// DevTools in a Leafdeck window (Leafdeck OS). Chromium would open a page's DevTools as a window of its own, and in the
// session that window takes the whole screen with no way back to Leafdeck. Here DevTools runs in a webview instead,
// connected to the page by electron/devtools.cjs, so it's an ordinary window you can move, snap and close.
// One window per page: Inspect brings it forward on the element, Ctrl+Shift+I closes it, and so does closing the window.
import { addResolver, openApp, wins, closeWindow } from '../wm.js';
import { shell } from '../shell.js';

const PARTITION = 'persist:leafdeck-devtools'; // main.cjs only lets the UI attach a blank webview on this partition
const pages = new Map(); // window id -> { webContentsId, title } (0 is Leafdeck's own page)
const idFor = (webContentsId) => `devtools:${webContentsId}`;
const nameOf = (p) => `DevTools · ${p.title}`;

addResolver((id) => {
  const p = pages.get(id);
  if (!p) return null;
  return {
    id,
    name: nameOf(p),
    icon: 'code',
    color: 'graphite',
    burner: true, // not one for the search's Recent list: it can't be reopened without its page
    size: [1100, 680],
    min: [420, 240],
    mount(win) {
      win.setTitle(nameOf(p));
      win.body.innerHTML = '<div class="embed devtools-embed"></div>';
      const view = document.createElement('webview');
      view.setAttribute('partition', PARTITION);
      view.setAttribute('src', 'about:blank');
      view.addEventListener(
        'dom-ready',
        () => {
          p.devId = view.getWebContentsId();
          shell.devtools.attach(p.webContentsId, p.devId).catch((err) => {
            console.error('DevTools', err);
            if (wins.has(id)) closeWindow(win);
          });
        },
        { once: true },
      );
      win.body.firstChild.append(view);
    },
    unmount() {
      pages.delete(id);
      shell.devtools.close(p.webContentsId).catch(() => {});
    },
  };
});

shell?.on?.('shell:devtools', ({ webContentsId, title, show, closed, devId } = {}) => {
  const id = idFor(Number(webContentsId) || 0);
  if (closed) {
    if (devId && pages.get(id)?.devId !== devId) return; // an earlier DevTools window of this page
    const w = wins.get(id);
    if (w) closeWindow(w);
    else pages.delete(id);
    return;
  }
  if (show) {
    if (wins.has(id)) openApp(id);
    return;
  }
  const stale = wins.get(id); // a window whose DevTools went away on its own: start over
  if (stale) closeWindow(stale);
  pages.set(id, { webContentsId: Number(webContentsId) || 0, title: String(title || 'Page') });
  openApp(id);
});
