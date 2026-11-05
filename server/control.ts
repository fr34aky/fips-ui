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

/**
 * The daemon's control endpoint. On Windows it is a TCP port on 127.0.0.1 (21210, gateway 21211); elsewhere a
 * Unix socket, searched in the same order as fipsctl. FIPS_SOCKET may be a path, a port, or host:port.
 */
export function defaultSocketPath(kind: 'control' | 'gateway' = 'control'): string {
  if (process.platform === 'win32') return kind === 'control' ? '21210' : '21211';
  const file = kind === 'control' ? 'control.sock' : 'gateway.sock';
  if (fs.existsSync('/run/fips')) return path.join('/run/fips', file);
  if (fs.existsSync('/var/run/fips')) return path.join('/var/run/fips', file);
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && fs.existsSync(path.join(xdg, 'fips'))) return path.join(xdg, 'fips', file);
  return kind === 'control' ? '/tmp/fips-control.sock' : '/tmp/fips-gateway.sock';
}

export const SOCKET_PATH = process.env.FIPS_SOCKET ?? defaultSocketPath('control');
export const GATEWAY_SOCKET_PATH = process.env.FIPS_GATEWAY_SOCKET ?? defaultSocketPath('gateway');

/**
 * The IPv6 adapter's status socket (fips from 2026-10-26 on): a sibling of the control socket named with `-ipv6tun`
 * before the extension (`control.sock` → `control-ipv6tun.sock`); on a TCP endpoint the control port plus 2. A
 * symlinked control socket is followed first, as fipsctl does, so the adapter is looked for beside the real socket.
 * It answers `show_status` (the TUN keys) and `show_listening_sockets`, which the control socket no longer does.
 */
export function ipv6tunEndpoint(control: string, realpath: (p: string) => string = (p) => fs.realpathSync(p)): string {
  const o = endpointOptions(control);
  if (!('path' in o) || !o.path) {
    const port = (o as { port: number }).port + 2;
    return /^\d{1,5}$/.test(control) ? String(port) : control.replace(/:\d{1,5}$/, `:${port}`);
  }
  let real = control;
  try { real = realpath(control); } catch { /* not there yet: derive from the given path */ }
  const ext = path.extname(real);
  return path.join(path.dirname(real), `${path.basename(real, ext)}-ipv6tun${ext}`);
}
/** Derived on every call: the control socket may appear, or become a symlink, after fips-ui started. */
export function ipv6tunSocketPath(): string { return process.env.FIPS_IPV6TUN_SOCKET ?? ipv6tunEndpoint(SOCKET_PATH); }

/** Connection options for an endpoint string: a TCP port, host:port / [v6]:port, or a Unix socket path. */
export function endpointOptions(ep: string): net.NetConnectOpts {
  if (/^\d{1,5}$/.test(ep)) return { host: '127.0.0.1', port: Number(ep) };
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/.exec(ep);
  if (m && !ep.startsWith('/')) return { host: m[1] ?? m[2], port: Number(m[3]) };
  return { path: ep };
}

/** Does this endpoint look reachable without connecting? (Unix sockets must exist; TCP endpoints always "may".) */
export function endpointExists(ep: string): boolean {
  const o = endpointOptions(ep) as { path?: string };
  return o.path ? fs.existsSync(o.path) : true;
}

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
    const sock = net.createConnection(endpointOptions(socketPath));
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
    case 'ECONNREFUSED': return /^[\d.:[\]a-zA-Z-]*\d$/.test(socketPath) && !socketPath.startsWith('/') ? `nothing listening on control port ${socketPath} (is the fips daemon running?)` : `connection refused on ${socketPath} (stale socket? daemon restarting?)`;
    default: return `${e.code ?? 'error'}: ${e.message}`;
  }
}

/**
 * `show_status` as fipsctl shows it: the daemon's answer with the IPv6 adapter's keys (`tun_state`, `tun_name`,
 * `effective_ipv6_mtu`, ...) merged in where the daemon leaves them out. An older daemon answers them itself; a newer
 * one without a reachable adapter socket answers without them, and `onAdapterError` says why, so a caller can show
 * the failure rather than a placeholder (a placeholder TUN name would be taken for a real interface).
 */
export async function queryStatus<T extends { tun_state?: unknown } = Record<string, unknown>>(
  opts: { timeoutMs?: number; onAdapterError?: (e: Error) => void } = {},
): Promise<T> {
  const adapter = ipv6tunSocketPath();
  const [st, tun] = await Promise.all([
    query<T>('show_status', undefined, { timeoutMs: opts.timeoutMs }),
    endpointExists(adapter)
      ? query<Record<string, unknown>>('show_status', undefined, { timeoutMs: opts.timeoutMs, socketPath: adapter }).catch((e: Error) => e)
      : new ControlError(`IPv6 adapter status socket not found at ${adapter}`, 'transport'),
  ]);
  if (!st || typeof st !== 'object' || st.tun_state !== undefined) return st; // the daemon answered the keys itself
  if (tun instanceof Error) { opts.onAdapterError?.(tun); return st; }
  return { ...tun, ...st } as T;
}

/** `show_listening_sockets` from the adapter's socket; from the control socket where there is no adapter (older daemons). */
export async function queryListening<T = unknown>(opts: { timeoutMs?: number } = {}): Promise<T> {
  const adapter = ipv6tunSocketPath();
  if (endpointExists(adapter)) {
    try { return await query<T>('show_listening_sockets', undefined, { ...opts, socketPath: adapter }); }
    catch (e) { if (!(e instanceof ControlError) || e.kind !== 'transport') throw e; }
  }
  try { return await query<T>('show_listening_sockets', undefined, opts); }
  catch (e) {
    // A daemon that no longer answers it on the control socket: the adapter socket is what is missing.
    if (e instanceof ControlError && e.kind === 'daemon' && /unknown command/.test(e.message)) throw new ControlError(`the IPv6 adapter's status socket at ${adapter} does not answer (the daemon serves listening sockets there; is it bound?)`, 'transport');
    throw e;
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
