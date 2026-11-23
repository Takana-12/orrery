// Session use cases: everything the human can do to a piece of work (start it, talk to it, stop it, put it away,
// call it done). Policy lives in the core; this service adds what needs the outside world (agents, folders, queue).
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ApprovalMode, AttentionAnswer, ProviderId, Settings } from '#core';
import type { WorktreeInfo } from '../infrastructure/worktree.ts';
import { runCommand } from '../infrastructure/shell.ts';
import type { Assistant, CommandReading } from './assistant.ts';
import { HttpError } from './errors.ts';
import type { Journal } from './journal.ts';
import { message, mustProject, mustProvider, mustSession } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import type { Scheduler } from './scheduler.ts';
import type { Secrets } from './secrets.ts';
import type { Workspaces } from './workspaces.ts';

export interface StartSessionInput {
  projectId: string;
  provider: ProviderId;
  /** Optional. Left empty, the work is named automatically from the instruction. */
  title?: string;
  prompt: string;
  acceptanceCriteria?: string | null;
  checkCommand?: string | null;
  autoFix?: boolean;
  model?: string | null;
  effort?: string | null;
  approvalMode?: ApprovalMode;
  planMode?: boolean;
  /** Work in a git worktree of its own. Left out, the project's own setting decides. */
  worktree?: boolean;
  /** Provider-specific extras, passed through to the adapter untouched. */
  codex?: unknown;
  claude?: unknown;
}

export interface SessionDeps {
  scheduler: Scheduler;
  secrets: Secrets;
  journal: Journal;
  workspaces: Workspaces;
  assistant: Assistant;
  /** Folder agents may read without asking (files the human attached). */
  attachmentsDir: string;
}

export class Sessions {
  /** Follow-up instructions written while the agent was busy; sent by us when its turn ends. */
  private readonly deferred = new Map<string, string>();
  private readonly rt: Runtime;
  private readonly d: SessionDeps;

  constructor(rt: Runtime, deps: SessionDeps) {
    this.rt = rt;
    this.d = deps;
  }

  addProject(path: string, name?: string): string {
    const root = resolve(path);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new HttpError(400, `フォルダが見つかりません: ${root}`);
    return this.rt.core.addProject(name?.trim() || basename(root), root);
  }

  renameProject(projectId: string, name: string): string {
    mustProject(this.rt, projectId);
    if (!name.trim()) throw new HttpError(400, '名前が空です');
    return this.rt.core.renameProject(projectId, name);
  }

  setProjectOptions(projectId: string, options: { useWorktree?: unknown; preamble?: unknown }): void {
    mustProject(this.rt, projectId);
    this.rt.core.setProjectOptions(projectId, {
      useWorktree: options.useWorktree === undefined ? undefined : options.useWorktree !== false,
      preamble: options.preamble === undefined ? undefined : String(options.preamble ?? ''),
    });
  }

