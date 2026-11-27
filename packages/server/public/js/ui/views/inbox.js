// Inbox: the list half of the home screen, the one place from which every piece of work is managed.
// Top to bottom, most pressing first: requests to answer, the human's own steps, failed checks, work that can be
// called done, work that stopped, finished replies, and what is still going. Every piece of work that is not put away
// is in exactly one of these (see inboxModel), and each row carries the actions that make sense for it, so nothing
// has to be opened just to answer, reply, finish, stop or put away.
import { act, markAllSeen, markKnowledgeSeen, sendMessage } from '../../logic/actions.js';
import { composerChoice } from '../../logic/ai.js';
import { knowledgeNews } from '../../logic/knowledge.js';
import { ago, agoWord } from '../../logic/format.js';
import { advanceAccordion, checkGroups, inboxModel, openPlainStep } from '../../logic/selectors.js';
import { store } from '../../logic/store.js';
import { el, sync } from '../dom.js';
import { effortPicker } from '../effort-picker.js';
import { icon } from '../icons.js';
import { go, render } from '../shell.js';
import { checksBox, checksSig, doneButton, evidenceLine, stepsBox, stepsSig, workspaceTag } from '../task-parts.js';
import { ticket, ticketSig } from '../ticket.js';
import { voiceOrb } from '../voice-orb.js';
import { lampFor, nowLine, waitsForBackground, wordFor } from '../vocabulary.js';
import { plainText } from '../../logic/markdown.js';
import { fullStamp } from '../../logic/format.js';

/** How many finished replies are listed before "show the rest". */
const FINISHED_SHOWN = 8;

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

const activeRow = (s) => workRow(s, {
  // Always one line: the live preview changes every few seconds, and a row that grows and shrinks shakes the list.
  oneLine: true,
  text: s.completion === 'validating' ? `検証しています: ${s.task?.checkCommand ?? ''}`
    : s.lifecycle === 'queued' ? (s.queuePosition ? `順番待ち ${s.queuePosition}番目。空きが出ると自動で始まります。` : '順番待ち')
      : s.lifecycle === 'waiting_for_user' ? 'エージェントがあなたの操作を待っています。開いて確認してください。'
        : nowLine(s) ?? '',
  reply: s.completion === 'validating' ? null : { word: '次の指示', placeholder: waitsForBackground(s) && s.live ? '指示を書いて Enter（すぐに届きます）' : '' },
  actions: [
    waitsForBackground(s) && el('button', { title: 'バックグラウンドの作業を待たずに、いまの返答を完了として扱う', disabled: !!s.busyWith, onclick: () => act(s.id, 'finish') }, icon('done', 's'), '待たない'),
    s.completion !== 'validating' && el('button', { disabled: !!s.busyWith, onclick: () => act(s.id, 'interrupt') }, icon('stop', 's'), s.lifecycle === 'queued' ? '取り消す' : '中断'),
    doneButton(s),
  ],
});

