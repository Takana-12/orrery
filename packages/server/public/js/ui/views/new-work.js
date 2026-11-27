// New work: the box at the foot of the home screen. What to ask, and under it a bar of chips (where, who, which model,
// how much say you keep).
import { pickFolder, registerFolder, startWork } from '../../logic/actions.js';
import { isSendChord, SEND_KEYS } from '../../logic/platform.js';
import { defaultChoice, ensureModels, stillValid, usableAgents, usableChoice } from '../../logic/ai.js';
import { store } from '../../logic/store.js';
import { beginVoice } from '../../logic/voice.js';
import { aiPicker } from '../ai-picker.js';
import { attachments } from '../attachments.js';
import { autoGrow, el, put } from '../dom.js';
import { icon } from '../icons.js';
import { loginNotice } from '../login-notice.js';
import { multiPicker, picker } from '../menu.js';
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
  const start = el('button', { class: 'primary ib', type: 'submit', title: `始める (${SEND_KEYS})`, 'aria-label': '始める' }, icon('send'));

  // Where: any number of workspaces, ticked in the chip's menu — ticking another adds it, ticking one again takes it
  // off. The first ticked is the main one: the agent starts in its folder and its settings (approvals, worktree, the
  // AI last used there) apply; the others are handed to the agent as folders it also works in.
  // A folder picked in Explorer is ticked at once as "path:<folder>", and becomes its project's own entry as soon as
  // the server's project list includes it.
  let picked = []; // [{ path, projectId? }]
  const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const folderOf = (v) => (v.startsWith('path:') ? v.slice(5) : '');
  const nameOf = (v) => store.state.projects.find((p) => p.id === v)?.name ?? (folderOf(v) ? baseName(folderOf(v)) : '');
  const projectOptions = () => [
    ...store.state.projects.map((p) => ({ value: p.id, label: p.name, sub: p.rootPath })),
    ...picked.map((x) => ({ value: `path:${x.path}`, label: baseName(x.path), sub: x.path })),
  ];
  const listed = (v) => store.state.projects.some((p) => p.id === v) || picked.some((x) => `path:${x.path}` === v);
  /** What was used last (main first); older versions remembered only one. */
  const lastUsed = () => {
    try { const a = JSON.parse(remember('crProjects') ?? 'null'); if (Array.isArray(a)) return a; } catch {}
    return [remember('crProject')];
  };
  let chosen = (store.newDraft.workspaces ?? lastUsed()).filter((v) => typeof v === 'string' && listed(v));
  if (!chosen.length && !store.newDraft.workspaces && projects[0]) chosen = [projects[0].id];
  const main = () => chosen[0] ?? '';
  const choose = (list) => {
    const was = main();
    chosen = [...new Set(list)];
    store.newDraft.workspaces = [...chosen];
    project.set(chosen, projectOptions());
    if (main() !== was) {
      store.newDraft.planMode = false; // plan-first is for one request in one workspace
      if (main()) useWorkspaceChoice(main());
    }
    syncForm();
  };
  // "別のフォルダを開く" goes straight to Explorer; a folder chosen there becomes the one workspace, or is ticked alongside
  // the others when Ctrl or Shift was held, as with the items above it.
  const project = multiPicker({
    ic: 'folder', label: 'ワークスペース', value: chosen, options: projectOptions(),
    onChange: (list) => choose(list),
    actions: [{ label: '別のフォルダを開く', icon: 'plus', onpick: (adding) => openFolder(adding) }],
  });
  let picking = false;
  async function openFolder(adding = false) {
    if (picking) return;
    picking = true;
    err.textContent = '';
    const r = await pickFolder();
    picking = false;
    if (r.status !== 200) return void (err.textContent = r.body.error || 'フォルダ選択を開けませんでした');
    const path = r.body.path;
    if (!path) return; // cancelled
    const known = store.state.projects.find((p) => p.rootPath.toLowerCase() === path.toLowerCase());
    const keep = adding ? chosen : [];
    if (known) return choose([...keep, known.id]);
    const again = picked.find((x) => x.path.toLowerCase() === path.toLowerCase());
    if (again) return choose([...keep, `path:${again.path}`]);
    const mine = { path };
    const v = `path:${path}`;
    picked.push(mine);
    choose([...keep, v]);
    const reg = await registerFolder(path);
    if (!picked.includes(mine)) return;
    if (reg.status !== 200) {
      picked = picked.filter((x) => x !== mine);
      err.textContent = reg.body.error || 'フォルダを登録できませんでした';
      return choose(chosen.filter((x) => x !== v));
    }
    mine.projectId = reg.body.projectId;
    refreshProjects();
  }
  /**
   * The server's project list may have changed: list it, swap a picked folder for its project once it is there, and
   * untick a workspace that is gone.
   */
  const refreshProjects = () => {
    for (const x of picked.filter((y) => y.projectId && store.state.projects.some((p) => p.id === y.projectId))) {
      picked = picked.filter((y) => y !== x);
      chosen = chosen.map((v) => (v === `path:${x.path}` ? x.projectId : v));
    }
    const was = main();
    chosen = [...new Set(chosen)].filter(listed);
    if (store.newDraft.workspaces) store.newDraft.workspaces = [...chosen];
    project.set(chosen, projectOptions());
    if (main() !== was && main()) useWorkspaceChoice(main());
  };
  const envCount = el('span', { class: 'v' });
  const envLink = el('button', { type: 'button', class: 'chip', title: 'このプロジェクトの環境変数', 'aria-label': '環境変数' }, icon('key', 's'), envCount);
  envLink.addEventListener('click', () => main() && go(`#/env/${main()}`));

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
      // An agent the human no longer uses (設定 → 使うAI) is not brought back.
      return c && usableAgents().includes(c.provider) ? { provider: c.provider, model: c.model ?? '', effort: c.effort ?? '' } : null;
    } catch { return null; }
  };
  const fromWs = wsChoice(main());
  const firstProv = fromWs?.provider ?? (usableAgents().includes(remember('crProvider')) ? remember('crProvider') : usableAgents()[0]);
  const initial = fromWs ?? savedChoice(firstProv) ?? { provider: firstProv, model: '', effort: '' };
  let shownProv = firstProv;
  const ai = aiPicker({
    value: initial,
    recall: (prov) => stillValid(savedChoice(prov) ?? defaultChoice(prov), prov),
    onChange: (c) => {
      remember(`crChoice:${c.provider}`, JSON.stringify({ model: c.model, effort: c.effort }));
      if (main()) remember(wsKey(main()), JSON.stringify(c));
      if (c.provider === shownProv) return;
      shownProv = c.provider;
      remember('crProvider', c.provider);
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
      }
      syncForm();
    };
    apply(); // at once, then again once the agent's model list is known (stillValid may then correct it)
    ensureModels(c.provider).then(() => { if (main() === v) apply(); });
  }
  const provider = { get: () => ai.get().provider };

  const approvalFor = (prov) => APPROVAL_OPTS.filter((o) => o.value !== 'edits' || prov === 'claude');
  // Approvals: start as the project's own setting (settings screen; a folder not yet a project: the agent's review),
  // can be switched for this one piece of work. A mode this agent does not offer becomes "ask every time".
  const approvalDefault = (prov) => {
    const want = store.state.projects.find((x) => x.id === main())?.approvalMode ?? 'auto';
    return approvalFor(prov).some((o) => o.value === want) ? want : 'ask';
  };
  let apFor = '';
  const approval = picker({
    ic: 'shield', label: '承認', value: approvalDefault(provider.get()), options: approvalFor(provider.get()), iconOnly: true,
    onChange: () => syncForm(),
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
  // Plan first: kept in store.newDraft so it survives a trip to another screen, but never saved per workspace.
  const plan = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(store.newDraft.planMode), title: '先に計画を出させて、承認してから実装させる', 'aria-label': '先に計画を出させる' }, icon('plan', 's'));
  plan.addEventListener('click', () => { store.newDraft.planMode = !store.newDraft.planMode; plan.setAttribute('aria-pressed', String(store.newDraft.planMode)); });

  const syncForm = () => {
    const prov = provider.get();
    const apDefault = approvalDefault(prov);
    if (apFor !== `${main()}|${prov}|${apDefault}`) { apFor = `${main()}|${prov}|${apDefault}`; approval.set(apDefault, approvalFor(prov)); }
    policy.node.hidden = prov !== 'codex' || approval.get() === 'auto';
    const p = store.state.projects.find((x) => x.id === main());
    // Name the workspaces in the box itself, so a request is not typed into the wrong one by mistake.
    const where = chosen.map(nameOf).filter(Boolean).join('・');
    prompt.placeholder = where ? `${where}で何をしますか？` : 'ワークスペースを選びましょう';
    envLink.hidden = !p;
    envCount.textContent = p?.envCount ? String(p.envCount) : '';
    const wtDefault = p?.useWorktree !== false;
    plan.setAttribute('aria-pressed', String(store.newDraft.planMode));
    if (wtFor !== `${main()}|${wtDefault}`) { wtFor = `${main()}|${wtDefault}`; wt.setAttribute('aria-pressed', String(wtDefault)); paintWt(); }
    const out = store.state.auth[prov].loggedIn === false;
    start.disabled = out;
    const sig = `${prov}|${JSON.stringify(store.state.auth[prov])}`;
    if (authSlot.dataset.sig !== sig) { authSlot.dataset.sig = sig; put(authSlot, out && loginNotice(prov)); }
  };
  // Voice input for the hand on the mouse: the same layer that holding Space opens.
  const speak = el('button', { type: 'button', class: 'quiet ib', title: '音声で頼む（Space 長押し）', 'aria-label': '音声で頼む', onclick: () => beginVoice('toggle') }, icon('mic'));
  const card = el('div', { class: 'composer' });
  const att = attachments('new', prompt, card, (m) => { err.textContent = m; });
  card.append(prompt,
    el('div', { class: 'bar one-line' }, att.button, speak, project.node, envLink, ai.node, approval.node, policy.node, plan, wt, el('span', { class: 'grow' }), start));
  const form = el('form', { class: 'new' }, authSlot, err, sentNote, el('div', { class: 'above-box' }, att.tray), el('div', { class: 'dock' }, card));
  prompt.addEventListener('keydown', (e) => { if (isSendChord(e)) { e.preventDefault(); form.requestSubmit(); } });
  // Sending shows at once: the box empties, the work appears in the rail as "送信中", and this screen stays ready for
  // the next request. If it cannot be sent, the text comes back into the box.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (start.disabled) return;
    if (!att.ready()) return void (err.textContent = '添付の保存が終わるまでお待ちください');
    if (!prompt.value.trim()) return void (err.textContent = '頼むことを書いてください');
    if (!chosen.length) return void (err.textContent = 'ワークスペースを選んでください');
    err.textContent = '';
    startWork({
      text: prompt.value,
      suffix: att.suffix(),
      provider: provider.get(),
      model: ai.get().model,
      effort: ai.get().effort,
      approvalMode: approval.get(),
      planMode: store.newDraft.planMode,
      worktree: wt.getAttribute('aria-pressed') === 'true',
      codexPolicy: policy.get(),
      workspaces: [...chosen],
      projectName: chosen.map(nameOf).filter(Boolean).join('・'),
    }, {
      // Shown in the rail from this instant: empty the box and stay ready for the next request.
      onQueued: () => { prompt.value = ''; autoGrow(prompt); att.clear(); plan.setAttribute('aria-pressed', 'false'); },
      afterQueued: () => prompt.focus(),
      onProject: (projectId, extra) => { remember('crProject', projectId); remember('crProjects', JSON.stringify([projectId, ...extra])); },
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
    update() {
      // Words handed over from voice input, to be corrected by hand: they never replace something already written.
      if (store.newDraft.fill !== null) {
        if (!prompt.value.trim()) { prompt.value = store.newDraft.prompt = store.newDraft.fill; autoGrow(prompt); }
        store.newDraft.fill = null;
      }
      // An agent just turned off in 設定 → 使うAI is not left chosen.
      const now = ai.get();
      const ok = usableChoice(now, (prov) => savedChoice(prov) ?? defaultChoice(prov));
      if (ok !== now) { ai.set(ok); shownProv = ok.provider; }
      refreshProjects(); syncForm(); paintSent();
    },
  };
}
