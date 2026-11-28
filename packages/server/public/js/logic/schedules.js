// Schedules on the screen: their expected effects (shown at the click, before the server answers), the words that
// describe a rule and a run, and the drafts being edited. Pure apart from `drafts` (client state). No DOM, no network.
import { stamp } from './format.js';
import { nextRunAt, settleRule } from './schedule-rule.js';

export const DAY = ['日', '月', '火', '水', '木', '金', '土'];
const BUSY = ['queued', 'running', 'waiting_for_user'];

/** A new schedule's id, made here so the row shown at the click and the one the server keeps are the same. */
export const newScheduleId = () => (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** Which service a webhook address is, and its host (never the token in its path). Same rule as the server. */
export function hookLabelOf(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)discord(app)?\.com$/i.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return { kind: 'discord', host: u.host };
    if (/^hooks\.slack\.com$/i.test(u.hostname)) return { kind: 'slack', host: u.host };
    return { kind: 'generic', host: u.host };
  } catch {
    return { kind: 'generic', host: '' };
  }
}
export const HOOK_WORD = { discord: 'Discord', slack: 'Slack', generic: 'Webhook' };

/** A rule in a few words: "平日 09:00", "月・水・金 09:00", "2時間ごと", "12/01 12:00 に1回". */
export function ruleText(rule) {
  if (!rule) return '';
  if (rule.kind === 'interval') return rule.minutes % 60 === 0 ? `${rule.minutes / 60}時間ごと` : `${rule.minutes}分ごと`;
  if (rule.kind === 'once') return `${stamp(rule.at)} に1回`;
  const d = rule.days.join(',');
  const days = d === '0,1,2,3,4,5,6' ? '毎日' : d === '1,2,3,4,5' ? '平日' : d === '0,6' ? '土日' : rule.days.map((x) => DAY[x]).join('・');
  return `${days} ${rule.time}`;
}

/**
 * What a run is in one icon and one word. `session`: the work it started, from the state (absent: not listed yet).
 * Returns { icon, word, tone } (tone: '' | 'red' | 'spin').
 */
export function runLook(run, session) {
  if (run.outcome === 'skipped') return { icon: 'pause', word: '見送り', tone: '' };
  if (run.outcome === 'failed') return { icon: 'error', word: '失敗', tone: 'red' };
  if (!run.sessionId || (session && BUSY.includes(session.lifecycle))) return { icon: 'running', word: '実行中', tone: 'spin' };
  if (run.delivery?.phase === 'failed') return { icon: 'error', word: '送れませんでした', tone: 'red' };
  if (run.delivery?.phase === 'sent') return { icon: 'send', word: '送信済み', tone: '' };
  if (run.delivery?.phase === 'waiting' || run.delivery?.phase === 'sending') return { icon: 'running', word: '送信中', tone: 'spin' };
  if (session && ['error', 'interrupted', 'unknown'].includes(session.lifecycle)) return { icon: 'error', word: '止まりました', tone: 'red' };
  return { icon: 'done', word: '完了', tone: '' };
}

/** The schedules in the order the screen lists them (the server's order: oldest first). */
export const schedulesOf = (state) => state?.schedules ?? [];

/**
 * A schedule saved from the screen: shown as saved from the click (made, or changed), its next run worked out as the
 * server will. `draft` holds only what changes for an existing one; `hook`: a URL sets, '' removes, undefined keeps;
 * `env`: { NAME: value | null }.
 */
