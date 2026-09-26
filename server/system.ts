// systemd unit state, /etc/fips/hosts parsing, and service actions.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const UNITS = ['fips.service', 'fips-dns.service', 'fips-firewall.service', 'fips-gateway.service'] as const;
export type UnitName = (typeof UNITS)[number];

export interface UnitState {
  unit: string;
  loaded: boolean;
  active: string;      // active | inactive | failed | activating ...
  sub: string;         // running | exited | dead ...
  description: string;
  since?: number;      // epoch ms of ExecMainStartTimestamp / ActiveEnterTimestamp
  mainPid?: number;
  memoryBytes?: number;
  cpuUsageNs?: number;
  restarts?: number;
  unitFileState?: string;
}

// Timestamps: `--timestamp=unix` (systemd >= 250) yields `@<epoch-seconds>`; older systemd ignores the flag and
// prints a localized string that does not parse, so the monotonic variants are read as a fallback and converted
// with CLOCK_MONOTONIC (process.hrtime on Linux), which like systemd's clock excludes suspend.
const PROPS = ['LoadState', 'ActiveState', 'SubState', 'Description', 'ActiveEnterTimestamp', 'ExecMainStartTimestamp', 'ActiveEnterTimestampMonotonic', 'ExecMainStartTimestampMonotonic', 'MainPID', 'MemoryCurrent', 'CPUUsageNSec', 'NRestarts', 'UnitFileState'];

export async function unitStates(): Promise<UnitState[]> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', ...UNITS, '-p', PROPS.join(','), '--no-pager', '--timestamp=unix']);
    const bootEpochMs = Date.now() - Number(process.hrtime.bigint() / 1_000_000n);
    // Output is blank-line separated blocks, one per unit, in request order.
    const blocks = stdout.trim().split(/\n\s*\n/);
    return blocks.map((block, i) => {
      const kv: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) kv[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const num = (s?: string) => (s && s !== '[not set]' && !Number.isNaN(Number(s)) ? Number(s) : undefined);
      const unix = /^@(\d+)/.exec(kv.ExecMainStartTimestamp || kv.ActiveEnterTimestamp || '');
      const monoUs = num(kv.ExecMainStartTimestampMonotonic) || num(kv.ActiveEnterTimestampMonotonic);
      const sinceMs = unix ? Number(unix[1]) * 1000 : monoUs ? bootEpochMs + monoUs / 1000 : NaN;
      return {
        unit: UNITS[i] ?? `unit-${i}`,
        loaded: kv.LoadState === 'loaded',
        active: kv.ActiveState ?? 'unknown',
        sub: kv.SubState ?? 'unknown',
        description: kv.Description ?? '',
        since: Number.isNaN(sinceMs) ? undefined : sinceMs,
        mainPid: num(kv.MainPID) || undefined,
        memoryBytes: num(kv.MemoryCurrent),
        cpuUsageNs: num(kv.CPUUsageNSec),
        restarts: num(kv.NRestarts),
        unitFileState: kv.UnitFileState,
      };
    });
  } catch {
    return [];
  }
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload';

export async function serviceAction(unit: UnitName, action: ServiceAction): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileP('systemctl', [action, unit], { timeout: 30000 });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || 'systemctl failed').trim() };
  }
}

export interface HostEntry { hostname: string; npub: string; comment?: string }

const HOSTS_PATH = process.env.FIPS_HOSTS ?? '/etc/fips/hosts';

export async function readHosts(): Promise<{ path: string; entries: HostEntry[]; raw: string | null; error?: string }> {
  try {
    const raw = await fs.readFile(HOSTS_PATH, 'utf8');
    const entries: HostEntry[] = [];
    let lastComment: string | undefined;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) { lastComment = undefined; continue; }
      if (t.startsWith('#')) { lastComment = t.replace(/^#+\s?/, ''); continue; }
      const [hostname, npub] = t.split(/\s+/);
      if (hostname && npub?.startsWith('npub1')) entries.push({ hostname, npub, comment: lastComment });
    }
    return { path: HOSTS_PATH, entries, raw };
  } catch (e) {
    return { path: HOSTS_PATH, entries: [], raw: null, error: (e as Error).message };
  }
}

export async function hostInfo() {
  return { hostname: os.hostname(), platform: os.platform(), release: os.release(), uptimeSecs: os.uptime(), loadavg: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem() };
}
