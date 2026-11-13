// The Leafdeck store, on this computer: the catalog, signed installs and updates, the takedown list, and publishing
// from App Builder. The service is store/worker.js; what an app may contain is appbundle.cjs.
//
// Nothing from the store is believed until its Ed25519 signature checks out against the key built in below. Installed
// apps live in the profile under store-apps/<id>/, read-only, apart from the Leafdeck Apps folder (where coding agents
// work), and userapps.cjs serves them under a stricter sandbox than apps you built yourself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, safeStorage } = require('electron');
const { userFile, writeAtomic } = require('./common.cjs');
const { LIMITS, isStoreId, normalizeManifest, compareVersions, nextVersion, checkBundle, decodeBundle } = require('./appbundle.cjs');

const STORE_URL = 'https://store.leafdeckos.com';
// More than one so the key can be rotated: ship the new one, move the service over, then drop the old one.
const PUBLIC_KEYS = ['vuglRaclCbG869Ndlc6/gjEWKdqPSmaCtydXMAagM9k='];
const CHECK_EVERY = 6 * 60 * 60_000;
const RELEASE = 'leafdeck-store-release';
const BLOCKLIST = 'leafdeck-store-blocklist';
const PUBLISHER_FILE = 'store-publisher.dat';
const LINK_FILE = '.leafdeck-store.json'; // in an app you publish: which store app it is

const dev = () => !app.isPackaged;
const storeUrl = () => ((dev() && process.env.LEAFDECK_STORE_URL) || STORE_URL).replace(/\/$/, '');
const publicKeys = () => (dev() && process.env.LEAFDECK_STORE_KEY ? [process.env.LEAFDECK_STORE_KEY] : PUBLIC_KEYS);

let deps = { onChange: () => {} };
const root = () => userFile('store-apps');
const dirOf = (id) => {
  if (!isStoreId(id)) throw new Error('Bad app id');
  return path.join(root(), id);
};
const receiptFile = (id) => path.join(root(), `${id}.json`);

/* ---------------- Signatures ---------------- */

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // the DER wrapping around a raw Ed25519 public key
const keyObject = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });

/** The statement's fields if `entry` is really signed by the store and is of this type; otherwise null. */
function verified(entry, type) {
  try {
    const signature = Buffer.from(String(entry.signature), 'base64');
    const message = Buffer.from(String(entry.statement), 'utf8');
    if (!publicKeys().some((k) => crypto.verify(null, message, keyObject(k), signature))) return null;
    const s = JSON.parse(entry.statement);
    return s?.type === type ? s : null;
  } catch {
    return null;
  }
}

function verifiedRelease(entry) {
  const s = verified(entry, RELEASE);
  if (!s || !isStoreId(s.id) || !Number.isSafeInteger(s.seq) || s.seq < 1 || !/^[0-9a-f]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.size) || !s.manifest || !s.publisher) return null;
  return s;
}

const samePermissions = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/* ---------------- The service ---------------- */

async function request(route, opts = {}) {
  let res;
  try {
    res = await fetch(storeUrl() + route, { signal: AbortSignal.timeout(opts.timeout || 30_000), ...opts });
  } catch {
    throw new Error('Couldn’t reach the Leafdeck store. Check your connection and try again.');
  }
  return res;
}

async function getJson(route) {
  const res = await request(route);
  if (!res.ok) throw new Error('The Leafdeck store isn’t available right now.');
  return res.json();
}

/* ---------------- The takedown list ---------------- */

const BLOCK_FILE = () => path.join(root(), 'blocklist.json');
let blocklist = { issued: 0, blocked: new Map() };

function acceptBlocklist(entry) {
  const s = verified(entry, BLOCKLIST);
  if (!s || !Number.isSafeInteger(s.issued) || !Array.isArray(s.blocked) || s.issued <= blocklist.issued) return false;
  blocklist = { issued: s.issued, blocked: new Map(s.blocked.filter((b) => isStoreId(b?.id)).map((b) => [b.id, String(b.reason || 'Taken down from the store')])) };
  return true;
}

