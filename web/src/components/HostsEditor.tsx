import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Save, Stethoscope, Trash2, Undo2 } from 'lucide-react';
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

  // With names synced from another node, the node's own (static) entries are folded away unless asked for, being
  // edited, or the target of an "add a name…" link. The choice is remembered in this browser.
  const [showLocal, setShowLocal] = useState(() => { try { return localStorage.getItem('fips-ui-hosts-local-open') === '1'; } catch { return false; } });
  const toggleLocal = (open: boolean) => { setShowLocal(open); try { localStorage.setItem('fips-ui-hosts-local-open', open ? '1' : '0'); } catch { /* storage unavailable */ } };
  const localOpen = !synced || showLocal || dirty || !!prefillNpub;
  /** Whether a name's npub is a direct peer (and how it is connected), this node, or neither. */
  const peerStatus = (npub: string) => {
    const p = peers.find((x) => x.npub === npub);
    return p ? <Chip tone="good">peer · {p.connectivity}</Chip> : npub === snap.status?.npub ? <Chip tone="accent">this node</Chip> : <Chip>not a direct peer</Chip>;
  };
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
            {synced && (
              <div className="border-t border-[var(--border)]">
                <div className="px-4 pt-3 pb-1 text-xs text-ink-3 flex flex-wrap items-center gap-1.5">Synced from the upstream node <NpubInline npub={synced.master} /> · {synced.entries.length} name{synced.entries.length === 1 ? '' : 's'} · read-only here, change them where they come from</div>
                <div className="overflow-auto max-h-[24rem]"><table className="data"><thead><tr><th>Name</th><th>npub</th><th>Status</th>{accessHead}<th /></tr></thead><tbody>
                  {synced.entries.map((h) => (
                    <tr key={h.hostname}><td className="w-48"><Copyable text={h.npub} display={<b>{h.hostname}</b>} mono={false} /></td><td><Copyable text={h.npub} display={shortKey(h.npub, 14, 8)} /></td><td>{peerStatus(h.npub)}</td>{showAccess && <td><AccessCell npub={h.npub} hostname={h.hostname} readOnly={readOnly} /></td>}<td className="text-right"><button className="btn sm ghost" onClick={() => onProbe(h.hostname)}><Stethoscope size={13} />Probe</button></td></tr>
                  ))}
                </tbody></table></div>
              </div>
            )}
            {synced && (
              <button className="flex items-center gap-2 px-4 py-2.5 border-t border-[var(--border)] text-left text-sm hover:bg-[var(--surface-2)]" onClick={() => toggleLocal(!showLocal)} aria-expanded={localOpen}>
                {localOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="font-medium">Local entries</span><span className="text-ink-3">({rows.length})</span>
                <span className="text-xs text-ink-3">{localOpen ? 'this node\'s own names; the synced ones win on duplicates' : 'show'}</span>
              </button>
            )}
            {localOpen && (
              <>
            {rows.length === 0 ? <Empty>No names yet.</Empty> : (
              <div className="overflow-auto max-h-[32rem]"><table className="data"><thead><tr><th>Name</th><th>npub</th><th>Status</th>{accessHead}<th>Note</th><th /></tr></thead><tbody>
                {rows.map((h, i) => { const isNew = !saved.some((s) => s.hostname === h.hostname && s.npub === h.npub); return (
                  <tr key={i}>
                    <td><Copyable text={h.npub} display={<b>{h.hostname}</b>} mono={false} /></td>
                    <td><Copyable text={h.npub} display={shortKey(h.npub, 14, 8)} /></td>
                    <td>{isNew ? <Chip tone="accent">unsaved</Chip> : syncedNames.has(h.hostname) ? <Chip tone="warn" title="The synced entry with this name is the one in effect">overridden by sync</Chip> : peerStatus(h.npub)}</td>
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
              </>
            )}
            {data.write && <FollowersPanel readOnly={readOnly} />}
            {!readOnly && data.write && <SyncPanel peers={peers} />}
          </div>
        )}
      </Card>
    </div>
  );
}

interface SyncConfig { enabled: boolean; master: string; port: number; intervalMin: number }
interface SyncStatus { running: boolean; lastAttempt?: number; lastSuccess?: number; lastChange?: number; received?: number; skipped?: number; error?: string; unreachableSince?: number; nextAttempt?: number; chain?: string[]; chainConfirmed?: boolean }

/** Follow another node: its hosts entries are fetched over the mesh and kept in a synced block of this file. */
function SyncPanel({ peers }: { peers: { npub: string; display_name?: string | null }[] }) {
  const toast = useToast();
  const r = usePoll(() => api.get<{ config: SyncConfig; status: SyncStatus; own?: string; role?: SyncRole }>('/api/hosts/sync'), [], 15000);
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
        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className="accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Sync names from another node</label>
        {r.data.role && r.data.role !== 'none' && <RoleChip role={r.data.role} self />}
        {config.enabled && (status.error ? <Chip tone="crit" title={status.error}>sync failing</Chip> : status.lastSuccess ? <Chip tone="good">synced {fmtAgo(status.lastSuccess)}</Chip> : <Chip>not synced yet</Chip>)}
        {config.enabled && <button className="btn sm ml-auto" disabled={busy || status.running} onClick={() => post('/api/hosts/sync/run', {}, 'Synced from the upstream node')}><RefreshCw size={13} />Sync now</button>}
      </div>
      {draft.enabled && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-ink-3 flex-1 min-w-[280px]">Sync from (npub or name)
            <input className="input mono" list="hosts-sync-master" placeholder="npub1… or a name" value={draft.master} onChange={(e) => setDraft({ ...draft, master: e.target.value.trim() })} />
            <datalist id="hosts-sync-master">{peers.map((p) => <option key={p.npub} value={p.npub}>{p.display_name ?? shortKey(p.npub, 12, 6)}</option>)}</datalist>
          </label>
          <label className="grid gap-1 text-xs text-ink-3">Its UI port<input className="input mono w-24" type="number" min={1} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
          <label className="grid gap-1 text-xs text-ink-3">Every (min)<input className="input mono w-24" type="number" min={1} max={1440} value={draft.intervalMin} onChange={(e) => setDraft({ ...draft, intervalMin: Number(e.target.value) })} /></label>
        </div>
      )}
      {!config.enabled && status.error && <div className="flex items-center gap-2"><ErrorNote>{status.error}</ErrorNote><button className="btn sm shrink-0" disabled={busy} onClick={() => post('/api/hosts/sync/run', {}, 'Synced names removed')}><RefreshCw size={13} />Retry</button></div>}
      {config.enabled && status.error && <ErrorNote>{status.error}{status.unreachableSince ? <> Offline since {fmtAgo(status.unreachableSince)}; the names synced last stay in effect.</> : null}{status.nextAttempt ? <> Next automatic try {fmtIn(status.nextAttempt)}.</> : null}</ErrorNote>}
      {config.enabled && status.chain && status.chain.length > 0 && <SyncChain chain={status.chain} confirmed={!!status.chainConfirmed} failing={!!status.error} />}
      {config.enabled && !status.error && status.lastSuccess && <p className="text-xs text-ink-3">{status.received} name{status.received === 1 ? '' : 's'} from the upstream node{status.skipped ? `, ${status.skipped} invalid left out` : ''}; last change {status.lastChange ? fmtAgo(status.lastChange) : 'none since start'}.</p>}
      <div className="flex items-center gap-2">
        <p className="text-xs text-ink-3 mr-auto">The upstream node's names are fetched over the mesh from its web UI and kept in a marked block at the end of this file; on a duplicate name its entry wins. On that node, enable <b>Web UI over the mesh</b> and add {r.data.own ? <span className="mono">{shortKey(r.data.own, 12, 6)}</span> : "this node's npub"} as a <b>viewer</b>. Turning sync off removes the synced names.</p>
        {dirty && <button className="btn ghost" onClick={() => setDraft(config)}><Undo2 size={14} />Discard</button>}
        <button className="btn primary" disabled={!dirty || busy} onClick={() => post('/api/hosts/sync', draft, draft.enabled ? 'Sync settings saved' : 'Sync turned off')}><Save size={14} />Save</button>
      </div>
    </div>
  );
}

/**
 * Where this node's names come from (nearest first in `chain`): the master node at the top, the distribution nodes
 * in between, and the parent this node syncs from (itself a distribution node, or the master).
 */
function SyncChain({ chain, confirmed, failing }: { chain: string[]; confirmed: boolean; failing: boolean }) {
  const path = [...chain].reverse();
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" aria-label="Sync hierarchy">
      <span className="text-ink-3 mr-1">Names flow</span>
      {/* Only the upstream node's own report shows what is above it; otherwise just that node is known. */}
      {!confirmed && <span className="text-ink-3 inline-flex items-center gap-1.5" title={failing ? 'Known again after the next successful sync' : 'A node further up could not confirm where its names come from (its own sync is failing, or it runs an older fips-ui)'}>{failing ? 'upstream unknown' : 'further up not confirmed'}<ChevronRight size={13} /></span>}
      {path.map((n, i) => (
        <span key={n} className="inline-flex items-center gap-1.5">
          <span className="rounded-md bg-surface-2 px-2 py-0.5 inline-flex items-center gap-1.5">
            <NpubInline npub={n} head={8} tail={4} />
            {confirmed && <RoleChip role={i === 0 ? 'master' : 'distribution'} />}
            {i === path.length - 1 && <Chip title="This node syncs from here">parent</Chip>}
          </span>
          <ChevronRight size={13} className="text-ink-3" />
        </span>
      ))}
      <span className="rounded-md border border-[var(--border)] px-2 py-0.5">this node</span>
    </div>
  );
}

