// Schedules: work that starts by itself at set times (every morning at 9, every 2 hours, once on Friday at 18:00), in
// the workspace and with the AI the human chose. Each run is an ordinary piece of work (Sessions.start): it waits for a
// slot like any other, shows on the home screen and in the inbox, and can be talked to afterwards.
//
// What a run leaves can be sent to a webhook (a Discord / Slack channel, or any endpoint taking JSON) when its reply
// ends, so the human need not open Orrery to read it. A schedule can also carry environment variables of its own
// (e.g. a token the work needs), given to its runs on top of the workspace's. The webhook address and those values are
// secrets: kept encrypted by Secrets under the schedule's scope, never in the schedule's own record, never on screen.
//
// Timing: the composition root calls tick() every few seconds. A run that came due while the app was not running
// happens once at the next start (not once per missed time). A run does not start while the previous run of the same
// schedule is still working (it is recorded as skipped), so a short interval cannot pile work up.
import { randomUUID } from 'node:crypto';
import { PROVIDER_IDS, enabledProviders, nextRunAt, settleRule } from '#core';
import type { ProviderId, ScheduleRule } from '#core';
import { checkHookUrl, hookLabel } from '../infrastructure/webhook.ts';
import type { HookMessage } from '../infrastructure/webhook.ts';
import { HttpError } from './errors.ts';
import type { Journal } from './journal.ts';
import { message } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import { Secrets, scheduleEnvScope, scheduleHookScope } from './secrets.ts';
import type { Sessions, StartSessionInput } from './sessions.ts';

/** The name the webhook address is kept under in its scope (what redaction shows in its place). */
const HOOK_NAME = 'WEBHOOK_URL';
/** Runs remembered per schedule, newest first. */
const KEEP_RUNS = 20;
const NAME_MAX = 80;
const PROMPT_MAX = 20_000;
const ID = /^[\w-]{6,64}$/;
/** States in which a run is still the agent's (a new run of the same schedule waits for it to end). */
const BUSY = new Set(['queued', 'running', 'waiting_for_user']);

/** Sending the result: none (no webhook), waiting for the reply to end, being sent, sent, failed. */
export type DeliveryPhase = 'none' | 'waiting' | 'sending' | 'sent' | 'failed';

export interface ScheduleRun {
  at: number;
  /** The work it started (null: it did not start). */
  sessionId: string | null;
  /** started: work was started. skipped: the previous run was still working. failed: it could not be started. */
  outcome: 'started' | 'skipped' | 'failed';
  error: string | null;
  delivery: { phase: DeliveryPhase; at: number | null; error: string | null };
  /** Put away by the schedule's "済んだら片付ける" once nothing was left for the human. */
  tidied?: boolean;
}

export interface Schedule {
  id: string;
  /** Empty: the work is named from the instruction, as new work is. */
  name: string;
  prompt: string;
  projectId: string;
  provider: ProviderId;
  /** '' = the agent's own default. */
  model: string;
  effort: string;
  rule: ScheduleRule;
  enabled: boolean;
  /** Put a run away by itself when it finished and nothing is left for the human (its result was sent, if there is a webhook). */
  tidy: boolean;
  createdAt: number;
  updatedAt: number;
  /** When it runs next; null while it is off (or a one-off that has run). */
  nextAt: number | null;
  runs: ScheduleRun[];
}

/** A save from the screen. For a new schedule everything but id/hook/env is required; for an existing one, what is left out stays. */
export interface ScheduleInput {
  id?: unknown;
  name?: unknown;
  prompt?: unknown;
  projectId?: unknown;
  provider?: unknown;
  model?: unknown;
  effort?: unknown;
  rule?: unknown;
  enabled?: unknown;
  tidy?: unknown;
  /** The webhook address: a URL sets it, '' or null removes it, left out keeps it. */
  hook?: unknown;
  /** The schedule's own environment variables to change: { NAME: value } sets, { NAME: null } removes. */
  env?: unknown;
}

export interface ScheduleDeps {
  sessions: Sessions;
  secrets: Secrets;
  journal: Journal;
  /** Send a message to a webhook (infrastructure/webhook.ts postHook; tests give their own). */
  post: (url: string, m: HookMessage) => Promise<void>;
  now?: () => number;
}

export class Schedules {
  private readonly list = new Map<string, Schedule>();
  private readonly rt: Runtime;
  private readonly d: ScheduleDeps;
  private readonly now: () => number;

  constructor(rt: Runtime, deps: ScheduleDeps) {
    this.rt = rt;
    this.d = deps;
    this.now = deps.now ?? Date.now;
    for (const sc of rt.store.readSchedules<Schedule>()) {
      // A result that was being sent when the app stopped is sent again.
      for (const r of sc.runs ?? []) if (r.delivery?.phase === 'sending') r.delivery.phase = 'waiting';
      this.list.set(sc.id, { ...sc, runs: sc.runs ?? [] });
    }
  }

