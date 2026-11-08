// The app display in a Leafdeck window (Leafdeck OS). Programs started from the Terminal (a game, a demo, anything with
// a window of its own) open on a display of their own, electron/appdisplay.cjs, instead of on the real screen, where
// they'd cover Leafdeck. This window shows that display: it opens by itself when a program opens a window there, takes
// the program's title, and closes when the last window does. Closing it asks the programs to close.
// The picture and input are VNC (noVNC, public/vendor/novnc), carried over Leafdeck's IPC rather than a network port.
import { addResolver, openApp, wins, closeWindow, toast } from '../wm.js';
import { shell } from '../shell.js';
import { esc } from '../util.js';

const ID = 'appdisplay';
const ad = shell?.appDisplay;
let windows = []; // the display's windows, oldest first: [{ id, title, appId, states }]
let closingEmpty = false; // closing ours because the display has no windows left (so don't ask the programs to close)
const channels = new Map(); // connection id -> Channel

const front = () => windows.find((w) => w.states.includes('activated')) || windows[windows.length - 1];
const nameOf = (w) => w?.title || w?.appId || 'App';

/** What noVNC needs from a WebSocket, over Leafdeck's IPC to the display's VNC socket. The main process holds the
 * connection's data back until noVNC has attached (it sets onmessage). */
class Channel {
  constructor() {
    this.binaryType = 'arraybuffer';
    this.protocol = '';
    this.readyState = WebSocket.CONNECTING;
    this.onopen = this.onclose = this.onerror = null;
    this.id = 0;
    this._onmessage = null;
  }
  async open() {
    this.id = await ad.connect();
    channels.set(this.id, this);
    this.readyState = WebSocket.OPEN;
  }
  get onmessage() {
    return this._onmessage;
  }
  set onmessage(fn) {
    this._onmessage = fn;
    if (fn && this.id) ad.start(this.id);
  }
  send(data) {
    if (this.readyState === WebSocket.OPEN) ad.send(this.id, data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    ad.disconnect(this.id);
    this.closed();
  }
  closed() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    channels.delete(this.id);
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

/** The window bar: the front window's title, and a switch between windows when the display has more than one. */
function renderBar(win) {
  const top = front();
  win.setTitle(nameOf(top));
  if (windows.length < 2) {
    win.tools.innerHTML = '';
    return;
  }
  win.tools.innerHTML = `<div class="seg">${windows
    .map((w) => `<button data-ad="${w.id}" class="${w === top ? 'on' : ''}" title="${esc(nameOf(w))}"><span class="ad-tab">${esc(nameOf(w))}</span></button>`)
    .join('')}</div>`;
}

addResolver((id) => {
  if (id !== ID || !windows.length) return null;
  return {
    id,
    name: nameOf(front()),
    icon: 'display',
    color: 'graphite',
    burner: true, // reopens by itself whenever a program opens a window
    size: [1280, 760], // 1280×720 inside, the size many programs ask for (cage gives a window the whole display)
    min: [320, 200],
    mount(win) {
      win.body.innerHTML = '<div class="embed appdisplay"><div class="ad-screen"></div><div class="ad-note">Connecting…</div></div>';
      const box = win.body.firstChild;
      const note = box.querySelector('.ad-note');
      let rfb = null;
      let stopped = false;
      let retry = null;
      const connect = async () => {
        if (stopped) return;
        try {
          const { default: RFB } = await import('/vendor/novnc/core/rfb.js');
          const ch = new Channel();
          await ch.open();
          if (stopped) return ch.close();
          const screen = box.querySelector('.ad-screen');
          rfb = new RFB(screen, ch, { shared: true });
          // noVNC measures with getBoundingClientRect, which includes transforms: a window opening or restoring is
          // scaled down for a moment, and the display would keep that smaller size. The layout size has no transforms.
          rfb._screenSize = () => ({ w: screen.clientWidth, h: screen.clientHeight });
          rfb.resizeSession = true; // the display takes this window's size
          rfb.background = '#000';
          rfb.addEventListener('connect', () => {
            note.hidden = true;
            rfb.focus();
          });
          rfb.addEventListener('disconnect', () => {
            rfb = null;
            if (stopped) return;
            note.hidden = false;
            note.textContent = 'Reconnecting…';
            retry = setTimeout(connect, 1000);
          });
        } catch (err) {
          note.hidden = false;
          note.textContent = `Couldn’t show the app display: ${err.message}`;
          retry = setTimeout(connect, 3000);
        }
      };
      // While a program here has the keyboard, Leafdeck's shortcuts step aside (all but Super and Alt+Tab).
      box.addEventListener('focusin', () => ad.focus(true));
      box.addEventListener('focusout', () => ad.focus(false));
      win.tools.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ad]');
        if (b) ad.activate(Number(b.dataset.ad)).then(() => rfb?.focus());
      });
      win.cleanups.push(() => {
        stopped = true;
        clearTimeout(retry);
        rfb?.disconnect();
        ad.focus(false);
      });
      renderBar(win);
      connect();
    },
    unmount() {
      // Closed by hand: ask each program to close (one with unsaved work can still ask, and this window comes back).
      if (!closingEmpty) for (const w of windows) ad.close(w.id).catch(() => {});
      closingEmpty = false;
    },
  };
});

function update(list) {
  const before = windows.length;
  windows = Array.isArray(list) ? list : [];
  const win = wins.get(ID);
  if (!windows.length) {
    if (win) {
      closingEmpty = true;
      closeWindow(win, true);
    }
    return;
  }
  if (!win || windows.length > before) openApp(ID); // a new window comes to the front
  const w = wins.get(ID);
  if (w) renderBar(w);
}

if (ad) {
  shell.on('appdisplay:windows', update);
  shell.on('appdisplay:data', ({ id, data }) => {
    const ch = channels.get(id);
    if (ch?._onmessage) ch._onmessage({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  });
  shell.on('appdisplay:closed', ({ id }) => channels.get(id)?.closed());
  // A program's window got onto the real screen anyway (started before the app display, or not from the Terminal):
  // Leafdeck is already back in front; the program is still running behind it.
  shell.on('appdisplay:outside', ({ id, title, appId }) =>
    toast(`“${title || appId || 'A program'}” tried to cover Leafdeck. Start it from a new Terminal to open it in a window.`, '', {
      label: 'Close it',
      act: () => ad.closeOutside(id),
    }),
  );
  ad.windows().then(update, () => {});
}
