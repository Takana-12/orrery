import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore, PROJECT_DESCRIPTION_MAX, completionOf, fold } from '../src/index.ts';
import type { AttentionAnswer, Question } from '../src/index.ts';

const q: Question = {
  id: 'db',
  header: 'Database',
  text: 'Which database?',
  multiSelect: false,
  allowFreeText: false,
  isSecret: false,
  options: [
    { label: 'SQLite', description: null },
    { label: 'PostgreSQL', description: null },
  ],
};

function setup(store = new MemoryEventStore()) {
  let t = 1000;
  const core = new ControlCore({ store, now: () => t++ });
  core.start();
  return { core, store };
}

function sessionWithQuestion(core: ControlCore, provider: 'claude' | 'codex' = 'claude', requestId = 'req-1') {
  const projectId = core.addProject(`p-${provider}`, `C:\\work\\${provider}-${Math.random()}`);
  const s = core.createSession({ projectId, provider, title: 'task' });
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running', providerSessionId: `prov-${s.id}` });
  const sent: AttentionAnswer[] = [];
  const itemId = core.attentionOpen({
    sessionId: s.id,
    requestId,
    type: 'user_question',
    summary: 'Which database?',
    questions: [q],
    reply: (a) => void sent.push(a),
  });
  return { sessionId: s.id, itemId, sent };
}

const answerDb = (label: string): AttentionAnswer => ({ kind: 'answers', answers: { db: [label] } });

test('an answer is delivered to its own request only, exactly once', () => {
  const { core } = setup();
  const a = sessionWithQuestion(core, 'claude');
  const b = sessionWithQuestion(core, 'codex');

  assert.deepEqual(core.answer(a.itemId, answerDb('PostgreSQL')), { ok: true });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0, 'the other session must receive nothing');
  assert.equal(core.state.items.get(b.itemId)!.status, 'pending');

  const again = core.answer(a.itemId, answerDb('SQLite'));
  assert.equal(again.ok, false);
  assert.equal(a.sent.length, 1, 'duplicate submit must not reach the provider');
});

test('pressing the button is not completion: resolved only after the provider acknowledges', () => {
  const { core } = setup();
  const a = sessionWithQuestion(core);
  core.answer(a.itemId, answerDb('SQLite'));
  assert.equal(core.state.items.get(a.itemId)!.status, 'answering');
  assert.equal(core.state.sessions.get(a.sessionId)!.lifecycle, 'waiting_for_user');

  core.attentionAcknowledged(a.sessionId, 'req-1', 'tool_result');
  const item = core.state.items.get(a.itemId)!;
  assert.equal(item.status, 'resolved');
  assert.equal(item.acknowledgement!.evidence, 'tool_result');
  assert.equal(core.state.sessions.get(a.sessionId)!.lifecycle, 'running');
});

test('a request the provider settles or withdraws without us expires and cannot be answered', () => {
  const { core } = setup();
  const a = sessionWithQuestion(core, 'codex');
  core.attentionAcknowledged(a.sessionId, 'req-1', 'serverRequest/resolved');
  assert.equal(core.state.items.get(a.itemId)!.status, 'expired');

  const b = sessionWithQuestion(core, 'claude');
  core.attentionWithdrawn(b.sessionId, 'req-1', 'aborted');
  assert.equal(core.state.items.get(b.itemId)!.status, 'expired');

  for (const x of [a, b]) {
    const r = core.answer(x.itemId, answerDb('SQLite'));
    assert.equal(r.ok, false);
    assert.equal(x.sent.length, 0);
  }
});

test('when a turn ends or the process dies, its pending items expire', () => {
  const { core } = setup();
  const a = sessionWithQuestion(core);
  core.sessionUpdate(a.sessionId, { lifecycle: 'interrupted', lastTurnOutcome: 'interrupted' });
  assert.equal(core.state.items.get(a.itemId)!.status, 'expired');

  const b = sessionWithQuestion(core);
  core.sessionUpdate(b.sessionId, { process: 'crashed' });
  assert.equal(core.state.items.get(b.itemId)!.status, 'expired');
  assert.equal(core.state.sessions.get(b.sessionId)!.lifecycle, 'error');
  assert.equal(core.answer(b.itemId, answerDb('SQLite')).ok, false);
  assert.equal(b.sent.length, 0);
});

