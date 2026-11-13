import { store } from './store.js';
import { $, $$, esc } from './util.js';
import { icon, appIcon } from './icons.js';
import { registry, getApp, openApp, toast, recentWindows, wins, activeWindow, screens } from './wm.js';
import { schemas, COLLECTIONS, recordMatches } from './schemas.js';
import { linkAppId } from './apps/system.js';
import { openBookmark, favicon } from './apps/bookmarks.js';
import { toUrl, searchUrl, engine, openWebPage, openBurnerWindow, hostOf, searchQueryOf } from './apps/browser.js';
import { shell } from './shell.js';

const openPage = (url) => (shell ? openWebPage(url) : window.open(url, '_blank', 'noopener'));
let historyHits = { q: '', rows: [] }; // async results for the current query (desktop app only)

const CREATE = [
  ['tasks', 'Task', 'title'],
  ['notes', 'Note', 'title'],
  ['contacts', 'Contact', 'name'],
  ['events', 'Event', 'title'],
];

function openRecord(col, id) {
  if (col === 'links') return openApp(linkAppId({ id }));
  if (col === 'bookmarks') return openBookmark(store.get('bookmarks', id));
  openApp(schemas[col].app, { record: id });
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
};

/** A window you've used recently: brings it forward if it's open, reopens it if not. */
const recentItem = (r) => {
  const app = getApp(r.id);
  const liveTitle = r.open ? wins.get(r.id)?.el.querySelector('.win-title-text')?.textContent : '';
  const site = r.url ? hostOf(r.url) : '';
  return {
    icon: r.open && app ? appIcon(app) : r.url ? `<img class="fav sr-fav" src="${esc(favicon(r.url))}" alt="" referrerpolicy="no-referrer">` : appIcon(app || { icon: 'grid', color: 'gray' }),
    title: liveTitle || r.title || site || app?.name || 'Window',
    sub: [site || (app?.isLink ? 'Connection' : 'App'), r.open ? 'Open' : ago(r.at)].join(' · '),
    run: () => (r.open || (!r.url && app) ? openApp(r.id) : openPage(r.url)),
  };
};

/** History rows → past searches (as searches) and pages, each matching every word typed. */
function historyItems(q, rows) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const searches = [];
  const pages = [];
  for (const h of rows) {
    const sq = searchQueryOf(h.url);
    if (sq) {
      if (words.every((w) => sq.toLowerCase().includes(w)) && !searches.some((s) => s.toLowerCase() === sq.toLowerCase())) searches.push(sq);
    } else pages.push(h);
  }
  return [
    ...searches.slice(0, 4).map((sq) => ({ icon: `<span class="sr-glyph">${icon('search', 14)}</span>`, title: sq, sub: `Searched before · ${engine()[0]}`, run: () => openPage(searchUrl(sq)) })),
    ...pages.slice(0, 5).map((h) => ({ icon: `<img class="fav sr-fav" src="${esc(favicon(h.url))}" alt="" referrerpolicy="no-referrer">`, title: h.title || hostOf(h.url), sub: h.url, run: () => openPage(h.url) })),
  ];
}

const recordItem = (col, r) => ({
  icon: appIcon(getApp(col === 'links' ? linkAppId(r) : schemas[col].app) || { icon: 'globe', color: 'gray' }),
  title: schemas[col].title(r),
  sub: schemas[col].sub?.(r) || schemas[col].label,
  run: () => openRecord(col, r.id),
});

