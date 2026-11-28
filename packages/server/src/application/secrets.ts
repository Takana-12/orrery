// Project environment variables: values the human set for a project's agents and check commands. The same store keeps
// values that belong to something other than a project (a schedule's webhook and its own variables), under a scope
// such as "schedule:<id>": same encryption, same redaction, never sent to the screen unless revealed one by one.
// Stored encrypted for this user of this machine (#host: DPAPI on Windows, a keychain-held key on macOS); the plain values live in memory only, and every text that is logged,
// stored or shown passes through redact() so a value never appears anywhere but in the agent's own environment.
import { HttpError } from './errors.ts';
import { mustProject } from './runtime.ts';
import type { Runtime } from './runtime.ts';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where a schedule's own environment variables are kept. */
export const scheduleEnvScope = (scheduleId: string) => `schedule:${scheduleId}`;
/** Where a schedule's webhook address is kept (it holds a token: it is a secret, too). */
export const scheduleHookScope = (scheduleId: string) => `schedule-hook:${scheduleId}`;

export interface Cipher {
  protect(plain: string): string;
  unprotect(cipher: string): string;
}

export class Secrets {
  /** Decrypted project env, kept in memory only: projectId -> name -> value. */
  private readonly env = new Map<string, Map<string, string>>();
  private readonly rt: Runtime;
  private readonly cipher: Cipher;

  constructor(rt: Runtime, cipher: Cipher) {
    this.rt = rt;
    this.cipher = cipher;
    for (const row of rt.store.readEnv()) {
      try {
        const m = this.env.get(row.projectId) ?? new Map<string, string>();
        m.set(row.name, cipher.unprotect(row.cipher));
        this.env.set(row.projectId, m);
      } catch {
        console.error(`[control-room] 環境変数 ${row.name} を復号できませんでした（別のユーザーまたは別のPCで保存された可能性）。無視します。`);
      }
    }
  }

  envFor(projectId: string): Record<string, string> {
    return Object.fromEntries(this.env.get(projectId) ?? []);
  }

  count(projectId: string): number {
    return this.env.get(projectId)?.size ?? 0;
  }

  /** Replace every stored secret value with its name, so values never reach the log, the DB transcript or the screen. */
  redact = (text: string): string => {
    let out = text;
    for (const vars of this.env.values()) {
      for (const [name, value] of vars) {
        if (value.length < 6) continue; // too short to redact without mangling ordinary text
        if (out.includes(value)) out = out.split(value).join(`[env:${name}]`);
      }
    }
    return out;
  };

  list(projectId: string): { name: string; length: number; updatedAt: number }[] {
    mustProject(this.rt, projectId);
    const values = this.env.get(projectId);
    return this.rt.store
      .readEnv()
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ name: r.name, length: values?.get(r.name)?.length ?? 0, updatedAt: r.updatedAt }));
  }

  set(projectId: string, name: string, value: string): void {
    mustProject(this.rt, projectId);
    Secrets.check(name, value);
    this.write(projectId, name, value);
    this.rt.notify();
  }

  delete(projectId: string, name: string): void {
    mustProject(this.rt, projectId);
    this.remove(projectId, name);
    this.rt.notify();
  }

  /** Refuse a name or value that cannot be kept, before anything is changed. */
  static check(name: string, value: unknown): void {
    if (!ENV_NAME.test(name ?? '')) throw new HttpError(400, '変数名は英数字とアンダースコアで、数字以外から始めてください');
    if (typeof value !== 'string' || value.length > 32_768) throw new HttpError(400, '値が長すぎます');
  }

  private write(owner: string, name: string, value: string): void {
    this.rt.store.writeEnv(owner, name, this.cipher.protect(value));
    const m = this.env.get(owner) ?? new Map<string, string>();
    m.set(name, value);
    this.env.set(owner, m);
  }

  private remove(owner: string, name: string): void {
    this.rt.store.deleteEnv(owner, name);
    this.env.get(owner)?.delete(name);
  }

  // ---- values under a scope other than a project (the caller has checked that its owner exists) ----

  /** Everything under a scope, plain (for the agent's environment or the webhook call only). */
  scoped(scope: string): Record<string, string> {
    return Object.fromEntries(this.env.get(scope) ?? []);
  }

  /** What the screen may know of a scope's values: names and lengths. */
  scopedNames(scope: string): { name: string; length: number }[] {
    return [...(this.env.get(scope) ?? [])].map(([name, value]) => ({ name, length: value.length })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Change values under a scope: `value` null removes. Names were checked with check(). No notification: the caller sends one. */
  setScoped(scope: string, name: string, value: string | null): void {
    if (value === null) this.remove(scope, name);
    else this.write(scope, name, value);
  }

  /** Forget a scope and every value in it. */
  dropScope(scope: string): void {
    this.rt.store.deleteEnvOf(scope);
    this.env.delete(scope);
  }

  /** The environment a piece of work runs with: its project's, then (overriding) its schedule's own. */
  envForWork(s: { projectId: string; scheduleId?: string }): Record<string, string> {
    return { ...this.envFor(s.projectId), ...(s.scheduleId ? this.scoped(scheduleEnvScope(s.scheduleId)) : {}) };
  }

  /** Showing a value is an explicit, per-variable act by the human. */
  reveal(projectId: string, name: string): string {
    mustProject(this.rt, projectId);
    const v = this.env.get(projectId)?.get(name);
    if (v === undefined) throw new HttpError(404, '該当する変数がありません');
    return v;
  }
}
