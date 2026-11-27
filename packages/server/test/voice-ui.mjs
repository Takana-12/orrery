// Isolated Electron smoke test of voice input: real UI → real HTTP (with its CSP) → application, with Chromium's fake
// microphone, a stand-in recogniser and a stand-in planner. No provider is called and no model is downloaded.
// Run: npm run test:voice-ui
// Screenshots of every phase go under .control-room/voice-ui-*/ (dark and light).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { allowMicrophoneOnly } from '../../../apps/desktop/permissions.mjs';
import { App } from '../src/app.ts';
import { Accounts } from '../src/application/accounts.ts';
import { Assistant } from '../src/application/assistant.ts';
import { startHttp } from '../src/interface/http/server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
mkdirSync(join(root, '.control-room'), { recursive: true });
const out = mkdtempSync(join(root, '.control-room/voice-ui-'));
const fail = (error) => {
  writeFileSync(join(out, 'result.json'), JSON.stringify({ ok: false, error: String(error?.stack || error) }));
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
mkdirSync(join(out, 'profile'), { recursive: true });
app.setPath('userData', join(out, 'profile'));
app.disableHardwareAcceleration();
// A microphone that needs no hardware and no prompt: Chromium's own test device (it beeps).
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAID = 'orreryのホーム画面のバグを直して。それとledgerの移行スクリプトにテストを足して、こっちはCodexでお願い。';
const MODELS = {
  claude: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], isDefault: true }, { id: 'haiku', label: 'Haiku', efforts: [] }],
  codex: [{ id: 'gpt-codex', label: 'GPT Codex', efforts: ['low', 'medium', 'high'], isDefault: true }],
};
Accounts.prototype.watch = () => {};
Accounts.prototype.refreshLimits = async () => [];
Accounts.prototype.listModels = async (provider) => MODELS[provider];
Accounts.prototype.view = () => ({ claude: { loggedIn: true, plan: null, loginInProgress: false, error: null }, codex: { loggedIn: true, plan: null, loginInProgress: false, error: null } });

/** The recogniser: remembers how much it was given and always hears the same sentence. */
const heard = [];
const MODEL_CHOICES = [
  { id: 'whisper-turbo', label: 'Whisper large-v3 turbo', note: '日本語に英語が混ざっても英語のまま書ける', state: 'ready', progress: 1, bytes: 1036613791, error: null },
  { id: 'sense-voice-small', label: 'SenseVoice Small', note: '速くて軽い', state: 'missing', progress: 0, bytes: 239549735, error: null },
];
const speech = {
  status: () => MODEL_CHOICES.find((m) => m.id === (control?.core.state.settings.voice.recognizer || 'whisper-turbo')),
  choices: () => MODEL_CHOICES,
  prepare: async () => {},
  warm: () => {},
  transcribe: async (samples) => { heard.push(samples.length); await sleep(700); return SAID; },
  close: () => {},
};
const planned = [];
Assistant.prototype.planVoice = async function (input, choice) {
  planned.push({ input, choice });
  await sleep(700);
  const [a, b] = input.projects;
  // Once there is work going on, the planner takes what was said as a reply to it, plus one new piece of work.
  if (input.sessions.length) return { tasks: [
    { sessionId: input.sessions[0].id, projectId: a.id, provider: 'claude', model: 'opus', effort: '', prompt: 'それでお願い。' },
    { sessionId: '', projectId: b.id, provider: 'codex', model: 'gpt-codex', effort: 'medium', prompt: '移行スクリプトにテストを足して。' },
  ] };
  return { tasks: [
    { projectId: a.id, provider: 'claude', model: 'opus', effort: 'medium', prompt: 'ホーム画面のバグを直して。' },
    { projectId: b.id, provider: 'codex', model: 'gpt-codex', effort: 'medium', prompt: '移行スクリプトにテストを足して。' },
  ] };
};
/** Putting English back: what the reply path asks for, answered the way the real AI does it. */
const tidied = [];
Assistant.prototype.tidyVoice = async function (input) {
  tidied.push(input);
  await sleep(300);
  return input.transcript.replace('orrery', 'Orrery');
};
const started = [];
App.prototype.startSession = async function (input) { started.push(input); return `fake-${started.length}`; };
const replies = [];
App.prototype.sendMessage = async function (sessionId, text) { replies.push({ sessionId, text }); return { ok: true }; };

