// The small language-model jobs Orrery does for the human (naming work, reading a final reply). Each is a short-lived
// helper process, so they run one at a time: a burst of new work must not start a burst of them.
import type { HumanCheck, ProviderId, SideChatModel } from '#core';
import type { PreferenceReader } from '../../../provider-shared/src/preferences.ts';
import type { VoicePlanInput, VoicePlanner, VoiceTask, VoiceTidyInput } from '../../../provider-shared/src/voice-plan.ts';
import type { Runtime } from './runtime.ts';

/** One thing the human looks at, once the change is in: what must be true (with the exact words), and where. */
export interface CheckItem {
  what: string;
  where: string | null;
}

/** What the human has to look at with their own eyes, and the one action that comes before it. */
export interface LookReading extends HumanCheck {
  checks: CheckItem[];
  /** What the reply leaves too vague to check by (which words, which screen, what it looked like before). */
  unclear: string[];
}

export interface ReplyReading {
  /** The agent says it is waiting for its own background work and will carry on by itself when that ends. */
  agentContinues: boolean;
  question: { text: string; options: { label: string; description: string | null }[] } | null;
  /** What only the human can do. `after`: what has to happen first, if the reply names a precondition. */
  steps: { title: string; detail: string | null; command: string | null; after: string | null }[];
  /** Things to see for oneself after bringing the change in. Null: nothing to look at. */
  look: LookReading | null;
}

/** Where to find out what the reply left vague: the agent's own conversation (forked, not continued), or its record. */
export interface ClarifySource {
  /** Claude: the provider's session to fork, in the folder it ran in. */
  fork: { providerSessionId: string; cwd: string } | null;
  /** Any agent: what it said and did, most recent last. */
  record: string;
}

/** What a command the human ran (for one of their steps) leaves for them. */
export interface CommandReading {
  /** The step is done: the command did what the step was for. */
  done: boolean;
  /** One or two sentences for the human on what the output says. */
  note: string | null;
  /** What the human still has to do because of what the output says, in order. Done: after the step. Not done: instead of it. */
  steps: { title: string; detail: string | null; command: string | null; after: string | null }[];
}

/** One area of the human's preferences, as the helper model is shown it. */
export interface DomainBrief {
  id: string;
  name: string;
  description: string;
}

/** An area of preferences a helper model wants made. `key` is what the rest of its answer calls it by (in place of an id). */
export interface NewDomain {
  key: string;
  name: string;
  description: string;
}

/** Standing preferences read from what the human said. `domainId`: an area's id, or the key of one in `newDomains`. */
export interface PreferenceReading {
  newDomains: NewDomain[];
  add: { domainId: string; text: string; scope: 'all' | 'project' }[];
  /** A section rewritten as a whole; optional for older helper transports. */
  update?: { id: string; text: string | null; domainId: string | null }[];
  /** Ids of preferences already recorded that came up again. */
  reinforce: string[];
}

/**
 * What the こだわり chat makes of one message: a short reply and the changes to the record. Area fields hold an area's
 * id or the key of one in `newDomains`; `scope` is 'all' or a project's id.
 */
export interface TuneReading {
  reply: string;
  newDomains: NewDomain[];
  add: { domainId: string; text: string; scope: string }[];
  /** Rewrites (full text) and moves of preferences already recorded. */
  update: { id: string; text: string | null; domainId: string | null }[];
  remove: string[];
  reinforce: string[];
}

export interface TuneInput {
  message: string;
  /** The conversation so far, oldest first (bounded). */
  history: { role: 'human' | 'ai'; text: string }[];
  domains: DomainBrief[];
  entries: { id: string; domainId: string; text: string; scope: string }[];
  projects: { id: string; name: string }[];
  otherDomainId: string;
  /** How many more areas may be made. */
  domainsLeft: number;
}

export type PreferenceModel = Pick<PreferenceReader, 'extractPreferences' | 'tunePreferences'>;
/** What either provider can be asked as a helper with the human's chosen model: preferences, and voice requests. */
export type HelperModel = PreferenceModel & { planVoice?: VoicePlanner['plan']; tidyVoice?: VoicePlanner['tidy'] };

/** Port: small helper jobs. Preferences can use either provider and the human's chosen model. */
export interface AssistantModel {
  generateTitle(instruction: string): Promise<string | null>;
  /** Null when the reply could not be read (no sign-in, time-out, unusable answer). */
  readFinalReply(reply: string, context: { background: string[] }): Promise<ReplyReading | null>;
  /** Null when the output could not be read. */
  readCommandResult(input: { step: { title: string; detail: string | null }; command: string; ok: boolean; exitCode: number | null; output: string; laterSteps: string[] }): Promise<CommandReading | null>;
  /**
   * Make the checks exact where the reply was vague, by asking the agent itself (on the cheapest model).
   * Null when that could not be done: the checks stay as they were.
   */
  clarifyChecks(input: { checks: CheckItem[]; unclear: string[]; source: ClarifySource }): Promise<CheckItem[] | null>;
  /** Null when what was said could not be read. */
  extractPreferences: PreferenceModel['extractPreferences'];
  /** The こだわり chat's reading of one message. Null when it could not be read. */
  tunePreferences: PreferenceModel['tunePreferences'];
  /** Which areas bear on new work. Null when that could not be decided; `signal` gives up on it. */
  routeKnowledge(input: { prompt: string; domains: DomainBrief[] }, signal?: AbortSignal): Promise<string[] | null>;
}

export class Assistant {
  private chain: Promise<void> = Promise.resolve();
  private readonly rt: Runtime;
  readonly model: AssistantModel;
  private readonly preferenceModels: Partial<Record<ProviderId, HelperModel>>;

  constructor(rt: Runtime, model: AssistantModel, preferenceModels: Partial<Record<ProviderId, HelperModel>> = { claude: model }) {
    this.rt = rt;
    this.model = model;
    this.preferenceModels = preferenceModels;
  }

  extractPreferences(input: Parameters<PreferenceModel['extractPreferences']>[0], choice: SideChatModel): Promise<PreferenceReading | null> {
    return this.preferenceModels[choice.provider]?.extractPreferences(input, choice) ?? Promise.resolve(null);
  }

  tunePreferences(input: TuneInput, choice: SideChatModel): Promise<TuneReading | null> {
    return this.preferenceModels[choice.provider]?.tunePreferences(input, choice) ?? Promise.resolve(null);
  }

  /** Voice input: split what was said into pieces of work. Not queued: the human is waiting in front of it. */
  planVoice(input: VoicePlanInput, choice: SideChatModel): Promise<{ tasks: VoiceTask[] } | null> {
    return this.preferenceModels[choice.provider]?.planVoice?.(input, choice) ?? Promise.resolve(null);
  }

  /** A spoken reply with English put back into English. Null when it could not be done (what was heard is used). */
  tidyVoice(input: VoiceTidyInput, choice: SideChatModel): Promise<string | null> {
    return this.preferenceModels[choice.provider]?.tidyVoice?.(input, choice) ?? Promise.resolve(null);
  }

  /** Run `job` after the ones already waiting, then hand its result to `then`. Problems are swallowed: these jobs must never get in the way of the work itself. */
  queue<T>(job: (model: AssistantModel) => Promise<T>, then: (result: T | null) => void): void {
    this.chain = this.chain
      .then(() => (this.rt.closing ? null : job(this.model)))
      .catch(() => null)
      .then(then)
      .catch(() => {});
  }
}
