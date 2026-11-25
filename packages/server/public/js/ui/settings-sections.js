// The settings screen's table of contents: which sections it has, in order, and which one is being read.
// The settings view draws a heading per entry; the rail lists the same entries while the settings screen is open.

/** The sections of the settings screen, top to bottom. `id` names the anchor; `icon` and `title` are its heading. */
export const SETTINGS_SECTIONS = [
  { id: 'look', icon: 'eye', title: '外観' },
  { id: 'work', icon: 'running', title: '作業' },
  { id: 'side-chat', icon: 'message', title: 'サイドチャット' },
  { id: 'voice', icon: 'mic', title: '音声入力' },
  { id: 'preamble', icon: 'send', title: 'デフォルトメッセージ' },
  { id: 'knowledge', icon: 'bulb', title: 'こだわり' },
  { id: 'projects', icon: 'folder', title: 'プロジェクト' },
  { id: 'shortcuts', icon: 'bolt', title: 'ショートカット' },
  { id: 'storage', icon: 'archive', title: '保存データ' },
  { id: 'update', icon: 'restore', title: 'アプリの更新' },
];

/** The element id of a section's heading block on the settings screen. */
export const sectionAnchor = (id) => `set-${id}`;

/**
 * The section being read in a scrolled box: the last one whose top has reached the box's top (with a little slack),
 * or the last section once the box is scrolled to its end (short sections at the bottom can never reach the top).
 */
export function sectionInView(box) {
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) return SETTINGS_SECTIONS.at(-1).id;
  const top = box.getBoundingClientRect().top + 32;
  let current = SETTINGS_SECTIONS[0].id;
  for (const s of SETTINGS_SECTIONS) {
    const node = document.getElementById(sectionAnchor(s.id));
    if (node && node.getBoundingClientRect().top <= top) current = s.id;
  }
  return current;
}
