// The security scan (server/security.ts): parsers against tool output, the firewall's input path, scoring, the
// weekly schedule and the scanner with a fake helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyse, firewalldModel, judgeListeners, nextRun, nftModel, parseAptUpgrade, parseArchAudit, parseCheckupdates, parseDebsecan, parseDnfUpdateinfo,
  parseDnfUpdates, parseSs, parseZypperPatches, parseZypperUpdates, rebootState, score, SecurityScanner, ufwModel, validateSettings,
  type Finding, type RawScan, type RawSection,
} from '../server/security.ts';

const TUN = 'fips0';
const MESH = 'fd5d:317:f040:c89:fd00:1ffc:d416:2b94';

const SS = `tcp LISTEN 0 4096 127.0.0.1:631 0.0.0.0:* users:(("cupsd",pid=812,fd=7))
tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))
tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=700,fd=4))
tcp LISTEN 0 511 *:6379 *:* users:(("redis-server",pid=900,fd=6))
tcp LISTEN 0 511 *:6379 *:* users:(("redis-server",pid=901,fd=6))
tcp LISTEN 0 4096 [${MESH}]:8321 [::]:* users:(("node",pid=1000,fd=20))
tcp LISTEN 0 4096 192.168.1.61:8080 0.0.0.0:*
tcp LISTEN 0 4096 [::1]:5432 [::]:*
udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*
udp UNCONN 0 0 0.0.0.0:42778 0.0.0.0:*
udp UNCONN 0 0 [fe80::70df:f28b:3549:6a1f]%wlp0s20f3:546 [::]:*
udp UNCONN 0 0 0.0.0.0%virbr0:67 0.0.0.0:*
tcp ESTAB 0 0 192.168.1.61:22 192.168.1.2:50000
`;

test('parseSs: scopes, processes, duplicates, ephemeral UDP', () => {
  const l = parseSs(SS, TUN, MESH);
  const by = (port: number, addr?: string) => l.find((x) => x.port === port && (!addr || x.addr === addr))!;
  assert.equal(by(631).scope, 'loopback');
  assert.equal(by(22, '0.0.0.0').scope, 'all');
  assert.equal(by(22, '0.0.0.0').process, 'sshd');
  assert.equal(by(22, '::').scope, 'all');
  assert.equal(l.filter((x) => x.port === 6379).length, 1);
  assert.equal(by(8321).scope, 'mesh');
  assert.equal(by(8080).scope, 'lan');
  assert.equal(by(5432).scope, 'loopback');
  assert.equal(by(53).scope, 'loopback');
  assert.equal(by(42778).ephemeral, true);
  assert.equal(by(546).scope, 'link-local');
  assert.equal(by(546).iface, 'wlp0s20f3');
  assert.equal(by(67).scope, 'lan');
  // Established connections are not listeners.
  assert.equal(l.filter((x) => x.port === 22).length, 2);
});