test('redelivery of the same provider request does not create a second item', () => {
  const { core } = setup();
  const a = sessionWithQuestion(core);
  const second = core.attentionOpen({ sessionId: a.sessionId, requestId: 'req-1', type: 'user_question', summary: 'dup', questions: [q], reply: () => {} });
  assert.equal(second, a.itemId);
  assert.equal(core.state.items.size, 1);
});

test('answers are validated against the question and the allowed decisions', () => {
  const { core } = setup();
  const a = sessionWithQuestion(core);
  assert.equal(core.answer(a.itemId, { kind: 'answers', answers: {} }).ok, false);
  assert.equal(core.answer(a.itemId, answerDb('Oracle')).ok, false, 'free text not allowed for this question');
  assert.equal(core.answer(a.itemId, { kind: 'answers', answers: { db: ['SQLite', 'PostgreSQL'] } }).ok, false, 'not multi-select');
  assert.equal(core.answer(a.itemId, { kind: 'decision', decision: 'accept' }).ok, false);
  assert.equal(a.sent.length, 0);
  assert.equal(core.state.items.get(a.itemId)!.status, 'pending', 'a rejected answer leaves the item answerable');

  const projectId = core.addProject('p', 'C:\\work\\approval');
  const s = core.createSession({ projectId, provider: 'codex', title: 't' });
  const sent: AttentionAnswer[] = [];
  const itemId = core.attentionOpen({
    sessionId: s.id,
    requestId: '0',
    type: 'permission_approval',
    summary: 'run command',
    approval: { tool: 'shell', subject: 'node -v', cwd: 'C:\\work', reason: null, decisions: ['accept', 'decline'] },
    reply: (x) => void sent.push(x),
  });
  assert.equal(core.answer(itemId, { kind: 'decision', decision: 'acceptForSession' }).ok, false, 'broader decision than offered');
  assert.deepEqual(core.answer(itemId, { kind: 'decision', decision: 'decline' }), { ok: true });
  assert.equal(sent.length, 1);
});

test('a failed delivery leaves the item pending and retryable', () => {
  const { core } = setup();
  const projectId = core.addProject('p', 'C:\\work\\fail');
  const s = core.createSession({ projectId, provider: 'claude', title: 't' });
  let fail = true;
  const itemId = core.attentionOpen({
    sessionId: s.id,
    requestId: 'r',
    type: 'user_question',
    summary: 's',
    questions: [q],
    reply: () => {
      if (fail) throw new Error('pipe closed');
    },
  });
  const r = core.answer(itemId, answerDb('SQLite'));
  assert.equal(r.ok, false);
  assert.equal(core.state.items.get(itemId)!.status, 'pending');
  fail = false;
  assert.deepEqual(core.answer(itemId, answerDb('SQLite')), { ok: true });
});

test('restart: state is rebuilt from the log, nothing is shown as running, old items cannot be answered', () => {
  const store = new MemoryEventStore();
  const first = setup(store);
  const pending = sessionWithQuestion(first.core, 'claude', 'req-p');
  const answering = sessionWithQuestion(first.core, 'codex', '0');
  first.core.answer(answering.itemId, answerDb('SQLite'));
  const finished = sessionWithQuestion(first.core, 'codex', '1');
  first.core.answer(finished.itemId, answerDb('SQLite'));
  first.core.attentionAcknowledged(finished.sessionId, '1', 'serverRequest/resolved');
  first.core.sessionUpdate(finished.sessionId, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: 'done' });

  // The control room dies here. A new process starts on the same log.
  const second = new ControlCore({ store: new MemoryEventStore(store.readAll()) });
  assert.equal(second.state.items.get(pending.itemId)!.status, 'pending', 'before start(): exactly what the log says');
  second.start();

  assert.equal(second.state.generation, 2);
  assert.equal(second.state.items.get(pending.itemId)!.status, 'expired');
  assert.equal(second.state.items.get(answering.itemId)!.status, 'expired');
  assert.match(second.state.items.get(answering.itemId)!.expiredReason!, /確認できません/);
  assert.equal(second.state.items.get(finished.itemId)!.status, 'resolved', 'history survives');

  const sPending = second.state.sessions.get(pending.sessionId)!;
  assert.equal(sPending.lifecycle, 'interrupted');
  assert.equal(sPending.process, 'stopped');
  assert.equal(second.state.sessions.get(finished.sessionId)!.lifecycle, 'turn_finished');
  assert.equal(second.state.sessions.get(finished.sessionId)!.lastText, 'done');

  const r = second.answer(pending.itemId, answerDb('SQLite'));
  assert.equal(r.ok, false);
  assert.equal(pending.sent.length, 0);

  // Codex request ids restart at 0 in a new process: the same id in a new generation is a NEW item.
  second.sessionUpdate(answering.sessionId, { process: 'alive', lifecycle: 'running' });
  const reused = second.attentionOpen({ sessionId: answering.sessionId, requestId: '0', type: 'user_question', summary: 'again', questions: [q], reply: () => {} });
  assert.notEqual(reused, answering.itemId);
  assert.equal(second.state.items.get(reused)!.status, 'pending');
});

