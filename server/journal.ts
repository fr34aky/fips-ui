// journalctl access: recent lines and a shared live follower for fips.service.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export interface LogLine {
  ts: number;            // epoch ms
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown';
  target?: string;       // rust tracing target, e.g. fips::node::tree
  message: string;
  raw: string;
  cursor?: string;
}

const UNIT = process.env.FIPS_UNIT ?? 'fips.service';
const PRIORITY_TO_LEVEL: Record<string, LogLine['level']> = { '0': 'error', '1': 'error', '2': 'error', '3': 'error', '4': 'warn', '5': 'info', '6': 'info', '7': 'debug' };
// Rust tracing format: 2026-09-26T09:19:13.825944Z  INFO target: message
const TRACING_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s?(.*)$/s;

export function parseJournalEntry(entry: Record<string, unknown>): LogLine {
  const raw = String(entry.MESSAGE ?? '');
  const usec = Number(entry.__REALTIME_TIMESTAMP ?? 0);
  let ts = usec ? Math.floor(usec / 1000) : Date.now();
  let level: LogLine['level'] = PRIORITY_TO_LEVEL[String(entry.PRIORITY ?? '')] ?? 'unknown';
  let target: string | undefined;
  let message = raw;
  const m = TRACING_RE.exec(raw);
  if (m) {
    const parsed = Date.parse(m[1]);
    if (!Number.isNaN(parsed)) ts = parsed;
    level = m[2].toLowerCase() as LogLine['level'];
    target = m[3];
    message = m[4];
  }
  return { ts, level, target, message, raw, cursor: entry.__CURSOR as string | undefined };
}

export function recentLogs(lines = 300, since?: string): Promise<LogLine[]> {
  const args = ['-u', UNIT, '-o', 'json', '--no-pager', '-n', String(Math.min(Math.max(lines, 1), 5000))];
  if (since) args.push('--since', since);
  return new Promise((resolve) => {
    const child = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const out: LogLine[] = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (l) => { try { out.push(parseJournalEntry(JSON.parse(l))); } catch { /* skip */ } });
    rl.on('close', () => resolve(out));
    child.on('error', () => resolve(out));
  });
}

/** One journalctl -f process shared by every SSE subscriber. */
class JournalFollower extends EventEmitter {
  private child: ChildProcess | null = null;
  private subscribers = 0;

  subscribe(fn: (line: LogLine) => void): () => void {
    this.subscribers++;
    this.on('line', fn);
    this.ensureRunning();
    return () => {
      this.off('line', fn);
      this.subscribers--;
      if (this.subscribers <= 0) this.stop();
    };
  }

  private ensureRunning() {
    if (this.child) return;
    const child = spawn('journalctl', ['-u', UNIT, '-f', '-n', '0', '-o', 'json', '--no-pager'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (l) => { try { this.emit('line', parseJournalEntry(JSON.parse(l))); } catch { /* skip */ } });
    child.on('exit', () => { if (this.child === child) { this.child = null; if (this.subscribers > 0) setTimeout(() => this.ensureRunning(), 2000); } });
    child.on('error', () => { if (this.child === child) this.child = null; });
  }

  private stop() {
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

export const journal = new JournalFollower();
