// Codex adapter: drives the official `codex app-server` over stdio JSON-RPC.
// ONE app-server process hosts every Codex session (thread); each thread has its own cwd.
// The official binary reads the user's existing ChatGPT login from its own home directory; this code never touches credentials.
import { formFromElicitation } from '#core';
import type { ApprovalDecision, AuthStatus, FileChange, ModelChoice, UsageLimit, ProviderAdapter, ProviderCapabilities, ProviderSink, StartSessionRequest } from '#core';
import { JsonRpcStdio } from './jsonrpc.ts';
import type { RpcMessage } from './jsonrpc.ts';
import { findCodex } from './find-codex.ts';

export interface CodexStartOptions {
  /** Omit to follow the user's ~/.codex/config.toml (the default: provider-native). */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Extra per-thread config overrides (same keys as config.toml), e.g. an additional MCP server. Advanced / tests. */
  config?: Record<string, unknown>;
}

interface CodexSession {
  threadId: string;
  turnId: string | null;
  finalText: string;
  model: string | null;
  reasoningEffort: string | null;
  /** Effort the human chose for this session; sent with every turn. */
  effort: string | null;
  /** Thread token totals: latest reported, and the part already recorded. */
  tokens: { input: number; output: number; cached: number } | null;
  recorded: { input: number; output: number; cached: number };
}

const windowLabel = (mins: number | null | undefined): string => (mins === 300 ? '5時間枠' : mins === 10080 ? '週間枠' : mins ? `${mins}分枠` : '利用枠');
const toMs = (t: number | null | undefined): number | null => (t ? (t < 1e12 ? t * 1000 : t) : null);

