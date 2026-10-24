// Client for the weekly security scan (server/security.ts): the report, its history and the schedule. Always the
// node the page looks at (a managed node's scan is reached through this node's proxy).
import { api } from './api';
import type { HelperInfo } from './admin';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category = 'exposure' | 'firewall' | 'patches' | 'vulns' | 'hardening';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const CATEGORIES: { id: Category; label: string; hint: string }[] = [
  { id: 'exposure', label: 'Exposure', hint: 'Services reachable from the LAN, the internet or the mesh' },
  { id: 'firewall', label: 'Firewall', hint: 'Whether inbound connections are refused unless allowed' },
  { id: 'patches', label: 'Patches', hint: 'Pending updates, reboots and restarts' },
  { id: 'vulns', label: 'Vulnerabilities', hint: 'Known CVEs in installed packages, from the distribution' },
  { id: 'hardening', label: 'Hardening', hint: 'SSH, kernel settings, accounts and fips file modes' },
];

export interface Finding { id: string; category: Category; severity: Severity; title: string; detail?: string; fix?: string }
export type Scope = 'loopback' | 'link-local' | 'mesh' | 'lan' | 'public' | 'all';
export type Verdict = 'blocked' | 'restricted' | 'allowed' | 'unknown' | 'none';
export interface Listener { proto: 'tcp' | 'udp'; addr: string; port: number; iface?: string; process?: string; pid?: number; scope: Scope; ephemeral?: boolean; lan?: Verdict; mesh?: Verdict }
export interface PendingUpdate { name: string; from?: string; to?: string; security: boolean; origin?: string }
export interface Vulnerability { pkg: string; ids: string[]; severity: Severity; fixed: boolean; advisory?: string; fixedIn?: string; remote?: boolean }
export interface Report {
  scannedAt: number; durationSecs: number; helperVersion: number;
  system: { name?: string; kernel?: string; manager: string; nixos: boolean };
  listeners: Listener[];
  firewall: { backend: string; defaultDeny: boolean | null; detail?: string };
  packages: { manager: string; supported: boolean; updates: PendingUpdate[] | null; vulns: Vulnerability[] | null; vulnSource?: string; listsAgeDays?: number; errors: string[] };
  reboot: { required: boolean; reasons: string[]; services: string[] };
  findings: Finding[];
  categories: Record<Category, { deducted: number; findings: number }>;
  score: number; grade: Grade;
  notes: string[];
}
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export interface ScanSettings { enabled: boolean; weekday: number; hour: number }
export interface SecurityState {
  settings: ScanSettings; running: boolean; startedAt?: number; nextRun: number | null;
  lastError?: string; lastFailure?: number; latest: Report | null;
  /** Whether a scan can run here (helper v13 on Linux), and the helper as the backend sees it. */
  available: boolean; helper: HelperState;
  /** The service manager the helper is installed for (lib/admin.ts helperInstallCommand). */
  serviceManager?: string;
}
/** The helper as the backend sees it; `security`: a v13+ helper can scan on this system (python3 and ss present). */
export type HelperState = Pick<HelperInfo, 'version' | 'available' | 'error'> & { security?: boolean };
export interface HistoryPoint { score: number; grade: Grade; scannedAt: number; counts: Record<Severity, number>; categories: Report['categories'] }

/** The helper version with the security scan (server/admin.ts). */
export const SECURITY_HELPER_VERSION = 13;

export const securityApi = {
  get: () => api.get<SecurityState>('/api/admin/security'),
  history: () => api.get<{ history: HistoryPoint[] }>('/api/admin/security/history'),
  scan: () => api.post<SecurityState>('/api/admin/security/scan'),
  saveSettings: (s: ScanSettings) => api.post<SecurityState>('/api/admin/security/settings', s),
};

export const severityTone = (s: Severity) => (s === 'critical' ? 'crit' : s === 'high' ? 'serious' : s === 'medium' ? 'warn' : s === 'low' ? 'accent' : 'neutral') as 'crit' | 'serious' | 'warn' | 'accent' | 'neutral';
export const gradeTone = (g: Grade) => (g === 'A' ? 'good' : g === 'B' ? 'accent' : g === 'C' ? 'warn' : g === 'D' ? 'serious' : 'crit') as 'good' | 'accent' | 'warn' | 'serious' | 'crit';
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
