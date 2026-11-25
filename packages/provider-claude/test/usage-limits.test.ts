import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderSink, UsageLimit } from '#core';
import { ClaudeAdapter } from '../src/index.ts';
const sink = (methods: Partial<ProviderSink>) => methods as ProviderSink;

test('Claude forwards subscription windows as they arrive, including model scope and seconds-to-ms conversion', () => {
  const seen: UsageLimit[][] = [];
  const adapter = new ClaudeAdapter(sink({ usageLimits: (_p, limits) => { seen.push(limits); } }));
  const reset = Math.floor(Date.now() / 1000) + 3600;
  adapter['noteRateLimit']({ rateLimitType: 'seven_day_opus', status: 'rejected', resetsAt: reset });
  assert.deepEqual(seen[0], [{ label: '週間枠（Opus）', model: 'opus', kind: 'other', usedPercent: null, resetsAt: reset * 1000, state: 'reached' }]);
  adapter['noteRateLimit']({ rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.9, resetsAt: reset * 1000 });
  assert.equal(seen[1][1].model, null); assert.equal(seen[1][1].usedPercent, 90);
  assert.equal(seen[1][1].resetsAt, reset * 1000);
});
