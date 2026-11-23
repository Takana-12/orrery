// Minimal JSONL JSON-RPC peer over a child process's stdio (bidirectional: the server also sends us requests).
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

export class JsonRpcStdio {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<{ code: number | null }>;
  onNotification: (msg: RpcMessage) => void = () => {};
  onServerRequest: (msg: RpcMessage, respond: (result: unknown) => void, respondError: (code: number, message: string) => void) => void = () => {};
  onStderr: (line: string) => void = () => {};
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(command: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(command, args, { env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code) => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error(`process exited (code=${code})`));
        this.pending.clear();
        resolve({ code });
      });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.onStderr(line));
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && msg.method) {
      this.onServerRequest(
        msg,
        (result) => this.send({ id: msg.id, result }),
        (code, message) => this.send({ id: msg.id, error: { code, message } }),
      );
    } else if (hasId) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.onNotification(msg);
    }
  }

  /** Throws if the pipe is gone, so a reply that cannot be delivered is never reported as sent. */
  private send(msg: RpcMessage): void {
    if (this.closed || !this.child.stdin.writable) throw new Error('provider process is not running');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ method, id, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {}
  }
}
