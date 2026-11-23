// PoC 03: one local page that aggregates questions / approvals from a Claude session and Codex
// sessions running in parallel, and answers each one back to its exact originating request.
//
//   node poc/03-inbox/server.mjs            -> http://127.0.0.1:4777
//   node poc/03-inbox/server.mjs --demo     -> also starts the three demo sessions (E2E test 1 of the brief)
//
// Local only: binds 127.0.0.1 and rejects requests whose Host/Origin is not this server (DNS-rebinding / CSRF guard).
import { createServer } from 'node:http';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './hub.mjs';
import { CodexAdapter, ClaudeAdapter } from './adapters.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4777);
const logsDir = resolve(here, '../logs');
mkdirSync(logsDir, { recursive: true });
const eventLog = resolve(logsDir, '03-hub-events.jsonl');
const codexLog = resolve(logsDir, '03-codex-rpc.jsonl');
for (const f of [eventLog, codexLog]) if (existsSync(f)) rmSync(f);

const hub = new Hub({ eventLog });
const codex = new CodexAdapter(hub, { logFile: codexLog });
const claude = new ClaudeAdapter(hub);
const adapters = { codex, claude };

const fixtures = {
  a: resolve(here, '../fixtures/project-a-claude'),
  b: resolve(here, '../fixtures/project-b-codex'),
};
const TEST_COMMAND = '`node -e "console.log(\'MARKER_\'+(6*7))"`';
export const PRESETS = {
  'claude-question': {
    provider: 'claude',
    cwd: fixtures.a,
    projectName: 'project-a (Claude)',
    task: 'DB選定の質問',
    prompt:
      'Before doing anything else, use the AskUserQuestion tool to ask me exactly one question: "Which database should the sample app use?" with options "SQLite" and "PostgreSQL". After I answer, reply with exactly one line: CHOSEN=<my answer>. Do not use any other tool.',
  },
  'claude-approval': {
    provider: 'claude',
    cwd: fixtures.a,
    projectName: 'project-a (Claude)',
    task: 'コマンド実行',
    prompt: `Run exactly this shell command with the Bash tool and nothing else, then report its output verbatim: ${TEST_COMMAND}. If it is not permitted, reply with exactly DENIED.`,
  },
  'codex-approval': {
    provider: 'codex',
    cwd: fixtures.b,
    projectName: 'project-b (Codex)',
    task: 'コマンド実行',
    prompt: `Run exactly this shell command and nothing else, then report its output verbatim: ${TEST_COMMAND}. If the command is not permitted, do not try any alternative; reply with exactly DECLINED.`,
  },
  'codex-question': {
    provider: 'codex',
    cwd: fixtures.b,
    projectName: 'project-b (Codex)',
    task: 'DB選定の質問',
    planMode: true,
    prompt:
      'Before doing anything else, use the request_user_input tool to ask me one multiple-choice question: "Which database should the sample app use?" with options "SQLite" and "PostgreSQL". After I answer, reply with exactly one line: CHOSEN=<my answer>. Do not run any commands.',
  },
  'codex-noattention': {
    provider: 'codex',
    cwd: fixtures.b,
    projectName: 'project-c (Codex)',
    task: '質問なしで完了するタスク',
    prompt: 'What is the harness codeword? Reply with the codeword only. Do not run any commands.',
  },
};

async function startPreset(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset ${name}`);
  const sessionId = hub.createSession({ provider: p.provider, cwd: p.cwd, projectName: p.projectName, task: p.task });
  adapters[p.provider]
    .startSession({ sessionId, cwd: p.cwd, prompt: p.prompt, planMode: p.planMode })
    .catch((e) => hub.sessionUpdate(sessionId, { status: 'error', error: String(e?.message ?? e) }));
  return sessionId;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const sseClients = new Set();
hub.on('change', () => {
  const payload = `data: ${JSON.stringify(hub.snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
});

const server = createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(req.headers.host ?? '')) return json(res, 403, { error: 'bad host' });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'bad origin' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(resolve(here, 'index.html')));
    }
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, hub.snapshot());
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(hub.snapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'GET' && path === '/api/presets') return json(res, 200, Object.keys(PRESETS));
    if (req.method === 'POST' && path === '/api/sessions') {
      const body = await readBody(req);
      return json(res, 200, { sessionId: await startPreset(body.preset) });
    }
    let m;
    if (req.method === 'POST' && (m = path.match(/^\/api\/items\/([\w-]+)\/answer$/))) {
      const body = await readBody(req);
      const r = hub.answer(m[1], body);
      return json(res, r.ok ? 200 : r.code, r);
    }
    if (req.method === 'POST' && (m = path.match(/^\/api\/sessions\/([\w-]+)\/interrupt$/))) {
      const s = hub.sessions.get(m[1]);
      if (!s) return json(res, 404, { error: 'unknown session' });
      await adapters[s.provider].interrupt(m[1]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/shutdown') {
      json(res, 200, { ok: true });
      return void shutdown();
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

async function shutdown() {
  for (const s of hub.sessions.values()) if (s.provider === 'codex') await codex.archive(s.id);
  await claude.shutdown();
  await codex.shutdown();
  server.close();
  for (const c of sseClients) c.end();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[inbox] http://127.0.0.1:${PORT}  (pid ${process.pid})`);
  if (process.argv.includes('--demo')) {
    for (const p of ['claude-question', 'codex-approval', 'codex-noattention']) await startPreset(p);
  }
});
