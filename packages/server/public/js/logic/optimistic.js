// Expected effects of the human's actions on the server's picture. Each function returns apply(state), which edits a
// copy of the snapshot the way the server is expected to; the store shows that copy until the server's own picture
// arrives. Pure: no DOM, no network. If a guess here is wrong the next snapshot corrects it within moments.

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
      // Work that was still waiting for a slot is simply taken out of the queue.
      if (s.lifecycle === 'queued') Object.assign(s, { lifecycle: 'interrupted', lifecycleSince: Date.now(), queuePosition: null, busyWith: null });
      break;
    case 'archive':
      Object.assign(s, { archived: true, unread: false });
      break;
    case 'accept':
      Object.assign(s, { archived: true, unread: false, completion: 'accepted' });
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
export const messageEffect = (sessionId, text) => (state) => {
  const s = session(state, sessionId);
  if (!s) return;
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

/** A step of the human's own list ticked. The last one finishes the work, which is then put away. */
export const stepEffect = (sessionId, index, done) => (state) => {
  const s = session(state, sessionId);
  const steps = s?.task?.humanSteps;
  if (!steps?.[index]) return;
  steps[index].done = done;
  if (steps.every((x) => x.done)) Object.assign(s, { archived: true, unread: false, completion: 'accepted' });
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

/** A project's own options (whether new work gets a worktree, its default message). */
export const projectEffect = (projectId, options) => (state) => {
  const p = state.projects.find((x) => x.id === projectId);
  if (p && options.useWorktree !== undefined) p.useWorktree = options.useWorktree !== false;
  if (p && options.preamble !== undefined) p.preamble = String(options.preamble ?? '').slice(0, 20000);
};

export const loginEffect = (provider) => (state) => {
  if (state.auth?.[provider]) state.auth[provider].loginInProgress = true;
};
