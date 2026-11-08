// Leafdeck OS: programs' real windows inside Leafdeck's frames. Leafdeck's compositor (cage with
// os/cage/native-windows.patch) has a control socket, LEAFDECK_COMPOSITOR in the session's environment. Once Leafdeck
// says which process it is, every other program's window is "native": cage shows it where Leafdeck's frame is,
// cropped to the frame, and draws Leafdeck's own pixels over it where Leafdeck's UI is in front ("covers"). Without
// the patched compositor nothing here runs, and programs keep opening on the app display (electron/appdisplay.cjs).
// The UI half is public/js/nativewin.js; the protocol is described at the top of os/cage/leafdeck.c.
const net = require('node:net');
const crypto = require('node:crypto');

let sock = null;
let ready = false; // connected, and cage knows Leafdeck's main window
let send = () => {}; // (event) to the UI
let mainWin = null;
let buf = '';
const listeners = new Set();

const line = (s) => sock && !sock.destroyed && sock.write(s + '\n');
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

function parse(l) {
  const f = l.split('\t');
  switch (f[0]) {
    case 'new':
      return { type: 'new', id: int(f[1]), parent: int(f[2]), pid: int(f[3]), w: int(f[4]), h: int(f[5]), minW: int(f[6]), minH: int(f[7]), appId: f[8] || '', title: f.slice(9).join(' ') };
    case 'title':
      return { type: 'title', id: int(f[1]), title: f.slice(2).join(' ') };
    case 'appid':
      return { type: 'appid', id: int(f[1]), appId: f[2] || '' };
    case 'size':
      return { type: 'size', id: int(f[1]), w: int(f[2]), h: int(f[3]) };
    case 'fullscreen':
      return { type: 'fullscreen', id: int(f[1]), on: f[2] === '1' };
    case 'focus':
      return { type: 'focus', id: int(f[1]) };
    case 'gone':
      return { type: 'gone', id: int(f[1]) };
    case 'main':
      return { type: 'main', ok: f[1] === 'ok' };
    case 'screen':
      return { type: 'screen', output: f[1] || '', ok: f[2] === 'ok' };
    case 'deco':
      return { type: 'deco', id: int(f[1]), csd: f[2] === 'csd' };
    case 'grab':
      return { type: 'grab', id: int(f[1]), kind: f[2] === 'resize' ? 'resize' : 'move', edges: int(f[3]), x: int(f[4]), y: int(f[5]) };
    case 'drag':
    case 'dragend':
      return { type: f[0], id: int(f[1]), x: int(f[2]), y: int(f[3]) };
    case 'state':
      return ['maximize', 'unmaximize', 'minimize'].includes(f[2]) ? { type: 'state', id: int(f[1]), state: f[2] } : null;
    case 'pointer':
      return { type: 'pointer', mice: int(f[1]) };
    default:
      return null;
  }
}

/** Tells cage which window is Leafdeck's main one: cage finds it by its title, so the title is a one-off word for a
 *  moment. */
let identifying = null; // { nonce, title, hold } while cage looks for the main window by its title
let attempts = 0;
function identifyMain() {
  if (!mainWin || mainWin.isDestroyed() || !sock || identifying) return;
  // The page sets its own title as it starts (Leafdeck · <business>): hold the one-off title until cage has answered.
  const hold = (e) => e.preventDefault();
  mainWin.on('page-title-updated', hold);
  identifying = { nonce: `leafdeck-main-${crypto.randomBytes(6).toString('hex')}`, title: mainWin.getTitle(), hold };
  mainWin.setTitle(identifying.nonce);
  setTimeout(() => identifying && line(`main ${identifying.nonce}`), 250);
}
/** The title back, whether cage answered or the connection went while it was looking. */
function endIdentify() {
  const was = identifying;
  identifying = null;
  if (was && mainWin && !mainWin.isDestroyed()) {
    mainWin.removeListener('page-title-updated', was.hold);
    mainWin.setTitle(mainWin.webContents.getTitle() || was.title);
  }
  return was;
}
function identified(ok) {
  const was = endIdentify();
  // Not found (the window wasn't mapped yet, the title hadn't reached cage): again, a little later each time.
  if (!ok && was && attempts++ < 8) setTimeout(identifyMain, 400 * attempts);
  if (ok) attempts = 0;
}

const screenListeners = new Set();
function onEvent(ev) {
  if (ev.type === 'screen') {
    for (const fn of screenListeners) fn(ev);
    return;
  }
  if (ev.type === 'pointer') {
    pointer.mice = ev.mice;
    pointer.answered = true;
    return;
  }
  if (ev.type === 'main') {
    identified(ev.ok);
    const was = ready;
    ready = ev.ok;
    if (ready && !was) {
      if (everReady) console.log('[compositor] back: programs open in Leafdeck frames');
      everReady = true;
      line('list'); // the windows that were open before Leafdeck (re)started, or while the link was down
    }
    for (const fn of listeners) fn(ready);
  }
  send(ev);
}

/**
 * The control socket, if it's the one of the screen this Leafdeck is on: $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY.leafdeck
 * (os/cage/leafdeck.c). cage keeps one client, the newest, so another Leafdeck that inherited LEAFDECK_COMPOSITOR from
 * a shell in the session (a test sandbox, with WAYLAND_DISPLAY unset) would take the session's windows away by
 * connecting; it gets nothing here.
 */
function ownSocket() {
  const p = process.env.LEAFDECK_COMPOSITOR;
  const d = process.env.WAYLAND_DISPLAY;
  if (!p || process.platform !== 'linux') return null;
  const own = d && (d.startsWith('/') ? `${d}.leafdeck` : require('node:path').join(process.env.XDG_RUNTIME_DIR || '', `${d}.leafdeck`));
  if (p === own) return p;
  console.log(`[compositor] ${p} isn't this screen's control socket (WAYLAND_DISPLAY=${d || ''}): not connecting`);
  return null;
}

