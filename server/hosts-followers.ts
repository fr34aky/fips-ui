// On a master: which nodes fetch this node's hosts list with "Sync names from a master node". A follower's
// request comes in over the mesh listener, so its npub is known; it identifies itself as a sync (header
// x-fips-ui-sync, or for followers before that header, a plain "node" user agent instead of a browser's).
import type { IncomingMessage } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FILE = process.env.FIPS_UI_HOSTS_FOLLOWERS_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'hosts-followers.json');
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;

/**
 * The sync tree below a follower: every node that syncs from it, directly or further down, as each node reports
 * its own followers upward with its sync (header x-fips-ui-subtree, see subtreeHeader). Informational only: a
 * node describes its own subtree, so nothing is granted or changed because of it.
 */
export interface SubNode { npub: string; parent: string }

/**
 * A node's place in the sync tree: the master node is the origin of the names (others sync from it, it syncs from
 * no one), a distribution node syncs from another node and is synced from in turn, a follower only syncs.
 */
export type SyncRole = 'master' | 'distribution' | 'follower' | 'none';
export function syncRole(syncing: boolean, activeFollowers: number): SyncRole {
  return syncing ? (activeFollowers > 0 ? 'distribution' : 'follower') : activeFollowers > 0 ? 'master' : 'none';
}
/** Nodes reported in one subtree at most (the header stays under ~9 KB); the rest is only counted. */
export const MAX_SUBTREE = 128;
/** Depth below a follower, like the chain of masters upward (server/hosts-sync.ts MAX_CHAIN). */
const MAX_DEPTH = 16;

export interface Follower {
  npub: string; address: string;
  firstSeen: number; lastSeen: number; count: number;
  /** Names served on the last fetch. */
  entries: number;
  /** What the follower reports: its fips-ui version and sync interval (minutes), when it sends them. */
  version?: string; intervalMin?: number;
  /** The nodes syncing below this follower, as it reported them on its last sync (absent: an older fips-ui). */
  below?: SubNode[];
  /** Nodes below it that did not fit into its report. */
  belowMore?: number;
}

/**
 * Parse a follower's x-fips-ui-subtree header: comma-separated "<npub>.<parent>" with <parent> "-" for the
 * follower itself or the index of an earlier item (so parents come first and there are no cycles), and an optional
 * final "+<n>" for nodes left out. Invalid items (and their descendants) are dropped, as are the follower, this
 * node and repeats.
 */
export function parseSubtree(header: unknown, follower: string, own?: string): { below: SubNode[]; more: number } | undefined {
  if (typeof header !== 'string') return undefined;
  const below: SubNode[] = []; let more = 0;
  const kept: (string | null)[] = []; const depth = new Map<string, number>([[follower, 0]]);
  const seen = new Set<string>([follower, ...(own ? [own] : [])]);
  for (const item of header.split(',').slice(0, MAX_SUBTREE + 1)) {
    const t = item.trim();
    if (!t) continue;
    const m = /^\+(\d{1,6})$/.exec(t);
    if (m) { more = Number(m[1]); continue; }
    const [npub, ref] = t.split('.');
    const parent = ref === '-' ? follower : /^\d{1,3}$/.test(ref ?? '') && Number(ref) < kept.length ? kept[Number(ref)] : null;
    const d = parent ? (depth.get(parent) ?? MAX_DEPTH) + 1 : MAX_DEPTH + 1;
    if (!NPUB_RE.test(npub ?? '') || !parent || seen.has(npub) || d > MAX_DEPTH || below.length >= MAX_SUBTREE) { kept.push(null); continue; }
    seen.add(npub); depth.set(npub, d); kept.push(npub);
    below.push({ npub, parent });
  }
  return { below, more };
}


