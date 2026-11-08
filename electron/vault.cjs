// Password vault: stored only on this computer, encrypted with safeStorage (DPAPI on Windows), never synced.
const { safeStorage } = require('electron');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { userFile, writeAtomic, isWebUrl, hostOf } = require('./common.cjs');

let vault = null; // decrypted entries, loaded on first use
let onChange = () => {};

const available = () => safeStorage.isEncryptionAvailable();
function requireEncryption() {
  if (!available()) throw new Error('Secure storage is not available on this system.');
}

function load() {
  if (vault) return vault;
  let buf;
  try {
    buf = fs.readFileSync(userFile('vault.dat'));
  } catch (err) {
    if (err.code === 'ENOENT') return (vault = []);
    throw err;
  }
  requireEncryption();
  // If decryption fails we throw rather than starting empty, so a later save can't overwrite the real vault.
  vault = JSON.parse(safeStorage.decryptString(buf));
  return vault;
}

function save() {
  requireEncryption();
  writeAtomic(userFile('vault.dat'), safeStorage.encryptString(JSON.stringify(vault)));
  onChange();
}

/** A saved login applies to the same host or a parent/child subdomain (never a sibling like a.github.io vs b.github.io). */
function hostMatches(entryHost, pageHost) {
  if (!entryHost || !pageHost) return false;
  return entryHost === pageHost || pageHost.endsWith('.' + entryHost) || entryHost.endsWith('.' + pageHost);
}

const publicEntry = ({ password, ...e }) => ({ ...e, hasPassword: !!password });

function normalizeUrl(url) {
  const u = String(url || '').trim();
  return u && !/^[a-z][\w+.-]*:/i.test(u) ? 'https://' + u : u;
}

/* ---------- CSV import ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

// Column names used by Chrome, Edge, Firefox, Safari, Bitwarden, 1Password, LastPass, Proton Pass and others.
const CSV_COLUMNS = {
  url: ['url', 'login_uri', 'login uri', 'website', 'web site', 'origin_url', 'hostname', 'urls'],
  username: ['username', 'login_username', 'login username', 'user name', 'user', 'email', 'login', 'email address'],
  password: ['password', 'login_password', 'login password'],
  name: ['name', 'title'],
  note: ['note', 'notes', 'extra', 'comments'],
};

function entriesFromCsv(text, source) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { entries: [], invalid: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(CSV_COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.url < 0 || col.password < 0) throw new Error('This CSV has no URL/password columns. Export passwords as CSV from your browser or password manager.');
  const entries = [];
  let invalid = 0;
  for (const r of rows.slice(1)) {
    const url = normalizeUrl((r[col.url] || '').trim().split(/[\s,]+/)[0]);
    const password = r[col.password] || '';
    if (!isWebUrl(url) || !password || !hostOf(url)) {
      invalid++; // android:// app logins, empty rows, notes without a site…
      continue;
    }
    entries.push({
      url,
      host: hostOf(url),
      username: col.username >= 0 ? (r[col.username] || '').trim() : '',
      password,
      name: col.name >= 0 ? (r[col.name] || '').trim() : '',
      note: col.note >= 0 ? (r[col.note] || '').trim() : '',
      source,
    });
  }
  return { entries, invalid };
}

function merge(entries) {
  const list = load();
  const now = Date.now();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const e of entries) {
    const existing = list.find((x) => x.host === e.host && x.username === e.username);
    if (!existing) {
      list.push({ id: crypto.randomUUID(), ...e, createdAt: now, updatedAt: now });
      added++;
    } else if (existing.password !== e.password) {
      Object.assign(existing, { password: e.password, url: e.url, updatedAt: now });
      updated++;
    } else skipped++;
  }
  save();
  return { added, updated, skipped };
}

function importCsvFile(file) {
  const { entries, invalid } = entriesFromCsv(fs.readFileSync(file, 'utf8'), require('node:path').basename(file));
  return { ...merge(entries), invalid };
}

/** Saved logins from another Leafdeck (a move file): same merge as a CSV, keeping names and notes. */
function mergeEntries(list) {
  const entries = [];
  for (const e of Array.isArray(list) ? list : []) {
    const url = normalizeUrl(e?.url);
    if (!isWebUrl(url) || !hostOf(url) || !e.password) continue;
    entries.push({ url, host: hostOf(url), username: String(e.username || ''), password: String(e.password), name: String(e.name || ''), note: String(e.note || ''), source: String(e.source || 'Leafdeck') });
  }
  return merge(entries);
}

/* ---------- CRUD ---------- */

function upsert(entry) {
  const list = load();
  const url = normalizeUrl(entry.url);
  if (!isWebUrl(url) || !hostOf(url)) throw new Error('Enter the site’s web address.');
  const now = Date.now();
  const base = { url, host: hostOf(url), username: String(entry.username || ''), name: String(entry.name || ''), note: String(entry.note || '') };
  const existing = entry.id && list.find((x) => x.id === entry.id);
  if (existing) {
    Object.assign(existing, base, { updatedAt: now });
    if (typeof entry.password === 'string' && entry.password) existing.password = entry.password;
  } else {
    if (!entry.password) throw new Error('Enter a password.');
    list.push({ id: crypto.randomUUID(), ...base, password: String(entry.password), source: entry.source || 'Leafdeck', createdAt: now, updatedAt: now });
  }
  save();
}

function remove(id) {
  const list = load();
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    save();
  }
}

const get = (id) => load().find((x) => x.id === id);
const matching = (pageHost) => (pageHost && available() ? load().filter((e) => hostMatches(e.host, pageHost)) : []);
const findLogin = (host, username) => load().find((x) => x.host === host && x.username === username);

module.exports = {
  available,
  requireEncryption,
  load,
  hostMatches,
  publicEntry,
  importCsvFile,
  mergeEntries,
  upsert,
  remove,
  get,
  matching,
  findLogin,
  onChange: (fn) => (onChange = fn),
};
