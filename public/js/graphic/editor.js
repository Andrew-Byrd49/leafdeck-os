// Graphic Designer's canvas: the artwork as live SVG under a screen-space overlay (selection, handles, anchors, guides),
// and every tool: Selection (V), Direct Selection (A), Pen (P), Pencil (N), Rectangle (M), Ellipse (L), Polygon, Star,
// Line (\), Text (T), Gradient (G), Scissors (C), Shape Builder (Shift+M), Eyedropper (I), Artboard (Shift+O), Hand (H),
// Zoom (Z). Also rulers
// (Ctrl+R), guides dragged out of them (Ctrl+; shows them, Ctrl+Alt+; locks them), the grid (Ctrl+', Ctrl+Shift+' snaps)
// and the document's units.
//
// The document model is doc.js; geometry is geom.js. Every change goes checkpoint() → change ed.doc → commit(), which is
// what Undo steps over; commit() redraws and tells the panels ('change').
import * as G from './geom.js';
import * as D from './doc.js';
import { combine, planar, smoothStroke, simplifyPath, outlineStroke } from './bool.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const SNAP = 6; // screen pixels
const HANDLE = 4;
export const TOOLS = ['select', 'direct', 'pen', 'pencil', 'rect', 'ellipse', 'polygon', 'star', 'line', 'text', 'gradient', 'scissors', 'shapebuilder', 'eyedropper', 'artboard', 'hand', 'zoom'];
export const TOOL_KEYS = { v: 'select', a: 'direct', p: 'pen', n: 'pencil', m: 'rect', l: 'ellipse', '\\': 'line', t: 'text', g: 'gradient', c: 'scissors', i: 'eyedropper', h: 'hand', z: 'zoom' };
const RULER = 16; // screen pixels
const GRID = { size: 20, show: false, snap: false };
const DRAWS = ['rect', 'ellipse', 'polygon', 'star', 'line'];

