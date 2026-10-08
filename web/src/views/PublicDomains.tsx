import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Health, PubdomPin, PubdomResolverStatus, PubdomServerStatus, PubdomSide, PubdomState, PubdomZones } from '../lib/types';
import { api, usePoll } from '../lib/api';
import { Card, Chip, Copyable, Empty, ErrorNote, KV, Segmented, Skeleton } from '../components/ui';
import { NpubInline } from '../components/PeerName';
import { fmtAgo, fmtDuration, fmtTime, shortKey } from '../lib/format';

// Public domain names over fips (fr34aky/fips-pub-domains, docs/webui.md): what this node serves
// (fips-pubdom-server) and what it resolves (fips-pubdomd), read from their control sockets. Read-only
// in this phase: editing, publish-now and the DNS check come with the helper's zone verbs.

type Tab = 'server' | 'resolver';

export function PublicDomains({ health }: { health: Health | null }) {
  // health's snapshot opens the page; what is running is re-read while it is open, so a unit started or
  // stopped meanwhile shows as such without a reload.
  const state = usePoll(() => api.get<PubdomState>('/api/pubdom/state'), [], 15000);
  const pd = state.data ?? health?.pubdom;
  const tabs: { value: Tab; label: string }[] = [];
  if (pd?.server.installed) tabs.push({ value: 'server', label: 'Domain server' });
  if (pd?.resolver.installed) tabs.push({ value: 'resolver', label: 'Resolver' });
  const [tab, setTab] = useState<Tab>(tabs[0]?.value ?? 'server');
  if (!pd || tabs.length === 0) {
    return <Card title="Public domains"><Empty><div className="max-w-md"><p className="mb-2">Neither <code>fips-pubdom-server</code> nor <code>fips-pubdomd</code> is installed on this node.</p><p className="text-xs">Public domain names over fips let <code>www.example.org</code> resolve to a mesh node: fr34aky/fips-pub-domains.</p></div></Empty></Card>;
  }
  const current = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;
  const side = pd[current];
  return (
    <div className="grid gap-4 fade-in">
      {tabs.length > 1 && <Segmented value={current} onChange={setTab} options={tabs} />}
      {!side.running ? <NotRunning what={current === 'server' ? 'The domain server' : 'The resolver'} side={side} />
        : current === 'server' ? <Server /> : <Resolver />}
      {side.running && <LogCard key={current} side={current} />}
    </div>
  );
}

function NotRunning({ what, side }: { what: string; side: PubdomSide }) {
  return <Card title={what}><Empty><div className="max-w-md"><p className="mb-2">{what} is installed but its control socket <code>{side.socket}</code> does not answer.</p><p className="text-xs">Start the unit, or point its configuration's <code>control:</code> at a directory that exists.</p></div></Empty></Card>;
}

const ts = (t: number | null | undefined) => (t ? <span title={fmtTime(t * 1000, true)}>{fmtAgo(t * 1000)}</span> : <span className="text-ink-3">never</span>);
const until = (t: number | null | undefined, past = 'expired') => (t ? <span title={fmtTime(t * 1000, true)}>{t * 1000 > Date.now() + 1500 ? `in ${fmtDuration((t * 1000 - Date.now()) / 1000)}` : past}</span> : <span className="text-ink-3">none</span>);

