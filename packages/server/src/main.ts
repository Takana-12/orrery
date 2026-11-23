// Agent Control Room: console entry point (development and end-to-end tests).
// The everyday way to run it is the Windows app: see apps/desktop.
//   node packages/server/src/main.ts [--no-open]
// Environment:
//   CONTROL_ROOM_PORT   (default 4780)
//   CONTROL_ROOM_HOME   data directory (default %LOCALAPPDATA%\AgentControlRoom)
//   CONTROL_ROOM_TOKEN  fixed API token (tests only; otherwise random per start)
//   CODEX_BIN           path to codex.exe (otherwise PATH, then the VS Code extension's bundled binary)
import { spawn } from 'node:child_process';
import { launch } from './launch.ts';

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await running.shutdown();
  process.exit(0);
}

const openExternal = (url: string): void => void spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
const running = await launch({ onShutdownRequest: () => void stop(), openExternal }).catch((e) => {
  console.error(`[control-room] ${e.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => running.logProblem('unhandledRejection', e));
process.on('uncaughtException', (e) => {
  running.logProblem('uncaughtException', e);
  process.exit(1); // agent processes are in kill-on-close jobs, so nothing is left running
});
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

console.log(`[control-room] generation ${running.app.generation}, data: ${running.home}`);
console.log(`[control-room] open: ${running.url}`);

if (!process.argv.includes('--no-open')) {
  const child = spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${running.url}`], { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => console.log('[control-room] Edgeを開けませんでした。上のURLをブラウザで開いてください。'));
  child.unref();
}
