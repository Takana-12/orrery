// One piece of work: its conversation, what it is waiting for, and the box to say more.
import { act, confirmSent, loadTranscript, markSeen, sendMessage } from '../../logic/actions.js';
import { composerChoice } from '../../logic/ai.js';
import { ago, agoWord, clock, mb } from '../../logic/format.js';
import { isSendChord, SEND_KEYS } from '../../logic/platform.js';
import { sessionModel, workspacesOf } from '../../logic/selectors.js';
import { store } from '../../logic/store.js';
import { toolSummary } from '../../logic/text.js';
import { beginVoice } from '../../logic/voice.js';
import { attachments } from '../attachments.js';
import { $, autoGrow, el, put, sync } from '../dom.js';
import { effortPicker } from '../effort-picker.js';
import { icon } from '../icons.js';
import { go, render, ui } from '../shell.js';
import { finishWork, richText, stepsBox, verdictNodes } from '../task-parts.js';
import { ticket, ticketSig } from '../ticket.js';
import { APPROVAL, BUSY_WORD, EFFORT, PROVIDER, STATE, lamp, lampFor, waitsForBackground, wordFor } from '../vocabulary.js';

function messageNode(e, sessionId) {
  const WHO = { user: 'user', assistant: 'agent', tool: 'terminal', system: 'info' };
  const head = icon(WHO[e.role] ?? 'info');
  if (e.role === 'tool') {
    const { glyph, line, more } = toolSummary(e.text);
    return el('div', { class: 'msg tool' }, icon(glyph), more ? el('details', {}, el('summary', {}, line), el('pre', {}, more)) : el('div', { class: 'text' }, line));
  }
  return el('div', { class: `msg ${e.role}` }, head, el('div', {}, e.role === 'assistant' ? el('div', { class: 'text rich' }, richText(e.text, sessionId)) : el('div', { class: 'text' }, e.text), el('div', { class: 'when' }, clock(e.at))));
}
const PR_STATE = { OPEN: 'オープン', MERGED: 'マージ済み', CLOSED: 'クローズ' };

/** The pull request this work is on: its number, opening it on GitHub. */
function prLink(pr) {
  const word = pr.draft && pr.state === 'OPEN' ? '下書き' : PR_STATE[pr.state] ?? pr.state;
  return el('a', { class: `pr pr-${(pr.draft && pr.state === 'OPEN' ? 'draft' : pr.state).toLowerCase()}`, href: pr.url, target: '_blank', rel: 'noopener noreferrer', title: `${pr.title}
${pr.url}` },
    icon('pr', 's'), `#${pr.number}`, word && el('span', { class: 'pr-state' }, word));
}

/**
 * While the work waits for the human's own steps, the screen shows either those steps or the record, never both:
 * a long list of steps would otherwise leave the record a sliver. The steps come first; the choice is kept per work.
 */
const stepsShown = new Map();

