// The human's accounts at each provider: whether this machine is signed in, how much of the plan is used, which
// models are offered. Orrery never reads credentials; it asks the provider's own program and watches the answer.
import { enabledProviders, type AuthStatus, type ModelChoice, type ProviderId, type UsageLimit } from '#core';
import { HttpError } from './errors.ts';
import { PROVIDERS, message, mustProvider } from './runtime.ts';
import type { Runtime } from './runtime.ts';

interface AuthState {
  /** `null` = not checked yet. */
  status: AuthStatus | null;
  checkedAt: number;
  loginStartedAt: number | null;
  error: string | null;
}

export class Accounts {
  private readonly auth: Record<ProviderId, AuthState> = {
    claude: { status: null, checkedAt: 0, loginStartedAt: null, error: null },
    codex: { status: null, checkedAt: 0, loginStartedAt: null, error: null },
  };
  private timer: NodeJS.Timeout | null = null;
  private readonly limitCache = new Map<ProviderId, { at: number; limits: UsageLimit[] }>();
  private readonly limitFetch = new Map<ProviderId, Promise<UsageLimit[]>>();
  private readonly limitAttempt = new Map<ProviderId, number>();
  private readonly models = new Map<ProviderId, Promise<ModelChoice[]>>();
  private readonly rt: Runtime;
  private readonly openExternal: ((url: string) => void) | undefined;
  private readonly onLimits: (provider: ProviderId, limits: UsageLimit[]) => void;

  constructor(rt: Runtime, openExternal?: (url: string) => void, onLimits: (provider: ProviderId, limits: UsageLimit[]) => void = () => {}) {
    this.rt = rt;
    this.openExternal = openExternal;
    this.onLimits = onLimits;
  }

  /**
   * Only the subscriptions the human uses (設定 → 使うAI) are watched: an unused one is never started just to ask
   * whether it is signed in. One turned on later is checked on the next tick.
   */
  private used(): readonly ProviderId[] {
    return enabledProviders(this.rt.core.state.settings);
  }

  /** Check now, then keep an eye on it (a provider can sign the machine out at any time). */
  watch(): void {
    for (const p of this.used()) void this.refresh(p);
    this.timer = setInterval(() => {
      for (const p of this.used()) {
        const a = this.auth[p];
        const waiting = a.loginStartedAt !== null;
        if (waiting && Date.now() - a.loginStartedAt! > 10 * 60_000) a.loginStartedAt = null;
        if (waiting || Date.now() - a.checkedAt > 5 * 60_000) void this.refresh(p);
        const work = [...this.rt.core.state.sessions.values()].some((s) => s.provider === p && !s.archived && (s.lifecycle === 'running' || s.usageResume));
        if (this.rt.core.state.settings.autoResumeOnLimit && work && Date.now() - (this.limitAttempt.get(p) ?? 0) >= 60_000) void this.refreshLimits(p).catch(() => {});
      }
    }, 3000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(provider: ProviderId): Promise<void> {
    const a = this.auth[provider];
    const before = JSON.stringify(a.status);
    try {
      a.status = await this.rt.adapters[provider].authStatus();
      a.error = null;
      if (a.status.loggedIn) a.loginStartedAt = null;
    } catch (e) {
      a.error = message(e);
    }
    a.checkedAt = Date.now();
    if (!this.rt.closing && JSON.stringify(a.status) !== before) this.rt.notify();
  }

  /** Start the provider's own sign-in. The human signs in on the provider's page; we only watch for the result. */
  async startLogin(provider: ProviderId): Promise<void> {
    mustProvider(provider);
    const r = await this.rt.adapters[provider].startLogin().catch((e) => {
      throw new HttpError(502, `ログインを開始できませんでした: ${message(e)}`);
    });
    if (r.url) {
      if (!this.openExternal) throw new HttpError(500, 'ブラウザを開けません');
      this.openExternal(r.url);
    }
    this.auth[provider].loginStartedAt = Date.now();
    this.rt.notify();
  }

  /** A turn consumed tokens: the windows moved, so read them again on the next ask. */
  usageMoved(provider: ProviderId): void {
    const c = this.limitCache.get(provider);
    if (c) c.at = 0;
  }

  /** One fetch per service, shared by the UI and the background limit watcher. No model prompt is sent. */
  refreshLimits(provider: ProviderId): Promise<UsageLimit[]> {
    const existing = this.limitFetch.get(provider);
    if (existing) return existing;
    this.limitAttempt.set(provider, Date.now());
    const pending = (this.auth[provider].status?.loggedIn === false ? Promise.resolve([]) : this.rt.adapters[provider].limits())
      .then((limits) => {
        if (!this.rt.closing) {
          this.limitCache.set(provider, { at: Date.now(), limits });
          this.onLimits(provider, limits);
        }
        return limits;
      })
      .finally(() => this.limitFetch.delete(provider));
    this.limitFetch.set(provider, pending);
    return pending;
  }

  /** Rate-limit windows and token totals per service. */
  async usageSummary() {
    const { store } = this.rt;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = store.usageSince(today);
    const week = store.usageSince(Date.now() - 7 * 86_400_000);
    const out: Record<string, unknown> = {};
    for (const p of this.used()) {
      let cached = this.limitCache.get(p);
      let limitsError: string | null = null;
      if (!cached || Date.now() - cached.at > 60_000) {
        // One fetch at a time per service: several screens asking at once share it.
        const pending = this.refreshLimits(p);
        if (cached) {
          pending.catch(() => {}); // answer with the last reading now (a fetch takes seconds); the next ask gets the new one
        } else {
          try {
            cached = { at: Date.now(), limits: await pending };
          } catch (e) {
            limitsError = message(e);
          }
        }
      }
      const zero = { input: 0, output: 0, cached: 0, turns: 0 };
      out[p] = { limits: cached?.limits ?? [], limitsAt: cached?.at ?? null, limitsError, today: day[p] ?? zero, week: week[p] ?? zero };
    }
    return out;
  }

  listModels(provider: ProviderId): Promise<ModelChoice[]> {
    mustProvider(provider);
    let p = this.models.get(provider);
    if (!p) {
      p = this.rt.adapters[provider].listModels();
      this.models.set(provider, p);
      p.catch(() => this.models.delete(provider));
    }
    return p.catch((e) => {
      throw new HttpError(502, `モデル一覧を取得できませんでした: ${message(e)}`);
    });
  }

  /** What the UI shows about each sign-in. */
  view() {
    return Object.fromEntries(
      PROVIDERS.map((p) => [p, { loggedIn: this.auth[p].status?.loggedIn ?? null, plan: this.auth[p].status?.plan ?? null, loginInProgress: this.auth[p].loginStartedAt !== null, error: this.auth[p].error }]),
    );
  }
}
