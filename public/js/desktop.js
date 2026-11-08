// Desktop icons, placed like a phone's home screen: the screen is a grid of slots and each icon sits in one, wherever you
// put it. While you drag, the empty slots around the icon show. Hold it on an occupied slot and that icon moves aside to
// the nearest free one; hold it over another icon's middle to make a group of the two (or to put it in a group, or a
// file into a folder). Select several (Ctrl/Shift+click, or drag a box around them) to move them together. Drop on
// the Dock to pin apps. Esc puts everything back.
//
// What's on it: the apps, desktop Connections, groups (a few icons in one tile, each with its own outline color), and
// on Linux the files and folders in your Desktop folder (drag them in from Files, or from other programs).
//
// prefs.desktopLayout is the order: app ids, 'file:<name>' keys, and groups ({ id, name, apps: [keys], color? }). New
// things take the first free slot, in that order. prefs.desktopPos says where each one is: { key: [column, row] },
// columns counted from the side the icons are on. Entries that are hidden right now (e.g. a Connection from another
// workspace) keep their place.

import { store } from './store.js';
import { $, $$, esc, el, uid } from './util.js';
import { appIcon } from './icons.js';
import { registry, getApp, openApp, showMenu, placePopup, appMenuItems, setPinned, isPinned, toast, wins } from './wm.js';
import { linkAppId } from './apps/system.js';
import { pickColor } from './colorpicker.js';
import { shell } from './shell.js';
import { openWebPage, fileUrlOf } from './apps/browser.js';
import { folderArt } from './filethumb.js';

const DEFAULT_ORDER = [
  'contacts', 'tasks', 'calendar', 'notes', 'bookmarks', 'history', 'downloads', 'passwords', 'connections', 'designer', 'settings',
];
const FILES_DRAG = 'application/x-leafdeck-files'; // what Files puts on a drag (apps/files.js)
const DISPLACE_AFTER = 260; // ms on an occupied slot before its icon moves aside
const INTO_AFTER = 120; // ms over an icon's middle before it means "put it in" (so passing over one doesn't flash)

const isGroup = (e) => e && typeof e === 'object';
const keyOf = (e) => (isGroup(e) ? e.id : e);
const isFileKey = (k) => typeof k === 'string' && k.startsWith('file:');

/* ---------------- Files on the desktop (Linux) ---------------- */

const filesOK = !!shell?.files?.desktopDir && shell.platform === 'linux';
let deskDir = ''; // the Desktop folder
let deskFiles = null; // name -> entry; null until it has been read (and always off Linux)
let watching = '';

