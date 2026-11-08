import { $, $$, esc, el, clamp, frame } from './util.js';
import { icon, appIcon } from './icons.js';
import { store } from './store.js';
import { shell } from './shell.js';
import { initScreens, announce, ownerOf, openElsewhere, openThere, screenAt as otherScreenAt, handOver, sessionKey, perScreen, screensInfo, isScreenPage, SCREEN, refreshInfo } from './screens.js';

export const MENUBAR_H = 30;
// Space kept clear for the Dock: it sits flush on the bottom edge, 62px tall at Dock size 1, and windows stop at its top.
export let DOCK_RESERVE = 62;
/** Settings → Desktop → Dock size: maximized windows keep clear of the Dock at its new size. */
export function setDockScale(scale) {
  const next = Math.round(62 * (Number(scale) || 1));
  if (next === DOCK_RESERVE) return;
  DOCK_RESERVE = next;
  relayout();
}
/* ---------------- App registry ---------------- */

export const registry = new Map();
const resolvers = [];
export const registerApp = (def) => registry.set(def.id, def);
/** Resolvers create app definitions on the fly (e.g. `link:<id>` connections). */
export const addResolver = (fn) => resolvers.push(fn);
export function getApp(id) {
  if (registry.has(id)) return registry.get(id);
  for (const f of resolvers) {
    const a = f(id);
    if (a) return a;
  }
  return null;
}

/* ---------------- Window state ---------------- */

export const wins = new Map();
let zTop = 100;
let active = null;
export const activeWindow = () => active;

const bus = new EventTarget();
export const onWM = (fn) => bus.addEventListener('wm', fn);
const emitWM = () => {
  bus.dispatchEvent(new Event('wm'));
  updateSeams();
  announce(); // one surface per screen: the other screens' pages know which windows are here
};

const LS_WIN = sessionKey('ws:windows'); // each screen's page keeps its own (one surface per screen, screens.js)
const session = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS_WIN)) || {};
  } catch {
    return {};
  }
})();
session.rects ||= {};
session.sizes ||= {}; // shared sizes by app.sizeKey, e.g. the last size you gave a browser window

/* Leafdeck OS: the open windows belong to one boot of the computer. Restarting Leafdeck brings them back; shutting down
   or restarting the computer, however it's done (a menu, the power button, `systemctl reboot`), starts empty. Where
   windows were and how big stay, as they do when a window is closed by hand. A list with no boot on it was saved by a
   version from before this, so it's restored. Elsewhere there's no boot id and windows always reopen. */
let bootId = '';
const fromOtherBoot = (s) => !!(bootId && s?.boot && s.boot !== bootId);
const forgetAtBoot = new Set();
/** A localStorage key that only means something until the computer shuts down: the file an app had open. */
export const forgetOnNewBoot = (key) => forgetAtBoot.add(key);

function saveSession() {
  if (bootId) session.boot = bootId;
  for (const w of wins.values()) {
    const r = w.max ? w.prev : w.rect;
    if (validRect(r)) session.rects[w.id] = { ...r, sized: !!w.sized, pinned: !!w.pinned, mini: w.mini ? w.miniPrev || {} : null, pair: w.pair || '' };
  }
  session.open = byZ().map((w) => w.id).reverse();
  localStorage.setItem(LS_WIN, JSON.stringify(session));
}

export function restoreSession(boot = '') {
  bootId = boot;
  if (fromOtherBoot(session)) {
    session.open = [];
    if (!isScreenPage) for (const k of forgetAtBoot) localStorage.removeItem(k);
    saveSession();
  }
  for (const id of session.open || []) if (getApp(id)) openApp(id, { restore: true });
  // Re-link pairs once both windows are back.
  for (const w of wins.values()) {
    const other = wins.get(session.rects[w.id]?.pair);
    if (other && !w.pair && !other.pair) pair(w, other, { arrange: false });
  }
}

const byZ = () => [...wins.values()].sort((a, b) => b.z - a.z);

/* ---------------- Screens ----------------
   Leafdeck OS can show its one window across several screens (Settings → Displays: a monitor beside a laptop, both panels
   of a Yoga Book 9). Each screen is a rect in page pixels; the first is the main one, with the menu bar and new
   windows, wherever it sits (and the Dock, unless it was put on another). Maximizing and snapping work per screen, and
   parts of the page that aren't on any screen (beside a smaller screen) are never left holding a window. Everywhere else there's one screen: the whole page. */
let layout = null; // [{ x, y, w, h }] in the compositor's pixels, top to bottom; null for one screen

/** Called with the screens Leafdeck's window covers (electron/ossystem.cjs layout()). */
export function setScreens(list) {
  layout = Array.isArray(list) && list.length > 1 ? list : null;
  const main = screens()[0];
  // The main screen's edges, for what's pinned to it in CSS (menu bar, notices, overlays).
  const root = document.documentElement.style;
  root.setProperty('--main-t', `${main.y}px`);
  root.setProperty('--main-l', `${main.x}px`);
  root.setProperty('--main-r', `${Math.max(0, innerWidth - main.x - main.w)}px`);
  root.setProperty('--main-b', `${Math.max(0, innerHeight - main.y - main.h)}px`);
  root.setProperty('--main-w', `${main.w}px`);
  root.setProperty('--main-h', `${main.h}px`);
  document.documentElement.classList.toggle('multi-screen', !!layout);
  placeDesktop();
  relayout();
  dispatchEvent(new Event('screens'));
}

/**
 * Leafdeck OS: at startup the page is a 1440×900 window until the session makes it full screen (electron/main.cjs), so
 * windows reopened then were fitted to that and lost their place on the other screens, and the briefing drew its blur
 * at the old size. Resolves once the window is full screen and the page has the shape of the screens' outline; right
 * away anywhere else, and after 5 seconds at most.
 */
