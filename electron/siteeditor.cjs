// Site Editor's main-process half (the app is public/js/apps/siteeditor.js; what runs inside the page is
// public/js/siteeditor/inpage.js). A site in development is a Claude Code project (its folder) shown at its local
// address in a webview; the user adjusts elements, edits text and pins comments on the page, then sends it all to
// Claude, which works in the project's folder. This module:
// - runs the in-page script in the webview (an isolated world) and relays its events to the editor,
// - finds where a style came from (CSS.getMatchedStylesForNode over CDP: the rule, its stylesheet, and the source
//   file through the dev server's source maps or Vite's data-vite-dev-id), so Claude edits the right file,
// - keeps the editor's state and hand-off outside the project, in the profile (projects/<id>/site/): nothing is
//   written into the user's folder. Claude gets that folder with --add-dir, reads handoff/spec.md and answers
//   comments in replies.json.
const fs = require('node:fs');
const path = require('node:path');
const { webContents, ipcMain, net } = require('electron');

const WORLD = 1010;
let deps = null; // { win(), isOurWebview(wc), publicDir, dir(pid), send(channel, payload) }
const active = new Set(); // web contents ids with the editor's overlay in them

let inPageSrc = null;
const inPage = () => (inPageSrc ??= fs.readFileSync(path.join(deps.publicDir, 'js', 'siteeditor', 'inpage.js'), 'utf8').replace(/^export default /m, ''));

