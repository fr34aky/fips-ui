// Daemon logs: recent lines and one shared live follower, from whatever log system this OS uses (server/platform.ts).
import { EventEmitter } from 'node:events';
import { followLogs, recentLogs as platformRecent, LOGS, type LogLine } from './platform.ts';

export type { LogLine };
export const LOG_SOURCE = LOGS?.name ?? null;
export const recentLogs = platformRecent;

/** One follower process shared by every SSE subscriber. */
class LogFollower extends EventEmitter {
  private stop: (() => void) | null = null;
  private subscribers = 0;

  subscribe(fn: (line: LogLine) => void): () => void {
    this.subscribers++;
    this.on('line', fn);
    this.ensureRunning();
    return () => {
      this.off('line', fn);
      this.subscribers--;
      if (this.subscribers <= 0) { this.stop?.(); this.stop = null; }
    };
  }

  private ensureRunning() {
    if (this.stop || !LOGS) return;
    let stopped = false;
    const stop = followLogs((l) => this.emit('line', l), () => {
      if (this.stop === stopFn) this.stop = null;
      if (!stopped && this.subscribers > 0) setTimeout(() => this.ensureRunning(), 2000);
    });
    const stopFn = () => { stopped = true; stop(); };
    this.stop = stopFn;
  }
}

export const journal = new LogFollower();
