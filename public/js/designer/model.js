// Designer's document model: a Figma-like tree of layers that maps one-to-one onto HTML and CSS, so what you design is
// what gets built. Frames are boxes (with auto layout = flexbox), text is text, images and SVGs are what they say.
//
// A design: { id, name, nodes: [top-level frames…], assets: { id: dataURL }, fonts: [{ family, weight, style, asset }],
//   meta: { [frameId]: { notes, framework, source } }, view: { x, y, z } }
// A node: { id, type: 'frame'|'rect'|'ellipse'|'text'|'image'|'svg', name, x, y, w, h, sizing: { w, h }, … } (below)
// x / y are relative to the parent's top-left corner (the canvas for top-level frames), in CSS pixels.
// A state of a component ("Button / Hover") is a top-level frame with `variant: { of: baseId, state }`; its layers carry
// `link` (the base layer they correspond to), so the code generator turns the differences into :hover rules.
import { uid } from '../util.js';

export const TYPES = ['frame', 'rect', 'ellipse', 'text', 'image', 'svg'];
export const CONTAINERS = new Set(['frame']);
export const STATES = {
  hover: { label: 'Hover', sel: ':hover' },
  pressed: { label: 'Pressed', sel: ':active' },
  focus: { label: 'Focus', sel: ':focus-visible' },
  disabled: { label: 'Disabled', sel: ':disabled', alt: '[aria-disabled="true"]' },
  checked: { label: 'Checked', sel: '[aria-checked="true"]', alt: '.is-checked' },
  selected: { label: 'Selected', sel: '[aria-selected="true"]', alt: '.is-selected' },
  open: { label: 'Open', sel: '[aria-expanded="true"]', alt: '.is-open' },
  error: { label: 'Error', sel: '[aria-invalid="true"]', alt: '.is-error' },
};
export const FRAMEWORKS = {
  html: 'HTML + CSS',
  react: 'React (CSS module)',
  tailwind: 'React + Tailwind',
  vue: 'Vue',
  svelte: 'Svelte',
  webcomponent: 'Web component',
  leafdeck: 'Leafdeck app (ld- classes)',
};
export const TAGS = ['div', 'button', 'a', 'input', 'textarea', 'select', 'label', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'ul', 'ol', 'li', 'section', 'article', 'aside', 'header', 'footer', 'main', 'form', 'img', 'figure', 'figcaption', 'dialog', 'strong', 'em', 'small', 'code', 'summary', 'details'];

/* ---------------- colors ---------------- */

