// The hash route: '#/<view>?qs' for this node, '#/node/<npub>/<view>?qs' for a node managed from here (its API is
// reached through this node's proxy, lib/api.ts apiBase).
import { NPUB_RE } from './types';

export interface Route { node: string | null; view: string; params: URLSearchParams }

export function parseHash(hash = location.hash): Route {
  const h = hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const segs = path.split('/');
  let node: string | null = null;
  if (segs[0] === 'node' && NPUB_RE.test(segs[1] ?? '')) { node = segs[1]; segs.splice(0, 2); }
  return { node, view: segs[0] ?? '', params: new URLSearchParams(qs ?? '') };
}

/** The node the page looks at right now, from the hash. */
export const currentNode = (): string | null => parseHash().node;

/** A link to `view`, on the node the page looks at unless another (or null for this node) is given. */
export function hashFor(view: string, params?: Record<string, string>, node: string | null = currentNode()): string {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return `#/${node ? `node/${node}/` : ''}${view}${qs}`;
}

/** The API prefix for a node (lib/api.ts): '' for this one. */
export const baseFor = (node: string | null): string => (node ? `/api/fleet/nodes/${node}` : '');
