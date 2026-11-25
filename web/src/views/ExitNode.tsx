import { useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Card, Chip, ConfirmDialog, Empty, ErrorNote, KV, Skeleton, StatusChip, useToast } from '../components/ui';
import { adminApi, EXIT_HELPER_VERSION, helperInstallCommand, type ExitResult, type ExitState } from '../lib/admin';
import { api, usePoll } from '../lib/api';

/**
 * The exit node (fips-exit): which mesh clients may send their internet traffic out through this node. Everyone
 * with access sees the list; an admin changes it, through the privileged helper.
 */
export function ExitNode({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const st = usePoll(() => api.get<ExitState>('/api/exit/state'), [], 10000);
  const status = usePoll(() => (readOnly ? Promise.resolve(null) : adminApi.status()), [readOnly], 30000);
  const helper = status.data?.helper;
  const helperOk = !!helper?.available && (helper.version ?? 0) >= EXIT_HELPER_VERSION;
  const [who, setWho] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { address: string; name: string }>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const run = async (fn: () => Promise<ExitResult | unknown>, okMsg: string) => {
    setBusy(true); setLastError(null);
    try {
      const r = (await fn()) as ExitResult;
      if (r && typeof r === 'object' && 'ok' in r && !r.ok) { setLastError(r.error ?? 'Rejected'); toast('err', r.error ?? 'Rejected'); return false; }
      toast('ok', okMsg); st.refresh(); return true;
    } catch (e) { setLastError((e as Error).message); toast('err', (e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const add = async () => { if (await run(() => adminApi.exitAdd(who.trim(), name.trim() || undefined), 'Client added')) { setWho(''); setName(''); } };
  const svc = (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') => run(() => adminApi.service('fips-exit', action), `fips-exit: ${action} done`);

  const s = st.data;
  if (st.error && !s) return <ErrorNote>{st.error}</ErrorNote>;
  if (!s) return <Skeleton className="h-40 w-full" />;
  if (!s.installed) {
    return (
      <Card title="Exit node">
        <Empty>
          <div className="max-w-md">
            <p className="mb-2"><code>fips-exit</code> is not installed on this node.</p>
            <p className="text-xs">An exit node carries the internet traffic of chosen mesh clients, such as phones running fips2go, out through this machine's connection. Install <a className="underline" href="https://github.com/fr34aky/fips-exit" target="_blank" rel="noreferrer">fips-exit</a> on the node to manage it here.</p>
          </div>
        </Empty>
      </Card>
    );
  }
  const active = s.unit?.active === 'active';
  const canChange = !readOnly && helperOk;
  const nameOk = !name.trim() || /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name.trim());
  return (
    <div className="grid gap-4 fade-in">
      <p className="text-ink-2 text-sm max-w-3xl">Mesh clients on the list send their internet traffic to this node, which forwards it from its own address like a VPN server would. A client reaches the public internet only: not this host, not another client, not this network. Whoever runs this node can see that traffic.</p>
      {st.error && <ErrorNote>{st.error}</ErrorNote>}
      {s.error && <ErrorNote>The client list could not be read: {s.error}</ErrorNote>}
      {lastError && <div className="card px-4 py-3 text-sm" style={{ borderColor: 'rgba(208,59,59,0.5)' }}><div className="text-crit font-medium whitespace-pre-wrap">{lastError}</div></div>}
      {!readOnly && status.data && !helperOk && (
        <ErrorNote>Changing the exit node needs helper v{EXIT_HELPER_VERSION} (installed: {helper?.version ? `v${helper.version}` : 'none'}). Run <code>{helperInstallCommand(helper?.serviceManager)}</code> on the node.</ErrorNote>
      )}

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card title="Service" actions={<button className="btn ghost icon sm" onClick={() => st.refresh()} title="Refresh"><RefreshCw size={14} /></button>}>
          <KV items={[
            ['fips-exit', s.unit ? <StatusChip value={s.unit.active} /> : <Chip tone="neutral">not a systemd unit</Chip>],
            ['At boot', s.unit ? <span>{s.unit.enabled}</span> : '–'],
            ['Clients', <span>{s.clients.filter((c) => c.served).length}</span>],
            ['Client list', <span className="mono text-xs">{s.clientsFile}</span>],
          ]} />
          {canChange && s.unit && (
            <div className="flex flex-wrap gap-2 mt-3">
              {active
                ? <><button className="btn sm" disabled={busy} onClick={() => svc('restart')}>Restart</button><button className="btn sm" disabled={busy} onClick={() => svc('stop')}>Stop</button></>
                : <button className="btn sm primary" disabled={busy} onClick={() => svc('start')}>Start</button>}
              {s.unit.enabled === 'enabled'
                ? <button className="btn sm ghost" disabled={busy} onClick={() => svc('disable')}>Do not start at boot</button>
                : <button className="btn sm ghost" disabled={busy} onClick={() => svc('enable')}>Start at boot</button>}
            </div>
          )}
          {!active && <p className="text-xs text-ink-3 mt-3">While the service is stopped no client is served. The list is kept and applied when it starts.</p>}
        </Card>

        <Card title={`Clients (${s.clients.length})`} pad={false}>
          {!s.clients.length ? <Empty>No client is allowed yet.</Empty> : (
            <div className="overflow-x-auto"><table className="data"><thead><tr><th>Name</th><th>Mesh address</th><th>Tunnel IPv4</th><th></th></tr></thead><tbody>
              {s.clients.map((c) => (
                <tr key={c.address}>
                  <td>{c.name || <span className="text-ink-3">–</span>}{!c.served && <Chip tone="warn" className="ml-2" title="An earlier client has the same tunnel address; the exit does not serve this one. Remove one of them.">not served</Chip>}</td>
                  <td className="mono text-xs">{c.address}</td>
                  <td className="mono text-xs">{c.inner}</td>
                  <td className="text-right">{canChange && <button className="btn ghost icon sm" disabled={busy} title={`Remove ${c.name || c.address}`} onClick={() => setConfirm({ address: c.address, name: c.name })}><Trash2 size={14} /></button>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          {canChange && (
            <form className="flex flex-wrap items-end gap-2 p-4 border-t border-line" onSubmit={(e) => { e.preventDefault(); if (who.trim() && nameOk && !busy) void add(); }}>
              <label className="grid gap-1 grow min-w-[16rem]"><span className="text-xs text-ink-3">Client: npub or mesh address (fd…)</span>
                <input className="input mono text-xs" value={who} onChange={(e) => setWho(e.target.value)} placeholder="npub1…" spellCheck={false} autoComplete="off" /></label>
              <label className="grid gap-1 w-44"><span className="text-xs text-ink-3">Name (optional)</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="alice-phone" maxLength={40} spellCheck={false} autoComplete="off" /></label>
              <button className="btn sm primary" type="submit" disabled={busy || !who.trim() || !nameOk}><Plus size={14} /> Allow</button>
              {!nameOk && <span className="text-xs text-crit w-full">The name is one word: letters, digits, dot, dash or underscore.</span>}
            </form>
          )}
        </Card>
      </div>
      <p className="text-xs text-ink-3 max-w-3xl">On a fips2go phone the npub to allow is shown under Overview → Internet route → This phone; the phone then adds this node's npub as its exit node. A change here applies at once, without restarting anything.</p>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} danger busy={busy} title="Remove this client?" confirmLabel="Remove"
        body={<p className="text-sm">{confirm?.name ? <><b>{confirm.name}</b> (<span className="mono text-xs">{confirm.address}</span>)</> : <span className="mono text-xs">{confirm?.address}</span>} is cut off at once: its open connections through this node stop.</p>}
        onConfirm={async () => { const c = confirm; if (c && (await run(() => adminApi.exitRemove(c.address), 'Client removed'))) setConfirm(null); }} />
    </div>
  );
}
