// The human's standing preferences: picked up from what they say, and sent with new work. A scripted model stands in
// for the helper model, and a recording adapter for the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore, KNOWLEDGE_HEADING } from '#core';
import type { ProviderAdapter, StartSessionRequest } from '#core';
import { Assistant } from '../src/application/assistant.ts';
import type { AssistantModel, PreferenceModel, PreferenceReading, TuneInput, TuneReading } from '../src/application/assistant.ts';
import type { PreferenceModelChoice } from '../../provider-shared/src/preferences.ts';
import { Knowledge } from '../src/application/knowledge.ts';
import { KnowledgeTune, TUNE_LOG_ID } from '../src/application/knowledge-tune.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { Sessions } from '../src/application/sessions.ts';

type Extract = Parameters<AssistantModel['extractPreferences']>[0];

function world(opts: { extract?: (x: Extract) => PreferenceReading | null; route?: (domains: string[]) => Promise<string[] | null>; tune?: (x: TuneInput) => TuneReading | null; codex?: PreferenceModel } = {}) {
  const core = new ControlCore({ store: new MemoryEventStore() } as never);
  core.start();
  const started: StartSessionRequest[] = [];
  const journal: { id: string; text: string }[] = [];
  const asked: Extract[] = [];
  const replies = new Map<string, string>();
  const adapter = { startSession: async (req: StartSessionRequest) => void started.push(req), isLive: () => true, sendMessage: async () => {} } as unknown as ProviderAdapter;
  const log: { seq: number; at: number; session_id: string; role: string; text: string }[] = [];
  const store = {
    turnReplies: (id: string) => replies.get(id) ?? '',
    appendTranscript: (id: string, role: string, text: string) => void log.push({ seq: log.length + 1, at: Date.now(), session_id: id, role, text }),
    readTranscript: (id: string, limit: number) => log.filter((r) => r.session_id === id).slice(-limit),
  };
  const tuned: TuneInput[] = [];
  const askedAi: (PreferenceModelChoice | undefined)[] = [];
  const tunedAi: (PreferenceModelChoice | undefined)[] = [];
  const rt = { core, closing: false, notify: () => {}, store, adapters: { claude: adapter, codex: adapter } } as unknown as Runtime;
  const model: AssistantModel = {
    generateTitle: async () => null,
    readFinalReply: async () => null,
    readCommandResult: async () => null,
    clarifyChecks: async () => null,
    extractPreferences: async (x, ai) => (asked.push(x), askedAi.push(ai), opts.extract ? opts.extract(x) : null),
    routeKnowledge: async (x) => (opts.route ? opts.route(x.domains.map((d) => d.id)) : null),
    tunePreferences: async (x, ai) => (tuned.push(x), tunedAi.push(ai), opts.tune ? opts.tune(x) : null),
  };
  const assistant = new Assistant(rt, model, { claude: model, ...(opts.codex ? { codex: opts.codex } : {}) });
  const write = (id: string, _role: string, text: string) => void journal.push({ id, text });
  const knowledge = new Knowledge(rt, { write } as never, assistant, (x) => x, 30);
  const tune = () => new KnowledgeTune(rt, knowledge, assistant, (x) => x.replace('SECRET', '***'));
  const scheduler = { enqueue: (_id: string, run: () => Promise<void>) => void run(), pump: () => {}, cancel: () => false };
  const sessions = new Sessions(rt, { scheduler, secrets: { redact: (x: string) => x, envFor: () => ({}) }, journal: { write }, workspaces: { reopen: async () => {} }, assistant, knowledge, attachmentsDir: 'C:\\att' } as never);
  const projectId = core.addProject('p', 'C:\\work\\p');
  const start = async (prompt: string) => {
    const id = await sessions.start({ projectId, provider: 'claude', prompt, title: 't', worktree: false });
    await settle();
    return id;
  };
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 2));
  };
  return { core, sessions, knowledge, assistant, started, journal, asked, askedAi, replies, projectId, start, settle, tune, tuned, tunedAi, log };
}

test('preference AI defaults remain Haiku for capture and Sonnet for the dedicated chat', async () => {
  const w = world();
  await w.start('画面を直して');
  const t = w.tune();
  t.send('説明は短くしてほしい');
  await w.settle();
  assert.deepEqual(w.askedAi[0], { provider: 'claude', model: 'haiku', effort: '' });
  assert.deepEqual(w.tunedAi[0], { provider: 'claude', model: 'sonnet', effort: '' });
});

