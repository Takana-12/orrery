// One git worktree per session, so parallel agents never edit the same checkout.
// Done by Orrery itself with plain git (deterministic, no AI):
//   create  : <home>\worktrees\<repo>-<key> on a new branch orrery/<key>, started from the project's current HEAD.
//   remove  : when the work is completed or put away. Uncommitted changes are first saved as a commit on the branch
//             (plumbing: no hooks run, the project's checkout is not touched). The branch is deleted when it holds
//             nothing new (or is already merged into the project's HEAD); otherwise it is kept and reported.
//   reopen  : resuming put-away work re-creates the worktree at the same path from the kept branch.
// node_modules: a fresh worktree has none, so the project's own folder is linked in (a directory junction).
// git would follow that junction when deleting the worktree and empty the project's node_modules, so every link we
// made is unlinked first, and the folder is not removed while any link is left inside it.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

export interface WorktreeInfo {
  sessionId: string;
  /** Top of the project's repository. */
  repo: string;
  /** The worktree folder. */
  path: string;
  /** Where the agent works: the project's folder inside the worktree (differs from `path` when the project is a subfolder of the repo). */
  cwd: string;
  branch: string;
  base: string;
  createdAt: number;
  removedAt: number | null;
  /** After removal: the branch was kept because it holds work (commits not in the project's HEAD). */
  keptBranch: boolean;
  /** Links we made inside the worktree (node_modules junctions), relative to `path`. */
  links: string[];
}

const run = (cwd: string, args: string[], env?: Record<string, string>): Promise<string> =>
  new Promise((ok, fail) =>
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 256 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (e, out, err) =>
      e ? fail(new Error(String(err || e.message).trim().split(/\r?\n/).slice(-3).join(' / '))) : ok(out),
    ),
  );

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Links directly inside the worktree or the project folder in it: what git would walk into when removing. */
function linksLeft(info: WorktreeInfo): string[] {
  const found: string[] = [];
  for (const dir of new Set([info.path, info.cwd])) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const n of names) if (isLink(join(dir, n))) found.push(join(dir, n));
  }
  return found;
}

export class Worktrees {
  /** git operations on one repository run one at a time (worktree add/remove write shared files under .git). */
  private readonly locks = new Map<string, Promise<unknown>>();

  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  private serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const key = repo.toLowerCase();
    const next = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  /** null when the folder is not in a git repository with at least one commit: the agent then works in the folder itself. */
  async create(sessionId: string, projectRoot: string, key: string): Promise<WorktreeInfo | null> {
    const info = await this.plan(sessionId, projectRoot, key);
    if (info) await this.materialize(info, projectRoot);
    return info;
  }

  /** Decide where the worktree goes (two quick git queries). Nothing is created yet: see materialize(). */
  async plan(sessionId: string, projectRoot: string, key: string): Promise<WorktreeInfo | null> {
    let repo: string;
    let base: string;
    try {
      repo = resolve((await run(projectRoot, ['rev-parse', '--show-toplevel'])).trim());
      base = (await run(projectRoot, ['rev-parse', '--verify', 'HEAD'])).trim();
    } catch {
      return null;
    }
    const dir = join(this.home, 'worktrees');
    mkdirSync(dir, { recursive: true });
    const name = `${basename(repo).replace(/[^\w.-]+/g, '_').slice(0, 40)}-${key}`;
    const path = join(dir, name);
    const branch = `orrery/${key}`;
    const sub = relative(repo, resolve(projectRoot));
    return { sessionId, repo, path, cwd: sub ? join(path, sub) : path, branch, base, createdAt: Date.now(), removedAt: null, keptBranch: false, links: [] };
  }

  /** Create the planned worktree (the slow part: git checks out every file). Fills in `links`. */
  async materialize(info: WorktreeInfo, projectRoot: string): Promise<void> {
    await this.serial(info.repo, () => run(info.repo, ['worktree', 'add', '-b', info.branch, info.path, info.base]));
    this.linkModules(info, projectRoot);
  }

