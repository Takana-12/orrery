import { refreshAuth, startLogin } from '../logic/actions.js';
import { store } from '../logic/store.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { PROVIDER } from './vocabulary.js';

/** Shown wherever a signed-out service matters. Signing in happens on the provider's own page; we start it and watch. */
export function loginNotice(p) {
  const a = store.state.auth[p];
  const err = el('span', { class: 'err' });
  const start = async (btn) => {
    btn.disabled = true;
    const r = await startLogin(p);
    if (r.status !== 200) { err.textContent = r.body.error || 'ログインを開始できませんでした'; btn.disabled = false; }
  };
  return el('div', { class: 'auth-alert', role: 'alert' }, icon('login', 'amber'),
    el('div', {},
      el('strong', {}, `${PROVIDER[p]} からログアウトされています`),
      a.loginInProgress
        ? el('div', { class: 'note' }, icon('running', 's spin'), ' ブラウザで開いたページでログインしてください。完了すると自動で反映されます。')
        : el('div', { class: 'note' }, 'ログインするまで、このエージェントの作業は始められません。'),
      el('div', { class: 'acts' },
        el('button', { class: 'primary', onclick: (e) => start(e.currentTarget) }, icon('login', 's'), a.loginInProgress ? 'もう一度開く' : 'ログインする'),
        a.loginInProgress && el('button', { class: 'quiet', onclick: () => refreshAuth(p) }, '確認する'), err)));
}
