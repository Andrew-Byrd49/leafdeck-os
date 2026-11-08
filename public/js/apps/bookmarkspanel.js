// The browser's Bookmarks panel: a square popover from the bookmark button beside the star. The page showing is at the
// top (add it, or see and change the folder it's saved in); then a search, the folders on the left and what's in the
// chosen one on the right: its subfolders, then its bookmarks. Drag a bookmark onto a folder to move it there.

import { $, $$, esc, el, debounce } from '../util.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { placePopup, showMenu, closeMenu, toast, openApp } from '../wm.js';
import { editRecord, recordMatches, hostLabel } from '../schemas.js';
import { ask, confirmDialog } from '../dialogs.js';
import { favicon, findBookmark, openImport } from './bookmarks.js';

const RECENT = ':recent'; // the rail's "Recently added" (folders are paths like "Work/Clients": never this)
const ALL = '';
const DEFAULT_FOLDER = 'Leafdeck'; // where the star puts pages too
const MAX_ROWS = 300;

// Kept between openings: the folder you were in, and which folders you opened in the rail.
const view = { folder: RECENT, expanded: new Set() };
let panel = null; // { node, anchor, close }

const folderOf = (b) => (b.folder || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
const parentOf = (path) => path.split('/').slice(0, -1).join('/');
const nameOf = (path) => path.split('/').pop();
const inFolder = (b, f) => {
  const p = folderOf(b);
  return p === f || p.startsWith(f + '/');
};
const byTitle = (a, b) => (a.title || hostLabel(a.url)).localeCompare(b.title || hostLabel(b.url), undefined, { sensitivity: 'base' });

/** Every folder (with its parents) → how many bookmarks are in it, and each folder's subfolders. */
function folderTree(all) {
  const counts = new Map();
  const kids = new Map([[ALL, new Set()]]);
  for (const b of all) {
    const parts = folderOf(b).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      counts.set(p, (counts.get(p) || 0) + 1);
      const parent = parts.slice(0, i - 1).join('/');
      if (!kids.has(parent)) kids.set(parent, new Set());
      kids.get(parent).add(p);
    }
  }
  const sorted = (p) => [...(kids.get(p) || [])].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }));
  return { counts, sorted };
}

export const closeBookmarksPanel = () => panel?.close();
export const bookmarksPanelOpen = (anchor) => !!panel && (!anchor || panel.anchor === anchor);

/**
 * Show the panel under `anchor` (again: hide it). opts: win (the browser window), page() → { url, title } of the page
 * showing (url '' on a new tab's start page), open(url, how) with how 'here' | 'tab' | 'window'.
 */
