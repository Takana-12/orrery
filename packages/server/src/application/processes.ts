// Process ownership: every provider process we start, and everything it spawns, lives in one kill-on-close job.
// That is how leftovers (dev servers, watchers) stay visible, measurable and removable.
import type { AgentSession } from '#core';
import { WinJob } from '#host-windows';
import type { JobSample } from '#host-windows';
import { HttpError } from './errors.ts';
import { mustSession } from './runtime.ts';
import type { Runtime } from './runtime.ts';

interface ProcessGroup {
  job: WinJob;
  rootPid: number;
  sample: JobSample | null;
}

export type SessionResources = { shared: boolean } & Pick<JobSample, 'sampledAt' | 'scope' | 'processCount' | 'workingSetBytes' | 'privateBytes'>;

export class Processes {
  /** Key: session id for per-session processes, `shared:<provider>` for a provider process shared by all its sessions. */
  private readonly groups = new Map<string, ProcessGroup>();
  private readonly rt: Runtime;

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  /** Take ownership of a process we started: it and everything it spawns live in one kill-on-close job. */
  own(key: string, pid: number): void {
    try {
      const previous = this.groups.get(key);
      if (previous) {
        // Same owner started a new root (e.g. a resumed session). Reuse its job: whatever the earlier root left
        // behind stays owned and visible, and is only terminated by an explicit cleanup or when we exit.
        previous.job.assign(pid);
        previous.rootPid = pid;
        return;
      }
      const job = new WinJob();
      job.assign(pid);
      this.groups.set(key, { job, rootPid: pid, sample: null });
    } catch (e) {
      // Ownership is a safety net, not a precondition: report it and keep the session usable.
      console.error(`[control-room] could not put pid ${pid} into a job: ${(e as Error).message}`);
    }
  }

  sampleAll(): void {
    let any = false;
    for (const g of this.groups.values()) {
      const s = g.job.sample();
      if (s.processCount > 0 || g.sample?.processCount) any = true;
      g.sample = s;
    }
    if (any) this.rt.notify();
  }

  private groupFor(s: AgentSession): { group: ProcessGroup | undefined; shared: boolean } {
    const own = this.groups.get(s.id);
    if (own) return { group: own, shared: false };
    return { group: this.groups.get(`shared:${s.provider}`), shared: true };
  }

  /** Terminate everything a finished per-session process left behind (dev servers, watchers ...). Explicit, never automatic. */
  cleanup(sessionId: string): { terminated: number } {
    const s = mustSession(this.rt, sessionId);
    const { group, shared } = this.groupFor(s);
    if (!group || shared) throw new HttpError(409, 'このセッション専用のプロセス群はありません');
    if (this.rt.adapters[s.provider].isLive(sessionId)) throw new HttpError(409, 'セッションが稼働中です。先に停止してください');
    const n = group.job.pids().length;
    group.job.terminate();
    group.sample = group.job.sample();
    this.rt.notify();
    return { terminated: n };
  }

  /** End whatever a session that is no longer live left running (it would keep files in its folder open). */
  terminateLeftovers(s: AgentSession): void {
    if (this.rt.adapters[s.provider].isLive(s.id)) return;
    const { group, shared } = this.groupFor(s);
    if (group && !shared) group.job.terminate();
  }

  /** What the session's processes use. A shared provider process is only "this session's" while the session is loaded in it. */
  resourcesOf(s: AgentSession, live: boolean): SessionResources | null {
    const { group, shared } = this.groupFor(s);
    const sample = shared && !live ? null : (group?.sample ?? null);
    return sample ? { shared, sampledAt: sample.sampledAt, scope: sample.scope, processCount: sample.processCount, workingSetBytes: sample.workingSetBytes, privateBytes: sample.privateBytes } : null;
  }

  totals(): { processCount: number; workingSetBytes: number } {
    let workingSetBytes = 0;
    let processCount = 0;
    for (const g of this.groups.values()) {
      workingSetBytes += g.sample?.workingSetBytes ?? 0;
      processCount += g.sample?.processCount ?? 0;
    }
    return { processCount, workingSetBytes };
  }

  /** Closing a kill-on-close job ends everything that is still inside it. */
  closeAll(): void {
    for (const g of this.groups.values()) g.job.close();
    this.groups.clear();
  }
}
