// Leafdeck OS: Ctrl+Alt+Delete. Normally it brings up Task Manager. When the desktop doesn't answer (its page is stuck,
// or crashed), or on a second press within a few seconds, it puts up the rescue screen instead: its own window and page
// (public/rescue.html), run by the main process, so it still works when everything else in Leafdeck is stuck. From
// there you can end a page, reload the desktop, restart Leafdeck (normally, or into safe mode: electron/safemode.cjs) or
// the computer. Only a stuck main process is beyond it.
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

let deps = null;
let rescueWin = null;
let lastPress = 0;
let busy = false;

/** True when the desktop's page runs a script within `ms`. */
function answers(wc, ms = 1200) {
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve(false);
  return Promise.race([wc.executeJavaScript('1', true).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), ms))]);
}

async function press() {
  if (busy) return;
  if (rescueWin) return rescueWin.focus();
  const again = Date.now() - lastPress < 4000;
  lastPress = Date.now();
  busy = true;
  try {
    const main = deps.mainWindow();
    const ok = !again && (await answers(main?.webContents));
    if (ok) {
      deps.showTaskManager();
      return;
    }
    show(again ? 'asked' : 'stuck');
  } finally {
    busy = false;
  }
}

function show(reason) {
  rescueWin = new BrowserWindow({
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#0b0f0d',
    title: 'Leafdeck Rescue',
    webPreferences: { preload: path.join(deps.preloadDir, 'rescue-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  rescueWin.setMenu?.(null);
  rescueWin.loadURL(`${deps.appUrl}rescue.html#${reason}`);
  rescueWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  rescueWin.webContents.on('will-navigate', (e) => e.preventDefault());
  rescueWin.webContents.on('before-input-event', (e, input) => {
    const k = String(input.key || '').toLowerCase();
    if (input.type === 'keyDown' && k === 'escape') close();
    if ((input.control || input.meta) && ['r', 'i', 'j', 'w', 'q'].includes(k)) e.preventDefault();
    if (k === 'f5' || k === 'f12') e.preventDefault();
  });
  rescueWin.on('closed', () => (rescueWin = null));
}

function close() {
  const w = rescueWin;
  rescueWin = null;
  if (w && !w.isDestroyed()) w.destroy();
  deps.mainWindow()?.focus();
}

const fromRescue = (event) => rescueWin && event.sender === rescueWin.webContents;

function wireIpc() {
  ipcMain.handle('rescue:info', async (event) => {
    if (!fromRescue(event)) throw new Error('Not allowed');
    const main = deps.mainWindow();
    return { desktopAnswers: await answers(main?.webContents, 800), pages: deps.pages() };
  });
  ipcMain.handle('rescue:act', (event, action, webContentsId) => {
    if (!fromRescue(event)) throw new Error('Not allowed');
    if (action === 'close') return close();
    if (action === 'end-page') return deps.endPage(Number(webContentsId));
    if (action === 'reload-desktop') {
      deps.reloadDesktop();
      return close();
    }
    if (action === 'restart-leafdeck') return deps.restartLeafdeck();
    if (action === 'safe-mode') return deps.safeMode();
    if (['restart', 'shutdown'].includes(action)) return deps.power(action);
    throw new Error('Not allowed');
  });
}

/**
 * deps: { mainWindow(), appUrl, preloadDir, showTaskManager(), pages() (Task Manager's rows), endPage(webContentsId),
 * reloadDesktop(), restartLeafdeck(), safeMode(), power(action) }
 */
function init(d) {
  deps = d;
  wireIpc();
}

module.exports = { init, press, isOpen: () => !!rescueWin };