test('the projection is a pure fold of the log', () => {
  const { core, store } = setup();
  const a = sessionWithQuestion(core);
  core.answer(a.itemId, answerDb('SQLite'));
  core.attentionAcknowledged(a.sessionId, 'req-1', 'tool_result');
  const rebuilt = fold(store.readAll());
  assert.deepEqual([...rebuilt.items.values()], [...core.state.items.values()]);
  assert.deepEqual([...rebuilt.sessions.values()], [...core.state.sessions.values()]);
});

test('finished work is "new" until the human opens it; archive is reversible and refuses live work', () => {
  const { core, store } = setup();
  const a = sessionWithQuestion(core);
  assert.equal(core.setArchived(a.sessionId, true).ok, false, 'waiting on the human: cannot be put away');
  core.answer(a.itemId, answerDb('SQLite'));
  core.attentionAcknowledged(a.sessionId, 'req-1', 'tool_result');
  assert.equal(core.state.sessions.get(a.sessionId)!.unread, false);
  core.sessionUpdate(a.sessionId, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: 'done' });
  assert.equal(core.state.sessions.get(a.sessionId)!.unread, true);
  core.markSeen(a.sessionId);
  assert.equal(core.state.sessions.get(a.sessionId)!.unread, false);

  assert.deepEqual(core.setArchived(a.sessionId, true), { ok: true });
  assert.equal(core.state.sessions.get(a.sessionId)!.archived, true);
  assert.equal(core.state.items.get(a.itemId)!.status, 'resolved', 'archiving deletes nothing');
  const rebuilt = fold(store.readAll());
  assert.equal(rebuilt.sessions.get(a.sessionId)!.archived, true, 'survives a restart');
  core.setArchived(a.sessionId, false);
  assert.equal(core.state.sessions.get(a.sessionId)!.archived, false);
});

test('completion follows evidence: a finished turn is not a finished task', () => {
  const { core } = setup();
  const projectId = core.addProject('p', 'C:\\work\\done');
  const s = core.createSession({ projectId, provider: 'claude', title: 't', checkCommand: 'npm test', autoFix: true });
  const task = () => core.state.tasks.get(s.taskId)!;
  const session = () => core.state.sessions.get(s.id)!;
  const completion = () => completionOf(task(), session());
  const result = (ok: boolean) => ({ command: 'npm test', ok, exitCode: ok ? 0 : 1, outputTail: ok ? 'ok' : '1 failed', at: 1, uncommittedFiles: 2 });

  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  assert.equal(completion(), 'working');
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished', lastText: 'All done!' });
  assert.equal(completion(), 'unverified', 'the agent saying "done" proves nothing');
  assert.equal(core.setAccepted(s.id, true).ok, true, 'without a check the human may still accept');
  core.setAccepted(s.id, false);

  core.validationStarted(task().id);
  assert.equal(completion(), 'validating');
  core.validated(task().id, result(false));
  assert.equal(completion(), 'needs_fix');
  assert.equal(core.setAccepted(s.id, true).ok, true, 'the human may call it done even when the check failed');
  assert.equal(completion(), 'accepted');
  core.setAccepted(s.id, false);
  assert.equal(completion(), 'needs_fix');
  assert.equal(session().unread, true);

  core.sessionUpdate(s.id, { lifecycle: 'running' });
  assert.equal(task().validation, null, 'work resumed: the old result is stale');
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished' });
  core.validated(task().id, result(true));
  assert.equal(completion(), 'candidate', 'a passing check makes it a candidate, not done');
  assert.deepEqual(core.setAccepted(s.id, true), { ok: true });
  assert.equal(completion(), 'accepted');

  core.sessionUpdate(s.id, { lifecycle: 'running' });
  assert.equal(completion(), 'working', 'more work reopens the task');
});

