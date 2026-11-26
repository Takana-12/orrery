// Rail: the strip board. Every piece of work that is not put away, as one strip, grouped by what it waits for.
import { acceptAll, archiveAll, dismissSending, dropArrivedSending, loadUsage } from '../logic/actions.js';
import { ago, leftTone, mb, stamp } from '../logic/format.js';
import { usableAgents } from '../logic/ai.js';
import { BATTERY_CELLS, limitsModel, newVersionText, quietFor, railModel, workspacesOf } from '../logic/selectors.js';
import { store } from '../logic/store.js';
import { askUpdate } from './app-control.js';
import { confirmAction } from './command-dialog.js';
import { $, el, put, sync } from './dom.js';
import { icon } from './icons.js';
import { loginNotice } from './login-notice.js';
import { sectionAnchor, sectionInView, SETTINGS_SECTIONS } from './settings-sections.js';
import { go, render } from './shell.js';
import { lampFor, nowLine, PROVIDER, ptag, waitsForBackground, wordFor } from './vocabulary.js';

let rail = null;
function buildRail() {
  // Four lamps with counts. The first one is also the way back to the home screen.
  const tally = el('div', { class: 'tally', role: 'status' });
  const cells = {};
  for (const [k, label, ic, tone] of [['attention', '要対応', 'inbox', 'amber'], ['running', '実行中', 'running', 'blue'], ['finished', '返答が完了', 'done', 'green'], ['problems', '異常', 'error', 'red']]) {
    cells[k] = el('b', {}, '0');
    tally.append(k === 'attention'
      ? el('button', { class: 'home', onclick: () => go('#/'), title: `ホーム・${label} (Space)`, 'aria-label': `ホーム・${label}` }, icon(ic, tone), cells[k])
      : el('div', { title: label }, icon(ic, tone), el('span', { class: 'sr-only' }, label), cells[k]));
  }
  const home = tally.firstChild;
  const groups = el('div', {});
  const sendingBox = el('div', { class: 'sending-box' });
  const toc = settingsToc();
  const authBox = el('div', { class: 'auth-box' });
  const ram = el('span', {});
  const limits = el('button', { class: 'rail-limits', onclick: () => go('#/usage'), title: '各サービスの利用枠の残り。ほかのアプリでの利用も含みます（クリックで利用状況）' });
  $('rail').replaceChildren(
    tally,
    authBox,
    el('div', { class: 'rail-scroll' }, toc.node, sendingBox, groups),
    limits,
    el('div', { class: 'rail-foot' }, el('span', { class: 'grow', title: '' }, icon('chip', 's'), ram), el('button', { class: 'quiet', onclick: () => go('#/settings'), title: '設定 (Ctrl+,)', 'aria-label': '設定' }, icon('gear', 's')),
      el('button', { class: 'quiet', onclick: () => go('#/archive'), title: 'アーカイブ (Ctrl+H)', 'aria-label': 'アーカイブ' }, icon('archive', 's')),
      el('button', { class: 'quiet update-btn', onclick: askUpdate, title: '更新（ソースから作り直して開き直す）', 'aria-label': 'Orreryを更新' }, icon('restore', 's')),
      el('button', { class: 'quiet new-work-btn', onclick: () => go('#/new'), title: '新しい作業を始める (n)', 'aria-label': '新しい作業' }, icon('plus', 's'))));
  rail = { cells, home, groups, sendingBox, toc, authBox, ram, limits, sections: new Map() };
  // The plan limits are read here, for as long as the page lives: the rail is always on screen.
  loadUsage().then(() => paintLimits());
  setInterval(() => loadUsage().then(() => paintLimits()), 90_000);
}

/**
 * While the settings screen is open, the top of the rail is its table of contents instead of the work list.
 * A click marks the entry at once and scrolls the section to the top; scrolling by hand moves the mark along.
 */
