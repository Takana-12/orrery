// A warning popup that asks before something that cannot be taken back: heading, what will happen, and two buttons.
// It only asks; what happens on yes is the caller's.
import { el } from './dom.js';
import { icon } from './icons.js';

/** Resolves true on the action button, false on やめる / Esc / a click outside. The safe choice has the focus. */
export function confirmDanger({ heading, lines = [], action, actionIcon = 'power' }) {
  return new Promise((done) => {
    const cancel = el('button', { type: 'submit', value: 'cancel', class: 'quiet', title: 'やめる (Esc)' }, 'やめる');
    const d = el('dialog', { class: 'cmd-dialog msg-dialog warn-dialog', 'aria-labelledby': 'warn-dialog-h', role: 'alertdialog' },
      el('form', { method: 'dialog' },
        el('div', { class: 'cd-head' }, icon('error', 'red wd-mark'), el('h2', { id: 'warn-dialog-h' }, heading)),
        ...lines.filter(Boolean).map((t) => el('p', { class: 'wd-line' }, t)),
        el('div', { class: 'md-foot' }, cancel, el('button', { type: 'submit', value: 'ok', class: 'primary danger-fill' }, icon(actionIcon, 's'), action))));
    d.addEventListener('keydown', (e) => e.stopPropagation()); // the page's own shortcuts must not fire from inside
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
    d.addEventListener('close', () => { d.remove(); done(d.returnValue === 'ok'); });
    document.body.append(d);
    d.showModal();
    cancel.focus();
  });
}
