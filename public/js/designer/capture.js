// Turning captures into layers. A capture (designer/inpage.js) is the element's drawn tree with its computed styles;
// here it becomes Designer layers that look the same and stay editable: flex containers become auto layout, text
// becomes text layers, a button's label is centered in its padding, and plain wrapper <div>s melt away.
// Also: pasted HTML (rendered in a hidden frame, then captured the same way), SVG, images, and the bookmarklet.
import inPage from './inpage.js';
import { makeNode, parseColor, formatColor, TAGS, walk } from './model.js';
import { uid } from '../util.js';

const num = (v) => parseFloat(v) || 0;
const col = (c) => {
  const p = parseColor(c);
  return p.raw ? c : formatColor(p.hex, p.a);
};
const visibleCol = (c) => !!c && parseColor(c).a > 0;

/** Split a CSS list on its top-level commas ("a(b, c), d" → ["a(b, c)", "d"]). */
export function splitTop(v) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(v || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SEMANTIC = new Set(TAGS);
const INTERACTIVE = /^(button|a|input|textarea|select|label|summary)$/;

export function fontFrom(s) {
  const lh = s['line-height'];
  const ta = s['text-align'] || 'start';
  return {
    family: s['font-family'] || 'system-ui, sans-serif',
    size: num(s['font-size']) || 16,
    weight: parseInt(s['font-weight']) || 400,
    italic: s['font-style'] === 'italic' || undefined,
    lineHeight: !lh || lh === 'normal' ? 'auto' : num(lh),
    letterSpacing: !s['letter-spacing'] || s['letter-spacing'] === 'normal' ? 0 : num(s['letter-spacing']),
    align: /center/.test(ta) ? 'center' : /right|end/.test(ta) ? 'right' : /justify/.test(ta) ? 'justify' : 'left',
    transform: s['text-transform'] && s['text-transform'] !== 'none' ? s['text-transform'] : undefined,
    decoration: s['text-decoration-line'] && s['text-decoration-line'] !== 'none' ? s['text-decoration-line'] : undefined,
    color: col(s.color || '#000'),
  };
}

/** "linear-gradient(135deg, rgb(…), rgb(…) 60%)" → an editable linear fill, or null when it's more than that. */
export function parseLinear(v) {
  const m = /^linear-gradient\((.*)\)$/s.exec(String(v).trim());
  if (!m) return null;
  const parts = splitTop(m[1]);
  let angle = 180;
  const dirs = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
  if (/^-?[\d.]+deg$/.test(parts[0])) angle = parseFloat(parts.shift());
  else if (/^to /.test(parts[0])) {
    if (!(parts[0] in dirs)) return null;
    angle = dirs[parts.shift()];
  }
  if (parts.length < 2) return null;
  const stops = [];
  for (const p of parts) {
    const pm = /^(.*?)\s+(-?[\d.]+)%$/.exec(p);
    if (/\dpx$/.test(p)) return null;
    stops.push({ color: col(pm ? pm[1] : p), pos: pm ? +pm[2] / 100 : null });
  }
  stops.forEach((st, i) => st.pos == null && (st.pos = i === 0 ? 0 : i === stops.length - 1 ? 1 : null));
  // Unplaced stops in between: spread evenly between their neighbors.
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].pos != null) continue;
    let j = i;
    while (stops[j].pos == null) j++;
    const a = stops[i - 1].pos;
    const step = (stops[j].pos - a) / (j - i + 1);
    for (let k = i; k < j; k++) stops[k].pos = a + step * (k - i + 1);
  }
  return { type: 'linear', angle, stops };
}

function fillsFrom(s, asset) {
  const fills = [];
  const imgs = s['background-image'] && s['background-image'] !== 'none' ? splitTop(s['background-image']) : [];
  const sizes = splitTop(s['background-size'] || '');
  const poss = splitTop(s['background-position'] || '');
  const reps = splitTop(s['background-repeat'] || '');
  imgs.forEach((layer, i) => {
    const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(layer);
    const extra = { size: sizes[i] && sizes[i] !== 'auto' ? sizes[i] : undefined, position: poss[i] && poss[i] !== '0% 0%' ? poss[i] : undefined, repeat: reps[i] || undefined };
    if (m) fills.push({ type: 'image', src: asset(m[2]), fit: extra.size === 'contain' ? 'contain' : extra.size === 'cover' ? 'cover' : undefined, ...extra, size: extra.size || 'auto' });
    else fills.push(parseLinear(layer) || { type: 'css', value: layer, ...extra });
  });
  if (visibleCol(s['background-color'])) fills.push({ type: 'solid', color: col(s['background-color']) });
  return fills;
}

