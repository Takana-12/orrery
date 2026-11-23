// The render loop: rail + the screen the address asks for, redrawn whenever the store says something changed.
// Also what belongs to the page as a whole: notifications and the keyboard.
import { openChat } from '../logic/chats.js';
import { routeKey } from '../logic/route.js';
import { neighbour } from '../logic/selectors.js';
import { store } from '../logic/store.js';
import { $, el, sync } from './dom.js';
import { icon } from './icons.js';
import { renderRail } from './rail.js';
import { chatRoom, drawChats } from './side-chat.js';
import { go, render, route, ui } from './shell.js';
import { kindOf } from './vocabulary.js';
import { archiveView } from './views/archive.js';
import { envView } from './views/env.js';
import { homeView } from './views/home.js';
import { sessionView } from './views/session.js';
import { settingsView } from './views/settings.js';
import { usageView } from './views/usage.js';

function draw() {
  if (!store.state) return;
  const r = route();
  const key = routeKey(r);
  document.body.dataset.view = r.view;
  renderRail(r);
  if (!ui.view || ui.view.key !== key) {
    ui.view = r.view === 'session' ? sessionView(r.id) : r.view === 'archive' ? archiveView() : r.view === 'settings' ? settingsView() : r.view === 'usage' ? usageView() : r.view === 'env' ? envView(r.id) : homeView();
    $('main').scrollTop = 0;
  }
  ui.view.update(r);
  // The same number as the rail's first lamp: requests to answer plus work whose remaining steps are the human's.
  const n = store.state.counts.needsAttention + store.state.counts.humanTasks;
  if (r.view !== 'session') document.title = n ? `(${n}) 要対応 — Orrery` : 'Orrery';
  drawNotices();
  drawChats();
  drawShutdown();
  notify();
}

/** After the power button: cover the page at once, so nothing more can be clicked while the app stops. */
function drawShutdown() {
  let veil = document.querySelector('.shutdown-veil');
  if (!store.shuttingDown) return void veil?.remove();
  if (veil) return;
  veil = el('div', { class: 'shutdown-veil', role: 'status' }, icon('running', 'spin'), el('div', {}, 'Orreryを停止しています…'),
    el('div', { class: 'note' }, 'このウィンドウはまもなく閉じます。閉じない場合はこのタブを閉じてください。'));
  document.body.append(veil);
}

/** Short messages about something that happened away from where the human is looking (see store.notice). */
function drawNotices() {
  sync($('notices'), store.notices, (n) => n.id, (n) => n.text, (n) =>
    el('div', { class: `notice ${n.tone}` }, icon(n.tone === 'bad' ? 'error' : 'info', n.tone === 'bad' ? 's red' : 's'), el('span', {}, n.text),
      el('button', { type: 'button', class: 'quiet ib', title: '閉じる', 'aria-label': '閉じる', onclick: () => store.dismissNotice(n.id) }, icon('x', 's'))));
}

const notified = new Set();
let firstPaint = true;
let lastAnnounced = -1;
function notify() {
  const open = store.state.items.filter((i) => i.status === 'pending');
  const total = open.length + store.state.counts.humanTasks;
  if (total !== lastAnnounced) {
    lastAnnounced = total;
    $('live').textContent = total ? `要対応が${total}件あります` : '要対応はありません';
  }
  // Work whose agent is finished and whose remaining steps are the human's is news too, not only questions.
  for (const s of store.state.sessions) {
    if (s.archived || s.completion !== 'human_steps' || notified.has(`steps:${s.id}:${s.lifecycleSince}`)) continue;
    notified.add(`steps:${s.id}:${s.lifecycleSince}`);
    if (firstPaint || document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') continue;
    const left = (s.task?.humanSteps ?? []).filter((x) => !x.done);
    const note = new Notification(`あなたの作業: ${s.taskTitle}`, { body: left.map((x) => x.title).join(' / ').slice(0, 140), tag: `steps:${s.id}` });
    note.onclick = () => { window.focus(); go(`#/s/${s.id}`); };
  }
  for (const i of open) {
    if (notified.has(i.id)) continue;
    notified.add(i.id);
    if (firstPaint || document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') continue;
    const note = new Notification(`${kindOf(i).word}: ${i.taskTitle}`, { body: i.summary.slice(0, 140), tag: i.id });
    note.onclick = () => { window.focus(); go('#/'); };
  }
  firstPaint = false;
}

function onKey(e) {
  const a = document.activeElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName ?? '') && !/^(radio|checkbox)$/.test(a?.type ?? '');
  if (document.querySelector('.menu') || store.shuttingDown) return;
  // Ctrl+A opens a side chat from anywhere. In a box with something written in it, it keeps selecting all of it.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && !(typing && a.value)) {
    e.preventDefault();
    return void openChat(chatRoom());
  }
  // Ctrl+U usage, Ctrl+H archive, Ctrl+, settings: from anywhere, even while typing.
  const jump = { ',': '#/settings', u: '#/usage', h: '#/archive' }[e.key.toLowerCase()];
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && jump) {
    e.preventDefault();
    return void go(jump);
  }
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && route().view === 'session') {
    const order = [...document.querySelectorAll('.rail .strip')].map((n) => n.dataset.key);
    if (order.length > 1) {
      e.preventDefault();
      ui.focusComposer = true;
      go(`#/s/${neighbour(order, route().id, e.shiftKey)}`);
      return;
    }
  }
  if (e.key === 'Escape') {
    if (typing) a.blur();
    else if (route().view !== 'inbox') go('#/');
    return;
  }
  const cards = [...document.querySelectorAll('[data-item]')];
  const current = a?.closest?.('[data-item]');
  if (e.key === 'Enter' && e.ctrlKey && current) return void current.querySelector('[data-submit]')?.click();
  if (e.key === 'Enter' && !typing && current === a && current?.dataset.collapsed) { e.preventDefault(); return void current.querySelector('.tg')?.click(); }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  // Space and n both open the home screen from anywhere with the cursor already in the new-work box; i opens it as it is.
  // (Space also stops re-pressing whatever button has focus.)
  if (e.key === ' ' && !/^(radio|checkbox)$/.test(a?.type ?? '')) { go('#/new'); e.preventDefault(); }
  else if (e.key === 'n') { go('#/new'); e.preventDefault(); }
  else if (e.key === 'i') { go('#/'); e.preventDefault(); }
  else if (e.key === 'j' || e.key === 'k') {
    if (!cards.length) return;
    const idx = cards.indexOf(current);
    cards[Math.max(0, Math.min(cards.length - 1, idx < 0 ? 0 : idx + (e.key === 'j' ? 1 : -1)))].focus();
    e.preventDefault();
  } else if (/^[1-9]$/.test(e.key)) {
    const target = (current ?? cards[0])?.querySelector(`input[data-key="${e.key}"]`);
    if (target && !target.disabled) { target.click(); target.focus(); e.preventDefault(); }
  }
}

/** Start drawing: from now on every store change, address change and return to the tab redraws the page. */
export function mount() {
  store.subscribe(draw);
  window.addEventListener('hashchange', () => render());
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  setInterval(() => { if (store.state && document.visibilityState === 'visible') render(); }, 30000); // keep "3分" ages honest
}
