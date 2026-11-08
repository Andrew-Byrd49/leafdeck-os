// Real browser windows inside the desktop (Electron only).
// Each window hosts a <webview>: a separate top-level browsing context, so sites that refuse to be framed
// still load, and logins persist in a shared "persist:web" session (like a browser profile).

import { $, $$, esc, el, debounce } from '../util.js';
import { icon, flameIcon } from '../icons.js';
import { addResolver, openApp, focus, closeMenu, showMenu, toast, wins, activeWindow, closeWindow, onWM, refreshAppIcon, setBadge, badgeFromTitle, snapTo, toggleMax, toggleMini, setRect, syncFullscreen, screenOf } from '../wm.js';
import { store } from '../store.js';
import { editRecord, recordMatches } from '../schemas.js';
import { shell } from '../shell.js';
import { findBookmark, favicon } from './bookmarks.js';
import { toggleBookmarksPanel, closeBookmarksPanel } from './bookmarkspanel.js';
import { drawStartBookmarks } from './startpage.js';
import { toggleOverview } from '../overview.js';
import { openFocusSetup } from '../focus.js';
import { focusSearch } from '../search.js';

export const SHARED_PARTITION = 'persist:web';
/** Burner windows: a fresh in-memory session each, wiped when the window (and any it opened) closes. */
export const isBurnerPartition = (p) => /^burner-/.test(p || '');
const newBurnerPartition = () => 'burner-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);

// Second-level suffixes where the registrable ("root") domain has three labels: example.co.uk, example.com.au…
const TWO_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'co.in', 'firm.in', 'com.br', 'com.mx', 'com.ar', 'com.cn', 'com.hk', 'com.sg', 'com.tr', 'co.za', 'co.il', 'com.tw']);
/** The registrable domain of a URL ("docs.google.com" → "google.com"), for deciding whether a new page opens as a tab. */
export function rootDomain(u) {
  let h = '';
  try {
    h = new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h; // IP address or single label (localhost)
  const parts = h.split('.');
  const n = TWO_PART_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/* ---------------- Search engines & address parsing ---------------- */

export const ENGINES = {
  google: ['Google', 'https://www.google.com/search?q='],
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q='],
  bing: ['Bing', 'https://www.bing.com/search?q='],
  brave: ['Brave Search', 'https://search.brave.com/search?q='],
  kagi: ['Kagi', 'https://kagi.com/search?q='],
  ecosia: ['Ecosia', 'https://www.ecosia.org/search?q='],
};
export const engine = () => ENGINES[store.prefs.searchEngine] || ENGINES.google;
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com|kagi\.com|ecosia\.org)$/i;
/** The words of a past web search, from a search-results address (else ''). */
export function searchQueryOf(u) {
  try {
    const x = new URL(u);
    if (!SEARCH_HOSTS.test(x.hostname)) return '';
    if (/google\./i.test(x.hostname) && x.pathname !== '/search') return '';
    return (x.searchParams.get('q') || '').trim();
  } catch {
    return '';
  }
}
export const searchUrl = (q) => engine()[1] + encodeURIComponent(q);

/** A file:// link to a path on this computer. */
export const fileUrlOf = (p) => 'file://' + String(p).split('/').map(encodeURIComponent).join('/');
const safeDecode = (u) => {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
};

/** A URL if the text looks like one (adding https:// or, for local addresses, http://); otherwise null. */
export function toUrl(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (shell?.platform === 'linux' && /^(file:\/\/)?\//i.test(t)) return t.startsWith('/') ? fileUrlOf(t) : t; // a page on this computer
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+\.(localhost|local|test))(:\d+)?([/?#].*)?$/i.test(t)) return 'http://' + t;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
  return null;
}
export const resolveInput = (text) => toUrl(text) || searchUrl(String(text).trim());

/* ---------------- Address suggestions (history + bookmarks) ---------------- */

function attachSuggest(win, input, onPick) {
  const box = el('<div class="addr-suggest" hidden></div>');
  win.el.append(box);
  let items = [];
  let sel = 0;
  let seq = 0;

  const place = () => {
    const r = input.getBoundingClientRect();
    const w = win.el.getBoundingClientRect();
    box.style.left = r.left - w.left + 'px';
    box.style.top = r.bottom - w.top + 6 + 'px';
    box.style.width = Math.max(r.width, 360) + 'px';
  };
  const render = () => {
    box.innerHTML = items
      .map(
        (it, i) => `<button type="button" class="addr-item ${i === sel ? 'on' : ''}" data-i="${i}">
          ${it.fav ? `<img class="fav" src="${esc(favicon(it.url))}" alt="" referrerpolicy="no-referrer">` : icon(it.icon, 14)}
          <span><b>${esc(it.title)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`,
      )
      .join('');
    box.hidden = !items.length;
    place();
  };
  const update = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q || document.activeElement !== input) {
      items = [];
      return render();
    }
    const url = toUrl(q);
    const head = url
      ? [{ icon: 'globe', title: url, sub: 'Go to address', url }]
      : [{ icon: 'search', title: q, sub: `Search ${engine()[0]}`, url: searchUrl(q) }];
    const marks = store.all('bookmarks').filter((b) => recordMatches('bookmarks', b, q)).slice(0, 3)
      .map((b) => ({ fav: true, title: b.title || hostOf(b.url), sub: `Bookmark · ${hostOf(b.url)}`, url: b.url }));
    let hist = [];
    try {
      hist = (await shell.history.search(q, 6)).map((h) => ({ fav: true, title: h.title || hostOf(h.url), sub: h.url, url: h.url }));
    } catch {}
    if (mine !== seq) return;
    const seen = new Set();
    items = [...head, ...marks, ...hist].filter((it) => !seen.has(it.url) && seen.add(it.url)).slice(0, 8);
    sel = 0;
    render();
  }, 90);

  const close = () => {
    items = [];
    render();
  };
  input.addEventListener('input', update);
  // Capture phase, so picking a suggestion wins over the input's own Enter handling.
  input.addEventListener(
    'keydown',
    (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        render();
      } else if (e.key === 'Enter' && items[sel] && sel > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onPick(items[sel].url);
        close();
      } else if (e.key === 'Escape') close();
    },
    true,
  );
  input.addEventListener('blur', () => setTimeout(close, 150));
  box.addEventListener('pointerdown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    onPick(items[b.dataset.i].url);
    close();
  });
  return { close };
}

/* ---------------- Recently closed (Ctrl+Shift+T) ---------------- */

const closedStack = [];
export function reopenClosed() {
  const last = closedStack.pop();
  if (last) openWebPage(last.url, last.partition);
  else toast('No recently closed windows');
}

/* ---------------- Memory saver ---------------- */

const lastActive = new Map(); // window id -> last time it was the active window
let restoring = false;
/** While true (session restore at startup), browser windows start asleep instead of loading. */
export function setRestoring(v) {
  restoring = v;
  if (!v) activeWindow()?.web?.wake(); // only the front window loads after a restart
}

let saver = { sleepAfterMin: 60, pauseMinimized: true };
export async function refreshSaverSettings() {
  if (!shell) return;
  try {
    const s = await shell.browsing.settings();
    saver = { sleepAfterMin: s.sleepAfterMin, pauseMinimized: s.pauseMinimized };
  } catch {}
}

const PAUSE_AFTER_MS = 10_000; // minimized this long → paused

if (shell) {
  // The window you switch to wakes up (if asleep) and resumes (if paused); minimized ones get paused below.
  onWM(() => {
    if (restoring) return;
    const a = activeWindow();
    if (a) lastActive.set(a.id, Date.now());
    for (const w of wins.values()) {
      const web = w.web;
      if (!web) continue;
      if (w === a && web.sleeping) web.wake();
      if (!w.minimized && web.frozen) {
        web.frozen = false;
        const id = web.wcId();
        if (id) shell.perf.freeze(id, false);
      }
    }
  });

  refreshSaverSettings();
  setInterval(async () => {
    const active = activeWindow();
    for (const w of [...wins.values()]) {
      const web = w.web;
      if (!web || w === active || web.sleeping) continue;
      const id = web.wcId();
      if (!id) continue;
      const idle = Date.now() - (lastActive.get(w.id) || 0);
      let keep = false;
      try {
        keep = await shell.perf.keepActive(id);
      } catch {
        continue;
      }
      if (keep) continue;
      if (saver.sleepAfterMin && idle > saver.sleepAfterMin * 60_000) web.sleep();
      else if (saver.pauseMinimized && w.minimized && !web.frozen && idle > PAUSE_AFTER_MS) {
        const r = await shell.perf.freeze(id, true);
        if (r?.ok && w.minimized) web.frozen = true;
      }
    }
  }, 15_000);
}

/* ---------------- The browser view ---------------- */

const LOCK = '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/**
 * Render a browser into `win`. With no `url`, shows a start page with the address box.
 * Calls `onTitle(title)` and `onUrl(url)` as the page changes; sets `win.web` (used by shortcuts).
 */
/* ---------------- Site icons ----------------
   Pages report their webclip (apple-touch-icon) and favicon from the webview preload. Many sites serve a
   webclip at /apple-touch-icon.png without declaring it, so try that before settling for the favicon. */

const isIconUrl = (u) => typeof u === 'string' && u.length < 4096 && /^(https?:|data:image\/)/i.test(u);
const probed = new Map(); // origin -> Promise<url | ''>

