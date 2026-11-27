// Builds the desktop app for this machine's OS and proves the built app really runs: it starts, serves its UI and
// API, knows what it was built from, and stops completely when asked. No agents are started and no account is used.
//   node scripts/smoke-packaged.mjs [--in-place]
// By default the app is built into a temporary folder, so an Orrery installed from this repository is not touched.
// --in-place builds into release/ like "npm run package" does (CI: nothing is installed there), which also lets the
// app find the repository it came from, so "is the source newer than this build?" is checked too.
// The same script runs on Windows and macOS (CI runs both): what differs is asked of apps/desktop/platform.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from '../apps/desktop/platform/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const inPlace = process.argv.includes('--in-place');
const work = mkdtempSync(join(tmpdir(), 'orrery-smoke-'));
const out = inPlace ? join(root, 'release') : join(work, 'out');
const log = (m) => console.log(`[smoke] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const portIsFree = (port) =>
  new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });

let child = null;
try {
  // 1. Build.
  log(`building ${pkg.productName} ${pkg.version} for ${platform.id} into ${out}`);
  execFileSync(process.execPath, [join(root, 'apps/desktop/package.mjs'), '--out', out], { cwd: root, stdio: 'inherit' });
  const bundle = join(out, platform.bundleName(pkg.productName));
  const exe = platform.exeIn(bundle, pkg.productName);
  assert.ok(existsSync(exe), `the program was built: ${exe}`);
  const info = JSON.parse(readFileSync(join(platform.resourcesIn(bundle, pkg.productName), 'build-info.json'), 'utf8'));
  assert.equal(info.version, pkg.version, 'build-info.json carries the version');
  assert.ok(info.fingerprint, 'build-info.json carries what it was built from');

  // 2. Start it: hidden, on a port and with data and a browser profile of its own (never the everyday ones).
  const port = await freePort();
  const token = 'smoke-test-token';
  const home = join(work, 'home');
  let output = '';
  child = spawn(exe, ['--hidden'], {
    cwd: work,
    env: { ...process.env, CONTROL_ROOM_PORT: String(port), CONTROL_ROOM_TOKEN: token, CONTROL_ROOM_HOME: home, ORRERY_USER_DATA: join(work, 'profile'), ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  let gone = null;
  void exited.then((e) => (gone = e));

  const api = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'x-control-room-token': token, 'content-type': 'application/json', ...init.headers } });
  let up = false;
  for (let i = 0; i < 240 && !up && !gone; i++) {
    up = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  assert.ok(up, `the app started and serves its UI within a minute${gone ? ` (it exited: ${JSON.stringify(gone)})` : ''}\n${output.slice(-3000)}`);
  log(`started (pid ${child.pid}), UI on port ${port}`);

  // 3. It answers: the page, the state, and what it knows about itself.
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /<html[\s\S]*js\/main\.js/, 'the page is the UI');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401, 'the API refuses a caller without the token');
  const state = await (await api('/api/state')).json();
  assert.equal(typeof state.counts?.needsAttention, 'number', 'the state has its counts');
  assert.deepEqual(Object.keys(state.capabilities ?? {}).sort(), ['claude', 'codex'], 'both agents are wired in');
  const update = await (await api('/api/app-update')).json();
  assert.equal(update.mode, 'packaged');
  assert.equal(update.version, pkg.version);
  assert.equal(update.build?.fingerprint, info.fingerprint, 'the running app read its own build-info.json');
  if (inPlace) {
    assert.equal(resolve(update.repo), root, 'the app found the repository it was built from');
    assert.equal(update.canBuild, true, 'and can rebuild itself from it');
    assert.equal(update.upToDate, true, 'a fresh build is up to date with its source');
  }
  const storage = await api('/api/storage');
  assert.equal(storage.status, 200, 'the data folder is readable');
  assert.ok(existsSync(join(home, 'control-room.sqlite')), 'the database was created in the data folder it was given');
  log(`answers: version ${update.version}, build ${String(info.commit).slice(0, 7)}${inPlace ? ', up to date with its source' : ''}`);

  // 4. It stops completely when asked: the process ends and the port is free again.
  //    (Asked once the window has finished loading; stopping in the middle of that is a different, noisier path.)
  for (let i = 0; i < 120 && !output.includes('app ready'); i++) await sleep(250);
  assert.ok(output.includes('app ready'), `the window, the tray and the menu were set up
${output.slice(-3000)}`);
  assert.equal((await api('/api/shutdown', { method: 'POST', body: '{}' })).status, 200);
  const end = await Promise.race([exited, sleep(30_000).then(() => null)]);
  assert.ok(end, 'the app exited within 30 seconds of being asked to stop');
  assert.equal(end.code, 0, `it exited cleanly\n${output.slice(-2000)}`);
  for (let i = 0; i < 40 && !(await portIsFree(port)); i++) await sleep(250);
  assert.ok(await portIsFree(port), 'the port is free again');
  const problems = existsSync(join(home, 'control-room.log')) ? readFileSync(join(home, 'control-room.log'), 'utf8') : '';
  assert.doesNotMatch(problems, /uncaughtException|unhandledRejection/, `nothing went wrong on the way:\n${problems.slice(-2000)}`);
  child = null;
  log('stopped cleanly; port released');
  log(`OK: the ${platform.id} app builds, starts, answers and stops`);
} catch (e) {
  console.error(`[smoke] FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  try {
    child?.kill('SIGKILL');
  } catch {}
  await sleep(500);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
