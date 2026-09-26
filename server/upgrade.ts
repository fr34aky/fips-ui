/**
 * Node upgrade module for the FIPS UI backend.
 *
 * Two upgrade sources:
 *   - "release": a published GitHub release artifact for this OS/arch
 *                (checksum-verified against the release's checksums-<os>.txt)
 *   - "master":  a local `cargo build --release` of the upstream repository
 *                (any git ref: origin/master, a tag, a sha)
 *
 * OS support. Cargo is portable, so the build path runs anywhere Rust does.
 * What differs per platform is wrapped in `Platform` below:
 *   - binary names            (.exe on Windows)
 *   - where the binaries live (/usr/bin, /usr/local/bin, or wherever `fips` is on PATH)
 *   - which release artifact  (linux tar.gz, macOS/FreeBSD pkg, Windows zip)
 *   - which checksum file     (checksums-linux|macos|freebsd|windows.txt)
 *   - how the service restarts (systemd, launchd, FreeBSD rc, OpenRC, Windows SCM)
 *
 * Privilege model. The backend never runs as root on POSIX. Download, verify,
 * clone and build happen as the UI user in FIPS_UI_WORKDIR. The backend never
 * asks for or handles a sudo password: the helper and its sudoers rule are
 * installed once by an administrator from a shell (deploy/install-upgrade-helper.sh). The final swap of
 * the binaries and the service restart go through a small root-owned helper
 * (scripts/fips-ui-helper, Linux/macOS/FreeBSD) reached via one sudoers rule.
 * On Windows there is no sudo; the backend must run elevated and the install
 * step is performed in-process. See docs/upgrade.md.
 *
 * Zero dependencies; runs directly under `node` (type-stripped TypeScript).
 *
 * Mounting:
 *   import { createUpgradeHandler } from './upgrade.ts'
 *   const upgrade = createUpgradeHandler({ authorize })
 *   http.createServer(async (req, res) => { if (await upgrade(req, res)) return; ... })
 *
 * Standalone (testing):  node server/upgrade.ts   (PORT, default 8787)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm, readdir, readFile, writeFile, stat, chmod, copyFile, rename } from 'node:fs/promises'
import { createWriteStream, createReadStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonBody, BodyError, sendJson } from './http.ts'
import { homedir, arch as osArch, platform as osPlatform } from 'node:os'
import { connect as netConnect } from 'node:net'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpgradeSource = 'release' | 'master'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StepInfo { name: string; label: string; state: StepState; startedAt?: number; endedAt?: number; detail?: string }
export interface LogLine { seq: number; t: number; stream: 'out' | 'err' | 'sys'; line: string }

export interface JobRequest {
  source: UpgradeSource
  /** Release tag ("v0.5.1", "latest") or git ref ("origin/master", a tag, a sha). */
  ref?: string
  /** Restart the service after installing. Default true. */
  restart?: boolean
  /** Stop after staging; never touch the system. Default false. */
  dryRun?: boolean
}

export interface JobResult { stagedVersion?: string; backupId?: string; restarted?: boolean; runningVersion?: string; stageDir?: string; artifact?: string }

export type JobKind = 'upgrade' | 'rollback' | 'toolchain' | 'helper'

export interface JobSummary {
  id: string; kind: JobKind; source: UpgradeSource; ref: string; restart: boolean; dryRun: boolean
  state: JobState; cancellable: boolean; steps: StepInfo[]
  startedAt: number; endedAt?: number; error?: string; result?: JobResult; logLines: number
}

export interface Backup { id: string; createdAt: number; version: string; files: string[] }

export interface UpgradeOptions {
  /** Sources, downloads and stage dirs. Default: $XDG_DATA_HOME/fips-ui (or %LOCALAPPDATA%\fips-ui). */
  workDir?: string
  /** Privileged helper path (POSIX). Default /usr/local/libexec/fips-ui-helper */
  helperPath?: string
  /** GitHub "owner/repo". Default jmcorgan/fips */
  githubRepo?: string
  /** GitHub token to lift the unauthenticated rate limit. */
  githubToken?: string
  /** Git clone URL. Default https://github.com/<githubRepo>.git */
  repoUrl?: string
  /** Daemon control socket (path, or a loopback port on Windows). */
  controlSocket?: string
  /** Backups directory (must match the helper). */
  backupsDir?: string
  /** URL prefix. Default /api/upgrade */
  prefix?: string
  /** Gate for mutating endpoints. Return false to answer 403. */
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>
  /** Extra cargo args for the master build (e.g. ["--features", "profiling"]). */
  cargoArgs?: string[]
}

const MAX_LOG_LINES = 6000
const GITHUB_CACHE_MS = 10 * 60 * 1000
const GITHUB_ERROR_CACHE_MS = 60 * 1000
const BASE_BINARIES = ['fips', 'fipsctl', 'fipstop', 'fips-gateway'] as const

// ---------------------------------------------------------------------------
// Platform abstraction — everything OS-specific lives here
// ---------------------------------------------------------------------------

export type OsName = 'linux' | 'macos' | 'freebsd' | 'windows' | 'other'

export interface Platform {
  os: OsName
  /** Arch in the vocabulary used by release asset names. */
  arch: string
  exe: string
  binaries: string[]
  /** Regex matching this platform's release artifact name. */
  assetPattern: RegExp
  checksumFile: string
  /** Kind of artifact the release ships for this OS. */
  artifactKind: 'archive' | 'pkg'
  defaultBinDir: string
  defaultWorkDir: string
  defaultBackupsDir: string
  /** Where cargo puts the built binaries under CARGO_TARGET_DIR. */
  cargoOut: string
  /** Extra search paths for libclang, used only to inform the operator. */
  libclangHints: string[]
  usesHelper: boolean
}

