// The UI's logic layer (public/js/logic) runs without a browser: it never touches the DOM. These tests pin down
// the two promises the UI makes: every piece of work can be managed from the inbox, and what the human does shows
// at once and is taken back if the server refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../public/js/logic/store.js';
import { act, renameProject, runStep, sendAnswer, sendMessage, setProjectPreamble, setProjectWorktree, setStep, shutdownApp, startAppUpdate } from '../public/js/logic/actions.js';
import { fullStamp, leftTone, stamp } from '../public/js/logic/format.js';
import { ARCHIVE_FOLD, advanceAccordion, archiveModel, busyCount, checkGroups, inInbox, inboxModel, isOpen, limitsModel, railModel, sessionModel } from '../public/js/logic/selectors.js';
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
  store.expanded.clear();
  store.lastOpenIds = [];
  store.userCollapsed = false;
  store.receive(snap);
}
const get = (id) => store.state.sessions.find((s) => s.id === id);

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

test('ticking the last of the human\'s steps finishes the work at once', async () => {
  const steps = () => [{ title: 'a', done: true }, { title: 'b', done: false }];
  reset(snapshot([sess('a', { completion: 'human_steps', task: { humanSteps: steps() } })]));
  server(409);
  const pending = setStep('a', 1, true);
  assert.equal(get('a').task.humanSteps[1].done, true);
  assert.equal(get('a').archived, true);
  await pending;
  assert.equal(get('a').task.humanSteps[1].done, false, 'taken back');
  assert.equal(get('a').archived, false);
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
