// Live check of naming work and of the things to look at, against the real helper model (this machine's login).
// Not part of `npm test`: it costs a little plan usage.   node packages/server/test/look-live.ts
import { ClaudeAdapter } from '#provider-claude';
import type { ProviderSink } from '#core';

const sink = { processSpawned() {}, sessionUpdate() {}, transcript() {}, usage() {}, usageLimits() {}, usageBlocked() {}, saveRaw: () => '', attentionOpen: () => '', attentionAcknowledged() {}, attentionWithdrawn() {} } as unknown as ProviderSink;
const claude = new ClaudeAdapter(sink);
let bad = 0;
const check = (ok: boolean, what: string, got: unknown) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'NG '} ${what}`, JSON.stringify(got));
};

// 1. A name for the work, on the cheapest settings (no extended thinking).
const title = await claude.generateTitle('要対応画面にある「自動で進めます」と「あとで見る」の文言を消して');
check(!!title && title.length <= 30, '見出し', title);

// 2. A reply that leaves the human an update and a vague check.
const reply = '要対応画面の不要な文言を2つ削除しました。アプリを更新（設定 → アプリの更新）して、2つの文言が消えているかを目で確かめてください。';
const r = await claude.readFinalReply(reply, { background: [] });
check(!!r?.look && r.look.checks.length > 0, '確かめることがある', r?.look);
check(r?.look?.update === 'rebuild', 'その前にアプリの更新', r?.look?.update);
check(!!r && !r.steps.some((s) => /更新|確かめ|確認/.test(s.title)), '更新と目視は steps に入らない', r?.steps);
check((r?.look?.unclear.length ?? 0) > 0, '文言が何かは返答から分からない', r?.look?.unclear);

// 3. The vague check made exact from the record of the work (what a Codex session, or a too-long one, falls back to).
const record = [
  '[user] 要対応画面にある「自動で進めます」と「あとで見る」の文言を消して',
  '[tool] Edit packages/server/public/js/ui/views/inbox.js',
  "-  el('div', { class: 'hint' }, '自動で進めます'),   // 「あなたの作業」の見出しのすぐ下",
  "-  el('button', { class: 'later' }, 'あとで見る'),   // 「返答が完了した作業」の各行の右端、「完了にする」の左",
  `[assistant] ${reply}`,
].join('\n');
const sharp = await claude.clarifyChecks({ checks: r?.look?.checks ?? [{ what: '2つの文言が消えている', where: null }], unclear: r?.look?.unclear.length ? r.look.unclear : ['消した2つの文言が何か'], source: { fork: null, record } });
check(!!sharp && sharp.some((c) => c.what.includes('自動で進めます')) && sharp.some((c) => c.what.includes('あとで見る')), '消した文言がそのまま書かれる', sharp);
check(!!sharp && sharp.every((c) => !!c.where), 'どこを見るかがある', sharp?.map((c) => c.where));

console.log(bad ? `${bad} NG` : 'all ok');
process.exit(bad ? 1 : 0);
