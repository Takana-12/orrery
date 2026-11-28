// Opening a file or folder an agent named: where it is, and that nothing that would run is ever opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTarget } from '../src/application/open-path.ts';

test('a named file or folder opens; what would run is only shown in its folder', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-open-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  for (const f of ['notes.md', 'app.ts', 'run.js', 'setup.exe', 'Makefile']) writeFileSync(join(root, f), '');

  assert.deepEqual(openTarget(join(root, 'notes.md'), null), { path: join(root, 'notes.md'), how: 'open' });
  assert.deepEqual(openTarget(join(root, 'docs'), null), { path: join(root, 'docs'), how: 'open' });
  // Relative: from the work's folder.
  assert.deepEqual(openTarget('docs/', root), { path: join(root, 'docs'), how: 'open' });
  assert.deepEqual(openTarget('./app.ts', root), { path: join(root, 'app.ts'), how: 'open' });
  // Programs, scripts (a .js runs when opened on Windows) and unknown kinds: shown, not opened.
  for (const f of ['run.js', 'setup.exe', 'Makefile']) assert.equal(openTarget(f, root).how, 'reveal', f);
  // ~ is the home folder.
  assert.deepEqual(openTarget('~/notes.md', null, root), { path: join(root, 'notes.md'), how: 'open' });

  const refused = (fn: () => unknown, status: number) => assert.throws(fn, (e: { status?: number }) => e.status === status);
  refused(() => openTarget('docs/', null), 400); // relative, with nowhere to find it from
  refused(() => openTarget(join(root, 'missing.md'), null), 404);
  refused(() => openTarget('\\\\server\\share\\x.md', null), 400);
  refused(() => openTarget('//server/share/x.md', null), 400);
  refused(() => openTarget('', root), 400);
});