function strokeFrom(s) {
  const sides = ['top', 'right', 'bottom', 'left'].map((d) => (s[`border-${d}-style`] && s[`border-${d}-style`] !== 'none' && s[`border-${d}-style`] !== 'hidden' ? num(s[`border-${d}-width`]) : 0));
  if (!sides.some(Boolean)) return undefined;
  const first = ['top', 'right', 'bottom', 'left'][sides.findIndex(Boolean)];
  const color = col(s[`border-${first}-color`] || '#000');
  const style = /dash/.test(s[`border-${first}-style`]) ? 'dashed' : /dot/.test(s[`border-${first}-style`]) ? 'dotted' : 'solid';
  if (!visibleCol(color)) return undefined;
  return sides.every((w) => w === sides[0]) ? { color, width: sides[0], style } : { color, width: Math.max(...sides), style, sides };
}

function radiusFrom(s, w, h) {
  const corner = (k) => {
    const v = String(s[k] || '0px').split(' ')[0];
    const r = v.endsWith('%') ? (num(v) / 100) * Math.min(w, h) : num(v);
    return Math.round(Math.min(r, Math.min(w, h) / 2) * 100) / 100;
  };
  const r = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].map(corner);
  if (!r.some(Boolean)) return undefined;
  return r.every((x) => x === r[0]) ? r[0] : r;
}

export function shadowsFrom(v) {
  if (!v || v === 'none') return [];
  return splitTop(v).map((part) => {
    const color = (/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(part) || [])[1] || 'rgba(0, 0, 0, 0.25)';
    const nums = part.replace(color, '').match(/-?[\d.]+(px)?/g)?.map(num) || [];
    return { type: /inset/.test(part) ? 'inner' : 'drop', x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color: col(color) };
  });
}

function effectsFrom(s) {
  const fx = shadowsFrom(s['box-shadow']);
  const blur = /^blur\(([\d.]+)px\)$/.exec(s.filter || '');
  if (blur) fx.push({ type: 'blur', radius: num(blur[1]) });
  const bg = /^blur\(([\d.]+)px\)/.exec(s['backdrop-filter'] || '');
  if (bg) fx.push({ type: 'bg-blur', radius: num(bg[1]) });
  return fx.length ? fx : undefined;
}

/** What the inspector can't show, kept as plain CSS so nothing is lost. */
function extraCss(s, { text = false, parent = null } = {}) {
  const c = {};
  // A text layer takes its element's text effects only (the box's outline, transform… belong to the box).
  if (text) {
    if (s['text-shadow'] && s['text-shadow'] !== 'none') c['text-shadow'] = s['text-shadow'];
    if (s['-webkit-line-clamp'] && s['-webkit-line-clamp'] !== 'none') Object.assign(c, { display: '-webkit-box', '-webkit-box-orient': 'vertical', '-webkit-line-clamp': s['-webkit-line-clamp'], overflow: 'hidden' });
    return Object.keys(c).length ? c : undefined;
  }
  // cursor is inherited: keep it only where it changes.
  if (s.cursor && !/^(auto|default)$/.test(s.cursor) && s.cursor !== parent?.cursor) c.cursor = s.cursor;
  if (s.transform && s.transform !== 'none') c.transform = s.transform;
  if (s.filter && s.filter !== 'none' && !/^blur\([\d.]+px\)$/.test(s.filter)) c.filter = s.filter;
  if (s['backdrop-filter'] && s['backdrop-filter'] !== 'none' && !/^blur\([\d.]+px\)$/.test(s['backdrop-filter'])) c['backdrop-filter'] = s['backdrop-filter'];
  if (s['outline-style'] && s['outline-style'] !== 'none' && num(s['outline-width'])) {
    c.outline = `${s['outline-width']} ${s['outline-style']} ${s['outline-color']}`;
    if (num(s['outline-offset'])) c['outline-offset'] = s['outline-offset'];
  }
  if (text && s['text-shadow'] && s['text-shadow'] !== 'none') c['text-shadow'] = s['text-shadow'];
  if (s['-webkit-line-clamp'] && s['-webkit-line-clamp'] !== 'none') Object.assign(c, { display: '-webkit-box', '-webkit-box-orient': 'vertical', '-webkit-line-clamp': s['-webkit-line-clamp'], overflow: 'hidden' });
  return Object.keys(c).length ? c : undefined;
}

