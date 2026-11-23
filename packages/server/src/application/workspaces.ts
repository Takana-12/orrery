// Each session's own work folder (a git worktree), so agents working in parallel never edit the same checkout.
// Created when work starts, removed when it is put away (its changes stay on the branch), re-created when it comes back.
import { existsSync } from 'node:fs';
import type { Worktrees, WorktreeInfo } from '../infrastructure/worktree.ts';
import type { Journal } from './journal.ts';
import type { Processes } from './processes.ts';
import { message, mustSession } from './runtime.ts';
import type { Runtime } from './runtime.ts';

export class Workspaces {
  private readonly wt = new Map<string, WorktreeInfo>();
  /** Removal / re-creation of a session's worktree, one after the other. */
  private readonly busy = new Map<string, Promise<void>>();
  private readonly rt: Runtime;
  private readonly git: Worktrees;
  private readonly journal: Journal;
  private readonly processes: Processes;
  private readonly redact: (text: string) => string;

  constructor(rt: Runtime, git: Worktrees, journal: Journal, processes: Processes, redact: (text: string) => string) {
    this.rt = rt;
    this.git = git;
    this.journal = journal;
    this.processes = processes;
    this.redact = redact;
    for (const w of rt.store.readWorktrees<WorktreeInfo>()) this.wt.set(w.sessionId, w);
  }

  /** Removals that failed or were cut short last time (work put away while files were still open, a crash ...). */
  retryRemovals(): void {
    for (const w of this.wt.values()) if (w.removedAt === null && this.rt.core.state.sessions.get(w.sessionId)?.archived) void this.remove(w.sessionId);
  }

  /** Decide where a new session will work. Quick: the folder itself is made by materialize(). */
  plan(projectRoot: string, key: string): Promise<WorktreeInfo | null> {
    return this.git.plan('', projectRoot, key);
  }

  /** Bind a planned worktree to its session and record it. */
  adopt(sessionId: string, info: WorktreeInfo): void {
    info.sessionId = sessionId;
    this.wt.set(sessionId, info);
    this.rt.store.saveWorktree(info);
  }

  /** Create the planned folder on disk. */
  materialize(info: WorktreeInfo, projectRoot: string): Promise<void> {
    return this.git.materialize(info, projectRoot).then(() => this.rt.store.saveWorktree(info));
  }

  /** The folder could not be made: there is nothing to clean up, and resuming tries to create it again. */
  markFailed(info: WorktreeInfo): void {
    info.removedAt = Date.now();
    this.rt.store.saveWorktree(info);
  }

  /** What the UI shows about a session's work folder. */
  view(sessionId: string): { path: string; branch: string; removed: boolean; keptBranch: boolean } | null {
    const w = this.wt.get(sessionId);
    return w ? { path: w.path, branch: w.branch, removed: w.removedAt !== null, keptBranch: w.keptBranch } : null;
  }

  /** Remove the session's worktree. Failures are recorded and retried at the next start; they never block putting work away. */
  remove(sessionId: string): Promise<void> {
    const w = this.wt.get(sessionId);
    if (!w || w.removedAt !== null) return Promise.resolve();
    const prev = this.busy.get(sessionId) ?? Promise.resolve();
    const job = prev.then(async () => {
      const cur = this.wt.get(sessionId);
      if (!cur || cur.removedAt !== null) return;
      // Whatever this session started (dev servers, watchers) would keep files in the folder open.
      const s = this.rt.core.state.sessions.get(sessionId);
      if (s) this.processes.terminateLeftovers(s);
      try {
        const r = await this.git.remove(cur, this.rt.core.state.tasks.get(s?.taskId ?? '')?.title ?? sessionId);
        this.wt.set(sessionId, r.info);
        this.rt.store.saveWorktree(r.info);
        this.journal.write(sessionId, 'system', [
          `作業用フォルダを削除しました: ${cur.path}`,
          r.savedChanges ? `未コミットの変更は、ブランチ ${cur.branch} にコミットして残しました。` : '',
          r.keptBranch ? `ブランチ ${cur.branch} に、まだ取り込まれていない変更があるので残しています（${r.ahead}件のコミット）。` : `ブランチ ${cur.branch} には残す変更がなかったので削除しました。`,
        ].filter(Boolean).join('\n'));
      } catch (e) {
        this.journal.write(sessionId, 'system', `作業用フォルダを削除できませんでした（次の起動時にもう一度試します）: ${this.redact(message(e))}`);
      }
      this.rt.notify();
    });
    this.busy.set(sessionId, job);
    return job;
  }

  /** Re-create a removed worktree at the same path before the agent works in it again. */
  reopen(sessionId: string): Promise<void> {
    const w = this.wt.get(sessionId);
    if (!w || (w.removedAt === null && existsSync(w.path))) return Promise.resolve();
    const s = mustSession(this.rt, sessionId);
    const root = this.rt.core.state.projects.get(s.projectId)?.rootPath ?? w.repo;
    const prev = this.busy.get(sessionId) ?? Promise.resolve();
    const job = prev.then(async () => {
      const cur = this.wt.get(sessionId)!;
      if (cur.removedAt === null && existsSync(cur.path)) return;
      const next = await this.git.reopen(cur, root);
      this.wt.set(sessionId, next);
      this.rt.store.saveWorktree(next);
      this.journal.write(sessionId, 'system', `作業用フォルダを作り直しました: ${next.path}（ブランチ ${next.branch}）`);
      this.rt.notify();
    });
    this.busy.set(sessionId, job.catch(() => {}));
    return job;
  }
}