  private mustSchedule(id: string): Schedule {
    const sc = this.list.get(id);
    if (!sc) throw new HttpError(404, '該当するスケジュールがありません');
    return sc;
  }

  private persist(sc: Schedule): void {
    this.rt.store.saveSchedule(sc);
  }

  /** The address results go to, or null. */
  private hookOf(id: string): string | null {
    return this.d.secrets.scoped(scheduleHookScope(id))[HOOK_NAME] ?? null;
  }

  /** What the screen is sent: the schedules, oldest first, with what may be known of their secrets (never the values). */
  view() {
    const st = this.rt.core.state;
    return [...this.list.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((sc) => {
        const hook = this.hookOf(sc.id);
        const last = sc.runs[0]?.sessionId ? st.sessions.get(sc.runs[0].sessionId) : undefined;
        return {
          ...sc,
          runs: sc.runs.slice(0, 5),
          projectName: st.projects.get(sc.projectId)?.name ?? '?',
          hook: hook ? hookLabel(hook) : null,
          env: this.d.secrets.scopedNames(scheduleEnvScope(sc.id)),
          /** Its latest run is still working. */
          busy: !!last && BUSY.has(last.lifecycle),
        };
      });
  }

  /** Make a schedule, or change one. Everything is checked before anything is changed. Answers its id. */
  save(input: ScheduleInput): string {
    const { rt } = this;
    const at = this.now();
    const id = input.id === undefined || input.id === null || input.id === '' ? randomUUID() : String(input.id);
    if (!ID.test(id)) throw new HttpError(400, 'スケジュールの id が不正です');
    const was = this.list.get(id);
    const pick = <T>(v: unknown, keep: T | undefined, read: (v: unknown) => T, what: string): T => {
      if (v === undefined) {
        if (keep === undefined) throw new HttpError(400, `${what}がありません`);
        return keep;
      }
      return read(v);
    };
    const prompt = pick(input.prompt, was?.prompt, (v) => String(v ?? '').trim(), '指示文');
    if (!prompt) throw new HttpError(400, '指示文が空です');
    if (prompt.length > PROMPT_MAX) throw new HttpError(400, '指示文が長すぎます');
    const name = pick(input.name, was?.name ?? '', (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX), '名前');
    const projectId = pick(input.projectId, was?.projectId, (v) => String(v ?? ''), 'ワークスペース');
    if (!rt.core.state.projects.has(projectId)) throw new HttpError(404, 'ワークスペースが見つかりません');
    const provider = pick(input.provider, was?.provider, (v) => v as ProviderId, 'AI');
    if (!PROVIDER_IDS.includes(provider)) throw new HttpError(400, 'AI が不正です');
    const model = pick(input.model, was?.model ?? '', (v) => String(v ?? '').trim().slice(0, 120), 'モデル');
    const effort = pick(input.effort, was?.effort ?? '', (v) => String(v ?? '').trim().slice(0, 40), '思考量');
    const rule = pick(input.rule, was?.rule, (v) => {
      const r = settleRule(v);
      if (!r) throw new HttpError(400, 'いつ実行するかが不正です');
      return r;
    }, 'いつ実行するか');
    const enabled = pick(input.enabled, was?.enabled ?? true, (v) => v !== false, 'オン・オフ');
    const tidy = pick(input.tidy, was?.tidy ?? true, (v) => v !== false, '片付け');
    if (enabled && rule.kind === 'once' && rule.at <= at && (!was || input.rule !== undefined || !was.enabled)) throw new HttpError(400, '過ぎた日時は選べません');
    // Secrets: checked now, written below with everything else.
    let hook: string | null | undefined;
    if (input.hook !== undefined) {
      if (input.hook === null || input.hook === '') hook = null;
      else {
        const c = checkHookUrl(input.hook);
        if ('error' in c) throw new HttpError(400, c.error);
        hook = c.url;
      }
    }
    const env: [string, string | null][] = [];
    if (input.env !== undefined && input.env !== null) {
      if (typeof input.env !== 'object' || Array.isArray(input.env)) throw new HttpError(400, '環境変数の形が不正です');
      for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) {
        if (v === null) env.push([k, null]);
        else {
          Secrets.check(k, v);
          env.push([k, v as string]);
        }
      }
    }

    // When it runs next: worked out again when the rule changed or it was turned (back) on; otherwise as it was.
    const ruleChanged = !was || JSON.stringify(was.rule) !== JSON.stringify(rule);
    const nextAt = !enabled ? null : ruleChanged || !was?.enabled || was.nextAt === null ? nextRunAt(rule, at) : was.nextAt;
    const sc: Schedule = { id, name, prompt, projectId, provider, model, effort, rule, enabled: enabled && nextAt !== null, tidy, createdAt: was?.createdAt ?? at, updatedAt: at, nextAt, runs: was?.runs ?? [] };
    if (hook !== undefined) this.d.secrets.setScoped(scheduleHookScope(id), HOOK_NAME, hook);
    for (const [k, v] of env) this.d.secrets.setScoped(scheduleEnvScope(id), k, v);
    this.list.set(id, sc);
    this.persist(sc);
    rt.notify();
    return id;
  }

