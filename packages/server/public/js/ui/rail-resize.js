// The line between the rail and the screen can be dragged left and right, within limits; the width is remembered.
// Double-click (or Home key) puts it back to the default. Arrow keys move it while the line has focus.
const KEY = 'crRailW';
const MIN = 200;
const MAX = 520;
const MIN_MAIN = 320; // the screen on the right always keeps at least this much

const fallback = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || 292;
const limit = (w) => Math.round(Math.max(MIN, Math.min(w, MAX, innerWidth - MIN_MAIN)));

export function mountRailResize() {
  const grip = document.getElementById('rail-grip');
  const app = grip?.parentElement;
  if (!grip || !app) return;
  const base = fallback();
  let want = Number(localStorage.getItem(KEY)) || base;
  const apply = () => {
    const w = limit(want);
    document.documentElement.style.setProperty('--rail-w', `${w}px`); // on the root: the voice layer (outside .app) sits right of it too
    grip.setAttribute('aria-valuenow', String(w));
  };
  const save = () => { try { localStorage.setItem(KEY, String(want)); } catch {} };
  grip.setAttribute('aria-valuemin', String(MIN));
  grip.setAttribute('aria-valuemax', String(MAX));
  apply();
  addEventListener('resize', apply);

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = app.getBoundingClientRect().left;
    const move = (ev) => { want = limit(ev.clientX - left); apply(); };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { want = base; apply(); save(); });
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 10;
    const now = limit(want);
    if (e.key === 'ArrowLeft') want = limit(now - step);
    else if (e.key === 'ArrowRight') want = limit(now + step);
    else if (e.key === 'Home') want = base;
    else return;
    e.preventDefault();
    apply();
    save();
  });
}
