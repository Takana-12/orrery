// Reader: when an agent's reply ends, what state is the work really in, and what does it ask of the human?
//
// A reply that ended is not one thing. It can mean:
//   - the work is done                                   -> nothing to add
//   - "A or B?"                                           -> a question in the inbox, answered as the next message
//   - "A or B? ... and C or D?"                            -> one ticket, one question per decision (picked separately)
//   - "now run X / merge the PR / restart the app"        -> steps for the human (not always phrased as a request)
//   - "... once the tests that are running have passed"   -> a step with a precondition, shown as such
//   - "the tests are running, I will report when done"    -> NOT finished: the agent continues by itself
//   - "update the app and check that X is gone"           -> checks: things to see after one shared action. When the
//                                                            reply leaves them vague ("the two words are gone"), the
//                                                            agent itself is asked (cheapest model) what exactly to look at
//   - "here is what I found" (the human asked to research) -> a report: the reply IS what the human wanted. Nothing is
//                                                            turned into steps or questions, so nothing stands between
//                                                            the human and the agent's own words (see TaskKind)
// None of this arrives as structured data, so the reply is read by a small model (no tools) and the answer is turned
// into core facts. Two moments are read:
//   finished  the turn ended                -> questions and human steps
//   parked    the reply ended but the agent's own background work is still live (the adapter holds the session as
//             running). If the agent is NOT waiting for that work (a dev server it merely left running), the turn is
//             released as finished; otherwise it stays running until the work reports back.
import { TASK_KINDS } from '#core';
import type { AgentSession, AttentionAnswer, AttentionItem, HumanStepInput, TaskKind } from '#core';
import type { Assistant, ClarifySource, ReplyReading } from './assistant.ts';
import type { Journal } from './journal.ts';
import { HttpError } from './errors.ts';
import { message } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';
import type { Sessions } from './sessions.ts';

/** How often a reply is handed to the model before the wording alone decides. */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 20_000;
const NOTHING: ReplyReading = { agentContinues: false, questions: [], steps: [], look: null };

