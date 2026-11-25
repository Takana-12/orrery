// Work stopped by a plan limit is resumed from its recorded conversation, through the ordinary work queue.
// Timers are deliberately short: a sleeping PC or an app restart must not lose a several-hour appointment.
import type { AgentSession, ProviderId, UsageLimit } from '#core';
import type { Journal } from './journal.ts';
import type { Runtime } from './runtime.ts';
import type { Sessions } from './sessions.ts';

export const USAGE_RESUME_DELAY_MS = 60_000;
export const USAGE_RESUME_MESSAGE = 'トークン制限が来て止まっていました。今は復活したので作業を再開してください';

const reached = (l: UsageLimit) => l.state ? l.state === 'reached' : (l.usedPercent ?? 0) >= 100;
const modelOf = (s: AgentSession) => s.model ?? s.requestedModel;

function applies(l: UsageLimit, provider: ProviderId, model: string | null): boolean {
  if (!l.model) return true;
  if (!model) return false;
  const a = l.model.toLowerCase();
  const b = model.toLowerCase();
  return a === b || (provider === 'claude' && /^[a-z][a-z0-9]*$/.test(a) && b.split(/[-_\s]/).includes(a));
}

export class UsageResumer {
  private readonly rt: Runtime;
  private readonly sessions: Sessions;
  private readonly journal: Journal;
  private readonly refresh: (provider: ProviderId) => Promise<unknown>;
  private readonly now: () => number;

  constructor(rt: Runtime, sessions: Sessions, journal: Journal, refresh: (provider: ProviderId) => Promise<unknown>, now = Date.now) {
    this.rt = rt;
    this.sessions = sessions;
    this.journal = journal;
    this.refresh = refresh;
    this.now = now;
  }

  private windows(provider: ProviderId, model: string | null): UsageLimit[] {
    return (this.rt.core.state.usageLimits.get(provider) ?? []).filter((l) => reached(l) && applies(l, provider, model));
  }

  private resetOf(windows: UsageLimit[]): number | null {
    // Both the five-hour AND weekly windows must recover. An unknown reset is never guessed.
    if (!windows.length || windows.some((l) => l.resetsAt === null)) return null;
    return Math.max(...windows.map((l) => l.resetsAt!));
  }

  private schedule(s: AgentSession, model: string | null, resetsAt: number | null): void {
    if (s.usageResume?.model === model && s.usageResume.resetsAt === resetsAt) return;
    this.rt.core.sessionUpdate(s.id, { usageResume: { model, resetsAt } });
    const when = resetsAt === null ? '復活時刻の通知を待っています' : `${new Date(resetsAt + USAGE_RESUME_DELAY_MS).toLocaleString('ja-JP')}ごろに再開します`;
    this.journal.write(s.id, 'system', `利用制限による自動再開を予約しました。${when}。設定の「利用制限後に自動再開」でオフにできます。`);
  }

  /** Called by account polling and by provider notifications, even when no usage screen is open. */
  observe(provider: ProviderId, limits: UsageLimit[]): void {
    if (this.rt.closing) return;
    const clean = limits.map((l) => ({ ...l, resetsAt: typeof l.resetsAt === 'number' && Number.isFinite(l.resetsAt) && l.resetsAt > 0 ? l.resetsAt : null }));
    this.rt.core.recordUsageLimits(provider, clean);
    if (!this.rt.core.state.settings.autoResumeOnLimit) return;
    for (const s of this.rt.core.state.sessions.values()) {
      if (s.provider !== provider || s.archived || s.usageResumeCancelled || this.rt.core.state.tasks.get(s.taskId)?.acceptedAt != null) continue;
      const model = s.usageResume?.model ?? modelOf(s);
      const windows = this.windows(provider, model).filter((l) => l.resetsAt === null || l.resetsAt > this.now());
      if (!windows.length) continue;
      const reset = this.resetOf(windows);
      if (s.usageResume) {
        // A later window can delay recovery; a reading must not send work before the recorded reset + grace minute.
        if (reset === null || s.usageResume.resetsAt === null || reset > s.usageResume.resetsAt) this.schedule(s, model, reset);
      } else if (s.lifecycle === 'running') {
        this.schedule(s, model, reset);
      }
    }
  }

  /** Explicit usage-limit rejection: retain the target even if fetching its reset finishes after the turn ends. */
  blocked(sessionId: string): void {
    const s = this.rt.core.state.sessions.get(sessionId);
    if (this.rt.closing || !s || s.archived || s.usageResumeCancelled || s.lifecycle !== 'running' || !this.rt.core.state.settings.autoResumeOnLimit) return;
    const model = modelOf(s);
    const reset = this.resetOf(this.windows(s.provider, model).filter((l) => l.resetsAt === null || l.resetsAt > this.now()));
    this.schedule(s, model, reset);
    void this.refresh(s.provider).catch(() => {}); // an unknown time stays pending and is retried by account polling
  }

  /** Called every five seconds. Checking a persisted timestamp also catches up after sleep / app restart. */
  tick(): void {
    if (this.rt.closing || !this.rt.core.state.settings.autoResumeOnLimit) return;
    for (const s of this.rt.core.state.sessions.values()) {
      const job = s.usageResume;
      if (!job) continue;
      if (s.archived || this.rt.core.state.tasks.get(s.taskId)?.acceptedAt != null || modelOf(s) !== job.model) {
        this.rt.core.sessionUpdate(s.id, { usageResume: null });
        continue;
      }
      if (job.resetsAt === null || this.now() < job.resetsAt + USAGE_RESUME_DELAY_MS) continue;
      // A provider still working or waiting for a human must never receive a second automatic prompt.
      if (!['error', 'interrupted', 'turn_finished'].includes(s.lifecycle)) continue;
      if (!s.providerSessionId && !this.rt.adapters[s.provider].isLive(s.id)) {
        this.rt.core.sessionUpdate(s.id, { usageResume: null });
        this.journal.write(s.id, 'system', '利用枠の復活時刻になりましたが、会話のIDが記録されていないため自動再開できませんでした。');
        continue;
      }
      this.journal.write(s.id, 'system', '利用枠の復活予定時刻から1分たったため、再開のメッセージを送ります。');
      void this.sessions.send(s.id, USAGE_RESUME_MESSAGE, { heard: true, automatic: true }).catch((e) => {
        if (!this.rt.closing) this.rt.core.sessionUpdate(s.id, { usageResume: null, error: `自動再開に失敗しました: ${String((e as Error)?.message ?? e)}` });
      });
    }
  }
}
