// Agent Control Room: console entry point (development and end-to-end tests).
// The everyday way to run it is the desktop app: see apps/desktop.
//   node packages/server/src/main.ts [--no-open]
// Environment:
//   CONTROL_ROOM_PORT   (default 4780)
//   CONTROL_ROOM_HOME   data directory (default: %LOCALAPPDATA%\AgentControlRoom, on macOS ~/Library/Application Support/AgentControlRoom)
//   CONTROL_ROOM_TOKEN  fixed API token (tests only; otherwise random per start)
//   CODEX_BIN           path to the codex binary (otherwise PATH, then the VS Code extension's bundled binary)
import { openAppWindow, openExternal } from '#host';
import { launch } from './launch.ts';

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await running.shutdown();
  process.exit(0);
}

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
  openAppWindow(running.url, () => console.log('[control-room] ブラウザを開けませんでした。上のURLをブラウザで開いてください。'));
}
