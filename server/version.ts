// fips-ui's own version. Releases are git tags (vX.Y.Z), so a git checkout reports the tag it is on ("0.8.0"),
// or the last tag plus the number of commits after it ("0.8.0+3"). When git cannot tell (git missing, an old git
// refusing a checkout owned by another user), the release the self-update last installed counts if the checkout is
// still on it; a source archive of a release carries its tag in VERSION (git archive's export-subst). Only then
// package.json's version, which is not bumped for every release.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DESCRIBE_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(\d+)-g[0-9a-f]+$/;
const TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
/** Written by the self-update next to fips-ui-previous: "<tag> <commit>". */
export const RELEASE_MARKER = 'fips-ui-release';

const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/** The commit HEAD points at, read from the files (no git binary needed). */
function headCommit(gitDir: string): string | null {
  const head = read(path.join(gitDir, 'HEAD'))?.trim();
  if (!head) return null;
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  const loose = read(path.join(gitDir, ref))?.trim();
  if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose;
  for (const line of (read(path.join(gitDir, 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

export function packageVersion(root: string): string {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

export function uiVersion(root: string): string {
  // Only this checkout's own history: never the tags of a repository fips-ui happens to be unpacked inside.
  const gitDir = path.join(root, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      // safe.directory: reading the tag is harmless even when another user owns the checkout.
      const d = execFileSync('git', ['-c', `safe.directory=${root}`, 'describe', '--tags', '--long', '--match', 'v[0-9]*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      const m = DESCRIBE_RE.exec(d);
      if (m) return m[2] === '0' ? m[1] : `${m[1]}+${m[2]}`;
    } catch { /* no git, or no tag in reach (shallow clone) */ }
    const [tag, commit] = (read(path.join(gitDir, RELEASE_MARKER)) ?? '').trim().split(' ');
    const m = TAG_RE.exec(tag ?? '');
    if (m && commit && commit === headCommit(gitDir)) return m[1];
  }
  // "$Format:%D$" in the repository; "HEAD -> main, tag: v0.8.0, …" in a source archive of a release; a package
  // build (the Nix flake) writes "version: <version>" instead.
  const file = read(path.join(root, 'VERSION'))?.trim() ?? '';
  const built = /^version: ([0-9A-Za-z.+-]{1,64})$/m.exec(file);
  if (built) return built[1];
  const archived = /\btag: v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:,|$)/.exec(file);
  if (archived) return archived[1];
  return packageVersion(root);
}
