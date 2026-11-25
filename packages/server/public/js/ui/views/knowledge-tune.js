// こだわりを整える: a chat whose only job is the human's standing preferences. The human pastes instructions, prompts or
// wishes; nothing is carried out. The server's helper model reads the intent and changes the record at once; each reply
// lists what it changed, one icon + one word per kind (TUNE_CHANGE), with the area and the text as now recorded.
// The message appears the moment it is sent (tuneSendEffect); refused, it goes back into the box with the reason.
// Layout: the conversation fills the screen, the box sits at the bottom with send at its right end (Ctrl+Enter).
import { sendKnowledgeTune, setKnowledgeSettings } from '../../logic/actions.js';
import { tuneModel } from '../../logic/knowledge.js';
import { store } from '../../logic/store.js';
import { aiPicker } from '../ai-picker.js';
import { $, el, sync } from '../dom.js';
import { icon } from '../icons.js';
import { go } from '../shell.js';
import { TUNE_CHANGE } from '../vocabulary.js';

/** One change the reading made: what kind (icon + word), in which area, and the text. */
function changeRow(c) {
  const v = TUNE_CHANGE[c.kind] ?? TUNE_CHANGE.add;
  return el('li', { class: `kt-change ${c.kind}` },
    el('span', { class: `kt-kind ${v.tone}` }, icon(v.icon, 's'), v.word),
    el('span', { class: 'kt-domain' }, c.domain),
    c.text && el('span', { class: 'kt-text' }, c.text));
}

function messageNode(m) {
  if (m.role === 'human') return el('div', { class: 'sc-msg user' }, el('div', { class: 'text' }, m.text));
  return el('div', { class: 'sc-msg ai kt-ai' + (m.failed ? ' failed' : '') },
    m.text && el('div', { class: 'text' }, m.failed && icon('error', 's red'), m.text),
    m.changes?.length ? el('ul', { class: 'kt-changes' }, m.changes.map(changeRow)) : null);
}

export function knowledgeTuneView() {
  const choice = () => store.state.settings.knowledge?.tuneAi ?? { provider: 'claude', model: 'sonnet', effort: '' };
  const ai = aiPicker({ value: choice(), label: 'AIと整えるのAI', onChange: (c) => setKnowledgeSettings({ tuneAi: c }) });
  const log = el('div', { class: 'sc-log kt-log' });
  const typing = el('div', { class: 'sc-typing', hidden: true }, el('i'), el('i'), el('i'));
  const empty = el('div', { class: 'sc-empty' }, icon('bulb', 'l dim'), el('div', {}, '指示・プロンプト・要望をそのまま貼ってください'), el('div', { class: 'note' }, '実行はせず、意図を読み取ってこだわりに反映します'));
  const body = el('div', { class: 'kt-body' }, empty, log, typing);
  const max = tuneModel(store.state).max;
  const text = el('textarea', { rows: '3', 'aria-label': 'こだわりにしたいこと', maxlength: String(max) });
  const sendBtn = el('button', { type: 'button', class: 'primary ib', title: '送る (Ctrl+Enter)', 'aria-label': '送る' }, icon('send'));
  const send = async () => {
    const said = text.value.trim();
    if (!said) return text.focus();
    text.value = '';
    sendBtn.disabled = true;
    const r = await sendKnowledgeTune(said);
    sendBtn.disabled = false;
    if (r.status !== 200 && !text.value) text.value = said; // refused: the words are not lost
    text.focus();
  };
  sendBtn.addEventListener('click', send);
  text.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    send();
  });
  const card = el('div', { class: 'composer' }, text, el('div', { class: 'bar one-line' }, ai.node, el('span', { class: 'grow' }), sendBtn));

  $('main').replaceChildren(el('div', { class: 'pad knowledge-tune' },
    el('h1', {}, el('button', { class: 'quiet', onclick: () => go('#/knowledge') }, icon('back', 's'), 'こだわり'), icon('message', 'l'), 'AIと整える'),
    body,
    el('div', { class: 'kt-foot' }, card)));
  text.focus();

  let seen = -1;
  return {
    key: 'knowledge-tune',
    update() {
      ai.set(choice());
      const t = tuneModel(store.state);
      empty.hidden = t.messages.length > 0;
      sync(log, t.messages, (m) => m.id, (m) => `${m.role}|${m.text}|${m.changes?.length ?? 0}`, messageNode);
      typing.hidden = !t.busy;
      // Follow the conversation to its end when something was added.
      const n = t.messages.length + (t.busy ? 1 : 0);
      if (n !== seen) {
        seen = n;
        body.scrollTop = body.scrollHeight;
      }
    },
  };
}
