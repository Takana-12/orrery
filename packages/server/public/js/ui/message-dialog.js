// The popup for writing a long message: a large box, × at the top right, 決定 at the bottom right.
// Used for a project's default message. It only collects the words; what happens to them is the caller's.
import { el } from './dom.js';
import { icon, orrery } from './icons.js';

/** Resolves with the new text on 決定, or null when closed with × / Esc / a click outside. */
export function editMessage({ heading, title, value = '', placeholder = '' }) {
  return new Promise((done) => {
    const box = el('textarea', { class: 'md-text', placeholder, 'aria-label': heading });
    box.value = value;
    const ok = el('button', { type: 'submit', class: 'primary', value: 'ok', title: '決定 (Ctrl+Enter)' }, icon('check', 's'), '決定');
    const d = el('dialog', { class: 'cmd-dialog msg-dialog', 'aria-labelledby': 'msg-dialog-h' },
      el('form', { method: 'dialog' },
        el('div', { class: 'cd-head' }, orrery(3, 'cd-mark'),
          el('div', { class: 'md-title' }, el('h2', { id: 'msg-dialog-h' }, heading), title && el('div', { class: 'note' }, title)),
          el('button', { type: 'submit', value: 'cancel', class: 'quiet ib md-close', title: '閉じる (Esc)', 'aria-label': '閉じる' }, icon('x', 's'))),
        box,
        el('div', { class: 'md-foot' }, ok)));
    d.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the page's own shortcuts must not fire from inside
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); d.close('ok'); }
    });
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
    d.addEventListener('close', () => { d.remove(); done(d.returnValue === 'ok' ? box.value : null); });
    document.body.append(d);
    d.showModal();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
}
