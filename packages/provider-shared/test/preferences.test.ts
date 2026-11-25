import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreferenceReader } from '../src/preferences.ts';

const common = { domains: [{ id: 'writing', name: '文章', description: '文章の書き方' }], entries: [{ id: 'old', domainId: 'writing', text: '短く書く', scope: 'all' }], otherDomainId: 'other' };

test('both preference jobs pass the selected model and effort to their transport and validate the answer', async () => {
  const calls: unknown[][] = [];
  const reader = new PreferenceReader(async (...args) => {
    calls.push(args);
    return JSON.stringify({ reply: '記録しました', newDomains: [{ key: 'n', name: '確認', description: '確認するもの' }], add: [{ domain: 'n', text: '境界値を試す', scope: 'p' }, { domain: 'unknown', text: '結論から書く', scope: 'unknown' }], update: [{ id: 'old', domain: 'writing', text: '理由を添えて短く書く' }, { id: 'unknown', text: 'bad' }], remove: ['unknown', 'old', 'old'], reinforce: ['old', 'unknown'] });
  });
  const ai = { model: 'chosen-model', effort: 'high' };
  const extracted = await reader.extractPreferences({ ...common, human: '境界値を試して', agentBefore: '', canAddDomain: true }, ai);
  assert.deepEqual(extracted?.reinforce, ['old']);
  assert.deepEqual(extracted?.add.map((a) => [a.domainId, a.scope]), [['n', 'all'], ['other', 'all']]);
  const tuned = await reader.tunePreferences({ ...common, message: 'こだわりを整理して', history: [], projects: [{ id: 'p', name: 'プロジェクト' }], domainsLeft: 1 }, ai);
  assert.deepEqual(tuned?.add.map((a) => [a.domainId, a.scope]), [['n', 'p'], ['other', 'all']]);
  assert.equal(tuned?.update.length, 1);
  assert.deepEqual(tuned?.remove, ['old']);
  assert.deepEqual(tuned?.reinforce, ['old']);
  assert.deepEqual(calls.map((c) => c[0]), [ai, ai]);
  assert.deepEqual(calls.map((c) => c[3]), [60_000, 180_000]);
});

test('unreadable preference responses return null without changes', async () => {
  const reader = new PreferenceReader(async () => 'not json');
  assert.equal(await reader.extractPreferences({ ...common, human: '説明して', agentBefore: '', canAddDomain: false }), null);
  assert.equal(await reader.tunePreferences({ ...common, message: '説明して', history: [], projects: [], domainsLeft: 0 }), null);
});

test('both readers see full section prompts and ask for one reusable prompt per section', async () => {
  const calls: string[][] = [];
  const original = '方針'.repeat(2700) + '\n末尾にある重要な条件';
  const reader = new PreferenceReader(async (_choice, prompt, system) => {
    calls.push([prompt, system]);
    return JSON.stringify({ update: [{ id: 'old', text: original + '\n新しい条件' }, { id: 'unknown', text: '不正' }] });
  });
  const entries = [{ id: 'old', domainId: 'writing', text: original, scope: 'all' }];
  const reading = await reader.extractPreferences({ ...common, entries, human: '新しい条件も守って', agentBefore: '', canAddDomain: false });
  await reader.tunePreferences({ ...common, entries, message: '新しい条件も守って', history: [], projects: [], domainsLeft: 0 });
  assert.equal(reading?.update?.length, 1);
  assert.equal(reading?.update?.[0]?.text, original + '\n新しい条件');
  for (const [prompt, system] of calls) {
    const record = JSON.parse(prompt.split('<記録済み>\n')[1]!.split('\n</記録済み>')[0]!);
    assert.equal(record[0].text, original, 'even the tail beyond 5,000 characters is needed when rewriting');
    assert.ok(system.includes('各セクションにつき一つのプロンプト'));
    assert.ok(system.includes('5000字'));
    assert.ok(system.includes('通常は "all"'));
  }
});