  private linkModules(info: WorktreeInfo, projectRoot: string): void {
    info.links = [];
    const pairs = new Map([[join(info.repo, 'node_modules'), join(info.path, 'node_modules')], [join(projectRoot, 'node_modules'), join(info.cwd, 'node_modules')]]);
    for (const [target, link] of pairs) {
      if (!existsSync(target) || existsSync(link) || isLink(link)) continue;
      try {
        mkdirSync(join(link, '..'), { recursive: true });
        symlinkSync(target, link, 'junction');
        info.links.push(relative(info.path, link));
      } catch {}
    }
  }

  /** Bring a removed worktree back at the same path (the agent's own session history is keyed by that path). */
  async reopen(info: WorktreeInfo, projectRoot: string): Promise<WorktreeInfo> {
    if (info.removedAt === null && existsSync(info.path)) return info;
    await this.serial(info.repo, async () => {
      await run(info.repo, ['worktree', 'prune']);
      const hasBranch = await run(info.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`]).then(() => true, () => false);
      await run(info.repo, hasBranch ? ['worktree', 'add', info.path, info.branch] : ['worktree', 'add', '-b', info.branch, info.path, info.base]);
    });
    const next = { ...info, removedAt: null, keptBranch: false };
    this.linkModules(next, projectRoot);
    return next;
  }

  /**
   * Remove the worktree. Never loses work: uncommitted changes are committed to the branch first, and a branch with
   * work on it is kept. Returns what happened, for the transcript.
   */
  async remove(info: WorktreeInfo, title: string): Promise<{ info: WorktreeInfo; savedChanges: boolean; keptBranch: boolean; ahead: number }> {
    return this.serial(info.repo, async () => {
      let savedChanges = false;
      if (existsSync(info.path)) {
        // 1. Our links go first, so that nothing below can reach the project's own files through them.
        for (const rel of info.links) {
          const p = join(info.path, rel);
          if (isLink(p)) unlinkSync(p);
        }
        const left = linksLeft(info);
        if (left.length) throw new Error(`リンクが残っているため削除を中止しました（リンク先を消さないため）: ${left.join(', ')}`);
        // 2. Keep uncommitted work as a commit on whatever branch the worktree has checked out.
        const status = await run(info.path, ['status', '--porcelain', '--untracked-files=all']).catch(() => '');
        if (status.trim()) {
          const who = (await run(info.path, ['config', 'user.email']).catch(() => '')).trim();
          const env = who ? undefined : { GIT_AUTHOR_NAME: 'Orrery', GIT_AUTHOR_EMAIL: 'orrery@localhost', GIT_COMMITTER_NAME: 'Orrery', GIT_COMMITTER_EMAIL: 'orrery@localhost' };
          const ref = (await run(info.path, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim() || `refs/heads/${info.branch}`;
          await run(info.path, ['add', '-A']);
          const tree = (await run(info.path, ['write-tree'])).trim();
          const head = (await run(info.path, ['rev-parse', 'HEAD'])).trim();
          const commit = (await run(info.path, ['commit-tree', tree, '-p', head, '-m', `Orrery: 「${title}」の未コミットの変更（作業の完了時に自動で保存）`], env)).trim();
          await run(info.path, ['update-ref', ref, commit]);
          savedChanges = true;
        }
        // 3. The folder itself.
        try {
          await run(info.repo, ['worktree', 'remove', '--force', info.path]);
        } catch {
          if (linksLeft(info).length) throw new Error('リンクが残っているため削除を中止しました');
          rmSync(info.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
        }
      }
      await run(info.repo, ['worktree', 'prune']).catch(() => {});
      // 4. The branch: deleted when it holds nothing the project does not already have.
      let ahead = 0;
      let keptBranch = false;
      const exists = await run(info.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`]).then(() => true, () => false);
      if (exists) {
        ahead = Number((await run(info.repo, ['rev-list', '--count', `${info.base}..refs/heads/${info.branch}`]).catch(() => '1')).trim()) || 0;
        const merged = ahead > 0 && (await run(info.repo, ['merge-base', '--is-ancestor', `refs/heads/${info.branch}`, 'HEAD']).then(() => true, () => false));
        if (ahead === 0 || merged) await run(info.repo, ['branch', '-D', info.branch]).catch(() => {});
        else keptBranch = true;
      }
      return { info: { ...info, removedAt: Date.now(), keptBranch }, savedChanges, keptBranch, ahead };
    });
  }
}
