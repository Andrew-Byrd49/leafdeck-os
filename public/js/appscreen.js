// The app screen, like Android's home screen and app drawer in one: opened with the Windows (Super) key on its own
// (electron/main.cjs) or Go → All Apps. Across the top, the time and date, a search box and the controls; below, your
// widgets (a widget board of its own, widgets.js, saved as prefs.appScreenWidgets) and every app: the ones you've used
// lately, then the rest in categories (Work, Create, Internet…), or all together. It stays up until you open something, press Esc or the Windows key, or click on another screen.
//
// Customize (prefs.appScreen): categories or all together; sorted by name, by use, by when you last used them or in
// your own order (drag an app to arrange; drag it to another category to move it there); icon size; the Recent row and
// the widgets on or off, widgets on either side; categories of your own, renamed, hidden or rearranged (drag a card by
// its title); apps hidden from here. An app's menu also puts it on the desktop (desktop.js) or in the Dock.

import { $, $$, esc, el, uid } from './util.js';
import { icon, appIcon } from './icons.js';
import { registry, getApp, openApp, recentWindows, showMenu, appMenuItems, onWM, wins, toast } from './wm.js';
import { store } from './store.js';
import { linkAppId } from './apps/system.js';
import { mountWidgetBoard, widgetEditing, enterWidgetEdit, exitWidgetEdit, openWidgetGallery, widgetGalleryOpen } from './widgets.js';
import { onDesktop, setOnDesktop } from './desktop.js';
import { ask, confirmDialog } from './dialogs.js';

let root = null;
let sel = -1;
let clockTimer = 0;
let justDragged = false;

export const appScreenOpen = () => !!root;
export const toggleAppScreen = () => (root ? closeAppScreen() : openAppScreen());

/* ---------------- Settings ---------------- */

const DEFAULTS = { view: 'categories', sort: 'name', iconSize: 'm', recent: true, widgets: true, widgetsSide: 'left' };
const prefs = () => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(store.prefs.appScreen || {}).filter(([, v]) => v != null)) });
function setPrefs(patch) {
  store.setPrefs({ appScreen: { ...(store.prefs.appScreen || {}), ...patch } });
  redraw();
}

/* How often you open each app (on this computer): for Sort by Most Used. Counted when a window opens. */
const USES = 'ws:app-uses';
const uses = (() => {
  try {
    return JSON.parse(localStorage.getItem(USES)) || {};
  } catch {
    return {};
  }
})();
function countUse(id) {
  uses[id] = (uses[id] || 0) + 1;
  try {
    localStorage.setItem(USES, JSON.stringify(uses));
  } catch {}
}
let known = null; // the windows open after start-up settled; the ones restored at start aren't counted
setTimeout(() => (known = new Set(wins.keys())), 5000);
onWM(() => {
  if (!known) return;
  for (const id of wins.keys()) if (!known.has(id)) countUse(id);
  known = new Set(wins.keys());
});

/* ---------------- Categories ---------------- */

// [key, title, icon, Leafdeck app ids]. Apps not listed land in Other; user apps in Your apps; connections in theirs.
const CATEGORIES = [
  ['work', 'Work', 'check', ['tasks', 'calendar', 'notes', 'contacts', 'layouts']],
  ['create', 'Create', 'pen', ['designer', 'siteeditor', 'appbuilder', 'editor', 'viewer', 'imageeditor']],
  ['internet', 'Internet', 'globe', ['bookmarks', 'history', 'downloads', 'passwords', 'connections']],
  ['yours', 'Your apps', 'sparkle', []],
  ['links', 'Connections', 'link', []],
  ['develop', 'Developer', 'code', ['terminal', 'claudecode', 'devtools']],
  ['system', 'System', 'sliders', ['settings', 'claudesettings', 'files', 'taskmanager', 'appstore']],
  ['other', 'Other', 'dots', []],
];
const OF_ID = new Map(CATEGORIES.flatMap(([key, , , ids]) => ids.map((id) => [id, key])));

