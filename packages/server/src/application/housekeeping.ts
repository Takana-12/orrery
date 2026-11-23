// Stored data: how much there is, and freeing it. Also the files the human attached to messages.
import type { AttachmentFiles } from '../infrastructure/attachment-files.ts';
import { HttpError } from './errors.ts';
import type { Journal } from './journal.ts';
import type { Runtime } from './runtime.ts';

export class Housekeeping {
  private readonly rt: Runtime;
  private readonly journal: Journal;
  private readonly files: AttachmentFiles;
  private readonly clearShellCache: (() => Promise<void>) | undefined;

  constructor(rt: Runtime, journal: Journal, files: AttachmentFiles, clearShellCache?: () => Promise<void>) {
    this.rt = rt;
    this.journal = journal;
    this.files = files;
    this.clearShellCache = clearShellCache;
  }

  storage() {
    const sessions = this.rt.core.state.sessions;
    const archived = [...sessions.values()].filter((s) => s.archived);
    return { ...this.rt.store.stats(), sessions: sessions.size, archivedSessions: archived.length };
  }

  /**
   * Free space: delete the conversation records and raw payloads of put-away work older than `olderThanDays`,
   * and the window's own caches. The event log (what happened, decisions, results) is kept, so history stays intact.
   */
  async purge(olderThanDays: number): Promise<{ sessions: number; freedBytes: number }> {
    const { core, store } = this.rt;
    const cutoff = Date.now() - Math.max(0, Number(olderThanDays) || 0) * 86_400_000;
    const ids = [...core.state.sessions.values()].filter((s) => s.archived && s.updatedAt <= cutoff).map((s) => s.id);
    const before = store.stats().bytes;
    store.purgeLogs(ids);
    for (const id of ids) this.journal.touch(id);
    await this.clearShellCache?.().catch(() => {});
    this.files.purge(Math.min(cutoff, Date.now() - 86_400_000));
    this.rt.notify();
    return { sessions: ids.length, freedBytes: Math.max(0, before - store.stats().bytes) };
  }

  /**
   * Keep a file the human attached and return where it is. The UI puts that path into the message, so it travels
   * through the queue, "send when finished" and resume like any other text, for both agents.
   */
  saveAttachment(name: string, data: Buffer): { name: string; path: string; size: number } {
    if (!data.length) throw new HttpError(400, '空のファイルは添付できません');
    return this.files.save(name, data);
  }
}
