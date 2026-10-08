import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { parseDocument } from 'yaml';
import type { Health, PubdomAttestation, PubdomCheckDns, PubdomFileText, PubdomPin, PubdomResolverStatus, PubdomServerStatus, PubdomSide, PubdomState, PubdomZone, PubdomZones } from '../lib/types';
import { api, usePoll } from '../lib/api';
import { Card, Chip, ConfirmDialog, Copyable, Empty, ErrorNote, KV, Modal, Segmented, Skeleton, useToast } from '../components/ui';
import { NpubInline } from '../components/PeerName';
import { adminApi, withResult, PUBDOM_HELPER_VERSION, type HelperInfo, type PubdomResult } from '../lib/admin';
import { fmtAgo, fmtDuration, fmtTime, shortKey } from '../lib/format';

// Public domain names over fips (fr34aky/fips-pub-domains, docs/webui.md): what this node serves
// (fips-pubdom-server) and what it resolves (fips-pubdomd), read from their control sockets. Viewers see
// everything; admins act over the sockets (publish, check DNS, forget, flush) and edit the zone and
// configuration files through the privileged helper, which validates each with the binaries' own parsers.

type Tab = 'server' | 'resolver';
const UNIT: Record<Tab, string> = { server: 'fips-pubdom-server', resolver: 'fips-pubdom' };

/** What the viewer may do: socket actions need the admin role, file edits the helper with the public-domains verbs. */
interface Can { admin: boolean; edit: boolean; serviceControl: boolean }

export function PublicDomains({ health }: { health: Health | null }) {
  // health's snapshot opens the page; what is running is re-read while it is open, so a unit started or
  // stopped meanwhile shows as such without a reload.
  const state = usePoll(() => api.get<PubdomState>('/api/pubdom/state'), [], 15000);
  const pd = state.data ?? health?.pubdom;
  const admin = !!health && !health.readOnly;
  const helper = usePoll(() => (admin ? adminApi.status().then((r) => r.helper) : Promise.resolve(null)), [admin], 60000);
  const can: Can = { admin, edit: admin && !!helper.data && helper.data.managementCapable && (helper.data.version ?? 0) >= PUBDOM_HELPER_VERSION, serviceControl: !!health?.serviceControl };
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
      {admin && helper.data && !can.edit && <HelperNote helper={helper.data} />}
      {!side.running ? <NotRunning tab={current} side={side} can={can} onChanged={state.refresh} />
        : current === 'server' ? <Server can={can} /> : <Resolver can={can} />}
      {side.running && <LogCard key={current} side={current} />}
    </div>
  );
}

function HelperNote({ helper }: { helper: HelperInfo }) {
  const why = !helper.managementCapable ? (helper.error ?? 'the privileged helper is not available') : `helper v${helper.version} is installed; the public-domains verbs came with v${PUBDOM_HELPER_VERSION}`;
  return <Card><div className="text-sm text-ink-2">Editing zone files and the configuration needs the privileged helper, version {PUBDOM_HELPER_VERSION} or newer: {why}. The actions over the control sockets work without it.<div className="mt-2"><Copyable text="sudo ./deploy/setup-local.sh" className="rounded-lg bg-surface-2 px-3 py-2 text-xs w-fit" /></div></div></Card>;
}

function NotRunning({ tab, side, can, onChanged }: { tab: Tab; side: PubdomSide; can: Can; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const what = tab === 'server' ? 'The domain server' : 'The resolver';
  const start = async () => {
    setBusy(true);
    try { await adminApi.service(UNIT[tab], 'start'); toast('ok', `${UNIT[tab]} started`); setTimeout(onChanged, 1500); }
    catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Card title={what} actions={can.serviceControl && <button className="btn sm primary" disabled={busy} onClick={start}>Start {UNIT[tab]}</button>}>
      <Empty><div className="max-w-md"><p className="mb-2">{what} is installed but its control socket <code>{side.socket}</code> does not answer.</p><p className="text-xs">Start the unit, or point its configuration's <code>control:</code> at a directory that exists.</p></div></Empty>
    </Card>
  );
}

const ts = (t: number | null | undefined) => (t ? <span title={fmtTime(t * 1000, true)}>{fmtAgo(t * 1000)}</span> : <span className="text-ink-3">never</span>);
const until = (t: number | null | undefined, past = 'expired') => (t ? <span title={fmtTime(t * 1000, true)}>{t * 1000 > Date.now() + 1500 ? `in ${fmtDuration((t * 1000 - Date.now()) / 1000)}` : past}</span> : <span className="text-ink-3">none</span>);
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

type Run = <T,>(fn: () => Promise<T>, okMsg: string | ((r: T) => string)) => Promise<T | null>;

/** One action at a time per card; a structured refusal (422) is shown, not thrown. */
function useAction(onDone?: () => void): { busy: boolean; run: Run } {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run: Run = async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await withResult(fn());
      if (r && typeof r === 'object' && 'ok' in r && !(r as { ok: boolean }).ok) { toast('err', (r as { error?: string }).error ?? 'Refused'); return r; }
      toast('ok', typeof okMsg === 'function' ? okMsg(r) : okMsg); onDone?.(); return r;
    } catch (e) { toast('err', (e as Error).message); return null; }
    finally { setBusy(false); }
  };
  return { busy, run };
}

