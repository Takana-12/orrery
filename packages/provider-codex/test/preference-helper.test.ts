import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexPreferenceHelper } from '../src/preference-helper.ts';
import type { JsonRpcStdio } from '../src/jsonrpc.ts';

function world(threadStart?: () => Promise<{ thread: { id: string } }>) {
  const calls: { method: string; params: any }[] = [];
  let ready!: () => void;
  const turning = new Promise<void>((done) => { ready = done; });
  const rpc = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'config/read') return { config: { mcp_servers: { existing: { command: 'unused' } }, plugins: { existing: { enabled: true } } } };
      if (method === 'thread/start') return threadStart ? threadStart() : { thread: { id: 'helper' } };
      if (method === 'turn/start') { ready(); return { turn: { id: 'turn' } }; }
      return {};
    },
  } as Pick<JsonRpcStdio, 'request'>;
  return { helper: new CodexPreferenceHelper(async () => rpc), calls, turning };
}

test('Codex preference reads use the selected model and effort in an isolated, non-persistent thread', async () => {
  const { helper, calls, turning } = world();
  const reading = helper.ask({ model: 'gpt-test', effort: 'high' }, 'human words', 'read preferences only', 1000);
  await turning;
  const thread = calls.find((c) => c.method === 'thread/start')!.params;
  assert.equal(thread.model, 'gpt-test');
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.sandbox, 'read-only');
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(thread.selectedCapabilityRoots, []);
  assert.equal(thread.baseInstructions, 'read preferences only');
  assert.equal(thread.config.project_doc_max_bytes, 0);
  assert.deepEqual(thread.config.mcp_servers, { existing: { enabled: false } });
  assert.deepEqual(thread.config.plugins, { existing: { enabled: false }, _default: { enabled: false } });
  const turn = calls.find((c) => c.method === 'turn/start')!.params;
  assert.equal(turn.effort, 'high');
  assert.equal(turn.input[0].text, 'human words');
  assert.equal(helper.owns('helper'), true);
  assert.equal(helper.onNotification({ method: 'turn/completed', params: { threadId: 'work', turn: { status: 'completed' } } }), false);
  helper.onNotification({ method: 'item/completed', params: { threadId: 'helper', item: { type: 'agentMessage', phase: 'commentary', text: 'thinking' } } });
  helper.onNotification({ method: 'item/completed', params: { threadId: 'helper', item: { type: 'agentMessage', text: '{"add":[]}' } } });
  helper.onNotification({ method: 'turn/completed', params: { threadId: 'helper', turn: { status: 'completed' } } });
  assert.equal(await reading, '{"add":[]}');
  assert.equal(helper.owns('helper'), false);
  assert.ok(calls.some((c) => c.method === 'thread/unsubscribe'));
  assert.ok(!calls.some((c) => c.method === 'turn/interrupt'), 'a completed reading needs no interruption');
});

test('choosing Codex defaults omits model and effort overrides; failed readings return null', async () => {
  const { helper, calls, turning } = world();
  const reading = helper.ask({ model: '', effort: '' }, 'words', 'instructions', 1000);
  await turning;
  assert.equal('model' in calls.find((c) => c.method === 'thread/start')!.params, false);
  assert.equal('effort' in calls.find((c) => c.method === 'turn/start')!.params, false);
  helper.onNotification({ method: 'turn/completed', params: { threadId: 'helper', turn: { status: 'failed' } } });
  assert.equal(await reading, null);
});

test('timed-out preference readings interrupt their turn and release the ephemeral thread', async () => {
  const { helper, calls, turning } = world();
  const reading = helper.ask({ model: '', effort: '' }, 'words', 'instructions', 20);
  await turning;
  assert.equal(await reading, null);
  assert.ok(calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'turn'));
  assert.ok(calls.some((c) => c.method === 'thread/unsubscribe'));
  assert.equal(helper.owns('helper'), false);
});

test('a thread created after timeout is released without starting a model turn', async () => {
  let release!: (v: { thread: { id: string } }) => void;
  const gate = new Promise<{ thread: { id: string } }>((done) => { release = done; });
  const { helper, calls } = world(() => gate);
  assert.equal(await helper.ask({ model: '', effort: '' }, 'words', 'instructions', 10), null);
  release({ thread: { id: 'late' } });
  await new Promise((done) => setImmediate(done));
  assert.ok(!calls.some((c) => c.method === 'turn/start'));
  assert.ok(calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'late'));
});

test('provider shutdown cancels pending preference readings', async () => {
  const { helper, turning } = world();
  const reading = helper.ask({ model: '', effort: '' }, 'words', 'instructions', 1000);
  await turning;
  helper.cancelAll();
  assert.equal(await reading, null);
  assert.equal(helper.owns('helper'), false);
});
