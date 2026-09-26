import { useEffect, useRef, useState, useSyncExternalStore, useCallback } from 'react';
import type { Snapshot, LogLine, Health } from './types';

const TOKEN_KEY = 'fips-ui-token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const tok = getToken();
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  if (init?.method && init.method !== 'GET') headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    if (res.status === 401) authStore.setNeeded(true);
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  q: <T,>(command: string, params?: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    return request<T>(`/api/q/${command}${s ? `?${s}` : ''}`);
  },
  health: () => request<Health>('/api/health'),
};

// ------------------------------------------------------------- auth store
const authStore = (() => {
  let needed = false;
  const subs = new Set<() => void>();
  return {
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    get: () => needed,
    setNeeded: (v: boolean) => { if (needed !== v) { needed = v; subs.forEach((f) => f()); } },
  };
})();
export const useAuthNeeded = () => useSyncExternalStore(authStore.subscribe, authStore.get);
export const setAuthNeeded = authStore.setNeeded;

// ------------------------------------------------------------- live store (SSE)
export type ConnState = 'connecting' | 'live' | 'reconnecting';
interface LiveState { snapshot: Snapshot | null; conn: ConnState; lastEventAt: number }

const MAX_LOG_BUFFER = 2000;
const live = (() => {
  let state: LiveState = { snapshot: null, conn: 'connecting', lastEventAt: 0 };
  let logs: LogLine[] = [];
  const subs = new Set<() => void>();
  const logSubs = new Set<() => void>();
  let es: EventSource | null = null;
  let refs = 0;
  const emit = () => subs.forEach((f) => f());
  const set = (patch: Partial<LiveState>) => { state = { ...state, ...patch }; emit(); };

  function open() {
    if (es) return;
    const tok = getToken();
    es = new EventSource(`/api/events${tok ? `?token=${encodeURIComponent(tok)}` : ''}`);
    es.addEventListener('snapshot', (ev) => {
      set({ snapshot: JSON.parse((ev as MessageEvent).data), conn: 'live', lastEventAt: Date.now() });
    });
    es.addEventListener('log', (ev) => {
      const line: LogLine = JSON.parse((ev as MessageEvent).data);
      logs = logs.length >= MAX_LOG_BUFFER ? [...logs.slice(-MAX_LOG_BUFFER + 1), line] : [...logs, line];
      logSubs.forEach((f) => f());
    });
    es.onopen = () => set({ conn: state.snapshot ? 'live' : 'connecting' });
    es.onerror = () => {
      set({ conn: 'reconnecting' });
      // EventSource can't surface the HTTP status; probe a cheap authenticated route to detect a 401.
      fetch('/api/hosts', { method: 'HEAD', headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then((r) => { if (r.status === 401) authStore.setNeeded(true); }).catch(() => {});
    };
  }
  function close() { es?.close(); es = null; }

  return {
    subscribe: (fn: () => void) => { subs.add(fn); refs++; open(); return () => { subs.delete(fn); if (--refs === 0) close(); }; },
    get: () => state,
    subscribeLogs: (fn: () => void) => { logSubs.add(fn); return () => { logSubs.delete(fn); }; },
    getLogs: () => logs,
    seedLogs: (lines: LogLine[]) => { const seen = new Set(logs.map((l) => l.cursor ?? l.raw + l.ts)); const merged = [...lines.filter((l) => !seen.has(l.cursor ?? l.raw + l.ts)), ...logs]; logs = merged.slice(-MAX_LOG_BUFFER); logSubs.forEach((f) => f()); },
    reconnect: () => { close(); open(); },
  };
})();

export const useLive = () => useSyncExternalStore(live.subscribe, live.get);
export const useLiveLogs = () => useSyncExternalStore(live.subscribeLogs, live.getLogs);
export const seedLogs = live.seedLogs;
export const reconnectLive = live.reconnect;

// ------------------------------------------------------------- polling fetch hook
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 5000): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try { const d = await fnRef.current(); if (alive) { setData(d); setError(null); } }
      catch (e) { if (alive) setError((e as Error).message); }
      finally { if (alive) { setLoading(false); if (intervalMs > 0) timer = setTimeout(run, document.hidden ? intervalMs * 4 : intervalMs); } }
    };
    void run();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, intervalMs]);
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);
  return { data, error, loading, refresh };
}
