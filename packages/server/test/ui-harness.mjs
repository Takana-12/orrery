// UI regression harness: serves the real UI against an invented, frozen server state and saves the DOM of every screen.
// Used to prove that a refactor of the UI changed nothing on the surface.
//   node packages/server/test/ui-harness.mjs <outDir> [port] [uiDir]
// Then open http://127.0.0.1:<port>/ in a browser: the page walks through every screen, posts each DOM here, and this
// process exits when the last one has arrived. Compare two out dirs with `diff -r`.
// Open http://127.0.0.1:<port>/?manual instead to try the UI by hand: nothing is walked, and actions are answered
// after a second (most succeed without changing the data, `fail` in the address makes them refuse) so that the
// immediate feedback and the taking-back on refusal can be seen.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(process.argv[4] ?? resolve(here, '../public'));
const out = resolve(process.argv[2] ?? 'ui-dump');
const port = Number(process.argv[3] ?? 4799);
mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Runs in the page, before the app: a frozen clock, an invented server, and the walk through the screens.
function stub() {
  const NOW = 1795000000000;
  const MANUAL = location.search.includes('manual');
  // ?manual&longdraft: a long request in the home box and the list scrolled, to see what the box lays over the list.
  if (location.search.includes('longdraft')) setTimeout(() => {
    const box = document.querySelector('form.new textarea');
    if (box) { box.value = Array.from({ length: 14 }, (_, i) => `${i + 1}行目: 書くことが多いと入力欄が縦に伸びる。`).join(String.fromCharCode(10)); box.dispatchEvent(new Event('input', { bubbles: true })); }
    setTimeout(() => { const b = document.querySelector('.home .s-body'); if (b) b.scrollTop = 420; }, 300);
  }, 1200);
  if (location.search.includes('light')) document.documentElement.dataset.theme = 'light';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Date.now = () => NOW;
  sessionStorage.setItem('crToken', 'harness');
  try { localStorage.clear(); } catch {}
  const min = 60000;
  const sess = (id, o) => ({
    id, projectId: 'p1', taskId: `t-${id}`, provider: 'claude', projectName: 'orrery', cwd: 'C:\\work\\orrery', taskTitle: id, providerSessionId: `ps-${id}`,
    lifecycle: 'turn_finished', lifecycleSince: NOW - 12 * min, createdAt: NOW - 60 * min, updatedAt: NOW - 12 * min, completion: 'unverified', unread: false, archived: false,
    live: true, process: 'alive', model: 'opus', requestedModel: 'opus', effort: 'medium', approvalMode: 'ask', transcriptRev: 1, resumability: 'resumable', lastText: null, lastTurnOutcome: 'completed', error: null,
    generation: 3, queuePosition: null, activity: null, deferredMessage: null, worktree: null, pullRequest: null, resources: null, background: null, awaitingBackground: false,
    task: { humanSteps: null, acceptanceCriteria: null, checkCommand: null, autoFix: false, fixRounds: 0, maxFixRounds: 2, validation: null, validating: false, acceptedAt: null }, ...o,
  });
  const validation = (ok) => ({ command: 'npm test', ok, exitCode: ok ? 0 : 1, outputTail: ok ? '42 passing' : '1 failing\nAssertionError: expected 2 to equal 3', at: NOW - 4 * min, uncommittedFiles: ok ? 0 : 3 });
  const task = (o) => ({ humanSteps: null, acceptanceCriteria: null, checkCommand: 'npm test', autoFix: true, fixRounds: 1, maxFixRounds: 2, validation: null, validating: false, acceptedAt: null, ...o });
  const sessions = [
    sess('s1', { taskTitle: 'モデル選択をポップオーバーにする', lifecycle: 'waiting_for_user', lifecycleSince: NOW - 2 * min, completion: 'working', resources: { processCount: 3, workingSetBytes: 412e6, privateBytes: 300e6, shared: false, scope: 'この作業のプロセス', sampledAt: NOW }, worktree: { path: 'C:\\data\\wt\\a', branch: 'orrery/261123-abc', removed: false, keptBranch: false }, pullRequest: { number: 128, url: 'https://github.com/example/orrery/pull/128', state: 'OPEN', draft: false, title: 'モデル選択をポップオーバーにする' } }),
    sess('s2', { taskTitle: 'SQLiteストアの移行スクリプト', provider: 'codex', projectName: 'ledger', projectId: 'p2', cwd: 'C:\\work\\ledger', lifecycle: 'running', lifecycleSince: NOW - 7 * min, completion: 'working', model: 'gpt-5.5-codex', effort: 'high', approvalMode: 'auto', activity: { at: NOW - 20000, text: 'npm test -- sqlite-store' }, resources: { processCount: 2, workingSetBytes: 200e6, privateBytes: 100e6, shared: true, scope: '共有', sampledAt: NOW } }),
    sess('s3', { taskTitle: 'トレイアイコンの差し替え', lifecycle: 'running', lifecycleSince: NOW - 31 * min, completion: 'working', activity: { at: NOW - 5 * min, text: 'make-icons.mjs を編集中' }, deferredMessage: '終わったら install-app も流して' }),
    sess('s4', { taskTitle: 'E2Eのフレーク調査', lifecycle: 'queued', queuePosition: 1, completion: 'working', live: false, process: 'not_started' }),
    sess('s5', { taskTitle: 'Runbookの更新', unread: true, lastText: '04-Runbook.md に起動手順とトラブルシュートを追記しました。' }),
    sess('s6', { taskTitle: '起動時のメモリ計測', lifecycleSince: NOW - 3 * 60 * min, updatedAt: NOW - 3 * 60 * min, live: false, process: 'stopped' }),
    sess('s7', { taskTitle: 'Windowsジョブの後始末', provider: 'codex', lifecycle: 'error', error: 'プロセスが異常終了しました', lifecycleSince: NOW - 50 * min, completion: 'working', live: false, unread: true, resumability: 'unrecoverable' }),
    sess('s8', { taskTitle: '検証に通った作業', completion: 'candidate', task: task({ validation: validation(true) }) }),
    sess('s9', { taskTitle: '検証に落ちた作業', completion: 'needs_fix', unread: true, task: task({ validation: validation(false) }) }),
    sess('s10', { taskTitle: 'リリース手順の残り', completion: 'human_steps', lastText: '実装は終わりました。`npm run install-app` を実行してください。', task: task({ checkCommand: null, humanSteps: [{ title: 'アプリを入れ直す', detail: 'ビルドに1分ほどかかります', command: 'npm run install-app', after: 'いま回しているテストが通ってから', done: false }, { title: '入れ直したアプリで動作を確かめる', detail: null, command: null, after: 'アプリを入れ直してから', done: false }, { title: 'PRをマージする', detail: null, command: null, after: null, done: true }] }) }),
    sess('s11', { taskTitle: '途中で止めた作業', lifecycle: 'interrupted', lifecycleSince: NOW - 20 * min, completion: 'working', live: false, lastTurnOutcome: 'interrupted', resources: { processCount: 2, workingSetBytes: 90e6, privateBytes: 50e6, shared: false, scope: 'この作業のプロセス', sampledAt: NOW } }),
    sess('s12', { taskTitle: '検証中の作業', completion: 'validating', task: task({ validating: true }) }),
    sess('s13', { taskTitle: '片付けた作業', archived: true, completion: 'accepted', live: false, task: task({ acceptedAt: NOW - 100 * min, validation: validation(true) }), worktree: { path: 'C:\\data\\wt\\b', branch: 'orrery/261122-def', removed: true, keptBranch: true } }),
    sess('s14', { taskTitle: '文章で質問された作業', lastText: 'AとBのどちらにしますか？', unread: true }),
    sess('s16', { taskTitle: '要対応画面の不要文言削除', completion: 'human_steps', lastText: '要対応画面の文言を2つ消しました。ブラウザを再読み込みして確かめてください。', task: task({ checkCommand: null, humanSteps: [
      { title: '「自動で進めます」という文言が表示されない', detail: 'ホームの「あなたの作業」の見出しのすぐ下（以前は見出しの下に1行で出ていた）', command: null, after: null, done: false, check: { update: 'reload', how: null, command: null } },
      { title: '「あとで見る」ボタンが表示されない', detail: 'ホームの「返答が完了した作業」の各行の右端（「完了にする」の左にあった）', command: null, after: null, done: false, check: { update: 'reload', how: null, command: null } },
    ] }) }),
    sess('s17', { taskTitle: '進行中作業のプレビュー表示の段数固定', completion: 'human_steps', task: task({ checkCommand: null, humanSteps: [
      { title: '進行中の作業の行が、プレビューの長さによらず1行のまま変わらない', detail: 'ホームの「進行中の作業」。作業の進み具合の文が切り替わる数秒ごとに見る', command: null, after: null, done: false, check: { update: 'rebuild', how: '設定 → アプリの更新 の「更新」を押す', command: null } },
      { title: 'はみ出したプレビューの末尾が「…」で切れている', detail: '同じ行の右側。マウスを重ねると全文が出る', command: null, after: null, done: true, check: { update: 'rebuild', how: '設定 → アプリの更新 の「更新」を押す', command: null } },
    ] }) }),
    // The action the checks need first, as a step of its own: the checks wait until it is ticked.
    sess('s18', { taskTitle: 'ポートフォリオの書体変更', projectName: 'ledger', projectId: 'p2', cwd: 'C:\\work\\ledger', completion: 'human_steps', task: task({ checkCommand: null, humanSteps: [
      { title: 'アプリを更新する', detail: '変更を取り込むため、返答にある `npx next dev --webpack` で開発サーバーを起動し、ブラウザでトップを開く', command: null, after: null, done: false, prep: true },
      { title: '見出し・日付・ラベル・ナビなどの短い文字がドット書体になっている', detail: 'トップ、作品一覧、作品詳細、経歴の各ページの見出し・日付・ラベル・ナビ', command: null, after: null, done: false, check: { update: 'rebuild', how: '変更を取り込むため、返答にある `npx next dev --webpack` で開発サーバーを起動し、ブラウザでトップを開く', command: null } },
      { title: 'スマホ幅で、レイアウトが崩れていない', detail: 'ブラウザの表示幅をスマホ幅に狭めたトップ、作品詳細、経歴の各ページ', command: null, after: null, done: false, check: { update: 'rebuild', how: '変更を取り込むため、返答にある `npx next dev --webpack` で開発サーバーを起動し、ブラウザでトップを開く', command: null } },
    ] }) }),
    sess('s15', { taskTitle: 'テストの完了を待っている作業', lifecycle: 'running', lifecycleSince: NOW - 4 * min, completion: 'working', lastText: 'E2Eテストをバックグラウンドで回しています。終わったら報告します。', background: ['npm run e2e'], awaitingBackground: true }),
  ];
  const item = (id, sessionId, o) => {
    const s = sessions.find((x) => x.id === sessionId);
    return { id, sessionId, projectId: s.projectId, projectName: s.projectName, status: 'pending', responseCapability: 'live', createdAt: NOW - 2 * min, taskTitle: s.taskTitle, allowDecline: false, passive: false, questions: null, approval: null, rawPayloadRef: `raw-${id}`, response: null, acknowledgement: null, expiredReason: null, source: { provider: s.provider, requestId: 'req-' + id, providerSessionId: 'abc', generation: 3, turnId: null }, ...o };
  };
  const items = [
    item('i1', 's1', { type: 'permission_approval', summary: 'Bash の実行承認', approval: { tool: 'Bash', subject: 'npm run package', cwd: 'C:\\work\\orrery', reason: 'パッケージを作り直して見た目を確認します', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'], changes: null } }),
    item('i2', 's1', { type: 'user_question', summary: 'メニューはどちら向きに開きますか', createdAt: NOW - 3 * min, questions: [{ id: 'q1', header: null, text: 'メニューはどちら向きに開きますか', options: [{ label: '下に開く', description: '収まらないときだけ上' }, { label: '常に上に開く', description: null }], multiSelect: false, allowFreeText: true, isSecret: false }, { id: 'q2', header: null, text: '対象の画面', options: [{ label: '新規', description: null }, { label: '設定', description: null }], multiSelect: true, allowFreeText: false, isSecret: false, optional: true }] }),
    item('i3', 's1', { type: 'permission_approval', summary: 'Edit: ファイル変更の承認', createdAt: NOW - 1 * min, approval: { tool: 'Edit', subject: 'update: C:\\work\\orrery\\a.js', cwd: 'C:\\work\\orrery', reason: null, decisions: ['accept', 'decline'], changes: [{ path: 'C:\\work\\orrery\\a.js', kind: 'update', diff: '-const a = 1;\n+const a = 2;\n@@\n-old\n+new' }] } }),
    item('i4', 's14', { type: 'user_question', summary: 'AとBのどちらにしますか', allowDecline: true, passive: true, context: '設定画面の保存処理を調べました。\n\n## 方針\n- **A**: 保存ボタンを押したときだけ保存する（今の動き）。`settings.ts` の `save()` に検証を足す\n- **B**: 入力のたびに自動保存する。`debounce` で 500ms まとめる\n\nB のほうが手間は少ないですが、途中の値が保存されます。\n\nAとBのどちらにしますか？', source: { provider: 'claude', requestId: 'final:123', providerSessionId: 'abc', generation: 3, turnId: null }, questions: [{ id: 'answer', header: null, text: 'AとBのどちらにしますか', options: [{ label: 'A', description: null }, { label: 'B', description: null }], multiSelect: false, allowFreeText: true, isSecret: false }] }),
    item('i5', 's2', { type: 'permission_approval', status: 'answering', summary: 'コマンド実行の承認', createdAt: NOW - 9 * min, response: { answer: { kind: 'decision', decision: 'accept' }, sentAt: NOW - 60000 }, approval: { tool: 'shell', subject: 'git push', cwd: 'C:\\work\\ledger', reason: null, decisions: ['accept', 'decline', 'cancel'], changes: null } }),
    item('i6', 's5', { type: 'permission_approval', status: 'resolved', summary: '済み', createdAt: NOW - 30 * min, approval: { tool: 'Bash', subject: 'ls', cwd: null, reason: null, decisions: ['accept', 'decline'], changes: null } }),
  ];
  const live = sessions.filter((s) => !s.archived);
  const state = {
    now: NOW, generation: 3,
    counts: { needsAttention: items.filter((i) => i.status === 'pending').length, humanTasks: 1, running: 3, queued: 1, waiting: 1, turnFinished: live.filter((s) => s.lifecycle === 'turn_finished').length, problems: 2, candidates: 1, needsFix: 1, archived: 1, unread: live.filter((s) => s.unread).length },
    resources: { processCount: 7, workingSetBytes: 913e6, scope: 'エージェントのプロセスの合計' },
    auth: { claude: { loggedIn: true, plan: 'max', loginInProgress: false, error: null }, codex: { loggedIn: false, plan: null, loginInProgress: false, error: null } },
    sessions, items,
    queue: { blockedBy: 'slots', length: 1, freeMemoryMB: 6120 },
    settings: { maxConcurrent: 3, minFreeMemoryMB: 1500, confirmCommands: true, sideChat: { provider: 'claude', model: 'sonnet', effort: 'low' }, knowledge: { capture: true, inject: true }, voice: { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: !location.search.includes('noconfirm') } },
    voice: { model: { state: location.search.includes('nomodel') ? 'missing' : 'ready', progress: 1, bytes: 239549735, label: 'SenseVoice Small', error: null } },
    chats: [],
    projects: [{ id: 'p1', name: 'orrery', rootPath: 'C:\\work\\orrery', createdAt: NOW, envCount: 2 }, { id: 'p2', name: 'ledger', rootPath: 'C:\\work\\ledger', createdAt: NOW, envCount: 0 }],
    capabilities: {},
    // One prompt per section: normal, near the attachment limit, over it, and two not yet looked at.
    knowledge: {
      domains: [
        { id: 'ui', name: 'UI・操作感', description: '画面の見た目、操作したときの反応、レイアウト、表示する言葉の量', always: false, order: 0 },
        { id: 'writing', name: '文章・言葉づかい', description: '文章の構成、言葉の選び方、説明や報告の書き方', always: false, order: 1 },
        { id: 'workflow', name: '進め方・git・報告', description: '作業の進め方、ブランチやコミット、マージ、報告のしかた', always: true, order: 2 },
        { id: 'other', name: 'その他', description: 'どの領域にも当てはまらないこだわり', always: false, order: 3 },
      ],
      entries: [
        { id: 'k1', domainId: 'ui', text: '操作したら、確定を待たずにその場で画面を変える。断られたら元に戻して理由を出す。\n\n新しい種類の状態を作ったら、必ず inbox から辿れるようにする。', sessionId: 's1', scope: 'all', hits: 5, createdAt: NOW - 90 * min, updatedAt: NOW - 30 * min, seen: true },
        { id: 'k3', domainId: 'writing', text: '報告は結論から書く。' + '補足は短く、専門用語は最初に一度だけ説明する。'.repeat(180), sessionId: 's2', scope: 'all', hits: 1, createdAt: NOW - 5 * min, updatedAt: NOW - 5 * min, seen: false },
        { id: 'k4', domainId: 'workflow', text: '新しい作業は新しいブランチで進め、終わったらマージする。', sessionId: 's3', scope: 'all', hits: 2, createdAt: NOW - 3 * min, updatedAt: NOW - 3 * min, seen: false },
        { id: 'kx', domainId: 'other', text: '以前に保存した長いプロンプトも、削らず残しておく。'.repeat(240), sessionId: null, scope: 'all', hits: 1, createdAt: NOW - 200 * min, updatedAt: NOW, seen: true },
      ],
      unseen: 2,
      limits: { sectionText: 5000, domainName: 40, domainDescription: 200, domains: 30, routeThreshold: 1500, maxRoutedDomains: 3 },
      heading: '## ユーザーのこだわり（この作業に関係する領域のみ）',
      // The こだわり chat: one message read into changes of every kind, one that could not be read, one being read.
      tune: {
        busy: true,
        max: 12000,
        messages: [
          { id: 't1', role: 'human', text: '保存ボタンは右に置いて。あと、確認ダイアログは出さないで取り消せるようにしてほしい。', at: NOW - 20 * min },
          { id: 't2', role: 'ai', text: 'ボタンの置き場所を新しく記録し、取り消しの決まりを書き直しました。', at: NOW - 19 * min, changes: [
            { kind: 'domain', domain: '操作の安全', text: '取り消し・確認・破壊的な操作の扱い' },
            { kind: 'add', domain: 'UI・操作感', text: '決定・保存のボタンは並びの右端に置く。' },
            { kind: 'update', domain: '操作の安全', text: '操作は確認ダイアログではなく、あとから取り消せる形にする。' },
            { kind: 'move', domain: 'その他', text: 'その他のこだわり 1' },
            { kind: 'remove', domain: 'UI・操作感', text: '確認ダイアログを出す。' },
            { kind: 'reinforce', domain: 'UI・操作感', text: '操作したら、確定を待たずにその場で画面を変える。' },
          ] },
          { id: 't3', role: 'human', text: 'よろしく', at: NOW - 10 * min },
          { id: 't4', role: 'ai', text: '読み取れませんでした。もう一度送ってください。', at: NOW - 9 * min, changes: [], failed: true },
          { id: 't5', role: 'human', text: 'コミットメッセージは英語で', at: NOW - 1 * min },
        ],
      },
    },
  };
  const MODELS = {
    claude: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true }, { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'haiku', label: 'Haiku 5.5', efforts: [] }],
    codex: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], isDefault: true }, { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: ['low', 'medium', 'high'] }],
  };
  const transcript = [
    { seq: 1, role: 'user', at: NOW - 14 * min, text: 'モデル選択を、押した場所に開くメニューにして。' },
    { seq: 2, role: 'assistant', at: NOW - 13 * min, text: 'いまの `openModelSheet` を外します。先に依存を確認します。' },
    { seq: 3, role: 'tool', at: NOW - 13 * min, text: '▶ Grep {"pattern":"openModelSheet","path":"packages/server/public"}' },
    { seq: 4, role: 'tool', at: NOW - 13 * min, text: '✔ packages/server/public/app.js:363\nsecond line' },
    { seq: 5, role: 'tool', at: NOW - 12 * min, text: '$ npm test\n[completed exit=0]\nok' },
    { seq: 6, role: 'system', at: NOW - 12 * min, text: '検証 成功: npm test（終了コード 0）' },
    { seq: 7, role: 'assistant', at: NOW - 3 * min, text: '終わりました。次を実行してください。\n\n```\nnpm run package\n```\n\nまたは `git status` で確認。`notACommand` はそのまま。' },
    { seq: 8, role: 'assistant', at: NOW - 2 * min, text: '## 変更点\n\n- **メニュー**: 押した場所に開くようにしました\n  - `Esc` で閉じます\n  - 外側をクリックしても閉じます\n- ~~シート~~ は削除\n\n### 確認\n\n1. [x] `npm test` が通る\n2. [ ] 実機で確認\n\n> 補足: 古い設定は *そのまま* 読めます。\n\n| 画面 | 状態 |\n|:--|--:|\n| 受信箱 | 済み |\n| 設定 | **未着手** |\n\n詳しくは [Electron のドキュメント](https://www.electronjs.org/docs) か https://example.com/a_(b) を参照。\n\n---\n\n<b>HTMLはそのまま文字</b>' },
  ];
  const chatWords = new Map();
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let push = () => {};
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const path = String(url);
    if (path.startsWith('/__')) return realFetch(url, init);
    if (path === '/api/stream') return new Response(new ReadableStream({ start(c) { push = () => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(state)}\n\n`)); push(); } }));
    let m;
    if ((m = path.match(/^\/api\/models\/(\w+)/))) return json({ models: MODELS[m[1]] ?? [] });
    // Side chats, by hand: a message is answered a second later with what was said, word for word.
    if ((m = path.match(/^\/api\/chats\/([\w-]+)\/transcript\?after=(\d+)/))) return json({ entries: (chatWords.get(m[1]) ?? []).filter((e) => e.seq > Number(m[2])) });
    if (MANUAL && init?.method === 'POST' && (m = path.match(/^\/api\/chats(?:\/([\w-]+)\/(message|choice|interrupt|close))?$/))) {
      if (location.search.includes('fail')) { await sleep(800); return json({ error: 'ハーネスが断りました（失敗時の表示の確認用）' }, 409); }
      const body = JSON.parse(init.body);
      let id = m[1];
      if (!id) {
        id = `chat-h${state.chats.length + 1}`;
        state.chats.push({ id, title: body.prompt.split(String.fromCharCode(10))[0].slice(0, 40), createdAt: NOW, provider: body.provider, model: body.model, effort: body.effort, state: 'idle', error: null, activeModel: null, startedWith: body.provider, live: true, transcriptRev: 0 });
      }
      const c = state.chats.find((x) => x.id === id);
      if (m[2] === 'close') { state.chats.splice(state.chats.indexOf(c), 1); push(); return json({ ok: true }); }
      if (m[2] === 'choice') { Object.assign(c, { provider: body.provider, model: body.model, effort: body.effort }); push(); return json({ ok: true }); }
      if (m[2] === 'interrupt') { c.state = 'interrupted'; push(); return json({ ok: true }); }
      const words = chatWords.get(id) ?? chatWords.set(id, []).get(id);
      const said = body.text ?? body.prompt;
      words.push({ seq: words.length + 1, role: 'user', at: NOW, text: said });
      c.state = 'running'; c.transcriptRev++;
      setTimeout(() => {
        words.push({ seq: words.length + 1, role: 'tool', at: NOW, text: '▶ WebSearch {"query":"' + said.slice(0, 20) + '"}' });
        words.push({ seq: words.length + 1, role: 'assistant', at: NOW, text: `「${said}」ですね。

- **要点**: ここに答えが入ります
- コードは \`npm test\` のように表示されます（実行ボタンにはなりません）` });
        c.state = 'idle'; c.transcriptRev++; push();
      }, 1500);
      push();
      return json(m[1] ? { ok: true } : { chatId: id });
    }
    if (/\/transcript(\?|$)/.test(path)) return json({ entries: path.includes('?') ? [] : transcript });
    if (path === '/api/usage') {
      const u = (pct) => ({ limits: [{ label: '5時間枠', kind: 'five_hour', usedPercent: pct, state: 'ok', resetsAt: NOW + 95 * min }, { label: '週間枠', kind: 'weekly', usedPercent: pct + 58, state: 'warning', resetsAt: NOW + 3 * 1440 * min }], limitsAt: NOW, limitsError: null, today: { input: 412000, output: 58000, cached: 0, turns: 23 }, week: { input: 3.4e6, output: 410000, cached: 0, turns: 164 } });
      return json({ claude: u(34), codex: u(12) });
    }
    if (path === '/api/storage') return json({ bytes: 48e6, events: 100, transcriptEntries: 5210, rawPayloads: 940, sessions: 61, archivedSessions: 4 });
    if (path === '/api/app-update') return json({ mode: 'console' });
    if (/\/env$/.test(path)) return json({ vars: [{ name: 'DATABASE_URL', length: 42, updatedAt: NOW }, { name: 'SENTRY_DSN', length: 61, updatedAt: NOW }] });
    if (/\/api\/raw\//.test(path)) return json({ hello: 'raw' });
    if (/\/seen$/.test(path)) return json({ ok: true });
    // A step's command, by hand: it runs, its output is read, and what is left replaces it (as the server does).
    if (MANUAL && init?.method === 'POST' && (m = path.match(/^\/api\/sessions\/([\w-]+)\/run$/)) && !location.search.includes('fail')) {
      const body = JSON.parse(init.body);
      const steps = state.sessions.find((x) => x.id === m[1])?.task?.humanSteps;
      const at = steps?.findIndex((x) => x.command === body.command && !x.done) ?? -1;
      if (at < 0) { await sleep(800); return json({ ok: true, exitCode: 0, output: 'ok', step: null }); }
      const run = (o) => { steps[at].run = { id: body.runId, at: NOW, ok: null, exitCode: null, outputTail: null, note: null, ...steps[at].run, ...o }; push(); };
      run({ phase: 'running' });
      await sleep(1500);
      run({ phase: 'reading', ok: false, exitCode: 1, outputTail: '? 本番に出す commit: 3件。承認しますか? (y/N)\nError: 入力がありません（非対話モード）' });
      await sleep(1500);
      run({ phase: 'settled', note: '承認の確認が出ましたが、入力できないため止まりました。ターミナルで実行して承認する必要があります。' });
      const last = steps[at].run;
      steps.splice(at, 1, { title: 'ターミナルで npm run install-app を実行し、表示される一覧を見て承認する', detail: '承認の確認には入力が必要です', command: null, after: null, done: false, run: last });
      push();
      return json({ ok: false, exitCode: 1, output: last.outputTail, step: { done: false, note: last.note, completed: false } });
    }
    // Explorer, by hand: it "picks" C:\work\atlas; registering it adds the project to the next picture a second later.
    // Voice input, by hand (?manual): whatever is said, the same two pieces of work are heard and planned.
    if (MANUAL && path === '/api/voice/prepare') return json({ ok: true });
    if (MANUAL && path === '/api/voice/transcribe') {
      await sleep(900);
      return location.search.includes('fail') ? json({ text: '' }) : json({ text: 'orreryのホーム画面のバグを直して。それとledgerの移行スクリプトにテストを足して、こっちはCodexでお願い。' });
    }
    if (MANUAL && path === '/api/voice/plan') {
      await sleep(1400);
      return json({ tasks: [
        { projectId: 'p1', provider: 'claude', model: 'opus', effort: 'medium', prompt: 'ホーム画面のバグを直して。' },
        { projectId: 'p2', provider: 'codex', model: 'gpt-5.5-codex', effort: 'medium', prompt: '移行スクリプトにテストを足して。' },
      ] });
    }
    if (MANUAL && path === '/api/pick-folder') { await sleep(300); return json({ path: 'C:\\work\\atlas' }); }
    if (MANUAL && path === '/api/projects' && !location.search.includes('fail')) {
      await sleep(1000);
      const rootPath = JSON.parse(init.body).path;
      let p = state.projects.find((x) => x.rootPath === rootPath);
      if (!p) { p = { id: `p${state.projects.length + 1}`, name: rootPath.split('\\').pop(), rootPath, createdAt: NOW, envCount: 0 }; state.projects.push(p); setTimeout(push, 1000); }
      return json({ projectId: p.id });
    }
    if (MANUAL && init?.method === 'POST') {
      await sleep(1000);
      if (location.search.includes('fail')) return json({ error: 'ハーネスが断りました（失敗時の表示の確認用）' }, 409);
      if ((m = path.match(/^\/api\/sessions\/([\w-]+)\/message$/))) {
        const body = JSON.parse(init.body);
        const s = state.sessions.find((x) => x.id === m[1]);
        if (s && body.effort !== undefined) { s.effort = body.effort; push(); }
      }
      return json(/\/message$/.test(path) ? { resumed: false, queued: false } : /\/step$/.test(path) ? { completed: false } : { ok: true });
    }
    return json({ error: 'ハーネスなので、ここから先は動きません' }, 409);
  };

  const dump = (name) => realFetch(`/__dump?name=${encodeURIComponent(name)}`, { method: 'POST', body: document.querySelector('.app').outerHTML + '\n<!-- title: ' + document.title + ' -->\n<!-- banner: ' + document.getElementById('banner').textContent + ' -->' });
  window.addEventListener('load', async () => {
    if (MANUAL) return;
    await sleep(600);
    const routes = ['#/', ...sessions.map((s) => `#/s/${s.id}`), '#/s/none', '#/new', '#/archive', '#/settings', '#/knowledge', '#/knowledge/tune', '#/usage', '#/env/p1', '#/env/none', '#/'];
    let n = 0;
    for (const r of routes) {
      location.hash = r;
      await sleep(450);
      await dump(`${String(++n).padStart(2, '0')}-${r.replace(/[^\w]+/g, '_')}`);
    }
    // A few interactions: collapse/expand a ticket, an empty answer, the menu of a picker.
    document.querySelector('[data-item] .tg')?.click();
    await sleep(150);
    await dump('90-ticket-toggled');
    document.querySelectorAll('[data-item] .tg')[1]?.click();
    await sleep(150);
    document.querySelector('[data-item="i2"] [data-submit]')?.click();
    await sleep(150);
    await dump('91-empty-answer');
    location.hash = '#/new';
    await sleep(450);
    document.querySelector('.new .chip')?.click();
    await sleep(150);
    await realFetch('/__dump?name=92-menu', { method: 'POST', body: document.querySelector('.menu')?.outerHTML ?? 'no menu' });
    await realFetch('/__done', { method: 'POST' });
    document.title = 'HARNESS DONE';
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (req.method === 'POST' && url.pathname === '/__dump') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // One element per line, so a difference is readable in a diff.
      writeFileSync(join(out, `${url.searchParams.get('name')}.html`), Buffer.concat(chunks).toString('utf8').replace(/></g, '>\n<'));
      res.end('ok');
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__done') {
    res.end('ok');
    console.log(`[ui-harness] done: ${out}`);
    return void setTimeout(() => process.exit(0), 200);
  }
  if (url.pathname === '/') {
    const page = readFileSync(join(pub, 'index.html'), 'utf8').replace(/<script /, `<script>(${stub.toString()})();</script>\n<script `);
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    return void res.end(page);
  }
  const file = normalize(join(pub, url.pathname));
  const ext = file.slice(file.lastIndexOf('.'));
  if (!file.startsWith(pub) || !TYPES[ext] || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[ext], 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
server.listen(port, '127.0.0.1', () => console.log(`[ui-harness] open http://127.0.0.1:${port}/  ->  ${out}`));
