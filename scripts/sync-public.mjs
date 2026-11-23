// Publishes this repository's master to the public repository as one new commit, without its history.
//   node scripts/sync-public.mjs [--push] [--skip-tests] [--message "<subject>"]
// The public repository is a separate clone (default: ../orrery next to this folder; override with ORRERY_PUBLIC_DIR)
// whose history is not connected to this one, so private history (old files, e-mail addresses) never reaches it.
// Without --push it only commits in the public clone, so the result can be looked at before it goes out.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(process.env.ORRERY_PUBLIC_DIR ?? join(root, '..', 'orrery'));
const args = process.argv.slice(2);
const push = args.includes('--push');
const skipTests = args.includes('--skip-tests');
const msgArg = args.indexOf('--message');
const BRANCH_SRC = 'master';
const BRANCH_PUB = 'main';
const TRAILER = 'Synced-From';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitConfig = (cwd, key) => {
  try {
    return git(cwd, 'config', key);
  } catch {
    return '';
  }
};
const log = (msg) => console.log(`[sync-public] ${msg}`);

// Once the public clone's files are touched, any stop puts it back exactly as GitHub has it (checked to be so in 2).
let touchedPub = false;
const restorePub = () => {
  if (!touchedPub) return;
  git(pub, 'reset', '-q', '--hard', `origin/${BRANCH_PUB}`);
  git(pub, 'clean', '-f', '-d', '-q');
  touchedPub = false;
};
const fail = (msg) => {
  console.error(`[sync-public] 中止: ${msg}`);
  if (touchedPub) {
    restorePub();
    console.error(`[sync-public] 公開用のリポジトリは元に戻しました（origin/${BRANCH_PUB} と同じ）。`);
  }
  process.exit(1);
};

// 1. This repository: master, nothing uncommitted (what is tested is exactly what is published).
if (git(root, 'branch', '--show-current') !== BRANCH_SRC) fail(`${BRANCH_SRC} ブランチに切り替えてから実行してください。`);
if (git(root, 'status', '--porcelain')) fail('コミットしていない変更があります。コミットかマージを済ませてください。');
const srcCommit = git(root, 'rev-parse', BRANCH_SRC);
const srcTree = git(root, 'rev-parse', `${BRANCH_SRC}^{tree}`);

// 2. The public clone: exists, clean, on main, same as GitHub, authored with GitHub's no-reply address.
if (!existsSync(join(pub, '.git'))) fail(`公開用のリポジトリが見つかりません: ${pub}（ORRERY_PUBLIC_DIR で場所を指定できます）`);
if (git(pub, 'branch', '--show-current') !== BRANCH_PUB) fail(`公開用のリポジトリを ${BRANCH_PUB} ブランチにしてください: ${pub}`);
if (git(pub, 'status', '--porcelain')) fail(`公開用のリポジトリにコミットしていない変更があります: ${pub}`);
git(pub, 'fetch', '--quiet', 'origin');
if (git(pub, 'rev-parse', 'HEAD') !== git(pub, 'rev-parse', `origin/${BRANCH_PUB}`)) {
  fail(`公開用のリポジトリが GitHub と一致していません（未 push のコミットか、GitHub 側の新しいコミットがあります）: ${pub}`);
}
const pubEmail = gitConfig(pub, 'user.email');
if (!pubEmail.endsWith('@users.noreply.github.com')) {
  fail(`公開用のリポジトリの user.email を GitHub の noreply アドレスにしてください（いま: "${pubEmail}"）:\n  git -C "${pub}" config user.email "<id>+<ユーザー名>@users.noreply.github.com"`);
}

