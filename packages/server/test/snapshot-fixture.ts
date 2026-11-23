// Backend regression fixture: drives the application through its public commands with invented work (no agent is
// started) and prints what the UI would be sent, with ids and times normalised. Run it before and after a refactor and
// compare the two outputs: they must be identical.
//   node packages/server/test/snapshot-fixture.ts > out.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';

const home = mkdtempSync(join(tmpdir(), 'orrery-fixture-'));
const app = new App({ dbPath: join(home, 'db.sqlite') });
const log: unknown[] = [];
const attempt = async (name: string, f: () => unknown): Promise<void> => {
  try {
    log.push({ name, result: (await f()) ?? null });
  } catch (e) {
    log.push({ name, error: (e as Error).message, status: (e as { status?: number }).status ?? null });
  }
};
const until = async (pred: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
};

const projectId = app.addProject(home, 'fixture');
await attempt('project again', () => app.addProject(home) === projectId);
await attempt('bad project', () => app.addProject(join(home, 'nope')));
await attempt('settings', () => app.setSettings({ maxConcurrent: 3, minFreeMemoryMB: 0 }));
await attempt('env set', () => app.setEnv(projectId, 'API_KEY', 'super-secret-value'));
await attempt('env bad', () => app.setEnv(projectId, '1bad', 'x'));
await attempt('env list', () => app.listEnv(projectId).map((v) => ({ name: v.name, length: v.length })));
await attempt('env reveal', () => app.revealEnv(projectId, 'API_KEY'));

const make = (title: string, extra: Record<string, unknown> = {}) => app.core.createSession({ projectId, provider: 'claude', title, ...extra }).id;
const sink = app.core;

// a: waiting on an approval and a question
const a = make('承認待ち');
sink.sessionUpdate(a, { lifecycle: 'running', process: 'alive', providerSessionId: 'ps-a', model: 'opus' });
const answered: unknown[] = [];
const i1 = sink.attentionOpen({ sessionId: a, requestId: 'r1', type: 'permission_approval', summary: 'Bash の実行承認', approval: { tool: 'Bash', subject: 'echo super-secret-value', cwd: home, reason: null, decisions: ['accept', 'decline'] }, reply: (x) => answered.push(x) });
const i2 = sink.attentionOpen({ sessionId: a, requestId: 'r2', type: 'user_question', summary: 'どちら', questions: [{ id: 'q', header: null, text: 'どちら', multiSelect: false, allowFreeText: false, isSecret: false, options: [{ label: 'A', description: null }, { label: 'B', description: null }] }], reply: (x) => answered.push(x) });
await attempt('answer invalid', () => app.answer(i2, { kind: 'answers', answers: { q: ['C'] } }));
await attempt('answer ok', () => app.answer(i1, { kind: 'decision', decision: 'accept' }));
await attempt('answer twice', () => app.answer(i1, { kind: 'decision', decision: 'accept' }));
sink.attentionAcknowledged(a, 'r1', 'tool_result');
await attempt('message while busy', () => app.sendMessage(a, 'あとでこれも'));
await attempt('archive while busy', () => app.setArchived(a, true));
await attempt('accept while busy', () => app.setAccepted(a, true));

// b: finished, checked by a command that passes
const b = make('検証つき', { checkCommand: 'node -e "process.exit(0)"', autoFix: true });
sink.sessionUpdate(b, { lifecycle: 'running', process: 'alive', providerSessionId: 'ps-b' });
sink.sessionUpdate(b, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: '実装しました。' });
await until(() => !!app.core.state.tasks.get(app.core.state.sessions.get(b)!.taskId)?.validation);

// c: finished with steps for the human
const c = make('人間の作業あり');
sink.sessionUpdate(c, { lifecycle: 'running', providerSessionId: 'ps-c' });
sink.sessionUpdate(c, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: '終わりました。' });
app.core.setHumanSteps(c, [{ title: 'マージする', detail: null, command: null }, { title: '反映する', detail: '1分', command: 'npm run x' }]);
await attempt('step', () => app.setStepDone(c, 0, true));
await attempt('run unknown command', () => app.runForHuman(c, 'rm -rf /'));

// d: finished, then accepted (put away)
const d = make('完了にする');
sink.sessionUpdate(d, { lifecycle: 'running', providerSessionId: 'ps-d' });
sink.sessionUpdate(d, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: '済み。' });
await attempt('seen', () => app.markSeen(d));
await attempt('rename', () => app.rename(d, '  完了にした   作業 '));
await attempt('rename empty', () => app.rename(d, ' '));
await attempt('accept', () => app.setAccepted(d, true));

// e: failed; f: queued behind the limit; g: interrupted
const e = make('失敗');
sink.sessionUpdate(e, { lifecycle: 'running', process: 'alive' });
sink.sessionUpdate(e, { lifecycle: 'error', error: 'boom super-secret-value', process: 'crashed' });
const g = make('中断');
sink.sessionUpdate(g, { lifecycle: 'running', providerSessionId: 'ps-g' });
sink.sessionUpdate(g, { lifecycle: 'interrupted', lastTurnOutcome: 'interrupted' });
await attempt('stop unknown', () => app.stop('nope'));
await attempt('cleanup none', () => app.cleanup(g));
await attempt('unsend', () => app.cancelDeferred(a));
await attempt('message empty', () => app.sendMessage(g, ' '));
await attempt('storage', () => { const s = app.storage(); return { ...s, bytes: 0 }; });
await attempt('capabilities', () => app.capabilities());
await new Promise((r) => setTimeout(r, 100));

const ids = new Map<string, string>();
const norm = (v: unknown): unknown => {
  if (typeof v === 'string') {
    return v
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => ids.get(m) ?? ids.set(m, `id${ids.size + 1}`).get(m)!)
      .split(home).join('<home>');
  }
  if (typeof v === 'number') return v > 1e11 ? 0 : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [norm(k) as string, norm(x)]));
  return v;
};
const snap = app.snapshot() as Record<string, any>;
delete snap.auth; // depends on whether this machine is signed in
delete snap.resources;
snap.queue.freeMemoryMB = 0;
for (const s of snap.sessions) s.activity = s.activity && { ...s.activity, at: 0 };
const transcripts = Object.fromEntries([a, b, c, d, e, g].map((id) => [id, app.store.readTranscript(id).map((x) => ({ role: x.role, text: x.text }))]));
console.log(JSON.stringify(norm({ log, answered, snap, transcripts }), null, 2));
await app.shutdown();
rmSync(home, { recursive: true, force: true });
process.exit(0);