// The host's own firewall (default drop, ssh allowed from the LAN prefix only, http from anywhere) and fips's
// baseline (fips0 only, drop-in allows 8321 from one address).
const m = (left: object, right: unknown, op = '==') => ({ match: { op, left, right } });
const dport = (proto: string) => ({ payload: { protocol: proto, field: 'dport' } });
const NFT = JSON.stringify({ nftables: [
  { metainfo: { version: '1.1' } },
  { table: { family: 'inet', name: 'filter' } },
  { chain: { family: 'inet', table: 'filter', name: 'input', type: 'filter', hook: 'input', prio: 0, policy: 'drop' } },
  { chain: { family: 'inet', table: 'filter', name: 'services' } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', expr: [m({ ct: { key: 'state' } }, ['established', 'related'], 'in'), { accept: null }] } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', expr: [m({ meta: { key: 'iifname' } }, 'lo'), { accept: null }] } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', expr: [m({ meta: { key: 'iifname' } }, TUN), { accept: null }] } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', expr: [m({ payload: { protocol: 'ip', field: 'saddr' } }, { prefix: { addr: '192.168.1.0', len: 24 } }), m(dport('tcp'), 22), { accept: null }] } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', expr: [{ jump: { target: 'services' } }] } },
  { rule: { family: 'inet', table: 'filter', chain: 'services', expr: [m(dport('tcp'), { set: [80, 443, { range: [8000, 8099] }] }), { counter: null }, { accept: null }] } },
  { table: { family: 'inet', name: 'fips' } },
  { chain: { family: 'inet', table: 'fips', name: 'inbound', type: 'filter', hook: 'input', prio: 0, policy: 'accept' } },
  { rule: { family: 'inet', table: 'fips', chain: 'inbound', expr: [m({ meta: { key: 'iifname' } }, TUN, '!='), { return: null }] } },
  { rule: { family: 'inet', table: 'fips', chain: 'inbound', expr: [m({ ct: { key: 'state' } }, ['established', 'related'], 'in'), { accept: null }] } },
  { rule: { family: 'inet', table: 'fips', chain: 'inbound', expr: [m({ meta: { key: 'nfproto' } }, 'ipv6'), m({ payload: { protocol: 'icmpv6', field: 'type' } }, 'echo-request'), { accept: null }] } },
  { rule: { family: 'inet', table: 'fips', chain: 'inbound', expr: [m({ payload: { protocol: 'ip6', field: 'saddr' } }, 'fd00::1'), m(dport('tcp'), 8321), { accept: null }] } },
  { rule: { family: 'inet', table: 'fips', chain: 'inbound', expr: [{ counter: { packets: 0, bytes: 0 } }, { drop: null }] } },
] });

test('nftModel: every base chain on the input hook must accept', () => {
  const fw = nftModel(NFT)!;
  assert.equal(fw.backend, 'nft');
  assert.equal(fw.defaultDeny, true);
  const v = (port: number, iface = '*', family: 'ip' | 'ip6' = 'ip', proto: 'tcp' | 'udp' = 'tcp') => fw.verdict({ proto, port, family, iface, tun: TUN });
  assert.equal(v(22), 'restricted');
  assert.equal(v(22, '*', 'ip6'), 'blocked');
  assert.equal(v(80), 'allowed');
  assert.equal(v(8050), 'allowed');
  assert.equal(v(80, '*', 'ip', 'udp'), 'blocked');
  assert.equal(v(6379), 'blocked');
  // From the mesh: the host chain accepts fips0, fips's own chain allows 8321 from one address and drops the rest.
  assert.equal(v(8321, TUN, 'ip6'), 'restricted');
  assert.equal(v(6379, TUN, 'ip6'), 'blocked');
});

test('nftModel: no input chain, open policy, unknown expressions', () => {
  assert.equal(nftModel(JSON.stringify({ nftables: [{ table: { family: 'inet', name: 'nat' } }] }))!.backend, 'none');
  const open = nftModel(JSON.stringify({ nftables: [{ chain: { family: 'ip', table: 't', name: 'in', type: 'filter', hook: 'input', policy: 'accept' } }] }))!;
  assert.equal(open.defaultDeny, false);
  assert.equal(open.verdict({ proto: 'tcp', port: 22, family: 'ip', iface: '*' }), 'allowed');
  // An ip-family chain does not see IPv6.
  assert.equal(open.verdict({ proto: 'tcp', port: 22, family: 'ip6', iface: '*' }), 'none');
  const xt = nftModel(JSON.stringify({ nftables: [
    { chain: { family: 'ip', table: 'filter', name: 'INPUT', type: 'filter', hook: 'input', policy: 'drop' } },
    { rule: { family: 'ip', table: 'filter', chain: 'INPUT', expr: [{ xt: { type: 'match', name: 'multiport' } }, { accept: null }] } },
  ] }))!;
  assert.equal(xt.verdict({ proto: 'tcp', port: 22, family: 'ip', iface: '*' }), 'unknown');
  assert.equal(nftModel('not json'), null);
});

