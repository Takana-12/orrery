// The こだわり chat: a conversation whose only job is to keep the human's standing preferences up to date. The human
// pastes in instructions, prompts or wishes; nothing is carried out. A helper model reads the intent and answers with
// changes to the record (new areas, additions, rewrites, merges, moves, removals), which are made at once through
// Knowledge.apply() and listed under its reply. Changes made here count as looked at (the human is watching them).
//  send()   records the human's message and answers at once; the reading runs after, one message at a time.
//  view()   the conversation (bounded) and whether a reading is under way, for the snapshot.
// The conversation is kept in the store's transcript under one fixed id, so it survives a restart.
import { KNOWLEDGE_LIMITS, OTHER_DOMAIN_ID } from '#core';
import type { SideChatModel } from '#core';
import { randomUUID } from 'node:crypto';
import type { Assistant } from './assistant.ts';
import { HttpError } from './errors.ts';
import type { Knowledge, KnowledgeChange } from './knowledge.ts';
import type { Runtime } from './runtime.ts';

/** The transcript id the conversation is kept under. Not a session's: nothing of the work's lists can see it. */
export const TUNE_LOG_ID = 'knowledge-tune';
/** Characters in one message. */
export const TUNE_MESSAGE_MAX = 12_000;
/** Messages kept in memory and shown. */
const SHOWN = 80;
/** Messages of the conversation so far given to the helper model with a new one. */
const HISTORY = 8;

export interface TuneMessage {
  id: string;
  role: 'human' | 'ai';
  text: string;
  at: number;
  /** What the reading changed (ai messages). */
  changes?: KnowledgeChange[];
  /** The reading could not be done (ai messages). */
  failed?: boolean;
}

export class KnowledgeTune {
  private readonly rt: Runtime;
  private readonly knowledge: Knowledge;
  private readonly assistant: Assistant;
  private readonly redact: (text: string) => string;
  private messages: TuneMessage[] = [];
  /** Messages waiting for, or under, a reading. */
  private waiting = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(rt: Runtime, knowledge: Knowledge, assistant: Assistant, redact: (text: string) => string) {
    this.rt = rt;
    this.knowledge = knowledge;
    this.assistant = assistant;
    this.redact = redact;
    try {
      this.messages = rt.store.readTranscript(TUNE_LOG_ID, SHOWN).map((r) => {
        if (r.role === 'human') return { id: `s${r.seq}`, role: 'human' as const, text: r.text, at: r.at };
        let body: { reply?: string; changes?: KnowledgeChange[]; failed?: boolean } = {};
        try {
          body = JSON.parse(r.text);
        } catch {}
        return { id: `s${r.seq}`, role: 'ai' as const, text: String(body.reply ?? ''), at: r.at, changes: body.changes ?? [], failed: !!body.failed };
      });
    } catch {}
  }

  view(): { messages: TuneMessage[]; busy: boolean; max: number } {
    return { messages: this.messages, busy: this.waiting > 0, max: TUNE_MESSAGE_MAX };
  }

  private push(m: Omit<TuneMessage, 'id' | 'at'>, stored: string): void {
    this.messages = [...this.messages, { ...m, id: randomUUID(), at: Date.now() }].slice(-SHOWN);
    try {
      this.rt.store.appendTranscript(TUNE_LOG_ID, m.role, stored);
    } catch {}
    this.rt.notify();
  }

  /** The human said something. Kept and shown at once; read after the messages before it. */
  send(text: unknown): void {
    const said = String(text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, TUNE_MESSAGE_MAX);
    if (!said) throw new HttpError(400, '空のメッセージは送れません');
    const history = this.messages
      .slice(-HISTORY)
      .map((m) => ({ role: m.role, text: m.role === 'ai' ? [m.text, ...(m.changes ?? []).map((c) => `[${c.kind}] ${c.domain}: ${c.text}`)].filter(Boolean).join(' / ') : m.text }));
    this.waiting++;
    const choice = { ...(this.rt.core.state.settings.knowledge.tuneAi ?? { provider: 'claude', model: 'sonnet', effort: '' }) };
    this.push({ role: 'human', text: said }, said);
    this.chain = this.chain.then(() => this.read(said, history, choice)).catch(() => {});
  }

  private async read(said: string, history: { role: 'human' | 'ai'; text: string }[], choice: SideChatModel): Promise<void> {
    try {
      if (this.rt.closing) return;
      const { state } = this.rt.core;
      const k = state.knowledge;
      const entries = [...k.entries.values()].map((e) => ({ id: e.id, domainId: e.domainId, text: e.text, scope: e.scope }));
      const reading = await this.assistant
        .tunePreferences({
          message: this.redact(said),
          history: history.map((h) => ({ role: h.role, text: this.redact(h.text) })),
          domains: this.knowledge.briefs(),
          entries,
          projects: [...state.projects.values()].map((p) => ({ id: p.id, name: p.name })),
          otherDomainId: OTHER_DOMAIN_ID,
          domainsLeft: Math.max(0, KNOWLEDGE_LIMITS.domains - k.domains.size),
        }, choice)
        .catch(() => null);
      if (this.rt.closing) return;
      if (!reading) {
        const reply = '読み取れませんでした。もう一度送ってください。';
        this.push({ role: 'ai', text: reply, changes: [], failed: true }, JSON.stringify({ reply, changes: [], failed: true }));
        return;
      }
      if (!this.knowledge.canApply(reading, entries)) {
        const reply = '読み取り中にこだわりが編集されたため、反映しませんでした。最新の文章で整えるには、もう一度送ってください。';
        this.push({ role: 'ai', text: reply, changes: [], failed: true }, JSON.stringify({ reply, changes: [], failed: true }));
        return;
      }
      const changes = this.knowledge.apply(reading, { sessionId: null, projectId: null, seen: true });
      const reply = this.redact(reading.reply);
      this.push({ role: 'ai', text: reply, changes }, JSON.stringify({ reply, changes }));
    } finally {
      this.waiting--;
      this.rt.notify();
    }
  }
}
