// Node management: fips.yaml, the fips0 firewall and the fips systemd units.
//
// Everything here needs root and goes through the privileged helper (scripts/fips-ui-helper, v4+) via the
// same single sudoers rule the upgrade flow uses. The backend never sees secret config values: the helper
// redacts them on read and restores them on write. File contents travel on the helper's stdin, never as
// paths, so nothing can be swapped between validation and install.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMeshPrefix } from './net6.ts';
import { readJsonBody, BodyError, sendJson } from './http.ts';
import { unitStates } from './system.ts';

export const MIN_HELPER_VERSION = 4;
// Worst case for config-apply: stop timeout (90 s) + health window (45 s), twice when it rolls back, plus margin.
// The helper ignores SIGTERM during install and rollback, so hitting this only abandons the wait.
const HELPER_RESTART_TIMEOUT = 330_000;
// Readable without privileges; overridable only so tests can point it at a scratch copy.
const DROPIN_DIR = process.env.FIPS_UI_DROPIN_DIR ?? '/etc/fips/fips.d';
export const MANAGED_DROPIN = 'fips-ui';
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;
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

export async function renderManagedDropin(rules: FirewallRule[]): Promise<string> {
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
    out.push(`${saddr}${r.proto} dport ${ports} accept${comment ? ` comment "${comment}"` : ''}`);
  }
  return out.join('\n') + '\n';
}

export function parseManagedDropin(text: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const line of text.split('\n')) {
    const m = /^# fips-ui-rule (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try { rules.push(validateRule(JSON.parse(m[1]))); } catch { /* skip a corrupted definition rather than fail the page */ }
  }
  return rules;
}

async function readDropins(): Promise<{ name: string; content: string; size: number; mtime: number; managed: boolean }[]> {
  if (!existsSync(DROPIN_DIR)) return [];
  const names = (await readdir(DROPIN_DIR)).filter((n) => n.endsWith('.nft')).sort();
  return Promise.all(names.map(async (n) => {
    const p = join(DROPIN_DIR, n);
    const [content, st] = await Promise.all([readFile(p, 'utf8').catch(() => ''), stat(p)]);
    const name = n.slice(0, -4);
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

export type HelperInfo = { available: boolean; version: number | null; error?: string; managementCapable: boolean };

export function createAdminHandler(opts: AdminOptions) {
  const helperPath = opts.helperPath ?? process.env.FIPS_UI_HELPER ?? '/usr/local/libexec/fips-ui-helper';
  let helperCache: { at: number; value: HelperInfo } | null = null;

  async function helperInfo(force = false): Promise<HelperInfo> {
    if (!force && helperCache && Date.now() - helperCache.at < 60_000) return helperCache.value;
    let value: HelperInfo;
    if (!existsSync(helperPath)) value = { available: false, version: null, error: `helper not installed at ${helperPath}`, managementCapable: false };
    else {
      const r = await runHelper(helperPath, ['check'], undefined, 15_000);
      if (r.code !== 0) value = { available: false, version: null, error: helperError(r), managementCapable: false };
      else {
        try { const j = lastJson<{ ok: boolean; version: number }>(r.stdout); value = { available: j.ok, version: j.version, managementCapable: j.ok && j.version >= MIN_HELPER_VERSION, error: j.version < MIN_HELPER_VERSION ? `helper v${j.version} is too old for node management (needs v${MIN_HELPER_VERSION}); re-run deploy/setup-local.sh` : undefined }; }
        catch { value = { available: false, version: null, error: 'helper returned invalid JSON', managementCapable: false }; }
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

  async function firewallStatus() {
    const [st, dropins, units] = await Promise.all([
      helperJson<{ unit_active: boolean; unit_enabled: string; table_loaded: boolean; ruleset: unknown }>(['firewall-status']).catch((e: Error) => ({ error: e.message })),
      readDropins(),
      unitStates(),
    ]);
    const managed = dropins.find((d) => d.managed);
    return {
      status: 'error' in st ? { error: st.error } : { unitActive: st.unit_active, unitEnabled: st.unit_enabled, tableLoaded: st.table_loaded, summary: summariseRuleset(st.ruleset) },
      unit: units.find((u) => u.unit === 'fips-firewall.service') ?? null,
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
          sendJson(res, 200, { yaml: base ? yaml.stdout.slice(nl + 1) : yaml.stdout, base, backups, path: '/etc/fips/fips.yaml' }); return true;
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
      if (sub === '/config/restore') {
        const id = body.id;
        if (typeof id !== 'string' || !/^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(id)) throw new BodyError(400, 'id (backup id string) required');
        const result = await helperJson<Record<string, unknown>>(['config-restore', id], undefined, HELPER_RESTART_TIMEOUT);
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/firewall/rules') {
        if (!Array.isArray(body.rules)) throw new BodyError(400, 'rules (array) required');
        const rules = body.rules.map(validateRule);
        const result = await (rules.length === 0
          ? (existsSync(join(DROPIN_DIR, `${MANAGED_DROPIN}.nft`)) ? helperJson<Record<string, unknown>>(['dropin-delete', MANAGED_DROPIN]) : { ok: true, reloaded: false })
          : helperJson<Record<string, unknown>>(['dropin-apply', MANAGED_DROPIN], await renderManagedDropin(rules)));
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/firewall/dropin') {
        const { name, content } = body as { name?: unknown; content?: unknown };
        if (typeof name !== 'string' || !DROPIN_RE.test(name)) throw new BodyError(400, 'name must match [a-z0-9][a-z0-9_-]{0,40}');
        if (name === MANAGED_DROPIN) throw new BodyError(400, `${MANAGED_DROPIN}.nft is managed through the rules editor`);
        if (typeof content !== 'string' || !content.trim()) throw new BodyError(400, 'content (non-empty string) required');
        const result = await helperJson<Record<string, unknown>>(['dropin-apply', name], content.endsWith('\n') ? content : content + '\n');
        sendJson(res, result.ok ? 200 : 422, result); return true;
      }
      if (sub === '/firewall/dropin/delete') {
        const name = body.name;
        if (typeof name !== 'string' || !DROPIN_RE.test(name)) throw new BodyError(400, 'invalid drop-in name');
        sendJson(res, 200, await helperJson<Record<string, unknown>>(['dropin-delete', name])); return true;
      }
      if (sub === '/service') {
        const { unit, action } = body as { unit?: unknown; action?: unknown };
        if (typeof unit !== 'string' || !/^(fips|fips-firewall|fips-dns|fips-gateway)(\.service)?$/.test(unit)) throw new BodyError(400, 'unit must be fips, fips-firewall, fips-dns or fips-gateway');
        if (typeof action !== 'string' || !['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) throw new BodyError(400, 'invalid action');
        sendJson(res, 200, await serviceAction(unit, action)); return true;
      }
        sendJson(res, 404, { error: 'not found' }); return true;
      });
    } catch (e) {
      if (e instanceof Conflict) sendJson(res, 409, { error: e.message });
      else if (e instanceof BodyError) sendJson(res, e.status, { error: e.message }, e.status === 413);
      else sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return true;
    }
  };

  return Object.assign(handler, {
    helperInfo,
    /** True while a node-management change is running (upgrades must not start then). */
    changePending: () => pending,
    serviceAction: (unit: string, action: string) => { const b = opts.busy(); return b ? Promise.reject(new Error(b)) : exclusive(() => serviceAction(unit, action)); },
  });
}
