// The node manager (server/fleet.ts): configuration rules, the status derived from a managed node's answers,
// and the poller with a fake HTTP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet, FleetError, classify, deriveNodeStatus, effectiveManagers, validateFleetConfig, type FetchJson, type FetchResult } from '../server/fleet.ts';

const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const npub = (seed: number) => { const d = Array.from({ length: 4 }, (_, i) => CHARS[Math.floor(seed / 32 ** i) % 32]).join(''); return 'npub1' + d + Array.from({ length: 54 }, (_, i) => CHARS[(i * 13) % 32]).join(''); };
const [ME, A, B, STANDBY] = [0, 1, 2, 3].map(npub);
const dir = mkdtempSync(join(tmpdir(), 'fips-ui-fleet-'));
let n = 0;
const file = () => join(dir, `fleet-${n++}.json`);

test('validateFleetConfig: defaults, limits, duplicates and the node itself', () => {
  const cfg = validateFleetConfig({ nodes: [{ npub: A, label: ' Home <x> ' }], managers: [{ npub: STANDBY }] }, ME);
  assert.deepEqual(cfg, { nodes: [{ npub: A, port: 8321, label: 'Home x' }], managers: [{ npub: STANDBY }] });
  assert.throws(() => validateFleetConfig({ nodes: [{ npub: 'npub1nope' }], managers: [] }), /invalid npub/);
  assert.throws(() => validateFleetConfig({ nodes: [{ npub: A }, { npub: A }], managers: [] }), /listed twice/);
  assert.throws(() => validateFleetConfig({ nodes: [{ npub: ME }], managers: [] }, ME), /cannot manage itself/);
  assert.throws(() => validateFleetConfig({ nodes: [{ npub: A, port: 70000 }], managers: [] }), /port/);
  assert.throws(() => validateFleetConfig({ nodes: [], managers: Array.from({ length: 17 }, (_, i) => ({ npub: npub(10 + i) })) }), /at most 16/);
  // The same npub may be managed and be a standby manager.
  assert.doesNotThrow(() => validateFleetConfig({ nodes: [{ npub: A }], managers: [{ npub: A }] }, ME));
});

test('effectiveManagers: this node first, once', () => {
  assert.deepEqual(effectiveManagers({ nodes: [], managers: [{ npub: STANDBY }, { npub: ME }] }, ME), [ME, STANDBY]);
  assert.deepEqual(effectiveManagers({ nodes: [], managers: [{ npub: STANDBY }] }), [STANDBY]);
});

test('classify: the node\'s own reason, and what 401 means', () => {
  assert.equal(classify({ status: 200, body: {} }), null);
  assert.equal(classify({ status: 403, body: { error: 'this node does not allow your npub' } })?.kind, 'unauthorised');
  assert.match(classify({ status: 403, body: { error: 'this node does not allow your npub' } })!.message, /does not allow your npub/);
  assert.equal(classify({ status: 401, body: { error: 'unauthorized' } })?.kind, 'unauthorised');
  assert.equal(classify({ status: 503, body: { error: 'guard reloaded' } })?.kind, 'not-ready');
  assert.equal(classify({ status: 500, body: null })?.kind, 'other');
});

const node = { npub: A, port: 8321, label: 'a' };
const health = (role: string, extra: Record<string, unknown> = {}): FetchResult => ({ status: 200, body: { ok: true, auth: 'npub', principal: { kind: 'mesh', role, npub: ME }, readOnly: role === 'viewer', nodeManagement: role !== 'viewer', uiVersion: '0.13.0', uiUptimeSecs: 42, version: '0.6.0', platform: { os: 'linux' }, ...extra } });
const access = (allowed: { npub: string; role: string }[]): FetchResult => ({ status: 200, body: { config: { enabled: true, port: 8321, allowed }, status: { npub: A } } });

