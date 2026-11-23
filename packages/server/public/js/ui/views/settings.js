// Settings: one row per setting — a short name and at most one short line on the left, its control on the right.
import { askShutdown } from '../app-control.js';
import { loadAppUpdate, loadStorage, purgeStorage, renameProject, runAppUpdate, setProjectPreamble, setProjectWorktree, setSettings } from '../../logic/actions.js';
import { fullStamp } from '../../logic/format.js';
import { store } from '../../logic/store.js';
import { aiPicker } from '../ai-picker.js';
import { $, autoGrow, el, sync } from '../dom.js';
import { icon } from '../icons.js';
import { picker } from '../menu.js';
import { editMessage } from '../message-dialog.js';
import { go, route } from '../shell.js';
import { setTheme, theme, THEMES } from '../theme.js';
import { SHORTCUTS } from '../vocabulary.js';

/** A setting: name (and an optional one-line note) at the left, the control at the right. */
const row = (name, note, ...control) => el('div', { class: 'set-row' }, el('div', { class: 'lab' }, el('b', {}, name), note), el('div', { class: 'ctl' }, ...control));
const group = (ic, title, ...rows) => el('section', { class: 'set-group' }, el('h2', {}, icon(ic, 's'), title), ...rows);
/** An on/off switch (a checkbox drawn as a toggle). */
export const toggle = (label, onchange) => {
  const t = el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': label });
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
  const askCmd = toggle('コマンド実行前に確認', (v) => set({ confirmCommands: v }));

  // ---- サイドチャット ----
  // What a new side chat (Ctrl+A) talks to: one agent, one model, one effort. Each chat can switch for itself.
  const chatAi = aiPicker({ value: s().sideChat ?? { provider: 'claude', model: 'sonnet', effort: 'low' }, label: 'サイドチャットの既定のAI', onChange: (c) => set({ sideChat: c }) });

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

  // ---- プロジェクト ----
  const projects = el('div', {});
  const noProjects = el('p', { class: 'note' }, 'まだありません');

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
    group('eye', '外観',
      row('テーマ', null, themeSeg)),
    group('running', '作業',
      row('同時に動かす数', queueNote, el('div', { class: 'stepper' }, minus, n, plus)),
      row('空きメモリの下限', memNote, mem, el('span', { class: 'unit' }, 'MB')),
      row('コマンド実行前に確認', null, askCmd)),
    group('message', 'サイドチャット',
      row('既定のAI', el('small', {}, 'Ctrl+A で開くチャットが最初に使うAI'), chatAi.node)),
    group('send', 'デフォルトメッセージ',
      pre,
      el('div', { class: 'stepper end' }, preState, preSave)),
    group('folder', 'プロジェクト',
      el('div', { class: 'set-head' }, el('span', {}), el('span', { title: '新しい作業を専用の git worktree で始める（新しい作業の画面でも切り替えられます）' }, 'worktree'), el('span', { title: 'このプロジェクトの新しい作業の最初のメッセージの先頭に付ける文章（全体のデフォルトメッセージの後ろ）' }, 'メッセージ'), el('span', {}, '環境変数')),
      projects, noProjects),
    group('bolt', 'ショートカット', keys),
    group('archive', '保存データ',
      row('アーカイブの記録', storeInfo, days.node, purgeBtn),
      purgeNote),
    group('restore', 'アプリの更新',
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
      if (st.settings.sideChat) chatAi.set(st.settings.sideChat);
      if (document.activeElement !== mem) mem.value = st.settings.minFreeMemoryMB;
      // Never overwrite what is being typed; take the stored text only while nothing unsaved is in the box.
      if (pre.dataset.base === undefined || pre.value === pre.dataset.base) { pre.value = saved(); autoGrow(pre); }
      pre.dataset.base = saved();
      paintPre();
      memNote.textContent = `いまの空き ${st.queue.freeMemoryMB} MB・0で無効`;
      noProjects.hidden = st.projects.length > 0;
      sync(projects, st.projects, (p) => p.id, (p) => `${p.name}|${p.envCount}|${p.useWorktree !== false}|${p.preamble ?? ''}`, (p) => {
        const wt = toggle(`${p.name} で worktree を使う`, (v) => setProjectWorktree(p.id, v));
        wt.checked = p.useWorktree !== false;
        return el('div', { class: 'set-row proj' },
          el('div', { class: 'lab' }, projectName(p), el('small', { class: 'path', title: p.rootPath }, p.rootPath)),
          el('div', { class: 'ctl' }, wt, projectMessageBtn(p),
            el('button', { type: 'button', class: 'quiet env-btn', title: '環境変数', onclick: () => go(`#/env/${p.id}`) }, icon('key', 's'), p.envCount ? String(p.envCount) : '—')));
      });
    },
  };
}