/** Every category, built-in and your own, in your order: { key, name, icon, custom, hidden }. */
function categories(p = prefs()) {
  const all = [
    ...CATEGORIES.map(([key, name, ic]) => ({ key, name, icon: ic, custom: false })),
    ...(p.cats || []).map((c) => ({ key: c.key, name: c.name, icon: c.icon || 'folder', custom: true })),
  ].map((c) => ({ ...c, name: p.catNames?.[c.key] || c.name, hidden: (p.hiddenCats || []).includes(c.key) }));
  const order = p.catOrder || [];
  const at = (c) => (order.includes(c.key) ? order.indexOf(c.key) : order.length + all.indexOf(c));
  return all.sort((a, b) => at(a) - at(b));
}

function defaultCategory(a) {
  if (a.isLink) return 'links';
  if (a.userApp) return 'yours';
  return OF_ID.get(a.id) || 'other';
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Apps in the order the Sort setting asks for; `key` is the group whose own order Your Order uses. */
function sorted(list, p, key) {
  const recent = recentWindows().map((r) => r.id);
  const rec = (a) => (recent.includes(a.id) ? recent.indexOf(a.id) : Infinity);
  const own = p.order?.[key] || [];
  const mine = (a) => (own.includes(a.id) ? own.indexOf(a.id) : Infinity);
  const how = {
    name: byName,
    used: (a, b) => (uses[b.id] || 0) - (uses[a.id] || 0) || byName(a, b),
    recent: (a, b) => rec(a) - rec(b) || byName(a, b),
    custom: (a, b) => mine(a) - mine(b) || byName(a, b),
  }[p.sort] || byName;
  return [...list].sort(how);
}

function lists(p = prefs()) {
  const links = store.all('links').map((l) => getApp(linkAppId(l))).filter(Boolean);
  const own = [...[...registry.values()].filter((a) => !a.hidden), ...links];
  const hidden = new Set(p.hiddenApps || []);
  const apps = own.filter((a) => !hidden.has(a.id));
  const cats = categories(p);
  const keys = new Set(cats.map((c) => c.key));
  const groups = new Map(cats.map((c) => [c.key, []]));
  for (const a of apps) {
    const mine = p.appCat?.[a.id];
    groups.get(mine && keys.has(mine) ? mine : defaultCategory(a)).push(a);
  }
  for (const [key, g] of groups) groups.set(key, sorted(g, p, key));
  // The apps behind the windows you've had open lately, newest first, once per name (not pages: they come and go).
  const seen = new Set();
  const recent = [];
  for (const r of recentWindows()) {
    const a = !r.url && getApp(r.id);
    if (!a || a.hidden || hidden.has(a.id) || seen.has(a.name.toLowerCase())) continue;
    seen.add(a.name.toLowerCase());
    recent.push(a);
    if (recent.length === 10) break;
  }
  return { cats, groups, recent, all: sorted(apps, p, '_all'), count: apps.length };
}

/* ---------------- Drawing ---------------- */

const tile = (a) => `<button class="as-app" data-id="${esc(a.id)}" data-text="${esc(`${a.name} ${a.comment || ''}`.toLowerCase())}" title="${esc(a.comment ? `${a.name} — ${a.comment}` : a.name)}">
    ${appIcon(a)}<span class="as-name">${esc(a.name)}</span></button>`;

const card = (c, items) =>
  `<section class="as-section as-cat" data-cat="${esc(c.key)}" style="--n:${Math.max(2, Math.min(5, items.length))}">
    <h4 title="Drag to move this category; right-click for more">${icon(c.icon, 14)}<span>${esc(c.name)}</span><em>${items.length || ''}</em></h4>
    <div class="as-grid">${items.map(tile).join('')}${items.length ? '' : '<div class="as-empty">Drag apps here</div>'}</div></section>`;

function drawApps() {
  const p = prefs();
  const { cats, groups, recent, all, count } = lists(p);
  root.className = `as-size-${p.iconSize} ${p.widgets ? '' : 'no-widgets'} ${p.widgetsSide === 'right' ? 'widgets-right' : ''} ${root.classList.contains('closing') ? 'closing' : ''}`;
  $('.as-search input', root).placeholder = `Search ${count} apps`;
  $$('[data-as=add], [data-as=edit]', root).forEach((b) => (b.hidden = !p.widgets));
  const cards =
    p.view === 'all'
      ? card({ key: '_all', name: 'All apps', icon: 'grid' }, all)
      : cats
          .filter((c) => !c.hidden && (groups.get(c.key).length || c.custom))
          .map((c) => card(c, groups.get(c.key)))
          .join('');
  $('.as-apps', root).innerHTML = `
    ${p.recent && recent.length >= 2 ? `<section class="as-section as-recent"><h4>${icon('clock', 14)}<span>Recent</span></h4><div class="as-strip">${recent.map(tile).join('')}</div></section>` : ''}
    <div class="as-cats ${p.view === 'all' ? 'as-one' : ''}">${cards}</div>
    <div class="as-none" hidden>No apps match</div>`;
  if ($('.as-search input', root).value.trim()) filter();
  else sel = -1;
}

/** Settings changed while it's open (here, or Settings in another window): draw again, keeping your place. */
function redraw() {
  if (!root) return;
  const scroll = $('.as-apps', root).scrollTop;
  drawApps();
  $('.as-apps', root).scrollTop = scroll;
}

export function openAppScreen() {
  if (root) return;
  root = el(`<div id="appscreen" role="dialog" aria-label="Apps">
    <div class="as-sheet">
      <div class="as-head">
        <div class="as-clock"><b class="as-time"></b><span class="as-date"></span></div>
        <label class="as-search">${icon('search', 16)}<input autocomplete="off" spellcheck="false" aria-label="Search apps"></label>
        <div class="as-tools">
          <button class="btn small" data-as="add">${icon('plus', 12)} Add Widget</button>
          <button class="btn small" data-as="edit">Edit Widgets</button>
          <button class="btn small" data-as="customize">${icon('sliders', 12)} Customize</button>
          <button class="tb-btn as-close" data-as="close" title="Close (Esc)" aria-label="Close">${icon('x', 15)}</button>
        </div>
      </div>
      <div class="as-main">
        <aside class="as-side"><div class="as-widgets"></div></aside>
        <div class="as-apps"></div>
      </div>
    </div>
  </div>`);
  document.body.append(root);
  drawApps();
  const board = $('.as-widgets', root);
  mountWidgetBoard(board, 'apps');
  // Edit mode starts and ends in widgets.js too (a widget's menu, Esc): the button follows it.
  new MutationObserver(syncTools).observe(board, { attributes: true, attributeFilter: ['class'] });
  tick();
  clockTimer = setInterval(tick, 10_000);
  const input = $('input', root);
  setTimeout(() => input.focus(), 20);
  input.addEventListener('input', filter);
  root.addEventListener('keydown', onKey);
  root.addEventListener('click', onClick);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('pointerdown', onPointerDown);
  addEventListener('pointerdown', onElsewhere, true);
  syncTools();
}

export function closeAppScreen() {
  if (!root) return;
  if (widgetEditing() === 'apps') exitWidgetEdit();
  clearInterval(clockTimer);
  removeEventListener('pointerdown', onElsewhere, true);
  const r = root;
  root = null;
  r.classList.add('closing');
  setTimeout(() => r.remove(), 140);
}

/** It covers the main screen; a click on another screen (outside it) puts it away. */
function onElsewhere(e) {
  if (!root || e.target.closest?.('.menu, #widget-gallery, .sheet-wrap')) return;
  const r = root.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) closeAppScreen();
}