  async start(input: StartSessionInput): Promise<string> {
    const { rt } = this;
    const { secrets, journal, workspaces, assistant, scheduler, attachmentsDir } = this.d;
    if (!input.prompt?.trim()) throw new HttpError(400, '指示文が空です');
    mustProject(rt, input.projectId);
    mustProvider(input.provider);
    const given = input.title?.trim();
    // A worktree of its own, so that agents working in parallel never edit the same checkout.
    // The project decides by default (on unless turned off in settings); the new-work screen may say otherwise.
    const project = rt.core.state.projects.get(input.projectId)!;
    const root = project.rootPath;
    const wantWorktree = typeof input.worktree === 'boolean' ? input.worktree : project.useWorktree !== false;
    const key = `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
    let wt: WorktreeInfo | null = null;
    let wtError: string | null = null;
    if (wantWorktree) {
      try {
        wt = await workspaces.plan(root, key); // quick: the folder itself is made below, while the reply goes back
      } catch (e) {
        wtError = message(e);
      }
    }
    const s = rt.core.createSession({
      cwd: wt?.cwd,
      projectId: input.projectId,
      provider: input.provider,
      title: given || input.prompt.trim().replace(/\s+/g, ' ').slice(0, 40),
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      checkCommand: input.checkCommand?.trim() || null,
      autoFix: !!input.autoFix,
      model: input.model?.trim() || null,
      effort: input.effort?.trim() || null,
      approvalMode: input.approvalMode === 'auto' || input.approvalMode === 'edits' ? input.approvalMode : 'ask',
    });
    if (!given) {
      // Name it in the background; the provisional name (start of the instruction) stays if this fails.
      assistant.queue(
        (m) => m.generateTitle(input.prompt),
        (title) => {
          if (title && !rt.closing) rt.core.renameTask(s.id, secrets.redact(title));
        },
      );
    }
    if (wt) {
      workspaces.adopt(s.id, wt);
      journal.write(s.id, 'system', `この作業専用のフォルダ（git worktree）で作業します: ${wt.path}\nブランチ ${wt.branch}（元: ${wt.base.slice(0, 7)}）。完了にするか片付けると、このフォルダは自動で削除されます。`);
    } else if (wtError) {
      journal.write(s.id, 'system', `作業専用のフォルダ（git worktree）を作れなかったため、プロジェクトのフォルダで直接作業します: ${secrets.redact(wtError)}`);
    }
    // The human's standing messages go first: the app-wide one (設定 → デフォルトメッセージ), then this project's own.
    const appWide = rt.core.state.settings.preamble?.trim();
    const own = project.preamble?.trim();
    const preamble = [appWide, own].filter(Boolean).join('\n\n');
    const req = { sessionId: s.id, cwd: s.cwd, prompt: preamble ? `${preamble}\n\n${input.prompt}` : input.prompt, shownPrompt: preamble ? input.prompt : undefined, readDirs: [attachmentsDir], model: s.requestedModel, effort: s.effort, approvalMode: s.approvalMode, planMode: input.planMode, codex: input.codex, claude: input.claude };
    if (preamble) journal.write(s.id, 'system', `${appWide && own ? '設定とプロジェクトの' : own ? 'プロジェクトの' : '設定の'}「デフォルトメッセージ」を先頭に付けて送りました。`);
    const made = wt;
    const ready = made ? workspaces.materialize(made, root) : Promise.resolve();
    ready.catch(() => {});
    scheduler.enqueue(s.id, async () => {
      try {
        await ready;
      } catch (e) {
        workspaces.markFailed(made!);
        rt.core.sessionUpdate(s.id, { lifecycle: 'error', error: `作業用フォルダ（git worktree）を作れませんでした: ${secrets.redact(message(e))}` });
        return;
      }
      await rt.adapters[s.provider].startSession({ ...req, env: secrets.envFor(s.projectId) });
    });
    return s.id;
  }

  hasDeferred(sessionId: string): boolean {
    return this.deferred.has(sessionId);
  }

  deferredOf(sessionId: string): string | null {
    return this.deferred.get(sessionId) ?? null;
  }

  /** Send any follow-up that was waiting for its session's turn to end. */
  flushDeferred(): void {
    for (const [sessionId, text] of this.deferred) {
      const s = this.rt.core.state.sessions.get(sessionId);
      if (!s) {
        this.deferred.delete(sessionId);
        continue;
      }
      if (s.lifecycle !== 'turn_finished') continue; // still busy, or stopped in a way the human should look at first
      this.deferred.delete(sessionId);
      void this.send(sessionId, text).catch((e) => this.rt.core.sessionUpdate(sessionId, { error: `後から送る指示を送れませんでした: ${message(e)}` }));
    }
  }

  cancelDeferred(sessionId: string): void {
    mustSession(this.rt, sessionId);
    if (this.deferred.delete(sessionId)) this.rt.notify();
  }

  /**
   * Follow-up message. Goes through the same queue as new work; a session whose process is gone is resumed by id.
   * If the agent is busy, the message is held and sent by us as soon as its turn ends, so the human need not come back.
   */
  async send(sessionId: string, text: string): Promise<{ resumed: boolean; queued: boolean; deferred?: boolean }> {
    const { rt } = this;
    if (!text?.trim()) throw new HttpError(400, 'メッセージが空です');
    const s = mustSession(rt, sessionId);
    const adapter = rt.adapters[s.provider];
    // An agent that is only waiting for its background work can be spoken to right away.
    const idleWaiting = s.lifecycle === 'running' && s.awaitingBackground && adapter.isLive(sessionId);
    if (!idleWaiting && (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user' || s.lifecycle === 'queued')) {
      const held = this.deferred.get(sessionId);
      this.deferred.set(sessionId, held ? `${held}\n\n${text}` : text);
      rt.notify();
      return { resumed: false, queued: false, deferred: true };
    }
    const live = adapter.isLive(sessionId);
    if (!live && !s.providerSessionId) throw new HttpError(409, 'このセッションは再開できません（プロバイダー側のIDが記録されていません）');
    if (s.archived) rt.core.setArchived(sessionId, false);
    this.d.scheduler.enqueue(sessionId, async () => {
      if (adapter.isLive(sessionId)) return adapter.sendMessage(sessionId, text);
      try {
        await this.d.workspaces.reopen(sessionId);
        await adapter.startSession({ sessionId, cwd: s.cwd, prompt: text, readDirs: [this.d.attachmentsDir], resumeProviderSessionId: s.providerSessionId, model: s.requestedModel, effort: s.effort, approvalMode: s.approvalMode, env: this.d.secrets.envFor(s.projectId) });
      } catch (e) {
        rt.core.sessionUpdate(sessionId, { lifecycle: 'error', resumability: 'unrecoverable', error: `再開に失敗: ${this.d.secrets.redact(message(e))}` });
      }
    });
    return { resumed: !live, queued: rt.core.state.sessions.get(sessionId)?.lifecycle === 'queued' };
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = mustSession(this.rt, sessionId);
    if (this.d.scheduler.cancel(sessionId)) {
      // Still waiting for a slot: nothing was sent to any agent yet.
      this.rt.core.sessionUpdate(sessionId, { lifecycle: 'interrupted', lastTurnOutcome: 'interrupted' });
      return;
    }
    await this.rt.adapters[s.provider].interrupt(sessionId);
  }

  /**
   * The human says: do not wait for this session's background work, treat the reply that ended as the finished turn.
   * (Orrery does this by itself when the reply shows the agent is not waiting; this is the manual override.)
   */
  finishWaiting(sessionId: string): void {
    const s = mustSession(this.rt, sessionId);
    if (!s.awaitingBackground || !this.rt.adapters[s.provider].finishTurn?.(sessionId)) throw new HttpError(409, 'この作業は、バックグラウンドの作業を待っている状態ではありません');
    this.d.journal.write(sessionId, 'system', 'バックグラウンドの作業の終了を待たずに、返答を完了として扱うようにしました。');
  }

  async stop(sessionId: string): Promise<void> {
    const s = mustSession(this.rt, sessionId);
    if (s.lifecycle === 'running' || s.lifecycle === 'waiting_for_user') throw new HttpError(409, 'ターンの実行中は停止できません。先に中断してください');
    await this.rt.adapters[s.provider].stop(sessionId);
  }

  markSeen(sessionId: string): void {
    mustSession(this.rt, sessionId);
    this.rt.core.markSeen(sessionId);
  }

  rename(sessionId: string, title: string): void {
    mustSession(this.rt, sessionId);
    if (!title?.trim()) throw new HttpError(400, '名前が空です');
    this.rt.core.renameTask(sessionId, title);
  }

  /** Archive = put away, reversibly. Frees the session's own process first; deletes nothing. */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const { rt } = this;
    const s = mustSession(rt, sessionId);
    const r = rt.core.setArchived(sessionId, archived);
    if (!r.ok) throw new HttpError(409, r.error);
    if (archived && rt.adapters[s.provider].isLive(sessionId)) await rt.adapters[s.provider].stop(sessionId);
    // Put away = cleaned up: the session's worktree goes (its work is kept on the branch). Brought back = re-created.
    // Not waited for: git can take seconds, and the human's "put away" is already true. Both report into the
    // session's record, a failed removal is retried at the next start, and a message sent meanwhile waits for the folder.
    if (archived) void this.d.workspaces.remove(sessionId);
    else void this.d.workspaces.reopen(sessionId).catch((e) => this.d.journal.write(sessionId, 'system', `作業用フォルダを作り直せませんでした: ${this.d.secrets.redact(message(e))}`));
  }

  /** The human says "this is done". Accepted work is put away (reversibly); reopening brings it back. */
  async setAccepted(sessionId: string, accepted: boolean): Promise<void> {
    mustSession(this.rt, sessionId);
    const holds = () => ['running', 'waiting_for_user', 'queued'].includes(this.rt.core.state.sessions.get(sessionId)?.lifecycle ?? '');
    if (accepted && holds()) {
      // The human called it done while the agent was still on it: stop the agent first, then put the work away.
      await this.interrupt(sessionId).catch(() => {});
      for (let i = 0; i < 50 && holds(); i++) await new Promise((r) => setTimeout(r, 200));
      if (!holds()) this.d.journal.write(sessionId, 'system', '作業中のエージェントを止めて、完了にしました。');
    }
    const r = this.rt.core.setAccepted(sessionId, accepted);
    if (!r.ok) throw new HttpError(409, r.error);
    await this.setArchived(sessionId, accepted);
  }

  /** Tick (or untick) one of the human's steps. When the last one is done, the task is done. */
  async setStepDone(sessionId: string, index: number, done: boolean): Promise<{ completed: boolean }> {
    mustSession(this.rt, sessionId);
    const all = this.rt.core.setHumanStepDone(sessionId, index, done);
    if (!all) return { completed: false };
    await this.setAccepted(sessionId, true);
    return { completed: true };
  }

  /**
   * Run a command the agent asked the human to run, in the session's folder, because the human clicked it.
   * Only commands that actually appear in what the agent wrote (or in the human-step list) are accepted.
   * When it is the command of one of the human's open steps, its output is then read for what it leaves: the step is
   * done, or something more is needed (an interactive prompt to answer in a terminal, a login, a fix and a re-run),
   * and the list is updated to say so. The answer comes once that is settled; the steps show each phase meanwhile.
   */
  async runForHuman(sessionId: string, command: string, runId?: string): Promise<{ ok: boolean; exitCode: number | null; output: string; step: { done: boolean; note: string | null; completed: boolean } | null }> {
    const { rt } = this;
    const s = mustSession(rt, sessionId);
    const cmd = String(command ?? '').trim();
    if (!cmd || cmd.length > 2000 || /[\r\n]/.test(cmd)) throw new HttpError(400, '実行できるのは1行のコマンドだけです');
    const t = rt.core.state.tasks.get(s.taskId);
    const stepIndex = t?.humanSteps?.findIndex((x) => x.command === cmd && !x.done) ?? -1;
    if (stepIndex < 0 && !t?.humanSteps?.some((x) => x.command === cmd) && !rt.store.agentWrote(sessionId, cmd)) throw new HttpError(403, 'このコマンドは、この作業でエージェントが書いたものではありません');
    if (stepIndex >= 0 && t?.humanSteps?.some((x) => x.run && x.run.phase !== 'settled')) throw new HttpError(409, 'この作業では、別のコマンドを実行しているか、その結果を読んでいるところです');
    const id = typeof runId === 'string' && /^[\w-]{6,64}$/.test(runId) ? runId : randomBytes(8).toString('hex');
    const forStep = stepIndex >= 0 && rt.core.humanStepRan(sessionId, stepIndex, cmd, id);
    const r = await runCommand(cmd, s.cwd, this.d.secrets.envFor(s.projectId));
    const output = this.d.secrets.redact(r.outputTail);
    this.d.journal.write(sessionId, 'system', `あなたが実行: ${cmd}（終了コード ${r.exitCode ?? '不明'}）\n${output}`);
    if (!forStep) return { ok: r.ok, exitCode: r.exitCode, output, step: null };
    const at = rt.core.humanStepOfRun(sessionId, id);
    if (at < 0 || !rt.core.humanStepRan(sessionId, at, cmd, id, { ok: r.ok, exitCode: r.exitCode, outputTail: output })) return { ok: r.ok, exitCode: r.exitCode, output, step: null };
    const step = await this.settleRun(sessionId, id, cmd, { ok: r.ok, exitCode: r.exitCode, output });
    return { ok: r.ok, exitCode: r.exitCode, output, step };
  }

  /** Read a step's command output and put what it leaves on the human's list. Finishing the last step finishes the task. */
  private async settleRun(sessionId: string, runId: string, cmd: string, res: { ok: boolean; exitCode: number | null; output: string }) {
    const { core } = this.rt;
    const redact = this.d.secrets.redact;
    const steps = () => {
      const s = core.state.sessions.get(sessionId);
      return (s && core.state.tasks.get(s.taskId)?.humanSteps) ?? [];
    };
    const at = core.humanStepOfRun(sessionId, runId);
    const st = steps()[at]!;
    const reading = await new Promise<CommandReading | null>((done) =>
      this.d.assistant.queue(
        (m) => m.readCommandResult({ step: { title: st.title, detail: st.detail }, command: cmd, ok: res.ok, exitCode: res.exitCode, output: res.output, laterSteps: steps().slice(at + 1).filter((x) => !x.done).map((x) => x.title) }),
        (r) => done(r),
      ),
    );
    const outcome = reading
      ? { done: reading.done, note: reading.note && redact(reading.note), steps: reading.steps.map((x) => ({ title: redact(x.title), detail: x.detail && redact(x.detail), command: x.command, after: x.after && redact(x.after) })) }
      : { done: res.ok, note: `出力を自動で読めなかったため、終了コード（${res.exitCode ?? '不明'}）で${res.ok ? '済んだ' : 'まだ済んでいない'}と判断しました。`, steps: [] };
    const all = core.settleHumanStep(sessionId, runId, outcome);
    this.d.journal.write(sessionId, 'system', `実行結果の読み取り: ${outcome.done ? '済み' : 'まだ済んでいない'}${outcome.note ? `。${outcome.note}` : ''}${outcome.steps.length ? `\n追加された作業: ${outcome.steps.map((x) => x.title).join(' / ')}` : ''}`);
    if (all) await this.setAccepted(sessionId, true).catch(() => {});
    return { done: outcome.done, note: outcome.note, completed: all };
  }

  answer(itemId: string, answer: AttentionAnswer) {
    return this.rt.core.answer(itemId, answer);
  }

  setSettings(patch: Partial<Settings>): Settings {
    const s = this.rt.core.setSettings(patch ?? {});
    this.d.scheduler.pump();
    return s;
  }
}
