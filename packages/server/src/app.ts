// Composition root: builds every layer and wires them together, and is the one object the interface layer (HTTP)
// talks to. Layers, outermost first:
//   interface/      receives requests (HTTP routes, the state stream) and turns them into calls on this class
//   application/    does the work: use cases (sessions, accounts, secrets ...) and the supervisors the human should
//                   not have to be (scheduler: how many at once; checker: did it pass; reader: what is left for me)
//   #core           decides: the event-sourced state and the rules for answers, acceptance and completion
//   infrastructure/ writes and runs: SQLite, git worktrees, the shell, attached files
//   #provider-*, #host-windows   the outside world: the agents and the operating system
// Dependencies point inwards only; nothing below application/ knows HTTP exists.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { ControlCore } from '#core';
import type { AttentionAnswer, ProviderId, ProviderSink, Settings } from '#core';
import { CodexAdapter } from '#provider-codex';
import type { CodexStartOptions } from '#provider-codex';
import { ClaudeAdapter } from '#provider-claude';
import type { ClaudeOptions, ClaudeStartExtras } from '#provider-claude';
import { protect, unprotect } from '#host-windows';
import { SqliteStore } from './infrastructure/sqlite-store.ts';
import { Worktrees } from './infrastructure/worktree.ts';
import { AttachmentFiles } from './infrastructure/attachment-files.ts';
import { pickFolderDialog, pullRequestOf } from './infrastructure/shell.ts';
import { ChosenSpeech } from './infrastructure/speech.ts';
import type { Speech } from './infrastructure/speech.ts';
import { Accounts } from './application/accounts.ts';
import { Assistant } from './application/assistant.ts';
import { Checker } from './application/checker.ts';
import { HttpError } from './application/errors.ts';
import { Housekeeping } from './application/housekeeping.ts';
import { Journal } from './application/journal.ts';
import { Knowledge } from './application/knowledge.ts';
import { KnowledgeTune } from './application/knowledge-tune.ts';
import { Processes } from './application/processes.ts';
import { PullRequests } from './application/pull-requests.ts';
import { Reader } from './application/reader.ts';
import { capabilities, snapshot } from './application/read-model.ts';
import type { Runtime } from './application/runtime.ts';
import { Scheduler } from './application/scheduler.ts';
import { Secrets } from './application/secrets.ts';
import { SideChats, isChatId } from './application/side-chats.ts';
import { Sessions } from './application/sessions.ts';
import type { StartSessionInput as BaseStartInput } from './application/sessions.ts';
import { Workspaces } from './application/workspaces.ts';
import { UsageResumer } from './application/usage-resume.ts';
import { Voice } from './application/voice.ts';

export { HttpError };

export interface AppOptions {
  dbPath: string;
  /** Shell-provided folder chooser (the Windows app uses the standard Explorer dialog). */
  pickFolder?: () => Promise<string | null>;
  /** Shell-provided "open this page in the default browser" (used for the providers' sign-in pages). */
  openExternal?: (url: string) => void;
  /** Shell-provided: drop the window's own caches (rendered pages, GPU shaders ...). */
  clearShellCache?: () => Promise<void>;
  codex?: CodexStartOptions;
  claude?: ClaudeOptions;
  /** The speech recogniser (tests give their own; by default it runs on this machine, see infrastructure/speech.ts). */
  speech?: Speech;
}

export interface StartSessionInput extends BaseStartInput {
  codex?: CodexStartOptions;
  claude?: ClaudeStartExtras;
}

export class App extends EventEmitter {
  readonly core: ControlCore;
  readonly store: SqliteStore;
  readonly generation: number;
  private readonly rt: Runtime;
  private readonly codex: CodexAdapter;
  private readonly secrets: Secrets;
  private readonly journal: Journal;
  private readonly processes: Processes;
  private readonly scheduler: Scheduler;
  private readonly workspaces: Workspaces;
  private readonly pullRequests: PullRequests;
  private readonly accounts: Accounts;
  private readonly sessions: Sessions;
  private readonly checker: Checker;
  private readonly reader: Reader;
  private readonly usageResumer: UsageResumer;
  private readonly housekeeping: Housekeeping;
  private readonly chats: SideChats;
  private readonly knowledge: Knowledge;
  private readonly knowledgeTune: KnowledgeTune;
  private readonly voice: Voice;
  private readonly speech: Speech;
  private readonly opts: AppOptions;
  private sampler: NodeJS.Timeout | null = null;

