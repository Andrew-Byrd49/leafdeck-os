// Move to another computer (Windows → Leafdeck OS, or any Leafdeck → another): one file with everything Leafdeck
// keeps on this computer, encrypted with a passphrase you choose.
//
// What's in it: saved passwords, addresses and cards, website sign-ins (cookies of the shared and per-connection
// sessions), browsing history, browsing settings and the server connection (address + encrypted tokens), the
// desktop's own settings (theme, wallpaper, windows), apps you built, and a copy of your records.
// Not in it: websites' local storage (most sites keep you signed in with cookies, some will ask again), downloads,
// and per-machine settings (download folder, Claude Code token, Leafdeck OS settings).
//
// File: "LDMOVE1\n" | salt (16) | iv (12) | GCM tag (16) | AES-256-GCM(gzip(JSON)), key = scrypt(passphrase, salt).
// Passwords never reach the UI: an opened file stays here (pending) until the UI says which parts to import.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { app } = require('electron');
const { readConfig, writeConfig, writeAtomic } = require('./common.cjs');
const vault = require('./vault.cjs');
const autofill = require('./autofill.cjs');
const history = require('./history.cjs');
const userApps = require('./userapps.cjs');

const MAGIC = Buffer.from('LDMOVE1\n');
const EXT = 'leafdeck';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
// Settings that belong to one machine and stay behind.
const LOCAL_CONFIG = new Set(['downloadFolder', 'mcp', 'os', 'update']);
const APP_FILE_MAX = 20 * 1024 * 1024;

let pending = null; // the bundle opened by inspect(), until apply() or a new inspect()
let pendingDir = ''; // where that file is: a backup (electron/backup.cjs) keeps the note media in media/ beside it

/* ---------------- Encryption ---------------- */

function checkPassphrase(p) {
  if (typeof p !== 'string' || p.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
}

const keyFor = (passphrase, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(passphrase.normalize('NFC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

async function seal(bundle, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await keyFor(passphrase, salt), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(bundle))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

async function unseal(buf, passphrase) {
  if (buf.length < MAGIC.length + 44 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('That isn’t a Leafdeck move file.');
  let o = MAGIC.length;
  const salt = buf.subarray(o, (o += 16));
  const iv = buf.subarray(o, (o += 12));
  const tag = buf.subarray(o, (o += 16));
  const decipher = crypto.createDecipheriv('aes-256-gcm', await keyFor(passphrase, salt), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(o)), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase (or the file is damaged).');
  }
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

/* ---------------- Collecting ---------------- */

const COOKIE_FIELDS = ['name', 'value', 'domain', 'hostOnly', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite'];

async function collectCookies(sessions) {
  const out = {};
  for (const [partition, s] of sessions) {
    const list = await s.cookies.get({});
    if (list.length) out[partition] = list.map((c) => Object.fromEntries(COOKIE_FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])));
  }
  return out;
}

function collectApps() {
  const apps = [];
  for (const a of userApps.list()) {
    const root = userApps.appDir(a.id);
    const files = {};
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.versions', 'node_modules', '.git'].includes(d.name)) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile() && fs.statSync(full).size <= APP_FILE_MAX) files[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64');
      }
    };
    walk(root);
    apps.push({ id: a.id, name: a.name, files });
  }
  return apps;
}

/** Everything to move. `ui` comes from the Leafdeck UI: { localStorage, collections, storeMode }. */
async function build({ ui, secrets, sessions }) {
  const config = Object.fromEntries(Object.entries(readConfig()).filter(([k]) => !LOCAL_CONFIG.has(k)));
  return {
    format: 1,
    exportedAt: new Date().toISOString(),
    from: { computer: os.hostname(), platform: process.platform, version: app.getVersion() },
    config,
    secrets,
    passwords: vault.available() ? vault.load() : [],
    autofill: autofill.available() ? autofill.load() : null,
    history: history.exportVisits(),
    cookies: await collectCookies(sessions),
    apps: collectApps(),
    ui: {
      localStorage: ui?.localStorage && typeof ui.localStorage === 'object' ? ui.localStorage : {},
      collections: ui?.collections && typeof ui.collections === 'object' ? ui.collections : {},
      storeMode: ui?.storeMode === 'cloud' ? 'cloud' : 'local',
    },
  };
}

async function exportTo(file, passphrase, parts) {
  checkPassphrase(passphrase);
  const bundle = await build(parts);
  writeAtomic(file, await seal(bundle, passphrase));
  return { file, size: fs.statSync(file).size, summary: summary(bundle) };
}

/* ---------------- Opening and importing ---------------- */

function summary(b) {
  const records = Object.entries(b.ui?.collections || {})
    .filter(([k]) => k !== 'settings')
    .reduce((n, [, v]) => n + (Array.isArray(v) ? v.length : 0), 0);
  const cookieList = Object.values(b.cookies || {}).flat();
  return {
    exportedAt: b.exportedAt,
    from: b.from,
    server: b.config?.url || '',
    storeMode: b.ui?.storeMode || 'local',
    counts: {
      passwords: (b.passwords || []).length,
      autofill: (b.autofill?.addresses?.length || 0) + (b.autofill?.cards?.length || 0),
      sites: new Set(cookieList.map((c) => String(c.domain || '').replace(/^\./, '').replace(/^www\./, ''))).size,
      history: (b.history || []).length,
      apps: (b.apps || []).length,
      records,
    },
  };
}

async function inspect(file, passphrase) {
  pending = null;
  const bundle = await unseal(fs.readFileSync(file), String(passphrase || ''));
  if (bundle?.format !== 1) throw new Error('This file was made by a newer Leafdeck. Update Leafdeck, then try again.');
  pending = bundle;
  pendingDir = path.dirname(path.resolve(file));
  return summary(bundle);
}

async function importCookies(cookies, sessionFor) {
  const now = Date.now() / 1000;
  let n = 0;
  for (const [partition, list] of Object.entries(cookies || {})) {
    const s = sessionFor(partition);
    if (!s) continue;
    for (const c of list) {
      if (c.expirationDate && c.expirationDate < now) continue;
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const details = {
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite,
      };
      if (!c.hostOnly) details.domain = c.domain;
      try {
        await s.cookies.set(details);
        n++;
      } catch {
        /* a cookie this Chromium won't accept */
      }
    }
    await s.cookies.flushStore().catch(() => {});
  }
  return n;
}

function importApps(apps) {
  let added = 0;
  let skipped = 0;
  for (const a of apps || []) {
    let dir;
    try {
      dir = userApps.appDir(a.id);
    } catch {
      continue;
    }
    if (fs.existsSync(dir)) {
      skipped++;
      continue;
    }
    for (const [rel, b64] of Object.entries(a.files || {})) {
      const target = path.resolve(dir, rel);
      if (!target.startsWith(dir + path.sep)) continue; // never outside the app's folder
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    }
    added++;
  }
  return { added, skipped };
}

/** The note images and voice memos a backup keeps beside its file: the ones not here yet are copied in. */
function importMedia(from, mediaDir) {
  let n = 0;
  let names;
  try {
    names = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return 0;
  }
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const d of names) {
    if (!d.isFile() || !/^[\w.-]+$/.test(d.name)) continue;
    const to = path.join(mediaDir, d.name);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(from, d.name), to);
    n++;
  }
  return n;
}

