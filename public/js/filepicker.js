// Leafdeck's file picker: what every "Open…", "Save…" and upload button on the computer shows in Leafdeck OS (the
// desktop portal's FileChooser, electron/desktop-helper.py), instead of GTK's. Your places on the left, the folder's
// contents as icons (pictures show themselves) or a list, and for saving, the name. It's the Files app's view of the
// disk (shell.files), in a dialog.
import { $, el, esc } from './util.js';
import { icon } from './icons.js';
import { shell } from './shell.js';
import { ask, confirmDialog } from './dialogs.js';
import { thumb, tile } from './filethumb.js';

const LAST = 'picker:folder'; // the folder you last picked from
const VIEW = 'picker:view'; // icons or a list
const stored = (k) => {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
};
const store = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const KIND_ICON = { folder: 'folder', image: 'image', video: 'play', audio: 'volume', pdf: 'note', text: 'note', code: 'note', archive: 'archive', doc: 'note', sheet: 'grid', slides: 'layout' };
const ARROWS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
const join = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const size = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);
const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

// A glob ("*.png", "*.[Jj][Pp][Gg]", "Makefile") as a test of a file name; matched without regard to case.
function globTest(glob) {
  if (glob === '*') return () => true;
  const re = '^' + glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  try {
    const r = new RegExp(re, 'i');
    return (name) => r.test(name);
  } catch {
    return () => false;
  }
}

/**
 * Pick files. mode: 'open' | 'save' | 'save-files'. Resolves { paths, filter } or null.
 *   multiple, directory (open), name (save), files (save-files: the names being saved), folder (where to start),
 *   filters [{ name, globs }], currentFilter (its name), title, accept (the button's label)
 *   onClose(fn): gets a function that closes the picker unanswered
 */