  constructor(opts: AppOptions) {
    super();
    this.opts = opts;
    const home = opts.dbPath === ':memory:' ? join(tmpdir(), 'orrery') : dirname(resolve(opts.dbPath));
    const files = new AttachmentFiles(join(home, 'attachments'));
    this.store = new SqliteStore(opts.dbPath);
    // The runtime is completed in two steps: services need the core, the core needs the change hook, adapters need the sink.
    const rt = { store: this.store, closing: false, notify: () => void this.emit('change') } as Runtime;
    this.rt = rt;
    this.secrets = new Secrets(rt, { protect, unprotect });
    const redact = this.secrets.redact;
    this.core = new ControlCore({ store: this.store, onEvent: () => this.changed(), onPassiveAnswer: (item, answer) => this.reader.deliver(item, answer) });
    (rt as { core: ControlCore }).core = this.core;
    this.journal = new Journal(rt, redact);
    this.processes = new Processes(rt);
    this.scheduler = new Scheduler(rt, redact);
    this.workspaces = new Workspaces(rt, new Worktrees(home), this.journal, this.processes, redact);
    this.pullRequests = new PullRequests(rt, this.workspaces, pullRequestOf);
    this.accounts = new Accounts(rt, opts.openExternal, (provider, limits) => this.usageResumer.observe(provider, limits));
    this.housekeeping = new Housekeeping(rt, this.journal, files, opts.clearShellCache);
    // Side chats run in one empty folder of their own: no project, nothing of the work's is in reach.
    const chatDir = join(home, 'side-chat');
    mkdirSync(chatDir, { recursive: true });
    this.chats = new SideChats(rt, this.journal, this.secrets.redact, { cwd: chatDir, attachments: files.dir });
    // Advancing the generation retires whatever the previous process left open (see reducer 'core.started').
    this.generation = this.core.start();
    setTimeout(() => this.workspaces.retryRemovals(), 3000).unref();

    const claude = new ClaudeAdapter(this.providerSink(), opts.claude);
    this.codex = new CodexAdapter(this.providerSink(), opts.codex);
    rt.adapters = { codex: this.codex, claude };
    const assistant = new Assistant(rt, claude, { claude, codex: this.codex });
    this.knowledge = new Knowledge(rt, this.journal, assistant, redact);
    this.knowledgeTune = new KnowledgeTune(rt, this.knowledge, assistant, redact);
    // Speech is recognised on this machine; its model lives in the data folder, downloaded on first use.
    this.speech = opts.speech ?? new ChosenSpeech(join(home, 'models'), () => rt.notify(), () => rt.core.state.settings.voice.recognizer);
    this.voice = new Voice(rt, { speech: this.speech, assistant, accounts: this.accounts });
    this.sessions = new Sessions(rt, { scheduler: this.scheduler, secrets: this.secrets, journal: this.journal, workspaces: this.workspaces, assistant, knowledge: this.knowledge, attachmentsDir: files.dir });
    this.usageResumer = new UsageResumer(rt, this.sessions, this.journal, (provider) => this.accounts.refreshLimits(provider));
    this.checker = new Checker(rt, this.sessions, this.secrets, this.journal);
    this.reader = new Reader(rt, this.sessions, this.secrets, this.journal, assistant);

    this.sampler = setInterval(() => {
      this.processes.sampleAll();
      this.scheduler.pump(); // free memory may have changed
      this.usageResumer.tick();
      void this.pullRequests.tick();
    }, 5000);
    this.sampler.unref();
    this.accounts.watch();
  }

