import { loadUsage } from '../../logic/actions.js';
import { usableAgents } from '../../logic/ai.js';
import { clock, leftTone, num, until } from '../../logic/format.js';
import { store } from '../../logic/store.js';
import { $, el, put } from '../dom.js';
import { brandMark, icon } from '../icons.js';
import { loginNotice } from '../login-notice.js';
import { go, route } from '../shell.js';
import { PROVIDER } from '../vocabulary.js';

export function usageView() {
  const box = el('div', {});
  const stamp = el('p', { class: 'note' });
  let data = null;
  let timer = null;
  const paint = () => {
    // Only the subscriptions the human uses (設定 → 使うAI).
    put(box, usableAgents().map((p) => {
      const a = store.state.auth[p];
      const u = data?.[p];
      if (!a) return null;
      return el('section', { class: `svc ${p}` },
        brandMark(p),
        el('h2', {}, PROVIDER[p],
          a.loggedIn === false ? el('span', { class: 'red' }, 'ログアウト中') : a.loggedIn ? el('span', { class: 'note' }, `ログイン中${a.plan ? `（${a.plan}）` : ''}`) : el('span', { class: 'note' }, '確認中…')),
        a.loggedIn === false && loginNotice(p),
        !u && el('p', { class: 'note' }, '利用状況を読み込んでいます…'),
        u && (u.limits.length
          ? u.limits.map((l) => {
              // The bar shows what is LEFT, coloured by how much: green, then yellow under 30%, red under 10%.
              const left = l.usedPercent === null ? null : Math.max(0, 100 - l.usedPercent);
              const tone = left !== null ? leftTone(left) : { ok: 'ok', warning: 'warn', reached: 'low' }[l.state] ?? null;
              const word = left === null ? { ok: '上限内', warning: '上限に近い', reached: '上限に到達' }[l.state] ?? '' : `残り ${left}%`;
              const bar = left !== null && el('div', { class: `bar-meter t-${tone}`, role: 'meter', 'aria-valuenow': String(left), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `${l.label}の残り` }, el('i', {}));
              if (bar) bar.firstChild.style.setProperty('width', `${Math.min(100, left)}%`);
              return el('div', { class: 'limit' }, el('div', { class: 'limit-head' }, el('span', {}, l.label), el('b', { class: tone ? `t-${tone}` : '' }, word), el('span', { class: 'note' }, l.resetsAt ? until(l.resetsAt) : '')), bar);
            })
          : el('p', { class: 'note' }, u.limitsError ? `利用枠を取得できませんでした: ${u.limitsError}` : '利用枠の情報はありません。')),
        u && el('div', { class: 'tokens' },
          el('div', {}, el('span', { class: 'note' }, '今日'), el('b', {}, num(u.today.input + u.today.output)), el('span', { class: 'note' }, `入力 ${num(u.today.input)} / 出力 ${num(u.today.output)}・${u.today.turns}回`)),
          el('div', {}, el('span', { class: 'note' }, '直近7日'), el('b', {}, num(u.week.input + u.week.output)), el('span', { class: 'note' }, `入力 ${num(u.week.input)} / 出力 ${num(u.week.output)}・${u.week.turns}回`))));
    }));
  };
  const load = async () => {
    const r = await loadUsage();
    if (r.status === 200) { data = r.body; stamp.textContent = `${clock(Date.now())} 時点`; stamp.title = 'トークン数はこのアプリから動かした作業の合計。利用枠は各サービスの値で、ほかのアプリでの利用も含みます'; }
    paint();
  };
  $('main').replaceChildren(el('div', { class: 'pad' }, el('h1', {}, icon('gauge', 'l'), '利用状況', el('button', { class: 'quiet narrow-only', onclick: () => go('#/') }, icon('back', 's'), '戻る')), box, stamp));
  load();
  timer = setInterval(() => { if (route().view === 'usage') load(); else clearInterval(timer); }, 60000);
  let authSig = '';
  return { key: 'usage', update() { const s2 = JSON.stringify([store.state.auth, usableAgents()]); if (s2 !== authSig) { authSig = s2; paint(); } } };
}
