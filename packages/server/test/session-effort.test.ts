import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore } from '#core';
import type { MessageOptions, ProviderId, StartSessionRequest } from '#core';
import type { Runtime } from '../src/application/runtime.ts';
import { Scheduler } from '../src/application/scheduler.ts';
import { Sessions } from '../src/application/sessions.ts';
import { ROUTES } from '../src/interface/http/routes.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(provider: ProviderId = 'codex') {
  const events = new MemoryEventStore();
  const core = new ControlCore({ store: events });
  core.start();
  const sent: { id: string; text: string; options: MessageOptions }[] = [];
  const started: StartSessionRequest[] = [];
  const heard: string[] = [];
  let live = true;
  const models = [{ id: 'chosen-model', label: 'Chosen', efforts: ['low', 'medium', 'high'] }];
  const adapter = {
    listModels: async () => models,
    isLive: () => live,
    sendMessage: async (id: string, text: string, options: MessageOptions) => { sent.push({ id, text, options }); },
    startSession: async (req: StartSessionRequest) => { started.push(req); },
  };
  const rt = { core, closing: false, notify: () => {}, adapters: { claude: adapter, codex: adapter } } as unknown as Runtime;
  const scheduler = new Scheduler(rt, (x) => x);
  const sessions = new Sessions(rt, {
    scheduler, attachmentsDir: 'attachments',
    secrets: { envFor: () => ({}), redact: (x: string) => x },
    workspaces: { reopen: async () => {} },
    knowledge: { heard: (_id: string, text: string) => { heard.push(text); } },
  } as never);
  const projectId = core.addProject('workspace', process.cwd());
  const s = core.createSession({ projectId, provider, title: 'work', model: 'chosen-model', effort: 'medium' });
  core.sessionUpdate(s.id, { providerSessionId: 'same-conversation', model: 'chosen-model', lifecycle: 'turn_finished' });
  return { core, events, scheduler, sessions, adapter, s, sent, started, heard, models, setLive: (value: boolean) => { live = value; } };
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: a live follow-up changes effort, keeps its model, and later messages inherit it`, async () => {
    const w = setup(provider);
    await w.sessions.send(w.s.id, 'more', { effort: 'high' });
    assert.deepEqual(w.sent, [{ id: w.s.id, text: 'more', options: { effort: 'high' } }]);
    assert.equal(w.s.effort, 'high');
    assert.equal(w.s.provider, provider);
    assert.equal(w.s.requestedModel, 'chosen-model');
    assert.equal(w.s.model, 'chosen-model');
    assert.equal(w.started.length, 0, 'the live conversation is not restarted');
    w.core.sessionUpdate(w.s.id, { lifecycle: 'turn_finished' });
    await w.sessions.send(w.s.id, 'again');
    assert.equal(w.sent[1]!.options.effort, 'high');
    const restored = new ControlCore({ store: w.events });
    assert.equal(restored.state.sessions.get(w.s.id)!.effort, 'high', 'saved effort survives a restart');
  });

  test(`${provider}: a stopped process resumes the same conversation and model with the selected effort`, async () => {
    const w = setup(provider);
    w.setLive(false);
    const result = await w.sessions.send(w.s.id, 'continue', { effort: 'low' });
    await flush();
    assert.equal(result.resumed, true);
    assert.equal(w.started.length, 1);
    const req = w.started[0]!;
    assert.equal(req.resumeProviderSessionId, 'same-conversation');
    assert.equal(req.model, 'chosen-model');
    assert.equal(req.effort, 'low');
    assert.equal(req.prompt, 'continue');
  });
}

test('busy work holds the selected effort without touching the active turn; merged instructions use the last choice', async () => {
  const w = setup();
  w.core.sessionUpdate(w.s.id, { lifecycle: 'running' });
  assert.equal((await w.sessions.send(w.s.id, 'first', { effort: 'low' })).deferred, true);
  await w.sessions.send(w.s.id, 'second', { effort: 'high' });
  assert.equal(w.sent.length, 0);
  assert.equal(w.sessions.deferredOf(w.s.id), 'first\n\nsecond');
  w.core.sessionUpdate(w.s.id, { lifecycle: 'turn_finished' });
  w.sessions.flushDeferred();
  await flush();
  assert.deepEqual(w.sent, [{ id: w.s.id, text: 'first\n\nsecond', options: { effort: 'high' } }]);
  assert.deepEqual(w.heard, ['first', 'second'], 'held instructions are not captured twice');
});

test('a queued message keeps its own effort when a later follow-up picks another one', async () => {
  const w = setup();
  w.core.setSettings({ maxConcurrent: 1 });
  const blocker = w.core.createSession({ projectId: w.s.projectId, provider: 'codex', title: 'busy' });
  w.core.sessionUpdate(blocker.id, { lifecycle: 'running' });
  await w.sessions.send(w.s.id, 'queued', { effort: 'low' });
  assert.equal(w.s.lifecycle, 'queued');
  await w.sessions.send(w.s.id, 'next', { effort: 'high' });
  w.core.sessionUpdate(blocker.id, { lifecycle: 'turn_finished' });
  w.scheduler.pump();
  await flush();
  assert.deepEqual(w.sent.map((m) => [m.text, m.options.effort]), [['queued', 'low']]);
  w.core.sessionUpdate(w.s.id, { lifecycle: 'turn_finished' });
  w.sessions.flushDeferred();
  await flush();
  assert.deepEqual(w.sent.map((m) => [m.text, m.options.effort]), [['queued', 'low'], ['next', 'high']]);
});

test('an agent waiting only for background work receives the new effort right away', async () => {
  const w = setup('claude');
  w.core.sessionUpdate(w.s.id, { lifecycle: 'running', awaitingBackground: true });
  assert.notEqual((await w.sessions.send(w.s.id, 'more', { effort: 'high' })).deferred, true);
  assert.equal(w.sent[0]!.options.effort, 'high');
});

test('invalid or unsupported effort is refused before state, preferences, or the provider changes', async () => {
  const w = setup();
  for (const effort of [null, '', 3, {}, 'max']) {
    await assert.rejects(w.sessions.send(w.s.id, 'more', { effort }), { status: 400 });
    assert.equal(w.s.effort, 'medium');
    assert.equal(w.s.lifecycle, 'turn_finished');
    assert.equal(w.heard.length, 0);
    assert.equal(w.sent.length, 0);
  }
});

test('the actual model takes precedence over its requested alias when checking supported efforts', async () => {
  const w = setup();
  w.core.sessionUpdate(w.s.id, { model: 'resolved-model' });
  w.models.push({ id: 'resolved-model', label: 'Resolved', efforts: ['low'] });
  await assert.rejects(w.sessions.send(w.s.id, 'more', { effort: 'high' }), { status: 400 });
  await w.sessions.send(w.s.id, 'more', { effort: 'low' });
  assert.equal(w.sent[0]!.options.effort, 'low');
});

test('a Claude session started with the provider default can change effort and resumes its resolved model', async () => {
  const w = setup('claude');
  w.s.requestedModel = null;
  w.core.sessionUpdate(w.s.id, { model: 'claude-sonnet-5-5' });
  w.models.push({ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] });
  w.setLive(false);
  await w.sessions.send(w.s.id, 'more', { effort: 'high' });
  await flush();
  assert.equal(w.started[0]!.effort, 'high');
  assert.equal(w.started[0]!.model, 'claude-sonnet-5-5', 'a changed provider default cannot switch the model');
});

test('ordinary messages need no model lookup; an unavailable list refuses an effort change honestly', async () => {
  const w = setup();
  w.adapter.listModels = async () => { throw new Error('offline'); };
  await assert.rejects(w.sessions.send(w.s.id, 'more', { effort: 'high' }), { status: 502 });
  assert.equal(w.s.effort, 'medium');
  await w.sessions.send(w.s.id, 'same effort');
  assert.equal(w.sent[0]!.options.effort, 'medium');
});

test('a provider refusal restores the saved effort and reports an error', async () => {
  const w = setup();
  w.adapter.sendMessage = async () => { throw new Error('effort refused'); };
  await w.sessions.send(w.s.id, 'more', { effort: 'high' });
  await flush();
  assert.equal(w.s.effort, 'medium');
  assert.equal(w.s.lifecycle, 'error');
  assert.equal(w.s.error, 'effort refused');
});

test('a refused held turn restores the effort actually used before it, including a queued predecessor', async () => {
  const w = setup();
  w.core.setSettings({ maxConcurrent: 1 });
  const blocker = w.core.createSession({ projectId: w.s.projectId, provider: 'codex', title: 'busy' });
  w.core.sessionUpdate(blocker.id, { lifecycle: 'running' });
  await w.sessions.send(w.s.id, 'queued', { effort: 'low' });
  await w.sessions.send(w.s.id, 'held', { effort: 'high' });
  w.core.sessionUpdate(blocker.id, { lifecycle: 'turn_finished' });
  w.scheduler.pump();
  await flush();
  assert.equal(w.sent[0]!.options.effort, 'low');
  w.adapter.sendMessage = async () => { throw new Error('effort refused'); };
  w.core.sessionUpdate(w.s.id, { lifecycle: 'turn_finished' });
  w.sessions.flushDeferred();
  await flush();
  assert.equal(w.s.effort, 'low', 'rollback uses the successful queued turn, not the initial or held setting');
  assert.equal(w.s.lifecycle, 'error');
});

test('the HTTP message route passes effort but accepts no model/provider override', async () => {
  let args: unknown[] = [];
  const route = ROUTES.find((r) => r.method === 'POST' && r.path.test('/api/sessions/session-id/message'))!;
  await route.handle({ app: { sendMessage: (...xs: unknown[]) => { args = xs; } }, params: ['session-id'], body: { text: 'more', effort: 'high', model: 'another', provider: 'claude' } } as never);
  assert.deepEqual(args, ['session-id', 'more', { effort: 'high' }]);
});
