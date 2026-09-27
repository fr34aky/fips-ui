// On a master: which nodes fetch this node's hosts list with "Sync names from a master node". A follower's
// request comes in over the mesh listener, so its npub is known; it identifies itself as a sync (header
// x-fips-ui-sync, or for followers before that header, a plain "node" user agent instead of a browser's).
import type { IncomingMessage } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FILE = process.env.FIPS_UI_HOSTS_FOLLOWERS_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'hosts-followers.json');

export interface Follower {
  npub: string; address: string;
  firstSeen: number; lastSeen: number; count: number;
  /** Names served on the last fetch. */
  entries: number;
  /** What the follower reports: its fips-ui version and sync interval (minutes), when it sends them. */
  version?: string; intervalMin?: number;
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
  private map = new Map<string, Follower>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  private load(): Promise<void> {
    // A missing, truncated or hand-edited file just starts an empty list.
    this.loaded ??= readFile(FILE, 'utf8').then((t) => {
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
      await mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
      const tmp = `${FILE}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, FILE);
    }).catch(() => {});
  }

  async record(npub: string, address: string, entries: number, info: { version?: string; intervalMin?: number }): Promise<void> {
    await this.load();
    const now = Date.now();
    const prev = this.map.get(npub);
    this.map.set(npub, { npub, address, firstSeen: prev?.firstSeen ?? now, lastSeen: now, count: (prev?.count ?? 0) + 1, entries, version: info.version ?? prev?.version, intervalMin: info.intervalMin ?? prev?.intervalMin });
    this.persist();
  }

  async list(): Promise<Follower[]> { await this.load(); return [...this.map.values()].sort((a, b) => b.lastSeen - a.lastSeen); }

  async forget(npub: string): Promise<boolean> {
    await this.load();
    const had = this.map.delete(npub);
    if (had) this.persist();
    return had;
  }
}
