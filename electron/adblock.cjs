// Built-in ad and tracker blocking, using Ghostery's engine with its prebuilt EasyList/EasyPrivacy lists.
//
// Electron allows one webRequest listener per event per session, and Leafdeck already uses onBeforeRequest
// for HTTPS-first, so the engine isn't enabled through its own enableBlockingInSession(); main.cjs calls
// `beforeRequest` / `headersReceived` from its listeners instead. Cosmetic filtering (hiding ad elements)
// uses the engine's own preload, registered alongside Leafdeck's.
//
// Settings live in config.json: adblock (default on) and adblockAllow (sites where it's paused).
const { app, ipcMain, webContents } = require('electron');
const fs = require('node:fs/promises');
const { readConfig, writeConfig, userFile, hostOf } = require('./common.cjs');

const CACHE = userFile('adblock-engine.bin');
const REFRESH_AFTER = 24 * 3600_000; // re-download the lists about once a day

let engine = null;
let loading = null;
let lastError = '';
let total = 0; // blocked since Leafdeck started
const perPage = new Map(); // webContents id -> { host, blocked }

const enabled = () => readConfig().adblock !== false;
const allowList = () => readConfig().adblockAllow || [];
const isAllowed = (host) => !!host && allowList().some((a) => host === a || host.endsWith('.' + a));

function pageHost(details) {
  // The site a request belongs to is the page shown in that webview, never the request's own host.
  try {
    return hostOf(webContents.fromId(details.webContentsId)?.mainFrame?.url || '');
  } catch {
    return '';
  }
}

async function build() {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, { path: CACHE, read: fs.readFile, write: fs.writeFile });
}

/** Load the engine: from the on-disk cache when there is one (fast), downloading the lists otherwise. */
function load() {
  if (engine || loading) return loading || Promise.resolve(engine);
  loading = (async () => {
    try {
      let stale = true;
      try {
        stale = Date.now() - (await fs.stat(CACHE)).mtimeMs > REFRESH_AFTER;
      } catch {}
      engine = await build();
      lastError = '';
      if (stale) refresh(); // use the cached lists now, fetch fresh ones in the background
    } catch (err) {
      lastError = `Couldn’t download the filter lists (${err.message}). Blocking starts once they load.`;
      setTimeout(() => {
        loading = null;
        load();
      }, 10 * 60_000);
    }
    return engine;
  })();
  return loading;
}

async function refresh() {
  try {
    await fs.rm(CACHE, { force: true });
    engine = await build();
  } catch {
    /* keep the lists we have */
  }
}

/* ---------- Request pipeline (called from main.cjs's session listeners) ---------- */

const active = (details) => !!engine && enabled() && !isAllowed(pageHost(details));

/** Returns true when it handled the request (and called back), false when the caller should. */
function beforeRequest(details, callback) {
  if (details.resourceType === 'mainFrame') {
    if (details.webContentsId) perPage.set(details.webContentsId, { host: hostOf(details.url), blocked: 0 });
    return false;
  }
  if (!active(details)) return false;
  engine.onBeforeRequest(details, (res) => {
    if (res && (res.cancel || res.redirectURL)) {
      total++;
      const p = perPage.get(details.webContentsId);
      if (p) p.blocked++;
    }
    callback(res || {});
  });
  return true;
}

function headersReceived(details, callback) {
  if (!active(details)) return false;
  engine.onHeadersReceived(details, callback);
  return true;
}

/* ---------- Cosmetic filtering: the engine's preload asks which elements to hide ---------- */

let preloadPath = '';
function preload() {
  if (!preloadPath) preloadPath = require.resolve('@ghostery/adblocker-electron-preload');
  return preloadPath;
}

/** Register the hide-elements preload on a site session (once per session). */
function attach(session) {
  try {
    session.registerPreloadScript({ type: 'frame', filePath: preload() });
  } catch (err) {
    console.warn('adblock preload:', err.message);
  }
}

function initIpc(isOurWebview) {
  // The page reports its URL; use the frame's real URL instead and ignore anything that isn't a site webview.
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, _url, msg) => {
    const wc = event.sender;
    if (!isOurWebview(wc) || !engine || !enabled() || isAllowed(hostOf(wc.mainFrame.url))) return;
    return engine.onInjectCosmeticFilters(event, event.senderFrame?.url || wc.getURL(), msg);
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) =>
    isOurWebview(event.sender) && !!engine && enabled() ? engine.onIsMutationObserverEnabled(event) : false,
  );
  app.on('web-contents-created', (_e, wc) => wc.once('destroyed', () => perPage.delete(wc.id)));
}

/* ---------- Status and settings for the UI ---------- */

function status(webContentsId) {
  const p = perPage.get(Number(webContentsId));
  let host = p?.host || '';
  if (!host) {
    try {
      host = hostOf(webContents.fromId(Number(webContentsId))?.getURL() || '');
    } catch {}
  }
  return { enabled: enabled(), ready: !!engine, error: lastError, host, allowed: isAllowed(host), blocked: p?.blocked || 0, total, allowList: allowList() };
}

function setEnabled(on) {
  writeConfig({ adblock: !!on });
  return status();
}

function allow(host, on) {
  host = String(host || '').toLowerCase().replace(/^www\./, '').slice(0, 253);
  if (!host) return status();
  const list = allowList().filter((h) => h !== host);
  if (on) list.push(host);
  writeConfig({ adblockAllow: list });
  return status();
}

module.exports = { load, beforeRequest, headersReceived, attach, initIpc, status, setEnabled, allow, isAllowed };