export function detectPlatform(): Platform {
  const p = osPlatform()
  const os: OsName = p === 'linux' ? 'linux' : p === 'darwin' ? 'macos' : p === 'freebsd' ? 'freebsd' : p === 'win32' ? 'windows' : 'other'
  const a = osArch()
  const arch = os === 'macos'
    ? ({ x64: 'x86_64', arm64: 'arm64' } as Record<string, string>)[a] ?? a
    : os === 'freebsd'
      ? ({ x64: 'amd64', arm64: 'aarch64' } as Record<string, string>)[a] ?? a
      : ({ x64: 'x86_64', arm64: 'aarch64' } as Record<string, string>)[a] ?? a
  const exe = os === 'windows' ? '.exe' : ''
  const home = homedir()
  const dataHome = os === 'windows'
    ? (process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
    : os === 'macos' ? join(home, 'Library', 'Application Support') : (process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'))
  const table: Record<OsName, Pick<Platform, 'assetPattern' | 'checksumFile' | 'artifactKind' | 'defaultBinDir' | 'defaultBackupsDir' | 'libclangHints'>> = {
    linux: { assetPattern: new RegExp(`^fips-.*-linux-${arch}\\.tar\\.gz$`), checksumFile: 'checksums-linux.txt', artifactKind: 'archive', defaultBinDir: '/usr/bin', defaultBackupsDir: '/var/lib/fips-ui/backups', libclangHints: ['/usr/lib/libclang.so', '/usr/lib64/libclang.so', '/usr/lib/llvm/lib/libclang.so'] },
    macos: { assetPattern: new RegExp(`^fips-.*-macos-${arch}\\.pkg$`), checksumFile: 'checksums-macos.txt', artifactKind: 'pkg', defaultBinDir: '/usr/local/bin', defaultBackupsDir: '/usr/local/var/fips-ui/backups', libclangHints: ['/Library/Developer/CommandLineTools/usr/lib/libclang.dylib', '/opt/homebrew/opt/llvm/lib/libclang.dylib', '/usr/local/opt/llvm/lib/libclang.dylib'] },
    freebsd: { assetPattern: new RegExp(`^fips-.*-freebsd-${arch}\\.pkg$`), checksumFile: 'checksums-freebsd.txt', artifactKind: 'pkg', defaultBinDir: '/usr/local/bin', defaultBackupsDir: '/var/db/fips-ui/backups', libclangHints: ['/usr/lib/libclang.so', '/usr/local/llvm19/lib/libclang.so', '/usr/local/llvm18/lib/libclang.so'] },
    windows: { assetPattern: new RegExp(`^fips-.*-windows-${arch}\\.zip$`), checksumFile: 'checksums-windows.txt', artifactKind: 'archive', defaultBinDir: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'fips'), defaultBackupsDir: join(process.env.ProgramData ?? 'C:\\ProgramData', 'fips-ui', 'backups'), libclangHints: [process.env.LIBCLANG_PATH ?? 'C:\\Program Files\\LLVM\\bin'] },
    other: { assetPattern: new RegExp(`^fips-.*-linux-${arch}\\.tar\\.gz$`), checksumFile: 'checksums-linux.txt', artifactKind: 'archive', defaultBinDir: '/usr/local/bin', defaultBackupsDir: '/var/lib/fips-ui/backups', libclangHints: [] },
  }
  return {
    os, arch, exe,
    binaries: BASE_BINARIES.map((b) => b + exe),
    ...table[os],
    defaultWorkDir: join(dataHome, 'fips-ui'),
    cargoOut: 'release',
    usesHelper: os !== 'windows',
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Ids for jobs and backups: UTC timestamp to the millisecond plus a per-process counter, fixed width, so ids are
 * unique within a second, never go backwards on a DST change, and sort lexically in start order (the client
 * relies on that to decide which job is newer).
 */
let idCounter = 0
function nowId(): string {
  const d = new Date(); const p = (n: number, w = 2) => String(n).padStart(w, '0')
  idCounter = (idCounter + 1) % 1000
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}${p(idCounter, 3)}`
}

/**
 * Environment for every tool this module spawns. Under a service manager PATH is minimal and excludes
 * per-user toolchain locations (rustup's ~/.cargo/bin, Homebrew on Apple silicon), which is exactly where
 * the UI tells operators to install Rust, so those are appended here.
 */
function toolEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sep = osPlatform() === 'win32' ? ';' : ':'
  const parts = (process.env.PATH ?? '').split(sep).filter(Boolean)
  for (const p of [join(homedir(), '.cargo', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']) if (!parts.includes(p) && existsSync(p)) parts.push(p)
  return { ...process.env, PATH: parts.join(sep), ...extra }
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd: opts.cwd, env: toolEnv(opts.env), timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let code = 0
      if (err) { const c = (err as { code?: unknown }).code; code = typeof c === 'number' ? c : 127 }
      res({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function which(bin: string): Promise<string | null> {
  const r = osPlatform() === 'win32' ? await run('where.exe', [bin]) : await run('sh', ['-c', `command -v ${JSON.stringify(bin)}`])
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] || null : null
}

const isRoot = (): boolean => typeof process.getuid === 'function' ? process.getuid() === 0 : false

async function isElevatedWindows(): Promise<boolean> { return (await run('net', ['session'], { timeout: 5000 })).code === 0 }

/** Parse "fips 0.6.0-dev (rev 0f0e1dc2bd)\ntarget: ..." */
export function parseVersionOutput(out: string): { version: string; rev?: string; target?: string } | null {
  const m = out.match(/^\s*fips\S*\s+(\S+)(?:\s+\(rev\s+([0-9a-f]+[^)\s]*)\))?/m)
  if (!m) return null
  const t = out.match(/^target:\s*(\S+)/m)
  return { version: m[1], rev: m[2], target: t?.[1] }
}

/** Compare semver-ish strings (v0.6.0-dev vs 0.5.1). -1/0/1. Pre-release < release of the same base. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => { const [base, pre] = v.replace(/^v/, '').split('-', 2); const nums = base.split('.').map((x) => Number.parseInt(x, 10) || 0); while (nums.length < 3) nums.push(0); return { nums, pre: pre ?? '' } }
  const A = norm(a), B = norm(b)
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1
  if (A.pre === B.pre) return 0
  if (A.pre === '') return 1
  if (B.pre === '') return -1
  return A.pre < B.pre ? -1 : 1
}

function controlQuery(socket: string, command: string, timeoutMs = 4000): Promise<Record<string, unknown> | null> {
  return new Promise((res) => {
    let buf = ''; let done = false
    const finish = (v: Record<string, unknown> | null) => { if (!done) { done = true; res(v) } }
    const s = /^\d+$/.test(socket) ? netConnect(Number(socket), '127.0.0.1') : netConnect(socket)
    s.setTimeout(timeoutMs)
    s.on('connect', () => s.write(JSON.stringify({ command }) + '\n'))
    s.on('data', (c) => { buf += c.toString('utf8'); if (buf.endsWith('\n')) { try { const j = JSON.parse(buf); finish(j.status === 'ok' ? j.data : null) } catch { finish(null) } s.end() } })
    s.on('timeout', () => { s.destroy(); finish(null) })
    s.on('error', () => finish(null))
    s.on('close', () => finish(null))
  })
}



async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c as Buffer)
  return h.digest('hex')
}

async function downloadTo(url: string, dest: string, cancel?: AbortSignal): Promise<number> {
  const timeout = AbortSignal.timeout(15 * 60_000)
  const r = await fetch(url, { headers: { 'user-agent': 'fips-ui' }, redirect: 'follow', signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout })
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`)
  let done = 0
  const tmp = `${dest}.part`
  await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), async function* (src) { for await (const c of src) { done += (c as Buffer).length; yield c } }, createWriteStream(tmp))
  await rename(tmp, dest)
  return done
}

function lastJsonLine(out: string): string { const lines = out.trim().split('\n').filter((l) => l.trim().startsWith('{')); return lines[lines.length - 1] ?? '{}' }
function cmpWord(c: number): 'newer' | 'same' | 'older' { return c > 0 ? 'newer' : c < 0 ? 'older' : 'same' }

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

interface GhRelease { tag_name: string; name: string; published_at: string; html_url: string; prerelease: boolean; body: string; assets: { name: string; size: number; browser_download_url: string }[] }
interface GhCommit { sha: string; commit: { message: string; committer: { date: string } }; html_url: string }

/**
 * GitHub REST client with a small cache. The unauthenticated limit is 60 requests/hour and the Upgrade page
 * polls status every 15 s, so successful answers are kept for ten minutes and failures for one minute (or
 * until the rate-limit window resets), which bounds an open tab to a few requests per hour per endpoint.
 */
class GitHub {
  private cache = new Map<string, { at: number; value?: unknown; error?: Error; until: number }>()
  private repo: string
  private token?: string
  constructor(repo: string, token?: string) { this.repo = repo; this.token = token }
  private async get<T>(path: string, ttl = GITHUB_CACHE_MS): Promise<T> {
    const c = this.cache.get(path)
    if (c && Date.now() < c.until) { if (c.error) throw c.error; return c.value as T }
    const headers: Record<string, string> = { 'user-agent': 'fips-ui', accept: 'application/vnd.github+json' }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    try {
      const r = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) {
        if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') {
          const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000
          const err = new Error(`GitHub API rate limit exceeded (resets ${reset ? new Date(reset).toLocaleTimeString() : 'later'}); set FIPS_UI_GITHUB_TOKEN`)
          this.cache.set(path, { at: Date.now(), error: err, until: reset && reset > Date.now() ? reset : Date.now() + GITHUB_ERROR_CACHE_MS })
          throw err
        }
        if (r.status === 429 || r.status === 403) {
          // Secondary/abuse limits: transient, with a retry-after; a token lifts them.
          const retry = Number(r.headers.get('retry-after')) * 1000
          const err = new Error(`GitHub API ${path}: HTTP ${r.status} (temporarily limited; retry in ${retry ? Math.ceil(retry / 1000) : 60} s, or set FIPS_UI_GITHUB_TOKEN)`)
          this.cache.set(path, { at: Date.now(), error: err, until: Date.now() + (retry > 0 ? retry : GITHUB_ERROR_CACHE_MS) })
          throw err
        }
        const err = new Error(`GitHub API ${path}: HTTP ${r.status}`)
        // Other 4xx answers are deterministic (no such release, rev not an ancestor of master): retrying every
        // minute only burns the rate limit, so they are cached as long as a success would be.
        if (r.status >= 400 && r.status < 500) this.cache.set(path, { at: Date.now(), error: err, until: Date.now() + ttl })
        throw err
      }
      const value = (await r.json()) as T
      this.cache.set(path, { at: Date.now(), value, until: Date.now() + ttl })
      return value
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      const prev = this.cache.get(path)
      if (!(prev?.error && Date.now() < prev.until)) this.cache.set(path, { at: Date.now(), error: err, until: Date.now() + GITHUB_ERROR_CACHE_MS })
      throw err
    }
  }
  latestRelease() { return this.get<GhRelease>(`/repos/${this.repo}/releases/latest`) }
  releaseByTag(tag: string) { return this.get<GhRelease>(`/repos/${this.repo}/releases/tags/${encodeURIComponent(tag)}`) }
  branchHead(branch = 'master') { return this.get<GhCommit>(`/repos/${this.repo}/commits/${encodeURIComponent(branch)}`) }
  compare(base: string, head: string) { return this.get<{ status: string; ahead_by: number; behind_by: number; commits: GhCommit[] }>(`/repos/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`) }
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