function Server({ can }: { can: Can }) {
  const status = usePoll(() => api.get<PubdomServerStatus>('/api/pubdom/server/status'), [], 10000);
  const zones = usePoll(() => api.get<PubdomZones>('/api/pubdom/server/zones'), [], 10000);
  const refresh = () => { status.refresh(); zones.refresh(); };
  const { busy, run } = useAction(refresh);
  const [editor, setEditor] = useState<{ zone: PubdomZone | null } | null>(null);
  const [confirm, setConfirm] = useState<PubdomZone | null>(null);
  if (status.error) return <ErrorNote>{status.error}</ErrorNote>;
  const s = status.data;
  const publishing = !!s?.publishing;
  return (
    <>
      <Card title="This node" hint="What the TXT record and the claims name" actions={<button className="btn ghost icon sm" onClick={refresh} title="Refresh"><RefreshCw size={14} /></button>}>
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
      <Card title="Relays" hint="Where the claims and zone records go" actions={can.admin && publishing && <button className="btn sm" disabled={busy} onClick={() => run(() => adminApi.pubdomAction('server', 'publish'), 'Publishing every domain now')}>Publish all now</button>}>
        {!s ? <Skeleton className="h-12 w-full" /> : s.relays.length === 0 ? <Empty>No relays: the claims are not published.{can.edit && <> Add some under Publishing below.</>}</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Relay</th><th>Last accepted</th><th>Last error</th></tr></thead><tbody>
            {s.relays.map((r) => <tr key={r.url}><td className="mono text-xs">{r.url}</td><td>{ts(r.accepted_at)}</td><td className="text-xs">{r.last_error ? <span className="text-crit">{r.last_error}</span> : <span className="text-ink-3">—</span>}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
      {zones.error ? <ErrorNote>{zones.error}</ErrorNote> : !zones.data ? <Skeleton className="h-24 w-full" /> : (
        <>
          {zones.data.zones.length === 0 ? (
            <Card title="Domains" actions={can.edit && <button className="btn sm primary" onClick={() => setEditor({ zone: null })}><Plus size={14} />Add domain</button>}>
              <Empty><div className="max-w-md"><p className="mb-2">No zone file yet.</p><p className="text-xs">{can.edit ? 'Add a domain here, or drop' : 'Drop'} a <code>domain.yaml</code> into the zones directory: it is served within a second (fips-pub-domains, docs/operators.md).</p></div></Empty>
            </Card>
          ) : (
            <>
              {can.edit && <div className="flex justify-end -mb-2"><button className="btn sm primary" onClick={() => setEditor({ zone: null })}><Plus size={14} />Add domain</button></div>}
              {zones.data.zones.map((z) => <ZoneCard key={z.domain} z={z} can={can} publishing={publishing} busy={busy} run={run} onEdit={() => setEditor({ zone: z })} onDelete={() => setConfirm(z)} />)}
            </>
          )}
          {zones.data.skipped.length > 0 && (
            <Card title="Skipped files" hint="Zone files the server could not load; the log below says why">
              <ul className="text-xs mono">{zones.data.skipped.map((f) => <li key={f.file}>{f.file}</li>)}</ul>
            </Card>
          )}
        </>
      )}
      {can.admin && <ConfigCard side="server" title="Publishing and server settings" hint="/etc/fips-pubdom/server.yaml: relays, DNSSEC proof, resolvers, port, TTL; a change restarts the server" can={can} onSaved={refresh} />}
      {editor && <ZoneEditor zone={editor.zone} defaultPort={s?.port ?? 5355} taken={zones.data?.zones.map((z) => z.domain) ?? []} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); refresh(); }} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} danger busy={busy} title={`Remove ${confirm?.domain}?`} confirmLabel="Remove"
        body={<p>The zone file <code>{confirm?.file}</code> is removed (a backup is kept) and the server stops answering for the domain within a second. The claim already published on the relays stays until it expires.</p>}
        onConfirm={async () => { if (!confirm) return; const r = await run(() => adminApi.pubdomZoneDelete(basename(confirm.file)), `${confirm.domain} removed`); if (r?.ok) setConfirm(null); }} />
    </>
  );
}

