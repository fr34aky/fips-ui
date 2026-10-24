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
  // Not a fips-ui at all on that port.
  assert.equal(deriveNodeStatus(node, undefined, { health: { status: 200, body: { error: '<html>' } } }, [ME], 3).phase, 'error');
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
  // A forced run asked for during a run still happens (with the list of that moment).
  const slow = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson: async (...a) => { await new Promise((r) => setTimeout(r, 30)); return f.fetchJson(...a); }, file: file(), intervalMs: 60_000 });
  await slow.start();
  await slow.save({ nodes: [{ npub: nodes[0] }], managers: [] });
  const first = slow.refresh();
  await slow.save({ nodes: [{ npub: nodes[0] }, { npub: nodes[1] }], managers: [] });
  await first;
  await slow.refresh();
  assert.equal(slow.snapshot().nodes[1].phase, 'ok', 'the node added during the run was probed by the run that followed');
  slow.close();
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

// ---- the proxy ----------------------------------------------------------------------------------

import http from 'node:http';
import { forwardQuery, parseProxyPath, proxyRequest } from '../server/fleet.ts';

test('parseProxyPath: only plain /api paths of a listed-looking npub', () => {
  assert.deepEqual(parseProxyPath(`/api/fleet/nodes/${A}/api/health`), { npub: A, path: '/api/health' });
  assert.deepEqual(parseProxyPath(`/api/fleet/nodes/${A}/api/upgrade/jobs/current/events`), { npub: A, path: '/api/upgrade/jobs/current/events' });
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/api/../etc`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/api/a//b`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/api/%2e%2e/x`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/api/a\\b`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/etc/passwd`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/api/x:y`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/npub1short/api/health`), null);
  assert.equal(parseProxyPath(`/api/fleet/nodes/${A}/api/${'a/'.repeat(300)}`), null);
  assert.equal(forwardQuery(new URLSearchParams('since=3&token=secret&x=y')), '?since=3&x=y');
  assert.equal(forwardQuery(new URLSearchParams('token=secret')), '');
});

test('proxyRequest: forwards GET and POST, strips the manager\'s headers, streams, and turns 401 into 502', async () => {
  // The "managed node": records what arrives, answers JSON, SSE, or 401.
  const seen: { method?: string; url?: string; headers?: http.IncomingHttpHeaders; body?: string }[] = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/api/needs-token') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
      if (req.url?.startsWith('/api/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'a=b', connection: 'keep-alive' });
        res.write('event: snapshot\ndata: {"n":1}\n\n');
        setTimeout(() => { res.write('event: snapshot\ndata: {"n":2}\n\n'); res.end(); }, 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b' });
      res.end(JSON.stringify({ ok: true, url: req.url, body }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as { port: number }).port;
  const node = { npub: A, port };
  // The "manager": every request is proxied (the body read like server/index.ts does).
  const front = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let body: Record<string, unknown> | undefined;
    if (req.method === 'POST') { let t = ''; for await (const c of req) t += c; body = JSON.parse(t); }
    await proxyRequest(req, res, node, url.pathname, forwardQuery(url.searchParams), { meshAddress: async () => '127.0.0.1', version: 'test', body });
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
  try {
    const r1 = await fetch(`${base}/api/health?token=secret&x=1`, { headers: { authorization: 'Bearer secret', cookie: 'c=d', origin: 'http://evil', accept: 'application/json' } });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-fips-ui-node'), A);
    assert.equal(r1.headers.get('set-cookie'), null, 'cookies never come back');
    assert.deepEqual(await r1.json(), { ok: true, url: '/api/health?x=1', body: '' });
    const h = seen[0].headers!;
    assert.equal(h.authorization, undefined); assert.equal(h.cookie, undefined); assert.equal(h.origin, undefined);
    assert.equal(h['user-agent'], 'fips-ui-fleet'); assert.equal(h['x-fips-ui-fleet'], 'test');
    assert.equal(h.host, `[127.0.0.1]:${port}`);

    const r2 = await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ peer: 'x' }) });
    assert.equal(r2.status, 200);
    assert.equal(seen[1].method, 'POST'); assert.equal(seen[1].headers!['content-type'], 'application/json'); assert.equal(seen[1].body, '{"peer":"x"}');

    const r3 = await fetch(`${base}/api/needs-token`);
    assert.equal(r3.status, 502);
    assert.equal((await r3.json() as { upstream: number }).upstream, 401);

    const r4 = await fetch(`${base}/api/events`);
    assert.equal(r4.headers.get('content-type'), 'text/event-stream');
    assert.equal(r4.headers.get('set-cookie'), null);
    const text = await r4.text();
    assert.ok(text.includes('{"n":1}') && text.includes('{"n":2}'), 'both events streamed through');

    upstream.close();
    const r5 = await fetch(`${base}/api/health`);
    assert.equal(r5.status, 502);
    assert.equal((await r5.json() as { kind: string }).kind, 'offline');
  } finally { front.close(); upstream.close(); }
});

// ---- the manager set ------------------------------------------------------------------------------

import { mergeManagers } from '../server/fleet.ts';

test('mergeManagers: adds missing managers as admins, promotes viewers, never removes or demotes', () => {
  const before = [{ npub: B, role: 'viewer' as const, label: 'b' }, { npub: ME, role: 'viewer' as const }, { npub: STANDBY, role: 'superadmin' as const }];
  const r = mergeManagers(before, [ME, STANDBY, A, npub(9)], A);
  assert.deepEqual(r.promoted, [ME]);
  assert.deepEqual(r.added, [npub(9)]);
  assert.deepEqual(r.allowed.map((e) => [e.npub, e.role]), [[B, 'viewer'], [ME, 'admin'], [STANDBY, 'superadmin'], [npub(9), 'admin']]);
  assert.equal(r.allowed[3].label, 'fips-ui manager');
  // Nothing to do: same list back, no changes reported.
  const same = mergeManagers(r.allowed, [ME, STANDBY, A, npub(9)], A);
  assert.equal(same.added.length + same.promoted.length, 0);
  assert.deepEqual(same.allowed, r.allowed);
  // Over the node's limit.
  assert.throws(() => mergeManagers(Array.from({ length: 200 }, (_, i) => ({ npub: npub(100 + i), role: 'viewer' as const })), [ME], A), /200 entries/);
});

test('Fleet.syncManagers writes the merged list to the node and reports it; a viewer grant cannot', async () => {
  const writes: unknown[] = [];
  const list = [{ npub: ME, role: 'viewer' }];
  const fetchJson: FetchJson = async (_npub, _port, path, init) => {
    if (path === '/api/health') return health('admin');
    if (path === '/api/q/show_status') return { status: 200, body: { peer_count: 1 } };
    if (path === '/api/access' && init?.method === 'POST') { writes.push(init.body); list.splice(0, list.length, ...(init.body as { allowed: typeof list }).allowed); return { status: 200, body: {} }; }
    if (path === '/api/access') return { status: 200, body: { config: { enabled: true, port: 8321, allowed: [...list] }, status: { npub: A } } };
    return { status: 404, body: { error: 'not found' } };
  };
  const fleet = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson, file: file(), intervalMs: 60_000 });
  await fleet.start();
  await fleet.save({ nodes: [{ npub: A }], managers: [{ npub: STANDBY }] });
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.managersInSync, false);
  const r = await fleet.syncManagers(A);
  assert.equal(r.changed, true);
  assert.deepEqual(r.promoted, [ME]);
  assert.deepEqual(r.added, [STANDBY]);
  assert.equal(writes.length, 1);
  assert.deepEqual((writes[0] as { allowed: { npub: string; role: string }[] }).allowed.map((e) => e.role), ['admin', 'admin']);
  assert.equal(r.node?.managersInSync, true);
  // Again: nothing to write.
  const again = await fleet.syncManagers(A);
  assert.equal(again.changed, false);
  assert.equal(writes.length, 1);
  // Bulk without a list: only reachable out-of-sync nodes (none now); with a list: those.
  assert.deepEqual(await fleet.syncAllManagers(), []);
  const all = await fleet.syncAllManagers([A, B]);
  assert.deepEqual(all.map((x) => [x.npub, x.changed]), [[A, false]], 'an unknown npub is left out, not thrown');
  await assert.rejects(fleet.syncManagers(B), /not managed/);
  fleet.close();
});

test('Fleet.expectRestart: the node is shown restarting once it is away, until it answers again or the window ends', async () => {
  let up = true;
  let uptime = 500;
  let now = 1000;
  const fetchJson: FetchJson = async (_n, _p, path) => {
    if (!up) throw new FleetError('cannot reach', 'offline');
    if (path === '/api/health') return health('admin', { uiUptimeSecs: uptime });
    return { status: 200, body: { peer_count: 1, config: { allowed: [{ npub: ME, role: 'admin' }] }, status: { npub: A } } };
  };
  const fleet = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson, file: file(), intervalMs: 60_000, now: () => now });
  await fleet.start();
  await fleet.save({ nodes: [{ npub: A }], managers: [] });
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'ok');
  // Told to restart, still up: nothing changes yet (the node answers 202 and restarts later).
  fleet.expectRestart(A, 60_000);
  assert.equal(fleet.nodeStatus(A)?.phase, 'ok');
  uptime = 510;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'ok');
  // Away: restarting, with the last known version.
  up = false;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'restarting');
  assert.equal(fleet.nodeStatus(A)?.uiVersion, '0.13.0');
  // Back: the wait is over; away again later is plain offline.
  up = true; uptime = 3;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'ok');
  up = false;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'offline');
  // A restart between two probes shows as a fallen uptime: the wait ends without a failed probe.
  up = true; uptime = 100;
  await fleet.refresh();
  fleet.expectRestart(A, 60_000);
  uptime = 2;
  await fleet.refresh();
  up = false;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'offline', 'the uptime fell, so the restart had happened');
  // The window ends: a node still away is offline.
  up = true;
  await fleet.refresh();
  fleet.expectRestart(A, 10);
  up = false;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'restarting');
  now += 20;
  await fleet.refresh();
  assert.equal(fleet.nodeStatus(A)?.phase, 'offline');
  assert.match(fleet.nodeStatus(A)?.error ?? '', /did not answer again/);
  fleet.close();
});

test('Fleet.pollNode: a probe already under way is shared, not raced', async () => {
  let calls = 0;
  const fetchJson: FetchJson = async (_n, _p, path) => { calls++; await new Promise((r) => setTimeout(r, 20)); return path === '/api/health' ? health('admin') : { status: 200, body: {} }; };
  const fleet = new Fleet({ ownNpub: async () => ME, meshAddress: async () => 'fd00::1', fetchJson, file: file(), intervalMs: 60_000 });
  await fleet.start();
  await fleet.save({ nodes: [{ npub: A }], managers: [] });
  await fleet.refresh();
  const before = calls;
  const node = { npub: A, port: 8321 };
  const [x, y] = await Promise.all([fleet.pollNode(node, false), fleet.pollNode(node, false)]);
  assert.equal(x, y);
  assert.equal(calls - before, 3, 'health, status and access once');
  fleet.close();
});

test('deriveNodeStatus: the security summary, an older fips-ui, carried while offline', () => {
  const sum = { summary: { score: 72, grade: 'C', scannedAt: 5000, counts: { critical: 0, high: 2, medium: 1, low: 0, info: 3 } }, available: true };
  const s = deriveNodeStatus(node, undefined, { health: health('admin'), security: { status: 200, body: sum } }, [ME], 1);
  assert.deepEqual(s.security, { available: true, score: 72, grade: 'C', scannedAt: 5000, critical: 0, high: 2 });
  assert.deepEqual(deriveNodeStatus(node, undefined, { health: health('admin'), security: { status: 200, body: { summary: null, available: false } } }, [ME], 1).security, { available: false });
  assert.equal(deriveNodeStatus(node, s, { health: health('admin'), security: { status: 404, body: { error: 'unknown' } } }, [ME], 2).security, undefined);
  // Between slow polls (no security read) and while offline, the last answer stays.
  assert.deepEqual(deriveNodeStatus(node, s, { health: health('admin') }, [ME], 3).security, s.security);
  assert.deepEqual(deriveNodeStatus(node, s, { health: new FleetError('offline', 'offline') }, [ME], 4).security, s.security);
});
