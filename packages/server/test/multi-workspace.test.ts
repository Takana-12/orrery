// One piece of work in several workspaces, and the choice of which AI subscriptions the human uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlCore, MemoryEventStore, enabledProviders } from '#core';
import type { StartSessionRequest } from '#core';
import type { Runtime } from '../src/application/runtime.ts';
import { Scheduler } from '../src/application/scheduler.ts';
import { Sessions } from '../src/application/sessions.ts';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function setup() {
  const events = new MemoryEventStore();
  const core = new ControlCore({ store: events });
  core.start();
  const started: StartSessionRequest[] = [];
  const adapter = { isLive: () => false, startSession: async (req: StartSessionRequest) => { started.push(req); } };
  const rt = { core, closing: false, notify: () => {}, adapters: { claude: adapter, codex: adapter } } as unknown as Runtime;
  const scheduler = new Scheduler(rt, (x) => x);
  const sessions = new Sessions(rt, {
    scheduler, attachmentsDir: 'attachments',
    secrets: { envFor: () => ({}), redact: (x: string) => x },
    journal: { write: () => {} },
    assistant: { queue: () => {} },
    workspaces: { reopen: async () => {} },
    knowledge: { heard: () => {}, preferencesFor: async () => ({ text: '', domains: [], dropped: 0 }) },
  } as never);
  const dir = (name: string) => mkdtempSync(join(tmpdir(), `orrery-${name}-`));
  return { core, events, sessions, started, a: core.addProject('A', dir('a')), b: core.addProject('B', dir('b')), c: core.addProject('C', dir('c')) };
}

test('work in several workspaces starts in the main one and is handed the others to work in too', async () => {
  const w = setup();
  const id = await w.sessions.start({ projectId: w.a, extraProjectIds: [w.b, w.c, w.a, w.b], provider: 'claude', prompt: 'make them talk', worktree: false });
  await settle();
  const s = w.core.state.sessions.get(id)!;
  assert.equal(s.projectId, w.a, 'the first one ticked is the main one');
  assert.deepEqual(s.extraProjectIds, [w.b, w.c], 'the others in the order ticked, each once, the main one not repeated');
  assert.equal(s.cwd, w.core.state.projects.get(w.a)!.rootPath);
  const req = w.started[0]!;
  assert.deepEqual(req.extraDirs, [w.core.state.projects.get(w.b)!.rootPath, w.core.state.projects.get(w.c)!.rootPath]);
  assert.match(req.prompt, /次のワークスペースも参照・編集の対象/);
  assert.ok(req.prompt.includes(w.core.state.projects.get(w.b)!.rootPath), 'the agent is told where the others are');
  assert.equal(req.shownPrompt, 'make them talk', 'the transcript shows only what the human wrote');
  const restored = new ControlCore({ store: w.events });
  assert.deepEqual(restored.state.sessions.get(id)!.extraProjectIds, [w.b, w.c], 'remembered across a restart');
});

test('work in one workspace is as before, and an unknown extra workspace is refused', async () => {
  const w = setup();
  const id = await w.sessions.start({ projectId: w.a, provider: 'codex', prompt: 'alone', worktree: false });
  await settle();
  assert.equal(w.core.state.sessions.get(id)!.extraProjectIds, undefined);
  assert.deepEqual(w.started[0]!.extraDirs, []);
  assert.equal(w.started[0]!.prompt, 'alone');
  await assert.rejects(w.sessions.start({ projectId: w.a, extraProjectIds: ['nope'], provider: 'claude', prompt: 'x', worktree: false }));
});

test('a resumed conversation still reaches the other workspaces', async () => {
  const w = setup();
  const id = await w.sessions.start({ projectId: w.a, extraProjectIds: [w.b], provider: 'claude', prompt: 'first', worktree: false });
  await settle();
  w.core.sessionUpdate(id, { providerSessionId: 'conv', lifecycle: 'turn_finished' });
  await w.sessions.send(id, 'more');
  await settle();
  assert.equal(w.started.length, 2);
  assert.deepEqual(w.started[1]!.extraDirs, [w.core.state.projects.get(w.b)!.rootPath]);
});

test('the subscriptions used: all by default, only known ones, never none, no event when nothing changes', () => {
  const core = new ControlCore({ store: new MemoryEventStore() });
  core.start();
  assert.deepEqual(enabledProviders(core.state.settings), ['claude', 'codex'], 'older settings: every one');
  core.setSettings({ providers: ['codex', 'gemini' as never] });
  assert.deepEqual(core.state.settings.providers, ['codex']);
  core.setSettings({ providers: [] });
  assert.deepEqual(core.state.settings.providers, ['codex'], 'turning off the last one is refused');
  core.setSettings({ providers: ['codex', 'claude'] });
  assert.deepEqual(core.state.settings.providers, ['claude', 'codex'], 'kept in their own order');
  const before = core.state.settings;
  assert.deepEqual(core.setSettings({ providers: ['claude', 'codex'] }), before);
});
