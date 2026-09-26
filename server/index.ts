// FIPS UI API server. Zero dependencies; runs directly under Node 22.18+ / 23.6+ / 24+ (unflagged TypeScript type stripping).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { query, ControlError, READ_ONLY_COMMANDS, GATEWAY_COMMANDS, SOCKET_PATH, GATEWAY_SOCKET_PATH } from './control.ts';
import { journal, recentLogs, type LogLine } from './journal.ts';
import { unitStates, serviceAction, readHosts, hostInfo, UNITS, type UnitName, type ServiceAction } from './system.ts';
import { createUpgradeHandler } from './upgrade.ts';
import { readJsonBody, BodyError, sendJson } from './http.ts';
import { createAdminHandler, NPUB_RE, type FirewallRule } from './admin.ts';
import { MeshAccess, LOCAL, AccessError, isMeshSource, expand6, type Principal } from './access.ts';

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) { console.warn(`${name}=${JSON.stringify(raw)} is not a number; using ${def}`); return def; }
  return Math.min(max, Math.max(min, Math.floor(n)));
}
const HOST = process.env.FIPS_UI_HOST ?? '127.0.0.1';
const PORT = envInt('FIPS_UI_PORT', 8321, 1, 65535);
const TOKEN = process.env.FIPS_UI_TOKEN || null;
const POLL_MS = envInt('FIPS_UI_POLL_MS', 2000, 500, 60_000);
const ALLOW_SERVICE_CONTROL = process.env.FIPS_UI_ALLOW_SERVICE_CONTROL === '1';
const READ_ONLY = process.env.FIPS_UI_READ_ONLY === '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Hosts a browser may address this API as. Requests whose Host (or Origin, when present) is not in this set
// are refused: that is what stops DNS-rebinding reads and cross-site writes against a loopback-only UI.
const WILDCARD_BIND = ['0.0.0.0', '::', '', '*'].includes(HOST);
const ALLOWED_HOSTS = new Set<string>(['localhost', '127.0.0.1', '::1', ...(WILDCARD_BIND ? [] : [HOST.toLowerCase()]), ...(process.env.FIPS_UI_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const HOST_CHECK = !WILDCARD_BIND || ALLOWED_HOSTS.size > 3; // a wildcard bind without an allow-list cannot know its names
const STATIC_DIR = process.env.FIPS_UI_STATIC ?? path.join(ROOT, 'web', 'dist');
const UI_VERSION: string = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; } })();

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
type Req = http.IncomingMessage;
type Res = http.ServerResponse;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const json = (res: Res, status: number, body: unknown, close = false) => sendJson(res, status, body, close);


