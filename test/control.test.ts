import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipv6tunEndpoint, endpointOptions } from '../server/control.ts';

const noRealpath = (p: string) => { throw new Error(`ENOENT ${p}`); };

test('adapter socket is a sibling of the control socket, -ipv6tun before the extension', () => {
  assert.equal(ipv6tunEndpoint('/run/fips/control.sock', noRealpath), '/run/fips/control-ipv6tun.sock');
  assert.equal(ipv6tunEndpoint('/var/run/fips/control.sock', noRealpath), '/var/run/fips/control-ipv6tun.sock');
  assert.equal(ipv6tunEndpoint('/tmp/fips-control.sock', noRealpath), '/tmp/fips-control-ipv6tun.sock');
  assert.equal(ipv6tunEndpoint('/srv/node.ctl', noRealpath), '/srv/node-ipv6tun.ctl');
  assert.equal(ipv6tunEndpoint('/srv/node', noRealpath), '/srv/node-ipv6tun');
});

test('a symlinked control socket is followed before deriving the adapter path', () => {
  assert.equal(ipv6tunEndpoint('/home/me/ctl.sock', () => '/run/fips/control.sock'), '/run/fips/control-ipv6tun.sock');
});

test('a TCP control endpoint gives the port plus 2', () => {
  assert.equal(ipv6tunEndpoint('21210'), '21212');
  assert.equal(ipv6tunEndpoint('127.0.0.1:21210'), '127.0.0.1:21212');
  assert.equal(ipv6tunEndpoint('[::1]:21210'), '[::1]:21212');
  assert.deepEqual(endpointOptions(ipv6tunEndpoint('[::1]:21210')), { host: '::1', port: 21212 });
});
