// Files: the file manager (Linux and Leafdeck OS; the work happens in electron/files.cjs). Your places and drives on the
// side; folders as icons or a list; copy, cut and paste, drag to move (hold Ctrl to copy), rename, Trash with restore;
// search; a preview for pictures, video, sound, text and PDFs (Space), and pictures open in Image Viewer (apps/viewer.js);
// live updates while a folder is open.
import { esc, $, $$, el } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, showMenu, openApp } from '../wm.js';
import { confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';
import { openWebPage, fileUrlOf } from './browser.js';
import { fileUrl, ext, KIND_NAME, thumb, tile } from '../filethumb.js';

const supported = !!shell?.files && shell.platform === 'linux';
const TRASH = 'trash:'; // the Trash isn't a folder you browse into: it lists where things came from
const PREVIEW = new Set(['image', 'video', 'audio', 'text', 'code', 'pdf', 'archive']);
const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i; // what Image Viewer shows
const WEB_PAGE = /\.(html?|xhtml)$/i; // opens in Leafdeck's browser
const IN_BROWSER = /\.(html?|xhtml|svg|pdf)$/i; // what the browser can also show
const PRINTS = new Set(['pdf', 'image', 'text', 'code', 'doc', 'sheet', 'slides']); // what gets Print… (electron/printing.cjs)
const DRAG_TYPE = 'application/x-leafdeck-files';

let clip = null; // { paths, cut }: copied or cut files, shared by every Files window

const pref = (k, d) => {
  try {
    return localStorage.getItem(`files:${k}`) ?? d;
  } catch {
    return d;
  }
};
const setPref = (k, v) => {
  try {
    localStorage.setItem(`files:${k}`, v);
  } catch {}
};

const base = (p) => p.split('/').filter(Boolean).pop() || '/';
function size(n) {
  if (n == null) return '';
  if (n < 1000) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1000;
    i++;
  } while (n >= 1000 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
// Your standard folders (Places) wear what's in them on the front.
const EMBLEMS = { desktop: 'grid', documents: 'note', download: 'download', pictures: 'image', music: 'volume', videos: 'play', publicshare: 'users', templates: 'layout' };

// A file or folder another program (xdg-open, "Show in folder") or Leafdeck itself asks to show.
if (supported) shell.on?.('shell:show-path', ({ path, reveal } = {}) => typeof path === 'string' && openApp('files', reveal ? { reveal: path } : { open: path }));

registerApp({
  id: 'files',
  name: 'Files',
  icon: 'folder',
  color: 'blue',
  size: [980, 620],
  min: [520, 320],
  hidden: !supported,
  reveal(win, p) {
    win.files?.reveal(String(p));
  },
  launch(opts) {
    // A picture opens in Image Viewer straight away, without a Files window behind it.
    if (opts.open && PICTURE.test(opts.open)) {
      openApp('viewer', { file: opts.open });
      return false;
    }
    // So does a web page, in the browser.
    if (opts.open && WEB_PAGE.test(opts.open)) {
      openWebPage(fileUrlOf(opts.open));
      return false;
    }
  },
  openFile(win, p) {
    win.files?.open(String(p));
  },
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Files runs on Leafdeck OS</div><p>On Windows, use File Explorer.</p></div>`;
      return;
    }
    win.tools.innerHTML = `<label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search this folder" aria-label="Search this folder"></label>`;
    win.body.innerHTML = `<div class="fm">
      <nav class="fm-side" aria-label="Places"></nav>
      <section class="fm-main">
        <div class="fm-bar">
          <button class="tb-btn" data-fm="back" title="Back (Alt+←)">${icon('left', 15)}</button>
          <button class="tb-btn" data-fm="forward" title="Forward (Alt+→)">${icon('right', 15)}</button>
          <button class="tb-btn" data-fm="up" title="Enclosing folder (Alt+↑)">${icon('up', 15)}</button>
          <div class="fm-crumbs" title="Double-click to type a location (Ctrl+L)"></div>
          <button class="tb-btn" data-fm="view" title="Icons or list"></button>
          <button class="tb-btn" data-fm="more" title="More">${icon('dots', 15)}</button>
        </div>
        <div class="fm-list" tabindex="0" role="listbox" aria-multiselectable="true"></div>
        <div class="fm-status"></div>
      </section>
      <div class="fm-preview" hidden></div>
    </div>`;
    const side = $('.fm-side', win.body);
    const listEl = $('.fm-list', win.body);
    const crumbs = $('.fm-crumbs', win.body);
    const searchIn = $('.tb-search input', win.tools);
    const status = $('.fm-status', win.body);
    const previewEl = $('.fm-preview', win.body);

    let places = null;
    let cur = ''; // a folder's path, or TRASH
    let back = [];
    let forward = [];
    let entries = [];
    let writable = true;
    let query = '';
    let results = null; // search results, while searching
    let sel = new Set();
    let anchor = null;
    let renaming = null;
    let view = pref('view', 'grid');
    // Downloads keeps a sort of its own, newest added first unless you choose another.
    const isDownloads = (d) => !!d && d === places?.folders.find((f) => f.id === 'download')?.path;
    const sortPref = (d) => (isDownloads(d) ? { pre: 'dl:', key: 'added', dir: -1 } : { pre: '', key: 'name', dir: 1 });
    let sortKey = pref('sort', 'name');
    let sortDir = Number(pref('sortDir', 1));
    const loadSort = (d) => {
      const p = sortPref(d);
      sortKey = pref(`${p.pre}sort`, p.key);
      sortDir = Number(pref(`${p.pre}sortDir`, p.dir));
    };
    let hidden = pref('hidden', '0') === '1';
    let watching = null;
    let loadSeq = 0;
    let revealing = false; // opened to show something: don't start at Home

    /* ---------------- loading ---------------- */

    async function go(dir, { push = true, select = null } = {}) {
      if (push && cur && dir !== cur) {
        back.push(cur);
        forward = [];
      }
      query = '';
      searchIn.value = '';
      results = null;
      await load(dir, select);
    }

    async function load(dir, select = null) {
      const seq = ++loadSeq;
      try {
        if (dir === TRASH) {
          entries = await shell.files.trashList();
          writable = false;
          dir = TRASH;
        } else {
          const r = await shell.files.list(dir);
          if (seq !== loadSeq) return;
          entries = r.entries;
          writable = r.writable;
          dir = r.path;
        }
      } catch (err) {
        toast(err.message, 'error');
        if (!cur) return load(places?.home || '/');
        return;
      }
      if (seq !== loadSeq) return;
      if (dir !== cur) {
        if (watching) shell.files.unwatch(watching);
        watching = dir === TRASH ? places?.trash : dir;
        if (watching) shell.files.watch(watching);
        sel = new Set();
        anchor = null;
        loadSort(dir);
      }
      cur = dir;
      if (select) sel = new Set([].concat(select));
      else sel = new Set([...sel].filter((p) => entries.some((e) => e.path === p)));
      win.setTitle(cur === TRASH ? 'Trash' : base(cur) === '/' ? 'This computer' : base(cur));
      draw();
      if (select) $(`.fm-item[data-path="${CSS.escape([].concat(select)[0])}"]`, listEl)?.scrollIntoView({ block: 'nearest' });
    }

    const reload = () => (results ? runSearch() : load(cur));

    /* ---------------- drawing ---------------- */

    function shown() {
      const list = (results || entries).filter((e) => hidden || !e.hidden);
      const by = {
        name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
        size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
        mtime: (a, b) => (cur === TRASH ? (a.deletedAt || 0) - (b.deletedAt || 0) : a.mtime - b.mtime),
        added: (a, b) => (cur === TRASH ? (a.deletedAt || 0) - (b.deletedAt || 0) : (a.added || a.mtime) - (b.added || b.mtime)),
        kind: (a, b) => a.kind.localeCompare(b.kind),
      }[sortKey];
      return list.sort((a, b) => b.dir - a.dir || by(a, b) * sortDir || a.name.localeCompare(b.name));
    }

    function drawSide() {
      if (!places) return;
      const item = (p, ic) => `<button class="fm-place${p.path === cur ? ' on' : ''}" data-go="${esc(p.path)}" data-drop="${esc(p.path)}">${icon(ic, 15)}<span>${esc(p.name)}</span></button>`;
      const ICONS = { home: 'user', desktop: 'grid', documents: 'note', download: 'download', pictures: 'sparkle', music: 'volume', videos: 'play' };
      side.innerHTML = `<div class="fm-side-head">Places</div>${places.folders.map((p) => item(p, ICONS[p.id] || 'folder')).join('')}
        ${places.drives.length || places.unmounted?.length
          ? `<div class="fm-side-head">Drives</div>${places.drives
              .map((d) => (d.device ? `<div class="fm-drive">${item(d, 'inbox')}<button class="fm-eject" data-eject="${esc(d.device)}" title="Safely remove “${esc(d.name)}”" aria-label="Safely remove ${esc(d.name)}">${icon('eject', 13)}</button></div>` : item(d, 'inbox')))
              .join('')}${(places.unmounted || []).map((d) => `<button class="fm-place dim" data-mount="${esc(d.device)}">${icon(d.locked ? 'lock' : 'inbox', 15)}<span>${esc(d.name)}</span></button>`).join('')}`
          : ''}
        <div class="fm-side-head">Computer</div>${item(places.computer, 'layout')}
        <button class="fm-place${cur === TRASH ? ' on' : ''}" data-go="${TRASH}" data-drop="${TRASH}">${icon('trash', 15)}<span>Trash</span></button>`;
    }

    function drawCrumbs() {
      if (cur === TRASH) return void (crumbs.innerHTML = `<span class="fm-crumb on">${icon('trash', 13)} Trash</span>`);
      const home = places?.home || '';
      const inHome = cur === home || cur.startsWith(home + '/');
      // A drive starts from its own name, not from where Linux happens to mount it.
      const drive = !inHome && places?.drives.find((d) => cur === d.path || cur.startsWith(`${d.path}/`));
      const root = drive || { name: inHome ? 'Home' : 'This computer', path: inHome ? home : '/' };
      const parts = [{ name: root.name, path: root.path }];
      let acc = root.path === '/' ? '' : root.path;
      for (const p of cur.slice(acc.length).split('/').filter(Boolean)) parts.push({ name: p, path: (acc += `/${p}`) });
      crumbs.innerHTML = parts
        .map((p, i) => `${i ? `<span class="fm-sep">›</span>` : ''}<button class="fm-crumb${i === parts.length - 1 ? ' on' : ''}" data-go="${esc(p.path)}" data-drop="${esc(p.path)}">${esc(p.name)}</button>`)
        .join('');
      crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function draw() {
      drawSide();
      drawCrumbs();
      $('[data-fm="back"]', win.body).disabled = !back.length;
      $('[data-fm="forward"]', win.body).disabled = !forward.length;
      $('[data-fm="up"]', win.body).disabled = cur === TRASH || cur === '/';
      $('[data-fm="view"]', win.body).innerHTML = icon(view === 'grid' ? 'list' : 'grid', 15);
      const items = shown();
      listEl.className = `fm-list fm-${view}`;
      const head =
        view === 'list'
          ? `<div class="fm-head">${[['name', 'Name'], sortKey === 'added' ? ['added', cur === TRASH ? 'Deleted' : 'Added'] : ['mtime', cur === TRASH ? 'Deleted' : 'Modified'], ['size', 'Size'], ['kind', results || cur === TRASH ? 'From' : 'Kind']]
              .map(([k, l]) => `<button data-sort="${k}" class="${sortKey === k ? 'on' : ''}">${l}${sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</button>`)
              .join('')}</div>`
          : '';
      const special = new Map(places?.folders.map((f) => [f.path, EMBLEMS[f.id]]) || []);
      const row = (e) => {
        const where = results ? e.path.slice(0, -e.name.length - 1).replace(places?.home || '\0', '~') : cur === TRASH ? (e.origPath || '').replace(places?.home || '\0', '~') : KIND_NAME[e.kind];
        return `<div class="fm-item${sel.has(e.path) ? ' sel' : ''}${e.hidden ? ' dim' : ''}${clip?.cut && clip.paths.includes(e.path) ? ' cut' : ''}" data-path="${esc(e.path)}" ${e.dir ? `data-drop="${esc(e.path)}"` : ''} draggable="${cur !== TRASH}" role="option" aria-selected="${sel.has(e.path)}">
          ${thumb(e, e.dir && special.get(e.path))}<span class="fm-name" title="${esc(e.name)}">${esc(e.name)}</span>
          ${view === 'list' ? `<span class="fm-col">${esc(when(cur === TRASH ? e.deletedAt : sortKey === 'added' ? e.added || e.mtime : e.mtime))}</span><span class="fm-col">${e.dir ? '—' : esc(size(e.size))}</span><span class="fm-col" title="${esc(where)}">${esc(where)}</span>` : ''}
        </div>`;
      };
      listEl.innerHTML = items.length
        ? head + items.map(row).join('')
        : `<div class="fm-empty">${results ? `Nothing called “${esc(query)}” in here` : cur === TRASH ? 'The Trash is empty' : 'This folder is empty'}</div>`;
      const total = items.filter((e) => sel.has(e.path));
      const bytes = total.reduce((t, e) => t + (e.size || 0), 0);
      status.innerHTML = `<span>${items.length} item${items.length === 1 ? '' : 's'}${total.length ? ` · ${total.length} selected${bytes ? ` (${size(bytes)})` : ''}` : ''}</span>
        ${cur === TRASH && entries.length ? `<button class="btn small" data-fm="empty-trash">Empty Trash</button>` : ''}
        ${!writable && cur !== TRASH && !results ? `<span class="muted">Read only</span>` : ''}`;
    }

    /* ---------------- selection ---------------- */

    const selected = () => shown().filter((e) => sel.has(e.path));
    function pick(path, e) {
      const items = shown().map((x) => x.path);
      if (e?.shiftKey && anchor && items.includes(anchor)) {
        const [a, b] = [items.indexOf(anchor), items.indexOf(path)].sort((x, y) => x - y);
        sel = new Set([...(e.ctrlKey ? sel : []), ...items.slice(a, b + 1)]);
      } else if (e?.ctrlKey || e?.metaKey) {
        sel.has(path) ? sel.delete(path) : sel.add(path);
        anchor = path;
      } else {
        sel = new Set([path]);
        anchor = path;
      }
      draw();
    }
    function moveSel(delta, extend) {
      const items = shown().map((x) => x.path);
      if (!items.length) return;
      const last = [...sel].pop();
      let i = items.indexOf(last);
      // In icon view, up and down move a whole row.
      const perRow = view === 'grid' ? Math.max(1, Math.floor(listEl.clientWidth / ($('.fm-item', listEl)?.offsetWidth + 8 || 112))) : 1;
      const step = Math.abs(delta) === 2 ? perRow * Math.sign(delta) : delta;
      i = i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + step));
      pick(items[i], extend ? { shiftKey: true } : null);
      $(`.fm-item[data-path="${CSS.escape(items[i])}"]`, listEl)?.scrollIntoView({ block: 'nearest' });
    }

    /* ---------------- actions ---------------- */

    const err = (e) => toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');

    async function open(e) {
      if (!e) return;
      if (e.dir && cur !== TRASH) return go(e.path);
      if (e.kind === 'image' && cur !== TRASH) return openApp('viewer', { file: e.path });
      if (WEB_PAGE.test(e.name) && cur !== TRASH) return openWebPage(fileUrlOf(e.path));
      if ((e.kind === 'text' || e.kind === 'code') && cur !== TRASH) return openApp('editor', { file: e.path });
      if (PREVIEW.has(e.kind)) return preview(e);
      if (cur === TRASH) return toast('Put it back first to open it');
      const problem = await shell.files.open(e.path).catch((x) => x.message);
      if (problem) toast(`There’s no app on this computer that opens ${ext(e.name) ? `.${ext(e.name).toLowerCase()} files` : 'this file'} yet.`, 'error');
    }

    async function newFolder() {
      if (cur === TRASH || !writable) return;
      try {
        const p = await shell.files.mkdir(cur);
        await load(cur, p);
        startRename(p);
      } catch (x) {
        err(x);
      }
    }

    function startRename(p) {
      const item = $(`.fm-item[data-path="${CSS.escape(p)}"]`, listEl);
      if (!item || cur === TRASH) return;
      renaming = p;
      const nameEl = $('.fm-name', item);
      const old = base(p);
      nameEl.innerHTML = `<input class="fm-rename" value="${esc(old)}" spellcheck="false">`;
      const input = $('input', nameEl);
      input.focus();
      // The name without its extension is selected, like other file managers.
      const dot = old.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : old.length);
      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        renaming = null;
        const name = input.value.trim();
        if (commit && name && name !== old) {
          try {
            const to = await shell.files.rename(p, name);
            return load(cur, to);
          } catch (x) {
            err(x);
          }
        }
        draw();
        listEl.focus();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    }

    async function toTrash(items = selected()) {
      if (!items.length) return;
      if (cur === TRASH) return deleteForever(items);
      try {
        await shell.files.trash(items.map((e) => e.path));
        toast(items.length === 1 ? `“${items[0].name}” moved to the Trash` : `${items.length} items moved to the Trash`, '', { label: 'Undo', act: () => undoTrash(items) });
        await load(cur);
      } catch (x) {
        err(x);
      }
    }
    async function undoTrash(items) {
      // The Trash keeps the name (or a numbered one, if taken there); put back the matching entries.
      const inTrash = await shell.files.trashList().catch(() => []);
      const found = items.map((e) => inTrash.filter((t) => t.origPath === e.path).sort((a, b) => b.deletedAt - a.deletedAt)[0]?.path).filter(Boolean);
      await shell.files.restore(found).catch(err);
      load(cur);
    }
    async function deleteForever(items) {
      const what = items === 'all' ? 'everything in the Trash' : items.length === 1 ? `“${items[0].name}”` : `these ${items.length} items`;
      if (!(await confirmDialog(`Delete ${what} for good? This can’t be undone.`, { ok: 'Delete', danger: true, win }))) return;
      await shell.files.deleteForever(items === 'all' ? 'all' : items.map((e) => e.path)).catch(err);
      load(cur);
    }
    async function restoreItems(items = selected()) {
      await shell.files.restore(items.map((e) => e.path)).catch(err);
      toast(items.length === 1 ? `“${items[0].name}” is back where it was` : `${items.length} items put back`);
      load(cur);
    }

    function copy(cut) {
      const items = selected();
      if (!items.length || cur === TRASH) return;
      clip = { paths: items.map((e) => e.path), cut };
      toast(`${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`} ${cut ? 'cut' : 'copied'}`);
      draw();
    }
    async function pasteInto(dir = cur, paths = clip?.paths, move = clip?.cut) {
      if (!paths?.length || dir === TRASH) return;
      try {
        const done = await shell.files.paste(paths, dir, !!move);
        if (move && paths === clip?.paths) clip = null;
        if (dir === cur) await load(cur, done);
        else await load(cur);
      } catch (x) {
        err(x);
        load(cur);
      }
    }

    /* ---------------- search ---------------- */

    let searchTimer = 0;
    async function runSearch() {
      if (!query || cur === TRASH) {
        results = null;
        return draw();
      }
      const q = query;
      const found = await shell.files.search(cur, q).catch(() => []);
      if (q !== query) return;
      results = found;
      sel = new Set();
      draw();
    }
    searchIn.addEventListener('input', () => {
      query = searchIn.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 250);
    });
    searchIn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchIn.value = '';
        query = '';
        results = null;
        draw();
        listEl.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        listEl.focus();
        if (!sel.size) moveSel(1);
      }
    });

    /* ---------------- preview ---------------- */

    /** An archive's contents as a tree: folders first and open at the top level, each file with its size. */
    function archiveBody(e, r) {
      if (r.error) return `<div class="fm-audio">${thumb(e)}<p class="muted">${esc(r.error)}</p></div>`;
      if (r.single) return `<div class="fm-audio">${thumb(e)}<p class="muted">Compresses one file, <b>${esc(r.single)}</b>, not a set of files.</p></div>`;
      const root = { dirs: new Map(), files: [] };
      for (const en of r.entries) {
        const parts = en.path.split('/').filter(Boolean);
        if (!parts.length) continue;
        let node = root;
        const upTo = en.dir ? parts.length : parts.length - 1;
        for (let i = 0; i < upTo; i++) {
          let d = node.dirs.get(parts[i]);
          if (!d) node.dirs.set(parts[i], (d = { dirs: new Map(), files: [] }));
          node = d;
        }
        if (!en.dir) node.files.push({ name: parts.at(-1), kind: en.kind, size: en.size, locked: en.locked });
      }
      const tree = (node, depth) =>
        [...node.dirs.entries()]
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
          .map(([name, d]) => `<details class="fm-arc-dir"${depth === 0 ? ' open' : ''}><summary><span class="fm-arc-row">${icon('folder', 14)}<span class="fm-arc-name">${esc(name)}</span><small>${d.dirs.size + d.files.length} item${d.dirs.size + d.files.length === 1 ? '' : 's'}</small></span></summary><div class="fm-arc-in">${tree(d, depth + 1)}</div></details>`)
          .join('') +
        node.files
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
          .map((f) => `<div class="fm-arc-row fm-arc-file" title="${esc(f.name)}">${tile(f)}<span class="fm-arc-name">${esc(f.name)}</span>${f.locked ? `<i title="Password-protected">${icon('lock', 11)}</i>` : ''}<small>${f.size ? esc(size(f.size)) : ''}</small></div>`)
          .join('');
      const files = r.entries.filter((x) => !x.dir).length;
      const folders = r.total - files;
      const summary = `${r.total === r.entries.length ? '' : `First ${r.entries.length} of `}${r.total} item${r.total === 1 ? '' : 's'}${folders ? ` in ${folders} folder${folders === 1 ? '' : 's'}` : ''} · ${esc(size(r.unpacked))} unpacked`;
      return `<div class="fm-arc"><div class="fm-arc-sum muted">${summary}</div>${tree(root, 0) || '<div class="fm-empty">This archive is empty.</div>'}</div>`;
    }

    let previewing = null;
    async function preview(e) {
      if (!e || e.dir) return;
      previewing = e;
      const url = fileUrl(e.path);
      let body;
      if (e.kind === 'image') body = `<img src="${esc(url)}" alt="">`;
      else if (e.kind === 'video') body = `<video src="${esc(url)}" controls autoplay></video>`;
      else if (e.kind === 'audio') body = `<div class="fm-audio">${thumb(e)}<audio src="${esc(url)}" controls autoplay></audio></div>`;
      else if (e.kind === 'pdf') body = `<iframe src="${esc(url)}" title="${esc(e.name)}"></iframe>`;
      else if (e.kind === 'text' || e.kind === 'code') {
        const r = await shell.files.readText(e.path).catch((x) => ({ text: x.message }));
        body = r.binary ? `<div class="fm-empty">This file isn’t text.</div>` : `<pre>${esc(r.text)}${r.truncated ? '\n…' : ''}</pre>`;
      } else if (e.kind === 'archive') {
        const r = await shell.files.archive(e.path).catch((x) => ({ error: x.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
        if (previewing !== e) return; // a slow one: the preview moved on
        body = archiveBody(e, r);
      } else body = `<div class="fm-audio">${thumb(e)}<p class="muted">No preview for this kind of file.</p></div>`;
      previewEl.hidden = false;
      previewEl.innerHTML = `<div class="fm-pv-bar"><b title="${esc(e.path)}">${esc(e.name)}</b><span class="muted">${esc([KIND_NAME[e.kind], size(e.size), when(e.mtime)].filter(Boolean).join(' · '))}</span>
          ${(e.kind === 'text' || e.kind === 'code') && cur !== TRASH ? '<button class="btn small" data-pv="edit">Edit</button>' : ''}${canPrint(e) ? '<button class="btn small" data-pv="print">Print…</button>' : ''}${isArchive(e) && cur !== TRASH ? '<button class="btn small" data-pv="extract">Extract</button>' : ''}<button class="btn small" data-pv="with">Open with…</button><button class="tb-btn" data-pv="close" title="Close (Space or Esc)">${icon('x', 14)}</button></div>
        <div class="fm-pv-body">${body}</div>`;
    }
    function closePreview() {
      if (previewEl.hidden) return false;
      previewEl.hidden = true;
      previewEl.innerHTML = ''; // stops video and sound
      previewing = null;
      listEl.focus();
      return true;
    }
    previewEl.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-pv]')?.dataset.pv;
      if (a === 'close' || e.target === previewEl) closePreview();
      if (a === 'edit') {
        const p = previewing.path;
        closePreview();
        openApp('editor', { file: p });
      }
      if (a === 'print') printFile(previewing);
      if (a === 'extract') {
        const e = previewing;
        closePreview();
        extract([e]);
      }
      if (a === 'with') {
        const r = e.target.closest('[data-pv]').getBoundingClientRect();
        openWithMenu(previewing, r.left, r.bottom + 4);
      }
    });
    /**
     * Unpack archives beside themselves (electron/files.cjs extract): a folder named after each, or the one file it
     * holds; then select what came out. The folder's watch shows it appear.
     */
    const isArchive = (e) => !!e && !e.dir && e.kind === 'archive';
    async function extract(items = selected().filter(isArchive)) {
      if (!items.length || cur === TRASH) return;
      toast(items.length === 1 ? `Extracting “${items[0].name}”…` : `Extracting ${items.length} archives…`);
      const made = [];
      for (const e of items) {
        const r = await shell.files.extract(e.path).then((p) => ({ path: p }), (x) => ({ error: x.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
        if (r.error) toast(`“${e.name}” couldn’t be extracted: ${r.error}`, 'error');
        else made.push(r.path);
      }
      if (!made.length) return;
      const parent = made[0].replace(/\/[^/]+$/, '') || '/';
      const show = () => (parent === cur ? go(cur, { push: false, select: made }) : go(parent, { select: made }));
      if (parent === cur && !results) await show();
      const name = (p) => p.split('/').pop();
      toast(made.length === 1 ? `“${name(made[0])}” extracted${parent === cur ? '' : ` to ${name(parent)}`}` : `${made.length} archives extracted`, '', parent === cur && !results ? null : { label: 'Show', act: show });
    }
    const canPrint = (e) => !!e && !e.dir && cur !== TRASH && (PRINTS.has(e.kind) || WEB_PAGE.test(e.name));
    async function printFile(e) {
      const problem = await shell.print.file(e.path).catch((x) => x.message);
      if (problem) toast(problem, 'error');
    }
    /** In a preview, ← and → go through the folder's pictures, videos and other previewable files. */
    function previewStep(d) {
      const items = shown().filter((x) => !x.dir && PREVIEW.has(x.kind));
      const i = items.findIndex((x) => x.path === previewing?.path);
      const next = items[(i + d + items.length) % items.length];
      if (next) {
        sel = new Set([next.path]);
        draw();
        preview(next);
      }
    }

    /* ---------------- menus ---------------- */

    /** Leafdeck's apps that open a file, then the computer's (the freedesktop.org MIME settings). */
    async function openWithMenu(e, x, y) {
      const apps = await shell.files.appsFor(e.path).catch(() => []);
      const launch = (a) => async () => {
        const problem = await shell.files.openWith(e.path, a.id).catch((x) => x.message);
        if (problem) toast(`${a.name} couldn’t open it: ${problem}`, 'error');
      };
      const own = [
        IN_BROWSER.test(e.name) && { label: 'Browser', act: () => openWebPage(fileUrlOf(e.path)) },
        e.kind === 'image' && { label: 'Image Viewer', act: () => openApp('viewer', { file: e.path }) },
        e.kind === 'image' && { label: 'Image Editor', act: () => openApp('imageeditor', { file: e.path }) },
        PREVIEW.has(e.kind) && { label: 'Preview', act: () => preview(e) },
      ].filter(Boolean);
      showMenu(x, y, [
        { header: 'Open with' },
        ...own,
        own.length && apps.length && '-',
        ...apps.map((a) => ({ label: a.name, key: a.isDefault ? 'Default' : '', act: launch(a) })),
        !own.length && !apps.length && { label: 'No app on this computer opens this file', disabled: true },
      ]);
    }

    function itemMenu(x, y) {
      const items = selected();
      const one = items.length === 1 ? items[0] : null;
      if (cur === TRASH)
        return showMenu(x, y, [
          { label: 'Put back', act: () => restoreItems(items) },
          one && PREVIEW.has(one.kind) && { label: 'Preview', key: 'Space', act: () => preview(one) },
          '-',
          { label: 'Delete for good…', act: () => deleteForever(items) },
        ]);
      showMenu(x, y, [
        one && { label: PREVIEW.has(one.kind) && one.kind !== 'image' && !WEB_PAGE.test(one.name) ? 'Preview' : 'Open', key: 'Enter', act: () => open(one) },
        one && (one.kind === 'image' || WEB_PAGE.test(one.name)) && { label: 'Preview', key: 'Space', act: () => preview(one) },
        one && !one.dir && { label: 'Open with…', act: () => openWithMenu(one, x, y) },
        canPrint(one) && { label: 'Print…', key: 'Ctrl+P', act: () => printFile(one) },
        items.every(isArchive) && { label: one ? 'Extract here' : `Extract ${items.length} archives here`, act: () => extract(items) },
        one?.dir && { label: 'Open in Terminal', act: () => openApp('terminal', { cwd: one.path }) },
        results && one && { label: 'Show in its folder', act: () => go(one.path.slice(0, -one.name.length - 1) || '/', { select: one.path }) },
        '-',
        { label: 'Cut', key: 'Ctrl+X', act: () => copy(true) },
        { label: 'Copy', key: 'Ctrl+C', act: () => copy(false) },
        one?.dir && clip && { label: 'Paste into folder', act: () => pasteInto(one.path) },
        { label: 'Duplicate', act: () => pasteInto(cur, items.map((e) => e.path), false) },
        { label: 'Copy location', act: () => shell.files.copyPath(items.map((e) => e.path)).then(() => toast('Location copied')) },
        '-',
        one && { label: 'Rename…', key: 'F2', act: () => startRename(one.path) },
        { label: 'Move to Trash', key: 'Delete', act: () => toTrash(items) },
      ]);
    }
    function folderMenu(x, y) {
      if (cur === TRASH) return showMenu(x, y, [{ label: 'Empty Trash…', disabled: !entries.length, act: () => deleteForever('all') }]);
      showMenu(x, y, [
        { label: 'New folder', key: 'Ctrl+Shift+N', disabled: !writable, act: newFolder },
        { label: 'Paste', key: 'Ctrl+V', disabled: !clip || !writable, act: () => pasteInto() },
        { label: 'Open in Terminal', act: () => openApp('terminal', { cwd: cur }) },
        '-',
        { header: 'Sort by' },
        ...[['name', 'Name'], ['mtime', 'Date modified'], ['added', 'Date added'], ['size', 'Size'], ['kind', 'Kind']].map(([k, l]) => ({ label: l, checked: sortKey === k, act: () => setSort(k) })),
        '-',
        { label: 'Show hidden files', key: 'Ctrl+H', checked: hidden, act: toggleHidden },
      ]);
    }
    const setSort = (k) => {
      sortDir = sortKey === k ? -sortDir : k === 'mtime' || k === 'added' ? -1 : 1;
      sortKey = k;
      const { pre } = sortPref(cur);
      setPref(`${pre}sort`, k);
      setPref(`${pre}sortDir`, sortDir);
      draw();
    };
    const toggleHidden = () => {
      hidden = !hidden;
      setPref('hidden', hidden ? '1' : '0');
      draw();
    };

    /* ---------------- events ---------------- */

    win.body.addEventListener('click', (e) => {
      const ej = e.target.closest('[data-eject]');
      if (ej) return void removeDrive(ej);
      const m = e.target.closest('[data-mount]');
      if (m) return void shell.files.mountDrive(m.dataset.mount).then((where) => where && go(where), err);
      const g = e.target.closest('[data-go]');
      if (g) return void go(g.dataset.go);
      const s = e.target.closest('[data-sort]');
      if (s) return setSort(s.dataset.sort);
      const a = e.target.closest('[data-fm]')?.dataset.fm;
      if (a === 'back' && back.length) {
        forward.push(cur);
        load(back.pop());
      } else if (a === 'forward' && forward.length) {
        back.push(cur);
        load(forward.pop());
      } else if (a === 'up' && cur !== TRASH && cur !== '/') go(cur.replace(/\/[^/]+\/?$/, '') || '/', { select: cur });
      else if (a === 'view') {
        view = view === 'grid' ? 'list' : 'grid';
        setPref('view', view);
        draw();
      } else if (a === 'more') {
        const r = e.target.closest('button').getBoundingClientRect();
        folderMenu(r.right - 220, r.bottom + 4);
      } else if (a === 'empty-trash') deleteForever('all');
    });

    listEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.fm-rename')) return;
      const item = e.target.closest('.fm-item');
      if (!item) {
        if (!e.target.closest('.fm-head')) startBand(e);
        return;
      }
      // In the list, the columns beside the name start a box too (a click there still picks the row), as in Windows.
      if (view === 'list' && !e.target.closest('.fm-name, .fm-thumb')) return startBand(e, item);
      // A click on an already selected item keeps the selection, so it can be dragged as a group.
      if (!sel.has(item.dataset.path) || e.ctrlKey || e.shiftKey) pick(item.dataset.path, e);
    });
    /** Drag a box from an empty spot to select the items it touches, like Windows (Ctrl or Shift adds to the selection).
     * It scrolls the list when dragged past its top or bottom edge. */
    function startBand(e, from = null) {
      e.preventDefault(); // no text selection, and no native drag
      listEl.focus({ preventScroll: true });
      const origin = () => listEl.getBoundingClientRect();
      // The start point in the list's content, so it stays put as the list scrolls.
      const o0 = origin();
      const sx = e.clientX - o0.left + listEl.scrollLeft;
      const sy = e.clientY - o0.top + listEl.scrollTop;
      const keep = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(sel) : new Set();
      let band = null;
      let last = e;
      const paint = () => {
        const o = origin();
        const cx = Math.min(Math.max(last.clientX, o.left), o.right) - o.left + listEl.scrollLeft;
        const cy = Math.min(Math.max(last.clientY, o.top), o.bottom) - o.top + listEl.scrollTop;
        const r = { left: Math.min(sx, cx), top: Math.min(sy, cy), right: Math.max(sx, cx), bottom: Math.max(sy, cy) };
        // Drawn on the page (fixed), clipped to the list's visible part.
        const top = Math.max(r.top - listEl.scrollTop + o.top, o.top);
        const bottom = Math.min(r.bottom - listEl.scrollTop + o.top, o.bottom);
        const left = r.left - listEl.scrollLeft + o.left;
        Object.assign(band.style, { left: `${left}px`, top: `${top}px`, width: `${r.right - r.left}px`, height: `${Math.max(0, bottom - top)}px` });
        sel = new Set(keep);
        for (const it of $$('.fm-item', listEl)) {
          const b = it.getBoundingClientRect();
          const x = b.left - o.left + listEl.scrollLeft;
          const y = b.top - o.top + listEl.scrollTop;
          const hit = x < r.right && x + b.width > r.left && y < r.bottom && y + b.height > r.top;
          if (hit) sel.add(it.dataset.path);
          it.classList.toggle('sel', sel.has(it.dataset.path));
          it.setAttribute('aria-selected', sel.has(it.dataset.path));
        }
      };
      // Past the top or bottom edge: keep scrolling, faster the further out.
      const scroller = setInterval(() => {
        if (!band) return;
        const o = origin();
        const d = last.clientY < o.top ? last.clientY - o.top : last.clientY > o.bottom ? last.clientY - o.bottom : 0;
        if (!d) return;
        listEl.scrollTop += Math.sign(d) * Math.min(40, 4 + Math.abs(d) / 3);
        paint();
      }, 30);
      const move = (ev) => {
        last = ev;
        if (!band) {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
          band = document.body.appendChild(el('<div class="d-band"></div>'));
        }
        paint();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        clearInterval(scroller);
        band?.remove();
        if (!band && from) return pick(from.dataset.path, e);
        if (!band) sel = keep.size ? keep : new Set(); // a plain click on an empty spot clears the selection
        const shownSel = shown().filter((x) => sel.has(x.path));
        if (band && shownSel.length) anchor = shownSel[0].path;
        draw();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.fm-item');
      if (item && sel.size > 1 && sel.has(item.dataset.path) && !e.ctrlKey && !e.shiftKey) pick(item.dataset.path);
    });
    listEl.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.fm-item');
      if (item && !e.target.closest('.fm-rename')) open(shown().find((x) => x.path === item.dataset.path));
    });
    listEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const item = e.target.closest('.fm-item');
      if (item) {
        if (!sel.has(item.dataset.path)) pick(item.dataset.path);
        itemMenu(e.clientX, e.clientY);
      } else folderMenu(e.clientX, e.clientY);
    });

    win.body.addEventListener('keydown', (e) => {
      if (e.target.matches('input')) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const one = selected()[0];
      if (!previewEl.hidden) {
        if (k === ' ' || k === 'Escape') closePreview();
        else if (k === 'ArrowRight' || k === 'ArrowDown') previewStep(1);
        else if (k === 'ArrowLeft' || k === 'ArrowUp') previewStep(-1);
        else return;
        return e.preventDefault();
      }
      if (e.altKey && k === 'ArrowLeft') $('[data-fm="back"]', win.body).click();
      else if (e.altKey && k === 'ArrowRight') $('[data-fm="forward"]', win.body).click();
      else if ((e.altKey && k === 'ArrowUp') || k === 'Backspace') $('[data-fm="up"]', win.body).click();
      else if (k === 'Enter') open(one);
      else if (k === ' ') preview(one);
      else if (k === 'F2' && one) startRename(one.path);
      else if (k === 'Delete' && e.shiftKey) deleteForever(selected());
      else if (k === 'Delete') toTrash();
      else if (ctrl && k.toLowerCase() === 'a') {
        sel = new Set(shown().map((x) => x.path));
        draw();
      } else if (ctrl && k.toLowerCase() === 'c') copy(false);
      else if (ctrl && k.toLowerCase() === 'x') copy(true);
      else if (ctrl && k.toLowerCase() === 'v') pasteInto();
      else if (ctrl && e.shiftKey && k.toLowerCase() === 'n') newFolder();
      else if (ctrl && k.toLowerCase() === 'h') toggleHidden();
      else if (ctrl && k.toLowerCase() === 'f') searchIn.focus();
      else if (ctrl && k.toLowerCase() === 'l') editLocation();
      else if (k === 'ArrowDown') moveSel(view === 'grid' ? 2 : 1, e.shiftKey);
      else if (k === 'ArrowUp') moveSel(view === 'grid' ? -2 : -1, e.shiftKey);
      else if (k === 'ArrowRight' && view === 'grid') moveSel(1, e.shiftKey);
      else if (k === 'ArrowLeft' && view === 'grid') moveSel(-1, e.shiftKey);
      else if (k === 'Escape' && sel.size) {
        sel = new Set();
        draw();
      } else return;
      e.preventDefault();
    });

    /** Type a location: double-click the path, or Ctrl+L. ~ is your home folder. */
    function editLocation() {
      crumbs.innerHTML = `<input class="fm-loc" value="${esc(cur === TRASH ? '' : cur)}" spellcheck="false" aria-label="Location">`;
      const input = $('input', crumbs);
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go(input.value.trim().replace(/^~(?=\/|$)/, places?.home || '~') || '/');
        if (e.key === 'Escape') drawCrumbs();
      });
      input.addEventListener('blur', () => setTimeout(drawCrumbs, 100));
    }
    crumbs.addEventListener('dblclick', (e) => !e.target.closest('.fm-crumb') && editLocation());

    /* Drag to move (Ctrl copies): onto folders, the places on the side, the path above, or another Files window. */
    win.body.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.fm-item');
      if (!item) return;
      if (!sel.has(item.dataset.path)) pick(item.dataset.path);
      const paths = selected().map((x) => x.path);
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    const dropTarget = (e) => e.target.closest('[data-drop]')?.dataset.drop || (e.target.closest('.fm-list') && cur !== TRASH && !results ? cur : null);
    win.body.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      const t = dropTarget(e);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = t === TRASH ? 'move' : e.ctrlKey ? 'copy' : 'move';
      $$('.drop-over', win.body).forEach((x) => x.classList.remove('drop-over'));
      e.target.closest('[data-drop]')?.classList.add('drop-over');
    });
    win.body.addEventListener('dragleave', (e) => e.target.closest?.('[data-drop]')?.classList.remove('drop-over'));
    win.body.addEventListener('drop', async (e) => {
      $$('.drop-over', win.body).forEach((x) => x.classList.remove('drop-over'));
      const t = dropTarget(e);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (!t || !raw) return;
      e.preventDefault();
      const paths = JSON.parse(raw).filter((p) => p !== t);
      if (!paths.length) return;
      if (t === TRASH) return toTrash(shown().filter((x) => paths.includes(x.path)));
      pasteInto(t, paths, !e.ctrlKey);
    });

    shell.on('files:changed', ({ dir }) => {
      if (win.el.isConnected && (dir === cur || (cur === TRASH && dir === places?.trash)) && !renaming) reload();
    });
    win.cleanups.push(() => watching && shell.files.unwatch(watching));

    // Drives come and go. If the one this window is showing went (removed here, or just pulled out), it goes home.
    const onDrive = (p) => cur === p || cur?.startsWith(`${p}/`);
    win.cleanups.push(shell.on('files:drives', async () => {
      if (!win.el.isConnected || !places) return;
      const was = places.drives;
      places = await shell.files.places().catch(() => places);
      if (was.some((d) => onDrive(d.path) && !places.drives.some((n) => n.path === d.path))) await go(places.home);
      else drawSide();
    }));
    const removeDrive = async (btn) => {
      btn.disabled = true;
      try {
        const name = await shell.files.ejectDrive(btn.dataset.eject);
        toast(`“${name}” is safe to remove`);
      } catch (e) {
        err(e);
        btn.disabled = false;
      }
    };

    // Ctrl+P and File → Print: the file in the preview, or the one selected.
    const toPrint = () => previewing || (selected().length === 1 ? selected()[0] : null);
    win.print = { can: () => canPrint(toPrint()), run: () => printFile(toPrint()) };

    win.files = {
      /** The folder this window shows, for things dropped on it from the desktop (null in the Trash or search results). */
      folder: () => (cur && cur !== TRASH && !results && writable ? cur : null),
      reload: () => cur && load(cur),
      /** Open the folder a file is in, with the file selected (or a folder itself). */
      async reveal(p) {
        revealing = true;
        if (!places) places = await shell.files.places().catch(() => null);
        const list = await shell.files.list(p).catch(() => null);
        if (list) return go(p);
        await go(p.replace(/\/[^/]+$/, '') || '/', { select: p });
      },
      /** Open a file the way double-clicking it here would: a preview, Image Viewer, or the computer's app for it. */
      async open(p) {
        await this.reveal(p);
        const e = entries.find((x) => x.path === p);
        if (e && !e.dir) await open(e);
      },
    };

    (async () => {
      places = await shell.files.places().catch(() => ({ folders: [], drives: [], computer: { name: 'This computer', path: '/' }, home: '/' }));
      if (!cur && !revealing) await go(places.home, { push: false });
      else drawSide();
      listEl.focus();
    })();
  },
});