function tokenOk(req: Req, url: URL): boolean {
  if (!TOKEN) return true;
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  if (!presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hostname of a Host header value or URL, lowercased, without port or IPv6 brackets. */
function hostnameOf(value: string | undefined, isUrl = false): string | null {
  if (!value) return null;
  try {
    const h = isUrl ? new URL(value).hostname : new URL(`http://${value}`).hostname;
    return h.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch { return null; }
}

/**
 * Browser-origin checks for the API. Host must be one of ours (DNS rebinding); a POST must carry a
 * same-site Origin when the browser sends one, must not be flagged cross-site by Sec-Fetch-Site, and must
 * be JSON, which HTML forms cannot produce and cross-origin fetches cannot send without a CORS preflight.
 */
function browserChecks(req: Req, method: string, via: 'local' | 'mesh'): string | null {
  // On the mesh listener the names are this node's fips0 address and .fips names; locally the configured set.
  const hostOk = (h: string | null) => (via === 'mesh' ? mesh.hostAllowed(h) : !!h && ALLOWED_HOSTS.has(h));
  if (via === 'mesh' || HOST_CHECK) {
    const host = hostnameOf(req.headers.host);
    if (!hostOk(host)) return `host '${req.headers.host ?? ''}' is not allowed${via === 'local' ? ' (set FIPS_UI_ALLOWED_HOSTS)' : ''}`;
  }
  if (method === 'GET' || method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    if (via === 'mesh') {
      // Any .fips name is a valid Host, so Origin must be exactly this request's own origin (same host and port):
      // a page served by another mesh node cannot post here.
      let same = false;
      try { same = new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase(); } catch { /* invalid origin */ }
      if (!same) return `cross-origin request from ${origin} refused`;
    } else {
      const o = hostnameOf(origin, true);
      if (!o || (HOST_CHECK ? !hostOk(o) : o !== hostnameOf(req.headers.host))) return `cross-origin request from ${origin} refused`;
    }
  } else if (origin === 'null') return 'cross-origin request refused';
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site === 'cross-site') return 'cross-site request refused';
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return 'mutating requests must be sent with content-type: application/json';
  return null;
}

function errToResponse(res: Res, e: unknown) {
  if (e instanceof BodyError) return json(res, e.status, { error: e.message }, e.status === 413);
  if (e instanceof HttpError) return json(res, e.status, { error: e.message });
  if (e instanceof ControlError) return json(res, e.kind === 'transport' ? 503 : 400, { error: e.message, kind: e.kind });
  console.error(e);
  json(res, 500, { error: (e as Error).message ?? 'internal error' });
}


/** Resolve a peer identifier (npub, hosts-file name, or live display name) to an npub. */
async function resolvePeer(id: string): Promise<{ npub: string; display_name?: string }> {
  const s = id.trim();
  if (NPUB_RE.test(s)) return { npub: s };
  const lower = s.toLowerCase();
  const hosts = await readHosts();
  const h = hosts.entries.find((e) => e.hostname.toLowerCase() === lower);
  if (h) return { npub: h.npub, display_name: h.hostname };
  const [peers, statPeers, idc] = await Promise.allSettled([
    query<{ peers: { npub: string; display_name?: string }[] }>('show_peers'),
    query<{ peers: { npub: string; display_name?: string }[] }>('show_stats_peers'),
    query<{ entries: { npub: string; display_name?: string }[] }>('show_identity_cache'),
  ]);
  const pools = [
    peers.status === 'fulfilled' ? peers.value.peers : [],
    statPeers.status === 'fulfilled' ? statPeers.value.peers : [],
    idc.status === 'fulfilled' ? idc.value.entries : [],
  ];
  for (const pool of pools) {
    const p = pool.find((x) => x.display_name?.toLowerCase() === lower);
    if (p) return { npub: p.npub, display_name: p.display_name };
  }
  throw new HttpError(404, `unknown peer '${id}': not an npub, not in /etc/fips/hosts, not a known peer name`);
}

// ---------------------------------------------------------------------------------------------
// Shared poller + SSE fan-out
// ---------------------------------------------------------------------------------------------
interface Snapshot {
  ts: number;
  status?: unknown; peers?: unknown; links?: unknown; transports?: unknown; tree?: unknown;
  sessions?: unknown; connections?: unknown; listening?: unknown; units?: unknown; gateway?: unknown;
  errors: Record<string, string>;
}

const sseClients = new Set<Res>();
let lastSnapshot: Snapshot | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let tick = 0;
let polling = false;

async function settle<T>(p: Promise<T>, key: string, errors: Record<string, string>): Promise<T | undefined> {
  try { return await p; } catch (e) { errors[key] = (e as Error).message; return undefined; }
}

async function pollOnce(): Promise<Snapshot> {
  if (polling && lastSnapshot) return lastSnapshot;
  polling = true;
  const errors: Record<string, string> = {};
  const slow = tick % 5 === 0 || !lastSnapshot; // heavier queries every 5th tick
  tick++;
  try {
    const [status, peers, links, transports, tree, sessions, connections, listening, units, gateway] = await Promise.all([
      settle(query('show_status'), 'status', errors),
      settle(query('show_peers'), 'peers', errors),
      settle(query('show_links'), 'links', errors),
      settle(query('show_transports'), 'transports', errors),
      settle(query('show_tree'), 'tree', errors),
      settle(query('show_sessions'), 'sessions', errors),
      settle(query('show_connections'), 'connections', errors),
      slow ? settle(query('show_listening_sockets'), 'listening', errors) : Promise.resolve(lastSnapshot?.listening),
      slow ? settle(unitStates(), 'units', errors) : Promise.resolve(lastSnapshot?.units),
      slow && fs.existsSync(GATEWAY_SOCKET_PATH)
        ? settle(Promise.all([query('show_gateway', undefined, { socketPath: GATEWAY_SOCKET_PATH }), query('show_mappings', undefined, { socketPath: GATEWAY_SOCKET_PATH })]).then(([g, m]) => ({ ...(g as object), ...(m as object) })), 'gateway', errors)
        : Promise.resolve(slow ? null : lastSnapshot?.gateway),
    ]);
    lastSnapshot = { ts: Date.now(), status, peers, links, transports, tree, sessions, connections, listening, units, gateway, errors };
    return lastSnapshot;
  } finally { polling = false; }
}

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function startPolling() {
  if (pollTimer) return;
  const run = async () => { const snap = await pollOnce(); broadcast('snapshot', snap); };
  void run();
  pollTimer = setInterval(run, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

let unsubscribeJournal: (() => void) | null = null;
function handleSse(req: Req, res: Res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`retry: 3000\n\n`);
  sseClients.add(res);
  if (lastSnapshot) res.write(`event: snapshot\ndata: ${JSON.stringify(lastSnapshot)}\n\n`);
  startPolling();
  if (!unsubscribeJournal) unsubscribeJournal = journal.subscribe((line: LogLine) => broadcast('log', line));
  const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
    if (sseClients.size === 0) { stopPolling(); unsubscribeJournal?.(); unsubscribeJournal = null; }
  });
}

// ---------------------------------------------------------------------------------------------
// Static files (built frontend)
// ---------------------------------------------------------------------------------------------
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(url: URL, res: Res) {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>FIPS UI</title><body style="font:16px system-ui;padding:2rem;background:#0b1220;color:#e5eefc"><h1>FIPS UI API is running</h1><p>The frontend has not been built yet. Run <code>npm run build</code> (production) or <code>npm run dev</code> (development, then open the Vite URL).</p><p>API: <a style="color:#7dd3fc" href="/api/snapshot">/api/snapshot</a></p>`);
  }
  let rel: string;
  try { rel = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad path' }); }
  if (rel.includes('..') || rel.includes('\0')) return json(res, 400, { error: 'bad path' });
  let file = path.join(STATIC_DIR, rel);
  const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const isAsset = rel.startsWith('/assets/');
  if (!isFile(file)) {
    // Hashed assets are never satisfied by the SPA fallback: a stale script URL must 404, not receive HTML.
    if (isAsset) return json(res, 404, { error: 'asset not found (stale build?)' });
    file = path.join(STATIC_DIR, 'index.html');
  }
  if (!isFile(file)) return json(res, 404, { error: 'frontend not built: web/dist/index.html is missing' });
  const ext = path.extname(file);
  const immutable = isAsset;
  const stream = fs.createReadStream(file);
  stream.on('open', () => res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }));
  // A file that vanishes or is unreadable (mid-build, wrong permissions) must fail this request, not the process.
  stream.on('error', (e: NodeJS.ErrnoException) => { if (!res.headersSent) json(res, e.code === 'ENOENT' ? 404 : 500, { error: `cannot read ${path.basename(file)}: ${e.code ?? e.message}` }); else res.destroy(); });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------
const startedAt = Date.now();
let upgradeStarting = 0;
/** Who is making each request: the loopback listener is the local operator; the mesh listener an allowed npub. */
const principals = new WeakMap<Req, Principal>();
const principalOf = (req: Req): Principal => principals.get(req) ?? LOCAL;
const canChange = (req: Req) => !READ_ONLY && principalOf(req).role === 'admin';
// Node upgrade API (/api/upgrade/*). Reads are open like every other API route; mutations are
// refused in read-only mode. Token auth (when configured) is enforced by route() before this runs.
const upgrade = createUpgradeHandler({ authorize: (req) => canChange(req), controlSocket: SOCKET_PATH });
// Node management (fips.yaml, firewall, units). Refused while an upgrade job holds the daemon.
const admin = createAdminHandler({
  authorize: (req) => canChange(req),
  busy: () => { const j = upgrade.manager.job; return upgradeStarting > 0 || (j && (j.state === 'running' || j.state === 'queued')) ? 'an upgrade job is running; wait for it to finish' : null; },
});
/** Service control is available through the helper (v4+), or directly with the legacy opt-in. */
async function serviceControlMode(): Promise<'helper' | 'direct' | null> {
  if (READ_ONLY) return null;
  if ((await admin.helperInfo()).managementCapable) return 'helper';
  return ALLOW_SERVICE_CONTROL ? 'direct' : null;
}

async function route(req: Req, res: Res) {
  const via: 'local' | 'mesh' = principalOf(req).kind;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  if (!p.startsWith('/api/')) return serveStatic(url, res);

  const refused = browserChecks(req, method, via);
  if (refused) return json(res, 403, { error: refused });

  // Auth: locally, a configured token is required for every API call. Over the mesh the npub is the credential.
  if (via === 'local' && p !== '/api/health' && !tokenOk(req, url)) return json(res, 401, { error: 'unauthorized', auth: 'token' });

  if (p === '/api/health') {
    let daemon: unknown = null; let error: string | undefined;
    try { daemon = await query('show_status', undefined, { timeoutMs: 2500 }); } catch (e) { error = (e as Error).message; }
    const pr = principalOf(req);
    return json(res, 200, { ok: !error, auth: via === 'mesh' ? 'npub' : TOKEN ? 'token' : 'none', principal: pr, readOnly: READ_ONLY || pr.role !== 'admin', upgrade: true, serviceControl: pr.role === 'admin' && (await serviceControlMode()) !== null, nodeManagement: pr.role === 'admin' && (await admin.helperInfo()).managementCapable && !READ_ONLY, socket: SOCKET_PATH, gatewaySocket: fs.existsSync(GATEWAY_SOCKET_PATH) ? GATEWAY_SOCKET_PATH : null, pollMs: POLL_MS, uiVersion: UI_VERSION, uiUptimeSecs: Math.floor((Date.now() - startedAt) / 1000), error, version: (daemon as { version?: string } | null)?.version });
  }

  if (p === '/api/events') return handleSse(req, res);
  // Upgrade state (paths, logs, and a refresh that spends the GitHub rate limit) is for admins only.
  if (p.startsWith('/api/upgrade')) {
    if (principalOf(req).role !== 'admin') return json(res, 403, { error: 'admin role required' });
    if (method === 'POST' && admin.changePending()) return json(res, 409, { error: 'a node-management change is in progress; wait for it to finish' });
    // Requests that start an upgrade or rollback are counted before any await, so a node-management change
    // cannot start while one of them reads its body (the upgrade module takes its own slot after that).
    const starts = method === 'POST' && (p === '/api/upgrade/jobs' || p === '/api/upgrade/rollback');
    if (starts) upgradeStarting++;
    try { if (await upgrade(req, res)) return; } finally { if (starts) upgradeStarting--; }
  }
  // Node management and the access list are admin-only even to read: they reveal configuration and other npubs.
  if (p.startsWith('/api/admin/')) { if (principalOf(req).role !== 'admin') return json(res, 403, { error: 'admin role required' }); if (await admin(req, res)) return; }
  if (p === '/api/snapshot') return json(res, 200, await pollOnce());

  // Generic read-only proxy: /api/q/show_peers, /api/q/show_stats_history?metric=bytes_in&window=1h
  if (p.startsWith('/api/q/')) {
    if (method !== 'GET') throw new HttpError(405, 'GET only');
    const cmd = p.slice('/api/q/'.length);
    const params: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams) if (k !== 'token') params[k] = v;
    if (typeof params.peer === 'string' && params.peer) params.peer = (await resolvePeer(params.peer)).npub;
    if (READ_ONLY_COMMANDS.has(cmd)) return json(res, 200, await query(cmd, params));
    if (GATEWAY_COMMANDS.has(cmd)) return json(res, 200, await query(cmd, params, { socketPath: GATEWAY_SOCKET_PATH }));
    throw new HttpError(404, `unknown or non-read-only command '${cmd}'`);
  }

  if (p === '/api/access' && method === 'GET') {
    const you = principalOf(req);
    return json(res, 200, you.role === 'admin' ? { config: mesh.config, status: mesh.status(), file: mesh.file, you, firewallManaged: (await admin.helperInfo()).managementCapable } : { you });
  }
  if (p === '/api/hosts') return json(res, 200, await readHosts());
  if (p === '/api/system') return json(res, 200, { host: await hostInfo(), units: await unitStates() });
  if (p === '/api/logs') {
    const requested = Number(url.searchParams.get('lines') ?? 300);
    const lines = Number.isFinite(requested) ? Math.min(5000, Math.max(1, Math.floor(requested))) : 300;
    return json(res, 200, { lines: await recentLogs(lines, url.searchParams.get('since') ?? undefined) });
  }
  if (p === '/api/resolve') {
    const id = url.searchParams.get('id') ?? '';
    return json(res, 200, await resolvePeer(id));
  }

  // ---- mutating -----------------------------------------------------------------------------
  if (method !== 'POST') throw new HttpError(404, 'not found');
  if (READ_ONLY) throw new HttpError(403, 'this UI instance is read-only (FIPS_UI_READ_ONLY=1)');
  if (principalOf(req).role !== 'admin') throw new HttpError(403, 'your npub has viewer access; changes need admin');
  const body = await readJsonBody(req);

  if (p === '/api/access') {
    try { await mesh.save(body); } catch (e) { throw new HttpError(e instanceof AccessError ? 400 : 500, (e as Error).message); }
    return json(res, 200, { config: mesh.config, status: mesh.status(), firewall: await syncMeshFirewall() });
  }

  if (p === '/api/connect') {
    const { peer, address, transport } = body as { peer?: string; address?: string; transport?: string };
    if (!peer || !address || !transport) throw new HttpError(400, 'peer, address and transport are required');
    if (!['udp', 'tcp', 'tor', 'nym', 'ethernet'].includes(transport)) throw new HttpError(400, 'transport must be udp, tcp, tor, nym or ethernet');
    const { npub } = await resolvePeer(peer);
    const data = await query('connect', { npub, address, transport }, { timeoutMs: 15000 });
    return json(res, 200, { npub, result: data });
  }
  if (p === '/api/disconnect') {
    const { peer } = body as { peer?: string };
    if (!peer) throw new HttpError(400, 'peer is required');
    const { npub } = await resolvePeer(peer);
    return json(res, 200, { npub, result: await query('disconnect', { npub }, { timeoutMs: 15000 }) });
  }
  if (p === '/api/probe/start') {
    const { peer } = body as { peer?: string };
    if (!peer) throw new HttpError(400, 'peer is required');
    const { npub } = await resolvePeer(peer);
    return json(res, 200, await query('probe_start', { npub }));
  }
  const probePoll = /^\/api\/probe\/(\d+)$/.exec(p);
  if (probePoll) return json(res, 200, await query('probe_poll', { probe_id: Number(probePoll[1]) }));
  const probeCancel = /^\/api\/probe\/(\d+)\/cancel$/.exec(p);
  if (probeCancel) return json(res, 200, await query('probe_cancel', { probe_id: Number(probeCancel[1]) }));

  const svc = /^\/api\/service\/([a-z-]+\.service)\/(start|stop|restart|reload)$/.exec(p);
  if (svc) {
    const mode = await serviceControlMode();
    if (!mode) throw new HttpError(403, 'service control needs the privileged helper (v4+, installed by deploy/setup-local.sh) or FIPS_UI_ALLOW_SERVICE_CONTROL=1');
    if (!(UNITS as readonly string[]).includes(svc[1])) throw new HttpError(400, 'unknown unit');
    if (mode === 'helper') await admin.serviceAction(svc[1], svc[2]);
    else { const r = await serviceAction(svc[1] as UnitName, svc[2] as ServiceAction); if (!r.ok) throw new HttpError(500, r.error); }
    return json(res, 200, { ok: true, units: await unitStates() });
  }

  throw new HttpError(404, 'not found');
}

/**
 * Every request, on either listener, is attributed by its source address: an fd00::/8 source can only have
 * come through the mesh and is admitted only as an allowed npub; anything else is the local operator
 * (loopback, or whatever FIPS_UI_HOST exposes, where FIPS_UI_TOKEN applies).
 */
function handle(req: Req, res: Res): void {
  const remote = req.socket.remoteAddress;
  if (isMeshSource(remote)) {
    const pr = mesh.principalFor(remote);
    if (!pr) { void denyMesh(req, res); return; }
    mesh.track(req.socket, pr);
    principals.set(req, pr);
  }
  route(req, res).catch((e) => errToResponse(res, e));
}
const server = http.createServer(handle);

// ---------------------------------------------------------------------------------------------
// Mesh access
// ---------------------------------------------------------------------------------------------
const MESH_TAG = 'mesh-access';

// Identity cache for the denial page, refreshed at most every 30 s so unlisted callers cannot load the daemon.
let identityCache: { at: number; byAddr: Map<string, string> } | null = null;
async function npubForAddress(addr: string): Promise<string | undefined> {
  if (!identityCache || Date.now() - identityCache.at > 30_000) {
    identityCache = { at: Date.now(), byAddr: identityCache?.byAddr ?? new Map() };
    try {
      const idc = await query<{ entries: { ipv6_addr: string; npub: string }[] }>('show_identity_cache', undefined, { timeoutMs: 2000 });
      identityCache.byAddr = new Map(idc.entries.flatMap((e) => { const k = expand6(e.ipv6_addr); return k ? [[k, e.npub] as [string, string]] : []; }));
    } catch { /* best effort */ }
  }
  const k = expand6(addr);
  return k ? identityCache.byAddr.get(k) : undefined;
}

async function denyMesh(req: Req, res: Res): Promise<void> {
  const addr = req.socket.remoteAddress ?? 'unknown';
  const npub = await npubForAddress(addr);
  const who = npub ? `${npub} (${addr})` : addr;
  if ((req.url ?? '').startsWith('/api/')) return json(res, 403, { error: 'this node does not allow your npub', you: { address: addr, npub } }, true);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Access denied</title><body style="font:16px system-ui;padding:2rem;max-width:40rem;margin:auto;background:#0a1220;color:#e6edf7"><h1 style="font-size:1.4rem">This FIPS node's dashboard is private</h1><p>Your connection came from <code style="word-break:break-all">${esc(who)}</code>, which is not on its allow-list.</p><p style="color:#a3b3ca">Ask the operator to add your npub under <b>Access → Web UI over the mesh</b>.</p>`;
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  res.end(html);
}

const mesh = new MeshAccess(handle);

/** Keep the UI's own firewall rule in step with the allow-list: its port, open only to the allowed npubs. */
async function syncMeshFirewall(): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!(await admin.helperInfo()).managementCapable) return { ok: false, skipped: 'helper v3 not installed; open the port in the firewall yourself' };
  const cfg = mesh.config;
  const rule: FirewallRule | null = cfg.enabled && cfg.allowed.length
    ? { proto: 'tcp', ports: String(cfg.port), sources: cfg.allowed.map((a) => ({ kind: 'npub' as const, npub: a.npub, label: a.label })), comment: 'fips-ui web access over the mesh', tag: MESH_TAG }
    : null;
  try {
    const r = await admin.updateManagedRules((rules) => [...rules.filter((x) => x.tag !== MESH_TAG), ...(rule ? [rule] : [])]);
    return r.ok ? { ok: true } : { ok: false, error: String(r.error ?? 'rejected') };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
void mesh.start();

server.listen(PORT, HOST, () => {
  console.log(`fips-ui ${UI_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`  control socket : ${SOCKET_PATH}`);
  console.log(`  static dir     : ${STATIC_DIR}${fs.existsSync(STATIC_DIR) ? '' : ' (not built yet)'}`);
  console.log(`  auth           : ${TOKEN ? 'token' : 'none (bind to loopback or set FIPS_UI_TOKEN)'}`);
  void serviceControlMode().then((m) => console.log(`  service control: ${m ? `enabled (${m})` : 'disabled'}${READ_ONLY ? ' (read-only mode)' : ''}`));
  console.log(`  allowed hosts  : ${HOST_CHECK ? [...ALLOWED_HOSTS].join(', ') : 'any (wildcard bind without FIPS_UI_ALLOWED_HOSTS: DNS-rebinding protection is off)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); mesh.close(); process.exit(0); });
