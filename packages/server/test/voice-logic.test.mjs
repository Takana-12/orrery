// Voice input in the page's logic layer (public/js/logic/voice.js), without a browser or a microphone: every step
// shows at once, what the server refuses is said and nothing is lost, and work starts with each workspace's own settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setVoiceSettings } from '../public/js/logic/actions.js';
import { store } from '../public/js/logic/store.js';
import { beginVoice, cancelVoice, confirmVoice, coolVoice, dropVoiceTask, endVoice, setVoicePrompt, setVoiceTask, voiceIo, voiceLevel, voiceReplyTargets, voiceToBox, warmVoice } from '../public/js/logic/voice.js';
import { micProblem, toPcm16 } from '../public/js/logic/voice-capture.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAN = { tasks: [
  { projectId: 'p1', provider: 'claude', model: 'opus', effort: 'medium', prompt: 'ホーム画面のバグを直して。' },
  { projectId: 'p2', provider: 'codex', model: 'gpt', effort: 'high', prompt: '移行スクリプトにテストを足して。' },
] };

/** The server: answers by path after a moment. `answers[path]` = [status, body]; anything else is 200 { ok: true }. */
function server(answers = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    calls.push({ path, body });
    await sleep(5);
    const [status, answer] = answers[path] ?? [200, path === '/api/voice/transcribe' ? { text: ' orreryのバグを直して、それとledgerにテストを足して ' } : path === '/api/voice/plan' ? PLAN : path === '/api/sessions' ? { sessionId: `s${calls.length}` } : { ok: true }];
    return new Response(JSON.stringify(answer), { status });
  };
  return calls;
}
/** A microphone that is open after a moment and gives back `seconds` of speech at `peak`. */
function mic({ seconds = 2, peak = 0.4, refuse = null } = {}) {
  const m = { opened: 0, stopped: 0, cancelled: 0 };
  voiceIo.openMic = async () => {
    m.opened++;
    await sleep(5);
    if (refuse) throw Object.assign(new Error('no'), { name: refuse });
    return { level: () => 0.5, stop: () => (m.stopped++, { pcm: new Int16Array(16000 * seconds), seconds, peak }), cancel: () => void m.cancelled++ };
  };
  return m;
}
/** Work going on: s1 has answered and waits, s2 was put away, s3 was accepted as done. */
const SESSIONS = [
  { id: 's1', projectId: 'p2', provider: 'codex', model: 'gpt', effort: 'high', taskTitle: 'READMEの更新', projectName: 'ledger', lifecycle: 'turn_finished', completion: 'unverified', archived: false, updatedAt: 2 },
  { id: 's2', projectId: 'p1', provider: 'claude', model: 'opus', effort: '', taskTitle: '片付け済み', projectName: 'orrery', lifecycle: 'turn_finished', completion: 'unverified', archived: true, updatedAt: 3 },
  { id: 's3', projectId: 'p1', provider: 'claude', model: 'opus', effort: '', taskTitle: '完了済み', projectName: 'orrery', lifecycle: 'turn_finished', completion: 'accepted', archived: false, updatedAt: 1 },
  { id: 's4', projectId: 'p1', provider: 'claude', model: 'opus', effort: '', taskTitle: 'ホーム画面', projectName: 'orrery', lifecycle: 'turn_finished', completion: 'unverified', archived: false, updatedAt: 4 },
];

function reset({ confirm = true } = {}) {
  cancelVoice();
  store.effects = [];
  store.notices.length = 0;
  store.sending.length = 0;
  store.outbox.clear();
  store.composerDrafts.clear();
  store.composerFill.clear();
  store.newDraft = { prompt: '', error: '', sent: null, planMode: false, fill: null };
  store.receive({
    sessions: structuredClone(SESSIONS), items: [], counts: {},
    settings: { maxConcurrent: 3, minFreeMemoryMB: 0, voice: { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm } },
    auth: { claude: { loginInProgress: false }, codex: { loginInProgress: false } },
    projects: [{ id: 'p1', name: 'orrery', rootPath: 'C:\\work\\orrery' }, { id: 'p2', name: 'ledger', rootPath: 'C:\\work\\ledger', approvalMode: 'edits', useWorktree: false }],
    voice: { model: { state: 'ready', progress: 1 } },
  });
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await sleep(5); assert.ok(check(), 'timed out'); };