test('deriveNodeStatus: an admin grant with every manager listed', () => {
  const s = deriveNodeStatus(node, undefined, {
    health: health('admin'), status: { status: 200, body: { peer_count: 3, uptime_secs: 1000, version: '0.6.0' } },
    access: access([{ npub: ME, role: 'admin' }, { npub: STANDBY, role: 'superadmin' }]),
    uiUpdate: { status: 200, body: { current: '0.13.0', latest: { version: '0.14.0' }, newer: true, job: null, helper: { installed: 12, shipped: 13 } } },
    upgrade: { status: 200, body: { installed: { version: '0.6.0' }, running: { version: '0.6.0' }, release: { tag: 'v0.7.0', relation: 'newer' }, restartPending: false, job: null, helper: { version: 12 } } },
  }, [ME, STANDBY], 1000);
  assert.equal(s.phase, 'ok');
  assert.equal(s.reachable, true);
  assert.equal(s.lastSeen, 1000);
  assert.equal(s.peerCount, 3);
  assert.equal(s.uptimeSecs, 1000);
  assert.equal(s.daemonVersion, '0.6.0');
  assert.equal(s.uiVersion, '0.13.0');
  assert.equal(s.platform, 'linux');
  assert.equal(s.managersInSync, true);
  assert.deepEqual(s.managersMissing, []);
  assert.deepEqual(s.helper, { installed: 12, shipped: 13 });
  assert.equal(s.uiUpdate?.available, true);
  assert.equal(s.uiUpdate?.latest, '0.14.0');
  assert.equal(s.upgrade?.available, true);
  assert.equal(s.upgrade?.latest, '0.7.0');
});

test('deriveNodeStatus: managers missing, viewer grant, refusals, and what an offline node keeps', () => {
  const ok = deriveNodeStatus(node, undefined, { health: health('admin'), access: access([{ npub: ME, role: 'admin' }, { npub: STANDBY, role: 'viewer' }]) }, [ME, STANDBY], 1);
  assert.equal(ok.managersInSync, false);
  assert.deepEqual(ok.managersMissing, [STANDBY]);
  // The node's own npub never counts as missing (it cannot be on its own list).
  assert.equal(deriveNodeStatus(node, undefined, { health: health('admin'), access: access([{ npub: ME, role: 'admin' }]) }, [ME, A], 1).managersInSync, true);
  const viewer = deriveNodeStatus(node, undefined, { health: health('viewer') }, [ME], 2);
  assert.equal(viewer.phase, 'viewer');
  assert.equal(viewer.reachable, true);
  assert.equal(viewer.uiVersion, '0.13.0');
  assert.equal(deriveNodeStatus(node, undefined, { health: { status: 403, body: { error: 'nope' } } }, [ME], 3).phase, 'unauthorised');
  // The node's main listener answers health openly as its local operator: not a grant.
  const main = deriveNodeStatus(node, undefined, { health: health('superadmin', { auth: 'none', principal: { kind: 'local', role: 'superadmin' } }) }, [ME], 3);
  assert.equal(main.phase, 'unauthorised');
  assert.match(main.error ?? '', /main listener/);
  // A managed node that is a standby manager too is never missing from its own list.
  assert.equal(deriveNodeStatus(node, undefined, { health: health('admin'), access: { status: 200, body: { config: { allowed: [{ npub: ME, role: 'admin' }] }, status: {} } } }, [ME, A], 1).managersInSync, true);
  // Only the job's state travels, not its log.
  const withJob = deriveNodeStatus(node, undefined, { health: health('admin'), uiUpdate: { status: 200, body: { current: '1', newer: false, job: { state: 'failed', restarting: false, log: ['a', 'b'], error: 'x' } } } }, [ME], 1);
  assert.deepEqual(withJob.uiUpdate?.job, { state: 'failed' });
  assert.equal(deriveNodeStatus(node, undefined, { health: { status: 503, body: {} } }, [ME], 3).phase, 'not-ready');
  const off = deriveNodeStatus(node, ok, { health: new FleetError('cannot reach', 'offline') }, [ME], 4);
  assert.equal(off.phase, 'offline');
  assert.equal(off.reachable, false);
  assert.equal(off.uiVersion, '0.13.0', 'the last known version stays');
  assert.equal(off.lastSeen, 1);
  assert.equal(off.lastAttempt, 4);
  assert.equal(off.managersInSync, false);
});

