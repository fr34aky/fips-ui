import test from 'node:test';
import assert from 'node:assert/strict';
import { ipv6Bytes, fipsAddress, innerIpv4, parseClients, EXIT_NAME_RE } from '../server/exit.ts';

const inner = (a: string) => innerIpv4(ipv6Bytes(a)!);

test('the inner address follows the formula fips-exit and fips2go share', () => {
  // The vectors of fips-exit's daemon test, fips2go's shim and its exit container.
  assert.equal(inner('fdab:cdef::'), '100.107.205.239');
  assert.equal(inner('fdff:ffff::'), '100.127.255.255');
  assert.equal(inner('fd00::'), '100.64.0.0');
  assert.equal(inner('fd11:2233:4455:6677::1'), '100.81.34.51');
  assert.equal(inner('fd99:8877:6655:4433::2'), '100.89.136.119');
});

test('an IPv6 address is expanded, and anything else is not one', () => {
  assert.deepEqual([...ipv6Bytes('fd11:2233:4455:6677:8899:aabb:ccdd:eeff')!], [0xfd, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  assert.deepEqual([...ipv6Bytes('fd00::1')!].slice(-2), [0, 1]);
  assert.deepEqual([...ipv6Bytes('::')!], Array(16).fill(0));
  for (const bad of ['', 'fd00', 'fd00:::1', '1.2.3.4', 'fe80::1%eth0', '::ffff:1.2.3.4', 'fd00::g', 'npub1xyz']) assert.equal(ipv6Bytes(bad), null, bad);
});

test('only an fd address is a client', () => {
  assert.equal(fipsAddress(' FD11:2233::1 '), 'fd11:2233::1');
  assert.equal(fipsAddress('2001:db8::1'), null);
  assert.equal(fipsAddress('fc00::1'), null);
});

test('the client list is read as the daemon reads it', () => {
  const list = parseClients([
    '# fips-exit clients: <fips address> [name]. Edit with fips-exit add/remove.',
    'fd11:2233:4455:6677::1 alice-phone',
    '',
    'fd99:8877:6655:4433::2   bob # his laptop',
    'not-an-address x',
    '2001:db8::1 outsider',
    'fd11:2233:4455:6677::1 alice again',
  ].join('\n'));
  assert.deepEqual(list, [
    { address: 'fd11:2233:4455:6677::1', inner: '100.81.34.51', name: 'alice-phone', served: true },
    { address: 'fd99:8877:6655:4433::2', inner: '100.89.136.119', name: 'bob', served: true },
  ]);
  assert.deepEqual(parseClients(''), []);
});

test('a second client with the same inner address is listed as not served', () => {
  // 22 bits: these two differ only above them. The first keeps the address, as in the daemon.
  const list = parseClients('fd11:2233::1 first\nfd51:2233::2 second\n');
  assert.equal(list[0].inner, list[1].inner);
  assert.deepEqual(list.map((c) => c.served), [true, false]);
});

test('a client name is one plain word', () => {
  for (const ok of ['alice-phone', 'pixel9', 'a', 'Home.NAS_2']) assert.ok(EXIT_NAME_RE.test(ok), ok);
  for (const bad of ['', '-rf', 'two words', 'x'.repeat(41), 'a;b', 'a\nb', '$(id)', '../x']) assert.ok(!EXIT_NAME_RE.test(bad), bad);
});