function probeWebclip(origin) {
  if (!/^https?:/.test(origin)) return Promise.resolve('');
  if (!probed.has(origin)) {
    probed.set(
      origin,
      new Promise((resolve) => {
        const img = new Image();
        const src = `${origin}/apple-touch-icon.png`;
        img.onload = () => resolve(img.naturalWidth >= 57 ? src : '');
        img.onerror = () => resolve('');
        img.referrerPolicy = 'no-referrer';
        img.src = src;
        setTimeout(() => resolve(''), 8000);
      }),
    );
  }
  return probed.get(origin);
}

/** Resolve a page's report to { clip, large, fav } (any may be ''). Only a webclip is a full-bleed icon. */
async function siteIcons(report, pageUrl) {
  let origin = '';
  try {
    origin = new URL(pageUrl).origin;
  } catch {}
  if (!report || report.origin !== origin) return null; // stale report from a previous page
  const fav = isIconUrl(report.fav) ? report.fav : '';
  const large = isIconUrl(report.large) ? report.large : '';
  const clip = isIconUrl(report.clip) ? report.clip : await probeWebclip(origin);
  return { clip, large, fav };
}

export function mountWeb(win, { url = '', partition = SHARED_PARTITION, onTitle, onUrl, onIcons, tabs: savedTabs, activeTab = 0, onTabs, handoff }) {
  const burner = isBurnerPartition(partition);
  // Navigation and the address bar lead the title bar; the site's icon and name follow; then the page tools.
  win.el.classList.add('site');
  $('.win-title', win.el).insertAdjacentHTML(
    'beforebegin',
    `<div class="web-nav">
    <button class="tb-btn" data-nav="back" title="Back (Alt+←)" disabled>${icon('left', 15)}</button>
    <button class="tb-btn" data-nav="forward" title="Forward (Alt+→)" disabled>${icon('right', 15)}</button>
    <button class="tb-btn" data-nav="reload" title="Reload (Ctrl+R)">${icon('refresh', 14)}</button>
    <label class="tb-address" title="">
      <span class="addr-badge">${burner ? flameIcon(13) : icon('globe', 12)}</span>
      <input class="addr-input" spellcheck="false" autocomplete="off" placeholder="Search or type a URL">
    </label>
    <button class="tb-btn" data-nav="star" title="Bookmark this page (Ctrl+D)">${icon('star', 14)}</button>
    <button class="tb-btn" data-nav="bookmarks" title="Bookmarks">${icon('bookmark', 14)}</button>
    </div>`,
  );
  const navBar = $('.web-nav', win.el);
  win.tools.innerHTML = `
    <button class="tb-pill tb-zoom" data-nav="zoom-reset" title="Reset zoom (Ctrl+0)" hidden></button>
    <button class="tb-btn tb-sound" data-nav="sound" title="Mute this page" hidden>${icon('volume', 14)}</button>
    <button class="tb-btn tb-key" data-nav="key" title="Fill a saved login" hidden>${icon('key', 14)}</button>
    <button class="tb-btn tb-shield" data-nav="shield" title="Ads & trackers blocked on this page">${icon('shield', 14)}<i class="tb-badge" hidden></i></button>
    <button class="tb-btn" data-nav="menu" title="More">${icon('dots', 15)}</button>`;
  win.body.innerHTML = '<div class="embed web"><div class="web-progress"></div></div>';
  if (burner) {
    // The burning title bar: a glow and rising embers behind the bar's contents (transform/opacity only).
    win.el.classList.add('burner');
    $('.win-bar', win.el).insertAdjacentHTML('afterbegin', '<div class="burn-fx" aria-hidden="true"><i class="burn-glow"></i><i class="burn-embers"></i><i class="burn-embers e2"></i></div>');
  }

  const wrap = $('.embed', win.body);
  const back = $('[data-nav=back]', navBar);
  const fwd = $('[data-nav=forward]', navBar);
  const addr = $('.addr-input', navBar);
  const badge = $('.addr-badge', navBar);
  const addrWrap = $('.tb-address', navBar);
  const zoomPill = $('.tb-zoom', win.tools);
  const starBtn = $('[data-nav=star]', navBar);
  const keyBtn = $('[data-nav=key]', win.tools);
  let wv = null; // the active tab's <webview>
  let accounts = [];

  /* ----- tabs: a strip across the top of the window, like a traditional browser ----- */
  const tabs = []; // { id, wv, url, title, icons, loading }
  let active = null;
  let tabSeq = 0;
  const newTab = (u, title = '') => {
    const t = { id: ++tabSeq, wv: null, url: u || '', title, icons: null, loading: false };
    tabs.push(t);
    return t;
  };
  for (const t of savedTabs?.length > 1 ? savedTabs : [{ url }]) newTab(t.url, t.title);
  // A tab dragged out of another window: what it had there (its history comes back as its page is made).
  if (handoff) Object.assign(tabs[0], { title: handoff.title || '', icons: handoff.icons || null, muted: !!handoff.muted, restore: handoff.history || null });
  active = tabs[Math.min(Math.max(activeTab | 0, 0), tabs.length - 1)];
  url = active.url;
  let current = url;
  const saveTabs = () => onTabs?.(tabs.map((t) => ({ url: t.url, title: t.title })), tabs.indexOf(active));

  // The strip is the window's first row: tabs, a new-tab button, then the window controls (back in the title bar for a mini window).
  const tabStrip = el(`<div class="win-tabs"><div class="win-tab-list" role="tablist"></div>
    <button class="win-tab-new" data-tab-new title="New tab (Ctrl+T)" aria-label="New tab">${icon('plus', 14)}</button></div>`);
  const tabList = $('.win-tab-list', tabStrip);
  const lights = $('.lights', win.el);
  win.el.prepend(tabStrip);
  const placeLights = () => {
    const home = win.el.classList.contains('mini') ? $('.win-bar', win.el) : tabStrip;
    if (lights.parentNode !== home) home.append(lights);
  };
  placeLights();
  const placeObserver = new MutationObserver(placeLights);
  placeObserver.observe(win.el, { attributes: true, attributeFilter: ['class'] });
  win.cleanups.push(() => placeObserver.disconnect());
  const tabIcon = (t) => {
    if (!t.url) return `<span class="win-tab-ic">${icon('search', 12)}</span>`;
    return `<img class="fav win-tab-ic" src="${esc(t.icons?.fav || favicon(t.url))}" alt="" referrerpolicy="no-referrer">`;
  };
  let held = false; // a tab drag (or one arriving from another window) owns the strip; it renders when that's over
  let renderLater = false;
  const renderTabs = () => {
    if (held) return void (renderLater = true);
    renderLater = false;
    tabList.innerHTML = tabs
      .map((t) => {
        const label = t.title || hostOf(t.url) || 'New tab';
        const sound = t.muted ? `<i class="win-tab-sound muted" title="Muted">${icon('volume-x', 10)}</i>` : t.audible ? `<i class="win-tab-sound" title="Playing audio">${icon('volume', 10)}</i>` : '';
        return `<div class="win-tab no-drag${t === active ? ' on' : ''}" role="tab" aria-selected="${t === active}" data-tab="${t.id}" title="${esc(label)}">${tabIcon(t)}<span>${esc(label)}</span>${sound}<button class="win-tab-x" data-tab-close="${t.id}" aria-label="Close tab" title="Close tab (Ctrl+W)">${icon('x', 10)}</button></div>`;
      })
      .join('');
  };
  const tabById = (id) => tabs.find((t) => String(t.id) === String(id));
  /* ----- dragging tabs -----
     Sideways, the tab follows the pointer and the others slide aside to open the gap it will land in (outlined); let go
     and it settles there. Pulled up or down out of the strip, it comes loose as a card with a picture of its page: over
     another browser window's tabs (one with the same logins) that window opens a gap for it, and letting go there moves
     it in; anywhere else it becomes a window of its own (a window with only this tab just moves there). Esc puts it back.
     A <webview> can't change windows, so a moved tab is a new page that gets the old one's history and scroll place. */
  const SETTLE_MS = 190;
  const settled = () => new Promise((r) => setTimeout(r, SETTLE_MS));
  let drag = null;
  let dragged = false; // the click that ends a drag isn't a click on the tab

  const dragDone = (d) => {
    d.ghost?.remove();
    d.slot?.remove();
    setTarget(d, null);
    tabStrip.classList.remove('reordering');
    if (drag === d) drag = null;
    held = false;
    renderTabs(); // fresh tabs, without the drag's transforms
  };
  const slotX = (d) => (d.to > d.from ? d.rects[d.to].right - d.w : d.rects[d.to].left);
  const placeSlot = (d) => (d.slot.style.transform = `translateX(${slotX(d) - d.list.left}px)`);

  const beginDrag = (d) => {
    d.tab = tabById(d.id);
    if (!d.tab) return false;
    if (d.tab !== active) selectTab(d.tab); // the tab you pick up is the one showing, as in any browser
    d.moved = true;
    held = true;
    document.body.classList.add('wm-busy'); // pages under the pointer don't take it
    tabStrip.classList.add('reordering');
    d.els = [...tabList.querySelectorAll('[data-tab]')];
    d.el = d.els.find((x) => x.dataset.tab === String(d.id));
    d.from = d.to = d.els.indexOf(d.el);
    d.rects = d.els.map((x) => x.getBoundingClientRect());
    d.list = tabList.getBoundingClientRect();
    d.home = d.rects[d.from];
    d.w = d.home.width;
    d.el.classList.add('dragging');
    d.slot = el('<div class="win-tab-slot" aria-hidden="true"></div>');
    d.slot.style.width = `${d.w}px`;
    tabList.append(d.slot);
    placeSlot(d);
    d.onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      endDrag(d, false);
    };
    addEventListener('keydown', d.onKey, true);
    return true;
  };

  // In the strip: follow the pointer sideways and open the gap where it would land.
  const reorderFrame = (d, x) => {
    const dx = Math.max(d.rects[0].left - d.home.left, Math.min(d.rects.at(-1).right - d.home.right, x - d.x));
    d.el.style.transform = `translateX(${dx}px)`;
    const mid = d.home.left + d.w / 2 + dx;
    let to = 0;
    d.rects.forEach((r, i) => i !== d.from && r.left + r.width / 2 < mid && to++);
    if (to === d.to && d.laidOut) return;
    d.to = to;
    d.laidOut = true;
    d.els.forEach((t, i) => {
      if (i === d.from) return;
      const shift = i > d.from && i <= to ? -d.w : i < d.from && i >= to ? d.w : 0;
      t.style.transform = shift ? `translateX(${shift}px)` : '';
    });
    placeSlot(d);
  };

  // A card of the tab and its page, following the pointer while it's out of the strip.
  const makeGhost = (d) => {
    const t = d.tab;
    const g = el(`<div class="tab-ghost" aria-hidden="true"><div class="tab-ghost-head">${tabIcon(t)}<span>${esc(t.title || hostOf(t.url) || 'New tab')}</span></div>
      <div class="tab-ghost-shot"></div><div class="tab-ghost-hint"></div></div>`);
    const r = wrap.getBoundingClientRect();
    if (r.width > 0) $('.tab-ghost-shot', g).style.setProperty('--shot-h', `${Math.round(Math.min(180, Math.max(100, (260 * r.height) / r.width)))}px`);
    if (t === active && t.wv && !sleeping) {
      Promise.resolve()
        .then(() => t.wv.capturePage())
        .then((img) => {
          const u = img?.toDataURL?.();
          if (!u || !g.isConnected) return;
          $('.tab-ghost-shot', g).style.backgroundImage = `url(${u})`;
          g.classList.add('has-shot');
        })
        .catch(() => {});
    }
    document.body.append(g);
    return g;
  };
  const loosen = (d) => {
    d.loose = true;
    d.laidOut = false;
    d.el.classList.add('lifted');
    d.slot.classList.add('off');
    // The others close up behind it.
    d.els.forEach((t, i) => i !== d.from && (t.style.transform = i > d.from ? `translateX(${-d.w}px)` : ''));
    d.ghost ||= makeGhost(d);
    d.ghost.classList.remove('hidden');
  };
  const reattach = (d) => {
    d.loose = false;
    d.el.classList.remove('lifted');
    d.slot.classList.remove('off');
    d.ghost?.classList.add('hidden');
    setTarget(d, null);
  };
  const setTarget = (d, t) => {
    if (d.target === t) return;
    d.target?.web?.tabDrop.clear();
    d.target = t;
    if (t) focus(t); // in front, so the gap opening in its tabs shows
  };
  /** The browser window whose tabs are under x, y, if this tab can go there (the same logins). This window doesn't count
   *  (picking up its tab brought it to the front): the one under it does. */
  const dropTargetAt = (x, y) => {
    for (const node of document.elementsFromPoint(x, y)) {
      const winEl = node.closest?.('.win');
      if (!winEl || winEl === win.el) continue;
      const w = [...wins.values()].find((o) => o.el === winEl);
      return w?.web?.tabDrop?.accepts(partition, y) ? w : null;
    }
    return null;
  };
  const looseFrame = (d, x, y) => {
    const target = dropTargetAt(x, y);
    setTarget(d, target);
    // Over another window the tab itself shows in the gap there; the card shrinks to a note beside the pointer.
    d.ghost.style.transform = target ? `translate(${x + 14}px, ${y + 20}px)` : `translate(${x - 22}px, ${y - 16}px)`;
    target?.web.tabDrop.preview(x, d.w, `${tabIcon(d.tab)}<span>${esc(d.tab.title || hostOf(d.tab.url) || 'New tab')}</span>`);
    d.ghost.classList.toggle('joining', !!target);
    const hint = target ? 'Move to this window' : tabs.length > 1 ? 'Open in a new window' : 'Move this window here';
    const hintEl = $('.tab-ghost-hint', d.ghost);
    if (hintEl.dataset.hint !== hint) {
      hintEl.dataset.hint = hint;
      hintEl.innerHTML = `${icon(target ? 'down' : 'new-window', 12)}<span>${hint}</span>`;
    }
  };
  const dragFrame = (d) => {
    const { x, y } = d.at;
    const s = tabStrip.getBoundingClientRect();
    const over = document.elementFromPoint(x, y)?.closest('.win');
    const inStrip = !win.minimized && y > s.top - 28 && y < s.bottom + 28 && x > s.left - 40 && x < s.right + 40 && (!over || over === win.el);
    if (inStrip) {
      if (d.loose) reattach(d);
      reorderFrame(d, x);
    } else {
      if (!d.loose) loosen(d);
      looseFrame(d, x, y);
    }
  };

  /** What another window needs to carry on with tab `t`: its address and title, and its history when it has a page. */
  const handOff = async (t) => {
    let history = null;
    try {
      if (t.wv) history = await shell.browsing.history(t.wv.getWebContentsId());
    } catch {}
    return { url: t.url, title: t.title, icons: t.icons, muted: !!t.muted, history };
  };
  let handedOff = false; // this window's last tab moved to another one: closing it isn't closing that page
  /** Tab `t` went to another window: let go of it here (the window, when it was the last). */
  const release = (t) => {
    if (tabs.length === 1) {
      handedOff = true;
      return closeWindow(win, true);
    }
    const i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.splice(i, 1);
    t.wv?.remove();
    if (t === active) {
      active = null;
      selectTab(tabs[Math.min(i, tabs.length - 1)]);
    }
    saveTabs();
  };

  const endDrag = async (d, commit) => {
    if (drag !== d || d.ending) return;
    stopFollowing();
    if (!d.moved) return void (drag = null);
    d.ending = true;
    cancelAnimationFrame(d.frame);
    removeEventListener('keydown', d.onKey, true);
    document.body.classList.remove('wm-busy');
    dragged = true;
    setTimeout(() => (dragged = false));
    if (commit && d.at) dragFrame(d); // where it really ended
    const t = d.tab;
    if (!commit) {
      // Back where it was.
      reattach(d);
      d.to = d.from;
      d.el.classList.add('settling');
      for (const x of d.els) x.style.transform = '';
      placeSlot(d);
      await settled();
    } else if (!d.loose) {
      // Into the gap it opened.
      d.el.classList.add('settling');
      d.el.style.transform = `translateX(${slotX(d) - d.home.left}px)`;
      await settled();
      if (d.to !== d.from) {
        tabs.splice(tabs.indexOf(t), 1);
        tabs.splice(d.to, 0, t);
        saveTabs();
      }
    } else if (d.target) {
      const target = d.target;
      const data = await handOff(t);
      target.web.tabDrop.take(data);
      d.target = null;
      release(t);
      focus(target);
    } else if (tabs.length > 1) {
      const data = await handOff(t);
      const nw = openWebPage(t.url, partition, data);
      if (nw?.rect) {
        // This window's size, with its first tab where the card was let go (kept on the screen).
        const size = (win.max && win.prev) || win.rect;
        const host = nw.el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
        setRect(nw, { x: d.at.x - host.left - 70, y: d.at.y - host.top - 18, w: size.w, h: size.h });
      }
      release(t);
    } else if (win.max && win.prev) {
      // Its only tab pulled out of a full-size window: the window, at its usual size, where it was let go.
      const host = win.el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
      setRect(win, { ...win.prev, x: d.at.x - host.left - 70, y: d.at.y - host.top - 18 });
    } else {
      setRect(win, { ...win.rect, x: win.rect.x + d.at.x - d.x, y: win.rect.y + d.at.y - d.y });
    }
    dragDone(d);
  };

  // From the press on, the pointer is followed wherever it goes (a quick flick leaves the strip before it counts as a drag).
  const onDragMove = (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.pid || d.ending) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      if (!beginDrag(d)) {
        stopFollowing();
        drag = null;
        return;
      }
    }
    d.at = { x: e.clientX, y: e.clientY };
    // High-rate mice send several moves a frame: lay out once a frame, at the latest.
    d.frame ||= requestAnimationFrame(() => {
      d.frame = 0;
      if (drag === d && !d.ending) dragFrame(d);
    });
  };
  const onDragUp = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    stopFollowing();
    if (drag.moved) drag.at = { x: e.clientX, y: e.clientY };
    endDrag(drag, e.type === 'pointerup');
  };
  const stopFollowing = () => {
    removeEventListener('pointermove', onDragMove, true);
    removeEventListener('pointerup', onDragUp, true);
    removeEventListener('pointercancel', onDragUp, true);
  };
  tabStrip.addEventListener('pointerdown', (e) => {
    const tabEl = e.button === 0 && !drag && !e.target.closest('[data-tab-close]') && e.target.closest('[data-tab]');
    if (!tabEl) return;
    drag = { id: tabEl.dataset.tab, x: e.clientX, y: e.clientY, pid: e.pointerId, moved: false };
    addEventListener('pointermove', onDragMove, true);
    addEventListener('pointerup', onDragUp, true);
    addEventListener('pointercancel', onDragUp, true);
  });
  win.cleanups.push(stopFollowing);

  /* A tab from another window, hovering over this one's tabs: a gap opens where it would go. */
  let incoming = null; // { rects, index, gap }
  const closeGap = (g) => {
    if (!g) return;
    g.classList.remove('open');
    setTimeout(() => g.remove(), SETTLE_MS);
  };
  const tabDrop = {
    /** Can a tab from `fromPartition` drop here, with the pointer at height y (over the tabs or the toolbar)? */
    accepts(fromPartition, y) {
      if (fromPartition !== partition || win.minimized || drag || win.el.matches('.mini, .web-fullscreen')) return false;
      const s = tabStrip.getBoundingClientRect();
      const bar = $('.win-bar', win.el)?.getBoundingClientRect() || s;
      return y >= s.top - 10 && y <= Math.max(s.bottom, bar.bottom) + 6;
    },
    preview(x, w, label = '') {
      held = true;
      if (!incoming) {
        // Where the tabs are before any gap opens, so the gap moving doesn't move where it goes.
        incoming = { rects: [...tabList.querySelectorAll('[data-tab]')].map((t) => t.getBoundingClientRect()), index: -1, gap: null };
        tabStrip.classList.add('receiving');
      }
      const index = incoming.rects.filter((r) => r.left + r.width / 2 < x).length;
      if (index === incoming.index) return;
      incoming.index = index;
      closeGap(incoming.gap);
      const gap = el(`<div class="win-tab-gap" aria-hidden="true"><div class="win-tab-gap-tab">${label}</div></div>`);
      gap.style.setProperty('--w', `${Math.round(w)}px`);
      tabList.insertBefore(gap, tabList.querySelectorAll('[data-tab]')[index] || null);
      requestAnimationFrame(() => gap.classList.add('open'));
      incoming.gap = gap;
    },
    clear() {
      if (!incoming) return;
      closeGap(incoming.gap);
      incoming = null;
      tabStrip.classList.remove('receiving');
      setTimeout(() => {
        if (incoming || drag) return;
        held = false;
        if (renderLater) renderTabs();
      }, SETTLE_MS);
    },
    /** It was let go here: it becomes a tab where the gap was. */
    take(data) {
      const index = incoming?.index ?? tabs.length;
      incoming?.gap?.remove();
      incoming = null;
      tabStrip.classList.remove('receiving');
      held = false;
      acceptTab(data, index);
    },
  };

  tabStrip.addEventListener('click', (e) => {
    if (dragged) return;
    if (e.target.closest('[data-tab-new]')) return addTab('');
    const x = e.target.closest('[data-tab-close]');
    if (x) return closeTab(tabById(x.dataset.tabClose));
    const t = e.target.closest('[data-tab]');
    if (t) selectTab(tabById(t.dataset.tab));
  });
  tabStrip.addEventListener('auxclick', (e) => {
    const t = e.button === 1 && e.target.closest('[data-tab]');
    if (t) closeTab(tabById(t.dataset.tab));
  });

  const currentUrl = () => {
    try {
      return (wv && wv.getURL()) || current;
    } catch {
      return current;
    }
  };
  const pageScheme = (view, scheme) => {
    try {
      shell?.pageScheme?.(view.getWebContentsId(), scheme).catch(() => {});
    } catch {}
  };
  const wcId = () => {
    try {
      return wv.getWebContentsId();
    } catch {
      return null;
    }
  };

  /* ----- address bar ----- */
  const showAddress = (u) => {
    current = u || current;
    const secure = /^https:/i.test(current);
    const local = /^file:/i.test(current); // a page on this computer
    badge.innerHTML = !current ? icon('search', 12) : secure ? LOCK : local ? `${icon('folder', 12)}<em>File</em>` : `${icon('globe', 12)}<em>Not secure</em>`;
    addrWrap.classList.toggle('insecure', !!current && !secure && !local);
    addrWrap.title = current;
    if (document.activeElement !== addr) addr.value = current ? (local ? safeDecode(current) : current.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) : '';
  };
  addr.addEventListener('focus', () => {
    addr.value = currentUrl();
    setTimeout(() => addr.select());
  });
  addr.addEventListener('blur', () => showAddress());
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && addr.value.trim()) {
      navigate(resolveInput(addr.value));
      addr.blur();
    } else if (e.key === 'Escape') addr.blur();
  });
  attachSuggest(win, addr, (u) => {
    navigate(u);
    addr.blur();
  });

  /* ----- start page (new window) ----- */
  // How the start page's bookmarks open: in this tab, a background tab, or a new window.
  const startCtx = () => ({
    win,
    open: (u, how) => (how === 'tab' ? addTab(u, { background: true }) : how === 'window' ? openWebPage(u, partition) : navigate(u)),
  });
  const renderStart = async () => {
    wrap.classList.add('start');
    for (const c of [...wrap.children]) if (c.tagName !== 'WEBVIEW') c.remove(); // other tabs' pages stay
    wrap.insertAdjacentHTML('beforeend', burner
      ? `<div class="web-start burner-start">
          <div class="bs-fx" aria-hidden="true"><i class="bs-glow"></i></div>
          <div class="bs-hero">
            <div class="bs-flame">${flameIcon(64)}</div>
            <h2>Burner window</h2>
            <p>Browse without leaving a trace. Close it, and it all goes up in smoke.</p>
          </div>
          <form class="web-start-form">
            <input class="web-start-input" placeholder="Search ${esc(engine()[0])} or type a URL" spellcheck="false" autocomplete="off">
          </form>
          <div class="bs-cards">
            <div class="bs-card bs-burns">
              <h5>${flameIcon(14)}Burns when you close it</h5>
              <ul><li>Browsing history</li><li>Cookies and site data</li><li>Sign-ins</li><li>Cache and form entries</li></ul>
            </div>
            <div class="bs-card bs-stays">
              <h5>${icon('shield', 14)}Stays with you</h5>
              <ul><li>${icon('download', 13)}Downloads</li><li>${icon('star', 13)}Bookmarks</li></ul>
              <small>Links this window opens stay in the burner too.</small>
            </div>
          </div>
          <p class="bs-note">Sites you visit, your network, or your internet provider can still see your activity.</p>
        </div>`
      : `<div class="web-start"><form class="web-start-form">
        <input class="web-start-input" placeholder="Search ${esc(engine()[0])} or type a URL" spellcheck="false" autocomplete="off">
      </form><div class="web-start-marks"></div><div class="web-start-list"></div></div>`);
    const input = $('.web-start-input', wrap);
    $('.web-start-form', wrap).addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) navigate(resolveInput(input.value));
    });
    attachSuggest(win, input, navigate);
    setTimeout(() => input.focus(), 80);
    if (burner) return; // no bookmarks or "Recently visited" in a burner
    drawStartBookmarks($('.web-start-marks', wrap), startCtx());
    let recent = [];
    try {
      const seen = new Set();
      recent = (await shell.history.list({ limit: 60 })).filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, 8);
    } catch {}
    const list = $('.web-start-list', wrap);
    if (list && recent.length) {
      list.innerHTML = `<h5>Recently visited</h5>${recent
        .map((h) => `<button class="web-start-item" data-url="${esc(h.url)}"><img class="fav" src="${esc(favicon(h.url))}" alt="" referrerpolicy="no-referrer"><span><b>${esc(h.title || hostOf(h.url))}</b><small>${esc(hostOf(h.url))}</small></span></button>`)
        .join('')}`;
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-url]');
        if (b) navigate(b.dataset.url);
      });
    }
  };

  /* ----- overlays ----- */
  const clearOverlay = () => $('.web-error', wrap)?.remove();
  const overlay = (html) => {
    clearOverlay();
    wrap.append(el(`<div class="web-error">${html}</div>`));
  };

  /* ----- the webviews: one per tab; only the active tab drives the toolbar ----- */
  const sync = () => {
    try {
      back.disabled = !wv.canGoBack();
      fwd.disabled = !wv.canGoForward();
    } catch {}
    updateSound();
  };
  // The sound button shows while the page plays audio, and stays while it's muted so you can unmute it.
  const soundBtn = $('.tb-sound', win.tools);
  const updateSound = () => {
    const muted = !!active?.muted;
    soundBtn.hidden = !(active?.audible || muted);
    soundBtn.classList.toggle('on', muted);
    soundBtn.title = muted ? 'Unmute this page' : 'Mute this page';
    soundBtn.innerHTML = icon(muted ? 'volume-x' : 'volume', 14);
  };
  // Leafdeck's print sheet (public/js/printsheet.js).
  const printPage = () => {
    if (wv) shell.print.page(wv.getWebContentsId());
  };
  const toggleMute = () => {
    if (!wv) return;
    active.muted = !active.muted;
    try {
      wv.setAudioMuted(active.muted);
    } catch {}
    updateSound();
    renderTabs();
  };
  const changedUrl = (u) => {
    showAddress(u);
    onUrl?.(u);
    updateStar();
    updateKey();
    sync();
  };
  // (Re)create the active tab's webview: first load, after the start page, and waking from sleep.
  const createWebview = (src) => {
    sleeping = false;
    frozen = false;
    win.el.classList.remove('sleeping', 'paused');
    wrap.classList.remove('start');
    // Clear the start/sleep screen but keep other tabs' pages.
    for (const c of [...wrap.children]) if (c.tagName !== 'WEBVIEW') c.remove();
    wrap.prepend(el('<div class="web-progress"></div>'));
    createView(active, src);
  };
  const createView = (tab, src) => {
    const view = document.createElement('webview');
    // partition must be set before the webview attaches; it can't change afterwards.
    view.setAttribute('partition', partition);
    view.setAttribute('allowpopups', '');
    if (tab.restore && shell?.browsing?.prepareRestore) {
      // A tab from another window: the main process puts its history in as this page attaches, which it does once it
      // has a src, so that waits until the main process has it.
      const history = tab.restore;
      tab.restore = null;
      shell.browsing
        .prepareRestore(partition, src, history)
        .catch(() => {})
        .finally(() => view.setAttribute('src', src));
    } else view.setAttribute('src', src);
    tab.wv = view;
    tab.url = src;
    if (tab === active) wv = view;
    else view.classList.add('bg');
    wrap.append(view);
    const isActive = () => tab === active && tab.wv === view;
    renderTabs();
    // Window → Appearance: the page gets the window's light or dark as prefers-color-scheme.
    view.addEventListener('did-attach', () => win.scheme && pageScheme(view, win.scheme));

    // The address of the link under the pointer, bottom-left like Chrome (empty when nothing's hovered).
    view.addEventListener('update-target-url', (e) => {
      if (!isActive()) return;
      let status = $('.web-status', wrap);
      if (!e.url) return status?.classList.remove('on');
      if (!status) {
        status = el('<div class="web-status"></div>');
        wrap.append(status);
      }
      status.textContent = e.url.length > 300 ? e.url.slice(0, 300) + '…' : e.url;
      status.classList.add('on');
    });
    const navigated = (u) => {
      tab.url = u;
      renderTabs();
      saveTabs();
      if (isActive()) changedUrl(u);
    };
    view.addEventListener('did-navigate', (e) => navigated(e.url));
    view.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && navigated(e.url));
    view.addEventListener('page-title-updated', (e) => {
      tab.title = e.title;
      renderTabs();
      saveTabs();
      if (isActive()) onTitle?.(e.title);
    });
    let lastIcons = '';
    view.addEventListener('ipc-message', async (e) => {
      if (e.channel !== 'leafdeck:icons' || !onIcons) return;
      let pageUrl = '';
      try {
        pageUrl = view.getURL();
      } catch {}
      const icons = await siteIcons(e.args[0], pageUrl);
      const key = icons && `${icons.clip}|${icons.large}|${icons.fav}`;
      if (!icons || key === lastIcons || (!icons.clip && !icons.large && !icons.fav)) return;
      lastIcons = key;
      tab.icons = icons;
      renderTabs();
      if (isActive()) onIcons(icons);
    });
    view.addEventListener('did-start-loading', () => {
      tab.loading = true;
      if (isActive()) wrap.classList.add('loading');
    });
    view.addEventListener('did-stop-loading', () => {
      tab.loading = false;
      if (!isActive()) return;
      wrap.classList.remove('loading');
      sync();
      updateShield();
      setTimeout(updateShield, 2500); // late-loading trackers
    });
    view.addEventListener('did-start-navigation', (e) => isActive() && e.isMainFrame && !e.isSameDocument && clearOverlay());
    view.addEventListener('did-fail-load', async (e) => {
      if (!isActive() || !e.isMainFrame || e.errorCode === -3) return; // -3: aborted (redirects, downloads)
      const failed = e.validatedURL;
      let d = { kind: 'other' };
      try {
        d = await shell.browsing.diagnose(wcId(), failed, e.errorCode);
      } catch {}
      if (d.kind === 'focus') {
        overlay(`${icon('target', 28)}<b>Not during your focus session</b>
          <span>${esc(hostOf(failed))} is on your block list until the session ends.</span>
          <div class="row"><button class="btn small" data-nav="back">Go back</button><button class="btn small" data-focus-end>End focus session</button></div>`);
      } else if (d.kind === 'blocked') {
        overlay(`${icon('shield', 28)}<b>Leafdeck blocked this site</b>
          <span>${esc(hostOf(failed))} is on Cloudflare’s list of malware and phishing sites.</span>
          <div class="row"><button class="btn small" data-nav="back">Go back</button></div>`);
      } else if (d.kind === 'no-https') {
        overlay(`${icon('globe', 28)}<b>This site doesn’t support a secure connection</b>
          <span>Anything you send to ${esc(hostOf(failed))} over plain HTTP could be read or changed on the way.</span>
          <div class="row"><button class="btn small" data-nav="back">Go back</button>
          <button class="btn small danger" data-http="${esc(d.httpUrl)}">Continue to http:// (not secure)</button></div>`);
      } else if (e.errorCode <= -200 && e.errorCode > -300) {
        overlay(`${icon('shield', 28)}<b>Your connection isn’t private</b>
          <span>The certificate for ${esc(hostOf(failed))} isn’t valid (${esc(e.errorDescription)}). Someone may be impersonating the site.</span>
          <div class="row"><button class="btn small" data-nav="back">Go back</button></div>`);
      } else {
        overlay(`<b>This page couldn’t load</b><span>${esc(e.errorDescription || 'Network error')}</span>
          <div class="row"><button class="btn small" data-nav="reload">${icon('refresh', 12)} Try again</button></div>`);
      }
    });
    view.addEventListener('media-started-playing', () => {
      tab.audible = true;
      if (tab.muted) view.setAudioMuted(true); // a new page in a muted tab stays muted
      renderTabs();
      if (isActive()) updateSound();
    });
    view.addEventListener('media-paused', () => {
      tab.audible = false;
      renderTabs();
      if (isActive()) updateSound();
    });
    // Pages that stop answering (a runaway script): offer to wait or to stop the page. Reported by the main process.
    view.hung = (hung) => {
      if (!isActive()) return;
      if (!hung) return void ($('.web-error [data-nav=wait]', wrap) && clearOverlay());
      overlay(`<b>This page isn’t responding</b><span>${esc(hostOf(tab.url))} is busy or stuck. You can wait, or stop it and load it again.</span>
        <div class="row"><button class="btn small" data-nav="wait">Wait</button><button class="btn small danger" data-nav="force-reload">Stop and reload</button></div>`);
    };
    view.addEventListener('render-process-gone', () =>
      isActive() &&
      overlay(`<b>This page crashed</b><span>Something went wrong while displaying it.</span>
        <div class="row"><button class="btn small" data-nav="reload">${icon('refresh', 12)} Reload</button></div>`),
    );
    view.addEventListener('enter-html-full-screen', () => {
      if (!view.shadowRoot.querySelector('.fs-style')) view.shadowRoot.append(el(`<style class="fs-style">${FS_FRAME_CSS}</style>`));
      setSiteFullscreen(win, true).then(() => {
        // Over the video, on its screen (toasts are on the main one, under the frame). After the page's root has gone
        // full screen, which closes popovers.
        if (!win.el.classList.contains('web-fullscreen')) return;
        const hint = el('<div class="toast fs-hint" popover="manual">Press Esc to leave full screen</div>');
        win.el.append(hint);
        hint.showPopover();
        setTimeout(() => hint.remove(), 2600);
      });
      focus(win);
    });
    view.addEventListener('leave-html-full-screen', () => {
      setSiteFullscreen(win, false);
    });
    view.addEventListener('found-in-page', (e) => {
      if (!isActive()) return;
      const count = $('.find-count', wrap);
      if (count) count.textContent = e.result.matches ? `${e.result.activeMatchOrdinal}/${e.result.matches}` : 'No matches';
    });
    // Clicks inside a webview never reach the desktop's DOM, so raise the window when it takes focus.
    view.addEventListener('focus', () => {
      closeMenu();
      closeBookmarksPanel();
      focus(win);
    });
  };

  function selectTab(t) {
    if (!t || t === active) return;
    try {
      wv?.stopFindInPage('clearSelection');
    } catch {}
    $('.find-bar', wrap)?.remove();
    $('.web-status', wrap)?.classList.remove('on');
    clearOverlay();
    active = t;
    for (const x of tabs) x.wv?.classList.toggle('bg', x !== t);
    if (wrap.classList.contains('start')) {
      wrap.classList.remove('start');
      $('.web-start', wrap)?.remove();
    }
    current = t.url;
    if (sleeping) {
      // Asleep: waking loads this tab.
      renderTabs();
      return saveTabs();
    }
    if (t.wv) wv = t.wv;
    else if (t.url) createView(t, t.url);
    else wv = null; // a new tab: the start page
    changedUrl(t.url);
    onTitle?.(t.title || hostOf(t.url) || 'New tab');
    if (t.icons) onIcons?.(t.icons);
    wrap.classList.toggle('loading', !!t.loading);
    updateShield();
    renderTabs();
    saveTabs();
    if (!wv) return renderStart();
    try {
      wv.focus();
    } catch {}
  }

  /** Open a page as a tab in this window (a link the site opened on its own root domain); no address is a new tab's start page. */
  function addTab(u, { background = false } = {}) {
    const t = newTab(u);
    if (sleeping) wake();
    if (background) createView(t, u);
    else selectTab(t);
    renderTabs();
    saveTabs();
    return t;
  }

  /** A tab dragged in from another window ({ url, title, icons, muted, history }), at `index`; it's the one showing. */
  function acceptTab(data, index = tabs.length) {
    const t = { id: ++tabSeq, wv: null, url: data.url || '', title: data.title || '', icons: data.icons || null, loading: false, muted: !!data.muted, restore: data.history || null };
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, t);
    selectTab(t);
    renderTabs();
    saveTabs();
    return t;
  }

  function closeTab(t) {
    const i = tabs.indexOf(t);
    if (i < 0) return;
    if (tabs.length === 1) return closeWindow(win);
    if (t.url && !burner) closedStack.push({ url: t.url, partition });
    tabs.splice(i, 1);
    t.wv?.remove();
    if (t === active) {
      active = null;
      selectTab(tabs[Math.min(i, tabs.length - 1)]);
    }
    renderTabs();
    saveTabs();
  }

  function navigate(u) {
    if (!u) return;
    current = u;
    active.url = u;
    showAddress(u);
    onUrl?.(u);
    if (!wv) createWebview(u);
    else {
      clearOverlay();
      wv.loadURL(u).catch(() => {}); // failures are shown by did-fail-load
    }
  }

  /* ----- star & key ----- */
  const updateStar = () => starBtn.classList.toggle('on', !!(current && findBookmark(currentUrl())));
  // Shield: how many requests the ad blocker stopped on this page; dimmed when it's off or paused here.
  const shieldBtn = $('.tb-shield', win.tools);
  const updateShield = async () => {
    if (!shell?.adblock || !wv) return;
    let st;
    try {
      st = await shell.adblock.status(wcId());
    } catch {
      return;
    }
    const off = !st.enabled || st.allowed;
    shieldBtn.classList.toggle('off', off);
    const badge = $('.tb-badge', shieldBtn);
    badge.textContent = st.blocked > 99 ? '99+' : String(st.blocked);
    badge.hidden = off || !st.blocked;
    shieldBtn.title = !st.enabled ? 'Ad blocking is off (Settings → Browsing)' : st.allowed ? `Ad blocking paused on ${st.host}` : `${st.blocked} ad${st.blocked === 1 ? '' : 's'} & trackers blocked on this page`;
  };
  win.every(4000, () => !document.hidden && !win.minimized && updateShield()); // trackers keep loading after the page does
  const shieldMenu = async () => {
    const st = await shell.adblock.status(wcId());
    const r = shieldBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { header: st.enabled ? `${st.blocked} blocked on this page · ${st.total} since Leafdeck opened` : 'Ad blocking is off' },
      st.host && st.enabled && {
        label: st.allowed ? `Resume blocking on ${st.host}` : `Pause blocking on ${st.host}`,
        act: async () => {
          await shell.adblock.allow(st.host, !st.allowed);
          wv.reload();
        },
      },
      '-',
      { label: st.enabled ? 'Turn off ad blocking' : 'Turn on ad blocking', act: () => shell.browsing.set({ adblock: !st.enabled }).then(() => wv.reload()) },
      st.error && { header: st.error },
    ]);
  };
  // Show the key only when the vault has logins for this site (asked of the main process, by real page URL).
  const updateKey = async () => {
    try {
      accounts = wv ? await shell.vault.accountsFor(wcId()) : [];
    } catch {
      accounts = [];
    }
    keyBtn.hidden = !accounts.length;
    keyBtn.title = accounts.length === 1 ? `Fill login for ${accounts[0].username || accounts[0].host}` : `Fill a saved login (${accounts.length})`;
  };
  const fill = (id) => shell.vault.fill(wcId(), id).catch((err) => toast(cleanError(err), 'error'));
  win.watch(['bookmarks'], () => {
    updateStar();
    const marks = $('.web-start-marks', wrap);
    if (marks) drawStartBookmarks(marks, startCtx()); // the start page keeps up with the star and the panel
  });

  /* ----- find in page ----- */
  const openFind = () => {
    if (!wv) return;
    let bar = $('.find-bar', wrap);
    if (!bar) {
      bar = el(`<div class="find-bar"><input placeholder="Find in page" spellcheck="false"><span class="find-count"></span>
        <button class="icon-btn" data-find="prev" title="Previous (Shift+Enter)">${icon('left', 13)}</button>
        <button class="icon-btn" data-find="next" title="Next (Enter)">${icon('right', 13)}</button>
        <button class="icon-btn" data-find="close" title="Close (Esc)">${icon('x', 13)}</button></div>`);
      wrap.append(bar);
      const input = $('input', bar);
      const closeFind = () => {
        wv.stopFindInPage('clearSelection');
        bar.remove();
        wv.focus();
      };
      const step = (forward) => input.value && wv.findInPage(input.value, { forward, findNext: false });
      input.addEventListener('input', () => {
        if (input.value) wv.findInPage(input.value, { findNext: true });
        else {
          wv.stopFindInPage('clearSelection');
          $('.find-count', bar).textContent = '';
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') step(!e.shiftKey);
        if (e.key === 'Escape') closeFind();
      });
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-find]');
        if (!b) return;
        if (b.dataset.find === 'close') closeFind();
        else step(b.dataset.find === 'next');
      });
    }
    const input = $('input', bar);
    input.focus();
    input.select();
  };

  /* ----- zoom ----- */
  const showZoom = (factor) => {
    zoomPill.hidden = factor === 100;
    zoomPill.textContent = `${factor}%`;
  };
  const zoom = (step) => {
    if (!wv) return;
    const level = step === 0 ? 0 : Math.max(-5, Math.min(5, wv.getZoomLevel() + step));
    wv.setZoomLevel(level);
    showZoom(Math.round(Math.pow(1.2, level) * 100));
  };

  const bookmark = () => {
    if (!current) return;
    const existing = findBookmark(currentUrl());
    if (existing) return editRecord(win, 'bookmarks', existing);
    let title = '';
    try {
      title = wv.getTitle();
    } catch {}
    store.save('bookmarks', { title, url: currentUrl(), folder: 'Leafdeck' });
    toast('Bookmarked — press Ctrl+D again to edit');
  };

  /* ----- toolbar & overlay buttons ----- */
  win.el.addEventListener('click', async (e) => {
    const http = e.target.closest('[data-http]');
    if (http && win.el.contains(http)) {
      await shell.browsing.allowHttp(http.dataset.http);
      return navigate(http.dataset.http);
    }
    const b = e.target.closest('[data-nav]');
    if (!b || !win.el.contains(b)) return;
    const act = b.dataset.nav;
    if (act === 'shield') return shieldMenu();
    if (act === 'back') wv?.canGoBack() && wv.goBack();
    else if (act === 'forward') wv?.goForward();
    else if (act === 'reload') {
      clearOverlay();
      wv ? wv.reload() : renderStart();
    } else if (act === 'zoom-reset') zoom(0);
    else if (act === 'sound') toggleMute();
    else if (act === 'wait') clearOverlay();
    else if (act === 'force-reload') {
      clearOverlay();
      shell.browsing.stopPage(wcId()).catch(() => wv?.reload());
    } else if (act === 'star') bookmark();
    else if (act === 'bookmarks') {
      toggleBookmarksPanel(b, {
        win,
        page: () => ({ url: current ? currentUrl() : '', title: active?.title || '' }),
        open: (u, how) => (how === 'tab' ? addTab(u, { background: true }) : how === 'window' ? openWebPage(u, partition) : navigate(u)),
      });
    }
    else if (act === 'key') {
      const r = b.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { header: accounts[0]?.host || 'Saved logins' },
        ...accounts.map((a) => ({ label: a.username || a.name || '(no username)', act: () => fill(a.id) })),
        '-',
        { label: 'Open Passwords', act: () => openApp('passwords') },
      ]);
    } else if (act === 'wake') wake();
    else if (act === 'menu') {
      const r = b.getBoundingClientRect();
      const host = hostOf(currentUrl());
      const awake = current ? (await shell.browsing.settings()).keepAwake.includes(host) : false;
      showMenu(r.right - 220, r.bottom + 4, [
        { label: 'New Tab', key: 'Ctrl+T', act: () => addTab('') },
        { label: 'Find in Page…', key: 'Ctrl+F', act: openFind, disabled: !wv },
        { label: 'Print…', key: 'Ctrl+P', act: printPage, disabled: !wv },
        { label: active?.muted ? 'Unmute This Page' : 'Mute This Page', act: toggleMute, disabled: !wv },
        '-',
        { label: 'Zoom In', key: 'Ctrl+=', act: () => zoom(0.5), disabled: !wv },
        { label: 'Zoom Out', key: 'Ctrl+−', act: () => zoom(-0.5), disabled: !wv },
        { label: 'Actual Size', key: 'Ctrl+0', act: () => zoom(0), disabled: !wv },
        '-',
        { label: 'Copy Page Address', act: () => navigator.clipboard.writeText(currentUrl()).then(() => toast('Address copied')), disabled: !current },
        { label: 'Open in Your Default Browser', act: () => shell.openExternal(currentUrl()), disabled: !current },
        '-',
        { label: `Keep ${host || 'This Site'} Awake`, checked: awake, disabled: !current, act: () => shell.perf.keepAwake(host, !awake).then(() => toast(awake ? `${host} can sleep again` : `${host} won’t be paused or put to sleep`)) },
        { label: 'Sleep Now', act: sleep, disabled: !wv },
        { label: 'Task Manager', key: 'Shift+Esc', act: () => openApp('taskmanager') },
        '-',
        { label: 'New Window', key: 'Ctrl+N', act: () => openWebPage('') },
        { label: 'New Burner Window', key: 'Ctrl+Shift+N', act: () => openBurnerWindow('') },
        '-',
        { label: 'Downloads', key: 'Ctrl+J', act: () => openApp('downloads') },
        { label: 'History', key: 'Ctrl+H', act: () => openApp('history') },
        { label: 'Bookmarks', act: () => openApp('bookmarks') },
        { label: 'Passwords', act: () => openApp('passwords') },
      ]);
    }
  });

  /* ----- memory saver: sleep unloads the page; wake reloads it at the same address ----- */
  let sleeping = false;
  let frozen = false;
  const sleep = () => {
    if (!wv || sleeping) return;
    current = currentUrl();
    sleeping = true;
    frozen = false;
    wv = null; // removing the <webview>s below destroys their renderer processes and frees their memory
    for (const t of tabs) t.wv = null; // each tab reloads when it's next shown
    win.el.classList.add('sleeping');
    back.disabled = fwd.disabled = true;
    keyBtn.hidden = true;
    wrap.classList.remove('loading');
    wrap.innerHTML = `<div class="web-sleep"><img class="fav" src="${esc(favicon(current))}" alt="" referrerpolicy="no-referrer">
      <b>${esc($('.win-title-text', win.el)?.textContent || hostOf(current))}</b>
      <span>Sleeping to save memory</span><button class="btn small" data-nav="wake">Wake</button></div>`;
  };
  const wake = () => {
    if (sleeping) createWebview(current);
  };

  // Recently closed, for Ctrl+Shift+T.
  win.cleanups.push(() => {
    if (current && !burner && !win.moving && !handedOff) closedStack.push({ url: currentUrl(), partition });
    if (closedStack.length > 25) closedStack.shift();
    if (win.el.classList.contains('web-fullscreen')) setSiteFullscreen(win, false);
  });

  win.web = {
    get webview() {
      return wv;
    },
    navigate,
    find: openFind,
    focusAddress: () => addr.focus(),
    zoom,
    showZoom,
    bookmark,
    print: printPage,
    addTab,
    partition,
    tabDrop,
    /** Ctrl+W: close the front tab when there are several (true), else leave it to the window (false). */
    newTab: () => addTab(''),
    closeActiveTab: () => (tabs.length > 1 ? (closeTab(active), true) : false),
    get tabCount() {
      return tabs.length;
    },
    /** Ctrl+Tab / Ctrl+Shift+Tab: the next / previous tab, wrapping around. */
    cycleTab: (dir) => selectTab(tabs[(tabs.indexOf(active) + dir + tabs.length) % tabs.length]),
    reload: (hard) => (hard ? wv?.reloadIgnoringCache() : wv?.reload()),
    back: () => wv?.canGoBack() && wv.goBack(),
    forward: () => wv?.canGoForward() && wv.goForward(),
    toggleMute,
    sleep,
    wake,
    get sleeping() {
      return sleeping;
    },
    get frozen() {
      return frozen;
    },
    set frozen(v) {
      frozen = v;
      win.el.classList.toggle('paused', v);
    },
    wcId,
    url: currentUrl,
    setScheme: (scheme) => tabs.forEach((t) => t.wv && pageScheme(t.wv, scheme)),
  };
  lastActive.set(win.id, Date.now());

  renderTabs();
  showAddress(url);
  // Restoring after a restart: only the front window loads now; the rest wake when you open them.
  if (url && restoring) {
    current = url;
    wv = {}; // placeholder so sleep() runs; replaced immediately
    sleep();
  } else if (url) createWebview(url);
  else renderStart();
  return win.web;
}

