import { env } from '../../logic/actions.js';
import { SECRET_STORE } from '../../logic/platform.js';
import { store } from '../../logic/store.js';
import { $, busyWhile, el, put } from '../dom.js';
import { icon } from '../icons.js';
import { go } from '../shell.js';

export function envView(projectId) {
  const project = store.state.projects.find((p) => p.id === projectId);
  if (!project) {
    $('main').replaceChildren(el('div', { class: 'pad' }, el('h1', {}, 'このプロジェクトは見つかりません'), el('button', { onclick: () => go('#/settings') }, icon('back', 's'), '設定に戻る')));
    return { key: `env:${projectId}`, update() {} };
  }
  const list = el('div', {});
  const name = el('input', { type: 'text', placeholder: '変数名（例: DATABASE_URL）', autocomplete: 'off', spellcheck: 'false' });
  const value = el('input', { type: 'password', placeholder: '値', autocomplete: 'new-password' });
  const err = el('div', { class: 'err', role: 'alert' });
  const shown = new Map(); // name -> revealed value (only while this screen is open)
  let vars = [];
  const load = async () => {
    const r = await env.list(projectId);
    if (r.status === 200) vars = r.body.vars;
    paint();
  };
  const paint = () => {
    put(list, vars.length ? vars.map((v) => el('div', { class: 'row env' }, icon('key', 'dim'),
      el('code', {}, v.name),
      el('span', { class: 'env-acts' },
        el('button', { class: 'quiet', onclick: async () => { if (shown.has(v.name)) { shown.delete(v.name); return paint(); } const r = await env.reveal(projectId, v.name); if (r.status === 200) { shown.set(v.name, r.body.value); paint(); } } }, icon('eye', 's'), shown.has(v.name) ? '隠す' : '見る'),
        el('button', { class: 'quiet danger', onclick: async () => { if (!confirm(`${v.name} を削除します。`)) return; await env.delete(projectId, v.name); shown.delete(v.name); load(); } }, icon('trash', 's'), '削除')),
      el('span', { class: 'x' }, shown.has(v.name) ? el('code', {}, shown.get(v.name)) : `${'•'.repeat(Math.min(12, v.length))}（${v.length}文字）`))) : el('p', { class: 'note' }, 'まだ設定されていません。'));
  };
  const form = el('form', { class: 'env-new' }, name, value, el('button', { class: 'primary', type: 'submit' }, icon('plus', 's'), '保存'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await busyWhile(form.querySelector('button[type=submit]'), env.set(projectId, name.value.trim(), value.value));
    if (r.status !== 200) return void (err.textContent = r.body.error || '保存できませんでした');
    err.textContent = '';
    shown.delete(name.value.trim());
    name.value = '';
    value.value = '';
    load();
    name.focus();
  });
  $('main').replaceChildren(el('div', { class: 'pad' },
    el('h1', {}, icon('key', 'l'), `${project.name} の環境変数`, el('button', { class: 'quiet narrow-only', onclick: () => go('#/settings') }, icon('back', 's'), '戻る')),
    el('p', { class: 'note' }, 'このプロジェクトで始める作業のエージェントと、検証コマンドに渡されます。値は' + SECRET_STORE + 'で保存し、会話の記録や画面では変数名に置き換えて表示します。'),
    el('p', { class: 'note' }, '注意: コマンドを実行できるエージェントは、渡された値を読めます。本番用の強い権限の値は入れないでください。次に始める作業から反映されます。'),
    list, el('h2', {}, icon('plus'), '追加・上書き'), form, err));
  load();
  return { key: `env:${projectId}`, update() {} };
}
