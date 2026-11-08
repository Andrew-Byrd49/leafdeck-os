// Graphic Designer's document: artboards and objects, how each is drawn as SVG (on the canvas and in exports), their
// bounds, and transforming them.
//
// A document: { kind: 'graphic', name, artboards: [{ id, name, x, y, w, h, bg }], nodes: [...], swatches: [...] }.
// Objects (nodes), bottom to top as SVG paints them:
//   path     { subpaths, fillRule }       world coordinates (see geom.js); an anchor with cr is a live rounded corner
//   rect     { x, y, w, h, rot, r, corners: [tl, tr, br, bl]? }   ellipse { x, y, w, h, rot }
//   polygon  { x, y, w, h, rot, sides, r }  star { x, y, w, h, rot, points, inner, r }   live shapes: turned around their middle
//   text     { x, y, rot, w (null: point text), text, font: { family, size, weight, italic, lh, ls, align, case, deco } }
//   image    { x, y, w, h, rot, flip, src, adjust: { brightness, contrast, saturate, hue, grayscale, sepia, invert }? }
//   group    { children, clip }          clip: the top child is a clipping mask for the rest
// Every object: { id, type, name, hidden, locked, fill, stroke, sw, cap, join, dash, ends, opacity, blend, effects }.
//   ends: arrowheads on open paths, { start, end: 'none' | 'arrow' | 'arrow-open' | 'circle' | 'square' | 'bar', size }.
//   effects: [{ type: 'shadow' | 'blur' | 'glow' | 'inner-shadow', ... }].
// A paint (fill, stroke): null, { type: 'solid', color } or { type: 'linear' | 'radial', angle, stops: [{ color, pos }] }.
//   A linear gradient placed by hand has x1, y1, x2, y2 (fractions of the object's box) instead of the angle; a radial
//   one cx, cy, r (fractions too). Those are what the Gradient tool drags.
// The document also keeps guides [{ v: x } | { h: y }], grid { size, show, snap }, units ('px' | 'pt' | 'in' | 'mm' |
// 'cm') and rulers (shown or not).
import { uid, esc } from '../util.js';
import * as G from './geom.js';

