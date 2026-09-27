import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Unplug, Stethoscope, ArrowDownLeft, ArrowUpRight, X, RefreshCw } from 'lucide-react';
import type { Snapshot, Peer, Health, Series, HostEntry } from '../lib/types';
import { Card, Chip, StatusChip, Copyable, KV, Empty, ErrorNote, Modal, ConfirmDialog, useToast, useNow, Skeleton } from '../components/ui';
import { PeerName } from '../components/PeerName';
import { TimeSeries } from '../components/TimeSeries';
import { fmtBytes, fmtBits, fmtMs, fmtPct, fmtAgo, shortKey, fmtDuration } from '../lib/format';
import { api, usePoll } from '../lib/api';
import { HostNameLink } from '../components/PeerName';

export function Peers({ snap, health, onProbe, selected, onSelect }: { snap: Snapshot; health: Health | null; onProbe: (npub: string) => void; selected: string | null; onSelect: (npub: string | null) => void }) {
  const peers = snap.peers?.peers ?? [];
  const [q, setQ] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const now = useNow(1000);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t ? peers.filter((p) => [p.display_name, p.npub, p.node_addr, p.transport_addr, p.transport_type, p.ipv6_addr].some((v) => v?.toLowerCase().includes(t))) : peers;
    return [...list].sort((a, b) => Number(b.is_parent) - Number(a.is_parent) || Number(b.is_child) - Number(a.is_child) || (a.display_name ?? a.npub).localeCompare(b.display_name ?? b.npub));
  }, [peers, q]);
  const sel = peers.find((p) => p.npub === selected) ?? null;
  const pending = snap.connections?.connections ?? [];

  return (
    <div className="grid gap-4 fade-in">
      {snap.errors?.peers && <ErrorNote>{snap.errors.peers}</ErrorNote>}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" /><input className="input pl-9" placeholder="Filter peers…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="text-xs text-ink-3">{peers.length} authenticated{pending.length ? ` · ${pending.length} handshaking` : ''}</div>
        <div className="ml-auto flex gap-2">{!health?.readOnly && <button className="btn primary" onClick={() => setConnectOpen(true)}><Plus size={15} />Connect peer</button>}</div>
      </div>

      <div className={`grid gap-4 ${sel ? 'xl:grid-cols-[minmax(0,1fr)_420px]' : ''}`}>
        <Card pad={false} className="overflow-hidden">
          {filtered.length === 0 ? <Empty>{peers.length ? 'No peers match the filter.' : 'No authenticated peers. Connect one to join the mesh.'}</Empty> : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead><tr><th>Peer</th><th>Role</th><th>State</th><th>Transport</th><th className="num">Depth</th><th className="num">RTT</th><th className="num">Loss</th><th className="num">ETX</th><th className="num">Goodput</th><th className="num">In / Out</th><th>Seen</th></tr></thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.npub} className={`row ${p.npub === selected ? 'selected' : ''}`} onClick={() => onSelect(p.npub === selected ? null : p.npub)}>
                      <td><PeerName name={p.display_name} npub={p.npub} /></td>
                      <td><Role p={p} /></td>
                      <td><StatusChip value={p.connectivity} /></td>
                      <td><div className="flex items-center gap-1.5 text-xs">{p.direction === 'inbound' ? <ArrowDownLeft size={13} className="text-ink-3" /> : <ArrowUpRight size={13} className="text-ink-3" />}<span className="uppercase font-medium">{p.transport_type}</span><span className="mono text-ink-3">{p.transport_addr}</span></div></td>
                      <td className="num">{p.tree_depth ?? '–'}</td>
                      <td className="num">{fmtMs(p.mmp?.srtt_ms)}</td>
                      <td className={`num ${(p.mmp?.loss_rate ?? 0) > 0.02 ? 'text-crit' : ''}`}>{fmtPct(p.mmp?.loss_rate)}</td>
                      <td className="num">{p.mmp?.etx?.toFixed(2) ?? '–'}</td>
                      <td className="num">{fmtBits(p.mmp?.goodput_bps)}</td>
                      <td className="num text-xs"><span>{fmtBytes(p.stats?.bytes_recv)}</span><span className="text-ink-3"> / </span><span>{fmtBytes(p.stats?.bytes_sent)}</span></td>
                      <td className="text-xs text-ink-3">{fmtAgo(p.last_seen_ms, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pending.length > 0 && (
            <div className="border-t border-line px-4 py-3">
              <div className="card-title mb-2">Pending handshakes</div>
              <div className="flex flex-wrap gap-2">{pending.map((c) => <Chip key={c.link_id} tone="warn">link {c.link_id} · {c.direction} · {c.handshake_state.replace(/_/g, ' ')} · {fmtDuration(c.idle_ms / 1000)} idle{c.expected_peer ? ` · ${shortKey(c.expected_peer, 8, 4)}` : ''}</Chip>)}</div>
            </div>
          )}
        </Card>
        {sel && <PeerDetail peer={sel} snap={snap} health={health} onClose={() => onSelect(null)} onProbe={onProbe} />}
      </div>

      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} snap={snap} />
    </div>
  );
}

