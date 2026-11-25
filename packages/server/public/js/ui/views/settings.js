// Settings: one row per setting — a short name and at most one short line on the left, its control on the right.
import { askShutdown } from '../app-control.js';
import { addProjectFromFolder, loadAppUpdate, loadStorage, prepareVoice, purgeStorage, renameProject, runAppUpdate, setKnowledgeSettings, setProjectApproval, setProjectCapture, setProjectDescription, setProjectPreamble, setProjectWorktree, setSettings, setVoiceSettings } from '../../logic/actions.js';
import { fullStamp } from '../../logic/format.js';
import { knowledgeUsage } from '../../logic/knowledge.js';
import { store } from '../../logic/store.js';
import { aiPicker } from '../ai-picker.js';
import { $, autoGrow, el, sync } from '../dom.js';
import { icon } from '../icons.js';
import { picker } from '../menu.js';
import { editMessage } from '../message-dialog.js';
import { go, route } from '../shell.js';
import { SETTINGS_SECTIONS, sectionAnchor } from '../settings-sections.js';
import { setTheme, theme, THEMES } from '../theme.js';
import { APPROVAL_OPTS, SHORTCUTS } from '../vocabulary.js';

/** A setting: name (and an optional one-line note) at the left, the control at the right. */
const row = (name, note, ...control) => el('div', { class: 'set-row' }, el('div', { class: 'lab' }, el('b', {}, name), note), el('div', { class: 'ctl' }, ...control));
/** A section of the screen; its heading comes from SETTINGS_SECTIONS, the same list the rail shows as a table of contents. */
const group = (id, ...rows) => {
  const sec = SETTINGS_SECTIONS.find((x) => x.id === id);
  return el('section', { class: 'set-group', id: sectionAnchor(id) }, el('h2', {}, icon(sec.icon, 's'), sec.title), ...rows);
};
/**
 * An on/off switch (a checkbox drawn as a toggle). `checked` is its state when first drawn — pass it, so a switch
 * that is on appears on, instead of sliding over from off when the screen opens.
 */
export const toggle = (label, onchange, checked = false) => {
  const t = el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': label });
  t.checked = !!checked;
  t.addEventListener('change', () => onchange(t.checked));
  return t;
};
/** One of a few: buttons side by side, the chosen one raised. */
function segmented(label, options, value, onpick) {
  const box = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const paint = (v) => { for (const b of box.children) b.setAttribute('aria-checked', String(b.dataset.v === v)); };
  for (const o of options) box.append(el('button', { type: 'button', role: 'radio', 'data-v': o.value, onclick: () => { paint(o.value); onpick(o.value); } }, o.label));
  paint(value);
  return box;
}
const caps = (combo) => el('span', { class: 'combo' }, combo.map((k, i) => [i > 0 && el('span', { class: 'plus' }, '+'), el('kbd', { class: 'cap' }, k)]));

/** A project's own default message: the button shows whether one is set, and opens the popup to write it. */
function projectMessageBtn(p) {
  const set = !!p.preamble?.trim();
  const tip = set ? `デフォルトメッセージ: ${p.preamble.trim().slice(0, 120)}` : 'デフォルトメッセージ（未設定）';
  return el('button', { type: 'button', class: 'quiet msg-btn' + (set ? ' on' : ''), title: tip, 'aria-label': `${p.name} のデフォルトメッセージ`, onclick: async () => {
    // Read the latest at the click, not what the row was drawn with.
    const now = store.state.projects.find((x) => x.id === p.id);
    const text = await editMessage({ heading: 'デフォルトメッセージ', title: p.name, value: now?.preamble ?? '', placeholder: 'このプロジェクトの新しい作業で、最初のメッセージの先頭に付ける文章' });
    if (text !== null && text !== (now?.preamble ?? '')) setProjectPreamble(p.id, text);
  } }, icon('message', 's'));
}

/**
 * What a project is, in the human's words: the AI that sends spoken requests to a workspace reads it. The button is
 * lit when one is written (its text in the tooltip), and opens the popup to write it.
 */