/* ---------------- Ad-hoc pages (new windows, links opened in a new window, searches…) ---------------- */

const LS_PAGES = 'ws:pages';
const pages = new Map(
  (() => {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(LS_PAGES)) || {});
    } catch {
      return [];
    }
  })(),
);
/* With one surface per screen (screens.js) each screen's page has its own copy of this map, so a page writes only the
   windows it has (and the ones it closed) into what's stored, and reads one that arrives from another screen afresh. */
const storedPages = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_PAGES)) || {};
  } catch {
    return {};
  }
};
const dropped = new Set(); // closed here since the last write
const writePages = () => {
  try {
    const all = storedPages();
    for (const id of dropped) delete all[id];
    dropped.clear();
    for (const [id, p] of pages) if (!isBurnerPartition(p.partition) && (wins.has(id) || !all[id])) all[id] = p;
    localStorage.setItem(LS_PAGES, JSON.stringify(all));
  } catch {}
};
const savePages = debounce(writePages, 300);
let seq = 0;

const handoffs = new Map(); // window id -> a tab dragged out of another window, for its first tab (see mountWeb)

/** A browser window on `url`; `handoff` is a tab dragged out of another window ({ title, icons, muted, history }). */
export function openWebPage(url = '', partition = SHARED_PARTITION, handoff = null) {
  const id = `web:${Date.now().toString(36)}${++seq}`;
  pages.set(id, { url, partition, title: handoff?.title || '' });
  if (handoff) handoffs.set(id, handoff);
  savePages();
  return openApp(id);
}

