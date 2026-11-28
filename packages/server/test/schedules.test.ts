// Schedules: when they run, what a run starts with, where its result goes, and that their secrets stay secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlCore, nextRunAt, settleRule } from '#core';
import type { StartSessionRequest } from '#core';
import { SqliteStore } from '../src/infrastructure/sqlite-store.ts';
import { checkHookUrl, hookBodies, hookKind, splitForLimit } from '../src/infrastructure/webhook.ts';
import type { HookMessage } from '../src/infrastructure/webhook.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { Scheduler } from '../src/application/scheduler.ts';
import { Schedules } from '../src/application/schedules.ts';
import { Secrets } from '../src/application/secrets.ts';
import { Sessions } from '../src/application/sessions.ts';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

// ---- the rule ----

test('a daily rule runs at its time on its days, the next one strictly after the moment given', () => {
  const rule = settleRule({ kind: 'daily', time: '9:05', days: [1, 3, 3, 9, 5] })!;
  assert.deepEqual(rule, { kind: 'daily', time: '09:05', days: [1, 3, 5] }, 'time padded, days once each and in range');
  // 2026-11-30 is a Monday.
  assert.equal(nextRunAt(rule, local(2026, 11, 30, 8, 0)), local(2026, 11, 30, 9, 5), 'later the same day');
  assert.equal(nextRunAt(rule, local(2026, 11, 30, 9, 5)), local(2026, 12, 2, 9, 5), 'not the same minute again: the next day it runs');
  assert.equal(nextRunAt(rule, local(2026, 12, 4, 10, 0)), local(2026, 12, 7, 9, 5), 'over the weekend to Monday');
  const every = settleRule({ kind: 'daily', time: '23:59', days: [0, 1, 2, 3, 4, 5, 6] })!;
  assert.equal(nextRunAt(every, local(2026, 12, 31, 23, 59)), local(2027, 1, 1, 23, 59), 'across the year');
});

test('an interval counts from the run, a one-off runs once, and nonsense is refused', () => {
  assert.equal(nextRunAt({ kind: 'interval', minutes: 90 }, 1_000), 1_000 + 90 * 60_000);
  assert.equal(nextRunAt({ kind: 'once', at: 5_000 }, 4_999), 5_000);
  assert.equal(nextRunAt({ kind: 'once', at: 5_000 }, 5_000), null, 'once it has run, never again');
  for (const bad of [null, {}, { kind: 'daily', time: '24:00', days: [1] }, { kind: 'daily', time: '09:00', days: [] }, { kind: 'interval', minutes: 4 }, { kind: 'interval', minutes: 8 * 24 * 60 }, { kind: 'once', at: 'x' }, { kind: 'cron' }]) {
    assert.equal(settleRule(bad), null, JSON.stringify(bad));
  }
});

// ---- webhooks ----

test('the webhook address decides the shape: Discord gets content in pieces and pings nobody, Slack gets text', () => {
  assert.equal(hookKind('https://discord.com/api/webhooks/1/abc'), 'discord');
  assert.equal(hookKind('https://ptb.discordapp.com/api/webhooks/1/abc'), 'discord');
  assert.equal(hookKind('https://hooks.slack.com/services/T/B/x'), 'slack');
  assert.equal(hookKind('https://example.com/hook'), 'generic');
  const m: HookMessage = { title: '朝のまとめ', workspace: 'Orrery', text: `@everyone ${'あ'.repeat(4000)}`, ok: true, sessionId: 's1' };
  const discord = hookBodies('discord', m) as { content: string; allowed_mentions: unknown }[];
  assert.ok(discord.length >= 3, 'a long reply goes as several messages');
  assert.ok(discord.every((b) => b.content.length <= 2000), 'each under Discord\'s limit');
  assert.ok(discord[0]!.content.startsWith('**朝のまとめ**（Orrery）'));
  assert.deepEqual(discord[0]!.allowed_mentions, { parse: [] });
  const [slack] = hookBodies('slack', { ...m, ok: false, text: 'だめでした' }) as { text: string }[];
  assert.equal(slack!.text, '失敗: *朝のまとめ*（Orrery）\nだめでした');
  const [generic] = hookBodies('generic', m) as { ok: boolean; sessionId: string; workspace: string }[];
  assert.equal(generic!.ok, true);
  assert.equal(generic!.workspace, 'Orrery');
  assert.deepEqual(splitForLimit('a\nb', 10, 3), ['a\nb']);
  assert.equal(splitForLimit('x'.repeat(50), 10, 2).length, 2, 'never more pieces than allowed');
});