/** Words that plainly hand something to the human. Used only when the model cannot be reached. */
const HANDS_OVER = /してください|して下さい|お願いします|手動で|実行するだけ|が必要です|please (run|restart|merge|deploy|install|check)|you(?:'ll| will)? need to|manually/i;

/** Last resort, without a model: if the reply plainly hands something over, say so; never guess more than that. */
export function fallbackReading(reply: string): ReplyReading {
  const line = reply.split('\n').find((l) => HANDS_OVER.test(l));
  if (!line) return NOTHING;
  return { ...NOTHING, steps: [{ title: '返答を読んで、頼まれている作業をする', detail: `${line.trim().slice(0, 200)}（返答の自動読み取りが使えなかったため、文面からの推定です）`, command: null, after: null }] };
}

/** What the step that brings the change in is called, by how it is brought in. */
const PREP_TITLE = { rebuild: 'アプリを更新する', reload: '画面を再読み込みする', none: '確かめる前の準備をする' } as const;

/**
 * The human's list from a reading: the ordinary steps in order, then the action the things to look at need first (as a
 * step of its own, so it can be ticked and its command run), then each thing to look at as a step of its own.
 */
export function stepsOf(r: ReplyReading): HumanStepInput[] {
  const look = r.look;
  const prep = look && look.checks.length > 0 && (look.update !== 'none' || look.how || look.command)
    ? [{ title: PREP_TITLE[look.update], detail: look.how, command: look.command, after: null, prep: true }]
    : [];
  return [
    ...r.steps.map((x) => ({ title: x.title, detail: x.detail, command: x.command, after: x.after })),
    ...prep,
    ...(look ? look.checks.map((c) => ({ title: c.what, detail: c.where, command: null, after: null, check: { update: look.update, how: look.how, command: look.command } })) : []),
  ];
}

type Mode = 'finished' | 'parked';

export class Reader {
  /** Readings in flight or settled, by `${sessionId}:${mode}:${lifecycleSince}:${reply length}`. */
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  /** The last reading per session, so the same words are not sent to the model twice (parked, then finished). */
  private readonly last = new Map<string, { text: string; reading: ReplyReading }>();
  private readonly rt: Runtime;
  private readonly sessions: Sessions;
  private readonly secrets: Secrets;
  private readonly journal: Journal;
  private readonly assistant: Assistant;
  private readonly retryMs: number;

  constructor(rt: Runtime, sessions: Sessions, secrets: Secrets, journal: Journal, assistant: Assistant, retryMs = RETRY_MS) {
    this.rt = rt;
    this.sessions = sessions;
    this.secrets = secrets;
    this.journal = journal;
    this.assistant = assistant;
    this.retryMs = retryMs;
  }

  /** Called on every state change. */
  onChange(): void {
    const st = this.rt.core.state;
    for (const s of st.sessions.values()) {
      if (s.archived) continue;
      if (s.lifecycle === 'turn_finished') {
        const t = st.tasks.get(s.taskId);
        // Already read (also across restarts), or more instructions are about to be sent: nothing to read now.
        if (!t || t.readTurn === s.lifecycleSince || this.sessions.hasDeferred(s.id)) continue;
        this.read(s, 'finished');
      } else if (s.lifecycle === 'running' && s.awaitingBackground) {
        this.read(s, 'parked');
      }
    }
  }

  private read(s: AgentSession, mode: Mode): void {
    const key = `${s.id}:${mode}:${s.lifecycleSince}:${(s.lastText ?? '').length}:${this.pinnedKind(s) ?? 'auto'}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    // Everything the agent wrote since the human last spoke: what is asked of the human is not always in the last message.
    const text = this.rt.store.turnReplies(s.id) || s.lastText || '';
    if (text.trim().length < 8) return this.apply(s, mode, text, NOTHING);
    const use = (r: ReplyReading) => {
      this.last.set(s.id, { text, reading: r });
      // Things to look at that the reply left vague: ask the agent what exactly, before they reach the human. A report
      // shows no checks, so nothing is asked for it.
      if (mode === 'finished' && r.look?.unclear.length && this.kindOf(s, r) !== 'report') return this.clarify(s, r, (sharp) => use(sharp));
      this.apply(s, mode, text, r);
    };
    const known = this.last.get(s.id);
    if (known?.text === text) return use(known.reading);
    this.assistant.queue(
      (m) => m.readFinalReply(text, { background: s.background ?? [], request: this.rt.store.lastRequest?.(s.id) || null }),
      (r) => {
        if (this.rt.closing) return;
        if (r) return use(r);
        const n = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, n);
        if (n < MAX_ATTEMPTS) {
          // Try again later; until then the turn simply shows as finished and unread.
          setTimeout(() => {
            this.seen.delete(key);
            if (!this.rt.closing) this.onChange();
          }, this.retryMs * n).unref();
        } else if (mode === 'finished') {
          this.apply(s, mode, text, fallbackReading(text));
        }
        // parked and unreadable: it stays "running"; the human can release it by hand.
      },
    );
  }

  /** Ask the agent (forked, cheapest model) or its record what the vague checks mean exactly. Unanswered: kept as read. */
  private clarify(s: AgentSession, r: ReplyReading, then: (r: ReplyReading) => void): void {
    const look = r.look!;
    const now = this.rt.core.state.sessions.get(s.id) ?? s;
    const source: ClarifySource = {
      fork: now.provider === 'claude' && now.providerSessionId ? { providerSessionId: now.providerSessionId, cwd: now.cwd } : null,
      record: this.rt.store.readTranscript(s.id, 300).map((e) => `[${e.role}] ${e.text}`).join('\n'),
    };
    this.journal.write(s.id, 'system', `確認する項目のうち、返答からは分からないことをエージェントに聞いています: ${look.unclear.join(' / ')}`);
    this.assistant.queue(
      (m) => m.clarifyChecks({ checks: look.checks, unclear: look.unclear, source }),
      (checks) => {
        if (this.rt.closing) return;
        if (!checks) this.journal.write(s.id, 'system', '確認する項目を具体的にできませんでした。返答から読み取った形のまま出します。');
        // Asked once either way: what could not be made exact is shown as it was read.
        then({ ...r, look: { ...look, checks: checks ?? look.checks, unclear: [] } });
      },
    );
  }

  private apply(read: AgentSession, mode: Mode, text: string, r: ReplyReading): void {
    const { core, store } = this.rt;
    const redact = this.secrets.redact;
    const now = core.state.sessions.get(read.id);
    if (!now || now.archived) return;
    if (mode === 'parked') {
      if (now.lifecycle !== 'running' || !now.awaitingBackground || r.agentContinues) return;
      // The agent is not waiting for what it left running (a dev server, a watcher): its reply is the finished turn.
      this.journal.write(read.id, 'system', 'バックグラウンドの作業は動いたままですが、エージェントはその終了を待っていないので、返答は完了として扱います。');
      this.rt.adapters[now.provider].finishTurn?.(read.id);
      return;
    }
    if (now.lifecycle !== 'turn_finished' || now.lifecycleSince !== read.lifecycleSince) return;
    core.replyRead(read.id, read.lifecycleSince);
    // What the human wants back, as this reply tells it (unless the human said so themself).
    if (typeof r.report === 'boolean') core.setTaskKind(read.id, r.report ? 'report' : 'work', false);
    // A report is read as it was written: its words are not turned into a list of steps or questions.
    if (this.kindOf(now, r) === 'report') return;
    const steps = stepsOf(r);
    if (steps.length) {
      core.setHumanSteps(read.id, steps.map((x) => ({
        ...x,
        title: redact(x.title),
        detail: x.detail && redact(x.detail),
        after: x.after && redact(x.after),
        ...(x.check ? { check: { ...x.check, how: x.check.how && redact(x.check.how) } } : {}),
      })));
    }
    if (r.questions.length) {
      const questions = r.questions.map((q, i) => ({
        id: questionId(i),
        header: null,
        text: redact(q.text),
        multiSelect: q.multiSelect,
        allowFreeText: true,
        isSecret: false,
        options: q.options.map((o) => ({ label: redact(o.label), description: o.description && redact(o.description) })),
      }));
      core.attentionOpen({
        sessionId: read.id,
        requestId: `final:${read.lifecycleSince}`,
        type: 'user_question',
        summary: questions.map((q) => q.text).join(' / '),
        allowDecline: true,
        passive: true,
        questions,
        context: redact(text).slice(-6000),
        rawPayloadRef: store.saveRaw(read.id, { source: 'エージェントの最終返答から読み取った質問', reply: redact(text) }),
      });
    }
  }

  /** The kind the human chose for the work, if they did. */
  private pinnedKind(s: AgentSession): TaskKind | null {
    const t = this.rt.core.state.tasks.get(s.taskId);
    return t?.kindPinned ? t.kind : null;
  }

  /** The kind that decides how a reading is used: the human's choice, else what the reading says, else what it was. */
  private kindOf(s: AgentSession, r: ReplyReading): TaskKind {
    const t = this.rt.core.state.tasks.get(s.taskId);
    if (t?.kindPinned && t.kind) return t.kind;
    if (typeof r.report === 'boolean') return r.report ? 'report' : 'work';
    return t?.kind ?? 'work';
  }

  /**
   * The human says what the work is. From then on replies are no longer classified for it. A reply already read is
   * shown the new way at once: as a report, its steps and the questions read from it go; as work, the same reading is
   * applied again (from memory when the words have not changed, so no model is asked).
   */
  setKind(sessionId: string, kind: unknown): void {
    const { core } = this.rt;
    const s = core.state.sessions.get(sessionId);
    if (!s) throw new HttpError(404, '作業が見つかりません');
    if (!TASK_KINDS.includes(kind as TaskKind)) throw new HttpError(400, '作業の種類が不正です');
    const t = core.state.tasks.get(s.taskId)!;
    const was = t.kind;
    core.setTaskKind(sessionId, kind as TaskKind, true);
    if (was === kind || s.lifecycle !== 'turn_finished' || t.readTurn !== s.lifecycleSince) return;
    if (kind === 'report') {
      if (t.humanSteps) core.setHumanSteps(sessionId, null);
      core.attentionWithdrawn(sessionId, `final:${s.lifecycleSince}`, '調査の作業として、返答をそのまま読むことにしました');
      return;
    }
    // onChange reads it again, as work (whatever was read for this turn before is no longer "seen").
    for (const k of this.seen) if (k.startsWith(`${sessionId}:finished:`)) this.seen.delete(k);
    core.forgetReading(sessionId);
  }

  /** The human answered a question that was read from a reply: the agent asked in prose, so the answer goes back as an ordinary message. */
  deliver(item: AttentionItem, answer: AttentionAnswer): void {
    if (answer.kind !== 'answers') return; // closed without an answer
    const text = answerMessage(item, answer.answers);
    void this.sessions.send(item.sessionId, text).catch((e) => this.rt.core.sessionUpdate(item.sessionId, { error: `回答を送れませんでした: ${message(e)}` }));
  }
}

/** The answer key of the i-th question read from a reply. The first keeps the name single questions always had. */
const questionId = (i: number) => (i === 0 ? 'answer' : `answer-${i + 1}`);

/**
 * The message an answer to a question read from a reply becomes. One question: just the answer, as the human would
 * type it. Several: each answer under its own question, so the agent knows which decision it settles.
 */
export function answerMessage(item: Pick<AttentionItem, 'questions'>, answers: Record<string, string[]>): string {
  const qs = (item.questions ?? []).filter((q) => answers[q.id]?.length);
  const said = (id: string) => answers[id]!.join('、');
  if ((item.questions ?? []).length <= 1) return qs[0] ? said(qs[0].id) : '';
  return qs.map((q) => `「${q.text}」→ ${said(q.id)}`).join('\n');
}
