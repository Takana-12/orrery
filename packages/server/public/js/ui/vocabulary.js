// Vocabulary: one lamp + one word per state. The only place that says how a state reads and looks.
import { ticketKind } from '../logic/selectors.js';
import { icon, SVG } from './icons.js';

export const STATE = {
  queued: { word: '順番待ち', icon: 'clock', tone: 'dim' },
  running: { word: '実行中', icon: 'running', tone: 'blue', spin: true },
  waiting_for_user: { word: 'あなたの判断待ち', icon: 'attention', tone: 'amber' },
  turn_finished: { word: '返答が完了', icon: 'done', tone: 'green' },
  interrupted: { word: '中断', icon: 'pause', tone: 'dim' },
  error: { word: '異常', icon: 'error', tone: 'red' },
  unknown: { word: '状況不明', icon: 'question', tone: 'dim' },
};
export const lamp = (lifecycle, cls = '') => {
  const s = STATE[lifecycle] ?? STATE.unknown;
  return icon(s.icon, `${s.tone} ${s.spin ? 'spin' : ''} ${cls}`);
};
/** What the evidence says about the task itself (a finished reply is not a finished task). */
export const VERDICT = {
  validating: { word: '検証中', icon: 'running', tone: 'blue', spin: true },
  needs_fix: { word: '検証に失敗', icon: 'fail', tone: 'red' },
  candidate: { word: '検証に成功', icon: 'shield', tone: 'green' },
  human_steps: { word: 'あなたの作業待ち', icon: 'user', tone: 'amber' },
  accepted: { word: '完了済み', icon: 'done', tone: 'green' },
};
/** The reply ended, but the agent is waiting for its own background work and will go on by itself: running, yet idle. */
const WAITING_BG = { word: 'バックグラウンド作業の終了待ち', icon: 'clock', tone: 'blue' };
export const waitsForBackground = (s) => s.lifecycle === 'running' && !!s.awaitingBackground;
/** What is being done to a session right now because the human asked (shown from the click on). */
/** What the こだわり chat did to the record: one icon + one word per kind of change. */
export const TUNE_CHANGE = {
  domain: { word: '領域を追加', icon: 'plan', tone: 'blue' },
  add: { word: '追加', icon: 'plus', tone: 'green' },
  update: { word: '書き直し', icon: 'pencil', tone: 'blue' },
  move: { word: '移動', icon: 'next', tone: 'dim' },
  remove: { word: '削除', icon: 'trash', tone: 'red' },
  reinforce: { word: '記録済み', icon: 'check', tone: 'dim' },
};
export const BUSY_WORD = { interrupt: '中断しています…', stop: 'プロセスを終了しています…', cleanup: '残ったプロセスを終了しています…', check: '検証を始めています…', finish: '完了として扱っています…' };
/** One lamp per strip: the task verdict when there is one, otherwise the session state. */
export const lampFor = (s, cls = '') => {
  const v = VERDICT[s.completion] ?? (waitsForBackground(s) ? WAITING_BG : null);
  return v ? icon(v.icon, `${v.tone} ${v.spin ? 'spin' : ''} ${cls}`) : lamp(s.lifecycle, cls);
};
export const wordFor = (s) => VERDICT[s.completion]?.word ?? (waitsForBackground(s) ? WAITING_BG.word : s.lifecycle === 'queued' && s.queuePosition ? `順番待ち ${s.queuePosition}番目` : (STATE[s.lifecycle] ?? STATE.unknown).word);
/** The one line under a title that says what a session is doing this moment (null: nothing worth a line). */
export const nowLine = (s) =>
  s.busyWith && BUSY_WORD[s.busyWith] ? BUSY_WORD[s.busyWith]
    : waitsForBackground(s) ? `終了待ち: ${(s.background ?? []).join('、') || 'バックグラウンドの作業'}`
      : s.lifecycle === 'running' && s.activity ? s.activity.text : null;
export const DECISION = {
  accept: { word: '許可する', icon: 'check', cls: 'primary' },
  acceptForSession: { word: 'この作業の間は常に許可', icon: 'shield', cls: '' },
  decline: { word: '拒否する', icon: 'x', cls: 'danger' },
  cancel: { word: '拒否して作業を止める', icon: 'stop', cls: 'danger' },
};
export const PROVIDER = { claude: 'Claude Code', codex: 'Codex' };

/** Things to look at: the action that brings the change in first, as a heading of the checklist and as a step's "先に". */
export const LOOK = {
  rebuild: { heading: 'アプリを更新して、次を確かめる', first: 'アプリを更新する' },
  reload: { heading: '画面を再読み込みして、次を確かめる', first: '画面を再読み込みする' },
  none: { heading: '次を確かめる', first: null },
};
/** The agent's mark, used wherever a row needs to say which agent it belongs to. */
export const ptag = (p) => {
  const s = icon(p in PROVIDER ? p : 'agent', 's dim');
  const t = document.createElementNS(SVG, 'title');
  t.textContent = PROVIDER[p] ?? p;
  s.append(t);
  return s;
};
/** The keyboard, as listed in settings. Each entry: alternatives (each a combination of keys) and what they do. */
export const SHORTCUTS = [
  { keys: [['Space'], ['n']], word: 'ホームで新しい作業を書く' },
  { keys: [['Space 長押し']], word: '音声で頼む（離すと送る）' },
  { keys: [['i']], word: 'ホーム' },
  { keys: [['Ctrl', 'U']], word: '利用状況' },
  { keys: [['Ctrl', 'H']], word: 'アーカイブ' },
  { keys: [['Ctrl', ',']], word: '設定' },
  { keys: [['Ctrl', 'A']], word: 'サイドチャットを開く（入力欄に文字があるときは全選択）' },
  { keys: [['Tab'], ['Shift', 'Tab']], word: '次 / 前の作業' },
  { keys: [['j'], ['k']], word: '次 / 前の項目' },
  { keys: [['1–9']], word: '選択肢を選ぶ' },
  { keys: [['Enter']], word: '項目を開く' },
  { keys: [['Ctrl', 'Enter']], word: '送信' },
  { keys: [['Esc']], word: '戻る' },
];
export const EFFORT = { none: 'なし', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大', ultra: 'ウルトラ' };
export const APPROVAL = { ask: '毎回わたしが決める', edits: 'ファイル編集は自動で許可', auto: 'エージェントの審査に任せる' };
export const APPROVAL_OPTS = [
  { value: 'ask', label: APPROVAL.ask, short: '毎回確認', icon: 'user' },
  { value: 'edits', label: APPROVAL.edits, short: '編集は自動', icon: 'file' },
  { value: 'auto', label: APPROVAL.auto, short: '審査に任せる', icon: 'shield' },
];

/** The word and icon for each kind of request. */
const KIND = {
  question_from_reply: { icon: 'question', word: '質問（返答の文章から）' },
  input: { icon: 'plug', word: '入力の依頼' },
  question: { icon: 'question', word: '質問' },
  plan: { icon: 'plan', word: '計画の承認' },
  file_change: { icon: 'file', word: 'ファイル変更の承認' },
  external_tool: { icon: 'plug', word: '外部ツールの承認' },
  command: { icon: 'terminal', word: 'コマンドの承認' },
  approval: { icon: 'shield', word: '承認' },
};
export const kindOf = (item) => KIND[ticketKind(item)];
