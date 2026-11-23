// What the source in the repository looks like right now: the commit plus a fingerprint of uncommitted changes.
// Compared with the build-info.json of the running app to tell whether an update is available.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** @returns {{ commit: string | null, subject: string | null, dirty: boolean, fingerprint: string | null }} */
export function sourceState(root) {
  try {
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    const subject = git(root, ['log', '-1', '--format=%s']).trim();
    const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
    const diff = status ? git(root, ['diff', 'HEAD', '--binary']) : '';
    const fingerprint = createHash('sha1').update(commit).update('\0').update(status).update('\0').update(diff).digest('hex').slice(0, 16);
    return { commit, subject, dirty: status.length > 0, fingerprint };
  } catch {
    return { commit: null, subject: null, dirty: false, fingerprint: null };
  }
}
