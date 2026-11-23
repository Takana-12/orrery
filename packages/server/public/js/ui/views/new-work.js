// New work: the box at the foot of the home screen. What to ask, and under it a bar of chips (where, who, which model,
// how much say you keep).
import { pickFolder, registerFolder, startWork } from '../../logic/actions.js';
import { defaultChoice, ensureModels, stillValid } from '../../logic/ai.js';
import { store } from '../../logic/store.js';
import { aiPicker } from '../ai-picker.js';
import { attachments } from '../attachments.js';
import { autoGrow, el, put } from '../dom.js';
import { icon } from '../icons.js';
import { loginNotice } from '../login-notice.js';
import { picker } from '../menu.js';
import { go, route, ui } from '../shell.js';
import { APPROVAL_OPTS } from '../vocabulary.js';

const remember = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

/** One card: what to ask, and under it a bar of chips (where, which AI, how much say you keep). Start is at the right. */
export function newWorkForm() {
  const projects = store.state.projects;
  const prompt = el('textarea', { rows: '3', 'aria-label': '頼むこと' });
  prompt.value = store.newDraft.prompt;
  prompt.addEventListener('input', () => { store.newDraft.prompt = prompt.value; });
  const err = el('div', { class: 'err', role: 'alert' }, store.newDraft.error);
  store.newDraft.error = '';
  const sentNote = el('div', { class: 'sent-note' });
  const authSlot = el('div', {});
  const start = el('button', { class: 'primary ib', type: 'submit', title: '始める (Ctrl+Enter)', 'aria-label': '始める' }, icon('send'));

  // A folder picked in Explorer is listed and chosen at once as "path:<folder>", and becomes its project's own
  // entry as soon as the server's project list includes it.
  let picked = null; // { path, projectId? }
  const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const folderOf = (v) => (v.startsWith('path:') ? v.slice(5) : '');
  const projectOptions = () => [
    ...store.state.projects.map((p) => ({ value: p.id, label: p.name, sub: p.rootPath })),
    ...(picked ? [{ value: `path:${picked.path}`, label: baseName(picked.path), sub: picked.path }] : []),
    { value: '', label: '別のフォルダを開く', short: '別のフォルダ', icon: 'plus', sep: store.state.projects.length > 0 || !!picked },
  ];
  let current = projects.some((p) => p.id === remember('crProject')) ? remember('crProject') : (projects[0]?.id ?? '');
  const choose = (v) => { current = v; project.set(v, projectOptions()); useWorkspaceChoice(v); syncForm(); };
  // "別のフォルダを開く" goes straight to Explorer; until a folder is chosen the chip keeps showing the one it had.
  const project = picker({
    ic: 'folder', label: 'プロジェクト', value: current, options: projectOptions(),
    onChange: (v) => { if (v === '') { project.set(current); openFolder(); } else choose(v); },
  });
  let picking = false;
  async function openFolder() {
    if (picking) return;
    picking = true;
    err.textContent = '';
    const r = await pickFolder();
    picking = false;
    if (r.status !== 200) return void (err.textContent = r.body.error || 'フォルダ選択を開けませんでした');
    const path = r.body.path;
    if (!path) return; // cancelled
    const known = store.state.projects.find((p) => p.rootPath.toLowerCase() === path.toLowerCase());
    if (known) return choose(known.id);
    const mine = { path };
    picked = mine;
    choose(`path:${path}`);
    const reg = await registerFolder(path);
    if (picked !== mine) return;
    if (reg.status !== 200) {
      picked = null;
      err.textContent = reg.body.error || 'フォルダを登録できませんでした';
      return choose(current === `path:${path}` ? (store.state.projects[0]?.id ?? '') : current);
    }
    mine.projectId = reg.body.projectId;
    remember('crProject', mine.projectId);
    refreshProjects();
  }
  /** The server's project list may have changed: list it, and swap a picked folder for its project once it is there. */
  const refreshProjects = () => {
    if (picked?.projectId && store.state.projects.some((p) => p.id === picked.projectId)) {
      const was = `path:${picked.path}`;
      const id = picked.projectId;
      picked = null;
      if (current === was) current = id;
    }
    project.set(current, projectOptions());
  };
  const envCount = el('span', { class: 'v' });
  const envLink = el('button', { type: 'button', class: 'chip', title: 'このプロジェクトの環境変数', 'aria-label': '環境変数' }, icon('key', 's'), envCount);
  envLink.addEventListener('click', () => project.get() && go(`#/env/${project.get()}`));

  // Who answers: one chip for the agent, its model and how hard it thinks (ai-picker.js). Each agent remembers the
  // model last used with it; the first time, it is the agent's recommended model at a middle effort.
  const savedChoice = (prov) => {
    try {
      const c = JSON.parse(remember(`crChoice:${prov}`) ?? 'null');
      return c ? { provider: prov, model: c.model ?? '', effort: c.effort ?? '' } : null;
    } catch { return null; }
  };
  // Each workspace (project) also remembers the agent, model and effort last used in it; choosing it again restores them.
  const wsKey = (v) => (v.startsWith('path:') ? `crChoiceWs:path:${v.slice(5).toLowerCase()}` : `crChoiceWs:${v}`);
  const wsChoice = (v) => {
    if (!v) return null;
    try {
      const c = JSON.parse(remember(wsKey(v)) ?? 'null');
      return c && (c.provider === 'claude' || c.provider === 'codex') ? { provider: c.provider, model: c.model ?? '', effort: c.effort ?? '' } : null;
    } catch { return null; }
  };
  const fromWs = wsChoice(current);
  const firstProv = fromWs?.provider ?? (remember('crProvider') === 'codex' ? 'codex' : 'claude');
  const initial = fromWs ?? savedChoice(firstProv) ?? { provider: firstProv, model: '', effort: '' };
  let shownProv = firstProv;
  const ai = aiPicker({
    value: initial,
    recall: (prov) => stillValid(savedChoice(prov) ?? defaultChoice(prov), prov),
    onChange: (c) => {
      remember(`crChoice:${c.provider}`, JSON.stringify({ model: c.model, effort: c.effort }));
      if (current) remember(wsKey(current), JSON.stringify(c));
      if (c.provider === shownProv) return;
      shownProv = c.provider;
      remember('crProvider', c.provider);
      approval.set(savedApproval(c.provider), approvalFor(c.provider));
      syncForm();
    },
  });
  // Once the agent's models are known: a remembered model it no longer offers (or none yet) becomes its default.
  ensureModels(firstProv).then(() => {
    const now = ai.get();
    if (now.provider !== initial.provider || now.model !== initial.model || now.effort !== initial.effort) return; // changed meanwhile
    ai.set(fromWs || savedChoice(firstProv) ? stillValid(initial, firstProv) : defaultChoice(firstProv));
  });
  /** Switching workspace: bring back the AI last used there (nothing changes for a workspace with none saved). */
  function useWorkspaceChoice(v) {
    const c = wsChoice(v);
    if (!c) return;
    const apply = () => {
      ai.set(stillValid(c, c.provider));
      if (c.provider !== shownProv) {
        shownProv = c.provider;
        remember('crProvider', c.provider);
        approval.set(savedApproval(c.provider), approvalFor(c.provider));
      }
      syncForm();
    };
    apply(); // at once, then again once the agent's model list is known (stillValid may then correct it)
    ensureModels(c.provider).then(() => { if (current === v) apply(); });
  }
  const provider = { get: () => ai.get().provider };

  const approvalFor = (prov) => APPROVAL_OPTS.filter((o) => o.value !== 'edits' || prov === 'claude');
  const savedApproval = (prov) => { const k = remember(`crApproval:${prov}`); return approvalFor(prov).some((o) => o.value === k) ? k : 'ask'; };
  const approval = picker({
    ic: 'shield', label: '承認', value: savedApproval(provider.get()), options: approvalFor(provider.get()), iconOnly: true,
    onChange: (v) => { remember(`crApproval:${provider.get()}`, v); syncForm(); },
  });
  const policy = picker({
    ic: 'eye', label: '確認するタイミング（Codex）', value: '',
    options: [{ value: '', label: 'Codexの設定どおり', short: '既定' }, { value: 'untrusted', label: 'コマンドを毎回確認する', short: '毎回' }, { value: 'on-request', label: '必要なときだけ確認する', short: '必要時' }],
  });
  // Worktree: starts as the project's own setting (settings screen), can be switched for this one piece of work.
  const wt = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true' }, icon('branch', 's'));
  let wtFor = '';
  const paintWt = () => {
    const on = wt.getAttribute('aria-pressed') === 'true';
    wt.title = on ? '専用の git worktree で作業する' : 'プロジェクトのフォルダで直接作業する';
    wt.setAttribute('aria-label', wt.title);
  };
  wt.addEventListener('click', () => { wt.setAttribute('aria-pressed', String(wt.getAttribute('aria-pressed') !== 'true')); paintWt(); });
  const plan = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', title: '先に計画を出させて、承認してから実装させる', 'aria-label': '先に計画を出させる' }, icon('plan', 's'));
  plan.addEventListener('click', () => plan.setAttribute('aria-pressed', String(plan.getAttribute('aria-pressed') !== 'true')));

  const syncForm = () => {
    const prov = provider.get();
    policy.node.hidden = prov !== 'codex' || approval.get() === 'auto';
    const p = store.state.projects.find((x) => x.id === project.get());
    // Name the workspace in the box itself, so a request is not typed into the wrong one by mistake.
    const where = p?.name ?? (folderOf(project.get()) ? baseName(folderOf(project.get())) : '');
    prompt.placeholder = where ? `${where}で何をしますか？` : 'ワークスペースを選びましょう';
    envLink.hidden = !p;
    envCount.textContent = p?.envCount ? String(p.envCount) : '';
    const wtDefault = p?.useWorktree !== false;
    if (wtFor !== `${project.get()}|${wtDefault}`) { wtFor = `${project.get()}|${wtDefault}`; wt.setAttribute('aria-pressed', String(wtDefault)); paintWt(); }
    const out = store.state.auth[prov].loggedIn === false;
    start.disabled = out;
    const sig = `${prov}|${JSON.stringify(store.state.auth[prov])}`;
    if (authSlot.dataset.sig !== sig) { authSlot.dataset.sig = sig; put(authSlot, out && loginNotice(prov)); }
  };
  const card = el('div', { class: 'composer' });
  const att = attachments('new', prompt, card, (m) => { err.textContent = m; });
  card.append(prompt,
    el('div', { class: 'bar one-line' }, att.button, project.node, envLink, ai.node, approval.node, policy.node, plan, wt, el('span', { class: 'grow' }), start));
  const form = el('form', { class: 'new' }, authSlot, err, sentNote, el('div', { class: 'above-box' }, att.tray), el('div', { class: 'dock' }, card));
  prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); form.requestSubmit(); } });
  // Sending shows at once: the box empties, the work appears in the rail as "送信中", and this screen stays ready for
  // the next request. If it cannot be sent, the text comes back into the box.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (start.disabled) return;
    if (!att.ready()) return void (err.textContent = '添付の保存が終わるまでお待ちください');
    if (!prompt.value.trim()) return void (err.textContent = '頼むことを書いてください');
    if (!project.get()) return void (err.textContent = 'フォルダを選んでください');
    err.textContent = '';
    startWork({
      text: prompt.value,
      suffix: att.suffix(),
      provider: provider.get(),
      model: ai.get().model,
      effort: ai.get().effort,
      approvalMode: approval.get(),
      planMode: plan.getAttribute('aria-pressed') === 'true',
      worktree: wt.getAttribute('aria-pressed') === 'true',
      codexPolicy: policy.get(),
      projectId: folderOf(project.get()) ? '' : project.get(),
      folder: folderOf(project.get()),
      projectName: store.state.projects.find((x) => x.id === project.get())?.name ?? folderOf(project.get()).split(/[\\/]/).filter(Boolean).pop() ?? '',
    }, {
      // Shown in the rail from this instant: empty the box and stay ready for the next request.
      onQueued: () => { prompt.value = ''; autoGrow(prompt); att.clear(); plan.setAttribute('aria-pressed', 'false'); },
      afterQueued: () => prompt.focus(),
      onProject: (projectId) => remember('crProject', projectId),
      onFail: (message, text) => {
        // The screen may have been rebuilt since (another screen was opened and closed): use whatever box is there now.
        const box = route().view === 'inbox' ? document.querySelector('form.new textarea') : null;
        if (box) {
          if (!box.value.trim()) { box.value = text; autoGrow(box); }
          const line = document.querySelector('form.new .err');
          if (line) line.textContent = message;
        } else store.newDraft.error = message;
      },
    });
  });
  // Shown for SENT_MS. The title is cut to whatever fits on one line at the current width (CSS ellipsis), so the
  // note never wraps; "を始めました" and "開く" always stay whole.
  const SENT_MS = 5000;
  const paintSent = () => {
    const x = store.newDraft.sent && Date.now() - store.newDraft.sent.at < SENT_MS - 100 ? store.newDraft.sent : null;
    if (sentNote.dataset.id === (x?.id ?? '')) return;
    sentNote.dataset.id = x?.id ?? '';
    put(sentNote, x && [icon('check', 's green'), el('span', { class: 'what' }, '「', el('span', { class: 'cut', title: x.title }, x.title), '」を始めました'), el('button', { type: 'button', class: 'quiet', onclick: () => go(`#/s/${x.id}`) }, '開く')]);
    if (x) setTimeout(() => { if (ui.view?.key === 'inbox') ui.view.update(route()); }, SENT_MS);
  };

  syncForm();
  autoGrow(prompt);
  paintSent();
  return {
    node: form,
    focus() { prompt.focus(); autoGrow(prompt); },
    update() { refreshProjects(); syncForm(); paintSent(); },
  };
}
