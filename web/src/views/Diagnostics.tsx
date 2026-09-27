import { useEffect, useRef, useState } from 'react';
import { Play, Square, CheckCircle2, XCircle, CircleDashed, Loader2 } from 'lucide-react';
import type { ProbeReport, ProbeStage, HostEntry, Snapshot } from '../lib/types';
import { Card, Chip, Copyable, KV, Empty, ErrorNote, useToast } from '../components/ui';
import { api } from '../lib/api';
import { shortKey, fmtMs, fmtDuration } from '../lib/format';
import { NameText } from '../components/PeerName';

const STAGES: { key: keyof Pick<ProbeReport, 'bloom' | 'discovery' | 'path' | 'session' | 'rtt'>; label: string; desc: string }[] = [
  { key: 'bloom', label: 'Bloom', desc: 'Does any peer\'s filter claim the address?' },
  { key: 'discovery', label: 'Discovery', desc: 'Did a lookup answer with signed coordinates?' },
  { key: 'path', label: 'Path', desc: 'Can a next hop be computed from the tree?' },
  { key: 'session', label: 'Session', desc: 'Does a Noise XK session establish end to end?' },
  { key: 'rtt', label: 'RTT', desc: 'Do MMP reports come back with a round-trip time?' },
];

interface Run { id: number; peer: string; startedAt: number; state: 'running' | 'done' | 'error'; report?: ProbeReport; error?: string; budget_ms?: number; target?: { display_name?: string | null; npub: string } }

export function Diagnostics({ initialPeer, snap, readOnly }: { initialPeer?: string | null; snap: Snapshot; readOnly: boolean }) {
  const toast = useToast();
  const [peer, setPeer] = useState(initialPeer ?? '');
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setInterval>>());
  useEffect(() => { api.get<{ entries: HostEntry[] }>('/api/hosts').then((h) => setHosts(h.entries)).catch(() => {}); }, []);
  useEffect(() => { if (initialPeer) setPeer(initialPeer); }, [initialPeer]);
  useEffect(() => () => { for (const t of timers.current.values()) clearInterval(t); }, []);

  const start = async (target = peer) => {
    const id0 = target.trim();
    if (!id0) return;
    try {
      const r = await api.post<{ probe_id: number; npub: string; node_addr: string; display_name?: string | null; budget_ms: number }>('/api/probe/start', { peer: id0 });
      const run: Run = { id: r.probe_id, peer: r.display_name || id0, startedAt: Date.now(), state: 'running', budget_ms: r.budget_ms, target: { display_name: r.display_name, npub: r.npub } };
      setRuns((rs) => [run, ...rs].slice(0, 20));
      setSelected(r.probe_id);
      const t = setInterval(async () => {
        try {
          const p = await api.post<{ state: 'running' | 'done'; report: ProbeReport | null }>(`/api/probe/${r.probe_id}`);
          if (p.state === 'done') { clearInterval(t); timers.current.delete(r.probe_id); setRuns((rs) => rs.map((x) => (x.id === r.probe_id ? { ...x, state: 'done', report: p.report ?? undefined } : x))); }
        } catch (e) { clearInterval(t); timers.current.delete(r.probe_id); setRuns((rs) => rs.map((x) => (x.id === r.probe_id ? { ...x, state: 'error', error: (e as Error).message } : x))); }
      }, 600);
      timers.current.set(r.probe_id, t);
    } catch (e) { toast('err', (e as Error).message); }
  };
  const cancel = async (id: number) => { try { await api.post(`/api/probe/${id}/cancel`); } catch (e) { toast('err', (e as Error).message); } };

  const peers = snap.peers?.peers ?? [];
  const suggestions = [...hosts.map((h) => ({ name: h.hostname, npub: h.npub })), ...peers.filter((p) => p.display_name && !hosts.some((h) => h.npub === p.npub)).map((p) => ({ name: p.display_name!, npub: p.npub }))];
  const sel = runs.find((r) => r.id === selected) ?? runs[0];

  return (
    <div className="grid gap-4 fade-in">
      <Card title="Probe a mesh endpoint" hint="Runs the daemon's staged reachability diagnostic: bloom lookup, discovery, path computation, session handshake and RTT.">
        {readOnly ? <ErrorNote>This UI instance is read-only; probes are disabled.</ErrorNote> : (
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void start(); }}>
            <input className="input mono flex-1 min-w-[240px] max-w-xl" list="probe-targets" placeholder="npub1… or hostname (e.g. test-de01)" value={peer} onChange={(e) => setPeer(e.target.value)} />
            <datalist id="probe-targets">{suggestions.map((s) => <option key={s.npub} value={s.name}>{shortKey(s.npub, 12, 6)}</option>)}</datalist>
            <button className="btn primary" disabled={!peer.trim()}><Play size={15} />Probe</button>
          </form>
        )}
        {suggestions.length > 0 && !readOnly && <div className="flex flex-wrap gap-1.5 mt-3">{suggestions.slice(0, 12).map((s) => <button key={s.npub} className="chip hover:border-line-strong" onClick={() => { setPeer(s.name); void start(s.name); }}>{s.name}</button>)}</div>}
      </Card>

      {runs.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card title="Runs" pad={false}>
            {runs.map((r) => (
              <button key={r.id} className={`w-full text-left px-4 py-2.5 border-b border-line last:border-0 hover:bg-surface-2 ${sel?.id === r.id ? 'bg-accent-soft' : ''}`} onClick={() => setSelected(r.id)}>
                <div className="flex items-center justify-between gap-2"><span className="font-medium truncate">{r.peer}</span><Verdict state={r.state} verdict={r.report?.overall} /></div>
                <div className="text-[11px] text-ink-3">#{r.id} · {new Date(r.startedAt).toLocaleTimeString()}{r.report ? ` · ${fmtDuration(r.report.elapsed_ms / 1000)}` : ''}</div>
              </button>
            ))}
          </Card>
          {sel && <Report run={sel} onCancel={() => cancel(sel.id)} />}
        </div>
      )}
      {runs.length === 0 && <Empty>No probes yet. Pick a host above to test reachability across the mesh.</Empty>}
    </div>
  );
}