function projectDescriptionBtn(p) {
  const text = p.description?.trim() ?? '';
  return el('button', { type: 'button', class: 'quiet msg-btn' + (text ? ' on' : ''), title: text ? `説明: ${text.slice(0, 160)}` : '説明（未設定）', 'aria-label': `${p.name} の説明`, onclick: async () => {
    // Read the latest at the click, not what the row was drawn with.
    const now = store.state.projects.find((x) => x.id === p.id);
    const next = await editMessage({ heading: '説明', title: p.name, value: now?.description ?? '', placeholder: 'このフォルダが何か。音声の依頼をどのワークスペースに振り分けるかの手がかりになります\n例: Unity製の2Dアクションゲーム。敵AIやステージの依頼はここ' });
    if (next !== null && next.trim() !== (now?.description ?? '')) setProjectDescription(p.id, next);
  } }, icon('info', 's'));
}

/** A project's name with a pencil right after it; the pencil turns the name into a text box (Enter / leaving it keeps, Esc cancels). */
function projectName(p) {
  const name = el('b', {}, p.name);
  const pen = el('button', { type: 'button', class: 'quiet ib pen', title: '名前を変える', 'aria-label': `${p.name} の名前を変える` }, icon('pencil', 's'));
  const box = el('span', { class: 'proj-name' }, name, pen);
  pen.addEventListener('click', () => {
    const cur = store.state.projects.find((x) => x.id === p.id)?.name ?? p.name;
    const input = el('input', { type: 'text', class: 'proj-name-input', value: cur, maxlength: '80', 'aria-label': 'プロジェクトの名前' });
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const next = input.value.replace(/\s+/g, ' ').trim();
      box.replaceChildren(name, pen);
      if (keep && next && next !== cur) { name.textContent = next; renameProject(p.id, next); }
      else pen.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    box.replaceChildren(input);
    input.focus();
    input.select();
  });
  return box;
}

