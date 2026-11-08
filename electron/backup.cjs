// Backup to a USB drive (Settings → Backup): everything "Move to another computer" saves (electron/move.cjs: passwords,
// sign-ins, history, settings, apps and a copy of your records) written as one passphrase-locked file into
// "Leafdeck Backups/<this computer>/" on a drive you plug in, plus the note images and voice memos (media/) copied
// beside it as they are. The newest KEEP backups are kept on each drive; older ones are removed as new ones are made.
// Restoring is Settings → Backup → Restore, the move file's import (public/js/move.js), which also brings the media back.
//
// The reminder: every N days (Settings → Backup → Remind me), a notification says it's time, with a button that opens
// Settings → Backup. Plugging in a drive that already holds backups from this computer brings it up right away when a
// backup is due. Settings are config.json's `backup`; the passphrase is a secret (secrets.json, encrypted), so a backup
// is one click once it's set.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { readConfig, writeConfig, writeAtomic } = require('./common.cjs');
const move = require('./move.cjs');

const FOLDER = 'Leafdeck Backups';
const KEEP = 10;
const DAY = 24 * 3600_000;
const REMIND_GAP = 20 * 3600_000; // at most one reminder a day
const CHECK_EVERY = 3600_000;

let deps = null; // { dir (the profile: leafdeck.db, media/), open(), notify({ title, body, button }) → Promise<clicked> }
const mediaDir = () => path.join(deps.dir, 'media');
let timer = 0;
let remindedDrive = ''; // the drive the plug-in reminder was last shown for (once per plug-in)

const settings = () => ({ everyDays: 0, lastAt: 0, lastFile: '', lastFolder: '', lastName: '', lastSize: 0, setAt: 0, remindedAt: 0, ...(readConfig().backup || {}) });
const set = (patch) => writeConfig({ backup: { ...settings(), ...patch } });

/** This computer's folder name on a drive: the hostname, kept to what every file system allows. */
const computerName = () => (os.hostname() || 'computer').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'computer';
const backupsDir = (folder) => path.join(folder, FOLDER, computerName());

/* ---------------- Drives ---------------- */

/** External drives mounted for you (udisks puts them in /run/media/<you>), with free space and the backups already on each. */
function drives() {
  if (process.platform !== 'linux') return [];
  const out = [];
  try {
    const user = os.userInfo().username;
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [dev, mnt] = line.split(' ');
      const where = (mnt || '').replace(/\\040/g, ' ');
      if (!dev?.startsWith('/dev/') || !(where.startsWith(`/run/media/${user}/`) || where.startsWith(`/media/${user}/`) || where.startsWith('/mnt/'))) continue;
      out.push(describe(where, path.basename(where)));
    }
  } catch {}
  // A folder you chose that isn't a drive (a network share, say): offered while it's still there.
  const s = settings();
  if (s.lastFolder && !out.some((d) => d.path === s.lastFolder) && fs.existsSync(s.lastFolder)) out.push(describe(s.lastFolder, s.lastName || path.basename(s.lastFolder), true));
  return out;
}

function describe(where, name, chosen = false) {
  let free = 0;
  let total = 0;
  try {
    const st = fs.statfsSync(where);
    free = Number(st.bavail) * Number(st.bsize);
    total = Number(st.blocks) * Number(st.bsize);
  } catch {}
  const backups = list(where);
  return { path: where, name, free, total, chosen, count: backups.length, last: backups[0] || null };
}

/** The backups from this computer on a drive (or in a folder), newest first. */
function list(folder) {
  const dir = backupsDir(folder);
  const found = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isFile() || !d.name.toLowerCase().endsWith('.' + move.EXT)) continue;
      const file = path.join(dir, d.name);
      const st = fs.statSync(file);
      found.push({ file, name: d.name, size: st.size, modified: st.mtimeMs });
    }
  } catch {}
  return found.sort((a, b) => b.modified - a.modified);
}

/* ---------------- Backing up ---------------- */

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
};

/** Copy the note images and voice memos that aren't on the drive yet (by name and size). */
function mirrorMedia(dest) {
  const src = mediaDir();
  let total = 0;
  let copied = 0;
  let bytes = 0;
  let names;
  try {
    names = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return { total, copied, bytes };
  }
  if (!names.length) return { total, copied, bytes };
  fs.mkdirSync(dest, { recursive: true });
  for (const d of names) {
    if (!d.isFile()) continue;
    total++;
    const from = path.join(src, d.name);
    const to = path.join(dest, d.name);
    const size = fs.statSync(from).size;
    bytes += size;
    let have = -1;
    try {
      have = fs.statSync(to).size;
    } catch {}
    if (have === size) continue;
    fs.copyFileSync(from, to);
    copied++;
  }
  return { total, copied, bytes };
}

/** How much a backup needs, roughly: the database and the media not on the drive yet, with room to spare. */
function needed(folder) {
  let n = 8 * 1024 * 1024;
  try {
    n += fs.statSync(path.join(deps.dir, 'leafdeck.db')).size;
  } catch {}
  try {
    const have = new Set();
    try {
      for (const f of fs.readdirSync(path.join(backupsDir(folder), 'media'))) have.add(f);
    } catch {}
    for (const d of fs.readdirSync(mediaDir(), { withFileTypes: true })) if (d.isFile() && !have.has(d.name)) n += fs.statSync(path.join(mediaDir(), d.name)).size;
  } catch {}
  return n;
}

