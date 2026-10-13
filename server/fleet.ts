// The node manager: other fips nodes that run fips-ui, managed from this one over the mesh through their own
// APIs. Each managed node lists this node's npub as an admin under "Web UI over the mesh", so a request that
// leaves this node for the managed node's fips0 address arrives as that npub (the same channel hosts sync uses,
// server/hosts-sync.ts). Nothing here needs a token: the mesh authenticates the source address.
//
// Recovery when this node is lost: fleet.json lists further managers (standby npubs). This node keeps every
// managed node's access list containing all of them as admins, so a standby whose nsec is backed up can be
// started anywhere and is admin on every node already.
//
// Only a superadmin on this node may use the fleet endpoints (server/index.ts): an npub is a node, not a person,
// and without that distinction every admin of this node would reach every managed node through it.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAdmin, type AccessEntry, type Role } from './access.ts';
import { sendJson } from './http.ts';

const DEFAULT_FILE = process.env.FIPS_UI_FLEET_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'fleet.json');
export const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;
export const MAX_NODES = 200;
export const MAX_MANAGERS = 16;
/** Sent with every request to a managed node: it must not look like a hosts-sync follower (server/hosts-followers.ts isSyncRequest). */
export const USER_AGENT = 'fips-ui-fleet';
/** Largest answer taken from a managed node. */
const MAX_ANSWER = 1024 * 1024;
/** Nodes probed at the same time. */
const CONCURRENCY = 4;
/** The GitHub-touching reads (release checks) run every n-th poll only. */
const SLOW_EVERY = 5;

export type FleetKind = 'config' | 'offline' | 'unauthorised' | 'viewer' | 'not-ready' | 'other';
export class FleetError extends Error {
  kind: FleetKind;
  status?: number;
  constructor(message: string, kind: FleetKind = 'other', status?: number) { super(message); this.kind = kind; this.status = status; }
}

export interface FleetNode { npub: string; label?: string; port: number }
export interface FleetManager { npub: string; label?: string }
export interface FleetConfig { nodes: FleetNode[]; managers: FleetManager[] }

const cleanLabel = (v: unknown): string => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ._@-]/gu, '').slice(0, 40).trim() : '');

export function validateFleetConfig(input: unknown, ownNpub?: string): FleetConfig {
  const x = input as Partial<FleetConfig> | null;
  if (!x || typeof x !== 'object') throw new FleetError('the configuration must be an object', 'config');
  if (!Array.isArray(x.nodes) || x.nodes.length > MAX_NODES) throw new FleetError(`nodes must be an array of at most ${MAX_NODES} entries`, 'config');
  if (!Array.isArray(x.managers) || x.managers.length > MAX_MANAGERS) throw new FleetError(`managers must be an array of at most ${MAX_MANAGERS} entries`, 'config');
  const seenNodes = new Set<string>();
  const nodes = x.nodes.map((n) => {
    const e = n as Partial<FleetNode>;
    if (!NPUB_RE.test(String(e?.npub))) throw new FleetError(`invalid npub '${e?.npub}'`, 'config');
    if (e.npub === ownNpub) throw new FleetError('this node cannot manage itself', 'config');
    if (seenNodes.has(e.npub!)) throw new FleetError(`${e.npub} is listed twice`, 'config');
    seenNodes.add(e.npub!);
    const port = Number(e.port ?? 8321);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FleetError(`port for ${e.npub} must be an integer between 1 and 65535`, 'config');
    const label = cleanLabel(e.label);
    return { npub: e.npub!, port, ...(label ? { label } : {}) };
  });
  const seenManagers = new Set<string>();
  const managers = x.managers.map((m) => {
    const e = m as Partial<FleetManager>;
    if (!NPUB_RE.test(String(e?.npub))) throw new FleetError(`invalid manager npub '${e?.npub}'`, 'config');
    if (seenManagers.has(e.npub!)) throw new FleetError(`manager ${e.npub} is listed twice`, 'config');
    seenManagers.add(e.npub!);
    const label = cleanLabel(e.label);
    return { npub: e.npub!, ...(label ? { label } : {}) };
  });
  return { nodes, managers };
}

/** The npubs every managed node should list as admins: this node first, then the configured standbys. */
export function effectiveManagers(cfg: FleetConfig, own?: string): string[] {
  const out: string[] = own ? [own] : [];
  for (const m of cfg.managers) if (!out.includes(m.npub)) out.push(m.npub);
  return out;
}

