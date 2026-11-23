// Side chats: small conversations beside the work, for a passing question or a chat. Each one talks to an agent
// (Claude or Codex) without a workspace: no project, no worktree, no permission choices, no inbox, no completion
// judging. They run on the same provider adapters as the work; the adapters' events for a chat id are routed here
// (see app.ts) instead of into the core, so nothing about a chat can reach the work's lists.
import { randomBytes } from 'node:crypto';
import type { OpenAttention, ProviderId } from '#core';
import { HttpError } from './errors.ts';
import type { Journal } from './journal.ts';
import { message, mustProvider } from './runtime.ts';
import type { Runtime } from './runtime.ts';

/** Every side chat id starts with this, so the adapters' events can be told apart from the work's. */
export const CHAT_PREFIX = 'chat-';
export const isChatId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(CHAT_PREFIX);

export type ChatState = 'idle' | 'running' | 'interrupted' | 'error';

export interface SideChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The AI the next message goes to (the human may switch it at any time). */
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  state: ChatState;
  error: string | null;
  /** The provider conversation the words so far are in, and the AI it was last started with. Null before the first message. */
  conversation: { provider: ProviderId; id: string | null; model: string | null; effort: string | null } | null;
  /** The model the provider says it is answering with. */
  activeModel: string | null;
}

/** What a chat may do on Codex: read, never write, never ask. */
const CODEX_CHAT = { approvalPolicy: 'never', sandbox: 'read-only' } as const;
/** A Claude chat nobody talks to for this long gives its process back (the conversation is resumed on the next message). */
const IDLE_STOP_MS = 15 * 60_000;
/** How much of the conversation so far is handed to another agent when the human switches agents mid-chat. */
const HISTORY_CHARS = 24_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

export interface ChatDirs {
  /** The folder every chat runs in: empty, shared, belongs to no project. */
  cwd: string;
  /** Attached files, which a chat may read. */
  attachments: string;
}

export class SideChats {
  private readonly chats = new Map<string, SideChat>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** Closed chats: late events from their dying process are dropped. */
  private readonly closed = new Set<string>();
  private readonly rt: Runtime;
  private readonly journal: Journal;
  private readonly redact: (text: string) => string;
  private readonly dirs: ChatDirs;

  constructor(rt: Runtime, journal: Journal, redact: (text: string) => string, dirs: ChatDirs) {
    this.rt = rt;
    this.journal = journal;
    this.redact = redact;
    this.dirs = dirs;
    for (const c of rt.store.readChats<SideChat>()) {
      // Whatever was answering when Orrery stopped did not finish.
      if (c.state === 'running') c.state = 'interrupted';
      this.chats.set(c.id, c);
    }
  }

  owns(id: string): boolean {
    return isChatId(id);
  }

  private must(id: string): SideChat {
    const c = this.chats.get(id);
    if (!c) throw new HttpError(404, 'このチャットはもうありません');
    return c;
  }

  private save(c: SideChat): void {
    c.updatedAt = Date.now();
    if (!this.closed.has(c.id)) this.rt.store.saveChat(c);
    this.rt.notify();
  }

  private choice(input: { provider: unknown; model?: unknown; effort?: unknown }): Pick<SideChat, 'provider' | 'model' | 'effort'> {
    mustProvider(input.provider);
    return { provider: input.provider, model: str(input.model), effort: str(input.effort) };
  }

  /** A new chat, with its first message. Answers at once; the reply comes in through the state stream. */
  start(input: { provider: unknown; model?: unknown; effort?: unknown; prompt: unknown }): string {
    const prompt = String(input.prompt ?? '');
    if (!prompt.trim()) throw new HttpError(400, 'メッセージが空です');
    const now = Date.now();
    const id = `${CHAT_PREFIX}${now.toString(36)}-${randomBytes(3).toString('hex')}`;
    const first = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
    const c: SideChat = { id, title: first.slice(0, 40) || 'チャット', createdAt: now, updatedAt: now, ...this.choice(input), state: 'idle', error: null, conversation: null, activeModel: null };
    this.chats.set(id, c);
    this.run(c, prompt);
    return id;
  }

  send(id: string, text: string): void {
    const c = this.must(id);
    if (!text.trim()) throw new HttpError(400, 'メッセージが空です');
    if (c.state === 'running') throw new HttpError(409, 'まだ返答中です。返答が終わってから送るか、止めてから送ってください');
    this.run(c, text);
  }

  /** The AI the next message goes to. The words so far stay; a different agent is told what was said. */
  setChoice(id: string, input: { provider: unknown; model?: unknown; effort?: unknown }): void {
    const c = this.must(id);
    Object.assign(c, this.choice(input));
    this.save(c);
  }

  async interrupt(id: string): Promise<void> {
    const c = this.must(id);
    if (c.state !== 'running' || !c.conversation) return;
    const adapter = this.rt.adapters[c.conversation.provider];
    try {
      await adapter.interrupt(id);
    } catch {
      // Nothing was running after all (the reply ended meanwhile, or the process is gone).
    }
    if (c.state === 'running') {
      c.state = 'interrupted';
      this.save(c);
    }
  }

  /** Closing a chat ends it: its process goes, and nothing of it is kept. */
  async close(id: string): Promise<void> {
    const c = this.chats.get(id);
    if (!c) return;
    this.closed.add(id);
    this.clearIdle(id);
    this.chats.delete(id);
    this.rt.store.deleteChat(id);
    this.rt.notify();
    if (c.conversation) await this.release(id, c.conversation.provider).catch(() => {});
  }