function loadBlocklist() {
  try {
    acceptBlocklist(JSON.parse(fs.readFileSync(BLOCK_FILE(), 'utf8')));
  } catch {}
}

async function refreshBlocklist() {
  const before = new Set(blocklist.blocked.keys());
  const entry = await getJson('/v1/blocklist');
  if (!acceptBlocklist(entry)) return;
  fs.mkdirSync(root(), { recursive: true });
  writeAtomic(BLOCK_FILE(), JSON.stringify(entry));
  // Changed either way: an open window has to stop, or come back.
  for (const id of new Set([...before, ...blocklist.blocked.keys()])) if (before.has(id) !== blocklist.blocked.has(id) && fs.existsSync(dirOf(id))) deps.onChange(id);
}

const blockedReason = (id) => blocklist.blocked.get(id) || '';

/* ---------------- What's installed ---------------- */

function receipt(id) {
  try {
    const entry = JSON.parse(fs.readFileSync(receiptFile(id), 'utf8'));
    const s = verifiedRelease(entry);
    return s && s.id === id ? s : null;
  } catch {
    return null;
  }
}

function readManifest(id) {
  return normalizeManifest(id, JSON.parse(fs.readFileSync(path.join(dirOf(id), 'manifest.json'), 'utf8')));
}

/** Installed store apps, in the shape userapps.cjs lists apps. A receipt that doesn't verify means it isn't listed. */
function installed() {
  let names = [];
  try {
    names = fs.readdirSync(root());
  } catch {}
  const out = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (id === name || !isStoreId(id)) continue;
    const s = receipt(id);
    if (!s) continue;
    try {
      out.push({ ...readManifest(id), path: dirOf(id), modified: s.at, hasIndex: fs.existsSync(path.join(dirOf(id), 'index.html')), blocked: blockedReason(id), store: { seq: s.seq, at: s.at, publisher: s.publisher } });
    } catch {}
  }
  return out;
}

/* ---------------- The catalog ---------------- */

async function fetchCatalog() {
  const { apps } = await getJson('/v1/catalog');
  const out = new Map();
  for (const entry of Array.isArray(apps) ? apps : []) {
    const s = verifiedRelease(entry);
    if (!s || blockedReason(s.id)) continue;
    if (!out.has(s.id) || out.get(s.id).release.seq < s.seq) out.set(s.id, { release: s, entry });
  }
  return out;
}

/** What the Leafdeck Store app shows: every app in the store, and whether this computer has an older copy. */
async function catalog() {
  const have = new Map(installed().map((a) => [a.id, a]));
  return [...(await fetchCatalog()).values()].map(({ release: s }) => {
    const m = normalizeManifest(s.id, s.manifest);
    delete m.ignoredPermissions;
    return { ...m, publisher: s.publisher, at: s.at, download: s.size, installed: have.has(s.id), update: !!have.get(s.id) && have.get(s.id).store.seq < s.seq };
  });
}

/* ---------------- Installing ---------------- */

function chmodTree(dir, fileMode, dirMode) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) chmodTree(p, fileMode, dirMode);
    else fs.chmodSync(p, fileMode);
  }
  fs.chmodSync(dir, dirMode);
}