export const openBurnerWindow = (url = '') => openWebPage(url, newBurnerPartition());

/** Forget saved pages that weren't reopened (call after session restore). */
export function prunePages() {
  // Windows another screen's page keeps (one surface per screen) aren't this page's to forget.
  const kept = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith('ws:windows@')) continue;
    try {
      for (const id of JSON.parse(localStorage.getItem(k))?.open || []) kept.add(id);
    } catch {}
  }
  for (const id of pages.keys())
    if (!wins.has(id) && !kept.has(id)) {
      pages.delete(id);
      dropped.add(id);
    }
  savePages();
}

const pageName = (p) => {
  const base = p.title || (p.url ? hostOf(p.url) : isBurnerPartition(p.partition) ? 'Burner Window' : 'New Window');
  return p.session ? `${base} · ${p.session}` : base;
};

/**
 * A window on a specific saved session (its own logins), labeled e.g. "Session 2".
 * If that session already has a window open, bring it forward instead of opening a duplicate.
 */
export function openSessionWindow(url, partition, label) {
  for (const [id, p] of pages) if (p.partition === partition && wins.has(id)) return openApp(id);
  const id = `web:${Date.now().toString(36)}${++seq}`;
  pages.set(id, { url, partition, title: '', session: label });
  savePages();
  return openApp(id);
}

