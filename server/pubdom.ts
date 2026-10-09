// Public domain names over fips (fr34aky/fips-pub-domains): the resolver daemon `fips-pubdomd` and the
// domain server `fips-pubdom-server` each expose a control socket in the daemon's own line-JSON protocol
// (that repository's docs/webui.md), so control.ts speaks to them unchanged. This module says whether
// either is on the node and proxies the read-only commands; writes (the helper's zone and config
// edits, publish, forget, flush) are a later phase.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ControlError, endpointExists, query } from './control.ts';
import { PLATFORM } from './platform.ts';
import { fetchLatestRelease } from './github.ts';

export type PubdomSide = 'resolver' | 'server';

export const RESOLVER_SOCKET = process.env.FIPS_PUBDOM_SOCKET ?? '/run/fips-pubdom/control.sock';
export const SERVER_SOCKET = process.env.FIPS_PUBDOM_SERVER_SOCKET ?? '/run/fips-pubdom-server/control.sock';

/** What a side's presence is judged from: its socket, or the files an installed one has. */
export interface SidePaths { socket: string; files: string[] }
export const PATHS: Record<PubdomSide, SidePaths> = {
  resolver: { socket: RESOLVER_SOCKET, files: ['/etc/fips-pubdom/config.yaml', '/var/lib/fips-pubdom/pins.json'] },
  server: { socket: SERVER_SOCKET, files: ['/etc/fips-pubdom/server.yaml', '/etc/fips-pubdom/zones'] },
};

export interface SideState { socket: string; running: boolean; installed: boolean }
export type PubdomState = Record<PubdomSide, SideState>;

/** The page's full picture of a side: presence, the binary's version and the unit's state (systemd only). */
export interface UnitState { loaded: boolean; active: string; sub: string; enabled: string }
export interface SideFull extends SideState { version: string | null; unit: UnitState | null }
export interface PubdomFull { resolver: SideFull; server: SideFull; /** Where the helper can install: systemd, as the packaging's units need. */ canInstall: boolean }
/** The binaries and the systemd units, as the web view names them too. */
export const BIN: Record<PubdomSide, string> = { resolver: 'fips-pubdomd', server: 'fips-pubdom-server' };
export const UNIT: Record<PubdomSide, string> = { resolver: 'fips-pubdom', server: 'fips-pubdom-server' };
/** Helper version with pubdom-install / pubdom-update. */
export const INSTALL_HELPER_VERSION = 12;
/** Fixed on purpose: the helper installs from here as root, and nothing a caller sets reaches it through sudo. */
export const RELEASE_REPO = 'fr34aky/fips-pub-domains';

function exec(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (err, out) => (err ? reject(err) : resolve(String(out)))));
}

/** "fips-pubdomd 0.2.8" → "0.2.8"; null when the binary is not there or says something else. */
export function parseVersionLine(out: string | null): string | null {
  const m = /^\S+\s+(\d+\.\d+\.\d+\S*)/.exec((out ?? '').trim());
  return m ? m[1] : null;
}
export async function binaryVersion(bin: string, run = exec): Promise<string | null> {
  return parseVersionLine(await run(bin, ['--version']).catch(() => null));
}

/** `systemctl show` output for a unit; null when it is not loaded at all. */
export function parseUnitShow(out: string): UnitState | null {
  const kv = new Map(out.split('\n').map((l) => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; }));
  if (kv.get('LoadState') !== 'loaded') return null;
  return { loaded: true, active: kv.get('ActiveState') ?? 'unknown', sub: kv.get('SubState') ?? '', enabled: kv.get('UnitFileState') ?? '' };
}
export async function unitState(unit: string, run = exec): Promise<UnitState | null> {
  if (PLATFORM.serviceManager !== 'systemd') return null;
  return parseUnitShow(await run('systemctl', ['show', `${unit}.service`, '-p', 'LoadState,ActiveState,SubState,UnitFileState']).catch(() => ''));
}

