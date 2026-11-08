// Graphic Designer: Designer's second half, for artwork rather than UI (logos, illustrations, posters, social posts,
// print). A simpler Illustrator: artboards, vector paths with the pen, pencil and scissors, live shapes, type,
// gradients (with on-canvas handles), arrowheads, effects, picture adjustments, pathfinder, clipping masks, align,
// smart guides, rulers, guides and a grid in the document's units, and export to PNG, JPG, SVG and PDF. This file is
// the window around the editor: the toolbar and its Object / Select / View menus, the tool palette, the context bar
// over the canvas, the Transform and Export sheets, the shortcuts sheet, placing files, saving.
//
// apps/designer.js opens a design here when its design.json has kind: 'graphic'; this mounts the editor
// (graphic/editor.js) and its panels (graphic/panels.js) into the Designer window and saves through the same storage.
import { $, esc, debounce } from '../util.js';
import { icon } from '../icons.js';
import { showMenu } from '../wm.js';
import { shell } from '../shell.js';
import { glyph } from '../designer/glyphs.js';
import { evalNum } from '../designer/inspector.js';
import { createGraphicEditor } from './editor.js';
import { createLayers, createInspector, objectMenu, BOARD_PRESETS } from './panels.js';
import * as D from './doc.js';
import * as G from './geom.js';

const PALETTE = [
  ['select', 'move', 'Selection (V)'],
  ['direct', 'direct', 'Direct Selection: edit anchors (A)'],
  '|',
  ['pen', 'pen-tool', 'Pen (P)'],
  ['pencil', 'pencil', 'Pencil (N)'],
  '|',
  ['rect', 'rect', 'Rectangle (M)'],
  ['ellipse', 'ellipse', 'Ellipse (L)'],
  ['polygon', 'polygon', 'Polygon'],
  ['star', 'star', 'Star'],
  ['line', 'line', 'Line (\\)'],
  ['text', 'text', 'Type (T)'],
  '|',
  ['gradient', 'gradient', 'Gradient: drag across a shape, then move its handles (G)'],
  ['scissors', 'scissors', 'Scissors: cut a path where you click (C)'],
  ['shapebuilder', 'shape-builder', 'Shape Builder: merge or erase the regions where selected shapes overlap (Shift+M)'],
  ['eyedropper', 'eyedropper', 'Eyedropper: copy a look (I)'],
  ['artboard', 'artboard', 'Artboard (Shift+O)'],
  '|',
  ['hand', 'hand', 'Hand (H, or hold Space)'],
  ['zoom', 'zoom', 'Zoom (Z, Alt-click to zoom out)'],
];

