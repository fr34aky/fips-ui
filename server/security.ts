// The weekly security scan: the privileged helper's `security-scan` gathers raw output of a fixed set of read-only
// commands (scripts/fips-ui-helper), and everything here turns it into a report: listeners and whether the host
// firewall lets them through, pending and security updates, known vulnerabilities from the distribution's own
// tools, reboot needs and a few hardening checks, scored 0-100 (docs/security-scan.md). Parsing and scoring are pure
// functions; the scanner keeps the schedule and the newest reports.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category = 'exposure' | 'firewall' | 'patches' | 'vulns' | 'hardening';
export const CATEGORIES: Category[] = ['exposure', 'firewall', 'patches', 'vulns', 'hardening'];
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Points one finding takes off the score, and the most a category can take (docs/security-scan.md). */
export const DEDUCTION: Record<Severity, number> = { critical: 25, high: 10, medium: 5, low: 2, info: 0 };
export const CATEGORY_CAP: Record<Category, number> = { exposure: 30, firewall: 20, patches: 20, vulns: 20, hardening: 15 };
/** A critical finding keeps the score below this, whatever else is fine. */
export const CRITICAL_CEILING = 59;

export interface Finding { id: string; category: Category; severity: Severity; title: string; detail?: string; fix?: string }

/** The raw helper answer. */
export interface RawSection { code: number; out: string }
export interface RawScan { ok: boolean; version: number; pm: string; nixos: boolean; started: number; finished: number; sections: Record<string, RawSection> }

// ---------------------------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------------------------

export type Scope = 'loopback' | 'link-local' | 'mesh' | 'lan' | 'public' | 'all';
/** What the host firewall does with a new connection to a listener from that side. `none`: no input filtering at all. */
export type Verdict = 'blocked' | 'restricted' | 'allowed' | 'unknown' | 'none';
export interface Listener {
  proto: 'tcp' | 'udp'; addr: string; port: number; iface?: string; process?: string; pid?: number;
  scope: Scope;
  /** UDP sockets in the ephemeral port range are clients' (DNS, mDNS, QUIC, WebRTC), not services: listed, never scored. */
  ephemeral?: boolean;
  /** From the LAN and beyond (any interface but loopback and fips0), and from the mesh (fips0), where it applies. */
  lan?: Verdict; mesh?: Verdict;
}

/** Linux's default ephemeral range (net.ipv4.ip_local_port_range), where unconnected UDP client sockets land. */
const EPHEMERAL_MIN = 32768, EPHEMERAL_MAX = 60999;

/** Split ss's "addr:port" (IPv4, [IPv6], *, with an optional %iface). */
function splitAddr(s: string): { addr: string; port: number; iface?: string } | null {
  const m = /^(\[[^\]]*\]|[^%\s]*?)(?:%([^:\s\]]+))?:(\d+|\*)$/.exec(s);
  if (!m || m[3] === '*') return null;
  let addr = m[1];
  if (addr.startsWith('[')) addr = addr.slice(1, -1);
  // ss prints a link-local scope inside the brackets on some versions: [fe80::1%eth0].
  let iface = m[2];
  const pct = addr.indexOf('%');
  if (pct >= 0) { iface ??= addr.slice(pct + 1); addr = addr.slice(0, pct); }
  return { addr: addr.toLowerCase(), port: Number(m[3]), ...(iface ? { iface } : {}) };
}

const v4 = (a: string): number[] | null => { const p = a.split('.').map(Number); return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? p : null; };

export function scopeOf(addr: string, iface: string | undefined, tun: string | undefined, meshAddr: string | undefined): Scope {
  if (iface === 'lo') return 'loopback';
  if (iface && tun && iface === tun) return 'mesh';
  const a = addr.replace(/^::ffff:/, '');
  // Bound to every address of one interface (SO_BINDTODEVICE, e.g. dnsmasq on a bridge): that interface's network.
  if (a === '*' || a === '0.0.0.0' || a === '::' || a === '') return iface ? 'lan' : 'all';
  const q = v4(a);
  if (q) {
    if (q[0] === 127) return 'loopback';
    // Link-local and multicast groups are not routed beyond the link.
    if ((q[0] === 169 && q[1] === 254) || (q[0] >= 224 && q[0] <= 239)) return 'link-local';
    if (q[0] === 10 || (q[0] === 172 && q[1] >= 16 && q[1] <= 31) || (q[0] === 192 && q[1] === 168) || (q[0] === 100 && q[1] >= 64 && q[1] <= 127)) return 'lan';
    return 'public';
  }
  if (a === '::1') return 'loopback';
  if (/^fe[89ab]/.test(a) || /^ff/.test(a)) return 'link-local';
  if (meshAddr && a === meshAddr.toLowerCase()) return 'mesh';
  if (/^f[cd]/.test(a)) return 'lan';
  return 'public';
}

/** `ss -Htulnp`: one line per socket; process names only as root. Duplicates (one socket per worker) are merged. */
export function parseSs(out: string, tun?: string, meshAddr?: string): Listener[] {
  const seen = new Map<string, Listener>();
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 5 || (t[0] !== 'tcp' && t[0] !== 'udp')) continue;
    if (t[0] === 'tcp' && t[1] !== 'LISTEN') continue;
    const local = splitAddr(t[4]);
    if (!local) continue;
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    const key = `${t[0]} ${local.addr} ${local.iface ?? ''} ${local.port}`;
    if (seen.has(key)) continue;
    const scope = scopeOf(local.addr, local.iface, tun, meshAddr);
    seen.set(key, {
      proto: t[0], addr: local.addr, port: local.port, ...(local.iface ? { iface: local.iface } : {}),
      ...(users ? { process: users[1], pid: Number(users[2]) } : {}), scope,
      ...(t[0] === 'udp' && local.port >= EPHEMERAL_MIN && local.port <= EPHEMERAL_MAX ? { ephemeral: true } : {}),
    });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

const isV4 = (addr: string) => !!v4(addr.replace(/^::ffff:/, ''));

// ---------------------------------------------------------------------------------------------
// Firewall: the input path for a new connection, from the nftables ruleset (nft -j), ufw or firewalld
// ---------------------------------------------------------------------------------------------

export interface Probe { proto: 'tcp' | 'udp'; port: number; family: 'ip' | 'ip6'; /** the arriving interface: the TUN, or '*' (any but lo and the TUN) */ iface: string; tun?: string }
export interface FirewallModel {
  backend: 'nft' | 'ufw' | 'firewalld' | 'iptables' | 'none' | 'unknown';
  /** Whether new inbound connections are refused unless allowed (some base chain drops by default). */
  defaultDeny: boolean | null;
  detail?: string;
  /** The verdict for one hypothetical new connection. */
  verdict: (p: Probe) => Verdict;
}

type Nft = { nftables?: Record<string, unknown>[] };
interface NftChain { family: string; table: string; name: string; hook?: string; type?: string; policy?: string; prio?: number }
interface NftRule { family: string; table: string; chain: string; expr: Record<string, unknown>[] }

type Cond = 'yes' | 'no' | 'cond' | 'unknown';
const NEUTRAL = new Set(['counter', 'log', 'limit', 'comment', 'quota', 'notrack', 'mangle', 'meter', 'set', 'xt_counter', 'ct count']);

function portIn(right: unknown, port: number): Cond {
  if (typeof right === 'number') return right === port ? 'yes' : 'no';
  if (typeof right === 'string') return /^\d+$/.test(right) ? (Number(right) === port ? 'yes' : 'no') : right.startsWith('@') ? 'unknown' : 'unknown';
  if (right && typeof right === 'object') {
    const r = right as { set?: unknown[]; range?: [unknown, unknown] };
    if (Array.isArray(r.range)) return Number(r.range[0]) <= port && port <= Number(r.range[1]) ? 'yes' : 'no';
    if (Array.isArray(r.set)) {
      let unknown = false;
      for (const e of r.set) { const c = portIn(e, port); if (c === 'yes') return 'yes'; if (c === 'unknown') unknown = true; }
      return unknown ? 'unknown' : 'no';
    }
  }
  return 'unknown';
}