function target(wcId) {
  const wc = webContents.fromId(Number(wcId));
  if (!wc || !deps.isOurWebview(wc)) throw new Error('That page isn’t open');
  return wc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Run the in-page script: sitePage(mode, opts) in the page's isolated world. */
async function run(wcId, mode, opts = {}) {
  const wc = target(wcId);
  if (mode === 'start') active.add(wc.id);
  if (mode === 'stop') active.delete(wc.id);
  if (mode === 'info' && opts.rest) {
    // Just clicked: the pointer is still on the element, so its :hover look would be read as the resting one. Move
    // the pointer off it first (the in-page script ignores the synthetic move).
    const r = opts.rest;
    const far = r && r.x <= 2 && r.y <= 2 ? { x: Math.round(r.x + r.w + 4), y: Math.round(r.y + r.h + 4) } : { x: 1, y: 1 };
    await sleep(160); // after the click settles, or the browser's own hover update puts the pointer back on it
    wc.sendInputEvent({ type: 'mouseMove', x: far.x, y: far.y });
    await sleep(90);
    opts = { ...opts, rest: undefined };
  }
  return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${inPage()})(${JSON.stringify(mode)}, ${JSON.stringify(opts)})` }], mode === 'start');
}

// What the page reports (public/js/siteeditor/inpage.js emits a DOM event; electron/webview-preload.cjs forwards it).
ipcMain.on('leafdeck:site-editor', (event, detail) => {
  const wc = event.sender;
  if (!deps || !deps.isOurWebview(wc) || !active.has(wc.id)) return;
  if (event.senderFrame && event.senderFrame !== wc.mainFrame) return;
  if (typeof detail !== 'string' || detail.length > 256 * 1024) return;
  let ev;
  try {
    ev = JSON.parse(detail);
  } catch {
    return;
  }
  if (!ev || typeof ev.t !== 'string') return;
  deps.send('siteeditor:event', { webContentsId: wc.id, ev });
});

/* ---------------- where a style came from ---------------- */

const SHORTHANDS = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  border: ['border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-right-style', 'border-right-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  font: ['font-family', 'font-size', 'font-weight', 'line-height', 'font-style'],
  background: ['background-color', 'background-image'],
  gap: ['row-gap', 'column-gap'],
  inset: ['top', 'right', 'bottom', 'left'],
};
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'word-spacing', 'visibility', 'cursor']);

/** The declaration in a rule's style that sets `prop` (itself, or the shorthand it came from), or null. */
function declFor(style, prop) {
  const props = style?.cssProperties || [];
  const own = props.find((p) => p.name === prop && !p.disabled && p.parsedOk !== false);
  if (!own) return null;
  if (own.text || own.range) return own;
  const short = props.find((p) => p.text && !p.disabled && SHORTHANDS[p.name]?.includes(prop));
  return short || own;
}

/**
 * The winning declaration for `prop` among matched rules (last = most specific), !important first. Rules that match
 * only through :hover / :active / :focus are skipped: the element was just clicked, and what the user adjusts is its
 * resting look.
 */
const TRANSIENT = /:(hover|active|focus|focus-visible|focus-within)\b/;
function winner(rules, prop) {
  const list = (rules || []).filter((r) => {
    if (r.rule?.origin === 'user-agent') return false;
    const sels = r.rule?.selectorList?.selectors || [];
    const matched = (r.matchingSelectors || []).map((i) => sels[i]?.text || '');
    return !matched.length || matched.some((s) => !TRANSIENT.test(s));
  });
  for (const important of [true, false]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const d = declFor(list[i].rule.style, prop);
      if (d && !!d.important === important) return { rule: list[i].rule, decl: d };
    }
  }
  return null;
}

/* Source maps: enough of the spec to turn a generated line/column into a source file and line. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVlq(s, pos) {
  let result = 0;
  let shift = 0;
  let digit;
  do {
    digit = B64.indexOf(s[pos.i++]);
    if (digit < 0) throw new Error('bad vlq');
    result += (digit & 31) << shift;
    shift += 5;
  } while (digit & 32);
  return result & 1 ? -(result >> 1) : result >> 1;
}
function originalPosition(map, line, col) {
  const lines = String(map.mappings || '').split(';');
  if (line >= lines.length) return null;
  let src = 0;
  let oline = 0;
  let ocol = 0;
  // Running state carries across lines: replay the earlier lines' segments.
  let best = null;
  for (let l = 0; l <= line; l++) {
    const segs = lines[l].split(',');
    let gcol = 0;
    for (const seg of segs) {
      if (!seg) continue;
      const pos = { i: 0 };
      gcol += decodeVlq(seg, pos);
      if (pos.i < seg.length) {
        src += decodeVlq(seg, pos);
        oline += decodeVlq(seg, pos);
        ocol += decodeVlq(seg, pos);
        if (l === line && gcol <= col) best = { src, line: oline, col: ocol };
        if (l === line && !best) best = { src, line: oline, col: ocol };
      }
    }
  }
  if (!best) return null;
  const file = map.sources?.[best.src];
  if (!file) return null;
  return { file: (map.sourceRoot || '') + file, line: best.line + 1, col: best.col };
}
const cleanSource = (s) =>
  String(s || '')
    .replace(/^webpack:\/\/\/?/, '')
    .replace(/^(\.\/)+/, '')
    .replace(/\?.*$/, '');
const pathOfUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) ? url.pathname : u;
  } catch {
    return cleanSource(u);
  }
};
async function fetchMap(ses, url, base) {
  try {
    if (/^data:/.test(url)) {
      const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
      if (!m) return null;
      return JSON.parse(m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]));
    }
    const abs = new URL(url, base || undefined).href;
    const res = await net.fetch(abs, { bypassCustomProtocolHandlers: true, ...(ses ? { session: ses } : {}) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * For each property, the declaration that sets it on the element: the rule's selector, the declaration's text, where
 * it is (the stylesheet's address or the source file through its map), and whether it's inherited from an ancestor.
 */
async function origins(wcId, selector, props) {
  const wc = target(wcId);
  const dbg = wc.debugger;
  const sheets = new Map();
  const onMessage = (_e, method, params) => {
    if (method === 'CSS.styleSheetAdded') sheets.set(params.header.styleSheetId, params.header);
  };
  let mine = false;
  const send = (m, p) => dbg.sendCommand(m, p);
  const out = {};
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      mine = true;
    }
    dbg.on('message', onMessage);
    await send('DOM.enable');
    await send('CSS.enable');
    const doc = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!nodeId) return out;
    const matched = await send('CSS.getMatchedStylesForNode', { nodeId });
    const mapCache = new Map();
    const describe = async (hit, inherited) => {
      const { rule, decl } = hit;
      const header = sheets.get(rule.styleSheetId) || null;
      const o = { selector: rule.selectorList?.text || '', text: decl.text || `${decl.name}: ${decl.value}${decl.important ? ' !important' : ''}`, important: !!decl.important };
      if (inherited) o.inherited = inherited;
      const range = decl.range || rule.style?.range;
      if (header) {
        if (header.sourceURL) o.url = pathOfUrl(header.sourceURL);
        if (range) o.line = range.startLine + (header.isInline ? header.startLine : 0) + 1;
        // Vite's dev server injects each CSS file as a <style> tagged with its path.
        if (header.ownerNode) {
          try {
            const { node } = await send('DOM.describeNode', { backendNodeId: header.ownerNode });
            const attrs = node?.attributes || [];
            for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'data-vite-dev-id' || attrs[i] === 'data-href' || attrs[i] === 'data-s') o.file ||= cleanSource(attrs[i + 1]);
          } catch {}
        }
        if (!o.file && header.sourceMapURL && range) {
          if (!mapCache.has(header.styleSheetId)) mapCache.set(header.styleSheetId, await fetchMap(wc.session, header.sourceMapURL, header.sourceURL || wc.getURL()));
          const map = mapCache.get(header.styleSheetId);
          const pos = map ? originalPosition(map, range.startLine, range.startColumn) : null;
          if (pos) {
            o.file = cleanSource(pos.file);
            o.line = pos.line;
          }
        }
        if (!o.file && header.sourceURL && !header.isInline) o.file = cleanSource(pathOfUrl(header.sourceURL));
        if (header.origin === 'inspector' || header.origin === 'injected') o.injected = true;
      }
      return o;
    };
    for (const prop of props) {
      let hit = winner(matched.matchedCSSRules, prop);
      let inherited = null;
      if (!hit && INHERITED.has(prop)) {
        for (const anc of matched.inherited || []) {
          hit = winner(anc.matchedCSSRules, prop);
          if (hit) {
            inherited = hit.rule.selectorList?.text || 'an ancestor';
            break;
          }
        }
      }
      if (hit) out[prop] = await describe(hit, inherited);
    }
    return out;
  } finally {
    dbg.off?.('message', onMessage) || dbg.removeListener('message', onMessage);
    if (mine) {
      try {
        dbg.detach();
      } catch {}
    }
  }
}

/* ---------------- pictures ---------------- */

/** A screenshot of a part of the page (CSS pixels of the viewport), or the whole viewport without a rect. */
async function shot(wcId, r = null) {
  const wc = target(wcId);
  try {
    const img = r
      ? await wc.capturePage({ x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.min(4000, Math.ceil(r.w + 1)), height: Math.min(4000, Math.ceil(r.h + 1)) })
      : await wc.capturePage();
    return img.isEmpty() ? null : img.toDataURL();
  } catch {
    return null;
  }
}

/* ---------------- state and hand-off, in the profile ---------------- */

const okId = (pid) => {
  if (!/^[a-z0-9]{6,12}$/.test(String(pid))) throw new Error('Bad project id');
  return String(pid);
};
function dir(pid) {
  const d = deps.dir(okId(pid));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function readState(pid) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir(pid), 'state.json'), 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}
function writeState(pid, state) {
  if (!state || typeof state !== 'object') throw new Error('Bad state');
  const file = path.join(dir(pid), 'state.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
  return true;
}
/** handoff/: text files and data-URL images; a null value removes the file. */
function writeHandoff(pid, files) {
  const base = path.join(dir(pid), 'handoff');
  fs.rmSync(base, { recursive: true, force: true }); // nothing from the last round lingers
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/^[\w.-]+$/.test(rel)) continue;
    const file = path.join(base, rel);
    if (content == null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(String(content));
    if (m) fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    else fs.writeFileSync(file, String(content));
  }
  // A stale answer from an earlier round shouldn't be read as this one's.
  fs.rmSync(path.join(dir(pid), 'replies.json'), { force: true });
  return base;
}
/** Claude's answers to comments (replies.json, written during its turn), taken once. */
function takeReplies(pid) {
  const file = path.join(dir(pid), 'replies.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.replies) ? raw.replies : raw && typeof raw === 'object' ? Object.entries(raw).map(([id, v]) => (typeof v === 'string' ? { id, reply: v } : { id, ...v })) : [];
    return list
      .filter((r) => r && typeof r === 'object' && (r.id || r.comment))
      .map((r) => ({ id: String(r.id || r.comment), text: String(r.reply ?? r.text ?? '').slice(0, 4000), done: !!(r.done ?? r.resolved) }));
  } catch {
    return [];
  }
}

function init(d) {
  deps = d;
}

module.exports = { init, run, origins, shot, dir, readState, writeState, writeHandoff, takeReplies, WORLD };
