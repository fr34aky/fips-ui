// fips-ui updating itself: find the newest release on GitHub and, when the UI runs from a git checkout of that
// repository, fast-forward it to the release tag, rebuild and let systemd restart the service. No privileges are
// involved: the checkout belongs to the UI's user. A newer privileged helper still has to be installed by an
// admin (sudo ./deploy/setup-local.sh); the UI only reports that it is needed.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = process.env.FIPS_UI_REPO ?? 'fr34aky/fips-ui';
const CHECK_MS = 6 * 60 * 60_000;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
// The service runs with NODE_ENV=production, in which npm ci leaves out devDependencies, and the build tools
// (TypeScript, Vite) are devDependencies: include them explicitly.
const NPM_CI = ['ci', '--prefix', 'web', '--include=dev', '--no-audit', '--no-fund'];

export interface Release { tag: string; version: string; url: string; publishedAt: string; notes: string }
export interface InstallMode { mode: 'git' | 'manual'; reason?: string; branch?: string }
export interface UpdateJob { tag: string; state: 'running' | 'done' | 'failed'; startedAt: number; finishedAt?: number; log: string[]; error?: string; restarting?: boolean }

/** -1, 0 or 1 for semantic versions like 0.3.0 (pre-release suffixes are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number), pb = b.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export class SelfUpdate {
  readonly root: string;
  readonly current: string;
  latest: Release | null = null;
  checkedAt = 0;
  checkError: string | undefined;
  job: UpdateJob | null = null;
  private checking: Promise<void> | null = null;

  constructor(root: string, current: string) { this.root = root; this.current = current; }

  /** The newest release, fetched at most every 6 hours unless forced. */
  check(force = false): Promise<void> {
    if (!force && Date.now() - this.checkedAt < CHECK_MS) return Promise.resolve();
    this.checking ??= (async () => {
      try {
        const headers: Record<string, string> = { 'user-agent': 'fips-ui', accept: 'application/vnd.github+json' };
        if (process.env.FIPS_UI_GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.FIPS_UI_GITHUB_TOKEN}`;
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`GitHub answered ${r.status}${r.status === 403 ? ' (rate limit? set FIPS_UI_GITHUB_TOKEN)' : ''}`);
        const j = await r.json() as { tag_name?: string; html_url?: string; published_at?: string; body?: string };
        if (!j.tag_name || !TAG_RE.test(j.tag_name)) throw new Error(`unexpected release tag ${JSON.stringify(j.tag_name)}`);
        this.latest = { tag: j.tag_name, version: j.tag_name.slice(1), url: j.html_url ?? `https://github.com/${REPO}/releases`, publishedAt: j.published_at ?? '', notes: (j.body ?? '').slice(0, 20_000) };
        this.checkError = undefined;
      } catch (e) {
        this.checkError = `could not check for a new fips-ui release: ${(e as Error).message}`;
      } finally {
        this.checkedAt = Date.now();
        this.checking = null;
      }
    })();
    return this.checking;
  }

  get newer(): boolean { return !!this.latest && compareVersions(this.latest.version, this.current) > 0; }

  /** Whether this installation can update itself: a clean git checkout of the release repository, on a branch. */
  async installMode(): Promise<InstallMode> {
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], this.root, 10_000);
    if (inside.code !== 0 || inside.out !== 'true') return { mode: 'manual', reason: `${this.root} is not a git checkout; download the release and run deploy/setup-local.sh again` };
    const remote = await run('git', ['remote', 'get-url', 'origin'], this.root, 10_000);
    if (remote.code !== 0 || !remote.out.replace(/\.git$/, '').endsWith(REPO)) return { mode: 'manual', reason: `the checkout's origin is not github.com/${REPO}` };
    const branch = await run('git', ['symbolic-ref', '--short', 'HEAD'], this.root, 10_000);
    if (branch.code !== 0) return { mode: 'manual', reason: 'the checkout is not on a branch (detached HEAD)' };
    const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], this.root, 10_000);
    if (status.out) return { mode: 'manual', reason: `the checkout has local changes (${status.out.split('\n').length} file(s)); commit or discard them, or update from a shell` };
    return { mode: 'git', branch: branch.out };
  }

  /** The helper version a checkout ships (scripts/fips-ui-helper), to tell whether the installed one is behind. */
  repoHelperVersion(): number | null {
    try { const m = /^HELPER_VERSION=(\d+)/m.exec(readFileSync(path.join(this.root, 'scripts', 'fips-ui-helper'), 'utf8')); return m ? Number(m[1]) : null; }
    catch { return null; }
  }

  private hasBuildTools(): boolean { return existsSync(path.join(this.root, 'web', 'node_modules', '.bin', 'tsc')) && existsSync(path.join(this.root, 'web', 'node_modules', '.bin', 'vite')); }

  /** Start the checkout's server in self-test mode (FIPS_UI_SELFTEST=1) and wait for it to report that it runs. */
  private selftest(): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...process.execArgv, 'server/index.ts'], { cwd: this.root, env: { ...process.env, FIPS_UI_SELFTEST: '1', INVOCATION_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const done = (ok: boolean) => { clearTimeout(timer); child.kill('SIGKILL'); resolve({ ok, out: out.trim() }); };
      const timer = setTimeout(() => done(false), 30_000);
      const onData = (d: Buffer) => { out += d.toString(); if (out.includes('fips-ui selftest ok')) done(true); };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('exit', () => { if (!out.includes('fips-ui selftest ok')) done(false); });
      child.on('error', (e) => { out += String(e); done(false); });
    });
  }

  /** Keep the previous commit on disk (inside .git, not the work tree), so going back is possible from a shell. */
  private remember(before: string, tag: string, job: UpdateJob): void {
    try { writeFileSync(path.join(this.root, '.git', 'fips-ui-previous'), `${before} ${tag} ${new Date().toISOString()}\n`); } catch { /* not essential */ }
    job.log.push(`previous version: ${before.slice(0, 10)}; to go back from a shell: git reset --hard ${before.slice(0, 10)} && npm run build`);
  }

  /** Under systemd (Restart=on-failure) exiting with an error code restarts the service on the new code. */
  // INVOCATION_ID alone is also set in shells of a systemd session; a service's own process has systemd as parent.
  get canRestart(): boolean { return !!process.env.INVOCATION_ID && process.ppid === 1; }

  /** Fast-forward to the release, install dependencies if they changed, build; roll back if anything fails. */
  async install(tag: string, onRestart: () => void): Promise<UpdateJob> {
    if (this.job?.state === 'running') throw new Error('an update is already running');
    if (!TAG_RE.test(tag)) throw new Error('invalid release tag');
    const job: UpdateJob = { tag, state: 'running', startedAt: Date.now(), log: [] };
    this.job = job;
    const step = async (label: string, cmd: string, args: string[], timeoutMs?: number) => {
      job.log.push(`$ ${label}`);
      const r = await run(cmd, args, this.root, timeoutMs);
      if (r.out) job.log.push(...r.out.split('\n').slice(-40));
      if (r.code !== 0) throw new Error(`${label} failed (exit ${r.code})`);
      return r.out;
    };
    let before = '';
    let moved = false;
    let depsChanged = false;
    try {
      const mode = await this.installMode();
      if (mode.mode !== 'git') throw new Error(mode.reason);
      before = (await step('git rev-parse HEAD', 'git', ['rev-parse', 'HEAD'])).trim();
      await step('git fetch --tags origin', 'git', ['fetch', '--tags', '--force', 'origin'], 120_000);
      await step(`git rev-parse ${tag}`, 'git', ['rev-parse', '--verify', `${tag}^{commit}`]);
      const ancestor = await run('git', ['merge-base', '--is-ancestor', 'HEAD', tag], this.root, 10_000);
      if (ancestor.code !== 0) throw new Error(`the checkout has commits that are not in ${tag} (it is ahead of or diverged from the release); update from a shell`);
      await step(`git merge --ff-only ${tag}`, 'git', ['merge', '--ff-only', tag]);
      moved = true;
      const changed = await run('git', ['diff', '--name-only', before, 'HEAD'], this.root, 10_000);
      depsChanged = /(^|\n)(web\/)?package(-lock)?\.json(\n|$)/.test(changed.out);
      // Also when the build tools are missing (a previous install without them): the build needs them.
      if (depsChanged || !this.hasBuildTools()) await step('npm ci (web)', 'npm', NPM_CI, 600_000);
      await step('npm run build', 'npm', ['run', 'build'], 600_000);
      // The web build does not compile the server: start the new server once, without side effects, before the
      // service is restarted on it.
      job.log.push('$ self-test of the new server');
      const t = await this.selftest();
      job.log.push(...t.out.split('\n').slice(-15));
      if (!t.ok) throw new Error('the new version did not start (self-test failed)');
      this.remember(before, tag, job);
      job.state = 'done';
      job.finishedAt = Date.now();
      if (this.canRestart) { job.restarting = true; job.log.push('restarting the service…'); setTimeout(onRestart, 1500); }
      else job.log.push('built; restart fips-ui to run the new version');
    } catch (e) {
      job.state = 'failed';
      job.error = (e as Error).message;
      job.finishedAt = Date.now();
      if (moved && before) {
        // Put the previous version back (the tree was clean and only fast-forwarded) and rebuild it.
        job.log.push(`rolling back to ${before.slice(0, 10)}`);
        await run('git', ['reset', '--hard', before], this.root, 60_000);
        if (depsChanged || !this.hasBuildTools()) await run('npm', NPM_CI, this.root, 600_000);
        const rb = await run('npm', ['run', 'build'], this.root, 600_000);
        job.log.push(rb.code === 0 ? 'previous version rebuilt' : `rebuilding the previous version failed; in ${this.root} run: npm ci --prefix web && npm run build`);
      }
    }
    return job;
  }
}