/** detect() plus what the install and service controls need; the versions come from the binaries themselves. */
export async function fullState(): Promise<PubdomFull> {
  const base = detect();
  const side = async (k: PubdomSide): Promise<SideFull> => {
    const [version, unit] = await Promise.all([binaryVersion(BIN[k]), unitState(UNIT[k])]);
    return { ...base[k], version, unit };
  };
  const [resolver, server] = await Promise.all([side('resolver'), side('server')]);
  return { resolver, server, canInstall: PLATFORM.serviceManager === 'systemd' };
}

export interface Release { tag: string; version: string; url: string; publishedAt: string }
export interface Releases { repo: string; latest: Release | null; error?: string; checkedAt: number }
let releases: Releases | null = null;
let releasesPending: Promise<Releases> | null = null;
const RELEASE_TTL_MS = 6 * 3600_000, RELEASE_ERROR_TTL_MS = 60_000;

/** The newest fips-pub-domains release, checked at most every six hours (a minute after an error) unless forced. */
export function latestRelease(force = false, fetchJson: (repo: string) => Promise<unknown> = fetchLatestRelease): Promise<Releases> {
  const ttl = releases?.error ? RELEASE_ERROR_TTL_MS : RELEASE_TTL_MS;
  if (!force && releases && Date.now() - releases.checkedAt < ttl) return Promise.resolve(releases);
  releasesPending ??= (async () => {
    try {
      const j = await fetchJson(RELEASE_REPO) as { tag_name?: string; html_url?: string; published_at?: string };
      if (!j.tag_name || !/^v\d+\.\d+\.\d+$/.test(j.tag_name)) throw new Error(`unexpected release tag ${JSON.stringify(j.tag_name)}`);
      releases = { repo: RELEASE_REPO, latest: { tag: j.tag_name, version: j.tag_name.slice(1), url: j.html_url ?? `https://github.com/${RELEASE_REPO}/releases`, publishedAt: j.published_at ?? '' }, checkedAt: Date.now() };
    } catch (e) {
      releases = { repo: RELEASE_REPO, latest: releases?.latest ?? null, error: `could not check for a new fips-pub-domains release: ${(e as Error).message}`, checkedAt: Date.now() };
    } finally { releasesPending = null; }
    return releases!;
  })();
  return releasesPending;
}

/**
 * Installed: a socket that answers, or configuration on disk (a stopped unit still shows its page). The socket is
 * judged as control.ts does, so a host:port override counts as reachable.
 */
export function detect(paths: Record<PubdomSide, SidePaths> = PATHS, exists: (p: string) => boolean = (p) => fs.existsSync(p), socketUp: (ep: string) => boolean = endpointExists): PubdomState {
  const side = (p: SidePaths): SideState => {
    const running = socketUp(p.socket);
    return { socket: p.socket, running, installed: running || p.files.some(exists) };
  };
  return { resolver: side(paths.resolver), server: side(paths.server) };
}

