// The UI's logic layer (public/js/logic) runs without a browser: it never touches the DOM. These tests pin down
// the two promises the UI makes: every piece of work can be managed from the inbox, and what the human does shows
// at once and is taken back if the server refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../public/js/logic/store.js';
import { composerChoice, ensureModels, sessionEfforts } from '../public/js/logic/ai.js';
import { act, startWork, addProjectFromFolder, renameProject, runStep, sendAnswer, sendMessage, setProjectApproval, setProjectDescription, setProjectPreamble, setProjectWorktree, setStep, shutdownApp, startAppUpdate, checkAppUpdate } from '../public/js/logic/actions.js';
import { fullStamp, leftTone, stamp } from '../public/js/logic/format.js';
import { ARCHIVE_FOLD, advanceAccordion, archiveModel, busyCount, checkGroups, inInbox, inboxModel, inboxStepIndexes, isOpen, limitsModel, newVersionText, railModel, sessionModel, workStepsModel } from '../public/js/logic/selectors.js';
import { parseRoute, routeKey } from '../public/js/logic/route.js';
import { looksLikeCommand, toolSummary } from '../public/js/logic/text.js';
import { inline, parseMarkdown, plainText } from '../public/js/logic/markdown.js';

const NOW = Date.now();
const sess = (id, o = {}) => ({ id, taskTitle: id, lifecycle: 'turn_finished', lifecycleSince: NOW, updatedAt: NOW, completion: 'unverified', unread: false, archived: false, live: true, deferredMessage: null, awaitingBackground: false, background: null, queuePosition: null, activity: null, resources: null, task: { humanSteps: null, validation: null, validating: false }, ...o });
const item = (id, sessionId, o = {}) => ({ id, sessionId, status: 'pending', passive: false, type: 'permission_approval', response: null, source: { requestId: `r-${id}` }, ...o });
const snapshot = (sessions, items = []) => ({ sessions, items, counts: {}, settings: { maxConcurrent: 3, minFreeMemoryMB: 0 }, auth: { claude: { loginInProgress: false }, codex: { loginInProgress: false } } });

/** Answer the next API call(s) with this status after a moment, like the server would. */
function server(status, body = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(status === 200 ? { ok: true, ...body } : { error: '断られました', ...body }), { status });
  };
  return calls;
}
function reset(snap) {
  store.effects = [];
  store.errors.clear();
  store.notices.length = 0;
  store.outbox.clear();
  store.composerEfforts.clear();
  store.expanded.clear();
  store.lastOpenIds = [];
  store.userCollapsed = false;
  store.receive(snap);
}
const get = (id) => store.state.sessions.find((s) => s.id === id);

test('the effort control keeps saved/drafted values while model metadata loads and follows the actual model', async () => {
  const s = sess('a', { provider: 'claude', model: 'claude-sonnet-5-5', requestedModel: null, effort: 'high' });
  reset(snapshot([s, sess('b', { effort: 'medium' })]));
  assert.equal(composerChoice(s).effort, 'high');
  assert.deepEqual(sessionEfforts(s), [], 'no guessed levels before the provider answers');
  store.composerEfforts.set('a', 'low');
  server(200, { models: [{ id: 'sonnet', efforts: ['low', 'medium', 'high'] }, { id: 'claude-sonnet-5-5', efforts: ['low', 'high'] }] });
  await ensureModels('claude');
  assert.deepEqual(sessionEfforts(s), ['low', 'high'], 'the actual model takes precedence over its alias');
  assert.deepEqual(sessionEfforts({ ...s, model: 'claude-sonnet-5-6' }), ['low', 'medium', 'high'], 'default Claude sessions use the reported family alias');
  assert.deepEqual(sessionEfforts({ ...s, model: 'unknown' }), [], 'unrecognized models do not pick a different model');
  store.receive(snapshot([s, sess('b', { effort: 'medium' })]));
  assert.equal(composerChoice(s).effort, 'low', 'server pushes and trips to another screen keep the unsent choice');
  assert.equal(get('a').effort, 'high', 'selecting has not saved anything yet');
  assert.equal(composerChoice(get('b')).effort, 'medium');
});

test('a follow-up sends its drafted effort with the message and rolls back immediately on refusal', async () => {
  reset(snapshot([sess('a', { effort: 'medium', model: 'same-model', provider: 'codex' }), sess('b', { effort: 'low' })]));
  store.composerEfforts.set('a', 'high');
  store.composerEfforts.set('b', 'medium');
  const calls = server(400);
  const sending = sendMessage('a', 'more');
  assert.equal(get('a').effort, 'high', 'selected effort shows before the server answers');
  assert.equal(get('a').model, 'same-model');
  assert.equal(get('b').effort, 'low', 'other sessions are unchanged');
  assert.deepEqual(calls, [{ url: '/api/sessions/a/message', body: { text: 'more', effort: 'high' } }]);
  await sending;
  assert.equal(get('a').effort, 'medium');
  assert.equal(store.composerEfforts.has('a'), false, 'refused setting is not silently sent again');
  assert.equal(store.composerEfforts.get('b'), 'medium');
  assert.equal(store.outbox.get('a').length, 0);
});

test('a confirmed effort stays visible until the server picture arrives, including for a held message', async () => {
  reset(snapshot([sess('a', { effort: 'medium', lifecycle: 'running' })]));
  const calls = server(200, { deferred: true });
  await sendMessage('a', 'after this', { effort: 'high' });
  assert.equal(get('a').effort, 'high');
  assert.equal(get('a').deferredMessage, 'after this');
  assert.equal(calls[0].body.effort, 'high');
  store.receive(snapshot([sess('a', { effort: 'high', lifecycle: 'running', deferredMessage: 'after this' })]));
  assert.equal(get('a').effort, 'high', 'no old-value flash');
  assert.equal(store.effects.length, 0);
});

