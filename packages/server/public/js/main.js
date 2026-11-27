// Orrery UI entry point. No dependencies, no build step, no inline script/style (strict CSP).
//   logic/  what the app knows and does: server access, client state, derivations, actions. Never touches the DOM.
//   ui/     what it looks like: builds and updates the DOM from the store, and turns clicks into calls on logic/.
// This file only connects the two: it finds the token, mounts the UI, and feeds server snapshots into the store.
import { followState } from './logic/api.js';
import { store } from './logic/store.js';
import { mount } from './ui/app.js';
import { mountRailResize } from './ui/rail-resize.js';
import { banner } from './ui/shell.js';
import { applyTheme } from './ui/theme.js';
import { applyWindowClear } from './ui/window-opacity.js';

applyTheme();
applyWindowClear();

const NO_ACCESS = 'このタブは操作できません。Orreryを起動したときに開いたウィンドウ、または起動時に表示されたURLから開いてください。';

// The token arrives once in the address fragment (never sent to the server), then lives in this tab's session storage.
store.token = sessionStorage.getItem('crToken') || '';
{
  const m = location.hash.match(/token=([\w-]+)/);
  if (m) {
    store.token = m[1];
    sessionStorage.setItem('crToken', store.token);
    history.replaceState(null, '', location.pathname + '#/');
  }
}

mount();
mountRailResize();

if (!store.token) banner(NO_ACCESS);
else {
  followState(
    (snapshot) => store.receive(snapshot),
    (status) => banner(status === 'connected' ? '' : status === 'refused' ? NO_ACCESS : 'Orreryとの接続が切れました。表示は最新でない可能性があります。再接続しています。'),
  );
}
