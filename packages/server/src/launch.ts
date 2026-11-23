// Start the control room core + local HTTP API. Used by both shells:
//   - the Windows app (apps/desktop/main.mjs, Electron)
//   - the console entry point (main.ts), kept for development and the end-to-end tests
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { App } from './app.ts';
import { startHttp } from './interface/http/server.ts';
import type { AppUpdater } from './interface/http/server.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface LaunchOptions {
  port?: number;
  home?: string;
  token?: string;
  pickFolder?: () => Promise<string | null>;
  openExternal?: (url: string) => void;
  clearShellCache?: () => Promise<void>;
  /** Rebuild/restart the app itself (Windows app only). */
  appUpdate?: AppUpdater;
  /** Called when the UI asks the control room to shut down (tests). */
  onShutdownRequest?: () => void;
}

export interface Launched {
  app: App;
  url: string;
  port: number;
  home: string;
  logProblem(kind: string, e: unknown): void;
  shutdown(opts?: { archiveCodexThreads?: boolean }): Promise<void>;
}

export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`ポート ${port} は使用中です。Control Roomが既に起動していないか確認してください。`);
    this.port = port;
  }
}

export const defaultHome = (): string =>
  resolve(process.env.CONTROL_ROOM_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentControlRoom'));

/** Fails fast, BEFORE the database is opened: opening it advances the generation and would retire a running instance's open requests. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const probe = createNetServer();
    probe.once('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EADDRINUSE' ? new PortInUseError(port) : e));
    probe.listen(port, '127.0.0.1', () => probe.close(() => ok()));
  });
}

export async function launch(opts: LaunchOptions = {}): Promise<Launched> {
  const port = opts.port ?? Number(process.env.CONTROL_ROOM_PORT ?? 4780);
  const home = opts.home ?? defaultHome();
  mkdirSync(home, { recursive: true });
  const token = opts.token ?? process.env.CONTROL_ROOM_TOKEN ?? randomBytes(24).toString('base64url');

  // Problems go to a local log so a crash can be diagnosed afterwards.
  const logFile = join(home, 'control-room.log');
  const logProblem = (kind: string, e: unknown): void => {
    const line = `${new Date().toISOString()} ${kind}: ${(e as Error)?.stack ?? String(e)}\n`;
    try {
      appendFileSync(logFile, line);
    } catch {}
    console.error(`[control-room] ${kind}: ${(e as Error)?.message ?? e}`);
  };

  await assertPortFree(port);
  const app = new App({ dbPath: join(home, 'control-room.sqlite'), pickFolder: opts.pickFolder, openExternal: opts.openExternal, clearShellCache: opts.clearShellCache });
  let stopped = false;
  let server: Awaited<ReturnType<typeof startHttp>>;
  const shutdown = async (o: { archiveCodexThreads?: boolean } = {}): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server?.close();
    await app.shutdown({ archiveCodexThreads: o.archiveCodexThreads ?? process.env.CONTROL_ROOM_ARCHIVE_ON_EXIT === '1' }).catch(() => {});
  };
  try {
    server = await startHttp({ app, port, token, uiDir: resolve(here, '../public'), onShutdownRequest: opts.onShutdownRequest, appUpdate: opts.appUpdate });
  } catch (e) {
    await app.shutdown().catch(() => {});
    throw (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? new PortInUseError(port) : e;
  }
  // The token travels in the URL fragment, which is never sent to the server or put in Referer.
  return { app, url: `http://127.0.0.1:${port}/#token=${token}`, port, home, logProblem, shutdown };
}