/** The inbox as a block for the home screen: requests first, then every group of work. */
export function inboxList() {
  const list = el('div', {});
  const clear = el('div', {});
  let orb = null; // the empty state's sphere: made once, reused each time the inbox empties
  const section = (ic, tone, word, extra) => {
    const n = el('span', { class: 'n' });
    return { head: el('h2', {}, icon(ic, tone), word, n, extra), n, body: el('div', {}) };
  };
  const steps = section('user', 'amber', 'あなたの作業');
  const fixes = section('fail', 'red', '検証に失敗した作業');
  const cands = section('shield', 'green', '完了にできる作業');
  const problems = section('error', 'red', '止まっている作業');
  const seenAll = el('button', { class: 'quiet seen-all', onclick: () => markAllSeen(inboxModel(store.state).allUnread) }, icon('check', 's'), 'すべて見たことにする');
  const finished = section('done', 'green', '返答が完了した作業', seenAll);
  const more = el('button', { class: 'quiet more', hidden: true, onclick: () => { store.showAllFinished = !store.showAllFinished; render(); } });
  const active = section('running', 'blue', '進行中の作業');
  // Preferences recorded by themselves: news until the human has looked at them (on their screen, or here).
  const learned = section('bulb', '', '新しく記録したこだわり');
  store.userCollapsed = false; // coming back to the inbox: one request opens by itself again
  const node = el('div', { class: 'inbox' }, list, clear,
    steps.head, steps.body, fixes.head, fixes.body, cands.head, cands.body, problems.head, problems.body, finished.head, finished.body, more, active.head, active.body, learned.head, learned.body);

  const fill = (sec, sessions, sig, build, key = (s) => s.id) => {
    sec.head.hidden = sessions.length === 0;
    sec.n.textContent = sessions.length || '';
    sync(sec.body, sessions, key, sig, build);
  };
  const verdictRow = (s) => el('div', { class: 'result verdict-row' },
    lampFor(s),
    el('button', { class: 'quiet t', onclick: () => go(`#/s/${s.id}`) }, s.taskTitle, workspaceTag(s)),
    s.completion === 'candidate'
      ? doneButton(s, 'primary')
      : el('span', { class: 'do' }, el('button', { onclick: () => go(`#/s/${s.id}`) }, '開く'), doneButton(s)),
    el('span', { class: 'x' }, evidenceLine(s)),
    store.errors.has(s.id) && el('span', { class: 'x err' }, store.errors.get(s.id)));
  const vSig = (s) => [s.completion, s.taskTitle, s.projectName, s.task?.validation?.at, store.errors.get(s.id)].join('|');

  return {
    node,
    update() {
      const model = inboxModel(store.state);
      const { open } = model;
      const c = store.state.counts;
      // Accordion: answering an open request opens the next one; with nothing open, the first opens by itself.
      const { opened, afterAnswer } = advanceAccordion(store, open.map((i) => i.id));
      sync(list, open, (i) => i.id, (i) => `${ticketSig(i)}|${store.expanded.has(i.id)}`, (i) => ticket(i, { collapsible: true }));
      if (opened && afterAnswer && (!document.activeElement || document.activeElement === document.body || list.contains(document.activeElement))) {
        requestAnimationFrame(() => list.querySelector(`[data-item="${opened}"]`)?.focus());
      }
      const clearSig = `${open.length}|${c.humanTasks}|${c.running}|${c.queued}|${c.unread}`;
      if (clear.dataset.sig !== clearSig) {
        clear.dataset.sig = clearSig;
        clear.replaceChildren(...(open.length || c.humanTasks ? [] : [el('div', { class: 'clear' }, (orb ??= voiceOrb()).node,
          el('strong', {}, '判断待ちはありません'),
          (c.running > 0 || c.queued > 0) && el('div', { class: 'counts' },
            el('span', { title: '実行中' }, icon('running', 's blue spin'), String(c.running)),
            c.queued > 0 && el('span', { title: '順番待ち' }, icon('clock', 's'), String(c.queued))))]));
        if (orb?.node.isConnected) orb.set(c.running > 0 ? 'busy' : 'idle');
      }
      // The human's own work: each project's things to look at as one checklist, then each work's other steps.
      const mine = [
        ...checkGroups(model.steps).map((g) => ({ key: `look:${g.projectId}`, g })),
        ...model.steps.filter((s) => (s.task?.humanSteps ?? []).some(openPlainStep)).map((s) => ({ key: s.id, s })),
      ];
      fill(steps, mine, (x) => (x.g ? checksSig(x.g) : stepsSig(x.s)), (x) => (x.g ? checksBox(x.g) : stepsBox(x.s, { titled: true })), (x) => x.key);
      fill(fixes, model.needsFix, vSig, verdictRow);
      fill(cands, model.candidates, vSig, verdictRow);
      fill(problems, model.problems, rowSig, problemRow);
      const shown = store.showAllFinished ? model.finished : model.finished.slice(0, FINISHED_SHOWN);
      fill(finished, shown, rowSig, finishedRow);
      finished.head.hidden = model.finished.length === 0;
      finished.n.textContent = model.finished.length || '';
      seenAll.hidden = !model.finished.some((s) => s.unread);
      more.hidden = model.finished.length <= FINISHED_SHOWN;
      more.textContent = store.showAllFinished ? `新しい${FINISHED_SHOWN}件だけ表示` : `ほか${model.finished.length - FINISHED_SHOWN}件を表示`;
      fill(active, model.active, rowSig, activeRow);
      const news = knowledgeNews(store.state);
      fill(learned, news.count ? [news] : [], (x) => `${x.count}|${x.latest.map((e) => e.id + e.text).join('|')}`, (x) => el('div', { class: 'result kn-news' },
        icon('bulb', 's'),
        el('button', { class: 'quiet t', title: 'こだわりの画面で見る・直す', onclick: () => go('#/knowledge') }, `${x.count}件のこだわりを自動で記録しました`),
        el('span', { class: 'do' },
          el('button', { onclick: () => go('#/knowledge') }, icon('pencil', 's'), '見る・直す'),
          el('button', { title: '内容はそのままで、新着から外す', onclick: () => markKnowledgeSeen() }, icon('check', 's'), '確認済み')),
        el('span', { class: 'x' }, x.latest.map((e) => `「${e.text.replace(/\s+/g, ' ').slice(0, 60)}」`).join(' ') + (x.count > x.latest.length ? ` ほか${x.count - x.latest.length}件` : ''))), () => 'news');
    },
  };
}
