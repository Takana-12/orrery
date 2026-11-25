// Menus: a small panel that opens right at the control that asked for it, and the chip that shows a choice.
import { el, put } from './dom.js';
import { icon } from './icons.js';

/**
 * fill({ close, repaint, menu }) returns the menu's children. repaint(selector) rebuilds it and focuses the match.
 * `cls`: extra classes for the menu itself.
 */
export function openMenu(anchor, fill, label, cls = '') {
  if (performance.now() - (anchor._closedAt ?? 0) < 200) return; // the click that just dismissed it
  const m = el('div', { class: `menu ${cls}`.trim(), popover: 'auto', role: 'menu', 'aria-label': label });
  const close = () => { if (m.isConnected) m.hidePopover(); };
  const repaint = (focus) => { put(m, fill({ close, repaint, menu: m })); if (focus) m.querySelector(focus)?.focus(); };
  m.addEventListener('toggle', (e) => {
    if (e.newState !== 'closed') return;
    const hadFocus = m.contains(document.activeElement);
    m.remove();
    anchor._closedAt = performance.now();
    anchor.setAttribute('aria-expanded', 'false');
    if (hadFocus || document.activeElement === document.body) anchor.focus();
  });
  m.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the page's own shortcuts (n, i, Tab, Escape) must not fire from inside a menu
    const a = document.activeElement;
    const stops = [...m.querySelectorAll('.menu-item:not(:disabled), .fx-bar[aria-checked=true]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stops[(stops.indexOf(a) + (e.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length]?.focus();
      e.preventDefault();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && a?.classList.contains('fx-bar')) {
      (e.key === 'ArrowLeft' ? a.previousElementSibling : a.nextElementSibling)?.click();
      e.preventDefault();
    } else if (/^[1-9]$/.test(e.key)) {
      m.querySelector(`[data-n="${e.key}"]`)?.click();
      e.preventDefault();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  });
  document.body.append(m);
  repaint();
  m.showPopover();
  anchor.setAttribute('aria-expanded', 'true');
  // Below the control when it fits; above it when the control sits low on the screen.
  const a = anchor.getBoundingClientRect();
  const h = m.offsetHeight;
  const above = a.bottom + 6 + h > innerHeight - 8 && a.top - 6 - h >= 8;
  m.style.setProperty('top', `${Math.max(8, above ? a.top - 6 - h : Math.min(a.bottom + 6, innerHeight - h - 8))}px`);
  m.style.setProperty('left', `${Math.max(8, Math.min(a.left, innerWidth - m.offsetWidth - 8))}px`);
  (m.querySelector('.menu-item[aria-checked=true]') ?? m.querySelector('.menu-item'))?.focus(); // also scrolls it into view
}
export const menuItem = ({ ic, label, sub, checked, n, title, onpick }) =>
  el('button', { type: 'button', class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(!!checked), 'data-n': n ?? null, title: title ?? null, onclick: onpick },
    ic && icon(ic, 's dim'),
    el('span', { class: 'tx' }, el('span', {}, label), sub && el('span', { class: 'sub' }, sub)),
    checked ? icon('check', 's ion') : n ? el('kbd', {}, String(n)) : null);

/**
 * A chip that shows the current choice and opens a menu of the others.
 * options: [{ value, label, short?, sub?, icon?, sep? }]. Returns { node, get, set(value, options?) }.
 */
export function picker({ ic, label, options, value, onChange, iconOnly = false }) {
  let opts = options;
  let val = value;
  const slot = el('span', { class: 'ic' });
  const v = el('span', { class: 'v' });
  const node = el('button', { type: 'button', class: iconOnly ? 'chip icon-only' : 'chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, slot, v, icon('down', 'caret'));
  const paint = () => {
    const o = opts.find((x) => x.value === val);
    put(slot, icon(o?.icon ?? ic, 's'));
    v.textContent = iconOnly ? '' : (o?.short ?? o?.label ?? '');
    node.title = iconOnly ? `${label}: ${o?.label ?? ''}` : label;
    node.setAttribute('aria-label', `${label}: ${o?.label ?? ''}`);
  };
  node.addEventListener('click', () => openMenu(node, ({ close }) => opts.map((o, i) => [
    o.sep && el('hr', {}),
    menuItem({ ic: o.icon, label: o.label, sub: o.sub, checked: o.value === val, n: i < 9 ? i + 1 : null, onpick: () => { val = o.value; paint(); close(); onChange?.(val); } }),
  ]), label));
  paint();
  return { node, get: () => val, set: (x, next) => { val = x; if (next) opts = next; paint(); } };
}

/**
 * A chip for "any number of these": each item in its menu is ticked or not, and a click flips it at once; the menu
 * stays open so several can be ticked in a row. The chip shows the first ticked (the main one) and how many more.
 * options: [{ value, label, sub? }]. actions: items at the foot that do something else ({ label, icon, onpick }); they
 * close the menu. Returns { node, get, set(values, options?) }. `get()` keeps the order things were ticked in.
 */
export function multiPicker({ ic, label, options, value, onChange, actions = [], empty = '' }) {
  let opts = options;
  let vals = [...value];
  const v = el('span', { class: 'v' });
  const more = el('span', { class: 'more' });
  const node = el('button', { type: 'button', class: 'chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon(ic, 's'), v, more, icon('down', 'caret'));
  const labelOf = (x) => opts.find((o) => o.value === x)?.label ?? '';
  const paint = () => {
    const names = vals.map(labelOf).filter(Boolean);
    v.textContent = names[0] ?? empty;
    more.textContent = names.length > 1 ? `+${names.length - 1}` : '';
    node.title = names.length ? `${label}: ${names.join('、')}` : label;
    node.setAttribute('aria-label', node.title);
  };
  const flip = (x) => {
    vals = vals.includes(x) ? vals.filter((y) => y !== x) : [...vals, x];
    paint();
    onChange?.([...vals]);
  };
  node.addEventListener('click', () => openMenu(node, ({ close, repaint }) => [
    opts.map((o, i) => {
      const b = menuItem({ ic: o.icon, label: o.label, sub: o.sub, checked: vals.includes(o.value), n: i < 9 ? i + 1 : null, onpick: () => { flip(o.value); repaint(`[data-v="${CSS.escape(o.value)}"]`); } });
      b.role = 'menuitemcheckbox';
      b.dataset.v = o.value;
      return b;
    }),
    actions.map((a, i) => [i === 0 && opts.length > 0 && el('hr', {}), menuItem({ ic: a.icon, label: a.label, onpick: () => { close(); a.onpick(); } })]),
  ], label));
  paint();
  return { node, get: () => [...vals], set: (x, next) => { vals = [...x]; if (next) opts = next; paint(); } };
}
