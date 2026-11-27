import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore, fold, KNOWLEDGE_LIMITS, KNOWLEDGE_HEADING, OTHER_DOMAIN_ID, composeFirstMessage, renderKnowledge, planKnowledge, chooseDomains } from '../src/index.ts';

function setup(store = new MemoryEventStore()) {
  let t = 1000;
  const core = new ControlCore({ store, now: () => t++ });
  core.start();
  return { core, store };
}

test('the areas start with その他 at the end, and その他 cannot be removed', () => {
  const { core } = setup();
  const names = [...core.state.knowledge.domains.values()].sort((a, b) => a.order - b.order).map((d) => d.name);
  assert.deepEqual(names, ['UI・操作感', '文章・言葉づかい', 'コード構造・設計', '進め方・git・報告', '確認・テスト', 'その他']);
  assert.throws(() => core.removeKnowledgeDomain(OTHER_DOMAIN_ID));
});

test('stored prompts keep their full text, survive a restart, and removing an area merges into その他', () => {
  const { core, store } = setup();
  const id = core.addKnowledgeEntry({ domainId: 'ui', text: 'あ'.repeat(KNOWLEDGE_LIMITS.sectionText + 50), seen: false })!;
  const e = core.state.knowledge.entries.get(id)!;
  assert.equal(e.text.length, KNOWLEDGE_LIMITS.sectionText + 50);
  assert.equal(e.scope, 'all');
  assert.equal(e.hits, 1);
  assert.equal(core.addKnowledgeEntry({ domainId: 'ui', text: '   ' }), null, 'empty text is not recorded');
  assert.equal(core.state.knowledge.entries.get(core.addKnowledgeEntry({ domainId: 'nope', text: 'x' })!)!.domainId, OTHER_DOMAIN_ID, 'an unknown area falls to その他');

  core.reinforceKnowledgeEntry(id, { sessionId: 's1' });
  core.updateKnowledgeEntry(id, { text: '操作には即時のフィードバック' });
  const domainId = core.setKnowledgeDomain({ name: ' 新しい領域 ', description: '説明' });
  core.updateKnowledgeEntry(id, { domainId });
  core.markKnowledgeSeen();

  const rebuilt = fold(store.readAll());
  const r = rebuilt.knowledge.entries.get(id)!;
  assert.deepEqual([r.text, r.hits, r.sessionId, r.domainId, r.seen], ['操作には即時のフィードバック', 2, 's1', domainId, true]);
  assert.equal(rebuilt.knowledge.domains.get(domainId)!.name, '新しい領域');

  core.removeKnowledgeDomain(domainId);
  const moved = [...core.state.knowledge.entries.values()].find((e) => e.domainId === OTHER_DOMAIN_ID)!;
  assert.ok(moved.text.includes('操作には即時のフィードバック'));
  assert.equal(fold(store.readAll()).knowledge.entries.get(moved.id)!.domainId, OTHER_DOMAIN_ID);

  core.updateKnowledgeEntry(moved.id, { text: '' });
  assert.equal(core.state.knowledge.entries.has(moved.id), false, 'an emptied preference is removed');
});

test('new rules append to the same section prompt, preserving paragraphs and its id', () => {
  const { core } = setup();
  const id = core.addKnowledgeEntry({ domainId: 'code', text: 'ロジックとUIを分ける。\n設計メモを残す。' });
  assert.equal(core.addKnowledgeEntry({ domainId: 'code', text: '境界を明示する。', seen: false }), id);
  assert.equal(core.state.knowledge.entries.size, 1);
  assert.equal(core.state.knowledge.entries.get(id!)!.text, 'ロジックとUIを分ける。\n設計メモを残す。\n\n境界を明示する。');
  assert.equal(core.state.knowledge.entries.get(id!)!.seen, false);
});

