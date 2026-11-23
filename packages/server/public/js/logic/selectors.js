// Derivations: what the lists on screen consist of, computed from the server snapshot. Pure functions, no DOM,
// no words: the UI decides how each group is labelled and drawn.

/** How long the agent may sit on a sent answer, still waiting, before the request is shown again. */
export const UNCONFIRMED_MS = 60_000;

/** Unanswered. An answered request leaves the inbox at once: it is the agent's now. */
export const isOpen = (i) => i.status === 'pending';

/**
 * Requests to show. Besides the unanswered ones, an answer is shown again only when it evidently did not arrive:
 * a minute later the agent is still waiting, unchanged since. An agent that went on got it, confirmed or not.
 */
export const openIn = (state) => (i) => {
  if (isOpen(i)) return true;
  if (i.status !== 'answering') return false;
  const sentAt = i.response?.sentAt ?? 0;
  const s = state.sessions.find((x) => x.id === i.sessionId);
  return !!s && s.lifecycle === 'waiting_for_user' && (s.lifecycleSince ?? 0) <= sentAt && Date.now() - sentAt > UNCONFIRMED_MS;
};

/** Minutes a running session has shown no activity (0 while it is clearly alive). */
export const quietFor = (s) => {
  const m = s.activity ? Math.floor((Date.now() - s.activity.at) / 60000) : 0;
  return m >= 3 ? m : 0;
};

export const BUSY = ['running', 'waiting_for_user', 'queued'];
export const isBusy = (s) => BUSY.includes(s.lifecycle);

/** What kind of request a ticket is, as a key the UI turns into a word and an icon. */
export function ticketKind(item) {
  if (item.type === 'user_question') return String(item.source.requestId).startsWith('final:') ? 'question_from_reply' : item.allowDecline ? 'input' : 'question';
  const tool = item.approval?.tool ?? '';
  if (tool === 'ExitPlanMode') return 'plan';
  if (item.approval?.changes?.length) return 'file_change';
  if (tool.startsWith('mcp')) return 'external_tool';
  if (tool === 'shell' || tool === 'Bash') return 'command';
  return 'approval';
}

/** sessionId -> number of unanswered requests. */
export function pendingBySession(state) {
  const by = new Map();
  for (const i of state.items) if (i.status === 'pending') by.set(i.sessionId, (by.get(i.sessionId) ?? 0) + 1);
  return by;
}

/** The strip board at the side: every piece of work that is not put away, grouped by what it is waiting for. */
export function railModel(state, showAllFinished) {
  const c = state.counts;
  const live = state.sessions.filter((s) => !s.archived);
  const pendingBy = pendingBySession(state);
  const finishedAll = live.filter((s) => s.lifecycle === 'turn_finished' && !pendingBy.has(s.id) && s.completion !== 'human_steps').sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt - a.updatedAt);
  return {
    needsYou: c.needsAttention + c.humanTasks,
    live,
    pendingBy,
    groups: [
      { key: 'wait', list: live.filter((s) => s.lifecycle === 'waiting_for_user' || pendingBy.has(s.id) || s.completion === 'human_steps') },
      { key: 'run', list: live.filter((s) => s.lifecycle === 'running') },
      { key: 'queue', list: live.filter((s) => s.lifecycle === 'queued').sort((a, b) => (a.queuePosition ?? 99) - (b.queuePosition ?? 99)) },
      { key: 'bad', list: live.filter((s) => ['error', 'interrupted', 'unknown'].includes(s.lifecycle)) },
      { key: 'done', list: showAllFinished ? finishedAll : finishedAll.slice(0, 8), total: finishedAll.length },
    ],
    /** Finished work whose result the human has already looked at: can be put away in one go. */
    seenFinished: finishedAll.filter((x) => !x.unread && x.completion === 'unverified'),
  };
}

/**
 * The inbox: the one list from which every piece of work is managed, most pressing first.
 * Every session that is not put away is in at least one group, so nothing can only be reached from elsewhere:
 *   open        requests to answer (a session with one is reached through it)
 *   steps       the agent is done, the rest is the human's
 *   needsFix    the automatic check failed
 *   candidates  the check passed: can be called done
 *   problems    stopped: failed, interrupted, or in an unknown state
 *   finished    the reply ended and nothing checks it: read it, reply, or call it done
 *   active      still going: running, queued, being checked, or waiting on the human without a request we can show
 */
