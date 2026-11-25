// Icons: our own static path data (trusted constants).
const ICON = {
  inbox: 'M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M4 13h4.5a3.5 3.5 0 0 0 7 0H20',
  attention: 'M12 3l9 9-9 9-9-9z M12 8v5 M12 16h.01',
  question: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7 M12 17h.01',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z M9 12l2 2 4-4',
  running: 'M12 3a9 9 0 1 0 9 9',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.5 15.5L20 20',
  done: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.5l2.8 2.8L16 9.5',
  pause: 'M9 5v14 M15 5v14',
  error: 'M12 3l10 17H2z M12 10v4 M12 17h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  stop: 'M6 6h12v12H6z',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  message: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M8 9h8 M8 12h5',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  terminal: 'M4 5h16v14H4z M7.5 9.5l3 2.5-3 2.5 M12.5 15h4',
  file: 'M7 3h7l4 4v14H7z M14 3v4h4 M9.5 13.5h5 M12 11v5',
  chip: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  archive: 'M4 5h16v4H4z M6 9v10h12V9 M10 13h4',
  restore: 'M4 12a8 8 0 1 0 2.5-5.8 M4 4v5h5',
  power: 'M12 4v8 M7 7a7 7 0 1 0 10 0',
  back: 'M14 6l-6 6 6 6',
  next: 'M10 6l6 6-6 6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20a7.5 7.5 0 0 1 15 0',
  agent: 'M6 9h12v9H6z M12 9V5 M12 5h.01 M9.5 13h.01 M14.5 13h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
  plan: 'M8 7h11 M8 12h11 M8 17h11 M4.5 7h.01 M4.5 12h.01 M4.5 17h.01',
  plug: 'M9 3v5 M15 3v5 M7 8h10v3a5 5 0 0 1-10 0z M12 16v5',
  trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13',
  x: 'M6 6l12 12 M18 6L6 18',
  model: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  down: 'M6 10l6 6 6-6',
  sliders: 'M4 7h10 M18 7h2 M4 17h4 M12 17h8 M14 5v4 M8 15v4',
  gear: 'M10.2 5.3L10.4 2.7L13.6 2.7L13.8 5.3L15.5 6.0L17.4 4.3L19.7 6.6L18.0 8.6L18.7 10.2L21.3 10.4L21.3 13.6L18.7 13.8L18.0 15.4L19.7 17.4L17.4 19.7L15.5 18.0L13.8 18.7L13.6 21.3L10.4 21.3L10.2 18.7L8.6 18.0L6.6 19.7L4.3 17.4L6.0 15.4L5.3 13.8L2.7 13.6L2.7 10.4L5.3 10.2L6.0 8.5L4.3 6.6L6.6 4.3L8.5 6.0z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  pencil: 'M4 20l4-1L19 8l-3-3L5 16z M14 7l3 3',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v3',
  fail: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 9l6 6 M15 9l-6 6',
  key: 'M8 15a4 4 0 1 1 3.5-2.1L20 4.5 M16 8l2.5 2.5 M13.5 10.5L16 13',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  minus: 'M5 12h14',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  gauge: 'M4 16a8 8 0 1 1 16 0 M12 16l4-5 M4 16h16',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  login: 'M14 4h5v16h-5 M4 12h10 M10 8l4 4-4 4',
  copy: 'M9 9h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1z M5 15H4.5a.5.5 0 0 1-.5-.5V4.5a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 .5.5V5',
  clip: 'M20 11.5l-7.8 7.8a5 5 0 0 1-7-7l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6',
  claude: 'M12 3v18 M3 12h18 M5.6 5.6l12.8 12.8 M18.4 5.6L5.6 18.4',
  codex: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.5 9.5l3 2.5-3 2.5 M13 14.5h3',
  pr: 'M6 8.5v7 M6 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M18 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M18 15.5V9a3 3 0 0 0-3-3h-3 M14 4l-2 2 2 2',
  branch: 'M7 4v11 M7 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17 9.5c0 4-4 5-10 6.5',
};
export const SVG = 'http://www.w3.org/2000/svg';
export function icon(name, cls = '') {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `i ${cls}`);
  s.setAttribute('aria-hidden', 'true');
  for (const d of ICON[name].split(' M').map((p, i) => (i ? 'M' + p : p))) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
/** A service's mark drawn large and faint behind its section (usage screen). */
export function brandMark(p) {
  const s = document.createElementNS(SVG, 'svg');
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    s.append(n);
  };
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('class', `brand ${p}`);
  s.setAttribute('aria-hidden', 'true');
  if (p === 'claude') {
    // a burst of rays of two lengths, slightly uneven, like the Claude mark
    for (let i = 0; i < 12; i++) {
      const a = ((i * 30 + (i % 3) * 4 - 4) * Math.PI) / 180;
      const r = i % 2 ? 34 : 45;
      add('line', { x1: 50 + Math.cos(a) * 7, y1: 50 + Math.sin(a) * 7, x2: (50 + Math.cos(a) * r).toFixed(1), y2: (50 + Math.sin(a) * r).toFixed(1) });
    }
  } else {
    add('rect', { x: 8, y: 16, width: 84, height: 68, rx: 20 });
    add('path', { d: 'M30 38l14 12-14 12 M52 63h18' });
  }
  return s;
}
/** The orrery: a sun, three orbits and one planet per running piece of work. It only moves while something is running. */
export function orrery(planets, cls = '') {
  const s = document.createElementNS(SVG, 'svg');
  const add = (parent, tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    parent.append(n);
    return n;
  };
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('class', `orrery ${cls}`);
  s.setAttribute('aria-hidden', 'true');
  const R = [17, 30, 43];
  for (const r of R) add(s, 'circle', { cx: 50, cy: 50, r, class: 'orbit' });
  add(s, 'circle', { cx: 50, cy: 50, r: 7, class: 'sun' });
  for (let i = 0; i < Math.min(planets, 6); i++) {
    const turned = add(s, 'g', { transform: `rotate(${(i * 137 + 20) % 360} 50 50)` });
    add(add(turned, 'g', { class: `arm a${i % 3}` }), 'circle', { cx: 50 + R[i % 3], cy: 50, r: [3, 4.2, 3.4][i % 3], class: 'planet' });
  }
  return s;
}