function Role({ p }: { p: Peer }) {
  if (p.is_parent) return <Chip tone="accent">parent</Chip>;
  if (p.is_child) return <Chip tone="good">child</Chip>;
  if (p.has_tree_position === false) return <Chip>no tree pos</Chip>;
  return <Chip>crosslink</Chip>;
}

function PeerDetail({ peer: p, snap, health, onClose, onProbe }: { peer: Peer; snap: Snapshot; health: Health | null; onClose: () => void; onProbe: (npub: string) => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const tp = snap.tree?.peers.find((t) => t.node_addr === p.node_addr);
  const link = snap.links?.links.find((l) => l.link_id === p.link_id);
  const hist = usePoll(async () => {
    const [srtt, loss, bin, bout] = await Promise.all(['srtt_ms', 'loss_rate', 'bytes_in', 'bytes_out'].map((m) => api.q<Series>('show_stats_history', { metric: m, peer: p.npub, window: '10m' })));
    return { srtt, loss, bin, bout };
  }, [p.npub], 5000);

  const disconnect = async () => {
    setBusy(true);
    try { await api.post('/api/disconnect', { peer: p.npub }); toast('ok', `Disconnected ${p.display_name ?? shortKey(p.npub)}`); setConfirm(false); onClose(); }
    catch (e) { toast('err', (e as Error).message); } finally { setBusy(false); }
  };

  const m = p.mmp;
  return (
    <Card className="xl:sticky xl:top-[72px] xl:max-h-[calc(100dvh-90px)] overflow-y-auto fade-in" pad={false}>
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="flex items-start justify-between gap-2">
          <PeerName name={p.display_name} npub={p.npub} size="lg" />
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2"><Role p={p} /><StatusChip value={p.connectivity} /><Chip>{p.direction}</Chip><Chip>{p.transport_type}</Chip>{p.rekey_in_progress && <Chip tone="warn">rekeying</Chip>}{p.nostr_traversal?.in_cooldown && <Chip tone="serious">nostr cooldown</Chip>}</div>
        <div className="flex gap-2 mt-3">
          <button className="btn sm" onClick={() => onProbe(p.npub)}><Stethoscope size={14} />Probe</button>
          {!health?.readOnly && <button className="btn sm danger" onClick={() => setConfirm(true)}><Unplug size={14} />Disconnect</button>}
        </div>
      </div>

      <Section title="Link quality">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="RTT" v={fmtMs(m?.srtt_ms)} trend={m?.rtt_trend} />
          <Stat label="Loss" v={fmtPct(m?.loss_rate)} trend={m?.loss_trend} />
          <Stat label="ETX" v={m?.etx?.toFixed(2) ?? '–'} />
          <Stat label="Goodput" v={fmtBits(m?.goodput_bps)} trend={m?.goodput_trend} />
          <Stat label="LQI" v={m?.lqi?.toFixed(2) ?? '–'} />
          <Stat label="Mode" v={m?.mode ?? '–'} />
        </div>
        <div className="mt-3 grid gap-3">
          {hist.data ? (<>
            <ChartBlock title="RTT" s={hist.data.srtt} />
            <ChartBlock title="Loss" s={hist.data.loss} />
            <ChartBlock title="Throughput" multi={[{ label: 'in', values: hist.data.bin.values, color: 'var(--s1)' }, { label: 'out', values: hist.data.bout.values, color: 'var(--s2)' }]} unit={hist.data.bin.unit} step={hist.data.bin.granularity_seconds} />
          </>) : hist.error ? <ErrorNote>{hist.error}</ErrorNote> : <Skeleton className="h-24 w-full" />}
        </div>
      </Section>

      <Section title="Identity">
        <KV items={[['Name', <HostNameLink npub={p.npub} readOnly={!!health?.readOnly} />], ['npub', <Copyable text={p.npub} display={shortKey(p.npub, 16, 8)} />], ['node addr', <Copyable text={p.node_addr} />], ['IPv6', <Copyable text={p.ipv6_addr} />], ['DNS', <Copyable text={`${p.display_name ?? p.npub}.fips`} />]]} />
      </Section>

      <Section title="Link">
        <KV items={[['Endpoint', <span className="mono">{p.transport_addr}</span>], ['Link id', p.link_id ?? '–'], ['Direction', p.direction], ['Authenticated', fmtAgo(p.authenticated_at_ms, now)], ['Last seen', fmtAgo(p.last_seen_ms, now)], ['Received', `${fmtBytes(p.stats?.bytes_recv)} · ${p.stats?.packets_recv ?? 0} pkts`], ['Sent', `${fmtBytes(p.stats?.bytes_sent)} · ${p.stats?.packets_sent ?? 0} pkts`], ['Link state', link?.state ?? '–'], ['Delivery fwd / rev', m ? `${fmtPct(m.delivery_ratio_forward, 0)} / ${fmtPct(m.delivery_ratio_reverse, 0)}` : '–']]} />
      </Section>

      <Section title="Tree">
        <KV items={[['Depth', p.tree_depth ?? '–'], ['Effective depth', p.effective_depth?.toFixed(3) ?? '–'], ['Distance', tp?.distance_to_us ?? '–'], ['Root', tp ? <Copyable text={tp.root} display={shortKey(tp.root, 8, 6)} /> : '–'], ['Bloom filter', p.has_bloom_filter ? `yes · seq ${p.filter_sequence}` : 'no']]} />
        {tp && <div className="mt-2 flex flex-wrap gap-1">{tp.coords.map((c, i) => <span key={c} className="chip mono" title={c}>{i === 0 ? '' : '↑ '}{shortKey(c, 6, 4)}</span>)}</div>}
      </Section>

      <Section title="Crypto">
        <KV items={[['Session index', p.our_session_index ?? '–'], ['Noise send / recv ctr', p.noise ? `${p.noise.send_counter} / ${p.noise.highest_recv_counter}` : '–'], ['Decrypt failures', p.consecutive_decrypt_failures ?? 0], ['Replay suppressed', p.replay_suppressed ?? 0], ['K-bit', p.current_k_bit ? '1' : '0']]} />
      </Section>

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={disconnect} busy={busy} danger title="Disconnect peer?" confirmLabel="Disconnect" body={<>The link to <b>{p.display_name ?? shortKey(p.npub)}</b> will be dropped. If the peer is configured in fips.yaml with auto-reconnect, the daemon will dial it again.</>} />
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <div className="px-4 py-3 border-b border-line last:border-0"><div className="card-title mb-2">{title}</div>{children}</div>; }
function Stat({ label, v, trend }: { label: string; v: React.ReactNode; trend?: string }) {
  const arrow = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : trend === 'stable' ? '→' : '';
  return <div className="rounded-lg bg-surface-2 px-2.5 py-1.5"><div className="text-[11px] text-ink-3">{label}</div><div className="text-sm font-semibold tabular">{v} <span className="text-ink-3 font-normal text-xs" title={trend}>{arrow}</span></div></div>;
}
function ChartBlock({ title, s, multi, unit, step }: { title: string; s?: Series; multi?: { label: string; values: (number | null)[]; color: string }[]; unit?: string; step?: number }) {
  const u = unit ?? s?.unit ?? '';
  const st = step ?? s?.granularity_seconds ?? 1;
  const series = multi ?? (s ? [{ label: title, values: s.values }] : []);
  return <div><div className="text-xs text-ink-3 mb-1">{title} · last 10 min</div><TimeSeries series={series} stepSecs={st} unit={u} height={110} /></div>;
}

// ------------------------------------------------------------- connect dialog
function ConnectDialog({ open, onClose, snap }: { open: boolean; onClose: () => void; snap: Snapshot }) {
  const toast = useToast();
  const [peer, setPeer] = useState('');
  const [address, setAddress] = useState('');
  const [transport, setTransport] = useState('udp');
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const transports = useMemo(() => Array.from(new Set((snap.transports?.transports ?? []).map((t) => t.type))), [snap.transports]);
  useEffect(() => { if (open) api.get<{ entries: HostEntry[] }>('/api/hosts').then((h) => setHosts(h.entries)).catch(() => {}); }, [open]);
  useEffect(() => { if (transports.length && !transports.includes(transport)) setTransport(transports[0]); }, [transports, transport]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ npub: string; result: { refreshed?: boolean } | string }>('/api/connect', { peer: peer.trim(), address: address.trim(), transport });
      toast('ok', typeof r.result === 'object' && r.result?.refreshed ? 'Alternate path handshake started' : `Dialing ${peer.trim()} over ${transport}`);
      onClose(); setPeer(''); setAddress('');
    } catch (err) { toast('err', (err as Error).message); } finally { setBusy(false); }
  };
  const placeholder = transport === 'tcp' ? 'host:8443' : transport === 'tor' ? 'xyz…onion:2121' : transport === 'ethernet' ? 'aa:bb:cc:dd:ee:ff' : 'host:2121';
  return (
    <Modal open={open} onClose={onClose} title="Connect to a peer">
      <form onSubmit={submit} className="grid gap-4">
        <label className="field">Peer (npub or hostname)
          <input className="input mono" list="fips-hosts" required value={peer} onChange={(e) => setPeer(e.target.value)} placeholder="npub1… or test-de01" autoFocus />
          <datalist id="fips-hosts">{hosts.map((h) => <option key={h.hostname} value={h.hostname}>{shortKey(h.npub, 12, 6)}</option>)}</datalist>
        </label>
        <div className="grid grid-cols-[1fr_130px] gap-3">
          <label className="field">Address<input className="input mono" required value={address} onChange={(e) => setAddress(e.target.value)} placeholder={placeholder} /></label>
          <label className="field">Transport<select className="input" value={transport} onChange={(e) => setTransport(e.target.value)}>{(transports.length ? transports : ['udp', 'tcp']).map((t) => <option key={t} value={t}>{t}</option>)}{['udp', 'tcp', 'tor', 'nym', 'ethernet'].filter((t) => !transports.includes(t)).map((t) => <option key={t} value={t} disabled>{t} (not configured)</option>)}</select></label>
        </div>
        <p className="text-xs text-ink-3">Ephemeral: the peer is not written to fips.yaml and gets no auto-reconnect. Names are resolved from /etc/fips/hosts and known peers.</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? <><RefreshCw size={14} className="animate-spin" />Dialing…</> : 'Connect'}</button></div>
      </form>
    </Modal>
  );
}
