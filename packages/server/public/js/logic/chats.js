// Side chats: small windows beside the work for a passing question or a chat (Ctrl+A). Each window talks to one AI,
// has no workspace, and is not work: it never appears in the lists or the inbox. Closing a window ends its chat.
// As everywhere, what the human does shows at once: a message is in the window from the moment it is sent, and taken
// back with the reason if it could not be.
import { api } from './api.js';
import { store } from './store.js';

let seq = 0;
/** First messages on their way (their windows may have been closed meanwhile). */
let starting = 0;
const nextKey = () => `w${Date.now().toString(36)}${++seq}`;

/** What a new chat talks to: the settings' choice (設定 → サイドチャット). */
const defaultAi = () => ({ provider: 'claude', model: 'sonnet', effort: 'low', ...(store.state?.settings?.sideChat ?? {}) });

/**
 * A new, empty chat window, at once. Nothing is asked of the server until the first message.
 * `room`: how many windows fit open side by side; older ones fold to their title bar to make space.
 */
export function openChat(room = Infinity) {
  const w = { key: nextKey(), chatId: null, choice: defaultAi(), minimized: false, outbox: [], error: '', draft: '', pending: false, focus: true, confirmed: false };
  store.chatWindows.push(w);
  const open = store.chatWindows.filter((x) => !x.minimized);
  for (const x of open.slice(0, Math.max(0, open.length - Math.max(1, room)))) x.minimized = true;
  store.changed();
  return w;
}

/**
 * Keep the windows in step with the server's chats: a chat this page does not show yet (opened before a reload, or in
 * another window) gets a window; a window whose chat the server no longer has (closed elsewhere) goes.
 * Called before drawing; changes the list without asking for another redraw.
 */
export function syncChatWindows() {
  const chats = store.state?.chats ?? [];
  const ids = new Set(chats.map((c) => c.id));
  for (const w of [...store.chatWindows]) {
    if (!w.chatId) continue;
    if (ids.has(w.chatId)) w.confirmed = true;
    else if (w.confirmed) store.chatWindows.splice(store.chatWindows.indexOf(w), 1);
  }
  // A first message on its way: the chat it makes may show up before its id comes back. Wait for the id.
  if (starting) return;
  for (const c of chats) {
    if (store.closingChats.has(c.id) || store.chatWindows.some((w) => w.chatId === c.id)) continue;
    store.chatWindows.push({ key: nextKey(), chatId: c.id, choice: { provider: c.provider, model: c.model ?? '', effort: c.effort ?? '' }, minimized: false, outbox: [], error: '', draft: '', pending: false, focus: false, confirmed: true });
  }
}

/** The server's picture of a window's chat (null before its first message has been accepted). */
export const chatOf = (w) => (w.chatId ? (store.state?.chats ?? []).find((c) => c.id === w.chatId) ?? null : null);

/** The AI is answering (or about to: the message is on its way). */
export const chatBusy = (w) => w.pending || chatOf(w)?.state === 'running';

/** Say something in a chat. The first message starts the chat on the server. Answers { status, body }. */
export async function sendChat(w, text) {
  const mine = { id: ++seq, text, sent: false };
  w.outbox.push(mine);
  w.error = '';
  w.pending = true;
  store.changed();
  const first = !w.chatId;
  if (first) starting++;
  const r = first ? await api('/api/chats', { ...w.choice, prompt: text }) : await api(`/api/chats/${w.chatId}/message`, { text });
  if (first) starting--;
  w.pending = false;
  if (r.status === 200) {
    mine.sent = true;
    if (!w.chatId) {
      w.chatId = r.body.chatId;
      // Closed while the first message was on its way: end the chat that has just been made.
      if (!store.chatWindows.includes(w)) {
        store.closingChats.add(w.chatId);
        void api(`/api/chats/${w.chatId}/close`, {});
      }
    }
    // Shown until the conversation record has it (confirmChatSent), a minute at most.
    setTimeout(() => { dropOut(w, mine); store.changed(); }, 60_000).unref?.();
  } else {
    dropOut(w, mine);
    w.error = r.body.error || `送れませんでした (${r.status})`;
  }
  store.changed();
  return r;
}

const dropOut = (w, m) => {
  const at = w.outbox.indexOf(m);
  if (at >= 0) w.outbox.splice(at, 1);
};

/** The record now shows `count` more of the human's messages: their provisional copies have done their job. */
export function confirmChatSent(w, count) {
  for (let n = 0; n < count; n++) {
    const at = w.outbox.findIndex((m) => m.sent);
    if (at < 0) break;
    w.outbox.splice(at, 1);
  }
  if (count) store.changed();
}

/** Which AI the next message goes to. Shown at once; said in a notice if the server refuses. */
export async function setChatChoice(w, choice) {
  w.choice = { ...choice };
  store.changed();
  if (!w.chatId) return;
  const r = await api(`/api/chats/${w.chatId}/choice`, choice);
  if (r.status !== 200) store.notice(`チャットのAIを切り替えられませんでした: ${r.body.error || r.status}`);
}

/** Stop the answer that is being written. */
export async function interruptChat(w) {
  if (!w.chatId) return;
  w.stopping = true;
  store.changed();
  const r = await api(`/api/chats/${w.chatId}/interrupt`, {});
  w.stopping = false;
  if (r.status !== 200) w.error = r.body.error || '止められませんでした';
  store.changed();
}

export function setChatMinimized(w, minimized) {
  w.minimized = minimized;
  if (!minimized) w.focus = true;
  store.changed();
}

/** Close a window: it goes at once, and its chat ends (nothing of it is kept). */
export async function closeChat(w) {
  const at = store.chatWindows.indexOf(w);
  if (at >= 0) store.chatWindows.splice(at, 1);
  store.changed();
  if (!w.chatId) return;
  store.closingChats.add(w.chatId);
  const r = await api(`/api/chats/${w.chatId}/close`, {});
  if (r.status !== 200 && r.status !== 404) {
    store.closingChats.delete(w.chatId);
    store.notice(`チャットを閉じられませんでした: ${r.body.error || r.status}`);
    store.changed();
  }
}

export const loadChatTranscript = (chatId, after) => api(`/api/chats/${chatId}/transcript?after=${after}`);
