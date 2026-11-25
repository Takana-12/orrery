// Real git repositories in a temporary folder: a "GitHub" (bare), the user's clone, and the maintainer's clone that publishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRemote, pullRemote } from './remote-version.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const commit = (cwd, file, text, msg) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, ...ident, 'commit', '-q', '-m', msg);
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-remote-'));
  const hub = join(dir, 'hub.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', hub);
  const pub = join(dir, 'pub');
  git(dir, 'clone', '-q', hub, pub);
  git(pub, 'checkout', '-q', '-B', 'main');
  commit(pub, 'package.json', '{"version":"0.4.0"}', 'v0.4.0');
  git(pub, 'push', '-q', '-u', 'origin', 'main');
  const user = join(dir, 'user');
  git(dir, 'clone', '-q', hub, user);
  return { dir, pub, user, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a clone with nothing new on GitHub is up to date', async () => {
  const t = setup();
  try {
    const r = await checkRemote(t.user);
    assert.equal(r.tracking, 'origin/main');
    assert.equal(r.behind, 0);
    assert.equal(r.latest, null);
  } finally {
    t.done();
  }
});

test('a newer version on GitHub is found, brought in, and says whether the dependencies changed', async () => {
  const t = setup();
  try {
    commit(t.pub, 'README.md', 'new', 'v0.4.1 の更新を反映');
    git(t.pub, 'push', '-q');
    let r = await checkRemote(t.user);
    assert.equal(r.behind, 1);
    assert.equal(r.ahead, 0);
    assert.equal(r.latest.subject, 'v0.4.1 の更新を反映');
    let p = await pullRemote(t.user);
    assert.notEqual(p.from, p.to);
    assert.equal(p.depsChanged, false, 'only the README changed');
    assert.equal((await checkRemote(t.user)).behind, 0);

    commit(t.pub, 'package.json', '{"version":"0.5.0"}', 'v0.5.0 の更新を反映');
    git(t.pub, 'push', '-q');
    p = await pullRemote(t.user);
    assert.equal(p.depsChanged, true, 'package.json changed: npm install is needed');
  } finally {
    t.done();
  }
});

test('a clone with its own commits is told about the new version but never merged into', async () => {
  const t = setup();
  try {
    commit(t.pub, 'README.md', 'new', 'upstream');
    git(t.pub, 'push', '-q');
    commit(t.user, 'mine.txt', 'mine', 'my own change');
    const r = await checkRemote(t.user);
    assert.equal(r.behind, 1);
    assert.equal(r.ahead, 1);
    const head = git(t.user, 'rev-parse', 'HEAD');
    await assert.rejects(pullRemote(t.user), /取り込めませんでした/);
    assert.equal(git(t.user, 'rev-parse', 'HEAD'), head, 'left as it was');
  } finally {
    t.done();
  }
});

test('a repository without an upstream (a private development copy) is never checked', async () => {
  const t = setup();
  try {
    const solo = join(t.dir, 'solo');
    git(t.dir, 'init', '-q', '-b', 'master', solo);
    commit(solo, 'a.txt', 'a', 'first');
    const r = await checkRemote(solo);
    assert.deepEqual({ tracking: r.tracking, behind: r.behind }, { tracking: null, behind: 0 });
  } finally {
    t.done();
  }
});

test('GitHub out of reach is an error to show, not a crash', async () => {
  const t = setup();
  try {
    git(t.user, 'remote', 'set-url', 'origin', join(t.dir, 'gone.git'));
    await assert.rejects(checkRemote(t.user));
  } finally {
    t.done();
  }
});
