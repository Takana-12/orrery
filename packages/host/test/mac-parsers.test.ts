// The macOS implementation reads the system's own tools. Their output is parsed by pure functions, checked here on
// every OS against text as those tools print it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsofListener, parsePs, parseVmStat } from '../src/mac/ps.ts';
import { open, seal } from '../src/sealed.ts';

test('ps: pid, parent, group, memory, start time and the executable (which may contain spaces)', () => {
  const table = parsePs(
    [
      '    1     0     1  18512 Ss   Mon Nov 23 09:14:02 2026     /sbin/launchd',
      '  812     1   812 104320 S    Fri Nov 27 10:00:00 2026     /Users/me/orrery/release/Orrery-darwin-arm64/Orrery.app/Contents/MacOS/Orrery',
      ' 4021   812  4021  65536 S    Fri Nov 27 10:01:09 2026     /Users/me/My Tools/claude',
      ' 4188  4021  4021   2048 R+   Fri Nov  6 08:03:00 2026     /bin/zsh',
      ' 4190  4021  4021      0 Z    Fri Nov 27 10:02:00 2026     (node)',
      '',
      'garbage line',
    ].join('\n'),
  );
  assert.equal(table.size, 4, 'four running processes; the one that has ended (Z) is not counted');
  assert.equal(table.has(4190), false);
  assert.deepEqual(table.get(4021), { pid: 4021, ppid: 812, pgid: 4021, rssBytes: 65536 * 1024, started: 'Fri Nov 27 10:01:09 2026', command: '/Users/me/My Tools/claude' });
  assert.equal(table.get(4188)!.started, 'Fri Nov 6 08:03:00 2026', 'a one-digit day is padded with two spaces by ps');
  assert.equal(table.get(4188)!.pgid, 4021);
});

test('vm_stat: what can be handed out is free + inactive + speculative, in the page size it states', () => {
  const text = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            400000.',
    'Pages inactive:                          200000.',
    'Pages speculative:                         5000.',
    'Pages wired down:                        150000.',
  ].join('\n');
  assert.equal(parseVmStat(text), (10000 + 200000 + 5000) * 16384);
  assert.equal(parseVmStat('something else entirely'), null);
});

test('lsof: who listens on a port', () => {
  assert.deepEqual(parseLsofListener('p812\ncOrrery\nf23\n'), { pid: 812, command: 'Orrery' });
  assert.equal(parseLsofListener(''), null);
});

test('sealed values: round-trip, differ each time, and do not open with another key or after a change', () => {
  const key = Buffer.alloc(32, 7);
  const a = seal(key, '日本語の値 with spaces');
  const b = seal(key, '日本語の値 with spaces');
  assert.notEqual(a, b);
  assert.equal(open(key, a), '日本語の値 with spaces');
  assert.equal(open(key, seal(key, '')), '');
  assert.throws(() => open(Buffer.alloc(32, 8), a));
  const raw = Buffer.from(a, 'base64');
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => open(key, raw.toString('base64')));
  assert.throws(() => open(key, 'AAAA'));
});
