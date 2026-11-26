import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRunWorktrees } from './e2e-cleanup.ts';

const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

test('removes only the worktrees and orrery branches under the run folder, then the folder', () => {
  const repo = mkdtempSync(join(tmpdir(), 'e2e-cleanup-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'e2e-cleanup-home-'));
  const other = mkdtempSync(join(tmpdir(), 'e2e-cleanup-other-'));
  try {
    git(repo, 'init', '-q', '-b', 'master');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const inRun = join(home, 'worktrees', 'repo-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'orrery/1', inRun);
    writeFileSync(join(inRun, 'stray.txt'), 'untracked'); // e2e leaves untracked files: must still go
    // As Orrery does: the repo's node_modules linked into the worktree (and into a subfolder) as junctions.
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'keep me');
    symlinkSync(join(repo, 'node_modules'), join(inRun, 'node_modules'), 'junction');
    mkdirSync(join(inRun, 'sub'));
    symlinkSync(join(repo, 'node_modules'), join(inRun, 'sub', 'node_modules'), 'junction');
    const kept = join(other, 'keep');
    git(repo, 'worktree', 'add', '-q', '-b', 'orrery/keep', kept);

    const r = removeRunWorktrees(repo, home);

    assert.equal(readFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'utf8'), 'keep me', 'what the links point at is untouched');
    assert.deepEqual(r.branches, ['orrery/1']);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(kept), true);
    const list = git(repo, 'worktree', 'list', '--porcelain');
    assert.ok(!list.includes('repo-1'));
    assert.ok(list.includes('keep'));
    assert.deepEqual(git(repo, 'branch', '--format=%(refname:short)').trim().split('\n').sort(), ['master', 'orrery/keep']);
  } finally {
    for (const d of [repo, home, other]) rmSync(d, { recursive: true, force: true });
  }
});
