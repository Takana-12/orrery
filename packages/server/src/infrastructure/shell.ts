// Running things on this machine: a shell command in a folder, git's view of a folder, GitHub's view of a branch.
import { execFile, spawn } from 'node:child_process';
import { createJob, ownedSpawn } from '#host';

const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 4000;

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  /** The end of stdout+stderr. */
  outputTail: string;
}

/** Run one command line through the shell, exactly as typed, and report how it ended. Everything it starts ends with it. */
export function runCommand(command: string, cwd: string, extraEnv: Record<string, string>): Promise<CommandResult> {
  return new Promise((done) => {
    let out = '';
    const add = (d: Buffer) => {
      out = (out + d.toString('utf8')).slice(-OUTPUT_TAIL * 2);
    };
    const child = spawn(command, { cwd, env: { ...process.env, ...extraEnv }, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...ownedSpawn });
    const job = createJob();
    try {
      if (child.pid) job.assign(child.pid);
    } catch {}
    const timer = setTimeout(() => {
      out += `\n[Control Room] ${TIMEOUT_MS / 60000}分でタイムアウトしたため中止しました`;
      job.terminate();
    }, TIMEOUT_MS);
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let finished = false;
    const finish = (code: number | null, note = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      job.close(); // ends anything the command left running
      done({ ok: code === 0, exitCode: code, outputTail: (out + note).slice(-OUTPUT_TAIL).trim() });
    };
    child.once('error', (e) => finish(null, `\n[Control Room] 実行できませんでした: ${e.message}`));
    child.once('close', (code) => finish(code));
  });
}

/** Files with uncommitted changes in `cwd`, or null when it is not a git repository. */
export function uncommittedFiles(cwd: string): Promise<number | null> {
  return new Promise((done) => {
    execFile('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true }, (err, stdout) => {
      done(err ? null : stdout.split('\n').filter((l) => l.trim()).length);
    });
  });
}

export interface PullRequestInfo {
  number: number;
  url: string;
  /** OPEN, MERGED or CLOSED, as GitHub says. */
  state: string;
  draft: boolean;
  title: string;
}

/**
 * The GitHub pull request of `branch` (or of the branch checked out in `cwd`), through the GitHub CLI.
 * null when there is none, or when it cannot be told (no gh, not signed in, not a GitHub repository, detached HEAD).
 */
export function pullRequestOf(cwd: string, branch: string | null): Promise<PullRequestInfo | null> {
  const args = ['pr', 'view', ...(branch ? [branch] : []), '--json', 'number,url,state,isDraft,title'];
  return new Promise((done) => {
    execFile('gh', args, { cwd, encoding: 'utf8', timeout: 20_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout) => {
      if (err) return done(null);
      try {
        const j = JSON.parse(stdout);
        if (typeof j.number !== 'number' || typeof j.url !== 'string') return done(null);
        done({ number: j.number, url: j.url, state: String(j.state ?? ''), draft: !!j.isDraft, title: String(j.title ?? '') });
      } catch {
        done(null);
      }
    });
  });
}