export function inboxModel(state) {
  const live = state.sessions.filter((s) => !s.archived);
  const open = state.items.filter(openIn(state));
  const asked = new Set(open.map((i) => i.sessionId));
  const stopped = (s) => ['error', 'interrupted', 'unknown'].includes(s.lifecycle);
  const going = (s) => s.completion === 'validating' || s.lifecycle === 'running' || s.lifecycle === 'queued' || (s.lifecycle === 'waiting_for_user' && !asked.has(s.id));
  const ORDER = { waiting_for_user: 0, running: 1, turn_finished: 2, queued: 3 };
  return {
    open,
    steps: live.filter((s) => s.completion === 'human_steps'),
    candidates: live.filter((s) => s.completion === 'candidate'),
    needsFix: live.filter((s) => s.completion === 'needs_fix'),
    problems: live.filter((s) => stopped(s) && s.completion !== 'validating').sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt - a.updatedAt),
    finished: live.filter((s) => (s.completion === 'unverified' || s.completion === 'accepted') && !asked.has(s.id)).sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt - a.updatedAt),
    active: live.filter(going).sort((a, b) => (ORDER[a.lifecycle] ?? 9) - (ORDER[b.lifecycle] ?? 9) || (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || b.updatedAt - a.updatedAt),
    allUnread: live.filter((s) => s.unread),
  };
}

/** True when the session can be found in the inbox (through a request or in one of its groups). */
export function inInbox(state, sessionId) {
  const m = inboxModel(state);
  return m.open.some((i) => i.sessionId === sessionId) || [m.steps, m.candidates, m.needsFix, m.problems, m.finished, m.active].some((g) => g.some((s) => s.id === sessionId));
}

/**
 * Accordion of open requests: answering an open one opens the next; with nothing open, the first opens by itself.
 * Updates store.expanded / lastOpenIds / userCollapsed and returns the request that was opened now (or null) and
 * whether that happened because another one was just answered.
 */
export function advanceAccordion(store, ids) {
  const { expanded } = store;
  let answeredAt = -2;
  for (const id of [...expanded]) {
    if (ids.includes(id)) continue;
    expanded.delete(id);
    if (store.lastOpenIds.includes(id)) answeredAt = Math.max(answeredAt, store.lastOpenIds.indexOf(id));
  }
  let opened = null;
  if (answeredAt > -2) {
    opened = ids.find((id) => !expanded.has(id) && (store.lastOpenIds.indexOf(id) > answeredAt || !store.lastOpenIds.includes(id))) ?? ids.find((id) => !expanded.has(id)) ?? null;
  } else if (!ids.some((id) => expanded.has(id)) && !store.userCollapsed && ids.length) {
    opened = ids[0];
  }
  if (opened) expanded.add(opened);
  if (!ids.length) store.userCollapsed = false;
  store.lastOpenIds = ids;
  return { opened, afterAnswer: answeredAt > -2 };
}

/** Open or close one request by hand. */
export function toggleTicket(store, itemId) {
  if (store.expanded.has(itemId)) {
    store.expanded.delete(itemId);
    if (!store.state.items.some((x) => openIn(store.state)(x) && store.expanded.has(x.id))) store.userCollapsed = true;
  } else {
    store.expanded.add(itemId);
    store.userCollapsed = false;
  }
}

/** One session's screen: the session and what can be done with it right now. */
export function sessionModel(state, id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return null;
  const res = s.resources;
  return {
    s,
    busy: isBusy(s),
    /** Processes a session that is no longer live left running. */
    leftovers: !!(res && !res.shared && !s.live && res.processCount > 0),
    /** Unanswered requests of other sessions (for "next one"). */
    others: state.items.filter((i) => i.status === 'pending' && i.sessionId !== id),
    mine: state.items.filter((i) => i.sessionId === id && openIn(state)(i)),
  };
}

