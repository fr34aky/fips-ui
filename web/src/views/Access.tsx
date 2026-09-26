import type { Snapshot } from '../lib/types';
import { Card, Chip, Copyable, KV, Empty, ErrorNote } from '../components/ui';
import { api, usePoll } from '../lib/api';
import { shortKey } from '../lib/format';
import { Listening } from './Overview';
import { Stethoscope } from 'lucide-react';
import { RemoteAccess } from '../components/RemoteAccess';

interface Acl { allow_all: boolean; allow_entries: string[]; allow_file: string; allow_file_entries: string[]; default_decision: string; deny_all: boolean; deny_entries: string[]; deny_file: string; deny_file_entries: string[]; effective_mode: string; enforcement_active: boolean }

export function Access({ snap, onProbe, readOnly }: { snap: Snapshot; onProbe: (peer: string) => void; readOnly: boolean }) {
  const acl = usePoll(() => api.q<Acl>('show_acl'), [], 10000);
  const hosts = usePoll(() => api.get<{ path: string; entries: { hostname: string; npub: string; comment?: string }[]; error?: string }>('/api/hosts'), [], 30000);
  const peers = snap.peers?.peers ?? [];
  const a = acl.data;
  return (
    <div className="grid gap-4 fade-in">
      <RemoteAccess readOnly={readOnly} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Peer ACL" hint="Which npubs may authenticate as peers. Configured in fips.yaml and /etc/fips/peers.allow / peers.deny.">
          {acl.error ? <ErrorNote>{acl.error}</ErrorNote> : !a ? <Empty>Loading…</Empty> : (
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-1.5">
                <Chip tone={a.enforcement_active ? 'good' : 'warn'}>{a.enforcement_active ? 'enforcing' : 'not enforcing'}</Chip>
                <Chip tone={a.effective_mode === 'default_open' ? 'warn' : 'accent'}>{a.effective_mode.replace(/_/g, ' ')}</Chip>
                <Chip>default: {a.default_decision}</Chip>
                {a.allow_all && <Chip tone="warn">allow all</Chip>}{a.deny_all && <Chip tone="crit">deny all</Chip>}
              </div>
              {a.effective_mode === 'default_open' && <p className="text-xs text-ink-3">Any npub may peer with this node. Add entries to {a.allow_file} or set an allow list in fips.yaml to restrict inbound peering.</p>}
              <List title={`Allow (config)`} items={a.allow_entries} /><List title={`Allow (${a.allow_file})`} items={a.allow_file_entries} />
              <List title={`Deny (config)`} items={a.deny_entries} /><List title={`Deny (${a.deny_file})`} items={a.deny_file_entries} />
            </div>
          )}
        </Card>
        <Card title="Exposed on fips0" hint="Local IPv6 listeners reachable over the mesh and how the fips firewall treats them"><Listening snap={snap} /></Card>
      </div>

      <Card title="Hosts file" hint="Static hostname → npub mappings resolved as <name>.fips" actions={hosts.data && <span className="text-xs text-ink-3 mono">{hosts.data.path}</span>} pad={false}>
        {hosts.error ? <div className="p-4"><ErrorNote>{hosts.error}</ErrorNote></div> : !hosts.data ? <Empty>Loading…</Empty> : hosts.data.error ? <div className="p-4"><ErrorNote>{hosts.data.error}</ErrorNote></div> : hosts.data.entries.length === 0 ? <Empty>No entries.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Hostname</th><th>npub</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>
            {hosts.data.entries.map((h) => { const p = peers.find((x) => x.npub === h.npub); return (
              <tr key={h.hostname}><td><Copyable text={`${h.hostname}.fips`} display={<b>{h.hostname}</b>} mono={false} /></td><td><Copyable text={h.npub} display={shortKey(h.npub, 14, 8)} /></td><td>{p ? <Chip tone="good">peer · {p.connectivity}</Chip> : <Chip>not a direct peer</Chip>}</td><td className="text-xs text-ink-3 max-w-[360px] truncate" title={h.comment}>{h.comment}</td><td className="text-right"><button className="btn sm ghost" onClick={() => onProbe(h.hostname)}><Stethoscope size={13} />Probe</button></td></tr>
            ); })}
          </tbody></table></div>
        )}
      </Card>

      <Card title="Node identity files">
        <KV items={[['Control socket', <span className="mono">{snap.status?.control_socket ?? '–'}</span>], ['Executable', <span className="mono">{snap.status?.exe_path ?? '–'}</span>], ['Persistent identity', snap.status?.persistent ? 'yes (fips.key / configured nsec)' : 'no: ephemeral key, address changes on restart'], ['DNS name', snap.status ? <Copyable text={`${snap.status.npub}.fips`} /> : '–']]} />
      </Card>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return <div><div className="text-xs text-ink-3 mb-1">{title} · {items.length}</div><div className="flex flex-wrap gap-1">{items.map((i) => <Copyable key={i} text={i} display={shortKey(i, 12, 6)} className="chip" />)}</div></div>;
}