test('every piece of work that is not put away can be found in the inbox', () => {
  const lifecycles = ['queued', 'running', 'waiting_for_user', 'turn_finished', 'interrupted', 'error', 'unknown'];
  const completions = ['working', 'validating', 'needs_fix', 'human_steps', 'candidate', 'unverified'];
  const sessions = [];
  for (const lifecycle of lifecycles) {
    // completionOf() only gives a verdict on a finished turn; anything else is "working" (or being checked).
    for (const completion of lifecycle === 'turn_finished' ? completions.slice(1) : ['working', 'validating']) {
      sessions.push(sess(`${lifecycle}-${completion}`, { lifecycle, completion }));
      sessions.push(sess(`${lifecycle}-${completion}-asked`, { lifecycle, completion }));
    }
  }
  sessions.push(sess('waits-bg', { lifecycle: 'running', completion: 'working', awaitingBackground: true, background: ['npm test'] }));
  sessions.push(sess('put-away', { archived: true, completion: 'accepted' }));
  const items = sessions.filter((s) => s.id.endsWith('-asked')).map((s) => item(`i-${s.id}`, s.id));
  const state = snapshot(sessions, items);
  for (const s of sessions) assert.equal(inInbox(state, s.id), !s.archived, s.id);

  const m = inboxModel(state);
  assert.ok(m.problems.some((s) => s.id === 'error-working'));
  assert.ok(m.finished.some((s) => s.id === 'turn_finished-unverified'));
  assert.ok(!m.finished.some((s) => s.id === 'turn_finished-unverified-asked'), 'reached through its request instead');
  assert.ok(m.active.some((s) => s.id === 'waits-bg'), 'waiting for background work is still going, not finished');
  assert.ok(m.active.some((s) => s.id === 'waiting_for_user-working'), 'waiting on the human without a request we can show');
});

test('putting work away shows at once, and comes back with the reason if the server refuses', async () => {
  reset(snapshot([sess('a', { unread: true }), sess('b')]));
  server(409);
  const pending = act('a', 'archive');
  assert.equal(get('a').archived, true, 'gone from the lists before the server has answered');
  assert.equal(store.state.counts.archived, 1);
  assert.equal(inboxModel(store.state).finished.length, 1);
  await pending;
  assert.equal(get('a').archived, false, 'taken back');
  assert.equal(store.errors.get('a'), '断られました');
  assert.match(store.notices[0].text, /片付けができませんでした: 断られました/);
});

test('a confirmed action stays shown until the server\'s own picture replaces it', async () => {
  reset(snapshot([sess('a')]));
  server(200);
  await act('a', 'accept');
  assert.equal(get('a').archived, true, 'still shown: the old picture must not flash back');
  assert.equal(get('a').completion, 'accepted');
  store.receive(snapshot([sess('a', { archived: true, completion: 'accepted' })]));
  assert.equal(store.effects.length, 0);
  assert.equal(get('a').archived, true);
});

test('interrupting says so at once; cancelling queued work takes it out of the queue at once', async () => {
  reset(snapshot([sess('run', { lifecycle: 'running', completion: 'working' }), sess('q', { lifecycle: 'queued', completion: 'working', queuePosition: 1 })]));
  server(200);
  const a = act('run', 'interrupt');
  const b = act('q', 'interrupt');
  assert.equal(get('run').busyWith, 'interrupt');
  assert.equal(get('run').lifecycle, 'running', 'the agent is not stopped until it says so');
  assert.equal(get('q').lifecycle, 'interrupted');
  await Promise.all([a, b]);
});

test('an answer leaves the inbox at once and the agent shows as going on; a refusal brings it back', async () => {
  const snap = () => snapshot([sess('a', { lifecycle: 'waiting_for_user', completion: 'working' })], [item('i1', 'a'), item('i2', 'a')]);
  reset(snap());
  advanceAccordion(store, ['i1', 'i2']);
  server(200);
  const first = sendAnswer(store.state.items[0], { kind: 'decision', decision: 'accept' });
  assert.deepEqual(store.state.items.filter(isOpen).map((i) => i.id), ['i2']);
  assert.equal(get('a').lifecycle, 'waiting_for_user', 'another request is still open');
  assert.deepEqual(advanceAccordion(store, ['i2']), { opened: 'i2', afterAnswer: true }, 'the next request opens by itself');
  await first;

  reset(snap());
  server(502);
  const refused = sendAnswer(store.state.items[1], { kind: 'decision', decision: 'accept' });
  assert.deepEqual(store.state.items.filter(isOpen).map((i) => i.id), ['i1']);
  await refused;
  assert.deepEqual(store.state.items.filter(isOpen).map((i) => i.id), ['i1', 'i2']);
  assert.equal(store.errors.get('i2'), '断られました');
  assert.equal(store.notices.length, 1);
});

test('a message shows in the conversation at once; where it goes depends on what the agent is doing', async () => {
  reset(snapshot([
    sess('idle', { task: { humanSteps: [{ title: 'x', done: false }], validation: null } }),
    sess('busy', { lifecycle: 'running', completion: 'working' }),
    sess('waits', { lifecycle: 'running', completion: 'working', awaitingBackground: true }),
  ], [item('q', 'idle', { passive: true, type: 'user_question' })]));
  server(200, { resumed: false, queued: false });
  const sent = [sendMessage('idle', '続けて'), sendMessage('busy', 'あとで'), sendMessage('waits', 'いますぐ')];
  assert.equal(store.outbox.get('idle')[0].text, '続けて');
  assert.equal(get('idle').lifecycle, 'running', 'the agent starts on it');
  assert.equal(get('idle').task.humanSteps, null, 'what the last reply left open no longer applies');
  assert.equal(store.state.items[0].status, 'expired', 'nor does the question read from it');
  assert.equal(get('busy').deferredMessage, 'あとで', 'held until the turn ends');
  assert.equal(get('waits').deferredMessage, null);
  assert.equal(get('waits').awaitingBackground, false, 'an agent that only waits takes the message now');
  await Promise.all(sent);
  assert.equal(store.outbox.get('idle')[0].sent, true, 'stays on screen until the record shows it');

  reset(snapshot([sess('idle')]));
  server(409);
  const r = await sendMessage('idle', '届かない');
  assert.equal(r.status, 409);
  assert.equal(store.outbox.get('idle').length, 0, 'it never happened');
  assert.equal(get('idle').lifecycle, 'turn_finished');
});

test("ticking the last of the human's steps finishes the work at once, without archiving the chat", async () => {
  const steps = () => [{ title: 'a', done: true }, { title: 'b', done: false }];
  reset(snapshot([sess('a', { completion: 'human_steps', task: { humanSteps: steps() } })]));
  server(409);
  const pending = setStep('a', 1, true);
  assert.equal(get('a').task.humanSteps[1].done, true);
  assert.equal(get('a').completion, 'accepted');
  assert.equal(get('a').archived, false, 'finishing a task is not archiving its chat');
  await pending;
  assert.equal(get('a').task.humanSteps[1].done, false, 'taken back');
  assert.equal(get('a').completion, 'human_steps');
});

