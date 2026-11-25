import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderSink } from '#core';
import { CodexAdapter } from '../src/index.ts';
import { codexUsageLimits } from '../src/usage-limits.ts';

const primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 };
const sink = (methods: Partial<ProviderSink>) => methods as ProviderSink;

test('Codex parses legacy and model-specific windows and preserves a shared bucket', () => {
  const limits = codexUsageLimits({
    rateLimits: { primary },
    rateLimitsByLimitId: {
      codex: { primary },
      model_quota: { normalModelSlug: 'gpt-test', secondary: { ...primary, windowDurationMins: 10080 } },
    },
  });
  assert.equal(limits.length, 2);
  assert.deepEqual(limits[0], { label: '5時間枠', kind: 'five_hour', model: null, usedPercent: 100, resetsAt: 1_800_000_000_000, state: 'reached' });
  assert.equal(limits[1].model, 'gpt-test'); assert.equal(limits[1].kind, 'weekly');
  assert.equal(codexUsageLimits({ rateLimits: { primary: { ...primary, usedPercent: 99.9 } } })[0].state, 'warning');
  assert.equal(codexUsageLimits({ rateLimits: { primary: { ...primary, resetsAt: null } } })[0].resetsAt, null);
});

test('account limit notifications are forwarded even though they carry no thread id', () => {
  const seen: unknown[] = [];
  const adapter = new CodexAdapter(sink({ usageLimits: (p, limits) => { seen.push({ p, limits }); } }));
  adapter['onNotification']({ method: 'account/rateLimits/updated', params: { rateLimits: { primary } } });
  assert.deepEqual(seen, [{ p: 'codex', limits: codexUsageLimits({ rateLimits: { primary } }) }]);
});

test('a failed usage-limited Codex turn marks its session before reporting the terminal lifecycle', async () => {
  const seen: string[] = [];
  const adapter = new CodexAdapter(sink({
    sessionUpdate: (_id, patch) => { if (patch.lifecycle) seen.push(patch.lifecycle); },
    transcript: () => {},
    usageBlocked: (id) => seen.push(`blocked:${id}`),
  }));
  // Fake the official RPC peer, so this test uses the real adapter without launching a binary or spending tokens.
  const rpc = { request: async (method: string) => method === 'thread/start' ? { thread: { id: 'thread' }, model: 'gpt-test' } : { turn: { id: 'turn' } } };
  adapter['rpc'] = rpc as never;
  adapter['starting'] = Promise.resolve(rpc as never);
  await adapter.startSession({ sessionId: 'work', cwd: '.', prompt: 'do it' });
  seen.length = 0;
  adapter['onNotification']({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'limit hit' } } } });
  assert.deepEqual(seen, ['blocked:work', 'error']);
  seen.length = 0;
  adapter['onNotification']({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'failed', error: { codexErrorInfo: 'contextWindowExceeded' } } } });
  assert.deepEqual(seen, ['error'], 'a full context window is not a plan limit with a reset');
});
