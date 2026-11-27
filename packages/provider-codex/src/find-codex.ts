// Locate an official Codex CLI binary without touching credentials.
// Order: CODEX_BIN -> codex on PATH -> the binary bundled with the official VS Code extension.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { host } from '#host';

export function findCodex(): string {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = host.findExecutable('codex');
  if (onPath) return onPath;
  const extRoot = join(homedir(), '.vscode', 'extensions');
  if (existsSync(extRoot)) {
    for (const d of readdirSync(extRoot).filter((x) => x.startsWith('openai.chatgpt-')).sort().reverse()) {
      const p = join(extRoot, d, 'bin', host.archTag, host.executableName('codex'));
      if (existsSync(p)) return p;
    }
  }
  throw new Error('Codexのバイナリが見つかりません。`npm i -g @openai/codex` で導入するか、環境変数 CODEX_BIN を設定してください。');
}
