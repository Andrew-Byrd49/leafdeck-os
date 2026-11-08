// The eyedropper: pick a color from anywhere on screen (public/js/eyedropper.js has the magnifier). On Windows and
// macOS every display is captured and covered by a window showing its picture (public/eyedropper.html), so other apps
// and other monitors can be picked from; the first window to answer ends it for all. In Leafdeck OS Leafdeck is the
// whole screen, so the picture goes back to the desktop page, which runs the magnifier itself. Elsewhere on Linux
// (screen capture there goes through a portal that asks each time), it's the Leafdeck window's own picture.
const path = require('path');
const fs = require('fs');
const { BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron');

let deps = null;
let current = null; // { windows: Map<webContentsId, { win, image }>, finish }

const PNG = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** '#rrggbb', null (canceled), or { image } for the desktop page to pick from. */
async function pick() {
  if (current) return null; // one at a time
  if (deps.session && process.platform === 'linux') {
    const file = await deps.osSystem.captureScreen();
    try {
      return { image: PNG(fs.readFileSync(file)) };
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }
  if (process.platform === 'linux') {
    const img = await deps.win()?.webContents.capturePage();
    return img && !img.isEmpty() ? { image: img.toDataURL() } : null;
  }
  return { color: await overScreens() };
}

async function overScreens() {
  const displays = screen.getAllDisplays();
  const big = displays.reduce((m, d) => ({ width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)), height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)) }), { width: 1, height: 1 });
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: big });
  if (!sources.length) return null;
  return new Promise((resolve) => {
    const windows = new Map();
    const finish = (color) => {
      if (current?.finish !== finish) return;
      current = null;
      for (const { win } of windows.values()) if (!win.isDestroyed()) win.destroy();
      deps.win()?.focus();
      resolve(isHex(color) ? color.toLowerCase() : null);
    };
    current = { windows, finish };
    const cursor = screen.getCursorScreenPoint();
    displays.forEach((d, i) => {
      const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) || sources[i];
      if (!src || src.thumbnail.isEmpty()) return;
      const win = new BrowserWindow({
        ...d.bounds,
        frame: false,
        show: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        alwaysOnTop: true,
        backgroundColor: '#000000',
        title: 'Pick a Color',
        webPreferences: { preload: path.join(__dirname, 'eyedropper-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      windows.set(win.webContents.id, { win, image: src.thumbnail.toDataURL() });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
      win.setMenu?.(null);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') finish(null);
      });
      win.once('ready-to-show', () => {
        win.setBounds(d.bounds); // Windows can shift a frameless window on a scaled display
        win.show();
        const b = d.bounds;
        if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) win.focus();
      });
      win.on('closed', () => finish(null));
      win.loadURL(`${deps.appUrl}eyedropper.html`);
    });
    if (!windows.size) finish(null);
  });
}

function init(d) {
  deps = d;
  ipcMain.handle('eyedropper:image', (event) => current?.windows.get(event.sender.id)?.image || null);
  ipcMain.on('eyedropper:done', (event, color) => {
    if (current?.windows.has(event.sender.id)) current.finish(color);
  });
}

module.exports = { init, pick };
