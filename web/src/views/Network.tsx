import type { Snapshot } from '../lib/types';
import { Card, Chip, StatusChip, Copyable, KV, Empty, ErrorNote, useNow } from '../components/ui';
import { CounterTable } from '../components/CounterTable';
import { fmtBytes, fmtAgo, shortKey, fmtDuration, fmtMs, fmtPct, fmtBits } from '../lib/format';
import { api, usePoll } from '../lib/api';

export function Network({ snap, onSelectPeer }: { snap: Snapshot; onSelectPeer: (npub: string) => void }) {
  const now = useNow(1000);
  const transports = snap.transports?.transports ?? [];
  const links = snap.links?.links ?? [];
  const peers = snap.peers?.peers ?? [];
  const sessions = snap.sessions?.sessions ?? [];
  const flows = usePoll(() => api.q<{ flows: Record<string, unknown>[]; listeners: { local_port: number; backlog: number }[]; stats: Record<string, number> }>('show_native_flows'), [], 5000);
  const peerByLink = new Map(peers.map((p) => [p.link_id, p]));

  return (
    <div className="grid gap-4 fade-in">
      {Object.entries(snap.errors ?? {}).filter(([k]) => ['transports', 'links', 'sessions'].includes(k)).map(([k, v]) => <ErrorNote key={k}>{k}: {v}</ErrorNote>)}

      <div className="grid gap-4 lg:grid-cols-2">
        {transports.map((t) => {
          const tl = links.filter((l) => l.transport_id === t.transport_id);
          return (
            <Card key={t.transport_id} title={<span className="flex items-center gap-2"><span>{t.type} transport</span><span className="text-ink-3 font-normal normal-case tracking-normal">#{t.transport_id}</span></span>} actions={<StatusChip value={t.state} />}>
              <KV items={[
                ['Local', <span className="mono">{t.local_addr ?? t.name ?? '–'}</span>],
                ...(t.onion_address ? [['Onion', <Copyable text={t.onion_address} />] as [React.ReactNode, React.ReactNode]] : []),
                ...(t.tor_mode ? [['Tor mode', t.tor_mode] as [React.ReactNode, React.ReactNode]] : []),
                ['MTU', t.mtu],
                ['Peers', snap.status?.transport_peer_counts?.[t.type] ?? 0],
                ['Traffic', `${fmtBytes(t.stats?.bytes_recv)} in · ${fmtBytes(t.stats?.bytes_sent)} out`],
              ]} />
              {t.interface && (
                <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2">
                  <div className="flex items-center justify-between gap-2 mb-1"><span className="text-xs font-medium">Interface {t.interface.name}</span><Chip tone={t.interface.presence === 'present' ? 'good' : t.interface.presence === 'binding' ? 'warn' : t.interface.policy === 'required' ? 'crit' : 'serious'}>{t.interface.presence}</Chip></div>
                  <div className="text-[11px] text-ink-3">carrier {t.interface.carrier ? 'yes' : 'no'} · {t.interface.policy} · {fmtDuration(t.interface.since_secs)} in this state · {t.interface.binds} bind{t.interface.binds === 1 ? '' : 's'}{t.interface.failed_attempts ? ` · ${t.interface.failed_attempts} failed` : ''}</div>
                </div>
              )}
              <div className="mt-3">
                <div className="card-title mb-1.5">Links ({tl.length})</div>
                {tl.length === 0 ? <div className="text-xs text-ink-3">No active links.</div> : (
                  <div className="overflow-x-auto -mx-1"><table className="data"><thead><tr><th>Link</th><th>Peer</th><th>Remote</th><th>Dir</th><th>State</th><th className="num">In / Out</th><th>Last recv</th></tr></thead><tbody>
                    {tl.map((l) => { const p = peerByLink.get(l.link_id); return <tr key={l.link_id} className={p ? 'row' : ''} onClick={() => p && onSelectPeer(p.npub)}><td className="tabular">{l.link_id}</td><td>{p ? (p.display_name || shortKey(p.npub, 8, 4)) : <span className="text-ink-3">unauthenticated</span>}</td><td className="mono text-xs">{l.remote_addr}</td><td className="text-xs">{l.direction}</td><td><StatusChip value={l.state} /></td><td className="num text-xs">{fmtBytes(l.stats.bytes_recv)} / {fmtBytes(l.stats.bytes_sent)}</td><td className="text-xs text-ink-3">{fmtAgo(l.stats.last_recv_ms, now)}</td></tr>; })}
                  </tbody></table></div>
                )}
              </div>
              <details className="mt-3 group"><summary className="text-xs text-ink-3 cursor-pointer select-none hover:text-ink">Transport counters</summary><div className="mt-1 -mx-4"><CounterTable data={t.stats} compact /></div></details>
            </Card>
          );
        })}
        {transports.length === 0 && <Card><Empty>No transports reported.</Empty></Card>}
      </div>

      <Card title={`End-to-end sessions (${sessions.length})`} hint="Noise XK sessions to remote mesh endpoints, independent of the hop-by-hop peer links" pad={false}>
        {sessions.length === 0 ? <Empty>No active sessions. Sessions appear when traffic flows to a remote node.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Remote</th><th>State</th><th>Role</th><th className="num">RTT</th><th className="num">Loss</th><th className="num">Goodput</th><th>Last activity</th></tr></thead><tbody>
            {sessions.map((s, i) => <tr key={s.remote_addr + i}><td><div className="font-medium">{s.display_name || shortKey(s.npub ?? s.remote_addr, 10, 6)}</div><div className="text-[11px] text-ink-3 mono">{shortKey(s.remote_addr, 10, 6)}</div></td><td><StatusChip value={s.state} />{s.is_draining && <Chip tone="warn" className="ml-1">draining</Chip>}</td><td className="text-xs">{s.is_initiator ? 'initiator' : 'responder'}</td><td className="num">{fmtMs(s.mmp?.srtt_ms)}</td><td className="num">{fmtPct(s.mmp?.loss_rate)}</td><td className="num">{fmtBits(s.mmp?.goodput_bps)}</td><td className="text-xs text-ink-3">{fmtAgo(s.last_activity_ms, now)}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Native datagram flows" hint="Applications using the FIPS native API (npub:port addressing) instead of the IPv6 TUN" pad={false}>
          {flows.error ? <div className="p-4"><ErrorNote>{flows.error}</ErrorNote></div> : !flows.data ? <Empty>Loading…</Empty> : (
            <>
              {flows.data.listeners.length > 0 && <div className="px-4 pt-3 flex flex-wrap gap-1.5">{flows.data.listeners.map((l) => <Chip key={l.local_port} tone="accent">listening :{l.local_port} · backlog {l.backlog}</Chip>)}</div>}
              {flows.data.flows.length === 0 ? <Empty>No native flows.</Empty> : (
                <div className="overflow-x-auto"><table className="data"><thead><tr><th>Flow</th><th>Peer</th><th>Ports</th><th>State</th><th className="num">Queued</th><th>Age</th></tr></thead><tbody>
                  {flows.data.flows.map((f) => <tr key={String(f.flow_id)}><td className="tabular">{String(f.flow_id)}</td><td className="mono text-xs">{shortKey(String(f.peer), 10, 6)}</td><td className="tabular text-xs">{String(f.local_port)} → {String(f.remote_port)}</td><td><StatusChip value={String(f.state)} /></td><td className="num">{String(f.queued)}</td><td className="text-xs text-ink-3">{fmtDuration(Number(f.age_ms) / 1000)}</td></tr>)}
                </tbody></table></div>
              )}
            </>
          )}
        </Card>
        <Card title="Native API counters" pad={false}>{flows.data ? <CounterTable data={flows.data.stats} compact /> : <Empty>Loading…</Empty>}</Card>
      </div>
    </div>
  );
}