export const scheduleSaveEffect = (draft, now = Date.now()) => (state) => {
  state.schedules ??= [];
  let sc = state.schedules.find((x) => x.id === draft.id);
  const was = sc ? { rule: sc.rule, enabled: sc.enabled, nextAt: sc.nextAt } : null;
  if (!sc) {
    sc = { id: draft.id, name: '', prompt: '', projectId: '', projectName: '', provider: 'claude', model: '', effort: '', rule: null, enabled: true, tidy: true, createdAt: now, updatedAt: now, nextAt: null, runs: [], hook: null, env: [], busy: false };
    state.schedules.push(sc);
  }
  if (draft.name !== undefined) sc.name = String(draft.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (draft.prompt !== undefined) sc.prompt = String(draft.prompt ?? '').trim();
  if (draft.projectId !== undefined) {
    sc.projectId = draft.projectId;
    sc.projectName = state.projects?.find((p) => p.id === draft.projectId)?.name ?? sc.projectName;
  }
  for (const k of ['provider', 'model', 'effort']) if (draft[k] !== undefined) sc[k] = draft[k] ?? '';
  if (draft.tidy !== undefined) sc.tidy = draft.tidy !== false;
  if (draft.rule !== undefined) sc.rule = settleRule(draft.rule) ?? sc.rule;
  if (draft.enabled !== undefined) sc.enabled = draft.enabled !== false;
  if (draft.hook !== undefined) sc.hook = draft.hook ? hookLabelOf(draft.hook) : null;
  if (draft.env) {
    const names = new Map((sc.env ?? []).map((v) => [v.name, v]));
    for (const [k, v] of Object.entries(draft.env)) {
      if (v === null) names.delete(k);
      else names.set(k, { name: k, length: String(v).length });
    }
    sc.env = [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  sc.updatedAt = now;
  // Same rule as the server: worked out again when the rule changed or it was turned (back) on.
  const changed = !was || JSON.stringify(was.rule) !== JSON.stringify(sc.rule);
  sc.nextAt = !sc.enabled || !sc.rule ? null : changed || !was.enabled || was.nextAt === null ? nextRunAt(sc.rule, now) : was.nextAt;
  if (sc.nextAt === null) sc.enabled = false;
};

export const scheduleRemoveEffect = (id) => (state) => {
  state.schedules = (state.schedules ?? []).filter((x) => x.id !== id);
};

/** Run now: the row shows a run in progress from the click. */
export const scheduleRunEffect = (id, now = Date.now()) => (state) => {
  const sc = (state.schedules ?? []).find((x) => x.id === id);
  if (!sc) return;
  sc.runs = [{ at: now, sessionId: null, outcome: 'started', error: null, delivery: { phase: sc.hook ? 'waiting' : 'none', at: null, error: null } }, ...(sc.runs ?? [])];
  sc.busy = true;
};

/**
 * The form's contents for a schedule (a copy, edited freely until it is saved). For a new one, what it starts from:
 * the first workspace, the given AI, weekdays at 09:00, on, tidied when done.
 */
export function draftOf(sc, defaults = {}) {
  if (sc) return { id: sc.id, isNew: false, name: sc.name, prompt: sc.prompt, projectId: sc.projectId, provider: sc.provider, model: sc.model, effort: sc.effort, rule: { ...sc.rule }, enabled: sc.enabled, tidy: sc.tidy, hook: undefined, env: {}, error: '' };
  return { id: newScheduleId(), isNew: true, name: '', prompt: '', projectId: defaults.projectId ?? '', provider: defaults.provider ?? 'claude', model: defaults.model ?? '', effort: defaults.effort ?? '', rule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, enabled: true, tidy: true, hook: undefined, env: {}, error: '' };
}

/** What a draft sends: everything for a new schedule; for an existing one too (the server keeps what is equal). */
export function saveBody(d) {
  const body = { id: d.id, name: d.name, prompt: d.prompt, projectId: d.projectId, provider: d.provider, model: d.model, effort: d.effort, rule: d.rule, enabled: d.enabled, tidy: d.tidy };
  if (d.hook !== undefined) body.hook = d.hook;
  if (Object.keys(d.env).length) body.env = { ...d.env };
  return body;
}

/** Why a draft cannot be saved yet (the first reason), or '' when it can. Checked before anything is sent. */
export function draftProblem(d, now = Date.now()) {
  if (!d.prompt.trim()) return '指示文を書いてください';
  if (!d.projectId) return 'ワークスペースを選んでください';
  const rule = settleRule(d.rule);
  if (!rule) return d.rule?.kind === 'interval' ? '間隔は5分から7日（10080分）までです' : d.rule?.kind === 'daily' ? '時刻と曜日を選んでください' : '日時を選んでください';
  if (d.enabled && rule.kind === 'once' && rule.at <= now) return '過ぎた日時は選べません';
  return '';
}

/** The variables a draft will have once saved: the saved names, less those removed, plus those added. */
export function draftEnv(sc, d) {
  const names = new Map((sc?.env ?? []).map((v) => [v.name, { ...v, added: false }]));
  for (const [k, v] of Object.entries(d.env)) {
    if (v === null) names.delete(k);
    else names.set(k, { name: k, length: v.length, added: true });
  }
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "次回 12/01 09:00" for what is set now in a draft or a schedule, or '' when it will not run. */
export function nextText(rule, enabled, now = Date.now()) {
  const r = settleRule(rule);
  const at = enabled && r ? nextRunAt(r, now) : null;
  return at ? `次回 ${stamp(at)}` : '';
}