test('hold, speak, release: listening shows at once, then what was heard, then the plan; go starts each piece its own way', async () => {
  reset();
  const calls = server();
  mic();
  store.newDraft.prompt = '書きかけ';
  beginVoice('hold');
  assert.deepEqual([store.voice.phase, store.voice.live], ['listening', false], 'the layer opens before the microphone has answered');
  await until(() => store.voice.live);
  assert.equal(voiceLevel(), 0.5);
  const done = endVoice();
  assert.equal(store.voice.phase, 'thinking', 'releasing the key shows at once');
  await until(() => store.voice.text);
  assert.equal(store.voice.text, 'orreryのバグを直して、それとledgerにテストを足して');
  assert.equal(store.voice.phase, 'thinking', 'what was heard shows while the work is still being planned');
  await done;
  assert.equal(store.voice.phase, 'review');
  assert.deepEqual(store.voice.tasks.map((t) => [t.projectId, t.provider, t.model, t.effort]), [['p1', 'claude', 'opus', 'medium'], ['p2', 'codex', 'gpt', 'high']]);
  assert.equal(calls.find((c) => c.path === '/api/voice/transcribe').body.length, 32000, 'the recording is sent as it is: 16-bit samples');
  assert.equal(calls.find((c) => c.path === '/api/voice/plan').body.text, store.voice.text);
  assert.equal(calls.filter((c) => c.path === '/api/sessions').length, 0, 'nothing starts before the human says go');

  confirmVoice();
  assert.equal(store.voice.phase, 'off', 'the layer closes at once');
  assert.deepEqual(store.sending.map((x) => [x.title, x.projectName, x.provider]), [['ホーム画面のバグを直して。', 'orrery', 'claude'], ['移行スクリプトにテストを足して。', 'ledger', 'codex']], 'each piece shows in the rail, with its workspace');
  assert.equal(store.newDraft.prompt, '書きかけ', 'what was being typed in the new-work box is left alone');
  await until(() => store.sending.every((x) => x.sessionId));
  const started = calls.filter((c) => c.path === '/api/sessions').map((c) => c.body).sort((a, b) => a.projectId.localeCompare(b.projectId));
  assert.deepEqual(started.map((b) => [b.projectId, b.provider, b.model, b.effort, b.prompt, b.approvalMode]), [
    ['p1', 'claude', 'opus', 'medium', 'ホーム画面のバグを直して。', 'auto'],
    ['p2', 'codex', 'gpt', 'high', '移行スクリプトにテストを足して。', 'ask'], // "edits" is not a Codex mode: ask every time, as the new-work box does
  ]);
  assert.ok(started.every((b) => !('worktree' in b)), 'the worktree is left to each workspace\'s own setting');
});

test('with confirmation off the work starts by itself', async () => {
  reset({ confirm: false });
  const calls = server();
  mic();
  beginVoice('toggle');
  await until(() => store.voice.live);
  await endVoice();
  assert.equal(store.voice.phase, 'off');
  assert.equal(store.sending.length, 2);
  await until(() => calls.filter((c) => c.path === '/api/sessions').length === 2);
});

test('the plan can be changed before it starts: where, who, or not at all', async () => {
  reset();
  const calls = server();
  mic();
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  const [a, b] = store.voice.tasks;
  setVoiceTask(a.key, { projectId: 'p2' });
  setVoiceTask(a.key, { provider: 'codex', model: 'gpt', effort: 'low' });
  dropVoiceTask(b.key);
  assert.equal(store.voice.tasks.length, 1);
  confirmVoice();
  await until(() => calls.some((c) => c.path === '/api/sessions'));
  await sleep(30);
  const sent = calls.filter((c) => c.path === '/api/sessions').map((c) => c.body);
  assert.deepEqual(sent.map((x) => [x.projectId, x.provider, x.model, x.effort]), [['p2', 'codex', 'gpt', 'low']]);
  // Taking the last one out is the same as cancelling.
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  for (const t of [...store.voice.tasks]) dropVoiceTask(t.key);
  assert.equal(store.voice.phase, 'off');
});

