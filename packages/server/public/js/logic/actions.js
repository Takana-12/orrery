// Everything the human can do, as functions the UI calls. Each one shows its expected effect at once (see store.js),
// then talks to the server and records the outcome in the store; none touches the DOM.
// Answers are { status, body } (status 200 = done).
import { api, upload } from './api.js';
import { actEffect, answerEffect, loginEffect, manyEffect, messageEffect, projectAddEffect, projectEffect, projectRenameEffect, settingsEffect, stepEffect, stepRunEffect } from './optimistic.js';
import { domainRemoveEffect, domainSetEffect, entryAddEffect, entryRemoveEffect, entryUpdateEffect, knowledgeSeenEffect, knowledgeSettingsEffect, tuneSendEffect } from './knowledge.js';
import { UNCONFIRMED_MS } from './selectors.js';
import { store } from './store.js';

const titleOf = (sessionId) => store.server?.sessions.find((s) => s.id === sessionId)?.taskTitle ?? '作業';

/** Run `call` with `effect` shown from this instant; take the effect back if the server refuses. */
async function withEffect(effect, call) {
  const shown = store.optimistic(effect);
  const r = await call();
  if (r.status === 200) shown.confirm();
  else shown.fail();
  return r;
}

// ---- requests waiting for the human --------------------------------------------------------------------

export async function sendAnswer(item, answer) {
  store.errors.delete(item.id);
  const r = await withEffect(answerEffect(item.id, answer), () => api(`/api/items/${item.id}/answer`, { answer }));
  setTimeout(() => store.changed(), UNCONFIRMED_MS + 300).unref?.(); // if it is still unconfirmed by then, bring it back
  if (r.status !== 200) {
    // The request is back in the inbox with the reason; say so in case the human has already moved on.
    store.errors.set(item.id, r.body.error || `送信できませんでした (${r.status})`);
    store.expanded.add(item.id);
    store.notice(`回答を送れませんでした: ${store.errors.get(item.id)}`);
  }
  store.changed();
  return r;
}

/** Collect the drafted answers of a question ticket. Returns { answers } or { missing: true }. */
export function collectAnswers(item) {
  const draft = store.drafts.get(item.id) ?? {};
  const answers = {};
  for (const q of item.questions) {
    const d = draft[q.id] ?? { picked: new Set(), free: '' };
    const v = d.free.trim() ? [d.free.trim()] : [...d.picked];
    if (!v.length) {
      if (q.optional) continue;
      return { missing: true };
    }
    answers[q.id] = v;
  }
  return { answers };
}

export function submitAnswers(item) {
  const r = collectAnswers(item);
  if (r.missing) {
    store.errors.set(item.id, 'まだ答えていない質問があります');
    return store.changed();
  }
  return sendAnswer(item, { kind: 'answers', answers: r.answers });
}

export const loadRaw = (ref) => api(`/api/raw/${ref}`);

// ---- sessions ---------------------------------------------------------------------------------------------

/** What each action is called when it has to be named in a message. */
const ACTION_WORD = { interrupt: '中断', stop: 'プロセスの終了', cleanup: '残ったプロセスの終了', seen: '既読', archive: '片付け', unarchive: '一覧に戻す操作', check: '検証', accept: '完了', reopen: '作業に戻す操作', rename: '名前の変更', unsend: '取り消し', finish: '完了扱い' };

/** One of: interrupt, stop, cleanup, seen, archive, unarchive, check, accept, reopen, rename, unsend, finish. */
export async function act(sessionId, action, body) {
  store.errors.delete(sessionId);
  const r = await withEffect(actEffect(sessionId, action, body), () => api(`/api/sessions/${sessionId}/${action}`, body ?? {}));
  if (r.status !== 200) {
    store.errors.set(sessionId, r.body.error || `失敗しました (${r.status})`);
    // The human may be on another screen by now (the action looked done): tell them wherever they are.
    store.notice(`「${titleOf(sessionId)}」の${ACTION_WORD[action] ?? action}ができませんでした: ${store.errors.get(sessionId)}`);
  }
  store.changed();
  return r;
}

export const markSeen = (sessionId) => withEffect(actEffect(sessionId, 'seen'), () => api(`/api/sessions/${sessionId}/seen`, {}));