/** A fake fleet: answers per node and path; `peak` is the most nodes with a request in flight at the same time. */
function fakeFetch(answers: Record<string, Record<string, FetchResult | Error>>, log: string[] = []) {
  const inflight = new Map<string, number>();
  let peak = 0;
  const fetchJson: FetchJson = async (npub, _port, path) => {
    inflight.set(npub, (inflight.get(npub) ?? 0) + 1); peak = Math.max(peak, inflight.size);
    log.push(`${npub.slice(5, 9)} ${path}`);
    await new Promise((r) => setTimeout(r, 2));
    if (inflight.get(npub) === 1) inflight.delete(npub); else inflight.set(npub, inflight.get(npub)! - 1);
    const a = answers[npub]?.[path];
    if (!a) throw new FleetError('cannot reach', 'offline');
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetchJson, peak: () => peak };
}

test('Fleet: saves, probes with bounded concurrency, and reports the nodes in order', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => npub(20 + i));
  const answers: Record<string, Record<string, FetchResult | Error>> = {};
  for (const x of nodes) answers[x] = { '/api/health': health('admin'), '/api/q/show_status': { status: 200, body: { peer_count: 1 } }, '/api/access': access([{ npub: ME, role: 'admin' }]) };
  delete answers[nodes[5]]; // offline
  const log: string[] = [];
  const f = fakeFetch(answers, log);
  const fleet = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson: f.fetchJson, file: file(), intervalMs: 60_000, now: () => 7 });
  await fleet.start();
  assert.equal(fleet.enabled, false);
  await fleet.save({ nodes: nodes.map((x) => ({ npub: x })), managers: [] });
  await fleet.refresh();
  const snap = fleet.snapshot();
  assert.deepEqual(snap.managers, [ME]);
  assert.deepEqual(snap.nodes.map((s) => s.npub), nodes);
  assert.equal(snap.nodes[0].phase, 'ok');
  assert.equal(snap.nodes[5].phase, 'offline');
  assert.equal(snap.nodes[0].managersInSync, true);
  assert.ok(f.peak() <= 4, `at most 4 nodes at a time, saw ${f.peak()}`);
  // The first run is a slow one (release checks included); they were asked for.
  assert.ok(log.some((l) => l.endsWith('/api/ui-update')));
  assert.equal(snap.status.lastRun, 7);
  // Removing a node drops its status; saving the node itself is refused.
  await fleet.save({ nodes: [{ npub: nodes[0] }], managers: [{ npub: STANDBY }] });
  assert.equal(fleet.snapshot().nodes.length, 1);
  assert.deepEqual(fleet.managers(), [ME, STANDBY]);
  await assert.rejects(fleet.save({ nodes: [{ npub: ME }], managers: [] }), /cannot manage itself/);
  fleet.close();
});

test('Fleet: concurrent saves land in order, the last one wins', async () => {
  const path = file();
  const fleet = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson: fakeFetch({}).fetchJson, file: path, intervalMs: 60_000 });
  await fleet.start();
  await Promise.all([fleet.save({ nodes: [{ npub: A }], managers: [] }), fleet.save({ nodes: [{ npub: B }], managers: [] })]);
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).nodes.map((n: { npub: string }) => n.npub), [B]);
  assert.deepEqual(fleet.config.nodes.map((n) => n.npub), [B]);
  fleet.close();
});

test('Fleet: a file that does not load is never overwritten', async () => {
  const path = file();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, '{ not json');
  const fleet = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson: fakeFetch({}).fetchJson, file: path });
  await fleet.start();
  assert.match(fleet.status.error ?? '', /cannot load/);
  await assert.rejects(fleet.save({ nodes: [], managers: [] }), /cannot load/);
  // Once the file is fixed (or removed), saving works again without a restart.
  writeFileSync(path, '{"nodes":[],"managers":[]}');
  await fleet.save({ nodes: [{ npub: A }], managers: [] });
  assert.equal(fleet.status.error, undefined);
  assert.equal(fleet.config.nodes.length, 1);
  fleet.close();
});
