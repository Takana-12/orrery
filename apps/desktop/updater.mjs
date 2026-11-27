// "更新して再起動" in settings. The app normally never closes (it lives in the tray), so this is how a code change reaches it.
//  - Packaged app (release\Orrery-win32-x64\Orrery.exe, on macOS release/Orrery-darwin-<arch>/Orrery.app): build the new app into
//    release\.staging while this one keeps running, then quit; the swap script (update-swap.ps1, on macOS update-swap.sh) waits for
//    the exit, swaps the folders and starts the new app. The old build is kept until the swap succeeded.
//    What differs between the two systems is in platform/.
//  - Development (npm run app): the source is read at start, so a restart is the update.
//  - "再起動" does the same as "更新" when the packaged app is older than its source, and only restarts otherwise.
//  - A copy installed with "git clone" (its branch tracks origin/main) is checked for a newer version on GitHub when the
//    app starts and every hour after. When there is one, "更新" first brings it in (git pull, then npm install if the
//    dependencies changed) and goes on as above.
// Restarting is never left to Electron's own relaunch: the new process would start while this one still holds the
// single-instance lock and the port, and silently give up. The swap script waits for this process to be gone (ending any
// leftover Orrery process from the same folder) and only then starts the new one.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkRemote, installDeps, pullRemote } from './remote-version.mjs';
import { sourceState } from './source-state.mjs';
import { platform } from './platform/index.mjs';

const FIRST_CHECK_MS = 15_000; // a little after start, so the check does not compete with opening the window
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * @param {{ here: string, quit: () => Promise<void> | void, onChange?: () => void }} opts
 */
