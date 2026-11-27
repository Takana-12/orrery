// The voice layer: one level above the screen on the right. Opened on the home screen, it is not a screen of its own:
// the home screen's own sphere takes the voice (it swells and comes forward, everything around it recedes; app.css,
// body[data-voice=home]) and only the words and the controls appear, where the new-work box was. Opened on any other
// screen, the rail stays in view (not operable) and everything right of it dissolves (body[data-voice=on]); only this
// is left there: its own sphere, what was heard, and the work it became.
// Opened by holding Space (a short press, released sooner, keeps its old meaning) or by the microphone chip of the new-work box or of a
// piece of work's reply box. Opened on a piece of work's screen, what is said is a reply to it.
import { store } from '../logic/store.js';
import { beginVoice, cancelVoice, confirmVoice, coolVoice, dropVoiceTask, endVoice, setVoicePrompt, setVoiceTask, voiceLevel, voiceReplyTargets, voiceToBox, warmVoice } from '../logic/voice.js';
import { aiPicker } from './ai-picker.js';
import { $, el, put, sync } from './dom.js';
import { icon } from './icons.js';
import { multiPicker, picker } from './menu.js';
import { go, route } from './shell.js';
import { wordFor } from './vocabulary.js';
import { voiceOrb } from './voice-orb.js';

/** Space held this long is "speak"; released sooner it is the short press it always was. */
const HOLD_MS = 350;
/** How large the home screen's sphere is while it takes the voice, and while the plan or an error is shown under it. */
const HOME_SCALE = { listening: 1.22, thinking: 1.22, review: 0.8, error: 0.9 };
/** Space is down, from a press this module took notice of. */
let held = false;
let timer = null;
/** Where the press takes the page if it turns out short (the home screen's new-work box), or null. */
let shortGo = null;

/** The new-work box or a piece of work's reply box, with nothing written in it: a space typed there means nothing. */
const boxEmpty = (a) => !!a?.matches?.('form.new textarea, .session .composer textarea') && !a.value.trim();

/**
 * Space went down: it is a hold if it is still down after HOLD_MS, else a short press that goes to `goTo` when the key
 * comes up. Nothing moves meanwhile, so a hold speaks over the screen it began on. The microphone opens at once: what
 * is said from the moment the key went down is kept.
 */
function arm(goTo = null) {
  held = true;
  shortGo = goTo;
  clearTimeout(timer);
  // What the words are for is decided where the key went down: on a piece of work's screen they answer it (held again
  // in the open layer, they keep what they were for).
  const r = route();
  const replyTo = store.voice.phase !== 'off' ? store.voice.replyTo : r.view === 'session' ? r.id : '';
  warmVoice();
  timer = setTimeout(() => {
    timer = null;
    shortGo = null;
    if (!held) return;
    // Spaces that slipped into the empty box while the key was held (an IME's wide space) are not part of a request.
    const a = document.activeElement;
    if (boxEmpty(a) && a.value) { a.value = ''; a.dispatchEvent(new Event('input', { bubbles: true })); }
    beginVoice('hold', { replyTo });
  }, HOLD_MS);
}

/** The key is no longer down, or will never be seen coming up: no hold, no short press. */
function disarm() {
  held = false;
  shortGo = null;
  clearTimeout(timer);
  timer = null;
}

/**
 * The page's keydown, offered here first. True: the key was this layer's, do nothing else with it.
 * `typing`: the focus is in a text field.
 */
