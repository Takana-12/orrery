// The voice layer's picture: the orrery's sun, alone. A soft sphere in the colour of "your move" that swells with
// the voice, with two orbits turning around it. Drawn on a canvas (no inline style, no image).
//   wait    the microphone is not open yet: dim and still
//   listen  it follows how loud the voice is
//   think   what was said is being read: a slow breath, the planets turning faster, the light turned blue (--think)
//   rest    nothing is happening (the plan is shown, or an error): one still frame, no loop
//   home    the home screen's sun: lit, with a calm, self-made swell, the same whether or not anything goes or waits
// Every change of mode is eased, never cut: the colour, the breath, the speed of the orbits and the glow all blend from
// one mode's to the next (the blue of "think" fades back to the accent over about a second). Waking from home into
// listening or thinking (the home screen's sphere taking the voice), the sphere also springs out a little.
// hover(on) (home): the moment the pointer comes onto the sphere it springs out (a soft "whoomph"), and for as long as
// the pointer stays it sways slowly, a little larger and brighter.
import { el } from './dom.js';

const SIZE = 420; // drawing units; the element's CSS size may be smaller (the picture scales)
const R = 58; // the sphere at rest
const TAU = Math.PI * 2;
/** How awake the sphere is in each mode (0 dim .. 1 lit). */
const GLOW = { wait: 0.25, rest: 0.55 };
const glowOf = (mode) => GLOW[mode] ?? 1;
const still = (mode) => mode === 'rest'; // modes that settle into one frame and stop redrawing

