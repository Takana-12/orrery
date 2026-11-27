// Windows: the app is a folder with Orrery.exe, lives in the notification area, and is restarted by a PowerShell
// script (update-swap.ps1) because a folder in use cannot be replaced by the process that runs from it.
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

export const id = 'windows';

// ---- where the built app is ----
/** Folder under release/ that holds the app. Fixed: apps installed before v0.6 look for exactly this name when they update. */
export const bundleName = (product) => `${product}-win32-x64`;
export const target = { platform: 'win32', arch: 'x64' };
/** The program to start, inside the bundle folder. */
export const exeIn = (bundle, product) => join(bundle, `${product}.exe`);
/** Where the app's own files (package.json, build-info.json) are, inside the bundle folder. */
export const resourcesIn = (bundle) => join(bundle, 'resources', 'app');
/** The repository a packaged app was built from: <repo>\release\Orrery-win32-x64\Orrery.exe. */
export const repoOfExe = (execPath) => resolve(dirname(execPath), '..', '..');
export const packagerOptions = (root) => ({ icon: join(root, 'apps/desktop/icon.ico') });
/** Nothing to do after packaging. */
export function finishBundle() {}

/**
 * Pid of an app running from `bundle`, or ''. Packager deletes the old folder first; if that app is running, Windows
 * keeps the files in use (exe, DLLs) and deletes the rest (icudtl.dat, *.pak ...), leaving an app that no longer starts.
 */
export function runningFrom(bundle, product) {
  const ps = `Get-Process -Name '${product}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Split-Path -Parent $_.Path) -ieq '${bundle.replace(/'/g, "''")}' } | Select-Object -First 1 -ExpandProperty Id`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    // Where no process of that name exists at all, some PowerShell versions end with an error status: that is "none".
    return String(e?.stdout ?? '').trim();
  }
}

/** Register the built app where the person starts apps from: the Start menu. */
export function installApp(root) {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'apps/desktop/install-shortcuts.ps1')], { stdio: 'inherit' });
}
export const installedNote = 'スタートメニューに「Orrery」を登録しました。';

// ---- updating and restarting ----
export const swapScript = 'update-swap.ps1';
/**
 * Start the swap script so that it outlives this process. A child started directly (even "detached") does not
 * survive the app exiting here; one started through "cmd /c start" does.
 */
export function handOff({ script, pid, exe, log, release = '', args = [], cwd = '', tempDir }) {
  const ps = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-WaitPid', String(pid), '-Exe', exe, '-Log', log];
  if (args.length) ps.push('-Arguments', args.join(' '));
  if (cwd) ps.push('-WorkingDirectory', cwd);
  if (release) ps.push('-Release', release);
  spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', ...ps], { cwd: tempDir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
/** npm is npm.cmd on Windows, so through cmd. */
export const npmInstall = () => ({ file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm install --no-audit --no-fund'] });

/** If the process listening on 127.0.0.1:<port> is an Orrery (or the development Electron), end it. True if one was ended. */
export function endStaleListener(port, selfPid) {
  try {
    const net = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const line = net.split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).test(l));
    const pid = Number(line?.trim().split(/\s+/).pop());
    if (!pid || pid === selfPid) return false;
    const image = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).split(',')[0]?.replace(/"/g, '').trim();
    if (!/^(orrery|electron)\.exe$/i.test(image ?? '')) return false;
    console.log(`[control-room] ending a leftover ${image} (pid ${pid}) that still holds port ${port}`);
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---- the running app ----
export const words = { loginItem: 'Windowsの起動時に開始', terminal: 'コマンドプロンプト' };
export const trayIcon = (here, alert) => join(here, alert ? 'tray-alert.png' : 'tray.png');
/** Started by Windows at sign-in: stay in the notification area until there is something to decide. */
export const startedHidden = (app, argv) => argv.includes('--hidden');
export const loginItem = (app) => ({
  enabled: () => app.getLoginItemSettings().openAtLogin,
  set: (on) => app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }),
});
/** Once, before the window exists. Windows needs nothing: no menu bar, and the tray icon brings the window back. */
export function setUpApp() {}
/** The person asked the whole app to quit (not just closed the window). Windows: the tray's own "終了" asks; anything else is the system. */
export const quitAsks = false;
/** Called whenever the number of things waiting for the person may have changed. */
export function showAttention({ win, rose, focused }) {
  if (rose && !focused) win?.flashFrame(true);
}
/** The person granted the microphone to the page; Windows asks nothing further. */
export const microphoneAllowed = async () => true;
