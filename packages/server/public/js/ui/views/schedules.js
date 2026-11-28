// Schedules: work that starts by itself at set times. One row per schedule — what it does, when, where, its last run —
// with "run now" and its on/off switch at the right. Pressing a row opens its form right under it; ＋ under the list
// opens a new one. The form saves with the button at its right end (or Ctrl+Enter / Ctrl+S) and closes at once: the row
// shows what was saved from the click (logic/schedules.js), and opens again with the reason if the server refuses.
import { removeSchedule, runSchedule, saveSchedule, setScheduleEnabled, testScheduleHook } from '../../logic/actions.js';
import { defaultChoice, usableAgents, usableChoice } from '../../logic/ai.js';
import { stamp } from '../../logic/format.js';
import { DAY, HOOK_WORD, draftEnv, draftOf, draftProblem, newScheduleId, nextText, ruleText, runLook, schedulesOf } from '../../logic/schedules.js';
import { SCHEDULE_INTERVAL_MAX, SCHEDULE_INTERVAL_MIN } from '../../logic/schedule-rule.js';
import { store } from '../../logic/store.js';
import { aiPicker } from '../ai-picker.js';
import { confirmAction } from '../command-dialog.js';
import { $, el, put, sync } from '../dom.js';
import { icon } from '../icons.js';
import { picker } from '../menu.js';
import { go, render } from '../shell.js';
import { ptag } from '../vocabulary.js';
import { segmented, toggle } from './settings.js';

const remember = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const firstLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const pad2 = (n) => String(n).padStart(2, '0');
/** A moment as the value of <input type=datetime-local> (local time). */
const localValue = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/** Where a new schedule starts: the workspace last used for new work, and the AI last used there. */
function startingPoint() {
  const projects = store.state.projects.filter((p) => !p.pending);
  const last = remember('crProject');
  const projectId = projects.some((p) => p.id === last) ? last : projects[0]?.id ?? '';
  let ai = null;
  try { ai = JSON.parse(remember(`crChoiceWs:${projectId}`) ?? 'null'); } catch {}
  const choice = usableChoice(ai?.provider ? ai : defaultChoice(usableAgents()[0]));
  return { projectId, ...choice };
}

/** The open form's draft, made from the schedule (or a new one) the first time it is asked for. */
function draftFor(id) {
  let d = store.scheduleDrafts.get(id);
  if (!d) {
    const sc = schedulesOf(store.state).find((x) => x.id === id);
    d = draftOf(sc, startingPoint());
    if (!sc) d.id = id;
    store.scheduleDrafts.set(id, d);
  }
  return d;
}

/** Close the form; what was written in it and not saved is let go. */
function closeForm(id) {
  store.scheduleDrafts.delete(id);
  if (store.scheduleOpen === id) store.scheduleOpen = null;
  render();
}

function openForm(id) {
  if (store.scheduleOpen && store.scheduleOpen !== id) store.scheduleDrafts.delete(store.scheduleOpen);
  store.scheduleOpen = id;
  render();
}

/** One labelled line of the form: a short name at the left, the control(s) at the right. */
const line = (name, ...control) => el('div', { class: 'sf-line' }, el('span', { class: 'sf-lab' }, name), el('div', { class: 'sf-ctl' }, ...control));

