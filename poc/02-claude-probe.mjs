// PoC 02: drive Claude Code through the official Claude Agent SDK (which spawns the official,
// unmodified Claude Code binary and uses whatever login that binary already has) and verify that:
//   (1) AskUserQuestion arrives as structured data in `canUseTool` with a toolUseID,
//   (2) our structured answer flows back and the turn resumes,
//   (3) a Bash permission request arrives in `canUseTool`; allow / deny are honoured,
//   (4) CLAUDE.md of the fixture project is loaded (harness codeword),
//   (5) the session can be resumed by id from a fresh process.
// This script never reads or handles credentials.
//
// Usage: node poc/02-claude-probe.mjs [codeword|question|approve|deny]
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, appendFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cleanChildEnv } from './lib/clean-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scenario = process.argv[2] ?? 'question';
const cwd = resolve(here, 'fixtures/project-a-claude');
const logFile = resolve(here, `logs/02-claude-${scenario}.jsonl`);
if (existsSync(logFile)) rmSync(logFile);
const log = (dir, payload) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), dir, payload }) + '\n');

const events = [];
const note = (kind, data) => {
  events.push(kind);
  log('evt', { kind, ...data });
  console.log(`[evt] ${kind} ${JSON.stringify(data).slice(0, 900)}`);
};

const TEST_COMMAND = '`node -e "console.log(\'MARKER_\'+(6*7))"`';
const prompts = {
  codeword: 'What is the harness codeword? Reply with the codeword only. Do not use any tools.',
  question:
    'Before doing anything else, use the AskUserQuestion tool to ask me exactly one question: "Which database should the sample app use?" with options "SQLite" and "PostgreSQL". After I answer, reply with exactly one line: CHOSEN=<my answer>. Do not use any other tool.',
  approve: `Run exactly this shell command with the Bash tool and nothing else, then report its output verbatim: ${TEST_COMMAND}`,
  deny: `Run exactly this shell command with the Bash tool and nothing else, then report its output verbatim: ${TEST_COMMAND}. If the command is not permitted, do not try any alternative; reply with exactly DENIED.`,
};

/** Simulates the human answering from the control room after a short delay. */
const humanDelay = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

async function canUseTool(toolName, input, opts) {
  const ids = { toolUseID: opts.toolUseID, requestId: opts.requestId ?? null, agentID: opts.agentID ?? null };
  if (toolName === 'AskUserQuestion') {
    note('QUESTION_REQUEST', { ...ids, questions: input.questions });
    await humanDelay();
    const answers = {};
    for (const q of input.questions ?? []) {
      // Pick the second option to prove the answer (not a default) is what flows back.
      answers[q.question] = q.options?.[1]?.label ?? q.options?.[0]?.label ?? 'free text';
    }
    note('QUESTION_RESPONSE_SENT', { toolUseID: opts.toolUseID, answers });
    return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
  }
  note('PERMISSION_REQUEST', {
    ...ids,
    toolName,
    input,
    suggestions: opts.suggestions ?? null,
    decisionReason: opts.decisionReason ?? null,
    blockedPath: opts.blockedPath ?? null,
  });
  await humanDelay();
  if (scenario === 'deny') {
    note('PERMISSION_RESPONSE_SENT', { toolUseID: opts.toolUseID, behavior: 'deny' });
    return { behavior: 'deny', message: 'Denied by the human in the control room PoC.' };
  }
  note('PERMISSION_RESPONSE_SENT', { toolUseID: opts.toolUseID, behavior: 'allow' });
  return { behavior: 'allow', updatedInput: input };
}

async function runTurn(promptText, extraOptions = {}) {
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: promptText }, parent_tool_use_id: null, session_id: '' };
    await done; // keep the input stream open while callbacks may still be needed
  }
  const out = { sessionId: null, resultText: '', result: null, init: null, toolResults: [] };
  const q = query({
    prompt: input(),
    options: {
      cwd,
      model: 'haiku', // cheapest model: this is a protocol test, not a quality test
      canUseTool,
      env: cleanChildEnv(),
      stderr: (line) => log('stderr', line),
      ...extraOptions,
    },
  });
  const timer = setTimeout(() => {
    console.error('[poc] timeout, interrupting');
    q.interrupt().catch(() => {});
    finish();
  }, 180_000);
  try {
    for await (const m of q) {
      log('recv', m);
      if (m.type === 'system' && m.subtype === 'init') {
        out.init = m;
        out.sessionId = m.session_id;
        note('init', {
          sessionId: m.session_id,
          model: m.model,
          permissionMode: m.permissionMode,
          claudeCodeVersion: m.claude_code_version ?? null,
          apiKeySource: m.apiKeySource ?? null,
          cwd: m.cwd,
        });
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === 'tool_result') {
            const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
            out.toolResults.push(text);
            note('tool_result', { toolUseId: c.tool_use_id, isError: c.is_error ?? false, text: text.slice(0, 200) });
          }
        }
      } else if (m.type === 'result') {
        out.result = m;
        out.resultText = m.result ?? '';
        note('result', { subtype: m.subtype, isError: m.is_error, numTurns: m.num_turns, costUsd: m.total_cost_usd, sessionId: m.session_id });
        finish();
      }
    }
  } finally {
    clearTimeout(timer);
    finish();
  }
  return out;
}

try {
  const first = await runTurn(prompts[scenario]);
  console.log('\n===== RESULT =====');
  console.log(`scenario             : ${scenario}`);
  console.log(`sessionId            : ${first.sessionId}`);
  console.log(`result subtype       : ${first.result?.subtype}`);
  console.log(`final text           : ${first.resultText.trim().slice(0, 400)}`);
  console.log(`MARKER_42 in results : ${first.toolResults.some((t) => /MARKER_42/.test(t))}`);
  console.log(`event kinds in order : ${events.join(' > ')}`);

  if (scenario === 'question' && first.sessionId) {
    events.length = 0;
    const second = await runTurn(
      'Which database did I choose a moment ago? Reply with exactly one line: CHOSEN_AGAIN=<answer>. Do not use any tools.',
      { resume: first.sessionId },
    );
    console.log('\n===== RESUME (new process, same session id) =====');
    console.log(`resumed sessionId    : ${second.sessionId}`);
    console.log(`final text           : ${second.resultText.trim().slice(0, 200)}`);
  }
} catch (e) {
  console.error('[poc] FAILED:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  console.log(`[poc] log: ${logFile}`);
}