test("running a step's command shows at once, never archives by itself, and a refusal takes it back", async () => {
  const steps = () => [{ title: 'deploy', done: false, command: 'npm run release', run: null }];
  reset(snapshot([sess('a', { completion: 'human_steps', task: { humanSteps: steps() } })]));
  const calls = server(409);
  const pending = runStep('a', 0, 'npm run release');
  assert.equal(get('a').task.humanSteps[0].run.phase, 'running', 'from the click');
  assert.equal(get('a').archived, false, 'running is not finishing');
  assert.equal(calls[0].body.command, 'npm run release');
  await pending;
  assert.equal(get('a').task.humanSteps[0].run, null, 'taken back');
  assert.ok(store.notices.length, 'and said');
});

test('the rail and the session screen are derived from the same picture', () => {
  const state = snapshot([
    sess('wait', { lifecycle: 'waiting_for_user', completion: 'working' }),
    sess('steps', { completion: 'human_steps' }),
    sess('run', { lifecycle: 'running', completion: 'working' }),
    sess('q2', { lifecycle: 'queued', completion: 'working', queuePosition: 2 }),
    sess('q1', { lifecycle: 'queued', completion: 'working', queuePosition: 1 }),
    sess('bad', { lifecycle: 'error', completion: 'working', live: false, resources: { shared: false, processCount: 2 } }),
    sess('seen'),
    sess('new', { unread: true }),
  ], [item('i', 'wait'), item('j', 'run')]);
  state.counts = { needsAttention: 2, humanTasks: 1 };
  const rail = railModel(state, false);
  const group = (k) => rail.groups.find((g) => g.key === k).list.map((s) => s.id);
  assert.equal(rail.needsYou, 3);
  assert.deepEqual(group('wait'), ['wait', 'steps', 'run'], 'whatever waits for the human, whatever its lifecycle');
  assert.deepEqual(group('queue'), ['q1', 'q2']);
  assert.deepEqual(group('done'), ['new', 'seen'], 'unread first');
  assert.deepEqual(rail.seenFinished.map((s) => s.id), ['seen']);
  assert.deepEqual(rail.finishedAll.map((s) => s.id), ['new', 'seen'], 'all of the done group, for 完了にする in one go');

  const bad = sessionModel(state, 'bad');
  assert.equal(bad.busy, false);
  assert.equal(bad.leftovers, true);
  assert.deepEqual(bad.others.map((i) => i.id), ['i', 'j']);
  assert.equal(sessionModel(state, 'nope'), null);
});

test('routes and agent text are read without a browser', () => {
  assert.deepEqual(parseRoute('#/s/abc'), { view: 'session', id: 'abc' });
  assert.deepEqual(parseRoute(''), { view: 'inbox' });
  assert.deepEqual(parseRoute('#/new'), { view: 'inbox', write: true }, 'new work is the home screen with its box focused');
  assert.equal(routeKey(parseRoute('#/new')), routeKey(parseRoute('#/')), 'same screen: no rebuild');
  assert.equal(routeKey(parseRoute('#/env/p1')), 'env:p1');
  assert.equal(looksLikeCommand('npm run install-app'), true);
  assert.equal(looksLikeCommand('openModelSheet'), false);
  assert.deepEqual(inline('次を実行: `npm test` と `foo`').map((p) => [p.t, p.command ?? null]), [['text', null], ['code', 'npm test'], ['text', null], ['code', null]]);
  assert.equal(toolSummary('▶ Bash {"command":"npm test"}').line, 'Bash  npm test');
});

test('agent replies are read as Markdown, never as HTML', () => {
  const kinds = (src) => parseMarkdown(src).map((b) => b.type);
  assert.deepEqual(kinds('## 見出し\n\n本文\n\n- a\n- b\n\n1. x\n\n> 引用\n\n---\n\n```sh\nnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'),
    ['heading', 'para', 'list', 'list', 'quote', 'hr', 'code', 'table']);
  // Nested lists, task boxes, and a nested list indented less than the item text.
  const [list] = parseMarkdown('1. 親\n  - 子\n2. [x] 済み');
  assert.equal(list.ordered, true);
  assert.equal(list.items[0].blocks[1].type, 'list');
  assert.equal(list.items[1].checked, true);
  // A fenced command stays clickable.
  assert.equal(parseMarkdown('```powershell\nnpm run build\n```')[0].command, 'npm run build');
  // Inline marks, including Japanese brackets right inside ** and snake_case left alone.
  assert.deepEqual(inline('**「強調」**です snake_case ~~消~~ *斜体*').map((n) => n.t), ['strong', 'text', 'del', 'text', 'em']);
  // Line breaks inside a paragraph are kept.
  assert.deepEqual(parseMarkdown('一行目\n二行目')[0].inline.map((n) => n.t), ['text', 'br', 'text']);
  // Only http(s)/mailto links; anything else keeps just its label. Raw HTML is text.
  assert.deepEqual(inline('[x](javascript:alert(1))'), [{ t: 'text', v: 'x' }]);
  assert.equal(inline('[ok](https://example.com)')[0].href, 'https://example.com');
  assert.equal(inline('見て https://example.com/a).')[1].href, 'https://example.com/a');
  assert.deepEqual(inline('<b>x</b>'), [{ t: 'text', v: '<b>x</b>' }]);
  // Previews show the words without the marks.
  assert.equal(plainText('## 結果\n\n**テスト**は `npm test` で通過'), '結果\nテストは npm test で通過');
});

test('an answered request stays out of the inbox unless the agent is evidently still stuck on it', () => {
  const sent = { status: 'answering', response: { answer: {}, sentAt: NOW - 5 * 60_000 } };
  const open = (lifecycle, since) => inboxModel(snapshot([sess('a', { lifecycle, lifecycleSince: since, completion: 'working' })], [item('i1', 'a', sent)])).open.map((i) => i.id);
  assert.deepEqual(open('running', NOW), [], 'the agent went on: it got the answer');
  assert.deepEqual(open('waiting_for_user', NOW - 60_000), [], 'waiting again, for something newer');
  assert.deepEqual(open('waiting_for_user', NOW - 10 * 60_000), ['i1'], 'still waiting since before the answer, minutes later');
});

