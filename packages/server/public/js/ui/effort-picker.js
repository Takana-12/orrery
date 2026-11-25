// Only the next reply's effort. The work's provider and model cannot be changed from this control.
import { ensureModels, modelsOf, sessionEfforts } from '../logic/ai.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { menuItem, openMenu } from './menu.js';
import { EFFORT } from './vocabulary.js';

export function effortPicker({ value, onChange }) {
  let choice = value;
  let shown = null;
  const word = el('span', { class: 'v' });
  const node = el('button', { type: 'button', class: 'chip effort-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('bolt', 's'), word, icon('down', 'caret'));
  const paint = () => {
    // Always paint the saved/drafted value, even before the model list arrives. Never substitute a middle/default level.
    word.textContent = EFFORT[choice.effort] ?? choice.effort ?? '既定';
    node.title = `次の返答の思考量: ${word.textContent}`;
    node.setAttribute('aria-label', node.title);
  };
  node.addEventListener('click', () => {
    const needsList = modelsOf(choice.provider)?.status !== 'ready';
    const loading = ensureModels(choice.provider);
    openMenu(node, ({ close, repaint, menu }) => {
      shown = { menu, repaint };
      const entry = modelsOf(choice.provider);
      if (entry?.status === 'loading') return el('div', { class: 'ai-note' }, icon('running', 's spin'), '読み込み中');
      if (entry?.status === 'failed') return el('div', { class: 'ai-note', role: 'alert' }, icon('error', 's'), '思考量を取得できませんでした');
      const levels = sessionEfforts(choice);
      if (!levels.length) return el('div', { class: 'ai-note' }, icon('info', 's'), 'このモデルでは思考量を選べません');
      return levels.map((effort) => menuItem({ ic: 'bolt', label: EFFORT[effort] ?? effort, checked: choice.effort === effort,
        onpick: () => {
          choice = { ...choice, effort };
          paint();
          close();
          onChange?.(effort);
        } }));
    }, '次の返答の思考量');
    if (needsList) loading.then(() => { if (shown?.menu.isConnected) shown.repaint('.menu-item[aria-checked=true], .menu-item'); });
  });
  paint();
  return { node, set: (next) => { choice = next; paint(); } };
}
