// こだわり: one editable prompt per section. Attachment limits and merging belong to the logic/core layers.
import { addKnowledgeEntry, copyText, markKnowledgeSeen, removeKnowledgeDomain, removeKnowledgeEntry, setKnowledgeDomain, setKnowledgeSettings, updateKnowledgeEntry } from '../../logic/actions.js';
import { domainClipboard, knowledgeModel, knowledgeUsage, tone } from '../../logic/knowledge.js';
import { store } from '../../logic/store.js';
import { $, el, sync } from '../dom.js';
import { icon } from '../icons.js';
import { go } from '../shell.js';
import { toggle } from './settings.js';

const fmt = (n) => Number(n).toLocaleString('ja-JP');
const TONE_WORD = { ok: '', warn: '上限に近づいています', full: '上限に達しています' };

/** Attachment character count, coloured by how close it is to the section limit. */
function paintCount(node, used, max, unit, what = '') {
  const t = tone(used, max);
  node.className = `kn-count ${t}`;
  node.textContent = `${fmt(used)} / ${fmt(max)} ${unit}`;
  node.title = [what, TONE_WORD[t]].filter(Boolean).join('・');
}
const countNode = (used, max, unit, what) => {
  const n = el('span', {});
  paintCount(n, used, max, unit, what);
  return n;
};

/** A button that copies what `text()` gives; its icon turns to a check the moment it is pressed. */
export function copyButton(text, label) {
  const b = el('button', { type: 'button', class: 'quiet ib copy', title: label, 'aria-label': label }, icon('copy', 's'));
  let timer = null;
  b.addEventListener('click', () => {
    b.replaceChildren(icon('check', 's'));
    b.classList.add('done');
    clearTimeout(timer);
    timer = setTimeout(() => { b.replaceChildren(icon('copy', 's')); b.classList.remove('done'); }, 1200);
    copyText(text()).then((ok) => { if (!ok) { clearTimeout(timer); b.replaceChildren(icon('copy', 's')); b.classList.remove('done'); } });
  });
  return b;
}

/** One section, one prompt. Copy keeps the full stored text; attachment alone is capped. */
function promptEditor(domain, entry, fresh) {
  const L = store.state.knowledge.limits;
  const original = entry?.text ?? '';
  const ta = el('textarea', { rows: '4', class: 'kn-text', 'aria-label': `${domain.name}のプロンプト`, placeholder: 'このセクションのこだわり', value: original });
  const count = el('span', {});
  const note = el('small', { class: 'note kn-limit-note', hidden: true });
  const save = el('button', { type: 'button', class: 'primary ib kn-save', title: '保存 (Ctrl+Enter)', 'aria-label': `${domain.name}を保存`, hidden: true }, icon('check', 's'));
  const dirty = () => ta.value.trim() !== original && !!ta.value.trim();
  const paint = () => {
    paintCount(count, ta.value.length, L.sectionText, '字', 'セクションの添付上限');
    note.hidden = ta.value.length <= L.sectionText;
    note.textContent = `添付は先頭${fmt(L.sectionText)}字まで。全文は保存されます。`;
    save.hidden = !dirty();
  };
  const commit = () => {
    if (!dirty()) return;
    save.hidden = true;
    if (entry) updateKnowledgeEntry(entry.id, { text: ta.value });
    else addKnowledgeEntry(domain.id, ta.value);
  };
  save.addEventListener('click', commit);
  ta.addEventListener('input', paint);
  ta.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ta.value = original; paint(); ta.blur(); }
  });
  paint();
  const remove = entry && el('button', { type: 'button', class: 'quiet ib danger', title: 'プロンプトを削除', 'aria-label': `${domain.name}のプロンプトを削除`, onclick: () => { if (confirm(`「${domain.name}」のプロンプトを削除します。`)) removeKnowledgeEntry(entry.id); } }, icon('trash', 's'));
  return el('div', { class: 'kn-entry' + (fresh ? ' fresh' : '') },
    el('div', { class: 'kn-line' }, fresh && el('span', { class: 'kn-new', title: '自動で記録したばかりのこだわり' }, '新'), ta),
    el('div', { class: 'kn-meta' }, count, el('span', { class: 'kn-acts' }, remove, save)), note);
}
const promptSig = (e, fresh) => [e?.id, e?.text, fresh].join('|');