// 3. Every public commit must come from this script (or be the first one). A commit made on GitHub, such as a merged
//    pull request, would be silently overwritten by the next sync, so stop and have it brought here first.
const headIsRoot = git(pub, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 1;
const headTrailer = git(pub, 'log', '-1', `--format=%(trailers:key=${TRAILER},valueonly)`);
if (!headIsRoot && !headTrailer) {
  fail(
    '公開用リポジトリの最新コミットは、このスクリプト以外で作られています（GitHub で PR をマージした等）。\n' +
      '  その変更を先にこのリポジトリへ取り込んでください（例: gh pr diff <番号> -R <公開リポジトリ> | git apply）。\n' +
      `  取り込んだうえで上書きしてよい場合は、公開用のリポジトリで「${TRAILER}: 手動」を付けた空コミットを push してから再実行してください。`,
  );
}

// 4. Nothing that identifies this machine or its owner, in any published file.
//    The patterns come from this machine at run time, so this script itself names nobody.
const user = userInfo().username;
const home = homedir();
const needles = [
  ...new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\'), `Users\\${user}`, `Users/${user}`, gitConfig(root, 'user.email')]),
].filter(Boolean);
let hits = '';
try {
  hits = git(root, 'grep', '-I', '-i', '-n', '-F', ...needles.flatMap((n) => ['-e', n]), BRANCH_SRC);
} catch (e) {
  if (e.status !== 1) throw e; // 1 = no match
}
if (hits) fail(`公開してはいけない文字列（ホームフォルダ・ユーザー名・メールアドレス）が含まれています:\n${hits}`);

// 5. Tests.
if (!skipTests) {
  log('テストを実行しています…');
  try {
    execFileSync('npm', ['test'], { cwd: root, stdio: 'ignore', shell: true });
  } catch {
    fail('npm test が失敗しました。直してから実行してください。');
  }
}

try {
  // 6. Replace the public files with master's. Written by git itself through a throwaway index: the real index of this
  //    repository is not touched, and file names in any language survive (Windows' tar.exe cannot extract the UTF-8
  //    names in git archive's output).
  touchedPub = true;
  git(pub, 'rm', '-r', '-q', '--ignore-unmatch', '.');
  const tmpIndexDir = mkdtempSync(join(tmpdir(), 'orrery-sync-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpIndexDir, 'index') };
    execFileSync('git', ['read-tree', BRANCH_SRC], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', [`--work-tree=${pub}`, 'checkout-index', '-a', '-f'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    rmSync(tmpIndexDir, { recursive: true, force: true });
  }
  git(pub, 'add', '-A');
  if (!git(pub, 'status', '--porcelain')) {
    restorePub();
    log('公開用のリポジトリはすでに最新です。反映するものはありません。');
    process.exit(0);
  }

  // 7. Show what changes. Images cannot be searched for names or paths, so they are listed to be looked at by eye.
  console.log(git(pub, 'diff', '--cached', '--stat'));
  const images = git(pub, 'diff', '--cached', '--name-only', '--diff-filter=AM')
    .split('\n')
    .filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f));
  if (images.length) {
    log('追加・変更された画像があります。個人の情報（パス、名前、メールアドレス、契約内容）が写っていないか目で確認してください:');
    for (const f of images) console.log(`  ${join(pub, f)}`);
  }

  // 8. Commit, then prove the public tree is byte-for-byte master's.
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const subject = msgArg > 0 ? args[msgArg + 1] : `v${version} の更新を反映`;
  execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: pub, input: `${subject}\n\n${TRAILER}: ${srcCommit}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
  const pubTree = git(pub, 'rev-parse', 'HEAD^{tree}');
  if (pubTree !== srcTree) fail(`公開用のコミットの中身が ${BRANCH_SRC} と一致しません（${pubTree} ≠ ${srcTree}）。push していません。`);
  log(`コミットしました: ${git(pub, 'log', '-1', '--format=%h %s')}（中身は ${BRANCH_SRC} と一致）`);
} catch (e) {
  restorePub();
  console.error('[sync-public] 予期しないエラーで中止しました。公開用のリポジトリは元に戻しました。');
  throw e;
}

// 9. Push only when asked.
if (push) {
  git(pub, 'push', '--quiet', 'origin', BRANCH_PUB);
  log(`GitHub に push しました: ${git(pub, 'remote', 'get-url', 'origin')}`);
} else {
  log(`まだ push していません。確認したら: git -C "${pub}" push origin ${BRANCH_PUB}`);
  log(`やめるなら: git -C "${pub}" reset --hard origin/${BRANCH_PUB}`);
}
