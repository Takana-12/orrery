// Which screen a location hash means. Pure.
export function parseRoute(hash) {
  const h = hash.replace(/^#\/?/, '');
  if (h.startsWith('s/')) return { view: 'session', id: h.slice(2) };
  // The home screen with the new-work box focused (the inbox and the new-work box are one screen).
  if (h === 'new') return { view: 'inbox', write: true };
  if (h === 'archive') return { view: 'archive' };
  if (h === 'settings') return { view: 'settings' };
  if (h === 'usage') return { view: 'usage' };
  if (h.startsWith('env/')) return { view: 'env', id: h.slice(4) };
  return { view: 'inbox' };
}

/** Identity of the screen: the same key means "update what is there", another key means "build the screen". */
export const routeKey = (r) => (r.view === 'session' ? `s:${r.id}` : r.view === 'env' ? `env:${r.id}` : r.view);
