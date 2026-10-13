// Roles for Web UI over the mesh: what each role may do, and that superadmin entries are a superadmin's to change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin, isSuperadmin, superadminChange, validateAccess, type AccessEntry } from '../server/access.ts';

const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const npub = (seed: number) => { const d = Array.from({ length: 4 }, (_, i) => CHARS[Math.floor(seed / 32 ** i) % 32]).join(''); return 'npub1' + d + Array.from({ length: 54 }, (_, i) => CHARS[(i * 13) % 32]).join(''); };
const [A, B, C] = [1, 2, 3].map(npub);

test('superadmin is an admin; viewer is neither', () => {
  assert.equal(isAdmin('superadmin'), true);
  assert.equal(isAdmin('admin'), true);
  assert.equal(isAdmin('viewer'), false);
  assert.equal(isSuperadmin('admin'), false);
  assert.equal(isSuperadmin('superadmin'), true);
});

test('validateAccess accepts the three roles and nothing else', () => {
  const cfg = validateAccess({ enabled: true, port: 8321, allowed: [{ npub: A, role: 'viewer' }, { npub: B, role: 'admin' }, { npub: C, role: 'superadmin' }] });
  assert.deepEqual(cfg.allowed.map((e) => e.role), ['viewer', 'admin', 'superadmin']);
  assert.throws(() => validateAccess({ enabled: true, port: 8321, allowed: [{ npub: A, role: 'root' }] }), /viewer, admin or superadmin/);
});

test('an admin may not grant, change or remove superadmin entries', () => {
  const before: AccessEntry[] = [{ npub: A, role: 'admin' }, { npub: B, role: 'superadmin' }];
  // Unchanged, or changes to other entries: fine.
  assert.equal(superadminChange(before, before), null);
  assert.equal(superadminChange(before, [{ npub: A, role: 'viewer' }, { npub: B, role: 'superadmin' }, { npub: C, role: 'admin' }]), null);
  assert.equal(superadminChange(before, [{ npub: B, role: 'superadmin' }]), null);
  // Promoting itself, demoting or removing the superadmin: refused.
  assert.match(superadminChange(before, [{ npub: A, role: 'superadmin' }, { npub: B, role: 'superadmin' }])!, /grant superadmin/);
  assert.match(superadminChange(before, [{ npub: A, role: 'admin' }, { npub: B, role: 'admin' }])!, /change the role of a superadmin/);
  assert.match(superadminChange(before, [{ npub: A, role: 'admin' }])!, /remove a superadmin/);
  assert.match(superadminChange(before, [{ npub: A, role: 'admin' }, { npub: B, role: 'superadmin', label: 'renamed' }])!, /change a superadmin's entry/);
});
