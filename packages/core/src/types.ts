// Domain types. Task != Turn != Session != Process: each has its own state and none is inferred from another.

export type ProviderId = 'claude' | 'codex';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  /** New work in this project gets a git worktree of its own unless the human says otherwise. Default on. */
  useWorktree: boolean;
  /** Put at the head of the first message of every new session in this project (after the app-wide one). Empty = none. */
  preamble: string;
}

/** What the human wants achieved. Completion is judged against this, not against "the agent stopped talking". */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  acceptanceCriteria: string | null;
  createdAt: number;
  /** Command the control room runs itself after each turn to check the work (e.g. `npm test`). Null = no automatic check. */
  checkCommand: string | null;
  /** Hand a failed check back to the agent automatically (bounded by MAX_FIX_ROUNDS). */
  autoFix: boolean;
  fixRounds: number;
  /** Result of the check for the CURRENT state of the work. Cleared as soon as the agent starts working again. */
  validation: TaskValidation | null;
  validating: boolean;
  /** The human accepted the task as done. Only a human sets this. */
  acceptedAt: number | null;
  /** What is left for the human once the agent has done everything it can. Finishing these finishes the task. */
  humanSteps: HumanStep[] | null;
  /**
   * `lifecycleSince` of the finished turn whose final reply was already read for questions / human steps.
   * Recorded so a restart does not read the same reply again (and reset the steps the human already ticked).
   */
  readTurn: number | null;
}

export interface HumanStep {
  title: string;
  detail: string | null;
  /** A command the agent asked the human to run, verbatim, if the step is one. */
  command: string | null;
  /** What has to happen first, in the agent's words ("テストが通ったら", "after CI is green"). Null: can be done now. */
  after?: string | null;
  /** Set when the step is something to look at once the change is brought in (see HumanCheck). Null: an ordinary step. */
  check?: HumanCheck | null;
  done: boolean;
  /** The last time the human ran this step's command from Orrery, and what reading its output concluded. */
  run?: HumanStepRun | null;
}

/**
 * A step's command run by the human's click. `running` -> `reading` (its output is being read for what is left)
 * -> `settled`. A run that was in flight when the server stopped is settled at the next start.
 */
export interface HumanStepRun {
  /** Chosen by whoever asked for the run, so a screen can tell its own run from an older one. */
  id: string;
  phase: 'running' | 'reading' | 'settled';
  at: number;
  ok: boolean | null;
  exitCode: number | null;
  outputTail: string | null;
  /** What reading the output concluded, in one or two sentences for the human. */
  note: string | null;
}

/** A step as an agent's reply (or a command's output) describes it, before it is on the list. */
export interface HumanStepInput {
  title: string;
  detail: string | null;
  command: string | null;
  after?: string | null;
  check?: HumanCheck | null;
}

/**
 * A step that is something to see with one's own eyes, after one shared action (bring the change into the app).
 * Several pieces of work in the same project usually leave the same action and differ only in what to look at, so the
 * inbox lists them as one action with one checklist. The step's title says what must be true (with the exact words),
 * its detail where to look.
 */
export interface HumanCheck {
  /** What brings the change in first: rebuild / restart the app, reload the page, or nothing. */
  update: 'rebuild' | 'reload' | 'none';
  /** How to do that, in the agent's words, when it said. */
  how: string | null;
  /** The command for it, verbatim from the reply, when there is one. */
  command: string | null;
}

/** Evidence, not opinion: what was run, how it exited, what it printed. */
export interface TaskValidation {
  command: string;
  ok: boolean;
  exitCode: number | null;
  outputTail: string;
  at: number;
  /** Files with uncommitted changes in the working folder, or null when it is not a git repository. */
  uncommittedFiles: number | null;
}

export const MAX_FIX_ROUNDS = 2;

export interface Settings {
  /** How many sessions may be working (or waiting on the human) at once; the rest queue. */
  maxConcurrent: number;
  /** Do not start queued work while free physical memory is below this. 0 = ignore memory. */
  minFreeMemoryMB: number;
  /** Ask before running a command the agent asked the human to run. Turned off from the confirmation itself. */
  confirmCommands: boolean;
  /** Put at the head of the first message of every new session, whatever the project or agent. Empty = nothing. */
  preamble: string;
  /** What a new side chat talks to unless the human picks something else in it. */
  sideChat: SideChatModel;
}

/** One AI for the side chat: the agent, its model ('' = the agent's own default) and how hard it thinks ('' = default). */
export interface SideChatModel {
  provider: ProviderId;
  model: string;
  effort: string;
}

/**
 * turn finished != task done. This is what the evidence supports:
 *  working: the agent is (or should be) still on it     validating: the check is running
 *  needs_fix: the check failed                           candidate: the check passed, waiting for the human to accept
 *  unverified: the turn ended and there is no check      accepted: the human accepted it
 */
export type Completion = 'working' | 'validating' | 'needs_fix' | 'human_steps' | 'candidate' | 'unverified' | 'accepted';

export function completionOf(task: Task, session: AgentSession): Completion {
  if (task.acceptedAt !== null) return 'accepted';
  if (task.validating) return 'validating';
  if (session.lifecycle !== 'turn_finished') return 'working';
  if (task.validation && !task.validation.ok) return 'needs_fix';
  if (task.humanSteps?.some((s) => !s.done)) return 'human_steps'; // the agent is finished; the rest is the human's
  if (task.validation) return 'candidate';
  return 'unverified';
}