const fileOf = (k) => (isFileKey(k) ? deskFiles?.get(k.slice(5)) : null);
const fileKey = (p) => 'file:' + String(p).split('/').pop();
const fileUrl = (p) => `/~file?p=${encodeURIComponent(p)}`;
const extOf = (name) => (name.includes('.') && !name.startsWith('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : '');
const errText = (x) => String(x?.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Read the Desktop folder (making it first, when something is about to go in it) and keep watching it. */
async function loadFiles({ create = false } = {}) {
  if (!filesOK) return;
  try {
    const d = await shell.files.desktopDir(create);
    deskDir = d.path;
    const list = d.exists ? await shell.files.list(d.path) : { entries: [] };
    deskFiles = new Map(list.entries.filter((f) => !f.hidden).map((f) => [f.name, f]));
    if (d.exists && watching !== d.path) {
      if (watching) shell.files.unwatch(watching);
      shell.files.watch(d.path);
      watching = d.path;
    }
  } catch {}
  renderIcons();
}

/** A file's picture: a folder, a thumbnail for pictures, or a page with the file's extension. */
function fileArt(f) {
  if (f.dir) return `<span class="d-art d-dir">${folderArt(f)}</span>`;
  if (f.kind === 'image' && f.size < 40e6) return `<span class="d-art d-pic"><img src="${esc(fileUrl(f.path))}" loading="lazy" decoding="async" alt="" draggable="false"></span>`;
  return `<span class="d-art d-doc fm-tile k-${esc(f.kind)}"><b>${esc(extOf(f.name))}</b></span>`;
}

const PREVIEW = new Set(['video', 'audio', 'text', 'code', 'pdf']);
const PRINTS = new Set(['pdf', 'image', 'text', 'code', 'doc', 'sheet', 'slides']); // what gets Print… (electron/printing.cjs)
/** Open a file the way Files would: folders in Files, pictures in Image Viewer, web pages in the browser, a preview, or the computer's app. */
async function openFile(f) {
  if (f.dir || PREVIEW.has(f.kind)) return openApp('files', { open: f.path });
  if (f.kind === 'image') return openApp('viewer', { file: f.path });
  if (/\.(html?|xhtml)$/i.test(f.name)) return openWebPage(fileUrlOf(f.path));
  const problem = await shell.files.open(f.path).catch(errText);
  if (problem) toast(`There’s no app on this computer that opens ${extOf(f.name) ? `.${extOf(f.name).toLowerCase()} files` : 'this file'} yet.`, 'error');
}

async function openWithMenu(f, x, y) {
  const apps = await shell.files.appsFor(f.path).catch(() => []);
  const own = [
    /\.(html?|xhtml|svg|pdf)$/i.test(f.name) && { label: 'Browser', act: () => openWebPage(fileUrlOf(f.path)) },
    f.kind === 'image' && { label: 'Image Viewer', act: () => openApp('viewer', { file: f.path }) },
    f.kind === 'image' && { label: 'Image Editor', act: () => openApp('imageeditor', { file: f.path }) },
    PREVIEW.has(f.kind) && { label: 'Preview in Files', act: () => openApp('files', { open: f.path }) },
  ].filter(Boolean);
  showMenu(x, y, [
    { header: 'Open with' },
    ...own,
    own.length && apps.length && '-',
    ...apps.map((a) => ({
      label: a.name,
      key: a.isDefault ? 'Default' : '',
      act: async () => {
        const problem = await shell.files.openWith(f.path, a.id).catch(errText);
        if (problem) toast(`${a.name} couldn’t open it: ${problem}`, 'error');
      },
    })),
    !own.length && !apps.length && { label: 'No app on this computer opens this file', disabled: true },
  ]);
}

async function trashFiles(keys) {
  const list = keys.map(fileOf).filter(Boolean);
  if (!list.length) return;
  try {
    await shell.files.trash(list.map((f) => f.path));
    toast(list.length === 1 ? `“${list[0].name}” moved to the Trash` : `${list.length} items moved to the Trash`, '', { label: 'Undo', act: () => untrash(list) });
  } catch (x) {
    toast(errText(x), 'error');
  }
  loadFiles();
}
async function untrash(list) {
  // The Trash keeps the name (or a numbered one, if taken there): put back the newest entry from each place.
  const inTrash = await shell.files.trashList().catch(() => []);
  const found = list.map((f) => inTrash.filter((t) => t.origPath === f.path).sort((a, b) => b.deletedAt - a.deletedAt)[0]?.path).filter(Boolean);
  await shell.files.restore(found).catch((x) => toast(errText(x), 'error'));
  loadFiles();
}

/** A file's key changes with its name: carry its place (and its spot in a group) over. */
function renameKey(from, to) {
  const p = store.prefs;
  const swap = (k) => (k === from ? to : k);
  const pos = { ...(p.desktopPos || {}) };
  if (pos[from]) [pos[to], pos[from]] = [pos[from], undefined];
  store.setPrefs({
    desktopLayout: (p.desktopLayout || []).map((e) => (isGroup(e) ? { ...e, apps: (e.apps || []).map(swap) } : swap(e))),
    desktopPos: Object.fromEntries(Object.entries(pos).filter(([, v]) => v)),
  });
}

/** Rename a file in place, on its label. */
let renaming = false;
function renameFile(k) {
  const f = fileOf(k);
  const b = tileEl(k) || (pop && $(`.dgp-item[data-key="${CSS.escape(k)}"]`, pop.el));
  const label = b && $('.d-label, :scope > span:last-child', b);
  if (!f || !label) return;
  const input = el('<input class="d-rename" spellcheck="false" aria-label="Name">');
  input.value = f.name;
  // Over the label rather than in it: the icon is a button.
  const r = label.getBoundingClientRect();
  const w = Math.max(r.width, b.getBoundingClientRect().width + 24);
  Object.assign(input.style, { left: `${r.left + r.width / 2 - w / 2}px`, top: `${r.top - 2}px`, width: `${w}px` });
  label.style.visibility = 'hidden';
  document.body.append(input);
  renaming = true;
  input.focus();
  const dot = f.dir ? -1 : f.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : f.name.length);
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    renaming = false;
    input.remove();
    label.style.visibility = '';
    const v = input.value.trim();
    if (!ok || !v || v === f.name) return renderIcons();
    try {
      const to = await shell.files.rename(f.path, v);
      deskFiles.delete(f.name);
      deskFiles.set(to.split('/').pop(), { ...f, name: to.split('/').pop(), path: to });
      renameKey(k, fileKey(to));
      renderIcons();
    } catch (x) {
      toast(errText(x), 'error');
      renderIcons();
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

/** Copy or move files somewhere. Resolves to the new paths ([] when it didn't work). */
async function pasteFiles(paths, into, move) {
  try {
    return await shell.files.paste(paths, into, move);
  } catch (x) {
    toast(errText(x), 'error');
    return [];
  }
}

/* ---------------- The arrangement ---------------- */

/** Everything that belongs on the desktop right now, in default order: the usual apps less the ones you took off, then
    the ones you added (prefs.desktopApps: any app, e.g. from the app screen), Connections marked for the desktop, files. */
function availableKeys() {
  const removed = new Set(store.prefs.desktopRemoved || []);
  const added = (store.prefs.desktopApps || []).filter((id) => !DEFAULT_ORDER.includes(id) && getApp(id));
  const apps = [...DEFAULT_ORDER.filter((id) => registry.has(id) && !removed.has(id)), ...added];
  const links = store.all('links').filter((l) => l.desktop).map(linkAppId).filter((id) => getApp(id));
  const files = deskFiles ? [...deskFiles.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).map((n) => 'file:' + n) : [];
  return [...apps, ...links, ...files];
}

/** Whether an app has an icon on the desktop (on its own or in a group). */
export const onDesktop = (id) => availableKeys().includes(id);

/** Put an app on the desktop (in the first free slot), or take it off. A Connection keeps this as its own setting. */
export function setOnDesktop(id, on) {
  if (id.startsWith('link:')) {
    const link = store.get('links', id.slice(5));
    if (link) store.save('links', { ...link, desktop: on });
  } else if (DEFAULT_ORDER.includes(id)) {
    const removed = (store.prefs.desktopRemoved || []).filter((x) => x !== id);
    store.setPrefs({ desktopRemoved: on ? removed : [...removed, id] });
  } else {
    const added = (store.prefs.desktopApps || []).filter((x) => x !== id);
    store.setPrefs({ desktopApps: on ? [...added, id] : added });
  }
  renderIcons();
}

/** Hidden right now but may be back: an app from another workspace, or a file while the Desktop folder isn't read yet. */
const mayReturn = (k) => (isFileKey(k) ? deskFiles === null : !!getApp(k));

/** The visible arrangement: saved order, minus what's unavailable, plus anything new at the end. */
function layout() {
  const avail = new Set(availableKeys());
  const seen = new Set();
  const take = (k) => avail.has(k) && !seen.has(k) && seen.add(k);
  const items = [];
  for (const e of store.prefs.desktopLayout || []) {
    if (isGroup(e)) items.push({ id: e.id, name: e.name, color: e.color || '', apps: (e.apps || []).filter(take) });
    else if (take(e)) items.push(e);
  }
  for (const k of avail) if (!seen.has(k)) items.push(k);
  return items;
}

/**
 * Save a visible arrangement, keeping hidden entries (and hidden ones inside groups) where they were. `pos` changes
 * where things are ({ key: [c, r] }, or null to let it find a place again).
 */
function saveLayout(items, pos = {}) {
  const old = store.prefs.desktopLayout || [];
  const visible = new Set(items.flatMap((e) => (isGroup(e) ? e.apps : [e])));
  const hiddenIn = (f) => (f.apps || []).filter((k) => !visible.has(k) && mayReturn(k));
  const next = items.map((e) => {
    if (!isGroup(e)) return e;
    const was = old.find((o) => isGroup(o) && o.id === e.id);
    return { id: e.id, name: e.name, ...(e.color ? { color: e.color } : {}), apps: [...e.apps, ...(was ? hiddenIn(was) : [])] };
  });
  old.forEach((o, i) => {
    const kept = isGroup(o) ? !items.some((e) => isGroup(e) && e.id === o.id) && hiddenIn(o).length : !visible.has(o) && mayReturn(o);
    if (!kept) return;
    next.splice(Math.min(i, next.length), 0, isGroup(o) ? { ...o, apps: hiddenIn(o) } : o);
  });
  // Places: only for what's on the desktop itself (not inside a group).
  const top = new Set(next.map(keyOf));
  const merged = { ...(store.prefs.desktopPos || {}), ...pos };
  store.setPrefs({ desktopLayout: next, desktopPos: Object.fromEntries(Object.entries(merged).filter(([k, v]) => v && top.has(k))) });
  renderIcons(); // right away, not on the next frame, so a drop never shows the old arrangement
}

const findGroup = (items, id) => items.find((e) => isGroup(e) && e.id === id);
const indexOfEntry = (items, key) => items.findIndex((e) => keyOf(e) === key);
const isGroupKey = (k) => !!$(`#icons .d-group[data-key="${CSS.escape(k)}"]`);

/* ---------------- The grid ----------------
   #icons covers the screen the icons are on. A slot is an icon's size plus the spacing from Settings → Desktop; the
   columns count from the icons' side, so the right-hand column is column 0 when they're on the right. */

const cellId = (c, r) => `${c},${r}`;
const ART_TOP = 6; // the icon's padding above its picture

function geom() {
  const box = $('#icons');
  const cs = getComputedStyle(box);
  const is = parseFloat(cs.getPropertyValue('--icon-scale')) || 1;
  const gap = parseFloat(cs.getPropertyValue('--icon-gap')) || 0;
  const W = box.clientWidth;
  const H = box.clientHeight;
  const tw = Math.round(92 * is);
  const th = Math.round(112 * is);
  const g = { W, H, tw, th, art: Math.round(54 * is), px: tw + gap, py: th + gap, left: document.documentElement.dataset.iconsSide === 'left', blocked: new Set() };
  g.cols = Math.max(1, Math.floor((W + gap) / g.px));
  g.rows = Math.max(1, Math.floor((H + gap) / g.py));
  // No slots under widgets.
  const br = box.getBoundingClientRect();
  const ws = $('#widgets')?.hidden ? [] : $$('#widgets .widget').map((w) => w.getBoundingClientRect()).filter((r) => r.width);
  if (ws.length && W)
    for (let c = 0; c < g.cols; c++)
      for (let r = 0; r < g.rows; r++) {
        const p = at(g, c, r);
        const x = br.left + p.x;
        const y = br.top + p.y;
        if (ws.some((w) => x + 8 < w.right && x + tw - 8 > w.left && y + 8 < w.bottom && y + th - 8 > w.top)) g.blocked.add(cellId(c, r));
      }
  return g;
}
/** A slot's top-left corner in #icons. */
const at = (g, c, r) => ({ x: g.left ? c * g.px : g.W - g.tw - c * g.px, y: r * g.py });
/** The slot whose picture is nearest a point in #icons. */
function cellAt(g, x, y) {
  const c = g.left ? Math.round((x - g.tw / 2) / g.px) : Math.round((g.W - g.tw / 2 - x) / g.px);
  const r = Math.round((y - ART_TOP - g.art / 2) / g.py);
  return { c: Math.max(0, Math.min(g.cols - 1, c)), r: Math.max(0, Math.min(g.rows - 1, r)) };
}
/** The free slot nearest one (on the screen), or null when there's none. */
function nearestFree(g, c0, r0, free) {
  let best = null;
  for (let c = 0; c < g.cols; c++)
    for (let r = 0; r < g.rows; r++) {
      if (!free(c, r)) continue;
      const d = ((c - c0) * g.px) ** 2 + ((r - r0) * g.py) ** 2;
      if (!best || d < best.d) best = { c, r, d };
    }
  return best;
}
/** The first free slot, down each column from the icons' side; past the screen's edge when it's full. */
function firstFree(g, free, from = null) {
  const start = from ? from.c * g.rows + from.r + 1 : 0;
  for (let i = start; i < (g.cols + 100) * g.rows; i++) {
    const c = Math.floor(i / g.rows);
    const r = i % g.rows;
    if (free(c, r)) return { c, r };
  }
  return firstFree(g, free);
}

/**
 * Where everything shows: its saved slot; the nearest free one when that's off this screen, under a widget or taken
 * ("borrowed": it goes back when there's room again); the first free one for something new.
 */
function place(items, g) {
  const saved = store.prefs.desktopPos || {};
  const cells = new Map(); // key -> { c, r, borrowed }
  const taken = new Set();
  const open = (c, r) => !taken.has(cellId(c, r)) && !g.blocked.has(cellId(c, r));
  const claim = (k, p, borrowed = false) => {
    cells.set(k, { c: p.c, r: p.r, borrowed });
    taken.add(cellId(p.c, p.r));
  };
  const valid = (p) => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= 0 && p[1] >= 0;
  const inside = (p) => p[0] < g.cols && p[1] < g.rows;
  const off = [];
  const loose = [];
  for (const e of items) {
    const k = keyOf(e);
    const p = saved[k];
    if (!valid(p)) loose.push(k);
    else if (inside(p) && open(p[0], p[1])) claim(k, { c: p[0], r: p[1] });
    else off.push([k, p, !inside(p) || g.blocked.has(cellId(p[0], p[1]))]);
  }
  for (const [k, p, borrowed] of off) claim(k, nearestFree(g, Math.min(p[0], g.cols - 1), Math.min(p[1], g.rows - 1), open) || firstFree(g, open), borrowed);
  for (const k of loose) claim(k, firstFree(g, open));
  return cells;
}

/** Every visible icon's slot as it shows now, to save with a change so nothing else moves (borrowed slots aren't). */
function pinAll(except = []) {
  const pos = {};
  for (const [k, p] of placed?.cells || []) if (!p.borrowed && !except.includes(k)) pos[k] = [p.c, p.r];
  return pos;
}

/* ---------------- Rendering ---------------- */

let placed = null; // { g, cells }: the last render
let dragging = false; // a drag is under way: renders wait for it (they'd pull the icons out from under it)
let renderLater = false;

const tileEl = (k) => $(`#icons .d-icon[data-key="${CSS.escape(k)}"]`);
const artOf = (b) => b && $(':scope > .app-icon, :scope > .d-art', b);

function miniArt(k) {
  const f = fileOf(k);
  if (f) return `<i>${fileArt(f)}</i>`;
  const a = getApp(k);
  return a ? `<i>${appIcon(a)}</i>` : '';
}
function groupTile(f) {
  // Up to four show bigger, in a 2×2 grid.
  return `<span class="app-icon is-glass is-group"><span class="ai-face ai-glass group-grid${f.apps.length <= 4 ? ' group-2' : ''}">${f.apps.slice(0, 9).map(miniArt).join('')}</span></span>`;
}

function tile(e, { x, y }) {
  const k = keyOf(e);
  const s = sel.has(k) ? ' sel' : '';
  const pos = `left:${x}px;top:${y}px`;
  if (isGroup(e)) {
    const color = /^#[0-9a-f]{6}$/i.test(e.color || '') ? `;--group:${e.color}` : '';
    return `<button class="d-icon d-group${s}" data-group="${esc(k)}" data-key="${esc(k)}" style="${pos}${color}">${groupTile(e)}<span class="d-label">${esc(e.name)}</span></button>`;
  }
  const f = fileOf(k);
  if (f) return `<button class="d-icon d-file${s}" data-file="${esc(k)}" data-key="${esc(k)}" title="${esc(f.name)}" style="${pos}">${fileArt(f)}<span class="d-label">${esc(f.name)}</span></button>`;
  const a = getApp(k);
  return `<button class="d-icon${s}" data-app="${esc(k)}" data-key="${esc(k)}" style="${pos}">${appIcon(a)}<span class="d-label">${esc(a.name)}</span></button>`;
}

export function renderIcons() {
  if (dragging || renaming) return void (renderLater = true);
  renderLater = false;
  const box = $('#icons');
  const items = layout();
  const g = geom();
  const cells = place(items, g);
  placed = { g, cells };
  // In the page in column order, so Shift+click runs and Tab go down each column.
  const order = items.map((e) => [e, cells.get(keyOf(e))]).sort(([, a], [, b]) => a.c - b.c || a.r - b.r);
  box.innerHTML = order.map(([e, p]) => tile(e, at(g, p.c, p.r))).join('');
  if (pop) renderPop();
}

/* ---------------- Group window ---------------- */

let pop = null; // { el, id, anchor }

function openGroup(id, { rename = false } = {}) {
  closeGroup();
  const anchor = tileEl(id);
  if (!anchor) return;
  const node = el(`<div class="d-group-pop" role="dialog" aria-label="Group">
    <input class="dgp-name" spellcheck="false" aria-label="Group name">
    <div class="dgp-grid"></div></div>`);
  document.body.append(node);
  pop = { el: node, id, anchor };
  const color = findGroup(layout(), id)?.color;
  if (color) node.style.setProperty('--group', color);
  renderPop();

  // Beside the group, on whichever side has more room on the icons' screen.
  const a = anchor.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const box = $('#icons').getBoundingClientRect();
  const x = a.left - box.left > box.right - a.right ? a.left - r.width - 10 : a.right + 10;
  placePopup(node, x, a.top - 10, { pad: 8, padBottom: 100, near: { x: a.left + a.width / 2, y: a.top + a.height / 2 } });
  anchor.classList.add('open');

  const name = $('.dgp-name', node);
  const commit = () => {
    const v = name.value.trim() || 'Group';
    const items = layout();
    const f = findGroup(items, id);
    if (f && f.name !== v) {
      f.name = v;
      saveLayout(items);
    }
  };
  name.addEventListener('change', commit);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      name.blur();
    }
    if (e.key === 'Escape') closeGroup();
    e.stopPropagation();
  });
  if (rename) {
    name.focus();
    name.select();
  }

  node.addEventListener('click', (e) => {
    const b = e.target.closest('.dgp-item');
    if (!b || node._suppressClick) return;
    closeGroup();
    openKey(b.dataset.key);
  });
  node.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.dgp-item');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const k = b.dataset.key;
    showMenu(e.clientX, e.clientY, [...(fileOf(k) ? fileMenuItems(k, e.clientX, e.clientY) : appMenuItems(k)), '-', { label: 'Remove from Group', act: () => moveOut(k, id) }]);
  });
  node.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.dgp-item');
    if (b && e.button === 0) startDrag(e, b, { keys: [b.dataset.key], from: id });
  });
  setTimeout(() => addEventListener('pointerdown', outsidePop, true));
}