test('settings are clamped and survive a restart; tasks can be renamed', () => {
  const { core, store } = setup();
  assert.deepEqual(core.setSettings({ maxConcurrent: 0 }), { maxConcurrent: 1, minFreeMemoryMB: 0, confirmCommands: true, autoResumeOnLimit: true, preamble: '', sideChat: { provider: 'claude', model: 'sonnet', effort: 'low' }, knowledge: { capture: true, inject: true }, voice: { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: true } });
  core.setSettings({ maxConcurrent: 3, minFreeMemoryMB: 2048, confirmCommands: false, preamble: '日本語で答えて', sideChat: { provider: 'codex' as const, model: ' gpt-6-luna ', effort: 'low' } });
  const projectId = core.addProject('p', 'C:\\work\\s');
  const s = core.createSession({ projectId, provider: 'codex', title: 'first words of the prompt' });
  core.renameTask(s.id, '  ログイン画面の\n修正  ');
  const rebuilt = fold(store.readAll());
  assert.deepEqual(rebuilt.settings, { maxConcurrent: 3, minFreeMemoryMB: 2048, confirmCommands: false, autoResumeOnLimit: true, preamble: '日本語で答えて', sideChat: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, knowledge: { capture: true, inject: true }, voice: { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: true } });
  assert.equal(rebuilt.tasks.get(s.taskId)!.title, 'ログイン画面の 修正');
});

test('what is left for the human: finishing the steps is what finishes the task', () => {
  const { core } = setup();
  const projectId = core.addProject('p', 'C:\\work\\steps');
  const s = core.createSession({ projectId, provider: 'codex', title: 't' });
  const completion = () => completionOf(core.state.tasks.get(s.taskId)!, core.state.sessions.get(s.id)!);
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished', lastText: 'PRを作りました。gh pr merge 707 --merge を実行してください。' });
  core.setHumanSteps(s.id, [
    { title: 'PRをマージする', detail: null, command: 'gh pr merge 707 --merge' },
    { title: '本番で表示を確認する', detail: 'トップページ', command: null },
  ]);
  assert.equal(completion(), 'human_steps');
  assert.equal(core.setHumanStepDone(s.id, 0, true), false);
  assert.equal(completion(), 'human_steps');
  assert.equal(core.setHumanStepDone(s.id, 1, true), true, 'all steps done');
  assert.equal(completion(), 'unverified', 'nothing left for the human to do but accept');
  assert.deepEqual(core.setAccepted(s.id, true), { ok: true });
  assert.equal(completion(), 'accepted');
  core.sessionUpdate(s.id, { lifecycle: 'running' });
  assert.equal(core.state.tasks.get(s.taskId)!.humanSteps, null, 'more agent work discards the old list');
});

