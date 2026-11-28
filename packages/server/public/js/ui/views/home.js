// Home: the sphere, and the new-work box under it. Every piece of work still going (logic/orbits.js) is a point of light
// circling the sphere slowly in space (behind it, then in front of it); every thing that waits for the human to decide
// or look at lies still on a wide, shallow arc just above the box. When going work comes to wait for the human, its
// light leaves its orbit and glides down to its place on the arc (and back up when the human sends it on its way).
// Each point has its workspace written faintly under it. A click on a point brings that thing up front in a panel, with
// the same answers and buttons it always had; closing the panel (its button, Esc, or a tap outside) shrinks it back into that point.
// Space and n open home with the box ready to type into; i as it is.
import { arcEntries, arcSpots, assignRings, orbitEntries } from '../../logic/orbits.js';
import { store } from '../../logic/store.js';
import { $, el, sync } from '../dom.js';
import { icon } from '../icons.js';
import { orbitRings } from '../orbit-rings.js';
import { voiceOrb } from '../voice-orb.js';
import { beginVoice, voiceLevel } from '../../logic/voice.js';
import { homeVoiceMode } from '../voice-layer.js';
import { entryNode, entrySig } from './inbox.js';
import { newWorkForm } from './new-work.js';

const TAU = Math.PI * 2;
/** Seconds one turn takes on the innermost orbit, and how much longer each orbit further out takes: slow, to be easy to click. */
const TURN_S = 120;
const TURN_STEP_S = 40;
/** The point's hit area (px): much larger than the point itself. */
const HIT = 56;
/** The room each point on the arc would like (px), and how long a light takes to glide to a new place. */
const ARC_GAP = 76;
const GLIDE_MS = 1400;
/** Under the arc's lowest point: room for the point and its workspace's name (px). */
const ARC_FOOT = 30;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/**
 * Each orbit is a circle in space around the sphere, seen from a little above: `open` is how far it opens towards the
 * eye (the sine of the angle it is seen at), `tilt` how it leans. The far half passes behind the sphere, the near half
 * in front of it, and both breathe a little, so the orrery is never quite still.
 */
const ORBITS = [
  { open: 0.38, tilt: -0.3 },
  { open: 0.29, tilt: 0.24 },
  { open: 0.42, tilt: -0.1 },
  { open: 0.26, tilt: 0.36 },
  { open: 0.34, tilt: -0.22 },
];
/** Kinds that are the human's move (a lit, breathing point), kinds that are a fault (red); the rest are a ring to look at. */
const YOURS = new Set(['ask', 'waiting', 'look', 'steps']);
const FAULT = new Set(['fix', 'problem']);
/** How a kind of thing is named for screen readers and in the point's tooltip. */
const KIND_WORD = { running: '実行中', queued: '順番待ち', ask: '回答待ち', waiting: '操作待ち', look: '確認すること', steps: 'あなたの作業', fix: '検証に失敗', candidate: '完了にできる', problem: '止まっている', finished: '返答が完了', report: '調査の結果', news: '新しいこだわり' };

/** Esc closes the panel of the home screen that is on screen (one listener for every home screen ever drawn). */
let escape = null;
document.addEventListener('keydown', (e) => escape?.(e), true);

