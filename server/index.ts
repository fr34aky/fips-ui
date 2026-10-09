// FIPS UI API server. Zero dependencies; runs directly under Node 22.18+ / 23.6+ / 24+ (unflagged TypeScript type stripping).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { query, ControlError, READ_ONLY_COMMANDS, GATEWAY_COMMANDS, SOCKET_PATH, GATEWAY_SOCKET_PATH, endpointExists } from './control.ts';
import { detect as detectPubdom, fullState as pubdomFullState, latestRelease as pubdomLatestRelease, isSide as isPubdomSide, READ_COMMANDS as PUBDOM_READ, CONFIG_FILE as PUBDOM_CONFIG_FILE, PubdomStateError, pubdomQuery, readEditable, readZoneFile, hostMatches, servedHostnames, watchServedHostnames } from './pubdom.ts';
import { journal, recentLogs, LOG_SOURCE, type LogLine } from './journal.ts';
import { LOGS, setDaemonProbe } from './platform.ts';
import { unitStates, serviceAction, readHosts, hostInfo, unitName, PLATFORM, SERVICES, type ServiceId, type ServiceAction } from './system.ts';
import { createUpgradeHandler } from './upgrade.ts';
import { readJsonBody, BodyError, sendJson } from './http.ts';
import { createAdminHandler, NPUB_RE, GUARD_HELPER_VERSION, HOSTS_HELPER_VERSION, meshAddress, type FirewallRule } from './admin.ts';
import { HOSTS_PATH, HostsError, renderHosts, validateEntries, writeHostsDirect, type HostsFile } from './hosts.ts';
import { HostsSync, SyncError } from './hosts-sync.ts';
import { HostsFollowers, isSyncRequest, parseSubtree, syncRole } from './hosts-followers.ts';
import { SelfUpdate } from './self-update.ts';
import { uiVersion } from './version.ts';
import { createConfigMerge, readProposal, clearProposal } from './config-merge.ts';
import { MeshAccess, LOCAL, AccessError, type Principal, type AccessConfig } from './access.ts';
import { expand6, isMeshAddress } from './net6.ts';

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
const UI_VERSION = uiVersion(ROOT);

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
  // On the mesh listener the names are this node's fips0 address, .fips names and the public domains it serves
  // itself (MeshAccess.hostAllowed); locally the configured set.
  const hostOk = (h: string | null) => (via === 'mesh' ? mesh.hostAllowed(h) : !!h && ALLOWED_HOSTS.has(h));
  if (via === 'mesh' || HOST_CHECK) {
    const host = hostnameOf(req.headers.host);
    if (!hostOk(host)) return `host '${req.headers.host ?? ''}' is not allowed${via === 'local' ? ' (set FIPS_UI_ALLOWED_HOSTS)' : ''}`;
  }
  if (method === 'GET' || method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    if (via === 'mesh') {
      // Several names are valid Hosts (address, <npub>.fips, hosts-file aliases), so Origin must be exactly this
      // request's own origin (same host and port): a page served by another mesh node cannot post here.
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
      slow && endpointExists(GATEWAY_SOCKET_PATH)
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
/** Sentinel for a request no listener attributed: a viewer that route() refuses outright. */
const NOBODY: Principal = { kind: 'mesh', role: 'viewer', npub: '', address: '' };
/** Who is making each request: the loopback listener is the local operator; the mesh listener an allowed npub. */
const principals = new WeakMap<Req, Principal>();
const mainRequests = new WeakSet<Req>();
/** The recorded principal, or the local operator for requests the main listener accepted; otherwise nobody. */
const principalOf = (req: Req): Principal => principals.get(req) ?? (mainRequests.has(req) ? LOCAL : NOBODY);
const canChange = (req: Req) => !READ_ONLY && principalOf(req).role === 'admin';
// Node upgrade API (/api/upgrade/*). Reads are open like every other API route; mutations are
// refused in read-only mode. Token auth (when configured) is enforced by route() before this runs.
setDaemonProbe(async () => (await query<{ pid?: number }>('show_status', undefined, { timeoutMs: 2000 })).pid);
const mergeConfig = createConfigMerge({ show: () => admin.configShow(), apply: (yaml, base) => admin.configApply(yaml, base), logs: (n) => recentLogs(n) });
const upgrade = createUpgradeHandler({
  authorize: (req) => canChange(req), controlSocket: SOCKET_PATH,
  // After an upgrade, fips.yaml follows the new template (server/config-merge.ts); `admin` is created below. Only
  // where the helper can apply configuration (Linux with systemd); elsewhere the step is skipped.
  // Only where the helper can apply the configuration; checked at the time of each upgrade.
  configMerge: async (a) => (await admin.helperInfo()).features.config ? mergeConfig(a) : { status: 'skipped', detail: 'not available on this system (the helper cannot apply the configuration here)' },
  configRestore: async (id: string) => (await admin.helperInfo()).features.config ? admin.configRestore(id).catch((e: Error) => ({ ok: false, error: e.message })) : { ok: false, error: 'not available on this system' },
  // After a fresh fips install: start again to pick up the fips group (once the install job has finished).
  restartUi: () => { if (!selfUpdate.canRestart) return false; restartWhenIdle('fips was installed; exiting so the service restarts fips-ui in the fips group'); return true; },
});
// Node management (fips.yaml, firewall, units). Refused while an upgrade job holds the daemon.
const admin = createAdminHandler({
  authorize: (req) => canChange(req),
  busy: () => { const j = upgrade.manager.job; return upgradeStarting > 0 || (j && (j.state === 'running' || j.state === 'queued')) ? 'an upgrade job is running; wait for it to finish' : null; },
});
/**
 * How this instance can write the hosts file: through the helper (Linux with systemd, the standard path), directly
 * (the process may write the file, e.g. running as root or an elevated Windows service), or not at all.
 */
async function hostsWriteMode(): Promise<{ mode: 'helper' | 'direct' | null; hint: string }> {
  if (READ_ONLY) return { mode: null, hint: 'this UI instance is read-only (FIPS_UI_READ_ONLY=1)' };
  {
    const h = await admin.helperInfo();
    if (h.available && (h.version ?? 0) >= HOSTS_HELPER_VERSION && h.features.hosts && h.hostsPath === HOSTS_PATH) return { mode: 'helper', hint: 'saved through the privileged helper' };
  }
  const target = fs.existsSync(HOSTS_PATH) ? HOSTS_PATH : path.dirname(HOSTS_PATH);
  try { await fs.promises.access(target, fs.constants.W_OK); return { mode: 'direct', hint: `written directly to ${HOSTS_PATH}` }; }
  catch {
    return { mode: null, hint: PLATFORM.os === 'windows'
      ? `the UI cannot write ${HOSTS_PATH}: run it elevated or give its user write access to that file`
      : `editing ${HOSTS_PATH} needs the privileged helper (v8 outside Linux with systemd): sudo ./deploy/setup-local.sh with systemd, sudo ./deploy/install-upgrade-helper.sh elsewhere; or give the UI's user write access to the file` };
  }
}

/** Write the whole hosts file through the helper or directly; `base` is the hash of the file it was built from. */
async function writeHostsFile(content: string, base: string): Promise<void> {
  const mode = await hostsWriteMode();
  if (!mode.mode) throw new HostsError(mode.hint);
  if (mode.mode === 'helper') {
    const r = await admin.hostsApply(content, base);
    if (!r.ok) throw new Error(r.error ?? 'the helper refused the change');
    return;
  }
  // Direct: the same stale-file check the helper makes.
  const now = await readHosts();
  if (now.base !== base) throw new Error(`${HOSTS_PATH} changed since it was read`);
  await writeHostsDirect(content);
}

/** What /api/hosts shows: the effective names, the node's own entries and the synced block. */
function hostsView(h: HostsFile) {
  return { path: h.path, entries: h.entries, local: h.local, synced: h.synced, base: h.base, error: h.error };
}

/**
 * Self-test mode (FIPS_UI_SELFTEST=1): the self-update starts a freshly built version this way before restarting
 * the service. It loads every module, listens on a spare loopback port, prints "fips-ui selftest ok" and exits;
 * nothing with side effects (mesh listener and guard, hosts sync, release checks, pollers) is started.
 */
const SELFTEST = process.env.FIPS_UI_SELFTEST === '1';
const selfUpdate = new SelfUpdate(ROOT, UI_VERSION);
// Look for a new fips-ui release shortly after start and every 6 hours.
if (!SELFTEST) setTimeout(() => { void selfUpdate.check(); setInterval(() => void selfUpdate.check(), 6 * 60 * 60_000).unref(); }, 10_000).unref();
/** Why fips-ui must not restart now (a node upgrade or node-management change would be killed with it). */
const restartBlocker = (): string | null => {
  const j = upgrade.manager.job;
  if (upgradeStarting > 0 || (j && (j.state === 'running' || j.state === 'queued'))) return 'a fips upgrade job is running';
  if (admin.changePending()) return 'a node-management change is in progress';
  return null;
};
/** Exit with 75 so the service manager starts fips-ui again, once nothing privileged is running. */
function restartWhenIdle(message: string): void {
  if (restartBlocker()) { setTimeout(() => restartWhenIdle(message), 2000); return; }
  console.log(message); server.close(); mesh.close(); hostsSync.close(); process.exit(75);
}

const hostsFollowers = new HostsFollowers();
const hostsSync = new HostsSync({
  version: UI_VERSION,
  ownNpub: async () => (await query<{ npub?: string }>('show_status', undefined, { timeoutMs: 3000 })).npub,
  meshAddress,
  write: writeHostsFile,
  label: async (npub) => (await readHosts()).local.find((e) => e.npub === npub)?.hostname,
  subtree: () => hostsFollowers.subtreeHeader(),
});
if (!SELFTEST) void hostsSync.start();

/** Service control is available through the helper (v4+), or directly with the legacy opt-in. */
async function serviceControlMode(): Promise<'helper' | 'direct' | null> {
  if (READ_ONLY) return null;
  // The helper drives systemd; other service managers use the direct path.
  if ((await admin.helperInfo()).features.services) return 'helper';
  return ALLOW_SERVICE_CONTROL ? 'direct' : null;
}

/** The query string as command params: everything but the token; the named keys as numbers. */
function queryParams(url: URL, numeric: string[] = []): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) if (k !== 'token') params[k] = numeric.includes(k) ? Number(v) : v;
  return params;
}