test('ufw and firewalld', () => {
  const ufw = ufwModel(`Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
5000:5010/tcp              ALLOW IN    192.168.1.0/24
22/tcp (v6)                ALLOW IN    Anywhere (v6)
`)!;
  assert.equal(ufw.defaultDeny, true);
  assert.equal(ufw.verdict({ proto: 'tcp', port: 22, family: 'ip', iface: '*' }), 'allowed');
  assert.equal(ufw.verdict({ proto: 'tcp', port: 5005, family: 'ip', iface: '*' }), 'restricted');
  assert.equal(ufw.verdict({ proto: 'tcp', port: 80, family: 'ip', iface: '*' }), 'blocked');
  assert.equal(ufwModel('Status: inactive'), null);
  const fwd = firewalldModel(`public (active)
  target: default
  interfaces: eth0
  services: dhcpv6-client ssh
  ports: 8080/tcp 9000-9010/udp
  rich rules:
`)!;
  assert.equal(fwd.verdict({ proto: 'tcp', port: 22, family: 'ip', iface: '*' }), 'allowed');
  assert.equal(fwd.verdict({ proto: 'udp', port: 9005, family: 'ip', iface: '*' }), 'allowed');
  assert.equal(fwd.verdict({ proto: 'tcp', port: 3306, family: 'ip', iface: '*' }), 'blocked');
});

test('judgeListeners + findings: exposed services, mesh reach, loopback ignored', () => {
  const fw = nftModel(NFT)!;
  const l = judgeListeners(parseSs(SS, TUN, MESH), fw, TUN);
  const redis = l.find((x) => x.port === 6379)!;
  assert.equal(redis.lan, 'blocked');
  assert.equal(redis.mesh, 'blocked');
  assert.equal(l.find((x) => x.port === 8321)!.mesh, 'restricted');
  assert.equal(l.find((x) => x.port === 8321)!.lan, undefined);
  assert.equal(l.find((x) => x.port === 631)!.lan, undefined);
  // Without any firewall, redis on every interface is a high finding and reachable from the mesh.
  const none = nftModel(JSON.stringify({ nftables: [] }))!;
  const raw = scan({ ss: ok(SS), nft: ok(JSON.stringify({ nftables: [] })) });
  const r = analyse(raw, { tun: TUN, meshAddr: MESH });
  assert.equal(none.backend, 'none');
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes('exposed-tcp/6379'));
  assert.equal(r.findings.find((f) => f.id === 'exposed-tcp/6379')!.severity, 'critical');
  assert.ok(ids.includes('mesh-tcp/6379'));
  assert.ok(ids.includes('firewall-open'));
  assert.ok(!ids.some((f) => f.includes('/631') || f.includes('42778')));
  // sshd on 0.0.0.0 and [::] is one finding.
  assert.equal(ids.filter((f) => f === 'exposed-tcp/22').length, 1);
});