function settingsToc() {
  const main = $('main');
  const items = new Map();
  // Set by a click and kept until the human scrolls by hand, so the smooth scroll (or a short section at the
  // bottom that cannot reach the top) does not move the mark away from what was clicked.
  let pinned = null;
  const mark = (id) => { for (const [k, b] of items) b.toggleAttribute('aria-current', k === id); };
  const node = el('div', { class: 'set-toc', hidden: true }, SETTINGS_SECTIONS.map((s) => {
    const b = el('button', { type: 'button', class: 'toc-row', onclick: () => {
      pinned = s.id;
      mark(s.id);
      document.getElementById(sectionAnchor(s.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } }, icon(s.icon, 's'), el('span', {}, s.title));
    items.set(s.id, b);
    return b;
  }));
  const follow = () => { if (!node.hidden && !pinned) mark(sectionInView(main)); };
  main.addEventListener('scroll', follow, { passive: true });
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) main.addEventListener(ev, () => { pinned = null; }, { passive: true });
  return {
    node,
    /** Show it (or not) for the screen now open; on opening, the mark starts at the top section. */
    show(on) {
      if (on === !node.hidden) return;
      node.hidden = !on;
      pinned = null;
      if (on) mark(SETTINGS_SECTIONS[0].id);
    },
  };
}

/** One battery: BATTERY_CELLS cells, lit from the left, coloured by how much is left. */
function battery(w) {
  const tone = w.left === null ? 'unknown' : leftTone(w.left);
  return el('span', { class: `batt t-${tone}`, 'aria-hidden': 'true' },
    ...Array.from({ length: BATTERY_CELLS }, (_, i) => el('i', { class: i < w.cells ? 'on' : '' })));
}

/** What is left of each service's 5-hour and weekly windows, as batteries. */
function paintLimits() {
  if (!rail) return;
  const model = limitsModel(store.limitsCache?.data, usableAgents());
  const sig = JSON.stringify(model);
  if (rail.limits.dataset.sig === sig) return;
  rail.limits.dataset.sig = sig;
  const WORD = { five_hour: '5h', weekly: '週' };
  put(rail.limits, model.map((p) => el('span', { class: 'lim-line' }, ptag(p.provider),
    ...p.windows.map((w) => el('span', {
      class: 'lim-cell' + (w.left === null ? ' dim' : ''),
      title: w.left === null ? `${PROVIDER[p.provider]} ${WORD[w.kind]}: 取得できていません` : `${PROVIDER[p.provider]} ${w.label ?? WORD[w.kind]}: 残り${w.left}%${w.resetsAt ? `（${stamp(w.resetsAt)}にリセット）` : ''}`,
    }, el('span', { class: 'lim-w' }, WORD[w.kind]), battery(w), el('b', { class: w.left === null ? '' : `t-${leftTone(w.left)}` }, w.left === null ? '—' : `${w.left}%`))))));
}
/** Minutes without a sign of life, for a session that should be showing some (not one that is knowingly waiting). */
const quiet = (s) => (s.busyWith || waitsForBackground(s) || s.lifecycle !== 'running' ? 0 : quietFor(s));

function strip(s, selected, pending) {
  return el('button', { class: 'strip', 'aria-current': selected ? 'page' : null, onclick: () => go(`#/s/${s.id}`), title: `${wordFor(s)}: ${s.taskTitle}` },
    lampFor(s),
    el('span', { class: 't' }, s.taskTitle),
    s.unread ? el('span', { class: 'new-dot', title: '結果をまだ見ていません' }) : pending ? el('span', { class: 'amber' }, String(pending)) : el('span', {}),
    el('span', { class: 'sub' }, ptag(s.provider), el('span', { class: 'p' }, workspacesOf(s)), el('span', { class: 'age' }, ago(s.lifecycleSince ?? s.updatedAt))),
    nowLine(s) && el('span', { class: 'now' + (quiet(s) ? ' quiet' : '') }, quiet(s) ? `${quiet(s)}分動きなし: ${s.activity.text}` : nowLine(s)),
    s.deferredMessage && el('span', { class: 'now', title: '終わったら送る指示があります' }, icon('send', 's'), el('span', { class: 'sr-only' }, '終わったら送る指示あり')));
}

export function renderRail(r) {
  if (!rail) buildRail();
  const c = store.state.counts;
  const model = railModel(store.state, store.showAllFinished);
  const { needsYou, live, pendingBy } = model;
  for (const [k, n] of [['attention', needsYou], ['running', c.running], ['finished', c.turnFinished], ['problems', c.problems]]) {
    rail.cells[k].textContent = n;
    rail.cells[k].parentElement.classList.toggle('zero', !n);
  }
  if (r.view === 'inbox') rail.home.setAttribute('aria-current', 'page');
  else rail.home.removeAttribute('aria-current');
  rail.ram.textContent = store.state.resources.processCount ? `${store.state.resources.processCount} × ${mb(store.state.resources.workingSetBytes)}` : '—';
  rail.ram.parentElement.title = store.state.resources.processCount ? `${store.state.resources.processCount}プロセス。${store.state.resources.scope}` : 'エージェントは動いていません';
  paintLimits();
  const ub = $('rail').querySelector('.update-btn');
  ub.classList.toggle('busy', !!store.updating);
  ub.disabled = !!store.updating;
  const nv = newVersionText(store.state.newVersion);
  ub.classList.toggle('has-new', !!nv && !store.updating);
  ub.title = nv ? `${nv}（押すと取り込んで更新）` : '更新（ソースから作り直して開き直す）';
  // Sign-in notices only for the subscriptions the human uses (設定 → 使うAI).
  const authSig = JSON.stringify([store.state.auth, usableAgents()]);
  if (rail.authBox.dataset.sig !== authSig) {
    rail.authBox.dataset.sig = authSig;
    put(rail.authBox, usableAgents().filter((p) => store.state.auth[p].loggedIn === false).map((p) => loginNotice(p)));
  }

  // On the settings screen the list gives way to the settings' table of contents (everything below stays).
  const onSettings = r.view === 'settings';
  rail.toc.show(onSettings);
  rail.sendingBox.hidden = rail.groups.hidden = onSettings;

  // Work just sent stays here until the control room lists it as a session.
  dropArrivedSending();
  put(rail.sendingBox, store.sending.map((x) => el('button', { class: 'strip sending' + (x.error ? ' failed' : ''), title: x.error ? `送れませんでした: ${x.error}` : '送信しています', onclick: () => { if (x.error) { dismissSending(x); go('#/new'); } } },
    x.error ? icon('error', 's red') : icon('running', 's blue spin'),
    el('span', { class: 't' }, x.title),
    el('span', { class: x.error ? 'red' : 'note' }, x.error ? '送れませんでした' : '送信中'),
    el('span', { class: 'sub' }, ptag(x.provider), el('span', { class: 'p' }, x.projectName), x.error && el('span', { class: 'age' }, '入力欄に戻しました')))));
  // How each group reads; which sessions are in it is decided by the logic layer (railModel).
  const LOOK = {
    wait: { label: 'あなたの判断待ち', icon: 'attention', tone: 'amber' },
    run: { label: '実行中', icon: 'running', tone: 'blue' },
    queue: { label: store.state.queue.blockedBy === 'memory' ? '順番待ち（空きメモリ不足）' : `順番待ち（同時に${store.state.settings.maxConcurrent}件まで）`, icon: 'clock', tone: 'dim' },
    bad: { label: '異常・中断', icon: 'error', tone: 'red' },
    done: { label: '返答が完了', icon: 'done', tone: 'green' },
  };
  for (const g of model.groups) {
    const d = { ...g, ...LOOK[g.key] };
    let sec = rail.sections.get(d.key);
    if (!sec) {
      const count = el('span', { class: 'n' });
      const head = el('div', { class: 'group' }, icon(d.icon, `s ${d.tone}`), el('span', { class: 'sr-only' }), count);
      const body = el('div', {});
      const more = el('button', { class: 'quiet more', hidden: true, onclick: () => { store.showAllFinished = !store.showAllFinished; render(); } });
      sec = { head, body, count, more };
      rail.sections.set(d.key, sec);
      rail.groups.append(head, body, more);
    }
    const total = d.total ?? d.list.length;
    sec.head.hidden = total === 0;
    sec.count.textContent = total;
    sec.head.childNodes[1].textContent = d.label;
    sec.head.title = d.label;
    sync(sec.body, d.list, (s) => s.id,
      (s) => [s.lifecycle, s.completion, s.queuePosition, s.unread, s.taskTitle, nowLine(s), quiet(s), !!s.deferredMessage, pendingBy.get(s.id) ?? 0, r.view === 'session' && r.id === s.id, ago(s.lifecycleSince ?? s.updatedAt)].join('|'),
      (s) => strip(s, r.view === 'session' && r.id === s.id, pendingBy.get(s.id)));
    if (d.key === 'done') {
      sec.more.hidden = total <= 8;
      sec.more.textContent = store.showAllFinished ? '新しい8件だけ表示' : `ほか${total - 8}件を表示`;
      const seen = model.seenFinished;
      if (!sec.tidy) {
        sec.tidy = el('button', { class: 'quiet more', title: '結果を見終わった作業を一覧から片付けます。何も消えず、いつでも戻せます' });
        sec.tidy.addEventListener('click', async () => {
          const list = sec.tidy._list ?? [];
          if (!list.length || !confirm(`結果を見終わった作業 ${list.length}件を片付けます。会話も履歴も消えません。`)) return;
          await archiveAll(list);
        });
        sec.more.after(sec.tidy);
      }
      // Every finished piece of work (also the ones folded away) called done at once. Work an action is still
      // going on (busyWith) is left alone.
      const doable = model.finishedAll.filter((x) => !x.busyWith);
      if (!sec.acceptAll) {
        sec.acceptAll = el('button', { class: 'quiet more accept-all', title: '返答が完了した作業をすべて完了にして片付けます（いつでも戻せます）' });
        sec.acceptAll.addEventListener('click', async () => {
          const list = sec.acceptAll._list ?? [];
          if (!list.length || !(await confirmAction({
            heading: `${list.length}件をすべて完了にします`,
            text: '返答が完了した作業をすべて完了にして片付けます。会話も履歴も消えず、アーカイブからいつでも作業に戻せます。',
            ok: 'すべて完了にする',
          }))) return;
          acceptAll(list);
        });
        sec.head.after(sec.acceptAll);
      }
      sec.acceptAll._list = doable;
      sec.acceptAll.hidden = !doable.length;
      if (sec.acceptAll.dataset.n !== String(doable.length)) {
        sec.acceptAll.dataset.n = doable.length;
        put(sec.acceptAll, icon('check', 's'), `${doable.length}件をすべて完了にする`);
      }
      sec.tidy._list = seen;
      sec.tidy.hidden = seen.length < 2;
      sec.tidy.textContent = `見終わった${seen.length}件を片付ける`;
    }
  }
  let empty = rail.groups.querySelector('.rail-empty');
  if (!live.length && !store.sending.length && !empty) rail.groups.prepend(el('div', { class: 'rail-empty' }, 'まだ作業がありません'));
  else if ((live.length || store.sending.length) && empty) empty.remove();
}
