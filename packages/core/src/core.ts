// ControlCore: the only place that decides whether an answer may be sent, and to which request.
// Provider adapters report facts through the ProviderSink methods; the UI issues commands; everything
// becomes an event first and state second.
import { randomUUID } from 'node:crypto';
import type { CoreEvent, EventStore, StoredEvent } from './events.ts';
import { apply, fold } from './reducer.ts';
import type {
  AgentSession,
  ApprovalMode,
  ApprovalRequest,
  AttentionAnswer,
  AttentionItem,
  AttentionType,
  CoreState,
  ProviderId,
  Question,
  Settings,
  HumanStepInput,
  TaskValidation,
} from './types.ts';

export interface OpenAttention {
  sessionId: string;
  requestId: string;
  turnId?: string | null;
  type: AttentionType;
  summary: string;
  questions?: Question[] | null;
  allowDecline?: boolean;
  passive?: boolean;
  approval?: ApprovalRequest | null;
  rawPayloadRef?: string | null;
  /**
   * Bound to the exact originating provider request. Never leaves the core. May throw if delivery fails.
   * Not needed for a passive request: its answer goes to CoreOptions.onPassiveAnswer instead.
   */
  reply?: (answer: AttentionAnswer) => void;
}

export type AnswerResult = { ok: true } | { ok: false; code: 'not_found' | 'not_pending' | 'invalid' | 'delivery_failed'; error: string };

export interface CoreOptions {
  store: EventStore;
  now?: () => number;
  onEvent?: (stored: StoredEvent, state: CoreState) => void;
  /**
   * Deliver the human's answer to a passive request (a question read from a finished reply). Unlike a provider
   * request it has no reply closure, so it can still be answered after a restart. May throw if delivery fails.
   */
  onPassiveAnswer?: (item: AttentionItem, answer: AttentionAnswer) => void;
}

export class ControlCore {
  readonly state: CoreState;
  private readonly store: EventStore;
  private readonly now: () => number;
  private readonly onEvent: (stored: StoredEvent, state: CoreState) => void;
  private readonly onPassiveAnswer: (item: AttentionItem, answer: AttentionAnswer) => void;
  /** itemId -> reply closure. In memory only: a reply cannot outlive the provider process it belongs to. */
  private readonly replies = new Map<string, (answer: AttentionAnswer) => void>();
  /** `${generation}|${sessionId}|${requestId}` -> itemId, for idempotent redelivery and for acknowledgements. */
  private readonly bySource = new Map<string, string>();

  constructor(opts: CoreOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent ?? (() => {});
    this.onPassiveAnswer =
      opts.onPassiveAnswer ??
      (() => {
        throw new Error('no handler for passive answers');
      });
    this.state = fold(this.store.readAll());
    for (const item of this.state.items.values()) this.bySource.set(this.sourceKey(item.source.generation, item.sessionId, item.source.requestId), item.id);
  }

  /** Call once per process start. Advances the generation, which retires everything the previous process left open. */
  start(): number {
    const generation = this.state.generation + 1;
    this.emit({ type: 'core.started', generation });
    return generation;
  }

  private emit(event: CoreEvent): void {
    const stored = this.store.append(this.now(), event);
    apply(this.state, stored);
    this.onEvent(stored, this.state);
  }

  private sourceKey(generation: number, sessionId: string, requestId: string): string {
    return `${generation}|${sessionId}|${requestId}`;
  }

  private findItem(sessionId: string, requestId: string): AttentionItem | undefined {
    const id = this.bySource.get(this.sourceKey(this.state.generation, sessionId, requestId));
    return id ? this.state.items.get(id) : undefined;
  }

  // ---- commands from the UI ------------------------------------------------------------------

  addProject(name: string, rootPath: string): string {
    for (const p of this.state.projects.values()) if (p.rootPath.toLowerCase() === rootPath.toLowerCase()) return p.id;
    const projectId = randomUUID();
    this.emit({ type: 'project.added', projectId, name, rootPath });
    return projectId;
  }