const glob = (pattern: string, s: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(s);
const negate = (c: Cond, op: string): Cond => (op === '!=' ? (c === 'yes' ? 'no' : c === 'no' ? 'yes' : c) : c);
const L4 = new Set(['tcp', 'udp', 'th']);
const KNOWN_L4 = new Set(['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'dccp', 'udplite', 'esp', 'ah', 'gre', 'igmp']);

/** Does one nft `match` hold for the probe? 'cond': it depends on what the probe does not fix (source address, …). */
function matchCond(m: { op?: string; left?: Record<string, unknown>; right?: unknown }, p: Probe): Cond {
  const op = m.op ?? '==';
  const left = m.left ?? {};
  const payload = left.payload as { protocol?: string; field?: string } | undefined;
  const meta = (left.meta as { key?: string } | undefined)?.key;
  const ct = (left.ct as { key?: string } | undefined)?.key;
  if (payload?.protocol) {
    const proto = payload.protocol;
    if (L4.has(proto) && (payload.field === 'dport')) {
      if (proto !== 'th' && proto !== p.proto) return op === '!=' ? 'cond' : 'no';
      return negate(portIn(m.right, p.port), op);
    }
    if (L4.has(proto) && proto !== 'th' && proto !== p.proto) return op === '!=' ? 'cond' : 'no';
    if (KNOWN_L4.has(proto) && proto !== p.proto && !L4.has(proto)) return 'no';
    if ((proto === 'ip' && p.family === 'ip6') || (proto === 'ip6' && p.family === 'ip')) return 'no';
    if ((proto === 'ip' || proto === 'ip6') && (payload.field === 'nexthdr' || payload.field === 'protocol')) {
      const r = m.right;
      if (typeof r === 'string') return negate(r === p.proto ? 'yes' : 'no', op);
      return 'unknown';
    }
    // Source address, sport, flags, …: depends on the sender.
    return 'cond';
  }
  if (meta === 'l4proto' || meta === 'protocol') {
    const r = m.right;
    if (typeof r === 'string' && meta === 'l4proto') return negate(r === p.proto ? 'yes' : 'no', op);
    if (typeof r === 'string' && meta === 'protocol') return negate(r === p.family ? 'yes' : 'no', op);
    if (r && typeof r === 'object' && Array.isArray((r as { set?: unknown[] }).set)) return negate((r as { set: unknown[] }).set.includes(meta === 'l4proto' ? p.proto : p.family) ? 'yes' : 'no', op);
    return 'unknown';
  }
  if (meta === 'nfproto') {
    const fam = p.family === 'ip' ? 'ipv4' : 'ipv6';
    if (typeof m.right === 'string') return negate(m.right === fam ? 'yes' : 'no', op);
    return 'unknown';
  }
  if (meta === 'iifname' || meta === 'iif') {
    const names = typeof m.right === 'string' ? [m.right] : Array.isArray((m.right as { set?: unknown[] })?.set) ? ((m.right as { set: unknown[] }).set.filter((x) => typeof x === 'string') as string[]) : null;
    if (!names) return 'unknown';
    if (p.iface !== '*') return negate(names.some((n) => glob(n, p.iface)) ? 'yes' : 'no', op);
    // Any interface but loopback and the TUN: "lo" and the TUN never match, any other name depends on the interface.
    const others = names.filter((n) => !glob(n, 'lo') && !(p.tun && glob(n, p.tun)));
    if (op === '!=') return others.length === 0 ? 'yes' : 'cond';
    return others.length === 0 ? 'no' : 'cond';
  }
  if (meta === 'pkttype') return 'cond';
  if (ct === 'state') {
    const states = typeof m.right === 'string' ? [m.right] : Array.isArray(m.right) ? (m.right as string[]) : Array.isArray((m.right as { set?: unknown[] })?.set) ? ((m.right as { set: string[] }).set) : null;
    if (!states) return 'unknown';
    const has = states.includes('new');
    return op === '!=' ? (has ? 'no' : 'yes') : has ? 'yes' : 'no';
  }
  if (left.fib) return 'cond';
  return 'unknown';
}

/** `skip`: "family table" names another model reads (ufw's iptables-nft tables, firewalld's own). */
export function nftModel(json: string, skip: Set<string> = new Set()): FirewallModel | null {
  let doc: Nft;
  try { doc = JSON.parse(json) as Nft; } catch { return null; }
  if (!Array.isArray(doc.nftables)) return null;
  const chains = new Map<string, NftChain>();
  const rules = new Map<string, NftRule[]>();
  const key = (family: string, table: string, name: string) => `${family}\0${table}\0${name}`;
  for (const item of doc.nftables) {
    if (item.chain) { const c = item.chain as NftChain; chains.set(key(c.family, c.table, c.name), c); }
    if (item.rule) { const r = item.rule as NftRule; const k = key(r.family, r.table, r.chain); (rules.get(k) ?? rules.set(k, []).get(k)!).push(r); }
  }
  const bases = [...chains.values()].filter((c) => c.hook === 'input' && (c.type ?? 'filter') === 'filter' && ['inet', 'ip', 'ip6'].includes(c.family) && !skip.has(`${c.family} ${c.table}`));
  if (bases.length === 0) return { backend: 'none', defaultDeny: false, detail: 'no nftables input chain', verdict: () => 'none' };

  type Outcome = { v: 'accept' | 'drop' | 'return' | 'end'; restricted: boolean; unknown: boolean };
  function run(c: NftChain, p: Probe, depth: number): Outcome {
    let restricted = false, unknown = false;
    for (const r of rules.get(key(c.family, c.table, c.name)) ?? []) {
      let cond: Cond = 'yes';
      let verdict: { kind: 'accept' | 'drop' | 'return' | 'jump'; target?: string } | null = null;
      for (const e of r.expr ?? []) {
        const k = Object.keys(e)[0];
        if (k === 'match') {
          const c2 = matchCond(e.match as Parameters<typeof matchCond>[0], p);
          if (c2 === 'no') { cond = 'no'; break; }
          if (c2 === 'unknown') cond = 'unknown';
          else if (c2 === 'cond' && cond === 'yes') cond = 'cond';
        } else if (k === 'accept') verdict = { kind: 'accept' };
        else if (k === 'drop' || k === 'reject') verdict = { kind: 'drop' };
        else if (k === 'return') verdict = { kind: 'return' };
        else if (k === 'jump' || k === 'goto') verdict = { kind: 'jump', target: (e[k] as { target?: string })?.target };
        else if (NEUTRAL.has(k)) continue;
        else if (cond === 'yes') cond = 'unknown';
      }
      if (cond === 'no' || !verdict) continue;
      if (verdict.kind === 'jump') {
        const target = verdict.target ? chains.get(key(c.family, c.table, verdict.target)) : undefined;
        if (!target || depth > 16) { unknown = true; continue; }
        const o = run(target, p, depth + 1);
        restricted ||= o.restricted; unknown ||= o.unknown;
        if (o.v === 'accept' || o.v === 'drop') {
          if (cond === 'yes') return { v: o.v, restricted, unknown };
          if (o.v === 'accept') { if (cond === 'cond') restricted = true; else unknown = true; }
        }
        continue;
      }
      if (cond === 'yes') return { v: verdict.kind, restricted, unknown };
      // A conditional accept lets some senders in; a conditional drop or return changes nothing for the others.
      if (verdict.kind === 'accept') { if (cond === 'cond') restricted = true; else unknown = true; }
    }
    return { v: 'end', restricted, unknown };
  }

  const verdict = (p: Probe): Verdict => {
    const results: Verdict[] = [];
    for (const c of bases) {
      if ((c.family === 'ip' && p.family !== 'ip') || (c.family === 'ip6' && p.family !== 'ip6')) continue;
      const o = run(c, p, 0);
      const policyDrop = c.policy === 'drop';
      // A drop reached after conditional accepts refuses only the senders those did not let in.
      if (o.v === 'drop') results.push(o.restricted ? 'restricted' : o.unknown ? 'unknown' : 'blocked');
      else if (o.v === 'accept') results.push(o.restricted ? 'restricted' : o.unknown ? 'unknown' : 'allowed');
      else if (!policyDrop) results.push('allowed');
      else results.push(o.unknown ? 'unknown' : o.restricted ? 'restricted' : 'blocked');
    }
    if (results.length === 0) return 'none';
    // Every base chain on the hook must accept the packet.
    if (results.includes('blocked')) return 'blocked';
    if (results.includes('unknown')) return 'unknown';
    if (results.includes('restricted')) return 'restricted';
    return 'allowed';
  };
  // Default deny: a probe to a port nothing names is refused from any interface.
  const sample = (family: 'ip' | 'ip6') => verdict({ proto: 'tcp', port: 1, family, iface: '*' });
  const defaultDeny = sample('ip') === 'blocked' && sample('ip6') === 'blocked';
  const tables = [...new Set(bases.map((c) => `${c.family} ${c.table}`))];
  return { backend: 'nft', defaultDeny, detail: `input chains in ${tables.join(', ')}`, verdict };
}

/** `ufw status verbose` when ufw is active: the default incoming policy and its ALLOW rules. */
export function ufwModel(out: string): FirewallModel | null {
  if (!/^Status: active/m.test(out)) return null;
  const deny = /^Default:\s*(deny|reject)\s*\(incoming\)/m.test(out);
  // "[dest] port[:port][/proto] [(v6)] [on iface] ALLOW|LIMIT [IN] [on iface] source [# comment]"
  const allows: { port: number; to?: number; proto?: string; anywhere: boolean; v6: boolean; dest?: string; iface?: string }[] = [];
  for (const line of out.split('\n')) {
    const m = /^(?:(\S+) )?(\d+)(?::(\d+))?(?:\/(tcp|udp))?( \(v6\))?(?: on (\S+))?\s+(?:ALLOW|LIMIT)(?: IN)?(?: on (\S+))?\s+(.+?)\s*(?:#.*)?$/.exec(line.trim());
    if (!m) continue;
    allows.push({ port: Number(m[2]), to: m[3] ? Number(m[3]) : undefined, proto: m[4], v6: !!m[5], iface: m[6] ?? m[7], anywhere: /^Anywhere/.test(m[8]), ...(m[1] && m[1] !== 'Anywhere' ? { dest: m[1] } : {}) });
  }
  return {
    backend: 'ufw', defaultDeny: deny, detail: 'ufw',
    // ufw's rules apply on every interface unless they name one.
    verdict: (p) => {
      const hit = allows.filter((a) => (!a.proto || a.proto === p.proto) && p.port >= a.port && p.port <= (a.to ?? a.port) && a.v6 === (p.family === 'ip6') && (!a.iface || p.iface === '*' || glob(a.iface.replace(/\+$/, '*'), p.iface)));
      if (hit.some((a) => a.anywhere && !a.dest && (!a.iface || p.iface !== '*'))) return 'allowed';
      if (hit.length) return 'restricted';
      return deny ? 'blocked' : 'allowed';
    },
  };
}

/** firewalld's default zone (`firewall-cmd --list-all`): its ports and the well-known services' ports. */
const FIREWALLD_SERVICES: Record<string, [string, number][]> = {
  ssh: [['tcp', 22]], http: [['tcp', 80]], https: [['tcp', 443]], 'dhcpv6-client': [['udp', 546]], mdns: [['udp', 5353]], cockpit: [['tcp', 9090]],
  dns: [['tcp', 53], ['udp', 53]], samba: [['tcp', 139], ['tcp', 445], ['udp', 137], ['udp', 138]], 'samba-client': [['udp', 137], ['udp', 138]], nfs: [['tcp', 2049]],
  ntp: [['udp', 123]], postgresql: [['tcp', 5432]], mysql: [['tcp', 3306]], redis: [['tcp', 6379]], vnc: [['tcp', 5900]], rdp: [['tcp', 3389]],
};
export function firewalldModel(out: string): FirewallModel | null {
  const target = /^\s*target:\s*(\S+)/m.exec(out)?.[1];
  if (!target) return null;
  const list = (k: string) => (new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(out)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const ports = list('ports').map((p) => { const [range, proto] = p.split('/'); const [a, b] = range.split('-').map(Number); return { a, b: b ?? a, proto }; });
  const services = list('services');
  const open = target === 'ACCEPT';
  return {
    backend: 'firewalld', defaultDeny: !open, detail: `firewalld (target ${target})`,
    verdict: (p) => {
      if (open) return 'allowed';
      if (ports.some((x) => x.proto === p.proto && p.port >= x.a && p.port <= x.b)) return 'allowed';
      if (services.some((s) => FIREWALLD_SERVICES[s]?.some(([pr, po]) => pr === p.proto && po === p.port))) return 'allowed';
      if (services.some((s) => !FIREWALLD_SERVICES[s])) return 'unknown';
      if (/^\s*rich rules:\s*\S/m.test(out) || /^\s+rule /m.test(out)) return 'unknown';
      return 'blocked';
    },
  };
}

/** iptables-save: the INPUT policy and plain --dport accepts; anything it jumps to elsewhere is "unknown". */
export function iptablesModel(v4out: string, v6out: string): FirewallModel | null {
  const parse = (out: string) => {
    if (!/^\*filter/m.test(out)) return null;
    const policy = /^:INPUT (\S+)/m.exec(out)?.[1] ?? 'ACCEPT';
    const rules = out.split('\n').filter((l) => l.startsWith('-A INPUT '));
    return { policy, rules };
  };
  const t4 = parse(v4out), t6 = parse(v6out);
  if (!t4 && !t6) return null;
  const one = (t: ReturnType<typeof parse>, p: Probe): Verdict => {
    if (!t) return 'none';
    let restricted = false, unknown = false;
    for (const r of t.rules) {
      if (/-i lo\b/.test(r)) continue;
      if (/--ctstate (RELATED,)?ESTABLISHED(,RELATED)?\b|--state (RELATED,)?ESTABLISHED/.test(r) && !/NEW/.test(r)) continue;
      const proto = /-p (\S+)/.exec(r)?.[1];
      if (proto && proto !== p.proto && proto !== 'all') continue;
      const dport = /--dports? (\S+)/.exec(r)?.[1];
      if (dport && !dport.split(',').some((d) => { const [a, b] = d.split(':').map(Number); return p.port >= a && p.port <= (b ?? a); })) continue;
      const target = /-j (\S+)/.exec(r)?.[1];
      const conditional = /-s \S+|-i \S+|-m (set|recent|mac|iprange)/.test(r);
      if (target === 'ACCEPT') { if (conditional) { restricted = true; continue; } return 'allowed'; }
      if (target === 'DROP' || target === 'REJECT') { if (conditional || !dport) continue; return 'blocked'; }
      if (target) unknown = true;
    }
    if (t.policy !== 'DROP' && t.policy !== 'REJECT') return 'allowed';
    return unknown ? 'unknown' : restricted ? 'restricted' : 'blocked';
  };
  const verdict = (p: Probe) => (p.iface !== '*' ? 'unknown' : one(p.family === 'ip' ? t4 : t6, p));
  const deny = [t4, t6].every((t) => !t || t.policy === 'DROP' || t.policy === 'REJECT');
  return { backend: 'iptables', defaultDeny: deny, detail: 'iptables INPUT chain', verdict };
}

/** Which tool decides, in the order a host would be configured: ufw, firewalld, then the ruleset itself. */
export function firewallModel(s: Record<string, RawSection>): FirewallModel {
  const ok = (n: string) => s[n] && s[n].code === 0 ? s[n].out : null;
  const nft = ok('nft');
  // ufw and firewalld write their own nftables tables (ufw through iptables-nft, in a form nft -j cannot express);
  // they are read from the tools, and every other table on the input hook (fips's own, the mesh guard) from nft.
  const front = (() => { const u = ok('ufw'); const m = u ? ufwModel(u) : null; if (m) return { m, skip: ['ip filter', 'ip6 filter'] }; const f = ok('firewalld'); const n = f ? firewalldModel(f) : null; return n ? { m: n, skip: ['inet firewalld'] } : null; })();
  if (front) {
    const rest = nft ? nftModel(nft, new Set(front.skip)) : null;
    if (!rest || rest.backend === 'none') return front.m;
    return { ...front.m, detail: `${front.m.detail}, and nftables ${rest.detail}`, verdict: (p) => both(front.m.verdict(p), rest.verdict(p)) };
  }
  const nm = nft ? nftModel(nft) : null;
  if (nm && nm.backend !== 'none') return nm;
  // An empty nftables ruleset next to iptables-legacy: the legacy tables filter.
  const ipt = iptablesModel(ok('iptables') ?? '', ok('ip6tables') ?? '');
  if (ipt) return ipt;
  if (nm) return nm;
  const why = s.nft ? (s.nft.code === 127 ? 'nft is not installed' : s.nft.out.trim().split('\n').pop()) : 'not collected';
  return { backend: 'unknown', defaultDeny: null, detail: `the firewall could not be read (${why})`, verdict: () => 'unknown' };
}

/** Two layers on the input path: a connection gets in only if both let it. */
function both(a: Verdict, b: Verdict): Verdict {
  if (a === 'none') return b;
  if (b === 'none') return a;
  for (const v of ['blocked', 'unknown', 'restricted'] as const) if (a === v || b === v) return v;
  return 'allowed';
}

/** Fill in each listener's verdict from the LAN side, and from the mesh where the node's TUN reaches it. */
export function judgeListeners(listeners: Listener[], fw: FirewallModel, tun?: string): Listener[] {
  return listeners.map((l) => {
    if (l.scope === 'loopback') return l;
    const families: ('ip' | 'ip6')[] = l.addr === '*' || l.addr === '::' ? ['ip', 'ip6'] : isV4(l.addr) ? ['ip'] : ['ip6'];
    const worst = (iface: string): Verdict => {
      const order: Verdict[] = ['none', 'allowed', 'unknown', 'restricted', 'blocked'];
      return families.map((family) => fw.verdict({ proto: l.proto, port: l.port, family, iface, tun })).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    };
    const out: Listener = { ...l };
    if (l.scope !== 'mesh') out.lan = worst('*');
    // The mesh is IPv6: a listener on [::], *, or the node's own fips0 address can be reached over fips0.
    if (tun && (l.scope === 'mesh' || (l.scope === 'all' && families.includes('ip6')))) {
      out.mesh = fw.verdict({ proto: l.proto, port: l.port, family: 'ip6', iface: tun, tun });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// Packages: pending updates and known vulnerabilities
// ---------------------------------------------------------------------------------------------

export interface PendingUpdate { name: string; from?: string; to?: string; security: boolean; origin?: string }
export interface Vulnerability { pkg: string; ids: string[]; severity: Severity; fixed: boolean; advisory?: string; fixedIn?: string; remote?: boolean }
export interface PackageState {
  manager: string;
  /** Whether this system's updates can be read at all. */
  supported: boolean;
  updates: PendingUpdate[] | null;
  vulns: Vulnerability[] | null;
  /** Where the vulnerabilities came from (debsecan, arch-audit, dnf updateinfo, zypper patches). */
  vulnSource?: string;
  /** Age of apt's package lists in days (apt only). */
  listsAgeDays?: number;
  errors: string[];
}

/** `apt-get -s dist-upgrade`: "Inst pkg [old] (new Origin:release [arch])". The security pocket names itself. */
export function parseAptUpgrade(out: string): PendingUpdate[] {
  const res: PendingUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = /^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+) ([^)]*)\)/.exec(line);
    if (!m) continue;
    const origin = m[4].replace(/\s*\[[^\]]*\]\s*$/, '');
    res.push({ name: m[1], ...(m[2] ? { from: m[2] } : {}), to: m[3], origin, security: /security/i.test(origin) });
  }
  return res;
}

const URGENCY: Record<string, Severity> = { high: 'high', medium: 'medium', low: 'low', unimportant: 'low' };
/** debsecan's summary format: "CVE-2024-1234 pkg (fixed, remotely exploitable, high urgency)", grouped per package. */
export function parseDebsecan(out: string): Vulnerability[] {
  const by = new Map<string, Vulnerability>();
  for (const line of out.split('\n')) {
    const m = /^((?:CVE|TEMP)-[\w-]+)\s+(\S+)(?:\s+\(([^)]*)\))?/.exec(line.trim());
    if (!m) continue;
    const flags = (m[3] ?? '').split(',').map((f) => f.trim());
    const fixed = flags.includes('fixed');
    const remote = flags.includes('remotely exploitable');
    let sev: Severity = URGENCY[flags.find((f) => f.endsWith(' urgency'))?.replace(' urgency', '').replace(/\*+$/, '') ?? ''] ?? 'low';
    const k = `${m[2]} ${fixed}`;
    const v = by.get(k) ?? { pkg: m[2], ids: [], severity: sev, fixed, remote };
    v.ids.push(m[1]);
    if (rank(sev) < rank(v.severity)) v.severity = sev;
    v.remote ||= remote;
    by.set(k, v);
  }
  return [...by.values()];
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);
const SEV_WORD: Record<string, Severity> = { critical: 'critical', important: 'high', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', none: 'info', unknown: 'low' };

/** arch-audit --json: one entry per advisory group (AVG) with its packages, CVEs, status and fixed version. */
export function parseArchAudit(out: string): Vulnerability[] {
  let doc: unknown;
  try { doc = JSON.parse(out); } catch { return []; }
  const list = Array.isArray(doc) ? doc : Array.isArray((doc as { avgs?: unknown[] })?.avgs) ? (doc as { avgs: unknown[] }).avgs : [];
  const res: Vulnerability[] = [];
  for (const a of list as Record<string, unknown>[]) {
    const pkgs = Array.isArray(a.packages) ? (a.packages as string[]) : [];
    const ids = Array.isArray(a.issues) ? (a.issues as string[]) : [];
    const severity = SEV_WORD[String(a.severity ?? '').toLowerCase()] ?? 'low';
    const fixed = typeof a.fixed === 'string' && !!a.fixed;
    for (const pkg of pkgs) res.push({ pkg, ids, severity, fixed, ...(typeof a.name === 'string' ? { advisory: a.name } : {}), ...(fixed ? { fixedIn: a.fixed as string } : {}), ...(/remote/i.test(String(a.type ?? '')) ? { remote: true } : {}) });
  }
  return groupVulns(res);
}

/** One entry per package and fix state: a package in several advisories merges their ids, at the worst severity. */
export function groupVulns(list: Vulnerability[]): Vulnerability[] {
  const by = new Map<string, Vulnerability>();
  for (const v of list) {
    const k = `${v.pkg} ${v.fixed}`;
    const had = by.get(k);
    if (!had) { by.set(k, { ...v, ids: [...v.ids] }); continue; }
    for (const id of v.ids) if (!had.ids.includes(id)) had.ids.push(id);
    if (rank(v.severity) < rank(had.severity)) had.severity = v.severity;
    if (v.advisory && had.advisory && !had.advisory.split(' ').includes(v.advisory)) had.advisory += ` ${v.advisory}`;
    had.remote ||= v.remote;
  }
  return [...by.values()];
}

/** `checkupdates`: "pkg old -> new". */
export function parseCheckupdates(out: string): PendingUpdate[] {
  return out.split('\n').map((l) => /^(\S+) (\S+) -> (\S+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => ({ name: m[1], from: m[2], to: m[3], security: false }));
}

const NEVRA = /^([A-Za-z0-9_.+-]+?)-(?:\d+:)?([^-\s]+-[^-\s]+)\.(x86_64|aarch64|noarch|i686|armv7hl|ppc64le|s390x)$/;
/** `dnf check-update` (dnf4) and dnf5: "name.arch  version  repo". */
export function parseDnfUpdates(out: string): PendingUpdate[] {
  const res: PendingUpdate[] = [];
  for (const line of out.split('\n')) {
    if (/^(Obsoleting|Last metadata|Security:|Upgrades|Updating)/i.test(line.trim())) { if (/^Obsoleting/i.test(line.trim())) break; continue; }
    const t = line.trim().split(/\s+/);
    if (t.length !== 3 || !/\.(x86_64|aarch64|noarch|i686|armv7hl|ppc64le|s390x)$/.test(t[0])) continue;
    res.push({ name: t[0].replace(/\.[^.]+$/, ''), to: t[1], origin: t[2], security: false });
  }
  return res;
}

/** `dnf updateinfo list --security [cves]`: id (advisory or CVE), severity, package NEVRA, in dnf4's or dnf5's columns. */
export function parseDnfUpdateinfo(out: string): { id: string; severity: Severity; pkg: string }[] {
  const res: { id: string; severity: Severity; pkg: string }[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 3) continue;
    const pkgTok = t.slice(1).find((x) => NEVRA.test(x));
    if (!pkgTok) continue;
    const sevTok = t.slice(1).map((x) => x.replace(/\/Sec\.?$/i, '').toLowerCase()).find((x) => x in SEV_WORD);
    res.push({ id: t[0], severity: sevTok ? SEV_WORD[sevTok] : 'medium', pkg: NEVRA.exec(pkgTok)![1] });
  }
  return res;
}

const xmlAttr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
/** zypper --xmlout list-updates: <update kind="package" name="…" edition="…" edition-old="…">. */
export function parseZypperUpdates(out: string): PendingUpdate[] {
  return [...out.matchAll(/<update[\s/>][^>]*>/g)].map((m) => m[0]).filter((t) => (xmlAttr(t, 'kind') ?? 'package') === 'package').map((t) => ({ name: xmlAttr(t, 'name') ?? '?', to: xmlAttr(t, 'edition'), from: xmlAttr(t, 'edition-old'), security: false }));
}
/** zypper --xmlout list-patches -g security: one patch per advisory, with its severity and the CVEs it references. */
export function parseZypperPatches(out: string): Vulnerability[] {
  const res: Vulnerability[] = [];
  for (const m of out.matchAll(/<update(\s[^>]*)?>([\s\S]*?)<\/update>/g)) {
    const attrs = m[1] ?? '';
    if ((xmlAttr(attrs, 'status') ?? 'needed') !== 'needed' && xmlAttr(attrs, 'status') !== undefined) continue;
    const ids = [...m[2].matchAll(/\bid="(CVE-[\d-]+)"/g)].map((x) => x[1]);
    const summary = /<summary>([^<]*)<\/summary>/.exec(m[2])?.[1];
    res.push({ pkg: summary?.trim() || xmlAttr(attrs, 'name') || '?', ids, severity: SEV_WORD[(xmlAttr(attrs, 'severity') ?? '').toLowerCase()] ?? 'medium', fixed: true, advisory: xmlAttr(attrs, 'name') });
  }
  return res;
}

export function packageState(raw: RawScan, now = Date.now()): PackageState {
  const s = raw.sections;
  const out = (n: string) => s[n]?.out ?? '';
  const st: PackageState = { manager: raw.pm, supported: true, updates: null, vulns: null, errors: [] };
  const failed = (n: string, okCodes = [0]) => {
    const x = s[n];
    if (!x || x.code === 127 || okCodes.includes(x.code)) return false;
    st.errors.push(`${n}: ${x.code === 124 ? 'timed out' : x.out.trim().split('\n').filter(Boolean).pop() ?? `exit ${x.code}`}`);
    return true;
  };
  switch (raw.pm) {
    case 'apt': {
      if (!failed('apt_upgrade')) st.updates = parseAptUpgrade(out('apt_upgrade'));
      const age = Number(out('apt_lists_age').trim());
      if (age > 0) st.listsAgeDays = Math.floor((now / 1000 - age) / 86400);
      if (s.debsecan && !failed('debsecan')) { st.vulns = parseDebsecan(out('debsecan')); st.vulnSource = 'debsecan'; }
      break;
    }
    case 'dnf': {
      failed('dnf_makecache');
      // check-update exits 100 when there are updates.
      if (!failed('dnf_updates', [0, 100])) st.updates = parseDnfUpdates(out('dnf_updates'));
      if (!failed('dnf_security')) {
        const adv = parseDnfUpdateinfo(out('dnf_security'));
        const cves = failed('dnf_cves') ? [] : parseDnfUpdateinfo(out('dnf_cves'));
        const secPkgs = new Set(adv.map((a) => a.pkg));
        if (st.updates) for (const u of st.updates) if (secPkgs.has(u.name)) u.security = true;
        const by = new Map<string, Vulnerability>();
        for (const a of adv) {
          const v = by.get(a.pkg) ?? { pkg: a.pkg, ids: [], severity: a.severity, fixed: true, advisory: a.id };
          if (rank(a.severity) < rank(v.severity)) v.severity = a.severity;
          by.set(a.pkg, v);
        }
        for (const c of cves) { const v = by.get(c.pkg); if (v && !v.ids.includes(c.id)) v.ids.push(c.id); }
        st.vulns = [...by.values()]; st.vulnSource = 'dnf updateinfo';
      }
      break;
    }
    case 'pacman': {
      // checkupdates exits 2 when there is nothing to update.
      if (s.pacman_updates?.code === 127) st.errors.push('checkupdates is not installed (pacman-contrib)');
      else if (!failed('pacman_updates', [0, 2])) st.updates = parseCheckupdates(out('pacman_updates'));
      if (s.arch_audit && s.arch_audit.code !== 127 && !failed('arch_audit')) {
        st.vulns = parseArchAudit(out('arch_audit')); st.vulnSource = 'arch-audit';
        const fixedPkgs = new Set(st.vulns.filter((v) => v.fixed).map((v) => v.pkg));
        if (st.updates) for (const u of st.updates) if (fixedPkgs.has(u.name)) u.security = true;
      }
      break;
    }
    case 'zypper': {
      // zypper's informational exit codes: 100 updates, 101 security updates, 102 reboot, 103 restart zypper.
      if (!failed('zypper_updates', [0, 100, 101, 102, 103])) st.updates = parseZypperUpdates(out('zypper_updates'));
      if (!failed('zypper_patches', [0, 100, 101, 102, 103])) { st.vulns = parseZypperPatches(out('zypper_patches')); st.vulnSource = 'zypper patches'; }
      break;
    }
    default: st.supported = false;
  }
  return st;
}

// ---------------------------------------------------------------------------------------------
// Report and score
// ---------------------------------------------------------------------------------------------

export interface Context {
  /** The node's TUN (fips0) and its mesh address, from the daemon. */
  tun?: string; meshAddr?: string;
  /** Facts only fips-ui knows: whether its main listener is reachable beyond loopback without a token, and the units. */
  uiExposed?: { host: string; token: boolean };
  fipsFirewallActive?: boolean;
}

export interface Report {
  scannedAt: number; durationSecs: number; helperVersion: number;
  system: { name?: string; kernel?: string; manager: string; nixos: boolean };
  listeners: Listener[];
  firewall: { backend: FirewallModel['backend']; defaultDeny: boolean | null; detail?: string };
  packages: PackageState;
  reboot: { required: boolean; reasons: string[]; services: string[] };
  findings: Finding[];
  categories: Record<Category, { deducted: number; findings: number }>;
  score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Checks that could not run (tool missing, failed), for the page to say what the score does not cover. */
  notes: string[];
}

/** Ports whose service should never face a network unprotected. */
const RISKY_PORTS: Record<number, string> = {
  21: 'FTP', 23: 'Telnet', 69: 'TFTP', 111: 'rpcbind', 135: 'MS RPC', 137: 'NetBIOS', 139: 'SMB', 445: 'SMB', 161: 'SNMP', 389: 'LDAP', 512: 'rexec', 513: 'rlogin', 514: 'rsh',
  873: 'rsync', 1433: 'MS SQL', 2049: 'NFS', 2375: 'Docker API', 2376: 'Docker API', 2379: 'etcd', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC', 5984: 'CouchDB',
  6000: 'X11', 6379: 'Redis', 8086: 'InfluxDB', 9200: 'Elasticsearch', 10250: 'kubelet', 11211: 'memcached', 27017: 'MongoDB',
};

const sev = (s: Severity, up: boolean): Severity => (up && rank(s) > 0 ? SEVERITIES[rank(s) - 1] : s);
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`}`;
/** Services the internet is meant to reach: a deliberate allow for them is not a finding. */
const PUBLIC_PORTS = new Set(['tcp/80', 'tcp/443', 'udp/443']);

/** Client sockets of common system services (DHCP, mDNS): listed, scored only as information. */
const CLIENT_PORTS: Record<string, string> = { 'udp/68': 'DHCP client', 'udp/546': 'DHCPv6 client', 'udp/5353': 'mDNS' };

/** One finding per service (proto/port) and side, however many addresses it is bound to. */
/** `defaultDeny`: the firewall refuses what it does not name, so an open port there was allowed on purpose. */
export function listenerFindings(listeners: Listener[], defaultDeny: boolean | null = null): Finding[] {
  const out = new Map<string, Finding & { addrs: string[] }>();
  const add = (f: Finding, addr: string) => {
    const had = out.get(f.id);
    if (!had) { out.set(f.id, { ...f, addrs: [addr] }); return; }
    if (!had.addrs.includes(addr)) had.addrs.push(addr);
    if (rank(f.severity) < rank(had.severity)) Object.assign(had, { severity: f.severity, title: f.title });
  };
  for (const l of listeners) {
    if (l.ephemeral || l.scope === 'loopback') continue;
    const svc = `${l.proto}/${l.port}`;
    const what = `${svc}${l.process ? ` (${l.process})` : ''}`;
    const name = RISKY_PORTS[l.port] ? `${RISKY_PORTS[l.port]} (${what})` : CLIENT_PORTS[svc] ? `${CLIENT_PORTS[svc]} (${what})` : what;
    const risky = !!RISKY_PORTS[l.port];
    const client = !!CLIENT_PORTS[svc];
    const where = l.addr === '::' || l.addr === '0.0.0.0' || l.addr === '*' ? 'every interface' : l.addr;
    const addr = `${l.addr}${l.iface ? `%${l.iface}` : ''}`;
    if (l.lan === 'allowed' || l.lan === 'none' || l.lan === 'unknown') {
      const wide = l.scope === 'public' || l.scope === 'all';
      let severity: Severity;
      // A port a default-deny firewall names was opened on purpose: worth knowing, rarely a mistake.
      const deliberate = l.lan === 'allowed' && defaultDeny === true;
      // Whether the firewall lets it in is not known: only what should never face a network costs points.
      if (l.lan === 'unknown') severity = risky ? 'medium' : 'info';
      else if (client || l.scope === 'link-local') severity = risky ? 'medium' : 'info';
      else if (deliberate) severity = risky ? 'medium' : PUBLIC_PORTS.has(svc) ? 'info' : 'low';
      else if (l.port === 22) severity = 'low';
      else severity = sev(risky ? 'high' : l.proto === 'tcp' ? 'medium' : 'low', wide);
      add({
        id: `exposed-${svc}`, category: 'exposure', severity,
        title: `${name} listens on ${where}${l.lan === 'unknown' ? ', and the firewall may let it through' : l.lan === 'none' ? ' with no host firewall' : deliberate ? ', and a firewall rule lets anyone in' : ', and the firewall lets anyone in'}`,
        fix: l.port === 22 ? 'Keep it if you administer the node over the network; limit sources in the firewall and use keys only.' : 'Bind it to 127.0.0.1 or ::1 if only this machine uses it, or allow only the hosts that need it in the host firewall.',
      }, addr);
    }
    if (l.mesh === 'allowed' || l.mesh === 'none') {
      add({
        // fips-firewall drops by default: an "allowed" here is a drop-in that lets every mesh address in.
        id: `mesh-${svc}`, category: 'exposure', severity: l.mesh === 'none' ? (risky ? 'high' : client ? 'info' : 'medium') : risky ? 'medium' : client ? 'info' : 'low',
        title: `${name} is reachable from every node on the mesh`,
        detail: l.mesh === 'none' ? 'nothing filters fips0' : 'a fips firewall rule lets any mesh address in',
        fix: 'Turn on fips-firewall, or allow only the npubs that need it (Firewall page).',
      }, addr);
    }
  }
  return [...out.values()].map(({ addrs, ...f }) => ({ ...f, detail: [f.detail, `bound to ${addrs.join(', ')}`].filter(Boolean).join('; ') }));
}

function updateFindings(p: PackageState, nixos: boolean): Finding[] {
  const out: Finding[] = [];
  if (!p.supported) {
    out.push({ id: 'patches-unsupported', category: 'patches', severity: 'info', title: nixos ? 'Updates are managed by Nix' : `Updates cannot be read with ${p.manager === 'none' ? 'this package manager' : p.manager}`, fix: nixos ? 'Update the flake inputs and run nixos-rebuild switch regularly.' : undefined });
    return out;
  }
  if (p.updates) {
    const sec = p.updates.filter((u) => u.security);
    // With vulnerability data the CVEs these updates fix are scored under Vulnerabilities; this only counts the backlog.
    const known = p.vulns !== null;
    if (sec.length) out.push({ id: 'patches-security', category: 'patches', severity: known ? (sec.length >= 10 ? 'medium' : 'low') : 'high', title: `${plural(sec.length, 'security update')} pending`, detail: sec.slice(0, 12).map((u) => u.name).join(', ') + (sec.length > 12 ? ', …' : '') + (known ? ' (the vulnerabilities they fix are scored under Vulnerabilities)' : ''), fix: 'Install them with the package manager, then reboot or restart the services that use them.' });
    const other = p.updates.length - sec.length;
    if (other > 0) out.push({ id: 'patches-other', category: 'patches', severity: other >= 50 ? 'medium' : 'low', title: `${plural(other, 'other update')} pending`, fix: 'Update the system regularly.' });
  }
  if (p.listsAgeDays !== undefined && p.listsAgeDays > 7) out.push({ id: 'patches-stale', category: 'patches', severity: 'medium', title: `Package lists are ${p.listsAgeDays} days old`, detail: 'Pending updates newer than the lists are not known.', fix: 'Enable apt-daily.timer, or run apt update.' });
  if (p.vulns === null && p.manager === 'apt') out.push({ id: 'vulns-no-tool', category: 'vulns', severity: 'info', title: 'Known vulnerabilities are not checked', fix: 'Install debsecan for a per-CVE view (apt install debsecan).' });
  if (p.vulns === null && p.manager === 'pacman') out.push({ id: 'vulns-no-tool', category: 'vulns', severity: 'info', title: 'Known vulnerabilities are not checked', fix: 'Install arch-audit (pacman -S arch-audit).' });
  for (const v of p.vulns ?? []) {
    out.push({
      // Without a fix there is nothing to install yet (and debsecan lists dozens on any Debian): listed, not scored.
      id: `vuln-${v.pkg}-${v.fixed ? 'fixed' : 'open'}`, category: 'vulns', severity: v.fixed ? v.severity : 'info',
      title: `${v.pkg}: ${plural(v.ids.length || 1, 'known vulnerability').replace(/^1 known vulnerability$/, 'a known vulnerability')}${v.fixed ? ', fixed in an update' : ', no fix yet'}`,
      detail: [v.advisory, v.ids.slice(0, 8).join(' '), v.ids.length > 8 ? `+${v.ids.length - 8}` : '', v.fixedIn ? `fixed in ${v.fixedIn}` : '', v.remote ? 'remotely exploitable' : ''].filter(Boolean).join(' · '),
      fix: v.fixed ? `Update ${v.pkg}.` : 'Watch for the distribution\'s fix; limit exposure of the service meanwhile.',
    });
  }
  return out;
}

export function rebootState(s: Record<string, RawSection>): Report['reboot'] {
  const reasons: string[] = [];
  const services: string[] = [];
  const running = s.uname?.out.trim();
  // Only a listing that worked: an error message is not a list of kernels (NixOS, containers).
  const kernels = (s.kernels?.code === 0 ? s.kernels.out : '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (running && kernels.length && !kernels.includes(running)) reasons.push(`the running kernel ${running} is no longer installed`);
  if (/^yes/.test(s.reboot_required?.out ?? '')) reasons.push(`the system asks for a reboot${(s.reboot_required!.out.split('\n').slice(1).filter(Boolean).length) ? ` (${s.reboot_required!.out.split('\n').slice(1).filter(Boolean).join(', ')})` : ''}`);
  if (s.needs_restarting?.code === 1) reasons.push('needs-restarting -r reports core libraries or the kernel updated');
  const nr = s.needrestart?.code === 0 ? s.needrestart.out : '';
  const ksta = /^NEEDRESTART-KSTA:\s*(\d)/m.exec(nr)?.[1];
  if (ksta === '2' || ksta === '3') reasons.push('needrestart reports a newer kernel');
  for (const m of nr.matchAll(/^NEEDRESTART-SVC:\s*(\S+)/gm)) services.push(m[1]);
  return { required: reasons.length > 0, reasons: [...new Set(reasons)], services };
}

/** sshd -T prints the effective configuration as lowercase "key value" lines. */
export function parseSshd(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const l of out.split('\n')) { const m = /^(\S+)\s+(.*)$/.exec(l.trim()); if (m) r[m[1].toLowerCase()] ??= m[2].trim().toLowerCase(); }
  return r;
}
export function parseSysctl(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const l of out.split('\n')) { const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(l.trim()); if (m) r[m[1]] = m[2].trim(); }
  return r;
}

function hardeningFindings(s: Record<string, RawSection>, notes: string[]): Finding[] {
  const out: Finding[] = [];
  const H = (id: string, severity: Severity, title: string, fix: string, detail?: string) => out.push({ id, category: 'hardening', severity, title, fix, ...(detail ? { detail } : {}) });
  if (s.sshd?.code === 0) {
    const c = parseSshd(s.sshd.out);
    if (c.permitrootlogin === 'yes') H('ssh-root', 'high', 'SSH allows root to log in with a password', 'Set PermitRootLogin prohibit-password (or no) in sshd_config.');
    if (c.passwordauthentication === 'yes') H('ssh-password', 'medium', 'SSH accepts passwords', 'Use keys and set PasswordAuthentication no.');
    if (c.permitemptypasswords === 'yes') H('ssh-empty', 'critical', 'SSH accepts empty passwords', 'Set PermitEmptyPasswords no.');
    if (c.x11forwarding === 'yes') H('ssh-x11', 'low', 'SSH forwards X11', 'Set X11Forwarding no unless you need it.');
    if (Number(c.maxauthtries) > 6) H('ssh-tries', 'low', `SSH allows ${c.maxauthtries} attempts per connection`, 'Set MaxAuthTries 3 to 6.');
  } else if (s.sshd && s.sshd.code !== 127) notes.push(`sshd -T: ${s.sshd.out.trim().split('\n').pop()}`);
  const k = parseSysctl(s.sysctl?.out ?? '');
  const is = (key: string, v: string) => k[key] !== undefined && k[key] === v;
  if (k['kernel.randomize_va_space'] !== undefined && k['kernel.randomize_va_space'] !== '2') H('sysctl-aslr', 'medium', 'Address space layout randomisation is not fully on', 'Set kernel.randomize_va_space = 2.', `kernel.randomize_va_space = ${k['kernel.randomize_va_space']}`);
  if (is('kernel.kptr_restrict', '0')) H('sysctl-kptr', 'low', 'Kernel pointers are visible to every user', 'Set kernel.kptr_restrict = 1.');
  if (is('kernel.dmesg_restrict', '0')) H('sysctl-dmesg', 'low', 'Every user can read the kernel log', 'Set kernel.dmesg_restrict = 1.');
  if (is('kernel.unprivileged_bpf_disabled', '0')) H('sysctl-bpf', 'low', 'Unprivileged users may load BPF programs', 'Set kernel.unprivileged_bpf_disabled = 1.');
  if (is('net.ipv4.conf.all.accept_redirects', '1') || is('net.ipv6.conf.all.accept_redirects', '1')) H('sysctl-redirects', 'low', 'ICMP redirects are accepted', 'Set net.ipv4.conf.all.accept_redirects = 0 and net.ipv6.conf.all.accept_redirects = 0.');
  if (is('net.ipv4.conf.all.accept_source_route', '1')) H('sysctl-srcroute', 'medium', 'Source-routed packets are accepted', 'Set net.ipv4.conf.all.accept_source_route = 0.');
  if (is('net.ipv4.tcp_syncookies', '0')) H('sysctl-syncookies', 'low', 'TCP SYN cookies are off', 'Set net.ipv4.tcp_syncookies = 1.');
  if (s.uid0?.code === 0) {
    const extra = s.uid0.out.split('\n').map((x) => x.trim()).filter((x) => x && x !== 'root');
    if (extra.length) H('uid0', 'critical', `Accounts other than root have UID 0: ${extra.join(', ')}`, 'Give them their own UID or remove them.');
  }
  if (s.empty_passwords?.code === 0) {
    const names = s.empty_passwords.out.split('\n').map((x) => x.trim()).filter(Boolean);
    if (names.length) H('empty-passwords', 'high', `Accounts without a password: ${names.join(', ')}`, 'Set a password or lock them (passwd -l).');
  }
  if (s.auto_updates?.code === 0) {
    const out = s.auto_updates.out;
    // On apt systems apt-daily-upgrade.timer is always there; whether it installs anything is APT::Periodic's setting.
    const apt = /APT::Periodic::Unattended-Upgrade/.test(out) || /^apt-daily-upgrade\.timer /m.test(out);
    const on = apt ? /Unattended-Upgrade\s+"1"/.test(out) && /^unattended-upgrades\.service /m.test(out)
      : out.split('\n').some((l) => /^\S+\s+enabled\b/.test(l));
    if (!on) H('auto-updates', 'low', 'Security updates are not installed automatically', 'Enable unattended-upgrades or dnf-automatic, or plan regular updates.');
  }
  if (s.timesync?.code === 0 && /NTPSynchronized=no/.test(s.timesync.out)) H('timesync', 'low', 'The clock is not synchronised', 'Enable systemd-timesyncd or chrony (timedatectl set-ntp true).');
  if (s.failed_units?.code === 0) {
    const units = s.failed_units.out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    if (units.length) H('failed-units', 'low', `${plural(units.length, 'unit')} failed`, 'Look at systemctl status for each.', units.slice(0, 10).join(', '));
  }
  for (const line of (s.fips_files?.out ?? '').split('\n')) {
    const m = /^(\d+) (\S+) (\S+) (.+)$/.exec(line.trim());
    if (!m) continue;
    const mode = parseInt(m[1], 8);
    const file = m[4];
    if (/\.key$/.test(file) && (mode & 0o007)) H('fips-key', 'critical', `The node's private key ${file} is readable by every user`, `chmod 640 ${file} (owner root, group fips).`, `mode ${m[1]} ${m[2]}:${m[3]}`);
    else if (/\.ya?ml$/.test(file) && (mode & 0o004)) H('fips-config', 'medium', `${file} is readable by every user`, `chmod 640 ${file}; it can hold secrets.`, `mode ${m[1]} ${m[2]}:${m[3]}`);
    if (mode & 0o002) H(`fips-writable-${file}`, 'critical', `${file} is writable by every user`, `chmod o-w ${file}.`);
  }
  return out;
}

export function gradeOf(score: number): Report['grade'] { return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'; }

export function score(findings: Finding[]): Pick<Report, 'score' | 'grade' | 'categories'> {
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, { deducted: 0, findings: 0 }])) as Report['categories'];
  for (const f of findings) {
    const c = categories[f.category];
    c.findings++;
    c.deducted = Math.min(CATEGORY_CAP[f.category], c.deducted + DEDUCTION[f.severity]);
  }
  let s = 100 - CATEGORIES.reduce((n, c) => n + categories[c].deducted, 0);
  if (findings.some((f) => f.severity === 'critical')) s = Math.min(s, CRITICAL_CEILING);
  s = Math.max(0, s);
  return { score: s, grade: gradeOf(s), categories };
}

/** The whole report from one helper answer. */
export function analyse(raw: RawScan, ctx: Context = {}, now = Date.now()): Report {
  const s = raw.sections;
  const notes: string[] = [];
  const fw = firewallModel(s);
  const listeners = judgeListeners(parseSs(s.ss?.code === 0 ? s.ss.out : '', ctx.tun, ctx.meshAddr), fw, ctx.tun);
  if (!s.ss || s.ss.code !== 0) notes.push(`listeners could not be read (${s.ss ? s.ss.out.trim().split('\n').pop() || `exit ${s.ss.code}` : 'not collected'})`);
  const packages = packageState(raw, now);
  notes.push(...packages.errors);
  const reboot = rebootState(s);
  const findings: Finding[] = [...listenerFindings(listeners, fw.defaultDeny)];
  if (fw.backend === 'unknown') findings.push({ id: 'firewall-unreadable', category: 'firewall', severity: 'info', title: 'The host firewall could not be read', detail: fw.detail });
  else if (!fw.defaultDeny) findings.push({ id: 'firewall-open', category: 'firewall', severity: 'high', title: fw.backend === 'none' ? 'No host firewall filters inbound connections' : `The host firewall (${fw.backend}) accepts inbound connections by default`, detail: fw.detail, fix: 'Drop new inbound connections by default and allow only what the node serves (nftables, ufw or firewalld).' });
  if (ctx.fipsFirewallActive === false) findings.push({ id: 'fips-firewall-off', category: 'firewall', severity: 'medium', title: 'fips-firewall is not running', detail: 'Services listening on [::] are reachable from the whole mesh.', fix: 'Start and enable it on the Firewall page.' });
  if (ctx.uiExposed && !ctx.uiExposed.token) findings.push({ id: 'ui-open', category: 'exposure', severity: 'high', title: `fips-ui listens on ${ctx.uiExposed.host} without FIPS_UI_TOKEN`, detail: 'Every client of that address is a superadmin.', fix: 'Bind fips-ui to 127.0.0.1, or set FIPS_UI_TOKEN in /etc/default/fips-ui.' });
  findings.push(...updateFindings(packages, raw.nixos));
  if (reboot.required) findings.push({ id: 'reboot', category: 'patches', severity: 'medium', title: 'A reboot is needed to finish updates', detail: reboot.reasons.join('; '), fix: 'Reboot when convenient; the fixes are not active until then.' });
  if (reboot.services.length) findings.push({ id: 'restart-services', category: 'patches', severity: 'low', title: `${plural(reboot.services.length, 'service')} still ${reboot.services.length === 1 ? 'runs' : 'run'} old libraries`, detail: reboot.services.slice(0, 12).join(', '), fix: 'Restart them (needrestart -r a).' });
  findings.push(...hardeningFindings(s, notes));
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const osName = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(s.os_release?.out ?? '')?.[1];
  return {
    scannedAt: raw.finished * 1000 || now, durationSecs: Math.max(0, raw.finished - raw.started), helperVersion: raw.version,
    system: { ...(osName ? { name: osName } : {}), ...(s.uname?.out.trim() ? { kernel: s.uname.out.trim() } : {}), manager: raw.pm, nixos: raw.nixos },
    listeners, firewall: { backend: fw.backend, defaultDeny: fw.defaultDeny, ...(fw.detail ? { detail: fw.detail } : {}) },
    packages, reboot, findings, ...score(findings), notes,
  };
}

/** What the Node manager shows for a node. */
export interface Summary { score: number; grade: Report['grade']; scannedAt: number; counts: Record<Severity, number> }
export function summarise(r: Report): Summary {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of r.findings) counts[f.severity]++;
  return { score: r.score, grade: r.grade, scannedAt: r.scannedAt, counts };
}