  /** Forget a schedule, its webhook and its variables. The work it started stays as it is. */
  remove(id: string): void {
    this.mustSchedule(id);
    this.list.delete(id);
    this.rt.store.deleteSchedule(id);
    this.d.secrets.dropScope(scheduleEnvScope(id));
    this.d.secrets.dropScope(scheduleHookScope(id));
    this.rt.notify();
  }

  /** Run it now, whatever its times (also while it is off). When it runs next is not changed. Answers the work's id. */
  async runNow(id: string): Promise<string> {
    const sc = this.mustSchedule(id);
    const run = await this.fire(sc, true);
    if (run.outcome !== 'started' || !run.sessionId) throw new HttpError(409, run.error ?? '始められませんでした');
    return run.sessionId;
  }

  /**
   * Send a test message, so the human sees at once that the address works. `url`: an address being typed (not saved
   * yet); left out, the schedule's saved one.
   */
  async testHook(input: { id?: unknown; url?: unknown }): Promise<void> {
    const id = input.id ? String(input.id) : '';
    const sc = id ? this.list.get(id) : undefined;
    let url: string | null;
    if (input.url !== undefined && input.url !== null && input.url !== '') {
      const c = checkHookUrl(input.url);
      if ('error' in c) throw new HttpError(400, c.error);
      url = c.url;
    } else url = id ? this.hookOf(id) : null;
    if (!url) throw new HttpError(400, 'Webhook の URL がありません');
    const title = sc ? this.labelOf(sc) : 'スケジュール';
    try {
      await this.d.post(url, { title, workspace: sc ? this.rt.core.state.projects.get(sc.projectId)?.name ?? '' : '', text: 'Orrery からのテスト送信です。このスケジュールの結果はここに届きます。', ok: true });
    } catch (e) {
      throw new HttpError(502, this.d.secrets.redact(message(e)));
    }
  }

  /** Start whatever has come due. Called every few seconds. */
  tick(): void {
    if (this.rt.closing) return;
    const at = this.now();
    for (const sc of this.list.values()) {
      if (!sc.enabled || sc.nextAt === null || sc.nextAt > at) continue;
      // The next time is settled before the run starts, so a slow start can never fire the same time twice.
      sc.nextAt = nextRunAt(sc.rule, at);
      if (sc.nextAt === null) sc.enabled = false;
      this.persist(sc);
      void this.fire(sc, false);
    }
  }

  private labelOf(sc: Schedule): string {
    return sc.name || sc.prompt.replace(/\s+/g, ' ').slice(0, 40);
  }

  private record(sc: Schedule, run: ScheduleRun): void {
    sc.runs.unshift(run);
    sc.runs.length = Math.min(sc.runs.length, KEEP_RUNS);
    this.persist(sc);
    this.rt.notify();
  }

  /** One run: start the work (or say why not). `manual`: the human pressed run now. */
  private async fire(sc: Schedule, manual: boolean): Promise<ScheduleRun> {
    const { rt } = this;
    const st = rt.core.state;
    const hook = this.hookOf(sc.id);
    const run: ScheduleRun = { at: this.now(), sessionId: null, outcome: 'started', error: null, delivery: { phase: hook ? 'waiting' : 'none', at: null, error: null } };
    const last = sc.runs.find((r) => r.sessionId);
    const prev = last?.sessionId ? st.sessions.get(last.sessionId) : undefined;
    const fail = (why: string) => {
      run.outcome = 'failed';
      run.error = why;
      return run;
    };
    if (!manual && prev && BUSY.has(prev.lifecycle)) {
      run.outcome = 'skipped';
      run.error = '前回の実行がまだ終わっていなかったため、見送りました';
      run.delivery.phase = 'none';
    } else if (!st.projects.has(sc.projectId)) fail('ワークスペースが見つかりません');
    else if (!enabledProviders(st.settings).includes(sc.provider)) fail('このスケジュールのAIは「使うAI」でオフになっています');
    if (run.outcome !== 'started') {
      this.record(sc, run);
      if (run.outcome === 'failed') this.deliver(sc, run, { ok: false, text: run.error ?? '' });
      return run;
    }
    this.record(sc, run);
    try {
      const project = st.projects.get(sc.projectId)!;
      // As voice input does: the workspace's own approval setting, where the agent has it (Codex has no "edits").
      const approvalMode = project.approvalMode === 'edits' && sc.provider !== 'claude' ? 'ask' : project.approvalMode;
      const input: StartSessionInput = { projectId: sc.projectId, provider: sc.provider, prompt: sc.prompt, title: sc.name || undefined, model: sc.model || null, effort: sc.effort || null, approvalMode, scheduleId: sc.id };
      run.sessionId = await this.d.sessions.start(input);
      this.d.journal.write(run.sessionId, 'system', `スケジュール「${this.labelOf(sc)}」${manual ? 'を「今すぐ実行」で' : 'の予定どおりに'}始めた作業です。${hook ? '返答が終わったら、結果を Webhook に送ります。' : ''}`);
    } catch (e) {
      fail(this.d.secrets.redact(message(e)));
      this.deliver(sc, run, { ok: false, text: run.error ?? '' });
    }
    this.persist(sc);
    rt.notify();
    return run;
  }

