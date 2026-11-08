// Saved layouts: a named arrangement of windows (sites and apps, with their positions) you can reopen in one
// click.
// Saved in prefs.layouts (synced with your other settings).

import { store } from './store.js';
import { $, $$, esc, el, uid } from './util.js';
import { icon } from './icons.js';
import { registerApp, wins, openApp, closeAll, setRect, minimize, toast, showMenu } from './wm.js';
import { openWebPage } from './apps/browser.js';

export const layouts = () => (Array.isArray(store.prefs.layouts) ? store.prefs.layouts : []);
const titleOf = (w) => $('.win-title-text', w.el)?.textContent || w.app.name;

/** The windows open right now, as a layout. */
export function snapshotWindows() {
  return [...wins.values()]
    .sort((a, b) => a.z - b.z) // back to front, so reopening restores the stacking order
    .map((w) => {
      let url = '';
      try {
        url = w.web?.url?.() || '';
      } catch {}
      if (w.web && !/^https?:\/\//i.test(url)) return null; // an empty site window
      const rect = w.max ? w.prev || w.rect : w.rect;
      return { id: w.web ? '' : w.id, url, title: titleOf(w), rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, max: !!w.max, minimized: !!w.minimized };
    })
    .filter(Boolean);
}

export function saveLayout({ id, name, windows = snapshotWindows() }) {
  const list = layouts().filter((l) => l.id !== id);
  const l = { id: id || 'l_' + uid(), name: String(name || '').trim().slice(0, 60) || 'Untitled layout', windows, updatedAt: Date.now() };
  list.push(l);
  store.setPrefs({ layouts: list });
  return l;
}

export function deleteLayout(id) {
  store.setPrefs({ layouts: layouts().filter((l) => l.id !== id) });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a layout: by default the current windows are closed first; `add` keeps them. */
export async function openLayout(l, { add = false } = {}) {
  if (!l) return;
  if (!add) closeAll();
  let opened = 0;
  for (const e of l.windows || []) {
    let w = null;
    if (e.url) w = openWebPage(e.url);
    else if (e.id) w = openApp(e.id);
    if (!w) continue;
    opened++;
    if (e.rect) setRect(w, e.rect, !!e.max);
    if (e.minimized) minimize(w);
    await wait(40);
  }
  toast(`Opened ${l.name} — ${opened} window${opened === 1 ? '' : 's'}`);
}


/** Items for the Window menu. */
export function layoutMenuItems() {
  const list = layouts().sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return [];
  return [{ header: 'Open Layout' }, ...list.slice(0, 10).map((l) => ({ label: `${l.name} (${l.windows.length})`, act: () => openLayout(l) })), '-'];
}

/* ---------------- The Layouts app ---------------- */

registerApp({
  id: 'layouts',
  name: 'Layouts',
  icon: 'layout',
  color: 'teal',
  hidden: true,
  size: [640, 520],
  min: [440, 360],
  create: (win) => win.showSave?.(),
  mount(win) {
    win.tools.innerHTML = `<button class="tb-btn" data-act="save" title="Save the current windows as a layout">${icon('plus', 16)}</button>`;
    const draw = () => {
      const list = layouts().sort((a, b) => a.name.localeCompare(b.name));
      win.body.innerHTML = `<div class="ly">
        <form class="ly-save" hidden>
          <input name="name" placeholder="Name this layout, e.g. Thesis" maxlength="60" required>
          <button class="btn primary small" type="submit">Save ${wins.size} window${wins.size === 1 ? '' : 's'}</button>
          <button class="btn small" type="button" data-cancel>Cancel</button>
        </form>
        ${
          list.length
            ? `<div class="ly-list">${list
                .map(
                  (l) => `<div class="ly-item" data-id="${esc(l.id)}">
              <div class="ly-main"><b>${esc(l.name)}</b><small>${l.windows.length} window${l.windows.length === 1 ? '' : 's'}</small>
                <small class="ly-wins">${esc(l.windows.map((w) => w.title).slice(0, 6).join(' · '))}${l.windows.length > 6 ? ' …' : ''}</small></div>
              <div class="ly-actions">
                <button class="btn small primary" data-open>Open</button>
                <button class="icon-btn" data-add title="Open alongside the current windows">${icon('plus', 13)}</button>
                <button class="icon-btn" data-update title="Replace with the windows open now">${icon('refresh', 13)}</button>
                <button class="icon-btn" data-delete title="Delete">${icon('trash', 13)}</button>
              </div></div>`,
                )
                .join('')}</div>`
            : `<div class="empty"><div class="empty-title">No saved layouts</div><p>Arrange the windows you want, then save them as a layout to bring them all back in one click.</p>
              <button class="btn primary" data-act="save">${icon('plus', 13)} Save current windows</button></div>`
        }</div>`;
    };
    win.showSave = () => {
      const f = $('.ly-save', win.body);
      if (!f) return;
      f.hidden = false;
      $('[name=name]', f).focus();
    };
    win.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act=save]')) return win.showSave();
      if (e.target.closest('[data-cancel]')) return ($('.ly-save', win.body).hidden = true);
      const item = e.target.closest('.ly-item');
      if (!item) return;
      const l = layouts().find((x) => x.id === item.dataset.id);
      if (!l) return;
      if (e.target.closest('[data-open]')) return openLayout(l);
      if (e.target.closest('[data-add]')) return openLayout(l, { add: true });
      if (e.target.closest('[data-update]')) {
        saveLayout({ id: l.id, name: l.name });
        return toast(`Updated ${l.name}`);
      }
      const del = e.target.closest('[data-delete]');
      if (del) {
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm');
          del.title = 'Click again to delete';
          setTimeout(() => del.isConnected && del.classList.remove('confirm'), 3000);
          return;
        }
        deleteLayout(l.id);
      }
    });
    win.body.addEventListener('submit', (e) => {
      const f = e.target.closest('.ly-save');
      if (!f) return;
      e.preventDefault();
      const l = saveLayout({ name: f.elements.name.value });
      toast(`Saved ${l.name}`);
    });
    win.watch(['settings'], draw);
    draw();
  },
});
