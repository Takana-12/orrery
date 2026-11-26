// The reader turns "the reply ended" into what is actually the case. A scripted model stands in for the helper model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore, completionOf } from '#core';
import type { ProviderAdapter } from '#core';
import { Assistant } from '../src/application/assistant.ts';
import type { AssistantModel, CheckItem, ReplyReading } from '../src/application/assistant.ts';
import { Reader, fallbackReading } from '../src/application/reader.ts';
import type { Runtime } from '../src/application/runtime.ts';

const NOTHING: ReplyReading = { agentContinues: false, questions: [], steps: [], look: null };

type Clarify = Parameters<AssistantModel['clarifyChecks']>[0];

function world(script: (reply: string, background: string[]) => ReplyReading | null, events = new MemoryEventStore(), clarify: (x: Clarify) => CheckItem[] | null = () => null) {
  const calls: { reply: string; background: string[] }[] = [];
  const asked: Clarify[] = [];
  const released: string[] = [];
  const sent: { id: string; text: string }[] = [];
  const replies = new Map<string, string>();
  let reader!: Reader;
  const core = new ControlCore({ store: events, onPassiveAnswer: (item, answer) => reader.deliver(item, answer) });
  core.start();
  const rt = {
    core,
    closing: false,
    notify: () => {},
    store: { turnReplies: (id: string) => replies.get(id) ?? '', saveRaw: () => 'raw-1', readTranscript: (id: string) => [{ role: 'assistant', text: replies.get(id) ?? '' }] },
    adapters: { claude: { finishTurn: (id: string) => (released.push(id), true) } as unknown as ProviderAdapter, codex: {} as ProviderAdapter },
  } as unknown as Runtime;
  const assistant = new Assistant(rt, {
    generateTitle: async () => null,
    readCommandResult: async () => null,
    extractPreferences: async () => null,
    routeKnowledge: async () => null,
    tunePreferences: async () => null,
    clarifyChecks: async (x) => (asked.push(x), clarify(x)),
    readFinalReply: async (reply, context) => {
      calls.push({ reply, background: context.background });
      return script(reply, context.background);
    },
  });
  const sessions = { hasDeferred: () => false, send: async (id: string, text: string) => void sent.push({ id, text }) };
  reader = new Reader(rt, sessions as never, { redact: (x: string) => x } as never, { write: () => {} } as never, assistant, 1);
  const projectId = core.addProject('p', 'C:\\work\\p');
  const start = () => {
    const s = core.createSession({ projectId, provider: 'claude', title: 'task' });
    core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running', providerSessionId: 'prov' });
    return s.id;
  };
  const finish = (id: string, reply: string) => {
    replies.set(id, reply);
    core.sessionUpdate(id, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: reply });
  };
  /** Let the reader look, and wait until the model's answer has been applied. */
  const settle = async () => {
    reader.onChange();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
  };
  const task = (id: string) => core.state.tasks.get(core.state.sessions.get(id)!.taskId)!;
  const completion = (id: string) => completionOf(task(id), core.state.sessions.get(id)!);
  return { core, reader, calls, asked, released, sent, replies, start, finish, settle, task, completion, events };
}

test('a hand-over that is not phrased as a request still becomes the human\'s step', async () => {
  const reply = '実装は終わりました。あとは `npm run install-app` を実行するだけです。';
  const w = world(() => ({ ...NOTHING, steps: [{ title: 'アプリを入れ直す', detail: null, command: 'npm run install-app', after: null }] }));
  const id = w.start();
  w.finish(id, reply);
  await w.settle();
  assert.equal(w.calls.length, 1, 'every finished reply is read, whatever its wording');
  assert.equal(w.completion(id), 'human_steps');
  assert.equal(w.task(id).humanSteps![0]!.command, 'npm run install-app');
  await w.settle();
  assert.equal(w.calls.length, 1, 'and only once');
});

test('a step that must wait for something keeps its precondition', async () => {
  const w = world(() => ({ ...NOTHING, steps: [{ title: 'デプロイする', detail: null, command: 'npm run deploy', after: 'いま回しているテストが通ったら' }] }));
  const id = w.start();
  w.finish(id, 'テストが通ったら npm run deploy してください。');
  await w.settle();
  assert.equal(w.task(id).humanSteps![0]!.after, 'いま回しているテストが通ったら');
});

test('a plain completion report leaves nothing for the human', async () => {
  const w = world(() => NOTHING);
  const id = w.start();
  w.finish(id, '修正してテストも通りました。');
  await w.settle();
  assert.equal(w.completion(id), 'unverified');
  assert.equal(w.task(id).humanSteps, null);
  assert.equal(w.task(id).readTurn, w.core.state.sessions.get(id)!.lifecycleSince);
});

