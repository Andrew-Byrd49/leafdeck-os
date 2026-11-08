// Graphic Designer's panels: Layers and Artboards (left), Properties (right): transform (with a reference point), the
// shape's own settings, appearance, fill and stroke (solid colors and gradients, arrowheads), type, effects, picture
// adjustments, align, pathfinder, path tools, swatches and the document's colors, the document's units, grid and guides.
// Lengths show in the document's units (px, pt, in, mm, cm); typing a unit after a number converts it.
// Styles reuse Designer's (.dzl-*, .dzi-*), plus graphic.css.
import { esc } from '../util.js';
import { pickColor } from '../colorpicker.js';
import { showMenu } from '../wm.js';
import { icon } from '../icons.js';
import { glyph } from '../designer/glyphs.js';
import { evalNum } from '../designer/inspector.js';
import * as D from './doc.js';
import * as G from './geom.js';

const MIXED = Symbol('mixed');
const round = (v) => Math.round(v * 100) / 100;
const FONTS = ['Inter', 'system-ui', 'Helvetica Neue', 'Arial', 'Roboto', 'Segoe UI', 'Georgia', 'Times New Roman', 'Garamond', 'Playfair Display', 'Futura', 'Impact', 'Menlo', 'Courier New'];
const WEIGHTS = [[100, 'Thin'], [200, 'Extra Light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']];
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
const title = (s) => s.replace(/(^|-)(\w)/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase());
export const BOARD_PRESETS = [
  ['Letter', 816, 1056],
  ['Letter (landscape)', 1056, 816],
  ['A4', 794, 1123],
  ['A4 (landscape)', 1123, 794],
  ['Square post', 1080, 1080],
  ['Portrait post', 1080, 1350],
  ['Story', 1080, 1920],
  ['HD 1920 × 1080', 1920, 1080],
  ['Business card', 336, 192],
  ['Poster 18 × 24', 1728, 2304],
  ['Icon 512', 512, 512],
  ['Logo 1000', 1000, 1000],
];

/* ---------------- colors: '#rrggbb' or '#rrggbbaa' ---------------- */

export function splitColor(c) {
  const s = String(c || '#000000');
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (!m) return { hex: D.rgbToHex(s).slice(0, 7), a: 1 };
  return { hex: '#' + m[1].toLowerCase(), a: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) / 100 : 1 };
}
export const joinColor = (hex, a = 1) => (a >= 1 ? hex : hex + Math.round(Math.max(0, a) * 255).toString(16).padStart(2, '0'));

/* ================= Layers and Artboards ================= */

