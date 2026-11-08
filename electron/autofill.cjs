// Addresses and payment cards for form autofill. Like the password vault: stored only on this computer,
// encrypted with safeStorage (DPAPI on Windows), never synced. Card security codes (CVC) are never stored.
const { safeStorage } = require('electron');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { userFile, writeAtomic } = require('./common.cjs');

const FILE = 'autofill.dat';
let data = null; // { addresses: [], cards: [] }
let onChange = () => {};

const available = () => safeStorage.isEncryptionAvailable();

function load() {
  if (data) return data;
  let buf;
  try {
    buf = fs.readFileSync(userFile(FILE));
  } catch (err) {
    if (err.code === 'ENOENT') return (data = { addresses: [], cards: [], entries: {} });
    throw err;
  }
  if (!available()) throw new Error('Secure storage is not available on this system.');
  // Throw rather than start empty if it can't be decrypted, so a later save can't wipe the real data.
  data = { addresses: [], cards: [], entries: {}, ...JSON.parse(safeStorage.decryptString(buf)) };
  return data;
}

function save() {
  if (!available()) throw new Error('Secure storage is not available on this system.');
  writeAtomic(userFile(FILE), safeStorage.encryptString(JSON.stringify(data)));
  onChange();
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/* ---------- Addresses ---------- */

const ADDRESS_FIELDS = ['name', 'organization', 'street', 'city', 'state', 'postal', 'country', 'phone', 'email'];

function cleanAddress(a) {
  const out = {};
  for (const k of ADDRESS_FIELDS) out[k] = str(a?.[k], k === 'street' ? 400 : 200);
  return out;
}

const addressKey = (a) => [a.name, a.street, a.postal].map((x) => String(x || '').toLowerCase().replace(/\s+/g, ' ')).join('|');

/** One part of a saved address, as a field asks for it (classify's parts in webview-preload.cjs). */
function addressPart(a, part) {
  const words = String(a.name || '').trim().split(/\s+/).filter(Boolean);
  const lines = String(a.street || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const parts = {
    name: a.name,
    given: words.length > 1 ? words.slice(0, -1).join(' ') : words[0],
    family: words.length > 1 ? words[words.length - 1] : '',
    organization: a.organization,
    street: lines.join(', '),
    line1: lines[0],
    line2: lines.slice(1).join(', '),
    city: a.city,
    state: a.state,
    postal: a.postal,
    country: a.country,
    phone: a.phone,
    email: a.email,
  };
  return String(parts[part] || '');
}

const PART_ICONS = { email: 'mail', phone: 'phone' };

/**
 * The menu rows for an address field: what each saved address has for this part, as typed so far. Addresses without
 * it aren't offered. `alone` is a field with no other address fields around it: there's nothing else to fill, so
 * the rows are just the distinct values, which go straight into the field.
 */
function addressSuggestions(part, prefix, alone) {
  const p = String(prefix || '').toLowerCase();
  const icon = PART_ICONS[part] || 'pin';
  const seen = new Set();
  const rows = [];
  for (const a of load().addresses) {
    const label = addressPart(a, part);
    const low = label.toLowerCase();
    if (!label || !low.startsWith(p) || low === p) continue;
    if (alone) {
      if (!seen.has(low)) rows.push({ id: label, kind: 'value', icon, label });
      seen.add(low);
      continue;
    }
    const sub = [a.name, a.street.split('\n')[0], a.city].filter((x) => x && x !== label).join(', ');
    if (seen.has(`${low}\n${sub}`)) continue;
    seen.add(`${low}\n${sub}`);
    rows.push({ id: a.id, kind: 'address', icon, label, sub });
  }
  return rows;
}

/* ---------- Cards ---------- */

const digits = (v) => String(v || '').replace(/\D/g, '');

function luhn(num) {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return num.length >= 12 && num.length <= 19 && sum % 10 === 0;
}

function brand(num) {
  if (/^4/.test(num)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard';
  if (/^3[47]/.test(num)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(num)) return 'Discover';
  return 'Card';
}

function cleanCard(c) {
  const number = digits(c?.number);
  if (!luhn(number)) throw new Error('That card number doesn’t look right.');
  const month = Math.min(12, Math.max(1, parseInt(c?.expMonth, 10) || 0)) || '';
  let year = parseInt(c?.expYear, 10) || '';
  if (year && year < 100) year += 2000;
  return { name: str(c?.name), number, expMonth: month ? String(month).padStart(2, '0') : '', expYear: year ? String(year) : '', nickname: str(c?.nickname, 60) };
}

/** What the Leafdeck UI and page menus may see: never the full number. */
const publicCard = (c) => ({
  id: c.id,
  name: c.name,
  nickname: c.nickname,
  brand: brand(c.number),
  last4: c.number.slice(-4),
  expMonth: c.expMonth,
  expYear: c.expYear,
});

/* ---------- CRUD ---------- */

function upsert(kind, entry) {
  const d = load();
  const list = kind === 'card' ? d.cards : d.addresses;
  const now = Date.now();
  const existing = entry?.id && list.find((x) => x.id === entry.id);
  // Editing a card without retyping its number keeps the saved number.
  if (kind === 'card' && existing && !digits(entry.number)) entry = { ...entry, number: existing.number };
  const clean = kind === 'card' ? cleanCard(entry) : cleanAddress(entry);
  if (existing) Object.assign(existing, clean, { updatedAt: now });
  else list.push({ id: crypto.randomUUID(), ...clean, createdAt: now, updatedAt: now });
  save();
}

function remove(kind, id) {
  const list = kind === 'card' ? load().cards : load().addresses;
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    save();
  }
}

const getAddress = (id) => load().addresses.find((x) => x.id === id);
const getCard = (id) => load().cards.find((x) => x.id === id);

/** Is this submitted address/card new (or changed) enough to offer saving? Returns the match if it's an update. */
function findAddress(a) {
  const key = addressKey(a);
  return load().addresses.find((x) => addressKey(x) === key);
}
const findCard = (number) => load().cards.find((x) => x.number === digits(number));

/* ---------- Form entries (what you typed into ordinary fields, suggested again later, like Chrome) ---------- */

const MAX_PER_FIELD = 25;
const MAX_FIELDS = 600;
// Never remember anything that looks like a card number, an SSN, or a one-time code.
function sensitiveValue(v) {
  const d = digits(v);
  if (d.length >= 12 && d.length <= 19 && luhn(d)) return true;
  if (/^\d{3}-?\d{2}-?\d{4}$/.test(v.trim())) return true;
  if (/^\d{4,8}$/.test(v.trim())) return true; // PINs, verification codes
  return false;
}

function rememberEntries(list) {
  const d = load();
  d.entries ||= {};
  const now = Date.now();
  let changed = false;
  for (const { key, value } of (Array.isArray(list) ? list : []).slice(0, 40)) {
    const k = str(key, 60).toLowerCase();
    const v = str(value, 200);
    if (!k || v.length < 2 || sensitiveValue(v)) continue;
    const arr = (d.entries[k] ||= []);
    const hit = arr.find((e) => e.v === v);
    if (hit) Object.assign(hit, { n: hit.n + 1, t: now });
    else arr.push({ v, n: 1, t: now });
    arr.sort((a, b) => b.t - a.t);
    arr.length = Math.min(arr.length, MAX_PER_FIELD);
    changed = true;
  }
  const keys = Object.keys(d.entries);
  if (keys.length > MAX_FIELDS) {
    keys
      .sort((a, b) => (d.entries[a][0]?.t || 0) - (d.entries[b][0]?.t || 0))
      .slice(0, keys.length - MAX_FIELDS)
      .forEach((k) => delete d.entries[k]);
  }
  if (changed) save();
}

/** Suggestions for a field: values starting with what's typed, most-used and most recent first. */
function entrySuggestions(key, prefix) {
  const arr = load().entries?.[str(key, 60).toLowerCase()] || [];
  const p = String(prefix || '').toLowerCase();
  return arr
    .filter((e) => e.v.toLowerCase().startsWith(p) && e.v.toLowerCase() !== p)
    .sort((a, b) => b.n - a.n || b.t - a.t)
    .slice(0, 6)
    .map((e) => e.v);
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Email fields are named differently everywhere, so they share every email address you've typed, on any field. */
function emailSuggestions(prefix) {
  const p = String(prefix || '').toLowerCase();
  const best = new Map();
  for (const arr of Object.values(load().entries || {})) {
    for (const e of arr) {
      const low = e.v.toLowerCase();
      if (!EMAIL.test(e.v) || !low.startsWith(p) || low === p) continue;
      const hit = best.get(low);
      best.set(low, hit ? { v: hit.v, n: hit.n + e.n, t: Math.max(hit.t, e.t) } : { ...e });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.n - a.n || b.t - a.t)
    .slice(0, 6)
    .map((e) => e.v);
}

/** Forget a remembered value: from this field, or (an email address) from every field it was typed in. */
function forgetEntry(key, value, everywhere) {
  const d = load();
  const k = str(key, 60).toLowerCase();
  const low = String(value).toLowerCase();
  let changed = false;
  for (const name of everywhere ? Object.keys(d.entries || {}) : [k]) {
    const arr = d.entries?.[name];
    if (!arr) continue;
    const kept = arr.filter((e) => (everywhere ? e.v.toLowerCase() !== low : e.v !== value));
    if (kept.length === arr.length) continue;
    changed = true;
    if (kept.length) d.entries[name] = kept;
    else delete d.entries[name];
  }
  if (changed) save();
}

function clearEntries() {
  load().entries = {};
  save();
}

/** Addresses, cards and form entries from another Leafdeck (a move file); what's already here is kept. */
function mergeData(other) {
  const d = load();
  const now = Date.now();
  let added = 0;
  for (const a of other?.addresses || []) {
    const clean = cleanAddress(a);
    if (findAddress(clean)) continue;
    d.addresses.push({ id: crypto.randomUUID(), ...clean, createdAt: a.createdAt || now, updatedAt: now });
    added++;
  }
  for (const c of other?.cards || []) {
    let clean;
    try {
      clean = cleanCard(c);
    } catch {
      continue;
    }
    if (findCard(clean.number)) continue;
    d.cards.push({ id: crypto.randomUUID(), ...clean, createdAt: c.createdAt || now, updatedAt: now });
    added++;
  }
  d.entries ||= {};
  for (const [k, arr] of Object.entries(other?.entries || {})) {
    if (!Array.isArray(arr)) continue;
    const mine = (d.entries[k] ||= []);
    for (const e of arr) if (e && typeof e.v === 'string' && !mine.some((m) => m.v === e.v)) mine.push({ v: e.v, n: Number(e.n) || 1, t: Number(e.t) || now });
    mine.sort((a, b) => b.t - a.t);
    mine.length = Math.min(mine.length, MAX_PER_FIELD);
  }
  save();
  return { added };
}

const entryCount = () => Object.values(load().entries || {}).reduce((n, arr) => n + arr.length, 0);

module.exports = {
  available,
  load,
  list: () => ({ addresses: load().addresses.map((a) => ({ ...a })), cards: load().cards.map(publicCard), entryCount: entryCount() }),
  rememberEntries,
  mergeData,
  entrySuggestions,
  emailSuggestions,
  addressSuggestions,
  forgetEntry,
  clearEntries,
  upsert,
  remove,
  getAddress,
  getCard,
  publicCard,
  cleanAddress,
  cleanCard,
  findAddress,
  findCard,
  luhn,
  digits,
  onChange: (fn) => (onChange = fn),
};
