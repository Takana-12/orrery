// Voice input: one layer above the screens. The human speaks; what they said becomes pieces of work, each with its
// workspace and AI decided for it, and each is started the same way typed work is (actions.startWork), so approvals
// and worktrees follow each workspace's own settings. Words that answer work already going on become a reply to it
// (actions.sendMessage), as if typed into its reply box:
//   - spoken on a piece of work's own screen (`replyTo`), all of it is a reply to that work; an AI only puts English
//     that came out as katakana back into English (and only when there is katakana or Latin in it)
//   - spoken anywhere else, the planner decides, for each part, whether it is new work or a reply to which work
//
// store.voice.phase:
//   off        the layer is closed
//   listening  the microphone is open (`live` once it really hears); ends when the key is released (mode 'hold') or
//              when the human says so (mode 'toggle', started from the button)
//   thinking   the recording is being read, then planned; `text` appears as soon as it is known
//   review     `tasks` are shown for the human's go (settings.voice.confirm); they may rewrite what each asks, and
//              change where and who
//   error      `error` says what went wrong; `text`, if any, can still be taken to the new-work box
// Every step shows at once; the server is asked afterwards. A newer start or a cancel makes older answers void (`run`).
import { api, upload } from './api.js';
import { sendMessage, startWork } from './actions.js';
import { store } from './store.js';
import { micGranted, micProblem, openMic } from './voice-capture.js';

/** A hold shorter than this, or a recording this quiet, is not a request: the layer just closes. */
const MIN_SECONDS = 0.4;
const MIN_PEAK = 0.02;
/** The server reads at most five minutes; stop a little before. */
const MAX_SECONDS = 290;

let run = 0;
let mic = null;
let limit = null;
let taskKey = 0;
/** Swapped by tests: opens the microphone; says whether it opens without asking. */
export const voiceIo = { openMic, micGranted };
/** A microphone opened the moment Space went down, before it is known to be a hold: what is said from then on is kept. */
let early = null;
let earlyTimer = null;
/** An early microphone not taken by a start within this long is closed again. */
const EARLY_MS = 3000;

const closed = () => ({ phase: 'off', mode: 'hold', live: false, text: '', tasks: [], error: '', replyTo: '' });
const set = (patch) => {
  store.voice = { ...store.voice, ...patch };
  store.changed();
};
const fail = (error) => set({ phase: 'error', live: false, error });
const remembered = (key) => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } };

/** How loud the microphone is right now, 0..1. */
export const voiceLevel = () => mic?.level() ?? 0;

const sessionOf = (id) => (id && store.state?.sessions.find((s) => s.id === id)) || null;

/**
 * Work the words can be a reply to: what is still open (not put away, not accepted as done), most recent first, and
 * `keep` (the reply's present target) even when it is not.
 */
