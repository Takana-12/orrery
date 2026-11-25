// Short-lived, isolated Codex threads for reading preferences. They never enter the work/session lists.
import { tmpdir } from 'node:os';
import type { PreferenceHelper } from '../../provider-shared/src/preferences.ts';
import type { JsonRpcStdio, RpcMessage } from './jsonrpc.ts';

type Rpc = Pick<JsonRpcStdio, 'request'>;
interface Reading {
  text: string;
  turnId: string | null;
  completed: boolean;
  finish: (text: string | null) => void;
}

export class CodexPreferenceHelper {
  private readonly getRpc: () => Promise<Rpc>;
  private readonly readings = new Map<string, Reading>();
  private readonly pending = new Set<(text: string | null) => void>();

  constructor(getRpc: () => Promise<Rpc>) {
    this.getRpc = getRpc;
  }

  owns(threadId: string): boolean {
    return this.readings.has(threadId);
  }

  cancelAll(): void {
    for (const finish of this.pending) finish(null);
  }

  onNotification(msg: RpcMessage): boolean {
    const p = msg.params ?? {};
    const reading = this.readings.get(p.threadId);
    if (!reading) return false;
    if (msg.method === 'turn/started') reading.turnId = p.turn?.id ?? null;
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') reading.text = String(p.item.text ?? '');
    if (msg.method === 'turn/completed') {
      reading.completed = true;
      reading.finish(p.turn?.status === 'completed' ? reading.text || null : null);
    }
    return true;
  }

  readonly ask: PreferenceHelper = async (choice, prompt, systemPrompt, timeoutMs) => {
    let rpc: Rpc | undefined;
    let threadId: string | undefined;
    let settled = false;
    let finish!: Reading['finish'];
    const result = new Promise<string | null>((resolve) => {
      finish = (text) => { if (!settled) { settled = true; resolve(text); } };
    });
    const reading: Reading = { text: '', turnId: null, completed: false, finish };
    let unsubscribed = false;
    let interrupted = false;
    this.pending.add(finish);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const release = () => {
      if (!rpc || !threadId) return;
      if (!reading.completed && reading.turnId && !interrupted) {
        interrupted = true;
        void rpc.request('turn/interrupt', { threadId, turnId: reading.turnId }).catch(() => {});
      }
      if (!unsubscribed) {
        unsubscribed = true;
        void rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
      }
    };
    void (async () => {
      rpc = await this.getRpc();
      if (settled) return;
      // Discover only the configured names, so inherited MCP/plugin tools can be disabled without copying secrets.
      const configured = await rpc.request('config/read', { includeLayers: false });
      if (settled) return;
      const disabled = (v: unknown) => Object.fromEntries(Object.keys(v && typeof v === 'object' ? v : {}).map((id) => [id, { enabled: false }]));
      const started = await rpc.request('thread/start', {
        cwd: tmpdir(),
        ...(choice.model ? { model: choice.model } : {}),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        environments: [],
        selectedCapabilityRoots: [],
        baseInstructions: systemPrompt,
        developerInstructions: '',
        config: {
          project_doc_max_bytes: 0,
          web_search: 'disabled',
          features: { shell_tool: false, apply_patch_freeform: false, multi_agent: false, apps: false },
          mcp_servers: disabled(configured.config?.mcp_servers),
          plugins: { ...disabled(configured.config?.plugins), _default: { enabled: false } },
        },
      });
      threadId = started.thread.id;
      if (settled) { release(); return; }
      this.readings.set(threadId!, reading);
      const turn = await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(choice.effort ? { effort: choice.effort } : {}),
      });
      reading.turnId = turn.turn?.id ?? reading.turnId;
      if (settled) release();
    })().catch(() => finish(null));
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      this.pending.delete(finish);
      if (threadId) this.readings.delete(threadId);
      release();
    }
  };
}
