// Follow a master node's hosts file over the mesh. The follower fetches the master's /api/hosts from the master's
// fips0 address: FIPS delivers packets for that address only to the master's npub, so the list is authentic, and
// the master admits the follower by its npub (a viewer in its "Web UI over the mesh" list). The names go into the
// synced block of the local hosts file (server/hosts.ts), which only changes when the list does.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOSTNAME_RE, readHosts, renderSync, type HostEntry } from './hosts.ts';

const FILE = process.env.FIPS_UI_HOSTS_SYNC_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'hosts-sync.json');
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;
const MAX_ENTRIES = 2000;
/** While the master is unreachable (or refuses this node), automatic attempts drop to once a day. */
const OFFLINE_RETRY_MS = 24 * 60 * 60_000;

export interface SyncConfig { enabled: boolean; master: string; port: number; intervalMin: number }
export interface SyncStatus {
  running: boolean;
  lastAttempt?: number; lastSuccess?: number; lastChange?: number;
  /** Entries taken from the master on the last successful sync, and invalid ones left out. */
  received?: number; skipped?: number;
  error?: string;
  /** Since when the master has been unreachable or refusing this node (automatic syncs then run once a day). */
  unreachableSince?: number;
  /** When the next automatic sync is due. */
  nextAttempt?: number;
}
export class SyncError extends Error {
  /** 'offline': the master could not be reached or refused this node; retried once a day unless synced by hand. */
  kind: 'offline' | 'other';
  constructor(message: string, kind: 'offline' | 'other' = 'other') { super(message); this.kind = kind; }
}

export interface SyncDeps {
  /** This node's npub (a node cannot follow itself). */
  ownNpub: () => Promise<string | undefined>;
  /** The fips0 address derived from an npub. */
  meshAddress: (npub: string) => Promise<string>;
  /** Write the whole hosts file; `base` is the hash of the file it was built from. */
  write: (content: string, base: string) => Promise<void>;
  /** A name for the master to put in the block header, if known. */
  label: (npub: string) => Promise<string | undefined>;
}

export function validateSyncConfig(input: unknown): SyncConfig {
  const x = input as Partial<SyncConfig>;
  if (typeof x?.enabled !== 'boolean') throw new SyncError('enabled must be a boolean');
  const master = String(x.master ?? '').trim();
  if (x.enabled && !NPUB_RE.test(master)) throw new SyncError('master must be an npub');
  const port = Number(x.port ?? 8321);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SyncError('port must be an integer between 1 and 65535');
  const intervalMin = Number(x.intervalMin ?? 5);
  if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 1440) throw new SyncError('intervalMin must be between 1 and 1440 minutes');
  return { enabled: x.enabled, master, port, intervalMin };
}

export class HostsSync {
  config: SyncConfig = { enabled: false, master: '', port: 8321, intervalMin: 5 };
  status: SyncStatus = { running: false };
  private readonly deps: SyncDeps;
  private timer: NodeJS.Timeout | null = null;
  /** Syncs, saves and removals run one at a time, in order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by every save: a sync started under an older configuration does not write. */
  private gen = 0;
  /** Turning sync off could not remove the synced names yet; retried every minute. */
  private pendingRemoval = false;

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  constructor(deps: SyncDeps) { this.deps = deps; }

  get file(): string { return FILE; }