export function voiceKey(e, typing) {
  const v = store.voice;
  const space = e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  if (v.phase === 'off') {
    if (!space) return false;
    // The key is still down from a press taken here: its repeats are not spaces.
    if (e.repeat) return held ? (e.preventDefault(), true) : false;
    const a = document.activeElement;
    if (/^(radio|checkbox)$/.test(a?.type ?? '')) return false;
    if (typing && !boxEmpty(a)) return false; // in a text box, a space is a space
    // Out of any box, a short press opens home with the cursor in the new-work box, as it always did, but only once the
    // key comes up. (Taking the key here also stops it re-pressing whatever button has focus.) Already in an empty box,
    // a leading space means nothing there.
    arm(typing ? null : '#/new');
    e.preventDefault();
    return true;
  }
  // Open: the keyboard belongs to the layer, nothing reaches the screens under it.
  // Rewriting a planned request in place: keys are typing. Enter (or Esc) ends the rewrite and gives the keyboard
  // back to the layer, so the next Enter sends; Shift+Enter is a new line, Ctrl+Enter sends at once.
  if (e.target?.matches?.('#voice .vt-prompt')) {
    if (e.isComposing || e.keyCode === 229) return true;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmVoice(); }
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); $('voice').focus({ preventScroll: true }); }
    return true;
  }
  const onButton = !!e.target?.closest?.('#voice button');
  if (e.key === 'Escape') { e.preventDefault(); cancelVoice(); return true; }
  if (e.key === 'Tab') return true;
  if (v.phase === 'listening') {
    if (v.mode === 'toggle' && !e.repeat && !onButton && (space || e.key === 'Enter')) { e.preventDefault(); endVoice(); }
    else if (space && !onButton) e.preventDefault();
    return true;
  }
  if (v.phase === 'thinking') {
    if (space && !onButton) e.preventDefault();
    return true;
  }
  if (onButton && (space || e.key === 'Enter')) return true; // the focused button's own press
  if (e.key === 'Enter') {
    e.preventDefault();
    if (v.phase === 'review') confirmVoice();
    else cancelVoice();
  } else if (space) {
    e.preventDefault();
    if (!e.repeat) arm(); // hold again to say it again
  }
  return true;
}

function voiceKeyup(e) {
  if (e.code !== 'Space') return;
  const short = timer !== null;
  const goTo = shortGo;
  disarm();
  if (short) {
    // Up before it was a hold: not speech. The microphone opened for it closes, and the short press does what it does.
    coolVoice();
    if (goTo) { e.preventDefault(); go(goTo); }
    return;
  }
  if (store.voice.phase === 'listening' && store.voice.mode === 'hold') endVoice();
}

/** The window lost the keyboard while the key was down: its release will never arrive. */
function voiceBlur() {
  if (!held) return;
  const short = timer !== null;
  disarm();
  if (short) return coolVoice();
  if (store.voice.phase !== 'listening' || store.voice.mode !== 'hold') return;
  if (store.voice.live) endVoice();
  else cancelVoice();
}

export function mountVoice() {
  document.addEventListener('keyup', voiceKeyup);
  window.addEventListener('blur', voiceBlur);
}

// ---- the layer itself ------------------------------------------------------------------------------------------

let layer = null;
/** What had the focus when the layer opened: it gets it back. */
let before = null;

function build() {
  const root = $('voice');
  const orb = voiceOrb();
  const state = el('div', { class: 'voice-state', role: 'status' });
  const text = el('p', { class: 'voice-text' });
  const tasks = el('div', { class: 'voice-tasks' });
  const bar = el('div', { class: 'voice-bar' });
  const say = el('div', { class: 'voice-say' }, text, state, tasks);
  root.replaceChildren(orb.node, say, bar);
  // On the home screen the words grow upwards from the bottom: the sphere keeps clear of them.
  new ResizeObserver(() => placeHomeOrb()).observe(say);
  window.addEventListener('resize', () => placeHomeOrb());
  return { root, orb, state, text, tasks, bar, say };
}

/** The voice is the home screen's sphere's (the layer was opened, or is open, on the home screen): what it shows, or null. */
export function homeVoiceMode() {
  const v = store.voice;
  if (v.phase === 'off' || route().view !== 'inbox') return null;
  return v.phase === 'listening' ? (v.live ? 'listen' : 'wait') : v.phase === 'thinking' ? 'think' : 'home';
}

/**
 * The home screen's sphere while it takes the voice: larger (it comes forward), and lifted just enough that the words
 * under it never cover it; if there is not room for that, smaller still. Set as --v-scale and --v-lift on the body
 * (app.css eases the sphere there and back).
 */