export function toggleBookmarksPanel(anchor, { win, page, open }) {
  if (panel?.anchor === anchor) return closeBookmarksPanel();
  closeBookmarksPanel();
  let q = '';
  if (view.folder !== RECENT && view.folder !== ALL && !store.all('bookmarks').some((b) => inFolder(b, view.folder))) view.folder = RECENT;

  const node = el(`<div class="bmp" role="dialog" aria-label="Bookmarks">
    <div class="bmp-page"></div>
    <div class="bmp-tools">
      <label class="tb-search bmp-search">${icon('search', 13)}<input type="search" placeholder="Search bookmarks" spellcheck="false" autocomplete="off"></label>
    </div>
    <div class="bmp-body"><nav class="bmp-folders" aria-label="Folders"></nav><div class="bmp-list" role="list"></div></div>
    <div class="bmp-foot">
      <button class="bmp-link" data-import>${icon('download', 12)} Import…</button><span class="grow"></span>
      <button class="bmp-link" data-manage>Manage bookmarks ${icon('right', 11)}</button>
    </div>
  </div>`);
  const pageEl = $('.bmp-page', node);
  const rail = $('.bmp-folders', node);
  const list = $('.bmp-list', node);
  const search = $('.bmp-search input', node);

  /* ----- the page showing ----- */
  const drawPage = () => {
    const { url, title } = page();
    if (!url) {
      pageEl.innerHTML = `<span class="bmp-page-ic">${icon('bookmark', 16)}</span><span class="bmp-main"><b>Bookmarks</b><small>Open a page to bookmark it</small></span>`;
      return;
    }
    const b = findBookmark(url);
    const head = `<img class="fav" src="${esc(favicon(url))}" alt="" referrerpolicy="no-referrer">
      <span class="bmp-main"><b>${esc(b?.title || title || hostLabel(url))}</b><small>${esc(hostLabel(url) || url)}</small></span>`;
    pageEl.classList.toggle('saved', !!b);
    pageEl.innerHTML = b
      ? `${head}<button class="bmp-chip" data-move="${esc(b.id)}" title="Move to another folder">${icon('folder', 12)}<span>${esc(folderOf(b) ? nameOf(folderOf(b)) : 'No folder')}</span>${icon('down', 11)}</button>
         <button class="icon-btn" data-edit="${esc(b.id)}" title="Edit">${icon('note', 13)}</button>
         <button class="icon-btn" data-remove="${esc(b.id)}" title="Remove bookmark">${icon('trash', 13)}</button>`
      : `${head}<button class="btn small primary bmp-add" data-add>${icon('star', 12)} Add to ${esc(nameOf(addFolder()))}</button>`;
  };
  // A new bookmark goes in the folder you're looking at, else where the star puts them.
  const addFolder = () => (view.folder === RECENT || view.folder === ALL ? DEFAULT_FOLDER : view.folder);

  /* ----- folders ----- */
  const drawRail = () => {
    const all = store.all('bookmarks');
    const { counts, sorted } = folderTree(all);
    // The folder you're in stays visible: its parents are open.
    for (let p = parentOf(view.folder); p; p = parentOf(p)) view.expanded.add(p);
    const row = (path, depth) => {
      const subs = sorted(path);
      const open = view.expanded.has(path);
      return `<div class="bmp-folder${view.folder === path && !q ? ' on' : ''}" data-folder="${esc(path)}" style="--depth:${depth}" title="${esc(path)}" tabindex="-1">
          ${subs.length ? `<button class="bmp-twisty${open ? ' open' : ''}" data-twisty="${esc(path)}" aria-label="${open ? 'Collapse' : 'Expand'}">${icon('right', 10)}</button>` : '<i class="bmp-twisty"></i>'}
          ${icon('folder', 13)}<span>${esc(nameOf(path))}</span><small>${counts.get(path)}</small></div>
        ${open ? subs.map((s) => row(s, depth + 1)).join('') : ''}`;
    };
    rail.innerHTML = `<div class="bmp-folder${view.folder === RECENT && !q ? ' on' : ''}" data-folder="${RECENT}" style="--depth:0"><i class="bmp-twisty"></i>${icon('clock', 13)}<span>Recently added</span></div>
      <div class="bmp-folder${view.folder === ALL && !q ? ' on' : ''}" data-folder="" style="--depth:0"><i class="bmp-twisty"></i>${icon('star', 13)}<span>All bookmarks</span><small>${all.length}</small></div>
      ${sorted(ALL).length ? '<div class="bmp-sep"></div>' : ''}
      ${sorted(ALL).map((p) => row(p, 0)).join('')}`;
  };

  /* ----- what's in the chosen folder (or the search) ----- */
  let hereId = null; // the page showing, when it's saved: marked in the list
  const bookmarkRow = (b, showFolder) => {
    const where = showFolder && folderOf(b) ? ` · ${esc(folderOf(b).replaceAll('/', ' › '))}` : '';
    return `<div class="bmp-row${b.id === hereId ? ' here' : ''}" data-id="${esc(b.id)}" role="listitem" tabindex="0" draggable="true" title="${esc(b.url)}">
      <img class="fav" src="${esc(favicon(b.url))}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="bmp-main"><b>${esc(b.title || hostLabel(b.url))}</b><small>${esc(hostLabel(b.url))}${where}</small></span>
      <button class="icon-btn" data-edit="${esc(b.id)}" title="Edit">${icon('note', 12)}</button></div>`;
  };
  const folderRow = (path, n) =>
    `<div class="bmp-row bmp-sub" data-open-folder="${esc(path)}" data-folder="${esc(path)}" role="listitem" tabindex="0">
      <span class="bmp-sub-ic">${icon('folder', 15)}</span><span class="bmp-main"><b>${esc(nameOf(path))}</b><small>${n} bookmark${n === 1 ? '' : 's'}</small></span>${icon('right', 12)}</div>`;
  const empty = (title, text) => `<div class="bmp-empty"><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
  const more = (n) => (n > MAX_ROWS ? `<p class="bmp-more">Showing ${MAX_ROWS} of ${n}. Search to find the rest.</p>` : '');

  const drawList = () => {
    const all = store.all('bookmarks');
    hereId = page().url ? findBookmark(page().url)?.id : null;
    if (!all.length) {
      list.innerHTML = `<div class="bmp-empty"><b>No bookmarks yet</b><span>Add this page with the button above or the star (Ctrl+D), or bring yours over from another browser.</span>
        <button class="btn small" data-import>${icon('download', 12)} Import bookmarks</button></div>`;
      return;
    }
    if (q) {
      const rows = all.filter((b) => recordMatches('bookmarks', b, q)).sort(byTitle);
      list.innerHTML = rows.length
        ? `<div class="bmp-head">${rows.length} result${rows.length === 1 ? '' : 's'}</div>${rows.slice(0, MAX_ROWS).map((b) => bookmarkRow(b, true)).join('')}${more(rows.length)}`
        : empty('No bookmarks match', `Nothing saved matches “${q}”.`);
      return;
    }
    if (view.folder === RECENT) {
      const rows = [...all].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 25);
      list.innerHTML = `<div class="bmp-head">Recently added</div>${rows.map((b) => bookmarkRow(b, true)).join('')}`;
      return;
    }
    if (view.folder === ALL) {
      // Everything, in groups by folder (no folder first).
      const groups = new Map();
      for (const b of [...all].sort(byTitle)) {
        const f = folderOf(b);
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push(b);
      }
      let left = MAX_ROWS;
      list.innerHTML =
        [...groups.keys()]
          .sort((a, b) => (!a ? -1 : !b ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base' })))
          .map((f) => {
            if (left <= 0) return '';
            const rows = groups.get(f).slice(0, left);
            left -= rows.length;
            return `<div class="bmp-head" data-folder="${esc(f)}">${f ? `${icon('folder', 11)} ${esc(f.replaceAll('/', ' › '))}` : 'No folder'}</div>${rows.map((b) => bookmarkRow(b, false)).join('')}`;
          })
          .join('') + more(all.length);
      return;
    }
    // A folder: where it is, its subfolders, then its own bookmarks.
    const f = view.folder;
    const { counts, sorted } = folderTree(all);
    const parts = f.split('/');
    const crumbs = parts
      .map((name, i) => {
        const path = parts.slice(0, i + 1).join('/');
        return i === parts.length - 1 ? `<b>${esc(name)}</b>` : `<button class="bmp-crumb" data-open-folder="${esc(path)}">${esc(name)}</button>`;
      })
      .join(`<i>${icon('right', 10)}</i>`);
    const own = all.filter((b) => folderOf(b) === f).sort(byTitle);
    const subs = sorted(f);
    list.innerHTML = `<div class="bmp-head bmp-crumbs">${crumbs}</div>
      ${subs.map((s) => folderRow(s, counts.get(s))).join('')}
      ${own.slice(0, MAX_ROWS).map((b) => bookmarkRow(b, false)).join('')}${more(own.length)}
      ${!own.length && !subs.length ? empty('This folder is empty', 'Drag bookmarks here to move them in.') : ''}`;
  };

  const draw = () => {
    drawPage();
    drawRail();
    drawList();
  };
  const showFolder = (f) => {
    view.folder = f;
    if (q) {
      q = '';
      search.value = '';
    }
    draw();
    list.scrollTop = 0;
  };

  /* ----- changing bookmarks ----- */
  const folders = () => {
    const { counts } = folderTree(store.all('bookmarks'));
    return [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  };
  const moveTo = (b, f) => {
    if (!b || folderOf(b) === f) return;
    store.save('bookmarks', { ...b, folder: f });
    toast(f ? `Moved to ${nameOf(f)}` : 'Moved out of its folder');
  };
  const askFolderName = async (title, value = '') => {
    close(); // the question is a sheet over the window: the panel would cover it
    const r = await ask({ win, title, icon: 'folder', fields: [{ name: 'name', label: 'Name', value, placeholder: 'e.g. Work or Work/Clients' }], buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    const name = (r?.values?.name || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
    return r?.button === 'ok' && name ? name : '';
  };
  const folderMenu = (anchorEl, b) => {
    const r = anchorEl.getBoundingClientRect();
    const current = folderOf(b);
    showMenu(
      r.left,
      r.bottom + 4,
      [
        { header: 'Move to folder' },
        ...folders().map((f) => ({ label: f.replaceAll('/', ' › '), checked: f === current, act: () => moveTo(b, f) })),
        { label: 'No folder', checked: !current, act: () => moveTo(b, '') },
        '-',
        {
          label: 'New Folder…',
          act: async () => {
            const name = await askFolderName('New folder');
            if (name) moveTo(store.get('bookmarks', b.id), name);
          },
        },
      ],
      { owner: anchorEl, minWidth: 200 },
    );
  };
  const removeBookmark = (b) => {
    store.remove('bookmarks', b.id);
    toast('Bookmark removed', '', { label: 'Undo', act: () => store.save('bookmarks', b) });
  };
  const rowMenu = (e, b) => {
    showMenu(e.clientX, e.clientY, [
      { label: 'Open', act: () => (close(), open(b.url, 'here')) },
      { label: 'Open in New Tab', act: () => open(b.url, 'tab') },
      { label: 'Open in New Window', act: () => (close(), open(b.url, 'window')) },
      '-',
      { label: 'Copy Link', act: () => navigator.clipboard.writeText(b.url).then(() => toast('Link copied')) },
      { label: 'Edit…', act: () => (close(), editRecord(win, 'bookmarks', b)) },
      { label: 'Delete', act: () => removeBookmark(b) },
    ]);
  };
  const folderContextMenu = (e, f) => {
    const inside = store.all('bookmarks').filter((b) => inFolder(b, f));
    showMenu(e.clientX, e.clientY, [
      { header: f.replaceAll('/', ' › ') },
      {
        label: `Open All (${inside.length}) in New Tabs`,
        disabled: !inside.length,
        act: async () => {
          if (inside.length > 12 && !(await confirmDialog(`Open ${inside.length} tabs?`, { win, ok: 'Open All' }))) return;
          close();
          inside.sort(byTitle).forEach((b) => open(b.url, 'tab'));
        },
      },
      {
        label: 'Rename Folder…',
        act: async () => {
          const name = await askFolderName('Rename folder', f);
          if (!name || name === f) return;
          store.saveMany('bookmarks', inside.map((b) => ({ ...b, folder: name + folderOf(b).slice(f.length) })));
          if (view.folder === f || view.folder.startsWith(f + '/')) view.folder = name + view.folder.slice(f.length);
          toast(`Renamed to ${nameOf(name)}`);
        },
      },
      {
        label: 'Delete Folder…',
        act: async () => {
          close();
          const ok = await confirmDialog(`Delete “${nameOf(f)}” and the ${inside.length} bookmark${inside.length === 1 ? '' : 's'} in it?`, { win, ok: 'Delete', danger: true });
          if (!ok) return;
          for (const b of inside) store.remove('bookmarks', b.id);
          if (inFolder({ folder: view.folder }, f)) view.folder = RECENT;
          toast(`Deleted ${nameOf(f)}`, '', { label: 'Undo', act: () => store.saveMany('bookmarks', inside) });
        },
      },
    ]);
  };

  /* ----- input ----- */
  node.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-manage]')) return close(), openApp('bookmarks', { folder: view.folder === RECENT ? '' : view.folder });
    if (t.closest('[data-import]')) return close(), openImport();
    if (t.closest('[data-add]')) {
      const { url, title } = page();
      if (!url || findBookmark(url)) return;
      store.save('bookmarks', { title: title || hostLabel(url), url, folder: addFolder() });
      return toast(`Bookmarked in ${nameOf(addFolder())}`);
    }
    const move = t.closest('[data-move]');
    if (move) return folderMenu(move, store.get('bookmarks', move.dataset.move));
    const rm = t.closest('[data-remove]');
    if (rm) return removeBookmark(store.get('bookmarks', rm.dataset.remove));
    const edit = t.closest('[data-edit]');
    if (edit) return close(), editRecord(win, 'bookmarks', store.get('bookmarks', edit.dataset.edit));
    const tw = t.closest('[data-twisty]');
    if (tw) {
      const p = tw.dataset.twisty;
      if (view.expanded.has(p)) view.expanded.delete(p);
      else view.expanded.add(p);
      return drawRail();
    }
    const go = t.closest('[data-open-folder]');
    if (go) {
      view.expanded.add(go.dataset.openFolder);
      return showFolder(go.dataset.openFolder);
    }
    const f = t.closest('.bmp-folders [data-folder]');
    if (f) {
      if (f.dataset.folder && f.dataset.folder !== RECENT) view.expanded.add(f.dataset.folder);
      return showFolder(f.dataset.folder);
    }
    const row = t.closest('[data-id]');
    const b = row && store.get('bookmarks', row.dataset.id);
    if (!b) return;
    // Ctrl/⌘-click: a tab behind this one (the panel stays, for opening several); Shift-click: a new window.
    if (e.ctrlKey || e.metaKey) return open(b.url, 'tab');
    close();
    open(b.url, e.shiftKey ? 'window' : 'here');
  });
  node.addEventListener('auxclick', (e) => {
    const row = e.button === 1 && e.target.closest('[data-id]');
    const b = row && store.get('bookmarks', row.dataset.id);
    if (b) open(b.url, 'tab');
  });
  node.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-id]');
    const b = row && store.get('bookmarks', row.dataset.id);
    const f = !b && e.target.closest('[data-folder]')?.dataset.folder;
    if (!b && !f) return;
    e.preventDefault();
    if (b) rowMenu(e, b);
    else if (f !== RECENT) folderContextMenu(e, f);
  });
  search.addEventListener(
    'input',
    debounce(() => {
      q = search.value.trim();
      drawRail();
      drawList();
      list.scrollTop = 0;
    }, 100),
  );
  // ↓ from the search goes into the list; ↑/↓ move through it; Enter opens.
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (search.value && document.activeElement === search) {
        search.value = '';
        search.dispatchEvent(new Event('input'));
        return;
      }
      return close();
    }
    const rows = $$('.bmp-list [tabindex="0"]', node);
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(rows.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
      (next < 0 ? search : rows[next])?.focus();
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      rows[i].click();
    } else if (e.key === 'Enter' && document.activeElement === search && rows[0]) {
      e.preventDefault();
      rows[0].click();
    }
  });

  // Drag a bookmark onto a folder (in the rail, or a subfolder in the list) to move it there.
  let dragId = null;
  node.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('[data-id]');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/uri-list', store.get('bookmarks', dragId)?.url || '');
    row.classList.add('dragging');
    node.classList.add('moving');
  });
  node.addEventListener('dragend', () => {
    dragId = null;
    node.classList.remove('moving');
    $$('.dragging, .drop', node).forEach((x) => x.classList.remove('dragging', 'drop'));
  });
  const dropFolder = (e) => {
    const f = dragId && e.target.closest?.('[data-folder]');
    return f && f.dataset.folder !== RECENT ? f : null;
  };
  node.addEventListener('dragover', (e) => {
    const f = dropFolder(e);
    $$('.drop', node).forEach((x) => x !== f && x.classList.remove('drop'));
    if (!f) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    f.classList.add('drop');
  });
  node.addEventListener('drop', (e) => {
    const f = dropFolder(e);
    if (!f) return;
    e.preventDefault();
    moveTo(store.get('bookmarks', dragId), f.dataset.folder);
  });

  /* ----- showing and hiding ----- */
  const outside = (e) => {
    if (node.contains(e.target) || anchor.contains(e.target) || e.target.closest?.('.menu')) return;
    close();
  };
  // A click into a page (a <webview> takes the focus; its clicks never reach this document) closes it too.
  const pageFocus = (e) => e.target?.tagName === 'WEBVIEW' && close();
  const onStore = (e) => (e.detail.col === 'bookmarks' || e.detail.col === '*') && redraw();
  const redraw = debounce(draw, 30);
  function close() {
    if (panel?.node !== node) return;
    panel = null;
    removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', pageFocus);
    store.removeEventListener('change', onStore);
    anchor.classList.remove('open');
    closeMenu();
    node.classList.add('closing');
    setTimeout(() => node.remove(), 120);
  }

  draw();
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  placePopup(node, r.right - node.offsetWidth + 6, r.bottom + 6, { pad: 8, near: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
  anchor.classList.add('open');
  panel = { node, anchor, close };
  setTimeout(() => addEventListener('pointerdown', outside, true));
  document.addEventListener('focusin', pageFocus);
  store.addEventListener('change', onStore);
  win.cleanups.push(close);
  $('.bmp-folder.on', rail)?.scrollIntoView({ block: 'nearest' });
  search.focus();
}