export function createGraphicEditor(host, opts = {}) {
  const handlers = {};
  const emit = (ev, data) => (handlers[ev] || []).forEach((fn) => fn(data));

  host.innerHTML = `<div class="gx-viewport" tabindex="0">
    <svg class="gx-svg" xmlns="${SVGNS}"><g class="gx-view"><g class="gx-boards"></g><g class="gx-grid"></g><g class="gx-art"></g><g class="gx-outlines"></g></g></svg>
    <svg class="gx-overlay" xmlns="${SVGNS}"></svg>
    <div class="gx-labels"></div>
    <textarea class="gx-textedit" spellcheck="false" hidden></textarea>
    <canvas class="gx-ruler gx-ruler-h" title="Drag down for a guide"></canvas><canvas class="gx-ruler gx-ruler-v" title="Drag right for a guide"></canvas><div class="gx-ruler-corner" title="Units (click to change)"></div>
  </div>`;
  const viewport = host.querySelector('.gx-viewport');
  const svg = host.querySelector('.gx-svg');
  const viewG = svg.querySelector('.gx-view');
  const boardsG = svg.querySelector('.gx-boards');
  const artG = svg.querySelector('.gx-art');
  const gridG = svg.querySelector('.gx-grid');
  const rulerH = host.querySelector('.gx-ruler-h');
  const rulerV = host.querySelector('.gx-ruler-v');
  const rulerCorner = host.querySelector('.gx-ruler-corner');
  const overlay = host.querySelector('.gx-overlay');
  const labels = host.querySelector('.gx-labels');
  const textEdit = host.querySelector('.gx-textedit');

  const ed = {
    doc: null,
    sel: [], // object ids
    anchors: new Set(), // Direct Selection: 'id:si:i'
    board: null, // the selected artboard (Artboard tool)
    scope: null, // the group you've gone into (double-click)
    tool: 'select',
    view: { x: 0, y: 0, z: 1 },
    style: { fill: D.solid('#d9d9d9'), stroke: null, sw: 1 },
    font: { ...D.FONT },
    polygonSides: 6,
    starPoints: 5,
    outlineMode: false,
    snapping: true,
    scaleStrokes: false,
    pixelSnap: false, // moves and sizes land on whole pixels
    nudgeStep: 1, // arrow keys, in pixels (Shift: ten times)
    gradientOn: 'fill', // what the Gradient tool edits
    viewport,
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
    },
  };

  /* ---------------- undo ---------------- */

  const undoStack = [];
  const redoStack = [];
  let lastKey = null;
  let lastAt = 0;
  const snapshot = () => JSON.stringify({ nodes: ed.doc.nodes, artboards: ed.doc.artboards, swatches: ed.doc.swatches, guides: ed.doc.guides, name: ed.doc.name, sel: ed.sel });
  /** Before a change. Changes with the same key in quick succession (typing, scrubbing) are one undo step. */
  ed.checkpoint = (key = null) => {
    const now = Date.now();
    if (key && key === lastKey && now - lastAt < 1200) {
      lastAt = now;
      return;
    }
    lastKey = key;
    lastAt = now;
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  };
  const restore = (s) => {
    const o = JSON.parse(s);
    Object.assign(ed.doc, { nodes: o.nodes, artboards: o.artboards, swatches: o.swatches || [], guides: o.guides || [], name: o.name });
    ed.sel = (o.sel || []).filter((id) => ed.node(id));
    ed.anchors.clear();
    if (ed.board && !ed.doc.artboards.some((b) => b.id === ed.board)) ed.board = null;
    if (ed.scope && !ed.node(ed.scope)) ed.scope = null;
    lastKey = null;
    commit();
    emit('select');
  };
  ed.undo = () => {
    endText();
    finishPen();
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  };
  ed.redo = () => {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  };
  Object.defineProperty(ed, 'canUndo', { get: () => undoStack.length > 0 });
  Object.defineProperty(ed, 'canRedo', { get: () => redoStack.length > 0 });

  function commit({ quiet = false } = {}) {
    render();
    if (!quiet) emit('select');
    emit('change');
  }
  ed.commit = commit;

  /* ---------------- lookups ---------------- */

  ed.node = (id) => D.find(ed.doc.nodes, id);
  ed.parentOf = (id) => D.parentOf(ed.doc.nodes, id);
  ed.selected = () => ed.sel.map(ed.node).filter(Boolean);
  ed.boardById = (id) => ed.doc.artboards.find((b) => b.id === id);
  const listOf = (parentId) => (parentId ? ed.node(parentId)?.children : ed.doc.nodes) || ed.doc.nodes;
  /** The document's units: 'px' | 'pt' | 'in' | 'mm' | 'cm'; px per unit; a length shown in them; one parsed from them. */
  ed.unit = () => ed.doc?.units || 'px';
  ed.unitPx = () => D.UNITS[ed.unit()] || 1;
  ed.toUnit = (px, digits = 2) => {
    const v = px / ed.unitPx();
    const d = ed.unit() === 'px' ? 2 : digits;
    return Math.round(v * 10 ** d) / 10 ** d;
  };
  ed.fromUnit = (v) => v * ed.unitPx();
  ed.fmtLen = (px) => `${ed.toUnit(px)} ${ed.unit()}`;
  /** Locked or hidden, itself or through a group it's in. */
  function blocked(id) {
    let p = ed.parentOf(id);
    const n = ed.node(id);
    if (!n || n.locked || n.hidden) return true;
    while (p?.parent) {
      if (p.parent.locked || p.parent.hidden) return true;
      p = ed.parentOf(p.parent.id);
    }
    return false;
  }

  /* ---------------- assets as blob URLs (data URLs in every redraw would be slow) ---------------- */

  const blobUrls = new Map();
  const canvasAssets = new Proxy(
    {},
    {
      get(_, id) {
        if (blobUrls.has(id)) return blobUrls.get(id);
        const data = ed.doc.assets?.[id];
        if (!data) return '';
        try {
          const [head, body] = data.split(',');
          const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
          const bytes = /;base64/.test(head) ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
          const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          blobUrls.set(id, url);
          return url;
        } catch {
          return data;
        }
      },
    },
  );
  ed.addAsset = (dataUrl) => {
    const id = D.newId();
    ed.doc.assets[id] = dataUrl;
    return id;
  };

  /* ---------------- drawing ---------------- */

  function render() {
    if (!ed.doc) return;
    boardsG.innerHTML = ed.doc.artboards
      .map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${b.bg || '#ffffff'}" class="gx-board${b.bg === 'transparent' ? ' clear' : ''}"/>`)
      .join('');
    artG.innerHTML = ed.doc.nodes.map((n) => D.nodeSvg(n, { canvas: true, assets: canvasAssets, hit: 8 / ed.view.z })).join('');
    drawGrid();
    svg.classList.toggle('outline', ed.outlineMode);
    if (editingText) artG.querySelector(`[data-id="${editingText}"] text`)?.setAttribute('visibility', 'hidden');
    drawLabels();
    drawOverlay();
  }
  ed.render = render;

  /** The grid: lines every `size` world units across each artboard (a pattern, so zoom just scales it). */
  function drawGrid() {
    const g = ed.doc.grid || GRID;
    if (!g.show || !(g.size > 0)) return (gridG.innerHTML = '');
    const sz = g.size;
    const major = sz * (g.every || 5);
    gridG.innerHTML =
      `<defs><pattern id="gx-grid-p" width="${sz}" height="${sz}" patternUnits="userSpaceOnUse"><path d="M${sz} 0H0V${sz}" class="gx-grid-line" vector-effect="non-scaling-stroke"/></pattern><pattern id="gx-grid-m" width="${major}" height="${major}" patternUnits="userSpaceOnUse"><path d="M${major} 0H0V${major}" class="gx-grid-line major" vector-effect="non-scaling-stroke"/></pattern></defs>` +
      ed.doc.artboards.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="url(#gx-grid-p)"/><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="url(#gx-grid-m)"/>`).join('');
  }
  function applyView() {
    const v = ed.view;
    viewG.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.z})`);
    viewport.style.setProperty('--z', v.z);
    // Hit areas are in world units: keep them a few screen pixels wide.
    artG.querySelectorAll('.gx-hit').forEach((h) => h.tagName === 'path' && h.setAttribute('stroke-width', 8 / v.z));
    drawLabels();
    drawOverlay();
    if (editingText) placeTextEdit();
    emit('view');
  }

  function drawLabels() {
    drawRulers();
    labels.innerHTML = ed.doc.artboards
      .map((b) => {
        const p = toScreen(b.x, b.y);
        return `<div class="gx-blabel${ed.board === b.id ? ' on' : ''}" data-board="${b.id}" style="left:${p.x}px;top:${p.y - 18}px;max-width:${Math.max(40, b.w * ed.view.z)}px">${escapeHtml(b.name)}</div>`;
      })
      .join('');
  }
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const toScreen = (x, y) => ({ x: x * ed.view.z + ed.view.x, y: y * ed.view.z + ed.view.y });
  ed.toWorld = (cx, cy) => {
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - ed.view.x) / ed.view.z, y: (cy - r.top - ed.view.y) / ed.view.z };
  };
  const pf = (p) => `${G.r2(p.x)},${G.r2(p.y)}`;
  const scrPathD = (subpaths) => {
    const s = G.clonePath(subpaths);
    G.transformPath(s, [ed.view.z, 0, 0, ed.view.z, ed.view.x, ed.view.y]);
    return G.toD(s);
  };

  /** Everything over the artwork: selection boxes, handles, anchors, the pen's rubber band, guides, the marquee. */
  function drawOverlay() {
    if (!ed.doc) return;
    let s = '';
    const z = ed.view.z;
    // Hover outline
    if (hoverId && !ed.sel.includes(hoverId) && !drag) {
      const n = ed.node(hoverId);
      if (n) s += `<path d="${scrPathD(D.outline(n))}" class="gx-ov-hover"/>`;
    }
    const sel = ed.selected();
    const direct = ed.tool === 'direct' || ed.tool === 'pen' || (drag?.kind === 'anchors');
    // Outlines of the selected objects, then their anchors (Direct Selection, Pen) or the box (Selection).
    for (const n of sel) {
      if (n.type !== 'group') s += `<path d="${scrPathD(D.outline(n))}" class="gx-ov-sel"/>`;
      else for (const c of leaves(n)) s += `<path d="${scrPathD(D.outline(c))}" class="gx-ov-sel thin"/>`;
    }
    if (direct) {
      for (const n of sel) for (const leaf of leaves(n)) s += anchorsSvg(leaf);
    } else if (sel.length && ed.tool !== 'artboard' && !editingText) {
      const f = D.selectionFrame(sel);
      if (f) s += boxSvg(f, true);
    }
    if (ed.tool === 'artboard' && ed.board) {
      const b = ed.boardById(ed.board);
      if (b) s += boxSvg({ m: G.translate(b.x, b.y), w: b.w, h: b.h, rot: 0 }, false);
    }
    // The pen's next segment
    if (pen && penHover) {
      const n = ed.node(pen.id);
      const sp = n?.subpaths[pen.si];
      if (sp && !drag) {
        const last = sp.pts[sp.pts.length - 1];
        const a = toScreen(last.x, last.y);
        const c1 = toScreen(last.ox, last.oy);
        const b = toScreen(penHover.x, penHover.y);
        s += `<path d="M${pf(a)}C${pf(c1)} ${pf(b)} ${pf(b)}" class="gx-ov-rubber"/>`;
      }
    }
    if (pencil) s += `<polyline points="${pencil.pts.map((p) => pf(toScreen(p.x, p.y))).join(' ')}" class="gx-ov-pencil" style="stroke:${pencilColor()};stroke-width:${Math.max(1, (ed.style.sw || 1) * z)}"/>`;
    if (marquee) {
      const a = toScreen(marquee.x1, marquee.y1);
      const b = toScreen(marquee.x2, marquee.y2);
      s += `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" class="gx-ov-marquee${marquee.zoom ? ' zoom' : ''}"/>`;
    }
    for (const g of guides) {
      if (g.v != null) {
        const a = toScreen(g.v, g.a);
        const b = toScreen(g.v, g.b);
        s += `<line x1="${a.x}" y1="${a.y - 6}" x2="${b.x}" y2="${b.y + 6}" class="gx-ov-guide"/>`;
      } else {
        const a = toScreen(g.a, g.h);
        const b = toScreen(g.b, g.h);
        s += `<line x1="${a.x - 6}" y1="${a.y}" x2="${b.x + 6}" y2="${b.y}" class="gx-ov-guide"/>`;
      }
    }
    s += guidesSvg();
    if ((direct || (ed.tool === 'select' && sel.length === 1)) && !editingText && !marquee) s += cornerWidgetsSvg(sel, direct);
    if (ed.tool === 'gradient' && !drag?.kind) s += gradientSvg();
    if (ed.tool === 'shapebuilder') s += regionsSvg();
    if (ed.tool === 'select' && sel.length === 1 && sel[0].type === 'rect' && !editingText && !drag) s += cornerHandlesSvg(sel[0]);
    if (cutHover) {
      const a = toScreen(cutHover.x, cutHover.y);
      s += `<circle cx="${a.x}" cy="${a.y}" r="5" class="gx-ov-cut"/><path d="M${a.x - 9} ${a.y}h18M${a.x} ${a.y - 9}v18" class="gx-ov-cut-x"/>`;
    }
    if (sizeTip) s += `<g class="gx-ov-tip" transform="translate(${sizeTip.x} ${sizeTip.y})"><rect x="${-sizeTip.text.length * 3.3 - 6}" y="0" width="${sizeTip.text.length * 6.6 + 12}" height="18" rx="3"/><text x="0" y="13">${escapeHtml(sizeTip.text)}</text></g>`;
    overlay.innerHTML = s;
  }
  ed.drawOverlay = drawOverlay;

  /* ---------------- guides and rulers ---------------- */

  let guideDrag = null; // a guide being pulled out of a ruler, or moved: { v } | { h }
  /** The document's guides (full-width lines), and the one being dragged. */
  function guidesSvg() {
    if (ed.doc.guidesHidden) return '';
    const r = viewport.getBoundingClientRect();
    const grab = ed.tool === 'select' && !ed.doc.guidesLocked;
    let s = '';
    const line = (g, i) => {
      if (g.v != null) {
        const x = g.v * ed.view.z + ed.view.x;
        if (x < -2 || x > r.width + 2) return '';
        return `<line x1="${x}" y1="0" x2="${x}" y2="${r.height}" class="gx-ov-dguide${i == null ? ' new' : ''}"/>${grab && i != null ? `<line x1="${x}" y1="0" x2="${x}" y2="${r.height}" class="gx-ov-dguide-hit" data-guide="${i}"/>` : ''}`;
      }
      const y = g.h * ed.view.z + ed.view.y;
      if (y < -2 || y > r.height + 2) return '';
      return `<line x1="0" y1="${y}" x2="${r.width}" y2="${y}" class="gx-ov-dguide${i == null ? ' new' : ''}"/>${grab && i != null ? `<line x1="0" y1="${y}" x2="${r.width}" y2="${y}" class="gx-ov-dguide-hit" data-guide="${i}"/>` : ''}`;
    };
    (ed.doc.guides || []).forEach((g, i) => (s += line(g, i)));
    if (guideDrag) s += line(guideDrag, null);
    return s;
  }
  ed.addGuide = (g) => {
    ed.checkpoint();
    (ed.doc.guides ||= []).push(g);
    commit({ quiet: true });
  };
  ed.removeGuide = (i) => {
    ed.checkpoint();
    ed.doc.guides.splice(i, 1);
    commit({ quiet: true });
  };
  ed.clearGuides = () => {
    if (!ed.doc.guides?.length) return;
    ed.checkpoint();
    ed.doc.guides = [];
    commit({ quiet: true });
  };
  /** Guides around the selection's box (or the artboard's). */
  ed.guidesAround = () => {
    const sel = ed.selected();
    const b = sel.length ? D.boundsOf(sel) : currentBoard() ? G.rectBox(currentBoard()) : null;
    if (!b || G.isEmpty(b)) return;
    ed.checkpoint();
    (ed.doc.guides ||= []).push({ v: G.r2(b.x1) }, { v: G.r2(b.x2) }, { h: G.r2(b.y1) }, { h: G.r2(b.y2) });
    commit({ quiet: true });
  };
  /** View settings kept in the document (rulers, guides shown or locked, the grid, units): not undo steps. */
  ed.setDocView = (patch) => {
    if (patch.grid) patch = { ...patch, grid: { ...(ed.doc.grid || GRID), ...patch.grid } };
    Object.assign(ed.doc, patch);
    applyRulers();
    render();
    emit('view');
    emit('change');
  };
  function applyRulers() {
    const on = ed.doc?.rulers !== false;
    viewport.classList.toggle('rulers', on);
    if (!on) return;
    const r = viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const size = (c, w, h) => {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    };
    size(rulerH, Math.max(1, r.width - RULER), RULER);
    size(rulerV, RULER, Math.max(1, r.height - RULER));
    rulerCorner.textContent = ed.unit();
    drawRulers();
  }
  /** Rulers in the document's units, zero at the current artboard's top left; the selection shows as a band. */
  function drawRulers() {
    if (!ed.doc || ed.doc.rulers === false) return;
    const dpr = window.devicePixelRatio || 1;
    const cs = getComputedStyle(rulerH);
    const fg = cs.color;
    const bg = cs.backgroundColor;
    const line = cs.borderColor;
    const unit = ed.unitPx();
    const z = ed.view.z;
    const ppu = unit * z; // screen pixels per unit
    const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const step = STEPS.find((st) => st * ppu >= 56) || STEPS[STEPS.length - 1];
    const minor = step / (/^(2|20|200|2000|0\.2|0\.02)$/.test(String(step)) ? 4 : 5);
    const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    const board = currentBoard();
    const ox = board ? board.x : 0;
    const oy = board ? board.y : 0;
    const selB = ed.sel.length ? D.boundsOf(ed.selected()) : null;
    const font = `500 9px ${cs.fontFamily}`;
    const draw = (c, horizontal) => {
      const W = c.width / dpr;
      const H = c.height / dpr;
      const x = c.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = bg;
      x.fillRect(0, 0, W, H);
      x.fillStyle = line;
      if (horizontal) x.fillRect(0, H - 1, W, 1);
      else x.fillRect(W - 1, 0, 1, H);
      const len = horizontal ? W : H;
      const view = horizontal ? ed.view.x - RULER : ed.view.y - RULER;
      const origin = horizontal ? ox : oy;
      if (selB && !G.isEmpty(selB)) {
        const a = (horizontal ? selB.x1 : selB.y1) * z + view;
        const b = (horizontal ? selB.x2 : selB.y2) * z + view;
        x.fillStyle = 'rgba(13, 153, 255, 0.18)';
        if (horizontal) x.fillRect(a, 0, Math.max(1, b - a), H - 1);
        else x.fillRect(0, a, W - 1, Math.max(1, b - a));
      }
      x.fillStyle = fg;
      x.strokeStyle = fg;
      x.font = font;
      x.textBaseline = 'alphabetic';
      // World units from the origin at the ruler's two ends.
      const u0 = ((0 - view) / z - origin) / unit;
      const u1 = ((len - view) / z - origin) / unit;
      const first = Math.floor(u0 / minor) * minor;
      x.beginPath();
      for (let u = first; u <= u1; u += minor) {
        const uu = Math.round(u / minor) * minor; // no drift
        const pos = Math.round((origin + uu * unit) * z + view) + 0.5;
        const major = Math.abs(uu / step - Math.round(uu / step)) < 1e-6;
        const h = major ? 7 : Math.abs((uu / minor) % 2) < 1e-6 && minor * 2 * ppu > 8 ? 4 : 3;
        if (horizontal) {
          x.moveTo(pos, H);
          x.lineTo(pos, H - h);
        } else {
          x.moveTo(W, pos);
          x.lineTo(W - h, pos);
        }
        if (major) {
          const label = (Math.abs(uu) < 1e-9 ? 0 : uu).toFixed(digits);
          if (horizontal) x.fillText(label, pos + 3, 9);
          else {
            x.save();
            x.translate(8, pos - 3);
            x.rotate(-Math.PI / 2);
            x.fillText(label, 0, 0);
            x.restore();
          }
        }
      }
      x.lineWidth = 1;
      x.stroke();
    };
    draw(rulerH, true);
    draw(rulerV, false);
  }
  // Pull a guide out of a ruler.
  for (const [el, horizontalRuler] of [
    [rulerH, true],
    [rulerV, false],
  ]) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      viewport.focus({ preventScroll: true });
      const locked = ed.doc.guidesLocked;
      track(e, {
        move: (ev) => {
          if (locked) return;
          const w = ed.toWorld(ev.clientX, ev.clientY);
          guideDrag = horizontalRuler ? { h: snapGuide(w.y, 'h') } : { v: snapGuide(w.x, 'v') };
          sizeTip = tipAt(ev, ed.fmtLen((horizontalRuler ? guideDrag.h : guideDrag.v) - (horizontalRuler ? currentBoard()?.y || 0 : currentBoard()?.x || 0)));
          drawOverlay();
        },
        up: (ev) => {
          const g = guideDrag;
          guideDrag = null;
          if (!g) return locked ? emit('message', 'Guides are locked (Ctrl+Alt+;)') : null;
          const r = viewport.getBoundingClientRect();
          const inside = ev.clientX - r.left > RULER && ev.clientY - r.top > RULER;
          if (inside) {
            if (ed.doc.guidesHidden) ed.doc.guidesHidden = false;
            ed.addGuide(g);
          }
        },
        cancel: () => {
          guideDrag = null;
        },
      });
    });
  }
  rulerCorner.addEventListener('click', () => {
    const units = Object.keys(D.UNITS);
    ed.setDocView({ units: units[(units.indexOf(ed.unit()) + 1) % units.length] });
    emit('message', `Units: ${ed.unit()}`);
  });
  /** A guide snaps to the artboards' and objects' edges (and whole pixels) as it's dragged. */
  function snapGuide(v, axis) {
    const t = snapTargets([]);
    const list = axis === 'v' ? t.xs : t.ys;
    const tol = SNAP / ed.view.z;
    let best = null;
    for (const c of list) if (!c.g && Math.abs(c.v - v) <= tol && (!best || Math.abs(c.v - v) < Math.abs(best - v))) best = c.v;
    return G.r2(best ?? Math.round(v));
  }
  function startGuideDrag(e, i) {
    const g = ed.doc.guides[i];
    if (!g) return;
    const before = snapshot();
    const r = viewport.getBoundingClientRect();
    let moved = false;
    track(e, {
      move: (ev) => {
        moved = true;
        const w = ed.toWorld(ev.clientX, ev.clientY);
        if (g.v != null) g.v = snapGuide(w.x, 'v');
        else g.h = snapGuide(w.y, 'h');
        sizeTip = tipAt(ev, ed.fmtLen((g.v != null ? g.v : g.h) - (g.v != null ? currentBoard()?.x || 0 : currentBoard()?.y || 0)));
        setCursor(g.v != null ? 'ew-resize' : 'ns-resize');
        drawOverlay();
      },
      up: (ev) => {
        setCursor('');
        if (!moved) return;
        // Dropped back on a ruler (or off the canvas): gone.
        const offX = ev.clientX - r.left < RULER || ev.clientX > r.right;
        const offY = ev.clientY - r.top < RULER || ev.clientY > r.bottom;
        if ((g.v != null && offX) || (g.h != null && offY)) ed.doc.guides.splice(i, 1);
        pushUndo(before);
        commit({ quiet: true });
      },
      cancel: () => {
        setCursor('');
        restoreRaw(before);
      },
    });
  }

  /* ---------------- the Gradient tool's handles ---------------- */

  /** The box a gradient's fractions refer to (SVG's objectBoundingBox): { m: local → world, w, h }. */
  function gradBox(n) {
    if (n.type === 'path') {
      const b = G.pathBox(n.subpaths);
      return { m: G.translate(b.x1, b.y1), w: Math.max(1e-6, b.x2 - b.x1), h: Math.max(1e-6, b.y2 - b.y1) };
    }
    const b = D.boxOf(n);
    return { m: G.frameMatrix(b), w: b.w || 1e-6, h: b.h || 1e-6 };
  }
  /** What the Gradient tool works on: the first selected leaf with a paint, and which of its paints. */
  function gradTarget() {
    const n = ed.selected().flatMap(leaves).find((x) => x.type !== 'group');
    if (!n) return null;
    let which = ed.gradientOn;
    if (n[which]?.type !== 'linear' && n[which]?.type !== 'radial') {
      const other = which === 'fill' ? 'stroke' : 'fill';
      if (n[other]?.type === 'linear' || n[other]?.type === 'radial') which = other;
    }
    if (n.type === 'image' && which === 'fill') which = 'stroke';
    return { n, which, p: n[which] };
  }
  function gradientSvg() {
    const t = gradTarget();
    if (!t || !t.p || t.p.type === 'solid') return '';
    const { n, p } = t;
    const box = gradBox(n);
    const at = (fx, fy) => toScreen(...Object.values(G.ap(box.m, fx * box.w, fy * box.h)));
    let s = '';
    if (p.type === 'linear') {
      const e = D.gradientLine(p);
      const a = at(e.x1, e.y1);
      const b = at(e.x2, e.y2);
      s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="gx-ov-gline"/><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="gx-ov-gline-hit" data-grad="line"/>`;
      s += stopsSvg(a, b, p.stops);
      s += `<circle cx="${a.x}" cy="${a.y}" r="6.5" class="gx-ov-gend" data-grad="p1"/><rect x="${b.x - 6}" y="${b.y - 6}" width="12" height="12" class="gx-ov-gend" data-grad="p2"/>`;
    } else {
      const cx = p.cx ?? 0.5;
      const cy = p.cy ?? 0.5;
      const r = p.r ?? 0.5;
      const c = at(cx, cy);
      const h = at(cx + r, cy);
      // The edge: an ellipse r × box in the object's frame.
      const ring = G.transformPath(G.shapeLocal({ type: 'ellipse', w: 2 * r * box.w, h: 2 * r * box.h }), G.mul(box.m, G.translate((cx - r) * box.w, (cy - r) * box.h)));
      s += `<path d="${scrPathD(ring)}" class="gx-ov-gline"/><line x1="${c.x}" y1="${c.y}" x2="${h.x}" y2="${h.y}" class="gx-ov-gline"/><line x1="${c.x}" y1="${c.y}" x2="${h.x}" y2="${h.y}" class="gx-ov-gline-hit" data-grad="line"/>`;
      s += stopsSvg(c, h, p.stops);
      s += `<circle cx="${c.x}" cy="${c.y}" r="6.5" class="gx-ov-gend" data-grad="c"/><rect x="${h.x - 6}" y="${h.y - 6}" width="12" height="12" class="gx-ov-gend" data-grad="r"/>`;
    }
    return s;
  }

  /** The color stops, hanging just beside the line so the end handles stay free. */
  function stopsSvg(a, b, stops) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * 11;
    const ny = ((b.x - a.x) / len) * 11;
    let s = '';
    stops.forEach((st, i) => {
      const q = { x: a.x + (b.x - a.x) * st.pos + nx, y: a.y + (b.y - a.y) * st.pos + ny };
      s += `<line x1="${q.x - nx * 0.55}" y1="${q.y - ny * 0.55}" x2="${q.x}" y2="${q.y}" class="gx-ov-hline"/><circle cx="${q.x}" cy="${q.y}" r="5" class="gx-ov-gstop" style="fill:${escapeHtml(st.color)}" data-grad="stop:${i}"/>`;
    });
    return s;
  }

  /* ---------------- live corners: a dot by each corner anchor; drag it inward to round that corner ---------------- */

  /** Where a path's corner dots go: the middle of a rounded corner's arc, else a little inside the corner. */
  function cornerSpots(sp, z, only = null) {
    const report = [];
    if (G.hasCorners([sp])) G.roundSubpath(sp, report);
    const out = [];
    sp.pts.forEach((p, i) => {
      if (only && !only.has(i)) return;
      const info = G.cornerInfo(sp, i);
      if (!info) return;
      const at = p.cr > 0 && report[i] ? report[i].mid : { x: p.x + (info.bis.x * 14) / z, y: p.y + (info.bis.y * 14) / z };
      out.push({ i, at, info });
    });
    return out;
  }
  /** A live polygon's or star's vertices as a subpath in world space, without its rounding (the skeleton). */
  const liveSkeleton = (n) => G.transformPath(G.shapeLocal({ ...n, r: 0 }), G.frameMatrix(n))[0];
  function cornerWidgetsSvg(sel, direct) {
    const z = ed.view.z;
    let s = '';
    const dot = (key, at) => {
      const q = toScreen(at.x, at.y);
      return `<circle cx="${q.x}" cy="${q.y}" r="3.5" class="gx-ov-cw" data-cw="${key}"/>`;
    };
    for (const n of sel.flatMap(leaves)) {
      if (blocked(n.id)) continue;
      if (n.type === 'path') {
        if (direct && ed.anchors.size && ![...ed.anchors].some((k) => k.startsWith(n.id + ':'))) continue;
        n.subpaths.forEach((sp, si) => {
          const only = direct && ed.anchors.size ? new Set([...ed.anchors].filter((k) => k.startsWith(`${n.id}:${si}:`)).map((k) => +k.split(':')[2])) : null;
          if (only && !only.size) return;
          for (const c of cornerSpots(sp, z, only)) s += dot(`${n.id}:${si}:${c.i}`, c.at);
        });
      } else if ((n.type === 'polygon' || n.type === 'star') && !direct) {
        const sk = liveSkeleton(n);
        if (n.r > 0) sk.pts.forEach((p) => (p.cr = n.r));
        for (const c of cornerSpots(sk, z)) s += dot(`${n.id}:live:${c.i}`, c.at);
      }
    }
    return s;
  }
  /** The radius the pointer asks for: how far it is from the corner along the inward bisector. */
  function radiusFromPointer(p, w, info) {
    const d = (w.x - p.x) * info.bis.x + (w.y - p.y) * info.bis.y;
    const k = 1 / Math.sin(info.theta / 2) - 1;
    return Math.max(0, Math.min(info.maxR, k > 1e-9 ? d / k : 0));
  }
  function startCornerWidget(e, key) {
    const [id, si, i] = key.split(':');
    const before = snapshot();
    let moved = false;
    if (si === 'live') {
      const n = ed.node(id);
      const sk = liveSkeleton(n);
      const info = G.cornerInfo(sk, +i);
      if (!info) return;
      const v = sk.pts[+i];
      track(e, {
        move: (ev) => {
          moved = true;
          const r = Math.round(radiusFromPointer(v, ed.toWorld(ev.clientX, ev.clientY), info) * 10) / 10;
          n.r = r || undefined;
          if (!r) delete n.r;
          sizeTip = tipAt(ev, `${ed.fmtLen(r)} radius`);
          render();
        },
        up: () => {
          if (!moved) return;
          pushUndo(before);
          commit();
        },
        cancel: () => restoreRaw(before),
      });
      return;
    }
    const n = asPath(id);
    if (!n) return;
    const lead = `${id}:${si}:${i}`;
    // The dragged corner, or every selected corner along with it (they all get the same radius).
    const keys = ed.anchors.has(lead) ? [...ed.anchors] : [lead];
    const sp = n.subpaths[+si];
    const info = G.cornerInfo(sp, +i);
    if (!info) return;
    const v = sp.pts[+i];
    track(e, {
      move: (ev) => {
        moved = true;
        const r = Math.round(radiusFromPointer(v, ed.toWorld(ev.clientX, ev.clientY), info) * 10) / 10;
        setCorners(keys, r);
        sizeTip = tipAt(ev, `${ed.fmtLen(r)} radius`);
        render();
      },
      up: () => {
        if (!moved) return;
        pushUndo(before);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }
  /** Give anchors a corner radius (0 takes it away); each one keeps to what its own segments allow. */
  function setCorners(keys, r) {
    for (const k of keys) {
      const a = parseKey(k);
      const n = asPath(a.id);
      const sp = n?.subpaths[a.si];
      const p = sp?.pts[a.i];
      if (!p) continue;
      const info = G.cornerInfo(sp, a.i);
      if (!info) continue;
      const v = Math.max(0, Math.min(info.maxR, r));
      if (v > 0) p.cr = G.r2(v);
      else delete p.cr;
    }
  }
  /** The Properties panel: a radius for the selected anchors, or for every corner of the selected paths. */
  ed.setCornerRadius = (r, { all = false } = {}) => {
    let keys = [...ed.anchors];
    if (all || !keys.length) {
      keys = [];
      for (const n of ed.selected().flatMap(leaves)) if (n.type === 'path') n.subpaths.forEach((sp, si) => sp.pts.forEach((_, i) => keys.push(`${n.id}:${si}:${i}`)));
    }
    if (!keys.length) return;
    ed.checkpoint('corner-r');
    setCorners(keys, r);
    commit({ quiet: true });
  };
  /** Bake the rounding into real anchors (Illustrator's Expand). */
  ed.expandCorners = () => {
    const paths = ed.selected().flatMap(leaves).filter((n) => n.type === 'path' && G.hasCorners(n.subpaths));
    if (!paths.length) return;
    ed.checkpoint();
    for (const n of paths) n.subpaths = G.roundCorners(n.subpaths);
    ed.anchors.clear();
    commit();
  };

  /** Corner handles on a selected rectangle: drag toward the middle to round it (Alt: just that corner). */
  function cornerHandlesSvg(n) {
    const z = ed.view.z;
    if (Math.min(Math.abs(n.w), Math.abs(n.h)) * z < 40) return '';
    const rr = G.cornerRadii(n);
    const m = G.frameMatrix(n);
    const lim = Math.min(Math.abs(n.w), Math.abs(n.h)) / 2;
    let s = '';
    [
      [0, 0, 1, 1],
      [n.w, 0, -1, 1],
      [n.w, n.h, -1, -1],
      [0, n.h, 1, -1],
    ].forEach(([cx, cy, sx, sy], i) => {
      const ins = Math.min(lim, Math.max(rr[i], 12 / z));
      const p = toScreen(...Object.values(G.ap(m, cx + sx * ins, cy + sy * ins)));
      s += `<circle cx="${p.x}" cy="${p.y}" r="3.5" class="gx-ov-corner" data-corner="${i}"/>`;
    });
    return s;
  }
  function startCorner(e, i) {
    const n = ed.selected()[0];
    if (!n || n.type !== 'rect' || blocked(n.id)) return;
    const before = snapshot();
    const inv = G.inv(G.frameMatrix(n));
    const lim = Math.min(Math.abs(n.w), Math.abs(n.h)) / 2;
    const rr = G.cornerRadii(n);
    track(e, {
      move: (ev) => {
        const l = G.ap(inv, ...Object.values(ed.toWorld(ev.clientX, ev.clientY)));
        const d = [Math.min(l.x, l.y), Math.min(n.w - l.x, l.y), Math.min(n.w - l.x, n.h - l.y), Math.min(l.x, n.h - l.y)][i];
        const r = Math.max(0, Math.min(lim, Math.round(d)));
        if (ev.altKey) {
          n.corners = (n.corners || rr.slice()).slice();
          n.corners[i] = r;
          // Back to one radius when they all agree.
          if (n.corners.every((c) => c === n.corners[0])) {
            n.r = n.corners[0];
            delete n.corners;
          }
        } else {
          n.r = r;
          delete n.corners;
        }
        sizeTip = tipAt(ev, `${ed.fmtLen(r)} ${ev.altKey ? 'corner' : 'radius'}`);
        render();
      },
      up: () => {
        pushUndo(before);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }

  const leaves = (n) => (n.type === 'group' ? n.children.flatMap(leaves) : [n]);

  function anchorsSvg(n) {
    if (n.type !== 'path' && !D.SHAPES.includes(n.type)) return '';
    const sub = n.type === 'path' ? n.subpaths : D.outline(n);
    let s = '';
    sub.forEach((sp, si) =>
      sp.pts.forEach((p, i) => {
        const key = `${n.id}:${si}:${i}`;
        const on = ed.anchors.has(key);
        const a = toScreen(p.x, p.y);
        // Handles show on selected anchors and their neighbors, like Illustrator.
        const near = on || ed.anchors.has(`${n.id}:${si}:${i - 1}`) || ed.anchors.has(`${n.id}:${si}:${i + 1}`) || (sp.closed && (ed.anchors.has(`${n.id}:${si}:${(i + 1) % sp.pts.length}`) || ed.anchors.has(`${n.id}:${si}:${(i - 1 + sp.pts.length) % sp.pts.length}`)));
        const showAll = sel1Path(n) && pen?.id === n.id;
        if ((near || showAll) && n.type === 'path') {
          for (const [hx, hy, which] of [
            [p.ix, p.iy, 'in'],
            [p.ox, p.oy, 'out'],
          ]) {
            if (Math.abs(hx - p.x) < 1e-6 && Math.abs(hy - p.y) < 1e-6) continue;
            const h = toScreen(hx, hy);
            s += `<line x1="${a.x}" y1="${a.y}" x2="${h.x}" y2="${h.y}" class="gx-ov-hline"/><circle cx="${h.x}" cy="${h.y}" r="3.2" class="gx-ov-handle" data-h="${key}:${which}"/>`;
          }
        }
        s += `<rect x="${a.x - HANDLE}" y="${a.y - HANDLE}" width="${HANDLE * 2}" height="${HANDLE * 2}" class="gx-ov-anchor${on ? ' on' : ''}${p.k === 'smooth' ? ' smooth' : ''}" data-a="${key}"/>`;
      }),
    );
    return s;
  }
  const sel1Path = (n) => n.type === 'path';

  /** A turned box with eight handles and a rotation zone at each corner. */
  function boxSvg(f, rotatable) {
    const c = [
      [0, 0, 'nw'],
      [f.w / 2, 0, 'n'],
      [f.w, 0, 'ne'],
      [f.w, f.h / 2, 'e'],
      [f.w, f.h, 'se'],
      [f.w / 2, f.h, 's'],
      [0, f.h, 'sw'],
      [0, f.h / 2, 'w'],
    ];
    const pts = c.map(([x, y, k]) => ({ ...toScreen(...Object.values(G.ap(f.m, x, y))), k }));
    // Rotation zones just outside the corners, under the handles (a handle wins where they overlap).
    let s = '';
    if (rotatable)
      for (const p of pts.filter((q) => q.k.length === 2)) s += `<circle cx="${p.x}" cy="${p.y}" r="16" class="gx-ov-rot" data-rot="${p.k}"/>`;
    s += `<polygon points="${[0, 2, 4, 6].map((i) => pf(pts[i])).join(' ')}" class="gx-ov-box"/>`;
    const small = Math.abs(f.w * ed.view.z) < 24 || Math.abs(f.h * ed.view.z) < 24;
    for (const p of pts) {
      if (small && p.k.length === 1) continue;
      s += `<rect x="${p.x - HANDLE - 1}" y="${p.y - HANDLE - 1}" width="${HANDLE * 2 + 2}" height="${HANDLE * 2 + 2}" class="gx-ov-bh" data-box="${p.k}" style="cursor:${cursorFor(p.k, f.rot)}"/>`;
    }
    return s;
  }
  const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  function cursorFor(k, rot = 0) {
    const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[k];
    const a = (((base + rot) % 180) + 180) % 180;
    return CURSORS[Math.round(a / 45) % 4];
  }

  /* ---------------- view ---------------- */

  ed.zoomAt = (z, sx, sy) => {
    z = Math.max(0.02, Math.min(64, z));
    const v = ed.view;
    v.x = sx - ((sx - v.x) * z) / v.z;
    v.y = sy - ((sy - v.y) * z) / v.z;
    v.z = z;
    render();
    applyView();
  };
  ed.zoomTo = (z) => {
    const r = viewport.getBoundingClientRect();
    ed.zoomAt(z, r.width / 2, r.height / 2);
  };
  /** Fit a world box (default: the current artboard, or everything) in view. */
  ed.fit = (box = null, { max = 4, pad = 60 } = {}) => {
    if (!box) {
      const b = currentBoard();
      box = b ? G.rectBox(b) : D.boundsOf(ed.doc.nodes);
      if (G.isEmpty(box)) box = { x1: 0, y1: 0, x2: 800, y2: 600 };
    }
    const r = viewport.getBoundingClientRect();
    if (!r.width) return;
    const w = Math.max(1, box.x2 - box.x1);
    const h = Math.max(1, box.y2 - box.y1);
    const z = Math.min(max, (r.width - pad * 2) / w, (r.height - pad * 2) / h);
    ed.view = { z, x: r.width / 2 - ((box.x1 + box.x2) / 2) * z, y: r.height / 2 - ((box.y1 + box.y2) / 2) * z };
    render();
    applyView();
  };
  ed.fitSelection = () => {
    const b = D.boundsOf(ed.selected());
    if (!G.isEmpty(b)) ed.fit(b, { max: 16 });
  };
  ed.fitAll = () => {
    let b = D.boundsOf(ed.doc.nodes);
    for (const a of ed.doc.artboards) b = G.union(b, G.rectBox(a));
    ed.fit(G.isEmpty(b) ? null : b);
  };
  /** The artboard in the middle of the view (or the selected one). */
  function currentBoard() {
    if (ed.board) return ed.boardById(ed.board);
    const r = viewport.getBoundingClientRect();
    const c = { x: (r.width / 2 - ed.view.x) / ed.view.z, y: (r.height / 2 - ed.view.y) / ed.view.z };
    const sel = D.boundsOf(ed.selected());
    const at = G.isEmpty(sel) ? c : { x: (sel.x1 + sel.x2) / 2, y: (sel.y1 + sel.y2) / 2 };
    return ed.doc.artboards.find((b) => at.x >= b.x && at.x <= b.x + b.w && at.y >= b.y && at.y <= b.y + b.h) || ed.doc.artboards[0] || null;
  }
  ed.currentBoard = currentBoard;

  /* ---------------- selection ---------------- */

  ed.select = (ids, { add = false } = {}) => {
    ids = ids.filter((id) => ed.node(id));
    ed.sel = add ? [...new Set([...ed.sel, ...ids])] : ids;
    for (const k of [...ed.anchors]) if (!ed.sel.includes(k.split(':')[0])) ed.anchors.delete(k);
    if (ed.sel.length) ed.board = null;
    emit('select');
    drawOverlay();
  };

  /** What a click picks: the object itself (Direct Selection), or its top-most group within the current scope. */
  function pickable(id, deep) {
    if (deep) return id;
    let cur = id;
    for (;;) {
      const p = ed.parentOf(cur);
      if (!p?.parent || p.parent.id === ed.scope) return cur;
      cur = p.parent.id;
    }
  }
  /** The object under a screen point (ignoring locked and hidden ones). */
  function hitAt(cx, cy) {
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (!artG.contains(el)) continue;
      const g = el.closest('[data-id]');
      // The innermost object with an id is the leaf.
      let leaf = g;
      while (leaf && !leaf.dataset.id) leaf = leaf.parentElement;
      if (!leaf) continue;
      const id = leaf.dataset.id;
      if (blocked(id)) continue;
      // In a scope: only things inside it.
      if (ed.scope && !D.find([ed.node(ed.scope)], id)) continue;
      return id;
    }
    return null;
  }

  /* ---------------- inserting, deleting, arranging ---------------- */

  /** Add objects on top of the current scope (or into `into`), select them. */
  ed.insert = (nodes, { into = undefined, select: sel = true } = {}) => {
    const parentId = into === undefined ? ed.scope : into;
    listOf(parentId).push(...nodes);
    if (sel) ed.sel = nodes.map((n) => n.id);
    commit();
  };
  ed.deleteSelection = () => {
    if (ed.board && !ed.sel.length) return deleteBoard(ed.board);
    if (ed.anchors.size) return deleteAnchors();
    if (!ed.sel.length) return;
    ed.checkpoint();
    for (const id of ed.sel) {
      const p = ed.parentOf(id);
      if (p) p.list.splice(p.index, 1);
    }
    cleanupGroups();
    ed.sel = [];
    commit();
  };
  /** Groups left with nothing in them go; clip groups without a mask become groups. */
  function cleanupGroups(list = ed.doc.nodes) {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      if (n.type !== 'group') continue;
      cleanupGroups(n.children);
      if (!n.children.length) list.splice(i, 1);
      else if (n.clip && n.children.length < 2) n.clip = false;
    }
  }

  /** Selected ids in paint order (bottom first), with their places. */
  function ordered(ids = ed.sel) {
    const out = [];
    D.walk(ed.doc.nodes, (n) => {
      if (ids.includes(n.id)) out.push(n.id);
    });
    return out;
  }

  ed.group = () => {
    const ids = ordered();
    if (!ids.length) return;
    ed.checkpoint();
    const first = ed.parentOf(ids[ids.length - 1]);
    const list = first.list;
    const index = list.indexOf(ed.node(ids[ids.length - 1]));
    const nodes = ids.map((id) => ed.node(id));
    const g = D.makeNode('group', { children: nodes });
    // Take them out (keeping the group where the topmost one was).
    for (const id of ids) {
      const p = ed.parentOf(id);
      p.list.splice(p.index, 1);
    }
    list.splice(Math.min(index - (ids.length - 1), list.length), 0, g);
    if (!list.includes(g)) list.push(g);
    cleanupGroups();
    ed.sel = [g.id];
    commit();
  };
  ed.ungroup = () => {
    const groups = ed.selected().filter((n) => n.type === 'group');
    if (!groups.length) return;
    ed.checkpoint();
    const out = [];
    for (const g of groups) {
      const p = ed.parentOf(g.id);
      let kids = g.children;
      if (g.clip && kids.length > 1) kids = kids.slice(); // releasing a clip group keeps the mask as a plain object
      for (const k of kids) {
        if (g.opacity != null && g.opacity < 1) k.opacity = (k.opacity ?? 1) * g.opacity;
      }
      p.list.splice(p.index, 1, ...kids);
      out.push(...kids.map((k) => k.id));
    }
    ed.sel = out;
    if (groups.some((g) => g.id === ed.scope)) ed.scope = null;
    commit();
  };
  /** Bring forward / to front / backward / to back, within each object's own group. */
  ed.arrange = (how) => {
    if (!ed.sel.length) return;
    ed.checkpoint();
    const ids = ordered();
    const list = how === 'front' || how === 'forward' ? ids.slice().reverse() : ids;
    for (const id of list) {
      const p = ed.parentOf(id);
      const n = p.list[p.index];
      const L = p.list;
      L.splice(p.index, 1);
      let to = p.index;
      if (how === 'front') to = L.length;
      if (how === 'back') to = 0;
      if (how === 'forward') to = Math.min(L.length, p.index + 1);
      if (how === 'backward') to = Math.max(0, p.index - 1);
      // Don't hop over another selected object.
      L.splice(to, 0, n);
    }
    commit();
  };

  /**
   * Duplicate (Ctrl+D). Move, turn or scale the copy, and the next Ctrl+D makes another one the same step along: a
   * row, a ring, a cascade (Affinity's Power Duplicate, Illustrator's Transform Again).
   */
  let dup = null; // { ids: the last copies, m: what's been done to them since }
  ed.duplicate = (offset = 10) => {
    const ids = ordered();
    if (!ids.length) return;
    const again = dup && !G.isIdentity(dup.m) && ids.length === dup.ids.length && ids.every((id) => dup.ids.includes(id));
    const A = again ? dup.m : G.translate(offset, offset);
    ed.checkpoint();
    const out = [];
    for (const id of ids) {
      const p = ed.parentOf(id);
      const c = D.transform(D.cloneFresh(ed.node(id)), A, { strokes: again && ed.scaleStrokes });
      p.list.push(c);
      out.push(c.id);
    }
    ed.sel = out;
    // The step so far: the offset the copy got (what's done to it next adds on).
    dup = { ids: out, m: A };
    commit();
    if (!again && !dupHinted) {
      dupHinted = true;
      emit('message', 'Move or turn the copy, then Ctrl+D again repeats that step');
    }
  };
  let dupHinted = false;
  /** A transform done on the canvas: remembered for Ctrl+D when it was done to the last copies. */
  function noteTransform(A, ids = ed.sel) {
    if (dup && ids.length === dup.ids.length && ids.every((id) => dup.ids.includes(id))) dup.m = G.mul(A, dup.m);
    else dup = null;
  }
  /** Move / scale / turn the selection by a matrix, or make `copies` copies each one step further (the Transform dialog). */
  ed.transformCopies = (A, copies = 0) => {
    const ids = ordered();
    if (!ids.length) return;
    if (!copies) return ed.transformSel(A);
    ed.checkpoint();
    const out = [];
    let M = G.I();
    for (let k = 0; k < copies; k++) {
      M = G.mul(A, M);
      for (const id of ids) {
        const p = ed.parentOf(id);
        const c = D.transform(D.cloneFresh(ed.node(id)), M, { strokes: ed.scaleStrokes });
        p.list.push(c);
        out.push(c.id);
      }
    }
    ed.sel = out;
    dup = null;
    commit();
  };

  /* ---------------- transforming the selection ---------------- */

  /** Apply a world transform to the selected objects (replacing any that change type). */
  function transformSel(A, ids = ed.sel) {
    for (const id of ids) {
      const p = ed.parentOf(id);
      if (!p) continue;
      p.list[p.index] = D.transform(p.list[p.index], A, { strokes: ed.scaleStrokes });
    }
  }
  ed.transformSel = (A) => {
    if (!ed.sel.length) return;
    ed.checkpoint();
    transformSel(A);
    noteTransform(A);
    commit();
  };
  const selCenter = () => {
    const b = D.boundsOf(ed.selected());
    return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
  };
  ed.flip = (axis) => {
    const c = selCenter();
    ed.transformSel(axis === 'h' ? G.scaleAt(-1, 1, c.x, c.y) : G.scaleAt(1, -1, c.x, c.y));
  };
  ed.rotate = (deg) => {
    const c = selCenter();
    ed.transformSel(G.rotateAt(deg, c.x, c.y));
  };
  ed.nudge = (dx, dy) => {
    if (ed.anchors.size) {
      ed.checkpoint('nudge');
      moveAnchors([...ed.anchors], dx, dy);
      return commit({ quiet: true });
    }
    if (ed.board && !ed.sel.length) {
      ed.checkpoint('nudge');
      moveBoard(ed.boardById(ed.board), dx, dy);
      return commit({ quiet: true });
    }
    if (!ed.sel.length) return;
    ed.checkpoint('nudge');
    transformSel(G.translate(dx, dy));
    noteTransform(G.translate(dx, dy));
    commit({ quiet: true });
    emit('select');
  };

  /**
   * Set X / Y / W / H / rotation of the selection as a whole (the Transform fields). `ref` is the reference point,
   * 0..8 from the top left to the bottom right (4: the middle): X and Y place it, W and H scale away from it.
   */
  ed.setGeometry = (k, v, { lock = false, ref = 0 } = {}) => {
    const sel = ed.selected();
    if (!sel.length) return;
    const f = D.selectionFrame(sel);
    if (!f) return;
    const fx = (ref % 3) / 2;
    const fy = Math.floor(ref / 3) / 2;
    ed.checkpoint('geom-' + k);
    if (k === 'rot') {
      const c = G.ap(f.m, f.w * fx, f.h * fy);
      transformSel(G.rotateAt(v - f.rot, c.x, c.y));
    } else if (k === 'x' || k === 'y') {
      const b = D.boundsOf(sel);
      const rx = b.x1 + fx * (b.x2 - b.x1);
      const ry = b.y1 + fy * (b.y2 - b.y1);
      transformSel(G.translate(k === 'x' ? v - rx : 0, k === 'y' ? v - ry : 0));
    } else {
      // Scale along the frame's own axes, away from the reference point.
      const sx = k === 'w' ? v / (f.w || 1) : lock ? v / (f.h || 1) : 1;
      const sy = k === 'h' ? v / (f.h || 1) : lock ? v / (f.w || 1) : 1;
      transformSel(G.mul(f.m, G.mul(G.scaleAt(sx, sy, f.w * fx, f.h * fy), G.inv(f.m))));
    }
    commit({ quiet: true });
  };

  /* ---------------- align and distribute ---------------- */

  /** to: 'selection' | 'artboard' | 'key' (the first-picked object stays put). */
  ed.align = (how, to = 'selection') => {
    const sel = ed.selected();
    if (!sel.length) return;
    let ref;
    if (to === 'artboard' || sel.length === 1) {
      const b = currentBoard();
      if (!b) return;
      ref = G.rectBox(b);
    } else if (to === 'key') ref = D.bounds(sel[0]);
    else ref = D.boundsOf(sel);
    ed.checkpoint();
    for (const n of sel) {
      const b = D.bounds(n);
      let dx = 0;
      let dy = 0;
      if (how === 'left') dx = ref.x1 - b.x1;
      if (how === 'hcenter') dx = (ref.x1 + ref.x2) / 2 - (b.x1 + b.x2) / 2;
      if (how === 'right') dx = ref.x2 - b.x2;
      if (how === 'top') dy = ref.y1 - b.y1;
      if (how === 'vcenter') dy = (ref.y1 + ref.y2) / 2 - (b.y1 + b.y2) / 2;
      if (how === 'bottom') dy = ref.y2 - b.y2;
      if (dx || dy) transformSel(G.translate(dx, dy), [n.id]);
    }
    commit();
  };
  /** Even gaps between objects (the outer two stay). */
  ed.distribute = (axis) => {
    const sel = ed.selected();
    if (sel.length < 3) return;
    ed.checkpoint();
    const items = sel.map((n) => ({ n, b: D.bounds(n) })).sort((a, b) => (axis === 'h' ? a.b.x1 - b.b.x1 : a.b.y1 - b.b.y1));
    const size = (b) => (axis === 'h' ? b.x2 - b.x1 : b.y2 - b.y1);
    const start = axis === 'h' ? items[0].b.x1 : items[0].b.y1;
    const end = axis === 'h' ? items[items.length - 1].b.x2 : items[items.length - 1].b.y2;
    const gap = (end - start - items.reduce((t, i) => t + size(i.b), 0)) / (items.length - 1);
    let at = start;
    for (const it of items) {
      const d = at - (axis === 'h' ? it.b.x1 : it.b.y1);
      if (d) transformSel(axis === 'h' ? G.translate(d, 0) : G.translate(0, d), [it.n.id]);
      at += size(it.b) + gap;
    }
    commit();
  };

  /* ---------------- paths: pathfinder, compound, clip, expand ---------------- */

  const shapeOf = (n) => ({ subpaths: D.outline(n), rule: n.fillRule || 'nonzero' });
  ed.pathfinder = async (op) => {
    const ids = ordered();
    const nodes = ids.map(ed.node).filter((n) => n && n.type !== 'image' && n.type !== 'text');
    if (nodes.length < 2) return emit('message', 'Select two or more shapes');
    let result;
    try {
      result = await combine(op, nodes.map((n) => (n.type === 'group' ? { subpaths: D.outline(n), rule: 'nonzero' } : shapeOf(n))));
    } catch (err) {
      return emit('message', err.message);
    }
    ed.checkpoint();
    // The result takes the look of the top shape (bottom one for Minus Front), where the top one was.
    const styleFrom = op === 'minus' ? nodes[0] : nodes[nodes.length - 1];
    const style = { fill: styleFrom.fill ?? null, stroke: styleFrom.stroke ?? null, sw: styleFrom.sw, opacity: styleFrom.opacity, cap: styleFrom.cap, join: styleFrom.join, dash: styleFrom.dash };
    if (styleFrom.type === 'group') Object.assign(style, { fill: leaves(styleFrom)[0]?.fill || D.solid('#d9d9d9'), stroke: leaves(styleFrom)[0]?.stroke || null });
    const top = ed.parentOf(nodes[nodes.length - 1].id);
    const list = top.list;
    let index = top.index;
    for (const n of nodes) {
      const p = ed.parentOf(n.id);
      if (p.list === list && p.index < index) index--;
      p.list.splice(p.index, 1);
    }
    let made;
    if (op === 'divide') {
      const pieces = result.map((sub) => D.makeNode('path', { ...style, subpaths: sub, fillRule: 'nonzero' }));
      made = pieces.length > 1 ? [D.makeNode('group', { children: pieces })] : pieces;
    } else made = result.length ? [D.makeNode('path', { ...style, name: 'Path', subpaths: result, fillRule: 'nonzero' })] : [];
    list.splice(Math.min(index, list.length), 0, ...made);
    cleanupGroups();
    ed.sel = made.map((m) => m.id);
    commit();
    if (!made.length) emit('message', 'Nothing was left');
  };
  /** Make Compound Path: the selected shapes as one path with holes where they overlap (even-odd). */
  ed.compound = () => {
    const ids = ordered();
    const nodes = ids.map(ed.node).filter((n) => n && n.type !== 'image' && n.type !== 'text');
    if (nodes.length < 2) return;
    ed.checkpoint();
    const top = nodes[nodes.length - 1];
    const sub = nodes.flatMap((n) => D.outline(n));
    const made = D.makeNode('path', { fill: nodes[0].fill ?? null, stroke: nodes[0].stroke ?? null, sw: nodes[0].sw, subpaths: sub, fillRule: 'evenodd', name: 'Compound Path' });
    const p = ed.parentOf(top.id);
    p.list.splice(p.index + 1, 0, made);
    for (const n of nodes) {
      const q = ed.parentOf(n.id);
      q.list.splice(q.index, 1);
    }
    cleanupGroups();
    ed.sel = [made.id];
    commit();
  };
  ed.releaseCompound = () => {
    const paths = ed.selected().filter((n) => n.type === 'path' && n.subpaths.length > 1);
    if (!paths.length) return;
    ed.checkpoint();
    const out = [];
    for (const n of paths) {
      const p = ed.parentOf(n.id);
      const parts = n.subpaths.map((sp) => ({ ...structuredClone(n), id: D.newId(), name: 'Path', subpaths: [sp], fillRule: 'nonzero' }));
      p.list.splice(p.index, 1, ...parts);
      out.push(...parts.map((x) => x.id));
    }
    ed.sel = out;
    commit();
  };
  /** Clipping mask: the top selected object cuts the rest to its shape. */
  ed.clip = () => {
    const ids = ordered();
    if (ids.length < 2) return emit('message', 'Select the artwork and, on top of it, the shape to clip it to');
    ed.checkpoint();
    const nodes = ids.map(ed.node);
    const mask = nodes[nodes.length - 1];
    if (mask.type === 'image') return emit('message', 'The top object becomes the mask: use a shape or path');
    const top = ed.parentOf(mask.id);
    const list = top.list;
    let index = top.index;
    for (const n of nodes) {
      const p = ed.parentOf(n.id);
      if (p.list === list && p.index < index) index--;
      p.list.splice(p.index, 1);
    }
    // The mask: no fill or stroke of its own after clipping (as Illustrator does).
    mask.fill = null;
    mask.stroke = null;
    const g = D.makeNode('group', { name: 'Clip Group', clip: true, children: nodes });
    list.splice(Math.min(index, list.length), 0, g);
    cleanupGroups();
    ed.sel = [g.id];
    commit();
  };
  ed.releaseClip = () => {
    const groups = ed.selected().filter((n) => n.type === 'group' && n.clip);
    if (!groups.length) return;
    ed.checkpoint();
    for (const g of groups) {
      g.clip = false;
      g.name = g.name === 'Clip Group' ? 'Group' : g.name;
    }
    commit();
  };
  /** Live shapes → editable paths. */
  ed.expand = () => {
    const shapes = ed.selected().filter((n) => D.SHAPES.includes(n.type));
    if (!shapes.length) return;
    ed.checkpoint();
    for (const n of shapes) {
      const p = ed.parentOf(n.id);
      const path = D.toPath(n);
      path.id = n.id;
      p.list[p.index] = path;
    }
    commit();
  };
  ed.outlineStroke = async () => {
    const nodes = ed.selected().filter((n) => n.stroke && n.sw && n.type !== 'text' && n.type !== 'image' && n.type !== 'group');
    if (!nodes.length) return emit('message', 'Select a shape or path with a stroke');
    const results = [];
    for (const n of nodes) results.push(await outlineStroke(D.outline(n), n.sw, { cap: n.cap, join: n.join }));
    ed.checkpoint();
    const out = [];
    nodes.forEach((n, i) => {
      const p = ed.parentOf(n.id);
      const strokeShape = D.makeNode('path', { name: 'Outlined Stroke', subpaths: results[i], fill: n.stroke, stroke: null, fillRule: 'nonzero', opacity: n.opacity });
      const keep = n.fill ? [{ ...D.toPath(n), stroke: null }] : [];
      const made = keep.length ? [D.makeNode('group', { children: [...keep, strokeShape] })] : [strokeShape];
      p.list.splice(p.index, 1, ...made);
      out.push(...made.map((m) => m.id));
    });
    ed.sel = out;
    commit();
  };
  ed.simplify = async () => {
    const paths = ed.selected().filter((n) => n.type === 'path');
    if (!paths.length) return;
    const res = [];
    for (const n of paths) res.push(await simplifyPath(n.subpaths, 0.6 / Math.max(0.25, ed.view.z)));
    ed.checkpoint();
    paths.forEach((n, i) => (n.subpaths = res[i]));
    ed.anchors.clear();
    commit();
  };
  ed.reversePath = () => {
    const paths = ed.selected().filter((n) => n.type === 'path');
    if (!paths.length) return;
    ed.checkpoint();
    for (const n of paths) n.subpaths.forEach(G.reverseSubpath);
    ed.anchors.clear();
    commit();
  };

  /** Join: the two selected endpoints (one open path, or two) with a straight line; or close an open path. */
  ed.join = () => {
    const ends = [...ed.anchors].map(parseKey).filter((a) => {
      const sp = ed.node(a.id)?.subpaths?.[a.si];
      return sp && !sp.closed && (a.i === 0 || a.i === sp.pts.length - 1);
    });
    const paths = ed.selected().filter((n) => n.type === 'path');
    ed.checkpoint();
    if (ends.length === 2 && ends[0].id === ends[1].id && ends[0].si === ends[1].si) {
      ed.node(ends[0].id).subpaths[ends[0].si].closed = true;
    } else if (ends.length === 2) {
      joinEnds(ends[0], ends[1]);
    } else if (paths.length === 1 && paths[0].subpaths.length === 1 && !paths[0].subpaths[0].closed) {
      paths[0].subpaths[0].closed = true;
    } else if (paths.length === 2 && paths.every((p) => p.subpaths.length === 1 && !p.subpaths[0].closed)) {
      // The nearest ends of two open paths.
      const [a, b] = paths;
      const A = a.subpaths[0].pts;
      const B = b.subpaths[0].pts;
      const opts = [
        [0, 0],
        [0, B.length - 1],
        [A.length - 1, 0],
        [A.length - 1, B.length - 1],
      ].map(([i, j]) => ({ i, j, d: G.dist(A[i], B[j]) }));
      const best = opts.sort((x, y) => x.d - y.d)[0];
      joinEnds({ id: a.id, si: 0, i: best.i }, { id: b.id, si: 0, i: best.j });
    } else {
      undoStack.pop();
      return emit('message', 'Select two endpoints, or an open path');
    }
    ed.anchors.clear();
    commit();
  };
  function joinEnds(a, b) {
    const na = ed.node(a.id);
    const nb = ed.node(b.id);
    const spa = na.subpaths[a.si];
    const spb = nb.subpaths[b.si];
    if (a.i === 0) G.reverseSubpath(spa);
    if (spa === spb) return void (spa.closed = true);
    if (b.i !== 0) G.reverseSubpath(spb);
    const la = spa.pts[spa.pts.length - 1];
    const fb = spb.pts[0];
    if (G.dist(la, fb) < 0.01) {
      la.ox = fb.ox;
      la.oy = fb.oy;
      spa.pts.push(...spb.pts.slice(1));
    } else spa.pts.push(...spb.pts);
    nb.subpaths.splice(b.si, 1);
    if (!nb.subpaths.length && na !== nb) {
      const p = ed.parentOf(nb.id);
      p.list.splice(p.index, 1);
      ed.sel = ed.sel.filter((id) => id !== nb.id);
    }
  }

  /* ---------------- anchors (Direct Selection) ---------------- */

  const parseKey = (k) => {
    const [id, si, i] = k.split(':');
    return { id, si: +si, i: +i };
  };
  /** Live shapes become paths the moment you edit their anchors. */
  function asPath(id) {
    const n = ed.node(id);
    if (!n || n.type === 'path') return n;
    if (!D.SHAPES.includes(n.type)) return null;
    const p = ed.parentOf(id);
    const path = D.toPath(n);
    path.id = n.id;
    p.list[p.index] = path;
    return path;
  }
  function moveAnchors(keys, dx, dy) {
    for (const k of keys) {
      const a = parseKey(k);
      const n = asPath(a.id);
      const p = n?.subpaths[a.si]?.pts[a.i];
      if (!p) continue;
      p.x += dx;
      p.y += dy;
      p.ix += dx;
      p.iy += dy;
      p.ox += dx;
      p.oy += dy;
    }
  }
  function deleteAnchors() {
    ed.checkpoint();
    const byPath = new Map();
    for (const k of ed.anchors) {
      const a = parseKey(k);
      (byPath.get(a.id) || byPath.set(a.id, []).get(a.id)).push(a);
    }
    for (const [id, list] of byPath) {
      const n = asPath(id);
      if (!n) continue;
      const out = [];
      n.subpaths.forEach((sp, si) => {
        const gone = new Set(list.filter((a) => a.si === si).map((a) => a.i));
        if (!gone.size) return out.push(sp);
        // Deleting anchors opens the path there and splits it into runs (Illustrator's behavior).
        const keepRuns = [];
        let run = [];
        const N = sp.pts.length;
        const startAt = sp.closed ? [...Array(N).keys()].find((i) => gone.has(i)) : 0;
        for (let k = 0; k < N; k++) {
          const i = sp.closed ? (startAt + k) % N : k;
          if (gone.has(i)) {
            if (run.length) keepRuns.push(run);
            run = [];
          } else run.push(sp.pts[i]);
        }
        if (run.length) keepRuns.push(run);
        if (!sp.closed && gone.size === 1 && !gone.has(0) && !gone.has(N - 1) && keepRuns.length === 2) {
          // One interior anchor out of an open path: keep it one path (the neighbors join), like Delete Anchor Point.
          out.push({ closed: false, pts: [...keepRuns[0], ...keepRuns[1]] });
          return;
        }
        if (sp.closed && gone.size === 1) {
          out.push({ closed: true, pts: keepRuns[0] });
          return;
        }
        for (const r of keepRuns) if (r.length > 1 || keepRuns.length === 1) out.push({ closed: false, pts: r });
      });
      n.subpaths = out.filter((sp) => sp.pts.length > 1 || (sp.pts.length === 1 && out.length === 1 && false));
      if (!n.subpaths.length) {
        const p = ed.parentOf(id);
        p.list.splice(p.index, 1);
        ed.sel = ed.sel.filter((x) => x !== id);
      }
    }
    ed.anchors.clear();
    cleanupGroups();
    commit();
  }
  /** Alt-click an anchor: smooth ↔ corner. */
  function toggleSmooth(a) {
    const n = asPath(a.id);
    const sp = n.subpaths[a.si];
    const p = sp.pts[a.i];
    const N = sp.pts.length;
    if (G.hasIn(p) || G.hasOut(p)) {
      p.ix = p.ox = p.x;
      p.iy = p.oy = p.y;
      p.k = 'corner';
      return;
    }
    const prev = sp.pts[(a.i - 1 + N) % N];
    const next = sp.pts[(a.i + 1) % N];
    const hasPrev = sp.closed || a.i > 0;
    const hasNext = sp.closed || a.i < N - 1;
    const dx = (hasNext ? next.x : p.x) - (hasPrev ? prev.x : p.x);
    const dy = (hasNext ? next.y : p.y) - (hasPrev ? prev.y : p.y);
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const li = hasPrev ? G.dist(p, prev) / 3 : 0;
    const lo = hasNext ? G.dist(p, next) / 3 : 0;
    p.ix = p.x - ux * li;
    p.iy = p.y - uy * li;
    p.ox = p.x + ux * lo;
    p.oy = p.y + uy * lo;
    p.k = 'smooth';
  }
  ed.anchorMode = (k) => {
    if (!ed.anchors.size) return;
    ed.checkpoint();
    for (const key of ed.anchors) {
      const a = parseKey(key);
      const n = asPath(a.id);
      const p = n?.subpaths[a.si]?.pts[a.i];
      if (!p) continue;
      const smoothNow = G.hasIn(p) || G.hasOut(p);
      if ((k === 'smooth') !== smoothNow) toggleSmooth(a);
    }
    commit();
  };

  /* ---------------- artboards ---------------- */

  ed.addBoard = (o = {}) => {
    ed.checkpoint();
    const last = ed.doc.artboards[ed.doc.artboards.length - 1];
    const w = o.w || last?.w || 1080;
    const h = o.h || last?.h || 1080;
    const b = { id: D.newId(), name: o.name || `Artboard ${ed.doc.artboards.length + 1}`, x: o.x ?? (last ? last.x + last.w + 80 : 0), y: o.y ?? (last ? last.y : 0), w, h, bg: o.bg ?? '#ffffff' };
    ed.doc.artboards.push(b);
    ed.board = b.id;
    ed.sel = [];
    commit();
    return b;
  };
  function deleteBoard(id) {
    if (ed.doc.artboards.length <= 1) return emit('message', 'A document keeps at least one artboard');
    ed.checkpoint();
    ed.doc.artboards = ed.doc.artboards.filter((b) => b.id !== id);
    ed.board = null;
    commit();
  }
  ed.deleteBoard = deleteBoard;
  /** Moving an artboard takes the artwork on it along. */
  function moveBoard(b, dx, dy, carry = null) {
    const items = carry || onBoard(b);
    b.x += dx;
    b.y += dy;
    for (const id of items) {
      const p = ed.parentOf(id);
      if (p) p.list[p.index] = D.transform(p.list[p.index], G.translate(dx, dy));
    }
  }
  const onBoard = (b) => ed.doc.nodes.filter((n) => !n.locked && G.contains(G.rectBox(b), D.bounds(n))).map((n) => n.id);
  ed.setBoard = (id, patch, key = null) => {
    const b = ed.boardById(id);
    if (!b) return;
    ed.checkpoint(key);
    if (('x' in patch || 'y' in patch) && !('w' in patch)) moveBoard(b, (patch.x ?? b.x) - b.x, (patch.y ?? b.y) - b.y);
    Object.assign(b, Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'x' && k !== 'y')));
    commit({ quiet: true });
  };
  ed.boardsArrange = () => {
    ed.checkpoint();
    let x = 0;
    for (const b of ed.doc.artboards) {
      moveBoard(b, x - b.x, 0 - b.y);
      x += b.w + 80;
    }
    commit();
    ed.fitAll();
  };
  /** Fit the artboard to the artwork on it. */
  ed.boardFitArt = (id) => {
    const b = ed.boardById(id);
    const box = D.boundsOf(ed.doc.nodes.filter((n) => !n.hidden && G.overlaps(D.bounds(n), G.rectBox(b))));
    if (G.isEmpty(box)) return;
    ed.checkpoint();
    Object.assign(b, { x: G.r2(box.x1), y: G.r2(box.y1), w: G.r2(box.x2 - box.x1), h: G.r2(box.y2 - box.y1) });
    commit();
  };

  /* ---------------- styles ---------------- */

  /** The look new objects get, from the selection's first object (the inspector's fill/stroke changes follow it). */
  ed.rememberStyle = (n) => {
    if (!n || n.type === 'group' || n.type === 'image') return;
    if (n.type === 'text') {
      ed.font = { ...n.font };
      return;
    }
    ed.style = { fill: structuredClone(n.fill ?? null), stroke: structuredClone(n.stroke ?? null), sw: n.sw ?? 1 };
  };
  ed.swapFillStroke = () => {
    const nodes = ed.selected().flatMap(leaves).filter((n) => n.type !== 'image');
    if (!nodes.length) {
      [ed.style.fill, ed.style.stroke] = [ed.style.stroke, ed.style.fill];
      return emit('select');
    }
    ed.checkpoint();
    for (const n of nodes) [n.fill, n.stroke] = [n.stroke ?? null, n.fill ?? null];
    for (const n of nodes) if (n.stroke && !n.sw) n.sw = 1;
    commit();
  };
  ed.defaultColors = () => {
    const nodes = ed.selected().flatMap(leaves).filter((n) => n.type !== 'image' && n.type !== 'text');
    ed.style = { fill: D.solid('#ffffff'), stroke: D.solid('#000000'), sw: 1 };
    if (!nodes.length) return emit('select');
    ed.checkpoint();
    for (const n of nodes) Object.assign(n, { fill: D.solid('#ffffff'), stroke: D.solid('#000000'), sw: 1 });
    commit();
  };
  const pencilColor = () => (ed.style.stroke?.type === 'solid' ? ed.style.stroke.color : ed.style.fill?.type === 'solid' ? ed.style.fill.color : '#1e1e1e');

  /* ---------------- snapping (smart guides) ---------------- */

  let guides = [];
  let sizeTip = null;
  /** Edges and middles of everything else (and the artboards) to snap to. */
  function snapTargets(skip) {
    const xs = [];
    const ys = [];
    const add = (b) => {
      xs.push({ v: b.x1, b }, { v: (b.x1 + b.x2) / 2, b }, { v: b.x2, b });
      ys.push({ v: b.y1, b }, { v: (b.y1 + b.y2) / 2, b }, { v: b.y2, b });
    };
    for (const a of ed.doc.artboards) add(G.rectBox(a));
    // Guides: no magenta line for these (the guide itself shows), hence g: true.
    if (!ed.doc.guidesHidden)
      for (const g of ed.doc.guides || []) {
        if (g.v != null) xs.push({ v: g.v, b: { x1: g.v, x2: g.v, y1: -1e9, y2: 1e9 }, g: true });
        else ys.push({ v: g.h, b: { y1: g.h, y2: g.h, x1: -1e9, x2: 1e9 }, g: true });
      }
    const skipSet = new Set(skip);
    const visit = (list) => {
      for (const n of list) {
        if (n.hidden || skipSet.has(n.id)) continue;
        if (n.type === 'group' && ed.scope && D.find([n], ed.scope)) visit(n.children);
        else add(D.bounds(n));
      }
    };
    visit(ed.doc.nodes);
    return { xs, ys };
  }
  /** Snap a moving box: returns the offset to add and fills `guides`. */
  function snapBox(box, targets, { xOnly = false, yOnly = false } = {}) {
    guides = [];
    const grid = ed.doc.grid || GRID;
    const gridOn = grid.snap && grid.size > 0;
    if (!ed.snapping && !gridOn && !ed.pixelSnap) return { dx: 0, dy: 0 };
    const tol = SNAP / ed.view.z;
    let best = { x: null, y: null };
    const cand = (mine, list, axis) => {
      if (ed.snapping)
        for (const m of mine)
          for (const t of list) {
            const d = t.v - m;
            if (Math.abs(d) <= tol && (best[axis] == null || Math.abs(d) < Math.abs(best[axis].d))) best[axis] = { d, t, m };
          }
      // The grid: edges to the nearest line (only when nothing closer); whole pixels when that's on.
      const round = gridOn ? grid.size : ed.pixelSnap ? 1 : 0;
      if (round && !best[axis])
        for (const m of [mine[0], mine[mine.length - 1]]) {
          const d = Math.round(m / round) * round - m;
          if (Math.abs(d) <= (gridOn ? tol : 0.5) && (best[axis] == null || Math.abs(d) < Math.abs(best[axis].d))) best[axis] = { d, t: null, m };
        }
    };
    if (!yOnly) cand([box.x1, (box.x1 + box.x2) / 2, box.x2], targets.xs, 'x');
    if (!xOnly) cand([box.y1, (box.y1 + box.y2) / 2, box.y2], targets.ys, 'y');
    const dx = best.x?.d || 0;
    const dy = best.y?.d || 0;
    if (best.x?.t && !best.x.t.g) {
      const v = best.x.t.v;
      guides.push({ v, a: Math.min(box.y1 + dy, best.x.t.b.y1), b: Math.max(box.y2 + dy, best.x.t.b.y2) });
    }
    if (best.y?.t && !best.y.t.g) {
      const h = best.y.t.v;
      guides.push({ h, a: Math.min(box.x1 + dx, best.y.t.b.x1), b: Math.max(box.x2 + dx, best.y.t.b.x2) });
    }
    return { dx, dy };
  }
  /** Snap one point (drawing, the pen, dragging an anchor). */
  function snapPoint(p, targets, skipAnchorsOf = null) {
    guides = [];
    const grid = ed.doc.grid || GRID;
    if (!ed.snapping) {
      if (grid.snap && grid.size > 0) return { x: Math.round(p.x / grid.size) * grid.size, y: Math.round(p.y / grid.size) * grid.size };
      return ed.pixelSnap ? { x: Math.round(p.x), y: Math.round(p.y) } : p;
    }
    const tol = SNAP / ed.view.z;
    // Anchors of other paths first: exact hits.
    let bestA = null;
    D.walk(ed.doc.nodes, (n) => {
      if (n.hidden || n.type !== 'path' || n.id === skipAnchorsOf) return;
      for (const sp of n.subpaths)
        for (const a of sp.pts) {
          const d = G.dist(a, p);
          if (d <= tol && (!bestA || d < bestA.d)) bestA = { d, a };
        }
    });
    if (bestA) return { x: bestA.a.x, y: bestA.a.y };
    const r = snapBox({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }, targets);
    return { x: p.x + r.dx, y: p.y + r.dy };
  }

  /* ---------------- pointer: shared state ---------------- */

  let drag = null;
  let marquee = null;
  let hoverId = null;
  let pen = null; // { id, si } the path the pen is drawing
  let penHover = null;
  let pencil = null;
  let spaceDown = false;
  let editingText = null;
  let cutHover = null; // Scissors: where the next cut lands

  const setCursor = (c) => (viewport.style.cursor = c || '');

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && (spaceDown || ed.tool === 'hand'))) return startPan(e);
    if (e.button !== 0) return;
    if (editingText && e.target === textEdit) return;
    if (editingText) endText();
    viewport.focus({ preventScroll: true });
    const w = ed.toWorld(e.clientX, e.clientY);
    const t = ed.tool;
    const label = e.target.closest?.('[data-board]');
    if (label) return startBoardDrag(e, ed.boardById(label.dataset.board));
    if (t === 'select') return selectDown(e, w);
    if (t === 'direct') return directDown(e, w);
    if (t === 'pen') return penDown(e, w);
    if (t === 'pencil') return pencilDown(e, w);
    if (DRAWS.includes(t)) return drawDown(e, w);
    if (t === 'text') return textDown(e, w);
    if (t === 'gradient') return gradientDown(e, w);
    if (t === 'scissors') return scissorsDown(e, w);
    if (t === 'shapebuilder') return sbDown(e, w);
    if (t === 'eyedropper') return eyedrop(e);
    if (t === 'artboard') return boardDown(e, w);
    if (t === 'zoom') return zoomDown(e, w);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (drag) return drag.move(e);
    const t = ed.tool;
    if (t === 'pen') {
      penHover = snapPoint(ed.toWorld(e.clientX, e.clientY), snapTargets([]), pen?.id);
      penCursor(e);
      return drawOverlay();
    }
    if (t === 'scissors') {
      cutHover = cutTarget(e.clientX, e.clientY, ed.toWorld(e.clientX, e.clientY));
      return drawOverlay();
    }
    if (t === 'shapebuilder') return sbMove(e);
    if (t === 'gradient') {
      const id = e.target.closest?.('[data-grad]') ? null : hitAt(e.clientX, e.clientY);
      const h = id ? pickable(id, false) : null;
      if (h !== hoverId) {
        hoverId = h;
        drawOverlay();
      }
      return;
    }
    if (t === 'select' || t === 'direct') {
      const id = e.target.closest?.('[data-a], [data-h], [data-box], [data-rot], [data-corner], [data-guide], [data-cw]') ? null : hitAt(e.clientX, e.clientY);
      const h = id ? pickable(id, t === 'direct') : null;
      if (h !== hoverId) {
        hoverId = h;
        drawOverlay();
      }
      const gd = e.target.closest?.('[data-guide]');
      setCursor(gd ? (ed.doc.guides[+gd.dataset.guide]?.v != null ? 'ew-resize' : 'ns-resize') : e.target.closest?.('[data-rot]') && !insideSel(e) ? rotateCursor : '');
    }
  });
  viewport.addEventListener('pointerleave', () => {
    if (hoverId || penHover || cutHover) {
      hoverId = null;
      penHover = null;
      cutHover = null;
      drawOverlay();
    }
  });
  function insideSel(e) {
    const f = D.selectionFrame(ed.selected());
    if (!f) return false;
    const w = ed.toWorld(e.clientX, e.clientY);
    const l = G.ap(G.inv(f.m), w.x, w.y);
    return l.x >= 0 && l.x <= f.w && l.y >= 0 && l.y <= f.h;
  }
  const rotateCursor = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 1 2 5" fill="none" stroke="white" stroke-width="4"/><path d="M5 12a7 7 0 1 1 2 5" fill="none" stroke="black" stroke-width="1.6"/><path d="M2 9l3 4 4-3" fill="none" stroke="black" stroke-width="1.6"/></svg>')}") 12 12, crosshair`;

  /** Track a drag on the viewport. move(e), up(e) get the pointer events; Escape cancels. */
  function track(e, { move, up, cancel }) {
    viewport.setPointerCapture(e.pointerId);
    drag = {
      move,
      up: (ev) => {
        drag = null;
        guides = [];
        sizeTip = null;
        up?.(ev);
        drawOverlay();
      },
      cancel: () => {
        drag = null;
        guides = [];
        sizeTip = null;
        cancel?.();
        drawOverlay();
      },
    };
    const onUp = (ev) => {
      viewport.removeEventListener('pointerup', onUp);
      viewport.removeEventListener('pointercancel', onUp);
      drag?.up(ev);
    };
    viewport.addEventListener('pointerup', onUp);
    viewport.addEventListener('pointercancel', onUp);
  }

  function startPan(e) {
    e.preventDefault();
    const x0 = e.clientX - ed.view.x;
    const y0 = e.clientY - ed.view.y;
    viewport.classList.add('panning');
    track(e, {
      move: (ev) => {
        ed.view.x = ev.clientX - x0;
        ed.view.y = ev.clientY - y0;
        applyView();
      },
      up: () => viewport.classList.remove('panning'),
    });
  }

  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const k = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025));
        return ed.zoomAt(ed.view.z * k, e.clientX - r.left, e.clientY - r.top);
      }
      ed.view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      ed.view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      applyView();
    },
    { passive: false },
  );

  /* ---------------- Selection tool ---------------- */

  function selectDown(e, w) {
    const boxH = e.target.closest?.('[data-box]');
    if (boxH) return startScale(e, boxH.dataset.box);
    const cornerH = e.target.closest?.('[data-corner]');
    if (cornerH) return startCorner(e, +cornerH.dataset.corner);
    const cw = e.target.closest?.('[data-cw]');
    if (cw) return startCornerWidget(e, cw.dataset.cw);
    const guideH = e.target.closest?.('[data-guide]');
    if (guideH) return startGuideDrag(e, +guideH.dataset.guide);
    // The rotation zones reach inside the box too: there, a press is on the object.
    const rotH = e.target.closest?.('[data-rot]');
    if (rotH) {
      const f = D.selectionFrame(ed.selected());
      const l = f && G.ap(G.inv(f.m), w.x, w.y);
      if (!l || l.x < 0 || l.x > f.w || l.y < 0 || l.y > f.h) return startRotate(e, w);
    }
    const id = hitAt(e.clientX, e.clientY);
    if (!id) {
      // Inside the selection's box counts as on it (easier to grab thin or empty things).
      const f = ed.sel.length ? D.selectionFrame(ed.selected()) : null;
      if (f && !e.shiftKey) {
        const l = G.ap(G.inv(f.m), w.x, w.y);
        if (l.x >= 0 && l.x <= f.w && l.y >= 0 && l.y <= f.h && (f.w * ed.view.z > 6 || f.h * ed.view.z > 6)) return startMove(e, w);
      }
      return startMarquee(e, w, false);
    }
    const pick = pickable(id, false);
    if (e.shiftKey) {
      ed.select(ed.sel.includes(pick) ? ed.sel.filter((x) => x !== pick) : [...ed.sel, pick]);
      return;
    }
    if (!ed.sel.includes(pick)) ed.select([pick]);
    startMove(e, w);
  }
  // Double-click: into a group, edit text, or edit a path's anchors; on nothing, back out of the group you're in.
  viewport.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || (ed.tool !== 'select' && ed.tool !== 'direct') || e.target.closest?.('[data-a], [data-h], [data-box]')) return;
    const id = hitAt(e.clientX, e.clientY);
    if (!id) {
      if (ed.scope && ed.tool === 'select') {
        const s = ed.scope;
        ed.scope = null;
        emit('scope');
        ed.select([s]);
      }
      return;
    }
    if (ed.tool === 'direct') return ed.node(id)?.type === 'text' && startText(id);
    doubleClick(id, pickable(id, false));
  });
  function doubleClick(id, pick) {
    const n = ed.node(pick);
    if (n?.type === 'group') {
      // Into the group: pick the next level down under the pointer.
      ed.scope = pick;
      emit('scope');
      const inner = pickable(id, false);
      ed.select([inner]);
      return;
    }
    if (n?.type === 'text') return startText(n.id);
    if (n?.type === 'path' || D.SHAPES.includes(n?.type)) {
      ed.setTool('direct');
      ed.select([n.id]);
    }
  }

  function startMove(e, w) {
    const ids = ed.sel.filter((id) => !blocked(id));
    if (!ids.length) return;
    let started = false;
    let copied = false;
    let lastA = null;
    const before = snapshot();
    const orig = ids.map((id) => structuredClone(ed.node(id)));
    const box0 = D.boundsOf(orig);
    const targets = snapTargets(ids);
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        let dx = p.x - w.x;
        let dy = p.y - w.y;
        if (!started && Math.hypot(dx * ed.view.z, dy * ed.view.z) < 3) return;
        if (!started) {
          started = true;
          hoverId = null;
        }
        // Alt: move a copy (the originals go back and stay).
        if (ev.altKey && !copied) {
          copied = true;
          ed.sel = ids.map((id, i) => {
            const p = ed.parentOf(id);
            p.list[p.index] = structuredClone(orig[i]);
            const c = D.cloneFresh(orig[i]);
            p.list.splice(p.index + 1, 0, c);
            return c.id;
          });
        }
        if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        const s = snapBox({ x1: box0.x1 + dx, y1: box0.y1 + dy, x2: box0.x2 + dx, y2: box0.y2 + dy }, targets, { xOnly: ev.shiftKey && dy === 0, yOnly: ev.shiftKey && dx === 0 });
        dx += s.dx;
        dy += s.dy;
        lastA = G.translate(dx, dy);
        (copied ? ed.sel : ids).forEach((id, i) => {
          const p = ed.parentOf(id);
          const c = copied ? reId(structuredClone(orig[i]), ed.node(id)) : structuredClone(orig[i]);
          p.list[p.index] = D.transform(c, lastA);
        });
        sizeTip = tipAt(ev, `${fmtU(dx)}, ${fmtU(dy)}`);
        render();
      },
      up: () => {
        if (!started) {
          // A click on an already-selected object inside a selection: just that one.
          return;
        }
        pushUndo(before);
        if (lastA) noteTransform(lastA, copied ? ed.sel : ids);
        commit();
      },
      cancel: () => {
        restoreRaw(before);
      },
    });
  }
  /** A moved copy keeps the ids it was given when copied. */
  function reId(fresh, existing) {
    const ids = [];
    D.walk([existing], (x) => ids.push(x.id));
    let i = 0;
    D.walk([fresh], (x) => (x.id = ids[i++] || D.newId()));
    return fresh;
  }
  const fmt = (v) => String(Math.round(v * 10) / 10);
  const fmtU = (px) => (ed.unit() === 'px' ? fmt(px) : `${ed.toUnit(px)} ${ed.unit()}`);
  const tipAt = (ev, text) => {
    const r = viewport.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top + 20, text };
  };
  function pushUndo(before) {
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastKey = null;
  }
  function restoreRaw(s) {
    const o = JSON.parse(s);
    Object.assign(ed.doc, { nodes: o.nodes, artboards: o.artboards });
    ed.sel = o.sel.filter((id) => ed.node(id));
    render();
  }

  function startScale(e, k) {
    const ids = ed.sel.filter((id) => !blocked(id));
    if (!ids.length) return;
    const before = snapshot();
    const orig = ids.map((id) => structuredClone(ed.node(id)));
    const f = D.selectionFrame(orig);
    const minv = G.inv(f.m);
    const targets = snapTargets(ids);
    const ax = k.includes('w') ? f.w : k.includes('e') ? 0 : f.w / 2;
    const ay = k.includes('n') ? f.h : k.includes('s') ? 0 : f.h / 2;
    const hx = k.includes('w') ? 0 : k.includes('e') ? f.w : f.w / 2;
    const hy = k.includes('n') ? 0 : k.includes('s') ? f.h : f.h / 2;
    const textOnly = orig.length === 1 && orig[0].type === 'text';
    let lastA = null;
    track(e, {
      move: (ev) => {
        let p = ed.toWorld(ev.clientX, ev.clientY);
        if (!f.rot) p = snapPoint(p, targets);
        const l = G.ap(minv, p.x, p.y);
        const cx = ev.altKey ? f.w / 2 : ax;
        const cy = ev.altKey ? f.h / 2 : ay;
        let sx = k.length === 1 && (k === 'n' || k === 's') ? 1 : (l.x - cx) / (hx - cx || 1);
        let sy = k.length === 1 && (k === 'e' || k === 'w') ? 1 : (l.y - cy) / (hy - cy || 1);
        // Shift (or point text, which keeps its proportions): scale evenly.
        const even = ev.shiftKey !== (textOnly && orig[0].w == null && k.length === 2);
        if (even) {
          if (k.length === 1) k === 'n' || k === 's' ? (sx = Math.abs(sy) * Math.sign(sx || 1)) : (sy = Math.abs(sx) * Math.sign(sy || 1));
          else {
            const s = Math.max(Math.abs(sx), Math.abs(sy));
            sx = s * Math.sign(sx || 1);
            sy = s * Math.sign(sy || 1);
          }
        }
        if (Math.abs(sx) < 1e-4) sx = 1e-4;
        if (Math.abs(sy) < 1e-4) sy = 1e-4;
        const A = G.mul(f.m, G.mul(G.scaleAt(sx, sy, cx, cy), minv));
        lastA = A;
        ids.forEach((id, i) => {
          const p = ed.parentOf(id);
          p.list[p.index] = D.transform(structuredClone(orig[i]), A, { strokes: ed.scaleStrokes });
          // Area text: dragging a side changes the column width, not the type size.
          if (textOnly && orig[0].w != null && (k === 'e' || k === 'w')) {
            const t = p.list[p.index];
            t.font = { ...orig[0].font };
          }
        });
        sizeTip = tipAt(ev, `${fmtU(Math.abs(f.w * sx))} × ${fmtU(Math.abs(f.h * sy))}`);
        render();
      },
      up: () => {
        pushUndo(before);
        if (lastA) noteTransform(lastA, ids);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }

  function startRotate(e, w) {
    const ids = ed.sel.filter((id) => !blocked(id));
    if (!ids.length) return;
    const before = snapshot();
    const orig = ids.map((id) => structuredClone(ed.node(id)));
    const f = D.selectionFrame(orig);
    const c = G.ap(f.m, f.w / 2, f.h / 2);
    const a0 = Math.atan2(w.y - c.y, w.x - c.x);
    let lastA = null;
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        let deg = ((Math.atan2(p.y - c.y, p.x - c.x) - a0) * 180) / Math.PI;
        if (ev.shiftKey) deg = Math.round((deg + f.rot) / 15) * 15 - f.rot;
        const A = G.rotateAt(deg, c.x, c.y);
        lastA = A;
        ids.forEach((id, i) => {
          const q = ed.parentOf(id);
          q.list[q.index] = D.transform(structuredClone(orig[i]), A);
        });
        let shown = (((f.rot + deg) % 360) + 360) % 360;
        if (shown > 180) shown -= 360;
        sizeTip = tipAt(ev, `${fmt(shown)}°`);
        setCursor(rotateCursor);
        render();
      },
      up: () => {
        setCursor('');
        pushUndo(before);
        if (lastA) noteTransform(lastA, ids);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }

  function startMarquee(e, w, direct) {
    const add = e.shiftKey;
    const prev = ed.sel.slice();
    const prevA = new Set(ed.anchors);
    marquee = { x1: w.x, y1: w.y, x2: w.x, y2: w.y };
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        marquee.x2 = p.x;
        marquee.y2 = p.y;
        const box = { x1: Math.min(marquee.x1, p.x), y1: Math.min(marquee.y1, p.y), x2: Math.max(marquee.x1, p.x), y2: Math.max(marquee.y1, p.y) };
        if (direct) {
          // Anchors inside the box; their paths become selected.
          const keys = new Set(add ? prevA : []);
          const ids = new Set(add ? prev : []);
          D.walk(ed.doc.nodes, (n) => {
            if (n.type !== 'path' || blocked(n.id)) return;
            n.subpaths.forEach((sp, si) =>
              sp.pts.forEach((pt, i) => {
                if (pt.x >= box.x1 && pt.x <= box.x2 && pt.y >= box.y1 && pt.y <= box.y2) {
                  keys.add(`${n.id}:${si}:${i}`);
                  ids.add(n.id);
                }
              }),
            );
          });
          D.walk(ed.doc.nodes, (n) => {
            if (n.type !== 'path' && !D.SHAPES.includes(n.type) && n.type !== 'text' && n.type !== 'image') return;
            if (!blocked(n.id) && G.overlaps(D.bounds(n), box) && pathTouches(n, box)) ids.add(n.id);
          });
          ed.anchors = keys;
          ed.sel = [...ids];
        } else {
          const list = ed.scope ? ed.node(ed.scope).children : ed.doc.nodes;
          const hits = list.filter((n) => !n.hidden && !n.locked && G.overlaps(D.bounds(n), box) && touches(n, box)).map((n) => n.id);
          ed.sel = add ? [...new Set([...prev, ...hits])] : hits;
        }
        drawOverlay();
      },
      up: () => {
        marquee = null;
        if (direct && ed.anchors.size) {
          // Anchors only on the paths whose anchors were caught; other touched paths stay selected whole.
        }
        emit('select');
      },
      cancel: () => {
        marquee = null;
        ed.sel = prev;
        ed.anchors = prevA;
      },
    });
  }
  /** Does any part of an object's outline fall in a box (not just its bounds)? */
  function touches(n, box) {
    if (n.type === 'group') return n.children.some((c) => !c.hidden && touches(c, box));
    if (n.type === 'text' || n.type === 'image') return true;
    return pathTouches(n, box);
  }
  function pathTouches(n, box) {
    const sub = D.outline(n);
    const filled = !!n.fill;
    for (const sp of sub)
      for (const s of G.segments(sp))
        for (let k = 0; k <= 12; k++) {
          const p = G.bez(s.p0, s.c1, s.c2, s.p1, k / 12);
          if (p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2) return true;
        }
    // A box inside a filled shape.
    if (filled) {
      const el = artG.querySelector(`[data-id="${n.id}"] path`);
      try {
        const c = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
        const pt = svg.createSVGPoint();
        const m = el?.getCTM();
        const vm = viewG.getCTM();
        if (el && m && vm) {
          const s = G.ap([vm.a, vm.b, vm.c, vm.d, vm.e, vm.f], c.x, c.y);
          pt.x = s.x;
          pt.y = s.y;
          return el.isPointInFill(pt.matrixTransform(m.inverse()));
        }
      } catch {}
    }
    return false;
  }

  /* ---------------- Direct Selection tool ---------------- */

  function directDown(e, w) {
    const cw = e.target.closest?.('[data-cw]');
    if (cw) return startCornerWidget(e, cw.dataset.cw);
    const ah = e.target.closest?.('[data-a]');
    const hh = e.target.closest?.('[data-h]');
    if (hh) return startHandle(e, hh.dataset.h);
    if (ah) {
      const key = ah.dataset.a;
      if (e.altKey) {
        ed.checkpoint();
        toggleSmooth(parseKey(key));
        return commit();
      }
      if (e.shiftKey) {
        ed.anchors.has(key) ? ed.anchors.delete(key) : ed.anchors.add(key);
        emit('select');
        return drawOverlay();
      }
      if (!ed.anchors.has(key)) {
        ed.anchors = new Set([key]);
        emit('select');
      }
      return startAnchorMove(e, w);
    }
    const id = hitAt(e.clientX, e.clientY);
    if (!id) return startMarquee(e, w, true);
    // A click on a path's outline: select it (all its anchors move with a drag).
    if (e.shiftKey) ed.select(ed.sel.includes(id) ? ed.sel.filter((x) => x !== id) : [...ed.sel, id]);
    else if (!ed.sel.includes(id) || ed.sel.length > 1) ed.select([id]);
    ed.anchors.clear();
    drawOverlay();
    startMove(e, w);
  }

  function startAnchorMove(e, w) {
    const before = snapshot();
    const keys = [...ed.anchors];
    keys.forEach((k) => asPath(parseKey(k).id));
    const orig = new Map(keys.map((k) => [k, { ...anchorAt(k) }]));
    const lead = anchorAt(keys[keys.length - 1]) || w;
    const leadKey = keys[keys.length - 1];
    const targets = snapTargets([]);
    let started = false;
    track(e, {
      move: (ev) => {
        let p = ed.toWorld(ev.clientX, ev.clientY);
        if (!started && Math.hypot((p.x - w.x) * ed.view.z, (p.y - w.y) * ed.view.z) < 2) return;
        started = true;
        const o = orig.get(leadKey);
        let target = { x: o.x + p.x - w.x, y: o.y + p.y - w.y };
        if (ev.shiftKey) target = G.constrain45(o, target);
        target = snapPoint(target, targets, keys.length === 1 ? null : parseKey(leadKey).id);
        const dx = target.x - o.x;
        const dy = target.y - o.y;
        for (const k of keys) {
          const a = anchorAt(k);
          const q = orig.get(k);
          if (!a || !q) continue;
          Object.assign(a, { x: q.x + dx, y: q.y + dy, ix: q.ix + dx, iy: q.iy + dy, ox: q.ox + dx, oy: q.oy + dy });
        }
        void lead;
        render();
      },
      up: () => {
        if (!started) return;
        pushUndo(before);
        commit({ quiet: true });
      },
      cancel: () => restoreRaw(before),
    });
  }
  function anchorAt(k) {
    const a = parseKey(k);
    return ed.node(a.id)?.subpaths?.[a.si]?.pts[a.i];
  }

  /** Drag a Bézier handle. Smooth anchors keep the other handle in line (Alt breaks them). */
  function startHandle(e, hkey) {
    const parts = hkey.split(':');
    const which = parts.pop();
    const key = parts.join(':');
    const before = snapshot();
    const a0 = parseKey(key);
    asPath(a0.id);
    const p = anchorAt(key);
    if (!p) return;
    const otherLen = which === 'in' ? Math.hypot(p.ox - p.x, p.oy - p.y) : Math.hypot(p.ix - p.x, p.iy - p.y);
    track(e, {
      move: (ev) => {
        let q = ed.toWorld(ev.clientX, ev.clientY);
        if (ev.shiftKey) q = G.constrain45(p, q);
        if (which === 'in') [p.ix, p.iy] = [q.x, q.y];
        else [p.ox, p.oy] = [q.x, q.y];
        if (ev.altKey) p.k = 'corner';
        else if (p.k === 'smooth') {
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const len = Math.hypot(dx, dy) || 1;
          if (which === 'in') [p.ox, p.oy] = [p.x - (dx / len) * otherLen, p.y - (dy / len) * otherLen];
          else [p.ix, p.iy] = [p.x - (dx / len) * otherLen, p.y - (dy / len) * otherLen];
        }
        render();
      },
      up: () => {
        pushUndo(before);
        commit({ quiet: true });
      },
      cancel: () => restoreRaw(before),
    });
  }

  /* ---------------- Pen tool ---------------- */

  /** What the pen does here: 'close' | 'continue' | 'add' | 'remove' | 'new' (and where). */
  function penTarget(clientX, clientY, w) {
    const tol = 6 / ed.view.z;
    if (pen) {
      const sp = ed.node(pen.id)?.subpaths[pen.si];
      if (sp && sp.pts.length > 1 && G.dist(sp.pts[0], w) <= tol) return { kind: 'close' };
    }
    const sel = ed.selected().filter((n) => n.type === 'path');
    for (const n of sel) {
      for (let si = 0; si < n.subpaths.length; si++) {
        const sp = n.subpaths[si];
        for (let i = 0; i < sp.pts.length; i++) {
          if (G.dist(sp.pts[i], w) > tol) continue;
          const end = !sp.closed && (i === 0 || i === sp.pts.length - 1);
          if (pen && pen.id === n.id && pen.si === si) continue;
          if (end && !pen) return { kind: 'continue', id: n.id, si, i };
          if (!pen) return { kind: 'remove', id: n.id, si, i };
        }
      }
      if (!pen) {
        const near = G.nearestOnPath(n.subpaths, w.x, w.y);
        if (near && near.d <= tol && near.t > 0.02 && near.t < 0.98) return { kind: 'add', id: n.id, ...near };
      }
    }
    return { kind: 'new' };
  }
  function penCursor(e) {
    const t = penTarget(e.clientX, e.clientY, ed.toWorld(e.clientX, e.clientY));
    viewport.dataset.pen = t.kind;
  }

  function penDown(e, w) {
    const t = penTarget(e.clientX, e.clientY, w);
    if (t.kind === 'add') {
      ed.checkpoint();
      const idx = G.insertAnchor(ed.node(t.id).subpaths, t.si, t.seg, t.t);
      ed.anchors = new Set([`${t.id}:${t.si}:${idx}`]);
      return commit();
    }
    if (t.kind === 'remove') {
      ed.anchors = new Set([`${t.id}:${t.si}:${t.i}`]);
      const n = ed.node(t.id);
      // Removing an anchor keeps the path whole.
      ed.checkpoint();
      const sp = n.subpaths[t.si];
      if (sp.pts.length <= 2) {
        ed.anchors.clear();
        undoStack.pop();
        return;
      }
      sp.pts.splice(t.i, 1);
      ed.anchors.clear();
      return commit();
    }
    if (t.kind === 'continue') {
      const n = ed.node(t.id);
      const sp = n.subpaths[t.si];
      ed.checkpoint();
      if (t.i === 0) G.reverseSubpath(sp);
      pen = { id: n.id, si: t.si };
      commit();
      return;
    }
    const before = snapshot();
    const targets = snapTargets([]);
    let p0 = snapPoint(w, targets, pen?.id);
    let n;
    let sp;
    let a;
    if (t.kind === 'close') {
      n = ed.node(pen.id);
      sp = n.subpaths[pen.si];
      a = sp.pts[0];
      sp.closed = true;
    } else {
      if (pen) {
        n = ed.node(pen.id);
        sp = n.subpaths[pen.si];
        if (e.shiftKey) p0 = G.constrain45(sp.pts[sp.pts.length - 1], p0);
        a = G.anchor(p0.x, p0.y);
        sp.pts.push(a);
      } else {
        a = G.anchor(p0.x, p0.y);
        n = D.makeNode('path', { subpaths: [{ closed: false, pts: [a] }], fill: ed.style.fill && ed.style.stroke ? structuredClone(ed.style.fill) : null, stroke: structuredClone(ed.style.stroke || D.solid('#1e1e1e')), sw: ed.style.sw || 1 });
        listOf(ed.scope).push(n);
        ed.sel = [n.id];
        pen = { id: n.id, si: 0 };
      }
    }
    const closing = t.kind === 'close';
    const ox = a.ox;
    const oy = a.oy;
    render();
    track(e, {
      move: (ev) => {
        let q = ed.toWorld(ev.clientX, ev.clientY);
        if (ev.shiftKey) q = G.constrain45(a, q);
        // Dragging pulls out the handles: out toward the pointer, in mirrored (Alt: only this side).
        if (closing) {
          a.ix = 2 * a.x - q.x;
          a.iy = 2 * a.y - q.y;
          if (!ev.altKey) [a.ox, a.oy] = [q.x, q.y];
          else [a.ox, a.oy] = [ox, oy];
        } else {
          a.ox = q.x;
          a.oy = q.y;
          if (!ev.altKey) [a.ix, a.iy] = [2 * a.x - q.x, 2 * a.y - q.y];
        }
        a.k = ev.altKey ? 'corner' : 'smooth';
        render();
      },
      up: () => {
        pushUndo(before);
        if (closing) pen = null;
        commit();
      },
      cancel: () => {
        restoreRaw(before);
        if (!ed.node(pen?.id)) pen = null;
      },
    });
  }
  /** Stop drawing (Enter, Escape, another tool). A path of one anchor goes away. */
  function finishPen() {
    if (!pen) return;
    const n = ed.node(pen.id);
    pen = null;
    penHover = null;
    if (n && n.subpaths.every((sp) => sp.pts.length < 2)) {
      const p = ed.parentOf(n.id);
      p.list.splice(p.index, 1);
      ed.sel = [];
      commit();
    } else drawOverlay();
  }
  ed.finishPen = finishPen;

  /* ---------------- Pencil tool ---------------- */

  function pencilDown(e, w) {
    pencil = { pts: [w] };
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        const last = pencil.pts[pencil.pts.length - 1];
        if (G.dist(last, p) * ed.view.z >= 1.5) pencil.pts.push(p);
        drawOverlay();
      },
      up: async () => {
        const pts = pencil.pts;
        pencil = null;
        drawOverlay();
        if (pts.length < 2) return;
        const closed = pts.length > 8 && G.dist(pts[0], pts[pts.length - 1]) * ed.view.z < 10;
        let subpaths;
        try {
          subpaths = await smoothStroke(pts, 2.5 / ed.view.z, closed);
        } catch {
          subpaths = [{ closed, pts: pts.map((p) => G.anchor(p.x, p.y)) }];
        }
        subpaths.forEach(G.markSmooth);
        ed.checkpoint();
        const n = D.makeNode('path', { subpaths, fill: closed && ed.style.fill && ed.style.stroke ? structuredClone(ed.style.fill) : null, stroke: structuredClone(ed.style.stroke || ed.style.fill || D.solid('#1e1e1e')), sw: ed.style.sw || 1, cap: 'round', join: 'round' });
        ed.insert([n]);
      },
      cancel: () => {
        pencil = null;
      },
    });
  }

  /* ---------------- Shape and Line tools ---------------- */

  function drawDown(e, w) {
    const t = ed.tool;
    const targets = snapTargets([]);
    const start = snapPoint(w, targets);
    let n = null;
    const before = snapshot();
    track(e, {
      move: (ev) => {
        let p = snapPoint(ed.toWorld(ev.clientX, ev.clientY), targets);
        if (!n && Math.hypot((p.x - start.x) * ed.view.z, (p.y - start.y) * ed.view.z) < 3) return;
        if (t === 'line') {
          if (ev.shiftKey) p = G.constrain45(start, p);
          if (!n) {
            n = D.makeNode('path', { name: 'Line', subpaths: [{ closed: false, pts: [G.anchor(start.x, start.y), G.anchor(p.x, p.y)] }], fill: null, stroke: structuredClone(ed.style.stroke || ed.style.fill || D.solid('#1e1e1e')), sw: ed.style.sw || 1 });
            listOf(ed.scope).push(n);
            ed.sel = [n.id];
          }
          Object.assign(n.subpaths[0].pts[1], G.anchor(p.x, p.y));
          sizeTip = tipAt(ev, `${fmt(G.dist(start, p))} · ${fmt((-Math.atan2(p.y - start.y, p.x - start.x) * 180) / Math.PI)}°`);
          return render();
        }
        let dx = p.x - start.x;
        let dy = p.y - start.y;
        if (ev.shiftKey) {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          dx = s * Math.sign(dx || 1);
          dy = s * Math.sign(dy || 1);
        }
        let x1 = start.x;
        let y1 = start.y;
        let x2 = start.x + dx;
        let y2 = start.y + dy;
        if (ev.altKey) {
          x1 = start.x - dx;
          y1 = start.y - dy;
        }
        const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        if (!n) {
          n = newShape(t, box);
          listOf(ed.scope).push(n);
          ed.sel = [n.id];
        }
        Object.assign(n, box);
        sizeTip = tipAt(ev, `${fmtU(box.w)} × ${fmtU(box.h)}`);
        render();
      },
      up: () => {
        if (!n) {
          // A click: a 100 × 100 shape there.
          ed.checkpoint();
          const m = t === 'line' ? null : newShape(t, { x: start.x - 50, y: start.y - 50, w: 100, h: 100 });
          if (m) ed.insert([m]);
          return;
        }
        pushUndo(before);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }
  function newShape(t, box) {
    const o = { ...box, fill: structuredClone(ed.style.fill), stroke: structuredClone(ed.style.stroke), sw: ed.style.sw || 1 };
    if (t === 'polygon') o.sides = ed.polygonSides;
    if (t === 'star') Object.assign(o, { points: ed.starPoints, inner: 0.5 });
    return D.makeNode(t, o);
  }

  /* ---------------- Text tool ---------------- */

  function textDown(e, w) {
    const id = hitAt(e.clientX, e.clientY);
    if (id && ed.node(id)?.type === 'text') return startText(id);
    let box = null;
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        box = { x: Math.min(w.x, p.x), y: Math.min(w.y, p.y), w: Math.abs(p.x - w.x), h: Math.abs(p.y - w.y) };
        marquee = { x1: w.x, y1: w.y, x2: p.x, y2: p.y };
        drawOverlay();
      },
      up: () => {
        marquee = null;
        const area = box && box.w * ed.view.z > 8;
        ed.checkpoint();
        const n = D.makeNode('text', { text: '', x: area ? box.x : w.x, y: area ? box.y : w.y - ed.font.size * 0.6, w: area ? box.w : null, font: { ...ed.font }, fill: ed.style.fill?.type === 'solid' && ed.style.fill.color !== '#d9d9d9' ? structuredClone(ed.style.fill) : D.solid('#1e1e1e') });
        listOf(ed.scope).push(n);
        ed.sel = [n.id];
        commit();
        startText(n.id, true);
      },
    });
  }

  let textFresh = false;
  let textNamed = false; // renamed by hand: the name stays when the words change
  const textName = (t) => String(t || '').trim().split('\n')[0].slice(0, 40) || 'Text';
  function startText(id, fresh = false) {
    const n = ed.node(id);
    if (!n || n.type !== 'text' || blocked(id)) return;
    endText();
    editingText = id;
    textFresh = fresh;
    ed.sel = [id];
    if (!fresh) ed.checkpoint();
    textNamed = !fresh && n.name !== textName(n.text);
    textEdit.hidden = false;
    textEdit.value = n.text;
    render();
    placeTextEdit();
    textEdit.focus();
    if (!fresh) textEdit.select();
    emit('select');
  }
  function placeTextEdit() {
    const n = ed.node(editingText);
    if (!n) return;
    const b = D.textBox(n);
    const f = n.font;
    const z = ed.view.z;
    const p = toScreen(n.x, n.y);
    const fill = n.fill?.type === 'solid' ? n.fill.color : n.fill?.stops?.[0]?.color || '#1e1e1e';
    Object.assign(textEdit.style, {
      left: p.x + 'px',
      top: p.y + 'px',
      width: (n.w != null ? n.w : Math.max(b.w, f.size * 2)) * z + 4 + 'px',
      height: b.h * z + f.size * f.lh * z + 'px',
      font: `${f.italic ? 'italic ' : ''}${f.weight} ${f.size * z}px ${JSON.stringify(f.family)}, sans-serif`,
      lineHeight: f.size * f.lh * z + 'px',
      letterSpacing: (f.ls || 0) * z + 'px',
      textAlign: f.align,
      color: fill,
      transform: `rotate(${n.rot || 0}deg)${n.flip ? ' scaleX(-1)' : ''}`,
      transformOrigin: `${(b.w * z) / 2}px ${(b.h * z) / 2}px`,
      whiteSpace: n.w != null ? 'pre-wrap' : 'pre',
      textTransform: f.case === 'upper' ? 'uppercase' : f.case === 'lower' ? 'lowercase' : f.case === 'title' ? 'capitalize' : 'none',
      textDecoration: f.deco === 'underline' ? 'underline' : f.deco === 'strike' ? 'line-through' : 'none',
    });
  }
  textEdit.addEventListener('input', () => {
    const n = ed.node(editingText);
    if (!n) return;
    n.text = textEdit.value;
    render();
    placeTextEdit();
    emit('change');
  });
  textEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      endText();
      viewport.focus();
    }
    e.stopPropagation();
  });
  textEdit.addEventListener('blur', () => setTimeout(() => document.activeElement !== textEdit && endText(), 0));
  function endText() {
    if (!editingText) return;
    const id = editingText;
    editingText = null;
    textEdit.hidden = true;
    const n = ed.node(id);
    if (n && !n.text.trim()) {
      const p = ed.parentOf(id);
      p.list.splice(p.index, 1);
      ed.sel = [];
      if (textFresh) undoStack.pop();
    } else if (n && !textNamed) n.name = textName(n.text);
    commit();
    if (ed.tool === 'text') ed.setTool('select');
  }
  ed.endText = endText;
  Object.defineProperty(ed, 'editing', { get: () => !!editingText });

  /* ---------------- Gradient tool ---------------- */

  // Drag a handle to move a gradient's ends (or a radial one's middle and edge) and its color stops; drag across an
  // object to lay a gradient over it from there to there; click one to select it.
  function gradientDown(e, w) {
    const h = e.target.closest?.('[data-grad]');
    const t = gradTarget();
    if (h && t?.p && t.p.type !== 'solid') return startGradHandle(e, h.dataset.grad, t);
    const id = hitAt(e.clientX, e.clientY);
    if (id) {
      const pick = pickable(id, false);
      if (!ed.sel.includes(pick)) ed.select(e.shiftKey ? [...ed.sel, pick] : [pick]);
    } else if (!e.shiftKey) ed.select([]);
    const tgt = gradTarget();
    if (!tgt) return;
    const { n, which } = tgt;
    if (n.type === 'image' && which === 'fill') return;
    const box = gradBox(n);
    const inv = G.inv(box.m);
    const frac = (pt) => {
      const l = G.ap(inv, pt.x, pt.y);
      return { x: l.x / box.w, y: l.y / box.h };
    };
    const before = snapshot();
    const base = n[which];
    let made = false;
    track(e, {
      move: (ev) => {
        let q = ed.toWorld(ev.clientX, ev.clientY);
        if (!made && Math.hypot((q.x - w.x) * ed.view.z, (q.y - w.y) * ed.view.z) < 4) return;
        if (ev.shiftKey) q = G.constrain45(w, q);
        made = true;
        const a = frac(w);
        const b = frac(q);
        const cur = n[which];
        if (cur?.type === 'radial') n[which] = { ...cur, cx: r3(a.x), cy: r3(a.y), r: r3(Math.hypot(b.x - a.x, b.y - a.y)) };
        else {
          const stops = cur?.type === 'linear' ? cur.stops : [{ color: D.paintColor(base, which === 'fill' ? '#d9d9d9' : '#1e1e1e'), pos: 0 }, { color: '#ffffff', pos: 1 }];
          const g = { type: 'linear', stops, x1: r3(a.x), y1: r3(a.y), x2: r3(b.x), y2: r3(b.y) };
          delete g.angle;
          n[which] = g;
        }
        sizeTip = tipAt(ev, `${fmt(D.gradientAngle(n[which]))}°`);
        render();
      },
      up: () => {
        if (!made) return;
        pushUndo(before);
        ed.rememberStyle(n);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  function startGradHandle(e, key, t) {
    const { n, which } = t;
    const before = snapshot();
    const box = gradBox(n);
    const inv = G.inv(box.m);
    const frac = (pt) => {
      const l = G.ap(inv, pt.x, pt.y);
      return { x: l.x / box.w, y: l.y / box.h };
    };
    const p0 = structuredClone(n[which]);
    const line0 = p0.type === 'linear' ? D.gradientLine(p0) : null;
    const w0 = ed.toWorld(e.clientX, e.clientY);
    const isStop = key.startsWith('stop:');
    const si = isStop ? +key.slice(5) : -1;
    let moved = false;
    track(e, {
      move: (ev) => {
        let q = ed.toWorld(ev.clientX, ev.clientY);
        moved = true;
        const p = structuredClone(p0);
        if (p.type === 'linear') {
          const L = { ...line0 };
          if (key === 'p1' || key === 'p2') {
            const other = key === 'p1' ? G.ap(box.m, L.x2 * box.w, L.y2 * box.h) : G.ap(box.m, L.x1 * box.w, L.y1 * box.h);
            if (ev.shiftKey) q = G.constrain45(other, q);
            const f = frac(q);
            if (key === 'p1') (L.x1 = f.x), (L.y1 = f.y);
            else (L.x2 = f.x), (L.y2 = f.y);
          } else if (key === 'line') {
            const d = frac(q);
            const o = frac(w0);
            L.x1 += d.x - o.x;
            L.y1 += d.y - o.y;
            L.x2 += d.x - o.x;
            L.y2 += d.y - o.y;
          } else if (isStop) {
            // Along the line, between its ends.
            const f = frac(q);
            const vx = L.x2 - L.x1;
            const vy = L.y2 - L.y1;
            const len2 = vx * vx + vy * vy || 1;
            p.stops[si].pos = Math.max(0, Math.min(1, Math.round((((f.x - L.x1) * vx + (f.y - L.y1) * vy) / len2) * 1000) / 1000));
          }
          Object.assign(p, { x1: r3(L.x1), y1: r3(L.y1), x2: r3(L.x2), y2: r3(L.y2) });
          delete p.angle;
          sizeTip = tipAt(ev, isStop ? `${Math.round(p.stops[si].pos * 100)}%` : `${fmt(D.gradientAngle(p))}°`);
        } else {
          const cx = p.cx ?? 0.5;
          const cy = p.cy ?? 0.5;
          const f = frac(q);
          if (key === 'c' || key === 'line') {
            const o = frac(w0);
            p.cx = r3(cx + f.x - o.x);
            p.cy = r3(cy + f.y - o.y);
          } else if (key === 'r') p.r = r3(Math.max(0.01, Math.hypot(f.x - cx, f.y - cy)));
          else if (isStop) p.stops[si].pos = Math.max(0, Math.min(1, Math.round((Math.hypot(f.x - cx, f.y - cy) / (p.r ?? 0.5)) * 1000) / 1000));
          sizeTip = tipAt(ev, isStop ? `${Math.round(p.stops[si].pos * 100)}%` : `${fmt(((p.r ?? 0.5) * box.w) / 1)}`);
        }
        n[which] = p;
        render();
      },
      up: () => {
        if (!moved) return;
        pushUndo(before);
        ed.rememberStyle(n);
        commit({ quiet: true });
        emit('select');
      },
      cancel: () => restoreRaw(before),
    });
  }

  /* ---------------- Scissors ---------------- */

  /** Where a click cuts: on an anchor, or on a segment of the path under the pointer (selected paths first). */
  function cutTarget(cx, cy, w) {
    const tol = 7 / ed.view.z;
    const candidates = [];
    for (const n of ed.selected().flatMap(leaves)) if (n.type === 'path' || D.SHAPES.includes(n.type)) candidates.push(n);
    const under = hitAt(cx, cy);
    if (under) {
      const n = ed.node(under);
      if ((n.type === 'path' || D.SHAPES.includes(n.type)) && !candidates.includes(n)) candidates.push(n);
    }
    for (const n of candidates) {
      const sub = n.type === 'path' ? n.subpaths : D.outline(n);
      for (let si = 0; si < sub.length; si++)
        for (let i = 0; i < sub[si].pts.length; i++) if (G.dist(sub[si].pts[i], w) <= tol) return { id: n.id, si, i, x: sub[si].pts[i].x, y: sub[si].pts[i].y };
      const near = G.nearestOnPath(sub, w.x, w.y);
      if (near && near.d <= tol) return { id: n.id, ...near };
    }
    return null;
  }
  function scissorsDown(e, w) {
    const t = cutTarget(e.clientX, e.clientY, w);
    if (!t) return;
    ed.checkpoint();
    const n = asPath(t.id);
    const sp = n.subpaths[t.si];
    const parts = t.i != null ? G.splitAtAnchor(sp, t.i) : G.splitSubpath(sp, t.seg, t.t);
    if (parts.length === 1 && !sp.closed) {
      undoStack.pop();
      return emit('message', 'Cut somewhere along the path, not at its end');
    }
    n.subpaths.splice(t.si, 1, parts[0]);
    const made = [n.id];
    if (parts.length > 1) {
      // The far piece becomes its own path, right above. Arrowheads stay at the line's real ends.
      const p = ed.parentOf(n.id);
      const other = { ...structuredClone(n), id: D.newId(), subpaths: [parts[1]] };
      if (n.ends) {
        other.ends = { ...n.ends, start: 'none' };
        n.ends = { ...n.ends, end: 'none' };
      }
      p.list.splice(p.index + 1, 0, other);
      made.push(other.id);
    }
    ed.sel = made;
    cutHover = null;
    commit();
  }
  ed.cutAt = scissorsDown;

  /* ---------------- Shape Builder ---------------- */

  // With two or more shapes selected, the places where they overlap and don't are regions. Click one to make it a shape
  // of its own, drag across several to merge them into one; Alt does the same but takes them away. The result looks
  // like the topmost shape it came from; what's left of the other shapes stays, cut back.
  let sb = { key: null, data: null, busy: false, hover: -1, swept: null, erase: false };
  function sbShapes() {
    return ordered()
      .map(ed.node)
      .flatMap(leaves)
      .filter((n) => (n.type === 'path' || D.SHAPES.includes(n.type)) && !blocked(n.id))
      .map((n) => ({ n, subpaths: D.outline(n), rule: n.fillRule || 'nonzero' }));
  }
  /** The regions for the current selection (computed once per selection and shape change). */
  async function sbRegions() {
    const shapes = sbShapes();
    if (shapes.length < 2) return null;
    const key = shapes.map((s) => s.n.id + ':' + JSON.stringify(s.subpaths)).join('|');
    if (sb.key === key) return sb.data;
    if (sb.busy) return null;
    sb.busy = true;
    try {
      const data = await planar(shapes);
      sb.data?.dispose();
      sb.data = data;
      sb.key = key;
      sb.data.shapes = shapes;
      return data;
    } catch (err) {
      emit('message', err.message);
      return null;
    } finally {
      sb.busy = false;
    }
  }
  function sbMove(e) {
    const w = ed.toWorld(e.clientX, e.clientY);
    const shapes = sbShapes();
    if (shapes.length < 2) {
      const id = hitAt(e.clientX, e.clientY);
      const h = id ? pickable(id, false) : null;
      if (h !== hoverId) {
        hoverId = h;
        drawOverlay();
      }
      return;
    }
    hoverId = null;
    sbRegions().then((data) => {
      if (!data || ed.tool !== 'shapebuilder' || drag) return;
      const idx = data.hit(w.x, w.y);
      sb.erase = e.altKey;
      sb.hover = idx;
      drawOverlay();
    });
  }
  function regionsSvg() {
    const data = sb.data;
    if (!data || sbShapes().length < 2) return '';
    let s = '';
    const cls = sb.erase ? 'gx-ov-region erase' : 'gx-ov-region';
    for (const i of sb.swept || []) s += `<path d="${scrPathD(data.list[i].subpaths)}" class="${cls} on"/>`;
    if (sb.hover >= 0 && !(sb.swept?.has(sb.hover))) s += `<path d="${scrPathD(data.list[sb.hover].subpaths)}" class="${cls}"/>`;
    return s;
  }
  function sbDown(e, w) {
    const shapes = sbShapes();
    if (shapes.length < 2) {
      // Pick the shapes to build with first.
      const id = hitAt(e.clientX, e.clientY);
      if (id) {
        const pick = pickable(id, false);
        ed.select(e.shiftKey ? (ed.sel.includes(pick) ? ed.sel.filter((x) => x !== pick) : [...ed.sel, pick]) : [pick]);
      } else if (!e.shiftKey) ed.select([]);
      if (ed.sel.length === 1) emit('message', 'Shift-click another shape (or marquee with V) to build with both');
      return;
    }
    // Only regions of the shapes as they are now (a change since the last hover: compute, then wait for a click).
    const key = shapes.map((x) => x.n.id + ':' + JSON.stringify(x.subpaths)).join('|');
    const data = sb.key === key ? sb.data : null;
    if (!data) {
      sbRegions().then(() => drawOverlay());
      return;
    }
    const first = data.hit(w.x, w.y);
    sb.swept = new Set(first >= 0 ? [first] : []);
    sb.erase = e.altKey;
    sb.hover = -1;
    drawOverlay();
    track(e, {
      move: (ev) => {
        const q = ed.toWorld(ev.clientX, ev.clientY);
        const idx = data.hit(q.x, q.y);
        sb.erase = ev.altKey;
        if (idx >= 0) sb.swept.add(idx);
        drawOverlay();
      },
      up: async () => {
        const swept = [...sb.swept];
        const erase = sb.erase;
        sb.swept = null;
        if (!swept.length) return drawOverlay();
        await sbApply(data, swept, erase);
      },
      cancel: () => {
        sb.swept = null;
      },
    });
  }
  /** Merge (or erase) the swept regions: new shape in, the sources cut back. */
  async function sbApply(data, swept, erase) {
    const shapes = data.shapes;
    const regions = swept.map((i) => data.list[i]);
    let merged;
    try {
      merged = regions.length === 1 ? regions[0].subpaths : await combine('unite', regions.map((r) => ({ subpaths: r.subpaths, rule: 'nonzero' })));
    } catch (err) {
      return emit('message', err.message);
    }
    if (!merged.length) return;
    // Which sources the regions touch, and what's left of each: its other regions, put back together (subtracting the
    // swept area would leave coincident edges for the path math to trip on).
    const touched = new Set(regions.flatMap((r) => r.sources));
    const remainders = new Map();
    for (const i of touched) {
      const rest = data.list.filter((r, k) => r.sources.includes(i) && !swept.includes(k));
      try {
        remainders.set(i, !rest.length ? [] : rest.length === 1 ? G.clonePath(rest[0].subpaths) : await combine('unite', rest.map((r) => ({ subpaths: r.subpaths, rule: 'nonzero' }))));
      } catch {
        remainders.set(i, []);
      }
    }
    // The look: the topmost source the first region lies in.
    const styleIdx = Math.max(...regions[0].sources);
    const styleFrom = shapes[styleIdx]?.n || shapes[shapes.length - 1].n;
    ed.checkpoint();
    const keep = [];
    let newNode = null;
    // Replace each touched source with its remainder (bottom to top keeps indexes valid per list).
    for (const i of [...touched].sort((a, b) => b - a)) {
      const src = shapes[i].n;
      const p = ed.parentOf(src.id);
      if (!p) continue;
      const rem = remainders.get(i) || [];
      if (rem.length) {
        const path = { ...D.toPath(src), id: src.id, subpaths: rem, fillRule: 'nonzero' };
        p.list[p.index] = path;
        keep.push(path.id);
      } else p.list.splice(p.index, 1);
    }
    if (!erase) {
      const style = { fill: styleFrom.fill ?? null, stroke: styleFrom.stroke ?? null, sw: styleFrom.sw, opacity: styleFrom.opacity, cap: styleFrom.cap, join: styleFrom.join, dash: styleFrom.dash, blend: styleFrom.blend, effects: styleFrom.effects ? structuredClone(styleFrom.effects) : undefined };
      newNode = D.makeNode('path', { ...style, name: 'Shape', subpaths: merged, fillRule: 'nonzero' });
      // Right above the topmost source that's still there, else on top of the scope.
      const above = [...touched].sort((a, b) => b - a).map((i) => ed.parentOf(shapes[i].n.id)).find(Boolean);
      if (above) above.list.splice(above.index + 1, 0, newNode);
      else listOf(ed.scope).push(newNode);
    }
    cleanupGroups();
    const untouched = shapes.filter((_, i) => !touched.has(i)).map((s) => s.n.id);
    ed.sel = [...untouched, ...keep, ...(newNode ? [newNode.id] : [])].filter((id) => ed.node(id));
    sb.hover = -1;
    commit();
  }
  ed.shapeBuild = (swept, erase = false) => sbRegions().then((data) => data && sbApply(data, swept, erase));
  ed.shapeRegions = () => sbRegions();

  /* ---------------- Eyedropper ---------------- */

  function eyedrop(e) {
    const id = hitAt(e.clientX, e.clientY);
    const src = id && ed.node(id);
    if (!src) return;
    const look = { fill: structuredClone(src.fill ?? null), stroke: structuredClone(src.stroke ?? null), sw: src.sw ?? 1, cap: src.cap, join: src.join, dash: src.dash ? [...src.dash] : undefined, opacity: src.opacity ?? 1 };
    const targets = ed.selected().flatMap(leaves).filter((n) => n.id !== id && n.type !== 'image');
    if (!targets.length) {
      ed.rememberStyle(src);
      return emit('message', 'Picked up its colors for what you draw next');
    }
    ed.checkpoint();
    for (const n of targets) {
      Object.assign(n, look);
      if (src.type === 'text' && n.type === 'text') n.font = { ...src.font };
    }
    commit();
  }

  /* ---------------- Artboard tool ---------------- */

  function boardAt(w) {
    for (let i = ed.doc.artboards.length - 1; i >= 0; i--) {
      const b = ed.doc.artboards[i];
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return b;
    }
    return null;
  }
  function boardDown(e, w) {
    const h = e.target.closest?.('[data-box]');
    if (h && ed.board) return startBoardResize(e, ed.boardById(ed.board), h.dataset.box);
    const b = boardAt(w);
    if (b) return startBoardDrag(e, b);
    // Draw a new artboard.
    const before = snapshot();
    let nb = null;
    const targets = snapTargets([]);
    track(e, {
      move: (ev) => {
        const p = snapPoint(ed.toWorld(ev.clientX, ev.clientY), targets);
        if (!nb && Math.hypot((p.x - w.x) * ed.view.z, (p.y - w.y) * ed.view.z) < 4) return;
        if (!nb) {
          nb = { id: D.newId(), name: `Artboard ${ed.doc.artboards.length + 1}`, x: w.x, y: w.y, w: 1, h: 1, bg: '#ffffff' };
          ed.doc.artboards.push(nb);
          ed.board = nb.id;
          ed.sel = [];
        }
        Object.assign(nb, { x: Math.round(Math.min(w.x, p.x)), y: Math.round(Math.min(w.y, p.y)), w: Math.round(Math.abs(p.x - w.x)), h: Math.round(Math.abs(p.y - w.y)) });
        sizeTip = tipAt(ev, `${nb.w} × ${nb.h}`);
        render();
      },
      up: () => {
        if (!nb) {
          ed.board = null;
          emit('select');
          return;
        }
        pushUndo(before);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }
  function startBoardDrag(e, b) {
    if (!b) return;
    if (ed.tool !== 'artboard') ed.setTool('artboard');
    ed.board = b.id;
    ed.sel = [];
    emit('select');
    drawLabels();
    drawOverlay();
    const before = snapshot();
    const w = ed.toWorld(e.clientX, e.clientY);
    const carry = e.altKey ? [] : onBoard(b);
    const x0 = b.x;
    const y0 = b.y;
    const targets = snapTargets(carry);
    targets.xs = targets.xs.filter((t) => t.b.x1 !== b.x || t.b.y1 !== b.y);
    let started = false;
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        let dx = p.x - w.x;
        let dy = p.y - w.y;
        if (!started && Math.hypot(dx * ed.view.z, dy * ed.view.z) < 3) return;
        started = true;
        const s = snapBox({ x1: x0 + dx, y1: y0 + dy, x2: x0 + dx + b.w, y2: y0 + dy + b.h }, targets);
        dx = Math.round(dx + s.dx);
        dy = Math.round(dy + s.dy);
        moveBoard(b, x0 + dx - b.x, y0 + dy - b.y, carry);
        render();
      },
      up: () => {
        if (!started) return;
        pushUndo(before);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }
  function startBoardResize(e, b, k) {
    const before = snapshot();
    const o = { ...b };
    const targets = snapTargets([]);
    track(e, {
      move: (ev) => {
        const p = snapPoint(ed.toWorld(ev.clientX, ev.clientY), targets);
        let { x, y, w, h } = o;
        if (k.includes('w')) (w = o.x + o.w - p.x), (x = p.x);
        if (k.includes('e')) w = p.x - o.x;
        if (k.includes('n')) (h = o.y + o.h - p.y), (y = p.y);
        if (k.includes('s')) h = p.y - o.y;
        if (w < 1 || h < 1) return;
        Object.assign(b, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
        sizeTip = tipAt(ev, `${b.w} × ${b.h}`);
        render();
      },
      up: () => {
        pushUndo(before);
        commit();
      },
      cancel: () => restoreRaw(before),
    });
  }

  /* ---------------- Zoom tool ---------------- */

  function zoomDown(e, w) {
    marquee = { x1: w.x, y1: w.y, x2: w.x, y2: w.y, zoom: true };
    track(e, {
      move: (ev) => {
        const p = ed.toWorld(ev.clientX, ev.clientY);
        marquee.x2 = p.x;
        marquee.y2 = p.y;
        drawOverlay();
      },
      up: (ev) => {
        const m = marquee;
        marquee = null;
        const r = viewport.getBoundingClientRect();
        if (Math.abs(m.x2 - m.x1) * ed.view.z > 8) return ed.fit({ x1: Math.min(m.x1, m.x2), y1: Math.min(m.y1, m.y2), x2: Math.max(m.x1, m.x2), y2: Math.max(m.y1, m.y2) }, { max: 64, pad: 10 });
        ed.zoomAt(ed.view.z * (ev.altKey ? 1 / 1.6 : 1.6), ev.clientX - r.left, ev.clientY - r.top);
      },
    });
  }

  /* ---------------- tools and keys ---------------- */

  ed.setTool = (t) => {
    if (t === ed.tool) return;
    endText();
    if (ed.tool === 'pen' && t !== 'pen') finishPen();
    ed.tool = t;
    viewport.dataset.tool = t;
    delete viewport.dataset.pen;
    if (t !== 'artboard') ed.board = null;
    if (t !== 'direct' && t !== 'pen') ed.anchors.clear();
    hoverId = null;
    cutHover = null;
    sb.hover = -1;
    sb.swept = null;
    drawLabels();
    drawOverlay();
    emit('tool', t);
    emit('select');
  };

  viewport.addEventListener('keydown', (e) => {
    if (e.target !== viewport) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === ' ' && !spaceDown) {
      spaceDown = true;
      viewport.classList.add('space');
      return e.preventDefault();
    }
    if (e.key === 'Alt' && ed.tool === 'shapebuilder' && !sb.erase) {
      sb.erase = true;
      drawOverlay();
    }
    if (e.key === 'Escape') {
      if (drag) return drag.cancel();
      if (pen) return finishPen();
      if (ed.anchors.size) {
        ed.anchors.clear();
        emit('select');
        return drawOverlay();
      }
      if (ed.scope) {
        const s = ed.scope;
        ed.scope = null;
        emit('scope');
        return ed.select([s]);
      }
      return ed.select([]);
    }
    if (e.key === 'Enter') {
      if (pen) return finishPen();
      const one = ed.selected()[0];
      if (one?.type === 'text' && ed.sel.length === 1) return e.preventDefault(), startText(one.id);
      if (one?.type === 'group' && ed.sel.length === 1) {
        ed.scope = one.id;
        emit('scope');
        return ed.select(one.children.length ? [one.children[one.children.length - 1].id] : []);
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      return ed.deleteSelection();
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const s = (ed.nudgeStep || 1) * (e.shiftKey ? 10 : 1);
      return ed.nudge(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
    }
    if (ctrl) {
      const act = {
        z: () => (e.shiftKey ? ed.redo() : ed.undo()),
        y: () => ed.redo(),
        a: () => ed.select(e.shiftKey ? [] : (ed.scope ? ed.node(ed.scope).children : ed.doc.nodes).filter((n) => !n.locked && !n.hidden).map((n) => n.id)),
        d: () => ed.duplicate(),
        g: () => (e.shiftKey ? ed.ungroup() : ed.group()),
        ']': () => ed.arrange(e.shiftKey ? 'front' : 'forward'),
        '}': () => ed.arrange('front'),
        '[': () => ed.arrange(e.shiftKey ? 'back' : 'backward'),
        '{': () => ed.arrange('back'),
        7: () => (e.altKey ? ed.releaseClip() : ed.clip()),
        8: () => (e.altKey && e.shiftKey ? ed.releaseCompound() : ed.compound()),
        j: () => ed.join(),
        2: () => (e.altKey ? ed.unlockAll() : ed.setFlag('locked', true)),
        3: () => (e.altKey ? ed.showAll() : ed.setFlag('hidden', true)),
        0: () => (e.altKey ? ed.fitAll() : ed.fit()),
        1: () => ed.zoomTo(1),
        r: () => ed.setDocView({ rulers: ed.doc.rulers === false }),
        ';': () => (e.altKey ? ed.setDocView({ guidesLocked: !ed.doc.guidesLocked }) : ed.setDocView({ guidesHidden: !ed.doc.guidesHidden })),
        "'": () => ed.setDocView({ grid: { show: !ed.doc.grid?.show } }),
        '"': () => ed.setDocView({ grid: { snap: !ed.doc.grid?.snap } }),
        u: () => ((ed.snapping = !ed.snapping), emit('view'), emit('message', ed.snapping ? 'Smart guides on' : 'Smart guides off')),
        5: () => ed.guidesAround(),
        '=': () => ed.zoomTo(ed.view.z * 1.4),
        '+': () => ed.zoomTo(ed.view.z * 1.4),
        '-': () => ed.zoomTo(ed.view.z / 1.4),
      }[e.key === 'Z' ? 'z' : e.code?.startsWith('Digit') ? e.code.slice(5) : e.key === '}' || e.key === '{' ? e.key : k];
      if (act) {
        e.preventDefault();
        return act();
      }
      return;
    }
    if (e.altKey) return;
    if (e.shiftKey && k === 'o') return ed.setTool('artboard');
    if (e.shiftKey && k === 'm') return ed.setTool('shapebuilder');
    if (e.shiftKey && k === 'x') return ed.swapFillStroke();
    if (e.shiftKey && k === '!') return ed.fitAll();
    if (k === 'd' && !e.shiftKey) return ed.defaultColors();
    if (TOOL_KEYS[k] && !e.shiftKey) {
      e.preventDefault();
      return ed.setTool(TOOL_KEYS[k]);
    }
  });
  viewport.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && ed.tool === 'shapebuilder') {
      sb.erase = false;
      drawOverlay();
    }
    if (e.key === ' ') {
      spaceDown = false;
      viewport.classList.remove('space');
    }
  });
  viewport.addEventListener('blur', () => {
    spaceDown = false;
    viewport.classList.remove('space');
  });

  ed.setFlag = (flag, on) => {
    if (!ed.sel.length) return;
    ed.checkpoint();
    for (const n of ed.selected()) n[flag] = on;
    if (on) ed.sel = [];
    commit();
  };
  ed.unlockAll = () => {
    ed.checkpoint();
    const out = [];
    D.walk(ed.doc.nodes, (n) => n.locked && (delete n.locked, out.push(n.id)));
    ed.sel = out;
    commit();
  };
  ed.showAll = () => {
    ed.checkpoint();
    const out = [];
    D.walk(ed.doc.nodes, (n) => n.hidden && (delete n.hidden, out.push(n.id)));
    ed.sel = out;
    commit();
  };

  /* ---------------- Select › Same, Select › All on Artboard ---------------- */

  /** Select every object like the first selected one: 'fill' | 'stroke' | 'type' | 'opacity' | 'font'. */
  ed.selectSame = (what) => {
    const ref = ed.selected().flatMap(leaves)[0];
    if (!ref) return;
    const key = (n) => {
      if (what === 'fill') return JSON.stringify(n.fill ?? null);
      if (what === 'stroke') return JSON.stringify([n.stroke ?? null, n.stroke ? n.sw : 0]);
      if (what === 'type') return n.type;
      if (what === 'opacity') return String(n.opacity ?? 1);
      if (what === 'font') return n.type === 'text' ? n.font.family : null;
      return null;
    };
    const want = key(ref);
    if (want == null) return;
    const out = [];
    D.walk(ed.doc.nodes, (n) => {
      if (n.type === 'group' || blocked(n.id)) return;
      if (key(n) === want) out.push(n.id);
    });
    ed.scope = null;
    emit('scope');
    ed.select(out);
    emit('message', `${out.length} object${out.length === 1 ? '' : 's'} with the same ${what === 'type' ? 'kind' : what}`);
  };
  ed.selectAllOnBoard = () => {
    const b = currentBoard();
    if (!b) return;
    const box = G.rectBox(b);
    ed.scope = null;
    emit('scope');
    ed.select(ed.doc.nodes.filter((n) => !n.locked && !n.hidden && G.overlaps(D.bounds(n), box)).map((n) => n.id));
  };
  /** Crop a picture: it goes inside a frame its own size; the frame's handles crop it, double-click to move it inside. */
  ed.cropImage = () => {
    const img = ed.selected().find((n) => n.type === 'image');
    if (!img) return emit('message', 'Select a picture to crop');
    ed.checkpoint();
    const p = ed.parentOf(img.id);
    const mask = D.makeNode('rect', { name: 'Crop', x: img.x, y: img.y, w: img.w, h: img.h, rot: img.rot, fill: null, stroke: null });
    const g = D.makeNode('group', { name: 'Cropped Picture', clip: true, children: [img, mask] });
    p.list.splice(p.index, 1, g);
    ed.scope = g.id;
    emit('scope');
    ed.sel = [mask.id];
    commit();
    emit('message', 'Drag the handles to crop; double-click the picture to move it inside the frame');
  };

  /* ---------------- clipboard ---------------- */

  // In the Leafdeck app the keys copy and paste themselves (the app reads the system clipboard: opts.readClipboard);
  // in a browser the page's own copy / cut / paste events do it. Copied objects go to the clipboard as SVG, so they
  // paste into other apps too; pasting that same SVG back here brings the objects themselves.
  let internalClip = null; // { json, svg }
  function copyData() {
    const nodes = ordered().map(ed.node);
    if (!nodes.length) return null;
    const assets = {};
    D.walk(nodes, (n) => {
      if (String(n.src || '').startsWith('asset:')) assets[n.src.slice(6)] = ed.doc.assets[n.src.slice(6)];
    });
    const box = D.boundsOf(nodes);
    const svgText = D.exportSvg({ nodes, artboards: [] }, { assets });
    return { json: JSON.stringify({ leafdeckGraphic: 1, nodes, assets, box }), svg: svgText };
  }
  ed.copy = () => {
    const d = copyData();
    if (!d) return false;
    internalClip = d;
    navigator.clipboard?.writeText(d.svg).catch(() => {});
    emit('message', `Copied ${ed.sel.length} object${ed.sel.length === 1 ? '' : 's'}`);
    return true;
  };
  ed.cut = () => ed.copy() && ed.deleteSelection();
  /** Paste from the system clipboard (the app's reader), or our own copy when that's all there is. */
  ed.paste = async ({ inPlace = false } = {}) => {
    let data = null;
    try {
      data = opts.readClipboard ? await opts.readClipboard() : { text: await navigator.clipboard.readText() };
    } catch {}
    pasteData(data || {}, inPlace);
  };
  function pasteData({ text = '', image = null } = {}, inPlace = false) {
    if (internalClip && (!text || text === internalClip.svg)) return pasteOurs(JSON.parse(internalClip.json), inPlace);
    if (text && /<svg[\s>]/i.test(text)) return ed.importSvgText(text, { at: inPlace ? null : 'center' });
    if (image) return ed.importImage(image);
    if (text?.trim()) {
      // Plain text: a text object.
      ed.checkpoint();
      const c = viewCenter();
      const n = D.makeNode('text', { text: text.trim().slice(0, 5000), x: c.x, y: c.y, font: { ...ed.font, size: Math.min(ed.font.size, 24) }, fill: D.solid('#1e1e1e') });
      n.name = n.text.split('\n')[0].slice(0, 40);
      ed.insert([n]);
    }
  }
  viewport.addEventListener('keydown', (e) => {
    if (e.target !== viewport || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && !e.shiftKey && ed.sel.length) e.preventDefault(), ed.copy();
    if (k === 'x' && !e.shiftKey && ed.sel.length) e.preventDefault(), ed.cut();
    if (k === 'v' && opts.readClipboard) e.preventDefault(), ed.paste({ inPlace: e.shiftKey });
    if (k === 'v') pasteInPlace = e.shiftKey;
  });
  // A browser: the paste event carries the clipboard.
  let pasteInPlace = false;
  viewport.addEventListener('paste', async (e) => {
    if (e.target !== viewport || opts.readClipboard) return;
    e.preventDefault();
    const cd = e.clipboardData;
    const file = [...cd.files].find((f) => /^image\//.test(f.type));
    const image = file
      ? await new Promise((r) => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.readAsDataURL(file);
        })
      : null;
    pasteData({ text: cd.getData('image/svg+xml') || cd.getData('text/plain'), image }, pasteInPlace);
  });
  function pasteOurs(data, inPlace) {
    ed.checkpoint();
    Object.assign(ed.doc.assets, data.assets || {});
    const nodes = data.nodes.map(D.cloneFresh);
    if (!inPlace) {
      // Offset a little from the originals when they're in view, else into the middle of the view.
      const c = viewCenter();
      const b = data.box;
      const r = viewport.getBoundingClientRect();
      const vis = { x1: -ed.view.x / ed.view.z, y1: -ed.view.y / ed.view.z, x2: (r.width - ed.view.x) / ed.view.z, y2: (r.height - ed.view.y) / ed.view.z };
      const off = G.overlaps(vis, b) ? G.translate(10, 10) : G.translate(c.x - (b.x1 + b.x2) / 2, c.y - (b.y1 + b.y2) / 2);
      nodes.forEach((n, i) => (nodes[i] = D.transform(n, off)));
      // The next paste steps on from this one.
      internalClip = { ...internalClip, json: JSON.stringify({ ...data, nodes, box: { x1: b.x1 + off[4], y1: b.y1 + off[5], x2: b.x2 + off[4], y2: b.y2 + off[5] } }) };
    }
    ed.insert(nodes);
  }

  function viewCenter() {
    const r = viewport.getBoundingClientRect();
    return { x: (r.width / 2 - ed.view.x) / ed.view.z, y: (r.height / 2 - ed.view.y) / ed.view.z };
  }

  /* ---------------- importing ---------------- */

  /** An SVG file's drawing as editable objects (grouped), centered at `at` (world point), the view's middle, or as-is. */
  ed.importSvgText = (text, { at = 'center', name = 'SVG' } = {}) => {
    let nodes;
    try {
      nodes = D.importSvg(text);
    } catch (err) {
      return emit('message', err.message);
    }
    if (!nodes.length) return emit('message', 'There was nothing to draw in that SVG');
    let out = nodes.length === 1 ? nodes : [D.makeNode('group', { name, children: nodes })];
    if (at) {
      const c = at === 'center' ? viewCenter() : at;
      const b = D.boundsOf(out);
      out = out.map((n) => D.transform(n, G.translate(c.x - (b.x1 + b.x2) / 2, c.y - (b.y1 + b.y2) / 2)));
    }
    ed.checkpoint();
    ed.insert(out);
  };
  ed.importImage = async (dataUrl, { at = null, name = 'Image' } = {}) => {
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
    } catch {
      return emit('message', 'Couldn’t read that image');
    }
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const r = viewport.getBoundingClientRect();
    const maxW = (r.width * 0.7) / ed.view.z;
    if (w > maxW) {
      h = (h * maxW) / w;
      w = maxW;
    }
    const c = at || viewCenter();
    ed.checkpoint();
    const id = ed.addAsset(dataUrl);
    ed.insert([D.makeNode('image', { name, src: 'asset:' + id, x: c.x - w / 2, y: c.y - h / 2, w, h })]);
  };
  /** Place an image inside the selected shape: the image clipped to it. */
  ed.placeIn = async (dataUrl) => {
    const shape = ed.selected()[0];
    if (!shape || ed.sel.length !== 1 || shape.type === 'image' || shape.type === 'text' || shape.type === 'group') return ed.importImage(dataUrl);
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const b = D.bounds(shape);
    const s = Math.max((b.x2 - b.x1) / img.naturalWidth, (b.y2 - b.y1) / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ed.checkpoint();
    const id = ed.addAsset(dataUrl);
    const im = D.makeNode('image', { src: 'asset:' + id, x: (b.x1 + b.x2) / 2 - w / 2, y: (b.y1 + b.y2) / 2 - h / 2, w, h });
    const p = ed.parentOf(shape.id);
    const mask = { ...shape, fill: null, stroke: null };
    const g = D.makeNode('group', { name: 'Clip Group', clip: true, children: [im, mask] });
    p.list.splice(p.index, 1, g);
    ed.sel = [g.id];
    commit();
  };

  /* ---------------- loading ---------------- */

  ed.load = (doc) => {
    for (const u of blobUrls.values()) URL.revokeObjectURL(u);
    blobUrls.clear();
    ed.doc = doc;
    doc.artboards ||= [];
    doc.nodes ||= [];
    doc.swatches ||= [];
    doc.assets ||= {};
    doc.guides ||= [];
    doc.grid = { ...GRID, ...(doc.grid || {}) };
    doc.units ||= 'px';
    dup = null;
    applyRulers();
    ed.sel = [];
    ed.anchors.clear();
    ed.scope = null;
    viewport.dataset.tool = ed.tool;
    render();
    if (doc.view?.z) {
      ed.view = { ...doc.view };
      applyView();
    } else requestAnimationFrame(() => ed.fit());
    emit('select');
  };
  ed.destroy = () => {
    for (const u of blobUrls.values()) URL.revokeObjectURL(u);
    ro.disconnect();
  };
  const ro = new ResizeObserver(() => {
    applyRulers();
    drawOverlay();
  });
  ro.observe(viewport);

  return ed;
}