addResolver((id) => {
  if (!id.startsWith('web:')) return null;
  // Not open here: what's stored is newest (another screen's page may have had it until now).
  if (!wins.has(id)) {
    const stored = storedPages()[id];
    if (stored) pages.set(id, stored);
  }
  const p = pages.get(id);
  if (!p) return null;
  return {
    id,
    name: pageName(p),
    icon: 'globe',
    // The site's webclip (big, full-bleed) for the Dock; its favicon for the small title-bar icon.
    // A burner always shows its flame, so you can tell it apart at a glance.
    logo: isBurnerPartition(p.partition) ? '' : p.clip || p.large || p.fav || '',
    logoFull: !isBurnerPartition(p.partition) && !!p.clip,
    smallLogo: isBurnerPartition(p.partition) ? '' : p.fav || '',
    ...(isBurnerPartition(p.partition) ? { icon: 'flame', burner: true } : {}),
    color: 'gray',
    size: 'browser', // 16:11, or the last size you gave a browser window
    sizeKey: 'browser',
    mount(win) {
      win.setTitle(pageName(p));
      const handoff = handoffs.get(id);
      handoffs.delete(id);
      mountWeb(win, {
        url: p.url,
        partition: p.partition,
        handoff,
        tabs: p.tabs,
        activeTab: p.activeTab,
        onTabs: (list, i) => {
          p.tabs = list.length > 1 ? list : undefined;
          p.activeTab = list.length > 1 ? i : undefined;
          savePages();
        },
        onTitle: (t) => {
          p.title = t;
          savePages();
          win.setTitle(pageName(p));
          setBadge(id, badgeFromTitle(t));
          const tip = document.querySelector(`#dock [data-app="${CSS.escape(id)}"] .dock-tip`);
          if (tip) tip.textContent = pageName(p);
        },
        onUrl: (u) => {
          // A different site: its icons no longer apply.
          if (p.url && hostOf(p.url) !== hostOf(u)) {
            p.clip = p.large = p.fav = '';
            refreshAppIcon(id);
          }
          p.url = u;
          savePages();
        },
        onIcons: ({ clip, large, fav }) => {
          p.clip = clip;
          p.large = large;
          p.fav = fav;
          savePages();
          refreshAppIcon(id);
        },
      });
    },
    unmount: (w) => {
      if (w?.moving) return writePages(); // to another screen: its page there opens it again, from this
      pages.delete(id);
      dropped.add(id);
      savePages();
      // Last window on this burner session closed: burn it.
      if (isBurnerPartition(p.partition) && ![...pages.values()].some((x) => x.partition === p.partition)) {
        shell?.burner?.burn(p.partition).catch(() => {});
      }
    },
  };
});