let control, server, win;
const errors = [];
const until = async (check, what) => {
  for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); }
  throw new Error(`Timed out waiting for: ${what}`);
};
const run = (code) => win.webContents.executeJavaScript(code);
const voice = (field) => run(`import('/js/logic/store.js').then((m) => m.store.voice.${field})`);
const key = (type, keyCode) => win.webContents.sendInputEvent({ type, keyCode });
const shot = async (name) => writeFileSync(join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
const label = (sel) => `[...document.querySelectorAll('.voice-task')].map((t) => t.querySelector('${sel}')?.textContent ?? null)`;
const opacity = (sel) => run(`getComputedStyle(document.querySelector('${sel}')).opacity`);

async function verify() {
  try {
    control = new App({ dbPath: join(out, 'test.sqlite'), speech });
    const dirs = ['orrery', 'ledger'].map((n) => { const d = join(out, n); mkdirSync(d); return d; });
    const [p1, p2] = dirs.map((d) => control.addProject(d));
    control.setProjectOptions(p2, { useWorktree: false, approvalMode: 'edits' });
    const port = Number(process.env.ORRERY_TEST_PORT || 4874);
    server = await startHttp({ app: control, port, token: 'voice-ui-test', uiDir: join(root, 'packages/server/public') });
    const page = `http://127.0.0.1:${port}`;
    allowMicrophoneOnly(session.defaultSession, page); // the same rule as the real app
    win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.on('did-fail-load', (_event, code, message) => errors.push(`${code}: ${message}`));
    await win.loadURL(page + '/#token=voice-ui-test');
    await until(() => run('!!document.querySelector(".home")'), 'the home screen');
    win.webContents.focus();
    await run('document.activeElement?.blur()');

    // A short press is what it always was: home, with the new-work box ready. No layer.
    // (Right after loading, an offscreen window may not have the keyboard yet: press until the page has seen the key.)
    await run('window.__spaces = 0; document.addEventListener("keydown", (e) => { if (e.code === "Space") window.__spaces++; }, true)');
    for (let i = 0; i < 20 && !(await run('window.__spaces')); i++) {
      win.webContents.focus();
      key('keyDown', 'Space');
      await sleep(120);
      key('keyUp', 'Space');
      await sleep(200);
    }
    assert.equal(await run('window.__spaces'), 1, 'the page saw one short press');
    assert.equal(await run('!!document.activeElement?.matches("form.new textarea")'), true, 'a short press focuses the new-work box');
    await sleep(500);
    assert.equal(await voice('phase'), 'off', 'a short press does not open voice input');
    assert.equal(await run('document.activeElement.value'), '', 'the press itself types nothing');

    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      const before = started.length;
      // Held on home: no screen of its own opens. The home screen's sphere takes the voice (it grows and comes forward),
      // the box and the orbits recede, and the microphone opens. (The box is empty and focused: holding Space there speaks, too.)
      const orbWidth = () => run('document.querySelector(".home .voice-orb").getBoundingClientRect().width');
      const calm = await orbWidth();
      key('keyDown', 'Space');
      await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone');
      assert.equal(await run('document.body.dataset.voice'), 'home');
      assert.equal(await run('document.querySelector(".app").inert'), true, 'the screens under the layer take no input');
      await sleep(2200);
      assert.equal(await opacity('.main'), '1', 'the home screen stays: its sphere is the one that listens');
      assert.equal(await opacity('.home .s-foot'), '0', 'the new-work box has receded');
      assert.equal(await run('getComputedStyle(document.querySelector(".voice > .voice-orb")).display'), 'none', 'no second sphere');
      assert.ok((await orbWidth()) > calm * 1.1, 'the sphere has come forward');
      const sayTop = await run('document.querySelector(".voice-say").getBoundingClientRect().top');
      assert.ok(sayTop > (await run('(() => { const r = document.querySelector(".home .voice-orb").getBoundingClientRect(); return r.top + r.height / 2; })()')), 'the words are under the sphere');
      await shot(`${theme}-1-listening`);
      // Released: read, then planned; each step shows at once.
      key('keyUp', 'Space');
      await until(async () => (await voice('phase')) === 'thinking', 'thinking');
      await sleep(350);
      await shot(`${theme}-2-reading`);
      await until(async () => (await voice('text')) === SAID, 'what was heard');
      await sleep(350);
      await shot(`${theme}-3-planning`);
      await until(async () => (await voice('phase')) === 'review', 'the plan');
      await sleep(700);
      assert.equal(await run('document.querySelectorAll(".voice-task").length'), 2, 'one request became two pieces of work');
      assert.deepEqual(await run(label('.chip[aria-label^="ワークスペース"] .v')), ['orrery', 'ledger'], 'each with its workspace');
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
      await shot(`${theme}-4-review`);
      // Enter starts both; the layer closes and the screen comes back.
      key('keyDown', 'Enter');
      key('keyUp', 'Enter');
      await until(() => started.length === before + 2, 'both pieces of work to start');
      assert.equal(await voice('phase'), 'off');
      await sleep(1400);
      assert.equal(await opacity('.home .s-foot'), '1', 'the box is back');
      // (Its own size may differ now: the work just started changes what the box leaves free.)
      assert.deepEqual(await run('(() => { const s = getComputedStyle(document.querySelector(".home .voice-orb")); return [s.scale, s.translate]; })()'), ['none', '-50% -50%'], 'the sphere has glided back to its place');
      await shot(`${theme}-5-back`);
      await run('document.querySelector("form.new textarea").focus()');
    }

    assert.ok(heard.length === 2 && heard.every((n) => n > 8000), `the recording reached the recogniser as samples: ${heard}`);
    const { input, choice } = planned[0];
    assert.equal(input.transcript, SAID);
    assert.deepEqual(choice, { provider: 'claude', model: 'haiku', effort: '' }, 'the planner is the AI chosen in settings');
    assert.deepEqual(input.agents.map((a) => a.provider), ['claude', 'codex']);
    const first = started.find((s) => s.projectId === p1); // the two are sent side by side: either may arrive first
    const second = started.find((s) => s.projectId === p2);
    assert.deepEqual([first.projectId, first.provider, first.model, first.prompt], [p1, 'claude', 'opus', 'ホーム画面のバグを直して。']);
    assert.deepEqual([second.projectId, second.provider, second.model], [p2, 'codex', 'gpt-codex']);
    assert.equal(first.worktree, undefined, 'the worktree is left to the workspace\'s own setting');
    assert.equal(first.approvalMode, 'auto', 'approvals follow the workspace');
    assert.equal(second.approvalMode, 'ask', 'a mode Codex lacks becomes "ask every time", as in the new-work box');

    // Work going on: words spoken on its screen are a reply to it, and no AI reads them first.
    const work = control.core.createSession({ projectId: p1, provider: 'claude', title: 'READMEの更新' });
    control.core.sessionUpdate(work.id, { lifecycle: 'turn_finished', lastText: 'どちらの書き方にしますか？' });
    const plannedBefore = planned.length;
    await run(`location.hash = '#/s/${work.id}'`);
    await until(() => run('!!document.querySelector(".session .composer textarea")'), 'the work\'s screen');
    await run('document.querySelector(".session .composer textarea").focus()');
    key('keyDown', 'Space');
    await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone (reply)');
    assert.equal(await voice('replyTo'), work.id);
    assert.equal(await run('document.body.dataset.voice'), 'on', 'away from home, the layer has its own sphere');
    await sleep(600);
    key('keyUp', 'Space');
    await until(async () => (await voice('phase')) === 'review', 'the reply');
    await sleep(700);
    const faint = Number(await opacity('.main'));
    assert.ok(faint > 0 && faint < 0.5, `the work's screen shows faintly behind the layer: ${faint}`);
    assert.match(await run('getComputedStyle(document.querySelector(".main")).filter'), /blur/, 'and blurred');
    assert.equal(planned.length, plannedBefore, 'no planner for a reply on its own screen');
    assert.deepEqual(tidied.map((x) => [x.transcript, x.context.split('\n')[0]]), [[SAID, 'READMEの更新']], 'only its English is put back, knowing which work it answers');
    assert.equal(await run('document.querySelector(".voice-task .vt-prompt").value'), SAID.replace('orrery', 'Orrery'));
    assert.deepEqual(await run(label('.chip[aria-label^="送り先"] .v')), ['READMEの更新 に返信'], 'it says which work it answers');
    assert.deepEqual(await run(label('.chip[aria-label^="ワークスペース"]')), [null], 'a reply has no workspace or AI to choose');
    assert.equal(await run('document.querySelector(".voice-bar .primary").title'), '送る (Enter)');
    await shot('reply-1-review');
    key('keyDown', 'Enter');
    key('keyUp', 'Enter');
    await until(() => replies.length === 1, 'the reply to be sent');
    assert.deepEqual(replies[0], { sessionId: work.id, text: SAID.replace('orrery', 'Orrery') });
    assert.equal(await run('location.hash'), `#/s/${work.id}`, 'the work stays on screen');
    await sleep(900);
    await shot('reply-2-sent');

    // The microphone chip of the reply box does the same; the words are corrected right where they are shown.
    await run('document.querySelector(".session .composer button[aria-label=音声で返信]").click()');
    await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone (reply button)');
    await sleep(600);
    await run('document.querySelector(".voice-bar .primary").click()');
    await until(async () => (await voice('phase')) === 'review', 'the reply (button)');
    assert.equal(await run('!!document.querySelector(".voice-bar button[aria-label=入力欄で書き直す]")'), false, 'no trip to another box');
    assert.equal(await run('document.querySelector(".voice-task .vt-prompt").value'), SAID.replace('orrery', 'Orrery'));
    await run('(() => { const b = document.querySelector(".voice-task .vt-prompt"); b.focus(); b.value = "書き直した返信"; b.dispatchEvent(new Event("input", { bubbles: true })); })()');
    key('keyDown', 'Space');
    key('keyUp', 'Space');
    await sleep(300);
    assert.equal(await voice('phase'), 'review', 'a space typed while rewriting is a space');
    key('keyDown', 'Enter');
    key('keyUp', 'Enter');
    await sleep(300);
    assert.equal(await voice('phase'), 'review', 'Enter ends the rewrite first');
    assert.equal(await run('document.activeElement.id'), 'voice');
    await shot('reply-2b-rewritten');
    key('keyDown', 'Enter');
    key('keyUp', 'Enter');
    await until(() => replies.length === 2, 'the rewritten reply to be sent');
    assert.deepEqual(replies[1], { sessionId: work.id, text: '書き直した返信' });

    // Held on the work's screen with nothing focused: the screen stays where it is (no trip to home on the way), and
    // what is said from the moment the key went down is kept.
    await run('document.activeElement?.blur()');
    const heardBefore = heard.length;
    const pressed = Date.now();
    key('keyDown', 'Space');
    await sleep(150);
    assert.equal(await run('location.hash'), `#/s/${work.id}`, 'a press not yet known to be short leaves the screen alone');
    await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone (held on the work)');
    assert.equal(await run('location.hash'), `#/s/${work.id}`, 'held, it speaks over the work it began on');
    assert.equal(await voice('replyTo'), work.id);
    await sleep(Math.max(0, pressed + 1000 - Date.now()));
    const held = (Date.now() - pressed) / 1000;
    key('keyUp', 'Space');
    await until(() => heard.length === heardBefore + 1, 'the recording held on the work');
    const kept = heard.at(-1) / 16000;
    assert.ok(kept >= held - 0.25, `the recording starts with the key, not after the hold is certain: ${kept}s of ${held}s kept`);
    await until(async () => (await voice('phase')) === 'review', 'the reply (held on the work)');
    key('keyDown', 'Escape');
    key('keyUp', 'Escape');
    await until(async () => (await voice('phase')) === 'off', 'Esc to close');
    assert.equal(await run('location.hash'), `#/s/${work.id}`);
    // A short press there still opens home, once the key comes up.
    await run('document.activeElement?.blur()');
    key('keyDown', 'Space');
    await sleep(100);
    assert.equal(await run('location.hash'), `#/s/${work.id}`, 'not before the key comes up');
    key('keyUp', 'Space');
    await until(() => run('!!document.activeElement?.matches("form.new textarea")'), 'home with the new-work box focused');
    await sleep(500);
    assert.equal(await voice('phase'), 'off', 'a short press does not open voice input');
    await run(`location.hash = '#/s/${work.id}'`);
    await until(() => run('!!document.querySelector(".session .composer textarea")'), 'the work screen again');

    // Spoken elsewhere: the planner is shown the work going on and decides which part answers it.
    await run('location.hash = "#/"');
    await until(() => run('!!document.querySelector(".home")'), 'home again');
    await run('document.querySelector("form.new button[aria-label=音声で頼む]").click()');
    await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone (home)');
    await sleep(600);
    await run('document.querySelector(".voice-bar .primary").click()');
    await until(async () => (await voice('phase')) === 'review', 'the mixed plan');
    await sleep(700);
    assert.deepEqual(planned.at(-1).input.sessions.map((x) => [x.id, x.title, x.last]), [[work.id, 'READMEの更新', 'どちらの書き方にしますか？']]);
    assert.deepEqual(await run(label('.chip[aria-label^="送り先"] .v')), ['READMEの更新 に返信', '新しい作業として始める']);
    assert.deepEqual(await run(label('.chip[aria-label^="ワークスペース"] .v')), [null, 'ledger']);
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
    await shot('reply-3-mixed');
    const startedBefore = started.length;
    key('keyDown', 'Enter');
    key('keyUp', 'Enter');
    await until(() => replies.length === 3 && started.length === startedBefore + 1, 'one reply and one new piece of work');
    assert.deepEqual(replies[2], { sessionId: work.id, text: 'それでお願い。' });

    // The microphone chip: the same layer for the hand on the mouse, ended and cancelled with visible buttons.
    await run('document.querySelector("form.new button[aria-label=音声で頼む]").click()');
    await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone (button)');
    assert.equal(await run('document.querySelectorAll(".voice-bar button").length'), 2, 'cancel at the left, done at the right');
    key('keyDown', 'Escape');
    key('keyUp', 'Escape');
    await until(async () => (await voice('phase')) === 'off', 'Esc to close');

    // The sphere on home is a microphone too: what lies at its centre (and a little past its edge) is its button.
    await until(() => run('!document.body.hasAttribute("data-voice")'), 'the layer gone');
    const hit = `((dx) => { const r = document.querySelector(".home .voice-orb").getBoundingClientRect(); const sr = r.width * 58 / 420;
      return document.elementFromPoint(r.left + r.width / 2 + dx * sr, r.top + r.height / 2)?.className; })`;
    assert.equal(await run(`${hit}(0)`), 'orbit-mic', 'the sphere\'s centre is its button');
    assert.equal(await run(`${hit}(1.3)`), 'orbit-mic', 'a little past its edge, too');
    await run(`document.elementFromPoint(...(() => { const r = document.querySelector(".home .voice-orb").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()).click()`);
    await until(async () => (await voice('phase')) === 'listening' && (await voice('live')), 'the microphone (sphere)');
    key('keyDown', 'Escape');
    key('keyUp', 'Escape');
    await until(async () => (await voice('phase')) === 'off', 'Esc to close (sphere)');

    // In a text box that has words in it, Space is a space.
    await run('(() => { const b = document.querySelector("form.new textarea"); b.focus(); b.value = "abc"; b.dispatchEvent(new Event("input", { bubbles: true })); })()');
    key('keyDown', 'Space');
    await sleep(600);
    key('keyUp', 'Space');
    assert.equal(await voice('phase'), 'off', 'holding Space while writing does not open voice input');

    // Settings: the planner's AI and the confirmation switch are drawn with their saved values, and saving shows at once.
    await run('document.activeElement?.blur(); location.hash = "#/settings"');
    await until(() => run('!!document.querySelector("#set-voice")'), 'the voice section of settings');
    assert.equal(await run('document.querySelector("#set-voice input.switch").checked'), true);
    assert.match(await run('document.querySelector("#set-voice .ai-chip").title'), /Claude/);
    await run('document.querySelector("#set-voice input.switch").click()');
    await until(() => control.core.state.settings.voice.confirm === false, 'the switch to be saved');
    // The recogniser: the chosen one, with what each is good at; switching shows at once and is saved.
    assert.match(await run('document.querySelector("#set-voice button[aria-label^=音声認識モデル]").textContent'), /Whisper/);
    await run('document.querySelector("#set-voice button[aria-label^=音声認識モデル]").click()');
    await until(() => run('!!document.querySelector(".menu-item")'), 'the list of recognisers');
    assert.match(await run('[...document.querySelectorAll(".menu-item")].map((b) => b.textContent).join("|")'), /Whisper.*英語のまま.*\|SenseVoice.*速くて軽い.*MB/);
    await run('[...document.querySelectorAll(".menu-item")].find((b) => b.textContent.includes("SenseVoice")).click()');
    assert.match(await run('document.querySelector("#set-voice button[aria-label^=音声認識モデル]").textContent'), /SenseVoice/, 'shown at the click');
    await until(() => control.core.state.settings.voice.recognizer === 'sense-voice-small', 'the recogniser to be saved');
    await until(() => run('document.querySelector("#set-voice .lab small")?.parentElement && [...document.querySelectorAll("#set-voice small")].some((s) => /初回に自動でダウンロード/.test(s.textContent))'), 'the new model\'s download to be described');
    // The human's words: saved when the box is left.
    await run('(() => { const b = document.querySelector("#set-voice textarea.voice-words"); b.focus(); b.value = "Orrery\\n\\n  Unity "; b.dispatchEvent(new Event("input", { bubbles: true })); b.blur(); b.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await until(() => control.core.state.settings.voice.words === 'Orrery\nUnity', 'the words to be saved');
    await run('document.querySelector("#set-voice").scrollIntoView()');
    await sleep(300);
    await shot('settings');

    assert.equal(errors.length, 0, errors.join('\n'));
    const result = { ok: true, heard, started: started.length, screenshots: out };
    console.log(JSON.stringify(result));
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ...result, errors }));
  } catch (error) {
    console.error(error);
    writeFileSync(join(out, 'result.json'), JSON.stringify({ ok: false, error: String(error.stack || error), errors, heard }));
    if (win && !win.isDestroyed()) await shot('failed').catch(() => {});
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