  /** What a provider adapter may tell us. Everything it reports is redacted before it is stored or shown. */
  private providerSink(): ProviderSink {
    const { rt } = this;
    const redact = this.secrets.redact;
    const chats = () => this.chats;
    return {
      sessionUpdate: (id, patch) => {
        if (rt.closing) return;
        if (isChatId(id)) return chats().update(id, patch);
        const clean = { ...patch };
        if (typeof clean.lastText === 'string') clean.lastText = redact(clean.lastText);
        if (typeof clean.error === 'string') {
          clean.error = redact(clean.error);
          const s = this.core.state.sessions.get(id);
          if (s && /log ?in|logged out|unauthor|401|auth/i.test(clean.error)) void this.accounts.refresh(s.provider);
        }
        this.core.sessionUpdate(id, clean);
      },
      attentionOpen: (input) => {
        if (rt.closing) throw new Error('control room is shutting down');
        if (isChatId(input.sessionId)) return chats().refuse(input);
        return this.core.attentionOpen({
          ...input,
          summary: redact(input.summary),
          approval: input.approval ? { ...input.approval, subject: input.approval.subject === null ? null : redact(input.approval.subject) } : input.approval,
        });
      },
      attentionAcknowledged: (id, req, ev) => void (rt.closing || isChatId(id) || this.core.attentionAcknowledged(id, req, ev)),
      attentionWithdrawn: (id, req, reason) => void (rt.closing || isChatId(id) || this.core.attentionWithdrawn(id, req, reason)),
      saveRaw: (sessionId, body) => (rt.closing ? '' : this.store.saveRaw(sessionId, JSON.parse(redact(JSON.stringify(body ?? null))))),
      transcript: (sessionId, entry) => (isChatId(sessionId) ? chats().transcript(sessionId, entry.role, entry.text) : this.journal.write(sessionId, entry.role, entry.text)),
      usage: (sessionId, u) => {
        const chatProvider = isChatId(sessionId) ? chats().providerOf(sessionId) : null;
        if (chatProvider) {
          if (rt.closing) return;
          this.store.addUsage(sessionId, chatProvider, u);
          this.accounts.usageMoved(chatProvider);
          return rt.notify();
        }
        const s = this.core.state.sessions.get(sessionId);
        if (rt.closing || !s) return;
        this.store.addUsage(sessionId, s.provider, u);
        this.accounts.usageMoved(s.provider);
        rt.notify();
      },
      usageLimits: (provider, limits) => this.usageResumer.observe(provider, limits),
      usageBlocked: (sessionId) => this.usageResumer.blocked(sessionId),
      processSpawned: (owner, pid) => this.processes.own(owner.sessionId ?? `shared:${owner.provider}`, pid),
    };
  }

  private changed(): void {
    this.emit('change');
    if (this.rt.closing) return;
    // Supervisors react to every state change, after the current event has been fully applied.
    queueMicrotask(() => {
      if (this.rt.closing) return;
      this.sessions.flushDeferred();
      this.scheduler.pump();
      this.checker.onChange();
      this.reader.onChange();
    });
  }

  // ---- use cases, as the interface layer calls them ---------------------------------------------

  refreshAuth(provider: ProviderId) { return this.accounts.refresh(provider); }
  startLogin(provider: ProviderId) { return this.accounts.startLogin(provider); }
  usageSummary() { return this.accounts.usageSummary(); }
  listModels(provider: ProviderId) { return this.accounts.listModels(provider); }

  addProject(path: string, name?: string) { return this.sessions.addProject(path, name); }
  renameProject(projectId: string, name: string) { return this.sessions.renameProject(projectId, name); }
  setProjectOptions(projectId: string, options: { useWorktree?: unknown; preamble?: unknown; approvalMode?: unknown; captureKnowledge?: unknown; description?: unknown }) { return this.sessions.setProjectOptions(projectId, options); }
  startSession(input: StartSessionInput) { return this.sessions.start(input); }
  sendMessage(sessionId: string, text: string, options: { effort?: unknown } = {}) { return this.sessions.send(sessionId, text, options); }
  cancelDeferred(sessionId: string) { return this.sessions.cancelDeferred(sessionId); }
  interrupt(sessionId: string) { return this.sessions.interrupt(sessionId); }
  stop(sessionId: string) { return this.sessions.stop(sessionId); }
  finishWaiting(sessionId: string) { return this.sessions.finishWaiting(sessionId); }
  markSeen(sessionId: string) { return this.sessions.markSeen(sessionId); }
  rename(sessionId: string, title: string) { return this.sessions.rename(sessionId, title); }
  setArchived(sessionId: string, archived: boolean) { return this.sessions.setArchived(sessionId, archived); }
  setAccepted(sessionId: string, accepted: boolean) { return this.sessions.setAccepted(sessionId, accepted); }
  setStepDone(sessionId: string, index: number, done: boolean) { return this.sessions.setStepDone(sessionId, index, done); }
  runForHuman(sessionId: string, command: string, runId?: string) { return this.sessions.runForHuman(sessionId, command, runId); }
  answer(itemId: string, answer: AttentionAnswer) { return this.sessions.answer(itemId, answer); }
  setSettings(patch: Partial<Settings>) { return this.sessions.setSettings(patch); }
  runCheck(sessionId: string) { return this.checker.run(sessionId); }

