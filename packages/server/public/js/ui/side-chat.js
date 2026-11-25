// Side chats: small windows at the bottom right, over whatever screen is open (Ctrl+M opens one; several may be open).
// A window can be dragged by its title bar to anywhere on the screen; a double click on the title bar puts it back in the dock.
// Each has its conversation, a box to write in, attachments and the AI chip — and nothing about a workspace.
import { chatBusy, chatOf, closeChat, confirmChatSent, interruptChat, loadChatTranscript, sendChat, setChatChoice, setChatMinimized, syncChatWindows } from '../logic/chats.js';
import { store } from '../logic/store.js';
import { toolSummary } from '../logic/text.js';
import { aiPicker } from './ai-picker.js';
import { attachments } from './attachments.js';
import { $, autoGrow, el, put, sync } from './dom.js';
import { icon } from './icons.js';
import { richText } from './task-parts.js';
import { PROVIDER } from './vocabulary.js';

/** Width of one open window plus the gap, for working out how many fit side by side. */
const WINDOW_W = 392;
/** How many chat windows fit open next to each other on this screen. */
export const chatRoom = () => Math.max(1, Math.floor((innerWidth - 24) / WINDOW_W));

// A window moved off the dock stays inside the screen when the screen gets smaller.
addEventListener('resize', () => { for (const n of $('chats')?.children ?? []) n._place?.(); });

/** Draw the windows (called with every redraw of the page). */
export function drawChats() {
  syncChatWindows();
  const dock = $('chats');
  dock.hidden = store.shuttingDown;
  sync(dock, store.chatWindows, (w) => w.key, (w) => w.key, chatWindow);
  for (const n of dock.children) n._update?.();
}

/** One line of the conversation. Only what the AI said is read as Markdown; tool use is one quiet line. */
function entryNode(e) {
  if (e.role === 'user') return el('div', { class: 'sc-msg user' }, el('div', { class: 'text' }, e.text));
  if (e.role === 'assistant') return el('div', { class: 'sc-msg ai' }, el('div', { class: 'text rich' }, richText(e.text)));
  if (e.role === 'tool') {
    if (/^[✔✖] /.test(e.text)) return null; // what a lookup returned: the answer says what mattered
    const { glyph, line } = toolSummary(e.text);
    return el('div', { class: 'sc-msg tool' }, icon(glyph, 's'), el('span', {}, line));
  }
  return el('div', { class: 'sc-msg system' }, e.text);
}

