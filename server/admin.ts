// Node management: fips.yaml, the fips0 firewall and the fips systemd units.
//
// Everything here needs root and goes through the privileged helper (scripts/fips-ui-helper, v4+) via the
// same single sudoers rule the upgrade flow uses. The backend never sees secret config values: the helper
// redacts them on read and restores them on write. File contents travel on the helper's stdin, never as
// paths, so nothing can be swapped between validation and install.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { DOMAIN_RE, WRITE_COMMANDS as PUBDOM_WRITE, ZONE_FILE_RE, PubdomStateError, isSide as isPubdomSide, liveZonesDir, pubdomQuery } from './pubdom.ts';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMeshPrefix } from './net6.ts';
import { readJsonBody, BodyError, sendJson } from './http.ts';
import { unitStates } from './system.ts';

export const MIN_HELPER_VERSION = 4;
/** The helper version that can load the mesh-access spoofing guard. */
export const GUARD_HELPER_VERSION = 5;
/** The helper version that can write the FIPS hosts file. */
export const HOSTS_HELPER_VERSION = 6;
/** Helper version that writes fips-pub-domains' zone and configuration files (docs/public-domains.md). */
export const PUBDOM_HELPER_VERSION = 11;
// Worst case for config-apply: stop timeout (90 s) + health window (45 s), twice when it rolls back, plus margin.
// The helper ignores SIGTERM during install and rollback, so hitting this only abandons the wait.
const HELPER_RESTART_TIMEOUT = 330_000;
// Readable without privileges; overridable only so tests can point it at a scratch copy.
const DROPIN_DIR = process.env.FIPS_UI_DROPIN_DIR ?? '/etc/fips/fips.d';
export const MANAGED_DROPIN = 'fips-ui';
export const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;
const DROPIN_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

interface HelperResult { code: number; stdout: string; stderr: string }

function runHelper(helperPath: string, args: string[], input?: string, timeoutMs = 60_000): Promise<HelperResult> {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const [cmd, argv] = isRoot ? [helperPath, args] : ['sudo', ['-n', helperPath, ...args]];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    // Collect bytes and decode once, so a multi-byte character split across pipe chunks survives.
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const text = (b: Buffer[]) => Buffer.concat(b).toString('utf8');
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout: text(out), stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: text(out), stderr: text(err) }); });
    if (input !== undefined && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function helperError(r: HelperResult): string {
  const line = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() ?? `helper exited ${r.code}`;
  return line.replace(/^error:\s*/, '');
}

function lastJson<T>(stdout: string): T {
  const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('[')).pop();
  if (!line) throw new Error('helper returned no JSON');
  return JSON.parse(line) as T;
}

// ---------------------------------------------------------------------------------------------
// Managed firewall rules
// ---------------------------------------------------------------------------------------------

export type RuleSource = { kind: 'any' } | { kind: 'npub'; npub: string; label?: string; addr?: string } | { kind: 'prefix'; prefix: string; label?: string };
export interface FirewallRule { proto: 'tcp' | 'udp'; ports: string; sources: RuleSource[]; comment?: string; tag?: string }

const PORTS_RE = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;

function cleanComment(s: string | undefined): string { return (s ?? '').replace(/[^A-Za-z0-9 ._:@,/-]/g, '').slice(0, 60).trim(); }

function validateRule(r: unknown): FirewallRule {
  const x = r as Partial<FirewallRule>;
  if (x?.proto !== 'tcp' && x?.proto !== 'udp') throw new BodyError(400, 'rule.proto must be tcp or udp');
  const ports = String(x.ports ?? '').replace(/\s+/g, '');
  if (!PORTS_RE.test(ports)) throw new BodyError(400, `invalid ports '${x.ports}': use 22, 80,443 or 8000-8100`);
  for (const part of ports.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (a < 1 || a > 65535 || (b !== undefined && (b < a || b > 65535))) throw new BodyError(400, `port out of range in '${part}'`);
  }
  if (!Array.isArray(x.sources) || x.sources.length === 0) throw new BodyError(400, 'rule.sources must be a non-empty array');
  const sources: RuleSource[] = x.sources.map((s) => {
    const src = s as RuleSource;
    if (src?.kind === 'any') return { kind: 'any' };
    if (src?.kind === 'npub') { if (!NPUB_RE.test(String(src.npub))) throw new BodyError(400, `invalid npub '${src.npub}'`); return { kind: 'npub', npub: src.npub, label: cleanComment(src.label) || undefined }; }
    if (src?.kind === 'prefix') { if (!isMeshPrefix(String(src.prefix))) throw new BodyError(400, `invalid source '${src.prefix}': must be an fd00::/8 address or prefix`); return { kind: 'prefix', prefix: src.prefix.toLowerCase(), label: cleanComment(src.label) || undefined }; }
    throw new BodyError(400, 'each source must be {kind:"any"}, {kind:"npub",npub} or {kind:"prefix",prefix}');
  });
  if (sources.some((s) => s.kind === 'any') && sources.length > 1) throw new BodyError(400, '"anyone on the mesh" cannot be combined with other sources');
  const tag = x.tag && /^[a-z0-9-]{1,32}$/.test(x.tag) ? x.tag : undefined;
  return { proto: x.proto, ports, sources, comment: cleanComment(x.comment) || undefined, tag };
}

