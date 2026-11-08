// Downloads — a view of the main process's download manager, plus a progress indicator in the menu bar.

import { $, esc, el } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, openApp, toast } from '../wm.js';
import { confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';

let list = [];
const listeners = new Set();
const speeds = new Map(); // id -> { bytes, at, rate }

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function bytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

function trackSpeed(r) {
  const now = Date.now();
  const prev = speeds.get(r.id);
  if (r.state !== 'progressing' || r.paused) return speeds.delete(r.id);
  if (!prev) return speeds.set(r.id, { bytes: r.received, at: now, rate: 0 });
  const dt = (now - prev.at) / 1000;
  if (dt < 0.5) return;
  const inst = (r.received - prev.bytes) / dt;
  speeds.set(r.id, { bytes: r.received, at: now, rate: prev.rate ? prev.rate * 0.6 + inst * 0.4 : inst });
}

function statusLine(r) {
  const from = hostOf(r.url) ? ` · ${hostOf(r.url)}` : '';
  if (r.state === 'progressing') {
    const rate = speeds.get(r.id)?.rate || 0;
    const of = r.total ? `${bytes(r.received)} of ${bytes(r.total)}` : bytes(r.received);
    if (r.paused) return `Paused · ${of}`;
    const left = r.total && rate ? ` · ${Math.max(1, Math.round((r.total - r.received) / rate))}s left` : '';
    return `${of}${rate ? ` · ${bytes(rate)}/s` : ''}${left}`;
  }
  if (r.state === 'completed') return `${bytes(r.received || r.total)}${from}`;
  if (r.state === 'cancelled') return `Canceled${from}`;
  return `Failed${from}`;
}

function update(next) {
  const before = new Map(list.map((r) => [r.id, r.state]));
  list = next;
  for (const r of list) {
    trackSpeed(r);
    if (before.get(r.id) === 'progressing' && r.state === 'completed') toast(`Downloaded ${r.filename}`);
    if (before.get(r.id) === 'progressing' && r.state === 'interrupted') toast(`Download failed: ${r.filename}`, 'error');
  }
  listeners.forEach((fn) => fn(list));
}

async function act(r, action) {
  try {
    const res = await shell.downloads.act(r.id, action);
    if (res?.reveal) return void openApp('files', { reveal: res.reveal });
    if (res?.open) return void openApp('files', { open: res.open });
    if (res?.needsConfirm) {
      const ok = await confirmDialog(`“${r.filename}” can run programs or change your computer.\n\nOnly open it if you trust ${hostOf(r.url) || 'where it came from'}. Open it anyway?`, { ok: 'Open', danger: true });
      const again = ok && (await shell.downloads.act(r.id, action, { confirmed: true }));
      if (again?.open) openApp('files', { open: again.open });
    }
  } catch (err) {
    toast(cleanError(err), 'error');
  }
}

/* ---------------- Menu bar indicator ---------------- */

export function initDownloadIndicator() {
  if (!shell) return;
  const btn = el(`<button class="mb-dl" title="Downloads (Ctrl+J)" hidden>
    <svg class="mb-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><circle class="mb-ring-fill" cx="10" cy="10" r="8"/></svg>
    ${icon('download', 12, 2.2)}</button>`);
  $('#menubar .mb-right')?.prepend(btn);
  btn.addEventListener('click', () => openApp('downloads'));
  const ring = $('.mb-ring-fill', btn);
  const C = 2 * Math.PI * 8;
  ring.style.strokeDasharray = C;
  let hideTimer;
  listeners.add(() => {
    const active = list.filter((r) => r.state === 'progressing');
    const total = active.reduce((t, r) => t + (r.total || 0), 0);
    const got = active.reduce((t, r) => t + (r.received || 0), 0);
    const recent = list.some((r) => r.endedAt && Date.now() - r.endedAt < 8000);
    btn.classList.toggle('active', !!active.length);
    ring.style.strokeDashoffset = active.length && total ? C * (1 - got / total) : active.length ? C * 0.75 : 0;
    clearTimeout(hideTimer);
    if (active.length || recent) btn.hidden = false;
    else hideTimer = setTimeout(() => (btn.hidden = true), 8000);
  });
  shell.downloads.list().then(update).catch(() => {});
  shell.on('shell:downloads', update);
}

/* ---------------- Downloads app ---------------- */

const STATE_ICON = { completed: 'tick', cancelled: 'x', interrupted: 'flag', progressing: 'download' };

registerApp({
  id: 'downloads',
  name: 'Downloads',
  icon: 'download',
  size: [760, 560],
  min: [460, 320],
  mount(win) {
    if (!shell) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Downloads live in the Leafdeck app</div>
        <p>In the web version, your browser handles downloads.</p></div>`;
      return;
    }
    win.tools.innerHTML = `<button class="tb-pill" data-dl-folder>${icon('inbox', 12)} Open folder</button>
      <button class="tb-pill" data-dl-clear>Clear finished</button>`;

    const draw = () => {
      if (!list.length) {
        win.body.innerHTML = `<div class="empty"><div class="empty-title">No downloads yet</div>
          <p>Files you download are saved to your Downloads folder and listed here.</p></div>`;
        return;
      }
      win.body.innerHTML = `<div class="dl-list">${list
        .map((r) => {
          const pct = r.total ? Math.round((r.received / r.total) * 100) : 0;
          const actions =
            r.state === 'progressing'
              ? `<button class="icon-btn" data-dl="${r.paused ? 'resume' : 'pause'}" title="${r.paused ? 'Resume' : 'Pause'}">${icon(r.paused ? 'play' : 'stop', 12)}</button>
                 <button class="icon-btn" data-dl="cancel" title="Cancel">${icon('x', 13)}</button>`
              : r.state === 'completed'
                ? `<button class="btn small" data-dl="open">${r.dangerous ? icon('shield', 12) + ' ' : ''}Open</button>
                   <button class="icon-btn" data-dl="show" title="Show in folder">${icon('inbox', 13)}</button>
                   <button class="icon-btn" data-dl="remove" title="Remove from list">${icon('x', 13)}</button>`
                : `<button class="btn small" data-dl="retry">Retry</button>
                   <button class="icon-btn" data-dl="remove" title="Remove from list">${icon('x', 13)}</button>`;
          return `<div class="dl-row s-${r.state}" data-id="${r.id}">
            <span class="dl-icon">${icon(STATE_ICON[r.state] || 'download', 15)}</span>
            <span class="dl-main"><b title="${esc(r.path || r.filename)}">${esc(r.filename)}</b>
              <small>${esc(statusLine(r))}${r.dangerous && r.state === 'completed' ? ' · <span class="txt-yellow">can run code</span>' : ''}</small>
              ${r.state === 'progressing' ? `<span class="progress dl-progress"><i style="width:${r.total ? pct : 30}%" class="${r.total ? '' : 'indeterminate'}"></i></span>` : ''}
            </span>
            <span class="dl-actions">${actions}</span></div>`;
        })
        .join('')}</div>`;
    };

    win.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      const r = b && list.find((x) => x.id === b.closest('[data-id]').dataset.id);
      if (r) act(r, b.dataset.dl);
    });
    win.tools.addEventListener('click', async (e) => {
      if (e.target.closest('[data-dl-clear]')) shell.downloads.clearFinished();
      if (e.target.closest('[data-dl-folder]')) {
        const done = list.find((r) => r.state === 'completed');
        if (done) act(done, 'show');
        else toast('Your Downloads folder opens here once something has downloaded');
      }
    });

    listeners.add(draw);
    win.cleanups.push(() => listeners.delete(draw));
    shell.downloads.list().then(update);
    draw();
  },
});
