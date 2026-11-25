// A step's command run from Orrery: its output is read, and the human's list says what is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore } from '#core';
import { Assistant } from '../src/application/assistant.ts';
import type { CommandReading } from '../src/application/assistant.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { Sessions } from '../src/application/sessions.ts';

function setup(reading: CommandReading | null) {
  const core = new ControlCore({ store: new MemoryEventStore() } as never);
  core.start();
  const rt = { core, closing: false, notify: () => {}, store: { agentWrote: () => false }, adapters: {} } as unknown as Runtime;
  const seen: { output: string; laterSteps: string[] }[] = [];
  const assistant = new Assistant(rt, {
    generateTitle: async () => null,
    readFinalReply: async () => null,
    clarifyChecks: async () => null,
    extractPreferences: async () => null,
    routeKnowledge: async () => null,
    tunePreferences: async () => null,
    readCommandResult: async (x) => (seen.push({ output: x.output, laterSteps: x.laterSteps }), reading),
  });
  const accepted: string[] = [];
  const sessions = new Sessions(rt, { secrets: { redact: (x: string) => x, envFor: () => ({}) }, journal: { write: () => {} }, assistant } as never);
  (sessions as unknown as { setAccepted: (id: string) => Promise<void> }).setAccepted = async (id) => void accepted.push(id);
  const projectId = core.addProject('p', process.cwd());
  const s = core.createSession({ projectId, provider: 'claude', title: 't' });
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  core.sessionUpdate(s.id, { lifecycle: 'turn_finished', lastText: 'x' });
  const steps = () => core.state.tasks.get(s.taskId)!.humanSteps!;
  return { core, sessions, id: s.id, steps, seen, accepted };
}

test('a command that ran but left work: the step is replaced by what is left, and nothing is put away', async () => {
  const t = setup({ done: false, note: '承認が必要', steps: [{ title: 'ターミナルで承認する', detail: null, command: null, after: null }] });
  t.core.setHumanSteps(t.id, [{ title: '本番へ出す', detail: null, command: 'node -e "console.log(42)"' }, { title: '確認する', detail: null, command: null }]);
  const r = await t.sessions.runForHuman(t.id, 'node -e "console.log(42)"', 'run-abc123');
  assert.equal(r.ok, true);
  assert.match(t.seen[0]!.output, /42/, 'the model read the real output');
  assert.deepEqual(t.seen[0]!.laterSteps, ['確認する']);
  assert.deepEqual(r.step, { done: false, note: '承認が必要', completed: false });
  assert.deepEqual(t.steps().map((x) => x.title), ['ターミナルで承認する', '確認する']);
  assert.equal(t.steps()[0]!.run!.phase, 'settled');
  assert.deepEqual(t.accepted, []);
});

test('the last step done by its command finishes the work; without the model, the exit code decides', async () => {
  const t = setup(null);
  t.core.setHumanSteps(t.id, [{ title: 'run', detail: null, command: 'node -e "0"' }]);
  const r = await t.sessions.runForHuman(t.id, 'node -e "0"');
  assert.equal(r.step!.done, true);
  assert.equal(r.step!.completed, true);
  assert.deepEqual(t.accepted, [t.id]);
});