test('what is left of a plan limit: green over 30%, yellow over 10%, red at 10% and under', () => {
  assert.deepEqual([100, 31, 30, 11, 10, 0].map(leftTone), ['ok', 'ok', 'warn', 'warn', 'low', 'low']);
  assert.equal(leftTone(null), null);
});

test('switching the worktree setting of a project shows at once and comes back if the server refuses', async () => {
  const snap = { ...snapshot([]), projects: [{ id: 'p1', name: 'p', rootPath: 'C:/p', useWorktree: true, envCount: 0 }] };
  reset(snap);
  let calls = server(200);
  const done = setProjectWorktree('p1', false);
  assert.equal(store.state.projects[0].useWorktree, false);
  await done;
  assert.deepEqual(calls[0].body, { useWorktree: false });
  reset(snap);
  calls = server(500);
  const refused = setProjectWorktree('p1', false);
  assert.equal(store.state.projects[0].useWorktree, false);
  await refused;
  assert.equal(store.state.projects[0].useWorktree, true);
  assert.equal(store.notices.length, 1);
});

test("a project's approval setting shows at once and comes back if the server refuses", async () => {
  const snap = { ...snapshot([]), projects: [{ id: 'p1', name: 'p', rootPath: 'C:/p', useWorktree: true, approvalMode: 'auto', envCount: 0 }] };
  reset(snap);
  let calls = server(200);
  const done = setProjectApproval('p1', 'ask');
  assert.equal(store.state.projects[0].approvalMode, 'ask');
  await done;
  assert.deepEqual(calls[0].body, { approvalMode: 'ask' });
  reset(snap);
  calls = server(500);
  const refused = setProjectApproval('p1', 'edits');
  assert.equal(store.state.projects[0].approvalMode, 'edits');
  await refused;
  assert.equal(store.state.projects[0].approvalMode, 'auto');
  assert.equal(store.notices.length, 1);
});

test("a project's default message shows at once and comes back if the server refuses", async () => {
  const snap = { ...snapshot([]), projects: [{ id: 'p1', name: 'p', rootPath: 'C:/p', useWorktree: true, preamble: '', envCount: 0 }] };
  reset(snap);
  let calls = server(200);
  const done = setProjectPreamble('p1', '日本語で');
  assert.equal(store.state.projects[0].preamble, '日本語で');
  await done;
  assert.deepEqual(calls[0].body, { preamble: '日本語で' });
  reset(snap);
  calls = server(500);
  const refused = setProjectPreamble('p1', '日本語で');
  assert.equal(store.state.projects[0].preamble, '日本語で');
  await refused;
  assert.equal(store.state.projects[0].preamble, '');
  assert.equal(store.notices.length, 1);
});

test("a project's description shows at once and comes back if the server refuses", async () => {
  const snap = { ...snapshot([]), projects: [{ id: 'p1', name: 'p', rootPath: 'C:/p', useWorktree: true, preamble: '', description: '', envCount: 0 }] };
  reset(snap);
  let calls = server(200);
  const done = setProjectDescription('p1', '  2Dゲーム  ');
  assert.equal(store.state.projects[0].description, '2Dゲーム', 'trimmed the way the server keeps it');
  await done;
  assert.ok(calls[0].url.endsWith('/api/projects/p1/options'));
  assert.deepEqual(calls[0].body, { description: '  2Dゲーム  ' });
  reset(snap);
  calls = server(500);
  const refused = setProjectDescription('p1', '2Dゲーム');
  assert.equal(store.state.projects[0].description, '2Dゲーム');
  await refused;
  assert.equal(store.state.projects[0].description, '');
  assert.equal(store.notices.length, 1);
});

test("renaming a project shows at once everywhere its name appears, and is taken back if refused", async () => {
  const snap = { ...snapshot([sess('s1', { projectId: 'p1', projectName: 'p' }), sess('s2', { projectId: 'p2', projectName: 'q' })], [item('i1', 's1', { projectId: 'p1', projectName: 'p' })]),
    projects: [{ id: 'p1', name: 'p', rootPath: 'C:/p', useWorktree: true, preamble: '', envCount: 0 }, { id: 'p2', name: 'q', rootPath: 'C:/q', useWorktree: true, preamble: '', envCount: 0 }] };
  reset(snap);
  let calls = server(200);
  const done = renameProject('p1', '  新しい  名前 ');
  assert.equal(store.state.projects[0].name, '新しい 名前');
  assert.equal(store.state.sessions[0].projectName, '新しい 名前');
  assert.equal(store.state.items[0].projectName, '新しい 名前');
  assert.equal(store.state.sessions[1].projectName, 'q', 'other projects untouched');
  await done;
  assert.ok(calls[0].url.endsWith('/api/projects/p1/rename'));
  assert.deepEqual(calls[0].body, { name: '  新しい  名前 ' });
  reset(snap);
  calls = server(500);
  const refused = renameProject('p1', 'x');
  assert.equal(store.state.projects[0].name, 'x');
  await refused;
  assert.equal(store.state.projects[0].name, 'p');
  assert.equal(store.state.sessions[0].projectName, 'p');
  assert.equal(store.notices.length, 1);
});

test('adding a project from settings shows the folder at once, and takes it back if refused', async () => {
  const snap = { ...snapshot([]), projects: [{ id: 'p1', name: 'p', rootPath: 'C:/p', envCount: 0 }] };
  /** The folder picker answers `path`; registering answers `status`. */
  const answers = (path, status) => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      await new Promise((r) => setTimeout(r, 5));
      if (String(url).endsWith('/api/pick-folder')) return new Response(JSON.stringify({ path }), { status: 200 });
      return new Response(JSON.stringify(status === 200 ? { projectId: 'p2' } : { error: '断られました' }), { status });
    };
    return calls;
  };
  reset(snap);
  answers('C:/work/new-app', 200);
  const added = addProjectFromFolder();
  await new Promise((r) => setTimeout(r, 8));
  const shown = store.state.projects.find((p) => p.rootPath === 'C:/work/new-app');
  assert.ok(shown?.pending, 'listed before the server answers');
  assert.equal(shown.name, 'new-app');
  await added;
  assert.equal(store.notices.length, 0);

  reset(snap);
  answers('C:/work/bad', 400);
  await addProjectFromFolder();
  assert.equal(store.state.projects.length, 1, 'taken back');
  assert.equal(store.notices.length, 1);

  reset(snap);
  answers('c:/P', 200);
  const again = addProjectFromFolder();
  await new Promise((r) => setTimeout(r, 8));
  assert.equal(store.state.projects.length, 1, 'a folder already listed is not doubled');
  await again;

  reset(snap);
  const calls = answers('', 200);
  await addProjectFromFolder();
  assert.equal(calls.length, 1, 'cancelling the picker registers nothing');
});

