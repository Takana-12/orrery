// How many orbits the home screen's points are spread over: a choice of this screen only (kept in the browser, like
// the theme). Read when the home screen is drawn, so it is right from the first frame.
import { DEFAULT_RINGS, MAX_RINGS } from '../logic/orbits.js';

const KEY = 'crOrbitRings';

export function orbitRings() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isInteger(v) && v >= 1 && v <= MAX_RINGS ? v : DEFAULT_RINGS;
  } catch {
    return DEFAULT_RINGS;
  }
}
export function setOrbitRings(v) {
  try { localStorage.setItem(KEY, String(v)); } catch {}
}
