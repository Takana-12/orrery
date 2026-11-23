// Mock-up only: stands in for the Orrery server so the real UI code can run from a single HTML file with invented data.
'use strict';
(() => {
  sessionStorage.setItem('crToken', 'mock');
  const now = Date.now();
  const min = 60000;
  const sess = (id, o) => ({ id, provider: 'claude', projectName: 'orrery', cwd: 'C:\\work\\orrery', taskTitle: id, lifecycle: 'turn_finished', lifecycleSince: now - 12 * min, updatedAt: now - 12 * min, completion: 'unverified', unread: false, archived: false, live: true, process: null, model: 'Opus 5.5', effort: 'medium', approvalMode: 'ask', transcriptRev: 1, resumability: 'ok', task: { humanSteps: null }, ...o });
  const sessions = [
    sess('s1', { taskTitle: 'モデル選択をポップオーバーにする', lifecycle: 'waiting_for_user', lifecycleSince: now - 2 * min, completion: null, resources: { processCount: 3, workingSetBytes: 412e6, shared: false, scope: 'この作業のプロセス', sampledAt: now } }),
    sess('s2', { taskTitle: 'SQLiteストアの移行スクリプト', provider: 'codex', projectName: 'ledger', cwd: 'C:\\work\\ledger', lifecycle: 'running', lifecycleSince: now - 7 * min, completion: null, model: 'gpt-5.5-codex', effort: 'high', activity: { at: now - 20000, text: 'npm test -- sqlite-store' } }),
    sess('s3', { taskTitle: 'トレイアイコンの差し替え', lifecycle: 'running', lifecycleSince: now - 31 * min, completion: null, activity: { at: now - 5 * min, text: 'make-icons.mjs を編集中' }, deferredMessage: '終わったら install-app も流して' }),
    sess('s4', { taskTitle: 'E2Eのフレーク調査', lifecycle: 'queued', queuePosition: 1, completion: null, live: false }),
    sess('s5', { taskTitle: 'Runbookの更新', unread: true, lastText: '04-Runbook.md に起動手順とトラブルシュートを追記しました。' }),
    sess('s6', { taskTitle: '起動時のメモリ計測', lifecycleSince: now - 3 * 60 * min, updatedAt: now - 3 * 60 * min, live: false }),
    sess('s7', { taskTitle: 'Windowsジョブの後始末', provider: 'codex', lifecycle: 'error', error: 'プロセスが異常終了しました', lifecycleSince: now - 50 * min, completion: null, live: false }),
  ];
  const item = (id, sessionId, o) => ({ id, sessionId, status: 'pending', createdAt: now - 2 * min, taskTitle: sessions.find((s) => s.id === sessionId).taskTitle, source: { provider: sessions.find((s) => s.id === sessionId).provider, requestId: 'req-' + id, providerSessionId: 'abc', generation: 1 }, ...o });
  const items = [
    item('i1', 's1', { type: 'approval', summary: 'npm run package', approval: { tool: 'Bash', subject: 'npm run package', cwd: 'C:\\work\\orrery', reason: 'パッケージを作り直して見た目を確認します', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } }),
    item('i2', 's1', { type: 'user_question', summary: 'メニューはどちら向きに開きますか', allowDecline: false, questions: [{ id: 'q1', text: 'メニューはどちら向きに開きますか', options: [{ label: '下に開く', description: '収まらないときだけ上' }, { label: '常に上に開く' }], multiSelect: false, allowFreeText: true, optional: false }] }),
  ];
  const state = {
    counts: { needsAttention: 2, humanTasks: 0, running: 2, turnFinished: 2, problems: 1, archived: 4, queued: 1, unread: 1 },
    resources: { processCount: 7, workingSetBytes: 913e6, scope: 'エージェントのプロセスの合計' },
    auth: { claude: { loggedIn: true, plan: 'Max', loginInProgress: false }, codex: { loggedIn: true, plan: 'Pro', loginInProgress: false } },
    sessions, items,
    queue: { blockedBy: 'slots', length: 1, freeMemoryMB: 6120 },
    settings: { maxConcurrent: 3, minFreeMemoryMB: 1500 },
    projects: [{ id: 'p1', name: 'orrery', rootPath: 'C:\\work\\orrery', envCount: 2 }, { id: 'p2', name: 'ledger', rootPath: 'C:\\work\\ledger', envCount: 0 }, { id: 'p3', name: 'starchart-site', rootPath: 'D:\\sites\\starchart', envCount: 0 }],
  };
  const MODELS = {
    claude: [
      { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
      { id: 'fable', label: 'Fable 5.2', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
      { id: 'haiku', label: 'Haiku 5.5', efforts: [] },
    ],
    codex: [
      { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], isDefault: true },
      { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', efforts: ['low', 'medium', 'high'] },
    ],
  };
  const transcript = [
    { seq: 1, role: 'user', at: now - 14 * min, text: 'モデル選択を、画面全体のオーバーレイではなく、押した場所に開くメニューにして。' },
    { seq: 2, role: 'assistant', at: now - 13 * min, text: 'いまの `openModelSheet` を外して、チップの位置に開くメニューへ置き換えます。先に依存を確認します。' },
    { seq: 3, role: 'tool', at: now - 13 * min, text: '▶ Grep {"pattern":"openModelSheet","path":"packages/server/public"}' },
    { seq: 4, role: 'tool', at: now - 13 * min, text: '✔ packages/server/public/app.js:363' },
    { seq: 5, role: 'assistant', at: now - 3 * min, text: '置き換えが終わりました。見た目を確かめるために、次を実行します。\n\n```\nnpm run package\n```' },
  ];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url) => {
    const path = String(url);
    if (path === '/api/stream') {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(state)}\n\n`)); } }));
    }
    let m;
    if ((m = path.match(/^\/api\/models\/(\w+)/))) return json({ models: MODELS[m[1]] ?? [] });
    if (/\/transcript(\?|$)/.test(path)) return json({ entries: path.includes('?') ? [] : transcript });
    if (path === '/api/usage') {
      const u = (pct) => ({ limits: [{ label: '5時間', usedPercent: pct, state: 'ok', resetsAt: now + 95 * min }, { label: '週', usedPercent: pct + 38, state: 'warning', resetsAt: now + 3 * 1440 * min }], today: { input: 412000, output: 58000, turns: 23 }, week: { input: 3.4e6, output: 410000, turns: 164 } });
      return json({ claude: u(34), codex: u(12) });
    }
    if ((m = path.match(/^\/api\/attachments\?name=(.*)$/))) return json({ name: decodeURIComponent(m[1]), path: 'C:\\Users\\you\\AppData\\Local\\AgentControlRoom\\attachments\\3f2a\\' + decodeURIComponent(m[1]), size: 1 });
    if (path === '/api/storage') return json({ bytes: 48e6, transcriptEntries: 5210, rawPayloads: 940, sessions: 61, archivedSessions: 4 });
    if (/\/env$/.test(path)) return json({ vars: [{ name: 'DATABASE_URL', length: 42 }, { name: 'SENTRY_DSN', length: 61 }] });
    return json({ error: 'モックアップなので、ここから先は動きません' }, 409);
  };
})();
