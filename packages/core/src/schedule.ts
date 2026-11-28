// When scheduled work runs. Pure: a rule and a moment in, the next moment out (local time of this machine).
// The screen keeps a copy of these two functions (public/js/logic/schedule-rule.js) so a change shows its next run at
// the click; test/schedules.test.ts holds the two to the same answers.

/**
 *  daily     at `time` (HH:MM) on the given days of the week (0 = Sunday .. 6 = Saturday; all seven = every day)
 *  interval  every `minutes`, counted from the last run (or from when the schedule was saved)
 *  once      at `at` (epoch ms), then the schedule turns itself off
 */
export type ScheduleRule =
  | { kind: 'daily'; time: string; days: number[] }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: number };

/** Shortest and longest gap of an interval rule, in minutes (5 minutes .. 7 days). */
export const SCHEDULE_INTERVAL_MIN = 5;
export const SCHEDULE_INTERVAL_MAX = 7 * 24 * 60;

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A rule as sent by a screen, made exact; null if it is not one. Days are kept once each, in order. */
export function settleRule(input: unknown): ScheduleRule | null {
  const r = input as { kind?: unknown; time?: unknown; days?: unknown; minutes?: unknown; at?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'daily') {
    const m = TIME.exec(String(r.time ?? ''));
    const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
    if (!m || !days.length) return null;
    return { kind: 'daily', time: `${m[1]!.padStart(2, '0')}:${m[2]}`, days };
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

/**
 * The first moment strictly after `after` at which the rule runs, or null if it never runs again.
 * For an interval, `after` is the run (or the save) it counts from.
 */
export function nextRunAt(rule: ScheduleRule, after: number): number | null {
  if (rule.kind === 'once') return rule.at > after ? rule.at : null;
  if (rule.kind === 'interval') return after + rule.minutes * 60_000;
  const [h, m] = rule.time.split(':').map(Number) as [number, number];
  const d = new Date(after);
  // Today's time first, then each following day; a week and a day covers every combination of days.
  for (let i = 0; i <= 7; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
    if (at.getTime() > after && rule.days.includes(at.getDay())) return at.getTime();
  }
  return null;
}
