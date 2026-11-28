// Parts of a piece of work that several screens show: commands the agent asked for, the human's own steps,
// and the verdict on the work with its evidence.
import { act, finishChecks, openPath, reportCommand, runCommand, runStep, setStep } from '../logic/actions.js';
import { clock, fullStamp } from '../logic/format.js';
import { parseMarkdown } from '../logic/markdown.js';
import { store } from '../logic/store.js';
import { inboxStepIndexes, isBusy, openPlainStep, workStepsModel, workspacesOf } from '../logic/selectors.js';
import { confirmAction, confirmCommand } from './command-dialog.js';
import { el, put } from './dom.js';
import { icon } from './icons.js';
import { go } from './shell.js';
import { LOOK, VERDICT } from './vocabulary.js';

const sessionOf = (id) => store.state.sessions.find((x) => x.id === id);

/**
 * Call the work done (it is put away at once, and can be brought back). Work the agent is still on is stopped first,
 * after asking. Resolves true when it was called done.
 */
export async function finishWork(s) {
  if (isBusy(s) && !(await confirmAction({
    heading: 'エージェントを止めて完了にします',
    title: s.taskTitle,
    text: s.lifecycle === 'queued' ? 'まだ順番待ちの作業です。取り消して、完了にします（いつでも作業に戻せます）。' : 'エージェントはまだ作業中です。いまの作業を中断してから完了にし、片付けます（会話は残り、いつでも作業に戻せます）。',
    ok: '止めて完了にする',
  }))) return false;
  act(s.id, 'accept');
  return true;
}
/**
 * Which workspace (project) a piece of work belongs to, shown beside its title so it need not be guessed from the title.
 * Quiet: a folder shape and the name (and those of any other workspaces it also works in), nothing when it has none.
 */
export const workspaceTag = (s) => s.projectName ? el('span', { class: 'ws', title: `ワークスペース: ${workspacesOf(s)}` }, icon('folder', 's'), workspacesOf(s)) : null;
/** The 完了にする button of a row. */
export const doneButton = (s, cls = '') => el('button', { class: cls || null, title: 'この作業を完了にして片付ける（いつでも戻せます）', disabled: !!s.busyWith, onclick: () => finishWork(s) }, icon('check', 's'), '完了にする');

/** A button that hands what a command did to the agent, so it can carry on (or fix what failed). */
function tellAgent(sessionId, command, ok, exitCode, output) {
  const told = el('span', { class: 'note' });
  const tell = el('button', { class: ok ? '' : 'primary', onclick: async () => {
    tell.disabled = true;
    told.textContent = '送っています…';
    const m = await reportCommand(sessionId, command, exitCode, output);
    told.textContent = m.status !== 200 ? (m.body.error || '送れませんでした') : m.body.deferred ? 'いまの作業が終わったら届きます。' : 'エージェントに伝えました。';
  } }, icon('send', 's'), ok ? '結果をエージェントに伝える' : '失敗をエージェントに伝えて直してもらう');
  return el('div', { class: 'acts' }, tell, told);
}

/** Run a command the agent wrote in its reply (not one of the human's steps). The result appears under `host`. */
async function runAndShow(sessionId, command, btn, host) {
  const sess = sessionOf(sessionId);
  if (!sess || !(await confirmCommand({ command, cwd: sess.cwd, title: sess.taskTitle, forStep: false }))) return;
  btn.disabled = true;
  host.parentElement?.querySelector(':scope > .run-result')?.remove();
  const box = el('div', { class: 'run-result' }, icon('running', 's spin'), ' 実行中…');
  host.after(box);
  const r = await runCommand(sessionId, command);
  btn.disabled = false;
  if (r.status !== 200) return void put(box, icon('fail', 's red'), ' ', r.body.error || `実行できませんでした (${r.status})`);
  const { ok, exitCode, output } = r.body;
  box.className = `run-result ${ok ? 'ok' : 'ng'}`;
  put(box, el('div', { class: 'run-head' }, icon(ok ? 'check' : 'fail', `s ${ok ? 'green' : 'red'}`), el('strong', {}, ok ? '成功しました' : `失敗しました（終了コード ${exitCode ?? '不明'}）`)),
    output && el('pre', {}, output), tellAgent(sessionId, command, ok, exitCode, output));
}

/** A command as something to click. Clicking runs it (after the question, unless that was turned off); it never opens anything. */
export function cmdButton(sessionId, command, run = null) {
  const b = el('button', { type: 'button', class: 'cmd', title: 'クリックで、この作業のフォルダで実行します' }, command);
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // a command inside something clickable (a step that opens its work) only runs
    if (run) return run(b);
    runAndShow(sessionId, command, b, b.closest('.md > *, .msg, li, .ticket, .steps') ?? b);
  });
  return b;
}