test('apt, debsecan, dnf, pacman, arch-audit, zypper', () => {
  const apt = parseAptUpgrade(`NOTE: This is only a simulation!
Inst libssl3 [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])
Inst tzdata [2024a-0+deb12u1] (2024b-0+deb12u1 Debian:12.7/stable [all])
Conf libssl3 (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])
`);
  assert.deepEqual(apt.map((u) => [u.name, u.security, u.to]), [['libssl3', true, '3.0.11-1~deb12u2'], ['tzdata', false, '2024b-0+deb12u1']]);
  const deb = parseDebsecan(`CVE-2024-0001 openssl (fixed, remotely exploitable, high urgency)
CVE-2024-0002 openssl (fixed, low urgency)
CVE-2024-0003 bash (medium urgency)
`);
  assert.deepEqual(deb.map((v) => [v.pkg, v.fixed, v.severity, v.ids.length]), [['openssl', true, 'critical', 2], ['bash', false, 'medium', 1]]);
  assert.deepEqual(parseDnfUpdates(`Last metadata expiration check: 0:10:00 ago.

openssl.x86_64            1:3.1.4-2.fc39       updates
kernel.x86_64             6.8.5-201.fc39       updates
Obsoleting Packages
grub2-tools.x86_64        1:2.06-1.fc39        updates
`).map((u) => u.name), ['openssl', 'kernel']);
  assert.deepEqual(parseDnfUpdateinfo(`FEDORA-2024-abc Important/Sec. openssl-1:3.1.4-2.fc39.x86_64
FEDORA-2024-def Moderate/Sec.  curl-8.2.1-4.fc39.x86_64
`), [{ id: 'FEDORA-2024-abc', severity: 'high', pkg: 'openssl' }, { id: 'FEDORA-2024-def', severity: 'medium', pkg: 'curl' }]);
  // dnf5 columns
  assert.deepEqual(parseDnfUpdateinfo(`Name                     Type     Severity  Package                         Issued
FEDORA-2024-abc security Critical openssl-1:3.1.4-2.fc40.x86_64 2024-04-01 00:00:00
`), [{ id: 'FEDORA-2024-abc', severity: 'critical', pkg: 'openssl' }]);
  assert.deepEqual(parseCheckupdates('linux 6.8.1.arch1-1 -> 6.8.2.arch1-1\nbad line\n'), [{ name: 'linux', from: '6.8.1.arch1-1', to: '6.8.2.arch1-1', security: false }]);
  const aa = parseArchAudit(JSON.stringify([{ name: 'AVG-1', packages: ['openssl', 'lib32-openssl'], status: 'Fixed', severity: 'High', type: 'arbitrary code execution', fixed: '3.2.1-1', issues: ['CVE-2024-1'] }, { name: 'AVG-2', packages: ['vim'], status: 'Vulnerable', severity: 'Low', type: 'unknown', fixed: null, issues: ['CVE-2024-2'] }]));
  assert.deepEqual(aa.map((v) => [v.pkg, v.severity, v.fixed]), [['openssl', 'high', true], ['lib32-openssl', 'high', true], ['vim', 'low', false]]);
  assert.deepEqual(parseArchAudit('garbage'), []);
  assert.deepEqual(parseZypperUpdates('<stream><update-status><update-list><update kind="package" name="curl" edition="8.6-1" edition-old="8.5-1" arch="x86_64"/></update-list></update-status></stream>').map((u) => [u.name, u.to, u.from]), [['curl', '8.6-1', '8.5-1']]);
  const zp = parseZypperPatches('<update kind="patch" name="openSUSE-2024-1" category="security" severity="important" status="needed"><summary>Security update for curl</summary><issue-list><issue type="cve" id="CVE-2024-9"/></issue-list></update>');
  assert.deepEqual(zp.map((v) => [v.pkg, v.severity, v.ids]), [['Security update for curl', 'high', ['CVE-2024-9']]]);
});

test('rebootState: removed kernel, reboot-required, needrestart', () => {
  const r = rebootState({ uname: ok('6.8.1-arch1-1\n'), kernels: ok('6.8.2-arch1-1\n'), reboot_required: ok('yes\nlinux-image-6.8\n'), needrestart: ok('NEEDRESTART-VER: 3.6\nNEEDRESTART-KSTA: 3\nNEEDRESTART-SVC: nginx.service\n') });
  assert.equal(r.required, true);
  assert.equal(r.reasons.length, 3);
  assert.deepEqual(r.services, ['nginx.service']);
  assert.equal(rebootState({ uname: ok('6.8.2\n'), kernels: ok('6.8.1\n6.8.2\n'), reboot_required: ok('no\n') }).required, false);
});

test('score: deductions, category caps, critical ceiling, grades', () => {
  const f = (category: Finding['category'], severity: Finding['severity'], i = 0): Finding => ({ id: `${category}-${severity}-${i}`, category, severity, title: '' });
  assert.deepEqual([score([]).score, score([]).grade], [100, 'A']);
  assert.equal(score([f('patches', 'high')]).score, 90);
  // Ten high exposure findings take at most the category cap (30).
  assert.equal(score(Array.from({ length: 10 }, (_, i) => f('exposure', 'high', i))).score, 70);
  assert.equal(score([f('hardening', 'critical')]).score, 59);
  assert.equal(score([f('hardening', 'critical')]).grade, 'F');
  assert.equal(score([f('hardening', 'info')]).categories.hardening.findings, 1);
});

