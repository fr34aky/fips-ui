// Remote access to the web UI over the mesh, authorised by npub.
//
// FIPS reconstructs the IPv6 header of every packet it delivers to fips0 from the authenticated end-to-end
// session (docs/design/fips-ipv6-adapter.md upstream), so the source address of a connection that arrives
// through the mesh is the fd00::/8 address derived from the sender's npub. The UI therefore needs no
// login over the mesh: it compares the peer address with the derived addresses of the allowed npubs.
//
// The mesh listener binds only to this node's fips0 address. A packet with a forged fd00::/8 source that
// arrives on another interface cannot complete a TCP handshake, because the reply is routed into the mesh
// to the real owner of that address; the firewall rule this module maintains is a second layer.
import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isIPv6 } from 'node:net';
import { query } from './control.ts';
import { meshAddress } from './admin.ts';

export type Role = 'viewer' | 'admin';
export interface AccessEntry { npub: string; label?: string; role: Role }
export interface AccessConfig { enabled: boolean; port: number; allowed: AccessEntry[] }
export type Principal =
  | { kind: 'local'; role: 'admin' }
  | { kind: 'mesh'; role: Role; npub: string; label?: string; address: string };

export const LOCAL: Principal = { kind: 'local', role: 'admin' };
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;
const FILE = process.env.FIPS_UI_ACCESS_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'access.json');

export class AccessError extends Error {}

/** Full, lowercase, zero-padded form of an IPv6 address so textual variants compare equal. */
export function expand6(addr: string): string | null {
  const a = addr.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (!isIPv6(a) || a.includes('.')) return null;
  const [head, tail] = a.includes('::') ? a.split('::') : [a, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')).join(':') : null;
}

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

export interface MeshStatus { listening: boolean; address: string | null; npub: string | null; port: number; error?: string }

export class MeshAccess {
  config: AccessConfig = { enabled: false, port: 8321, allowed: [] };
  private byAddress = new Map<string, AccessEntry & { address: string }>();
  private server: http.Server | null = null;
  private bound: { address: string; port: number } | null = null;
  private own: { address: string; npub: string } | null = null;
  private lastError: string | undefined;
  private reconciling: Promise<void> | null = null;
  private readonly handler: http.RequestListener;

  constructor(handler: http.RequestListener) { this.handler = handler; }

  get file(): string { return FILE; }

  status(): MeshStatus {
    return { listening: !!this.bound, address: this.bound?.address ?? this.own?.address ?? null, npub: this.own?.npub ?? null, port: this.config.port, error: this.config.enabled ? this.lastError : undefined };
  }

  /** The principal for a connection that arrived on the mesh listener, or null if its address is not allowed. */
  principalFor(remote: string | undefined): Principal | null {
    const key = remote ? expand6(remote) : null;
    const e = key ? this.byAddress.get(key) : undefined;
    return e ? { kind: 'mesh', role: e.role, npub: e.npub, label: e.label, address: e.address } : null;
  }

  /** Host names a browser may use to reach the mesh listener: this node's fips0 address or any .fips name. */
  hostAllowed(hostname: string | null): boolean {
    if (!hostname) return false;
    if (hostname.endsWith('.fips')) return true;
    const e = expand6(hostname);
    return !!e && !!this.own && e === expand6(this.own.address);
  }

  async start(): Promise<void> {
    try { this.config = validateAccess(JSON.parse(await readFile(FILE, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`ignoring ${FILE}: ${(e as Error).message}`); }
    await this.remap().catch((e) => { this.lastError = (e as Error).message; });
    await this.reconcile();
    setInterval(() => { void this.reconcile(); }, 15_000).unref();
  }

  async save(next: AccessConfig): Promise<void> {
    const cfg = validateAccess(next);
    const previous = this.config;
    this.config = cfg;
    try { await this.remap(); }
    catch (e) { this.config = previous; await this.remap().catch(() => {}); throw e; }
    await mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, FILE);
    this.bound && (this.bound.port !== cfg.port || !cfg.enabled) && this.close();
    await this.reconcile();
  }

  private async remap(): Promise<void> {
    const map = new Map<string, AccessEntry & { address: string }>();
    for (const e of this.config.allowed) {
      const address = await meshAddress(e.npub);
      const key = expand6(address);
      if (key) map.set(key, { ...e, address });
    }
    this.byAddress = map;
  }

  private close(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.bound = null;
  }

  /** Bind (or re-bind) the mesh listener to the current fips0 address; tear it down when disabled. */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      if (!this.config.enabled) { if (this.server) this.close(); this.lastError = undefined; return; }
      try {
        const st = await query<{ ipv6_addr?: string; npub?: string }>('show_status', undefined, { timeoutMs: 3000 });
        if (st.ipv6_addr && st.npub) this.own = { address: st.ipv6_addr, npub: st.npub };
      } catch (e) {
        if (!this.own) { this.lastError = `daemon unreachable: ${(e as Error).message}`; return; }
      }
      if (!this.own) { this.lastError = 'the daemon did not report a fips0 address'; return; }
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
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  close_all(): void { this.close(); }
}