function renderPop() {
  const f = findGroup(layout(), pop.id);
  if (!f) return closeGroup();
  pop.anchor = tileEl(pop.id) || pop.anchor;
  pop.anchor.classList.add('open');
  const name = $('.dgp-name', pop.el);
  if (document.activeElement !== name) name.value = f.name;
  $('.dgp-grid', pop.el).innerHTML =
    f.apps
      .map((k) => {
        const file = fileOf(k);
        const a = !file && getApp(k);
        if (!file && !a) return '';
        return `<button class="dgp-item" data-key="${esc(k)}"${file ? ` title="${esc(file.name)}"` : ''}>${file ? fileArt(file) : appIcon(a)}<span>${esc(file ? file.name : a.name)}</span></button>`;
      })
      .join('') || '<p class="dgp-empty">Drag apps and files here</p>';
}

function outsidePop(e) {
  if (!pop || pop.el.contains(e.target) || e.target.closest('.menu')) return;
  if (pop.anchor.contains(e.target)) return; // clicking the group again toggles it closed
  closeGroup();
}

export function closeGroup() {
  if (!pop) return;
  removeEventListener('pointerdown', outsidePop, true);
  const name = $('.dgp-name', pop.el);
  if (document.activeElement === name) name.dispatchEvent(new Event('change'));
  pop.anchor.classList.remove('open');
  pop.el.remove();
  pop = null;
}