/** Text that turns into a box on the pencil (Enter / leaving keeps, Esc cancels). */
function editable(text, { label, max, cls, onsave, placeholder = '' }) {
  const shown = el('span', { class: cls }, text || placeholder);
  if (!text) shown.classList.add('empty');
  const pen = el('button', { type: 'button', class: 'quiet ib pen', title: `${label}を変える`, 'aria-label': `${label}を変える` }, icon('pencil', 's'));
  const box = el('span', { class: 'kn-editable' }, shown, pen);
  pen.addEventListener('click', () => {
    const input = el('input', { type: 'text', value: text, maxlength: String(max), 'aria-label': label, placeholder });
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const next = input.value.replace(/\s+/g, ' ').trim();
      box.replaceChildren(shown, pen);
      if (keep && next !== text) { shown.textContent = next || placeholder; onsave(next); } else pen.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    box.replaceChildren(input);
    input.focus();
    input.select();
  });
  return box;
}

/** One section: its name, description, attachment usage and a single prompt editor. */
function domainSection(d, open) {
  const L = store.state.knowledge.limits;
  const always = toggle(`${d.name} を常に付ける`, (v) => setKnowledgeDomain(d.id, { always: v }), !!d.always);
  always.checked = !!d.always;
  const head = el('div', { class: 'kn-head' },
    el('button', { type: 'button', class: 'quiet ib fold', 'aria-expanded': String(open.has(d.id)), title: open.has(d.id) ? 'たたむ' : 'ひらく', onclick: () => { if (open.has(d.id)) open.delete(d.id); else open.add(d.id); store.changed(); } }, icon(open.has(d.id) ? 'down' : 'next', 's')),
    el('div', { class: 'kn-title' },
      editable(d.name, { label: '領域の名前', max: L.domainName, cls: 'kn-name', onsave: (v) => v && setKnowledgeDomain(d.id, { name: v }) }),
      editable(d.description, { label: '領域の説明', max: L.domainDescription, cls: 'kn-desc', placeholder: '説明（新しい作業に付けるかどうかは、この説明で決めます）', onsave: (v) => setKnowledgeDomain(d.id, { description: v }) })),
    el('div', { class: 'kn-side' },
      el('span', { class: 'kn-usage' }),
      copyButton(() => domainClipboard(store.state, d.id), `${d.name} をまとめてコピー`),
      el('label', { class: 'kn-always', title: 'どんな作業にも、この領域のこだわりを付けます' }, always, '常に付ける'),
      d.id !== 'other'
        ? el('button', { type: 'button', class: 'quiet ib danger', title: '領域を削除（中のこだわりは「その他」に移ります）', 'aria-label': `${d.name} を削除`, onclick: () => { if (confirm(`領域「${d.name}」を削除します。中のこだわりは「その他」に移ります。`)) removeKnowledgeDomain(d.id); } }, icon('trash', 's'))
        : el('span', { class: 'ib-space' })));
  const list = el('div', { class: 'kn-list' });
  const node = el('section', { class: 'kn-domain' }, head, list);
  return { node, list, usage: head.querySelector('.kn-usage') };
}
const domainSig = (d, open) => [d.name, d.description, d.always, open.has(d.id)].join('|');

