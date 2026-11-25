// Local HTTP server: the UI's files, the API, and the state stream.
// Local-only by construction: binds 127.0.0.1, rejects foreign Host/Origin (DNS rebinding, CSRF),
// and every /api call must carry the per-start token. No CORS headers are ever sent.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../../app.ts';
import { HttpError } from '../../application/errors.ts';
import { json, readBody, readBytes } from './io.ts';
import { ROUTES, Reply, stateOf } from './routes.ts';
import type { AppUpdater, Route } from './routes.ts';

export type { AppUpdater };

export interface HttpOptions {
  app: App;
  port: number;
  token: string;
  /** Directory holding the UI: index.html, app.css and the script modules under js/. */
  uiDir: string;
  onShutdownRequest?: () => void;
  appUpdate?: AppUpdater;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** A UI file for this URL path, or null. Only our own html/js/css inside `uiDir` is ever served. */
function uiFile(uiDir: string, path: string): { file: string; type: string } | null {
  const rel = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[\w./-]+$/.test(rel) || rel.includes('..')) return null;
  const file = normalize(join(uiDir, rel));
  const type = TYPES[extname(file)];
  if (!type || !file.startsWith(normalize(uiDir) + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
  return { file, type };
}

export function startHttp(opts: HttpOptions): Promise<Server> {
  const { app, port, token } = opts;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const tokenBuf = Buffer.from(token);
  const tokenOk = (req: IncomingMessage): boolean => {
    const got = Buffer.from(String(req.headers['x-control-room-token'] ?? ''));
    return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf);
  };

  // ---- state stream: every connected UI is pushed the read model whenever something changed ----
  const streams = new Set<ServerResponse>();
  let scheduled = false;
  app.on('change', () => {
    // Coalesce bursts of events into one push.
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!streams.size) return;
      const payload = `data: ${JSON.stringify(stateOf(app, opts.appUpdate))}\n\n`;
      for (const res of streams) res.write(payload);
    }, 50);
  });

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return json(res, 403, { error: 'bad host' });
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'bad origin' });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      const asset = method === 'GET' && !path.startsWith('/api/') ? uiFile(opts.uiDir, path) : null;
      if (asset) {
        res.writeHead(200, {
          'content-type': asset.type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // Agent output is untrusted: no inline script or style at all, nothing remote.
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        return void res.end(readFileSync(asset.file));
      }
      if (!path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      if (!tokenOk(req)) return json(res, 401, { error: 'トークンが違います。起動時に表示されたURLから開き直してください。' });

      if (method === 'GET' && path === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(stateOf(app, opts.appUpdate))}\n\n`);
        streams.add(res);
        console.log(`[control-room] UI connected (${streams.size} open)`);
        req.on('close', () => streams.delete(res));
        return;
      }

      let route: Route | undefined;
      let params: string[] = [];
      for (const r of ROUTES) {
        const m = r.method === method ? path.match(r.path) : null;
        if (!m) continue;
        route = r;
        params = m.slice(1);
        break;
      }
      if (!route && method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const body = method !== 'POST' ? undefined : route?.rawLimit ? await readBytes(req, route.rawLimit) : await readBody(req);
      if (!route) return json(res, 404, { error: 'not found' });
      const out = await route.handle({ app, params, query: url.searchParams, body, appUpdate: opts.appUpdate, onShutdownRequest: opts.onShutdownRequest });
      if (out instanceof Reply) {
        json(res, out.status, out.body);
        out.after?.();
      } else json(res, 200, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      json(res, status, { error: String((e as Error)?.message ?? e) });
    }
  });

  server.on('close', () => {
    for (const s of streams) s.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