/* ---------------- Group actions ---------------- */

function openKey(k) {
  const f = fileOf(k);
  if (f) return openFile(f);
  if (getApp(k)) openApp(k);
}

/** A new group: around some icons (where the first of them is), or empty in a slot. */
function newGroup(keys = [], cell = null) {
  const items = layout();
  const f = { id: 'g_' + uid(), name: 'New Group', apps: keys };
  const first = keys.map((k) => placed.cells.get(k)).filter(Boolean).sort((a, b) => a.c - b.c || a.r - b.r)[0];
  const rest = items.filter((e) => isGroup(e) || !keys.includes(e));
  const at = Math.min(...keys.map((k) => indexOfEntry(items, k)).filter((i) => i >= 0), items.length);
  rest.splice(Math.min(at, rest.length), 0, f);
  const spot = first || cell || freeSpot();
  selectOnly(f.id);
  saveLayout(rest, { ...pinAll(keys), ...Object.fromEntries(keys.map((k) => [k, null])), [f.id]: [spot.c, spot.r] });
  openGroup(f.id, { rename: true });
}

/** Free slots near one (for icons coming out of a group): the first goes there if it's free. */
function spread(keys, cell, taken = new Set()) {
  const g = placed.g;
  const used = new Set([...taken, ...[...placed.cells.values()].map((p) => cellId(p.c, p.r))]);
  const out = {};
  for (const k of keys) {
    const free = (c, r) => !used.has(cellId(c, r)) && !g.blocked.has(cellId(c, r));
    const p = nearestFree(g, cell.c, cell.r, free) || firstFree(g, free);
    used.add(cellId(p.c, p.r));
    out[k] = [p.c, p.r];
  }
  return out;
}
const freeSpot = () => {
  const used = new Set([...placed.cells.values()].map((p) => cellId(p.c, p.r)));
  return firstFree(placed.g, (c, r) => !used.has(cellId(c, r)) && !placed.g.blocked.has(cellId(c, r)));
};

function ungroup(id) {
  const items = layout();
  const i = indexOfEntry(items, id);
  if (i < 0) return;
  const keys = items[i].apps;
  const cell = placed.cells.get(id);
  items.splice(i, 1, ...keys);
  // The first takes the group's slot; the rest the free ones nearest it.
  const pos = { ...pinAll([id]), [id]: null };
  if (cell && keys.length) {
    pos[keys[0]] = [cell.c, cell.r];
    Object.assign(pos, spread(keys.slice(1), cell, new Set([cellId(cell.c, cell.r)])));
  }
  saveLayout(items, pos);
}

/** A group's outline color: the accent (''), or any color from the picker. Previewed live as you pick. */
function groupColor(id, x, y) {
  const f = findGroup(layout(), id);
  if (!f) return;
  const paint = (c) => {
    for (const n of [tileEl(id), pop?.id === id ? pop.el : null]) {
      if (!n) continue;
      if (c) n.style.setProperty('--group', c);
      else n.style.removeProperty('--group');
    }
  };
  pickColor(x, y, {
    value: f.color || '',
    accent: true,
    title: `${f.name} color`,
    onChange: paint,
    onDone: (c) => {
      const items = layout();
      const g = findGroup(items, id);
      if (!g || (g.color || '') === c) return;
      g.color = c;
      saveLayout(items);
    },
  });
}

/** Take something out of a group and put it in the free slot nearest the group. */
function moveOut(k, groupId) {
  const items = layout();
  const f = findGroup(items, groupId);
  if (!f) return;
  f.apps = f.apps.filter((x) => x !== k);
  items.splice(indexOfEntry(items, groupId) + 1, 0, k);
  const cell = placed.cells.get(groupId);
  saveLayout(items, { ...pinAll(), ...(cell ? spread([k], cell) : {}) });
}

/* ---------------- Moving icons ---------------- */

/**
 * Where things go when they land in a slot: the first in that slot, the others in the free slots after it (down the
 * column). Whatever was in that slot moves to the free one nearest it. { key: { c, r } }
 */
function plan(keys, cell) {
  const g = placed.g;
  const base = [...placed.cells].filter(([k]) => !keys.includes(k));
  const taken = new Map(base.map(([k, p]) => [cellId(p.c, p.r), k]));
  const used = new Set(taken.keys());
  const free = (c, r) => !used.has(cellId(c, r)) && !g.blocked.has(cellId(c, r));
  const out = {};
  const occupant = taken.get(cellId(cell.c, cell.r));
  out[keys[0]] = cell;
  used.add(cellId(cell.c, cell.r));
  let prev = cell;
  for (const k of keys.slice(1)) {
    prev = firstFree(g, free, prev);
    out[k] = prev;
    used.add(cellId(prev.c, prev.r));
  }
  if (occupant) out[occupant] = nearestFree(g, cell.c, cell.r, free) || firstFree(g, free);
  return out;
}

