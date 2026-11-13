// What a Leafdeck app is, and what may go in the store. Shared by the desktop app (electron/userapps.cjs,
// electron/appstore.cjs) and the store service (store/worker.js), so both agree on permissions and on what a bundle may
// hold. Plain JavaScript only: no Node or Electron, because this also runs in a Cloudflare Worker.

/** Built-in collections an app may ask for ("tasks:read", "contacts:write"…). */
const COLLECTIONS = ['tasks', 'notes', 'contacts', 'sprints', 'events', 'bookmarks'];

// The store hands out app ids, so a publisher can't pick one that already holds someone's approvals. Apps you build
// yourself never get an id of this shape (userapps.cjs).
const isStoreId = (id) => /^st-[a-z2-7]{12}$/.test(String(id || ''));

/** Only the fields Leafdeck understands, with unknown permissions dropped (and reported). */
function normalizeManifest(id, m) {
  const perms = [];
  const ignored = [];
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    const s = String(p).trim().toLowerCase();
    const [what, how] = s.split(':');
    if (COLLECTIONS.includes(what) && ['read', 'write'].includes(how)) perms.push(s);
    else if (s === 'notify') perms.push(s);
    else if (what === 'network' && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(how || '')) perms.push(s);
    // A program of the user's own on this computer (a helper that runs tools for the app), over plain http on loopback.
    else if (what === 'local' && /^\d{4,5}$/.test(how || '') && +how >= 1024 && +how <= 65535) perms.push(s);
    else ignored.push(String(p));
  }
  return {
    id,
    name: String(m.name || id).slice(0, 40),
    description: String(m.description || '').slice(0, 300),
    version: String(m.version || '0.1.0').slice(0, 20),
    icon: /^[a-z-]{2,20}$/.test(m.icon || '') ? m.icon : 'sparkle',
    glyph: typeof m.glyph === 'string' ? [...m.glyph].slice(0, 2).join('') : '',
    color: /^[a-z]{3,10}$/.test(m.color || '') ? m.color : 'green',
    size: Array.isArray(m.size) && m.size.length === 2 ? m.size.map((n) => Math.max(320, Math.min(2400, Number(n) || 800))) : [960, 680],
    permissions: [...new Set(perms)].sort(),
    ignoredPermissions: ignored,
  };
}

/* ---------------- Versions ---------------- */

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}
const nextVersion = (v) => {
  const [a, b, c] = String(v).split('.').map(Number);
  return `${a}.${b}.${(c || 0) + 1}`;
};

/* ---------------- Bundles ---------------- */

const LIMITS = { files: 500, file: 10 * 1024 * 1024, total: 20 * 1024 * 1024, depth: 8 };
// Base64 and the JSON around it: what a bundle may unpack to before its files are even looked at.
LIMITS.unpacked = Math.ceil(LIMITS.total * 1.4) + LIMITS.files * 200;
LIMITS.upload = LIMITS.unpacked;

const EXTENSIONS = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff2', 'woff', 'ttf', 'mp3', 'mp4', 'wasm', 'txt', 'md']);
const TEXT = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'txt', 'md']);
// Instructions for a coding agent: harmless in the app, but they'd steer the Claude of whoever customizes it later.
const AGENT_FILES = new Set(['claude.md', 'agents.md', 'brief.md']);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ ()-]{0,99}$/;

