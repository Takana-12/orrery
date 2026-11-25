import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore } from '#core';
import type { ProviderId, StartSessionRequest, UsageLimit } from '#core';
import { SqliteStore } from '../src/infrastructure/sqlite-store.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { Journal } from '../src/application/journal.ts';
import { Scheduler } from '../src/application/scheduler.ts';
import { Sessions } from '../src/application/sessions.ts';
import { Accounts } from '../src/application/accounts.ts';
import { UsageResumer, USAGE_RESUME_MESSAGE } from '../src/application/usage-resume.ts';

const NOW = 1_800_000_000_000;
const RESET = NOW + 5 * 60 * 60_000;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const limit = (resetsAt: number | null = RESET, extra: Partial<UsageLimit> = {}): UsageLimit => ({ label: '5時間枠', kind: 'five_hour', usedPercent: 100, state: 'reached', resetsAt, ...extra });

function setup(store = new SqliteStore(':memory:')) {
  let time = NOW;
  const core = new ControlCore({ store, now: () => time });
  core.start();
  const sent: { id: string; text: string }[] = [];
  const started: StartSessionRequest[] = [];
  const live = new Set<string>();
  const reopened: string[] = [];
  let limits: UsageLimit[] = [];
  const fake = () => ({
    isLive: (id: string) => live.has(id),
    sendMessage: async (id: string, text: string) => { sent.push({ id, text }); core.sessionUpdate(id, { lifecycle: 'running' }); },
    startSession: async (req: StartSessionRequest) => { started.push(req); live.add(req.sessionId); core.sessionUpdate(req.sessionId, { lifecycle: 'running', process: 'alive' }); },
    limits: async () => limits,
    interrupt: async () => assert.fail('an already stopped turn needs no provider interrupt'),
    stop: async () => {},
  });
  const rt = { core, store, closing: false, notify: () => {}, adapters: { claude: fake(), codex: fake() } } as unknown as Runtime;
  const journal = new Journal(rt, (s) => s);
  const scheduler = new Scheduler(rt, (s) => s);
  const sessions = new Sessions(rt, {
    scheduler, journal,
    secrets: { envFor: () => ({ DEMO: 'ok' }), redact: (s: string) => s },
    workspaces: { reopen: async (id: string) => { reopened.push(id); } },
    knowledge: { heard: () => assert.fail('automatic prompts are not human preferences') },
    attachmentsDir: 'C:\\attachments',
  } as never);
  const accounts = new Accounts(rt, undefined, (p, limits) => resumer.observe(p, limits));
  const resumer = new UsageResumer(rt, sessions, journal, (p) => accounts.refreshLimits(p), () => time);
  const projectId = core.addProject('p', 'C:\\work');
  const session = (provider: ProviderId = 'codex', model = 'gpt-test', lifecycle = 'running') => {
    const s = core.createSession({ projectId, provider, title: 'work', model, effort: 'high', approvalMode: 'auto' });
    core.sessionUpdate(s.id, { providerSessionId: `conversation:${s.id}`, model, lifecycle: lifecycle as never, process: 'alive' });
    live.add(s.id);
    return s;
  };
  const fail = (id: string) => core.sessionUpdate(id, { lifecycle: 'error', lastTurnOutcome: 'failed', error: 'usage limit' });
  const due = () => { time = RESET + 60_000; resumer.tick(); };
  return { core, store, rt, sessions, accounts, resumer, scheduler, sent, started, live, reopened, session, fail, due, setTime: (v: number) => { time = v; }, setLimits: (v: UsageLimit[]) => { limits = v; } };
}

test('only work running at the limit is reserved; reset + one minute sends the exact prompt once', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  const a = w.session();
  const b = w.session();
  const finished = w.session('codex', 'gpt-test', 'turn_finished');
  const queued = w.session('codex', 'gpt-test', 'queued');
  const asked = w.session('codex', 'gpt-test', 'waiting_for_user');
  const claude = w.session('claude', 'sonnet');
  w.resumer.observe('codex', [limit()]);
  assert.equal(a.usageResume?.resetsAt, RESET);
  assert.equal(b.usageResume?.resetsAt, RESET);
  for (const s of [finished, queued, asked, claude]) assert.equal(s.usageResume, null);
  w.fail(a.id); w.fail(b.id);
  w.setTime(RESET + 59_999); w.resumer.tick();
  assert.equal(w.sent.length, 0);
  w.due(); w.resumer.tick(); await flush();
  assert.deepEqual(w.sent, [a, b].map((s) => ({ id: s.id, text: USAGE_RESUME_MESSAGE })));
  assert.equal(a.usageResume, null);
  assert.match(w.store.readTranscript(a.id, 100).map((e) => e.text).join('\n'), /自動再開を予約/);
});