  /** What the UI is sent about the chats. */
  view() {
    return [...this.chats.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        provider: c.provider,
        model: c.model,
        effort: c.effort,
        state: c.state,
        error: c.error,
        activeModel: c.activeModel,
        startedWith: c.conversation?.provider ?? null,
        live: !!c.conversation && this.rt.adapters[c.conversation.provider].isLive(c.id),
        transcriptRev: this.journal.revOf(c.id),
      }));
  }

  private run(c: SideChat, text: string): void {
    const want = { provider: c.provider, model: c.model, effort: c.effort };
    const conv = c.conversation;
    const adapter = this.rt.adapters[want.provider];
    c.state = 'running';
    c.error = null;
    this.clearIdle(c.id);
    this.save(c);
    void (async () => {
      try {
        const same = !!conv && conv.provider === want.provider && conv.model === want.model && conv.effort === want.effort;
        if (same && adapter.isLive(c.id)) return await adapter.sendMessage(c.id, text);
        // A process started with another model or agent is let go first, so its exit is not taken for the new one's.
        if (conv) await this.release(c.id, conv.provider);
        const resume = conv && conv.provider === want.provider ? conv.id : null;
        // Another agent has not heard what was said so far: it is told, and the record shows only the new message.
        const prompt = conv && conv.provider !== want.provider ? this.withHistory(c.id, text) : text;
        c.conversation = { provider: want.provider, id: resume, model: want.model, effort: want.effort };
        this.save(c);
        await adapter.startSession({
          sessionId: c.id,
          cwd: this.dirs.cwd,
          prompt,
          shownPrompt: prompt === text ? undefined : text,
          readDirs: [this.dirs.attachments],
          model: want.model,
          effort: want.effort,
          resumeProviderSessionId: resume,
          approvalMode: 'ask',
          chat: true,
          codex: CODEX_CHAT,
        } as Parameters<typeof adapter.startSession>[0]);
      } catch (e) {
        this.update(c.id, { lifecycle: 'error', error: message(e) });
      }
    })();
  }

  /** Let a chat's process go (Claude: one per chat). Codex threads share one process: nothing to wait for. */
  private async release(id: string, provider: ProviderId): Promise<void> {
    const a = this.rt.adapters[provider];
    if (!a.isLive(id) || provider === 'codex') return;
    await a.stop(id);
    for (let i = 0; i < 50 && a.isLive(id); i++) await new Promise((r) => setTimeout(r, 100));
  }

  private withHistory(id: string, text: string): string {
    const said = this.rt.store
      .readTranscript(id, 200)
      .filter((e) => e.role === 'user' || e.role === 'assistant')
      .map((e) => `${e.role === 'user' ? '人間' : 'AI'}: ${e.text}`)
      .join('\n\n');
    if (!said.trim()) return text;
    return `<これまでの会話>\n${said.slice(-HISTORY_CHARS)}\n</これまでの会話>\n\n上は、この人と別のAIとのこれまでの会話です。その続きとして、次のメッセージに答えてください。\n\n${text}`;
  }

  private clearIdle(id: string): void {
    const t = this.idleTimers.get(id);
    if (t) clearTimeout(t);
    this.idleTimers.delete(id);
  }

  private armIdle(c: SideChat): void {
    this.clearIdle(c.id);
    if (c.conversation?.provider !== 'claude') return;
    const t = setTimeout(() => {
      this.idleTimers.delete(c.id);
      if (c.state !== 'running' && this.chats.has(c.id)) void this.release(c.id, 'claude').then(() => this.rt.notify());
    }, IDLE_STOP_MS);
    t.unref?.();
    this.idleTimers.set(c.id, t);
  }

  // ---- what the provider adapters report about a chat (routed here by app.ts) ----------------------------------

  update(id: string, patch: { lifecycle?: string; error?: string | null; providerSessionId?: string | null; model?: string | null; process?: string }): void {
    const c = this.chats.get(id);
    if (!c || this.closed.has(id)) return;
    if (patch.providerSessionId && c.conversation) c.conversation.id = patch.providerSessionId;
    if (typeof patch.model === 'string' && patch.model) c.activeModel = patch.model;
    if (patch.lifecycle === 'running') {
      c.state = 'running';
      c.error = null;
    } else if (patch.lifecycle === 'turn_finished') {
      c.state = 'idle';
      this.armIdle(c);
    } else if (patch.lifecycle === 'interrupted') c.state = 'interrupted';
    else if (patch.lifecycle === 'error') {
      c.state = 'error';
      c.error = this.redact(String(patch.error || '')) || '答えられませんでした';
    }
    if (patch.process === 'crashed' && c.state === 'running') {
      c.state = 'error';
      c.error = 'AIのプロセスが止まりました。もう一度送ると続きから再開します';
    }
    this.save(c);
  }

  transcript(id: string, role: string, text: string): void {
    if (this.chats.has(id) && !this.closed.has(id)) this.journal.write(id, role, text);
  }

  /** A chat never asks the human anything: whatever an agent asks for there is refused at once. */
  refuse(input: OpenAttention): string {
    const reply = input.reply;
    if (reply) {
      queueMicrotask(() => {
        for (const answer of [{ kind: 'decision', decision: 'decline', message: 'サイドチャットでは、この操作はできません。' }, { kind: 'decline' }, { kind: 'answers', answers: {} }] as const) {
          try {
            reply(answer as Parameters<typeof reply>[0]);
            return;
          } catch {}
        }
      });
    }
    this.transcript(input.sessionId, 'system', `「${input.summary}」は、サイドチャットではできないので断りました。`);
    return `${input.sessionId}:refused:${randomBytes(4).toString('hex')}`;
  }

  providerOf(id: string): ProviderId | null {
    return this.chats.get(id)?.conversation?.provider ?? null;
  }
}
