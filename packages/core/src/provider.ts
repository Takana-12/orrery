// The boundary between the core and a provider (Claude, Codex, later ACP or a hooks bridge).
// Adapters translate provider-native events into these calls and never decide policy.
import type { ControlCore, OpenAttention } from './core.ts';
import type { ApprovalMode, ProviderId } from './types.ts';

/** Differences between providers are reported honestly and shown in the UI, not papered over. */
export interface ProviderCapabilities {
  structuredQuestions: 'yes' | 'plan_mode_only' | 'no';
  multiSelectQuestions: boolean;
  denyWithMessage: boolean;
  resume: 'verified' | 'unverified' | 'no';
  /** How the provider confirms that an answer landed. */
  acknowledgement: string;
  processModel: 'one_process_per_session' | 'shared_process';
}

/** What an adapter is allowed to tell the core. A subset of ControlCore, so adapters cannot issue UI commands. */
export type ProviderSink = Pick<ControlCore, 'sessionUpdate' | 'attentionAcknowledged' | 'attentionWithdrawn'> & {
  attentionOpen(input: OpenAttention): string;
  /** Store a raw provider payload for drill-down; returns its reference id. */
  saveRaw(sessionId: string, body: unknown): string;
  /** Append to the session's transcript (assistant text, tool activity). */
  transcript(sessionId: string, entry: { role: 'user' | 'assistant' | 'tool' | 'system'; text: string }): void;
  /** Tokens one finished turn consumed, as reported by the provider. */
  usage(sessionId: string, usage: TurnUsage): void;
  /** A provider's account-wide or model-specific windows changed (may be a sparse update). */
  usageLimits(provider: ProviderId, limits: UsageLimit[]): void;
  /** This turn was rejected by a plan limit, before its terminal sessionUpdate. */
  usageBlocked(sessionId: string): void;
  /** Called with the root pid of a provider process as soon as it exists, so the host can take ownership of it. */
  processSpawned(owner: { provider: ProviderId; sessionId: string | null }, pid: number): void;
};

export interface StartSessionRequest {
  sessionId: string;
  cwd: string;
  prompt: string;
  model?: string | null;
  /** Codex only: plan mode is currently the only mode in which the model may ask structured questions. */
  planMode?: boolean;
  /** What the transcript shows as the human's first message when `prompt` carries more (the standing preamble). */
  shownPrompt?: string;
  /** Provider session to continue (Claude session id / Codex thread id). */
  resumeProviderSessionId?: string | null;
  /** Who decides on permission requests. Default: the human. */
  approvalMode?: ApprovalMode;
  /** Reasoning effort for this session (provider's own level name). */
  effort?: string | null;
  /** Folders outside `cwd` the agent may read without asking (files the human attached to a message). */
  readDirs?: string[];
  /** Project environment variables (already decrypted) for the agent's commands. Never logged by adapters. */
  env?: Record<string, string>;
  /**
   * A side chat: a plain conversation with no workspace and no project settings. The agent may look things up
   * (read a file it was given, search the web) but has no tool that changes anything, and never asks the human.
   */
  chat?: boolean;
}

export interface ModelChoice {
  /** Value to pass as `model` when starting a session. */
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  /** Reasoning-effort levels this model accepts, weakest first. Empty/absent: effort cannot be chosen. */
  efforts?: string[];
  defaultEffort?: string | null;
}

/** Options for a follow-up turn; the conversation and its model stay the same. */
export interface MessageOptions {
  effort?: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  /** Plan / account type as the provider names it (e.g. "max", "plus"). */
  plan: string | null;
  method: string | null;
}

/** One rate-limit window as the provider reports it. */
export interface UsageLimit {
  /** Null / absent: shared by all models of this provider. Otherwise a model id or Claude family. */
  model?: string | null;
  label: string;
  /** Which window this is, so a compact view can pick the 5-hour and the weekly one. */
  kind?: 'five_hour' | 'weekly' | 'other';
  /** 0-100, or null when the provider only reports a state (see `state`). */
  usedPercent: number | null;
  resetsAt: number | null;
  /** Provider's own verdict when it gives no percentage: within the limit, close to it, or over it. */
  state?: 'ok' | 'warning' | 'reached';
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  capabilities(): ProviderCapabilities;
  /** Models this provider offers to the logged-in account, straight from the provider. */
  listModels(): Promise<ModelChoice[]>;
  /** Is the provider's own CLI signed in on this machine? Never reads credentials: asks the official binary. */
  authStatus(): Promise<AuthStatus>;
  /** Start the provider's official sign-in flow. `url`: a page the human must open in a browser (if the provider did not open it itself). */
  startLogin(): Promise<{ url?: string }>;
  /** Current rate-limit windows, as far as the provider tells us. */
  limits(): Promise<UsageLimit[]>;
  /** Start a new provider session, or resume one, and run the first turn with `prompt`. */
  startSession(req: StartSessionRequest): Promise<void>;
  /** Send a follow-up message to a live session. */
  sendMessage(sessionId: string, text: string, options?: MessageOptions): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Release the session's process (if it has its own). The conversation stays resumable. */
  stop(sessionId: string): Promise<void>;
  /** True if the adapter still holds this session in memory (can receive sendMessage). */
  isLive(sessionId: string): boolean;
  /**
   * Stop holding a session as "running" for its background work: report the reply that already ended as the
   * finished turn. Returns false when the session was not waiting. Only for providers that report background work.
   */
  finishTurn?(sessionId: string): boolean;
  shutdown(): Promise<void>;
}
