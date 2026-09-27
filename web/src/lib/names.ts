// Clear names for npubs, from the FIPS hosts file (the daemon's own source for <name>.fips). One shared copy,
// refreshed every minute while any component uses it and right after the file is saved.
import { useSyncExternalStore } from 'react';
import { api } from './api';

export interface HostEntry { hostname: string; npub: string; comment?: string }
export interface HostsData {
  path: string; base: string; error?: string;
  /** Every name the daemon resolves (the last entry wins on a duplicate). */
  entries: HostEntry[];
  /** This node's own entries, which the editor changes. */
  local?: HostEntry[];
  /** Names synced from a master node, if this node follows one. */
  synced?: { master: string; entries: HostEntry[] } | null;
  /** Present for admins: whether and how this UI can write the file. */
  write?: { mode: 'helper' | 'direct' | null; hint: string };
}

let data: HostsData | null = null;
let loadError: string | null = null;
let byNpub = new Map<string, string>();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<HostsData | null> | null = null;

function publish(d: HostsData) {
  data = d; loadError = null;
  // With several names for one npub the first in the file is shown.
  byNpub = new Map();
  for (const e of d.entries) if (!byNpub.has(e.npub)) byNpub.set(e.npub, e.hostname);
  subs.forEach((f) => f());
}

export function refreshHosts(): Promise<HostsData | null> {
  inflight ??= api.get<HostsData>('/api/hosts')
    .then((d) => { publish(d); return d; })
    .catch((e: Error) => { loadError = e.message; subs.forEach((f) => f()); return null; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Put a saved file's state in place without another request. */
export function setHosts(d: HostsData) { publish({ ...data, ...d }); }

function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) { void refreshHosts(); timer = setInterval(() => void refreshHosts(), 60_000); }
  return () => { subs.delete(f); if (subs.size === 0 && timer) { clearInterval(timer); timer = undefined; } };
}

export function useHosts(): { data: HostsData | null; error: string | null } {
  const d = useSyncExternalStore(subscribe, () => data);
  const e = useSyncExternalStore(subscribe, () => loadError);
  return { data: d, error: e };
}

/** The hosts-file name for an npub, if it has one. */
export function useHostName(npub: string | null | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () => (npub ? byNpub.get(npub) : undefined));
}

/** Lookup for components that already subscribe through useHosts(). */
export function hostNameOf(npub: string | null | undefined): string | undefined { return npub ? byNpub.get(npub) : undefined; }

/**
 * A display name that is a real name: the daemon labels peers without one by a shortened npub
 * ("npub1pr5e...e4l9"), which is not a name.
 */
export function realName(name: string | null | undefined): string | undefined {
  return name && !/^npub1[0-9a-z]*(\.\.\.|…)[0-9a-z]*$/.test(name) ? name : undefined;
}