/** The form for one schedule (existing or new). Built once per opening; it edits the draft in place. */
function form(id) {
  const d = draftFor(id);
  const saved = () => schedulesOf(store.state).find((x) => x.id === id);
  const err = el('div', { class: 'err', role: 'alert' }, d.error);
  const save = el('button', { type: 'button', class: 'primary', title: '保存 (Ctrl+Enter)' }, icon('check', 's'), '保存');

  // ---- what, where, who ----
  const name = el('input', { type: 'text', value: d.name, placeholder: '名前', maxlength: '80', 'aria-label': 'スケジュールの名前', spellcheck: 'false' });
  name.addEventListener('input', () => { d.name = name.value; });
  const prompt = el('textarea', { rows: '3', placeholder: '何を作りますか?', 'aria-label': '指示文' });
  prompt.value = d.prompt;
  prompt.addEventListener('input', () => { d.prompt = prompt.value; });
  const workspace = picker({ ic: 'folder', label: 'ワークスペース', value: d.projectId, options: store.state.projects.filter((p) => !p.pending).map((p) => ({ value: p.id, label: p.name, sub: p.rootPath })), onChange: (v) => { d.projectId = v; } });
  const ai = aiPicker({ value: { provider: d.provider, model: d.model, effort: d.effort }, label: '実行するAI', onChange: (c) => Object.assign(d, c) });

  // ---- when ----
  const next = el('small', { class: 'sf-next' });
  const paintNext = () => { next.textContent = nextText(d.rule, d.enabled) || (d.enabled ? '' : 'オフ'); };
  const whenBox = el('div', { class: 'sf-when' });
  const paintWhen = () => {
    const r = d.rule;
    if (r.kind === 'daily') {
      const time = el('input', { type: 'time', class: 'sf-time', value: r.time, 'aria-label': '時刻', required: true });
      time.addEventListener('input', () => { if (time.value) r.time = time.value; paintNext(); });
      const days = DAY.map((w, i) => {
        const b = el('button', { type: 'button', class: 'day', 'aria-pressed': String(r.days.includes(i)), 'aria-label': `${w}曜日` }, w);
        b.addEventListener('click', () => {
          r.days = r.days.includes(i) ? r.days.filter((x) => x !== i) : [...r.days, i].sort((a, b) => a - b);
          b.setAttribute('aria-pressed', String(r.days.includes(i)));
          paintNext();
        });
        return b;
      });
      put(whenBox, time, el('span', { class: 'days', role: 'group', 'aria-label': '曜日' }, days));
    } else if (r.kind === 'interval') {
      const hours = r.minutes % 60 === 0;
      const n = el('input', { type: 'text', inputmode: 'numeric', class: 'num sf-num', value: String(hours ? r.minutes / 60 : r.minutes), maxlength: hours ? '3' : '5', 'aria-label': '間隔' });
      const unit = segmented('単位', [{ value: 'm', label: '分' }, { value: 'h', label: '時間' }], hours ? 'h' : 'm', (u) => {
        const v = Math.max(1, Math.floor(Number(n.value)) || 1);
        r.minutes = u === 'h' ? v * 60 : v;
        n.maxLength = u === 'h' ? 3 : 5;
        paintNext();
      });
      n.addEventListener('input', () => {
        const v = Math.floor(Number(n.value)) || 0;
        r.minutes = unit.querySelector('[aria-checked=true]')?.dataset.v === 'h' ? v * 60 : v;
        paintNext();
      });
      put(whenBox, n, unit, el('small', { class: 'sf-hint' }, `${SCHEDULE_INTERVAL_MIN}分〜${SCHEDULE_INTERVAL_MAX / 1440}日`));
    } else {
      const at = el('input', { type: 'datetime-local', class: 'sf-at', value: localValue(r.at), 'aria-label': '日時' });
      at.addEventListener('input', () => { const t = new Date(at.value).getTime(); if (Number.isFinite(t)) r.at = t; paintNext(); });
      put(whenBox, at);
    }
    paintNext();
  };
  const KIND_DEFAULT = { daily: () => ({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), interval: () => ({ kind: 'interval', minutes: 60 }), once: () => ({ kind: 'once', at: Math.ceil((Date.now() + 3600_000) / 600_000) * 600_000 }) };
  const kind = segmented('いつ', [{ value: 'daily', label: '時刻' }, { value: 'interval', label: '間隔' }, { value: 'once', label: '1回' }], d.rule.kind, (k) => {
    if (d.rule.kind !== k) d.rule = KIND_DEFAULT[k]();
    paintWhen();
  });
  paintWhen();

  // ---- where the result goes ----
  const hookBox = el('div', { class: 'sf-hook' });
  const tested = el('small', { class: 'sf-tested', role: 'status' });
  const hookInput = el('input', { type: 'text', placeholder: 'Discord・Slack などの Webhook URL', 'aria-label': 'Webhook URL', spellcheck: 'false', autocomplete: 'off' });
  hookInput.addEventListener('input', () => { d.hook = hookInput.value.trim() || (saved()?.hook ? '' : undefined); tested.textContent = ''; });
  hookInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); hookInput.blur(); } });
  const test = el('button', { type: 'button', title: 'この URL にテストのメッセージを送ります', onclick: async () => {
    tested.textContent = '';
    tested.className = 'sf-tested';
    const url = typeof d.hook === 'string' && d.hook ? d.hook : undefined;
    const r = await testScheduleHook({ id: saved() ? id : undefined, url });
    tested.className = `sf-tested ${r.status === 200 ? '' : 'err'}`;
    put(tested, icon(r.status === 200 ? 'check' : 'error', 's'), r.status === 200 ? '届きました' : (r.body.error || '送れませんでした'));
  } }, icon('send', 's'), 'テスト送信');
  const paintHook = () => {
    const sc = saved();
    const keep = !!sc?.hook && d.hook === undefined;
    test.disabled = !keep && !(typeof d.hook === 'string' && d.hook);
    // A saved address is never shown again (it holds a token): its service and host, with × to take it off.
    if (keep) {
      put(hookBox, el('span', { class: 'sf-saved', title: `${HOOK_WORD[sc.hook.kind]}（${sc.hook.host}）に送ります` }, icon('send', 's'), HOOK_WORD[sc.hook.kind], el('small', {}, sc.hook.host)),
        el('button', { type: 'button', class: 'quiet ib', title: 'この送り先を外す', 'aria-label': '送り先を外す', onclick: () => { d.hook = ''; paintHook(); } }, icon('x', 's')),
        el('button', { type: 'button', class: 'quiet', title: '別の URL に変える', onclick: () => { d.hook = ''; paintHook(); hookInput.focus(); } }, icon('pencil', 's')),
        test, tested);
    } else {
      hookInput.value = typeof d.hook === 'string' ? d.hook : '';
      put(hookBox, hookInput, test, tested);
    }
  };
  hookInput.addEventListener('input', () => { test.disabled = !hookInput.value.trim(); });
  paintHook();

  // ---- its own environment variables ----
  const envList = el('div', { class: 'sf-env' });
  const envName = el('input', { type: 'text', placeholder: '変数名', 'aria-label': '変数名', spellcheck: 'false', autocomplete: 'off' });
  const envValue = el('input', { type: 'password', placeholder: '値', 'aria-label': '値', autocomplete: 'new-password' });
  const envErr = el('div', { class: 'err', role: 'alert' });
  const paintEnv = () => put(envList, draftEnv(saved(), d).map((v) => el('div', { class: 'sf-var' + (v.added ? ' added' : '') }, icon('key', 's dim'), el('code', {}, v.name),
    el('small', {}, `${'•'.repeat(Math.min(10, v.length))}（${v.length}文字）`),
    el('button', { type: 'button', class: 'quiet ib', title: `${v.name} を外す`, 'aria-label': `${v.name} を外す`, onclick: () => {
      if (saved()?.env?.some((x) => x.name === v.name)) d.env[v.name] = null;
      else delete d.env[v.name];
      paintEnv();
    } }, icon('x', 's')))));
  const addEnv = () => {
    const k = envName.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return void (envErr.textContent = '変数名は英数字とアンダースコアで、数字以外から始めてください');
    envErr.textContent = '';
    d.env[k] = envValue.value;
    envName.value = envValue.value = '';
    paintEnv();
    envName.focus();
  };
  for (const i of [envName, envValue]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (envName.value.trim()) addEnv(); else i.blur(); } });
  paintEnv();

  const tidy = toggle('済んだら片付ける', (v) => { d.tidy = v; }, d.tidy);

  // ---- saving ----
  const submit = () => {
    const why = draftProblem(d);
    if (why) return void (err.textContent = why);
    if (envName.value.trim()) addEnv(); // a variable typed but not added yet is part of what is saved
    saveSchedule({ ...d, rule: d.rule.kind === 'once' ? { ...d.rule } : d.rule });
  };
  save.addEventListener('click', submit);
  const del = !d.isNew && el('button', { type: 'button', class: 'quiet danger', onclick: async () => {
    if (await confirmAction({ heading: 'スケジュールを削除します', title: saved()?.name || firstLine(saved()?.prompt), text: '送り先と環境変数も消えます。これまでに始まった作業はそのまま残ります。', ok: '削除する', okIcon: 'trash' })) removeSchedule(id);
  } }, icon('trash', 's'), '削除');

  const node = el('div', { class: 'sched-form', 'data-form': id },
    name, prompt,
    el('div', { class: 'bar' }, workspace.node, ai.node),
    line('いつ', kind, whenBox, next),
    line('送り先', hookBox),
    line('環境変数', envList, el('div', { class: 'sf-env-new' }, envName, envValue, el('button', { type: 'button', class: 'ib', title: '追加', 'aria-label': '環境変数を追加', onclick: addEnv }, icon('plus', 's'))), envErr),
    line('済んだら片付ける', tidy),
    el('div', { class: 'sf-foot' }, del || el('span'), el('span', { class: 'sf-acts' }, err, save)));
  node.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key.toLowerCase() === 's') && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); }
    else if (e.key === 'Escape' && !document.querySelector('.menu')) { e.preventDefault(); e.stopPropagation(); closeForm(id); }
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); prompt.focus(); } });
  return node;
}

