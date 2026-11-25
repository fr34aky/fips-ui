// The exit node (fr34aky/fips-exit): a daemon `fips-exitd` and a control script `fips-exit` that let listed
// mesh clients send their internet traffic out through this node. fips-ui shows what is set up and, for admins,
// changes the client list. Reads need no privilege (the list is a world-readable file); writes go through the
// privileged helper, which runs `fips-exit add` / `remove` (server/admin.ts).
//
// The inner IPv4 address shown next to a client is derived here by the same formula the daemon, the script and
// fips2go use; it is display only, and test/exit.test.ts holds it to the same vectors.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { PLATFORM } from './platform.ts';

export const EXIT_SCRIPT = process.env.FIPS_EXIT_SCRIPT ?? '/usr/local/sbin/fips-exit';
export const EXIT_DAEMON = process.env.FIPS_EXIT_DAEMON ?? '/usr/local/sbin/fips-exitd';
export const EXIT_CLIENTS = process.env.FIPS_EXIT_CLIENTS ?? '/etc/fips-exit/clients';
export const EXIT_UNIT = 'fips-exit';
/** A client's name in the list: what `fips-exit add` takes as one argument and the helper checks again. */
export const EXIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface ExitClient {
  /** The client's fips address, as written in the list. */
  address: string;
  /** Its IPv4 address inside the tunnel. */
  inner: string;
  name: string;
  /** False for a line whose inner address an earlier client already has: the exit does not serve it. */
  served: boolean;
}
export interface ExitState {
  installed: boolean;
  /** The service, where systemd runs it: active state and whether it starts at boot. */
  unit: { active: string; enabled: string } | null;
  clients: ExitClient[];
  clientsFile: string;
  /** Why the list could not be read, if it could not. */
  error?: string;
}

/** The 16 bytes of an IPv6 address, or null if `text` is not one. */
export function ipv6Bytes(text: string): Uint8Array | null {
  if (!net.isIPv6(text) || text.includes('%') || text.includes('.')) return null;
  const [head, tail] = text.split('::');
  const groups = (s: string | undefined) => (s ? s.split(':') : []);
  const left = groups(head), right = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array(fill).fill('0'), ...right];
  if (all.length !== 8) return null;
  const out = new Uint8Array(16);
  all.forEach((g, i) => { const v = parseInt(g, 16); out[i * 2] = v >> 8; out[i * 2 + 1] = v & 0xff; });
  return out;
}

/** A fips address (fd00::/8) in the form the tools print it, or null. */
export function fipsAddress(text: string): string | null {
  const b = ipv6Bytes(text.trim());
  return b && b[0] === 0xfd ? text.trim().toLowerCase() : null;
}

/** The inner IPv4 address of a fips address: 100.64.0.0/10 with the low 22 bits of address bytes 1..3. */
export function innerIpv4(address: Uint8Array): string {
  const bits = ((address[1] << 16) | (address[2] << 8) | address[3]) & 0x3fffff;
  const v = (0x64400000 | bits) >>> 0;
  return [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

/**
 * The client list, as the daemon reads it: `<fips address> [name]` per line, `#` comments, lines that are not a
 * fips address skipped. A client whose inner address an earlier line has is listed but not served.
 */
export function parseClients(text: string): ExitClient[] {
  const out: ExitClient[] = [];
  const byInner = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const fields = raw.split('#')[0].trim().split(/\s+/).filter(Boolean);
    if (!fields.length) continue;
    const bytes = ipv6Bytes(fields[0]);
    if (!bytes || bytes[0] !== 0xfd) continue;
    const address = fields[0].toLowerCase();
    if (out.some((c) => c.address === address)) continue;
    const inner = innerIpv4(bytes);
    const other = byInner.get(inner);
    if (other === undefined) byInner.set(inner, address);
    out.push({ address, inner, name: fields.slice(1).join(' '), served: other === undefined });
  }
  return out;
}

/** Whether fips-exit is on this node at all. The page and its menu entry exist only then. */
export function detect(): { installed: boolean } {
  return { installed: PLATFORM.os === 'linux' && fs.existsSync(EXIT_SCRIPT) && fs.existsSync(EXIT_DAEMON) };
}

function unitState(): Promise<ExitState['unit']> {
  if (PLATFORM.serviceManager !== 'systemd') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('systemctl', ['show', `${EXIT_UNIT}.service`, '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'LoadState'], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const kv = Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      resolve(kv.LoadState === 'not-found' ? null : { active: kv.ActiveState || 'unknown', enabled: kv.UnitFileState || 'unknown' });
    });
  });
}

export async function state(): Promise<ExitState> {
  const { installed } = detect();
  if (!installed) return { installed, unit: null, clients: [], clientsFile: EXIT_CLIENTS };
  const unit = await unitState();
  try {
    const text = await fs.promises.readFile(EXIT_CLIENTS, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; });
    return { installed, unit, clients: parseClients(text), clientsFile: EXIT_CLIENTS };
  } catch (e) {
    return { installed, unit, clients: [], clientsFile: EXIT_CLIENTS, error: (e as Error).message };
  }
}