/** The same action on several sessions: all of them change at once on screen, the server is asked one by one. */
async function actOnMany(sessions, action) {
  const shown = store.optimistic(manyEffect(sessions.map((x) => x.id), action));
  let failed = 0;
  for (const x of sessions) if ((await api(`/api/sessions/${x.id}/${action}`, {})).status !== 200) failed++;
  if (failed) {
    shown.fail();
    store.notice(`${failed}件の作業で${ACTION_WORD[action]}ができませんでした`);
  } else shown.confirm();
}
export const markAllSeen = (sessions) => actOnMany(sessions, 'seen');
/** Put several finished sessions away. */
export const archiveAll = (sessions) => actOnMany(sessions, 'archive');
/** Call several finished sessions done (each is put away, and can be brought back). */
export const acceptAll = (sessions) => actOnMany(sessions, 'accept');

let outboxId = 0;
/**
 * Say something to a session. The words show in its conversation at once (store.outbox) and the agent shows as
 * working; they are taken back, with the reason, if they could not be sent.
 */
export async function sendMessage(sessionId, text, { effort = store.composerEfforts.get(sessionId) } = {}) {
  store.composerEfforts.delete(sessionId);
  const mine = { id: ++outboxId, text, at: Date.now() };
  const box = store.outbox.get(sessionId) ?? store.outbox.set(sessionId, []).get(sessionId);
  box.push(mine);
  const r = await withEffect(messageEffect(sessionId, text, effort), () => api(`/api/sessions/${sessionId}/message`, { text, ...(effort === undefined ? {} : { effort }) }));
  const drop = () => {
    const at = box.indexOf(mine);
    if (at >= 0) box.splice(at, 1);
  };
  if (r.status !== 200 || r.body.deferred) drop(); // not sent: it never happened. Held: the "send when finished" box shows it.
  else {
    // Sent: it stays on screen until the conversation record shows it (confirmSent), or a while at most.
    mine.sent = true;
    setTimeout(() => { drop(); store.changed(); }, 60_000).unref?.();
  }
  store.changed();
  return r;
}

/** The conversation record now shows `count` more of the human's messages: drop that many provisional copies. */
export function confirmSent(sessionId, count) {
  const box = store.outbox.get(sessionId);
  if (!box || !count) return;
  for (let n = 0; n < count; n++) {
    const at = box.findIndex((m) => m.sent);
    if (at < 0) break;
    box.splice(at, 1);
  }
  store.changed();
}

export const loadTranscript = (sessionId, range = {}) =>
  api(`/api/sessions/${sessionId}/transcript${range.after !== undefined ? `?after=${range.after}` : range.before !== undefined ? `?before=${range.before}` : ''}`);

/** Tick a step of the human's own to-do list. On failure the tick is taken back and the error recorded. */
export async function setStep(sessionId, index, done) {
  store.errors.delete(sessionId);
  const r = await withEffect(stepEffect(sessionId, index, done), () => api(`/api/sessions/${sessionId}/step`, { index, done }));
  if (r.status !== 200) {
    store.errors.set(sessionId, r.body.error || '更新できませんでした');
    store.notice(`「${titleOf(sessionId)}」を更新できませんでした: ${store.errors.get(sessionId)}`);
  }
  store.changed();
  return r;
}

export const runCommand = (sessionId, command) => api(`/api/sessions/${sessionId}/run`, { command });

/** Whether a command the agent asked for is shown to the human before it runs (they can turn this off from the question itself). */
export const confirmsCommands = () => store.state?.settings?.confirmCommands !== false;

/**
 * Run the command of one of the human's steps. It shows as running at once; the server then reads its output and
 * updates the list (the step is done, or what is still needed takes its place), which arrives with its picture.
 * When that finishes the last step, the work is done (the chat is not archived): said in a notice.
 */
export async function runStep(sessionId, index, command) {
  store.errors.delete(sessionId);
  const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const shown = store.optimistic(stepRunEffect(sessionId, index, command, runId));
  store.changed();
  const r = await api(`/api/sessions/${sessionId}/run`, { command, runId });
  if (r.status === 200) shown.confirm();
  else {
    shown.fail();
    store.errors.set(sessionId, r.body.error || `実行できませんでした (${r.status})`);
    store.notice(`「${titleOf(sessionId)}」のコマンドを実行できませんでした: ${store.errors.get(sessionId)}`);
  }
  if (r.status === 200 && r.body.step?.completed) store.notice(`「${titleOf(sessionId)}」のあなたの作業がすべて済んだので、完了にしました。`, 'good');
  store.changed();
  return r;
}

/** Tell the agent how a command it asked for went. */
export const reportCommand = (sessionId, command, exitCode, output) =>
  sendMessage(sessionId, `頼まれたコマンドを実行しました。\n\n$ ${command}\n終了コード: ${exitCode ?? '不明'}\n出力:\n${output || '（なし）'}`);

// ---- new work ---------------------------------------------------------------------------------------------

