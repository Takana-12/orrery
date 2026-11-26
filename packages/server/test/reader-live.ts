// Live check of the reply reader against the real helper model (Claude Code's cheapest model, this machine's login).
// Not part of `npm test`: it costs a little plan usage.   node packages/server/test/reader-live.ts
import { ClaudeAdapter } from '#provider-claude';
import type { ProviderSink } from '#core';

const sink = { processSpawned() {}, sessionUpdate() {}, transcript() {}, usage() {}, usageLimits() {}, usageBlocked() {}, saveRaw: () => '', attentionOpen: () => '', attentionAcknowledged() {}, attentionWithdrawn() {} } as unknown as ProviderSink;
const claude = new ClaudeAdapter(sink);

interface Case {
  name: string;
  reply: string;
  background?: string[];
  expect: { continues: boolean; steps: boolean; after?: boolean; question?: boolean; questions?: number };
}
const cases: Case[] = [
  { name: '完了報告だけ', reply: 'ログイン画面の入力チェックを直しました。`npm test` も全件通っています。', expect: { continues: false, steps: false } },
  { name: '依頼の形でない人間の作業', reply: '実装とテストは終わりました。あとは `npm run install-app` を実行するとアプリに反映されます。', expect: { continues: false, steps: true, after: false } },
  { name: '人間の作業（依頼）', reply: 'PRを作成しました: https://github.com/x/y/pull/12\nレビューのうえマージをお願いします。マージ後に `npm run deploy` を実行してください。', expect: { continues: false, steps: true } },
  { name: 'テスト待ちで自分が続ける', reply: 'E2Eテストをバックグラウンドで実行しています（10分ほどかかります）。完了したら結果を確認して報告します。', background: ['npm run e2e'], expect: { continues: true, steps: false } },
  { name: 'テスト後に人間がやる（エージェントは待機中）', reply: '修正を入れて、いまバックグラウンドでテストを回しています。終わったら結果を報告します。テストが通ったら、あなたの側で `npm run install-app` を実行してください。', background: ['npm test'], expect: { continues: true, steps: true, after: true } },
  { name: 'テスト後に人間がやる（エージェントは終了）', reply: '修正を入れました。CIが回っています。CIが緑になったら `gh pr merge 12 --squash` でマージしてください。', expect: { continues: false, steps: true, after: true } },
  { name: '開発サーバーを残しただけ', reply: '開発サーバーを起動しました。http://localhost:3000 で画面を確認できます。変更は以上です。', background: ['npm run dev'], expect: { continues: false, steps: false } },
  { name: '質問で終わる', reply: '実装方法が2つあります。A: 既存のテーブルに列を足す。B: 新しいテーブルを作る。どちらにしますか？', expect: { continues: false, steps: false, question: true } },
  { name: '別々の2つの判断', reply: '見比べの結果が出ました。次の対応を決めてください。\n- EXP-2を採用する\n- EXP-2を破棄する（元の指示文より良くならなかったため）\n- EXP-3を実施する（改訂版で次の実験。約25ドルの見込み）\n\nそれとは別に、課題 git-author-email-private について:\n- GitHubの作者アドレスを非公開用に切り替える\n- 私用アドレスの設定に戻す\nどちらにしますか？', expect: { continues: false, steps: false, question: true, questions: 2 } },
  { name: '任意の提案', reply: '対応しました。必要であれば、ドキュメントの更新もできます。', expect: { continues: false, steps: false } },
];

let bad = 0;
for (const c of cases) {
  const r = await claude.readFinalReply(c.reply, { background: c.background ?? [] });
  if (!r) {
    console.log(`??    ${c.name}: 読み取れませんでした`);
    bad++;
    continue;
  }
  const got = { continues: r.agentContinues, steps: r.steps.length > 0, after: r.steps.some((s) => !!s.after), question: r.questions.length > 0, questions: r.questions.length };
  const ok = got.continues === c.expect.continues && got.steps === c.expect.steps && (c.expect.after === undefined || got.after === c.expect.after) && (c.expect.question === undefined || got.question === c.expect.question) && (c.expect.questions === undefined || got.questions === c.expect.questions);
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'NG  '}  ${c.name}\n        ${JSON.stringify(r)}`);
}
console.log(bad ? `\n${bad}件が期待と違います` : '\nすべて期待どおり');
await claude.shutdown();
process.exit(bad ? 1 : 0);