export async function screensSettled(ms = 5000) {
  const info = await shell?.info?.().catch(() => null);
  if (!info?.session) return;
  const until = Date.now() + ms;
  // One surface per screen: the main window covers every screen until cage has given it its own (screens.js).
  while (!isScreenPage && !perScreen() && screensInfo().wanted && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    await refreshInfo();
  }
  while (Date.now() < until) {
    const [state, list] = await Promise.all([
      shell.info().catch(() => null),
      shell.os.layout().then((r) => r.screens || [], () => []),
    ]);
    if (state?.fullscreen && list.length) {
      const w = Math.max(...list.map((r) => r.x + r.w));
      const h = Math.max(...list.map((r) => r.y + r.h));
      if (Math.abs(innerWidth / innerHeight - w / h) < 0.02 * (w / h)) {
        if (list.length > 1 && !layout) setScreens(list); // before ostray.js has asked for them
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* Which screen the Dock and the desktop icons are on (Settings → Desktop), by connector name: the main one unless another
   is chosen, so the menu bar and new windows stay where they are. A screen that isn't connected falls back to the main
   one. Icons also pick a side. Widgets go anywhere (widgets.js); these are only the corner that those not yet placed
   start from, chosen in the Settings of older versions. */
const places = { dock: '', widgets: '', icons: '' };
const sides = { widgets: 'left', icons: 'right' };
const screenNamed = (name) => Math.max(0, name ? screens().findIndex((s) => s.name === name) : 0);
export function setDockScreen(name) {
  name = typeof name === 'string' ? name : '';
  if (name === places.dock) return;
  places.dock = name;
  placeDesktop();
  relayout();
  syncFullscreen();
}
/** { widgets: { screen, side }, icons: { screen, side } } from Settings → Desktop. */
export function setDesktopPlaces(opts) {
  for (const k of ['widgets', 'icons']) {
    places[k] = typeof opts[k]?.screen === 'string' ? opts[k].screen : '';
    sides[k] = ['left', 'right'].includes(opts[k]?.side) ? opts[k].side : k === 'widgets' ? 'left' : 'right';
  }
  placeDesktop();
}
/** The index of the screen the Dock is on. */
export const dockScreen = () => screenNamed(places.dock);
/** The corner that widgets with no place of their own yet flow from. */
export const widgetsHome = () => ({ n: screenNamed(places.widgets), side: sides.widgets, name: places.widgets });

/* Settings → Displays → Menu bar, Dock: other screens can have a menu bar and a Dock of their own as well, each chosen
   separately (by connector name). The menu bar's copies are menubar.js's; the Dock's are here (.dock-extra), drawn
   and working like #dock. */
const extra = { bars: [], docks: [] };
/** { bars, docks }: the connector names of the screens that get their own menu bar, and their own Dock. */
export function setExtraBars(opts) {
  const clean = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n) : []);
  const next = { bars: clean(opts?.bars), docks: clean(opts?.docks) };
  if (JSON.stringify(next) === JSON.stringify(extra)) return;
  Object.assign(extra, next);
  placeDesktop();
  relayout();
  dispatchEvent(new Event('screens'));
}
const extraScreens = (names) => (layout ? screens().flatMap((s, i) => (names.includes(s.name) ? [i] : [])) : []);
/** The indexes of the screens besides the main one that have a menu bar of their own. */
export const barScreens = () => extraScreens(extra.bars).filter((n) => n > 0);
/** The indexes of the screens besides the Dock's own that have a Dock of their own. */
const dockScreens = () => extraScreens(extra.docks).filter((n) => n !== dockScreen());
/* One surface per screen (screens.js): this page is one screen, and what Settings puts on a screen (by name) is on the
   page of that screen, or on the main page when it's on none (not chosen, or not connected). */
const myScreen = () => SCREEN || screensInfo().main;
function shownHere(name) {
  const info = screensInfo();
  if (name && info.screens.some((s) => s.name === name)) return name === myScreen();
  return !isScreenPage;
}
/** Is something placed on the screen called `name` on this page? (Every screen is, with one surface.) */
export const desktopHere = (name) => !perScreen() || shownHere(name);
/** Does screen `n` have a menu bar (the main one always does), or a Dock? */
export const hasBar = (n) => (perScreen() ? !isScreenPage || extra.bars.includes(myScreen()) : n === 0 || barScreens().includes(n));
const hasDock = (n) => (perScreen() ? shownHere(places.dock) || extra.docks.includes(myScreen()) : n === dockScreen() || dockScreens().includes(n));
const docks = () => $$('#dock, .dock-extra');
/** The Dock on screen `n` (the main Dock when that screen has none). */
const dockOn = (n) => $(`.dock-extra[data-screen="${n}"]`) || $('#dock');
/** A Dock at the bottom of each screen that has one of its own. */
function placeDocks() {
  const all = screens();
  const want = dockScreens();
  for (const d of $$('.dock-extra')) if (!want.includes(Number(d.dataset.screen))) d.remove();
  let added = false;
  for (const n of want) {
    let d = $(`.dock-extra[data-screen="${n}"]`);
    if (!d) {
      d = el(`<nav class="dock-extra" data-screen="${n}" aria-label="Dock"></nav>`);
      $('#dock').after(d);
      wireDock(d);
      added = true;
    }
    const s = all[n];
    Object.assign(d.style, { left: `${s.x}px`, right: `${Math.max(0, innerWidth - s.x - s.w)}px`, bottom: `${Math.max(0, innerHeight - s.y - s.h)}px` });
  }
  if (added) renderDock();
}
function placeDesktop() {
  const all = screens();
  const root = document.documentElement;
  const edges = (prefix, n, top = 0) => {
    const s = all[n];
    root.style.setProperty(`--${prefix}-t`, `${s.y + top}px`);
    root.style.setProperty(`--${prefix}-l`, `${s.x}px`);
    root.style.setProperty(`--${prefix}-r`, `${Math.max(0, innerWidth - s.x - s.w)}px`);
    root.style.setProperty(`--${prefix}-b`, `${Math.max(0, innerHeight - s.y - s.h)}px`);
  };
  const dock = dockScreen();
  edges('dock', dock);
  // Icons: below the menu bar on the main screen, clear of the Dock where it is (--ic-dock: 1 or 0).
  const iconScreen = screenNamed(places.icons);
  edges('ic', iconScreen, hasBar(iconScreen) ? MENUBAR_H : 0);
  root.style.setProperty('--ic-dock', hasDock(iconScreen) ? 1 : 0);
  root.dataset.iconsSide = sides.icons;
  if ($('#dock')) placeDocks();
  // One surface per screen: the menu bar, Dock and icons are on this page only when they're on its screen.
  const per = perScreen();
  root.classList.toggle('no-menubar', per && !hasBar(0));
  root.classList.toggle('no-dock', per && !hasDock(0));
  root.classList.toggle('no-icons', per && !shownHere(places.icons));
}
addEventListener('screens-windows', () => renderDock());
// The screens' names and places arrived or changed (screens.js).
addEventListener('screens-info', () => {
  placeDesktop();
  relayout();
});
export function screens() {
  if (!layout) return [{ x: 0, y: 0, w: innerWidth, h: innerHeight }];
  // Scaled to the page, which can differ from the compositor's pixels (zoom).
  const sx = innerWidth / Math.max(...layout.map((r) => r.x + r.w));
  const sy = innerHeight / Math.max(...layout.map((r) => r.y + r.h));
  return layout.map((r) => ({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy), internal: !!r.internal, name: r.name || '' }));
}
/** The screen a point is on (the main one when it's on none). */
const screenAt = (x, y) => Math.max(0, screens().findIndex((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h));
export const screenOf = (r) => screenAt(r.x + r.w / 2, r.y + Math.min(r.h / 2, 40));
/* Full screen (a video, a game, a program) fills the screen its window is on, and the other screens carry on. What sits
   above the windows on that screen steps aside, rather than the window being lifted over it: #windows is one layer, and
   lifting it would put every screen's windows over the switcher, the overview and the notices too. */
let fsHoles = [];
const zOf = (w) => Number(w.el.style.zIndex) || 0;
const fsCut = (holes, x = 0, y = 0) => holes.length ? `path(evenodd, 'M-9999 -9999H19999V19999H-9999z ${holes.map((s) => `M${s.x - x} ${s.y - y}h${s.w}v${s.h}h-${s.w}z`).join(' ')}')` : '';
/** A window behind a site's frame loses what's on the frame's screen. One in front of it stays whole, as it is anywhere. */
function cutForFullscreen(w) {
  const r = w.rect;
  const holes = w.el.classList.contains('web-fullscreen') ? [] : fsHoles.filter((s) => zOf(w) < s.z && r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y);
  w.el.style.clipPath = fsCut(holes, r.x, r.y);
}
onWM(() => {
  if (fsHoles.length) syncFullscreen(); // the order of the windows may have changed
});
export function syncFullscreen() {
  const taken = new Set();
  for (const w of wins.values()) {
    if (!w.el.matches('.nw-fs, .web-fullscreen')) continue;
    const n = screenOf(w.rect);
    // One screen: the CSS's own 100vw, because the page may still be growing to fill the monitor.
    const s = layout ? screens()[n] : {};
    for (const k of ['x', 'y', 'w', 'h']) {
      if (layout) w.el.style.setProperty(`--fs-${k}`, `${s[k]}px`);
      else w.el.style.removeProperty(`--fs-${k}`);
    }
    if (!w.minimized) taken.add(n);
  }
  /* A site's frame is under the page's root, which went full screen to keep the other screens alive (main.cjs,
     fit-site-fullscreen), so what the UI draws on the frame's screen is cut out of it. Only these, not the root: a clip
     on the root is a mask over the whole surface, and the other screens stop being drawn. */
  fsHoles = layout ? [...wins.values()].filter((w) => !w.minimized && w.el.classList.contains('web-fullscreen')).map((w) => ({ ...screens()[screenOf(w.rect)], z: zOf(w) })) : [];
  for (const id of ['wallpaper', 'desktop']) document.getElementById(id).style.clipPath = fsCut(fsHoles);
  for (const w of wins.values()) cutForFullscreen(w);
  const root = document.documentElement.classList;
  root.toggle('fs-main', taken.has(0));
  root.toggle('fs-dock', taken.has(dockScreen()));
  for (const b of $$('.menubar-extra, .dock-extra')) b.classList.toggle('fs-under', taken.has(Number(b.dataset.screen)));
}
addEventListener('screens', syncFullscreen);
/** Is a window's title bar on a screen? (Not in a gap beside a smaller screen, where no one would see it.) */
const titleOnScreen = (r) => screens().some((s) => r.x + r.w / 2 >= s.x && r.x + r.w / 2 < s.x + s.w && r.y + 14 >= s.y && r.y + 14 < s.y + s.h);

/** The on-screen keyboard (osk.js) covers the bottom of one screen; maximized windows there fit above it. */
let keyboard = null; // { screen, height }
export function setKeyboardArea(k) {
  keyboard = k;
  relayout();
}

/** Where windows go on a screen: clear of its menu bar and Dock, where it has them. */
export const workArea = (n = 0) => {
  const all = screens();
  const i = all[n] ? n : 0;
  const s = all[i];
  const top = hasBar(i) ? MENUBAR_H : 0;
  const area = { x: s.x, y: s.y + top, w: s.w, h: s.h - top - (hasDock(i) ? DOCK_RESERVE : 0) };
  if (keyboard?.screen === i) area.h = Math.max(160, Math.min(area.h, s.y + s.h - keyboard.height - area.y));
  return area;
};

/** Keep a rect usable on the current screen (also guards against a 0×0 viewport at load). */
function fitRect(r, min = [380, 260]) {
  // Fitted to the screen the window is on (the main one if it's on none): its title bar stays reachable.
  const n = screenOf({ x: r.x || 0, y: r.y || 0, w: r.w || 0, h: r.h || 0 });
  const s = screens()[n];
  const top = s.y + (hasBar(n) ? MENUBAR_H : 0);
  const w = Math.max(min[0], Math.min(r.w || 0, s.w));
  const h = Math.max(min[1], Math.min(r.h || 0, s.y + s.h - top - 8));
  const fitted = {
    w,
    h,
    x: clamp(r.x || 0, s.x + 120 - w, Math.max(s.x, s.x + s.w - 120)),
    y: clamp(r.y || 0, top, Math.max(top, s.y + s.h - 60)),
  };
  // Left beside a smaller screen (or the screen it was on is gone): onto the main screen.
  if (!titleOnScreen(fitted)) {
    const a = workArea(0);
    return { w: Math.min(w, a.w), h: Math.min(h, a.h), x: a.x + Math.max(8, Math.round((a.w - Math.min(w, a.w)) / 2)), y: a.y + 8 };
  }
  return fitted;
}
const validRect = (r) => r && r.w >= 200 && r.h >= 150;

function applyRect(w) {
  if (fsHoles.length) cutForFullscreen(w);
  const s = w.el.style;
  s.left = w.rect.x + 'px';
  s.top = w.rect.y + 'px';
  s.width = w.rect.w + 'px';
  s.height = w.rect.h + 'px';
  updateSeams();
}

/* ---------------- Flush neighbors ----------------
   Two windows whose edges touch (snapped halves, a pair) get square inner corners so they read as one
   surface, and a divider on the seam: drag it to move the split, resizing both windows at once. */

const SEAM_TOLERANCE = 1.5;
const seams = new Map(); // "leftId|rightId" -> divider element
let seamQueued = false;
function updateSeams() {
  if (seamQueued) return;
  seamQueued = true;
  requestAnimationFrame(() => {
    seamQueued = false;
    drawSeams();
  });
}
function drawSeams() {
  const vis = [...wins.values()].filter((w) => !w.minimized && !w.max && !w.mini && !w.el.classList.contains('closing'));
  const found = new Map();
  for (const L of vis) {
    for (const R of vis) {
      if (L === R || Math.abs(R.rect.x - (L.rect.x + L.rect.w)) > SEAM_TOLERANCE) continue;
      const top = Math.max(L.rect.y, R.rect.y);
      const bottom = Math.min(L.rect.y + L.rect.h, R.rect.y + R.rect.h);
      if (bottom - top > 60) found.set(`v:${L.id}|${R.id}`, { L, R, top, bottom });
    }
  }
  // Stacked: one window's bottom edge on the other's top edge.
  for (const T of vis) {
    for (const B of vis) {
      if (T === B || Math.abs(B.rect.y - (T.rect.y + T.rect.h)) > SEAM_TOLERANCE) continue;
      const left = Math.max(T.rect.x, B.rect.x);
      const right = Math.min(T.rect.x + T.rect.w, B.rect.x + B.rect.w);
      if (right - left > 60) found.set(`h:${T.id}|${B.id}`, { T, B, left, right });
    }
  }
  const sides = { 'flush-r': new Set(), 'flush-l': new Set(), 'flush-b': new Set(), 'flush-t': new Set() };
  for (const f of found.values()) {
    if (f.L) (sides['flush-r'].add(f.L), sides['flush-l'].add(f.R));
    else (sides['flush-b'].add(f.T), sides['flush-t'].add(f.B));
  }
  for (const w of wins.values()) for (const [cls, set] of Object.entries(sides)) w.el.classList.toggle(cls, set.has(w));
  for (const [key, el] of seams) if (!found.has(key) && !el.classList.contains('active')) (el.remove(), seams.delete(key));
  for (const [key, f] of found) {
    let el = seams.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = `win-seam ${key[0]}`; // v = side by side (drag sideways), h = stacked (drag up/down)
      el.title = 'Drag to resize both windows';
      el.addEventListener('pointerdown', (e) => startSeamDrag(key, e));
      $('#windows').append(el);
      seams.set(key, el);
    }
    const [a, b] = f.L ? [f.L, f.R] : [f.T, f.B];
    Object.assign(
      el.style,
      f.L
        ? { left: f.R.rect.x + 'px', top: f.top + 'px', width: '', height: f.bottom - f.top + 'px' }
        : { left: f.left + 'px', top: f.B.rect.y + 'px', width: f.right - f.left + 'px', height: '' },
      // Level with the front-most of the two, and after them in the DOM, so it sits on top of both
      // but under any other window that overlaps the seam.
      { zIndex: Math.max(Number(a.el.style.zIndex) || 0, Number(b.el.style.zIndex) || 0) },
    );
  }
}
function startSeamDrag(key, e) {
  const [lid, rid] = key.slice(2).split('|');
  const L = wins.get(lid);
  const R = wins.get(rid);
  const el = seams.get(key);
  if (!L || !R || !el) return;
  e.preventDefault();
  e.stopPropagation();
  if (key[0] === 'h') return startStackDrag(L, R, el, e); // L is the top window, R the bottom one
  const sx = e.clientX;
  const left = L.rect.x;
  const right = R.rect.x + R.rect.w;
  const split = R.rect.x;
  const lmin = (L.app.min || [380])[0];
  const rmin = (R.app.min || [380])[0];
  el.classList.add('active');
  track(
    L,
    (ev) => {
      const x = clamp(split + ev.clientX - sx, left + lmin, right - rmin);
      L.rect = { ...L.rect, w: x - left };
      R.rect = { ...R.rect, x, w: right - x };
      L.sized = R.sized = true;
      applyRect(L);
      applyRect(R);
    },
    () => {
      el.classList.remove('active');
      updateSeams();
    },
    [L, R],
  );
}
/** The divider between a window and the one stacked under it: move the split up or down. */
function startStackDrag(T, B, el, e) {
  const sy = e.clientY;
  const top = T.rect.y;
  const bottom = B.rect.y + B.rect.h;
  const split = B.rect.y;
  const tmin = (T.app.min || [0, 260])[1];
  const bmin = (B.app.min || [0, 260])[1];
  el.classList.add('active');
  track(
    T,
    (ev) => {
      const y = clamp(split + ev.clientY - sy, top + tmin, bottom - bmin);
      T.rect = { ...T.rect, h: y - top };
      B.rect = { ...B.rect, y, h: bottom - y };
      T.sized = B.sized = true;
      applyRect(T);
      applyRect(B);
    },
    () => {
      el.classList.remove('active');
      updateSeams();
    },
    [T, B],
  );
}

/* ---------------- Open / close ---------------- */

/* ---------------- Recently used windows (the search's "Recent" list) ---------------- */

const LS_RECENT = 'ws:recent-windows';
let recent = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS_RECENT)) || [];
  } catch {
    return [];
  }
})();
const saveRecent = () => {
  try {
    localStorage.setItem(LS_RECENT, JSON.stringify(recent));
  } catch {}
};
/** Note a window as just used: apps by id, sites by address. Burner windows are never remembered. */
function noteRecent(w) {
  if (!w?.app || w.app.burner || w.el.classList.contains('burner')) return;
  let url = '';
  try {
    url = w.web?.url?.() || '';
  } catch {}
  const title = $('.win-title-text', w.el)?.textContent || w.app.name;
  const key = url && w.id.startsWith('web:') ? 'url:' + url.replace(/#.*$/, '') : 'id:' + w.id;
  recent = recent.filter((r) => r.key !== key && r.id !== w.id);
  recent.unshift({ key, id: w.id, url: w.id.startsWith('web:') ? url : '', title, at: Date.now() });
  recent.length = Math.min(recent.length, 30);
  saveRecent();
}
/** Recently used windows, newest first, each marked `open` if it's still on screen. */
export function recentWindows() {
  return recent.map((r) => ({ ...r, open: wins.has(r.id) }));
}

export function openApp(id, opts = {}) {
  // One surface per screen: a window that's on another screen comes forward there (never twice).
  if (!wins.has(id) && ownerOf(id)) {
    if (!opts.restore) openThere(id, opts);
    return null;
  }
  const app = getApp(id);
  if (!app) return null;
  if (app.launch && app.launch(opts) === false) return null;
  let w = wins.get(id);
  const fresh = !w;
  if (fresh) w = createWindow(app, opts.screen);
  if (w.minimized) restore(w);
  focus(w);
  renderDock();
  if (fresh && !opts.restore) bounce(id);
  if (opts.record) app.openRecord?.(w, opts.record);
  if (opts.tab) app.openTab?.(w, opts.tab);
  if (opts.folder != null) app.openFolder?.(w, opts.folder);
  if (opts.create) app.create?.(w, opts.create);
  if (opts.reveal) app.reveal?.(w, opts.reveal); // Files: show a file or folder
  if (opts.open) app.openFile?.(w, opts.open); // Files: open a file (a preview, or its app)
  if (opts.file) app.openFile?.(w, opts.file); // Image Viewer: a picture
  if (opts.cwd && !fresh) app.openHere?.(w, opts.cwd); // Terminal: a new tab in a folder (a new window starts there)
  saveSession();
  return w;
}

const LIGHT_GLYPHS = {
  close: '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>',
  min: '<svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg>',
  max: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5"/></svg>',
  mini: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5"/><rect x="6" y="6" width="4.5" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>',
};

/** Default browser window: 16:11, as large as fits comfortably (up to 1600 wide). */
function browserSize(a) {
  let w = Math.min(1600, a.w - 60);
  let h = Math.round((w * 11) / 16);
  if (h > a.h - 24) {
    h = a.h - 24;
    w = Math.round((h * 16) / 11);
  }
  return [w, h];
}

/** A new window, on screen `n` (opened from that screen's Dock) or the main one. */
function createWindow(app, n) {
  const a = workArea(n ?? 0);
  // Browser windows (sizeKey 'browser') share the last size you resized one to; otherwise 16:11.
  const shared = app.sizeKey && session.sizes[app.sizeKey];
  const [dw, dh] = shared ? [shared.w, shared.h] : app.size === 'browser' ? browserSize(a) : app.size || [900, 600];
  let saved = validRect(session.rects[app.id]) ? session.rects[app.id] : null;
  // A browser window you never resized by hand opens fresh, centered at the current default size.
  if (saved && app.sizeKey && !saved.sized) saved = null;
  const flags = session.rects[app.id] || {};
  if (flags.mini && validRect(flags)) saved = { ...flags };
  // Where it was last, but on the screen it's opened from: the same spot on that screen.
  if (saved && n != null && screens()[n] && screenOf(saved) !== n) {
    const from = screens()[screenOf(saved)];
    const to = screens()[n];
    saved = { ...saved, x: saved.x - from.x + to.x, y: saved.y - from.y + to.y };
  }
  const count = wins.size;
  let rect = saved ? { ...saved } : { w: Math.min(dw, a.w - 40), h: Math.min(dh, a.h - 24), x: 0, y: 0 };
  if (!saved) {
    // Cascade new windows, but keep big ones (like 16:11 browser windows) fully on screen.
    rect.x = a.x + clamp(Math.round((a.w - rect.w) / 2 + 60 + (count % 6) * 26), 8, Math.max(8, a.w - rect.w - 8));
    rect.y = clamp(Math.round(a.y + 18 + (count % 6) * 26), a.y + 8, Math.max(a.y + 8, a.y + a.h - rect.h));
  }
  rect = fitRect(rect, app.min);

  const node = el(`
    <div class="win opening" data-app="${esc(app.id)}" role="dialog" aria-label="${esc(app.name)}">
      <div class="win-bar">
        <div class="win-title">${appIcon(titleIcon(app))}<span class="win-title-text">${esc(app.name)}</span>
          <button class="win-flag win-pin" data-wa="unpin" title="Kept on top — click to release">${icon('pin', 11)}</button>
          <button class="win-flag win-pair" data-wa="unpair" title="Paired with another window — click to unpair">${icon('link', 11)}</button></div>
        <div class="win-tools"></div>
        <div class="lights">
          <button class="light l-mini" data-wa="mini" aria-label="Mini window" title="Mini window (Alt+Shift+↓)">${LIGHT_GLYPHS.mini}</button>
          <button class="light l-min" data-wa="min" aria-label="Minimize" title="Minimize">${LIGHT_GLYPHS.min}</button>
          <button class="light l-max" data-wa="max" aria-label="Maximize" title="Maximize">${LIGHT_GLYPHS.max}</button>
          <button class="light l-close" data-wa="close" aria-label="Close" title="Close">${LIGHT_GLYPHS.close}</button>
        </div>
      </div>
      <div class="win-body"></div>
      ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="rz rz-${d}" data-rz="${d}"></div>`).join('')}
    </div>`);

  const w = {
    id: app.id,
    app,
    el: node,
    body: $('.win-body', node),
    tools: $('.win-tools', node),
    rect,
    sized: !!session.rects[app.id]?.sized, // resized by hand (so its own size wins over the default)
    prev: null,
    max: false,
    minimized: false,
    z: 0,
    cleanups: [],
    /** Re-run `fn` (once per frame) whenever any of `cols` change. */
    watch(cols, fn) {
      const f = frame(fn);
      const h = (e) => {
        const c = e.detail.col;
        if (c === '*' || cols.includes(c)) f();
      };
      store.addEventListener('change', h);
      this.cleanups.push(() => store.removeEventListener('change', h));
    },
    every(ms, fn) {
      const t = setInterval(fn, ms);
      this.cleanups.push(() => clearInterval(t));
    },
    setTitle(t) {
      $('.win-title-text', node).textContent = t;
    },
    sheet: (content) => openSheet(w, content),
    close: () => closeWindow(w),
  };

  applyRect(w);
  $('#windows').append(node);
  wins.set(app.id, w);

  node.addEventListener('pointerdown', () => focus(w), true);
  // The title bar moves the window, and so does a browser's tab strip (.win-tabs, which also holds its controls), and
  // so does any .win-drag of an app that draws its own top row (mergeTitleBar).
  const onBar = (e) => e.target.closest('.win-bar, .win-tabs')?.parentNode === node || (node.classList.contains('merged') && !node.classList.contains('mini') && !!e.target.closest('.win-drag'));
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !onBar(e) || e.target.closest('button, input, select, textarea, a, label, .no-drag')) return;
    startDrag(w, e);
  });
  node.addEventListener('dblclick', (e) => {
    if (onBar(e) && !e.target.closest('button, input, select, textarea, a, label, .no-drag')) toggleMax(w);
  });
  node.addEventListener('click', (e) => {
    const b = e.target.closest('.win-bar [data-wa], .win-tabs [data-wa], .lights [data-wa]');
    if (!b) return;
    ({ close: closeWindow, min: minimize, max: toggleMax, mini: toggleMini, unpin: (x) => togglePinned(x, false), unpair })[b.dataset.wa]?.(w);
  });
  if (flags.pinned) togglePinned(w, true);
  setScheme(w, store.prefs.appSchemes?.[app.id], { save: false });
  if (flags.mini) {
    w.mini = true;
    w.miniPrev = flags.mini;
    node.classList.add('mini');
    if (!w.pinned) togglePinned(w, true);
  }
  $$('[data-rz]', node).forEach((h) => h.addEventListener('pointerdown', (e) => startResize(w, e, h.dataset.rz)));

  try {
    app.mount(w);
  } catch (err) {
    console.error(err);
    w.body.innerHTML = `<div class="empty">Something went wrong opening ${esc(app.name)}.<br><small>${esc(err.message)}</small></div>`;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('opening')));
  return w;
}

/**
 * An app that draws its own top row: the title bar goes, and the window controls move into `host` (the app's row). Its
 * .win-drag areas move the window and double-click to maximize. A mini window gets its title bar back.
 */
export function mergeTitleBar(w, host) {
  const lights = $('.lights', w.el);
  const bar = $('.win-bar', w.el);
  w.el.classList.add('merged');
  const place = () => {
    const home = w.el.classList.contains('mini') ? bar : host;
    if (lights.parentNode !== home) home.append(lights);
  };
  place();
  const mo = new MutationObserver(place);
  mo.observe(w.el, { attributes: true, attributeFilter: ['class'] });
  w.cleanups.push(() => mo.disconnect());
}

export function closeWindow(w, force = false) {
  if (!wins.has(w.id)) return;
  // An app with unsaved work (Text Editor) can ask first; it resolves false to stay open.
  if (!force && w.app.canClose) {
    Promise.resolve(w.app.canClose(w)).then((ok) => ok && closeWindow(w, true));
    return;
  }
  noteRecent(w); // with its final title and address, so it can be reopened from the search
  unpair(w);
  badges.delete(w.id);
  w.cleanups.forEach((f) => f());
  w.app.unmount?.(w);
  wins.delete(w.id);
  syncFullscreen();
  w.el.classList.add('closing');
  setTimeout(() => w.el.remove(), 180);
  if (active === w) {
    active = null;
    focusTop();
  }
  renderDock();
  saveSession();
  emitWM();
}

export function focus(w) {
  if (active === w && w.z === zTop) return;
  active?.el.classList.remove('active');
  // A focused <webview> in another window would swallow the next click without raising its window.
  const ae = document.activeElement;
  if (ae && ae !== document.body && !w.el.contains(ae)) ae.blur();
  active = w;
  const partner = wins.get(w.pair);
  if (partner && !partner.minimized) {
    partner.z = ++zTop;
    applyZ(partner);
  }
  w.z = ++zTop;
  applyZ(w);
  w.el.classList.add('active');
  noteRecent(w);
  emitWM();
}

/* Clicks inside an embedded page (a <webview> or <iframe>: an embedded connection, a PDF, Designer's previews, DevTools)
   never reach this document, so a click there couldn't raise its window. The page taking focus does reach it: raise the
   window it's in. A focus event when there is one; otherwise this document loses focus with the frame left active. */
function raiseFrameWindow(t) {
  if (!t || !/^(WEBVIEW|IFRAME)$/.test(t.tagName)) return;
  const node = t.closest('.win');
  const w = node && [...wins.values()].find((x) => x.el === node);
  if (!w || active === w) return;
  closeMenu();
  focus(w);
}
document.addEventListener('focusin', (e) => raiseFrameWindow(e.target));
addEventListener('blur', () => setTimeout(() => raiseFrameWindow(document.activeElement)));

// Pinned ("keep on top") windows sit above everything else, in their own stacking order.
const applyZ = (w) => {
  w.el.style.zIndex = w.z + (w.pinned ? 1_000_000 : 0);
  updateSeams();
};

/* ---------------- Keep on top, mini windows ---------------- */

export function togglePinned(w, on = !w.pinned) {
  if (!w) return;
  w.pinned = !!on;
  w.el.classList.toggle('pinned', w.pinned);
  applyZ(w);
  saveSession();
  emitWM();
}

/* ---------------- Light / dark per window ---------------- */

/** Window → Appearance: 'light' or 'dark' for this app's window, or '' to match Leafdeck (Settings → Appearance).
    Kept in prefs.appSchemes by app id (not for temporary web page windows). A site window's pages follow it too. */
export function setScheme(w, scheme, { save = true } = {}) {
  if (!w) return;
  w.scheme = ['light', 'dark'].includes(scheme) ? scheme : '';
  if (w.scheme) w.el.dataset.scheme = w.scheme;
  else delete w.el.dataset.scheme;
  w.web?.setScheme?.(w.scheme);
  if (!save || w.id.startsWith('web:')) return;
  const { [w.id]: _, ...rest } = store.prefs.appSchemes || {};
  store.setPrefs({ appSchemes: w.scheme ? { ...rest, [w.id]: w.scheme } : rest });
}

export const schemeMenuItems = (w) => [
  { header: 'Appearance' },
  ...[['', 'Match Leafdeck'], ['light', 'Light'], ['dark', 'Dark']].map(([s, label]) => ({ label, checked: !!w && (w.scheme || '') === s, disabled: !w, act: () => setScheme(w, s) })),
];

const MINI = { w: 400, h: 225 + 36 }; // a 16:9 picture plus the title bar

/** Mini mode: a small always-on-top window in the bottom-right corner (a lecture, a call); toggling back restores it. */
export function toggleMini(w, on = !w.mini) {
  if (!w || on === !!w.mini) return;
  if (on) {
    w.miniPrev = { rect: w.max ? { ...w.prev } : { ...w.rect }, max: !!w.max, pinned: !!w.pinned };
    if (w.max) {
      w.max = false;
      w.el.classList.remove('max');
    }
    unpair(w);
    w.mini = true;
    w.el.classList.add('mini');
    const a = workArea();
    w.rect = { w: MINI.w, h: MINI.h, x: a.x + Math.max(0, a.w - MINI.w - 16), y: Math.max(a.y, a.y + a.h - MINI.h - 8) };
    applyRect(w);
    if (!w.pinned) togglePinned(w, true);
  } else {
    const p = w.miniPrev || {};
    w.mini = false;
    w.el.classList.remove('mini');
    if (!p.pinned && w.pinned) togglePinned(w, false);
    w.rect = fitRect(p.rect || w.rect, w.app.min);
    if (p.max) {
      w.prev = { ...w.rect };
      w.rect = workArea(screenOf(w.rect));
      w.max = true;
      w.el.classList.add('max');
    }
    applyRect(w);
    w.miniPrev = null;
  }
  focus(w);
  saveSession();
  emitWM();
}

/* ---------------- Snapping and pairs ---------------- */

const SNAP_GAP = 8; // around the outside of snapped windows
const MID_GAP = 0; // between two side-by-side windows: flush
/** The screen halves (and the whole work area for "top"). The halves meet flush in the middle. */
function zones(n = 0) {
  const a = workArea(n);
  const g = SNAP_GAP;
  const x0 = a.x;
  const mid = Math.round(a.w / 2);
  const midY = Math.round(a.y + a.h / 2);
  return {
    left: { x: x0 + g, y: a.y + g, w: mid - g - MID_GAP / 2, h: a.h - g * 2 },
    right: { x: x0 + mid + MID_GAP / 2, y: a.y + g, w: a.w - mid - g - MID_GAP / 2, h: a.h - g * 2 },
    // Quarters (drag into a screen corner): stacked windows meet flush too.
    tl: { x: x0 + g, y: a.y + g, w: mid - g, h: midY - a.y - g },
    tr: { x: x0 + mid, y: a.y + g, w: a.w - mid - g, h: midY - a.y - g },
    bl: { x: x0 + g, y: midY, w: mid - g, h: a.y + a.h - g - midY },
    br: { x: x0 + mid, y: midY, w: a.w - mid - g, h: a.y + a.h - g - midY },
    top: { ...a },
  };
}
/** Which snap zone the pointer is in while dragging: an edge snaps to a half (top maximizes), a corner to a quarter. */
const CORNER = 140;
let snapScreen = 0; // the screen the snap preview is on
function snapZoneAt(x, y) {
  snapScreen = screenAt(x, y);
  const s = screens()[snapScreen];
  const top = s.y + (hasBar(snapScreen) ? MENUBAR_H : 0);
  const atL = x <= s.x + 6;
  const atR = x >= s.x + s.w - 6;
  const atT = y <= top + 2;
  const atB = y >= s.y + s.h - 6;
  if (!atL && !atR && !atT && !atB) return null;
  const nearT = y < top + CORNER;
  const nearB = y > s.y + s.h - CORNER;
  const nearL = x < s.x + CORNER;
  const nearR = x > s.x + s.w - CORNER;
  if (nearL && nearT) return 'tl';
  if (nearR && nearT) return 'tr';
  if (nearL && nearB) return 'bl';
  if (nearR && nearB) return 'br';
  return atL ? 'left' : atR ? 'right' : atT ? 'top' : null;
}
let snapEl = null;
let snapZone = null;
function showSnap(zone) {
  if (zone === snapZone) return;
  snapZone = zone;
  if (!zone) {
    snapEl?.remove();
    snapEl = null;
    return;
  }
  if (!snapEl) {
    snapEl = el('<div id="snap-preview"></div>');
    document.body.append(snapEl);
  }
  const z = zones(snapScreen)[zone];
  Object.assign(snapEl.style, { left: z.x + 'px', top: z.y + 'px', width: z.w + 'px', height: z.h + 'px' });
}

/** Snap a window to the left or right half, or maximize it ("top"), on screen `n` (default: the one it's on). */
export function snapTo(w, zone, n) {
  if (!w) return;
  if (w.mini) toggleMini(w, false);
  n ??= screenOf(w.rect);
  if (zone === 'top') {
    if (!w.max) toggleMax(w, n);
    return;
  }
  if (w.max) {
    w.max = false;
    w.el.classList.remove('max');
  }
  w.el.classList.add('animating');
  w.rect = fitRect(zones(n)[zone], w.app.min);
  w.sized = true;
  applyRect(w);
  setTimeout(() => w.el.classList.remove('animating'), 280);
  saveSession();
}

/** Pair two windows side by side (a on the left); they then move and resize together. */
export function pair(a, b, { arrange = true } = {}) {
  if (!a || !b || a === b) return;
  unpair(a);
  unpair(b);
  if (arrange) {
    snapTo(a, 'left');
    snapTo(b, 'right');
  }
  a.pair = b.id;
  b.pair = a.id;
  a.el.classList.add('paired');
  b.el.classList.add('paired');
  if (b.minimized) restore(b);
  if (a.minimized) restore(a);
  focus(a);
  saveSession();
  emitWM();
}
export function unpair(w) {
  if (!w?.pair) return;
  const p = wins.get(w.pair);
  if (p) {
    p.pair = '';
    p.el.classList.remove('paired');
  }
  w.pair = '';
  w.el.classList.remove('paired');
  saveSession();
  emitWM();
}

/* ---------------- Dock badges (unread counts from page titles) ---------------- */

const badges = new Map(); // window id -> count

/** Unread counts sites put in their titles: "(3) Inbox", "Inbox (3) - Gmail", "[2] Chat". Years like (2019) are ignored. */
export function badgeFromTitle(title) {
  const t = String(title || '');
  const m = t.match(/^\s*[([](\d{1,3})\+?[)\]]/) || t.match(/[([](\d{1,3})\+?[)\]]\s*(?:[-–—·|]|$)/);
  return m ? Number(m[1]) : 0;
}

export function setBadge(id, n) {
  const v = Math.max(0, Math.min(9999, Number(n) || 0));
  if ((badges.get(id) || 0) === v) return;
  if (v) badges.set(id, v);
  else badges.delete(id);
  for (const item of $$(`#dock [data-app="${CSS.escape(id)}"], .dock-extra [data-app="${CSS.escape(id)}"]`)) {
    let b = $('.dock-badge', item);
    if (!v) {
      b?.remove();
      continue;
    }
    if (!b) {
      b = el('<i class="dock-badge"></i>');
      item.append(b);
    }
    b.textContent = v > 99 ? '99+' : String(v);
  }
}
const badgeHtml = (id) => (badges.get(id) ? `<i class="dock-badge">${badges.get(id) > 99 ? '99+' : badges.get(id)}</i>` : '');

