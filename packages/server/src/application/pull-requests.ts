// Which pull request each session is working on, so the human can see its number next to the branch.
// Asked of GitHub (through the gh CLI) one session at a time: when a session's state changes (a finished reply may
// have opened one) and every few minutes (it may have been merged). Only for work that is not put away.
import type { PullRequestInfo } from '../infrastructure/shell.ts';
import type { Runtime } from './runtime.ts';
import type { Workspaces } from './workspaces.ts';

const REFRESH_MS = 3 * 60_000;

export type LookUpPullRequest = (cwd: string, branch: string | null) => Promise<PullRequestInfo | null>;

export class PullRequests {
  private readonly known = new Map<string, { pr: PullRequestInfo | null; at: number }>();
  private running = false;
  private readonly rt: Runtime;
  private readonly workspaces: Workspaces;
  private readonly lookUp: LookUpPullRequest;

  constructor(rt: Runtime, workspaces: Workspaces, lookUp: LookUpPullRequest) {
    this.rt = rt;
    this.workspaces = workspaces;
    this.lookUp = lookUp;
  }

  /** What the UI shows. */
  view(sessionId: string): PullRequestInfo | null {
    return this.known.get(sessionId)?.pr ?? null;
  }

  /** Look up the one session that most needs it, if any. Called on a timer; never runs two lookups at once. */
  tick(now = Date.now()): Promise<void> {
    if (this.running || this.rt.closing) return Promise.resolve();
    const due = [...this.rt.core.state.sessions.values()]
      .filter((s) => !s.archived)
      .map((s) => ({ s, k: this.known.get(s.id) }))
      .filter(({ s, k }) => !k || s.lifecycleSince > k.at || now - k.at > REFRESH_MS)
      .sort((a, b) => (a.k?.at ?? 0) - (b.k?.at ?? 0))[0];
    if (!due) return Promise.resolve();
    const { s } = due;
    const w = this.workspaces.view(s.id);
    const project = this.rt.core.state.projects.get(s.projectId);
    // A removed worktree's branch is still asked about, from the project's own folder.
    const where = w ? (w.removed ? { cwd: project?.rootPath ?? s.cwd, branch: w.branch } : { cwd: w.path, branch: w.branch }) : { cwd: s.cwd, branch: null };
    this.running = true;
    return this.lookUp(where.cwd, where.branch)
      .catch(() => null)
      .then((pr) => {
        const before = this.known.get(s.id)?.pr ?? null;
        this.known.set(s.id, { pr, at: Date.now() });
        if (JSON.stringify(before) !== JSON.stringify(pr)) this.rt.notify();
      })
      .finally(() => {
        this.running = false;
      });
  }
}
