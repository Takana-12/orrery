// What every OS implementation of #host must do. The same expectations run on Windows and on macOS (CI runs both),
// so a change to one implementation cannot quietly leave the other behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { host } from '../src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await sleep(100);
  }
}

/**
 * A parent that starts a child, prints the child's pid, and (optionally) exits, leaving the child without a parent.
 * `apart`: the child is started detached, the way a dev server or a watcher usually is (on Windows a child that is
 * not detached ends with its Node parent anyway; on macOS a detached child leaves its parent's process group).
 */
function family(parentExits: boolean, apart = false) {
  const grandchild = `setInterval(() => {}, 1000)`;
  const parent = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: ${apart}, windowsHide: true }); console.log(c.pid); ${parentExits ? 'setTimeout(() => process.exit(0), 1500)' : 'setInterval(() => {}, 1000)'}`;
  const child = spawn(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...host.ownedSpawn });
  const grandPid = new Promise<number>((ok) => child.stdout!.once('data', (d) => ok(Number(String(d).trim()))));
  return { child, grandPid };
}

test('host: it says which OS it is, in the words the rest of the code uses', () => {
  assert.ok(host.os === 'windows' || host.os === 'mac');
  assert.match(host.archTag, /^(windows|macos)-(x86_64|aarch64)$/);
  assert.equal(host.executableName('claude'), host.os === 'windows' ? 'claude.exe' : 'claude');
});

test('host: it can open a file or folder, or show it in its folder (not run here: it would open a window)', () => {
  assert.equal(typeof host.openPath, 'function');
  assert.equal(host.openPath.length, 2);
});

test('job: owns a process and what it starts, measures them, and ends them all at once', async () => {
  const job = host.createJob();
  const { child, grandPid } = family(false);
  try {
    job.assign(child.pid!);
    const grand = await grandPid;
    await until('the grandchild is in the job', () => job.pids().includes(grand));
    assert.ok(job.pids().includes(child.pid!));
    const s = job.sample();
    assert.ok(s.processCount >= 2, `processCount ${s.processCount}`);
    assert.ok(s.workingSetBytes > 1024 * 1024, `workingSetBytes ${s.workingSetBytes}`);
    assert.ok(s.processes.every((p) => p.image.length > 0 && !/[\\/]/.test(p.image)), 'image names without folders');
    assert.ok(s.scope.length > 0);
    assert.equal(job.terminate(), true);
    await until('everything in the job has ended', () => !alive(child.pid!) && !alive(grand));
    assert.equal(job.pids().length, 0);
  } finally {
    job.close();
    child.kill();
  }
});

test('job: a detached grandchild whose parent has exited is still ours, and closing the job ends it', async () => {
  const job = host.createJob();
  const { child, grandPid } = family(true, true);
  try {
    job.assign(child.pid!);
    const grand = await grandPid;
    // Seen once while its parent was alive (the app samples every few seconds), it stays ours from then on.
    await until('the grandchild is in the job', () => job.pids().includes(grand));
    await until('the parent has exited', () => child.exitCode !== null);
    await sleep(300);
    assert.ok(alive(grand), 'the grandchild outlived its parent');
    assert.ok(job.pids().includes(grand), 'and is still counted as ours');
    job.close();
    await until('closing the job ended the grandchild', () => !alive(grand));
  } finally {
    job.close();
    child.kill();
  }
});

test('job (macOS): an orphan that was never sampled is still found, through its process group', { skip: host.os !== 'mac' }, async () => {
  const job = host.createJob();
  const { child, grandPid } = family(true);
  try {
    job.assign(child.pid!);
    const grand = await grandPid;
    await until('the parent has exited', () => child.exitCode !== null);
    await sleep(300);
    assert.ok(alive(grand), 'the grandchild outlived its parent');
    assert.deepEqual(job.pids(), [grand]);
    job.close();
    await until('closing the job ended the grandchild', () => !alive(grand));
  } finally {
    job.close();
    child.kill();
  }
});

test('job: assigning a process that does not exist is refused', () => {
  const job = host.createJob();
  try {
    assert.throws(() => job.assign(0x3ffffffe));
  } finally {
    job.close();
  }
});

test('secrets: values round-trip and the stored form does not contain the secret', (t) => {
  // macOS keeps the key in the login keychain: use an item of our own, removed afterwards.
  process.env.ORRERY_KEYCHAIN_SERVICE = `Orrery test ${process.pid}`;
  t.after(async () => {
    if (host.os === 'mac') (await import('../src/mac/keychain.ts')).forgetKey();
    delete process.env.ORRERY_KEYCHAIN_SERVICE;
  });
  for (const secret of ['sk-test-1234567890', '日本語の値 with spaces', 'x'.repeat(5000)]) {
    const cipher = host.protect(secret);
    if (secret) {
      assert.notEqual(cipher, secret);
      assert.equal(Buffer.from(cipher, 'base64').includes(Buffer.from(secret.slice(0, 12), 'utf8')), false);
    }
    assert.equal(host.unprotect(cipher), secret);
  }
  assert.throws(() => host.unprotect(Buffer.from('not something we stored').toString('base64')));
});

test('the machine: programs are found, memory is measured, the data folder is a real place', () => {
  const node = host.findExecutable('node');
  assert.ok(node && isAbsolute(node) && existsSync(node), `node on PATH: ${node}`);
  assert.equal(host.findExecutable('orrery-no-such-program'), null);
  const free = host.freeMemoryBytes();
  assert.ok(free > 16 * 1024 * 1024 && free < 4096 * 1024 ** 3, `free memory ${free}`);
  assert.ok(isAbsolute(host.defaultDataDir()) && /AgentControlRoom$/.test(host.defaultDataDir()));
  assert.doesNotThrow(() => host.adoptShellPath());
  assert.ok(host.findExecutable('node'), 'node is still found after adopting the shell PATH');
});

test('the machine: the children of a process can be listed by image name', async () => {
  const { child, grandPid } = family(false);
  try {
    await grandPid;
    const images = host.childImages(child.pid!);
    assert.equal(images.filter((image) => /^node(\.exe)?$/i.test(image)).length, 1, `children: ${images.join(', ')}`);
  } finally {
    const grand = await grandPid;
    child.kill();
    try {
      process.kill(grand);
    } catch {}
  }
});