  async start(): Promise<void> {
    try { this.config = validateSyncConfig(JSON.parse(await readFile(FILE, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.status.error = `cannot load ${FILE}: ${(e as Error).message}`; }
    // Check once a minute whether a sync is due (every intervalMin, or once a day while the master is offline).
    this.timer = setInterval(() => {
      if (this.config.enabled ? Date.now() >= (this.status.nextAttempt ?? 0) : this.pendingRemoval) void this.run();
    }, 60_000);
    this.timer.unref();
    if (this.config.enabled) void this.run();
  }

  /** Persist a new configuration, then sync at once (or remove the synced names when turned off). */
  async save(input: unknown): Promise<SyncStatus> {
    const cfg = validateSyncConfig(input);
    if (cfg.enabled && cfg.master === (await this.deps.ownNpub())) throw new SyncError('this node cannot follow itself');
    // Queued behind a sync in flight, which then no longer writes (the generation changes first).
    this.gen++;
    return this.serial(() => this.apply(cfg));
  }

  private async apply(cfg: SyncConfig): Promise<SyncStatus> {
    await mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.${process.pid}.tmp`;
    try { await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, FILE); }
    catch (e) { await unlink(tmp).catch(() => {}); throw new Error(`cannot write ${FILE}: ${(e as Error).message}`); }
    this.config = cfg;
    this.status = { running: false };
    this.pendingRemoval = !cfg.enabled;
    if (cfg.enabled) await this.syncNow();
    else await this.removeBlock();
    return this.status;
  }

  /**
   * Fetch the master's list and update the synced block if it changed. Never throws; the outcome is in status.
   * Called by the timer when due and by "Sync now", which always tries at once. The synced names stay in the
   * hosts file while the master is offline.
   */
  async run(): Promise<SyncStatus> {
    if (this.status.running) return this.status;
    if (!this.config.enabled) return this.pendingRemoval ? this.serial(async () => { await this.removeBlock(); return this.status; }) : this.status;
    return this.serial(() => this.syncNow());
  }

  private async syncNow(): Promise<SyncStatus> {
    if (!this.config.enabled) return this.status;
    const { master, port } = this.config;
    const gen = this.gen;
    this.status = { ...this.status, running: true, lastAttempt: Date.now() };
    try {
      const entries = await this.fetchMaster(master, port);
      const cur = await readHosts();
      if (cur.error) throw new SyncError(`cannot read ${cur.path}: ${cur.error}`);
      const content = renderSync(cur.raw, master, await this.deps.label(master).catch(() => undefined), entries.valid);
      if (gen !== this.gen) return this.status; // the configuration changed while fetching: the new one decides
      if (content !== cur.raw) { await this.deps.write(content, cur.base); this.status.lastChange = Date.now(); }
      this.status = { ...this.status, lastSuccess: Date.now(), received: entries.valid.length, skipped: entries.skipped, error: undefined, unreachableSince: undefined, nextAttempt: Date.now() + this.config.intervalMin * 60_000 };
    } catch (e) {
      const offline = e instanceof SyncError && e.kind === 'offline';
      this.status = {
        ...this.status, error: (e as Error).message,
        unreachableSince: offline ? (this.status.unreachableSince ?? Date.now()) : undefined,
        nextAttempt: Date.now() + (offline ? OFFLINE_RETRY_MS : this.config.intervalMin * 60_000),
      };
    } finally {
      this.status = { ...this.status, running: false };
    }
    return this.status;
  }

  private async fetchMaster(master: string, port: number): Promise<{ valid: { hostname: string; npub: string }[]; skipped: number }> {
    const addr = await this.deps.meshAddress(master).catch((e: Error) => { throw new SyncError(`cannot derive the master's address: ${e.message}`); });
    const url = `http://[${addr}]:${port}/api/hosts`;
    let res: Response;
    try { res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); }
    catch (e) { throw new SyncError(`cannot reach the master at [${addr}]:${port} (${(e as Error).cause ? String(((e as Error).cause as Error).message ?? (e as Error).cause) : (e as Error).message}); is it online with "Web UI over the mesh" enabled on that port? Retrying once a day, or use Sync now`, 'offline'); }
    const body = await res.json().catch(() => null) as { entries?: HostEntry[]; error?: string } | null;
    if (res.status === 403) {
      const own = await this.deps.ownNpub().catch(() => undefined);
      throw new SyncError(`the master refused this node${body?.error ? ` (${body.error})` : ''}: on the master, add ${own ?? "this node's npub"} as a viewer under Access → Web UI over the mesh, then use Sync now`, 'offline');
    }
    // 503: the master's mesh listener is up but not ready (guard reloading, identity unknown): a normal retry.
    if (!res.ok || !Array.isArray(body?.entries)) throw new SyncError(`the master answered ${res.status}${body?.error ? `: ${body.error}` : ''}`);
    // A master that cannot read its own hosts file answers with no entries and an error: never take that as
    // "no names" (it would remove every synced name on every follower).
    if (body.error) throw new SyncError(`the master cannot read its hosts file (${body.error}); keeping the names synced last`);
    // Only well-formed entries are taken (the same rules as the editor); the last one wins on a duplicate name.
    const byName = new Map<string, string>();
    let skipped = 0;
    for (const e of body.entries.slice(0, MAX_ENTRIES)) {
      const hostname = String(e?.hostname ?? '').toLowerCase();
      const npub = String(e?.npub ?? '');
      if (!HOSTNAME_RE.test(hostname) || !NPUB_RE.test(npub)) { skipped++; continue; }
      byName.delete(hostname); byName.set(hostname, npub);
    }
    skipped += Math.max(0, body.entries.length - MAX_ENTRIES);
    return { valid: [...byName].map(([hostname, npub]) => ({ hostname, npub })), skipped };
  }

  /** Turned off: remove the synced names from the hosts file. */
  private async removeBlock(): Promise<void> {
    try {
      const cur = await readHosts();
      if (cur.error) throw new Error(`cannot read ${cur.path}: ${cur.error}`);
      if (cur.synced) { await this.deps.write(renderSync(cur.raw, cur.synced.master, undefined, null), cur.base); this.status.lastChange = Date.now(); }
      this.pendingRemoval = false;
      this.status.error = undefined;
    } catch (e) { this.status.error = `could not remove the synced names (retried every minute): ${(e as Error).message}`; }
  }

  close(): void { if (this.timer) clearInterval(this.timer); }
}