test('the words of the plan are rewritten where they are shown and sent as rewritten; one rubbed out is not sent', async () => {
  reset();
  const calls = server();
  mic();
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  const [a, b] = store.voice.tasks;
  setVoicePrompt(a.key, '  書き直した依頼\n二行目  ');
  setVoicePrompt(b.key, '   ');
  assert.equal(store.voice.phase, 'review', 'rewriting does not move on by itself');
  confirmVoice();
  assert.equal(store.voice.phase, 'off');
  await until(() => calls.some((c) => c.path === '/api/sessions'));
  await sleep(30);
  assert.deepEqual(calls.filter((c) => c.path === '/api/sessions').map((c) => c.body.prompt ?? c.body.text), ['書き直した依頼\n二行目']);
  // Every request rubbed out: nothing is sent, the layer just closes.
  const before = calls.length;
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  for (const t of store.voice.tasks) setVoicePrompt(t.key, '');
  confirmVoice();
  assert.equal(store.voice.phase, 'off');
  await sleep(30);
  assert.equal(calls.slice(before).filter((c) => c.path === '/api/sessions').length, 0);
});

test('a slip of the key or a silent microphone asks the server nothing and just closes', async () => {
  for (const rec of [{ seconds: 0.2 }, { peak: 0.001 }]) {
    reset();
    const calls = server();
    mic(rec);
    beginVoice();
    await until(() => store.voice.live);
    await endVoice();
    assert.equal(store.voice.phase, 'off');
    assert.equal(calls.filter((c) => c.path !== '/api/voice/prepare').length, 0);
  }
  // Released before the microphone was even open.
  reset();
  const m = mic();
  beginVoice();
  await endVoice();
  assert.equal(store.voice.phase, 'off');
  await sleep(20);
  assert.equal(m.cancelled, 1, 'the microphone that opened too late is closed again');
});

test('what goes wrong is said in the layer, and what was heard can still be taken to the new-work box', async () => {
  reset();
  mic();
  server({ '/api/voice/transcribe': [200, { text: '' }] });
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  assert.deepEqual([store.voice.phase, store.voice.error], ['error', '聞き取れませんでした']);

  server({ '/api/voice/transcribe': [503, { error: '音声認識を起動できませんでした' }] });
  beginVoice(); // speaking again from the error
  await until(() => store.voice.live);
  await endVoice();
  assert.deepEqual([store.voice.phase, store.voice.error], ['error', '音声認識を起動できませんでした']);

  server({ '/api/voice/plan': [502, { error: '依頼を読み取れませんでした' }] });
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  assert.deepEqual([store.voice.phase, store.voice.error, store.voice.text], ['error', '依頼を読み取れませんでした', 'orreryのバグを直して、それとledgerにテストを足して']);
  voiceToBox();
  assert.equal(store.voice.phase, 'off');
  assert.equal(store.newDraft.fill, 'orreryのバグを直して、それとledgerにテストを足して');

  for (const [name, word] of [['NotAllowedError', 'マイクを使う許可がありません'], ['NotFoundError', 'マイクが見つかりません'], ['AbortError', 'マイクを開けませんでした']]) {
    reset();
    server();
    mic({ refuse: name });
    beginVoice();
    await until(() => store.voice.phase === 'error');
    assert.equal(store.voice.error, word);
    assert.equal(micProblem({ name }), word);
  }
});

test('cancelling closes at once and a late answer changes nothing; work that cannot start says so', async () => {
  reset();
  const calls = server();
  const m = mic();
  beginVoice();
  await until(() => store.voice.live);
  cancelVoice();
  assert.equal(store.voice.phase, 'off');
  assert.equal(m.cancelled, 1);
  beginVoice();
  await until(() => store.voice.live);
  const reading = endVoice();
  cancelVoice(); // Esc while it is being read
  await reading;
  await sleep(30);
  assert.equal(store.voice.phase, 'off');
  assert.equal(calls.filter((c) => c.path === '/api/voice/plan').length, 0);

  reset({ confirm: false });
  server({ '/api/sessions': [409, { error: '断られました' }] });
  mic();
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  await until(() => store.notices.length === 2);
  assert.match(store.notices[0].text, /「ホーム画面のバグを直して。」を始められませんでした: 断られました/);
  assert.ok(store.sending.every((x) => x.error), 'the rail shows which could not be sent');
});