test('capture and tune each use their selected provider, model and effort and record its changes', async () => {
  const codexCalls: { kind: string; ai: PreferenceModelChoice | undefined }[] = [];
  const w = world({ codex: {
    extractPreferences: async (_x, ai) => {
      codexCalls.push({ kind: 'capture', ai });
      return { newDomains: [], add: [{ domainId: 'writing', text: '報告は短くする', scope: 'all' }], reinforce: [] };
    },
    tunePreferences: async (_x, ai) => {
      codexCalls.push({ kind: 'tune', ai });
      return { reply: '記録しました', newDomains: [], add: [{ domainId: 'ui', text: 'ボタンは右に置く', scope: 'all' }], update: [], remove: [], reinforce: [] };
    },
  } });
  const codex = { provider: 'codex' as const, model: 'gpt-test', effort: 'high' };
  const claude = { provider: 'claude' as const, model: 'opus', effort: 'medium' };
  w.core.setSettings({ knowledge: { captureAi: codex, tuneAi: claude } as never });
  await w.start('作業を進めて');
  const t = w.tune();
  t.send('説明を短くして');
  await w.settle();
  assert.deepEqual(codexCalls, [{ kind: 'capture', ai: codex }]);
  assert.deepEqual(w.tunedAi[0], claude);
  w.core.setSettings({ knowledge: { captureAi: claude, tuneAi: codex } as never });
  await w.start('別の作業を進めて');
  t.send('ボタンは右に置いて');
  await w.settle();
  assert.deepEqual(w.askedAi[0], claude);
  assert.deepEqual(codexCalls.at(-1), { kind: 'tune', ai: codex });
  assert.deepEqual([...w.core.state.knowledge.entries.values()].map((e) => [e.text, e.seen]), [['報告は短くする', false], ['ボタンは右に置く', true]]);
});

test('queued preference readings keep the AI selected when the instruction or message was sent', async () => {
  const w = world();
  const id = await w.start('準備して');
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  w.assistant.queue(async () => { await gate; return null; }, () => {});
  const first = { provider: 'claude' as const, model: 'opus', effort: 'high' };
  const second = { provider: 'claude' as const, model: 'sonnet', effort: 'low' };
  w.core.setSettings({ knowledge: { captureAi: first, tuneAi: first } as never });
  w.knowledge.heard(id, '説明は結論から書いて');
  const t = w.tune();
  t.send('説明は短くして');
  w.core.setSettings({ knowledge: { captureAi: second, tuneAi: second } as never });
  t.send('理由も入れて');
  release();
  await w.settle();
  assert.deepEqual(w.askedAi.at(-1), first);
  assert.deepEqual(w.tunedAi, [first, second]);
});

test('an unavailable preference provider does not silently use Claude', async () => {
  const w = world();
  const codex = { provider: 'codex' as const, model: '', effort: '' };
  w.core.setSettings({ knowledge: { captureAi: codex, tuneAi: codex } as never });
  await w.start('新しい作業をして');
  const t = w.tune();
  t.send('説明は短くして');
  await w.settle();
  assert.equal(w.asked.length, 0);
  assert.equal(w.tuned.length, 0);
  assert.equal(t.view().messages.at(-1)!.failed, true);
  assert.equal(t.view().busy, false);
});

test('nothing recorded: the first message is exactly what it was before', async () => {
  const w = world();
  await w.start('ボタンを直して');
  assert.equal(w.started[0]!.prompt, 'ボタンを直して');
  assert.equal(w.started[0]!.shownPrompt, undefined);
  assert.equal(w.journal.filter((j) => j.text.includes('先頭に付けて')).length, 0);

  w.core.setSettings({ preamble: '日本語で' });
  await w.start('次の作業');
  assert.equal(w.started[1]!.prompt, '日本語で\n\n次の作業');
  assert.ok(w.journal.some((j) => j.text === '設定の「デフォルトメッセージ」を先頭に付けて送りました。'));
});

