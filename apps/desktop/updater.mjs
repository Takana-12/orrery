// "更新して再起動" in settings. The app normally never closes (it lives in the tray), so this is how a code change reaches it.
//  - Packaged app (release\Orrery-win32-x64\Orrery.exe): build the new app into release\.staging while this one keeps running,
//    then quit; update-swap.ps1 waits for the exit, swaps the folders and starts the new exe. The old build is kept until the swap succeeded.
//  - Development (npm run app): the source is read at start, so a restart is the update.
//  - "再起動" does the same as "更新" when the packaged app is older than its source, and only restarts otherwise.
// Restarting is never left to Electron's own relaunch: the new process would start while this one still holds the
// single-instance lock and the port, and silently give up. update-swap.ps1 waits for this process to be gone (ending any
// leftover Orrery process from the same folder) and only then starts the new one.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sourceState } from './source-state.mjs';

/**
 * @param {{ here: string, quit: () => Promise<void> | void, onChange?: () => void }} opts
 */
export function createUpdater({ here, quit, onChange, startDir = process.cwd() }) {
  const packaged = app.isPackaged;
  // The packaged app sits at <repo>\release\Orrery-win32-x64\Orrery.exe; development runs straight from <repo>.
  const repo = packaged ? resolve(dirname(process.execPath), '..', '..') : resolve(here, '../..');
  const canBuild = existsSync(join(repo, 'apps/desktop/package.mjs')) && existsSync(join(repo, 'node_modules/@electron/packager'));
  let build = null;
  try {
    build = JSON.parse(readFileSync(join(app.getAppPath(), 'build-info.json'), 'utf8'));
  } catch {}

  /** @type {'idle' | 'building' | 'restarting' | 'failed'} */
  let phase = 'idle';
  let startedAt = null;
  let error = null;
  let log = [];
  const set = (p, e = null) => {
    phase = p;
    error = e;
    onChange?.();
  };

  function status() {
    const source = canBuild ? sourceState(repo) : null;
    const upToDate = !packaged ? true : build?.fingerprint && source?.fingerprint ? build.fingerprint === source.fingerprint : null;
    return { mode: packaged ? 'packaged' : 'dev', repo, canBuild, version: app.getVersion(), build, source, upToDate, phase, startedAt, error, log: log.slice(-40) };
  }

  /**
   * Start update-swap.ps1 so that it outlives this process. A child started directly (even "detached") does not
   * survive the app exiting here; one started through "cmd /c start" does.
   */
  function handOff({ script, exe, log: logFile, release, args = [], cwd = '' }) {
    const ps = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-WaitPid', String(process.pid), '-Exe', exe, '-Log', logFile];
    if (args.length) ps.push('-Arguments', args.join(' '));
    if (cwd) ps.push('-WorkingDirectory', cwd);
    if (release) ps.push('-Release', release);
    spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', ...ps], { cwd: app.getPath('temp'), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  /** Restart; a packaged app whose source has changed since it was built is rebuilt first (the same as "更新"). */
  async function restart() {
    if (phase === 'building') throw new Error('更新の準備中です。終わるまでお待ちください。');
    if (packaged && canBuild && phase !== 'restarting' && status().upToDate === false) return update();
    set('restarting');
    handOff({
      script: join(here, 'update-swap.ps1'),
      exe: process.execPath,
      log: join(app.getPath('temp'), 'orrery-restart.log'),
      // npm run app = "electron ." from the repository; the packaged exe needs nothing.
      args: process.argv.slice(1).filter((a) => a !== '--hidden'),
      cwd: packaged ? '' : startDir,
    });
    setTimeout(() => void quit(), 300); // let the HTTP reply reach the page first
  }

  async function update() {
    if (!packaged) return restart();
    if (!canBuild) throw new Error(`ソースのフォルダが見つかりません: ${repo}`);
    if (phase === 'building' || phase === 'restarting') throw new Error('すでに更新中です。');
    const staging = join(repo, 'release', '.staging');
    rmSync(staging, { recursive: true, force: true });
    log = [];
    startedAt = Date.now();
    set('building');
    // The exe doubles as Node (ELECTRON_RUN_AS_NODE), so no separate Node installation on PATH is needed.
    const child = spawn(process.execPath, [join(repo, 'apps/desktop/package.mjs'), '--out', staging], {
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const take = (b) => {
      for (const line of String(b).split(/\r?\n/)) if (line.trim()) log.push(line.slice(0, 400));
      if (log.length > 200) log = log.slice(-200);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => set('failed', String(e?.message ?? e)));
    child.on('exit', async (code) => {
      if (phase !== 'building') return;
      if (code !== 0 || !existsSync(join(staging, 'Orrery-win32-x64', 'Orrery.exe'))) return set('failed', `ビルドに失敗しました（終了コード ${code}）。いまのバージョンのまま動いています。`);
      set('restarting');
      handOff({
        script: join(repo, 'apps/desktop/update-swap.ps1'),
        exe: join(repo, 'release', 'Orrery-win32-x64', 'Orrery.exe'),
        log: join(repo, 'release', 'update.log'),
        release: join(repo, 'release'),
      });
      await quit();
    });
  }

  return { status, update, restart };
}
