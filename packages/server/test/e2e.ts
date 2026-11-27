// End-to-end acceptance run against the real daemon, with real Claude Code and real Codex.
// Plays the human through the same HTTP API the UI uses. Uses a throwaway data directory.
//   node packages/server/test/e2e.ts
// Costs a small amount of plan usage on both providers (Claude runs on haiku).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childImages } from '#host';
import { removeRunWorktrees } from './e2e-cleanup.ts';

const here = dirname(fileURLToPath(import.meta.url));

// The result is committed as evidence: keep the machine's home folder (and so the Windows user name) out of it.
const withoutHome = (json: string): string => json.split(JSON.stringify(homedir()).slice(1, -1)).join('~');
const root = resolve(here, '../../..');
const PORT = 4781;
const TOKEN = 'e2e-test-token';
const base = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), 'control-room-e2e-'));
const fixtureA = join(root, 'poc/fixtures/project-a-claude');
const fixtureB = join(root, 'poc/fixtures/project-b-codex');

type Result = { id: string; name: string; pass: boolean; detail?: unknown };
const results: Result[] = [];
const check = (id: string, name: string, pass: unknown, detail?: unknown) => {
  results.push({ id, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 260) : ''}`);
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
const lastItem = (s: any, id: string) => itemsOf(s, id).at(-1);
const answers = (item: any, label: string) => ({ answer: { kind: 'answers', answers: { [item.questions[0].id]: [label] } } });
const decision = (d: string) => ({ answer: { kind: 'decision', decision: d } });

/** Answer every request a session raises until its turn ends. Each item is answered once. */
async function drive(sessionId: string, answerFor: (item: any) => object, timeoutMs = 240_000): Promise<void> {
  const done = new Set<string>();
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    const me = sess(s, sessionId);
    for (const item of itemsOf(s, sessionId)) {
      if (item.status !== 'pending' || done.has(item.id)) continue;
      done.add(item.id);
      const r = await post(`/api/items/${item.id}/answer`, answerFor(item));
      if (r.status !== 200) console.log(`  (answer rejected for ${item.summary}: ${r.body.error})`);
    }
    if (['turn_finished', 'error', 'interrupted'].includes(me.lifecycle)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout driving session ${me.taskTitle}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const CMD = '`node -e "console.log(\'MARKER_\'+(6*7))"`';
const P = {
  claudeQuestion:
    'Before doing anything else, use the AskUserQuestion tool to ask me exactly one question: "Which database should the sample app use?" with options "SQLite" and "PostgreSQL". After I answer, reply with exactly one line: CHOSEN=<my answer>. Do not use any other tool.',
  claudeCmd: `Run exactly this shell command with the Bash tool and nothing else, then report its output verbatim: ${CMD}. If it is not permitted, reply with exactly DENIED.`,
  codexCmd: `Run exactly this shell command and nothing else, then report its output verbatim: ${CMD}. If the command is not permitted, do not try any alternative; reply with exactly DECLINED.`,
  codexQuestion:
    'Before doing anything else, use the request_user_input tool to ask me one multiple-choice question: "Which database should the sample app use?" with options "SQLite" and "PostgreSQL". After I answer, reply with exactly one line: CHOSEN=<my answer>. Do not run any commands.',
  codeword: 'What is the harness codeword? Reply with the codeword only. Do not run any commands or tools.',
};
const codexOpts = { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
let projA = '';
let projB = '';
const startClaude = async (title: string, prompt: string) => (await post('/api/sessions', { projectId: projA, provider: 'claude', title, prompt, model: 'haiku' })).body.sessionId as string;
const startCodex = async (title: string, prompt: string, extra: object = {}) =>
  (await post('/api/sessions', { projectId: projB, provider: 'codex', title, prompt, codex: codexOpts, ...extra })).body.sessionId as string;

try {
  await boot();

  // ---- security of the local API -------------------------------------------------------------
  const noToken = await fetch(base + '/api/state');
  const badOrigin = await fetch(base + '/api/state', { headers: { ...headers, origin: 'http://evil.example' } });
  check('S1', 'API without the token is rejected', noToken.status === 401, noToken.status);
  check('S2', 'API from a foreign origin is rejected', badOrigin.status === 403, badOrigin.status);

  projA = (await post('/api/projects', { path: fixtureA, name: 'project-a' })).body.projectId;
  projB = (await post('/api/projects', { path: fixtureB, name: 'project-b' })).body.projectId;
  const badProject = await post('/api/projects', { path: join(root, 'no-such-folder') });
  check('S3', 'unknown folder is rejected', badProject.status === 400, badProject.body.error);

  // ---- T1: three sessions in parallel ----------------------------------------------------------
  const A = await startClaude('DB選定', P.claudeQuestion);
  const B = await startCodex('コマンド実行', P.codexCmd);
  const C = await startCodex('質問なしのタスク', P.codeword);
  const s1 = await waitFor('two pending items and C finished', (s) =>
    lastItem(s, A)?.status === 'pending' && lastItem(s, B)?.status === 'pending' && sess(s, C).lifecycle === 'turn_finished' ? s : null,
  );
  const itemA = lastItem(s1, A);
  const itemB = lastItem(s1, B);
  check('T1a', 'Claude question + Codex approval pending in one inbox; no item for the silent session', s1.counts.needsAttention === 2 && itemsOf(s1, C).length === 0, s1.counts);
  check('T1b', 'harness loaded (AGENTS.md codeword)', sess(s1, C).lastText?.includes('KIWI-7421'), sess(s1, C).lastText);
  check('T1c', 'provider ids + generation recorded', /^toolu_/.test(itemA.source.requestId) && itemB.source.providerSessionId === sess(s1, B).providerSessionId && itemA.source.generation === s1.generation, {
    claude: itemA.source.requestId,
    codex: itemB.source.requestId,
    generation: s1.generation,
  });
  const rawB = await get(`/api/raw/${itemB.rawPayloadRef}`);
  check('T1d', 'raw evidence retrievable for the approval', /MARKER_/.test(itemB.approval.subject) && rawB.method === 'item/commandExecution/requestApproval', itemB.approval.subject.slice(0, 80));

  // ---- T2/T3: answer A only ---------------------------------------------------------------------
  const r2 = await post(`/api/items/${itemA.id}/answer`, answers(itemA, 'PostgreSQL'));
  const s2 = await waitFor('A finished', (s) => (sess(s, A).lifecycle === 'turn_finished' ? s : null));
  check('T2a', 'answer acknowledged by the provider', r2.status === 200 && lastItem(s2, A).status === 'resolved', lastItem(s2, A).acknowledgement);
  check('T2b', 'answered session resumed with the answer', /CHOSEN=PostgreSQL/.test(sess(s2, A).lastText), sess(s2, A).lastText);
  check('T2c', 'other session untouched', lastItem(s2, B).status === 'pending' && sess(s2, B).lifecycle === 'waiting_for_user');
  const r3 = await post(`/api/items/${itemA.id}/answer`, answers(itemA, 'SQLite'));
  check('T3', 'duplicate submit rejected', r3.status === 409, r3.body.error);
  const rBad = await post(`/api/items/${itemB.id}/answer`, decision('acceptForSession'));
  check('T3b', 'a decision the provider did not offer is rejected, item stays answerable', rBad.status === 400 && lastItem(await state(), B).status === 'pending', rBad.body.error);

  // ---- T4: decline B ----------------------------------------------------------------------------
  const r4 = await post(`/api/items/${itemB.id}/answer`, decision('decline'));
  const s4 = await waitFor('B finished', (s) => (sess(s, B).lifecycle === 'turn_finished' ? s : null));
  check('T4', 'decline acknowledged; command did not run', r4.status === 200 && lastItem(s4, B).acknowledgement?.evidence === 'serverRequest/resolved' && !/MARKER_42/.test(sess(s4, B).lastText ?? ''), sess(s4, B).lastText);

  // ---- T5/T6: stale requests --------------------------------------------------------------------
  const D = await startCodex('中断されるコマンド', P.codexCmd);
  const itemD = await waitFor('D pending', (s) => (lastItem(s, D)?.status === 'pending' ? lastItem(s, D) : null));
  await post(`/api/sessions/${D}/interrupt`);
  const s5 = await waitFor('D expired', (s) => (lastItem(s, D).status === 'expired' ? s : null), 30_000);
  const r5 = await post(`/api/items/${itemD.id}/answer`, decision('accept'));
  check('T5', 'Codex: interrupted turn expires the card; answering it sends nothing', r5.status === 409 && sess(s5, D).lifecycle === 'interrupted', lastItem(s5, D).expiredReason);

  const E = await startClaude('中断されるコマンド', P.claudeCmd);
  const itemE = await waitFor('E pending', (s) => (lastItem(s, E)?.status === 'pending' ? lastItem(s, E) : null));
  await post(`/api/sessions/${E}/interrupt`);
  const s6 = await waitFor('E expired', (s) => (lastItem(s, E).status === 'expired' ? s : null), 30_000);
  const r6 = await post(`/api/items/${itemE.id}/answer`, decision('accept'));
  await new Promise((r) => setTimeout(r, 2500));
  check('T6', 'Claude: interrupted turn expires the card; session shown as interrupted, not error', r6.status === 409 && sess(await state(), E).lifecycle === 'interrupted', lastItem(s6, E).expiredReason);

  // ---- T7: Codex structured question -------------------------------------------------------------
  const F = await startCodex('DB選定(Codex)', P.codexQuestion, { planMode: true });
  const itemF = await waitFor('F pending', (s) => (lastItem(s, F)?.status === 'pending' ? lastItem(s, F) : null));
  await post(`/api/items/${itemF.id}/answer`, answers(itemF, 'SQLite'));
  const s7 = await waitFor('F finished', (s) => (sess(s, F).lifecycle === 'turn_finished' ? s : null));
  check('T7', 'Codex structured question answered', lastItem(s7, F).status === 'resolved' && /CHOSEN=SQLite/.test(sess(s7, F).lastText), sess(s7, F).lastText);

  // ---- T8/T9: follow-up messages on live sessions -------------------------------------------------
  const r8 = await post(`/api/sessions/${A}/message`, { text: 'Which database did I choose? Reply with exactly one line: AGAIN=<answer>. Do not use any tools.' });
  const s8 = await waitFor('A follow-up finished', (s) => (sess(s, A).lifecycle === 'turn_finished' && /AGAIN=/.test(sess(s, A).lastText ?? '') ? s : null));
  check('T8', 'Claude: follow-up message in the same live process', r8.body.resumed === false && /AGAIN=PostgreSQL/.test(sess(s8, A).lastText), sess(s8, A).lastText);
  const r9 = await post(`/api/sessions/${C}/message`, { text: 'Repeat the codeword once more, prefixed with AGAIN=. Do not run any commands.' });
  const s9 = await waitFor('C follow-up finished', (s) => (sess(s, C).lifecycle === 'turn_finished' && /AGAIN=/.test(sess(s, C).lastText ?? '') ? s : null));
  check('T9', 'Codex: follow-up turn on the same thread', r9.body.resumed === false && /AGAIN=KIWI-7421/.test(sess(s9, C).lastText), sess(s9, C).lastText);

  // ---- T10: free the Claude process, then resume it by id ----------------------------------------
  const before10 = sess(await state(), A);
  await post(`/api/sessions/${A}/stop`);
  const s10 = await waitFor('A process stopped', (s) => (sess(s, A).process === 'stopped' && !sess(s, A).live ? s : null), 30_000);
  await new Promise((r) => setTimeout(r, 6000)); // let one resource sample pass
  const after10 = sess(await state(), A);
  check('T10a', 'idle Claude session releases its process; conversation kept', after10.lifecycle === 'turn_finished' && (after10.resources?.processCount ?? 0) === 0, {
    beforeProcs: before10.resources?.processCount,
    beforeWsMB: before10.resources ? Math.round(before10.resources.workingSetBytes / 1048576) : null,
    afterProcs: after10.resources?.processCount,
  });
  void s10;
  const r10 = await post(`/api/sessions/${A}/message`, { text: 'One more time: which database did I choose? Reply with exactly one line: RESUMED=<answer>. Do not use any tools.' });
  const s10b = await waitFor('A resumed and finished', (s) => (sess(s, A).lifecycle === 'turn_finished' && /RESUMED=/.test(sess(s, A).lastText ?? '') ? s : null));
  check('T10b', 'Claude: session resumed in a fresh process with its memory', r10.body.resumed === true && /RESUMED=PostgreSQL/.test(sess(s10b, A).lastText), sess(s10b, A).lastText);

  // ---- T11: hard-kill the control room while two requests are pending, then restart ----------------
  const G = await startCodex('再起動をまたぐ承認', P.codexCmd);
  const H = await startClaude('再起動をまたぐ質問', P.claudeQuestion);
  const s11 = await waitFor('G and H pending', (s) => (lastItem(s, G)?.status === 'pending' && lastItem(s, H)?.status === 'pending' ? s : null));
  const itemG = lastItem(s11, G);
  const itemH = lastItem(s11, H);
  const resolvedBefore = s11.items.filter((i: any) => i.status === 'resolved').length;
  const serverPid = server.pid!;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill(); // TerminateProcess on Windows: no cleanup code runs
  await exited;
  await new Promise((r) => setTimeout(r, 2500));
  const orphans = String(childImages(serverPid).filter((image) => /claude|codex/i.test(image)).length);
  check('T11a', 'after a hard kill, no agent process we started is left running (kill-on-close job)', orphans === '0', `orphaned agent processes: ${orphans}`);

  await boot();
  const s11b = await state();
  check('T11b', 'restart: new generation, history kept', s11b.generation === s11.generation + 1 && s11b.items.filter((i: any) => i.status === 'resolved').length === resolvedBefore, {
    generation: s11b.generation,
    resolvedKept: resolvedBefore,
  });
  check('T11c', 'restart: nothing shown as running; open requests are expired with a reason', s11b.counts.running === 0 && s11b.counts.waiting === 0 && lastItem(s11b, G).status === 'expired' && lastItem(s11b, H).status === 'expired', {
    G: sess(s11b, G).lifecycle,
    H: sess(s11b, H).lifecycle,
    reason: lastItem(s11b, G).expiredReason,
  });
  const r11g = await post(`/api/items/${itemG.id}/answer`, decision('accept'));
  const r11h = await post(`/api/items/${itemH.id}/answer`, answers(itemH, 'SQLite'));
  check('T11d', 'answering a pre-restart card sends nothing', r11g.status === 409 && r11h.status === 409, r11g.body.error);

  // ---- T12: resume interrupted sessions after the restart ---------------------------------------
  const r12 = await post(`/api/sessions/${C}/message`, { text: 'After the restart: repeat the codeword, prefixed with BACK=. Do not run any commands.' });
  const s12 = await waitFor('C resumed', (s) => (sess(s, C).lifecycle === 'turn_finished' && /BACK=/.test(sess(s, C).lastText ?? '') ? s : null));
  check('T12a', 'Codex: thread resumed (thread/resume) in a new app-server after restart', r12.body.resumed === true && /BACK=KIWI-7421/.test(sess(s12, C).lastText), sess(s12, C).lastText);
  const r12h = await post(`/api/sessions/${H}/message`, { text: 'Ignore the earlier question. What is the harness codeword? Reply with exactly BACK=<codeword>. Do not use any tools.' });
  const s12h = await waitFor('H resumed', (s) => (sess(s, H).lifecycle === 'turn_finished' && /BACK=/.test(sess(s, H).lastText ?? '') ? s : null));
  check('T12b', 'Claude: interrupted session resumed after restart', r12h.body.resumed === true && /BACK=MANGO-3187/.test(sess(s12h, H).lastText), sess(s12h, H).lastText);
  const tr = await get(`/api/sessions/${H}/transcript`);
  check('T12c', 'transcript persisted across the restart', tr.entries.length >= 3 && tr.entries.some((e: any) => e.role === 'user' && /harness codeword/.test(e.text)), `${tr.entries.length} entries`);

  // ---- T13: Claude file write shows a diff before it happens -------------------------------------
  // Each session works in a folder of its own (a git worktree), so that is where its files appear;
  // the project's own checkout must stay untouched.
  const workFile = async (id: string, name: string): Promise<string> => join(sess(await state(), id).cwd, name);
  const strayA = join(fixtureA, 'e2e-claude.txt');
  rmSync(strayA, { force: true });
  const W = await startClaude('ファイル作成', 'Use the Write tool to create a file named e2e-claude.txt in the current directory containing exactly the text HELLO_FROM_CLAUDE. Do not use any other tool. Then reply DONE.');
  const itemW = await waitFor('W pending', (s) => (lastItem(s, W)?.status === 'pending' ? lastItem(s, W) : null));
  const chW = itemW.approval?.changes?.[0];
  const fileA = await workFile(W, 'e2e-claude.txt');
  check('T13a', 'Claude: file write approval carries the path and the content as a diff', !!chW && /e2e-claude\.txt$/.test(chW.path) && chW.diff.includes('+HELLO_FROM_CLAUDE') && !existsSync(fileA), chW);
  await post(`/api/items/${itemW.id}/answer`, decision('accept'));
  await waitFor('W finished', (s) => (sess(s, W).lifecycle === 'turn_finished' ? s : null));
  check('T13b', 'Claude: the file is written only after approval, in the session\'s own work folder', existsSync(fileA) && readFileSync(fileA, 'utf8').includes('HELLO_FROM_CLAUDE') && !existsSync(strayA), fileA);

  // ---- T14: Codex file change ------------------------------------------------------------------------
  const strayB = join(fixtureB, 'e2e-codex.txt');
  rmSync(strayB, { force: true });
  const X = await startCodex('ファイル作成(Codex)', 'Create a file named e2e-codex.txt in the current directory containing exactly the text HELLO_FROM_CODEX. Use the apply_patch tool, not a shell command. Then reply DONE.');
  const fileB = await workFile(X, 'e2e-codex.txt');
  const seenX: any[] = [];
  await drive(X, (item) => {
    seenX.push({ tool: item.approval?.tool, changes: item.approval?.changes ?? null, existedBefore: existsSync(fileB) });
    return decision('accept');
  });
  const patchX = seenX.find((x) => x.tool === 'apply_patch');
  check('T14a', 'Codex: file change approval carries the path and diff', !!patchX?.changes?.[0] && /e2e-codex\.txt$/.test(patchX.changes[0].path) && patchX.changes[0].diff.includes('+HELLO_FROM_CODEX') && !patchX.existedBefore, seenX.map((x) => ({ tool: x.tool, change: x.changes?.[0] })));
  check('T14b', 'Codex: the file exists after approval, in the session\'s own work folder', existsSync(fileB) && readFileSync(fileB, 'utf8').includes('HELLO_FROM_CODEX') && !existsSync(strayB), sess(await state(), X).lastText);

  // ---- T15: Claude plan mode: the plan itself is put in front of the human --------------------------
  const PL = (await post('/api/sessions', { projectId: projA, provider: 'claude', title: 'プラン承認', model: 'haiku', planMode: true, prompt: 'Plan how to add a file named plan-test.txt containing OK. Do not research. Write a plan of exactly two short bullet points and immediately call ExitPlanMode with it.' })).body.sessionId as string;
  const itemPL = await waitFor('PL pending', (s) => (lastItem(s, PL)?.status === 'pending' ? lastItem(s, PL) : null));
  check('T15a', 'Claude: ExitPlanMode arrives as an approval showing the plan text', itemPL.approval?.tool === 'ExitPlanMode' && typeof itemPL.approval.subject === 'string' && itemPL.approval.subject.length > 10, String(itemPL.approval?.subject).slice(0, 120));
  const rPL = await post(`/api/items/${itemPL.id}/answer`, { answer: { kind: 'decision', decision: 'decline', message: 'Stop here. Do not revise the plan; reply with exactly PLAN_REJECTED.' } });
  const sPL = await waitFor('PL settled', (s) => (lastItem(s, PL).status !== 'pending' && lastItem(s, PL).status !== 'answering' && ['turn_finished', 'waiting_for_user'].includes(sess(s, PL).lifecycle) ? s : null));
  check('T15b', 'Claude: rejecting the plan is acknowledged and nothing is implemented', rPL.status === 200 && !existsSync(join(fixtureA, 'plan-test.txt')), sess(sPL, PL).lastText);
  if (sess(sPL, PL).lifecycle !== 'turn_finished') await post(`/api/sessions/${PL}/interrupt`);

  // ---- T16/T17: MCP elicitation (a form from an MCP server) ----------------------------------------
  const mcp = { command: process.execPath, args: [join(here, 'fixtures/elicit-mcp-server.mjs')] };
  const elicitPrompt = 'Call the pick_color tool of the "elicit" MCP server exactly once, with no arguments, and then reply with exactly the text the tool returned. Do not use any other tool.';
  const answerElicit = (item: any) =>
    item.type === 'permission_approval' ? decision('accept') : { answer: { kind: 'answers', answers: { color: ['Blue'], shade: ['7'] } } };

  const M = (await post('/api/sessions', { projectId: projA, provider: 'claude', title: 'MCP入力要求', model: 'haiku', prompt: elicitPrompt, claude: { mcpServers: { elicit: mcp } } })).body.sessionId as string;
  const seenM: any[] = [];
  await drive(M, (item) => (seenM.push(item), answerElicit(item)));
  const formM = seenM.find((i) => i.allowDecline);
  check('T16a', 'Claude: MCP elicitation shown as a declinable form with typed fields', !!formM && formM.questions.map((q: any) => `${q.id}:${q.optional ? 'opt' : 'req'}:${q.options.map((o: any) => o.label).join('/')}`).join(' ') === 'color:req:Red/Blue shade:opt:', formM?.questions);
  check('T16b', 'Claude: the answer reaches the MCP server with the right types', /ELICIT_ACTION=accept COLOR=blue SHADE=7/.test(sess(await state(), M).lastText ?? ''), sess(await state(), M).lastText);

  const M2 = (await post('/api/sessions', { projectId: projA, provider: 'claude', title: 'MCP入力要求(辞退)', model: 'haiku', prompt: elicitPrompt, claude: { mcpServers: { elicit: mcp } } })).body.sessionId as string;
  await drive(M2, (item) => (item.type === 'permission_approval' ? decision('accept') : { answer: { kind: 'decline' } }));
  check('T16c', 'Claude: declining the form reaches the MCP server as decline', /ELICIT_ACTION=decline/.test(sess(await state(), M2).lastText ?? ''), sess(await state(), M2).lastText);

  const N = (await post('/api/sessions', { projectId: projB, provider: 'codex', title: 'MCP入力要求(Codex)', prompt: elicitPrompt, codex: { ...codexOpts, config: { mcp_servers: { elicit: mcp } } } })).body.sessionId as string;
  const seenN: any[] = [];
  await drive(N, (item) => (seenN.push(item), answerElicit(item)));
  const formN = seenN.find((i) => i.allowDecline && i.questions?.some((q: any) => q.id === 'color'));
  const toolGate = seenN.find((i) => i.type === 'permission_approval' && /^mcp:/.test(i.approval?.tool ?? ''));
  check('T17a', 'Codex: the "allow this MCP tool call?" prompt is shown as an approval with its text', !!toolGate && /pick_color/.test(toolGate.approval.subject), toolGate?.approval);
  check('T17b', 'Codex: MCP elicitation form answered; the answer reaches the MCP server', !!formN && /ELICIT_ACTION=accept COLOR=blue SHADE=7/.test(sess(await state(), N).lastText ?? ''), {
    lastText: sess(await state(), N).lastText,
    items: seenN.map((i) => ({ type: i.type, summary: i.summary, tool: i.approval?.tool })),
  });

  // ---- T18: finished results stay "new" until opened; archive is reversible; transcript paging ----
  const s18 = await state();
  check('T18a', 'a finished session is flagged as an unseen result', sess(s18, X).unread === true && s18.counts.unread > 0, s18.counts);
  await post(`/api/sessions/${X}/seen`);
  check('T18b', 'opening it clears the flag', sess(await state(), X).unread === false);
  const busy = await startCodex('片付けできない作業', P.codexCmd);
  await waitFor('busy pending', (s) => (lastItem(s, busy)?.status === 'pending' ? s : null));
  const rBusy = await post(`/api/sessions/${busy}/archive`);
  check('T18c', 'work that is waiting on the human cannot be archived', rBusy.status === 409, rBusy.body.error);
  await post(`/api/items/${lastItem(await state(), busy).id}/answer`, decision('decline'));
  await waitFor('busy finished', (s) => (sess(s, busy).lifecycle === 'turn_finished' ? s : null));
  const before18 = (await state()).counts;
  const rArch = await post(`/api/sessions/${X}/archive`);
  const mid18 = await state();
  check('T18d', 'archiving hides the session from the working counts and deletes nothing', rArch.status === 200 && sess(mid18, X).archived === true && mid18.counts.turnFinished === before18.turnFinished - 1 && itemsOf(mid18, X).length > 0 && (await get(`/api/sessions/${X}/transcript`)).entries.length > 0, mid18.counts);
  await post(`/api/sessions/${X}/unarchive`);
  check('T18e', 'and it can be brought back', sess(await state(), X).archived === false);
  const all18 = (await get(`/api/sessions/${C}/transcript`)).entries;
  const tail18 = (await get(`/api/sessions/${C}/transcript?after=${all18[0].seq}`)).entries;
  check('T18f', 'transcript can be fetched incrementally', all18.length >= 2 && tail18.length === all18.length - 1 && tail18[0].seq === all18[1].seq, `${all18.length} -> ${tail18.length}`);
  const css = await fetch(base + '/app.css');
  const page = await fetch(base + '/');
  check('S4', 'UI is served with a CSP that forbids inline script and style', css.status === 200 && /script-src 'self'; style-src 'self'/.test(page.headers.get('content-security-policy') ?? ''), page.headers.get('content-security-policy'));
} catch (e) {
  check('ERR', 'run aborted', false, String((e as Error)?.message ?? e));
} finally {
  const final = await state().catch(() => null);
  mkdirSync(join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(join(root, 'docs/evidence/mvp-e2e-result.json'), withoutHome(JSON.stringify({ ranAt: new Date().toISOString(), results, finalCounts: final?.counts ?? null }, null, 2)));
  await post('/api/shutdown').catch(() => {});
  await new Promise((r) => setTimeout(r, 7000));
  if (server.exitCode === null) server.kill();
  await new Promise((r) => setTimeout(r, 1000)); // let the killed agents release their folders
  const cleaned = removeRunWorktrees(root, home);
  console.log(`cleanup: removed ${cleaned.worktrees.length} worktrees, ${cleaned.branches.length} orrery/* branches`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
