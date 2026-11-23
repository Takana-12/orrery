import { act } from '../../logic/actions.js';
import { ARCHIVE_FOLD, archiveModel } from '../../logic/selectors.js';
import { store } from '../../logic/store.js';
import { $, el, sync } from '../dom.js';
import { icon } from '../icons.js';
import { go } from '../shell.js';
import { lamp, ptag } from '../vocabulary.js';

// What was typed in the search box and which projects were opened in full stay while the app is open.
const kept = { query: '', open: new Set() };

/** Put-away work: a search box on top, then one section per project showing its latest few, "もっと見る" for the rest. */
export function archiveView() {
  const list = el('div', { class: 'arch-groups' });
  const empty = el('p', { class: 'note' });
  const search = el('input', { type: 'search', class: 'arch-q', placeholder: 'アーカイブを検索（タイトル・プロジェクト）', 'aria-label': 'アーカイブを検索', value: kept.query });
  const clear = el('button', { type: 'button', class: 'quiet arch-clear', 'aria-label': '検索をクリア', title: 'クリア (Esc)' }, icon('x', 's'));
  const paint = () => view.update();
  search.addEventListener('input', () => { kept.query = search.value; paint(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = kept.query = ''; paint(); } });
  clear.addEventListener('click', () => { search.value = kept.query = ''; paint(); search.focus(); });
  const row = (s) =>
    el('div', { class: 'row' }, lamp(s.lifecycle),
      el('button', { class: 'quiet', onclick: () => go(`#/s/${s.id}`) }, ptag(s.provider), s.taskTitle),
      el('button', { onclick: () => act(s.id, 'unarchive') }, icon('restore', 's'), '一覧に戻す'),
      el('span', { class: 'x' }, new Date(s.updatedAt).toLocaleString()));
  $('main').replaceChildren(el('div', { class: 'pad' },
    el('h1', {}, icon('archive', 'l'), 'アーカイブ', el('button', { class: 'quiet narrow-only', onclick: () => go('#/') }, icon('back', 's'), '戻る')),
    el('div', { class: 'arch-search' }, icon('search', 's dim'), search, clear),
    list, empty));
  const view = {
    key: 'archive',
    update() {
      const q = kept.query.trim();
      clear.hidden = !search.value;
      const groups = archiveModel(store.state, q);
      empty.hidden = groups.length > 0;
      empty.textContent = q ? `「${q}」に一致するアーカイブはありません。` : 'アーカイブはありません。';
      // While searching every match is shown; otherwise each project shows its latest few until opened in full.
      sync(list, groups, (g) => g.key, (g) => {
        const all = !!q || kept.open.has(g.key);
        return `${all}|${g.name}|${g.sessions.map((s) => `${s.id}:${s.lifecycle}:${s.taskTitle}:${s.updatedAt}`).join(',')}`;
      }, (g) => {
        const all = !!q || kept.open.has(g.key);
        const shown = all ? g.sessions : g.sessions.slice(0, ARCHIVE_FOLD);
        const rest = g.sessions.length - shown.length;
        return el('section', { class: 'arch-group' },
          el('h2', {}, icon('folder', 'dim'), g.name, el('span', { class: 'n' }, String(g.sessions.length))),
          shown.map(row),
          rest > 0 && el('div', { class: 'arch-more' }, el('button', { type: 'button', class: 'quiet', onclick: () => { kept.open.add(g.key); paint(); } }, `もっと見る（あと${rest}件）`)),
          !q && kept.open.has(g.key) && g.sessions.length > ARCHIVE_FOLD && el('div', { class: 'arch-more' }, el('button', { type: 'button', class: 'quiet', onclick: () => { kept.open.delete(g.key); paint(); } }, 'たたむ')));
      });
    },
  };
  return view;
}