/* ---------------- Shortcuts, prompts and events from the shell ---------------- */

/** A site in or out of full screen. Outside Leafdeck OS the whole app window fills the monitor while any site is. */
function setSiteFullscreen(win, on) {
  win.el.classList.toggle('web-fullscreen', on);
  syncFullscreen();
  shell.windowAction($('.win.web-fullscreen') ? 'enter-fullscreen' : 'leave-fullscreen');
  return on ? fitSiteFullscreen(win) : Promise.resolve();
}
/* Chromium puts the <webview>'s frame in the page's top layer at the size of the whole page, with !important rules no
   style here can outweigh (position, size, padding, transform). On several screens that's all of them. So the frame is
   moved with `translate` (not among those rules) and clipped to its screen, which also keeps clicks on the other screens
   from landing on it; the page inside is told the screen's size by the main process (fitSiteFullscreen). */
const FS_FRAME_CSS = `iframe:fullscreen {
  translate: var(--fs-x, 0) var(--fs-y, 0);
  clip-path: inset(0 calc(100vw - var(--fs-w, 100vw)) calc(100vh - var(--fs-h, 100vh)) 0);
  pointer-events: auto;
}
iframe::backdrop { display: none; }`;
async function fitSiteFullscreen(win) {
  const style = win.el.style;
  try {
    await shell.fitSiteFullscreen(win.web.webview.getWebContentsId(), style.getPropertyValue('--fs-w') ? { width: parseInt(style.getPropertyValue('--fs-w')), height: parseInt(style.getPropertyValue('--fs-h')) } : null);
  } catch {}
}
addEventListener('screens', () => {
  for (const w of wins.values()) if (w.el.classList.contains('web-fullscreen')) fitSiteFullscreen(w);
});
function exitSiteFullscreen(w) {
  try {
    shell.leaveSiteFullscreen(w.web.webview.getWebContentsId());
  } catch {}
  // A page that's gone can't answer.
  setTimeout(() => w.el.classList.contains('web-fullscreen') && setSiteFullscreen(w, false), 600);
}
/* The frame covers everything on its screen, so a window that comes forward there would be out of sight: full screen ends
   instead. Windows on other screens don't touch it. */
