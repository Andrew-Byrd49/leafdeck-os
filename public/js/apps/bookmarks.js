// Bookmarks app + the "Import from another browser" sheet (bookmarks and passwords).

import { store } from '../store.js';
import { $, $$, esc, el, debounce } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, openApp, showMenu, toast } from '../wm.js';
import { editRecord, recordMatches, hostLabel } from '../schemas.js';
import { shell } from '../shell.js';
import { openWebPage } from './browser.js';

const MAX_ROWS = 500;
const normUrl = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
export const favicon = (url) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostLabel(url))}&sz=32`;

export function openBookmark(b) {
  if (shell) openWebPage(b.url);
  else window.open(b.url, '_blank', 'noopener');
}

export const findBookmark = (url) => {
  const k = normUrl(url);
  return store.all('bookmarks').find((b) => normUrl(b.url) === k);
};

/* ---------------- Import ---------------- */

/** Add bookmarks under a top-level folder named after their source, skipping URLs already saved. */
function importBookmarks(items, label) {
  const seen = new Set(store.all('bookmarks').map((b) => normUrl(b.url)));
  const fresh = [];
  let duplicates = 0;
  for (const it of items) {
    const k = normUrl(it.url);
    if (!/^https?:\/\//i.test(it.url) || seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    fresh.push({ title: it.title || '', url: it.url, folder: [label, it.folder].filter(Boolean).join('/'), source: label });
  }
  if (fresh.length) store.saveMany('bookmarks', fresh);
  return { added: fresh.length, duplicates };
}

/** Netscape bookmark HTML — the export format of every major browser. */
function parseBookmarksHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const out = [];
  const walk = (dl, folder) => {
    if (!dl) return;
    for (const dt of dl.querySelectorAll(':scope > dt, :scope > p > dt')) {
      const a = dt.querySelector(':scope > a');
      const h3 = dt.querySelector(':scope > h3');
      if (a) out.push({ title: a.textContent.trim(), url: a.getAttribute('href') || '', folder: folder.join('/') });
      if (h3) walk(dt.querySelector(':scope > dl'), [...folder, h3.textContent.trim()]);
    }
  };
  walk(doc.querySelector('dl'), []);
  return out;
}

const resultLine = (r) =>
  `${icon('tick', 13, 2.4)} Imported <b>${r.added}</b> bookmark${r.added === 1 ? '' : 's'}${r.duplicates ? ` · ${r.duplicates} already saved or skipped` : ''}`;

export async function openImportSheet(win) {
  const sources = shell ? await shell.importer.sources().catch(() => []) : [];
  const vault = shell ? await shell.vault.status().catch(() => ({ available: false })) : null;

  const passwords = !shell
    ? '<p class="muted">Passwords are stored only in the Leafdeck desktop app, encrypted on your computer.</p>'
    : !vault.available
      ? '<p class="txt-red">Secure storage isn’t available on this computer, so Leafdeck can’t save passwords.</p>'
      : `<p>Browsers don’t let other apps read their saved passwords, so export them to a CSV file first:</p>
        <ul class="imp-steps">
          <li><b>Chrome</b> — open <code>chrome://password-manager/settings</code> → Export passwords</li>
          <li><b>Edge</b> — Settings → Passwords → ⋯ → Export passwords</li>
          <li><b>Firefox</b> — open <code>about:logins</code> → ⋯ → Export passwords</li>
          <li><b>Bitwarden, 1Password, Proton Pass, LastPass</b> — export as CSV</li>
        </ul>
        <button class="btn primary small" data-csv>${icon('upload', 12)} Choose CSV file…</button>
        <div class="imp-result" data-pw-result></div>`;

  const node = el(`<div class="import">
    <div class="sheet-head"><div><h2>Import from another browser</h2>
      <small>Bookmarks sync with your Leafdeck data. Passwords stay encrypted on this computer and never sync.</small></div></div>
    <div class="sheet-scroll">
      <section class="imp-sec"><h3>${icon('star', 14)} Bookmarks</h3>
        ${
          shell
            ? sources.length
              ? `<div class="imp-sources">${sources
                  .map((s, i) => `<button class="imp-src" data-src="${i}"><b>${esc(s.browserName)}</b><span>${esc(s.profileName)}</span><small>${s.count} bookmarks</small></button>`)
                  .join('')}</div>`
              : '<p class="muted">No Chrome, Edge, Brave or Vivaldi profiles found on this computer.</p>'
            : '<p class="muted">Importing straight from installed browsers works in the Leafdeck desktop app.</p>'
        }
        <label class="btn small">${icon('upload', 12)} From an HTML bookmarks file…<input type="file" accept=".html,.htm" data-html hidden></label>
        <p class="muted small">Firefox, Safari, Arc and others: export bookmarks to an HTML file, then choose it here.</p>
        <div class="imp-result" data-bm-result></div>
      </section>
      <section class="imp-sec"><h3>${icon('key', 14)} Passwords</h3>${passwords}</section>
    </div>
    <div class="sheet-foot"><span class="grow"></span><button class="btn primary" data-close>Done</button></div>
  </div>`);

  const sh = win.sheet(node);
  const bmResult = $('[data-bm-result]', node);
  const pwResult = $('[data-pw-result]', node);

  node.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return sh.close();

    const src = e.target.closest('[data-src]');
    if (src) {
      const s = sources[src.dataset.src];
      src.disabled = true;
      try {
        const items = await shell.importer.bookmarks(s.browser, s.profile);
        const label = sources.filter((x) => x.browser === s.browser).length > 1 ? `${s.browserName} (${s.profileName})` : s.browserName;
        bmResult.innerHTML = resultLine(importBookmarks(items, label));
      } catch (err) {
        bmResult.innerHTML = `<span class="txt-red">${esc(err.message)}</span>`;
      } finally {
        src.disabled = false;
      }
      return;
    }

    if (e.target.closest('[data-csv]')) {
      try {
        const r = await shell.vault.importCsv();
        if (r.canceled) return;
        pwResult.innerHTML = `<div>${icon('tick', 13, 2.4)} <b>${r.added}</b> added · <b>${r.updated}</b> updated · ${r.skipped} unchanged${r.invalid ? ` · ${r.invalid} skipped (no website or password)` : ''}</div>
          <div class="imp-warn">${icon('shield', 14)} <span><b>${esc(r.file)}</b> holds your passwords in plain text. Delete it now — and empty the Recycle Bin afterwards.</span>
          <button class="btn small danger" data-trash>Move to Recycle Bin</button></div>`;
      } catch (err) {
        pwResult.innerHTML = `<span class="txt-red">${esc(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))}</span>`;
      }
      return;
    }

    const trash = e.target.closest('[data-trash]');
    if (trash) {
      const r = await shell.vault.trashImportFile();
      trash.replaceWith(el(`<span class="txt-green">${r.ok ? 'Moved to the Recycle Bin' : 'Already removed'}</span>`));
    }
  });

  node.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-html]');
    if (!input?.files[0]) return;
    try {
      const items = parseBookmarksHtml(await input.files[0].text());
      if (!items.length) throw new Error('No bookmarks found in that file.');
      bmResult.innerHTML = resultLine(importBookmarks(items, 'Imported'));
    } catch (err) {
      bmResult.innerHTML = `<span class="txt-red">${esc(err.message)}</span>`;
    }
    input.value = '';
  });
  return sh;
}

/** Open the Bookmarks window with the import sheet showing. */
export function openImport() {
  const w = openApp('bookmarks');
  if (w) openImportSheet(w);
}

/* ---------------- Bookmarks app ---------------- */

registerApp({
  id: 'bookmarks',
  name: 'Bookmarks',
  icon: 'star',
  size: [1000, 660],
  min: [560, 380],
  newLabel: 'Bookmark',
  create: (win, d) => editRecord(win, 'bookmarks', null, d),
  openRecord: (_win, id) => {
    const b = store.get('bookmarks', id);
    if (b) openBookmark(b);
  },
  openFolder: (win, f) => win.openFolder?.(f),
  mount(win) {
    let folder = '';
    let q = '';
    win.tools.innerHTML = `<label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search bookmarks"></label>
      <button class="tb-btn" data-import title="Import from another browser">${icon('download', 15)}</button>
      <button class="tb-btn" data-act="new" title="New bookmark">${icon('plus', 16)}</button>`;
    win.body.innerHTML = '<div class="bm"><aside class="bm-folders"></aside><section class="bm-list"></section></div>';
    const side = $('.bm-folders', win.body);
    const list = $('.bm-list', win.body);

    const drawFolders = () => {
      const all = store.all('bookmarks');
      const counts = new Map();
      for (const b of all) {
        const parts = (b.folder || '').split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          const p = parts.slice(0, i).join('/');
          counts.set(p, (counts.get(p) || 0) + 1);
        }
      }
      const paths = [...counts.keys()].sort((a, b) => a.localeCompare(b));
      side.innerHTML = `<button class="bm-folder ${folder === '' ? 'on' : ''}" data-folder=""><span>${icon('star', 13)} All bookmarks</span><small>${all.length}</small></button>
        ${paths
          .map((p) => {
            const depth = p.split('/').length - 1;
            return `<button class="bm-folder ${folder === p ? 'on' : ''}" data-folder="${esc(p)}" style="padding-left:${10 + depth * 14}px" title="${esc(p)}">
              <span>${esc(p.split('/').pop())}</span><small>${counts.get(p)}</small></button>`;
          })
          .join('')}`;
    };

    const drawList = () => {
      let rows = store.all('bookmarks');
      if (folder) rows = rows.filter((b) => b.folder === folder || (b.folder || '').startsWith(folder + '/'));
      if (q) rows = rows.filter((b) => recordMatches('bookmarks', b, q));
      rows.sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || (a.title || '').localeCompare(b.title || ''));
      if (!rows.length) {
        list.innerHTML = store.all('bookmarks').length
          ? '<div class="empty small"><p>No bookmarks match.</p></div>'
          : `<div class="empty"><div class="empty-title">No bookmarks yet</div><p>Import them from Chrome, Edge, Firefox and more — or star pages as you browse.</p>
              <button class="btn primary" data-import>${icon('download', 13)} Import bookmarks</button></div>`;
        return;
      }
      list.innerHTML = `${rows
        .slice(0, MAX_ROWS)
        .map(
          (b) => `<div class="bm-row" data-id="${b.id}" title="${esc(b.url)}">
            <img class="fav" src="${esc(favicon(b.url))}" alt="" loading="lazy" referrerpolicy="no-referrer">
            <span class="bm-main"><b>${esc(b.title || hostLabel(b.url))}</b><small>${esc(hostLabel(b.url))}${!folder && b.folder ? ` · ${esc(b.folder)}` : ''}</small></span>
            <button class="icon-btn" data-edit title="Edit">${icon('note', 13)}</button>
          </div>`,
        )
        .join('')}${rows.length > MAX_ROWS ? `<p class="muted small bm-more">Showing ${MAX_ROWS} of ${rows.length} — search or pick a folder to narrow it down.</p>` : ''}`;
    };

    const draw = () => {
      drawFolders();
      drawList();
    };

    win.tools.addEventListener('input', debounce((e) => {
      q = e.target.value;
      drawList();
    }, 120));
    win.el.addEventListener('click', (e) => {
      if (!win.el.contains(e.target) || e.target.closest('.sheet-wrap')) return;
      if (e.target.closest('[data-import]')) return openImportSheet(win);
      if (e.target.closest('[data-act=new]')) return editRecord(win, 'bookmarks');
    });
    win.openFolder = (f) => {
      folder = f;
      draw();
    };
    side.addEventListener('click', (e) => {
      const f = e.target.closest('[data-folder]');
      if (!f) return;
      folder = f.dataset.folder;
      draw();
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      const b = row && store.get('bookmarks', row.dataset.id);
      if (!b) return;
      if (e.target.closest('[data-edit]')) editRecord(win, 'bookmarks', b);
      else openBookmark(b);
    });
    list.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('[data-id]');
      const b = row && store.get('bookmarks', row.dataset.id);
      if (!b) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Open', act: () => openBookmark(b) },
        shell && { label: 'Open in Your Browser', act: () => shell.openExternal(b.url) },
        { label: 'Copy Link', act: () => navigator.clipboard.writeText(b.url).then(() => toast('Link copied')) },
        '-',
        { label: 'Edit…', act: () => editRecord(win, 'bookmarks', b) },
        { label: 'Delete', act: () => store.remove('bookmarks', b.id) },
      ]);
    });

    win.watch(['bookmarks'], draw);
    draw();
  },
});
