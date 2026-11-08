// The new tab page's bookmarks: all of them, as tiles grouped by folder. The front shows every folder with a few of its
// bookmarks; open a folder to see all of it. The folder you're in is kept for the next new tab (in this run). Wrapper
// folders with nothing in them but one folder (an import's "Imported/Bookmarks bar") are skipped over.

import { $, esc, debounce } from '../util.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { showMenu, toast, openApp } from '../wm.js';
import { editRecord, recordMatches, hostLabel } from '../schemas.js';
import { confirmDialog } from '../dialogs.js';
import { favicon, openImport } from './bookmarks.js';

const ROOT = '';
const PER_SECTION = 12; // bookmarks shown per folder on the front; the folder itself shows them all
const MAX_TILES = 400;
const view = { folder: ROOT };

const folderOf = (b) => (b.folder || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
const nameOf = (path) => path.split('/').pop();
const inFolder = (b, f) => {
  const p = folderOf(b);
  return p === f || p.startsWith(f + '/');
};
const byTitle = (a, b) => (a.title || hostLabel(a.url)).localeCompare(b.title || hostLabel(b.url), undefined, { sensitivity: 'base' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The folders: how many bookmarks each holds (with its subfolders), which are directly in it, and its subfolders. */
function folderTree(all) {
  const counts = new Map();
  const own = new Map([[ROOT, []]]);
  const kids = new Map([[ROOT, new Set()]]);
  for (const b of all) {
    const f = folderOf(b);
    if (!own.has(f)) own.set(f, []);
    own.get(f).push(b);
    const parts = f.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      counts.set(p, (counts.get(p) || 0) + 1);
      const parent = parts.slice(0, i - 1).join('/');
      if (!kids.has(parent)) kids.set(parent, new Set());
      kids.get(parent).add(p);
    }
  }
  const sorted = (p) => [...(kids.get(p) || [])].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }));
  const inside = (p) => (own.get(p) || []).slice().sort(byTitle);
  const isWrapper = (p) => p !== ROOT && !inside(p).length && sorted(p).length === 1;
  // Past the wrappers: "Imported" with only "Bookmarks bar" in it stands for "Imported/Bookmarks bar".
  const through = (p) => {
    while (isWrapper(p)) p = sorted(p)[0];
    return p;
  };
  return { counts, sorted, inside, isWrapper, through };
}

// Under the title, the site; a bookmark with no title is named after its site, so its path goes under it instead.
const pathOf = (u) => {
  try {
    const { pathname, search } = new URL(u);
    return pathname === '/' && !search ? '' : pathname + search;
  } catch {
    return '';
  }
};
const bookmarkTile = (b, sub) =>
  `<button class="sp-tile" data-url="${esc(b.url)}" data-id="${esc(b.id)}" title="${esc(b.url)}">
    <span class="sp-ic"><img src="${esc(favicon(b.url))}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>
    <b>${esc(b.title || hostLabel(b.url))}</b><small>${esc(sub ?? (b.title ? hostLabel(b.url) : pathOf(b.url)))}</small></button>`;
const folderTile = (path, n) =>
  `<button class="sp-tile sp-folder" data-folder="${esc(path)}" title="${esc(path)}">
    <span class="sp-ic">${icon('folder', 20)}</span><b>${esc(nameOf(path))}</b><small>${plural(n, 'bookmark')}</small></button>`;
const showAll = (path, n) => `<button class="sp-link sp-showall" data-folder="${esc(path)}">Show all ${plural(n, 'bookmark')} ${icon('right', 11)}</button>`;
const emptyNote = (title, text) => `<div class="sp-empty"><b>${esc(title)}</b><span>${esc(text)}</span></div>`;

/**
 * Draw the bookmarks into `host` (the start page's `.web-start-marks`). `open(url, how)` opens a bookmark, how 'here' |
 * 'tab' | 'window'. Call it again when bookmarks change: the filter box and the folder you're in stay.
 */