export const SHAPES = ['rect', 'ellipse', 'polygon', 'star'];
export const BOXED = [...SHAPES, 'image'];
export const NAMES = { path: 'Path', rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', text: 'Text', image: 'Image', group: 'Group' };
export const FONT = { family: 'Inter', size: 48, weight: 400, italic: false, lh: 1.2, ls: 0, align: 'left', case: 'none', deco: 'none' };
export const ENDS = ['none', 'arrow', 'arrow-open', 'circle', 'square', 'bar'];
export const END_NAMES = { none: 'None', arrow: 'Arrow', 'arrow-open': 'Open arrow', circle: 'Circle', square: 'Square', bar: 'Bar' };
export const ADJUST = { brightness: 1, contrast: 1, saturate: 1, hue: 0, grayscale: 0, sepia: 0, invert: 0 };
/** Units: how many pixels (CSS, 96 per inch) one of each is. */
export const UNITS = { px: 1, pt: 96 / 72, in: 96, mm: 96 / 25.4, cm: 96 / 2.54 };

export const newId = () => uid().replace(/[^a-z0-9]/g, '');
export const solid = (color) => ({ type: 'solid', color });

export function makeNode(type, o = {}) {
  const n = { id: newId(), type, name: o.name || NAMES[type] || 'Object', fill: solid('#d9d9d9'), stroke: null, sw: 1, opacity: 1, ...o };
  if (type === 'path') {
    n.subpaths ??= [];
    n.fill = o.fill === undefined ? null : o.fill;
    n.stroke = o.stroke === undefined ? solid('#1e1e1e') : o.stroke;
  }
  if (type === 'text') {
    n.font = { ...FONT, ...(o.font || {}) };
    n.fill = o.fill === undefined ? solid('#1e1e1e') : o.fill;
    n.text ??= '';
    n.w ??= null;
  }
  if (type === 'group') {
    n.children ??= [];
    delete n.fill;
  }
  if (type === 'image') n.fill = null;
  n.rot ??= 0;
  return n;
}

/* ---------------- walking the tree ---------------- */

export function walk(nodes, fn, parent = null) {
  for (const n of nodes) {
    if (fn(n, parent) === false) return false;
    if (n.children && walk(n.children, fn, n) === false) return false;
  }
}
export function find(nodes, id) {
  let out = null;
  walk(nodes, (n) => (n.id === id ? ((out = n), false) : undefined));
  return out;
}
export function parentOf(nodes, id, parent = null) {
  for (const n of nodes) {
    if (n.id === id) return { parent, list: nodes, index: nodes.indexOf(n) };
    if (n.children) {
      const r = parentOf(n.children, id, n);
      if (r) return r;
    }
  }
  return null;
}
/** A copy with new ids all the way down. */
export function cloneFresh(n) {
  const c = structuredClone(n);
  walk([c], (x) => (x.id = newId()));
  return c;
}

/* ---------------- text ---------------- */

let mctx = null;
const fontCss = (f) => `${f.italic ? 'italic ' : ''}${f.weight || 400} ${f.size}px ${quoteFamily(f.family)}`;
const quoteFamily = (fam) =>
  String(fam || 'Inter')
    .split(',')
    .map((s) => s.trim())
    .map((s) => (/^[\w-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`))
    .join(', ') + ', sans-serif';
/** Text with the font's case applied (what's drawn and measured). */
export function caseText(s, c) {
  s = String(s ?? '');
  if (c === 'upper') return s.toUpperCase();
  if (c === 'lower') return s.toLowerCase();
  if (c === 'title') return s.toLowerCase().replace(/(^|[\s(\["'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return s;
}
export function measure(f, s) {
  mctx ??= document.createElement('canvas').getContext('2d');
  mctx.font = fontCss(f);
  return mctx.measureText(s).width + Math.max(0, s.length - 1) * (f.ls || 0);
}
/** The lines a text object shows (area text wraps to its width). */
export function textLines(n) {
  const f = n.font;
  const out = [];
  for (const para of caseText(n.text, f.case).split('\n')) {
    if (n.w == null || !para) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/(?<=\s)/)) {
      const next = line + word;
      if (line && measure(f, next.trimEnd()) > n.w) {
        out.push(line.trimEnd());
        line = word;
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}
/** A text object's box in its own frame: { w, h, lines }. */
export function textBox(n) {
  const lines = textLines(n);
  const lh = n.font.size * (n.font.lh || 1.2);
  const w = n.w ?? Math.max(1, ...lines.map((l) => measure(n.font, l)));
  return { w, h: Math.max(1, lines.length) * lh, lines, lh };
}
/** The frame (local → world) of anything with a box: shapes, images, text. */
export function boxOf(n) {
  if (n.type === 'text') {
    const b = textBox(n);
    return { x: n.x, y: n.y, w: b.w, h: b.h, rot: n.rot, flip: n.flip };
  }
  return n;
}
export const nodeFrame = (n) => G.frameMatrix(boxOf(n));

/* ---------------- geometry of any object ---------------- */

/** An object's outline as a world-coordinate path (live shapes, images and text as their boxes). */
export function outline(n) {
  if (n.type === 'path') return G.hasCorners(n.subpaths) ? G.roundCorners(n.subpaths) : G.clonePath(n.subpaths);
  if (SHAPES.includes(n.type)) return G.transformPath(G.shapeLocal(n), G.frameMatrix(n));
  if (n.type === 'image' || n.type === 'text') {
    const b = boxOf(n);
    return G.transformPath([{ closed: true, pts: [G.anchor(0, 0), G.anchor(b.w, 0), G.anchor(b.w, b.h), G.anchor(0, b.h)] }], G.frameMatrix(b));
  }
  if (n.type === 'group') return (n.clip && n.children.length ? [n.children[n.children.length - 1]] : n.children).flatMap((c) => outline(c));
  return [];
}

/** World bounds of an object (geometry; strokes not included). */
export function bounds(n) {
  if (n.type === 'group') {
    const kids = n.clip && n.children.length ? [n.children[n.children.length - 1]] : n.children;
    return kids.filter((c) => !c.hidden).reduce((b, c) => G.union(b, bounds(c)), G.EMPTY());
  }
  return G.pathBox(outline(n));
}
export const boundsOf = (list) => list.reduce((b, n) => G.union(b, bounds(n)), G.EMPTY());

/** The box handles go around: an object's own turned box when it has one, else its bounds. { m, w, h } (m: local → world). */
export function selectionFrame(list) {
  if (list.length === 1 && (BOXED.includes(list[0].type) || list[0].type === 'text') && list[0].rot) {
    const b = boxOf(list[0]);
    return { m: G.frameMatrix({ ...b, flip: false }), w: b.w, h: b.h, rot: b.rot };
  }
  const b = boundsOf(list);
  if (G.isEmpty(b)) return null;
  return { m: G.translate(b.x1, b.y1), w: b.x2 - b.x1, h: b.y2 - b.y1, rot: 0 };
}

/* ---------------- transforming ---------------- */

/** A live shape (or anything with a box) as a path object, looking the same. */
export function toPath(n) {
  if (n.type === 'path') return n;
  const p = { ...n, type: 'path', subpaths: outline(n), fillRule: 'nonzero' };
  for (const k of ['x', 'y', 'w', 'h', 'rot', 'r', 'sides', 'points', 'inner', 'flip']) delete p[k];
  if (n.name === NAMES[n.type]) p.name = 'Path';
  return p;
}

/**
 * Apply a world transform to an object, in place. Paths take it into their points; boxes stay boxes while the transform
 * keeps them rectangles (moves, turns, scales along their sides), otherwise live shapes become paths. Returns the object
 * (a new one when it had to change type).
 */
export function transform(n, A, { strokes = false } = {}) {
  const det = A[0] * A[3] - A[1] * A[2];
  const sc = Math.sqrt(Math.abs(det));
  if (strokes && n.stroke && n.sw) n.sw = G.r2(n.sw * sc);
  if (n.type === 'group') {
    n.children = n.children.map((c) => transform(c, A, { strokes }));
    return n;
  }
  if (n.type === 'path') {
    G.transformPath(n.subpaths, A);
    if (Math.abs(sc - 1) > 1e-9 && G.hasCorners(n.subpaths)) for (const sp of n.subpaths) for (const p of sp.pts) if (p.cr) p.cr = G.r2(p.cr * sc);
    return n;
  }
  const b = boxOf(n);
  const N = G.mul(A, G.frameMatrix(b));
  const u = { x: N[0], y: N[1] };
  const v = { x: N[2], y: N[3] };
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  const ortho = Math.abs(u.x * v.x + u.y * v.y) < 1e-6 * Math.max(1, lu * lv);
  const flipped = N[0] * N[3] - N[1] * N[2] < 0;
  if (!ortho || (flipped && (n.type === 'polygon' || n.type === 'star'))) {
    if (SHAPES.includes(n.type)) return transform(toPath(n), A);
  }
  const w = b.w * lu;
  const h = b.h * lv;
  const c = G.ap(N, b.w / 2, b.h / 2);
  // A mirrored frame's x axis points the other way (frameMatrix flips before turning), so its angle is the opposite one.
  // Rectangles and ellipses look the same mirrored: they just turn.
  const mirror = flipped && (n.type === 'image' || n.type === 'text');
  let rot = (Math.atan2(mirror ? -u.y : u.y, mirror ? -u.x : u.x) * 180) / Math.PI;
  if (Math.abs(rot) < 1e-7) rot = 0;
  n.rot = Math.round(rot * 1000) / 1000;
  if (n.type === 'image' || n.type === 'text') n.flip = flipped;
  if (n.type === 'text') {
    // Area text: the width follows, the type scales with the height. Point text: the type scales.
    const s = n.w != null ? lv : Math.sqrt(lu * lv);
    if (Math.abs(s - 1) > 1e-9) n.font = { ...n.font, size: G.r2(n.font.size * s) };
    if (n.w != null) n.w = w;
    const nb = textBox(n);
    n.x = c.x - nb.w / 2;
    n.y = c.y - nb.h / 2;
    return n;
  }
  n.w = w;
  n.h = h;
  n.x = c.x - w / 2;
  n.y = c.y - h / 2;
  if (n.type === 'rect' && (n.r || n.corners) && (Math.abs(lu - 1) > 1e-9 || Math.abs(lv - 1) > 1e-9) && strokes) {
    n.r = G.r2((n.r || 0) * Math.min(lu, lv));
    if (n.corners) n.corners = n.corners.map((c) => (c == null ? c : G.r2(c * Math.min(lu, lv))));
  }
  return n;
}

/* ---------------- drawing as SVG ---------------- */

export function gradientEnds(angle = 0) {
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a) / 2;
  const dy = Math.sin(a) / 2;
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}
/** Where a linear gradient runs, as fractions of the object's box: its own points, or from its angle. */
export function gradientLine(p) {
  if (p?.x1 != null) return { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 };
  return gradientEnds(p?.angle || 0);
}
const f3 = (v) => G.r2(v * 1000) / 1000;
function paintDef(p, id) {
  if (!p || p.type === 'solid') return '';
  const stops = (p.stops || []).map((s) => `<stop offset="${G.r2(s.pos * 100)}%" stop-color="${esc(s.color)}"/>`).join('');
  if (p.type === 'radial') return `<radialGradient id="${id}" cx="${f3(p.cx ?? 0.5)}" cy="${f3(p.cy ?? 0.5)}" r="${f3(p.r ?? 0.5)}">${stops}</radialGradient>`;
  const e = gradientLine(p);
  return `<linearGradient id="${id}" x1="${f3(e.x1)}" y1="${f3(e.y1)}" x2="${f3(e.x2)}" y2="${f3(e.y2)}">${stops}</linearGradient>`;
}
/** A gradient's angle in degrees (from its points when it has them). */
export const gradientAngle = (p) => (p?.x1 != null ? G.r2((Math.atan2(p.y2 - p.y1, p.x2 - p.x1) * 180) / Math.PI) : p?.angle || 0);
const paintRef = (p, id) => (!p ? 'none' : p.type === 'solid' ? esc(p.color) : `url(#${id})`);
export const paintCss = (p) =>
  !p ? 'transparent' : p.type === 'solid' ? p.color : p.type === 'radial' ? `radial-gradient(${p.stops.map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})` : `linear-gradient(${gradientAngle(p) + 90}deg, ${p.stops.map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})`;
/** The first color of a paint (markers and text carets use it). */
export const paintColor = (p, fallback = '#1e1e1e') => (!p ? fallback : p.type === 'solid' ? p.color : p.stops?.[0]?.color || fallback);

const mstr = (m) => `matrix(${m.map((v) => G.r2(v * 1000) / 1000).join(' ')})`;

/** Does an image's adjust differ from no adjustment? */
export const adjusted = (a) => !!a && Object.keys(ADJUST).some((k) => a[k] != null && Math.abs(a[k] - ADJUST[k]) > 1e-6);
const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
function adjustDefs(a, input, i) {
  // Each adjustment is one filter primitive, chained; the same math as CSS's filter functions.
  let body = '';
  let last = input;
  const step = (prim, name) => {
    body += prim.replace('IN', last).replace('RES', `${name}${i}`);
    last = `${name}${i}`;
  };
  const v = { ...ADJUST, ...a };
  if (Math.abs(v.brightness - 1) > 1e-6) step(`<feComponentTransfer in="IN" result="RES"><feFuncR type="linear" slope="${v.brightness}"/><feFuncG type="linear" slope="${v.brightness}"/><feFuncB type="linear" slope="${v.brightness}"/></feComponentTransfer>`, 'ab');
  if (Math.abs(v.contrast - 1) > 1e-6) {
    const ic = 0.5 - 0.5 * v.contrast;
    step(`<feComponentTransfer in="IN" result="RES"><feFuncR type="linear" slope="${v.contrast}" intercept="${ic}"/><feFuncG type="linear" slope="${v.contrast}" intercept="${ic}"/><feFuncB type="linear" slope="${v.contrast}" intercept="${ic}"/></feComponentTransfer>`, 'ac');
  }
  if (Math.abs(v.saturate - 1) > 1e-6) step(`<feColorMatrix in="IN" result="RES" type="saturate" values="${v.saturate}"/>`, 'as');
  if (v.grayscale > 1e-6) step(`<feColorMatrix in="IN" result="RES" type="saturate" values="${1 - Math.min(1, v.grayscale)}"/>`, 'ag');
  if (Math.abs(v.hue) > 1e-6) step(`<feColorMatrix in="IN" result="RES" type="hueRotate" values="${v.hue}"/>`, 'ah');
  if (v.sepia > 1e-6) {
    const t = Math.min(1, v.sepia);
    const m = SEPIA.map((x, k) => (k % 4 === 0 ? 1 - t + x * t : x * t));
    step(`<feColorMatrix in="IN" result="RES" type="matrix" values="${m.slice(0, 3).join(' ')} 0 0 ${m.slice(3, 6).join(' ')} 0 0 ${m.slice(6, 9).join(' ')} 0 0 0 0 0 1 0"/>`, 'ap');
  }
  if (v.invert > 1e-6) {
    const t = Math.min(1, v.invert);
    step(`<feComponentTransfer in="IN" result="RES"><feFuncR type="table" tableValues="${t} ${1 - t}"/><feFuncG type="table" tableValues="${t} ${1 - t}"/><feFuncB type="table" tableValues="${t} ${1 - t}"/></feComponentTransfer>`, 'ai');
  }
  return { body, last };
}
function filterDef(n, id) {
  const fx = (n.effects || []).filter((e) => !e.off);
  const adj = n.type === 'image' && adjusted(n.adjust);
  if (!fx.length && !adj) return '';
  let body = '';
  let last = 'SourceGraphic';
  if (adj) {
    const a = adjustDefs(n.adjust, last, 0);
    body += a.body;
    last = a.last;
  }
  const under = []; // behind the object: shadows and glows
  const over = []; // on top: inner shadows
  fx.forEach((e, i) => {
    if (e.type === 'blur') {
      body += `<feGaussianBlur in="${last}" stdDeviation="${Math.max(0, e.r) / 2}" result="b${i}"/>`;
      last = `b${i}`;
    }
  });
  fx.forEach((e, i) => {
    if (e.type === 'shadow') {
      body += `<feDropShadow in="SourceGraphic" dx="${e.x}" dy="${e.y}" stdDeviation="${Math.max(0, e.blur) / 2}" flood-color="${esc(e.color)}" result="s${i}"/>`;
      under.push(`s${i}`);
    }
    if (e.type === 'glow') {
      body += `<feMorphology in="SourceAlpha" operator="dilate" radius="${Math.max(0, e.spread || 0)}" result="gd${i}"/><feGaussianBlur in="gd${i}" stdDeviation="${Math.max(0, e.r) / 2}" result="gb${i}"/><feFlood flood-color="${esc(e.color)}" result="gc${i}"/><feComposite in="gc${i}" in2="gb${i}" operator="in" result="g${i}"/>`;
      under.push(`g${i}`);
    }
    if (e.type === 'inner-shadow') {
      body += `<feGaussianBlur in="SourceAlpha" stdDeviation="${Math.max(0, e.blur) / 2}" result="ib${i}"/><feOffset in="ib${i}" dx="${e.x}" dy="${e.y}" result="io${i}"/><feComposite in="SourceAlpha" in2="io${i}" operator="arithmetic" k2="1" k3="-1" result="ii${i}"/><feFlood flood-color="${esc(e.color)}" result="ic${i}"/><feComposite in="ic${i}" in2="ii${i}" operator="in" result="is${i}"/>`;
      over.push(`is${i}`);
    }
  });
  if (under.length || over.length || last !== 'SourceGraphic') body += `<feMerge>${[...under, last, ...over].map((p) => `<feMergeNode in="${p}"/>`).join('')}</feMerge>`;
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}</filter>`;
}

/** Arrowheads and other line ends, as SVG markers that scale with the stroke. */
function markerDefs(n, id) {
  const e = n.ends;
  if (!e || ((!e.start || e.start === 'none') && (!e.end || e.end === 'none'))) return { defs: '', attrs: '' };
  const color = esc(paintColor(n.stroke));
  const size = 5 * (e.size || 1);
  const shape = (kind) => {
    if (kind === 'arrow') return `<path d="M0 0.5L10 5 0 9.5z" fill="${color}"/>`;
    if (kind === 'arrow-open') return `<path d="M1.5 1.5L9 5 1.5 8.5" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (kind === 'circle') return `<circle cx="5" cy="5" r="3.6" fill="${color}"/>`;
    if (kind === 'square') return `<rect x="1.4" y="1.4" width="7.2" height="7.2" fill="${color}"/>`;
    if (kind === 'bar') return `<path d="M5 0.5V9.5" stroke="${color}" stroke-width="2"/>`;
    return '';
  };
  const refX = (kind) => (kind === 'arrow' || kind === 'arrow-open' ? 9 : 5);
  let defs = '';
  let attrs = '';
  for (const which of ['start', 'end']) {
    const kind = e[which];
    if (!kind || kind === 'none') continue;
    defs += `<marker id="${id}-${which}" viewBox="0 0 10 10" refX="${refX(kind)}" refY="5" markerWidth="${size}" markerHeight="${size}" markerUnits="strokeWidth" orient="auto-start-reverse">${shape(kind)}</marker>`;
    attrs += ` marker-${which}="url(#${id}-${which})"`;
  }
  return { defs, attrs };
}

/**
 * An object as SVG. o: { canvas (data-id attributes and hit areas), assets ({ id: dataURL }), hit (hit-area width in
 * world units), prefix (for ids, so exports don't collide) }.
 */
export function nodeSvg(n, o = {}) {
  if (n.hidden) return '';
  const pre = (o.prefix || '') + n.id;
  let defs = '';
  const attrs = [];
  if (o.canvas) attrs.push(`data-id="${n.id}"`);
  if (n.opacity != null && n.opacity < 1) attrs.push(`opacity="${n.opacity}"`);
  if (n.blend && n.blend !== 'normal') attrs.push(`style="mix-blend-mode:${n.blend}"`);
  const fdef = filterDef(n, pre + '-fx');
  if (fdef) {
    defs += fdef;
    attrs.push(`filter="url(#${pre}-fx)"`);
  }
  const paint = () => {
    defs += paintDef(n.fill, pre + '-f') + paintDef(n.stroke, pre + '-s');
    let s = `fill="${paintRef(n.fill, pre + '-f')}"`;
    if (n.stroke && n.sw) {
      s += ` stroke="${paintRef(n.stroke, pre + '-s')}" stroke-width="${n.sw}"`;
      if (n.cap && n.cap !== 'butt') s += ` stroke-linecap="${n.cap}"`;
      if (n.join && n.join !== 'miter') s += ` stroke-linejoin="${n.join}"`;
      if (n.dash?.length) s += ` stroke-dasharray="${n.dash.join(' ')}"`;
    }
    return s;
  };
  let body = '';
  if (n.type === 'group') {
    const kids = n.clip && n.children.length > 1 ? n.children.slice(0, -1) : n.children;
    body = kids.map((c) => nodeSvg(c, o)).join('');
    if (n.clip && n.children.length > 1) {
      const mask = n.children[n.children.length - 1];
      defs += `<clipPath id="${pre}-clip"><path d="${G.toD(outline(mask))}"${mask.fillRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`;
      body = `<g clip-path="url(#${pre}-clip)">${body}</g>`;
      // The mask's own stroke (if it has one) shows on top, like Illustrator.
      if (mask.stroke && mask.sw) body += nodeSvg({ ...mask, fill: null, effects: null }, { ...o, canvas: false });
    }
    return `<g ${attrs.join(' ')}>${defs ? `<defs>${defs}</defs>` : ''}${body}</g>`;
  }
  const hitW = o.hit || 6;
  if (n.type === 'path') {
    const d = G.toD(outline(n));
    const mk = n.stroke && n.sw ? markerDefs(n, pre + '-m') : { defs: '', attrs: '' };
    defs += mk.defs;
    body = `<path d="${d}" ${paint()}${n.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${mk.attrs}/>`;
    if (o.canvas) body += `<path d="${d}" fill="none" stroke="transparent" stroke-width="${hitW}" class="gx-hit"/>`;
  } else if (SHAPES.includes(n.type)) {
    const d = G.toD(G.shapeLocal(n));
    const t = G.frameMatrix(n);
    body = `<path d="${d}" transform="${mstr(t)}" ${paint()}/>`;
    if (o.canvas) body += `<path d="${d}" transform="${mstr(t)}" fill="none" stroke="transparent" stroke-width="${hitW}" class="gx-hit"/>`;
  } else if (n.type === 'image') {
    const src = String(n.src || '').startsWith('asset:') ? o.assets?.[n.src.slice(6)] || '' : n.src;
    body = `<image href="${esc(src)}" width="${n.w}" height="${n.h}" preserveAspectRatio="none" transform="${mstr(G.frameMatrix(n))}"/>`;
    if (n.stroke && n.sw) body += `<rect width="${n.w}" height="${n.h}" transform="${mstr(G.frameMatrix(n))}" ${paint().replace(/fill="[^"]*"/, 'fill="none"')}/>`;
  } else if (n.type === 'text') {
    const b = textBox(n);
    const f = n.font;
    const asc = f.size * 0.8 + (b.lh - f.size) / 2 + f.size * 0.1;
    const ax = f.align === 'center' ? b.w / 2 : f.align === 'right' ? b.w : 0;
    const anchor = f.align === 'center' ? 'middle' : f.align === 'right' ? 'end' : 'start';
    const tspans = b.lines.map((l, i) => `<tspan x="${G.r2(ax)}" y="${G.r2(asc + i * b.lh)}">${esc(l) || ' '}</tspan>`).join('');
    const deco = f.deco === 'underline' ? ';text-decoration:underline' : f.deco === 'strike' ? ';text-decoration:line-through' : '';
    const style = `font-family:${esc(quoteFamily(f.family))};font-size:${f.size}px;font-weight:${f.weight || 400}${f.italic ? ';font-style:italic' : ''}${f.ls ? `;letter-spacing:${f.ls}px` : ''}${deco};white-space:pre`;
    body = `<text transform="${mstr(G.frameMatrix(boxOf(n)))}" text-anchor="${anchor}" style="${style}" ${paint()}>${tspans}</text>`;
    if (o.canvas) body += `<rect width="${b.w}" height="${b.h}" transform="${mstr(G.frameMatrix(boxOf(n)))}" fill="transparent" class="gx-hit"/>`;
  }
  return `<g ${attrs.join(' ')}>${defs ? `<defs>${defs}</defs>` : ''}${body}</g>`;
}

/** The whole picture or one artboard as a standalone SVG file. */
export function exportSvg(doc, { artboard = null, assets = {}, scale = 1, background = true } = {}) {
  let box;
  if (artboard) box = { x1: artboard.x, y1: artboard.y, x2: artboard.x + artboard.w, y2: artboard.y + artboard.h };
  else {
    box = boundsOf(doc.nodes.filter((n) => !n.hidden));
    if (G.isEmpty(box)) box = { x1: 0, y1: 0, x2: 100, y2: 100 };
  }
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const nodes = artboard ? doc.nodes.filter((n) => !n.hidden && G.overlaps(bounds(n), box)) : doc.nodes;
  const bg = background && artboard?.bg ? `<rect x="${box.x1}" y="${box.y1}" width="${w}" height="${h}" fill="${esc(artboard.bg)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${G.r2(w * scale)}" height="${G.r2(h * scale)}" viewBox="${G.r2(box.x1)} ${G.r2(box.y1)} ${G.r2(w)} ${G.r2(h)}">${bg}${nodes.map((n) => nodeSvg(n, { assets, prefix: 'x' })).join('')}</svg>`;
}

/* ---------------- reading SVG files ---------------- */

const num = (v, d = 0) => (v == null || v === '' ? d : parseFloat(v) || 0);
function parseTransform(s) {
  let m = G.I();
  for (const [, fn, args] of String(s || '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let t = G.I();
    if (fn === 'matrix') t = a.slice(0, 6);
    if (fn === 'translate') t = G.translate(a[0] || 0, a[1] || 0);
    if (fn === 'scale') t = G.scaleAt(a[0], a[1] ?? a[0]);
    if (fn === 'rotate') t = G.rotateAt(a[0] || 0, a[1] || 0, a[2] || 0);
    if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0];
    if (fn === 'skewY') t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = G.mul(m, t);
  }
  return m;
}

/**
 * An SVG file → objects (a group when there's more than one). Paths, basic shapes, text, images, groups; solid colors,
 * gradients (by their first and last stops), strokes, opacity. Computed styles come from a hidden copy in the page, so
 * CSS classes in the file work too.
 */
export function importSvg(markup) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = parsed.querySelector('svg');
  if (!svg || parsed.querySelector('parsererror')) throw new Error('That isn’t an SVG file');
  svg.querySelectorAll('script, foreignObject').forEach((e) => e.remove());
  const live = document.importNode(svg, true);
  host.append(live);
  document.body.append(host);
  try {
    const vb = (live.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    let root = G.I();
    const W = num(live.getAttribute('width'), vb[2] || 0);
    const H = num(live.getAttribute('height'), vb[3] || 0);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) root = G.mul(G.scaleAt(W ? W / vb[2] : 1, H ? H / vb[3] : 1), G.translate(-vb[0], -vb[1]));
    const paintOf = (el, prop, cs) => {
      const v = cs[prop];
      if (!v || v === 'none') return null;
      const m = /url\(["']?#([^"')]+)/.exec(v);
      if (m) {
        const g = live.querySelector('#' + CSS.escape(m[1]));
        const stops = [...(g?.querySelectorAll('stop') || [])].map((s) => {
          const scs = getComputedStyle(s);
          return { color: rgbToHex(scs.stopColor, num(scs.stopOpacity, 1)), pos: Math.min(1, Math.max(0, parseFloat(s.getAttribute('offset')) / (String(s.getAttribute('offset')).includes('%') ? 100 : 1) || 0)) };
        });
        if (!stops.length) return null;
        if (g.tagName === 'radialGradient') return { type: 'radial', stops };
        const x1 = num(g.getAttribute('x1'), 0);
        const y1 = num(g.getAttribute('y1'), 0);
        const x2 = num(g.getAttribute('x2'), 1);
        const y2 = num(g.getAttribute('y2'), 0);
        return { type: 'linear', angle: G.r2((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI), stops };
      }
      const op = num(prop === 'fill' ? cs.fillOpacity : cs.strokeOpacity, 1);
      return solid(rgbToHex(v, op));
    };
    const walkEl = (el, m) => {
      const out = [];
      for (const c of el.children) {
        const tag = c.tagName.toLowerCase();
        if (['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'symbol', 'pattern', 'filter', 'marker'].includes(tag)) continue;
        const cs = getComputedStyle(c);
        if (cs.display === 'none') continue;
        const mm = G.mul(m, parseTransform(c.getAttribute('transform')));
        const style = { opacity: num(cs.opacity, 1), fill: paintOf(c, 'fill', cs), stroke: paintOf(c, 'stroke', cs), sw: G.r2(num(cs.strokeWidth, 1) * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]))) };
        if (cs.strokeLinecap && cs.strokeLinecap !== 'butt') style.cap = cs.strokeLinecap;
        if (cs.strokeLinejoin && cs.strokeLinejoin !== 'miter') style.join = cs.strokeLinejoin;
        if (cs.strokeDasharray && cs.strokeDasharray !== 'none') style.dash = cs.strokeDasharray.split(/[\s,]+/).map(parseFloat).filter((x) => x >= 0);
        const name = c.getAttribute('id') || c.getAttribute('inkscape:label') || undefined;
        if (tag === 'g' || tag === 'svg' || tag === 'a') {
          const kids = walkEl(c, tag === 'svg' ? mm : mm);
          if (kids.length) out.push(makeNode('group', { name: name || 'Group', children: kids, opacity: style.opacity }));
          continue;
        }
        if (tag === 'use') {
          const ref = live.querySelector(c.getAttribute('href') || c.getAttribute('xlink:href') || '#none');
          if (ref) {
            const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            wrap.append(ref.cloneNode(true));
            c.after(wrap);
            out.push(...walkEl(wrap, G.mul(mm, G.translate(num(c.getAttribute('x')), num(c.getAttribute('y'))))));
            wrap.remove();
          }
          continue;
        }
        if (tag === 'text') {
          const b = c.getBBox?.() || { x: 0, y: 0 };
          const size = num(cs.fontSize, 16);
          const t = makeNode('text', { name, text: c.textContent.trim(), x: 0, y: 0, font: { family: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Inter', size, weight: num(cs.fontWeight, 400), italic: cs.fontStyle === 'italic' }, fill: style.fill, stroke: style.stroke, sw: style.sw, opacity: style.opacity });
          t.x = b.x;
          t.y = b.y;
          out.push(transform(t, mm));
          continue;
        }
        if (tag === 'image') {
          const href = c.getAttribute('href') || c.getAttribute('xlink:href');
          if (!href) continue;
          const img = makeNode('image', { name, src: href, x: num(c.getAttribute('x')), y: num(c.getAttribute('y')), w: num(c.getAttribute('width')), h: num(c.getAttribute('height')), opacity: style.opacity });
          out.push(transform(img, mm));
          continue;
        }
        let d = null;
        const at = (k) => num(c.getAttribute(k));
        if (tag === 'path') d = c.getAttribute('d');
        else if (tag === 'rect') {
          const x = at('x');
          const y = at('y');
          const w = at('width');
          const h = at('height');
          let rx = num(c.getAttribute('rx'), NaN);
          let ry = num(c.getAttribute('ry'), NaN);
          if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
          if (Number.isNaN(ry)) ry = rx;
          rx = Math.min(rx, w / 2);
          ry = Math.min(ry, h / 2);
          d = rx || ry ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z` : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
        } else if (tag === 'circle' || tag === 'ellipse') {
          const cx = at('cx');
          const cy = at('cy');
          const rx = tag === 'circle' ? at('r') : at('rx');
          const ry = tag === 'circle' ? at('r') : at('ry');
          d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
        } else if (tag === 'line') d = `M${at('x1')} ${at('y1')}L${at('x2')} ${at('y2')}`;
        else if (tag === 'polyline' || tag === 'polygon') d = 'M' + (c.getAttribute('points') || '').trim() + (tag === 'polygon' ? 'Z' : '');
        if (!d) continue;
        const subpaths = G.parseD(d);
        if (!subpaths.length) continue;
        G.transformPath(subpaths, mm);
        out.push(makeNode('path', { name, subpaths, fillRule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', ...style }));
      }
      return out;
    };
    return walkEl(live, root);
  } finally {
    host.remove();
  }
}

export function rgbToHex(c, alpha = 1) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(c || '');
  let hex;
  let a = alpha;
  if (m) {
    hex = '#' + [m[1], m[2], m[3]].map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('');
    if (m[4] != null) a *= m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
  } else if (/^#[0-9a-f]{6}$/i.test(c || '')) hex = c.toLowerCase();
  else if (/^#[0-9a-f]{3}$/i.test(c || '')) hex = '#' + [...c.slice(1)].map((x) => x + x).join('').toLowerCase();
  else hex = '#000000';
  return a >= 0.999 ? hex : hex + Math.round(a * 255).toString(16).padStart(2, '0');
}
