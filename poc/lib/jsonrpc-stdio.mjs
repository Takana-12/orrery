// Minimal JSONL JSON-RPC peer over a child process's stdio.
// Used by the PoC to talk to `codex app-server` (bidirectional: the server also sends requests to us).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

export class JsonRpcStdio {
  /**
   * @param {string} command
   * @param {string[]} args
   * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, logFile?: string, label?: string }} opts
   */
  constructor(command, args, opts = {}) {
    this.label = opts.label ?? 'rpc';
    this.logFile = opts.logFile;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    /** Handler for server->client requests. Must call respond(result) or respondError(). */
    this.onServerRequest = (_msg, _respond) => {};
    this.child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.#log('exit', { code, signal });
        for (const [, p] of this.pending) p.reject(new Error(`${this.label} exited (code=${code})`));
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.#onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.#log('stderr', line));
  }

  get pid() {
    return this.child.pid;
  }

  #log(dir, payload) {
    if (!this.logFile) return;
    appendFileSync(this.logFile, JSON.stringify({ t: new Date().toISOString(), who: this.label, dir, payload }) + '\n');
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#log('stdout-nonjson', line);
      return;
    }
    this.#log('recv', msg);
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && msg.method) {
      // server -> client request
      const respond = (result) => this.#send({ id: msg.id, result });
      const respondError = (code, message) => this.#send({ id: msg.id, error: { code, message } });
      this.onServerRequest(msg, respond, respondError);
    } else if (hasId) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpcError: msg.error }));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.onNotification(msg);
    }
  }

  #send(msg) {
    this.#log('send', msg);
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ method, id, params });
    });
  }

  notify(method, params) {
    this.#send(params === undefined ? { method } : { method, params });
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {}
  }
}