/**
 * A file or folder the agent named, as something to click: it opens at once with what this computer opens it with,
 * no question asked (nothing runs; the server shows what would run in its folder instead). Looks like a command.
 */
function pathButton(sessionId, text, target) {
  const b = el('button', { type: 'button', class: 'cmd path', title: target.relative ? 'クリックで、この作業のフォルダから開きます' : 'クリックで開きます' }, text);
  b.addEventListener('click', async (e) => {
    e.stopPropagation(); // inside something clickable (a step that opens its work) it only opens the path
    b.classList.add('opening');
    await openPath(target.path, sessionId);
    b.classList.remove('opening');
  });
  return b;
}
/** A path is clickable when there is something to find it from: an absolute one always, a relative one in a work. */
const clickablePath = (target, sid) => !!target && (!target.relative || !!sid);

/** A step's command: asked about, then run; what it left is read on the server and arrives as the updated list. */
function stepCommand(sess, index, st) {
  const b = cmdButton(sess.id, st.command, async () => {
    if (!(await confirmCommand({ command: st.command, cwd: sess.cwd, title: sess.taskTitle, forStep: true }))) return;
    runStep(sess.id, index, st.command);
  });
  b.disabled = !!(st.run && st.run.phase !== 'settled');
  return b;
}

/** What the last run of a step's command did, and what reading its output concluded. */
function runLine(sess, st) {
  const r = st.run;
  if (!r) return null;
  if (r.phase === 'running') return el('div', { class: 'run-state' }, icon('running', 's blue spin'), el('span', {}, '実行中… 終わったら出力を読んで、残りの作業を確かめます。'));
  const exit = r.ok === null ? '' : `終了コード ${r.ok ? 0 : r.exitCode ?? '不明'}`;
  if (r.phase === 'reading') return el('div', { class: 'run-state' }, icon('running', 's blue spin'), el('span', {}, `${exit}で終わりました。出力を読んで、残りの作業を確かめています…`));
  const good = !!st.done;
  return el('div', { class: `run-state settled ${good ? 'ok' : 'ng'}` },
    icon(good ? 'check' : 'info', `s ${good ? 'green' : 'amber'}`),
    el('span', {}, r.note || (good ? '済みました。' : 'まだ済んでいません。')),
    (r.outputTail || exit) && el('details', { class: 'raw' }, el('summary', {}, `出力（${exit || '終了コード不明'}）`), el('pre', {}, r.outputTail || '（出力なし）')),
    !good && r.ok !== null && st.command && tellAgent(sess.id, st.command, r.ok, r.exitCode, r.outputTail ?? ''));
}

/**
 * The human's own to-do list for a task whose agent work is finished.
 * In the inbox (`titled`) the whole box opens the work; only its commands do something else (they run). Nothing here
 * is ticked by a stray click: a step is done when its command's output says so, or when the human says so in the work.
 */
function stepCheck(sess, i, st) {
  const busy = !!(st.run && st.run.phase !== 'settled');
  const box = el('input', { type: 'checkbox', checked: !!st.done, disabled: busy,
    title: st.done ? 'まだ完了していないことにする' : 'このタスクを完了にする（チャットはアーカイブしません）',
    'aria-label': st.done ? '完了' : '未完了' });
  box.addEventListener('change', () => setStep(sess.id, i, box.checked));
  return el('label', { class: 'st-check' }, box, el('span', { class: 'st' }, st.title));
}

/** Show every step of a list, or only what can be done now (`key`: a session id, or `look:<projectId>`). */
function everyStepToggle(key, held) {
  const all = store.everyStep.has(key);
  if (held === 0) return null; // nothing waits: both ways show the same
  return el('div', { class: 'steps-held' },
    !all && el('span', { class: 'note' }, `ほか${held}件は、先の作業を済ませる（チェックを付ける）と表示します。`),
    el('button', { type: 'button', class: 'quiet', onclick: () => {
      if (all) store.everyStep.delete(key);
      else store.everyStep.add(key);
      store.changed();
    } }, icon(all ? 'eye' : 'down', 's'), all ? '先にやる作業だけ表示する' : 'すべて表示する'));
}

