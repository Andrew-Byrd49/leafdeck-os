// Designer's canvas: an infinite, zoomable canvas of frames, edited the way Figma edits them.
//   Click selects a top-level frame's child (double-click goes deeper, Ctrl+click goes straight to the deepest layer);
//   drag moves (with smart guides; into another frame to put it there; within auto layout to reorder); handles resize
//   (Shift keeps proportions, Alt resizes from the center); F / R / O / T draw frames, rectangles, ellipses and text;
//   Space or the middle button pans, Ctrl+scroll or a pinch zooms. The layers are real HTML (designer/model.js).
//   Markup (P pen, L line, Shift+L arrow, B box, N note) draws on top of the design to show Claude what you mean; it's
//   kept in doc.marks, in canvas coordinates, and never becomes part of the design.
import { uid, esc } from '../util.js';
import { makeNode, nodeCss, cssText, indexTree, walk, layoutOf, cloneNode, strokeInset, resolveSrc, assetsUsed, parseColor } from './model.js';
import { fromCapture, statesFromCapture, cleanPaths, captureHtml, svgSize, imageSize, CAPTURE_PREFIX, LAYERS_PREFIX } from './capture.js';

const MIN_Z = 0.02;
const MAX_Z = 64;
const SNAP = 5; // screen pixels
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const MARK_TOOLS = ['pen', 'line', 'arrow', 'box', 'note', 'eraser'];
export const MARK_COLORS = ['#f24822', '#ffa629', '#14ae5c', '#0d99ff', '#9747ff', '#1e1e1e'];

/** Clean up SVG markup from anywhere: no scripts, no event handlers, no outside documents. */
const svgCache = new Map();
export function cleanSvg(markup) {
  if (svgCache.has(markup)) return svgCache.get(markup);
  let out = '';
  try {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg?.nodeName === 'svg') {
      svg.querySelectorAll('script, foreignObject, iframe').forEach((x) => x.remove());
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const a of [...el.attributes]) {
          if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
        }
      }
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.display = 'block';
      if (!svg.getAttribute('preserveAspectRatio')) svg.setAttribute('preserveAspectRatio', 'none');
      out = new XMLSerializer().serializeToString(svg);
    }
  } catch {}
  if (svgCache.size > 400) svgCache.clear();
  svgCache.set(markup, out);
  return out;
}

/** A design's layers as plain, non-interactive HTML (previews of templates and designs). */
export function renderStatic(nodes, assets = {}) {
  const build = (n, parent) => {
    const el = document.createElement('div');
    const css = nodeCss(n, parent, { mode: parent ? 'canvas' : 'export', assets });
    if (n.hidden) css.display = 'none';
    el.style.cssText = cssText(css);
    if (n.type === 'text') el.textContent = n.text;
    else if (n.type === 'svg') el.innerHTML = cleanSvg(n.markup || '');
    else if (n.type === 'image' && resolveSrc(n.src, assets)) {
      const img = document.createElement('img');
      img.src = resolveSrc(n.src, assets);
      img.style.cssText = `width: 100%; height: 100%; object-fit: ${n.fit || 'cover'}; display: block;`;
      el.append(img);
    }
    n.children?.forEach((c) => el.append(build(c, n)));
    return el;
  };
  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.append(build(n, null)));
  return frag;
}

