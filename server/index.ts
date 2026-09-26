// FIPS UI API server. Zero dependencies; runs directly under Node >= 22.6 (native TypeScript stripping).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { query, ControlError, READ_ONLY_COMMANDS, GATEWAY_COMMANDS, SOCKET_PATH, GATEWAY_SOCKET_PATH } from './control.ts';
import { journal, recentLogs, type LogLine } from './journal.ts';
import { unitStates, serviceAction, readHosts, hostInfo, UNITS, type UnitName, type ServiceAction } from './system.ts';
import { createUpgradeHandler } from './upgrade.ts';

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

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
type Req = http.IncomingMessage;
type Res = http.ServerResponse;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function json(res: Res, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: Req): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 64 * 1024) throw new HttpError(413, 'body too large'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
}

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
function browserChecks(req: Req, method: string): string | null {
  if (HOST_CHECK) {
    const host = hostnameOf(req.headers.host);
    if (!host || !ALLOWED_HOSTS.has(host)) return `host '${req.headers.host ?? ''}' is not allowed (set FIPS_UI_ALLOWED_HOSTS)`;
  }
  if (method === 'GET' || method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    const o = hostnameOf(origin, true);
    if (!o || (HOST_CHECK ? !ALLOWED_HOSTS.has(o) : o !== hostnameOf(req.headers.host))) return `cross-origin request from ${origin} refused`;
  } else if (origin === 'null') return 'cross-origin request refused';
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site === 'cross-site') return 'cross-site request refused';
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return 'mutating requests must be sent with content-type: application/json';
  return null;
}

function errToResponse(res: Res, e: unknown) {
  if (e instanceof HttpError) return json(res, e.status, { error: e.message });
  if (e instanceof ControlError) return json(res, e.kind === 'transport' ? 503 : 400, { error: e.message, kind: e.kind });
  console.error(e);
  json(res, 500, { error: (e as Error).message ?? 'internal error' });
}

const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;

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
  if (!isFile(file)) file = path.join(STATIC_DIR, 'index.html'); // SPA fallback
  if (!isFile(file)) return json(res, 404, { error: 'frontend not built: web/dist/index.html is missing' });
  const ext = path.extname(file);
  const immutable = rel.startsWith('/assets/');
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
// Node upgrade API (/api/upgrade/*). Reads are open like every other API route; mutations are
// refused in read-only mode. Token auth (when configured) is enforced by route() before this runs.
const upgrade = createUpgradeHandler({ authorize: () => !READ_ONLY, controlSocket: SOCKET_PATH });

async function route(req: Req, res: Res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  if (!p.startsWith('/api/')) return serveStatic(url, res);

  const refused = browserChecks(req, method);
  if (refused) return json(res, 403, { error: refused });

  // Auth: when a token is configured, every API call needs it (mutations always, reads too).
  if (p !== '/api/health' && !tokenOk(req, url)) return json(res, 401, { error: 'unauthorized', auth: 'token' });

  if (p === '/api/health') {
    let daemon: unknown = null; let error: string | undefined;
    try { daemon = await query('show_status', undefined, { timeoutMs: 2500 }); } catch (e) { error = (e as Error).message; }
    return json(res, 200, { ok: !error, auth: TOKEN ? 'token' : 'none', readOnly: READ_ONLY, upgrade: true, serviceControl: ALLOW_SERVICE_CONTROL && !READ_ONLY, socket: SOCKET_PATH, gatewaySocket: fs.existsSync(GATEWAY_SOCKET_PATH) ? GATEWAY_SOCKET_PATH : null, pollMs: POLL_MS, uiUptimeSecs: Math.floor((Date.now() - startedAt) / 1000), error, version: (daemon as { version?: string } | null)?.version });
  }

  if (p === '/api/events') return handleSse(req, res);
  if (p.startsWith('/api/upgrade')) { if (await upgrade(req, res)) return; }
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

  if (p === '/api/hosts') return json(res, 200, await readHosts());
  if (p === '/api/system') return json(res, 200, { host: await hostInfo(), units: await unitStates() });
  if (p === '/api/logs') {
    const lines = Number(url.searchParams.get('lines') ?? 300);
    return json(res, 200, { lines: await recentLogs(lines, url.searchParams.get('since') ?? undefined) });
  }
  if (p === '/api/resolve') {
    const id = url.searchParams.get('id') ?? '';
    return json(res, 200, await resolvePeer(id));
  }

  // ---- mutating -----------------------------------------------------------------------------
  if (method !== 'POST') throw new HttpError(404, 'not found');
  if (READ_ONLY) throw new HttpError(403, 'this UI instance is read-only (FIPS_UI_READ_ONLY=1)');
  const body = await readBody(req);

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
    if (!ALLOW_SERVICE_CONTROL) throw new HttpError(403, 'service control is disabled; start the UI with FIPS_UI_ALLOW_SERVICE_CONTROL=1 and the needed privileges');
    if (!(UNITS as readonly string[]).includes(svc[1])) throw new HttpError(400, 'unknown unit');
    const r = await serviceAction(svc[1] as UnitName, svc[2] as ServiceAction);
    if (!r.ok) throw new HttpError(500, r.error);
    return json(res, 200, { ok: true, units: await unitStates() });
  }

  throw new HttpError(404, 'not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => errToResponse(res, e));
});

server.listen(PORT, HOST, () => {
  console.log(`fips-ui listening on http://${HOST}:${PORT}`);
  console.log(`  control socket : ${SOCKET_PATH}`);
  console.log(`  static dir     : ${STATIC_DIR}${fs.existsSync(STATIC_DIR) ? '' : ' (not built yet)'}`);
  console.log(`  auth           : ${TOKEN ? 'token' : 'none (bind to loopback or set FIPS_UI_TOKEN)'}`);
  console.log(`  service control: ${ALLOW_SERVICE_CONTROL && !READ_ONLY ? 'enabled' : 'disabled'}${READ_ONLY ? ' (read-only mode)' : ''}`);
  console.log(`  allowed hosts  : ${HOST_CHECK ? [...ALLOWED_HOSTS].join(', ') : 'any (wildcard bind without FIPS_UI_ALLOWED_HOSTS: DNS-rebinding protection is off)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); process.exit(0); });