export function createLayers(host, ed) {
  let tab = 'layers';
  const open = new Set();
  let renaming = null;

  function render() {
    if (renaming || !ed.doc) return;
    host.innerHTML = `<div class="gx-ltabs"><button type="button" data-ltab="layers" class="${tab === 'layers' ? 'on' : ''}">Layers</button><button type="button" data-ltab="boards" class="${tab === 'boards' ? 'on' : ''}">Artboards <small>${ed.doc.artboards.length}</small></button><span class="grow"></span>${tab === 'boards' ? `<button type="button" class="dzi-icon" data-add-board title="New artboard">${glyph('plus', 14)}</button>` : ''}</div>
      <div class="gx-lbody">${tab === 'layers' ? layersHtml() : boardsHtml()}</div>`;
  }
  // Groups you're inside or that hold the selection open by themselves.
  function autoOpen() {
    for (const id of [...ed.sel, ed.scope].filter(Boolean)) {
      let p = ed.parentOf(id);
      while (p?.parent) {
        open.add(p.parent.id);
        p = ed.parentOf(p.parent.id);
      }
    }
  }
  function layersHtml() {
    if (!ed.doc.nodes.length) return `<p class="dzl-empty">Draw something: <kbd>P</kbd> pen, <kbd>M</kbd> rectangle, <kbd>L</kbd> ellipse, <kbd>T</kbd> type. Or drop an SVG or image here.</p>`;
    autoOpen();
    let out = '';
    const row = (n, d, dim) => {
      const isOpen = open.has(n.id);
      const icon = n.type === 'group' ? (n.clip ? 'clip' : 'group') : n.type === 'path' ? 'svg' : n.type === 'polygon' ? 'polygon' : n.type === 'star' ? 'star' : n.type;
      const cls = ['dzl-row', ed.sel.includes(n.id) ? 'on' : '', dim || n.hidden ? 'dim' : '', ed.scope === n.id ? 'scope' : ''].filter(Boolean).join(' ');
      out += `<div class="${cls}" style="--d:${d}" data-lid="${n.id}" draggable="true">
        ${n.type === 'group' ? `<button type="button" class="dzl-caret${isOpen ? ' open' : ''}" data-caret>${glyph('caret', 12)}</button>` : '<span class="dzl-caret"></span>'}
        <span class="dzl-ic">${glyph(icon, 14)}</span>${n.type !== 'group' && n.type !== 'image' && n.type !== 'text' ? `<span class="gx-lchip" style="--c:${esc(D.paintCss(n.fill || n.stroke))}"></span>` : ''}
        <span class="dzl-name">${esc(n.name)}</span>
        <span class="dzl-tools${n.hidden || n.locked ? ' keep' : ''}"><button type="button" data-lock class="${n.locked ? 'set' : ''}" title="${n.locked ? 'Unlock' : 'Lock'}">${glyph(n.locked ? 'lock' : 'unlock', 14)}</button><button type="button" data-eye class="${n.hidden ? 'set' : ''}" title="${n.hidden ? 'Show' : 'Hide'}">${glyph(n.hidden ? 'eye-off' : 'eye', 14)}</button></span>
      </div>`;
      if (n.type === 'group' && isOpen) for (const c of n.children.slice().reverse()) row(c, d + 1, dim || n.hidden);
    };
    for (const n of ed.doc.nodes.slice().reverse()) row(n, 0, false);
    return out;
  }
  function boardsHtml() {
    return ed.doc.artboards
      .map((b, i) => `<div class="dzl-row gx-brow${ed.board === b.id ? ' on' : ''}" style="--d:0" data-bid="${b.id}"><span class="gx-bnum">${i + 1}</span><span class="dzl-name">${esc(b.name)}</span><small class="gx-bsize">${round(b.w)} × ${round(b.h)}</small></div>`)
      .join('');
  }

  host.addEventListener('click', (e) => {
    const lt = e.target.closest('[data-ltab]');
    if (lt) {
      tab = lt.dataset.ltab;
      if (tab === 'boards') ed.setTool('artboard');
      else if (ed.tool === 'artboard') ed.setTool('select');
      return render();
    }
    if (e.target.closest('[data-add-board]')) {
      ed.addBoard();
      return ed.fit();
    }
    const brow = e.target.closest('[data-bid]');
    if (brow) {
      ed.setTool('artboard');
      ed.board = brow.dataset.bid;
      ed.sel = [];
      ed.fit();
      return ed.commit();
    }
    const r = e.target.closest('[data-lid]');
    if (!r) return;
    const id = r.dataset.lid;
    const n = ed.node(id);
    if (e.target.closest('[data-caret]')) {
      open.has(id) ? open.delete(id) : open.add(id);
      return render();
    }
    if (e.target.closest('[data-eye]') || e.target.closest('[data-lock]')) {
      ed.checkpoint();
      const k = e.target.closest('[data-eye]') ? 'hidden' : 'locked';
      n[k] = !n[k];
      if (n[k]) ed.sel = ed.sel.filter((x) => x !== id);
      return ed.commit();
    }
    if (ed.tool === 'artboard') ed.setTool('select');
    // A layer inside a group: work inside that group.
    const p = ed.parentOf(id);
    ed.scope = p?.parent ? p.parent.id : null;
    if (e.shiftKey || e.ctrlKey || e.metaKey) ed.select(ed.sel.includes(id) ? ed.sel.filter((x) => x !== id) : [...ed.sel, id]);
    else ed.select([id]);
    ed.viewport.focus({ preventScroll: true });
  });
  host.addEventListener('dblclick', (e) => {
    const r = e.target.closest('[data-lid], [data-bid]');
    if (!r || e.target.closest('button')) return;
    const nameEl = r.querySelector('.dzl-name');
    const isBoard = !!r.dataset.bid;
    const obj = isBoard ? ed.boardById(r.dataset.bid) : ed.node(r.dataset.lid);
    if (!obj) return;
    renaming = obj;
    const input = document.createElement('input');
    input.className = 'dzl-rename';
    input.value = obj.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (renaming !== obj) return;
      renaming = null;
      const v = input.value.trim();
      if (save && v && v !== obj.name) {
        ed.checkpoint();
        obj.name = v;
        ed.commit();
      } else render();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') done(true);
      if (ev.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  });
  host.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('[data-lid], [data-bid]');
    if (!r) return;
    e.preventDefault();
    if (r.dataset.bid) {
      const id = r.dataset.bid;
      return showMenu(e.clientX, e.clientY, [
        { label: 'Fit to Artwork', act: () => ed.boardFitArt(id) },
        { label: 'Duplicate', act: () => duplicateBoard(id) },
        '-',
        { label: 'Delete Artboard', act: () => ed.deleteBoard(id), disabled: ed.doc.artboards.length < 2 },
      ]);
    }
    if (!ed.sel.includes(r.dataset.lid)) ed.select([r.dataset.lid]);
    objectMenu(e.clientX, e.clientY, ed);
  });
  function duplicateBoard(id) {
    const b = ed.boardById(id);
    const nb = ed.addBoard({ name: b.name + ' copy', w: b.w, h: b.h, bg: b.bg });
    // Its artwork comes along.
    const inside = ed.doc.nodes.filter((n) => G.contains(G.rectBox(b), D.bounds(n)));
    ed.doc.nodes.push(...inside.map((n) => D.transform(D.cloneFresh(n), G.translate(nb.x - b.x, nb.y - b.y))));
    ed.commit();
  }

  /* ----- drag to reorder (and into groups) ----- */
  let dragId = null;
  host.addEventListener('dragstart', (e) => {
    const r = e.target.closest('[data-lid]');
    if (!r) return;
    dragId = r.dataset.lid;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  const clearDrop = () => host.querySelectorAll('.drop-above, .drop-below, .drop-inside').forEach((x) => x.classList.remove('drop-above', 'drop-below', 'drop-inside'));
  const dropPos = (e, r) => {
    const b = r.getBoundingClientRect();
    const y = (e.clientY - b.top) / b.height;
    const n = ed.node(r.dataset.lid);
    if (n?.type === 'group' && y > 0.3 && y < 0.7) return 'inside';
    return y < 0.5 ? 'above' : 'below';
  };
  host.addEventListener('dragover', (e) => {
    const r = e.target.closest('[data-lid]');
    if (!dragId || !r || r.dataset.lid === dragId) return;
    e.preventDefault();
    clearDrop();
    r.classList.add('drop-' + dropPos(e, r));
  });
  host.addEventListener('dragleave', (e) => !host.contains(e.relatedTarget) && clearDrop());
  host.addEventListener('drop', (e) => {
    const r = e.target.closest('[data-lid]');
    clearDrop();
    if (!dragId || !r) return;
    e.preventDefault();
    const target = r.dataset.lid;
    const pos = dropPos(e, r);
    const moving = ed.node(dragId);
    if (!moving || D.find([moving], target)) return (dragId = null);
    ed.checkpoint();
    const from = ed.parentOf(dragId);
    from.list.splice(from.index, 1);
    if (pos === 'inside') {
      ed.node(target).children.push(moving);
      open.add(target);
    } else {
      const to = ed.parentOf(target);
      // The list shows top first: "above" means later in paint order.
      to.list.splice(pos === 'above' ? to.index + 1 : to.index, 0, moving);
    }
    dragId = null;
    ed.sel = [moving.id];
    ed.commit();
  });
  host.addEventListener('dragend', () => {
    dragId = null;
    clearDrop();
  });

  ed.on('change', render);
  ed.on('select', render);
  ed.on('scope', render);
  render();
  return { render, showBoards: () => ((tab = 'boards'), render()) };
}

/** The right-click menu for selected objects (canvas and Layers). */
export function objectMenu(x, y, ed) {
  const sel = ed.selected();
  const one = sel.length === 1 ? sel[0] : null;
  const paths = sel.filter((n) => n.type === 'path');
  showMenu(x, y, [
    { label: 'Cut', key: 'Ctrl+X', act: () => ed.cut(), disabled: !sel.length },
    { label: 'Copy', key: 'Ctrl+C', act: () => ed.copy(), disabled: !sel.length },
    { label: 'Paste', key: 'Ctrl+V', act: () => ed.paste() },
    { label: 'Duplicate', key: 'Ctrl+D', act: () => ed.duplicate(), disabled: !sel.length },
    { label: 'Delete', key: 'Del', act: () => ed.deleteSelection(), disabled: !sel.length },
    '-',
    { label: 'Group', key: 'Ctrl+G', act: () => ed.group(), disabled: !sel.length },
    { label: 'Ungroup', key: 'Ctrl+Shift+G', act: () => ed.ungroup(), disabled: !sel.some((n) => n.type === 'group') },
    '-',
    { header: 'Arrange' },
    { label: 'Bring to Front', key: 'Ctrl+Shift+]', act: () => ed.arrange('front'), disabled: !sel.length },
    { label: 'Bring Forward', key: 'Ctrl+]', act: () => ed.arrange('forward'), disabled: !sel.length },
    { label: 'Send Backward', key: 'Ctrl+[', act: () => ed.arrange('backward'), disabled: !sel.length },
    { label: 'Send to Back', key: 'Ctrl+Shift+[', act: () => ed.arrange('back'), disabled: !sel.length },
    '-',
    { label: 'Make Clipping Mask', key: 'Ctrl+7', act: () => ed.clip(), disabled: sel.length < 2 },
    { label: 'Release Clipping Mask', key: 'Ctrl+Alt+7', act: () => ed.releaseClip(), disabled: !sel.some((n) => n.clip) },
    { label: 'Make Compound Path', key: 'Ctrl+8', act: () => ed.compound(), disabled: sel.length < 2 },
    { label: 'Release Compound Path', act: () => ed.releaseCompound(), disabled: !paths.some((n) => n.subpaths.length > 1) },
    { label: 'Convert to Path', act: () => ed.expand(), disabled: !sel.some((n) => D.SHAPES.includes(n.type)) },
    { label: 'Outline Stroke', act: () => ed.outlineStroke(), disabled: !sel.some((n) => n.stroke && n.sw) },
    '-',
    { label: 'Crop Picture', act: () => ed.cropImage(), disabled: !sel.some((n) => n.type === 'image') },
    '-',
    { header: 'Select' },
    { label: 'Same Fill Color', act: () => ed.selectSame('fill'), disabled: !sel.length },
    { label: 'Same Stroke', act: () => ed.selectSame('stroke'), disabled: !sel.length },
    { label: 'Same Kind of Object', act: () => ed.selectSame('type'), disabled: !sel.length },
    { label: 'All on This Artboard', act: () => ed.selectAllOnBoard() },
    '-',
    { label: 'Flip Horizontal', act: () => ed.flip('h'), disabled: !sel.length },
    { label: 'Flip Vertical', act: () => ed.flip('v'), disabled: !sel.length },
    { label: 'Rotate 90° Clockwise', act: () => ed.rotate(90), disabled: !sel.length },
    '-',
    { label: one?.locked ? 'Unlock' : 'Lock', key: 'Ctrl+2', act: () => ed.setFlag('locked', !one?.locked), disabled: !sel.length },
    { label: 'Hide', key: 'Ctrl+3', act: () => ed.setFlag('hidden', true), disabled: !sel.length },
    { label: 'Unlock All', key: 'Ctrl+Alt+2', act: () => ed.unlockAll() },
    { label: 'Show All', key: 'Ctrl+Alt+3', act: () => ed.showAll() },
  ]);
}

/* ================= Properties ================= */

export function createInspector(panel, ed, opts = {}) {
  let ctl = new Map();
  let seq = 0;
  let quiet = false;
  let lockRatio = false;
  let alignTo = 'selection';
  let refPt = 4; // the Transform fields' reference point: 0..8, top left to bottom right, 4 the middle
  let stopSel = { fill: 0, stroke: 0 };
  let cornersOpen = false; // the rectangle's four radii shown separately
  const collapsed = new Set(JSON.parse(localStorage.getItem('graphic:collapsed') || '[]'));
  const reg = (o) => {
    const k = 'k' + ++seq;
    ctl.set(k, o);
    return k;
  };
  const sel = () => ed.selected();
  /** The objects style changes go to: through groups to what's in them. */
  const styled = () => sel().flatMap(function leaves(n) {
    return n.type === 'group' ? (n.clip ? n.children.slice(0, -1) : n.children).flatMap(leaves) : [n];
  });
  const same = (list, get) => {
    if (!list.length) return undefined;
    const vals = list.map(get);
    return vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])) ? vals[0] : MIXED;
  };

  /** Change objects; `key` merges quick repeats (typing, scrubbing) into one undo step. */
  function apply(list, fn, key = null) {
    ed.checkpoint(key);
    list.forEach(fn);
    quiet = true;
    ed.commit({ quiet: true });
    quiet = false;
  }

  /* ----- controls ----- */
  /** A number field. o.unit: a length, shown in the document's units (the value itself stays in pixels). */
  function num(label, get, set, o = {}) {
    const list = o.list || styled();
    const v = o.value !== undefined ? o.value : same(list, get);
    const unit = o.unit && ed.unit() !== 'px' ? ed.unit() : null;
    const scale = o.scale || (unit ? 1 / ed.unitPx() : 1);
    const step = o.step || (unit ? (unit === 'in' ? 0.05 : unit === 'cm' ? 0.1 : 1) : 1);
    const k = reg({ type: 'num', get, set, list, step, dstep: unit ? step : step < 1 ? step * scale : step, min: o.min ?? -Infinity, max: o.max ?? Infinity, scale, unit: !!o.unit, key: o.key || label, custom: o.custom });
    const shown = v === MIXED || v == null ? '' : unit ? ed.toUnit(v, 3) : round(v * scale);
    return `<label class="dzi-num${o.cls ? ' ' + o.cls : ''}" title="${esc(o.title || label)}${unit ? ` (${unit})` : ''}"><span class="dzi-l" data-scrub="${k}">${o.icon ? glyph(o.icon, 14) : esc(label)}</span><input data-k="${k}" value="${esc(shown)}" placeholder="${v === MIXED ? 'Mixed' : ''}" inputmode="decimal" spellcheck="false">${o.suffix ? `<i data-scrub="${k}">${o.suffix}</i>` : unit ? `<i data-scrub="${k}" class="unit">${unit}</i>` : ''}</label>`;
  }
  /** A slider with its number: adjustments and the like. */
  function slider(label, get, set, o = {}) {
    const list = o.list || styled();
    const v = o.value !== undefined ? o.value : same(list, get);
    const k = reg({ type: 'num', get, set, list, step: o.step || 1, dstep: (o.step || 1) < 1 ? (o.step || 1) * (o.scale || 1) : o.step || 1, min: o.min ?? 0, max: o.max ?? 100, scale: o.scale || 1, key: o.key || label, custom: o.custom });
    const shown = v === MIXED || v == null ? '' : round(v * (o.scale || 1));
    return `<label class="gx-slider" title="${esc(o.title || label)}"><span>${esc(label)}</span><input type="range" data-k="${k}" data-range min="${(o.min ?? 0) * (o.scale || 1)}" max="${(o.max ?? 100) * (o.scale || 1)}" step="${o.rangeStep || 1}" value="${v === MIXED || v == null ? (o.def ?? 0) * (o.scale || 1) : shown}"><input data-k="${k}" value="${esc(shown)}" inputmode="decimal" spellcheck="false" class="gx-slider-n">${o.suffix ? `<i>${o.suffix}</i>` : ''}</label>`;
  }
  function select(get, set, options, o = {}) {
    const list = o.list || styled();
    const v = o.value !== undefined ? o.value : same(list, get);
    const k = reg({ type: 'select', set, list, key: o.key, custom: o.custom });
    return `<select class="dzi-select${o.cls ? ' ' + o.cls : ''}" data-k="${k}" title="${esc(o.title || '')}">${v === MIXED ? '<option value="" selected disabled>Mixed</option>' : ''}${options.map(([val, label]) => `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  }
  function seg(get, set, options, o = {}) {
    const list = o.list || styled();
    const v = o.value !== undefined ? o.value : same(list, get);
    const k = reg({ type: 'seg', set, list, custom: o.custom });
    return `<div class="dzi-seg${o.cls ? ' ' + o.cls : ''}" data-k="${k}">${options.map(([val, label, tip]) => `<button type="button" data-v="${esc(val)}" class="${String(val) === String(v) ? 'on' : ''}" title="${esc(tip || '')}">${label}</button>`).join('')}</div>`;
  }
  /** A color field: swatch (opens the picker), hex, opacity. */
  function color(value, set, o = {}) {
    const c = value === MIXED || !value ? { hex: '#000000', a: 1 } : splitColor(value);
    const k = reg({ type: 'color', set, value, key: o.key || 'color' });
    return `<div class="dzi-color" data-k="${k}"><button type="button" class="dzi-swatch" data-swatch style="--c:${esc(value === MIXED ? 'transparent' : value || 'transparent')}"></button><input data-hex value="${value === MIXED ? '' : c.hex.slice(1).toUpperCase()}" placeholder="${value === MIXED ? 'Mixed' : ''}" spellcheck="false"><input data-alpha value="${value === MIXED ? '' : Math.round(c.a * 100)}" inputmode="decimal"><i>%</i></div>`;
  }
  const btn = (act, icon, tip, o = {}) => `<button type="button" class="dzi-icon${o.on ? ' on' : ''}" data-act="${act}" title="${esc(tip)}"${o.disabled ? ' disabled' : ''}>${glyph(icon, 16)}${o.label ? `<span>${esc(o.label)}</span>` : ''}</button>`;
  const section = (id, label, body, o = {}) => `<section class="dzi-sec collapsible${collapsed.has(id) ? ' closed' : ''}" data-sec="${id}"><header data-collapse="${id}"><h4>${esc(label)}</h4><span class="grow"></span>${o.tools || ''}</header><div class="dzi-body">${body}</div></section>`;

  /* ----- a paint (fill or stroke) ----- */
  function paintEditor(which) {
    const list = styled().filter((n) => n.type !== 'image' || which === 'stroke');
    const target = list.length ? list : null;
    const v = target ? same(target, (n) => n[which] ?? null) : ed.style[which];
    const setPaint = (p, key) => {
      if (target) {
        apply(target, (n) => {
          n[which] = p == null ? null : structuredClone(p);
          if (which === 'stroke' && p && !n.sw) n.sw = 1;
        }, key);
        ed.rememberStyle(target[0]);
      } else {
        ed.style[which] = p == null ? null : structuredClone(p);
        if (which === 'stroke' && p && !ed.style.sw) ed.style.sw = 1;
      }
      render();
    };
    const kind = v === MIXED ? 'mixed' : v ? v.type : 'none';
    const k = reg({ type: 'paint', which, set: setPaint, value: v });
    let body = `<div class="dzi-row">${seg(
      () => kind,
      () => {},
      [
        ['none', glyph('none', 14), 'None'],
        ['solid', '<span class="gx-kind solid"></span>', 'Color'],
        ['linear', '<span class="gx-kind linear"></span>', 'Linear gradient'],
        ['radial', '<span class="gx-kind radial"></span>', 'Radial gradient'],
      ],
      { value: kind, custom: (val) => setPaint(convertPaint(v === MIXED ? null : v, val, which)) },
    )}<span class="grow"></span>${which === 'fill' && target ? `<button type="button" class="dzi-icon" data-act="swap" title="Swap fill and stroke (Shift+X)">${glyph('swap', 14)}</button>` : ''}</div>`;
    if (kind === 'solid') body += `<div class="dzi-row">${color(v.color, (c, key) => setPaint({ ...v, color: c }, key), { key: which + '-color' })}</div>`;
    if (kind === 'mixed') body += `<div class="dzi-row"><span class="gx-muted">Mixed</span></div>`;
    if (kind === 'linear' || kind === 'radial') {
      const si = Math.min(stopSel[which], v.stops.length - 1);
      const st = v.stops[si];
      body += `<div class="gx-grad" data-grad="${k}" style="--g:linear-gradient(90deg, ${v.stops.map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})">${v.stops.map((s, i) => `<button type="button" class="gx-stop${i === si ? ' on' : ''}" data-stop="${i}" style="left:${s.pos * 100}%;--c:${esc(s.color)}" title="Drag to move, double-click to remove"></button>`).join('')}</div>
        <div class="dzi-row">${color(st.color, (c, key) => setPaint({ ...v, stops: v.stops.map((s, i) => (i === si ? { ...s, color: c } : s)) }, key), { key: which + '-stop' })}${num('', () => st.pos, (val) => setPaint({ ...v, stops: v.stops.map((s, i) => (i === si ? { ...s, pos: Math.max(0, Math.min(1, val)) } : s)) }, which + '-pos'), { value: st.pos, scale: 100, suffix: '%', custom: true, cls: 'narrow', title: 'Stop position', icon: 'gap' })}${v.stops.length > 2 ? `<button type="button" class="dzi-icon" data-stop-del="${k}" data-i="${si}" title="Remove this color stop">${glyph('minus', 14)}</button>` : ''}</div>
        <div class="dzi-row">${kind === 'linear' ? num('Angle', () => D.gradientAngle(v), (val) => {
          // Typing an angle: the gradient runs across the whole box again (the Gradient tool's points go).
          const { x1, y1, x2, y2, ...rest } = v;
          void x1, y1, x2, y2;
          setPaint({ ...rest, angle: ((val % 360) + 360) % 360 }, which + '-angle');
        }, { value: D.gradientAngle(v), suffix: '°', custom: true, icon: 'rotate', title: 'Angle (press G to place the gradient by hand)' }) : `<span class="gx-muted">From the middle out (G places it)</span>`}<button type="button" class="dzi-icon" data-act="reverse-grad" data-which="${which}" title="Reverse the colors">${glyph('flip-h', 14)}</button></div>`;
    }
    return { body, setPaint, v };
  }
  function convertPaint(p, kind, which) {
    const base = p?.type === 'solid' ? p.color : p?.stops?.[0]?.color || (which === 'fill' ? '#d9d9d9' : '#1e1e1e');
    if (kind === 'none') return null;
    if (kind === 'solid') return D.solid(base);
    const stops = p?.stops || [
      { color: base, pos: 0 },
      { color: splitColor(base).hex === '#000000' ? '#ffffff' : '#000000', pos: 1 },
    ];
    return { type: kind, angle: p?.angle ?? 0, stops };
  }

  /* ----- sections ----- */

  function transformSec(list) {
    const f = D.selectionFrame(list);
    if (!f) return '';
    const b = D.boundsOf(list);
    const geo = (k, v) => ed.setGeometry(k, v, { lock: lockRatio, ref: refPt });
    const one = list.length === 1 ? list[0] : null;
    // X and Y are the reference point's place (relative to the artboard, as the rulers show).
    const board = ed.currentBoard();
    const ox = board ? board.x : 0;
    const oy = board ? board.y : 0;
    const rx = b.x1 + ((refPt % 3) * (b.x2 - b.x1)) / 2;
    const ry = b.y1 + (Math.floor(refPt / 3) * (b.y2 - b.y1)) / 2;
    const refGrid = `<div class="gx-ref" title="Reference point: what X and Y place, and what W and H scale from">${[...Array(9).keys()].map((i) => `<button type="button" data-ref="${i}" class="${i === refPt ? 'on' : ''}"><i></i></button>`).join('')}</div>`;
    let body = `<div class="gx-xform">${refGrid}<div class="gx-xform-f"><div class="dzi-row">${num('X', null, (v) => geo('x', v + ox), { value: rx - ox, custom: true, key: 'x', unit: true })}${num('Y', null, (v) => geo('y', v + oy), { value: ry - oy, custom: true, key: 'y', unit: true })}</div>
      <div class="dzi-row">${num('W', null, (v) => geo('w', Math.max(0.01, v)), { value: f.w, custom: true, key: 'w', unit: true })}${num('H', null, (v) => geo('h', Math.max(0.01, v)), { value: f.h, custom: true, key: 'h', unit: true })}<button type="button" class="dzi-icon${lockRatio ? ' on' : ''}" data-act="lock-ratio" title="Keep proportions">${glyph(lockRatio ? 'lock' : 'unlock', 14)}</button></div></div></div>
      <div class="dzi-row">${num('', null, (v) => geo('rot', v), { value: G.r2(f.rot), custom: true, suffix: '°', icon: 'rotate', key: 'rot', title: 'Rotation' })}${btn('rot90', 'rotate', 'Rotate 90°')}${btn('flip-h', 'flip-h', 'Flip horizontal')}${btn('flip-v', 'flip-v', 'Flip vertical')}${btn('xform', 'move', 'Move, scale or rotate by a number, with copies…')}</div>`;
    const rects = list.filter((n) => n.type === 'rect');
    if (rects.length && rects.length === list.length) {
      const anyCorners = rects.some((n) => n.corners);
      if (cornersOpen || anyCorners) {
        const c = (i, lab, tip) => num(lab, (n) => G.cornerRadii(n)[i], (n, v) => {
          n.corners = G.cornerRadii(n);
          n.corners[i] = Math.max(0, v);
          if (n.corners.every((x) => x === n.corners[0])) {
            n.r = n.corners[0];
            delete n.corners;
          }
        }, { list: rects, min: 0, title: tip, unit: true, key: 'corner' + i });
        body += `<div class="dzi-row">${c(0, '┌', 'Top left radius')}${c(1, '┐', 'Top right radius')}<button type="button" class="dzi-icon on" data-act="corners-toggle" title="One radius for all corners">${glyph('corners', 14)}</button></div><div class="dzi-row">${c(3, '└', 'Bottom left radius')}${c(2, '┘', 'Bottom right radius')}<span class="dzi-icon"></span></div>`;
      } else body += `<div class="dzi-row">${num('', (n) => n.r || 0, (n, v) => ((n.r = Math.max(0, v)), delete n.corners), { list: rects, icon: 'radius', title: 'Corner radius (drag the corner handles on the canvas too)', min: 0, unit: true })}<button type="button" class="dzi-icon" data-act="corners-toggle" title="Each corner separately">${glyph('corners', 14)}</button></div>`;
    }
    const polys = list.filter((n) => n.type === 'polygon' || n.type === 'star');
    if (one?.type === 'polygon') body += `<div class="dzi-row">${num('Sides', (n) => n.sides, (n, v) => (n.sides = Math.max(3, Math.min(60, Math.round(v)))), { list: [one], min: 3, title: 'Sides' })}<span class="grow"></span></div>`;
    if (one?.type === 'star') body += `<div class="dzi-row">${num('Points', (n) => n.points, (n, v) => (n.points = Math.max(3, Math.min(60, Math.round(v)))), { list: [one], min: 3 })}${num('Inner', (n) => n.inner ?? 0.5, (n, v) => (n.inner = Math.max(0.05, Math.min(1, v))), { list: [one], scale: 100, suffix: '%', title: 'Inner radius', step: 0.01 })}</div>`;
    if (polys.length && polys.length === list.length) body += `<div class="dzi-row">${num('', (n) => n.r || 0, (n, v) => (v > 0 ? (n.r = v) : delete n.r), { list: polys, icon: 'radius', title: 'Corner radius (drag the corner dots on the canvas too)', min: 0, unit: true })}<span class="grow"></span></div>`;
    if (one?.type === 'image') body += `<div class="dzi-row"><button type="button" class="btn small" data-act="img-reset">Original size</button><button type="button" class="btn small" data-act="img-replace">Replace…</button></div>`;
    return section('transform', 'Transform', body);
  }
  function appearanceSec(list) {
    const body = `<div class="dzi-row">${num('', (n) => n.opacity ?? 1, (n, v) => (n.opacity = Math.max(0, Math.min(1, v))), { list, scale: 100, suffix: '%', icon: 'opacity', title: 'Opacity', step: 0.01, min: 0, max: 1 })}${select((n) => n.blend || 'normal', (n, v) => (n.blend = v === 'normal' ? undefined : v), BLENDS.map((b) => [b, title(b)]), { list, title: 'Blend mode' })}</div>`;
    return section('appearance', 'Appearance', body);
  }
  function fillSec() {
    return section('fill', 'Fill', paintEditor('fill').body);
  }
  function strokeSec() {
    const list = styled();
    const pe = paintEditor('stroke');
    let body = pe.body;
    const has = list.length ? list.some((n) => n.stroke) : !!ed.style.stroke;
    if (has) {
      const target = list.length ? list : null;
      const swNum = target
        ? num('', (n) => n.sw ?? 1, (n, v) => (n.sw = Math.max(0, v)), { list: target, icon: 'outline', title: 'Stroke width', min: 0, step: 0.5, unit: true })
        : num('', null, (v) => ((ed.style.sw = Math.max(0, v)), render()), { value: ed.style.sw, custom: true, icon: 'outline', title: 'Stroke width', unit: true });
      body += `<div class="dzi-row">${swNum}${target ? select((n) => (n.dash?.length ? n.dash.join(' ') : ''), (n, v) => (n.dash = v ? v.split(' ').map(Number) : undefined), [['', 'Solid'], ['4 4', 'Dashed'], ['1 4', 'Dotted'], ['12 6', 'Long dash'], ['12 4 2 4', 'Dash dot']], { list: target, title: 'Dashes' }) : ''}</div>`;
      if (target) {
        body += `<div class="dzi-row"><span class="gx-lab">Caps</span>${seg((n) => n.cap || 'butt', (n, v) => (n.cap = v === 'butt' ? undefined : v), [['butt', capIcon('butt'), 'Butt'], ['round', capIcon('round'), 'Round'], ['square', capIcon('square'), 'Projecting']], { list: target })}<span class="gx-lab">Joins</span>${seg((n) => n.join || 'miter', (n, v) => (n.join = v === 'miter' ? undefined : v), [['miter', joinIcon('miter'), 'Miter'], ['round', joinIcon('round'), 'Round'], ['bevel', joinIcon('bevel'), 'Bevel']], { list: target })}</div>`;
        const dashV = same(target, (n) => (n.dash?.length ? n.dash.join(' ') : ''));
        if (dashV && dashV !== MIXED) body += `<div class="dzi-row">${num('Dash', (n) => n.dash?.[0] ?? 4, (n, v) => (n.dash = [Math.max(0, v), ...(n.dash?.slice(1) || [4])]), { list: target, min: 0 })}${num('Gap', (n) => n.dash?.[1] ?? 4, (n, v) => (n.dash = [n.dash?.[0] ?? 4, Math.max(0, v), ...(n.dash?.slice(2) || [])]), { list: target, min: 0 })}</div>`;
        // Arrowheads: on paths with an open subpath (lines, pen strokes).
        const open = target.filter((n) => n.type === 'path' && n.subpaths.some((sp) => !sp.closed));
        if (open.length) {
          const endOpts = D.ENDS.map((e) => [e, D.END_NAMES[e]]);
          const setEnd = (which) => (n, v) => {
            n.ends = { ...(n.ends || {}), [which]: v };
            if ((n.ends.start || 'none') === 'none' && (n.ends.end || 'none') === 'none') delete n.ends;
          };
          body += `<div class="dzi-row"><span class="gx-lab">Ends</span>${select((n) => n.ends?.start || 'none', setEnd('start'), endOpts, { list: open, title: 'Start of the line' })}${select((n) => n.ends?.end || 'none', setEnd('end'), endOpts, { list: open, title: 'End of the line' })}<button type="button" class="dzi-icon" data-act="swap-ends" title="Swap the ends">${glyph('swap', 14)}</button></div>`;
          if (open.some((n) => n.ends)) body += `<div class="dzi-row">${num('Size', (n) => n.ends?.size ?? 1, (n, v) => (n.ends = { ...(n.ends || {}), size: Math.max(0.1, v) }), { list: open, scale: 100, suffix: '%', step: 0.1, min: 0.1, title: 'Arrowhead size, relative to the stroke width' })}<span class="grow"></span></div>`;
        }
      }
    }
    return section('stroke', 'Stroke', body);
  }
  const capIcon = (c) => `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8h7" stroke="currentColor" stroke-width="5" stroke-linecap="${c}" fill="none" opacity=".45"/><path d="M3 8h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;
  const joinIcon = (j) => `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 13V5h10" stroke="currentColor" stroke-width="4" stroke-linejoin="${j}" fill="none" opacity=".45"/></svg>`;

  function typeSec(texts) {
    const f = (k) => (n) => n.font[k];
    const sf = (k, conv = (v) => v) => (n, v) => (n.font = { ...n.font, [k]: conv(v) });
    const fam = same(texts, f('family'));
    const fams = FONTS.includes(fam) || fam === MIXED ? FONTS : [fam, ...FONTS];
    const body = `<div class="dzi-row">${select(f('family'), sf('family'), [...fams.map((x) => [x, x]), ['__other', 'Other font…']], { list: texts, title: 'Font' })}</div>
      <div class="dzi-row">${select(f('weight'), sf('weight', Number), WEIGHTS, { list: texts })}${num('', f('size'), sf('size', (v) => Math.max(1, v)), { list: texts, title: 'Size', icon: 'text', min: 1 })}</div>
      <div class="dzi-row">${num('', f('lh'), sf('lh', (v) => Math.max(0.5, v)), { list: texts, title: 'Line height', icon: 'padv', step: 0.05, scale: 100, suffix: '%' })}${num('', f('ls'), sf('ls'), { list: texts, title: 'Letter spacing', icon: 'padh', step: 0.1 })}</div>
      <div class="dzi-row">${seg(f('align'), sf('align'), [['left', glyph('align-l', 14), 'Left'], ['center', glyph('align-c', 14), 'Center'], ['right', glyph('align-r', 14), 'Right']], { list: texts })}${seg((n) => !!n.font.italic, (n, v) => (n.font = { ...n.font, italic: v === 'true' }), [['false', '<b style="font-weight:500">I</b>', 'Upright'], ['true', '<i style="font-family:Georgia">I</i>', 'Italic']], { list: texts })}</div>
      <div class="dzi-row">${seg((n) => n.font.case || 'none', sf('case'), [['none', '<span class="gx-case">Aa</span>', 'As typed'], ['upper', '<span class="gx-case">AA</span>', 'All caps'], ['lower', '<span class="gx-case">aa</span>', 'All lowercase'], ['title', '<span class="gx-case">Ab</span>', 'Capitalize each word']], { list: texts })}${seg((n) => n.font.deco || 'none', sf('deco'), [['none', glyph('none', 14), 'Plain'], ['underline', glyph('underline', 14), 'Underline'], ['strike', glyph('strike', 14), 'Strikethrough']], { list: texts })}</div>
      <div class="dzi-row"><span class="gx-lab">Box</span>${seg((n) => (n.w == null ? 'point' : 'area'), (n, v) => {
        if (v === 'point') n.w = null;
        else if (n.w == null) n.w = Math.ceil(D.textBox(n).w);
      }, [['point', 'Point', 'Point type: grows as you type'], ['area', 'Area', 'Area type: wraps in a column']], { list: texts, cls: 'words' })}</div>`;
    return section('type', 'Type', body);
  }

  function effectsSec(list) {
    const fx = same(list, (n) => n.effects || []);
    let body = '';
    if (fx === MIXED) body = '<span class="gx-muted">Mixed</span>';
    else
      (fx || []).forEach((e, i) => {
        const setE = (patch) => (n) => (n.effects = (n.effects || []).map((x, j) => (j === i ? { ...x, ...patch } : x)));
        if (e.type === 'shadow')
          body += `<div class="gx-fx"><div class="dzi-row"><b class="gx-fxname">Drop shadow</b><span class="grow"></span><button type="button" class="dzi-icon" data-act="fx-del" data-i="${i}" title="Remove">${glyph('minus', 14)}</button></div>
          <div class="dzi-row">${num('X', () => e.x, (n, v) => setE({ x: v })(n), { list, key: 'fx-x' + i })}${num('Y', () => e.y, (n, v) => setE({ y: v })(n), { list, key: 'fx-y' + i })}${num('Blur', () => e.blur, (n, v) => setE({ blur: Math.max(0, v) })(n), { list, key: 'fx-b' + i })}</div>
          <div class="dzi-row">${color(e.color, (c, key) => apply(list, setE({ color: c }), key), { key: 'fx-c' + i })}</div></div>`;
        if (e.type === 'blur')
          body += `<div class="gx-fx"><div class="dzi-row"><b class="gx-fxname">Blur</b>${num('', () => e.r, (n, v) => setE({ r: Math.max(0, v) })(n), { list, icon: 'radius', key: 'fx-r' + i })}<button type="button" class="dzi-icon" data-act="fx-del" data-i="${i}" title="Remove">${glyph('minus', 14)}</button></div></div>`;
        if (e.type === 'glow')
          body += `<div class="gx-fx"><div class="dzi-row"><b class="gx-fxname">Glow</b><span class="grow"></span><button type="button" class="dzi-icon" data-act="fx-del" data-i="${i}" title="Remove">${glyph('minus', 14)}</button></div>
          <div class="dzi-row">${num('Size', () => e.r, (n, v) => setE({ r: Math.max(0, v) })(n), { list, key: 'fx-gr' + i, min: 0 })}${num('Spread', () => e.spread || 0, (n, v) => setE({ spread: Math.max(0, v) })(n), { list, key: 'fx-gs' + i, min: 0 })}</div>
          <div class="dzi-row">${color(e.color, (c, key) => apply(list, setE({ color: c }), key), { key: 'fx-gc' + i })}</div></div>`;
        if (e.type === 'inner-shadow')
          body += `<div class="gx-fx"><div class="dzi-row"><b class="gx-fxname">Inner shadow</b><span class="grow"></span><button type="button" class="dzi-icon" data-act="fx-del" data-i="${i}" title="Remove">${glyph('minus', 14)}</button></div>
          <div class="dzi-row">${num('X', () => e.x, (n, v) => setE({ x: v })(n), { list, key: 'fx-ix' + i })}${num('Y', () => e.y, (n, v) => setE({ y: v })(n), { list, key: 'fx-iy' + i })}${num('Blur', () => e.blur, (n, v) => setE({ blur: Math.max(0, v) })(n), { list, key: 'fx-ib' + i })}</div>
          <div class="dzi-row">${color(e.color, (c, key) => apply(list, setE({ color: c }), key), { key: 'fx-ic' + i })}</div></div>`;
      });
    return section('effects', 'Effects', body || '<span class="gx-muted">Shadows, glows and blur</span>', { tools: `<button type="button" class="dzi-icon" data-act="fx-add" title="Add an effect">${glyph('plus', 14)}</button>` });
  }
  /** Pictures: brightness, contrast and the rest, like Canva's Adjust. */
  function adjustSec(images) {
    const a = (k) => (n) => n.adjust?.[k] ?? D.ADJUST[k];
    const sa = (k) => (n, v) => {
      n.adjust = { ...(n.adjust || {}), [k]: v };
      if (!D.adjusted(n.adjust)) delete n.adjust;
    };
    const body = `${slider('Brightness', a('brightness'), sa('brightness'), { list: images, min: 0, max: 2, scale: 100, def: 1, suffix: '%', step: 0.01, key: 'adj-b' })}
      ${slider('Contrast', a('contrast'), sa('contrast'), { list: images, min: 0, max: 2, scale: 100, def: 1, suffix: '%', step: 0.01, key: 'adj-c' })}
      ${slider('Saturation', a('saturate'), sa('saturate'), { list: images, min: 0, max: 2, scale: 100, def: 1, suffix: '%', step: 0.01, key: 'adj-s' })}
      ${slider('Hue', a('hue'), sa('hue'), { list: images, min: -180, max: 180, def: 0, suffix: '°', key: 'adj-h' })}
      ${slider('Grayscale', a('grayscale'), sa('grayscale'), { list: images, min: 0, max: 1, scale: 100, def: 0, suffix: '%', step: 0.01, key: 'adj-g' })}
      ${slider('Sepia', a('sepia'), sa('sepia'), { list: images, min: 0, max: 1, scale: 100, def: 0, suffix: '%', step: 0.01, key: 'adj-p' })}
      ${slider('Invert', a('invert'), sa('invert'), { list: images, min: 0, max: 1, scale: 100, def: 0, suffix: '%', step: 0.01, key: 'adj-i' })}
      <div class="gx-btnrow"><button type="button" class="btn small" data-act="adj-reset"${images.some((n) => D.adjusted(n.adjust)) ? '' : ' disabled'}>Reset</button><button type="button" class="btn small" data-act="crop">Crop</button></div>`;
    return section('adjust', 'Picture', body);
  }

  function alignSec(list) {
    const body = `<div class="gx-alignrow">${['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'].map((a) => btn('align-' + a, 'al-' + a, 'Align ' + { left: 'left edges', hcenter: 'horizontal centers', right: 'right edges', top: 'top edges', vcenter: 'vertical centers', bottom: 'bottom edges' }[a])).join('')}${btn('dist-h', 'dist-h', 'Distribute horizontally', { disabled: list.length < 3 })}${btn('dist-v', 'dist-v', 'Distribute vertically', { disabled: list.length < 3 })}</div>
      <div class="dzi-row"><span class="gx-lab">Align to</span>${select(null, null, [['selection', 'Selection'], ['artboard', 'Artboard'], ['key', 'First selected']], { value: list.length === 1 ? 'artboard' : alignTo, custom: (v) => (alignTo = v) })}</div>`;
    return section('align', 'Align', body);
  }
  function pathfinderSec() {
    const body = `<div class="gx-alignrow">${btn('pf-unite', 'unite', 'Unite: one shape from all of them')}${btn('pf-minus', 'minus-front', 'Minus Front: cut the top shapes out of the bottom one')}${btn('pf-intersect', 'intersect', 'Intersect: only where they overlap')}${btn('pf-exclude', 'exclude', 'Exclude: everything but the overlaps')}${btn('pf-divide', 'divide', 'Divide: every piece separately')}</div>`;
    return section('pathfinder', 'Pathfinder', body);
  }
  function pathSec(list) {
    const anchors = ed.anchors.size;
    let body = '';
    if (anchors) body += `<div class="dzi-row"><span class="gx-lab">${anchors} anchor${anchors === 1 ? '' : 's'}</span><span class="grow"></span>${btn('anchor-corner', 'anchor-corner', 'Make corner')}${btn('anchor-smooth', 'anchor-smooth', 'Make smooth')}${btn('join', 'join', 'Join (Ctrl+J)')}${btn('del-anchors', 'trash', 'Delete anchors')}</div>`;
    // Live corners: the selected anchors' radius, or every corner of the selected paths.
    const pathLeaves = list.filter((n) => n.type === 'path');
    if (pathLeaves.length) {
      const crOf = (k) => {
        const [id, si, i] = k.split(':');
        return ed.node(id)?.subpaths?.[+si]?.pts[+i]?.cr || 0;
      };
      const vals = anchors ? [...ed.anchors].map(crOf) : pathLeaves.flatMap((n) => n.subpaths.flatMap((sp, si) => sp.pts.map((p, i) => (G.cornerInfo(sp, i) ? p.cr || 0 : null)).filter((v) => v != null)));
      if (vals.length) {
        const v = vals.every((x) => x === vals[0]) ? vals[0] : MIXED;
        body += `<div class="dzi-row">${num('', null, (val) => ed.setCornerRadius(val), { value: v, custom: true, icon: 'radius', title: anchors ? 'Round the selected corners' : 'Round every corner of the path', min: 0, unit: true, key: 'corner-r' })}<span class="gx-lab">${anchors ? 'selected corners' : 'all corners'}</span>${pathLeaves.some((n) => G.hasCorners(n.subpaths)) ? `<button type="button" class="dzi-icon" data-act="expand-corners" title="Make the rounding real anchors">${glyph('anchor-corner', 14)}</button>` : ''}</div>`;
      }
    }
    const hasShape = list.some((n) => D.SHAPES.includes(n.type));
    const hasPath = list.some((n) => n.type === 'path');
    body += `<div class="gx-btnrow">${hasShape ? `<button type="button" class="btn small" data-act="expand">Convert to path</button>` : ''}${hasPath ? `<button type="button" class="btn small" data-act="simplify">Simplify</button><button type="button" class="btn small" data-act="reverse">Reverse</button>${!anchors ? `<button type="button" class="btn small" data-act="join">Join / close</button>` : ''}` : ''}${list.some((n) => n.stroke && n.sw) ? `<button type="button" class="btn small" data-act="outline">Outline stroke</button>` : ''}${list.some((n) => n.type === 'path' && n.subpaths.length > 1) ? `<button type="button" class="btn small" data-act="release-compound">Release compound</button>${select((n) => n.fillRule || 'nonzero', (n, v) => (n.fillRule = v), [['nonzero', 'Fill: non-zero'], ['evenodd', 'Fill: even-odd']], { list: list.filter((n) => n.type === 'path') })}` : ''}</div>`;
    if (ed.tool !== 'direct' && hasPath && !anchors) body += `<p class="gx-hint">Double-click a path, or press <kbd>A</kbd>, to edit its anchors.</p>`;
    return section('path', 'Path', body);
  }
  function swatchesSec() {
    const sw = ed.doc.swatches || [];
    let body = `<div class="gx-swatches">${sw.map((c, i) => `<button type="button" class="gx-sw" data-sw="${i}" style="--c:${esc(D.paintCss(c))}" title="Click: fill · Shift+click: stroke · right-click: remove"></button>`).join('')}<button type="button" class="gx-sw add" data-act="sw-add" title="Save the current fill as a swatch">${glyph('plus', 12)}</button></div>`;
    // The colors already in the artwork, most used first.
    const used = new Map();
    D.walk(ed.doc.nodes, (n) => {
      for (const p of [n.fill, n.stroke]) {
        if (!p) continue;
        const k = JSON.stringify(p);
        used.set(k, (used.get(k) || 0) + 1);
      }
    });
    const docColors = [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k]) => JSON.parse(k)).filter((p) => !sw.some((c) => JSON.stringify(c) === JSON.stringify(p)));
    if (docColors.length) body += `<div class="gx-lab" style="margin-top:6px">In this artwork</div><div class="gx-swatches">${docColors.map((c) => `<button type="button" class="gx-sw" data-paint="${esc(JSON.stringify(c))}" style="--c:${esc(D.paintCss(c))}" title="Click: fill · Shift+click: stroke · right-click: save as a swatch"></button>`).join('')}</div>`;
    return section('swatches', 'Swatches', body);
  }

  function boardSec(b) {
    const set = (patch, key) => {
      ed.setBoard(b.id, patch, key);
      render();
    };
    const body = `<div class="dzi-row"><input class="dzi-text" data-board-name value="${esc(b.name)}" spellcheck="false"></div>
      <div class="dzi-row">${select(null, null, [['', 'Size preset…'], ...BOARD_PRESETS.map(([n, w, h]) => [`${w}x${h}`, `${n} (${w} × ${h})`])], { value: '', custom: (v) => v && set({ w: +v.split('x')[0], h: +v.split('x')[1] }) })}</div>
      <div class="dzi-row">${num('X', null, (v) => set({ x: Math.round(v) }, 'bx'), { value: b.x, custom: true, unit: true })}${num('Y', null, (v) => set({ y: Math.round(v) }, 'by'), { value: b.y, custom: true, unit: true })}</div>
      <div class="dzi-row">${num('W', null, (v) => set({ w: Math.max(1, Math.round(v)) }, 'bw'), { value: b.w, custom: true, unit: true })}${num('H', null, (v) => set({ h: Math.max(1, Math.round(v)) }, 'bh'), { value: b.h, custom: true, unit: true })}<button type="button" class="dzi-icon" data-act="board-rotate" title="Portrait ↔ landscape">${glyph('rotate', 14)}</button></div>
      <div class="dzi-row">${b.bg === 'transparent' ? '<span class="gx-muted">Transparent background</span>' : color(b.bg || '#ffffff', (c, key) => set({ bg: c }, key), { key: 'board-bg' })}<button type="button" class="dzi-icon${b.bg === 'transparent' ? ' on' : ''}" data-act="board-clear" title="Transparent background">${glyph('none', 14)}</button></div>
      <div class="gx-btnrow"><button type="button" class="btn small" data-act="board-fit">Fit to artwork</button><button type="button" class="btn small" data-act="board-del"${ed.doc.artboards.length < 2 ? ' disabled' : ''}>Delete</button></div>`;
    return section('board', 'Artboard', body);
  }
  function documentSec() {
    const b = ed.currentBoard();
    const g = ed.doc.grid || {};
    const body = `<div class="gx-btnrow"><button type="button" class="btn small" data-act="add-board">${glyph('plus', 12)} Artboard</button><button type="button" class="btn small" data-act="arrange-boards">Arrange artboards</button></div>
      ${b ? `<div class="dzi-row"><span class="gx-lab">${esc(b.name)}: ${ed.toUnit(b.w)} × ${ed.toUnit(b.h)} ${ed.unit()}</span></div>` : ''}
      <div class="dzi-row"><span class="gx-lab">Units</span>${select(null, null, [['px', 'Pixels (px)'], ['pt', 'Points (pt)'], ['in', 'Inches (in)'], ['mm', 'Millimeters (mm)'], ['cm', 'Centimeters (cm)']], { value: ed.unit(), custom: (v) => ed.setDocView({ units: v }), title: 'What lengths show in (the rulers too)' })}</div>
      <label class="gx-check"><input type="checkbox" data-view="rulers"${ed.doc.rulers !== false ? ' checked' : ''}> Rulers (Ctrl+R): drag guides out of them</label>
      <label class="gx-check"><input type="checkbox" data-view="guides"${ed.doc.guidesHidden ? '' : ' checked'}> Show guides (Ctrl+;)${ed.doc.guides?.length ? ` <small class="gx-muted">${ed.doc.guides.length}</small>` : ''}</label>
      <label class="gx-check"><input type="checkbox" data-view="guidesLocked"${ed.doc.guidesLocked ? ' checked' : ''}> Lock guides (Ctrl+Alt+;)</label>
      <div class="gx-btnrow"><button type="button" class="btn small" data-act="guides-around" title="Guides at the edges of the selection, or of the artboard">Guides around</button><button type="button" class="btn small" data-act="guides-clear"${ed.doc.guides?.length ? '' : ' disabled'}>Clear guides</button></div>
      <label class="gx-check"><input type="checkbox" data-view="gridShow"${g.show ? ' checked' : ''}> Grid (Ctrl+')</label>
      <div class="dzi-row">${num('Every', null, (v) => ed.setDocView({ grid: { size: Math.max(1, v) } }), { value: g.size || 20, custom: true, unit: true, min: 1, title: 'Grid spacing', key: 'grid-size' })}<label class="gx-check" style="flex:1"><input type="checkbox" data-view="gridSnap"${g.snap ? ' checked' : ''}> Snap (Ctrl+Shift+')</label></div>
      <label class="gx-check"><input type="checkbox" data-pref="snapping"${ed.snapping ? ' checked' : ''}> Smart guides: snap to edges and centers (Ctrl+U)</label>
      <label class="gx-check"><input type="checkbox" data-pref="pixelSnap"${ed.pixelSnap ? ' checked' : ''}> Snap to whole pixels</label>
      <label class="gx-check"><input type="checkbox" data-pref="scaleStrokes"${ed.scaleStrokes ? ' checked' : ''}> Scale strokes and effects with objects</label>
      <div class="dzi-row">${num('Nudge', null, (v) => ((ed.nudgeStep = Math.max(0.01, v)), opts.onPrefs?.()), { value: ed.nudgeStep || 1, custom: true, unit: true, min: 0.01, title: 'How far the arrow keys move things (Shift: ten times)', key: 'nudge' })}<span class="gx-lab">per arrow key</span></div>
      <label class="gx-check"><input type="checkbox" data-pref="outlineMode"${ed.outlineMode ? ' checked' : ''}> Outline view (Ctrl+Y)</label>`;
    return section('document', 'Document', body);
  }
  /** Nothing selected: the fill and stroke new objects get. */
  function defaultsSec() {
    return section('fill', 'Fill', paintEditor('fill').body, { tools: '<small class="gx-muted">for new objects</small>' }) + strokeSec();
  }

  function render() {
    if (quiet || !ed.doc) return;
    if (panel.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox])')) return;
    ctl = new Map();
    seq = 0;
    const list = sel();
    let html = '';
    if (ed.tool === 'artboard' && ed.board) {
      const b = ed.boardById(ed.board);
      html = `<div class="dzi-head">${glyph('artboard', 14)} Artboard</div>` + (b ? boardSec(b) : '');
    } else if (!list.length) {
      html = `${documentSec()}${defaultsSec()}${swatchesSec()}`;
    } else {
      const kinds = [...new Set(list.map((n) => n.type))];
      const label = list.length === 1 ? D.NAMES[list[0].type] + (list[0].clip ? ' (clipped)' : '') : `${list.length} objects`;
      const texts = styled().filter((n) => n.type === 'text');
      const shapes = list.filter((n) => n.type === 'path' || D.SHAPES.includes(n.type));
      html = `<div class="dzi-head">${esc(label)}<span class="grow"></span>${btn('group', 'group', 'Group (Ctrl+G)')}${kinds.includes('group') ? btn('ungroup', 'frame', 'Ungroup (Ctrl+Shift+G)') : ''}<button type="button" class="dzi-icon" data-act="more" title="More">${icon('dots', 15)}</button></div>`;
      html += alignSec(list);
      html += transformSec(list);
      if (texts.length) html += typeSec(texts);
      html += appearanceSec(list);
      if (!list.every((n) => n.type === 'image')) html += fillSec();
      html += strokeSec();
      html += effectsSec(list);
      const images = styled().filter((n) => n.type === 'image');
      if (images.length) html += adjustSec(images);
      if (list.length > 1 && shapes.length > 1) html += pathfinderSec();
      if (shapes.length) html += pathSec(shapes);
      html += swatchesSec();
    }
    panel.innerHTML = html;
  }

  /* ----- events ----- */

  /** A typed length: "2in", "10 mm", "12pt" convert; a bare number is in the field's own units. */
  function parseLen(raw, c) {
    const m = /^\s*(.*?)\s*(px|pt|in|mm|cm)\s*$/i.exec(String(raw));
    if (m && c.unit) {
      const v = evalNum(m[1]);
      return v == null ? null : (v * D.UNITS[m[2].toLowerCase()]) / (1 / c.scale);
    }
    return evalNum(raw);
  }
  function setValue(c, raw) {
    if (c.type === 'num') {
      const v = parseLen(raw, c);
      if (v == null) return;
      const val = Math.max(c.min, Math.min(c.max, v / c.scale));
      if (c.custom) return c.set(val);
      apply(c.list, (n) => c.set(n, val), c.key);
      if (c.list.length) ed.rememberStyle(c.list[0]);
    } else if (c.type === 'select') {
      if (c.custom) return c.custom(raw);
      if (raw === '__other') return askFont(c);
      apply(c.list, (n) => c.set(n, raw), c.key);
    }
  }
  async function askFont(c) {
    const name = await opts.ask?.('Font family', 'Any font installed on this computer, e.g. "Montserrat"');
    if (name) apply(c.list, (n) => c.set(n, name.trim()));
    render();
  }

  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-pref]')) {
      ed[t.dataset.pref] = t.checked;
      if (t.dataset.pref === 'outlineMode') ed.render();
      return opts.onPrefs?.();
    }
    if (t.matches('[data-view]')) {
      const k = t.dataset.view;
      if (k === 'rulers') return ed.setDocView({ rulers: t.checked });
      if (k === 'guides') return ed.setDocView({ guidesHidden: !t.checked });
      if (k === 'guidesLocked') return ed.setDocView({ guidesLocked: t.checked });
      if (k === 'gridShow') return ed.setDocView({ grid: { show: t.checked } });
      if (k === 'gridSnap') return ed.setDocView({ grid: { snap: t.checked } });
      return;
    }
    if (t.matches('[data-range]')) {
      // The slider's number field follows; the value was applied on input.
      const c = ctl.get(t.dataset.k);
      if (c) setValue(c, t.value);
      return render();
    }
    if (t.matches('[data-board-name]') && ed.board) {
      ed.setBoard(ed.board, { name: t.value.trim() || 'Artboard' });
      return;
    }
    const c = ctl.get(t.dataset.k);
    if (c && (c.type === 'num' || c.type === 'select')) {
      setValue(c, t.value);
      t.blur();
      render();
    }
    const box = t.closest('.dzi-color');
    if (box) commitColor(box);
  });
  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.matches('[data-range]')) return;
    const c = ctl.get(t.dataset.k);
    if (!c) return;
    setValue(c, t.value);
    const n = t.parentElement.querySelector('.gx-slider-n');
    if (n) n.value = t.value;
  });
  panel.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Enter' && t.matches('input')) {
      t.blur();
      return;
    }
    const c = ctl.get(t.dataset.k);
    if (c?.type === 'num' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const cur = evalNum(t.value) ?? 0;
      const step = (e.shiftKey ? 10 : 1) * (c.dstep ?? c.step);
      t.value = round(cur + (e.key === 'ArrowUp' ? step : -step));
      setValue(c, t.value);
    }
    e.stopPropagation();
  });
  panel.addEventListener('focusout', (e) => {
    if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
    setTimeout(() => !panel.contains(document.activeElement) && render(), 0);
  });
  function commitColor(box) {
    const c = ctl.get(box.dataset.k);
    if (!c) return;
    const hex = box.querySelector('[data-hex]').value.trim().replace(/^#/, '');
    const a = evalNum(box.querySelector('[data-alpha]').value);
    let h = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((x) => x + x).join('') : hex;
    if (!/^[0-9a-f]{6}$/i.test(h)) return render();
    c.set(joinColor('#' + h.toLowerCase(), a == null ? 1 : Math.max(0, Math.min(100, a)) / 100), c.key);
  }

  panel.addEventListener('click', (e) => {
    const t = e.target;
    const head = t.closest('[data-collapse]');
    if (head && !t.closest('button')) {
      const id = head.dataset.collapse;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      try {
        localStorage.setItem('graphic:collapsed', JSON.stringify([...collapsed]));
      } catch {}
      return head.parentElement.classList.toggle('closed');
    }
    const sw = t.closest('[data-swatch]');
    if (sw) {
      const box = sw.closest('.dzi-color');
      const c = ctl.get(box.dataset.k);
      const r = sw.getBoundingClientRect();
      const cur = c.value && c.value !== MIXED ? splitColor(c.value) : { hex: '#000000', a: 1 };
      return pickColor(r.left - 250, r.top, {
        value: cur.hex,
        title: 'Color',
        onChange: (hex) => {
          if (hex) c.set(joinColor(hex, cur.a), c.key + '-pick');
        },
        onDone: () => render(),
      });
    }
    const segB = t.closest('.dzi-seg [data-v]');
    if (segB) {
      const c = ctl.get(segB.parentElement.dataset.k);
      if (!c) return;
      if (c.custom) return c.custom(segB.dataset.v), render();
      apply(c.list, (n) => c.set(n, segB.dataset.v));
      return render();
    }
    const stop = t.closest('[data-stop]');
    if (stop) return;
    const del = t.closest('[data-stop-del]');
    if (del) {
      const c = ctl.get(del.dataset.stopDel);
      const v = structuredClone(c.value);
      v.stops.splice(+del.dataset.i, 1);
      stopSel[c.which] = 0;
      return c.set(v);
    }
    const swatch = t.closest('[data-sw]');
    if (swatch) return applySwatch(+swatch.dataset.sw, e.shiftKey);
    const dc = t.closest('[data-paint]');
    if (dc) return applyPaint(JSON.parse(dc.dataset.paint), e.shiftKey);
    const ref = t.closest('[data-ref]');
    if (ref) {
      refPt = +ref.dataset.ref;
      return render();
    }
    const b = t.closest('[data-act]');
    if (b) return act(b.dataset.act, b, e);
  });
  // Double-click a gradient stop: remove it (two always stay).
  panel.addEventListener('dblclick', (e) => {
    const stopEl = e.target.closest('[data-stop]');
    const bar = stopEl?.closest('[data-grad]');
    const c = bar && ctl.get(bar.dataset.grad);
    if (!c || c.value.stops.length <= 2) return;
    const v = structuredClone(c.value);
    v.stops.splice(+stopEl.dataset.stop, 1);
    stopSel[c.which] = 0;
    c.set(v);
  });
  panel.addEventListener('contextmenu', (e) => {
    const dc = e.target.closest('[data-paint]');
    if (dc) {
      e.preventDefault();
      ed.checkpoint();
      ed.doc.swatches.push(JSON.parse(dc.dataset.paint));
      return ed.commit();
    }
    const swatch = e.target.closest('[data-sw]');
    if (!swatch) return;
    e.preventDefault();
    ed.checkpoint();
    ed.doc.swatches.splice(+swatch.dataset.sw, 1);
    ed.commit();
  });
  function applySwatch(i, toStroke) {
    applyPaint(ed.doc.swatches[i], toStroke);
  }
  function applyPaint(p, toStroke) {
    if (!p) return;
    const list = styled().filter((n) => n.type !== 'image' || toStroke);
    const which = toStroke ? 'stroke' : 'fill';
    if (!list.length) {
      ed.style[which] = structuredClone(p);
      return render();
    }
    apply(list, (n) => {
      n[which] = structuredClone(p);
      if (toStroke && !n.sw) n.sw = 1;
    });
    render();
  }

  /* gradient stops: drag to move, click the bar to add, double-click a stop to remove */
  panel.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('[data-grad]');
    if (bar) return gradDown(e, bar);
    const s = e.target.closest('[data-scrub]');
    if (s) return scrub(e, s);
  });
  function gradDown(e, bar) {
    const c = ctl.get(bar.dataset.grad);
    const v = structuredClone(c.value);
    const r = bar.getBoundingClientRect();
    const posAt = (x) => Math.max(0, Math.min(1, (x - r.left) / r.width));
    const stopEl = e.target.closest('[data-stop]');
    let i;
    if (stopEl) i = +stopEl.dataset.stop;
    else {
      // A new stop, in the color the gradient already has there.
      const pos = posAt(e.clientX);
      const sorted = v.stops.slice().sort((a, b) => a.pos - b.pos);
      const right = sorted.find((s) => s.pos >= pos) || sorted[sorted.length - 1];
      v.stops.push({ color: right.color, pos });
      i = v.stops.length - 1;
      c.set(v);
    }
    stopSel[c.which] = i;
    render();
    const move = (ev) => {
      v.stops[i].pos = Math.round(posAt(ev.clientX) * 1000) / 1000;
      c.set(v, c.which + '-drag');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  /** Drag a field's label sideways to change its value. */
  function scrub(e, s) {
    const c = ctl.get(s.dataset.scrub);
    const input = panel.querySelector(`input[data-k="${s.dataset.scrub}"]`);
    if (!c || !input) return;
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = evalNum(input.value) ?? 0;
    const step = c.dstep ?? c.step;
    s.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const v = round(v0 + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1));
      input.value = v;
      setValue(c, String(v));
    };
    const up = () => {
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerup', up);
      render();
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  }

  async function act(a, b, e) {
    const list = sel();
    if (a.startsWith('align-')) return ed.align(a.slice(6), list.length === 1 ? 'artboard' : alignTo);
    if (a === 'dist-h') return ed.distribute('h');
    if (a === 'dist-v') return ed.distribute('v');
    if (a.startsWith('pf-')) return ed.pathfinder(a.slice(3));
    const simple = {
      group: () => ed.group(),
      ungroup: () => ed.ungroup(),
      rot90: () => ed.rotate(90),
      'flip-h': () => ed.flip('h'),
      'flip-v': () => ed.flip('v'),
      swap: () => ed.swapFillStroke(),
      expand: () => ed.expand(),
      simplify: () => ed.simplify(),
      reverse: () => ed.reversePath(),
      join: () => ed.join(),
      outline: () => ed.outlineStroke(),
      'release-compound': () => ed.releaseCompound(),
      'anchor-corner': () => ed.anchorMode('corner'),
      'anchor-smooth': () => ed.anchorMode('smooth'),
      'del-anchors': () => ed.deleteSelection(),
      'add-board': () => (ed.addBoard(), ed.fit()),
      'arrange-boards': () => ed.boardsArrange(),
      'board-fit': () => ed.boardFitArt(ed.board),
      'board-del': () => ed.deleteBoard(ed.board),
      'guides-around': () => ed.guidesAround(),
      'expand-corners': () => ed.expandCorners(),
      'guides-clear': () => ed.clearGuides(),
      crop: () => ed.cropImage(),
      xform: () => opts.transformDialog?.(),
      'corners-toggle': () => {
        cornersOpen = !cornersOpen;
        if (!cornersOpen) apply(list.filter((n) => n.type === 'rect'), (n) => n.corners && ((n.r = Math.max(...G.cornerRadii(n))), delete n.corners));
        render();
      },
      'swap-ends': () => {
        apply(list.filter((n) => n.type === 'path'), (n) => n.ends && (n.ends = { ...n.ends, start: n.ends.end || 'none', end: n.ends.start || 'none' }));
        render();
      },
      'adj-reset': () => {
        apply(styled().filter((n) => n.type === 'image'), (n) => delete n.adjust);
        render();
      },
    };
    if (simple[a]) return simple[a]();
    if (a === 'more') {
      const r = b.getBoundingClientRect();
      return objectMenu(r.left, r.bottom + 4, ed);
    }
    if (a === 'lock-ratio') {
      lockRatio = !lockRatio;
      return render();
    }
    if (a === 'board-rotate') {
      const bd = ed.boardById(ed.board);
      ed.setBoard(bd.id, { w: bd.h, h: bd.w });
      return render();
    }
    if (a === 'board-clear') {
      const bd = ed.boardById(ed.board);
      ed.setBoard(bd.id, { bg: bd.bg === 'transparent' ? '#ffffff' : 'transparent' });
      return render();
    }
    if (a === 'reverse-grad') {
      const which = b.dataset.which;
      const target = styled();
      if (target.length) apply(target, (n) => n[which]?.stops && (n[which] = { ...n[which], stops: n[which].stops.map((s) => ({ ...s, pos: 1 - s.pos })) }));
      return render();
    }
    if (a === 'fx-add') {
      const r = b.getBoundingClientRect();
      const add = (fx) => {
        apply(list, (n) => (n.effects = [...(n.effects || []), fx]));
        render();
      };
      return showMenu(r.left - 120, r.bottom + 4, [
        { label: 'Drop shadow', act: () => add({ type: 'shadow', x: 0, y: 4, blur: 8, color: '#00000040' }) },
        { label: 'Inner shadow', act: () => add({ type: 'inner-shadow', x: 0, y: 3, blur: 6, color: '#00000059' }) },
        { label: 'Glow', act: () => add({ type: 'glow', r: 10, spread: 0, color: '#ffcc00cc' }) },
        { label: 'Blur', act: () => add({ type: 'blur', r: 4 }) },
      ]);
    }
    if (a === 'fx-del') {
      const i = +b.dataset.i;
      apply(list, (n) => {
        n.effects = (n.effects || []).filter((_, j) => j !== i);
        if (!n.effects.length) delete n.effects;
      });
      return render();
    }
    if (a === 'sw-add') {
      const first = styled()[0];
      const p = first ? first.fill || first.stroke : ed.style.fill || ed.style.stroke;
      if (!p) return;
      ed.checkpoint();
      ed.doc.swatches.push(structuredClone(p));
      ed.commit();
      return;
    }
    if (a === 'img-reset') {
      const n = list[0];
      const img = new Image();
      img.src = n.src.startsWith('asset:') ? ed.doc.assets[n.src.slice(6)] : n.src;
      await img.decode().catch(() => {});
      if (!img.naturalWidth) return;
      ed.checkpoint();
      Object.assign(n, { w: img.naturalWidth, h: img.naturalHeight });
      return ed.commit();
    }
    if (a === 'img-replace') {
      const url = await opts.chooseImage?.();
      if (!url) return;
      ed.checkpoint();
      list[0].src = 'asset:' + ed.addAsset(url);
      return ed.commit();
    }
    void e;
  }

  ed.on('select', render);
  ed.on('change', render);
  ed.on('tool', render);
  render();
  return { render };
}
