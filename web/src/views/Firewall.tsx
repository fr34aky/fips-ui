import { useEffect, useState } from 'react';
import { FileCode2, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, Pencil } from 'lucide-react';
import type { Snapshot } from '../lib/types';
import { Card, Chip, ConfirmDialog, Empty, ErrorNote, KV, Modal, Segmented, Skeleton, useToast } from '../components/ui';
import { adminApi, withResult, type DropinResult, type FirewallRule, type RuleSource } from '../lib/admin';
import { api, usePoll } from '../lib/api';
import { fmtAgo, fmtBytes, fmtNum, shortKey } from '../lib/format';
import { HelperGate } from '../components/HelperGate';

type Prefill = { proto?: 'tcp' | 'udp'; port?: string; comment?: string } | null;

export function Firewall({ snap, readOnly, prefill }: { snap: Snapshot; readOnly: boolean; prefill: Prefill }) {
  const toast = useToast();
  const status = usePoll(() => adminApi.status(), [], 30000);
  const helper = status.data?.helper;
  const fw = usePoll(() => (helper?.managementCapable ? adminApi.firewall() : Promise.resolve(null)), [helper?.managementCapable], 10000);
  const [ruleDialog, setRuleDialog] = useState<{ index: number | null; initial: Partial<FirewallRule> } | null>(null);
  const [dropinEdit, setDropinEdit] = useState<{ name: string; content: string; isNew: boolean } | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; body: React.ReactNode; label: string; run: () => Promise<void> }>(null);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<DropinResult | null>(null);

  useEffect(() => { if (prefill?.port && !readOnly) setRuleDialog({ index: null, initial: { proto: prefill.proto ?? 'tcp', ports: prefill.port, comment: prefill.comment, sources: [{ kind: 'any' }] } }); }, [prefill?.port, prefill?.proto, prefill?.comment, readOnly]);

  const run = async (fn: () => Promise<DropinResult | unknown>, okMsg: string) => {
    setBusy(true); setLastError(null);
    try {
      const r = (await withResult(fn() as Promise<DropinResult>)) as DropinResult;
      if (r && typeof r === 'object' && 'ok' in r && !r.ok) { setLastError(r); toast('err', r.error ?? 'Rejected'); return false; }
      toast('ok', okMsg); fw.refresh(); return true;
    } catch (e) { toast('err', (e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const saveRules = (rules: FirewallRule[], msg: string) => run(() => adminApi.saveRules(rules), msg);
  const svc = (action: 'start' | 'stop' | 'reload' | 'enable' | 'disable') => run(() => adminApi.service('fips-firewall', action), `fips-firewall: ${action} done`);

  const f = fw.data;
  const st = f && !('error' in f.status) ? f.status : null;
  const rules = f?.managedRules ?? [];
  const others = (f?.dropins ?? []).filter((d) => !d.managed);

  return (
    <div className="grid gap-4 fade-in">
      <p className="text-ink-2 text-sm max-w-3xl">The fips0 firewall is the default-deny nftables baseline at <code>/etc/fips/fips.nft</code>: nothing a mesh peer initiates gets in unless a drop-in in <code>/etc/fips/fips.d/</code> allows it. Every change is checked with <code>nft -c</code> against the full ruleset before it is written, and reloaded if the firewall is running.</p>
      <HelperGate helper={helper}>
        {fw.error && <ErrorNote>{fw.error}</ErrorNote>}
        {lastError && <div className="card px-4 py-3 text-sm grid gap-2" style={{ borderColor: 'rgba(208,59,59,0.5)' }}><div className="text-crit font-medium">{lastError.error}</div>{lastError.detail && <pre className="text-xs whitespace-pre-wrap bg-surface-2 rounded-lg p-3 max-h-48 overflow-auto">{lastError.detail}</pre>}</div>}

        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Card title="Firewall service" actions={<button className="btn ghost icon sm" onClick={() => fw.refresh()} title="Refresh"><RefreshCw size={14} /></button>}>
            {!f ? <Skeleton className="h-32 w-full" /> : 'error' in f.status ? <ErrorNote>{f.status.error}</ErrorNote> : st && (
              <div className="grid gap-3">
                <div className="flex items-center gap-3">
                  {st.tableLoaded ? <ShieldCheck size={28} className="text-good" /> : <ShieldAlert size={28} className="text-crit" />}
                  <div><div className="font-semibold">{st.tableLoaded ? 'Protecting fips0' : 'Not protecting fips0'}</div><div className="text-xs text-ink-3">{st.tableLoaded ? 'table inet fips is loaded' : 'every listener bound to :: is reachable from the mesh'}</div></div>
                </div>
                <KV items={[
                  ['Service', <Chip tone={st.unitActive ? 'good' : 'crit'}>{st.unitActive ? 'active' : 'inactive'}</Chip>],
                  ['At boot', <Chip tone={st.unitEnabled === 'enabled' ? 'good' : 'warn'}>{st.unitEnabled}</Chip>],
                  ['Rules loaded', st.summary ? fmtNum(st.summary.rules) : '–'],
                  ['Dropped', st.summary ? `${fmtNum(st.summary.dropPackets)} packets · ${fmtBytes(st.summary.dropBytes)}` : '–'],
                  ...(f.unit?.since && st.unitActive ? [['Since', fmtAgo(f.unit.since)] as [React.ReactNode, React.ReactNode]] : []),
                ]} />
                {!readOnly && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {st.unitEnabled !== 'enabled' && <button className="btn primary sm" disabled={busy} onClick={async () => { if (await svc('enable')) if (!st.unitActive) await svc('start'); }}>Enable at boot{st.unitActive ? '' : ' and start'}</button>}
                    {!st.unitActive && st.unitEnabled === 'enabled' && <button className="btn primary sm" disabled={busy} onClick={() => svc('start')}>Start</button>}
                    {st.unitActive && <button className="btn sm" disabled={busy} onClick={() => svc('reload')}>Reload</button>}
                    {st.unitActive && <button className="btn sm danger" disabled={busy} onClick={() => setConfirm({ title: 'Stop the firewall?', label: 'Stop', body: 'The inet fips table is removed immediately. Every service listening on all interfaces becomes reachable from any mesh node until the firewall is started again.', run: async () => { await svc('stop'); } })}>Stop</button>}
                    {st.unitEnabled === 'enabled' && <button className="btn sm ghost" disabled={busy} onClick={() => setConfirm({ title: 'Disable at boot?', label: 'Disable', body: 'The firewall keeps running now but will not be loaded after the next reboot.', run: async () => { await svc('disable'); } })}>Disable at boot</button>}
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card title="Allowed inbound (managed by this UI)" hint="Rules stored in /etc/fips/fips.d/fips-ui.nft" actions={!readOnly && <button className="btn sm primary" disabled={busy || !f} onClick={() => setRuleDialog({ index: null, initial: { proto: 'tcp', sources: [{ kind: 'any' }] } })}><Plus size={14} />Add rule</button>} pad={false}>
            {!f ? <div className="p-4"><Skeleton className="h-24 w-full" /></div> : rules.length === 0 ? <Empty>No rules yet. Use Add rule, or Allow next to a listener below.</Empty> : (
              <div className="overflow-x-auto"><table className="data"><thead><tr><th>Proto</th><th>Ports</th><th>From</th><th>Note</th><th /></tr></thead><tbody>
                {rules.map((r, i) => (
                  <tr key={i}>
                    <td className="uppercase text-xs font-medium">{r.proto}</td>
                    <td className="mono">{r.ports}</td>
                    <td><Sources sources={r.sources} /></td>
                    <td className="text-xs text-ink-2">{r.comment}{r.tag === 'mesh-access' && <Chip tone="accent" className="ml-2">remote access</Chip>}</td>
                    <td className="text-right whitespace-nowrap">{!readOnly && r.tag === 'mesh-access' && <a className="text-xs text-ink-3 hover:text-ink" href="#/access">manage on Access</a>}{!readOnly && r.tag !== 'mesh-access' && <>
                      <button className="btn ghost icon sm" title="Edit" onClick={() => setRuleDialog({ index: i, initial: r })}><Pencil size={13} /></button>
                      <button className="btn ghost icon sm" title="Delete" disabled={busy} onClick={() => setConfirm({ title: 'Remove this rule?', label: 'Remove', body: <>Inbound <b>{r.proto} {r.ports}</b> will be dropped again for every source in this rule.</>, run: async () => { await saveRules(rules.filter((_, j) => j !== i), 'Rule removed'); } })}><Trash2 size={13} /></button>
                    </>}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </Card>
        </div>

        <Card title="Listening on fips0" hint="IPv6 listeners the mesh can reach (bound to all interfaces or to fips0) and how the loaded firewall treats them. IPv4-only and loopback listeners are not reachable over fips0 and are not listed." actions={snap.listening && <span className="text-xs text-ink-3">{snap.listening.sockets.length} reachable</span>} pad={false}>
          {!snap.listening ? <Empty>Not available.</Empty> : snap.listening.sockets.length === 0 ? <Empty>No IPv6 listeners reachable from the mesh.</Empty> : (
            <div className="overflow-auto max-h-[26rem]"><table className="data"><thead><tr><th>Proto</th><th>Port</th><th>Process</th><th>Filter</th><th /></tr></thead><tbody>
              {snap.listening.sockets.map((k, i) => (
                <tr key={i}>
                  <td className="uppercase text-xs">{k.proto}</td><td className="tabular">{k.port}</td><td>{k.process ?? '?'}{k.pid ? <span className="text-ink-3"> ({k.pid})</span> : null}</td>
                  <td><Chip tone={k.filter === 'accept' ? 'good' : k.filter === 'no_firewall' ? 'crit' : k.filter === 'drop' ? 'neutral' : 'warn'}>{k.filter === 'accept' ? 'open' : k.filter === 'drop' ? 'filtered' : k.filter === 'no_firewall' ? 'exposed' : k.filter}</Chip></td>
                  <td className="text-right">{!readOnly && k.filter === 'drop' && <button className="btn sm" disabled={busy || !f} onClick={() => setRuleDialog({ index: null, initial: { proto: k.proto === 'udp' ? 'udp' : 'tcp', ports: String(k.port), comment: k.process ? `${k.process}` : undefined, sources: [{ kind: 'any' }] } })}>Allow…</button>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>

        <Card title="Other drop-ins" hint="Files in /etc/fips/fips.d written by other software or by hand" actions={!readOnly && <button className="btn sm" disabled={busy} onClick={() => setDropinEdit({ name: '', content: '', isNew: true })}><Plus size={14} />New drop-in</button>} pad={false}>
          {!f ? <Empty>Loading…</Empty> : others.length === 0 ? <Empty>None.</Empty> : others.map((d) => (
            <div key={d.name} className="border-b border-line last:border-0 px-4 py-3 grid gap-2">
              <div className="flex items-center gap-2"><FileCode2 size={15} className="text-ink-3" /><span className="font-medium mono">{d.name}.nft</span><span className="text-xs text-ink-3">{fmtBytes(d.size)} · changed {fmtAgo(d.mtime)}</span>
                {!readOnly && <div className="ml-auto flex gap-1"><button className="btn sm ghost" onClick={() => setDropinEdit({ name: d.name, content: d.content, isNew: false })}><Pencil size={13} />Edit</button><button className="btn sm ghost" disabled={busy} onClick={() => setConfirm({ title: `Delete ${d.name}.nft?`, label: 'Delete', body: 'The allowances in this file stop applying as soon as the firewall reloads.', run: async () => { await run(() => adminApi.deleteDropin(d.name), `${d.name}.nft deleted`); } })}><Trash2 size={13} /></button></div>}
              </div>
              <pre className="text-xs bg-surface-2 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre">{d.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n') || '(comments only)'}</pre>
            </div>
          ))}
        </Card>
      </HelperGate>

      {ruleDialog && <RuleDialog initial={ruleDialog.initial} isEdit={ruleDialog.index !== null} busy={busy} onClose={() => setRuleDialog(null)} onSave={async (rule) => {
        const next = ruleDialog.index === null ? [...rules, rule] : rules.map((r, i) => (i === ruleDialog.index ? rule : r));
        if (await saveRules(next, ruleDialog.index === null ? 'Rule added' : 'Rule updated')) setRuleDialog(null);
      }} />}
      <Modal open={!!dropinEdit} onClose={() => setDropinEdit(null)} title={dropinEdit?.isNew ? 'New drop-in' : `Edit ${dropinEdit?.name}.nft`} width="max-w-3xl">
        {dropinEdit && <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => adminApi.saveDropin(dropinEdit.name, dropinEdit.content), `${dropinEdit.name}.nft saved`)) setDropinEdit(null); }}>
          {dropinEdit.isNew && <label className="field">Name<input className="input mono" required pattern="[a-z0-9][a-z0-9_\-]{0,40}" value={dropinEdit.name} onChange={(e) => setDropinEdit({ ...dropinEdit, name: e.target.value })} placeholder="services" /></label>}
          <label className="field">Rules (chain context, one per line)<textarea className="input mono h-64 py-2 resize-y" spellCheck={false} value={dropinEdit.content} onChange={(e) => setDropinEdit({ ...dropinEdit, content: e.target.value })} placeholder={'tcp dport 22 accept\nip6 saddr fd97:467a::/64 tcp dport 8443 accept'} /></label>
          <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setDropinEdit(null)}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Validating…' : 'Validate and save'}</button></div>
        </form>}
      </Modal>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} busy={busy} danger title={confirm?.title ?? ''} body={confirm?.body} confirmLabel={confirm?.label} onConfirm={async () => { if (confirm) { await confirm.run(); setConfirm(null); } }} />
    </div>
  );
}

function Sources({ sources }: { sources: RuleSource[] }) {
  if (sources.some((s) => s.kind === 'any')) return <Chip tone="warn">anyone on the mesh</Chip>;
  return <div className="flex flex-wrap gap-1">{sources.map((s, i) => s.kind === 'npub' ? <span key={i} className="chip" title={`${s.npub}\n${s.addr ?? ''}`}>{s.label || shortKey(s.npub, 10, 4)}</span> : s.kind === 'prefix' ? <span key={i} className="chip mono" title={s.prefix}>{s.label || s.prefix}</span> : null)}</div>;
}

type SourceMode = 'any' | 'npubs' | 'prefix';
function RuleDialog({ initial, isEdit, busy, onClose, onSave }: { initial: Partial<FirewallRule>; isEdit: boolean; busy: boolean; onClose: () => void; onSave: (r: FirewallRule) => void }) {
  const init = initial.sources ?? [{ kind: 'any' }];
  const [proto, setProto] = useState<'tcp' | 'udp'>(initial.proto ?? 'tcp');
  const [ports, setPorts] = useState(initial.ports ?? '');
  const [mode, setMode] = useState<SourceMode>(init.some((s) => s.kind === 'npub') ? 'npubs' : init.some((s) => s.kind === 'prefix') ? 'prefix' : 'any');
  const [npubs, setNpubs] = useState(init.filter((s) => s.kind === 'npub').map((s) => (s.kind === 'npub' ? (s.label ? `${s.npub} ${s.label}` : s.npub) : '')).join('\n'));
  const [prefixes, setPrefixes] = useState(init.filter((s) => s.kind === 'prefix').map((s) => (s.kind === 'prefix' ? s.prefix : '')).join('\n'));
  const [comment, setComment] = useState(initial.comment ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    let sources: RuleSource[] = [{ kind: 'any' }];
    try {
      if (mode === 'npubs') {
        setResolving(true);
        const lines = npubs.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) throw new Error('enter at least one npub or hosts-file name');
        sources = await Promise.all(lines.map(async (l) => {
          const [id, ...rest] = l.split(/\s+/);
          const r = await api.get<{ npub: string; display_name?: string }>(`/api/resolve?id=${encodeURIComponent(id)}`);
          return { kind: 'npub' as const, npub: r.npub, label: rest.join(' ') || r.display_name || (id.startsWith('npub1') ? undefined : id) };
        }));
      } else if (mode === 'prefix') {
        const lines = prefixes.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) throw new Error('enter at least one fd00::/8 address or prefix');
        sources = lines.map((p) => ({ kind: 'prefix' as const, prefix: p }));
      }
    } catch (x) { setErr((x as Error).message); setResolving(false); return; }
    setResolving(false);
    onSave({ proto, ports: ports.replace(/\s+/g, ''), sources, comment: comment.trim() || undefined });
  };

  return (
    <Modal open onClose={onClose} title={isEdit ? 'Edit rule' : 'Allow inbound traffic'}>
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid grid-cols-[110px_1fr] gap-3">
          <label className="field">Protocol<select className="input" value={proto} onChange={(e) => setProto(e.target.value as 'tcp' | 'udp')}><option value="tcp">tcp</option><option value="udp">udp</option></select></label>
          <label className="field">Ports<input className="input mono" required value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="22 or 80,443 or 8000-8100" /></label>
        </div>
        <div className="grid gap-2">
          <div className="text-xs text-ink-2 font-medium">From</div>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'any', label: 'Anyone on the mesh' }, { value: 'npubs', label: 'Specific nodes' }, { value: 'prefix', label: 'Address prefix' }]} />
          {mode === 'any' && <p className="text-xs text-warn">Any of the mesh's nodes can connect. Prefer specific nodes unless the service authenticates its users itself.</p>}
          {mode === 'npubs' && <label className="field">One per line: an npub or a hosts-file name, optionally followed by a label<textarea className="input mono h-28 py-2 resize-y" value={npubs} onChange={(e) => setNpubs(e.target.value)} placeholder={'npub1… laptop\ntest-de01'} /></label>}
          {mode === 'prefix' && <label className="field">One per line: an fd00::/8 address or prefix<textarea className="input mono h-24 py-2 resize-y" value={prefixes} onChange={(e) => setPrefixes(e.target.value)} placeholder="fd97:467a::/64" /></label>}
        </div>
        <label className="field">Note<input className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="ssh, web ui, …" maxLength={60} /></label>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || resolving}>{busy || resolving ? 'Validating…' : 'Validate and apply'}</button></div>
      </form>
    </Modal>
  );
}