export function createUpdater({ here, quit, onChange, startDir = process.cwd() }) {
  const packaged = app.isPackaged;
  // The packaged app sits under <repo>\release; development runs straight from <repo>.
  const repo = packaged ? platform.repoOfExe(process.execPath) : resolve(here, '../..');
  const bundle = platform.bundleName(app.getName());
  const canBuild = existsSync(join(repo, 'apps/desktop/package.mjs')) && existsSync(join(repo, 'node_modules/@electron/packager'));
  let build = null;
  try {
    build = JSON.parse(readFileSync(join(app.getAppPath(), 'build-info.json'), 'utf8'));
  } catch {}

  /** @type {'idle' | 'pulling' | 'installing' | 'building' | 'restarting' | 'failed'} */
  let phase = 'idle';
  let startedAt = null;
  let error = null;
  let log = [];
  const busy = () => phase === 'pulling' || phase === 'installing' || phase === 'building' || phase === 'restarting';
  const set = (p, e = null) => {
    phase = p;
    error = e;
    onChange?.();
  };
  const take = (b) => {
    for (const line of String(b).split(/\r?\n/)) if (line.trim()) log.push(line.slice(0, 400));
    if (log.length > 200) log = log.slice(-200);
  };

  // ---- a newer version on GitHub ----
  let remote = { tracking: null, behind: 0, ahead: 0, latest: null, checkedAt: null, checking: false, error: null };
  /** Only a plain fast-forward is brought in by itself; a copy with its own commits is left to its owner. */
  const canPull = () => !!remote.tracking && remote.behind > 0 && remote.ahead === 0;

  /** Ask GitHub whether there is a newer version. Never throws: a failure (offline, say) is kept and shown. */
  async function check() {
    if (remote.checking || busy() || !existsSync(join(repo, '.git'))) return status();
    remote = { ...remote, checking: true };
    onChange?.();
    try {
      remote = { ...(await checkRemote(repo)), checking: false, error: null };
    } catch (e) {
      remote = { ...remote, checking: false, checkedAt: Date.now(), error: String(e?.message ?? e).split('\n')[0] };
    }
    onChange?.();
    return status();
  }
  setTimeout(() => void check(), FIRST_CHECK_MS).unref?.();
  setInterval(() => void check(), CHECK_EVERY_MS).unref?.();

  /** What every screen needs to know, sent along with the state: a newer version is waiting on GitHub. */
  function newVersion() {
    return remote.behind > 0 ? { behind: remote.behind, subject: remote.latest?.subject ?? '', commit: remote.latest?.commit ?? '', canPull: canPull() } : null;
  }

  function status() {
    const source = canBuild ? sourceState(repo) : null;
    const upToDate = !packaged ? true : build?.fingerprint && source?.fingerprint ? build.fingerprint === source.fingerprint : null;
    return { mode: packaged ? 'packaged' : 'dev', repo, canBuild, version: app.getVersion(), build, source, upToDate, remote, phase, startedAt, error, log: log.slice(-40) };
  }

  /** Start the swap script so that it outlives this process, and restarts the app once this process is gone. */
  const handOff = (o) => platform.handOff({ ...o, pid: process.pid, bundle, tempDir: app.getPath('temp') });

  /** Restart; a packaged app whose source has changed since it was built is rebuilt first (the same as "更新"). */
  async function restart() {
    if (phase === 'building' || phase === 'pulling' || phase === 'installing') throw new Error('更新の準備中です。終わるまでお待ちください。');
    if (packaged && canBuild && phase !== 'restarting' && status().upToDate === false) return update();
    set('restarting');
    handOff({
      script: join(here, platform.swapScript),
      exe: process.execPath,
      log: join(app.getPath('temp'), 'orrery-restart.log'),
      // npm run app = "electron ." from the repository; the packaged exe needs nothing.
      args: process.argv.slice(1).filter((a) => a !== '--hidden'),
      cwd: packaged ? '' : startDir,
    });
    setTimeout(() => void quit(), 300); // let the HTTP reply reach the page first
  }

  /** Bring in the newer version from GitHub when there is one, then rebuild (packaged) or restart (development). */
  async function update() {
    if (busy()) throw new Error('すでに更新中です。');
    if (packaged && !canBuild) throw new Error(`ソースのフォルダが見つかりません: ${repo}`);
    if (!canPull()) return packaged ? rebuild() : restart();
    log = [];
    startedAt = Date.now();
    set('pulling');
    // Returns at once (the page follows the progress); the rest runs on its own.
    void (async () => {
      try {
        const r = await pullRemote(repo, take);
        if (r.depsChanged) {
          set('installing');
          await installDeps(repo, take);
        }
        remote = { ...remote, behind: 0, latest: null };
      } catch (e) {
        set('failed', String(e?.message ?? e));
        void check();
        return;
      }
      if (!packaged) {
        set('idle');
        return restart();
      }
      return rebuild({ keepLog: true });
    })().catch((e) => set('failed', String(e?.message ?? e)));
  }

  async function rebuild({ keepLog = false } = {}) {
    const staging = join(repo, 'release', '.staging');
    rmSync(staging, { recursive: true, force: true });
    if (!keepLog) {
      log = [];
      startedAt = Date.now();
    }
    set('building');
    // The exe doubles as Node (ELECTRON_RUN_AS_NODE), so no separate Node installation on PATH is needed.
    const child = spawn(process.execPath, [join(repo, 'apps/desktop/package.mjs'), '--out', staging], {
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => set('failed', String(e?.message ?? e)));
    child.on('exit', async (code) => {
      if (phase !== 'building') return;
      if (code !== 0 || !existsSync(platform.exeIn(join(staging, bundle), app.getName()))) return set('failed', `ビルドに失敗しました（終了コード ${code}）。いまのバージョンのまま動いています。`);
      set('restarting');
      handOff({
        script: join(repo, 'apps/desktop', platform.swapScript),
        exe: platform.exeIn(join(repo, 'release', bundle), app.getName()),
        log: join(repo, 'release', 'update.log'),
        release: join(repo, 'release'),
      });
      await quit();
    });
  }

  return { status, update, restart, check, newVersion };
}
