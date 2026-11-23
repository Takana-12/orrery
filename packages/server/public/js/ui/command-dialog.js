// The question asked before a command the agent asked for runs: exactly what will run, where, and what happens after.
// It can be turned off from here ("次からは表示しない"), and back on in the settings.
import { confirmsCommands, setSettings } from '../logic/actions.js';
import { el } from './dom.js';
import { icon, orrery } from './icons.js';

/** The same kind of question for anything else that cannot be taken back at once. Resolves true on `ok`. */
export function confirmAction({ heading, title, text, ok, okIcon = 'check' }) {
  return new Promise((done) => {
    const yes = el('button', { type: 'submit', class: 'primary', value: 'ok' }, icon(okIcon, 's'), ok);
    const d = el('dialog', { class: 'cmd-dialog', 'aria-labelledby': 'cmd-dialog-h' },
      el('form', { method: 'dialog' },
        el('div', { class: 'cd-head' }, orrery(3, 'cd-mark'),
          el('div', {}, el('h2', { id: 'cmd-dialog-h' }, heading), title && el('div', { class: 'note' }, title))),
        el('p', { class: 'note' }, text),
        el('div', { class: 'cd-foot' }, el('span'), el('span', { class: 'cd-acts' }, el('button', { type: 'submit', value: 'cancel' }, 'やめる'), yes))));
    d.addEventListener('keydown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
    d.addEventListener('close', () => { d.remove(); done(d.returnValue === 'ok'); });
    document.body.append(d);
    d.showModal();
    yes.focus();
  });
}

/**
 * Resolves true when the command may run. Without the question (turned off), it resolves true at once.
 * `forStep`: the command is one of the human's own steps, so its output will be read to update their list.
 */
export function confirmCommand({ command, cwd, title, forStep }) {
  if (!confirmsCommands()) return Promise.resolve(true);
  return new Promise((done) => {
    const skip = el('input', { type: 'checkbox' });
    const run = el('button', { type: 'submit', class: 'primary', value: 'run' }, icon('terminal', 's'), '実行する');
    const d = el('dialog', { class: 'cmd-dialog', 'aria-labelledby': 'cmd-dialog-h' },
      el('form', { method: 'dialog' },
        el('div', { class: 'cd-head' }, orrery(3, 'cd-mark'),
          el('div', {}, el('h2', { id: 'cmd-dialog-h' }, 'このコマンドを実行します'), title && el('div', { class: 'note' }, title))),
        el('pre', { class: 'cd-line' }, el('span', { class: 'cd-prompt', 'aria-hidden': 'true' }, '›'), command),
        el('div', { class: 'cd-where' }, icon('folder', 's'), el('span', {}, cwd)),
        el('p', { class: 'note' }, forStep
          ? '終わったら出力を読み、この作業が済んだか、ほかに必要なことがあるかを確かめて「あなたの作業」を更新します。入力を求めるコマンドには答えられません（10分で打ち切り）。'
          : '入力を求めるコマンドには答えられません（10分で打ち切り）。結果はこの下に表示され、エージェントに伝えることもできます。'),
        el('div', { class: 'cd-foot' },
          el('label', { class: 'cd-skip' }, skip, el('span', {}, '次からは表示しない')),
          el('span', { class: 'cd-acts' }, el('button', { type: 'submit', value: 'cancel' }, 'やめる'), run))));
    d.addEventListener('keydown', (e) => e.stopPropagation()); // the page's own shortcuts must not fire from inside
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); }); // a click on the backdrop
    d.addEventListener('close', () => {
      const ok = d.returnValue === 'run';
      // Turned off only by a confirmed run: ticking the box and then backing out changes nothing.
      if (ok && skip.checked) setSettings({ confirmCommands: false });
      d.remove();
      done(ok);
    });
    document.body.append(d);
    d.showModal();
    run.focus();
  });
}
