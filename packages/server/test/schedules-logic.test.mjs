// The schedules screen's logic (public/js/logic): what shows at the click, what is taken back when the server refuses,
// and the words a rule and a run are told in. No browser: the logic never touches the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../public/js/logic/store.js';
import { removeSchedule, runSchedule, saveSchedule, setScheduleEnabled } from '../public/js/logic/actions.js';
import { draftEnv, draftOf, draftProblem, hookLabelOf, nextText, ruleText, runLook, saveBody, scheduleSaveEffect } from '../public/js/logic/schedules.js';
import { nextRunAt } from '../public/js/logic/schedule-rule.js';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const saved = (o = {}) => ({ id: 'sc-1', name: '朝のまとめ', prompt: 'まとめて', projectId: 'p1', projectName: 'Orrery', provider: 'claude', model: 'sonnet', effort: 'low', rule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, enabled: true, tidy: true, createdAt: 1, updatedAt: 1, nextAt: local(2030, 1, 1, 9), runs: [], hook: null, env: [{ name: 'TOKEN', length: 8 }], busy: false, ...o });
const snapshot = (schedules = []) => ({ sessions: [], items: [], counts: {}, projects: [{ id: 'p1', name: 'Orrery', rootPath: 'C:/o' }, { id: 'p2', name: 'Site', rootPath: 'C:/s' }], settings: { maxConcurrent: 3 }, auth: {}, schedules });

function server(status, body = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(status === 200 ? { ok: true, ...body } : { error: '断られました', ...body }), { status });
  };
  return calls;
}
function reset(snap) {
  store.effects = [];
  store.notices.length = 0;
  store.scheduleDrafts.clear();
  store.scheduleOpen = null;
  store.receive(snap);
}

test('a new schedule shows in the list at the click, with its next run, and its form closes', async () => {
  reset(snapshot());
  const calls = server(200, { scheduleId: 'x' });
  const d = { ...draftOf(null, { projectId: 'p2', provider: 'codex', model: 'gpt', effort: 'high' }), prompt: '毎朝のニュース', hook: 'https://discord.com/api/webhooks/1/tok', env: { KEY: 'value' } };
  store.scheduleOpen = d.id;
  store.scheduleDrafts.set(d.id, d);
  const p = saveSchedule(d);
  const sc = store.state.schedules.find((x) => x.id === d.id);
  assert.ok(sc, 'listed before the server has answered');
  assert.equal(sc.projectName, 'Site');
  assert.equal(sc.provider, 'codex');
  assert.deepEqual(sc.hook, { kind: 'discord', host: 'discord.com' }, 'the service is shown, never the address');
  assert.deepEqual(sc.env, [{ name: 'KEY', length: 5 }]);
  assert.equal(sc.nextAt, nextRunAt(sc.rule, sc.updatedAt));
  assert.equal(store.scheduleOpen, null, 'the form closed at once');
  await p;
  assert.equal(calls[0].url, '/api/schedules');
  assert.equal(calls[0].body.id, d.id, 'the id made here is the one the server keeps');
  assert.equal(calls[0].body.hook, d.hook);
});

test('a refused save is taken back and its form opens again with what was written and the reason', async () => {
  reset(snapshot());
  server(400);
  const d = { ...draftOf(null, { projectId: 'p1' }), prompt: 'だめなもの' };
  await saveSchedule(d);
  assert.equal(store.state.schedules.length, 0, 'taken back');
  assert.equal(store.scheduleOpen, d.id, 'the form is open again');
  assert.equal(store.scheduleDrafts.get(d.id).prompt, 'だめなもの', 'with the words written');
  assert.equal(store.scheduleDrafts.get(d.id).error, '断られました');
  assert.match(store.notices[0].text, /保存できませんでした/);
});

test('turning one off shows at once (no next run); a refusal turns it back on', async () => {
  reset(snapshot([saved()]));
  server(500);
  const p = setScheduleEnabled('sc-1', false);
  assert.equal(store.state.schedules[0].enabled, false);
  assert.equal(store.state.schedules[0].nextAt, null);
  await p;
  assert.equal(store.state.schedules[0].enabled, true);
  assert.equal(store.notices.length, 1);
});

