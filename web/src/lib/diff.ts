// Minimal line diff (LCS) for config previews. Inputs are a few hundred lines, so O(n*m) is fine.
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map((t, i) => ({ kind: 'del' as const, text: t, a: i + 1 })), ...b.map((t, j) => ({ kind: 'add' as const, text: t, b: j + 1 }))];
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: 'del', text: a[i], a: i + 1 }); i++; }
    else { out.push({ kind: 'add', text: b[j], b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i], a: i + 1 }); i++; }
  while (j < m) { out.push({ kind: 'add', text: b[j], b: j + 1 }); j++; }
  return out;
}

/** Collapse unchanged runs to `context` lines around changes. `null` marks an elided gap. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => { if (keep[i]) out.push(l); else if (out.length && out[out.length - 1] !== null) out.push(null); });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length };
}
