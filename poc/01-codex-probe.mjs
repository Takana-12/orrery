// PoC 01: drive the official `codex app-server` over stdio and verify, with the real binary and
// the user's existing ChatGPT login, that:
//   (1) a command-approval request arrives as a structured server->client request with ids,
//   (2) our response (accept / decline) is routed to that request and the turn resumes,
//   (3) `serverRequest/resolved` acknowledges the resolution,
//   (4) AGENTS.md of the fixture project is loaded (harness codeword),
//   (5) optionally, a structured `item/tool/requestUserInput` question round-trips (plan mode).
//
// Usage: node poc/01-codex-probe.mjs [approve|decline|question|codeword]
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { JsonRpcStdio } from './lib/jsonrpc-stdio.mjs';
import { findCodex } from './lib/find-codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scenario = process.argv[2] ?? 'approve';
const cwd = resolve(here, 'fixtures/project-b-codex');
const logFile = resolve(here, `logs/01-codex-${scenario}.jsonl`);
if (existsSync(logFile)) rmSync(logFile);
const marker = resolve(cwd, 'poc-marker.txt');
if (existsSync(marker)) rmSync(marker);

const codex = findCodex();
console.log(`[poc] codex binary: ${codex}`);
const rpc = new JsonRpcStdio(codex, ['app-server'], { logFile, label: 'codex' });
console.log(`[poc] app-server pid: ${rpc.pid}`);

const events = [];
const note = (kind, data) => {
  events.push({ t: Date.now(), kind, ...data });
  console.log(`[evt] ${kind} ${JSON.stringify(data)}`);
};

let turnDone;
const turnCompleted = new Promise((r) => (turnDone = r));
let agentText = '';

rpc.onNotification = (msg) => {
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'thread/status/changed':
      note('thread.status', { threadId: p.threadId, status: p.status });
      break;
    case 'turn/started':
      note('turn.started', { turnId: p.turn?.id });
      break;
    case 'turn/completed':
      note('turn.completed', { turnId: p.turn?.id, status: p.turn?.status, error: p.turn?.error ?? null });
      turnDone(p.turn);
      break;
    case 'serverRequest/resolved':
      note('serverRequest.resolved', { threadId: p.threadId, requestId: p.requestId });
      break;
    case 'item/completed':
      if (p.item?.type === 'agentMessage') agentText += (p.item.text ?? '') + '\n';
      if (p.item?.type === 'commandExecution')
        note('command.completed', { status: p.item.status, exitCode: p.item.exitCode, output: (p.item.aggregatedOutput ?? '').slice(0, 200) });
      break;
    case 'error':
      note('error', p);
      break;
  }
};

rpc.onServerRequest = (msg, respond, respondError) => {
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'item/commandExecution/requestApproval': {
      note('APPROVAL_REQUEST', {
        rpcId: msg.id,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        approvalId: p.approvalId ?? null,
        approvalKind: p.kind,
        command: p.command,
        cwd: p.cwd,
        reason: p.reason ?? null,
        availableDecisions: p.availableDecisions ?? null,
      });
      const decision = scenario === 'decline' ? 'decline' : 'accept';
      // Simulate a human taking a moment, so "waitingOnApproval" is observable.
      setTimeout(() => {
        note('APPROVAL_RESPONSE_SENT', { rpcId: msg.id, decision });
        respond({ decision });
      }, 1500);
      break;
    }
    case 'item/fileChange/requestApproval': {
      note('FILECHANGE_APPROVAL_REQUEST', { rpcId: msg.id, threadId: p.threadId, itemId: p.itemId, reason: p.reason ?? null });
      respond({ decision: scenario === 'decline' ? 'decline' : 'accept' });
      break;
    }
    case 'item/tool/requestUserInput': {
      note('USER_INPUT_REQUEST', { rpcId: msg.id, threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, questions: p.questions });
      const answers = {};
      for (const q of p.questions ?? []) {
        // Pick the second option when available, to prove the answer (not a default) is what flows back.
        const pick = q.options?.[1]?.label ?? q.options?.[0]?.label ?? 'free text answer from control room';
        answers[q.id] = { answers: [pick] };
      }
      setTimeout(() => {
        note('USER_INPUT_RESPONSE_SENT', { rpcId: msg.id, answers });
        respond({ answers });
      }, 1500);
      break;
    }
    default:
      note('UNHANDLED_SERVER_REQUEST', { method: msg.method, rpcId: msg.id });
      respondError(-32601, `PoC does not handle ${msg.method}`);
  }
};

