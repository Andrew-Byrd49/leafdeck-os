// The Site Editor's inspector (the Edit pane): every part of an element's CSS, in the order you'd reach for it.
// What the styles apply to (this element, everything with one of its classes, a state, a width), then Layout (auto
// layout the Figma way: direction, the 3×3 alignment, gap, and Hug / Fill / Fixed sizes), Size, Position, the margin
// and padding box, Typography, Backgrounds, Borders, Effects, any other property by name, and the page's own rules for
// the element. Fields show the value the project wrote (1.5rem, var(--gap)) when there is one, else what it computes to.
//
// It draws and reads its own fields; the app (apps/siteeditor.js) owns the changes. `api`:
//   setProps(props, { live })  { property: value } to set, null to take a change back; `live` while dragging (no redraw)
//   setScope(patch)            { target | state | media }
//   select(selector)           select another element (the breadcrumb, the children)
//   hint(kind, side)           show the padding / margin / gap bands on the page (no kind: none)
//   wantRules()                the rules list was opened: read the page's rules for the element
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { glyph } from '../designer/glyphs.js';
import { pickColor } from '../colorpicker.js';
import { showMenu } from '../wm.js';

export const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
/** Fields that write several properties at once. */
const MULTI = {
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  padding: SIDES.map((s) => `padding-${s}`),
  margin: SIDES.map((s) => `margin-${s}`),
  inset: SIDES,
  'border-radius': CORNERS.map((c) => `border-${c}-radius`),
  'border-width': SIDES.map((s) => `border-${s}-width`),
  'border-style': SIDES.map((s) => `border-${s}-style`),
  'border-color': SIDES.map((s) => `border-${s}-color`),
};
const expand = (prop) => MULTI[prop] || [prop];

const short = (s, n = 60) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const px = (v) => {
  const m = /^(-?\d*\.?\d+)px$/.exec(String(v ?? '').trim());
  return m ? String(Math.round(parseFloat(m[1]) * 100) / 100) : String(v ?? '');
};
export function toHex(c) {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(String(c || '').trim());
  if (!m) return /^#/.test(c) ? c : '';
  const h = (n) => Number(n).toString(16).padStart(2, '0');
  const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return `#${h(m[1])}${h(m[2])}${h(m[3])}${a < 1 ? h(Math.round(a * 255)) : ''}`;
}
const transparent = (c) => /^rgba\(\s*\d+[,\s]+\d+[,\s]+\d+[,\s/]+0\s*\)$/.test(String(c || '').trim()) || c === 'transparent';

const LENGTH = /^(width|height|(min|max)-(width|height)|top|right|bottom|left|inset|(padding|margin)(-(top|right|bottom|left))?|gap|row-gap|column-gap|font-size|letter-spacing|word-spacing|text-indent|text-underline-offset|flex-basis|border(-(top|right|bottom|left))?-width|border(-(top|bottom)-(left|right))?-radius|outline-(width|offset))$/;
const NEGATIVE = /^(margin|top|right|bottom|left|inset|letter-spacing|word-spacing|text-indent|text-underline-offset|z-index|order|outline-offset)/;
/** What was typed, as CSS: a bare number is pixels where a length goes, a bare hex a color. */
export function toCss(prop, raw) {
  const v = String(raw ?? '').trim().replace(/;$/, '');
  if (v === '') return '';
  if (/^-?\d*\.?\d+$/.test(v)) {
    if (prop === 'line-height') return parseFloat(v) > 4 ? `${v}px` : v;
    if (LENGTH.test(prop) && parseFloat(v) !== 0) return `${v}px`;
    if (LENGTH.test(prop)) return '0px';
  }
  if (/color$/.test(prop) && /^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return `#${v}`;
  return v;
}
export const validCss = (prop, value) => /^--/.test(prop) || (typeof CSS !== 'undefined' && CSS.supports(prop, value));

/** Commas outside parentheses: the layers of a shadow or a background. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const COLOR_FN = '(?:rgba?|hsla?|color|oklch|oklab|lab|lch|hwb|color-mix)\\((?:[^()]|\\([^()]*\\))*\\)|#[0-9a-f]+';
/** One shadow layer, as computed ("rgba(0, 0, 0, 0.2) 0px 4px 12px 0px") or as written (the color last). */
function parseShadow(s) {
  const inset = /\binset\b/.test(s);
  let rest = String(s || '').replace(/\binset\b/, '').trim();
  let color = '';
  const lead = new RegExp(`^(${COLOR_FN})\\s*`, 'i').exec(rest);
  if (lead) {
    color = lead[1];
    rest = rest.slice(lead[0].length);
  } else {
    const tail = new RegExp(`\\s+(${COLOR_FN}|[a-z]+)$`, 'i').exec(rest);
    if (tail) {
      color = tail[1];
      rest = rest.slice(0, tail.index);
    }
  }
  const n = rest.trim().split(/\s+/);
  if (n.length < 2 || n.length > 4 || n.some((x) => !/^-?\d*\.?\d+(px)?$/.test(x))) return null;
  const len = (x) => (x == null ? '0px' : /px$/.test(x) ? x : `${x}px`);
  return { color: color || 'rgb(0, 0, 0)', x: len(n[0]), y: len(n[1]), blur: len(n[2]), spread: len(n[3]), inset };
}
const shadowCss = (s) => `${s.inset ? 'inset ' : ''}${s.x} ${s.y} ${s.blur} ${s.spread} ${s.color}`;
/** How many tracks a computed grid-template has ("200px 200px [end]" → 2). */
function tracks(v) {
  if (!v || v === 'none') return 0;
  let depth = 0;
  let n = 0;
  let inTok = false;
  for (const ch of v.replace(/\[[^\]]*\]/g, ' ')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && !depth) inTok = false;
    else if (!inTok) {
      inTok = true;
      n++;
    }
  }
  return n;
}