/** A blank graphic document with one artboard. */
export function newGraphicDoc(id, { name = 'Untitled artwork', w = 1080, h = 1080 } = {}) {
  return { id, kind: 'graphic', name, artboards: [{ id: D.newId(), name: 'Artboard 1', x: 0, y: 0, w, h, bg: '#ffffff' }], nodes: [], swatches: defaultSwatches(), createdAt: Date.now(), updatedAt: Date.now() };
}
const defaultSwatches = () =>
  ['#000000', '#ffffff', '#5c5c5c', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5856d6', '#af52de', '#ff2d55'].map((c) => D.solid(c)).concat([{ type: 'linear', angle: 0, stops: [{ color: '#ff9500', pos: 0 }, { color: '#ff2d55', pos: 1 }] }, { type: 'linear', angle: 90, stops: [{ color: '#0a84ff', pos: 0 }, { color: '#5856d6', pos: 1 }] }]);
export const GRAPHIC_PRESETS = BOARD_PRESETS;

const saveBlob = (name, blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
const safeName = (s) => String(s || 'Artwork').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Artwork';

/** An SVG drawn into a canvas: a PNG or JPEG blob. */
async function rasterize(svgText, w, h, { type = 'image/png', background = null } = {}) {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const x = c.getContext('2d');
    if (background) {
      x.fillStyle = background;
      x.fillRect(0, 0, c.width, c.height);
    }
    x.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, type, 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Open a graphic document in the Designer window. ctx: { id, doc, assets, storage, toast, home(), chooseFile(accept),
 * readFileAs(file, how), ask(title, detail) }. Returns { save(), thumb(), destroy() }.
 */
export function mountGraphic(win, ctx) {
  const { id, storage, toast } = ctx;
  const doc = { ...ctx.doc, id, assets: ctx.assets || {} };
  doc.artboards?.length || (doc.artboards = [{ id: D.newId(), name: 'Artboard 1', x: 0, y: 0, w: 1080, h: 1080, bg: '#ffffff' }]);
  const saved = new Set(Object.keys(ctx.assets || {}));
  let destroyed = false;
  const ac = new AbortController();
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });
  let thumbTimer = null;
  const scheduleSave = debounce(() => save(), 600);
  const scheduleViewSave = debounce(() => save(), 2000);

  win.setTitle(doc.name);
  win.tools.innerHTML = `<button class="tb-btn" data-g="home" title="All designs">${icon('grid', 15)}</button>
    <button class="tb-btn" data-g="left" title="Show or hide Layers (Ctrl+Alt+[)">${glyph('panel-left', 16)}</button>
    <input class="dz-name" value="${esc(doc.name)}" spellcheck="false" aria-label="Document name">
    <span class="gx-badge">Graphic</span>
    <span class="gx-menus"><button class="tb-pill gx-menu" data-g="menu-object">Object</button><button class="tb-pill gx-menu" data-g="menu-select">Select</button><button class="tb-pill gx-menu" data-g="menu-view">View</button></span>
    <span class="grow"></span>
    <button class="tb-btn" data-g="undo" title="Undo (Ctrl+Z)">${glyph('undo', 16)}</button>
    <button class="tb-btn" data-g="redo" title="Redo (Ctrl+Shift+Z)">${glyph('redo', 16)}</button>
    <button class="tb-pill" data-g="place" title="Place an image or SVG">${icon('plus', 12)} Place</button>
    <button class="tb-pill" data-g="export" title="Export (Ctrl+Shift+E)">${glyph('export', 13)} Export</button>
    <button class="tb-pill dz-zoom" data-g="zoom" title="Zoom">100%</button>
    <button class="tb-btn" data-g="right" title="Show or hide Properties (Ctrl+Alt+])">${glyph('panel-right', 16)}</button>`;
  win.body.innerHTML = `<div class="dz gx">
    <aside class="dz-left"><div class="gx-layers"></div></aside>
    <div class="dz-split" data-gsplit="left" title="Drag to resize"></div>
    <section class="dz-center">
      <div class="gx-ctxbar"></div>
      <div class="dz-canvas"></div>
      <div class="gx-palette" role="toolbar" aria-label="Tools">
        ${PALETTE.map((t) => (t === '|' ? '<i></i>' : `<button type="button" data-gtool="${t[0]}" title="${esc(t[2])}">${glyph(t[1], 18)}</button>`)).join('')}
        <i></i>
        <div class="gx-fs" title="Fill and stroke (Shift+X swaps, D resets)"><span class="gx-fs-stroke"></span><span class="gx-fs-fill"></span></div>
      </div>
      <div class="dz-drop-hint" hidden>Drop SVG or image files</div>
    </section>
    <div class="dz-split" data-gsplit="right" title="Drag to resize"></div>
    <aside class="dz-right"><div class="dz-tabs"><button type="button" class="on">Properties</button><span class="grow"></span><button type="button" class="dzi-icon" data-gpanel="right" title="Hide (Ctrl+Alt+])">${glyph('panel-right', 14)}</button></div><div class="dz-pane gx-props"></div></aside>
  </div>`;

  const ed = createGraphicEditor($('.dz-canvas', win.body), { readClipboard: shell?.designer?.clipboard ? () => shell.designer.clipboard() : null });
  $('.dz', win.body).gx = ed; // reachable from the debugging port (Claude Code control)
  createLayers($('.gx-layers', win.body), ed);
  createInspector($('.gx-props', win.body), ed, {
    ask: async (title, detail) => {
      const { ask } = await import('../dialogs.js');
      const r = await ask({ title, detail, win, fields: [{ name: 'v', label: 'Name' }] });
      return r?.values?.v || null;
    },
    chooseImage: async () => {
      const f = await ctx.chooseFile('image/*');
      return f ? ctx.readFileAs(f, 'readAsDataURL') : null;
    },
    onPrefs: () => savePrefs(),
    transformDialog: () => transformSheet(),
  });

  /* ----- panels ----- */
  const PANELS = 'graphic:panels';
  const prefsOf = () => {
    try {
      return JSON.parse(localStorage.getItem(PANELS)) || {};
    } catch {
      return {};
    }
  };
  function applyPanels() {
    const w = prefsOf();
    const dz = $('.dz', win.body);
    if (w.left) $('.dz-left', win.body).style.width = w.left + 'px';
    if (w.right) $('.dz-right', win.body).style.width = w.right + 'px';
    dz.classList.toggle('hide-left', !!w.hideLeft);
    dz.classList.toggle('hide-right', !!w.hideRight);
  }
  function togglePanel(side, hide) {
    const dz = $('.dz', win.body);
    hide ??= !dz.classList.contains('hide-' + side);
    dz.classList.toggle('hide-' + side, hide);
    try {
      localStorage.setItem(PANELS, JSON.stringify({ ...prefsOf(), [side === 'left' ? 'hideLeft' : 'hideRight']: hide }));
    } catch {}
    chrome();
    ed.drawOverlay();
  }
  applyPanels();
  loadPrefs();
  function loadPrefs() {
    const p = prefsOf();
    if (p.snapping === false) ed.snapping = false;
    if (p.scaleStrokes) ed.scaleStrokes = true;
    if (p.pixelSnap) ed.pixelSnap = true;
    if (p.nudgeStep > 0) ed.nudgeStep = p.nudgeStep;
  }
  function savePrefs() {
    try {
      localStorage.setItem(PANELS, JSON.stringify({ ...prefsOf(), snapping: ed.snapping, scaleStrokes: ed.scaleStrokes, pixelSnap: ed.pixelSnap, nudgeStep: ed.nudgeStep }));
    } catch {}
  }

  /* ----- chrome: tool buttons, zoom, undo ----- */
  function chrome() {
    if (destroyed) return;
    win.body.querySelectorAll('[data-gtool]').forEach((b) => b.classList.toggle('on', b.dataset.gtool === ed.tool));
    const z = $('[data-g="zoom"]', win.tools);
    if (z) z.textContent = Math.round(ed.view.z * 100) + '%';
    const u = $('[data-g="undo"]', win.tools);
    if (u) u.disabled = !ed.canUndo;
    const r = $('[data-g="redo"]', win.tools);
    if (r) r.disabled = !ed.canRedo;
    const dz = $('.dz', win.body);
    dz.classList.toggle('rulers', ed.doc?.rulers !== false);
    $('[data-g="left"]', win.tools)?.classList.toggle('on', !dz.classList.contains('hide-left'));
    $('[data-g="right"]', win.tools)?.classList.toggle('on', !dz.classList.contains('hide-right'));
    ctxBar();
    // The fill / stroke chips: the selection's, or what new objects get.
    const n = ed.selected()[0];
    const look = n && n.type !== 'group' ? n : ed.style;
    const fs = $('.gx-fs', win.body);
    if (fs) {
      fs.querySelector('.gx-fs-fill').style.setProperty('--c', look.fill ? D.paintCss(look.fill) : 'transparent');
      fs.querySelector('.gx-fs-fill').classList.toggle('none', !look.fill);
      fs.querySelector('.gx-fs-stroke').style.setProperty('--c', look.stroke ? D.paintCss(look.stroke) : 'transparent');
      fs.querySelector('.gx-fs-stroke').classList.toggle('none', !look.stroke);
    }
  }
  ed.on('change', () => {
    scheduleSave();
    chrome();
  });
  ed.on('view', () => {
    scheduleViewSave();
    chrome();
  });
  ed.on('select', chrome);
  ed.on('tool', chrome);
  ed.on('scope', chrome);
  ed.on('message', (m) => toast(m));

  /* ----- the context bar: where you are (inside which group), the tool's options, and what the modifier keys do ----- */
  const HINTS = {
    select: 'Drag to move · Shift: straight · Alt: a copy · corners turn · a corner’s dot rounds it · double-click: into a group, edit text, edit anchors',
    direct: 'Drag anchors and handles · a corner’s dot rounds it (select several first to round them together) · Shift: add · Alt-click: corner ↔ smooth',
    pen: 'Click: a corner · drag: a curve · Shift: 45° · click the first anchor to close · Enter or Esc: finish · click a path to add or remove anchors',
    pencil: 'Draw freely; it becomes a smooth path · end near the start to close it',
    rect: 'Drag · Shift: a square · Alt: from the center · click: 100 × 100 · the corner handles round it',
    ellipse: 'Drag · Shift: a circle · Alt: from the center · click: 100 × 100',
    polygon: 'Drag · Shift: regular · Alt: from the center',
    star: 'Drag · Shift: regular · Alt: from the center',
    line: 'Drag · Shift: 45° steps · arrowheads are in Stroke',
    text: 'Click: point type (grows as you type) · drag: area type (wraps) · Esc or Ctrl+Enter: done',
    gradient: 'Drag across the selection to lay a gradient · drag the ends and stops · click a shape to pick it',
    scissors: 'Click on a path or an anchor to cut there · live shapes become paths',
    shapebuilder: 'Select two or more overlapping shapes · click a region to make it a shape · drag across regions to merge them · Alt: erase them',
    eyedropper: 'Click an object: its look goes onto the selection (or onto what you draw next)',
    artboard: 'Drag to draw an artboard · drag one to move it (Alt: leave the artwork) · handles resize',
    hand: 'Drag to pan · Space does this from any tool',
    zoom: 'Click: in · Alt-click: out · drag a box to zoom to it · Ctrl+scroll zooms anywhere',
  };
  function ctxBar() {
    const bar = $('.gx-ctxbar', win.body);
    if (!bar || !ed.doc) return;
    // Breadcrumbs: the groups you've gone into.
    const crumbs = [];
    let id = ed.scope;
    while (id) {
      const n = ed.node(id);
      if (!n) break;
      crumbs.unshift(n);
      id = ed.parentOf(id)?.parent?.id || null;
    }
    const sel = ed.selected();
    let where = `<button type="button" class="gx-crumb${crumbs.length ? '' : ' on'}" data-crumb="" title="Back out of the group (Esc or double-click empty space)">${esc(ed.doc.name)}</button>`;
    for (const c of crumbs) where += `<i>›</i><button type="button" class="gx-crumb${c.id === ed.scope ? ' on' : ''}" data-crumb="${c.id}">${esc(c.name)}</button>`;
    let opts = '';
    const t = ed.tool;
    if (t === 'polygon') opts = `<label class="gx-opt">Sides <input type="number" min="3" max="60" value="${ed.polygonSides}" data-opt="polygonSides"></label>`;
    if (t === 'star') opts = `<label class="gx-opt">Points <input type="number" min="3" max="60" value="${ed.starPoints}" data-opt="starPoints"></label>`;
    if (t === 'gradient') opts = `<span class="gx-opt">On</span><div class="dzi-seg words gx-ctxseg">${['fill', 'stroke'].map((w) => `<button type="button" data-gradon="${w}" class="${ed.gradientOn === w ? 'on' : ''}">${w === 'fill' ? 'Fill' : 'Stroke'}</button>`).join('')}</div>`;
    if ((t === 'select' || t === 'direct') && sel.length) {
      const b = D.boundsOf(sel);
      const label = sel.length === 1 ? sel[0].name : `${sel.length} objects`;
      opts = `<span class="gx-opt gx-selinfo" title="Selection"><b>${esc(label)}</b> <span class="gx-muted">${ed.toUnit(b.x2 - b.x1)} × ${ed.toUnit(b.y2 - b.y1)} ${ed.unit()}</span></span>`;
    }
    bar.innerHTML = `<div class="gx-where">${where}</div>${opts}<span class="grow"></span><span class="gx-hintline" title="What this tool does">${esc(HINTS[t] || '')}</span>`;
  }
  on(win.body, 'click', (e) => {
    const c = e.target.closest('[data-crumb]');
    if (c) {
      const id = c.dataset.crumb || null;
      const was = ed.scope;
      ed.scope = id;
      if (was && was !== id) ed.select([was]);
      else ed.select([]);
      chrome();
      return ed.viewport.focus();
    }
    const g = e.target.closest('[data-gradon]');
    if (g) {
      ed.gradientOn = g.dataset.gradon;
      ed.drawOverlay();
      return ctxBar();
    }
  });
  on(win.body, 'change', (e) => {
    const o = e.target.closest('[data-opt]');
    if (!o) return;
    const v = Math.max(3, Math.min(60, Math.round(+o.value) || 3));
    ed[o.dataset.opt] = v;
    // Selected polygons or stars follow.
    const kind = o.dataset.opt === 'polygonSides' ? 'polygon' : 'star';
    const list = ed.selected().filter((n) => n.type === kind);
    if (list.length) {
      ed.checkpoint();
      list.forEach((n) => (kind === 'polygon' ? (n.sides = v) : (n.points = v)));
      ed.commit();
    }
  });

  ed.load(doc);
  chrome();
  ed.viewport.focus({ preventScroll: true });

  /* ----- clicks ----- */
  const onToolsClick = (e) => {
    const b = e.target.closest('[data-g]');
    if (!b || destroyed) return;
    const g = b.dataset.g;
    if (g === 'home') return ctx.home();
    if (g === 'left' || g === 'right') return togglePanel(g);
    if (g === 'undo') return ed.undo();
    if (g === 'redo') return ed.redo();
    if (g === 'export') return exportSheet();
    if (g === 'place') return place();
    if (g.startsWith('menu-')) {
      const r = b.getBoundingClientRect();
      return showMenu(r.left, r.bottom + 4, menus[g.slice(5)](), { owner: b });
    }
    if (g === 'zoom') {
      const r = b.getBoundingClientRect();
      return showMenu(r.left, r.bottom + 4, [
        { label: 'Zoom in', key: 'Ctrl +', act: () => ed.zoomTo(ed.view.z * 1.4) },
        { label: 'Zoom out', key: 'Ctrl −', act: () => ed.zoomTo(ed.view.z / 1.4) },
        '-',
        { label: 'Fit artboard', key: 'Ctrl+0', act: () => ed.fit() },
        { label: 'Fit all', key: 'Ctrl+Alt+0', act: () => ed.fitAll() },
        { label: 'Zoom to selection', act: () => ed.fitSelection(), disabled: !ed.sel.length },
        '-',
        { label: '50%', act: () => ed.zoomTo(0.5) },
        { label: '100%', key: 'Ctrl+1', act: () => ed.zoomTo(1) },
        { label: '200%', act: () => ed.zoomTo(2) },
        { label: '400%', act: () => ed.zoomTo(4) },
        '-',
        { label: ed.outlineMode ? 'Preview view' : 'Outline view', key: 'Ctrl+Y', act: () => toggleOutline() },
      ]);
    }
  };
  const menus = {
    object: () => {
      const sel = ed.selected();
      const some = sel.length > 0;
      const paths = sel.filter((n) => n.type === 'path');
      return [
        { label: 'Group', key: 'Ctrl+G', act: () => ed.group(), disabled: !some },
        { label: 'Ungroup', key: 'Ctrl+Shift+G', act: () => ed.ungroup(), disabled: !sel.some((n) => n.type === 'group') },
        '-',
        { label: 'Transform…', key: 'Ctrl+Shift+M', act: () => transformSheet(), disabled: !some },
        { label: 'Duplicate', key: 'Ctrl+D', act: () => ed.duplicate(), disabled: !some },
        { label: 'Flip Horizontal', act: () => ed.flip('h'), disabled: !some },
        { label: 'Flip Vertical', act: () => ed.flip('v'), disabled: !some },
        { label: 'Rotate 90° Clockwise', act: () => ed.rotate(90), disabled: !some },
        '-',
        { header: 'Arrange' },
        { label: 'Bring to Front', key: 'Ctrl+Shift+]', act: () => ed.arrange('front'), disabled: !some },
        { label: 'Bring Forward', key: 'Ctrl+]', act: () => ed.arrange('forward'), disabled: !some },
        { label: 'Send Backward', key: 'Ctrl+[', act: () => ed.arrange('backward'), disabled: !some },
        { label: 'Send to Back', key: 'Ctrl+Shift+[', act: () => ed.arrange('back'), disabled: !some },
        '-',
        { header: 'Path' },
        { label: 'Make Clipping Mask', key: 'Ctrl+7', act: () => ed.clip(), disabled: sel.length < 2 },
        { label: 'Release Clipping Mask', key: 'Ctrl+Alt+7', act: () => ed.releaseClip(), disabled: !sel.some((n) => n.clip) },
        { label: 'Make Compound Path', key: 'Ctrl+8', act: () => ed.compound(), disabled: sel.length < 2 },
        { label: 'Release Compound Path', act: () => ed.releaseCompound(), disabled: !paths.some((n) => n.subpaths.length > 1) },
        { label: 'Convert to Path', act: () => ed.expand(), disabled: !sel.some((n) => D.SHAPES.includes(n.type)) },
        { label: 'Outline Stroke', act: () => ed.outlineStroke(), disabled: !sel.some((n) => n.stroke && n.sw) },
        { label: 'Simplify', act: () => ed.simplify(), disabled: !paths.length },
        { label: 'Join', key: 'Ctrl+J', act: () => ed.join(), disabled: !paths.length },
        '-',
        { header: 'Pathfinder' },
        { label: 'Unite', act: () => ed.pathfinder('unite'), disabled: sel.length < 2 },
        { label: 'Minus Front', act: () => ed.pathfinder('minus'), disabled: sel.length < 2 },
        { label: 'Intersect', act: () => ed.pathfinder('intersect'), disabled: sel.length < 2 },
        { label: 'Exclude', act: () => ed.pathfinder('exclude'), disabled: sel.length < 2 },
        { label: 'Divide', act: () => ed.pathfinder('divide'), disabled: sel.length < 2 },
        '-',
        { label: 'Crop Picture', act: () => ed.cropImage(), disabled: !sel.some((n) => n.type === 'image') },
        '-',
        { label: 'Lock', key: 'Ctrl+2', act: () => ed.setFlag('locked', true), disabled: !some },
        { label: 'Unlock All', key: 'Ctrl+Alt+2', act: () => ed.unlockAll() },
        { label: 'Hide', key: 'Ctrl+3', act: () => ed.setFlag('hidden', true), disabled: !some },
        { label: 'Show All', key: 'Ctrl+Alt+3', act: () => ed.showAll() },
      ];
    },
    select: () => {
      const some = ed.sel.length > 0;
      const all = () => ed.select((ed.scope ? ed.node(ed.scope).children : ed.doc.nodes).filter((n) => !n.locked && !n.hidden).map((n) => n.id));
      return [
        { label: 'All', key: 'Ctrl+A', act: all },
        { label: 'All on This Artboard', act: () => ed.selectAllOnBoard() },
        { label: 'Deselect', key: 'Ctrl+Shift+A', act: () => ed.select([]), disabled: !some },
        '-',
        { header: 'Same' },
        { label: 'Fill Color', act: () => ed.selectSame('fill'), disabled: !some },
        { label: 'Stroke', act: () => ed.selectSame('stroke'), disabled: !some },
        { label: 'Opacity', act: () => ed.selectSame('opacity'), disabled: !some },
        { label: 'Kind of Object', act: () => ed.selectSame('type'), disabled: !some },
        { label: 'Font', act: () => ed.selectSame('font'), disabled: !ed.selected().some((n) => n.type === 'text') },
        '-',
        { label: 'Unlock All', key: 'Ctrl+Alt+2', act: () => ed.unlockAll() },
        { label: 'Show All', key: 'Ctrl+Alt+3', act: () => ed.showAll() },
      ];
    },
    view: () => [
      { label: 'Zoom In', key: 'Ctrl +', act: () => ed.zoomTo(ed.view.z * 1.4) },
      { label: 'Zoom Out', key: 'Ctrl −', act: () => ed.zoomTo(ed.view.z / 1.4) },
      { label: 'Fit Artboard', key: 'Ctrl+0', act: () => ed.fit() },
      { label: 'Fit All', key: 'Ctrl+Alt+0', act: () => ed.fitAll() },
      { label: 'Actual Size', key: 'Ctrl+1', act: () => ed.zoomTo(1) },
      '-',
      { label: 'Outline View', key: 'Ctrl+Y', checked: ed.outlineMode, act: () => toggleOutline() },
      '-',
      { label: 'Rulers', key: 'Ctrl+R', checked: ed.doc.rulers !== false, act: () => ed.setDocView({ rulers: ed.doc.rulers === false }) },
      { label: 'Show Guides', key: 'Ctrl+;', checked: !ed.doc.guidesHidden, act: () => ed.setDocView({ guidesHidden: !ed.doc.guidesHidden }) },
      { label: 'Lock Guides', key: 'Ctrl+Alt+;', checked: !!ed.doc.guidesLocked, act: () => ed.setDocView({ guidesLocked: !ed.doc.guidesLocked }) },
      { label: 'Guides Around Selection', key: 'Ctrl+5', act: () => ed.guidesAround() },
      { label: 'Clear Guides', act: () => ed.clearGuides(), disabled: !ed.doc.guides?.length },
      '-',
      { label: 'Show Grid', key: "Ctrl+'", checked: !!ed.doc.grid?.show, act: () => ed.setDocView({ grid: { show: !ed.doc.grid?.show } }) },
      { label: 'Snap to Grid', key: "Ctrl+Shift+'", checked: !!ed.doc.grid?.snap, act: () => ed.setDocView({ grid: { snap: !ed.doc.grid?.snap } }) },
      { label: 'Smart Guides', key: 'Ctrl+U', checked: ed.snapping, act: () => ((ed.snapping = !ed.snapping), savePrefs(), chrome()) },
      { label: 'Snap to Pixels', checked: ed.pixelSnap, act: () => ((ed.pixelSnap = !ed.pixelSnap), savePrefs(), chrome()) },
      '-',
      { header: 'Units' },
      ...Object.keys(D.UNITS).map((u) => ({ label: { px: 'Pixels', pt: 'Points', in: 'Inches', mm: 'Millimeters', cm: 'Centimeters' }[u], checked: ed.unit() === u, act: () => ed.setDocView({ units: u }) })),
      '-',
      { label: 'Keyboard Shortcuts…', key: '?', act: () => shortcutsSheet() },
    ],
  };
  const onToolsChange = (e) => {
    if (!e.target.matches('.dz-name') || destroyed) return;
    const v = e.target.value.trim() || 'Untitled artwork';
    ed.checkpoint();
    ed.doc.name = v;
    win.setTitle(v);
    ed.commit({ quiet: true });
  };
  const onToolsKey = (e) => {
    if (e.target.matches('.dz-name') && e.key === 'Enter') ed.viewport.focus();
  };
  on(win.tools, 'click', onToolsClick);
  on(win.tools, 'change', onToolsChange);
  on(win.tools, 'keydown', onToolsKey);

  on(win.body, 'click', (e) => {
    if (destroyed) return;
    const t = e.target.closest('[data-gtool]');
    if (t) {
      ed.setTool(t.dataset.gtool);
      if (t.dataset.gtool === 'polygon' || t.dataset.gtool === 'star') shapeOptions(t);
      return ed.viewport.focus();
    }
    if (e.target.closest('.gx-fs')) return ed.swapFillStroke();
    const p = e.target.closest('[data-gpanel]');
    if (p) togglePanel(p.dataset.gpanel, true);
  });
  /** Polygon sides / star points for the next one you draw (right-click or a second click on the tool). */
  let lastShapeClick = 0;
  function shapeOptions(btn) {
    const again = Date.now() - lastShapeClick < 600;
    lastShapeClick = Date.now();
    if (!again) return;
    const r = btn.getBoundingClientRect();
    const star = btn.dataset.gtool === 'star';
    showMenu(
      r.right + 6,
      r.top,
      [{ header: star ? 'Points' : 'Sides' }, ...[3, 4, 5, 6, 7, 8, 10, 12].map((n) => ({ label: String(n), checked: (star ? ed.starPoints : ed.polygonSides) === n, act: () => (star ? (ed.starPoints = n) : (ed.polygonSides = n)) }))],
    );
  }
  on(win.body, 'contextmenu', (e) => {
    if (destroyed) return;
    const tb = e.target.closest('[data-gtool="polygon"], [data-gtool="star"]');
    if (tb) {
      e.preventDefault();
      lastShapeClick = Date.now();
      return shapeOptions(tb);
    }
    if (!e.target.closest('.gx-viewport')) return;
    e.preventDefault();
    objectMenu(e.clientX, e.clientY, ed);
  });

  on(win.body, 'keydown', (e) => {
    if (destroyed) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault();
      return togglePanel(e.code === 'BracketLeft' ? 'left' : 'right');
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      return exportSheet();
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return toggleOutline();
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      return place();
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      return transformSheet();
    }
    if (e.key === '?' && !ctrl && !e.altKey && !e.target.matches('input, textarea, select, [contenteditable]')) {
      e.preventDefault();
      return shortcutsSheet();
    }
  });

  /* ----- sheets: Transform, Shortcuts ----- */
  function sheet(html, { onOpen, onSubmit, cls = '' } = {}) {
    ed.endText();
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<form class="sheet ld-dialog gx-sheet ${cls}">${html}</form>`;
    win.el.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const form = wrap.firstElementChild;
    const close = () => {
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 180);
      ed.viewport.focus();
    };
    form.addEventListener('click', (e) => e.target.closest('[data-x-cancel]') && close());
    form.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (onSubmit?.(form, e.submitter) !== false) close();
    });
    onOpen?.(form, close);
    return { form, close };
  }
  /** Object › Transform: move, scale and turn the selection by numbers, once or as a row of copies. */
  function transformSheet() {
    if (!ed.sel.length) return toast('Select something to transform');
    const u = ed.unit();
    sheet(
      `<div class="dlg-main"><div class="dlg-text"><h2>Transform</h2>
      <div class="gx-xrow"><span>Move</span><label class="dzi-num"><span class="dzi-l">X</span><input name="dx" value="0" inputmode="decimal"><i>${u}</i></label><label class="dzi-num"><span class="dzi-l">Y</span><input name="dy" value="0" inputmode="decimal"><i>${u}</i></label></div>
      <div class="gx-xrow"><span>Scale</span><label class="dzi-num"><span class="dzi-l">W</span><input name="sx" value="100" inputmode="decimal"><i>%</i></label><label class="dzi-num"><span class="dzi-l">H</span><input name="sy" value="100" inputmode="decimal"><i>%</i></label><label class="gx-check"><input type="checkbox" name="even" checked> Evenly</label></div>
      <div class="gx-xrow"><span>Rotate</span><label class="dzi-num"><span class="dzi-l">${glyph('rotate', 14)}</span><input name="rot" value="0" inputmode="decimal"><i>°</i></label><span class="gx-muted">around the selection's middle</span></div>
      <div class="gx-xrow"><span>Copies</span><label class="dzi-num narrow"><input name="copies" value="0" inputmode="numeric"></label><span class="gx-muted">each one a step further: a row, a ring, a cascade</span></div>
      <p class="gx-xnote">Tip: on the canvas, Ctrl+D after moving a copy repeats that step too.</p>
    </div></div><div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-x-cancel>Cancel</button><button type="submit" class="btn" value="copy">Copy</button><button type="submit" class="btn primary" value="ok">OK</button></div>`,
      {
        onOpen: (form) => {
          form.elements.dx.focus();
          form.elements.dx.select();
          form.addEventListener('input', (e) => {
            if (form.elements.even.checked && (e.target.name === 'sx' || e.target.name === 'sy')) form.elements[e.target.name === 'sx' ? 'sy' : 'sx'].value = e.target.value;
          });
        },
        onSubmit: (form, btn) => {
          const f = form.elements;
          const n = (el, d = 0) => evalNum(el.value) ?? d;
          const dx = ed.fromUnit(n(f.dx));
          const dy = ed.fromUnit(n(f.dy));
          const sx = Math.max(0.01, n(f.sx, 100) / 100);
          const sy = Math.max(0.01, n(f.sy, 100) / 100);
          const rot = n(f.rot);
          let copies = Math.max(0, Math.min(500, Math.round(n(f.copies))));
          if (btn?.value === 'copy' && !copies) copies = 1;
          const b = D.boundsOf(ed.selected());
          const c = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
          const A = G.mul(G.translate(dx, dy), G.mul(G.rotateAt(rot, c.x, c.y), G.scaleAt(sx, sy, c.x, c.y)));
          if (G.isIdentity(A) && !copies) return;
          ed.transformCopies(A, copies);
        },
      },
    );
  }
  function shortcutsSheet() {
    const groups = [
      ['Tools', [['V', 'Selection'], ['A', 'Direct Selection'], ['P', 'Pen'], ['N', 'Pencil'], ['M', 'Rectangle'], ['L', 'Ellipse'], ['\\', 'Line'], ['T', 'Type'], ['G', 'Gradient'], ['C', 'Scissors'], ['Shift+M', 'Shape Builder'], ['I', 'Eyedropper'], ['Shift+O', 'Artboard'], ['H / Space', 'Hand'], ['Z', 'Zoom']]],
      ['Edit', [['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'], ['Ctrl+C / X / V', 'Copy / Cut / Paste (Shift+V: in place)'], ['Ctrl+D', 'Duplicate; again repeats the copy’s move'], ['Delete', 'Delete'], ['Arrows', 'Nudge (Shift: ×10)'], ['Ctrl+A', 'Select all'], ['Ctrl+Shift+A', 'Deselect'], ['Esc', 'Deselect, leave the group, finish the pen'], ['Enter', 'Edit text, go into a group'], ['Ctrl+Shift+M', 'Transform by numbers']]],
      ['Objects', [['Ctrl+G / Ctrl+Shift+G', 'Group / Ungroup'], ['Ctrl+] / Ctrl+[', 'Forward / Backward (Shift: to the front / back)'], ['Ctrl+7', 'Clipping mask (Alt: release)'], ['Ctrl+8', 'Compound path'], ['Ctrl+J', 'Join'], ['Ctrl+2 / Ctrl+Alt+2', 'Lock / Unlock all'], ['Ctrl+3 / Ctrl+Alt+3', 'Hide / Show all'], ['Shift+X', 'Swap fill and stroke'], ['D', 'Default colors']]],
      ['View', [['Ctrl+0', 'Fit artboard'], ['Ctrl+Alt+0', 'Fit all'], ['Ctrl+1', 'Actual size'], ['Ctrl + / −', 'Zoom'], ['Ctrl+scroll', 'Zoom at the pointer'], ['Ctrl+Y', 'Outline view'], ['Ctrl+R', 'Rulers'], ['Ctrl+;', 'Show guides (Alt: lock)'], ['Ctrl+5', 'Guides around the selection'], ["Ctrl+'", 'Grid (Shift: snap to it)'], ['Ctrl+U', 'Smart guides'], ['Ctrl+Alt+[ / ]', 'Hide a panel'], ['Ctrl+Shift+E', 'Export'], ['Ctrl+Shift+P', 'Place']]],
      ['While dragging', [['Shift', 'Constrain: straight, square, 45°, even scale'], ['Alt', 'From the center, a copy, one corner, break a handle'], ['Esc', 'Cancel the drag']]],
    ];
    sheet(
      `<div class="dlg-main"><div class="dlg-text gx-keys"><h2>Keyboard shortcuts</h2><div class="gx-keys-grid">${groups.map(([t, rows]) => `<section><h3>${esc(t)}</h3><dl>${rows.map(([k, l]) => `<dt>${esc(k)}</dt><dd>${esc(l)}</dd>`).join('')}</dl></section>`).join('')}</div></div></div><div class="sheet-foot"><span class="grow"></span><button type="submit" class="btn primary">Done</button></div>`,
      { cls: 'gx-keys-sheet', onOpen: (form) => form.querySelector('[type=submit]').focus() },
    );
  }
  function toggleOutline() {
    ed.outlineMode = !ed.outlineMode;
    ed.render();
    ed.commit({ quiet: true });
  }

  /* ----- resizing panels ----- */
  on(win.body, 'pointerdown', (e) => {
    const sp = e.target.closest('[data-gsplit]');
    if (!sp || destroyed) return;
    const side = sp.dataset.gsplit;
    const panel = $(side === 'left' ? '.dz-left' : '.dz-right', win.body);
    const w0 = panel.getBoundingClientRect().width;
    const x0 = e.clientX;
    sp.setPointerCapture(e.pointerId);
    const move = (ev) => (panel.style.width = Math.max(side === 'left' ? 180 : 240, Math.min(side === 'left' ? 420 : 520, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0))) + 'px');
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      ed.drawOverlay();
      try {
        localStorage.setItem(PANELS, JSON.stringify({ ...prefsOf(), [side]: Math.round(panel.getBoundingClientRect().width) }));
      } catch {}
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });

  /* ----- files: drop and place ----- */
  on(win.body, 'dragover', (e) => {
    if (destroyed || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    $('.dz-drop-hint', win.body).hidden = false;
  });
  on(win.body, 'dragleave', (e) => {
    if (!destroyed && !win.body.contains(e.relatedTarget)) $('.dz-drop-hint', win.body).hidden = true;
  });
  on(win.body, 'drop', async (e) => {
    if (destroyed || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    $('.dz-drop-hint', win.body).hidden = true;
    const at = ed.toWorld(e.clientX, e.clientY);
    for (const f of e.dataTransfer.files) await placeFile(f, at).catch((err) => toast(err.message, 'error'));
  });
  async function placeFile(f, at = 'center') {
    const name = f.name.replace(/\.\w+$/, '');
    if (/svg/.test(f.type) || /\.svg$/i.test(f.name)) return ed.importSvgText(await ctx.readFileAs(f, 'readAsText'), { at, name });
    if (/^image\//.test(f.type)) return ed.importImage(await ctx.readFileAs(f, 'readAsDataURL'), { at: at === 'center' ? null : at, name });
    throw new Error(`${f.name}: Graphic Designer places SVG and image files`);
  }
  async function place() {
    const f = await ctx.chooseFile('image/*,.svg');
    if (!f) return;
    // An image with one shape selected goes inside it (clipped), like Place into a frame.
    const one = ed.sel.length === 1 ? ed.selected()[0] : null;
    if (one && /^image\//.test(f.type) && !/svg/.test(f.type) && one.type !== 'group' && one.type !== 'image' && one.type !== 'text') return ed.placeIn(await ctx.readFileAs(f, 'readAsDataURL'));
    await placeFile(f).catch((err) => toast(err.message, 'error'));
  }

  /* ----- export ----- */
  const exportPrefs = () => {
    try {
      return JSON.parse(localStorage.getItem('graphic:export')) || {};
    } catch {
      return {};
    }
  };
  function exportSheet() {
    ed.endText();
    const p = { format: 'png', what: 'board', scale: 2, clear: false, ...exportPrefs() };
    if (p.what === 'selection' && !ed.sel.length) p.what = 'board';
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<form class="sheet ld-dialog gx-export"><div class="dlg-main"><div class="dlg-text"><h2>Export</h2>
      <div class="gx-xrow"><span>Format</span><div class="dzi-seg gx-xseg" data-x="format">${['png', 'jpg', 'svg', 'pdf'].map((f) => `<button type="button" data-v="${f}" class="${p.format === f ? 'on' : ''}">${f.toUpperCase()}</button>`).join('')}</div></div>
      <div class="gx-xrow"><span>What</span><select class="dzi-select" name="what"><option value="board"${p.what === 'board' ? ' selected' : ''}>This artboard (${esc(ed.currentBoard()?.name || '')})</option><option value="all"${p.what === 'all' ? ' selected' : ''}>All artboards (${ed.doc.artboards.length})</option><option value="selection"${p.what === 'selection' ? ' selected' : ''}${ed.sel.length ? '' : ' disabled'}>The selection</option></select></div>
      <div class="gx-xrow" data-only="png jpg"><span>Size</span><div class="dzi-seg gx-xseg" data-x="scale">${[0.5, 1, 2, 3, 4].map((s) => `<button type="button" data-v="${s}" class="${p.scale === s ? 'on' : ''}">${s}×</button>`).join('')}</div></div>
      <label class="gx-check" data-only="png svg"><input type="checkbox" name="clear"${p.clear ? ' checked' : ''}> Transparent background</label>
      <p class="gx-xnote"></p>
    </div></div><div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-x-cancel>Cancel</button><button type="submit" class="btn primary">Export</button></div></form>`;
    win.el.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const form = wrap.firstElementChild;
    const sync = () => {
      form.querySelectorAll('[data-only]').forEach((x) => (x.hidden = !x.dataset.only.split(' ').includes(p.format)));
      const what = form.elements.what.value;
      const boxes = targets(what);
      const b = boxes[0];
      form.querySelector('.gx-xnote').textContent = b
        ? `${boxes.length > 1 ? boxes.length + ' files, the first ' : ''}${p.format === 'png' || p.format === 'jpg' ? `${Math.round(b.w * p.scale)} × ${Math.round(b.h * p.scale)} pixels` : `${Math.round(b.w)} × ${Math.round(b.h)} px${p.format === 'pdf' ? ` (${(b.w / 96).toFixed(2)} × ${(b.h / 96).toFixed(2)} in)` : ''}`}${p.format === 'pdf' && boxes.length > 1 ? ' — one PDF, a page each' : ''}`
        : 'Nothing to export';
    };
    form.addEventListener('click', (e) => {
      const b = e.target.closest('.gx-xseg [data-v]');
      if (b) {
        const k = b.parentElement.dataset.x;
        p[k] = k === 'scale' ? +b.dataset.v : b.dataset.v;
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        sync();
      }
      if (e.target.closest('[data-x-cancel]')) close();
    });
    form.addEventListener('change', sync);
    const close = () => {
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 180);
      ed.viewport.focus();
    };
    form.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      p.what = form.elements.what.value;
      p.clear = form.elements.clear.checked;
      try {
        localStorage.setItem('graphic:export', JSON.stringify(p));
      } catch {}
      form.classList.add('busy');
      try {
        await runExport(p);
        close();
      } catch (err) {
        form.classList.remove('busy');
        toast(`Couldn’t export: ${err.message}`, 'error');
      }
    });
    sync();
    form.querySelector('[type=submit]').focus();
  }
  /** What to export: [{ name, x, y, w, h, bg, nodes }]. */
  function targets(what) {
    if (what === 'selection') {
      const nodes = ed.selected();
      const b = D.boundsOf(nodes);
      if (G.isEmpty(b)) return [];
      return [{ name: ed.doc.name, x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1, bg: 'transparent', nodes }];
    }
    const boards = what === 'all' ? ed.doc.artboards : [ed.currentBoard()].filter(Boolean);
    return boards.map((b) => ({ name: ed.doc.artboards.length > 1 ? `${ed.doc.name} - ${b.name}` : ed.doc.name, ...b, nodes: ed.doc.nodes }));
  }
  async function runExport(p) {
    const list = targets(p.what);
    if (!list.length) throw new Error('nothing to export');
    const svgOf = (t, scale = 1, clear = false) => D.exportSvg({ nodes: t.nodes }, { artboard: { x: t.x, y: t.y, w: t.w, h: t.h, bg: clear || t.bg === 'transparent' ? null : t.bg }, assets: ed.doc.assets, scale });
    if (p.format === 'svg') {
      for (const t of list) saveBlob(safeName(t.name) + '.svg', new Blob([svgOf(t, 1, p.clear)], { type: 'image/svg+xml' }));
      return toast(list.length > 1 ? `Exported ${list.length} SVG files` : 'Exported SVG');
    }
    if (p.format === 'pdf') {
      if (!shell?.designer?.pdf) throw new Error('PDF export needs the Leafdeck app');
      const bytes = await shell.designer.pdf(list.map((t) => ({ svg: svgOf(t), w: t.w, h: t.h })), ed.doc.name);
      saveBlob(safeName(list.length === 1 ? list[0].name : ed.doc.name) + '.pdf', new Blob([bytes], { type: 'application/pdf' }));
      return toast('Exported PDF');
    }
    const jpg = p.format === 'jpg';
    for (const t of list) {
      const blob = await rasterize(svgOf(t, p.scale, p.clear && !jpg), t.w * p.scale, t.h * p.scale, { type: jpg ? 'image/jpeg' : 'image/png', background: jpg ? (t.bg && t.bg !== 'transparent' ? t.bg.slice(0, 7) : '#ffffff') : null });
      if (!blob) throw new Error('the picture is too big');
      saveBlob(`${safeName(t.name)}${p.scale !== 1 ? `@${p.scale}x` : ''}.${jpg ? 'jpg' : 'png'}`, blob);
    }
    toast(list.length > 1 ? `Exported ${list.length} files` : `Exported ${p.format.toUpperCase()}`);
  }

  /* ----- saving ----- */
  function assetsUsed() {
    const used = new Set();
    D.walk(ed.doc.nodes, (n) => String(n.src || '').startsWith('asset:') && used.add(n.src.slice(6)));
    return used;
  }
  async function save() {
    if (destroyed && !ed.doc) return;
    try {
      const used = assetsUsed();
      const fresh = {};
      for (const a of used) if (!saved.has(a) && ed.doc.assets[a]) fresh[a] = ed.doc.assets[a];
      const { assets, ...rest } = ed.doc;
      void assets;
      await storage.write(id, { ...rest, kind: 'graphic', view: ed.view, updatedAt: Date.now(), version: 1 }, fresh, [...used]);
      Object.keys(fresh).forEach((a) => saved.add(a));
      for (const a of [...saved]) if (!used.has(a)) saved.delete(a);
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => thumb(), 8000);
    } catch (err) {
      toast(`Couldn’t save: ${err.message}`, 'error');
    }
  }
  /** The gallery picture: the first artboard. */
  async function thumb() {
    const b = ed.doc.artboards[0];
    if (!b) return;
    try {
      const s = Math.min(480 / b.w, 300 / b.h, 1);
      const svgText = D.exportSvg(ed.doc, { artboard: b, assets: ed.doc.assets, scale: s });
      const blob = await rasterize(svgText, b.w * s, b.h * s, { background: b.bg === 'transparent' ? null : undefined });
      if (!blob) return;
      const url = await new Promise((r) => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.readAsDataURL(blob);
      });
      await storage.thumb(id, url);
    } catch {}
  }

  return {
    ed,
    save,
    thumb,
    async close() {
      clearTimeout(thumbTimer);
      await save();
      await thumb();
    },
    destroy() {
      destroyed = true;
      clearTimeout(thumbTimer);
      ac.abort();
      ed.destroy();
    },
  };
}