/**
 * Start a piece of work. It shows in the rail at once (store.sending); the server is asked afterwards.
 * `draft`: { text, suffix, provider, model, effort, approvalMode, planMode, worktree, codexPolicy, workspaces, projectName }.
 * `workspaces`: where, main one first (project ids, or "path:<folder>" for a folder to register first). Callers with a
 * single one may give `projectId` / `folder` instead.
 * `hooks` let the screen follow along without this function knowing about it:
 *   onQueued()            the work is in the rail: clear the input
 *   afterQueued()         the screen has been redrawn
 *   onProject(projectId, extraProjectIds)  where it went (picked folders have been registered by now)
 *   onFail(message, text) it could not be sent: put the words back
 *   keepDraft             the work did not come from the new-work box (voice): leave what is being written there
 */
export async function startWork(draft, hooks = {}) {
  const body = { provider: draft.provider, prompt: draft.text + draft.suffix, checkCommand: null, autoFix: false, model: draft.model || null, effort: draft.effort || null, approvalMode: draft.approvalMode, planMode: draft.planMode };
  if (typeof draft.worktree === 'boolean') body.worktree = draft.worktree;
  if (draft.provider === 'codex' && draft.codexPolicy && draft.approvalMode !== 'auto') body.codex = { approvalPolicy: draft.codexPolicy };
  const entry = { title: draft.text.trim().replace(/\s+/g, ' ').slice(0, 40), provider: draft.provider, projectName: draft.projectName, sessionId: null, error: null };
  store.sending.push(entry);
  if (!hooks.keepDraft) {
    store.newDraft.prompt = '';
    store.newDraft.planMode = false;
  }
  hooks.onQueued?.();
  store.changed();
  hooks.afterQueued?.();
  const fail = (message) => {
    entry.error = message;
    if (!hooks.keepDraft && !store.newDraft.prompt.trim()) { // give the words back, with the plan-first switch they were sent with
      store.newDraft.prompt = draft.text;
      store.newDraft.planMode = !!draft.planMode;
    }
    hooks.onFail?.(message, draft.text);
    store.changed();
  };
  // The workspaces, main one first: a project id, or "path:<folder>" for a folder picked but not yet registered.
  const wanted = draft.workspaces ?? [draft.projectId || `path:${draft.folder}`];
  const ids = [];
  for (const w of wanted) {
    if (!w.startsWith('path:')) { ids.push(w); continue; }
    const r = await api('/api/projects', { path: w.slice(5) });
    if (r.status !== 200) return fail(r.body.error || 'フォルダを登録できませんでした');
    ids.push(r.body.projectId);
  }
  const [projectId, ...extraProjectIds] = [...new Set(ids)];
  hooks.onProject?.(projectId, extraProjectIds);
  const r = await api('/api/sessions', { ...body, projectId, ...(extraProjectIds.length ? { extraProjectIds } : {}) });
  if (r.status !== 200) return fail(r.body.error || '始められませんでした');
  entry.sessionId = r.body.sessionId;
  // The note under the box cuts the title to the screen width itself, so it gets more than the rail's 40 characters.
  store.newDraft.sent = { id: r.body.sessionId, title: draft.text.trim().replace(/\s+/g, ' ').slice(0, 200), at: Date.now() };
  store.changed();
}

/** Work that the server now lists no longer needs its "sending" placeholder. */
export function dropArrivedSending() {
  const { sending, state } = store;
  for (let i = sending.length - 1; i >= 0; i--) if (sending[i].sessionId && state.sessions.some((x) => x.id === sending[i].sessionId)) sending.splice(i, 1);
}

export function dismissSending(entry) {
  store.sending.splice(store.sending.indexOf(entry), 1);
}

export const loadModels = (provider) => api(`/api/models/${provider}`);
export const pickFolder = () => api('/api/pick-folder', {});
/** Register a folder as a project (a folder already registered gives back its project). Answers { status, body: { projectId } }. */
export const registerFolder = (path) => api('/api/projects', { path });
export const saveAttachment = (name, file) => upload(`/api/attachments?name=${encodeURIComponent(name)}`, file);

// ---- accounts and usage -------------------------------------------------------------------------------------

export const startLogin = (provider) => withEffect(loginEffect(provider), () => api(`/api/auth/${provider}/login`, {}));
export const refreshAuth = (provider) => api(`/api/auth/${provider}/refresh`, {});

/** Read the usage of both services and remember it for the screens that show it. */
export async function loadUsage() {
  const r = await api('/api/usage');
  if (r.status === 200) store.limitsCache = { at: Date.now(), data: r.body };
  return r;
}

