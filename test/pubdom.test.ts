import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { detect, READ_COMMANDS, WRITE_COMMANDS, DOMAIN_RE, ZONE_FILE_RE, isSide, readEditable, zoneFileWithin } from '../server/pubdom.ts';

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
