// Voice input: what a helper model answers is only ever a proposal. Whatever it says, each piece of work that comes
// out names a workspace that exists, an agent that is signed in, a model that agent offers and an effort it accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_LIMITS, VoicePlanner } from '../src/voice-plan.ts';
import type { VoicePlanInput } from '../src/voice-plan.ts';

const input: VoicePlanInput = {
  transcript: 'オーラリーのバグを直して、それとレジャーのテストを足して、こっちはコーデックスで',
  projects: [
    { id: 'p1', name: 'orrery', path: 'C:\\work\\orrery', description: 'エージェントを並行して動かす\nデスクトップアプリ', recent: ['ホーム画面の修正'], usual: { provider: 'claude', model: 'sonnet' } },
    { id: 'p2', name: 'ledger', path: 'C:\\work\\ledger', description: '', recent: [], usual: null },
  ],
  agents: [
    { provider: 'claude', models: [{ id: 'opus', label: 'Opus', description: '', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'medium' }, { id: 'sonnet', label: 'Sonnet', description: '', efforts: ['low', 'high'], isDefault: false, defaultEffort: 'high' }] },
    { provider: 'codex', models: [{ id: 'gpt', label: 'GPT', description: '', efforts: [], isDefault: true, defaultEffort: null }] },
  ],
  sessions: [{ id: 's1', title: 'READMEの更新', projectId: 'p1', provider: 'codex', state: '返答済み', last: 'どちらの書き方にしますか？' }],
  defaultProjectId: 'p2',
};

test('one spoken request becomes several pieces of work, asked of the chosen planner model', async () => {
  const calls: unknown[][] = [];
  const planner = new VoicePlanner(async (...args) => {
    calls.push(args);
    return `はい。${JSON.stringify({ tasks: [
      { project: 'p1', agent: 'claude', model: 'opus', effort: 'high', prompt: ' バグを直して ' },
      { project: 'p2', agent: 'codex', model: 'gpt', effort: 'high', prompt: 'テストを足して' },
    ] })}`;
  });
  const ai = { model: 'chosen', effort: 'low' };
  const r = await planner.plan(input, ai);
  assert.deepEqual(r?.tasks, [
    { sessionId: '', projectId: 'p1', provider: 'claude', model: 'opus', effort: 'high', prompt: 'バグを直して' },
    { sessionId: '', projectId: 'p2', provider: 'codex', model: 'gpt', effort: '', prompt: 'テストを足して' }, // this model takes no effort
  ]);
  assert.equal(calls[0]![0], ai, 'the planner is the model the human chose');
  const shown = String(calls[0]![1]);
  for (const word of ['p1: orrery', '説明: エージェントを並行して動かす デスクトップアプリ', 'ホーム画面の修正', 'ふだん使うAI: claude sonnet', 'gpt: GPT', input.transcript]) assert.ok(shown.includes(word), `the planner is shown: ${word}`);
  assert.ok(!/p2: ledger[^\n]*説明:/.test(shown), 'a workspace with no description is shown without one');
});

test('anything the planner makes up falls back to what exists', async () => {
  const planner = new VoicePlanner(async () => JSON.stringify({ tasks: [
    { project: 'nowhere', agent: 'gemini', model: 'ultra', effort: 'max', prompt: 'a' }, // -> last-used workspace, its agent's default
    { project: 'p1', agent: 'claude', model: 'ultra', effort: 'medium', prompt: 'b' }, // -> the workspace's usual model, its middle effort
    { project: 'p1', agent: 'codex', prompt: 'c' },
    { project: 'p1', agent: 'claude', model: 'opus', effort: 'low', prompt: '   ' }, // no request: dropped
    'nonsense',
  ] }));
  const r = await planner.plan(input);
  assert.deepEqual(r?.tasks, [
    { sessionId: '', projectId: 'p2', provider: 'claude', model: 'opus', effort: 'medium', prompt: 'a' },
    { sessionId: '', projectId: 'p1', provider: 'claude', model: 'sonnet', effort: 'high', prompt: 'b' },
    { sessionId: '', projectId: 'p1', provider: 'codex', model: 'gpt', effort: '', prompt: 'c' },
  ]);
});

