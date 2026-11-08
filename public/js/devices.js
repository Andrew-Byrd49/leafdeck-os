// Companion devices (the Leafdeck Android app): keeps this desktop in step with the server and the phone.
//   - pulls changes other devices made (store.pull) on a timer and right after our own saves
//   - uploads this computer's browsing history and folds in visits from other devices
//   - reports our open site windows, shows "sent to this computer" links, and builds the send-to menus
//   - the pairing sheet (QR code) and the Devices rows in Settings
// Protocol: docs/companion-api.md.
import { store } from './store.js';
import { shell } from './shell.js';
import { $, el, esc } from './util.js';
import { icon } from './icons.js';
import { toast, openApp } from './wm.js';
import { qrcode } from './vendor-qrcode.js';

const PULL_FOCUSED = 15_000;
const PULL_BLURRED = 60_000;
const HISTORY_UPLOAD = 20_000;
const TABS_REPORT = 5_000;

export const otherDevices = () => (store.devices || []).filter((d) => d.id !== 'desktop');
const deviceName = (id) => (store.devices || []).find((d) => d.id === id)?.name || (id === 'desktop' ? 'Desktop' : 'another device');
const since = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

/* ---------------- Keeping in step ---------------- */

let pullTimer = null;
const seenSends = new Set();

function schedulePull(ms) {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(async () => {
    await store.pull();
    schedulePull(document.hasFocus() ? PULL_FOCUSED : PULL_BLURRED);
  }, ms);
}

export function initDevices() {
  // Only a server has other devices; the phone companion is shelved for data on this computer.
  if (store.mode !== 'cloud' || store.local) return;
  // Our own save just landed: see what the phone did meanwhile.
  let afterSave = null;
  store.addEventListener('status', (e) => {
    if (e.detail.status !== 'saved') return;
    clearTimeout(afterSave);
    afterSave = setTimeout(() => store.pull(), 1500);
  });
  store.addEventListener('sync', (e) => onSync(e.detail));
  addEventListener('focus', () => schedulePull(500));
  schedulePull(2000);

  if (shell) {
    uploadHistory();
    setInterval(uploadHistory, HISTORY_UPLOAD);
    setInterval(reportTabs, TABS_REPORT);
  }
}

async function onSync({ history, sends }) {
  if (history.length && shell) {
    const n = await shell.history.applyRemote(history).catch(() => 0);
    if (n) dispatchEvent(new CustomEvent('leafdeck:history', { detail: { remote: true } }));
  }
  for (const s of sends) {
    if (seenSends.has(s.id) || s.openedAt) continue;
    seenSends.add(s.id);
    if (Date.now() - s.createdAt > 24 * 3600_000) continue; // old ones from before this session: don't nag
    // Opens right away in a new site window (the web version has no site windows: it offers a button instead).
    const open = async () => {
      (await import('./apps/browser.js')).openWebPage(s.url);
      store.api(`/sends/${encodeURIComponent(s.id)}/opened`, { method: 'POST' }).catch(() => {});
    };
    if (shell) {
      open();
      toast(`Opened from ${deviceName(s.from)}: ${s.title || s.url}`);
    } else toast(`${deviceName(s.from)} sent: ${s.title || s.url}`, '', { label: 'Open', act: open });
  }
}

/* ---------------- History ---------------- */

let uploading = false;
async function uploadHistory() {
  if (uploading || !shell || store.mode !== 'cloud' || store.local) return;
  uploading = true;
  try {
    for (let i = 0; i < 10; i++) {
      const rows = await shell.history.pending(500);
      if (!rows.length) break;
      await store.api('/history/_bulk', { method: 'POST', body: JSON.stringify(rows) });
      await shell.history.markSynced(rows.map((r) => r.id));
      if (rows.length < 500) break;
    }
  } catch (err) {
    console.warn('history upload', err.message);
  } finally {
    uploading = false;
  }
}

/** Remove one visit everywhere (local row id + its shared id). */
export async function deleteVisit(localId, uid) {
  if (shell && localId != null) uid = (await shell.history.remove(Number(localId))) || uid;
  if (uid && store.mode === 'cloud' && !store.local) await store.api(`/history/${encodeURIComponent(uid)}`, { method: 'DELETE' }).catch(() => {});
}

/** Clear history everywhere since a time (0 = all). */
export async function clearVisits(sinceMs = 0) {
  if (store.mode === 'cloud' && !store.local) await store.api('/history/_clear', { method: 'POST', body: JSON.stringify({ since: sinceMs }) }).catch(() => {});
}

/* ---------------- Open tabs & sending ---------------- */

let lastTabs = '';