export function voiceReplyTargets(keep = '') {
  return (store.state?.sessions ?? []).filter((s) => s.id === keep || (!s.archived && s.completion !== 'accepted'))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

const busy = () => store.voice.phase === 'listening' || store.voice.phase === 'thinking' || store.shuttingDown;
const shut = (opening) => void opening?.then((m) => m.cancel(), () => {});
const takeEarly = () => {
  clearTimeout(earlyTimer);
  const p = early;
  early = null;
  return p;
};

/**
 * Space went down and may be held: open the microphone now, so the first words are not lost to the wait for the hold
 * and to the microphone's own start. Only where it opens without asking (a short press must never bring up a prompt).
 * Taken by the next beginVoice; released sooner, coolVoice closes it.
 */
export function warmVoice() {
  if (early || busy() || !voiceIo.micGranted()) return;
  early = voiceIo.openMic();
  early.catch(() => {}); // the start that takes it says what went wrong
  earlyTimer = setTimeout(coolVoice, EARLY_MS);
  earlyTimer.unref?.();
}

/** The key went up before it was a hold: close the microphone opened for it. */
export function coolVoice() {
  shut(takeEarly());
}

/**
 * Start listening. `mode`: 'hold' (ends when the key is released) or 'toggle' (ends when the human says so).
 * `replyTo`: the work whose screen is open; what is said goes to it as a reply.
 */
export function beginVoice(mode = 'hold', { replyTo = '' } = {}) {
  const opening = takeEarly();
  if (busy()) return shut(opening);
  const mine = ++run;
  store.voice = { ...closed(), phase: 'listening', mode, replyTo: sessionOf(replyTo) ? replyTo : '' };
  store.changed();
  // Wake the recogniser while the human speaks (its model is fetched the first time; the layer shows how far along it is).
  void api('/api/voice/prepare', {});
  (opening ?? voiceIo.openMic()).then((m) => {
    if (run !== mine || store.voice.phase !== 'listening') return void m.cancel();
    mic = m;
    limit = setTimeout(() => endVoice(), MAX_SECONDS * 1000);
    limit.unref?.();
    set({ live: true });
  }, (e) => {
    if (run === mine) fail(micProblem(e));
  });
}

/** The human has finished speaking: read the recording, then plan the work. */
export async function endVoice() {
  if (store.voice.phase !== 'listening') return;
  clearTimeout(limit);
  const m = mic;
  mic = null;
  if (!m) return cancelVoice(); // released before the microphone was open: nothing was heard
  const mine = run;
  const rec = m.stop();
  if (rec.seconds < MIN_SECONDS || rec.peak < MIN_PEAK) return cancelVoice();
  set({ phase: 'thinking', live: false });
  const heard = await upload('/api/voice/transcribe', rec.pcm);
  if (run !== mine) return;
  if (heard.status !== 200) return fail(heard.status === 0 ? 'Orreryに接続できません' : heard.body.error || '聞き取れませんでした');
  const text = String(heard.body.text ?? '').trim();
  if (!text) return fail('聞き取れませんでした');
  set({ text });
  const target = sessionOf(store.voice.replyTo);
  if (target) return tidyReply(mine, target, text);
  await planVoice(mine, text);
}

/**
 * A reply is sent as it was said, but recognisers write English inside Japanese badly ("プランビ"): it is put back
 * into English first. What was heard shows meanwhile; if that cannot be done, it is what is sent.
 */
async function tidyReply(mine, target, heard) {
  const r = await api('/api/voice/tidy', { text: heard, sessionId: target.id });
  if (run !== mine) return;
  const text = (r.status === 200 && String(r.body.text ?? '').trim()) || heard;
  if (text !== heard) set({ text });
  ready([replyTask(sessionOf(target.id) ?? target, text)]);
}

/** All that was said, as a reply to `s`; should it become new work instead, it starts where `s` is, with its AI. */
const replyTask = (s, prompt) => ({ key: `v${++taskKey}`, sessionId: s.id, projectId: s.projectId, extraProjectIds: [...(s.extraProjectIds ?? [])], provider: s.provider, model: s.model ?? '', effort: s.effort ?? '', prompt });

/** The plan is known: wait for the human's go, or go at once (settings.voice.confirm). */
function ready(tasks) {
  store.voice = { ...store.voice, tasks };
  if (store.state?.settings?.voice?.confirm === false) return confirmVoice();
  set({ phase: 'review' });
}

/** Which AI the human last chose by hand in each workspace (kept by the new-work box): a hint for the planner. */
function usualChoices() {
  const out = {};
  for (const p of store.state?.projects ?? []) {
    try {
      const c = JSON.parse(remembered(`crChoiceWs:${p.id}`) ?? 'null');
      if (c && (c.provider === 'claude' || c.provider === 'codex')) out[p.id] = { provider: c.provider, model: c.model ?? '' };
    } catch {}
  }
  return out;
}

async function planVoice(mine, text) {
  const r = await api('/api/voice/plan', { text, lastProjectId: remembered('crProject'), usual: usualChoices() });
  if (run !== mine) return;
  if (r.status !== 200) return fail(r.body.error || '依頼を読み取れませんでした');
  const tasks = (r.body.tasks ?? []).map((t) => ({ key: `v${++taskKey}`, sessionId: sessionOf(t.sessionId) ? t.sessionId : '', projectId: t.projectId, extraProjectIds: [], provider: t.provider, model: t.model ?? '', effort: t.effort ?? '', prompt: t.prompt }));
  if (!tasks.length) return fail('依頼が見つかりませんでした');
  ready(tasks);
}

/**
 * Change where a planned piece of work goes or who does it (`patch`: { projectId, extraProjectIds } — the main
 * workspace and any others ticked with it, as in the new-work box — or { provider, model, effort }),
 * or which work it answers (`patch`: { sessionId }; '' = start it as new work).
 */
export function setVoiceTask(key, patch) {
  const t = store.voice.tasks.find((x) => x.key === key);
  if (!t) return;
  Object.assign(t, patch);
  store.changed();
}

/**
 * The human rewrote what a planned piece of work will ask, right where it is shown. Nothing on screen depends on the
 * words but the box they were typed into, so the page is not redrawn for each key.
 */
export function setVoicePrompt(key, prompt) {
  const t = store.voice.tasks.find((x) => x.key === key);
  if (t) t.prompt = prompt;
}

/** Take one planned piece of work out. The last one out closes the layer. */
export function dropVoiceTask(key) {
  const tasks = store.voice.tasks.filter((x) => x.key !== key);
  if (!tasks.length) return cancelVoice();
  set({ tasks });
}

/** The workspace's own approval setting, as the new-work box would start from (a mode this agent lacks: ask every time). */
const approvalFor = (project, provider) => {
  const mode = project?.approvalMode ?? 'auto';
  return mode === 'edits' && provider !== 'claude' ? 'ask' : mode;
};

/** Put `text` into the reply box of work `sessionId`, after what is already written there (store.composerFill). */
function fillReplyBox(sessionId, text) {
  const had = (store.composerDrafts.get(sessionId) ?? '').trim();
  store.composerDrafts.set(sessionId, had ? `${had}\n${text}` : text);
  store.composerFill.add(sessionId);
}

/** Send one reply. It shows in that work's conversation at once; refused, the words go back into its reply box. */
async function sendReply(t) {
  const r = await sendMessage(t.sessionId, t.prompt);
  if (r.status === 200) return;
  const title = sessionOf(t.sessionId)?.taskTitle ?? '作業';
  fillReplyBox(t.sessionId, t.prompt);
  store.notice(`「${title}」に送れませんでした: ${r.body.error || `送信できませんでした (${r.status})`}（話した内容は入力欄に戻してあります）`);
}

/** Start every planned piece of work and send every reply. Each shows at once; the layer closes. */
export function confirmVoice() {
  if (!store.voice.tasks.length) return;
  // A request rubbed out by hand is one the human no longer wants; with none left, there is nothing to send.
  const tasks = store.voice.tasks.map((t) => ({ ...t, prompt: t.prompt.trim() })).filter((t) => t.prompt);
  if (!tasks.length) return cancelVoice();
  run++;
  store.voice = closed();
  store.changed();
  for (const t of tasks) {
    if (t.sessionId && sessionOf(t.sessionId)) {
      void sendReply(t);
      continue;
    }
    const project = store.state?.projects.find((p) => p.id === t.projectId);
    const title = t.prompt.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!project) { store.notice(`「${title}」はワークスペースが選ばれていないため、始めませんでした`); continue; }
    const others = (t.extraProjectIds ?? []).filter((id) => id !== t.projectId && store.state.projects.some((p) => p.id === id));
    const names = [project.name, ...others.map((id) => store.state.projects.find((p) => p.id === id).name)];
    // No `worktree`: left out, the workspace's own setting decides (Sessions.start).
    void startWork({ text: t.prompt, suffix: '', provider: t.provider, model: t.model, effort: t.effort, approvalMode: approvalFor(project, t.provider), planMode: false, codexPolicy: '', workspaces: [t.projectId, ...others], projectName: names.join('・') }, {
      keepDraft: true,
      onFail: (message) => store.notice(`「${title}」を始められませんでした: ${message}`),
    });
  }
}

/**
 * Hand what was heard to a box, to be corrected by hand: the reply box of the work it answers, or the new-work box.
 * Returns the address of the screen with that box (the screen opens it).
 */
export function voiceToBox() {
  const v = store.voice;
  const one = v.tasks.length === 1 ? v.tasks[0] : null;
  const text = one ? one.prompt : v.text;
  const target = sessionOf(one ? one.sessionId : v.tasks.length ? '' : v.replyTo);
  cancelVoice();
  if (target) {
    if (text) fillReplyBox(target.id, text);
    return `#/s/${target.id}`;
  }
  if (text) store.newDraft.fill = text;
  return '#/new';
}

/** Close the layer and forget what was being heard or read. */
export function cancelVoice() {
  coolVoice();
  run++;
  clearTimeout(limit);
  mic?.cancel();
  mic = null;
  if (store.voice.phase === 'off') return;
  store.voice = closed();
  store.changed();
}