export function knowledgeView() {
  // What was recorded by itself before this screen opened stays marked as new while it is open.
  const fresh = new Set(store.state.knowledge?.entries.filter((e) => !e.seen).map((e) => e.id) ?? []);
  const open = new Set(store.state.knowledge?.domains.map((d) => d.id) ?? []);
  markKnowledgeSeen();

  const kset0 = store.state.settings?.knowledge ?? {};
  const capture = toggle('指示からこだわりを記録する', (v) => setKnowledgeSettings({ capture: v }), kset0.capture !== false);
  const inject = toggle('新しい作業に付ける', (v) => setKnowledgeSettings({ inject: v }), kset0.inject !== false);
  const total = el('span', {});
  const totalNote = el('small', {});
  const domains = el('div', {});
  const sections = new Map();

  const L0 = store.state.knowledge?.limits;
  const newName = el('input', { type: 'text', placeholder: '新しい領域の名前', maxlength: String(L0?.domainName ?? 40), 'aria-label': '新しい領域の名前' });
  const newDesc = el('input', { type: 'text', placeholder: '説明（どんな作業に関係するか）', maxlength: String(L0?.domainDescription ?? 200), 'aria-label': '新しい領域の説明' });
  const domainCount = el('span', {});
  const addDomain = () => {
    const name = newName.value.trim();
    if (!name) return newName.focus();
    setKnowledgeDomain(null, { name, description: newDesc.value.trim() });
    newName.value = newDesc.value = '';
    newName.focus();
  };
  for (const i of [newName, newDesc]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addDomain(); } });

  $('main').replaceChildren(el('div', { class: 'pad settings knowledge' },
    el('h1', { class: 'kn-h1' }, el('button', { class: 'quiet', onclick: () => go('#/settings') }, icon('back', 's'), '設定'), icon('bulb', 'l'), 'こだわり',
      el('button', { type: 'button', class: 'kn-tune-open', title: '指示や要望を渡して、AIにこだわりとして整理してもらう', onclick: () => go('#/knowledge/tune') }, icon('message', 's'), 'AIと整える')),
    el('p', { class: 'note' }, 'セクションごとに、一つのプロンプトとして記録します。作業への添付は各セクション5,000字まで。'),
    el('section', { class: 'set-group' },
      el('div', { class: 'set-row' }, el('div', { class: 'lab' }, el('b', {}, '指示からこだわりを記録する'), el('small', {}, '新しい作業の指示・追加の指示・却下の理由を読み、繰り返し通用しそうなものを自動で記録します')), el('div', { class: 'ctl' }, capture)),
      el('div', { class: 'set-row' }, el('div', { class: 'lab' }, el('b', {}, '新しい作業に付ける'), el('small', {}, '記録したこだわりを、新しい作業の最初のメッセージに付けます')), el('div', { class: 'ctl' }, inject)),
      el('div', { class: 'set-row' }, el('div', { class: 'lab' }, el('b', {}, '送る量'), totalNote), el('div', { class: 'ctl' }, total))),
    domains,
    el('section', { class: 'set-group kn-new-domain' },
      el('h2', {}, icon('plus', 's'), '領域を追加', domainCount),
      el('div', { class: 'kn-new-row' }, newName, newDesc, el('button', { type: 'button', onclick: addDomain }, icon('plus', 's'), '追加')))));

  return {
    key: 'knowledge',
    update() {
      const st = store.state;
      if (!st.knowledge) return;
      const kset = st.settings.knowledge ?? { capture: true, inject: true };
      capture.checked = kset.capture !== false;
      inject.checked = kset.inject !== false;
      const u = knowledgeUsage(st);
      total.className = 'kn-count';
      total.textContent = `${fmt(u.total.chars)} 字`;
      total.title = 'すべてのセクションを添付した場合の文字数';
      totalNote.textContent = u.total.chars === 0
        ? 'まだ何も記録されていません'
        : u.total.routed
          ? `${fmt(u.total.routeThreshold)} 字を超えているため、作業に関係する領域だけを選んで付けます`
          : `${fmt(u.total.routeThreshold)} 字以下なので、すべて付けます`;
      paintCount(domainCount, st.knowledge.domains.length, u.limits.domains, '領域', '領域の数の上限');
      for (const x of [newName, newDesc]) x.disabled = st.knowledge.domains.length >= u.limits.domains;

      const model = knowledgeModel(st);
      // Areas keep their nodes while only their preferences change, so a box being typed in is never replaced.
      for (const [id, s] of sections) if (!model.some((m) => m.domain.id === id)) { s.node.remove(); sections.delete(id); }
      let prev = null;
      for (const { domain: d, entries } of model) {
        let s = sections.get(d.id);
        const sig = domainSig(d, open);
        if (!s || s.sig !== sig) {
          const fresh2 = domainSection(d, open);
          fresh2.sig = sig;
          if (s) s.node.replaceWith(fresh2.node);
          s = fresh2;
          sections.set(d.id, s);
        }
        const want = prev ? prev.nextSibling : domains.firstChild;
        if (s.node !== want) domains.insertBefore(s.node, want);
        prev = s.node;
        const du = u.perDomain.get(d.id);
        s.usage.replaceChildren(countNode(du.chars, du.maxChars, '字', 'セクションの添付上限'));
        s.list.hidden = !open.has(d.id);
        if (s.list.hidden) continue;
        const entry = entries[0];
        const isFresh = entry ? fresh.has(entry.id) || !entry.seen : false;
        sync(s.list, [{ key: d.id, entry }], (r) => r.key, (r) => promptSig(r.entry, isFresh), (r) => promptEditor(d, r.entry, isFresh));
      }
    },
  };
}