test('only https addresses are kept (plain http only to this machine)', () => {
  assert.deepEqual(checkHookUrl(' https://discord.com/api/webhooks/1/abc '), { url: 'https://discord.com/api/webhooks/1/abc' });
  assert.ok('url' in checkHookUrl('http://localhost:8080/x'));
  for (const bad of ['', 'discord.com/api/webhooks/1/abc', 'http://example.com/x', 'ftp://x', 'file:///c:/x']) assert.ok('error' in checkHookUrl(bad), bad);
});

// ---- schedules in the app ----

function setup(opts: { now?: number } = {}) {
  const store = new SqliteStore(':memory:');
  const core = new ControlCore({ store });
  core.start();
  let now = opts.now ?? local(2026, 11, 30, 8, 0);
  const started: StartSessionRequest[] = [];
  const adapter = { isLive: () => false, startSession: async (req: StartSessionRequest) => { started.push(req); }, listModels: async () => [] };
  const rt = { core, store, closing: false, notify: () => {}, adapters: { claude: adapter, codex: adapter } } as unknown as Runtime;
  const cipher = { protect: (x: string) => `enc(${x})`, unprotect: (x: string) => x.slice(4, -1) };
  const secrets = new Secrets(rt, cipher);
  const notes: { sessionId: string; text: string }[] = [];
  const journal = { write: (sessionId: string, _role: string, text: string) => notes.push({ sessionId, text }) };
  const sessions = new Sessions(rt, {
    scheduler: new Scheduler(rt, (x) => x), attachmentsDir: 'attachments', secrets, journal,
    assistant: { queue: () => {} },
    workspaces: { reopen: async () => {}, remove: async () => {} },
    knowledge: { heard: () => {}, preferencesFor: async () => ({ text: '', domains: [], dropped: 0 }) },
  } as never);
  const posted: { url: string; m: HookMessage }[] = [];
  let refuse = false;
  const post = async (url: string, m: HookMessage) => {
    if (refuse) throw new Error('送信先が 404 を返しました');
    posted.push({ url, m });
  };
  const schedules = new Schedules(rt, { sessions, secrets, journal: journal as never, post, now: () => now });
  const project = core.addProject('Orrery', mkdtempSync(join(tmpdir(), 'orrery-sched-')));
  return {
    store, core, secrets, sessions, schedules, started, posted, notes, project, rt, cipher,
    at: (t: number) => { now = t; },
    refuse: (on: boolean) => { refuse = on; },
    base: { prompt: '昨日のコミットをまとめて', projectId: project, provider: 'claude', model: 'sonnet', effort: 'low', rule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } },
  };
}

test('a schedule is saved with its next run; its webhook and variables are kept encrypted, never in its record or on screen', () => {
  const w = setup();
  const id = w.schedules.save({ ...w.base, id: 'sched-1', hook: 'https://discord.com/api/webhooks/1/SECRETTOKEN', env: { REPORT_TOKEN: 'tok-123456', BAD: null } });
  assert.equal(id, 'sched-1', 'the screen\'s own id is kept, so what it showed at the click is the same schedule');
  const [v] = w.schedules.view();
  assert.equal(v!.nextAt, local(2026, 11, 30, 9, 0));
  assert.deepEqual(v!.hook, { kind: 'discord', host: 'discord.com' });
  assert.deepEqual(v!.env, [{ name: 'REPORT_TOKEN', length: 10 }]);
  assert.equal(v!.projectName, 'Orrery');
  const everything = JSON.stringify(w.store.readSchedules()) + JSON.stringify(w.schedules.view());
  assert.ok(!everything.includes('SECRETTOKEN') && !everything.includes('tok-123456'), 'no secret in the record or the view');
  assert.ok(w.store.readEnv().every((r) => r.cipher.startsWith('enc(')), 'kept encrypted');
  assert.equal(w.secrets.redact('posted to https://discord.com/api/webhooks/1/SECRETTOKEN'), 'posted to [env:WEBHOOK_URL]', 'redacted like any secret');

  // Changing the name keeps the time; leaving the hook out keeps it; '' removes it.
  w.at(local(2026, 11, 30, 8, 30));
  w.schedules.save({ id, name: '朝のまとめ' });
  assert.equal(w.schedules.view()[0]!.nextAt, local(2026, 11, 30, 9, 0));
  assert.equal(w.schedules.view()[0]!.prompt, w.base.prompt);
  assert.ok(w.schedules.view()[0]!.hook);
  w.schedules.save({ id, hook: '' });
  assert.equal(w.schedules.view()[0]!.hook, null);
  // Off: no next run; removing forgets its secrets too.
  w.schedules.save({ id, enabled: false });
  assert.equal(w.schedules.view()[0]!.nextAt, null);
  w.schedules.remove(id);
  assert.deepEqual(w.schedules.view(), []);
  assert.deepEqual(w.store.readEnv(), []);
  assert.deepEqual(w.store.readSchedules(), []);
});