/** Any CSS color we store ('#rgb', '#rrggbb', '#rrggbbaa', 'rgb()', 'rgba()', 'transparent') → { hex: '#rrggbb', a: 0–1 }. */
export function parseColor(c) {
  const s = String(c || '').trim().toLowerCase();
  if (!s || s === 'transparent') return { hex: '#000000', a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return { hex: '#' + h.slice(0, 6), a: Math.round(a * 100) / 100 };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map((x) => Math.round(Math.min(255, +x)).toString(16).padStart(2, '0')).join('');
    let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    return { hex, a: Math.round(a * 100) / 100 };
  }
  return { hex: '#000000', a: 1, raw: s }; // a named color or color-mix(): kept as written
}
export function formatColor(hex, a = 1) {
  if (a >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 100) / 100})`;
}
export const isVisibleColor = (c) => !!c && parseColor(c).a > 0;

/* ---------------- making nodes ---------------- */

const base = (type, o) => ({
  id: uid(),
  type,
  name: o.name || { frame: 'Frame', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text', image: 'Image', svg: 'Vector' }[type],
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  sizing: { w: 'fixed', h: 'fixed' },
  ...o,
});

export function makeNode(type, o = {}) {
  switch (type) {
    case 'frame':
      return base('frame', { fills: [{ type: 'solid', color: '#ffffff' }], children: [], layout: { mode: 'none' }, ...o });
    case 'rect':
      return base('rect', { fills: [{ type: 'solid', color: '#d9d9d9' }], ...o });
    case 'ellipse':
      return base('ellipse', { fills: [{ type: 'solid', color: '#d9d9d9' }], ...o });
    case 'text':
      return base('text', {
        text: 'Text',
        sizing: { w: 'hug', h: 'hug' },
        w: 40,
        h: 20,
        font: { family: 'Inter, system-ui, sans-serif', size: 14, weight: 400, lineHeight: 'auto', letterSpacing: 0, align: 'left', color: '#1d1f1e' },
        ...o,
      });
    case 'image':
      return base('image', { src: '', fit: 'cover', ...o });
    case 'svg':
      return base('svg', { markup: '', ...o });
  }
  throw new Error('Unknown layer type ' + type);
}

export const layoutOf = (n) => (n?.type === 'frame' && n.layout?.mode && n.layout.mode !== 'none' ? n.layout : null);

/* ---------------- tree helpers ---------------- */

export function* walk(nodes, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    yield { node: n, parent, index: i };
    if (n.children) yield* walk(n.children, n);
  }
}

/** id → { node, parent (node or null), index, depth, top (the top-level frame) } */
export function indexTree(nodes) {
  const map = new Map();
  const rec = (list, parent, depth, top) => {
    list.forEach((n, index) => {
      const t = top || n;
      map.set(n.id, { node: n, parent, index, depth, top: t });
      if (n.children) rec(n.children, n, depth + 1, t);
    });
  };
  rec(nodes, null, 0, null);
  return map;
}

/** A deep copy with fresh ids. `links`: remember the original id as `link` (for states). */
export function cloneNode(n, { links = false, keepLinks = false } = {}) {
  const c = structuredClone(n);
  const fix = (x, src) => {
    if (links) x.link = src.id;
    else if (!keepLinks) delete x.link;
    x.id = uid();
    x.children?.forEach((ch, i) => fix(ch, src.children[i]));
  };
  fix(c, n);
  delete c.variant;
  return c;
}

/** Asset ids a set of nodes uses ('asset:<id>' in src, fills or markup). */
export function assetsUsed(nodes) {
  const out = new Set();
  const scan = (s) => String(s || '').replace(/asset:([a-z0-9]+)/g, (_, id) => out.add(id));
  for (const { node } of walk(nodes)) {
    scan(node.src);
    node.fills?.forEach((f) => scan(f.src || f.value));
  }
  return out;
}

/* ---------------- CSS for a node ---------------- */

const px = (n) => `${Math.round((+n || 0) * 100) / 100}px`;
const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };
const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

/** An asset reference as a usable URL (data URL from the design's assets). */
export const resolveSrc = (src, assets) => String(src || '').replace(/^asset:([a-z0-9]+)$/, (_, id) => assets?.[id] || '');
const resolveCss = (v, assets) => String(v || '').replace(/asset:([a-z0-9]+)/g, (_, id) => assets?.[id] || '');

export function backgroundOf(fills, assets) {
  const vis = (fills || []).filter((f) => f.visible !== false);
  if (!vis.length) return {};
  const layers = [];
  let color = '';
  vis.forEach((f, i) => {
    const last = i === vis.length - 1;
    if (f.type === 'solid') {
      if (last) color = f.color;
      else layers.push(`linear-gradient(${f.color}, ${f.color})`);
    } else if (f.type === 'linear') {
      layers.push(`linear-gradient(${f.angle ?? 180}deg, ${(f.stops || []).map((s) => `${s.color} ${Math.round((s.pos ?? 0) * 100)}%`).join(', ')})`);
    } else if (f.type === 'radial') {
      layers.push(`radial-gradient(circle, ${(f.stops || []).map((s) => `${s.color} ${Math.round((s.pos ?? 0) * 100)}%`).join(', ')})`);
    } else if (f.type === 'image') {
      layers.push(`url("${resolveSrc(f.src, assets)}")`);
    } else if (f.type === 'css') layers.push(resolveCss(f.value, assets));
  });
  const out = {};
  if (color) out['background-color'] = color;
  if (layers.length) {
    out['background-image'] = layers.join(', ');
    const imgs = vis.filter((f) => f.type !== 'solid' || vis.indexOf(f) !== vis.length - 1);
    if (imgs.some((f) => f.type === 'image' || f.size || f.position || f.repeat)) {
      out['background-size'] = imgs.map((f) => (f.type === 'image' ? f.size || (f.fit === 'fill' ? '100% 100%' : f.fit || 'cover') : f.size || 'auto')).join(', ');
      out['background-position'] = imgs.map((f) => f.position || (f.type === 'image' ? 'center' : '0% 0%')).join(', ');
      out['background-repeat'] = imgs.map((f) => f.repeat || 'no-repeat').join(', ');
    }
  }
  return out;
}

export const shadowCss = (effects) =>
  (effects || [])
    .filter((e) => e.visible !== false && (e.type === 'drop' || e.type === 'inner'))
    .map((e) => `${e.type === 'inner' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread)} ${e.color}`)
    .join(', ');

const radiusCss = (r) => (Array.isArray(r) ? (r.every((x) => x === r[0]) ? px(r[0]) : r.map(px).join(' ')) : px(r));

/** Border widths (inside strokes take up room in the box, so absolute children shift by them). */
export const strokeInset = (n) => {
  const s = n.stroke;
  if (!s || s.visible === false || (s.align && s.align !== 'inside')) return [0, 0, 0, 0];
  return s.sides || [s.width, s.width, s.width, s.width];
};

/**
 * CSS declarations for a node, as { prop: value }. `parent` is the parent node (null for a top-level frame);
 * `mode`: 'canvas' (absolute positions on the canvas) or 'export' (top-level frame without a position).
 */
export function nodeCss(n, parent, { mode = 'canvas', assets } = {}) {
  const c = {};
  const pl = layoutOf(parent);
  const inFlow = pl && !n.absolute;
  // Position
  if (!parent) {
    if (mode === 'canvas') Object.assign(c, { position: 'absolute', left: px(n.x), top: px(n.y) });
    else c.position = 'relative';
  } else if (!inFlow) {
    const [bt, , , bl] = strokeInset(parent);
    Object.assign(c, { position: 'absolute', left: px(n.x - bl), top: px(n.y - bt) });
  } else c.position = 'relative';
  if (n.type === 'frame' && n.layout?.mode === 'none' && c.position !== 'absolute') c.position = 'relative';

  // Size: fixed, hug (fit the content) or fill (take the rest of the parent's auto layout).
  const sz = n.sizing || {};
  const row = pl?.mode === 'row';
  for (const axis of ['w', 'h']) {
    const prop = axis === 'w' ? 'width' : 'height';
    const mode2 = sz[axis] || 'fixed';
    const main = inFlow && (axis === 'w') === row;
    if (mode2 === 'fill' && inFlow) {
      if (main) {
        c.flex = '1 1 0';
        c['min-' + prop] = '0';
      } else c['align-self'] = 'stretch';
    } else if (mode2 === 'hug') {
      if (!inFlow && (n.type === 'frame' || n.type === 'text') && axis === 'w') c[prop] = 'max-content';
    } else c[prop] = px(n[axis]);
  }
  if (inFlow && !(c.flex)) c['flex-shrink'] = '0';
  if (n.minW) c['min-width'] = px(n.minW);
  if (n.maxW) c['max-width'] = px(n.maxW);

  // Auto layout
  const L = layoutOf(n);
  if (L) {
    c.display = 'flex';
    c['flex-direction'] = L.mode === 'column' ? 'column' : 'row';
    if (L.wrap) c['flex-wrap'] = 'wrap';
    if (L.gap) c.gap = L.wrap && L.rowGap != null ? `${px(L.rowGap)} ${px(L.gap)}` : px(L.gap);
    const p = L.padding || [0, 0, 0, 0];
    if (p.some(Boolean)) c.padding = p[0] === p[2] && p[1] === p[3] ? (p[0] === p[1] ? px(p[0]) : `${px(p[0])} ${px(p[1])}`) : p.map(px).join(' ');
    c['justify-content'] = JUSTIFY[L.justify || 'start'];
    c['align-items'] = ALIGN[L.align || 'start'];
  }
  if (n.type === 'frame' && (n.clip || n.type === 'image')) c.overflow = 'hidden';
  if (n.type === 'image') c.overflow = 'hidden';

  // Fill, stroke, corners, effects
  if (n.type !== 'text' && n.type !== 'svg') Object.assign(c, backgroundOf(n.fills, assets));
  if (n.type === 'svg' && n.fills?.length) Object.assign(c, backgroundOf(n.fills, assets));
  const s = n.stroke;
  if (s && s.visible !== false && (s.width || s.sides)) {
    const style = s.style || 'solid';
    if (!s.align || s.align === 'inside') {
      if (s.sides) {
        const names = ['top', 'right', 'bottom', 'left'];
        s.sides.forEach((w, i) => w && (c[`border-${names[i]}`] = `${px(w)} ${style} ${s.color}`));
      } else c.border = `${px(s.width)} ${style} ${s.color}`;
    } else {
      c.outline = `${px(s.width)} ${style} ${s.color}`;
      c['outline-offset'] = s.align === 'center' ? px(-s.width / 2) : '0px';
    }
  }
  if (n.type === 'ellipse') c['border-radius'] = '50%';
  else if (n.radius && (Array.isArray(n.radius) ? n.radius.some(Boolean) : n.radius)) c['border-radius'] = radiusCss(n.radius);
  const sh = shadowCss(n.effects);
  if (sh) c['box-shadow'] = sh;
  const blur = (n.effects || []).find((e) => e.type === 'blur' && e.visible !== false);
  const bgBlur = (n.effects || []).find((e) => e.type === 'bg-blur' && e.visible !== false);
  if (blur) c.filter = `blur(${px(blur.radius)})`;
  if (bgBlur) c['backdrop-filter'] = `blur(${px(bgBlur.radius)})`;
  if (n.opacity != null && n.opacity < 1) c.opacity = String(Math.round(n.opacity * 1000) / 1000);
  if (n.blend && n.blend !== 'normal') c['mix-blend-mode'] = n.blend;

  // Text (a fill on text paints the letters: a gradient, an image)
  if (n.type === 'text') Object.assign(c, fontCss(n.font));
  if (n.type === 'text' && (n.fills || []).some((f) => f.visible !== false)) {
    Object.assign(c, backgroundOf(n.fills, assets), { '-webkit-background-clip': 'text', 'background-clip': 'text', '-webkit-text-fill-color': 'transparent' });
  }
  if (n.type === 'text') {
    c['white-space'] = sz.w === 'hug' ? 'pre' : 'pre-wrap';
    if (n.truncate) Object.assign(c, { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  }
  if (n.type === 'svg' && n.color) c.color = n.color;
  if (n.type === 'image' && n.fit) c['object-fit'] = n.fit;

  // Anything captured that the inspector has no control for (cursor, transform, outline offset…).
  if (n.css) for (const [k, v] of Object.entries(n.css)) if (v !== '' && v != null) c[k] = v;
  if (n.box === 'content') c['box-sizing'] = 'content-box';
  return c;
}

export function fontCss(f = {}) {
  const c = {};
  if (f.family) c['font-family'] = f.family;
  if (f.size) c['font-size'] = px(f.size);
  if (f.weight && +f.weight !== 400) c['font-weight'] = String(f.weight);
  if (f.italic) c['font-style'] = 'italic';
  if (f.lineHeight && f.lineHeight !== 'auto') c['line-height'] = typeof f.lineHeight === 'number' ? px(f.lineHeight) : f.lineHeight;
  if (f.letterSpacing) c['letter-spacing'] = px(f.letterSpacing);
  if (f.align && f.align !== 'left') c['text-align'] = f.align;
  if (f.transform && f.transform !== 'none') c['text-transform'] = f.transform;
  if (f.decoration && f.decoration !== 'none') c['text-decoration'] = f.decoration;
  if (f.color) c.color = f.color;
  return c;
}

export const cssText = (decl) =>
  Object.entries(decl)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');

/* ---------------- naming ---------------- */

export const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'layer';

/** Class names for a component's layers: the root's slug, then root__child (BEM), unique. */
export function classNames(root) {
  const names = new Map();
  const used = new Set();
  const rootName = slug(root.name.split('/')[0]);
  const take = (want) => {
    let n = want;
    for (let i = 2; used.has(n); i++) n = `${want}-${i}`;
    used.add(n);
    return n;
  };
  names.set(root.id, take(rootName));
  for (const { node } of walk(root.children || [])) names.set(node.id, take(`${rootName}__${slug(node.type === 'text' ? (node.name || 'text').slice(0, 20) : node.name)}`));
  return names;
}

/* ---------------- code generation ---------------- */

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const VOID = new Set(['input', 'img']);

/** First text inside a node (an input's placeholder, a button's label). */
const firstText = (n) => {
  for (const { node } of walk([n])) if (node.type === 'text') return node;
  return null;
};

/** States of a component: the top-level frames that are variants of it. */
export const statesOf = (doc, root) => doc.nodes.filter((f) => f.variant?.of === root.id);

/**
 * HTML and CSS for one component (a top-level frame) and its states. Images become files referenced as
 * assets/<id>.<ext> when `assetPath` is given, or stay inline data URLs.
 */
export function exportComponent(doc, root, { assetPath = null } = {}) {
  const names = classNames(root);
  const assets = assetPath ? Object.fromEntries(Object.keys(doc.assets || {}).map((id) => [id, assetPath(id)])) : doc.assets;
  const rules = [];
  const hasStates = statesOf(doc, root).length > 0;
  /** A layer's CSS for the code: its own, plus what the HTML element it becomes needs. null = no rule (merged). */
  const declFor = (n, parent) => {
    if (n.type === 'text' && /^(input|textarea)$/.test(parent?.tag || '')) return null; // the field's own text
    let d = nodeCss(n, parent, { mode: 'export', assets });
    if (!parent) d.position = 'relative';
    if (n.hidden) d.display = 'none';
    if (/^(input|textarea)$/.test(n.tag || '')) {
      const t = firstText(n);
      if (t) Object.assign(d, fontCss(t.font), { outline: d.outline || 'none' });
      if (t?.role === 'placeholder') d['--placeholder'] = t.font?.color;
    }
    if (/^(button|a|input|textarea|select)$/.test(n.tag || '') && !n.css?.cursor) d.cursor = n.tag === 'input' || n.tag === 'textarea' ? 'text' : 'pointer';
    // Form elements start with the browser's own look: reset what the design doesn't set.
    if (/^(button|input|textarea|select)$/.test(n.tag || '')) {
      if (!d.border && !Object.keys(d).some((k) => k.startsWith('border-') && !k.startsWith('border-radius'))) d.border = '0';
      if (!d['background-color'] && !d['background-image']) d['background-color'] = 'transparent';
      d.appearance = 'none';
      d.margin = '0';
      if (n.tag === 'button') d.font = d.font || 'inherit';
    }
    return d;
  };
  const decls = new Map();
  const baseIdx = indexTree([root]);
  for (const { node } of walk([root])) {
    const d = declFor(node, baseIdx.get(node.id)?.parent || null);
    if (!d) continue;
    if (node === root && hasStates) d.transition = 'background-color 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s, opacity 0.15s, transform 0.15s';
    decls.set(node.id, d);
    const sel = '.' + names.get(node.id);
    const { '--placeholder': ph, ...rest } = d;
    rules.push(`${sel} {\n${Object.entries(rest).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`);
    if (ph) rules.push(`${sel}::placeholder {\n  color: ${ph};\n}`);
  }
  // States: what's different from the default, under the state's selector on the root.
  for (const v of statesOf(doc, root)) {
    const rootSel = '.' + names.get(root.id);
    const sels = stateSelectors(root, v.variant.state).map((s) => rootSel + s);
    const vIdx = indexTree([v]);
    const seen = new Set();
    for (const { node } of walk([v])) {
      const baseId = node === v ? root.id : node.link;
      if (!baseId || !decls.has(baseId)) continue;
      seen.add(baseId);
      const d = declFor(node, vIdx.get(node.id)?.parent || null);
      if (!d) continue;
      const b = decls.get(baseId);
      const diff = {};
      // Sizes only count when both are set by hand (a state that hugs while the default was resized isn't a change).
      const sized = (k) => /^(width|height)$/.test(k) && !(/px$/.test(b[k] || '') && /px$/.test(d[k] || ''));
      for (const [k, x] of Object.entries(d)) if (b[k] !== x && !(node === v && (k === 'left' || k === 'top')) && !sized(k) && !k.startsWith('--')) diff[k] = x;
      for (const k of Object.keys(b)) if (!(k in d) && !k.startsWith('--') && !/^(cursor|font|margin|left|top|outline|transition|width|height|flex|flex-shrink|min-width|align-self)$/.test(k)) diff[k] = INITIAL[k] || 'initial';
      if (d['--placeholder'] && d['--placeholder'] !== b['--placeholder']) rules.push(`${sels.map((s) => `${s} .${names.get(baseId)}::placeholder`).join(',\n')} {\n  color: ${d['--placeholder']};\n}`);
      if (Object.keys(diff).length) {
        const desc = baseId === root.id ? '' : ' .' + names.get(baseId);
        rules.push(`${sels.map((s) => s + desc).join(',\n')} {\n${Object.entries(diff).map(([k, x]) => `  ${k}: ${x};`).join('\n')}\n}`);
      }
    }
    for (const id of decls.keys()) if (!seen.has(id) && id !== root.id && v.children?.length) {
      // A layer the state doesn't have: hidden in that state.
      rules.push(`${sels.map((s) => `${s} .${names.get(id)}`).join(',\n')} {\n  display: none;\n}`);
    }
  }

  const html = markup(root, names, assets, 0);
  const fonts = fontFaces(doc, root, assetPath);
  return { html, css: (fonts ? fonts + '\n\n' : '') + rules.join('\n\n'), names };
}

const FOCUSABLE_TAGS = /^(button|a|input|textarea|select|summary)$/;
/**
 * The CSS selectors (after the root's class) for a state. Focus on something that can't take focus itself (a label
 * around an input) is :focus-within; :disabled only exists on form elements.
 */
export function stateSelectors(root, state) {
  const st = STATES[state];
  if (!st) return [`.is-${slug(state)}`];
  const focusable = FOCUSABLE_TAGS.test(root.tag || '') || root.attrs?.tabindex != null;
  if (state === 'focus') return [focusable ? ':focus-visible' : ':focus-within'];
  if (state === 'disabled') return /^(button|input|textarea|select)$/.test(root.tag || '') ? [':disabled', '[aria-disabled="true"]'] : ['[aria-disabled="true"]', '.is-disabled'];
  return [st.sel, st.alt].filter(Boolean);
}

const INITIAL = { display: 'block', 'background-color': 'transparent', 'background-image': 'none', 'box-shadow': 'none', border: '0', opacity: '1', filter: 'none', 'text-decoration': 'none', color: 'inherit', 'border-radius': '0' };

function markup(n, names, assets, depth) {
  const pad = '  '.repeat(depth);
  const cls = names.get(n.id);
  const attrs = { class: cls, ...(n.attrs || {}) };
  if (n.hidden) return '';
  let tag = n.tag || (n.type === 'text' ? 'span' : n.type === 'image' ? 'img' : 'div');
  if (n.type === 'image') {
    tag = 'img';
    attrs.src = resolveSrc(n.src, assets);
    attrs.alt = n.attrs?.alt ?? '';
  }
  if (tag === 'input' || tag === 'textarea') {
    const t = firstText(n);
    if (t) attrs[t.role === 'value' ? 'value' : 'placeholder'] = t.text;
    if (tag === 'input' && !attrs.type) attrs.type = 'text';
  }
  if (tag === 'button' && !attrs.type) attrs.type = 'button';
  const a = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${escHtml(String(v).slice(0, 300))}"`))
    .join(' ');
  const open = `${pad}<${tag} ${a}>`;
  if (VOID.has(tag)) return open.replace(/>$/, ' />');
  if (tag === 'textarea') {
    const t = firstText(n);
    return `${open}${t?.role === 'value' ? escHtml(t.text) : ''}</textarea>`;
  }
  if (n.type === 'text') {
    const body = n.runs?.length ? n.runs.map((r) => (Object.keys(r.style || {}).length ? `<span style="${escHtml(cssText(r.style))}">${escHtml(r.text)}</span>` : escHtml(r.text))).join('') : escHtml(n.text);
    return `${open}${body}</${tag}>`;
  }
  if (n.type === 'svg') return `${open}\n${pad}  ${String(n.markup || '').replace(/\n\s*/g, ' ')}\n${pad}</${tag}>`;
  const kids = (n.children || []).map((c) => markup(c, names, assets, depth + 1)).filter(Boolean);
  return kids.length ? `${open}\n${kids.join('\n')}\n${pad}</${tag}>` : `${open}</${tag}>`;
}

