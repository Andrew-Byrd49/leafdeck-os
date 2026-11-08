// Leafdeck OS: programs' real windows in Leafdeck frames (electron/compositor.cjs, os/cage/native-windows.patch).
// Each program window gets a Leafdeck window, "nw:<id>", whose body is where the compositor shows the program: drawn
// by the program itself on the graphics card, with the real pointer, not a picture of it. Leafdeck keeps telling the
// compositor where each body is (place), what of Leafdeck is in front of it (covers: windows above, menus, the
// Dock…), the stacking order and which has the keyboard; it does that every frame, sending only what changed.
// A program that draws its own title bar (GNOME's apps, Spotify, Chrome) gets a frame without Leafdeck's: its title bar
// moves the frame (the compositor passes the pointer on: grab, drag, dragend) and its buttons maximize and minimize it.
import { addResolver, openApp, wins, closeWindow, focus, activeWindow, toggleMax, minimize, renderDock, externalDrag, pageScale, syncFullscreen } from './wm.js';
import { shell } from './shell.js';

const comp = shell?.compositor;
const PREFIX = 'nw:';
const BAR = 46; // the window's title bar (.win-bar)
const EDGE = 4; // the resize handles reach this far into a window: the program stays clear of them
const PASS = new Set(['wl-clipboard']);
const natives = new Map(); // id -> { id, parent, title, appId, w, h, minW, minH, csd, frame }
const decos = new Map(); // id -> csd, told before the window itself
const sent = new Map(); // id -> { place, cover } last sent
let sentOrder = '';
let sentFocus = -1;
let lastActive = null;
let running = false;
let drag = null; // { id, move, end } while a program's own title bar moves its frame

const cmd = (c) => comp.cmd(c);

addResolver((appId) => {
  if (!appId.startsWith(PREFIX)) return null;
  const n = natives.get(Number(appId.slice(PREFIX.length)));
  if (!n) return null;
  const s = pageScale();
  const top = n.csd ? EDGE : BAR; // the program's own title bar needs no room above it
  return {
    id: appId,
    name: n.title || n.appId || 'App',
    icon: 'display',
    color: 'graphite',
    burner: true, // not reopened with the session: the program is what decides it's there
    size: [Math.round(Math.max(n.w, 200) * s.x) + 2 * EDGE, Math.round(Math.max(n.h, 120) * s.y) + top + EDGE],
    min: [Math.round(Math.max(n.minW, 160) * s.x) + 2 * EDGE, Math.round(Math.max(n.minH, 80) * s.y) + top + EDGE],
    // Closing asks the program; its window goes when the program closes it (it can ask about unsaved work first).
    canClose() {
      cmd({ op: 'close', id: n.id });
      return false;
    },
    mount(win) {
      win.body.innerHTML = '<div class="nw-body"></div>';
      win.el.classList.add('nw-win');
      win.el.classList.toggle('nw-csd', !!n.csd);
      win.nativeId = n.id;
      n.frame = win;
      win.setTitle(n.title || app?.name || 'App');
      // The title bar gives the program the keyboard, as a click in it would.
      win.el.addEventListener('pointerdown', () => {
        sentFocus = n.id;
        cmd({ op: 'focus', id: n.id });
      });
      win.cleanups.push(() => {
        if (n.frame === win) n.frame = null;
        sent.delete(n.id);
        if (n.fullscreen) setFullscreen(n, false);
        cmd({ op: 'hide', id: n.id });
      });
      start();
    },
  };
});

/* ---------------- full screen ---------------- */

/** A video or a game asked for the whole screen: the frame fills the screen it's on (syncFullscreen in wm.js). */
function setFullscreen(n, on) {
  n.fullscreen = on;
  const w = n.frame;
  if (w) {
    w.el.classList.toggle('nw-fs', on);
    syncFullscreen();
    if (on) focus(w);
  }
  cmd({ op: 'fullscreen', id: n.id, on });
  tick(); // where it goes now, without waiting for a frame (there may be none while it covers the screen)
}

/* ---------------- what the compositor says ---------------- */

