import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/index.ts';
import type { JsonRpcStdio } from '../src/jsonrpc.ts';

test('Codex sends changed effort on the same thread, inherits it later, and rolls back a refused change', async () => {
  const adapter = new CodexAdapter(new Proxy({}, { get: () => () => {} }) as never);
  const turns: Record<string, any>[] = [];
  let refuse = false;
  const rpc = { request: async (method: string, params: Record<string, any>) => {
    if (method === 'thread/start') return { thread: { id: 'same-thread' }, model: 'same-model' };
    assert.equal(method, 'turn/start');
    turns.push(params);
    if (refuse) throw new Error('refused');
    return { turn: { id: `turn-${turns.length}` } };
  } };
  const internals = adapter as unknown as { starting: Promise<JsonRpcStdio>; rpc: JsonRpcStdio };
  internals.starting = Promise.resolve(rpc as unknown as JsonRpcStdio);
  internals.rpc = rpc as unknown as JsonRpcStdio;
  await adapter.startSession({ sessionId: 'work', cwd: process.cwd(), prompt: 'first', model: 'same-model', effort: 'medium' });
  await adapter.sendMessage('work', 'second', { effort: 'high' });
  await adapter.sendMessage('work', 'third');
  refuse = true;
  await assert.rejects(adapter.sendMessage('work', 'refused', { effort: 'low' }), /refused/);
  refuse = false;
  await adapter.sendMessage('work', 'again');
  assert.deepEqual(turns.map((p) => p.effort), ['medium', 'high', 'high', 'low', 'high']);
  assert.ok(turns.every((p) => p.threadId === 'same-thread'));
  assert.ok(turns.every((p) => !('model' in p)), 'follow-ups do not override the model');
});
