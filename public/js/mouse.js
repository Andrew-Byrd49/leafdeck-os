// Settings → Mouse (Leafdeck OS): how far the pointer goes and whether it accelerates. The compositor puts both on every
// mouse through libinput (electron/compositor.cjs setPointer; the `pointer` command in os/cage/leafdeck.c), and on mice
// connected later. The touchpad keeps libinput's touchpad defaults. Saved in the OS settings (os:mouse, electron/main.cjs).
import { shell } from './shell.js';
import { esc } from './util.js';

let host = null;
let data = null; // os:mouse: { accel, speed, compositor, supported, mice }
let timer = 0;

const row = (label, control, hint = '') =>
  `<div class="set-row"><div><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="set-ctl">${control}</div></div>`;
const speedLabel = (v) => (v === 0 ? 'Normal' : v > 0 ? `+${v}` : String(v));

function status() {
  if (!data.compositor) return 'Takes effect on Leafdeck OS, where Leafdeck’s compositor is running. It isn’t connected here.';
  if (!data.supported) return 'This compositor doesn’t take mouse settings yet: rebuild it (sh os/cage/build.sh) and sign in again.';
  if (!data.mice) return 'No mouse is connected right now. The settings apply as soon as one is. The touchpad keeps its own settings.';
  return `On ${data.mice === 1 ? 'the mouse' : `${data.mice} mice`} connected now. The touchpad keeps its own settings.`;
}

function render() {
  if (!host || !data) return;
  host.innerHTML = `<div class="set-group">
      ${row('Pointer speed', `<div class="set-range"><input type="range" min="-100" max="100" step="5" value="${data.speed}" data-mouse-speed aria-label="Pointer speed"><output>${speedLabel(data.speed)}</output></div>`, 'How far the pointer goes for the same movement of the mouse. Normal is one pixel per step of the mouse')}
      ${row('Acceleration', `<label class="switch"><input type="checkbox" data-mouse-accel ${data.accel ? 'checked' : ''}><span></span></label>`, 'The pointer goes farther when you move the mouse quickly, and less when you move it slowly. Off: the same distance for the same movement, at any speed')}
      ${row('Defaults', `<button class="btn small" data-mouse-reset ${data.accel && data.speed === 0 ? 'disabled' : ''}>Back to the defaults</button>`, 'Normal speed, acceleration on')}
    </div>
    <p class="muted mouse-status">${esc(status())}</p>`;
}

async function save(patch) {
  try {
    data = await shell.os.mouse(patch);
  } catch (err) {
    console.warn('[mouse]', err);
  }
  render();
}

export function mountMouse(el) {
  host = el;
  el.innerHTML = '<p class="muted">Loading…</p>';
  shell.os
    .mouse()
    .then((d) => {
      data = d;
      render();
    })
    .catch((err) => (el.innerHTML = `<p class="muted">${esc(String(err?.message || err))}</p>`));
  el.addEventListener('input', (e) => {
    const r = e.target.closest('[data-mouse-speed]');
    if (!r) return;
    const v = Number(r.value);
    r.nextElementSibling.textContent = speedLabel(v);
    clearTimeout(timer);
    timer = setTimeout(() => save({ speed: v }), 120); // live, but not a write per pixel of the slider
  });
  el.addEventListener('change', (e) => {
    const a = e.target.closest('[data-mouse-accel]');
    if (a) save({ accel: a.checked });
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-mouse-reset]')) save({ accel: true, speed: 0 });
  });
}