function Verdict({ state, verdict }: { state: Run['state']; verdict?: string }) {
  if (state === 'running') return <Chip tone="warn" dot={false}><Loader2 size={12} className="animate-spin" />running</Chip>;
  if (state === 'error') return <Chip tone="crit">error</Chip>;
  return <Chip tone={verdict === 'ok' ? 'good' : 'crit'}>{verdict ?? 'done'}</Chip>;
}

function Report({ run, onCancel }: { run: Run; onCancel: () => void }) {
  const r = run.report;
  return (
    <Card title={<span>Probe #{run.id} · {run.peer}</span>} actions={run.state === 'running' ? <button className="btn sm danger" onClick={onCancel}><Square size={13} />Cancel</button> : <Verdict state={run.state} verdict={r?.overall} />}>
      {run.state === 'error' && <ErrorNote>{run.error}</ErrorNote>}
      {run.state === 'running' && <div className="text-sm text-ink-2 mb-3">Running… budget {fmtDuration((run.budget_ms ?? 0) / 1000)}. Stages execute on the daemon's tick, so this takes a few seconds.</div>}

      {/* Stage pipeline */}
      <ol className="grid grid-cols-5 gap-2 mb-4">
        {STAGES.map((s, i) => {
          const st = r?.[s.key];
          const v = st?.verdict;
          const tone = !r ? 'pending' : v === 'ok' ? 'ok' : v === 'skipped' || v === 'skip' ? 'skip' : 'fail';
          return (
            <li key={s.key} className="relative rounded-xl px-3 py-2.5 border" style={{ borderColor: tone === 'ok' ? 'rgba(12,163,12,0.45)' : tone === 'fail' ? 'rgba(208,59,59,0.5)' : 'var(--border)', background: tone === 'ok' ? 'var(--good-soft)' : tone === 'fail' ? 'var(--crit-soft)' : 'var(--surface-2)' }}>
              <div className="flex items-center gap-1.5 text-xs font-semibold">{tone === 'ok' ? <CheckCircle2 size={14} className="text-good" /> : tone === 'fail' ? <XCircle size={14} className="text-crit" /> : run.state === 'running' ? <Loader2 size={14} className="animate-spin text-ink-3" /> : <CircleDashed size={14} className="text-ink-3" />}{i + 1}. {s.label}</div>
              <div className="text-[11px] text-ink-3 mt-0.5 leading-snug hidden md:block">{s.desc}</div>
              {st && <div className="text-[11px] mt-1 tabular text-ink-2">{fmtMs(st.elapsed_ms, 0)}{st.reason ? <span className="text-crit"> · {String(st.reason)}</span> : ''}</div>}
            </li>
          );
        })}
      </ol>

      {r && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="card-title mb-2">Target</div>
            <KV items={[['Name', <NameText npub={r.target.npub} name={r.target.display_name} fallback="–" />], ['npub', <Copyable text={r.target.npub} display={shortKey(r.target.npub, 14, 8)} />], ['Node addr', <Copyable text={r.target.node_addr} />], ['IPv6', <Copyable text={r.target.ipv6_addr} />], ['Total', fmtMs(r.elapsed_ms, 0)]]} />
          </div>
          <div>
            <div className="card-title mb-2">Path</div>
            <PathBlock p={r.path} />
          </div>
          <div>
            <div className="card-title mb-2">Session &amp; RTT</div>
            <KV items={[['Established', String(r.session.established ?? '–')], ['Pre-existing', String(r.session.preexisting ?? '–')], ['Path MTU', String(r.session.path_mtu ?? '–')], ['RTT', fmtMs(r.rtt.rtt_ms as number)], ['SRTT', fmtMs(r.rtt.srtt_ms as number)], ['Samples', `${r.rtt.samples ?? 0} (${r.rtt.reports_seen ?? 0} reports)`]]} />
          </div>
          <div>
            <div className="card-title mb-2">Lookup &amp; cleanup</div>
            <KV items={[['Bloom fanout', String(r.bloom.fanout ?? '–')], ['Discovery source', String(r.discovery.source ?? '–')], ['Attempts', `${r.discovery.attempts ?? 0} · ladder ${(r.discovery.attempt_timeouts_secs as number[] | undefined)?.join('/') ?? '–'} s`], ['Identity cached', String(r.cleanup.identity_was_cached)], ['Coords cached', String(r.cleanup.coords_were_cached)], ['Session torn down', String(r.cleanup.session_created_and_torn_down)], ...(r.cleanup.left_intact_reason ? [['Left intact', String(r.cleanup.left_intact_reason)] as [React.ReactNode, React.ReactNode]] : [])]} />
          </div>
          {STAGES.filter((s) => r[s.key].detail).map((s) => <div key={s.key} className="md:col-span-2"><ErrorNote><b>{s.label}:</b> {String(r[s.key].detail)}</ErrorNote></div>)}
        </div>
      )}
    </Card>
  );
}

function PathBlock({ p }: { p: ProbeStage }) {
  const ours = (p.our_coords as string[] | undefined) ?? [];
  const theirs = (p.their_coords as string[] | undefined) ?? [];
  const lca = p.lca as string | undefined;
  const nh = p.next_hop as { class: string; display_name?: string | null; node_addr: string; direct_peer: boolean } | null | undefined;
  return (
    <div className="grid gap-2">
      <KV items={[['Same root', String(p.same_root ?? '–')], ['Tree distance', `${p.tree_distance ?? '–'} (${p.tree_hops_up ?? 0} up, ${p.tree_hops_down ?? 0} down)`], ['LCA', lca ? <span className="mono">{shortKey(lca, 8, 6)} @ depth {String(p.lca_depth)}</span> : '–'], ['Next hop', nh ? `${nh.display_name || shortKey(nh.node_addr, 8, 4)} · ${nh.class.replace(/_/g, ' ')}${nh.direct_peer ? ' · direct' : ''}` : String(p.no_hop_reason ?? '–')]]} />
      {ours.length > 0 && theirs.length > 0 && (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div><div className="text-ink-3 mb-1">us → root</div><div className="flex flex-col gap-0.5">{ours.map((c) => <span key={c} className={`chip mono ${c === lca ? 'accent' : ''}`}>{shortKey(c, 6, 4)}</span>)}</div></div>
          <div><div className="text-ink-3 mb-1">them → root</div><div className="flex flex-col gap-0.5">{theirs.map((c) => <span key={c} className={`chip mono ${c === lca ? 'accent' : ''}`}>{shortKey(c, 6, 4)}</span>)}</div></div>
        </div>
      )}
    </div>
  );
}
