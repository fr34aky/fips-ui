// Public domain names over fips (fr34aky/fips-pub-domains): the resolver daemon `fips-pubdomd` and the
// domain server `fips-pubdom-server` each expose a control socket in the daemon's own line-JSON protocol
// (that repository's docs/webui.md), so control.ts speaks to them unchanged. This module says whether
// either is on the node and proxies the read-only commands; writes (the helper's zone and config
// edits, publish, forget, flush) are a later phase.
import fs from 'node:fs';
import { query } from './control.ts';

export type PubdomSide = 'resolver' | 'server';

export const RESOLVER_SOCKET = process.env.FIPS_PUBDOM_SOCKET ?? '/run/fips-pubdom/control.sock';
export const SERVER_SOCKET = process.env.FIPS_PUBDOM_SERVER_SOCKET ?? '/run/fips-pubdom-server/control.sock';

/** What a side's presence is judged from: its socket, or the files an installed one has. */
export interface SidePaths { socket: string; files: string[] }
export const PATHS: Record<PubdomSide, SidePaths> = {
  resolver: { socket: RESOLVER_SOCKET, files: ['/etc/fips-pubdom/config.yaml', '/var/lib/fips-pubdom/pins.json'] },
  server: { socket: SERVER_SOCKET, files: ['/etc/fips-pubdom/server.yaml', '/etc/fips-pubdom/zones'] },
};

export interface SideState { socket: string; running: boolean; installed: boolean }
export type PubdomState = Record<PubdomSide, SideState>;

/** Installed: a socket that answers, or configuration on disk (a stopped unit still shows its page). */
export function detect(paths: Record<PubdomSide, SidePaths> = PATHS, exists: (p: string) => boolean = (p) => fs.existsSync(p)): PubdomState {
  const side = (p: SidePaths): SideState => {
    const running = exists(p.socket);
    return { socket: p.socket, running, installed: running || p.files.some(exists) };
  };
  return { resolver: side(paths.resolver), server: side(paths.server) };
}

/** Read-only commands per side; anything else over the socket waits for the editing phase. */
export const READ_COMMANDS: Record<PubdomSide, Set<string>> = {
  resolver: new Set(['status', 'pins', 'log']),
  server: new Set(['status', 'zones', 'txt', 'log']),
};

export function isSide(s: string): s is PubdomSide { return s === 'resolver' || s === 'server'; }

export function pubdomQuery<T = unknown>(side: PubdomSide, command: string, params?: Record<string, unknown>): Promise<T> {
  return query<T>(command, params, { socketPath: PATHS[side].socket, timeoutMs: 15000 });
}
