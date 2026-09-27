import { useEffect, useState } from 'react';
import { ArrowUpCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { Card, Chip, ConfirmDialog, ErrorNote, useToast } from './ui';
import { api } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { refreshUiUpdate, useUiUpdate, type UiUpdateJob } from '../lib/uiUpdate';

/** fips-ui itself: the installed and newest release, and updating to it from here. */
export function UiUpdateCard({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const info = useUiUpdate();
  const [confirm, setConfirm] = useState(false);
  const [checking, setChecking] = useState(false);
  const [job, setJob] = useState<UiUpdateJob | null>(null);
  const [restarting, setRestarting] = useState(false);

  // Follow a running update, then wait for the restarted server to answer with the new version and reload.
  useEffect(() => {
    if (!job || (job.state !== 'running' && !job.restarting)) return;
    const t = setInterval(async () => {
      if (job.state === 'running') {
        const d = await refreshUiUpdate();
        // The server may already have exited (no answer) or restarted on the new version (no job in memory).
        if (!d || !d.job || d.current === job.tag.slice(1)) { if (d?.current === job.tag.slice(1)) location.reload(); else { setJob({ ...job, state: 'done', restarting: true }); setRestarting(true); } return; }
        setJob(d.job); if (d.job.state === 'failed') toast('err', d.job.error ?? 'the update failed'); if (d.job.restarting) setRestarting(true);
        return;
      }
      const h = await api.get<{ uiVersion?: string }>('/api/health').catch(() => null);
      if (h?.uiVersion === job.tag.slice(1)) location.reload();
    }, 2000);
    return () => clearInterval(t);
  }, [job, toast]);
  useEffect(() => { if (info?.job && !job) setJob(info.job); }, [info?.job]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return null;
  const { latest } = info;
  const install = async () => {
    setConfirm(false);
    try { const r = await api.post<{ job: UiUpdateJob }>('/api/ui-update/install', { tag: latest!.tag }); setJob(r.job); }
    catch (x) { toast('err', (x as Error).message); }
  };
  const check = async () => { setChecking(true); await refreshUiUpdate(true); setChecking(false); };
  const helperBehind = info.helper && info.helper.shipped !== null && (info.helper.installed ?? 0) < info.helper.shipped;
  const running = job?.state === 'running';

  return (
    <Card title="fips-ui (this dashboard)" hint="New fips-ui releases are looked up on GitHub every 6 hours. Updating fast-forwards this installation's git checkout to the release, rebuilds it and restarts the service."
      actions={<button className="btn sm" disabled={checking} onClick={check}><RefreshCw size={13} />{checking ? 'Checking…' : 'Check now'}</button>}>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Installed <b>v{info.current}</b></span>
          {latest && (info.newer ? <Chip tone="accent">v{latest.version} available</Chip> : <Chip tone="good">up to date</Chip>)}
          {latest && <a className="text-xs text-ink-3 hover:text-ink inline-flex items-center gap-1" href={latest.url} target="_blank" rel="noreferrer">release notes <ExternalLink size={11} /></a>}
          <span className="text-xs text-ink-3 ml-auto">{info.checkedAt ? `checked ${fmtAgo(info.checkedAt)}` : 'not checked yet'}</span>
        </div>
        {info.error && <ErrorNote>{info.error}</ErrorNote>}
        {info.newer && latest?.notes && (
          <details className="text-sm"><summary className="cursor-pointer text-ink-2">What's new in v{latest.version}</summary><pre className="mt-2 text-xs whitespace-pre-wrap bg-surface-2 rounded-lg p-3 max-h-72 overflow-auto">{latest.notes}</pre></details>
        )}
        {info.newer && !readOnly && info.install && (info.install.mode === 'git'
          ? <div className="flex flex-wrap items-center gap-3">
              <button className="btn primary" disabled={running || restarting} onClick={() => setConfirm(true)}><ArrowUpCircle size={15} />Update to v{latest!.version}</button>
              <span className="text-xs text-ink-3">{info.canRestart ? 'The service restarts by itself afterwards; this page reloads when it is back.' : 'Not running under systemd: restart fips-ui yourself after the build.'}</span>
            </div>
          : <p className="text-xs text-ink-3">This installation cannot update itself: {info.install.reason}.</p>)}
        {helperBehind && <ErrorNote>This version ships privileged helper v{info.helper!.shipped} (installed: {info.helper!.installed ? `v${info.helper!.installed}` : 'none'}). Some pages need it: run <code>sudo ./deploy/setup-local.sh</code> in {'the fips-ui directory'}.</ErrorNote>}
        {job && (
          <div className="grid gap-1">
            <div className="text-xs">{job.state === 'running' ? `Updating to ${job.tag}…` : job.state === 'failed' ? <span className="text-crit">Update to {job.tag} failed: {job.error}</span> : restarting || job.restarting ? `Updated to ${job.tag}; waiting for the service to come back…` : `Updated to ${job.tag}.`}</div>
            <pre className="text-xs whitespace-pre-wrap bg-surface-2 rounded-lg p-3 max-h-60 overflow-auto">{job.log.join('\n')}</pre>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={install} title={`Update fips-ui to v${latest?.version}?`} confirmLabel="Update"
        body={<>The checkout is fast-forwarded to <code>{latest?.tag}</code>, rebuilt and the service restarted. If the build fails the previous version is restored. The dashboard is unavailable for a few seconds during the restart.</>} />
    </Card>
  );
}