/** @font-face rules for the captured fonts the component uses. */
function fontFaces(doc, root, assetPath) {
  if (!doc.fonts?.length) return '';
  const families = new Set();
  for (const { node } of walk([root])) if (node.font?.family) node.font.family.split(',').forEach((f) => families.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase()));
  return doc.fonts
    .filter((f) => families.has(f.family.toLowerCase()) && doc.assets?.[f.asset])
    .map((f) => `@font-face {\n  font-family: "${f.family}";\n  src: url("${assetPath ? assetPath(f.asset) : doc.assets[f.asset]}");\n  font-weight: ${f.weight || 'normal'};\n  font-style: ${f.style || 'normal'};\n  font-display: swap;\n}`)
    .join('\n\n');
}

/** A standalone page showing the component and each of its states (for the live preview and the hand-off). */
export function previewPage(doc, root, opts = {}) {
  const { html, css } = exportComponent(doc, root, opts);
  const states = statesOf(doc, root);
  // On the background it was captured on, if it came from a page; a light gray otherwise.
  const base = root.variant ? doc.nodes.find((n) => n.id === root.variant.of) : root;
  const bg = opts.background || doc.meta?.[base?.id]?.source?.backdrop || '#f4f5f7';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(root.name)}</title>
<style>
html, body { margin: 0; min-height: 100%; }
body { display: grid; place-items: center; min-height: 100vh; background: ${bg}; font-family: system-ui, sans-serif; }
.stage { padding: 48px; }
${opts.inspect ? '.stage [class] { outline: 1px dashed rgba(10, 132, 255, 0.35); outline-offset: -1px; }' : ''}
${css}
</style>
</head>
<body>
<div class="stage">
${html}
</div>
${states.length && opts.legend !== false ? `<!-- States: ${states.map((s) => s.variant.state).join(', ')} -->` : ''}
</body>
</html>`;
}

export function luminance(c) {
  const { hex } = parseColor(c);
  const v = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ---------------- the spec (for people and for AI) ---------------- */

/** Colors, type styles, radii and shadows a component uses, most used first. */
export function tokensOf(root) {
  const colors = new Map();
  const type = new Map();
  const radii = new Map();
  const shadows = new Map();
  const bump = (m, k, extra) => k && m.set(k, { n: (m.get(k)?.n || 0) + 1, ...extra });
  for (const { node } of walk([root])) {
    if (node.hidden) continue;
    node.fills?.forEach((f) => f.visible !== false && f.type === 'solid' && bump(colors, f.color, { use: 'fill' }));
    if (node.stroke && node.stroke.visible !== false) bump(colors, node.stroke.color, { use: 'stroke' });
    if (node.font) {
      bump(colors, node.font.color, { use: 'text' });
      const f = node.font;
      bump(type, `${f.family.split(',')[0].replace(/["']/g, '')} ${f.weight || 400} ${f.size}px${f.lineHeight && f.lineHeight !== 'auto' ? '/' + (typeof f.lineHeight === 'number' ? f.lineHeight + 'px' : f.lineHeight) : ''}${f.letterSpacing ? ` ${f.letterSpacing}px tracking` : ''}`);
    }
    if (node.radius) bump(radii, Array.isArray(node.radius) ? node.radius.join(' ') : String(node.radius));
    const sh = shadowCss(node.effects);
    if (sh) bump(shadows, sh);
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  return { colors: sorted(colors), type: sorted(type), radii: sorted(radii), shadows: sorted(shadows) };
}

/** An indented outline of the layers, with the facts a builder needs. */
export function outline(root) {
  const lines = [];
  const rec = (n, depth, parent) => {
    const bits = [];
    const L = layoutOf(n);
    const sz = n.sizing || {};
    bits.push(`${sz.w === 'hug' ? 'hug' : sz.w === 'fill' ? 'fill' : Math.round(n.w)}×${sz.h === 'hug' ? 'hug' : sz.h === 'fill' ? 'fill' : Math.round(n.h)}`);
    if (L) bits.push(`auto layout ${L.mode}${L.wrap ? ' wrap' : ''}, gap ${L.gap || 0}, padding ${(L.padding || [0, 0, 0, 0]).join('/')}, align ${L.align || 'start'}, justify ${L.justify || 'start'}`);
    else if (parent && !layoutOf(parent)) bits.push(`at ${Math.round(n.x)},${Math.round(n.y)}`);
    const fill = (n.fills || []).filter((f) => f.visible !== false).map((f) => (f.type === 'solid' ? f.color : f.type)).join(' + ');
    if (fill && n.type !== 'text') bits.push(`fill ${fill}`);
    if (n.stroke && n.stroke.visible !== false) bits.push(`stroke ${n.stroke.sides ? n.stroke.sides.join('/') : n.stroke.width}px ${n.stroke.color}`);
    if (n.radius) bits.push(`radius ${Array.isArray(n.radius) ? n.radius.join('/') : n.radius}`);
    if (shadowCss(n.effects)) bits.push(`shadow ${shadowCss(n.effects)}`);
    if (n.opacity != null && n.opacity < 1) bits.push(`opacity ${n.opacity}`);
    if (n.font) bits.push(`${n.font.size}px/${n.font.weight || 400} ${n.font.color}${n.font.align && n.font.align !== 'left' ? ' ' + n.font.align : ''}`);
    if (n.icon) bits.push(`icon "${n.icon.name}" from ${ICON_SETS[n.icon.set] || n.icon.set}, color ${n.color || 'currentColor'}`);
    const label = n.type === 'text' ? `"${n.text.slice(0, 60).replace(/\n/g, ' ')}"` : n.name;
    const tag = n.tag && n.tag !== 'div' ? ` <${n.tag}>` : '';
    lines.push(`${'  '.repeat(depth)}- ${n.type === 'text' ? 'Text' : n.type[0].toUpperCase() + n.type.slice(1)}${tag} ${label}${n.hidden ? ' (hidden)' : ''}: ${bits.join('; ')}`);
    n.children?.forEach((c) => rec(c, depth + 1, n));
  };
  rec(root, 0, null);
  return lines.join('\n');
}

const ICON_SETS = { lucide: 'Lucide', tabler: 'Tabler Icons (outline)', 'tabler-filled': 'Tabler Icons (filled)' };

/** The user's markup (marks drawn over the design), in words, in px from `origin` (the component's top-left). */
export function describeMarks(marks, origin = { x: 0, y: 0 }) {
  const pt = (p) => `(${Math.round(p[0] - origin.x)}, ${Math.round(p[1] - origin.y)})`;
  return marks.map((m) => {
    const [a, b] = [m.pts[0], m.pts[m.pts.length - 1]];
    if (m.kind === 'note') return `- Note at ${pt(a)}: “${m.text}”`;
    if (m.kind === 'arrow') return `- Arrow from ${pt(a)} pointing to ${pt(b)}`;
    if (m.kind === 'line') return `- Line from ${pt(a)} to ${pt(b)}`;
    if (m.kind === 'box') return `- Box around ${pt([Math.min(a[0], b[0]), Math.min(a[1], b[1])])}, ${Math.round(Math.abs(b[0] - a[0]))}×${Math.round(Math.abs(b[1] - a[1]))}`;
    const xs = m.pts.map((p) => p[0]);
    const ys = m.pts.map((p) => p[1]);
    const box = [Math.min(...xs), Math.min(...ys)];
    return `- Freehand stroke from ${pt(a)} to ${pt(b)}, over ${pt(box)}, ${Math.round(Math.max(...xs) - box[0])}×${Math.round(Math.max(...ys) - box[1])}`;
  }).join('\n');
}

/** The hand-off: everything an AI (or a person) needs to build the component, as Markdown. */
export function handoffMarkdown(doc, root, { framework = 'html', notes = '', code, files = false, marks = [] } = {}) {
  const meta = doc.meta?.[root.id] || {};
  const states = statesOf(doc, root);
  const t = tokensOf(root);
  const { html, css } = code || exportComponent(doc, root);
  const src = meta.source;
  const fw = FRAMEWORKS[framework] || framework;
  const out = [];
  out.push(`# Build this UI element: ${root.name}`);
  out.push('');
  out.push(`Build the component below as **${fw}**. It was designed in Leafdeck Designer; match the design exactly (sizes, spacing, colors, type), then bring it to life: real interaction, every state listed, keyboard and screen-reader support.`);
  if (notes || meta.notes) out.push('', '## What it should do', '', (notes || meta.notes).trim());
  if (marks.length) {
    out.push('', '## The user’s markup', '', `The user drew on the canvas to show what they want${files ? ' (see `handoff/markup.png`: the design with the markup on it)' : ''}. The markup isn’t part of the design: read it as instructions (notes say what to do, arrows and boxes point at what they mean, freehand strokes sketch shapes or circle things). In px from the component’s top-left corner:`, '', describeMarks(marks, root));
  }
  out.push('', '## Spec', '');
  out.push(`- Size: ${(root.sizing?.w === 'hug' ? 'fits its content' : Math.round(root.w) + 'px wide')} × ${root.sizing?.h === 'hug' ? 'fits its content' : Math.round(root.h) + 'px tall'}`);
  out.push(`- Element: \`<${root.tag || 'div'}>\``);
  if (states.length) out.push(`- States: default, ${states.map((s) => (STATES[s.variant.state]?.label || s.variant.state).toLowerCase()).join(', ')} (designed as separate frames; the CSS below has them as ${states.map((s) => '`' + (STATES[s.variant.state]?.sel || '.is-' + s.variant.state) + '`').join(', ')})`);
  else out.push('- States: only the default was designed. Add sensible hover, focus-visible, pressed and disabled states in the same style.');
  if (t.colors.length) out.push(`- Colors: ${t.colors.slice(0, 12).map(([c, v]) => `\`${c}\` (${v.use})`).join(', ')}`);
  if (t.type.length) out.push(`- Type: ${t.type.slice(0, 6).map(([k]) => `\`${k}\``).join(', ')}`);
  if (t.radii.length) out.push(`- Corner radius: ${t.radii.map(([k]) => k + 'px').join(', ')}`);
  if (t.shadows.length) out.push(`- Shadows: ${t.shadows.map(([k]) => '`' + k + '`').join(', ')}`);
  const fams = [...new Set(doc.fonts?.map((f) => f.family) || [])];
  if (fams.length) out.push(`- Fonts captured with the design: ${fams.join(', ')}${files ? ' (files in assets/)' : ''}`);
  if (src?.url) out.push(`- Captured from: ${src.url}${src.title ? ` (“${src.title}”)` : ''}`);
  out.push('', '## Layers', '', '```', outline(root), ...states.map((s) => '\n' + outline(s)), '```');
  out.push('', '## Reference HTML and CSS', '', 'Generated from the design. It renders exactly like the design: use it as the visual truth, and restructure it as the framework needs.', '');
  out.push('```html', html, '```', '', '```css', css.length > 60000 ? css.slice(0, 60000) + '\n/* … */' : css, '```');
  if (src?.html) out.push('', '## The original markup', '', `The element as it was on ${src.url || 'the page'} (structure, class names and ARIA; styles came from the page's stylesheets).`, '', '```html', src.html.slice(0, 12000), '```');
  if (files) out.push('', '## Files', '', '- `handoff/preview.png`: how it looks', ...(marks.length ? ['- `handoff/markup.png`: the design with the user’s markup on it'] : []), '- `handoff/component.html` + `handoff/styles.css`: the reference above', '- `design.json`: the design itself (see DESIGN.md)');
  out.push('', '## Requirements', '', '- Use semantic elements and the right ARIA roles; everything works with the keyboard; focus is visible.', '- Keep the exact visual design. Don’t add margins or decoration that isn’t in the design.', '- Keep it self-contained: no new dependencies unless the target needs them.');
  return out.join('\n');
}
