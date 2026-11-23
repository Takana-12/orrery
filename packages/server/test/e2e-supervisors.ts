// End-to-end checks for the supervisors: model list, automatic naming, the queue (concurrency limit),
// project environment variables, and completion judgement. Real Claude Code and real Codex.
//   node packages/server/test/e2e-supervisors.ts
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The result is committed as evidence: keep the machine's home folder (and so the Windows user name) out of it.
const withoutHome = (json: string): string => json.split(JSON.stringify(homedir()).slice(1, -1)).join('~');
const root = resolve(here, '../../..');
const PORT = 4782;
const TOKEN = 'e2e-test-token';
const base = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), 'control-room-e2e2-'));
const fixtureB = join(root, 'poc/fixtures/project-b-codex');
const SECRET = 's3cr3t-value-12345';
// A value the agents will happily print (Codex declines to echo a variable that looks like a credential).
const CHANNEL = 'nightly-channel-98765';

const results: { id: string; name: string; pass: boolean; detail?: unknown }[] = [];
const check = (id: string, name: string, pass: unknown, detail?: unknown) => {
  results.push({ id, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 280) : ''}`);
};

let server!: ChildProcess;
async function boot(): Promise<void> {
  server = spawn(process.execPath, [join(root, 'packages/server/src/main.ts'), '--no-open'], {
    cwd: root,
    env: { ...process.env, CONTROL_ROOM_PORT: String(PORT), CONTROL_ROOM_HOME: home, CONTROL_ROOM_TOKEN: TOKEN, CONTROL_ROOM_ARCHIVE_ON_EXIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stderr!.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise<void>((r, rej) => {
    server.stdout!.on('data', (d) => String(d).includes('open:') && r());
    server.once('exit', (c) => rej(new Error(`server exited early (${c})`)));
  });
}
const headers = { 'content-type': 'application/json', 'x-control-room-token': TOKEN };
const get = async (p: string): Promise<any> => (await fetch(base + p, { headers })).json();
const post = async (p: string, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const state = (): Promise<any> => get('/api/state');
async function waitFor<T>(desc: string, pred: (s: any) => T | null | undefined | false, timeoutMs = 180_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = pred(await state());
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
const sess = (s: any, id: string) => s.sessions.find((x: any) => x.id === id);
const itemsOf = (s: any, id: string) => s.items.filter((i: any) => i.sessionId === id);
const decision = (d: string) => ({ answer: { kind: 'decision', decision: d } });
/** Approve every request a session raises until its turn ends. */
async function approveAll(sessionId: string, until: (me: any) => boolean, timeoutMs = 300_000): Promise<void> {
  const done = new Set<string>();
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    for (const item of itemsOf(s, sessionId)) {
      if (item.status !== 'pending' || done.has(item.id)) continue;
      done.add(item.id);
      await post(`/api/items/${item.id}/answer`, decision('accept'));
    }
    if (until(sess(s, sessionId))) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout driving ${sess(s, sessionId).taskTitle}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const transcriptText = async (id: string): Promise<string> => (await get(`/api/sessions/${id}/transcript`)).entries.map((e: any) => e.text).join('\n');
const codexOpts = { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
const CMD = '`node -e "console.log(\'MARKER_\'+(6*7))"`';

try {
  await boot();
  const projB = (await post('/api/projects', { path: fixtureB, name: 'project-b' })).body.projectId as string;

  // ---- models ----------------------------------------------------------------------------------
  const codexModels = (await get('/api/models/codex')).models ?? [];
  const claudeModels = (await get('/api/models/claude')).models ?? [];
  check('M1', 'Codex model list comes from the provider and marks a default', codexModels.length > 0 && codexModels.some((m: any) => m.isDefault), codexModels.map((m: any) => m.id).slice(0, 6));
  check('M2', 'Claude model list comes from the provider', claudeModels.length > 0 && claudeModels.every((m: any) => m.id && m.label), claudeModels.map((m: any) => m.id).slice(0, 8));

  // ---- automatic naming --------------------------------------------------------------------------
  const promptN = 'このプロジェクトのハーネスの合言葉を、短い日本語の1文で教えてください。コマンドは実行しないでください。';
  const N = (await post('/api/sessions', { projectId: projB, provider: 'codex', prompt: promptN })).body.sessionId as string;
  const provisional = sess(await state(), N).taskTitle;
  const named = await waitFor('title generated', (s) => (sess(s, N).taskTitle !== provisional ? sess(s, N).taskTitle : null), 90_000).catch(() => null);
  check('N1', 'work started without a name gets a short generated one', !!named && named.length <= 30 && named !== promptN.slice(0, 40), { provisional, named });
  await waitFor('N finished', (s) => (sess(s, N).lifecycle === 'turn_finished' ? s : null));
  const rRename = await post(`/api/sessions/${N}/rename`, { title: '合言葉の確認（手動）' });
  check('N2', 'the human can rename it', rRename.status === 200 && sess(await state(), N).taskTitle === '合言葉の確認（手動）');

  // ---- queue: at most N working at once -------------------------------------------------------------
  await post('/api/settings', { maxConcurrent: 1 });
  const startQ = async (n: number) => (await post('/api/sessions', { projectId: projB, provider: 'codex', title: `順番待ちテスト${n}`, codex: codexOpts, prompt: `Run exactly this shell command and nothing else, then report its output verbatim: ${CMD}. If it is not permitted, reply DECLINED.` })).body.sessionId as string;
  const Q1 = await startQ(1);
  const Q2 = await startQ(2);
  const Q3 = await startQ(3);
  const sQ = await waitFor('Q1 waiting on approval', (s) => (sess(s, Q1).lifecycle === 'waiting_for_user' ? s : null));
  check('Q1', 'with a limit of 1, one session works and the others queue in order', sess(sQ, Q2).lifecycle === 'queued' && sess(sQ, Q3).lifecycle === 'queued' && sess(sQ, Q2).queuePosition === 1 && sess(sQ, Q3).queuePosition === 2 && sQ.queue.blockedBy === 'slots', {
    Q2: sess(sQ, Q2).lifecycle,
    Q3: sess(sQ, Q3).queuePosition,
    blockedBy: sQ.queue.blockedBy,
  });
  check('Q2', 'queued work has not started any provider session', sess(sQ, Q2).providerSessionId === null && sess(sQ, Q3).providerSessionId === null);
  await post(`/api/sessions/${Q3}/interrupt`);
  const sQ3 = await state();
  check('Q3', 'queued work can be cancelled before it starts', sess(sQ3, Q3).lifecycle === 'interrupted' && sess(sQ3, Q3).providerSessionId === null && sQ3.queue.length === 1);
  await post(`/api/items/${itemsOf(sQ, Q1).at(-1).id}/answer`, decision('decline'));
  const sQ4 = await waitFor('Q2 started after Q1 finished', (s) => (sess(s, Q1).lifecycle === 'turn_finished' && sess(s, Q2).lifecycle === 'waiting_for_user' ? s : null));
  check('Q4', 'the next queued session starts by itself when a slot frees', sQ4.queue.length === 0 && sess(sQ4, Q2).providerSessionId !== null);
  await post(`/api/items/${itemsOf(sQ4, Q2).at(-1).id}/answer`, decision('decline'));
  await waitFor('Q2 finished', (s) => (sess(s, Q2).lifecycle === 'turn_finished' ? s : null));
  await post('/api/settings', { maxConcurrent: 4 });

  // ---- project environment variables -----------------------------------------------------------------
  const work = mkdtempSync(join(tmpdir(), 'control-room-work-'));
  writeFileSync(join(work, 'CLAUDE.md'), '# temp project for control room tests\n');
  writeFileSync(join(work, 'check.js'), "const fs=require('fs');if(!fs.existsSync('ok.txt')){console.error('CHECK FAILED: ok.txt does not exist. Create a file named ok.txt containing the text OK in this folder.');process.exit(1)}console.log('CHECK PASSED');\n");
  const projW = (await post('/api/projects', { path: work, name: 'work' })).body.projectId as string;
  const badName = await post(`/api/projects/${projB}/env/set`, { name: '1BAD-NAME', value: 'x' });
  await post(`/api/projects/${projB}/env/set`, { name: 'CR_SECRET_TOKEN', value: SECRET });
  await post(`/api/projects/${projB}/env/set`, { name: 'CR_BUILD_CHANNEL', value: CHANNEL });
  await post(`/api/projects/${projW}/env/set`, { name: 'CR_BUILD_CHANNEL', value: CHANNEL });
  const listed = (await get(`/api/projects/${projB}/env`)).vars;
  const dbBytes = readFileSync(join(home, 'control-room.sqlite'));
  check('E1', 'variable is listed by name only; the value is not in the state or stored in plain text', badName.status === 400 && listed.length === 2 && listed.some((v: any) => v.name === 'CR_SECRET_TOKEN' && v.length === SECRET.length) && !JSON.stringify(await state()).includes(SECRET) && !dbBytes.includes(Buffer.from(SECRET)), listed);
  check('E2', 'revealing a value is an explicit request', (await post(`/api/projects/${projB}/env/reveal`, { name: 'CR_SECRET_TOKEN' })).body.value === SECRET);

  const envPrompt = 'Run exactly this shell command and nothing else, then repeat its output line verbatim: `node -e "console.log(\'CHANNEL=\'+process.env.CR_BUILD_CHANNEL)"`';
  const EC = (await post('/api/sessions', { projectId: projB, provider: 'codex', title: 'env確認(Codex)', codex: codexOpts, prompt: envPrompt })).body.sessionId as string;
  const EL = (await post('/api/sessions', { projectId: projW, provider: 'claude', model: 'haiku', title: 'env確認(Claude)', prompt: envPrompt })).body.sessionId as string;
  await Promise.all([approveAll(EC, (me) => me.lifecycle === 'turn_finished'), approveAll(EL, (me) => me.lifecycle === 'turn_finished')]);
  const tC = await transcriptText(EC);
  const tL = await transcriptText(EL);
  check('E3', 'Codex: the variable reaches the agent command, and its value is masked everywhere it is recorded', tC.includes('CHANNEL=[env:CR_BUILD_CHANNEL]') && !tC.includes(CHANNEL), tC.match(/CHANNEL=\[\S+/)?.[0] ?? tC.slice(-200));
  check('E4', 'Claude: the variable reaches the agent command, and its value is masked everywhere it is recorded', tL.includes('CHANNEL=[env:CR_BUILD_CHANNEL]') && !tL.includes(CHANNEL), tL.match(/CHANNEL=\[\S+/)?.[0] ?? tL.slice(-200));
  const whole = JSON.stringify(await state()) + readFileSync(join(home, 'control-room.sqlite')).toString('latin1');
  check('E5', 'neither value appears anywhere in the state or the database file', !whole.includes(SECRET) && !whole.includes(CHANNEL));
  await post(`/api/projects/${projB}/env/delete`, { name: 'CR_SECRET_TOKEN' });
  check('E6', 'a variable can be deleted', (await get(`/api/projects/${projB}/env`)).vars.length === 1);

  // ---- completion judgement ----------------------------------------------------------------------------
  const D = (await post('/api/sessions', { projectId: projW, provider: 'claude', model: 'haiku', title: '完了判定テスト', checkCommand: 'node check.js', autoFix: true, prompt: 'Reply with exactly: すべて完了しました。 Do not use any tools.' })).body.sessionId as string;
  let sawNeedsFix: any = null;
  let acceptWhileFailing: number | null = null;
  await approveAll(D, (me) => {
    if (me.completion === 'needs_fix' && !sawNeedsFix) sawNeedsFix = { validation: me.task.validation, lastText: me.lastText };
    return me.completion === 'candidate';
  });
  const sD = await state();
  const tD = await transcriptText(D);
  check('D1', 'the agent said it was done, but the check failed: recorded as failed with the evidence', /検証 失敗: node check\.js/.test(tD) && tD.includes('CHECK FAILED'), sawNeedsFix?.validation ?? '(transient state not sampled; transcript has the record)');
  check('D2', 'the failure was handed back to the agent once, and the agent fixed it', sess(sD, D).task.fixRounds === 1 && existsSync(join(work, 'ok.txt')), { fixRounds: sess(sD, D).task.fixRounds });
  check('D3', 'after the fix the check passes: completion candidate with evidence, not yet accepted', sess(sD, D).completion === 'candidate' && sess(sD, D).task.validation.ok === true && sess(sD, D).task.validation.exitCode === 0 && /CHECK PASSED/.test(sess(sD, D).task.validation.outputTail) && sess(sD, D).archived === false, sess(sD, D).task.validation);
  const rAcc = await post(`/api/sessions/${D}/accept`);
  const sD2 = await state();
  check('D4', 'accepting is a human act; accepted work is put away and can be reopened', rAcc.status === 200 && sess(sD2, D).completion === 'accepted' && sess(sD2, D).archived === true);
  await post(`/api/sessions/${D}/reopen`);
  check('D5', 'reopen brings it back as a candidate', sess(await state(), D).archived === false && sess(await state(), D).completion === 'candidate');

  // A failing check with auto-fix off: stays "needs fix", and cannot be accepted.
  writeFileSync(join(work, 'always-fail.js'), "console.error('2 tests failed');process.exit(3);\n");
  const F = (await post('/api/sessions', { projectId: projW, provider: 'claude', model: 'haiku', title: '検証失敗テスト', checkCommand: 'node always-fail.js', prompt: 'Reply with exactly: 完了しました。 Do not use any tools.' })).body.sessionId as string;
  const sF = await waitFor('F needs fix', (s) => (sess(s, F).completion === 'needs_fix' ? s : null));
  acceptWhileFailing = (await post(`/api/sessions/${F}/accept`)).status;
  check('D6', 'failed check without auto-fix: shown as needing a fix with exit code and output; accept is refused', sess(sF, F).task.validation.exitCode === 3 && /2 tests failed/.test(sess(sF, F).task.validation.outputTail) && acceptWhileFailing === 409 && sF.counts.needsFix >= 1, { exit: sess(sF, F).task.validation.exitCode, accept: acceptWhileFailing });
  writeFileSync(join(work, 'always-fail.js'), "console.log('all good');\n");
  await post(`/api/sessions/${F}/check`);
  const sF2 = await waitFor('F candidate after re-check', (s) => (sess(s, F).completion === 'candidate' ? s : null), 30_000);
  check('D7', 'the check can be re-run by hand', sess(sF2, F).task.validation.ok === true);

  // ---- reading the final reply: questions asked in prose ---------------------------------------------
  const RQ = (await post('/api/sessions', { projectId: projB, provider: 'codex', title: '方針の相談', prompt: '次の文章だけを、そのまま返答してください。コマンドは実行しないでください。\n\n実装方針が2つあります。A案: 既存のテーブルに列を追加する（変更が小さい）。B案: 新しいテーブルを作る（将来の拡張がしやすい）。どちらにしますか？' })).body.sessionId as string;
  const itemRQ = await waitFor('question read from prose', (s) => itemsOf(s, RQ).find((i: any) => i.status === 'pending' && String(i.source.requestId).startsWith('final:')), 120_000).catch(() => null);
  const labels = (itemRQ?.questions?.[0]?.options ?? []).map((o: any) => o.label);
  check('R1', 'a question the agent asked in plain prose becomes an inbox question with its choices', !!itemRQ && itemRQ.type === 'user_question' && labels.length === 2 && /A/.test(labels[0]) && /B/.test(labels[1]), { question: itemRQ?.questions?.[0]?.text, labels });
  if (itemRQ) {
    await post(`/api/items/${itemRQ.id}/answer`, { answer: { kind: 'answers', answers: { answer: [labels[1]] } } });
    const sRQ = await waitFor('RQ answered and finished again', (s) => (sess(s, RQ).lifecycle === 'turn_finished' && sess(s, RQ).lifecycleSince > itemRQ.createdAt ? s : null), 120_000).catch(() => null);
    const tRQ = await transcriptText(RQ);
    check('R2', 'the chosen answer goes back to the agent as the next message', !!sRQ && itemsOf(sRQ, RQ).find((i: any) => i.id === itemRQ.id).status === 'resolved' && tRQ.includes(labels[1]), labels[1]);
  }

  // ---- what is left for the human: steps, clickable commands, completion ---------------------------------
  const HS = (await post('/api/sessions', { projectId: projW, provider: 'claude', model: 'haiku', title: '残作業の抽出', prompt: '次の文章だけを、そのまま返答してください。ツールは使わないでください。\n\n実装とテストは完了し、PRを作成しました。残りはあなたの作業です。\n1. `node -e "console.log(\'MERGED_\'+(40+2))"` を実行してマージしてください。\n2. 本番のトップページで表示を確認してください。' })).body.sessionId as string;
  const sHS = await waitFor('human steps read', (s) => (sess(s, HS).completion === 'human_steps' ? s : null), 120_000).catch(() => null);
  const steps = sHS ? sess(sHS, HS).task.humanSteps : [];
  const cmd = `node -e "console.log('MERGED_'+(40+2))"`;
  check('H1', 'work that only the human can do is listed as steps, with the command verbatim', steps.length === 2 && steps[0].command === cmd && steps[1].command === null && sHS.counts.humanTasks >= 1, steps);
  const rBad = await post(`/api/sessions/${HS}/run`, { command: 'node -e "console.log(1)"' });
  check('H2', 'a command the agent never wrote is refused', rBad.status === 403, rBad.body.error);
  const rRun = await post(`/api/sessions/${HS}/run`, { command: cmd });
  const sH3 = await state();
  check('H3', 'clicking the command runs it in the work folder; its step is ticked and the result recorded', rRun.status === 200 && rRun.body.ok === true && /MERGED_42/.test(rRun.body.output) && sess(sH3, HS).task.humanSteps[0].done === true && (await transcriptText(HS)).includes('あなたが実行'), rRun.body);
  const rStep = await post(`/api/sessions/${HS}/step`, { index: 1, done: true });
  const sH4 = await state();
  check('H4', 'ticking the last step completes the task (and puts it away)', rStep.body.completed === true && sess(sH4, HS).completion === 'accepted' && sess(sH4, HS).archived === true);

  // ---- stored data -------------------------------------------------------------------------------------------
  const st0 = await get('/api/storage');
  const before = (await get(`/api/sessions/${HS}/transcript`)).entries.length;
  const rPurge = await post('/api/storage/purge', { olderThanDays: 0 });
  const after = (await get(`/api/sessions/${HS}/transcript`)).entries.length;
  const sP = await state();
  check('P1', 'stored data can be measured; purging removes conversation records of put-away work but keeps the work and its outcome', st0.bytes > 0 && before > 0 && after === 0 && rPurge.body.sessions >= 1 && sess(sP, HS).completion === 'accepted' && (await get(`/api/sessions/${RQ}/transcript`)).entries.length > 0, { bytes: st0.bytes, removedFrom: rPurge.body.sessions, freed: rPurge.body.freedBytes });
} catch (e) {
  check('ERR', 'run aborted', false, String((e as Error)?.message ?? e));
} finally {
  mkdirSync(join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(join(root, 'docs/evidence/supervisors-e2e-result.json'), withoutHome(JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2)));
  await post('/api/shutdown').catch(() => {});
  await new Promise((r) => setTimeout(r, 7000));
  if (server.exitCode === null) server.kill();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