  /** Send a run's result (or why it failed) to the schedule's webhook, once. */
  private deliver(sc: Schedule, run: ScheduleRun, m: { ok: boolean; text: string }): void {
    const url = this.hookOf(sc.id);
    if (!url || run.delivery.phase === 'sending' || run.delivery.phase === 'sent') {
      if (!url) run.delivery.phase = 'none';
      return;
    }
    run.delivery = { phase: 'sending', at: null, error: null };
    this.persist(sc);
    const workspace = this.rt.core.state.projects.get(sc.projectId)?.name ?? '';
    const title = (run.sessionId && this.rt.core.state.tasks.get(this.rt.core.state.sessions.get(run.sessionId)?.taskId ?? '')?.title) || this.labelOf(sc);
    this.d.post(url, { title, workspace, text: m.text, ok: m.ok, sessionId: run.sessionId }).then(
      () => {
        run.delivery = { phase: 'sent', at: this.now(), error: null };
        if (run.sessionId) this.d.journal.write(run.sessionId, 'system', '結果を Webhook に送りました。');
      },
      (e) => {
        const why = this.d.secrets.redact(message(e));
        run.delivery = { phase: 'failed', at: this.now(), error: why };
        if (run.sessionId) this.d.journal.write(run.sessionId, 'system', `結果を Webhook に送れませんでした: ${why}`);
      },
    ).finally(() => {
      if (this.list.get(sc.id) === sc) this.persist(sc);
      this.rt.notify();
      this.onChange();
    });
  }

  /**
   * Called on every state change: send the result of each run whose reply has ended, and put away the runs that are
   * finished with nothing left for the human (when the schedule says so).
   */
  onChange(): void {
    if (this.rt.closing) return;
    const st = this.rt.core.state;
    for (const sc of this.list.values()) {
      for (const run of sc.runs) {
        if (run.outcome !== 'started' || !run.sessionId) continue;
        const s = st.sessions.get(run.sessionId);
        if (!s) continue;
        if (run.delivery.phase === 'waiting') {
          if (s.lifecycle === 'turn_finished' && !this.d.sessions.hasDeferred(s.id)) {
            this.deliver(sc, run, { ok: true, text: s.lastText?.trim() || this.rt.store.turnReplies(s.id) });
          } else if ((s.lifecycle === 'error' || s.lifecycle === 'interrupted' || s.lifecycle === 'unknown') && !s.usageResume) {
            this.deliver(sc, run, { ok: false, text: s.error ?? (s.lifecycle === 'interrupted' ? '中断されました' : '状況が分からなくなりました') });
          }
        }
        if (sc.tidy && !run.tidied && (run.delivery.phase === 'none' || run.delivery.phase === 'sent') && this.leftNothing(s.id)) {
          run.tidied = true;
          this.persist(sc);
          this.d.journal.write(s.id, 'system', 'スケジュールの「済んだら片付ける」に従って、完了にして片付けました（アーカイブからいつでも戻せます）。');
          void this.d.sessions.setAccepted(s.id, true).catch(() => {});
        }
      }
    }
  }

  /** The run's reply ended, was read for what it asks of the human, and asks nothing: no question, no step, no failed check. */
  private leftNothing(sessionId: string): boolean {
    const st = this.rt.core.state;
    const s = st.sessions.get(sessionId);
    const t = s && st.tasks.get(s.taskId);
    if (!s || !t || s.archived || t.acceptedAt !== null) return false;
    if (s.lifecycle !== 'turn_finished' || s.lastTurnOutcome !== 'completed' || this.d.sessions.hasDeferred(s.id)) return false;
    if (t.readTurn !== s.lifecycleSince) return false; // not read yet
    if (t.humanSteps?.some((x) => !x.done) || t.validating || (t.validation && !t.validation.ok)) return false;
    for (const i of st.items.values()) if (i.sessionId === s.id && (i.status === 'pending' || i.status === 'answering')) return false;
    return true;
  }
}
