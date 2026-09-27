#!/usr/bin/env node
// Smoke test against a running fips-ui (used by .github/workflows/smoke.yml, runnable by hand):
//   node scripts/smoke-test.mjs [--url http://127.0.0.1:8321] [--os linux] [--daemon] [--helper] [--supervised]
//                               [--killed-at <unix seconds>] [--token <FIPS_UI_TOKEN>]
// --daemon      the fips daemon runs: health must report it
// --helper      the privileged helper is installed: node management must be available with the shipped version
// --supervised  fips-ui runs under a service that restarts it (the self-update can restart it)
// --killed-at   its process was killed at this time: the answering server must have started after it
// --token       FIPS_UI_TOKEN of the installation (default: the FIPS_UI_TOKEN environment variable)
// Exits non-zero on the first failed check.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
const base = opt('--url') ?? 'http://127.0.0.1:8321';
const token = opt('--token') ?? process.env.FIPS_UI_TOKEN;

const expectVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const shippedHelper = Number(/^HELPER_VERSION=(\d+)/m.exec(readFileSync(join(root, 'scripts/fips-ui-helper'), 'utf8'))?.[1]);

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}
async function get(path) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(10_000), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  let body = text; try { body = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, body };
}

// Wait up to 60 s for the server (it may just have been (re)started).
let health;
for (let i = 0; i < 120; i++) {
  try { health = await get('/api/health'); if (health.status === 200) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!health || health.status !== 200) { check('server answers /api/health', false, health?.status ?? 'no answer'); process.exit(1); }
const h = health.body;
check('server answers /api/health', true);
check('uiVersion is the checkout\'s', h.uiVersion === expectVersion, `${h.uiVersion} (package.json ${expectVersion})`);
if (opt('--os')) check('platform os', h.platform?.os === opt('--os'), h.platform);
if (opt('--killed-at') !== undefined) {
  const startedAt = Math.floor(Date.now() / 1000) - h.uiUptimeSecs;
  check('restarted after its process was killed', startedAt >= Number(opt('--killed-at')) - 1, `started ${startedAt}, killed ${opt('--killed-at')}`);
}
if (flag('--daemon')) check('daemon reachable', h.ok === true && typeof h.version === 'string', h.error ?? `fips ${h.version}`);
else console.log(`info daemon: ${h.ok ? `fips ${h.version}` : h.error}`);

const index = await get('/');
check('frontend is served', index.status === 200 && typeof index.body === 'string' && index.body.includes('<div id="root">'), index.status);

const snap = await get('/api/snapshot');
check('/api/snapshot answers', snap.status === 200, snap.status);
const sys = await get('/api/system');
check('/api/system answers', sys.status === 200, sys.status);

const admin = await get('/api/admin/status?refresh=1');
check('/api/admin/status answers', admin.status === 200, admin.status);
const helper = admin.body?.helper ?? {};
if (flag('--helper')) {
  check('helper installed at the shipped version', helper.available === true && helper.version === shippedHelper, { available: helper.available, version: helper.version, shipped: shippedHelper, error: helper.error });
  check('node management available', helper.managementCapable === true, helper.features);
  check('/api/health reports node management', h.nodeManagement === true);
  const cfg = await get('/api/admin/config');
  if (helper.features?.config) check('configuration readable through the helper', cfg.status === 200 && typeof cfg.body?.yaml === 'string', cfg.status === 200 ? cfg.body.path : cfg.body);
  const fw = await get('/api/admin/firewall');
  check('firewall state readable', fw.status === 200, fw.status === 200 ? { backend: fw.body.backend } : fw.body);
} else console.log(`info helper: ${helper.available ? `v${helper.version}` : helper.error ?? 'not installed'}`);

const hosts = await get('/api/hosts');
check('hosts file state answers', hosts.status === 200, hosts.status === 200 ? hosts.body.path : hosts.body);
const logs = await get('/api/logs?lines=5');
check('/api/logs answers', logs.status === 200, logs.status);

const upd = await get('/api/ui-update');
check('/api/ui-update answers', upd.status === 200, upd.status);
if (flag('--supervised')) check('self-update can restart fips-ui', upd.body?.canRestart === true, upd.body?.canRestart);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