// ---- client ---------------------------------------------------------------------------------

export interface FetchInit { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }
export interface FetchResult { status: number; body: unknown }
/** One JSON request to a managed node. Rejects with FleetError('offline') when the node cannot be reached. */
export type FetchJson = (npub: string, port: number, path: string, init?: FetchInit) => Promise<FetchResult>;

export function makeFetchJson(meshAddress: (npub: string) => Promise<string>, version?: string): FetchJson {
  return async (npub, port, path, init = {}) => {
    const addr = await meshAddress(npub).catch((e: Error) => { throw new FleetError(`cannot derive the node's address: ${e.message}`, 'offline'); });
    const url = `http://[${addr}]:${port}${path}`;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT, 'x-fips-ui-fleet': version ?? '' };
    if (init.method === 'POST') headers['content-type'] = 'application/json';
    let res: Response;
    try { res = await fetch(url, { method: init.method ?? 'GET', headers, body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) }); }
    catch (e) {
      const cause = (e as Error).cause;
      throw new FleetError(`cannot reach [${addr}]:${port} (${cause ? String((cause as Error).message ?? cause) : (e as Error).message})`, 'offline');
    }
    // Read at most MAX_ANSWER bytes: a node is trusted less than this one, so its answer is bounded before it is held.
    if (Number(res.headers.get('content-length')) > MAX_ANSWER) { await res.body?.cancel().catch(() => {}); throw new FleetError('the node\'s answer is too large'); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        size += r.value.byteLength;
        if (size > MAX_ANSWER) { await reader.cancel().catch(() => {}); throw new FleetError(`the node's answer is too large (over ${MAX_ANSWER} bytes)`); }
        chunks.push(r.value);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 200) }; }
    return { status: res.status, body };
  };
}

/** The error a non-success answer stands for, with the node's own reason when it gave one. */
export function classify(r: FetchResult): FleetError | null {
  const reason = (r.body as { error?: unknown } | null)?.error;
  const why = typeof reason === 'string' && reason ? reason : `status ${r.status}`;
  if (r.status >= 200 && r.status < 300) return null;
  if (r.status === 403) return new FleetError(`the node refused this node: ${why}`, 'unauthorised', 403);
  if (r.status === 401) return new FleetError('the node asked for a token: its main listener answered, so Web UI over the mesh is off there or its port differs', 'unauthorised', 401);
  if (r.status === 503) return new FleetError(`the node is not ready: ${why}`, 'not-ready', 503);
  return new FleetError(`the node answered ${why}`, 'other', r.status);
}

// ---- per-node status --------------------------------------------------------------------------

export type Phase = 'ok' | 'offline' | 'unauthorised' | 'viewer' | 'not-ready' | 'restarting' | 'error';
export interface NodeStatus {
  npub: string; label?: string; port: number;
  reachable: boolean; phase: Phase; error?: string;
  lastAttempt: number; lastSeen?: number;
  /** From the node's /api/health and show_status (kept from the last answer while it is unreachable). */
  daemonVersion?: string; daemonOk?: boolean; uiVersion?: string; uiUptimeSecs?: number; uptimeSecs?: number; peerCount?: number;
  platform?: string; readOnly?: boolean; nodeManagement?: boolean;
  /** This node's role there (admin is what management needs). */
  role?: Role;
  /** The node's privileged helper: installed version and the one its fips-ui checkout ships (null: unknown). */
  helper?: { installed: number | null; shipped: number | null };
  upgrade?: { installed?: string; running?: string; latest?: string; available: boolean; restartPending?: boolean; job?: { state: string; kind?: string } | null };
  uiUpdate?: { current?: string; latest?: string; available: boolean; job?: { state: string; restarting?: boolean } | null };
  /** Whether every manager (but the node itself) is an admin on the node's access list, and which are not. */
  managersInSync?: boolean; managersMissing?: string[];
}

type Answer = FetchResult | Error;
export interface Probe { health: Answer; status?: Answer; access?: Answer; uiUpdate?: Answer; upgrade?: Answer }