export function sessionView(id) {
  const s0 = store.state.sessions.find((x) => x.id === id);
  if (!s0) {
    $('main').replaceChildren(el('div', { class: 'pad' }, el('h1', {}, 'この作業は見つかりません'), el('button', { onclick: () => go('#/') }, icon('back', 's'), '要対応に戻る')));
    // Right after starting, the first store.state push may not include the session yet: this key never matches,
    // so the screen is rebuilt on the next push instead of staying on "not found".
    return { key: 'missing', update() {} };
  }
  const title = el('span', {});
  const stateEl = el('span', { class: 's-state' });
  const meta = el('div', { class: 's-meta' });
  const acts = el('div', { class: 's-acts' });
  const err = el('div', { class: 'err', role: 'alert' });
  const verdict = el('div', { class: 'verdict' });
  const renameBtn = el('button', { class: 'quiet ib', title: '名前を変える', 'aria-label': '名前を変える', onclick: () => { const cur = store.state.sessions.find((x) => x.id === id)?.taskTitle ?? ''; const next = prompt('作業の名前', cur); if (next && next.trim() && next !== cur) act(id, 'rename', { title: next }); } }, icon('pencil', 's'));
  const log = el('div', { class: 'inner' }, el('div', { class: 'note' }, '記録を読み込んでいます…'));
  const earlier = el('button', { class: 'quiet', hidden: true }, '以前の記録を読み込む');
  const jump = el('div', { class: 's-jump', hidden: true }, el('button', { class: 'ib', title: '新しい記録へ', 'aria-label': '新しい記録へ', onclick: () => { body.scrollTop = body.scrollHeight; } }, icon('down')));
  // Messages sent from here that the record does not show yet: on screen from the moment they are sent.
  const outbox = el('div', { class: 'inner outbox' });
  // What the work is waiting for sits right under the record and scrolls with it, so a long question never leaves
  // the record a sliver of the screen.
  const pending = el('div', { class: 'inner pending' });
  const body = el('div', { class: 's-body' }, el('div', { class: 'inner' }, earlier), log, outbox, pending, jump);
  const text = el('textarea', { rows: '2', 'aria-label': '追加の指示' });
  text.value = store.composerDrafts.get(id) ?? '';
  const send = el('button', { class: 'primary ib' }, icon('send'));
  const hint = el('span', { class: 'note' });
  const sendErr = el('span', { class: 'err', role: 'alert' });
  const held = el('div', { class: 'held' });
  const card = el('div', { class: 'composer' });
  const att = attachments(`s:${id}`, text, card, (m) => { sendErr.textContent = m; });
  const effort = effortPicker({ value: composerChoice(s0), onChange: (value) => store.composerEfforts.set(id, value) });
  // Voice input for the hand on the mouse: what is said is a reply to this work (holding Space does the same).
  const speak = el('button', { type: 'button', class: 'quiet ib', title: '音声で返信（Space 長押し）', 'aria-label': '音声で返信', onclick: () => beginVoice('toggle', { replyTo: id }) }, icon('mic'));
  card.append(text, el('div', { class: 'bar' }, att.button, speak, effort.node, hint, sendErr, el('span', { class: 'grow' }), send));
  const stepsSlot = el('div', { class: 'steps-slot' }); // the switch between the steps and the record sits on the composer's top right
  const footInner = el('div', { class: 'inner' }, held, att.tray, stepsSlot, card);
  const foot = el('div', { class: 's-foot' }, footInner);
  const screen = el('div', { class: 'session' });
  $('main').replaceChildren(screen);
  put(screen,
    el('header', { class: 's-head' },
      el('div', { class: 's-title' }, el('button', { class: 'quiet ib back', onclick: () => go('#/'), 'aria-label': '一覧に戻る' }, icon('back')), el('h1', {}, title), renameBtn, stateEl, acts),
      meta, verdict, err),
    body, foot);
  const showSteps = (yes) => {
    stepsShown.set(id, yes);
    headSig = '';
    render();
    if (!yes) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; jump.hidden = true; });
  };

  let firstSeq = null;
  let lastSeq = 0;
  let rev = -1;
  let loading = false;
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.addEventListener('scroll', () => { if (atBottom()) jump.hidden = true; });

  async function load(initial) {
    if (loading) return;
    loading = true;
    const r = await loadTranscript(id, initial ? {} : { after: lastSeq });
    loading = false;
    if (r.status !== 200 || !r.body.entries.length) {
      if (initial) log.replaceChildren(el('div', { class: 'note' }, r.status === 200 ? 'まだ記録がありません。' : '記録を読み込めませんでした。'));
      return;
    }
    const stick = initial || atBottom();
    if (initial) {
      log.replaceChildren();
      firstSeq = r.body.entries[0].seq;
      earlier.hidden = r.body.entries.length < 200;
    }
    if (!initial && !firstSeq) { log.replaceChildren(); firstSeq = r.body.entries[0].seq; } // the first entries of a record that was empty
    for (const e of r.body.entries) log.append(messageNode(e, id));
    lastSeq = r.body.entries.at(-1).seq;
    // The record now shows what was sent from here: its provisional copy has done its job.
    if (!initial) confirmSent(id, r.body.entries.filter((e) => e.role === 'user').length);
    if (stick) body.scrollTop = body.scrollHeight;
    else jump.hidden = false;
  }
  earlier.addEventListener('click', async () => {
    const r = await loadTranscript(id, { before: firstSeq });
    if (r.status !== 200 || !r.body.entries.length) return void (earlier.hidden = true);
    const h = body.scrollHeight;
    log.prepend(...r.body.entries.map((e) => messageNode(e, id)));
    firstSeq = r.body.entries[0].seq;
    earlier.hidden = r.body.entries.length < 200;
    body.scrollTop += body.scrollHeight - h;
  });

  const submit = async () => {
    if (!text.value.trim() && !att.count()) return;
    if (!att.ready()) return void (sendErr.textContent = '添付の保存が終わるまでお待ちください');
    // Sent from this instant as far as the screen goes: the box empties and the words appear in the conversation.
    const words = (text.value.trim() || '添付ファイルを確認してください。') + att.suffix();
    text.value = '';
    autoGrow(text);
    att.clear();
    store.composerDrafts.delete(id);
    sendErr.textContent = '';
    if (stepsShown.get(id) !== false) showSteps(false); // what was just said is in the record
    const sending = sendMessage(id, words);
    body.scrollTop = body.scrollHeight;
    const r = await sending;
    if (r.status === 200) return;
    // It did not go out: give the words back (to this box if it is still on screen and empty, else to the draft).
    const message = r.body.error || `送信できませんでした (${r.status})`;
    if (!(store.composerDrafts.get(id) ?? '').trim()) store.composerDrafts.set(id, words);
    if (text.isConnected) {
      if (!text.value.trim()) { text.value = words; autoGrow(text); }
      sendErr.textContent = message;
    } else store.notice(`「${store.state.sessions.find((x) => x.id === id)?.taskTitle ?? '作業'}」に送れませんでした: ${message}（書いた内容は入力欄に戻してあります）`);
  };
  send.addEventListener('click', submit);
  text.addEventListener('input', () => store.composerDrafts.set(id, text.value));
  text.addEventListener('keydown', (e) => { if (isSendChord(e)) submit(); });

  if (ui.focusComposer) { ui.focusComposer = false; text.focus(); }
  let headSig = '';
  return {
    key: `s:${id}`,
    update() {
      const model = sessionModel(store.state, id);
      if (!model) return;
      const { s, busy, leftovers, others, mine } = model;
      // Words put into this box from elsewhere (voice input, or a reply that could not be sent).
      if (store.composerFill.delete(id)) { text.value = store.composerDrafts.get(id) ?? ''; autoGrow(text); }
      effort.set(composerChoice(s));
      if (s.unread && document.visibilityState === 'visible') markSeen(id);
      const def = STATE[s.lifecycle] ?? STATE.unknown;
      const waitsBg = waitsForBackground(s);
      // An agent that only waits for its background work takes a message at once; a working one gets it afterwards.
      const holds = busy && !(waitsBg && s.live);
      const mineOut = store.outbox.get(id) ?? [];
      sync(outbox, mineOut, (m) => m.id, (m) => `${m.sent}`, (m) =>
        el('div', { class: 'msg user unsent' }, icon('user'), el('div', {}, el('div', { class: 'text' }, m.text), el('div', { class: 'when' }, icon(m.sent ? 'clock' : 'running', m.sent ? 's' : 's spin'), m.sent ? ' 送信済み（エージェントの開始待ち）' : ' 送信中'))));
      if (s.completion !== 'human_steps') stepsShown.delete(id); // the next list of steps is shown first again
      const res = s.resources;
      const sig = [s.lifecycle, s.completion, s.taskTitle, s.effort, s.approvalMode, s.deferredMessage, s.busyWith, s.awaitingBackground, JSON.stringify(s.usageResume ?? null), (s.background ?? []).join('、'), others.length, JSON.stringify(s.task?.humanSteps ?? null), stepsShown.get(id), store.everyStep.has(id), s.queuePosition, s.task?.validating, s.task?.validation?.at, s.task?.fixRounds, s.live, s.process, s.model, s.archived, s.resumability, JSON.stringify(s.pullRequest ?? null), res?.processCount, res && Math.round(res.workingSetBytes / 5e6), s.error, store.errors.get(id), ago(s.lifecycleSince)].join('|');
      if (sig !== headSig) {
        headSig = sig;
        title.textContent = s.taskTitle;
        document.title = `${s.taskTitle} — Orrery`;
        const doing = s.busyWith && BUSY_WORD[s.busyWith];
        const word = doing || (waitsBg ? wordFor(s) : s.lifecycle === 'queued' && s.queuePosition ? `順番待ち ${s.queuePosition}番目` : def.word);
        put(stateEl, doing ? icon('running', 'spin') : waitsBg ? lampFor(s) : lamp(s.lifecycle),
          // What was just asked for, and a state that is easy to mistake for "finished", are spelled out.
          doing || waitsBg ? el('span', { class: 'note' }, word) : el('span', { class: 'sr-only' }, word), el('span', { class: 'note' }, ago(s.lifecycleSince)));
        stateEl.title = `${word}（${agoWord(s.lifecycleSince)}から）`;
        put(meta,
          el('span', { title: 'ワークスペース' }, icon('folder', 's'), workspacesOf(s)),
          el('span', { class: 'path', title: s.cwd }, s.cwd),
          s.worktree && el('span', { title: s.worktree.removed ? (s.worktree.keptBranch ? '作業用フォルダは片付け済み。変更はこのブランチに残っています' : '作業用フォルダは片付け済み') : `この作業専用のフォルダ（git worktree）。完了にするか片付けると自動で削除されます\n${s.worktree.path}` }, icon('branch', 's'), s.worktree.branch, s.worktree.removed ? '（片付け済み）' : ''),
          s.pullRequest && prLink(s.pullRequest),
          el('span', { title: 'エージェント' }, icon(s.provider in PROVIDER ? s.provider : 'agent', 's'), PROVIDER[s.provider]),
          s.model && el('span', { title: 'モデル' }, icon('model', 's'), s.model),
          s.effort && el('span', { title: '思考量' }, icon('bolt', 's'), EFFORT[s.effort] ?? s.effort),
          s.approvalMode !== 'ask' && el('span', { title: '承認の任せ方' }, icon('shield', 's'), APPROVAL[s.approvalMode]),
          el('span', { title: res ? `${res.scope}（${clock(new Date(res.sampledAt))}計測）` : '' }, icon('chip', 's'),
            !s.live ? 'プロセスなし' : res ? `${res.shared ? '共有 ' : ''}${res.processCount}プロセス ${mb(res.workingSetBytes)}` : '計測待ち'),
          s.background?.length && el('span', { title: 'エージェントがバックグラウンドで動かしている作業' }, icon('running', 's'), s.background.join('、')),
          s.resumability === 'unrecoverable' && el('span', { class: 'red' }, icon('error', 's'), '再開できません'));
        const ib = (ic, label, onclick, cls = '') => el('button', { class: `ib ${cls}`, title: label, 'aria-label': label, onclick, disabled: !!s.busyWith }, icon(ic, 's'));
        put(acts,
          busy && ib('stop', s.lifecycle === 'queued' ? '取り消す' : '中断する', () => act(id, 'interrupt')),
          waitsBg && ib('done', 'バックグラウンドの作業を待たずに、いまの返答を完了として扱う', () => act(id, 'finish')),
          !busy && s.live && s.provider === 'claude' && ib('power', 'メモリを空ける（プロセスを終了します。会話は残り、次の指示で再開します）', () => act(id, 'stop')),
          leftovers && ib('trash', `残ったプロセス${res.processCount}個を終了`, () => confirm(`この作業が残した ${res.processCount} 個のプロセスを終了します。`) && act(id, 'cleanup'), 'danger'),
          !busy && !s.archived && ib('archive', '片付ける（会話も履歴も消えず、いつでも戻せます）', () => { act(id, 'archive'); go('#/'); }),
          s.archived && ib('restore', '一覧に戻す', () => act(id, 'unarchive')),
          // Calling it done is the human's call at any point; an agent still on it is stopped first (after asking).
          s.completion === 'accepted'
            ? el('button', { class: 'done-btn', title: '完了を取り消して作業に戻す', onclick: () => act(id, 'reopen') }, icon('restore', 's'), '作業に戻す')
            : el('button', { class: 'done-btn primary', title: 'この作業を完了にして片付ける（いつでも戻せます）', onclick: async () => { if (await finishWork(s)) go('#/'); } }, icon('check', 's'), '完了にする'),
          others.length > 0 && el('button', { class: 'primary', title: `次の判断待ちへ（${others.length}件）`, 'aria-label': `次の判断待ちへ（${others.length}件）`, onclick: () => go(`#/s/${others[0].sessionId}`) }, icon('attention', 's'), String(others.length)));
        err.textContent = store.errors.get(id) ?? s.error ?? '';
        const steps = s.completion === 'human_steps' ? s.task?.humanSteps ?? [] : [];
        const stepsMode = steps.length > 0 && stepsShown.get(id) !== false;
        screen.classList.toggle('steps-mode', stepsMode);
        // The record is hidden while the steps are shown: what the work waits for then stays above the composer.
        if (stepsMode) { if (pending.parentNode !== footInner) footInner.prepend(pending); }
        else if (pending.parentNode !== body) body.insertBefore(pending, jump);
        const toggle = (yes, label) => el('button', { class: 'quiet steps-toggle', onclick: () => showSteps(yes) }, icon(yes ? 'user' : 'terminal', 's'), label);
        put(stepsSlot, steps.length > 0 && (stepsMode ? toggle(false, 'これまでの経過を見る') : toggle(true, '作業を表示する')));
        if (stepsMode) put(verdict, stepsBox(s, { titled: false }));
        else if (steps.length) {
          const left = steps.filter((x) => !x.done).length;
          put(verdict, el('div', { class: 'verdict-line' }, icon('user', 'amber'), el('strong', {}, 'あなたの作業'), el('span', { class: 'note' }, `残り${left}件`)));
        } else put(verdict, verdictNodes(s));
        const sendWord = holds ? '終わったら送る' : s.live ? '送る' : '再開して送る';
        put(send, icon(holds ? 'clock' : s.live ? 'send' : 'restore'));
        send.title = `${sendWord} (${SEND_KEYS})`;
        send.setAttribute('aria-label', sendWord);
        text.placeholder = holds ? '次に頼むことを書いておけます（いまの作業が終わったら自動で送ります）' : s.lifecycle === 'interrupted' ? '続きの指示を書く' : '追加の指示を書く';
        put(held, s.deferredMessage && el('div', { class: 'held-box' }, icon('send', 's'), el('div', { class: 'text' }, s.deferredMessage), el('button', { class: 'quiet', onclick: () => act(id, 'unsend') }, icon('x', 's'), '取り消す')));
        put(hint, s.lifecycle === 'queued' ? '順番が来たら自動で始まります' : s.lifecycle === 'waiting_for_user' ? '上の依頼に答えると進みます' : waitsBg ? 'バックグラウンドの作業が終わると、エージェントが続きを始めます' : busy ? '作業が終わったら自動で届きます'
          : [el('kbd', { title: 'Tabで次の作業へ' }, 'Tab'), icon('down', 's')]);
      }
      const known = new Set([...pending.children].map((n) => n.dataset.key));
      const stick = atBottom();
      sync(pending, mine, (i) => i.id, ticketSig, (i) => ticket(i, { linkToSession: false }));
      // A request that just arrived is brought into view if the record was followed to its end; otherwise the arrow shows it is there.
      if (mine.some((i) => !known.has(String(i.id)))) {
        if (stick) body.scrollTop = body.scrollHeight;
        else jump.hidden = false;
      }
      if (rev < 0) { rev = s.transcriptRev; load(true); }
      else if (s.transcriptRev !== rev) { rev = s.transcriptRev; load(false); }
    },
  };
}
