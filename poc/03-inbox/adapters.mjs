// Provider adapters for the PoC. Each adapter turns provider-native events into the same small
// vocabulary for the hub: session status changes and "attention requests" that carry a `reply`
// function bound to the exact originating request. Nothing here types text into a terminal.
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { JsonRpcStdio } from '../lib/jsonrpc-stdio.mjs';
import { findCodex } from '../lib/find-codex.mjs';
import { cleanChildEnv } from '../lib/clean-env.mjs';

/**
 * Hub callbacks (implemented in hub.mjs):
 *   hub.sessionUpdate(sessionId, patch)
 *   hub.attentionOpen({ sessionId, sourceRequestId, type, title, questions?, approval?, raw, reply }) -> itemId
 *   hub.attentionAcknowledged(sessionId, sourceRequestId, evidence)   provider confirmed our answer landed
 *   hub.attentionWithdrawn(sessionId, sourceRequestId, reason)        provider no longer wants an answer
 */

// ---------------------------------------------------------------------------------------------
// Codex: ONE `codex app-server` process hosts many threads (one per session), each with its own cwd.
// ---------------------------------------------------------------------------------------------
export class CodexAdapter {
  constructor(hub, { logFile } = {}) {
    this.hub = hub;
    this.logFile = logFile;
    this.rpc = null;
    this.threadToSession = new Map(); // threadId -> sessionId
    this.sessions = new Map(); // sessionId -> { threadId, turnId, text }
  }