/** Read-only commands per side, proxied for every role. `attestations` asks the relays, so it is on request. */
export const READ_COMMANDS: Record<PubdomSide, Set<string>> = {
  resolver: new Set(['status', 'pins', 'log']),
  server: new Set(['status', 'zones', 'txt', 'attestations', 'log']),
};
/** Commands that change something, for admins (server/admin.ts): they go over the socket, not the helper. */
export const WRITE_COMMANDS: Record<PubdomSide, Set<string>> = {
  resolver: new Set(['forget', 'flush']),
  server: new Set(['publish', 'check-dns']),
};
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
/** A zone file is any plain *.yaml name the server loads: the one path component a caller may choose (the helper checks it too). */
export const ZONE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.yaml$/;
/** `key:` in server.yaml may hold the key itself rather than a path; such a file is not shown. */
const INLINE_KEY_RE = /^\s*key:\s*["']?(nsec1[a-z0-9]+|[0-9a-fA-F]{64})["']?\s*(#.*)?$/m;

/** The configuration file the helper's `pubdom-config-apply <side>` writes. */
export const CONFIG_FILE: Record<PubdomSide, string> = { resolver: '/etc/fips-pubdom/config.yaml', server: '/etc/fips-pubdom/server.yaml' };

export interface FileText { path: string; text: string; /** sha256 of the bytes, or 'none' when the file does not exist: the helper's --base. */ base: string }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A file the editor shows and the helper later replaces, with the hash the helper checks against. */
export function readEditable(file: string): FileText {
  try {
    const b = fs.readFileSync(file);
    const text = b.toString('utf8');
    if (INLINE_KEY_RE.test(text)) throw new Error(`${file} holds the key itself under key:; point key: at a file (such as /etc/fips/fips.key) or edit it from a shell`);
    return { path: file, text, base: sha256(b) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (!err.code) throw e;
    if (err.code === 'ENOENT') return { path: file, text: '', base: 'none' };
    if (err.code === 'EACCES') throw new Error(`cannot read ${file}: permission denied (the file should be root:root 0644)`);
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

/** True when `file` is `<dir>/<name>.yaml` with a plain name: what the zones listing reports and nothing else. */
export function zoneFileWithin(dir: string, file: string): boolean {
  const base = path.basename(file);
  return ZONE_FILE_RE.test(base) && !base.includes('..') && path.resolve(file) === path.join(path.resolve(dir), base);
}

/** An expected state of the node that the operator must change, not a fault: answered 409, not 500. */
export class PubdomStateError extends Error {}

/** What a server running from --zone flags needs: `init` writes the file, or only a restart if it already exists. */
export function noZonesDirMessage(configExists: boolean): string {
  return configExists
    ? `the server runs from --zone flags although ${CONFIG_FILE.server} exists; run \`sudo systemctl restart ${UNIT.server}\` so the unit uses the file`
    : `the server runs from --zone flags, not a zones directory: run \`sudo ${UNIT.server} init\` to write ${CONFIG_FILE.server} from the existing zone files, then \`sudo systemctl restart ${UNIT.server}\``;
}

/**
 * The directory the running server follows, which the helper must agree with before it writes there. A server
 * started with --zone flags (a unit from before server.yaml existed, or one not restarted since the file was
 * written) follows no directory: a new file in it would not be picked up.
 */
export async function liveZonesDir(status: () => Promise<{ zones_dir?: string | null }> = () => pubdomQuery('server', 'status'), configExists: () => boolean = () => fs.existsSync(CONFIG_FILE.server)): Promise<string> {
  const st = await status();
  if (!st.zones_dir) throw new PubdomStateError(noZonesDirMessage(configExists()));
  return st.zones_dir;
}

/** A zone file as it is on disk, for the editor; the path must be inside the server's zones directory. */
export async function readZoneFile(file: string): Promise<FileText> {
  if (!zoneFileWithin(await liveZonesDir(), file)) throw new Error('not a file in the zones directory');
  return readEditable(file);
}

export function isSide(s: string): s is PubdomSide { return s === 'resolver' || s === 'server'; }

/** The query, with the transport errors' "is the fips daemon running?" hint naming the right process. */
export async function pubdomQuery<T = unknown>(side: PubdomSide, command: string, params?: Record<string, unknown>): Promise<T> {
  try {
    return await query<T>(command, params, { socketPath: PATHS[side].socket, timeoutMs: 15000 });
  } catch (e) {
    if (e instanceof ControlError && e.kind === 'transport') throw new ControlError(e.message.replace('the fips daemon', BIN[side]), 'transport');
    throw e;
  }
}

// ---- Names this node serves (fips-ui reached under a public domain) -------------------------------------------
// A browser that reaches this dashboard under a public domain sends that name as Host. Only the names this node's
// own domain server answers with this node (target "self", or this node's own npub written out) may be accepted, and only for zones whose claim is
// published without an error: a visitor's fips-pubdomd binds a domain to a node only when that node published a
// valid claim, so nobody else can point such a name here (the same reason any <name>.fips is safe). A name the zone
// gives to another node, or leaves to ordinary DNS ("legacy"), is not ours, even with a "*" entry.

/** The domain server's `zones` answer, as far as fips-ui reads it (web/src/lib/types.ts PubdomZone has all of it). */
export interface ZonesAnswer { zones?: { domain?: string; names?: { label?: string; target?: string }[]; claim_published_at?: number | null; last_error?: string | null }[] }
/** Per served domain (claim published, no error): what each label answers, and what `*` answers. */
export type ServedNames = Map<string, { labels: Map<string, string>; wildcard: string | null }>;

// Zone labels are single hostname labels ("@", "www", "*"), as fips-pub-domains validates them.
const ZONE_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The served zones from a `zones` answer, keyed by domain. A target that is this node's own npub (bech32 in any
 * case) is recorded as "self": the domain server answers both with this node.
 */
export function selfHostnames(answer: ZonesAnswer | null | undefined, ownNpub?: string): ServedNames {
  const own = ownNpub?.toLowerCase();
  const out: ServedNames = new Map();
  for (const z of answer?.zones ?? []) {
    const domain = String(z.domain ?? '').toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) continue;
    // An unpublished or failing claim: visitors do not bind the domain to this node, ordinary DNS answers instead.
    if (!z.claim_published_at || z.last_error) continue;
    const labels = new Map<string, string>(); let wildcard: string | null = null;
    for (const n of z.names ?? []) {
      const label = String(n?.label ?? '').toLowerCase();
      const raw = String(n?.target ?? '').trim();
      const target = own && raw.toLowerCase() === own ? 'self' : raw;
      if (label === '*') wildcard = target;
      else if (label === '@' || ZONE_LABEL_RE.test(label)) labels.set(label, target);
    }
    out.set(domain, { labels, wildcard });
  }
  return out;
}

/**
 * Whether the domain server answers `hostname` with this node, by its own lookup rule: the part before the domain
 * ("@" for the domain itself) matches a label exactly, or else the `*` entry decides (at any depth, and for the
 * domain itself when there is no "@"). Targets naming this node by its npub are "self" already (selfHostnames).
 */
export function hostMatches(hostname: string, names: ServedNames): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  let best: string | null = null;
  for (const d of names.keys()) if ((h === d || h.endsWith(`.${d}`)) && (!best || d.length > best.length)) best = d;
  if (!best) return false;
  const zone = names.get(best)!;
  const part = h === best ? '@' : h.slice(0, -(best.length + 1));
  const target = zone.labels.has(part) ? zone.labels.get(part) : zone.wildcard;
  return target === 'self';
}

const NO_NAMES: ServedNames = new Map();
let served: ServedNames = NO_NAMES;
let lastAnswer: ZonesAnswer | null = null;
let ownNpub: string | undefined;
let refreshSeq = 0;
let watching = false;

/** The names this node serves right now (kept current by watchServedHostnames and setServedOwnNpub). */
export function servedHostnames(): ServedNames { return served; }

/**
 * This node's npub, for zones that name it instead of "self". The mesh listener learns it after start (and the
 * identity may change): the names are rebuilt from the last answer at once instead of at the next refresh.
 */
export function setServedOwnNpub(npub: string | undefined): void {
  const n = npub?.toLowerCase();
  if (n === ownNpub) return;
  ownNpub = n;
  if (lastAnswer) served = selfHostnames(lastAnswer, ownNpub);
}

/**
 * Keep the served names current: read the zones at once and every 15 s. A query that fails keeps the names of
 * the last answer (a busy server must not lock visitors out mid-session); a stopped server serves none, and an
 * answer still on its way from before it stopped is dropped, like any answer that arrives out of order.
 */
export function watchServedHostnames(intervalMs = 15_000): void {
  if (watching) return;
  watching = true;
  const refresh = () => {
    const seq = ++refreshSeq;
    if (!detect().server.running) { served = NO_NAMES; lastAnswer = null; return; }
    void pubdomQuery<ZonesAnswer>('server', 'zones').then((z) => { if (seq === refreshSeq) { lastAnswer = z; served = selfHostnames(z, ownNpub); } }, () => { /* keep the last answer */ });
  };
  refresh();
  setInterval(refresh, intervalMs).unref();
}
