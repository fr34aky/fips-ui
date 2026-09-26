import { useEffect, useMemo, useState } from 'react';
import type { Series, MetricDef, StatsPeer } from '../lib/types';
import { Card, Segmented, Empty, ErrorNote, Skeleton } from '../components/ui';
import { TimeSeries, seriesColor } from '../components/TimeSeries';
import { api, usePoll } from '../lib/api';
import { fmtUnitValue, shortKey, titleCase } from '../lib/format';

type Mode = 'node' | 'compare' | 'peer';
type Win = '10m' | '1h' | '6h' | '24h';
const WINDOWS: { value: Win; label: string; gran: '1s' | '1m'; step: number; refresh: number }[] = [
  { value: '10m', label: '10 min', gran: '1s', step: 1, refresh: 3000 },
  { value: '1h', label: '1 hour', gran: '1s', step: 1, refresh: 10000 },
  { value: '6h', label: '6 hours', gran: '1m', step: 60, refresh: 30000 },
  { value: '24h', label: '24 hours', gran: '1m', step: 60, refresh: 60000 },
];
const NODE_ORDER = ['mesh_size', 'peer_count', 'tree_depth', 'bytes_in', 'bytes_out', 'packets_in', 'packets_out', 'loss_rate', 'active_sessions', 'parent_switches'];
const PEER_ORDER = ['srtt_ms', 'loss_rate', 'bytes_in', 'bytes_out', 'packets_in', 'packets_out', 'ecn_ce'];
const LABELS: Record<string, string> = { mesh_size: 'Estimated mesh size', peer_count: 'Peers', tree_depth: 'Tree depth', bytes_in: 'Bytes in', bytes_out: 'Bytes out', packets_in: 'Packets in', packets_out: 'Packets out', loss_rate: 'Loss rate', active_sessions: 'Active sessions', parent_switches: 'Parent switches', srtt_ms: 'Smoothed RTT', ecn_ce: 'ECN CE marks' };
const label = (m: string) => LABELS[m] ?? titleCase(m);

export function Metrics({ initialPeer }: { initialPeer?: string | null }) {
  const [mode, setMode] = useState<Mode>(initialPeer ? 'peer' : 'node');
  const [win, setWin] = useState<Win>('10m');
  const [peer, setPeer] = useState<string>(initialPeer ?? '');
  const [metric, setMetric] = useState('srtt_ms');
  const w = WINDOWS.find((x) => x.value === win)!;
  const meta = usePoll(() => Promise.all([api.q<{ metrics: MetricDef[] }>('show_stats_list'), api.q<{ peers: StatsPeer[] }>('show_stats_peers')]), [], 30000);
  const peers = meta.data?.[1].peers ?? [];
  const peerMetrics = (meta.data?.[0].metrics ?? []).filter((m) => m.scope === 'peer');
  useEffect(() => { if (!peer && peers.length) setPeer(peers.find((p) => p.is_active)?.npub ?? peers[0].npub); }, [peers, peer]);

  return (
    <div className="grid gap-4 fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'node', label: 'Node' }, { value: 'compare', label: 'Compare peers' }, { value: 'peer', label: 'One peer' }]} />
        <Segmented value={win} onChange={setWin} options={WINDOWS.map((x) => ({ value: x.value, label: x.label }))} />
        {mode === 'compare' && <select className="input w-auto" value={metric} onChange={(e) => setMetric(e.target.value)}>{(peerMetrics.length ? peerMetrics.map((m) => m.name) : PEER_ORDER).map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>}
        {mode === 'peer' && <select className="input w-auto max-w-xs" value={peer} onChange={(e) => setPeer(e.target.value)}>{peers.map((p) => <option key={p.npub} value={p.npub}>{p.display_name || shortKey(p.npub, 12, 6)}{p.is_active ? '' : ' (inactive)'}</option>)}</select>}
        <span className="text-xs text-ink-3 ml-auto">{w.gran === '1s' ? '1 s samples · fast ring' : '1 min samples · slow ring'}</span>
      </div>
      {meta.error && <ErrorNote>{meta.error}</ErrorNote>}
      {mode === 'node' && <AllHistory win={w} />}
      {mode === 'peer' && (peer ? <AllHistory win={w} peer={peer} /> : <Empty>No peers in the stats history yet.</Empty>)}
      {mode === 'compare' && <Compare win={w} metric={metric} />}
    </div>
  );
}

function AllHistory({ win, peer }: { win: (typeof WINDOWS)[number]; peer?: string }) {
  const r = usePoll(() => api.q<{ series: Series[]; granularity_seconds: number }>('show_stats_all_history', { window: win.value, granularity: win.gran, peer }), [win.value, peer], win.refresh);
  const series = useMemo(() => {
    const order = peer ? PEER_ORDER : NODE_ORDER;
    return [...(r.data?.series ?? [])].sort((a, b) => (order.indexOf(a.metric) + 1 || 99) - (order.indexOf(b.metric) + 1 || 99));
  }, [r.data, peer]);
  if (r.error) return <ErrorNote>{r.error}</ErrorNote>;
  if (!r.data) return <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-56 w-full" />)}</div>;
  if (!series.length) return <Empty>No history yet.</Empty>;
  const step = r.data.granularity_seconds || win.step;
  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {series.map((s, i) => {
        const vals = s.values.filter((v): v is number => v != null && Number.isFinite(v));
        const cur = vals.length ? vals[vals.length - 1] : null;
        const max = vals.length ? Math.max(...vals) : null;
        const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        return (
          <Card key={s.metric} title={label(s.metric)} actions={<span className="text-sm font-semibold tabular">{fmtUnitValue(cur, s.unit)}</span>}>
            <TimeSeries series={[{ label: label(s.metric), values: s.values, color: seriesColor(i) }]} stepSecs={step} unit={s.unit} height={150} />
            <div className="flex gap-4 text-[11px] text-ink-3 mt-1 tabular"><span>avg {fmtUnitValue(avg, s.unit)}</span><span>max {fmtUnitValue(max, s.unit)}</span></div>
          </Card>
        );
      })}
    </div>
  );
}

function Compare({ win, metric }: { win: (typeof WINDOWS)[number]; metric: string }) {
  const r = usePoll(() => api.q<{ metric: string; unit: string; granularity_seconds: number; peers: { node_addr: string; display_name?: string | null; is_active: boolean; values: (number | null)[] }[] }>('show_stats_history_all_peers', { metric, window: win.value, granularity: win.gran }), [metric, win.value], win.refresh);
  if (r.error) return <ErrorNote>{r.error}</ErrorNote>;
  if (!r.data) return <Skeleton className="h-80 w-full" />;
  const active = r.data.peers.filter((p) => p.values.some((v) => v != null));
  const shown = active.slice(0, 8);
  return (
    <Card title={`${label(metric)} across peers`} actions={active.length > 8 ? <span className="text-xs text-ink-3">showing 8 of {active.length}</span> : undefined}>
      {shown.length === 0 ? <Empty>No per-peer samples for this metric.</Empty> : (
        <TimeSeries series={shown.map((p, i) => ({ label: p.display_name || shortKey(p.node_addr, 6, 4), values: p.values, color: seriesColor(i) }))} stepSecs={r.data.granularity_seconds || win.step} unit={r.data.unit} height={340} showLegend />
      )}
    </Card>
  );
}