function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  // Read-only folders can't be emptied until they're writable again, top down.
  const open = (d) => {
    fs.chmodSync(d, 0o755);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(path.join(d, e.name));
  };
  open(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

// One install at a time per app, so a background update and a click can't cross.
const locks = new Map();
function locked(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(id, next);
  return next.finally(() => {
    if (locks.get(id) === next) locks.delete(id);
  });
}

async function applyRelease({ release: s, entry }) {
  const have = receipt(s.id);
  if (have && have.seq >= s.seq) {
    if (have.seq > s.seq) throw new Error('This computer already has a newer version.');
    return false;
  }
  const res = await request(`/v1/bundles/${s.id}/${s.seq}-${s.sha256}`, { timeout: 180_000 });
  if (!res.ok) throw new Error('Couldn’t download that app. Try again in a moment.');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length !== s.size || crypto.createHash('sha256').update(body).digest('hex') !== s.sha256) throw new Error('That download doesn’t match what the store signed, so it wasn’t installed.');

  let files;
  try {
    files = decodeBundle(JSON.parse(zlib.gunzipSync(body, { maxOutputLength: LIMITS.unpacked }).toString('utf8')));
  } catch {
    throw new Error('That download is damaged, so it wasn’t installed.');
  }
  // Signed or not, a bundle has to meet the rules: no hidden files, nothing outside its folder.
  const { errors, manifest } = checkBundle(files);
  if (errors.length || !manifest) throw new Error('That app doesn’t meet the store’s rules, so it wasn’t installed.');
  if (manifest.version !== s.manifest.version || !samePermissions(manifest.permissions, s.manifest.permissions)) throw new Error('That download doesn’t match what the store signed, so it wasn’t installed.');

  fs.mkdirSync(root(), { recursive: true });
  const stamp = `${s.id}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(root(), `.tmp-${stamp}`);
  const old = path.join(root(), `.old-${stamp}`);
  try {
    for (const f of files) {
      const to = path.join(tmp, ...f.path.split('/'));
      if (!to.startsWith(tmp + path.sep)) throw new Error('Bad path');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.bytes);
    }
    chmodTree(tmp, 0o444, 0o555);
    const dir = dirOf(s.id);
    if (fs.existsSync(dir)) fs.renameSync(dir, old);
    fs.renameSync(tmp, dir);
    writeAtomic(receiptFile(s.id), JSON.stringify(entry));
  } finally {
    removeTree(tmp);
    removeTree(old);
  }
  return true;
}

/** Install or update one app from the store's current release. */
async function install(id) {
  if (!isStoreId(id)) throw new Error('Bad app id');
  return locked(id, async () => {
    const item = (await fetchCatalog()).get(id);
    if (!item) throw new Error('That app isn’t in the store any more.');
    await applyRelease(item);
    deps.onChange(id);
    return true;
  });
}

function removeApp(id) {
  if (!isStoreId(id)) throw new Error('Bad app id');
  return locked(id, () => {
    fs.rmSync(receiptFile(id), { force: true });
    removeTree(dirOf(id));
    deps.onChange(null);
    return true;
  });
}

/** The takedown list, then any newer versions. An open app keeps running the version it started with. */
async function checkForUpdates() {
  await refreshBlocklist();
  const have = installed();
  if (!have.length) return;
  const items = await fetchCatalog();
  let changed = false;
  for (const a of have) {
    const item = items.get(a.id);
    if (!item || item.release.seq <= a.store.seq) continue;
    // Asking for more waits for a click in the Leafdeck Store app, and the approval that follows. The new policy would otherwise
    // reach an app that's already running and reloads itself.
    if (item.release.manifest.permissions.some((p) => !a.permissions.includes(p))) continue;
    try {
      changed = (await locked(a.id, () => applyRelease(item))) || changed;
    } catch (err) {
      console.warn(`[store] couldn't update ${a.id}:`, err.message);
    }
  }
  if (changed) deps.onChange(null);
}

function init({ onChange }) {
  deps = { onChange };
  loadBlocklist();
  // Leftovers from an install that was cut off.
  try {
    for (const name of fs.readdirSync(root())) if (/^\.(tmp|old)-/.test(name)) removeTree(path.join(root(), name));
  } catch {}
  const check = () => checkForUpdates().catch((err) => console.warn('[store] update check:', err.message));
  const testEvery = Number(dev() && process.env.LEAFDECK_STORE_CHECK_MS);
  setTimeout(check, testEvery || 30_000).unref?.();
  setInterval(check, testEvery || CHECK_EVERY).unref?.();
}

/* ---------------- Publishing ---------------- */

function publisherKey() {
  if (dev() && process.env.LEAFDECK_STORE_TOKEN) return process.env.LEAFDECK_STORE_TOKEN;
  try {
    return safeStorage.decryptString(fs.readFileSync(userFile(PUBLISHER_FILE)));
  } catch {
    return '';
  }
}

