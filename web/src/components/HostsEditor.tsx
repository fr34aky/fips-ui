import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Save, Stethoscope, Trash2, Undo2 } from 'lucide-react';
import { Card, Chip, ConfirmDialog, Copyable, Empty, ErrorNote, useToast } from './ui';
import { api, usePoll } from '../lib/api';
import { NpubInline } from './PeerName';
import { saveAccess, saveMessage, useAccess, type Role } from '../lib/access';
import { fmtAgo } from '../lib/format';
import { shortKey } from '../lib/format';
import { refreshHosts, setHosts, useHosts, type HostsData } from '../lib/names';
import type { Snapshot } from '../lib/types';

type Row = { hostname: string; npub: string; comment?: string };
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;

/**
 * The FIPS hosts file: names resolved as <name>.fips on this node and shown next to npubs throughout the UI.
 * The daemon reloads the file on its next DNS query, so a save takes effect without a restart.
 */
export function HostsEditor({ snap, onProbe, readOnly, prefillNpub }: { snap: Snapshot; onProbe: (peer: string) => void; readOnly: boolean; prefillNpub?: string | null }) {
  const toast = useToast();
  const { data, error } = useHosts();
  const [draft, setDraft] = useState<Row[] | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [add, setAdd] = useState({ hostname: '', npub: prefillNpub ?? '' });
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const peers = snap.peers?.peers ?? [];
  // Admins see and change each name's web UI access ("Web UI over the mesh"); others get no column.
  const access = useAccess().data;
  const showAccess = !!access?.config;
  const accessHead = showAccess && <th title="Web UI over the mesh: which of these npubs may open this dashboard">Web UI{access!.config!.enabled ? '' : ' (off)'}</th>;

  // Adopt the file whenever it changes on disk and nothing is being edited.
  const saved: Row[] = useMemo(() => (data?.local ?? data?.entries)?.map((e) => ({ hostname: e.hostname, npub: e.npub, comment: e.comment })) ?? [], [data]);
  const synced = data?.synced ?? null;
  const syncedNames = useMemo(() => new Set(synced?.entries.map((e) => e.hostname) ?? []), [synced]);
  const dirty = draft !== null && JSON.stringify(draft.map(strip)) !== JSON.stringify(saved.map(strip));
  useEffect(() => { if (data && (!dirty || base === null)) { setDraft(saved); setBase(data.base); } }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!prefillNpub) return;
    setAdd((a) => ({ ...a, npub: prefillNpub }));
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => nameInput.current?.focus(), 300);
  }, [prefillNpub]);

  const mode = data?.write?.mode ?? null;
  const editable = !readOnly && !!mode;
  const rows = draft ?? saved;
  const suggestions = useMemo(() => peers.filter((p) => !rows.some((r) => r.npub === p.npub)), [peers, rows]);

  const addEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const hostname = add.hostname.trim().toLowerCase();
    let npub = add.npub.trim();
    if (!NAME_RE.test(hostname)) { toast('err', 'Names use lowercase letters, digits and hyphens (at most 63, no hyphen at either end)'); return; }
    if (rows.some((r) => r.hostname === hostname)) { toast('err', `${hostname} is already on the list`); return; }
    if (!NPUB_RE.test(npub)) {
      // Also accept a peer's current display name.
      try { npub = (await api.get<{ npub: string }>(`/api/resolve?id=${encodeURIComponent(npub)}`)).npub; }
      catch { toast('err', 'Enter an npub (npub1…) or the name of a connected peer'); return; }
    }
    // An npub that already has a name is renamed (the "change…" link on a peer lands here).
    const existing = rows.findIndex((r) => r.npub === npub);
    if (existing >= 0) { toast('info', `${rows[existing].hostname} renamed to ${hostname}`); setDraft(rows.map((r, j) => (j === existing ? { hostname, npub } : r))); }
    else setDraft([...rows, { hostname, npub }]);
    setAdd({ hostname: '', npub: '' });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api.post<HostsData>('/api/hosts', { entries: draft.map(({ hostname, npub }) => ({ hostname, npub })), base });
      setHosts(r); setDraft((r.local ?? r.entries).map((x) => ({ ...x }))); setBase(r.base);
      toast('ok', 'Hosts file saved; the daemon picks it up on the next lookup');
    } catch (x) {
      toast('err', (x as Error).message);
      if (/changed since/.test((x as Error).message)) { const d = await refreshHosts(); if (d) { setDraft((d.local ?? d.entries).map((e) => ({ ...e }))); setBase(d.base); } }
    } finally { setBusy(false); }
  };

  return (
    <div ref={ref} className="scroll-mt-4">
      <Card title="Hosts file" hint="Names for npubs, resolved as <name>.fips on this node and shown next to npubs throughout this UI. The daemon reloads the file on its next lookup; no restart needed."
        actions={data && <span className="text-xs text-ink-3 mono">{data.path}</span>} pad={false}>
        {error ? <div className="p-4"><ErrorNote>{error}</ErrorNote></div> : !data ? <Empty>Loading…</Empty> : (
          <div className="grid">
            {data.error && <div className="p-4"><ErrorNote>{data.error}</ErrorNote></div>}
            {rows.length === 0 ? <Empty>No names yet.</Empty> : (
              <div className="overflow-auto max-h-[32rem]"><table className="data"><thead><tr><th>Name</th><th>npub</th><th>Status</th>{accessHead}<th>Note</th><th /></tr></thead><tbody>
                {rows.map((h, i) => { const p = peers.find((x) => x.npub === h.npub); const isNew = !saved.some((s) => s.hostname === h.hostname && s.npub === h.npub); return (
                  <tr key={i}>
                    <td><Copyable text={`${h.hostname}.fips`} display={<b>{h.hostname}</b>} mono={false} /></td>
                    <td><Copyable text={h.npub} display={shortKey(h.npub, 14, 8)} /></td>
                    <td>{isNew ? <Chip tone="accent">unsaved</Chip> : syncedNames.has(h.hostname) ? <Chip tone="warn" title="The master's entry with this name is the one in effect">overridden by master</Chip> : p ? <Chip tone="good">peer · {p.connectivity}</Chip> : h.npub === snap.status?.npub ? <Chip tone="accent">this node</Chip> : <Chip>not a direct peer</Chip>}</td>
                    {showAccess && <td><AccessCell npub={h.npub} hostname={h.hostname} readOnly={readOnly} /></td>}
                    <td className="text-xs text-ink-3 max-w-[320px] truncate" title={h.comment}>{h.comment}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="btn sm ghost" onClick={() => onProbe(h.hostname)} disabled={isNew}><Stethoscope size={13} />Probe</button>
                      {editable && <button className="btn ghost icon sm" title="Remove" onClick={() => setDraft(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>}
                    </td>
                  </tr>
                ); })}
              </tbody></table></div>
            )}
            {synced && (
              <div className="border-t border-[var(--border)]">
                <div className="px-4 pt-3 pb-1 text-xs text-ink-3 flex flex-wrap items-center gap-1.5">Synced from the master <NpubInline npub={synced.master} /> · {synced.entries.length} name{synced.entries.length === 1 ? '' : 's'} · read-only here, change them on the master</div>
                <div className="overflow-auto max-h-[24rem]"><table className="data"><tbody>
                  {synced.entries.map((h) => (
                    <tr key={h.hostname}><td className="w-48"><Copyable text={`${h.hostname}.fips`} display={<b>{h.hostname}</b>} mono={false} /></td><td><Copyable text={h.npub} display={shortKey(h.npub, 14, 8)} /></td>{showAccess && <td><AccessCell npub={h.npub} hostname={h.hostname} readOnly={readOnly} /></td>}<td className="text-right"><button className="btn sm ghost" onClick={() => onProbe(h.hostname)}><Stethoscope size={13} />Probe</button></td></tr>
                  ))}
                </tbody></table></div>
              </div>
            )}
            {!readOnly && data.write && !mode && <div className="px-4 pt-3"><ErrorNote>{data.write.hint}</ErrorNote></div>}
            {editable && (
              <div className="grid gap-3 p-4 border-t border-[var(--border)]">
                <form className="flex flex-wrap gap-2" onSubmit={addEntry}>
                  <input ref={nameInput} className="input w-44 mono" placeholder="name" value={add.hostname} onChange={(e) => setAdd({ ...add, hostname: e.target.value.toLowerCase() })} maxLength={63} />
                  <input className="input mono flex-1 min-w-[260px]" placeholder="npub1… or a connected peer" list="hosts-peer-suggestions" value={add.npub} onChange={(e) => setAdd({ ...add, npub: e.target.value })} />
                  <datalist id="hosts-peer-suggestions">{suggestions.map((p) => <option key={p.npub} value={p.npub}>{p.display_name ?? shortKey(p.npub, 12, 6)}</option>)}</datalist>
                  <button className="btn"><Plus size={14} />Add</button>
                </form>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-xs text-ink-3 mr-auto">{mode === 'helper' ? 'Saved as root through the privileged helper; the previous file is kept as a backup.' : `Written directly to ${data.path}.`} Comments in the file are kept.</span>
                  {dirty && <button className="btn ghost" onClick={() => setDraft(saved)}><Undo2 size={14} />Discard</button>}
                  <button className="btn primary" disabled={!dirty || busy} onClick={save}><Save size={14} />{busy ? 'Saving…' : 'Save'}</button>
                </div>
              </div>
            )}
            {!readOnly && data.write && <SyncPanel peers={peers} />}
          </div>
        )}
      </Card>
    </div>
  );
}

interface SyncConfig { enabled: boolean; master: string; port: number; intervalMin: number }
interface SyncStatus { running: boolean; lastAttempt?: number; lastSuccess?: number; lastChange?: number; received?: number; skipped?: number; error?: string; unreachableSince?: number; nextAttempt?: number }

/** Follow a master node: its hosts entries are fetched over the mesh and kept in a synced block of this file. */
function SyncPanel({ peers }: { peers: { npub: string; display_name?: string | null }[] }) {
  const toast = useToast();
  const r = usePoll(() => api.get<{ config: SyncConfig; status: SyncStatus; own?: string }>('/api/hosts/sync'), [], 15000);
  const [draft, setDraft] = useState<SyncConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (r.data && !draft) setDraft(r.data.config); }, [r.data, draft]);
  if (!r.data || !draft) return null;
  const { config, status } = r.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const post = async (path: string, body: unknown, ok: string) => {
    setBusy(true);
    try {
      const res = await api.post<{ config: SyncConfig; status: SyncStatus }>(path, body);
      setDraft(res.config); r.refresh(); void refreshHosts();
      toast(res.status.error ? 'err' : 'ok', res.status.error ?? ok);
    } catch (x) { toast('err', (x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="grid gap-3 p-4 border-t border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className="accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Sync names from a master node</label>
        {config.enabled && (status.error ? <Chip tone="crit" title={status.error}>sync failing</Chip> : status.lastSuccess ? <Chip tone="good">synced {fmtAgo(status.lastSuccess)}</Chip> : <Chip>not synced yet</Chip>)}
        {config.enabled && <button className="btn sm ml-auto" disabled={busy || status.running} onClick={() => post('/api/hosts/sync/run', {}, 'Synced from the master')}><RefreshCw size={13} />Sync now</button>}
      </div>
      {draft.enabled && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-ink-3 flex-1 min-w-[280px]">Master (npub or name)
            <input className="input mono" list="hosts-sync-master" placeholder="npub1… or a name" value={draft.master} onChange={(e) => setDraft({ ...draft, master: e.target.value.trim() })} />
            <datalist id="hosts-sync-master">{peers.map((p) => <option key={p.npub} value={p.npub}>{p.display_name ?? shortKey(p.npub, 12, 6)}</option>)}</datalist>
          </label>
          <label className="grid gap-1 text-xs text-ink-3">Its UI port<input className="input mono w-24" type="number" min={1} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
          <label className="grid gap-1 text-xs text-ink-3">Every (min)<input className="input mono w-24" type="number" min={1} max={1440} value={draft.intervalMin} onChange={(e) => setDraft({ ...draft, intervalMin: Number(e.target.value) })} /></label>
        </div>
      )}
      {!config.enabled && status.error && <div className="flex items-center gap-2"><ErrorNote>{status.error}</ErrorNote><button className="btn sm shrink-0" disabled={busy} onClick={() => post('/api/hosts/sync/run', {}, 'Synced names removed')}><RefreshCw size={13} />Retry</button></div>}
      {config.enabled && status.error && <ErrorNote>{status.error}{status.unreachableSince ? <> Offline since {fmtAgo(status.unreachableSince)}; the names synced last stay in effect.</> : null}{status.nextAttempt ? <> Next automatic try {fmtIn(status.nextAttempt)}.</> : null}</ErrorNote>}
      {config.enabled && !status.error && status.lastSuccess && <p className="text-xs text-ink-3">{status.received} name{status.received === 1 ? '' : 's'} from the master{status.skipped ? `, ${status.skipped} invalid left out` : ''}; last change {status.lastChange ? fmtAgo(status.lastChange) : 'none since start'}.</p>}
      <div className="flex items-center gap-2">
        <p className="text-xs text-ink-3 mr-auto">The master's names are fetched over the mesh from its web UI and kept in a marked block at the end of this file; on a duplicate name the master's entry wins. On the master, enable <b>Web UI over the mesh</b> and add {r.data.own ? <span className="mono">{shortKey(r.data.own, 12, 6)}</span> : "this node's npub"} as a <b>viewer</b>. Turning sync off removes the synced names.</p>
        {dirty && <button className="btn ghost" onClick={() => setDraft(config)}><Undo2 size={14} />Discard</button>}
        <button className="btn primary" disabled={!dirty || busy} onClick={() => post('/api/hosts/sync', draft, draft.enabled ? 'Sync settings saved' : 'Sync turned off')}><Save size={14} />Save</button>
      </div>
    </div>
  );
}

const strip = (r: Row) => ({ hostname: r.hostname, npub: r.npub });

/** "in 5 min", "in 23 h" for a future timestamp. */
function fmtIn(ts: number): string {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return s < 90 ? 'in a minute' : s < 5400 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`;
}

/** One name's web UI access: not allowed, viewer or admin. Changing it saves the allowed list at once. */
function AccessCell({ npub, hostname, readOnly }: { npub: string; hostname: string; readOnly: boolean }) {
  const toast = useToast();
  const { data } = useAccess();
  const [busy, setBusy] = useState(false);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const cfg = data?.config;
  if (!cfg) return null;
  const entry = cfg.allowed.find((e) => e.npub === npub);
  if (data.status?.npub === npub) return <span className="text-xs text-ink-3">this node</span>;
  if (readOnly) return entry ? <Chip tone={entry.role === 'admin' ? 'accent' : 'neutral'}>{entry.role}</Chip> : <span className="text-xs text-ink-3">not allowed</span>;
  const set = async (role: Role | 'none') => {
    const you = data.you;
    if (you.kind === 'mesh' && you.npub === npub && role !== 'admin') { toast('err', 'That would remove your own admin access; change it in the list under Web UI over the mesh'); return; }
    const allowed = role === 'none' ? cfg.allowed.filter((e) => e.npub !== npub)
      : entry ? cfg.allowed.map((e) => (e.npub === npub ? { ...e, role } : e))
        : [...cfg.allowed, { npub, role, label: hostname }];
    setBusy(true);
    try {
      const res = await saveAccess({ ...cfg, allowed });
      const m = saveMessage(res);
      toast(m.tone, `${hostname}: ${role === 'none' ? 'no web UI access' : `${role} access`}${m.tone === 'ok' ? '' : ` (${m.text.replace(/^Access saved; /, '')})`}`);
    } catch (x) { toast('err', (x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <select className={`input h-8 w-32 ${entry ? '' : 'text-ink-3'}`} aria-label={`Web UI access for ${hostname}`} value={entry?.role ?? 'none'} disabled={busy}
        onChange={(e) => { const role = e.target.value as Role | 'none'; if (role === 'admin') setConfirmAdmin(true); else void set(role); }}>
        <option value="none">not allowed</option>
        <option value="viewer">viewer</option>
        <option value="admin">admin</option>
      </select>
      <ConfirmDialog open={confirmAdmin} onClose={() => setConfirmAdmin(false)} onConfirm={async () => { setConfirmAdmin(false); await set('admin'); }} busy={busy} danger
        title={`Give ${hostname} admin access?`} confirmLabel="Give admin access"
        body={<>Admin over the mesh has the same rights as someone on this machine, including changing the node's configuration and firewall as root. Grant it only to an npub whose key you trust as much as this host's own login; every local user of that node shares the grant.</>} />
    </>
  );
}
