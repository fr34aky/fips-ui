// IPv6 helpers shared by the firewall rules and mesh access.
import { isIPv6 } from 'node:net';

/** Full, lowercase, zero-padded form of an IPv6 address so textual variants compare equal; null if not IPv6. */
export function expand6(addr: string): string | null {
  const a = addr.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (!isIPv6(a) || a.includes('.')) return null;
  const [head, tail] = a.includes('::') ? a.split('::') : [a, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')).join(':') : null;
}

/** True for an address whose first byte is 0xfd (fd00::/8), the only addresses the mesh carries. */
export function isMeshAddress(addr: string | undefined): boolean {
  const e = addr ? expand6(addr) : null;
  return !!e && e.startsWith('fd');
}

/** An fd00::/8 address with an optional /8../128 prefix length. */
export function isMeshPrefix(s: string): boolean {
  const [addr, len, extra] = s.split('/');
  if (extra !== undefined || !isMeshAddress(addr)) return false;
  if (len === undefined) return true;
  const n = Number(len);
  return /^\d{1,3}$/.test(len) && n >= 8 && n <= 128;
}
