// Orrery — the Windows app (Electron shell).
// The control room core runs inside this process; the window shows the same local UI the core serves.
// Closing the window keeps the app (and the agents) running in the notification area; "終了" in the tray menu stops everything.
import { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, nativeTheme, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, PortInUseError } from '../../packages/server/src/launch.ts';
import { allowMicrophoneOnly } from './permissions.mjs';
import { createUpdater } from './updater.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP_ID = 'local.orrery';
app.setName('Orrery');
app.setAppUserModelId(APP_ID); // groups the taskbar button and names the sender of notifications
// Tests: a separate profile (own single-instance lock) so a second copy can run next to the everyday one.
if (process.env.ORRERY_USER_DATA) app.setPath('userData', process.env.ORRERY_USER_DATA);
// The packaged app does not stay in its own folder: a process whose working directory is releaseOrrery-win32-x64
// (this one, or anything it starts) would keep that folder from being swapped by an update.
const startDir = process.cwd();
if (app.isPackaged) {
  try {
    process.chdir(app.getPath('temp'));
  } catch {}
}

/** @type {Awaited<ReturnType<typeof launch>> | null} */
let running = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the first instance gets 'second-instance' and shows its window
} else {
  // Opened again while this one is on its way out: get out of the way at once, so the next try starts cleanly.
  app.on('second-instance', () => (quitting ? app.exit(0) : showWindow()));
  app.whenReady().then(start);
}

function showWindow(hash) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}

let retriedPort = false;

/** If the process listening on 127.0.0.1:<port> is an Orrery (or the development Electron), end it. True if one was ended. */
function endStaleOrrery(port) {
  try {
    const net = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const line = net.split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).test(l));
    const pid = Number(line?.trim().split(/\s+/).pop());
    if (!pid || pid === process.pid) return false;
    const image = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).split(',')[0]?.replace(/"/g, '').trim();
    if (!/^(orrery|electron)\.exe$/i.test(image ?? '')) return false;
    console.log(`[control-room] ending a leftover ${image} (pid ${pid}) that still holds port ${port}`);
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function start() {
  const updater = createUpdater({ here, startDir, quit: () => quit({ confirm: false }), onChange: () => running?.app.emit('change') });
  try {
    running = await launch({
      onShutdownRequest: () => void quit({ confirm: false }),
      // The standard Explorer "select folder" dialog, attached to our window.
      pickFolder: async () => {
        const r = await dialog.showOpenDialog(win, { title: 'プロジェクトのフォルダを選択', buttonLabel: 'このフォルダを使う', properties: ['openDirectory'] });
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
      },
      clearShellCache: async () => {
        await session.defaultSession.clearCache();
        await session.defaultSession.clearStorageData({ storages: ['shadercache', 'cachestorage'] });
      },
      // Provider sign-in pages open in the default browser: credentials are typed there, never inside this app.
      appUpdate: updater,
      openExternal: (url) => {
        if (/^https:\/\//.test(url)) void shell.openExternal(url);
      },
    });
  } catch (e) {
    // The port is held by an Orrery that did not exit properly (we hold the single-instance lock, so it is not a working
    // one): end it and try once more, instead of asking the human to find and kill it.
    if (e instanceof PortInUseError && !retriedPort && endStaleOrrery(e.port)) {
      retriedPort = true;
      await new Promise((r) => setTimeout(r, 1500));
      return start();
    }
    dialog.showErrorBox('Orrery を起動できません', e instanceof PortInUseError ? `${e.message}\n\nコンソールから起動したOrreryが動いている場合は、そちらを終了してください。` : String(e?.stack ?? e));
    app.exit(1);
    return;
  }
  process.on('unhandledRejection', (e) => running.logProblem('unhandledRejection', e));
  process.on('uncaughtException', (e) => running.logProblem('uncaughtException', e));

  // The page is our own local UI. It gets no extra powers: no Node, no remote content, and one browser permission
  // only: the microphone, for voice input (permissions.mjs).
  // Notifications are sent by this process instead (they must work while the window is hidden).
  const origin = new URL(running.url).origin;
  allowMicrophoneOnly(session.defaultSession, origin);

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: 'Orrery',
    icon: join(here, 'icon.ico'),
    // Until the page says otherwise (below), the background follows the system: dark ink or the light theme's white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12141d' : '#f1efea',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: join(here, 'preload.cjs') },
  });
  win.setMenu(null);
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin) e.preventDefault();
  });
  // Links in agent replies open in the person's browser; the app never opens windows of its own.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Started by Windows at sign-in: stay in the notification area until there is something to decide.
  const startHidden = process.argv.includes('--hidden');
  win.once('ready-to-show', () => startHidden || win.show());
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // keep supervising in the background
    win.hide();
  });
  // The theme chosen in settings lives in the page: once it has loaded, give the window the page's own background,
  // so resizing or a reload never shows the other theme's colour behind it.
  const matchPageBackground = () => {
    win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor', true)
      .then((c) => { if (typeof c === 'string' && c.startsWith('rgb')) win.setBackgroundColor(rgbToHex(c)); })
      .catch(() => {});
  };
  win.webContents.on('did-finish-load', matchPageBackground);
  win.on('focus', matchPageBackground); // after the theme was switched in settings
  nativeTheme.on('updated', matchPageBackground);
  // The page reports its theme (preload.cjs) at load and on every switch. Windows draws the title bar from
  // nativeTheme, so following the page keeps the bar white in light and dark in dark, even against the system setting.
  ipcMain.on('orrery:theme', (e, t) => {
    if (e.sender !== win.webContents) return;
    const source = t === 'light' || t === 'dark' ? t : 'system';
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
    matchPageBackground();
  });
  await win.loadURL(running.url);

  tray = new Tray(nativeImage.createFromPath(join(here, 'tray.png')));
  tray.on('click', () => showWindow());
  let timer = null;
  running.app.on('change', () => {
    timer ??= setTimeout(() => {
      timer = null;
      refresh();
    }, 400);
  });
  refresh();
  console.log(`[control-room] app ready (electron ${process.versions.electron}, node ${process.versions.node}), data: ${running.home}`);

  // Test hook: write process metrics once the UI has settled.
  if (process.env.CONTROL_ROOM_METRICS_FILE) {
    setTimeout(() => {
      const m = app.getAppMetrics().map((p) => ({ type: p.type, workingSetKB: p.memory.workingSetSize, privateKB: p.memory.privateBytes ?? null }));
      writeFileSync(process.env.CONTROL_ROOM_METRICS_FILE, JSON.stringify({ processes: m, totalWorkingSetMB: Math.round(m.reduce((a, p) => a + p.workingSetKB, 0) / 1024) }, null, 2));
    }, 12_000);
  }
}