// Harmless and read-only: prints MARKER_42 only if it really ran.
const TEST_COMMAND = '`node -e "console.log(\'MARKER_\'+(6*7))"`';

const prompts = {
  approve: `Run exactly this shell command and nothing else, then report its output verbatim: ${TEST_COMMAND}`,
  decline: `Run exactly this shell command and nothing else, then report its output verbatim: ${TEST_COMMAND}. If the command is not permitted, do not try any alternative; reply with exactly DECLINED.`,
  question:
    'Before doing anything else, use the request_user_input tool to ask me one multiple-choice question: "Which database should the sample app use?" with options "SQLite" and "PostgreSQL". After I answer, reply with exactly one line: CHOSEN=<my answer>. Do not run any commands.',
  codeword: 'What is the harness codeword? Reply with the codeword only. Do not run any commands.',
};

try {
  const init = await rpc.request('initialize', {
    clientInfo: { name: 'control_room_poc', title: 'Agent Control Room PoC', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  note('initialized', { userAgent: init.userAgent, platformOs: init.platformOs ?? null });
  rpc.notify('initialized');

  const account = await rpc.request('account/read', { refreshToken: false });
  // Deliberately do not print the e-mail address.
  note('account', { type: account.account?.type ?? null, planType: account.account?.planType ?? null, requiresOpenaiAuth: account.requiresOpenaiAuth });

  const started = await rpc.request('thread/start', {
    cwd,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  });
  const threadId = started.thread.id;
  note('thread.started', {
    threadId,
    model: started.model,
    approvalPolicy: started.approvalPolicy,
    sandbox: started.sandbox?.type,
    instructionSources: started.instructionSources,
  });

  const turnParams = { threadId, input: [{ type: 'text', text: prompts[scenario], text_elements: [] }] };
  if (scenario === 'question') {
    turnParams.collaborationMode = {
      mode: 'plan',
      settings: { model: started.model, reasoning_effort: started.reasoningEffort ?? null, developer_instructions: null },
    };
  }
  const turn = await rpc.request('turn/start', turnParams);
  note('turn.start.ack', { turnId: turn.turn?.id });

  let timer;
  const timeout = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('turn timeout (180s)')), 180_000)));
  const finished = await Promise.race([turnCompleted, timeout]).finally(() => clearTimeout(timer));

  console.log('\n===== RESULT =====');
  console.log(`scenario            : ${scenario}`);
  console.log(`threadId            : ${threadId}`);
  console.log(`turn status         : ${finished.status}`);
  console.log(`MARKER_42 in output : ${/MARKER_42/.test(agentText) || events.some((e) => e.kind === 'command.completed' && /MARKER_42/.test(e.output ?? ''))}`);
  console.log(`agent final text    : ${agentText.trim().slice(0, 600)}`);
  console.log(`event kinds in order: ${events.map((e) => e.kind).join(' > ')}`);

  // Keep the user's Codex history tidy: archive the PoC thread (reversible).
  try {
    await rpc.request('thread/archive', { threadId });
    console.log('thread archived     : yes');
  } catch (e) {
    console.log(`thread archived     : no (${e.message})`);
  }
} catch (e) {
  console.error('[poc] FAILED:', e.message, e.rpcError ?? '');
  process.exitCode = 1;
} finally {
  rpc.close();
  const killTimer = setTimeout(() => rpc.child.kill(), 5000);
  await rpc.exited;
  clearTimeout(killTimer);
  console.log(`[poc] log: ${logFile}`);
}