test('put-away work is grouped by project, newest first, and found by every word typed', () => {
  const a = (id, projectId, projectName, ago, o = {}) => sess(id, { archived: true, projectId, projectName, provider: 'claude', updatedAt: NOW - ago, ...o });
  const sessions = [a('old', 'p1', 'orrery', 50), a('new', 'p1', 'orrery', 1, { taskTitle: 'ログイン画面の修正' }), a('l1', 'p2', 'Ledger', 10), sess('live', { projectId: 'p1', projectName: 'orrery' })];
  const groups = archiveModel({ sessions });
  assert.deepEqual(groups.map((g) => [g.name, g.sessions.map((s) => s.id)]), [['orrery', ['new', 'old']], ['Ledger', ['l1']]]);
  assert.deepEqual(archiveModel({ sessions }, 'ledger').map((g) => g.name), ['Ledger'], 'case ignored, project name searched');
  assert.deepEqual(archiveModel({ sessions }, 'ｌｏｇｉｎ').length, 0);
  assert.deepEqual(archiveModel({ sessions }, 'orrery ログイン').flatMap((g) => g.sessions.map((s) => s.id)), ['new'], 'every word must match');
  assert.equal(ARCHIVE_FOLD, 5);
});

test('reset times always read "mm/dd hh:mm"', () => {
  assert.equal(stamp(new Date(2026, 10, 23, 15, 5).getTime()), '11/23 15:05');
  assert.equal(stamp(new Date(2026, 0, 4, 9, 0).getTime()), '01/04 09:00');
});

test('the last update reads "yyyy/mm/dd hh:mm"', () => {
  assert.equal(fullStamp(new Date(2026, 10, 23, 15, 5).getTime()), '2026/11/23 15:05');
  assert.equal(fullStamp(new Date(2027, 0, 4, 9, 0).getTime()), '2027/01/04 09:00');
});

test('things to look at from works in one project become one checklist under the strongest action', () => {
  const look = (title, update, how = null) => ({ title, detail: `${title}の場所`, command: null, after: null, done: false, check: { update, how, command: null } });
  const plain = { title: 'PRをマージする', detail: null, command: null, after: null, done: false };
  const a = sess('a', { projectId: 'p', projectName: 'orrery', completion: 'human_steps', task: { humanSteps: [look('a1', 'reload'), look('a2', 'reload')] } });
  const b = sess('b', { projectId: 'p', projectName: 'orrery', completion: 'human_steps', task: { humanSteps: [plain, look('b1', 'rebuild', '設定の「更新」を押す')] } });
  const c = sess('c', { projectId: 'q', projectName: 'other', completion: 'human_steps', task: { humanSteps: [{ ...look('c1', 'none'), done: true }, plain] } });
  const groups = checkGroups([a, b, c]);
  assert.equal(groups.length, 1, 'a project whose checks are all ticked has no checklist');
  const g = groups[0];
  assert.equal(g.update, 'rebuild');
  assert.deepEqual(g.hows, ['設定の「更新」を押す']);
  assert.deepEqual(g.works.map((w) => [w.session.id, w.items.map((i) => [i.index, i.step.title])]), [['a', [[0, 'a1'], [1, 'a2']]], ['b', [[1, 'b1']]]]);
});

test('plan limits become batteries of five cells: any amount left lights one, unknown lights none', () => {
  const usage = { claude: { limits: [{ kind: 'five_hour', label: '5時間', usedPercent: 18, resetsAt: 1 }, { kind: 'weekly', label: '週', usedPercent: 99.6, resetsAt: null }] }, codex: { limits: [{ kind: 'five_hour', usedPercent: null }] } };
  const m = limitsModel(usage);
  assert.deepEqual(m.map((p) => p.provider), ['claude', 'codex']);
  assert.deepEqual(m[0].windows.map((w) => [w.kind, w.left, w.cells]), [['five_hour', 82, 5], ['weekly', 0, 0]]);
  assert.deepEqual(m[1].windows.map((w) => [w.left, w.cells]), [[null, 0], [null, 0]]);
  const at = (used) => limitsModel({ claude: { limits: [{ kind: 'five_hour', usedPercent: used }] } })[0].windows[0].cells;
  assert.deepEqual([100, 99, 80, 79, 41, 40, 1, 0].map(at), [0, 1, 1, 2, 3, 3, 5, 5]);
  assert.deepEqual(limitsModel(null)[0].windows.map((w) => w.left), [null, null]);
});

test('the power button covers the page at once and takes it back if the app cannot be asked to stop', async () => {
  assert.equal(busyCount({ counts: { running: 2, waiting: 1, queued: 3, turnFinished: 9 } }), 6);
  store.notices.length = 0;
  let calls = server(200);
  let pending = shutdownApp();
  assert.equal(store.shuttingDown, true, 'shown before the server has answered');
  await pending;
  assert.equal(calls[0].url, '/api/shutdown');
  assert.equal(store.shuttingDown, true);
  store.shuttingDown = false;
  calls = server(500);
  pending = shutdownApp();
  assert.equal(store.shuttingDown, true);
  await pending;
  assert.equal(store.shuttingDown, false, 'taken back');
  assert.match(store.notices.at(-1).text, /停止できませんでした/);
});

test('the update button shows at once and is taken back if the update cannot be started', async () => {
  store.notices.length = 0;
  let calls = server(200);
  const pending = startAppUpdate();
  assert.equal(store.updating, true, 'shown before the server has answered');
  await pending;
  assert.equal(calls[0].url, '/api/app-update/update');
  assert.equal(store.updating, true);
  store.updating = false;
  calls = server(500);
  await startAppUpdate();
  assert.equal(store.updating, false, 'taken back');
  assert.match(store.notices.at(-1).text, /更新できませんでした/);
});

