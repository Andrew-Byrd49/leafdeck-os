// Site Editor's main-process half (the app is public/js/apps/siteeditor.js; what runs inside the page is
// public/js/siteeditor/inpage.js). A site in development is a Claude Code project (its folder) shown at its local
// address in a webview; the user adjusts elements, edits text and pins comments on the page, then sends it all to
// Claude, which works in the project's folder. This module:
// - runs the in-page script in the webview (an isolated world) and relays its events to the editor,
// - finds where a style came from (CSS.getMatchedStylesForNode over CDP: the rule, its stylesheet, and the source
//   file through the dev server's source maps or Vite's data-vite-dev-id), so Claude edits the right file; the same
//   call gives the inspector the values as written (1.5rem, var(--gap)) and the rules that match an element,
// - holds an element in a state (:hover, :focus) while that state's styles are edited (CSS.forcePseudoState),
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
  if (mode === 'stop') {
    active.delete(wc.id);
    if (sessions.get(wc.id)?.open) forceState(wc.id, null, '').catch(() => {}); // let go of a held :hover and the debugger
  }
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

const SIDES = ['top', 'right', 'bottom', 'left'];
const sides = (pre, post = '') => SIDES.map((x) => `${pre}-${x}${post}`);
const SHORTHANDS = {
  padding: sides('padding'),
  margin: sides('margin'),
  'padding-inline': ['padding-inline-start', 'padding-inline-end'],
  'padding-block': ['padding-block-start', 'padding-block-end'],
  'margin-inline': ['margin-inline-start', 'margin-inline-end'],
  'margin-block': ['margin-block-start', 'margin-block-end'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  border: SIDES.flatMap((x) => [`border-${x}-width`, `border-${x}-style`, `border-${x}-color`]),
  ...Object.fromEntries(SIDES.map((x) => [`border-${x}`, [`border-${x}-width`, `border-${x}-style`, `border-${x}-color`]])),
  'border-width': sides('border', '-width'),
  'border-color': sides('border', '-color'),
  'border-style': sides('border', '-style'),
  outline: ['outline-width', 'outline-style', 'outline-color'],
  font: ['font-family', 'font-size', 'font-weight', 'line-height', 'font-style'],
  background: ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-clip', 'background-attachment'],
  gap: ['row-gap', 'column-gap'],
  inset: SIDES,
  'inset-inline': ['inset-inline-start', 'inset-inline-end'],
  'inset-block': ['inset-block-start', 'inset-block-end'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  overflow: ['overflow-x', 'overflow-y'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'grid-template': ['grid-template-columns', 'grid-template-rows'],
  grid: ['grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'text-decoration': ['text-decoration-line', 'text-decoration-color', 'text-decoration-style'],
  'list-style': ['list-style-type'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
};
// A physical property may be set through its logical twin (Tailwind's px-4 is padding-inline): left-to-right,
// top-to-bottom writing is assumed.
const LOGICAL = {
  ...Object.fromEntries(['padding', 'margin'].flatMap((k) => [[`${k}-left`, `${k}-inline-start`], [`${k}-right`, `${k}-inline-end`], [`${k}-top`, `${k}-block-start`], [`${k}-bottom`, `${k}-block-end`]])),
  left: 'inset-inline-start', right: 'inset-inline-end', top: 'inset-block-start', bottom: 'inset-block-end',
  width: 'inline-size', height: 'block-size', 'min-width': 'min-inline-size', 'min-height': 'min-block-size', 'max-width': 'max-inline-size', 'max-height': 'max-block-size',
};
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'word-spacing', 'visibility', 'cursor',
  'white-space', 'text-indent', 'word-break', 'overflow-wrap', 'text-wrap', 'text-shadow', 'list-style-type', 'pointer-events']);

/**
 * The declaration in a rule's style that sets `prop` (itself, its logical twin, or the shorthand either came from),
 * or null: { decl (what's written, for its text and place), value (the value `prop` gets from it) }.
 */
function declFor(style, prop) {
  const props = style?.cssProperties || [];
  const names = [prop, LOGICAL[prop]].filter(Boolean);
  const own = props.findLast((p) => names.includes(p.name) && !p.disabled && p.parsedOk !== false);
  if (!own) return null;
  if (own.text || own.range) return { decl: own, value: own.value };
  const short = props.findLast((p) => p.text && !p.disabled && SHORTHANDS[p.name]?.includes(own.name));
  return { decl: short || own, value: own.value || (short ? fromVarShorthand(short, own.name) : '') };
}
/**
 * What a longhand gets from a shorthand written with var(): the browser can't say until it computes it, so its
 * longhands read as empty. The box shorthands (padding: 48px var(--space)) go by position, a pair (gap, overflow)
 * likewise, and a background that's one var() is taken as its color.
 */
const BOX4 = /^(padding|margin|inset|border-width|border-style|border-color|border-radius)$/;
function fromVarShorthand(short, name) {
  const v = String(short.value || '').replace(/\s*!important\s*$/, '').trim();
  if (!/var\(/.test(v) || /[\/,](?![^(]*\))/.test(v)) return '';
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && !depth) {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  if (short.name === 'background') return name === 'background-color' && parts.length === 1 ? parts[0] : '';
  const i = SHORTHANDS[short.name].indexOf(name);
  if (BOX4.test(short.name) && parts.length <= 4) return parts[[[0, 0, 0, 0], [0, 1, 0, 1], [0, 1, 2, 1], [0, 1, 2, 3]][parts.length - 1][i]] || '';
  if (/^(gap|overflow|(padding|margin|inset)-(inline|block))$/.test(short.name) && parts.length <= 2) return parts[Math.min(i, parts.length - 1)] || '';
  return '';
}

/**
 * The winning declaration for `prop` among matched rules (last = most specific) and the element's own style
 * attribute, !important first. Rules that match only through :hover / :active / :focus are skipped unless that's the
 * state being edited: the element was just clicked, and what the user adjusts is its resting look. The editor's own
 * rules (the in-page script's stylesheet, marked in their selectors) never count: this is about the project's CSS.
 */
const TRANSIENT = /:(hover|active|focus-visible|focus-within|focus)\b/g;
const OURS = ':not(#ld-site-editor)';
const STATES = ['hover', 'focus', 'focus-visible', 'focus-within', 'active'];
function pageRules(rules, state = '') {
  return (rules || []).filter((r) => {
    if (r.rule?.origin === 'user-agent') return false;
    const text = r.rule?.selectorList?.text || '';
    if (text.includes(OURS)) return false;
    const sels = r.rule?.selectorList?.selectors || [];
    const matched = (r.matchingSelectors || []).map((i) => sels[i]?.text || '');
    return !matched.length || matched.some((s) => (s.match(TRANSIENT) || []).every((m) => m === ':' + state));
  });
}
function winner(rules, prop, { state = '', inline = null } = {}) {
  const list = pageRules(rules, state);
  for (const important of [true, false]) {
    const own = inline && declFor(inline, prop);
    if (own && !!own.decl.important === important) return { rule: null, ...own };
    for (let i = list.length - 1; i >= 0; i--) {
      const d = declFor(list[i].rule.style, prop);
      if (d && !!d.decl.important === important) return { rule: list[i].rule, ...d };
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

/** The inspector reads an element's rules each time one is selected: a map fetched a moment ago is still good. */
const recentMaps = new Map(); // address -> { at, map }
async function recentMap(ses, url, base) {
  const key = `${base || ''}\n${url}`;
  const hit = recentMaps.get(key);
  if (hit && Date.now() - hit.at < 20000) return hit.map;
  const map = fetchMap(ses, url, base);
  recentMaps.set(key, { at: Date.now(), map });
  if (recentMaps.size > 24) recentMaps.delete(recentMaps.keys().next().value);
  return map;
}

/* One conversation with a page's debugger at a time. It's shared (DevTools in a Leafdeck window, the leafdeck_* tools):
   attach only when nobody has, and let go after each call, except while an element is held in a state (:hover…),
   which lasts only as long as the CSS domain stays on. */
const sessions = new Map(); // web contents id -> { wc, sheets, open, mine, root, forced, queue }
function session(wc) {
  let s = sessions.get(wc.id);
  if (s) return s;
  s = { wc, sheets: new Map(), open: false, mine: false, root: 0, forced: null, queue: Promise.resolve() };
  s.onMessage = (_e, method, params) => {
    if (method === 'CSS.styleSheetAdded') s.sheets.set(params.header.styleSheetId, params.header);
    else if (method === 'CSS.styleSheetRemoved') s.sheets.delete(params.styleSheetId);
    else if (method === 'DOM.documentUpdated') {
      s.root = 0;
      s.forced = null;
    }
  };
  s.onDetach = () => {
    wc.debugger.removeListener('message', s.onMessage);
    Object.assign(s, { open: false, root: 0, forced: null });
    s.sheets.clear();
  };
  sessions.set(wc.id, s);
  wc.once('destroyed', () => sessions.delete(wc.id));
  return s;
}
async function openSession(s) {
  if (s.open) return;
  const dbg = s.wc.debugger;
  s.mine = !dbg.isAttached();
  if (s.mine) dbg.attach('1.3');
  dbg.on('message', s.onMessage);
  dbg.once('detach', s.onDetach);
  s.open = true;
  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');
}
function closeSession(s) {
  if (!s.open || s.forced) return;
  const dbg = s.wc.debugger;
  dbg.removeListener('message', s.onMessage);
  dbg.removeListener('detach', s.onDetach);
  Object.assign(s, { open: false, root: 0 });
  s.sheets.clear();
  if (s.mine) {
    try {
      dbg.detach();
    } catch {}
  }
}
/** fn(session, send) with the page's DOM and CSS domains on; calls for one page run one after another. */
function withPage(wcId, fn) {
  const wc = target(wcId);
  const s = session(wc);
  const job = s.queue.then(async () => {
    await openSession(s);
    try {
      return await fn(s, (m, p) => wc.debugger.sendCommand(m, p));
    } finally {
      closeSession(s);
    }
  });
  s.queue = job.catch(() => {});
  return job;
}
/** The node for a selector. The document is asked for once per session: asking again forgets every node id. */
async function nodeFor(s, send, selector) {
  if (!s.root) s.root = (await send('DOM.getDocument', { depth: 0 })).root.nodeId;
  return (await send('DOM.querySelector', { nodeId: s.root, selector })).nodeId || 0;
}

/**
 * Hold an element in a state (:hover, :focus…) while its styles for that state are edited; no state lets go.
 * Resolves to whether it's held.
 */
function forceState(wcId, selector, state) {
  return withPage(wcId, async (s, send) => {
    if (s.forced) {
      await send('CSS.forcePseudoState', { nodeId: s.forced.nodeId, forcedPseudoClasses: [] }).catch(() => {});
      s.forced = null;
    }
    if (!selector || !STATES.includes(state)) return false;
    const nodeId = await nodeFor(s, send, selector);
    if (!nodeId) return false;
    await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [state] });
    s.forced = { nodeId, selector, state };
    return true;
  });
}

/**
 * What the project's CSS says about an element. `props`: for each property asked about, the declaration that sets it
 * (the rule's selector, the declaration's text and the value the property gets from it, where it is: the stylesheet's
 * address or the source file through its map, and whether it's inherited from an ancestor). `rules`: every rule of the
 * page's that matches it, strongest first, with what each declares. `state` ('hover'…) counts that state's rules too.
 */
function inspect(wcId, selector, { props = [], state = '', rules: wantRules = false } = {}) {
  return withPage(wcId, async (s, send) => {
    const out = { props: {}, rules: [] };
    const wc = s.wc;
    const nodeId = await nodeFor(s, send, selector);
    if (!nodeId) return out;
    const matched = await send('CSS.getMatchedStylesForNode', { nodeId });
    const mapCache = new Map();
    const fileCache = new Map();
    /** Where a rule (or one declaration of it) is written. */
    const where = async (rule, range) => {
      const o = {};
      const header = s.sheets.get(rule.styleSheetId) || null;
      if (!header) return o;
      if (header.sourceURL) o.url = pathOfUrl(header.sourceURL);
      if (range) o.line = range.startLine + (header.isInline ? header.startLine : 0) + 1;
      // Vite's dev server injects each CSS file as a <style> tagged with its path.
      if (header.ownerNode) {
        if (!fileCache.has(header.styleSheetId)) {
          let file = '';
          try {
            const { node } = await send('DOM.describeNode', { backendNodeId: header.ownerNode });
            const attrs = node?.attributes || [];
            for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'data-vite-dev-id' || attrs[i] === 'data-href' || attrs[i] === 'data-s') file ||= cleanSource(attrs[i + 1]);
          } catch {}
          fileCache.set(header.styleSheetId, file);
        }
        if (fileCache.get(header.styleSheetId)) o.file = fileCache.get(header.styleSheetId);
      }
      if (!o.file && header.sourceMapURL && range) {
        if (!mapCache.has(header.styleSheetId)) mapCache.set(header.styleSheetId, await recentMap(wc.session, header.sourceMapURL, header.sourceURL || wc.getURL()));
        const map = mapCache.get(header.styleSheetId);
        const pos = map ? originalPosition(map, range.startLine, range.startColumn) : null;
        if (pos) {
          o.file = cleanSource(pos.file);
          o.line = pos.line;
        }
      }
      if (!o.file && header.sourceURL && !header.isInline) o.file = cleanSource(pathOfUrl(header.sourceURL));
      if (header.origin === 'inspector' || header.origin === 'injected') o.injected = true;
      return o;
    };
    const mediaOf = (rule) => (rule.media || []).filter((m) => m.source === 'mediaRule' && m.text).map((m) => m.text).join(' and ');
    const describe = async (hit, inherited) => {
      const { rule, decl, value } = hit;
      const o = { selector: rule ? rule.selectorList?.text || '' : 'style attribute', text: decl.text || `${decl.name}: ${decl.value}${decl.important ? ' !important' : ''}`, value: String(value ?? '').replace(/\s*!important\s*$/, ''), important: !!decl.important };
      if (!rule) o.inline = true;
      if (inherited) o.inherited = inherited;
      if (rule) {
        const media = mediaOf(rule);
        if (media) o.media = media;
        Object.assign(o, await where(rule, decl.range || rule.style?.range));
      }
      return o;
    };
    for (const prop of props) {
      let hit = winner(matched.matchedCSSRules, prop, { state, inline: matched.inlineStyle });
      let inherited = null;
      if (!hit && INHERITED.has(prop)) {
        for (const anc of matched.inherited || []) {
          hit = winner(anc.matchedCSSRules, prop, { inline: anc.inlineStyle });
          if (hit) {
            inherited = hit.rule ? hit.rule.selectorList?.text || 'an ancestor' : 'an ancestor’s style attribute';
            break;
          }
        }
      }
      if (hit) out.props[prop] = await describe(hit, inherited);
    }
    if (wantRules) {
      const written = (style) => (style?.cssProperties || []).filter((p) => (p.text || p.range) && !p.disabled && p.parsedOk !== false && !/^\/\*/.test(p.text || '')).slice(0, 60).map((p) => ({ name: p.name, value: String(p.value || '').replace(/\s*!important\s*$/, '').slice(0, 300), important: !!p.important }));
      const own = written(matched.inlineStyle);
      if (own.length) out.rules.push({ selector: 'style attribute', inline: true, decls: own });
      for (const r of pageRules(matched.matchedCSSRules, state).reverse().slice(0, 60)) {
        const decls = written(r.rule.style);
        if (!decls.length) continue;
        const sels = r.rule.selectorList?.selectors || [];
        out.rules.push({ selector: (r.rule.selectorList?.text || '').slice(0, 400), matched: (r.matchingSelectors || []).map((i) => sels[i]?.text || '').filter(Boolean).slice(0, 8), media: mediaOf(r.rule) || undefined, ...(await where(r.rule, r.rule.style?.range)), decls });
      }
    }
    return out;
  });
}
/** inspect()'s `props` alone (what App Builder and older callers ask for). */
const origins = async (wcId, selector, props) => (await inspect(wcId, selector, { props })).props;

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

module.exports = { init, run, origins, inspect, forceState, shot, dir, readState, writeState, writeHandoff, takeReplies, WORLD };
