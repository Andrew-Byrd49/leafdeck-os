// Settings → Backup: back up to a USB drive, and the reminder. The work is electron/backup.cjs's: the file is the one
// "Move to another computer" makes (passwords, sign-ins, history, settings, apps and your records, locked with a
// passphrase), written into "Leafdeck Backups/<this computer>/" on the drive with the note media copied beside it.
// Restore is the move file's import (public/js/move.js), which finds the backups on a plugged-in drive.
import { shell } from './shell.js';
import { esc, $, el } from './util.js';
import { icon } from './icons.js';
import { toast } from './wm.js';
import { openImportMoveSheet, uiParts } from './move.js';

let host = null;
let win = null;
let data = null; // backup:status
let folder = ''; // the drive (or folder) picked in the list
let busy = false;
let result = ''; // what the last backup from this page did

const plain = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const size = (b) => (b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(1)} GB` : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const row = (label, control, hint = '') =>
  `<div class="set-row"><div><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="set-ctl">${control}</div></div>`;

const EVERY = [
  [0, 'Never'],
  [7, 'Every week'],
  [14, 'Every 2 weeks'],
  [30, 'Every month'],
  [90, 'Every 3 months'],
];

function lastText() {
  if (!data.lastAt) return '<span class="muted">Never</span>';
  const ago = Math.floor((Date.now() - data.lastAt) / 86400_000);
  const pill = data.due ? '<span class="pill pill-yellow">Overdue</span>' : data.everyDays ? '<span class="pill pill-green">Up to date</span>' : '';
  return `${esc(when(data.lastAt))}${data.lastName ? ` to <b>${esc(data.lastName)}</b>` : ''}${data.lastSize ? ` · ${size(data.lastSize)}` : ''}<br><small class="muted">${ago ? `${plural(ago, 'day')} ago` : 'Today'}</small> ${pill}`;
}

function draw() {
  if (!host?.isConnected) return;
  if (!data) return void (host.innerHTML = '<div class="set-group"><div class="set-row"><span class="muted">Loading…</span></div></div>');
  const drives = data.drives || [];
  if (!drives.some((d) => d.path === folder)) folder = (drives.find((d) => d.path === data.lastFolder) || drives[0])?.path || '';
  const picked = drives.find((d) => d.path === folder);
  const every = EVERY.some(([d]) => d === data.everyDays) ? EVERY : [...EVERY, [data.everyDays, `Every ${plural(data.everyDays, 'day')}`]];
  const canRun = !!picked && data.passphrase && !busy;
  host.innerHTML = `<div class="set-group">
    ${row('Last backup', `<span class="bk-last">${lastText()}</span>`)}
    ${row(
      'Back up to',
      `<div class="set-inline">${
        drives.length
          ? `<select data-bk-drive>${drives.map((d) => `<option value="${esc(d.path)}" ${d.path === folder ? 'selected' : ''}>${esc(d.name)}${d.free ? ` — ${size(d.free)} free` : ''}${d.count ? ` · ${plural(d.count, 'backup')}` : ''}</option>`).join('')}</select>`
          : `<span class="muted small">Plug in a USB drive</span>`
      }<button class="btn small" data-bk-folder title="A folder on this computer or a network share, instead of a drive">Choose a folder…</button></div>`,
      'Backups go into “Leafdeck Backups” on the drive, in a folder named after this computer',
    )}
    ${row(
      'Back up now',
      `<button class="btn small primary" data-bk-run ${canRun ? '' : 'disabled'}>${icon('download', 12)} ${busy ? 'Backing up…' : 'Back up now'}</button>`,
      `Passwords, website sign-ins, history, settings, the apps you built and your records, in one file locked with your passphrase. Note images and voice memos are copied as files beside it. The ${data.keep} most recent backups are kept on each drive`,
    )}
    ${row(
      'Passphrase',
      `<div class="set-inline">${data.passphrase ? '<span class="pill pill-green">Set</span>' : '<span class="pill pill-yellow">Not set</span>'}<button class="btn small" data-bk-pass ${data.secrets ? '' : 'disabled'}>${data.passphrase ? 'Change…' : 'Set…'}</button></div>`,
      data.secrets ? 'Needed to open a backup. Leafdeck can’t recover it, so keep it somewhere safe' : 'Sign in with your password (not the PIN) to set it: it’s kept in secure storage',
    )}
    ${row(
      'Remind me',
      `<select data-bk-every>${every.map(([d, l]) => `<option value="${d}" ${d === data.everyDays ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`,
      data.everyDays ? `A notification when it’s been ${plural(data.everyDays, 'day')} since the last backup${data.lastAt ? '' : ' (or since now)'}, and whenever a drive with your backups is plugged in while one is due` : 'A notification when it’s time to back up',
    )}
    ${row('Restore', `<button class="btn small" data-bk-restore>${icon('upload', 12)} Restore from a backup…</button>`, 'Choose a backup on a plugged-in drive and what to bring back from it')}
    ${result ? `<div class="set-row"><div class="imp-result">${result}</div></div>` : ''}
    ${
      picked?.count
        ? `<details class="set-details"><summary>${plural(picked.count, 'backup')} on ${esc(picked.name)}</summary>
      ${picked.last ? row('Latest', `<span>${esc(when(picked.last.modified))} · ${size(picked.last.size)}</span>`, picked.last.name) : ''}
      ${row('Folder', `<span class="set-path">${esc(picked.path)}/Leafdeck Backups/${esc(data.computer)}</span>`)}</details>`
        : ''
    }
  </div>`;
}

async function load() {
  if (!shell?.backup) return;
  try {
    data = await shell.backup.status();
  } catch (err) {
    data = null;
    host.innerHTML = `<div class="set-group"><div class="set-row"><span class="txt-red">${esc(plain(err))}</span></div></div>`;
    return;
  }
  draw();
}

/** Set or change the passphrase: a sheet with it twice. */
function passphraseSheet() {
  const node = el(`<form class="rec-form move">
    <div class="sheet-head"><div><h2>${data.passphrase ? 'Change the backup passphrase' : 'Choose a backup passphrase'}</h2>
      <small>Every backup is locked with it. You’ll need it to restore, and Leafdeck can’t recover it.${data.passphrase ? ' Backups you’ve already made keep the old one.' : ''}</small></div></div>
    <div class="sheet-scroll">
      <div class="form-grid">
        <label class="field span2"><span>Passphrase</span><input type="password" name="p1" minlength="8" required autocomplete="new-password" placeholder="At least 8 characters"></label>
        <label class="field span2"><span>Passphrase again</span><input type="password" name="p2" minlength="8" required autocomplete="new-password"></label>
      </div>
      <div class="imp-result" data-result></div>
    </div>
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">Save</button></div></form>`);
  const sh = win.sheet(node);
  const out = $('[data-result]', node);
  node.elements.p1.focus();
  node.addEventListener('click', (e) => e.target.closest('[data-cancel]') && sh.close());
  node.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = node.elements;
    if (f.p1.value !== f.p2.value) return void (out.innerHTML = '<span class="txt-red">The passphrases don’t match.</span>');
    try {
      await shell.backup.setPassphrase(f.p1.value);
      f.p1.value = f.p2.value = '';
      sh.close();
      toast('Backup passphrase saved');
      load();
    } catch (err) {
      out.innerHTML = `<span class="txt-red">${esc(plain(err))}</span>`;
    }
  });
}

