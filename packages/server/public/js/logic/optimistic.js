// Expected effects of the human's actions on the server's picture. Each function returns apply(state), which edits a
// copy of the snapshot the way the server is expected to; the store shows that copy until the server's own picture
// arrives. Pure: no DOM, no network. If a guess here is wrong the next snapshot corrects it within moments.

import { AGENTS } from './agents.js';

const session = (state, id) => state.sessions.find((s) => s.id === id);
const BUSY = ['running', 'waiting_for_user', 'queued'];

/** The header counts, recomputed the way the server computes them. */
export function recount(state) {
  const working = state.sessions.filter((s) => !s.archived);
  const life = (...l) => working.filter((s) => l.includes(s.lifecycle)).length;
  const done = (c) => working.filter((s) => s.completion === c).length;
  state.counts = {
    ...state.counts,
    needsAttention: state.items.filter((i) => i.status === 'pending').length,
    running: life('running'),
    queued: life('queued'),
    waiting: life('waiting_for_user'),
    turnFinished: life('turn_finished'),
    problems: life('error', 'interrupted', 'unknown'),
    candidates: done('candidate'),
    humanTasks: done('human_steps'),
    needsFix: done('needs_fix'),
    unread: working.filter((s) => s.unread).length,
    archived: state.sessions.length - working.length,
  };
}

/** The agent was sent back to work: what its last reply left open no longer applies. */
function backToWork(state, s) {
  s.lifecycle = 'running';
  s.lifecycleSince = Date.now();
  s.completion = 'working';
  s.unread = false;
  s.archived = false;
  s.awaitingBackground = false;
  s.usageResume = null;
  if (s.task) Object.assign(s.task, { humanSteps: null, validation: null, acceptedAt: null });
  for (const i of state.items) if (i.sessionId === s.id && i.passive && i.status === 'pending') i.status = 'expired';
}

/** Actions that take the server a moment: the session is marked with what is being done to it (`busyWith`). */
const SLOW = new Set(['interrupt', 'stop', 'cleanup', 'check', 'finish']);

/** One of the per-session actions (the same names as the API). */
export const actEffect = (sessionId, action, body = {}) => (state) => {
  const s = session(state, sessionId);
  if (!s) return;
  if (SLOW.has(action)) s.busyWith = action;
  switch (action) {
    case 'interrupt':
      if (s.usageResume) Object.assign(s, { usageResume: null, busyWith: null });
      // Work that was still waiting for a slot is simply taken out of the queue.
      if (s.lifecycle === 'queued') Object.assign(s, { lifecycle: 'interrupted', lifecycleSince: Date.now(), queuePosition: null, busyWith: null });
      break;
    case 'archive':
      Object.assign(s, { archived: true, unread: false, usageResume: null });
      break;
    case 'accept':
      Object.assign(s, { archived: true, unread: false, completion: 'accepted', usageResume: null });
      break;
    case 'unarchive':
      s.archived = false;
      break;
    case 'reopen':
      Object.assign(s, { archived: false, completion: 'unverified' });
      break;
    case 'seen':
      s.unread = false;
      break;
    case 'check':
      if (s.task) s.task.validating = true;
      s.completion = 'validating';
      break;
    case 'kind':
      // The tag changes at once. Told it is a report, the steps and the questions read from its reply go with it (the
      // reply is shown as written); told it is work, they come back as the server reads the reply again.
      if (!s.task) break;
      Object.assign(s.task, { kind: body.kind, kindPinned: true });
      if (body.kind === 'report' && s.lifecycle === 'turn_finished') {
        s.task.humanSteps = null;
        if (s.completion === 'human_steps') s.completion = 'unverified';
        for (const i of state.items) if (i.sessionId === s.id && i.passive && i.status === 'pending') i.status = 'expired';
      }
      break;
    case 'rename':
      s.taskTitle = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || s.taskTitle;
      break;
    case 'unsend':
      s.deferredMessage = null;
      break;
    case 'finish':
      Object.assign(s, { awaitingBackground: false, lifecycle: 'turn_finished', lifecycleSince: Date.now(), completion: 'unverified' });
      break;
  }
};

/** Several sessions at once (mark all seen, put all away). */
export const manyEffect = (sessionIds, action) => (state) => {
  for (const id of sessionIds) actEffect(id, action)(state);
};

/** A message to a session: held if the agent is busy, otherwise the agent starts on it. */
export const messageEffect = (sessionId, text, effort) => (state) => {
  const s = session(state, sessionId);
  if (!s) return;
  if (effort !== undefined) s.effort = effort;
  if (BUSY.includes(s.lifecycle) && !(s.lifecycle === 'running' && s.awaitingBackground && s.live)) s.deferredMessage = s.deferredMessage ? `${s.deferredMessage}\n\n${text}` : text;
  else backToWork(state, s);
};

/** An answer to a request: it leaves the inbox, and the agent goes on if nothing else is asked of the human. */
export const answerEffect = (itemId, answer) => (state) => {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || item.status !== 'pending') return;
  item.status = 'answering';
  item.response = { answer, sentAt: Date.now() };
  const s = session(state, item.sessionId);
  if (!s) return;
  if (item.passive) {
    item.status = 'resolved';
    if (answer.kind === 'answers') backToWork(state, s);
  } else if (s.lifecycle === 'waiting_for_user' && !state.items.some((i) => i.sessionId === s.id && i.status === 'pending')) {
    s.lifecycle = 'running';
    s.lifecycleSince = Date.now();
  }
};