async function route(req: Req, res: Res) {
  if (principalOf(req) === NOBODY) return json(res, 403, { error: 'no identity for this request' }, true);
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
    // Host details only for callers that passed authentication (health itself is open locally).
    const authed = via === 'mesh' || tokenOk(req, url);
    return json(res, 200, { ok: !error, auth: via === 'mesh' ? 'npub' : TOKEN ? 'token' : 'none', principal: pr, readOnly: READ_ONLY || pr.role !== 'admin', upgrade: true, serviceControl: pr.role === 'admin' && (await serviceControlMode()) !== null, nodeManagement: pr.role === 'admin' && (await admin.helperInfo()).managementCapable && !READ_ONLY, socket: SOCKET_PATH, gatewaySocket: endpointExists(GATEWAY_SOCKET_PATH) ? GATEWAY_SOCKET_PATH : null, ...(authed ? { platform: PLATFORM, logSource: LOG_SOURCE, pubdom: detectPubdom() } : {}), pollMs: POLL_MS, uiVersion: UI_VERSION, uiUptimeSecs: Math.floor((Date.now() - startedAt) / 1000), error, version: (daemon as { version?: string } | null)?.version });
  }

  if (p === '/api/events') return handleSse(req, res);
  // Upgrade state (paths, logs, and a refresh that spends the GitHub rate limit) is for admins only.
  if (p.startsWith('/api/upgrade')) {
    if (principalOf(req).role !== 'admin') return json(res, 403, { error: 'admin role required' });
    if (method === 'POST' && admin.changePending()) return json(res, 409, { error: 'a node-management change is in progress; wait for it to finish' });
    // Requests that start an upgrade or rollback are counted before any await, so a node-management change
    // cannot start while one of them reads its body (the upgrade module takes its own slot after that).
    const starts = method === 'POST' && (p === '/api/upgrade/jobs' || p === '/api/upgrade/rollback' || p === '/api/upgrade/install-daemon');
    if (starts) upgradeStarting++;
    try { if (await upgrade(req, res)) return; } finally { if (starts) upgradeStarting--; }
  }
  // A fips.yaml merge an upgrade could not apply by itself, offered on the Configuration page.
  if (p === '/api/admin/config/proposal' || p === '/api/admin/config/proposal/dismiss') {
    if (!canChange(req)) return json(res, 403, { error: 'admin role required' });
    if (method === 'POST' && p.endsWith('/dismiss')) { await clearProposal(); return json(res, 200, { ok: true }); }
    if (method !== 'GET') return json(res, 405, { error: 'GET only' });
    const prop = await readProposal();
    if (!prop) return json(res, 200, { proposal: null });
    // A proposal made for a file that has changed since cannot be applied as it is.
    const cur = await admin.configShow().catch(() => null);
    return json(res, 200, { proposal: { ...prop, stale: !!cur && cur.base !== prop.base } });
  }
  // Node management and the access list are admin-only even to read: they reveal configuration and other npubs.
  if (p.startsWith('/api/admin/')) { if (principalOf(req).role !== 'admin') return json(res, 403, { error: 'admin role required' }); if (await admin(req, res)) return; }
  if (p === '/api/snapshot') return json(res, 200, await pollOnce());

  // Public domain names (server/pubdom.ts): /api/pubdom/state says what is installed and running right now;
  // /api/pubdom/<resolver|server>/<command> proxies the read-only commands, for every role.
  if (p === '/api/pubdom/state') { if (method !== 'GET') throw new HttpError(405, 'GET only'); return json(res, 200, await pubdomFullState()); }
  // The newest release on GitHub, for the install and update buttons (admins: it is a request to a third party).
  if (p === '/api/pubdom/releases') {
    if (method !== 'GET') throw new HttpError(405, 'GET only');
    if (principalOf(req).role !== 'admin') throw new HttpError(403, 'admin role required');
    return json(res, 200, await pubdomLatestRelease(url.searchParams.get('refresh') === '1'));
  }
  if (p.startsWith('/api/pubdom/')) {
    if (method !== 'GET') throw new HttpError(405, 'GET only');
    const [side, cmd, ...rest] = p.slice('/api/pubdom/'.length).split('/');
    if (!side || !cmd || rest.length || !isPubdomSide(side)) throw new HttpError(404, 'unknown public-domains endpoint');
    // The files the editors show: the side's configuration, or a zone file the zones listing named. Admins
    // only: unlike the socket's answers, a file is whatever the operator wrote in it.
    if (cmd === 'config-file' || cmd === 'zone-file') {
      if (principalOf(req).role !== 'admin') throw new HttpError(403, 'admin role required');
    }
    if (cmd === 'config-file') return json(res, 200, readEditable(PUBDOM_CONFIG_FILE[side]));
    if (cmd === 'zone-file' && side === 'server') {
      const file = url.searchParams.get('file') ?? '';
      if (!file.startsWith('/')) throw new HttpError(400, 'file (absolute path from the zones listing) required');
      try { return json(res, 200, await readZoneFile(file)); }
      catch (e) { if (e instanceof PubdomStateError) throw new HttpError(409, e.message); throw e; }
    }
    if (!PUBDOM_READ[side].has(cmd)) throw new HttpError(404, `'${cmd}' is not a read-only ${side} command`);
    return json(res, 200, await pubdomQuery(side, cmd, queryParams(url, ['n'])));
  }

  // Generic read-only proxy: /api/q/show_peers, /api/q/show_stats_history?metric=bytes_in&window=1h
  if (p.startsWith('/api/q/')) {
    if (method !== 'GET') throw new HttpError(405, 'GET only');
    const cmd = p.slice('/api/q/'.length);
    const params = queryParams(url);
    if (typeof params.peer === 'string' && params.peer) params.peer = (await resolvePeer(params.peer)).npub;
    if (READ_ONLY_COMMANDS.has(cmd)) return json(res, 200, await query(cmd, params));
    if (GATEWAY_COMMANDS.has(cmd)) return json(res, 200, await query(cmd, params, { socketPath: GATEWAY_SOCKET_PATH }));
    throw new HttpError(404, `unknown or non-read-only command '${cmd}'`);
  }

  if (p === '/api/access' && method === 'GET') {
    const you = principalOf(req);
    if (you.role !== 'admin') return json(res, 200, { you });
    const h = await admin.helperInfo();
    return json(res, 200, { config: mesh.config, status: mesh.status(), file: mesh.file, you, firewallManaged: h.features.firewall !== 'none', guardSupported: h.features.guard !== 'none', helperVersion: h.version, guardHelperVersion: GUARD_HELPER_VERSION });
  }
  if (p === '/api/hosts' && method !== 'POST') {
    const h = await readHosts();
    // A follower node syncing from this one (over the mesh, by its npub): remembered for the master's list.
    const pr = principalOf(req);
    const syncInfo = pr.kind === 'mesh' && method === 'GET' ? isSyncRequest(req) : null;
    // A sync is answered with this node's upstream chain, which lets followers detect loops.
    const own = syncInfo ? (lastSnapshot?.status as { npub?: string } | undefined)?.npub ?? await query<{ npub?: string }>('show_status', undefined, { timeoutMs: 3000 }).then((s) => s.npub, () => undefined) : undefined;
    // With the nodes it reports below itself (its subtree), for the tree on this page.
    if (pr.kind === 'mesh' && syncInfo && !h.error) void hostsFollowers.record(pr.npub, pr.address, h.entries.length, syncInfo, parseSubtree(req.headers['x-fips-ui-subtree'], pr.npub, own)).catch(() => {});
    const chain = own ? await hostsSync.chainFor(own) : undefined;
    // Admins also learn whether (and how) this instance can write the file.
    const write = canChange(req) ? await hostsWriteMode() : undefined;
    return json(res, 200, { ...hostsView(h), ...(chain ? { chain, chainComplete: hostsSync.chainComplete() } : {}), ...(write !== undefined ? { write } : {}) });
  }
  if (p === '/api/hosts/followers' && method === 'GET') {
    if (!canChange(req)) return json(res, 403, { error: 'admin role required' });
    return json(res, 200, { followers: await hostsFollowers.list() });
  }
  if (p === '/api/ui-update' && method === 'GET') {
    const admin_ = canChange(req);
    await selfUpdate.check(admin_ && url.searchParams.get('refresh') === '1');
    const base = { current: selfUpdate.current, latest: selfUpdate.latest, newer: selfUpdate.newer, checkedAt: selfUpdate.checkedAt, error: selfUpdate.checkError };
    if (!admin_) return json(res, 200, base);
    const h = await admin.helperInfo().catch(() => null);
    return json(res, 200, { ...base, job: selfUpdate.job, install: await selfUpdate.installMode(), canRestart: selfUpdate.canRestart, helper: { installed: h?.version ?? null, shipped: selfUpdate.repoHelperVersion() } });
  }
  if (p === '/api/hosts/sync' && method === 'GET') {
    if (!canChange(req)) return json(res, 403, { error: 'admin role required' });
    const role = syncRole(hostsSync.config.enabled, await hostsFollowers.activeCount());
    return json(res, 200, { config: hostsSync.config, status: hostsSync.status, file: hostsSync.file, own: lastSnapshot?.status && (lastSnapshot.status as { npub?: string }).npub, role });
  }
  if (p === '/api/system') return json(res, 200, { host: await hostInfo(), units: await unitStates() });
  if (p === '/api/logs') {
    const requested = Number(url.searchParams.get('lines') ?? 300);
    const lines = Number.isFinite(requested) ? Math.min(5000, Math.max(1, Math.floor(requested))) : 300;
    // A log file the UI's user cannot read (FreeBSD's is root-only) is reported, so the page can offer a fix.
    const file = LOGS?.file;
    let unreadable: string | undefined;
    if (file) { try { await fs.promises.access(file, fs.constants.R_OK); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = file; } }
    return json(res, 200, { lines: await recentLogs(lines, url.searchParams.get('since') ?? undefined), ...(unreadable ? { unreadable } : {}) });
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
    const want = body as Partial<AccessConfig>;
    // The mesh listener binds this node's fips0 address, which the main listener already holds on its port when it
    // is bound to every IPv6 address or to that address itself.
    if (want?.enabled === true && mainHoldsMeshPort(Number(want.port))) throw new HttpError(400, `port ${want.port} is already used by the main listener (FIPS_UI_HOST=${HOST}); choose another port for mesh access`);
    try { await mesh.save(body); } catch (e) { throw new HttpError(e instanceof AccessError ? 400 : 500, (e as Error).message); }
    // Syncs already in flight (or chained on them) were built from the previous list: wait for a few of them,
    // then run this save's own full sync. The dirty flag guarantees a full sync on the next tick regardless.
    for (let i = 0; meshSync.running && i < 3; i++) await meshSync.running.catch(() => {});
    meshSync.dirty = true;
    const firewall = meshSync.running
      ? { ok: false, skipped: 'another sync is still running; this change is applied within 15 seconds' }
      : await syncMesh().catch((e) => ({ ok: false, guard: (e as Error).message }));
    await mesh.reconcile();
    return json(res, 200, { config: mesh.config, status: mesh.status(), firewall });
  }

  if (p === '/api/hosts') {
    const { entries, base } = body as { entries?: unknown; base?: unknown };
    const cur = await readHosts();
    if (cur.error) throw new HttpError(500, `cannot read ${cur.path}: ${cur.error}`);
    // The editor changes the node's own entries; a synced block is kept as it is.
    let want: { hostname: string; npub: string }[];
    try { want = validateEntries(entries, cur.local); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (base !== cur.base) throw new HttpError(409, `${cur.path} changed since it was loaded; reload and make the change again`);
    const content = renderHosts(cur.raw, want);
    try { if (content !== cur.raw) await writeHostsFile(content, cur.base); }
    catch (e) { throw new HttpError(e instanceof HostsError ? 403 : /changed since|in progress/.test((e as Error).message) ? 409 : 500, (e as Error).message); }
    return json(res, 200, { ok: true, ...hostsView(await readHosts()) });
  }

  if (p === '/api/hosts/sync') {
    try {
      const b = body as { enabled?: unknown; master?: unknown; port?: unknown; intervalMin?: unknown };
      // The master may be given by npub or by a name this node knows.
      const master = b.enabled === true && typeof b.master === 'string' && b.master.trim() ? (await resolvePeer(b.master)).npub : b.master;
      const status = await hostsSync.save({ ...b, master });
      return json(res, 200, { config: hostsSync.config, status });
    } catch (e) { throw e instanceof HttpError ? e : new HttpError(e instanceof SyncError ? 400 : 500, (e as Error).message); }
  }
  if (p === '/api/ui-update/install') {
    const { tag } = body as { tag?: unknown };
    await selfUpdate.check();
    if (!selfUpdate.latest || !selfUpdate.newer || tag !== selfUpdate.latest.tag) throw new HttpError(400, `only the newest release (${selfUpdate.latest?.tag ?? 'unknown'}) can be installed, and only when it is newer than ${selfUpdate.current}`);
    if (selfUpdate.job?.state === 'running') throw new HttpError(409, 'an update is already running');
    const blocked = restartBlocker();
    if (blocked) throw new HttpError(409, `${blocked}; update fips-ui when it has finished`);
    // The restart waits for anything privileged that started meanwhile: exiting would kill it with the service.
    void selfUpdate.install(tag, () => restartWhenIdle(`fips-ui updated to ${tag}; exiting so the service manager restarts it`));
    return json(res, 202, { job: selfUpdate.job });
  }
  if (p === '/api/hosts/followers/forget') {
    const { npub } = body as { npub?: unknown };
    if (typeof npub !== 'string' || !NPUB_RE.test(npub)) throw new HttpError(400, 'npub required');
    return json(res, 200, { ok: await hostsFollowers.forget(npub) });
  }
  if (p === '/api/hosts/sync/run') {
    // Syncs now, or with sync turned off retries removing names a failed removal left behind.
    return json(res, 200, { config: hostsSync.config, status: await hostsSync.run() });
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

  // /api/service/<id>/<action>; <id> is fips, fips-dns, fips-firewall or fips-gateway (a trailing .service is accepted).
  const svc = /^\/api\/service\/([a-z-]+?)(?:\.service)?\/(start|stop|restart|reload)$/.exec(p);
  if (svc) {
    const mode = await serviceControlMode();
    if (!mode) throw new HttpError(403, 'service control needs the privileged helper (v4+, installed by deploy/setup-local.sh; Linux with systemd) or FIPS_UI_ALLOW_SERVICE_CONTROL=1');
    if (!(SERVICES as readonly string[]).includes(svc[1])) throw new HttpError(400, 'unknown service');
    const native = unitName(svc[1] as ServiceId);
    if (!native) throw new HttpError(400, `${svc[1]} is not a service on this system`);
    // The helper takes the unit id and maps it to this system's service name itself.
    if (mode === 'helper') await admin.serviceAction(svc[1], svc[2]);
    else { const r = await serviceAction(svc[1] as ServiceId, svc[2] as ServiceAction); if (!r.ok) throw new HttpError(500, r.error); }
    return json(res, 200, { ok: true, units: await unitStates() });
  }

  throw new HttpError(404, 'not found');
}

/**
 * Every request is attributed by its source address and listener. On the mesh listener only fd00::/8 sources
 * are accepted, each admitted only as an allowed npub while the kernel guard is proven (see server/access.ts).
 * On the main listener every source is the local operator (loopback, or whatever FIPS_UI_HOST exposes, where
 * FIPS_UI_TOKEN applies), except fd00::/8 sources while mesh access is on, which are refused.
 */
async function handle(req: Req, res: Res, listener: 'main' | 'mesh'): Promise<void> {
  const remote = req.socket.remoteAddress;
  // A connection that is already gone reports no address; never attribute that to anyone.
  if (!remote) return denyMesh(req, res, 'unknown peer address');
  // Mesh identities are admitted on the mesh listener only. With mesh access on, an fd00::/8 source on the main
  // listener is refused (it would bypass the guard, which covers the mesh port); with it off such sources are
  // what they were before this feature existed (LAN ULA clients, governed by FIPS_UI_HOST and FIPS_UI_TOKEN).
  if (listener === 'main' && isMeshAddress(remote) && mesh.meshSourcesReserved) return denyMesh(req, res, 'use the mesh address and port for access over the mesh');
  if (listener === 'mesh') {
    if (!isMeshAddress(remote)) return denyMesh(req, res, 'not a mesh connection');
    // The guard must have been loaded for this connection's handshake (proven when it was accepted), and the
    // principal is read only after that, so a revocation during the proof takes effect.
    const proof = await mesh.provenAtAccept(req.socket);
    if (proof === 'unlisted') return denyMesh(req, res);
    if (proof === 'retry') { res.setHeader('retry-after', '1'); return json(res, 503, { error: 'the spoofing guard was just reloaded; retry in a second' }, true); }
    if (proof !== 'ok') return denyMesh(req, res, 'the spoofing guard was not loaded for this connection');
    if (!mesh.ready()) { res.setHeader('retry-after', '5'); return json(res, 503, { error: 'mesh access is not ready (guard or node identity missing); retry shortly' }, true); }
    const pr = mesh.principalFor(remote);
    if (!pr) return denyMesh(req, res);
    mesh.track(req.socket, pr);
    principals.set(req, pr);
  }
  return route(req, res);
}
const server = http.createServer((req, res) => { mainRequests.add(req); handle(req, res, 'main').catch((e) => errToResponse(res, e)); });
/** Whether the main listener holds `port` on this node's fips0 address (bound to [::] or to that address). */
function mainHoldsMeshPort(port: number): boolean {
  const a = server.address();
  if (!a || typeof a !== 'object' || a.port !== port) return false;
  const own = mesh.status().address;
  return a.address === '::' || (!!own && expand6(a.address) === expand6(own));
}


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

async function denyMesh(req: Req, res: Res, reason?: string): Promise<void> {
  const addr = req.socket.remoteAddress ?? 'unknown';
  if (reason) return json(res, 403, { error: `refused: ${reason}` }, true);
  const npub = await npubForAddress(addr);
  const who = npub ? `${npub} (${addr})` : addr;
  if ((req.url ?? '').startsWith('/api/')) return json(res, 403, { error: 'this node does not allow your npub', you: { address: addr, npub } }, true);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Access denied</title><body style="font:16px system-ui;padding:2rem;max-width:40rem;margin:auto;background:#0a1220;color:#e6edf7"><h1 style="font-size:1.4rem">This FIPS node's dashboard is private</h1><p>Your connection came from <code style="word-break:break-all">${esc(who)}</code>, which is not on its allow-list.</p><p style="color:#a3b3ca">Ask the operator to add your npub under <b>Access → Web UI over the mesh</b>.</p>`;
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  res.end(html);
}

const mesh = new MeshAccess((req, res) => { handle(req, res, 'mesh').catch((e) => errToResponse(res, e)); });
// Under a public domain this node serves itself (fips-pub-domains): those names are this node's too.
mesh.extraHostAllowed = (h) => hostMatches(h, servedHostnames());
if (!SELFTEST) watchServedHostnames();

/**
 * Bring the kernel guard and the managed firewall rule in line with the access list. Runs outside the
 * access queue; a failed or refused step leaves `dirty` set and is retried on the next 15 s tick.
 */
type MeshSyncResult = { ok: boolean; guard?: string; rule?: string; skipped?: string };
const meshSync = { dirty: true, running: null as Promise<MeshSyncResult> | null };
// Only the mesh listener admits mesh identities, so only its port needs the guard.
function guardPorts(cfg: AccessConfig): number[] { return [cfg.port]; }

/** The managed firewall rule for mesh access: the mesh port on fips0, open to exactly the allowed npubs. */
function meshRule(cfg: AccessConfig): FirewallRule | null {
  return cfg.enabled && cfg.allowed.length
    ? { proto: 'tcp', ports: String(cfg.port), sources: cfg.allowed.map((a) => ({ kind: 'npub' as const, npub: a.npub, label: a.label })), comment: 'fips-ui web access over the mesh', tag: MESH_TAG }
    : null;
}
function applyMeshRule(cfg: AccessConfig): Promise<Record<string, unknown>> {
  const rule = meshRule(cfg);
  return admin.updateManagedRules((rules) => [...rules.filter((x) => x.tag !== MESH_TAG), ...(rule ? [rule] : [])]);
}
const samePorts = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Full sync after a change: guard and managed firewall rule. */
function syncMesh(): Promise<MeshSyncResult> {
  if (meshSync.running) return meshSync.running;
  meshSync.running = (async (): Promise<MeshSyncResult> => {
    meshSync.dirty = false;
    const cfg: AccessConfig = mesh.config;
    const helper = await admin.helperInfo().catch(() => null);
    // With access off there is nothing to remove when the helper is known not to have a guard: not installed, or
    // answering as too old for it. A helper check that failed may hide a loaded guard, so that case is retried.
    const noGuardPossible = helper !== null && (helper.available ? (helper.version ?? 0) < GUARD_HELPER_VERSION : !helper.installed);
    if (!cfg.enabled && noGuardPossible) return { ok: true, skipped: 'no guard to remove' };
    if (!helper?.available || helper.features.guard === 'none') {
      mesh.setGuard({ active: false, ports: [], error: helper?.available ? 'the spoofing guard is not supported on this system yet, so mesh access stays off' : 'mesh access needs the privileged helper, which installs the spoofing guard' });
      meshSync.dirty = true;
      return { ok: false, skipped: 'helper not installed' };
    }
    const ports = cfg.enabled ? guardPorts(cfg) : null;
    const tun = mesh.tunName;
    const result: MeshSyncResult = { ok: true };
    if (ports && !mesh.canaryPort && !(await mesh.startCanary())) {
      mesh.setGuard({ active: false, ports: [], error: 'the guard canary could not listen on [::1]; mesh access needs IPv6 loopback' });
      meshSync.dirty = true;
      return { ok: false, guard: 'no canary' };
    }
    // A guard already confirmed for exactly these ports and this interface is left alone (no reload): the
    // per-connection canary and the 30 s check notice if it disappears.
    const confirmed = !!ports && mesh.guard.active && mesh.guard.tun === tun && samePorts(mesh.guard.ports, ports);
    // Changing an active guard: stop admitting first, so nothing is admitted on a port while the kernel covers another.
    if (!confirmed && mesh.guard.active) mesh.setGuard({ active: false, ports: [], error: 'reloading the guard' });
    if (confirmed) {
      meshGuardDirty = false;
    } else try {
      const g = await admin.meshGuard(ports, tun, mesh.canaryPort);
      if (g.ok && tun !== mesh.tunName) { result.ok = false; result.guard = 'interface changed while applying'; meshGuardDirty = true; }
      else if (g.ok) { mesh.setGuard(ports ? { active: true, ports, tun } : { active: false, ports: [] }, { reloaded: true }); meshGuardDirty = false; }
      else { result.ok = false; result.guard = g.error ?? 'failed'; mesh.setGuard({ active: false, ports: [], error: result.guard }); }
    } catch (e) { result.ok = false; result.guard = (e as Error).message; mesh.setGuard({ active: false, ports: [], error: result.guard }); }
    try {
      const r = await applyMeshRule(cfg);
      if (!r.ok) { result.ok = false; result.rule = String(r.error ?? 'rejected'); }
    } catch (e) { result.ok = false; result.rule = (e as Error).message; }
    // A failed guard needs the full sync again; a failed rule alone is retried without touching the guard.
    if (result.guard) meshSync.dirty = true; else if (result.rule) meshRuleDirty = true; else meshRuleDirty = false;
    return result;
  })().finally(() => { meshSync.running = null; });
  return meshSync.running;
}

/** Re-apply only the guard (after a loss or a TUN rename); the firewall rule is unaffected. */
function reapplyGuard(): Promise<MeshSyncResult> {
  // After a running sync, re-apply only if the guard is still not right for the current ports and interface.
  if (meshSync.running) return meshSync.running.then(() => (mesh.guard.active && mesh.guard.tun === mesh.tunName && samePorts(mesh.guard.ports, guardPorts(mesh.config)) ? { ok: true } : reapplyGuard()));
  meshSync.running = (async (): Promise<MeshSyncResult> => {
    if (!mesh.config.enabled) return { ok: true };
    if (!mesh.canaryPort && !(await mesh.startCanary())) { mesh.setGuard({ active: false, ports: [], error: 'the guard canary could not listen on [::1]' }); meshGuardDirty = true; return { ok: false, guard: 'no canary' }; }
    const want = guardPorts(mesh.config), tun = mesh.tunName;
    if (mesh.guard.active && !(mesh.guard.tun === tun && samePorts(mesh.guard.ports, want))) mesh.setGuard({ active: false, ports: [], error: 'reloading the guard' });
    const g = await admin.meshGuard(want, tun, mesh.canaryPort).catch((e) => ({ ok: false, error: (e as Error).message }));
    if (g.ok && tun === mesh.tunName) mesh.setGuard({ active: true, ports: want, tun }, { reloaded: true });
    else { mesh.setGuard({ active: false, ports: [], error: g.ok ? 'interface changed while applying' : g.error }); meshGuardDirty = true; }
    return { ok: g.ok, guard: g.ok ? undefined : g.error };
  })().finally(() => { meshSync.running = null; });
  return meshSync.running;
}

/**
 * Every 30 s while mesh access is on, confirm the guard (ports, interface, canary) is really loaded. Read-only;
 * a mismatch stops admission at once and re-applies only the guard. A result from a check that started before
 * any other guard change is discarded.
 */
function verifyGuard(): Promise<unknown> {
  if (!mesh.config.enabled) return Promise.resolve();
  // A sync or rule retry holding the slot delays the check instead of skipping it (once; a sync reloads the guard anyway).
  if (meshSync.running) return meshSync.running.catch(() => {}).then(() => (meshSync.running ? undefined : verifyGuard()));
  const gen = mesh.guardGen;
  meshSync.running = (async (): Promise<MeshSyncResult> => {
    const st = await admin.meshGuardStatus().catch(() => null);
    if (st === null || !mesh.config.enabled || mesh.guardGen !== gen) return { ok: true };
    const want = guardPorts(mesh.config), tun = mesh.tunName;
    const ok = mesh.canaryPort > 0 && st.active && want.every((p) => st.ports.includes(p)) && st.tun === tun && st.canary === mesh.canaryPort;
    if (ok) { if (!mesh.guard.active) mesh.setGuard({ active: true, ports: want, tun }); return { ok: true }; }
    mesh.setGuard({ active: false, ports: [], error: st.active ? 'guard loaded for other ports, interface or canary' : 'guard not loaded (was the nftables ruleset flushed?)' });
    meshGuardDirty = true;
    return { ok: false };
  })().finally(() => { meshSync.running = null; });
  return meshSync.running;
}

let meshGuardDirty = false;
let meshRuleDirty = false;

/** Retry only the managed firewall rule (the guard is fine), in the same slot as the other syncs. */
function syncRule(): Promise<unknown> {
  if (meshSync.running) return Promise.resolve();
  meshSync.running = (async (): Promise<MeshSyncResult> => {
    try { const r = await applyMeshRule(mesh.config); meshRuleDirty = !r.ok; return { ok: !!r.ok }; } catch (e) { meshRuleDirty = true; return { ok: false, rule: (e as Error).message }; }
  })().finally(() => { meshSync.running = null; });
  return meshSync.running;
}
mesh.onChange = async () => { meshSync.dirty = true; };
mesh.onTunChange = () => { meshGuardDirty = true; };
mesh.onGuardLost = () => { void reapplyGuard().then(() => mesh.reconcile()); };
let meshTicks = 0;
if (!SELFTEST) setInterval(() => {
  if (meshSync.dirty) void syncMesh().then(() => mesh.reconcile());
  else if (meshGuardDirty) { meshGuardDirty = false; void reapplyGuard().then(() => mesh.reconcile()); }
  // The 30 s guard check always gets its tick; a failing rule retry cannot starve it.
  else if (++meshTicks % 2 === 0) void verifyGuard().then(() => mesh.reconcile());
  else if (meshRuleDirty) void syncRule();
}, 15_000).unref();
if (!SELFTEST) void mesh.startCanary().then(() => mesh.start()).then(() => syncMesh()).then(() => mesh.reconcile());

server.listen(SELFTEST ? 0 : PORT, SELFTEST ? '127.0.0.1' : HOST, () => {
  if (SELFTEST) { console.log('fips-ui selftest ok'); process.exit(0); }
  console.log(`fips-ui ${UI_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`  control socket : ${SOCKET_PATH}`);
  console.log(`  platform       : ${PLATFORM.os}${PLATFORM.distro ? ` (${PLATFORM.distro})` : ''}, services via ${PLATFORM.serviceManager}, logs via ${LOG_SOURCE ?? 'none'}`);
  console.log(`  static dir     : ${STATIC_DIR}${fs.existsSync(STATIC_DIR) ? '' : ' (not built yet)'}`);
  console.log(`  auth           : ${TOKEN ? 'token' : 'none (bind to loopback or set FIPS_UI_TOKEN)'}`);
  void serviceControlMode().then((m) => console.log(`  service control: ${m ? `enabled (${m})` : 'disabled'}${READ_ONLY ? ' (read-only mode)' : ''}`));
  console.log(`  allowed hosts  : ${HOST_CHECK ? [...ALLOWED_HOSTS].join(', ') : 'any (wildcard bind without FIPS_UI_ALLOWED_HOSTS: DNS-rebinding protection is off)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); mesh.close(); hostsSync.close(); process.exit(0); });