const asRecord = (a: Answer | undefined): Record<string, unknown> | null => {
  if (!a || a instanceof Error || a.status !== 200 || !a.body || typeof a.body !== 'object') return null;
  return a.body as Record<string, unknown>;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Builds the status record from the answers of one poll; `prev` keeps the last known facts while the node is away. */
export function deriveNodeStatus(node: FleetNode, prev: NodeStatus | undefined, probe: Probe, managers: string[], now: number): NodeStatus {
  const carry: Partial<NodeStatus> = prev ? { lastSeen: prev.lastSeen, daemonVersion: prev.daemonVersion, uiVersion: prev.uiVersion, platform: prev.platform, helper: prev.helper, upgrade: prev.upgrade, uiUpdate: prev.uiUpdate, managersInSync: prev.managersInSync, managersMissing: prev.managersMissing, role: prev.role } : {};
  const base: NodeStatus = { ...carry, npub: node.npub, port: node.port, ...(node.label ? { label: node.label } : {}), reachable: false, phase: 'error', lastAttempt: now };
  const h = probe.health;
  if (h instanceof Error) {
    const kind = h instanceof FleetError ? h.kind : 'other';
    return { ...base, phase: kind === 'offline' ? 'offline' : kind === 'not-ready' ? 'not-ready' : kind === 'unauthorised' ? 'unauthorised' : 'error', error: h.message };
  }
  const refused = classify(h);
  if (refused) return { ...base, phase: refused.kind === 'unauthorised' ? 'unauthorised' : refused.kind === 'not-ready' ? 'not-ready' : 'error', error: refused.message };
  const health = asRecord(h) ?? {};
  // Something else answered on that port (another service, a page): not a fips-ui.
  if (typeof health.ok !== 'boolean' || typeof health.auth !== 'string') return { ...base, phase: 'error', error: 'unexpected answer: is that the port of its fips-ui?' };
  // Only the node's mesh listener knows this node by its npub. Its main listener answers /api/health too (openly,
  // as the local operator): that is not a grant, and every other call there would be refused.
  if (health.auth !== 'npub') return { ...base, phase: 'unauthorised', error: 'the node\'s main listener answered, not its mesh listener: Web UI over the mesh is off there, or its port differs' };
  const principal = health.principal as { role?: Role } | undefined;
  const role = principal?.role;
  const out: NodeStatus = {
    ...base, reachable: true, phase: 'ok', lastSeen: now, role,
    daemonOk: health.ok === true, daemonVersion: str(health.version) ?? base.daemonVersion, uiVersion: str(health.uiVersion) ?? base.uiVersion, uiUptimeSecs: num(health.uiUptimeSecs),
    platform: str((health.platform as { os?: unknown } | undefined)?.os) ?? base.platform, readOnly: health.readOnly === true, nodeManagement: health.nodeManagement === true,
  };
  const st = asRecord(probe.status);
  if (st) { out.peerCount = num(st.peer_count); out.uptimeSecs = num(st.uptime_secs ?? st.uptime); out.daemonVersion = str(st.version) ?? out.daemonVersion; }
  if (!role || !isAdmin(role)) {
    return { ...out, phase: 'viewer', error: `this node is listed as ${role ?? 'nobody'} there; management needs admin`, managersInSync: undefined, managersMissing: undefined };
  }
  const access = asRecord(probe.access);
  const allowed = (access?.config as { allowed?: AccessEntry[] } | undefined)?.allowed;
  if (Array.isArray(allowed)) {
    // The node itself cannot be on its own list (a standby that is also managed).
    const missing = managers.filter((m) => m !== node.npub && !allowed.some((e) => e?.npub === m && isAdmin(e.role)));
    out.managersInSync = missing.length === 0; out.managersMissing = missing;
  }
  const u = asRecord(probe.uiUpdate);
  if (u) {
    const latest = str((u.latest as { version?: unknown } | null | undefined)?.version);
    const helper = u.helper as { installed?: unknown; shipped?: unknown } | undefined;
    const job = u.job as { state?: unknown; restarting?: unknown } | null | undefined;
    out.uiUpdate = { current: str(u.current), latest, available: u.newer === true, job: job && typeof job.state === 'string' ? { state: job.state, ...(job.restarting === true ? { restarting: true } : {}) } : null };
    if (helper) out.helper = { installed: typeof helper.installed === 'number' ? helper.installed : null, shipped: typeof helper.shipped === 'number' ? helper.shipped : null };
  }
  const g = asRecord(probe.upgrade);
  if (g) {
    const release = g.release as { tag?: unknown; relation?: unknown } | undefined;
    const job = g.job as { state?: unknown; kind?: unknown } | null | undefined;
    out.upgrade = {
      installed: str((g.installed as { version?: unknown } | undefined)?.version), running: str((g.running as { version?: unknown } | null | undefined)?.version),
      latest: str(release?.tag)?.replace(/^v/, ''), available: release?.relation === 'newer', restartPending: g.restartPending === true,
      job: job && typeof job.state === 'string' ? { state: job.state, ...(typeof job.kind === 'string' ? { kind: job.kind } : {}) } : null,
    };
    const hv = (g.helper as { version?: unknown } | undefined)?.version;
    if (typeof hv === 'number' && !out.helper) out.helper = { installed: hv, shipped: null };
  }
  return out;
}

// ---- the fleet ----------------------------------------------------------------------------------

export interface FleetDeps {
  /** This node's npub (implicit first manager; cannot be managed). */
  ownNpub: () => Promise<string | undefined>;
  /** The fips0 address derived from an npub. */
  meshAddress: (npub: string) => Promise<string>;
  /** Replaces the HTTP client (tests). */
  fetchJson?: FetchJson;
  /** This node's fips-ui version, sent to the managed nodes. */
  version?: string;
  now?: () => number;
  /** How often every node is probed. */
  intervalMs?: number;
  /** Where the configuration lives (default: FIPS_UI_FLEET_FILE or ~/.config/fips-ui/fleet.json). */
  file?: string;
}

export interface FleetStatus { running: boolean; lastRun?: number; nextRun?: number; error?: string }
let saveSeq = 0;

export class Fleet {
  config: FleetConfig = { nodes: [], managers: [] };
  status: FleetStatus = { running: false };
  private readonly deps: FleetDeps;
  private readonly fetchJson: FetchJson;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly file_: string;
  private nodes = new Map<string, NodeStatus>();
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private tick = 0;
  /** The file exists but could not be loaded: saving is refused until it does, so it is never overwritten. */
  private loadError: string | undefined;
  private own: string | undefined;
  /** Loads and saves run one at a time, in order (a save cannot race the load at start, nor another save). */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  constructor(deps: FleetDeps) {
    this.deps = deps;
    this.fetchJson = deps.fetchJson ?? makeFetchJson(deps.meshAddress, deps.version);
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.file_ = deps.file ?? DEFAULT_FILE;
  }

  get file(): string { return this.file_; }
  /** Whether anything is managed (the poller only runs then). */
  get enabled(): boolean { return this.config.nodes.length > 0; }
  get ownNpub(): string | undefined { return this.own; }

  /** Read the file; a missing file means nothing is managed. The outcome is in `loadError` (cleared when it loads). */
  private async load(): Promise<void> {
    try { this.config = validateFleetConfig(JSON.parse(await readFile(this.file_, 'utf8'))); this.loadError = undefined; }
    catch (e) { this.loadError = (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : `cannot load ${this.file_}: ${(e as Error).message}`; }
    this.status = { ...this.status, error: this.loadError };
  }

  async start(): Promise<void> {
    await this.serial(() => this.load());
    this.timer = setInterval(() => { if (this.enabled) void this.runOnce(false); }, this.intervalMs);
    this.timer.unref();
    if (this.enabled) void this.runOnce(true);
  }

  close(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Persist a new configuration and probe the nodes at once. A file that failed to load is read again first, so fixing or removing it is enough. */
  save(input: unknown): Promise<FleetConfig> {
    return this.serial(async () => {
      if (this.loadError) await this.load();
      if (this.loadError) throw new FleetError(`${this.loadError}; fix or remove the file first`, 'config');
      const own = await this.deps.ownNpub().catch(() => undefined);
      const cfg = validateFleetConfig(input, own);
      await mkdir(dirname(this.file_), { recursive: true, mode: 0o700 });
      const tmp = `${this.file_}.${process.pid}.${++saveSeq}.tmp`;
      try { await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, this.file_); }
      catch (e) { await unlink(tmp).catch(() => {}); throw new Error(`cannot write ${this.file_}: ${(e as Error).message}`); }
      this.config = cfg;
      for (const npub of [...this.nodes.keys()]) if (!cfg.nodes.some((n) => n.npub === npub)) this.nodes.delete(npub);
      if (this.enabled) void this.runOnce(true);
      return cfg;
    });
  }

  /** Probe every node now (one run at a time; a call during a run waits for that run). */
  refresh(): Promise<void> { return this.runOnce(true); }

  /** The managers every node should list: this node, then the standbys. */
  managers(): string[] { return effectiveManagers(this.config, this.own); }

  /** What the overview shows, in the configured order. */
  snapshot(): { config: FleetConfig; own?: string; managers: string[]; file: string; status: FleetStatus; nodes: NodeStatus[] } {
    const nodes = this.config.nodes.map((n) => this.nodes.get(n.npub) ?? { npub: n.npub, port: n.port, ...(n.label ? { label: n.label } : {}), reachable: false, phase: 'offline' as Phase, error: 'not probed yet', lastAttempt: 0 });
    return { config: this.config, own: this.own, managers: this.managers(), file: this.file_, status: this.status, nodes };
  }

  nodeStatus(npub: string): NodeStatus | undefined { return this.nodes.get(npub); }

  /** A forced run asked for while one is in flight runs right after it (with the list and checks of that moment). */
  private forcedNext = false;
  private runOnce(force: boolean): Promise<void> {
    if (this.inflight) {
      if (!force) return this.inflight;
      if (!this.forcedNext) { this.forcedNext = true; this.inflight = this.inflight.then(() => { this.forcedNext = false; return this.pollAll(true); }).catch(() => {}).finally(() => { this.inflight = null; }); }
      return this.inflight;
    }
    this.inflight = this.pollAll(force).catch(() => {}).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async pollAll(force: boolean): Promise<void> {
    this.tick++;
    const slow = force || this.tick % SLOW_EVERY === 1;
    this.status = { ...this.status, running: true };
    try {
      this.own = (await this.deps.ownNpub().catch(() => undefined)) ?? this.own;
      const managers = this.managers();
      const queue = [...this.config.nodes];
      const worker = async () => { for (let n = queue.shift(); n; n = queue.shift()) await this.pollNode(n, slow, managers); };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    } finally {
      const at = this.now();
      this.status = { ...this.status, running: false, lastRun: at, nextRun: at + this.intervalMs };
    }
  }

  /** Probe one node and record what it said. Never throws. */
  async pollNode(node: FleetNode, slow: boolean, managers = this.managers()): Promise<NodeStatus> {
    // A file copied from another manager (recovery) may list this node itself: never probed, flagged instead.
    if (this.own && node.npub === this.own) {
      const self: NodeStatus = { npub: node.npub, port: node.port, ...(node.label ? { label: node.label } : {}), reachable: false, phase: 'error', error: 'this is this node itself; remove it from the list', lastAttempt: this.now() };
      this.nodes.set(node.npub, self);
      return self;
    }
    const get = (path: string, timeoutMs = 8000): Promise<Answer> => this.fetchJson(node.npub, node.port, path, { timeoutMs }).catch((e: Error) => e);
    const probe: Probe = { health: await get('/api/health') };
    const health = asRecord(probe.health);
    if (health) {
      const role = (health.principal as { role?: Role } | undefined)?.role;
      const reads: Promise<unknown>[] = [get('/api/q/show_status').then((a) => { probe.status = a; })];
      if (role && isAdmin(role)) {
        reads.push(get('/api/access').then((a) => { probe.access = a; }));
        if (slow) reads.push(get('/api/ui-update', 15_000).then((a) => { probe.uiUpdate = a; }), get('/api/upgrade/status', 20_000).then((a) => { probe.upgrade = a; }));
      }
      await Promise.all(reads);
    }
    const status = deriveNodeStatus(node, this.nodes.get(node.npub), probe, managers, this.now());
    if (this.config.nodes.some((n) => n.npub === node.npub)) this.nodes.set(node.npub, status);
    return status;
  }
}

// ---- proxy ----------------------------------------------------------------------------------------
// /api/fleet/nodes/<npub>/api/... forwards one request to that node's own API, so the manager's frontend can show
// any of its pages for a managed node. The browser cannot call the node itself: its writes are refused as
// cross-origin there, and it does not carry this node's mesh identity. Only an allow-list of headers travels
// upstream (never the manager's token or cookies), and the answer streams back as it arrives (SSE included).

const PROXY_RE = /^\/api\/fleet\/nodes\/(npub1[02-9ac-hj-np-z]{58})(\/api(?:\/[A-Za-z0-9_.-]+)*\/?)$/;
const MAX_PROXY_PATH = 512;
/** Request headers that go upstream; everything else from the browser stays here. */
const FORWARD_REQUEST = ['accept', 'last-event-id'];
/** Response headers that come back; hop-by-hop ones and cookies do not. */
const FORWARD_RESPONSE = ['content-type', 'cache-control', 'retry-after', 'content-length', 'x-accel-buffering'];
/** Time for the node to answer a read with headers; after that a stream may stay open as long as it likes. */
const HEADERS_TIMEOUT_MS = 10_000;
/** A change may take long on the node (a service restart waits up to 150 s there): it is given that long. */
const POST_TIMEOUT_MS = 180_000;

/** The node and the path on it that a proxied URL names, or null when it is not one (or not a plain /api path). */
export function parseProxyPath(pathname: string): { npub: string; path: string } | null {
  if (pathname.length > MAX_PROXY_PATH + 80) return null;
  const m = PROXY_RE.exec(pathname);
  if (!m) return null;
  const path = m[2];
  if (path.length > MAX_PROXY_PATH || path.includes('//') || path.split('/').some((s) => s === '.' || s === '..')) return null;
  return { npub: m[1], path };
}

/** The query string to send upstream: everything but this node's token. */
export function forwardQuery(params: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of params) if (k !== 'token') q.append(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

// No socket cap: every open page of a managed node holds a stream, which must not queue the next request.
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

export interface ProxyDeps {
  meshAddress: (npub: string) => Promise<string>;
  version?: string;
  /** The JSON body of a POST, already read and checked by the caller. */
  body?: Record<string, unknown>;
  /** Told what the node answered to a forwarded POST (the self-update and install cases restart it). */
  onForwarded?: (node: FleetNode, path: string, status: number) => void;
}

/**
 * Forward `req` to `node` and stream the answer into `res`. Resolves once the node's headers are through (or an
 * error was answered); a long stream keeps flowing after that. A closed browser connection ends the upstream one.
 */
export function proxyRequest(req: IncomingMessage, res: ServerResponse, node: FleetNode, path: string, query: string, deps: ProxyDeps): Promise<void> {
  const method = req.method === 'POST' ? 'POST' : 'GET';
  return new Promise<void>((resolve) => {
    const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => { if (!res.headersSent && !res.destroyed) sendJson(res, status, { error, ...extra }); else res.destroy(); resolve(); };
    // The browser may be gone before the address is known (or while the body was read): then nothing is sent
    // upstream. Only the response side tells: a request whose body was consumed counts as destroyed already.
    let up: http.ClientRequest | null = null;
    let gone = res.destroyed;
    res.on('close', () => { gone = true; up?.destroy(); });
    deps.meshAddress(node.npub).then((addr) => {
      if (gone) return resolve();
      const headers: Record<string, string> = { host: `[${addr}]:${node.port}`, 'user-agent': USER_AGENT, 'x-fips-ui-fleet': deps.version ?? '' };
      for (const h of FORWARD_REQUEST) { const v = req.headers[h]; if (typeof v === 'string') headers[h] = v; }
      headers.accept ??= 'application/json';
      const body = method === 'POST' ? Buffer.from(JSON.stringify(deps.body ?? {})) : null;
      if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
      up = http.request({ host: addr, port: node.port, path: `${path}${query}`, method, headers, agent });
      const limit = method === 'POST' ? POST_TIMEOUT_MS : HEADERS_TIMEOUT_MS;
      const timer = setTimeout(() => up?.destroy(new Error('timeout')), limit);
      up.on('response', (upstream) => {
        clearTimeout(timer);
        const status = upstream.statusCode ?? 502;
        if (status === 401) {
          // The node's main listener answered (mesh access is off there, or the port is wrong). Not passed through:
          // a 401 would make the manager's frontend ask for the manager's token.
          upstream.resume();
          return fail(502, 'the node asked for a token: its main listener answered, so Web UI over the mesh is off there or its port differs', { upstream: 401, kind: 'unauthorised' });
        }
        const out: Record<string, string> = { 'x-fips-ui-node': node.npub };
        for (const h of FORWARD_RESPONSE) { const v = upstream.headers[h]; if (typeof v === 'string') out[h] = v; }
        res.writeHead(status, out);
        upstream.pipe(res);
        upstream.on('error', () => res.destroy());
        if (method === 'POST') deps.onForwarded?.(node, path, status);
        resolve();
      });
      up.on('error', (e) => {
        clearTimeout(timer);
        if (e.message === 'timeout') return fail(504, `the node did not answer within ${limit / 1000} seconds`, { kind: 'offline' });
        fail(502, `cannot reach the node at [${addr}]:${node.port} (${(e as NodeJS.ErrnoException).code ?? e.message})`, { kind: 'offline' });
      });
      up.end(body ?? undefined);
    }, (e: Error) => fail(502, `cannot derive the node's address: ${e.message}`, { kind: 'offline' }));
  });
}