test('a section recorded by itself keeps only the lines it added as new, until the human looks', () => {
  const { core, store } = setup();
  const id = core.addKnowledgeEntry({ domainId: 'code', text: 'ロジックとUIを分ける。\n設計メモを残す。' })!;
  assert.equal(core.state.knowledge.entries.get(id)!.added, undefined, 'written by hand: nothing is news');
  core.addKnowledgeEntry({ domainId: 'code', text: '境界を明示する。', seen: false });
  assert.deepEqual(core.state.knowledge.entries.get(id)!.added, ['境界を明示する。']);
  core.addKnowledgeEntry({ domainId: 'code', text: '名前で意図を伝える。', seen: false });
  assert.deepEqual(core.state.knowledge.entries.get(id)!.added, ['境界を明示する。', '名前で意図を伝える。']);
  // A rewrite read from what was said: a line that was already there is not news, a changed one is.
  core.updateKnowledgeEntry(id, { text: 'ロジックとUIを分ける。\n設計メモを短く残す。\n\n名前で意図を伝える。', seen: false });
  assert.deepEqual(core.state.knowledge.entries.get(id)!.added, ['名前で意図を伝える。', '設計メモを短く残す。']);
  assert.deepEqual(fold(store.readAll()).knowledge.entries.get(id)!.added, ['名前で意図を伝える。', '設計メモを短く残す。'], 'survives a restart');
  core.markKnowledgeSeen();
  assert.equal(core.state.knowledge.entries.get(id)!.added, undefined);
  core.addKnowledgeEntry({ domainId: 'code', text: '次の追加', seen: false });
  assert.deepEqual(core.state.knowledge.entries.get(id)!.added, ['次の追加'], 'what was looked at is not news again');
});

test('knowledge settings merge with what is there', () => {
  const { core, store } = setup();
  core.setSettings({ knowledge: { capture: false } as never });
  assert.deepEqual(core.state.settings.knowledge, { capture: false, inject: true });
  assert.deepEqual(fold(store.readAll()).settings.knowledge, { capture: false, inject: true });
});

test('preference AI choices are independent, normalized and replayed without losing the switches', () => {
  const { core, store } = setup();
  const captureAi = { provider: 'codex' as const, model: ' gpt-test ', effort: ' high ' };
  const tuneAi = { provider: 'claude' as const, model: 'opus', effort: 'medium' };
  core.setSettings({ knowledge: { captureAi } as never });
  core.setSettings({ knowledge: { tuneAi } as never });
  core.setSettings({ knowledge: { capture: false } as never });
  const expected = { capture: false, inject: true, captureAi: { provider: 'codex', model: 'gpt-test', effort: 'high' }, tuneAi };
  assert.deepEqual(core.state.settings.knowledge, expected);
  assert.deepEqual(fold(store.readAll()).settings.knowledge, expected);
  const before = store.readAll().length;
  core.setSettings({ knowledge: { tuneAi } as never });
  assert.equal(store.readAll().length, before, 'unchanged AI settings do not create another event');
  core.setSettings({ knowledge: { captureAi: { provider: 'codex', model: '', effort: '' } } as never });
  assert.deepEqual(core.state.settings.knowledge.captureAi, { provider: 'codex', model: '', effort: '' }, 'provider defaults are an explicit choice');
});

test('what is sent: each section is one prompt, with line breaks and explicit project conditions preserved', () => {
  const { core } = setup();
  const p1 = core.addProject('a', 'C:\\a');
  const p2 = core.addProject('b', 'C:\\b');
  core.addKnowledgeEntry({ domainId: 'ui', text: '一度だけ' });
  const often = core.addKnowledgeEntry({ domainId: 'ui', text: '何度も（迷わないため）' })!;
  core.reinforceKnowledgeEntry(often, {});
  core.addKnowledgeEntry({ domainId: 'writing', text: 'p1 の文章', scope: p1 });
  core.addKnowledgeEntry({ domainId: 'code', text: 'p2 のコード', scope: p2 });

  const r = renderKnowledge(core.state.knowledge, ['ui', 'writing', 'code'], p1);
  assert.equal(r.text, [KNOWLEDGE_HEADING, '### UI・操作感', '一度だけ\n\n何度も（迷わないため）', '### 文章・言葉づかい', 'プロジェクト「a」（C:\\a）に限り、次の方針を適用する。\np1 の文章', '### コード構造・設計', 'プロジェクト「b」（C:\\b）に限り、次の方針を適用する。\np2 のコード'].join('\n'));
  assert.deepEqual(r.domains, ['UI・操作感', '文章・言葉づかい', 'コード構造・設計']);
  assert.equal(renderKnowledge(core.state.knowledge, [], p1).text, '');
});