test('run now shows a run in progress at the click; removing takes the row away at the click', async () => {
  reset(snapshot([saved({ hook: { kind: 'slack', host: 'hooks.slack.com' } })]));
  server(200, { sessionId: 's9' });
  const p = runSchedule('sc-1');
  const sc = store.state.schedules[0];
  assert.equal(sc.busy, true);
  assert.equal(sc.runs[0].outcome, 'started');
  assert.equal(sc.runs[0].delivery.phase, 'waiting');
  assert.equal(runLook(sc.runs[0], undefined).word, '実行中');
  await p;
  const q = removeSchedule('sc-1');
  assert.equal(store.state.schedules.length, 0);
  await q;
});

test('changing only the name keeps when it runs next; changing the rule works it out again', () => {
  const state = snapshot([saved({ nextAt: 123 })]);
  scheduleSaveEffect({ id: 'sc-1', name: '別の名前' })(state);
  assert.equal(state.schedules[0].nextAt, 123);
  const now = local(2026, 12, 1, 10);
  scheduleSaveEffect({ id: 'sc-1', rule: { kind: 'interval', minutes: 30 } }, now)(state);
  assert.equal(state.schedules[0].nextAt, now + 30 * 60_000);
  scheduleSaveEffect({ id: 'sc-1', env: { TOKEN: null, OTHER: 'abc' }, hook: '' })(state);
  assert.deepEqual(state.schedules[0].env, [{ name: 'OTHER', length: 3 }]);
  assert.equal(state.schedules[0].hook, null);
});

test('a rule and a run are told in a few words, one icon each', () => {
  assert.equal(ruleText({ kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }), '毎日 09:00');
  assert.equal(ruleText({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), '平日 09:00');
  assert.equal(ruleText({ kind: 'daily', time: '18:30', days: [1, 3, 5] }), '月・水・金 18:30');
  assert.equal(ruleText({ kind: 'interval', minutes: 120 }), '2時間ごと');
  assert.equal(ruleText({ kind: 'interval', minutes: 45 }), '45分ごと');
  assert.match(ruleText({ kind: 'once', at: local(2026, 12, 1, 12) }), /^12\/01 12:00 に1回$/);
  const run = (o) => ({ at: 1, sessionId: 's', outcome: 'started', error: null, delivery: { phase: 'none', at: null, error: null }, ...o });
  assert.equal(runLook(run({ outcome: 'skipped' })).word, '見送り');
  assert.equal(runLook(run({ outcome: 'failed' })).tone, 'red');
  assert.equal(runLook(run(), { lifecycle: 'running' }).word, '実行中');
  assert.equal(runLook(run({ delivery: { phase: 'sent' } }), { lifecycle: 'turn_finished' }).word, '送信済み');
  assert.equal(runLook(run({ delivery: { phase: 'failed' } }), { lifecycle: 'turn_finished' }).word, '送れませんでした');
  assert.equal(runLook(run(), { lifecycle: 'turn_finished' }).word, '完了');
  assert.equal(hookLabelOf('https://hooks.slack.com/services/x').kind, 'slack');
});

test('a form says what is missing before anything is sent, and shows the variables it will have', () => {
  const d = draftOf(null, { projectId: 'p1' });
  assert.equal(draftProblem(d), '指示文を書いてください');
  d.prompt = 'x';
  assert.equal(draftProblem(d), '');
  d.rule = { kind: 'interval', minutes: 2 };
  assert.match(draftProblem(d), /5分から/);
  d.rule = { kind: 'daily', time: '09:00', days: [] };
  assert.match(draftProblem(d), /曜日/);
  d.rule = { kind: 'once', at: Date.now() - 1000 };
  assert.match(draftProblem(d), /過ぎた/);
  assert.equal(nextText(d.rule, true), '');
  const e = draftOf(saved());
  e.env = { TOKEN: null, NEW_ONE: 'abc' };
  assert.deepEqual(draftEnv(saved(), e).map((v) => [v.name, v.added]), [['NEW_ONE', true]]);
  assert.equal(saveBody(e).hook, undefined, 'the saved address is kept unless changed');
  assert.deepEqual(saveBody(e).env, { TOKEN: null, NEW_ONE: 'abc' });
});