function Server() {
  const status = usePoll(() => api.get<PubdomServerStatus>('/api/pubdom/server/status'), [], 10000);
  const zones = usePoll(() => api.get<PubdomZones>('/api/pubdom/server/zones'), [], 10000);
  if (status.error) return <ErrorNote>{status.error}</ErrorNote>;
  const s = status.data;
  return (
    <>
      <Card title="This node" hint="What the TXT record and the claims name" actions={<button className="btn ghost icon sm" onClick={() => { status.refresh(); zones.refresh(); }} title="Refresh"><RefreshCw size={14} /></button>}>
        {!s ? <Skeleton className="h-20 w-full" /> : (
          <KV items={[
            ['Server', <NpubInline npub={s.npub} />],
            ['Mesh address', <Copyable text={s.address} display={shortKey(s.address, 14, 8)} />],
            ['Listening', <span className="mono">{s.bind}</span>],
            ['Publishing', s.publishing ? <Chip tone="good">on</Chip> : <Chip tone="warn">off — no relays configured</Chip>],
            ['Version', s.version],
          ]} />
        )}
      </Card>
      <Card title="Relays" hint="Where the claims and zone records go">
        {!s ? <Skeleton className="h-12 w-full" /> : s.relays.length === 0 ? <Empty>No relays: the claims are not published.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Relay</th><th>Last accepted</th><th>Last error</th></tr></thead><tbody>
            {s.relays.map((r) => <tr key={r.url}><td className="mono text-xs">{r.url}</td><td>{ts(r.accepted_at)}</td><td className="text-xs">{r.last_error ? <span className="text-crit">{r.last_error}</span> : <span className="text-ink-3">—</span>}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
      {zones.error ? <ErrorNote>{zones.error}</ErrorNote> : !zones.data ? <Skeleton className="h-24 w-full" /> : zones.data.zones.length === 0 ? (
        <Card title="Domains"><Empty><div className="max-w-md"><p className="mb-2">No zone file yet.</p><p className="text-xs">A <code>domain.yaml</code> dropped into the zones directory is served within a second (fips-pub-domains, docs/operators.md).</p></div></Empty></Card>
      ) : zones.data.zones.map((z) => (
        <Card key={z.domain} title={z.domain} hint={z.file} actions={z.last_error ? <Chip tone="crit">{z.last_error}</Chip> : z.claim_published_at ? <Chip tone="good">published</Chip> : s?.publishing ? <Chip tone="warn">not yet published</Chip> : undefined}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <div className="text-xs text-ink-3 mb-1">Names</div>
              <table className="data"><thead><tr><th>Name</th><th>Where</th></tr></thead><tbody>
                {z.names.map((n) => <tr key={n.label}><td className="mono">{n.label === '*' ? '*' : n.label === '@' ? z.domain : `${n.label}.${z.domain}`}</td><td>{n.target === 'self' ? <Chip tone="accent" dot={false}>this node</Chip> : n.target === 'legacy' ? <Chip dot={false}>legacy (not over fips)</Chip> : <NpubInline npub={n.target} />}</td></tr>)}
              </tbody></table>
            </div>
            <KV items={[
              ['Port', String(z.port)],
              ['Claim published', ts(z.claim_published_at)],
              ['Zone record published', ts(z.zone_published_at)],
              ['DNSSEC proof valid', until(z.dnssec_proof_until)],
              ['Next publication', until(z.next_publish_at, 'now')],
            ]} />
          </div>
          <div className="mt-3">
            <div className="text-xs text-ink-3 mb-1">DNS record to add at the domain's hoster</div>
            <Copyable text={z.txt_record} display={<span className="text-xs break-all">{z.txt_record}</span>} />
          </div>
        </Card>
      ))}
      {zones.data && zones.data.skipped.length > 0 && (
        <Card title="Skipped files" hint="Zone files the server could not load; the journal says why">
          <ul className="text-xs mono">{zones.data.skipped.map((f) => <li key={f.file}>{f.file}</li>)}</ul>
        </Card>
      )}
    </>
  );
}

function Resolver() {
  const status = usePoll(() => api.get<PubdomResolverStatus>('/api/pubdom/resolver/status'), [], 10000);
  const pins = usePoll(() => api.get<PubdomPin[]>('/api/pubdom/resolver/pins'), [], 10000);
  if (status.error) return <ErrorNote>{status.error}</ErrorNote>;
  const s = status.data;
  return (
    <>
      <Card title="Resolver" hint="fips-pubdomd, in front of this node's DNS" actions={<button className="btn ghost icon sm" onClick={() => { status.refresh(); pins.refresh(); }} title="Refresh"><RefreshCw size={14} /></button>}>
        {!s ? <Skeleton className="h-20 w-full" /> : (
          <KV items={[
            ['State', s.online ? <Chip tone="good">online</Chip> : <Chip tone="warn">offline — mesh relays only</Chip>],
            ['Listening', <span className="mono">{s.listen.join(', ')}</span>],
            ['Upstreams', s.upstreams.length ? <span className="mono">{s.upstreams.join(', ')}</span> : <span className="text-ink-3">none</span>],
            ['Upstreams from', s.upstreams_from ? <span className="mono text-xs">{s.upstreams_from}</span> : <span className="text-ink-3">configured</span>],
            ['OS integration', s.backend ?? <span className="text-ink-3">not set up</span>],
            ['DNSSEC', s.dnssec ? 'on' : 'off'],
            ['Plain probe', s.plain_probe ? 'on' : 'off (every denial validated)'],
            ['Witnesses', s.witnesses.length ? <span className="grid gap-1">{s.witnesses.map((w) => <NpubInline key={w} npub={w} />)}</span> : <span className="text-ink-3">none</span>],
            ['Attestation threshold', String(s.attestation_threshold)],
            ['Mesh relays', s.mesh_relays.length ? <span className="mono text-xs">{s.mesh_relays.join(', ')}</span> : <span className="text-ink-3">none</span>],
            ['Public relays', <span className="mono text-xs">{s.public_relays.join(', ')}</span>],
            ['Version', s.version],
          ]} />
        )}
      </Card>
      <Card title={`Verified domains${pins.data ? ` (${pins.data.length})` : ''}`} hint="Pinned bindings: domain → the node that serves it" pad={false}>
        {pins.error ? <div className="p-4"><ErrorNote>{pins.error}</ErrorNote></div> : !pins.data ? <div className="p-4"><Skeleton className="h-12 w-full" /></div> : pins.data.length === 0 ? <Empty>No domain verified yet: the first lookup of a bound domain pins it.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Domain</th><th>Server</th><th className="num">Port</th><th>Verified by</th><th>Verified</th></tr></thead><tbody>
            {pins.data.map((p) => <tr key={`${p.domain}-${p.npub}`}><td className="mono">{p.domain}</td><td><NpubInline npub={p.npub} /></td><td className="num">{p.port}</td><td><Chip dot={false} tone={p.method === 'dnssec' ? 'good' : p.method === 'dns' || p.method === 'attested' ? 'accent' : 'warn'}>{p.method}</Chip></td><td>{ts(p.verified_at)}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
    </>
  );
}

function LogCard({ side }: { side: Tab }) {
  const log = usePoll(() => api.get<string[]>(`/api/pubdom/${side}/log?n=200`), [side], 15000);
  return (
    <Card title="Log" hint={`The last lines of ${side === 'server' ? 'fips-pubdom-server' : 'fips-pubdomd'}`} pad={false} actions={<button className="btn ghost icon sm" onClick={log.refresh} title="Refresh"><RefreshCw size={14} /></button>}>
      {log.error ? <div className="p-4"><ErrorNote>{log.error}</ErrorNote></div> : !log.data ? <div className="p-4"><Skeleton className="h-12 w-full" /></div> : log.data.length === 0 ? <Empty>Nothing logged yet.</Empty> : (
        <div className="overflow-auto max-h-96 py-1">
          {log.data.map((l, i) => { const m = /^(\d+)\s+(\w+)\s+(\S+):\s(.*)$/.exec(l); const level = (m?.[2] ?? 'info').toLowerCase(); return (
            <div key={i} className={`log-line ${level}`}><span className="text-ink-3 tabular">{m ? fmtTime(Number(m[1]) * 1000) : ''}</span><span className="lvl">{level}</span><span className="msg">{m?.[3] && <span className="tgt">{m[3]} </span>}{m ? m[4] : l}</span></div>
          ); })}
        </div>
      )}
    </Card>
  );
}
