// Small HTTP helpers shared by the API server and the upgrade module.
import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyError extends Error {
  status: 400 | 413;
  constructor(status: 400 | 413, message: string) { super(message); this.status = status; }
}

/**
 * Read and parse a JSON request body with a size limit. Listener-based on purpose: breaking out of
 * `for await (const c of req)` destroys the request and its socket, so a 413 written afterwards never
 * reaches the client. On overflow the request is paused and a 413 BodyError is thrown; the caller must
 * answer with `connection: close` and destroy the request after the response (see sendJson), because
 * the unread remainder of the body would otherwise be parsed as the next request on a kept-alive socket.
 */
export function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; req.pause(); reject(new BodyError(413, `request body too large (${Math.floor(limit / 1024)} KiB limit)`)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (!chunks.length) return resolve({});
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new BodyError(400, 'JSON body must be an object'));
        resolve(v as Record<string, unknown>);
      } catch { reject(new BodyError(400, 'invalid JSON body')); }
    });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

/** Write a JSON response. With `close`, the connection is closed after it (required after a 413). */
export function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) };
  if (close) headers.connection = 'close';
  res.writeHead(status, headers);
  res.end(text, () => { if (close) res.socket?.destroy(); });
}
