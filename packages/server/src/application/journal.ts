// The conversation record of each session, as the human reads it: what was said, what tools did, what Orrery did.
// Also keeps the one-line "what is it doing right now" and a revision counter so the UI fetches only what is new.
import type { Runtime } from './runtime.ts';

/** One short line describing a transcript entry, for the "what is it doing right now" display. */
export function activityLine(role: string, text: string): string {
  const call = text.match(/^▶ (\S+) ([\s\S]*)$/);
  if (call) {
    let hint = '';
    try {
      const j = JSON.parse(call[2]!);
      hint = String(j.command ?? j.file_path ?? j.pattern ?? j.path ?? j.url ?? '');
    } catch {}
    return `${call[1]} ${hint.split('\n')[0]}`.trim().slice(0, 120);
  }
  const first = text.replace(/^[✔✖] /, '').split('\n')[0]!.trim();
  return (role === 'tool' && first.startsWith('$ ') ? first.slice(2) : first).slice(0, 120);
}

export class Journal {
  /** Bumped whenever a session's transcript grows, so the UI fetches only when there is something new. */
  private readonly rev = new Map<string, number>();
  /** What each session did last, in one line, so the list can say what is going on without opening anything. */
  private readonly activity = new Map<string, { at: number; text: string }>();
  private readonly rt: Runtime;
  private readonly redact: (text: string) => string;

  constructor(rt: Runtime, redact: (text: string) => string) {
    this.rt = rt;
    this.redact = redact;
  }

  write = (sessionId: string, role: string, text: string): void => {
    if (this.rt.closing) return;
    const clean = this.redact(text);
    if (role !== 'user') this.activity.set(sessionId, { at: Date.now(), text: activityLine(role, clean) });
    this.rt.store.appendTranscript(sessionId, role, clean);
    this.touch(sessionId);
    this.rt.notify();
  };

  /** The stored record changed without an entry being added (it was purged). */
  touch(sessionId: string): void {
    this.rev.set(sessionId, (this.rev.get(sessionId) ?? 0) + 1);
  }

  revOf(sessionId: string): number {
    return this.rev.get(sessionId) ?? 0;
  }

  activityOf(sessionId: string): { at: number; text: string } | null {
    return this.activity.get(sessionId) ?? null;
  }
}
