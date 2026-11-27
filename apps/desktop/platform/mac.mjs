// macOS: the app is a bundle (Orrery.app), lives in the menu bar and the Dock, and is restarted by a shell script
// (update-swap.sh) so that the new process never meets the old one's single-instance lock and port.
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { parseLsofListener } from '../../../packages/host/src/mac/ps.ts';

export const id = 'mac';

// ---- where the built app is ----
/** Folder under release/ that holds the app: Orrery-darwin-arm64 (Apple silicon) or Orrery-darwin-x64 (Intel). */
export const bundleName = (product) => `${product}-darwin-${process.arch}`;
export const target = { platform: 'darwin', arch: process.arch };
/** The program to start, inside the bundle folder. */
export const exeIn = (bundle, product) => join(bundle, `${product}.app`, 'Contents', 'MacOS', product);
/** Where the app's own files (package.json, build-info.json) are, inside the bundle folder. */
export const resourcesIn = (bundle, product) => join(bundle, `${product}.app`, 'Contents', 'Resources', 'app');
/** The repository a packaged app was built from: <repo>/release/Orrery-darwin-arm64/Orrery.app/Contents/MacOS/Orrery. */
export const repoOfExe = (execPath) => resolve(dirname(execPath), '..', '..', '..', '..', '..');
/** Orrery.app, from the program inside it (or null when the program is not inside a bundle). */
const appOfExe = (exe) => /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1] ?? null;

export const packagerOptions = (root) => ({
  icon: join(root, 'apps/desktop/icon.icns'),
  appBundleId: 'local.orrery',
  appCategoryType: 'public.app-category.developer-tools',
  darwinDarkModeSupport: true,
  // Without this line macOS ends the app the moment the page asks for the microphone.
  extendInfo: { NSMicrophoneUsageDescription: '音声での依頼を文字にするために使います。音声の認識はこの Mac の中で行い、録音を外に送りません。' },
});

/**
 * build-info.json is written into the bundle after packaging, which leaves the bundle's signature not matching its
 * contents. Sign it again (ad-hoc: no certificate, valid on this Mac only), so macOS sees one coherent app when it
 * remembers the microphone permission. The app runs either way, so a failure here is only reported.
 */
export function finishBundle(bundle, product) {
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', join(bundle, `${product}.app`)], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 600_000 });
  } catch (e) {
    console.warn(`[package] 署名をやり直せませんでした（アプリは動きます）: ${String(e?.stderr || e?.message).trim().split('\n').pop()}`);
  }
}

const processes = () =>
  execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*\S)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), command: m[2] }));

/** Pid of an app running from `bundle`, or ''. Rebuilding into a folder whose app is running would pull the files out from under it. */
export function runningFrom(bundle) {
  try {
    const hit = processes().find((p) => p.command.startsWith(bundle + '/') && p.pid !== process.pid);
    return hit ? String(hit.pid) : '';
  } catch {
    return '';
  }
}

/** Register the built app where the person starts apps from: ~/Applications (shown in Finder and Launchpad). */
export function installApp(root) {
  execFileSync('/bin/bash', [join(root, 'apps/desktop/install-app.sh')], { stdio: 'inherit' });
}
export const installedNote = '~/Applications に「Orrery」を登録しました（Finder の「アプリケーション」や Spotlight から開けます）。';

// ---- updating and restarting ----
export const swapScript = 'update-swap.sh';
/** Start the swap script in a session of its own, so that it outlives this process. */
export function handOff({ script, pid, exe, log, release = '', bundle = '', args = [], cwd = '', tempDir }) {
  const a = [script, '--wait-pid', String(pid), '--exe', exe, '--log', log];
  if (cwd) a.push('--cwd', cwd);
  if (release) a.push('--release', release, '--name', bundle);
  spawn('/bin/bash', [...a, '--', ...args], { cwd: tempDir, detached: true, stdio: 'ignore' }).unref();
}
export const npmInstall = () => ({ file: 'npm', args: ['install', '--no-audit', '--no-fund'] });