const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'a GitHub token'],
  [/\b[sr]k_live_[A-Za-z0-9]{20,}/, 'a Stripe key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];

function checkPath(p) {
  const parts = String(p).split('/');
  if (parts.length > LIMITS.depth) return 'is nested too deeply';
  if (!parts.every((s) => SEGMENT.test(s) && !s.includes('..'))) return 'has a name the store doesn’t allow (hidden files, and anything outside the app’s folder)';
  if (AGENT_FILES.has(parts[parts.length - 1].toLowerCase())) return 'is instructions for a coding agent, which don’t ship with an app';
  const dot = parts[parts.length - 1].lastIndexOf('.');
  if (dot < 0 || !EXTENSIONS.has(parts[parts.length - 1].slice(dot + 1).toLowerCase())) return 'isn’t a kind of file the store allows';
  return '';
}

/** Readable reasons a page wouldn't work under the store's stricter rules. The sandbox enforces them regardless. */
function checkHtml(path, text) {
  const errors = [];
  const html = text.replace(/<!--[\s\S]*?-->/g, '');
  if (/<script\b(?![^>]*\bsrc\s*=)(?![^>]*\btype\s*=\s*["']?[a-z/+-]*json)[^>]*>/i.test(html)) errors.push(`${path}: move inline <script> code into a .js file in the app`);
  if (/<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i.test(html)) errors.push(`${path}: scripts must come from the app’s own folder`);
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) errors.push(`${path}: replace inline event handlers (onclick=…) with addEventListener in a .js file`);
  if (/\b(?:href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) errors.push(`${path}: javascript: links aren’t allowed`);
  return errors;
}

/**
 * Everything the store requires of an app. `files` is [{ path, bytes: Uint8Array }]. Returns { errors, manifest }; the
 * app may be published (or installed) only when `errors` is empty.
 */
function checkBundle(files) {
  const errors = [];
  let total = 0;
  const seen = new Set();
  const decoder = new TextDecoder();
  if (!files.length) errors.push('The app has no files');
  if (files.length > LIMITS.files) errors.push(`The app has ${files.length} files; the limit is ${LIMITS.files}`);
  let rawManifest = null;
  for (const f of files) {
    const bad = checkPath(f.path);
    if (bad) {
      errors.push(`${f.path} ${bad}`);
      continue;
    }
    const lower = f.path.toLowerCase();
    if (seen.has(lower)) errors.push(`${f.path} appears twice`);
    seen.add(lower);
    total += f.bytes.length;
    if (f.bytes.length > LIMITS.file) errors.push(`${f.path} is over the 10 MB limit for one file`);
    const ext = lower.slice(lower.lastIndexOf('.') + 1);
    if (!TEXT.has(ext) || f.bytes.length > LIMITS.file) continue;
    const text = decoder.decode(f.bytes);
    if (f.path === 'manifest.json') rawManifest = text;
    if (ext === 'html') errors.push(...checkHtml(f.path, text));
    if (ext === 'svg' && /<script\b/i.test(text)) errors.push(`${f.path}: SVG files can’t contain scripts`);
    for (const [re, what] of SECRETS) if (re.test(text)) errors.push(`${f.path} seems to contain ${what}. Remove it before publishing`);
  }
  if (total > LIMITS.total) errors.push('The app is over the 20 MB limit');
  if (!seen.has('index.html')) errors.push('The app needs an index.html');

  let manifest = null;
  if (rawManifest === null) errors.push('The app needs a manifest.json');
  else {
    let raw = null;
    try {
      raw = JSON.parse(rawManifest);
    } catch (err) {
      errors.push(`manifest.json: ${err.message}`);
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      manifest = normalizeManifest('', raw);
      delete manifest.id;
      if (!String(raw.name || '').trim()) errors.push('manifest.json: give the app a name');
      if (!VERSION.test(String(raw.version || ''))) errors.push('manifest.json: the version must look like 1.2.3');
      if (manifest.ignoredPermissions.length) errors.push(`manifest.json: unknown permissions: ${manifest.ignoredPermissions.join(', ')}`);
      for (const p of manifest.permissions) if (p.startsWith('local:')) errors.push(`manifest.json: ${p} can’t be published, because the store can’t include or check the program it talks to`);
      delete manifest.ignoredPermissions;
    } else if (raw !== null) errors.push('manifest.json: expected an object');
  }
  return { errors, manifest };
}

/** The bundle's JSON ({ format: 1, files: { path: base64 } }) as a file list. Throws when it isn't one. */
function decodeBundle(doc) {
  if (!doc || doc.format !== 1 || !doc.files || typeof doc.files !== 'object') throw new Error('Not a Leafdeck app bundle');
  return Object.entries(doc.files).map(([path, b64]) => {
    if (typeof b64 !== 'string') throw new Error('Not a Leafdeck app bundle');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { path, bytes };
  });
}

module.exports = { COLLECTIONS, LIMITS, VERSION, isStoreId, normalizeManifest, compareVersions, nextVersion, checkBundle, decodeBundle };
