// A color picker of Leafdeck's own: a saturation/brightness square, a hue bar, a hex field, a few quick colors, and
// optionally "Accent color" (follow whatever the accent is). The browser's <input type="color"> opens a separate system
// dialog on Linux, which in Leafdeck OS would cover the whole screen. The eyedropper picks from anywhere on screen.
import { esc, el } from './util.js';
import { icon } from './icons.js';
import { pickScreenColor } from './eyedropper.js';
import { placePopup } from './wm.js';

const QUICK = ['#34c77b', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#ffd60a', '#64d2ff', '#8e8e93'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

let open = null;

/**
 * Pick a color next to (x, y). `value`: '#rrggbb', or '' for the accent color (with `accent: true`). `onChange` gets
 * every change as it happens (for a live preview); `onDone` gets the final value when the picker closes ('' = accent).
 */
export function pickColor(x, y, { value = '', accent = false, title = 'Color', onChange = () => {}, onDone = () => {} } = {}) {
  open?.close();
  const accentNow = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#34c77b';
  let current = value;
  let hsv = hexToHsv(value || accentNow) || { h: 140, s: 0.7, v: 0.78 };
  const node = el(`<div class="cpick" role="dialog" aria-label="${esc(title)}">
    <div class="cpick-head">${esc(title)}</div>
    <div class="cpick-sv" tabindex="0" aria-label="Saturation and brightness"><i></i></div>
    <div class="cpick-hue" tabindex="0" aria-label="Hue"><i></i></div>
    <div class="cpick-row"><span class="cpick-swatch"></span><input class="cpick-hex" spellcheck="false" maxlength="7" aria-label="Hex color"><button type="button" class="cpick-drop" title="Pick a color from the screen" aria-label="Pick a color from the screen">${icon('eyedropper', 16)}</button></div>
    <div class="cpick-quick">${accent ? `<button class="cpick-accent" data-c="" title="Follow the accent color">Accent</button>` : ''}${QUICK.map((c) => `<button data-c="${c}" style="--c:${c}" title="${c}"></button>`).join('')}</div>
  </div>`);
  document.body.append(node);
  const sv = node.querySelector('.cpick-sv');
  const hue = node.querySelector('.cpick-hue');
  const hex = node.querySelector('.cpick-hex');

  function draw() {
    const shown = current || accentNow;
    sv.style.setProperty('--hue', `hsl(${hsv.h} 100% 50%)`);
    sv.querySelector('i').style.cssText = `left:${hsv.s * 100}%;top:${(1 - hsv.v) * 100}%;background:${shown}`;
    hue.querySelector('i').style.left = `${(hsv.h / 360) * 100}%`;
    node.querySelector('.cpick-swatch').style.background = shown;
    if (document.activeElement !== hex) hex.value = current ? current.toUpperCase() : 'Accent';
    node.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === current.toLowerCase()));
  }
  function set(next, fromHsv = false) {
    current = next;
    if (!fromHsv) hsv = hexToHsv(current || accentNow) || hsv;
    draw();
    onChange(current);
  }
  const drag = (area, fn) =>
    area.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      area.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = area.getBoundingClientRect();
        fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
        set(hsvToHex(hsv), true);
      };
      move(e);
      area.addEventListener('pointermove', move);
      area.addEventListener('pointerup', () => area.removeEventListener('pointermove', move), { once: true });
    });
  drag(sv, (fx, fy) => Object.assign(hsv, { s: fx, v: 1 - fy }));
  drag(hue, (fx) => (hsv.h = fx * 359.9));
  // Arrow keys nudge the square and the hue bar.
  sv.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, 0.02], ArrowDown: [0, -0.02] }[e.key];
    if (!d) return;
    e.preventDefault();
    Object.assign(hsv, { s: clamp(hsv.s + d[0], 0, 1), v: clamp(hsv.v + d[1], 0, 1) });
    set(hsvToHex(hsv), true);
  });
  hue.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -3, ArrowRight: 3 }[e.key];
    if (!d) return;
    e.preventDefault();
    hsv.h = (hsv.h + d + 360) % 360;
    set(hsvToHex(hsv), true);
  });
  hex.addEventListener('input', () => {
    const v = hex.value.trim().replace(/^#?/, '#');
    if (/^#[0-9a-f]{6}$/i.test(v)) set(v.toLowerCase());
  });
  hex.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') close();
  });
  let picking = false;
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-c]');
    if (b) set(b.dataset.c);
    if (e.target.closest('.cpick-drop') && !picking) {
      picking = true;
      node.hidden = true; // out of the picture
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = await pickScreenColor();
      picking = false;
      node.hidden = false;
      if (c) set(c);
    }
  });

  placePopup(node, x, y, { pad: 8 });
  draw();

  const outside = (e) => !picking && !node.contains(e.target) && close();
  const esc_ = (e) => !picking && e.key === 'Escape' && close();
  function close() {
    if (open?.node !== node) return;
    open = null;
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', esc_, true);
    node.remove();
    onDone(current);
  }
  setTimeout(() => {
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', esc_, true);
  });
  open = { node, close };
  return { close };
}