test('voice settings show at once and are taken back if refused', async () => {
  reset();
  server();
  const ok = setVoiceSettings({ confirm: false });
  assert.equal(store.state.settings.voice.confirm, false);
  assert.deepEqual(store.state.settings.voice.plannerAi, { provider: 'claude', model: 'haiku', effort: '' }, 'the other field is untouched');
  await ok;
  server({ '/api/settings': [409, { error: '断られました' }] });
  store.receive({ ...store.server });
  const refused = setVoiceSettings({ plannerAi: { provider: 'codex', model: 'gpt', effort: 'low' } });
  assert.deepEqual(store.state.settings.voice.plannerAi, { provider: 'codex', model: 'gpt', effort: 'low' });
  await refused;
  assert.deepEqual(store.state.settings.voice.plannerAi, { provider: 'claude', model: 'haiku', effort: '' });
  assert.equal(store.notices.length, 1);
});

test('spoken on a piece of work\'s screen, all of it is a reply to that work: no planner, sent as if typed there', async () => {
  reset();
  const calls = server({ '/api/voice/tidy': [200, { text: 'Orreryのバグを直して、それとledgerにテストを足して' }] });
  mic();
  beginVoice('hold', { replyTo: 's1' });
  assert.equal(store.voice.replyTo, 's1');
  await until(() => store.voice.live);
  await endVoice();
  assert.equal(store.voice.phase, 'review');
  assert.equal(calls.filter((c) => c.path === '/api/voice/plan').length, 0, 'no planner reads it');
  assert.deepEqual(calls.find((c) => c.path === '/api/voice/tidy').body, { text: 'orreryのバグを直して、それとledgerにテストを足して', sessionId: 's1' }, 'its English is put back, knowing which work it answers');
  assert.equal(store.voice.text, 'Orreryのバグを直して、それとledgerにテストを足して');
  assert.deepEqual(store.voice.tasks.map((t) => [t.sessionId, t.projectId, t.provider, t.prompt]), [['s1', 'p2', 'codex', 'Orreryのバグを直して、それとledgerにテストを足して']]);
  confirmVoice();
  assert.equal(store.voice.phase, 'off');
  assert.deepEqual(store.outbox.get('s1').map((m) => m.text), ['Orreryのバグを直して、それとledgerにテストを足して'], 'the reply shows in that conversation at once');
  assert.equal(store.sending.length, 0, 'no new work');
  await until(() => calls.some((c) => c.path === '/api/sessions/s1/message'));
  assert.equal(calls.find((c) => c.path === '/api/sessions/s1/message').body.text, 'Orreryのバグを直して、それとledgerにテストを足して');

  // Tidying that fails leaves the words as they were heard.
  reset();
  server({ '/api/voice/tidy': [502, { error: 'no' }] });
  mic();
  beginVoice('hold', { replyTo: 's1' });
  await until(() => store.voice.live);
  await endVoice();
  assert.deepEqual(store.voice.tasks.map((t) => t.prompt), ['orreryのバグを直して、それとledgerにテストを足して']);
  cancelVoice();
  assert.equal(calls.filter((c) => c.path === '/api/sessions').length, 0);

  // With confirmation off it goes at once; work that is no longer there is no target (the planner decides instead).
  reset({ confirm: false });
  const again = server();
  mic();
  beginVoice('toggle', { replyTo: 's1' });
  await until(() => store.voice.live);
  await endVoice();
  assert.equal(store.voice.phase, 'off');
  await until(() => again.some((c) => c.path === '/api/sessions/s1/message'));
  reset();
  beginVoice('hold', { replyTo: 'gone' });
  assert.equal(store.voice.replyTo, '');
});

test('spoken elsewhere, the planner decides which parts answer which work; each is sent or started its own way', async () => {
  reset();
  const calls = server({ '/api/voice/plan': [200, { tasks: [
    { sessionId: 's1', projectId: 'p2', provider: 'codex', model: 'gpt', effort: '', prompt: '短い方で' },
    { sessionId: 'gone', projectId: 'p1', provider: 'claude', model: 'opus', effort: 'medium', prompt: '新しく' },
    { sessionId: '', projectId: 'p1', provider: 'claude', model: 'opus', effort: 'medium', prompt: 'ホームを直して' },
  ] }] });
  mic();
  beginVoice();
  await until(() => store.voice.live);
  await endVoice();
  assert.deepEqual(store.voice.tasks.map((t) => t.sessionId), ['s1', '', ''], 'a reply to work that is not there is new work');
  confirmVoice();
  assert.deepEqual(store.outbox.get('s1').map((m) => m.text), ['短い方で']);
  assert.deepEqual(store.sending.map((x) => x.title), ['新しく', 'ホームを直して']);
  await until(() => calls.filter((c) => c.path === '/api/sessions').length === 2 && calls.some((c) => c.path === '/api/sessions/s1/message'));
});