/** A step's detail. Commands written in it (`npm run dev`) can be clicked to run, as in the agent's reply. */
const stepDetail = (sessionId, text, cls = 'note') => (sessionId && (text.includes('`') || /[A-Za-z]:[\\/]|~\//.test(text)) ? el('div', { class: `${cls} rich` }, richText(text, sessionId)) : el('div', { class: cls }, text));

export function stepsBox(sess, { titled, aside = null }) {
  const steps = sess.task.humanSteps ?? [];
  const left = steps.filter((x) => !x.done).length;
  const open = () => go(`#/s/${sess.id}`);
  // The inbox shows what can be done now; a step waiting on an earlier one appears once that one is done. The work's
  // own screen likewise shows first what comes first: the rest once that is ticked, or on request.
  const shown = titled ? new Set(inboxStepIndexes(steps)) : null;
  const waiting = titled ? steps.filter((x, i) => openPlainStep(x) && !shown.has(i)).length : 0;
  const model = titled ? null : workStepsModel(steps, store.everyStep.has(sess.id));
  const rows = titled ? steps.map((step, index) => ({ index, step, waits: false })).filter((r) => shown.has(r.index)) : model.rows;
  const prep = steps.find((x) => x.prep && !x.done);
  // A list read before the action came as a step of its own says it only as a note, on the first thing to look at.
  const legacyLook = !steps.some((x) => x.prep);
  const firstLook = (i) => !steps.slice(0, i).some((x) => x.check && !x.done);
  const box = el('section', { class: `steps${titled ? ' opens' : ''}` },
    el('div', { class: 'steps-head' }, icon('user', 'amber'),
      titled ? el('button', { class: 'quiet t', onclick: open }, sess.taskTitle, workspaceTag(sess)) : el('strong', {}, 'あなたの作業'),
      !titled && el('span', { class: 'note' }, `残り${left}件。すべて済ませると、この作業は完了になります。`),
      titled && doneButton(sess, 'steps-done'), aside),
    // The inbox lists only what is left (and things to look at are in their project's checklist, see checksBox).
    el('ol', {}, rows.map(({ index: i, step: st, waits }) => el('li', { class: `${st.done ? 'done' : ''}${st.check ? ' look' : ''}${st.prep ? ' prep' : ''}${waits ? ' waits' : ''}` },
      // In the inbox the precondition comes first: it is what has to happen before this step can be done.
      titled && st.after && el('div', { class: 'note after' }, icon('clock', 's'), `先に: ${st.after}`),
      el('div', { class: 'st-line' },
        // In the work itself the human ticks a step done (or unticks it), like the home checklist: a checkbox whose
        // label is the step, crossed out once done. The last one finishes the work; the chat stays open.
        !titled ? stepCheck(sess, i, st) : el('span', { class: 'st' }, st.title)),
      // A step that has to wait for something says so, so it is not done too early.
      !titled && st.after && !st.done && el('div', { class: 'note after' }, icon('clock', 's'), `先に: ${st.after}`),
      // A thing to look at, shown before the action it needs is ticked (every step shown), names that action.
      !titled && st.check && !st.done && prep && el('div', { class: 'note after' }, icon('clock', 's'), `先に: ${prep.title}`),
      // A list without that action as a step: the first thing to look at says what brings the change in before it.
      !titled && legacyLook && st.check && !st.done && LOOK[st.check.update]?.first && firstLook(i)
        && el('div', { class: 'note after' }, icon('clock', 's'), `先に: ${LOOK[st.check.update].first}`),
      !titled && legacyLook && st.check && !st.done && st.check.how && firstLook(i) && stepDetail(sess.id, st.check.how),
      !titled && legacyLook && st.check && !st.done && st.check.command && firstLook(i) && cmdButton(sess.id, st.check.command),
      st.detail && stepDetail(sess.id, st.detail),
      st.command && !st.done && stepCommand(sess, i, st),
      runLine(sess, st)))),
    waiting > 0 && el('div', { class: 'note' }, `ほか${waiting}件は、先の作業が済んでから表示します。`),
    !titled && everyStepToggle(sess.id, model.held),
    store.errors.has(sess.id) && el('div', { class: 'err' }, store.errors.get(sess.id)));
  if (titled) {
    box.title = 'クリックで開く';
    box.addEventListener('click', (e) => {
      // Controls inside keep their own meaning; selecting text is not a click either.
      if (e.target.closest('button, a, summary, details pre, input, label') || getSelection()?.toString()) return;
      open();
    });
  }
  return box;
}
export const stepsSig = (x) => JSON.stringify([x.taskTitle, x.projectName, x.task?.humanSteps, store.errors.get(x.id), store.everyStep.has(x.id)]);

/** One line of evidence for a checked task: what ran, how it exited, what is left uncommitted. */
export function evidenceLine(s) {
  const v = s.task?.validation;
  if (!v) return '';
  const left = v.uncommittedFiles === null ? '' : v.uncommittedFiles ? `、未コミットの変更 ${v.uncommittedFiles}件` : '、未コミットの変更なし';
  return `${v.command} が終了コード ${v.exitCode ?? '不明'} で${v.ok ? '成功' : '失敗'}（${clock(v.at)}）${left}`;
}

export function verdictNodes(s) {
  if (s.usageResume && !isBusy(s)) {
    const at = s.usageResume.resetsAt;
    return [el('div', { class: 'verdict-line' }, icon('clock', 'amber'), el('strong', {}, '利用枠の復活待ち'),
      el('span', { class: 'note' }, at === null ? '復活時刻を確認でき次第、自動再開を予約します' : `${fullStamp(at + 60_000)}ごろに自動再開`),
      el('button', { onclick: () => act(s.id, 'interrupt') }, icon('x', 's'), '自動再開を取り消す'))];
  }
  const t = s.task;
  if (!t) return [];
  if (s.completion === 'human_steps') return [stepsBox(s, { titled: false })];
  const id = s.id;
  const v = t.validation;
  const def = VERDICT[s.completion];
  const evidence = v && el('details', { class: 'raw' }, el('summary', {}, evidenceLine(s)), el('div', { class: 'subject' }, el('pre', {}, v.outputTail || '（出力なし）')));
  const recheck = t.checkCommand && s.lifecycle === 'turn_finished' && !t.validating && el('button', { onclick: () => act(id, 'check') }, icon('restore', 's'), '検証をやり直す');
  if (s.completion === 'accepted') return [el('div', { class: 'verdict-line' }, icon(def.icon, def.tone), el('strong', {}, def.word), el('button', { onclick: () => act(id, 'reopen') }, icon('restore', 's'), '作業に戻す')), evidence];
  if (s.completion === 'validating') return [el('div', { class: 'verdict-line' }, icon(def.icon, `${def.tone} spin`), el('strong', {}, def.word), el('code', {}, t.checkCommand))];
  if (s.completion === 'candidate') return [el('div', { class: 'verdict-line' }, icon(def.icon, def.tone), el('strong', {}, def.word), el('span', { class: 'note' }, '右上の「完了にする」で片付けられます。'), recheck), evidence];
  if (s.completion === 'needs_fix') {
    const auto = t.autoFix ? (t.fixRounds >= t.maxFixRounds ? `自動の修正依頼は上限の${t.maxFixRounds}回に達しました。` : `エージェントに修正を依頼します（${t.fixRounds}/${t.maxFixRounds}回）。`) : '下の欄から修正を指示できます。';
    return [el('div', { class: 'verdict-line' }, icon(def.icon, def.tone), el('strong', { class: 'red' }, def.word), el('span', { class: 'note' }, auto), recheck), evidence];
  }
  return t.checkCommand ? [el('div', { class: 'verdict-line' }, icon('shield', 'dim'), el('span', { class: 'note' }, '返答が終わるたびに検証します: '), el('code', {}, t.checkCommand))] : [];
}

/**
 * Agent prose as rendered Markdown. The tree comes from logic/markdown.js and is built with el(), so whatever the agent
 * wrote is only ever text. Code spans and blocks that are commands become clickable; without a session (a side chat)
 * they stay plain code, since there is no folder to run them in.
 */
export function richText(text, sessionId = null) {
  return el('div', { class: 'md' }, parseMarkdown(text).map((b) => mdBlock(b, sessionId)));
}
function mdBlock(b, sid) {
  switch (b.type) {
    case 'heading': return el(`h${Math.min(b.level + 2, 6)}`, { class: `md-h${b.level}` }, mdInline(b.inline, sid));
    case 'para': return el('p', {}, mdInline(b.inline, sid));
    case 'code': return el('pre', { class: 'code' }, b.command && sid ? cmdButton(sid, b.command) : clickablePath(b.path, sid) ? pathButton(sid, b.text.trim(), b.path) : b.text);
    case 'hr': return el('hr');
    case 'quote': return el('blockquote', {}, b.blocks.map((x) => mdBlock(x, sid)));
    case 'list': return el(b.ordered ? 'ol' : 'ul', { start: b.ordered && b.start !== 1 ? String(b.start) : null },
      b.items.map((it) => el('li', { class: it.checked === null ? null : 'task' },
        it.checked !== null && el('input', { type: 'checkbox', disabled: true, checked: it.checked, 'aria-label': it.checked ? '済み' : '未完了' }),
        it.blocks.map((x) => mdBlock(x, sid)))));
    case 'table': return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, b.head.map((c, k) => el('th', { style: b.align[k] ? `text-align:${b.align[k]}` : null }, mdInline(c, sid))))),
      el('tbody', {}, b.rows.map((r) => el('tr', {}, r.map((c, k) => el('td', { style: b.align[k] ? `text-align:${b.align[k]}` : null }, mdInline(c, sid))))))));
    default: return null;
  }
}
function mdInline(nodes, sid) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'br': return el('br');
      case 'code': return n.command && sid ? cmdButton(sid, n.command) : clickablePath(n.path, sid) ? pathButton(sid, n.v, n.path) : el('code', {}, n.v);
      case 'path': return pathButton(sid, n.v, n.path);
      case 'strong': return el('strong', {}, mdInline(n.c, sid));
      case 'em': return el('em', {}, mdInline(n.c, sid));
      case 'del': return el('del', {}, mdInline(n.c, sid));
      // Opened in the person's browser (the app window itself never navigates away).
      case 'link': return el('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer', title: n.href }, mdInline(n.c, sid));
      default: return null;
    }
  });
}

