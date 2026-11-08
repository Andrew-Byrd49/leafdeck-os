// Leafdeck OS: one surface per screen (LEAFDECK_PER_SCREEN=1 in the session, with Leafdeck's cage). Without it,
// Leafdeck's one window covers every screen: one surface as wide as all of them, drawn at the highest scale (a 1x monitor
// beside 2x panels got four times its pixels, scaled down), and Chromium redraws the box around everything that changed
// in a frame, so a terminal on one screen and a page on another redrew everything between them. With it, the main
// window fills the main screen and every other screen gets a window of its own (the same UI, `?screen=<connector>`),
// each at its screen's scale. The pages share the data (store.js pulls what another page saved) and hand windows to each
// other when they move between screens (public/js/screens.js). cage pins each window to its screen (`screen`,
// `mainscreen` in os/cage/leafdeck.c).
const crypto = require('node:crypto');

let opts = null; // { compositor, main: () => BrowserWindow, create: (name, title) => BrowserWindow, layout: () => Promise, send }
let layout = []; // the screens in use: [{ name, internal, main, x, y, w, h }] (ossystem.cjs layout())
let mainScreen = ''; // the screen the main window fills
let pinning = false; // cage answered `mainscreen`: it can pin windows to screens (os/cage/native-windows.patch, 2026-11)
let asked = null; // the timer while that answer is awaited
const pages = new Map(); // connector name -> BrowserWindow, for every screen besides the main one

const alive = (w) => w && !w.isDestroyed();

/** Turns it on. `o.create(name, title)` makes a screen's window (titled `title` for good) loading `?screen=<name>`. */
function init(o) {
  opts = o;
  // An older cage doesn't know `screen`: its screens' windows would cover every screen. Only once cage has answered
  // `mainscreen` are they made.
  opts.compositor.onScreen((ev) => {
    if (pinning || !ev.ok || ev.output !== mainScreen) return;
    pinning = true;
    clearTimeout(asked);
    console.log('[screens] one surface per screen');
    sync(layout);
  });
  opts.compositor.onReady((ok) => {
    if (!ok) {
      mainScreen = '';
      pinning = false;
      return;
    }
    Promise.resolve(layout.length ? layout : opts.layout())
      .then((list) => sync(list, true))
      .catch((err) => console.error('[screens]', err.message));
  });
}

/** Is Leafdeck drawn one surface per screen right now? (On, and the compositor is Leafdeck's cage.) */
const active = () => !!opts && opts.compositor.ready() && !!mainScreen && pinning;

/** The screens changed (or Leafdeck started): the main window on the main screen, a window on each other screen. */
function sync(list, force = false) {
  if (!opts) return;
  layout = Array.isArray(list) ? list : [];
  if (!opts.compositor.ready()) return;
  const main = layout.find((s) => s.main) || layout[0];
  if (!main) return;
  if (main.name !== mainScreen || force) {
    mainScreen = main.name;
    opts.compositor.pinMain(main.name);
    if (!pinning && !asked) {
      asked = setTimeout(() => {
        asked = null;
        if (!pinning) console.error('[screens] this cage can’t give each screen a surface of its own: build os/cage again (sh os/cage/build.sh)');
      }, 3000);
    }
  }
  if (!pinning) return; // until cage says it can
  for (const s of layout) {
    if (s === main || alive(pages.get(s.name))) continue;
    const title = `leafdeck-screen-${s.name}-${crypto.randomBytes(4).toString('hex')}`;
    opts.compositor.pinScreen(title, s.name); // before it opens: cage gives it its screen as it maps
    const w = opts.create(s.name, title);
    pages.set(s.name, w);
    w.on('closed', () => pages.get(s.name) === w && pages.delete(s.name));
  }
  // A screen that's gone (or is the main one now): its window closes, and the main page takes its windows.
  for (const [name, w] of pages) {
    if (layout.some((s) => s.name === name && s !== main)) continue;
    pages.delete(name);
    if (alive(w)) w.destroy();
    const m = opts.main();
    if (alive(m)) opts.send(m.webContents, 'screens:adopt', { screen: name });
  }
  // Each page: its own screen, the whole of it (it starts at 0,0).
  for (const wc of uiPages()) opts.send(wc, 'os:layout', { screens: own(wc) });
}

/** Every Leafdeck page: the main window's and each screen's. */
function uiPages() {
  const m = opts?.main();
  return [m, ...pages.values()].filter(alive).map((w) => w.webContents);
}

/** The screen a page draws ('' for the main page before there are screens). */
function screenOf(wc) {
  for (const [name, w] of pages) if (alive(w) && w.webContents === wc) return name;
  return mainScreen;
}

/** Is this one of the screens' pages (not the main one)? */
const isScreenPage = (wc) => [...pages.values()].some((w) => alive(w) && w.webContents === wc);

/** A page's layout: just its screen, at 0,0. */
function own(wc) {
  const s = layout.find((x) => x.name === screenOf(wc));
  return s ? [{ ...s, x: 0, y: 0, main: true }] : [];
}

/** For a page: which screen it is, and where every screen is (layout pixels, the main screen's top left at 0,0). */
function info(wc) {
  return { on: active(), wanted: !!opts, self: screenOf(wc), main: mainScreen, screens: layout.map((s) => ({ ...s })) };
}

/** Keyboard focus to a screen's window (its page asked: a window there was focused from another screen). */
function focus(name) {
  if (active() && layout.some((s) => s.name === name)) opts.compositor.focusScreen(name);
}

module.exports = { init, sync, active, uiPages, screenOf, isScreenPage, own, info, focus };