test('model windows affect only the matching model, while a shared window affects all models', (t) => {
  const w = setup(); t.after(() => w.store.close());
  const opus = w.session('claude', 'claude-opus-5-5');
  const sonnet = w.session('claude', 'sonnet');
  const codex = w.session('codex', 'gpt-test');
  const other = w.session('codex', 'gpt-other');
  w.resumer.observe('claude', [limit(RESET, { model: 'opus', label: '週間枠（Opus）', kind: 'other' })]);
  w.resumer.observe('codex', [limit(RESET, { model: 'gpt-test' })]);
  assert.ok(opus.usageResume); assert.ok(codex.usageResume);
  assert.equal(sonnet.usageResume, null); assert.equal(other.usageResume, null);
  w.resumer.observe('claude', [limit()]);
  assert.ok(sonnet.usageResume);
});

test('all exhausted windows must recover, including a later reset learned after the turn stops', (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session();
  w.resumer.observe('codex', [limit(), limit(RESET + 86_400_000, { kind: 'weekly', label: '週間枠' })]);
  assert.equal(s.usageResume?.resetsAt, RESET + 86_400_000);
  w.fail(s.id); w.due();
  assert.equal(w.sent.length, 0);
  w.resumer.observe('codex', [limit(RESET + 2 * 86_400_000, { kind: 'weekly', label: '週間枠' })]);
  assert.equal(s.usageResume?.resetsAt, RESET + 2 * 86_400_000);
  w.setTime(RESET + 2 * 86_400_000 + 60_000); w.resumer.tick();
  assert.equal(w.sent.length, 1);
});

test('explicit rejection keeps its target while the reset fetch completes after the terminal event', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session('claude', 'sonnet');
  w.setLimits([limit()]);
  w.resumer.blocked(s.id);
  assert.deepEqual(s.usageResume, { model: 'sonnet', resetsAt: null });
  w.fail(s.id);
  await flush();
  assert.equal(s.usageResume?.resetsAt, RESET);
  w.due();
  assert.equal(w.sent.length, 1);
});

test('reservations and limit windows survive a restart; a dead process resumes the same conversation and options', async (t) => {
  const first = setup(); t.after(() => first.store.close());
  const s = first.session('claude', 'sonnet');
  first.resumer.observe('claude', [limit()]);
  first.fail(s.id);
  const w = setup(first.store);
  const restored = w.core.state.sessions.get(s.id)!;
  assert.equal(restored.usageResume?.resetsAt, RESET);
  assert.equal(w.core.state.usageLimits.get('claude')?.[0].resetsAt, RESET);
  w.due(); await flush();
  assert.equal(w.started.length, 1);
  assert.deepEqual(w.reopened, [s.id]);
  const req = w.started[0];
  assert.equal(req.resumeProviderSessionId, s.providerSessionId);
  assert.equal(req.model, 'sonnet'); assert.equal(req.effort, 'high'); assert.equal(req.approvalMode, 'auto');
  assert.equal(req.prompt, USAGE_RESUME_MESSAGE);
  assert.deepEqual(req.env, { DEMO: 'ok' });
  w.resumer.tick(); await flush(); assert.equal(w.started.length, 1);
  const again = new ControlCore({ store: first.store });
  assert.equal(again.state.sessions.get(s.id)!.usageResume, null);
});

test('normal completion cancels a reservation; active work and human questions never receive an automatic prompt', (t) => {
  const w = setup(); t.after(() => w.store.close());
  const done = w.session(); const active = w.session(); const asked = w.session();
  w.resumer.observe('codex', [limit()]);
  w.core.sessionUpdate(done.id, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed' });
  w.core.sessionUpdate(asked.id, { lifecycle: 'waiting_for_user' });
  assert.equal(done.usageResume, null);
  w.due();
  assert.equal(w.sent.length, 0);
  assert.equal(active.lifecycle, 'running'); assert.equal(asked.lifecycle, 'waiting_for_user');
});

test('turning the feature off clears reservations persistently and turning it on does not revive them', (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session();
  assert.equal(w.core.state.settings.autoResumeOnLimit, true);
  w.resumer.observe('codex', [limit()]); w.fail(s.id);
  w.sessions.setSettings({ autoResumeOnLimit: false });
  assert.equal(s.usageResume, null);
  const restored = new ControlCore({ store: w.store });
  assert.equal(restored.state.settings.autoResumeOnLimit, false);
  assert.equal(restored.state.sessions.get(s.id)!.usageResume, null);
  w.sessions.setSettings({ autoResumeOnLimit: true }); w.due();
  assert.equal(w.sent.length, 0);
});

test('manual interrupt, stop, message, archive and acceptance cancel automatic resumption', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  const jobs = Array.from({ length: 5 }, () => w.session());
  w.resumer.observe('codex', [limit()]); jobs.forEach((s) => w.fail(s.id));
  await w.sessions.interrupt(jobs[0].id);
  await w.sessions.stop(jobs[1].id);
  await w.sessions.send(jobs[2].id, '手動の続き', { heard: true });
  w.core.setArchived(jobs[3].id, true);
  w.core.setAccepted(jobs[4].id, true);
  assert.ok(jobs.every((s) => !s.usageResume));
  w.due(); await flush();
  assert.deepEqual(w.sent, [{ id: jobs[2].id, text: '手動の続き' }]);
});

