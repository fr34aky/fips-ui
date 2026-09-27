// Types and client for the node upgrade API (server/upgrade.ts).
import { useEffect, useRef, useState } from 'react';
import { api, getToken, ApiError } from './api';

export type UpgradeSource = 'release' | 'master';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepInfo { name: string; label: string; state: StepState; startedAt?: number; endedAt?: number; detail?: string }
export interface JobLogLine { seq: number; t: number; stream: 'out' | 'err' | 'sys'; line: string }
export interface ConfigMergeResult { status: 'unchanged' | 'current' | 'applied' | 'proposed' | 'failed' | 'skipped'; detail: string; fromRev?: string; toRef?: string; templateDiff?: string; configDiff?: string; deprecations?: string[] }
export interface JobResult { stagedVersion?: string; backupId?: string; restarted?: boolean; runningVersion?: string; stageDir?: string; artifact?: string; config?: ConfigMergeResult }
export type JobKind = 'upgrade' | 'rollback' | 'toolchain' | 'helper';
export interface JobSummary {
  id: string; kind: JobKind; source: UpgradeSource; ref: string; restart: boolean; dryRun: boolean;
  state: JobState; cancellable: boolean; steps: StepInfo[];
  startedAt: number; endedAt?: number; error?: string; result?: JobResult; logLines: number;
}
export interface Backup { id: string; createdAt: number; version: string; files: string[] }

export interface UpgradeStatus {
  platform: { os: string; arch: string; pfsense?: { abi: string; tag: string | null } | null; artifactKind: 'archive' | 'pkg'; installer: string; binDir: string; workDir: string; controlSocket: string };
  installed: { path: string | null; version?: string; rev?: string; target?: string; raw?: string };
  running: { version?: string; rev?: string; uptime_secs?: number; pid?: number } | null;
  package: { manager: string; name: string; version?: string; note: string } | null;
  helper: { available: boolean; error?: string; detail?: string };
  toolchain: Record<string, { ok: boolean; required: boolean; detail?: string }>;
  toolchainPlan: { manager: string | null; sudo: boolean; packages: string[]; command: string[]; note?: string; missing: string[] };
  helperInstallScript: string | null;
  backups: Backup[];
  release: { tag: string; name: string; publishedAt: string; url: string; prerelease: boolean; notes: string; asset: { name: string; size: number } | null; checksums: boolean; relation: 'newer' | 'same' | 'older' | 'unknown' } | { error: string };
  master: { sha: string; subject: string; date: string; url: string; ahead: { ahead_by: number; behind_by: number; commits: { sha: string; subject: string; date: string; url: string }[] } | null; relation: 'newer' | 'same' | 'unknown' } | { error: string };
  restartPending: boolean;
  job: JobSummary | null;
}

export const upgradeApi = {
  status: (force = false) => api.get<UpgradeStatus>(`/api/upgrade/status${force ? '?refresh=1' : ''}`),
  start: (body: { source: UpgradeSource; ref?: string; restart?: boolean; dryRun?: boolean; mergeConfig?: boolean }) => api.post<JobSummary>('/api/upgrade/jobs', body),
  cancel: () => api.post<{ cancelled: boolean }>('/api/upgrade/jobs/current/cancel'),
  rollback: (id: string) => api.post<JobSummary>('/api/upgrade/rollback', { id }),
  restart: () => api.post<{ output: string }>('/api/upgrade/restart'),
  current: (since = 0) => api.get<JobSummary & { log: JobLogLine[] }>(`/api/upgrade/jobs/current?since=${since}`),
};

/**
 * Follow the current job over SSE. Re-subscribes when `jobId` changes, keeps
 * the full log locally, and falls back to polling if the stream drops.
 */
export function useUpgradeJob(jobId: string | null | undefined): { job: JobSummary | null; log: JobLogLine[] } {
  const [job, setJob] = useState<JobSummary | null>(null);
  const [log, setLog] = useState<JobLogLine[]>([]);
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!jobId) { setJob(null); setLog([]); lastSeq.current = 0; return; }
    setLog([]); lastSeq.current = 0;
    let es: EventSource | null = null;
    let closed = false;
    const tok = getToken();

    const push = (l: JobLogLine) => { if (l.seq > lastSeq.current) { lastSeq.current = l.seq; setLog((prev) => (prev.length > 5000 ? [...prev.slice(-4000), l] : [...prev, l])); } };
    const open = () => {
      if (closed) return;
      es = new EventSource(`/api/upgrade/jobs/current/events?since=${lastSeq.current}${tok ? `&token=${encodeURIComponent(tok)}` : ''}`);
      es.addEventListener('log', (ev) => push(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener('state', (ev) => { const s: JobSummary = JSON.parse((ev as MessageEvent).data); setJob(s); if (s.state !== 'running' && s.state !== 'queued') { es?.close(); es = null; } });
      es.onerror = () => {
        es?.close(); es = null;
        if (closed) return;
        // Fallback: poll once for the state, then retry the stream.
        upgradeApi.current(lastSeq.current)
          .then((s) => { s.log.forEach(push); setJob(s); if (s.state === 'running' || s.state === 'queued') setTimeout(open, 2000); })
          .catch((e) => {
            // 404: the backend restarted and no longer knows this job. Stop, and show that instead of spinning forever.
            if (e instanceof ApiError && e.status === 404) { closed = true; setJob((prev) => prev && (prev.state === 'running' || prev.state === 'queued') ? { ...prev, state: 'failed', error: 'the UI backend restarted while this job was running; its outcome is unknown. Check the versions above.', cancellable: false, endedAt: Date.now() } : prev); return; }
            setTimeout(open, 3000);
          });
      };
    };
    open();
    return () => { closed = true; es?.close(); };
  }, [jobId]);

  return { job, log };
}