/** Resolve a CSS colour to [r, g, b] by letting a canvas parse it. */
function rgbOf(g, css) {
  g.fillStyle = '#000';
  g.fillStyle = css;
  const v = g.fillStyle;
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  return (v.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map(Number);
}
const rgba = ([r, g, b], a) => `rgb(${r} ${g} ${b} / ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export function homeView() {
  const work = newWorkForm();
  const foot = el('div', { class: 's-foot' }, el('div', { class: 'inner' }, work.node));
  // Two skies around the sphere: what is behind it, drawn first, and what is in front of it, drawn over it.
  const back = el('canvas', { class: 'orbit-sky', 'aria-hidden': 'true' });
  const fore = el('canvas', { class: 'orbit-sky', 'aria-hidden': 'true' });
  const gb = back.getContext('2d');
  const gf = fore.getContext('2d');
  const orb = voiceOrb({ orbits: false });
  const dots = el('div', { class: 'orbit-dots', role: 'group', 'aria-label': '実行中の作業と、判断・確認を待っている作業' });
  // The sphere itself is the microphone for the hand on the mouse: tap it and the voice layer opens, as holding Space does.
  // Its hit area is a little larger than the sphere; the points on the orbits stay above it.
  const mic = el('button', { type: 'button', class: 'orbit-mic', title: '音声で頼む（Space 長押し）', 'aria-label': '音声で頼む', onclick: () => beginVoice('toggle') });
  mic.addEventListener('pointerenter', () => orb.hover(true));
  mic.addEventListener('pointerleave', () => orb.hover(false));
  const stage = el('div', { class: 'orbit-stage' }, back, orb.node, fore, mic, dots);
  const front = el('div', { class: 'orbit-front' });
  const screen = el('div', { class: 'session home' }, el('div', { class: 's-body' }, stage), front, foot);
  // The sphere sits in what the box leaves free: keep the foot's height at hand, however tall the box grows.
  const room = new ResizeObserver(() => screen.style.setProperty('--foot-h', `${foot.offsetHeight}px`));
  room.observe(foot);
  $('main').replaceChildren(screen);

  const ringCount = orbitRings();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  /**
   * key → { entry, node, arc (on the arc, not an orbit), ring, a (its place on the orbit, eased), spot (its place on
   * the arc), x, y, z, s, born, goneAt, seed, from ({ x, y, at }: where a glide started; null when not gliding) }
   */
  const points = new Map();
  let ringOf = new Map();
  const phase = Array.from({ length: ringCount }, (_, k) => k * 1.3);
  let W = 0;
  let H = 0;
  let cy = 0; // the sphere's centre: the middle of what the arc leaves free
  let arc = { half: 300, depth: 30, base: 0 }; // the arc: half its width, how much higher its ends are, its lowest y
  let sr = 40; // the sphere's radius on screen
  let focal = 1000; // the eye's distance: what makes the near side larger than the far side
  let geo = []; // per orbit: { R, open, tilt }
  let col = null;
  let paused = false;
  let hover = null;
  let raf = 0;
  let last = 0;
  let clock = 0; // seconds the orrery has been moving
  let open = null; // the panel: { key, node, body }

  const colours = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => rgbOf(gb, css.getPropertyValue(name).trim());
    const bg = v('--bg');
    col = { acc: v('--acc'), red: v('--red'), ink: v('--ink'), dim: v('--ink-2'), bg, dark: bg[0] + bg[1] + bg[2] < 384 };
  };

  // ---- geometry: the arc along the bottom, the sphere in the middle of what is left, the orbits out to its edges ----
  const layout = () => {
    W = stage.clientWidth;
    H = stage.clientHeight;
    const half = Math.max(80, Math.min(W / 2 - 40, 420));
    const depth = Math.max(18, Math.min(44, half * 0.1));
    arc = { half, depth, base: H - ARC_FOOT };
    const top = H - ARC_FOOT - depth - 34; // what the arc leaves free above it
    cy = top / 2;
    stage.style.setProperty('--cy', `${cy.toFixed(0)}px`);
    const orbPx = Math.round(Math.max(150, Math.min(360, Math.min(W, top) * 0.6)));
    orb.node.style.setProperty('--orb', `${orbPx}px`);
    sr = (orbPx * 58) / 420; // voice-orb.js draws the sphere at 58 of 420
    stage.style.setProperty('--sr', `${sr}px`);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [c, g] of [[back, gb], [fore, gf]]) {
      c.width = Math.max(1, Math.round(W * dpr));
      c.height = Math.max(1, Math.round(H * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const minR = sr * 2.6;
    geo = Array.from({ length: ringCount }, (_, k) => {
      const o = ORBITS[k];
      // As large as the space allows, with its lean and the near side's perspective counted in.
      const reachY = Math.abs(Math.sin(o.tilt)) + o.open * Math.cos(o.tilt) + 0.06;
      const maxR = Math.max(minR, Math.min((W / 2 - 44) / 1.14, (top / 2 - 24) / (reachY * 1.14)));
      const t = ringCount === 1 ? 0.45 : k / (ringCount - 1);
      return { R: minR + (maxR - minR) * t, ...o };
    });
    focal = Math.max(...geo.map((g) => g.R)) * 4;
    if (!col) colours();
    placeArc(false);
    frame(0);
  };
  new ResizeObserver(layout).observe(stage);

  /** Where angle `th` on orbit `k` is on screen: x, y, z (> 0: in front of the sphere), s (nearer = larger). */
  const at = (k, th) => {
    const g = geo[k];
    const still = reduced.matches;
    const tl = g.tilt + (still ? 0 : 0.035 * Math.sin(clock * 0.23 + k * 1.9));
    const op = g.open + (still ? 0 : 0.025 * Math.sin(clock * 0.17 + k * 1.3));
    const lx = Math.cos(th) * g.R;
    const ly = Math.sin(th) * g.R;
    const y0 = ly * op;
    const z = ly * Math.sqrt(1 - op * op);
    const s = focal / (focal - z);
    return { x: W / 2 + (lx * Math.cos(tl) - y0 * Math.sin(tl)) * s, y: cy + (lx * Math.sin(tl) + y0 * Math.cos(tl)) * s, z, s };
  };
  /** 0 at the far side of an orbit, 1 at the near side. */
  const nearness = (k, z) => (z / geo[k].R + 1) / 2;
  /** How near a point is: on the arc it is in front of everything. */
  const nearOf = (p) => (p.arc ? 1 : Math.max(0, Math.min(1, nearness(p.ring, p.z))));
  /** Where a place on the arc is on screen. */
  const arcAt = (spot) => ({ x: W / 2 + spot.dx, y: arc.base - spot.rise });
  /**
   * Give every point on the arc its place, from left to right in the order they were put in `points` (most pressing
   * first). A point whose place moved glides there from where it is, unless `glide` is false (the screen was resized:
   * everything is simply where it belongs).
   */
  const placeArc = (glide) => {
    const list = [...points.values()].filter((p) => p.arc && !p.goneAt);
    const spots = arcSpots(list.length, { half: arc.half, depth: arc.depth, gap: ARC_GAP });
    const step = list.length > 1 ? spots[1].dx - spots[0].dx : ARC_GAP;
    dots.style.setProperty('--arc-w', `${Math.max(44, Math.round(step - 8))}px`);
    const now = performance.now();
    list.forEach((p, j) => {
      const was = p.spot;
      p.spot = spots[j];
      if (!glide || reduced.matches) { if (!glide && was) p.from = null; return; }
      if (was && !p.from && Math.hypot(was.dx - p.spot.dx, was.rise - p.spot.rise) > 0.5) p.from = { x: p.x, y: p.y, at: now };
    });
  };
  /** A short straight piece of an orbit or a trail, on the sky it belongs to (behind or in front of the sphere). */
  const piece = (a, b, colour, width) => {
    const g = (a.z + b.z) / 2 >= 0 ? gf : gb;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.strokeStyle = colour;
    g.lineWidth = width;
    g.stroke();
  };
  /** The faint line the arc's points lie on: clearest in the middle, gone before it reaches its ends. */
  const drawArc = () => {
    const N = 64;
    const reach = 1.08;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 2 - 1;
      const cur = { x: W / 2 + u * reach * arc.half, y: arc.base - arc.depth * (u * reach) ** 2, z: 1 };
      if (prev) piece(prev, cur, rgba(col.dim, 0.24 * (1 - u * u)), 0.8);
      prev = cur;
    }
  };

  // ---- drawing: the orbits, the light each point leaves behind it, the arc, and the points ----
  const draw = (now) => {
    for (const g of [gb, gf]) { g.clearRect(0, 0, W, H); g.lineCap = 'round'; }
    if (!geo.length || !col) return;
    const all = [...points.values()];
    const used = new Set(all.filter((p) => !p.goneAt && !p.arc).map((p) => p.ring));
    // the orbits: a hairline, brighter and a little thicker on the near side
    for (let k = 0; k < ringCount; k++) {
      if (!used.has(k)) continue;
      const N = 144;
      let prev = at(k, 0);
      for (let i = 1; i <= N; i++) {
        const cur = at(k, (i / N) * TAU);
        const near = nearness(k, (prev.z + cur.z) / 2);
        piece(prev, cur, rgba(col.dim, 0.08 + 0.34 * near), 0.6 + 0.7 * near);
        prev = cur;
      }
    }
    if (all.some((p) => p.arc && !p.goneAt)) drawArc();
    // farthest first, so a near point is drawn over a far one; the arc's points over everything
    for (const p of all.sort((a, b) => (a.arc ? 1e9 : a.z) - (b.arc ? 1e9 : b.z))) {
      const life = Math.min(1, (now - p.born) / 600) * (p.goneAt ? Math.max(0, 1 - (now - p.goneAt) / 700) : 1);
      if (life <= 0) continue;
      const kind = p.entry.kind;
      // Work going is a plain light in the ink's colour (a ring while it waits its turn); on the arc the human's own
      // moves are lit and breathe, faults are red, and the rest are a ring to look at.
      const going = kind === 'running';
      const lit = going || YOURS.has(kind) || FAULT.has(kind);
      const c = FAULT.has(kind) ? col.red : going ? col.ink : lit ? col.acc : col.dim;
      const light = life * (0.4 + 0.6 * nearOf(p));
      if (!p.arc) {
        // the trail: light left along the orbit, thinning and fading behind the point (growing in as a light rises from the arc)
        const th = phase[p.ring] + p.a;
        const grown = p.from ? ease(Math.min(1, (now - p.from.at) / GLIDE_MS)) ** 3 : 1;
        const STEPS = 22;
        const span = 0.46 - p.ring * 0.04;
        let prev = at(p.ring, th);
        for (let i = 1; i <= STEPS; i++) {
          const cur = at(p.ring, th - (i / STEPS) * span);
          const fade = 1 - i / STEPS;
          piece(prev, cur, rgba(c, (lit ? 0.5 : 0.35) * fade * fade * light * grown), 2.8 * fade * cur.s + 0.3);
          prev = cur;
        }
      }
      const g = p.arc || p.z >= 0 ? gf : gb;
      const big = (hover === p.entry.key || open?.key === p.entry.key ? 1.4 : 1) * p.s * (0.8 + 0.3 * nearOf(p));
      // the glow: the human's own moves breathe, each at its own pace
      const breathe = lit && !going ? 0.7 + 0.3 * Math.sin(clock * 2.1 + p.seed) : 0.6;
      const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 18 * big);
      glow.addColorStop(0, rgba(c, (col.dark ? 0.45 : 0.32) * breathe * light));
      glow.addColorStop(1, rgba(c, 0));
      g.fillStyle = glow;
      g.beginPath();
      g.arc(p.x, p.y, 18 * big, 0, TAU);
      g.fill();
      g.beginPath();
      g.arc(p.x, p.y, 5.5 * big, 0, TAU);
      if (lit) {
        // a small sphere of light, lit from the upper left like the big one
        const core = g.createRadialGradient(p.x - 1.6 * big, p.y - 1.6 * big, 0, p.x, p.y, 5.5 * big);
        core.addColorStop(0, rgba([255, 255, 255], 0.9 * light));
        core.addColorStop(0.5, rgba(c, light));
        core.addColorStop(1, rgba(c, 0.85 * light));
        g.fillStyle = core;
        g.fill();
      } else {
        g.fillStyle = rgba(col.bg, light);
        g.fill();
        g.strokeStyle = rgba(p.entry.s?.unread ? col.ink : c, light);
        g.lineWidth = 1.8 * big;
        g.stroke();
      }
    }
  };

  // ---- motion: every orbit turns slowly; each point glides to its own place when others come or go ----
  const frame = (dt) => {
    if (!geo.length) return;
    if (!reduced.matches) clock += dt;
    if (!paused && !reduced.matches) for (let k = 0; k < ringCount; k++) phase[k] += (dt * TAU) / (TURN_S + TURN_STEP_S * k);
    const byRing = geo.map(() => []);
    for (const p of points.values()) if (!p.goneAt && !p.arc) byRing[p.ring].push(p);
    byRing.forEach((list) => list.forEach((p, j) => {
      const target = (j / list.length) * TAU;
      let d = (target - p.a) % TAU;
      if (d > Math.PI) d -= TAU;
      if (d < -Math.PI) d += TAU;
      p.a = reduced.matches ? target : p.a + d * Math.min(1, dt * 1.6);
    }));
    const now = performance.now();
    for (const p of points.values()) {
      const live = p.arc ? { ...arcAt(p.spot ?? { dx: 0, rise: 0 }), z: 0, s: 1 } : at(p.ring, phase[p.ring] + p.a);
      if (p.from) {
        // gliding: from where it was (an orbit, the arc, or another place on the arc) to where it now belongs
        const t = reduced.matches ? 1 : Math.min(1, (now - p.from.at) / GLIDE_MS);
        const e = ease(t);
        live.x = p.from.x + (live.x - p.from.x) * e;
        live.y = p.from.y + (live.y - p.from.y) * e;
        if (t >= 1) p.from = null;
      }
      Object.assign(p, live);
      const near = nearOf(p);
      // Behind the sphere a point is hidden by it: its name is not written over the sphere.
      const hidden = !p.arc && p.z < 0 && Math.hypot(p.x - W / 2, p.y - cy) < sr * 1.05;
      p.node.style.transform = `translate(${(p.x - HIT / 2).toFixed(1)}px, ${(p.y - HIT / 2).toFixed(1)}px)`;
      p.node.style.zIndex = String(p.arc ? 200 : Math.round(near * 100));
      p.node.style.setProperty('--near', near.toFixed(2));
      p.node.classList.toggle('behind', hidden);
    }
    draw(now);
  };
  const loop = (now) => {
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
    last = now;
    frame(dt);
    raf = screen.isConnected && !reduced.matches ? requestAnimationFrame(loop) : 0;
  };
  const wake = () => { if (!raf && screen.isConnected) { last = 0; raf = requestAnimationFrame(loop); } };

  // ---- the panel: one thing up front; switching to another point lets the first one dissolve ----
  const dissolve = (node) => {
    if (reduced.matches) return node.remove();
    node.classList.add('leaving');
    node.setAttribute('aria-hidden', 'true');
    node.inert = true;
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 900); // a hidden window does not run animations: it must not keep the panel
  };
  const close = () => {
    if (!open) return;
    const was = open;
    open = null;
    dissolve(was.node);
    points.get(was.key)?.node.setAttribute('aria-expanded', 'false');
    if (was.node.contains(document.activeElement)) document.activeElement.blur();
  };
  const show = (key) => {
    const p = points.get(key);
    if (!p || p.goneAt) return;
    if (open?.key === key) return;
    close();
    const body = el('div', { class: 'op-body' });
    const node = el('section', { class: 'orbit-panel', role: 'dialog', 'aria-label': `${KIND_WORD[p.entry.kind]}: ${p.entry.title}`, tabindex: '-1' },
      el('div', { class: 'op-head' },
        el('button', { type: 'button', class: 'quiet ib', title: '閉じる (Esc)', 'aria-label': '閉じる', onclick: close }, icon('x', 's')),
        // A request does not say which workspace it is from by itself; the rows do.
        p.entry.kind === 'ask' && p.entry.workspace && el('span', { class: 'ws' }, icon('folder', 's'), p.entry.workspace)),
      body);
    front.append(node);
    // Grow out of the point that was clicked.
    const box = node.getBoundingClientRect();
    const dot = p.node.getBoundingClientRect();
    node.style.transformOrigin = `${(dot.left + dot.width / 2 - box.left).toFixed(0)}px ${(dot.top + dot.height / 2 - box.top).toFixed(0)}px`;
    open = { key, node, body };
    p.node.setAttribute('aria-expanded', 'true');
    fillPanel();
    requestAnimationFrame(() => (node.querySelector('[data-item], [data-autofocus]') ?? node).focus());
  };
  const fillPanel = () => {
    const p = open && points.get(open.key);
    if (!p || p.goneAt) return close(); // answered, finished, put away: nothing is left to show
    sync(open.body, [p.entry], (e) => e.key, entrySig, entryNode);
  };
  escape = (e) => {
    if (!screen.isConnected) return void (escape = null);
    if (e.key !== 'Escape' || !open || document.querySelector('.menu') || document.body.dataset.voice !== undefined) return;
    // In the new-work box, Esc only leaves the box (app.js); everywhere else it closes the panel.
    const a = document.activeElement;
    if (a && a !== document.body && !open.node.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  // A tap anywhere outside the panel closes it, as Esc and its × do. A tap on a point is not "outside": that point
  // shows itself instead (show), or stays shown if it is the one already open. Menus and dialogs live outside this screen.
  screen.addEventListener('pointerdown', (e) => {
    if (!open || e.button > 0) return;
    const t = e.target;
    if (!(t instanceof Element) || open.node.contains(t) || t.closest('.o-dot')) return;
    close();
  }, true);

  // ---- the points: an invisible, large hit area over each light, with its workspace's name ----
  const pointNode = (entry) => {
    const node = el('button', { type: 'button', class: 'o-dot', 'data-kind': entry.kind, 'aria-expanded': 'false', onclick: () => show(entry.key) },
      el('span', { class: 'ws' }));
    node.addEventListener('pointerenter', () => { paused = true; hover = entry.key; });
    node.addEventListener('pointerleave', () => { paused = false; hover = null; });
    node.addEventListener('focus', () => { paused = true; });
    node.addEventListener('blur', () => { paused = false; });
    return node;
  };
  const label = (p) => {
    const e = p.entry;
    const words = `${KIND_WORD[e.kind]}: ${e.title}${e.workspace && e.kind !== 'look' ? `（${e.workspace}）` : ''}`;
    if (p.node.title !== words) { p.node.title = words; p.node.setAttribute('aria-label', words); }
    const ws = p.node.lastChild;
    if (ws.textContent !== e.workspace) ws.textContent = e.workspace;
    p.node.dataset.kind = e.kind;
    p.node.classList.toggle('arc', p.arc);
  };
  /**
   * A new point. If the same work's light is going away this moment (it was going and now waits, or the other way
   * round), that light does not fade: it moves, and the new point starts where it was and glides on from there.
   */
  const born = (entry, onArc, leaving) => {
    const p = { entry, node: pointNode(entry), arc: onArc, ring: onArc ? 0 : ringOf.get(entry.key), a: 0, spot: null, fresh: true, x: 0, y: 0, z: 0, s: 1, born: reduced.matches ? -1e9 : performance.now(), goneAt: 0, seed: Math.random() * TAU, from: null };
    const was = entry.sid && leaving.get(entry.sid);
    if (was) {
      leaving.delete(entry.sid);
      was.node.remove();
      if (points.get(was.entry.key) === was) points.delete(was.entry.key);
      Object.assign(p, { born: -1e9, x: was.x, y: was.y, z: was.z, s: was.s, from: reduced.matches ? null : { x: was.x, y: was.y, at: performance.now() } });
    }
    return p;
  };

  return {
    key: 'inbox',
    update(r) {
      work.update();
      const going = orbitEntries(store.state);
      const waiting = arcEntries(store.state);
      ringOf = assignRings(ringOf, going.map((e) => e.key), ringCount);
      const now = new Set([...going, ...waiting].map((e) => e.key));
      /** session id → its point that goes away this moment */
      const leaving = new Map();
      for (const [key, p] of points) {
        if (now.has(key) || p.goneAt) continue;
        // The light fades out where it is (draw); its button goes at once.
        p.goneAt = performance.now();
        p.node.disabled = true;
        if (p.entry.sid) leaving.set(p.entry.sid, p);
        setTimeout(() => { p.node.remove(); if (points.get(key) === p) points.delete(key); }, reduced.matches ? 0 : 700);
      }
      const onArc = [];
      for (const [entries, arcSide] of [[going, false], [waiting, true]]) {
        for (const entry of entries) {
          let p = points.get(entry.key);
          if (!p || p.goneAt) {
            p?.node.remove();
            p = born(entry, arcSide, leaving);
            points.set(entry.key, p);
            dots.append(p.node);
          }
          p.entry = entry;
          if (arcSide) onArc.push(p);
          else p.ring = ringOf.get(entry.key);
          label(p);
        }
      }
      // The arc's points lie in the order of their entries: the most pressing on the left.
      for (const p of onArc) { points.delete(p.entry.key); points.set(p.entry.key, p); }
      // A new point on an orbit starts at its own place there, not gliding in from the first one's.
      const byRing = new Map();
      for (const p of points.values()) if (!p.goneAt && !p.arc) byRing.set(p.ring, [...(byRing.get(p.ring) ?? []), p]);
      for (const list of byRing.values()) list.forEach((p, j) => { if (p.fresh) p.a = (j / list.length) * TAU; p.fresh = false; });
      // On the arc, the points already there glide aside; a new one appears at its place, or glides there from its orbit.
      placeArc(true);
      for (const p of onArc) p.fresh = false;
      colours(); // the theme may have changed
      frame(0);

      // The sphere looks the same whether or not anything goes or waits: an empty sky is simply empty. While the voice
      // is spoken here, the sphere is the one that listens and thinks (voice-layer.js): no other screen opens for it.
      const voice = homeVoiceMode();
      if (voice) orb.hover(false); // the pointer is no longer on it as far as it is concerned: the screen is not operable
      orb.set(voice ?? 'home', voiceLevel);
      if (open) fillPanel();
      wake();
      if (r?.write) {
        // "#/new" (Space, n, the rail's +, a work that could not be sent) is this screen with the box focused. Put the address
        // back to "#/" so that pressing n again is a change of address again.
        history.replaceState(null, '', '#/');
        work.focus();
      }
    },
  };
}