function focusTop() {
  const top = byZ().find((x) => !x.minimized);
  if (top) focus(top);
  else {
    active = null;
    emitWM();
  }
}

export function minimize(w) {
  if (w.minimized) return;
  const target = $(`[data-app="${CSS.escape(w.id)}"]`, dockOn(screenOf(w.rect))) || $(`#dock [data-app="${CSS.escape(w.id)}"]`);
  const r = w.el.getBoundingClientRect();
  const t = target?.getBoundingClientRect();
  const dx = t ? t.left + t.width / 2 - (r.left + r.width / 2) : 0;
  const dy = t ? t.top + t.height / 2 - (r.top + r.height / 2) : innerHeight;
  w.el.style.setProperty('--mx', dx + 'px');
  w.el.style.setProperty('--my', dy + 'px');
  w.el.classList.add('minimizing');
  w.minimized = true;
  syncFullscreen();
  setTimeout(() => w.minimized && w.el.classList.add('hidden'), 340);
  if (active === w) {
    w.el.classList.remove('active');
    active = null;
    focusTop();
  }
  renderDock();
  emitWM();
}

export function restore(w) {
  if (!w.minimized) return;
  w.minimized = false;
  syncFullscreen();
  w.el.classList.remove('hidden');
  void w.el.offsetWidth;
  w.el.classList.remove('minimizing');
  renderDock();
  emitWM();
}

