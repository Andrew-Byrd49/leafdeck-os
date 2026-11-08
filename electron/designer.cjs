// Designer (public/js/apps/designer.js): designs on disk, capturing elements from site windows and from Leafdeck's own
// interface, the screen for anything else, and the live preview of what Claude builds.
//
// Each design is a folder in Documents/Leafdeck Designs/<id>: design.json (the layers), assets/ (images and fonts,
// referenced as asset:<id>), thumb.png, handoff/ (the generated code, spec and preview for building it) and build/ (what
// Claude makes of it). Claude works in that folder (a Designer chat), so it can read the hand-off and even edit
// design.json; Designer notices and reloads.
//
// Capturing: public/js/designer/inpage.js runs in the page in an isolated world (the page's DOM, none of its scripts).
// You pick an element; then, through Chromium's debugger, the pointer is moved off it and its :hover, :focus-visible and
// :active states are forced one at a time and captured too, its images and fonts are fetched with the page's own
// session, and a screenshot of it is taken as a reference.
const fs = require('node:fs');
const path = require('node:path');
const { app, webContents, desktopCapturer, clipboard, shell, net, BrowserWindow } = require('electron');

const WORLD = 1009;
const ID = /^[a-z0-9]{4,40}$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8' };
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m.split(';')[0], e]));
EXT['image/jpeg'] = 'jpg';

let deps = null; // { win(), publicDir, isOurWebview(wc), session: bool (Leafdeck OS), osSystem }

