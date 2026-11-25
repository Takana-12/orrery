// Takes the README's screenshots from the real UI, filled with invented work, so they can be retaken whenever the UI
// changes. Run: npm run screenshots   (writes docs/images/*.png)
// No provider is started and no everyday profile or data is opened: the database lives in a temporary folder under
// .control-room/, and every name, path and text below is made up (nothing of this machine or its owner appears).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { App } from '../packages/server/src/app.ts';
import { Accounts } from '../packages/server/src/application/accounts.ts';
import { startHttp } from '../packages/server/src/interface/http/server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const images = join(root, 'docs/images');
mkdirSync(join(root, '.control-room'), { recursive: true });
mkdirSync(images, { recursive: true });
const out = mkdtempSync(join(root, '.control-room/readme-shots-'));
const fail = (error) => {
  console.error(error);
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
mkdirSync(join(out, 'profile'), { recursive: true });
app.setPath('userData', join(out, 'profile'));
app.disableHardwareAcceleration();
// Sharp text on high-density screens, where most people will read the README.
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.on('window-all-closed', () => {});
Accounts.prototype.watch = () => {};
// Plan usage, so the meters under the list show something (no provider is asked).
const HOUR = 3_600_000;
const LIMITS = {
  claude: [{ label: '5 時間', kind: 'five_hour', usedPercent: 42, resetsAt: Date.now() + 2 * HOUR }, { label: '週間', kind: 'weekly', usedPercent: 18, resetsAt: Date.now() + 80 * HOUR }],
  codex: [{ label: '5 時間', kind: 'five_hour', usedPercent: 25, resetsAt: Date.now() + 3 * HOUR }, { label: '週間', kind: 'weekly', usedPercent: 61, resetsAt: Date.now() + 50 * HOUR }],
};
Accounts.prototype.refreshLimits = async function (provider) {
  const limits = LIMITS[provider] ?? [];
  this.limitCache.set(provider, { at: Date.now(), limits });
  return limits;
};
Accounts.prototype.listModels = async () => [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The invented work: three workspaces, and pieces of work in each state the inbox and the list distinguish. */
function seed(control) {
  const core = control.core;
  const journal = control.journal;
  const ws = (name, path, description) => {
    const id = core.addProject(name, path);
    core.setProjectOptions(id, { description });
    return id;
  };
  const shop = ws('shop-web', 'D:\\dev\\shop-web', 'EC サイトのフロントエンド');
  const billing = ws('billing-api', 'D:\\dev\\billing-api', '請求と決済の API');
  const docs = ws('docs-site', 'D:\\dev\\docs-site', '製品ドキュメント');
  const session = (projectId, provider, title, model, extra = {}) => core.createSession({ projectId, provider, title, model, ...extra }).id;
  const say = (id, role, text) => journal.write(id, role, text);
  const noop = () => {};

  // A question with choices (Codex).
  const q = session(billing, 'codex', '請求テーブルの設計', 'gpt-5.5');
  say(q, 'user', '月額プランと従量課金を同じ請求書に載せられるようにしてください。');
  say(q, 'assistant', 'いまの invoices テーブルは月額プランだけを前提にしています。進め方が 2 つあります。');
  core.sessionUpdate(q, { lifecycle: 'waiting_for_user', process: 'alive' });
  core.attentionOpen({
    sessionId: q, requestId: 'q1', type: 'user_question', summary: '請求明細の持ち方を選んでください', reply: noop,
    questions: [{
      id: 'q1', header: '設計', text: '請求明細の持ち方はどちらにしますか？', multiSelect: false, allowFreeText: true, isSecret: false,
      options: [
        { label: 'invoices に列を追加する', description: '変更が小さく、既存の集計がそのまま動く' },
        { label: 'invoice_items テーブルを新しく作る', description: '明細が増えても扱いやすい（移行が必要）' },
      ],
    }],
  });

  // A command waiting for approval (Claude).
  const a = session(shop, 'claude', '商品一覧の読み込みを速くする', 'claude-opus-5-5', { checkCommand: 'npm test' });
  say(a, 'user', '商品一覧の初回表示が遅いので速くしてください。');
  say(a, 'assistant', '画像の読み込みを遅延させ、一覧の API を 1 回にまとめました。テストを実行します。');
  core.sessionUpdate(a, { lifecycle: 'waiting_for_user', process: 'alive' });
  core.attentionOpen({
    sessionId: a, requestId: 'a1', type: 'permission_approval', summary: 'コマンドの実行', reply: noop,
    approval: { tool: 'Bash', subject: 'npm run test -- --filter product-list', cwd: 'D:\\dev\\shop-web', reason: '変更した一覧画面のテストを実行します', decisions: ['accept', 'acceptForSession', 'decline'] },
  });

  // Finished by the agent; what is left is the human's (Claude).
  const h = session(shop, 'claude', '決済画面のエラー表示を直す', 'claude-sonnet-5');
  say(h, 'user', 'カードが拒否されたときに、何が起きたか分かるようにしてください。');
  say(h, 'assistant', '拒否の理由ごとに文言を分け、入力欄の近くに出すようにしました。PR #412 を作りました。');
  core.sessionUpdate(h, { lifecycle: 'turn_finished', process: 'stopped', lastTurnOutcome: 'completed', lastText: 'PR #412 を作りました。' });
  core.setHumanSteps(h, [
    { title: 'PR #412 をマージする', detail: 'テストはすべて通っています。', command: 'gh pr merge 412 --squash' },
    { title: '本番の決済画面で、拒否されたカードの表示を確かめる', detail: 'テスト用カード 4000 0000 0000 0002 で確かめられます。', command: null },
  ]);

  // Running, with what it is doing right now (Codex, two workspaces).
  const r = session(docs, 'codex', 'API リファレンスを最新の仕様に合わせる', 'gpt-5.5', { extraProjectIds: [billing] });
  say(r, 'user', 'billing-api の変更に合わせて、API リファレンスを更新してください。');
  core.sessionUpdate(r, { lifecycle: 'running', process: 'alive' });
  say(r, 'tool', '▶ Read {"file_path":"docs/api/invoices.md"}');
  say(r, 'tool', '▶ Edit {"file_path":"docs/api/invoices.md"}');

  const r2 = session(billing, 'claude', '領収書 PDF の文字化けを直す', 'claude-opus-5-5', { checkCommand: 'npm test' });
  say(r2, 'user', '領収書 PDF で、宛名の漢字が一部 □ になります。');
  core.sessionUpdate(r2, { lifecycle: 'running', process: 'alive' });
  say(r2, 'tool', '▶ Bash {"command":"npm test -- receipt"}');

  // Done, and the check passed.
  const d = session(docs, 'claude', 'はじめにのページを書き直す', 'claude-sonnet-5', { checkCommand: 'npm run build' });
  say(d, 'user', 'はじめにのページを、初めての人向けに短くしてください。');
  say(d, 'assistant', '手順を 3 つにまとめ、インストールの節を先頭に移しました。');
  core.sessionUpdate(d, { lifecycle: 'turn_finished', process: 'stopped', lastTurnOutcome: 'completed', lastText: '手順を 3 つにまとめました。' });
  const task = core.state.sessions.get(d).taskId;
  core.validated(task, { command: 'npm run build', ok: true, exitCode: 0, outputTail: 'build complete', at: Date.now(), uncommittedFiles: 0 });

  return { q, a, h, r };
}

async function shoot(win, name, { width = 1280, height = 800, theme = 'dark' } = {}) {
  win.setContentSize(width, height);
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
  await win.webContents.executeJavaScript(`for (const el of document.querySelectorAll('main, .scroll, [class*="scroll"]')) el.scrollTop = 0`);
  // A hidden window paints lazily: the first capture after a change can still hold the previous frame.
  win.webContents.invalidate();
  await sleep(800);
  await win.webContents.capturePage();
  await sleep(300);
  const file = join(images, `${name}.png`);
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  console.log(`[screenshots] ${file}`);
}

async function main() {
  let control, server, win;
  try {
    control = new App({ dbPath: join(out, 'shots.sqlite') });
    const ids = seed(control);
    const port = Number(process.env.ORRERY_TEST_PORT || 4875);
    server = await startHttp({ app: control, port, token: 'readme-shots', uiDir: join(root, 'packages/server/public') });
    win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const run = (code) => win.webContents.executeJavaScript(code);
    await win.loadURL(`http://127.0.0.1:${port}/#token=readme-shots`);
    for (let i = 0; i < 100 && !(await run('!!document.querySelector(".home")')); i++) await sleep(50);
    await sleep(500);
    await shoot(win, 'inbox');
    await run(`location.hash = '#/s/${ids.a}'`);
    await sleep(600);
    await shoot(win, 'session');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (server) { server.closeAllConnections(); server.close(); }
    if (control) await control.shutdown();
    app.exit(process.exitCode || 0);
  }
}
app.whenReady().then(main);