export function toggleMax(w, n) {
  w.el.classList.add('animating');
  if (w.max) {
    w.rect = fitRect(w.prev);
    w.max = false;
  } else {
    w.prev = { ...w.rect };
    w.rect = workArea(n ?? screenOf(w.rect));
    w.max = true;
  }
  w.el.classList.toggle('max', w.max);
  applyRect(w);
  setTimeout(() => w.el.classList.remove('animating'), 280);
  saveSession();
}

/** Put a window at a saved position and size (used by layouts); `max` maximizes it with that rect as its restore size. */
export function setRect(w, rect, max = false) {
  if (!w || !rect) return;
  w.el.classList.remove('max');
  w.max = false;
  w.rect = fitRect(rect, w.app.min);
  w.sized = true;
  if (max) {
    w.prev = { ...w.rect };
    w.rect = workArea(screenOf(w.rect));
    w.max = true;
    w.el.classList.add('max');
  }
  applyRect(w);
  saveSession();
}

export const minimizeAll = () => [...wins.values()].forEach(minimize);
export const closeAll = () => [...wins.values()].forEach(closeWindow);

function relayout() {
  const n = screens().length;
  for (const w of wins.values()) {
    const on = screenOf(w.rect);
    w.rect = w.max ? workArea(on < n ? on : 0) : fitRect(w.rect);
    applyRect(w);
  }
}
addEventListener('resize', () => (layout ? setScreens(layout) : relayout()));