  /** A project's display name; spaces are folded, an empty name is refused. Answers the name it now has. */
  renameProject(projectId: string, name: string): string {
    const p = this.state.projects.get(projectId);
    if (!p) throw new Error('unknown project');
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) throw new Error('empty name');
    if (clean !== p.name) this.emit({ type: 'project.renamed', projectId, name: clean });
    return clean;
  }

  setProjectOptions(projectId: string, options: { useWorktree?: boolean; preamble?: string }): void {
    const p = this.state.projects.get(projectId);
    if (!p) throw new Error('unknown project');
    const change: { useWorktree?: boolean; preamble?: string } = {};
    if (options.useWorktree !== undefined && !!options.useWorktree !== p.useWorktree) change.useWorktree = !!options.useWorktree;
    if (options.preamble !== undefined) {
      const preamble = String(options.preamble ?? '').slice(0, 20000);
      if (preamble !== (p.preamble ?? '')) change.preamble = preamble;
    }
    if (Object.keys(change).length) this.emit({ type: 'project.options_changed', projectId, ...change });
  }

  createSession(input: { projectId: string; provider: ProviderId; title: string; acceptanceCriteria?: string | null; checkCommand?: string | null; autoFix?: boolean; cwd?: string; model?: string | null; effort?: string | null; approvalMode?: ApprovalMode }): AgentSession {
    const project = this.state.projects.get(input.projectId);
    if (!project) throw new Error('unknown project');
    const taskId = randomUUID();
    const sessionId = randomUUID();
    this.emit({
      type: 'task.created',
      taskId,
      projectId: project.id,
      title: input.title,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      ...(input.checkCommand ? { checkCommand: input.checkCommand, autoFix: !!input.autoFix } : {}),
    });
    this.emit({
      type: 'session.created',
      sessionId,
      projectId: project.id,
      taskId,
      provider: input.provider,
      cwd: input.cwd ?? project.rootPath,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.approvalMode && input.approvalMode !== 'ask' ? { approvalMode: input.approvalMode } : {}),
    });
    return this.state.sessions.get(sessionId)!;
  }

  renameTask(sessionId: string, title: string): void {
    const s = this.state.sessions.get(sessionId);
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (s && clean && this.state.tasks.get(s.taskId)?.title !== clean) this.emit({ type: 'task.renamed', taskId: s.taskId, title: clean });
  }

  validationStarted(taskId: string): void {
    if (this.state.tasks.has(taskId)) this.emit({ type: 'task.validation_started', taskId });
  }

  /** The work moved on while the check was running: its result would describe a state that no longer exists. */
  validationCancelled(taskId: string): void {
    if (this.state.tasks.get(taskId)?.validating) this.emit({ type: 'task.validation_cancelled', taskId });
  }

  validated(taskId: string, validation: TaskValidation): void {
    if (this.state.tasks.has(taskId)) this.emit({ type: 'task.validated', taskId, validation });
  }

  fixRequested(taskId: string): void {
    if (this.state.tasks.has(taskId)) this.emit({ type: 'task.fix_requested', taskId });
  }

  /** The final reply of the turn that began its "finished" state at `turn` has been read. */
  replyRead(sessionId: string, turn: number): void {
    const s = this.state.sessions.get(sessionId);
    const t = s && this.state.tasks.get(s.taskId);
    if (t && t.readTurn !== turn) this.emit({ type: 'task.reply_read', taskId: t.id, turn });
  }

  setHumanSteps(sessionId: string, steps: HumanStepInput[] | null): void {
    const s = this.state.sessions.get(sessionId);
    if (s) this.emit({ type: 'task.human_steps', taskId: s.taskId, steps: steps && steps.length ? steps : null });
  }

  /** Tick a human step. Returns true when every step is now done. */
  setHumanStepDone(sessionId: string, index: number, done: boolean): boolean {
    const s = this.state.sessions.get(sessionId);
    const t = s && this.state.tasks.get(s.taskId);
    if (!t?.humanSteps?.[index]) return false;
    if (t.humanSteps[index]!.done !== done) this.emit({ type: 'task.human_step_done', taskId: t.id, index, done });
    return t.humanSteps.every((x) => x.done);
  }

  /** A step's command started running (`result` omitted) or ended. False if the step is not (any longer) that command. */
  humanStepRan(sessionId: string, index: number, command: string, runId: string, result?: { ok: boolean; exitCode: number | null; outputTail: string }): boolean {
    const s = this.state.sessions.get(sessionId);
    const t = s && this.state.tasks.get(s.taskId);
    if (t?.humanSteps?.[index]?.command !== command) return false;
    this.emit({ type: 'task.human_step_ran', taskId: t.id, index, command, runId, ...(result ? { ok: result.ok, exitCode: result.exitCode, outputTail: result.outputTail } : {}) });
    return true;
  }

  /** Where to find the step whose command ran as `runId` now (steps before it may have changed meanwhile). */
  humanStepOfRun(sessionId: string, runId: string): number {
    const s = this.state.sessions.get(sessionId);
    const t = s && this.state.tasks.get(s.taskId);
    return t?.humanSteps?.findIndex((x) => x.run?.id === runId) ?? -1;
  }

  /** What a step's run leaves for the human (see the event). Returns true when every step is now done. */
  settleHumanStep(sessionId: string, runId: string, outcome: { done: boolean; note: string | null; steps: HumanStepInput[] }): boolean {
    const s = this.state.sessions.get(sessionId);
    const t = s && this.state.tasks.get(s.taskId);
    const index = this.humanStepOfRun(sessionId, runId);
    const st = t?.humanSteps?.[index];
    if (!t || !st?.command || st.run?.phase !== 'reading') return false;
    this.emit({ type: 'task.human_step_settled', taskId: t.id, index, command: st.command, runId, done: outcome.done, note: outcome.note, steps: outcome.steps.slice(0, 12) });
    return !!t.humanSteps?.every((x) => x.done);
  }

  /**
   * Only the human accepts a task, and whenever they decide to: a failed or unfinished check, an interrupted or broken
   * session do not stop them. The agent must not be holding it, though (stop it first), nor a request be open.
   */
  setAccepted(sessionId: string, accepted: boolean): { ok: true } | { ok: false; error: string } {
    const s = this.state.sessions.get(sessionId);
    const t = s && this.state.tasks.get(s.taskId);
    if (!s || !t) return { ok: false, error: '該当する作業がありません' };
    if (accepted) {
      if (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user' || s.lifecycle === 'queued') return { ok: false, error: 'エージェントが作業中です。止めてから完了にしてください' };
      // A question read from the reply does not block: calling the work done is an answer to it.
      if ([...this.state.items.values()].some((i) => i.sessionId === s.id && !i.passive && (i.status === 'pending' || i.status === 'answering'))) {
        return { ok: false, error: '未回答の依頼が残っています' };
      }
    }
    if ((t.acceptedAt !== null) !== accepted) this.emit({ type: 'task.accepted', taskId: t.id, accepted });
    return { ok: true };
  }

  setSettings(patch: Partial<Settings>): Settings {
    const next: Partial<Settings> = {};
    if (patch.maxConcurrent !== undefined) next.maxConcurrent = Math.min(20, Math.max(1, Math.floor(Number(patch.maxConcurrent)) || 1));
    if (patch.minFreeMemoryMB !== undefined) next.minFreeMemoryMB = Math.min(65536, Math.max(0, Math.floor(Number(patch.minFreeMemoryMB)) || 0));
    if (patch.confirmCommands !== undefined) next.confirmCommands = patch.confirmCommands !== false;
    if (patch.preamble !== undefined) next.preamble = String(patch.preamble ?? '').slice(0, 20000);
    if (patch.sideChat !== undefined && patch.sideChat !== null && typeof patch.sideChat === 'object') {
      const c = patch.sideChat as Partial<Settings['sideChat']>;
      next.sideChat = {
        provider: c.provider === 'codex' ? 'codex' : 'claude',
        model: String(c.model ?? '').trim().slice(0, 120),
        effort: String(c.effort ?? '').trim().slice(0, 30),
      };
    }
    if (Object.keys(next).length) this.emit({ type: 'settings.changed', settings: next });
    return this.state.settings;
  }

  /** The human opened the session: its finished result is no longer "new". */
  markSeen(sessionId: string): void {
    if (this.state.sessions.get(sessionId)?.unread) this.emit({ type: 'session.seen', sessionId });
  }

  /** Reversible tidy-up. A session that is still working or waiting on the human cannot be put away. */
  setArchived(sessionId: string, archived: boolean): { ok: true } | { ok: false; error: string } {
    const s = this.state.sessions.get(sessionId);
    if (!s) return { ok: false, error: '該当するセッションがありません' };
    if (archived && (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user' || s.lifecycle === 'queued')) {
      return { ok: false, error: '実行中・人間待ちの作業はアーカイブできません。先に中断してください' };
    }
    if (s.archived !== archived) this.emit({ type: 'session.archived', sessionId, archived });
    return { ok: true };
  }

  /** The human's answer to one item. Hands it to the provider at most once, and only while the item is pending. */
  answer(itemId: string, answer: AttentionAnswer): AnswerResult {
    const item = this.state.items.get(itemId);
    if (!item) return { ok: false, code: 'not_found', error: '該当する項目がありません' };
    if (item.status !== 'pending') return { ok: false, code: 'not_pending', error: `この項目は${STATUS_JA[item.status]}のため、回答は送信されませんでした` };
    if (item.passive) return this.answerPassive(item, answer);
    const reply = this.replies.get(itemId);
    if (!reply || item.source.generation !== this.state.generation) {
      this.emit({ type: 'attention.expired', itemId, reason: '発生元のプロセスが既に存在しません' });
      return { ok: false, code: 'not_pending', error: '発生元のプロセスが既に存在しないため、回答は送信されませんでした' };
    }
    const invalid = validateAnswer(item, answer);
    if (invalid) return { ok: false, code: 'invalid', error: invalid };

    // Record intent first, then deliver: if we crash in between, the item is 'answering' and the next
    // start reports "could not confirm delivery" instead of silently offering the button again.
    this.emit({ type: 'attention.answer_sent', itemId, answer });
    this.replies.delete(itemId);
    try {
      reply(answer);
    } catch (e) {
      this.replies.set(itemId, reply);
      this.emit({ type: 'attention.answer_failed', itemId, error: String((e as Error)?.message ?? e) });
      return { ok: false, code: 'delivery_failed', error: `プロバイダーへの送信に失敗しました: ${String((e as Error)?.message ?? e)}` };
    }
    return { ok: true };
  }

  private answerPassive(item: AttentionItem, answer: AttentionAnswer): AnswerResult {
    const invalid = validateAnswer(item, answer);
    if (invalid) return { ok: false, code: 'invalid', error: invalid };
    this.emit({ type: 'attention.answer_sent', itemId: item.id, answer });
    try {
      this.onPassiveAnswer(item, answer);
    } catch (e) {
      this.emit({ type: 'attention.answer_failed', itemId: item.id, error: String((e as Error)?.message ?? e) });
      return { ok: false, code: 'delivery_failed', error: `送信できませんでした: ${String((e as Error)?.message ?? e)}` };
    }
    // Nothing on the provider side confirms it: handing it over is the evidence.
    this.emit({ type: 'attention.acknowledged', itemId: item.id, evidence: answer.kind === 'decline' ? '回答なしで閉じた' : 'メッセージとして送信' });
    return { ok: true };
  }

  // ---- facts reported by provider adapters -----------------------------------------------------

  sessionUpdate(sessionId: string, patch: Extract<CoreEvent, { type: 'session.updated' }>['patch']): void {
    if (!this.state.sessions.has(sessionId)) return;
    this.emit({ type: 'session.updated', sessionId, patch });
    // Items the reducer just expired can no longer be replied to.
    for (const [itemId] of this.replies) if (this.state.items.get(itemId)?.status === 'expired') this.replies.delete(itemId);
  }

  attentionOpen(input: OpenAttention): string {
    const key = this.sourceKey(this.state.generation, input.sessionId, input.requestId);
    const existing = this.bySource.get(key);
    if (existing) return existing; // redelivery of the same provider request
    if (!this.state.sessions.has(input.sessionId)) throw new Error('unknown session');
    const itemId = randomUUID();
    this.bySource.set(key, itemId);
    if (input.passive) {
      // An open passive question from an earlier reply of this session is superseded by the new one.
      for (const old of [...this.state.items.values()]) if (old.sessionId === input.sessionId && old.passive && old.status === 'pending') this.expireItem(old.id, '新しい返答に置き換わりました');
    } else if (!input.reply) throw new Error('a provider request needs a reply');
    else this.replies.set(itemId, input.reply);
    this.emit({
      type: 'attention.opened',
      itemId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      turnId: input.turnId ?? null,
      itemType: input.type,
      summary: input.summary,
      questions: input.questions ?? null,
      approval: input.approval ?? null,
      rawPayloadRef: input.rawPayloadRef ?? null,
      ...(input.allowDecline ? { allowDecline: true } : {}),
      ...(input.passive ? { passive: true } : {}),
    });
    return itemId;
  }

  /** The provider confirmed the request is settled. If we never answered it, it was settled without us: expire. */
  attentionAcknowledged(sessionId: string, requestId: string, evidence: string): void {
    const item = this.findItem(sessionId, requestId);
    if (!item) return;
    if (item.status === 'answering') this.emit({ type: 'attention.acknowledged', itemId: item.id, evidence });
    else if (item.status === 'pending') this.expireItem(item.id, `プロバイダー側で解決済みになりました（${evidence}）`);
  }

  attentionWithdrawn(sessionId: string, requestId: string, reason: string): void {
    const item = this.findItem(sessionId, requestId);
    if (item && item.status === 'pending') this.expireItem(item.id, reason);
  }

  private expireItem(itemId: string, reason: string): void {
    this.replies.delete(itemId);
    this.emit({ type: 'attention.expired', itemId, reason });
  }
}

const STATUS_JA: Record<AttentionItem['status'], string> = {
  pending: '未回答',
  answering: '送信済み（受領確認待ち）',
  resolved: '回答済み',
  expired: '失効済み',
};

function validateAnswer(item: AttentionItem, answer: AttentionAnswer): string | null {
  if (item.type === 'user_question') {
    if (answer.kind === 'decline') return item.allowDecline ? null : 'この質問は回答を辞退できません';
    if (answer.kind !== 'answers') return '質問には回答（answers）が必要です';
    for (const q of item.questions ?? []) {
      const v = answer.answers[q.id];
      if (q.optional && (v === undefined || (Array.isArray(v) && v.length === 0))) continue;
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !x.trim())) return `未回答の質問があります: ${q.text}`;
      if (v.length > 1 && !q.multiSelect) return `複数選択できない質問です: ${q.text}`;
      const labels = new Set(q.options.map((o) => o.label));
      if (!q.allowFreeText && v.some((x) => !labels.has(x))) return `選択肢にない回答です: ${q.text}`;
    }
    return null;
  }
  if (item.type === 'permission_approval') {
    if (answer.kind !== 'decision') return '承認要求には決定（decision）が必要です';
    if (!item.approval?.decisions.includes(answer.decision)) return `この要求では選べない決定です: ${answer.decision}`;
    return null;
  }
  return 'この種類の項目には回答できません';
}
