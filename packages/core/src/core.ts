// ControlCore: the only place that decides whether an answer may be sent, and to which request.
// Provider adapters report facts through the ProviderSink methods; the UI issues commands; everything
// becomes an event first and state second.
import { randomUUID } from 'node:crypto';
import type { CoreEvent, EventStore, StoredEvent } from './events.ts';
import { apply, fold } from './reducer.ts';
import { APPROVAL_MODES, PROJECT_DESCRIPTION_MAX, PROVIDER_IDS, enabledProviders } from './types.ts';
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
  KnowledgeSettings,
  VoiceSettings,
  KnowledgeEntry,
  TaskValidation,
} from './types.ts';
import { addedSince, cleanLine, cleanText, combineKnowledgeText, mergeKnowledgeEntries, newLines, scopedKnowledgeText, KNOWLEDGE_LIMITS, OTHER_DOMAIN_ID } from './knowledge.ts';
import type { UsageLimit } from './provider.ts';

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
  /** What the agent wrote just before asking, shown above the question. */
  context?: string | null;
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
    this.consolidateKnowledge();
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

  setProjectOptions(projectId: string, options: { useWorktree?: boolean; preamble?: string; approvalMode?: ApprovalMode; captureKnowledge?: boolean; description?: string }): void {
    const p = this.state.projects.get(projectId);
    if (!p) throw new Error('unknown project');
    const change: { useWorktree?: boolean; preamble?: string; approvalMode?: ApprovalMode; captureKnowledge?: boolean; description?: string } = {};
    if (options.approvalMode !== undefined) {
      if (!APPROVAL_MODES.includes(options.approvalMode)) throw new Error('unknown approval mode');
      if (options.approvalMode !== p.approvalMode) change.approvalMode = options.approvalMode;
    }
    if (options.useWorktree !== undefined && !!options.useWorktree !== p.useWorktree) change.useWorktree = !!options.useWorktree;
    if (options.captureKnowledge !== undefined && !!options.captureKnowledge !== (p.captureKnowledge !== false)) change.captureKnowledge = !!options.captureKnowledge;
    if (options.preamble !== undefined) {
      const preamble = String(options.preamble ?? '').slice(0, 20000);
      if (preamble !== (p.preamble ?? '')) change.preamble = preamble;
    }
    if (options.description !== undefined) {
      const description = String(options.description ?? '').trim().slice(0, PROJECT_DESCRIPTION_MAX);
      if (description !== (p.description ?? '')) change.description = description;
    }
    if (Object.keys(change).length) this.emit({ type: 'project.options_changed', projectId, ...change });
  }

  createSession(input: { projectId: string; provider: ProviderId; title: string; acceptanceCriteria?: string | null; checkCommand?: string | null; autoFix?: boolean; cwd?: string; extraProjectIds?: string[]; model?: string | null; effort?: string | null; approvalMode?: ApprovalMode }): AgentSession {
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
      ...(input.extraProjectIds?.length ? { extraProjectIds: [...new Set(input.extraProjectIds)].filter((id) => id !== project.id && this.state.projects.has(id)) } : {}),
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
    if (patch.autoResumeOnLimit !== undefined) next.autoResumeOnLimit = patch.autoResumeOnLimit !== false;
    if (patch.preamble !== undefined) next.preamble = String(patch.preamble ?? '').slice(0, 20000);
    if (patch.sideChat !== undefined && patch.sideChat !== null && typeof patch.sideChat === 'object') {
      const c = patch.sideChat as Partial<Settings['sideChat']>;
      next.sideChat = {
        provider: c.provider === 'codex' ? 'codex' : 'claude',
        model: String(c.model ?? '').trim().slice(0, 120),
        effort: String(c.effort ?? '').trim().slice(0, 30),
      };
    }
    if (patch.knowledge !== undefined && patch.knowledge !== null && typeof patch.knowledge === 'object') {
      const c = patch.knowledge as Partial<KnowledgeSettings>;
      const now = this.state.settings.knowledge;
      const k = { ...now, capture: c.capture === undefined ? now.capture : c.capture !== false, inject: c.inject === undefined ? now.inject : c.inject !== false };
      for (const key of ['captureAi', 'tuneAi'] as const) {
        const ai = c[key];
        if (!ai || typeof ai !== 'object') continue;
        k[key] = {
          provider: ai.provider === 'codex' ? 'codex' : 'claude',
          model: String(ai.model ?? '').trim().slice(0, 120),
          effort: String(ai.effort ?? '').trim().slice(0, 30),
        };
      }
      if (JSON.stringify(k) !== JSON.stringify(now)) next.knowledge = k;
    }
    if (patch.voice !== undefined && patch.voice !== null && typeof patch.voice === 'object') {
      const c = patch.voice as Partial<VoiceSettings>;
      const now = this.state.settings.voice;
      const v: VoiceSettings = { ...now, plannerAi: { ...now.plannerAi }, confirm: c.confirm === undefined ? now.confirm : c.confirm !== false };
      if (c.recognizer !== undefined) v.recognizer = String(c.recognizer ?? '').trim().slice(0, 60);
      if (c.words !== undefined) v.words = voiceWords(c.words);
      if (c.plannerAi && typeof c.plannerAi === 'object') {
        v.plannerAi = {
          provider: c.plannerAi.provider === 'codex' ? 'codex' : 'claude',
          model: String(c.plannerAi.model ?? '').trim().slice(0, 120),
          effort: String(c.plannerAi.effort ?? '').trim().slice(0, 30),
        };
      }
      if (JSON.stringify(v) !== JSON.stringify(now)) next.voice = v;
    }
    if (Array.isArray(patch.providers)) {
      // Known providers only, in their own order; at least one stays on (there is always some AI to ask).
      const want = PROVIDER_IDS.filter((p) => (patch.providers as unknown[]).includes(p));
      if (want.length && JSON.stringify(want) !== JSON.stringify(enabledProviders(this.state.settings))) next.providers = want;
    }
    if (Object.keys(next).length) this.emit({ type: 'settings.changed', settings: next });
    return this.state.settings;
  }

  recordUsageLimits(provider: ProviderId, limits: UsageLimit[]): void {
    const key = (l: UsageLimit) => JSON.stringify([l.model ?? null, l.kind ?? 'other', l.label]);
    const merged = new Map((this.state.usageLimits.get(provider) ?? []).map((l) => [key(l), l]));
    for (const l of limits) merged.set(key(l), l);
    const next = [...merged.values()];
    if (JSON.stringify(next) !== JSON.stringify(this.state.usageLimits.get(provider) ?? [])) this.emit({ type: 'usage.limits_updated', provider, limits: next });
  }

  // ---- the human's standing preferences (こだわり) --------------------------------------------------

  /** Upgrade older, individual entries once. Original events stay in the log; replacement is atomic. */
  private consolidateKnowledge(): void {
    const k = this.state.knowledge;
    const entries: KnowledgeEntry[] = [];
    const remove: string[] = [];
    for (const domainId of k.domains.keys()) {
      const old = [...k.entries.values()].filter((e) => e.domainId === domainId);
      if (!old.length || (old.length === 1 && old[0]!.scope === 'all')) continue;
      entries.push(mergeKnowledgeEntries(this.state, old, domainId));
      remove.push(...old.map((e) => e.id));
    }
    if (entries.length) this.emit({ type: 'knowledge.prompts_set', entries, remove });
  }

  /** Make an area (no id) or change one. Answers its id. */
  setKnowledgeDomain(input: { id?: string; name?: string; description?: string; always?: boolean }): string {
    const k = this.state.knowledge;
    const d = input.id ? k.domains.get(input.id) : undefined;
    if (input.id && !d) throw new Error('unknown domain');
    const change: { name?: string; description?: string; always?: boolean } = {};
    if (input.name !== undefined) {
      const name = cleanLine(input.name, KNOWLEDGE_LIMITS.domainName);
      if (!name) throw new Error('empty name');
      if (name !== d?.name) change.name = name;
    } else if (!d) throw new Error('empty name');
    if (input.description !== undefined) {
      const description = cleanLine(input.description, KNOWLEDGE_LIMITS.domainDescription);
      if (description !== (d?.description ?? '')) change.description = description;
    }
    if (input.always !== undefined && !!input.always !== (d?.always ?? false)) change.always = !!input.always;
    if (!d && k.domains.size >= KNOWLEDGE_LIMITS.domains) throw new Error('too many domains');
    const domainId = d?.id ?? randomUUID();
    if (!d || Object.keys(change).length) this.emit({ type: 'knowledge.domain_set', domainId, ...change });
    return domainId;
  }

  /** Remove an area; what was in it goes to その他. その他 itself stays. */
  removeKnowledgeDomain(domainId: string): void {
    if (domainId === OTHER_DOMAIN_ID) throw new Error('the catch-all domain stays');
    if (!this.state.knowledge.domains.has(domainId)) return;
    const k = this.state.knowledge;
    const moveTo = k.domains.has(OTHER_DOMAIN_ID) ? OTHER_DOMAIN_ID : null;
    const source = [...k.entries.values()].filter((e) => e.domainId === domainId);
    if (moveTo && source.length) {
      const target = [...k.entries.values()].filter((e) => e.domainId === moveTo);
      const merged = mergeKnowledgeEntries(this.state, [...target, ...source], moveTo);
      if (target.length) merged.id = target[0]!.id;
      this.emit({ type: 'knowledge.prompts_set', entries: [merged], remove: [...target, ...source].map((e) => e.id) });
    }
    this.emit({ type: 'knowledge.domain_removed', domainId, moveTo });
  }

  /**
   * Append to a section's single prompt. Answers its existing id, or null for empty text.
   * `seen`: written by the human (true), or read from what they said and not yet looked at (false).
   */
  addKnowledgeEntry(input: { domainId: string; text: string; sessionId?: string | null; scope?: string | null; seen?: boolean }): string | null {
    const k = this.state.knowledge;
    const domainId = k.domains.has(input.domainId) ? input.domainId : k.domains.has(OTHER_DOMAIN_ID) ? OTHER_DOMAIN_ID : null;
    if (!domainId) return null;
    const text = cleanText(input.text, Infinity);
    if (!text) return null;
    const old = [...k.entries.values()].filter((e) => e.domainId === domainId);
    const at = this.now();
    const entry: KnowledgeEntry = { id: randomUUID(), domainId, text, sessionId: input.sessionId ?? null, scope: this.scopeOf(input.scope), hits: 1, createdAt: at, updatedAt: at, seen: input.seen ?? true };
    const merged = mergeKnowledgeEntries(this.state, [...old, entry], domainId);
    if (old.length) merged.id = old[0]!.id;
    merged.updatedAt = at;
    merged.sessionId = input.sessionId ?? merged.sessionId;
    merged.seen = input.seen ?? true;
    this.markAdded(merged, old);
    this.emit({ type: 'knowledge.prompts_set', entries: [merged], remove: old.map((e) => e.id) });
    return merged.id;
  }

  private scopeOf(scope: string | null | undefined): string {
    return scope && scope !== 'all' && this.state.projects.has(scope) ? scope : 'all';
  }

  /** Rewrite a preference. An empty text removes it. */
  updateKnowledgeEntry(entryId: string, patch: { text?: string; domainId?: string; scope?: string; seen?: boolean }): void {
    const k = this.state.knowledge;
    const e = k.entries.get(entryId);
    if (!e) throw new Error('unknown entry');
    const next = { ...e };
    if (patch.text !== undefined) {
      const text = cleanText(patch.text, Infinity);
      if (!text) return this.removeKnowledgeEntry(entryId);
      next.text = text;
    }
    if (patch.domainId !== undefined && patch.domainId !== e.domainId) {
      if (!k.domains.has(patch.domainId)) throw new Error('unknown domain');
      next.domainId = patch.domainId;
    }
    if (patch.scope !== undefined) {
      next.text = scopedKnowledgeText(this.state, this.scopeOf(patch.scope), next.text);
      next.scope = 'all';
    }
    next.seen = patch.seen ?? true;
    if (next.text === e.text && next.domainId === e.domainId && next.scope === e.scope && next.seen === e.seen) return;
    next.updatedAt = this.now();
    const target = [...k.entries.values()].filter((x) => x.domainId === next.domainId && x.id !== entryId);
    // Keep the target's id on moves, so subsequent edits can keep referring to the section.
    const merged = target.length ? { ...mergeKnowledgeEntries(this.state, [...target, next], next.domainId), id: target[0]!.id } : next;
    merged.seen = next.seen;
    this.markAdded(merged, [...target, e]);
    this.emit({ type: 'knowledge.prompts_set', entries: [merged], remove: [entryId, ...target.map((x) => x.id)] });
  }

  /**
   * A section recorded by itself keeps which of its lines are new to the human, so the news shows only those; what
   * was there before (`before`, the entries it replaces) is not news again. Seen: nothing is new.
   */
  private markAdded(merged: KnowledgeEntry, before: readonly KnowledgeEntry[]): void {
    if (merged.seen) {
      delete merged.added;
      return;
    }
    const text = combineKnowledgeText(before.map((x) => scopedKnowledgeText(this.state, x.scope, x.text)));
    merged.added = addedSince({ text, added: before.flatMap(newLines) }, merged.text);
  }

  removeKnowledgeEntry(entryId: string): void {
    if (this.state.knowledge.entries.has(entryId)) this.emit({ type: 'knowledge.entry_removed', entryId });
  }

  /** The same preference came up again. */
  reinforceKnowledgeEntry(entryId: string, from: { sessionId?: string | null }): void {
    if (!this.state.knowledge.entries.has(entryId)) return;
    this.emit({ type: 'knowledge.entry_reinforced', entryId, sessionId: from.sessionId ?? null });
  }

  /** The human looked at what was recorded by itself. */
  markKnowledgeSeen(): void {
    if ([...this.state.knowledge.entries.values()].some((e) => !e.seen)) this.emit({ type: 'knowledge.seen' });
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
      ...(input.context?.trim() ? { context: input.context } : {}),
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

/** The human's own words for voice input: one per line, blank lines and stray spaces dropped, a sane number of them. */
function voiceWords(raw: unknown): string {
  return String(raw ?? '').split(/\r?\n/).map((w) => w.trim().slice(0, 80)).filter(Boolean).slice(0, 200).join('\n');
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