const root = () => path.join(app.getPath('documents'), 'Leafdeck Designs');
function dirOf(id) {
  if (!ID.test(String(id))) throw new Error('Bad design id');
  return path.join(root(), id);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- designs on disk ---------------- */

const dataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;
function fromDataUrl(s) {
  const m = /^data:([\w/+.-]+)(;[^,]*)?,(.*)$/s.exec(String(s || ''));
  if (!m) return null;
  const buf = /;base64/.test(m[2] || '') ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  return { mime: m[1], buf };
}

function list() {
  let names = [];
  try {
    names = fs.readdirSync(root());
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    if (!ID.test(id)) continue;
    try {
      const dir = path.join(root(), id);
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
      let thumb = null;
      try {
        thumb = dataUrl(fs.readFileSync(path.join(dir, 'thumb.png')), 'image/png');
      } catch {}
      out.push({ id, name: String(doc.name || 'Untitled'), kind: doc.kind === 'graphic' ? 'graphic' : 'ui', updatedAt: doc.updatedAt || fs.statSync(path.join(dir, 'design.json')).mtimeMs, frames: (doc.kind === 'graphic' ? doc.artboards : doc.nodes || [])?.length || 0, thumb });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function read(id) {
  const dir = dirOf(id);
  const file = path.join(dir, 'design.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const assets = {};
  try {
    for (const f of fs.readdirSync(path.join(dir, 'assets'))) {
      const m = /^([a-z0-9]+)\.(\w+)$/.exec(f);
      if (!m) continue;
      assets[m[1]] = dataUrl(fs.readFileSync(path.join(dir, 'assets', f)), MIME[m[2]] || 'application/octet-stream');
    }
  } catch {}
  return { doc, assets, mtime: fs.statSync(file).mtimeMs };
}

/** Save a design. `assets`: new ones ({ id: dataURL }); `keep`: every asset id still in use (others are deleted). */
function write(id, doc, assets = {}, keep = null) {
  const dir = dirOf(id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const [aid, url] of Object.entries(assets || {})) {
    if (!/^[a-z0-9]+$/.test(aid)) continue;
    const d = fromDataUrl(url);
    if (!d || d.buf.length > 40e6) continue;
    const ext = EXT[d.mime] || 'bin';
    fs.writeFileSync(path.join(dir, 'assets', `${aid}.${ext}`), d.buf);
  }
  if (Array.isArray(keep)) {
    const k = new Set(keep);
    for (const f of fs.readdirSync(path.join(dir, 'assets'))) {
      const m = /^([a-z0-9]+)\./.exec(f);
      if (m && !k.has(m[1])) fs.rmSync(path.join(dir, 'assets', f), { force: true });
    }
  }
  const file = path.join(dir, 'design.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, file);
  writeGuide(dir);
  return fs.statSync(file).mtimeMs;
}

function stat(id) {
  try {
    return fs.statSync(path.join(dirOf(id), 'design.json')).mtimeMs;
  } catch {
    return 0;
  }
}

function writeThumb(id, url) {
  const d = fromDataUrl(url);
  if (d && d.mime === 'image/png' && d.buf.length < 4e6) fs.writeFileSync(path.join(dirOf(id), 'thumb.png'), d.buf);
}

async function remove(id) {
  const dir = dirOf(id);
  try {
    await shell.trashItem(dir);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write files into a design's folder (the hand-off). Text, or data URLs for binary files; null removes the file. Only
 * under handoff/, build/ and trace/.
 */
function writeFiles(id, files) {
  const dir = dirOf(id);
  for (const [rel, content] of Object.entries(files || {})) {
    const norm = path.normalize(rel).replace(/^([/\\])+/, '');
    if (!/^(handoff|build|trace)[/\\]/.test(norm) || norm.includes('..')) continue;
    const file = path.join(dir, norm);
    if (content == null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = typeof content === 'string' && content.startsWith('data:') ? fromDataUrl(content) : null;
    fs.writeFileSync(file, d ? d.buf : String(content));
  }
  return dir;
}

/** Read a text file from a design's folder (what Claude made: build/…, trace/…). */
function readFile(id, rel) {
  const dir = dirOf(id);
  const file = path.normalize(path.join(dir, String(rel)));
  if (!file.startsWith(dir + path.sep)) throw new Error('Not in the design');
  try {
    const st = fs.statSync(file);
    if (st.size > 8e6) throw new Error('Too big');
    return { text: fs.readFileSync(file, 'utf8'), mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/** The guide Claude reads in a design's folder. */
function writeGuide(dir) {
  const file = path.join(dir, 'DESIGN.md');
  try {
    const src = fs.readFileSync(path.join(deps.publicDir, 'js', 'designer', 'DESIGN.md'), 'utf8');
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== src) fs.writeFileSync(file, src);
  } catch {}
}

/* ---------------- capturing in a page ---------------- */

let inPageSrc = null;
const inPage = () => (inPageSrc ??= fs.readFileSync(path.join(deps.publicDir, 'js', 'designer', 'inpage.js'), 'utf8').replace(/^export default /m, ''));
const run = (wc, mode, opts = {}, gesture = false) => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${inPage()})(${JSON.stringify(mode)}, ${JSON.stringify(opts)})` }], gesture);

function target(wcId) {
  const win = deps.win();
  if (!wcId) return win?.webContents;
  const wc = webContents.fromId(Number(wcId));
  if (!wc || !deps.isOurWebview(wc)) throw new Error('That window can’t be captured');
  return wc;
}

let picking = null; // the webContents a pick is running in
/** Pick an element in a page (0: Leafdeck itself) and capture it with its states, images and fonts. */
async function pick(wcId, { at = null, exclude = null } = {}) {
  const wc = target(wcId);
  if (picking && !picking.isDestroyed()) await run(picking, 'cancel').catch(() => {});
  picking = wc;
  let cap;
  try {
    cap = await run(wc, 'pick', { mark: true, at, excludeSelector: exclude }, true);
  } finally {
    if (picking === wc) picking = null;
  }
  if (!cap) return null;
  if (cap.error) throw new Error(cap.error);
  return finish(wc, cap);
}
function cancel() {
  if (picking && !picking.isDestroyed()) run(picking, 'cancel').catch(() => {});
}

/** Capture a known element (by selector) without a pick: the Site Editor's "Edit in Designer". */
async function captureSelector(wcId, selector) {
  const wc = target(wcId);
  const token = Math.random().toString(36).slice(2, 10);
  const marked = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => { try { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.setAttribute('data-ld-capture', ${JSON.stringify(token)}); return true; } catch { return false; } })()` }]);
  if (!marked) throw new Error('That element isn’t on the page anymore');
  const cap = await run(wc, 'serialize', { selector: `[data-ld-capture="${token}"]` });
  if (!cap?.root) {
    await run(wc, 'unmark').catch(() => {});
    throw new Error('Couldn’t read that element');
  }
  cap.token = token;
  return finish(wc, cap);
}

async function finish(wc, cap) {
  const selector = cap.token ? `[data-ld-capture="${cap.token}"]` : null;
  const dbg = wc.debugger;
  let mine = false;
  let nodeId = null;
  let docId = null; // DOM.getDocument again would make every node id so far stale
  const send = (m, p) => dbg.sendCommand(m, p);
  try {
    if (selector) {
      if (!dbg.isAttached()) {
        dbg.attach('1.3');
        mine = true;
      }
      await send('DOM.enable');
      await send('CSS.enable');
      docId = (await send('DOM.getDocument', { depth: 0 })).root.nodeId;
      nodeId = (await send('DOM.querySelector', { nodeId: docId, selector })).nodeId || null;
      // The pointer is still on the element (you just clicked it): move it away, so what's captured is the resting state.
      const r = cap.rect;
      const far = r.x <= 2 && r.y <= 2 ? { x: Math.max(r.x + r.w + 4, 1), y: Math.max(r.y + r.h + 4, 1) } : { x: 1, y: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: far.x, y: far.y }).catch(() => {});
      await injectNoTransitions(wc, true);
      // A right-click or a click focuses what it hits: let go of it, so focus isn't in the resting state.
      await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => { const e = document.querySelector(${JSON.stringify(selector)}); const a = document.activeElement; if (e && a && a !== document.body && (e === a || e.contains(a))) a.blur(); })()` }]).catch(() => {});
      await sleep(90);
      const base = await run(wc, 'serialize', { selector });
      if (base?.root) Object.assign(cap, { root: base.root, rect: base.rect, html: base.html || cap.html });
    }
    cap.shot = await shot(wc, cap.rect);
    if (nodeId) {
      cap.states = {};
      // Compared without the browser's default focus ring (outline: auto), which isn't a design of the site's.
      const noRing = ({ 'outline-style': a, 'outline-width': b, 'outline-color': c, 'outline-offset': d, ...rest }) => rest;
      const sig = (r) => JSON.stringify(r, (k, v) => (k === 's' && v?.['outline-style'] === 'auto' ? noRing(v) : v));
      const baseSig = sig(cap.root);
      // Focus goes where focus can go: the element itself, or the first field or button inside it (a label around an
      // input), with :focus-within on the element. Pressed only means something for things you can press.
      const focus = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: FOCUSABLE(selector) }]).catch(() => null);
      let inner = null;
      if (focus === 'inner') inner = (await send('DOM.querySelector', { nodeId: docId, selector: '[data-ld-focus]' })).nodeId || null;
      const plan = [['hover', [[nodeId, ['hover']]]]];
      if (focus === 'self') plan.push(['focus', [[nodeId, ['focus', 'focus-visible', 'focus-within']]]], ['pressed', [[nodeId, ['hover', 'active', 'focus']]]]);
      if (inner) plan.push(['focus', [[nodeId, ['focus-within']], [inner, ['focus', 'focus-visible']]]]);
      for (const [name, list] of plan) {
        try {
          for (const [id, forced] of list) await send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: forced });
          await sleep(40);
          const snap = await run(wc, 'serialize', { selector });
          if (snap?.root && sig(snap.root) !== baseSig) cap.states[name] = snap.root;
        } catch {}
        for (const [id] of list) await send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('Designer: states not captured:', err.message);
    if (!cap.shot) cap.shot = await shot(wc, cap.rect);
  } finally {
    await injectNoTransitions(wc, false);
    await run(wc, 'unmark').catch(() => {});
    if (mine) {
      try {
        dbg.detach();
      } catch {}
    }
  }
  delete cap.token;
  cap.resolved = await resolveAssets(wc.session, cap);
  return cap;
}

/** Whether an element can take focus ('self'), has something inside that can ('inner', marked), or neither. */
const FOCUSABLE = (selector) => `(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  const F = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';
  if (!e) return null;
  if (e.matches(F)) return 'self';
  const d = e.querySelector(F);
  if (!d) return null;
  d.setAttribute('data-ld-focus', '');
  return 'inner';
})()`;

/** Transitions off while the states are captured, so each one is read at its end value, not halfway. */
function injectNoTransitions(wc, on) {
  const code = on
    ? `(() => { const s = document.createElement('style'); s.setAttribute('data-ld-overlay', ''); s.id = '__ld-notrans'; s.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; }'; (document.head || document.documentElement).append(s); })()`
    : `document.getElementById('__ld-notrans')?.remove()`;
  return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]).catch(() => {});
}

/** A screenshot of a part of a page (the element, as a reference). */
async function shot(wc, r) {
  try {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.ceil(r.w + (r.x - x));
    const h = Math.ceil(r.h + (r.y - y));
    if (w < 1 || h < 1) return null;
    const img = await wc.capturePage({ x, y, width: Math.min(w, 4000), height: Math.min(h, 4000) });
    return img.isEmpty() ? null : img.toDataURL();
  } catch {
    return null;
  }
}

/* ---------------- images and fonts ---------------- */

async function fetchData(ses, url, { max = 6e6, accept } = {}) {
  if (!/^https?:/i.test(url)) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await (ses?.fetch ? ses.fetch(url, { signal: ctl.signal, headers: accept ? { accept } : {} }) : net.fetch(url, { signal: ctl.signal }));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) return null;
    let mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!mime || mime === 'application/octet-stream' || mime === 'text/plain') mime = MIME[(/\.(\w+)(?:[?#]|$)/.exec(url) || [])[1]?.toLowerCase()] || mime || 'application/octet-stream';
    return { buf, mime };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(ses, url) {
  const d = await fetchData(ses, url, { max: 3e6, accept: 'text/css,*/*;q=0.1' });
  return d ? d.buf.toString('utf8') : '';
}

/** Fetch what a capture points to: images → data URLs, and the font files for the families it uses. */
async function resolveAssets(ses, cap) {
  const images = {};
  let total = 0;
  await Promise.all(
    (cap.images || []).slice(0, 80).map(async (u) => {
      const d = await fetchData(ses, u);
      if (!d || !/^image\//.test(d.mime) || total + d.buf.length > 40e6) return;
      total += d.buf.length;
      images[u] = dataUrl(d.buf, d.mime);
    }),
  );
  // Fonts: faces the page let us read, and @font-face rules in stylesheets it didn't (another origin).
  const families = new Set((cap.families || []).map((f) => f.toLowerCase()));
  const faces = [...(cap.fonts || [])];
  for (const href of (cap.fontSheets || []).slice(0, 8)) {
    const css = await fetchText(ses, href);
    for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const body = m[1];
      const prop = (k) => ((new RegExp(`${k}\\s*:\\s*([^;]+)`, 'i').exec(body) || [])[1] || '').trim();
      const family = prop('font-family').replace(/^["']|["']$/g, '');
      if (!families.has(family.toLowerCase())) continue;
      const range = prop('unicode-range');
      if (range && !/U\+0(000)?-|U\+0000/i.test(range)) continue;
      const urls = [...prop('src').matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((x) => x[2]);
      const best = urls.find((u) => /woff2/.test(u)) || urls.find((u) => /woff/.test(u)) || urls[0];
      if (!best) continue;
      let src = best;
      try {
        src = new URL(best, href).href;
      } catch {}
      faces.push({ family, weight: prop('font-weight') || 'normal', style: prop('font-style') || 'normal', src });
    }
  }
  const fonts = [];
  let fontBytes = 0;
  const seen = new Set();
  for (const f of faces) {
    const key = `${f.family}|${f.weight}|${f.style}`;
    if (seen.has(key) || fonts.length >= 12) continue;
    seen.add(key);
    const d = await fetchData(ses, f.src, { max: 2e6 });
    if (!d || fontBytes + d.buf.length > 8e6) continue;
    fontBytes += d.buf.length;
    const ext = (/\.(woff2|woff|ttf|otf)(?:[?#]|$)/i.exec(f.src) || [])[1]?.toLowerCase() || 'woff2';
    fonts.push({ family: f.family, weight: f.weight, style: f.style, data: dataUrl(d.buf, MIME[ext]) });
  }
  return { images, fonts };
}

/** Fetch images for pasted HTML (no page session: the shared web session). */
const fetchImages = (urls) => resolveAssets(deps.webSession?.() || null, { images: urls || [] }).then((r) => r.images);

/* ---------------- the screen, the clipboard, the Designer window ---------------- */

/** Anything else on screen: Leafdeck OS takes the whole screen; elsewhere, the windows and screens to choose from. */
async function screen() {
  if (deps.session && process.platform === 'linux') {
    const file = await deps.osSystem.captureScreen();
    try {
      return { kind: 'screen', image: dataUrl(fs.readFileSync(file), 'image/png') };
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1920, height: 1200 }, fetchWindowIcons: true });
  return {
    kind: 'sources',
    sources: sources
      .filter((s) => !s.thumbnail.isEmpty() && !/^Leafdeck$/i.test(s.name))
      .slice(0, 40)
      .map((s) => ({ id: s.id, name: s.name, image: s.thumbnail.toDataURL(), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null })),
  };
}

/** A picture of part of the Leafdeck window (a design's thumbnail and preview). */
async function snap(rect) {
  const win = deps.win();
  if (!win) return null;
  const z = win.webContents.getZoomFactor() || 1; // the rectangle is in the page's CSS pixels
  const r = { x: Math.max(0, Math.round(rect.x * z)), y: Math.max(0, Math.round(rect.y * z)), width: Math.max(1, Math.round(rect.w * z)), height: Math.max(1, Math.round(rect.h * z)) };
  const img = await win.webContents.capturePage(r);
  return img.isEmpty() ? null : img.toDataURL();
}

/** What's on the clipboard: text, HTML and an image (Electron's clipboard is the web's async ClipboardItem API now). */
async function readClipboard() {
  const out = { text: '', html: '', image: null };
  try {
    for (const item of await clipboard.read()) {
      for (const type of item.types) {
        if (type === 'text/plain' && !out.text) out.text = await (await item.getType(type)).text();
        else if (type === 'text/html' && !out.html) out.html = await (await item.getType(type)).text();
        else if (/^image\//.test(type) && !out.image) {
          const buf = Buffer.from(await (await item.getType(type)).arrayBuffer());
          if (buf.length < 30e6) out.image = dataUrl(buf, type.split(';')[0]);
        }
      }
    }
  } catch {}
  if (!out.text) out.text = (await Promise.resolve(clipboard.readText()).catch(() => '')) || '';
  return out;
}

/* ---------------- the live preview: leafdesign://<id>/… ---------------- */

const PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://esm.sh",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "form-action 'none'",
].join('; ');

async function serve(request) {
  try {
    const url = new URL(request.url);
    const dir = dirOf(url.host);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir + path.sep) || /[/\\]\.[^/\\]/.test(path.relative(dir, file))) return new Response('Forbidden', { status: 403 });
    const body = await fs.promises.readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
    if (ext === 'html') headers['content-security-policy'] = PREVIEW_CSP;
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function init(d) {
  deps = d;
}


/**
 * Graphic Designer's PDF export: each page an SVG (one per artboard, sizes in CSS pixels), printed by Chromium in a
 * hidden window with scripts off, so curves and type stay vectors. Returns the PDF's bytes.
 */
async function pdf(pages, title = '') {
  const list = (Array.isArray(pages) ? pages : []).slice(0, 200).map((p) => ({ svg: String(p?.svg || ''), w: Math.max(1, Math.min(20000, Number(p?.w) || 0)), h: Math.max(1, Math.min(20000, Number(p?.h) || 0)) }));
  if (!list.length) throw new Error('Nothing to export');
  const css = list.map((p, i) => `@page p${i} { size: ${p.w}px ${p.h}px; margin: 0 } .p${i} { page: p${i}; width: ${p.w}px; height: ${p.h}px }`).join('\n');
  const body = list.map((p, i) => `<div class="pg p${i}">${p.svg.replace(/<script[\s\S]*?<\/script>/gi, '')}</div>`).join('');
  const esc = (t) => String(t || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(String(title).slice(0, 200))}</title><style>html,body{margin:0;padding:0}.pg{overflow:hidden;break-after:page}.pg:last-child{break-after:auto}.pg>svg{display:block;width:100%;height:100%}${css}</style>${body}`;
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, offscreen: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } });
  } finally {
    w.destroy();
  }
}

module.exports = { pdf, init, root, dirOf, list, read, write, stat, writeThumb, remove, writeFiles, readFile, writeGuide, pick, cancel, captureSelector, screen, snap, readClipboard, fetchImages, serve };
