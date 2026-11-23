// Append-only events: the single source of truth. All state is a fold over these, so it can be rebuilt after a crash.
// Never put secret values in an event.
import type {
  ApprovalMode,
  ApprovalRequest,
  AttentionAnswer,
  AttentionType,
  ProcessState,
  ProviderId,
  Question,
  Resumability,
  SessionLifecycle,
  Settings,
  TaskValidation,
  HumanStepInput,
} from './types.ts';

export type CoreEvent =
  | { type: 'core.started'; generation: number }
  | { type: 'project.added'; projectId: string; name: string; rootPath: string }
  | { type: 'project.renamed'; projectId: string; name: string }
  | { type: 'project.options_changed'; projectId: string; useWorktree?: boolean; preamble?: string }
  | { type: 'task.created'; taskId: string; projectId: string; title: string; acceptanceCriteria: string | null; checkCommand?: string | null; autoFix?: boolean }
  | { type: 'task.renamed'; taskId: string; title: string }
  | { type: 'task.validation_started'; taskId: string }
  | { type: 'task.validation_cancelled'; taskId: string }
  | { type: 'task.validated'; taskId: string; validation: TaskValidation }
  | { type: 'task.fix_requested'; taskId: string }
  | { type: 'task.accepted'; taskId: string; accepted: boolean }
  | { type: 'task.human_steps'; taskId: string; steps: HumanStepInput[] | null }
  | { type: 'task.reply_read'; taskId: string; turn: number }
  | { type: 'task.human_step_done'; taskId: string; index: number; done: boolean }
  /** A step's command started (`ok` null) or ended; while ended and not yet settled, its output is being read. */
  | { type: 'task.human_step_ran'; taskId: string; index: number; command: string; runId: string; ok?: boolean | null; exitCode?: number | null; outputTail?: string | null }
  /**
   * What the command's output says is left. done: the step is done, and `steps` follow it. Not done: `steps` (if any)
   * take its place, being what still has to happen instead; with none, the step stays as it was, with the note.
   */
  | { type: 'task.human_step_settled'; taskId: string; index: number; command: string; runId: string; done: boolean; note: string | null; steps: HumanStepInput[] }
  | { type: 'settings.changed'; settings: Partial<Settings> }
  | { type: 'session.created'; sessionId: string; projectId: string; taskId: string; provider: ProviderId; cwd: string; model?: string | null; effort?: string | null; approvalMode?: ApprovalMode }
  | {
      type: 'session.updated';
      sessionId: string;
      patch: Partial<{
        providerSessionId: string;
        model: string;
        lifecycle: SessionLifecycle;
        process: ProcessState;
        resumability: Resumability;
        lastText: string;
        lastTurnOutcome: 'completed' | 'interrupted' | 'failed';
        error: string | null;
        background: string[] | null;
        awaitingBackground: boolean;
      }>;
    }
  | {
      type: 'attention.opened';
      itemId: string;
      sessionId: string;
      requestId: string;
      turnId: string | null;
      itemType: AttentionType;
      summary: string;
      questions: Question[] | null;
      approval: ApprovalRequest | null;
      rawPayloadRef: string | null;
      allowDecline?: boolean;
      /** The provider is not blocked on this request (it was read from a finished reply): do not mark the session as waiting. */
      passive?: boolean;
    }
  | { type: 'session.seen'; sessionId: string }
  | { type: 'session.archived'; sessionId: string; archived: boolean }
  | { type: 'attention.answer_sent'; itemId: string; answer: AttentionAnswer }
  | { type: 'attention.answer_failed'; itemId: string; error: string }
  | { type: 'attention.acknowledged'; itemId: string; evidence: string }
  | { type: 'attention.expired'; itemId: string; reason: string };

export interface StoredEvent {
  seq: number;
  at: number;
  event: CoreEvent;
}

/** Persistence port. The SQLite implementation lives in the server package; tests use the in-memory one. */
export interface EventStore {
  append(at: number, event: CoreEvent): StoredEvent;
  readAll(): StoredEvent[];
}

export class MemoryEventStore implements EventStore {
  private events: StoredEvent[] = [];
  constructor(initial: StoredEvent[] = []) {
    this.events = [...initial];
  }
  append(at: number, event: CoreEvent): StoredEvent {
    const stored = { seq: this.events.length + 1, at, event };
    this.events.push(stored);
    return stored;
  }
  readAll(): StoredEvent[] {
    return [...this.events];
  }
}