function onEvent(ev) {
  const n = natives.get(ev.id);
  const s = pageScale();
  switch (ev.type) {
    case 'deco':
      if (n) {
        n.csd = ev.csd;
        n.frame?.el.classList.toggle('nw-csd', ev.csd);
      } else decos.set(ev.id, ev.csd);
      break;
    case 'new': {
      // wl-copy's window is only there for a moment, to take the clipboard: no frame for it (it stays unplaced).
      if (PASS.has(ev.appId.toLowerCase())) return;
      const csd = decos.has(ev.id) ? decos.get(ev.id) : n?.csd;
      decos.delete(ev.id);
      if (n) Object.assign(n, ev, { csd }); // announced again (a list after a reload)
      else natives.set(ev.id, { ...ev, csd, frame: null });
      if (!natives.get(ev.id).frame) openApp(PREFIX + ev.id);
      break;
    }
    case 'gone':
      natives.delete(ev.id);
      decos.delete(ev.id);
      sent.delete(ev.id);
      if (drag?.id === ev.id) drag = null;
      if (n?.frame) closeWindow(n.frame, true);
      break;
    case 'title':
      if (n) {
        n.title = ev.title;
        n.frame?.setTitle(ev.title || 'App');
        renderDock();
      }
      break;
    case 'appid':
      if (n) n.appId = ev.appId;
      break;
    case 'size':
      if (n) Object.assign(n, { w: ev.w, h: ev.h });
      break;
    case 'focus': {
      // The keyboard moved by itself (a click in a program, Super back to Leafdeck): the frame comes forward.
      sentFocus = ev.id;
      const f = ev.id ? natives.get(ev.id)?.frame : null;
      if (f && activeWindow() !== f) {
        focus(f);
        lastActive = f;
      }
      break;
    }
    case 'grab':
      if (n?.frame && !n.fullscreen) {
        drag?.end();
        focus(n.frame);
        drag = { id: ev.id, ...externalDrag(n.frame, ev.kind, ev.x * s.x, ev.y * s.y, ev.edges) };
      }
      break;
    case 'drag':
      if (drag?.id === ev.id) drag.move(ev.x * s.x, ev.y * s.y);
      break;
    case 'dragend':
      if (drag?.id === ev.id) {
        drag.move(ev.x * s.x, ev.y * s.y);
        drag.end();
        drag = null;
      }
      break;
    case 'state':
      if (!n?.frame) break;
      if (ev.state === 'minimize') minimize(n.frame);
      else if ((ev.state === 'maximize') !== !!n.frame.max) toggleMax(n.frame);
      break;
    case 'fullscreen':
      if (n) setFullscreen(n, ev.on);
      break;
    case 'reset': // the compositor connection is gone
      for (const x of natives.values()) if (x.frame) closeWindow(x.frame, true);
      natives.clear();
      decos.clear();
      sent.clear();
      drag = null;
      break;
  }
}

/* ---------------- telling the compositor, every frame ---------------- */

const visible = (el) => el && el.isConnected && !el.classList.contains('hidden') && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';

// Page pixels to the compositor's (they differ when Leafdeck is zoomed).
function toComp(r, s) {
  const x = Math.floor(r.x / s.x);
  const y = Math.floor(r.y / s.y);
  return { x, y, w: Math.ceil((r.x + r.w) / s.x) - x, h: Math.ceil((r.y + r.h) / s.y) - y };
}