export function settingsView() {
  const s = () => store.state.settings;
  const set = (patch) => setSettings(patch);

  // ---- 外観 ----
  const themeSeg = segmented('テーマ', THEMES, theme(), setTheme);

  // ---- 作業 ----
  const n = el('b', { class: 'big' });
  const minus = el('button', { type: 'button', class: 'ib', 'aria-label': '減らす', onclick: () => set({ maxConcurrent: s().maxConcurrent - 1 }) }, icon('minus', 's'));
  const plus = el('button', { type: 'button', class: 'ib', 'aria-label': '増やす', onclick: () => set({ maxConcurrent: s().maxConcurrent + 1 }) }, icon('plus', 's'));
  const queueNote = el('small', {});
  const mem = el('input', { type: 'text', inputmode: 'numeric', class: 'num', 'aria-label': '空きメモリの下限（MB）' });
  mem.addEventListener('change', () => set({ minFreeMemoryMB: Number(mem.value) || 0 }));
  const memNote = el('small', {});
  // Turned off from the confirmation itself (次からは表示しない), back on here.
  const askCmd = toggle('コマンド実行前に確認', (v) => set({ confirmCommands: v }), s().confirmCommands !== false);
  const autoResume = toggle('利用制限後に自動再開', (v) => set({ autoResumeOnLimit: v }), s().autoResumeOnLimit !== false);

  // ---- サイドチャット ----
  // What a new side chat (Ctrl+M) talks to: one agent, one model, one effort. Each chat can switch for itself.
  const chatAi = aiPicker({ value: s().sideChat ?? { provider: 'claude', model: 'sonnet', effort: 'low' }, label: 'サイドチャットの既定のAI', onChange: (c) => set({ sideChat: c }) });

  // ---- 音声入力 ----
  // Holding Space speaks: which AI turns what was said into work, whether the plan waits for a go, and the recogniser's model.
  const VOICE_AI = { provider: 'claude', model: 'haiku', effort: '' };
  const voiceAi = aiPicker({ value: s().voice?.plannerAi ?? VOICE_AI, label: '音声の依頼を振り分けるAI', onChange: (c) => setVoiceSettings({ plannerAi: c }) });
  const voiceConfirm = toggle('始める前に確認', (v) => setVoiceSettings({ confirm: v }), s().voice?.confirm !== false);
  const voiceModel = el('small', {});
  const voiceGet = el('button', { type: 'button', title: '音声認識モデルをダウンロード', 'aria-label': '音声認識モデルをダウンロード', onclick: () => prepareVoice() }, icon('restore', 's'));
  const mbOf = (m) => `${Math.round((m?.bytes ?? 0) / 1048576)} MB`;
  // Which recogniser: each says what it is good at and whether it is on this PC yet. Chosen, it shows at once.
  const recognizerOpts = (list) => (list ?? []).map((m) => ({ value: m.id, label: m.label, sub: `${m.note}${m.note ? '・' : ''}${m.state === 'ready' ? 'ダウンロード済み' : mbOf(m)}` }));
  const recognizerOf = (st) => st.settings.voice?.recognizer || st.voice?.model?.id || '';
  const voiceRecognizer = picker({ ic: 'mic', label: '音声認識モデル', value: recognizerOf(store.state), options: recognizerOpts(store.state.voice?.models), onChange: (v) => setVoiceSettings({ recognizer: v }) });
  const paintVoiceModel = (m) => {
    // Just switched: the server's answer about the new model is still on its way.
    if (m && m.id !== recognizerOf(store.state)) m = store.state.voice?.models?.find((x) => x.id === recognizerOf(store.state)) ?? m;
    voiceModel.textContent = !m ? '' : m.state === 'ready' ? 'このPC内で認識' : m.state === 'downloading' ? `ダウンロード中 ${Math.round(m.progress * 100)}%` : m.state === 'failed' ? m.error : `${mbOf(m)}（初回に自動でダウンロード）`;
    voiceModel.className = m?.state === 'failed' ? 'err' : '';
    voiceGet.hidden = !m || m.state === 'ready' || m.state === 'downloading';
  };
  paintVoiceModel(store.state.voice?.model);
  // The human's own words: names a recogniser cannot know, written back with this spelling. Saved when the box is left.
  const voiceWords = el('textarea', { rows: '3', class: 'voice-words', spellcheck: 'false', placeholder: '例:\nOrrery\ntakanaEditor\nUnity', 'aria-label': '音声入力の用語' });
  voiceWords.value = s().voice?.words ?? '';
  voiceWords.addEventListener('change', () => setVoiceSettings({ words: voiceWords.value }));

  // ---- デフォルトメッセージ ----
  // Standing message: put at the head of the first message of every new session (any project, any agent).
  // Each project can add its own after it (the message button in the project rows).
  const pre = el('textarea', { rows: '4', class: 'preamble', placeholder: '例: 回答は日本語で。変更を加えたらテストを実行してから報告すること。', 'aria-label': 'デフォルトメッセージ' });
  const preSave = el('button', { class: 'primary' }, icon('check', 's'), '保存');
  const preState = el('small', {});
  const saved = () => store.state.settings.preamble ?? '';
  const paintPre = () => {
    const dirty = pre.value !== saved();
    preSave.disabled = !dirty;
    preState.textContent = dirty ? '未保存の変更があります' : '';
  };
  pre.addEventListener('input', paintPre);
  pre.addEventListener('keydown', (e) => { if (e.key === 's' && e.ctrlKey) { e.preventDefault(); preSave.click(); } });
  preSave.addEventListener('click', () => { setSettings({ preamble: pre.value }); paintPre(); });

  // ---- こだわり ----
  // The human's standing preferences: whether they are picked up and sent, and how much is recorded. Edited on their own screen.
  const kset0 = s().knowledge ?? {};
  const captureAi = aiPicker({ value: kset0.captureAi ?? { provider: 'claude', model: 'haiku', effort: '' }, label: '自動読み取りのAI', onChange: (c) => setKnowledgeSettings({ captureAi: c }) });
  const tuneAi = aiPicker({ value: kset0.tuneAi ?? { provider: 'claude', model: 'sonnet', effort: '' }, label: 'AIと整えるのAI', onChange: (c) => setKnowledgeSettings({ tuneAi: c }) });
  const kCapture = toggle('指示からこだわりを記録する', (v) => setKnowledgeSettings({ capture: v }), kset0.capture !== false);
  const kInject = toggle('新しい作業に付ける', (v) => setKnowledgeSettings({ inject: v }), kset0.inject !== false);
  const kNote = el('small', {});
  const kOpen = el('button', { type: 'button', onclick: () => go('#/knowledge') }, icon('bulb', 's'), el('span', {}, '開く'));
  // The こだわり chat: hand over instructions or wishes and have them sorted into preferences (nothing is carried out).
  const kTune = el('button', { type: 'button', onclick: () => go('#/knowledge/tune') }, icon('message', 's'), el('span', {}, '開く'));

  // ---- プロジェクト ----
  const projects = el('div', {});
  const noProjects = el('p', { class: 'note' }, 'まだありません');
  // Adding moves the list forward, so it sits at the right end under the list. A plus under a list needs no words.
  const addProject = el('div', { class: 'stepper end' }, el('button', { type: 'button', class: 'ib', title: 'プロジェクトを追加', 'aria-label': 'プロジェクトを追加', onclick: () => addProjectFromFolder() }, icon('plus', 's')));

  // ---- ショートカット ----
  const keys = el('div', { class: 'keys' }, SHORTCUTS.map((k) => el('div', { class: 'key-row' },
    el('span', { class: 'key-caps' }, k.keys.map((c, i) => [i > 0 && el('span', { class: 'or' }, '/'), caps(c)])),
    el('span', {}, k.word))));

  // ---- 保存データ ----
  const storeInfo = el('small', {}, '…');
  const days = picker({ ic: 'clock', label: '対象', value: '30', options: [{ value: '30', label: '30日より前' }, { value: '7', label: '7日より前' }, { value: '0', label: 'すべて' }] });
  const purgeNote = el('p', { class: 'note' });
  const loadStore = async () => {
    const r = await loadStorage();
    if (r.status === 200) storeInfo.textContent = `${(r.body.bytes / 1048576).toFixed(1)} MB・作業 ${r.body.sessions}件（アーカイブ ${r.body.archivedSessions}）`;
  };
  const purgeBtn = el('button', { type: 'button', class: 'danger', title: 'アーカイブの会話記録とキャッシュを削除します。作業の一覧・履歴は残り、再開もできます', onclick: async () => {
    if (!confirm('アーカイブの会話記録とキャッシュを削除します。元に戻せません。')) return;
    purgeNote.textContent = '';
    const r = await purgeStorage(Number(days.get()));
    purgeNote.textContent = r.status === 200 ? `${r.body.sessions}件・${(r.body.freedBytes / 1048576).toFixed(1)} MB 削除しました` : (r.body.error || '削除できませんでした');
    loadStore();
  } }, icon('trash', 's'), '削除');

  // ---- アプリの更新 (the app lives in the tray and never closes on its own, so new code comes in from here) ----
  const updInfo = el('small', {}, '…');
  const updState = el('p', { class: 'note' });
  const updErr = el('p', { class: 'err', role: 'alert' });
  const updLog = el('pre', { class: 'upd-log', hidden: true });
  const updBtn = el('button', { type: 'button', class: 'primary', title: 'ソースから作り直して開き直します（作っている間も使えます）' }, icon('restore', 's'), el('span', {}, '更新'));
  const restartBtn = el('button', { type: 'button', title: '開き直します。ソースが変わっていれば先に作り直します（作っている間も使えます）' }, icon('power', 's'), '再起動');
  const stopBtn = el('button', { type: 'button', class: 'danger-fill', title: 'アプリ・サーバー・すべてのエージェントを終了します（通知領域にも残りません）', onclick: askShutdown }, icon('power', 's'), '完全に停止');
  const confirmStop = (what) => {
    const c = store.state.counts;
    const busy = c.running + c.waiting + c.queued;
    return !busy || confirm(`動いている作業が${busy}件あります。${what}の間エージェントは止まり、起動後に「中断」として表示されます。続けますか？`);
  };
  const short = (x) => (x ? x.slice(0, 7) : '?');
  const paintUpd = (u) => {
    updErr.textContent = u.error || '';
    updLog.hidden = !(u.phase === 'building' || u.phase === 'failed') || !u.log?.length;
    if (!updLog.hidden) { updLog.textContent = u.log.join('\n'); updLog.scrollTop = updLog.scrollHeight; }
    if (u.mode === 'console') {
      updInfo.textContent = 'コンソール起動のため更新できません';
      updBtn.hidden = restartBtn.hidden = true;
      return;
    }
    if (u.mode === 'dev') {
      updInfo.textContent = '開発用の起動（再起動で反映）';
      updBtn.lastChild.textContent = '再起動して反映';
      restartBtn.hidden = true;
    } else {
      const b = u.build;
      updInfo.textContent = `v${u.version}${b ? `・${new Date(b.builtAt).toLocaleDateString()}・${short(b.commit)}${b.dirty ? '+' : ''}` : ''}`;
    }
    const src = u.source;
    updState.textContent =
      u.phase === 'building' ? `ビルド中（${Math.round((Date.now() - u.startedAt) / 1000)}秒）。終わると自動で再起動します`
      : u.phase === 'restarting' ? '再起動しています…'
      : u.mode === 'dev' ? ''
      : !u.canBuild ? `ソースのフォルダが見つかりません（${u.repo}）`
      : u.upToDate === true ? (u.build?.builtAt ? `last updated at : ${fullStamp(u.build.builtAt)}` : '最新です')
      : u.upToDate === false ? `更新あり: ${short(src?.commit)} ${src?.subject ?? ''}${src?.dirty ? '（+未コミット）' : ''}`
      : '';
    updBtn.disabled = u.phase === 'building' || u.phase === 'restarting' || (u.mode === 'packaged' && !u.canBuild);
    restartBtn.disabled = u.phase === 'building' || u.phase === 'restarting';
    updBtn.classList.toggle('primary', u.upToDate !== true);
  };
  let updTimer = null;
  const loadUpd = async () => {
    clearTimeout(updTimer);
    if (route().view !== 'settings') return;
    const r = await loadAppUpdate();
    if (r.status === 0) {
      updState.textContent = '再起動しています…';
      updTimer = setTimeout(loadUpd, 2000);
      return;
    }
    if (r.status !== 200) return void (updInfo.textContent = r.body.error || '状態を取得できませんでした');
    paintUpd(r.body);
    if (r.body.phase === 'building' || r.body.phase === 'restarting') updTimer = setTimeout(loadUpd, 1500);
  };
  const runUpd = async (kind) => {
    if (!confirmStop(kind === 'update' ? '更新' : '再起動')) return;
    updBtn.disabled = restartBtn.disabled = true;
    updErr.textContent = '';
    updState.textContent = kind === 'update' ? '更新を始めています…' : '再起動しています…';
    const r = await runAppUpdate(kind);
    if (r.status !== 200 && r.status !== 0) {
      updErr.textContent = r.body.error || `できませんでした (${r.status})`;
      updBtn.disabled = restartBtn.disabled = false;
      return;
    }
    loadUpd();
  };
  updBtn.addEventListener('click', () => runUpd('update'));
  restartBtn.addEventListener('click', () => runUpd('restart'));
  loadUpd();
  loadStore();

  $('main').replaceChildren(el('div', { class: 'pad settings' },
    el('h1', {}, icon('gear', 'l'), '設定', el('button', { class: 'quiet narrow-only', onclick: () => go('#/') }, icon('back', 's'), '戻る')),
    group('look',
      row('テーマ', null, themeSeg)),
    group('work',
      row('同時に動かす数', queueNote, el('div', { class: 'stepper' }, minus, n, plus)),
      row('空きメモリの下限', memNote, mem, el('span', { class: 'unit' }, 'MB')),
      row('利用制限後に自動再開', el('small', {}, '制限で止まった作業に、復活予定時刻の1分後に再開を指示します。オフにすると予約も取り消します'), autoResume),
      row('コマンド実行前に確認', null, askCmd)),
    group('side-chat',
      row('既定のAI', el('small', {}, 'Ctrl+M で開くチャットが最初に使うAI'), chatAi.node)),
    group('voice',
      row('振り分けるAI', el('small', {}, '話した内容から、作業・ワークスペース・モデルを決めるAI'), voiceAi.node),
      row('始める前に確認', null, voiceConfirm),
      row('音声認識', voiceModel, voiceRecognizer.node, voiceGet),
      row('用語', el('small', {}, '聞き取りにくい名前や英単語を1行に1つ。カタカナで聞こえてもこの綴りに直します'), voiceWords)),
    group('preamble',
      pre,
      el('div', { class: 'stepper end' }, preState, preSave)),
    group('knowledge',
      row('指示からこだわりを記録する', el('small', {}, '指示や修正から、繰り返し通用しそうなものを自動で記録します'), kCapture),
      row('自動読み取りのAI', null, captureAi.node),
      row('新しい作業に付ける', el('small', {}, '作業に関係する領域のこだわりだけを、最初のメッセージに付けます'), kInject),
      row('記録したこだわり', kNote, kOpen),
      row('AIと整える', el('small', {}, '指示や要望を渡すと、実行はせずに意図を読み取ってこだわりに反映します'), tuneAi.node, kTune)),
    group('projects',
      el('div', { class: 'set-head' }, el('span', {}), el('span', { title: 'このワークスペースが何か。音声の依頼をどのワークスペースに振り分けるかを、AIがこれを見て決めます' }, '説明'), el('span', { title: '新しい作業での承認の任せ方（新しい作業の画面でも切り替えられます）' }, '承認'), el('span', { title: '新しい作業を専用の git worktree で始める（新しい作業の画面でも切り替えられます）' }, 'worktree'), el('span', { title: 'このプロジェクトでの指示から、こだわりを抽出して記録する（全体の設定がオンのときだけ働きます）' }, 'こだわり'), el('span', { title: 'このプロジェクトの新しい作業の最初のメッセージの先頭に付ける文章（全体のデフォルトメッセージの後ろ）' }, 'メッセージ'), el('span', {}, '環境変数')),
      projects, noProjects, addProject),
    group('shortcuts', keys),
    group('storage',
      row('アーカイブの記録', storeInfo, days.node, purgeBtn),
      purgeNote),
    group('update',
      row('バージョン', updInfo, stopBtn, restartBtn, updBtn),
      updState, updErr, updLog)));

  return {
    key: 'settings',
    update() {
      const st = store.state;
      n.textContent = st.settings.maxConcurrent;
      minus.disabled = st.settings.maxConcurrent <= 1;
      plus.disabled = st.settings.maxConcurrent >= 20;
      queueNote.textContent = st.queue.length ? `${st.queue.length}件が順番待ち` : '';
      askCmd.checked = st.settings.confirmCommands !== false;
      autoResume.checked = st.settings.autoResumeOnLimit !== false;
      if (st.settings.sideChat) chatAi.set(st.settings.sideChat);
      voiceAi.set(st.settings.voice?.plannerAi ?? VOICE_AI);
      voiceConfirm.checked = st.settings.voice?.confirm !== false;
      voiceRecognizer.set(recognizerOf(st), recognizerOpts(st.voice?.models));
      paintVoiceModel(st.voice?.model);
      if (document.activeElement !== voiceWords) voiceWords.value = st.settings.voice?.words ?? '';
      if (document.activeElement !== mem) mem.value = st.settings.minFreeMemoryMB;
      // Never overwrite what is being typed; take the stored text only while nothing unsaved is in the box.
      if (pre.dataset.base === undefined || pre.value === pre.dataset.base) { pre.value = saved(); autoGrow(pre); }
      pre.dataset.base = saved();
      paintPre();
      const kset = st.settings.knowledge ?? { capture: true, inject: true };
      kCapture.checked = kset.capture !== false;
      kInject.checked = kset.inject !== false;
      captureAi.set(kset.captureAi ?? { provider: 'claude', model: 'haiku', effort: '' });
      tuneAi.set(kset.tuneAi ?? { provider: 'claude', model: 'sonnet', effort: '' });
      const ku = knowledgeUsage(st);
      if (ku) {
        const unseen = st.knowledge.entries.filter((e) => !e.seen).length;
        kNote.textContent = `${st.knowledge.domains.length}セクション・各5,000字まで添付${unseen ? `・新しく記録 ${unseen}件` : ''}`;
        kNote.className = 'kn-sum';
      }
      memNote.textContent = `いまの空き ${st.queue.freeMemoryMB} MB・0で無効`;
      noProjects.hidden = st.projects.length > 0;
      sync(projects, st.projects, (p) => p.id, (p) => `${p.pending ? 'p' : ''}|${p.name}|${p.envCount}|${p.useWorktree !== false}|${p.approvalMode ?? 'auto'}|${p.captureKnowledge !== false}|${p.preamble ?? ''}|${p.description ?? ''}`, (p) => {
        // Being added: shown at once, but its controls wait for the server's project (they need its id).
        if (p.pending) return el('div', { class: 'set-row proj pending', 'aria-busy': 'true' },
          el('div', { class: 'lab' }, el('b', {}, p.name), el('small', { class: 'path', title: p.rootPath }, p.rootPath)),
          el('div', { class: 'ctl' }, icon('running', 's spin')));
        const wt = toggle(`${p.name} で worktree を使う`, (v) => setProjectWorktree(p.id, v), p.useWorktree !== false);
        const kc = toggle(`${p.name} でこだわりを記録する`, (v) => setProjectCapture(p.id, v), p.captureKnowledge !== false);
        const approval = picker({ ic: 'shield', label: `${p.name} の承認`, value: p.approvalMode ?? 'auto', options: APPROVAL_OPTS, iconOnly: true, onChange: (v) => setProjectApproval(p.id, v) });
        return el('div', { class: 'set-row proj' },
          el('div', { class: 'lab' }, projectName(p), el('small', { class: 'path', title: p.rootPath }, p.rootPath)),
          el('div', { class: 'ctl' }, projectDescriptionBtn(p), approval.node, wt, kc, projectMessageBtn(p),
            el('button', { type: 'button', class: 'quiet env-btn', title: '環境変数', onclick: () => go(`#/env/${p.id}`) }, icon('key', 's'), p.envCount ? String(p.envCount) : '—')));
      });
    },
  };
}
