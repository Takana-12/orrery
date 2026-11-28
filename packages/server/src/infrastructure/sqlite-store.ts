// SQLite persistence (Node's built-in node:sqlite, no native build).
// `events` is the source of truth; `raw_payloads` and `transcript` are drill-down data that is never needed
// to rebuild state. Nothing here is sent anywhere: it is a local file.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CoreEvent, EventStore, StoredEvent } from '#core';

export interface TranscriptEntry {
  seq: number;
  at: number;
  role: string;
  text: string;
}

export class SqliteStore implements EventStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        session_id TEXT,
        item_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raw_payloads (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        session_id TEXT,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_session ON transcript (session_id, seq);
      -- Project environment variables. cipher is DPAPI ciphertext: the plain value is never written to disk.
      -- Tokens each finished turn consumed (as reported by the provider). Numbers only, no content.
      CREATE TABLE IF NOT EXISTS usage (
        at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
      CREATE TABLE IF NOT EXISTS project_env (
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cipher TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, name)
      );
      -- The git worktree each session works in (see worktree.ts). body is the WorktreeInfo as JSON.
      CREATE TABLE IF NOT EXISTS worktrees (
        session_id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      -- Side chats that are open (see side-chats.ts). body is the chat as JSON; its words are in transcript.
      CREATE TABLE IF NOT EXISTS side_chats (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      -- Scheduled work (see application/schedules.ts). body is the schedule as JSON, without any secret: its webhook
      -- and its environment variables are in project_env under the scope "schedule:<id>", encrypted like a project's.
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `);
  }

  saveSchedule(schedule: { id: string }): void {
    this.db.prepare('INSERT INTO schedules (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(schedule.id, JSON.stringify(schedule));
  }

  readSchedules<T>(): T[] {
    return (this.db.prepare('SELECT body FROM schedules').all() as unknown as { body: string }[]).map((r) => JSON.parse(r.body) as T);
  }

  deleteSchedule(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  saveChat(chat: { id: string }): void {
    this.db.prepare('INSERT INTO side_chats (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(chat.id, JSON.stringify(chat));
  }

  readChats<T>(): T[] {
    return (this.db.prepare('SELECT body FROM side_chats').all() as unknown as { body: string }[]).map((r) => JSON.parse(r.body) as T);
  }

  /** A closed side chat leaves nothing behind: the chat, its words and its raw payloads go. */
  deleteChat(id: string): void {
    this.db.prepare('DELETE FROM side_chats WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM transcript WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM raw_payloads WHERE session_id = ?').run(id);
  }

  append(at: number, event: CoreEvent): StoredEvent {
    const e = event as { sessionId?: string; itemId?: string };
    const r = this.db
      .prepare('INSERT INTO events (at, type, session_id, item_id, payload) VALUES (?, ?, ?, ?, ?)')
      .run(at, event.type, e.sessionId ?? null, e.itemId ?? null, JSON.stringify(event));
    return { seq: Number(r.lastInsertRowid), at, event };
  }

  readAll(): StoredEvent[] {
    const rows = this.db.prepare('SELECT seq, at, payload FROM events ORDER BY seq').all() as unknown as { seq: number; at: number; payload: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.payload) as CoreEvent }));
  }

  saveRaw(sessionId: string, body: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO raw_payloads (id, at, session_id, body) VALUES (?, ?, ?, ?)').run(id, Date.now(), sessionId, JSON.stringify(body));
    return id;
  }

  readRaw(id: string): unknown | null {
    const row = this.db.prepare('SELECT body FROM raw_payloads WHERE id = ?').get(id) as unknown as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }

  appendTranscript(sessionId: string, role: string, text: string): void {
    this.db.prepare('INSERT INTO transcript (at, session_id, role, text) VALUES (?, ?, ?, ?)').run(Date.now(), sessionId, role, text);
  }

  /** Paged, oldest first. The UI never loads an unbounded log into memory. */
  readTranscript(sessionId: string, limit = 200, range: { before?: number; after?: number } = {}): TranscriptEntry[] {
    if (range.after !== undefined) {
      // New entries since the client's last one (incremental refresh).
      return this.db.prepare('SELECT seq, at, role, text FROM transcript WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(sessionId, range.after, limit) as unknown as TranscriptEntry[];
    }
    const rows = (
      range.before !== undefined
        ? this.db.prepare('SELECT seq, at, role, text FROM transcript WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(sessionId, range.before, limit)
        : this.db.prepare('SELECT seq, at, role, text FROM transcript WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(sessionId, limit)
    ) as unknown as TranscriptEntry[];
    return rows.reverse();
  }

  /**
   * What the agent wrote since the human last spoke in this session, oldest first (the end of it, if it is long).
   * A turn's request to the human is not always in its very last message.
   */
  /** What the human said last to the agent (the request the current turn answers), cut to `maxChars`. */
  lastRequest(sessionId: string, maxChars = 2000): string {
    const row = this.db.prepare("SELECT text FROM transcript WHERE session_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1").get(sessionId) as unknown as { text: string } | undefined;
    return (row?.text ?? '').slice(0, maxChars);
  }

  turnReplies(sessionId: string, maxChars = 8000): string {
    const last = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript WHERE session_id = ? AND role = 'user'").get(sessionId) as unknown as { seq: number };
    const rows = this.db.prepare("SELECT text FROM transcript WHERE session_id = ? AND role = 'assistant' AND seq > ? ORDER BY seq DESC LIMIT 40").all(sessionId, last.seq) as unknown as { text: string }[];
    return rows
      .reverse()
      .map((r) => r.text)
      .join('\n\n')
      .slice(-maxChars);
  }

  addUsage(sessionId: string, provider: string, u: { inputTokens: number; outputTokens: number; cachedInputTokens: number }): void {
    this.db.prepare('INSERT INTO usage (at, session_id, provider, input_tokens, output_tokens, cached_tokens) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), sessionId, provider, u.inputTokens, u.outputTokens, u.cachedInputTokens);
  }

  /** Token totals per provider since `since` (epoch ms). */
  usageSince(since: number): Record<string, { input: number; output: number; cached: number; turns: number }> {
    const rows = this.db
      .prepare('SELECT provider, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached, COUNT(*) AS turns FROM usage WHERE at >= ? GROUP BY provider')
      .all(since) as unknown as { provider: string; input: number; output: number; cached: number; turns: number }[];
    return Object.fromEntries(rows.map((r) => [r.provider, { input: r.input, output: r.output, cached: r.cached, turns: r.turns }]));
  }

  usageBySession(sessionId: string): { input: number; output: number; cached: number } {
    const r = this.db.prepare('SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cached_tokens),0) AS cached FROM usage WHERE session_id = ?').get(sessionId) as unknown as { input: number; output: number; cached: number };
    return r;
  }

  /** True if `needle` appears in something the agent wrote in this session (used to refuse commands it never proposed). */
  agentWrote(sessionId: string, needle: string): boolean {
    const r = this.db.prepare("SELECT 1 AS x FROM transcript WHERE session_id = ? AND role = 'assistant' AND instr(text, ?) > 0 LIMIT 1").get(sessionId, needle);
    return !!r;
  }

  stats(): { bytes: number; events: number; transcriptEntries: number; rawPayloads: number } {
    const one = (sql: string): number => Number(Object.values(this.db.prepare(sql).get() as Record<string, unknown>)[0] ?? 0);
    return {
      bytes: one('PRAGMA page_count') * one('PRAGMA page_size'),
      events: one('SELECT COUNT(*) FROM events'),
      transcriptEntries: one('SELECT COUNT(*) FROM transcript'),
      rawPayloads: one('SELECT COUNT(*) FROM raw_payloads'),
    };
  }

  /** Delete the conversation records and raw provider payloads of the given sessions, then give the space back. */
  purgeLogs(sessionIds: string[]): void {
    const delT = this.db.prepare('DELETE FROM transcript WHERE session_id = ?');
    const delR = this.db.prepare('DELETE FROM raw_payloads WHERE session_id = ?');
    for (const id of sessionIds) {
      delT.run(id);
      delR.run(id);
    }
    this.db.exec('VACUUM');
  }

  readEnv(): { projectId: string; name: string; cipher: string; updatedAt: number }[] {
    return this.db.prepare('SELECT project_id AS projectId, name, cipher, updated_at AS updatedAt FROM project_env ORDER BY project_id, name').all() as unknown as {
      projectId: string;
      name: string;
      cipher: string;
      updatedAt: number;
    }[];
  }

  writeEnv(projectId: string, name: string, cipher: string): void {
    this.db
      .prepare('INSERT INTO project_env (project_id, name, cipher, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET cipher = excluded.cipher, updated_at = excluded.updated_at')
      .run(projectId, name, cipher, Date.now());
  }

  deleteEnv(projectId: string, name: string): void {
    this.db.prepare('DELETE FROM project_env WHERE project_id = ? AND name = ?').run(projectId, name);
  }

  /** Every value kept under one owner (a project id, or a scope such as "schedule:<id>"). */
  deleteEnvOf(projectId: string): void {
    this.db.prepare('DELETE FROM project_env WHERE project_id = ?').run(projectId);
  }

  saveWorktree(info: { sessionId: string }): void {
    this.db.prepare('INSERT INTO worktrees (session_id, body) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET body = excluded.body').run(info.sessionId, JSON.stringify(info));
  }

  readWorktrees<T>(): T[] {
    return (this.db.prepare('SELECT body FROM worktrees').all() as unknown as { body: string }[]).map((r) => JSON.parse(r.body) as T);
  }

  close(): void {
    this.db.close();
  }
}