test('unknown or invalid reset times are never guessed; a later valid notification completes the reservation', (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session();
  w.resumer.observe('codex', [limit(NaN)]);
  assert.equal(s.usageResume?.resetsAt, null);
  w.fail(s.id); w.due();
  assert.equal(w.sent.length, 0);
  w.resumer.observe('codex', [limit(RESET + 100_000)]);
  w.setTime(RESET + 160_000); w.resumer.tick();
  assert.equal(w.sent.length, 1);
});

test('resumption respects the ordinary concurrency queue, and a queued automatic message can be cancelled', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  w.core.setSettings({ maxConcurrent: 1 });
  const s = w.session();
  w.resumer.observe('codex', [limit()]); w.fail(s.id);
  w.session('claude', 'sonnet'); // occupies the one allowed slot
  w.due(); w.resumer.tick();
  assert.equal(s.lifecycle, 'queued'); assert.equal(w.scheduler.length, 1); assert.equal(w.sent.length, 0);
  await w.sessions.interrupt(s.id);
  assert.equal(w.scheduler.length, 0);
  w.resumer.tick(); assert.equal(w.sent.length, 0);
});

test('turning the feature off also removes an automatic message already waiting for a slot', (t) => {
  const w = setup(); t.after(() => w.store.close());
  w.core.setSettings({ maxConcurrent: 1 });
  const s = w.session(); w.resumer.observe('codex', [limit()]); w.fail(s.id);
  const busy = w.session('claude', 'sonnet');
  w.due(); assert.equal(w.scheduler.length, 1);
  w.sessions.setSettings({ autoResumeOnLimit: false });
  assert.equal(w.scheduler.length, 0); assert.equal(s.usageResume, null);
  w.core.sessionUpdate(busy.id, { lifecycle: 'turn_finished' }); w.scheduler.pump();
  assert.equal(w.sent.length, 0);
});

test('a queued automatic message survives restart and manual messages replace it instead of being deferred', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  w.core.setSettings({ maxConcurrent: 1 });
  const s = w.session(); w.resumer.observe('codex', [limit()]); w.fail(s.id);
  w.session('claude', 'sonnet'); w.due();
  assert.equal(w.scheduler.length, 1); assert.ok(s.usageResume);
  const restarted = setup(w.store); restarted.due(); await flush();
  assert.equal(restarted.started[0].resumeProviderSessionId, s.providerSessionId);
  // The original in-memory queue is used only to exercise replacement of an automatic instruction.
  const r = await w.sessions.send(s.id, '今はこちらを優先', { heard: true });
  assert.equal(r.deferred, undefined);
  assert.equal(w.scheduler.length, 1);
  assert.equal(s.usageResume, null);
  assert.equal(w.sessions.hasDeferred(s.id), false);
});

test('cancelling while the provider is still running suppresses later polls and rejections of that turn', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session(); w.resumer.observe('codex', [limit()]);
  w.rt.adapters.codex.interrupt = async () => {};
  await w.sessions.interrupt(s.id);
  w.resumer.observe('codex', [limit()]); w.resumer.blocked(s.id); w.fail(s.id);
  w.due(); assert.equal(w.sent.length, 0); assert.equal(s.usageResume, null);
  await w.sessions.send(s.id, '新しい指示', { heard: true });
  w.setTime(NOW); w.resumer.observe('codex', [limit()]);
  assert.ok(s.usageResume, 'the cancellation only applies to the old turn');
});

test('a fresh rejection after an automatic attempt records a new reset instead of looping on the old one', async (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session();
  w.resumer.observe('codex', [limit()]); w.fail(s.id); w.due();
  w.setLimits([limit(RESET + 300_000)]);
  w.resumer.blocked(s.id); w.fail(s.id); await flush();
  assert.equal(s.usageResume?.resetsAt, RESET + 300_000);
  w.resumer.tick(); assert.equal(w.sent.length, 1);
  w.setTime(RESET + 360_000); w.resumer.tick();
  assert.equal(w.sent.length, 2);
});

test('a limit warning rounded to 100%, a different model and shutdown never trigger resumption', (t) => {
  const w = setup(); t.after(() => w.store.close());
  const s = w.session();
  w.resumer.observe('codex', [limit(RESET, { state: 'warning' })]); assert.equal(s.usageResume, null);
  w.resumer.observe('codex', [limit()]); w.fail(s.id);
  w.core.sessionUpdate(s.id, { model: 'new-model' }); w.due();
  assert.equal(w.sent.length, 0); assert.equal(s.usageResume, null);
  const b = w.session(); w.setTime(NOW); w.resumer.observe('codex', [limit()]); w.fail(b.id);
  w.rt.closing = true; w.due(); assert.equal(w.sent.length, 0);
});

test('background polling detects limits without opening a usage screen', async (t) => {
  const w = setup(); t.after(() => { w.accounts.stop(); w.store.close(); });
  w.session(); w.setLimits([limit()]);
  // The watch loop runs every three seconds; advance the interval without waiting for real time or using an AI.
  t.mock.timers.enable({ apis: ['setInterval'] });
  w.accounts.watch(); t.mock.timers.tick(3000); await flush();
  assert.equal(w.core.state.usageLimits.get('codex')?.[0].resetsAt, RESET);
  assert.ok([...w.core.state.sessions.values()][0].usageResume);
});