function calc(q) {
  if (!/^[\d\s+\-*/().%]+$/.test(q) || !/\d\s*[+\-*/%]\s*[\d(]/.test(q)) return null;
  try {
    const v = Function(`"use strict";return (${q})`)();
    return Number.isFinite(v) ? Math.round(v * 1e8) / 1e8 : null;
  } catch {
    return null;
  }
}

const appKind = (a) => (a.isLink ? 'Connection' : 'Application');

function build(q) {
  const groups = [];
  const apps = [...registry.values()].filter((a) => !a.hidden);
  const links = store.all('links').map((l) => getApp(linkAppId(l))).filter(Boolean);
  if (!q) {
    // The windows you've had open, newest first (open ones come forward, closed ones reopen).
    const recent = recentWindows().slice(0, 7);
    if (recent.length) groups.push(['Recent', recent.map(recentItem)]);
    groups.push([
      'Quick actions',
      CREATE.map(([col, label]) => ({
        icon: `<span class="sr-glyph">${icon('plus', 14)}</span>`,
        title: `New ${label}`,
        sub: schemas[col].plural,
        run: () => openApp(schemas[col].app, { create: {} }),
      })),
    ]);
    return groups;
  }

  // Like a browser's address bar, the first result is what Enter does: an address you typed, a site
  // you've been to that starts with what you typed, an app with that name, or else a web search.
  const ql = q.toLowerCase();
  const url = toUrl(q);
  const site = url ? null : visitedSite(ql);
  const app = url || site ? null : [...apps, ...links].find((a) => a.name.toLowerCase().startsWith(ql));
  const webSearch = { icon: `<span class="sr-glyph">${icon('search', 14)}</span>`, title: `Search ${engine()[0]} for “${q}”`, sub: shell ? 'Opens in a Leafdeck window' : 'Opens a new tab', run: () => openPage(searchUrl(q)) };
  if (url) groups.push(['Go to', [{ icon: `<span class="sr-glyph">${icon('globe', 14)}</span>`, title: url, sub: 'Open this address', run: () => openPage(url) }]]);
  else if (site) groups.push(['Go to', [{ icon: `<img class="fav sr-fav" src="${esc(favicon(site))}" alt="" referrerpolicy="no-referrer">`, title: hostOf(site), sub: site, run: () => openPage(site) }]]);
  else if (app) groups.push(['Open', [{ icon: appIcon(app), title: app.name, sub: appKind(app), run: () => openApp(app.id) }]]);
  else groups.push(['Web', [webSearch]]);
  const v = calc(q);
  if (v != null)
    groups.push(['Calculator', [{ icon: `<span class="sr-glyph">=</span>`, title: String(v), sub: 'Copy result', run: () => navigator.clipboard?.writeText(String(v)).then(() => toast('Copied ' + v)) }]]);

  // Your past searches and pages matching what you typed come right after the top result.
  if (historyHits.q === q) {
    const hist = historyItems(q, historyHits.rows);
    if (hist.length) groups.push(['History', hist]);
  }

  const appHits = [...apps, ...links].filter((a) => a !== app && a.name.toLowerCase().includes(ql)).slice(0, 5);
  if (appHits.length)
    groups.push(['Applications', appHits.map((a) => ({ icon: appIcon(a), title: a.name, sub: appKind(a), run: () => openApp(a.id) }))]);

  for (const col of COLLECTIONS) {
    const hits = store.all(col).filter((r) => recordMatches(col, r, q));
    if (hits.length) groups.push([schemas[col].plural, hits.slice(0, 4).map((r) => recordItem(col, r))]);
  }

  groups.push([
    'Create',
    CREATE.map(([col, label, field]) => ({
      icon: `<span class="sr-glyph">${icon('plus', 14)}</span>`,
      title: `New ${label.toLowerCase()} “${q}”`,
      sub: schemas[col].plural,
      run: () => openApp(schemas[col].app, { create: { [field]: q } }),
    })),
  ]);
  if (url || site || app) groups.push(['Web', [webSearch]]);
  return groups;
}

/** A site you've visited or saved whose address starts with what you typed (e.g. "git" → github.com). */
function visitedSite(ql) {
  if (ql.length < 2 || /[\s/]/.test(ql)) return null;
  const urls = [
    ...(historyHits.q.toLowerCase() === ql ? historyHits.rows.map((h) => h.url) : []),
    ...store.all('links').map((l) => l.url),
    ...store.all('bookmarks').map((b) => b.url),
  ];
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u || '')) continue;
    const host = hostOf(u);
    if (host.toLowerCase().startsWith(ql)) return new URL(u).origin + '/';
  }
  return null;
}