onWM(() => {
  const front = activeWindow();
  if (!front) return;
  for (const w of wins.values()) {
    if (w !== front && w.el.classList.contains('web-fullscreen') && screenOf(w.rect) === screenOf(front.rect)) exitSiteFullscreen(w);
  }
});
/* Esc with the keyboard on Leafdeck's UI rather than in the page (electron/main.cjs has the page's own Esc): it leaves
   full screen when the window that's full screen is the active one. In any other window Esc is that window's: other
   screens are in use while a video plays on this one. */
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const w = activeWindow();
  if (!w?.el.classList.contains('web-fullscreen') || $('.menu, .sheet-wrap')) return;
  const focused = document.activeElement;
  if (focused && focused !== document.body && !w.el.contains(focused)) return;
  exitSiteFullscreen(w);
}, true);

export const webviewFor = (webContentsId) =>
  $$('webview').find((wv) => {
    try {
      return wv.getWebContentsId() === webContentsId;
    } catch {
      return false;
    }
  });

export const windowForWebContents = (webContentsId) => {
  const id = webviewFor(webContentsId)?.closest('.win')?.dataset.app;
  return id ? wins.get(id) : null;
};

/** Which session a webview (by its WebContents id) belongs to, so its links open in the same login. */
const partitionOf = (webContentsId) => webviewFor(webContentsId)?.getAttribute('partition') || SHARED_PARTITION;

