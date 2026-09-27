// New fips-ui releases: one shared copy of the server's check, refreshed every 30 minutes while in use (the server
// itself asks GitHub at most every 6 hours unless an admin forces it).
import { useSyncExternalStore } from 'react';
import { api } from './api';

export interface UiRelease { tag: string; version: string; url: string; publishedAt: string; notes: string }
export interface UiUpdateJob { tag: string; state: 'running' | 'done' | 'failed'; startedAt: number; finishedAt?: number; log: string[]; error?: string; restarting?: boolean }
export interface UiUpdateInfo {
  current: string; latest: UiRelease | null; newer: boolean; checkedAt: number; error?: string;
  // Admins only:
  job?: UiUpdateJob | null;
  install?: { mode: 'git' | 'manual'; reason?: string; branch?: string };
  canRestart?: boolean;
  helper?: { installed: number | null; shipped: number | null };
}

let data: UiUpdateInfo | null = null;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const emit = () => subs.forEach((f) => f());

export function refreshUiUpdate(force = false): Promise<UiUpdateInfo | null> {
  return api.get<UiUpdateInfo>(`/api/ui-update${force ? '?refresh=1' : ''}`).then((d) => { data = d; emit(); return d; }, () => null);
}

function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) { void refreshUiUpdate(); timer = setInterval(() => void refreshUiUpdate(), 30 * 60_000); }
  return () => { subs.delete(f); if (subs.size === 0 && timer) { clearInterval(timer); timer = undefined; } };
}

export const useUiUpdate = (): UiUpdateInfo | null => useSyncExternalStore(subscribe, () => data);
