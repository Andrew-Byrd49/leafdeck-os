// The Claude Code app's Changes panel: what the session's folder has changed against its last commit (git), file by
// file, each opening to its diff. It refreshes as Claude edits and runs commands, and can ask Claude to commit or review.
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { unifiedHtml } from './diff.js';

const STATUS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed' };

/** opts: { git(), diff(file), ask(text): send Claude a message, openFile(path relative to the repo) } */
export function createChanges(opts) {
  const el = document.createElement('div');
  el.className = 'ccc';
  el.innerHTML = `<div class="ccc-head"><b>Changes</b><small class="ccc-sum"></small><span class="grow"></span>
      <button class="tb-btn" data-ccc="refresh" title="Refresh">${icon('refresh', 13)}</button></div>
    <div class="ccc-list"></div>
    <div class="ccc-foot" hidden><button class="btn small" data-ccc="review">${icon('eye', 12)} Review</button><button class="btn small primary" data-ccc="commit">${icon('tick', 12)} Commit…</button></div>`;
  const list = el.querySelector('.ccc-list');
  const open = new Set(); // files whose diff is shown
  let data = null;
  let busy = false;
  let again = false;
  let top = '';

  async function refresh() {
    if (busy) return void (again = true);
    busy = true;
    try {
      data = await opts.git();
    } catch (err) {
      data = { error: err.message };
    }
    busy = false;
    draw();
    opts.counted?.();
    if (again) {
      again = false;
      refresh();
    }
  }
  let t = 0;
  const soon = () => {
    clearTimeout(t);
    t = setTimeout(refresh, 600);
  };

  function draw() {
    const sum = el.querySelector('.ccc-sum');
    const foot = el.querySelector('.ccc-foot');
    if (data?.error) {
      sum.textContent = '';
      foot.hidden = true;
      list.innerHTML = `<p class="ccc-none">${esc(data.error)}</p>`;
      return;
    }
    if (!data?.repo) {
      sum.textContent = '';
      foot.hidden = true;
      list.innerHTML = `<p class="ccc-none">${icon('folder', 16)}<br>This folder isn’t a git repository, so there’s no diff to show. Claude’s edits still show in the chat.</p>`;
      return;
    }
    top = data.top || '';
    const files = data.files || [];
    const add = files.reduce((n, f) => n + (f.add || 0), 0);
    const del = files.reduce((n, f) => n + (f.del || 0), 0);
    sum.innerHTML = `${data.branch ? `${icon('branch', 11)} ${esc(data.branch)}` : 'Detached'}${files.length ? ` · ${files.length} file${files.length === 1 ? '' : 's'} <b class="add">+${add}</b> <b class="del">−${del}</b>` : ''}`;
    foot.hidden = !files.length;
    if (!files.length) {
      list.innerHTML = `<p class="ccc-none">${icon('tick', 16)}<br>No changes since the last commit${data.ahead ? `; ${data.ahead} commit${data.ahead === 1 ? '' : 's'} not pushed yet` : ''}.</p>`;
      return;
    }
    // Keep what's open (and where the list is scrolled) across refreshes.
    const scroll = list.scrollTop;
    const old = new Map([...list.querySelectorAll('.ccc-file')].map((n) => [n.dataset.file, n]));
    list.innerHTML = '';
    for (const f of files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const name = dir ? f.path.slice(dir.length + 1) : f.path;
      const key = `${f.status}:${f.add}:${f.del}`;
      const prev = old.get(f.path);
      const node = document.createElement('div');
      node.className = `ccc-file${open.has(f.path) ? ' open' : ''}`;
      node.dataset.file = f.path;
      node.innerHTML = `<button class="ccc-row" title="${esc(STATUS[f.status] || '')}: ${esc(f.path)}"><span class="ccc-st st-${esc(f.status)}">${esc(f.status)}</span>
          <span class="ccc-name"><b>${esc(name)}</b><small>${esc(dir)}</small></span>
          ${f.binary ? '<small>binary</small>' : `<span class="ccc-n"><b class="add">+${f.add}</b> <b class="del">−${f.del}</b></span>`}
          <span class="ccc-open" data-open title="Open the file">${icon('external', 11)}</span></button><div class="ccc-diff"></div>`;
      list.append(node);
      if (open.has(f.path)) {
        // Reuse the diff when the file hasn't changed since; fetch it again when it has.
        if (prev && prev._key === key && prev.querySelector('.ccc-diff').innerHTML) node.querySelector('.ccc-diff').innerHTML = prev.querySelector('.ccc-diff').innerHTML;
        else loadDiff(node);
      }
      node._key = key;
    }
    list.scrollTop = scroll;
  }
  async function loadDiff(node) {
    const box = node.querySelector('.ccc-diff');
    box.innerHTML = '<div class="ccc-loading">Loading…</div>';
    try {
      box.innerHTML = unifiedHtml(await opts.diff(node.dataset.file));
    } catch (err) {
      box.innerHTML = `<p class="ccc-none">${esc(err.message)}</p>`;
    }
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ccc]');
    if (b?.dataset.ccc === 'refresh') return refresh();
    if (b?.dataset.ccc === 'commit') return opts.ask?.('Commit the current changes with a clear commit message. Check `git status` and the diff first, and leave out anything that shouldn’t be committed.');
    if (b?.dataset.ccc === 'review') return opts.ask?.('Review my uncommitted changes (git diff against HEAD) for bugs and anything I missed. Don’t change files; just report.');
    const file = e.target.closest('.ccc-file');
    if (e.target.closest('[data-open]') && file) {
      e.stopPropagation();
      return opts.openFile?.(top ? `${top}/${file.dataset.file}` : file.dataset.file);
    }
    if (e.target.closest('.ccc-row') && file) {
      const f = file.dataset.file;
      if (open.has(f)) {
        open.delete(f);
        file.classList.remove('open');
      } else {
        open.add(f);
        file.classList.add('open');
        loadDiff(file);
      }
    }
  });

  return { el, refresh, soon, count: () => data?.files?.length || 0 };
}