const tidy = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

const firstText = (sn) => {
  if (sn.text) return sn.text;
  if (sn.value || sn.ph) return sn.value || sn.ph;
  for (const c of sn.c || []) {
    const t = c.t == null ? c.text : firstText(c);
    if (t && t.trim()) return t;
  }
  return '';
};

function nameFor(sn) {
  const a = sn.a || {};
  const label = a['aria-label'] || (sn.t === 'input' || sn.t === 'textarea' ? a.placeholder : '') || '';
  const kind = { button: 'Button', a: 'Link', input: 'Input', textarea: 'Text area', select: 'Select', label: 'Label', nav: 'Nav', ul: 'List', ol: 'List', li: 'Item', img: 'Image', svg: 'Icon', form: 'Form', header: 'Header', footer: 'Footer', h1: 'Heading', h2: 'Heading', h3: 'Heading', p: 'Paragraph' }[sn.t];
  const cls = (a.class || '').split(' ')[0];
  if (label) return `${kind || 'Frame'} · ${label.slice(0, 30)}`;
  const txt = firstText(sn).trim().replace(/\s+/g, ' ');
  if (kind && txt) return `${kind} · ${txt.slice(0, 30)}`;
  if (kind) return kind + (cls ? ` .${cls.slice(0, 24)}` : '');
  if (a.id) return '#' + a.id.slice(0, 30);
  if (cls) return '.' + cls.slice(0, 30);
  return sn.t === 'div' ? 'Frame' : sn.t;
}

const boxVisual = (n) =>
  (n.fills && n.fills.length) || n.stroke || n.effects || n.clip || (n.opacity != null && n.opacity < 1) || n.css || n.radius;

/**
 * A capture → { root, fonts, source }. `asset(url)` turns an image address into what a layer stores
 * ('asset:<id>' when the image was fetched, else the address).
 */
export function fromCapture(cap, { asset = (u) => u } = {}) {
  const root = convert(cap.root, asset, '0', true);
  place(root, { x: 0, y: 0 });
  root.x = 0;
  root.y = 0;
  return root;
}

/** The states a capture brought (hover, focus, pressed), each linked layer by layer to `base`. Unchanged ones are dropped. */
export function statesFromCapture(cap, base, { asset = (u) => u } = {}) {
  const out = [];
  const byPath = new Map();
  for (const { node } of walk([base])) if (node._path) byPath.set(node._path, node.id);
  const sig = (n) => JSON.stringify(n, (k, v) => (k === 'id' || k === '_path' || k === 'name' || k === 'link' ? undefined : v));
  const baseSig = sig(base);
  for (const [state, sn] of Object.entries(cap.states || {})) {
    if (!sn) continue;
    const v = convert(sn, asset, '0', true);
    place(v, { x: 0, y: 0 });
    v.x = v.y = 0;
    if (sig(v) === baseSig) continue;
    for (const { node } of walk([v])) {
      const id = byPath.get(node._path);
      if (id && node !== v) node.link = id;
      delete node._path;
    }
    v.variant = { of: base.id, state };
    out.push(v);
  }
  return out;
}

export const cleanPaths = (root) => {
  for (const { node } of walk([root])) delete node._path;
};

/** Positions relative to each parent (the capture has them relative to the root). */
function place(n, parentAbs) {
  n.x = Math.round((n._abs.x - parentAbs.x) * 100) / 100;
  n.y = Math.round((n._abs.y - parentAbs.y) * 100) / 100;
  n.children?.forEach((c) => place(c, n._abs));
  delete n._abs;
}