function placeHomeOrb() {
  const b = document.body;
  const stage = document.querySelector('.home .orbit-stage');
  if (b.dataset.voice !== 'home' || !layer || !stage) return;
  const css = getComputedStyle(stage);
  const sr = parseFloat(css.getPropertyValue('--sr')) || 40;
  const box = stage.getBoundingClientRect();
  const centre = box.top + (parseFloat(css.getPropertyValue('--cy')) || box.height / 2);
  const floor = layer.say.getBoundingClientRect().top - 12; // the words' top edge
  const top = box.top + 8;
  let scale = HOME_SCALE[store.voice.phase] ?? 1;
  const reach = 1.5; // the sphere swelling with the voice, and some of its light, past its radius
  // Lift it until its lower edge clears the words, but not past the top of the stage; if both cannot be kept, shrink it.
  const room = floor - top;
  if (room > 0 && sr * scale * reach * 2 > room) scale = Math.max(0.45, room / (sr * reach * 2));
  const lift = Math.max(0, Math.min(centre + sr * scale * reach - floor, centre - sr * scale - top));
  b.style.setProperty('--v-scale', scale.toFixed(3));
  b.style.setProperty('--v-lift', `${lift.toFixed(0)}px`);
}

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * One planned piece of work: what will be asked, and under it what it is (new work, or a reply to which work) and, for
 * new work, where and who. All of it can be changed before it starts, the words too: they are written in a box that
 * looks like text until it is touched.
 */
function taskRow(t) {
  const reply = !!t.sessionId;
  const to = picker({
    ic: reply ? 'message' : 'plus',
    label: '送り先',
    value: t.sessionId,
    options: [
      { value: '', icon: 'plus', label: '新しい作業として始める' },
      ...voiceReplyTargets(t.sessionId).map((s, i) => ({ sep: i === 0, value: s.id, icon: 'message', label: `${s.taskTitle} に返信`, short: `${cut(s.taskTitle, 24)} に返信`, sub: `${s.projectName}・${wordFor(s)}` })),
    ],
    onChange: (v) => setVoiceTask(t.key, { sessionId: v }),
  });
  const projects = store.state.projects.filter((p) => !p.pending);
  // Workspaces tick on and off as in the new-work box: the first ticked is the main one, the rest go along with it.
  const where = !reply && multiPicker({ ic: 'folder', label: 'ワークスペース', value: [t.projectId, ...(t.extraProjectIds ?? [])].filter(Boolean), options: projects.map((p) => ({ value: p.id, label: p.name, sub: p.rootPath })),
    onChange: (list) => setVoiceTask(t.key, { projectId: list[0] ?? '', extraProjectIds: list.slice(1) }) });
  const who = !reply && aiPicker({ value: { provider: t.provider, model: t.model, effort: t.effort }, onChange: (c) => setVoiceTask(t.key, c) });
  const drop = reply ? 'この返信は送らない' : 'この作業は始めない';
  return el('div', { class: `voice-task${reply ? ' reply' : ''}` },
    el('textarea', { class: 'vt-prompt', rows: 1, spellcheck: 'false', 'aria-label': reply ? '送る内容' : '頼む内容', value: t.prompt, oninput: (e) => setVoicePrompt(t.key, e.target.value) }),
    el('div', { class: 'vt-meta' }, to.node, where && where.node, who && who.node, el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'quiet ib vt-drop', title: drop, 'aria-label': drop, onclick: () => dropVoiceTask(t.key) }, icon('x', 's'))));
}

const ib = (ic, label, onclick, cls = 'quiet ib') => el('button', { type: 'button', class: cls, title: label, 'aria-label': label, onclick }, icon(ic));