test('what the human says is read for preferences, recorded at once, and said in the record', async () => {
  const w = world({ extract: (x) => (x.human.includes('結論') ? { newDomains: [], add: [{ domainId: 'writing', text: '報告は結論から書く', scope: 'all' }], reinforce: [] } : null) });
  const id = await w.start('README を直して');
  w.replies.set(id, '長い説明……');
  await w.sessions.send(id, '報告は結論から書いて');
  await w.settle();
  assert.equal(w.asked.at(-1)!.agentBefore, '長い説明……', 'the reply it answers is read with it');
  const entries = [...w.core.state.knowledge.entries.values()];
  assert.deepEqual(entries.map((e) => [e.domainId, e.text, e.seen, e.sessionId]), [['writing', '報告は結論から書く', false, id]]);
  assert.ok(w.journal.some((j) => j.id === id && j.text.includes('こだわりを記録しました') && j.text.includes('[文章・言葉づかい] 報告は結論から書く')));

  // The same again is counted, not written twice.
  await w.sessions.send(id, 'だから結論からって言ってるでしょ');
  await w.settle();
  assert.equal(w.core.state.knowledge.entries.size, 1);
  assert.equal([...w.core.state.knowledge.entries.values()][0]!.hits, 2);
});

test('a preference already recorded is reinforced; turned off, nothing is read', async () => {
  const w = world({ extract: (x) => ({ newDomains: [], add: [], reinforce: x.entries.map((e) => e.id) }) });
  const id = w.core.addKnowledgeEntry({ domainId: 'ui', text: '即時のフィードバック' })!;
  const s = await w.start('画面を直して');
  assert.equal(w.core.state.knowledge.entries.get(id)!.hits, 2);
  w.core.setSettings({ knowledge: { capture: false, inject: true } });
  const before = w.asked.length;
  await w.sessions.send(s, 'もっと速く反応するように');
  await w.settle();
  assert.equal(w.asked.length, before);
});

test('a workspace with picking up turned off is not read, while the app-wide setting stays on', async () => {
  const w = world({ extract: () => ({ newDomains: [], add: [{ domainId: 'ui', text: '即時のフィードバック', scope: 'all' }], reinforce: [] }) });
  w.core.setProjectOptions(w.projectId, { captureKnowledge: false });
  const s = await w.start('画面を直して');
  await w.sessions.send(s, 'もっと速く反応するように');
  await w.settle();
  assert.equal(w.core.state.knowledge.entries.size, 0);
  w.core.setProjectOptions(w.projectId, { captureKnowledge: true });
  await w.sessions.send(s, 'もっと速く反応するように');
  await w.settle();
  assert.equal(w.core.state.knowledge.entries.size, 1);
});

test('a project preference stays in its project', async () => {
  const w = world({ extract: () => ({ newDomains: [], add: [{ domainId: 'ui', text: 'inbox から辿れるようにする', scope: 'project' }], reinforce: [] }) });
  await w.start('新しい状態を足して');
  const e = [...w.core.state.knowledge.entries.values()][0]!;
  assert.equal(e.scope, 'all');
  assert.ok(e.text.includes('プロジェクト「p」（C:\\work\\p）に限り、次の方針を適用する。'));
  assert.ok(e.text.endsWith('inbox から辿れるようにする'));
});

test('little recorded: all of it goes, after the default message, and the human\'s words are what the record shows', async () => {
  const w = world();
  w.core.setSettings({ preamble: '日本語で' });
  w.core.addKnowledgeEntry({ domainId: 'ui', text: '即時のフィードバック' });
  await w.start('ボタンを直して');
  const req = w.started[0]!;
  assert.equal(req.prompt, `日本語で\n\n${KNOWLEDGE_HEADING}\n### UI・操作感\n即時のフィードバック\n\nボタンを直して`);
  assert.equal(req.shownPrompt, 'ボタンを直して');
  assert.ok(w.journal.some((j) => j.text === '設定の「デフォルトメッセージ」とこだわり（UI・操作感）を先頭に付けて送りました。'));

  w.core.setSettings({ knowledge: { capture: true, inject: false } });
  await w.start('次');
  assert.equal(w.started[1]!.prompt, '日本語で\n\n次', 'turned off: none are sent');
});

function lots(w: ReturnType<typeof world>) {
  for (let i = 0; i < 20; i++) w.core.addKnowledgeEntry({ domainId: 'writing', text: `文章の規則 ${i} ${'あ'.repeat(80)}` });
  w.core.addKnowledgeEntry({ domainId: 'ui', text: 'UI の規則' });
  w.core.addKnowledgeEntry({ domainId: 'workflow', text: '新しいブランチで作業する' });
  w.core.setKnowledgeDomain({ id: 'workflow', always: true });
}

