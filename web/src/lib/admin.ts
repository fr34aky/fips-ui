// Client for the node-management API (server/admin.ts).
import { api } from './api';

export interface HelperFeatures { config: boolean; hosts: boolean; services: boolean; firewall: 'nft' | 'pf' | 'none'; guard: 'nft' | 'pf' | 'none' }
export interface HelperInfo { available: boolean; version: number | null; error?: string; managementCapable: boolean; features?: HelperFeatures; serviceManager?: string; configPath?: string }
export interface ConfigBackup { id: string; size: number; mtime: number }
export interface ApplyResult { ok: boolean; changed?: boolean; restarted?: boolean; backup_id?: string; rolled_back?: boolean; restored_healthy?: boolean; error?: string; journal?: string }
export type RuleSource = { kind: 'any' } | { kind: 'npub'; npub: string; label?: string; addr?: string } | { kind: 'prefix'; prefix: string; label?: string };
export interface FirewallRule { proto: 'tcp' | 'udp'; ports: string; sources: RuleSource[]; comment?: string; tag?: string }
export interface Dropin { name: string; content: string; size: number; mtime: number; managed: boolean }
export interface FirewallState {
  /** nftables (Linux) or pf (FreeBSD, macOS), and where the drop-ins live. */
  backend?: 'nft' | 'pf'; dropinDir?: string; dropinExt?: string;
  status: { unitActive: boolean; unitEnabled: string; tableLoaded: boolean; summary: { dropPackets: number; dropBytes: number; rules: number } | null; pfEnabled?: boolean; anchorReferenced?: boolean; anchor?: string } | { error: string };
  unit: { active: string; sub: string; unitFileState?: string; since?: number } | null;
  managedRules: FirewallRule[];
  dropins: Dropin[];
}
export interface DropinResult { ok: boolean; error?: string; detail?: string; reloaded?: boolean }

export const adminApi = {
  status: (refresh = false) => api.get<{ helper: HelperInfo; busy: string | null }>(`/api/admin/status${refresh ? '?refresh=1' : ''}`),
  config: () => api.get<{ yaml: string; base: string; backups: ConfigBackup[]; path: string }>('/api/admin/config'),
  backup: (id: string) => api.get<{ id: string; yaml: string }>(`/api/admin/config/backup?id=${encodeURIComponent(id)}`),
  apply: (yaml: string, restart: boolean, base: string) => api.post<ApplyResult>('/api/admin/config', { yaml, restart, base }),
  restore: (id: string) => api.post<ApplyResult>('/api/admin/config/restore', { id }),
  firewall: () => api.get<FirewallState>('/api/admin/firewall'),
  saveRules: (rules: FirewallRule[]) => api.post<DropinResult>('/api/admin/firewall/rules', { rules }),
  saveDropin: (name: string, content: string) => api.post<DropinResult>('/api/admin/firewall/dropin', { name, content }),
  deleteDropin: (name: string) => api.post<DropinResult>('/api/admin/firewall/dropin/delete', { name }),
  service: (unit: string, action: 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable') => api.post<{ ok: boolean; active: boolean; enabled: string }>('/api/admin/service', { unit, action }),
  address: (npub: string) => api.get<{ npub: string; address: string }>(`/api/admin/address?npub=${encodeURIComponent(npub)}`),
};

/** 422 answers carry a structured result; surface it instead of a bare error string. */
export async function withResult<T>(p: Promise<T>): Promise<T> {
  try { return await p; }
  catch (e) {
    const err = e as Error & { status?: number; body?: unknown };
    if (err.status === 422 && err.body) return err.body as T;
    throw e;
  }
}
