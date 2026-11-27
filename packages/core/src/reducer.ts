// Pure fold: (state, event) -> state. No I/O, no clocks other than the event's own timestamp.
import type { StoredEvent } from './events.ts';
import type { AgentSession, AttentionItem, CoreState, HumanStep } from './types.ts';
import { defaultKnowledge } from './knowledge.ts';

export function emptyState(): CoreState {
  return {
    generation: 0,
    settings: { maxConcurrent: 8, minFreeMemoryMB: 0, confirmCommands: true, autoResumeOnLimit: true, preamble: '', sideChat: { provider: 'claude', model: 'sonnet', effort: 'low' }, knowledge: { capture: true, inject: true }, voice: { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: true } },
    projects: new Map(),
    tasks: new Map(),
    sessions: new Map(),
    items: new Map(),
    knowledge: defaultKnowledge(),
    usageLimits: new Map(),
  };
}

const TURN_ENDED = new Set(['turn_finished', 'interrupted', 'error']);

function expire(item: AttentionItem, reason: string): void {
  item.status = 'expired';
  item.expiredReason = reason;
}

/** Close the open questions that were read from a session's reply (nothing is waiting on them but the human). */
function expirePassive(state: CoreState, sessionId: string, reason: string): void {
  for (const item of state.items.values()) {
    if (item.sessionId === sessionId && item.passive && item.status === 'pending') expire(item, reason);
  }
}