type SyncRole = 'master' | 'distribution' | 'follower' | 'none';
const ROLES: Record<Exclude<SyncRole, 'none'>, { label: string; title: string; tone: 'accent' | 'neutral' }> = {
  master: { label: 'master node', title: 'The origin of the names: other nodes sync from it, it syncs from no one', tone: 'accent' },
  distribution: { label: 'distribution node', title: 'Syncs its names from another node and passes them on to the nodes that sync from it', tone: 'neutral' },
  follower: { label: 'follower', title: 'Syncs its names from another node; no node syncs from it', tone: 'neutral' },
};
/** A node's place in the sync tree (server/hosts-followers.ts syncRole). */
function RoleChip({ role, self = false }: { role: Exclude<SyncRole, 'none'>; self?: boolean }) {
  const r = ROLES[role];
  return <Chip tone={r.tone} title={r.title}>{self ? `this node: ${r.label}` : r.label}</Chip>;
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

interface Follower { npub: string; address: string; firstSeen: number; lastSeen: number; count: number; entries: number; version?: string; intervalMin?: number; below?: { npub: string; parent: string }[]; belowMore?: number }

/** On a master or distribution node: the nodes that sync their hosts names from this one, when they last did, and the tree below them. */
function FollowersPanel({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const r = usePoll(() => api.get<{ followers: Follower[] }>('/api/hosts/followers'), [], 30000);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const list = r.data?.followers ?? [];
  if (!list.length) return null;
  const forget = async (npub: string) => {
    try { await api.post('/api/hosts/followers/forget', { npub }); r.refresh(); } catch (x) { toast('err', (x as Error).message); }
  };
  // Overdue after three missed intervals (5 minutes when the follower does not report its interval).
  const isOverdue = (f: Follower) => Date.now() - f.lastSeen > 3 * (f.intervalMin ?? 5) * 60_000;
  // A follower that stopped syncing here but appears below a node that still syncs has moved there (it switched its
  // upstream node): shown as moved, not as overdue, and counted once.
  const movedUnder = new Map<string, Follower>();
  for (const f of list) if (!isOverdue(f)) for (const n of f.below ?? []) if (!movedUnder.has(n.npub)) movedUnder.set(n.npub, f);
  // The whole tree as this node reports it upward (server/hosts-followers.ts subtreeHeader): what followers that still
  // sync report below them; an overdue follower counts only itself, and not at all once it moved.
  const tree = new Set<string>();
  let more = 0;
  for (const f of list) {
    if (isOverdue(f)) { if (!movedUnder.has(f.npub)) tree.add(f.npub); continue; }
    tree.add(f.npub);
    for (const n of f.below ?? []) tree.add(n.npub);
    more += f.belowMore ?? 0;
  }
  const total = tree.size + more;
  const toggle = (npub: string) => setOpen((o) => { const n = new Set(o); if (n.has(npub)) n.delete(npub); else n.add(npub); return n; });
  return (
    <div className="border-t border-[var(--border)]">
      <div className="px-4 pt-3 pb-1 text-xs text-ink-3">Nodes syncing their names from this node · {list.length} direct{total > list.length ? `, ${total} in the whole tree` : ''}</div>
      <div className="overflow-auto max-h-[24rem]"><table className="data"><thead><tr><th>Node</th><th>Last sync</th><th>Names</th><th>Every</th><th>fips-ui</th><th /></tr></thead><tbody>
        {list.map((f) => {
          const overdue = isOverdue(f);
          const movedTo = overdue ? movedUnder.get(f.npub) : undefined;
          // Its role as it reported it on its last sync; a node that stopped syncing is not shown as passing names on.
          const below = (f.below?.length ?? 0) + (f.belowMore ?? 0);
          const isOpen = open.has(f.npub);
          return (
            <FollowerRows key={f.npub} f={f} isOpen={isOpen}>
              <tr>
                <td>
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    {(f.below?.length ?? 0) > 0 ? <button className="btn ghost icon sm -ml-1" aria-expanded={isOpen} title={isOpen ? 'Hide the nodes below' : 'Show the nodes below'} onClick={() => toggle(f.npub)}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="w-6" />}
                    <NpubInline npub={f.npub} />
                    {below > 0 && !overdue && <><RoleChip role="distribution" /><Chip title="Nodes syncing from this one, directly or further down, as it reports them">{below} below</Chip></>}
                  </span>
                </td>
                <td>{movedTo ? <span className="inline-flex items-center gap-1.5 text-xs text-ink-3" title={`Last synced from this node ${fmtAgo(f.lastSeen)}; it now syncs below another node. Forget removes this entry.`}><Chip>moved</Chip>under <NpubInline npub={movedTo.npub} head={8} tail={4} /></span> : overdue ? <Chip tone="warn" title={`${f.count} syncs since ${new Date(f.firstSeen).toLocaleString()}`}>{fmtAgo(f.lastSeen)}</Chip> : <Chip tone="good" title={`${f.count} syncs since ${new Date(f.firstSeen).toLocaleString()}`}>{fmtAgo(f.lastSeen)}</Chip>}</td>
                <td className="tabular">{f.entries}</td>
                <td className="text-xs text-ink-3">{f.intervalMin ? `${f.intervalMin} min` : '–'}</td>
                <td className="text-xs text-ink-3" title={f.below === undefined ? 'Reports no subtree (older fips-ui)' : undefined}>{f.version ?? 'older'}</td>
                <td className="text-right">{!readOnly && <button className="btn ghost icon sm" title="Forget (it reappears on its next sync)" onClick={() => void forget(f.npub)}><Trash2 size={13} /></button>}</td>
              </tr>
            </FollowerRows>
          );
        })}
      </tbody></table></div>
    </div>
  );
}

/** A follower's row and, when opened, the nodes below it (as it reported them), indented by depth. */
function FollowerRows({ f, isOpen, children }: { f: Follower; isOpen: boolean; children: React.ReactNode }) {
  const rows = useMemo(() => {
    if (!isOpen || !f.below?.length) return [];
    const kids = new Map<string, string[]>();
    for (const n of f.below) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.npub]);
    const out: { npub: string; depth: number; parent: string; relays: boolean }[] = [];
    const walk = (p: string, depth: number) => { for (const k of kids.get(p) ?? []) { out.push({ npub: k, depth, parent: p, relays: kids.has(k) }); walk(k, depth + 1); } };
    walk(f.npub, 1);
    return out;
  }, [f, isOpen]);
  return (
    <>
      {children}
      {rows.map((n) => (
        <tr key={n.npub} className="text-ink-2">
          <td><span className="inline-flex items-center gap-1.5 min-w-0" style={{ paddingLeft: `${n.depth * 1.25}rem` }}><span className="text-ink-3">└</span><NpubInline npub={n.npub} head={8} tail={4} />{n.relays && <RoleChip role="distribution" />}</span></td>
          <td colSpan={5} className="text-xs text-ink-3">syncs from <NpubInline npub={n.parent} head={8} tail={4} /> · reported by <NpubInline npub={f.npub} head={8} tail={4} /></td>
        </tr>
      ))}
      {isOpen && !!f.belowMore && <tr><td colSpan={6} className="text-xs text-ink-3" style={{ paddingLeft: '2.5rem' }}>and {f.belowMore} more not reported</td></tr>}
    </>
  );
}
