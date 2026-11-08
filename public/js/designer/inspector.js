// Designer's Design panel (right side): the selected layers' properties, Figma's sections in Figma's order.
// Number fields take math ("120+16") and arrow keys, and their labels scrub: drag one sideways to change the value.
import { esc } from '../util.js';
import { pickColor } from '../colorpicker.js';
import { glyph } from './glyphs.js';
import { parseColor, formatColor, layoutOf, nodeCss, TAGS, resolveSrc, tokensOf } from './model.js';

const MIXED = Symbol('mixed');
const FONTS = ['Inter', 'system-ui', 'SF Pro Text', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'Georgia', 'Times New Roman', 'Menlo', 'JetBrains Mono', 'Courier New'];
const WEIGHTS = [[100, 'Thin'], [200, 'Extra Light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']];
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'difference', 'exclusion', 'luminosity'];
const round = (v) => Math.round(v * 100) / 100;

/** "120+16" → 136: numbers with + - * / and parentheses (a small parser; the page's CSP rightly forbids eval). */
export function evalNum(s) {
  const src = String(s).trim().replace(/,/g, '.').replace(/px$/i, '').replace(/%$/, '');
  if (!src || !/^[\d.+\-*/() ]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === ' ') i++;
  };
  const num = () => {
    skip();
    if (peek() === '(') {
      i++;
      const v = sum();
      skip();
      if (src[i++] !== ')') throw new Error();
      return v;
    }
    if (peek() === '-') return i++, -num();
    if (peek() === '+') return i++, num();
    const m = /^\d*\.?\d+|^\d+\.?/.exec(src.slice(i));
    if (!m) throw new Error();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const product = () => {
    let v = num();
    for (skip(); peek() === '*' || peek() === '/'; skip()) v = src[i++] === '*' ? v * num() : v / num();
    return v;
  };
  const sum = () => {
    let v = product();
    for (skip(); peek() === '+' || peek() === '-'; skip()) v = src[i++] === '+' ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    skip();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function createInspector(panel, ed, opts = {}) {
  let ctl = new Map();
  let seq = 0;
  let quiet = false; // our own change: don't rebuild under the field being typed in
  const reg = (o) => {
    const k = 'k' + ++seq;
    ctl.set(k, o);
    return k;
  };
  const nodes = () => ed.sel.map((id) => ed.node(id)).filter(Boolean);
  const same = (list, get) => {
    const vals = list.map(get);
    return vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])) ? vals[0] : MIXED;
  };

  /** Change the selected layers. `key` groups quick repeated changes (scrubbing, typing) into one undo step. */
  function apply(fn, key = null, list = nodes()) {
    ed.checkpoint(key);
    list.forEach(fn);
    quiet = true;
    ed.commit({ quiet: true });
    quiet = false;
  }
  const setAndRedraw = (fn, key) => {
    apply(fn, key);
    render();
  };

  /* ---------------- controls ---------------- */

  function num(label, get, set, o = {}) {
    const list = o.list || nodes();
    const v = same(list, get);
    const k = reg({ type: 'num', get, set, list, step: o.step || 1, min: o.min ?? -Infinity, max: o.max ?? Infinity, scale: o.scale || 1, key: o.key || label });
    const shown = v === MIXED ? '' : v == null || v === '' ? '' : round(v * (o.scale || 1));
    return `<label class="dzi-num${o.wide ? ' wide' : ''}" title="${esc(o.title || label)}"><span class="dzi-l" data-scrub="${k}">${o.icon ? glyph(o.icon, 14) : esc(label)}</span><input data-k="${k}" value="${esc(shown)}" placeholder="${v === MIXED ? 'Mixed' : esc(o.placeholder || '')}" inputmode="decimal" spellcheck="false">${o.suffix ? `<i data-scrub="${k}">${o.suffix}</i>` : ''}</label>`;
  }
  function select(get, set, options, o = {}) {
    const list = o.list || nodes();
    const v = same(list, get);
    const k = reg({ type: 'select', set, list, key: o.key });
    return `<select class="dzi-select${o.cls ? ' ' + o.cls : ''}" data-k="${k}" title="${esc(o.title || '')}">${v === MIXED ? '<option value="" selected disabled>Mixed</option>' : ''}${options.map(([val, label]) => `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  }
  function seg(get, set, options, o = {}) {
    const list = o.list || nodes();
    const v = same(list, get);
    const k = reg({ type: 'seg', set, list });
    return `<div class="dzi-seg" data-k="${k}">${options.map(([val, label, tip]) => `<button type="button" data-v="${esc(val)}" class="${String(val) === String(v) ? 'on' : ''}" title="${esc(tip || '')}">${label}</button>`).join('')}</div>`;
  }
  function text(get, set, o = {}) {
    const list = o.list || nodes();
    const v = same(list, get);
    const k = reg({ type: 'text', set, list, key: o.key });
    return `<input class="dzi-text${o.mono ? ' mono' : ''}" data-k="${k}" value="${esc(v === MIXED ? '' : v ?? '')}" placeholder="${v === MIXED ? 'Mixed' : esc(o.placeholder || '')}" spellcheck="false"${o.list2 ? ` list="${o.list2}"` : ''}>`;
  }
  function color(get, set, o = {}) {
    const list = o.list || nodes();
    const v = same(list, get);
    const c = v === MIXED || !v ? { hex: '#000000', a: 1 } : parseColor(v);
    const k = reg({ type: 'color', get, set, list, key: o.key || 'color' });
    return `<div class="dzi-color" data-k="${k}"><button type="button" class="dzi-swatch" data-swatch style="--c:${esc(v === MIXED ? 'transparent' : v || 'transparent')}"></button><input data-hex value="${v === MIXED ? '' : c.raw ? esc(v) : c.hex.slice(1).toUpperCase()}" placeholder="${v === MIXED ? 'Mixed' : ''}" spellcheck="false"><input data-alpha value="${v === MIXED ? '' : Math.round(c.a * 100)}" inputmode="decimal"><i data-scrub-alpha>%</i></div>`;
  }
  function toggle(label, get, set, o = {}) {
    const list = o.list || nodes();
    const v = same(list, get);
    const k = reg({ type: 'toggle', set, list });
    return `<label class="dzi-check"><input type="checkbox" data-k="${k}"${v === true ? ' checked' : ''}${v === MIXED ? ' data-mixed' : ''}> ${esc(label)}</label>`;
  }
  const btn = (act, inner, title, cls = '') => `<button type="button" class="dzi-icon ${cls}" data-act="${act}" title="${esc(title)}">${inner}</button>`;
  const section = (title, body, actions = '', cls = '') => `<section class="dzi-sec ${cls}"><header><h4>${title}</h4><span class="grow"></span>${actions}</header>${body ? `<div class="dzi-body">${body}</div>` : ''}</section>`;

  /* ---------------- sections ---------------- */

  function render() {
    ctl = new Map();
    seq = 0;
    const list = nodes();
    if (!list.length) return renderDoc();
    const one = list.length === 1 ? list[0] : null;
    const parents = list.map((n) => ed.parentOf(n.id));
    const flowAll = parents.every((p, i) => p && layoutOf(p) && !list[i].absolute);
    const anyFlow = parents.some((p) => p && layoutOf(p));
    const frames = list.every((n) => n.type === 'frame');
    const texts = list.every((n) => n.type === 'text');
    const boxes = list.every((n) => n.type !== 'text');
    const out = [];

    // What it is, and the HTML element it'll be built as.
    const kinds = [...new Set(list.map((n) => (n.variant ? 'State' : n.ref ? 'Reference' : n.type === 'frame' && !ed.parentOf(n.id) ? 'Component' : n.type[0].toUpperCase() + n.type.slice(1))))];
    out.push(`<div class="dzi-head"><b>${list.length > 1 ? `${list.length} layers` : esc(kinds[0])}</b>${frames ? `<span class="grow"></span><span class="dzi-tag">${select((n) => n.tag || 'div', (n, v) => (v === 'div' ? delete n.tag : (n.tag = v)), TAGS.map((t) => [t, `<${t}>`]), { title: 'The HTML element it becomes' })}</span>` : ''}</div>`);

    // Align
    out.push(`<div class="dzi-align">${[['left', 'al-left', 'Align left (Alt+A)'], ['hcenter', 'al-hcenter', 'Align horizontal centers (Alt+H)'], ['right', 'al-right', 'Align right'], ['top', 'al-top', 'Align top (Alt+W)'], ['vcenter', 'al-vcenter', 'Align vertical centers (Alt+V)'], ['bottom', 'al-bottom', 'Align bottom (Alt+S)']].map(([a, g2, t]) => btn('align:' + a, glyph(g2, 16), t)).join('')}${list.length > 2 ? btn('dist:x', glyph('dist-h'), 'Distribute horizontally') + btn('dist:y', glyph('dist-v'), 'Distribute vertically') : ''}</div>`);

    // Position and size
    const sizeOpts = (axis) => {
      const o = [['fixed', 'Fixed']];
      if (list.every((n) => n.type === 'text' || layoutOf(n))) o.push(['hug', 'Hug']);
      if (flowAll) o.push(['fill', 'Fill']);
      return o;
    };
    let pos = '';
    if (!flowAll) pos += `<div class="dzi-row">${num('X', (n) => n.x, (n, v) => (n.x = v))}${num('Y', (n) => n.y, (n, v) => (n.y = v))}</div>`;
    pos += `<div class="dzi-row">${num('W', (n) => n.w, (n, v) => ((n.w = Math.max(0, v)), (n.sizing = { ...n.sizing, w: 'fixed' })), { min: 0 })}${num('H', (n) => n.h, (n, v) => ((n.h = Math.max(0, v)), (n.sizing = { ...n.sizing, h: 'fixed' })), { min: 0 })}</div>`;
    pos += `<div class="dzi-row">${select((n) => n.sizing?.w || 'fixed', (n, v) => (n.sizing = { ...n.sizing, w: v }), sizeOpts('w'), { title: 'Width: fixed, hug its content, or fill the auto layout', cls: 'half' })}${select((n) => n.sizing?.h || 'fixed', (n, v) => (n.sizing = { ...n.sizing, h: v }), sizeOpts('h'), { title: 'Height: fixed, hug its content, or fill the auto layout', cls: 'half' })}</div>`;
    const flags = [];
    if (anyFlow) flags.push(btn('absolute', glyph('absolute'), 'Absolute position: ignore the auto layout', list.every((n) => n.absolute) ? 'on' : ''));
    if (frames) flags.push(btn('clip', glyph('clip'), 'Clip content', list.every((n) => n.clip) ? 'on' : ''));
    out.push(section(flowAll ? 'Size' : 'Position', pos, flags.join('')));

    // Auto layout
    if (frames) {
      const L = one ? layoutOf(one) : list.every((n) => layoutOf(n)) ? layoutOf(list[0]) : null;
      // Free design for everything inside, when there's auto layout below this frame (or several levels of it).
      const nested = (n) => (n.children || []).some((c) => layoutOf(c) || nested(c));
      const freeAll = list.some(nested) ? btn('free-all', glyph('free'), 'Free design: take this and every frame inside it out of auto layout (Alt+Shift+A)') : '';
      if (L && one) {
        const row = L.mode === 'row';
        const grid = ['start', 'center', 'end']
          .map((a) => ['start', 'center', 'end'].map((j) => {
            const on = L.justify === 'between' ? L.align === a : (row ? L.justify === j && L.align === a : L.justify === a && L.align === j);
            const jv = row ? j : a;
            const av = row ? a : j;
            return `<button type="button" data-act="grid:${jv}:${av}" class="${on ? 'on' : ''}" title="${row ? `${jv} / ${av}` : `${av} / ${jv}`}"><i class="${row ? 'r' : 'c'}"></i></button>`;
          }).join(''))
          .join('');
        const pad = L.padding || [0, 0, 0, 0];
        const fourPads = L.fourPads || !(pad[0] === pad[2] && pad[1] === pad[3]);
        const P = (i, label, icon) => num(label, (n) => n.layout.padding?.[i] ?? 0, (n, v) => { const p2 = [...(n.layout.padding || [0, 0, 0, 0])]; p2[i] = Math.max(0, v); n.layout.padding = p2; }, { icon, title: `Padding ${label}`, key: 'pad' + i });
        const PH = num('H', (n) => n.layout.padding?.[1] ?? 0, (n, v) => { const p2 = [...(n.layout.padding || [0, 0, 0, 0])]; p2[1] = p2[3] = Math.max(0, v); n.layout.padding = p2; }, { icon: 'padh', title: 'Horizontal padding', key: 'padh' });
        const PV = num('V', (n) => n.layout.padding?.[0] ?? 0, (n, v) => { const p2 = [...(n.layout.padding || [0, 0, 0, 0])]; p2[0] = p2[2] = Math.max(0, v); n.layout.padding = p2; }, { icon: 'padv', title: 'Vertical padding', key: 'padv' });
        const body = `<div class="dzi-row">${seg((n) => (n.layout.wrap ? 'wrap' : n.layout.mode), (n, v) => Object.assign(n.layout, v === 'wrap' ? { mode: 'row', wrap: true } : { mode: v, wrap: false }), [['column', glyph('column'), 'Vertical'], ['row', glyph('row'), 'Horizontal'], ['wrap', glyph('wrap'), 'Wrap']])}<span class="grow"></span></div>
          <div class="dzi-al"><div class="dzi-grid${L.justify === 'between' ? ' between' : ''} ${row ? 'row' : 'col'}">${grid}</div>
          <div class="dzi-al-side">${L.justify === 'between' ? `<div class="dzi-auto">Auto gap ${btn('gap-fixed', 'Fixed', 'Use a fixed gap', 'txt')}</div>` : num('Gap', (n) => n.layout.gap || 0, (n, v) => (n.layout.gap = Math.max(0, v)), { icon: 'gap', title: 'Gap between items' })}
          ${L.justify !== 'between' ? btn('gap-auto', 'Auto', 'Space between: push items to the ends', 'txt') : ''}
          ${select((n) => n.layout.align || 'start', (n, v) => (n.layout.align = v), [['start', 'Align start'], ['center', 'Align center'], ['end', 'Align end'], ['stretch', 'Stretch'], ['baseline', 'Baseline']], { title: 'Cross-axis alignment' })}</div></div>
          ${fourPads ? `<div class="dzi-row">${P(3, 'Left', 'padh')}${P(0, 'Top', 'padv')}</div><div class="dzi-row">${P(1, 'Right', 'padh')}${P(2, 'Bottom', 'padv')}</div>` : `<div class="dzi-row">${PH}${PV}</div>`}
          <div class="dzi-row end">${btn('pads', glyph('corners'), fourPads ? 'Same padding on opposite sides' : 'Padding on each side', fourPads ? 'on' : '')}</div>`;
        out.push(section('Auto layout', body, freeAll + btn('al-off', glyph('minus'), 'Remove auto layout: free layers that stay where they are (Shift+A)')));
      } else out.push(section('Auto layout', '', freeAll + btn('al-on', glyph('plus'), 'Add auto layout (Shift+A)')));
    }

    // Appearance
    const rad = boxes && list.every((n) => n.type !== 'ellipse' && n.type !== 'svg');
    const radiusArr = one && Array.isArray(one.radius);
    let app = `<div class="dzi-row">${num('Opacity', (n) => (n.opacity ?? 1) * 100, (n, v) => (v >= 100 ? delete n.opacity : (n.opacity = Math.max(0, Math.min(100, v)) / 100)), { icon: 'opacity', suffix: '%', min: 0, max: 100 })}${rad ? num('Radius', (n) => (Array.isArray(n.radius) ? (n.radius.every((r) => r === n.radius[0]) ? n.radius[0] : null) : n.radius || 0), (n, v) => (v ? (n.radius = Math.max(0, v)) : delete n.radius), { icon: 'radius', min: 0, placeholder: radiusArr ? 'Mixed' : '' }) : '<span class="grow"></span>'}</div>`;
    if (rad && one && radiusArr) {
      const R = (i, t) => num(t, (n) => (Array.isArray(n.radius) ? n.radius[i] : n.radius || 0), (n, v) => { const r = Array.isArray(n.radius) ? [...n.radius] : [n.radius || 0, n.radius || 0, n.radius || 0, n.radius || 0]; r[i] = Math.max(0, v); n.radius = r; }, { title: t + ' corner', key: 'rad' + i });
      app += `<div class="dzi-row">${R(0, '↖')}${R(1, '↗')}</div><div class="dzi-row">${R(3, '↙')}${R(2, '↘')}</div>`;
    }
    app += `<div class="dzi-row">${select((n) => n.blend || 'normal', (n, v) => (v === 'normal' ? delete n.blend : (n.blend = v)), BLENDS.map((b) => [b, b[0].toUpperCase() + b.slice(1).replace('-', ' ')]), { title: 'Blend mode' })}</div>`;
    out.push(section('Appearance', app, rad && one ? btn('corners', glyph('corners'), 'Independent corners', radiusArr ? 'on' : '') : ''));

    // Text
    if (texts) out.push(textSection(list));

    // Fill (on text it paints the letters, over the text color: gradient text)
    out.push(fillSection(list, one, texts));

    // Stroke, effects
    out.push(strokeSection(list));
    out.push(effectsSection(list));

    // SVG and image specifics
    if (list.every((n) => n.type === 'svg')) out.push(section('Vector', `<div class="dzi-row">${color((n) => n.color || '#000000', (n, v) => (n.color = v), { key: 'svgcolor' })}</div><p class="dzi-note">Sets <code>currentColor</code>: parts of the SVG drawn in it follow this color.</p><div class="dzi-row">${one?.icon ? btn('icon-swap', `${glyph('icons', 14)} Swap icon…`, 'Pick another icon (same size and color)', 'txt wide') : ''}${btn('svg-edit', one?.icon ? 'Edit SVG…' : 'Edit SVG code…', 'Edit the markup', 'txt wide')}</div>`));
    if (one?.type === 'image') {
      const src = resolveSrc(one.src, ed.doc.assets);
      out.push(section('Image', `<div class="dzi-img">${src ? `<img src="${esc(src)}" alt="">` : ''}</div><div class="dzi-row">${select((n) => n.fit || 'cover', (n, v) => (n.fit = v), [['cover', 'Fill (crop)'], ['contain', 'Fit'], ['fill', 'Stretch'], ['none', 'Original size']])}${btn('img-replace', 'Replace…', 'Choose another image', 'txt')}</div>${opts.canTrace ? `<div class="dzi-row">${btn('img-trace', `${glyph('claude', 14)} Rebuild as layers with Claude`, 'Claude recreates this picture as real, editable layers', 'txt wide accent')}</div>` : ''}`));
    }

    // HTML: attributes for the build (aria-label, type, role…)
    if (one && one.type !== 'text') out.push(kvSection('HTML attributes', 'attrs', one, 'aria-label', 'Close menu'));
    if (one) out.push(kvSection('Other CSS', 'css', one, 'cursor', 'pointer'));

    // The CSS this layer becomes
    if (one) {
      const p = ed.parentOf(one.id);
      const css = Object.entries(nodeCss(one, p, { mode: p ? 'canvas' : 'export', assets: {} }))
        .map(([k, v]) => `${k}: ${String(v).length > 120 ? String(v).slice(0, 120) + '…' : v};`)
        .join('\n');
      out.push(section('CSS', `<pre class="dzi-css">${esc(css)}</pre>`, btn('copy-css', glyph('code', 14), 'Copy CSS'), 'collapsible' + (opts.cssOpen ? '' : ' closed')));
    }

    panel.innerHTML = out.join('');
  }

  function textSection(list) {
    const F = (k) => (n) => n.font?.[k];
    const setF = (k) => (n, v) => (n.font = { ...n.font, [k]: v });
    const families = [...new Set([...(ed.doc.fonts || []).map((f) => f.family), ...FONTS])];
    const body = `<datalist id="dz-fonts-list">${families.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <div class="dzi-row">${text((n) => n.font?.family?.split(',')[0].replace(/["']/g, '').trim(), (n, v) => (n.font = { ...n.font, family: v.includes(',') ? v : `${/\s/.test(v) ? `"${v}"` : v}, ${n.font?.family?.split(',').slice(1).join(',').trim() || 'system-ui, sans-serif'}` }), { list2: 'dz-fonts-list', placeholder: 'Font' })}</div>
      <div class="dzi-row">${select((n) => n.font?.weight || 400, (n, v) => (n.font = { ...n.font, weight: +v }), WEIGHTS)}${num('Size', F('size'), (n, v) => (n.font = { ...n.font, size: Math.max(1, v) }), { title: 'Font size' })}</div>
      <div class="dzi-row">${num('Line', (n) => (n.font?.lineHeight === 'auto' ? null : n.font?.lineHeight), (n, v) => (n.font = { ...n.font, lineHeight: v || 'auto' }), { title: 'Line height', placeholder: 'Auto' })}${num('Letter', F('letterSpacing'), setF('letterSpacing'), { title: 'Letter spacing', step: 0.1 })}</div>
      <div class="dzi-row">${seg((n) => n.font?.align || 'left', setF('align'), [['left', glyph('align-l'), 'Left'], ['center', glyph('align-c'), 'Center'], ['right', glyph('align-r'), 'Right'], ['justify', glyph('align-j'), 'Justify']])}${seg((n) => n.font?.decoration || 'none', (n, v) => (n.font = { ...n.font, decoration: v === 'none' ? undefined : v }), [['none', glyph('none'), 'None'], ['underline', glyph('underline'), 'Underline'], ['line-through', glyph('strike'), 'Strikethrough']])}</div>
      <div class="dzi-row">${color((n) => n.font?.color || '#000000', setF('color'), { key: 'textcolor' })}</div>
      <div class="dzi-row">${select((n) => n.font?.transform || 'none', (n, v) => (n.font = { ...n.font, transform: v === 'none' ? undefined : v }), [['none', 'As typed'], ['uppercase', 'UPPERCASE'], ['lowercase', 'lowercase'], ['capitalize', 'Title Case']])}${toggle('Italic', (n) => !!n.font?.italic, (n, v) => (n.font = { ...n.font, italic: v || undefined }))}</div>
      <div class="dzi-row">${toggle('Truncate with …', (n) => !!n.truncate, (n, v) => (v ? (n.truncate = true) : delete n.truncate))}${list.length === 1 && list[0].runs ? `<span class="dzi-note">Mixed styles (editing the text makes it one style)</span>` : ''}</div>`;
    return section('Text', body);
  }

  function fillSection(list, one, texts = false) {
    if (!one) {
      const v = same(list, (n) => n.fills || []);
      if (v === MIXED) return section('Fill', '<p class="dzi-note">Mixed fills. Select one layer to edit them.</p>', btn('fill-add', glyph('plus'), 'Add fill'));
    }
    const fills = (one || list[0]).fills || [];
    const rows = fills.map((f, i) => {
      const L = list;
      const at = (fn) => (n, v) => n.fills?.[i] && fn(n.fills[i], v);
      const typeSel = select((n) => n.fills?.[i]?.type, (n, v) => n.fills?.[i] && (n.fills[i] = convertFill(n.fills[i], v)), [['solid', 'Solid'], ['linear', 'Linear'], ['radial', 'Radial'], ['image', 'Image'], ['css', 'CSS']], { list: L, cls: 'type' });
      let body = '';
      if (f.type === 'solid') body = color((n) => n.fills?.[i]?.color, at((x, v) => (x.color = v)), { list: L, key: 'fill' + i });
      else if (f.type === 'linear' || f.type === 'radial') {
        body = `${f.type === 'linear' ? num('Angle', (n) => n.fills?.[i]?.angle ?? 180, at((x, v) => (x.angle = v)), { list: L, suffix: '°', key: 'ang' + i }) : ''}
          <div class="dzi-grad" style="--g:${esc(`linear-gradient(90deg, ${(f.stops || []).map((s) => `${s.color} ${Math.round((s.pos ?? 0) * 100)}%`).join(', ')})`)}"></div>
          ${(f.stops || []).map((s, j) => `<div class="dzi-row stop">${num('Pos', (n) => (n.fills?.[i]?.stops?.[j]?.pos ?? 0) * 100, at((x, v) => x.stops[j] && (x.stops[j].pos = Math.max(0, Math.min(100, v)) / 100)), { list: L, suffix: '%', key: `stop${i}${j}` })}${color((n) => n.fills?.[i]?.stops?.[j]?.color, at((x, v) => x.stops[j] && (x.stops[j].color = v)), { list: L, key: `stopc${i}${j}` })}${f.stops.length > 2 ? btn(`stop-del:${i}:${j}`, glyph('minus'), 'Remove stop') : ''}</div>`).join('')}
          <div class="dzi-row end">${btn('stop-add:' + i, `${glyph('plus', 14)} Stop`, 'Add a color stop', 'txt')}</div>`;
      } else if (f.type === 'image') body = `<div class="dzi-row"><span class="dzi-thumb" style="background-image:url('${esc(resolveSrc(f.src, ed.doc.assets))}')"></span>${select((n) => n.fills?.[i]?.fit || 'cover', at((x, v) => ((x.fit = v), (x.size = v === 'fill' ? '100% 100%' : v === 'none' ? 'auto' : v))), [['cover', 'Fill'], ['contain', 'Fit'], ['fill', 'Stretch'], ['none', 'Original']], { list: L })}${btn('fill-image:' + i, 'Choose…', 'Choose an image', 'txt')}</div>`;
      else body = text((n) => n.fills?.[i]?.value, at((x, v) => (x.value = v)), { list: L, mono: true, key: 'css' + i });
      return `<div class="dzi-fill${f.visible === false ? ' off' : ''}"><div class="dzi-row">${typeSel}<span class="grow"></span>${btn('fill-eye:' + i, glyph(f.visible === false ? 'eye-off' : 'eye'), f.visible === false ? 'Show' : 'Hide')}${btn('fill-del:' + i, glyph('minus'), 'Remove fill')}</div><div class="dzi-fill-body">${body}</div></div>`;
    });
    return section(texts ? 'Text fill' : 'Fill', rows.join('') || (texts ? '<p class="dzi-note">Paint the letters with a gradient or an image (the text color is used without one).</p>' : ''), btn('fill-add', glyph('plus'), 'Add fill'));
  }

  function convertFill(f, type) {
    const c = f.color || f.stops?.[0]?.color || '#d9d9d9';
    if (type === 'solid') return { type, color: c };
    if (type === 'linear' || type === 'radial') return { type, angle: 180, stops: f.stops || [{ color: c, pos: 0 }, { color: formatColor(parseColor(c).hex, 0), pos: 1 }] };
    if (type === 'image') return { type, src: '', fit: 'cover', size: 'cover' };
    return { type: 'css', value: f.value || (f.type === 'solid' ? `linear-gradient(${c}, ${c})` : '') };
  }

  function strokeSection(list) {
    const has = list.some((n) => n.stroke);
    if (!has) return section('Stroke', '', btn('stroke-add', glyph('plus'), 'Add stroke'));
    const S = (k) => (n) => n.stroke?.[k];
    const setS = (k) => (n, v) => n.stroke && (n.stroke[k] = v);
    const sides = list.length === 1 && list[0].stroke?.sides;
    const body = `<div class="dzi-row">${color(S('color'), setS('color'), { key: 'stroke' })}</div>
      <div class="dzi-row">${num('Width', (n) => (n.stroke?.sides ? Math.max(...n.stroke.sides) : n.stroke?.width), (n, v) => n.stroke && ((n.stroke.width = Math.max(0, v)), delete n.stroke.sides), { title: 'Stroke width', min: 0, step: 0.5 })}${select((n) => n.stroke?.align || 'inside', (n, v) => n.stroke && (n.stroke.align = v), [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']])}</div>
      <div class="dzi-row">${select((n) => n.stroke?.style || 'solid', setS('style'), [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']])}${btn('stroke-eye', glyph(list.every((n) => n.stroke?.visible === false) ? 'eye-off' : 'eye'), 'Show or hide')}</div>
      ${sides ? `<p class="dzi-note">Per side: ${sides.join(' / ')} px (top, right, bottom, left)</p>` : ''}`;
    return section('Stroke', body, btn('stroke-del', glyph('minus'), 'Remove stroke'));
  }

  function effectsSection(list) {
    const one = list.length === 1 ? list[0] : null;
    if (!one) return section('Effects', list.some((n) => n.effects?.length) ? '<p class="dzi-note">Select one layer to edit its effects.</p>' : '', btn('fx-add', glyph('plus'), 'Add effect'));
    const rows = (one.effects || []).map((e, i) => {
      const at = (fn) => (n, v) => n.effects?.[i] && fn(n.effects[i], v);
      const typeSel = select((n) => n.effects?.[i]?.type, at((x, v) => {
        x.type = v;
        if (v === 'blur' || v === 'bg-blur') x.radius ??= 8;
        else Object.assign(x, { x: x.x ?? 0, y: x.y ?? 4, blur: x.blur ?? 8, spread: x.spread ?? 0, color: x.color || 'rgba(0, 0, 0, 0.25)' });
      }), [['drop', 'Drop shadow'], ['inner', 'Inner shadow'], ['blur', 'Layer blur'], ['bg-blur', 'Background blur']], { cls: 'type' });
      const body =
        e.type === 'blur' || e.type === 'bg-blur'
          ? `<div class="dzi-row">${num('Blur', (n) => n.effects?.[i]?.radius, at((x, v) => (x.radius = Math.max(0, v))), { key: 'fxr' + i })}<span class="grow"></span></div>`
          : `<div class="dzi-row">${num('X', (n) => n.effects?.[i]?.x, at((x, v) => (x.x = v)), { key: 'fxx' + i })}${num('Y', (n) => n.effects?.[i]?.y, at((x, v) => (x.y = v)), { key: 'fxy' + i })}</div>
            <div class="dzi-row">${num('Blur', (n) => n.effects?.[i]?.blur, at((x, v) => (x.blur = Math.max(0, v))), { key: 'fxb' + i })}${num('Spread', (n) => n.effects?.[i]?.spread, at((x, v) => (x.spread = v)), { key: 'fxs' + i })}</div>
            <div class="dzi-row">${color((n) => n.effects?.[i]?.color, at((x, v) => (x.color = v)), { key: 'fxc' + i })}</div>`;
      return `<div class="dzi-fill${e.visible === false ? ' off' : ''}"><div class="dzi-row">${typeSel}<span class="grow"></span>${btn('fx-eye:' + i, glyph(e.visible === false ? 'eye-off' : 'eye'), 'Show or hide')}${btn('fx-del:' + i, glyph('minus'), 'Remove effect')}</div><div class="dzi-fill-body">${body}</div></div>`;
    });
    return section('Effects', rows.join(''), btn('fx-add', glyph('plus'), 'Add effect'));
  }

  function kvSection(title, prop, n, keyHint, valHint) {
    const entries = Object.entries(n[prop] || {});
    const rows = entries
      .map(([k, v], i) => `<div class="dzi-kv"><input data-kv="${prop}:${i}:k" value="${esc(k)}" spellcheck="false" class="mono"><input data-kv="${prop}:${i}:v" value="${esc(String(v))}" spellcheck="false" class="mono">${btn(`kv-del:${prop}:${i}`, glyph('minus'), 'Remove')}</div>`)
      .join('');
    return section(title, rows || `<p class="dzi-note">${prop === 'attrs' ? 'For the build: aria-label, role, type, href…' : 'CSS the panels don’t cover (cursor, transform, transition…).'}</p>`, btn(`kv-add:${prop}:${keyHint}:${valHint}`, glyph('plus'), 'Add'), 'collapsible' + (entries.length ? '' : ' closed'));
  }

  /** Nothing selected: the design as a whole. */
  function renderDoc() {
    const doc = ed.doc;
    const colors = new Map();
    for (const f of doc.nodes) {
      const t = tokensOf(f);
      t.colors.forEach(([c, v]) => colors.set(c, (colors.get(c) || 0) + v.n));
    }
    const comps = doc.nodes.filter((n) => n.type === 'frame' && !n.variant);
    panel.innerHTML = `${section('Canvas', `<div class="dzi-row">${color(() => doc.canvas || '', (_, v) => (doc.canvas = v), { list: [doc], key: 'canvas' })}</div>`, '')}
      ${section('Components', comps.length ? comps.map((c) => `<button type="button" class="dzi-comp" data-act="sel:${c.id}">${glyph('component', 14)}<span>${esc(c.name)}</span><small>${doc.nodes.filter((s) => s.variant?.of === c.id).length ? doc.nodes.filter((s) => s.variant?.of === c.id).length + 1 + ' states' : ''}</small></button>`).join('') : '<p class="dzi-note">Draw a frame (F), start from a template, or capture an element from a window (C).</p>')}
      ${colors.size ? section('Colors', `<div class="dzi-swatches">${[...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([c]) => `<button type="button" class="dzi-sw" style="--c:${esc(c)}" title="${esc(c)} — click to copy" data-act="copy:${esc(c)}"></button>`).join('')}</div>`) : ''}
      ${doc.fonts?.length ? section('Captured fonts', doc.fonts.map((f) => `<div class="dzi-font" style="font-family:'${esc(f.family)}';font-weight:${esc(String(f.weight))};font-style:${esc(f.style)}">${esc(f.family)} <small>${esc(String(f.weight))} ${esc(f.style)}</small></div>`).join('')) : ''}
      ${section('Shortcuts', `<dl class="dzi-keys">${[['V / H', 'Move / hand'], ['F  R  O  T', 'Frame, rectangle, ellipse, text'], ['C', 'Capture an element'], ['I', 'Icons'], ['P  L  B  N', 'Markup: pen, line, box, note'], ['Shift+L', 'Markup arrow'], ['Ctrl+\\', 'Hide / show both panels'], ['Shift+A', 'Auto layout'], ['Ctrl+G', 'Group  (Ctrl+Shift+G ungroup)'], ['Ctrl+D', 'Duplicate'], ['Alt+drag', 'Duplicate while moving'], ['Enter / Shift+Enter', 'Into / out of a frame'], ['Ctrl+click', 'Deepest layer'], ['Alt (hover)', 'Measure distances'], ['Shift+1 / 2 / 0', 'Fit all / selection / 100%'], ['Ctrl+Shift+H / L', 'Hide / lock']].map(([k, d]) => `<dt>${esc(k)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>`, '', 'collapsible')}`;
  }

  /* ---------------- events ---------------- */

  const commitNum = (input, live = false) => {
    const c = ctl.get(input.dataset.k);
    if (!c) return;
    const v = evalNum(input.value);
    if (v == null) return;
    const val = Math.min(c.max, Math.max(c.min, v)) / c.scale;
    apply((n) => c.set(n, val), live ? c.key : null, c.list);
  };
  const commitColor = (wrap, live = false) => {
    const c = ctl.get(wrap.dataset.k);
    const hexIn = wrap.querySelector('[data-hex]').value.trim();
    const aIn = evalNum(wrap.querySelector('[data-alpha]').value);
    let hex = hexIn.replace(/^#/, '');
    let out;
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((x) => x + x).join('');
    if (/^[0-9a-f]{6}$/i.test(hex)) out = formatColor('#' + hex.toLowerCase(), aIn == null ? 1 : Math.max(0, Math.min(100, aIn)) / 100);
    else if (hexIn && !/^[0-9a-f]+$/i.test(hexIn)) out = hexIn; // a CSS color name or function
    if (!out) return;
    if (!live) return setAndRedraw((n) => c.set(n, out), c.key, c.list);
    apply((n) => c.set(n, out), c.key, c.list); // scrubbing: keep the field under the pointer
    wrap.querySelector('[data-swatch]').style.setProperty('--c', out);
  };

  panel.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.matches('.dzi-num input')) {
      if (e.key === 'Enter') return commitNum(t), t.select();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const c = ctl.get(t.dataset.k);
        const cur = evalNum(t.value) ?? 0;
        t.value = round(cur + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : c.step));
        commitNum(t, true);
      }
      if (e.key === 'Escape') t.blur();
    } else if (t.matches('[data-hex], [data-alpha]') && e.key === 'Enter') commitColor(t.closest('.dzi-color'));
    else if (t.matches('.dzi-text, [data-kv]') && e.key === 'Enter') t.blur();
    e.stopPropagation();
  });
  panel.addEventListener('change', (e) => {
    const t = e.target;
    const c = ctl.get(t.dataset.k);
    if (t.matches('.dzi-num input')) return commitNum(t);
    if (t.matches('[data-hex], [data-alpha]')) return commitColor(t.closest('.dzi-color'));
    if (t.matches('select') && c) return setAndRedraw((n) => c.set(n, t.value), null, c.list);
    if (t.matches('.dzi-text') && c) return setAndRedraw((n) => c.set(n, t.value), null, c.list);
    if (t.matches('.dzi-check input') && c) return setAndRedraw((n) => c.set(n, t.checked), null, c.list);
    if (t.matches('[data-kv]')) {
      const [prop, i, part] = t.dataset.kv.split(':');
      const n = nodes()[0];
      const entries = Object.entries(n[prop] || {});
      if (!entries[i]) return;
      if (part === 'k') entries[i][0] = t.value.trim();
      else entries[i][1] = t.value;
      setAndRedraw((x) => {
        x[prop] = Object.fromEntries(entries.filter(([k]) => k));
        if (!Object.keys(x[prop]).length) delete x[prop];
      });
    }
  });
  // Scrub: drag a number's label or unit sideways (a color's % scrubs its opacity).
  panel.addEventListener('pointerdown', (e) => {
    const lab = e.target.closest('[data-scrub], [data-scrub-alpha]');
    if (!lab || e.button !== 0) return;
    const alpha = lab.hasAttribute('data-scrub-alpha');
    const c = alpha ? { step: 1, min: 0, max: 100 } : ctl.get(lab.dataset.scrub);
    const input = lab.parentElement.querySelector(alpha ? '[data-alpha]' : 'input');
    const start = evalNum(input.value) ?? 0;
    const x0 = e.clientX;
    e.preventDefault();
    lab.setPointerCapture(e.pointerId);
    document.body.classList.add('dz-scrubbing');
    const move = (ev) => {
      const v = round(start + Math.round((ev.clientX - x0) / 2) * (ev.shiftKey ? 10 : c.step));
      input.value = Math.min(c.max, Math.max(c.min, v));
      if (alpha) commitColor(lab.parentElement, true);
      else commitNum(input, true);
    };
    const up = () => {
      lab.removeEventListener('pointermove', move);
      lab.removeEventListener('pointerup', up);
      document.body.classList.remove('dz-scrubbing');
    };
    lab.addEventListener('pointermove', move);
    lab.addEventListener('pointerup', up);
  });
  panel.addEventListener('click', async (e) => {
    const t = e.target;
    const segB = t.closest('.dzi-seg button');
    if (segB) {
      const c = ctl.get(segB.parentElement.dataset.k);
      return setAndRedraw((n) => c.set(n, segB.dataset.v), null, c.list);
    }
    const sw = t.closest('[data-swatch]');
    if (sw) {
      const wrap = sw.closest('.dzi-color');
      const c = ctl.get(wrap.dataset.k);
      const cur = same(c.list, c.get);
      const parsed = parseColor(cur === MIXED ? '#000000' : cur || '#000000');
      const r = sw.getBoundingClientRect();
      ed.checkpoint();
      pickColor(r.left - 250, r.bottom + 6, {
        value: parsed.hex,
        title: 'Color',
        onChange: (hex) => {
          const v = formatColor(hex, parsed.a || 1);
          c.list.forEach((n) => c.set(n, v));
          quiet = true;
          ed.commit({ quiet: true });
          quiet = false;
          sw.style.setProperty('--c', v);
          wrap.querySelector('[data-hex]').value = hex.slice(1).toUpperCase();
        },
        onDone: () => render(),
      });
      return;
    }
    const sec = t.closest('.dzi-sec.collapsible > header');
    if (sec && !t.closest('[data-act]')) return sec.parentElement.classList.toggle('closed');
    const b = t.closest('[data-act]');
    if (!b) return;
    const [act, a1, a2, a3] = b.dataset.act.split(':');
    const one = nodes()[0];
    switch (act) {
      case 'align':
        return ed.ops.align(a1);
      case 'dist':
        return ed.ops.distribute(a1);
      case 'absolute':
        return setAndRedraw((n) => (b.classList.contains('on') ? delete n.absolute : ed.parentOf(n.id) && layoutOf(ed.parentOf(n.id)) && (n.absolute = true)));
      case 'clip':
        return setAndRedraw((n) => (b.classList.contains('on') ? delete n.clip : (n.clip = true)));
      case 'al-on':
      case 'al-off':
        return ed.ops.autoLayout();
      case 'free-all':
        return ed.ops.freeLayout({ deep: true });
      case 'grid':
        return setAndRedraw((n) => Object.assign(n.layout, n.layout.justify === 'between' ? { align: a2 } : { justify: a1, align: a2 }));
      case 'gap-auto':
        return setAndRedraw((n) => (n.layout.justify = 'between'));
      case 'gap-fixed':
        return setAndRedraw((n) => (n.layout.justify = 'start'));
      case 'pads':
        return setAndRedraw((n) => (n.layout.fourPads = !b.classList.contains('on')));
      case 'corners':
        return setAndRedraw((n) => (n.radius = Array.isArray(n.radius) ? n.radius[0] : [n.radius || 0, n.radius || 0, n.radius || 0, n.radius || 0]));
      case 'fill-add':
        return setAndRedraw((n) =>
          (n.fills = [...(n.fills || []), n.type === 'text' ? { type: 'linear', angle: 90, stops: [{ color: n.font?.color || '#000000', pos: 0 }, { color: '#0a84ff', pos: 1 }] } : { type: 'solid', color: n.fills?.length ? '#000000' : '#d9d9d9' }]));
      case 'fill-del':
        return setAndRedraw((n) => n.fills?.splice(+a1, 1));
      case 'fill-eye':
        return setAndRedraw((n) => n.fills?.[+a1] && (n.fills[+a1].visible === false ? delete n.fills[+a1].visible : (n.fills[+a1].visible = false)));
      case 'fill-image': {
        const url = await opts.chooseImage?.();
        if (url) setAndRedraw((n) => n.fills?.[+a1] && Object.assign(n.fills[+a1], { src: 'asset:' + ed.addAsset(url) }));
        return;
      }
      case 'stop-add':
        return setAndRedraw((n) => {
          const f = n.fills?.[+a1];
          if (f?.stops) f.stops.push({ color: f.stops[f.stops.length - 1].color, pos: 1 });
        });
      case 'stop-del':
        return setAndRedraw((n) => n.fills?.[+a1]?.stops?.splice(+a2, 1));
      case 'stroke-add':
        return setAndRedraw((n) => (n.stroke ||= { color: '#000000', width: 1, align: 'inside' }));
      case 'stroke-del':
        return setAndRedraw((n) => delete n.stroke);
      case 'stroke-eye':
        return setAndRedraw((n) => n.stroke && (n.stroke.visible === false ? delete n.stroke.visible : (n.stroke.visible = false)));
      case 'fx-add':
        return setAndRedraw((n) => (n.effects = [...(n.effects || []), { type: 'drop', x: 0, y: 4, blur: 12, spread: 0, color: 'rgba(0, 0, 0, 0.2)' }]));
      case 'fx-del':
        return setAndRedraw((n) => n.effects?.splice(+a1, 1));
      case 'fx-eye':
        return setAndRedraw((n) => n.effects?.[+a1] && (n.effects[+a1].visible === false ? delete n.effects[+a1].visible : (n.effects[+a1].visible = false)));
      case 'kv-add':
        return setAndRedraw((n) => {
          n[a1] = { ...(n[a1] || {}) };
          let k = a2;
          for (let i = 2; k in n[a1]; i++) k = `${a2}-${i}`;
          n[a1][k] = a3;
        });
      case 'kv-del':
        return setAndRedraw((n) => {
          const entries = Object.entries(n[a1] || {});
          entries.splice(+a2, 1);
          n[a1] = Object.fromEntries(entries);
          if (!entries.length) delete n[a1];
        });
      case 'copy-css':
        return navigator.clipboard.writeText(panel.querySelector('.dzi-css')?.textContent || '').then(() => opts.toast?.('CSS copied'));
      case 'copy':
        return navigator.clipboard.writeText(b.dataset.act.slice(5)).then(() => opts.toast?.(`Copied ${b.dataset.act.slice(5)}`));
      case 'sel':
        ed.select([a1]);
        return ed.fit([a1], { max: 2 });
      case 'svg-edit':
        return opts.editSvg?.(one);
      case 'icon-swap':
        return opts.swapIcon?.(one);
      case 'img-replace': {
        const url = await opts.chooseImage?.();
        if (url) setAndRedraw((n) => (n.src = 'asset:' + ed.addAsset(url)));
        return;
      }
      case 'img-trace':
        return opts.trace?.(one);
    }
  });

  ed.on('select', () => render());
  ed.on('change', (d) => {
    if (quiet || d?.quiet) return;
    if (panel.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
    render();
  });
  // Ctrl+B / I / U on text layers.
  ed.on('text-style', (k) => {
    const list = nodes().filter((n) => n.type === 'text');
    if (!list.length) return;
    if (k === 'b') setAndRedraw((n) => (n.font = { ...n.font, weight: (n.font.weight || 400) >= 600 ? 400 : 700 }));
    if (k === 'i') setAndRedraw((n) => (n.font = { ...n.font, italic: !n.font.italic || undefined }));
    if (k === 'u') setAndRedraw((n) => (n.font = { ...n.font, decoration: n.font.decoration === 'underline' ? undefined : 'underline' }));
  });
  render();
  return { render };
}