/** The session after (or before) `currentId` in the order the rail shows them. */
export function neighbour(order, currentId, backwards) {
  const at = order.indexOf(currentId);
  return order[(at + (backwards ? -1 : 1) + order.length) % order.length];
}

/** How many put-away sessions each project shows before "もっと見る". */
export const ARCHIVE_FOLD = 5;

/**
 * Put-away work, one group per project (the project used most recently first), newest first inside each group.
 * `query`: words separated by spaces, all of which must appear in the title, project name or agent (case and
 * full/half width ignored).
 */
export function archiveModel(state, query = '') {
  const norm = (t) => String(t ?? '').normalize('NFKC').toLowerCase();
  const words = norm(query).split(/\s+/).filter(Boolean);
  const hit = (s) => { const hay = norm(`${s.taskTitle} ${s.projectName} ${s.provider}`); return words.every((w) => hay.includes(w)); };
  const groups = new Map();
  for (const s of state.sessions) {
    if (!s.archived || !hit(s)) continue;
    const key = s.projectId ?? s.projectName ?? '';
    if (!groups.has(key)) groups.set(key, { key, name: s.projectName || '(プロジェクトなし)', sessions: [] });
    groups.get(key).sessions.push(s);
  }
  const list = [...groups.values()];
  for (const g of list) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.sort((a, b) => b.sessions[0].updatedAt - a.sessions[0].updatedAt);
}

const UPDATE_RANK = { none: 0, reload: 1, rebuild: 2 };
/** An ordinary step (not something to look at), still to do. */
export const openPlainStep = (st) => !st.check && !st.done;

/**
 * The things to look at, from every work that waits on the human, one group per project: works in the same project
 * usually leave the same action (bring the change into the app) and differ only in what to look at. The group's action
 * is the strongest any of them needs (rebuild > reload > none). Items keep their work and their place in its list, so
 * ticking one ticks that work's step; a work whose last step is ticked is done. Done items stay (struck through) for as
 * long as their work is on the list.
 */
export function checkGroups(sessions) {
  const by = new Map();
  for (const s of sessions) {
    (s.task?.humanSteps ?? []).forEach((st, index) => {
      if (!st.check) return;
      let g = by.get(s.projectId);
      if (!g) by.set(s.projectId, (g = { projectId: s.projectId, projectName: s.projectName, update: 'none', hows: [], commands: [], works: [] }));
      if (UPDATE_RANK[st.check.update] > UPDATE_RANK[g.update]) g.update = st.check.update;
      if (st.check.how && !g.hows.includes(st.check.how)) g.hows.push(st.check.how);
      if (st.check.command && !g.commands.some((c) => c.command === st.check.command)) g.commands.push({ sessionId: s.id, command: st.check.command });
      let w = g.works.find((x) => x.session.id === s.id);
      if (!w) g.works.push((w = { session: s, items: [] }));
      w.items.push({ index, step: st });
    });
  }
  // A group with nothing left to tick is not something to deal with.
  return [...by.values()].filter((g) => g.works.some((w) => w.items.some((i) => !i.step.done)));
}

/** A battery is drawn as this many cells: each stands for a fifth of the window. */
export const BATTERY_CELLS = 5;
/**
 * What is left of each service's plan windows (5-hour and weekly), for the battery gauges. `left` is a percentage or
 * null when unknown; `cells` how many of the BATTERY_CELLS are lit (any amount left lights at least one).
 */
export function limitsModel(usage) {
  return ['claude', 'codex'].map((provider) => ({
    provider,
    windows: ['five_hour', 'weekly'].map((kind) => {
      const l = (usage?.[provider]?.limits ?? []).find((x) => x.kind === kind);
      const left = l && l.usedPercent !== null && l.usedPercent !== undefined ? Math.max(0, Math.min(100, Math.round(100 - l.usedPercent))) : null;
      return { kind, label: l?.label ?? null, left, cells: left === null ? 0 : Math.ceil((left / 100) * BATTERY_CELLS), resetsAt: l?.resetsAt ?? null };
    }),
  }));
}

/** Work that stopping the app would interrupt. */
export const busyCount = (state) => {
  const c = state?.counts ?? {};
  return (c.running ?? 0) + (c.waiting ?? 0) + (c.queued ?? 0);
};