/* ---------------- Drag & resize ---------------- */

/* Resizing a window resizes the pages embedded in it (webviews, iframes), and every new size makes the whole desktop
   wait for each of those pages to paint at it: a browser window resizes at ~14 fps, against 57 for a window without
   one. So while a resize handle or a seam is held, embedded pages keep their size (the window's body hides what
   sticks out) and take the new size only when the pointer rests, and on release. Not now and then while it keeps
   moving: a big page takes a few hundred ms to lay out and paint at a new size, and the desktop waits for it. */
const CATCH_UP_REST = 90; // ms the pointer has to rest before the embedded pages take the window's new size
function holdEmbeds(windows) {
  const views = windows.flatMap((w) => $$('webview, iframe', w.el));
  const fix = () => {
    const sizes = views.map((v) => [v.offsetWidth, v.offsetHeight]); // read everything before writing anything
    views.forEach((v, i) => {
      v.style.width = sizes[i][0] + 'px';
      v.style.height = sizes[i][1] + 'px';
    });
  };
  const free = () => views.forEach((v) => (v.style.width = v.style.height = ''));
  windows.forEach((w) => w.el.classList.add('resizing'));
  fix();
  let rest = 0;
  const catchUp = () => {
    clearTimeout(rest);
    rest = 0;
    free();
    fix();
  };
  return {
    tick() {
      clearTimeout(rest);
      rest = setTimeout(catchUp, CATCH_UP_REST);
    },
    release() {
      clearTimeout(rest);
      free();
      windows.forEach((w) => w.el.classList.remove('resizing'));
    },
  };
}

