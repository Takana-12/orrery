// Isolated Electron smoke test of "a newer version on GitHub": real UI → HTTP, with an invented updater in place of the
// app shell's (no git, no GitHub). Run: npm run test:update-ui
// Screenshots and the test database go under .control-room/; no everyday profile or data is opened.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { App } from '../src/app.ts';
import { Accounts } from '../src/application/accounts.ts';
import { startHttp } from '../src/interface/http/server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
mkdirSync(join(root, '.control-room'), { recursive: true });
const out = mkdtempSync(join(root, '.control-room/update-ui-'));
const fail = (error) => {
  writeFileSync(join(out, 'result.json'), JSON.stringify({ ok: false, error: String(error?.stack || error) }));
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
mkdirSync(join(out, 'profile'), { recursive: true });
app.setPath('userData', join(out, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
Accounts.prototype.watch = () => {};
Accounts.prototype.refreshLimits = async () => [];
Accounts.prototype.listModels = async () => [];

let control, server, win;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what = 'the UI') => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50); }
  throw new Error(`Timed out waiting for ${what}`);
};
const run = (code) => win.webContents.executeJavaScript(code);

// The app shell's updater, invented: starts with nothing new; check() finds v0.5.0 on GitHub.
const calls = [];
let remote = { tracking: 'origin/main', behind: 0, ahead: 0, latest: null, checkedAt: 1795000000000, checking: false, error: null };
const updater = {
  status: () => ({ mode: 'packaged', repo: 'C:\\orrery', canBuild: true, version: '0.4.0', build: { builtAt: 1795000000000, commit: 'abcdef0', dirty: false }, source: { commit: 'abcdef0', subject: 'v0.4.0', dirty: false }, upToDate: true, remote, phase: 'idle', startedAt: null, error: null, log: [] }),
  update: async () => void calls.push('update'),
  restart: async () => void calls.push('restart'),
  check: async () => {
    calls.push('check');
    remote = { ...remote, behind: 2, latest: { commit: '1234567', subject: 'v0.5.0 の更新を反映' }, checkedAt: Date.now() };
    control.emit('change');
    return updater.status();
  },
  newVersion: () => (remote.behind > 0 ? { behind: remote.behind, subject: remote.latest.subject, commit: remote.latest.commit, canPull: true } : null),
};

async function verify() {
  try {
    control = new App({ dbPath: join(out, 'test.sqlite') });
    const port = Number(process.env.ORRERY_TEST_PORT || 4874);
    server = await startHttp({ app: control, port, token: 'update-ui-test', uiDir: join(root, 'packages/server/public'), appUpdate: updater });
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.on('did-fail-load', (_event, code, message) => errors.push(`${code}: ${message}`));
    await win.loadURL(`http://127.0.0.1:${port}/#token=update-ui-test`);
    await until(() => run('!!document.querySelector(".home")'));

    // Nothing new: the rail's button is plain.
    assert.equal(await run('document.querySelector(".update-btn").classList.contains("has-new")'), false);

    // Settings: the row says when it was checked; "今すぐ確認" asks the updater, and the rail lights up by itself.
    await run('location.hash = "#/settings"');
    await until(() => run('[...document.querySelectorAll(".set-row b")].some((b) => b.textContent === "GitHub の新しい版")'), 'the GitHub row');
    const rowText = 'const r = [...document.querySelectorAll(".set-row")].find((x) => x.querySelector("b")?.textContent === "GitHub の新しい版"); r';
    await until(() => run(`(() => { ${rowText}; return !r.hidden && r.textContent.includes("最新です"); })()`), 'up to date');
    await run(`(() => { ${rowText}; [...r.querySelectorAll("button")].find((b) => b.textContent.includes("今すぐ確認")).click(); })()`);
    await until(() => run('document.querySelector(".update-btn").classList.contains("has-new")'), 'the rail to show the new version');
    assert.deepEqual(calls, ['check']);
    assert.match(await run('document.querySelector(".update-btn").title'), /GitHub に新しい版があります：「v0\.5\.0 の更新を反映」ほか、2件の変更/);
    await until(() => run(`(() => { ${rowText}; return r.textContent.includes("v0.5.0 の更新を反映"); })()`), 'the row to show the new version');

    // The rail's button: the dialog says what will be brought in; confirming starts the update.
    await run('document.querySelector(".update-btn").click()');
    await until(() => run('!!document.querySelector("dialog[open]")'), 'the update dialog');
    const dialog = await run('document.querySelector("dialog[open]").textContent');
    assert.match(dialog, /GitHub に新しい版があります/);
    assert.match(dialog, /git pull/);
    await sleep(600);
    writeFileSync(join(out, 'dialog.png'), (await win.webContents.capturePage()).toPNG());
    await run('[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.includes("更新する")).click()');
    await until(async () => calls.includes('update'), 'the update to start');

    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ ok: true, calls, screenshots: out }));
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ok: true, calls, errors }));
  } catch (error) {
    console.error(error);
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ok: false, error: String(error.stack || error), errors }));
    process.exitCode = 1;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (server) { server.closeAllConnections(); server.close(); }
    if (control) await control.shutdown();
    app.exit(process.exitCode || 0);
  }
}
app.whenReady().then(verify);
