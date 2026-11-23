// Checker: a finished turn is not a finished task. When a task has a check command, Orrery runs it itself after
// each turn and records exactly what happened; a failure can be handed back to the agent (a bounded number of times).
import { MAX_FIX_ROUNDS } from '#core';
import type { TaskValidation } from '#core';
import { runCommand, uncommittedFiles } from '../infrastructure/shell.ts';
import { HttpError } from './errors.ts';
import type { Journal } from './journal.ts';
import { mustSession } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import type { Secrets } from './secrets.ts';
import type { Sessions } from './sessions.ts';

export class Checker {
  /** `${sessionId}:${lifecycleSince}` of turns whose check was already started, so one turn is checked once. */
  private readonly checked = new Set<string>();
  private readonly rt: Runtime;
  private readonly sessions: Sessions;
  private readonly secrets: Secrets;
  private readonly journal: Journal;

  constructor(rt: Runtime, sessions: Sessions, secrets: Secrets, journal: Journal) {
    this.rt = rt;
    this.sessions = sessions;
    this.secrets = secrets;
    this.journal = journal;
  }

  /** Called on every state change: start the check of each turn that just finished. */
  onChange(): void {
    const st = this.rt.core.state;
    for (const s of st.sessions.values()) {
      if (s.lifecycle !== 'turn_finished' || s.archived) continue;
      const t = st.tasks.get(s.taskId);
      if (!t?.checkCommand || t.validation || t.validating) continue;
      if (this.sessions.hasDeferred(s.id)) continue; // more instructions are about to be sent: check after that turn instead
      const key = `${s.id}:${s.lifecycleSince}`;
      if (this.checked.has(key)) continue;
      this.checked.add(key);
      void this.run(s.id).catch(() => {});
    }
  }

  /** Run the task's check command ourselves, in the work folder, and record exactly what happened. */
  async run(sessionId: string): Promise<void> {
    const { core } = this.rt;
    const s = mustSession(this.rt, sessionId);
    const t = core.state.tasks.get(s.taskId)!;
    if (!t.checkCommand) throw new HttpError(409, 'この作業には検証コマンドが設定されていません');
    if (t.validating) throw new HttpError(409, '検証の実行中です');
    if (s.lifecycle !== 'turn_finished') throw new HttpError(409, 'エージェントの返答が終わってから検証します');
    const command = t.checkCommand;
    core.validationStarted(t.id);
    // The command comes from the human who created the task, and is run through the shell exactly as typed.
    const result = await runCommand(command, s.cwd, this.secrets.envFor(s.projectId));
    if (this.rt.closing) return;
    if (core.state.sessions.get(sessionId)?.lifecycle !== 'turn_finished') {
      // The agent was sent back to work while the check ran: this result is about a state that no longer exists.
      core.validationCancelled(t.id);
      return;
    }
    const validation: TaskValidation = { command, ...result, outputTail: this.secrets.redact(result.outputTail), at: Date.now(), uncommittedFiles: await uncommittedFiles(s.cwd) };
    core.validated(t.id, validation);
    this.journal.write(sessionId, 'system', `検証 ${validation.ok ? '成功' : '失敗'}: ${command}（終了コード ${validation.exitCode ?? '不明'}）\n${validation.outputTail}`);

    const now = core.state.tasks.get(t.id)!;
    if (!validation.ok && now.autoFix && now.fixRounds < MAX_FIX_ROUNDS && core.state.sessions.get(sessionId)?.lifecycle === 'turn_finished') {
      core.fixRequested(t.id);
      await this.sessions
        .send(sessionId, `検証コマンド \`${command}\` が失敗しました（終了コード ${validation.exitCode ?? '不明'}）。原因を直してください。直したら、あなた自身でも同じコマンドで確認してください。\n\n出力の末尾:\n${validation.outputTail}`)
        .catch(() => {});
    }
  }
}
