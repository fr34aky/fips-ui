// Minimal client for the FIPS control socket (line-delimited JSON, one request per connection).
// Protocol reference: docs/reference/control-socket.md in the upstream repository.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export class ControlError extends Error {
  readonly kind: 'daemon' | 'transport';
  constructor(message: string, kind: 'daemon' | 'transport' = 'daemon') {
    super(message);
    this.name = 'ControlError';
    this.kind = kind;
  }
}

export function defaultSocketPath(kind: 'control' | 'gateway' = 'control'): string {
  const file = kind === 'control' ? 'control.sock' : 'gateway.sock';
  if (fs.existsSync('/run/fips')) return path.join('/run/fips', file);
  if (fs.existsSync('/var/run/fips')) return path.join('/var/run/fips', file);
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && fs.existsSync(path.join(xdg, 'fips'))) return path.join(xdg, 'fips', file);
  return kind === 'control' ? '/tmp/fips-control.sock' : '/tmp/fips-gateway.sock';
}

export const SOCKET_PATH = process.env.FIPS_SOCKET ?? defaultSocketPath('control');
export const GATEWAY_SOCKET_PATH = process.env.FIPS_GATEWAY_SOCKET ?? defaultSocketPath('gateway');

type Ok<T> = { status: 'ok'; data: T };
type Err = { status: 'error'; message: string };

export function query<T = unknown>(
  command: string,
  params?: Record<string, unknown>,
  opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<T> {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const body: Record<string, unknown> = { command };
  if (params && Object.keys(params).length) body.params = params;
  const line = JSON.stringify(body) + '\n';
  if (Buffer.byteLength(line) > 4096) return Promise.reject(new ControlError('request too large', 'transport'));

  return new Promise<T>((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ControlError(`timeout after ${timeoutMs}ms`, 'transport'))), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(line));
    const safe = (fn: () => void) => { try { fn(); } catch (e) { finish(() => reject(new ControlError(`client error: ${(e as Error).message}`, 'transport'))); } };
    sock.on('data', (chunk: string) => safe(() => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      handle(buf.slice(0, nl));
    }));
    sock.on('end', () => safe(() => { if (buf.trim()) handle(buf); else finish(() => reject(new ControlError('empty response', 'transport'))); }));
    sock.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(new ControlError(describeSocketError(e, socketPath), 'transport'))));
    function handle(text: string) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return finish(() => reject(new ControlError('malformed response from daemon', 'transport'))); }
      if (!parsed || typeof parsed !== 'object') return finish(() => reject(new ControlError('unexpected non-object response from daemon', 'transport')));
      const r = parsed as Partial<Ok<T>> & Partial<Err>;
      if (r.status === 'ok') finish(() => resolve(r.data as T));
      else finish(() => reject(new ControlError(typeof r.message === 'string' ? r.message : 'unknown error')));
    }
  });
}

function describeSocketError(e: NodeJS.ErrnoException, socketPath: string): string {
  switch (e.code) {
    case 'ENOENT': return `control socket not found at ${socketPath} (is the fips daemon running?)`;
    case 'EACCES': return `permission denied on ${socketPath} (add this user to the 'fips' group)`;
    case 'ECONNREFUSED': return `connection refused on ${socketPath} (stale socket? daemon restarting?)`;
    default: return `${e.code ?? 'error'}: ${e.message}`;
  }
}

/** Read-only queries that the HTTP layer may proxy verbatim. */
export const READ_ONLY_COMMANDS = new Set([
  'show_status', 'show_acl', 'show_peers', 'show_links', 'show_tree', 'show_sessions', 'show_bloom',
  'show_mmp', 'show_cache', 'show_connections', 'show_transports', 'show_routing', 'show_identity_cache',
  'show_native_flows', 'show_listening_sockets', 'show_stats_list', 'show_metrics', 'show_stats_history',
  'show_stats_all_history', 'show_stats_peers', 'show_stats_history_all_peers',
]);

export const GATEWAY_COMMANDS = new Set(['show_gateway', 'show_mappings']);