function onClick(e) {
  if (justDragged) return;
  const b = e.target.closest('.as-app');
  if (b) return launch(b.dataset.id);
  const tool = e.target.closest('[data-as]');
  if (tool?.dataset.as === 'add') return openWidgetGallery('apps');
  if (tool?.dataset.as === 'edit') return widgetEditing() === 'apps' ? exitWidgetEdit() : enterWidgetEdit('apps');
  if (tool?.dataset.as === 'customize') {
    const r = tool.getBoundingClientRect();
    return showMenu(r.right, r.bottom + 6, customizeItems(), { flipTo: r.left });
  }
  if (tool?.dataset.as === 'close') return closeAppScreen();
  // A click on the empty background ends widget editing (it doesn't close the screen).
  if (widgetEditing() === 'apps' && !e.target.closest('.as-widgets, .as-head')) exitWidgetEdit();
}

/** The Edit Widgets button reads Done while you're editing. */
function syncTools() {
  if (!root) return;
  const edit = $('[data-as="edit"]', root);
  const on = widgetEditing() === 'apps';
  edit.textContent = on ? 'Done' : 'Edit Widgets';
  edit.classList.toggle('primary', on);
}

function tick() {
  if (!root) return;
  const now = new Date();
  $('.as-time', root).textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('.as-date', root).textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function launch(id) {
  closeAppScreen();
  const a = getApp(id);
  if (!a) return;
  openApp(id);
}

/* ---------------- Menus ---------------- */

const SORTS = [['name', 'Name'], ['used', 'Most Used'], ['recent', 'Recently Used'], ['custom', 'Your Order (drag to arrange)']];
const SIZES = [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']];

function customizeItems() {
  const p = prefs();
  const hiddenApps = (p.hiddenApps || []).map(getApp).filter(Boolean);
  const hiddenCats = categories(p).filter((c) => c.hidden);
  return [
    { header: 'Show apps' },
    { label: 'In Categories', checked: p.view === 'categories', act: () => setPrefs({ view: 'categories' }) },
    { label: 'All Together', checked: p.view === 'all', act: () => setPrefs({ view: 'all' }) },
    '-',
    { header: 'Sort by' },
    ...SORTS.map(([v, label]) => ({ label, checked: p.sort === v, act: () => setPrefs({ sort: v }) })),
    '-',
    { header: 'Icon size' },
    ...SIZES.map(([v, label]) => ({ label, checked: p.iconSize === v, act: () => setPrefs({ iconSize: v }) })),
    '-',
    { label: 'Recent Apps', checked: p.recent, act: () => setPrefs({ recent: !p.recent }) },
    { label: 'Widgets', checked: p.widgets, act: () => (widgetEditing() === 'apps' && exitWidgetEdit(), setPrefs({ widgets: !p.widgets })) },
    { label: 'Widgets on the Right', checked: p.widgetsSide === 'right', disabled: !p.widgets, act: () => setPrefs({ widgetsSide: p.widgetsSide === 'right' ? 'left' : 'right' }) },
    '-',
    { label: 'New Category…', act: () => newCategory() },
    { label: `Hidden Apps${hiddenApps.length ? ` (${hiddenApps.length})` : ''}…`, disabled: !hiddenApps.length, act: () => showHidden('apps', hiddenApps) },
    { label: `Hidden Categories${hiddenCats.length ? ` (${hiddenCats.length})` : ''}…`, disabled: !hiddenCats.length, act: () => showHidden('cats', hiddenCats) },
    '-',
    { label: 'Reset App Screen…', act: reset },
  ];
}

/** A menu of what's hidden; picking one shows it again. */
function showHidden(kind, list) {
  const r = $('[data-as=customize]', root).getBoundingClientRect();
  const p = prefs();
  showMenu(r.right, r.bottom + 6, [
    { header: kind === 'apps' ? 'Show again' : 'Show category again' },
    ...list.map((x) => ({
      label: x.name,
      act: () => setPrefs(kind === 'apps' ? { hiddenApps: p.hiddenApps.filter((id) => id !== x.id) } : { hiddenCats: p.hiddenCats.filter((k) => k !== x.key) }),
    })),
  ], { flipTo: r.left });
}

async function reset() {
  const ok = await confirmDialog('Reset the app screen?', { detail: 'Categories, sorting, hidden apps and sizes go back to how they started. Your widgets stay.', ok: 'Reset' });
  if (!ok) return;
  store.setPrefs({ appScreen: {} });
  redraw();
}

async function nameDialog(title, value = '') {
  const r = await ask({ title, fields: [{ name: 'name', label: 'Name', value }], buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
  return r?.button === 'ok' ? r.values.name.trim() : '';
}

/** Make a category of your own (after the others). Resolves to its key, or '' when you cancel. `app` goes in it. */
async function newCategory(app = '') {
  const name = await nameDialog('New category');
  if (!name) return '';
  const p = prefs();
  const key = 'c-' + uid();
  const patch = { cats: [...(p.cats || []), { key, name, icon: 'folder' }], catOrder: [...categories(p).map((c) => c.key), key] };
  if (app) patch.appCat = { ...(p.appCat || {}), [app]: key };
  setPrefs(patch);
  if (!app) toast(`Added ${name}: drag apps into it, or use an app's Move to Category`);
  return key;
}

function categoryItems(key) {
  const p = prefs();
  const c = categories(p).find((x) => x.key === key);
  if (!c) return [];
  return [
    { header: c.name },
    { label: 'Rename…', act: async () => {
      const name = await nameDialog('Rename category', c.name);
      if (name) setPrefs({ catNames: { ...(p.catNames || {}), [key]: name } });
    } },
    { label: 'Hide Category', act: () => setPrefs({ hiddenCats: [...(p.hiddenCats || []), key] }) },
    c.custom && { label: 'Delete Category', act: () => {
      // Its apps go back to the categories they started in.
      const appCat = Object.fromEntries(Object.entries(p.appCat || {}).filter(([, k]) => k !== key));
      setPrefs({ cats: p.cats.filter((x) => x.key !== key), appCat });
    } },
    '-',
    { label: 'New Category…', act: () => newCategory() },
  ];
}

function appItems(id, x, y) {
  const a = getApp(id);
  const p = prefs();
  const base = appMenuItems(id);
  // Opening something puts the app screen away; the rest (Dock, window options) keep it up.
  base[1] = { ...base[1], act: () => launch(id) };
  const desk = onDesktop(id);
  const mine = [
    { label: 'On Desktop', checked: desk, act: () => (setOnDesktop(id, !desk), toast(desk ? `Removed ${a.name} from the desktop` : `Added ${a.name} to the desktop`)) },
    p.view === 'categories' && { label: 'Move to Category…', act: () => showMenu(x, y, moveItems(id)) },
    { label: 'Hide from App Screen', act: () => setPrefs({ hiddenApps: [...(p.hiddenApps || []), id] }) },
  ];
  const dock = base.findIndex((it) => it?.label === 'Keep in Dock');
  base.splice(dock < 0 ? base.length : dock + 1, 0, ...mine);
  return base;
}

function moveItems(id) {
  const p = prefs();
  const a = getApp(id);
  const cur = p.appCat?.[id] || defaultCategory(a);
  return [
    { header: `Move ${a.name} to` },
    ...categories(p).filter((c) => !c.hidden).map((c) => ({ label: c.name, checked: c.key === cur, act: () => moveTo(id, c.key) })),
    '-',
    { label: 'New Category…', act: () => newCategory(id) },
  ];
}

/** Put an app in a category (its own one again clears the choice). */
function moveTo(id, key) {
  const p = prefs();
  const appCat = { ...(p.appCat || {}) };
  if (key === defaultCategory(getApp(id))) delete appCat[id];
  else appCat[id] = key;
  setPrefs({ appCat });
}

function onContextMenu(e) {
  const b = e.target.closest('.as-app');
  const h = e.target.closest('.as-cat h4');
  if (!b && !h) return;
  e.preventDefault();
  if (b) return showMenu(e.clientX, e.clientY, appItems(b.dataset.id, e.clientX, e.clientY));
  const key = h.closest('.as-cat').dataset.cat;
  if (key !== '_all') showMenu(e.clientX, e.clientY, categoryItems(key));
}

/* ---------------- Dragging: apps within and between categories, categories by their title ---------------- */

function onPointerDown(e) {
  if (e.button !== 0 || root.classList.contains('searching')) return;
  const tileEl = e.target.closest('.as-cats .as-app');
  const head = !tileEl && e.target.closest('.as-cats .as-cat h4');
  const node = tileEl || head?.closest('.as-cat');
  if (!node || node.dataset.cat === '_all') return;
  const sx = e.clientX;
  const sy = e.clientY;
  let ghost = null;
  let scroller = 0;
  const apps = $('.as-apps', root);
  const from = node.closest('.as-cat')?.dataset.cat;
  const before = $$('.as-cats .as-app', root).map((b) => b.dataset.id).join();
  const beforeCats = $$('.as-cat', root).map((c) => c.dataset.cat).join();
  let last = { x: sx, y: sy };

  const place = (x, y) => {
    ghost.style.translate = `${x - sx}px ${y - sy}px`;
    const under = document.elementFromPoint(x, y);
    if (tileEl) {
      const over = under?.closest('.as-cats .as-app');
      if (over && over !== node) {
        const r = over.getBoundingClientRect();
        over.parentElement.insertBefore(node, x < r.left + r.width / 2 ? over : over.nextSibling);
      } else if (!over) {
        const grid = under?.closest('.as-cat')?.querySelector('.as-grid');
        if (grid && node.parentElement !== grid) grid.insertBefore(node, $('.as-empty', grid));
      }
      $$('.as-cat', root).forEach((c) => c.classList.toggle('drop-into', c.contains(node) && c.dataset.cat !== from));
    } else {
      const over = under?.closest('.as-cat');
      if (over && over !== node && over.parentElement === node.parentElement) {
        const r = over.getBoundingClientRect();
        node.parentElement.insertBefore(node, x < r.left + r.width / 2 ? over : over.nextSibling);
      }
    }
  };
  // Near the top or bottom of the apps, they scroll while you hold the app there.
  const edgeScroll = () => {
    const r = apps.getBoundingClientRect();
    const d = last.y < r.top + 50 ? -14 : last.y > r.bottom - 50 ? 14 : 0;
    if (d) {
      apps.scrollTop += d;
      place(last.x, last.y);
    }
  };
  const move = (ev) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      const r = node.getBoundingClientRect();
      ghost = node.cloneNode(true);
      ghost.classList.add('as-ghost');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      root.append(ghost);
      node.classList.add('as-dragging');
      root.classList.add('dragging');
      scroller = setInterval(edgeScroll, 30);
    }
    place(ev.clientX, ev.clientY);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (!ghost) return;
    clearInterval(scroller);
    ghost.remove();
    node.classList.remove('as-dragging');
    root.classList.remove('dragging');
    $$('.as-cat.drop-into', root).forEach((c) => c.classList.remove('drop-into'));
    justDragged = true;
    setTimeout(() => (justDragged = false));
    if (tileEl) dropApp(node, from, before);
    else if ($$('.as-cat', root).map((c) => c.dataset.cat).join() !== beforeCats) setPrefs({ catOrder: $$('.as-cat', root).map((c) => c.dataset.cat) });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** An app was dropped: into another category moves it there; a new place in the order switches to Your Order. */
function dropApp(node, from, before) {
  const p = prefs();
  const id = node.dataset.id;
  const to = node.closest('.as-cat')?.dataset.cat;
  const patch = {};
  if (to && to !== from) {
    const appCat = { ...(p.appCat || {}) };
    if (to === defaultCategory(getApp(id))) delete appCat[id];
    else appCat[id] = to;
    patch.appCat = appCat;
  }
  const after = $$('.as-cats .as-app', root).map((b) => b.dataset.id).join();
  // Within a category it's a new order; into another one it only moves there (unless you sort in your own order).
  const reordered = after !== before && (to === from || p.sort === 'custom');
  if (reordered) {
    // Your Order keeps every category's order as it is on screen now.
    const order = { ...(p.order || {}) };
    for (const c of $$('.as-cat', root)) order[c.dataset.cat] = $$('.as-app', c).map((b) => b.dataset.id);
    patch.order = order;
    if (p.sort !== 'custom') {
      patch.sort = 'custom';
      toast('Sorting apps in your order now (Customize → Sort by to change)');
    }
  }
  if (Object.keys(patch).length) setPrefs(patch);
  else redraw();
}

/* ---------------- Search and keys ---------------- */

const rank = (b, q) => (!q ? 0 : b.dataset.text.startsWith(q) ? 0 : b.dataset.text.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2);

/** Searching shows the matching apps in their categories, the best matches first; the Recent row steps aside. */
function filter() {
  const q = $('input', root).value.trim().toLowerCase();
  if (!q && root.classList.contains('searching')) {
    root.classList.remove('searching');
    return drawApps(); // back to your arrangement
  }
  root.classList.toggle('searching', !!q);
  for (const s of $$('.as-section', root)) {
    let any = false;
    for (const b of $$('.as-app', s)) {
      b.hidden = !!q && !b.dataset.text.includes(q);
      any ||= !b.hidden;
    }
    s.hidden = !any || (!!q && s.classList.contains('as-recent'));
  }
  if (q) {
    // Names that start with what you typed come first in each category, so Enter opens the likeliest one…
    for (const g of $$('.as-cat .as-grid', root))
      [...g.querySelectorAll('.as-app')].sort((a, b) => rank(a, q) - rank(b, q) || a.dataset.text.localeCompare(b.dataset.text)).forEach((c) => g.append(c));
    // …and the category holding the best match comes first.
    const cats = $('.as-cats', root);
    const best = (s) => Math.min(3, ...$$('.as-app:not([hidden])', s).map((b) => rank(b, q)));
    [...cats.children].map((c, i) => [c, best(c), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).forEach(([c]) => cats.append(c));
  }
  $('.as-none', root).hidden = !q || visible().length > 0;
  sel = q ? 0 : -1;
  highlight();
}

const visible = () => $$('.as-section:not([hidden]) .as-app:not([hidden])', root);

function highlight() {
  const items = visible();
  if (sel >= items.length) sel = items.length - 1;
  items.forEach((b, i) => b.classList.toggle('sel', i === sel));
  if (sel >= 0) items[sel].scrollIntoView({ block: 'nearest' });
}

/** Up and down go to the nearest app above or below on screen (the categories sit side by side). */
function vertical(items, dir) {
  const cur = items[sel]?.getBoundingClientRect();
  if (!cur) return 0;
  const cx = cur.left + cur.width / 2;
  let best = sel;
  let bestScore = Infinity;
  items.forEach((b, i) => {
    if (i === sel) return;
    const r = b.getBoundingClientRect();
    const dy = dir > 0 ? r.top - cur.bottom : cur.top - r.bottom;
    if (dy < -cur.height / 2) return; // not above / below
    const score = Math.max(0, dy) * 3 + Math.abs(r.left + r.width / 2 - cx);
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

function onKey(e) {
  if (widgetGalleryOpen()) return;
  if (e.target.closest('.as-widgets')) return; // typing in a widget (a quick note)
  if (e.key === 'Escape') {
    e.preventDefault();
    if (widgetEditing() === 'apps') return; // widgets.js leaves edit mode
    const input = $('input', root);
    if (input.value) {
      input.value = '';
      filter();
    } else closeAppScreen();
    return;
  }
  const items = visible();
  if (e.key === 'Enter') {
    e.preventDefault();
    const b = items[Math.max(0, sel)];
    if (b) launch(b.dataset.id);
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || !items.length) return;
  // Left and right stay with the text while you're editing it, until something is highlighted.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel < 0) return;
  e.preventDefault();
  if (sel < 0) sel = 0;
  else if (e.key === 'ArrowRight') sel = Math.min(items.length - 1, sel + 1);
  else if (e.key === 'ArrowLeft') sel = Math.max(0, sel - 1);
  else sel = vertical(items, e.key === 'ArrowDown' ? 1 : -1);
  highlight();
}
