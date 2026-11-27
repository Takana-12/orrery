// Inbox: what the home screen's panel shows for one thing that waits for the human, or for work that is still going
// (logic/orbits.js decides which things those are). Each carries the actions that make sense for it, so nothing has to be opened just to answer,
// reply, finish, stop or put away.
import { act, markKnowledgeSeen, sendMessage } from '../../logic/actions.js';
import { composerChoice } from '../../logic/ai.js';
import { ago, agoWord } from '../../logic/format.js';
import { store } from '../../logic/store.js';
import { el } from '../dom.js';
import { effortPicker } from '../effort-picker.js';
import { icon } from '../icons.js';
import { go, render } from '../shell.js';
import { checksBox, checksSig, doneButton, evidenceLine, stepsBox, stepsSig, workspaceTag } from '../task-parts.js';
import { ticket, ticketSig } from '../ticket.js';
import { lampFor, nowLine, wordFor } from '../vocabulary.js';
import { plainText } from '../../logic/markdown.js';
import { fullStamp } from '../../logic/format.js';

/** A reply box inside a row. It shares its draft with the session's own reply box. */
function quickReply(s, placeholder) {
  const input = el('input', { type: 'text', placeholder, value: store.composerDrafts.get(s.id) ?? '', 'aria-label': `${s.taskTitle} への指示` });
  const effort = effortPicker({ value: composerChoice(s), onChange: (value) => store.composerEfforts.set(s.id, value) });
  const send = () => {
    const words = input.value.trim();
    if (!words) return input.focus();
    // Sent as far as the screen goes: the row closes and the work shows as going on. It comes back if sending fails.
    store.composerDrafts.delete(s.id);
    store.replying.delete(s.id);
    sendMessage(s.id, words).then((r) => {
      if (r.status === 200) return;
      store.composerDrafts.set(s.id, words);
      store.replying.add(s.id);
      store.errors.set(s.id, r.body.error || `送信できませんでした (${r.status})`);
      render();
    });
  };
  input.addEventListener('input', () => store.composerDrafts.set(s.id, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape') { e.stopPropagation(); store.replying.delete(s.id); render(); }
  });
  return el('div', { class: 'quick' }, input, effort.node, el('button', { class: 'primary ib', title: '送る (Enter)', 'aria-label': '送る', onclick: send }, icon('send', 's')));
}

/** One piece of work as a row: what it is, what state it is in, and what can be done about it right here. */
function workRow(s, { text, actions = [], reply = null, oneLine = false }) {
  const replying = reply && store.replying.has(s.id);
  const toggleReply = () => {
    if (replying) store.replying.delete(s.id);
    else store.replying.add(s.id);
    render();
    if (!replying) requestAnimationFrame(() => document.querySelector(`[data-work="${s.id}"] .quick input`)?.focus());
  };
  return el('div', { class: 'result work', 'data-work': s.id },
    lampFor(s),
    el('button', { class: 'quiet t', title: `${wordFor(s)}。開く`, onclick: () => go(`#/s/${s.id}`) }, s.unread && el('span', { class: 'new-dot', title: '結果をまだ見ていません' }), s.taskTitle, workspaceTag(s)),
    el('span', { class: 'do' },
      el('span', { class: 'age', title: wordFor(s) }, agoWord(s.lifecycleSince ?? s.updatedAt)),
      reply && el('button', { 'aria-expanded': String(!!replying), onclick: toggleReply }, icon('pencil', 's'), reply.word),
      actions),
    text && el('span', oneLine ? { class: 'x one', title: text } : { class: 'x' }, text),
    store.errors.has(s.id) && el('span', { class: 'x err', role: 'alert' }, store.errors.get(s.id)),
    replying && quickReply(s, reply.placeholder));
}
const rowSig = (s) => [s.lifecycle, s.completion, s.taskTitle, s.projectName, s.extraProjectNames?.join('・'), s.model, s.effort, s.unread, s.lastText, s.error, JSON.stringify(s.usageResume ?? null), s.busyWith, s.queuePosition, nowLine(s), store.replying.has(s.id), store.errors.get(s.id), ago(s.lifecycleSince ?? s.updatedAt)].join('|');