// ---------------------------------------------------------------------------------------------
// The scanner: weekly schedule, one scan at a time, the newest reports kept
// ---------------------------------------------------------------------------------------------

const FILE = process.env.FIPS_UI_SECURITY_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'fips-ui', 'security.json');
const KEEP_REPORTS = 12;
/** After a scan that could not run, the next automatic attempt waits this long. */
const RETRY_MS = 60 * 60_000;

export interface ScanSettings { enabled: boolean; /** 0 = Sunday */ weekday: number; hour: number }
export const DEFAULT_SETTINGS: ScanSettings = { enabled: true, weekday: 0, hour: 3 };

export class SettingsError extends Error {}
export function validateSettings(input: unknown): ScanSettings {
  const x = (input ?? {}) as Partial<ScanSettings>;
  if (typeof x.enabled !== 'boolean') throw new SettingsError('enabled must be true or false');
  if (!Number.isInteger(x.weekday) || x.weekday! < 0 || x.weekday! > 6) throw new SettingsError('weekday must be 0 (Sunday) to 6');
  if (!Number.isInteger(x.hour) || x.hour! < 0 || x.hour! > 23) throw new SettingsError('hour must be 0 to 23');
  return { enabled: x.enabled, weekday: x.weekday!, hour: x.hour! };
}

