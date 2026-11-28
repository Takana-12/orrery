// The home screen's orrery. Work that is still going circles the sphere, each on its own orbit; every thing that
// waits for the human to decide or look at something lies still on a wide, shallow arc just above the new-work box: a
// request to answer, an agent that waits for the human without a request, the human's own steps, a failed check, work
// that can be called done, work that stopped, a finished reply not yet read, and the preferences recorded by themselves.
// When work that was going comes to wait for the human, its light leaves its orbit and glides down to the arc (the
// view links the two by `sid`, the session's id).
// No DOM here: the view (ui/views/home.js) draws what this returns.
import { knowledgeNews } from './knowledge.js';
import { checkGroups, inboxModel, openPlainStep } from './selectors.js';

/** How many orbits the human may choose between (settings → 外観). */
export const MAX_RINGS = 5;
export const DEFAULT_RINGS = 3;

const ws = (s) => [s.projectName, ...(s.extraProjectNames ?? [])].filter(Boolean).join('・');
const work = (kind) => (s) => ({ key: `${kind}:${s.id}`, kind, sid: s.id, workspace: ws(s), title: s.taskTitle, s });
/** Going, but waiting for the human in a way the agent could not put as a request: that is on the arc, not an orbit. */
const waitsForHuman = (s) => s.lifecycle === 'waiting_for_user' && s.completion !== 'validating';

/**
 * Work that is still going, one point per piece of work: { key, kind, sid, workspace, title, s }.
 *   kind  running (an agent works, or its result is being checked) | queued (waits for its turn)
 */
export function orbitEntries(state) {
  return inboxModel(state).active.filter((s) => !waitsForHuman(s)).map((s) => work(s.lifecycle === 'queued' ? 'queued' : 'running')(s));
}

/**
 * Everything on the arc, most pressing first. Each entry: { key, kind, sid, workspace, title, s?, item?, g?, news? }.
 *   kind  ask | waiting | steps | look | fix | candidate | problem | finished | report | news
 * (waiting: the agent waits for the human in a way it could not put as a request; it is otherwise still going)
 * `key` stays the same for as long as the thing waits, so its point keeps its place on the arc.
 */
export function arcEntries(state) {
  const m = inboxModel(state);
  const out = [
    ...m.open.map((i) => ({ key: `ask:${i.id}`, kind: 'ask', sid: i.sessionId, workspace: i.projectName ?? '', title: i.taskTitle, item: i })),
    ...m.active.filter(waitsForHuman).map(work('waiting')),
    ...checkGroups(m.steps).map((g) => ({ key: `look:${g.projectId}`, kind: 'look', sid: null, workspace: g.projectName ?? '', title: g.projectName ?? '', g })),
    ...m.steps.filter((s) => (s.task?.humanSteps ?? []).some(openPlainStep)).map(work('steps')),
    ...m.needsFix.map(work('fix')),
    ...m.candidates.map(work('candidate')),
    ...m.problems.map(work('problem')),
    // A finished reply waits on the arc until it has been read; after that it is found in the rail like work that is going.
    // A report (research: the reply is what was asked for) shows the reply's opening instead. Its key stays that of a
    // finished reply, so the point keeps its place when the reply is told to be one.
    ...m.finished.filter((s) => s.unread).map((s) => ({ ...work('finished')(s), kind: s.task?.kind === 'report' ? 'report' : 'finished' })),
  ];
  const news = knowledgeNews(state);
  if (news.count) out.push({ key: 'news', kind: 'news', sid: null, workspace: '', title: 'こだわり', news });
  return out;
}

/**
 * Which orbit each point goes on, 0 (innermost) .. rings-1. A point keeps the orbit it was given (`prev`, key → ring)
 * for as long as it circles; a new one goes on the orbit with the fewest points (the inner one on a tie). When the
 * number of orbits is lowered, points on orbits that are gone move in the same way.
 */
export function assignRings(prev, keys, rings) {
  const n = Math.max(1, Math.min(MAX_RINGS, rings));
  const next = new Map();
  const load = Array(n).fill(0);
  for (const k of keys) {
    const r = prev.get(k);
    if (r !== undefined && r < n) { next.set(k, r); load[r]++; }
  }
  for (const k of keys) {
    if (next.has(k)) continue;
    const r = load.indexOf(Math.min(...load));
    next.set(k, r);
    load[r]++;
  }
  return next;
}

/**
 * Where `n` points lie on the arc above the new-work box: a parabola open upwards, wide and shallow. `half` is half its
 * width, `depth` how much higher its ends are than its middle, `gap` the room each point would like (it is squeezed
 * when there is not enough). Returns, from left to right, { dx, rise }: px from the middle, and px above the lowest point.
 */
export function arcSpots(n, { half, depth, gap }) {
  if (n <= 0) return [];
  const step = n === 1 ? 0 : Math.min(gap, (2 * half) / (n - 1));
  return Array.from({ length: n }, (_, j) => {
    const dx = (j - (n - 1) / 2) * step;
    return { dx, rise: depth * (dx / half) ** 2 };
  });
}