function clip(r, c) {
  const x = Math.max(r.left, c.left);
  const y = Math.max(r.top, c.top);
  const w = Math.min(r.right, c.right) - x;
  const h = Math.min(r.bottom, c.bottom) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// What's drawn above the windows: whatever sits in front of #windows (menus, panels, search, toasts, the overview,
// dialogs; the menu bar and Dock where they're in front, which on a screen in full screen they aren't: syncFullscreen).
const BASE = new Set(['wallpaper', 'desktop', 'windows']);
const zOf = (el) => Number(getComputedStyle(el).zIndex) || 0;
function overlays() {
  const out = [];
  const floor = zOf(document.getElementById('windows'));
  for (const el of document.body.children) {
    if (BASE.has(el.id) || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(el.tagName) || el.hidden || !visible(el) || zOf(el) <= floor) continue;
    painted(el, out, 0);
  }
  return out;
}

// The parts of an element that draw something: a see-through container (the Dock's full-width strip, #toasts) counts
// only by what's in it, or the program under its empty space would be hidden for nothing.
function paints(el, cs) {
  const bg = cs.backgroundColor;
  return (
    (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) ||
    cs.backgroundImage !== 'none' ||
    cs.backdropFilter !== 'none' ||
    cs.boxShadow !== 'none' ||
    (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') ||
    !el.children.length
  );
}
function painted(el, out, depth) {
  if (el.hidden || !visible(el)) return;
  const cs = getComputedStyle(el);
  if (cs.opacity === '0') return;
  if (depth >= 4 || paints(el, cs)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) out.push(el);
    if (depth >= 4) return;
  }
  // Children can stick out of their parent (a menu under the search box): they count too.
  for (const c of el.children) painted(c, out, depth + 1);
}

function coversFor(n, area, over) {
  const w = n.frame;
  const z = Number(w.el.style.zIndex) || 0;
  const rects = [];
  const add = (r) => {
    const c = clip(r, area);
    if (c && rects.length < 48) rects.push(c);
  };
  for (const o of wins.values()) {
    if (o === w || o.minimized || !visible(o.el) || (Number(o.el.style.zIndex) || 0) <= z) continue;
    add(o.el.getBoundingClientRect());
  }
  for (const el of over) add(el.getBoundingClientRect());
  // The window's own menus and sheets over its body.
  for (const el of w.el.querySelectorAll('.sheet, .menu')) if (visible(el)) add(el.getBoundingClientRect());
  // The rounded corners: Leafdeck's own corner there, not the program's square one (all four without a title bar).
  if (!n.fullscreen && !w.max) {
    const radius = parseFloat(getComputedStyle(w.el).borderBottomLeftRadius) || 0;
    const k = Math.max(0, Math.ceil(radius - EDGE));
    if (k) {
      add({ left: area.left, top: area.bottom - k, right: area.left + k, bottom: area.bottom });
      add({ left: area.right - k, top: area.bottom - k, right: area.right, bottom: area.bottom });
      if (n.csd) {
        add({ left: area.left, top: area.top, right: area.left + k, bottom: area.top + k });
        add({ left: area.right - k, top: area.top, right: area.right, bottom: area.top + k });
      }
    }
  }
  return rects;
}

function sync() {
  if (!natives.size) {
    running = false;
    clearInterval(watchdog);
    return;
  }
  requestAnimationFrame(sync);
  tick();
}
// The page stops getting frames while a program covers all of it (full screen); this keeps the compositor told anyway.
let watchdog = 0;
let lastTick = 0;
function tick() {
  lastTick = performance.now();
  const scale = pageScale();
  const over = overlays();
  const frames = [];
  for (const n of natives.values()) {
    const w = n.frame;
    if (!w) continue;
    frames.push(w);
    const body = w.body;
    const r = body.getBoundingClientRect();
    const el = w.el;
    // Hidden while it's minimized, opening, closing or scaled (the overview, an animation): the program can't be.
    const show =
      !document.hidden &&
      !w.minimized &&
      visible(el) &&
      !/\b(opening|closing|minimizing)\b/.test(el.className) &&
      Math.abs(r.width - body.offsetWidth) < 1 &&
      Math.abs(r.height - body.offsetHeight) < 1 &&
      r.width > 2 * EDGE + 1 &&
      r.height > 2 * EDGE + 1;
    const s = sent.get(n.id) || {};
    if (!show) {
      if (s.place !== 'hidden') {
        cmd({ op: 'hide', id: n.id });
        sent.set(n.id, { place: 'hidden' });
      }
      continue;
    }
    // Clear of the resize handles, except in full screen or maximized (nothing to resize there).
    const e = n.fullscreen || w.max ? 0 : EDGE;
    const area = { left: r.left + e, top: r.top + (n.csd ? e : 0), right: r.right - e, bottom: r.bottom - e };
    const place = toComp({ x: area.left, y: area.top, w: area.right - area.left, h: area.bottom - area.top }, scale);
    const pk = `${place.x},${place.y},${place.w},${place.h}`;
    const covers = coversFor(n, area, over).map((c) => toComp(c, scale));
    const ck = covers.map((c) => `${c.x},${c.y},${c.w},${c.h}`).join(' ');
    if (s.place !== pk) cmd({ op: 'place', id: n.id, ...place });
    // Maximized or not, so the program's own maximize button and double click match.
    if (!!w.max !== n.maxSent) {
      n.maxSent = !!w.max;
      cmd({ op: 'maximized', id: n.id, on: n.maxSent });
    }
    if (s.place !== pk || s.cover !== ck) cmd({ op: 'cover', id: n.id, rects: covers });
    sent.set(n.id, { place: pk, cover: ck });
  }
  // Stacking, bottom to top, as Leafdeck's windows are.
  const order = frames.sort((a, b) => (Number(a.el.style.zIndex) || 0) - (Number(b.el.style.zIndex) || 0)).map((w) => w.nativeId).join(' ');
  if (order !== sentOrder) {
    sentOrder = order;
    cmd({ op: 'order', ids: order ? order.split(' ').map(Number) : [] });
  }
  // The keyboard follows the front window: a program's frame gives it to the program, any other window to Leafdeck.
  const a = activeWindow();
  if (a !== lastActive) {
    lastActive = a;
    const id = a?.nativeId || 0;
    if (id !== sentFocus) {
      sentFocus = id;
      cmd({ op: 'focus', id });
    }
  }
}

function start() {
  if (running) return;
  running = true;
  requestAnimationFrame(sync);
  watchdog = setInterval(() => natives.size && performance.now() - lastTick > 200 && tick(), 250);
}

export async function initNativeWindows() {
  if (!comp) return;
  shell.on('compositor:event', onEvent);
  // After a reload of this page, the windows that are open come again.
  if (await comp.ready().catch(() => false)) cmd({ op: 'list' });
}
export const _debug = { natives, sent, get drag() { return drag; } }; // for tests (~/ldtests/native)
