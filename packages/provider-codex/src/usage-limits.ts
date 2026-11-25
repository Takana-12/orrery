import type { UsageLimit } from '#core';

interface Window {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
interface Snapshot {
  limitId?: string | null;
  normalModelSlug?: string | null;
  primary?: Window | null;
  secondary?: Window | null;
}

/** Reads both the legacy account bucket and the current multi-bucket response / sparse notification. */
export function codexUsageLimits(r: { rateLimits?: Snapshot | null; rateLimitsByLimitId?: Record<string, Snapshot> | null }): UsageLimit[] {
  const buckets = new Map<string, Snapshot>(Object.entries(r.rateLimitsByLimitId ?? {}));
  if (r.rateLimits) buckets.set(r.rateLimits.limitId ?? 'codex', r.rateLimits);
  const out: UsageLimit[] = [];
  for (const [id, b] of buckets) {
    const model = id === 'codex' ? null : b.normalModelSlug ?? id;
    for (const w of [b.primary, b.secondary]) {
      if (!w || !Number.isFinite(w.usedPercent)) continue;
      const mins = w.windowDurationMins;
      const label = mins === 300 ? '5時間枠' : mins === 10080 ? '週間枠' : mins ? `${mins}分枠` : '利用枠';
      out.push({
        label: model ? `${label}（${model}）` : label,
        model,
        kind: mins === 300 ? 'five_hour' : mins === 10080 ? 'weekly' : 'other',
        usedPercent: Math.round(w.usedPercent),
        resetsAt: w.resetsAt ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : null,
        state: w.usedPercent >= 100 ? 'reached' : w.usedPercent >= 80 ? 'warning' : 'ok',
      });
    }
  }
  return out;
}