type Listener = (ev: { type: 'log'; data: LogLine } | { type: 'state'; data: JobSummary }) => void
class CancelledError extends Error { constructor() { super('cancelled by operator'); this.name = 'CancelledError' } }

class Job {
  readonly id = nowId()
  state: JobState = 'queued'
  cancellable = true
  steps: StepInfo[] = []
  startedAt = Date.now()
  endedAt?: number
  error?: string
  result: JobResult = {}
  readonly ref: string
  readonly restart: boolean
  readonly dryRun: boolean
  private log: LogLine[] = []
  private seq = 0
  private listeners = new Set<Listener>()
  private child: ChildProcess | null = null
  private cancelRequested = false
  private readonly aborter = new AbortController()
  /** Aborts in-process work (downloads) when the operator cancels; child processes are killed separately. */
  get signal(): AbortSignal { return this.aborter.signal }

  readonly source: UpgradeSource
  readonly kind: JobKind

  constructor(source: UpgradeSource, req: JobRequest, refOverride?: string, kind: JobKind = 'upgrade') {
    this.source = source; this.kind = kind
    this.ref = refOverride ?? (req.ref?.trim() || (source === 'release' ? 'latest' : 'origin/master'))
    this.restart = req.restart !== false
    this.dryRun = req.dryRun === true
  }

  summary(): JobSummary {
    return { id: this.id, kind: this.kind, source: this.source, ref: this.ref, restart: this.restart, dryRun: this.dryRun, state: this.state, cancellable: this.cancellable && (this.state === 'running' || this.state === 'queued'), steps: this.steps, startedAt: this.startedAt, endedAt: this.endedAt, error: this.error, result: this.result, logLines: this.log.length }
  }
  logSince(seq: number): LogLine[] { return this.log.filter((l) => l.seq > seq) }
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l) }
  emitState(): void { const s = this.summary(); for (const l of this.listeners) l({ type: 'state', data: s }) }

  write(stream: LogLine['stream'], text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\r/g, '').trimEnd()
      if (!line) continue
      const entry: LogLine = { seq: ++this.seq, t: Date.now(), stream, line }
      this.log.push(entry)
      if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES)
      for (const l of this.listeners) l({ type: 'log', data: entry })
    }
  }
  info(msg: string): void { this.write('sys', msg) }

  defineSteps(steps: [string, string][]): void { this.steps = steps.map(([name, label]) => ({ name, label, state: 'pending' })); this.emitState() }
  private step(name: string): StepInfo { const s = this.steps.find((x) => x.name === name); if (!s) throw new Error(`no step ${name}`); return s }

  async runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.throwIfCancelled()
    const s = this.step(name)
    s.state = 'running'; s.startedAt = Date.now(); this.emitState()
    this.info(`── ${s.label}`)
    try { const r = await fn(); s.state = 'done'; s.endedAt = Date.now(); this.emitState(); return r }
    catch (e) { s.state = 'failed'; s.endedAt = Date.now(); s.detail = e instanceof Error ? e.message : String(e); this.emitState(); throw e }
  }
  skipStep(name: string, why: string): void { const s = this.step(name); s.state = 'skipped'; s.detail = why; this.emitState() }
  throwIfCancelled(): void { if (this.cancelRequested) throw new CancelledError() }

  /** Spawn a process, stream its output into the job log, reject on non-zero exit. */
  exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean; input?: string; display?: string } = {}): Promise<string> {
    this.throwIfCancelled()
    return new Promise((res, rej) => {
      if (!opts.quiet) this.info(`$ ${opts.display ?? [cmd, ...args].join(' ')}`)
      const win = osPlatform() === 'win32'
      const child = spawn(cmd, args, { cwd: opts.cwd, env: toolEnv(opts.env), stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true })
      this.child = child
      if (opts.input !== undefined && child.stdin) { child.stdin.on('error', () => { /* sudo may close stdin early */ }); child.stdin.end(opts.input) }
      let out = ''
      child.stdout?.on('data', (c) => { const s = c.toString('utf8'); out += s; this.write('out', s) })
      child.stderr?.on('data', (c) => this.write('err', c.toString('utf8')))
      child.on('error', (e) => { this.child = null; rej(e) })
      child.on('close', (code, signal) => {
        this.child = null
        if (this.cancelRequested) return rej(new CancelledError())
        if (code === 0) res(out); else rej(new Error(`${basename(cmd)} exited with ${code ?? signal}`))
      })
    })
  }

  cancel(): boolean {
    if (!this.cancellable || (this.state !== 'running' && this.state !== 'queued')) return false
    this.cancelRequested = true
    this.info('cancel requested')
    this.aborter.abort()
    const c = this.child
    if (c?.pid) {
      if (osPlatform() === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
      else { try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill('SIGTERM') } catch { /* ignore */ } } }
    }
    return true
  }

  finish(err?: unknown): void {
    this.endedAt = Date.now()
    if (err instanceof CancelledError || (err && this.cancelRequested)) { this.state = 'cancelled'; this.error = 'cancelled by operator' }
    else if (err) { this.state = 'failed'; this.error = err instanceof Error ? err.message : String(err); this.info(`✗ ${this.error}`) }
    else { this.state = 'succeeded'; this.info('✓ finished') }
    for (const s of this.steps) if (s.state === 'pending' || s.state === 'running') s.state = this.state === 'succeeded' ? 'done' : 'skipped'
    this.emitState()
  }
}

// ---------------------------------------------------------------------------
// Installers: how staged binaries reach the system
// ---------------------------------------------------------------------------

interface InstallResult { backup_id?: string; restarted?: boolean; installed_version?: string; pre_rollback_backup?: string }

interface Installer {
  kind: string
  check(): Promise<{ available: boolean; error?: string; detail?: string }>
  install(job: Job, stageDir: string, restart: boolean): Promise<InstallResult>
  rollback(job: Job, backupId: string): Promise<InstallResult>
  restart(): Promise<string>
  listBackups(): Promise<Backup[]>
}