export function createEditor(host, opts = {}) {
  host.innerHTML = `<div class="dz-viewport" tabindex="0" aria-label="Canvas">
      <div class="dz-world"></div>
      <div class="dz-marks"></div>
      <div class="dz-overlay"></div>
    </div>`;
  const vp = host.querySelector('.dz-viewport');
  const world = host.querySelector('.dz-world');
  const overlay = host.querySelector('.dz-overlay');
  const marksEl = host.querySelector('.dz-marks');

  let doc = { nodes: [], assets: {}, fonts: [], meta: {}, marks: [] };
  let idx = new Map();
  let sel = [];
  let hover = null;
  let tool = 'move';
  let view = { x: 80, y: 80, z: 1 };
  let els = new Map(); // id -> element
  let editing = null; // text layer being typed into
  let drag = null; // the pointer interaction under way
  let guides = [];
  let dropLine = null;
  let marquee = null;
  let space = false;
  let markColor = MARK_COLORS[0];
  let marksShown = true;
  let noteEdit = null; // { m, input, fresh }: a note being typed
  const listeners = {};
  const emit = (ev, data) => listeners[ev]?.forEach((f) => f(data));

  /* ---------------- history ---------------- */

  const past = [];
  const future = [];
  let lastKey = null;
  let lastAt = 0;
  const snapshot = () => JSON.stringify({ nodes: doc.nodes, meta: doc.meta, fonts: doc.fonts, name: doc.name, marks: doc.marks });
  /** Remember the design before a change, for Undo. Changes with the same `key` close together are one step. */
  function checkpoint(key = null) {
    const now = Date.now();
    if (key && key === lastKey && now - lastAt < 1200) return (lastAt = now);
    lastKey = key;
    lastAt = now;
    past.push(snapshot());
    if (past.length > 200) past.shift();
    future.length = 0;
  }
  function restore(s) {
    const o = JSON.parse(s);
    Object.assign(doc, { nodes: o.nodes, meta: o.meta || {}, fonts: o.fonts || [], name: o.name ?? doc.name, marks: o.marks || [] });
    reindex();
    sel = sel.filter((id) => idx.has(id));
    render();
    emit('change', { history: true });
    emit('select', sel);
  }
  const undo = () => past.length && (future.push(snapshot()), restore(past.pop()), (lastKey = null));
  const redo = () => future.length && (past.push(snapshot()), restore(future.pop()), (lastKey = null));

  /* ---------------- the tree ---------------- */

  const reindex = () => (idx = indexTree(doc.nodes));
  const info = (id) => idx.get(id);
  const node = (id) => idx.get(id)?.node;
  const parentOf = (id) => idx.get(id)?.parent || null;
  const siblings = (id) => (parentOf(id)?.children || doc.nodes);
  const isAncestor = (a, b) => {
    for (let p = parentOf(b); p; p = parentOf(p.id)) if (p.id === a) return true;
    return false;
  };
  /** The selection without layers whose parent is also selected. */
  const topSel = () => sel.filter((id) => idx.has(id) && !sel.some((o) => o !== id && isAncestor(o, id)));

  function detach(id) {
    const list = siblings(id);
    const i = list.findIndex((n) => n.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  /* ---------------- assets and fonts ---------------- */

  function addAsset(dataUrl) {
    for (const [id, v] of Object.entries(doc.assets)) if (v === dataUrl) return id;
    const id = uid().replace(/[^a-z0-9]/g, '');
    doc.assets[id] = dataUrl;
    return id;
  }
  function injectFonts() {
    let style = document.getElementById('dz-fonts');
    if (!style) {
      style = document.createElement('style');
      style.id = 'dz-fonts';
      document.head.append(style);
    }
    const rules = (doc.fonts || [])
      .filter((f) => doc.assets[f.asset])
      .map((f) => `@font-face { font-family: "${f.family.replace(/"/g, '')}"; src: url("${doc.assets[f.asset]}"); font-weight: ${f.weight || 'normal'}; font-style: ${f.style || 'normal'}; font-display: swap; }`);
    style.textContent = rules.join('\n');
  }
  // Captured fonts load after the first draw: measure hug layers again once they're in.
  const onFonts = () => {
    syncSizes();
    drawOverlay();
  };
  document.fonts?.addEventListener('loadingdone', onFonts);

  /* ---------------- drawing the layers ---------------- */

  function build(n, parent) {
    const el = document.createElement('div');
    el.dataset.id = n.id;
    el.className = `dz-n dz-${n.type}`;
    const css = nodeCss(n, parent, { mode: 'canvas', assets: doc.assets });
    if (n.hidden) css.display = 'none';
    el.style.cssText = cssText(css);
    if (n.type === 'text') {
      if (n.runs?.length) for (const r of n.runs) {
        const s = document.createElement('span');
        s.textContent = r.text;
        if (r.style) s.style.cssText = cssText(r.style);
        el.append(s);
      }
      else el.textContent = n.text;
    } else if (n.type === 'svg') {
      el.innerHTML = cleanSvg(n.markup || '');
    } else if (n.type === 'image') {
      const src = resolveSrc(n.src, doc.assets);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        img.style.cssText = `width: 100%; height: 100%; object-fit: ${n.fit || 'cover'}; display: block; pointer-events: none;`;
        el.append(img);
      } else el.classList.add('dz-empty-img');
    }
    els.set(n.id, el);
    n.children?.forEach((c) => el.append(build(c, n)));
    return el;
  }

  /** Re-draw the whole design, then read back the sizes the browser gave hug and fill layers. */
  function render() {
    reindex();
    els = new Map();
    const frag = document.createDocumentFragment();
    doc.nodes.forEach((n) => frag.append(build(n, null)));
    world.replaceChildren(frag);
    applyView();
    syncSizes();
    if (editing) {
      const el = els.get(editing);
      if (el) startEdit(editing, { keep: true });
    }
    drawOverlay();
  }

  function syncSizes() {
    for (const [id, el] of els) {
      const n = node(id);
      if (!n || n.hidden || !el.offsetParent && el.style.display === 'none') continue;
      const s = n.sizing || {};
      if (s.w !== 'fixed' || s.h !== 'fixed' || n.type === 'text') {
        if (s.w !== 'fixed') n.w = el.offsetWidth;
        if (s.h !== 'fixed' || n.type === 'text') n.h = el.offsetHeight;
      }
      const p = parentOf(id);
      if (p && layoutOf(p) && !n.absolute) {
        const [bt, , , bl] = strokeInset(p);
        n.x = el.offsetLeft + bl;
        n.y = el.offsetTop + bt;
      }
    }
  }

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    vp.style.setProperty('--z', view.z);
    vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
  }

  /* ---------------- geometry ---------------- */

  const vpRect = () => vp.getBoundingClientRect();
  /** A layer's box on screen, relative to the canvas. */
  function screenRect(id) {
    const el = els.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const v = vpRect();
    return { x: r.left - v.left, y: r.top - v.top, w: r.width, h: r.height };
  }
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.z, y: (sy - view.y) / view.z });
  function worldRect(id) {
    const s = screenRect(id);
    if (!s) return null;
    const p = toWorld(s.x, s.y);
    return { x: p.x, y: p.y, w: s.w / view.z, h: s.h / view.z };
  }
  const local = (e) => {
    const v = vpRect();
    return { x: e.clientX - v.left, y: e.clientY - v.top };
  };
  const union = (rects) => {
    const rs = rects.filter(Boolean);
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  };

  /** The layers under a point, from the top-level frame down to the deepest. Hidden and locked ones are skipped. */
  function pathAt(clientX, clientY) {
    const hits = document.elementsFromPoint(clientX, clientY);
    const el = hits.find((h) => world.contains(h) && h.closest('.dz-n'))?.closest('.dz-n');
    if (!el) return [];
    const path = [];
    for (let e = el; e && e !== world; e = e.parentElement) if (e.dataset?.id) path.unshift(e.dataset.id);
    // A locked layer can't be picked on the canvas: stop at its parent.
    const lockAt = path.findIndex((id) => node(id)?.locked);
    return lockAt >= 0 ? path.slice(0, lockAt) : path;
  }
  /** Which layer a click picks, Figma's way. */
  function pickFrom(path, deep) {
    if (!path.length) return null;
    if (deep) return path[path.length - 1];
    // At the level you're working at: a sibling of something selected.
    const levels = new Set(sel.map((id) => parentOf(id)?.id ?? null));
    for (let i = path.length - 1; i >= 1; i--) if (levels.has(parentOf(path[i])?.id ?? null)) return path[i];
    // Inside a selected nested layer: keep it (a drag moves it; a click without dragging goes into it).
    const s = path.findIndex((id) => sel.includes(id));
    if (s > 0) return path[s];
    // Otherwise a top-level frame's child, as in Figma (the frame itself from its name, or where it's empty).
    return path[1] ?? path[0];
  }
  /**
   * The frame to draw into or drop onto at a point (deepest unlocked frame), ignoring `skip` and what's inside it.
   * `lists`: prefer an auto layout to the items in it (dropping onto a menu adds to the menu, not into one of its rows).
   */
  function frameAt(clientX, clientY, skip = [], { lists = false } = {}) {
    const hits = document.elementsFromPoint(clientX, clientY).filter((h) => world.contains(h) && h.classList.contains('dz-frame'));
    for (const h of hits) {
      let id = h.dataset.id;
      if (skip.some((s) => s === id || isAncestor(s, id))) continue;
      if (node(id)?.locked || node(id)?.hidden) continue;
      if (lists) {
        for (let p = parentOf(id); p && layoutOf(p) && !node(id).absolute && !skip.includes(p.id); p = parentOf(id)) id = p.id;
      }
      return id;
    }
    return null;
  }

  /* ---------------- the overlay: selection, handles, guides, labels ---------------- */

  function drawOverlay() {
    drawMarks();
    const parts = [];
    const z = view.z;
    // Top-level frame names, above each frame (click or drag them to select the frame).
    for (const n of doc.nodes) {
      if (n.type !== 'frame' && !n.ref) continue;
      const r = screenRect(n.id);
      if (!r) continue;
      const on = sel.includes(n.id);
      const label = n.variant ? `${esc(n.name)}` : esc(n.name);
      parts.push(`<div class="dz-label${on ? ' on' : ''}${n.variant ? ' variant' : ''}" data-label="${n.id}" style="left:${r.x}px;top:${r.y - 20}px;max-width:${Math.max(60, r.w)}px">${n.variant ? '<i>◆</i>' : ''}${label}</div>`);
    }
    // Hover outline
    if (hover && !sel.includes(hover) && !drag) {
      const r = screenRect(hover);
      if (r) parts.push(`<div class="dz-hover" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`);
    }
    const live = sel.filter((id) => idx.has(id));
    // Selection
    const rects = live.map((id) => screenRect(id)).filter(Boolean);
    for (const r of rects) parts.push(`<div class="dz-sel" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`);
    const box = union(rects);
    if (box && !editing) {
      if (rects.length > 1) parts.push(`<div class="dz-sel group" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px"></div>`);
      const small = box.w < 24 || box.h < 24;
      if (live.length === 1 && !(drag?.kind === 'move')) {
        for (const h of HANDLES) {
          if (small && h.length === 1) continue;
          const hx = box.x + (h.includes('w') ? 0 : h.includes('e') ? box.w : box.w / 2);
          const hy = box.y + (h.includes('n') ? 0 : h.includes('s') ? box.h : box.h / 2);
          parts.push(`<div class="dz-handle h-${h}" data-handle="${h}" style="left:${hx}px;top:${hy}px"></div>`);
        }
        // Edges resize too (wider targets than the handles).
        parts.push(`<div class="dz-edge e-n" data-handle="n" style="left:${box.x}px;top:${box.y - 3}px;width:${box.w}px"></div>`,
          `<div class="dz-edge e-s" data-handle="s" style="left:${box.x}px;top:${box.y + box.h - 3}px;width:${box.w}px"></div>`,
          `<div class="dz-edge e-w" data-handle="w" style="left:${box.x - 3}px;top:${box.y}px;height:${box.h}px"></div>`,
          `<div class="dz-edge e-e" data-handle="e" style="left:${box.x + box.w - 3}px;top:${box.y}px;height:${box.h}px"></div>`);
      }
      const wr = live.length === 1 ? node(live[0]) : null;
      const w = wr ? wr.w : box.w / z;
      const h = wr ? wr.h : box.h / z;
      const sz = wr?.sizing || {};
      const tag = (v, m) => `${fmt(v)}${m === 'hug' ? ' Hug' : m === 'fill' ? ' Fill' : ''}`;
      parts.push(`<div class="dz-size" style="left:${box.x + box.w / 2}px;top:${box.y + box.h + 8}px">${tag(w, sz.w)} × ${tag(h, sz.h)}</div>`);
    }
    for (const g of guides) parts.push(`<div class="dz-guide ${g.axis}" style="${g.axis === 'x' ? `left:${g.pos}px;top:${g.from}px;height:${g.to - g.from}px` : `top:${g.pos}px;left:${g.from}px;width:${g.to - g.from}px`}"></div>`);
    if (dropLine) parts.push(`<div class="dz-drop ${dropLine.axis}" style="left:${dropLine.x}px;top:${dropLine.y}px;${dropLine.axis === 'x' ? `height:${dropLine.len}px` : `width:${dropLine.len}px`}"></div>`);
    if (drag?.dropFrame) {
      const r = screenRect(drag.dropFrame);
      if (r) parts.push(`<div class="dz-target" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`);
    }
    if (marquee) parts.push(`<div class="dz-marquee" style="left:${marquee.x}px;top:${marquee.y}px;width:${marquee.w}px;height:${marquee.h}px"></div>`);
    if (drag?.kind === 'draw' && drag.rect) {
      const r = drag.rect;
      parts.push(`<div class="dz-size" style="left:${view.x + (r.x + r.w / 2) * z}px;top:${view.y + (r.y + r.h) * z + 8}px">${fmt(r.w)} × ${fmt(r.h)}</div>`);
    }
    if (drag?.measure) parts.push(drag.measure);
    overlay.innerHTML = parts.join('');
  }
  const fmt = (v) => String(Math.round(v * 100) / 100);

  /* ---------------- selection ---------------- */

  function select(ids, { add = false, toggle = false } = {}) {
    ids = (Array.isArray(ids) ? ids : [ids]).filter((id) => id && idx.has(id));
    if (toggle) {
      const s = new Set(sel);
      ids.forEach((id) => (s.has(id) ? s.delete(id) : s.add(id)));
      sel = [...s];
    } else sel = add ? [...new Set([...sel, ...ids])] : ids;
    drawOverlay();
    emit('select', sel);
  }

  /* ---------------- view ---------------- */

  function zoomAt(z, sx, sy) {
    z = Math.min(MAX_Z, Math.max(MIN_Z, z));
    const w = toWorld(sx, sy);
    view = { x: sx - w.x * z, y: sy - w.y * z, z };
    applyView();
    drawOverlay();
    emit('view', view);
  }
  function zoomTo(z) {
    const v = vpRect();
    zoomAt(z, v.width / 2, v.height / 2);
  }
  /** Show `ids` (or everything) filling the canvas. */
  function fit(ids, { max = 2, pad = 80, include = null } = {}) {
    const list = ids?.length ? ids : doc.nodes.map((n) => n.id);
    const r = union([...list.map(worldRect), include]);
    const v = vpRect();
    if (!r || !v.width) return;
    const z = Math.min(max, Math.max(MIN_Z, Math.min((v.width - pad * 2) / Math.max(r.w, 1), (v.height - pad * 2) / Math.max(r.h, 1))));
    view = { z, x: v.width / 2 - (r.x + r.w / 2) * z, y: v.height / 2 - (r.y + r.h / 2) * z };
    applyView();
    drawOverlay();
    emit('view', view);
  }
  function setView(v) {
    view = { ...view, ...v };
    applyView();
    drawOverlay();
  }

  /* ---------------- changing the design ---------------- */

  /** Finish a change: re-draw, tell the app (it saves). */
  function commit({ select: s, quiet = false } = {}) {
    render();
    if (s) select(s);
    else if (!quiet) emit('select', sel);
    emit('change', { quiet });
  }

  /** Where new top-level frames go: right of everything (or the middle of the screen on an empty canvas). */
  function freeSpot(w, h) {
    const v = vpRect();
    const center = toWorld(v.width / 2, v.height / 2);
    const all = union(doc.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
    if (!all) return { x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2) };
    return { x: Math.round(all.x + all.w + 80), y: Math.round(all.y) };
  }
  /** Bring layers into view if they're off screen (zooming out only if they don't fit). */
  function reveal(ids) {
    const r = union(ids.map(screenRect));
    const v = vpRect();
    if (!r || (r.x >= 0 && r.y >= 0 && r.x + r.w <= v.width && r.y + r.h <= v.height)) return;
    fit(ids, { max: view.z });
  }

  /**
   * Add layers. into: a frame id (or null for the canvas); at: world point for the first one's top-left (top level);
   * Without `into`, a selected frame takes them (pasting into the selection, like Figma).
   */
  function insert(nodes, { into = undefined, at = null, index = null, selectThem = true, keepPositions = false } = {}) {
    if (!nodes.length) return [];
    checkpoint();
    let target = into;
    if (target === undefined) {
      const one = sel.length === 1 ? node(sel[0]) : null;
      target = one?.type === 'frame' && !nodes.some((n) => n.variant) ? one.id : null;
    }
    const parent = target ? node(target) : null;
    const box = union(nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
    if (!parent) {
      const spot = at || (keepPositions ? null : freeSpot(box.w, box.h));
      if (spot) nodes.forEach((n) => ((n.x += spot.x - box.x), (n.y += spot.y - box.y)));
      doc.nodes.splice(index ?? doc.nodes.length, 0, ...nodes);
    } else {
      if (!layoutOf(parent)) {
        // Centered in the frame unless it fits where it came from.
        const fits = box.x >= 0 && box.y >= 0 && box.x + box.w <= parent.w && box.y + box.h <= parent.h;
        if (!fits || !keepPositions) {
          const dx = Math.round((parent.w - box.w) / 2) - box.x;
          const dy = Math.round((parent.h - box.h) / 2) - box.y;
          nodes.forEach((n) => ((n.x += dx), (n.y += dy)));
        }
      }
      parent.children.splice(index ?? parent.children.length, 0, ...nodes);
    }
    commit({ select: selectThem ? nodes.map((n) => n.id) : sel });
    requestAnimationFrame(() => reveal(nodes.map((n) => n.id)));
    return nodes;
  }

  /** Move a layer into another parent (null = the canvas) at an index, keeping where it is on screen. */
  function reparent(id, newParentId, index = null) {
    const n = node(id);
    const r = worldRect(id);
    const pr = newParentId ? worldRect(newParentId) : { x: 0, y: 0 };
    detach(id);
    const list = newParentId ? node(newParentId).children : doc.nodes;
    list.splice(index == null ? list.length : Math.min(index, list.length), 0, n);
    n.x = Math.round((r.x - pr.x) * 100) / 100;
    n.y = Math.round((r.y - pr.y) * 100) / 100;
    if (!newParentId) {
      delete n.absolute;
      if (n.sizing?.w === 'fill') n.sizing.w = 'fixed';
      if (n.sizing?.h === 'fill') n.sizing.h = 'fixed';
    }
    reindex();
  }

  const ops = {
    delete() {
      const ids = topSel();
      if (!ids.length) return;
      checkpoint();
      for (const id of ids) {
        detach(id);
        delete doc.meta?.[id];
        // A component's states go with it, and its backdrop and original picture.
        doc.nodes = doc.nodes.filter((f) => f.variant?.of !== id && f.ref !== id);
      }
      sel = [];
      commit();
    },
    duplicate() {
      const ids = topSel();
      if (!ids.length) return;
      checkpoint();
      const out = [];
      for (const id of ids) {
        const n = node(id);
        const c = cloneNode(n, { keepLinks: !!parentOf(id) });
        if (!parentOf(id)) {
          c.x += n.w + 40;
          if (n.variant) c.variant = { ...n.variant, state: n.variant.state + '-copy' };
          c.name = n.name;
        } else if (!layoutOf(parentOf(id))) {
          c.x += 10;
          c.y += 10;
        }
        const list = siblings(id);
        list.splice(list.indexOf(n) + 1, 0, c);
        out.push(c.id);
      }
      commit({ select: out });
    },
    /** Ctrl+G: wrap the selection in a frame (no fill, positioned as it was). */
    group({ auto = false } = {}) {
      const ids = topSel();
      if (!ids.length) return;
      const pid = parentOf(ids[0])?.id ?? null;
      if (ids.some((id) => (parentOf(id)?.id ?? null) !== pid)) return;
      checkpoint();
      const rects = ids.map(worldRect);
      const box = union(rects);
      const pr = pid ? worldRect(pid) : { x: 0, y: 0 };
      const list = siblings(ids[0]);
      const order = ids.map((id) => list.findIndex((n) => n.id === id)).sort((a, b) => a - b);
      const g = makeNode('frame', { name: auto ? 'Frame' : 'Group', fills: [], x: Math.round(box.x - pr.x), y: Math.round(box.y - pr.y), w: Math.round(box.w), h: Math.round(box.h), layout: { mode: 'none' } });
      const members = order.map((i) => list[i]);
      members.forEach((m, k) => {
        const r = worldRect(m.id);
        m.x = Math.round(r.x - box.x);
        m.y = Math.round(r.y - box.y);
        delete m.absolute;
      });
      for (const m of members) detach(m.id);
      g.children = members;
      list.splice(order[0], 0, g);
      if (pid && layoutOf(node(pid))) g.sizing = { w: 'hug', h: 'hug' };
      reindex();
      if (auto) inferAutoLayout(g);
      commit({ select: [g.id] });
    },
    /** Ctrl+Shift+G: put a frame's layers where it is, and remove it. */
    ungroup() {
      const ids = topSel().filter((id) => node(id)?.type === 'frame' && node(id).children?.length);
      if (!ids.length) return;
      checkpoint();
      const out = [];
      for (const id of ids) {
        const g = node(id);
        const pid = parentOf(id)?.id ?? null;
        const list = siblings(id);
        const at = list.indexOf(g);
        const rects = g.children.map((c) => ({ c, r: worldRect(c.id) }));
        const pr = pid ? worldRect(pid) : { x: 0, y: 0 };
        list.splice(at, 1, ...g.children);
        for (const { c, r } of rects) {
          c.x = Math.round(r.x - pr.x);
          c.y = Math.round(r.y - pr.y);
          out.push(c.id);
        }
      }
      commit({ select: out });
    },
    /** Shift+A: auto layout on the selected frame, or wrap the selected layers in a new auto layout frame. */
    autoLayout() {
      const ids = topSel();
      if (!ids.length) return;
      const n = node(ids[0]);
      if (ids.length === 1 && n.type === 'frame') {
        checkpoint();
        if (layoutOf(n)) freeLayouts([n]);
        else inferAutoLayout(n);
        return commit();
      }
      ops.group({ auto: true });
    },
    /** Free design: the selected frames' auto layouts (`deep`: and every one inside them) become free layers that stay where they are. */
    freeLayout({ deep = false } = {}) {
      const frames = [];
      for (const id of topSel()) {
        if (deep) for (const { node: m } of walk([node(id)])) layoutOf(m) && frames.push(m);
        else if (layoutOf(node(id))) frames.push(node(id));
      }
      if (!frames.length) return;
      checkpoint();
      freeLayouts(frames);
      commit();
    },
    align(how) {
      const ids = topSel();
      if (!ids.length) return;
      checkpoint();
      const one = ids.length === 1;
      const box = one ? (parentOf(ids[0]) ? worldRect(parentOf(ids[0]).id) : null) : union(ids.map(worldRect));
      if (!box) return;
      for (const id of ids) {
        const n = node(id);
        if (parentOf(id) && layoutOf(parentOf(id)) && !n.absolute) continue;
        const r = worldRect(id);
        let dx = 0;
        let dy = 0;
        if (how === 'left') dx = box.x - r.x;
        if (how === 'hcenter') dx = box.x + box.w / 2 - (r.x + r.w / 2);
        if (how === 'right') dx = box.x + box.w - (r.x + r.w);
        if (how === 'top') dy = box.y - r.y;
        if (how === 'vcenter') dy = box.y + box.h / 2 - (r.y + r.h / 2);
        if (how === 'bottom') dy = box.y + box.h - (r.y + r.h);
        n.x = Math.round(n.x + dx);
        n.y = Math.round(n.y + dy);
      }
      commit();
    },
    distribute(axis) {
      const ids = topSel().filter((id) => !(parentOf(id) && layoutOf(parentOf(id)) && !node(id).absolute));
      if (ids.length < 3) return;
      checkpoint();
      const items = ids.map((id) => ({ n: node(id), r: worldRect(id) })).sort((a, b) => (axis === 'x' ? a.r.x - b.r.x : a.r.y - b.r.y));
      const first = items[0].r;
      const last = items[items.length - 1].r;
      const total = items.reduce((t, i) => t + (axis === 'x' ? i.r.w : i.r.h), 0);
      const space = ((axis === 'x' ? last.x + last.w - first.x : last.y + last.h - first.y) - total) / (items.length - 1);
      let pos = axis === 'x' ? first.x : first.y;
      for (const i of items) {
        const d = pos - (axis === 'x' ? i.r.x : i.r.y);
        if (axis === 'x') i.n.x = Math.round(i.n.x + d);
        else i.n.y = Math.round(i.n.y + d);
        pos += (axis === 'x' ? i.r.w : i.r.h) + space;
      }
      commit();
    },
    /** Move in the stacking order: +1 forward, -1 backward, Infinity to the front, -Infinity to the back. */
    order(step) {
      const ids = topSel();
      if (!ids.length) return;
      checkpoint();
      for (const id of step > 0 ? [...ids].reverse() : ids) {
        const list = siblings(id);
        const i = list.findIndex((n) => n.id === id);
        const j = Math.max(0, Math.min(list.length - 1, step === Infinity ? list.length - 1 : step === -Infinity ? 0 : i + step));
        if (i === j) continue;
        const [n] = list.splice(i, 1);
        list.splice(j, 0, n);
      }
      commit();
    },
    toggle(prop) {
      const ids = topSel();
      if (!ids.length) return;
      checkpoint();
      const on = !ids.every((id) => node(id)[prop]);
      ids.forEach((id) => (on ? (node(id)[prop] = true) : delete node(id)[prop]));
      if (prop === 'locked' && on) sel = [];
      commit();
    },
    /** Arrow keys: nudge, or within auto layout move earlier / later. */
    nudge(dx, dy) {
      const ids = topSel();
      if (!ids.length) return;
      checkpoint('nudge');
      for (const id of ids) {
        const p = parentOf(id);
        const n = node(id);
        const L = p && layoutOf(p);
        if (L && !n.absolute) {
          const d = L.mode === 'row' ? dx || dy : dy || dx;
          const list = p.children;
          const i = list.indexOf(n);
          const j = Math.max(0, Math.min(list.length - 1, i + Math.sign(d)));
          list.splice(i, 1);
          list.splice(j, 0, n);
        } else {
          n.x = Math.round((n.x + dx) * 100) / 100;
          n.y = Math.round((n.y + dy) * 100) / 100;
        }
      }
      commit();
    },
    selectAll() {
      const base = sel.length ? siblings(sel[0]) : doc.nodes;
      select(base.filter((n) => !n.locked && !n.hidden).map((n) => n.id));
    },
    selectChildren() {
      const out = topSel().flatMap((id) => node(id)?.children?.map((c) => c.id) || []);
      if (out.length) select(out);
      else if (sel.length === 1 && node(sel[0])?.type === 'text') startEdit(sel[0]);
    },
    selectParent() {
      const ps = [...new Set(topSel().map((id) => parentOf(id)?.id).filter(Boolean))];
      select(ps.length ? ps : []);
    },
    selectSibling(step) {
      if (sel.length !== 1) return;
      const list = siblings(sel[0]);
      const i = list.findIndex((n) => n.id === sel[0]);
      const n = list[(i + step + list.length) % list.length];
      if (n) select([n.id]);
    },
  };

  /**
   * Take frames out of auto layout without moving anything: the last draw measured every layer (syncSizes), so the
   * children keep those boxes as positions. Hug and fill become fixed sizes where they no longer mean anything
   * (text keeps hugging; a frame that keeps its auto layout still hugs its content).
   */
  function freeLayouts(frames) {
    const freed = new Set(frames);
    const fix = (n, keepHug) => {
      const s = { ...n.sizing };
      for (const a of ['w', 'h']) if (s[a] === 'fill' || (s[a] === 'hug' && !keepHug)) s[a] = 'fixed';
      n.sizing = s;
    };
    for (const f of frames) {
      f.layout = { mode: 'none' };
      const s = { ...f.sizing };
      for (const a of ['w', 'h']) if (s[a] === 'hug') s[a] = 'fixed';
      f.sizing = s;
      for (const c of f.children || []) {
        delete c.absolute;
        fix(c, c.type === 'text' || (layoutOf(c) && !freed.has(c)));
      }
    }
  }

  /** Turn a frame's free layout into auto layout, guessing the direction, gap and padding from where things are. */
  function inferAutoLayout(f) {
    const kids = (f.children || []).filter((c) => !c.absolute);
    if (!kids.length) {
      f.layout = { mode: 'row', gap: 10, padding: [10, 10, 10, 10], align: 'center', justify: 'start' };
      f.sizing = { w: 'hug', h: 'hug' };
      return;
    }
    const xs = kids.map((c) => c.x);
    const ys = kids.map((c) => c.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    const row = spreadX >= spreadY;
    kids.sort((a, b) => (row ? a.x - b.x : a.y - b.y));
    const gaps = [];
    for (let i = 1; i < kids.length; i++) gaps.push(row ? kids[i].x - (kids[i - 1].x + kids[i - 1].w) : kids[i].y - (kids[i - 1].y + kids[i - 1].h));
    const gap = Math.max(0, Math.round(gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxR = Math.max(...kids.map((c) => c.x + c.w));
    const maxB = Math.max(...kids.map((c) => c.y + c.h));
    const pad = [minY, f.w - maxR, f.h - maxB, minX].map((v) => Math.max(0, Math.round(v)));
    const others = (f.children || []).filter((c) => c.absolute);
    f.children = [...kids, ...others];
    f.layout = { mode: row ? 'row' : 'column', gap, padding: pad, align: 'center', justify: 'start' };
    f.sizing = { w: 'hug', h: 'hug' };
  }

  /* ---------------- text editing ---------------- */

  /** Type into a text layer. `fresh`: it was just made (its creation is already the undo step). */
  function startEdit(id, { keep = false, fresh = false } = {}) {
    const n = node(id);
    const el = els.get(id);
    if (!n || n.type !== 'text' || !el) return;
    if (!keep && editing && editing !== id) endEdit();
    if (!keep && !fresh) checkpoint();
    editing = id;
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    el.spellcheck = false;
    el.focus();
    // Select all to start; after a re-draw, put the caret back at the end.
    const r = document.createRange();
    r.selectNodeContents(el);
    if (keep) r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    el.oninput = () => {
      n.text = el.innerText.replace(/\n$/, '');
      delete n.runs;
      syncSizes();
      drawOverlay();
    };
    el.onblur = () => editing === id && endEdit();
    el.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        endEdit();
        vp.focus();
      }
    };
    drawOverlay();
  }
  function endEdit() {
    const id = editing;
    if (!id) return;
    editing = null;
    const el = els.get(id);
    const n = node(id);
    if (el) {
      el.contentEditable = 'false';
      el.classList.remove('editing');
      el.oninput = el.onblur = el.onkeydown = null;
    }
    if (n && !n.text.trim() && !n.runs?.length) {
      detach(id);
      sel = sel.filter((s) => s !== id);
    }
    getSelection()?.removeAllRanges();
    commit();
  }

  /* ---------------- pointer ---------------- */

  vp.addEventListener('pointerdown', (e) => {
    if (editing && e.target.closest('.editing')) return;
    if (e.target.closest('.dz-note-edit')) return;
    if (editing) endEdit();
    vp.focus({ preventScroll: true });
    const p = local(e);
    // Pan: middle button, Space, or the hand tool.
    if (e.button === 1 || (e.button === 0 && (space || tool === 'hand'))) {
      e.preventDefault();
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, view: { ...view } };
      vp.classList.add('panning');
      return capture(e);
    }
    if (e.button !== 0) return;
    if (isMarkTool(tool)) return startMark(e, p);
    const handle = e.target.closest('[data-handle]');
    if (handle && sel.length === 1) return startResize(e, handle.dataset.handle);
    const label = e.target.closest('[data-label]');
    if (label) {
      const id = label.dataset.label;
      if (e.shiftKey) return select([id], { toggle: true });
      if (!sel.includes(id)) select([id]);
      return startMove(e, p);
    }
    if (['frame', 'rect', 'ellipse', 'text'].includes(tool)) return startDraw(e, p);
    const path = pathAt(e.clientX, e.clientY);
    const id = pickFrom(path, e.ctrlKey || e.metaKey);
    if (!id) {
      if (!e.shiftKey) select([]);
      drag = { kind: 'marquee', start: p, base: e.shiftKey ? [...sel] : [] };
      return capture(e);
    }
    if (e.shiftKey) return select([id], { toggle: true });
    // Pressing inside the selection drags the selection; a click there without dragging selects what's under it.
    const inSel = path.some((x) => sel.includes(x));
    if (inSel && !sel.includes(id)) {
      startMove(e, p);
      if (drag) drag.clickSelect = id;
      return;
    }
    if (!sel.includes(id)) select([id]);
    startMove(e, p);
  });

  function capture(e) {
    try {
      vp.setPointerCapture(e.pointerId);
    } catch {}
  }

  vp.addEventListener('dblclick', (e) => {
    if (editing) return;
    const path = pathAt(e.clientX, e.clientY);
    if (!path.length) return;
    const cur = sel.length === 1 ? path.indexOf(sel[0]) : -1;
    const target = cur >= 0 && path[cur + 1] ? path[cur + 1] : path[path.length - 1];
    const n = node(target);
    if (n?.type === 'text' && (sel[0] === target || cur === path.length - 1 || path[cur + 1] === target)) return startEdit(target);
    if (sel[0] === target && n?.type === 'text') return startEdit(target);
    select([target]);
    if (n?.type === 'text' && cur === path.length - 2) startEdit(target);
  });

  function startMove(e, p) {
    const ids = topSel().filter((id) => !node(id).locked);
    if (!ids.length) return;
    drag = {
      kind: 'move',
      start: p,
      ids,
      moved: false,
      alt: e.altKey,
      items: ids.map((id) => ({ id, n: node(id), x: node(id).x, y: node(id).y, flow: !!(parentOf(id) && layoutOf(parentOf(id)) && !node(id).absolute), r: worldRect(id) })),
    };
    capture(e);
  }

  function startResize(e, h) {
    const id = sel[0];
    const n = node(id);
    if (n.locked) return;
    checkpoint();
    drag = { kind: 'resize', h, id, start: local(e), r: worldRect(id), x: n.x, y: n.y, w: n.w, h0: n.h, ratio: n.w / Math.max(1, n.h) };
    capture(e);
  }

  function startDraw(e, p) {
    const w = toWorld(p.x, p.y);
    const into = frameAt(e.clientX, e.clientY);
    drag = { kind: 'draw', start: p, origin: w, into, made: null, rect: null, type: tool };
    capture(e);
  }

  vp.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (!drag) {
      const path = pathAt(e.clientX, e.clientY);
      const h = e.target.closest('[data-label]')?.dataset.label || (tool === 'move' ? pickFrom(path, e.ctrlKey || e.metaKey) : null);
      if (h !== hover) {
        hover = h;
        drawOverlay();
        emit('hover', hover);
      }
      if (e.altKey && sel.length && hover && !sel.includes(hover)) measure();
      return;
    }
    if (drag.kind === 'pan') {
      view = { ...drag.view, x: drag.view.x + e.clientX - drag.sx, y: drag.view.y + e.clientY - drag.sy };
      applyView();
      drawOverlay();
      return;
    }
    if (drag.kind === 'marquee') {
      const s = drag.start;
      marquee = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      const hit = doc.nodes.filter((n) => {
        if (n.locked || n.hidden) return false;
        const r = screenRect(n.id);
        return r && r.x < marquee.x + marquee.w && r.x + r.w > marquee.x && r.y < marquee.y + marquee.h && r.y + r.h > marquee.y;
      });
      sel = [...new Set([...drag.base, ...hit.map((n) => n.id)])];
      drawOverlay();
      emit('select', sel);
      return;
    }
    if (drag.kind === 'move') return moveTo(e, p);
    if (drag.kind === 'resize') return resizeTo(e, p);
    if (drag.kind === 'draw') return drawTo(e, p);
    if (drag.kind === 'mark') return (drag.moved = true), markTo(e, p);
    if (drag.kind === 'erase') return eraseAt(p);
  });

  vp.addEventListener('pointerup', (e) => finishDrag(e));
  vp.addEventListener('pointercancel', (e) => finishDrag(e, true));
  vp.addEventListener('pointerleave', () => {
    if (!drag && hover) {
      hover = null;
      drawOverlay();
      emit('hover', null);
    }
  });

  function finishDrag(e, cancelled = false) {
    const d = drag;
    if (!d) return;
    drag = null;
    guides = [];
    dropLine = null;
    marquee = null;
    vp.classList.remove('panning');
    if (d.kind === 'pan') return emit('view', view);
    if (d.kind === 'marquee') return drawOverlay();
    if (d.kind === 'mark') return finishMark(d, cancelled);
    if (d.kind === 'erase') return;
    if (d.kind === 'move') {
      if (!d.moved) {
        // A click (no drag) inside the selection: select the layer under the pointer.
        if (d.clickSelect && !cancelled) return select([d.clickSelect]);
        return drawOverlay();
      }
      if (cancelled) return restore(past.pop());
      // Into another frame, out onto the canvas, or to a new place in the same auto layout.
      const target = d.dropFrame;
      let index = d.dropIndex;
      for (const it of d.items) {
        const cur = parentOf(it.id)?.id ?? null;
        if (target !== undefined && target !== cur) {
          reparent(it.id, target, index);
          if (index != null) index++;
          if (it.flow && !(target && layoutOf(node(target)))) {
            // Out of an auto layout: it lands where it was dropped.
            const pr = target ? worldRect(target) : { x: 0, y: 0 };
            it.n.x = Math.round(it.r.x + d.dx - pr.x);
            it.n.y = Math.round(it.r.y + d.dy - pr.y);
          }
        } else if (it.flow && index != null) {
          const list = siblings(it.id);
          const i = list.indexOf(it.n);
          list.splice(i, 1);
          const j = index > i ? index - 1 : index;
          list.splice(j, 0, it.n);
          index = j + 1;
        }
      }
      return commit();
    }
    if (d.kind === 'resize') return commit();
    if (d.kind === 'draw') {
      if (!d.made) {
        // A click: a default-sized layer, or text to type.
        const w = d.type === 'text' ? 0 : 100;
        makeDrawn(d, { x: d.origin.x - (d.into ? 0 : 0), y: d.origin.y, w, h: w });
      }
      const id = d.made;
      setTool('move');
      commit({ select: [id] });
      if (node(id)?.type === 'text') requestAnimationFrame(() => startEdit(id, { fresh: true }));
    }
  }

  /* ----- moving ----- */

  function moveTo(e, p) {
    const d = drag;
    let dx = (p.x - d.start.x) / view.z;
    let dy = (p.y - d.start.y) / view.z;
    if (!d.moved) {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 3) return;
      d.moved = true;
      checkpoint();
      if (d.alt) {
        // Alt+drag: drag a copy, leave the original.
        for (const it of d.items) {
          const c = cloneNode(it.n, { keepLinks: true });
          const list = siblings(it.id);
          list.splice(list.indexOf(it.n), 0, c);
        }
        render();
      }
    }
    if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    const free = d.items.filter((it) => !it.flow);
    d.dx = dx;
    d.dy = dy;
    // Where it would land: the deepest frame under the pointer (or the canvas). Top-level frames stay top-level.
    const skip = d.ids;
    const curParent = parentOf(d.ids[0])?.id ?? null;
    // Components with states, states and reference pictures stay on the canvas; anything else can go into a frame.
    const anchored = d.items.some((it) => !parentOf(it.id) && (it.n.variant || it.n.ref || doc.nodes.some((v) => v.variant?.of === it.id)));
    let target = anchored ? null : frameAt(e.clientX, e.clientY, skip, { lists: !(e.ctrlKey || e.metaKey) });
    // An auto layout's item stays in its list (reordering) while the pointer is still over the list.
    if (curParent && d.items.some((it) => it.flow)) {
      const pr = screenRect(curParent);
      const lp = local(e);
      if (pr && lp.x >= pr.x && lp.x <= pr.x + pr.w && lp.y >= pr.y && lp.y <= pr.y + pr.h) target = curParent;
    }
    d.dropFrame = target === curParent ? undefined : target;
    d.dropIndex = null;
    dropLine = null;
    // Auto layout: show where it would go in the row or column.
    const targetNode = target ? node(target) : null;
    if (targetNode && layoutOf(targetNode)) {
      const L = layoutOf(targetNode);
      const kids = targetNode.children.filter((c) => !c.absolute && !skip.includes(c.id) && !c.hidden);
      const row = L.mode === 'row';
      let i = kids.length;
      for (let k = 0; k < kids.length; k++) {
        const r = screenRect(kids[k].id);
        if (row ? p.x < r.x + r.w / 2 : p.y < r.y + r.h / 2) {
          i = k;
          break;
        }
      }
      const all = targetNode.children;
      d.dropIndex = i < kids.length ? all.indexOf(kids[i]) : all.length;
      const tr = screenRect(target);
      const ref = kids[i] ? screenRect(kids[i].id) : kids[i - 1] ? screenRect(kids[i - 1].id) : null;
      if (row) dropLine = { axis: 'x', x: ref ? (kids[i] ? ref.x - 2 : ref.x + ref.w + 1) : tr.x + 4, y: tr.y + 2, len: tr.h - 4 };
      else dropLine = { axis: 'y', x: tr.x + 2, y: ref ? (kids[i] ? ref.y - 2 : ref.y + ref.h + 1) : tr.y + 4, len: tr.w - 4 };
      // Free layers dropped into an auto layout join the flow; free layers moving inside one stay free.
      if (target === curParent && !d.items.some((it) => it.flow)) dropLine = null;
    }
    // Free layers follow the pointer, snapping to their neighbors' edges and centers.
    if (free.length && !(dropLine && d.dropFrame !== undefined)) {
      const box = union(free.map((it) => ({ x: it.r.x + dx, y: it.r.y + dy, w: it.r.w, h: it.r.h })));
      const snapped = e.ctrlKey || e.metaKey ? { dx: 0, dy: 0, guides: [] } : snapBox(box, d.ids, curParent);
      dx += snapped.dx;
      dy += snapped.dy;
      guides = snapped.guides;
      for (const it of free) {
        it.n.x = Math.round((it.x + dx) * 100) / 100;
        it.n.y = Math.round((it.y + dy) * 100) / 100;
        const el = els.get(it.id);
        if (el) {
          const p2 = parentOf(it.id);
          const [bt, , , bl] = p2 ? strokeInset(p2) : [0, 0, 0, 0];
          el.style.left = `${it.n.x - bl}px`;
          el.style.top = `${it.n.y - bt}px`;
        }
      }
    } else guides = [];
    // Flow layers: show a ghost following the pointer.
    // Layers in an auto layout stay in place (lifted) until dropped; the line shows where they'll go.
    for (const it of d.items) if (it.flow) els.get(it.id)?.classList.add('dz-lifted');
    if (!dropLine && d.items.some((it) => it.flow) && d.dropFrame === undefined) dropLine = null;
    drawOverlay();
  }

  /** Snap a moving box (world) to the edges and centers of the layers around it. Returns the correction and the guide lines. */
  function snapBox(box, skip, parentId) {
    const cands = [];
    const pool = parentId ? node(parentId).children : doc.nodes;
    for (const n of pool) if (!skip.includes(n.id) && !n.hidden) cands.push(worldRect(n.id));
    if (parentId) cands.push(worldRect(parentId));
    const th = SNAP / view.z;
    const xs = [box.x, box.x + box.w / 2, box.x + box.w];
    const ys = [box.y, box.y + box.h / 2, box.y + box.h];
    let bx = null;
    let by = null;
    for (const c of cands.filter(Boolean)) {
      for (const cx of [c.x, c.x + c.w / 2, c.x + c.w]) for (const x of xs) {
        const dd = cx - x;
        if (Math.abs(dd) <= th && (!bx || Math.abs(dd) < Math.abs(bx.d))) bx = { d: dd, pos: cx, c };
      }
      for (const cy of [c.y, c.y + c.h / 2, c.y + c.h]) for (const y of ys) {
        const dd = cy - y;
        if (Math.abs(dd) <= th && (!by || Math.abs(dd) < Math.abs(by.d))) by = { d: dd, pos: cy, c };
      }
    }
    const out = [];
    const z = view.z;
    if (bx) {
      const from = Math.min(box.y, bx.c.y);
      const to = Math.max(box.y + box.h, bx.c.y + bx.c.h);
      out.push({ axis: 'x', pos: view.x + bx.pos * z, from: view.y + from * z, to: view.y + to * z });
    }
    if (by) {
      const from = Math.min(box.x, by.c.x);
      const to = Math.max(box.x + box.w, by.c.x + by.c.w);
      out.push({ axis: 'y', pos: view.y + by.pos * z, from: view.x + from * z, to: view.x + to * z });
    }
    return { dx: bx?.d || 0, dy: by?.d || 0, guides: out };
  }

  /* ----- resizing ----- */

  function resizeTo(e, p) {
    const d = drag;
    const n = node(d.id);
    const dx = (p.x - d.start.x) / view.z;
    const dy = (p.y - d.start.y) / view.z;
    let { x, y, w, h } = d.r;
    const hd = d.h;
    if (hd.includes('e')) w = d.r.w + dx;
    if (hd.includes('w')) (w = d.r.w - dx), (x = d.r.x + dx);
    if (hd.includes('s')) h = d.r.h + dy;
    if (hd.includes('n')) (h = d.r.h - dy), (y = d.r.y + dy);
    if (e.shiftKey && hd.length === 2) {
      // Keep proportions.
      if (Math.abs(w / d.ratio) > Math.abs(h)) h = w / d.ratio;
      else w = h * d.ratio;
      if (hd.includes('w')) x = d.r.x + d.r.w - w;
      if (hd.includes('n')) y = d.r.y + d.r.h - h;
    }
    if (e.altKey) {
      if (hd.includes('e') || hd.includes('w')) (w = d.r.w + 2 * (hd.includes('e') ? dx : -dx)), (x = d.r.x + (d.r.w - w) / 2);
      if (hd.includes('n') || hd.includes('s')) (h = d.r.h + 2 * (hd.includes('s') ? dy : -dy)), (y = d.r.y + (d.r.h - h) / 2);
    }
    // Snap the moving edges to neighbors.
    guides = [];
    if (!(e.ctrlKey || e.metaKey) && !e.altKey) {
      const s = snapBox({ x, y, w, h }, [d.id, ...[...walk([n])].map((x2) => x2.node.id)], parentOf(d.id)?.id ?? null);
      if (s.dx && (hd.includes('e') || hd.includes('w'))) hd.includes('e') ? (w += s.dx) : ((x += s.dx), (w -= s.dx));
      if (s.dy && (hd.includes('n') || hd.includes('s'))) hd.includes('s') ? (h += s.dy) : ((y += s.dy), (h -= s.dy));
      guides = s.guides;
    }
    w = Math.max(1, Math.round(w * 100) / 100);
    h = Math.max(1, Math.round(h * 100) / 100);
    const sz = { ...(n.sizing || { w: 'fixed', h: 'fixed' }) };
    if (hd.includes('e') || hd.includes('w')) sz.w = 'fixed';
    if (hd.includes('n') || hd.includes('s')) sz.h = n.type === 'text' ? 'fixed' : 'fixed';
    n.sizing = sz;
    n.w = w;
    n.h = h;
    const flow = parentOf(d.id) && layoutOf(parentOf(d.id)) && !n.absolute;
    if (!flow) {
      n.x = Math.round((d.x + (x - d.r.x)) * 100) / 100;
      n.y = Math.round((d.y + (y - d.r.y)) * 100) / 100;
    }
    render();
  }

  /* ----- drawing ----- */

  function makeDrawn(d, r) {
    const parent = d.into ? node(d.into) : null;
    const pr = parent ? worldRect(parent.id) : { x: 0, y: 0 };
    const o = { x: Math.round(r.x - pr.x), y: Math.round(r.y - pr.y), w: Math.round(r.w), h: Math.round(r.h) };
    let n;
    if (d.type === 'text') n = makeNode('text', { x: o.x, y: o.y, text: '', name: 'Text', sizing: r.w > 4 ? { w: 'fixed', h: 'hug' } : { w: 'hug', h: 'hug' }, w: Math.max(o.w, 1) });
    else if (d.type === 'frame') n = makeNode('frame', { ...o, name: parent ? 'Frame' : 'Frame ' + (doc.nodes.filter((x) => x.type === 'frame').length + 1) });
    else n = makeNode(d.type, o);
    if (d.type === 'text') n.text = '';
    if (!d.made) checkpoint();
    if (d.made) detach(d.made);
    if (parent) parent.children.push(n);
    else doc.nodes.push(n);
    d.made = n.id;
    render();
    sel = [n.id];
    return n;
  }
  function drawTo(e, p) {
    const d = drag;
    if (!d.made && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 3) return;
    const w = toWorld(p.x, p.y);
    let rx = Math.min(d.origin.x, w.x);
    let ry = Math.min(d.origin.y, w.y);
    let rw = Math.abs(w.x - d.origin.x);
    let rh = Math.abs(w.y - d.origin.y);
    if (e.shiftKey) {
      const m = Math.max(rw, rh);
      rw = rh = m;
      rx = w.x < d.origin.x ? d.origin.x - m : d.origin.x;
      ry = w.y < d.origin.y ? d.origin.y - m : d.origin.y;
    }
    d.rect = { x: rx, y: ry, w: rw, h: rh };
    if (!d.made) makeDrawn(d, d.rect);
    else {
      const n = node(d.made);
      const parent = parentOf(d.made);
      const pr = parent ? worldRect(parent.id) : { x: 0, y: 0 };
      Object.assign(n, { x: Math.round(rx - pr.x), y: Math.round(ry - pr.y), w: Math.max(1, Math.round(rw)), h: Math.max(1, Math.round(rh)) });
      render();
    }
  }

  /* ---------------- markup: drawing on the design for Claude ---------------- */

  const toScreen = (pt) => [view.x + pt[0] * view.z, view.y + pt[1] * view.z];
  const isMarkTool = (t) => MARK_TOOLS.includes(t);
  /** A mark's box in canvas coordinates. */
  function markBox(m) {
    if (m.kind === 'note') return { x: m.pts[0][0], y: m.pts[0][1], w: m.w || 120, h: m.h || 24 };
    const xs = m.pts.map((p) => p[0]);
    const ys = m.pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function drawMarks() {
    const list = drag?.kind === 'mark' && drag.mark ? [...doc.marks, drag.mark] : doc.marks;
    marksEl.hidden = !marksShown || !list.length;
    if (marksEl.hidden) return (marksEl.innerHTML = '');
    const paths = [];
    const notes = [];
    for (const m of list) {
      const pts = m.pts.map(toScreen);
      const c = esc(m.color);
      let d = '';
      if (m.kind === 'pen') d = pts.length === 1 ? `M${pts[0]}l0 0` : 'M' + pts.join('L');
      else if (m.kind === 'line') d = `M${pts[0]}L${pts[1]}`;
      else if (m.kind === 'arrow') {
        const [[x0, y0], [x1, y1]] = pts;
        const a = Math.atan2(y1 - y0, x1 - x0);
        const len = Math.min(16, Math.hypot(x1 - x0, y1 - y0) * 0.6);
        const head = (s) => `${x1 - len * Math.cos(a + s)},${y1 - len * Math.sin(a + s)}`;
        d = `M${x0},${y0}L${x1},${y1}M${head(0.45)}L${x1},${y1}L${head(-0.45)}`;
      } else if (m.kind === 'box') {
        const [[x0, y0], [x1, y1]] = pts;
        paths.push(`<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" rx="6" class="halo"/><rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" rx="6" stroke="${c}"/>`);
      } else if (m.kind === 'note' && (!noteEdit || noteEdit.m !== m)) {
        notes.push(`<div class="dz-note" data-mark="${m.id}" style="left:${pts[0][0]}px;top:${pts[0][1]}px;--c:${c}">${esc(m.text)}</div>`);
      }
      if (d) paths.push(`<path d="${d}" class="halo"/><path d="${d}" stroke="${c}"/>`);
    }
    marksEl.innerHTML = `<svg width="100%" height="100%">${paths.join('')}</svg>${notes.join('')}`;
    // Notes are sized by the browser: remember how big they are (for hit testing and the hand-off).
    for (const el of marksEl.querySelectorAll('.dz-note')) {
      const m = list.find((x) => x.id === el.dataset.mark);
      if (m) Object.assign(m, { w: Math.round(el.offsetWidth / view.z), h: Math.round(el.offsetHeight / view.z) });
    }
    if (noteEdit) {
      const [x, y] = toScreen(noteEdit.m.pts[0]);
      Object.assign(noteEdit.input.style, { left: x + 'px', top: y + 'px' });
    }
  }

  /** The mark under a point on screen (the top-most), for the eraser and editing notes. */
  function markAt(p) {
    const segDist = (q, a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = dx || dy ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
      return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
    };
    const q = [p.x, p.y];
    for (let i = doc.marks.length - 1; i >= 0; i--) {
      const m = doc.marks[i];
      const pts = m.pts.map(toScreen);
      if (m.kind === 'note') {
        const b = markBox(m);
        if (p.x >= pts[0][0] && p.y >= pts[0][1] && p.x <= pts[0][0] + b.w * view.z && p.y <= pts[0][1] + b.h * view.z) return m;
        continue;
      }
      let segs = [];
      if (m.kind === 'box') {
        const [[x0, y0], [x1, y1]] = pts;
        segs = [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]];
      } else for (let j = 0; j < pts.length; j++) segs.push([pts[j], pts[j + 1] || pts[j]]);
      if (segs.some(([a, b]) => segDist(q, a, b) < 8)) return m;
    }
    return null;
  }

  /** Fewer points along a freehand stroke, the shape kept (Ramer–Douglas–Peucker). */
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    let far = 0;
    let at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
      if (d > far) (far = d), (at = i);
    }
    if (far <= eps) return [a, b];
    return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)];
  }

  const roundPt = (w) => [Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10];
  function startMark(e, p) {
    marksShown = true;
    if (tool === 'eraser') {
      drag = { kind: 'erase', erased: false };
      eraseAt(p);
      return capture(e);
    }
    if (tool === 'note') {
      const hit = markAt(p);
      if (hit?.kind === 'note') return editNote(hit, false);
      e.preventDefault();
      const m = { id: uid(), kind: 'note', pts: [roundPt(toWorld(p.x, p.y))], color: markColor, text: '' };
      return editNote(m, true);
    }
    const w = roundPt(toWorld(p.x, p.y));
    drag = { kind: 'mark', start: p, mark: { id: uid(), kind: tool, pts: tool === 'pen' ? [w] : [w, w], color: markColor } };
    capture(e);
    drawMarks();
  }
  function markTo(e, p) {
    const m = drag.mark;
    if (m.kind === 'pen') {
      const last = toScreen(m.pts[m.pts.length - 1]);
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= 2) m.pts.push(roundPt(toWorld(p.x, p.y)));
    } else {
      let q = { ...p };
      if (e.shiftKey) {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        if (m.kind === 'box') {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          q = { x: drag.start.x + Math.sign(dx || 1) * s, y: drag.start.y + Math.sign(dy || 1) * s };
        } else {
          // Lines snap to 45° steps.
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          q = { x: drag.start.x + Math.cos(a) * len, y: drag.start.y + Math.sin(a) * len };
        }
      }
      m.pts[1] = roundPt(toWorld(q.x, q.y));
    }
    drawMarks();
  }
  function finishMark(d, cancelled) {
    const m = d.mark;
    const [a, b] = [toScreen(m.pts[0]), toScreen(m.pts[m.pts.length - 1])];
    const tiny = m.kind === 'pen' ? m.pts.length < 2 && !d.moved : Math.hypot(b[0] - a[0], b[1] - a[1]) < 4;
    if (cancelled || tiny) return drawMarks();
    if (m.kind === 'pen') m.pts = simplify(m.pts, 0.75 / view.z);
    checkpoint();
    doc.marks.push(m);
    drawMarks();
    emit('change', { marks: true });
  }
  function eraseAt(p) {
    const m = markAt(p);
    if (!m) return;
    if (!drag?.erased) checkpoint();
    if (drag) drag.erased = true;
    doc.marks = doc.marks.filter((x) => x !== m);
    drawMarks();
    emit('change', { marks: true });
  }

  /** Type a note's text right on the canvas. Enter keeps it, Shift+Enter starts a new line, Esc cancels. */
  function editNote(m, fresh) {
    noteEdit?.input.blur();
    const input = document.createElement('textarea');
    input.className = 'dz-note-edit';
    input.rows = 1;
    input.value = m.text || '';
    input.placeholder = 'Tell Claude…';
    input.style.setProperty('--c', m.color);
    vp.append(input);
    noteEdit = { m, input, fresh };
    drawMarks();
    const fit = () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    };
    fit();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      noteEdit = null;
      input.remove();
      const text = input.value.trim();
      if (keep && text !== (m.text || '')) {
        checkpoint();
        if (!text) doc.marks = doc.marks.filter((x) => x !== m);
        else {
          m.text = text;
          if (fresh) doc.marks.push(m);
        }
        drawMarks();
        emit('change', { marks: true });
      } else drawMarks();
      vp.focus({ preventScroll: true });
    };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) e.preventDefault(), finish(true);
      if (e.key === 'Escape') e.preventDefault(), finish(false);
    });
    // After the press that made it, which would take the focus back to the canvas.
    setTimeout(() => {
      if (done) return;
      input.focus();
      input.addEventListener('blur', () => finish(true));
    });
  }

  /** Marks over a box in canvas coordinates (with `pad` around it), or every mark. */
  function marksIn(r = null, pad = 0) {
    if (!r) return doc.marks.slice();
    return doc.marks.filter((m) => {
      const b = markBox(m);
      return b.x <= r.x + r.w + pad && b.x + b.w >= r.x - pad && b.y <= r.y + r.h + pad && b.y + b.h >= r.y - pad;
    });
  }

  /* ----- Alt: distances between the selection and the layer under the pointer ----- */

  function measure() {
    const a = union(topSel().map(screenRect));
    const b = screenRect(hover);
    if (!a || !b) return;
    const lines = [];
    const z = view.z;
    const lab = (x, y, v) => `<div class="dz-measure-label" style="left:${x}px;top:${y}px">${fmt(v / z)}</div>`;
    const inside = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    const cy = a.y + a.h / 2;
    const cx = a.x + a.w / 2;
    if (inside) {
      [['x', b.x, a.x, cy], ['x', a.x + a.w, b.x + b.w, cy], ['y', b.y, a.y, cx], ['y', a.y + a.h, b.y + b.h, cx]].forEach(([ax, from, to, at]) => {
        if (to - from < 1) return;
        lines.push(ax === 'x' ? `<div class="dz-measure x" style="left:${from}px;top:${at}px;width:${to - from}px"></div>${lab((from + to) / 2, at + 4, to - from)}` : `<div class="dz-measure y" style="left:${at}px;top:${from}px;height:${to - from}px"></div>${lab(at + 4, (from + to) / 2, to - from)}`);
      });
    } else {
      if (b.x >= a.x + a.w) lines.push(`<div class="dz-measure x" style="left:${a.x + a.w}px;top:${cy}px;width:${b.x - a.x - a.w}px"></div>${lab((a.x + a.w + b.x) / 2, cy + 4, b.x - a.x - a.w)}`);
      if (a.x >= b.x + b.w) lines.push(`<div class="dz-measure x" style="left:${b.x + b.w}px;top:${cy}px;width:${a.x - b.x - b.w}px"></div>${lab((b.x + b.w + a.x) / 2, cy + 4, a.x - b.x - b.w)}`);
      if (b.y >= a.y + a.h) lines.push(`<div class="dz-measure y" style="left:${cx}px;top:${a.y + a.h}px;height:${b.y - a.y - a.h}px"></div>${lab(cx + 4, (a.y + a.h + b.y) / 2, b.y - a.y - a.h)}`);
      if (a.y >= b.y + b.h) lines.push(`<div class="dz-measure y" style="left:${cx}px;top:${b.y + b.h}px;height:${a.y - b.y - b.h}px"></div>${lab(cx + 4, (b.y + b.h + a.y) / 2, a.y - b.y - b.h)}`);
    }
    overlay.insertAdjacentHTML('beforeend', `<div class="dz-hover" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"></div>` + lines.join(''));
  }

  /* ---------------- wheel: pan and zoom ---------------- */

  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (Math.abs(e.deltaY) < 40 ? 4 : 1));
        zoomAt(view.z * factor, p.x, p.y);
      } else {
        const k = e.deltaMode === 1 ? 20 : 1;
        view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
        view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY * k;
        applyView();
        drawOverlay();
        emit('view', view);
      }
    },
    { passive: false },
  );

  /* ---------------- keyboard ---------------- */

  const TOOLS = { v: 'move', k: 'move', f: 'frame', a: 'frame', r: 'rect', o: 'ellipse', e: 'ellipse', t: 'text', h: 'hand', p: 'pen', l: 'line', b: 'box', n: 'note' };
  function setTool(t) {
    if (isMarkTool(t) && !marksShown) {
      marksShown = true;
      drawMarks();
      emit('marks', marksShown);
    }
    tool = t;
    vp.dataset.tool = t;
    emit('tool', t);
  }

  vp.addEventListener('keydown', (e) => {
    if (editing || e.target !== vp) return;
    const k = e.key;
    const lower = k.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const done = () => (e.preventDefault(), e.stopPropagation());
    if (k === ' ' && !space) {
      space = true;
      vp.classList.add('space');
      return done();
    }
    if (ctrl && lower === 'z') return done(), e.shiftKey ? redo() : undo();
    if (ctrl && lower === 'y') return done(), redo();
    if (ctrl && lower === 'a') return done(), ops.selectAll();
    if (ctrl && lower === 'd') return done(), ops.duplicate();
    if (ctrl && lower === 'g') return done(), e.shiftKey ? ops.ungroup() : ops.group({ auto: e.altKey });
    if (ctrl && lower === 'c') return done(), copy();
    if (ctrl && lower === 'x') return done(), copy().then(() => ops.delete());
    if (ctrl && lower === 'v' && !opts.nativePaste) return done(), emit('paste-request', { here: e.shiftKey });
    if (ctrl && e.shiftKey && lower === 'h') return done(), ops.toggle('hidden');
    if (ctrl && e.shiftKey && lower === 'l') return done(), ops.toggle('locked');
    if (ctrl && lower === 'r') return done(), emit('rename', sel[0]);
    if (ctrl && (k === ']' || k === '[')) return done(), ops.order((k === ']' ? 1 : -1) * (e.shiftKey ? Infinity : 1));
    if (ctrl && (k === '=' || k === '+')) return done(), zoomTo(view.z * 1.5);
    if (ctrl && k === '-') return done(), zoomTo(view.z / 1.5);
    if ((ctrl && k === '0') || (e.shiftKey && (k === ')' || e.code === 'Digit0'))) return done(), zoomTo(1);
    if (e.shiftKey && (k === '!' || e.code === 'Digit1')) return done(), fit();
    if (e.shiftKey && (k === '@' || e.code === 'Digit2')) return done(), fit(sel, { max: 8 });
    if (ctrl && ['b', 'i', 'u'].includes(lower)) return done(), emit('text-style', lower);
    if (k === 'Delete' || k === 'Backspace') return done(), ops.delete();
    if (k === 'Escape' && isMarkTool(tool) && !drag) return done(), setTool('move');
    if (k === 'Escape') return done(), drag ? null : sel.length ? (topSel().some((id) => parentOf(id)) ? ops.selectParent() : select([])) : setTool('move');
    if (k === 'Enter') return done(), e.shiftKey ? ops.selectParent() : ops.selectChildren();
    if (k === 'Tab') return done(), ops.selectSibling(e.shiftKey ? -1 : 1);
    if (k.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      done();
      return ops.nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
    }
    if (e.shiftKey && e.altKey && lower === 'a' && !ctrl) return done(), ops.freeLayout({ deep: true });
    if (e.shiftKey && lower === 'a' && !ctrl) return done(), ops.autoLayout();
    if (e.shiftKey && lower === 'l' && !ctrl && !e.altKey) return done(), setTool('arrow');
    if (e.altKey && !ctrl) {
      const al = { a: 'left', h: 'hcenter', w: 'top', v: 'vcenter', s: 'bottom' }[lower];
      if (al) return done(), ops.align(al);
    }
    if (!ctrl && !e.altKey && !e.shiftKey && TOOLS[lower]) return done(), setTool(TOOLS[lower]);
    if (!ctrl && !e.altKey && (k === '+' || k === '=')) return done(), zoomTo(view.z * 1.5);
    if (!ctrl && !e.altKey && k === '-') return done(), zoomTo(view.z / 1.5);
    if (!ctrl && lower === 'c') return done(), emit('capture');
  });
  vp.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      space = false;
      vp.classList.remove('space');
    }
    if (e.key === 'Alt') drawOverlay();
  });
  vp.addEventListener('focus', () => opts.onFocus?.(true));
  vp.addEventListener('blur', () => {
    space = false;
    vp.classList.remove('space');
    opts.onFocus?.(false);
  });

  /* ---------------- clipboard ---------------- */

  async function copy() {
    const ids = topSel();
    if (!ids.length) return;
    const nodes = ids.map((id) => {
      const n = structuredClone(node(id));
      const r = worldRect(id);
      if (parentOf(id)) Object.assign(n, { x: r.x, y: r.y, _abs: true });
      return n;
    });
    const used = assetsUsed(nodes);
    const assets = Object.fromEntries([...used].map((a) => [a, doc.assets[a]]).filter(([, v]) => v));
    const text = LAYERS_PREFIX + JSON.stringify({ nodes, assets, fonts: doc.fonts?.filter((f) => assets[f.asset]) || [] });
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
    emit('copied', ids.length);
  }

  /**
   * Paste whatever's on the clipboard: Designer layers, an element captured in another browser, an SVG, an image,
   * HTML, or plain text. `data`: { text, html, image } (the app reads the clipboard).
   */
  async function paste(data, { here = false, point = null } = {}) {
    const text = String(data.text || '');
    if (text.startsWith(LAYERS_PREFIX)) {
      const o = JSON.parse(text.slice(LAYERS_PREFIX.length));
      const map = {};
      for (const [aid, url] of Object.entries(o.assets || {})) map[aid] = addAsset(url);
      const fix = (s) => String(s || '').replace(/asset:([a-z0-9]+)/g, (_, a) => 'asset:' + (map[a] || a));
      const nodes = o.nodes.map((n) => {
        const c = cloneNode(n, { keepLinks: false });
        for (const { node: x } of walk([c])) {
          if (x.src) x.src = fix(x.src);
          x.fills?.forEach((f) => (f.src && (f.src = fix(f.src)), f.value && (f.value = fix(f.value))));
        }
        delete c._abs;
        return c;
      });
      for (const f of o.fonts || []) if (!doc.fonts.some((g) => g.family === f.family && g.weight === f.weight && g.style === f.style)) doc.fonts.push({ ...f, asset: map[f.asset] || f.asset });
      injectFonts();
      // Pasted where they were (offset if that's on top of the originals), or at the pointer.
      const copiedHere = o.nodes.some((n) => sel.includes(n.id));
      const into = here || copiedHere ? null : sel.length === 1 && node(sel[0])?.type === 'frame' ? sel[0] : null;
      const box = union(nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
      const occupied = doc.nodes.some((n) => Math.abs(n.x - box.x) < 1 && Math.abs(n.y - box.y) < 1);
      const at = into ? null : point || (occupied ? { x: box.x + 24, y: box.y + 24 } : { x: box.x, y: box.y });
      return insert(nodes, { into: into || null, at, keepPositions: !!into });
    }
    if (text.startsWith(CAPTURE_PREFIX)) return importCapture(JSON.parse(text.slice(CAPTURE_PREFIX.length)), { at: point });
    const svgText = /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text) ? text : null;
    if (svgText) return importSvg(svgText, { point });
    const html = String(data.html || '');
    const htmlIsJustImage = /^\s*(<meta[^>]*>)?\s*<img[^>]*>\s*$/i.test(html);
    if (data.image && (!html || htmlIsJustImage)) return importImage(data.image, { point, name: 'Pasted image' });
    if (html && /<[a-z]/i.test(html)) {
      const cap = await captureHtml(html);
      return importCapture(cap, { at: point, name: 'Pasted' });
    }
    if (/^\s*<[a-z!]/i.test(text)) {
      const cap = await captureHtml(text);
      return importCapture(cap, { at: point, name: 'Pasted HTML' });
    }
    if (text.trim()) {
      const t = makeNode('text', { text: text.slice(0, 5000), name: text.trim().slice(0, 40) });
      return insert([t], { at: point });
    }
    return [];
  }

  async function importSvg(markup, { point = null, name = 'Vector' } = {}) {
    const s = svgSize(markup);
    if (!s) throw new Error('That isn’t an SVG');
    const scale = Math.min(1, 600 / Math.max(s.w, s.h));
    const n = makeNode('svg', { name, markup: s.markup, w: Math.round(s.w * scale), h: Math.round(s.h * scale), color: '#000000' });
    return insert([n], { at: point });
  }

  /** An image layer. `density`: the picture's pixels per CSS pixel (2 for a screenshot of a 2x screen). */
  async function importImage(dataUrl, { point = null, name = 'Image', into, density = 1 } = {}) {
    const { w, h } = await imageSize(dataUrl);
    const scale = Math.min(1 / density, 1400 / Math.max(w, 1));
    const aid = addAsset(dataUrl);
    const n = makeNode('image', { name, src: 'asset:' + aid, w: Math.round(w * scale), h: Math.round(h * scale), fit: 'fill' });
    return insert([n], { at: point, into });
  }

  /**
   * Bring in a captured element: its layers, the states it had on the page (hover, focus, pressed) as state frames,
   * its images and fonts as assets, and a screenshot of the original beside it for comparison.
   */
  function importCapture(cap, { at = null, name = '' } = {}) {
    if (!cap?.root) throw new Error('Nothing was captured');
    const resolved = cap.resolved?.images || {};
    const urlAsset = {};
    const asset = (u) => {
      if (!u) return '';
      if (u.startsWith('data:')) return 'asset:' + addAsset(u);
      if (resolved[u]) return 'asset:' + (urlAsset[u] ??= addAsset(resolved[u]));
      return u;
    };
    const root = fromCapture(cap, { asset });
    const states = statesFromCapture(cap, root, { asset });
    cleanPaths(root);
    let host = '';
    try {
      host = cap.url && /^https?:/.test(cap.url) ? new URL(cap.url).hostname.replace(/^www\./, '') : '';
    } catch {}
    if (name) root.name = name;
    states.forEach((s) => (s.name = `${root.name} / ${s.variant.state[0].toUpperCase() + s.variant.state.slice(1)}`));
    for (const f of cap.resolved?.fonts || []) {
      if (doc.fonts.some((g) => g.family === f.family && String(g.weight) === String(f.weight) && g.style === f.style)) continue;
      doc.fonts.push({ family: f.family, weight: f.weight, style: f.style, asset: addAsset(f.data) });
    }
    injectFonts();
    checkpoint();
    const spot = at || freeSpot(root.w + states.reduce((t, s) => t + s.w + 40, 0), root.h);
    root.x = Math.round(spot.x);
    root.y = Math.round(spot.y);
    let x = root.x + root.w + 40;
    for (const s of states) {
      s.x = x;
      s.y = root.y;
      x += s.w + 40;
    }
    const added = [root, ...states];
    doc.meta[root.id] = { ...(doc.meta[root.id] || {}), source: { url: cap.url || '', title: cap.title || '', html: cap.html || '', host } };
    if (cap.site) doc.meta[root.id].source.site = cap.site; // from the Site Editor: the project and element to send it back to
    // A transparent component (a ghost button on a dark page) sits on the background it had, behind it on the canvas.
    const ownFill = (root.fills || []).some((f) => f.visible !== false && (f.type !== 'solid' || parseColor(f.color).a > 0.5));
    if (cap.backdrop) doc.meta[root.id].source.backdrop = cap.backdrop;
    if (!ownFill && cap.backdrop) {
      const right = Math.max(...[root, ...states].map((n) => n.x + n.w));
      const bd = makeNode('rect', { name: `Backdrop${host ? ' · ' + host : ''}`, x: root.x - 24, y: root.y - 24, w: right - root.x + 48, h: root.h + 48, fills: [{ type: 'solid', color: cap.backdrop }], radius: 8, locked: true, ref: root.id });
      added.unshift(bd);
    }
    if (cap.shot) {
      const shotId = addAsset(cap.shot);
      doc.meta[root.id].source.shot = shotId;
      const ref = makeNode('image', { name: `Original${host ? ' · ' + host : ''}`, src: 'asset:' + shotId, x: root.x, y: root.y + root.h + 48, w: Math.round(cap.rect.w), h: Math.round(cap.rect.h), fit: 'fill', ref: root.id });
      added.push(ref);
    }
    doc.nodes.push(...added);
    commit({ select: [root.id] });
    requestAnimationFrame(() => fit(added.map((n) => n.id), { max: 1.5 }));
    emit('captured', { root, states, host });
    return added;
  }

  /* ---------------- loading ---------------- */

  function load(d) {
    doc = d;
    doc.nodes ||= [];
    doc.assets ||= {};
    doc.fonts ||= [];
    doc.meta ||= {};
    doc.marks ||= [];
    sel = [];
    past.length = future.length = 0;
    if (d.view) view = { ...d.view };
    injectFonts();
    render();
    if (!d.view) requestAnimationFrame(() => fit(null, { max: 1 }));
    emit('select', sel);
  }
  /** Replace the layers (Claude changed design.json), keeping Undo. */
  function replace(d) {
    checkpoint();
    Object.assign(doc, { nodes: d.nodes || [], meta: d.meta || {}, fonts: d.fonts || [], name: d.name || doc.name, marks: d.marks || [] });
    Object.assign(doc.assets, d.assets || {});
    injectFonts();
    sel = sel.filter((id) => indexTree(doc.nodes).has(id));
    render();
    emit('select', sel);
  }

  const ro = new ResizeObserver(() => drawOverlay());
  ro.observe(vp);

  return {
    get doc() {
      return doc;
    },
    get sel() {
      return sel;
    },
    get view() {
      return view;
    },
    get tool() {
      return tool;
    },
    get editing() {
      return editing;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    viewport: vp,
    on(ev, fn) {
      (listeners[ev] ||= new Set()).add(fn);
      return () => listeners[ev].delete(fn);
    },
    load,
    replace,
    render,
    commit,
    checkpoint,
    undo,
    redo,
    select,
    node,
    info,
    parentOf,
    topSel,
    screenRect,
    worldRect,
    setTool,
    setView,
    zoomTo,
    fit,
    startEdit,
    endEdit,
    insert,
    reparent,
    addAsset,
    injectFonts,
    importCapture,
    importImage,
    importSvg,
    paste,
    copy,
    ops,
    /** Show only one top-level frame (for a picture of it), or everything again (null). */
    solo(id) {
      for (const n of doc.nodes) {
        const el = els.get(n.id);
        if (el) el.style.visibility = id && n.id !== id ? 'hidden' : '';
      }
    },
    hoverLayer(id) {
      hover = id;
      drawOverlay();
    },
    frameAt,
    toWorld: (clientX, clientY) => {
      const v = vpRect();
      return toWorld(clientX - v.left, clientY - v.top);
    },
    marks: {
      get color() {
        return markColor;
      },
      set color(c) {
        markColor = c;
        emit('tool', tool);
      },
      get shown() {
        return marksShown;
      },
      set shown(v) {
        marksShown = !!v;
        if (!marksShown && isMarkTool(tool)) setTool('move');
        drawMarks();
        emit('marks', marksShown);
      },
      in: marksIn,
      box: markBox,
      clear() {
        if (!doc.marks.length) return;
        checkpoint();
        doc.marks = [];
        drawMarks();
        emit('change', { marks: true });
      },
    },
    drawOverlay,
    destroy() {
      noteEdit?.input.remove();
      ro.disconnect();
      document.fonts?.removeEventListener('loadingdone', onFonts);
    },
  };
}
