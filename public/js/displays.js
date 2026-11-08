// Settings → Displays (Leafdeck OS): arrange the screens, choose the main one (menu bar and new windows), give others a menu
// bar or a Dock of their own, and set each screen's resolution, scale and rotation. The arrangement is saved per set of connected screens (electron/ossystem.cjs), so a
// laptop docked and undocked comes back as it was. Apply tries it; it's kept only when confirmed within 15 seconds,
// otherwise the previous one comes back by itself (electron/main.cjs, os:try-displays). The Menu bar and Dock switches
// aren't part of the arrangement: they're settings (prefs.barScreens, prefs.dockScreens, by connector name) and take
// effect right away.
import { shell } from './shell.js';
import { store } from './store.js';
import { esc } from './util.js';
import { icon } from './icons.js';
import { toast } from './wm.js';

const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const ROTATIONS = [
  ['normal', 'Normal'],
  ['180', 'Upside down'],
  ['90', 'Turned 90°'],
  ['270', 'Turned 270°'],
];
const KEEP_SECONDS = 15;

let data = null; // { key, saved, profile, outputs } from os:displays
let draft = null; // the arrangement being edited: { main, outputs: { [id]: { on, x, y, scale, transform, mode } } }
let selected = null; // id of the selected screen
let dirty = false;
let trying = 0; // seconds left to confirm a tried arrangement
let tryTimer = 0;
let host = null; // the element the page draws into

const clone = (o) => JSON.parse(JSON.stringify(o));
const out = (id) => data.outputs.find((o) => o.id === id);
const modeOf = (o, key) => o.modes.find((m) => modeKey(m) === key) || o.modes[0] || o;
const modeKey = (m) => `${m.width}x${m.height}@${Number(m.refresh || 0).toFixed(3)}Hz`;
const label = (o) => (o.internal ? (data.outputs.filter((x) => x.internal).length > 1 ? `Built-in screen (${o.name})` : 'Built-in screen') : o.description);

/** A screen's size on the desktop, in layout pixels (as electron/ossystem.cjs logicalSize). */
function size(id) {
  const o = out(id);
  const p = draft.outputs[id];
  const m = modeOf(o, p.mode);
  const side = p.transform === '90' || p.transform === '270';
  return { w: Math.round((side ? m.height : m.width) / p.scale), h: Math.round((side ? m.width : m.height) / p.scale) };
}
const rectOf = (id) => ({ x: draft.outputs[id].x, y: draft.outputs[id].y, ...size(id) });
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const namesIn = (key) => (Array.isArray(store.prefs[key]) ? store.prefs[key] : []);
/** Is this the screen the Dock itself is on (Settings → Desktop → Dock screen, else the main one)? */
const dockHere = (o) => {
  const named = store.prefs.dockScreen && draft.outputs[data.outputs.find((x) => x.name === store.prefs.dockScreen)?.id]?.on;
  return named ? o.name === store.prefs.dockScreen : o.id === draft.main;
};
const onIds = () => data.outputs.filter((o) => draft.outputs[o.id].on).map((o) => o.id);

/**
 * Place a screen where it was dropped, touching the others edge to edge without overlapping them: of the spots beside
 * each other screen (aligned at the drop point, or flush with its top, bottom, left or right), the closest wins.
 */
