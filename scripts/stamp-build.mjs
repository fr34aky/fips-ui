// Records which version of web/ the frontend in web/dist was built from: git's tree hash of web/ at HEAD, in
// web/dist/.build-source. deploy/setup-local.sh compares it with the checkout and rebuilds a frontend built for an
// older one (after a git pull). Without git (a tarball), nothing is recorded.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'dist', '.build-source');
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // Built from uncommitted changes: not HEAD's tree, so setup-local.sh builds it again from the checkout.
  const dirty = git('status', '--porcelain', '--', 'web') !== '';
  writeFileSync(out, `${git('rev-parse', 'HEAD:web')}${dirty ? '-dirty' : ''}\n`);
} catch {
  rmSync(out, { force: true });
}
