// /etc/fips/hosts parsing and host facts; service state and actions live in server/platform.ts.
import fs from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { PLATFORM as P } from './platform.ts';


export { unitStates, serviceAction, unitName, PLATFORM, SERVICES, type UnitState, type ServiceAction, type ServiceId } from './platform.ts';

export interface HostEntry { hostname: string; npub: string; comment?: string }

const HOSTS_PATH = process.env.FIPS_HOSTS ?? (os.platform() === 'win32' ? `${process.env.ProgramData ?? 'C:\\ProgramData'}\\fips\\hosts` : os.platform() === 'darwin' || os.platform() === 'freebsd' ? (existsSync('/usr/local/etc/fips/hosts') ? '/usr/local/etc/fips/hosts' : '/etc/fips/hosts') : '/etc/fips/hosts');

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
  return { hostname: os.hostname(), platform: os.platform(), os: P.os, distro: P.distro, serviceManager: P.serviceManager, release: os.release(), uptimeSecs: os.uptime(), loadavg: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem() };
}