/** Put icons in a slot (out of the group they were in, if any). */
function moveTo(keys, cell, from = null) {
  const items = layout();
  if (from) {
    const f = findGroup(items, from);
    if (f) f.apps = f.apps.filter((k) => !keys.includes(k));
    for (const k of keys) if (indexOfEntry(items, k) < 0) items.push(k);
  }
  const moves = plan(keys, cell);
  const pos = pinAll(keys);
  for (const [k, p] of Object.entries(moves)) pos[k] = [p.c, p.r];
  saveLayout(items, pos);
}

/** Icons dropped on a group go in it; on an app or file, they make a new group together; files on a folder move into it. */
async function putInto(keys, targetKey, what, from = null) {
  if (what === 'folder') {
    const dir = fileOf(targetKey);
    const paths = keys.map(fileOf).filter(Boolean).map((f) => f.path);
    if (dir && paths.length && (await pasteFiles(paths, dir.path, true)).length) toast(paths.length === 1 ? `Moved to ${dir.name}` : `${paths.length} items moved to ${dir.name}`);
    return loadFiles();
  }
  const items = layout();
  if (from) {
    const f = findGroup(items, from);
    if (f) f.apps = f.apps.filter((k) => !keys.includes(k));
  }
  const rest = items.filter((e) => isGroup(e) || !keys.includes(e));
  const ti = indexOfEntry(rest, targetKey);
  if (ti < 0) return renderIcons();
  const t = rest[ti];
  const gone = Object.fromEntries(keys.map((k) => [k, null]));
  if (isGroup(t)) {
    t.apps.push(...keys.filter((k) => !t.apps.includes(k)));
    saveLayout(rest, { ...pinAll(keys), ...gone });
    return toast(`Moved to ${t.name}`);
  }
  const f = { id: 'g_' + uid(), name: 'New Group', apps: [t, ...keys] };
  rest.splice(ti, 1, f);
  const cell = placed.cells.get(targetKey);
  selectOnly(f.id);
  saveLayout(rest, { ...pinAll([...keys, targetKey]), ...gone, [targetKey]: null, [f.id]: [cell.c, cell.r] });
  openGroup(f.id, { rename: true });
}

function pinToDock(apps) {
  const added = apps.filter((id) => !isPinned(id));
  added.forEach((id) => setPinned(id, true));
  if (added.length) toast(added.length === 1 ? `Added ${getApp(added[0])?.name || 'app'} to the Dock` : `Added ${added.length} apps to the Dock`);
}

/* ---------------- The slots you see while dragging ---------------- */

function showSlots() {
  const g = placed.g;
  const box = $('#icons');
  let html = '';
  for (let c = 0; c < g.cols; c++)
    for (let r = 0; r < g.rows; r++) {
      if (g.blocked.has(cellId(c, r))) continue;
      const p = at(g, c, r);
      html += `<i data-cell="${c},${r}" style="left:${p.x + (g.tw - g.art) / 2}px;top:${p.y + ART_TOP}px"></i>`;
    }
  const s = el(`<div class="d-slots">${html}</div>`);
  box.prepend(s);
  return {
    el: s,
    /** Show the slots around a point (in the page), with one of them lit. */
    aim(x, y, cell) {
      const br = box.getBoundingClientRect();
      s.style.setProperty('--mx', `${x - br.left}px`);
      s.style.setProperty('--my', `${y - br.top}px`);
      const id = cell ? cellId(cell.c, cell.r) : '';
      if (s._on !== id) {
        $('i.on', s)?.classList.remove('on');
        if (id) $(`i[data-cell="${id}"]`, s)?.classList.add('on');
        s._on = id;
      }
    },
    remove: () => s.remove(),
  };
}

/**
 * What a point means for icons with the given keys dropped there (the point is where the middle of the dragged picture
 * is, in the page): into the icon there (when it's over its middle), or a slot, with whatever's in it.
 * `intoWhat(occupantKey)` says what dropping into it would do ('group', 'new', 'folder'), or null when it can't.
 */
function aim(x, y, keys, intoWhat) {
  const g = placed.g;
  const br = $('#icons').getBoundingClientRect();
  let cell = cellAt(g, x - br.left, y - br.top);
  const base = new Map([...placed.cells].filter(([k]) => !keys.includes(k)).map(([k, p]) => [cellId(p.c, p.r), k]));
  if (g.blocked.has(cellId(cell.c, cell.r))) cell = nearestFree(g, cell.c, cell.r, (c, r) => !g.blocked.has(cellId(c, r))) || cell;
  const occupant = base.get(cellId(cell.c, cell.r));
  if (occupant) {
    const r = artOf(tileEl(occupant))?.getBoundingClientRect();
    const inset = r ? r.width * 0.2 : 0;
    const what = r && x > r.left + inset && x < r.right - inset && y > r.top + inset && y < r.bottom - inset && intoWhat(occupant);
    if (what) return { kind: 'into', key: occupant, what, cell };
  }
  return { kind: 'slot', cell, occupant };
}

/** What dropping these onto an icon would do. */
function intoRule(keys) {
  return (k) => {
    if (keys.some(isGroupKey)) return null; // groups don't go in groups
    if (isGroupKey(k)) return 'group';
    if (fileOf(k)?.dir && keys.every(isFileKey)) return 'folder';
    return 'new';
  };
}
function intoHint(t) {
  if (t.what === 'group') return `Add to ${$('.d-label', tileEl(t.key))?.textContent || 'group'}`;
  if (t.what === 'folder') return `Move into ${fileOf(t.key)?.name || 'folder'}`;
  return 'New group';
}

/* ---------------- Dragging ----------------
   From the desktop (the icon you grabbed, or everything selected with it) or out of an open group. The icon follows
   the pointer and the free slots around it show; it lands in the slot it's over. On an occupied slot, after a moment
   the icon there moves aside (and back, if you move on). Over an icon's middle: into it. On the Dock: pinned. On a
   Files window: files move into its folder. Over the group it came from: reorder it there. */