function textNode(text, s, abs, { lines = 1, runs, path, name, role } = {}) {
  const t = makeNode('text', {
    name: name || text.trim().replace(/\s+/g, ' ').slice(0, 40) || 'Text',
    text,
    font: tidy(fontFrom(s)),
    w: Math.max(1, Math.ceil(abs.w)),
    h: Math.max(1, Math.ceil(abs.h)),
    sizing: lines > 1 ? { w: 'fixed', h: 'hug' } : { w: 'hug', h: 'hug' },
  });
  t._abs = { ...abs };
  t._path = path;
  if (s['background-clip'] === 'text' && s['background-image'] && s['background-image'] !== 'none') t.fills = fillsFrom(s, (u) => u);
  if (runs) t.runs = runs.map((r) => ({ text: r.text, style: Object.fromEntries(Object.entries(r.s).filter(([k]) => !k.startsWith('__'))) }));
  if (role) t.role = role;
  if (s['text-overflow'] === 'ellipsis') t.truncate = true;
  const css = extraCss(s, { text: true, parent: s });
  if (css) t.css = css;
  return t;
}

function convert(sn, asset, path, isRoot = false, parentS = null) {
  const s = sn.s || {};
  const abs = { x: sn.r.x, y: sn.r.y, w: sn.r.w, h: sn.r.h };
  if (sn.ow != null && s.transform && s.transform !== 'none') {
    abs.x += (sn.r.w - sn.ow) / 2;
    abs.y += (sn.r.h - sn.oh) / 2;
    abs.w = sn.ow;
    abs.h = sn.oh;
  }
  const name = nameFor(sn);
  const opacity = num(s.opacity ?? 1);
  const common = (n) => {
    n._abs = abs;
    n._path = path;
    const css = extraCss(s, { parent: parentS });
    if (css) n.css = css;
    if (s.opacity != null && opacity < 1) n.opacity = opacity;
    if (s['mix-blend-mode'] && s['mix-blend-mode'] !== 'normal') n.blend = s['mix-blend-mode'];
    if (s.visibility === 'hidden') n.hidden = true;
    return n;
  };

  if (sn.svg) return common(makeNode('svg', { name, markup: sn.svg, w: abs.w, h: abs.h, color: col(s.color || '#000'), fills: [] }));
  if (sn.img) {
    const img = makeNode('image', { name, src: asset(sn.img), w: abs.w, h: abs.h, fit: s['object-fit'] && s['object-fit'] !== 'fill' ? s['object-fit'] : 'fill', attrs: sn.a?.alt ? { alt: sn.a.alt } : undefined });
    Object.assign(img, tidy({ radius: radiusFrom(s, abs.w, abs.h), stroke: strokeFrom(s), effects: effectsFrom(s) }));
    return common(img);
  }

  const bw = ['top', 'right', 'bottom', 'left'].map((d) => (s[`border-${d}-style`] && s[`border-${d}-style`] !== 'none' ? num(s[`border-${d}-width`]) : 0));
  const pad = ['top', 'right', 'bottom', 'left'].map((d) => num(s['padding-' + d]));
  // Gradient text (background-clip: text) paints the letters: its fill goes to the text, not the box.
  const f = makeNode('frame', { name, fills: s['background-clip'] === 'text' ? [] : fillsFrom(s, asset), w: abs.w, h: abs.h });
  if (SEMANTIC.has(sn.t) && sn.t !== 'div') f.tag = sn.t;
  Object.assign(f, tidy({ stroke: strokeFrom(s), radius: radiusFrom(s, abs.w, abs.h), effects: effectsFrom(s) }));
  if (/hidden|clip|auto|scroll/.test((s['overflow-x'] || '') + (s['overflow-y'] || ''))) f.clip = true;
  const attrs = {};
  for (const k of ['role', 'aria-label', 'type', 'href', 'name', 'disabled', 'title', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed']) if (sn.a?.[k] != null) attrs[k] = sn.a[k];
  if (Object.keys(attrs).length) f.attrs = attrs;
  common(f);

  // The things inside, in drawing order.
  const items = [];
  const contentBox = { x: abs.x + bw[3] + pad[3], y: abs.y + bw[0] + pad[0], w: abs.w - bw[1] - bw[3] - pad[1] - pad[3], h: abs.h - bw[0] - bw[2] - pad[0] - pad[2] };
  const pseudoNode = (p, which) => {
    const ps = p.s || {};
    const absPos = ps.position === 'absolute' || ps.position === 'fixed';
    let x = which === 'before' ? contentBox.x : contentBox.x + contentBox.w - p.w;
    let y = contentBox.y;
    if (absPos) {
      if (ps.left && ps.left !== 'auto') x = abs.x + bw[3] + num(ps.left);
      else if (ps.right && ps.right !== 'auto') x = abs.x + abs.w - bw[1] - num(ps.right) - p.w;
      if (ps.top && ps.top !== 'auto') y = abs.y + bw[0] + num(ps.top);
      else if (ps.bottom && ps.bottom !== 'auto') y = abs.y + abs.h - bw[2] - num(ps.bottom) - p.h;
    }
    const pabs = { x, y, w: p.w || num(ps['font-size']) || 10, h: p.h || num(ps['line-height']) || num(ps['font-size']) * 1.2 || 10 };
    let n;
    if (p.text) n = textNode(p.text, ps, pabs, { path: `${path}:${which}`, name: `::${which}` });
    else if (p.img) n = Object.assign(makeNode('image', { name: `::${which}`, src: asset(p.img), fit: 'contain' }), { _abs: pabs, _path: `${path}:${which}`, w: pabs.w, h: pabs.h });
    else {
      n = makeNode('frame', { name: `::${which}`, fills: fillsFrom(ps, asset), w: pabs.w, h: pabs.h });
      Object.assign(n, tidy({ stroke: strokeFrom(ps), radius: radiusFrom(ps, pabs.w, pabs.h), effects: effectsFrom(ps) }));
      n._abs = pabs;
      n._path = `${path}:${which}`;
      const css = extraCss(ps, { parent: s });
      if (css) n.css = css;
    }
    if (absPos) n._absolute = true;
    if (ps.opacity != null && num(ps.opacity) < 1) n.opacity = num(ps.opacity);
    return n;
  };
  if (sn.before) items.push(pseudoNode(sn.before, 'before'));

  // Form fields: their text (value or placeholder) inside, the way the browser draws it.
  let field = false;
  if (/^(input|textarea|select)$/.test(sn.t)) {
    field = true;
    if (sn.checked != null) {
      const radio = sn.a?.type === 'radio';
      Object.assign(f, { fills: [{ type: 'solid', color: sn.checked ? '#0a84ff' : '#ffffff' }], stroke: sn.checked ? undefined : { color: '#8e8e93', width: 1 }, radius: radio ? Math.min(abs.w, abs.h) / 2 : 3 });
      if (sn.checked) f.children.push(Object.assign(makeNode(radio ? 'ellipse' : 'svg', radio ? { name: 'Dot', fills: [{ type: 'solid', color: '#fff' }] } : { name: 'Check', markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="100%" height="100%"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>', color: '#fff' }), { _abs: radio ? { x: abs.x + abs.w * 0.3, y: abs.y + abs.h * 0.3, w: abs.w * 0.4, h: abs.h * 0.4 } : { ...abs } }));
      f.children.forEach((c) => (c.w = c._abs.w, c.h = c._abs.h));
      return f;
    }
    const text = sn.value || sn.ph || '';
    if (text) {
      const ts = sn.value ? s : { ...s, color: sn.phColor || s.color };
      const t = textNode(text, ts, { x: contentBox.x, y: contentBox.y, w: contentBox.w, h: contentBox.h }, { path: path + ':text', role: sn.value ? 'value' : 'placeholder', lines: sn.t === 'textarea' ? 2 : 1 });
      if (sn.t !== 'textarea') t.sizing = { w: 'fill', h: 'hug' };
      items.push(t);
    }
    if (sn.t === 'select') {
      const chev = makeNode('svg', { name: 'Chevron', markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="100%" height="100%"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color: col(s.color || '#000'), w: 12, h: 12 });
      chev._abs = { x: abs.x + abs.w - 12 - Math.max(6, pad[1]), y: abs.y + (abs.h - 12) / 2, w: 12, h: 12 };
      items.push(chev);
    }
  } else if (sn.frame) {
    f.fills = [{ type: 'solid', color: '#e5e5ea' }];
    items.push(textNode('Embedded content', { ...s, color: '#8e8e93', 'font-size': '12px' }, { x: abs.x + 8, y: abs.y + 8, w: 120, h: 16 }, { path: path + ':frame' }));
  } else if (sn.text != null) {
    const tr = sn.tr || contentBox;
    const multi = (sn.lines || 1) > 1;
    const tabs = multi ? { x: contentBox.x, y: tr.y, w: contentBox.w, h: tr.h } : { ...tr };
    items.push(textNode(sn.text, s, tabs, { lines: sn.lines, runs: sn.runs, path: path + ':text' }));
  } else {
    (sn.c || []).forEach((c, i) => {
      if (c.t == null && c.text != null) items.push(textNode(c.text, s, c.r, { lines: c.lines, path: `${path}.${i}t` }));
      else {
        const n = convert(c, asset, `${path}.${i}`, false, s);
        if (n) {
          if (c.s?.position === 'absolute' || c.s?.position === 'fixed') n._absolute = true;
          n._margins = ['top', 'right', 'bottom', 'left'].map((d) => num(c.s?.['margin-' + d]));
          n._alignSelf = c.s?.['align-self'];
          items.push(n);
        }
      }
    });
  }
  if (sn.after) items.push(pseudoNode(sn.after, 'after'));

  // Layout: auto layout when the browser laid it out as a flex row or column we can say the same way.
  const display = s.display || '';
  const flow = items.filter((n) => !n._absolute);
  const flexOk =
    /flex/.test(display) &&
    flow.length > 0 &&
    flow.every((n) => !n._margins?.some(Boolean) && (!n._alignSelf || /^(auto|normal)$/.test(n._alignSelf))) &&
    /^(normal|flex-start|start|left|center|flex-end|end|right|space-between)$/.test(s['justify-content'] || 'normal') &&
    !/^(space-around|space-evenly)$/.test(s['justify-content'] || '');
  const single = !flexOk && flow.length === 1 && flow[0].type === 'text' && (field || boxVisual(f) || INTERACTIVE.test(sn.t) || /inline|flex/.test(display) || pad.some(Boolean));

  if (flexOk || single) {
    const dirRaw = s['flex-direction'] || 'row';
    const column = flexOk && dirRaw.startsWith('column');
    if (flexOk && /reverse/.test(dirRaw)) items.reverse();
    const jc = s['justify-content'] || 'normal';
    const ai = s['align-items'] || 'normal';
    const L = { mode: column ? 'column' : 'row', padding: pad.map((p) => Math.round(p * 100) / 100), gap: 0 };
    if (flexOk) {
      L.gap = num(column ? s['row-gap'] : s['column-gap']);
      if (s['flex-wrap'] && s['flex-wrap'] !== 'nowrap') Object.assign(L, { wrap: true, rowGap: num(s['row-gap']) });
      L.justify = /center/.test(jc) ? 'center' : /end|right/.test(jc) ? 'end' : /between/.test(jc) ? 'between' : 'start';
      L.align = /center/.test(ai) ? 'center' : /end/.test(ai) ? 'end' : /baseline/.test(ai) ? 'baseline' : 'start';
    } else {
      // One text inside a box: put it where it actually sits.
      const t = flow[0];
      const fa = fontFrom(s).align;
      L.justify = field ? (fa === 'center' ? 'center' : fa === 'right' ? 'end' : 'start') : near(t._abs.x - contentBox.x, contentBox.w - t._abs.w);
      L.align = sn.t === 'textarea' ? 'start' : field ? 'center' : near(t._abs.y - contentBox.y, contentBox.h - t._abs.h);
      if (t.sizing.w === 'fixed' && !field) t.sizing = { w: 'fill', h: 'hug' };
      if (t.font.align === 'center' && L.justify === 'center') t.font.align = 'center';
    }
    f.layout = L;
    // Hug the content when the box was exactly as big as its content (a button), so editing the label resizes it.
    const mainSum = flow.reduce((t, n) => t + (column ? n._abs.h : n._abs.w), 0) + L.gap * Math.max(0, flow.length - 1);
    const crossMax = Math.max(0, ...flow.map((n) => (column ? n._abs.w : n._abs.h)));
    const inW = abs.w - bw[1] - bw[3] - pad[1] - pad[3];
    const inH = abs.h - bw[0] - bw[2] - pad[0] - pad[2];
    const hugW = !L.wrap && Math.abs((column ? crossMax : mainSum) - inW) < 1.5 && flow.every((n) => n.sizing?.w !== 'fill');
    const hugH = !L.wrap && Math.abs((column ? mainSum : crossMax) - inH) < 1.5;
    f.sizing = { w: hugW ? 'hug' : 'fixed', h: hugH ? 'hug' : 'fixed' };
    // Content-box sizing: CSS sizes include padding and border (we draw border-box); nothing to do.
    f.children = items.map((n) => {
      if (n._absolute) n.absolute = true;
      if (!n.absolute && n.type === 'text' && !single && n.sizing.w === 'fixed' && (n.lines || 0) <= 1) n.sizing = { w: 'hug', h: 'hug' };
      return n;
    });
  } else if (stackOf(f, flow, items, display, abs, bw)) {
    // Block elements stacked evenly (a card's title, text and button): a vertical auto layout.
  } else {
    // Positioned as drawn. Plain wrappers (no look of their own) give their children to this frame.
    f.layout = { mode: 'none' };
    const out = [];
    const take = (n) => {
      if (n._plain && !n._absolute) n.children.forEach(take);
      else out.push(n);
    };
    items.forEach(take);
    f.children = out;
  }
  for (const n of f.children) delete n._margins, delete n._alignSelf, delete n._absolute, delete n._plain;
  if (!isRoot && f.layout.mode === 'none' && !boxVisual(f) && !f.tag && !f.attrs && !f.hidden) f._plain = true;
  // A wrapper exactly around one thing (a <span> around a label): just the thing, which keeps the element it was.
  if (!isRoot && !boxVisual(f) && f.children.length === 1 && !f.hidden && !/^(button|input|textarea|select|label|li|ul|ol|nav|form)$/.test(f.tag || '')) {
    const c = f.children[0];
    const near = (a, b, t = 1.5) => Math.abs(a - b) < t;
    const same = near(c._abs.x, abs.x) && near(c._abs.y, abs.y) && near(c._abs.w, abs.w) && near(c._abs.h, abs.h);
    // Text inside a box of its own (a heading, a paragraph, a label's <span>): the text is the layer, as wide as the
    // box when it's wider (keeping its alignment), hugging when it's about the same.
    const inside = c._abs.x >= abs.x - 1 && c._abs.y >= abs.y - 1 && c._abs.x + c._abs.w <= abs.x + abs.w + 1 && c._abs.y + c._abs.h <= abs.y + abs.h + 1;
    const textInside = c.type === 'text' && inside && near(c._abs.h, abs.h, 3);
    // Generic wrappers (span, div) give way to what they wrap, whatever it is.
    const generic = !f.tag || /^(span|div|section)$/.test(f.tag);
    if ((same || textInside) && (!(f.tag && c.tag) || generic)) {
      if (f.tag && !(generic && c.tag)) c.tag = f.tag;
      if (f.attrs && !c.attrs) c.attrs = f.attrs;
      if (same) c._abs = abs;
      else if (textInside && !near(c._abs.w, abs.w, 3)) {
        c._abs = { ...c._abs, x: abs.x, w: abs.w };
        c.sizing = { w: 'fixed', h: 'hug' };
      }
      c._path ||= path;
      return c;
    }
  }
  return f;
}

/**
 * Block children stacked top to bottom with even spacing → a column auto layout (padding and gap measured), so the
 * stack stays editable: change a heading and what's below moves down. Returns false when it doesn't fit that.
 */
function stackOf(f, flow, items, display, abs, bw) {
  if (!/^(block|flow-root|list-item)$/.test(display) || flow.length < 2 || items.some((n) => n._absolute)) return false;
  for (let i = 1; i < flow.length; i++) if (flow[i]._abs.y < flow[i - 1]._abs.y + flow[i - 1]._abs.h - 0.5) return false;
  const gaps = flow.slice(1).map((n, i) => n._abs.y - (flow[i]._abs.y + flow[i]._abs.h));
  if (Math.min(...gaps) < -0.5 || Math.max(...gaps) - Math.min(...gaps) > 1) return false;
  const xs = flow.map((n) => n._abs.x);
  if (Math.max(...xs) - Math.min(...xs) > 1) return false; // everything starts at the same left edge
  const left = abs.x + bw[3];
  const right = abs.x + abs.w - bw[1];
  const last = flow[flow.length - 1];
  const r2 = (v) => Math.max(0, Math.round(v * 100) / 100);
  const maxR = Math.max(...flow.map((n) => n._abs.x + n._abs.w));
  const padding = [r2(flow[0]._abs.y - abs.y - bw[0]), r2(right - maxR), r2(abs.y + abs.h - bw[2] - (last._abs.y + last._abs.h)), r2(Math.min(...xs) - left)];
  const inner = abs.w - bw[1] - bw[3] - padding[1] - padding[3];
  f.layout = { mode: 'column', gap: r2(gaps.reduce((a, b) => a + b, 0) / gaps.length), padding, align: 'start', justify: 'start' };
  f.sizing = { w: 'fixed', h: 'hug' };
  f.children = flow.map((n) => {
    // Full-width children (paragraphs, inputs) stretch with the stack.
    if (Math.abs(n._abs.w - inner) < 1.5) n.sizing = { w: 'fill', h: n.type === 'text' ? 'hug' : n.sizing?.h || 'fixed' };
    return n;
  });
  return true;
}

/** Where something sits in the room it has: start, center or end. */
function near(offset, room) {
  if (room < 2) return 'start';
  if (Math.abs(offset - room / 2) < Math.max(1.5, room * 0.12)) return 'center';
  if (Math.abs(offset - room) < 1.5) return 'end';
  return 'start';
}

/* ---------------- other ways in ---------------- */

/** Render HTML in a hidden frame (no scripts run) and capture it. `width`: the frame's width. */
export async function captureHtml(html, { width = 1200, baseUrl = '' } = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position: fixed; left: -30000px; top: 0; width: ${width}px; height: 2000px; border: 0; pointer-events: none;`;
  const looksFull = /<html[\s>]/i.test(html);
  frame.srcdoc = looksFull ? html : `<!doctype html><html><head><meta charset="utf-8">${baseUrl ? `<base href="${baseUrl.replace(/"/g, '')}">` : ''}<style>body { margin: 0; font-family: system-ui, sans-serif; display: inline-block; max-width: ${width}px; }</style></head><body>${html}</body></html>`;
  document.body.append(frame);
  try {
    await new Promise((r) => {
      frame.onload = r;
      setTimeout(r, 4000);
    });
    const doc = frame.contentDocument;
    if (!doc?.body) throw new Error('Couldn’t read that HTML');
    await Promise.race([Promise.all([doc.fonts?.ready, ...[...doc.images].map((i) => i.decode().catch(() => {}))]), new Promise((r) => setTimeout(r, 2500))]);
    const els = [...doc.body.children].filter((e) => !/^(script|style|meta|link)$/i.test(e.tagName));
    const root = els.length === 1 ? els[0] : doc.body;
    if (root === doc.body) Object.assign(doc.body.style, { display: 'inline-block', padding: '0' });
    const cap = inPage('serialize', { el: root });
    if (!cap?.root || (!cap.root.r.w && !cap.root.r.h)) throw new Error('That HTML doesn’t draw anything');
    if (root === doc.body) cap.root.t = 'div';
    cap.url = baseUrl;
    cap.title = '';
    return cap;
  } finally {
    frame.remove();
  }
}

/** An SVG's size from its attributes or viewBox. */
export function svgSize(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName !== 'svg') return null;
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let w = parseFloat(svg.getAttribute('width')) || vb[2] || 100;
  let h = parseFloat(svg.getAttribute('height')) || vb[3] || 100;
  if (!svg.getAttribute('viewBox') && w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.querySelectorAll('script, foreignObject').forEach((x) => x.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  return { w, h, markup: new XMLSerializer().serializeToString(svg) };
}

/** An image's natural size. */
export const imageSize = (src) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 200, h: 150 });
    img.src = src;
  });

/** The bookmarklet for other browsers: pick an element there, it's copied; paste it into Designer. */
export const bookmarklet = () => 'javascript:' + encodeURIComponent(`(${inPage.toString()})('pick',{copy:true});void 0`);

export const CAPTURE_PREFIX = 'LEAFDECK-ELEMENT/1\n';
export const LAYERS_PREFIX = 'LEAFDECK-LAYERS/1\n';
export { inPage, uid };