/** Resolve a CSS colour (a custom property's value) to [r, g, b] by letting the canvas parse it. */
function rgbOf(g, css) {
  g.fillStyle = '#000';
  g.fillStyle = css;
  const v = g.fillStyle;
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  return (v.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map(Number);
}
const rgba = ([r, g, b], a) => `rgb(${r} ${g} ${b} / ${Math.max(0, Math.min(1, a))})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * Returns { node, set(mode, level?), hover(on) }. `level()` gives the voice's loudness, 0..1. `orbits: false` draws the sphere
 * alone (the home screen draws its own orbits, one point per thing that waits for the human).
 */
export function voiceOrb({ orbits = true } = {}) {
  const node = el('canvas', { class: 'voice-orb', 'aria-hidden': 'true' });
  const g = node.getContext('2d');
  let mode = 'rest';
  let level = () => 0;
  let raf = 0;
  let energy = 0; // the loudness, eased: quick to rise, slow to fall
  let glow = 0; // how awake the sphere is (0 dim .. 1 lit), eased towards the mode's own
  let turn = 0; // the orbits' angle; advances faster while thinking
  let speed = 0.5; // how fast the orbits turn, eased
  let tone = 0; // how far the light has turned from the accent to the thinking blue (0..1), eased
  let last = 0;
  let c = null;
  let hovered = false;
  let bounce = 0; // the spring the pointer sets off: how far the sphere is out of its size (0 at rest)
  let spring = 0; // its speed
  let sway = 0; // how much the slow sway of a pointer that stays is on (0..1), eased

  const colours = () => {
    const css = getComputedStyle(document.documentElement);
    const acc = rgbOf(g, css.getPropertyValue('--acc').trim());
    const think = rgbOf(g, css.getPropertyValue('--think').trim());
    const ink = rgbOf(g, css.getPropertyValue('--ink').trim());
    const bg = rgbOf(g, css.getPropertyValue('--bg').trim());
    const dark = bg[0] + bg[1] + bg[2] < 384;
    return { base: acc, think, ink, dark, line: rgbOf(g, css.getPropertyValue('--ink-2').trim()) };
  };

  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (node.width !== SIZE * dpr) node.width = node.height = SIZE * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /** One closed, softly uneven outline around the centre: the sphere's edge is never a perfect circle. */
  const blob = (radius, wobble, phase, t) => {
    g.beginPath();
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * TAU;
      const r = radius * (1 + wobble * (Math.sin(a * 2 + phase + t * 1.3) * 0.5 + Math.sin(a * 3 - phase * 1.7 - t * 0.9) * 0.32 + Math.sin(a * 5 + phase * 0.6 + t * 1.9) * 0.18));
      const x = SIZE / 2 + Math.cos(a) * r;
      const y = SIZE / 2 + Math.sin(a) * r;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
  };

  /** Half of an orbit (the far half behind the sphere, the near half in front of it) and its planet. */
  const orbit = (i, front, swell) => {
    if (!orbits) return;
    const rx = R * (1.72 + i * 0.5) * (1 + swell * 0.1);
    const ry = rx * (0.3 + i * 0.05);
    const tilt = -0.42 + i * 0.5;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    g.save();
    g.translate(cx, cy);
    g.rotate(tilt);
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, front ? 0 : Math.PI, front ? Math.PI : TAU);
    g.strokeStyle = rgba(c.line, (front ? 0.5 : 0.22) * (0.35 + glow * 0.65));
    g.lineWidth = 1;
    g.stroke();
    const a = turn * (i ? 0.62 : 1) + i * 2.4;
    if (Math.sin(a) > 0 === front) {
      g.beginPath();
      g.arc(Math.cos(a) * rx, Math.sin(a) * ry, i ? 2.6 : 3.4, 0, TAU);
      g.fillStyle = rgba(c.ink, (front ? 0.95 : 0.4) * (0.35 + glow * 0.65));
      g.fill();
    }
    g.restore();
  };

  const paint = (now) => {
    const t = now / 1000;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    // home has no microphone: its own slow, uneven swell stands in for a voice
    const heard = mode === 'listen' ? level() : mode === 'home' ? 0.14 + 0.08 * Math.sin(t * 0.9) + 0.05 * Math.sin(t * 2.3 + 1) : 0;
    energy += (heard - energy) * (heard > energy ? 0.4 : 0.09);
    glow += (glowOf(mode) - glow) * 0.08;
    // Into thinking quickly (it is an answer to what was just said), out of it slowly (a glide back, not a cut).
    const thinking = mode === 'think' ? 1 : 0;
    tone += (thinking - tone) * Math.min(1, dt * (thinking ? 6 : 2.2));
    speed += ((mode === 'think' ? 1.9 : 0.5 + energy * 1.2) - speed) * Math.min(1, dt * 2.5);
    turn += dt * speed;
    c.acc = mix(c.base, c.think, tone);
    c.hot = mix(c.acc, [255, 255, 255], c.dark ? 0.42 : 0.3);
    // Thinking: the light swells and fades gently, so it reads as "working", not "stopped". Its breath blends into the
    // calm one by `tone`, so leaving it is a slow settling, not a jump.
    const calm = mode === 'listen' || mode === 'home' ? 0.5 + 0.5 * Math.sin(t * 1.5) : 0.5;
    const deep = 0.5 + 0.5 * Math.sin(t * 2.4);
    const breath = calm + (deep - calm) * tone;
    // the pointer: a damped spring (quick and strong, settling in about a second), then a slow sway while it stays
    for (let n = 0, h = dt / 4; n < 4; n++) {
      spring += (-70 * bounce - 6.5 * spring) * h;
      bounce += spring * h;
    }
    sway += ((hovered ? 1 : 0) - sway) * Math.min(1, dt * 1.6);
    const swayed = sway * (0.05 + 0.035 * Math.sin(t * 1.1));
    const lit = glow * (1 + (0.62 + deep * 0.3 - 1) * tone) * (1 + sway * 0.1 + Math.max(0, bounce) * 0.15);
    const radius = R * (1 + energy * 0.42 + (breath - 0.5) * (0.04 + 0.03 * tone) + bounce * 0.16 + swayed);
    const cx = SIZE / 2;
    const cy = SIZE / 2;

    g.clearRect(0, 0, SIZE, SIZE);
    orbit(1, false, energy);
    orbit(0, false, energy);

    // the halo: light that reaches further the louder the voice
    const reach = Math.min(SIZE / 2 - 2, radius * (2.1 + energy * 0.7)); // never past the canvas: its edge must not show
    const halo = g.createRadialGradient(cx, cy, radius * 0.6, cx, cy, reach);
    halo.addColorStop(0, rgba(c.acc, (c.dark ? 0.3 : 0.24) * lit));
    halo.addColorStop(0.5, rgba(c.acc, (c.dark ? 0.1 : 0.08) * lit));
    halo.addColorStop(1, rgba(c.acc, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, SIZE, SIZE);

    // the sphere: three uneven layers that drift against each other, lit from the upper left
    const wobble = 0.03 + energy * 0.13 + 0.02 * tone + Math.abs(bounce) * 0.1 + sway * 0.025;
    for (let i = 0; i < 3; i++) {
      const ox = Math.cos(t * (0.5 + i * 0.23) + i * 2.1) * radius * 0.16;
      const oy = Math.sin(t * (0.42 + i * 0.19) + i * 1.3) * radius * 0.16;
      const body = g.createRadialGradient(cx + ox - radius * 0.22, cy + oy - radius * 0.26, 0, cx, cy, radius * (1.08 + i * 0.06));
      body.addColorStop(0, rgba(c.hot, 0.62 * lit));
      body.addColorStop(0.6, rgba(c.acc, 0.5 * lit));
      body.addColorStop(1, rgba(c.acc, 0));
      g.fillStyle = body;
      blob(radius * (1.02 + i * 0.07), wobble, i * 2.3, t * (0.7 + i * 0.2));
      g.fill();
    }
    // a highlight up and to the left: what makes the disc a sphere
    const shine = g.createRadialGradient(cx - radius * 0.3, cy - radius * 0.36, 0, cx - radius * 0.3, cy - radius * 0.36, radius * 0.62);
    shine.addColorStop(0, rgba([255, 255, 255], (c.dark ? 0.26 : 0.42) * lit));
    shine.addColorStop(1, rgba([255, 255, 255], 0));
    g.fillStyle = shine;
    g.beginPath();
    g.arc(cx, cy, radius, 0, TAU);
    g.fill();

    orbit(0, true, energy);
    orbit(1, true, energy);
  };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const loop = (now) => {
    paint(now);
    // At rest (and idle) the picture settles (the glow eases to its level) and then stops being redrawn.
    const settled = still(mode) && Math.abs(glow - glowOf(mode)) < 0.01 && energy < 0.01 && tone < 0.01 && Math.abs(bounce) + Math.abs(spring) + sway < 0.01;
    raf = settled || reduced.matches || !node.isConnected ? 0 : requestAnimationFrame(loop);
  };

  return {
    node,
    set(next, levelFn) {
      if (levelFn) level = levelFn;
      const woke = mode !== next;
      // The home screen's sphere taking the voice: a soft "whoomph" out of its calm.
      if (woke && mode === 'home' && next !== 'rest' && !reduced.matches) spring += 9;
      mode = next;
      if (!woke && raf) return;
      c = colours(); // the theme may have changed since the last time
      fit();
      if (reduced.matches) { glow = glowOf(mode); energy = 0; tone = mode === 'think' ? 1 : 0; speed = mode === 'think' ? 1.9 : 0.5; }
      if (!raf) { last = 0; raf = requestAnimationFrame(loop); }
    },
    hover(on) {
      if (hovered === on) return;
      hovered = on;
      if (reduced.matches) return;
      if (on) spring += 11; // the push of the moment the pointer arrives
      if (!raf && c) { last = 0; raf = requestAnimationFrame(loop); }
    },
  };
}
