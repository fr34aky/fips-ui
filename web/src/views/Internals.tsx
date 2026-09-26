import { useState } from 'react';
import { Search } from 'lucide-react';
import type { Snapshot } from '../lib/types';
import { Card, Chip, Copyable, KV, Empty, ErrorNote, Segmented, useNow } from '../components/ui';
import { CounterTable } from '../components/CounterTable';
import { fmtPct, fmtNum, shortKey, fmtDuration, fmtAgo, titleCase } from '../lib/format';
import { api, usePoll } from '../lib/api';

type Tab = 'counters' | 'routing' | 'bloom' | 'caches';

export function Internals({ snap }: { snap: Snapshot }) {
  const [tab, setTab] = useState<Tab>('counters');
  const [filter, setFilter] = useState('');
  return (
    <div className="grid gap-4 fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'counters', label: 'Protocol counters' }, { value: 'routing', label: 'Routing' }, { value: 'bloom', label: 'Bloom filters' }, { value: 'caches', label: 'Caches' }]} />
        {tab === 'counters' && <div className="relative min-w-[200px]"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" /><input className="input pl-9" placeholder="Filter counters…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>}
      </div>
      {tab === 'counters' && <Counters filter={filter} />}
      {tab === 'routing' && <Routing />}
      {tab === 'bloom' && <Bloom snap={snap} />}
      {tab === 'caches' && <Caches />}
    </div>
  );
}

function Counters({ filter }: { filter: string }) {
  const r = usePoll(() => api.q<Record<string, Record<string, number>>>('show_metrics'), [], 5000);
  if (r.error) return <ErrorNote>{r.error}</ErrorNote>;
  if (!r.data) return <Empty>Loading…</Empty>;
  const fams = Object.entries(r.data).filter(([, v]) => v && typeof v === 'object');
  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {fams.map(([name, counters]) => {
        const total = Object.values(counters).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
        return <Card key={name} title={titleCase(name)} actions={<span className="text-xs text-ink-3 tabular">{fmtNum(total)} total</span>} pad={false}><CounterTable data={counters} compact filter={filter} /></Card>;
      })}
    </div>
  );
}

function Routing() {
  const r = usePoll(() => api.q<Record<string, unknown>>('show_routing'), [], 4000);
  if (r.error) return <ErrorNote>{r.error}</ErrorNote>;
  if (!r.data) return <Empty>Loading…</Empty>;
  const d = r.data;
  const pending = (d.pending_lookups as Record<string, unknown>[] | undefined) ?? [];
  const retries = (d.retries as Record<string, unknown>[] | undefined) ?? [];
  const families = ['forwarding', 'discovery', 'error_signals', 'congestion'].filter((k) => d[k] && typeof d[k] === 'object');
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[['Coord cache', d.coord_cache_entries], ['Identity cache', d.identity_cache_entries], ['Pending lookups', pending.length], ['Queued TUN dst', d.pending_tun_destinations], ['Queued TUN pkts', d.pending_tun_packets]].map(([l, v]) => <div key={String(l)} className="card px-4 py-3"><div className="text-xs text-ink-3">{String(l)}</div><div className="text-xl font-semibold tabular">{fmtNum(Number(v ?? 0))}</div></div>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pending lookups" pad={false}>{pending.length === 0 ? <Empty>No discovery requests in flight.</Empty> : <Raw rows={pending} />}</Card>
        <Card title="Retry state" pad={false}>{retries.length === 0 ? <Empty>No retries scheduled.</Empty> : <Raw rows={retries} />}</Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">{families.map((k) => <Card key={k} title={titleCase(k)} pad={false}><CounterTable data={d[k] as Record<string, unknown>} compact /></Card>)}</div>
    </div>
  );
}

function Raw({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return <div className="overflow-x-auto"><table className="data"><thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="mono text-xs">{fmtCell(r[c])}</td>)}</tr>)}</tbody></table></div>;
}
function fmtCell(v: unknown): string { if (v == null) return '–'; if (typeof v === 'string') return v.length > 20 && /^[0-9a-f]+$/.test(v) ? shortKey(v, 8, 6) : v; if (Array.isArray(v)) return v.map(fmtCell).join(', '); if (typeof v === 'object') return JSON.stringify(v); return String(v); }

