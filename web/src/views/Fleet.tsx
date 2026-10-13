import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, ExternalLink, Plus, RefreshCw, Save, Trash2, Undo2, UserPlus } from 'lucide-react';
import { Card, Chip, ConfirmDialog, Copyable, Empty, ErrorNote, KV, useToast } from '../components/ui';
import { NpubInline } from '../components/PeerName';
import { api, usePoll } from '../lib/api';
import { fleetApi, phaseInfo, type FleetConfig, type FleetData, type FleetNodeStatus, type SyncResult } from '../lib/fleet';
import { fmtAgo, fmtDuration, fmtNum, shortKey } from '../lib/format';
import { useHosts } from '../lib/names';
import { hashFor } from '../lib/route';
import { isAdmin, NPUB_RE, type Snapshot } from '../lib/types';

/**
 * The node manager: other fips nodes whose fips-ui this node reaches over the mesh, each listing this node's npub
 * as an admin. The overview is what the backend last learned from them (server/fleet.ts); the list of nodes and
 * of standby managers is edited below it.
 */
export function Fleet({ snap }: { snap: Snapshot }) {
  const toast = useToast();
  const r = usePoll(() => fleetApi.get(), [], 10_000);
  const [probing, setProbing] = useState(false);
  const probeNow = async () => {
    setProbing(true);
    try { await fleetApi.get(true); r.refresh(); } catch (x) { toast('err', (x as Error).message); } finally { setProbing(false); }
  };
  const own = r.data?.own ?? snap.status?.npub;
  // Every manager as an admin on every node that lacks one, after a confirmation (it writes those nodes' access lists).
  const outOfSync = r.data?.nodes.filter((n) => n.managersInSync === false && n.reachable && isAdmin(n.role)) ?? [];
  const [confirmSync, setConfirmSync] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncAll = async () => {
    setConfirmSync(false); setSyncing(true);
    try {
      const { results } = await fleetApi.syncAllManagers(outOfSync.map((n) => n.npub));
      const changed = results.filter((x) => x.changed).length, failed = results.filter((x) => x.error);
      toast(failed.length ? 'err' : 'ok', `${changed} node${changed === 1 ? '' : 's'} updated${failed.length ? `; ${failed.length} failed: ${failed.map((x) => x.error).join('; ')}` : ''}`);
      r.refresh();
    } catch (x) { toast('err', (x as Error).message); } finally { setSyncing(false); }
  };
  return (
    <div className="grid gap-4 fade-in">
      <Card title="Managed nodes" pad={false} hint="What each node last answered. Reads every 30 seconds; Probe now asks all of them at once."
        actions={<>
          {outOfSync.length > 0 && <button className="btn sm" onClick={() => setConfirmSync(true)} disabled={syncing}><UserPlus size={13} />Sync managers ({outOfSync.length})</button>}
          <button className="btn sm" onClick={probeNow} disabled={probing || !r.data?.nodes.length}><RefreshCw size={13} className={probing ? 'spin' : ''} />Probe now</button>
        </>}>
        {r.error ? <div className="px-4 pb-4"><ErrorNote>{r.error}</ErrorNote></div> : !r.data ? <Empty>Loading…</Empty> : <Nodes data={r.data} own={own} onChanged={r.refresh} busy={syncing} />}
      </Card>
      <ConfirmDialog open={confirmSync} onClose={() => setConfirmSync(false)} onConfirm={syncAll} busy={syncing} title={`Make every manager an admin on ${outOfSync.length} node${outOfSync.length === 1 ? '' : 's'}?`} confirmLabel="Sync managers"
        body={<>Each of those nodes' access lists is read and written back with every manager (this node and the standbys) as an <b>admin</b>. Nobody is removed or demoted there. Admin over the mesh has the same rights as someone at that machine, so every manager key must be one you trust with those nodes.</>} />
      {r.data && <FleetConfigCard data={r.data} own={own} onSaved={r.refresh} />}
    </div>
  );
}

// ---- overview ---------------------------------------------------------------------------------

function Nodes({ data, own, onChanged, busy }: { data: FleetData; own?: string; onChanged: () => void; busy: boolean }) {
  if (data.status.error) return <div className="px-4 pb-4"><ErrorNote>{data.status.error}</ErrorNote></div>;
  if (data.nodes.length === 0) return <Empty>No nodes yet. Add the first one below: it must run fips-ui with <b>Web UI over the mesh</b> on, listing this node as an admin.</Empty>;
  // Nodes with something to do; not the ones that simply have not been probed yet.
  const attention = data.nodes.filter((n) => n.phase !== 'ok' && n.error && n.lastAttempt > 0);
  return (
    <div className="grid gap-3 pb-4">
      <div className="hidden md:block overflow-x-auto">
        <table className="data">
          <thead><tr><th>Node</th><th>Status</th><th>Daemon</th><th>fips-ui</th><th>Uptime</th><th>Peers</th><th>Helper</th><th title="Whether every manager (this node and the standbys) is an admin on that node">Managers</th><th /></tr></thead>
          <tbody>
            {data.nodes.map((n) => (
              <tr key={n.npub}>
                <td><NpubInline npub={n.npub} name={n.label} /></td>
                <td><PhaseChip n={n} /></td>
                <td><VersionCell version={n.daemonVersion} latest={n.upgrade?.latest} available={!!n.upgrade?.available} restartPending={n.upgrade?.restartPending} /></td>
                <td><VersionCell version={n.uiVersion} latest={n.uiUpdate?.latest} available={!!n.uiUpdate?.available} /></td>
                <td className="mono">{n.reachable ? fmtDuration(n.uptimeSecs) : '–'}</td>
                <td className="mono">{n.reachable ? fmtNum(n.peerCount) : '–'}</td>
                <td><HelperChip n={n} /></td>
                <td><ManagersChip n={n} /></td>
                <td><div className="flex flex-wrap gap-1.5 justify-end"><NodeActions n={n} onChanged={onChanged} busy={busy} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden grid gap-3 px-3">
        {data.nodes.map((n) => (
          <div key={n.npub} className="card p-3 grid gap-2">
            <div className="flex items-center justify-between gap-2 min-w-0"><NpubInline npub={n.npub} name={n.label} /><PhaseChip n={n} /></div>
            <KV items={[
              ['Daemon', <VersionCell key="d" version={n.daemonVersion} latest={n.upgrade?.latest} available={!!n.upgrade?.available} restartPending={n.upgrade?.restartPending} />],
              ['fips-ui', <VersionCell key="u" version={n.uiVersion} latest={n.uiUpdate?.latest} available={!!n.uiUpdate?.available} />],
              ['Uptime · peers', <span key="p" className="mono">{n.reachable ? `${fmtDuration(n.uptimeSecs)} · ${fmtNum(n.peerCount)}` : '–'}</span>],
              ['Helper', <HelperChip key="h" n={n} />], ['Managers', <ManagersChip key="m" n={n} />],
            ]} />
            <div className="flex flex-wrap gap-2"><NodeActions n={n} onChanged={onChanged} busy={busy} /></div>
          </div>
        ))}
      </div>
      {attention.length > 0 && (
        <div className="px-4 grid gap-2">
          {attention.map((n) => (
            <ErrorNote key={n.npub}>
              <b>{n.label || shortKey(n.npub, 12, 6)}</b>: {n.error}
              {(n.phase === 'unauthorised' || n.phase === 'viewer') && <> On that node, under <b>Access → Web UI over the mesh</b>, add {own ? <Copyable text={own} display={shortKey(own, 12, 6)} /> : "this node's npub"} as an <b>admin</b>.</>}
              {n.lastSeen ? <span className="text-ink-3"> Last seen {fmtAgo(n.lastSeen)}.</span> : null}
            </ErrorNote>
          ))}
        </div>
      )}
    </div>
  );
}

/** Open the node's pages here (its API is forwarded by this node): needs it reachable with this node as admin. Plus the managers sync when one is missing there. */
function NodeActions({ n, onChanged, busy }: { n: FleetNodeStatus; onChanged: () => void; busy: boolean }) {
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const can = n.reachable && isAdmin(n.role);
  const why = !n.reachable ? 'The node is not reachable' : !isAdmin(n.role) ? 'This node is not an admin there' : undefined;
  const upgradeHint = n.upgrade?.available || n.uiUpdate?.available ? 'An update is available there' : 'Upgrade the daemon or fips-ui there';
  const sync = async () => {
    setSyncing(true);
    try {
      const res: SyncResult = await fleetApi.syncManagers(n.npub);
      if (res.error) toast('err', res.error);
      else toast('ok', res.changed ? `${n.label || shortKey(n.npub, 12, 6)}: ${[res.added.length && `${res.added.length} added`, res.promoted.length && `${res.promoted.length} promoted`].filter(Boolean).join(', ')}` : 'Already in sync');
      if (!res.error) onChanged();
    } catch (x) { toast('err', (x as Error).message); } finally { setSyncing(false); }
  };
  const syncBtn = n.managersInSync === false && can ? <button className="btn sm" onClick={sync} disabled={syncing || busy} title="Make every manager an admin on this node"><UserPlus size={13} />Sync managers</button> : null;
  if (!can) return <><button className="btn sm" disabled title={why}><ExternalLink size={13} />Open</button><button className="btn sm" disabled title={why}><ArrowUpCircle size={13} />Upgrade</button></>;
  return (
    <>
      {syncBtn}
      <a className="btn sm" href={hashFor('overview', undefined, n.npub)} title="Open this node's pages"><ExternalLink size={13} />Open</a>
      <a className={`btn sm ${n.upgrade?.available || n.uiUpdate?.available ? 'primary' : ''}`} href={hashFor('upgrade', undefined, n.npub)} title={upgradeHint}><ArrowUpCircle size={13} />Upgrade</a>
    </>
  );
}

function PhaseChip({ n }: { n: FleetNodeStatus }) {
  const p = phaseInfo(n);
  return <Chip tone={p.tone} className={p.pulse ? 'pulse' : ''} title={n.error ?? (n.lastSeen ? `last seen ${fmtAgo(n.lastSeen)}` : undefined)}>{p.label}</Chip>;
}

function VersionCell({ version, latest, available, restartPending }: { version?: string; latest?: string; available: boolean; restartPending?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="mono">{version ?? '–'}</span>
      {available && <Chip tone="accent" dot={false} title={latest ? `v${latest} is available` : 'an update is available'}>{latest ? `v${latest}` : 'update'} available</Chip>}
      {restartPending && <Chip tone="warn" dot={false} title="A newer version is installed than is running">restart pending</Chip>}
    </span>
  );
}

function HelperChip({ n }: { n: FleetNodeStatus }) {
  const h = n.helper;
  if (!h) return <span className="text-ink-3">–</span>;
  // null: the node did not say (no helper on that platform, or its check failed this time), not "none".
  if (h.installed === null) return <span className="text-ink-3" title="The node did not report its helper">–</span>;
  if (h.shipped !== null && h.installed < h.shipped) return <Chip tone="warn" title={`Its fips-ui ships helper v${h.shipped}; run sudo ./deploy/setup-local.sh on that node`}>v{h.installed} &lt; v{h.shipped}</Chip>;
  return <Chip dot={false}>v{h.installed}</Chip>;
}

function ManagersChip({ n }: { n: FleetNodeStatus }) {
  if (n.managersInSync === undefined) return <span className="text-ink-3">–</span>;
  if (n.managersInSync) return <Chip tone="good">in sync</Chip>;
  return <Chip tone="warn" title={`Not an admin there: ${(n.managersMissing ?? []).map((m) => shortKey(m, 12, 6)).join(', ')}`}>out of sync</Chip>;
}

// ---- configuration ----------------------------------------------------------------------------

function FleetConfigCard({ data, own, onSaved }: { data: FleetData; own?: string; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<FleetConfig>(data.config);
  const [busy, setBusy] = useState(false);
  const [addNode, setAddNode] = useState({ id: '', label: '' });
  const [addManager, setAddManager] = useState('');
  const hosts = useHosts().data?.entries ?? [];
  // Follow the saved list while there are no unsaved edits here.
  const lastSaved = useRef(JSON.stringify(data.config));
  useEffect(() => {
    const saved = JSON.stringify(data.config);
    if (JSON.stringify(draft) === lastSaved.current) setDraft(data.config);
    lastSaved.current = saved;
  }, [data.config]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);
  const incomplete = draft.nodes.some((n) => !n.port);
  const listed = new Set([...draft.nodes.map((n) => n.npub), ...draft.managers.map((m) => m.npub)]);
  const pickable = hosts.filter((h) => h.npub !== own && !listed.has(h.npub));

  /** An npub, or a name this node's hosts file or peers know. */
  const resolve = async (id: string): Promise<{ npub: string; name?: string }> => {
    if (NPUB_RE.test(id)) return { npub: id };
    const res = await api.local.get<{ npub: string; display_name?: string }>(`/api/resolve?id=${encodeURIComponent(id)}`);
    return { npub: res.npub, name: res.display_name || id };
  };
  const submitNode = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = addNode.id.trim();
    if (!id) return;
    try {
      const { npub, name } = await resolve(id);
      if (npub === own) { toast('err', 'That is this node'); return; }
      if (draft.nodes.some((n) => n.npub === npub)) { toast('info', 'Already managed'); return; }
      const label = addNode.label.trim() || name || hosts.find((h) => h.npub === npub)?.hostname;
      setDraft({ ...draft, nodes: [...draft.nodes, { npub, port: 8321, ...(label ? { label } : {}) }] });
      setAddNode({ id: '', label: '' });
    } catch (x) { toast('err', (x as Error).message); }
  };
  const submitManager = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = addManager.trim();
    if (!id) return;
    try {
      const { npub, name } = await resolve(id);
      if (npub === own) { toast('info', 'This node is always a manager'); return; }
      if (draft.managers.some((m) => m.npub === npub)) { toast('info', 'Already a manager'); return; }
      const label = name || hosts.find((h) => h.npub === npub)?.hostname;
      setDraft({ ...draft, managers: [...draft.managers, { npub, ...(label ? { label } : {}) }] });
      setAddManager('');
    } catch (x) { toast('err', (x as Error).message); }
  };
  const save = async () => {
    setBusy(true);
    try { const res = await fleetApi.save(draft); lastSaved.current = JSON.stringify(res.config); setDraft(res.config); toast('ok', 'Saved; probing the nodes'); onSaved(); }
    catch (x) { toast('err', (x as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <Card title="Nodes" hint="Each node must run fips-ui with Web UI over the mesh on, with this node's npub as an admin. The port is its mesh-access port.">
        <div className="grid gap-3">
          {draft.nodes.length === 0 ? <div className="text-sm text-ink-3 py-1">Nothing managed yet.</div> : (
            <div className="overflow-x-auto -mx-1"><table className="data"><tbody>
              {draft.nodes.map((n, i) => (
                <tr key={n.npub}>
                  <td><Copyable text={n.npub} display={shortKey(n.npub, 14, 6)} /></td>
                  <td><input className="input h-8 w-36" placeholder="label" value={n.label ?? ''} maxLength={40} onChange={(e) => setDraft({ ...draft, nodes: draft.nodes.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} /></td>
                  <td><input className="input h-8 w-24 mono" type="number" min={1} max={65535} title="Mesh-access port on that node" value={n.port || ''} onChange={(e) => setDraft({ ...draft, nodes: draft.nodes.map((y, j) => (j === i ? { ...y, port: Number(e.target.value) || 0 } : y)) })} /></td>
                  <td className="text-right"><button className="btn ghost icon sm" title="Remove" onClick={() => setDraft({ ...draft, nodes: draft.nodes.filter((_, j) => j !== i) })}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          <form className="flex flex-wrap gap-2" onSubmit={submitNode}>
            {pickable.length > 0 && (
              <select className="input w-52" aria-label="Pick from the hosts file" value="" onChange={(e) => { const h = pickable.find((x) => x.hostname === e.target.value); if (h) setAddNode({ id: h.hostname, label: addNode.label || h.hostname }); }}>
                <option value="">From hosts file…</option>
                {pickable.map((h) => <option key={h.hostname} value={h.hostname}>{h.hostname} · {shortKey(h.npub, 10, 4)}</option>)}
              </select>
            )}
            <input className="input mono flex-1 min-w-[220px]" placeholder="npub1… or hosts-file name" list="fleet-hosts" value={addNode.id} onChange={(e) => setAddNode({ ...addNode, id: e.target.value })} />
            <datalist id="fleet-hosts">{pickable.map((h) => <option key={h.hostname} value={h.hostname}>{shortKey(h.npub, 12, 6)}</option>)}</datalist>
            <input className="input w-36" placeholder="label" value={addNode.label} onChange={(e) => setAddNode({ ...addNode, label: e.target.value })} maxLength={40} />
            <button className="btn"><Plus size={14} />Add</button>
          </form>
        </div>
      </Card>
      <Card title="Managers" hint="Every manager is kept as an admin on each node. A standby whose nsec is backed up can take over when this node is lost.">
        <div className="grid gap-3">
          <div className="overflow-x-auto -mx-1"><table className="data"><tbody>
            <tr><td><NpubInline npub={own} /></td><td><Chip tone="accent" dot={false}>this node</Chip></td><td /></tr>
            {draft.managers.map((m, i) => m.npub === own ? null : (
              <tr key={m.npub}>
                <td><NpubInline npub={m.npub} name={m.label} /></td>
                <td><Chip dot={false}>standby</Chip></td>
                <td className="text-right"><button className="btn ghost icon sm" title="Remove" onClick={() => setDraft({ ...draft, managers: draft.managers.filter((_, j) => j !== i) })}><Trash2 size={13} /></button></td>
              </tr>
            ))}
          </tbody></table></div>
          <form className="flex flex-wrap gap-2" onSubmit={submitManager}>
            <input className="input mono flex-1 min-w-[220px]" placeholder="standby npub1… or hosts-file name" list="fleet-hosts" value={addManager} onChange={(e) => setAddManager(e.target.value)} />
            <button className="btn"><Plus size={14} />Add</button>
          </form>
          <p className="text-xs text-ink-3">A standby's key is a root credential for every managed node: back up its nsec as carefully as this node's own. Stored in <span className="mono">{data.file}</span>.</p>
        </div>
      </Card>
      <div className="lg:col-span-2 flex justify-end gap-2">
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft(data.config)}><Undo2 size={14} />Discard</button>
        <button className="btn primary" disabled={!dirty || busy || incomplete} title={incomplete ? 'Every node needs a port' : undefined} onClick={save}><Save size={14} />Save</button>
      </div>
    </div>
  );
}

export default Fleet;