/** Mutates and returns `state` (the fold owns the state object). */
export function apply(state: CoreState, stored: StoredEvent): CoreState {
  const { at, event: e } = stored;
  switch (e.type) {
    case 'core.started': {
      state.generation = e.generation;
      for (const t of state.tasks.values()) {
        t.validating = false; // a check that was running died with the previous process
        // So did a step's command, or the reading of its output.
        for (const st of t.humanSteps ?? []) {
          if (st.run && st.run.phase !== 'settled') {
            st.run.note = st.run.phase === 'running' ? 'Orrery が止まったため、実行は途中で終わりました。もう一度実行できます。' : 'Orrery が止まったため、結果を読み終えられませんでした。';
            st.run.phase = 'settled';
          }
        }
      }
      // Nothing from an earlier generation can still be live: its provider processes were ours and are gone.
      for (const s of state.sessions.values()) {
        if (s.generation === e.generation) continue;
        // Background work lived in the agent's process tree, which is gone.
        s.background = null;
        s.awaitingBackground = false;
        if (s.process === 'alive' || s.process === 'stopping') s.process = 'stopped';
        if (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user' || s.lifecycle === 'queued') {
          s.lifecycle = 'interrupted';
          s.lifecycleSince = at;
          s.unread = true;
          s.lastTurnOutcome = 'interrupted';
          s.resumability = s.providerSessionId ? 'unknown' : 'unrecoverable';
          s.updatedAt = at;
        }
      }
      for (const item of state.items.values()) {
        // A passive question needs no live process: it stays open across restarts.
        if (item.passive && item.status === 'pending') continue;
        if (item.source.generation !== e.generation && (item.status === 'pending' || item.status === 'answering')) {
          expire(
            item,
            item.status === 'answering'
              ? 'Control Roomが再起動したため、回答が届いたか確認できません'
              : 'Control Roomが再起動したため回答できません（セッションを再開して再度指示してください）',
          );
        }
      }
      return state;
    }
    case 'project.added':
      state.projects.set(e.projectId, { id: e.projectId, name: e.name, rootPath: e.rootPath, createdAt: at, useWorktree: true, preamble: '', approvalMode: 'auto', captureKnowledge: true, description: '' });
      return state;
    case 'project.renamed': {
      const p = state.projects.get(e.projectId);
      if (p) p.name = e.name;
      return state;
    }
    case 'project.options_changed': {
      const p = state.projects.get(e.projectId);
      if (p && e.useWorktree !== undefined) p.useWorktree = e.useWorktree;
      if (p && e.preamble !== undefined) p.preamble = e.preamble;
      if (p && e.approvalMode !== undefined) p.approvalMode = e.approvalMode;
      if (p && e.captureKnowledge !== undefined) p.captureKnowledge = e.captureKnowledge;
      if (p && e.description !== undefined) p.description = e.description;
      return state;
    }
    case 'task.created':
      state.tasks.set(e.taskId, {
        id: e.taskId,
        projectId: e.projectId,
        title: e.title,
        acceptanceCriteria: e.acceptanceCriteria,
        createdAt: at,
        checkCommand: e.checkCommand ?? null,
        autoFix: e.autoFix ?? false,
        fixRounds: 0,
        validation: null,
        validating: false,
        acceptedAt: null,
        humanSteps: null,
        readTurn: null,
      });
      return state;
    case 'task.renamed': {
      const t = state.tasks.get(e.taskId);
      if (t) t.title = e.title;
      return state;
    }
    case 'task.validation_started': {
      const t = state.tasks.get(e.taskId);
      if (t) t.validating = true;
      return state;
    }
    case 'task.validation_cancelled': {
      const t = state.tasks.get(e.taskId);
      if (t) t.validating = false;
      return state;
    }
    case 'task.validated': {
      const t = state.tasks.get(e.taskId);
      if (t) {
        t.validating = false;
        t.validation = e.validation;
        // A result is news for the human.
        for (const s of state.sessions.values()) if (s.taskId === t.id) s.unread = true;
      }
      return state;
    }
    case 'task.fix_requested': {
      const t = state.tasks.get(e.taskId);
      if (t) t.fixRounds += 1;
      return state;
    }
    case 'task.human_steps': {
      const t = state.tasks.get(e.taskId);
      if (t) {
        t.humanSteps = e.steps ? e.steps.map((s) => ({ ...s, after: s.after ?? null, done: false })) : null;
        if (e.steps) for (const s of state.sessions.values()) if (s.taskId === t.id) s.unread = true;
      }
      return state;
    }
    case 'task.reply_read': {
      const t = state.tasks.get(e.taskId);
      if (t) t.readTurn = e.turn;
      return state;
    }
    case 'task.human_step_ran': {
      const st = state.tasks.get(e.taskId)?.humanSteps?.[e.index];
      if (!st || st.command !== e.command) return state;
      st.run = e.ok === undefined || e.ok === null
        ? { id: e.runId, phase: 'running', at, ok: null, exitCode: null, outputTail: null, note: null }
        : { id: e.runId, phase: 'reading', at: st.run?.id === e.runId ? st.run.at : at, ok: e.ok, exitCode: e.exitCode ?? null, outputTail: e.outputTail ?? null, note: null };
      return state;
    }
    case 'task.human_step_settled': {
      const t = state.tasks.get(e.taskId);
      const st = t?.humanSteps?.[e.index];
      if (!t?.humanSteps || !st || st.command !== e.command || st.run?.id !== e.runId) return state;
      st.run = { ...st.run, phase: 'settled', note: e.note };
      const added: HumanStep[] = e.steps.map((x) => ({ ...x, after: x.after ?? null, done: false, run: null }));
      if (e.done) {
        st.done = true;
        t.humanSteps.splice(e.index + 1, 0, ...added);
      } else if (added.length) {
        // What still has to happen replaces the step; the run that led to it is kept on the first one, so it can be seen.
        added[0]!.run = st.run;
        // What replaces the action the checks need first is still needed first.
        if (st.prep) for (const x of added) x.prep = true;
        t.humanSteps.splice(e.index, 1, ...added);
      }
      return state;
    }
    case 'task.human_step_done': {
      const step = state.tasks.get(e.taskId)?.humanSteps?.[e.index];
      if (step) step.done = e.done;
      return state;
    }
    case 'task.accepted': {
      const t = state.tasks.get(e.taskId);
      if (t) {
        t.acceptedAt = e.accepted ? at : null;
        if (e.accepted) for (const s of state.sessions.values()) if (s.taskId === t.id) s.usageResume = null;
        // Calling the work done answers whatever its last reply was asking.
        if (e.accepted) for (const s of state.sessions.values()) if (s.taskId === t.id) expirePassive(state, s.id, '作業を完了にしました');
      }
      return state;
    }
    case 'settings.changed':
      Object.assign(state.settings, e.settings);
      if (e.settings.autoResumeOnLimit === false) for (const s of state.sessions.values()) {
        if (s.usageResume) s.usageResumeCancelled = true;
        s.usageResume = null;
      }
      return state;
    case 'usage.limits_updated':
      state.usageLimits.set(e.provider, e.limits);
      return state;
    case 'knowledge.domain_set': {
      const k = state.knowledge;
      const d = k.domains.get(e.domainId) ?? { id: e.domainId, name: '', description: '', always: false, order: Math.max(-1, ...[...k.domains.values()].map((x) => x.order)) + 1 };
      if (e.name !== undefined) d.name = e.name;
      if (e.description !== undefined) d.description = e.description;
      if (e.always !== undefined) d.always = e.always;
      if (e.order !== undefined) d.order = e.order;
      k.domains.set(d.id, d);
      return state;
    }
    case 'knowledge.domain_removed': {
      const k = state.knowledge;
      k.domains.delete(e.domainId);
      for (const entry of [...k.entries.values()]) {
        if (entry.domainId !== e.domainId) continue;
        if (e.moveTo && k.domains.has(e.moveTo)) {
          entry.domainId = e.moveTo;
          entry.updatedAt = at;
        } else k.entries.delete(entry.id);
      }
      return state;
    }
    case 'knowledge.entry_added':
      state.knowledge.entries.set(e.entryId, {
        id: e.entryId,
        domainId: e.domainId,
        // Old events kept the reason apart; it was sent after the text, so it stays there.
        text: e.why ? `${e.text}（理由: ${e.why}）` : e.text,
        sessionId: e.sessionId,
        scope: e.scope,
        hits: 1,
        createdAt: at,
        updatedAt: at,
        seen: e.seen,
      });
      return state;
    case 'knowledge.entry_updated': {
      const entry = state.knowledge.entries.get(e.entryId);
      if (!entry) return state;
      if (e.text !== undefined) entry.text = e.text;
      if (e.domainId !== undefined) entry.domainId = e.domainId;
      if (e.scope !== undefined) entry.scope = e.scope;
      entry.updatedAt = at;
      return state;
    }
    case 'knowledge.entry_removed':
      state.knowledge.entries.delete(e.entryId);
      return state;
    case 'knowledge.prompts_set':
      for (const id of e.remove) state.knowledge.entries.delete(id);
      for (const entry of e.entries) state.knowledge.entries.set(entry.id, { ...entry });
      return state;
    case 'knowledge.entry_reinforced': {
      const entry = state.knowledge.entries.get(e.entryId);
      if (!entry) return state;
      entry.hits += 1;
      if (e.sessionId) entry.sessionId = e.sessionId;
      entry.updatedAt = at;
      return state;
    }
    case 'knowledge.seen':
      for (const entry of state.knowledge.entries.values()) {
        entry.seen = true;
        delete entry.added;
      }
      return state;
    case 'session.created': {
      const s: AgentSession = {
        id: e.sessionId,
        projectId: e.projectId,
        taskId: e.taskId,
        provider: e.provider,
        cwd: e.cwd,
        ...(e.extraProjectIds?.length ? { extraProjectIds: [...e.extraProjectIds] } : {}),
        providerSessionId: null,
        model: null,
        lifecycle: 'queued',
        process: 'not_started',
        resumability: 'unknown',
        generation: state.generation,
        createdAt: at,
        updatedAt: at,
        lastText: null,
        lastTurnOutcome: null,
        error: null,
        requestedModel: e.model ?? null,
        effort: e.effort ?? null,
        approvalMode: e.approvalMode ?? 'ask',
        lifecycleSince: at,
        unread: false,
        archived: false,
        background: null,
        awaitingBackground: false,
        usageResume: null,
        usageResumeCancelled: false,
      };
      state.sessions.set(s.id, s);
      return state;
    }
    case 'session.updated': {
      const s = state.sessions.get(e.sessionId);
      if (!s) return state;
      const before = s.lifecycle;
      Object.assign(s, e.patch);
      if (e.patch.usageResume === null) s.usageResumeCancelled = e.patch.usageResumeCancelled ?? true;
      if (e.patch.lifecycle === 'queued') s.usageResumeCancelled = false;
      // A normal reply has moved past the interrupted work. Queued automatic resumes retain their appointment
      // until actually started, so restarting the app while they wait for a slot cannot lose them.
      if (e.patch.lifecycle === 'turn_finished' && s.lastTurnOutcome === 'completed') s.usageResume = null;
      s.updatedAt = at;
      if (s.lifecycle !== before) {
        s.lifecycleSince = at;
        if (TURN_ENDED.has(s.lifecycle)) s.unread = true;
        // Waiting for background work is a way of running: any other state ends it.
        if (s.lifecycle !== 'running' && e.patch.awaitingBackground === undefined) s.awaitingBackground = false;
        // The session moved on (the human typed a reply, or more work started): a question read from the old reply is stale.
        if (s.lifecycle !== 'turn_finished') expirePassive(state, s.id, '作業が先に進みました');
        // The agent went on after an answer (working again, or its turn ended): the answer reached it, whether or not
        // the provider ever says so. It must not come back to the human as if it were still unanswered.
        if (s.lifecycle !== 'waiting_for_user' && s.lifecycle !== 'queued' && e.patch.process !== 'stopped' && e.patch.process !== 'crashed') {
          for (const item of state.items.values()) {
            if (item.sessionId !== s.id || item.passive || item.status !== 'answering') continue;
            item.status = 'resolved';
            item.acknowledgement = { at, evidence: 'エージェントが先に進んだ' };
          }
        }
        if (s.lifecycle === 'running') {
          // The agent is changing things again: the previous check result no longer describes the work.
          const t = state.tasks.get(s.taskId);
          if (t) {
            t.validation = null;
            t.acceptedAt = null;
            t.humanSteps = null; // the agent is working again: what it leaves for the human may change
          }
        }
      }
      if (e.patch.process === 'alive') s.generation = state.generation;
      if (e.patch.providerSessionId && s.resumability === 'unknown') s.resumability = 'resumable';
      // A turn that ended, or a process that is gone, cannot still be waiting on a request.
      const turnEnded = e.patch.lifecycle !== undefined && TURN_ENDED.has(e.patch.lifecycle);
      const processGone = e.patch.process === 'stopped' || e.patch.process === 'crashed';
      if (turnEnded || processGone) {
        for (const item of state.items.values()) {
          if (item.sessionId !== s.id || item.passive) continue;
          if (item.status === 'pending' || (processGone && item.status === 'answering')) {
            expire(item, processGone ? 'エージェントのプロセスが終了しました' : `ターンが終了しました（${e.patch.lifecycle}）`);
          }
        }
        if (processGone) {
          s.background = null;
          s.awaitingBackground = false;
        }
        if (processGone && (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user')) {
          s.lifecycle = e.patch.process === 'crashed' ? 'error' : 'interrupted';
          s.lifecycleSince = at;
          s.unread = true;
        }
      }
      return state;
    }
    case 'attention.opened': {
      const s = state.sessions.get(e.sessionId);
      if (!s) return state;
      state.items.set(e.itemId, {
        id: e.itemId,
        sessionId: e.sessionId,
        projectId: s.projectId,
        source: { provider: s.provider, providerSessionId: s.providerSessionId, generation: state.generation, requestId: e.requestId, turnId: e.turnId },
        type: e.itemType,
        status: 'pending',
        responseCapability: 'live',
        createdAt: at,
        summary: e.summary,
        questions: e.questions,
        allowDecline: e.allowDecline ?? false,
        passive: e.passive ?? false,
        context: e.context ?? null,
        approval: e.approval,
        rawPayloadRef: e.rawPayloadRef,
        response: null,
        acknowledgement: null,
        expiredReason: null,
      });
      if (!e.passive) {
        if (s.lifecycle !== 'waiting_for_user') s.lifecycleSince = at;
        s.lifecycle = 'waiting_for_user';
      }
      s.updatedAt = at;
      return state;
    }
    case 'attention.answer_sent': {
      const item = state.items.get(e.itemId);
      if (item && item.status === 'pending') {
        item.status = 'answering';
        item.response = { answer: e.answer, sentAt: at };
      }
      return state;
    }
    case 'attention.answer_failed': {
      const item = state.items.get(e.itemId);
      if (item && item.status === 'answering') {
        item.status = 'pending';
        item.response = null;
      }
      return state;
    }
    case 'attention.acknowledged': {
      const item = state.items.get(e.itemId);
      if (item && item.status === 'answering') {
        item.status = 'resolved';
        item.acknowledgement = { at, evidence: e.evidence };
        const s = state.sessions.get(item.sessionId);
        const stillWaiting = [...state.items.values()].some((i) => i.sessionId === item.sessionId && i.status === 'pending');
        if (s && s.lifecycle === 'waiting_for_user' && !stillWaiting) {
          s.lifecycle = 'running';
          s.lifecycleSince = at;
        }
      }
      return state;
    }
    case 'session.seen': {
      const s = state.sessions.get(e.sessionId);
      if (s) s.unread = false;
      return state;
    }
    case 'session.archived': {
      const s = state.sessions.get(e.sessionId);
      if (s) {
        s.archived = e.archived;
        if (e.archived) {
          s.usageResume = null;
          s.unread = false;
          expirePassive(state, s.id, '作業を片付けました');
        }
      }
      return state;
    }
    case 'attention.expired': {
      const item = state.items.get(e.itemId);
      if (item && (item.status === 'pending' || item.status === 'answering')) expire(item, e.reason);
      return state;
    }
  }
}

export function fold(events: StoredEvent[]): CoreState {
  const state = emptyState();
  for (const e of events) apply(state, e);
  return state;
}
