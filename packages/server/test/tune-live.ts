// Live check of the こだわり chat's reading against the real helper model (costs a little plan usage).
//   node packages/server/test/tune-live.ts
import { ClaudeAdapter } from '#provider-claude';
import type { ProviderSink } from '#core';

const sink = { processSpawned() {}, sessionUpdate() {}, transcript() {}, usage() {}, usageLimits() {}, usageBlocked() {}, saveRaw: () => '', attentionOpen: () => '', attentionAcknowledged() {}, attentionWithdrawn() {} } as unknown as ProviderSink;
const claude = new ClaudeAdapter(sink);

const started = Date.now();
const r = await claude.tunePreferences({
  message: [
    '設定画面のこだわり編集で、保存ボタンを右端に置いて。押したらすぐ画面に反映して。',
    'あと「確認ダイアログを出す」は古いからもういらない。',
    'それと、SQL のマイグレーションは必ず down も書くこと。テーブル名は複数形で。',
  ].join('\n'),
  history: [],
  domains: [
    { id: 'ui', name: 'UI・操作感', description: '画面の見た目、操作したときの反応、レイアウト' },
    { id: 'code', name: 'コード構造・設計', description: 'ファイルや層の分け方、命名、設計の方針' },
    { id: 'other', name: 'その他', description: 'どの領域にも当てはまらないこだわり' },
  ],
  entries: [
    { id: 'e1', domainId: 'ui', text: '削除の前には確認ダイアログを出す', scope: 'all' },
    { id: 'e2', domainId: 'ui', text: '操作したら、確定を待たずにその場で画面を変える', scope: 'all' },
  ],
  projects: [{ id: 'p1', name: 'orrery' }],
  otherDomainId: 'other',
  domainsLeft: 27,
});
console.log(`${Date.now() - started} ms`);
console.log(JSON.stringify(r, null, 2));
process.exit(r ? 0 : 1);
