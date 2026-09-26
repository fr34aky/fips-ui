import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { fmtUnitValue, fmtTime, fmtBytes, fmtCompact } from '../lib/format';

export interface TSSeries { label: string; values: (number | null)[]; color?: string }

const PALETTE = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const seriesColor = (i: number) => PALETTE[i % PALETTE.length];

function cssVar(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name.replace(/^var\(|\)$/g, '')).trim();
  return v || name;
}

/**
 * Time-series line chart (uPlot) with crosshair + tooltip. `values` are evenly spaced samples ending "now",
 * `stepSecs` apart. Single-series charts get an area wash; multi-series charts get a legend.
 */
export function TimeSeries({ series, stepSecs, unit, height = 180, endTs, showLegend }: { series: TSSeries[]; stepSecs: number; unit: string; height?: number; endTs?: number; showLegend?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; ts: number; rows: { label: string; color: string; v: number | null }[] } | null>(null);
  const [theme, setTheme] = useState(0);

  useEffect(() => {
    const obs = new MutationObserver(() => setTheme((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const n = Math.max(0, ...series.map((s) => s.values.length));
  const end = endTs ?? Date.now();
  const data = useMemo(() => {
    const xs = Array.from({ length: n }, (_, i) => (end - (n - 1 - i) * stepSecs * 1000) / 1000);
    const ys = series.map((s) => { const arr = new Array<number | null>(n).fill(null); const off = n - s.values.length; s.values.forEach((v, i) => { arr[off + i] = v == null || !Number.isFinite(v) ? null : v; }); return arr; });
    return [xs, ...ys] as uPlot.AlignedData;
  }, [series, n, stepSecs, end]);

  const colors = series.map((s, i) => cssVar(s.color ?? seriesColor(i)));
  const legend = showLegend ?? series.length > 1;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const grid = cssVar('var(--grid)'), axis = cssVar('var(--axis)'), text = cssVar('var(--text-3)');
    const isPct = unit === 'fraction';
    const isCount = ['nodes', 'peers', 'hops', 'sessions', 'bytes/s', 'packets/s', 'events/s'].includes(unit);
    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height,
      padding: [8, 12, 0, 0],
      cursor: { points: { size: 8, width: 2, stroke: (_u, i) => colors[i - 1], fill: cssVar('var(--surface)') }, drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, min, max) => { if (isPct) return [0, Math.max(0.01, max * 1.1)]; const lo = Math.min(0, min); const hi = max <= lo ? lo + 1 : max + (max - lo) * 0.1; return [lo, hi]; } } },
      axes: [
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: axis, width: 1, size: 4 }, font: '11px system-ui', gap: 6, space: 70, values: (_u, vals) => vals.map((v) => fmtTime(v * 1000)) },
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui', gap: 8, size: 68, incrs: isCount ? [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000] : undefined, values: (_u, vals) => vals.map((v) => fmtAxis(v, unit)) },
      ],
      series: [
        {},
        ...series.map((s, i) => ({ label: s.label, stroke: colors[i], width: 2, points: { show: false }, fill: series.length === 1 ? withAlpha(colors[i], 0.10) : undefined, spanGaps: false })),
      ],
      hooks: {
        setCursor: [(u) => {
          const idx = u.cursor.idx;
          if (idx == null || idx < 0) { setTip(null); return; }
          const left = u.cursor.left ?? 0, top = u.cursor.top ?? 0;
          if (left < 0 || top < 0) { setTip(null); return; }
          setTip({ x: left, y: top, ts: (u.data[0][idx] as number) * 1000, rows: series.map((s, i) => ({ label: s.label, color: colors[i], v: (u.data[i + 1][idx] as number | null) ?? null })) });
        }],
      },
    };
    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => { if (el.clientWidth) plot.setSize({ width: el.clientWidth, height }); });
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.length, unit, height, theme, series.map((s) => s.label).join('|')]);

  useEffect(() => { plotRef.current?.setData(data); }, [data]);

  return (
    <div className="relative min-w-0">
      {legend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pb-1 text-xs text-ink-2">
          {series.map((s, i) => <span key={s.label} className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 rounded" style={{ background: colors[i] }} />{s.label}</span>)}
        </div>
      )}
      <div ref={ref} onMouseLeave={() => setTip(null)} />
      {tip && (
        <div className="pointer-events-none absolute z-10 card px-2.5 py-1.5 text-xs shadow-lg" style={{ left: Math.min(tip.x + 14, (ref.current?.clientWidth ?? 300) - 170), top: Math.max(0, tip.y - 10 + (legend ? 20 : 0)), minWidth: 150 }}>
          <div className="text-ink-3 mb-1 tabular">{fmtTime(tip.ts, true)}</div>
          {tip.rows.map((r) => <div key={r.label} className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-1.5 text-ink-2"><span className="inline-block w-2 h-2 rounded-full" style={{ background: r.color }} />{r.label}</span><span className="tabular font-medium">{fmtUnitValue(r.v, unit)}</span></div>)}
        </div>
      )}
    </div>
  );
}

function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Short axis tick labels: unit suffix dropped where the chart title already carries it. */
function fmtAxis(v: number, unit: string): string {
  switch (unit) {
    case 'bytes/s': return fmtBytes(v, true);
    case 'fraction': return `${(v * 100).toFixed(v * 100 >= 10 ? 0 : 1)}%`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Number.isInteger(v) ? v : v.toFixed(1)}ms`;
    default: return fmtCompact(v);
  }
}
