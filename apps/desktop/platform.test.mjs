// The desktop shell has one module per OS (platform/windows.mjs, platform/mac.mjs). Whoever adds something to one
// must add it to the other: main.mjs and updater.mjs call both through the same names. Both files load on any OS
// (they import nothing OS-specific at the top), so this runs everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as windows from './platform/windows.mjs';
import * as mac from './platform/mac.mjs';
import { platform } from './platform/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const shape = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, typeof m[k]]));

test('both platforms export the same things, of the same kind', () => {
  assert.deepEqual(shape(windows), shape(mac));
  assert.deepEqual(Object.keys(windows.words).sort(), Object.keys(mac.words).sort());
  assert.ok(platform === windows || platform.id === 'mac');
});

test('everything the shell calls on the platform exists', () => {
  const used = new Set();
  for (const file of ['main.mjs', 'updater.mjs', 'package.mjs', 'install.mjs', 'remote-version.mjs']) {
    for (const m of readFileSync(join(here, file), 'utf8').matchAll(/\bplatform\.(\w+)/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 10, 'the shell goes through the platform module');
  for (const name of used) assert.ok(name in windows && name in mac, `platform.${name} is used by the shell but not exported by both platforms`);
});

test('where the built app lives: each platform names its bundle, its program and its files', () => {
  assert.equal(windows.bundleName('Orrery'), 'Orrery-win32-x64');
  assert.match(mac.bundleName('Orrery'), /^Orrery-darwin-(arm64|x64)$/);
  // The repository is found again from the program inside it (how a packaged app knows what to rebuild).
  for (const [p, repo] of [[windows, resolve('/work/orrery')], [mac, '/work/orrery']]) {
    if (p === mac && platform !== mac) continue; // POSIX paths do not resolve the same way on Windows
    if (p === windows && platform !== windows) continue;
    const bundle = join(repo, 'release', p.bundleName('Orrery'));
    assert.equal(p.repoOfExe(p.exeIn(bundle, 'Orrery')), repo);
    assert.ok(p.resourcesIn(bundle, 'Orrery').startsWith(bundle));
  }
});

test('every file a platform refers to is in the repository', () => {
  for (const p of [windows, mac]) {
    assert.ok(existsSync(join(here, p.swapScript)), p.swapScript);
    for (const alert of [false, true]) assert.ok(existsSync(p.trayIcon(here, alert)), p.trayIcon(here, alert));
    assert.ok(existsSync(p.packagerOptions(root).icon), p.packagerOptions(root).icon);
  }
  assert.ok(existsSync(join(here, 'tray-mac@2x.png')) && existsSync(join(here, 'tray-mac-alert@2x.png')), 'the menu bar images have @2x versions');
  assert.ok(existsSync(join(here, 'install-app.sh')) && existsSync(join(here, 'install-shortcuts.ps1')));
});

// Apps installed before v0.6 update themselves by running, from the NEW source, exactly these paths with exactly
// these names (their own, old code decides what to run). Moving or renaming any of them strands those installs:
// the old app quits to be replaced and nothing starts again.
test('update contract with already-installed Windows apps (v0.5 and earlier)', () => {
  assert.ok(existsSync(join(here, 'package.mjs')), 'apps/desktop/package.mjs');
  assert.ok(existsSync(join(here, 'update-swap.ps1')), 'apps/desktop/update-swap.ps1');
  assert.ok(existsSync(join(here, 'install-shortcuts.ps1')), 'apps/desktop/install-shortcuts.ps1');
  assert.equal(windows.exeIn(join('release', '.staging', windows.bundleName('Orrery')), 'Orrery'), join('release', '.staging', 'Orrery-win32-x64', 'Orrery.exe'));
  const swap = readFileSync(join(here, 'update-swap.ps1'), 'utf8');
  for (const param of ['$WaitPid', '$Exe', '$Log', '$Arguments', '$WorkingDirectory', '$Release']) assert.ok(swap.includes(param), `update-swap.ps1 takes ${param}`);
  assert.ok(swap.includes("'Orrery-win32-x64'"));
});

test('shell scripts are stored with LF line endings (bash refuses CRLF)', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\.sh\s+text\s+eol=lf$/m);
});

// The swap itself, with a pretend app: a folder that holds a "program" (a script that leaves a note when started).
test('macOS: update-swap.sh waits, swaps the new build in, starts it, and removes the old one', { skip: platform.id !== 'mac' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'orrery-swap-'));
  const release = join(base, 'release');
  const name = 'Orrery-darwin-test';
  const note = join(base, 'started.txt');
  const build = (dir, label) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Orrery'), `#!/bin/bash\necho "${label} $*" >> "${note}"\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'which.txt'), label);
  };
  build(join(release, name), 'old');
  build(join(release, '.staging', name), 'new');
  // Not a child of this process: the test blocks while the script runs, so a child of ours that ended would never be
  // collected and would look alive to the script for as long as it cared to wait.
  const waitedPid = Number(execFileSync('/bin/sh', ['-c', '/bin/sleep 3 > /dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
  const began = Date.now();
  const log = join(base, 'update.log');
  try {
    execFileSync('/bin/bash', [join(here, 'update-swap.sh'), '--wait-pid', String(waitedPid), '--exe', join(release, name, 'Orrery'), '--log', log, '--release', release, '--name', name, '--', '--flag', 'two words'], { stdio: 'ignore', timeout: 60_000 });
    const text = readFileSync(log, 'utf8');
    assert.ok(Date.now() - began > 2000, 'it waited for the process to end');
    assert.ok(Date.now() - began < 15_000, 'and no longer than that');
    assert.equal(readFileSync(join(release, name, 'which.txt'), 'utf8'), 'new', `the new build is in place\n${text}`);
    assert.ok(!existsSync(join(release, '.staging')) && !existsSync(join(release, '.previous')), 'nothing is left behind');
    for (let i = 0; i < 50 && !existsSync(note); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(readFileSync(note, 'utf8'), 'new --flag two words\n', 'the new program was started, with its arguments intact');
    assert.match(text, /started .*\n.* done\n$/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('macOS: update-swap.sh with no new build starts the program that is there and says so', { skip: platform.id !== 'mac' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'orrery-swap-'));
  const release = join(base, 'release');
  const name = 'Orrery-darwin-test';
  const note = join(base, 'started.txt');
  mkdirSync(join(release, name), { recursive: true });
  writeFileSync(join(release, name, 'Orrery'), `#!/bin/bash\necho old >> "${note}"\n`, { mode: 0o755 });
  const log = join(base, 'update.log');
  try {
    execFileSync('/bin/bash', [join(here, 'update-swap.sh'), '--wait-pid', '999999', '--exe', join(release, name, 'Orrery'), '--log', log, '--release', release, '--name', name], { stdio: 'ignore', timeout: 60_000, env: { ...process.env, PATH: '/usr/bin:/bin' } });
    for (let i = 0; i < 50 && !existsSync(note); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(readFileSync(note, 'utf8'), 'old\n');
    assert.match(readFileSync(log, 'utf8'), /no new build at .*\n[\s\S]*update failed; previous build started\n$/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