/**
 * Import the chosen parts of the opened file. Returns what happened, plus the UI's own parts
 * (localStorage, records) for the UI to apply.
 */
async function apply(parts, { setSecret, sessionFor, mediaDir }) {
  const b = pending;
  if (!b) throw new Error('Open the file again.');
  const want = new Set(Array.isArray(parts) ? parts : []);
  const done = {};
  if (want.has('passwords') && b.passwords?.length) done.passwords = vault.mergeEntries(b.passwords);
  if (want.has('autofill') && b.autofill) done.autofill = autofill.mergeData(b.autofill);
  if (want.has('history') && b.history?.length) done.history = history.importVisits(b.history, b.from?.computer || '');
  if (want.has('sites')) done.sites = await importCookies(b.cookies, sessionFor);
  if (want.has('apps')) done.apps = importApps(b.apps);
  if (want.has('settings')) {
    const cfg = Object.fromEntries(Object.entries(b.config || {}).filter(([k]) => !LOCAL_CONFIG.has(k)));
    const cur = readConfig();
    if (cfg.permissions) cfg.permissions = { ...(cur.permissions || {}), ...cfg.permissions };
    for (const k of ['neverSave', 'keepAwake', 'adblockAllow']) if (Array.isArray(cfg[k])) cfg[k] = [...new Set([...(cur[k] || []), ...cfg[k]])].sort();
    writeConfig(cfg);
    for (const [k, v] of Object.entries(b.secrets || {})) if (v) setSecret(k, v);
    done.settings = true;
  }
  if (want.has('records') && mediaDir && pendingDir) done.media = importMedia(path.join(pendingDir, 'media'), mediaDir);
  const ui = {
    localStorage: want.has('desktop') ? b.ui?.localStorage || {} : null,
    collections: want.has('records') ? b.ui?.collections || null : null,
  };
  pending = null;
  pendingDir = '';
  return { done, ui };
}

/* ---------------- Finding the file ---------------- */

/**
 * Move files in the usual places: Desktop, Downloads, Documents, OneDrive, and (on Linux) USB drives, including the
 * backups in "Leafdeck Backups/<computer>/" on them (electron/backup.cjs).
 */
function findFiles() {
  const home = os.homedir();
  const dirs = [home, ...['Desktop', 'Downloads', 'Documents'].map((d) => path.join(home, d))];
  if (process.env.OneDrive) dirs.push(process.env.OneDrive, path.join(process.env.OneDrive, 'Desktop'), path.join(process.env.OneDrive, 'Documents'));
  if (process.platform === 'linux') {
    const user = os.userInfo().username;
    for (const base of [`/run/media/${user}`, `/media/${user}`, '/mnt']) {
      try {
        for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) dirs.push(path.join(base, d.name));
      } catch {}
    }
  }
  for (const dir of [...dirs]) {
    try {
      for (const d of fs.readdirSync(path.join(dir, 'Leafdeck Backups'), { withFileTypes: true })) if (d.isDirectory()) dirs.push(path.join(dir, 'Leafdeck Backups', d.name));
    } catch {}
  }
  const found = new Map();
  for (const dir of dirs) {
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!d.isFile() || !d.name.toLowerCase().endsWith('.' + EXT)) continue;
        const file = path.join(dir, d.name);
        const st = fs.statSync(file);
        found.set(fs.realpathSync(file), { file, name: d.name, dir, size: st.size, modified: st.mtimeMs });
      }
    } catch {}
  }
  return [...found.values()].sort((a, b) => b.modified - a.modified).slice(0, 10);
}

const defaultName = () => `Leafdeck from ${os.hostname()} ${new Date().toISOString().slice(0, 10)}.${EXT}`;

module.exports = { EXT, exportTo, inspect, apply, findFiles, defaultName, seal, unseal };
