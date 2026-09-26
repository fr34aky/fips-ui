import { useMemo, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import { AlertTriangle, CheckCircle2, History, Power, RefreshCw, RotateCcw, Save, Undo2, XCircle } from 'lucide-react';
import { Card, Chip, ConfirmDialog, Empty, ErrorNote, Modal, Segmented, Skeleton, useToast } from '../components/ui';
import { HelperGate } from '../components/HelperGate';
import { adminApi, withResult, type ApplyResult, type ConfigBackup } from '../lib/admin';
import { usePoll } from '../lib/api';
import { diffStats, lineDiff, withContext, type DiffLine } from '../lib/diff';
import { fmtAgo, fmtBytes } from '../lib/format';

const REDACTED = '"<redacted #N>"';
const PLACEHOLDER_RE = /<redacted #\d+>/g;


export default function Config({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const status = usePoll(() => adminApi.status(), [], 30000);
  const helper = status.data?.helper;
  const cfg = usePoll(() => (helper?.managementCapable ? adminApi.config() : Promise.resolve(null)), [helper?.managementCapable], 0);
  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<'edit' | 'diff'>('edit');
  const [restart, setRestart] = useState(true);
  const [confirm, setConfirm] = useState<null | 'apply' | 'restart' | { restore: ConfigBackup }>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [viewBackup, setViewBackup] = useState<{ id: string; yaml: string } | null>(null);

  // Browsers edit with LF line endings; compare and diff in LF (the helper keeps a CRLF file CRLF on save).
  const original = (cfg.data?.yaml ?? '').replace(/\r\n/g, '\n');
  const text = draft ?? original;
  const dirty = draft !== null && draft !== original;

  const parsed = useMemo(() => {
    if (!text) return { errors: [] as { line: number; message: string }[], warnings: [] as string[] };
    const doc = parseDocument(text, { prettyErrors: false });
    const lineOf = (pos?: [number, number]) => (pos ? text.slice(0, pos[0]).split('\n').length : 0);
    const errors = doc.errors.map((e) => ({ line: lineOf(e.pos), message: e.message.split('\n')[0] }));
    const warnings: string[] = [];
    if (!errors.length) {
      const js = doc.toJS() as Record<string, unknown> | null;
      if (!js || typeof js !== 'object' || Array.isArray(js)) errors.push({ line: 1, message: 'the top level must be a mapping (node:, transports:, peers: …)' });
      else if (!('node' in js) && !('transports' in js)) warnings.push('neither node: nor transports: is present; is this the right file?');
    }
    const origRedacted = (original.match(PLACEHOLDER_RE) ?? []).length, nowRedacted = (text.match(PLACEHOLDER_RE) ?? []).length;
    if (nowRedacted < origRedacted) warnings.push(`${origRedacted - nowRedacted} redacted secret line(s) were removed or changed; that secret will be deleted from the file.`);
    return { errors, warnings };
  }, [text, original]);

  const diff = useMemo(() => (dirty ? lineDiff(original, text) : []), [dirty, original, text]);
  const stats = diffStats(diff);

  const apply = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await withResult(adminApi.apply(text, restart, cfg.data?.base ?? ''));
      setResult(r);
      if (r.ok) { toast('ok', r.changed ? (r.restarted ? 'Configuration applied and the daemon is healthy' : 'Configuration saved; restart the daemon to apply it') : 'No changes to apply'); setDraft(null); cfg.refresh(); }
      else toast('err', r.error ?? 'Apply failed');
    } catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); setConfirm(null); }
  };
  const restore = async (b: ConfigBackup) => {
    setBusy(true); setResult(null);
    try { const r = await withResult(adminApi.restore(b.id)); setResult(r); if (r.ok) { toast('ok', `Restored ${b.id}`); setDraft(null); cfg.refresh(); } else toast('err', r.error ?? 'Restore failed'); }
    catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); setConfirm(null); }
  };
  const restartNode = async () => {
    setBusy(true);
    try { await adminApi.service('fips', 'restart'); toast('ok', 'fips.service restarted'); }
    catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); setConfirm(null); }
  };

  return (
    <div className="grid gap-4 fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-ink-2 text-sm max-w-3xl">Edit <code>/etc/fips/fips.yaml</code>. Secret values stay on the node: they are shown as <code>{REDACTED}</code> placeholders, and restored on save as long as each stays under its key and entry. Applying backs up the current file, restarts the daemon and <b>rolls back automatically</b> if it does not stay up. See the <a className="underline hover:text-ink" href="https://github.com/jmcorgan/fips/blob/master/docs/reference/configuration.md" target="_blank" rel="noreferrer">configuration reference</a>.</p>
        {!readOnly && helper?.managementCapable && <button className="btn ml-auto" disabled={busy} onClick={() => setConfirm('restart')}><Power size={15} />Restart node</button>}
      </div>

      <HelperGate helper={helper}>
        {cfg.error && <ErrorNote>{cfg.error}</ErrorNote>}
        {result && <ResultNote r={result} />}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Card pad={false} className="overflow-hidden min-h-[420px]">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
              <Segmented value={view} onChange={setView} options={[{ value: 'edit', label: 'Edit' }, { value: 'diff', label: <>Changes{dirty ? <span className="text-ink-3 ml-1">+{stats.added} −{stats.removed}</span> : null}</> }]} />
              {parsed.errors.length > 0 ? <Chip tone="crit">YAML error{parsed.errors.length > 1 ? `s (${parsed.errors.length})` : ''}</Chip> : text ? <Chip tone="good">valid YAML</Chip> : null}
              {dirty && <Chip tone="warn">unsaved</Chip>}
              <div className="ml-auto flex items-center gap-2">
                {dirty && <button className="btn sm ghost" onClick={() => setDraft(null)}><Undo2 size={14} />Discard</button>}
                <button className="btn sm ghost" onClick={() => { setDraft(null); cfg.refresh(); }} title="Reload from disk"><RefreshCw size={14} /></button>
              </div>
            </div>
            {!cfg.data ? <div className="p-4"><Skeleton className="h-80 w-full" /></div> : view === 'edit'
              ? <YamlEditor value={text} onChange={setDraft} errorLines={parsed.errors.map((e) => e.line)} readOnly={readOnly} />
              : dirty ? <DiffView lines={diff} /> : <Empty>No changes yet.</Empty>}
            {(parsed.errors.length > 0 || parsed.warnings.length > 0) && (
              <div className="border-t border-line px-4 py-2.5 grid gap-1 text-xs">
                {parsed.errors.map((e, i) => <div key={i} className="text-crit flex gap-2"><XCircle size={13} className="mt-0.5 shrink-0" />line {e.line}: {e.message}</div>)}
                {parsed.warnings.map((w, i) => <div key={i} className="text-warn flex gap-2"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{w}</div>)}
              </div>
            )}
            {!readOnly && (
              <div className="border-t border-line px-4 py-3 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} className="accent-[var(--accent)]" />Restart the daemon and verify (auto-rollback)</label>
                <button className="btn primary ml-auto" disabled={!dirty || parsed.errors.length > 0 || busy} onClick={() => setConfirm('apply')}>{busy ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}{busy ? 'Applying…' : 'Apply'}</button>
              </div>
            )}
          </Card>

          <Card title="Backups" hint="Taken automatically before every apply or restore; the newest 20 are kept, root-only" pad={false}>
            {!cfg.data ? <Empty>Loading…</Empty> : cfg.data.backups.length === 0 ? <Empty>None yet.</Empty> : (
              <div className="max-h-[520px] overflow-y-auto">
                {cfg.data.backups.map((b) => (
                  <div key={b.id} className="px-4 py-2.5 border-b border-line last:border-0 flex items-center gap-2">
                    <History size={14} className="text-ink-3 shrink-0" />
                    <div className="min-w-0"><div className="text-sm mono truncate">{b.id}</div><div className="text-[11px] text-ink-3">{fmtAgo(b.mtime * 1000)} · {fmtBytes(b.size)}</div></div>
                    <div className="ml-auto flex gap-1">
                      <button className="btn sm ghost" onClick={async () => { try { setViewBackup(await adminApi.backup(b.id)); } catch (e) { toast('err', (e as Error).message); } }}>View</button>
                      {!readOnly && <button className="btn sm" disabled={busy} onClick={() => setConfirm({ restore: b })}><RotateCcw size={13} /></button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </HelperGate>

      <ConfirmDialog open={confirm === 'apply'} onClose={() => setConfirm(null)} onConfirm={apply} busy={busy} danger title="Apply configuration?" confirmLabel={restart ? 'Apply and restart' : 'Save'}
        body={<div className="grid gap-2"><div><b>+{stats.added} −{stats.removed}</b> lines. The current file is backed up first.</div>{restart ? <div>The daemon restarts: every peer link and session drops briefly. If it does not stay up for a few seconds, the previous file is restored and the daemon restarted again.</div> : <div>The file is saved but the running daemon keeps the old configuration until it restarts; nothing verifies the new file yet.</div>}{parsed.warnings.map((w, i) => <div key={i} className="text-warn">{w}</div>)}</div>} />
      <ConfirmDialog open={confirm === 'restart'} onClose={() => setConfirm(null)} onConfirm={restartNode} busy={busy} danger title="Restart the FIPS daemon?" confirmLabel="Restart" body="Every peer link and end-to-end session drops; peers reconnect automatically within seconds." />
      <ConfirmDialog open={!!confirm && typeof confirm === 'object'} onClose={() => setConfirm(null)} onConfirm={() => typeof confirm === 'object' && confirm && restore(confirm.restore)} busy={busy} danger title="Restore this backup?" confirmLabel="Restore and restart"
        body={confirm && typeof confirm === 'object' ? <>The current file is backed up, <span className="mono">{confirm.restore.id}</span> is reinstalled and the daemon restarted, with the same automatic rollback.</> : null} />
      <Modal open={!!viewBackup} onClose={() => setViewBackup(null)} title={`Backup ${viewBackup?.id ?? ''} vs current`} width="max-w-4xl">
        {viewBackup && <div className="max-h-[70vh] overflow-auto rounded-lg border border-line">{viewBackup.yaml === original ? <Empty>Identical to the current file.</Empty> : <DiffView lines={lineDiff(viewBackup.yaml, original)} labels={['backup', 'current']} />}</div>}
      </Modal>
    </div>
  );
}

function ResultNote({ r }: { r: ApplyResult }) {
  if (r.ok) return <div className="card px-4 py-3 flex items-center gap-2 text-sm"><CheckCircle2 size={16} className="text-good" />{r.changed ? (r.restarted ? 'Applied; the daemon restarted and stayed healthy.' : 'Saved without restarting.') : 'The file was already identical; nothing changed.'}{r.backup_id && <span className="text-ink-3 ml-auto">backup {r.backup_id}</span>}</div>;
  return (
    <div className="card px-4 py-3 grid gap-2 text-sm" style={{ borderColor: 'rgba(208,59,59,0.5)' }}>
      <div className="flex items-center gap-2 text-crit font-medium"><XCircle size={16} />{r.error ?? 'Apply failed'}</div>
      {r.rolled_back && <div className="text-ink-2">The previous configuration was restored{r.restored_healthy ? ' and the daemon is healthy again.' : ', but the daemon did not come back cleanly either; check the Logs page.'}</div>}
      {r.journal && <pre className="max-h-60 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap">{r.journal}</pre>}
    </div>
  );
}

function YamlEditor({ value, onChange, errorLines, readOnly }: { value: string; onChange: (v: string) => void; errorLines: number[]; readOnly: boolean }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;
  const errs = new Set(errorLines);
  return (
    <div className="flex font-mono text-[12.5px] leading-[1.6] min-h-[420px] max-h-[65vh]">
      <div ref={gutter} className="select-none text-right text-ink-3 bg-surface-2 border-r border-line px-2 py-3 overflow-hidden" aria-hidden>
        {Array.from({ length: lines }, (_, i) => <div key={i} className={errs.has(i + 1) ? 'text-crit font-bold' : ''}>{i + 1}</div>)}
      </div>
      <textarea
        className="flex-1 resize-none bg-transparent outline-none px-3 py-3 whitespace-pre overflow-auto"
        spellCheck={false} autoCapitalize="off" autoCorrect="off" readOnly={readOnly} value={value} wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          e.preventDefault();
          const t = e.currentTarget, s = t.selectionStart, end = t.selectionEnd;
          onChange(t.value.slice(0, s) + '  ' + t.value.slice(end));
          requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
        }}
        aria-label="fips.yaml"
      />
    </div>
  );
}

export function DiffView({ lines, labels = ['current', 'edited'] }: { lines: DiffLine[]; labels?: [string, string] }) {
  const rows = withContext(lines);
  return (
    <div className="font-mono text-[12px] leading-[1.55] overflow-auto max-h-[65vh] py-2">
      <div className="px-3 pb-2 text-[11px] text-ink-3 font-sans"><span className="text-crit">− {labels[0]}</span> · <span className="text-good">+ {labels[1]}</span></div>
      {rows.map((l, i) => l === null
        ? <div key={i} className="px-3 text-ink-3 bg-surface-2">⋯</div>
        : <div key={i} className="grid grid-cols-[40px_40px_16px_1fr] px-1" style={{ background: l.kind === 'add' ? 'var(--good-soft)' : l.kind === 'del' ? 'var(--crit-soft)' : undefined }}>
            <span className="text-right text-ink-3 pr-2">{l.a ?? ''}</span><span className="text-right text-ink-3 pr-2">{l.b ?? ''}</span>
            <span className={l.kind === 'add' ? 'text-good' : l.kind === 'del' ? 'text-crit' : 'text-ink-3'}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="whitespace-pre">{l.text || ' '}</span>
          </div>)}
    </div>
  );
}
