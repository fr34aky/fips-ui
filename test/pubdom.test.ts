import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { detect, READ_COMMANDS, WRITE_COMMANDS, DOMAIN_RE, ZONE_FILE_RE, PubdomStateError, binaryVersion, isSide, latestRelease, liveZonesDir, parseUnitShow, parseVersionLine, readEditable, zoneFileWithin, selfHostnames, hostMatches } from '../server/pubdom.ts';

const paths = {
  resolver: { socket: '/run/r.sock', files: ['/etc/r.yaml', '/var/r.json'] },
  server: { socket: '/run/s.sock', files: ['/etc/s.yaml', '/etc/zones'] },
};

test('a side is installed by its socket or its files, running only by its socket', () => {
  const none = detect(paths, () => false, () => false);
  assert.deepEqual(none.resolver, { socket: '/run/r.sock', running: false, installed: false });
  assert.deepEqual(none.server, { socket: '/run/s.sock', running: false, installed: false });
  const stopped = detect(paths, (p) => p === '/etc/zones', () => false);
  assert.equal(stopped.server.installed, true);
  assert.equal(stopped.server.running, false);
  assert.equal(stopped.resolver.installed, false);
  const up = detect(paths, () => false, (p) => p === '/run/r.sock');
  assert.equal(up.resolver.running, true);
  assert.equal(up.resolver.installed, true);
  // The socket is judged like control.ts judges fips's own: a host:port override is reachable, a path must exist.
  assert.equal(detect({ ...paths, resolver: { ...paths.resolver, socket: '127.0.0.1:21212' } }, () => false).resolver.running, true);
});

test('only read-only commands are proxied', () => {
  assert.ok(READ_COMMANDS.server.has('zones') && READ_COMMANDS.resolver.has('pins'));
  for (const w of ['publish', 'forget', 'flush', 'check-dns']) assert.ok(!READ_COMMANDS.server.has(w) && !READ_COMMANDS.resolver.has(w), w);
  assert.ok(isSide('server') && isSide('resolver') && !isSide('gateway'));
});

test('write commands are the admin actions and nothing else', () => {
  assert.deepEqual([...WRITE_COMMANDS.server].sort(), ['check-dns', 'publish']);
  assert.deepEqual([...WRITE_COMMANDS.resolver].sort(), ['flush', 'forget']);
  for (const w of ['publish', 'forget', 'flush', 'check-dns']) assert.ok(!READ_COMMANDS.server.has(w) && !READ_COMMANDS.resolver.has(w), w);
});

test('a zone file is a plain <domain>.yaml directly in the zones directory', () => {
  assert.ok(zoneFileWithin('/etc/fips-pubdom/zones', '/etc/fips-pubdom/zones/example.org.yaml'));
  assert.ok(zoneFileWithin('/etc/fips-pubdom/zones/', '/etc/fips-pubdom/zones/example.org.yaml'));
  assert.ok(!zoneFileWithin('/etc/fips-pubdom/zones', '/etc/fips-pubdom/server.yaml'));
  assert.ok(!zoneFileWithin('/etc/fips-pubdom/zones', '/etc/fips-pubdom/zones/sub/example.org.yaml'));
  assert.ok(!zoneFileWithin('/etc/fips-pubdom/zones', '/etc/fips-pubdom/zones/../server.yaml'));
  assert.ok(zoneFileWithin('/etc/fips-pubdom/zones', '/etc/fips-pubdom/zones/My_Site.yaml'), 'any name the server loads');
  assert.ok(ZONE_FILE_RE.test('example.org.yaml') && !ZONE_FILE_RE.test('example.org') && !ZONE_FILE_RE.test('.yaml') && !ZONE_FILE_RE.test('a/b.yaml') && !ZONE_FILE_RE.test('-x.yaml'));
  assert.ok(DOMAIN_RE.test('example.org') && DOMAIN_RE.test('a.b.example.co.uk') && !DOMAIN_RE.test('example') && !DOMAIN_RE.test('-x.org') && !DOMAIN_RE.test('Example.org'));
});

test('an editable file comes with the hash the helper checks; a missing one with base none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubdom-'));
  const f = path.join(dir, 'server.yaml');
  fs.writeFileSync(f, 'zones: /etc/fips-pubdom/zones\n');
  const r = readEditable(f);
  assert.equal(r.text, 'zones: /etc/fips-pubdom/zones\n');
  assert.equal(r.base, createHash('sha256').update('zones: /etc/fips-pubdom/zones\n').digest('hex'));
  assert.deepEqual(readEditable(path.join(dir, 'none.yaml')), { path: path.join(dir, 'none.yaml'), text: '', base: 'none' });
  // server.yaml may hold the key itself; such a file is never sent to a browser.
  for (const k of ['key: nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n', 'key: "' + 'ab'.repeat(32) + '"  # hex\n']) {
    fs.writeFileSync(f, 'zones: /z\n' + k);
    assert.throws(() => readEditable(f), /holds the key itself/);
  }
  fs.writeFileSync(f, 'key: /etc/fips/fips.key\n');
  assert.equal(readEditable(f).text, 'key: /etc/fips/fips.key\n');
  fs.rmSync(dir, { recursive: true });
});