function prune(folder) {
  const files = list(folder);
  const gone = [];
  for (const f of files.slice(KEEP)) {
    try {
      fs.unlinkSync(f.file);
      gone.push(f.name);
    } catch {}
  }
  return gone;
}

/**
 * Make a backup in a folder (a drive's mount point, or one you chose). `ui`, `secrets` and `sessions` are what
 * move.exportTo takes; the passphrase is the saved one. Returns the file and what went into it.
 */
async function run({ folder, name, passphrase, ui, secrets, sessions }) {
  if (!passphrase) throw new Error('Set a backup passphrase first.');
  folder = path.resolve(String(folder || ''));
  let st;
  try {
    st = fs.statSync(folder);
  } catch {
    throw new Error('That drive isn’t plugged in anymore.');
  }
  if (!st.isDirectory()) throw new Error('That isn’t a folder.');
  try {
    fs.accessSync(folder, fs.constants.W_OK);
  } catch {
    throw new Error('Leafdeck can’t write to that drive. It may be read-only, or formatted for another computer.');
  }
  let free = 0;
  try {
    const f = fs.statfsSync(folder);
    free = Number(f.bavail) * Number(f.bsize);
  } catch {}
  if (free && free < needed(folder)) throw new Error('There isn’t enough room on that drive.');

  const dir = backupsDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `Leafdeck backup ${stamp()}.${move.EXT}`);
  const r = await move.exportTo(file, passphrase, { ui, secrets, sessions });
  const media = mirrorMedia(path.join(dir, 'media'));
  const removed = prune(folder);
  const at = Date.now();
  writeAtomic(
    path.join(dir, 'backup.json'),
    JSON.stringify({ computer: os.hostname(), last: { file: path.basename(file), at: new Date(at).toISOString(), size: r.size, counts: r.summary.counts }, media: { files: media.total, bytes: media.bytes } }, null, 2),
  );
  set({ lastAt: at, lastFile: file, lastFolder: folder, lastName: String(name || path.basename(folder)), lastSize: r.size, remindedAt: 0 });
  remindedDrive = '';
  return { file, size: r.size, counts: r.summary.counts, media, removed, name: String(name || path.basename(folder)) };
}

/* ---------------- The reminder ---------------- */

/** Days since the last backup (or since the reminder was set) when one is due, else 0. */
function due() {
  const s = settings();
  if (!s.everyDays) return 0;
  const from = s.lastAt || s.setAt;
  if (!from) return 0;
  const days = Math.floor((Date.now() - from) / DAY);
  return days >= s.everyDays ? days : 0;
}

/** What Settings shows: the settings, what's plugged in, and whether a backup is due. */
const status = () => ({ ...settings(), due: due(), keep: KEEP, computer: computerName(), drives: drives() });

/** Settings → Backup → Remind me. Days from now, counted from the last backup when there is one. */
function setEvery(days) {
  const everyDays = Math.max(0, Math.min(365, Math.round(Number(days) || 0)));
  set({ everyDays, setAt: everyDays ? Date.now() : 0, remindedAt: 0 });
  return settings();
}

async function remind(drive) {
  const s = settings();
  const days = due();
  if (!days) return;
  if (drive) {
    if (remindedDrive === drive.path) return;
    remindedDrive = drive.path;
  } else if (Date.now() - s.remindedAt < REMIND_GAP) return;
  set({ remindedAt: Date.now() });
  const since = s.lastAt ? `It’s been ${days} day${days === 1 ? '' : 's'} since your last backup.` : 'You haven’t backed up Leafdeck yet.';
  const where = drive ? `“${drive.name}” is plugged in.` : 'Plug in a USB drive to back up.';
  const clicked = await deps.notify({ title: 'Time to back up Leafdeck', body: `${since} ${where}`, button: 'Open Backup' }).catch(() => false);
  if (clicked) deps.open();
}

const check = () => remind(null);

/** A drive came or went: one holding backups from this computer gets a reminder of its own when a backup is due. */
function driveChanged() {
  if (!due()) return;
  const d = drives().find((x) => x.count && !x.chosen);
  if (d) remind(d);
  else remindedDrive = '';
}

/**
 * Show a notification with one button; resolves true when it's pressed. In the Leafdeck OS session the cards are
 * Leafdeck's own notification service, reached like any program does (notify-send, which waits for the answer);
 * elsewhere it's the desktop's notification, which opens Settings when clicked.
 */
function notifySend({ title, body, button, icon }) {
  return new Promise((resolve) => {
    const child = spawn('notify-send', ['-a', 'Leafdeck', '-i', icon, '-A', `open=${button}`, title, body], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.trim() === 'open'));
  });
}

function init(options) {
  deps = options;
  clearInterval(timer);
  timer = setInterval(check, CHECK_EVERY);
  timer.unref?.();
  setTimeout(check, 90_000).unref?.();
}

function stop() {
  clearInterval(timer);
}

module.exports = { init, stop, status, setEvery, run, list, drives, due, driveChanged, notifySend, FOLDER, KEEP };
