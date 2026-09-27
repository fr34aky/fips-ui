// Keeping fips.yaml in step with the daemon's template (packaging/common/fips.yaml upstream) across upgrades. The
// template's changes between the running and the installed version are merged into the node's configuration
// with a 3-way merge (git merge-file), the way package managers treat changed config files: the node's own edits
// stay, the template's edits are added. The merge works on the redacted configuration, so secrets never leave
// the helper; a clean result is applied through config-apply (backup, restart, automatic rollback), a conflicted
// one is kept as a proposal for the Configuration page.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigMergeHook, ConfigMergeResult } from './upgrade.ts';
import type { LogLine } from './journal.ts';

const PROPOSAL_FILE = process.env.FIPS_UI_CONFIG_PROPOSAL_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'config-proposal.json');

/** A merge that could not be applied by itself, for the Configuration page to offer. */
export interface ConfigProposal { at: number; fromRev: string; toRef: string; base: string; yaml: string; conflicts: boolean; reason: string; templateDiff?: string }

function git(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0, out: stdout || stderr })));
}

/** Unified diff of two texts, without the file header lines. */
export async function unifiedDiff(a: string, b: string, labelA: string, labelB: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fips-ui-diff-'));
  try {
    await writeFile(join(dir, 'a'), a); await writeFile(join(dir, 'b'), b);
    const r = await git(['diff', '--no-index', '--no-color', '-U3', 'a', 'b'], dir);
    return r.out.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n').replace(/^/, `--- ${labelA}\n+++ ${labelB}\n`).trimEnd();
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 3-way merge: `ours` (the node's file) gets the change from `base` to `theirs` (old to new template). */
export async function merge3(ours: string, base: string, theirs: string, labels: [string, string, string]): Promise<{ text: string; conflicts: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'fips-ui-merge-'));
  try {
    await writeFile(join(dir, 'ours'), ours); await writeFile(join(dir, 'base'), base); await writeFile(join(dir, 'theirs'), theirs);
    // Exit status: 0 clean, >0 number of conflicts, <0 error.
    const r = await git(['merge-file', '-p', '-L', labels[0], '-L', labels[1], '-L', labels[2], 'ours', 'base', 'theirs'], dir);
    if (r.code < 0) throw new Error(`git merge-file failed: ${r.out.trim() || 'is git installed?'}`);
    return { text: r.out, conflicts: r.code > 0 };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function readProposal(): Promise<ConfigProposal | null> {
  try { return JSON.parse(await readFile(PROPOSAL_FILE, 'utf8')) as ConfigProposal; } catch { return null; }
}
export async function clearProposal(): Promise<void> { await unlink(PROPOSAL_FILE).catch(() => {}); }
async function saveProposal(p: ConfigProposal): Promise<void> {
  await mkdir(dirname(PROPOSAL_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${PROPOSAL_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(p), { mode: 0o600 }); await rename(tmp, PROPOSAL_FILE);
}

const short = (ref: string) => (/^[0-9a-f]{12,}$/.test(ref) ? ref.slice(0, 10) : ref);

export function createConfigMerge(deps: {
  show: () => Promise<{ yaml: string; base: string }>;
  apply: (yaml: string, base: string) => Promise<{ ok: boolean; error?: string; backup_id?: string }>;
  logs: (lines: number) => Promise<LogLine[]>;
}): ConfigMergeHook {
  return async ({ oldTemplate, newTemplate, fromRev, toRef, apply, restartedAt, log }) => {
    const from = short(fromRev), to = short(toRef);
    const res: ConfigMergeResult = { status: 'unchanged', detail: '', fromRev, toRef };
    try {
      if (oldTemplate === newTemplate) res.detail = `the template did not change between ${from} and ${to}`;
      else {
        res.templateDiff = await unifiedDiff(oldTemplate, newTemplate, `template ${from}`, `template ${to}`);
        const cur = await deps.show();
        const m = await merge3(cur.yaml, oldTemplate, newTemplate, ['your fips.yaml', `template ${from}`, `template ${to}`]);
        if (!m.conflicts && m.text === cur.yaml) { res.status = 'current'; res.detail = 'the template changed, but none of it applies to this fips.yaml (already up to date)'; }
        else {
          res.configDiff = await unifiedDiff(cur.yaml, m.text, 'fips.yaml', `fips.yaml merged with template ${to}`);
          const keep = async (reason: string) => { await saveProposal({ at: Date.now(), fromRev, toRef, base: cur.base, yaml: m.text, conflicts: m.conflicts, reason, templateDiff: res.templateDiff }); };
          if (m.conflicts) { res.status = 'proposed'; res.detail = 'the template changed lines this fips.yaml also changed; the merge (with conflict markers) waits on the Configuration page'; await keep('conflicts'); }
          else if (!apply) { res.status = 'proposed'; res.detail = 'merged cleanly; not applied (automatic update was turned off), waiting on the Configuration page'; await keep('not applied automatically'); }
          else {
            log('applying the merged fips.yaml (backup, restart, automatic rollback if the daemon does not stay up)');
            const r = await deps.apply(m.text, cur.base);
            if (r.ok) { res.status = 'applied'; res.detail = `updated to the ${to} template${r.backup_id ? ` (previous file: backup ${r.backup_id})` : ''}`; await clearProposal(); }
            else { res.status = 'failed'; res.detail = `the merged fips.yaml was rolled back: ${r.error ?? 'the daemon did not stay up'}; it waits on the Configuration page`; await keep(`rolled back: ${r.error ?? 'daemon did not stay up'}`); }
          }
        }
      }
    } catch (e) {
      res.status = 'failed'; res.detail = `could not update fips.yaml: ${(e as Error).message}`;
    }
    // Keys the new daemon still accepts but reports as deprecated (it warns once, at startup).
    try {
      const lines = await deps.logs(2000);
      const seen = new Set<string>();
      res.deprecations = lines.filter((l) => l.ts >= restartedAt - 5000 && /deprecat/i.test(l.message) && (!l.target || /config/.test(l.target)))
        .map((l) => l.message.trim()).filter((m) => !seen.has(m) && seen.add(m));
      if (res.deprecations.length) log(`the new daemon reports deprecated settings: ${res.deprecations.join(' | ')}`);
    } catch { /* the log is optional */ }
    return res;
  };
}