const addrCache = new Map<string, string>();
/** The fd00::/8 mesh address of an npub, derived offline by fipsctl (no daemon round trip). */
export async function meshAddress(npub: string): Promise<string> {
  if (!NPUB_RE.test(npub)) throw new BodyError(400, `invalid npub '${npub}'`);
  const hit = addrCache.get(npub);
  if (hit) return hit;
  if (addrCache.size >= 1000) addrCache.delete(addrCache.keys().next().value!);
  const addr = await new Promise<string>((resolve, reject) => execFile('fipsctl', ['address', npub], { timeout: 5000 }, (err, out) => err ? reject(new Error(`fipsctl address failed: ${err.message}`)) : resolve(String(out).trim())));
  if (!/^fd[0-9a-f:]+$/i.test(addr)) throw new Error(`fipsctl address returned '${addr}'`);
  addrCache.set(npub, addr.toLowerCase());
  return addr.toLowerCase();
}

/** Where the firewall's drop-ins live and in which language: nftables (Linux) or pf (FreeBSD, macOS). */
export interface FwTarget { backend: 'nft' | 'pf'; dir: string; ext: string }

/** A rule set in pf syntax, for the pf anchor ($tun is the FIPS interface, defined by the helper's baseline). */
function renderPfRule(r: FirewallRule, resolved: RuleSource[]): string {
  const pfPorts = r.ports.split(',').map((p) => p.replace('-', ':'));
  const ports = pfPorts.length > 1 ? `{ ${pfPorts.join(', ')} }` : pfPorts[0];
  const addrs = resolved.flatMap((s) => (s.kind === 'npub' ? [`${s.addr}/128`] : s.kind === 'prefix' ? [s.prefix.includes('/') ? s.prefix : `${s.prefix}/128`] : []));
  const from = addrs.length === 0 ? 'any' : addrs.length === 1 ? addrs[0] : `{ ${addrs.join(', ')} }`;
  const label = cleanComment(r.comment ?? `fips-ui ${r.proto} ${r.ports}`);
  return `pass in on $tun inet6 proto ${r.proto} from ${from} to any port ${ports} keep state${label ? ` label "${label}"` : ''}`;
}

export async function renderManagedDropin(rules: FirewallRule[], backend: 'nft' | 'pf' = 'nft'): Promise<string> {
  const out = [
    '# Managed by fips-ui (Firewall page). Manual edits to this file are overwritten.',
    '# Each rule is preceded by its definition so the UI can read it back.',
    '',
  ];
  for (const r of rules) {
    const resolved: RuleSource[] = [];
    for (const s of r.sources) resolved.push(s.kind === 'npub' ? { ...s, addr: await meshAddress(s.npub) } : s);
    const ports = r.ports.includes(',') ? `{ ${r.ports.split(',').join(', ')} }` : r.ports;
    const addrs = resolved.flatMap((s) => (s.kind === 'npub' ? [`${s.addr}/128`] : s.kind === 'prefix' ? [s.prefix.includes('/') ? s.prefix : `${s.prefix}/128`] : []));
    const saddr = addrs.length === 0 ? '' : addrs.length === 1 ? `ip6 saddr ${addrs[0]} ` : `ip6 saddr { ${addrs.join(', ')} } `;
    const comment = cleanComment(r.comment ?? `fips-ui ${r.proto} ${r.ports}`);
    out.push(`# fips-ui-rule ${JSON.stringify({ ...r, comment: cleanComment(r.comment) || undefined, sources: resolved })}`);
    out.push(backend === 'pf' ? renderPfRule(r, resolved) : `${saddr}${r.proto} dport ${ports} accept${comment ? ` comment "${comment}"` : ''}`);
  }
  return out.join('\n') + '\n';
}