test('checking GitHub for a newer version shows at once and says so when it cannot be reached', async () => {
  store.notices.length = 0;
  let calls = server(200, { remote: { behind: 0, error: null } });
  let pending = checkAppUpdate();
  assert.equal(store.checkingUpdate, true, 'shown before the server has answered');
  await pending;
  assert.equal(calls[0].url, '/api/app-update/check');
  assert.equal(store.checkingUpdate, false);
  assert.equal(store.notices.length, 0);
  server(200, { remote: { behind: 0, error: 'Could not resolve host: github.com' } });
  await checkAppUpdate();
  assert.match(store.notices.at(-1).text, /確認できませんでした: Could not resolve host/);
  server(500);
  await checkAppUpdate();
  assert.equal(store.checkingUpdate, false);
  assert.match(store.notices.at(-1).text, /確認できませんでした/);
});

test('a newer version on GitHub is put in words, and says when it will not be brought in by itself', () => {
  assert.equal(newVersionText(null), null);
  assert.equal(newVersionText({ behind: 0 }), null);
  assert.equal(newVersionText({ behind: 1, subject: 'v0.5.0 の更新を反映', canPull: true }), 'GitHub に新しい版があります：「v0.5.0 の更新を反映」');
  assert.equal(newVersionText({ behind: 3, subject: 'v0.5.0 の更新を反映', canPull: true }), 'GitHub に新しい版があります：「v0.5.0 の更新を反映」ほか、3件の変更');
  assert.match(newVersionText({ behind: 2, subject: '', canPull: false }), /2件の変更.*自動では取り込みません/);
});

test('the inbox shows a step that waits on an earlier one only once that one is done', () => {
  const step = (title, extra = {}) => ({ title, detail: null, command: null, after: null, done: false, ...extra });
  const steps = [
    step('PRをマージする'),
    step('アプリを再起動する', { after: 'PRがマージされてから' }),
    step('設定を見直す'),
    step('画面を見る', { check: { update: 'reload', how: null, command: null } }),
  ];
  // The precondition comes first; what depends on it waits. Steps that can be done now still show.
  assert.deepEqual(inboxStepIndexes(steps), [0, 2]);
  steps[0].done = true;
  assert.deepEqual(inboxStepIndexes(steps), [1, 2]);
  // A precondition outside the list (nothing earlier is open) shows the step, with the precondition said first.
  assert.deepEqual(inboxStepIndexes([step('デプロイする', { after: 'CIが緑になったら' })]), [0]);
  // A chain opens one link at a time.
  const chain = [step('A'), step('B', { after: 'A' }), step('C', { after: 'B' })];
  assert.deepEqual(inboxStepIndexes(chain), [0]);
  chain[0].done = true;
  assert.deepEqual(inboxStepIndexes(chain), [1]);
});

test('a work shows first what comes first: the things to look at appear once the action they need is ticked', () => {
  const step = (title, extra = {}) => ({ title, detail: null, command: null, after: null, done: false, ...extra });
  const check = { update: 'rebuild', how: '`npm run dev` で起動する', command: null };
  const steps = [
    step('PRをマージする'),
    step('アプリを更新する', { prep: true, detail: check.how }),
    step('見出しがドット書体', { check }),
    step('スマホ幅で崩れない', { check }),
  ];
  const shown = (all) => workStepsModel(steps, all).rows.map((r) => r.step.title);
  assert.deepEqual(shown(false), ['PRをマージする', 'アプリを更新する']);
  assert.equal(workStepsModel(steps).held, 2);
  // Every step can still be shown, those that wait marked as such.
  assert.deepEqual(workStepsModel(steps, true).rows.map((r) => [r.step.title, r.waits]), [['PRをマージする', false], ['アプリを更新する', false], ['見出しがドット書体', true], ['スマホ幅で崩れない', true]]);
  steps[1].done = true;
  assert.deepEqual(shown(false), ['PRをマージする', 'アプリを更新する', '見出しがドット書体', 'スマホ幅で崩れない'], 'done steps stay, crossed out');
  assert.equal(workStepsModel(steps).held, 0);
  // A step with a precondition waits behind the open steps before it, as in the inbox.
  const chain = [step('A'), step('B', { after: 'Aが済んだら' })];
  assert.deepEqual(workStepsModel(chain).rows.map((r) => r.step.title), ['A']);
  // The action is not an ordinary step of the inbox: it heads its project's checklist instead.
  assert.deepEqual(inboxStepIndexes([step('アプリを更新する', { prep: true }), step('見る', { check })]), []);
});

test('the action a project checklist needs comes first, ticked for every work, and the list waits for it', () => {
  const look = (title) => ({ title, detail: null, command: null, after: null, done: false, check: { update: 'rebuild', how: null, command: 'npm run dev' } });
  const prep = (done = false) => ({ title: 'アプリを更新する', detail: null, command: 'npm run dev', after: null, done, prep: true });
  const a = sess('a', { projectId: 'p', projectName: 'orrery', completion: 'human_steps', task: { humanSteps: [prep(), look('a1')] } });
  const b = sess('b', { projectId: 'p', projectName: 'orrery', completion: 'human_steps', task: { humanSteps: [prep(true), look('b1')] } });
  let [g] = checkGroups([a, b]);
  assert.equal(g.hasPrep, true);
  assert.equal(g.prepped, false, 'one work still has the action to do');
  assert.deepEqual(g.works.map((w) => [w.session.id, w.preps.map((p) => p.index), w.items.map((i) => i.index)]), [['a', [0], [1]], ['b', [0], [1]]]);
  a.task.humanSteps[0].done = true;
  [g] = checkGroups([a, b]);
  assert.equal(g.prepped, true);
  // A list read before the action was a step of its own has no item for it, and its checklist shows at once.
  const old = sess('c', { projectId: 'q', projectName: 'old', completion: 'human_steps', task: { humanSteps: [look('c1')] } });
  [g] = checkGroups([old]);
  assert.equal(g.hasPrep, false);
  assert.equal(g.prepped, true);
});

// ---- the human's standing preferences (こだわり) ----
import { WARN_AT, domainClipboard, entryClipboard, knowledgeModel, knowledgeNews, knowledgeUsage, tone, tuneModel } from '../public/js/logic/knowledge.js';
import { addKnowledgeEntry, markKnowledgeSeen, removeKnowledgeDomain, removeKnowledgeEntry, sendKnowledgeTune, setKnowledgeDomain, setKnowledgeSettings, updateKnowledgeEntry } from '../public/js/logic/actions.js';