/** Whether a request is a follower's sync rather than a browser: the sync header, or a non-browser node client. */
export function isSyncRequest(req: IncomingMessage): { version?: string; intervalMin?: number } | null {
  const h = req.headers['x-fips-ui-sync'];
  if (typeof h === 'string') {
    const kv = Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((x) => x.length === 2)) as Record<string, string>;
    const n = Number(kv.interval);
    return { version: /^[0-9A-Za-z.+-]{1,32}$/.test(kv.version ?? '') ? kv.version : undefined, intervalMin: Number.isInteger(n) && n > 0 && n <= 1440 ? n : undefined };
  }
  const ua = String(req.headers['user-agent'] ?? '');
  return ua === 'node' || ua.startsWith('undici') ? {} : null;
}

export class HostsFollowers {
  private readonly file: string;
  private map = new Map<string, Follower>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(file = FILE) { this.file = file; }

  private load(): Promise<void> {
    // A missing, truncated or hand-edited file just starts an empty list.
    this.loaded ??= readFile(this.file, 'utf8').then((t) => {
      try {
        const list = JSON.parse(t) as unknown;
        if (Array.isArray(list)) for (const f of list as Follower[]) if (f && typeof f.npub === 'string' && typeof f.lastSeen === 'number') this.map.set(f.npub, f);
      } catch { /* start empty */ }
    }, () => {});
    return this.loaded;
  }

  private persist(): void {
    const data = JSON.stringify([...this.map.values()]);
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, this.file);
    }).catch(() => {});
  }

  async record(npub: string, address: string, entries: number, info: { version?: string; intervalMin?: number }, subtree?: { below: SubNode[]; more: number }): Promise<void> {
    await this.load();
    const now = Date.now();
    const prev = this.map.get(npub);
    this.map.set(npub, {
      npub, address, firstSeen: prev?.firstSeen ?? now, lastSeen: now, count: (prev?.count ?? 0) + 1, entries, version: info.version ?? prev?.version, intervalMin: info.intervalMin ?? prev?.intervalMin,
      // Each sync replaces the report; a follower that stops sending one (downgraded) has no known subtree.
      ...(subtree ? { below: subtree.below, ...(subtree.more ? { belowMore: subtree.more } : {}) } : {}),
    });
    this.persist();
  }

  /** Whether a follower still syncs: seen within three of its intervals (5 minutes when it does not report one). */
  static active(f: Follower, now = Date.now()): boolean { return now - f.lastSeen <= 3 * (f.intervalMin ?? 5) * 60_000; }

  /**
   * This node's report to its own master: its active followers ("<npub>.-") and what they reported below them,
   * parents first, at most MAX_SUBTREE nodes and a "+<n>" for the rest. Followers that stopped syncing drop out,
   * and with them everything they reported.
   */
  async subtreeHeader(now = Date.now()): Promise<string> {
    await this.load();
    const out: string[] = []; const index = new Map<string, number>(); let more = 0;
    const add = (npub: string, parent: string | null) => {
      if (index.has(npub)) return;
      if (out.length >= MAX_SUBTREE) { more++; return; }
      const ref = parent === null ? '-' : index.get(parent);
      if (ref === undefined) { more++; return; }
      index.set(npub, out.length); out.push(`${npub}.${ref}`);
    };
    const active = [...this.map.values()].filter((f) => HostsFollowers.active(f, now)).sort((a, b) => a.firstSeen - b.firstSeen);
    for (const f of active) add(f.npub, null);
    for (const f of active) { for (const n of f.below ?? []) add(n.npub, n.parent); more += f.belowMore ?? 0; }
    return [...out, ...(more ? [`+${more}`] : [])].join(',');
  }

  /** How many followers still sync (see active). */
  async activeCount(now = Date.now()): Promise<number> { await this.load(); return [...this.map.values()].filter((f) => HostsFollowers.active(f, now)).length; }

  async list(): Promise<Follower[]> { await this.load(); return [...this.map.values()].sort((a, b) => b.lastSeen - a.lastSeen); }

  async forget(npub: string): Promise<boolean> {
    await this.load();
    const had = this.map.delete(npub);
    if (had) this.persist();
    return had;
  }
}