export function drawStartBookmarks(host, { win, open }) {
  host._sp = { win, open };
  if (!host.dataset.ready) mount(host);
  const all = store.all('bookmarks');
  host.closest('.web-start')?.classList.toggle('rich', all.length > 0);
  const crumbs = $('.sp-crumbs', host);
  const body = $('.sp-body', host);
  const filter = $('.sp-filter input', host);
  const q = filter.value.trim();
  $('.sp-head', host).hidden = !all.length;

  if (!all.length) {
    body.innerHTML = `<div class="sp-empty"><span class="sp-empty-ic">${icon('star', 24)}</span><b>No bookmarks yet</b>
      <span>Press Ctrl+D on a page to keep it here, or bring your bookmarks over from another browser.</span>
      <button class="btn small" data-import>${icon('download', 12)} Import bookmarks</button></div>`;
    return;
  }
  const tree = folderTree(all);
  if (view.folder !== ROOT && !all.some((b) => inFolder(b, view.folder))) view.folder = ROOT; // the folder went away
  const f = tree.through(view.folder);

  // Where you are: the folders above this one, without the wrappers.
  const parts = f.split('/').filter(Boolean);
  const trail = parts
    .map((_, i) => parts.slice(0, i + 1).join('/'))
    .filter((p) => p === f || !tree.isWrapper(p))
    .map((p) => (p === f ? `<b>${esc(nameOf(p))}</b>` : `<button class="sp-crumb" data-folder="${esc(p)}">${esc(nameOf(p))}</button>`));
  crumbs.innerHTML = [f === ROOT && !q ? '<b>Bookmarks</b>' : '<button class="sp-crumb" data-folder="">Bookmarks</button>', ...(q ? [`<b>Matching “${esc(q)}”</b>`] : trail)].join(
    `<i>${icon('right', 10)}</i>`,
  );

  if (q) {
    const rows = all.filter((b) => recordMatches('bookmarks', b, q)).sort(byTitle);
    body.innerHTML = rows.length
      ? `<div class="sp-grid">${rows.slice(0, MAX_TILES).map((b) => bookmarkTile(b, folderOf(b) ? nameOf(folderOf(b)) : hostLabel(b.url))).join('')}</div>`
      : emptyNote('No bookmarks match', `Nothing saved matches “${q}”.`);
    return;
  }

  if (f === ROOT) {
    // The front: every top folder is a section, with a few of its bookmarks; the loose ones come first.
    const loose = tree.inside(ROOT);
    const section = (path) => {
      const subs = tree.sorted(path).map(tree.through);
      const marks = tree.inside(path);
      const shown = marks.slice(0, Math.max(PER_SECTION - subs.length, 4));
      return `<section class="sp-section">
        <h5 class="sp-title"><button data-folder="${esc(path)}">${esc(nameOf(path))}${icon('right', 11)}</button><small>${tree.counts.get(path)}</small></h5>
        <div class="sp-grid">${subs.map((s) => folderTile(s, tree.counts.get(s))).join('')}${shown.map((b) => bookmarkTile(b)).join('')}</div>
        ${shown.length < marks.length ? showAll(path, marks.length) : ''}</section>`;
    };
    body.innerHTML =
      (loose.length ? `<section class="sp-section"><div class="sp-grid">${loose.slice(0, MAX_TILES).map((b) => bookmarkTile(b)).join('')}</div></section>` : '') +
      tree
        .sorted(ROOT)
        .map(tree.through)
        .map(section)
        .join('');
    return;
  }

  // A folder: its subfolders, then all of its own bookmarks.
  const subs = tree.sorted(f).map(tree.through);
  const marks = tree.inside(f);
  body.innerHTML =
    subs.length || marks.length
      ? `<div class="sp-grid">${subs.map((s) => folderTile(s, tree.counts.get(s))).join('')}${marks.slice(0, MAX_TILES).map((b) => bookmarkTile(b)).join('')}</div>`
      : emptyNote('This folder is empty', 'Bookmarks you move here will show up.');
}

