export function fmtBytes(n: number | null | undefined, perSec = false): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n), i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const s = v >= 100 || i === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${n < 0 ? '-' : ''}${s} ${units[i]}${perSec ? '/s' : ''}`;
}

export function fmtBits(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '–';
  const units = ['bps', 'kbps', 'Mbps', 'Gbps'];
  let v = bps, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '–';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–';
  if (Math.abs(n) < 1000) return Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1);
  return n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

export function fmtPct(frac: number | null | undefined, digits = 1): string {
  if (frac == null || !Number.isFinite(frac)) return '–';
  return `${(frac * 100).toFixed(digits)}%`;
}

export function fmtMs(ms: number | null | undefined, digits = 1): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(ms < 10 ? digits + 1 : digits)} ms`;
}

export function fmtDuration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return '–';
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

export function fmtAgo(epochMs: number | null | undefined, now = Date.now()): string {
  if (!epochMs) return '–';
  const diff = Math.max(0, now - epochMs);
  if (diff < 1500) return 'just now';
  return `${fmtDuration(diff / 1000)} ago`;
}

export function fmtTime(epochMs: number, withDate = false): string {
  const d = new Date(epochMs);
  const t = d.toLocaleTimeString(undefined, { hour12: false });
  return withDate ? `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}` : t;
}

export function shortKey(s: string | null | undefined, head = 10, tail = 6): string {
  if (!s) return '–';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function fmtUnitValue(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '–';
  switch (unit) {
    case 'bytes/s': return fmtBytes(v, true);
    case 'fraction': return fmtPct(v, 2);
    case 'ms': return fmtMs(v);
    case 'packets/s': case 'events/s': return `${fmtCompact(v)} ${unit.split('/')[0]}/s`;
    default: return `${fmtCompact(v)} ${unit}`;
  }
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
