// The AI chip: one control for who answers. Its menu lists the agents (Claude Code, Codex); pointing at one opens its
// models right beside it, and picking one there is the choice. How hard the chosen model thinks is set at the foot of
// the agents' column. Used by new work, the side chats and the settings.
import { AGENTS, defaultChoice, ensureModels, findModel, modelsOf, stillValid, withModel } from '../logic/ai.js';
import { el, put } from './dom.js';
import { icon } from './icons.js';
import { menuItem, openMenu } from './menu.js';
import { EFFORT, PROVIDER } from './vocabulary.js';

const effortWord = (e) => EFFORT[e] ?? e;
const same = (a, b) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;

/**
 * value: { provider, model, effort }. recall(provider): what picking an agent itself (not one of its models) chooses,
 * e.g. the model last used with it. onChange(choice) after every change made here.
 * Returns { node, get(), set(choice) } (set does not call onChange).
 */
export function aiPicker({ value, onChange, recall = (p) => defaultChoice(p), label = 'AIとモデル' }) {
  let choice = { ...value };
  const slot = el('span', { class: 'ic' });
  const name = el('span', { class: 'v' });
  const gauge = el('span', { class: 'fx-mini' });
  const node = el('button', { type: 'button', class: 'chip ai-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, slot, name, gauge, icon('down', 'caret'));
  const modelWord = (c) => (c.model ? findModel(c.provider, c.model)?.label ?? c.model : '既定');

  const paint = () => {
    const levels = findModel(choice.provider, choice.model)?.efforts ?? [];
    const at = levels.indexOf(choice.effort);
    put(slot, icon(choice.provider, 's'));
    name.textContent = modelWord(choice);
    put(gauge, levels.map((_, i) => el('i', { class: i <= at ? 'on' : '' })));
    gauge.hidden = !levels.length;
    node.title = `${label}: ${PROVIDER[choice.provider]}・${modelWord(choice)}${at >= 0 ? `・思考量 ${effortWord(choice.effort)}` : ''}`;
    node.setAttribute('aria-label', node.title);
  };
  const commit = (next) => {
    const changed = !same(next, choice);
    choice = { ...next };
    paint();
    if (changed) onChange?.({ ...choice });
  };

  // ---- the menu: agents on the left, the pointed agent's models beside it ----
  let menu = null;
  let subFor = null;
  const closeSub = () => {
    menu?.querySelector('.ai-sub')?.remove();
    for (const r of menu?.querySelectorAll('.ai-agent') ?? []) r.setAttribute('aria-expanded', 'false');
    subFor = null;
  };
  /** Show `p`'s models beside its row. focus: put the keyboard in the list. */
  const openSub = (p, close, focus = false) => {
    if (!menu) return;
    const row = menu.querySelector(`.ai-agent[data-agent="${p}"]`);
    if (!row) return;
    menu.querySelector('.ai-sub')?.remove();
    subFor = p;
    for (const r of menu.querySelectorAll('.ai-agent')) r.setAttribute('aria-expanded', String(r === row));
    const entry = modelsOf(p);
    const pick = (next) => { commit(next); close(); };
    const sub = el('div', { class: 'ai-sub', role: 'menu', 'aria-label': `${PROVIDER[p]} のモデル` },
      !entry || entry.status === 'loading'
        ? el('div', { class: 'ai-note' }, icon('running', 's spin'), '読み込んでいます…')
        : entry.status === 'failed'
          ? el('div', { class: 'ai-note' }, icon('error', 's'), 'モデルの一覧を取得できませんでした')
          : entry.models.map((m) => menuItem({ label: m.label, title: m.description ?? null, checked: choice.provider === p && choice.model === m.id, onpick: () => pick(withModel(choice, p, m)) })),
      el('hr', {}),
      menuItem({ ic: 'sliders', label: '既定', title: `${PROVIDER[p]} 側の設定のモデルと思考量を使う`, checked: choice.provider === p && choice.model === '', onpick: () => pick({ provider: p, model: '', effort: '' }) }));
    sub.addEventListener('keydown', (e) => {
      const items = [...sub.querySelectorAll('.menu-item')];
      const at = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (e.key === 'ArrowLeft') {
        row.focus();
        closeSub();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    menu.append(sub);
    // Beside the agent's row; on the left when there is no room on the right; moved up as far as it must to fit.
    const mb = menu.getBoundingClientRect();
    const rb = row.getBoundingClientRect();
    sub.style.top = `${rb.top - mb.top - 6}px`;
    const sb = sub.getBoundingClientRect();
    if (sb.right > innerWidth - 8) sub.classList.add('left');
    const over = sb.bottom - (innerHeight - 8);
    if (over > 0) sub.style.top = `${Math.max(8 - mb.top, rb.top - mb.top - 6 - over)}px`;
    if (focus) (sub.querySelector('.menu-item[aria-checked=true]') ?? sub.querySelector('.menu-item'))?.focus();
  };

  const fill = ({ close, repaint, menu: m }) => {
    menu = m;
    subFor = null;
    const levels = findModel(choice.provider, choice.model)?.efforts ?? [];
    const at = levels.indexOf(choice.effort);
    const agents = AGENTS.map((p) => {
      const row = el('button', { type: 'button', class: 'menu-item ai-agent', role: 'menuitemradio', 'aria-checked': String(choice.provider === p), 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-agent': p,
        title: `${PROVIDER[p]}（右のメニューでモデルを選ぶ）`,
        // The agent itself: the model last used with it.
        onclick: () => { commit(stillValid(recall(p), p)); close(); } },
        icon(p, 's dim'),
        el('span', { class: 'tx' }, el('span', {}, PROVIDER[p]), choice.provider === p && el('span', { class: 'sub plain' }, modelWord(choice))),
        icon('next', 's dim'));
      row.addEventListener('mouseenter', () => { if (subFor !== p) openSub(p, close); });
      row.addEventListener('focus', () => { if (subFor && subFor !== p) closeSub(); });
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        openSub(p, close, true);
      });
      return row;
    });
    return [
      el('div', { class: 'ai-col' }, agents),
      levels.length > 0 && [
        el('hr', {}),
        el('div', { class: 'fx', role: 'radiogroup', 'aria-label': '思考量', title: `思考量（${modelWord(choice)}）`, onfocusin: closeSub }, icon('bolt', 's dim'),
          el('div', { class: 'fx-bars' }, levels.map((l, i) => el('button', { type: 'button', role: 'radio', class: 'fx-bar' + (i <= at ? ' on' : ''), 'aria-checked': String(i === at), tabindex: i === at ? '0' : '-1', title: effortWord(l), 'aria-label': `思考量 ${effortWord(l)}`,
            onclick: () => { commit({ ...choice, effort: l }); repaint('.fx-bar[aria-checked=true]'); } }))),
          el('span', { class: 'fx-word' }, at >= 0 ? effortWord(levels[at]) : '')),
      ],
    ];
  };

  node.addEventListener('click', () => {
    // Both agents' lists are asked for now, so whichever is pointed at next is (usually) already there.
    for (const p of AGENTS) {
      if (modelsOf(p)?.status === 'ready') continue;
      ensureModels(p).then(() => {
        paint();
        if (menu?.isConnected && subFor === p) {
          const focused = menu.querySelector('.ai-sub')?.contains(document.activeElement);
          openSub(p, () => menu?.hidePopover(), focused);
        }
      });
    }
    openMenu(node, fill, label, 'ai-menu');
  });
  ensureModels(choice.provider).then(paint);
  paint();
  return {
    node,
    get: () => ({ ...choice }),
    set: (next) => {
      if (same(next, choice)) return;
      choice = { ...next };
      paint();
    },
  };
}