/* ----- the frame (once per page) and what clicks do ----- */
function mount(host) {
  host.dataset.ready = '1';
  host.innerHTML = `<div class="sp-head">
      <nav class="sp-crumbs" aria-label="Folder"></nav>
      <label class="tb-search sp-filter">${icon('search', 13)}<input type="search" placeholder="Filter bookmarks" spellcheck="false" autocomplete="off"></label>
      <button class="sp-link" data-manage title="Open the Bookmarks app">Manage ${icon('right', 11)}</button>
    </div><div class="sp-body"></div>`;
  const redraw = () => drawStartBookmarks(host, host._sp);
  const filter = $('.sp-filter input', host);
  filter.addEventListener('input', debounce(redraw, 120));
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filter.value) {
      e.stopPropagation();
      filter.value = '';
      redraw();
    }
  });
  const showFolder = (f) => {
    view.folder = f;
    if (filter.value) filter.value = '';
    redraw();
    host.closest('.web-start')?.scrollTo({ top: 0 });
  };
  const bookmarkAt = (t) => store.get('bookmarks', t.closest('[data-id]')?.dataset.id);

  host.addEventListener('click', (e) => {
    const t = e.target;
    const tile = t.closest('[data-url]');
    if (tile) return host._sp.open(tile.dataset.url, e.ctrlKey || e.metaKey ? 'tab' : e.shiftKey ? 'window' : 'here');
    const folder = t.closest('[data-folder]');
    if (folder) return showFolder(folder.dataset.folder);
    if (t.closest('[data-manage]')) return openApp('bookmarks', { folder: view.folder });
    if (t.closest('[data-import]')) return openImport();
  });
  host.addEventListener('auxclick', (e) => {
    const tile = e.target.closest('[data-url]');
    if (tile && e.button === 1) {
      e.preventDefault();
      host._sp.open(tile.dataset.url, 'tab');
    }
  });
  host.addEventListener('contextmenu', (e) => {
    const { open, win } = host._sp;
    const t = e.target;
    const b = t.closest('[data-url]') && bookmarkAt(t);
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      return showMenu(e.clientX, e.clientY, [
        { label: 'Open', act: () => open(b.url, 'here') },
        { label: 'Open in New Tab', act: () => open(b.url, 'tab') },
        { label: 'Open in New Window', act: () => open(b.url, 'window') },
        '-',
        { label: 'Copy Link', act: () => navigator.clipboard.writeText(b.url).then(() => toast('Link copied')) },
        { label: 'Edit…', act: () => editRecord(win, 'bookmarks', b) },
        {
          label: 'Delete',
          act: () => {
            store.remove('bookmarks', b.id);
            toast('Bookmark removed', '', { label: 'Undo', act: () => store.save('bookmarks', b) });
          },
        },
      ]);
    }
    const folder = t.closest('.sp-folder, .sp-title [data-folder]');
    if (folder) {
      e.preventDefault();
      e.stopPropagation();
      const f = folder.dataset.folder;
      const inside = store.all('bookmarks').filter((x) => inFolder(x, f)).sort(byTitle);
      showMenu(e.clientX, e.clientY, [
        { header: f.replaceAll('/', ' › ') },
        { label: 'Open Folder', act: () => showFolder(f) },
        {
          label: `Open All (${inside.length}) in New Tabs`,
          disabled: !inside.length,
          act: async () => {
            if (inside.length > 12 && !(await confirmDialog(`Open ${inside.length} tabs?`, { win, ok: 'Open All' }))) return;
            inside.forEach((x) => open(x.url, 'tab'));
          },
        },
        { label: 'Show in Bookmarks', act: () => openApp('bookmarks', { folder: f }) },
      ]);
    }
  });
}
