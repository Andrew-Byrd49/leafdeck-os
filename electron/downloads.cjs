// Downloads: saved straight to the Downloads folder (or ask where), tracked for the Leafdeck UI, and tagged
// with Windows' "Mark of the Web" so SmartScreen and Office Protected View treat them as coming from the internet.
const { app, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { readJson, writeJson, readConfig } = require('./common.cjs');

const MAX_KEPT = 200;
// Files that can run code when opened. Leafdeck asks before opening these.
const DANGEROUS = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'psd1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'url', 'reg', 'dll', 'sys', 'iso', 'img', 'vhd', 'vhdx',
  'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'chm', 'application', 'gadget', 'inf', 'scf', 'settingcontent-ms', 'appref-ms',
  // Linux and Leafdeck OS
  'sh', 'bash', 'zsh', 'run', 'bin', 'appimage', 'desktop', 'deb', 'rpm', 'flatpak', 'flatpakref', 'snap', 'py', 'pl',
]);

const live = new Map(); // id -> DownloadItem
let records = readJson('downloads.json', []);
let notify = () => {};
let saveTimer = null;

const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson('downloads.json', records.slice(0, MAX_KEPT)), 500);
};

// Anything that was mid-download when the app last closed didn't finish.
for (const r of records) if (r.state === 'progressing') r.state = 'interrupted';

const downloadsFolder = () => readConfig().downloadFolder || app.getPath('downloads');
const isDangerous = (name) => DANGEROUS.has(path.extname(name).slice(1).toLowerCase());

function uniquePath(dir, name) {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate) || fs.existsSync(candidate + '.crdownload'); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function markOfTheWeb(file, url, referrer) {
  if (process.platform !== 'win32') return;
  const ads = file + ':Zone.Identifier';
  try {
    if (fs.existsSync(ads)) return; // Chromium already tagged it
    const host = /^https?:/i.test(url) ? url : 'about:internet';
    const ref = /^https?:/i.test(referrer || '') ? `ReferrerUrl=${referrer}\r\n` : '';
    fs.writeFileSync(ads, `[ZoneTransfer]\r\nZoneId=3\r\n${ref}HostUrl=${host}\r\n`);
  } catch {
    /* non-NTFS drive: nothing to tag */
  }
}

let throttle = null;
const changed = (now = false) => {
  persist();
  if (now) {
    clearTimeout(throttle);
    throttle = null;
    return notify(records);
  }
  if (!throttle) throttle = setTimeout(() => {
    throttle = null;
    notify(records);
  }, 250);
};

// "Save … As" from a menu: always asks where to save, whatever the setting says. The name is for downloads that
// have none of their own (an SVG saved from a page as a data: URL).
const asked = new Map(); // url -> filename ('' to keep the download's own)
function saveAs(contents, url, filename = '') {
  asked.set(url, filename);
  contents.downloadURL(url);
}

function attach(session) {
  session.on('will-download', (_event, item, contents) => {
    const id = crypto.randomUUID();
    const saveAsked = asked.has(item.getURL());
    const filename = asked.get(item.getURL()) || item.getFilename();
    asked.delete(item.getURL());
    const ask = saveAsked || !!readConfig().askWhereToSave;
    if (ask) {
      item.setSaveDialogOptions({ defaultPath: path.join(downloadsFolder(), filename), title: saveAsked ? 'Save As' : 'Save download' });
    } else {
      fs.mkdirSync(downloadsFolder(), { recursive: true });
      item.setSavePath(uniquePath(downloadsFolder(), filename));
    }
    let referrer = '';
    try {
      referrer = contents?.getURL() || '';
    } catch {}
    const rec = {
      id,
      url: item.getURL(),
      referrer,
      filename,
      path: item.getSavePath(),
      mime: item.getMimeType(),
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      paused: false,
      dangerous: isDangerous(filename),
      startedAt: Date.now(),
      endedAt: null,
    };
    records.unshift(rec);
    live.set(id, item);
    changed(true);

    item.on('updated', (_e, state) => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.paused = item.isPaused();
      rec.path = item.getSavePath() || rec.path;
      rec.filename = rec.path ? path.basename(rec.path) : rec.filename;
      rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      changed();
    });
    item.once('done', (_e, state) => {
      live.delete(id);
      rec.state = state; // completed | cancelled | interrupted
      rec.received = item.getReceivedBytes();
      rec.path = item.getSavePath() || rec.path;
      rec.filename = rec.path ? path.basename(rec.path) : rec.filename;
      rec.dangerous = isDangerous(rec.filename);
      rec.endedAt = Date.now();
      if (state === 'completed' && rec.path) markOfTheWeb(rec.path, rec.url, rec.referrer);
      changed(true);
    });
  });
}

const find = (id) => records.find((r) => r.id === id);

async function act(id, action, opts = {}) {
  const rec = find(id);
  const item = live.get(id);
  if (!rec) throw new Error('Download not found');
  switch (action) {
    case 'pause':
      item?.pause();
      break;
    case 'resume':
      if (item?.canResume()) item.resume();
      break;
    case 'cancel':
      item?.cancel();
      break;
    case 'open': {
      if (rec.state !== 'completed' || !fs.existsSync(rec.path)) throw new Error('The file is no longer there.');
      if (rec.dangerous && !opts.confirmed) return { needsConfirm: true };
      // On Linux, Leafdeck opens it (the UI: a preview in Files, Image Viewer, or the computer's app for it).
      if (process.platform === 'linux') return { open: rec.path };
      const err = await shell.openPath(rec.path);
      if (err) throw new Error(err);
      break;
    }
    case 'show':
      // On Linux, Leafdeck's own Files app shows it (the UI opens it); elsewhere, the system's file manager.
      if (process.platform === 'linux') return { reveal: fs.existsSync(rec.path) ? rec.path : path.dirname(rec.path) };
      if (fs.existsSync(rec.path)) shell.showItemInFolder(rec.path);
      else shell.openPath(path.dirname(rec.path));
      break;
    case 'remove':
      item?.cancel();
      records = records.filter((r) => r.id !== id);
      break;
    case 'retry':
      return { url: rec.url };
    default:
      throw new Error('Unknown action');
  }
  changed(true);
  return { ok: true };
}

function clearFinished() {
  records = records.filter((r) => r.state === 'progressing');
  changed(true);
}

async function chooseFolder(win) {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a downloads folder', defaultPath: downloadsFolder(), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}

module.exports = {
  attach,
  act,
  clearFinished,
  chooseFolder,
  downloadsFolder,
  saveAs,
  list: () => records,
  onChange: (fn) => (notify = fn),
};