/**
 * One project's things to look at, from all the works that left them: the one action that comes first, then a checklist
 * under each work's name. Ticking an item ticks that work's step (a work whose last step is ticked is done and put
 * away); 完了にする ticks every item left.
 */
export function checksBox(g) {
  const left = g.works.reduce((n, w) => n + w.items.filter((i) => !i.step.done).length, 0);
  const err = g.works.map((w) => store.errors.get(w.session.id)).find(Boolean);
  const key = `look:${g.projectId}`;
  const sid = g.works[0]?.session.id ?? null;
  const how = (g.hows.length > 0 || g.commands.length > 0) && el('div', { class: 'look-how' },
    g.hows.map((h) => stepDetail(sid, h)),
    g.commands.map((c) => cmdButton(c.sessionId, c.command)));
  // The action comes first, as an item of its own (ticked for every work at once): the checklist shows once it is
  // ticked, or on request.
  const preps = g.works.flatMap((w) => w.preps.map((p) => ({ session: w.session, ...p })));
  const listed = !g.hasPrep || g.prepped || store.everyStep.has(key);
  let prepItem = null;
  if (g.hasPrep) {
    const box = el('input', { type: 'checkbox', checked: g.prepped, 'aria-label': g.prepped ? '済み' : '未完了' });
    box.addEventListener('change', async () => {
      for (const p of preps) {
        if (p.step.done === box.checked) continue;
        if ((await setStep(p.session.id, p.index, box.checked)).status !== 200) break;
      }
    });
    prepItem = el('div', { class: `look-prep${g.prepped ? ' done' : ''}` },
      el('label', {}, box, el('span', { class: 'st' }, (preps.find((p) => !p.step.done) ?? preps[0]).step.title)),
      !g.prepped && how);
  }
  return el('section', { class: 'steps checks' },
    el('div', { class: 'steps-head' }, icon('eye', 'amber'),
      el('strong', { class: 't' }, LOOK[g.update]?.heading ?? LOOK.none.heading),
      workspaceTag(g),
      el('button', { class: 'steps-done', title: `残りの${left}項目を確かめたことにして、それぞれの作業を完了にする`, onclick: () => finishChecks(g.works) }, icon('check', 's'), '完了にする')),
    prepItem ?? how,
    listed && g.works.filter((w) => w.items.length > 0).map((w) => el('div', { class: 'look-work' },
      el('button', { class: 'quiet src', title: 'この作業を開く', onclick: () => go(`#/s/${w.session.id}`) }, w.session.taskTitle),
      el('ul', {}, w.items.map((it) => {
        const box = el('input', { type: 'checkbox', checked: it.step.done, 'aria-label': it.step.done ? '確かめた' : 'まだ確かめていない' });
        box.addEventListener('change', () => setStep(w.session.id, it.index, box.checked));
        return el('li', { class: it.step.done ? 'done' : '' },
          el('label', {}, box, el('span', { class: 'st' }, it.step.title)),
          it.step.detail && el('div', { class: 'note where' }, icon('pin', 's dim'), it.step.detail));
      })))),
    g.hasPrep && !g.prepped && everyStepToggle(key, left),
    err && el('div', { class: 'err' }, err));
}
export const checksSig = (g) => JSON.stringify([g.update, g.hows, g.commands, g.works.map((w) => [w.session.id, w.session.taskTitle, w.items, w.preps, store.errors.get(w.session.id)]), store.everyStep.has(`look:${g.projectId}`)]);