test('every selected section gets its own 5,000 characters, without a shared 6,000 character budget', () => {
  const { core } = setup();
  core.addKnowledgeEntry({ domainId: 'ui', text: 'あ'.repeat(5001) });
  core.addKnowledgeEntry({ domainId: 'writing', text: 'い'.repeat(5000) });
  core.addKnowledgeEntry({ domainId: 'workflow', text: 'う'.repeat(4999) });
  const r = renderKnowledge(core.state.knowledge, ['ui', 'writing', 'workflow'], null);
  assert.equal(r.text, [KNOWLEDGE_HEADING, '### UI・操作感', 'あ'.repeat(5000), '### 文章・言葉づかい', 'い'.repeat(5000), '### 進め方・git・報告', 'う'.repeat(4999)].join('\n'));
  assert.equal(r.dropped, 1);
  assert.equal([...core.state.knowledge.entries.values()][0]!.text.length, 5001);
});

test('legacy entries consolidate once, preserving full text, reasons, restrictions and unread status across replay', () => {
  const store = new MemoryEventStore();
  store.append(1, { type: 'project.added', projectId: 'p', name: '専用', rootPath: 'C:\\p' });
  store.append(2, { type: 'knowledge.entry_added', entryId: 'first', domainId: 'ui', text: '先頭\n二行目', why: '迷わないため', sessionId: 's', scope: 'all', seen: true });
  store.append(3, { type: 'knowledge.entry_added', entryId: 'second', domainId: 'ui', text: '限定の決まり', sessionId: null, scope: 'p', seen: false });
  store.append(4, { type: 'knowledge.entry_added', entryId: 'third', domainId: 'ui', text: '残す'.repeat(3000), sessionId: null, scope: 'all', seen: true });
  const { core } = setup(store);
  assert.equal(core.state.knowledge.entries.size, 1);
  const prompt = core.state.knowledge.entries.get('first')!;
  assert.ok(prompt.text.startsWith('先頭\n二行目（理由: 迷わないため）\n\nプロジェクト「専用」（C:\\p）に限り、次の方針を適用する。\n限定の決まり\n\n'));
  assert.ok(prompt.text.endsWith('残す'.repeat(3000)));
  assert.equal(prompt.seen, false);
  assert.equal(prompt.hits, 3);
  assert.deepEqual(fold(store.readAll()).knowledge, core.state.knowledge);
  const again = setup(store).core;
  assert.deepEqual(again.state.knowledge, core.state.knowledge);
  assert.equal(store.readAll().filter((e) => e.event.type === 'knowledge.prompts_set').length, 1);
});

test('moving into an occupied section and deleting a domain merge prompts without losing text on replay', () => {
  const { core, store } = setup();
  const target = core.addKnowledgeEntry({ domainId: 'writing', text: '結論から書く' })!;
  const source = core.addKnowledgeEntry({ domainId: 'ui', text: '短い言葉で伝える' })!;
  core.updateKnowledgeEntry(source, { domainId: 'writing' });
  assert.equal(core.state.knowledge.entries.size, 1);
  assert.equal(core.state.knowledge.entries.get(target)!.text, '結論から書く\n\n短い言葉で伝える');
  core.addKnowledgeEntry({ domainId: 'other', text: '既存のその他' });
  core.removeKnowledgeDomain('writing');
  assert.equal(core.state.knowledge.entries.size, 1);
  assert.ok([...core.state.knowledge.entries.values()][0]!.text.includes('既存のその他'));
  assert.deepEqual(fold(store.readAll()).knowledge, core.state.knowledge);
});

