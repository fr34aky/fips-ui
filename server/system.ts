// Host facts (the hosts file lives in server/hosts.ts); service state and actions live in server/platform.ts.
import os from 'node:os';
import { PLATFORM as P } from './platform.ts';


export { unitStates, serviceAction, unitName, PLATFORM, SERVICES, type UnitState, type ServiceAction, type ServiceId } from './platform.ts';

export { readHosts, HOSTS_PATH, type HostEntry } from './hosts.ts';

export async function hostInfo() {
  return { hostname: os.hostname(), platform: os.platform(), os: P.os, distro: P.distro, serviceManager: P.serviceManager, release: os.release(), uptimeSecs: os.uptime(), loadavg: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem() };
}
