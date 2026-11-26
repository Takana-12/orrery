// After an end-to-end run: take away what the run left in the real repository.
// The e2e projects are fixtures inside this repo, so every session's worktree (<home>\worktrees\...) is
// registered in this repo's .git, on a branch orrery/<key>. Without this, each run leaves ~15 worktrees
// and branches behind, and the throwaway data folder in %TEMP% too.
// Each worktree has node_modules linked in as a directory junction to this repo's own node_modules, and
// `git worktree remove` follows junctions on Windows and empties what they point at (see worktree.ts).
// So every link is unlinked first, and a folder that still has one is never deleted.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const norm = (p: string): string => {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Unlink every symbolic link / junction inside `dir` without going through any of them. Returns the links that could not be unlinked. */
export function unlinkLinks(dir: string): string[] {
  const left: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          unlinkSync(p);
        } catch {
          left.push(p);
        }
      } else if (st.isDirectory() && name !== '.git') walk(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return left;
}

/** Remove the worktrees (and their orrery/* branches) that live under `home`, then `home` itself. Returns what was removed. */
export function removeRunWorktrees(repo: string, home: string): { worktrees: string[]; branches: string[] } {
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  const under = norm(home) + sep;
  const removed = { worktrees: [] as string[], branches: [] as string[] };
  let entries: { path: string; branch: string | undefined }[] = [];
  try {
    entries = git('worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .map((block) => {
        const path = /^worktree (.+)$/m.exec(block)?.[1];
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
        return path ? { path, branch } : null;
      })
      .filter((e): e is { path: string; branch: string | undefined } => !!e);
  } catch {
    // not a git repository: nothing was registered
  }
  for (const e of entries) {
    if (!norm(e.path).startsWith(under)) continue;
    if (unlinkLinks(e.path).length) continue; // a link is left: deleting could reach the files behind it
    try {
      git('worktree', 'remove', '--force', '--force', e.path);
      removed.worktrees.push(e.path);
    } catch {
      // folder already gone or locked: prune below drops the registration
    }
    if (e.branch?.startsWith('orrery/')) {
      try {
        git('branch', '-D', e.branch);
        removed.branches.push(e.branch);
      } catch {
        // already deleted
      }
    }
  }
  try {
    git('worktree', 'prune');
  } catch {
    // not a git repository
  }
  if (unlinkLinks(home).length) return removed;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  return removed;
}