const KNOWN_DECISIONS: ApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const;
  private rpc: JsonRpcStdio | null = null;
  private starting: Promise<JsonRpcStdio> | null = null;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly threadToSession = new Map<string, string>();
  /** fileChange item id -> proposed changes, captured from item/started so the approval card can show the diff. */
  private readonly fileChanges = new Map<string, FileChange[]>();
  private shuttingDown = false;
  private readonly sink: ProviderSink;
  private readonly defaults: CodexStartOptions;

  constructor(sink: ProviderSink, defaults: CodexStartOptions = {}) {
    this.sink = sink;
    this.defaults = defaults;
  }

  capabilities(): ProviderCapabilities {
    return {
      structuredQuestions: 'plan_mode_only',
      multiSelectQuestions: false,
      denyWithMessage: false,
      resume: 'unverified',
      acknowledgement: 'serverRequest/resolved 通知',
      processModel: 'shared_process',
    };
  }

  /** Single-flight: concurrent callers must share ONE app-server. Two servers would each own different threads. */
  private ensureStarted(): Promise<JsonRpcStdio> {
    this.starting ??= (async () => {
      const rpc = new JsonRpcStdio(findCodex(), ['app-server']);
      this.sink.processSpawned({ provider: 'codex', sessionId: null }, rpc.pid);
      rpc.onNotification = (m) => this.onNotification(m);
      rpc.onServerRequest = (m, respond, respondError) => this.onServerRequest(m, respond, respondError);
      void rpc.exited.then(() => this.onProcessExit(rpc));
      await rpc.request('initialize', {
        clientInfo: { name: 'agent_control_room', title: 'Agent Control Room', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify('initialized');
      this.rpc = rpc;
      return rpc;
    })();
    this.starting.catch(() => (this.starting = null));
    return this.starting;
  }

  private onProcessExit(rpc: JsonRpcStdio): void {
    if (this.rpc !== rpc && this.rpc !== null) return;
    this.rpc = null;
    this.starting = null;
    // Every thread lived in that process. Pending requests died with it and are not re-issued by Codex.
    for (const sessionId of this.sessions.keys()) this.sink.sessionUpdate(sessionId, { process: this.shuttingDown ? 'stopped' : 'crashed' });
    this.sessions.clear();
    this.threadToSession.clear();
  }

  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async listModels(): Promise<ModelChoice[]> {
    const rpc = await this.ensureStarted();
    const r = await rpc.request('model/list', { limit: 50 });
    return (r.data ?? [])
      .filter((m: any) => !m.hidden)
      .map((m: any) => ({
        id: m.model,
        label: m.displayName ?? m.model,
        description: m.description ?? undefined,
        isDefault: !!m.isDefault,
        efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort ?? null,
      }));
  }

  async authStatus(): Promise<AuthStatus> {
    const rpc = await this.ensureStarted();
    const r = await rpc.request('account/read', { refreshToken: false });
    return { loggedIn: !!r.account || r.requiresOpenaiAuth === false, plan: r.account?.planType ?? null, method: r.account?.type ?? null };
  }

  /** Codex's own ChatGPT sign-in: the app-server runs the local callback, the human signs in on OpenAI's page. */
  async startLogin(): Promise<{ url?: string }> {
    const rpc = await this.ensureStarted();
    const r = await rpc.request('account/login/start', { type: 'chatgpt' });
    return { url: r.authUrl };
  }

  async limits(): Promise<UsageLimit[]> {
    const rpc = await this.ensureStarted();
    const r = await rpc.request('account/rateLimits/read', {});
    const out: UsageLimit[] = [];
    for (const w of [r.rateLimits?.primary, r.rateLimits?.secondary]) {
      if (w) out.push({ label: windowLabel(w.windowDurationMins), kind: w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'weekly' : 'other', usedPercent: Math.round(w.usedPercent), resetsAt: toMs(w.resetsAt), state: w.usedPercent >= 100 ? 'reached' : w.usedPercent >= 80 ? 'warning' : 'ok' });
    }
    return out;
  }

  async startSession(req: StartSessionRequest & { codex?: CodexStartOptions }): Promise<void> {
    const rpc = await this.ensureStarted();
    const opts = { ...this.defaults, ...req.codex };
    const common: Record<string, unknown> = { cwd: req.cwd };
    if (opts.approvalPolicy) common.approvalPolicy = opts.approvalPolicy;
    if (opts.sandbox) common.sandbox = opts.sandbox;
    if (req.approvalMode === 'auto') {
      // Codex's own risk-based reviewer answers approval requests; what it will not approve still comes to the human.
      common.approvalsReviewer = 'auto_review';
      if (!opts.approvalPolicy) common.approvalPolicy = 'on-request';
    }
    // Project env reaches the agent's commands through Codex's own shell_environment_policy (same key as config.toml).
    const config: Record<string, unknown> = { ...(opts.config ?? {}) };
    if (req.env && Object.keys(req.env).length) {
      const policy = (config.shell_environment_policy as Record<string, unknown> | undefined) ?? {};
      config.shell_environment_policy = { ...policy, set: { ...((policy.set as object) ?? {}), ...req.env } };
    }
    if (Object.keys(config).length) common.config = config;
    if (req.model) common.model = req.model;
    const started = req.resumeProviderSessionId
      ? await rpc.request('thread/resume', { threadId: req.resumeProviderSessionId, ...common })
      : await rpc.request('thread/start', common);
    const threadId: string = started.thread.id;
    this.threadToSession.set(threadId, req.sessionId);
    this.sessions.set(req.sessionId, { threadId, turnId: null, finalText: '', model: started.model ?? null, reasoningEffort: started.reasoningEffort ?? null, effort: req.effort ?? null, tokens: null, recorded: { input: 0, output: 0, cached: 0 } });
    this.sink.sessionUpdate(req.sessionId, { providerSessionId: threadId, model: started.model ?? undefined, process: 'alive', error: null });
    await this.runTurn(req.sessionId, req.prompt, !!req.planMode, req.shownPrompt);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error('session is not live');
    await this.runTurn(sessionId, text, false);
  }

  private async runTurn(sessionId: string, text: string, planMode: boolean, shown?: string): Promise<void> {
    const s = this.sessions.get(sessionId)!;
    const params: Record<string, unknown> = { threadId: s.threadId, input: [{ type: 'text', text, text_elements: [] }] };
    if (s.effort) params.effort = s.effort;
    if (planMode && s.model) {
      params.collaborationMode = { mode: 'plan', settings: { model: s.model, reasoning_effort: s.reasoningEffort, developer_instructions: null } };
    }
    s.finalText = ''; // a turn that says nothing must not be reported with the previous turn's words
    this.sink.transcript(sessionId, { role: 'user', text: shown ?? text });
    this.sink.sessionUpdate(sessionId, { lifecycle: 'running' });
    const turn = await this.rpc!.request('turn/start', params);
    s.turnId = turn.turn?.id ?? null;
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.turnId || !this.rpc) throw new Error('実行中のターンがありません');
    await this.rpc.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
  }

  /** Codex threads share one process, so there is nothing to free per session; the thread just goes idle. */
  async stop(_sessionId: string): Promise<void> {}

  async archive(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s && this.rpc) await this.rpc.request('thread/archive', { threadId: s.threadId }).catch(() => {});
  }

  private onNotification(msg: RpcMessage): void {
    const p = msg.params ?? {};
    const sessionId = this.threadToSession.get(p.threadId);
    if (!sessionId) return;
    const s = this.sessions.get(sessionId)!;
    switch (msg.method) {
      case 'thread/status/changed':
        if (p.status?.type === 'active') {
          this.sink.sessionUpdate(sessionId, { lifecycle: p.status.activeFlags?.length ? 'waiting_for_user' : 'running' });
        }
        break;
      case 'turn/started':
        s.turnId = p.turn?.id ?? s.turnId;
        break;
      case 'item/started':
        if (p.item?.type === 'fileChange' && Array.isArray(p.item.changes)) {
          this.fileChanges.set(
            p.item.id,
            p.item.changes.map((c: any) => {
              const kind = c.kind?.type === 'add' ? 'add' : c.kind?.type === 'delete' ? 'delete' : 'update';
              const raw = String(c.diff ?? '').replace(/\n$/, '');
              // Codex sends the full content (not a diff) for added and deleted files.
              const diff = kind === 'update' ? raw : raw.split('\n').map((l) => (kind === 'add' ? '+' : '-') + l).join('\n');
              return { path: String(c.path), kind, diff };
            }),
          );
        }
        break;
      case 'item/completed': {
        const item = p.item ?? {};
        if (item.type === 'agentMessage' && item.text) {
          if (item.phase !== 'commentary') s.finalText = item.text;
          this.sink.transcript(sessionId, { role: 'assistant', text: item.text });
        } else if (item.type === 'fileChange') {
          this.fileChanges.delete(item.id);
          const paths = (item.changes ?? []).map((c: any) => c.path).join(', ');
          this.sink.transcript(sessionId, { role: 'tool', text: `ファイル変更 [${item.status}] ${paths}` });
        } else if (item.type === 'commandExecution') {
          const out = String(item.aggregatedOutput ?? '').slice(0, 4000);
          this.sink.transcript(sessionId, { role: 'tool', text: `$ ${item.command}\n[${item.status}${item.exitCode != null ? ` exit=${item.exitCode}` : ''}]\n${out}` });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const t = p.tokenUsage?.total;
        if (t) s.tokens = { input: t.inputTokens ?? 0, output: t.outputTokens ?? 0, cached: t.cachedInputTokens ?? 0 };
        break;
      }
      case 'serverRequest/resolved':
        this.sink.attentionAcknowledged(sessionId, String(p.requestId), 'serverRequest/resolved');
        break;
      case 'turn/completed': {
        const status: string = p.turn?.status;
        if (s.tokens) {
          // Codex reports thread totals; record only what this turn added.
          const d = { input: s.tokens.input - s.recorded.input, output: s.tokens.output - s.recorded.output, cached: s.tokens.cached - s.recorded.cached };
          s.recorded = { ...s.tokens };
          if (d.input > 0 || d.output > 0) this.sink.usage(sessionId, { inputTokens: d.input, outputTokens: d.output, cachedInputTokens: Math.max(0, d.cached) });
        }
        this.sink.sessionUpdate(sessionId, {
          lifecycle: status === 'completed' ? 'turn_finished' : status === 'interrupted' ? 'interrupted' : 'error',
          lastTurnOutcome: status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed',
          lastText: s.finalText,
          ...(status === 'failed' ? { error: String(p.turn?.error?.message ?? 'turn failed') } : {}),
        });
        break;
      }
    }
  }

  private onServerRequest(msg: RpcMessage, respond: (r: unknown) => void, respondError: (code: number, message: string) => void): void {
    const p = msg.params ?? {};
    const sessionId = this.threadToSession.get(p.threadId);
    if (!sessionId) return respondError(-32000, 'unknown thread');
    const requestId = String(msg.id);
    const rawPayloadRef = this.sink.saveRaw(sessionId, { method: msg.method, id: msg.id, params: p });
    const base = { sessionId, requestId, turnId: p.turnId ?? null, rawPayloadRef };
    switch (msg.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const isCommand = msg.method === 'item/commandExecution/requestApproval';
        // Offer what the provider says is valid. Only simple string decisions are surfaced for now; policy
        // amendments ("always allow commands starting with ...") stay visible in the raw payload but are not offered.
        const offered: ApprovalDecision[] = (p.availableDecisions ?? ['accept', 'decline', 'cancel']).filter(
          (d: unknown): d is ApprovalDecision => typeof d === 'string' && KNOWN_DECISIONS.includes(d as ApprovalDecision),
        );
        // `decline` was accepted by Codex 0.171 even when not listed (verified on this machine); a human must always be able to say no.
        const decisions = offered.includes('decline') ? offered : [...offered, 'decline' as const];
        const changes = isCommand ? null : (this.fileChanges.get(p.itemId) ?? null);
        this.sink.attentionOpen({
          ...base,
          type: 'permission_approval',
          summary: isCommand ? 'コマンド実行の承認' : 'ファイル変更の承認',
          approval: {
            tool: isCommand ? 'shell' : 'apply_patch',
            subject: isCommand ? (p.command ?? null) : changes ? changes.map((c) => `${c.kind}: ${c.path}`).join('\n') : null,
            cwd: p.cwd ?? null,
            reason: p.reason ?? (p.grantRoot ? `書き込み先の追加許可: ${p.grantRoot}` : null),
            decisions,
            changes,
          },
          reply: (answer) => {
            if (answer.kind !== 'decision') throw new Error('decision expected');
            respond({ decision: answer.decision });
          },
        });
        break;
      }
      case 'item/tool/requestUserInput':
        this.sink.attentionOpen({
          ...base,
          type: 'user_question',
          summary: p.questions?.[0]?.question ?? '質問',
          questions: (p.questions ?? []).map((q: any) => ({
            id: q.id,
            header: q.header ?? null,
            text: q.question,
            multiSelect: false,
            allowFreeText: !!q.isOther,
            isSecret: !!q.isSecret,
            options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description ?? null })),
          })),
          reply: (answer) => {
            if (answer.kind !== 'answers') throw new Error('answers expected');
            respond({ answers: Object.fromEntries(Object.entries(answer.answers).map(([id, v]) => [id, { answers: v }])) });
          },
        });
        break;
      case 'mcpServer/elicitation/request': {
        // Only the standard form mode is presented. Anything else is declined (a valid MCP answer), never accepted unseen.
        const form = p.mode === 'form' ? formFromElicitation(p.requestedSchema) : null;
        if (!form) {
          this.sink.transcript(sessionId, { role: 'system', text: `MCPサーバー「${p.serverName}」からの入力要求（${p.mode}）は未対応の形式のため辞退しました` });
          respond({ action: 'decline', content: null, _meta: null });
          break;
        }
        if (form.questions.length === 0) {
          this.sink.attentionOpen({
            ...base,
            type: 'permission_approval',
            summary: `MCPサーバー「${p.serverName}」の確認`,
            approval: { tool: `mcp:${p.serverName}`, subject: String(p.message ?? ''), cwd: null, reason: null, decisions: ['accept', 'decline'] },
            reply: (answer) => {
              if (answer.kind !== 'decision') throw new Error('decision expected');
              respond(answer.decision === 'accept' ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null });
            },
          });
          break;
        }
        this.sink.attentionOpen({
          ...base,
          type: 'user_question',
          summary: `MCPサーバー「${p.serverName}」: ${p.message ?? '入力の要求'}`,
          questions: form.questions,
          allowDecline: true,
          reply: (answer) => {
            if (answer.kind === 'decline') return respond({ action: 'decline', content: null, _meta: null });
            if (answer.kind !== 'answers') throw new Error('answers expected');
            respond({ action: 'accept', content: form.toContent(answer.answers), _meta: null });
          },
        });
        break;
      }
      default:
        // Not supported yet (permission profiles, dynamic tools ...). Fail closed and say so,
        // rather than auto-accepting something the human never saw.
        this.sink.transcript(sessionId, { role: 'system', text: `未対応の要求種別のため自動で拒否しました: ${msg.method}` });
        respondError(-32601, `Agent Control Room does not handle ${msg.method} yet`);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const rpc = this.rpc;
    if (!rpc) return;
    rpc.close();
    await Promise.race([rpc.exited, new Promise((r) => setTimeout(r, 4000))]);
  }
}