test('a reply can be turned into new work, sent to other work, or taken to that work\'s reply box', async () => {
  reset();
  const calls = server();
  mic();
  beginVoice('hold', { replyTo: 's1' });
  await until(() => store.voice.live);
  await endVoice();
  const [t] = store.voice.tasks;
  assert.deepEqual(voiceReplyTargets('s1').map((s) => s.id), ['s4', 's1'], 'open work only, most recent first');
  assert.deepEqual(voiceReplyTargets('s2').map((s) => s.id), ['s4', 's2', 's1'], 'the present target is kept even when put away');
  setVoiceTask(t.key, { sessionId: 's4' });
  setVoiceTask(t.key, { sessionId: '' });
  confirmVoice();
  await until(() => calls.some((c) => c.path === '/api/sessions'));
  assert.deepEqual([calls.find((c) => c.path === '/api/sessions').body.projectId, calls.find((c) => c.path === '/api/sessions').body.provider], ['p2', 'codex'], 'new work starts where the work it was answering is, with its AI');
  assert.ok(!calls.some((c) => c.path.endsWith('/message')));

  reset();
  server();
  mic();
  store.composerDrafts.set('s1', '書きかけ');
  beginVoice('hold', { replyTo: 's1' });
  await until(() => store.voice.live);
  await endVoice();
  assert.equal(voiceToBox(), '#/s/s1');
  assert.equal(store.voice.phase, 'off');
  assert.equal(store.composerDrafts.get('s1'), '書きかけ\norreryのバグを直して、それとledgerにテストを足して', 'added after what was being written, never over it');
  assert.ok(store.composerFill.has('s1'), 'the box takes it when drawn');
  assert.equal(store.newDraft.fill, null);
});

test('a reply that is refused is said, and the words go back into that work\'s reply box', async () => {
  reset({ confirm: false });
  server({ '/api/sessions/s1/message': [409, { error: '断られました' }] });
  mic();
  beginVoice('hold', { replyTo: 's1' });
  await until(() => store.voice.live);
  await endVoice();
  await until(() => store.notices.length === 1);
  assert.match(store.notices[0].text, /「READMEの更新」に送れませんでした: 断られました/);
  assert.equal(store.composerDrafts.get('s1'), 'orreryのバグを直して、それとledgerにテストを足して');
  assert.ok(store.composerFill.has('s1'));
  assert.equal((store.outbox.get('s1') ?? []).length, 0, 'what was not sent does not stay in the conversation');
});

test('the microphone opens the moment Space goes down: the start takes it, a short press closes it, and none opens without leave', async () => {
  // Held: the microphone opened at the key's press is the one listened to, so the first words are kept.
  reset();
  voiceIo.micGranted = () => true;
  const calls = server();
  let m = mic();
  warmVoice();
  assert.equal(m.opened, 1, 'opened before it is known to be a hold');
  await sleep(20);
  beginVoice('hold');
  await until(() => store.voice.live);
  assert.equal(m.opened, 1, 'the start does not open a second one');
  await endVoice();
  assert.equal(m.stopped, 1);
  assert.equal(calls.filter((c) => c.path === '/api/voice/transcribe').length, 1);

  // Released sooner: closed again, nothing shown, nothing asked.
  reset();
  m = mic();
  warmVoice();
  coolVoice();
  await sleep(20);
  assert.deepEqual([m.opened, m.cancelled, store.voice.phase], [1, 1, 'off']);

  // A cancel closes it too.
  reset();
  m = mic();
  warmVoice();
  cancelVoice();
  await sleep(20);
  assert.equal(m.cancelled, 1);

  // Not yet allowed: a short press must not bring up the browser's question; the start asks as before.
  reset();
  voiceIo.micGranted = () => false;
  m = mic();
  warmVoice();
  assert.equal(m.opened, 0);
  beginVoice('hold');
  await until(() => store.voice.live);
  assert.equal(m.opened, 1);
  cancelVoice();
});

test('samples are sent as 16-bit integers, clipped', () => {
  assert.deepEqual([...toPcm16([new Float32Array([0, 1, -1]), new Float32Array([2, -2, 0.5])], 6)], [0, 32767, -32768, 32767, -32768, 16383]);
});