/** The controls under the layer: what stops or goes back at the left, what moves on at the right end. */
function barFor(v) {
  const cancel = ib('x', 'やめる (Esc)', () => cancelVoice());
  // What was heard but could not be planned can still be taken to a box and written by hand.
  const toBox = ib('pencil', '入力欄で書き直す', () => go(voiceToBox()));
  // Saying it again keeps what it was for: the same work's reply, or anything.
  const again = (cls) => ib('mic', 'もう一度話す（Space 長押し）', () => beginVoice('toggle', { replyTo: v.replyTo }), cls);
  const allReplies = v.tasks.length > 0 && v.tasks.every((t) => t.sessionId);
  const grow = el('span', { class: 'grow' });
  if (v.phase === 'listening') return v.mode === 'toggle' ? [cancel, grow, ib('check', '話し終える (Enter)', () => endVoice(), 'primary ib')] : [];
  if (v.phase === 'thinking') return [cancel, grow];
  // The plan's words are rewritten where they are shown: no trip to another box.
  if (v.phase === 'review') return [cancel, again('quiet ib'), grow, ib('send', allReplies ? '送る (Enter)' : '始める (Enter)', () => confirmVoice(), 'primary ib')];
  return [cancel, v.text && toBox, grow, again('ib')];
}

/** Called on every redraw of the page. */
export function drawVoice() {
  const v = store.voice;
  const on = v.phase !== 'off';
  if (!layer) {
    if (!on) return;
    layer = build();
  }
  const { root, orb } = layer;
  const b = document.body;
  const shown = b.dataset.voice !== undefined;
  const home = route().view === 'inbox';
  if (on && !shown) {
    before = document.activeElement;
    for (const n of document.querySelectorAll('.app, .chat-dock')) n.inert = true;
    root.focus({ preventScroll: true });
  } else if (!on && shown) {
    delete b.dataset.voice;
    // The home screen's sphere glides back to its place and size from where it was (app.css).
    b.style.removeProperty('--v-scale');
    b.style.removeProperty('--v-lift');
    for (const n of document.querySelectorAll('.app, .chat-dock')) n.inert = false;
    if (before?.isConnected && !document.activeElement?.matches?.('textarea, input')) before.focus({ preventScroll: true });
    before = null;
    orb.set('rest');
  }
  if (!on) return; // what was shown stays as it is while the layer fades out
  b.dataset.voice = home ? 'home' : 'on';
  root.dataset.phase = v.phase;
  // On the home screen its sphere is the one that moves (views/home.js, homeVoiceMode); this one rests, unseen.
  orb.set(home ? 'rest' : v.phase === 'listening' ? (v.live ? 'listen' : 'wait') : v.phase === 'thinking' ? 'think' : 'rest', voiceLevel);

  // One state = one icon + one word, where the next thing will appear.
  const model = store.state?.voice?.model;
  const fetching = model?.state === 'downloading' && v.phase === 'thinking';
  const word = v.phase === 'listening' ? (v.live ? '聞いています' : '')
    : v.phase === 'thinking' ? (fetching ? `音声モデルを準備中 ${Math.round((model.progress ?? 0) * 100)}%` : '考え中')
    : v.phase === 'error' ? v.error : '';
  const sig = `${v.phase}|${word}`;
  if (layer.state.dataset.sig !== sig) {
    layer.state.dataset.sig = sig;
    layer.state.className = `voice-state${v.phase === 'thinking' ? ' thinking' : ''}${v.phase === 'error' ? ' bad' : ''}`;
    put(layer.state, word && [v.phase === 'listening' ? icon('mic', 's') : v.phase === 'error' ? icon('error', 's red') : fetching ? icon('running', 's spin') : null, el('span', {}, word)]);
  }
  // What was heard shows while it is being read and when it could not be used; the plan replaces it.
  const heard = v.phase === 'thinking' || v.phase === 'error' ? v.text : '';
  if (layer.text.textContent !== heard) layer.text.textContent = heard;
  layer.text.hidden = !heard;
  sync(layer.tasks, v.phase === 'review' ? v.tasks : [], (t) => t.key, (t) => `${t.key}|${t.sessionId}`, taskRow);
  const barSig = `${v.phase}|${v.mode}|${!!v.text}|${v.replyTo}|${v.tasks.map((t) => !!t.sessionId).join()}`;
  if (layer.bar.dataset.sig !== barSig) {
    layer.bar.dataset.sig = barSig;
    put(layer.bar, barFor(v));
  }
  placeHomeOrb();
}