// ---- settings, stored data, the app itself ---------------------------------------------------------------------

export async function setSettings(patch) {
  const r = await withEffect(settingsEffect(patch), () => api('/api/settings', patch));
  if (r.status !== 200) store.notice(`設定を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
/** Voice input: the AI that plans the work from what was said, and whether the plan waits for the human's go. */
export async function setVoiceSettings(patch) {
  const r = await withEffect(settingsEffect({ voice: patch }), () => api('/api/settings', { voice: patch }));
  if (r.status !== 200) store.notice(`設定を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
/** Fetch the speech recogniser's model now (it is fetched by itself the first time voice input is used). */
export async function prepareVoice() {
  const r = await api('/api/voice/prepare', {});
  if (r.status !== 200) store.notice(`音声認識モデルを取得できませんでした: ${r.body.error || r.status}`);
  return r;
}
/**
 * Add a workspace from the settings screen: pick a folder in Explorer, show it in the list at once, then register it.
 * A refusal takes the row back and says why. Cancelling the picker does nothing.
 */
export async function addProjectFromFolder() {
  const picked = await pickFolder();
  if (picked.status !== 200) return void store.notice(`フォルダ選択を開けませんでした: ${picked.body.error || picked.status}`);
  const path = picked.body.path;
  if (!path) return;
  const r = await withEffect(projectAddEffect(path), () => registerFolder(path));
  if (r.status !== 200) store.notice(`プロジェクトを追加できませんでした: ${r.body.error || r.status}`);
}
/** A project's display name (the folder stays where it is). */
export async function renameProject(projectId, name) {
  const r = await withEffect(projectRenameEffect(projectId, name), () => api(`/api/projects/${projectId}/rename`, { name }));
  if (r.status !== 200) store.notice(`プロジェクトの名前を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
/** Whether new work in this project gets a git worktree of its own by default. */
export async function setProjectWorktree(projectId, useWorktree) {
  const r = await withEffect(projectEffect(projectId, { useWorktree }), () => api(`/api/projects/${projectId}/options`, { useWorktree }));
  if (r.status !== 200) store.notice(`設定を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
/** Whether standing preferences are picked up from the human's words in this project's work. */
export async function setProjectCapture(projectId, captureKnowledge) {
  const r = await withEffect(projectEffect(projectId, { captureKnowledge }), () => api(`/api/projects/${projectId}/options`, { captureKnowledge }));
  if (r.status !== 200) store.notice(`設定を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
/** How new work in this project handles permission requests unless the new-work screen says otherwise. */
export async function setProjectApproval(projectId, approvalMode) {
  const r = await withEffect(projectEffect(projectId, { approvalMode }), () => api(`/api/projects/${projectId}/options`, { approvalMode }));
  if (r.status !== 200) store.notice(`設定を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
/** What this project is, in the human's words: read by the AI that sends spoken requests to a workspace. */
export async function setProjectDescription(projectId, description) {
  const r = await withEffect(projectEffect(projectId, { description }), () => api(`/api/projects/${projectId}/options`, { description }));
  if (r.status !== 200) store.notice(`説明を保存できませんでした: ${r.body.error || r.status}`);
  return r;
}
/** The message put at the head of the first message of every new piece of work in this project. */
export async function setProjectPreamble(projectId, preamble) {
  const r = await withEffect(projectEffect(projectId, { preamble }), () => api(`/api/projects/${projectId}/options`, { preamble }));
  if (r.status !== 200) store.notice(`設定を変えられませんでした: ${r.body.error || r.status}`);
  return r;
}
// ---- the human's standing preferences (こだわり) -----------------------------------------------------------------

/** Run a change to the preferences with its effect shown at once; taken back, with the reason, if refused. */
async function knowledgeChange(effect, url, body, word) {
  const r = await withEffect(effect, () => api(url, body));
  if (r.status !== 200) store.notice(`${word}できませんでした: ${r.body.error || r.status}`);
  return r;
}
let tempKnowledge = 0;
const tempId = (kind) => `tmp-${kind}-${Date.now().toString(36)}-${++tempKnowledge}`;

/** Preference capture/injection switches and the AI choices for capture and the dedicated chat. */
export function setKnowledgeSettings(patch) {
  const now = store.state?.settings?.knowledge ?? { capture: true, inject: true };
  const knowledge = { ...now, ...patch };
  return knowledgeChange(knowledgeSettingsEffect(patch), '/api/settings', { knowledge }, '設定を変更');
}
export const addKnowledgeEntry = (domainId, text, scope = 'all') => knowledgeChange(entryAddEffect(tempId('entry'), { domainId, text, scope }), '/api/knowledge/entries', { domainId, text, scope }, 'こだわりを追加');
/** Rewrite a preference (an empty text removes it), move it to another area, or change where it holds. */
export const updateKnowledgeEntry = (entryId, patch) => knowledgeChange(entryUpdateEffect(entryId, patch), `/api/knowledge/entries/${entryId}`, patch, 'こだわりを変更');
export const removeKnowledgeEntry = (entryId) => knowledgeChange(entryRemoveEffect(entryId), `/api/knowledge/entries/${entryId}/remove`, {}, 'こだわりを削除');
/** Make an area (`domainId` null) or change one. */
export function setKnowledgeDomain(domainId, patch) {
  const id = domainId ?? tempId('domain');
  return knowledgeChange(domainSetEffect(id, patch), '/api/knowledge/domains', domainId ? { id: domainId, ...patch } : patch, domainId ? '領域を変更' : '領域を追加');
}
/** Remove an area; what was in it goes to その他. */
export const removeKnowledgeDomain = (domainId) => knowledgeChange(domainRemoveEffect(domainId), `/api/knowledge/domains/${domainId}/remove`, {}, '領域を削除');
/** The human has looked at what was recorded by itself: it is no longer news in the inbox. */
export function markKnowledgeSeen() {
  if (!store.state?.knowledge?.entries.some((e) => !e.seen)) return null;
  return withEffect(knowledgeSeenEffect(), () => api('/api/knowledge/seen', {}));
}

/**
 * A message to the こだわり chat: shown at once, read by the server after. Refused: taken back, with the reason, and
 * the answer says so (the screen puts the words back in the box).
 */
export async function sendKnowledgeTune(text) {
  const r = await withEffect(tuneSendEffect(tempId('tune'), text), () => api('/api/knowledge/tune', { text }));
  if (r.status !== 200) store.notice(`送れませんでした: ${r.body.error || r.status}`);
  return r;
}

/** Put text on the clipboard. Answers whether it worked; says so when it did not. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    store.notice('クリップボードにコピーできませんでした');
    return false;
  }
}

export const loadStorage = () => api('/api/storage');
export const purgeStorage = (olderThanDays) => api('/api/storage/purge', { olderThanDays });
export const loadAppUpdate = () => api('/api/app-update');

/**
 * Stop Orrery entirely: the app, its server and every agent it started. The screen says so at once; if the server
 * cannot be asked, that is taken back and the reason shown.
 */
export async function shutdownApp() {
  store.shuttingDown = true;
  store.changed();
  const r = await api('/api/shutdown', {});
  if (r.status !== 200) {
    store.shuttingDown = false;
    store.notice(`停止できませんでした: ${r.body.error || r.status}`);
  }
  return r;
}
export const runAppUpdate = (kind) => api(`/api/app-update/${kind}`, {});

/** Ask GitHub now whether there is a newer version. Shown as checking at once; the answer comes back with the state. */
export async function checkAppUpdate() {
  store.checkingUpdate = true;
  store.changed();
  const r = await runAppUpdate('check');
  store.checkingUpdate = false;
  store.changed();
  if (r.status !== 200) store.notice(`新しい版を確認できませんでした: ${r.body.error || r.status}`);
  else if (r.body.remote?.error) store.notice(`新しい版を確認できませんでした: ${r.body.remote.error}`);
  return r;
}

/** Rebuild from source and reopen. The button shows it at once; if it cannot be started, that is taken back and the reason shown. */
export async function startAppUpdate() {
  store.updating = true;
  store.changed();
  const r = await runAppUpdate('update');
  if (r.status !== 200 && r.status !== 0) {
    store.updating = false;
    store.notice(`更新できませんでした: ${r.body.error || r.status}`);
  } else store.notice('更新を始めました。終わると自動で開き直します');
  return r;
}

export const env = {
  list: (projectId) => api(`/api/projects/${projectId}/env`),
  set: (projectId, name, value) => api(`/api/projects/${projectId}/env/set`, { name, value }),
  delete: (projectId, name) => api(`/api/projects/${projectId}/env/delete`, { name }),
  reveal: (projectId, name) => api(`/api/projects/${projectId}/env/reveal`, { name }),
};

/**
 * Tick every open check of a group. One work at a time, in its own order, so a work's last tick (which finishes it)
 * really is its last request.
 */
export async function finishChecks(works) {
  for (const w of works) {
    for (const i of w.items) {
      if (i.step.done) continue;
      const r = await setStep(w.session.id, i.index, true);
      if (r.status !== 200) break;
    }
  }
}
