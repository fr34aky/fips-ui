import type { Snapshot } from '../lib/types';
import { Card, Chip, StatusChip, KV, Empty } from '../components/ui';
import { StatTile } from '../components/StatTile';
import { Meter } from './Internals';
import { fmtDuration, shortKey, fmtNum } from '../lib/format';

export function Gateway({ snap }: { snap: Snapshot }) {
  const g = snap.gateway;
  const unit = snap.units?.find((u) => u.id === 'fips-gateway');
  if (!g) {
    return (
      <Card title="LAN gateway">
        <Empty>
          <div className="max-w-md">
            <p className="mb-2">The <code>fips-gateway</code> control socket is not reachable{unit ? <>; the unit is <StatusChip value={unit.active} /></> : ''}.</p>
            <p className="text-xs">The gateway folds an unmodified LAN into the mesh by allocating virtual IPs for mesh nodes and translating traffic. Enable <code>gateway.*</code> in fips.yaml and start the <code>fips-gateway</code> service to see pool usage and mappings here.</p>
          </div>
        </Empty>
      </Card>
    );
  }
  const used = g.pool_total ? (g.pool_allocated ?? 0) / g.pool_total : 0;
  return (
    <div className="grid gap-4 fade-in">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Pool used" value={`${fmtNum(g.pool_allocated)} / ${fmtNum(g.pool_total)}`} sub={g.pool_cidr} />
        <StatTile label="Active mappings" value={fmtNum(g.pool_active)} sub={`${fmtNum(g.pool_draining)} draining`} />
        <StatTile label="NAT entries" value={fmtNum(g.nat_mappings)} />
        <StatTile label="Uptime" value={fmtDuration(g.uptime_secs)} sub={g.lan_interface} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card title="Configuration">
          <KV items={[['LAN interface', g.lan_interface], ['Pool CIDR', <span className="mono">{g.pool_cidr}</span>], ['Pool utilisation', <Meter value={used} />], ['Free', fmtNum(g.pool_free)], ['Grace period', fmtDuration(g.pool_grace_period)], ['DNS listen', <span className="mono">{g.dns_listen}</span>], ['DNS upstream', <span className="mono">{g.dns_upstream}</span>], ['DNS TTL', `${g.dns_ttl}s`]]} />
        </Card>
        <Card title={`Mappings (${g.mappings?.length ?? 0})`} pad={false}>
          {!g.mappings?.length ? <Empty>No LAN clients have resolved a mesh name yet.</Empty> : (
            <div className="overflow-x-auto"><table className="data"><thead><tr><th>Virtual IP</th><th>DNS name</th><th>Mesh node</th><th>State</th><th className="num">Sessions</th><th>Age</th><th>Last ref</th></tr></thead><tbody>
              {g.mappings.map((m) => <tr key={m.virtual_ip}><td className="mono">{m.virtual_ip}</td><td>{m.dns_name}</td><td className="mono text-xs">{shortKey(m.mesh_addr, 10, 6)}</td><td><Chip tone={m.state === 'Active' ? 'good' : m.state === 'Draining' ? 'warn' : 'neutral'}>{m.state}</Chip></td><td className="num">{m.sessions}</td><td className="text-xs text-ink-3">{fmtDuration(m.age_secs)}</td><td className="text-xs text-ink-3">{fmtDuration(m.last_ref_secs)} ago</td></tr>)}
            </tbody></table></div>
          )}
        </Card>
      </div>
    </div>
  );
}
