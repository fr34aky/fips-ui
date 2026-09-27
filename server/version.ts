// fips-ui's own version. Releases are git tags (vX.Y.Z), so a git checkout reports the tag it is on ("0.8.0"),
// or the last tag plus the number of commits after it ("0.8.0+3"). Without git history (a source archive, git
// missing) it falls back to package.json's version, which is not bumped for every release.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DESCRIBE_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(\d+)-g[0-9a-f]+$/;

export function packageVersion(root: string): string {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

export function uiVersion(root: string): string {
  // Only this checkout's own history: never the tags of a repository fips-ui happens to be unpacked inside.
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      // safe.directory: reading the tag is harmless even when another user owns the checkout.
      const d = execFileSync('git', ['-c', `safe.directory=${root}`, 'describe', '--tags', '--long', '--match', 'v[0-9]*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      const m = DESCRIBE_RE.exec(d);
      if (m) return m[2] === '0' ? m[1] : `${m[1]}+${m[2]}`;
    } catch { /* no git, or no tag in reach (shallow clone) */ }
  }
  return packageVersion(root);
}
