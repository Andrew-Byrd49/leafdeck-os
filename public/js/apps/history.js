// History — visits recorded by the main process, kept only on this computer.

import { $, esc, el, debounce } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast } from '../wm.js';
import { shell } from '../shell.js';
import { favicon } from './bookmarks.js';
import { openWebPage } from './browser.js';
import { store } from '../store.js';
import { deleteVisit, clearVisits } from '../devices.js';

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};
const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
const timeLabel = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Clear browsing data" sheet, shared with Settings. */
export function openClearDataSheet(win, onDone) {
  const node = el(`<form class="rec-form">
    <div class="sheet-head"><div><h2>Clear browsing data</h2><small>Bookmarks, passwords and your Leafdeck records aren’t affected.</small></div></div>
    <div class="sheet-scroll"><div class="form-grid">
      <label class="field span2"><span>Time range (history)</span><select name="range">
        <option value="3600000">Last hour</option><option value="86400000">Last 24 hours</option>
        <option value="604800000">Last 7 days</option><option value="0" selected>All time</option></select></label>
      <label class="field check span2"><input type="checkbox" name="history" checked><span>Browsing history</span></label>
      <label class="field check span2"><input type="checkbox" name="cache" checked><span>Cached images and files</span></label>
      <label class="field check span2"><input type="checkbox" name="cookies"><span>Cookies and site data — signs you out of websites</span></label>
    </div></div>
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary danger-solid">Clear data</button></div></form>`);
  const sh = win.sheet(node);
  node.addEventListener('click', (e) => e.target.closest('[data-cancel]') && sh.close());
  node.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = node.elements;
    const range = Number(f.range.value);
    const since = range ? Date.now() - range : 0;
    if (shell) await shell.browsing.clear({ since, history: f.history.checked, cache: f.cache.checked, cookies: f.cookies.checked });
    if (f.history.checked) await clearVisits(since); // every device's copy too
    sh.close();
    toast('Browsing data cleared');
    onDone?.();
  });
}

registerApp({
  id: 'history',
  name: 'History',
  icon: 'clock',
  size: [860, 640],
  min: [480, 360],
  mount(win) {
    if (!shell && store.mode !== 'cloud') {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">History lives in the Leafdeck app</div>
        <p>Browsing history is recorded by the Leafdeck desktop app and shared through your server.</p></div>`;
      return;
    }
    let q = '';
    let rows = [];
    let done = false;

    win.tools.innerHTML = `<label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search history"></label>
      <button class="tb-pill" data-clear-data>Clear browsing data…</button>`;

    const draw = () => {
      if (!rows.length) {
        win.body.innerHTML = `<div class="empty"><div class="empty-title">${q ? 'No matches' : 'No history yet'}</div>
          <p>${q ? 'Try different words.' : 'Pages you visit in Leafdeck — on this computer or your phone — show up here.'}</p></div>`;
        return;
      }
      let day = '';
      win.body.innerHTML = `<div class="hist">${rows
        .map((r) => {
          const d = dayLabel(r.visitedAt);
          const head = d !== day ? `<h4>${esc((day = d))}</h4>` : '';
          const from = r.deviceId && r.deviceId !== 'desktop' ? `<span class="chip hist-dev">${icon('phone', 10)} ${esc(r.deviceName || 'Phone')}</span>` : '';
          return `${head}<div class="hist-row" data-id="${esc(String(r.id))}" data-uid="${esc(r.uid || (shell ? '' : r.id))}" data-url="${esc(r.url)}" title="${esc(r.url)}">
            <span class="hist-time">${timeLabel(r.visitedAt)}</span>
            <img class="fav" src="${esc(favicon(r.url))}" alt="" loading="lazy" referrerpolicy="no-referrer">
            <span class="bm-main"><b>${esc(r.title || hostOf(r.url))}</b><small>${esc(hostOf(r.url))}${from}</small></span>
            <button class="icon-btn" data-remove title="Remove from history">${icon('x', 13)}</button></div>`;
        })
        .join('')}${done ? '' : '<div class="hist-more"><button class="btn small" data-more>Load more</button></div>'}</div>`;
    };

    const load = async (more = false) => {
      const before = more && rows.length ? rows[rows.length - 1].visitedAt : Date.now() + 1;
      // The desktop app keeps a local copy of every device's visits; the web version asks the server.
      const page = shell
        ? await shell.history.list({ q, before, limit: 300 })
        : await store.api(`/history?q=${encodeURIComponent(q)}&before=${before}&limit=300`);
      rows = more ? [...rows, ...page] : page;
      done = page.length < 300;
      draw();
    };

    win.tools.addEventListener('input', debounce((e) => {
      q = e.target.value;
      load();
    }, 150));
    win.tools.addEventListener('click', (e) => e.target.closest('[data-clear-data]') && openClearDataSheet(win, () => load()));
    win.body.addEventListener('click', async (e) => {
      if (e.target.closest('[data-more]')) return load(true);
      const row = e.target.closest('[data-id]');
      if (!row) return;
      if (e.target.closest('[data-remove]')) {
        await deleteVisit(shell ? row.dataset.id : null, row.dataset.uid);
        rows = rows.filter((r) => String(r.id) !== row.dataset.id);
        return draw();
      }
      openWebPage(row.dataset.url);
    });

    // Visits from the phone arrived: refresh (only while nothing is typed, so a search isn't disturbed).
    const onRemote = () => {
      if (!win.el.isConnected) return removeEventListener('leafdeck:history', onRemote);
      if (!q) load();
    };
    addEventListener('leafdeck:history', onRemote);
    load();
  },
});