export function parseManagedDropin(text: string): FirewallRule[] { return parseManagedDropinStrict(text).rules; }

/** Rules plus the number of definitions that no longer validate (which a rewrite would silently drop). */
export function parseManagedDropinStrict(text: string): { rules: FirewallRule[]; invalid: number } {
  const rules: FirewallRule[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    const m = /^# fips-ui-rule (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try { rules.push(validateRule(JSON.parse(m[1]))); } catch { invalid++; }
  }
  return { rules, invalid };
}

async function readDropins(fw: FwTarget = { backend: 'nft', dir: DROPIN_DIR, ext: '.nft' }): Promise<{ name: string; content: string; size: number; mtime: number; managed: boolean }[]> {
  if (!existsSync(fw.dir)) return [];
  const names = (await readdir(fw.dir)).filter((n) => n.endsWith(fw.ext)).sort();
  return Promise.all(names.map(async (n) => {
    const p = join(fw.dir, n);
    const [content, st] = await Promise.all([readFile(p, 'utf8').catch(() => ''), stat(p)]);
    const name = n.slice(0, -fw.ext.length);
    return { name, content, size: st.size, mtime: st.mtimeMs, managed: name === MANAGED_DROPIN };
  }));
}

/** Drop counter and rule count from `nft -j list table inet fips`. */
function summariseRuleset(ruleset: unknown): { dropPackets: number; dropBytes: number; rules: number } | null {
  const items = (ruleset as { nftables?: Record<string, unknown>[] } | null)?.nftables;
  if (!Array.isArray(items)) return null;
  let dropPackets = 0, dropBytes = 0, rules = 0;
  for (const it of items) {
    const rule = it.rule as { expr?: Record<string, unknown>[] } | undefined;
    if (!rule?.expr) continue;
    rules++;
    const counter = rule.expr.find((e) => 'counter' in e)?.counter as { packets?: number; bytes?: number } | undefined;
    if (counter && rule.expr.some((e) => 'drop' in e)) { dropPackets += counter.packets ?? 0; dropBytes += counter.bytes ?? 0; }
  }
  return { dropPackets, dropBytes, rules };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

export interface AdminOptions {
  helperPath?: string;
  /** May this request change node state? (read-only mode, roles) */
  authorize: (req: IncomingMessage) => boolean;
  /** A reason to refuse changes right now (an upgrade job is running), or null. */
  busy: () => string | null;
}

/** What the installed helper can do on this system (reported by helper v8+, derived for older ones). */
export interface HelperFeatures { config: boolean; hosts: boolean; services: boolean; firewall: 'nft' | 'pf' | 'none'; guard: 'nft' | 'pf' | 'none' }
const NO_FEATURES: HelperFeatures = { config: false, hosts: false, services: false, firewall: 'none', guard: 'none' };
export type HelperInfo = {
  installed: boolean; available: boolean; version: number | null; error?: string;
  /** Configuration editor and node management: helper v4+ with a service manager it handles. */
  managementCapable: boolean;
  features: HelperFeatures;
  serviceManager?: string; configPath?: string; hostsPath?: string;
  /** Where the firewall's drop-ins live (/etc/fips/fips.d with .nft, or $etc/pf.d with .pf). */
  firewallDropinDir?: string; firewallDropinExt?: string;
  /** fips-pub-domains binaries the helper found (v11+), whose `validate` commands check every file before it is written. */
  pubdom?: { server: boolean; resolver: boolean };
};

export function createAdminHandler(opts: AdminOptions) {
  const helperPath = opts.helperPath ?? process.env.FIPS_UI_HELPER ?? '/usr/local/libexec/fips-ui-helper';
  let helperCache: { at: number; value: HelperInfo } | null = null;
  let helperPending: Promise<HelperInfo> | null = null;

  /** Cached for a minute; concurrent callers share one in-flight check (one sudo call, not one per caller). */
  function helperInfo(force = false): Promise<HelperInfo> {
    if (!force && helperCache && Date.now() - helperCache.at < 60_000) return Promise.resolve(helperCache.value);
    if (helperPending) return helperPending;
    helperPending = checkHelper().finally(() => { helperPending = null; });
    return helperPending;
  }

  async function checkHelper(): Promise<HelperInfo> {
    let value: HelperInfo;
    if (!existsSync(helperPath)) value = { installed: false, available: false, version: null, error: `helper not installed at ${helperPath}`, managementCapable: false, features: NO_FEATURES };
    else {
      const r = await runHelper(helperPath, ['check'], undefined, 15_000);
      if (r.code !== 0) value = { installed: true, available: false, version: null, error: helperError(r), managementCapable: false, features: NO_FEATURES };
      else {
        try {
          const j = lastJson<{ ok: boolean; version: number; service_manager?: string; config_path?: string; hosts_path?: string; firewall_dropin_dir?: string; firewall_dropin_ext?: string; features?: Partial<HelperFeatures>; pubdom?: { server?: boolean; resolver?: boolean } }>(r.stdout);
          const systemd = j.service_manager === 'systemd';
          // Helpers before v8 do not report features: they did everything with systemd, nothing without it.
          const f: HelperFeatures = j.features
            ? { ...NO_FEATURES, ...j.features }
            : { config: systemd, hosts: systemd && j.version >= 6, services: systemd, firewall: systemd ? 'nft' : 'none', guard: systemd && j.version >= 5 ? 'nft' : 'none' };
          const tooOld = j.version < MIN_HELPER_VERSION;
          value = {
            installed: true, available: j.ok, version: j.version, features: f,
            managementCapable: j.ok && !tooOld && f.config,
            serviceManager: j.service_manager, configPath: j.config_path ?? '/etc/fips/fips.yaml', hostsPath: j.hosts_path ?? '/etc/fips/hosts',
            firewallDropinDir: j.firewall_dropin_dir, firewallDropinExt: j.firewall_dropin_ext,
            pubdom: j.pubdom ? { server: !!j.pubdom.server, resolver: !!j.pubdom.resolver } : undefined,
            error: tooOld ? `helper v${j.version} is too old for node management (needs v${MIN_HELPER_VERSION}); re-run deploy/setup-local.sh`
              : !f.config ? `node management is not supported with ${j.service_manager ?? 'this service manager'}` : undefined,
          };
        } catch { value = { installed: true, available: false, version: null, error: 'helper returned invalid JSON', managementCapable: false, features: NO_FEATURES }; }
      }
    }
    helperCache = { at: Date.now(), value };
    return value;
  }

  // One privileged change at a time from this process (the helper also takes a system-wide lock).
  let pending = false;
  class Conflict extends Error {}
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (pending) return Promise.reject(new Conflict('another node-management change is in progress'));
    pending = true;
    return fn().finally(() => { pending = false; });
  }

  async function requireHelper(): Promise<void> {
    const h = await helperInfo();
    if (!h.managementCapable) throw new Error(h.error ?? 'the privileged helper is not available');
  }

  /** The public-domains verbs came with helper v11; an older helper gets a precise message, not a usage error. */
  async function requirePubdomHelper(): Promise<void> {
    const h = await helperInfo();
    if (!h.managementCapable) throw new Error(h.error ?? 'the privileged helper is not available');
    if ((h.version ?? 0) < PUBDOM_HELPER_VERSION) throw new Error(`editing public domains needs helper v${PUBDOM_HELPER_VERSION} (installed: v${h.version}); run sudo ./deploy/setup-local.sh`);
  }

  async function helperJson<T>(args: string[], input?: string, timeoutMs?: number): Promise<T> {
    await requireHelper();
    const r = await runHelper(helperPath, args, input, timeoutMs);
    if (r.code !== 0) throw new Error(helperError(r));
    return lastJson<T>(r.stdout);
  }

  async function serviceAction(unit: string, action: string): Promise<{ ok: boolean; unit: string; active: boolean; enabled: string }> {
    const name = unit.replace(/\.service$/, '');
    // A stop or restart can take systemd's full 90 s stop timeout, after up to 10 s waiting for the helper lock.
    return helperJson(['service', action, name], undefined, 150_000);
  }

  /** The firewall's backend and drop-in directory, as the helper reports them. */
  async function fwTarget(): Promise<FwTarget> {
    const h = await helperInfo();
    return h.features.firewall === 'pf' && h.firewallDropinDir ? { backend: 'pf', dir: h.firewallDropinDir, ext: h.firewallDropinExt ?? '.pf' } : { backend: 'nft', dir: DROPIN_DIR, ext: '.nft' };
  }

  async function firewallStatus() {
    const fw = await fwTarget();
    const [st, dropins, units] = await Promise.all([
      helperJson<{ unit_active: boolean; unit_enabled: string; table_loaded: boolean; ruleset: unknown; summary?: { dropPackets: number; dropBytes: number; rules: number }; pf_enabled?: boolean; anchor_referenced?: boolean; anchor?: string; tun?: string; anchor_tun?: string; stale_interface?: boolean }>(['firewall-status']).catch((e: Error) => ({ error: e.message })),
      readDropins(fw),
      unitStates(),
    ]);
    const managed = dropins.find((d) => d.managed);
    return {
      backend: fw.backend, dropinDir: fw.dir, dropinExt: fw.ext,
      status: 'error' in st ? { error: st.error } : { unitActive: st.unit_active, unitEnabled: st.unit_enabled, tableLoaded: st.table_loaded, summary: st.summary ?? summariseRuleset(st.ruleset), pfEnabled: st.pf_enabled, anchorReferenced: st.anchor_referenced, anchor: st.anchor, tun: st.tun, anchorTun: st.anchor_tun, staleInterface: st.stale_interface },
      unit: units.find((u) => u.id === 'fips-firewall') ?? null,
      managedRules: managed ? parseManagedDropin(managed.content) : [],
      dropins,
    };
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/api/admin/')) return false;
    const sub = url.pathname.slice('/api/admin'.length);
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET') {
        if (sub === '/status') { sendJson(res, 200, { helper: await helperInfo(url.searchParams.get('refresh') === '1'), busy: opts.busy() }); return true; }
        if (sub === '/config') {
          await requireHelper();
          const [yaml, backups] = await Promise.all([runHelper(helperPath, ['config-show']), helperJson<{ id: string; size: number; mtime: number }[]>(['config-backups'])]);
          if (yaml.code !== 0) throw new Error(helperError(yaml));
          const nl = yaml.stdout.indexOf('\n');
          const base = /^base [0-9a-f]{64}$/.test(yaml.stdout.slice(0, nl)) ? yaml.stdout.slice(5, nl) : '';
          sendJson(res, 200, { yaml: base ? yaml.stdout.slice(nl + 1) : yaml.stdout, base, backups, path: (await helperInfo()).configPath ?? '/etc/fips/fips.yaml' }); return true;
        }
        if (sub === '/config/backup') {
          await requireHelper();
          const id = url.searchParams.get('id') ?? '';
          if (!/^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(id)) throw new BodyError(400, 'invalid backup id');
          const r = await runHelper(helperPath, ['config-show', id]);
          if (r.code !== 0) throw new Error(helperError(r));
          sendJson(res, 200, { id, yaml: r.stdout.replace(/^base [0-9a-f]{64}\n/, '') }); return true;
        }
        if (sub === '/firewall') { sendJson(res, 200, await firewallStatus()); return true; }
        if (sub === '/address') { sendJson(res, 200, { npub: url.searchParams.get('npub'), address: await meshAddress(url.searchParams.get('npub') ?? '') }); return true; }
        sendJson(res, 404, { error: 'not found' }); return true;
      }

      if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      if (!opts.authorize(req)) { sendJson(res, 403, { error: 'not allowed to change node state' }); return true; }
      const busy = opts.busy();
      if (busy) { sendJson(res, 409, { error: busy }); return true; }
      // The lock is taken before the body is read, so an upgrade cannot start in that window.
      return await exclusive(async () => {
      // fips.yaml may be up to 256 KiB, which JSON escaping can roughly double.
      const body = await readJsonBody(req, sub === '/config' ? 1024 * 1024 : undefined);

      if (sub === '/config') {
        const yaml = body.yaml;
        if (typeof yaml !== 'string' || !yaml.trim()) throw new BodyError(400, 'yaml (non-empty string) required');
        if (Buffer.byteLength(yaml) > 256 * 1024) throw new BodyError(400, 'configuration larger than 256 KiB');
        if (body.restart !== undefined && typeof body.restart !== 'boolean') throw new BodyError(400, 'restart must be a boolean');
        if (typeof body.base !== 'string' || !/^[0-9a-f]{64}$/.test(body.base)) throw new BodyError(400, 'base (the hash returned with the configuration) required');
        const result = await helperJson<Record<string, unknown>>(['config-apply', ...(body.restart === false ? ['--no-restart'] : []), '--base', body.base], yaml, HELPER_RESTART_TIMEOUT);
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/log-access') {
        // Let the fips group read the daemon's log file (FreeBSD creates it root-only), so the Logs page works.
        const result = await helperJson<Record<string, unknown>>(['log-access']);
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/config/restore') {
        const id = body.id;
        if (typeof id !== 'string' || !/^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(id)) throw new BodyError(400, 'id (backup id string) required');
        const result = await helperJson<Record<string, unknown>>(['config-restore', id], undefined, HELPER_RESTART_TIMEOUT);
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/firewall/rules') {
        if (!Array.isArray(body.rules)) throw new BodyError(400, 'rules (array) required');
        // Tagged rules (mesh access) belong to the UI itself: whatever a possibly stale page sends for them is
        // replaced by the rules currently on disk.
        const fw = await fwTarget();
        const managed = (await readDropins(fw)).find((d) => d.managed);
        const kept = managed ? parseManagedDropinStrict(managed.content).rules.filter((r) => r.tag) : [];
        const rules = [...body.rules.map(validateRule).filter((r: FirewallRule) => !r.tag), ...kept];
        const result = await (rules.length === 0
          ? (existsSync(join(fw.dir, `${MANAGED_DROPIN}${fw.ext}`)) ? helperJson<Record<string, unknown>>(['dropin-delete', MANAGED_DROPIN]) : { ok: true, reloaded: false })
          : helperJson<Record<string, unknown>>(['dropin-apply', MANAGED_DROPIN], await renderManagedDropin(rules, fw.backend)));
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/firewall/dropin') {
        const { name, content } = body as { name?: unknown; content?: unknown };
        if (typeof name !== 'string' || !DROPIN_RE.test(name)) throw new BodyError(400, 'name must match [a-z0-9][a-z0-9_-]{0,40}');
        if (name === MANAGED_DROPIN) throw new BodyError(400, `the ${MANAGED_DROPIN} drop-in is managed through the rules editor`);
        if (typeof content !== 'string' || !content.trim()) throw new BodyError(400, 'content (non-empty string) required');
        const result = await helperJson<Record<string, unknown>>(['dropin-apply', name], content.endsWith('\n') ? content : content + '\n');
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/firewall/dropin/delete') {
        const name = body.name;
        if (typeof name !== 'string' || !DROPIN_RE.test(name)) throw new BodyError(400, 'invalid drop-in name');
        sendJson(res, 200, await helperJson<Record<string, unknown>>(['dropin-delete', name])); return true;
      }
      // Public domains (server/pubdom.ts, docs/public-domains.md): files through the helper, which validates
      // them with the fips-pub-domains binaries; actions over the control sockets, which trust whoever can open them.
      if (sub === '/pubdom/zone') {
        const { file, content, base } = body as { file?: unknown; content?: unknown; base?: unknown };
        if (typeof file !== 'string' || !ZONE_FILE_RE.test(file) || file.includes('..')) throw new BodyError(400, 'file must be a plain <name>.yaml');
        if (typeof content !== 'string' || !content.trim()) throw new BodyError(400, 'content (non-empty string) required');
        if (typeof base !== 'string' || !/^([0-9a-f]{64}|none)$/.test(base)) throw new BodyError(400, 'base (sha256 or none) required');
        await requirePubdomHelper();
        // The directory the running server follows goes along: the helper refuses to write anywhere else.
        const result = await helperJson<Record<string, unknown>>(['pubdom-zone-apply', file, '--base', base, '--dir', await liveZonesDir()], content.endsWith('\n') ? content : content + '\n');
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/pubdom/zone/delete') {
        const file = body.file;
        if (typeof file !== 'string' || !ZONE_FILE_RE.test(file) || file.includes('..')) throw new BodyError(400, 'file must be a plain <name>.yaml');
        await requirePubdomHelper();
        sendJson(res, 200, await helperJson<Record<string, unknown>>(['pubdom-zone-delete', file, '--dir', await liveZonesDir()])); return true;
      }
      if (sub === '/pubdom/config') {
        const { side, yaml, base, restart } = body as { side?: unknown; yaml?: unknown; base?: unknown; restart?: unknown };
        if (typeof side !== 'string' || !isPubdomSide(side)) throw new BodyError(400, 'side must be server or resolver');
        if (typeof yaml !== 'string' || !yaml.trim()) throw new BodyError(400, 'yaml (non-empty string) required');
        if (typeof base !== 'string' || !/^([0-9a-f]{64}|none)$/.test(base)) throw new BodyError(400, 'base (sha256 or none) required');
        await requirePubdomHelper();
        const result = await helperJson<Record<string, unknown>>(['pubdom-config-apply', side, ...(restart === false ? ['--no-restart'] : []), '--base', base], yaml.endsWith('\n') ? yaml : yaml + '\n', HELPER_RESTART_TIMEOUT);
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/pubdom/action') {
        const { side, command, domain } = body as { side?: unknown; command?: unknown; domain?: unknown };
        if (typeof side !== 'string' || !isPubdomSide(side)) throw new BodyError(400, 'side must be server or resolver');
        if (typeof command !== 'string' || !PUBDOM_WRITE[side].has(command)) throw new BodyError(400, `command must be one of ${[...PUBDOM_WRITE[side]].join(', ')}`);
        if (domain !== undefined && (typeof domain !== 'string' || !DOMAIN_RE.test(domain))) throw new BodyError(400, 'domain must be a domain name');
        if ((command === 'check-dns' || command === 'forget') && domain === undefined) throw new BodyError(400, 'domain required');
        sendJson(res, 200, { ok: true, result: await pubdomQuery(side, command, domain === undefined ? undefined : { domain }) }); return true;
      }
      if (sub === '/service') {
        const { unit, action } = body as { unit?: unknown; action?: unknown };
        if (typeof unit !== 'string' || !/^(fips|fips-firewall|fips-dns|fips-gateway|fips-pubdom|fips-pubdom-server)(\.service)?$/.test(unit)) throw new BodyError(400, 'unit must be fips, fips-firewall, fips-dns, fips-gateway, fips-pubdom or fips-pubdom-server');
        if (typeof action !== 'string' || !['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) throw new BodyError(400, 'invalid action');
        sendJson(res, 200, await serviceAction(unit, action)); return true;
      }
        sendJson(res, 404, { error: 'not found' }); return true;
      });
    } catch (e) {
      if (e instanceof Conflict || e instanceof PubdomStateError) sendJson(res, 409, { error: e.message });
      else if (e instanceof BodyError) sendJson(res, e.status, { error: e.message }, e.status === 413);
      else sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return true;
    }
  };

  /** Replace the managed rules through a pure function of the current ones (used by mesh access). */
  function updateManagedRules(mutate: (rules: FirewallRule[]) => FirewallRule[]): Promise<Record<string, unknown>> {
    const busy = opts.busy();
    if (busy) return Promise.reject(new Error(busy));
    return exclusive(async () => {
      await requireHelper();
      const fw = await fwTarget();
      const managed = (await readDropins(fw)).find((d) => d.managed);
      const current = managed ? parseManagedDropinStrict(managed.content) : { rules: [], invalid: 0 };
      if (current.invalid) throw new Error(`${MANAGED_DROPIN}.nft has ${current.invalid} rule definition(s) that no longer validate; fix them on the Firewall page first so they are not lost`);
      const next = mutate(current.rules).map(validateRule);
      if (next.length === 0) return managed ? helperJson<Record<string, unknown>>(['dropin-delete', MANAGED_DROPIN]) : { ok: true, reloaded: false };
      const content = await renderManagedDropin(next, fw.backend);
      // Unchanged rules need no write and no firewall reload.
      if (managed && managed.content === content) return { ok: true, reloaded: false, unchanged: true };
      return helperJson<Record<string, unknown>>(['dropin-apply', MANAGED_DROPIN], content);
    });
  }

  /** Load or remove the kernel guard that makes fd00::/8 source addresses trustworthy (see server/access.ts). */
  async function meshGuard(ports: number[] | null, tun: string, canary?: number): Promise<{ ok: boolean; error?: string }> {
    const h = await helperInfo();
    // The nftables guard came with helper v5, the pf guard with v8.
    const need = h.features.guard === 'pf' ? 8 : GUARD_HELPER_VERSION;
    // A helper older than the guard (or one without a guard here) cannot have loaded it: "off" is trivially satisfied.
    if (!(ports && ports.length) && ((h.version ?? 0) < need || h.features.guard === 'none')) return { ok: true };
    if (h.available && h.features.guard === 'none') return { ok: false, error: 'the spoofing guard is not supported on this system, so mesh access stays off' };
    if (!h.available || (h.version ?? 0) < need) return { ok: false, error: `mesh access needs helper v${need} or newer (installed: ${h.version ? `v${h.version}` : 'none'}); install it from the fips-ui directory` };
    const r = await runHelper(helperPath, ['mesh-guard', ports && ports.length ? ports.join(',') : 'off', tun, ...(canary ? [String(canary)] : [])], undefined, 30_000);
    if (r.code !== 0) return { ok: false, error: helperError(r) };
    return lastJson<{ ok: boolean; error?: string }>(r.stdout);
  }

  /** Read-only: is the guard loaded, and for which ports and interface? */
  async function meshGuardStatus(): Promise<{ active: boolean; ports: number[]; tun: string; canary: number } | null> {
    const h = await helperInfo();
    if (!h.available || h.features.guard === 'none' || (h.version ?? 0) < (h.features.guard === 'pf' ? 8 : GUARD_HELPER_VERSION)) return null;
    const r = await runHelper(helperPath, ['mesh-guard', 'status'], undefined, 15_000);
    if (r.code !== 0) return null;
    try { const j = lastJson<{ active: boolean; ports?: string; tun?: string; canary?: string }>(r.stdout); return { active: j.active, ports: (j.ports ?? '').split(',').filter(Boolean).map(Number), tun: j.tun ?? '', canary: Number(j.canary ?? 0) }; }
    catch { return null; }
  }

  /** Replace /etc/fips/hosts through the helper; `base` is the hash of the file the change was made on. */
  async function hostsApply(content: string, base: string): Promise<{ ok: boolean; changed?: boolean; error?: string }> {
    const busy = opts.busy();
    if (busy) throw new Error(busy);
    const h = await helperInfo();
    if ((h.version ?? 0) < HOSTS_HELPER_VERSION) throw new Error(`editing the hosts file needs helper v${HOSTS_HELPER_VERSION} (installed: ${h.version ? `v${h.version}` : 'none'}); run sudo ./deploy/setup-local.sh`);
    return exclusive(() => helperJson(['hosts-apply', '--base', base], content));
  }

  /** fips.yaml with secrets redacted, and the hash of the exact bytes it came from. */
  async function configShow(): Promise<{ yaml: string; base: string }> {
    await requireHelper();
    const r = await runHelper(helperPath, ['config-show']);
    if (r.code !== 0) throw new Error(helperError(r));
    const nl = r.stdout.indexOf('\n');
    const base = /^base [0-9a-f]{64}$/.test(r.stdout.slice(0, nl)) ? r.stdout.slice(5, nl) : '';
    if (!base) throw new Error('the helper did not report the configuration hash');
    return { yaml: r.stdout.slice(nl + 1), base };
  }

  /**
   * Apply a redacted fips.yaml (secrets restored by the helper), restart and roll back if the daemon does not stay
   * up. For the upgrade job itself, which the HTTP route would refuse as "busy".
   */
  function configApply(yaml: string, base: string): Promise<{ ok: boolean; changed?: boolean; restarted?: boolean; error?: string; backup_id?: string }> {
    return exclusive(() => helperJson(['config-apply', '--base', base], yaml, HELPER_RESTART_TIMEOUT));
  }

  /** Reinstall a config backup (restart and health check, rolled back if the daemon does not stay up). */
  function configRestore(id: string): Promise<{ ok: boolean; error?: string }> {
    return exclusive(() => helperJson(['config-restore', id], undefined, HELPER_RESTART_TIMEOUT));
  }

  return Object.assign(handler, {
    helperInfo,
    hostsApply,
    configShow,
    configApply,
    configRestore,
    meshGuard,
    meshGuardStatus,
    updateManagedRules,
    /** True while a node-management change is running (upgrades must not start then). */
    changePending: () => pending,
    serviceAction: (unit: string, action: string) => { const b = opts.busy(); return b ? Promise.reject(new Error(b)) : exclusive(() => serviceAction(unit, action)); },
  });
}