/** Follow the pointer until it's released: `apply(event)` once a frame. `held`: windows whose embedded pages are being resized. */
function track(w, apply, onEnd, held, ext) {
  document.body.classList.add('wm-busy');
  const hold = held && holdEmbeds(held);
  // High-rate mice fire many pointermoves per frame; apply only the latest one each frame.
  let pending = null;
  const onMove = (ev) => {
    if (!pending) requestAnimationFrame(() => {
      if (pending) {
        apply(pending);
        hold?.tick();
      }
      pending = null;
    });
    pending = ev;
  };
  const up = () => {
    if (pending) apply(pending);
    pending = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', up);
    hold?.release();
    document.body.classList.remove('wm-busy');
    w.el.classList.remove('dragging');
    onEnd?.();
    saveSession();
  };
  // A program's own title bar (nativewin.js): the compositor reports the pointer instead of this page.
  if (ext) {
    ext.move = onMove;
    ext.up = up;
    return;
  }
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', up);
}

function startDrag(w, e, ext) {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  if (w.max) {
    const ratio = (sx - w.rect.x) / w.rect.w;
    w.max = false;
    w.el.classList.remove('max');
    w.rect = { ...w.prev, x: sx - w.prev.w * ratio, y: Math.max(MENUBAR_H, sy - 14) }; // title bar stays under the pointer
    applyRect(w);
  }
  const { x, y } = w.rect;
  const partner = wins.get(w.pair);
  const pStart = partner && !partner.minimized ? { ...partner.rect } : null;
  const last = { x: sx, y: sy }; // where the pointer is (it can be on another screen: one surface per screen)
  w.el.classList.add('dragging');
  track(
    w,
    (ev) => {
      last.x = ev.clientX;
      last.y = ev.clientY;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      w.rect.x = x + dx;
      w.rect.y = clamp(y + dy, MENUBAR_H, innerHeight - 50);
      applyRect(w);
      if (pStart) {
        partner.rect.x = pStart.x + dx;
        partner.rect.y = clamp(pStart.y + dy, MENUBAR_H, innerHeight - 50);
        applyRect(partner);
      }
      // Near a screen edge: show where the window would snap (not for mini windows or pairs).
      const zone = w.mini || pStart ? null : snapZoneAt(ev.clientX, ev.clientY);
      showSnap(zone);
    },
    () => {
      const zone = snapZone;
      showSnap(null);
      // Let go over another screen (one surface per screen): that screen's page takes the window, the title bar
      // under the pointer as it was.
      const there = !pStart && !ext && !STAY.test(w.id) ? otherScreenAt(last.x, last.y) : null;
      if (there) return moveToScreen(w, there.page, { ...w.rect, x: there.x - (sx - x), y: Math.max(MENUBAR_H, there.y - (sy - y)) });
      if (zone) snapTo(w, zone, snapScreen);
      else if (!titleOnScreen(w.rect)) {
        // Dropped beside a smaller screen, where no one would see it: back onto the screen nearest the pointer.
        w.rect = fitRect(w.rect, w.app.min);
        applyRect(w);
      }
    },
    null,
    ext,
  );
}

