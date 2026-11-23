// Project environment variables: values the human set for a project's agents and check commands.
// Stored encrypted (DPAPI, per Windows user); the plain values live in memory only, and every text that is logged,
// stored or shown passes through redact() so a value never appears anywhere but in the agent's own environment.
import { HttpError } from './errors.ts';
import { mustProject } from './runtime.ts';
import type { Runtime } from './runtime.ts';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
        console.error(`[control-room] 環境変数 ${row.name} を復号できませんでした（別のWindowsユーザーで保存された可能性）。無視します。`);
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
    if (!ENV_NAME.test(name ?? '')) throw new HttpError(400, '変数名は英数字とアンダースコアで、数字以外から始めてください');
    if (typeof value !== 'string' || value.length > 32_768) throw new HttpError(400, '値が長すぎます');
    this.rt.store.writeEnv(projectId, name, this.cipher.protect(value));
    const m = this.env.get(projectId) ?? new Map<string, string>();
    m.set(name, value);
    this.env.set(projectId, m);
    this.rt.notify();
  }

  delete(projectId: string, name: string): void {
    mustProject(this.rt, projectId);
    this.rt.store.deleteEnv(projectId, name);
    this.env.get(projectId)?.delete(name);
    this.rt.notify();
  }

  /** Showing a value is an explicit, per-variable act by the human. */
  reveal(projectId: string, name: string): string {
    mustProject(this.rt, projectId);
    const v = this.env.get(projectId)?.get(name);
    if (v === undefined) throw new HttpError(404, '該当する変数がありません');
    return v;
  }
}