const problemRow = (s) => workRow(s, {
  text: s.usageResume ? (s.usageResume.resetsAt === null ? '利用枠の復活待ち。復活時刻を確認でき次第、自動再開を予約します。' : `利用枠の復活待ち。${fullStamp(s.usageResume.resetsAt + 60_000)}ごろに自動再開します。`)
    : s.error ? `エラー: ${s.error}` : s.lifecycle === 'interrupted' ? '途中で止まりました。続きを指示するか、片付けられます。' : '状況が分かりません。開いて確認してください。',
  reply: s.resumability === 'unrecoverable' ? null : { word: '続きを指示', placeholder: '続きの指示を書いて Enter（作業を再開します）' },
  actions: [doneButton(s), el('button', { title: '片付ける（会話も履歴も消えず、いつでも戻せます）', onclick: () => act(s.id, 'archive') }, icon('archive', 's'), '片付ける')],
});

const finishedRow = (s) => workRow(s, {
  // A two-line preview: the reply's words without its Markdown marks.
  text: plainText(s.lastText ?? ''),
  reply: { word: '返信', placeholder: '追加の指示を書いて Enter' },
  actions: [doneButton(s)],
});

const waitingRow = (s) => workRow(s, {
  text: 'エージェントがあなたの操作を待っています。開いて確認してください。',
  reply: { word: '次の指示', placeholder: '' },
  actions: [
    el('button', { disabled: !!s.busyWith, onclick: () => act(s.id, 'interrupt') }, icon('stop', 's'), '中断'),
    doneButton(s),
  ],
});

/** Work still going (a point on an orbit): what it is doing now, and a way to stop it or take it out of the queue. */
const goingRow = (s) => workRow(s, {
  text: nowLine(s),
  oneLine: true,
  actions: [el('button', { disabled: !!s.busyWith, onclick: () => act(s.id, 'interrupt') }, icon('stop', 's'), s.lifecycle === 'queued' ? '取り消す' : '中断')],
});

const verdictRow = (s) => el('div', { class: 'result verdict-row' },
  lampFor(s),
  el('button', { class: 'quiet t', onclick: () => go(`#/s/${s.id}`) }, s.taskTitle, workspaceTag(s)),
  s.completion === 'candidate'
    ? doneButton(s, 'primary')
    : el('span', { class: 'do' }, el('button', { onclick: () => go(`#/s/${s.id}`) }, '開く'), doneButton(s)),
  el('span', { class: 'x' }, evidenceLine(s)),
  store.errors.has(s.id) && el('span', { class: 'x err' }, store.errors.get(s.id)));
const vSig = (s) => [s.completion, s.taskTitle, s.projectName, s.task?.validation?.at, store.errors.get(s.id)].join('|');

const newsRow = (x) => el('div', { class: 'result kn-news' },
  icon('bulb', 's'),
  el('button', { class: 'quiet t', title: 'こだわりの画面で見る・直す', onclick: () => go('#/knowledge') }, `${x.count}件のこだわりを自動で記録しました`),
  el('span', { class: 'do' },
    el('button', { onclick: () => go('#/knowledge') }, icon('pencil', 's'), '見る・直す'),
    el('button', { title: '内容はそのままで、新着から外す', onclick: () => markKnowledgeSeen() }, icon('check', 's'), '確認済み')),
  el('div', { class: 'x kn-added' }, ...x.lines.map((line) => el('p', {}, line))));
const newsSig = (x) => x.lines.join('\n');

/** What one orbit entry (logic/orbits.js) is drawn as, and the signature that says when to draw it again. */
const VIEWS = {
  ask: { build: (e) => ticket(e.item), sig: (e) => ticketSig(e.item) },
  waiting: { build: (e) => waitingRow(e.s), sig: (e) => rowSig(e.s) },
  look: { build: (e) => checksBox(e.g), sig: (e) => checksSig(e.g) },
  steps: { build: (e) => stepsBox(e.s, { titled: true }), sig: (e) => stepsSig(e.s) },
  fix: { build: (e) => verdictRow(e.s), sig: (e) => vSig(e.s) },
  candidate: { build: (e) => verdictRow(e.s), sig: (e) => vSig(e.s) },
  problem: { build: (e) => problemRow(e.s), sig: (e) => rowSig(e.s) },
  finished: { build: (e) => finishedRow(e.s), sig: (e) => rowSig(e.s) },
  news: { build: (e) => newsRow(e.news), sig: (e) => newsSig(e.news) },
  running: { build: (e) => goingRow(e.s), sig: (e) => rowSig(e.s) },
  queued: { build: (e) => goingRow(e.s), sig: (e) => rowSig(e.s) },
};
export const entryNode = (e) => VIEWS[e.kind].build(e);
export const entrySig = (e) => `${e.kind}|${VIEWS[e.kind].sig(e)}`;
