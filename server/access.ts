// Remote access to the web UI over the mesh, authorised by npub.
//
// FIPS reconstructs the IPv6 header of every packet it delivers to fips0 from the authenticated end-to-end
// session (docs/design/fips-ipv6-adapter.md upstream), so the source address of a connection that arrives
// through the mesh is the fd00::/8 address derived from the sender's npub. The UI therefore needs no
// login over the mesh: it compares the peer address with the derived addresses of the allowed npubs.
//
// A source address alone is not proof: a host on the LAN could send packets with someone's fd00::/8
// address, and with a forged router advertisement even complete a handshake. So the helper loads a kernel
// guard (table inet fips_ui_guard) that drops TCP from fd00::/8 to the UI's ports unless it arrives on lo or
// the FIPS TUN device. Every packet is checked, the handshake included.
//
// Something outside the UI can flush the guard (restarting nftables.service flushes the whole ruleset), so
// its presence is proven for every fd00::/8 connection at the moment it is accepted, without privileges: the
// same table holds a canary rule that resets TCP to a private port on ::1 where this process listens. On
// accept the UI connects to that port. Refused means the table is loaded, so the handshake just completed
// under the guard; accepted means it is gone, and the connection is destroyed. The residual window is the
// time between the kernel completing a handshake and this check (well under a millisecond), during which the
// guard would have to be re-loaded by someone else for a forged connection to pass.

import http from 'node:http';
import net, { type Socket } from 'node:net';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { expand6, isMeshAddress as isMeshSource } from './net6.ts';
import { query } from './control.ts';
import { meshAddress, NPUB_RE } from './admin.ts';
import { readHosts } from './system.ts';

export type Role = 'viewer' | 'admin';
export interface AccessEntry { npub: string; label?: string; role: Role }
export interface AccessConfig { enabled: boolean; port: number; allowed: AccessEntry[] }
export type Principal =
  | { kind: 'local'; role: 'admin' }
  | { kind: 'mesh'; role: Role; npub: string; label?: string; address: string };

export const LOCAL: Principal = { kind: 'local', role: 'admin' };
const FILE = process.env.FIPS_UI_ACCESS_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'access.json');

export class AccessError extends Error {}

/** Every address configured on this host's interfaces (expanded), re-read at most once a second. */
let localCache: { at: number; set: Set<string> } | null = null;
function localAddresses(): Set<string> {
  const now = performance.now();
  if (!localCache || now - localCache.at > 1000) {
    const set = new Set<string>();
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) { const k = a.family === 'IPv6' ? expand6(a.address.split('%')[0]) : null; if (k) set.add(k); }
    localCache = { at: now, set };
  }
  return localCache.set;
}

export { expand6 };