  setKnowledgeDomain(input: { id?: unknown; name?: unknown; description?: unknown; always?: unknown }) { return this.knowledge.setDomain(input); }
  removeKnowledgeDomain(domainId: string) { return this.knowledge.removeDomain(domainId); }
  addKnowledgeEntry(input: { domainId?: unknown; text?: unknown; scope?: unknown }) { return this.knowledge.addEntry(input); }
  updateKnowledgeEntry(entryId: string, patch: { text?: unknown; domainId?: unknown; scope?: unknown }) { return this.knowledge.updateEntry(entryId, patch); }
  removeKnowledgeEntry(entryId: string) { return this.knowledge.removeEntry(entryId); }
  markKnowledgeSeen() { return this.knowledge.markSeen(); }
  sendKnowledgeTune(text: unknown) { return this.knowledgeTune.send(text); }
  cleanup(sessionId: string) { return this.processes.cleanup(sessionId); }

  prepareVoice() { return this.voice.prepare(); }
  transcribeVoice(recording: unknown) { return this.voice.transcribe(recording); }
  planVoice(input: { text?: unknown; lastProjectId?: unknown; usual?: unknown }) { return this.voice.plan(input); }
  tidyVoice(input: { text?: unknown; sessionId?: unknown }) { return this.voice.tidy(input); }

  startChat(input: { provider: unknown; model?: unknown; effort?: unknown; prompt: unknown }) { return this.chats.start(input); }
  sendChat(chatId: string, text: string) { return this.chats.send(chatId, text); }
  setChatChoice(chatId: string, choice: { provider: unknown; model?: unknown; effort?: unknown }) { return this.chats.setChoice(chatId, choice); }
  interruptChat(chatId: string) { return this.chats.interrupt(chatId); }
  closeChat(chatId: string) { return this.chats.close(chatId); }

  listEnv(projectId: string) { return this.secrets.list(projectId); }
  setEnv(projectId: string, name: string, value: string) { return this.secrets.set(projectId, name, value); }
  deleteEnv(projectId: string, name: string) { return this.secrets.delete(projectId, name); }
  revealEnv(projectId: string, name: string) { return this.secrets.reveal(projectId, name); }

  storage() { return this.housekeeping.storage(); }
  purge(olderThanDays: number) { return this.housekeeping.purge(olderThanDays); }
  saveAttachment(name: string, data: Buffer) { return this.housekeeping.saveAttachment(name, data); }

  /** Native folder chooser, so the human does not have to type an absolute path. Resolves null if cancelled. */
  pickFolder(): Promise<string | null> {
    if (this.opts.pickFolder) return this.opts.pickFolder();
    return pickFolderDialog().catch(() => {
      throw new HttpError(500, 'フォルダ選択ダイアログを開けませんでした。パスを直接入力してください');
    });
  }

  capabilities() { return capabilities(this.rt); }

  /** The one document the UI is sent. */
  snapshot() {
    return snapshot(this.rt, { scheduler: this.scheduler, processes: this.processes, workspaces: this.workspaces, journal: this.journal, sessions: this.sessions, chats: this.chats, knowledgeTune: this.knowledgeTune, voice: this.voice, accounts: this.accounts, secrets: this.secrets, pullRequests: this.pullRequests });
  }

  async shutdown(opts: { archiveCodexThreads?: boolean } = {}): Promise<void> {
    if (this.sampler) clearInterval(this.sampler);
    this.accounts.stop();
    this.speech.close();
    if (opts.archiveCodexThreads) for (const s of this.core.state.sessions.values()) if (s.provider === 'codex') await this.codex.archive(s.id);
    this.rt.closing = true;
    await this.rt.adapters.claude.shutdown();
    await this.rt.adapters.codex.shutdown();
    this.processes.closeAll();
    this.store.close();
  }
}