/** POSIX: everything privileged goes through the root-owned helper script. */
class HelperInstaller implements Installer {
  kind = 'helper'
  private helperPath: string
  private backupsDir: string
  private binaries: string[]
  constructor(helperPath: string, backupsDir: string, binaries: string[]) { this.helperPath = helperPath; this.backupsDir = backupsDir; this.binaries = binaries }
  private cmd(args: string[]): [string, string[]] { return isRoot() ? [this.helperPath, args] : ['sudo', ['-n', this.helperPath, ...args]] }
  async check() {
    if (!existsSync(this.helperPath)) return { available: false, error: `helper not installed at ${this.helperPath}` }
    const [c, a] = this.cmd(['check'])
    const r = await run(c, a, { timeout: 15_000 })
    if (r.code !== 0) return { available: false, error: (r.stderr || r.stdout).trim().split('\n')[0] || `helper exited ${r.code}` }
    try { const j = JSON.parse(r.stdout); return { available: j.ok === true, detail: `helper v${j.version} · ${j.service_manager ?? '?'} · bin ${j.bin_dir}` } }
    catch { return { available: false, error: 'helper returned invalid JSON' } }
  }
  async install(job: Job, stageDir: string, restart: boolean) { const [c, a] = this.cmd(['install', stageDir, ...(restart ? [] : ['--no-restart'])]); return JSON.parse(lastJsonLine(await job.exec(c, a))) as InstallResult }
  async rollback(job: Job, id: string) { const [c, a] = this.cmd(['rollback', id]); return JSON.parse(lastJsonLine(await job.exec(c, a))) as InstallResult }
  async restart() { const [c, a] = this.cmd(['restart']); const r = await run(c, a, { timeout: 90_000 }); if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `helper exited ${r.code}`); return r.stdout.trim() }
  async listBackups() { return readBackupsDir(this.backupsDir, this.binaries) }
}

/** Windows: no sudo; the backend itself must run elevated. Service via the SCM. */
class WindowsInstaller implements Installer {
  kind = 'windows-inprocess'
  private binDir: string
  private backupsDir: string
  private binaries: string[]
  private service: string
  constructor(binDir: string, backupsDir: string, binaries: string[], service: string) { this.binDir = binDir; this.backupsDir = backupsDir; this.binaries = binaries; this.service = service }
  async check() {
    if (!(await isElevatedWindows())) return { available: false, error: 'backend is not running elevated (Administrator); upgrades need it on Windows' }
    if (!existsSync(join(this.binDir, 'fips.exe'))) return { available: false, error: `fips.exe not found in ${this.binDir} (set FIPS_BIN_DIR)` }
    return { available: true, detail: `in-process · service ${this.service} · bin ${this.binDir}` }
  }
  private async backup(job: Job): Promise<string> {
    await mkdir(this.backupsDir, { recursive: true })
    const ver = parseVersionOutput((await run(join(this.binDir, 'fips.exe'), ['--version'], { timeout: 5000 })).stdout)
    const id = `${nowId()}_${(ver ? `${ver.version}${ver.rev ? `_${ver.rev}` : ''}` : 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_')}`
    const dir = join(this.backupsDir, id)
    await mkdir(dir, { recursive: true })
    for (const b of this.binaries) if (existsSync(join(this.binDir, b))) await copyFile(join(this.binDir, b), join(dir, b))
    await writeFile(join(dir, 'VERSION'), ver ? `fips ${ver.version}${ver.rev ? ` (rev ${ver.rev})` : ''}\n` : 'unknown\n')
    job.info(`backed up current binaries to ${dir}`)
    return id
  }
  private async swap(job: Job, from: string): Promise<void> {
    const present = this.binaries.filter((b) => existsSync(join(from, b)))
    if (!present.includes('fips.exe')) throw new Error(`fips.exe missing in ${from}`)
    await this.stopService(job)
    for (const b of present) { await copyFile(join(from, b), join(this.binDir, `${b}.new`)); await rename(join(this.binDir, `${b}.new`), join(this.binDir, b)) }
    job.info(`installed: ${present.join(', ')}`)
  }
  private async stopService(job: Job) { const r = await run('sc.exe', ['stop', this.service], { timeout: 60_000 }); job.info(r.code === 0 ? `stopped service ${this.service}` : `service ${this.service} not stopped (${r.stdout.trim().split('\n').pop()})`); await new Promise((r) => setTimeout(r, 2000)) }
  private async startService(job: Job) { const r = await run('sc.exe', ['start', this.service], { timeout: 60_000 }); if (r.code !== 0) throw new Error(`sc start ${this.service} failed: ${r.stdout.trim()}`); job.info(`started service ${this.service}`) }
  async install(job: Job, stageDir: string, restart: boolean) {
    const backup_id = await this.backup(job)
    await this.swap(job, stageDir) // stops the service: Windows locks running executables
    if (!restart) job.info('note: on Windows the service must be stopped to replace its binaries, so it is started again regardless of the restart option')
    await this.startService(job)
    return { backup_id, restarted: true }
  }
  async rollback(job: Job, id: string) { const pre_rollback_backup = await this.backup(job); await this.swap(job, join(this.backupsDir, id)); await this.startService(job); return { pre_rollback_backup, restarted: true } }
  async restart() { const s = await run('sc.exe', ['stop', this.service], { timeout: 60_000 }); await new Promise((r) => setTimeout(r, 2000)); const r = await run('sc.exe', ['start', this.service], { timeout: 60_000 }); if (r.code !== 0) throw new Error(r.stdout.trim()); return `${s.stdout.trim()}\n${r.stdout.trim()}` }
  async listBackups() { return readBackupsDir(this.backupsDir, this.binaries) }
}