function Bloom({ snap }: { snap: Snapshot }) {
  const r = usePoll(() => api.q<{ own_node_addr: string; is_leaf_only: boolean; sequence: number; leaf_dependent_count: number; leaf_dependents: string[]; peer_filters: { display_name?: string | null; estimated_count: number; fill_ratio: number; filter_sequence: number; has_filter: boolean; peer: string; set_bits: number }[]; uptree_fill_ratio: number | null; uptree_estimated_count: number | null; stats: Record<string, number> }>('show_bloom'), [], 4000);
  if (r.error) return <ErrorNote>{r.error}</ErrorNote>;
  if (!r.data) return <Empty>Loading…</Empty>;
  const d = r.data;
  const peers = snap.peers?.peers ?? [];
  const nameOf = (addr: string) => peers.find((p) => p.node_addr === addr)?.display_name || shortKey(addr, 8, 6);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card title="Per-peer filters" hint="Each peer advertises a Bloom filter of the addresses reachable through it. Fill ratio near 1 means the filter is saturating." pad={false}>
        {d.peer_filters.length === 0 ? <Empty>No filters received.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Peer</th><th>Filter</th><th className="num">Est. nodes</th><th className="num">Set bits</th><th>Fill</th><th className="num">Seq</th></tr></thead><tbody>
            {d.peer_filters.map((f) => <tr key={f.peer}><td className="font-medium">{f.display_name || nameOf(f.peer)}</td><td>{f.has_filter ? <Chip tone="good">present</Chip> : <Chip>none</Chip>}</td><td className="num">{fmtNum(f.estimated_count)}</td><td className="num">{fmtNum(f.set_bits)}</td><td><Meter value={f.fill_ratio} /></td><td className="num text-xs text-ink-3">{f.filter_sequence}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
      <div className="grid gap-4 content-start">
        <Card title="Our announcement">
          <KV items={[['Sequence', d.sequence], ['Leaf-only', d.is_leaf_only ? 'yes' : 'no'], ['Leaf dependents', d.leaf_dependent_count], ['Uptree fill', d.uptree_fill_ratio != null ? <Meter value={d.uptree_fill_ratio} /> : 'n/a (root)'], ['Uptree est. subtree', d.uptree_estimated_count != null ? fmtNum(d.uptree_estimated_count) : '–']]} />
          {d.leaf_dependents.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{d.leaf_dependents.map((a) => <span key={a} className="chip mono">{nameOf(a)}</span>)}</div>}
        </Card>
        <Card title="Filter protocol counters" pad={false}><CounterTable data={d.stats} compact /></Card>
      </div>
    </div>
  );
}

export function Meter({ value, warnAt = 0.8 }: { value: number; warnAt?: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const color = pct >= 0.95 ? 'var(--crit)' : pct >= warnAt ? 'var(--warn)' : 'var(--accent)';
  return <div className="flex items-center gap-2 min-w-[120px]"><div className="h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: 'var(--surface-3)' }}><div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: color }} /></div><span className="text-xs tabular w-12 text-right">{fmtPct(pct, 1)}</span></div>;
}

function Caches() {
  const now = useNow(1000);
  const c = usePoll(() => api.q<{ count: number; max_entries: number; fill_ratio: number; default_ttl_ms: number; expired: number; avg_age_ms: number; entries: Record<string, unknown>[] }>('show_cache'), [], 4000);
  const idc = usePoll(() => api.q<{ count: number; max_entries: number; entries: { node_addr: string; npub: string; display_name?: string | null; ipv6_addr: string; last_seen_ms: number; age_ms: number }[] }>('show_identity_cache'), [], 6000);
  return (
    <div className="grid gap-4">
      <Card title="Coordinate cache" hint="Learned coordinates for remote destinations. Entries expire after the TTL." pad={false}>
        {c.error ? <div className="p-4"><ErrorNote>{c.error}</ErrorNote></div> : !c.data ? <Empty>Loading…</Empty> : (
          <>
            <div className="px-4 pt-3 pb-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2"><span><b className="text-ink">{fmtNum(c.data.count)}</b> / {fmtNum(c.data.max_entries)} entries</span><span>TTL {fmtDuration(c.data.default_ttl_ms / 1000)}</span><span>avg age {fmtDuration(c.data.avg_age_ms / 1000)}</span><span>{fmtNum(c.data.expired)} expired</span><span className="min-w-[160px]"><Meter value={c.data.fill_ratio} /></span></div>
            {c.data.entries.length === 0 ? <Empty>Cache is empty. Entries appear after a destination is looked up.</Empty> : <Raw rows={c.data.entries} />}
          </>
        )}
      </Card>
      <Card title="Identity cache" hint="Known node public keys and their derived addresses" pad={false}>
        {idc.error ? <div className="p-4"><ErrorNote>{idc.error}</ErrorNote></div> : !idc.data ? <Empty>Loading…</Empty> : idc.data.entries.length === 0 ? <Empty>No identities cached.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Name</th><th>npub</th><th>Node addr</th><th>IPv6</th><th>Last seen</th></tr></thead><tbody>
            {idc.data.entries.map((e) => <tr key={e.node_addr}><td className="font-medium">{e.display_name || <span className="text-ink-3">–</span>}</td><td><Copyable text={e.npub} display={shortKey(e.npub, 12, 6)} /></td><td><Copyable text={e.node_addr} display={shortKey(e.node_addr, 8, 6)} /></td><td><Copyable text={e.ipv6_addr} /></td><td className="text-xs text-ink-3">{fmtAgo(e.last_seen_ms, now)}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