test('little enough is sent whole; more is routed, with the areas always sent kept', () => {
  const { core } = setup();
  const p = core.addProject('a', 'C:\\a');
  assert.deepEqual(planKnowledge(core.state, p), { kind: 'none' }, 'nothing recorded');
  core.addKnowledgeEntry({ domainId: 'ui', text: '短い' });
  assert.deepEqual(planKnowledge(core.state, p), { kind: 'all', domainIds: ['ui'] });
  core.setSettings({ knowledge: { capture: true, inject: false } });
  assert.deepEqual(planKnowledge(core.state, p), { kind: 'none' }, 'turned off');
  core.setSettings({ knowledge: { capture: true, inject: true } });

  for (let i = 0; i < 20; i++) core.addKnowledgeEntry({ domainId: 'writing', text: `文章の規則 ${i} ${'あ'.repeat(80)}` });
  core.addKnowledgeEntry({ domainId: 'workflow', text: '新しいブランチで作業する' });
  core.setKnowledgeDomain({ id: 'workflow', always: true });
  const plan = planKnowledge(core.state, p);
  assert.equal(plan.kind, 'route');
  if (plan.kind !== 'route') return;
  assert.deepEqual(plan.candidates.map((d) => d.id), ['ui', 'writing', 'workflow']);
  assert.deepEqual(plan.always, ['workflow']);
  assert.deepEqual(chooseDomains(plan, ['writing', 'unknown', 'workflow']), ['workflow', 'writing']);
  assert.deepEqual(chooseDomains(plan, null), ['workflow'], 'no answer: only the areas always sent');
});

test('preferences recorded before the reason became part of the text keep sending it, inside the text', () => {
  const store = new MemoryEventStore();
  store.append(1, { type: 'knowledge.entry_added', entryId: 'old', domainId: 'ui', text: '即時に変える', why: '迷うため', quote: '元の発言', sessionId: null, scope: 'all', seen: true });
  store.append(2, { type: 'knowledge.entry_reinforced', entryId: 'old', quote: 'また', sessionId: 's' });
  const { core } = setup(store);
  const e = core.state.knowledge.entries.get('old')!;
  assert.equal(e.text, '即時に変える（理由: 迷うため）');
  assert.equal(e.hits, 2);
  assert.equal(Object.hasOwn(e, 'why') || Object.hasOwn(e, 'quote'), false);
});

test('the first message keeps the standing part and the request apart, even when the request is about preferences', () => {
  assert.equal(composeFirstMessage('', 'ボタンを直して'), 'ボタンを直して', 'nothing standing: the request goes as it is');
  assert.equal(composeFirstMessage('  \n', 'ボタンを直して'), 'ボタンを直して');
  const request = 'こだわりが更新されたとき、ホーム画面には追加されたものだけを出して';
  const m = composeFirstMessage(`${KNOWLEDGE_HEADING}\n### UI・操作感\n押したらすぐ変える`, request);
  const standing = m.slice(m.indexOf('<standing_instructions>'), m.indexOf('</standing_instructions>'));
  const asked = m.slice(m.indexOf('<request>'), m.indexOf('</request>'));
  assert.ok(m.startsWith('<standing_instructions>') && m.endsWith('</request>'));
  assert.ok(m.indexOf('</standing_instructions>') < m.indexOf('<request>'), 'the request comes after the standing part closes');
  assert.ok(standing.includes('押したらすぐ変える') && !standing.includes(request));
  assert.ok(asked.includes(request) && !asked.includes('押したらすぐ変える'));
});
