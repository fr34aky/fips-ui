// The FIPS hosts file: "hostname npub" lines resolved as <hostname>.fips by the daemon's DNS responder, which
// reloads the file when its mtime changes (docs/how-to/host-aliases.md upstream). Reading is open to everyone;
// writing needs root on Linux (through the helper) or write access to the file on other systems.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HostEntry { hostname: string; npub: string; comment?: string }

export const HOSTS_PATH = process.env.FIPS_HOSTS ?? (os.platform() === 'win32'
  ? `${process.env.ProgramData ?? 'C:\\ProgramData'}\\fips\\hosts`
  : os.platform() === 'darwin' || os.platform() === 'freebsd'
    ? (existsSync('/usr/local/etc/fips/hosts') ? '/usr/local/etc/fips/hosts' : '/etc/fips/hosts')
    : '/etc/fips/hosts');

/** Lowercase letters, digits and hyphens, at most 63 characters (a DNS label: no hyphen at either end). */
export const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;
const ENTRY_RE = /^(\s*)([^\s#]+)(\s+)(npub1\S+)(\s*(?:#.*)?)$/;

export class HostsError extends Error {}

/** sha256 of the file's bytes, as the helper computes it ('none' when there is no file). */
export const hashOf = (bytes: Buffer | null): string => (bytes === null ? 'none' : createHash('sha256').update(bytes).digest('hex'));

export async function readHosts(): Promise<{ path: string; entries: HostEntry[]; raw: string | null; base: string; error?: string }> {
  try {
    const bytes = await fs.readFile(HOSTS_PATH);
    const raw = bytes.toString('utf8');
    return { path: HOSTS_PATH, entries: parseHosts(raw), raw, base: hashOf(bytes) };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return { path: HOSTS_PATH, entries: [], raw: null, base: 'none', error: missing ? undefined : (e as Error).message };
  }
}

/** Entries in file order; on duplicate hostnames the last one wins, as in the daemon. */
export function parseHosts(raw: string): HostEntry[] {
  const byName = new Map<string, HostEntry>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    // The note is the entry's own trailing comment; comment blocks above describe the file, not one entry.
    const inline = m[5].trim().replace(/^#+\s?/, '');
    byName.delete(m[2]);
    byName.set(m[2], { hostname: m[2], npub: m[4], ...(inline ? { comment: inline } : {}) });
  }
  return [...byName.values()];
}

/**
 * Validate the entries of a save. An entry exactly as it already is in the file is accepted unchanged (a
 * hand-written line the UI would not create must not block every other change); new and changed entries must
 * be valid.
 */
export function validateEntries(input: unknown, existing: HostEntry[] = []): { hostname: string; npub: string }[] {
  if (!Array.isArray(input) || input.length > 2000) throw new HostsError('entries must be an array of at most 2000 items');
  const kept = new Set(existing.map((e) => `${e.hostname} ${e.npub}`));
  const seen = new Set<string>();
  return input.map((x) => {
    const e = x as { hostname?: unknown; npub?: unknown };
    const raw = { hostname: String(e?.hostname ?? '').trim(), npub: String(e?.npub ?? '').trim() };
    if (kept.has(`${raw.hostname} ${raw.npub}`) && !seen.has(raw.hostname)) { seen.add(raw.hostname); return raw; }
    const hostname = raw.hostname.toLowerCase();
    const npub = raw.npub;
    if (!HOSTNAME_RE.test(hostname)) throw new HostsError(`'${hostname}' is not a valid name: lowercase letters, digits and hyphens, at most 63 characters, no hyphen at either end`);
    if (!NPUB_RE.test(npub)) throw new HostsError(`invalid npub for ${hostname}`);
    if (seen.has(hostname)) throw new HostsError(`${hostname} is listed twice`);
    seen.add(hostname);
    return { hostname, npub };
  });
}

/**
 * The new file: comments, blank lines and the order of the entries that stay are kept; an entry whose npub
 * changes keeps its spacing and inline comment; removed entries (every line with that name) are dropped;
 * new entries are appended. The file's line ending (LF or CRLF) is kept.
 */
export function renderHosts(raw: string | null, entries: { hostname: string; npub: string }[]): string {
  const eol = raw?.includes('\r\n') ? '\r\n' : '\n';
  const want = new Map(entries.map((e) => [e.hostname, e.npub]));
  const written = new Set<string>();
  const out: string[] = [];
  const lines = raw === null ? ['# FIPS hosts: one "hostname npub" per line, resolved as <hostname>.fips (managed with fips-ui).'] : raw.split(/\r?\n/);
  if (raw !== null && lines[lines.length - 1] === '') lines.pop();
  // With duplicate names only the last line counts (as in the daemon); that is the one updated in place.
  const lastLine = new Map<string, number>();
  lines.forEach((line, i) => { const m = ENTRY_RE.exec(line); if (m && !line.trim().startsWith('#')) lastLine.set(m[2], i); });
  lines.forEach((line, i) => {
    const m = line.trim().startsWith('#') ? null : ENTRY_RE.exec(line);
    if (!m) { out.push(line); return; }
    const npub = want.get(m[2]);
    if (npub === undefined || lastLine.get(m[2]) !== i) return;
    out.push(`${m[1]}${m[2]}${m[3]}${npub}${m[5]}`);
    written.add(m[2]);
  });
  const width = Math.max(14, ...entries.map((e) => e.hostname.length + 1));
  for (const e of entries) if (!written.has(e.hostname)) out.push(`${e.hostname.padEnd(width)} ${e.npub}`);
  return out.join(eol) + eol;
}

/**
 * Write the file directly (systems without the helper). Needs write access to the file, or to its directory
 * when it does not exist yet; the error says what is missing.
 */
export async function writeHostsDirect(content: string): Promise<void> {
  const dir = path.dirname(HOSTS_PATH);
  const tmp = path.join(dir, `.hosts.fips-ui-${process.pid}.tmp`);
  try {
    if (existsSync(HOSTS_PATH)) {
      // Rewritten in place, in one write, so its owner, group and mode stay as the admin set them (a rename would
      // give the file to the UI's user and drop group write access).
      await fs.writeFile(HOSTS_PATH, content);
      return;
    }
    // A new file is created whole: written next to its final name, then renamed.
    try { await fs.writeFile(tmp, content, { mode: 0o644 }); await fs.rename(tmp, HOSTS_PATH); }
    catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new HostsError(os.platform() === 'win32'
        ? `no write access to ${HOSTS_PATH}: run the UI from an elevated (administrator) process or grant its user write access to that file`
        : `no write access to ${HOSTS_PATH}: grant the UI's user write access to it (for example a group-writable file), or on Linux with systemd install the privileged helper (deploy/setup-local.sh)`);
    }
    throw e;
  }
}