/* ---------------- One surface per screen: windows moving between screens (screens.js) ---------------- */

/* Windows that stay on their page for now: DevTools (attached to a site in this page), the app display (its VNC is the
   main page's), the Claude chat (its conversation lives in this page) and programs' own windows (cage frames them for
   the main page). Dropped on another screen, they stay where they are. */
const STAY = /^(devtools:|appdisplay$|claude|nw:)/; // claude: the chat and Claude Code

/** Hands a window to another screen's page ('main' or a connector name), to show at `rect` (that page's pixels). Here it
 *  closes the way a reload does: its app keeps what it has (the Terminal its shells, a site its page), `w.moving`. */
export function moveToScreen(w, page, rect) {
  if (!wins.has(w.id)) return;
  if (w.max) rect = { ...rect, ...(w.prev ? { w: w.prev.w, h: w.prev.h } : {}) };
  w.moving = true;
  saveSession();
  closeWindow(w, true);
  handOver(page, w.id, { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) });
}

/** Another screen's page handed a window over: open it here, at `rect`. */
function adoptWindow(id, rect) {
  const w = openApp(id, { restore: true });
  if (!w || !validRect(rect)) return;
  w.rect = fitRect(rect, w.app.min);
  applyRect(w);
  focus(w);
  saveSession();
}

/** A screen's page closed (the screen was unplugged or became the main one): the main page takes its windows. */
export function adoptScreen(name) {
  let other = null;
  try {
    other = JSON.parse(localStorage.getItem(`ws:windows@${name}`));
  } catch {}
  if (!fromOtherBoot(other)) for (const id of other?.open || []) if (getApp(id) && !wins.has(id)) adoptWindow(id, other.rects?.[id]);
  if (other) localStorage.setItem(`ws:windows@${name}`, JSON.stringify({ ...other, open: [] }));
}

initScreens({ open: (id, opts) => openApp(id, opts), adopt: adoptWindow, list: () => [...wins.keys()] });

function startResize(w, e, dir, ext) {
  e.preventDefault();
  e.stopPropagation();
  if (w.max) {
    w.max = false;
    w.el.classList.remove('max');
  }
  const s = { ...w.rect };
  const sx = e.clientX;
  const sy = e.clientY;
  const [mw, mh] = w.app.min || [380, 260];
  const pair = wins.get(w.pair);
  track(w, (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    const r = { ...s };
    if (dir.includes('e')) r.w = Math.max(mw, s.w + dx);
    if (dir.includes('s')) r.h = Math.max(mh, s.h + dy);
    if (dir.includes('w')) {
      r.w = Math.max(mw, s.w - dx);
      r.x = s.x + s.w - r.w;
    }
    if (dir.includes('n')) {
      r.h = Math.max(mh, s.h - dy);
      r.y = s.y + s.h - r.h;
      if (r.y < MENUBAR_H) {
        r.h -= MENUBAR_H - r.y;
        r.y = MENUBAR_H;
      }
    }
    w.rect = r;
    applyRect(w);
    const p = wins.get(w.pair);
    if (p && !p.minimized) {
      const pr = { ...p.rect };
      const [pmw] = p.app.min || [380, 260];
      const onRight = pr.x > r.x;
      if (dir.includes('e') && onRight) {
        const right = pr.x + pr.w;
        pr.x = r.x + r.w + MID_GAP;
        pr.w = Math.max(pmw, right - pr.x);
      }
      if (dir.includes('w') && !onRight) pr.w = Math.max(pmw, r.x - MID_GAP - pr.x);
      if (dir.includes('n') || dir.includes('s')) {
        pr.y = r.y;
        pr.h = r.h;
      }
      p.rect = pr;
      applyRect(p);
    }
  }, () => {
    // Remember this size: for this window, and as the default for new windows of the same kind.
    w.sized = true;
    if (w.app.sizeKey) session.sizes[w.app.sizeKey] = { w: w.rect.w, h: w.rect.h };
  }, pair && !pair.minimized ? [w, pair] : [w], ext);
}

/**
 * Moving or resizing a window with a pointer this page doesn't see: a program's own title bar or border, where the
 * compositor holds the pointer (nativewin.js). `x`, `y` are where it was pressed; returns { move(x, y), end() }.
 * `edges`: the compositor's (1 top, 2 bottom, 4 left, 8 right).
 */
export function externalDrag(w, kind, x, y, edges = 0) {
  const ext = {};
  const e = { clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} };
  if (kind === 'resize') {
    const dir = `${edges & 1 ? 'n' : edges & 2 ? 's' : ''}${edges & 4 ? 'w' : edges & 8 ? 'e' : ''}`;
    if (!dir) return { move() {}, end() {} };
    startResize(w, e, dir, ext);
  } else startDrag(w, e, ext);
  return { move: (mx, my) => ext.move?.({ clientX: mx, clientY: my }), end: () => ext.up?.() };
}

/** Page pixels per compositor pixel (Leafdeck's zoom): what nativewin.js scales by when it talks to the compositor. */
export function pageScale() {
  if (!layout) return { x: 1, y: 1 };
  return { x: innerWidth / Math.max(...layout.map((r) => r.x + r.w)), y: innerHeight / Math.max(...layout.map((r) => r.y + r.h)) };
}

/* ---------------- Sheets (modal panels inside a window) ---------------- */

function openSheet(w, content) {
  $('.sheet-wrap', w.el)?._close();
  const wrap = el('<div class="sheet-wrap"><div class="sheet" role="dialog"></div></div>');
  const sheet = wrap.firstElementChild;
  if (typeof content === 'string') sheet.innerHTML = content;
  else sheet.append(content);
  w.el.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
  };
  wrap._close = close;
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  return { el: sheet, close };
}

/* ---------------- Menus ---------------- */

/**
 * Put a popup (menu, picker, small panel) at x, y on the screen that point is on, never across into another one or off
 * its edges. One taller than that screen scrolls. It opens down from y (up when there's no room below, or with opts.up,
 * where y is its bottom edge); opts.flipTo is where its bottom goes when it flips (an anchor's top, for one opened below
 * a button), opts.near the point whose screen it stays on when that isn't x, y, opts.padBottom room left at the bottom.
 */
export function placePopup(node, x, y, opts = {}) {
  const pad = opts.pad ?? 6;
  const n = screenAt(opts.near?.x ?? x, opts.near?.y ?? y);
  const s = screens()[n];
  // Below the screen's menu bar (a menu bar menu opens right at its edge).
  const top0 = s.y + (hasBar(n) ? Math.max(pad, Math.min(MENUBAR_H, y - s.y)) : pad);
  const bottom = s.y + s.h - (opts.padBottom ?? pad);
  node.style.maxHeight = `${bottom - top0}px`;
  if (getComputedStyle(node).overflowY === 'visible') node.style.overflowY = 'auto';
  let r = node.getBoundingClientRect();
  // max-height leaves out padding and borders (and a transform can scale it): take off whatever is still over.
  if (r.height > bottom - top0) {
    node.style.maxHeight = `${Math.max(40, 2 * (bottom - top0) - r.height)}px`;
    r = node.getBoundingClientRect();
  }
  let top = opts.up ? y - r.height : y;
  if (!opts.up && top + r.height > bottom) top = (opts.flipTo ?? y) - r.height;
  node.style.top = clamp(top, top0, bottom - r.height) + 'px';
  node.style.left = Math.max(s.x + pad, Math.min(x, s.x + s.w - pad - r.width)) + 'px';
}

let menuEl = null;

/**
 * items: [{ label, act, key, checked, disabled } | '-' | { header }]
 * opts.up: open above (y is the bottom edge), opts.owner: element that toggles it, opts.keepFocus: clicking it leaves
 * the keyboard where it was (a page's text field, for Cut and Paste), opts.minWidth, opts.flipTo and opts.near (see placePopup),
 * opts.onClose: called when it goes away, chosen from or not (before the choice's act).
 */
export function showMenu(x, y, items, opts = {}) {
  closeMenu();
  const m = el('<div class="menu" role="menu"></div>');
  for (const it of items) {
    if (!it) continue;
    if (it === '-') m.append(el('<div class="menu-sep"></div>'));
    else if (it.header) m.append(el(`<div class="menu-head">${esc(it.header)}</div>`));
    else {
      const b = el(`<button class="menu-item" role="menuitem" ${it.disabled ? 'disabled' : ''} ${it.checked ? 'data-checked' : ''}>
        <span class="mi-check">${it.checked ? icon('tick', 12, 2.4) : ''}</span>
        <span class="mi-label">${esc(it.label)}</span>
        <span class="mi-key">${esc(it.key || '')}</span></button>`);
      b.addEventListener('click', () => {
        closeMenu();
        it.act?.();
      });
      m.append(b);
    }
  }
  if (opts.keepFocus) m.addEventListener('mousedown', (e) => e.preventDefault());
  if (opts.minWidth) m.style.minWidth = `${opts.minWidth}px`;
  document.body.append(m);
  placePopup(m, x, y, { up: opts.up, flipTo: opts.flipTo, near: opts.near });
  m.querySelector('[data-checked]')?.scrollIntoView({ block: 'nearest' }); // a long list that scrolls: at the chosen one
  menuEl = m;
  m._onClose = opts.onClose;
  m._owner = opts.owner;
  opts.owner?.classList.add('open');
  setTimeout(() => addEventListener('pointerdown', outside, true));
  return m;
}