/** The latest scheduled slot at or before `now`, in local time. */
function lastSlot(s: ScanSettings, now: number): number {
  const d = new Date(now);
  d.setHours(s.hour, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - s.weekday + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/**
 * When the next automatic scan is due: at the weekly slot, or at once when a slot passed since `since` (the last
 * scan, or when the scanner started on a node never scanned) without a scan, e.g. while fips-ui was down. After a
 * failed attempt at a slot, it is tried again an hour later.
 */
export function nextRun(s: ScanSettings, since: number, now: number, lastFailure?: number): number | null {
  if (!s.enabled) return null;
  const slot = lastSlot(s, now);
  // A week later on the calendar: the same local hour across a daylight-saving change.
  const d = new Date(slot); d.setDate(d.getDate() + 7);
  const following = d.getTime();
  if (since >= slot) return following;
  if (lastFailure !== undefined && lastFailure >= slot) return Math.min(following, lastFailure + RETRY_MS);
  return slot;
}

export interface ScannerDeps {
  /** Run the helper's security-scan. */
  run: () => Promise<RawScan>;
  /** The node facts the report needs from the daemon and fips-ui itself. */
  context: () => Promise<Context>;
  /** Whether a scan can run here at all (helper v13 with the security feature). */
  available: () => Promise<boolean>;
  file?: string;
  now?: () => number;
}

export interface ScannerStatus {
  settings: ScanSettings; running: boolean; startedAt?: number; nextRun: number | null;
  lastError?: string; lastFailure?: number; latest: Report | null;
}

export class SecurityScanner {
  private settings: ScanSettings = { ...DEFAULT_SETTINGS };
  private reports: Report[] = [];
  private running: Promise<void> | null = null;
  private startedAt?: number;
  private lastError?: string;
  private lastFailure?: number;
  private timer?: NodeJS.Timeout;
  private bootedAt = 0;
  private readonly file: string;
  private readonly dir: string;
  private readonly now: () => number;

  private readonly deps: ScannerDeps;

  constructor(deps: ScannerDeps) {
    this.deps = deps;
    this.file = deps.file ?? FILE;
    this.dir = join(dirname(this.file), 'security');
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    try { this.settings = validateSettings(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.lastError = `cannot load ${this.file}: ${(e as Error).message}`; }
    await this.loadReports();
    this.bootedAt = this.now();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async loadReports(): Promise<void> {
    let names: string[] = [];
    try { names = (await readdir(this.dir)).filter((n) => /^\d+\.json$/.test(n)); } catch { return; }
    const loaded: Report[] = [];
    for (const n of names) {
      try { loaded.push(JSON.parse(await readFile(join(this.dir, n), 'utf8')) as Report); } catch { /* a damaged report is skipped */ }
    }
    this.reports = loaded.filter((r) => typeof r?.scannedAt === 'number').sort((a, b) => a.scannedAt - b.scannedAt).slice(-KEEP_REPORTS);
  }

  private get latest(): Report | null { return this.reports.at(-1) ?? null; }
  private due(): number | null { return nextRun(this.settings, this.latest?.scannedAt ?? this.bootedAt, this.now(), this.lastFailure); }

  /** Called once a minute: scan when due. */
  async tick(): Promise<void> {
    const due = this.due();
    if (due === null || due > this.now() || this.running) return;
    if (!(await this.deps.available())) return;
    await this.scan();
  }

  status(): ScannerStatus {
    return {
      settings: this.settings, running: !!this.running, ...(this.startedAt && this.running ? { startedAt: this.startedAt } : {}),
      nextRun: this.due(),
      ...(this.lastError ? { lastError: this.lastError, lastFailure: this.lastFailure } : {}), latest: this.latest,
    };
  }

  history(): (Summary & { categories: Report['categories'] })[] { return this.reports.map((r) => ({ ...summarise(r), categories: r.categories })); }

  summary(): Summary | null { const r = this.latest; return r ? summarise(r) : null; }

  /** Start a scan (or join the one running); resolves when it is over. Never throws: the outcome is in status(). */
  scan(): Promise<void> {
    if (this.running) return this.running;
    this.startedAt = this.now();
    this.running = (async () => {
      try {
        const raw = await this.deps.run();
        if (!raw?.ok || typeof raw.sections !== 'object') throw new Error('the helper returned no scan');
        const report = analyse(raw, await this.deps.context(), this.now());
        await this.save(report);
        this.lastError = undefined; this.lastFailure = undefined;
      } catch (e) {
        this.lastError = (e as Error).message; this.lastFailure = this.now();
      } finally { this.running = null; }
    })();
    return this.running;
  }

  private async save(r: Report): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const f = join(this.dir, `${r.scannedAt}.json`);
    const tmp = `${f}.${process.pid}.tmp`;
    try { await writeFile(tmp, JSON.stringify(r), { mode: 0o600 }); await rename(tmp, f); }
    catch (e) { await unlink(tmp).catch(() => {}); throw new Error(`cannot write ${f}: ${(e as Error).message}`); }
    this.reports = [...this.reports.filter((x) => x.scannedAt !== r.scannedAt), r].slice(-KEEP_REPORTS);
    const keep = new Set(this.reports.map((x) => `${x.scannedAt}.json`));
    for (const n of await readdir(this.dir).catch(() => [] as string[])) if (/^\d+\.json$/.test(n) && !keep.has(n)) await unlink(join(this.dir, n)).catch(() => {});
  }

  async saveSettings(input: unknown): Promise<ScannerStatus> {
    const s = validateSettings(input);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try { await writeFile(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, this.file); }
    catch (e) { await unlink(tmp).catch(() => {}); throw new Error(`cannot write ${this.file}: ${(e as Error).message}`); }
    this.settings = s;
    return this.status();
  }
}