/** The row of a saved schedule. Its last run says what happened in one icon and one word, and opens that work. */
function scheduleRow(sc, formNode) {
  const sessions = store.state.sessions;
  const last = sc.runs?.[0];
  const look = last && runLook(last, sessions.find((s) => s.id === last.sessionId));
  const open = store.scheduleOpen === sc.id;
  const head = el('button', { type: 'button', class: 'sched-head', 'aria-expanded': String(open), title: open ? '閉じる (Esc)' : '開いて変える', onclick: () => (open ? closeForm(sc.id) : openForm(sc.id)) },
    el('b', {}, sc.name || firstLine(sc.prompt)),
    el('small', {}, icon('clock', 's'), el('span', {}, ruleText(sc.rule)), el('span', { class: 'ws' }, icon('folder', 's'), sc.projectName), ptag(sc.provider), sc.hook && el('span', { class: 'sf-to', title: `結果を${HOOK_WORD[sc.hook.kind]}に送ります` }, icon('send', 's'), HOOK_WORD[sc.hook.kind])));
  const when = el('small', { class: 'sched-when' }, sc.enabled && sc.nextAt ? `次回 ${stamp(sc.nextAt)}` : 'オフ');
  const lastRun = look && el('button', { type: 'button', class: `quiet sched-last ${look.tone === 'red' ? 'red' : ''}`, disabled: !last.sessionId,
    title: last.error || last.delivery?.error || (last.sessionId ? 'この実行の作業を開く' : ''), onclick: () => last.sessionId && go(`#/s/${last.sessionId}`) },
    icon(look.icon, `s${look.tone === 'spin' ? ' spin' : look.tone === 'red' ? ' red' : ''}`), el('span', {}, look.word), el('small', {}, stamp(last.at)));
  const run = el('button', { type: 'button', class: 'ib', title: '今すぐ実行', 'aria-label': `${sc.name || firstLine(sc.prompt)} を今すぐ実行`, disabled: sc.busy, onclick: () => runSchedule(sc.id) }, icon('play', 's'));
  const sw = toggle(`${sc.name || firstLine(sc.prompt)} をオンにする`, (v) => setScheduleEnabled(sc.id, v), sc.enabled);
  return el('div', { class: `sched${sc.enabled ? '' : ' off'}${open ? ' open' : ''}` },
    el('div', { class: 'sched-row' }, head, el('div', { class: 'ctl' }, lastRun, when, run, sw)),
    open && formNode);
}

