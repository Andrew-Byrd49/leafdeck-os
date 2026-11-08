/* View → Show Touches: a ring where each touch (and pen) lands on Leafdeck's page, with its position and the screen it's
   on, for finding out where the compositor puts touches on a computer with several screens. Touches on a web page go
   to the page, not here, so try it on the desktop or a window's title bar. */
import { screens } from './wm.js';

let layer = null;
const rings = new Map(); // pointerId → ring element

export const touchesShown = () => !!layer;

export function toggleTouches() {
  if (layer) {
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) removeEventListener(t, onPointer, true);
    layer.remove();
    layer = null;
    rings.clear();
    return;
  }
  layer = document.createElement('div');
  layer.className = 'touch-layer';
  document.body.append(layer);
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) addEventListener(t, onPointer, true);
}

function screenAt(x, y) {
  const i = screens().findIndex((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  return i < 0 ? 'no screen' : screens()[i].name || `screen ${i + 1}`;
}

function onPointer(e) {
  if (e.pointerType === 'mouse') return;
  const x = Math.round(e.clientX);
  const y = Math.round(e.clientY);
  if (e.type === 'pointerdown') {
    const ring = document.createElement('div');
    ring.className = 'touch-ring';
    ring.innerHTML = '<span></span>';
    layer.append(ring);
    rings.set(e.pointerId, ring);
  }
  const ring = rings.get(e.pointerId);
  if (!ring) return;
  ring.style.transform = `translate(${x}px, ${y}px)`;
  ring.firstChild.textContent = `${e.pointerType} ${x}, ${y} · ${screenAt(x, y)}`;
  if (e.type === 'pointermove') trail(x, y);
  if (e.type === 'pointerup' || e.type === 'pointercancel') {
    rings.delete(e.pointerId);
    ring.classList.add('lifted');
    setTimeout(() => ring.remove(), 1500);
  }
}

function trail(x, y) {
  const dot = document.createElement('div');
  dot.className = 'touch-trail';
  dot.style.transform = `translate(${x}px, ${y}px)`;
  layer.append(dot);
  setTimeout(() => dot.remove(), 600);
}
