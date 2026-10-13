// The node manager: the nodes this one manages over the mesh (server/fleet.ts). Always this node's own
// endpoints, whichever node the page is looking at.
import { api } from './api';
import type { Role } from './types';

export interface FleetNodeConfig { npub: string; label?: string; port: number }
export interface FleetManager { npub: string; label?: string }
export interface FleetConfig { nodes: FleetNodeConfig[]; managers: FleetManager[] }
export type Phase = 'ok' | 'offline' | 'unauthorised' | 'viewer' | 'not-ready' | 'restarting' | 'error';
export interface FleetNodeStatus {
  npub: string; label?: string; port: number;
  reachable: boolean; phase: Phase; error?: string;
  lastAttempt: number; lastSeen?: number;
  daemonVersion?: string; daemonOk?: boolean; uiVersion?: string; uiUptimeSecs?: number; uptimeSecs?: number; peerCount?: number;
  platform?: string; readOnly?: boolean; nodeManagement?: boolean; role?: Role;
  helper?: { installed: number | null; shipped: number | null };
  upgrade?: { installed?: string; running?: string; latest?: string; available: boolean; restartPending?: boolean; job?: { state: string; kind?: string } | null };
  uiUpdate?: { current?: string; latest?: string; available: boolean; job?: { state: string; restarting?: boolean } | null };
  managersInSync?: boolean; managersMissing?: string[];
}
export interface FleetStatus { running: boolean; lastRun?: number; nextRun?: number; error?: string }
export interface FleetData { config: FleetConfig; own?: string; managers: string[]; file: string; status: FleetStatus; nodes: FleetNodeStatus[] }

/** What syncing the managers to one node did. */
export interface SyncResult { npub: string; changed: boolean; added: string[]; promoted: string[]; error?: string; node?: FleetNodeStatus }

export const fleetApi = {
  get: (refresh = false) => api.local.get<FleetData>(`/api/fleet${refresh ? '?refresh=1' : ''}`),
  save: (config: FleetConfig) => api.local.post<FleetData>('/api/fleet', config),
  /** Make every manager an admin on that node (or on all of them). */
  syncManagers: (npub: string) => api.local.post<SyncResult>(`/api/fleet/nodes/${encodeURIComponent(npub)}/sync-managers`),
  syncAllManagers: () => api.local.post<{ results: SyncResult[] }>('/api/fleet/sync-managers'),
};

/** What a phase says, and how loud. */
export function phaseInfo(n: FleetNodeStatus): { label: string; tone: 'good' | 'warn' | 'serious' | 'crit' | 'accent' | 'neutral'; pulse?: boolean } {
  switch (n.phase) {
    case 'ok': return { label: 'reachable', tone: 'good' };
    case 'offline': return { label: n.lastAttempt ? 'offline' : 'not probed yet', tone: n.lastAttempt ? 'crit' : 'neutral' };
    case 'unauthorised': return { label: 'not allowed', tone: 'warn' };
    case 'viewer': return { label: 'viewer only', tone: 'warn' };
    case 'not-ready': return { label: 'not ready', tone: 'serious' };
    case 'restarting': return { label: 'restarting', tone: 'accent', pulse: true };
    default: return { label: 'error', tone: 'crit' };
  }
}