let everReady = false;
let wasConnected = false; // this socket connected (so a close is a drop, not cage missing)
let retry = null; // the timer to the next attempt
let delay = 1000;

/**
 * One connection. When it goes (another Leafdeck took the socket, cage is restarting), its programs stay hidden until
 * the link is back: the next attempt is a moment later, then a little later each time. Programs started meanwhile open
 * on the app display (programDisplay, main.cjs).
 */
function connect(path) {
  retry = null;
  const s = net.connect(path);
  sock = s;
  buf = '';
  wasConnected = false;
  s.setEncoding('utf8');
  s.on('connect', () => {
    wasConnected = true;
    delay = 1000;
    line(`shell ${process.pid}`);
    sendPointer();
    if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', identifyMain);
    else identifyMain();
  });
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (ev) onEvent(ev);
    }
  });
  const gone = (why) => {
    if (sock !== s) return; // error, then close: once
    sock = null;
    endIdentify();
    attempts = 0;
    if (ready) {
      ready = false;
      for (const fn of listeners) fn(false);
      send({ type: 'reset' });
    }
    if (wasConnected) console.log(`[compositor] link ${why}: programs open on the app display until it's back`);
    if (mainWin && !mainWin.isDestroyed()) retry = setTimeout(() => connect(path), delay);
    delay = Math.min(delay * 2, 10000);
  };
  s.on('error', (err) => gone(`lost (${err.message})`));
  s.on('close', () => gone('closed'));
}

/**
 * Connects to the compositor (if it's Leafdeck's). `opts.win` is Leafdeck's main window, `opts.send(event)` reaches the
 * UI. Resolves true once cage knows the main window; the link is kept up from then on.
 */
function init({ win, send: s }) {
  const path = ownSocket();
  if (!path) return Promise.resolve(false);
  mainWin = win;
  send = s || send;
  return new Promise((resolve) => {
    listeners.add(function first(ok) {
      if (!ok) return; // a miss is tried again (identified)
      listeners.delete(first);
      resolve(true);
    });
    setTimeout(() => resolve(ready), 15000);
    connect(path);
  });
}

/** A command from the UI, checked and passed on. */
function command(c) {
  if (!ready || !c || typeof c !== 'object') return;
  const id = int(c.id);
  switch (c.op) {
    case 'place':
      return line(`place ${id} ${int(c.x)} ${int(c.y)} ${Math.max(1, int(c.w))} ${Math.max(1, int(c.h))}`);
    case 'hide':
      return line(`hide ${id}`);
    case 'cover': {
      const rects = (Array.isArray(c.rects) ? c.rects : []).slice(0, 48).filter((r) => r && int(r.w) > 0 && int(r.h) > 0);
      return line(`cover ${id}${rects.map((r) => ` ${int(r.x)} ${int(r.y)} ${int(r.w)} ${int(r.h)}`).join('')}`);
    }
    case 'order':
      return line(`order ${(Array.isArray(c.ids) ? c.ids : []).map(int).join(' ')}`);
    case 'focus':
      return line(`focus ${id}`);
    case 'close':
      return line(`close ${id}`);
    case 'fullscreen':
      return line(`fullscreen ${id} ${c.on ? 1 : 0}`);
    case 'maximized':
      return line(`maximized ${id} ${c.on ? 1 : 0}`);
    case 'list': // the UI reloaded: every window again
      return line('list');
  }
}

/* The mouse (Settings → Mouse, os:mouse in main.cjs): libinput's acceleration profile and speed, set by cage on every mouse.
   cage keeps the settings for mice that come later; a cage without the command says nothing back. */
const pointer = { accel: true, speed: 0, sent: false, answered: false, mice: 0 };
const sendPointer = () => pointer.sent && line(`pointer ${pointer.accel ? 'adaptive' : 'flat'} ${int(pointer.speed)}`);
/** `accel`: libinput's adaptive profile (faster when moved fast); off is the flat one. `speed`: -100..100, 0 is 1:1. */
function setPointer({ accel, speed }) {
  pointer.accel = accel !== false;
  pointer.speed = Math.max(-100, Math.min(100, int(speed)));
  pointer.sent = true;
  sendPointer();
}
/** What's known: connected to cage, whether it took the command, and how many mice have the settings. */
const pointerInfo = () => ({ compositor: !!sock && !sock.destroyed && wasConnected, supported: pointer.answered, mice: pointer.mice });

/* One surface per screen (electron/screens.cjs): cage pins a Leafdeck window to one screen, found by its title (a screen
   window keeps a one-off title all its life; cage applies the pin as it opens, so it never covers every screen first). */
/** The Leafdeck window titled `title` fills the screen `output` (a connector name), or every screen again with '-'. */
const pinScreen = (title, output) => ready && /^[\w.:-]+$/.test(title) && /^[\w.-]+$/.test(output) && line(`screen ${title} ${output}`);
/** The main window fills only `output` (or every screen again with '-'). */
const pinMain = (output) => ready && /^[\w.-]+$/.test(output) && line(`mainscreen ${output}`);
/** Keyboard focus to the Leafdeck window of a screen. */
const focusScreen = (output) => ready && /^[\w.-]+$/.test(output) && line(`screenfocus ${output}`);

/** cage's answers to pinning: { output, ok } (`mainscreen` always gets one from a cage that can pin). */
const onScreen = (fn) => screenListeners.add(fn);

module.exports = { init, command, ready: () => ready, onReady: (fn) => listeners.add(fn), identifyMain, pinScreen, pinMain, focusScreen, onScreen, setPointer, pointerInfo };