test('much recorded: only the areas chosen for the work go, with those always sent', async () => {
  const w = world({ route: async () => ['ui'] });
  lots(w);
  await w.start('ボタンの色');
  const p = w.started[0]!.prompt;
  assert.ok(p.includes('UI の規則') && p.includes('新しいブランチで作業する'));
  assert.ok(!p.includes('文章の規則'));
  assert.ok(w.journal.some((j) => j.text.includes('こだわり（UI・操作感、進め方・git・報告）')));
});

test('the choice takes too long or fails: the work goes with the areas always sent', async () => {
  const slow = world({ route: () => new Promise((r) => setTimeout(() => r(['ui']), 500)) });
  lots(slow);
  await slow.start('ボタンの色');
  await slow.settle();
  const p = slow.started[0]!.prompt;
  assert.ok(p.includes('新しいブランチで作業する') && !p.includes('UI の規則'));

  const failing = world({ route: async () => { throw new Error('no sign-in'); } });
  lots(failing);
  await failing.start('ボタンの色');
  assert.ok(failing.started[0]!.prompt.includes('新しいブランチで作業する'));
});

test('a refusal with a reason is read like an instruction', async () => {
  const w = world({ extract: () => null });
  const id = await w.start('作業');
  const n = w.asked.length;
  const itemId = w.core.attentionOpen({ sessionId: id, requestId: 'r1', type: 'permission_approval', summary: 'rm', approval: { tool: 'Bash', subject: 'rm -rf', cwd: null, reason: null, decisions: ['accept', 'decline'] }, reply: () => {} });
  w.sessions.answer(itemId, { kind: 'decision', decision: 'decline', message: '削除はゴミ箱に送る形にして' });
  await w.settle();
  assert.equal(w.asked.length, n + 1);
  assert.equal(w.asked.at(-1)!.human, '削除はゴミ箱に送る形にして');
});

test('a preference of a new kind goes into a new area the helper model names; nothing else makes one', async () => {
  const w = world({
    extract: (x) => ({
      newDomains: [{ key: 'n1', name: 'セキュリティ', description: '秘密情報や権限の扱い' }, { key: 'n2', name: '空の領域', description: '' }],
      add: [{ domainId: 'n1', text: '秘密情報はログに出さない', scope: 'all' }],
      reinforce: [],
    }),
  });
  const id = await w.start('ログを足して');
  assert.equal(w.asked[0]!.canAddDomain, true);
  const d = [...w.core.state.knowledge.domains.values()].find((x) => x.name === 'セキュリティ')!;
  assert.equal(d.description, '秘密情報や権限の扱い');
  assert.ok(![...w.core.state.knowledge.domains.values()].some((x) => x.name === '空の領域'), 'an area nothing goes into is not made');
  assert.deepEqual([...w.core.state.knowledge.entries.values()].map((e) => [e.domainId, e.text]), [[d.id, '秘密情報はログに出さない']]);
  assert.ok(w.journal.some((j) => j.id === id && j.text.includes('こだわりの領域を追加しました: 「セキュリティ」')));
});

