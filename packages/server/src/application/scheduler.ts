// Scheduler: how many agents work at once. Work beyond the limit (or while memory is short) waits in a queue and
// starts by itself when there is room.
import { freeMemoryBytes } from '#host';
import { message } from './runtime.ts';
import type { Runtime } from './runtime.ts';

interface QueuedRun {
  sessionId: string;
  run: () => Promise<void>;
}

export class Scheduler {
  /** Work waiting for a free slot, oldest first. In memory: after a restart queued work shows as interrupted. */
  private readonly queue: QueuedRun[] = [];
  private pumping = false;
  private readonly rt: Runtime;
  private readonly redact: (text: string) => string;

  constructor(rt: Runtime, redact: (text: string) => string) {
    this.rt = rt;
    this.redact = redact;
  }

  get length(): number {
    return this.queue.length;
  }

  freeMemoryMB(): number {
    return Math.round(freeMemoryBytes() / 1048576);
  }

  private activeCount(): number {
    let n = 0;
    for (const s of this.rt.core.state.sessions.values()) if (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user') n++;
    return n;
  }

  /** Why queued work is not starting right now, or null if nothing is held back. */
  blockedBy(): 'slots' | 'memory' | null {
    if (!this.queue.length) return null;
    const { maxConcurrent, minFreeMemoryMB } = this.rt.core.state.settings;
    if (this.activeCount() >= maxConcurrent) return 'slots';
    if (minFreeMemoryMB > 0 && freeMemoryBytes() / 1048576 < minFreeMemoryMB) return 'memory';
    return null;
  }

  /** 1-based place in the queue per waiting session. */
  positions(): Map<string, number> {
    return new Map(this.queue.map((q, i) => [q.sessionId, i + 1]));
  }

  enqueue(sessionId: string, run: () => Promise<void>): void {
    this.queue.push({ sessionId, run });
    this.rt.core.sessionUpdate(sessionId, { lifecycle: 'queued', error: null });
    this.pump();
  }

  /** Take a session's work back out of the queue. False if it was not waiting (it already started). */
  cancel(sessionId: string): boolean {
    const at = this.queue.findIndex((q) => q.sessionId === sessionId);
    if (at < 0) return false;
    this.queue.splice(at, 1);
    return true;
  }

  pump(): void {
    if (this.pumping || this.rt.closing) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.blockedBy() === null) {
        const next = this.queue.shift()!;
        // Counted as active from this instant, so a burst of starts cannot overshoot the limit.
        this.rt.core.sessionUpdate(next.sessionId, { lifecycle: 'running' });
        next.run().catch((e) => this.rt.core.sessionUpdate(next.sessionId, { lifecycle: 'error', error: this.redact(message(e)) }));
      }
    } finally {
      this.pumping = false;
    }
  }
}
