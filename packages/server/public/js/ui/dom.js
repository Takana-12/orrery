// DOM helpers. Everything an agent wrote is appended as TEXT through el(); nothing from an agent is ever parsed as HTML.
export const $ = (id) => document.getElementById(id);
export const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', (e) => busyWhile(n, v(e)));
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  if (tag === 'textarea') growWatch.observe(n);
  return n;
};

/**
 * Feedback rule: a control that started something shows it from the click on, not when the answer comes back.
 * While `work` (a promise) is pending the control is marked busy (a spinner, no second click); nothing else changes.
 */
export function busyWhile(node, work) {
  if (!work || typeof work.then !== 'function') return work;
  node.setAttribute('aria-busy', 'true');
  const done = () => node.removeAttribute('aria-busy');
  work.then(done, done);
  return work;
}

// Text areas grow with what is typed (wrapping at the edge) up to their CSS max-height, then scroll.
export function autoGrow(t) {
  if (!t.isConnected) return;
  const max = parseFloat(getComputedStyle(t).maxHeight) || Infinity;
  t.style.height = 'auto';
  const h = t.scrollHeight + t.offsetHeight - t.clientHeight;
  t.style.height = `${Math.min(h, max)}px`;
  t.style.overflowY = h > max ? 'auto' : 'hidden';
}
// A width change re-wraps the text, so the height is measured again (height changes alone are ignored: we cause those).
// Resize after delivery, on the next frame: changing layout inside ResizeObserver can leave notifications undelivered.
const pendingGrow = new Set();
let growFrame = null;
const growWatch = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    if (target._growW === contentRect.width) continue;
    target._growW = contentRect.width;
    pendingGrow.add(target);
  }
  if (!pendingGrow.size || growFrame !== null) return;
  growFrame = requestAnimationFrame(() => {
    growFrame = null;
    const targets = [...pendingGrow];
    pendingGrow.clear();
    for (const target of targets) autoGrow(target);
  });
});
document.addEventListener('input', (e) => { if (e.target instanceof HTMLTextAreaElement) autoGrow(e.target); });
/** replaceChildren that skips false/null/undefined (so `cond && node` is safe). */
export const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
// ---- keyed list sync: only rows whose signature changed are rebuilt ----------------------------------
export function sync(container, list, key, sig, build) {
  const old = new Map([...container.children].map((n) => [n.dataset.key, n]));
  let prev = null;
  for (const item of list) {
    const k = String(key(item));
    const s = String(sig(item));
    let node = old.get(k);
    if (!node || node.dataset.sig !== s) {
      const hadFocus = node && node.contains(document.activeElement);
      // Where the focus was among the node's controls, so it can go back to the same one (a checkbox, not the first button).
      const FOCUSABLE = '[tabindex],button,input,select,textarea';
      const at = hadFocus ? [...node.querySelectorAll(FOCUSABLE)].indexOf(document.activeElement) : -1;
      const fresh = build(item);
      fresh.dataset.key = k;
      fresh.dataset.sig = s;
      if (node) node.replaceWith(fresh);
      node = fresh;
      if (hadFocus) {
        const target = (at >= 0 && node.querySelectorAll(FOCUSABLE)[at]) || (node.matches('button,[tabindex]') ? node : node.querySelector(FOCUSABLE));
        // preventScroll: moving the focus must not jump the list (e.g. back to the top after ticking a step).
        target?.focus({ preventScroll: true });
      }
    }
    old.delete(k);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (node !== want) container.insertBefore(node, want);
    prev = node;
  }
  for (const n of old.values()) n.remove();
}
