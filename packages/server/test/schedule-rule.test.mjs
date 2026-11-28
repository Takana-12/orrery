// The screen keeps its own copy of when scheduled work runs (public/js/logic/schedule-rule.js), so a change shows its
// next run at the click. It must give the server's answers (packages/core/src/schedule.ts), exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, settleRule } from '#core';
import * as screen from '../public/js/logic/schedule-rule.js';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('the screen works out the next run exactly as the server does', () => {
  const rules = [
    { kind: 'daily', time: '09:05', days: [1, 3, 5] },
    { kind: 'daily', time: '00:00', days: [0, 1, 2, 3, 4, 5, 6] },
    { kind: 'daily', time: '7:30', days: [6] },
    { kind: 'interval', minutes: 5 },
    { kind: 'interval', minutes: 1440 },
    { kind: 'once', at: local(2026, 12, 1, 12, 0) },
  ];
  const moments = [local(2026, 11, 28, 0, 0), local(2026, 11, 30, 9, 5), local(2026, 12, 1, 11, 59), local(2026, 12, 6, 23, 59), local(2027, 3, 28, 1, 30)];
  for (const raw of [...rules, { kind: 'daily', time: '25:00', days: [1] }, { kind: 'interval', minutes: 1 }]) {
    assert.deepEqual(screen.settleRule(raw), settleRule(raw), `settle ${JSON.stringify(raw)}`);
    const r = settleRule(raw);
    if (r) for (const m of moments) assert.equal(screen.nextRunAt(r, m), nextRunAt(r, m), `${JSON.stringify(r)} after ${new Date(m).toString()}`);
  }
});