test('a server running from --zone flags is an operator state with the step to take, not a fault', async () => {
  assert.equal(await liveZonesDir(async () => ({ zones_dir: '/etc/fips-pubdom/zones' }), () => true), '/etc/fips-pubdom/zones');
  await assert.rejects(liveZonesDir(async () => ({ zones_dir: null }), () => false), (e: Error) => e instanceof PubdomStateError && /fips-pubdom-server init/.test(e.message) && /systemctl restart fips-pubdom-server/.test(e.message));
  // The file is already there (written by hand or from the settings card without a restart): only the restart is missing.
  await assert.rejects(liveZonesDir(async () => ({}), () => true), (e: Error) => e instanceof PubdomStateError && !/init/.test(e.message) && /systemctl restart fips-pubdom-server/.test(e.message));
});

test('binary versions and unit states are read from the tools\' own output', async () => {
  assert.equal(parseVersionLine('fips-pubdomd 0.2.8\n'), '0.2.8');
  assert.equal(parseVersionLine('fips-pubdom-server 0.3.0-rc.1'), '0.3.0-rc.1');
  assert.equal(parseVersionLine(''), null);
  assert.equal(await binaryVersion('fips-pubdomd', async () => 'fips-pubdomd 0.2.8'), '0.2.8');
  assert.equal(await binaryVersion('fips-pubdomd', async () => { throw new Error('ENOENT'); }), null);
  assert.deepEqual(parseUnitShow('LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n'), { loaded: true, active: 'active', sub: 'running', enabled: 'enabled' });
  assert.equal(parseUnitShow('LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n'), null);
  assert.equal(parseUnitShow(''), null);
});

test('the newest release is read from GitHub and an error keeps the last answer', async () => {
  const r = await latestRelease(true, async () => ({ tag_name: 'v0.2.8', html_url: 'https://example/r', published_at: '2026-10-08T00:00:00Z' }));
  assert.deepEqual(r.latest, { tag: 'v0.2.8', version: '0.2.8', url: 'https://example/r', publishedAt: '2026-10-08T00:00:00Z' });
  const cached = await latestRelease(false, async () => { throw new Error('must not be called'); });
  assert.equal(cached.latest?.version, '0.2.8');
  const failed = await latestRelease(true, async () => { throw new Error('GitHub answered 403'); });
  assert.match(failed.error ?? '', /403/);
  assert.equal(failed.latest?.version, '0.2.8');
  const odd = await latestRelease(true, async () => ({ tag_name: 'nightly' }));
  assert.match(odd.error ?? '', /unexpected release tag/);
});

test('only the names the domain server answers with this node are this node\'s', () => {
  const other = 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98';
  const published = { claim_published_at: 1, last_error: null };
  const names = selfHostnames({ zones: [
    { domain: 'Example.org.', ...published, names: [{ label: '@', target: 'self' }, { label: 'www', target: 'self' }, { label: 'shop', target: other }, { label: 'old', target: 'legacy' }] },
    // "*" covers every depth and the domain itself; an exception covers exactly its own label.
    { domain: 'apps.example.net', ...published, names: [{ label: '*', target: 'self' }, { label: 'blog', target: 'legacy' }, { label: 'shop', target: other }] },
    { domain: 'unclaimed.org', claim_published_at: null, names: [{ label: '@', target: 'self' }] },
    { domain: 'failing.org', claim_published_at: 1, last_error: 'relay refused', names: [{ label: '@', target: 'self' }] },
    { domain: 'bad domain', ...published, names: [{ label: '@', target: 'self' }] },
  ] });
  for (const h of ['example.org', 'www.example.org', 'WWW.Example.org.', 'apps.example.net', 'ui.apps.example.net', 'a.b.apps.example.net', 'x.blog.apps.example.net']) assert.ok(hostMatches(h, names), h);
  for (const h of ['shop.example.org', 'old.example.org', 'x.www.example.org', 'blog.apps.example.net', 'shop.apps.example.net',
    'unclaimed.org', 'failing.org', 'evil.com', 'example.org.evil.com', 'xapps.example.net']) assert.ok(!hostMatches(h, names), h);
  assert.equal(selfHostnames(null).size, 0);
});

test('a zone may name this node by its own npub instead of self', () => {
  const own = 'npub1k3aerhf3f4ed9mrlu2zcusx3yruvzqyeut0kz5we5xd023jfgl0s8wcl6n';
  const other = 'npub12yu4dny6chzwghtq68ygmkyj7ugz93e403skz3y075mykjsheg7sp0yyzz';
  const zone = (names: { label: string; target: string }[]) => ({ zones: [{ domain: 'unkn0wn.ch', claim_published_at: 1, last_error: null, names }] });
  // home's own zone: home -> its own npub, pixel -> another node.
  const names = selfHostnames(zone([{ label: 'home', target: own }, { label: 'pixel', target: other }]), own);
  assert.ok(hostMatches('home.unkn0wn.ch', names));
  assert.ok(!hostMatches('pixel.unkn0wn.ch', names));
  assert.ok(!hostMatches('home.unkn0wn.ch', selfHostnames(zone([{ label: 'home', target: own }]))), 'without its own npub only "self" counts');
  // Upper-case bech32 and stray whitespace are the same npub.
  assert.ok(hostMatches('home.unkn0wn.ch', selfHostnames(zone([{ label: 'home', target: ` ${own.toUpperCase()} ` }]), own)));
  // "@" and "*" by npub, and an exact label elsewhere still overriding the wildcard.
  const wild = selfHostnames(zone([{ label: '@', target: own }, { label: '*', target: own }, { label: 'pixel', target: other }]), own);
  for (const h of ['unkn0wn.ch', 'x.unkn0wn.ch', 'a.b.unkn0wn.ch']) assert.ok(hostMatches(h, wild), h);
  assert.ok(!hostMatches('pixel.unkn0wn.ch', wild));
});
