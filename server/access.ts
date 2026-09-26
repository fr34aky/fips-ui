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
// the FIPS TUN device. Every packet is checked, the handshake included. fd00::/8 sources are trusted as
// npubs only while that guard is confirmed active; without it nobody is admitted from the mesh.

import http from 'node:http';
import type { Socket } from 'node:net';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expand6 } from './net6.ts';
import { query } from './control.ts';
import { meshAddress, NPUB_RE } from './admin.ts';

export type Role = 'viewer' | 'admin';
export interface AccessEntry { npub: string; label?: string; role: Role }
export interface AccessConfig { enabled: boolean; port: number; allowed: AccessEntry[] }
export type Principal =
  | { kind: 'local'; role: 'admin' }
  | { kind: 'mesh'; role: Role; npub: string; label?: string; address: string };

export const LOCAL: Principal = { kind: 'local', role: 'admin' };
const FILE = process.env.FIPS_UI_ACCESS_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'access.json');

export class AccessError extends Error {}

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
  guard: { active: boolean; ports: number[]; error?: string } = { active: false, ports: [] };
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

  /** Record the guard state; losing it cuts every mesh connection and stops the listener until it is back. */
  setGuard(g: { active: boolean; ports: number[]; error?: string }): void {
    this.guard = g;
    if (!g.active) { this.revalidate(); if (this.server) this.close(); }
  }

  /**
   * The principal for a connection from a mesh (fd00::/8) source, on any listener, or null if it is not
   * admitted. When mesh access is disabled nobody is admitted from the mesh.
   */
  principalFor(remote: string | undefined): Principal | null {
    if (!this.config.enabled || !this.guard.active) return null;
    const key = remote ? expand6(remote) : null;
    const e = key ? this.byAddress.get(key) : undefined;
    return e ? { kind: 'mesh', role: e.role, npub: e.npub, label: e.label, address: e.address } : null;
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

  /** Host names a browser may use to reach this node over the mesh: its fips0 address or any .fips name. */
  hostAllowed(hostname: string | null): boolean {
    if (!hostname) return false;
    if (hostname.endsWith('.fips')) return true;
    const e = expand6(hostname);
    return !!e && !!this.own && e === expand6(this.own.address);
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
      if (st.ipv6_addr && st.npub) this.own = { address: st.ipv6_addr, npub: st.npub };
      if (st.tun_name) this.tun = st.tun_name;
    } catch (e) {
      if (!this.own) { this.lastError = `daemon unreachable: ${(e as Error).message}`; return; }
    }
    if (!this.own) { this.lastError = 'the daemon did not report a fips0 address'; return; }
    if (!this.guard.active || !this.guard.ports.includes(this.config.port)) { if (this.server) this.close(); this.lastError = `waiting for the spoofing guard${this.guard.error ? `: ${this.guard.error}` : ''}`; return; }
    const want = { address: this.own.address, port: this.config.port };
    if (this.bound && this.bound.address === want.address && this.bound.port === want.port) return;
    if (this.server) this.close();
    const server = http.createServer(this.handler);
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
