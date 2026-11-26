import { loadRaw, sendAnswer, submitAnswers } from '../logic/actions.js';
import { ago } from '../logic/format.js';
import { toggleTicket } from '../logic/selectors.js';
import { store } from '../logic/store.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { go, render } from './shell.js';
import { DECISION, kindOf, ptag } from './vocabulary.js';

// Request tickets (shared by the inbox and the session screen).
function questionBody(item) {
  const draft = store.drafts.get(item.id) ?? store.drafts.set(item.id, {}).get(item.id);
  const locked = item.status !== 'pending';
  let n = 0;
  const blocks = item.questions.map((q, qi) => {
    const d = draft[q.id] ?? (draft[q.id] = { picked: new Set(), free: '' });
    return el('div', { class: 'qblock' },
      el('div', { class: 'ask' }, q.text, q.optional && el('span', { class: 'opt-mark' }, '任意')),
      q.options.map((o) => {
        const key = ++n;
        const input = el('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `${item.id}-${qi}`, disabled: locked, 'data-key': key <= 9 ? key : null });
        input.checked = d.picked.has(o.label);
        input.addEventListener('change', () => {
          if (!q.multiSelect) d.picked.clear();
          if (input.checked) d.picked.add(o.label);
          else d.picked.delete(o.label);
        });
        return el('label', { class: 'choice' }, input, el('span', { class: 'lab' }, o.label, o.description && el('small', {}, o.description)), key <= 9 && el('kbd', {}, String(key)));
      }),
      q.multiSelect && el('div', { class: 'note' }, '複数選べます'),
      q.allowFreeText && (() => {
        const t = el('input', { type: q.isSecret ? 'password' : 'text', placeholder: q.options.length ? 'ほかの答えを入力（入力した内容が優先されます）' : '答えを入力', value: d.free, disabled: locked, autocomplete: 'off', 'aria-label': `${q.text} の自由入力` });
        t.addEventListener('input', () => { d.free = t.value; });
        return t;
      })());
  });
  const submit = () => submitAnswers(item);
  // A summary that only repeats the questions below (a reply read as several questions) is not shown again.
  const repeatsQuestions = item.summary === item.questions.map((q) => q.text).join(' / ');
  return [
    !repeatsQuestions && (item.questions.length > 1 || (item.allowDecline && item.summary !== item.questions[0]?.text)) && el('div', { class: 'note' }, item.summary),
    blocks,
    el('div', { class: 'acts' },
      item.allowDecline && el('button', { class: 'danger', disabled: locked, onclick: () => sendAnswer(item, { kind: 'decline' }) }, icon('x', 's'), '答えない'),
      el('span', { class: 'grow' }),
      el('kbd', { class: 'hint', title: 'Ctrl+Enterで送信' }, 'Ctrl+Enter'),
      el('button', { class: 'primary', onclick: submit, disabled: locked, 'data-submit': true }, icon('send', 's'), '回答を送る')),
  ];
}

function approvalBody(item) {
  const a = item.approval;
  const locked = item.status !== 'pending';
  const canExplain = item.source.provider === 'claude';
  const KINDWORD = { add: '新規', delete: '削除', update: '変更' };
  const body = a.changes?.length
    ? el('div', { class: 'diff' }, a.changes.map((c) => [
        el('div', { class: 'file' }, icon('file', 's'), `${KINDWORD[c.kind] ?? c.kind}  ${c.path}`),
        c.diff.split('\n').map((l) => el('div', { class: 'ln ' + (l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '') }, l || ' ')),
      ]))
    : el('div', { class: 'subject' }, el('pre', {}, a.subject ?? '対象の情報がありません。下の「生データ」で確認してください。'));
  // The ticket head already names the kind of request; a headline is added only when it carries new information.
  const fileName = (p) => p.split(/[\\/]/).pop();
  const VERB = { add: 'を新しく作る', delete: 'を削除する', update: 'を書き換える' };
  const headline = a.changes?.length ? a.changes.map((c) => `${fileName(c.path)} ${VERB[c.kind] ?? ''}`).join('、') : null;
  return [
    headline && el('div', { class: 'ask' }, headline),
    body,
    el('div', { class: 'facts' },
      el('span', {}, icon('shield', 's'), el('code', {}, a.tool)),
      a.cwd && el('span', {}, icon('folder', 's'), el('code', {}, a.cwd)),
      a.reason && el('span', {}, icon('info', 's'), a.reason)),
    canExplain && (() => {
      const t = el('input', { type: 'text', class: 'reason', placeholder: '拒否する理由をエージェントに伝える（任意）', disabled: locked, value: store.notes.get(item.id) ?? '' });
      t.addEventListener('input', () => store.notes.set(item.id, t.value));
      return t;
    })(),
    (() => {
      // Refusals at the left, permissions at the right, the plain "allow" at the far right.
      const rank = (d) => ({ danger: 0, '': 1, primary: 2 })[DECISION[d]?.cls ?? ''];
      const btn = (d) => {
        const def = DECISION[d] ?? { word: d, icon: 'shield', cls: '' };
        const message = () => (store.notes.get(item.id) ?? '').trim();
        return el('button', { class: def.cls, disabled: locked, onclick: () => sendAnswer(item, { kind: 'decision', decision: d, ...(message() && d !== 'accept' ? { message: message() } : {}) }) }, icon(def.icon, 's'), def.word);
      };
      const order = [...a.decisions].sort((x, y) => rank(x) - rank(y));
      return el('div', { class: 'acts' }, order.filter((d) => rank(d) === 0).map(btn), el('span', { class: 'grow' }), order.filter((d) => rank(d) > 0).map(btn));
    })(),
  ];
}

export function ticket(item, { linkToSession = true, collapsible = false } = {}) {
  const kind = kindOf(item);
  const isExpanded = !collapsible || store.expanded.has(item.id);
  const toggle = () => {
    toggleTicket(store, item.id);
    render();
    requestAnimationFrame(() => document.querySelector(`[data-item="${item.id}"]`)?.focus());
  };
  const raw = el('pre', {}, '読み込み中…');
  const details = el('details', { class: 'raw' }, el('summary', {}, '生データと発生元'),
    el('div', { class: 'facts' },
      el('span', {}, '要求ID ', el('code', {}, item.source.requestId)),
      el('span', {}, 'セッションID ', el('code', {}, item.source.providerSessionId ?? '-')),
      el('span', {}, '世代 ', el('code', {}, String(item.source.generation)))),
    el('div', { class: 'subject' }, raw));
  details.addEventListener('toggle', async () => {
    if (!details.open || raw.dataset.loaded || !item.rawPayloadRef) return;
    const r = await loadRaw(item.rawPayloadRef);
    raw.textContent = r.status === 200 ? JSON.stringify(r.body, null, 2) : '生データを取得できませんでした';
    raw.dataset.loaded = '1';
  });
  const head = el('div', { class: 'ticket-head' + (collapsible ? ' toggles' : '') },
    collapsible && el('button', { type: 'button', class: 'quiet ib tg', 'aria-expanded': String(isExpanded), title: isExpanded ? '閉じる' : '開いて答える (Enter)', 'aria-label': isExpanded ? '閉じる' : '開く', onclick: toggle }, icon('down', 's')),
    el('span', { class: 'kind' }, icon(kind.icon), item.status === 'answering' ? '送信しましたが、エージェントの受領を確認できていません' : kind.word),
    linkToSession && el('button', { class: 'quiet where', title: 'この作業の画面を開く', onclick: () => go(`#/s/${item.sessionId}`) }, ptag(item.source.provider), item.taskTitle),
    el('span', { class: 'age', title: new Date(item.createdAt).toLocaleString() }, icon('clock', 's'), ago(item.createdAt)));
  if (collapsible) head.addEventListener('click', (e) => { if (!e.target.closest('button')) toggle(); });
  if (!isExpanded) {
    return el('section', { class: `ticket ${item.status} collapsed`, 'data-item': item.id, 'data-collapsed': '1', tabindex: '-1', 'aria-label': `${kind.word}: ${item.summary}（閉じています）` },
      head, el('div', { class: 'ticket-sum', onclick: toggle }, item.type === 'user_question' ? (item.questions.length > 1 ? item.summary : (item.questions[0]?.text ?? item.summary)) : (item.approval?.subject?.split('\n')[0] || item.summary)));
  }
  return el('section', { class: `ticket ${item.status}`, 'data-item': item.id, tabindex: '-1', 'aria-label': `${kind.word}: ${item.summary}` },
    head,
    item.type === 'user_question' ? questionBody(item) : approvalBody(item),
    item.status === 'answering' && el('div', { class: 'note' }, '回答は送信済みです。エージェントが受け取ると自動で消えます。止まっているようなら、作業を開いて状態を確認してください。'),
    store.errors.has(item.id) && el('div', { class: 'err', role: 'alert' }, store.errors.get(item.id)),
    details);
}
export const ticketSig = (i) => `${i.status}|${store.errors.get(i.id) ?? ''}|${Math.floor((Date.now() - i.createdAt) / 60000)}`;
