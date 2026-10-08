import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, READ_COMMANDS, isSide } from '../server/pubdom.ts';

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
