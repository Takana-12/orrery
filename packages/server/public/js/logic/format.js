// Pure formatting of numbers and times.
export const mb = (b) => `${Math.round(b / 1048576)} MB`;
export const ago = (t) => {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  return s < 60 ? '今' : s < 3600 ? `${Math.floor(s / 60)}分` : s < 86400 ? `${Math.floor(s / 3600)}時間` : `${Math.floor(s / 86400)}日`;
};
export const agoWord = (t) => (ago(t) === '今' ? 'たった今' : `${ago(t)}前`);
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
/** How much of a plan limit is left, as a colour: over 30% ok, over 10% warn, otherwise low. Null when unknown. */
export const leftTone = (left) => (left === null || left === undefined ? null : left > 30 ? 'ok' : left > 10 ? 'warn' : 'low');
export const until = (t) => {
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  return m < 60 ? `あと${m}分でリセット` : m < 1440 ? `あと${Math.round(m / 60)}時間でリセット` : `あと${Math.round(m / 1440)}日でリセット`;
};
/** A moment as "mm/dd hh:mm", always the same shape (used for when usage windows reset). */
export const stamp = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** A moment with its year, "yyyy/mm/dd hh:mm" (when the running app was last built). */
export const fullStamp = (t) => `${new Date(t).getFullYear()}/${stamp(t)}`;
