// Worktree lifecycle against real git in temporary repositories (no agents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worktrees } from '../src/infrastructure/worktree.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'orrery-wt-'));
  const root = join(base, 'proj');
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'keep me');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'a.txt'), 'a');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return { root, home: join(base, 'home') };
}

test('not a git repository: no worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-wt-plain-'));
  assert.equal(await new Worktrees(join(dir, 'home')).create('s', dir, 'k'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('changes are kept on the branch, the project node_modules survives removal, reopen brings the work back', async () => {
  const { root, home } = repo();
  const w = new Worktrees(home);
  const info = (await w.create('s1', root, 'k1'))!;
  assert.ok(existsSync(join(info.path, 'a.txt')));
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'the project checkout is untouched');
  assert.ok(lstatSync(join(info.path, 'node_modules')).isSymbolicLink(), 'node_modules is linked in');
  assert.equal(git(info.path, 'status', '--porcelain'), '', 'the link does not show as a change');
  assert.equal(git(root, 'status', '--porcelain'), '', 'and hiding it changed nothing in the project checkout');

  writeFileSync(join(info.path, 'a.txt'), 'changed');
  writeFileSync(join(info.path, 'new.txt'), 'new');
  const r = await w.remove(info, 'テスト');
  assert.equal(r.savedChanges, true);
  assert.equal(r.keptBranch, true);
  assert.equal(r.ahead, 1);
  assert.ok(!existsSync(info.path), 'worktree folder removed');
  assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'keep me', 'the project node_modules was not touched');
  assert.equal(git(root, 'show', `${info.branch}:new.txt`), 'new');
  assert.equal(git(root, 'status', '--porcelain'), '', 'nothing leaked into the project checkout');

  const back = await w.reopen(r.info, root);
  assert.equal(readFileSync(join(back.path, 'a.txt'), 'utf8'), 'changed');
  assert.equal(back.removedAt, null);
  const again = await w.remove(back, 'テスト');
  assert.equal(again.keptBranch, true, 'still holds the commit');
  rmSync(join(root, '..'), { recursive: true, force: true });
});

test('a branch with nothing new, or already merged, is deleted', async () => {
  const { root, home } = repo();
  const w = new Worktrees(home);
  const empty = (await w.create('s2', root, 'k2'))!;
  const r1 = await w.remove(empty, 'x');
  assert.equal(r1.keptBranch, false);
  assert.equal(git(root, 'branch', '--list', empty.branch), '');

  const merged = (await w.create('s3', root, 'k3'))!;
  writeFileSync(join(merged.path, 'b.txt'), 'b');
  git(merged.path, 'add', '-A');
  git(merged.path, 'commit', '-qm', 'work');
  git(root, 'merge', '-q', '--ff-only', merged.branch);
  const r2 = await w.remove(merged, 'x');
  assert.equal(r2.keptBranch, false);
  assert.equal(git(root, 'branch', '--list', merged.branch), '');
  rmSync(join(root, '..'), { recursive: true, force: true });
});

test('a project in a subfolder of the repository works in the same subfolder of the worktree', async () => {
  const { root, home } = repo();
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'pkg', 'p.txt'), 'p');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'pkg');
  const info = (await new Worktrees(home).create('s4', join(root, 'pkg'), 'k4'))!;
  assert.equal(info.cwd, join(info.path, 'pkg'));
  assert.ok(existsSync(join(info.cwd, 'p.txt')));
  await new Worktrees(home).remove(info, 'x');
  assert.ok(existsSync(join(root, 'node_modules', 'dep', 'index.js')));
  rmSync(join(root, '..'), { recursive: true, force: true });
});