test('the こだわり chat: a message is shown at once, then read into additions, rewrites, moves, removals and new areas', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const w = world({
    tune: (x) => {
      const old = x.entries.find((e) => e.text === '古い決まり')!;
      const dup = x.entries.find((e) => e.text === '重複')!;
      const keep = x.entries.find((e) => e.text === 'ボタンは右')!;
      return {
        reply: 'UI の決まりを書き直し、テスト方針の領域を作りました。',
        newDomains: [{ key: 'n1', name: 'テスト方針', description: 'テストの書き方' }],
        add: [{ domainId: 'n1', text: '境界値を必ず試す', scope: 'all' }, { domainId: 'workflow', text: 'ボタンは右', scope: 'all' }],
        update: [{ id: old.id, text: '新しい決まり', domainId: null }, { id: keep.id, text: null, domainId: 'workflow' }],
        remove: [dup.id],
        reinforce: [],
      };
    },
  });
  w.core.addKnowledgeEntry({ domainId: 'ui', text: '古い決まり' });
  w.core.addKnowledgeEntry({ domainId: 'other', text: '重複' });
  w.core.addKnowledgeEntry({ domainId: 'code', text: 'ボタンは右' });
  const t = w.tune();
  const model = (t as unknown as { assistant: { model: AssistantModel } }).assistant.model;
  const real = model.tunePreferences.bind(model);
  model.tunePreferences = async (x) => (await gate, real(x));

  t.send('  保存ボタンは右に置いて SECRET  ');
  assert.deepEqual(t.view().messages.map((m) => [m.role, m.text]), [['human', '保存ボタンは右に置いて SECRET']], 'shown at once, as written');
  assert.equal(t.view().busy, true);
  release();
  await w.settle();

  assert.equal(w.tuned[0]!.message, '保存ボタンは右に置いて ***', 'the helper model never sees a secret');
  const v = t.view();
  assert.equal(v.busy, false);
  const ai = v.messages.at(-1)!;
  assert.equal(ai.role, 'ai');
  assert.equal(ai.text, 'UI の決まりを書き直し、テスト方針の領域を作りました。');
  assert.deepEqual(ai.changes!.map((c) => [c.kind, c.domain, c.text]), [
    ['domain', 'テスト方針', 'テストの書き方'],
    ['remove', 'その他', '重複'],
    ['update', 'UI・操作感', '新しい決まり'],
    ['move', '進め方・git・報告', 'ボタンは右'],
    ['add', 'テスト方針', '境界値を必ず試す'],
    ['reinforce', '進め方・git・報告', 'ボタンは右'],
  ]);
  const texts = [...w.core.state.knowledge.entries.values()].map((e) => e.text).sort();
  assert.deepEqual(texts, ['ボタンは右', '境界値を必ず試す', '新しい決まり']);
  assert.ok([...w.core.state.knowledge.entries.values()].every((e) => e.seen), 'what the human watched being made is not news');

  // The conversation survives a restart.
  const again = w.tune();
  assert.deepEqual(again.view().messages.map((m) => [m.role, m.text, m.changes?.length ?? null]), v.messages.map((m) => [m.role, m.text, m.changes?.length ?? null]));
  assert.ok(w.log.every((r) => r.session_id === TUNE_LOG_ID));

  // The conversation so far goes with the next message.
  again.send('さっきのはやっぱりUIに');
  await w.settle();
  assert.deepEqual(w.tuned[1]!.history.map((h) => h.role), ['human', 'ai']);
  assert.ok(w.tuned[1]!.history[1]!.text.includes('[domain] テスト方針'));
});

test('the こだわり chat: an unreadable answer says so and changes nothing; an empty message is refused', async () => {
  const w = world({ tune: () => null });
  const t = w.tune();
  assert.throws(() => t.send('   '));
  t.send('何か');
  await w.settle();
  const last = t.view().messages.at(-1)!;
  assert.equal(last.failed, true);
  assert.equal(w.core.state.knowledge.entries.size, 0);
  assert.equal(t.view().busy, false);
});

test('automatic recording updates one section as a whole, and future work receives its paragraphs', async () => {
  const initial = 'UIの方針。\n既存の条件。';
  const w = world({ extract: (x) => ({
    newDomains: [], add: [], reinforce: [],
    update: x.human.includes('新しい条件') ? [{ id: x.entries[0]!.id, text: initial + '\n\n新しい条件。', domainId: null }] : [],
  }) });
  const id = w.core.addKnowledgeEntry({ domainId: 'ui', text: initial })!;
  await w.start('新しい条件も守って');
  const entries = [...w.core.state.knowledge.entries.values()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, id);
  assert.equal(entries[0]!.text, initial + '\n\n新しい条件。');
  assert.equal(entries[0]!.seen, false);
  await w.start('次の画面を作って');
  assert.ok(w.started[1]!.prompt.includes('### UI・操作感\n' + initial + '\n\n新しい条件。'));
});

test('a delayed AI rewrite cannot erase a section edited by hand while it was reading', async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const w = world({ tune: (x) => ({ reply: '整理しました', newDomains: [], add: [], update: [{ id: x.entries[0]!.id, text: 'AIの古い全文', domainId: null }], remove: [], reinforce: [] }) });
  const id = w.core.addKnowledgeEntry({ domainId: 'ui', text: '読み取り前の全文' })!;
  const real = w.assistant.tunePreferences.bind(w.assistant);
  w.assistant.tunePreferences = async (input, choice) => { await gate; return real(input, choice); };
  const t = w.tune();
  t.send('整理して');
  await new Promise((done) => setTimeout(done, 0));
  w.core.updateKnowledgeEntry(id, { text: '人間が保存した新しい全文' });
  release();
  await w.settle();
  assert.equal(w.core.state.knowledge.entries.get(id)!.text, '人間が保存した新しい全文');
  assert.equal(t.view().messages.at(-1)!.failed, true);
  assert.ok(t.view().messages.at(-1)!.text.includes('読み取り中にこだわりが編集されたため'));
});
