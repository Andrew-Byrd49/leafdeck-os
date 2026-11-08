/* Leafdeck OS, one surface per screen (electron/screens.cjs): the main window's page draws the main screen and each other
   screen has a page of its own (`?screen=<connector>`), all running this same UI. Each page keeps the windows on its
   screen. Here the pages tell each other which windows they have (so opening one that's on another screen brings it
   forward there instead of opening it twice) and hand windows over when one is dragged to another screen.

   Everywhere else there's one page and none of this does anything. */
import { shell } from './shell.js';

/** The connector name of the screen this page draws, '' for the main page. */
export const SCREEN = new URLSearchParams(location.search).get('screen') || '';
/** Is this a screen's own page (not the main one)? */
export const isScreenPage = !!SCREEN;

const PAGE = SCREEN || 'main';
const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('leafdeck-screens') : null;
const elsewhere = new Map(); // window id -> the page that has it ('main' or a connector name)
let handlers = { open: null, adopt: null, list: () => [] };

let info = { on: false, self: '', main: '', screens: [] };
/** Where the screens are, and which this page is: { on, self, main, screens: [{ name, x, y, w, h }] }. */
export async function refreshInfo() {
  info = (await shell?.screens?.info?.().catch(() => null)) || info;
  dispatchEvent(new Event('screens-info'));
  return info;
}
shell?.on?.('os:layout', () => refreshInfo());
export const screensInfo = () => info;
/** Is Leafdeck drawn one surface per screen? */
export const perScreen = () => !!info.on;

const post = (msg) => bus?.postMessage({ ...msg, from: PAGE });

/**
 * Hooks this page's window manager up (wm.js): `open(id, opts)` opens or brings forward one of its windows,
 * `adopt(id, rect)` takes one handed over by another page, `list()` is the ids of the windows it has.
 */
export function initScreens(h) {
  handlers = { ...handlers, ...h };
  if (!bus) return;
  bus.onmessage = ({ data: m }) => {
    if (!m || m.from === PAGE) return;
    if (m.type === 'windows') {
      for (const [id, page] of elsewhere) if (page === m.from) elsewhere.delete(id);
      for (const id of m.ids || []) elsewhere.set(id, m.from);
      dispatchEvent(new Event('screens-windows')); // the Dock shows them as open
    } else if (m.type === 'hello') announce();
    else if (m.to !== PAGE) return;
    else if (m.type === 'open') {
      handlers.open?.(m.id, m.opts || {});
      shell?.screens?.focus?.();
    } else if (m.type === 'adopt') {
      elsewhere.delete(m.id); // it's this page's now (the sender's list of its windows comes a moment later)
      handlers.adopt?.(m.id, m.rect, m.opts || {});
      shell?.screens?.focus?.();
    }
  };
  post({ type: 'hello' });
  announce();
  addEventListener('pagehide', () => post({ type: 'windows', ids: [] }));
}

/** Tells the other pages which windows this one has (after any change). */
let announceT = 0;
export function announce() {
  clearTimeout(announceT);
  announceT = setTimeout(() => post({ type: 'windows', ids: handlers.list() }), 30);
}

/** The page that has window `id` open, when it's another one ('main' or a connector name). */
export const ownerOf = (id) => elsewhere.get(id) || '';
/** The windows open on other screens' pages. */
export const openElsewhere = () => [...elsewhere.keys()];

/** Asks the page that has window `id` to bring it forward (with `opts` as openApp's). */
export function openThere(id, opts = {}) {
  const page = ownerOf(id);
  if (!page) return false;
  post({ type: 'open', to: page, id, opts: JSON.parse(JSON.stringify(opts || {})) });
  return true;
}

/** The page drawing a screen: 'main' for the main screen. */
const pageFor = (name) => (name === info.main ? 'main' : name);

/**
 * The screen under a point given in this page's pixels, when it isn't this page's: { page, x, y } with x, y in that
 * screen's pixels. null on this screen, or off every screen.
 */
export function screenAt(x, y) {
  if (!info.on) return null;
  const me = info.screens.find((s) => s.name === (SCREEN || info.main));
  if (!me) return null;
  const gx = me.x + x;
  const gy = me.y + y;
  const s = info.screens.find((r) => gx >= r.x && gx < r.x + r.w && gy >= r.y && gy < r.y + r.h);
  if (!s || s.name === me.name) return null;
  return { page: pageFor(s.name), name: s.name, x: gx - s.x, y: gy - s.y };
}

/** Hands window `id` to another page, to show it at `rect` (that page's pixels). */
export function handOver(page, id, rect, opts = {}) {
  elsewhere.set(id, page);
  post({ type: 'adopt', to: page, id, rect, opts });
}

/** The localStorage key for this page's windows (each screen keeps its own). */
export const sessionKey = (base) => (SCREEN ? `${base}@${SCREEN}` : base);