function startDrag(e, srcEl, { keys, from = null }) {
  const sx = e.clientX;
  const sy = e.clientY;
  const icons = $('#icons');
  const dock = $('#dock');
  const srcArt = artOf(srcEl) || $('.app-icon, .d-art', srcEl);
  const apps = keys.filter((k) => !isFileKey(k) && getApp(k));
  const allFiles = keys.every(isFileKey);
  const intoWhat = intoRule(keys);
  const movers = from ? [srcEl] : keys.map(tileEl).filter(Boolean);
  let ghost = null;
  let slots = null;
  let hold = null; // where in the picture it's held, at the desktop's size
  let target = null;
  let lit = null; // the icon lit up to go into
  let litWin = null;
  let slotKey = ''; // the slot it's on, and the icon moved aside from it
  let displaced = null;
  let dwell = 0;
  let intoKey = '';
  let intoTimer = 0;
  let ready = false; // INTO_AFTER has passed over intoKey

  const moveEl = (k, p) => {
    const b = tileEl(k);
    if (!b || !p) return;
    const xy = at(placed.g, p.c, p.r);
    b.style.left = `${xy.x}px`;
    b.style.top = `${xy.y}px`;
  };
  const putBack = () => {
    if (!displaced) return;
    moveEl(displaced, placed.cells.get(displaced));
    displaced = null;
  };
  const light = (b) => {
    if (lit === b) return;
    lit?.classList.remove('drop-into');
    lit = b;
    lit?.classList.add('drop-into');
  };
  const hint = (text) => {
    const h = $('.d-hint', ghost);
    h.textContent = text || '';
    h.hidden = !text;
  };

  const findTarget = (x, y) => {
    const dr = dock && !dock.hidden && $('.dock-inner', dock)?.getBoundingClientRect(); // the bar, not the full-width strip
    if (apps.length === keys.length && dr && x >= dr.left - 10 && x <= dr.right + 10 && y >= dr.top - 10 && y <= dr.bottom + 10) return { kind: 'dock' };
    const under = document.elementFromPoint(x, y);
    if (pop && pop.el.contains(under)) {
      if (from === pop.id) return { kind: 'pop' };
      if (!keys.some(isGroupKey)) return { kind: 'into', key: pop.id, what: 'group', now: true };
    }
    const win = under?.closest('.win');
    if (win) {
      const w = [...wins.values()].find((v) => v.el === win);
      const dir = allFiles && w?.files?.folder?.();
      return dir ? { kind: 'win', win, w, dir } : { kind: 'none' };
    }
    if (under?.closest('#menubar, #dock, .menu')) return { kind: 'none' };
    // The middle of the picture you're holding picks the slot.
    return aim(x - hold.x + placed.g.art / 2, y - hold.y + placed.g.art / 2, keys, intoWhat);
  };

  const show = (t) => {
    dock?.classList.toggle('drop-pin', t.kind === 'dock');
    litWin?.classList.remove('icon-drop');
    litWin = t.kind === 'win' ? t.win : null;
    litWin?.classList.add('icon-drop');
    if (pop && from) pop.el.classList.toggle('leaving', t.kind !== 'pop');

    // Into an icon: after a moment over its middle.
    if (t.kind === 'into') {
      if (intoKey !== t.key) {
        intoKey = t.key;
        ready = false;
        clearTimeout(intoTimer);
        intoTimer = setTimeout(() => {
          ready = true;
          show(target);
        }, INTO_AFTER);
      }
    } else {
      intoKey = '';
      ready = false;
      clearTimeout(intoTimer);
    }
    if (t.now) ready = true;
    const into = t.kind === 'into' && ready;
    light(into ? tileEl(t.key) : null);
    hint(t.kind === 'dock' ? 'Add to Dock' : into ? intoHint(t) : t.kind === 'win' ? 'Move here' : '');

    // A slot: lit, and after a moment whatever's in it moves aside.
    const cell = t.kind === 'slot' ? t.cell : t.kind === 'into' && !ready ? t.cell : null;
    const id = cell ? cellId(cell.c, cell.r) : '';
    if (id !== slotKey) {
      slotKey = id;
      clearTimeout(dwell);
      putBack();
      if (t.kind === 'slot' && t.occupant)
        dwell = setTimeout(() => {
          displaced = t.occupant;
          moveEl(displaced, plan(keys, cell)[displaced]);
        }, DISPLACE_AFTER);
    }
    if (into && displaced) putBack();
    slots?.aim(...ghostMid(), t.kind === 'slot' ? t.cell : null);
  };
  let last = { x: sx, y: sy };
  const ghostMid = () => [last.x - hold.x + placed.g.art / 2, last.y - hold.y + placed.g.art / 2];

  const move = (ev) => {
    const x = ev.clientX;
    const y = ev.clientY;
    last = { x, y };
    if (!ghost) {
      if (Math.hypot(x - sx, y - sy) < 6) return;
      const r = srcArt.getBoundingClientRect();
      const k = placed.g.art / (r.width || placed.g.art);
      hold = { x: Math.max(0, Math.min(r.width, sx - r.left)) * k, y: Math.max(0, Math.min(r.height, sy - r.top)) * k };
      ghost = el(`<div class="d-ghost">${srcArt.outerHTML}${keys.length > 1 ? `<b class="d-count">${keys.length}</b>` : ''}<span class="d-label">${esc($('.d-label, :scope > span:last-child', srcEl)?.textContent || '')}</span><span class="d-hint" hidden></span></div>`);
      const art = ghost.firstElementChild;
      art.style.width = art.style.height = `${placed.g.art}px`;
      art.style.fontSize = art.classList.contains('d-art') ? `${placed.g.art * 0.2}px` : `${placed.g.art}px`;
      document.body.append(ghost);
      dragging = true;
      movers.forEach((b) => b.classList.add('dragging'));
      $$('.d-icon', icons).forEach((b) => b.classList.add('shift'));
      document.body.classList.add('icon-dragging');
      slots = showSlots();
    }
    ghost.style.transform = `translate(${x - hold.x}px, ${y - hold.y}px)`;
    target = findTarget(x, y);
    // Live reorder inside the group it came from.
    if (target.kind === 'pop') {
      const near = $$('.dgp-item', pop.el)
        .filter((b) => b !== srcEl)
        .map((b) => [b, b.getBoundingClientRect()])
        .sort(([, a], [, b]) => Math.hypot(x - a.left - a.width / 2, y - a.top - a.height / 2) - Math.hypot(x - b.left - b.width / 2, y - b.top - b.height / 2))[0];
      if (near) srcEl.parentNode.insertBefore(srcEl, x < near[1].left + near[1].width / 2 ? near[0] : near[0].nextSibling);
    }
    show(target);
  };

  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('keydown', cancel, true);
    clearTimeout(dwell);
    clearTimeout(intoTimer);
    if (!ghost) return false;
    ghost.remove();
    slots?.remove();
    light(null);
    litWin?.classList.remove('icon-drop');
    dock?.classList.remove('drop-pin');
    movers.forEach((b) => b.classList.remove('dragging'));
    $$('.d-icon', icons).forEach((b) => b.classList.remove('shift'));
    document.body.classList.remove('icon-dragging');
    pop?.el.classList.remove('leaving');
    for (const host of [icons, pop?.el].filter(Boolean)) {
      host._suppressClick = true;
      setTimeout(() => (host._suppressClick = false), 0);
    }
    dragging = false;
    return true;
  };

  const up = async (ev) => {
    const ghostAt = ghost?.firstElementChild.getBoundingClientRect();
    if (!end()) return;
    const t = target || { kind: 'none' };
    // Taken out of an open group: it closes, like a folder on a phone.
    if (from && t.kind !== 'pop' && t.kind !== 'none') closeGroup();
    if (t.kind === 'dock') {
      pinToDock(apps);
      return renderIcons();
    }
    if (t.kind === 'pop') {
      const items = layout();
      const f = findGroup(items, from);
      if (f) f.apps = [...$$('.dgp-item', pop.el).map((b) => b.dataset.key), ...f.apps.filter((k) => !$(`.dgp-item[data-key="${CSS.escape(k)}"]`, pop.el))];
      return saveLayout(items);
    }
    if (t.kind === 'win') {
      const paths = keys.map(fileOf).filter(Boolean).map((f) => f.path);
      const done = await pasteFiles(paths, t.dir, !ev.ctrlKey);
      if (done.length) t.w.files.reload?.();
      return loadFiles();
    }
    if (t.kind === 'into' && ready) return putInto(keys, t.key, t.what, from);
    if ((t.kind === 'slot' || t.kind === 'into') && t.cell) {
      moveTo(keys, t.cell, from);
      // Settle from where you let go into its slot.
      const b = tileEl(keys[0]);
      const art = artOf(b)?.getBoundingClientRect();
      if (art) artOf(b).animate([{ transform: `translate(${ghostAt.left - art.left}px, ${ghostAt.top - art.top}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.3,1)' });
      return;
    }
    renderIcons(); // back where it was
  };

  const cancel = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    end();
    if (pop) renderPop();
    renderIcons();
  };

  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('keydown', cancel, true);
}

/* ---------------- Files dragged in (from Files, or another program) ---------------- */

function initFileDrops() {
  if (!filesOK) return;
  const desktop = $('#desktop');
  let ext = null; // { slots, target, lit }
  const accepts = (dt) => dt && (dt.types.includes(FILES_DRAG) || dt.types.includes('Files'));
  const stop = () => {
    if (!ext) return;
    ext.slots.remove();
    ext.lit?.classList.remove('drop-into');
    ext = null;
  };
  desktop.addEventListener('dragover', (e) => {
    if (!accepts(e.dataTransfer) || e.target.closest('#widgets') || !placed) return;
    e.preventDefault();
    const own = e.dataTransfer.types.includes(FILES_DRAG);
    e.dataTransfer.dropEffect = own && !e.ctrlKey ? 'move' : 'copy';
    ext ||= { slots: showSlots(), target: null, lit: null };
    // Into a group, or a folder; otherwise a slot.
    const t = aim(e.clientX, e.clientY, [], (k) => (isGroupKey(k) ? 'group' : fileOf(k)?.dir ? 'folder' : null));
    ext.target = t;
    const lit = t.kind === 'into' ? tileEl(t.key) : null;
    if (lit !== ext.lit) {
      ext.lit?.classList.remove('drop-into');
      lit?.classList.add('drop-into');
      ext.lit = lit;
    }
    ext.slots.aim(e.clientX, e.clientY, t.kind === 'slot' ? t.cell : null);
  });
  desktop.addEventListener('dragleave', (e) => !desktop.contains(e.relatedTarget) && stop());
  addEventListener('dragend', stop);
  desktop.addEventListener('drop', async (e) => {
    if (!accepts(e.dataTransfer) || !ext) return stop();
    e.preventDefault();
    const t = ext.target;
    stop();
    const raw = e.dataTransfer.getData(FILES_DRAG);
    let paths = [];
    try {
      paths = raw ? JSON.parse(raw) : [...e.dataTransfer.files].map((f) => shell.files.pathForFile?.(f)).filter(Boolean);
    } catch {}
    if (!paths.length) return;
    // From Files they move (Ctrl copies); from other programs they're copied.
    const move = !!raw && !e.ctrlKey;
    if (t?.kind === 'into' && t.what === 'folder') {
      const dir = fileOf(t.key);
      if (dir && (await pasteFiles(paths, dir.path, move)).length) toast(`${move ? 'Moved' : 'Copied'} to ${dir.name}`);
      return loadFiles();
    }
    await loadFiles({ create: true });
    const done = await pasteFiles(paths, deskDir, move);
    await loadFiles();
    const keys = done.map(fileKey).filter((k) => placed.cells.has(k));
    if (!keys.length) return;
    if (t?.kind === 'into') return putInto(keys, t.key, 'group');
    if (t?.cell) moveTo(keys, t.cell);
  });
}

/* ---------------- Selecting ----------------
   Click selects an icon; Ctrl+click adds or removes one; Shift+click selects a run of them (down the columns); dragging
   on an empty part of the desktop draws a box around several. Arrow keys move the selection, Enter opens. */

const sel = new Set(); // selected icons' keys
let anchorKey = null; // where a Shift+click run starts
const iconEls = () => $$('#icons .d-icon');
const paintSel = () => iconEls().forEach((b) => b.classList.toggle('sel', sel.has(b.dataset.key)));
function selectOnly(key) {
  sel.clear();
  if (key) sel.add(key);
  anchorKey = key || null;
  paintSel();
}
function clickSelect(b, e) {
  const key = b.dataset.key;
  if (e.shiftKey && anchorKey) {
    const keys = iconEls().map((x) => x.dataset.key);
    const [a, z] = [keys.indexOf(anchorKey), keys.indexOf(key)].sort((p, q) => p - q);
    if (!e.ctrlKey) sel.clear();
    if (a >= 0) keys.slice(a, z + 1).forEach((k) => sel.add(k));
  } else if (e.ctrlKey || e.metaKey) {
    sel.has(key) ? sel.delete(key) : sel.add(key);
    anchorKey = key;
  } else if (!sel.has(key)) return selectOnly(key);
  paintSel();
}

/** Drag a box on the empty desktop to select the icons it touches (Ctrl adds to what's selected). */
function startBand(e) {
  const sx = e.clientX;
  const sy = e.clientY;
  const keep = e.ctrlKey || e.metaKey ? new Set(sel) : new Set();
  let band = null;
  const move = (ev) => {
    if (!band) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      band = document.body.appendChild(el('<div class="d-band"></div>'));
    }
    const r = { left: Math.min(sx, ev.clientX), top: Math.min(sy, ev.clientY), right: Math.max(sx, ev.clientX), bottom: Math.max(sy, ev.clientY) };
    Object.assign(band.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    sel.clear();
    keep.forEach((k) => sel.add(k));
    for (const b of iconEls()) {
      const a = artOf(b).getBoundingClientRect();
      if (a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top) sel.add(b.dataset.key);
    }
    paintSel();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    band?.remove();
    if (!band && !keep.size) selectOnly(null); // a plain click on the desktop clears the selection
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** Arrow keys: the nearest icon that way. */
function arrowSelect(from, dir) {
  const a = from.getBoundingClientRect();
  let best = null;
  for (const b of iconEls()) {
    if (b === from) continue;
    const r = b.getBoundingClientRect();
    const dx = r.left + r.width / 2 - (a.left + a.width / 2);
    const dy = r.top + r.height / 2 - (a.top + a.height / 2);
    const ok = { ArrowLeft: dx < -4 && Math.abs(dy) < r.height, ArrowRight: dx > 4 && Math.abs(dy) < r.height, ArrowUp: dy < -4 && Math.abs(dx) < r.width, ArrowDown: dy > 4 && Math.abs(dx) < r.width }[dir];
    const d = Math.hypot(dx, dy);
    if (ok && (!best || d < best.d)) best = { b, d };
  }
  if (!best) return;
  selectOnly(best.b.dataset.key);
  best.b.focus();
}

/* ---------------- Menus ---------------- */

function fileMenuItems(k, x, y) {
  const f = fileOf(k);
  if (!f) return [];
  return [
    { label: 'Open', key: 'Enter', act: () => openFile(f) },
    !f.dir && { label: 'Open With…', act: () => openWithMenu(f, x, y) },
    !f.dir && PRINTS.has(f.kind) && {
      label: 'Print…',
      act: async () => {
        const problem = await shell.print.file(f.path).catch(errText);
        if (problem) toast(problem, 'error');
      },
    },
    { label: 'Show in Files', act: () => openApp('files', { reveal: f.path }) },
    f.dir && { label: 'Open in Terminal', act: () => openApp('terminal', { cwd: f.path }) },
    '-',
    { label: 'Rename…', key: 'F2', act: () => renameFile(k) },
    { label: 'Copy Location', act: () => shell.files.copyPath([f.path]).then(() => toast('Location copied')) },
    { label: 'Move to Trash', key: 'Delete', act: () => trashFiles([k]) },
  ];
}

/** New folder in the Desktop folder, in a slot, named as you go. */
async function newFolder(cell) {
  try {
    await loadFiles({ create: true });
    const p = await shell.files.mkdir(deskDir, 'New folder');
    const name = p.split('/').pop();
    deskFiles.set(name, { name, path: p, dir: true, kind: 'folder', size: null, mtime: Date.now() });
    renderIcons();
    const k = fileKey(p);
    if (cell) moveTo([k], cell);
    selectOnly(k);
    renameFile(k);
  } catch (x) {
    toast(errText(x), 'error');
  }
}

/** The slot under a point on the desktop, if it's in the icons' area. */
function cellUnder(x, y) {
  const br = $('#icons').getBoundingClientRect();
  if (!placed || x < br.left || x > br.right || y < br.top || y > br.bottom) return null;
  const g = placed.g;
  const used = new Set([...placed.cells.values()].map((p) => cellId(p.c, p.r)));
  const c = cellAt(g, x - br.left, y - br.top);
  return nearestFree(g, c.c, c.r, (cc, rr) => !used.has(cellId(cc, rr)) && !g.blocked.has(cellId(cc, rr)));
}

/** Sort by name: everything finds a slot again, in name order, groups, apps and files together. */
function sortByName() {
  const items = layout();
  const name = (e) => (isGroup(e) ? e.name : fileOf(e)?.name || getApp(e)?.name || e);
  saveLayout(
    [...items].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base', numeric: true })),
    Object.fromEntries(items.map((e) => [keyOf(e), null])),
  );
}

/* ---------------- Setup ---------------- */

export function initDesktop({ desktopMenu }) {
  const icons = $('#icons');

  icons.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const b = e.target.closest('.d-icon');
    if (!b) return;
    clickSelect(b, e);
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = b.dataset.key;
    const keys = sel.has(k) && sel.size > 1 ? [k, ...iconEls().map((x) => x.dataset.key).filter((x) => x !== k && sel.has(x))] : [k];
    startDrag(e, b, { keys });
  });
  icons.addEventListener('click', (e) => {
    const b = e.target.closest('.d-icon');
    if (!b || icons._suppressClick || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // A plain click on one of several selected icons selects just that one.
    if (sel.size > 1) selectOnly(b.dataset.key);
    // Groups open with one click (like a folder on a phone); apps and files with a double-click.
    if (b.dataset.group) pop?.id === b.dataset.group ? closeGroup() : openGroup(b.dataset.group);
  });
  icons.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.d-icon');
    if (b && !b.dataset.group) openKey(b.dataset.key);
  });
  icons.addEventListener('keydown', (e) => {
    const b = e.target.closest('.d-icon');
    if (!b) return;
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      return arrowSelect(b, e.key);
    }
    const keys = sel.size > 1 ? [...sel] : [b.dataset.key];
    if (e.key === 'Enter') {
      if (b.dataset.group) openGroup(b.dataset.group);
      else keys.forEach((k) => !isGroupKey(k) && openKey(k));
    }
    if (e.key === 'F2') b.dataset.group ? openGroup(b.dataset.group, { rename: true }) : b.dataset.file && renameFile(b.dataset.key);
    if (e.key === 'Delete' && keys.some(isFileKey)) trashFiles(keys.filter(isFileKey));
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      iconEls().forEach((x) => sel.add(x.dataset.key));
      paintSel();
    }
  });
  addEventListener('keydown', (e) => e.key === 'Escape' && pop && closeGroup());

  $('#desktop').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.win, textarea, input')) return;
    e.preventDefault();
    const b = e.target.closest('.d-icon');
    if (b && !sel.has(b.dataset.key)) selectOnly(b.dataset.key);
    if (b && sel.size > 1) {
      const keys = [...sel];
      const apps = keys.filter((k) => !isFileKey(k) && getApp(k));
      const files = keys.filter(isFileKey);
      return showMenu(e.clientX, e.clientY, [
        { header: `${sel.size} items` },
        { label: 'Open', act: () => keys.forEach((k) => !isGroupKey(k) && openKey(k)) },
        apps.length && { label: 'Add to Dock', act: () => (pinToDock(apps), renderIcons()) },
        !keys.some(isGroupKey) && { label: 'New Group with These', act: () => newGroup(keys) },
        files.length && '-',
        files.length && { label: files.length === keys.length ? 'Move to Trash' : `Move ${files.length} File${files.length === 1 ? '' : 's'} to Trash`, act: () => trashFiles(files) },
      ]);
    }
    if (b?.dataset.group) {
      const id = b.dataset.group;
      return showMenu(e.clientX, e.clientY, [
        { header: findGroup(layout(), id)?.name || 'Group' },
        { label: 'Open', act: () => openGroup(id) },
        { label: 'Rename…', key: 'F2', act: () => openGroup(id, { rename: true }) },
        { label: 'Color…', act: () => groupColor(id, e.clientX, e.clientY) },
        '-',
        { label: 'Ungroup', act: () => ungroup(id) },
      ]);
    }
    if (b) {
      const k = b.dataset.key;
      const items = b.dataset.file ? fileMenuItems(k, e.clientX, e.clientY) : appMenuItems(k);
      items.push('-', { label: 'New Group with This', act: () => newGroup([k]) });
      if (!b.dataset.file) items.push({ label: 'Remove from Desktop', act: () => setOnDesktop(k, false) });
      if (k.startsWith('link:')) items.push({ label: 'Edit Connection…', act: () => openApp('connections', { record: k.slice(5) }) });
      return showMenu(e.clientX, e.clientY, items);
    }
    const p = store.prefs;
    const cell = cellUnder(e.clientX, e.clientY);
    showMenu(e.clientX, e.clientY, [
      ...desktopMenu({ x: e.clientX, y: e.clientY }),
      '-',
      { label: 'New Group', act: () => newGroup([], cell) },
      filesOK && { label: 'New Folder', act: () => newFolder(cell) },
      filesOK && { label: 'Open Desktop Folder', act: async () => (await loadFiles({ create: true }), openApp('files', { open: deskDir })) },
      '-',
      { label: 'Sort by Name', act: sortByName },
      { label: 'Reset Icon Arrangement', disabled: !p.desktopLayout?.length && !Object.keys(p.desktopPos || {}).length, act: () => (store.setPrefs({ desktopLayout: [], desktopPos: {} }), renderIcons()) },
      { label: 'Show Desktop Icons', checked: !p.hideIcons, act: () => store.setPrefs({ hideIcons: !p.hideIcons }) },
      { label: 'Desktop Settings…', act: () => openApp('settings', { tab: 'desktop' }) },
    ]);
  });
  // A box drawn from anywhere on the empty desktop (not on widgets or windows) selects icons.
  $('#desktop').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.d-icon, .widget, #widgets, .win, button, input, textarea')) return;
    startBand(e);
  });

  // The grid follows the screen.
  let queued = false;
  const again = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderIcons();
    });
  };
  addEventListener('resize', again);
  addEventListener('screens', again);
  // Widgets: no icons under them, so their slots change when they do.
  addEventListener('widgets-placed', again);

  initFileDrops();
  if (filesOK) {
    shell.on('files:changed', ({ dir } = {}) => dir === watching && loadFiles());
    loadFiles();
  }
}
