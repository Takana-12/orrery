// What "finished" means: a reply that ended is not always a finished turn, and what is left may be the human's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore, completionOf } from '../src/index.ts';
import type { AttentionAnswer, AttentionItem } from '../src/index.ts';

function setup(store = new MemoryEventStore()) {
  let t = 1000;
  const delivered: { item: AttentionItem; answer: AttentionAnswer }[] = [];
  const core = new ControlCore({ store, now: () => t++, onPassiveAnswer: (item, answer) => void delivered.push({ item, answer }) });
  core.start();
  return { core, store, delivered };
}

function finishedSession(core: ControlCore) {
  const projectId = core.addProject('p', `C:\\work\\${Math.random()}`);
  const s = core.createSession({ projectId, provider: 'claude', title: 'task' });
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running', providerSessionId: 'prov' });
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: 'AとBどちらにしますか' });
  return s.id;
}

const ask = (core: ControlCore, sessionId: string, requestId = 'final:1') =>
  core.attentionOpen({ sessionId, requestId, type: 'user_question', summary: 'AかBか', allowDecline: true, passive: true, questions: [{ id: 'answer', header: null, text: 'AかBか', multiSelect: false, allowFreeText: true, isSecret: false, options: [] }] });

const completion = (core: ControlCore, id: string) => {
  const s = core.state.sessions.get(id)!;
  return completionOf(core.state.tasks.get(s.taskId)!, s);
};

test('a reply that ended while background work is live is still working, not finished', () => {
  const { core } = setup();
  const id = finishedSession(core);
  core.sessionUpdate(id, { lifecycle: 'running' });
  core.sessionUpdate(id, { background: ['npm test'] });
  core.sessionUpdate(id, { lifecycle: 'running', awaitingBackground: true, lastText: 'テストの完了を待っています' });
  const s = core.state.sessions.get(id)!;
  assert.equal(s.lifecycle, 'running');
  assert.equal(s.awaitingBackground, true);
  assert.deepEqual(s.background, ['npm test']);
  assert.equal(completion(core, id), 'working');
  assert.deepEqual(core.setAccepted(id, true).ok, false, 'cannot be called done while it waits');

  core.sessionUpdate(id, { background: null });
  core.sessionUpdate(id, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed' });
  assert.equal(core.state.sessions.get(id)!.awaitingBackground, false, 'any other state ends the waiting');
  assert.equal(completion(core, id), 'unverified');
});

test('a process that is gone takes its background work with it', () => {
  const { core } = setup();
  const id = finishedSession(core);
  core.sessionUpdate(id, { lifecycle: 'running', awaitingBackground: true, background: ['dev server'] });
  core.sessionUpdate(id, { process: 'crashed' });
  const s = core.state.sessions.get(id)!;
  assert.equal(s.background, null);
  assert.equal(s.awaitingBackground, false);
  assert.equal(s.lifecycle, 'error');
});

test('human steps keep their precondition, and finishing them is what completes the work', () => {
  const { core } = setup();
  const id = finishedSession(core);
  core.setHumanSteps(id, [
    { title: 'アプリを入れ直す', detail: null, command: 'npm run install-app', after: 'いま回しているテストが通ってから' },
    { title: 'PRをマージする', detail: null, command: null },
  ]);
  const steps = core.state.tasks.get(core.state.sessions.get(id)!.taskId)!.humanSteps!;
  assert.equal(steps[0]!.after, 'いま回しているテストが通ってから');
  assert.equal(steps[1]!.after, null);
  assert.equal(completion(core, id), 'human_steps');
  assert.equal(core.setHumanStepDone(id, 0, true), false);
  assert.equal(core.setHumanStepDone(id, 1, true), true);
  assert.equal(completion(core, id), 'unverified', 'nothing is left for the human');
});

test('a restart does not forget which reply was read, nor the steps already ticked', () => {
  const store = new MemoryEventStore();
  const first = setup(store);
  const id = finishedSession(first.core);
  const turn = first.core.state.sessions.get(id)!.lifecycleSince;
  first.core.replyRead(id, turn);
  first.core.setHumanSteps(id, [{ title: 'a', detail: null, command: null }, { title: 'b', detail: null, command: null }]);
  first.core.setHumanStepDone(id, 0, true);

  const second = setup(store);
  const s = second.core.state.sessions.get(id)!;
  const t = second.core.state.tasks.get(s.taskId)!;
  assert.equal(s.lifecycle, 'turn_finished');
  assert.equal(t.readTurn, s.lifecycleSince, 'same finished turn: no need to read it again');
  assert.deepEqual(t.humanSteps!.map((x) => x.done), [true, false]);
});

test('a question read from a reply stays answerable after the process stops and after a restart', () => {
  const store = new MemoryEventStore();
  const first = setup(store);
  const id = finishedSession(first.core);
  const itemId = ask(first.core, id);
  assert.equal(first.core.state.sessions.get(id)!.lifecycle, 'turn_finished', 'passive: the session is not waiting on it');
  first.core.sessionUpdate(id, { process: 'stopped' });
  assert.equal(first.core.state.items.get(itemId)!.status, 'pending', 'freeing the process does not withdraw the question');

  const second = setup(store);
  assert.equal(second.core.state.items.get(itemId)!.status, 'pending', 'still open after a restart');
  const r = second.core.answer(itemId, { kind: 'answers', answers: { answer: ['A'] } });
  assert.deepEqual(r, { ok: true });
  assert.equal(second.delivered.length, 1);
  assert.equal(second.delivered[0]!.item.sessionId, id);
  assert.equal(second.core.state.items.get(itemId)!.status, 'resolved');
  assert.equal(second.core.answer(itemId, { kind: 'answers', answers: { answer: ['B'] } }).ok, false, 'answered once');
});

test('a question read from a reply is withdrawn when the work moves on, is put away, or is called done', () => {
  for (const how of ['moves on', 'archived', 'accepted', 'superseded'] as const) {
    const { core } = setup();
    const id = finishedSession(core);
    const itemId = ask(core, id);
    if (how === 'moves on') core.sessionUpdate(id, { lifecycle: 'running' });
    else if (how === 'archived') assert.deepEqual(core.setArchived(id, true), { ok: true });
    else if (how === 'accepted') assert.deepEqual(core.setAccepted(id, true), { ok: true }, 'an unanswered passive question does not block completion');
    else ask(core, id, 'final:2');
    assert.equal(core.state.items.get(itemId)!.status, 'expired', how);
  }
});

test('a real provider request still blocks completion and still dies with its process', () => {
  const { core } = setup();
  const projectId = core.addProject('p', 'C:\\work\\x');
  const s = core.createSession({ projectId, provider: 'claude', title: 'task' });
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  const itemId = core.attentionOpen({ sessionId: s.id, requestId: 'r', type: 'permission_approval', summary: 'x', approval: { tool: 'Bash', subject: 'ls', cwd: null, reason: null, decisions: ['accept', 'decline'] }, reply: () => {} });
  assert.throws(() => core.attentionOpen({ sessionId: s.id, requestId: 'r2', type: 'permission_approval', summary: 'x' }), /needs a reply/);
  core.sessionUpdate(s.id, { process: 'stopped' });
  assert.equal(core.state.items.get(itemId)!.status, 'expired');
});