function ZoneCard({ z, can, publishing, busy, run, onEdit, onDelete }: { z: PubdomZone; can: Can; publishing: boolean; busy: boolean; run: Run; onEdit: () => void; onDelete: () => void }) {
  const [dns, setDns] = useState<PubdomCheckDns | null>(null);
  const [atts, setAtts] = useState<PubdomAttestation[] | 'loading' | { error: string } | null>(null);
  const checkDns = async () => { const r = await run(() => adminApi.pubdomAction<PubdomCheckDns>('server', 'check-dns', z.domain), (r) => `DNS: ${r.result.verdict}`); if (r) setDns(r.result); };
  const loadAtts = async () => {
    setAtts('loading');
    try { setAtts(await api.get<PubdomAttestation[]>(`/api/pubdom/server/attestations?domain=${encodeURIComponent(z.domain)}`)); }
    catch (e) { setAtts({ error: (e as Error).message }); }
  };
  const state = z.last_error ? <Chip tone="crit">{z.last_error}</Chip> : z.claim_published_at ? <Chip tone="good">published</Chip> : publishing ? <Chip tone="warn">not yet published</Chip> : null;
  return (
    <Card title={z.domain} hint={z.file} actions={<div className="flex items-center gap-2 flex-wrap justify-end">
      {state}
      <button className="btn sm ghost" disabled={atts === 'loading'} onClick={loadAtts} title="Who vouches for the domain on the relays">Attestations</button>
      {can.admin && <button className="btn sm" disabled={busy} onClick={checkDns} title="Verify the TXT record as a client would">Check DNS</button>}
      {can.admin && publishing && <button className="btn sm" disabled={busy} onClick={() => run(() => adminApi.pubdomAction('server', 'publish', z.domain), `Publishing ${z.domain} now`)}>Publish now</button>}
      {can.edit && <button className="btn sm ghost" onClick={onEdit}><Pencil size={13} />Edit</button>}
      {can.edit && <button className="btn sm ghost" disabled={busy} onClick={onDelete} title="Remove the zone file"><Trash2 size={13} /></button>}
    </div>}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="text-xs text-ink-3 mb-1">Names</div>
          <table className="data"><thead><tr><th>Name</th><th>Where</th></tr></thead><tbody>
            {z.names.map((n) => <tr key={n.label}><td className="mono">{n.label === '*' ? `*.${z.domain}` : n.label === '@' ? z.domain : `${n.label}.${z.domain}`}</td><td>{n.target === 'self' ? <Chip tone="accent" dot={false}>this node</Chip> : n.target === 'legacy' ? <Chip dot={false}>legacy (not over fips)</Chip> : <NpubInline npub={n.target} />}</td></tr>)}
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
      {dns && (
        <div className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-ink-3 text-xs">DNS check</span><Chip dot={false} tone={dns.verdict.startsWith('verified') ? 'good' : dns.verdict === 'no record' || dns.verdict === 'unreachable' ? 'warn' : 'crit'}>{dns.verdict}</Chip>{dns.detail && <span className="text-xs text-ink-2">{dns.detail}</span>}</div>
          <div className="text-xs text-ink-3 mt-1">asked {dns.upstreams.join(', ')}{dns.ttl != null ? `, TTL ${dns.ttl} s` : ''}; the record a client must see is the one above</div>
        </div>
      )}
      {atts !== null && (
        <div className="mt-3">
          <div className="text-xs text-ink-3 mb-1">Attestations on the relays <span title="A resolver believes only the witnesses it configured; this is who vouched at all">(the server's view, not a verification)</span></div>
          {atts === 'loading' ? <Skeleton className="h-8 w-full" /> : 'error' in atts ? <ErrorNote>{atts.error}</ErrorNote> : atts.length === 0 ? <div className="text-xs text-ink-3">Nobody has attested this domain on the configured relays.</div> : (
            <div className="overflow-x-auto"><table className="data"><thead><tr><th>Witness</th><th>Attests</th><th>Method</th><th>Verified</th><th>Published</th></tr></thead><tbody>
              {atts.map((a) => <tr key={a.witness}><td><NpubInline npub={a.witness} /></td><td>{a.names_this_server ? <Chip tone="good" dot={false}>this server</Chip> : <span className="grid gap-1">{a.servers.map((sv) => <NpubInline key={sv} npub={sv} />)}</span>}</td><td><Chip dot={false} tone={a.method === 'dnssec' ? 'good' : 'accent'}>{a.method}</Chip></td><td>{ts(a.verified_at)}</td><td>{ts(a.created_at)}</td></tr>)}
            </tbody></table></div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- the zone editor

type RowKind = 'self' | 'node' | 'legacy';
interface Row { label: string; kind: RowKind; npub: string }

/** The zone file for the table: a label per line, quoted where YAML needs it (`*`, `@`). */
export function renderZoneYaml(domain: string, port: string, rows: Row[]): string {
  const lines = [`domain: ${domain.trim().toLowerCase()}`];
  if (port.trim()) lines.push(`port: ${port.trim()}`);
  lines.push('names:');
  for (const r of rows) {
    const label = r.label.trim().toLowerCase();
    if (!label) continue;
    const key = /^[a-z0-9-]+$/.test(label) ? label : JSON.stringify(label);
    lines.push(`  ${key}: ${r.kind === 'node' ? r.npub.trim() : r.kind}`);
  }
  return lines.join('\n') + '\n';
}

function ZoneEditor({ zone, defaultPort, taken, onClose, onSaved }: { zone: PubdomZone | null; defaultPort: number; taken: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [domain, setDomain] = useState(zone?.domain ?? '');
  const [port, setPort] = useState(zone && zone.port !== defaultPort ? String(zone.port) : '');
  const [rows, setRows] = useState<Row[]>(zone ? zone.names.map((n) => ({ label: n.label, kind: n.target === 'self' ? 'self' : n.target === 'legacy' ? 'legacy' : 'node', npub: n.target === 'self' || n.target === 'legacy' ? '' : n.target })) : [{ label: 'www', kind: 'self', npub: '' }]);
  const [mode, setMode] = useState<'table' | 'yaml'>('table');
  const [yaml, setYaml] = useState<string | null>(null);
  const [file, setFile] = useState<PubdomFileText | null>(zone ? null : { path: '', text: '', base: 'none' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<PubdomResult | null>(null);
  const [busy, setBusy] = useState(false);
  // An existing file is read for its hash (the helper refuses a save over a file that changed meanwhile) and
  // for the raw view; the table is filled from what the server loaded.
  useEffect(() => {
    if (!zone) return;
    api.get<PubdomFileText>(`/api/pubdom/server/zone-file?file=${encodeURIComponent(zone.file)}`).then(setFile).catch((e: Error) => setLoadError(e.message));
  }, [zone]);
  const generated = renderZoneYaml(domain, port, rows);
  const text = mode === 'yaml' ? (yaml ?? generated) : generated;
  const wildcard = rows.some((r) => r.label.trim() === '*');
  const problems: string[] = [];
  if (!zone && !/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain.trim().toLowerCase())) problems.push('the domain must be a registered name like example.org');
  if (!zone && taken.includes(domain.trim().toLowerCase())) problems.push('this domain already has a zone file; edit that one');
  if (port.trim() && !/^\d{1,5}$/.test(port.trim())) problems.push('the port must be a number');
  if (mode === 'table') {
    if (!rows.some((r) => r.label.trim())) problems.push('at least one name is needed');
    for (const r of rows) if (r.kind === 'node' && !/^npub1[02-9ac-hj-np-z]{58}$/.test(r.npub.trim())) problems.push(`${r.label.trim() || 'a row'}: the other node's npub is needed`);
  }
  const save = async () => {
    if (!file) return;
    setBusy(true); setResult(null);
    try {
      const r = await withResult(adminApi.pubdomZone(zone ? basename(zone.file) : `${domain.trim().toLowerCase()}.yaml`, text, file.base));
      setResult(r);
      if (r.ok) { toast('ok', r.changed ? `${zone?.domain ?? domain.trim()} saved; the server picks it up within a second` : 'No changes'); onSaved(); }
      else toast('err', r.error ?? 'Refused');
    } catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={zone ? `Edit ${zone.domain}` : 'Add a domain'} width="max-w-3xl">
      <div className="grid gap-3">
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <label className="field">Domain<input className="input mono" value={domain} disabled={!!zone} onChange={(e) => setDomain(e.target.value)} placeholder="example.org" /></label>
          <label className="field">Port<input className="input mono" value={port} onChange={(e) => setPort(e.target.value)} placeholder={String(defaultPort)} title="Must match the TXT record; empty for the server's port" /></label>
        </div>
        <Segmented value={mode} onChange={(m) => { if (m === 'yaml' && yaml === null) setYaml(file?.text && zone ? file.text : generated); setMode(m); }} options={[{ value: 'table', label: 'Names' }, { value: 'yaml', label: 'File' }]} />
        {mode === 'table' ? (
          <div className="grid gap-2">
            <div className="text-xs text-ink-3">Each name under the domain and where it points: this node, another fips node (its npub), or <em>legacy</em> for a name that stays on the ordinary Internet even under a wildcard. <code>@</code> is the domain itself, <code>*</code> every other name.</div>
            {rows.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[10rem_9rem_minmax(0,1fr)_2rem] items-center">
                <input className="input mono" value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="www" />
                <select className="input" value={r.kind} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, kind: e.target.value as RowKind } : x)))}>
                  <option value="self">this node</option><option value="node">another node</option><option value="legacy">legacy (not over fips)</option>
                </select>
                {r.kind === 'node' ? <input className="input mono" value={r.npub} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, npub: e.target.value } : x)))} placeholder="npub1…" /> : <span className="text-xs text-ink-3">{r.kind === 'self' ? 'answered with this node\'s mesh address' : 'resolved by the ordinary DNS'}</span>}
                <button type="button" className="btn ghost icon sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} title="Remove"><Trash2 size={13} /></button>
              </div>
            ))}
            <div><button type="button" className="btn sm" onClick={() => setRows([...rows, { label: '', kind: 'self', npub: '' }])}><Plus size={13} />Add name</button></div>
            {wildcard && <div className="text-xs text-warn">A wildcard claims every name under the domain for the mesh: a browser on the mesh will not reach any name you forgot to mark <em>legacy</em>. Use it only if everything under the domain really is on the mesh.</div>}
          </div>
        ) : (
          <label className="field">The zone file as it will be written (checked by the server's own parser on save)<textarea className="input mono h-56 py-2 resize-y" spellCheck={false} value={text} onChange={(e) => setYaml(e.target.value)} /></label>
        )}
        {problems.length > 0 && <div className="text-xs text-warn">{problems.join('; ')}</div>}
        {result && !result.ok && <ErrorNote><div>{result.error}</div>{result.detail && <pre className="mt-1 text-xs whitespace-pre-wrap">{result.detail}</pre>}</ErrorNote>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !file || problems.length > 0} onClick={save}>{zone ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the configuration files

function ConfigCard({ side, title, hint, can, onSaved }: { side: Tab; title: string; hint: string; can: Can; onSaved: () => void }) {
  const toast = useToast();
  const file = usePoll(() => api.get<PubdomFileText>(`/api/pubdom/${side}/config-file`), [side], 0);
  const [draft, setDraft] = useState<string | null>(null);
  const [restart, setRestart] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PubdomResult | null>(null);
  const original = (file.data?.text ?? '').replace(/\r\n/g, '\n');
  const text = draft ?? original;
  const dirty = draft !== null && draft !== original;
  const syntax = useMemo(() => {
    if (!text.trim()) return null;
    const doc = parseDocument(text, { prettyErrors: false });
    if (doc.errors.length) return doc.errors[0].message.split('\n')[0];
    const js = doc.toJS() as unknown;
    return js && typeof js === 'object' && !Array.isArray(js) ? null : 'the top level must be a mapping (key: value lines)';
  }, [text]);
  const save = async () => {
    if (!file.data) return;
    setBusy(true); setResult(null);
    try {
      const r = await withResult(adminApi.pubdomConfig(side, text, file.data.base, restart));
      setResult(r);
      if (r.ok) { toast('ok', r.changed ? (r.restarted ? `${file.data.path} saved and ${UNIT[side]} restarted` : `${file.data.path} saved`) : 'No changes'); setDraft(null); file.refresh(); onSaved(); }
      else toast('err', r.error ?? 'Refused');
    } catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); setConfirm(false); }
  };
  return (
    <Card title={title} hint={hint} actions={<div className="flex gap-2">{dirty && <button className="btn sm" disabled={busy} onClick={() => setDraft(null)}>Discard</button>}<button className="btn sm primary" disabled={!can.edit || !dirty || !!syntax || busy || !text.trim()} title={can.edit ? undefined : `needs helper v${PUBDOM_HELPER_VERSION}`} onClick={() => setConfirm(true)}>Save</button></div>}>
      {file.error ? <ErrorNote>{file.error}</ErrorNote> : !file.data ? <Skeleton className="h-24 w-full" /> : (
        <div className="grid gap-2">
          {file.data.base === 'none' && <div className="text-xs text-ink-3">{file.data.path} does not exist yet; what you save here creates it.</div>}
          <textarea className="input mono h-48 py-2 resize-y" spellCheck={false} value={text} readOnly={!can.edit} onChange={(e) => setDraft(e.target.value)} placeholder={side === 'server' ? 'zones: /etc/fips-pubdom/zones\npublish:\n  relays: ["wss://relay.example", "ws://npub1….fips:80"]' : 'upstreams: ["9.9.9.9", "1.1.1.1"]\nwitnesses: []'} />
          {syntax && <div className="text-xs text-warn">YAML: {syntax}</div>}
          {result && !result.ok && <ErrorNote><div>{result.error}</div>{result.detail && <pre className="mt-1 text-xs whitespace-pre-wrap">{result.detail}</pre>}</ErrorNote>}
        </div>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} busy={busy} title={`Save ${file.data?.path ?? ''}?`} confirmLabel="Save"
        body={<div className="grid gap-2"><p>The file is checked with <code>{side === 'resolver' ? 'fips-pubdomd' : 'fips-pubdom-server'} validate config</code> before it is written; a backup of the current one is kept.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />Restart {UNIT[side]} if it is running</label></div>}
        onConfirm={save} />
    </Card>
  );
}

