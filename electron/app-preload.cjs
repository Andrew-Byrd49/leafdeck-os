// The bridge a user app sees as `window.leafdeck` (API reference: electron/app-sdk/GUIDE.md).
// Every call goes to the Leafdeck UI hosting this app (public/js/userapps.js), which checks the app's manifest
// permissions before touching anything. The app never gets Node, Electron, or Leafdeck's own IPC.
const { contextBridge, ipcRenderer } = require('electron');

let seq = 0;
const waiting = new Map();
const listeners = new Map(); // event name -> Set(fn)
let readyInfo = null;
let readyWaiters = [];
let iconPaths = {};

/** Leafdeck's line icon as an SVG string (same icons as the built-in apps). */
function iconSvg(name, size = 16) {
  const s = Math.max(8, Math.min(64, Number(size) || 16));
  const p = iconPaths[name] || iconPaths.sparkle || '';
  return `<svg class="ld-ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
/** <span data-icon="plus"></span> (optional data-icon-size) fills in with that icon, including elements added later. */
function hydrateIcons(root) {
  if (!root?.querySelectorAll) return;
  const els = root.matches?.('[data-icon]') ? [root, ...root.querySelectorAll('[data-icon]')] : root.querySelectorAll('[data-icon]');
  for (const el of els) {
    const key = el.dataset.icon + '/' + (el.dataset.iconSize || '');
    if (el.dataset.iconDrawn === key) continue;
    el.dataset.iconDrawn = key;
    el.innerHTML = iconSvg(el.dataset.icon, el.dataset.iconSize);
  }
}
function watchIcons() {
  hydrateIcons(document.documentElement);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') hydrateIcons(m.target);
      else m.addedNodes.forEach((n) => n.nodeType === 1 && hydrateIcons(n));
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-icon', 'data-icon-size'] });
}

ipcRenderer.on('leafapp:reply', (_e, { id, ok, result, error }) => {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  ok ? w.resolve(result) : w.reject(new Error(error || 'Leafdeck refused the request'));
});

ipcRenderer.on('leafapp:event', (_e, { type, detail }) => {
  if (type === 'theme') applyTheme(detail);
  if (type === 'ready') {
    if (detail.icons) iconPaths = detail.icons;
    delete detail.icons;
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', watchIcons, { once: true });
    else watchIcons();
    readyInfo = detail;
    applyTheme(detail.theme);
    readyWaiters.forEach((f) => f(detail));
    readyWaiters = [];
  }
  for (const fn of listeners.get(type) || []) {
    try {
      fn(detail);
    } catch (err) {
      console.error(err);
    }
  }
});

// App Builder's comment overlay (public/js/siteeditor/inpage.js, run in this page's isolated world by
// electron/userapps.cjs) reports what the user did as a DOM event; it goes to the Leafdeck UI hosting this app.
document.addEventListener('leafdeck-site-editor', (e) => typeof e.detail === 'string' && e.detail.length < 256 * 1024 && ipcRenderer.sendToHost('leafapp:page', e.detail), true);

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ipcRenderer.sendToHost('leafapp:call', { id, method, args: JSON.parse(JSON.stringify(args ?? [])) });
  });
}

/** Leafdeck's light/dark mode and accent color, as CSS variables and a data-theme attribute on <html>. */
function applyTheme(t) {
  if (!t) return;
  const set = () => {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.theme = t.dark ? 'dark' : 'light';
    root.style.colorScheme = t.dark ? 'dark' : 'light';
    root.style.setProperty('--ld-accent', t.accent);
    root.style.setProperty('--ld-accent-ink', t.accentInk);
  };
  if (document.documentElement) set();
  else addEventListener('DOMContentLoaded', set, { once: true });
}

contextBridge.exposeInMainWorld('leafdeck', {
  /** Resolves once Leafdeck has connected: { app: { id, name, permissions }, theme: { dark, accent } }. */
  ready: () => (readyInfo ? Promise.resolve(readyInfo) : new Promise((r) => readyWaiters.push(r))),
  /** Leafdeck's built-in records (needs "<collection>:read" / ":write" in manifest.json). */
  records: {
    list: (collection, query) => call('records.list', collection, query),
    get: (collection, id) => call('records.get', collection, id),
    save: (collection, record) => call('records.save', collection, record),
    remove: (collection, id) => call('records.remove', collection, id),
  },
  /** This app's own records, synced to every device. No permission needed. `kind` groups them ("item", "client"…). */
  data: {
    list: (kind) => call('data.list', kind),
    get: (id) => call('data.get', id),
    save: (kind, record) => call('data.save', kind, record),
    remove: (id) => call('data.remove', id),
  },
  /** Show a Leafdeck notification (needs "notify"). */
  notify: (title, body) => call('notify', title, body),
  /** Open a web page in a Leafdeck window. */
  openUrl: (url) => call('openUrl', url),
  /** Open a built-in Leafdeck app ("tasks", "calendar", "contacts"…), optionally at a record. */
  openApp: (appId, recordId) => call('openApp', appId, recordId),
  /** Change this window's title. */
  setTitle: (title) => call('setTitle', title),
  /** The app's controls in the window's title bar, drawn by Leafdeck like a built-in app's toolbar.
      Controls: { type: 'segmented' | 'search' | 'select' | 'button', id, ... }. Changes arrive as leafdeck.on('toolbar', ({ id, value }) => …). */
  toolbar: {
    set: (items) => call('toolbar.set', items),
    clear: () => call('toolbar.set', []),
  },
  /** A Leafdeck line icon as an SVG string. Or write <span data-icon="name"></span> and it fills in. */
  icon: (name, size) => iconSvg(String(name || ''), size),
  /** The icon names icon() and data-icon accept. */
  icons: () => Object.keys(iconPaths),
  /** Listen for "change" ({ collection }), "theme" ({ dark, accent }) and "toolbar" ({ id, value }). Returns a function that stops listening. */
  on: (type, fn) => {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  },
});
