import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../src/index.ts';

test('Claude applies a session-only effort overlay before delivering the next prompt, without changing model', async () => {
  const adapter = new ClaudeAdapter(new Proxy({}, { get: () => () => {} }) as never);
  const calls: unknown[] = [];
  let applied = false;
  let release!: () => void;
  const live = {
    effort: 'medium',
    query: { applyFlagSettings: async (settings: unknown) => {
      calls.push(settings);
      await new Promise<void>((resolve) => { release = resolve; });
      applied = true;
    } },
    push: (text: string) => { assert.equal(applied, true); calls.push(text); },
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('work', live);
  const sending = adapter.sendMessage('work', 'more', { effort: 'high' });
  assert.deepEqual(calls, [{ effortLevel: 'high' }], 'the prompt waits for the overlay acknowledgement');
  release();
  await sending;
  await adapter.sendMessage('work', 'same', { effort: 'high' });
  assert.deepEqual(calls, [{ effortLevel: 'high' }, 'more', 'same']);
  assert.equal(live.effort, 'high');
});

test('a refused Claude effort overlay delivers no prompt and keeps the previous effort', async () => {
  const adapter = new ClaudeAdapter(new Proxy({}, { get: () => () => {} }) as never);
  const live = {
    effort: 'medium',
    query: { applyFlagSettings: async () => { throw new Error('refused'); } },
    push: () => assert.fail('must not send with the wrong effort'),
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('work', live);
  await assert.rejects(adapter.sendMessage('work', 'more', { effort: 'high' }), /refused/);
  assert.equal(live.effort, 'medium');
});
