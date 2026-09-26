import { useEffect, useState } from 'react';
import { Globe, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { Card, Chip, Copyable, Empty, ErrorNote, useToast } from './ui';
import { api, usePoll } from '../lib/api';
import { shortKey } from '../lib/format';
import type { Principal } from '../lib/types';

type Role = 'viewer' | 'admin';
interface Entry { npub: string; label?: string; role: Role }
interface Config { enabled: boolean; port: number; allowed: Entry[] }
interface Status { listening: boolean; address: string | null; npub: string | null; port: number; guard?: { active: boolean; ports: number[]; error?: string }; error?: string }
interface AccessResponse { config?: Config; status?: Status; file?: string; you: Principal; firewallManaged?: boolean }
interface SaveResponse { config: Config; status: Status; firewall: { ok: boolean; skipped?: string; guard?: string; rule?: string } }

export function RemoteAccess({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const r = usePoll(() => api.get<AccessResponse>('/api/access'), [], 10000);
  const [draft, setDraft] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState({ id: '', label: '', role: 'viewer' as Role });
  const [lastFw, setLastFw] = useState<SaveResponse['firewall'] | null>(null);
  const data = r.data;
  useEffect(() => { if (data?.config && !draft) setDraft(data.config); }, [data?.config, draft]);

  if (!data) return <Card title="Web UI over the mesh">{r.error ? <ErrorNote>{r.error}</ErrorNote> : <Empty>Loading…</Empty>}</Card>;
  const you = data.you;
  if (!data.config || !draft) {
    return <Card title="Web UI over the mesh"><div className="text-sm text-ink-2">You are connected {you.kind === 'mesh' ? <>over the mesh as <b>{you.label || shortKey(you.npub, 12, 6)}</b> with <b>{you.role}</b> access</> : 'locally'}. Only admins can see or change who else has access.</div></Card>;
  }
  const saved = data.config;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const st = data.status!;
  const selfRemoved = you.kind === 'mesh' && !draft.allowed.some((e) => e.npub === you.npub && e.role === 'admin');

  const addEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = add.id.trim();
    if (!id) return;
    try {
      const res = await api.get<{ npub: string; display_name?: string }>(`/api/resolve?id=${encodeURIComponent(id)}`);
      if (draft.allowed.some((x) => x.npub === res.npub)) { toast('info', 'Already on the list'); return; }
      setDraft({ ...draft, allowed: [...draft.allowed, { npub: res.npub, role: add.role, label: add.label.trim() || res.display_name || (id.startsWith('npub1') ? undefined : id) }] });
      setAdd({ id: '', label: '', role: add.role });
    } catch (x) { toast('err', (x as Error).message); }
  };
  const save = async () => {
    setBusy(true); setLastFw(null);
    try {
      const res = await api.post<SaveResponse>('/api/access', draft);
      setDraft(res.config); setLastFw(res.firewall); r.refresh();
      toast(res.firewall.ok ? 'ok' : 'info', res.firewall.ok ? 'Access saved; guard and firewall rule updated' : `Access saved; ${res.firewall.skipped ?? res.firewall.guard ?? res.firewall.rule ?? 'not fully applied yet'}`);
    } catch (x) { toast('err', (x as Error).message); }
    finally { setBusy(false); }
  };

  const urls = st.address ? [`http://[${st.address}]:${draft.port}`, ...(st.npub ? [`http://${st.npub}.fips:${draft.port}`] : [])] : [];

  return (
    <Card title="Web UI over the mesh" hint="Other FIPS nodes can open this dashboard at this node's mesh address. The npub of each connection is established by the mesh itself, so there is no password: only the npubs listed here get in."
      actions={!readOnly && <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className="accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Enabled</label>}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Globe size={16} className="text-ink-3" />
          {!saved.enabled ? <Chip>off</Chip> : st.listening ? <Chip tone="good">listening</Chip> : <Chip tone="crit">not listening</Chip>}
          {saved.enabled && <Chip tone={st.guard?.active ? 'good' : 'crit'} title="Kernel rule that only lets mesh source addresses reach the UI through the FIPS interface">{st.guard?.active ? 'spoofing guard on' : 'spoofing guard off'}</Chip>}
          {saved.enabled && st.error && <span className="text-crit text-xs">{st.error}</span>}
          {you.kind === 'mesh' && <span className="text-xs text-ink-3 ml-auto">you: {you.label || shortKey(you.npub, 10, 4)} · {you.role}</span>}
        </div>
        {saved.enabled && urls.length > 0 && <div className="grid gap-1">{urls.map((u) => <Copyable key={u} text={u} className="text-xs rounded-md bg-surface-2 px-2.5 py-1.5 w-fit max-w-full" />)}</div>}

        <div className="grid gap-2">
          <div className="flex items-center justify-between"><div className="card-title">Allowed npubs ({draft.allowed.length})</div>
            <label className="flex items-center gap-2 text-xs text-ink-2">Port<input className="input h-8 w-24 mono" type="number" min={1} max={65535} disabled={readOnly} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
          </div>
          {draft.allowed.length === 0 ? <div className="text-sm text-ink-3 py-2">Nobody yet. With an empty list the listener refuses every connection.</div> : (
            <div className="overflow-x-auto -mx-1"><table className="data"><tbody>
              {draft.allowed.map((e, i) => (
                <tr key={e.npub}>
                  <td><div className="font-medium">{e.label || <span className="text-ink-3">no label</span>}</div><Copyable text={e.npub} display={shortKey(e.npub, 14, 6)} className="text-[11px] text-ink-3" /></td>
                  <td>{readOnly ? <Chip tone={e.role === 'admin' ? 'accent' : 'neutral'}>{e.role}</Chip> : <select className="input h-8 w-auto" value={e.role} onChange={(x) => setDraft({ ...draft, allowed: draft.allowed.map((y, j) => (j === i ? { ...y, role: x.target.value as Role } : y)) })}><option value="viewer">viewer</option><option value="admin">admin</option></select>}</td>
                  <td className="text-right">{!readOnly && <button className="btn ghost icon sm" title="Remove" onClick={() => setDraft({ ...draft, allowed: draft.allowed.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          {!readOnly && (
            <form className="flex flex-wrap gap-2" onSubmit={addEntry}>
              <input className="input mono flex-1 min-w-[220px]" placeholder="npub1… or hosts-file name" value={add.id} onChange={(e) => setAdd({ ...add, id: e.target.value })} />
              <input className="input w-36" placeholder="label" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} maxLength={40} />
              <select className="input w-28" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as Role })}><option value="viewer">viewer</option><option value="admin">admin</option></select>
              <button className="btn"><Plus size={14} />Add</button>
            </form>
          )}
          <p className="text-xs text-ink-3"><b>Viewer</b>: everything read-only, no configuration, firewall or upgrade pages. <b>Admin</b>: the same rights as someone on this machine, including changing the node's configuration and firewall as root. Grant it only to npubs whose keys you trust as much as this host's own login. An npub is a whole node: all of its local users and, if it runs fips-gateway, its LAN clients share the grant.</p>
        </div>

        {selfRemoved && <ErrorNote>Saving removes your own admin access; this page will stop working for you over the mesh.</ErrorNote>}
        {lastFw && !lastFw.ok && <ErrorNote>Not fully applied: {[lastFw.skipped, lastFw.guard && `guard: ${lastFw.guard}`, lastFw.rule && `firewall rule: ${lastFw.rule}`].filter(Boolean).join('; ')}. The UI retries every 15 seconds.</ErrorNote>}
        {!data.firewallManaged && draft.enabled && <ErrorNote>Mesh access needs the privileged helper (v5): it installs the kernel rule that makes mesh source addresses trustworthy. Until it is installed nobody is admitted from the mesh. Run <code>sudo ./deploy/setup-local.sh</code>.</ErrorNote>}

        {!readOnly && (
          <div className="flex justify-end gap-2">
            {dirty && <button className="btn ghost" onClick={() => setDraft(saved)}><Undo2 size={14} />Discard</button>}
            <button className="btn primary" disabled={!dirty || busy} onClick={save}><Save size={14} />{busy ? 'Saving…' : 'Save'}</button>
          </div>
        )}
      </div>
    </Card>
  );
}
