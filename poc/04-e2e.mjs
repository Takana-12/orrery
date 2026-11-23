// PoC 04: automated acceptance run against the PoC inbox server, with real Claude Code and real Codex.
// Plays the human through the same HTTP API the page uses, and checks the brief's P0 acceptance items:
//   T1 three sessions in parallel -> exactly two attention items; the no-question session produces none
//   T2 answering the Claude question resumes ONLY that session; the Codex approval stays pending
//   T3 a second submit for an already-answered item is rejected and not sent
//   T4 declining the Codex approval is confirmed by the provider and the command does not run
//   T5 a Codex approval whose turn was interrupted expires; answering it is rejected
//   T6 a Claude approval whose turn was interrupted expires; answering it is rejected
//   T7 Codex structured question (plan mode) answered from the same inbox
// Writes poc/logs/04-e2e-result.json.
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 4778;
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const server = spawn(process.execPath, [resolve(here, '03-inbox/server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await new Promise((r, rej) => {
  server.stdout.on('data', (d) => String(d).includes('[inbox]') && r());
  server.on('exit', (c) => rej(new Error(`server exited ${c}`)));
});

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const start = async (preset) => (await post('/api/sessions', { preset })).body.sessionId;
const state = () => get('/api/state');
async function waitFor(desc, pred, timeoutMs = 150_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    const v = pred(s);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
const itemOf = (s, sessionId) => s.items.find((i) => i.sessionId === sessionId);
const sess = (s, id) => s.sessions.find((x) => x.id === id);

try {
  // ---- T1 ----------------------------------------------------------------------------------
  const A = await start('claude-question'); // project A, Claude
  const B = await start('codex-approval'); // project B, Codex
  const C = await start('codex-noattention'); // project C, Codex
  const s1 = await waitFor('two pending items and C finished', (s) =>
    itemOf(s, A)?.status === 'pending' && itemOf(s, B)?.status === 'pending' && sess(s, C).status === 'turn_finished' ? s : null,
  );
  const itemA = itemOf(s1, A);
  const itemB = itemOf(s1, B);
  check('T1a', 'Claude question and Codex approval are both pending in one inbox', s1.counts.needsAttention === 2, {
    types: [itemA.type, itemB.type],
    providers: [itemA.provider, itemB.provider],
  });
  check('T1b', 'session without a question produced no attention item and finished', !itemOf(s1, C) && sess(s1, C).lastText?.includes('KIWI-7421'), sess(s1, C).lastText);
  check('T1c', 'items carry provider-native ids', /^toolu_/.test(itemA.sourceRequestId) && itemB.raw.params.threadId === sess(s1, B).providerSessionId, {
    claudeToolUseId: itemA.sourceRequestId,
    codexRpcId: itemB.sourceRequestId,
    codexThreadId: itemB.raw.params.threadId,
  });
  check('T1d', 'structured content present', itemA.questions[0].options.length === 2 && /MARKER_/.test(itemB.approval.command), {
    options: itemA.questions[0].options.map((o) => o.label),
    command: itemB.approval.command.slice(0, 120),
  });

  // ---- T2 ----------------------------------------------------------------------------------
  const r2 = await post(`/api/items/${itemA.id}/answer`, { answers: { [itemA.questions[0].id]: ['PostgreSQL'] } });
  const s2 = await waitFor('A finished', (s) => (sess(s, A).status === 'turn_finished' ? s : null));
  check('T2a', 'answer accepted and acknowledged by provider', r2.status === 200 && itemOf(s2, A).status === 'resolved', itemOf(s2, A).acknowledgement);
  check('T2b', 'the answered session resumed with our answer', /CHOSEN=PostgreSQL/.test(sess(s2, A).lastText), sess(s2, A).lastText);
  check('T2c', 'the other session was untouched (still pending, still waiting)', itemOf(s2, B).status === 'pending' && sess(s2, B).status === 'waiting_for_user', {
    itemB: itemOf(s2, B).status,
    sessionB: sess(s2, B).status,
  });

  // ---- T3 ----------------------------------------------------------------------------------
  const r3 = await post(`/api/items/${itemA.id}/answer`, { answers: { [itemA.questions[0].id]: ['SQLite'] } });
  check('T3', 'duplicate submit rejected, nothing sent', r3.status === 409, r3.body.error);

  // ---- T4 ----------------------------------------------------------------------------------
  const r4 = await post(`/api/items/${itemB.id}/answer`, { decision: 'decline' });
  const s4 = await waitFor('B finished', (s) => (sess(s, B).status === 'turn_finished' ? s : null));
  check('T4a', 'decline acknowledged via serverRequest/resolved', r4.status === 200 && itemOf(s4, B).status === 'resolved' && itemOf(s4, B).acknowledgement.evidence.via === 'serverRequest/resolved', itemOf(s4, B).acknowledgement);
  check('T4b', 'declined command did not run', sess(s4, B).lastCommand?.status === 'declined' && !/MARKER_42/.test(sess(s4, B).lastText ?? ''), {
    lastCommand: sess(s4, B).lastCommand,
    lastText: sess(s4, B).lastText,
  });

  // ---- T5 ----------------------------------------------------------------------------------
  const D = await start('codex-approval');
  const s5 = await waitFor('D pending', (s) => (itemOf(s, D)?.status === 'pending' ? s : null));
  const itemD = itemOf(s5, D);
  await post(`/api/sessions/${D}/interrupt`);
  const s5b = await waitFor('D item expired', (s) => (itemOf(s, D).status === 'expired' ? s : null), 30_000);
  const r5 = await post(`/api/items/${itemD.id}/answer`, { decision: 'accept' });
  check('T5a', 'Codex approval expired after its turn was interrupted', itemOf(s5b, D).status === 'expired', itemOf(s5b, D).expiredReason);
  check('T5b', 'answering the stale card is rejected, nothing sent', r5.status === 409, r5.body.error);

  // ---- T6 ----------------------------------------------------------------------------------
  const E = await start('claude-approval');
  const s6 = await waitFor('E pending', (s) => (itemOf(s, E)?.status === 'pending' ? s : null));
  const itemE = itemOf(s6, E);
  await post(`/api/sessions/${E}/interrupt`);
  const s6b = await waitFor('E item expired', (s) => (itemOf(s, E).status === 'expired' ? s : null), 30_000);
  const r6 = await post(`/api/items/${itemE.id}/answer`, { decision: 'accept' });
  check('T6a', 'Claude approval expired after its turn was interrupted', itemOf(s6b, E).status === 'expired', itemOf(s6b, E).expiredReason);
  check('T6b', 'answering the stale card is rejected, nothing sent', r6.status === 409, r6.body.error);

  // ---- T7 ----------------------------------------------------------------------------------
  const F = await start('codex-question');
  const s7 = await waitFor('F pending', (s) => (itemOf(s, F)?.status === 'pending' ? s : null));
  const itemF = itemOf(s7, F);
  await post(`/api/items/${itemF.id}/answer`, { answers: { [itemF.questions[0].id]: ['SQLite'] } });
  const s7b = await waitFor('F finished', (s) => (sess(s, F).status === 'turn_finished' ? s : null));
  check('T7', 'Codex structured question answered from the same inbox', itemOf(s7b, F).status === 'resolved' && /CHOSEN=SQLite/.test(sess(s7b, F).lastText), sess(s7b, F).lastText);
} catch (e) {
  check('ERR', 'run aborted', false, String(e?.message ?? e));
} finally {
  const final = await state().catch(() => null);
  writeFileSync(
    resolve(here, 'logs/04-e2e-result.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results, finalCounts: final?.counts ?? null }, null, 2),
  );
  await post('/api/shutdown').catch(() => {});
  await new Promise((r) => setTimeout(r, 6000));
  if (server.exitCode === null) server.kill();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