export async function pickFiles(o) {
  const places = await shell.files.places().catch(() => ({ folders: [], drives: [], home: '/' }));
  const saving = o.mode !== 'open';
  const dirOnly = o.mode === 'save-files' || (!saving && o.directory);
  const filters = o.filters || [];
  let filter = filters.find((f) => f.name === o.currentFilter) || filters[0] || null;
  let test = null;
  const setFilter = (f) => {
    filter = f;
    const tests = f ? f.globs.map(globTest) : [];
    test = f ? (name) => tests.some((t) => t(name)) : () => true;
  };
  setFilter(filter);

  let dir = '';
  let entries = [];
  let selected = new Set();
  let anchor = null;
  let view = stored(VIEW) === 'list' ? 'list' : 'grid';
  const back = [];

  const body = el(`<div class="fp${saving ? ' saving' : ''}">
    ${o.mode === 'save' ? `<label class="field fp-name"><span>Save as</span><input name="fp-name" value="${esc(o.name || '')}" autocomplete="off" spellcheck="false"></label>` : ''}
    <div class="fp-wrap">
      <nav class="fp-side" aria-label="Places">
        ${places.folders.map((p) => `<button type="button" class="fp-place" data-go="${esc(p.path)}">${icon(p.id === 'home' ? 'user' : p.id === 'downloads' ? 'download' : p.id === 'pictures' ? 'image' : 'folder', 14)}<span>${esc(p.name)}</span></button>`).join('')}
        ${places.drives.length ? `<div class="fp-side-head">Drives</div>${places.drives.map((d) => `<button type="button" class="fp-place" data-go="${esc(d.path)}">${icon('archive', 14)}<span>${esc(d.name)}</span></button>`).join('')}` : ''}
        <button type="button" class="fp-place" data-go="/">${icon('display', 14)}<span>This computer</span></button>
      </nav>
      <section class="fp-main">
        <div class="fp-bar">
          <button type="button" class="tb-btn" data-act="back" title="Back">${icon('left', 15)}</button>
          <button type="button" class="tb-btn" data-act="up" title="Enclosing folder">${icon('up', 15)}</button>
          <div class="fp-path" title="Type a location"><input name="fp-path" spellcheck="false" autocomplete="off" aria-label="Location"></div>
          <button type="button" class="tb-btn" data-act="view"></button>
          ${saving || dirOnly ? `<button type="button" class="tb-btn" data-act="mkdir" title="New folder">${icon('plus', 15)}</button>` : ''}
        </div>
        <div class="fp-list" role="listbox" tabindex="0" ${o.multiple ? 'aria-multiselectable="true"' : ''}></div>
        ${filters.length > 1 ? `<div class="fp-foot"><select name="fp-filter" aria-label="File types">${filters.map((f, i) => `<option value="${i}"${f === filter ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>` : ''}
      </section>
    </div>
  </div>`);
  const list = $('.fp-list', body);
  const pathIn = $('[name="fp-path"]', body);
  const nameIn = $('[name="fp-name"]', body);
  let api = null;

  const visible = () =>
    entries
      .filter((e) => !e.hidden && (e.dir || (!dirOnly && test(e.name))))
      .sort((a, b) => b.dir - a.dir || byName.compare(a.name, b.name));

  function draw() {
    const items = visible();
    const grid = view === 'grid';
    list.classList.toggle('fp-grid', grid);
    const toggle = $('[data-act="view"]', body);
    toggle.innerHTML = icon(grid ? 'list' : 'grid', 15);
    toggle.title = grid ? 'Show as a list' : 'Show as icons';
    list.innerHTML = items.length
      ? items
          .map((e) => {
            const about = e.dir ? '' : size(e.size);
            const open = `<div class="fp-item${selected.has(e.path) ? ' on' : ''}${e.dir ? ' dir' : ''}" role="option" data-path="${esc(e.path)}"`;
            return grid
              ? `${open} title="${esc([e.name, about, when(e.mtime)].filter(Boolean).join(' · '))}">${thumb(e)}<span class="fp-n">${esc(e.name)}</span></div>`
              : `${open}>${icon(KIND_ICON[e.kind] || 'note', 15)}<span class="fp-n">${esc(e.name)}</span>
              <span class="fp-s">${about}</span><span class="fp-d">${when(e.mtime)}</span></div>`;
          })
          .join('')
      : `<div class="fp-empty">${dirOnly ? 'No folders here' : filter && filters.length ? `No ${esc(filter.name.toLowerCase())} here` : 'This folder is empty'}</div>`;
    for (const b of body.querySelectorAll('.fp-place')) b.classList.toggle('on', b.dataset.go === dir);
    updateButton();
  }

  // Selection changes only what's marked: drawing again would make every picture load again.
  function mark() {
    for (const it of list.querySelectorAll('.fp-item')) it.classList.toggle('on', selected.has(it.dataset.path));
    updateButton();
  }

  async function go(to, push = true) {
    try {
      const r = await shell.files.list(to);
      if (push && dir && r.path !== dir) back.push(dir);
      dir = r.path;
      entries = r.entries;
      selected = new Set();
      anchor = null;
      pathIn.value = dir;
      api?.setError('');
      draw();
      list.scrollTop = 0;
    } catch (e) {
      api?.setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      pathIn.value = dir;
    }
  }

  function updateButton() {
    const b = api && $('.btn.primary', api.el);
    if (!b) return;
    const sel = [...selected].map((p) => entries.find((e) => e.path === p)).filter(Boolean);
    if (o.mode === 'save') b.disabled = !nameIn.value.trim();
    else if (dirOnly) b.disabled = !dir;
    else b.disabled = !sel.length;
  }

  const itemAt = (t) => t.closest('.fp-item');
  list.addEventListener('click', (e) => {
    const it = itemAt(e.target);
    if (!it) return;
    const p = it.dataset.path;
    const ent = entries.find((x) => x.path === p);
    if (o.multiple && (e.ctrlKey || e.metaKey)) {
      if (selected.has(p)) selected.delete(p);
      else selected.add(p);
    } else if (o.multiple && e.shiftKey && anchor) {
      const items = visible().map((x) => x.path);
      const [a, b] = [items.indexOf(anchor), items.indexOf(p)].sort((x, y) => x - y);
      selected = new Set(items.slice(a, b + 1));
    } else selected = new Set([p]);
    anchor = p;
    if (o.mode === 'save' && ent && !ent.dir) nameIn.value = ent.name;
    mark();
  });
  // A picture the browser can't show (HEIC, TIFF, a damaged file) gets the page with its extension instead.
  list.addEventListener(
    'error',
    (e) => {
      const it = e.target.tagName === 'IMG' && itemAt(e.target);
      const ent = it && entries.find((x) => x.path === it.dataset.path);
      if (ent) e.target.closest('.fm-thumb').outerHTML = tile(ent);
    },
    true,
  );
  list.addEventListener('dblclick', (e) => {
    const it = itemAt(e.target);
    if (!it) return;
    const ent = entries.find((x) => x.path === it.dataset.path);
    if (ent?.dir) return go(ent.path);
    if (ent) {
      selected = new Set([ent.path]);
      if (o.mode === 'save') nameIn.value = ent.name;
      $('.btn.primary', api.el)?.click();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      go(dir.replace(/\/[^/]+\/?$/, '') || '/');
    } else if (e.key in ARROWS && (view === 'grid' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = visible();
      const i = items.findIndex((x) => x.path === anchor);
      const across = view === 'grid' ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 1;
      let to = i + ARROWS[e.key] * (e.key === 'ArrowDown' || e.key === 'ArrowUp' ? across : 1);
      // Down into a shorter last row lands on its last item; past the ends it stays.
      if (to >= items.length && Math.floor(i / across) < Math.floor((items.length - 1) / across)) to = items.length - 1;
      const next = i < 0 ? items[0] : items[to] || items[i];
      if (!next) return;
      selected = new Set([next.path]);
      anchor = next.path;
      mark();
      list.querySelector('.fp-item.on')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const ent = entries.find((x) => x.path === anchor);
      e.preventDefault();
      if (ent?.dir && selected.size === 1) go(ent.path);
      else if (selected.size) $('.btn.primary', api.el)?.click();
    }
  });
  body.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-go]');
    if (g) return go(g.dataset.go);
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'back' && back.length) go(back.pop(), false);
    else if (a === 'up' && dir !== '/') go(dir.replace(/\/[^/]+\/?$/, '') || '/');
    else if (a === 'view') {
      view = view === 'grid' ? 'list' : 'grid';
      store(VIEW, view);
      draw();
    } else if (a === 'mkdir') {
      const r = await ask({ now: true, title: 'New folder', fields: [{ name: 'name', label: 'Name', value: 'New folder' }], buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
      if (!r?.values.name.trim()) return;
      try {
        const made = await shell.files.mkdir(dir, r.values.name.trim());
        await go(made);
      } catch (err) {
        api?.setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
    }
  });
  pathIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    go(pathIn.value.trim().replace(/^~(?=\/|$)/, places.home));
  });
  nameIn?.addEventListener('input', updateButton);
  $('[name="fp-filter"]', body)?.addEventListener('change', (e) => {
    setFilter(filters[Number(e.target.value)]);
    draw();
  });

  let result = null;
  const answer = await ask({
    title: o.title || (o.mode === 'open' ? (o.directory ? 'Choose a folder' : o.multiple ? 'Choose files' : 'Choose a file') : 'Save'),
    wide: true,
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: o.accept || (saving ? 'Save' : dirOnly ? 'Select' : 'Open'), value: 'ok', primary: true }],
    onMount: (a) => {
      api = a;
      a.el.classList.add('fp-dialog');
      o.onClose?.(() => a.close(null)); // the program gave up waiting
      go(o.folder || stored(LAST) || places.folders.find((p) => p.id === 'downloads')?.path || places.home, false).then(() => (nameIn || list).focus());
      if (nameIn) {
        // The name is selected up to its extension, ready to type over.
        const dot = nameIn.value.lastIndexOf('.');
        requestAnimationFrame(() => nameIn.setSelectionRange(0, dot > 0 ? dot : nameIn.value.length));
      }
    },
    check: async () => {
      const sel = [...selected].map((p) => entries.find((e) => e.path === p)).filter(Boolean);
      if (o.mode === 'save') {
        const name = nameIn.value.trim();
        if (/[/]/.test(name)) return api.setError('A name can’t have a “/” in it.'), false;
        const there = entries.find((e) => e.name === name);
        if (there?.dir) return go(there.path).then(() => false);
        if (there && !(await confirmDialog(`“${name}” already exists. Replace it?`, { ok: 'Replace', danger: true, now: true }))) return false;
        result = { paths: [join(dir, name)] };
      } else if (o.mode === 'save-files') {
        const into = sel.length === 1 && sel[0].dir ? sel[0].path : dir;
        result = { paths: (o.files || []).map((n) => join(into, n)) };
      } else if (dirOnly) {
        result = { paths: [sel.length === 1 && sel[0].dir ? sel[0].path : dir] };
      } else {
        if (sel.length === 1 && sel[0].dir) return go(sel[0].path).then(() => false);
        const files = sel.filter((e) => !e.dir);
        if (!files.length) return false;
        result = { paths: files.map((e) => e.path) };
      }
      store(LAST, dir);
      if (filter) result.filter = filter.name;
      return true;
    },
  });
  return answer ? result : null;
}
