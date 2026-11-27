// Light / dark: a choice of this screen only (kept in the browser), applied as data-theme on <html>.
// "auto" leaves it to the system's own setting. js/theme-boot.js applies the same choice before the first frame.
const KEY = 'crTheme';
export const THEMES = [
  { value: 'auto', label: '自動' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
];
export function theme() {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.some((x) => x.value === t) ? t : 'auto';
  } catch {
    return 'auto';
  }
}
export function applyTheme(t = theme()) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // In the desktop app, tell the window too, so the window's title bar matches (apps/desktop/preload.cjs). Absent in a browser.
  globalThis.orreryShell?.theme(t);
}
export function setTheme(t) {
  try { localStorage.setItem(KEY, t); } catch {}
  applyTheme(t);
}