function Resolver({ can }: { can: Can }) {
  const status = usePoll(() => api.get<PubdomResolverStatus>('/api/pubdom/resolver/status'), [], 10000);
  const pins = usePoll(() => api.get<PubdomPin[]>('/api/pubdom/resolver/pins'), [], 10000);
  const refresh = () => { status.refresh(); pins.refresh(); };
  const { busy, run } = useAction(refresh);
  const [confirm, setConfirm] = useState<PubdomPin | null>(null);
  if (status.error) return <ErrorNote>{status.error}</ErrorNote>;
  const s = status.data;
  return (
    <>
      <Card title="Resolver" hint="fips-pubdomd, in front of this node's DNS" actions={<div className="flex gap-2">{can.admin && <button className="btn sm" disabled={busy} onClick={() => run(() => adminApi.pubdomAction('resolver', 'flush'), 'Caches flushed')} title="Forget cached answers and decisions; the pins stay">Flush caches</button>}<button className="btn ghost icon sm" onClick={refresh} title="Refresh"><RefreshCw size={14} /></button></div>}>
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
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Domain</th><th>Server</th><th className="num">Port</th><th>Verified by</th><th>Verified</th>{can.admin && <th></th>}</tr></thead><tbody>
            {pins.data.map((p) => <tr key={`${p.domain}-${p.npub}`}><td className="mono">{p.domain}</td><td><NpubInline npub={p.npub} /></td><td className="num">{p.port}</td><td><Chip dot={false} tone={p.method === 'dnssec' ? 'good' : p.method === 'dns' || p.method === 'attested' ? 'accent' : 'warn'}>{p.method}</Chip></td><td>{ts(p.verified_at)}</td>{can.admin && <td className="text-right"><button className="btn sm ghost" disabled={busy} onClick={() => setConfirm(p)} title="Drop the pin; the next lookup verifies the domain again">Forget</button></td>}</tr>)}
          </tbody></table></div>
        )}
      </Card>
      {can.admin && <ConfigCard side="resolver" title="Resolver settings" hint="/etc/fips-pubdom/config.yaml: upstreams, witnesses, relays, plain probe; a change restarts the daemon" can={can} onSaved={refresh} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} busy={busy} title={`Forget ${confirm?.domain}?`} confirmLabel="Forget"
        body={<p>The pin for <code>{confirm?.domain}</code> is dropped and the caches flushed. The next lookup verifies the domain again from the legacy DNS, or from the mesh relays when offline — which is when a pin matters, so forget one only if it is wrong.</p>}
        onConfirm={async () => { if (!confirm) return; const r = await run(() => adminApi.pubdomAction<{ forgotten: boolean }>('resolver', 'forget', confirm.domain), (r) => (r.result.forgotten ? `${confirm.domain} forgotten` : `${confirm.domain} had no pin`)); if (r) setConfirm(null); }} />
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