function cycleWindows(dir) {
  const list = [...wins.values()];
  if (!list.length) return;
  const i = list.indexOf(activeWindow());
  openApp(list[(i + dir + list.length) % list.length].id);
}

export function runShortcut(name, webContentsId) {
  const target = (webContentsId && windowForWebContents(webContentsId)) || activeWindow();
  const web = target?.web;
  switch (name) {
    case 'search':
      return focusSearch();
    case 'new-tab':
      return web ? web.newTab() : openWebPage('');
    case 'new-window':
      return openWebPage('');
    case 'burner':
      return openBurnerWindow('');
    case 'close-window':
      return target && (target.web?.closeActiveTab?.() || closeWindow(target));
    case 'reopen':
      return reopenClosed();
    case 'next-window':
      return target?.web?.tabCount > 1 ? target.web.cycleTab(1) : cycleWindows(1);
    case 'prev-window':
      return target?.web?.tabCount > 1 ? target.web.cycleTab(-1) : cycleWindows(-1);
    case 'address':
      if (web) return web.focusAddress();
      // No site in front: the menu bar's search doubles as the address bar.
      return focusSearch();
    case 'downloads':
      return openApp('downloads');
    case 'history':
      return openApp('history');
    case 'overview':
      return toggleOverview();
    case 'apps': // the Windows key on its own (Leafdeck OS)
      return import('../appscreen.js').then((m) => m.toggleAppScreen());
    case 'leave-site-fullscreen':
      // The site didn't leave full screen when asked (electron/main.cjs): give the screen back to Leafdeck regardless.
      if (target?.el.classList.contains('web-fullscreen')) setSiteFullscreen(target, false);
      return;
    case 'snap-left':
    case 'snap-right':
      return target && snapTo(target, name.slice(5));
    case 'snap-up':
      return target && (target.mini ? toggleMini(target, false) : target.max ? null : toggleMax(target));
    case 'snap-down':
      return target && (target.max ? toggleMax(target) : toggleMini(target));
    case 'focus':
      return openFocusSetup();
    case 'task-manager':
      return openApp('taskmanager');
    case 'back':
      return web?.back();
    case 'forward':
      return web?.forward();
    case 'find':
      return web?.find();
    case 'bookmark':
      return web?.bookmark();
    case 'print':
      if (web) return web.print();
      return target?.print?.can() ? target.print.run() : undefined; // an app that prints a file (Files, Image Viewer…)
    case 'zoom-in':
      return web?.zoom(0.5);
    case 'zoom-out':
      return web?.zoom(-0.5);
    case 'zoom-reset':
      return web?.zoom(0);
    // With a site in front, reload the site; otherwise reload Leafdeck itself (e.g. to pick up server changes).
    case 'reload':
      return web ? web.reload(false) : location.reload();
    case 'hard-reload':
      return web ? web.reload(true) : location.reload();
    case 'back':
      return web?.back();
    case 'forward':
      return web?.forward();
  }
}

const PERMISSION_TEXT = {
  notifications: 'show notifications',
  geolocation: 'know your location',
  'clipboard-read': 'see what you copy',
  midi: 'use MIDI devices',
  midiSysex: 'fully control MIDI devices',
};
function permissionText(req) {
  if (req.permission !== 'media') return PERMISSION_TEXT[req.permission] || `use “${req.permission}”`;
  const a = req.mediaTypes.includes('audio');
  const v = req.mediaTypes.includes('video');
  return a && v ? 'use your camera and microphone' : v ? 'use your camera' : a ? 'use your microphone' : 'use your camera or microphone';
}

/** A prompt bar inside the window showing a site. */
function promptBar(webContentsId, html, onClick) {
  const wv = webviewFor(webContentsId);
  if (!wv) return false;
  const bar = el(`<div class="perm-bar">${html}</div>`);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-answer]');
    if (b && onClick(b.dataset.answer, bar) !== false) bar.remove();
  });
  wv.closest('.embed').append(bar);
  const w = wv.closest('.win');
  if (w) w.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // raise the window asking
  return true;
}

if (shell) {
  // Links a site opens in a new window: a tab in the same window when it's on the site's own root domain
  // (mail.google.com → docs.google.com), a new window otherwise. "Open Link in New Tab/Window" forces one.
  shell.on('shell:open-url', ({ url, webContentsId, mode, background }) => {
    if (!/^https?:\/\//i.test(url)) return;
    const from = webContentsId ? windowForWebContents(webContentsId) : null;
    if (from?.web?.addTab && mode !== 'window') {
      let opener = '';
      try {
        opener = webviewFor(webContentsId).getURL();
      } catch {}
      const root = rootDomain(url);
      if (mode === 'tab' || (root && root === rootDomain(opener))) {
        from.web.addTab(url, { background: !!background });
        if (!background) focus(from);
        return;
      }
    }
    openWebPage(url, webContentsId ? partitionOf(webContentsId) : SHARED_PARTITION);
  });
  shell.on('shell:search', ({ text }) => openWebPage(searchUrl(text)));
  shell.on('shell:shortcut', ({ name, webContentsId }) => runShortcut(name, webContentsId));
  shell.on('shell:page-hung', ({ webContentsId, hung }) => webviewFor(webContentsId)?.hung?.(hung));
  shell.on('shell:zoom', ({ webContentsId, factor }) => windowForWebContents(webContentsId)?.web?.showZoom(factor));

  // A site asked for a permission: ask in that site's window. Decisions can be remembered per site.
  shell.on('shell:permission', (req) => {
    const shown = promptBar(
      req.webContentsId,
      `${icon('shield', 15)}<span><b>${esc(hostOf(req.origin))}</b> wants to ${esc(permissionText(req))}</span>
        <label class="perm-remember"><input type="checkbox" checked> Remember for this site</label>
        <button class="btn small" data-answer="deny">Block</button>
        <button class="btn small primary" data-answer="allow">Allow</button>`,
      (answer, bar) => shell.permissions.respond(req.id, answer === 'allow', $('input', bar).checked),
    );
    if (!shown) shell.permissions.respond(req.id, false, false);
  });

  // You just signed in somewhere: offer to save (the password never leaves the main process).
  shell.on('shell:save-login', (req) => {
    promptBar(
      req.webContentsId,
      `${icon('key', 15)}<span>${req.update ? 'Update' : 'Save'} password${req.username ? ` for <b>${esc(req.username)}</b>` : ''} on <b>${esc(req.host)}</b>?</span>
        <button class="btn small" data-answer="never">Never for this site</button>
        <button class="btn small" data-answer="dismiss">Not now</button>
        <button class="btn small primary" data-answer="save">${req.update ? 'Update' : 'Save'}</button>`,
      (answer) => {
        shell.vault.resolvePending(req.id, answer).then(() => answer === 'save' && toast('Password saved'));
      },
    );
  });

  // You filled in an address or card on a site: offer to keep it for autofill.
  shell.on('shell:save-autofill', (req) => {
    const what = req.kind === 'card' ? 'card' : 'address';
    promptBar(
      req.webContentsId,
      `${icon(req.kind === 'card' ? 'card' : 'place', 15)}<span>Save ${what} <b>${esc(req.summary)}</b> for autofill?${
        req.kind === 'card' ? ' <small>(encrypted on this computer; the security code isn’t saved)</small>' : ''
      }</span>
        <button class="btn small" data-answer="dismiss">Not now</button>
        <button class="btn small primary" data-answer="save">Save</button>`,
      (answer) => {
        shell.autofill.resolvePending(req.id, answer).then(() => answer === 'save' && toast(req.kind === 'card' ? 'Card saved' : 'Address saved'));
      },
    );
  });

  // "Manage passwords…" (or addresses / payment methods) from a page's autofill menu.
  shell.on('shell:open-autofill', ({ kind }) => openApp('passwords', { tab: kind }));

  shell.on('shell:fill-result', ({ filled }) => {
    if (!filled) toast('No login form found on this page');
  });

  shell.on('shell:update', (u) => {
    toast(`Security update: Electron ${u.latest} is out (Leafdeck uses ${u.current}). Rebuild Leafdeck to update.`);
  });
}