test('a step whose command ran: its output decides whether it is done and what is left', () => {
  const { core, store } = setup();
  const projectId = core.addProject('p', 'C:\\work\\run');
  const s = core.createSession({ projectId, provider: 'claude', title: 't' });
  const steps = () => core.state.tasks.get(s.taskId)!.humanSteps!;
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished', lastText: 'npm run release を実行してください。' });
  core.setHumanSteps(s.id, [{ title: '本番へのデプロイを承認する', detail: null, command: 'npm run release' }, { title: '本番を確認する', detail: null, command: null }]);

  assert.equal(core.humanStepRan(s.id, 0, 'other', 'run-1'), false, "only the step's own command");
  assert.equal(core.humanStepRan(s.id, 0, 'npm run release', 'run-1'), true);
  assert.equal(steps()[0]!.run!.phase, 'running');
  core.humanStepRan(s.id, 0, 'npm run release', 'run-1', { ok: false, exitCode: 1, outputTail: 'approval needs a terminal' });
  assert.equal(steps()[0]!.run!.phase, 'reading');
  // Not done, and the output says what to do instead: that takes the step's place, carrying the run that led to it.
  assert.equal(core.settleHumanStep(s.id, 'run-1', { done: false, note: '承認には対話が必要です', steps: [{ title: 'ターミナルで npm run release を実行して承認する', detail: null, command: 'npm run release' }] }), false);
  assert.deepEqual(steps().map((x) => [x.title, x.done]), [['ターミナルで npm run release を実行して承認する', false], ['本番を確認する', false]]);
  assert.equal(steps()[0]!.run!.note, '承認には対話が必要です');
  assert.equal(completionOf(core.state.tasks.get(s.taskId)!, core.state.sessions.get(s.id)!), 'human_steps', "not done: still the human's");

  // Done, with something to do after it: it follows the step.
  core.humanStepRan(s.id, 0, 'npm run release', 'run-2');
  core.humanStepRan(s.id, 0, 'npm run release', 'run-2', { ok: true, exitCode: 0, outputTail: 'deployed. visit https://example.test' });
  assert.equal(core.settleHumanStep(s.id, 'run-2', { done: true, note: null, steps: [{ title: '表示されたURLを開く', detail: null, command: null }] }), false);
  assert.deepEqual(steps().map((x) => [x.title, x.done]), [['ターミナルで npm run release を実行して承認する', true], ['表示されたURLを開く', false], ['本番を確認する', false]]);

  // A run cut off by a restart is settled, so the step can be run again.
  core.setHumanSteps(s.id, [{ title: 'x', detail: null, command: 'npm test' }]);
  core.humanStepRan(s.id, 0, 'npm test', 'run-3');
  const rebuilt = fold([...store.readAll(), { seq: 1e9, at: Date.now(), event: { type: 'core.started', generation: 99 } }]);
  assert.equal(rebuilt.tasks.get(s.taskId)!.humanSteps![0]!.run!.phase, 'settled');
});

test('an answer the agent went on from is settled, even when the provider never confirms it', () => {
  const { core } = setup();
  const projectId = core.addProject('p', 'C:\work\went-on');
  const s = core.createSession({ projectId, provider: 'claude', title: 't' });
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'waiting_for_user' });
  const open = () => core.attentionOpen({ sessionId: s.id, requestId: String(Math.random()), type: 'user_question', summary: 'q', questions: [q], reply: () => {} });
  const a = open();
  assert.equal(core.answer(a, { kind: 'answers', answers: { db: ['SQLite'] } }).ok, true);
  assert.equal(core.state.items.get(a)!.status, 'answering');
  core.sessionUpdate(s.id, { lifecycle: 'running' });
  assert.equal(core.state.items.get(a)!.status, 'resolved', 'working again is the evidence');

  core.sessionUpdate(s.id, { lifecycle: 'waiting_for_user' });
  const b = open();
  core.answer(b, { kind: 'answers', answers: { db: ['SQLite'] } });
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished' });
  assert.equal(core.state.items.get(b)!.status, 'resolved', 'so is the turn ending');

  core.sessionUpdate(s.id, { lifecycle: 'waiting_for_user' });
  const c = open();
  core.answer(c, { kind: 'answers', answers: { db: ['SQLite'] } });
  core.sessionUpdate(s.id, { process: 'crashed' });
  assert.equal(core.state.items.get(c)!.status, 'expired', 'a crash is not evidence that it arrived');
});

test('a project uses worktrees by default; the setting is per project and survives a restart', () => {
  const { core, store } = setup();
  const a = core.addProject('a', 'C:\work\wt-a');
  const b = core.addProject('b', 'C:\work\wt-b');
  assert.equal(core.state.projects.get(a)!.useWorktree, true);
  core.setProjectOptions(a, { useWorktree: false });
  assert.equal(core.state.projects.get(a)!.useWorktree, false);
  assert.equal(core.state.projects.get(b)!.useWorktree, true);
  const again = setup(store).core;
  assert.equal(again.state.projects.get(a)!.useWorktree, false);
  assert.equal(again.state.projects.get(b)!.useWorktree, true);
});