/** A step of the human's own list ticked. The last one finishes the work; the chat itself stays (it is not archived). */
export const stepEffect = (sessionId, index, done) => (state) => {
  const s = session(state, sessionId);
  const steps = s?.task?.humanSteps;
  if (!steps?.[index]) return;
  steps[index].done = done;
  if (steps.every((x) => x.done)) Object.assign(s, { unread: false, completion: 'accepted' });
};

/**
 * A step's command was clicked: it shows as running from this instant. `runId` tells this run from an older one, so the
 * server's later phases (reading its output, settled) are never painted over by this guess.
 */
export const stepRunEffect = (sessionId, index, command, runId) => (state) => {
  const step = session(state, sessionId)?.task?.humanSteps?.[index];
  if (!step || step.command !== command || step.run?.id === runId) return;
  step.run = { id: runId, phase: 'running', at: Date.now(), ok: null, exitCode: null, outputTail: null, note: null };
};

export const settingsEffect = (patch) => (state) => {
  const next = { ...state.settings };
  if (patch.confirmCommands !== undefined) next.confirmCommands = patch.confirmCommands !== false;
  if (patch.preamble !== undefined) next.preamble = String(patch.preamble ?? '').slice(0, 20000);
  if (patch.maxConcurrent !== undefined) next.maxConcurrent = Math.min(20, Math.max(1, Math.floor(Number(patch.maxConcurrent)) || 1));
  if (patch.minFreeMemoryMB !== undefined) next.minFreeMemoryMB = Math.min(65536, Math.max(0, Math.floor(Number(patch.minFreeMemoryMB)) || 0));
  if (patch.sideChat) next.sideChat = { provider: patch.sideChat.provider === 'codex' ? 'codex' : 'claude', model: String(patch.sideChat.model ?? ''), effort: String(patch.sideChat.effort ?? '') };
  if (Array.isArray(patch.providers)) {
    // Same rule as the server: known agents in their own order, never none.
    const want = AGENTS.filter((p) => patch.providers.includes(p));
    if (want.length) next.providers = want;
  }
  if (patch.voice) {
    const now = next.voice ?? { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: true };
    const ai = patch.voice.plannerAi;
    next.voice = {
      ...now,
      plannerAi: ai ? { provider: ai.provider === 'codex' ? 'codex' : 'claude', model: String(ai.model ?? ''), effort: String(ai.effort ?? '') } : now.plannerAi,
      confirm: patch.voice.confirm === undefined ? now.confirm : patch.voice.confirm !== false,
    };
    if (patch.voice.recognizer !== undefined) next.voice.recognizer = String(patch.voice.recognizer ?? '');
    // Same folding as the server: one word per line, blank lines dropped.
    if (patch.voice.words !== undefined) next.voice.words = String(patch.voice.words ?? '').split(/\r?\n/).map((w) => w.trim()).filter(Boolean).join('\n');
  }
  state.settings = next;
};

/** A project's display name, wherever it shows (the project list, its sessions, its requests). Same folding as the server. */
export const projectRenameEffect = (projectId, name) => (state) => {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  const p = state.projects.find((x) => x.id === projectId);
  if (p) p.name = clean;
  for (const s of state.sessions) if (s.projectId === projectId) s.projectName = clean;
  for (const i of state.items) if (i.projectId === projectId) i.projectName = clean;
};

/** A project's own options (whether new work gets a worktree, how it handles approvals, its default message, what it is). */
export const projectEffect = (projectId, options) => (state) => {
  const p = state.projects.find((x) => x.id === projectId);
  if (p && options.useWorktree !== undefined) p.useWorktree = options.useWorktree !== false;
  if (p && options.preamble !== undefined) p.preamble = String(options.preamble ?? '').slice(0, 20000);
  // Same trimming and limit as the server (PROJECT_DESCRIPTION_MAX), so what shows at the click is what is kept.
  if (p && options.description !== undefined) p.description = String(options.description ?? '').trim().slice(0, 2000);
  if (p && options.captureKnowledge !== undefined) p.captureKnowledge = options.captureKnowledge !== false;
  if (p && ['ask', 'edits', 'auto'].includes(options.approvalMode)) p.approvalMode = options.approvalMode;
};

export const loginEffect = (provider) => (state) => {
  if (state.auth?.[provider]) state.auth[provider].loginInProgress = true;
};

/** A placeholder id for a folder being added as a project, until the server's picture lists the real one. */
export const pendingProjectId = (path) => `pending:${path}`;

/**
 * A folder is being added as a project: show it in the list at once (as pending). A folder already listed is left
 * alone — the server gives back that same project.
 */
export const projectAddEffect = (path) => (state) => {
  const key = String(path).toLowerCase();
  if (state.projects.some((p) => p.rootPath.toLowerCase() === key)) return;
  const name = String(path).replace(/[\/]+$/, '').split(/[\/]/).pop() || String(path);
  state.projects.push({ id: pendingProjectId(path), name, rootPath: path, envCount: 0, pending: true });
};
