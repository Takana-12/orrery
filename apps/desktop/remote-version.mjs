// Whether the repository this app is built from has a newer version on GitHub, and bringing it in.
// Someone who installed Orrery with "git clone" has a branch that tracks origin/main: a fetch tells whether it has moved
// on. A repository without an upstream (a private development copy) is simply never checked.
import { execFile } from 'node:child_process';

const run = (cwd, file, args, timeout = 120_000) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || stdout || err.message).trim().split(/\r?\n/).slice(-6).join('\n');
        reject(Object.assign(new Error(msg || String(err.message)), { stdout, stderr }));
      } else resolve(String(stdout).trim());
    });
  });
const git = (cwd, ...args) => run(cwd, 'git', args);

/** The upstream of the current branch ("origin/main"), or null when there is none (or no branch). */
async function upstream(repo) {
  try {
    return await git(repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  } catch {
    return null;
  }
}

/**
 * Fetch the upstream and compare.
 * @returns {Promise<{ tracking: string | null, behind: number, ahead: number, latest: { commit: string, subject: string } | null, checkedAt: number }>}
 *   `behind`: commits on GitHub that this copy does not have yet. Throws when the fetch fails (offline, no access).
 */
export async function checkRemote(repo) {
  const tracking = await upstream(repo);
  const checkedAt = Date.now();
  if (!tracking) return { tracking: null, behind: 0, ahead: 0, latest: null, checkedAt };
  const remote = tracking.split('/')[0];
  await run(repo, 'git', ['fetch', '--quiet', '--no-tags', remote], 60_000);
  const [ahead, behind] = (await git(repo, 'rev-list', '--left-right', '--count', 'HEAD...@{u}')).split(/\s+/).map(Number);
  let latest = null;
  if (behind > 0) {
    const [commit, subject] = (await git(repo, 'log', '-1', '--format=%H%x00%s', '@{u}')).split('\0');
    latest = { commit, subject };
  }
  return { tracking, behind, ahead, latest, checkedAt };
}

const DEP_FILES = ['package.json', 'package-lock.json'];

/**
 * Bring the upstream in (fast-forward only: a copy with its own commits is never merged into by itself).
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ from: string, to: string, depsChanged: boolean }>}
 */
export async function pullRemote(repo, log = () => {}) {
  const from = await git(repo, 'rev-parse', 'HEAD');
  log('$ git pull --ff-only');
  try {
    const out = await run(repo, 'git', ['pull', '--ff-only', '--no-rebase'], 180_000);
    if (out) for (const line of out.split(/\r?\n/)) log(line);
  } catch (e) {
    throw new Error(`GitHub から新しい版を取り込めませんでした。手元でファイルやコミットを変えている場合は、それを退けてから（git stash など）もう一度押してください。\n${e.message}`);
  }
  const to = await git(repo, 'rev-parse', 'HEAD');
  const changed = from === to ? '' : await git(repo, 'diff', '--name-only', from, to, '--', ...DEP_FILES);
  return { from, to, depsChanged: changed.length > 0 };
}

/** npm install in the repository (npm is npm.cmd on Windows, so through cmd). */
export async function installDeps(repo, log = () => {}) {
  log('$ npm install');
  try {
    const out = await run(repo, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install --no-audit --no-fund'], 600_000);
    if (out) for (const line of out.split(/\r?\n/).slice(-10)) log(line);
  } catch (e) {
    throw new Error(`npm install に失敗しました。コマンドプロンプトで「npm install」を実行してから、もう一度押してください。\n${e.message}`);
  }
}
