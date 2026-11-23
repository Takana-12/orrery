# Phase 0 PoC

本物のClaude CodeとCodexを使う検証スクリプト。結果の解説は [技術選定レポート](../docs/01-技術選定レポート.md)。

## 前提

- Windows、Node.js 24以上
- Claude Codeにログイン済み（`claude auth status`）
- Codexにログイン済み。バイナリは次の順で探す：環境変数 `CODEX_BIN` → PATH上の `codex.exe` → VS Code拡張（openai.chatgpt）の同梱バイナリ
- 依存の導入：リポジトリのルートで `npm install`

## 実行

リポジトリのルートから実行する。どれも各社のプラン枠を少量消費する（Claude側は `haiku` を明示）。

| コマンド | 内容 |
|---|---|
| `node poc/01-codex-probe.mjs codeword\|approve\|decline\|question` | Codex App Server単体：AGENTS.md読み込み、承認の許可／拒否、構造化質問 |
| `node poc/02-claude-probe.mjs codeword\|question\|approve\|deny` | Claude Agent SDK単体：CLAUDE.md読み込み、AskUserQuestion＋再開、権限の許可／拒否 |
| `node poc/03-inbox/server.mjs --demo` | 統合Inbox。`http://127.0.0.1:4777` を開く。`--demo` で3セッションを自動開始 |
| `node poc/04-e2e.mjs` | 自動受け入れテスト（15項目）。結果は `poc/logs/04-e2e-result.json` |
| `node poc/05-winjob.mjs` | Job Objectによる孤児プロセスの後始末と、実エージェントのメモリ計測 |

## 注意

- `poc/logs/*.jsonl` はプロバイダーとの生の通信ログで、アカウントのメールアドレス等を含む。`.gitignore` 済みだが、共有しないこと。
- Codexのスレッドは終了時にアーカイブしている（Codexアプリの「アーカイブ済み」に残る。復元可能）。
- Claudeのセッションは `~/.claude/projects/` に通常どおり記録される。
- このPoCは「ターン終了」までしか扱わない。完了判定・永続化・再起動時の再同期は未実装。