async function run() {
  const picked = (data?.drives || []).find((d) => d.path === folder);
  if (!picked || busy) return;
  busy = true;
  result = '';
  draw();
  try {
    const r = await shell.backup.run({ folder: picked.path, name: picked.name, ui: uiParts() });
    const c = r.counts;
    result = `<div>${icon('tick', 13, 2.4)} Backed up to <b>${esc(r.name)}</b> (${size(r.size)}): ${plural(c.records, 'record')}, ${plural(c.passwords, 'password')}, sign-ins for ${plural(c.sites, 'site')}, ${plural(c.history, 'history entry', 'history entries')}${c.apps ? `, ${plural(c.apps, 'app')}` : ''}${r.media.total ? `; ${plural(r.media.total, 'media file')}${r.media.copied ? ` (${r.media.copied} new)` : ''}` : ''}.${r.removed.length ? ` ${plural(r.removed.length, 'older backup')} removed.` : ''}</div>`;
    toast(`Backed up to ${r.name}`);
  } catch (err) {
    result = `<span class="txt-red">${esc(plain(err))}</span>`;
  } finally {
    busy = false;
  }
  await load();
}

async function onClick(e) {
  const t = e.target;
  if (t.closest('[data-bk-run]')) return run();
  if (t.closest('[data-bk-pass]')) return passphraseSheet();
  if (t.closest('[data-bk-restore]')) return openImportMoveSheet(win);
  if (t.closest('[data-bk-folder]')) {
    const dir = await shell.backup.chooseFolder().catch(() => null);
    if (!dir) return;
    folder = dir;
    // A chosen folder shows in the list once it's been backed up to; until then, back up to it straight away.
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    data.drives = [...(data.drives || []).filter((d) => d.path !== dir), { path: dir, name, free: 0, chosen: true, count: 0, last: null }];
    draw();
  }
}

async function onChange(e) {
  const t = e.target;
  if (t.matches('[data-bk-drive]')) {
    folder = t.value;
    draw();
  } else if (t.matches('[data-bk-every]')) {
    try {
      await shell.backup.remind(Number(t.value));
      toast(Number(t.value) ? 'Reminder set' : 'Reminder off');
    } catch (err) {
      toast(plain(err), 'error');
    }
    load();
  }
}

/** Settings → Backup, drawn into its section each time the page is shown. */
export function mountBackup(node, w) {
  if (host === node) return;
  host = node;
  win = w;
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  const off = shell.on?.('files:drives', () => host?.isConnected && load());
  w.cleanups?.push(() => {
    off?.();
    if (host === node) host = null;
  });
  load();
}