const WEIGHTS = [['100', 'Thin'], ['200', 'Extra light'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']];
const DISPLAYS = ['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'list-item', 'table', 'none'];
const JUSTIFY = [['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['space-between', 'Space between'], ['space-around', 'Space around'], ['space-evenly', 'Space evenly']].map(([v, l]) => [v, `Justify: ${l}`]);
const ALIGN = [['stretch', 'Stretch'], ['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['baseline', 'Baseline']].map(([v, l]) => [v, `Align: ${l}`]);
const SELF = [['auto', 'Auto'], ['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['stretch', 'Stretch'], ['baseline', 'Baseline']];
const ITEMS = [['stretch', 'Stretch'], ['start', 'Start'], ['center', 'Center'], ['end', 'End']];
const STATES = [['', 'No state'], ['hover', ':hover'], ['focus', ':focus'], ['focus-visible', ':focus-visible'], ['focus-within', ':focus-within'], ['active', ':active']];
const SHADOWS = [['Small', '0px 1px 2px 0px rgba(0, 0, 0, 0.08)'], ['Medium', '0px 4px 12px 0px rgba(0, 0, 0, 0.12)'], ['Large', '0px 12px 32px 0px rgba(0, 0, 0, 0.18)'], ['Inner', 'inset 0px 1px 3px 0px rgba(0, 0, 0, 0.2)']];
const SECTIONS = [['layout', 'Layout'], ['size', 'Size'], ['position', 'Position'], ['spacing', 'Spacing'], ['type', 'Typography'], ['fill', 'Backgrounds'], ['border', 'Borders'], ['effects', 'Effects'], ['css', 'Custom CSS'], ['rules', 'CSS rules']];
const CLOSED = { position: true, effects: true, rules: true };

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

let propNames = null;
/** Every CSS property the browser knows, for the Custom CSS box. */
function cssProps() {
  if (propNames) return propNames;
  const names = new Set();
  const st = document.documentElement.style;
  for (const k in st) {
    if (typeof st[k] !== 'string' || /^(webkit|cssText|cssFloat|\d)/.test(k) || k.includes('-')) continue;
    names.add(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
  }
  names.add('float');
  propNames = [...names].sort();
  return propNames;
}

export const originText = (o) => `${o.selector}${o.inherited ? ` (inherited from ${o.inherited})` : ''}${o.media ? ` @media ${o.media}` : ''}${o.file ? ` in ${o.file}${o.line ? ':' + o.line : ''}` : o.url ? ` in ${o.url}` : ''}`;
const originShort = (o) => (o.file ? short(o.file.split('/').pop(), 24) + (o.line ? ':' + o.line : '') : o.selector);

export function createInspector(host, api) {
  let ctx = null; // { selected, declared, rules, change, textChange, scope, vars, breaks }
  let busy = false; // dragging a value or picking a color: the fields stay as they are
  let waiting = false; // a draw came in meanwhile
  let lastSel = '';
  let borderSide = 'all';
  let radiusSplit = null;
  let hinted = '';
  let fielded = new Set();
  const ui = store.get('siteeditor:inspector', {});
  ui.closed ||= {};
  const saveUi = () => store.set('siteeditor:inspector', ui);
  const isClosed = (id) => ui.closed[id] ?? !!CLOSED[id];

  // Suggestions for the Custom CSS box and color fields; outside the pane, so drawing doesn't rebuild them.
  const lists = document.createElement('div');
  lists.hidden = true;
  lists.innerHTML = `<datalist id="sei-props"></datalist><datalist id="sei-vars"></datalist>`;
  host.after(lists);
  let listedVars = null;
  function fillLists() {
    const props = lists.firstElementChild;
    if (!props.childElementCount) props.innerHTML = cssProps().map((p) => `<option value="${p}">`).join('');
    if (listedVars !== ctx.vars) {
      listedVars = ctx.vars;
      lists.lastElementChild.innerHTML = (ctx.vars || []).map((v) => `<option value="var(${esc(v.name)})">${esc(short(v.value, 40))}</option>`).join('');
    }
  }

  /* ----- values ----- */

  const st = () => ctx.selected.styles;
  const chg = (p) => ctx.change?.props?.[p] || null;
  /** Set on this element by one of the project's rules (not inherited). */
  const dec = (p) => {
    const d = ctx.declared?.[p];
    return d && !d.inherited && d.value ? d : null;
  };
  /** Another pending change (another scope) already moved it: what's shown isn't what the project wrote. */
  const moved = (p) => !!ctx.others?.has(p);
  /** The value in effect: the pending change, else what it computes to. */
  const cur = (p) => chg(p)?.after ?? st()[p] ?? '';
  /** The value as written: the pending change, else the project's own (1.5rem, var(--gap)), else what it computes to. */
  const shown = (p) => chg(p)?.after ?? (moved(p) ? st()[p] : dec(p)?.value ?? st()[p]) ?? '';
  const mark = (props) => (props.some(chg) ? ' chg' : props.some(dec) ? ' set' : '');
  const tip = (prop, title = '') => {
    const p = expand(prop)[0];
    const d = ctx.declared?.[p];
    const c = expand(prop).some(chg);
    return `${title ? `${title} (${prop})` : prop}${d ? `\n${originText(d)}` : ''}${c ? '\nChanged here. Alt-click the label to take it back.' : ''}`;
  };
  const obj = (props, v) => Object.fromEntries(props.map((p) => [p, v]));

  /* ----- fields ----- */

  const reg = (prop) => {
    const ps = expand(prop);
    for (const p of ps) fielded.add(p);
    return ps;
  };
  /** A number box. `auto`: empty until something sets it, with what it resolves to as the placeholder. */
  function num(prop, label = '', o = {}) {
    const ps = reg(prop);
    const vals = ps.map(shown);
    const same = vals.every((v) => v === vals[0]);
    const unset = o.auto && !ps.some((p) => chg(p) || dec(p));
    const v = !same || unset ? '' : px(vals[0]);
    const ph = !same ? 'Mixed' : unset ? px(st()[ps[0]]) : o.ph || '';
    return `<label class="dzi-num${mark(ps)}${o.cls || ''}" title="${esc(tip(prop, o.title))}"${o.hint ? ` data-hint="${o.hint}"` : ''}>${label !== '' ? `<span class="dzi-l" data-scrub data-reset="${ps.join(' ')}">${label}</span>` : ''}<input type="text" data-prop="${prop}" data-num value="${esc(v)}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off"></label>`;
  }
  function select(prop, options, o = {}) {
    const ps = reg(prop);
    const raw = cur(ps[0]);
    const v = o.norm ? o.norm(raw) : raw;
    const opts = options.map((x) => (Array.isArray(x) ? x : [x, x]));
    if (!opts.some(([val]) => val === v)) opts.unshift([v, v]);
    return `<select class="dzi-select${mark(ps)}${o.cls || ''}" data-prop="${prop}" title="${esc(tip(prop, o.title))}">${opts.map(([val, l]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  /** Buttons for a keyword. `off`: pressing the lit one sets that instead (a toggle). */
  function seg(prop, options, o = {}) {
    const ps = reg(prop);
    const v = cur(ps[0]);
    return `<span class="dzi-seg${o.cls || ''}${mark(ps)}" data-seg="${prop}"${o.off != null ? ` data-off="${o.off}"` : ''}>${options.map(([val, l, t]) => `<button type="button" data-val="${val}" class="${(o.is ? o.is(val, v) : v === val) ? 'on' : ''}" title="${esc(t || val)}">${l}</button>`).join('')}</span>`;
  }
  function color(prop) {
    const ps = reg(prop);
    const c = st()[ps[0]] ?? '';
    const pending = chg(ps[0])?.after;
    const d = dec(ps[0])?.value || '';
    const none = pending == null && (transparent(c) || c === '');
    const txt = pending != null ? toHex(pending) || pending : /var\(/.test(d) && !moved(ps[0]) ? d : none ? '' : toHex(c) || c;
    const sw = pending && !/var\(|currentcolor/i.test(pending) ? pending : c;
    return `<span class="dzi-color${mark(ps)}" title="${esc(tip(prop))}"><button type="button" class="dzi-swatch" data-swatch="${prop}" style="--c:${esc(none ? 'transparent' : sw)}" title="Pick a color"></button><input type="text" data-prop="${prop}" list="sei-vars" value="${esc(txt)}" placeholder="${none ? 'none' : ''}" spellcheck="false" autocomplete="off"></span>`;
  }
  function text(prop, ph = '', cls = '') {
    reg(prop);
    const v = shown(prop);
    const quiet = !chg(prop) && /^(none|normal|auto|all|all 0s ease 0s|50% 50%( 0px)?|0% 0%)$/.test(v);
    return `<input class="dzi-text mono${mark([prop])}${cls}" type="text" data-prop="${prop}" value="${esc(quiet ? '' : v)}" placeholder="${esc(quiet ? v : ph)}" title="${esc(tip(prop))}" spellcheck="false" autocomplete="off">`;
  }
  const lab = (label, props, title = '') => `<span class="sei-lab${mark(props)}" data-reset="${props.join(' ')}" title="${esc(tip(props[0], title))}">${label}</span>`;
  const row = (label, props, body, title = '') => `<div class="sei-row">${lab(label, props.flatMap(expand), title)}<div class="dzi-row">${body}</div></div>`;

  /* ----- sections ----- */

  /** The 3×3: where the children sit along the direction (justify) and across it (align). */
  function alignGrid() {
    const dir = cur('flex-direction');
    const col = /^column/.test(dir);
    const rev = /reverse/.test(dir);
    const j = cur('justify-content');
    const a = cur('align-items');
    const spaced = /^space-/.test(j);
    const ji = /^(center)$/.test(j) ? 1 : /^(flex-end|end|right)$/.test(j) ? 2 : 0;
    const ai = /^(center)$/.test(a) ? 1 : /^(flex-end|end|last baseline)$/.test(a) ? 2 : 0;
    const J = rev ? ['flex-end', 'center', 'flex-start'] : ['flex-start', 'center', 'flex-end'];
    const A = ['flex-start', 'center', 'flex-end'];
    let h = '';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const main = col ? r : c;
        const cross = col ? c : r;
        const on = cross === ai && (spaced || J[main] === J[rev ? 2 - ji : ji]);
        h += `<button type="button" data-cell="${J[main]}|${A[cross]}" class="${on ? 'on' : ''}" title="${['Top', 'Middle', 'Bottom'][r]} ${['left', 'center', 'right'][c]}"><i></i></button>`;
      }
    }
    return `<div class="dzi-grid ${col ? 'col' : 'row'}" data-hint="gap:all">${h}</div>`;
  }
  function layoutSec() {
    const s = ctx.selected;
    const d = cur('display');
    const flex = /flex/.test(d);
    const grid = /grid/.test(d);
    let h = `<div class="dzi-row">${seg('display', [['block', 'Block'], ['flex', 'Flex'], ['grid', 'Grid'], ['none', 'None']], { cls: ' txt grow', is: (val, v) => (val === 'flex' ? /flex/.test(v) : val === 'grid' ? /grid/.test(v) : v === val) })}${select('display', DISPLAYS, { cls: ' sei-narrow' })}</div>`;
    if (flex) {
      const dir = cur('flex-direction');
      const rev = /reverse/.test(dir);
      const wrap = cur('flex-wrap') !== 'nowrap';
      const spaced = /^space-/.test(cur('justify-content'));
      reg('flex-wrap');
      h += `<div class="dzi-row">
          ${seg('flex-direction', [[`row${rev ? '-reverse' : ''}`, glyph('row', 14), 'Side by side (row)'], [`column${rev ? '-reverse' : ''}`, glyph('column', 14), 'Stacked (column)']], { is: (val, v) => v.split('-')[0] === val.split('-')[0] })}
          <button type="button" class="dzi-icon${rev ? ' on' : ''}" data-act="reverse" title="Reverse the order">${glyph('swap', 14)}</button>
          <button type="button" class="dzi-icon${wrap ? ' on' : ''}" data-act="wrap" title="Wrap onto more lines when they don’t fit">${glyph('wrap', 14)}</button>
          ${num('gap', glyph('gap', 14), { title: 'Gap between the items', hint: 'gap:all', ph: spaced ? 'Auto' : '', cls: ' sei-gap' })}
          <button type="button" class="dzi-icon txt${spaced ? ' on' : ''}" data-act="gap-auto" title="Auto: spread the items across the space (space-between)">Auto</button>
        </div>
        <div class="dzi-al">${alignGrid()}<div class="dzi-al-side">
          ${select('justify-content', JUSTIFY, { norm: (v) => (/^(normal|start|left)$/.test(v) ? 'flex-start' : /^(end|right)$/.test(v) ? 'flex-end' : v) })}
          ${select('align-items', ALIGN, { norm: (v) => (v === 'normal' ? 'stretch' : v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v) })}
        </div></div>`;
      if (wrap) h += row('Lines', ['align-content'], select('align-content', [['normal', 'Normal'], ['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['space-between', 'Space between'], ['space-around', 'Space around'], ['stretch', 'Stretch']]) + num('row-gap', '↕', { title: 'Gap between lines' }) + num('column-gap', '↔', { title: 'Gap between items' }), 'How the lines share the space');
    } else if (grid) {
      h += row('Columns', ['grid-template-columns'], `<label class="dzi-num sei-count" title="Equal columns: how many"><input type="text" data-cols data-num value="${tracks(st()['grid-template-columns']) || ''}" spellcheck="false" autocomplete="off"></label>${text('grid-template-columns', 'none')}`)
        + row('Rows', ['grid-template-rows'], text('grid-template-rows', 'none'))
        + row('Gap', ['gap'], num('row-gap', '↕', { title: 'Gap between rows', hint: 'gap:all' }) + num('column-gap', '↔', { title: 'Gap between columns', hint: 'gap:all' }))
        + row('Justify', ['justify-items'], select('justify-items', ITEMS, { norm: (v) => (/^(normal|legacy)$/.test(v) ? 'stretch' : v) }), 'Each item across its cell')
        + row('Align', ['align-items'], select('align-items', ITEMS, { norm: (v) => (v === 'normal' ? 'stretch' : v) }), 'Each item down its cell')
        + row('Flow', ['grid-auto-flow'], select('grid-auto-flow', ['row', 'column', 'row dense', 'column dense']) + text('grid-auto-rows', 'auto'), 'Where new items go, and the size of rows it adds');
      reg('grid-auto-columns');
    } else if (d !== 'none' && s.childCount) {
      h += `<button type="button" class="dzi-icon wide sei-auto" data-act="autolayout">${glyph(s.flow === 'row' ? 'row' : 'column', 14)} Add auto layout</button>
        <p class="dzi-note">Makes it a flex ${s.flow === 'row' ? 'row' : 'column'}, as its ${s.childCount === 1 ? 'child sits' : `${s.childCount} children sit`} now, so they can be aligned and spaced.</p>`;
    }
    const par = s.parent;
    if (par && /flex/.test(par.display)) {
      h += `<div class="sei-sub"><h5>Inside ${esc(short(par.label, 28))} · flex ${/^column/.test(par.direction) ? 'column' : 'row'}</h5>
        ${row('Align', ['align-self'], select('align-self', SELF, { norm: (v) => (v === 'normal' ? 'auto' : v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v) }), 'Its own alignment across the direction')}
        <div class="dzi-row">${num('flex-grow', 'Grow', { title: 'Share of the spare space it takes' })}${num('flex-shrink', 'Shrink', { title: 'How readily it gives up space' })}</div>
        <div class="dzi-row">${num('flex-basis', 'Basis', { title: 'Its size before growing or shrinking', auto: true })}${num('order', 'Order', { title: 'Its place among the items' })}</div></div>`;
    } else if (par && /grid/.test(par.display)) {
      h += `<div class="sei-sub"><h5>Inside ${esc(short(par.label, 28))} · grid</h5>
        ${row('Column', ['grid-column'], text('grid-column', 'auto · span 2 · 1 / 3'))}
        ${row('Row', ['grid-row'], text('grid-row', 'auto · span 2 · 1 / 3'))}
        ${row('Justify', ['justify-self'], select('justify-self', [['auto', 'Auto'], ...ITEMS], { norm: (v) => (v === 'normal' ? 'auto' : v) }))}
        ${row('Align', ['align-self'], select('align-self', [['auto', 'Auto'], ...ITEMS], { norm: (v) => (v === 'normal' ? 'auto' : v) }))}
        ${row('Order', ['order'], num('order'))}</div>`;
    } else for (const p of ['flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'justify-self', 'order', 'grid-column', 'grid-row']) reg(p);
    for (const p of ['justify-items', 'align-content', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-rows', 'justify-content', 'align-items', 'flex-direction', 'flex-wrap']) reg(p);
    return h;
  }

  /** Where the element sits in its parent, for what Hug, Fill and Fixed mean. */
  function axisOf(axis) {
    const par = ctx.selected.parent;
    const pflex = !!par && /flex/.test(par.display);
    const main = pflex && (axis === 'w') === !/^column/.test(par.direction);
    return { par, pflex, pgrid: !!par && /grid/.test(par.display), main, cross: pflex && !main };
  }
  function sizeMode(axis) {
    const prop = axis === 'w' ? 'width' : 'height';
    const v = chg(prop)?.after ?? dec(prop)?.value ?? '';
    const { par, pgrid, main, cross } = axisOf(axis);
    if (/^(fit-content|max-content|min-content)/.test(v)) return 'hug';
    if (v === '100%' || /stretch|fill-available/.test(v)) return 'fill';
    if (main && parseFloat(cur('flex-grow')) > 0) return 'fill';
    if (v && v !== 'auto') return 'fixed';
    const self = cur(axis === 'w' && pgrid ? 'justify-self' : 'align-self');
    if (cross && (self === 'stretch' || (/^(auto|normal)$/.test(self) && /^(normal|stretch)$/.test(par.alignItems)))) return 'fill';
    if (pgrid && /^(auto|normal|stretch)$/.test(self)) return 'fill';
    if (!main && !cross && !pgrid && axis === 'w' && /^(block|flex|grid|list-item|table)$/.test(cur('display')) && !/^(absolute|fixed)$/.test(cur('position'))) return 'fill';
    return 'hug';
  }
  function setSize(axis, mode) {
    const s = ctx.selected;
    const prop = axis === 'w' ? 'width' : 'height';
    const { pgrid, main, cross } = axisOf(axis);
    const written = !!(chg(prop) || dec(prop));
    const props = {};
    if (mode === 'fixed') {
      props[prop] = `${Math.round(s.rect[axis])}px`;
      if (main) Object.assign(props, { 'flex-grow': '0', 'flex-shrink': '0' });
    } else if (mode === 'hug') {
      props[prop] = 'fit-content';
      if (main) Object.assign(props, { 'flex-grow': '0', 'flex-basis': 'auto' });
    } else if (main) {
      Object.assign(props, { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': '0%' });
      if (written) props[prop] = 'auto';
    } else if (cross || pgrid) {
      props[axis === 'w' && pgrid ? 'justify-self' : 'align-self'] = 'stretch';
      if (written) props[prop] = 'auto';
    } else props[prop] = '100%';
    api.setProps(props);
  }
  function sizeSec() {
    const s = ctx.selected;
    const mode = (axis) => {
      const m = sizeMode(axis);
      return `<select class="dzi-select sei-narrow" data-size="${axis}" title="Fixed: a set size. Hug: as big as what’s inside. Fill: takes the space its parent has.">${[['fixed', 'Fixed'], ['hug', 'Hug'], ['fill', 'Fill']].map(([v, l]) => `<option value="${v}"${v === m ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    };
    reg('object-position');
    return `<div class="dzi-row">${num('width', 'W', { title: 'Width', auto: true })}${mode('w')}</div>
      <div class="dzi-row">${num('height', 'H', { title: 'Height', auto: true })}${mode('h')}</div>
      <div class="dzi-row">${num('min-width', 'Min W', { title: 'Narrowest it gets', auto: true })}${num('max-width', 'Max W', { title: 'Widest it gets', auto: true })}</div>
      <div class="dzi-row">${num('min-height', 'Min H', { title: 'Shortest it gets', auto: true })}${num('max-height', 'Max H', { title: 'Tallest it gets', auto: true })}</div>
      ${row('Overflow', ['overflow'], select('overflow', ['visible', 'hidden', 'clip', 'scroll', 'auto']), 'What happens to content that doesn’t fit')}
      ${row('Ratio', ['aspect-ratio'], num('aspect-ratio', '', { auto: true, ph: '16 / 9' }) + select('box-sizing', [['border-box', 'Border box'], ['content-box', 'Content box']], { title: 'Whether the size includes padding and border' }), 'Width to height')}
      ${/^(img|video|canvas|picture|iframe|svg)$/.test(s.tag) ? row('Fit', ['object-fit'], select('object-fit', ['fill', 'contain', 'cover', 'none', 'scale-down']) + text('object-position', '50% 50%'), 'How the picture fills its box') : ''}`;
  }
  function positionSec() {
    const p = cur('position');
    for (const x of ['float', 'clear']) reg(x);
    return `${row('Position', ['position'], select('position', [['static', 'Static (in the flow)'], ['relative', 'Relative'], ['absolute', 'Absolute'], ['fixed', 'Fixed'], ['sticky', 'Sticky']]))}
      ${p !== 'static'
        ? `<div class="sei-inset">${num('top', 'T', { auto: true, cls: ' t' })}${num('left', 'L', { auto: true, cls: ' l' })}<span class="sei-inset-mid">${glyph('absolute', 14)}</span>${num('right', 'R', { auto: true, cls: ' r' })}${num('bottom', 'B', { auto: true, cls: ' b' })}</div>
          <div class="dzi-row"><button type="button" class="dzi-icon txt" data-act="inset-0" title="Stretch over its container (inset: 0)">Cover the container</button></div>`
        : SIDES.map(reg) && ''}
      ${row('Z-index', ['z-index'], num('z-index', '', { auto: true }), 'What’s in front')}
      ${row('Float', ['float'], select('float', ['none', 'left', 'right']) + select('clear', ['none', 'left', 'right', 'both'], { title: 'Clear' }))}`;
  }
  function spacingSec() {
    const s = ctx.selected;
    const cell = (kind, side) => {
      const p = `${kind}-${side}`;
      reg(p);
      const v = px(shown(p));
      return `<input type="text" class="sei-bx ${side}${mark([p])}${v === '0' ? ' zero' : ''}" data-prop="${p}" data-num data-box="${kind}" data-side="${side}" data-scrub data-hint="${kind}:${side}" value="${esc(v)}" title="${esc(tip(p))}" spellcheck="false" autocomplete="off">`;
    };
    return `<div class="sei-box" data-hint="margin:all"><span class="sei-bt">Margin</span>${SIDES.map((x) => cell('margin', x)).join('')}
        <div class="sei-box in" data-hint="padding:all"><span class="sei-bt">Padding</span>${SIDES.map((x) => cell('padding', x)).join('')}
          <div class="sei-core">${Math.round(s.rect.w)} × ${Math.round(s.rect.h)}</div></div></div>
      <p class="dzi-note">Drag a number, or type one (<code>auto</code>, <code>2rem</code>, <code>var(--space)</code>). Hold Shift for all four sides, Alt for the opposite side too.</p>`;
  }
  function typeSec() {
    const s = ctx.selected;
    let h = `<div class="dzi-row">${text('font-family', 'Font family')}</div>
      <div class="dzi-row">${num('font-size', 'Aa', { title: 'Font size' })}${select('font-weight', WEIGHTS, { norm: (v) => (v === 'normal' ? '400' : v === 'bold' ? '700' : v), title: 'Weight' })}</div>
      <div class="dzi-row">${num('line-height', '↕', { title: 'Line height' })}${num('letter-spacing', 'AV', { title: 'Letter spacing' })}</div>
      <div class="dzi-row">${color('color')}</div>
      <div class="dzi-row">${seg('text-align', [['left', glyph('align-l', 14), 'Align left'], ['center', glyph('align-c', 14), 'Center'], ['right', glyph('align-r', 14), 'Align right'], ['justify', glyph('align-j', 14), 'Justify']], { is: (val, v) => v === val || (val === 'left' && v === 'start') || (val === 'right' && v === 'end') })}
        <span class="grow"></span>${seg('font-style', [['italic', '<em>I</em>', 'Italic']], { off: 'normal' })}
        ${seg('text-decoration-line', [['underline', glyph('underline', 14), 'Underline'], ['line-through', glyph('strike', 14), 'Strike through']], { off: 'none', is: (val, v) => v.includes(val) })}</div>
      <div class="dzi-row">${seg('text-transform', [['none', '–', 'As written'], ['uppercase', 'AA', 'Uppercase'], ['capitalize', 'Aa', 'Capitalize'], ['lowercase', 'aa', 'Lowercase']], { cls: ' txt grow' })}
        <button type="button" class="dzi-icon txt${ui.moreType ? ' on' : ''}" data-act="more-type">More</button></div>`;
    const more = ['white-space', 'text-wrap', 'text-overflow', 'word-break', 'overflow-wrap', 'text-indent', 'word-spacing', 'text-decoration-color', 'text-decoration-style', 'text-underline-offset', 'text-shadow', 'vertical-align', 'list-style-type'];
    if (ui.moreType) {
      h += row('Wrap', ['white-space', 'text-wrap'], select('white-space', ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']) + select('text-wrap', ['wrap', 'nowrap', 'balance', 'pretty'], { title: 'How lines break' }), 'White space and line breaks')
        + row('Cut off', ['text-overflow'], select('text-overflow', [['clip', 'Clip'], ['ellipsis', 'Ellipsis…']]), 'Text that doesn’t fit (with overflow hidden and no wrap)')
        + row('Break', ['word-break', 'overflow-wrap'], select('word-break', ['normal', 'break-all', 'keep-all']) + select('overflow-wrap', ['normal', 'break-word', 'anywhere'], { title: 'Long words' }), 'Where words may break')
        + row('Indent', ['text-indent', 'word-spacing'], num('text-indent', '⇥', { title: 'First-line indent' }) + num('word-spacing', '␣', { title: 'Word spacing' }))
        + row('Underline', ['text-decoration-style', 'text-decoration-color', 'text-underline-offset'], select('text-decoration-style', ['solid', 'double', 'dotted', 'dashed', 'wavy']) + num('text-underline-offset', '↕', { title: 'Underline offset', auto: true }))
        + row('', ['text-decoration-color'], color('text-decoration-color'))
        + row('Shadow', ['text-shadow'], text('text-shadow', 'none · 0 1px 2px rgba(0,0,0,.3)'))
        + row('Baseline', ['vertical-align'], select('vertical-align', ['baseline', 'top', 'middle', 'bottom', 'text-top', 'text-bottom', 'sub', 'super']), 'Vertical alignment in a line or a table cell')
        + (/^(ul|ol|li)$/.test(s.tag) ? row('Bullets', ['list-style-type'], select('list-style-type', ['disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-roman', 'none'])) : '');
    }
    for (const p of more) reg(p);
    return h;
  }
  function fillSec() {
    const img = cur('background-image');
    let h = row('Color', ['background-color'], color('background-color'))
      + row('Image', ['background-image'], `${text('background-image', 'none · url(…) or a gradient')}<button type="button" class="dzi-icon" data-act="gradient" title="Start a gradient">${glyph('gradient', 14)}</button>`);
    if (img && img !== 'none') {
      h += row('Size', ['background-size'], select('background-size', ['auto', 'cover', 'contain']) + select('background-repeat', ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'], { title: 'Repeat' }))
        + row('Position', ['background-position'], text('background-position', '0% 0% · center · right top'))
        + row('Clip', ['background-clip', 'background-attachment'], select('background-clip', ['border-box', 'padding-box', 'content-box', 'text']) + select('background-attachment', ['scroll', 'fixed', 'local'], { title: 'Scrolls with the page, or stays put' }));
    }
    for (const p of ['background-size', 'background-repeat', 'background-position', 'background-clip', 'background-attachment']) reg(p);
    return h;
  }
  function borderSec() {
    const key = (k) => (borderSide === 'all' ? `border-${k}` : `border-${borderSide}-${k}`);
    const corners = MULTI['border-radius'];
    const split = radiusSplit ?? !corners.every((c) => cur(c) === cur(corners[0]));
    for (const k of ['width', 'style', 'color']) reg(`border-${k}`);
    corners.forEach(reg);
    return `<div class="dzi-row"><span class="dzi-seg txt grow">${[['all', 'All sides'], ['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']].map(([v, l]) => `<button type="button" data-border-side="${v}" class="${borderSide === v ? 'on' : ''}">${l}</button>`).join('')}</span></div>
      <div class="dzi-row">${num(key('width'), 'W', { title: 'Border width' })}${select(key('style'), ['none', 'solid', 'dashed', 'dotted', 'double'], { title: 'Border style' })}</div>
      <div class="dzi-row">${color(key('color'))}</div>
      ${split
        ? `<div class="dzi-row">${corners.map((c, i) => num(c, ['◜', '◝', '◞', '◟'][i], { title: ['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' radius' })).join('')}<button type="button" class="dzi-icon on" data-act="radius-split" title="One radius for all corners">${glyph('corners', 14)}</button></div>`
        : `<div class="dzi-row">${num('border-radius', glyph('radius', 14), { title: 'Corner radius' })}<button type="button" class="dzi-icon" data-act="radius-split" title="Each corner">${glyph('corners', 14)}</button></div>`}
      ${row('Outline', ['outline-width', 'outline-style'], num('outline-width', 'W', { title: 'Outline width' }) + select('outline-style', ['none', 'solid', 'dashed', 'dotted', 'double', 'auto'], { title: 'Outline style' }), 'A line around it that takes no space')}
      ${row('', ['outline-color', 'outline-offset'], color('outline-color') + num('outline-offset', '↔', { title: 'Outline offset', cls: ' sei-gap' }))}`;
  }
  function shadowBlock() {
    reg('box-shadow');
    const v = cur('box-shadow');
    const layers = !v || v === 'none' ? [] : splitTop(v);
    const first = layers.length ? parseShadow(layers[0]) : null;
    const n = (k, label, title) => `<label class="dzi-num" title="${title}"><span class="dzi-l" data-scrub>${label}</span><input type="text" data-shadow="${k}" data-num value="${esc(px(first[k]))}" spellcheck="false" autocomplete="off"></label>`;
    let h = `<div class="sei-row">${lab('Shadow', ['box-shadow'])}<div class="dzi-row">${text('box-shadow', 'none')}<button type="button" class="dzi-icon" data-act="shadow-menu" title="Shadows to start from">${glyph('caret', 12)}</button></div></div>`;
    if (first) {
      h += `<div class="sei-shadow"><div class="dzi-row">${n('x', 'X', 'Across')}${n('y', 'Y', 'Down')}${n('blur', 'Blur', 'Blur')}${n('spread', 'Spr', 'Spread')}</div>
        <div class="dzi-row"><span class="dzi-color"><button type="button" class="dzi-swatch" data-swatch="@shadow" style="--c:${esc(first.color)}" title="Shadow color"></button><input type="text" data-shadow="color" value="${esc(toHex(first.color) || first.color)}" spellcheck="false" autocomplete="off"></span>
          <button type="button" class="dzi-icon txt${first.inset ? ' on' : ''}" data-act="shadow-inset" title="Inside the element">Inner</button></div>
        ${layers.length > 1 ? `<p class="dzi-note">The first of ${layers.length} layers; the box above has them all.</p>` : ''}</div>`;
    }
    return h;
  }
  function effectsSec() {
    for (const p of ['transform-origin']) reg(p);
    return `${row('Opacity', ['opacity'], num('opacity', glyph('opacity', 14), { title: 'Opacity, 0 to 1' }) + select('mix-blend-mode', ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'], { title: 'Blend with what’s behind' }))}
      ${shadowBlock()}
      ${row('Filter', ['filter'], text('filter', 'none · blur(4px) · grayscale(1)'))}
      ${row('Backdrop', ['backdrop-filter'], text('backdrop-filter', 'none · blur(12px)'), 'A filter on what’s behind it')}
      ${row('Transform', ['transform'], text('transform', 'none · rotate(3deg) · scale(1.05)'))}
      ${row('Transition', ['transition'], text('transition', 'all 0.2s ease'), 'How changes (a hover, say) animate')}
      ${row('Cursor', ['cursor'], select('cursor', ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'not-allowed', 'crosshair', 'zoom-in', 'help', 'none']) + select('pointer-events', [['auto', 'Clickable'], ['none', 'Click-through']], { title: 'Pointer events' }))}
      ${row('Visibility', ['visibility'], select('visibility', [['visible', 'Visible'], ['hidden', 'Hidden (keeps its space)']]))}`;
  }
  /** Any property by name, and the changed ones that have no field of their own. */
  function cssSec() {
    const extra = Object.keys(ctx.change?.props || {}).filter((p) => !fielded.has(p));
    return `${extra.map((p) => `<div class="dzi-kv"><input class="mono chg" type="text" value="${esc(p)}" readonly tabindex="-1"><input class="mono" type="text" data-prop="${esc(p)}" value="${esc(chg(p).after)}" list="sei-vars" spellcheck="false" autocomplete="off"><button type="button" class="dzi-icon" data-act="del-prop" data-p="${esc(p)}" title="Take it back">${glyph('minus', 12)}</button></div>`).join('')}
      <form class="dzi-kv" data-addcss><input class="mono" type="text" name="p" placeholder="property" list="sei-props" spellcheck="false" autocomplete="off"><input class="mono" type="text" name="v" placeholder="value" list="sei-vars" spellcheck="false" autocomplete="off"><button type="submit" class="dzi-icon" title="Add it (Enter)">${glyph('plus', 12)}</button></form>
      <p class="dzi-note">Any CSS, one declaration at a time: <code>clip-path</code>, <code>scroll-snap-type</code>, <code>--brand</code>… Paste <code>property: value</code> into the first box.</p>`;
  }
  function rulesSec() {
    if (!ctx.rules) return `<p class="dzi-note">Reading the page’s CSS…</p>`;
    if (!ctx.rules.length) return `<p class="dzi-note">No rule in the page’s CSS matches this element.</p>`;
    return `<p class="dzi-note">What the project’s CSS says about it, strongest first. Click a declaration to change it.</p>${ctx.rules.map((r) => `<div class="sei-rule"><div class="sei-rule-h"><code title="${esc(r.selector)}">${esc(short(r.selector, 64))}</code>${r.media ? `<i>@media ${esc(short(r.media, 40))}</i>` : ''}${r.file || r.url ? `<small title="${esc(r.file || r.url)}">${esc(short((r.file || r.url).split('/').pop(), 28))}${r.line ? ':' + r.line : ''}</small>` : ''}</div>
        ${r.decls.map((d) => `<button type="button" class="sei-decl" data-usedecl="${esc(d.name)}" data-v="${esc(d.value)}"><b>${esc(d.name)}</b>: ${esc(short(d.value, 90))}${d.important ? ' !important' : ''}</button>`).join('')}</div>`).join('')}`;
  }

  /* ----- the element's header ----- */

  function scopeBar() {
    const s = ctx.selected;
    const sc = ctx.scope || {};
    const targets = (s.targets || []).filter((t) => t.count > 1 || t.selector[0] === '.');
    const brk = (m) => (/^max-width: /.test(m) ? `≤ ${m.slice(11)}` : /^min-width: /.test(m) ? `≥ ${m.slice(11)}` : m);
    const medias = [...new Set([...(ctx.breaks || []), sc.media].filter(Boolean))];
    return `<div class="sei-scope${sc.target || sc.state || sc.media ? ' on' : ''}">
      <select class="dzi-select${sc.target ? ' chg' : ''}" data-scope="target" title="What the styles apply to: this element alone, or everything with its class or tag"><option value="">This element</option>${targets.map((t) => `<option value="${esc(t.selector)}"${sc.target === t.selector ? ' selected' : ''}>${esc(short(t.selector, 26))} (${t.count})</option>`).join('')}</select>
      <select class="dzi-select${sc.state ? ' chg' : ''}" data-scope="state" title="Style a state: the page holds the element in it while you do">${STATES.map(([v, l]) => `<option value="${v}"${(sc.state || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <select class="dzi-select${sc.media ? ' chg' : ''}" data-scope="media" title="Style it at some widths only (a media query)"><option value="">All widths</option>${medias.map((m) => `<option value="${esc(m)}"${sc.media === m ? ' selected' : ''}>${esc(brk(m))}</option>`).join('')}<option value="custom">Another width…</option></select>
    </div>`;
  }
  function crumbs() {
    const s = ctx.selected;
    const path = s.path || [];
    const tail = path.slice(-3);
    return `<div class="sei-crumbs">${path.length > tail.length ? `<button type="button" data-act="path" title="Everything it’s inside">…</button><i>›</i>` : ''}${tail.map((p) => `<button type="button" data-goto="${esc(p.selector)}" title="Select ${esc(p.label)}">${esc(short(p.label, 18))}</button><i>›</i>`).join('')}<b>${esc(short(s.label, 22))}</b>${s.childCount ? `<button type="button" class="sei-kids" data-act="children" title="Select something inside it">${s.childCount} inside ${icon('down', 10)}</button>` : ''}</div>`;
  }
  function summary(ch) {
    return `<dl class="dzi-keys">${Object.entries(ch.props || {}).map(([p, v]) => `<dt>${esc(p)}</dt><dd title="${esc(`${v.before || '(none)'} → ${v.after}`)}"><s>${esc(short(v.before, 20))}</s> ${esc(short(v.after, 26))}${ch.origins?.[p] ? `<small title="${esc(originText(ch.origins[p]))}"> · ${esc(originShort(ch.origins[p]))}</small>` : ''}</dd>`).join('')}</dl>`;
  }

  function render() {
    const s = ctx.selected;
    if (s.selector !== lastSel) {
      lastSel = s.selector;
      borderSide = 'all';
      radiusSplit = null;
    }
    fielded = new Set();
    fillLists();
    const ch = ctx.change;
    const tc = ctx.textChange;
    const sc = ctx.scope || {};
    const bodies = { layout: layoutSec(), size: sizeSec(), position: positionSec(), spacing: spacingSec(), type: typeSec(), fill: fillSec(), border: borderSec(), effects: effectsSec() };
    const owned = {};
    // Which section each changed property belongs to, for the dot on its header.
    const before = new Set();
    for (const [id, fn] of [['layout', layoutSec], ['size', sizeSec], ['position', positionSec], ['spacing', spacingSec], ['type', typeSec], ['fill', fillSec], ['border', borderSec], ['effects', effectsSec]]) {
      fielded = new Set();
      fn();
      owned[id] = [...fielded].filter((p) => !before.has(p));
      for (const p of fielded) before.add(p);
    }
    fielded = before;
    bodies.css = cssSec();
    owned.css = Object.keys(ch?.props || {}).filter((p) => !fielded.has(p));
    bodies.rules = isClosed('rules') ? '' : rulesSec();
    const scopeNote = [sc.target && `every <code>${esc(short(sc.target, 30))}</code>`, sc.state && `while <code>:${esc(sc.state)}</code>`, sc.media && `at widths <code>${esc(sc.media.replace('max-width: ', '≤ ').replace('min-width: ', '≥ '))}</code>`].filter(Boolean).join(', ');
    const html = `<div class="se-insp">
      <div class="se-el"><b>${esc(s.label)}</b><small title="${esc(s.selector)}">${esc(short(s.selector, 70))}</small>
        <span class="se-el-size">${Math.round(s.rect.w)} × ${Math.round(s.rect.h)}</span></div>
      ${crumbs()}
      <div class="se-el-actions">
        <button type="button" class="btn small" data-se="designer">${icon('pen', 12)} Edit in Designer</button>
        <button type="button" class="btn small" data-se="comment-here">${icon('pin', 12)} Comment</button>
        <button type="button" class="btn small" data-se="parent" title="Select the parent (↑)">${icon('up', 12)}</button>
        ${ch || tc ? `<button type="button" class="btn small" data-se="revert-sel" title="Take back this element’s changes">${icon('refresh', 12)} Revert</button>` : ''}
      </div>
      ${scopeBar()}
      ${scopeNote ? `<p class="sei-scope-note">Styling ${scopeNote}.</p>` : ''}
      ${s.textKind === 'plain'
        ? `<section class="dzi-sec"><div class="dzi-head">Text</div><div class="dzi-body"><textarea class="se-text" data-text rows="3" spellcheck="true">${esc(tc?.after ?? s.text)}</textarea>
            <p class="dzi-note">Or double-click it on the page (Enter when it’s selected) to edit it in place.</p></div></section>`
        : s.textKind === 'inline'
          ? `<section class="dzi-sec"><div class="dzi-head">Text</div><div class="dzi-body"><p class="se-textprev">${esc(short(tc?.after ?? s.text, 220))}</p>
            <div class="dzi-row"><button type="button" class="btn small" data-se="edit-text">${icon('pen', 12)} Edit text on the page</button></div>
            <p class="dzi-note">It has links or formatting inside, so it’s edited in place to keep them (double-click it, or Enter).</p></div></section>`
          : ''}
      ${SECTIONS.map(([id, name]) => `<section class="dzi-sec collapsible${isClosed(id) ? ' closed' : ''}" data-sec="${id}"><header><h4>${name}${(owned[id] || []).some(chg) ? '<i class="sei-dot" title="Changed here"></i>' : ''}</h4></header><div class="dzi-body">${bodies[id]}</div></section>`).join('')}
      ${ch ? `<section class="dzi-sec"><div class="dzi-head">This element’s changes</div><div class="dzi-body">${summary(ch)}</div></section>` : ''}
    </div>`;
    // Keep the caret where it was: fields are redrawn under the person typing in them.
    const a = document.activeElement;
    let keep = null;
    if (a && host.contains(a) && a.matches('input, select, textarea')) {
      const attr = ['data-prop', 'data-shadow', 'data-cols', 'data-text', 'data-scope', 'data-size', 'name'].find((k) => a.hasAttribute(k));
      if (attr) keep = { q: `${a.tagName.toLowerCase()}[${attr}="${CSS.escape(a.getAttribute(attr))}"]`, value: a.value, dirty: a.tagName !== 'SELECT' && a.value !== a.defaultValue, start: a.selectionStart, end: a.selectionEnd };
    }
    const top = host.scrollTop;
    host.innerHTML = html;
    host.scrollTop = top;
    if (keep) {
      const el = host.querySelector(keep.q);
      if (el) {
        if (keep.dirty) el.value = keep.value;
        el.focus({ preventScroll: true });
        try {
          el.setSelectionRange(keep.start, keep.end);
        } catch {}
      }
    }
  }
  function draw(next) {
    if (next) ctx = next;
    if (!ctx?.selected) return;
    if (busy) {
      waiting = true;
      return;
    }
    render();
  }
  function settle() {
    busy = false;
    if (waiting) {
      waiting = false;
      if (ctx?.selected) render();
    }
  }

  /* ----- reading the fields ----- */

  function commitShadow(patch, live) {
    const layers = splitTop(cur('box-shadow'));
    const first = layers.length ? parseShadow(layers[0]) : null;
    if (!first) return;
    Object.assign(first, patch);
    api.setProps({ 'box-shadow': [shadowCss(first), ...layers.slice(1)].join(', ') }, { live });
  }
  /** A field's value into the change. `shift` / `alt` in the spacing box: all four sides, or the opposite side too. */
  function commit(el, o = {}) {
    if (el.dataset.shadow) {
      const k = el.dataset.shadow;
      const raw = el.value.trim();
      const v = k === 'color' ? toCss('color', raw) : toCss('width', raw);
      if (!raw || (k === 'color' ? !validCss('color', v) : !/^-?\d*\.?\d+px$/.test(v))) return el.classList.add('bad');
      return commitShadow({ [k]: v }, !!o.live);
    }
    if (el.hasAttribute('data-cols')) {
      const n = parseInt(el.value, 10);
      if (!(n > 0 && n <= 24)) return el.classList.add('bad');
      return api.setProps({ 'grid-template-columns': `repeat(${n}, minmax(0, 1fr))` }, { live: !!o.live });
    }
    const prop = el.dataset.prop;
    if (!prop) return;
    let ps = expand(prop);
    if (el.dataset.box && o.shift) ps = SIDES.map((x) => `${el.dataset.box}-${x}`);
    else if (el.dataset.box && o.alt) ps = [prop, `${el.dataset.box}-${OPPOSITE[el.dataset.side]}`];
    const raw = el.value.trim();
    el.classList.remove('bad');
    if (raw === '') return o.live ? null : api.setProps(obj(ps, null)); // emptied: back to what the project has
    const v = toCss(ps[0], raw);
    if (!validCss(ps[0], v)) return el.classList.add('bad');
    const props = obj(ps, v);
    // A border needs a style to show.
    const bw = /^border(-(top|right|bottom|left))?-width$/.exec(prop);
    if (bw && parseFloat(v) > 0) for (const p of ps) if (cur(p.replace('-width', '-style')) === 'none') props[p.replace('-width', '-style')] = 'solid';
    if (/^outline-width$/.test(prop) && parseFloat(v) > 0 && cur('outline-style') === 'none') props['outline-style'] = 'solid';
    api.setProps(props, { live: !!o.live });
  }
  /** A shorthand typed into Custom CSS becomes the properties the fields show, when they cover all of it. */
  function spread(prop, value) {
    if (/^--/.test(prop) || /var\(/.test(value)) return { [prop]: value };
    const probe = document.createElement('i');
    probe.style.setProperty(prop, value);
    const out = {};
    for (const p of probe.style) {
      const v = probe.style.getPropertyValue(p);
      if (!v || v === 'initial' || !(p in st())) return { [prop]: value };
      out[p] = v;
    }
    return Object.keys(out).length ? out : { [prop]: value };
  }

  const numOf = (el) => {
    const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(el.value.trim());
    if (m) return { n: parseFloat(m[1]), unit: m[2] };
    if (el.value.trim()) return null; // auto, var(--x): not a number to nudge
    const p = el.dataset.prop ? expand(el.dataset.prop)[0] : '';
    const c = /^(-?\d*\.?\d+)(px)?$/.exec(p ? st()[p] || '' : '');
    return { n: c ? parseFloat(c[1]) : 0, unit: '' };
  };
  const stepOf = (key, s) => (/^(rem|em)$/.test(s.unit) ? 0.1 : key === 'opacity' ? 0.01 : key === 'line-height' && !s.unit && s.n <= 4 ? 0.05 : key === 'letter-spacing' ? 0.1 : key === 'aspect-ratio' ? 0.1 : 1);
  const nudge = (el, s, by) => {
    const key = el.dataset.prop || el.dataset.shadow || '';
    let n = Math.round((s.n + by) * 1000) / 1000;
    if (!NEGATIVE.test(key) && !/^(x|y|spread)$/.test(key)) n = Math.max(0, n);
    if (key === 'opacity') n = Math.min(1, n);
    if (/^(z-index|order|font-weight)$/.test(key) || el.hasAttribute('data-cols')) n = Math.round(n);
    el.value = `${n}${s.unit === 'px' ? '' : s.unit}`;
  };

  /* ----- events ----- */

  // Drag a label (or a number in the spacing box) to change its value.
  host.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-scrub]');
    if (!h || e.button !== 0 || !ctx?.selected) return;
    const input = h.matches('input') ? h : h.parentElement.querySelector('input');
    if (!input || (h === input && document.activeElement === input)) return;
    if (e.altKey && h !== input) return; // Alt-click a label takes the change back
    const start = numOf(input);
    if (!start) return;
    const box = !!input.dataset.box;
    const step = stepOf(input.dataset.prop || input.dataset.shadow || '', start);
    const x0 = e.clientX;
    let dragged = false;
    let mods = {};
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!dragged && Math.abs(dx) < 3) return;
      if (!dragged) {
        dragged = true;
        busy = true;
        host.classList.add('sei-scrubbing');
      }
      mods = box ? { shift: ev.shiftKey, alt: ev.altKey } : {};
      nudge(input, start, Math.round(dx / 2) * step * (box ? 1 : ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1));
      commit(input, { live: true, ...mods });
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      host.classList.remove('sei-scrubbing');
      if (!dragged) {
        if (h === input) {
          input.focus();
          input.select();
        }
        return;
      }
      commit(input, mods);
      settle();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });

  host.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t.matches?.('input') || !host.contains(t) || !ctx?.selected) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && t.hasAttribute('data-num')) {
      const s = numOf(t);
      if (!s) return;
      e.preventDefault();
      nudge(t, s, (e.key === 'ArrowUp' ? 1 : -1) * stepOf(t.dataset.prop || t.dataset.shadow || '', s) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1));
      commit(t, { live: true });
    } else if (e.key === 'Enter' && (t.dataset.prop || t.dataset.shadow || t.hasAttribute('data-cols'))) {
      e.preventDefault();
      t.defaultValue = t.value; // committed here: leaving the field doesn't commit it again
      commit(t, t.dataset.box ? { shift: e.shiftKey, alt: e.altKey } : {});
    } else if (e.key === 'Escape' && t.dataset.prop) {
      t.value = t.defaultValue;
      t.blur();
    }
  });
  host.addEventListener('change', (e) => {
    const t = e.target;
    if (!ctx?.selected) return;
    if (t.matches('[data-scope]')) return api.setScope({ [t.dataset.scope]: t.value });
    if (t.matches('[data-size]')) return setSize(t.dataset.size, t.value);
    if (t.matches('[data-prop], [data-shadow], [data-cols]')) return commit(t);
  });
  host.addEventListener('submit', (e) => {
    const f = e.target;
    if (!f.matches('[data-addcss]') || !ctx?.selected) return;
    e.preventDefault();
    let p = f.elements.p.value.trim();
    let v = f.elements.v.value.trim().replace(/;$/, '');
    const pasted = /^([^:]+):\s*(.+?);?$/.exec(p);
    if (pasted && !v) [, p, v] = pasted;
    p = /^--/.test(p) ? p.trim() : p.trim().toLowerCase();
    f.elements.p.classList.toggle('bad', !/^-?-?[a-z][a-z0-9-]*$/i.test(p));
    f.elements.v.classList.toggle('bad', !!p && (!v || !validCss(p, v)));
    if (f.querySelector('.bad')) return;
    api.setProps(spread(p, v));
  });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (!ctx?.selected || !host.contains(t)) return;
    const reset = t.closest('[data-reset]');
    if (reset && e.altKey) {
      e.preventDefault();
      return api.setProps(obj(reset.dataset.reset.split(' ').filter(Boolean), null));
    }
    const head = t.closest('.dzi-sec.collapsible > header');
    if (head && !t.closest('button, select, input')) {
      const sec = head.parentElement;
      const id = sec.dataset.sec;
      ui.closed[id] = !isClosed(id);
      saveUi();
      if (id === 'rules' && !ui.closed[id]) {
        if (!ctx.rules) api.wantRules();
        return draw();
      }
      return sec.classList.toggle('closed', ui.closed[id]);
    }
    const sw = t.closest('[data-swatch]');
    if (sw) {
      const key = sw.dataset.swatch;
      const input = sw.parentElement.querySelector('input');
      const r = sw.getBoundingClientRect();
      const set = (v, live) => (key === '@shadow' ? commitShadow({ color: v }, live) : api.setProps(obj(expand(key), v), { live }));
      const from = key === '@shadow' ? parseShadow(splitTop(cur('box-shadow'))[0] || '')?.color : st()[expand(key)[0]];
      let picked = null;
      pickColor(r.left, r.bottom + 6, {
        value: toHex(from) || '#000000',
        title: key === 'color' ? 'Text color' : key === 'background-color' ? 'Background' : key === '@shadow' ? 'Shadow color' : /^border/.test(key) ? 'Border color' : 'Color',
        onChange: (v) => {
          picked = v;
          busy = true;
          input.value = v;
          sw.style.setProperty('--c', v);
          set(v, true);
        },
        onDone: () => {
          if (picked != null) set(picked, false);
          settle();
        },
      });
      return;
    }
    const sg = t.closest('[data-seg] [data-val]');
    if (sg) {
      const box = sg.closest('[data-seg]');
      const v = sg.classList.contains('on') && box.dataset.off != null ? box.dataset.off : sg.dataset.val;
      return api.setProps(obj(expand(box.dataset.seg), v));
    }
    const cell = t.closest('[data-cell]');
    if (cell) {
      const [j, a] = cell.dataset.cell.split('|');
      const spaced = /^space-/.test(cur('justify-content'));
      return api.setProps({ ...(spaced ? {} : { 'justify-content': j }), 'align-items': a });
    }
    const side = t.closest('[data-border-side]');
    if (side) {
      borderSide = side.dataset.borderSide;
      return draw();
    }
    const go = t.closest('[data-goto]');
    if (go) return api.select(go.dataset.goto);
    const use = t.closest('[data-usedecl]');
    if (use) {
      ui.closed.css = false;
      saveUi();
      draw();
      const f = host.querySelector('[data-addcss]');
      f.elements.p.value = use.dataset.usedecl;
      f.elements.v.value = use.dataset.v;
      f.scrollIntoView({ block: 'center' });
      f.elements.v.focus();
      f.elements.v.select();
      return;
    }
    const btn = t.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    const s = ctx.selected;
    if (act === 'autolayout') return api.setProps({ display: /^inline/.test(cur('display')) ? 'inline-flex' : 'flex', 'flex-direction': s.flow === 'row' ? 'row' : 'column', ...(s.flow === 'row' ? { 'align-items': 'baseline' } : {}) });
    if (act === 'reverse') {
      const dir = cur('flex-direction');
      return api.setProps({ 'flex-direction': /reverse/.test(dir) ? dir.replace('-reverse', '') : `${dir}-reverse` });
    }
    if (act === 'wrap') return api.setProps({ 'flex-wrap': cur('flex-wrap') === 'nowrap' ? 'wrap' : 'nowrap' });
    if (act === 'gap-auto') return api.setProps({ 'justify-content': /^space-/.test(cur('justify-content')) ? 'flex-start' : 'space-between' });
    if (act === 'inset-0') return api.setProps(obj(SIDES, '0px'));
    if (act === 'radius-split') {
      const corners = MULTI['border-radius'];
      radiusSplit = !(radiusSplit ?? !corners.every((c) => cur(c) === cur(corners[0])));
      return draw();
    }
    if (act === 'more-type') {
      ui.moreType = !ui.moreType;
      saveUi();
      return draw();
    }
    if (act === 'gradient') {
      const c = st()['background-color'];
      return api.setProps({ 'background-image': `linear-gradient(180deg, ${transparent(c) || !c ? '#ffffff' : toHex(c) || c}, ${transparent(c) || !c ? '#e6e8ee' : 'rgba(0, 0, 0, 0.25)'})` });
    }
    if (act === 'shadow-inset') {
      const first = parseShadow(splitTop(cur('box-shadow'))[0] || '');
      return first && commitShadow({ inset: !first.inset }, false);
    }
    if (act === 'del-prop') return api.setProps({ [btn.dataset.p]: null });
    const r = btn.getBoundingClientRect();
    if (act === 'shadow-menu') {
      return showMenu(r.left, r.bottom + 4, [...SHADOWS.map(([label, v]) => ({ label, act: () => api.setProps({ 'box-shadow': v }) })), '-', { label: 'No Shadow', act: () => api.setProps({ 'box-shadow': 'none' }) }]);
    }
    if (act === 'children') {
      return showMenu(r.left, r.bottom + 4, [...s.children.map((c) => ({ label: `${short(c.label, 30)}${c.text ? `  “${short(c.text, 22)}”` : ''}`, act: () => api.select(c.selector) })), ...(s.childCount > s.children.length ? [{ label: `and ${s.childCount - s.children.length} more: click one on the page`, disabled: true }] : [])]);
    }
    if (act === 'path') return showMenu(r.left, r.bottom + 4, (s.path || []).map((p) => ({ label: short(p.label, 40), act: () => api.select(p.selector) })));
  });

  // Hovering the spacing box or the gap shows it on the page.
  const hint = (key) => {
    if (key === hinted) return;
    hinted = key;
    const [kind, side] = key.split(':');
    api.hint(kind || null, side || 'all');
  };
  host.addEventListener('pointerover', (e) => ctx?.selected && !busy && hint(e.target.closest?.('[data-hint]')?.dataset.hint || ''));
  host.addEventListener('pointerleave', () => !busy && hint(''));
  host.addEventListener('focusin', (e) => e.target.dataset?.hint && hint(e.target.dataset.hint));
  host.addEventListener('focusout', (e) => e.target.dataset?.hint && hint(''));

  return {
    draw,
    /** The selection went away: no bands left on the page. */
    clear() {
      ctx = null;
      hinted = '';
      busy = false;
      waiting = false;
    },
    destroy: () => lists.remove(),
  };
}