const LIMITS = { sectionText: 5000, domainName: 40, domainDescription: 200, domains: 30, routeThreshold: 1500, maxRoutedDomains: 3 };
const HEADING = '## ユーザーのこだわり（この作業に関係する領域のみ）';
const kEntry = (id, domainId, text, o = {}) => ({ id, domainId, text, sessionId: null, scope: 'all', hits: 1, createdAt: NOW, updatedAt: NOW, seen: true, ...o });
const kSnap = (entries = []) => ({
  ...snapshot([]),
  settings: { maxConcurrent: 3, minFreeMemoryMB: 0, knowledge: { capture: true, inject: true } },
  projects: [],
  knowledge: {
    domains: [{ id: 'ui', name: 'UI・操作感', description: '', always: false, order: 0 }, { id: 'writing', name: '文章・言葉づかい', description: '', always: false, order: 1 }, { id: 'other', name: 'その他', description: '', always: false, order: 2 }],
    entries,
    unseen: entries.filter((e) => !e.seen).length,
    limits: LIMITS,
    heading: HEADING,
  },
});

test('usage: each limit is measured the way the server measures it, and warns near it', () => {
  assert.equal(tone(0, 500), 'ok');
  assert.equal(tone(Math.ceil(500 * WARN_AT) - 1, 500), 'ok');
  assert.equal(tone(Math.ceil(500 * WARN_AT), 500), 'warn');
  assert.equal(tone(500, 500), 'full');
  const u = knowledgeUsage(kSnap([kEntry('a', 'ui', 'あ'.repeat(4200)), kEntry('b', 'ui', '短い（理由）')]));
  assert.deepEqual(u.perEntry.get('a'), { used: 4200, max: 5000, tone: 'warn' });
  assert.deepEqual(u.perEntry.get('b'), { used: 6, max: 5000, tone: 'ok' });
  const ui = u.perDomain.get('ui');
  assert.equal(ui.chars, 4208);
  assert.equal(ui.maxChars, 5000);
  const sent = [HEADING, '### UI・操作感', `${'あ'.repeat(4200)}\n\n短い（理由）`].join('\n');
  assert.equal(u.total.chars, sent.length);
  assert.equal(u.perDomain.get('writing').chars, 0);
  assert.equal(u.total.routed, true);
  assert.equal(knowledgeUsage(kSnap([])).total.chars, 0, 'nothing recorded: nothing sent');
  const big = knowledgeUsage(kSnap([kEntry('long', 'writing', 'い'.repeat(5001))]));
  assert.equal(big.total.routed, true);
  assert.equal(big.perDomain.get('writing').attached, 5000);
  assert.equal(big.total.chars, [HEADING, '### 文章・言葉づかい', 'い'.repeat(5000)].join('\n').length);
});

test('news: what was recorded by itself, newest first, and the areas in order with the most repeated first', () => {
  const st = kSnap([kEntry('old', 'ui', '古い', { seen: false, createdAt: NOW - 10 }), kEntry('new', 'ui', '新しい', { seen: false, createdAt: NOW, hits: 3 }), kEntry('seen', 'writing', '見た')]);
  const n = knowledgeNews(st);
  assert.equal(n.count, 2);
  assert.deepEqual(n.latest.map((e) => e.id), ['new', 'old']);
  const m = knowledgeModel(st);
  assert.deepEqual(m.map((x) => x.domain.id), ['ui', 'writing', 'other']);
  assert.deepEqual(m[0].entries.map((e) => e.id), ['old', 'new']);
});

test('preferences change on screen at once and come back if the server refuses', async () => {
  const snap = kSnap([kEntry('a', 'ui', '即時のフィードバック')]);
  reset(snap);
  let calls = server(200);
  const added = addKnowledgeEntry('writing', '  結論から書く  ');
  assert.ok(store.state.knowledge.entries.some((e) => e.domainId === 'writing' && e.text === '結論から書く'));
  await added;
  assert.deepEqual(calls[0].body, { domainId: 'writing', text: '  結論から書く  ', scope: 'all' });
  assert.ok(calls[0].url.endsWith('/api/knowledge/entries'));

  reset(snap);
  calls = server(200);
  const moved = updateKnowledgeEntry('a', { text: '操作には即時の反応', domainId: 'other' });
  assert.deepEqual([store.state.knowledge.entries[0].text, store.state.knowledge.entries[0].domainId], ['操作には即時の反応', 'other']);
  await moved;
  assert.ok(calls[0].url.endsWith('/api/knowledge/entries/a'));

  reset(snap);
  calls = server(500);
  const refused = removeKnowledgeEntry('a');
  assert.equal(store.state.knowledge.entries.length, 0);
  await refused;
  assert.equal(store.state.knowledge.entries.length, 1, 'taken back');
  assert.equal(store.notices.length, 1);

  reset(snap);
  calls = server(200);
  const gone = removeKnowledgeDomain('ui');
  assert.ok(!store.state.knowledge.domains.some((d) => d.id === 'ui'));
  assert.equal(store.state.knowledge.entries[0].domainId, 'other', 'what was in it goes to その他');
  await gone;

  reset(snap);
  calls = server(200);
  const made = setKnowledgeDomain(null, { name: '  設計  ', description: '構成' });
  assert.equal(store.state.knowledge.domains.at(-1).name, '設計');
  await made;
  assert.deepEqual(calls[0].body, { name: '  設計  ', description: '構成' });
});

test('the two switches show at once; looking at the news clears it', async () => {
  reset(kSnap([kEntry('a', 'ui', 'x', { seen: false })]));
  let calls = server(200);
  const off = setKnowledgeSettings({ capture: false });
  assert.deepEqual(store.state.settings.knowledge, { capture: false, inject: true });
  await off;
  assert.deepEqual(calls[0].body, { knowledge: { capture: false, inject: true } });
  calls = server(200);
  const seen = markKnowledgeSeen();
  assert.equal(knowledgeNews(store.state).count, 0);
  await seen;
  assert.ok(calls[0].url.endsWith('/api/knowledge/seen'));
  assert.equal(markKnowledgeSeen(), null, 'nothing new: nothing is asked');
  assert.deepEqual(parseRoute('#/knowledge'), { view: 'knowledge' });
});