test('analyse: the report from a whole scan', () => {
  const raw = scan({
    os_release: ok('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n'), uname: ok('6.1.0-18-amd64\n'), kernels: ok('6.1.0-18-amd64\n'), reboot_required: ok('no\n'),
    ss: ok(SS), nft: ok(NFT),
    apt_upgrade: ok('Inst libssl3 [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])\n'),
    apt_lists_age: ok(String(Math.floor(Date.now() / 1000) - 10 * 86400)),
    sshd: ok('permitrootlogin yes\npasswordauthentication no\nx11forwarding no\nmaxauthtries 6\n'),
    sysctl: ok('kernel.randomize_va_space = 2\nkernel.kptr_restrict = 0\n'),
    uid0: ok('root\ntoor\n'), empty_passwords: ok(''),
    fips_files: ok('640 root fips /etc/fips/fips.key\n644 root root /etc/fips/fips.yaml\n'),
  }, 'apt');
  const r = analyse(raw, { tun: TUN, meshAddr: MESH, fipsFirewallActive: true });
  assert.equal(r.system.name, 'Debian GNU/Linux 12 (bookworm)');
  assert.equal(r.firewall.defaultDeny, true);
  const ids = r.findings.map((x) => x.id);
  for (const id of ['patches-security', 'patches-stale', 'vulns-no-tool', 'ssh-root', 'sysctl-kptr', 'uid0', 'fips-config']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('fips-key'));
  assert.ok(!ids.includes('firewall-open'));
  assert.equal(r.findings[0].severity, 'critical');
  assert.equal(r.score, 59);
});

test('nextRun: weekly slot, missed slots, failures, disabled', () => {
  const s = { enabled: true, weekday: 0, hour: 3 };
  const sunday3 = new Date(2026, 9, 25, 3, 0, 0).getTime(); // Sunday 25 Oct 2026, 03:00 local
  const wed = new Date(2026, 9, 28, 12, 0, 0).getTime();
  // Scanned at the last slot: next Sunday.
  assert.equal(new Date(nextRun(s, sunday3 + 60_000, wed)!).getDate(), 1);
  // Not scanned since before that slot (fips-ui was down): due at once.
  assert.equal(nextRun(s, sunday3 - 3600_000, wed), sunday3);
  // A failed attempt after the slot: an hour later.
  assert.equal(nextRun(s, sunday3 - 3600_000, wed, wed - 60_000), wed - 60_000 + 3600_000);
  assert.equal(nextRun({ ...s, enabled: false }, 0, wed), null);
  // Across a daylight-saving change the next scan keeps its local hour.
  const next = new Date(nextRun({ ...s, weekday: 3, hour: 2 }, wed, wed)!);
  assert.deepEqual([next.getDay(), next.getHours(), next.getMinutes()], [3, 2, 0]);
  assert.throws(() => validateSettings({ enabled: true, weekday: 7, hour: 3 }), /weekday/);
  assert.throws(() => validateSettings({ enabled: 'yes', weekday: 0, hour: 3 }), /enabled/);
});

test('SecurityScanner: scan, keep the newest reports, settings, failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fips-ui-security-'));
  let t = 1_800_000_000_000;
  let fail = false;
  const sc = new SecurityScanner({
    file: join(dir, 'security.json'), now: () => t, available: async () => true, context: async () => ({}),
    run: async () => { if (fail) throw new Error('helper v12 has no security-scan'); return { ...scan({ ss: ok(SS) }), finished: Math.floor(t / 1000) }; },
  });
  await sc.start();
  sc.stop();
  assert.equal(sc.status().latest, null);
  for (let i = 0; i < 14; i++) { t += 1000; await sc.scan(); }
  assert.equal(sc.history().length, 12);
  assert.equal(readdirSync(join(dir, 'security')).length, 12);
  assert.ok(sc.summary()!.score <= 100);
  fail = true; t += 1000;
  await sc.scan();
  assert.match(sc.status().lastError!, /no security-scan/);
  assert.equal(sc.history().length, 12);
  await sc.saveSettings({ enabled: false, weekday: 2, hour: 4 });
  const again = new SecurityScanner({ file: join(dir, 'security.json'), now: () => t, available: async () => true, context: async () => ({}), run: async () => scan({}) });
  await again.start(); again.stop();
  assert.deepEqual(again.status().settings, { enabled: false, weekday: 2, hour: 4 });
  assert.equal(again.history().length, 12);
});

function ok(out: string): RawSection { return { code: 0, out }; }
function scan(sections: Record<string, RawSection>, pm = 'none'): RawScan {
  return { ok: true, version: 13, pm, nixos: false, started: 1_800_000_000, finished: 1_800_000_060, sections };
}
