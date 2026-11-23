// The pull request each session works on, and "done" from the top of the work at any time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore } from '#core';
import { PullRequests } from '../src/application/pull-requests.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { Sessions } from '../src/application/sessions.ts';

function setup() {
  const core = new ControlCore({ store: new MemoryEventStore() } as never);
  core.start();
  let notified = 0;
  const rt = { core, closing: false, notify: () => void notified++, store: { agentWrote: () => false }, adapters: {} } as unknown as Runtime;
  const projectId = core.addProject('p', 'C:\\repo');
  const s = core.createSession({ projectId, provider: 'claude', title: 't', cwd: 'C:\\repo\\wt' });
  return { core, rt, s, notified: () => notified };
}

test('the pull request of a session is looked up on its branch and shown', async () => {
  const { core, rt, s, notified } = setup();
  const asked: [string, string | null][] = [];
  let removed = false;
  const workspaces = { view: () => ({ path: 'C:\\repo\\wt', branch: 'orrery/t', removed, keptBranch: true }) };
  const prs = new PullRequests(rt, workspaces as never, async (cwd, branch) => (asked.push([cwd, branch]), { number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', draft: false, title: 'x' }));
  assert.equal(prs.view(s.id), null);
  await prs.tick(1);
  assert.deepEqual(asked, [['C:\\repo\\wt', 'orrery/t']]);
  assert.equal(prs.view(s.id)?.number, 42);
  assert.equal(notified(), 1);
  await prs.tick(2);
  assert.equal(asked.length, 1, 'not asked again until something changes or time passes');
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  removed = true;
  await prs.tick(Date.now() + 1);
  assert.deepEqual(asked[1], ['C:\\repo', 'orrery/t'], 'a removed worktree is asked about from the project folder');
  assert.equal(notified(), 1, 'the same answer does not redraw');
});

test('done can be said while the agent is still on it: the agent is stopped first', async () => {
  const { core, rt, s } = setup();
  core.sessionUpdate(s.id, { process: 'alive', lifecycle: 'running' });
  assert.equal(core.setAccepted(s.id, true).ok, false, 'the core never accepts work an agent is holding');
  const interrupted: string[] = [];
  (rt as { adapters: unknown }).adapters = { claude: { interrupt: async (id: string) => (interrupted.push(id), core.sessionUpdate(id, { lifecycle: 'interrupted' })), isLive: () => false } };
  const sessions = new Sessions(rt, { scheduler: { cancel: () => false }, secrets: { redact: (x: string) => x }, journal: { write: () => {} }, workspaces: { remove: async () => {} } } as never);
  await sessions.setAccepted(s.id, true);
  assert.deepEqual(interrupted, [s.id]);
  assert.notEqual(core.state.tasks.get(s.taskId)!.acceptedAt, null);
  assert.equal(core.state.sessions.get(s.id)!.archived, true);
});