const notified = new Set();
let firstRefresh = true;
let lastAttention = 0;

/** Keep the tray icon, its tooltip and its menu in step with the state, and announce new requests. */
function refresh() {
  if (!running || !tray || quitting) return;
  const snap = running.app.snapshot();
  const c = snap.counts;
  tray.setImage(nativeImage.createFromPath(join(here, c.needsAttention ? 'tray-alert.png' : 'tray.png')));
  tray.setToolTip(`Orrery\n判断待ち ${c.needsAttention}件 / 実行中 ${c.running}件${c.queued ? ` / 順番待ち ${c.queued}件` : ''}${c.candidates ? `\n完了にできる作業 ${c.candidates}件` : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: c.needsAttention ? `判断待ち ${c.needsAttention}件を開く` : 'Orrery を開く', click: () => showWindow('#/') },
      { type: 'separator' },
      { label: 'Windowsの起動時に開始', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }) },
      { type: 'separator' },
      { label: '終了（エージェントも停止）', click: () => void quit({ confirm: true }) },
    ]),
  );

  const focused = win?.isFocused() && win.isVisible();
  for (const item of snap.items) {
    if (item.status !== 'pending' || notified.has(item.id)) continue;
    notified.add(item.id);
    if (firstRefresh || focused || !Notification.isSupported()) continue;
    const kind = item.type === 'user_question' ? '質問' : '承認の依頼';
    const n = new Notification({ title: `${kind}: ${item.taskTitle}`, body: String(item.summary).slice(0, 160), icon: join(here, 'icon.png') });
    n.on('click', () => showWindow('#/'));
    n.show();
    console.log(`[control-room] notification shown: ${kind}`);
  }
  if (c.needsAttention > lastAttention && !focused) win?.flashFrame(true);
  lastAttention = c.needsAttention;
  firstRefresh = false;
}

async function quit({ confirm }) {
  if (quitting || !running) return;
  const c = running.app.snapshot().counts;
  const busy = c.running + c.waiting + c.queued;
  if (confirm && busy > 0) {
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['終了する', 'やめる'],
      defaultId: 1,
      cancelId: 1,
      title: 'Orrery',
      message: `実行中・判断待ち・順番待ちの作業が${busy}件あります。`,
      detail: '終了するとエージェントも停止します。会話は残り、次に起動したときに「中断」として表示され、続きを指示できます。',
    });
    if (r.response !== 0) return;
  }
  quitting = true;
  tray?.destroy();
  win?.destroy();
  // Never linger without a window: a process stuck here keeps the port and the single-instance lock, and the next
  // start would silently give up. Agents are in kill-on-close jobs, so exiting ends them anyway.
  await Promise.race([running.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  app.exit(0);
}

app.on('window-all-closed', () => {}); // stay in the tray
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void quit({ confirm: false });
});

/** "rgb(18, 20, 29)" -> "#12141d" (what BrowserWindow.setBackgroundColor takes). */
function rgbToHex(rgb) {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
  return '#' + [r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('');
}