function settle(id, x, y) {
  const others = onIds().filter((o) => o !== id).map(rectOf);
  if (!others.length) return { x: 0, y: 0 };
  const { w, h } = size(id);
  const cands = [];
  for (const o of others) {
    const ys = [y, o.y, o.y + o.h - h].map((v) => Math.min(Math.max(v, o.y - h + 40), o.y + o.h - 40));
    const xs = [x, o.x, o.x + o.w - w].map((v) => Math.min(Math.max(v, o.x - w + 40), o.x + o.w - 40));
    for (const yy of ys) cands.push({ x: o.x + o.w, y: yy }, { x: o.x - w, y: yy });
    for (const xx of xs) cands.push({ x: xx, y: o.y + o.h }, { x: xx, y: o.y - h });
  }
  const free = cands.filter((c) => !others.some((o) => overlaps({ ...c, w, h }, o)));
  const best = (free.length ? free : cands).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

async function load() {
  data = await shell.os.displays();
  draft = clone(data.profile);
  selected = selected && data.outputs.some((o) => o.id === selected) ? selected : draft.main;
  dirty = false;
}

/* ---------------- drawing ---------------- */

function draw() {
  if (!host || !data) return;
  if (!data.outputs.length) return void (host.innerHTML = '<p class="muted">Leafdeck couldn’t read the screens from the display server.</p>');
  const on = onIds();
  const rects = on.map((id) => ({ id, ...rectOf(id) }));
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const sel = out(selected);
  const p = sel && draft.outputs[sel.id];
  host.innerHTML = `
    <div class="dsp">
      <div class="dsp-canvas" data-bounds="${minX},${minY},${maxX - minX},${maxY - minY}">
        ${rects.map((r) => `<button class="dsp-screen${r.id === selected ? ' on' : ''}${r.id === draft.main ? ' main' : ''}" data-id="${esc(r.id)}">
          <span class="dsp-bar"></span><b>${esc(label(out(r.id)))}</b><small>${r.w * draft.outputs[r.id].scale} × ${r.h * draft.outputs[r.id].scale}</small></button>`).join('')}
      </div>
      ${data.outputs.some((o) => !draft.outputs[o.id].on) ? `<div class="dsp-off"><span>Not in use:</span>${data.outputs
        .filter((o) => !draft.outputs[o.id].on)
        .map((o) => `<button class="chip${o.id === selected ? ' on' : ''}" data-id="${esc(o.id)}">${icon('display', 12)} ${esc(label(o))}</button>`)
        .join('')}</div>` : ''}
      <p class="dsp-hint muted small">Drag the screens to match where they sit on your desk. The main screen has the menu bar (and the Dock, unless Settings → Desktop puts it on another screen); other screens can have their own menu bar and Dock as well.</p>
      ${sel ? `<div class="set-group dsp-props">
        <div class="set-row"><div><b>${esc(label(sel))}</b><small>${esc(sel.description)} · ${esc(sel.name)}</small></div>
          <div class="set-ctl"><label class="switch" title="Use this screen"><input type="checkbox" data-dsp="on" ${p.on ? 'checked' : ''} ${p.on && on.length < 2 ? 'disabled' : ''}><span></span></label></div></div>
        ${p.on ? `
        <div class="set-row"><div>Main screen<small>The menu bar and new windows</small></div>
          <div class="set-ctl">${draft.main === sel.id ? '<span class="muted small">This is the main screen</span>' : '<button class="btn small" data-dsp="main">Make main</button>'}</div></div>
        ${draft.main !== sel.id ? `<div class="set-row"><div>Menu bar<small>A menu bar and search on this screen too</small></div>
          <div class="set-ctl"><label class="switch" title="Menu bar on this screen"><input type="checkbox" data-dsp="bar" data-key="barScreens" ${namesIn('barScreens').includes(sel.name) ? 'checked' : ''}><span></span></label></div></div>` : ''}
        <div class="set-row"><div>Dock<small>${dockHere(sel) ? 'Settings → Desktop → Dock screen puts the Dock here' : 'A Dock on this screen too'}</small></div>
          <div class="set-ctl">${dockHere(sel) ? '<span class="muted small">This screen has the Dock</span>' : `<label class="switch" title="Dock on this screen"><input type="checkbox" data-dsp="bar" data-key="dockScreens" ${namesIn('dockScreens').includes(sel.name) ? 'checked' : ''}><span></span></label>`}</div></div>
        <div class="set-row"><div>Resolution</div><div class="set-ctl"><select data-dsp="mode">${sel.modes
          .map((m) => `<option value="${esc(modeKey(m))}" ${modeKey(m) === p.mode ? 'selected' : ''}>${m.width} × ${m.height} · ${Math.round(m.refresh)} Hz${m.preferred ? ' (best)' : ''}</option>`)
          .join('')}</select></div></div>
        <div class="set-row"><div>Scale<small>Bigger text and controls on dense screens</small></div><div class="set-ctl"><select data-dsp="scale">${SCALES.map(
          (s) => `<option value="${s}" ${s === p.scale ? 'selected' : ''}>${Math.round(s * 100)}%</option>`,
        ).join('')}</select></div></div>
        <div class="set-row"><div>Rotation</div><div class="set-ctl"><select data-dsp="transform">${ROTATIONS.map(
          ([v, l]) => `<option value="${v}" ${v === p.transform ? 'selected' : ''}>${l}</option>`,
        ).join('')}</select></div></div>` : ''}
      </div>` : ''}
      <div class="dsp-actions">
        ${trying ? `<div class="dsp-confirm"><span>Keep these display settings? Going back in ${trying} s.</span>
          <button class="btn small" data-dsp="revert">Go back</button><button class="btn small primary" data-dsp="keep">Keep</button></div>`
        : `<button class="btn small" data-dsp="auto" ${data.saved || dirty ? '' : 'disabled'} title="One screen: an external display when connected, else the built-in one">Automatic</button>
          <button class="btn small primary" data-dsp="apply" ${dirty ? '' : 'disabled'}>Apply</button>`}
      </div>
    </div>`;
  layoutCanvas();
}

/** Scale the arrangement to fit the canvas, centered. */
function layoutCanvas() {
  const canvas = host.querySelector('.dsp-canvas');
  if (!canvas) return;
  const [bx, by, bw, bh] = canvas.dataset.bounds.split(',').map(Number);
  const cw = canvas.clientWidth || 560;
  const ch = canvas.clientHeight || 220;
  const k = Math.min((cw - 40) / bw, (ch - 40) / bh);
  canvas.dataset.k = k;
  const ox = (cw - bw * k) / 2 - bx * k;
  const oy = (ch - bh * k) / 2 - by * k;
  canvas.dataset.origin = `${ox},${oy}`;
  for (const el of canvas.querySelectorAll('.dsp-screen')) {
    const r = rectOf(el.dataset.id);
    Object.assign(el.style, { left: `${ox + r.x * k}px`, top: `${oy + r.y * k}px`, width: `${r.w * k - 3}px`, height: `${r.h * k - 3}px` });
  }
}

function change(fn) {
  fn(draft.outputs[selected]);
  dirty = true;
  draw();
}

/* ---------------- events ---------------- */

function onClick(e) {
  const b = e.target.closest('[data-dsp], [data-id]');
  if (!b || b.disabled) return;
  if (b.dataset.id && !b.dataset.dsp) {
    if (b.classList.contains('dsp-screen')) return; // handled on pointerdown (select or drag)
    selected = b.dataset.id;
    return draw();
  }
  const act = b.dataset.dsp;
  if (act === 'main') {
    draft.main = selected;
    dirty = true;
    draw();
  } else if (act === 'apply') apply();
  else if (act === 'keep') keep();
  else if (act === 'revert') goBack();
  else if (act === 'auto') automatic();
}

function onChange(e) {
  const t = e.target.closest('[data-dsp]');
  if (!t) return;
  const act = t.dataset.dsp;
  if (act === 'bar') {
    const name = out(selected).name;
    const key = t.dataset.key;
    store.setPrefs({ [key]: [...namesIn(key).filter((n) => n !== name), ...(t.checked ? [name] : [])] });
    return;
  }
  if (act === 'on')
    change((p) => {
      p.on = t.checked;
      if (p.on) Object.assign(p, settle(selected, 1e6, 0)); // to the right of the others
      else if (draft.main === selected) draft.main = onIds().find((id) => id !== selected) || draft.main;
    });
  else if (act === 'mode') change((p) => (p.mode = t.value));
  else if (act === 'scale') change((p) => (p.scale = Number(t.value)));
  else if (act === 'transform') change((p) => (p.transform = t.value));
  // A screen that changed size may now overlap its neighbors: settle it again.
  if (['mode', 'scale', 'transform'].includes(act)) {
    const p = draft.outputs[selected];
    Object.assign(p, settle(selected, p.x, p.y));
    draw();
  }
}

/** Drag a screen around the canvas; it settles beside the others when dropped. A click without moving selects it. */
function onPointerDown(e) {
  const el = e.target.closest('.dsp-screen');
  if (!el || trying) return;
  e.preventDefault();
  const id = el.dataset.id;
  const canvas = el.parentElement;
  const k = Number(canvas.dataset.k);
  const start = { x: e.clientX, y: e.clientY, px: draft.outputs[id].x, py: draft.outputs[id].y };
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / k;
    const dy = (ev.clientY - start.y) / k;
    if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
    moved = true;
    el.classList.add('dragging');
    const [ox, oy] = canvas.dataset.origin.split(',').map(Number);
    el.style.left = `${ox + (start.px + dx) * k}px`;
    el.style.top = `${oy + (start.py + dy) * k}px`;
  };
  const up = (ev) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    selected = id;
    if (moved) {
      const spot = settle(id, start.px + (ev.clientX - start.x) / k, start.py + (ev.clientY - start.y) / k);
      if (spot.x !== start.px || spot.y !== start.py) {
        Object.assign(draft.outputs[id], spot);
        dirty = true;
      }
    }
    draw();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/* ---------------- apply, keep, go back ---------------- */

async function apply() {
  try {
    const r = await shell.os.tryDisplays(draft);
    draft = clone(r.profile);
    dirty = false;
    trying = KEEP_SECONDS;
    clearInterval(tryTimer);
    tryTimer = setInterval(() => {
      trying = Math.max(0, trying - 1);
      if (!trying) clearInterval(tryTimer); // the main process goes back by itself (os:displays-reverted)
      draw();
    }, 1000);
    draw();
  } catch (err) {
    toast(`Couldn’t change the displays: ${err.message}`, 'error');
  }
}

async function keep() {
  clearInterval(tryTimer);
  trying = 0;
  const ok = await shell.os.keepDisplays().catch(() => false);
  toast(ok ? 'Display settings saved' : 'Those settings had already been undone', ok ? '' : 'error');
  await load();
  draw();
}

async function goBack() {
  clearInterval(tryTimer);
  trying = 0;
  await shell.os.revertDisplays().catch(() => {});
  await load();
  draw();
}

async function automatic() {
  await shell.os.resetDisplays().catch((err) => toast(err.message, 'error'));
  await load();
  draw();
}

let wired = false;
/** Draw the Displays page into `el` (Settings calls this each time it draws; an edit in progress is kept). */
export async function mountDisplays(el) {
  if (!shell?.os?.displays) return;
  host = el;
  if (!wired) {
    wired = true;
    shell.on('os:displays-reverted', async () => {
      clearInterval(tryTimer);
      trying = 0;
      toast('Display settings went back to how they were');
      await load();
      draw();
    });
    // Screens plugged in or out: start from what's connected now (unless an edit is in progress).
    shell.on('os:layout', async () => {
      if (dirty || trying || !host?.isConnected) return;
      await load();
      draw();
    });
  }
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('pointerdown', onPointerDown);
  new ResizeObserver(() => layoutCanvas()).observe(host);
  if (!data || (!dirty && !trying)) {
    try {
      await load();
    } catch (err) {
      host.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
      return;
    }
  }
  draw();
}