function outside(e) {
  if (!menuEl || menuEl.contains(e.target)) return;
  if (menuEl._owner && menuEl._owner.contains(e.target)) return;
  closeMenu();
}

export function closeMenu() {
  if (!menuEl) return;
  removeEventListener('pointerdown', outside, true);
  menuEl._owner?.classList.remove('open');
  menuEl.remove();
  const done = menuEl._onClose;
  menuEl = null;
  done?.();
}
export const menuOwner = () => menuEl?._owner;

addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

/* ---------------- Toasts ---------------- */

/** A short message; with an `action` ({ label, act }) it gets a button and stays up longer. */
export function toast(msg, kind = '', action = null) {
  const t = el(`<div class="toast ${kind}">${esc(msg)}${action ? `<button class="toast-act">${esc(action.label)}</button>` : ''}</div>`);
  $('#toasts').append(t);
  const life = action ? 8000 : 2600;
  const out = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  };
  if (action) {
    $('.toast-act', t).addEventListener('click', () => {
      out();
      action.act();
    });
  }
  setTimeout(out, life);
}

/* ---------------- Dock ---------------- */

function bounce(id) {
  for (const it of $$(`#dock [data-app="${CSS.escape(id)}"], .dock-extra [data-app="${CSS.escape(id)}"]`)) {
    it.classList.remove('bounce');
    void it.offsetWidth;
    it.classList.add('bounce');
  }
}

/* Pinned apps: prefs.dockPinned (app ids, in Dock order). Kept separate from the old "dock" setting. */
export const pinnedIds = () => (store.prefs.dockPinned || []).filter((id) => getApp(id));
export const isPinned = (id) => pinnedIds().includes(id);
export function setPinned(id, on) {
  const list = pinnedIds().filter((x) => x !== id);
  if (on) list.push(id);
  store.setPrefs({ dockPinned: list });
  renderDock();
}

/** A web page window can't be pinned directly (it's temporary), so save it as a Connection and pin that. */
function pinWebPage(w) {
  let url = '';
  try {
    url = w.web?.url() || '';
  } catch {}
  if (!/^https?:\/\//i.test(url)) return toast('Open a page first, then pin it');
  const host = new URL(url).host.replace(/^www\./, '');
  const existing = store.all('links').find((l) => l.url === url || l.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
  const link = existing || store.save('links', { name: $('.win-title-text', w.el)?.textContent?.slice(0, 40) || host, url, color: 'blue', desktop: false, embed: false });
  setPinned('link:' + link.id, true);
  // Swap the temporary page window for the pinned app, in the same place, so the Dock shows it once.
  const rect = { ...w.rect };
  closeWindow(w);
  const app = openApp('link:' + link.id);
  if (app && !app.max) {
    app.rect = fitRect(rect, app.app.min);
    applyRect(app);
  }
  toast(`Pinned ${link.name} — it’s also in Connections`);
}

/**
 * Dock: pinned apps first (in your order), then a divider and any open windows that aren't pinned.
 * A dot marks open apps; the active window's dot is brighter. Hidden when nothing is pinned or open.
 */
export function renderDock() {
  const pinned = pinnedIds();
  // Open here, then open on another screen (one surface per screen): a click brings it forward there.
  const extra = [...new Set([...wins.keys(), ...openElsewhere()])].filter((id) => !pinned.includes(id));
  const item = (id, isPinned) => {
    const w = wins.get(id);
    const a = getApp(id) || w?.app; // resolver gives the freshest name (e.g. a page title)
    if (!a) return '';
    const cls = [(w || ownerOf(id)) && 'running', w && w === active && 'active', w?.minimized && 'minimized', isPinned && 'pinned'].filter(Boolean).join(' ');
    return `<button class="dock-item ${cls}" data-app="${esc(id)}" aria-label="${esc(a.name)}">
      <span class="dock-tip">${esc(a.name)}</span>${appIcon(a)}<i class="dock-dot"></i>${badgeHtml(id)}</button>`;
  };
  const html = `<div class="dock-inner">${pinned.map((id) => item(id, true)).join('')}${
    pinned.length && extra.length ? '<span class="dock-sep"></span>' : ''
  }${extra.map((id) => item(id, false)).join('')}</div>`;
  for (const dock of docks()) {
    dock.hidden = !pinned.length && !extra.length;
    dock.innerHTML = html;
  }
}

// Mark the focused window's Dock icon without rebuilding the Dock.
onWM(() => $$('#dock .dock-item, .dock-extra .dock-item').forEach((b) => b.classList.toggle('active', b.dataset.app === active?.id)));

export function appMenuItems(id, screen) {
  const a = getApp(id);
  const w = wins.get(id);
  const isWebPage = id.startsWith('web:');
  return [
    { header: a.name },
    { label: w ? (w.minimized ? 'Show' : 'Bring to Front') : 'Open', act: () => openApp(id, { screen }) },
    w && !w.minimized && { label: 'Minimize', act: () => minimize(w) },
    ...(a.menuItems?.() || []), // app-specific items, e.g. a connection's extra sessions
    '-',
    isWebPage
      ? { label: 'Keep in Dock', act: () => pinWebPage(w) }
      : { label: 'Keep in Dock', checked: isPinned(id), act: () => setPinned(id, !isPinned(id)) },
    w && '-',
    w && { label: 'Keep on Top', checked: !!w.pinned, act: () => togglePinned(w) },
    w && { label: 'Mini Window', checked: !!w.mini, act: () => toggleMini(w) },
    w && '-',
    ...(w ? schemeMenuItems(w) : []),
    w && '-',
    w && { label: 'Close', act: () => closeWindow(w) },
  ];
}

/** Title bars are small: use the favicon there when the app's main logo is a big webclip. */
const titleIcon = (a) => (a.smallLogo ? { ...a, logo: a.smallLogo, logoFull: false } : a);

/** An app's icon changed (e.g. a site reported its webclip): redraw it in its title bar and the Dock. */
export function refreshAppIcon(id) {
  const w = wins.get(id);
  const a = getApp(id) || w?.app;
  const t = w && a && $('.win-title .app-icon', w.el);
  if (t) t.outerHTML = appIcon(titleIcon(a));
  renderDock();
}

/** Drag pinned icons sideways to reorder them. */
function startDockReorder(dock, item, e) {
  const sx = e.clientX;
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - sx) < 6) return;
    if (!moved) {
      moved = true;
      item.classList.add('dragging');
    }
    const over = [...$$('.dock-item.pinned', dock)].find((b) => {
      if (b === item) return false;
      const r = b.getBoundingClientRect();
      return ev.clientX > r.left && ev.clientX < r.right;
    });
    if (!over) return;
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(item, ev.clientX < r.left + r.width / 2 ? over : over.nextSibling);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    item.classList.remove('dragging');
    if (!moved) return;
    dock._suppressClick = true;
    setTimeout(() => (dock._suppressClick = false), 0);
    store.setPrefs({ dockPinned: $$('.dock-item.pinned', dock).map((b) => b.dataset.app) });
    renderDock();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

export function initDock() {
  wireDock($('#dock'));
  placeDocks();
}
/** The screen a Dock is on. */
const dockIndex = (dock) => (dock.dataset.screen != null ? Number(dock.dataset.screen) : dockScreen());
/** Clicks, menus and reordering for a Dock (the main one, or another screen's). */
function wireDock(dock) {
  dock.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.dock-item.pinned');
    if (b && e.button === 0) startDockReorder(dock, b, e);
  });
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('.dock-item');
    if (!b || dock._suppressClick) return;
    const id = b.dataset.app;
    const w = wins.get(id);
    if (w?.minimized) {
      restore(w);
      focus(w);
    } else if (w && active === w) minimize(w);
    else openApp(id, { screen: dockIndex(dock) }); // a new window opens on the screen of the Dock you clicked
  });
  dock.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.dock-item');
    if (!b) return;
    e.preventDefault();
    const r = b.getBoundingClientRect();
    showMenu(r.left, r.top - 10, appMenuItems(b.dataset.app, dockIndex(dock)), { up: true });
  });
}