test("a project leaves approvals to the agent's review by default; the setting is per project and survives a restart", () => {
  const { core, store } = setup();
  const a = core.addProject('a', 'C:\work\ap-a');
  const b = core.addProject('b', 'C:\work\ap-b');
  assert.equal(core.state.projects.get(a)!.approvalMode, 'auto');
  core.setProjectOptions(a, { approvalMode: 'ask' });
  assert.equal(core.state.projects.get(a)!.approvalMode, 'ask');
  assert.equal(core.state.projects.get(a)!.useWorktree, true, 'the worktree option is left alone');
  assert.equal(core.state.projects.get(b)!.approvalMode, 'auto');
  assert.throws(() => core.setProjectOptions(a, { approvalMode: 'yolo' as any }));
  assert.equal(core.state.projects.get(a)!.approvalMode, 'ask');
  const again = setup(store).core;
  assert.equal(again.state.projects.get(a)!.approvalMode, 'ask');
  assert.equal(again.state.projects.get(b)!.approvalMode, 'auto');
});

test("a project can be renamed; the name is tidied, an empty one refused, and it survives a restart", () => {
  const { core, store } = setup();
  const a = core.addProject('a', 'C:\work\rn-a');
  const b = core.addProject('b', 'C:\work\rn-b');
  assert.equal(core.renameProject(a, '  新しい   名前 '), '新しい 名前');
  assert.equal(core.state.projects.get(a)!.name, '新しい 名前');
  assert.equal(core.state.projects.get(a)!.rootPath, 'C:\work\rn-a', 'the folder stays where it is');
  assert.equal(core.state.projects.get(b)!.name, 'b');
  assert.throws(() => core.renameProject(a, '   '));
  assert.equal(core.state.projects.get(a)!.name, '新しい 名前');
  assert.equal(setup(store).core.state.projects.get(a)!.name, '新しい 名前');
});

test("a project's description is its own, trimmed and bounded, changes nothing else, and survives a restart", () => {
  const { core, store } = setup();
  const a = core.addProject('a', 'C:\work\pd-a');
  const b = core.addProject('b', 'C:\work\pd-b');
  assert.equal(core.state.projects.get(a)!.description, '', 'a new project has none');
  core.setProjectOptions(a, { preamble: '日本語で' });
  core.setProjectOptions(a, { description: '  Unity製の2Dゲーム\n敵AIはここ  ' });
  assert.equal(core.state.projects.get(a)!.description, 'Unity製の2Dゲーム\n敵AIはここ');
  assert.equal(core.state.projects.get(a)!.preamble, '日本語で', 'the description leaves the default message alone');
  assert.equal(core.state.projects.get(b)!.description, '');
  const before = store.readAll().length;
  core.setProjectOptions(a, { description: 'Unity製の2Dゲーム\n敵AIはここ ' });
  assert.equal(store.readAll().length, before, 'the same words again record nothing');
  core.setProjectOptions(b, { description: 'x'.repeat(5000) });
  assert.equal(core.state.projects.get(b)!.description.length, PROJECT_DESCRIPTION_MAX);
  const again = setup(store).core;
  assert.equal(again.state.projects.get(a)!.description, 'Unity製の2Dゲーム\n敵AIはここ');
  assert.equal(again.state.projects.get(a)!.preamble, '日本語で');
});

test("a project's default message is its own, changes nothing else, and survives a restart", () => {
  const { core, store } = setup();
  const a = core.addProject('a', 'C:\work\pm-a');
  const b = core.addProject('b', 'C:\work\pm-b');
  assert.equal(core.state.projects.get(a)!.preamble, '');
  core.setProjectOptions(a, { useWorktree: false });
  core.setProjectOptions(a, { preamble: 'テストを書くこと' });
  assert.equal(core.state.projects.get(a)!.preamble, 'テストを書くこと');
  assert.equal(core.state.projects.get(a)!.useWorktree, false, 'setting the message leaves the worktree option alone');
  assert.equal(core.state.projects.get(b)!.preamble, '');
  const again = setup(store).core;
  assert.equal(again.state.projects.get(a)!.preamble, 'テストを書くこと');
  assert.equal(again.state.projects.get(a)!.useWorktree, false);
});
