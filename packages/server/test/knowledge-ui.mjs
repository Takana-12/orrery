// Isolated Electron smoke test: real UI → HTTP → application → SQLite, without any provider calls.
// Run: npm run test:knowledge-ui
// Screenshots and the test database go under .control-room/; no everyday profile or data is opened.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { renderKnowledge } from '#core';
import { App } from '../src/app.ts';
import { Accounts } from '../src/application/accounts.ts';
import { startHttp } from '../src/interface/http/server.ts';
import { SqliteStore } from '../src/infrastructure/sqlite-store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
mkdirSync(join(root, '.control-room'), { recursive: true });
const out = mkdtempSync(join(root, '.control-room/knowledge-ui-'));
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
const until = async (check) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out waiting for the UI or saved state');
};
const run = (code) => win.webContents.executeJavaScript(code);
const section = (name) => `document.querySelector('textarea[aria-label="${name}のプロンプト"]')`;
const save = async (name, value) => {
  await run(`(() => { const box = ${section(name)}; box.value = ${JSON.stringify(value)}; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); })()`);
  await until(() => [...control.core.state.knowledge.entries.values()].some((e) => e.text === value));
};

async function verify() {
  try {
    const dbPath = join(out, 'test.sqlite');
    const seed = new SqliteStore(dbPath);
    for (const [i, text] of ['押したらすぐ画面に反応を返す。', '決定・保存のボタンを右に置く。'].entries()) {
      seed.append(i + 1, { type: 'knowledge.entry_added', entryId: `legacy-${i}`, domainId: 'ui', text, sessionId: null, scope: 'all', seen: false });
    }
    seed.close();
    control = new App({ dbPath });
    const merged = '押したらすぐ画面に反応を返す。\n\n決定・保存のボタンを右に置く。';
    assert.equal(control.core.state.knowledge.entries.size, 1);
    assert.equal([...control.core.state.knowledge.entries.values()][0].text, merged);
    const port = Number(process.env.ORRERY_TEST_PORT || 4873);
    server = await startHttp({ app: control, port, token: 'knowledge-ui-test', uiDir: join(root, 'packages/server/public') });
    win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.on('did-fail-load', (_event, code, message) => errors.push(`${code}: ${message}`));
    const page = `http://127.0.0.1:${port}`;
    await win.loadURL(page + '/#token=knowledge-ui-test');
    await until(() => run('!!document.querySelector(".home")'));
    await run('location.hash = "#/knowledge"');
    await until(() => run('document.querySelectorAll(".kn-domain").length === 6'));
    assert.equal(await run('[...document.querySelectorAll(".kn-domain")].every((d) => d.querySelectorAll("textarea").length === 1)'), true);
    assert.equal(await run('document.querySelectorAll(".kn-add, .kn-acts .chip").length'), 0);
    assert.equal(await run(`${section('UI・操作感')}.value`), merged);
    const updated = merged + '\n\n短い言葉で伝える。';
    await save('UI・操作感', updated);
    await save('文章・言葉づかい', '結論から書く。\n必要な前提と理由を添える。');
    assert.equal(control.core.state.knowledge.entries.size, 2);
    const long = '長'.repeat(5000) + '末尾も保存する';
    await save('コード構造・設計', long);
    const attached = renderKnowledge(control.core.state.knowledge, ['ui', 'writing', 'code'], null);
    assert.equal(attached.dropped, 1);
    assert.ok(attached.text.includes('長'.repeat(5000)));
    assert.ok(!attached.text.includes('末尾も保存する'));
    assert.equal(await run(`${section('コード構造・設計')}.closest('.kn-entry').querySelector('.kn-limit-note').hidden`), false);
    const copied = await run(`import('/js/logic/knowledge.js').then(async (m) => m.domainClipboard((await import('/js/logic/store.js')).store.state, 'code'))`);
    assert.ok(copied.endsWith('末尾も保存する'));

    for (const [theme, width] of [['dark', 1280], ['light', 1280], ['light', 520]]) {
      win.setSize(width, 1000);
      await run(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('main').scrollTop = 0`);
      await sleep(150);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
      writeFileSync(join(out, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.reload();
    await until(() => run('document.querySelectorAll(".kn-domain").length === 6'));
    assert.equal(await run(`${section('UI・操作感')}.value`), updated);
    assert.equal(await run(`${section('コード構造・設計')}.value`), long);
    await run('location.hash = "#/settings"');
    await until(() => run('!!document.querySelector(".kn-sum")'));
    assert.ok((await run('document.querySelector(".kn-sum").textContent')).includes('各5,000字まで添付'));
    const stored = control.snapshot().knowledge.entries;
    win.destroy();
    win = null;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    server = null;
    await control.shutdown();
    control = new App({ dbPath });
    assert.deepEqual(control.snapshot().knowledge.entries, stored);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ ok: true, sections: 6, storedPrompts: stored.length, screenshots: out }));
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ok: true, sections: 6, storedPrompts: stored.length, errors }));
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
// Electron must finish evaluating the main module before it can emit ready.
app.whenReady().then(verify);
