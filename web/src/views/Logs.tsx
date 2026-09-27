import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Trash2, ArrowDown, Search } from 'lucide-react';
import type { LogLine } from '../lib/types';
import { api, useLiveLogs, seedLogs } from '../lib/api';
import { Card, Segmented, Empty } from '../components/ui';
import { fmtTime } from '../lib/format';

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
type Level = (typeof LEVELS)[number];
const RANK: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4, unknown: 2 };

export function Logs() {
  const lines = useLiveLogs();
  const [minLevel, setMinLevel] = useState<Level>('info');
  const [q, setQ] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [seeded, setSeeded] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  // The daemon's log file may be unreadable for the UI's user (FreeBSD creates it root-only).
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const load = () => api.get<{ lines: LogLine[]; unreadable?: string }>('/api/logs?lines=600').then((r) => { seedLogs(r.lines); setUnreadable(r.unreadable ?? null); setSeeded(true); }).catch(() => setSeeded(true));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const grantAccess = async () => {
    setFixing(true);
    try { await api.post('/api/admin/log-access', {}); await load(); }
    catch (e) { alert((e as Error).message); }
    finally { setFixing(false); }
  };

  const source = paused && frozen ? frozen : lines;
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const max = RANK[minLevel];
    return source.filter((l) => RANK[l.level] <= max && (!t || l.message.toLowerCase().includes(t) || l.target?.toLowerCase().includes(t))).slice(-1500);
  }, [source, q, minLevel]);

  useEffect(() => { if (!paused && atBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [filtered, paused, atBottom]);
  useEffect(() => { if (paused && frozen) setHidden(lines.length - frozen.length); }, [lines, paused, frozen]);

  const togglePause = () => { if (paused) { setPaused(false); setFrozen(null); setHidden(0); } else { setPaused(true); setFrozen(lines); } };
  const onScroll = () => { const el = scroller.current; if (!el) return; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const l of source) c[l.level] = (c[l.level] ?? 0) + 1; return c; }, [source]);

  return (
    <div className="grid gap-3 fade-in" style={{ height: 'calc(100dvh - 120px)' }}>
      {unreadable && (
        <div className="card px-4 py-3 text-sm flex flex-wrap items-center gap-3" style={{ borderColor: 'rgba(214,158,46,0.5)' }}>
          <span>The daemon's log <code>{unreadable}</code> is readable by root only, so this page cannot show it. Admins can let the fips group read it (the file's contents and owner stay as they are).</span>
          <button className="btn sm ml-auto" disabled={fixing} onClick={() => void grantAccess()}>{fixing ? 'Granting…' : 'Let the fips group read it'}</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={minLevel} onChange={setMinLevel} options={LEVELS.map((l) => ({ value: l, label: <span className="capitalize">{l}{counts[l] ? <span className="text-ink-3 ml-1">{counts[l]}</span> : null}</span> }))} />
        <div className="relative flex-1 min-w-[180px] max-w-md"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" /><input className="input pl-9" placeholder="Search message or target…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="ml-auto flex items-center gap-2">
          <button className={`btn sm ${paused ? 'primary' : ''}`} onClick={togglePause}>{paused ? <><Play size={14} />Resume{hidden > 0 ? ` (+${hidden})` : ''}</> : <><Pause size={14} />Pause</>}</button>
          <button className="btn sm ghost" onClick={() => { setFrozen([]); setPaused(true); }} title="Clear view"><Trash2 size={14} /></button>
        </div>
      </div>
      <Card pad={false} className="min-h-0 relative">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto py-1 rounded-[var(--radius)]">
          {filtered.length === 0 ? <Empty>{seeded ? 'No log lines match.' : 'Loading journal…'}</Empty> : filtered.map((l, i) => (
            <div key={l.cursor ?? `${l.ts}-${i}`} className={`log-line ${l.level}`}>
              <span className="text-ink-3 tabular" title={new Date(l.ts).toISOString()}>{fmtTime(l.ts)}</span>
              <span className="lvl">{l.level}</span>
              <span className="msg">{l.target && <span className="tgt">{l.target.replace(/^fips::/, '')} </span>}{highlight(l.message, q)}</span>
            </div>
          ))}
        </div>
        {!atBottom && <button className="btn sm absolute bottom-3 right-4 shadow-lg" onClick={() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }}><ArrowDown size={14} />Latest</button>}
      </Card>
    </div>
  );
}

function highlight(text: string, q: string) {
  const t = q.trim();
  if (!t) return text;
  const idx = text.toLowerCase().indexOf(t.toLowerCase());
  if (idx < 0) return text;
  return <>{text.slice(0, idx)}<mark style={{ background: 'var(--warn-soft)', color: 'inherit', borderRadius: 3 }}>{text.slice(idx, idx + t.length)}</mark>{text.slice(idx + t.length)}</>;
}
