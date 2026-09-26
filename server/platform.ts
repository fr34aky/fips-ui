// Operating-system adapters: which service manager runs fips, how to read its state, act on it, and read its logs.
//
// Supported: Linux with systemd, OpenRC or OpenWrt's procd; macOS (launchd); FreeBSD (rc.d); Windows (SCM).
// Everything here is read-only except serviceAction(), which needs the privileges of the respective tool.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type OsName = 'linux' | 'macos' | 'freebsd' | 'windows' | 'other';
export type ServiceManager = 'systemd' | 'openrc' | 'procd' | 'launchd' | 'rc' | 'scm' | 'none';

export interface Platform { os: OsName; distro?: string; serviceManager: ServiceManager }

function detect(): Platform {
  const p = os.platform();
  if (p === 'darwin') return { os: 'macos', serviceManager: 'launchd' };
  if (p === 'freebsd') return { os: 'freebsd', serviceManager: 'rc' };
  if (p === 'win32') return { os: 'windows', serviceManager: 'scm' };
  if (p !== 'linux') return { os: 'other', serviceManager: 'none' };
  let distro: string | undefined;
  try { distro = /^ID=("?)([^"\n]+)\1$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[2]; } catch { /* no os-release */ }
  if (existsSync('/etc/openwrt_release') || distro === 'openwrt') return { os: 'linux', distro: 'openwrt', serviceManager: 'procd' };
  if (existsSync('/run/systemd/system')) return { os: 'linux', distro, serviceManager: 'systemd' };
  if (existsSync('/sbin/openrc-run') || existsSync('/sbin/rc-service')) return { os: 'linux', distro, serviceManager: 'openrc' };
  return { os: 'linux', distro, serviceManager: 'none' };
}

export const PLATFORM: Platform = (() => {
  const d = detect();
  const forced = process.env.FIPS_UI_SERVICE_MANAGER as ServiceManager | undefined;
  return forced ? { ...d, serviceManager: forced } : d;
})();

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

/** Logical services the UI shows; each OS maps them to its own unit, label or service name. */
export const SERVICES = ['fips', 'fips-dns', 'fips-firewall', 'fips-gateway'] as const;
export type ServiceId = (typeof SERVICES)[number];

/** The unit/service names used by the packaging for each service manager (env overrides per service). */
function nativeName(id: ServiceId): string | null {
  const env = process.env[`FIPS_UI_SERVICE_${id.replace(/-/g, '_').toUpperCase()}`];
  if (env) return env;
  switch (PLATFORM.serviceManager) {
    case 'systemd': return `${id}.service`;
    case 'launchd': return id === 'fips' ? 'com.fips.daemon' : id === 'fips-gateway' ? 'com.fips.gateway' : null;
    case 'rc': return id === 'fips' ? 'fips' : id === 'fips-gateway' ? 'fips_gateway' : null;
    case 'scm': return id === 'fips' ? 'fips' : id === 'fips-gateway' ? 'fips-gateway' : null;
    case 'openrc': case 'procd': return id === 'fips' || id === 'fips-gateway' ? id : null;
    default: return null;
  }
}

export interface UnitState {
  unit: string;         // native name (e.g. fips.service, com.fips.daemon)
  id: ServiceId;
  loaded: boolean;
  active: string;       // active | inactive | failed | activating | unknown
  sub: string;          // running | exited | dead | ...
  description: string;
  since?: number;       // epoch ms the current run started
  mainPid?: number;
  memoryBytes?: number;
  cpuUsageNs?: number;
  restarts?: number;
  unitFileState?: string;  // enabled | disabled | static | ... (where the OS has the concept)
}

const DESCRIPTIONS: Record<ServiceId, string> = {
  fips: 'FIPS Mesh Network Daemon',
  'fips-dns': 'DNS routing for the .fips domain',
  'fips-firewall': 'fips0 nftables baseline',
  'fips-gateway': 'FIPS LAN gateway',
};

const run = async (cmd: string, args: string[], timeout = 10_000): Promise<{ code: number; out: string }> => {
  try { const { stdout } = await execFileP(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); return { code: 0, out: String(stdout) }; }
  catch (e) { const x = e as { code?: number; stdout?: string }; return { code: typeof x.code === 'number' ? x.code : 127, out: String(x.stdout ?? '') }; }
};