  // Single-flight: concurrent startSession calls must share ONE app-server process.
  // (Without this, two processes were spawned and a thread created on one was addressed on the other.)
  #ensureStarted() {
    this.starting ??= (async () => {
      const rpc = new JsonRpcStdio(findCodex(), ['app-server'], { logFile: this.logFile, label: 'codex' });
      rpc.onNotification = (m) => this.#onNotification(m);
      rpc.onServerRequest = (m, respond, respondError) => this.#onServerRequest(m, respond, respondError);
      await rpc.request('initialize', {
        clientInfo: { name: 'control_room_poc', title: 'Agent Control Room PoC', version: '0.0.1' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify('initialized');
      this.rpc = rpc;
    })();
    return this.starting;
  }

  get pid() {
    return this.rpc?.pid ?? null;
  }

  async startSession({ sessionId, cwd, prompt, planMode = false }) {
    await this.#ensureStarted();
    const started = await this.rpc.request('thread/start', { cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    const threadId = started.thread.id;
    this.threadToSession.set(threadId, sessionId);
    this.sessions.set(sessionId, { threadId, turnId: null, text: '' });
    this.hub.sessionUpdate(sessionId, { providerSessionId: threadId, model: started.model, processPid: this.rpc.pid, status: 'running' });
    const params = { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] };
    if (planMode) {
      params.collaborationMode = {
        mode: 'plan',
        settings: { model: started.model, reasoning_effort: started.reasoningEffort ?? null, developer_instructions: null },
      };
    }
    const turn = await this.rpc.request('turn/start', params);
    this.sessions.get(sessionId).turnId = turn.turn?.id ?? null;
  }

  async interrupt(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s?.turnId) throw new Error('no active turn');
    await this.rpc.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
  }

  async archive(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) await this.rpc.request('thread/archive', { threadId: s.threadId }).catch(() => {});
  }

  #onNotification(msg) {
    const p = msg.params ?? {};
    const sessionId = this.threadToSession.get(p.threadId);
    if (!sessionId) return;
    const s = this.sessions.get(sessionId);
    switch (msg.method) {
      case 'thread/status/changed': {
        const st = p.status;
        if (st.type === 'active') {
          const waiting = st.activeFlags?.length > 0;
          this.hub.sessionUpdate(sessionId, { status: waiting ? 'waiting_for_user' : 'running', providerStatus: st });
        }
        break;
      }
      case 'turn/started':
        s.turnId = p.turn?.id ?? s.turnId;
        break;
      case 'item/completed':
        if (p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') s.text = p.item.text ?? s.text;
        if (p.item?.type === 'commandExecution')
          this.hub.sessionUpdate(sessionId, { lastCommand: { status: p.item.status, exitCode: p.item.exitCode ?? null } });
        break;
      case 'serverRequest/resolved':
        // Provider-side acknowledgement that the request is settled (by us, or withdrawn by the provider).
        this.hub.attentionAcknowledged(sessionId, String(p.requestId), { via: 'serverRequest/resolved' });
        break;
      case 'turn/completed': {
        const status = p.turn?.status;
        this.hub.sessionUpdate(sessionId, {
          status: status === 'completed' ? 'turn_finished' : status === 'interrupted' ? 'interrupted' : 'error',
          lastText: s.text,
          turnStatus: status,
        });
        break;
      }
    }
  }

  #onServerRequest(msg, respond, respondError) {
    const p = msg.params ?? {};
    const sessionId = this.threadToSession.get(p.threadId);
    if (!sessionId) return respondError(-32000, 'unknown thread');
    const sourceRequestId = String(msg.id);
    const base = { sessionId, sourceRequestId, raw: { method: msg.method, id: msg.id, params: p } };
    switch (msg.method) {
      case 'item/commandExecution/requestApproval': {
        const allowed = (p.availableDecisions ?? ['accept', 'decline', 'cancel']).filter((d) => typeof d === 'string');
        this.hub.attentionOpen({
          ...base,
          type: 'permission_approval',
          title: 'コマンド実行の承認',
          approval: { tool: 'shell', command: p.command, cwd: p.cwd, reason: p.reason ?? null, decisions: [...new Set([...allowed, 'decline'])] },
          reply: (answer) => respond({ decision: answer.decision }),
        });
        break;
      }
      case 'item/fileChange/requestApproval':
        this.hub.attentionOpen({
          ...base,
          type: 'permission_approval',
          title: 'ファイル変更の承認',
          approval: { tool: 'apply_patch', command: null, cwd: null, reason: p.reason ?? null, decisions: ['accept', 'decline', 'cancel'] },
          reply: (answer) => respond({ decision: answer.decision }),
        });
        break;
      case 'item/tool/requestUserInput':
        this.hub.attentionOpen({
          ...base,
          type: 'user_question',
          title: p.questions?.[0]?.header ?? '質問',
          questions: (p.questions ?? []).map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            multiSelect: false,
            allowFreeText: !!q.isOther,
            options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
          })),
          // answer.answers: { [questionId]: string[] }
          reply: (answer) =>
            respond({ answers: Object.fromEntries(Object.entries(answer.answers).map(([id, v]) => [id, { answers: v }])) }),
        });
        break;
      default:
        respondError(-32601, `PoC does not handle ${msg.method}`);
    }
  }

  async shutdown() {
    if (!this.rpc) return;
    this.rpc.close();
    const t = setTimeout(() => this.rpc.child.kill(), 4000);
    await this.rpc.exited;
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------------------------
// Claude: one Agent SDK query (= one Claude Code process) per live session.
// ---------------------------------------------------------------------------------------------
export class ClaudeAdapter {
  constructor(hub, { log } = {}) {
    this.hub = hub;
    this.log = log ?? (() => {});
    this.sessions = new Map(); // sessionId -> { query, finish }
  }

  async startSession({ sessionId, cwd, prompt, model = 'haiku' }) {
    let finish;
    const done = new Promise((r) => (finish = r));
    async function* input() {
      yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' };
      await done;
    }
    const pendingToolUse = new Set();
    const canUseTool = (toolName, toolInput, opts) =>
      new Promise((resolvePermission) => {
        const sourceRequestId = opts.toolUseID;
        pendingToolUse.add(sourceRequestId);
        const base = { sessionId, sourceRequestId, raw: { toolName, input: toolInput, toolUseID: opts.toolUseID, requestId: opts.requestId ?? null, suggestions: opts.suggestions ?? null } };
        // If Claude Code withdraws the request (interrupt, turn ended), retire the inbox item.
        opts.signal?.addEventListener('abort', () => {
          this.hub.attentionWithdrawn(sessionId, sourceRequestId, 'aborted by provider');
          resolvePermission({ behavior: 'deny', message: 'Request was withdrawn.' });
        });
        if (toolName === 'AskUserQuestion') {
          this.hub.attentionOpen({
            ...base,
            type: 'user_question',
            title: toolInput.questions?.[0]?.header ?? '質問',
            questions: (toolInput.questions ?? []).map((q) => ({
              id: q.question, // Claude keys answers by question text
              header: q.header,
              question: q.question,
              multiSelect: !!q.multiSelect,
              allowFreeText: true,
              options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
            })),
            reply: (answer) =>
              resolvePermission({
                behavior: 'allow',
                updatedInput: {
                  questions: toolInput.questions,
                  answers: Object.fromEntries(Object.entries(answer.answers).map(([id, v]) => [id, v.join(', ')])),
                },
              }),
          });
        } else {
          this.hub.attentionOpen({
            ...base,
            type: 'permission_approval',
            title: `${toolName} の実行承認`,
            approval: {
              tool: toolName,
              command: toolInput.command ?? JSON.stringify(toolInput),
              cwd,
              reason: opts.decisionReason ?? null,
              decisions: ['accept', 'decline'],
            },
            reply: (answer) =>
              resolvePermission(
                answer.decision === 'accept'
                  ? { behavior: 'allow', updatedInput: toolInput }
                  : { behavior: 'deny', message: answer.message ?? 'Denied by the user in the control room.' },
              ),
          });
        }
      });

    const q = query({
      prompt: input(),
      options: { cwd, model, canUseTool, env: cleanChildEnv(), stderr: (l) => this.log('claude-stderr', l) },
    });
    this.sessions.set(sessionId, { query: q, finish });
    this.hub.sessionUpdate(sessionId, { status: 'running' });

    (async () => {
      try {
        for await (const m of q) {
          this.log('claude-recv', { sessionId, m });
          if (m.type === 'system' && m.subtype === 'init') {
            this.hub.sessionUpdate(sessionId, { providerSessionId: m.session_id, model: m.model });
          } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
            for (const c of m.message.content) {
              if (c.type === 'tool_result' && pendingToolUse.has(c.tool_use_id)) {
                pendingToolUse.delete(c.tool_use_id);
                // The tool result for this tool_use id is our evidence that the answer was applied.
                this.hub.attentionAcknowledged(sessionId, c.tool_use_id, { via: 'tool_result', isError: !!c.is_error });
                this.hub.sessionUpdate(sessionId, { status: 'running', lastToolResult: String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300) });
              }
            }
          } else if (m.type === 'result') {
            this.hub.sessionUpdate(sessionId, {
              status: m.subtype === 'success' ? 'turn_finished' : 'error',
              lastText: m.result ?? '',
              turnStatus: m.subtype,
            });
            finish();
          }
        }
      } catch (e) {
        this.hub.sessionUpdate(sessionId, { status: 'error', error: String(e?.message ?? e) });
      } finally {
        finish();
        this.hub.sessionUpdate(sessionId, { processAlive: false });
      }
    })();
  }

  async interrupt(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('unknown session');
    await s.query.interrupt();
    this.hub.sessionUpdate(sessionId, { status: 'interrupted' });
  }

  async shutdown() {
    for (const s of this.sessions.values()) {
      s.finish();
      try {
        s.query.close?.();
      } catch {}
    }
  }
}

export const newId = () => randomUUID();
