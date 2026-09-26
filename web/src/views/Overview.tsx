import { Globe, Users, GitBranch, ArrowDownToLine, ArrowUpFromLine, Percent, Link2, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { Snapshot, Health, UnitState } from '../lib/types';
import { StatTile } from '../components/StatTile';
import { Card, Chip, StatusChip, Copyable, KV, ErrorNote, Empty, useToast, useNow, ConfirmDialog } from '../components/ui';
import { fmtBytes, fmtDuration, fmtPct, fmtNum, fmtMs, shortKey, fmtAgo, fmtCompact } from '../lib/format';
import { api } from '../lib/api';
import { useState } from 'react';
import type { ViewId } from '../components/Shell';

export function Overview({ snap, health, onNav }: { snap: Snapshot; health: Health | null; onNav: (v: ViewId) => void }) {
  const s = snap.status;
  const peers = snap.peers?.peers ?? [];
  const parent = peers.find((p) => p.is_parent);
  const children = peers.filter((p) => p.is_child);
  const now = useNow(1000);
  const errs = Object.entries(snap.errors ?? {});

  if (!s) return <div className="grid gap-4">{errs.map(([k, v]) => <ErrorNote key={k}><b>{k}</b>: {v}</ErrorNote>)}<Empty>Waiting for the daemon…</Empty></div>;

  const sp = s.sparklines ?? {};
  const bytesIn = last(sp.bytes_in), bytesOut = last(sp.bytes_out), loss = last(sp.loss_rate);
  const fw = s.forwarding ?? {};
  const drops = (fw.drop_no_route_packets ?? 0) + (fw.drop_mtu_exceeded_packets ?? 0) + (fw.drop_send_error_packets ?? 0) + (fw.ttl_exhausted_packets ?? 0);

  return (
    <div className="grid gap-4 fade-in">
      {errs.length > 0 && <div className="grid gap-2">{errs.map(([k, v]) => <ErrorNote key={k}><b>{k}</b>: {v}</ErrorNote>)}</div>}

      {/* Identity strip */}
      <Card className="overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-8">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative shrink-0"><img src="/favicon.svg" width={52} height={52} className="rounded-xl" alt="" /><span className={`absolute -right-1 -bottom-1 w-4 h-4 rounded-full border-2 border-surface ${s.state === 'running' ? 'bg-good' : 'bg-crit'}`} /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-semibold tracking-tight">{s.is_root ? 'Tree root' : s.is_leaf_only ? 'Leaf node' : 'Mesh node'}</span>
                <StatusChip value={s.state} />
                {s.is_root && <Chip tone="accent">root</Chip>}
                {s.is_leaf_only && <Chip tone="warn">leaf-only</Chip>}
                <Chip tone={s.persistent ? 'good' : 'warn'} title={s.persistent ? 'Identity is persisted on disk' : 'Ephemeral identity: a restart changes this node\'s address'}>{s.persistent ? 'persistent identity' : 'ephemeral identity'}</Chip>
              </div>
              <div className="text-xs text-ink-3 mt-1">{s.version} · up {fmtDuration(s.uptime_secs)} · pid {s.pid}</div>
            </div>
          </div>
          <dl className="kv lg:flex-1 lg:grid-cols-[auto_1fr] gap-x-4">
            <dt>npub</dt><dd><Copyable text={s.npub} display={s.npub} /></dd>
            <dt>IPv6</dt><dd><Copyable text={s.ipv6_addr} /></dd>
            <dt>node addr</dt><dd><Copyable text={s.node_addr} /></dd>
          </dl>
        </div>
      </Card>

      {/* Tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3">
        <StatTile label="Mesh size (est.)" value={fmtNum(s.estimated_mesh_size)} sub="nodes reachable" trend={sp.mesh_size} icon={<Globe size={15} />} hero onClick={() => onNav('metrics')} />
        <StatTile label="Peers" value={s.peer_count} sub={`${s.link_count} link${s.link_count === 1 ? '' : 's'} · ${s.connection_count} pending`} trend={sp.peer_count} icon={<Users size={15} />} onClick={() => onNav('peers')} />
        <StatTile label="Tree depth" value={s.is_root ? 'root' : (snap.tree?.depth ?? '–')} sub={parent ? `via ${parent.display_name ?? shortKey(parent.npub, 8, 4)}` : s.is_root ? 'this node is the root' : 'no parent'} trend={sp.tree_depth} icon={<GitBranch size={15} />} onClick={() => onNav('topology')} />
        <StatTile label="Inbound" value={fmtBytes(bytesIn, true)} sub={`${fmtBytes(fw.received_bytes)} total`} trend={sp.bytes_in} icon={<ArrowDownToLine size={15} />} onClick={() => onNav('metrics')} />
        <StatTile label="Outbound" value={fmtBytes(bytesOut, true)} sub={`${fmtBytes(fw.originated_bytes + (fw.forwarded_bytes ?? 0))} total`} trend={sp.bytes_out} icon={<ArrowUpFromLine size={15} />} onClick={() => onNav('metrics')} />
        <StatTile label="Loss rate" value={fmtPct(loss, 2)} sub={`${s.session_count} session${s.session_count === 1 ? '' : 's'}`} trend={sp.loss_rate} icon={<Percent size={15} />} tone={loss != null && loss > 0.05 ? 'var(--crit)' : undefined} onClick={() => onNav('metrics')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Uplink / parent */}
        <Card title="Uplink" actions={<button className="btn ghost sm" onClick={() => onNav('topology')}>Topology</button>}>
          {s.is_root ? <Empty>This node is the spanning-tree root.</Empty> : parent ? (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0"><div className="font-medium truncate">{parent.display_name ?? shortKey(parent.npub, 12, 6)}</div><div className="text-xs text-ink-3 mono truncate">{parent.transport_type} · {parent.transport_addr}</div></div>
                <StatusChip value={parent.connectivity} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Mini label="RTT" value={fmtMs(parent.mmp?.srtt_ms)} />
                <Mini label="Loss" value={fmtPct(parent.mmp?.loss_rate)} />
                <Mini label="ETX" value={parent.mmp?.etx?.toFixed(2) ?? '–'} />
              </div>
              <KV items={[['Root', <Copyable text={snap.tree?.root ?? s.root} display={shortKey(snap.tree?.root ?? s.root, 10, 6)} />], ['Depth', `${snap.tree?.depth ?? '–'} hops`], ['Children', children.length]]} />
            </div>
          ) : <Empty>No parent yet: the node has not joined a tree.</Empty>}
        </Card>

        {/* Services */}
        <Card title="Services" actions={<button className="btn ghost sm" onClick={() => onNav('logs')}>Logs</button>}>
          <Services units={snap.units ?? []} health={health} now={now} />
        </Card>

        {/* Traffic / forwarding */}
        <Card title="Forwarding" actions={<button className="btn ghost sm" onClick={() => onNav('internals')}>Internals</button>}>
          <div className="grid grid-cols-2 gap-2">
            <Mini label="Delivered" value={fmtCompact(fw.delivered_packets)} sub={fmtBytes(fw.delivered_bytes)} />
            <Mini label="Originated" value={fmtCompact(fw.originated_packets)} sub={fmtBytes(fw.originated_bytes)} />
            <Mini label="Forwarded" value={fmtCompact(fw.forwarded_packets)} sub={fmtBytes(fw.forwarded_bytes)} />
            <Mini label="Dropped" value={fmtCompact(drops)} sub={drops ? 'no route / mtu / ttl / send' : 'none'} tone={drops ? 'crit' : undefined} />
          </div>
          <div className="mt-3 text-xs text-ink-3 flex flex-wrap gap-x-3 gap-y-1">
            <span>tree up {fmtCompact(fw.route_tree_up)}</span><span>tree down {fmtCompact(fw.route_tree_down)}</span><span>direct {fmtCompact(fw.route_direct_peer)}</span><span>crosslink {fmtCompact((fw.route_crosslink_ascend ?? 0) + (fw.route_crosslink_descend ?? 0))}</span>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Transports */}
        <Card title="Transports" actions={<button className="btn ghost sm" onClick={() => onNav('network')}>Details</button>}>
          {snap.transports?.transports?.length ? (
            <div className="grid gap-2">
              {snap.transports.transports.map((t) => (
                <div key={t.transport_id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 bg-surface-2">
                  <div className="min-w-0 flex items-center gap-2"><Link2 size={14} className="text-ink-3 shrink-0" /><span className="font-medium uppercase text-xs tracking-wide">{t.type}</span><span className="mono text-xs text-ink-2 truncate">{t.onion_address ?? t.local_addr ?? t.name ?? ''}</span>{t.interface && <Chip tone={t.interface.presence === 'present' ? 'good' : 'warn'}>{t.interface.name}: {t.interface.presence}</Chip>}</div>
                  <div className="flex items-center gap-2 shrink-0 text-xs text-ink-3"><span>{s.transport_peer_counts?.[t.type] ?? 0} peer{(s.transport_peer_counts?.[t.type] ?? 0) === 1 ? '' : 's'}</span><span>mtu {t.mtu}</span><StatusChip value={t.state} /></div>
                </div>
              ))}
            </div>
          ) : <Empty>No transports configured.</Empty>}
          <div className="mt-3 text-xs text-ink-3">TUN <b className="text-ink-2">{s.tun_name}</b> {s.tun_state} · effective IPv6 MTU {s.effective_ipv6_mtu}</div>
        </Card>

        {/* Listening */}
        <Card title="Exposed on fips0" hint="Local IPv6 listeners reachable over the mesh and how the fips firewall treats them" actions={<button className="btn ghost sm" onClick={() => onNav('access')}>Access</button>}>
          <Listening snap={snap} />
        </Card>
      </div>
    </div>
  );
}

function last(arr?: number[]): number | null { return arr && arr.length ? arr[arr.length - 1] : null; }

export function Mini({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'crit' | 'warn' | 'good' }) {
  return <div className="rounded-lg bg-surface-2 px-3 py-2 min-w-0"><div className="text-[11px] text-ink-3">{label}</div><div className={`text-base font-semibold tabular truncate ${tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : ''}`}>{value}</div>{sub && <div className="text-[11px] text-ink-3 truncate">{sub}</div>}</div>;
}

export function Listening({ snap }: { snap: Snapshot }) {
  const l = snap.listening;
  if (!l) return <Empty>Not available.</Empty>;
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-xs">{l.firewall_active ? <Chip tone="good"><ShieldCheck size={12} />firewall active</Chip> : <Chip tone="crit"><ShieldAlert size={12} />fips-firewall inactive: all listeners exposed</Chip>}<span className="text-ink-3 mono truncate">{l.fips0_addr}</span></div>
      {l.sockets.length === 0 ? <div className="text-sm text-ink-3 py-2">No IPv6 listeners reachable from the mesh.</div> : (
        <div className="overflow-x-auto -mx-1"><table className="data"><thead><tr><th>Proto</th><th>Port</th><th>Process</th><th>Bind</th><th>Filter</th></tr></thead><tbody>
          {l.sockets.map((k, i) => <tr key={i}><td className="uppercase text-xs">{k.proto}</td><td className="tabular">{k.port}</td><td>{k.process ? `${k.process}${k.pid ? ` (${k.pid})` : ''}` : '?'}</td><td className="text-ink-3 text-xs">{k.wildcard_bind ? 'all interfaces' : 'fips0 only'}</td><td><Chip tone={k.filter === 'accept' ? 'good' : k.filter === 'drop' ? 'neutral' : k.filter === 'no_firewall' ? 'crit' : 'warn'}>{k.filter === 'accept' ? 'open' : k.filter === 'drop' ? 'filtered' : k.filter === 'no_firewall' ? 'exposed' : k.filter}</Chip>{k.filter === 'drop' && <a className="ml-2 text-xs text-ink-3 hover:text-ink" href={`#/firewall?proto=${k.proto}&port=${k.port}${k.process ? `&note=${encodeURIComponent(k.process)}` : ''}`}>allow…</a>}</td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}

export function Services({ units, health, now }: { units: UnitState[]; health: Health | null; now: number }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ id: string; unit: string; action: 'restart' | 'start' | 'stop' } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try { await api.post(`/api/service/${confirm.id}/${confirm.action}`); toast('ok', `${confirm.action} ${confirm.id} succeeded`); setConfirm(null); }
    catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); }
  };
  if (!units.length) return <Empty>systemd unit state unavailable.</Empty>;
  return (
    <div className="grid gap-1.5">
      {units.map((u) => {
        const tone = u.active === 'active' ? (u.sub === 'running' || u.sub === 'exited' ? 'good' : 'warn') : u.active === 'failed' ? 'crit' : u.unitFileState === 'disabled' || u.unitFileState === 'static' ? 'neutral' : 'serious';
        return (
          <div key={u.unit} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 bg-surface-2">
            <div className="min-w-0"><div className="text-sm font-medium truncate">{u.id}</div><div className="text-[11px] text-ink-3 truncate">{u.active === 'active' && u.since ? `since ${fmtAgo(u.since, now)}` : u.description}{u.memoryBytes ? ` · ${fmtBytes(u.memoryBytes)}` : ''}{u.restarts ? ` · ${u.restarts} restart${u.restarts === 1 ? '' : 's'}` : ''}</div></div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Chip tone={tone}>{u.active}{u.sub && u.sub !== u.active ? ` · ${u.sub}` : ''}</Chip>
              {health?.serviceControl && <button className="btn ghost icon sm" title={u.active === 'active' ? `Restart ${u.unit}` : `Start ${u.unit}`} onClick={() => setConfirm({ id: u.id, unit: u.unit, action: u.active === 'active' ? 'restart' : 'start' })}><RotateCw size={14} /></button>}
            </div>
          </div>
        );
      })}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={run} busy={busy} danger title={`${confirm?.action} ${confirm?.id}?`} body={confirm?.id === 'fips' && confirm.action !== 'start' ? 'Restarting the daemon drops every peer link and session. Peers reconnect automatically, but traffic over the mesh will pause for a few seconds.' : `The service manager will ${confirm?.action} ${confirm?.unit} on this host.`} confirmLabel={confirm?.action ?? 'Confirm'} />
    </div>
  );
}
