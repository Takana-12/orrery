// The voice layer's picture: the orrery's sun, alone. A soft sphere in the colour of "your move" that swells with
// the voice, with two orbits turning around it. Drawn on a canvas (no inline style, no image).
//   wait    the microphone is not open yet: dim and still
//   listen  it follows how loud the voice is
//   think   what was said is being read: a slow breath, the planets turning faster, the light turned blue (--think)
//   rest    nothing is happening (the plan is shown, or an error): one still frame, no loop
import { el } from './dom.js';

const SIZE = 420; // drawing units; the element's CSS size may be smaller (the picture scales)
const R = 58; // the sphere at rest
const TAU = Math.PI * 2;

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

/** Returns { node, set(mode, level?) }. `level()` gives the voice's loudness, 0..1. */
export function voiceOrb() {
  const node = el('canvas', { class: 'voice-orb', 'aria-hidden': 'true' });
  const g = node.getContext('2d');
  let mode = 'rest';
  let level = () => 0;
  let raf = 0;
  let energy = 0; // the loudness, eased: quick to rise, slow to fall
  let glow = 0; // how awake the sphere is (0 dim .. 1 lit), eased towards the mode's own
  let turn = 0; // the orbits' angle; advances faster while thinking
  let tone = 0; // how far the light has turned from the accent to the thinking blue (0..1), eased
  let last = 0;
  let c = null;

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
    const heard = mode === 'listen' ? level() : 0;
    energy += (heard - energy) * (heard > energy ? 0.4 : 0.09);
    glow += ((mode === 'wait' ? 0.25 : mode === 'rest' ? 0.55 : 1) - glow) * 0.08;
    turn += dt * (mode === 'think' ? 1.9 : 0.5 + energy * 1.2);
    tone += ((mode === 'think' ? 1 : 0) - tone) * 0.14;
    c.acc = mix(c.base, c.think, tone);
    c.hot = mix(c.acc, [255, 255, 255], c.dark ? 0.42 : 0.3);
    // Thinking: the light swells and fades gently, so it reads as "working", not "stopped".
    const breath = mode === 'think' ? 0.5 + 0.5 * Math.sin(t * 2.4) : mode === 'listen' ? 0.5 + 0.5 * Math.sin(t * 1.5) : 0.5;
    const lit = glow * (mode === 'think' ? 0.62 + breath * 0.3 : 1);
    const radius = R * (1 + energy * 0.42 + (breath - 0.5) * (mode === 'think' ? 0.07 : 0.04));
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
    const wobble = 0.03 + energy * 0.13 + (mode === 'think' ? 0.02 : 0);
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

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const loop = (now) => {
    paint(now);
    // At rest the picture settles (the glow eases to its level) and then stops being redrawn.
    const settled = mode === 'rest' && Math.abs(glow - 0.55) < 0.01 && energy < 0.01 && tone < 0.01;
    raf = settled || still.matches || !node.isConnected ? 0 : requestAnimationFrame(loop);
  };

  return {
    node,
    set(next, levelFn) {
      if (levelFn) level = levelFn;
      const woke = mode !== next;
      mode = next;
      if (!woke && raf) return;
      c = colours(); // the theme may have changed since the last time
      fit();
      if (still.matches) { glow = mode === 'wait' ? 0.25 : mode === 'rest' ? 0.55 : 1; energy = 0; tone = mode === 'think' ? 1 : 0; }
      if (!raf) { last = 0; raf = requestAnimationFrame(loop); }
    },
  };
}