async function whoAmI(key) {
  const res = await request('/v1/me', { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 401) throw new Error('That publisher key isn’t valid.');
  if (!res.ok) throw new Error('The Leafdeck store isn’t available right now.');
  return res.json();
}

async function publisherStatus() {
  const key = publisherKey();
  if (!key) return { key: false };
  try {
    return { key: true, publisher: await whoAmI(key) };
  } catch (err) {
    return { key: true, error: err.message };
  }
}

async function setPublisherKey(raw) {
  const key = String(raw || '').trim();
  if (!/^ldp_[a-z2-7]{40}$/.test(key)) throw new Error('That doesn’t look like a publisher key.');
  const publisher = await whoAmI(key);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage isn’t available on this computer, so the key can’t be saved.');
  writeAtomic(userFile(PUBLISHER_FILE), safeStorage.encryptString(key));
  return { key: true, publisher };
}

function forgetPublisherKey() {
  fs.rmSync(userFile(PUBLISHER_FILE), { force: true });
  return { key: false };
}

const SKIP_DIRS = new Set(['node_modules']);
const SKIP_ROOT_FILES = new Set(['claude.md', 'agents.md', 'brief.md']);

/** An app folder's publishable files: no hidden files, no links, none of the notes for its coding agent. */
function pack(dir) {
  const files = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile() && !(!prefix && SKIP_ROOT_FILES.has(e.name.toLowerCase()))) files.push({ path: rel, bytes: fs.readFileSync(path.join(d, e.name)) });
    }
  };
  walk(dir, '');
  return files;
}

const readLink = (dir) => {
  try {
    const link = JSON.parse(fs.readFileSync(path.join(dir, LINK_FILE), 'utf8'));
    return isStoreId(link.id) ? link : null;
  } catch {
    return null;
  }
};

/** What publishing this folder would find, without sending anything. */
function preflight(dir) {
  const files = pack(dir);
  const { errors, manifest } = checkBundle(files);
  return { errors, manifest, files: files.length, bytes: files.reduce((n, f) => n + f.bytes.length, 0), link: readLink(dir) };
}

function setVersion(dir, version) {
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.version = version;
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
}

async function publish(dir) {
  const key = publisherKey();
  if (!key) throw new Error('Add your publisher key first.');
  const check = preflight(dir);
  if (check.errors.length) throw Object.assign(new Error(check.errors.join('\n')), { checks: check.errors });
  const link = check.link;

  // A version the store already has would be refused, so publishing again moves the last number up by one.
  let version = check.manifest.version;
  if (link?.version && compareVersions(version, link.version) <= 0) {
    version = nextVersion(link.version);
    setVersion(dir, version);
  }

  const send = async () => {
    const body = zlib.gzipSync(JSON.stringify({ format: 1, files: Object.fromEntries(pack(dir).map((f) => [f.path, Buffer.from(f.bytes).toString('base64')])) }));
    if (body.length > LIMITS.upload) throw new Error('The app is too large to publish.');
    return request(`/v1/publish${link ? `?app=${link.id}` : ''}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/gzip' }, body, timeout: 180_000 });
  };
  let res = await send();
  let data = await res.json().catch(() => ({}));
  // Published from another computer since: go one past what the store has.
  if (res.status === 409 && data.currentVersion) {
    version = nextVersion(data.currentVersion);
    setVersion(dir, version);
    res = await send();
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(data.errors?.length ? data.errors.join('\n') : data.error || 'The store didn’t accept that app.');
  fs.writeFileSync(path.join(dir, LINK_FILE), JSON.stringify({ id: data.id, version: data.version, seq: data.seq, publishedAt: Date.now() }, null, 2) + '\n');
  return data;
}

module.exports = { init, dirOf, isStoreId, installed, readManifest, blockedReason, catalog, install, removeApp, checkForUpdates, publisherStatus, setPublisherKey, forgetPublisherKey, preflight, publish };
