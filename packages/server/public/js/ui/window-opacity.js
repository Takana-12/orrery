// How see-through the desktop app's window is: a choice of this screen only (kept in the browser, like the theme),
// handed to the window through apps/desktop/preload.cjs. In a browser there is no window to change, so nothing is offered.
const KEY = 'crWindowClear';
/** Percent of see-through, 0 (solid) .. MAX. Past this the text behind starts to win over the app's own. */
export const MAX_CLEAR = 60;
export const CLEAR_STEP = 5;

/** True when the page runs in the desktop app and can change its window. */
export const canSeeThrough = () => typeof globalThis.orreryShell?.opacity === 'function';

export function windowClear() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) ? Math.min(MAX_CLEAR, Math.max(0, Math.round(v / CLEAR_STEP) * CLEAR_STEP)) : 0;
  } catch {
    return 0;
  }
}
export function applyWindowClear(v = windowClear()) {
  globalThis.orreryShell?.opacity?.(1 - v / 100);
}
export function setWindowClear(v) {
  try { localStorage.setItem(KEY, String(v)); } catch {}
  applyWindowClear(v);
}
