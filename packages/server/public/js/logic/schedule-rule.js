// When scheduled work runs: the screen's copy of packages/core/src/schedule.ts, so a change to a schedule shows its next
// run at the click. Pure. test/schedules.test.ts holds the two copies to the same answers: change both together.

export const SCHEDULE_INTERVAL_MIN = 5;
export const SCHEDULE_INTERVAL_MAX = 7 * 24 * 60;

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A rule made exact; null if it is not one. */
export function settleRule(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'daily') {
    const m = TIME.exec(String(r.time ?? ''));
    const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
    if (!m || !days.length) return null;
    return { kind: 'daily', time: `${m[1].padStart(2, '0')}:${m[2]}`, days };
  }
  if (r.kind === 'interval') {
    const minutes = Math.floor(Number(r.minutes));
    if (!Number.isFinite(minutes) || minutes < SCHEDULE_INTERVAL_MIN || minutes > SCHEDULE_INTERVAL_MAX) return null;
    return { kind: 'interval', minutes };
  }
  if (r.kind === 'once') {
    const at = Math.floor(Number(r.at));
    if (!Number.isFinite(at) || at <= 0) return null;
    return { kind: 'once', at };
  }
  return null;
}

/** The first moment strictly after `after` at which the rule runs, or null. */
export function nextRunAt(rule, after) {
  if (rule.kind === 'once') return rule.at > after ? rule.at : null;
  if (rule.kind === 'interval') return after + rule.minutes * 60_000;
  const [h, m] = rule.time.split(':').map(Number);
  const d = new Date(after);
  for (let i = 0; i <= 7; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
    if (at.getTime() > after && rule.days.includes(at.getDay())) return at.getTime();
  }
  return null;
}