test('Claude work is Opus by default and Sonnet for tiny edits; Fable is never reached by a fallback', async () => {
  const fable = { id: 'claude-fable-5-2', label: 'Fable 5.2', description: '', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'medium' };
  const opus = { id: 'opus', label: 'Opus 5.5', description: '', efforts: ['low', 'medium', 'high'], isDefault: false, defaultEffort: 'medium' };
  const sonnet = { id: 'sonnet', label: 'Sonnet 5.5', description: '', efforts: ['low', 'medium', 'high'], isDefault: false, defaultEffort: 'medium' };
  const withFable: VoicePlanInput = {
    ...input,
    projects: [{ id: 'p1', name: 'orrery', path: 'C:\\work\\orrery', description: '', recent: [], usual: { provider: 'claude', model: 'claude-fable-5-2' } }],
    agents: [{ provider: 'claude', models: [fable, opus, sonnet] }],
    defaultProjectId: 'p1',
  };
  let shown = '';
  const planner = new VoicePlanner(async (_c, prompt, system) => {
    shown = `${prompt}\n${system}`;
    return JSON.stringify({ tasks: [
      { project: 'p1', agent: 'claude', model: 'made-up', prompt: 'a' }, // unknown model, usual and default are Fable -> Opus
      { project: 'p1', agent: 'claude', model: 'claude-fable-5-2', effort: 'high', prompt: 'b' }, // the planner judged it very large: kept
    ] });
  });
  const r = await planner.plan(withFable);
  assert.deepEqual(r?.tasks.map((t) => t.model), ['opus', 'claude-fable-5-2']);
  for (const word of ['Claudeのモデルの選び方', 'Sonnet: ほんとうに細かい改善だけ', '迷ったらOpus', 'Fable: よほどのことがない限り使わない']) assert.ok(shown.includes(word), `the planner is told: ${word}`);
  const onlyFable = await new VoicePlanner(async () => JSON.stringify({ tasks: [{ project: 'p1', agent: 'claude', prompt: 'c' }] })).plan({ ...withFable, agents: [{ provider: 'claude', models: [fable] }] });
  assert.equal(onlyFable?.tasks[0]?.model, 'claude-fable-5-2', 'Fable is still used when it is the only model offered');
});

test('an agent whose models are not known is still usable with its own default, and the number of tasks is bounded', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ project: 'p1', agent: 'codex', model: 'x', effort: 'high', prompt: `t${i}` }));
  const planner = new VoicePlanner(async () => JSON.stringify({ tasks: many }));
  const r = await planner.plan({ ...input, agents: [{ provider: 'codex', models: [] }] });
  assert.equal(r?.tasks.length, VOICE_LIMITS.tasks);
  assert.deepEqual(r?.tasks[0], { sessionId: '', projectId: 'p1', provider: 'codex', model: '', effort: '', prompt: 't0' });
});

test('an answer that is not the plan asked for is no plan', async () => {
  assert.equal(await new VoicePlanner(async () => null).plan(input), null);
  assert.equal(await new VoicePlanner(async () => 'すみません、分かりません').plan(input), null);
  assert.equal(await new VoicePlanner(async () => '{"tasks": "none"}').plan(input), null);
  assert.deepEqual(await new VoicePlanner(async () => '{"tasks": []}').plan(input), { tasks: [] });
});

test('words that answer work already going on become a reply to it; a reply to work that does not exist is new work', async () => {
  const calls: unknown[][] = [];
  const planner = new VoicePlanner(async (...args) => (calls.push(args), JSON.stringify({ tasks: [
    { reply: 's1', prompt: '短い方で' },
    { project: 'p2', agent: 'claude', model: 'opus', effort: 'low', prompt: 'テストを足して' },
    { reply: 's1', prompt: '見出しも直して' }, // the same work twice: one message
    { reply: 'gone', project: 'p1', agent: 'claude', model: 'opus', effort: 'low', prompt: 'c' },
  ] })));
  const r = await planner.plan(input);
  assert.deepEqual(r?.tasks, [
    // A reply keeps the work's own workspace and agent: what it would start with if turned into new work.
    { sessionId: 's1', projectId: 'p1', provider: 'codex', model: 'gpt', effort: '', prompt: '短い方で\n見出しも直して' },
    { sessionId: '', projectId: 'p2', provider: 'claude', model: 'opus', effort: 'low', prompt: 'テストを足して' },
    { sessionId: '', projectId: 'p1', provider: 'claude', model: 'opus', effort: 'low', prompt: 'c' },
  ]);
  const shown = String(calls[0]![1]);
  for (const word of ['<進行中の作業>', 's1: READMEの更新', '返答済み', 'どちらの書き方にしますか？']) assert.ok(shown.includes(word), `the planner is shown: ${word}`);
  await new VoicePlanner(async (...args) => (calls.push(args), '{"tasks": []}')).plan({ ...input, sessions: [] });
  assert.ok(!String(calls[1]![1]).includes('<進行中の作業>'), 'no open work, no section');
});
