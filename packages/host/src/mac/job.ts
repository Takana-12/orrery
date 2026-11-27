// Process ownership without Job Objects (macOS, and any POSIX system).
// What a Windows job gives for free has to be kept by hand here:
//   - the set: a process is ours when its parent is ours, or when it is in a process group led by one of ours.
//     Roots are started as group leaders (host.ownedSpawn), so a grandchild whose parent has exited is still found
//     through its group; one that made a group of its own was seen through its parent while that was alive (the set
//     is refreshed on every sample, every few seconds) and its group is remembered from then on.
//   - identity: a pid alone can be reused by an unrelated process, so each member is remembered with its start time
//     and dropped when that no longer matches. Nothing is ever signalled on the strength of a bare pid.
//   - "nothing outlives us": close() ends what is left, and so does this process's exit (normal or uncaught error).
//     A hard kill of Orrery itself (kill -9, power loss) cannot be covered this way; the agents then end on their
//     own because their pipes close, but something they started may stay. Windows has no such gap.
import type { Job, JobSample } from '../types.ts';
import { forgetProcessTable, processTable } from './ps.ts';
import type { Proc } from './ps.ts';

const live = new Set<PosixJob>();
let hooked = false;

export class PosixJob implements Job {
  /** pid -> start time of every process known to be ours and still alive at the last look. */
  private readonly members = new Map<number, string>();
  /** Process groups led by one of ours. */
  private readonly groups = new Set<number>();
  private closed = false;

  constructor() {
    live.add(this);
    if (!hooked) {
      hooked = true;
      process.on('exit', () => {
        for (const job of [...live]) job.close();
      });
    }
  }

  assign(pid: number): void {
    const p = processTable({ fresh: true }).get(pid);
    if (!p) throw new Error(`process ${pid} is not running`);
    this.add(p);
  }

  private add(p: Proc): void {
    this.members.set(p.pid, p.started);
    if (p.pgid === p.pid) this.groups.add(p.pid);
  }

  /** Bring the set up to date against the process table and return its live members. */
  private refresh(fresh = false): Proc[] {
    if (this.closed) return [];
    const table = processTable({ fresh });
    for (const [pid, started] of this.members) if (table.get(pid)?.started !== started) this.members.delete(pid);
    const populated = new Set<number>();
    for (const p of table.values()) populated.add(p.pgid);
    // A group id cannot be given to a new process while the group still has members, so an empty group is simply over.
    for (const g of this.groups) if (!populated.has(g)) this.groups.delete(g);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of table.values()) {
        if (this.members.has(p.pid) || p.pid === process.pid) continue;
        if (this.groups.has(p.pgid) || this.members.has(p.ppid)) {
          this.add(p);
          grew = true;
        }
      }
    }
    const out: Proc[] = [];
    for (const pid of this.members.keys()) out.push(table.get(pid)!);
    return out;
  }

  pids(): number[] {
    return this.refresh().map((p) => p.pid);
  }

  sample(): JobSample {
    const processes = this.refresh().map((p) => ({ pid: p.pid, image: p.command.slice(p.command.lastIndexOf('/') + 1), workingSetBytes: p.rssBytes, privateBytes: p.rssBytes }));
    const total = processes.reduce((a, p) => a + p.workingSetBytes, 0);
    return { sampledAt: new Date().toISOString(), scope: '所有する全生存プロセス（ルート＋子孫）の実メモリ（RSS）の瞬間値の合計', processCount: processes.length, workingSetBytes: total, privateBytes: total, processes };
  }

  terminate(): boolean {
    if (this.closed) return false;
    // Twice: something may have been started between the look and the signal.
    for (let round = 0; round < 2; round++) {
      const procs = this.refresh(true);
      if (!procs.length) break;
      for (const g of this.groups) signal(-g);
      for (const p of procs) signal(p.pid);
    }
    forgetProcessTable();
    return true;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.terminate();
    } catch {}
    this.closed = true;
    this.members.clear();
    this.groups.clear();
    live.delete(this);
  }
}

function signal(target: number): void {
  try {
    process.kill(target, 'SIGKILL');
  } catch {}
}