/** Start time of a process in epoch ms, from ps (POSIX) — used where the service manager does not report it. */
async function processStart(pid: number): Promise<number | undefined> {
  if (PLATFORM.os === 'windows' || !pid) return undefined;
  const r = await run('ps', ['-o', 'etimes=', '-p', String(pid)]);
  const secs = Number(r.out.trim());
  if (r.code === 0 && Number.isFinite(secs) && r.out.trim()) return Date.now() - secs * 1000;
  // BSD/macOS ps has no etimes: use etime ([[dd-]hh:]mm:ss).
  const e = await run('ps', ['-o', 'etime=', '-p', String(pid)]);
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(e.out.trim());
  if (!m) return undefined;
  const s = (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + Number(m[3]) * 60 + Number(m[4]);
  return Date.now() - s * 1000;
}

// ---- systemd --------------------------------------------------------------------------------
// Timestamps: `--timestamp=unix` (systemd >= 251) yields `@<epoch-seconds>`; older systemd rejects the flag, so it is
// probed once and the monotonic properties are converted with CLOCK_MONOTONIC (process.hrtime), which like
// systemd's clock excludes suspend.
const PROPS = ['LoadState', 'ActiveState', 'SubState', 'Description', 'ActiveEnterTimestamp', 'ExecMainStartTimestamp', 'ActiveEnterTimestampMonotonic', 'ExecMainStartTimestampMonotonic', 'MainPID', 'MemoryCurrent', 'CPUUsageNSec', 'NRestarts', 'UnitFileState'];
let unixTimestamps: boolean | null = null;

async function systemdStates(): Promise<UnitState[]> {
  const ids = SERVICES.filter((id) => nativeName(id));
  const names = ids.map((id) => nativeName(id)!);
  const base = ['show', ...names, '-p', PROPS.join(','), '--no-pager'];
  let stdout: string;
  try {
    if (unixTimestamps !== false) {
      try { stdout = (await execFileP('systemctl', [...base, '--timestamp=unix'])).stdout; unixTimestamps = true; }
      catch (e) { if (unixTimestamps === true) throw e; unixTimestamps = false; stdout = (await execFileP('systemctl', base)).stdout; }
    } else stdout = (await execFileP('systemctl', base)).stdout;
  } catch { return []; }
  const bootEpochMs = Date.now() - Number(process.hrtime.bigint() / 1_000_000n);
  return stdout.trim().split(/\n\s*\n/).map((block, i) => {
    const kv: Record<string, string> = {};
    for (const line of block.split('\n')) { const eq = line.indexOf('='); if (eq > 0) kv[line.slice(0, eq)] = line.slice(eq + 1); }
    const num = (s?: string) => (s && s !== '[not set]' && !Number.isNaN(Number(s)) ? Number(s) : undefined);
    const unix = /^@(\d+)/.exec(kv.ExecMainStartTimestamp || kv.ActiveEnterTimestamp || '');
    const monoUs = num(kv.ExecMainStartTimestampMonotonic) || num(kv.ActiveEnterTimestampMonotonic);
    const since = unix ? Number(unix[1]) * 1000 : monoUs ? bootEpochMs + monoUs / 1000 : undefined;
    return {
      unit: names[i], id: ids[i], loaded: kv.LoadState === 'loaded', active: kv.ActiveState ?? 'unknown', sub: kv.SubState ?? 'unknown',
      description: kv.Description || DESCRIPTIONS[ids[i]], since, mainPid: num(kv.MainPID) || undefined, memoryBytes: num(kv.MemoryCurrent),
      cpuUsageNs: num(kv.CPUUsageNSec), restarts: num(kv.NRestarts), unitFileState: kv.UnitFileState,
    };
  });
}

// ---- other service managers: one probe per service ------------------------------------------
async function probe(id: ServiceId, name: string): Promise<UnitState> {
  const base: UnitState = { unit: name, id, loaded: false, active: 'unknown', sub: 'unknown', description: DESCRIPTIONS[id] };
  switch (PLATFORM.serviceManager) {
    case 'launchd': {
      const r = await run('launchctl', ['print', `system/${name}`]);
      if (r.code !== 0) return { ...base, active: 'inactive', sub: 'not loaded' };
      const state = /^\s*state = (\S+)/m.exec(r.out)?.[1] ?? 'unknown';
      const pid = Number(/^\s*pid = (\d+)/m.exec(r.out)?.[1] ?? 0) || undefined;
      const runs = Number(/^\s*runs = (\d+)/m.exec(r.out)?.[1] ?? 0);
      return { ...base, loaded: true, active: state === 'running' ? 'active' : 'inactive', sub: state, mainPid: pid, since: pid ? await processStart(pid) : undefined, restarts: runs > 0 ? runs - 1 : undefined };
    }
    case 'rc': case 'openrc': {
      const [cmd, args] = PLATFORM.serviceManager === 'rc' ? ['service', [name, 'status']] : ['rc-service', [name, 'status']];
      const r = await run(cmd, args as string[]);
      const exists = PLATFORM.serviceManager === 'rc' ? existsSync(`/usr/local/etc/rc.d/${name}`) || existsSync(`/etc/rc.d/${name}`) : existsSync(`/etc/init.d/${name}`);
      if (!exists) return base;
      const pid = Number(/pid (\d+)/i.exec(r.out)?.[1] ?? 0) || undefined;
      const running = r.code === 0 && /running|started/i.test(r.out);
      let enabled: string | undefined;
      if (PLATFORM.serviceManager === 'rc') enabled = (await run('service', [name, 'enabled'])).code === 0 ? 'enabled' : 'disabled';
      else enabled = (await run('rc-update', ['show', 'default'])).out.split('\n').some((l) => l.trim().startsWith(`${name} `)) ? 'enabled' : 'disabled';
      return { ...base, loaded: true, active: running ? 'active' : 'inactive', sub: running ? 'running' : 'stopped', mainPid: pid, since: pid ? await processStart(pid) : undefined, unitFileState: enabled };
    }
    case 'procd': {
      if (!existsSync(`/etc/init.d/${name}`)) return base;
      const r = await run('ubus', ['call', 'service', 'list', JSON.stringify({ name })]);
      let pid: number | undefined, running = false;
      try {
        const inst = (JSON.parse(r.out) as Record<string, { instances?: Record<string, { running?: boolean; pid?: number }> }>)[name]?.instances ?? {};
        const first = Object.values(inst)[0];
        running = !!first?.running; pid = first?.pid;
      } catch { /* ubus unavailable */ }
      const enabled = (await run(`/etc/init.d/${name}`, ['enabled'])).code === 0 ? 'enabled' : 'disabled';
      return { ...base, loaded: true, active: running ? 'active' : 'inactive', sub: running ? 'running' : 'stopped', mainPid: pid, since: pid ? await processStart(pid) : undefined, unitFileState: enabled };
    }
    case 'scm': {
      const r = await run('sc.exe', ['queryex', name]);
      if (r.code !== 0 || /FAILED 1060/.test(r.out)) return base;
      const state = /STATE\s*:\s*\d+\s+(\S+)/.exec(r.out)?.[1] ?? 'UNKNOWN';
      const pid = Number(/PID\s*:\s*(\d+)/.exec(r.out)?.[1] ?? 0) || undefined;
      const c = await run('sc.exe', ['qc', name]);
      const start = /START_TYPE\s*:\s*\d+\s+(\S+)/.exec(c.out)?.[1];
      return { ...base, loaded: true, active: state === 'RUNNING' ? 'active' : state.endsWith('PENDING') ? 'activating' : 'inactive', sub: state.toLowerCase(), mainPid: pid, unitFileState: start === 'AUTO_START' ? 'enabled' : start === 'DISABLED' ? 'disabled' : start?.toLowerCase() };
    }
    default: return base;
  }
}

export async function unitStates(): Promise<UnitState[]> {
  if (PLATFORM.serviceManager === 'systemd') return systemdStates();
  if (PLATFORM.serviceManager === 'none') return [];
  const ids = SERVICES.filter((id) => nativeName(id));
  const states = await Promise.all(ids.map((id) => probe(id, nativeName(id)!).catch(() => null)));
  return states.filter((s): s is UnitState => !!s && s.loaded);
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload';

/** The native unit name for a UI service id, or null if this OS has no such service. */
export function unitName(id: ServiceId): string | null { return nativeName(id); }

/** Run a service action with the OS's tool. Needs privileges (root, polkit, or an elevated Windows process). */
export async function serviceAction(id: ServiceId, action: ServiceAction): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = nativeName(id);
  if (!name) return { ok: false, error: `${id} is not a service on this system` };
  let cmd: string, args: string[];
  switch (PLATFORM.serviceManager) {
    case 'systemd': [cmd, args] = ['systemctl', [action === 'reload' ? 'reload-or-restart' : action, name]]; break;
    case 'launchd':
      [cmd, args] = action === 'stop' ? ['launchctl', ['kill', 'TERM', `system/${name}`]] : action === 'start' ? ['launchctl', ['kickstart', `system/${name}`]] : ['launchctl', ['kickstart', '-k', `system/${name}`]];
      break;
    case 'rc': [cmd, args] = ['service', [name, action === 'reload' ? 'restart' : action]]; break;
    case 'openrc': [cmd, args] = ['rc-service', [name, action === 'reload' ? 'restart' : action]]; break;
    case 'procd': [cmd, args] = [`/etc/init.d/${name}`, [action === 'reload' ? 'restart' : action]]; break;
    case 'scm':
      if (action === 'restart' || action === 'reload') {
        const s = await run('sc.exe', ['stop', name], 60_000);
        if (s.code !== 0 && !/1062/.test(s.out)) return { ok: false, error: s.out.trim() || 'sc stop failed' };
        await new Promise((r) => setTimeout(r, 2000));
        [cmd, args] = ['sc.exe', ['start', name]];
      } else [cmd, args] = ['sc.exe', [action, name]];
      break;
    default: return { ok: false, error: 'no supported service manager found' };
  }
  try { await execFileP(cmd, args, { timeout: 90_000, windowsHide: true }); return { ok: true }; }
  catch (e) { const err = e as { stderr?: string; stdout?: string; message?: string }; return { ok: false, error: (err.stderr || err.stdout || err.message || `${cmd} failed`).trim() }; }
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown';
export interface LogLine { ts: number; level: LogLevel; target?: string; message: string; raw: string; cursor?: string }

// Rust tracing format: 2026-09-26T09:19:13.825944Z  INFO target: message (optionally ANSI-coloured)
const TRACING_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s?(.*)$/s;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Parse one fips log message; `fallbackTs`/`fallbackLevel` come from the log system when the line has none. */
export function parseMessage(raw: string, fallbackTs = Date.now(), fallbackLevel: LogLevel = 'unknown', cursor?: string): LogLine {
  const clean = raw.replace(ANSI_RE, '');
  const m = TRACING_RE.exec(clean.slice(clean.search(/\d{4}-\d{2}-\d{2}T/) >= 0 ? clean.search(/\d{4}-\d{2}-\d{2}T/) : 0));
  if (m) {
    const t = Date.parse(m[1]);
    return { ts: Number.isNaN(t) ? fallbackTs : t, level: m[2].toLowerCase() as LogLevel, target: m[3], message: m[4], raw: clean, cursor };
  }
  return { ts: fallbackTs, level: fallbackLevel, message: clean, raw: clean, cursor };
}

const PRIORITY_TO_LEVEL: Record<string, LogLevel> = { '0': 'error', '1': 'error', '2': 'error', '3': 'error', '4': 'warn', '5': 'info', '6': 'info', '7': 'debug' };

export interface LogSource {
  name: string;
  /** argv producing recent lines, and the parser for one output line. */
  recent(lines: number, since?: string): [string, string[]] | null;
  /** argv producing a live stream. */
  follow(): [string, string[]] | null;
  parse(line: string): LogLine | null;
}

const LOG_FILE = process.env.FIPS_UI_LOG_FILE;
const fileSource = (file: string): LogSource => ({
  name: `file ${file}`,
  recent: (n) => PLATFORM.os === 'windows'
    ? ['powershell.exe', ['-NoProfile', '-Command', `Get-Content -Tail ${n} -LiteralPath '${file.replace(/'/g, "''")}'`]]
    : ['tail', ['-n', String(n), file]],
  follow: () => PLATFORM.os === 'windows'
    ? ['powershell.exe', ['-NoProfile', '-Command', `Get-Content -Wait -Tail 0 -LiteralPath '${file.replace(/'/g, "''")}'`]]
    : ['tail', ['-n', '0', '-F', file]],
  parse: (l) => (l.trim() ? parseMessage(l) : null),
});

function logSource(): LogSource | null {
  if (LOG_FILE) return fileSource(LOG_FILE);
  const unit = process.env.FIPS_UNIT ?? 'fips.service';
  switch (PLATFORM.serviceManager) {
    case 'systemd':
      return {
        name: 'journald',
        recent: (n, since) => ['journalctl', ['-u', unit, '-o', 'json', '--no-pager', '-n', String(n), ...(since ? ['--since', since] : [])]],
        follow: () => ['journalctl', ['-u', unit, '-f', '-n', '0', '-o', 'json', '--no-pager']],
        parse: (l) => {
          let e: Record<string, unknown>;
          try { e = JSON.parse(l); } catch { return null; }
          const usec = Number(e.__REALTIME_TIMESTAMP ?? 0);
          return parseMessage(String(e.MESSAGE ?? ''), usec ? Math.floor(usec / 1000) : Date.now(), PRIORITY_TO_LEVEL[String(e.PRIORITY ?? '')] ?? 'unknown', e.__CURSOR as string | undefined);
        },
      };
    case 'procd':
      // OpenWrt's logd ring buffer; fips logs to stderr, which procd forwards with the process name.
      return {
        name: 'logread',
        recent: (n) => ['sh', ['-c', `logread -e fips | tail -n ${Math.floor(n)}`]],
        follow: () => ['logread', ['-f', '-e', 'fips']],
        parse: (l) => (l.trim() ? parseMessage(l.replace(/^.*?\bfips(?:\[\d+\])?:\s*/, '')) : null),
      };
    case 'launchd':
      // The upstream LaunchDaemon writes stdout/stderr to /var/log/fips/fips.log; fall back to unified logging.
      if (existsSync('/var/log/fips/fips.log')) return fileSource('/var/log/fips/fips.log');
      return {
        name: 'unified log',
        recent: () => ['log', ['show', '--last', '1h', '--style', 'ndjson', '--predicate', 'process == "fips"']],
        follow: () => ['log', ['stream', '--style', 'ndjson', '--predicate', 'process == "fips"']],
        parse: (l) => {
          let e: { eventMessage?: string; timestamp?: string; messageType?: string };
          try { e = JSON.parse(l); } catch { return null; }
          if (!e.eventMessage) return null;
          const t = e.timestamp ? Date.parse(e.timestamp.replace(' ', 'T')) : Date.now();
          return parseMessage(e.eventMessage, Number.isNaN(t) ? Date.now() : t, e.messageType === 'Error' || e.messageType === 'Fault' ? 'error' : 'info');
        },
      };
    case 'rc':
      // The upstream rc.d script uses daemon(8) -o /var/log/fips.log (with newsyslog rotation).
      return fileSource(existsSync('/var/log/fips/fips.log') ? '/var/log/fips/fips.log' : '/var/log/fips.log');
    case 'openrc':
      return fileSource(existsSync('/var/log/fips/fips.log') ? '/var/log/fips/fips.log' : '/var/log/fips.log');
    case 'scm': {
      const pd = process.env.ProgramData ?? 'C:\\ProgramData';
      return fileSource(`${pd}\\fips\\logs\\fips.log`);
    }
    default: return null;
  }
}

export const LOGS: LogSource | null = logSource();

/** Recent log lines, oldest first. Empty if this platform has no known log source. */
export function recentLogs(lines = 300, since?: string): Promise<LogLine[]> {
  const n = Number.isFinite(lines) ? Math.min(Math.max(Math.floor(lines), 1), 5000) : 300;
  const argv = LOGS?.recent(n, since);
  if (!argv) return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv[1], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const out: LogLine[] = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = LOGS!.parse(buf.slice(0, i).replace(/\r$/, '')); if (l) out.push(l); buf = buf.slice(i + 1); } });
    child.on('close', () => { if (buf) { const l = LOGS!.parse(buf); if (l) out.push(l); } resolve(out.slice(-n)); });
    child.on('error', () => resolve(out));
  });
}

/** Start a live log follower; returns a stop function. */
export function followLogs(onLine: (l: LogLine) => void, onExit: () => void): () => void {
  const argv = LOGS?.follow();
  if (!argv) return () => {};
  const child: ChildProcess = spawn(argv[0], argv[1], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = LOGS!.parse(buf.slice(0, i).replace(/\r$/, '')); if (l) onLine(l); buf = buf.slice(i + 1); } });
  child.on('exit', onExit);
  child.on('error', onExit);
  return () => { child.kill(); };
}