async function reportTabs() {
  if (store.mode !== 'cloud') return;
  const tabs = (await import('./apps/browser.js')).openSiteTabs().slice(0, 50);
  const key = JSON.stringify(tabs);
  if (key === lastTabs) return;
  lastTabs = key;
  await store.api('/devices/desktop/tabs', { method: 'PUT', body: JSON.stringify({ tabs }) }).catch(() => (lastTabs = ''));
}

export async function sendTo(deviceId, url, title = '') {
  await store.api('/sends', { method: 'POST', body: JSON.stringify({ url, title, to: deviceId }) });
  toast(`Sent to ${deviceId === 'all' ? 'your other devices' : deviceName(deviceId)}`);
}

/** Menu items: "Send to <phone>…" for a page. */
export function sendMenuItems(url, title) {
  const others = otherDevices();
  if (!url) return [{ label: 'Send to Phone', disabled: true }];
  if (!others.length) return [{ label: 'Send to Phone', disabled: true }, { header: 'Pair a phone in Settings → Devices' }];
  const items = others.map((d) => ({ label: `Send to ${d.name}`, act: () => sendTo(d.id, url, title).catch((e) => toast(e.message, 'error')) }));
  if (others.length > 1) items.push({ label: 'Send to All Devices', act: () => sendTo('all', url, title).catch((e) => toast(e.message, 'error')) });
  return items;
}

/** Menu items: what's open on other devices, each opening here. */
export function otherTabsMenuItems() {
  const items = [];
  for (const d of otherDevices()) {
    items.push({ header: `${d.name}${d.tabsAt ? ` · ${since(d.tabsAt)}` : ''}` });
    if (!d.tabs?.length) items.push({ label: 'Nothing open', disabled: true });
    for (const t of d.tabs.slice(0, 12)) {
      items.push({ label: (t.title || t.url).slice(0, 60), act: async () => (await import('./apps/browser.js')).openWebPage(t.url) });
    }
  }
  return items.length ? items : [{ label: 'No other devices', disabled: true }, { header: 'Pair a phone in Settings → Devices' }];
}

/* ---------------- Settings: Devices ---------------- */

export function devicesRowsHtml() {
  const list = store.devices || [];
  if (!list.length) return '<div class="set-row"><div><span class="muted small">Loading…</span></div></div>';
  return list
    .map((d) => {
      const tabs = d.tabs?.length ? `${d.tabs.length} open` : '';
      const seen = d.id === 'desktop' ? 'This computer' : `Last seen ${since(d.lastSeen)}`;
      return `<div class="set-row"><div><span>${icon(d.kind === 'android' ? 'phone' : 'layout', 13)} ${esc(d.name)}</span><small>${esc(seen)}${tabs ? ` · ${esc(tabs)}` : ''}</small></div>
        <div class="set-ctl">${d.id === 'desktop' ? '' : `<button class="btn small danger" data-device-revoke="${esc(d.id)}">Remove</button>`}</div></div>`;
    })
    .join('');
}

export async function revokeDevice(id) {
  await store.api(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  store.devices = (store.devices || []).filter((d) => d.id !== id);
  toast('Device removed — it will need to pair again');
}

/** The QR code the phone scans. Lives in a sheet on the Settings window. */
export function openPairingSheet(win) {
  const node = el(`<div class="rec-form pair-sheet">
    <div class="sheet-head"><div><h2>Pair a phone</h2><small>In the Leafdeck app on your phone, tap “Pair with your desktop” and scan this.</small></div></div>
    <div class="sheet-scroll"><div class="pair-body"><div class="qr" data-qr></div>
      <div class="pair-side"><div class="pair-code" data-code>····-····</div><small class="muted" data-exp>Getting a code…</small>
        <small class="muted">Or type the code into the app. Each code works once and expires after 10 minutes.</small></div></div></div>
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-new>New code</button><button type="button" class="btn primary" data-done>Done</button></div></div>`);
  const sh = win.sheet(node);
  let expiry = null;
  const fresh = async () => {
    clearTimeout(expiry);
    try {
      const extras = shell ? await shell.pairingExtras() : { serverUrl: location.origin, access: null };
      const { code, expiresAt } = await store.api('/devices/pair', { method: 'POST' });
      const payload = { u: extras.serverUrl, c: code };
      if (extras.access) payload.a = extras.access;
      const qr = qrcode(0, 'M');
      qr.addData(JSON.stringify(payload), 'Byte');
      qr.make();
      $('[data-qr]', node).innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      $('[data-code]', node).textContent = code;
      const tickExp = () => {
        const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        $('[data-exp]', node).textContent = s ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired — get a new code';
        if (s) expiry = setTimeout(tickExp, 1000);
      };
      tickExp();
    } catch (err) {
      $('[data-exp]', node).textContent = err.message;
    }
  };
  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) fresh();
    if (e.target.closest('[data-done]')) {
      clearTimeout(expiry);
      sh.close();
      store.pull();
    }
  });
  fresh();
}

export const openDevicesSettings = () => openApp('settings');