test('a save that is wrong anywhere changes nothing', () => {
  const w = setup();
  for (const bad of [
    { ...w.base, prompt: ' ' },
    { ...w.base, projectId: 'nope' },
    { ...w.base, provider: 'gemini' },
    { ...w.base, rule: { kind: 'interval', minutes: 1 } },
    { ...w.base, rule: { kind: 'once', at: local(2026, 11, 29) } },
    { ...w.base, hook: 'http://example.com/x' },
    { ...w.base, env: { '1BAD': 'x' } },
    { ...w.base, id: 'x' },
  ] as Record<string, unknown>[]) assert.throws(() => w.schedules.save({ ...bad, hook: bad.hook ?? 'https://discord.com/api/webhooks/1/t' }), (e: { status?: number }) => e.status === 400 || e.status === 404, JSON.stringify(bad));
  assert.deepEqual(w.schedules.view(), []);
  assert.deepEqual(w.store.readEnv(), [], 'no secret was written for a refused save');
});

test('when its time comes the work starts in its workspace, with its AI and its own variables over the workspace\'s', async () => {
  const w = setup();
  w.secrets.set(w.project, 'SHARED', 'from-project');
  w.secrets.set(w.project, 'REPORT_TOKEN', 'project-value');
  const id = w.schedules.save({ ...w.base, name: '朝のまとめ', env: { REPORT_TOKEN: 'schedule-value' } });
  w.schedules.tick();
  assert.equal(w.started.length, 0, 'not before its time');
  w.at(local(2026, 11, 30, 9, 0));
  w.schedules.tick();
  await settle();
  assert.equal(w.started.length, 1);
  const req = w.started[0]!;
  assert.equal(req.model, 'sonnet');
  assert.equal(req.effort, 'low');
  assert.equal(req.cwd, w.core.state.projects.get(w.project)!.rootPath, 'the workspace chosen');
  assert.deepEqual(req.env, { SHARED: 'from-project', REPORT_TOKEN: 'schedule-value' });
  const v = w.schedules.view()[0]!;
  const s = w.core.state.sessions.get(v.runs[0]!.sessionId!)!;
  assert.equal(s.scheduleId, id, 'the work knows the schedule that started it');
  assert.equal(w.core.state.tasks.get(s.taskId)!.title, '朝のまとめ');
  assert.equal(v.nextAt, local(2026, 12, 1, 9, 0), 'the next weekday');
  assert.ok(w.notes.some((n) => n.sessionId === s.id && n.text.includes('スケジュール「朝のまとめ」')), 'its record says where it came from');
});

test('a run does not start while the previous one is still working; a one-off turns itself off; a missed time runs once', async () => {
  const w = setup();
  w.schedules.save({ ...w.base, id: 'every-5', rule: { kind: 'interval', minutes: 5 } });
  w.at(local(2026, 11, 30, 8, 5));
  w.schedules.tick();
  await settle();
  w.at(local(2026, 11, 30, 8, 10));
  w.schedules.tick();
  await settle();
  const runs = w.schedules.view().find((x) => x.id === 'every-5')!.runs;
  assert.deepEqual(runs.map((r) => r.outcome), ['skipped', 'started'], 'the first is still working: the second is skipped');
  assert.equal(w.started.length, 1);

  w.schedules.save({ ...w.base, id: 'once-1', rule: { kind: 'once', at: local(2026, 11, 30, 12, 0) } });
  w.at(local(2026, 12, 3, 7, 0)); // the app was off for days
  w.schedules.tick();
  w.schedules.tick();
  await settle();
  const once = w.schedules.view().find((x) => x.id === 'once-1')!;
  assert.equal(once.runs.length, 1, 'once, not once per missed time');
  assert.equal(once.enabled, false);
  assert.equal(once.nextAt, null);
});