export function validateAccess(input: unknown): AccessConfig {
  const x = input as Partial<AccessConfig>;
  if (typeof x?.enabled !== 'boolean') throw new AccessError('enabled must be a boolean');
  const port = Number(x.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AccessError('port must be an integer between 1 and 65535');
  if (!Array.isArray(x.allowed) || x.allowed.length > 200) throw new AccessError('allowed must be an array of at most 200 entries');
  const seen = new Set<string>();
  const allowed = x.allowed.map((e) => {
    const en = e as Partial<AccessEntry>;
    if (!NPUB_RE.test(String(en?.npub))) throw new AccessError(`invalid npub '${en?.npub}'`);
    if (en.role !== 'viewer' && en.role !== 'admin') throw new AccessError(`role for ${en.npub} must be viewer or admin`);
    if (seen.has(en.npub!)) throw new AccessError(`${en.npub} is listed twice`);
    seen.add(en.npub!);
    const label = typeof en.label === 'string' ? en.label.replace(/[^\p{L}\p{N} ._@-]/gu, '').slice(0, 40).trim() : '';
    return { npub: en.npub!, role: en.role, ...(label ? { label } : {}) };
  });
  return { enabled: x.enabled, port, allowed };
}

export interface MeshStatus { listening: boolean; address: string | null; npub: string | null; port: number; guard: { active: boolean; ports: number[]; error?: string }; error?: string }

type Entry = AccessEntry & { address: string };
type Proof = 'ok' | 'retry' | 'fail';

export class MeshAccess {
  config: AccessConfig = { enabled: false, port: 8321, allowed: [] };
  private byAddress = new Map<string, Entry>();
  private server: http.Server | null = null;
  private bound: { address: string; port: number } | null = null;
  private own: { address: string; npub: string } | null = null;
  private lastError: string | undefined;
  /** Every state change (load, save, bind, re-bind) runs through this queue, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Open connections admitted as a mesh principal, with the grant they were admitted under. */
  private conns = new Map<Socket, string>();
  private tun = 'fips0';
  /** Whether the kernel guard for the current ports is loaded (set by the sync in server/index.ts). */
  guard: { active: boolean; ports: number[]; tun?: string; error?: string } = { active: false, ports: [] };
  /** Bumped on every guard state change, so a check that started earlier can tell it is stale. */
  guardGen = 0;
  private rebindGen = 0;
  /** When the guard was last (re)loaded, on a monotonic clock: connections accepted right after are refused. */
  private guardSince = 0;
  /** Set when access.json exists but could not be loaded; saving is refused until it loads, so it is never overwritten. */
  private loadError: string | undefined;
  private loaded = false;
  private readonly handler: http.RequestListener;

  constructor(handler: http.RequestListener) { this.handler = handler; }

  get file(): string { return FILE; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  get tunName(): string { return this.tun; }

  status(): MeshStatus {
    return { listening: !!this.bound, address: this.bound?.address ?? this.own?.address ?? null, npub: this.own?.npub ?? null, port: this.config.port, guard: this.guard, error: this.loadError ?? (this.config.enabled ? this.lastError : undefined) };
  }

  /**
   * Record the guard state. It takes effect for admission at once (principalFor checks it), and losing it
   * cuts every mesh connection and stops the listener, through the queue so it cannot race a bind.
   */
  setGuard(g: { active: boolean; ports: number[]; tun?: string; error?: string }, opts: { reloaded?: boolean } = {}): void {
    const prev = this.guard;
    // A real change of state, or any actual reload of the table by the helper (after a flush that went unnoticed,
    // a reload is exactly when queued forged handshakes must be discarded).
    const transition = prev.active !== g.active || (g.active && (!!opts.reloaded || prev.tun !== g.tun || prev.ports.join() !== g.ports.join()));
    this.guard = g;
    this.guardGen++;
    if (!transition) return; // the same confirmed guard: nothing to do
    // Losing the guard cuts every mesh connection and stops the listener. Getting it (back) starts the grace
    // window and closes and rebinds the listener, discarding any handshake that queued in the backlog while
    // it was missing. The rebind has its own counter, so unrelated guard updates cannot cancel it.
    if (g.active) this.guardSince = performance.now();
    else this.revalidate();
    const rebind = ++this.rebindGen;
    void this.serial(async () => {
      if (rebind !== this.rebindGen) return;
      if (this.server) this.close();
      if (this.guard.active) await this.reconcileNow();
    });
  }

  // --- canary --------------------------------------------------------------------------------------
  private canaryServer: net.Server | null = null;
  private proven = new WeakMap<Socket, Promise<Proof>>();
  /** Port of the canary listener on ::1 (0 until started). */
  canaryPort = 0;

  /** Listen on a private ::1 port whose connections the guard's canary rule resets. */
  startCanary(): Promise<number> {
    if (this.canaryServer) return Promise.resolve(this.canaryPort);
    return new Promise((resolve) => {
      const srv = net.createServer((c) => c.destroy());
      srv.on('error', () => resolve(0));
      srv.listen({ host: '::1', port: 0, ipv6Only: true }, () => { this.canaryServer = srv; this.canaryPort = (srv.address() as net.AddressInfo).port; resolve(this.canaryPort); });
    });
  }

  /** 'loaded' if our connection to the canary port is reset, 'missing' if it is accepted, 'unknown' otherwise. */
  private canary(): Promise<'loaded' | 'missing' | 'unknown'> {
    if (!this.canaryPort) return Promise.resolve('unknown');
    return new Promise((resolve) => {
      const s = net.connect({ host: '::1', port: this.canaryPort });
      const done = (v: 'loaded' | 'missing' | 'unknown') => { clearTimeout(t); s.destroy(); resolve(v); };
      const t = setTimeout(() => done('unknown'), 500);
      s.once('connect', () => done('missing'));
      s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'loaded' : 'unknown'));
    });
  }

  /**
   * Called for every fd00::/8 connection as the mesh listener accepts it: prove the guard was loaded
   * for its handshake. A connection that fails is destroyed at once and can never be admitted. Only a canary
   * that actually accepts (not a timeout) marks the guard lost.
   */
  proveOnAccept(socket: Socket): void {
    const acceptedAt = performance.now();
    const p = (async (): Promise<Proof> => {
      if (!this.guard.active || this.guard.tun !== this.tun) return 'retry';
      // The connection must have arrived on a port the loaded guard covers.
      if (!this.guard.ports.includes(socket.localPort ?? -1)) return 'fail';
      // A handshake that completed while the table was missing can be accepted just after it is re-loaded;
      // connections accepted within a second of a (re)load are answered "retry" instead of admitted.
      if (acceptedAt - this.guardSince < 1000) return 'retry';
      const r = await this.canary();
      if (r === 'missing' && this.guard.active) { this.setGuard({ active: false, ports: [], error: 'guard table missing (was the nftables ruleset flushed?)' }); this.onGuardLost(); }
      return r === 'loaded' ? 'ok' : 'fail';
    })();
    this.proven.set(socket, p);
    void p.then((r) => { if (r === 'fail') socket.destroy(); });
  }

  /** This connection's accept-time proof ('fail' for a connection that was never proven). */
  provenAtAccept(socket: Socket): Promise<Proof> { return this.proven.get(socket) ?? Promise.resolve('fail'); }

  onGuardLost: () => void = () => {};

  /** Called when the daemon reports a different TUN name, so the guard is re-applied for it. */
  onTunChange: () => void = () => {};

  /**
   * Whether the main listener must refuse fd00::/8 sources: while mesh access is on, and while access.json has
   * not loaded (it may turn mesh access on, so the main listener must not admit mesh sources meanwhile).
   */
  get meshSourcesReserved(): boolean { return this.config.enabled || !this.loaded; }

  /** Whether admission is possible at all right now (false while the guard or the node's identity is missing). */
  ready(): boolean { return this.config.enabled && this.guard.active && !!this.own && this.guard.tun === this.tun; }

  /**
   * The principal for a connection from a mesh (fd00::/8) source on the mesh listener, or null if it is not
   * admitted. When mesh access is disabled nobody is admitted from the mesh.
   */
  principalFor(remote: string | undefined): Principal | null {
    // Without the node's own identity the own address cannot be excluded, so nobody is admitted until it is known.
    if (!this.ready()) return null;
    const key = remote ? expand6(remote) : null;
    // This node's own addresses arrive over lo from any local process; they must never act as an npub.
    if (!key || key === expand6(this.own!.address) || localAddresses().has(key)) return null;
    const e = this.byAddress.get(key);
    if (!e || e.npub === this.own.npub) return null;
    return { kind: 'mesh', role: e.role, npub: e.npub, label: e.label, address: e.address };
  }

  /** Remember a connection admitted as `p`, so a later revocation or role change can cut it. */
  track(socket: Socket, p: Principal): void {
    if (p.kind !== 'mesh' || this.conns.has(socket)) return;
    this.conns.set(socket, `${p.npub}:${p.role}`);
    socket.once('close', () => this.conns.delete(socket));
  }

  /** Close every tracked connection whose grant no longer holds (removed, role changed, access disabled). */
  private revalidate(): void {
    for (const [socket, grant] of this.conns) {
      const p = this.principalFor(socket.remoteAddress);
      if (!p || p.kind !== 'mesh' || `${p.npub}:${p.role}` !== grant) { socket.destroy(); this.conns.delete(socket); }
    }
  }

  /** Names a browser may use for this node over the mesh: its fips0 address, <own npub>.fips, hosts-file aliases of it. */
  private ownNames = new Set<string>();
  hostAllowed(hostname: string | null): boolean {
    if (!hostname || !this.own) return false;
    if (hostname.endsWith('.fips')) return this.ownNames.has(hostname) || hostname === `${this.own.npub.toLowerCase()}.fips`;
    const e = expand6(hostname);
    return !!e && e === expand6(this.own.address);
  }

  /** Called after every successful load or save, inside the queue (keeps the firewall rule in step). */
  onChange: (cfg: AccessConfig) => Promise<unknown> = async () => {};

  start(): Promise<void> {
    setInterval(() => { void this.reconcile(); }, 15_000).unref();
    return this.serial(async () => { await this.loadNow(); await this.reconcileNow(); });
  }

  /** Load access.json. A missing file means "never configured"; any other failure is retried on every tick. */
  private async loadNow(): Promise<void> {
    if (this.loaded) return;
    try {
      const cfg = validateAccess(JSON.parse(await readFile(FILE, 'utf8')));
      this.byAddress = await this.buildMap(cfg);
      this.config = cfg;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        const msg = `cannot load ${FILE}: ${(e as Error).message}; mesh access is off until it loads`;
        if (msg !== this.loadError) console.warn(msg);
        this.loadError = msg;
        return;
      }
    }
    this.loaded = true; this.loadError = undefined;
    void this.onChange(this.config).catch(() => {});
  }

  /** Validate, derive addresses, persist, and only then put the new list into effect. */
  save(input: unknown): Promise<void> {
    return this.serial(async () => {
      if (!this.loaded) throw new AccessError(this.loadError ?? 'the saved access list has not loaded yet');
      const cfg = validateAccess(input);
      if (this.own && cfg.allowed.some((e) => e.npub === this.own!.npub)) throw new AccessError('this node\'s own npub cannot be on the list: any local user could use it to bypass the token');
      const map = await this.buildMap(cfg);
      await mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
      const tmp = `${FILE}.${process.pid}.tmp`;
      try { await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, FILE); }
      catch (e) { await unlink(tmp).catch(() => {}); throw new Error(`cannot write ${FILE}: ${(e as Error).message}`); }
      const rebind = !cfg.enabled || (this.bound !== null && this.bound.port !== cfg.port);
      this.config = cfg;
      this.byAddress = map;
      this.revalidate();
      if (rebind) this.close();
      await this.reconcileNow();
      void this.onChange(cfg).catch(() => {});
    });
  }

  private async buildMap(cfg: AccessConfig): Promise<Map<string, Entry>> {
    const resolved = await Promise.all(cfg.allowed.map(async (e) => ({ ...e, address: await meshAddress(e.npub) })));
    const map = new Map<string, Entry>();
    for (const e of resolved) { const key = expand6(e.address); if (key) map.set(key, e); }
    return map;
  }

  close(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.bound = null;
  }

  /** Bind (or re-bind) the mesh listener to the current fips0 address; tear it down when disabled. */
  reconcile(): Promise<void> { return this.serial(() => this.reconcileNow()); }

  private async reconcileNow(): Promise<void> {
    await this.loadNow();
    if (!this.config.enabled) { if (this.server) this.close(); this.lastError = undefined; return; }
    try {
      const st = await query<{ ipv6_addr?: string; npub?: string; tun_name?: string }>('show_status', undefined, { timeoutMs: 3000 });
      if (st.ipv6_addr && st.npub) {
        this.own = { address: st.ipv6_addr, npub: st.npub };
        const hosts = await readHosts().catch(() => ({ entries: [] as { hostname: string; npub: string }[] }));
        this.ownNames = new Set(hosts.entries.filter((h) => h.npub === st.npub).map((h) => `${h.hostname.toLowerCase()}.fips`));
      }
      if (st.tun_name && st.tun_name !== this.tun) {
        this.tun = st.tun_name;
        // The loaded guard exempts the old interface: stop admitting until it is re-applied for the new one.
        this.setGuard({ active: false, ports: [], error: `waiting for the guard for ${st.tun_name}` });
        this.onTunChange();
      }
    } catch (e) {
      if (!this.own) { this.lastError = `daemon unreachable: ${(e as Error).message}`; return; }
    }
    if (!this.own) { this.lastError = 'the daemon did not report a fips0 address'; return; }
    if (!this.guard.active || !this.guard.ports.includes(this.config.port)) { if (this.server) this.close(); this.lastError = `waiting for the spoofing guard${this.guard.error ? `: ${this.guard.error}` : ''}`; return; }
    const want = { address: this.own.address, port: this.config.port };
    if (this.bound && this.bound.address === want.address && this.bound.port === want.port) return;
    if (this.server) this.close();
    const server = http.createServer(this.handler);
    server.on('connection', (sock: Socket) => { if (isMeshSource(sock.remoteAddress)) this.proveOnAccept(sock); });
    await new Promise<void>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.lastError = e.code === 'EADDRNOTAVAIL' ? `fips0 address ${want.address} is not configured yet` : e.code === 'EADDRINUSE' ? `port ${want.port} is already in use on ${want.address}` : `${e.code ?? 'error'}: ${e.message}`;
        resolve();
      });
      server.listen({ host: want.address, port: want.port, ipv6Only: true }, () => {
        this.server = server; this.bound = want; this.lastError = undefined;
        console.log(`mesh access listening on http://[${want.address}]:${want.port} for ${this.config.allowed.length} npub(s)`);
        resolve();
      });
    });
  }
}
