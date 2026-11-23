// Attachments: files and pasted pictures that go along with a message.
import { saveAttachment } from '../logic/actions.js';
import { el, put } from './dom.js';
import { icon } from './icons.js';

/** composer key -> [{ name, path, thumb, busy }]; keeps the list when the screen is rebuilt. */
const attachDrafts = new Map();

/**
 * Wires a composer for attachments: a clip button, Ctrl+V for pictures on the clipboard, and drag and drop.
 * Each file is saved by Orrery; the message then names the saved path, and the agent opens it from there.
 * Returns { button, tray, ready(), suffix(), clear() }. `key` keeps the list when the screen is rebuilt.
 */
export function attachments(key, textarea, card, onError) {
  const list = attachDrafts.get(key) ?? attachDrafts.set(key, []).get(key);
  const tray = el('div', { class: 'attached' });
  const input = el('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const button = el('button', { type: 'button', class: 'quiet ib', title: 'ファイルを添付（画像は Ctrl+V でも貼れます）', 'aria-label': 'ファイルを添付', onclick: () => input.click() }, icon('clip'), input);
  const drop = (a) => { const i = list.indexOf(a); if (i >= 0) list.splice(i, 1); if (a.thumb) URL.revokeObjectURL(a.thumb); };
  const paint = () => {
    tray.hidden = !list.length;
    put(tray, list.map((a) => el('span', { class: 'att', title: a.path ?? a.name },
      a.thumb ? el('img', { src: a.thumb, alt: '' }) : icon(a.busy ? 'running' : 'file', a.busy ? 's spin' : 's'),
      el('span', { class: 'v' }, a.name),
      el('button', { type: 'button', class: 'quiet', title: '外す', 'aria-label': `${a.name} を外す`, onclick: () => { drop(a); paint(); } }, icon('x', 's')))));
  };
  const add = async (files) => {
    for (const file of files) {
      // A picture pasted from the clipboard is always called "image.png": name it by the time so several stay apart.
      const pasted = file.name === 'image.png' && file.lastModified > Date.now() - 5000;
      const name = pasted ? `${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png` : file.name;
      const a = { name, path: null, busy: true, thumb: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
      list.push(a);
      paint();
      const r = await saveAttachment(name, file);
      if (r.status === 200) { a.path = r.body.path; a.busy = false; onError(''); }
      else { drop(a); onError(r.body.error || `${name} を添付できませんでした (${r.status})`); }
      paint();
    }
  };
  input.addEventListener('click', (e) => e.stopPropagation()); // it sits inside the button that opens it
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    // Copying cells or rich text also puts a picture of it on the clipboard: the text is what was meant.
    if (!files.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    add(files);
  });
  card.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); card.classList.add('dropping'); } });
  card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('dropping'); });
  card.addEventListener('drop', (e) => {
    card.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });
  paint();
  return {
    button, tray,
    count: () => list.length,
    ready: () => !list.some((a) => a.busy),
    suffix: () => (list.length ? `\n\n添付ファイル（次のパスにあります。開いて確認してください）:\n${list.map((a) => `- ${a.path}`).join('\n')}` : ''),
    clear: () => { for (const a of [...list]) drop(a); paint(); },
  };
}
