// What every screen shares: where we are, how to go elsewhere, how to ask for a redraw.
import { parseRoute } from '../logic/route.js';
import { store } from '../logic/store.js';
import { $ } from './dom.js';

/** UI-only state: the screen that is built right now, and a one-shot wish to focus the reply box. */
export const ui = {
  /** { key, update(route) } */
  view: null,
  /** Set when a session is opened with Tab, so typing can continue without the mouse. */
  focusComposer: false,
};

export const route = () => parseRoute(location.hash);

/** Redraw now. (The app subscribes to the store; this is the same signal logic uses.) */
export const render = () => store.changed();

export const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

export const banner = (text) => {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
};
