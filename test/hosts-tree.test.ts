// The sync tree across nodes: each node reports its followers upward with its sync (server/hosts-followers.ts).
// Simulates A <- B <- C <- D (and E below B) with one followers store per node, exchanging the real header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostsFollowers, MAX_SUBTREE, parseSubtree } from '../server/hosts-followers.ts';

const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
// Distinct per seed: the seed's base-32 digits, padded with a fixed pattern.
const npub = (seed: number) => { const d = Array.from({ length: 4 }, (_, i) => CHARS[Math.floor(seed / 32 ** i) % 32]).join(''); return 'npub1' + d + Array.from({ length: 54 }, (_, i) => CHARS[(i * 13) % 32]).join(''); };
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(npub);
const dir = mkdtempSync(join(tmpdir(), 'fips-ui-tree-'));
const store = (name: string) => new HostsFollowers(join(dir, `${name}.json`));

/** `child` syncs from `master`: it sends its subtree header, the master records what it parsed. */
async function sync(master: HostsFollowers, masterNpub: string, child: HostsFollowers, childNpub: string, now = Date.now()) {
  const header = await child.subtreeHeader(now);
  await master.record(childNpub, 'fd00::1', 3, { intervalMin: 5 }, parseSubtree(header, childNpub, masterNpub));
}

test('each level sees the whole tree below it', async () => {
  const [a, b, c, d] = [store('a1'), store('b1'), store('c1'), store('d1')];
  // Bottom-up, as the syncs would run over a few intervals.
  await sync(c, C, d, D);
  await sync(b, B, c, C);
  await sync(b, B, store('e1'), E);
  await sync(a, A, b, B);
  const [bOnA] = await a.list();
  assert.equal(bOnA.npub, B);
  assert.deepEqual(bOnA.below, [{ npub: C, parent: B }, { npub: E, parent: B }, { npub: D, parent: C }]);
  // C sees D below it; D sees nothing.
  assert.deepEqual((await c.list())[0].below, []);
  assert.equal((await c.list())[0].npub, D);
});

test('a follower that stops syncing drops out with its subtree', async () => {
  const [a, b, c] = [store('a2'), store('b2'), store('c2')];
  const old = Date.now() - 60 * 60_000;
  await sync(b, B, c, C, old);
  await b.record(C, 'fd00::1', 3, { intervalMin: 5 }, { below: [{ npub: D, parent: C }], more: 0 });
  // C last synced an hour ago (interval 5 min): B no longer reports it, nor D below it.
  const map = (b as unknown as { map: Map<string, { lastSeen: number }> }).map;
  map.get(C)!.lastSeen = old;
  assert.equal(await b.subtreeHeader(), '');
  await sync(a, A, b, B);
  assert.deepEqual((await a.list())[0].below, []);
});

test('invalid, looping and forward references are dropped', () => {
  const h = [`${C}.-`, `${D}.0`, `${A}.0`, `${B}.0`, `${C}.1`, `npub1bad.-`, `${E}.9`, `${E}.1`, '+4'].join(',');
  // A is the receiving node and B the sender: neither may appear below B; C only once; E's first parent is unknown.
  assert.deepEqual(parseSubtree(h, B, A), { below: [{ npub: C, parent: B }, { npub: D, parent: C }, { npub: E, parent: D }], more: 4 });
  assert.equal(parseSubtree(undefined, B, A), undefined);
  assert.deepEqual(parseSubtree('', B, A), { below: [], more: 0 });
});

test('large trees are capped and counted', async () => {
  const b = store('b4');
  const kids = Array.from({ length: MAX_SUBTREE + 20 }, (_, i) => npub(100 + i));
  for (const k of kids) await b.record(k, 'fd00::1', 1, { intervalMin: 5 });
  const header = await b.subtreeHeader();
  assert.ok(header.length < 10_000, `header ${header.length} bytes`);
  const parsed = parseSubtree(header, B, A)!;
  assert.equal(parsed.below.length, MAX_SUBTREE);
  assert.equal(parsed.more, 20);
});
