// The small language-model jobs Orrery does for the human (naming work, reading a final reply). Each is a short-lived
// helper process, so they run one at a time: a burst of new work must not start a burst of them.
import type { HumanCheck } from '#core';
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

/** Port: whoever can do these jobs (today the Claude adapter, on its cheapest model, without tools). */
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
}

export class Assistant {
  private chain: Promise<void> = Promise.resolve();
  private readonly rt: Runtime;
  readonly model: AssistantModel;

  constructor(rt: Runtime, model: AssistantModel) {
    this.rt = rt;
    this.model = model;
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