test('when the reply ends its result goes to the webhook; a failure goes too, and a refused send is recorded on the work', async () => {
  const w = setup();
  const id = w.schedules.save({ ...w.base, name: '朝のまとめ', hook: 'https://discord.com/api/webhooks/1/t', tidy: false });
  const sid = await w.schedules.runNow(id);
  w.core.sessionUpdate(sid, { lifecycle: 'running' });
  w.schedules.onChange();
  assert.equal(w.posted.length, 0, 'not while it works');
  w.core.sessionUpdate(sid, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: '3件のコミットがありました' });
  w.schedules.onChange();
  w.schedules.onChange();
  await settle();
  assert.equal(w.posted.length, 1, 'once');
  assert.deepEqual({ ...w.posted[0]!.m, sessionId: null }, { title: '朝のまとめ', workspace: 'Orrery', text: '3件のコミットがありました', ok: true, sessionId: null });
  assert.equal(w.schedules.view()[0]!.runs[0]!.delivery.phase, 'sent');

  w.refuse(true);
  const sid2 = await w.schedules.runNow(id);
  w.core.sessionUpdate(sid2, { lifecycle: 'error', error: 'ログインが切れています' });
  w.schedules.onChange();
  await settle();
  const run = w.schedules.view()[0]!.runs[0]!;
  assert.equal(run.delivery.phase, 'failed');
  assert.match(run.delivery.error!, /404/);
  assert.ok(w.notes.some((n) => n.sessionId === sid2 && n.text.includes('Webhook に送れませんでした')));
});

test('a test message goes to the address being typed, or to the saved one', async () => {
  const w = setup();
  await w.schedules.testHook({ url: 'https://hooks.slack.com/services/a' });
  assert.equal(w.posted[0]!.url, 'https://hooks.slack.com/services/a');
  const id = w.schedules.save({ ...w.base, hook: 'https://discord.com/api/webhooks/1/t' });
  await w.schedules.testHook({ id });
  assert.equal(w.posted[1]!.url, 'https://discord.com/api/webhooks/1/t');
  await assert.rejects(w.schedules.testHook({ url: 'http://example.com' }), (e: { status?: number }) => e.status === 400);
  w.refuse(true);
  await assert.rejects(w.schedules.testHook({ id }), (e: { status?: number; message: string }) => e.status === 502 && /404/.test(e.message));
});

test('"済んだら片付ける" puts a run away only once its reply was read, its result sent, and nothing is left for the human', async () => {
  const w = setup();
  const id = w.schedules.save({ ...w.base, hook: 'https://discord.com/api/webhooks/1/t' });
  const sid = await w.schedules.runNow(id);
  w.core.sessionUpdate(sid, { lifecycle: 'turn_finished', lastTurnOutcome: 'completed', lastText: 'done' });
  w.schedules.onChange();
  await settle();
  assert.equal(w.core.state.sessions.get(sid)!.archived, false, 'not before its reply was read for what it asks');
  const s = w.core.state.sessions.get(sid)!;
  w.core.setHumanSteps(sid, [{ title: 'PR をマージする', detail: null, command: null }]);
  w.core.replyRead(sid, s.lifecycleSince);
  w.schedules.onChange();
  await settle();
  assert.equal(w.core.state.sessions.get(sid)!.archived, false, 'a step is left for the human: it stays');
  w.core.setHumanStepDone(sid, 0, true);
  w.schedules.onChange();
  await settle();
  assert.equal(w.core.state.sessions.get(sid)!.archived, true, 'nothing left: put away');
  assert.ok(w.core.state.tasks.get(w.core.state.sessions.get(sid)!.taskId)!.acceptedAt);
});

test('a schedule outlives a restart, with its webhook and variables', async () => {
  const w = setup();
  const id = w.schedules.save({ ...w.base, hook: 'https://discord.com/api/webhooks/1/t', env: { A_B: 'value-1' } });
  const again = new Schedules(w.rt, { sessions: w.sessions, secrets: new Secrets(w.rt, w.cipher), journal: { write: () => {} } as never, post: async () => {}, now: () => local(2026, 11, 30, 8, 0) });
  const v = again.view()[0]!;
  assert.equal(v.id, id);
  assert.deepEqual(v.env, [{ name: 'A_B', length: 7 }]);
  assert.equal(v.hook!.kind, 'discord');
});