/** The search in the menu bar of the screen you're working on (the active window's), else the main one's (#search).
 * Other screens' menu bars have one too (menubar.js, .mb-search). */
function currentSearch() {
  const r = activeWindow()?.rect;
  const x = r ? r.x + r.w / 2 : 0;
  const y = r ? r.y + Math.min(r.h / 2, 40) : 0;
  const n = r ? screens().findIndex((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) : 0;
  return $(`.menubar-extra[data-screen="${n}"] .mb-search input`) || $('#search input');
}

export function focusSearch() {
  const input = currentSearch();
  input?.focus();
  input?.select();
}

export function initSearch() {
  addSearch($('#search'));
  addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
      e.preventDefault();
      focusSearch();
    }
  });
}

/** Make `root` a search box: the main menu bar's (#search), or another screen's (menubar.js). */
export function addSearch(root) {
  root.innerHTML = `<div class="search-results" hidden></div>
    <label class="search-bar">${icon('search', 15)}
      <input type="text" placeholder="Search or type a web address" autocomplete="off" spellcheck="false" aria-label="Search or type a web address">
      ${shell ? `<button type="button" class="search-burner" title="New Burner Window (Ctrl+Shift+N)" aria-label="New Burner Window">${icon('flame-plus', 17, 1.7)}</button>` : '<kbd>Ctrl K</kbd>'}</label>`;
  const input = $('input', root);
  const panel = $('.search-results', root);
  $('.search-burner', root)?.addEventListener('click', (e) => {
    e.preventDefault(); // it sits inside the search's <label>: don't focus the input
    e.stopPropagation();
    input.blur();
    openBurnerWindow('');
  });
  let items = [];
  let sel = 0;

  const draw = () => {
    const q = input.value.trim();
    if (q && historyHits.q !== q && (shell || store.mode === 'cloud')) {
      (shell ? shell.history.search(q, 12) : store.api(`/history/search?q=${encodeURIComponent(q)}&limit=12`)).then((rows) => {
        historyHits = { q, rows };
        if (input.value.trim() === q && !panel.hidden) draw();
      }).catch(() => {});
    }
    const groups = build(q);
    items = groups.flatMap((g) => g[1]);
    sel = Math.min(sel, items.length - 1);
    let i = 0;
    panel.innerHTML = groups
      .map(
        ([title, list]) => `<div class="sr-group"><h5>${esc(title)}</h5>${list
          .map((it) => `<button class="sr-item ${i === sel ? 'on' : ''}" data-i="${i++}">
            <span class="sr-icon">${it.icon}</span><span class="sr-text"><b>${esc(it.title)}</b><small>${esc(it.sub || '')}</small></span></button>`)
          .join('')}</div>`,
      )
      .join('');
    panel.hidden = false;
    root.classList.add('open');
  };

  const highlight = () => {
    $$('.sr-item', panel).forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === sel));
    $('.sr-item.on', panel)?.scrollIntoView({ block: 'nearest' });
  };

  const close = () => {
    panel.hidden = true;
    root.classList.remove('open');
  };

  const run = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    input.value = '';
    input.blur();
    it.run();
  };

  input.addEventListener('focus', () => {
    sel = 0;
    draw();
  });
  input.addEventListener('input', () => {
    sel = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') sel = Math.min(items.length - 1, sel + 1);
    else if (e.key === 'ArrowUp') sel = Math.max(0, sel - 1);
    else if (e.key === 'Enter') return run(sel);
    else if (e.key === 'Escape') {
      close();
      input.blur();
      return;
    } else return;
    e.preventDefault();
    highlight();
  });
  panel.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) run(Number(b.dataset.i));
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}