export type SessionLifecycle =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'turn_finished' // the agent's reply ended. NOT the same as the task being done.
  | 'interrupted'
  | 'error'
  | 'unknown'; // no evidence of the real state; shown as "状況不明", never guessed

/**
 * Who decides on the agent's permission requests:
 *  ask   - the human, every time (the inbox)
 *  edits - file edits are accepted automatically, everything else asks (Claude Code "acceptEdits")
 *  auto  - the provider's own reviewer decides and only escalates what it will not approve itself
 *          (Claude Code "auto" mode, Codex "auto_review")
 */
export type ApprovalMode = 'ask' | 'edits' | 'auto';

export type ProcessState = 'not_started' | 'alive' | 'stopping' | 'stopped' | 'crashed';
export type Resumability = 'resumable' | 'unknown' | 'unrecoverable';

export interface AgentSession {
  id: string;
  projectId: string;
  taskId: string;
  provider: ProviderId;
  cwd: string;
  /** Claude session id / Codex thread id. Null until the provider reports it. */
  providerSessionId: string | null;
  model: string | null;
  lifecycle: SessionLifecycle;
  process: ProcessState;
  resumability: Resumability;
  /** Core generation in which this session's provider process was last known to be alive. */
  generation: number;
  createdAt: number;
  updatedAt: number;
  lastText: string | null;
  lastTurnOutcome: 'completed' | 'interrupted' | 'failed' | null;
  error: string | null;
  /** What the human chose when starting it; reused when the session is resumed in a new process. */
  requestedModel: string | null;
  effort: string | null;
  approvalMode: ApprovalMode;
  /** When the current lifecycle state began (for "running for 4 min"). */
  lifecycleSince: number;
  /** A turn ended (or failed) and the human has not opened the session since. */
  unread: boolean;
  /** Logical, reversible tidy-up: hidden from the working lists, nothing is deleted. */
  archived: boolean;
  /** Work the agent left running in the background (shells, subagents), as the provider describes it. Null: none known. */
  background: string[] | null;
  /**
   * The agent's reply ended, but it is waiting for its own background work and will continue by itself when that
   * reports back. Shown as still running: this is not a finished turn.
   */
  awaitingBackground: boolean;
}

export interface QuestionOption {
  label: string;
  description: string | null;
}

export interface Question {
  /** Key the provider expects the answer under (Claude: question text, Codex: question id). */
  id: string;
  header: string | null;
  text: string;
  multiSelect: boolean;
  allowFreeText: boolean;
  isSecret: boolean;
  /** May be left unanswered (form fields that the provider did not mark as required). */
  optional?: boolean;
  options: QuestionOption[];
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalRequest {
  tool: string;
  /** The exact thing being approved, shown in full: command line, patch summary, ... */
  subject: string | null;
  cwd: string | null;
  reason: string | null;
  /** Decisions the provider says are valid for this request, in display order. */
  decisions: ApprovalDecision[];
  /** For file edits: what would change, per file. `diff` is diff-like text (lines starting with + or -). */
  changes?: FileChange[] | null;
}

export interface FileChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
  diff: string;
}

export type AttentionType = 'user_question' | 'permission_approval' | 'error_requires_action' | 'completion_review';

export type AttentionStatus =
  | 'pending' // waiting for the human
  | 'answering' // answer handed to the provider; provider has not confirmed
  | 'resolved' // provider confirmed
  | 'expired'; // can no longer be answered

export interface AttentionSource {
  provider: ProviderId;
  providerSessionId: string | null;
  /** Provider request ids are only unique within one provider process lifetime, so the generation is part of the key. */
  generation: number;
  requestId: string;
  turnId: string | null;
}

export type AttentionAnswer =
  | { kind: 'answers'; answers: Record<string, string[]> }
  /** Refuse to answer a form the provider allows to be declined (MCP elicitation). */
  | { kind: 'decline' }
  | { kind: 'decision'; decision: ApprovalDecision; message?: string };

export interface AttentionItem {
  id: string;
  sessionId: string;
  projectId: string;
  source: AttentionSource;
  type: AttentionType;
  status: AttentionStatus;
  /** 'live': answerable only while the originating provider process is alive (true for both providers today). */
  responseCapability: 'live' | 'not_resumable';
  createdAt: number;
  summary: string;
  questions: Question[] | null;
  /** True when the human may refuse to answer (MCP elicitation). Plain agent questions cannot be declined. */
  allowDecline: boolean;
  /**
   * No provider is blocked on this request: it was read from a finished reply, and is answered by sending the answer
   * as the next message. It therefore survives the agent's process and a restart of the control room.
   */
  passive: boolean;
  approval: ApprovalRequest | null;
  /** Id of the stored raw provider payload, for the "show me the evidence" drill-down. */
  rawPayloadRef: string | null;
  response: { answer: AttentionAnswer; sentAt: number } | null;
  acknowledgement: { at: number; evidence: string } | null;
  expiredReason: string | null;
}

export interface CoreState {
  generation: number;
  settings: Settings;
  projects: Map<string, Project>;
  tasks: Map<string, Task>;
  sessions: Map<string, AgentSession>;
  items: Map<string, AttentionItem>;
}