/** If the process listening on 127.0.0.1:<port> is an Orrery (or the development Electron), end it. True if one was ended. */
export function endStaleListener(port, selfPid) {
  try {
    const who = parseLsofListener(execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    if (!who || who.pid === selfPid) return false;
    if (!/^(orrery|electron)/i.test(who.command)) return false;
    console.log(`[control-room] ending a leftover ${who.command} (pid ${who.pid}) that still holds port ${port}`);
    process.kill(who.pid, 'SIGKILL'); // its helper processes (renderer, GPU) end with it
    return true;
  } catch {
    return false;
  }
}

// ---- the running app ----
export const words = { loginItem: 'ログイン時に開始', terminal: 'ターミナル' };
/** 18-point images with @2x versions beside them (Electron picks by the screen); the menu bar is 22 points high. */
export const trayIcon = (here, alert) => join(here, alert ? 'tray-mac-alert.png' : 'tray-mac.png');
/** Opened by macOS at login: stay in the menu bar until there is something to decide. */
export const startedHidden = (app, argv) => argv.includes('--hidden') || !!app.getLoginItemSettings().wasOpenedAtLogin;
export const loginItem = (app) => ({
  enabled: () => app.getLoginItemSettings().openAtLogin,
  set: (on) => app.setLoginItemSettings({ openAtLogin: on }),
});

/**
 * Once, before the window exists. A Mac app always has a menu bar: without one of our own Electron shows its
 * default (with "Reload" and developer tools), and without an Edit menu ⌘C / ⌘V do not work in text boxes.
 * Clicking the Dock icon brings the window back, as closing it only hides it.
 */
export function setUpApp({ app, Menu, showWindow, quit }) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: `${app.name} について` },
          { type: 'separator' },
          { role: 'hide', label: `${app.name} を隠す` },
          { role: 'hideOthers', label: 'ほかを隠す' },
          { role: 'unhide', label: 'すべてを表示' },
          { type: 'separator' },
          { label: `${app.name} を終了（エージェントも停止）`, accelerator: 'Command+Q', click: () => void quit({ confirm: true }) },
        ],
      },
      {
        label: '編集',
        submenu: [
          { role: 'undo', label: '取り消す' },
          { role: 'redo', label: 'やり直す' },
          { type: 'separator' },
          { role: 'cut', label: 'カット' },
          { role: 'copy', label: 'コピー' },
          { role: 'paste', label: 'ペースト' },
          { role: 'selectAll', label: 'すべてを選択' },
        ],
      },
      {
        label: 'ウインドウ',
        submenu: [
          { role: 'minimize', label: 'しまう' },
          { role: 'zoom', label: '拡大／縮小' },
          { role: 'togglefullscreen', label: 'フルスクリーン' },
          { type: 'separator' },
          { role: 'close', label: '閉じる（裏で動き続けます）' },
          { type: 'separator' },
          { label: `${app.name} を開く`, click: () => showWindow('#/') },
        ],
      },
    ]),
  );
  app.on('activate', () => showWindow());
}
/** The person asked the whole app to quit (Dock → 終了, or logging out): ask before stopping agents that are working. */
export const quitAsks = true;
/** Called whenever the number of things waiting for the person may have changed: a count on the Dock icon, and one bounce when it rises. */
export function showAttention({ app, count, rose, focused }) {
  app.dock?.setBadge(count > 0 ? String(count) : '');
  if (rose && !focused) app.dock?.bounce('informational');
}
/** macOS has its own switch for the microphone, per app (System Settings → Privacy): ask it too. Shows the system's prompt the first time. */
export async function microphoneAllowed(systemPreferences) {
  try {
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted' || (await systemPreferences.askForMediaAccess('microphone'));
  } catch {
    return false;
  }
}