test('while the agent waits for its own background tests, nothing is handed to the human yet', async () => {
  const w = world(() => ({ ...NOTHING, agentContinues: true, steps: [{ title: 'デプロイする', detail: null, command: null, after: 'テスト後' }] }));
  const id = w.start();
  w.replies.set(id, 'テストをバックグラウンドで回しています。終わったら結果を報告します。その後 deploy をお願いします。');
  w.core.sessionUpdate(id, { background: ['npm test'] });
  w.core.sessionUpdate(id, { lifecycle: 'running', awaitingBackground: true, lastText: w.replies.get(id)! });
  await w.settle();
  assert.deepEqual(w.calls[0]!.background, ['npm test'], 'the model is told what is still running');
  assert.deepEqual(w.released, [], 'the agent is waiting: the turn is not finished');
  assert.equal(w.completion(id), 'working');
  assert.equal(w.task(id).humanSteps, null, 'the step is not shown before the agent is really done');
});

test('background work the agent is not waiting for (a dev server) does not keep the turn open', async () => {
  const w = world(() => NOTHING);
  const id = w.start();
  w.replies.set(id, '開発サーバーを起動しました。http://localhost:3000 で確認できます。');
  w.core.sessionUpdate(id, { background: ['npm run dev'] });
  w.core.sessionUpdate(id, { lifecycle: 'running', awaitingBackground: true, lastText: w.replies.get(id)! });
  await w.settle();
  assert.deepEqual(w.released, [id], 'released as a finished turn');
  // The adapter now reports the finished turn; the same words are not sent to the model a second time.
  w.core.sessionUpdate(id, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed' });
  await w.settle();
  assert.equal(w.calls.length, 1);
  assert.equal(w.completion(id), 'unverified');
});

test('when the model cannot be reached, it is tried again and then the wording decides', async () => {
  const w = world(() => null);
  const id = w.start();
  w.finish(id, '設定を変えました。\nアプリを再起動してください。');
  for (let i = 0; i < 6; i++) await w.settle();
  assert.equal(w.calls.length, 3);
  assert.equal(w.completion(id), 'human_steps');
  assert.match(w.task(id).humanSteps![0]!.detail!, /再起動してください/);
  assert.deepEqual(fallbackReading('修正しました。テストも通っています。').steps, [], 'no hand-over words: nothing is invented');
});

test('after a restart the same reply is not read again and ticked steps stay ticked', async () => {
  const events = new MemoryEventStore();
  const steps = (): ReplyReading => ({ ...NOTHING, steps: [{ title: 'a', detail: null, command: null, after: null }, { title: 'b', detail: null, command: null, after: null }] });
  const first = world(steps, events);
  const id = first.start();
  first.finish(id, 'aとbをお願いします。');
  await first.settle();
  first.core.setHumanStepDone(id, 0, true);

  const second = world(steps, events);
  await second.settle();
  assert.equal(second.calls.length, 0);
  assert.deepEqual(second.task(id).humanSteps!.map((x) => x.done), [true, false]);
});

test('a question in the reply goes to the inbox and its answer goes back as a message', async () => {
  const w = world(() => ({ ...NOTHING, questions: [{ text: 'AとBどちらにしますか', multiSelect: false, options: [{ label: 'A', description: null }, { label: 'B', description: null }] }] }));
  const id = w.start();
  w.finish(id, 'AとBどちらにしますか？');
  await w.settle();
  const item = [...w.core.state.items.values()].find((i) => i.sessionId === id)!;
  assert.equal(item.passive, true);
  assert.equal(w.core.state.sessions.get(id)!.lifecycle, 'turn_finished');
  assert.deepEqual(w.core.answer(item.id, { kind: 'answers', answers: { answer: ['B'] } }), { ok: true });
  assert.deepEqual(w.sent, [{ id, text: 'B' }]);
  assert.equal(w.core.state.items.get(item.id)!.status, 'resolved');
});

test('a reply that asks two separate things becomes one ticket with a question for each, answered together', async () => {
  const opt = (label: string) => ({ label, description: null });
  const w = world(() => ({ ...NOTHING, questions: [
    { text: '見比べの結果、どうしますか', multiSelect: false, options: [opt('EXP-2を採用'), opt('EXP-2を破棄'), opt('EXP-3を実施')] },
    { text: '作者アドレスをどうしますか', multiSelect: false, options: [opt('作者アドレスを切り替える'), opt('作者アドレスの設定を戻す')] },
  ] }));
  const id = w.start();
  w.finish(id, '見比べの結果を見て決めてください。それと、作者アドレスはどうしますか？');
  await w.settle();
  const item = [...w.core.state.items.values()].find((i) => i.sessionId === id)!;
  assert.deepEqual(item.questions!.map((q) => [q.id, q.options.length]), [['answer', 3], ['answer-2', 2]]);
  // Each decision is picked on its own: one answer for each question, both required.
  assert.notEqual(w.core.answer(item.id, { kind: 'answers', answers: { answer: ['EXP-3を実施'] } }).ok, true);
  assert.deepEqual(w.core.answer(item.id, { kind: 'answers', answers: { answer: ['EXP-3を実施'], 'answer-2': ['作者アドレスの設定を戻す'] } }), { ok: true });
  assert.deepEqual(w.sent, [{ id, text: '「見比べの結果、どうしますか」→ EXP-3を実施\n「作者アドレスをどうしますか」→ 作者アドレスの設定を戻す' }]);
});

test('things to look at become steps of their own, each knowing the action that comes first', async () => {
  const look = { update: 'rebuild' as const, how: '設定の「更新」を押す', command: null, unclear: [], checks: [
    { what: '「完了にする」ボタンが行の右端にある', where: 'ホームの「あなたの作業」' },
    { what: '「すべて見たことにする」が表示されない', where: 'ホームの「返答が完了した作業」の見出しの右' },
  ] };
  const w = world(() => ({ ...NOTHING, steps: [{ title: 'PRをマージする', detail: null, command: null, after: null }], look }));
  const id = w.start();
  w.finish(id, 'アプリを更新して、2か所を確かめてください。PRのマージもお願いします。');
  await w.settle();
  const steps = w.task(id).humanSteps!;
  assert.deepEqual(steps.map((x) => x.title), ['PRをマージする', 'アプリを更新する', '「完了にする」ボタンが行の右端にある', '「すべて見たことにする」が表示されない']);
  assert.equal(steps[0]!.check ?? null, null, 'an ordinary step is not a check');
  // The action the checks need first is a step of its own (ticked, its command run), not just a note on them.
  assert.equal(steps[1]!.prep, true);
  assert.equal(steps[1]!.detail, '設定の「更新」を押す');
  assert.equal(steps[1]!.check ?? null, null);
  assert.equal(steps[0]!.prep ?? false, false);
  assert.deepEqual(steps[3]!.check, { update: 'rebuild', how: '設定の「更新」を押す', command: null });
  assert.equal(steps[3]!.detail, 'ホームの「返答が完了した作業」の見出しの右');
  assert.equal(w.asked.length, 0, 'nothing was vague: the agent is not asked');
});

test('vague checks are made exact by asking the agent itself before they reach the human', async () => {
  const vague = { update: 'reload' as const, how: null, command: null, checks: [{ what: '2つの文言が消えている', where: null }], unclear: ['消した2つの文言が何か', 'その文言があった場所'] };
  const exact: CheckItem[] = [
    { what: '「自動で進めます」が表示されない', where: 'ホームの「要対応」の見出しの下' },
    { what: '「あとで見る」が表示されない', where: 'ホームの「要対応」の各行の右端' },
  ];
  const w = world(() => ({ ...NOTHING, look: vague }), undefined, () => exact);
  const id = w.start();
  w.core.sessionUpdate(id, { cwd: 'C:\\work\\p-wt' } as never);
  w.finish(id, '要対応画面の文言を2つ消しました。ブラウザを再読み込みして確かめてください。');
  await w.settle();
  assert.equal(w.asked.length, 1);
  assert.deepEqual(w.asked[0]!.unclear, vague.unclear);
  assert.equal(w.asked[0]!.source.fork?.providerSessionId, 'prov', 'a Claude session is asked through a fork of its own conversation');
  assert.deepEqual(w.task(id).humanSteps!.map((x) => x.title), ['画面を再読み込みする', ...exact.map((x) => x.what)]);
  assert.equal(w.task(id).humanSteps![1]!.check?.update, 'reload');
});

test('when the agent cannot be asked, the checks are kept as they were read', async () => {
  const vague = { update: 'none' as const, how: null, command: null, checks: [{ what: '表示を確かめる', where: null }], unclear: ['何を見るか'] };
  const w = world(() => ({ ...NOTHING, look: vague }), undefined, () => null);
  const id = w.start();
  w.finish(id, '表示を確かめてください。');
  await w.settle();
  assert.deepEqual(w.task(id).humanSteps!.map((x) => x.title), ['表示を確かめる'], 'nothing to do first: no step for it');
  assert.equal(w.completion(id), 'human_steps');
  assert.equal(w.asked.length, 1, 'asked once, not again and again');
});