export function schedulesView() {
  const list = el('div', { class: 'sched-list' });
  const fresh = el('div', {});
  const none = el('p', { class: 'note' }, 'まだありません');
  const noProject = el('p', { class: 'note' }, 'ワークスペースを追加すると作れます');
  const add = el('button', { type: 'button', class: 'ib', title: 'スケジュールを追加', 'aria-label': 'スケジュールを追加' }, icon('plus', 's'));
  add.addEventListener('click', () => {
    const id = store.scheduleOpen && !schedulesOf(store.state).some((x) => x.id === store.scheduleOpen) ? store.scheduleOpen : newScheduleId();
    openForm(id);
    document.querySelector(`[data-form="${id}"] textarea`)?.focus();
  });
  // Forms are kept per opening, so a redraw of the row never loses what is being typed.
  const forms = new Map();
  const formOf = (id) => forms.get(id) ?? forms.set(id, form(id)).get(id);

  $('main').replaceChildren(el('div', { class: 'pad schedules' },
    el('h1', {}, icon('clock', 'l'), 'スケジュール', el('button', { class: 'quiet narrow-only', onclick: () => go('#/') }, icon('back', 's'), '戻る')),
    list, none, fresh, noProject, el('div', { class: 'stepper end' }, add)));

  return {
    key: 'schedules',
    update() {
      const all = schedulesOf(store.state);
      const openId = store.scheduleOpen;
      for (const id of forms.keys()) if (id !== openId) forms.delete(id);
      const sessions = store.state.sessions;
      sync(list, all, (sc) => sc.id, (sc) => {
        const last = sc.runs?.[0];
        return JSON.stringify([sc, openId === sc.id, last?.sessionId && sessions.find((s) => s.id === last.sessionId)?.lifecycle]);
      }, (sc) => scheduleRow(sc, openId === sc.id ? formOf(sc.id) : null));
      // A new one being written sits under the list until it is saved.
      const isNew = openId && !all.some((x) => x.id === openId);
      if (isNew && fresh.firstChild !== forms.get(openId)) put(fresh, formOf(openId));
      if (!isNew && fresh.firstChild) put(fresh);
      const hasProject = store.state.projects.some((p) => !p.pending);
      none.hidden = all.length > 0 || !!isNew || !hasProject;
      noProject.hidden = hasProject;
      add.disabled = !hasProject || !!isNew;
    },
  };
}
