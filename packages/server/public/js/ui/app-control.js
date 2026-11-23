// Stopping or updating the whole app: warn first, then call the logic layer.
import { shutdownApp, startAppUpdate } from '../logic/actions.js';
import { busyCount } from '../logic/selectors.js';
import { store } from '../logic/store.js';
import { confirmDanger } from './confirm-dialog.js';

/** Warn, then stop the app, its server and every agent. */
export async function askShutdown() {
  const busy = busyCount(store.state);
  const ok = await confirmDanger({
    heading: 'Orreryを完全に停止しますか？',
    lines: [
      busy ? `実行中・判断待ち・順番待ちの作業が${busy}件あります。` : null,
      'アプリ・裏で動いているサーバー・すべてのエージェントのプロセスを終了します。通知領域にも残りません。',
      '会話は残ります。次に起動したとき、止めた作業は「中断」として表示され、続きを指示できます。',
    ],
    action: '停止する',
  });
  if (ok) shutdownApp();
}

/** Warn if work is running, then rebuild from source and reopen. */
export async function askUpdate() {
  if (store.updating) return;
  const busy = busyCount(store.state);
  const ok = await confirmDanger({
    heading: 'Orreryを更新しますか？',
    lines: [
      busy ? `実行中・判断待ち・順番待ちの作業が${busy}件あります。` : null,
      'ソースから作り直して開き直します。作っている間も使えますが、開き直す間エージェントは止まります。',
      '止めた作業は、起動後に「中断」として表示され、続きを指示できます。',
    ],
    action: '更新する',
    actionIcon: 'restore',
  });
  if (ok) startAppUpdate();
}
