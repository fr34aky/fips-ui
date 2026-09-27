import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowUpCircle, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Download, ExternalLink,
  GitCommitHorizontal, Hammer, KeyRound, Loader2, Package, RefreshCw, RotateCcw, ShieldCheck, SkipForward, Terminal, X, XCircle,
} from 'lucide-react';
import { usePoll } from '../lib/api';
import { UiUpdateCard } from '../components/UiUpdateCard';
import { Copyable, Modal } from '../components/ui';
import { fmtAgo, fmtBytes, fmtDuration, fmtTime } from '../lib/format';
import { upgradeApi, useUpgradeJob, type ConfigMergeResult, type Backup, type JobSummary, type StepInfo, type UpgradeSource, type UpgradeStatus } from '../lib/upgrade';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Upgrade() {
  // The periodic poll reads cached probes; the Refresh button forces the backend to re-probe.
  const forceRef = useRef(false);
  const { data: st, error, refresh } = usePoll(() => { const f = forceRef.current; forceRef.current = false; return upgradeApi.status(f); }, [], 15000);
  const forceRefresh = () => { forceRef.current = true; refresh(); };
  // The job this tab launched (id + start time); it only bridges the gap until the next status poll sees it.
  const [active, setActive] = useState<{ id: string; startedAt: number } | null>(null);
  const activeJobId = active?.id ?? null;
  const setActiveJobId = (j: JobSummary | null) => setActive(j ? { id: j.id, startedAt: j.startedAt } : null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  // The server keeps its last job indefinitely, so "dismiss" has to be remembered client-side.
  const serverJob = st?.job && st.job.id !== dismissedId ? st.job : null;
  // A newer job reported by the server (started from another tab or curl) supersedes the one this tab launched.
  // Compared by start time, not id, so an id-format change across a backend upgrade cannot pin an old job.
  const followId = serverJob && (!active || serverJob.startedAt > active.startedAt || serverJob.id === active.id) ? serverJob.id : activeJobId ?? serverJob?.id ?? null;
  const { job: liveJob, log } = useUpgradeJob(followId);
  const candidate = liveJob ?? st?.job ?? null;
  const job = candidate && candidate.id !== dismissedId ? candidate : null;
  const busy = job?.state === 'running' || job?.state === 'queued';

  // Refresh status when a job ends so versions and backups update.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => { if (prevState.current && (prevState.current === 'running' || prevState.current === 'queued') && job && job.state !== 'running' && job.state !== 'queued') refresh(); prevState.current = job?.state; }, [job?.state, job, refresh]);

  const [confirm, setConfirm] = useState<null | { source: UpgradeSource; ref?: string; label: string }>(null);
  const [restart, setRestart] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [mergeConfig, setMergeConfig] = useState(true);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const launch = async (fn: () => Promise<JobSummary | null>) => {
    setActionErr(null);
    try { const j = await fn(); if (j) { setDismissedId(null); setActiveJobId(j); refresh(); } }
    catch (e) { setActionErr((e as Error).message); }
  };

  const canInstall = !!st?.helper.available;
  const toolchainOk = !!st && Object.values(st.toolchain).filter((t) => t.required).every((t) => t.ok);
  const missingTools = st ? Object.entries(st.toolchain).filter(([, v]) => !v.ok).map(([k]) => k) : [];

  return (
    <div className="grid gap-4 fade-in">
      <UiUpdateCard readOnly={false} />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2 text-sm max-w-2xl">Install a published release or build the development version from <code>master</code>. Binaries are backed up before every install and can be rolled back from this page.</p>
        <div className="flex items-center gap-2">
          {st?.restartPending && <span className="chip warn"><span className="chip-dot" />restart pending</span>}
          <button className="btn sm" onClick={forceRefresh} title="Re-check versions, helper and toolchain"><RefreshCw size={14} /> Refresh</button>
        </div>
      </header>

      {error && !st && <div className="card p-4 text-crit flex items-center gap-2"><XCircle size={16} /> {error}</div>}
      {actionErr && <div className="card p-3 text-crit flex items-center gap-2 text-sm"><XCircle size={16} /> {actionErr}<button className="btn ghost sm ml-auto" onClick={() => setActionErr(null)}><X size={14} /></button></div>}

      {/* ---- versions ------------------------------------------------------ */}
      <section className="grid gap-4 md:grid-cols-3">
        <VersionCard title="Running daemon" version={st?.running?.version} rev={st?.running?.rev} sub={st?.running ? `pid ${st.running.pid} · up ${fmtDuration(st.running.uptime_secs)}` : 'control socket unreachable'} tone={st?.running ? 'good' : 'crit'} />
        <VersionCard title="Installed on disk" version={st?.installed.version} rev={st?.installed.rev} sub={st?.installed.path ?? 'fips binary not found'} tone={st?.restartPending ? 'warn' : 'neutral'} />
        <div className="card p-4 grid gap-2 content-start">
          <div className="card-title">System</div>
          <dl className="kv">
            <dt>Platform</dt><dd>{st ? `${st.platform.os} / ${st.platform.arch}` : '–'}</dd>
            <dt>Install path</dt><dd className="mono text-xs">{st?.platform.binDir ?? '–'}</dd>
            <dt>Installer</dt><dd>{st ? (st.helper.available ? <span className="chip good"><ShieldCheck size={12} />{st.platform.installer === 'helper' ? 'privileged helper' : 'elevated'}</span> : <span className="chip crit"><AlertTriangle size={12} />unavailable</span>) : '–'}</dd>
            {st?.package && <><dt>Package</dt><dd>{st.package.manager}: <span className="mono text-xs">{st.package.name}{st.package.version ? ` ${st.package.version}` : ''}</span></dd></>}
          </dl>
        </div>
      </section>

      {/* ---- preflight ----------------------------------------------------- */}
      {st && !st.helper.available && (
        <div className="card p-4 border-l-4" style={{ borderLeftColor: 'var(--warn)' }}>
          <div className="flex flex-wrap items-start gap-3">
            <KeyRound size={18} className="text-warn mt-0.5" />
            <div className="grid gap-2 text-sm flex-1 min-w-[260px]">
              <div className="font-medium">Privileged installer not available</div>
              <div className="text-ink-2">{st.helper.error}. Downloads and builds still work as a dry run, but swapping binaries and restarting the service needs root.</div>
              {st.platform.installer === 'helper' ? (
                <>
                  <div className="text-ink-2">Install the helper once from a shell on this host. It places a small root-owned script at <span className="mono">/usr/local/libexec/fips-ui-helper</span> and one <span className="mono">sudoers.d</span> rule that lets the UI user run that script and nothing else. The web UI never asks for a password and cannot grant itself privileges.</div>
                  <Copyable text={`sudo ${st.helperInstallScript ?? 'deploy/install-upgrade-helper.sh'}`} className="rounded-lg bg-surface-2 px-3 py-2 text-xs w-fit max-w-full" />
                  <div className="text-ink-3 text-xs">Then press Refresh. To remove it later: <span className="mono">sudo rm /etc/sudoers.d/fips-ui /usr/local/libexec/fips-ui-helper</span></div>
                </>
              ) : (
                <div className="text-ink-2">On Windows, run the UI backend from an elevated (Administrator) shell.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {st?.package && <div className="text-xs text-ink-3 flex items-start gap-2 px-1"><Package size={13} className="mt-0.5 flex-none" /><span>{st.package.note}</span></div>}

      {/* ---- sources ------------------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <ReleaseCard st={st} disabled={busy} onInstall={(ref, label) => setConfirm({ source: 'release', ref, label })} />
        <MasterCard st={st} disabled={busy} toolchainOk={toolchainOk} missing={missingTools}
          onInstall={(ref, label) => setConfirm({ source: 'master', ref, label })} />
      </section>

      {/* ---- options ------------------------------------------------------- */}
      <section className="card p-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <div className="card-title mr-2">Options</div>
        <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} className="accent-[var(--accent)]" /> Restart service after install</label>
        <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="accent-[var(--accent)]" /> Dry run <span className="text-ink-3">(download / build and stage only, install nothing)</span></label>
        <label className="flex items-center gap-2 cursor-pointer" title="After the new daemon runs, the changes of the fips.yaml template between the old and the new version are merged into your fips.yaml (your own edits stay). A clean merge is applied with a backup, restart and automatic rollback; a merge with conflicts waits on the Configuration page."><input type="checkbox" checked={mergeConfig} onChange={(e) => setMergeConfig(e.target.checked)} className="accent-[var(--accent)]" /> Update fips.yaml to the new template</label>
        {!canInstall && !dryRun && <span className="chip warn"><AlertTriangle size={12} /> installs will fail until the privileged installer is available</span>}
        {st?.restartPending && <button className="btn sm ml-auto" disabled={busy || !canInstall} onClick={() => { setActionErr(null); upgradeApi.restart().then(refresh).catch((e) => setActionErr(e.message)); }}><RotateCcw size={14} /> Restart service now</button>}
      </section>

      {/* ---- job ----------------------------------------------------------- */}
      {job && <JobPanel job={job} log={log} onCancel={() => upgradeApi.cancel().catch((e) => setActionErr(e.message))} onDismiss={() => { setDismissedId(job.id); setActiveJobId(null); }} />}

      {/* ---- backups ------------------------------------------------------- */}
      <BackupsCard backups={st?.backups ?? []} disabled={busy || !canInstall} onRollback={(b) => setConfirm({ source: 'release', ref: `rollback:${b.id}`, label: `Roll back to ${b.version || b.id}` })} />

      {/* ---- dialogs ------------------------------------------------------- */}
      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title={confirm.label} width="max-w-md">
          <div className="grid gap-3 text-sm">
            {confirm.ref?.startsWith('rollback:') ? (
              <p>The current binaries are backed up first, then the selected backup is restored and the service restarted.</p>
            ) : (
              <>
                <p>{confirm.source === 'release' ? 'The release artifact is downloaded and its checksum verified against the published checksum file.' : 'The repository is synced and compiled locally with cargo. A full build takes several minutes on first run.'}</p>
                {dryRun ? <p className="chip accent w-fit">Dry run: nothing will be installed.</p> : (
                  <ul className="list-disc pl-5 text-ink-2 grid gap-1">
                    <li>Current binaries are backed up and can be restored from this page.</li>
                    {restart ? <li>The daemon restarts: peers drop briefly and the spanning tree re-announces.</li> : <li>The service is <b>not</b> restarted; the old version keeps running until you restart it.</li>}
                  </ul>
                )}
              </>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn primary" onClick={() => {
                const c = confirm; setConfirm(null);
                if (c.ref?.startsWith('rollback:')) void launch(() => upgradeApi.rollback(c.ref!.slice('rollback:'.length)));
                else void launch(() => upgradeApi.start({ source: c.source, ref: c.ref, restart, dryRun, mergeConfig }));
              }}><Check size={15} /> {dryRun && !confirm.ref?.startsWith('rollback:') ? 'Start dry run' : 'Proceed'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Upgrade;

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function VersionCard({ title, version, rev, sub, tone }: { title: string; version?: string; rev?: string; sub: string; tone: 'good' | 'warn' | 'crit' | 'neutral' }) {
  return (
    <div className="card p-4 grid gap-1 content-start">
      <div className="card-title flex items-center gap-2">{title}{tone !== 'neutral' && <span className={`chip-dot ${tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-crit'}`} style={{ background: 'currentColor' }} />}</div>
      <div className="text-2xl font-semibold tabular tracking-tight">{version ?? <span className="text-ink-3">–</span>}</div>
      <div className="text-xs text-ink-3 mono truncate">{rev ? `rev ${rev}` : ' '}</div>
      <div className="text-xs text-ink-2 truncate" title={sub}>{sub}</div>
    </div>
  );
}

function RelationChip({ rel }: { rel: string }) {
  if (rel === 'newer') return <span className="chip accent"><ArrowUpCircle size={12} /> newer than installed</span>;
  if (rel === 'same') return <span className="chip good"><Check size={12} /> installed</span>;
  if (rel === 'older') return <span className="chip"><span className="chip-dot" /> older than installed</span>;
  return <span className="chip">unknown</span>;
}

function ReleaseCard({ st, disabled, onInstall }: { st: UpgradeStatus | null; disabled: boolean; onInstall: (ref: string | undefined, label: string) => void }) {
  const [notes, setNotes] = useState(false);
  const [custom, setCustom] = useState('');
  const rel = st?.release;
  return (
    <div className="card p-4 grid gap-3 content-start">
      <div className="flex items-center justify-between gap-2">
        <div className="card-title flex items-center gap-2"><Download size={14} /> Stable release</div>
        {rel && !('error' in rel) && <RelationChip rel={rel.relation} />}
      </div>
      {!st ? <div className="skeleton h-16" /> : !rel || 'error' in rel ? (
        <div className="text-sm text-serious flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5" /> {rel?.error ?? 'unavailable'}</div>
      ) : (
        <>
          <div>
            <div className="text-2xl font-semibold tracking-tight flex items-center gap-2">{rel.tag}{rel.prerelease && <span className="chip warn">pre-release</span>}</div>
            <div className="text-xs text-ink-2 mt-1">Published {fmtAgo(Date.parse(rel.publishedAt))} · {rel.asset ? <>{rel.asset.name} · {fmtBytes(rel.asset.size)}</> : <span className="text-serious">no artifact for {st.platform.os}/{st.platform.arch}</span>} · {rel.checksums ? 'checksum published' : 'no checksum file'} · <a href={rel.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">release page <ExternalLink size={11} /></a></div>
          </div>
          {rel.notes && (
            <div>
              <button className="btn ghost sm -ml-2" onClick={() => setNotes((v) => !v)}>{notes ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Release notes</button>
              {notes && <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap font-sans text-ink-2">{rel.notes}</pre>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-auto pt-1">
            <button className="btn primary" disabled={disabled || !rel.asset} onClick={() => onInstall(undefined, `Install ${rel.tag}`)}><Download size={15} /> Install {rel.tag}</button>
            <div className="flex items-center gap-1 ml-auto">
              <input className="input h-[34px] w-32 text-xs mono" placeholder="other tag, e.g. v0.5.0" value={custom} onChange={(e) => setCustom(e.target.value)} />
              <button className="btn" disabled={disabled || !custom.trim()} onClick={() => onInstall(custom.trim(), `Install ${custom.trim()}`)}>Install</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MasterCard({ st, disabled, toolchainOk, missing, onInstall }: { st: UpgradeStatus | null; disabled: boolean; toolchainOk: boolean; missing: string[]; onInstall: (ref: string | undefined, label: string) => void }) {
  const [showCommits, setShowCommits] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [ref, setRef] = useState('');
  const m = st?.master;
  const plan = st?.toolchainPlan;
  return (
    <div className="card p-4 grid gap-3 content-start">
      <div className="flex items-center justify-between gap-2">
        <div className="card-title flex items-center gap-2"><Hammer size={14} /> Development build (master)</div>
        {m && !('error' in m) && <RelationChip rel={m.relation} />}
      </div>
      {!st ? <div className="skeleton h-16" /> : !m || 'error' in m ? (
        <div className="text-sm text-serious flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5" /> {m?.error ?? 'unavailable'}</div>
      ) : (
        <>
          <div>
            <div className="text-2xl font-semibold tracking-tight mono">{m.sha.slice(0, 10)}</div>
            <div className="text-xs text-ink-2 mt-1 truncate" title={m.subject}>{m.subject}</div>
            <div className="text-xs text-ink-3 mt-0.5">Committed {fmtAgo(Date.parse(m.date))}{m.ahead ? <> · <b className="text-ink-2">{m.ahead.ahead_by}</b> commit{m.ahead.ahead_by === 1 ? '' : 's'} ahead of installed</> : null} · <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">view <ExternalLink size={11} /></a></div>
          </div>
          {m.ahead && m.ahead.commits.length > 0 && (
            <div>
              <button className="btn ghost sm -ml-2" onClick={() => setShowCommits((v) => !v)}>{showCommits ? <ChevronDown size={14} /> : <ChevronRight size={14} />} What changed</button>
              {showCommits && (
                <ul className="mt-1 max-h-56 overflow-auto rounded-lg bg-surface-2 p-2 text-xs grid gap-1">
                  {m.ahead.commits.map((c) => <li key={c.sha} className="flex gap-2 items-start"><GitCommitHorizontal size={13} className="mt-0.5 flex-none text-ink-3" /><a href={c.url} target="_blank" rel="noreferrer" className="mono text-ink-3 hover:text-ink flex-none">{c.sha.slice(0, 8)}</a><span className="text-ink-2 truncate" title={c.subject}>{c.subject}</span></li>)}
                </ul>
              )}
            </div>
          )}
          {/* toolchain */}
          <div className="rounded-lg border border-line bg-surface-2 p-2.5 text-xs grid gap-2">
            <button className="flex items-center gap-2 text-left" onClick={() => setShowTools((v) => !v)}>
              {toolchainOk ? <CheckCircle2 size={14} className="text-good" /> : <AlertTriangle size={14} className="text-warn" />}
              <span className="font-medium">{toolchainOk ? 'Build toolchain ready' : `Build tools missing: ${missing.join(', ')}`}</span>
              {!toolchainOk && missing.every((k) => !st.toolchain[k].required) && <span className="text-ink-3">(optional)</span>}
              <span className="ml-auto text-ink-3">{showTools ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            </button>
            {showTools && (
              <ul className="grid gap-1 pl-1">
                {Object.entries(st.toolchain).map(([k, v]) => <li key={k} className="flex items-start gap-2">{v.ok ? <Check size={13} className="text-good mt-0.5 flex-none" /> : <X size={13} className={`${v.required ? 'text-crit' : 'text-warn'} mt-0.5 flex-none`} />}<span className="font-medium w-20 flex-none">{k}</span><span className="text-ink-2 break-all">{v.detail}</span></li>)}
              </ul>
            )}
            {!toolchainOk && plan && (
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-line">
                {plan.manager ? (
                  <>
                    <span className="text-ink-2 w-full">Install them from a shell{plan.sudo ? ' as root' : ''}, then press Refresh:</span>
                    <Copyable text={`${plan.sudo ? 'sudo ' : ''}${plan.command.join(' ')}`} className="rounded-md bg-surface px-2 py-1 max-w-full" />
                  </>
                ) : <span className="text-ink-2">{plan.note}</span>}
                {plan.manager && plan.note && <div className="w-full text-ink-3">{plan.note}</div>}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-auto pt-1">
            <button className="btn primary" disabled={disabled || !toolchainOk} title={toolchainOk ? '' : 'Install the build tools first'} onClick={() => onInstall(undefined, 'Build and install master')}><Hammer size={15} /> Build &amp; install master</button>
            <div className="flex items-center gap-1 ml-auto">
              <input className="input h-[34px] w-36 text-xs mono" placeholder="branch, tag or sha" value={ref} onChange={(e) => setRef(e.target.value)} />
              <button className="btn" disabled={disabled || !toolchainOk || !ref.trim()} onClick={() => onInstall(ref.trim(), `Build and install ${ref.trim()}`)}>Build</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BackupsCard({ backups, disabled, onRollback }: { backups: Backup[]; disabled: boolean; onRollback: (b: Backup) => void }) {
  return (
    <div className="card overflow-hidden">
      <div className="p-4 pb-2 flex items-center gap-2"><div className="card-title flex items-center gap-2"><RotateCcw size={14} /> Backups</div><span className="text-xs text-ink-3">{backups.length ? `${backups.length} kept (most recent 10)` : 'none yet — one is taken before every install'}</span></div>
      {backups.length > 0 && (
        <table className="data">
          <thead><tr><th>Taken</th><th>Version</th><th>Files</th><th className="num"></th></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id}>
                <td>{fmtTime(b.createdAt, true)} <span className="text-ink-3">· {fmtAgo(b.createdAt)}</span></td>
                <td className="mono text-xs">{b.version || b.id}</td>
                <td className="text-ink-2 text-xs">{b.files.join(', ')}</td>
                <td className="num"><button className="btn sm" disabled={disabled} onClick={() => onRollback(b)}><RotateCcw size={13} /> Roll back</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job panel: step tracker + live log
// ---------------------------------------------------------------------------

function StepIcon({ s }: { s: StepInfo['state'] }) {
  if (s === 'done') return <CheckCircle2 size={16} className="text-good" />;
  if (s === 'running') return <Loader2 size={16} className="text-accent animate-spin" />;
  if (s === 'failed') return <XCircle size={16} className="text-crit" />;
  if (s === 'skipped') return <SkipForward size={16} className="text-ink-3" />;
  return <CircleDashed size={16} className="text-ink-3" />;
}

function JobPanel({ job, log, onCancel, onDismiss }: { job: JobSummary; log: { seq: number; t: number; stream: string; line: string }[]; onCancel: () => void; onDismiss: () => void }) {
  const running = job.state === 'running' || job.state === 'queued';
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [log.length, follow]);
  const title = useMemo(() => job.kind === 'rollback' ? `Rollback ${job.ref.replace('rollback:', '')}` : job.kind === 'toolchain' ? 'Installing build tools' : job.kind === 'helper' ? 'Installing privileged helper' : `${job.dryRun ? 'Dry run: ' : ''}${job.source === 'release' ? `Release ${job.ref}` : `Build ${job.ref}`}`, [job]);
  const tone = job.state === 'succeeded' ? 'good' : job.state === 'failed' ? 'crit' : job.state === 'cancelled' ? 'warn' : 'accent';
  // Tick once a second while running so the elapsed time advances without impure reads during render.
  const [now, setNow] = useState(() => job.endedAt ?? job.startedAt);
  useEffect(() => { if (!running) { setNow(job.endedAt ?? job.startedAt); return; } const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running, job.endedAt, job.startedAt]);
  const elapsed = fmtDuration((now - job.startedAt) / 1000);

  return (
    <section className="card overflow-hidden fade-in">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line">
        <Terminal size={16} className="text-ink-3" />
        <div className="font-medium">{title}</div>
        <span className={`chip ${tone}`}>{running && <Loader2 size={12} className="animate-spin" />}{job.state}</span>
        <span className="text-xs text-ink-3">started {fmtTime(job.startedAt)} · {elapsed}</span>
        <div className="ml-auto flex items-center gap-2">
          {running && job.cancellable && <button className="btn danger sm" onClick={onCancel}><X size={13} /> Cancel</button>}
          {running && !job.cancellable && <span className="text-xs text-ink-3">privileged step — cannot cancel</span>}
          {!running && <button className="btn ghost sm" onClick={onDismiss}><X size={13} /> Dismiss</button>}
        </div>
      </div>
      <div className="grid md:grid-cols-[260px_1fr]">
        <ol className="p-3 grid gap-1 content-start border-b md:border-b-0 md:border-r border-line">
          {job.steps.map((s) => (
            <li key={s.name} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ${s.state === 'running' ? 'bg-accent-soft' : ''}`}>
              <span className="mt-0.5"><StepIcon s={s.state} /></span>
              <div className="min-w-0">
                <div className={s.state === 'pending' ? 'text-ink-3' : ''}>{s.label}</div>
                {s.startedAt && s.endedAt && <div className="text-[11px] text-ink-3">{fmtDuration((s.endedAt - s.startedAt) / 1000)}</div>}
                {s.detail && <div className={`text-xs ${s.state === 'failed' ? 'text-crit' : 'text-ink-3'} break-words`}>{s.detail}</div>}
              </div>
            </li>
          ))}
          {job.result && (job.result.stagedVersion || job.result.runningVersion || job.result.backupId) && (
            <li className="mt-2 px-2 text-xs grid gap-0.5 text-ink-2">
              {job.result.stagedVersion && <div>staged: <span className="mono">{job.result.stagedVersion}</span></div>}
              {job.result.runningVersion && <div>running: <span className="mono">{job.result.runningVersion}</span></div>}
              {job.result.backupId && <div>backup: <span className="mono">{job.result.backupId}</span></div>}
            </li>
          )}
          {job.result?.config && <li className="mt-2 px-2"><ConfigOutcome c={job.result.config} /></li>}
          {job.error && job.state !== 'cancelled' && <li className="mt-1 px-2 text-xs text-crit break-words">{job.error}</li>}
        </ol>
        <div className="relative min-w-0">
          <div ref={box} onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }} className="h-[360px] overflow-auto bg-[#0b0f17] text-[#d6dde8] font-mono text-[12px] leading-[1.5] p-3">
            {log.length === 0 && <div className="text-ink-3">waiting for output…</div>}
            {log.map((l) => (
              <div key={l.seq} className={`whitespace-pre-wrap break-all ${l.stream === 'sys' ? 'text-[#5ce1d3]' : l.stream === 'err' ? 'text-[#ffd48a]' : ''}`}>
                <span className="text-[#5b6a82] select-none">{fmtTime(l.t)} </span>{l.line}
              </div>
            ))}
          </div>
          {!follow && <button className="btn sm absolute bottom-3 right-3" onClick={() => { setFollow(true); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}><ChevronDown size={13} /> Follow</button>}
        </div>
      </div>
    </section>
  );
}

/** What happened to fips.yaml after the upgrade: template diff, the change to this node's file, deprecations. */
function ConfigOutcome({ c }: { c: ConfigMergeResult }) {
  const tone = c.status === 'applied' ? 'good' : c.status === 'proposed' ? 'warn' : c.status === 'failed' ? 'crit' : '';
  const label = { unchanged: 'template unchanged', current: 'already up to date', applied: 'updated', proposed: 'review needed', failed: 'not updated', skipped: 'skipped' }[c.status];
  return (
    <div className="grid gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5"><span className="text-ink-2">fips.yaml:</span><span className={`chip ${tone}`}><span className="chip-dot" />{label}</span>{(c.status === 'proposed' || c.status === 'failed') && <a className="text-ink-3 hover:text-ink" href="#/config">review on the Configuration page →</a>}</div>
      <div className="text-ink-3 break-words">{c.detail}</div>
      {!!c.deprecations?.length && <div className="text-warn break-words">Deprecated settings reported by the new daemon: {c.deprecations.join(' · ')}</div>}
      {c.configDiff && <details><summary className="cursor-pointer text-ink-2">Change to your fips.yaml</summary><DiffBlock text={c.configDiff} /></details>}
      {c.templateDiff && <details><summary className="cursor-pointer text-ink-2">Template change</summary><DiffBlock text={c.templateDiff} /></details>}
    </div>
  );
}

function DiffBlock({ text }: { text: string }) {
  return <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-snug">{text.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-good' : l.startsWith('-') && !l.startsWith('---') ? 'text-crit' : l.startsWith('@@') ? 'text-ink-3' : ''}>{l || ' '}</div>)}</pre>;
}
