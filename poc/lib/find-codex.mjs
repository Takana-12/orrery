// Locate an official Codex CLI binary without touching any credentials.
// Order: CODEX_BIN env -> `codex` on PATH -> the binary bundled with the official VS Code extension.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export function findCodex() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;

  try {
    const out = execFileSync('where.exe', ['codex.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  } catch {}

  const extRoot = join(homedir(), '.vscode', 'extensions');
  if (existsSync(extRoot)) {
    const dirs = readdirSync(extRoot)
      .filter((d) => d.startsWith('openai.chatgpt-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const p = join(extRoot, d, 'bin', 'windows-x86_64', 'codex.exe');
      if (existsSync(p)) return p;
    }
  }
  throw new Error('Codex binary not found. Install with `npm i -g @openai/codex` or set CODEX_BIN.');
}
