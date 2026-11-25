import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../src/index.ts';

test('Claude preference jobs forward the chosen model and effort to the tool-free helper', async () => {
  const adapter = new ClaudeAdapter({} as never);
  const calls: unknown[][] = [];
  (adapter as unknown as { askHelper: (...args: unknown[]) => Promise<string> }).askHelper = async (...args) => {
    calls.push(args);
    return '{"reply":"記録しました","add":[]}';
  };
  const domains = [{ id: 'writing', name: '文章', description: '文章の書き方' }];
  const choice = { model: 'opus', effort: 'high' };
  await adapter.extractPreferences({ human: '説明は短く', agentBefore: '', domains, entries: [], otherDomainId: 'other', canAddDomain: false }, choice);
  await adapter.tunePreferences({ message: '説明は短く', history: [], domains, entries: [], projects: [], otherDomainId: 'other', domainsLeft: 0 }, choice);
  assert.deepEqual(calls.map((c) => [c[0], c[5]]), [['opus', 'high'], ['opus', 'high']]);
  await adapter.extractPreferences({ human: '説明は短く', agentBefore: '', domains, entries: [], otherDomainId: 'other', canAddDomain: false }, { model: '', effort: '' });
  assert.deepEqual([calls[2]![0], calls[2]![5]], ['', ''], 'an explicit default does not restore the old hard-coded model');
});