async function readBackupsDir(dir: string, binaries: string[]): Promise<Backup[]> {
  try {
    const out: Backup[] = []
    for (const id of await readdir(dir)) {
      const d = join(dir, id)
      try {
        const st = await stat(d); if (!st.isDirectory()) continue
        const files = (await readdir(d)).filter((f) => binaries.includes(f))
        let version = ''; try { version = (await readFile(join(d, 'VERSION'), 'utf8')).trim() } catch { /* absent */ }
        out.push({ id, createdAt: st.mtimeMs, version, files })
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  } catch { return [] }
}

// ---------------------------------------------------------------------------
// Upgrade manager
// ---------------------------------------------------------------------------

export class UpgradeManager {
  readonly platform = detectPlatform()
  readonly workDir: string
  readonly helperPath: string
  readonly backupsDir: string
  readonly controlSocket: string
  readonly repoUrl: string
  readonly gh: GitHub
  readonly cargoArgs: string[]
  readonly installer: Installer
  private binDirCache: string | null = null
  private current: Job | null = null
  /** Probe results that only change when an operator acts (helper install, package changes, toolchain installs). */
  private readonly cache = new Map<string, { at: number; value: unknown }>()
  private memo<T>(key: string, ttlMs: number, force: boolean, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (!force && hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T)
    return fn().then((value) => { this.cache.set(key, { at: Date.now(), value }); return value })
  }

  constructor(opts: UpgradeOptions = {}) {
    const P = this.platform
    this.workDir = opts.workDir ?? process.env.FIPS_UI_WORKDIR ?? P.defaultWorkDir
    this.helperPath = opts.helperPath ?? process.env.FIPS_UI_HELPER ?? '/usr/local/libexec/fips-ui-helper'
    this.backupsDir = opts.backupsDir ?? process.env.FIPS_UI_BACKUPS ?? P.defaultBackupsDir
    this.controlSocket = opts.controlSocket ?? process.env.FIPS_CONTROL_SOCKET ?? (P.os === 'windows' ? '21210' : existsSync('/run/fips/control.sock') ? '/run/fips/control.sock' : existsSync('/var/run/fips/control.sock') ? '/var/run/fips/control.sock' : join(process.env.XDG_RUNTIME_DIR ?? '/tmp', process.env.XDG_RUNTIME_DIR ? 'fips/control.sock' : 'fips-control.sock'))
    const repo = opts.githubRepo ?? process.env.FIPS_UI_GITHUB_REPO ?? 'jmcorgan/fips'
    this.repoUrl = opts.repoUrl ?? process.env.FIPS_UI_REPO_URL ?? `https://github.com/${repo}.git`
    this.gh = new GitHub(repo, opts.githubToken ?? process.env.FIPS_UI_GITHUB_TOKEN)
    this.cargoArgs = opts.cargoArgs ?? (process.env.FIPS_UI_CARGO_ARGS ? process.env.FIPS_UI_CARGO_ARGS.split(/\s+/).filter(Boolean) : [])
    this.installer = P.usesHelper
      ? new HelperInstaller(this.helperPath, this.backupsDir, P.binaries)
      : new WindowsInstaller(process.env.FIPS_BIN_DIR ?? P.defaultBinDir, this.backupsDir, P.binaries, process.env.FIPS_SERVICE_NAME ?? 'fips')
  }

  get job(): Job | null { return this.current }

  // ---- introspection ------------------------------------------------------

  async binDir(): Promise<string> {
    if (this.binDirCache) return this.binDirCache
    const envDir = process.env.FIPS_BIN_DIR
    const found = envDir && existsSync(join(envDir, 'fips' + this.platform.exe)) ? join(envDir, 'fips' + this.platform.exe)
      : existsSync(join(this.platform.defaultBinDir, 'fips' + this.platform.exe)) ? join(this.platform.defaultBinDir, 'fips' + this.platform.exe)
        : await which('fips')
    this.binDirCache = found ? dirname(found) : this.platform.defaultBinDir
    return this.binDirCache
  }

  async installedVersion(): Promise<{ path: string | null; version?: string; rev?: string; target?: string; raw?: string }> {
    const path = join(await this.binDir(), 'fips' + this.platform.exe)
    if (!existsSync(path)) return { path: null }
    const r = await run(path, ['--version'], { timeout: 5000 })
    const p = parseVersionOutput(r.stdout)
    return { path, raw: r.stdout.trim(), ...(p ?? {}) }
  }

  async runningVersion(): Promise<{ version?: string; rev?: string; uptime_secs?: number; pid?: number } | null> {
    const d = await controlQuery(this.controlSocket, 'show_status')
    if (!d) return null
    const p = parseVersionOutput(`fips ${String(d.version ?? '')}`)
    return { version: p?.version, rev: p?.rev, uptime_secs: d.uptime_secs as number | undefined, pid: d.pid as number | undefined }
  }

  /** Which package manager owns the installed binary, if any (so the UI can warn about drift). */
  async packageInfo(): Promise<{ manager: string; name: string; version?: string; note: string } | null> {
    const bin = join(await this.binDir(), 'fips' + this.platform.exe)
    if (this.platform.os === 'linux') {
      if (await which('pacman')) { const r = await run('pacman', ['-Qo', bin]); const m = r.stdout.match(/is owned by (\S+) (\S+)/); if (m) return { manager: 'pacman', name: m[1], version: m[2], note: `Installing binaries directly diverges from the ${m[1]} package; pacman -Qkk will report modified files and the next package upgrade will overwrite them.` } }
      if (await which('dpkg-query')) { const r = await run('dpkg-query', ['-S', bin]); const m = r.stdout.match(/^([^:]+):/); if (m) { const v = await run('dpkg-query', ['-W', '-f=${Version}', m[1]]); return { manager: 'dpkg', name: m[1], version: v.stdout.trim() || undefined, note: `Installing binaries directly diverges from the ${m[1]} .deb; the next apt upgrade of it will overwrite them.` } } }
      if (await which('rpm')) { const r = await run('rpm', ['-qf', bin]); if (r.code === 0) return { manager: 'rpm', name: r.stdout.trim(), note: 'Installing binaries directly diverges from the RPM database.' } }
    } else if (this.platform.os === 'freebsd' && await which('pkg')) {
      const r = await run('pkg', ['which', '-q', bin]); if (r.code === 0 && r.stdout.trim()) return { manager: 'pkg', name: r.stdout.trim(), note: 'Installing binaries directly diverges from the pkg database; release .pkg installs stay consistent.' }
    } else if (this.platform.os === 'macos' && existsSync('/var/db/receipts')) {
      const r = await run('pkgutil', ['--file-info', bin]); const m = r.stdout.match(/pkgid:\s*(\S+)/); if (m) return { manager: 'pkgutil', name: m[1], note: 'Installed from a macOS .pkg; release upgrades reinstall the .pkg, master builds replace the binaries in place.' }
    }
    return null
  }

  async toolchain(): Promise<Record<string, { ok: boolean; required: boolean; detail?: string }>> {
    const out: Record<string, { ok: boolean; required: boolean; detail?: string }> = {}
    for (const name of ['cargo', 'rustc', 'git'] as const) {
      const p = await which(name)
      out[name] = p ? { ok: true, required: true, detail: (await run(p, ['--version'])).stdout.trim() } : { ok: false, required: true, detail: 'not found on PATH' }
    }
    // libclang: needed by bindgen for the gateway's conntrack bindings. Search env, hints, then llvm-config.
    let libclang = process.env.LIBCLANG_PATH && existsSync(process.env.LIBCLANG_PATH) ? `LIBCLANG_PATH=${process.env.LIBCLANG_PATH}` : this.platform.libclangHints.find((p) => existsSync(p)) ?? ''
    if (!libclang) { const lc = await which('llvm-config'); if (lc) { const r = await run(lc, ['--libdir']); if (r.code === 0) libclang = r.stdout.trim() } }
    if (!libclang && this.platform.os === 'linux') { const r = await run('sh', ['-c', 'ls /usr/lib/*/libclang*.so* /usr/lib/llvm-*/lib/libclang*.so* 2>/dev/null | head -1']); libclang = r.stdout.trim() }
    if (!libclang && this.platform.os === 'macos') { const r = await run('xcrun', ['--find', 'clang']); if (r.code === 0) libclang = `${dirname(dirname(r.stdout.trim()))}/lib` }
    out.libclang = libclang ? { ok: true, required: false, detail: libclang } : { ok: false, required: false, detail: 'libclang not found (needed by the gateway build; install clang/llvm or set LIBCLANG_PATH)' }
    if (this.platform.os === 'linux') {
      const pc = await which('pkg-config')
      const dbus = pc ? await run('pkg-config', ['--modversion', 'dbus-1']) : { code: 1, stdout: '' }
      out['dbus-1'] = dbus.code === 0 ? { ok: true, required: false, detail: `dbus-1 ${dbus.stdout.trim()}` } : { ok: false, required: false, detail: 'dbus-1 development package not found (Linux BLE transport)' }
    }
    return out
  }

  // ---- build-dependency installation ------------------------------------

  /** What this OS needs for `cargo build`, and how to install it. */
  async toolchainPlan(tcIn?: Record<string, { ok: boolean; required: boolean; detail?: string }>): Promise<{ manager: string | null; sudo: boolean; packages: string[]; command: string[]; note?: string; missing: string[] }> {
    const tc = tcIn ?? await this.toolchain()
    const missing = Object.entries(tc).filter(([, v]) => !v.ok).map(([k]) => k)
    const os = this.platform.os
    const pick = async (cands: [string, string[], string[]][]): Promise<{ manager: string; packages: string[]; command: string[] } | null> => {
      for (const [bin, prefix, pkgs] of cands) if (await which(bin)) return { manager: bin, packages: pkgs, command: [...prefix, ...pkgs] }
      return null
    }
    let plan: { manager: string; packages: string[]; command: string[] } | null = null
    let sudo = true
    let note: string | undefined
    if (os === 'linux') {
      plan = await pick([
        ['pacman', ['pacman', '-S', '--needed', '--noconfirm'], ['rust', 'clang', 'git', 'pkgconf', 'dbus']],
        ['apt-get', ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y'], ['cargo', 'rustc', 'git', 'clang', 'libclang-dev', 'pkg-config', 'libdbus-1-dev']],
        ['dnf', ['dnf', 'install', '-y'], ['cargo', 'rust', 'git', 'clang', 'clang-devel', 'pkgconf-pkg-config', 'dbus-devel']],
        ['zypper', ['zypper', '--non-interactive', 'install'], ['cargo', 'rust', 'git', 'clang', 'clang-devel', 'pkg-config', 'dbus-1-devel']],
        ['apk', ['apk', 'add'], ['cargo', 'rust', 'git', 'clang', 'clang-dev', 'pkgconf', 'dbus-dev', 'musl-dev']],
        ['emerge', ['emerge', '--ask=n'], ['dev-lang/rust', 'dev-vcs/git', 'llvm-core/clang', 'sys-apps/dbus']],
      ])
      if (plan?.manager === 'apt-get') note = 'Distribution Rust may be older than the crate floor; if the build rejects it, install rustup (https://rustup.rs) as the UI user instead.'
    } else if (os === 'freebsd') {
      plan = await pick([['pkg', ['pkg', 'install', '-y'], ['rust', 'git', 'llvm']]])
    } else if (os === 'macos') {
      sudo = false
      plan = await pick([['brew', ['brew', 'install'], ['rust', 'llvm', 'git']]])
      note = plan ? 'Homebrew installs as your user (no sudo). Xcode Command Line Tools must be present: xcode-select --install' : 'Install Homebrew (https://brew.sh) or Rust via rustup, plus Xcode Command Line Tools.'
    } else if (os === 'windows') {
      sudo = false
      plan = await pick([['winget', ['winget', 'install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id'], ['Rustlang.Rustup']]])
      if (plan) plan.command = ['winget', 'install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'Rustlang.Rustup', '--id', 'LLVM.LLVM', '--id', 'Git.Git']
      note = 'Runs winget from the elevated backend; a new terminal is needed afterwards for PATH changes.'
    }
    if (!plan) return { manager: null, sudo, packages: [], command: [], missing, note: note ?? 'No supported package manager found; install cargo, rustc, git and clang/libclang manually (https://rustup.rs).' }
    return { ...plan, sudo, missing, note }
  }

  /**
   * Everything the Upgrade page shows. The expensive probes (package ownership, helper self-test via sudo,
   * toolchain discovery: ~25 process spawns) are cached for ten minutes; `force` (the page's Refresh button)
   * and the end of any job invalidate them. Versions, backups and GitHub state are read every time.
   */
  async status(force = false): Promise<Record<string, unknown>> {
    const TTL = 10 * 60_000
    const [installed, running, pkg, helper, toolchain, backups] = await Promise.all([
      this.installedVersion(), this.runningVersion(),
      this.memo('package', TTL, force, () => this.packageInfo()),
      this.memo('helper', TTL, force, () => this.installer.check()),
      this.memo('toolchain', TTL, force, () => this.toolchain()),
      this.installer.listBackups(),
    ])
    const toolchainPlan = await this.memo('toolchainPlan', TTL, force, () => this.toolchainPlan(toolchain))
    // The three GitHub calls run concurrently so an unreachable GitHub costs one fetch timeout, not three in a row.
    const [relR, headR, cmpR] = await Promise.allSettled([
      this.gh.latestRelease(),
      this.gh.branchHead('master'),
      installed.rev ? this.gh.compare(installed.rev, 'master') : Promise.reject(new Error('no installed rev')),
    ])
    const errMsg = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : '')
    let release: Record<string, unknown>
    if (relR.status === 'fulfilled') {
      const r = relR.value
      const asset = this.pickAsset(r)
      release = { tag: r.tag_name, name: r.name, publishedAt: r.published_at, url: r.html_url, prerelease: r.prerelease, notes: r.body?.slice(0, 4000) ?? '', asset: asset ? { name: asset.name, size: asset.size } : null, checksums: !!r.assets.find((a) => a.name === this.platform.checksumFile), relation: installed.version ? cmpWord(compareVersions(r.tag_name, installed.version)) : 'unknown' }
    } else release = { error: errMsg(relR) }
    let master: Record<string, unknown>
    if (headR.status === 'fulfilled') {
      const head = headR.value
      const ahead = cmpR.status === 'fulfilled' ? { ahead_by: cmpR.value.ahead_by, behind_by: cmpR.value.behind_by, commits: cmpR.value.commits.slice(-40).reverse().map((x) => ({ sha: x.sha, subject: x.commit.message.split('\n')[0], date: x.commit.committer.date, url: x.html_url })) } : null
      master = { sha: head.sha, subject: head.commit.message.split('\n')[0], date: head.commit.committer.date, url: head.html_url, ahead, relation: installed.rev && head.sha.startsWith(installed.rev) ? 'same' : ahead ? (ahead.ahead_by > 0 ? 'newer' : 'same') : 'unknown' }
    } else master = { error: errMsg(headR) }
    const restartPending = !!(installed.version && running?.version && (installed.version !== running.version || (installed.rev ?? '') !== (running.rev ?? '')))
    return {
      platform: { os: this.platform.os, arch: this.platform.arch, artifactKind: this.platform.artifactKind, installer: this.installer.kind, binDir: await this.binDir(), workDir: this.workDir, controlSocket: this.controlSocket },
      installed, running, package: pkg, helper, toolchain, toolchainPlan, backups, release, master, restartPending,
      helperInstallScript: this.platform.usesHelper ? resolve(import.meta.dirname, '..', 'deploy', 'install-upgrade-helper.sh') : null,
      job: this.current?.summary() ?? null,
    }
  }

  private pickAsset(r: GhRelease) { return r.assets.find((a) => this.platform.assetPattern.test(a.name)) ?? null }

  // ---- job control --------------------------------------------------------

  /** True while start()/rollback() are between the guard and publishing a Job, so concurrent starts cannot both pass. */
  private starting = false
  private claimSlot(): void {
    if (this.starting || (this.current && (this.current.state === 'running' || this.current.state === 'queued'))) throw new Error('an upgrade job is already running')
    this.starting = true // synchronous, before any await
  }
  /** Publish the job as current (or give the slot back on `null`). Only published jobs are observable by clients. */
  private publish(job: Job | null): void { if (job) this.current = job; this.starting = false }
  private launch(job: Job, work: () => Promise<void>): Job {
    job.state = 'running'
    // Housekeeping runs while the job still holds the slot, so it can never delete files of a job started right after.
    void work().then(
      async () => { await this.housekeep(job, true); job.finish() },
      async (e) => { await this.housekeep(job, false); job.finish(e) },
    ).finally(() => this.cache.clear())
    return job
  }

  /** Bound the work dir: drop partial downloads and extract dirs, keep the 3 newest stage dirs and 2 newest artifacts. */
  private async housekeep(job: Job, succeeded: boolean): Promise<void> {
    const keepNewest = async (dir: string, keep: number, filter: (name: string) => boolean = () => true) => {
      let names: string[]
      try { names = (await readdir(dir)).filter(filter) } catch { return }
      const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })))
      for (const { n } of withTime.sort((a, b) => b.t - a.t).slice(keep)) await rm(join(dir, n), { recursive: true, force: true }).catch(() => {})
    }
    try {
      if (!job.dryRun && succeeded && job.result.stageDir) await rm(job.result.stageDir, { recursive: true, force: true })
      await rm(join(this.workDir, 'extract'), { recursive: true, force: true })
      await keepNewest(join(this.workDir, 'downloads'), 0, (n) => n.endsWith('.part'))
      await keepNewest(join(this.workDir, 'downloads'), 2, (n) => !n.endsWith('.part'))
      await keepNewest(join(this.workDir, 'stage'), 3)
    } catch { /* housekeeping is best effort */ }
  }

  async start(reqIn: JobRequest): Promise<Job> {
    // Flags must be real booleans: a client that sends "true" or 1 has asked for something and must get a 400,
    // never a silent flip to the destructive default.
    for (const k of ['dryRun', 'restart'] as const) if (reqIn[k] !== undefined && typeof reqIn[k] !== 'boolean') throw new Error(`${k} must be a boolean`)
    const req: JobRequest = { ...reqIn, dryRun: reqIn.dryRun === true, restart: reqIn.restart !== false }
    if (req.source !== 'release' && req.source !== 'master') throw new Error('source must be "release" or "master"')
    if (req.ref && !/^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,119}$/.test(req.ref)) throw new Error('invalid ref: use a branch, tag or commit sha (no leading "-" or ".")')
    this.claimSlot()
    if (!req.dryRun) {
      let h: { available: boolean; error?: string }
      try { h = await this.installer.check() } catch (e) { this.publish(null); throw e }
      if (!h.available) { this.publish(null); throw new Error(`cannot install: ${h.error ?? 'privileged installer unavailable'}. Install the helper first, or start a dry run.`) }
    }
    const job = new Job(req.source, req)
    this.publish(job)
    return this.launch(job, () => this.execute(job))
  }

  private async execute(job: Job): Promise<void> {
    const P = this.platform
    await mkdir(this.workDir, { recursive: true })
    const stageDir = join(this.workDir, 'stage', job.id)
    job.info(`platform ${P.os}/${P.arch} · installer ${this.installer.kind} · work dir ${this.workDir}`)
    if (job.source === 'release') {
      job.defineSteps([['resolve', 'Resolve release'], ['download', 'Download artifact'], ['verify', 'Verify checksum'], ['extract', P.artifactKind === 'pkg' ? 'Stage package' : 'Extract and stage'], ['install', 'Install (privileged)'], ['restart', 'Restart service'], ['confirm', 'Confirm running version']])
      const rel = await job.runStep('resolve', async () => {
        const r = job.ref === 'latest' ? await this.gh.latestRelease() : await this.gh.releaseByTag(job.ref.startsWith('v') ? job.ref : `v${job.ref}`)
        const asset = this.pickAsset(r)
        if (!asset) throw new Error(`release ${r.tag_name} publishes no artifact for ${P.os}/${P.arch} (${r.assets.map((a) => a.name).join(', ')})`)
        const sums = r.assets.find((a) => a.name === P.checksumFile) ?? null
        job.info(`release ${r.tag_name} (${r.published_at}) · ${asset.name} · ${(asset.size / 1e6).toFixed(1)} MB${sums ? '' : ` · no ${P.checksumFile} published`}`)
        return { r, asset, sums }
      })
      const dlDir = join(this.workDir, 'downloads'); await mkdir(dlDir, { recursive: true })
      const artifact = join(dlDir, rel.asset.name)
      await job.runStep('download', async () => { const n = await downloadTo(rel.asset.browser_download_url, artifact, job.signal); job.info(`downloaded ${(n / 1e6).toFixed(1)} MB → ${artifact}`); job.throwIfCancelled() })
      await job.runStep('verify', async () => {
        const actual = await sha256File(artifact)
        if (!rel.sums) { job.info(`sha256 ${actual} (unverified: no checksum file in this release)`); return }
        const text = await (await fetch(rel.sums.browser_download_url, { signal: AbortSignal.timeout(15_000) })).text()
        const line = text.split('\n').find((l) => l.trim().endsWith(rel.asset.name))
        if (!line) throw new Error(`${P.checksumFile} has no entry for ${rel.asset.name}`)
        const expected = line.trim().split(/\s+/)[0].toLowerCase()
        if (expected !== actual) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`)
        job.info(`sha256 OK ${actual}`)
      })
      await job.runStep('extract', async () => {
        await rm(stageDir, { recursive: true, force: true }); await mkdir(stageDir, { recursive: true })
        if (P.artifactKind === 'pkg') {
          // macOS / FreeBSD ship installer packages; the helper installs them with the native tool.
          await copyFile(artifact, join(stageDir, rel.asset.name))
          await writeFile(join(stageDir, 'PACKAGE'), rel.asset.name + '\n')
          job.result.artifact = rel.asset.name
          job.info(`staged package ${rel.asset.name} → ${stageDir}`)
          return
        }
        const x = join(this.workDir, 'extract', job.id)
        await rm(x, { recursive: true, force: true }); await mkdir(x, { recursive: true })
        await job.exec('tar', ['xf', artifact, '-C', x]) // bsdtar/GNU tar both handle .tar.gz and .zip
        const top = await findDirContaining(x, 'fips' + P.exe)
        if (!top) throw new Error(`no ${'fips' + P.exe} inside ${rel.asset.name}`)
        await this.stageBinaries(job, top, stageDir)
        await rm(x, { recursive: true, force: true })
      })
    } else {
      job.defineSteps([['sync', 'Sync source from git'], ['build', 'cargo build --release'], ['stage', 'Stage binaries'], ['install', 'Install (privileged)'], ['restart', 'Restart service'], ['confirm', 'Confirm running version']])
      const src = join(this.workDir, 'src', 'fips')
      const builtSha = await job.runStep('sync', async () => {
        if (!existsSync(join(src, '.git'))) { await mkdir(join(this.workDir, 'src'), { recursive: true }); await job.exec('git', ['clone', '--no-checkout', this.repoUrl, src]) }
        await job.exec('git', ['fetch', '--prune', '--tags', 'origin'], { cwd: src })
        // A bare branch name must mean the remote branch just fetched, not the local branch git created at clone
        // time (which is never updated and would silently build stale code). Try origin/<ref> first, then <ref>
        // itself (tags, shas, explicit origin/... names).
        let target: string | null = null
        for (const cand of job.ref.startsWith('origin/') ? [job.ref] : [`origin/${job.ref}`, job.ref]) {
          const r = await run('git', ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], { cwd: src })
          if (r.code === 0 && r.stdout.trim()) { target = r.stdout.trim(); job.info(`${job.ref} → ${cand} = ${target.slice(0, 12)}`); break }
        }
        if (!target) throw new Error(`unknown ref '${job.ref}': not a branch on origin, tag, or commit`)
        await job.exec('git', ['checkout', '--force', '--detach', target, '--'], { cwd: src })
        const sha = (await job.exec('git', ['rev-parse', 'HEAD'], { cwd: src, quiet: true })).trim()
        const subject = (await job.exec('git', ['log', '-1', '--format=%s (%ci)'], { cwd: src, quiet: true })).trim()
        job.info(`building ${sha.slice(0, 10)} — ${subject}`)
        return sha
      })
      const targetDir = join(this.workDir, 'target')
      await job.runStep('build', async () => {
        const env: NodeJS.ProcessEnv = { CARGO_TARGET_DIR: targetDir, CARGO_TERM_COLOR: 'never', CARGO_TERM_PROGRESS_WHEN: 'never' }
        const tc = await this.toolchain()
        if (!tc.cargo.ok) throw new Error('cargo not found; install Rust from https://rustup.rs')
        if (!tc.libclang.ok) job.info('warning: libclang not detected; the fips-gateway build may fail (set LIBCLANG_PATH)')
        await job.exec('cargo', ['build', '--release', '--locked', ...this.cargoArgs], { cwd: src, env })
      })
      await job.runStep('stage', async () => { await this.stageBinaries(job, join(targetDir, P.cargoOut), stageDir, builtSha) })
    }

    job.result.stageDir = stageDir
    if (P.artifactKind !== 'pkg' || job.source === 'master') {
      const staged = parseVersionOutput((await run(join(stageDir, 'fips' + P.exe), ['--version'], { timeout: 5000 })).stdout)
      if (!staged) throw new Error('staged fips binary did not report a version')
      job.result.stagedVersion = staged.rev ? `${staged.version} (rev ${staged.rev})` : staged.version
      job.info(`staged version: ${job.result.stagedVersion}`)
    } else {
      job.result.stagedVersion = job.ref === 'latest' ? 'latest release' : job.ref
    }
    job.emitState()

    if (job.dryRun) {
      for (const s of ['install', 'restart', 'confirm']) job.skipStep(s, 'dry run')
      job.info(`dry run: staged in ${stageDir}; nothing was installed`)
      return
    }

    job.cancellable = false; job.emitState()
    const before = await this.runningVersion()
    const r = await job.runStep('install', () => this.installer.install(job, stageDir, job.restart))
    job.result.backupId = r.backup_id; job.result.restarted = !!r.restarted
    if (!job.restart && !job.result.restarted) { job.skipStep('restart', 'restart disabled by operator'); job.skipStep('confirm', 'restart disabled by operator'); job.info('binaries installed; the running daemon keeps the old version until the service restarts'); return }
    await job.runStep('restart', async () => { if (!job.result.restarted) throw new Error(await this.restartFailureMessage('binaries are installed')) })
    await job.runStep('confirm', async () => {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const v = await this.runningVersion()
        if (v?.version && (!before || v.pid !== before.pid)) {
          job.result.runningVersion = v.rev ? `${v.version} (rev ${v.rev})` : v.version
          job.info(`daemon is back: ${job.result.runningVersion} (pid ${v.pid})`)
          const expectRev = job.result.stagedVersion?.match(/rev ([^)\s]+)/)?.[1]
          if (expectRev && v.rev && expectRev !== v.rev) throw new Error(`daemon reports ${job.result.runningVersion}, expected ${job.result.stagedVersion}`)
          return
        }
        await new Promise((res) => setTimeout(res, 1500))
      }
      throw new Error('daemon did not answer on the control socket within 120 s after restart')
    })
  }

  /**
   * Copy the daemon binaries from `from` into a fresh stage dir. With `expectSha` (the commit that was just
   * built), each binary's `--version` revision must be a prefix of it: a binary reporting another revision is a
   * leftover from an earlier build of a different ref in the shared target dir and is not staged (optional
   * binaries are skipped, required ones fail the job). Cargo does not relink fresh binaries, so mtimes cannot
   * tell a leftover from a legitimately up-to-date one; the embedded revision can.
   */
  private async stageBinaries(job: Job, from: string, stageDir: string, expectSha?: string): Promise<void> {
    await rm(stageDir, { recursive: true, force: true }); await mkdir(stageDir, { recursive: true })
    const staged: string[] = []
    for (const b of this.platform.binaries) {
      const p = join(from, b)
      const required = b.startsWith('fips.') || b === 'fips' || b.startsWith('fipsctl')
      if (!existsSync(p)) { if (required) throw new Error(`missing ${b} in ${from}`); job.info(`note: ${b} not present, skipping`); continue }
      if (expectSha) {
        const v = parseVersionOutput((await run(p, ['--version'], { timeout: 5000 })).stdout)
        const rev = v?.rev?.replace(/[^0-9a-f].*$/, '')
        if (rev && !expectSha.startsWith(rev)) { if (required) throw new Error(`${b} reports rev ${rev}, not the ${expectSha.slice(0, 10)} that was just built (left over from an earlier build)`); job.info(`note: ${b} is from an earlier build (rev ${rev}), not staged`); continue }
        if (!rev) job.info(`note: ${b} reports no revision; staged unverified`)
      }
      await copyFile(p, join(stageDir, b))
      if (this.platform.os !== 'windows') await chmod(join(stageDir, b), 0o755)
      staged.push(b)
    }
    await writeFile(join(stageDir, 'SOURCE'), `${job.source} ${job.ref} ${new Date().toISOString()}\n`)
    job.info(`staged ${staged.join(', ')} → ${stageDir}`)
  }

  async rollback(id: string): Promise<Job> {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('invalid backup id')
    this.claimSlot()
    const job = new Job('release', { source: 'release' }, `rollback:${id}`, 'rollback')
    this.publish(job)
    job.cancellable = false
    return this.launch(job, async () => {
      job.defineSteps([['install', `Restore backup ${id} (privileged)`], ['confirm', 'Confirm running version']])
      const h = await this.installer.check(); if (!h.available) throw new Error(`cannot roll back: ${h.error}`)
      const before = await this.runningVersion()
      const r = await job.runStep('install', () => this.installer.rollback(job, id))
      const pre = r.pre_rollback_backup ?? r.backup_id
      if (pre) { job.result.backupId = pre; job.info(`safety backup of the replaced binaries: ${pre}`) }
      job.result.restarted = !!r.restarted; job.emitState()
      if (!r.restarted) throw new Error(await this.restartFailureMessage('the backup is restored on disk'))
      await job.runStep('confirm', async () => {
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          const v = await this.runningVersion()
          if (v?.version && (!before || v.pid !== before.pid)) { job.result.runningVersion = v.rev ? `${v.version} (rev ${v.rev})` : v.version; job.info(`daemon is back: ${job.result.runningVersion}`); return }
          await new Promise((res) => setTimeout(res, 1500))
        }
        throw new Error('daemon did not come back within 120 s')
      })
    })
  }

  restartService(): Promise<string> { return this.installer.restart() }

  /** The helper reports restarted:false both when the unit is unknown and when the restart failed; say which state the daemon is really in. */
  private async restartFailureMessage(done: string): Promise<string> {
    const v = await this.runningVersion()
    const state = v?.version ? `the previously running daemon (${v.rev ? `${v.version} rev ${v.rev}` : v.version}, pid ${v.pid}) is still up` : 'the daemon is not answering on the control socket, so the service is probably down'
    return `the installer could not restart the service (see the helper output above); ${done} and ${state}`
  }
}

async function findDirContaining(root: string, file: string, depth = 3): Promise<string | null> {
  if (existsSync(join(root, file))) return root
  if (depth === 0) return null
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const r = await findDirContaining(join(root, e.name), file, depth - 1)
    if (r) return r
  }
  return null
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function createUpgradeHandler(opts: UpgradeOptions = {}): ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & { manager: UpgradeManager } {
  const mgr = new UpgradeManager(opts)
  const prefix = (opts.prefix ?? '/api/upgrade').replace(/\/$/, '')

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false
    const sub = url.pathname.slice(prefix.length) || '/'
    const method = req.method ?? 'GET'
    if (method === 'POST' && opts.authorize && !(await opts.authorize(req))) { sendJson(res, 403, { error: 'forbidden' }); return true }

    try {
      if (sub === '/status' && method === 'GET') { sendJson(res, 200, await mgr.status(url.searchParams.get('refresh') === '1')); return true }
      if (sub === '/backups' && method === 'GET') { sendJson(res, 200, { backups: await mgr.installer.listBackups() }); return true }
      if (sub === '/jobs' && method === 'POST') { const body = (await readJsonBody(req)) as unknown as JobRequest; sendJson(res, 202, (await mgr.start(body)).summary()); return true }
      if (sub === '/jobs/current' && method === 'GET') {
        const j = mgr.job; if (!j) { sendJson(res, 404, { error: 'no job' }); return true }
        sendJson(res, 200, { ...j.summary(), log: j.logSince(Number(url.searchParams.get('since') ?? '0')) }); return true
      }
      if (sub === '/jobs/current/events' && method === 'GET') {
        const j = mgr.job; if (!j) { sendJson(res, 404, { error: 'no job' }); return true }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        for (const l of j.logSince(Number(url.searchParams.get('since') ?? '0'))) send('log', l)
        send('state', j.summary())
        const unsub = j.subscribe((ev) => send(ev.type, ev.data))
        const ka = setInterval(() => res.write(': ka\n\n'), 20_000)
        req.on('close', () => { unsub(); clearInterval(ka) })
        return true
      }
      if (sub === '/jobs/current/cancel' && method === 'POST') { const j = mgr.job; if (!j) { sendJson(res, 404, { error: 'no job' }); return true } sendJson(res, 200, { cancelled: j.cancel() }); return true }
      if (sub === '/rollback' && method === 'POST') { const body = (await readJsonBody(req)) as { id?: string }; if (!body.id) { sendJson(res, 400, { error: 'id required' }); return true } sendJson(res, 202, (await mgr.rollback(body.id)).summary()); return true }
      if (sub === '/restart' && method === 'POST') { sendJson(res, 200, { output: await mgr.restartService() }); return true }
      if (sub === '/toolchain/plan' && method === 'GET') { sendJson(res, 200, await mgr.toolchainPlan()); return true }
      sendJson(res, 404, { error: 'not found' }); return true
    } catch (e) { if (e instanceof BodyError) sendJson(res, e.status, { error: e.message }, e.status === 413); else sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); return true }
  }
  return Object.assign(handler, { manager: mgr })
}

// ---------------------------------------------------------------------------
// Standalone entry point (testing / development)
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787)
  const host = process.env.HOST ?? '127.0.0.1'
  const upgrade = createUpgradeHandler()
  createServer(async (req, res) => { if (await upgrade(req, res)) return; sendJson(res, 404, { error: 'not found' }) })
    .listen(port, host, () => console.log(`fips-ui upgrade API on http://${host}:${port}/api/upgrade  (${upgrade.manager.platform.os}/${upgrade.manager.platform.arch}, workDir ${upgrade.manager.workDir})`))
}
