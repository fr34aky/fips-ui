import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Stethoscope, Trash2, Undo2 } from 'lucide-react';
import { Card, Chip, Copyable, Empty, ErrorNote, useToast } from './ui';
import { api } from '../lib/api';
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

  // Adopt the file whenever it changes on disk and nothing is being edited.
  const saved: Row[] = useMemo(() => data?.entries.map((e) => ({ hostname: e.hostname, npub: e.npub, comment: e.comment })) ?? [], [data]);
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
    setDraft([...rows, { hostname, npub }]);
    setAdd({ hostname: '', npub: '' });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api.post<HostsData>('/api/hosts', { entries: draft.map(({ hostname, npub }) => ({ hostname, npub })), base });
      setHosts(r); setDraft(r.entries.map((x) => ({ ...x }))); setBase(r.base);
      toast('ok', 'Hosts file saved; the daemon picks it up on the next lookup');
    } catch (x) {
      toast('err', (x as Error).message);
      if (/changed since/.test((x as Error).message)) { const d = await refreshHosts(); if (d) { setDraft(d.entries.map((e) => ({ ...e }))); setBase(d.base); } }
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
              <div className="overflow-auto max-h-[32rem]"><table className="data"><thead><tr><th>Name</th><th>npub</th><th>Status</th><th>Note</th><th /></tr></thead><tbody>
                {rows.map((h, i) => { const p = peers.find((x) => x.npub === h.npub); const isNew = !saved.some((s) => s.hostname === h.hostname && s.npub === h.npub); return (
                  <tr key={i}>
                    <td><Copyable text={`${h.hostname}.fips`} display={<b>{h.hostname}</b>} mono={false} /></td>
                    <td><Copyable text={h.npub} display={shortKey(h.npub, 14, 8)} /></td>
                    <td>{isNew ? <Chip tone="accent">unsaved</Chip> : p ? <Chip tone="good">peer · {p.connectivity}</Chip> : h.npub === snap.status?.npub ? <Chip tone="accent">this node</Chip> : <Chip>not a direct peer</Chip>}</td>
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
          </div>
        )}
      </Card>
    </div>
  );
}

const strip = (r: Row) => ({ hostname: r.hostname, npub: r.npub });