test('preference AI settings show immediately, survive toggles, and roll back on a refused save', async () => {
  reset(kSnap([]));
  const captureAi = { provider: 'codex', model: 'gpt-test', effort: 'high' };
  const tuneAi = { provider: 'claude', model: 'opus', effort: 'medium' };
  let calls = server(200);
  const saving = setKnowledgeSettings({ captureAi });
  assert.deepEqual(store.state.settings.knowledge.captureAi, captureAi);
  await saving;
  assert.deepEqual(calls[0].body.knowledge.captureAi, captureAi);
  await setKnowledgeSettings({ tuneAi });
  await setKnowledgeSettings({ capture: false });
  assert.deepEqual(store.state.settings.knowledge, { capture: false, inject: true, captureAi, tuneAi });
  calls = server(500);
  const refused = setKnowledgeSettings({ tuneAi: captureAi });
  assert.deepEqual(store.state.settings.knowledge.tuneAi, captureAi);
  await refused;
  assert.deepEqual(store.state.settings.knowledge.tuneAi, tuneAi);
  assert.deepEqual(store.state.settings.knowledge.captureAi, captureAi);
});

test('copying: one preference is its text; one area is its heading and its lines as they are sent', () => {
  const st = kSnap([kEntry('a', 'ui', '一度'), kEntry('b', 'ui', '何度も\n二行目', { hits: 3 }), kEntry('c', 'writing', '別の領域')]);
  assert.equal(entryClipboard(st.knowledge.entries[1]), '何度も\n二行目');
  assert.equal(domainClipboard(st, 'ui'), ['### UI・操作感', '一度\n\n何度も\n二行目'].join('\n'));
  assert.equal(domainClipboard(st, 'nope'), '');
});

test('section appends and moves merge immediately, keep full long text, and roll back when refused', async () => {
  const original = kSnap([kEntry('a', 'ui', '最初の決まり'), kEntry('b', 'other', 'その他の決まり')]);
  reset(original);
  server(200);
  await addKnowledgeEntry('ui', '追記する決まり');
  assert.equal(store.state.knowledge.entries.filter((e) => e.domainId === 'ui').length, 1);
  assert.equal(store.state.knowledge.entries.find((e) => e.domainId === 'ui').text, '最初の決まり\n\n追記する決まり');
  reset(original);
  server(500);
  const moved = updateKnowledgeEntry('a', { domainId: 'other', text: '長'.repeat(5100) });
  assert.equal(store.state.knowledge.entries.length, 1);
  assert.ok(store.state.knowledge.entries[0].text.includes('長'.repeat(5100)));
  await moved;
  assert.deepEqual(store.state.knowledge.entries, original.knowledge.entries);
});

test('the こだわり chat: the message shows at once with the reading under way, and comes back out if refused', async () => {
  const snap = kSnap([]);
  reset(snap);
  assert.deepEqual(tuneModel(store.state), { messages: [], busy: false, max: 12000 });
  let calls = server(200);
  const sent = sendKnowledgeTune('保存ボタンは右に');
  const t = tuneModel(store.state);
  assert.equal(t.busy, true);
  assert.deepEqual(t.messages.map((m) => [m.role, m.text]), [['human', '保存ボタンは右に']]);
  await sent;
  assert.ok(calls[0].url.endsWith('/api/knowledge/tune'));
  assert.deepEqual(calls[0].body, { text: '保存ボタンは右に' });

  reset(snap);
  calls = server(400);
  const refused = sendKnowledgeTune('x');
  await refused;
  assert.equal(tuneModel(store.state).messages.length, 0, 'taken back');
  assert.equal(store.notices.length, 1);
  assert.deepEqual(parseRoute('#/knowledge/tune'), { view: 'knowledge-tune' });
});

test('new work in several workspaces: folders not yet registered are registered first, the main one goes first', async () => {
  reset(snapshot([]));
  store.sending.length = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const answer = String(url).endsWith('/api/projects') ? { projectId: 'p-new' } : { sessionId: 's1' };
    return new Response(JSON.stringify({ ok: true, ...answer }), { status: 200 });
  };
  let where = null;
  await startWork({ text: 'つなげて', suffix: '', provider: 'claude', model: '', effort: '', approvalMode: 'auto', planMode: false, workspaces: ['p1', 'path:C:\new', 'p2', 'p1'], projectName: 'A・new・B' }, { keepDraft: true, onProject: (id, extra) => { where = [id, extra]; } });
  assert.deepEqual(calls.map((c) => c.url.replace(/^.*\/api/, '/api')), ['/api/projects', '/api/sessions']);
  assert.equal(calls[0].body.path, 'C:\new');
  assert.equal(calls[1].body.projectId, 'p1');
  assert.deepEqual(calls[1].body.extraProjectIds, ['p-new', 'p2'], 'each once, in the order ticked');
  assert.deepEqual(where, ['p1', ['p-new', 'p2']]);
  calls.length = 0;
  await startWork({ text: 'ひとつ', suffix: '', provider: 'claude', model: '', effort: '', approvalMode: 'auto', planMode: false, projectId: 'p1', folder: '', projectName: 'A' }, { keepDraft: true });
  assert.equal(calls[0].body.projectId, 'p1');
  assert.equal('extraProjectIds' in calls[0].body, false, 'one workspace sends what it always did');
  store.sending.length = 0;
});

test('only the subscriptions the human uses are offered and shown; turning one off shows at once', async () => {
  const { usableAgents, usableChoice } = await import('../public/js/logic/ai.js');
  const { setSettings } = await import('../public/js/logic/actions.js');
  reset(snapshot([]));
  assert.deepEqual(usableAgents(), ['claude', 'codex'], 'settings from before the choice: all of them');
  const calls = server(200);
  const done = setSettings({ providers: ['codex'] });
  assert.deepEqual(usableAgents(), ['codex'], 'shown before the server answers');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.at(-1).body, { providers: ['codex'] });
  await done;
  assert.deepEqual(limitsModel({}, usableAgents()).map((x) => x.provider), ['codex']);
  assert.equal(usableChoice({ provider: 'claude', model: 'opus', effort: 'high' }).provider, 'codex', 'a choice of an agent not used moves to one that is');
  const kept = { provider: 'codex', model: '', effort: '' };
  assert.equal(usableChoice(kept), kept);
  server(500);
  await setSettings({ providers: ['claude'] });
  assert.deepEqual(usableAgents(), ['codex'], 'refused: back to what it was before this change');
});
