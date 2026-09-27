// "Web UI over the mesh" settings, shared by the Access card and the hosts table (both can change the allowed
// list), refreshed every 10 seconds while in use and right after every save.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Principal } from './types';

export type Role = 'viewer' | 'admin';
export interface AccessEntry { npub: string; label?: string; role: Role }
export interface AccessConfig { enabled: boolean; port: number; allowed: AccessEntry[] }
export interface AccessStatus { listening: boolean; address: string | null; npub: string | null; port: number; guard?: { active: boolean; ports: number[]; error?: string }; error?: string }
export interface AccessData { config?: AccessConfig; status?: AccessStatus; file?: string; you: Principal; firewallManaged?: boolean; helperVersion?: number | null; guardHelperVersion?: number }
export interface AccessSaveResult { config: AccessConfig; status: AccessStatus; firewall: { ok: boolean; skipped?: string; guard?: string; rule?: string } }

let data: AccessData | null = null;
let loadError: string | null = null;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const emit = () => subs.forEach((f) => f());

export function refreshAccess(): Promise<void> {
  return api.get<AccessData>('/api/access').then((d) => { data = d; loadError = null; emit(); }, (e: Error) => { loadError = e.message; emit(); });
}

function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) { void refreshAccess(); timer = setInterval(() => void refreshAccess(), 10_000); }
  return () => { subs.delete(f); if (subs.size === 0 && timer) { clearInterval(timer); timer = undefined; } };
}

export function useAccess(): { data: AccessData | null; error: string | null } {
  return { data: useSyncExternalStore(subscribe, () => data), error: useSyncExternalStore(subscribe, () => loadError) };
}

/** Save a whole configuration and publish the result to every user of the store. */
export async function saveAccess(cfg: AccessConfig): Promise<AccessSaveResult> {
  const res = await api.post<AccessSaveResult>('/api/access', cfg);
  if (data) { data = { ...data, config: res.config, status: res.status }; emit(); }
  void refreshAccess();
  return res;
}

/** A save's outcome for a toast. */
export function saveMessage(res: AccessSaveResult): { tone: 'ok' | 'info'; text: string } {
  return res.firewall.ok
    ? { tone: 'ok', text: 'Access saved; guard and firewall rule updated' }
    : { tone: 'info', text: `Access saved; ${res.firewall.skipped ?? res.firewall.guard ?? res.firewall.rule ?? 'not fully applied yet'}` };
}