function chatWindow(w) {
  const title = el('span', { class: 'sc-title' });
  const lamp = el('span', { class: 'sc-lamp' });
  const agent = el('span', { class: 'sc-agent' });
  const minBtn = el('button', { type: 'button', class: 'quiet ib', onclick: (e) => { e.stopPropagation(); setChatMinimized(w, !w.minimized); } });
  const closeBtn = el('button', { type: 'button', class: 'quiet ib', title: '閉じる（このチャットは残りません）', 'aria-label': 'チャットを閉じる', onclick: (e) => { e.stopPropagation(); closeChat(w); } }, icon('x', 's'));
  const head = el('header', { class: 'sc-head' }, agent, title, lamp, el('span', { class: 'grow' }), minBtn, closeBtn);
  // A folded window opens again from anywhere on its title bar (unless the press was the end of a drag).
  let dragged = false;
  head.addEventListener('click', () => { if (dragged) { dragged = false; return; } if (w.minimized) setChatMinimized(w, false); });

  const empty = el('div', { class: 'sc-empty' }, icon('message', 'l dim'), el('div', {}, '雑談やちょっとした質問にどうぞ'), el('div', { class: 'note' }, 'ファイルの添付もできます。作業のフォルダには触れません。'));
  const log = el('div', { class: 'sc-log' });
  const outbox = el('div', { class: 'sc-log' });
  const typing = el('div', { class: 'sc-typing', hidden: true }, el('i'), el('i'), el('i'));
  const errLine = el('div', { class: 'err', role: 'alert' });
  const body = el('div', { class: 'sc-body' }, empty, log, outbox, typing, errLine);

  const text = el('textarea', { rows: '1', 'aria-label': 'メッセージ', placeholder: 'メッセージ（Ctrl+Enterで送信・Enterで改行）' });
  text.value = w.draft ?? '';
  text.addEventListener('input', () => { w.draft = text.value; });
  const sendBtn = el('button', { type: 'button', class: 'primary ib' });
  const card = el('div', { class: 'composer' });
  const att = attachments(`chat:${w.key}`, text, card, (m) => { w.error = m; paintErr(); });
  const ai = aiPicker({ value: w.choice, label: 'このチャットのAI', onChange: (c) => setChatChoice(w, c) });
  card.append(text, el('div', { class: 'bar one-line' }, att.button, ai.node, el('span', { class: 'grow' }), sendBtn));
  const foot = el('div', { class: 'sc-foot' }, att.tray, card);
  const node = el('section', { class: 'side-chat', role: 'dialog', 'aria-label': 'サイドチャット' }, head, body, foot);
  // The page's own keys (Space, n, j, k ...) are not for this window, whatever has focus in it.
  // Escape only lets go of the box; it does not leave the screen behind the window.
  node.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') document.activeElement?.blur?.();
    e.stopPropagation();
  });

  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const toBottom = () => { body.scrollTop = body.scrollHeight; };
  const paintErr = () => {
    const c = chatOf(w);
    errLine.textContent = w.error || (c?.state === 'error' ? c.error ?? '' : c?.state === 'interrupted' ? '途中で止めました' : '');
    errLine.classList.toggle('note', !w.error && c?.state === 'interrupted');
  };

  // The record is fetched from the end of what is shown, whenever the server says it grew.
  let lastSeq = 0;
  let rev = -1;
  let loading = false;
  async function load() {
    if (loading || !w.chatId) return;
    loading = true;
    const id = w.chatId;
    const r = await loadChatTranscript(id, lastSeq);
    loading = false;
    if (r.status !== 200 || w.chatId !== id) return;
    const stick = atBottom();
    for (const e of r.body.entries) { const n = entryNode(e); if (n) log.append(n); }
    if (r.body.entries.length) lastSeq = r.body.entries.at(-1).seq;
    confirmChatSent(w, r.body.entries.filter((e) => e.role === 'user').length);
    if (stick) toBottom();
    // More arrived meanwhile (or there was more than one page): fetch on.
    const c = chatOf(w);
    if (r.body.entries.length >= 200 || (c && c.transcriptRev !== rev)) { rev = c?.transcriptRev ?? rev; load(); }
  }

  const submit = async () => {
    if (chatBusy(w)) return;
    if (!att.ready()) { w.error = '添付の保存が終わるまでお待ちください'; return paintErr(); }
    if (!text.value.trim() && !att.count()) return;
    const words = (text.value.trim() || '添付ファイルを見てください。') + att.suffix();
    text.value = '';
    w.draft = '';
    autoGrow(text);
    att.clear();
    const r = sendChat(w, words);
    toBottom();
    const res = await r;
    if (res.status !== 200 && !text.value.trim()) {
      text.value = words; // give the words back
      w.draft = words;
      autoGrow(text);
    }
  };
  sendBtn.addEventListener('click', () => (chatBusy(w) ? interruptChat(w) : submit()));
  // Enter is a new line; Ctrl+Enter sends, as in every other box.
  text.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    submit();
  });

  // Moving the window: it follows the pointer from the moment it is pressed on the title bar and dragged a little.
  // Where it was put is kept on the window (w.pos), so redraws and folding leave it there.
  const place = () => {
    node.classList.toggle('floating', !!w.pos);
    if (!w.pos) { node.style.left = node.style.top = ''; return; }
    const x = Math.min(Math.max(0, w.pos.x), Math.max(0, innerWidth - node.offsetWidth));
    const y = Math.min(Math.max(0, w.pos.y), Math.max(0, innerHeight - node.offsetHeight));
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  };
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = node.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const sx = e.clientX;
    const sy = e.clientY;
    let moving = false;
    dragged = false;
    const move = (m) => {
      if (!moving && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
      if (!moving) { moving = true; node.classList.add('dragging'); }
      w.pos = { x: m.clientX - dx, y: m.clientY - dy };
      place();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      node.classList.remove('dragging');
      dragged = moving;
    };
    // Followed on the whole page: a quick drag leaves the title bar before the first move arrives.
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || !w.pos) return;
    w.pos = null;
    place();
  });
  node._place = place;

  let sig = '';
  node._update = () => {
    const c = chatOf(w);
    const busy = chatBusy(w);
    node.classList.toggle('min', w.minimized);
    place();
    const firstWords = w.outbox[0]?.text.trim().split('\n')[0].slice(0, 40);
    title.textContent = c?.title ?? firstWords ?? '新しいチャット';
    const s = [w.minimized, busy, w.stopping, c?.state, c?.error, w.error, w.choice.provider].join('|');
    if (s !== sig) {
      sig = s;
      put(agent, icon(w.choice.provider, 's'));
      agent.title = PROVIDER[w.choice.provider];
      put(lamp, busy && icon('running', 's spin'));
      put(minBtn, icon(w.minimized ? 'restore' : 'minus', 's'));
      minBtn.title = w.minimized ? '開く' : 'たたむ';
      minBtn.setAttribute('aria-label', minBtn.title);
      put(sendBtn, icon(busy ? 'stop' : 'send'));
      sendBtn.title = busy ? '返答を止める' : '送る (Ctrl+Enter)';
      sendBtn.setAttribute('aria-label', sendBtn.title);
      sendBtn.disabled = !!w.stopping;
      typing.hidden = !busy;
      paintErr();
    }
    ai.set(w.choice);
    empty.hidden = !!c || w.outbox.length > 0;
    const stick = atBottom();
    sync(outbox, w.outbox, (m) => m.id, (m) => String(m.sent), (m) => el('div', { class: 'sc-msg user unsent' }, el('div', { class: 'text' }, m.text)));
    if (stick) toBottom();
    if (c && c.transcriptRev !== rev) { rev = c.transcriptRev; load(); }
    if (w.focus && !w.minimized) {
      w.focus = false;
      requestAnimationFrame(() => { text.focus(); autoGrow(text); });
    }
  };
  return node;
}
