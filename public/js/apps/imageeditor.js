// Image Editor: quick edits to pictures on this computer (Linux and Leafdeck OS). One picture to a window, with layers,
// selections (rectangle, ellipse, lasso, magic wand), moving and scaling selected pixels, paint tools, text, crop and
// resize, and color adjustments, then Ctrl+S back to the file. PNG, JPEG and WebP save; everything else Leafdeck can draw
// opens and saves as one of those. Layers last until the window closes: a saved file is the picture flattened.
//
// How it's put together:
// - Each layer is a canvas the size of the picture, in main memory. `view` shows them composited, `over` draws what isn't
//   the picture (the selection's marching ants, handles, the brush circle) so those redraw without recompositing.
// - Painting goes through one path (strokeStart/Show/End): the tool draws on a scratch canvas, which is masked by the
//   selection and laid over a copy of the layer, so a stroke doesn't build up over itself and stays within the selection.
// - A selection is a mask canvas with its outline traced from it, and it's never changed once made, so history can hold it.
// - History is linear: a step keeps either the region of a layer that changed, or the layer list with its canvases.
//   Operations that change a layer's size or whole contents give it a new canvas, so the old one stays valid for undo.
// - Moving pixels lifts them into `float`, which sits just above the layer until it's dropped (by anything else you do).
import { esc, $, $$, clamp, el } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, showMenu, closeMenu, menuOwner, forgetOnNewBoot } from '../wm.js';
import { shell } from '../shell.js';
import { ask as askDialog } from '../dialogs.js';
import { pickFiles as pickFile } from '../filepicker.js';
import { pickColor } from '../colorpicker.js';
import { makeCanvas, ctxOf, copyRect, clone, rectFrom, intersect, union, flood, maskToCanvas, insideOf, boundsOf, selectionShape, traceOutline, opaqueBounds, filtered, sharpened } from '../imageeditor/pixels.js';

const supported = !!shell?.files && shell.platform === 'linux';
const DRAG_TYPE = 'application/x-leafdeck-files'; // files dragged from Files
const LAST = 'imageeditor:last'; // the picture to open again after restarting Leafdeck
forgetOnNewBoot(LAST);
const PREFS = 'imageeditor:prefs'; // tool settings and colors
const OPENS = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i; // what Leafdeck can draw
const FORMATS = {
  png: { mime: 'image/png', name: 'PNG image', globs: ['*.png'] },
  jpg: { mime: 'image/jpeg', name: 'JPEG image', globs: ['*.jpg', '*.jpeg'], lossy: true },
  webp: { mime: 'image/webp', name: 'WebP image', globs: ['*.webp'], lossy: true },
};
const MAX_SIDE = 16384;
const MAX_AREA = 120e6; // pixels: a layer takes four bytes for each, and history keeps copies
const MAX_HISTORY = 1024 ** 3; // bytes of undo history
const MAX_ANTS = 40000; // a selection's outline with more segments than this draws solid: dashes get too slow
const ZOOMS = [0.05, 0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const PALETTE = ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff', '#7f0000', '#ff0000', '#ff6a00', '#ffd800', '#b6ff00', '#00c853', '#00e5ff', '#0094ff', '#0026ff', '#6a00ff', '#ff00dc', '#ff7fb6', '#8d5524', '#ffe0bd', '#34c77b'];
const FONTS = ['Inter', 'sans-serif', 'serif', 'monospace', 'Noto Sans', 'Noto Serif', 'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

// [id, name, icon, key, the settings it shows, what the status bar says]
const TOOLS = [
  ['move', 'Move Pixels', 'ie-move', 'M', [], 'Drag the selection to move its pixels, or a handle to scale them (Shift keeps the shape). With nothing selected, this moves the whole layer.'],
  null,
  ['select', 'Rectangle Select', 'ie-sel-rect', 'S', ['mode'], 'Drag to select. Shift makes a square; Ctrl adds to the selection, Alt takes away.'],
  ['ellipse-select', 'Ellipse Select', 'ie-sel-ellipse', 'C', ['mode'], 'Drag to select. Shift makes a circle; Ctrl adds to the selection, Alt takes away.'],
  ['lasso', 'Lasso Select', 'ie-lasso', 'L', ['mode'], 'Draw around what you want. Ctrl adds to the selection, Alt takes away.'],
  ['wand', 'Magic Wand', 'ie-wand', 'W', ['mode', 'tolerance', 'contiguous'], 'Click a color to select it. Then Delete makes it transparent. Ctrl adds, Alt takes away.'],
  null,
  ['brush', 'Paintbrush', 'ie-brush', 'B', ['size', 'hardness', 'opacity'], 'Left button paints the primary color, right button the secondary. [ and ] change the size.'],
  ['pencil', 'Pencil', 'ie-pencil', 'P', ['size', 'opacity'], 'Paints hard-edged pixels. Left button is the primary color, right button the secondary.'],
  ['eraser', 'Eraser', 'ie-eraser', 'E', ['size', 'hardness', 'opacity'], 'Erases to transparent. [ and ] change the size.'],
  ['fill', 'Paint Bucket', 'ie-bucket', 'F', ['tolerance', 'contiguous', 'opacity'], 'Click to fill the area with the primary color, or right-click for the secondary.'],
  ['gradient', 'Gradient', 'ie-gradient', 'G', ['gradient', 'opacity'], 'Drag from where the gradient starts to where it ends. Shift keeps it straight.'],
  null,
  ['line', 'Line', 'ie-line', 'N', ['size', 'opacity'], 'Drag to draw a line. Shift snaps it to 45° steps.'],
  ['rect', 'Rectangle', 'ie-rect', 'R', ['shape', 'size', 'opacity'], 'Drag to draw. Shift makes a square.'],
  ['ellipse', 'Ellipse', 'ie-ellipse', 'O', ['shape', 'size', 'opacity'], 'Drag to draw. Shift makes a circle.'],
  ['text', 'Text', 'ie-text', 'T', ['font', 'fontSize', 'bold', 'italic', 'opacity'], 'Click and type. Ctrl+Enter or clicking away places the text; Esc cancels it.'],
  null,
  ['picker', 'Color Picker', 'eyedropper', 'K', [], 'Click to pick a color from the picture, or right-click for the secondary color.'],
  ['hand', 'Pan', 'ie-hand', 'H', [], 'Drag to move around. Holding Space does this with any tool.'],
];
const PAINTS = new Set(['brush', 'pencil', 'eraser', 'fill', 'gradient', 'line', 'rect', 'ellipse', 'text']);

const base = (p) => p.split('/').pop();
const folderOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const stem = (name) => name.replace(/\.[^.]+$/, '') || name;
const errText = (x) => String(x?.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const fileUrl = (p) => `/~file?p=${encodeURIComponent(p)}&v=${Date.now()}`; // never an earlier version of the file
const formatOf = (p) => {
  const m = /\.(png|jpe?g|webp)$/i.exec(p || '');
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null;
};
const fits = (w, h) => w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_AREA;
const TOO_BIG = `Pictures can be up to ${MAX_SIDE.toLocaleString()} pixels on a side and ${Math.round(MAX_AREA / 1e6)} megapixels.`;
const stored = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

function loadImage(p) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('It may be damaged, or no longer there.'));
    img.src = fileUrl(p);
  });
}

let pending = null; // the picture for a new window (openApp('imageeditor', { file }))

registerApp({
  id: 'imageeditor',
  name: 'Image Editor',
  icon: 'ie-brush',
  color: 'orange',
  size: [1180, 780],
  min: [720, 480],
  hidden: !supported,
  launch(opts) {
    pending = typeof opts?.file === 'string' ? opts.file : null;
  },
  openFile(win, file) {
    win.imageEditor?.open(String(file));
  },
  canClose(win) {
    return win.imageEditor ? win.imageEditor.confirmLeave() : true;
  },
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Image Editor runs on Leafdeck OS</div>
        <p>It edits pictures in this computer’s files, which needs Linux.</p></div>`;
      return;
    }
    mountEditor(win);
  },
});

function mountEditor(win) {
  win.body.innerHTML = `<div class="ie" tabindex="0">
      <div class="ie-menus">${['File', 'Edit', 'View', 'Image', 'Layers', 'Adjustments'].map((m) => `<button type="button" data-menu="${m}">${m}</button>`).join('')}<span class="grow"></span></div>
      <div class="ie-options"></div>
      <div class="ie-main">
        <div class="ie-tools">${TOOLS.map((t) => (t ? `<button type="button" class="ie-tool" data-tool="${t[0]}" title="${esc(t[1])} (${t[3]})" aria-label="${esc(t[1])}">${icon(t[2], 17)}</button>` : '<i></i>')).join('')}</div>
        <div class="ie-stage">
          <canvas class="ie-view"></canvas>
          <canvas class="ie-over"></canvas>
          <textarea class="ie-type" spellcheck="false" autocomplete="off" aria-label="Text" hidden></textarea>
          <div class="ie-start"><div class="empty"><div class="empty-title">No picture open</div>
            <p>Open a picture, drag one here from Files, or start from what’s on the clipboard.</p>
            <div class="ie-start-btns"><button type="button" class="btn primary" data-act="open">Open…</button><button type="button" class="btn" data-act="new">New…</button><button type="button" class="btn" data-act="paste-new">Paste</button></div></div></div>
          <form class="ie-adjust" hidden></form>
        </div>
        <aside class="ie-side">
          <div class="ie-colors">
            <div class="ie-wells" title="Primary and secondary color. X swaps them.">
              <button type="button" class="ie-well second" data-well="secondary" aria-label="Secondary color"></button>
              <button type="button" class="ie-well first" data-well="primary" aria-label="Primary color"></button>
              <button type="button" class="ie-swap" data-act="swap" title="Swap colors (X)" aria-label="Swap colors">${icon('ie-swap', 12)}</button>
            </div>
            <div class="ie-palette">${PALETTE.map((c) => `<button type="button" data-swatch="${c}" style="background:${c}" title="${c.toUpperCase()}" aria-label="${c}"></button>`).join('')}</div>
          </div>
          <div class="ie-side-head">Layers</div>
          <div class="ie-layers"></div>
          <label class="ie-layer-opacity"><span>Opacity</span><input type="range" min="0" max="100" data-layer-opacity><output></output></label>
          <div class="ie-layer-btns">
            <button type="button" class="tb-btn" data-act="layer-add" title="Add layer">${icon('plus', 15)}</button>
            <button type="button" class="tb-btn" data-act="layer-dup" title="Duplicate layer">${icon('copy', 15)}</button>
            <button type="button" class="tb-btn" data-act="layer-merge" title="Merge down">${icon('ie-merge', 15)}</button>
            <button type="button" class="tb-btn" data-act="layer-up" title="Move up">${icon('up', 15)}</button>
            <button type="button" class="tb-btn" data-act="layer-down" title="Move down">${icon('down', 15)}</button>
            <button type="button" class="tb-btn" data-act="layer-del" title="Delete layer">${icon('trash', 15)}</button>
          </div>
        </aside>
      </div>
      <div class="ie-status"><span class="ie-hint"></span><span class="grow"></span><span class="ie-st-sel"></span><span class="ie-st-pos"></span><span class="ie-st-size"></span>
        <button type="button" class="tb-btn" data-act="zoom-out" title="Zoom out (−)">${icon('ie-minus', 13)}</button><button type="button" class="ie-zoom" data-act="zoom-menu" title="Zoom"></button><button type="button" class="tb-btn" data-act="zoom-in" title="Zoom in (+)">${icon('plus', 13)}</button></div>
    </div>`;
  win.tools.innerHTML = `<button class="tb-btn" data-act="open" title="Open (Ctrl+O)">${icon('folder', 15)}</button>
    <button class="tb-btn" data-act="save" title="Save (Ctrl+S)">${icon('download', 15)}</button>
    <button class="tb-btn" data-act="undo" title="Undo (Ctrl+Z)">${icon('ie-undo', 15)}</button>
    <button class="tb-btn" data-act="redo" title="Redo (Ctrl+Y)">${icon('ie-redo', 15)}</button>`;

  const root = $('.ie', win.body);
  const stage = $('.ie-stage', root);
  const view = $('.ie-view', root);
  const over = $('.ie-over', root);
  const typeBox = $('.ie-type', root);
  const startEl = $('.ie-start', root);
  const adjustEl = $('.ie-adjust', root);
  const optionsEl = $('.ie-options', root);
  const layersEl = $('.ie-layers', root);
  const v = view.getContext('2d', { alpha: true, willReadFrequently: true });
  const o = over.getContext('2d');

  // The keyboard belongs to the picture: after a dialog, the file picker or a button in the title bar, it comes back here.
  const refocus = () => {
    if (typeBox.hidden) root.focus({ preventScroll: true });
  };
  const ask = (opts) => askDialog(opts).finally(refocus);
  const pickFiles = (opts) => pickFile(opts).finally(refocus);

  /* ---------------- state ---------------- */

  let doc = null; // { w, h, layers (bottom first), active, file, savedId }
  let sel = null; // the selection: { mask, path, segs, x, y, w, h }
  let float = null; // pixels being moved; see lift()
  let st = null; // the stroke being painted
  let drag = null; // what the pointer is doing: { move(p, e), up(p, e), cancel(), preview?() }
  let text = null; // text being typed: { x, y, color, alpha }
  let adjusting = null; // the adjustment panel's work
  let layerSeq = 0;
  let stepSeq = 0;
  const hist = { undo: [], redo: [], bytes: 0 };
  let tool = 'brush';
  let prevTool = null; // where the color picker goes back to
  let zoom = 1; // device pixels per picture pixel, so 100% is exact on any screen
  let ox = 0; // where the picture's corner is on the view, in device pixels
  let oy = 0;
  let fitted = true;
  let hover = null; // the pointer over the stage, in picture coordinates
  let spaceDown = false;
  let antsPhase = 0;
  let shadow = null; // the layer as it was when the stroke began
  let scratch = null; // what the stroke has drawn
  let masked = null; // the stroke, cut to the selection

  const prefs = {
    primary: '#000000', secondary: '#ffffff', size: 8, hardness: 100, opacity: 100, tolerance: 25, contiguous: true, mode: 'replace', shape: 'outline',
    gradient: 'colors', font: 'Inter', fontSize: 48, bold: false, italic: false, bg: 'white',
  };
  try {
    Object.assign(prefs, JSON.parse(stored(PREFS) || '{}'));
  } catch {}
  const savePrefs = () => store(PREFS, JSON.stringify(prefs));

  /* ---------------- drawing the screen ---------------- */

  let wantImage = false;
  let wantOver = false;
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (wantImage) drawImage();
      if (wantOver) drawOver();
      wantImage = wantOver = false;
    });
  }
  const redraw = () => {
    wantImage = wantOver = true;
    schedule();
  };
  const redrawOver = () => {
    wantOver = true;
    schedule();
  };

  const checker = (() => {
    const c = makeCanvas(16, 16);
    const x = ctxOf(c);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#d4d4d4';
    x.fillRect(0, 0, 8, 8);
    x.fillRect(8, 8, 8, 8);
    return v.createPattern(c, 'repeat');
  })();

  function drawImage() {
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.clearRect(0, 0, view.width, view.height);
    if (!doc) return;
    const box = intersect({ x: Math.round(ox), y: Math.round(oy), w: Math.round(doc.w * zoom), h: Math.round(doc.h * zoom) }, { x: 0, y: 0, w: view.width, h: view.height });
    if (!box) return;
    v.fillStyle = checker;
    v.fillRect(box.x, box.y, box.w, box.h);
    v.save();
    v.beginPath();
    v.rect(box.x, box.y, box.w, box.h);
    v.clip();
    v.setTransform(zoom, 0, 0, zoom, ox, oy);
    // Enlarged, you see the pixels; shrunk, they blend.
    v.imageSmoothingEnabled = zoom < 1;
    v.imageSmoothingQuality = 'medium';
    composite(v);
    v.restore();
  }

  /** The layers, bottom to top, onto a context already set up for picture coordinates. */
  function composite(c) {
    for (const l of doc.layers) {
      if (!l.visible) continue;
      c.globalAlpha = l.opacity;
      c.drawImage(l.canvas, 0, 0);
      if (float && float.layer === l) c.drawImage(float.canvas, float.x, float.y, float.w, float.h);
    }
    c.globalAlpha = 1;
  }

  const moving = () => tool === 'move' && !adjusting;
  /** What the Move tool's handles go around. */
  const moveBox = () => (float && !float.whole ? float : !float && sel && moving() ? sel : null);
  function handlePoints(b) {
    const x0 = ox + b.x * zoom;
    const y0 = oy + b.y * zoom;
    const x1 = x0 + b.w * zoom;
    const y1 = y0 + b.h * zoom;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    return { nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my] };
  }

  function ants(path, segs) {
    o.setTransform(zoom, 0, 0, zoom, ox, oy);
    o.lineWidth = 1 / zoom;
    o.setLineDash([]);
    o.lineDashOffset = 0;
    o.strokeStyle = '#ffffff';
    o.stroke(path);
    o.strokeStyle = '#000000';
    if (segs < MAX_ANTS) {
      o.setLineDash([4 / zoom, 4 / zoom]);
      o.lineDashOffset = -antsPhase / zoom;
    }
    o.stroke(path);
    o.setLineDash([]);
    o.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawOver() {
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, over.width, over.height);
    if (!doc) return;
    o.lineWidth = 1;
    o.strokeStyle = 'rgba(128, 128, 128, 0.7)';
    o.strokeRect(Math.round(ox) - 0.5, Math.round(oy) - 0.5, Math.round(doc.w * zoom) + 1, Math.round(doc.h * zoom) + 1);

    if (float) {
      const m = new DOMMatrix().translate(float.x, float.y).scale(float.w / float.w0, float.h / float.h0).translate(-float.x0, -float.y0);
      const p = new Path2D();
      p.addPath(float.path, m);
      ants(p, float.segs);
    } else if (sel) ants(sel.path, sel.segs);
    drag?.preview?.();

    const b = moveBox();
    if (b) {
      const pts = handlePoints(b);
      o.fillStyle = '#ffffff';
      o.strokeStyle = '#1a6fd6';
      o.lineWidth = 1.5 * (devicePixelRatio || 1);
      const s = 4 * (devicePixelRatio || 1);
      for (const h of HANDLES) {
        o.beginPath();
        o.rect(pts[h][0] - s, pts[h][1] - s, s * 2, s * 2);
        o.fill();
        o.stroke();
      }
    }

    if (text) drawTextOn(o, true);

    if (hover && !adjusting && ['brush', 'eraser', 'pencil'].includes(tool) && !spaceDown) {
      const r = (prefs.size * zoom) / 2;
      const cx = ox + hover.x * zoom;
      const cy = oy + hover.y * zoom;
      const outline = () => {
        o.beginPath();
        if (tool === 'pencil') {
          const s = prefs.size;
          const px = Math.floor(hover.x) - Math.floor(s / 2);
          const py = Math.floor(hover.y) - Math.floor(s / 2);
          o.rect(ox + px * zoom, oy + py * zoom, s * zoom, s * zoom);
        } else o.arc(cx, cy, Math.max(r, 1), 0, Math.PI * 2);
      };
      o.lineWidth = 3;
      o.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      outline();
      o.stroke();
      o.lineWidth = 1;
      o.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      outline();
      o.stroke();
    }
  }

  // The ants march only while there's a selection to show; the interval does nothing otherwise.
  const antsTimer = setInterval(() => {
    if (document.hidden || !stage.clientWidth) return;
    const segs = float ? float.segs : sel ? sel.segs : Infinity;
    if (segs >= MAX_ANTS) return;
    antsPhase = (antsPhase + 1) % 8;
    redrawOver();
  }, 120);
  win.cleanups.push(() => clearInterval(antsTimer));

  /* ---------------- view ---------------- */

  function clampPan() {
    if (!doc) return;
    const m = 48; // this much of the picture always stays in view
    ox = clamp(ox, m - doc.w * zoom, view.width - m);
    oy = clamp(oy, m - doc.h * zoom, view.height - m);
  }
  function fit() {
    if (!doc) return;
    const m = 24 * (devicePixelRatio || 1);
    zoom = Math.min(1, (view.width - m * 2) / doc.w, (view.height - m * 2) / doc.h);
    zoom = Math.max(zoom, 0.01);
    ox = Math.round((view.width - doc.w * zoom) / 2);
    oy = Math.round((view.height - doc.h * zoom) / 2);
    fitted = true;
    viewChanged();
  }
  /** Zoom keeping the point (cx, cy) of the view where it is; by default, the middle. */
  function zoomTo(z, cx = view.width / 2, cy = view.height / 2) {
    if (!doc) return;
    z = clamp(z, 0.01, 64);
    const k = z / zoom;
    ox = cx - (cx - ox) * k;
    oy = cy - (cy - oy) * k;
    zoom = z;
    fitted = false;
    if (zoom >= 1) {
      ox = Math.round(ox);
      oy = Math.round(oy);
    }
    clampPan();
    viewChanged();
  }
  function zoomStep(dir) {
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom * 1.001) : [...ZOOMS].reverse().find((z) => z < zoom * 0.999);
    if (next) zoomTo(next);
  }
  function panBy(dx, dy) {
    ox += dx;
    oy += dy;
    fitted = false;
    clampPan();
    viewChanged();
  }
  function viewChanged() {
    placeTypeBox();
    drawStatus();
    redraw();
  }
  const ro = new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(stage.clientWidth * dpr));
    const h = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (view.width === w && view.height === h) return;
    view.width = over.width = w;
    view.height = over.height = h;
    if (fitted) fit();
    else {
      clampPan();
      viewChanged();
    }
    wantImage = wantOver = false;
    drawImage(); // now, not next frame: resizing a canvas blanks it
    drawOver();
  });
  ro.observe(stage);
  win.cleanups.push(() => ro.disconnect());

  /** Where a pointer event is on the picture, and on the view. */
  function locate(e) {
    const r = over.getBoundingClientRect();
    const k = r.width ? over.width / r.width : 1;
    const vx = (e.clientX - r.left) * k;
    const vy = (e.clientY - r.top) * k;
    return { x: (vx - ox) / zoom, y: (vy - oy) / zoom, vx, vy };
  }

  /* ---------------- history ---------------- */

  function pushStep(step) {
    step.id = ++stepSeq;
    hist.undo.push(step);
    hist.bytes += step.bytes;
    for (const s of hist.redo) hist.bytes -= s.bytes;
    hist.redo.length = 0;
    while (hist.bytes > MAX_HISTORY && hist.undo.length > 1) hist.bytes -= hist.undo.shift().bytes;
    changed();
  }
  const resetHistory = () => {
    hist.undo.length = hist.redo.length = 0;
    hist.bytes = 0;
  };
  const putRegion = (layer, r, region) => {
    const c = ctxOf(layer.canvas);
    c.clearRect(r.x, r.y, r.w, r.h);
    c.drawImage(region, r.x, r.y);
  };
  /** A step for pixels that changed within `r` of a layer. */
  function pixelStep(label, layer, r, before, after, selA = sel, selB = sel) {
    return {
      label,
      bytes: r.w * r.h * 8,
      undo() {
        putRegion(layer, r, before);
        sel = selA;
      },
      redo() {
        putRegion(layer, r, after);
        sel = selB;
      },
    };
  }
  const capture = () => ({
    w: doc.w,
    h: doc.h,
    active: doc.active,
    sel,
    layers: doc.layers.map((l) => ({ l, canvas: l.canvas, visible: l.visible, opacity: l.opacity, name: l.name })),
  });
  function restore(s) {
    const resized = s.w !== doc.w || s.h !== doc.h;
    doc.w = s.w;
    doc.h = s.h;
    doc.layers = s.layers.map((x) => Object.assign(x.l, { canvas: x.canvas, visible: x.visible, opacity: x.opacity, name: x.name }));
    doc.active = s.active;
    sel = s.sel;
    if (resized) sizeChanged();
  }
  /** Run a change to the layer list or the picture's size as one step. Canvases it replaces stay as they were. */
  function record(label, fn) {
    commitPending();
    const a = capture();
    fn();
    pushCaptured(label, a);
  }
  function pushCaptured(label, a) {
    const b = capture();
    const had = new Set(a.layers.map((x) => x.canvas));
    let bytes = 1024;
    for (const x of b.layers) if (!had.has(x.canvas)) bytes += x.canvas.width * x.canvas.height * 4;
    pushStep({ label, bytes, undo: () => restore(a), redo: () => restore(b) });
  }
  function sizeChanged() {
    shadow = scratch = masked = null;
    fit();
  }
  function undo() {
    if (adjusting) return closeAdjust(false);
    if (text) return cancelText();
    if (float) return cancelFloat();
    const s = hist.undo.pop();
    if (!s) return;
    s.undo();
    hist.redo.push(s);
    changed();
  }
  function redo() {
    if (adjusting || text || float) return;
    const s = hist.redo.pop();
    if (!s) return;
    s.redo();
    hist.undo.push(s);
    changed();
  }
  /** The last step that changed the picture: selecting doesn't, so it doesn't ask you to save. */
  const lastChange = () => hist.undo.findLast((s) => !s.selectionOnly)?.id ?? 0;
  const dirty = () => !!doc && (!!float || lastChange() !== doc.savedId);

  /** After anything that changes the picture: the panels, the title and the screen catch up. */
  function changed() {
    drawLayers();
    drawTitle();
    drawStatus();
    redraw();
  }

  /** Whatever's in progress becomes part of the picture, so another operation can start. */
  function commitPending() {
    if (adjusting) closeAdjust(true);
    if (text) commitText();
    if (float) dropFloat();
  }

  /* ---------------- layers ---------------- */

  function newLayer(name, canvas) {
    return { id: ++layerSeq, name, canvas: canvas || makeCanvas(doc.w, doc.h), visible: true, opacity: 1 };
  }
  const nextLayerName = () => `Layer ${doc.layers.length + 1}`;
  function addLayer() {
    record('Add Layer', () => {
      const l = newLayer(nextLayerName());
      doc.layers.splice(doc.layers.indexOf(doc.active) + 1, 0, l);
      doc.active = l;
    });
  }
  function duplicateLayer() {
    record('Duplicate Layer', () => {
      const a = doc.active;
      const l = newLayer(`${a.name} copy`, clone(a.canvas));
      l.opacity = a.opacity;
      doc.layers.splice(doc.layers.indexOf(a) + 1, 0, l);
      doc.active = l;
    });
  }
  function deleteLayer() {
    if (doc.layers.length < 2) return toast('A picture needs at least one layer', 'error');
    record('Delete Layer', () => {
      const i = doc.layers.indexOf(doc.active);
      doc.layers.splice(i, 1);
      doc.active = doc.layers[Math.max(0, i - 1)];
    });
  }
  function moveLayer(d) {
    const i = doc.layers.indexOf(doc.active);
    if (i + d < 0 || i + d >= doc.layers.length) return;
    record(d > 0 ? 'Move Layer Up' : 'Move Layer Down', () => {
      const [l] = doc.layers.splice(i, 1);
      doc.layers.splice(i + d, 0, l);
    });
  }
  function mergeDown() {
    const i = doc.layers.indexOf(doc.active);
    if (i < 1) return;
    record('Merge Down', () => {
      const top = doc.active;
      const under = doc.layers[i - 1];
      const out = makeCanvas(doc.w, doc.h);
      const c = ctxOf(out);
      c.globalAlpha = under.opacity;
      c.drawImage(under.canvas, 0, 0);
      c.globalAlpha = top.opacity;
      c.drawImage(top.canvas, 0, 0);
      under.canvas = out;
      under.opacity = 1;
      doc.layers.splice(i, 1);
      doc.active = under;
    });
  }
  /** Everything visible, as one canvas. `bg`: a color behind it. */
  function flattened(bg) {
    const out = makeCanvas(doc.w, doc.h);
    const c = ctxOf(out);
    if (bg) {
      c.fillStyle = bg;
      c.fillRect(0, 0, doc.w, doc.h);
    }
    composite(c);
    return out;
  }
  function flatten() {
    if (doc.layers.length < 2) return;
    record('Flatten', () => {
      const l = newLayer('Background', flattened());
      doc.layers = [l];
      doc.active = l;
    });
  }
  async function renameLayer(l) {
    const r = await ask({ win, title: 'Rename layer', fields: [{ name: 'name', label: 'Name', value: l.name }] });
    const name = r?.values.name.trim();
    if (!name || name === l.name) return;
    record('Rename Layer', () => (l.name = name));
  }

  /* ---------------- selection ---------------- */

  function selectionFrom(mask) {
    const { inside, box } = selectionShape(mask);
    if (!box) return null;
    return { mask, ...box, ...traceOutline(inside, doc.w, doc.h) };
  }
  function setSelection(next, label) {
    const a = sel;
    if (a === next) return;
    sel = next;
    pushStep({ label, selectionOnly: true, bytes: (next ? doc.w * doc.h * 4 : 0) + 1024, undo: () => (sel = a), redo: () => (sel = next) });
  }
  const selectMode = (e) => (e?.ctrlKey || e?.metaKey ? 'add' : e?.altKey ? 'subtract' : prefs.mode);
  /** Combine a new shape (a mask canvas) with the selection, as the mode says. */
  function applyShape(shape, mode, label) {
    let mask = shape;
    if (sel && mode !== 'replace') {
      mask = clone(sel.mask);
      const c = ctxOf(mask);
      c.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
      c.drawImage(shape, 0, 0);
    } else if (mode === 'subtract' || mode === 'intersect') return;
    setSelection(selectionFrom(mask), label);
  }
  function selectAll() {
    commitPending();
    const mask = makeCanvas(doc.w, doc.h);
    const c = ctxOf(mask);
    c.fillRect(0, 0, doc.w, doc.h);
    setSelection(selectionFrom(mask), 'Select All');
  }
  function deselect() {
    commitPending();
    setSelection(null, 'Deselect');
  }
  function invertSelection() {
    commitPending();
    const mask = makeCanvas(doc.w, doc.h);
    const c = ctxOf(mask);
    c.fillRect(0, 0, doc.w, doc.h);
    if (sel) {
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(sel.mask, 0, 0);
    }
    setSelection(selectionFrom(mask), 'Invert Selection');
  }

  /* ---------------- painting ---------------- */

  function strokeStart(label, { erase = false, alpha = prefs.opacity / 100 } = {}) {
    commitPending();
    if (!doc.active.visible) {
      toast('This layer is hidden', 'error');
      return false;
    }
    if (!shadow) {
      shadow = makeCanvas(doc.w, doc.h);
      scratch = makeCanvas(doc.w, doc.h);
      masked = makeCanvas(doc.w, doc.h);
    }
    const s = ctxOf(shadow);
    s.clearRect(0, 0, doc.w, doc.h);
    s.drawImage(doc.active.canvas, 0, 0);
    ctxOf(scratch).clearRect(0, 0, doc.w, doc.h);
    st = { label, layer: doc.active, erase, alpha, dirty: null };
    return true;
  }
  const docRect = () => ({ x: 0, y: 0, w: doc.w, h: doc.h });
  /** Lay what's been drawn on the scratch canvas over the layer, within `r`. */
  function strokeShow(r) {
    r = intersect({ x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.w) + 1, h: Math.ceil(r.h) + 1 }, docRect());
    if (!r) return;
    st.dirty = union(st.dirty, r);
    const c = ctxOf(st.layer.canvas);
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.clearRect(r.x, r.y, r.w, r.h);
    c.drawImage(shadow, 0, 0);
    let src = scratch;
    if (sel) {
      const m = ctxOf(masked);
      m.save();
      m.beginPath();
      m.rect(r.x, r.y, r.w, r.h);
      m.clip();
      m.clearRect(r.x, r.y, r.w, r.h);
      m.drawImage(scratch, 0, 0);
      m.globalCompositeOperation = 'destination-in';
      m.drawImage(sel.mask, 0, 0);
      m.restore();
      src = masked;
    }
    c.globalAlpha = st.alpha;
    c.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    c.drawImage(src, 0, 0);
    c.restore();
    wantImage = true;
    schedule();
  }
  function strokeEnd() {
    const s = st;
    st = null;
    if (!s?.dirty) return;
    const r = s.dirty;
    pushStep(pixelStep(s.label, s.layer, r, copyRect(shadow, r.x, r.y, r.w, r.h), copyRect(s.layer.canvas, r.x, r.y, r.w, r.h)));
  }
  function strokeCancel() {
    const s = st;
    st = null;
    if (!s?.dirty) return;
    const r = s.dirty;
    putRegion(s.layer, r, copyRect(shadow, r.x, r.y, r.w, r.h));
    redraw();
  }

  const colorFor = (e) => (e.button === 2 ? prefs.secondary : prefs.primary);

  // A soft brush tip for the current size, hardness and color.
  let tipKey = '';
  let tipCanvas = null;
  function softTip(color) {
    const key = `${prefs.size}|${prefs.hardness}|${color}`;
    if (key === tipKey) return tipCanvas;
    const s = Math.max(2, Math.ceil(prefs.size));
    const c = makeCanvas(s, s);
    const x = ctxOf(c);
    const g = x.createRadialGradient(s / 2, s / 2, (s / 2) * (prefs.hardness / 100), s / 2, s / 2, s / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, `${color}00`);
    x.fillStyle = g;
    x.fillRect(0, 0, s, s);
    tipKey = key;
    tipCanvas = c;
    return c;
  }

  function brushDrag(p, e, label, erase) {
    if (!strokeStart(label, { erase })) return null;
    const color = erase ? '#000000' : colorFor(e);
    const size = prefs.size;
    const hard = prefs.hardness >= 100;
    const c = ctxOf(scratch);
    const tip = hard ? null : softTip(color);
    let last = p;
    let carry = 0;
    const dab = (a, b) => {
      const pad = size / 2 + 2;
      if (hard) {
        c.strokeStyle = c.fillStyle = color;
        c.lineWidth = size;
        c.lineCap = c.lineJoin = 'round';
        if (a === b) {
          c.beginPath();
          c.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
          c.fill();
        } else {
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
      } else {
        const gap = Math.max(1, size / 8);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        let t = a === b ? 0 : gap - carry;
        for (; t <= len; t += gap) {
          const f = len ? t / len : 0;
          c.drawImage(tip, a.x + (b.x - a.x) * f - tip.width / 2, a.y + (b.y - a.y) * f - tip.height / 2);
        }
        carry = a === b ? 0 : (carry + len) % gap;
      }
      const r = rectFrom(a.x, a.y, b.x, b.y);
      strokeShow({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
    };
    dab(p, p);
    return {
      move(q) {
        dab(last, q);
        last = q;
      },
      up: strokeEnd,
      cancel: strokeCancel,
    };
  }

  function pencilDrag(p, e) {
    if (!strokeStart('Pencil')) return null;
    const c = ctxOf(scratch);
    c.fillStyle = colorFor(e);
    const s = prefs.size;
    const shift = Math.floor(s / 2);
    let lx = Math.floor(p.x);
    let ly = Math.floor(p.y);
    const line = (x1, y1) => {
      // Bresenham, so diagonal lines are one pixel wide with no gaps.
      let x = lx;
      let y = ly;
      const dx = Math.abs(x1 - x);
      const dy = -Math.abs(y1 - y);
      const sx = x < x1 ? 1 : -1;
      const sy = y < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        c.fillRect(x - shift, y - shift, s, s);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y += sy;
        }
      }
      const r = rectFrom(lx, ly, x1, y1);
      strokeShow({ x: r.x - s, y: r.y - s, w: r.w + s * 2, h: r.h + s * 2 });
      lx = x1;
      ly = y1;
    };
    line(lx, ly);
    return { move: (q) => line(Math.floor(q.x), Math.floor(q.y)), up: strokeEnd, cancel: strokeCancel };
  }

  /** A shape or gradient, redrawn from scratch as the pointer moves. draw(ctx, from, to, event) returns what it covered. */
  function shapeDrag(p, label, draw) {
    if (!strokeStart(label)) return null;
    const c = ctxOf(scratch);
    let prev = null;
    return {
      move(q, e) {
        if (prev) c.clearRect(prev.x - 1, prev.y - 1, prev.w + 2, prev.h + 2);
        c.save();
        const r = draw(c, p, q, e);
        c.restore();
        strokeShow(union(prev, r));
        prev = r;
      },
      up: strokeEnd,
      cancel: strokeCancel,
    };
  }
  /** The other corner of a drag; Shift makes it square. */
  function corner(p, q, e) {
    if (!e.shiftKey) return q;
    const d = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y));
    return { x: p.x + Math.sign(q.x - p.x || 1) * d, y: p.y + Math.sign(q.y - p.y || 1) * d };
  }
  const snapped = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  function shapeTool(p, e, kind) {
    const main = colorFor(e);
    const other = e.button === 2 ? prefs.primary : prefs.secondary;
    const size = prefs.size;
    const start = snapped(p);
    return shapeDrag(p, kind === 'rect' ? 'Rectangle' : 'Ellipse', (c, _from, q, ev) => {
      const to = snapped(corner(start, q, ev));
      const r = rectFrom(start.x, start.y, to.x, to.y);
      const off = prefs.shape !== 'fill' && size % 2 ? 0.5 : 0; // an odd outline stays on whole pixels
      c.beginPath();
      if (kind === 'rect') c.rect(r.x + off, r.y + off, r.w, r.h);
      else c.ellipse(r.x + r.w / 2 + off, r.y + r.h / 2 + off, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      c.lineWidth = size;
      c.lineJoin = 'miter';
      if (prefs.shape === 'fill') {
        c.fillStyle = main;
        c.fill();
      } else {
        if (prefs.shape === 'both') {
          c.fillStyle = other;
          c.fill();
        }
        c.strokeStyle = main;
        c.stroke();
      }
      const pad = prefs.shape === 'fill' ? 2 : size / 2 + 3;
      return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    });
  }
  function lineTool(p, e) {
    const color = colorFor(e);
    const size = prefs.size;
    return shapeDrag(p, 'Line', (c, from, q, ev) => {
      let to = q;
      if (ev.shiftKey) {
        const a = Math.round(Math.atan2(q.y - from.y, q.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
        const d = Math.hypot(q.x - from.x, q.y - from.y);
        to = { x: from.x + Math.cos(a) * d, y: from.y + Math.sin(a) * d };
      }
      c.strokeStyle = color;
      c.lineWidth = size;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(from.x, from.y);
      c.lineTo(to.x, to.y);
      c.stroke();
      const r = rectFrom(from.x, from.y, to.x, to.y);
      const pad = size / 2 + 3;
      return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    });
  }
  function gradientTool(p, e) {
    const a = colorFor(e);
    const b = prefs.gradient === 'fade' ? `${a}00` : e.button === 2 ? prefs.primary : prefs.secondary;
    const area = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : docRect();
    return shapeDrag(p, 'Gradient', (c, from, q, ev) => {
      let to = q;
      if (ev.shiftKey) {
        const ang = Math.round(Math.atan2(q.y - from.y, q.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
        const d = Math.hypot(q.x - from.x, q.y - from.y);
        to = { x: from.x + Math.cos(ang) * d, y: from.y + Math.sin(ang) * d };
      }
      if (from.x === to.x && from.y === to.y) return area;
      const g = c.createLinearGradient(from.x, from.y, to.x, to.y);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      c.clearRect(area.x, area.y, area.w, area.h);
      c.fillStyle = g;
      c.fillRect(area.x, area.y, area.w, area.h);
      return area;
    });
  }
  function fillTool(p, e) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
    const color = colorFor(e);
    if (!strokeStart('Fill')) return;
    const img = ctxOf(doc.active.canvas).getImageData(0, 0, doc.w, doc.h);
    const area = flood(img, x, y, prefs.tolerance, prefs.contiguous, sel ? insideOf(sel.mask) : null);
    const r = boundsOf(area, doc.w, doc.h);
    if (!r) {
      st = null;
      return;
    }
    const c = ctxOf(scratch);
    c.drawImage(maskToCanvas(area, doc.w, doc.h), 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = color;
    c.fillRect(r.x, r.y, r.w, r.h);
    c.globalCompositeOperation = 'source-over';
    strokeShow(r);
    strokeEnd();
  }
  function pickAt(p, e) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
    const c = makeCanvas(1, 1);
    const cx = ctxOf(c);
    cx.translate(-x, -y);
    composite(cx);
    const d = cx.getImageData(0, 0, 1, 1).data;
    if (!d[3]) return;
    setColor(e.button === 2 ? 'secondary' : 'primary', `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`);
  }

  /* ---------------- moving pixels ---------------- */

  /**
   * Lift the selected pixels (or with `whole`, the whole layer) off the layer. float: { layer, canvas, x, y, w, h (now),
   * x0, y0, w0, h0 (as lifted), path, segs (its outline, where it was lifted from), maskPiece, lift: { r, before }, selBefore }
   */
  function lift(whole = false) {
    const l = doc.active;
    if (!l.visible) {
      toast('This layer is hidden', 'error');
      return false;
    }
    const r = whole ? docRect() : intersect({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, docRect());
    const before = copyRect(l.canvas, r.x, r.y, r.w, r.h);
    const piece = clone(before);
    const c = ctxOf(l.canvas);
    let maskPiece;
    if (whole) {
      maskPiece = makeCanvas(r.w, r.h);
      ctxOf(maskPiece).fillRect(0, 0, r.w, r.h);
      c.clearRect(r.x, r.y, r.w, r.h);
    } else {
      maskPiece = copyRect(sel.mask, r.x, r.y, r.w, r.h);
      const pc = ctxOf(piece);
      pc.globalCompositeOperation = 'destination-in';
      pc.drawImage(maskPiece, 0, 0);
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(sel.mask, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
    const outline = whole ? new Path2D() : sel.path;
    if (whole) outline.rect(r.x, r.y, r.w, r.h);
    float = { layer: l, canvas: piece, x: r.x, y: r.y, w: r.w, h: r.h, x0: r.x, y0: r.y, w0: r.w, h0: r.h, path: outline, segs: whole ? 4 : sel.segs, maskPiece, lift: { r, before }, selBefore: sel, whole, label: whole ? 'Move Layer' : 'Move Pixels' };
    redraw();
    return true;
  }
  /** Put the pixels down where they are, as one step. */
  function dropFloat() {
    const f = float;
    float = null;
    const unmoved = f.lift && f.x === f.x0 && f.y === f.y0 && f.w === f.w0 && f.h === f.h0;
    if (unmoved && !f.cleared) {
      putRegion(f.layer, f.lift.r, f.lift.before);
      sel = f.selBefore;
      return changed();
    }
    const c = ctxOf(f.layer.canvas);
    const now = { x: f.x, y: f.y, w: f.w, h: f.h };
    const r = intersect(union(f.lift?.r, now), docRect());
    if (!r) {
      sel = f.selBefore;
      return changed();
    }
    // What this region was before the pixels were lifted.
    const before = copyRect(f.layer.canvas, r.x, r.y, r.w, r.h);
    if (f.lift) {
      const b = ctxOf(before);
      b.clearRect(f.lift.r.x - r.x, f.lift.r.y - r.y, f.lift.r.w, f.lift.r.h);
      b.drawImage(f.lift.before, f.lift.r.x - r.x, f.lift.r.y - r.y);
    }
    c.imageSmoothingQuality = 'high';
    c.imageSmoothingEnabled = f.w !== f.w0 || f.h !== f.h0;
    c.drawImage(f.canvas, f.x, f.y, f.w, f.h);
    c.imageSmoothingEnabled = true;
    const after = copyRect(f.layer.canvas, r.x, r.y, r.w, r.h);
    let selAfter = null;
    if (!f.whole) {
      const mask = makeCanvas(doc.w, doc.h);
      ctxOf(mask).drawImage(f.maskPiece, f.x, f.y, f.w, f.h);
      selAfter = selectionFrom(mask);
    } else selAfter = f.selBefore;
    sel = selAfter;
    pushStep(pixelStep(f.label, f.layer, r, before, after, f.selBefore, selAfter));
  }
  function cancelFloat() {
    const f = float;
    float = null;
    if (f.lift) putRegion(f.layer, f.lift.r, f.lift.before);
    sel = f.selBefore;
    changed();
  }

  function moveDrag(p, e) {
    const b = moveBox();
    if (b) {
      const pts = handlePoints(b);
      const near = 10 * (devicePixelRatio || 1);
      const h = HANDLES.find((n) => Math.hypot(pts[n][0] - p.vx, pts[n][1] - p.vy) <= near);
      if (h) return scaleDrag(p, h);
    }
    const inside = b && p.x >= b.x && p.y >= b.y && p.x < b.x + b.w && p.y < b.y + b.h;
    if (float && !inside) {
      dropFloat();
      return null;
    }
    if (!float) {
      if (sel && !inside) return null;
      if (!lift(!sel)) return null;
    }
    const f = float;
    const from = { x: f.x, y: f.y };
    return {
      move(q) {
        f.x = Math.round(from.x + q.x - p.x);
        f.y = Math.round(from.y + q.y - p.y);
        drawStatus();
        redraw();
      },
      up() {
        if (f.whole && float === f) dropFloat();
      },
      cancel: () => float === f && cancelFloat(),
    };
  }
  function scaleDrag(p, h) {
    if (!float && !lift()) return null;
    const f = float;
    const a = { x: f.x, y: f.y, w: f.w, h: f.h };
    const ratio = a.w / a.h;
    return {
      move(q, e) {
        let x0 = a.x;
        let y0 = a.y;
        let x1 = a.x + a.w;
        let y1 = a.y + a.h;
        if (h.includes('w')) x0 = Math.min(Math.round(q.x), x1 - 1);
        if (h.includes('e')) x1 = Math.max(Math.round(q.x), x0 + 1);
        if (h.includes('n')) y0 = Math.min(Math.round(q.y), y1 - 1);
        if (h.includes('s')) y1 = Math.max(Math.round(q.y), y0 + 1);
        if (e.shiftKey && h.length === 2) {
          const k = Math.max((x1 - x0) / a.w, (y1 - y0) / a.h);
          const w = Math.max(1, Math.round(a.h * k * ratio));
          const hh = Math.max(1, Math.round(a.h * k));
          if (h.includes('w')) x0 = x1 - w;
          else x1 = x0 + w;
          if (h.includes('n')) y0 = y1 - hh;
          else y1 = y0 + hh;
        }
        f.x = x0;
        f.y = y0;
        f.w = x1 - x0;
        f.h = y1 - y0;
        drawStatus();
        redraw();
      },
      up() {},
      cancel: () => float === f && cancelFloat(),
    };
  }
  function nudge(dx, dy) {
    if (!float) {
      if (!sel || !lift()) return;
    }
    float.x += dx;
    float.y += dy;
    drawStatus();
    redraw();
  }

  /* ---------------- selecting ---------------- */

  function shapeSelectDrag(p, e, ellipse) {
    commitPending();
    const start = { x: Math.round(p.x), y: Math.round(p.y) };
    const mode = selectMode(e);
    let box = null;
    const shapePath = (r) => {
      const path = new Path2D();
      if (ellipse) path.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else path.rect(r.x, r.y, r.w, r.h);
      return path;
    };
    return {
      move(q, ev) {
        const to = snapped(corner(start, q, ev));
        box = intersect(rectFrom(start.x, start.y, to.x, to.y), docRect());
        drawStatus(box);
        redrawOver();
      },
      up() {
        drawStatus();
        const r = box;
        box = null;
        if (!r) return mode === 'replace' && sel ? setSelection(null, 'Deselect') : redrawOver();
        const mask = makeCanvas(doc.w, doc.h);
        ctxOf(mask).fill(shapePath(r));
        applyShape(mask, mode, ellipse ? 'Ellipse Select' : 'Rectangle Select');
      },
      cancel: () => {
        box = null;
        drawStatus();
        redrawOver();
      },
      preview() {
        if (box) ants(shapePath(box), 4);
      },
    };
  }
  function lassoDrag(p, e) {
    commitPending();
    const mode = selectMode(e);
    const path = new Path2D();
    path.moveTo(p.x, p.y);
    let n = 0;
    return {
      move(q) {
        path.lineTo(q.x, q.y);
        n++;
        redrawOver();
      },
      up() {
        if (n < 2) return mode === 'replace' && sel ? setSelection(null, 'Deselect') : redrawOver();
        path.closePath();
        const mask = makeCanvas(doc.w, doc.h);
        ctxOf(mask).fill(path);
        applyShape(mask, mode, 'Lasso Select');
      },
      cancel: redrawOver,
      preview() {
        ants(path, 4);
      },
    };
  }
  function wandClick(p, e) {
    commitPending();
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
    const img = ctxOf(doc.active.canvas).getImageData(0, 0, doc.w, doc.h);
    const area = flood(img, x, y, prefs.tolerance, prefs.contiguous);
    applyShape(maskToCanvas(area, doc.w, doc.h), selectMode(e), 'Magic Wand');
  }

  /* ---------------- text ---------------- */

  const fontString = (px) => `${prefs.italic ? 'italic ' : ''}${prefs.bold ? 'bold ' : ''}${px}px "${prefs.font}", sans-serif`.replace('"sans-serif"', 'sans-serif').replace('"serif"', 'serif').replace('"monospace"', 'monospace');
  const lineStep = () => prefs.fontSize * 1.2;
  function drawTextOn(c, onView) {
    const lines = typeBox.value.split('\n');
    c.save();
    if (onView) c.setTransform(zoom, 0, 0, zoom, ox, oy);
    c.font = fontString(prefs.fontSize);
    c.fillStyle = text.color;
    c.textBaseline = 'top';
    c.globalAlpha = onView ? prefs.opacity / 100 : 1;
    lines.forEach((line, i) => c.fillText(line, text.x, text.y + i * lineStep()));
    c.restore();
  }
  function placeTypeBox() {
    if (!text) return;
    const r = over.getBoundingClientRect();
    const k = r.width ? r.width / over.width : 1;
    const scale = zoom * k;
    const c = ctxOf(makeScratchText());
    c.font = fontString(prefs.fontSize);
    const lines = typeBox.value.split('\n');
    const wide = Math.max(prefs.fontSize, ...lines.map((l) => c.measureText(l).width));
    Object.assign(typeBox.style, {
      left: `${(ox + text.x * zoom) * k}px`,
      top: `${(oy + text.y * zoom) * k}px`,
      width: `${(wide + prefs.fontSize) * scale}px`,
      height: `${lines.length * lineStep() * scale}px`,
      font: fontString(prefs.fontSize * scale),
      lineHeight: `${lineStep() * scale}px`,
      caretColor: text.color,
    });
  }
  let textMeasure = null;
  const makeScratchText = () => (textMeasure ||= makeCanvas(1, 1));
  function startText(p, e) {
    if (!doc.active.visible) return toast('This layer is hidden', 'error');
    text = { x: Math.round(p.x), y: Math.round(p.y), color: colorFor(e) };
    typeBox.value = '';
    typeBox.hidden = false;
    placeTypeBox();
    typeBox.focus();
    redrawOver();
  }
  function endText() {
    text = null;
    typeBox.hidden = true;
    typeBox.value = '';
    root.focus({ preventScroll: true });
    redrawOver();
  }
  function commitText() {
    const t = text;
    if (!typeBox.value.trim()) return endText();
    const value = typeBox.value;
    const alpha = prefs.opacity / 100;
    text = null; // strokeStart commits whatever's pending
    if (strokeStart('Text', { alpha })) {
      text = t;
      const c = ctxOf(scratch);
      drawTextOn(c, false);
      const m = ctxOf(makeScratchText());
      m.font = fontString(prefs.fontSize);
      const lines = value.split('\n');
      const wide = Math.max(...lines.map((l) => m.measureText(l).width));
      const pad = prefs.fontSize; // room for what leans past the measured box
      strokeShow({ x: t.x - pad, y: t.y - pad, w: wide + pad * 2, h: lines.length * lineStep() + pad * 2 });
      strokeEnd();
    }
    endText();
  }
  const cancelText = endText;

  /* ---------------- adjustments ---------------- */

  /**
   * Show a panel of sliders over the stage, with the result live on the layer. sliders: [{ name, label, min, max, value,
   * unit }]; render(source canvas, values) returns the adjusted canvas.
   */
  function openAdjust(title, sliders, render) {
    commitPending();
    if (!doc.active.visible) return toast('This layer is hidden', 'error');
    const r = sel ? intersect({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, docRect()) : docRect();
    const before = copyRect(doc.active.canvas, r.x, r.y, r.w, r.h);
    const layer = doc.active;
    const values = Object.fromEntries(sliders.map((s) => [s.name, s.value]));
    adjustEl.innerHTML = `<h3>${esc(title)}</h3>
      ${sliders.map((s) => `<label><span>${esc(s.label)}</span><input type="range" name="${s.name}" min="${s.min}" max="${s.max}" step="${s.step || 1}" value="${s.value}"><output>${s.value}${s.unit || ''}</output></label>`).join('')}
      <div class="ie-adjust-btns"><button type="button" class="btn small" data-adjust="cancel">Cancel</button><button type="submit" class="btn small primary">Apply</button></div>`;
    adjustEl.hidden = false;
    let queued = false;
    const apply = () => {
      queued = false;
      if (!adjusting) return;
      showResult(layer, r, before, render(before, values));
      wantImage = true;
      schedule();
    };
    adjusting = { layer, r, before, title };
    adjustEl.oninput = (e) => {
      const s = sliders.find((x) => x.name === e.target.name);
      if (!s) return;
      values[s.name] = Number(e.target.value);
      e.target.nextElementSibling.textContent = `${e.target.value}${s.unit || ''}`;
      if (!queued) {
        queued = true;
        requestAnimationFrame(apply);
      }
    };
    adjustEl.onsubmit = (e) => {
      e.preventDefault();
      closeAdjust(true);
    };
    apply();
    redrawOver();
  }
  /** The layer within `r`: `before`, with `result` showing through the selection. */
  function showResult(layer, r, before, result) {
    const c = ctxOf(layer.canvas);
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.clearRect(r.x, r.y, r.w, r.h);
    if (sel) {
      c.drawImage(before, r.x, r.y);
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(sel.mask, 0, 0);
      c.globalCompositeOperation = 'source-over';
      const cut = clone(result);
      const x = ctxOf(cut);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(sel.mask, -r.x, -r.y);
      c.drawImage(cut, r.x, r.y);
    } else c.drawImage(result, r.x, r.y);
    c.restore();
  }
  function closeAdjust(keep) {
    const a = adjusting;
    adjusting = null;
    adjustEl.hidden = true;
    adjustEl.innerHTML = '';
    if (keep) pushStep(pixelStep(a.title, a.layer, a.r, a.before, copyRect(a.layer.canvas, a.r.x, a.r.y, a.r.w, a.r.h)));
    else {
      putRegion(a.layer, a.r, a.before);
      redraw();
    }
    root.focus({ preventScroll: true });
  }
  /** An adjustment with nothing to set. */
  function applyFilter(label, filter) {
    commitPending();
    if (!doc.active.visible) return toast('This layer is hidden', 'error');
    const r = sel ? intersect({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, docRect()) : docRect();
    const before = copyRect(doc.active.canvas, r.x, r.y, r.w, r.h);
    showResult(doc.active, r, before, filtered(before, filter));
    pushStep(pixelStep(label, doc.active, r, before, copyRect(doc.active.canvas, r.x, r.y, r.w, r.h)));
  }
  const adjustments = {
    brightness: () =>
      openAdjust('Brightness / Contrast', [{ name: 'b', label: 'Brightness', min: -100, max: 100, value: 0 }, { name: 'c', label: 'Contrast', min: -100, max: 100, value: 0 }], (src, { b, c }) => filtered(src, `brightness(${1 + b / 100}) contrast(${1 + c / 100})`)),
    hue: () =>
      openAdjust('Hue / Saturation', [{ name: 'h', label: 'Hue', min: -180, max: 180, value: 0, unit: '°' }, { name: 's', label: 'Saturation', min: 0, max: 200, value: 100, unit: '%' }], (src, { h, s }) => filtered(src, `hue-rotate(${h}deg) saturate(${s}%)`)),
    blur: () =>
      openAdjust('Blur', [{ name: 'r', label: 'Radius', min: 0, max: 50, step: 0.5, value: 2, unit: ' px' }], (src, { r }) => (r ? filtered(src, `blur(${r}px)`, Math.ceil(r * 3)) : src)),
    sharpen: () =>
      openAdjust('Sharpen', [{ name: 'a', label: 'Amount', min: 0, max: 300, value: 60, unit: '%' }, { name: 'r', label: 'Radius', min: 0.5, max: 10, step: 0.5, value: 1, unit: ' px' }], (src, { a, r }) => (a ? sharpened(src, a / 100, r) : src)),
  };

  /* ---------------- the whole picture ---------------- */

  /** Give every layer a new canvas: the old one's pixels, drawn by `draw(ctx, layerCanvas)`. */
  function remake(w, h, draw) {
    for (const l of doc.layers) {
      const out = makeCanvas(w, h);
      draw(ctxOf(out), l.canvas);
      l.canvas = out;
    }
    const resized = w !== doc.w || h !== doc.h;
    doc.w = w;
    doc.h = h;
    sel = null;
    if (resized) sizeChanged();
  }
  function cropTo(r, mask, label) {
    record(label, () => {
      remake(r.w, r.h, (c, src) => {
        c.drawImage(src, -r.x, -r.y);
        if (mask) {
          c.globalCompositeOperation = 'destination-in';
          c.drawImage(mask, -r.x, -r.y);
        }
      });
    });
  }
  function cropToSelection() {
    if (float) dropFloat();
    if (!sel) return toast('Select the part to keep first', 'error');
    cropTo({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, sel.mask, 'Crop');
  }
  function trim() {
    commitPending();
    const r = opaqueBounds(flattened());
    if (!r) return toast('The picture is completely transparent', 'error');
    if (r.w === doc.w && r.h === doc.h) return toast('No transparent edges to trim');
    cropTo(r, null, 'Trim');
  }
  function turn(deg) {
    const swap = deg !== 180;
    const w = swap ? doc.h : doc.w;
    const h = swap ? doc.w : doc.h;
    record(deg === 180 ? 'Rotate 180°' : deg === 90 ? 'Rotate Right' : 'Rotate Left', () => {
      remake(w, h, (c, src) => {
        c.translate(w / 2, h / 2);
        c.rotate((deg * Math.PI) / 180);
        c.drawImage(src, -src.width / 2, -src.height / 2);
      });
    });
  }
  function flip(horizontal) {
    record(horizontal ? 'Flip Horizontal' : 'Flip Vertical', () => {
      remake(doc.w, doc.h, (c, src) => {
        c.translate(horizontal ? doc.w : 0, horizontal ? 0 : doc.h);
        c.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
        c.drawImage(src, 0, 0);
      });
    });
  }
  function flipLayer(horizontal) {
    record(horizontal ? 'Flip Layer Horizontal' : 'Flip Layer Vertical', () => {
      const l = doc.active;
      const out = makeCanvas(doc.w, doc.h);
      const c = ctxOf(out);
      c.translate(horizontal ? doc.w : 0, horizontal ? 0 : doc.h);
      c.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
      c.drawImage(l.canvas, 0, 0);
      l.canvas = out;
    });
  }

  /** The width and height fields of a dialog, tied together while the box is ticked. */
  function linkSize(form, ratio) {
    const wIn = form.elements.w;
    const hIn = form.elements.h;
    const keep = form.elements.keep;
    wIn.addEventListener('input', () => {
      if (keep?.checked && Number(wIn.value) > 0) hIn.value = Math.max(1, Math.round(Number(wIn.value) / ratio));
    });
    hIn.addEventListener('input', () => {
      if (keep?.checked && Number(hIn.value) > 0) wIn.value = Math.max(1, Math.round(Number(hIn.value) * ratio));
    });
  }
  const sizeCheck = (r, api) => {
    const w = Number(r.values.w);
    const h = Number(r.values.h);
    if (!Number.isInteger(w) || !Number.isInteger(h) || !fits(w, h)) {
      api.setError(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? TOO_BIG : 'Enter a whole number of pixels for each.');
      return false;
    }
    return true;
  };
  async function resizeDialog() {
    commitPending();
    let smooth = true;
    const body = el(`<div class="ie-dlg"><label class="ie-check"><input type="checkbox" name="keep" checked> Keep the proportions</label>
      <label class="field"><span>Resampling</span><select name="how"><option value="smooth">Smooth (photos)</option><option value="pixels">Nearest pixel (pixel art)</option></select></label></div>`);
    const r = await ask({
      win,
      title: 'Resize image',
      fields: [{ name: 'w', label: 'Width (pixels)', type: 'number', value: doc.w }, { name: 'h', label: 'Height (pixels)', type: 'number', value: doc.h }],
      body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Resize', value: 'ok', primary: true }],
      onMount: (api) => linkSize(api.el, doc.w / doc.h),
      check: (res, api) => {
        smooth = $('[name="how"]', body).value === 'smooth';
        return sizeCheck(res, api);
      },
    });
    if (!r) return;
    const w = Number(r.values.w);
    const h = Number(r.values.h);
    if (w === doc.w && h === doc.h) return;
    record('Resize', () => {
      remake(w, h, (c, src) => {
        c.imageSmoothingEnabled = smooth;
        c.imageSmoothingQuality = 'high';
        c.drawImage(src, 0, 0, w, h);
      });
    });
  }
  function canvasResize(w, h, ax, ay) {
    const dx = Math.round((w - doc.w) * ax);
    const dy = Math.round((h - doc.h) * ay);
    record('Canvas Size', () => remake(w, h, (c, src) => c.drawImage(src, dx, dy)));
  }
  async function canvasDialog() {
    commitPending();
    let ax = 0.5;
    let ay = 0.5;
    const body = el(`<div class="ie-dlg"><div class="ie-dlg-label">Keep the picture at</div>
      <div class="ie-anchor">${[0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => `<button type="button" data-x="${x}" data-y="${y}" class="${x === 0.5 && y === 0.5 ? 'on' : ''}" aria-label="Anchor"></button>`)).join('')}</div></div>`);
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      ax = Number(b.dataset.x);
      ay = Number(b.dataset.y);
      $$('[data-x]', body).forEach((x) => x.classList.toggle('on', x === b));
    });
    const r = await ask({
      win,
      title: 'Canvas size',
      message: 'Changes the picture’s edges without scaling it. New area is transparent.',
      fields: [{ name: 'w', label: 'Width (pixels)', type: 'number', value: doc.w }, { name: 'h', label: 'Height (pixels)', type: 'number', value: doc.h }],
      body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Resize', value: 'ok', primary: true }],
      check: sizeCheck,
    });
    if (!r) return;
    const w = Number(r.values.w);
    const h = Number(r.values.h);
    if (w !== doc.w || h !== doc.h) canvasResize(w, h, ax, ay);
  }

  /* ---------------- clipboard ---------------- */

  /** What's selected on the active layer (or all of it), or with `merged`, of everything visible. */
  function selectedCanvas(merged) {
    const src = merged ? flattened() : doc.active.canvas;
    if (!sel) return clone(src);
    const out = copyRect(src, sel.x, sel.y, sel.w, sel.h);
    const c = ctxOf(out);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(sel.mask, -sel.x, -sel.y);
    return out;
  }
  async function copyImage(merged = false) {
    commitPending();
    try {
      const c = selectedCanvas(merged);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      toast('Couldn’t copy this', 'error');
      return false;
    }
  }
  /** Erase what's selected (or, with nothing selected, the whole layer). */
  function clearSelected(label = 'Erase Selection') {
    if (float) {
      ctxOf(float.canvas).clearRect(0, 0, float.w0, float.h0);
      float.cleared = true;
      float.label = 'Erase Selection';
      return dropFloat();
    }
    commitPending();
    if (!doc.active.visible) return toast('This layer is hidden', 'error');
    const r = sel ? intersect({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }, docRect()) : docRect();
    const before = copyRect(doc.active.canvas, r.x, r.y, r.w, r.h);
    const c = ctxOf(doc.active.canvas);
    if (sel) {
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(sel.mask, 0, 0);
      c.globalCompositeOperation = 'source-over';
    } else c.clearRect(r.x, r.y, r.w, r.h);
    pushStep(pixelStep(label, doc.active, r, before, copyRect(doc.active.canvas, r.x, r.y, r.w, r.h)));
  }
  function fillSelected() {
    if (!strokeStart('Fill Selection')) return;
    const c = ctxOf(scratch);
    c.fillStyle = prefs.primary;
    c.fillRect(0, 0, doc.w, doc.h);
    strokeShow(sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : docRect());
    strokeEnd();
  }
  async function clipboardImage() {
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch {
      toast('Couldn’t read the clipboard', 'error');
      return null;
    }
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      try {
        return await createImageBitmap(await it.getType(type));
      } catch {}
    }
    toast('There’s no picture on the clipboard');
    return null;
  }
  async function paste() {
    const img = await clipboardImage();
    if (!img) return;
    if (!doc) {
      if (!(await startFromImage(img, 'Untitled'))) return;
      return;
    }
    placeImage(img, 'Paste');
  }
  async function pasteAsNew() {
    if (doc && !(await confirmLeave())) return;
    const img = await clipboardImage();
    if (img) startFromImage(img, 'Untitled');
  }
  function startFromImage(img, name, file = null) {
    const w = img.naturalWidth || img.width || 1024;
    const h = img.naturalHeight || img.height || 1024;
    if (!fits(w, h)) {
      toast(TOO_BIG, 'error');
      return false;
    }
    const c = makeCanvas(w, h);
    ctxOf(c).drawImage(img, 0, 0, w, h);
    startDoc(w, h, c, name, file);
    return true;
  }
  /** Put a picture on the active layer as pixels you can drag and scale before they're set down. */
  async function placeImage(img, label) {
    commitPending();
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w > doc.w || h > doc.h) {
      const r = await ask({
        win,
        title: 'This is larger than the canvas',
        message: `It’s ${w} × ${h} pixels and the canvas is ${doc.w} × ${doc.h}.`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Keep Canvas Size', value: 'keep' }, { label: 'Expand Canvas', value: 'expand', primary: true }],
      });
      if (!r) return;
      if (r.button === 'expand') {
        const nw = Math.max(w, doc.w);
        const nh = Math.max(h, doc.h);
        if (!fits(nw, nh)) return toast(TOO_BIG, 'error');
        canvasResize(nw, nh, 0, 0);
      }
    }
    setTool('move');
    if (!doc.active.visible) return toast('This layer is hidden', 'error');
    const piece = makeCanvas(w, h);
    ctxOf(piece).drawImage(img, 0, 0, w, h);
    const maskPiece = makeCanvas(w, h);
    ctxOf(maskPiece).fillRect(0, 0, w, h);
    // In the middle of what you're looking at, and on the canvas if it fits.
    const cx = (view.width / 2 - ox) / zoom;
    const cy = (view.height / 2 - oy) / zoom;
    const x = Math.round(clamp(cx - w / 2, Math.min(0, doc.w - w), Math.max(0, doc.w - w)));
    const y = Math.round(clamp(cy - h / 2, Math.min(0, doc.h - h), Math.max(0, doc.h - h)));
    const outline = new Path2D();
    outline.rect(x, y, w, h);
    float = { layer: doc.active, canvas: piece, x, y, w, h, x0: x, y0: y, w0: w, h0: h, path: outline, segs: 4, maskPiece, lift: null, selBefore: sel, whole: false, label };
    changed();
  }

  /* ---------------- files ---------------- */

  function startDoc(w, h, firstCanvas, name, file) {
    doc = { w, h, layers: [], active: null, file, name, savedId: 0 };
    const l = newLayer('Background', firstCanvas);
    doc.layers = [l];
    doc.active = l;
    sel = null;
    float = null;
    st = null;
    shadow = scratch = masked = null;
    resetHistory();
    doc.savedId = stepSeq = 0;
    startEl.hidden = true;
    store(LAST, file);
    fit();
    changed();
    root.focus({ preventScroll: true });
  }

  /** Unsaved changes: save them, throw them away, or stay. Resolves true when it's fine to move on. */
  async function confirmLeave() {
    if (text || adjusting) commitPending();
    if (!dirty()) return true;
    const r = await ask({
      win,
      title: `Save changes to ${doc.name}?`,
      message: 'Your changes are lost if you don’t save them.',
      buttons: [
        { label: 'Don’t Save', value: 'discard', danger: true },
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', primary: true },
      ],
    });
    if (r?.button === 'save') return save();
    return r?.button === 'discard';
  }

  async function open(p, { quiet = false } = {}) {
    if (!p) return;
    if (!(await confirmLeave())) return;
    let img;
    try {
      img = await loadImage(p);
    } catch (x) {
      if (quiet) store(LAST, null);
      else toast(`Couldn’t open ${base(p)}: ${errText(x)}`, 'error');
      return;
    }
    startFromImage(img, base(p), p);
  }
  async function chooseFile() {
    const r = await pickFiles({
      mode: 'open',
      title: 'Open',
      folder: doc?.file ? folderOf(doc.file) : undefined,
      filters: [{ name: 'Pictures', globs: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.bmp', '*.svg', '*.ico'] }, { name: 'All files', globs: ['*'] }],
    });
    if (r?.paths?.[0]) open(r.paths[0]);
  }
  async function addLayerFromFile(p) {
    if (!p) {
      const r = await pickFiles({ mode: 'open', title: 'Add as a layer', folder: doc.file ? folderOf(doc.file) : undefined, filters: [{ name: 'Pictures', globs: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.bmp', '*.svg', '*.ico'] }] });
      p = r?.paths?.[0];
      if (!p) return;
    }
    let img;
    try {
      img = await loadImage(p);
    } catch (x) {
      return toast(`Couldn’t open ${base(p)}: ${errText(x)}`, 'error');
    }
    record('Add Layer', () => {
      const l = newLayer(stem(base(p)));
      doc.layers.splice(doc.layers.indexOf(doc.active) + 1, 0, l);
      doc.active = l;
    });
    placeImage(img, 'Place Picture');
  }

  async function encode(format, quality) {
    const canvas = flattened(FORMATS[format].lossy && format === 'jpg' ? '#ffffff' : null); // JPEG has no transparency
    const blob = await new Promise((r) => canvas.toBlob(r, FORMATS[format].mime, quality));
    if (!blob) throw new Error('The picture is too large to save in this format.');
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function writeOut(path, quality) {
    const format = formatOf(path);
    try {
      await shell.files.writeBytes(path, await encode(format, quality));
    } catch (x) {
      toast(`Couldn’t save ${base(path)}: ${errText(x)}`, 'error');
      return false;
    }
    doc.file = path;
    doc.name = base(path);
    doc.quality = quality;
    doc.savedId = lastChange();
    store(LAST, path);
    if (doc.layers.length > 1) toast(`Saved. Layers are merged in ${doc.name}, and stay separate only until you close this window.`);
    drawTitle();
    return true;
  }
  async function save() {
    if (!doc) return false;
    commitPending();
    // A format we can't write, or never saved: ask where to.
    if (!doc.file || !formatOf(doc.file)) return saveAs();
    return writeOut(doc.file, doc.quality ?? 0.92);
  }
  async function saveAs() {
    if (!doc) return false;
    commitPending();
    const current = formatOf(doc.file) || 'png';
    const order = [current, ...Object.keys(FORMATS).filter((f) => f !== current)];
    const r = await pickFiles({
      mode: 'save',
      title: 'Save as',
      name: `${stem(doc.name)}.${current}`,
      folder: doc.file ? folderOf(doc.file) : undefined,
      filters: order.map((f) => ({ name: FORMATS[f].name, globs: FORMATS[f].globs })),
      currentFilter: FORMATS[current].name,
    });
    let path = r?.paths?.[0];
    if (!path) return false;
    // A name with no picture extension gets the one for the format chosen. (The picker asked about replacing the name as
    // typed, so this one's asked here.)
    if (!formatOf(path)) {
      const f = order.find((k) => FORMATS[k].name === r.filter) || current;
      path = `${path}.${f}`;
      const list = await shell.files.list(folderOf(path)).catch(() => null);
      if (list?.entries.some((e) => e.path === path)) {
        const yes = await ask({ win, title: `“${base(path)}” already exists. Replace it?`, buttons: [{ label: 'Cancel', value: null }, { label: 'Replace', value: 'ok', primary: true, danger: true }] });
        if (!yes) return false;
      }
    }
    let quality = doc.quality ?? 0.92;
    if (FORMATS[formatOf(path)].lossy) {
      quality = await askQuality(formatOf(path), quality);
      if (quality == null) return false;
    }
    return writeOut(path, quality);
  }
  /** The quality of a JPEG or WebP, with what that makes the file's size. Resolves null if you cancel. */
  async function askQuality(format, start) {
    const body = el(`<div class="ie-dlg"><label class="ie-quality"><input type="range" name="q" min="10" max="100" value="${Math.round(start * 100)}"><output></output></label><p class="ie-dlg-label ie-size-note"></p></div>`);
    const range = $('[name="q"]', body);
    const out = $('output', body);
    const note = $('.ie-size-note', body);
    let seq = 0;
    const measure = async () => {
      const n = ++seq;
      out.textContent = `${range.value}%`;
      const bytes = await encode(format, Number(range.value) / 100).catch(() => null);
      if (n !== seq || !bytes) return;
      note.textContent = `About ${bytes.length < 1048576 ? `${Math.max(1, Math.round(bytes.length / 1024))} KB` : `${(bytes.length / 1048576).toFixed(1)} MB`}`;
    };
    range.addEventListener('input', measure);
    measure();
    const r = await ask({ win, title: `${FORMATS[format].name} quality`, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    seq++;
    return r ? Number(range.value) / 100 : null;
  }
  async function newDialog() {
    if (doc && !(await confirmLeave())) return;
    const body = el(`<div class="ie-dlg"><label class="field"><span>Background</span><select name="bg">
        <option value="white">White</option><option value="transparent">Transparent</option><option value="primary">Primary color</option></select></label></div>`);
    $('[name="bg"]', body).value = prefs.bg;
    const r = await ask({
      win,
      title: 'New image',
      fields: [{ name: 'w', label: 'Width (pixels)', type: 'number', value: doc?.w || 1280 }, { name: 'h', label: 'Height (pixels)', type: 'number', value: doc?.h || 720 }],
      body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }],
      check: sizeCheck,
    });
    if (!r) return;
    const w = Number(r.values.w);
    const h = Number(r.values.h);
    prefs.bg = $('[name="bg"]', body).value;
    savePrefs();
    const c = makeCanvas(w, h);
    if (prefs.bg !== 'transparent') {
      const x = ctxOf(c);
      x.fillStyle = prefs.bg === 'white' ? '#ffffff' : prefs.primary;
      x.fillRect(0, 0, w, h);
    }
    startDoc(w, h, c, 'Untitled.png', null);
  }

  /* ---------------- tools ---------------- */

  function setTool(id) {
    if (id !== tool) {
      if (text) commitText();
      if (float && id !== 'move') dropFloat();
    }
    if (id === 'picker' && tool !== 'picker') prevTool = tool;
    tool = id;
    $$('.ie-tool', root).forEach((b) => b.classList.toggle('on', b.dataset.tool === id));
    drawOptions();
    drawStatus();
    setCursor();
    redrawOver();
  }
  function setCursor(e) {
    let c = 'crosshair';
    if (spaceDown || tool === 'hand') c = drag ? 'grabbing' : 'grab';
    else if (tool === 'text') c = 'text';
    else if (tool === 'brush' || tool === 'eraser' || tool === 'pencil') c = prefs.size * zoom > 4 ? 'none' : 'crosshair';
    else if (tool === 'move') {
      c = 'default';
      const b = moveBox();
      if (e && doc) {
        const p = locate(e);
        if (b) {
          const pts = handlePoints(b);
          const h = HANDLES.find((n) => Math.hypot(pts[n][0] - p.vx, pts[n][1] - p.vy) <= 10 * (devicePixelRatio || 1));
          if (h) c = HANDLE_CURSOR[h];
          else if (p.x >= b.x && p.y >= b.y && p.x < b.x + b.w && p.y < b.y + b.h) c = 'move';
        } else if (!sel) c = 'move';
      }
    }
    over.style.cursor = adjusting ? 'default' : c;
  }

  const select = (name, label, options) =>
    `<label class="ie-opt"><span>${esc(label)}</span><select data-o="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${String(prefs[name]) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  const slider = (name, label, min, max, unit = '%') =>
    `<label class="ie-opt"><span>${esc(label)}</span><input type="range" data-o="${name}" min="${min}" max="${max}" value="${prefs[name]}"><output>${prefs[name]}${unit}</output></label>`;
  const number = (name, label, min, max) => `<label class="ie-opt"><span>${esc(label)}</span><input type="number" data-o="${name}" min="${min}" max="${max}" value="${prefs[name]}"></label>`;
  const toggle = (name, label) => `<label class="ie-opt ie-check"><input type="checkbox" data-o="${name}"${prefs[name] ? ' checked' : ''}> ${esc(label)}</label>`;
  const OPTION = {
    size: () => number('size', 'Size', 1, 1000),
    hardness: () => slider('hardness', 'Hardness', 0, 100),
    opacity: () => slider('opacity', 'Opacity', 1, 100),
    tolerance: () => slider('tolerance', 'Tolerance', 0, 100),
    contiguous: () => toggle('contiguous', 'Touching only'),
    mode: () => select('mode', 'Selection', [['replace', 'Replace'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']]),
    shape: () => select('shape', 'Draw', [['outline', 'Outline'], ['fill', 'Filled'], ['both', 'Outline and fill']]),
    gradient: () => select('gradient', 'Colors', [['colors', 'Primary to secondary'], ['fade', 'Primary to transparent']]),
    font: () => select('font', 'Font', FONTS.map((f) => [f, f])),
    fontSize: () => number('fontSize', 'Size', 4, 1000),
    bold: () => toggle('bold', 'Bold'),
    italic: () => toggle('italic', 'Italic'),
  };
  const toolDef = () => TOOLS.find((t) => t && t[0] === tool);
  function drawOptions() {
    const t = toolDef();
    optionsEl.innerHTML = `<b>${esc(t[1])}</b>${t[4].map((k) => OPTION[k]()).join('')}`;
  }
  const NUMERIC = new Set(['size', 'hardness', 'opacity', 'tolerance', 'fontSize']);
  function optionChanged(e) {
    const name = e.target.dataset.o;
    if (!name) return;
    let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (NUMERIC.has(name)) {
      value = Number(value);
      if (!Number.isFinite(value)) return;
      value = clamp(value, Number(e.target.min), Number(e.target.max));
    }
    prefs[name] = value;
    if (e.target.nextElementSibling?.tagName === 'OUTPUT') e.target.nextElementSibling.textContent = `${value}%`;
    tipKey = '';
    savePrefs();
    if (text) {
      placeTypeBox();
      typeBox.focus();
    }
    setCursor();
    redrawOver();
  }
  optionsEl.addEventListener('input', optionChanged);
  optionsEl.addEventListener('change', (e) => {
    optionChanged(e);
    if (e.target.matches('select, input[type=checkbox]') && !text) root.focus({ preventScroll: true });
  });

  function setColor(which, hex) {
    prefs[which] = hex;
    savePrefs();
    drawColors();
    if (text && which === 'primary') {
      text.color = hex;
      placeTypeBox();
      redrawOver();
    }
  }
  function drawColors() {
    $('.ie-well.first', root).style.background = prefs.primary;
    $('.ie-well.second', root).style.background = prefs.secondary;
    $('.ie-well.first', root).title = `Primary color: ${prefs.primary.toUpperCase()}`;
    $('.ie-well.second', root).title = `Secondary color: ${prefs.secondary.toUpperCase()}`;
  }
  function swapColors() {
    [prefs.primary, prefs.secondary] = [prefs.secondary, prefs.primary];
    savePrefs();
    drawColors();
  }
  $('.ie-colors', root).addEventListener('click', (e) => {
    const sw = e.target.closest('[data-swatch]');
    if (sw) return setColor('primary', sw.dataset.swatch);
    const well = e.target.closest('[data-well]')?.dataset.well;
    if (!well) return;
    const r = e.target.getBoundingClientRect();
    pickColor(r.left - 250, r.bottom + 6, {
      value: prefs[well],
      title: well === 'primary' ? 'Primary color' : 'Secondary color',
      onChange: (c) => c && setColor(well, c),
      onDone: (c) => c && setColor(well, c),
    });
  });
  $('.ie-colors', root).addEventListener('contextmenu', (e) => {
    const sw = e.target.closest('[data-swatch]');
    if (!sw) return;
    e.preventDefault();
    setColor('secondary', sw.dataset.swatch);
  });

  /* ---------------- panels ---------------- */

  function drawTitle() {
    win.setTitle(doc ? `${dirty() ? '• ' : ''}${doc.name}` : 'Image Editor');
    const set = (a, on, title) => {
      const b = $(`[data-act="${a}"]`, win.tools);
      b.disabled = !on;
      if (title) b.title = title;
    };
    set('save', !!doc);
    const u = hist.undo.at(-1);
    const r = hist.redo.at(-1);
    set('undo', !!doc && (!!u || !!float || !!text || !!adjusting), `Undo${u ? ` ${u.label}` : ''} (Ctrl+Z)`);
    set('redo', !!doc && !!r, `Redo${r ? ` ${r.label}` : ''} (Ctrl+Y)`);
  }
  function drawStatus(box) {
    $('.ie-hint', root).textContent = doc ? toolDef()[5] : '';
    $('.ie-st-size', root).textContent = doc ? `${doc.w} × ${doc.h}` : '';
    const s = box || (float ? float : sel);
    $('.ie-st-sel', root).textContent = doc && s ? `Selected ${s.w} × ${s.h}` : '';
    const pos = doc && hover && hover.x >= 0 && hover.y >= 0 && hover.x < doc.w && hover.y < doc.h;
    $('.ie-st-pos', root).textContent = pos ? `${Math.floor(hover.x)}, ${Math.floor(hover.y)}` : '';
    $('.ie-zoom', root).textContent = doc ? `${Math.round(zoom * 100)}%` : '';
    $$('[data-act^="zoom"]', root).forEach((b) => (b.disabled = !doc));
  }
  function drawLayers() {
    const on = !!doc;
    $('.ie-side', root).classList.toggle('off', !on);
    if (!on) {
      layersEl.innerHTML = '';
      return;
    }
    layersEl.innerHTML = [...doc.layers]
      .reverse()
      .map(
        (l) => `<div class="ie-layer${l === doc.active ? ' on' : ''}" data-layer="${l.id}" title="Double-click to rename">
        <canvas width="40" height="30"></canvas><span>${esc(l.name)}</span>
        <button type="button" class="ie-eye${l.visible ? '' : ' off'}" data-eye="${l.id}" title="${l.visible ? 'Hide' : 'Show'} layer" aria-label="${l.visible ? 'Hide' : 'Show'} layer">${icon('eye', 14)}</button></div>`,
      )
      .join('');
    for (const row of $$('.ie-layer', layersEl)) {
      const l = doc.layers.find((x) => x.id === Number(row.dataset.layer));
      const c = $('canvas', row);
      const k = Math.min(40 / doc.w, 30 / doc.h);
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'medium';
      x.drawImage(l.canvas, (40 - doc.w * k) / 2, (30 - doc.h * k) / 2, doc.w * k, doc.h * k);
    }
    const range = $('[data-layer-opacity]', root);
    range.value = Math.round(doc.active.opacity * 100);
    range.nextElementSibling.textContent = `${range.value}%`;
    const i = doc.layers.indexOf(doc.active);
    const dis = (a, off) => ($(`[data-act="${a}"]`, root).disabled = off);
    dis('layer-merge', i < 1);
    dis('layer-down', i < 1);
    dis('layer-up', i >= doc.layers.length - 1);
    dis('layer-del', doc.layers.length < 2);
  }
  layersEl.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      const l = doc.layers.find((x) => x.id === Number(eye.dataset.eye));
      record(l.visible ? 'Hide Layer' : 'Show Layer', () => (l.visible = !l.visible));
      return;
    }
    const row = e.target.closest('[data-layer]');
    if (!row) return;
    const l = doc.layers.find((x) => x.id === Number(row.dataset.layer));
    if (l === doc.active) return;
    commitPending();
    doc.active = l;
    drawLayers();
  });
  layersEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-layer]');
    if (!row || e.target.closest('[data-eye]')) return;
    renameLayer(doc.layers.find((x) => x.id === Number(row.dataset.layer)));
  });
  let opacityFrom = null;
  const opacityRange = $('[data-layer-opacity]', root);
  opacityRange.addEventListener('input', () => {
    if (!doc) return;
    if (!opacityFrom) {
      commitPending();
      opacityFrom = capture();
    }
    doc.active.opacity = Number(opacityRange.value) / 100;
    opacityRange.nextElementSibling.textContent = `${opacityRange.value}%`;
    redraw();
  });
  opacityRange.addEventListener('change', () => {
    if (!opacityFrom) return;
    const a = opacityFrom;
    opacityFrom = null;
    pushCaptured('Layer Opacity', a);
    root.focus({ preventScroll: true });
  });

  /* ---------------- menus ---------------- */

  const menus = () => {
    const has = !!doc;
    const hasSel = has && (!!sel || !!float);
    return {
      File: [
        { label: 'New…', act: newDialog },
        { label: 'New from Clipboard', key: 'Ctrl+Alt+V', act: pasteAsNew },
        { label: 'Open…', key: 'Ctrl+O', act: chooseFile },
        '-',
        { label: 'Save', key: 'Ctrl+S', disabled: !has, act: save },
        { label: 'Save As…', key: 'Ctrl+Shift+S', disabled: !has, act: saveAs },
      ],
      Edit: [
        { label: hist.undo.at(-1) ? `Undo ${hist.undo.at(-1).label}` : 'Undo', key: 'Ctrl+Z', disabled: !hist.undo.length && !float && !text && !adjusting, act: undo },
        { label: hist.redo.at(-1) ? `Redo ${hist.redo.at(-1).label}` : 'Redo', key: 'Ctrl+Y', disabled: !hist.redo.length, act: redo },
        '-',
        { label: 'Cut', key: 'Ctrl+X', disabled: !has, act: cut },
        { label: 'Copy', key: 'Ctrl+C', disabled: !has, act: () => copyImage() },
        { label: 'Copy Merged', key: 'Ctrl+Shift+C', disabled: !has, act: () => copyImage(true) },
        { label: 'Paste', key: 'Ctrl+V', act: paste },
        '-',
        { label: 'Erase Selection', key: 'Delete', disabled: !hasSel, act: () => clearSelected() },
        { label: 'Fill Selection', key: 'Backspace', disabled: !hasSel, act: fillSelected },
        '-',
        { label: 'Select All', key: 'Ctrl+A', disabled: !has, act: selectAll },
        { label: 'Deselect', key: 'Ctrl+D', disabled: !hasSel, act: deselect },
        { label: 'Invert Selection', key: 'Ctrl+I', disabled: !has, act: invertSelection },
      ],
      View: [
        { label: 'Zoom In', key: '+', disabled: !has, act: () => zoomStep(1) },
        { label: 'Zoom Out', key: '−', disabled: !has, act: () => zoomStep(-1) },
        { label: 'Fit in Window', key: '0', disabled: !has, act: fit },
        { label: 'Actual Size', key: '1', disabled: !has, act: () => zoomTo(1) },
      ],
      Image: [
        { label: 'Crop to Selection', key: 'Ctrl+Shift+X', disabled: !hasSel, act: cropToSelection },
        { label: 'Trim Transparent Edges', disabled: !has, act: trim },
        '-',
        { label: 'Resize…', key: 'Ctrl+R', disabled: !has, act: resizeDialog },
        { label: 'Canvas Size…', disabled: !has, act: canvasDialog },
        '-',
        { label: 'Rotate Right', disabled: !has, act: () => turn(90) },
        { label: 'Rotate Left', disabled: !has, act: () => turn(-90) },
        { label: 'Rotate 180°', disabled: !has, act: () => turn(180) },
        { label: 'Flip Horizontal', disabled: !has, act: () => flip(true) },
        { label: 'Flip Vertical', disabled: !has, act: () => flip(false) },
        '-',
        { label: 'Flatten', disabled: !has || doc.layers.length < 2, act: flatten },
      ],
      Layers: [
        { label: 'Add Layer', disabled: !has, act: addLayer },
        { label: 'Add from File…', disabled: !has, act: () => addLayerFromFile() },
        { label: 'Duplicate Layer', disabled: !has, act: duplicateLayer },
        { label: 'Delete Layer', disabled: !has || doc.layers.length < 2, act: deleteLayer },
        { label: 'Merge Down', disabled: !has || doc.layers.indexOf(doc.active) < 1, act: mergeDown },
        '-',
        { label: 'Move Up', disabled: !has || doc.layers.indexOf(doc.active) >= doc.layers.length - 1, act: () => moveLayer(1) },
        { label: 'Move Down', disabled: !has || doc.layers.indexOf(doc.active) < 1, act: () => moveLayer(-1) },
        '-',
        { label: 'Flip Layer Horizontal', disabled: !has, act: () => flipLayer(true) },
        { label: 'Flip Layer Vertical', disabled: !has, act: () => flipLayer(false) },
        '-',
        { label: 'Rename…', disabled: !has, act: () => renameLayer(doc.active) },
      ],
      Adjustments: [
        { label: 'Brightness / Contrast…', disabled: !has, act: adjustments.brightness },
        { label: 'Hue / Saturation…', disabled: !has, act: adjustments.hue },
        { label: 'Blur…', disabled: !has, act: adjustments.blur },
        { label: 'Sharpen…', disabled: !has, act: adjustments.sharpen },
        '-',
        { label: 'Black and White', disabled: !has, act: () => applyFilter('Black and White', 'grayscale(1)') },
        { label: 'Sepia', disabled: !has, act: () => applyFilter('Sepia', 'sepia(1)') },
        { label: 'Invert Colors', disabled: !has, act: () => applyFilter('Invert Colors', 'invert(1)') },
      ],
    };
  };
  async function cut() {
    if (await copyImage()) clearSelected('Cut');
  }
  $('.ie-menus', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]');
    if (!b) return;
    if (menuOwner() === b) return closeMenu();
    const r = b.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, menus()[b.dataset.menu], { owner: b, minWidth: 220, onClose: () => root.focus({ preventScroll: true }) });
  });

  function act(a) {
    const needs = { save, undo, redo, swap: swapColors, 'zoom-in': () => zoomStep(1), 'zoom-out': () => zoomStep(-1), 'layer-add': addLayer, 'layer-dup': duplicateLayer, 'layer-merge': mergeDown, 'layer-up': () => moveLayer(1), 'layer-down': () => moveLayer(-1), 'layer-del': deleteLayer };
    if (a === 'open') return chooseFile();
    if (a === 'new') return newDialog();
    if (a === 'paste-new') return pasteAsNew();
    if (a === 'swap') return swapColors();
    if (!doc) return;
    if (a === 'zoom-menu') {
      const r = $('.ie-zoom', root).getBoundingClientRect();
      return showMenu(r.left, r.top - 4, [{ label: 'Fit in Window', act: fit }, '-', ...[0.25, 0.5, 1, 2, 4, 8, 16].map((z) => ({ label: `${z * 100}%`, checked: Math.abs(zoom - z) < 0.001, act: () => zoomTo(z) }))], { up: true });
    }
    needs[a]?.();
  }
  const onClick = (e) => {
    const t = e.target.closest('[data-tool]');
    if (t) return setTool(t.dataset.tool);
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a) act(a);
    if (e.target.closest('[data-adjust="cancel"]')) closeAdjust(false);
  };
  root.addEventListener('click', onClick);
  win.tools.addEventListener('click', onClick);

  /* ---------------- pointer ---------------- */

  const touches = new Map(); // fingers down, for pinching
  let pinch = null;
  function pinchStart() {
    const [a, b] = [...touches.values()];
    const r = over.getBoundingClientRect();
    const k = over.width / r.width;
    pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, zoom, cx: (((a[0] + b[0]) / 2 - r.left) * k), cy: (((a[1] + b[1]) / 2 - r.top) * k), ox, oy };
  }
  function panDrag(p) {
    let last = p;
    return {
      move(_q, e) {
        const n = locate(e);
        panBy(n.vx - last.vx, n.vy - last.vy);
        last = n;
      },
      up() {},
      cancel() {},
    };
  }
  function toolDown(p, e) {
    switch (tool) {
      case 'move': return moveDrag(p, e);
      case 'select': return shapeSelectDrag(p, e, false);
      case 'ellipse-select': return shapeSelectDrag(p, e, true);
      case 'lasso': return lassoDrag(p, e);
      case 'wand': return wandClick(p, e);
      case 'brush': return brushDrag(p, e, 'Paintbrush', false);
      case 'eraser': return brushDrag(p, e, 'Eraser', true);
      case 'pencil': return pencilDrag(p, e);
      case 'fill': return fillTool(p, e);
      case 'gradient': return gradientTool(p, e);
      case 'line': return lineTool(p, e);
      case 'rect': return shapeTool(p, e, 'rect');
      case 'ellipse': return shapeTool(p, e, 'ellipse');
      case 'text':
        if (text) return commitText();
        return startText(p, e);
      case 'picker':
        pickAt(p, e);
        return {
          move: (q) => pickAt(q, e),
          up() {
            if (PAINTS.has(prevTool)) setTool(prevTool);
          },
          cancel() {},
        };
      case 'hand': return panDrag(p);
      default: return null;
    }
  }
  over.addEventListener('mousedown', (e) => e.preventDefault()); // the tool decides where the keyboard goes (text takes it)
  over.addEventListener('pointerdown', (e) => {
    if (typeBox.hidden) root.focus({ preventScroll: true });
    if (!doc || adjusting) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        drag?.cancel();
        drag = null;
        pinchStart();
        return;
      }
    }
    if (drag || (e.button !== 0 && e.button !== 1 && e.button !== 2)) return;
    over.setPointerCapture(e.pointerId);
    const p = locate(e);
    hover = p;
    drag = e.button === 1 || spaceDown ? panDrag(p) : toolDown(p, e) || null;
    setCursor(e);
    redrawOver();
  });
  over.addEventListener('pointermove', (e) => {
    if (!doc) return;
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = over.getBoundingClientRect();
      const k = over.width / r.width;
      const cx = ((a[0] + b[0]) / 2 - r.left) * k;
      const cy = ((a[1] + b[1]) / 2 - r.top) * k;
      const z = clamp((pinch.zoom * d) / pinch.d, 0.01, 64);
      ox = cx - ((pinch.cx - pinch.ox) * z) / pinch.zoom;
      oy = cy - ((pinch.cy - pinch.oy) * z) / pinch.zoom;
      zoom = z;
      fitted = false;
      clampPan();
      viewChanged();
      return;
    }
    hover = locate(e);
    if (drag) {
      const list = e.getCoalescedEvents?.() || [];
      for (const c of list.length ? list : [e]) drag.move(locate(c), e);
    } else setCursor(e);
    drawStatus();
    redrawOver();
  });
  const pointerEnd = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (!drag) return;
    const d = drag;
    drag = null;
    if (e.type === 'pointercancel') d.cancel();
    else d.up(locate(e), e);
    setCursor(e);
    redrawOver();
  };
  over.addEventListener('pointerup', pointerEnd);
  over.addEventListener('pointercancel', pointerEnd);
  over.addEventListener('pointerleave', () => {
    if (drag) return;
    hover = null;
    drawStatus();
    redrawOver();
  });
  stage.addEventListener('contextmenu', (e) => {
    if (e.target !== typeBox) e.preventDefault();
  });
  // Ctrl+wheel (and a touchpad's pinch) zooms around the pointer; the wheel alone moves around, as in other paint programs.
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!doc) return;
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 40 : 1;
      if (e.ctrlKey || e.metaKey) {
        const p = locate(e);
        return zoomTo(zoom * Math.exp(-e.deltaY * scale * 0.002), p.vx, p.vy);
      }
      const k = devicePixelRatio || 1;
      panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * scale * k, e.shiftKey ? 0 : -e.deltaY * scale * k);
    },
    { passive: false },
  );
  typeBox.addEventListener('input', () => {
    placeTypeBox();
    redrawOver();
  });

  /* ---------------- keyboard ---------------- */

  function onKey(e) {
    if (e.target.closest?.('.sheet-wrap')) return; // a dialog's own keys
    const typing = e.target.matches?.('input:not([type=range]):not([type=checkbox]), textarea, select');
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.target === typeBox) {
      if (e.key === 'Escape') cancelText();
      else if (e.key === 'Enter' && ctrl) commitText();
      else return;
      e.preventDefault();
      return;
    }
    if (ctrl && !e.altKey && k === 's') {
      e.preventDefault();
      return e.shiftKey ? saveAs() : save();
    }
    if (ctrl && !e.altKey && k === 'o') {
      e.preventDefault();
      return chooseFile();
    }
    if (typing) return;
    if (drag && e.key !== 'Escape') return; // Ctrl+Z in the middle of a stroke would undo under it
    if (adjusting) {
      if (e.key === 'Escape') closeAdjust(false);
      else if (e.key === 'Enter') closeAdjust(true);
      else return;
      return e.preventDefault();
    }
    if (ctrl && e.altKey && k === 'v') {
      e.preventDefault();
      return pasteAsNew();
    }
    if (ctrl && k === 'v') {
      e.preventDefault();
      return paste();
    }
    if (!doc) return;
    let handled = true;
    if (ctrl && !e.altKey) {
      if (k === 'z') e.shiftKey ? redo() : undo();
      else if (k === 'y') redo();
      else if (k === 'c') copyImage(e.shiftKey);
      else if (k === 'x' && e.shiftKey) cropToSelection();
      else if (k === 'x') cut();
      else if (k === 'a') selectAll();
      else if (k === 'd') deselect();
      else if (k === 'i') invertSelection();
      else if (k === 'r') resizeDialog();
      else if (k === '0') fit();
      else if (k === '=' || k === '+') zoomStep(1);
      else if (k === '-') zoomStep(-1);
      else handled = false;
    } else if (e.altKey) {
      handled = false;
    } else if (e.key === ' ') {
      spaceDown = true;
      setCursor();
      redrawOver();
    } else if (e.key === 'Escape') {
      if (drag) {
        const d = drag;
        drag = null;
        d.cancel();
      } else if (float) cancelFloat();
      else if (sel) deselect();
      else handled = false;
    } else if (e.key === 'Enter') {
      if (float) dropFloat();
      else handled = false;
    } else if (e.key === 'Delete') {
      if (sel || float) clearSelected();
      else handled = false;
    } else if (e.key === 'Backspace') {
      if (sel || float) fillSelected();
      else handled = false;
    } else if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (tool === 'move' && (sel || float)) nudge(dx, dy);
      else handled = false;
    } else if (k === '[' || k === ']') {
      prefs.size = clamp(prefs.size + (k === ']' ? 1 : -1) * Math.max(1, Math.round(prefs.size / 10)), 1, 1000);
      savePrefs();
      tipKey = '';
      drawOptions();
      setCursor();
      redrawOver();
    } else if (k === '+' || k === '=') zoomStep(1);
    else if (k === '-') zoomStep(-1);
    else if (k === '0') fit();
    else if (k === '1') zoomTo(1);
    else if (k === 'x') swapColors();
    else {
      const t = TOOLS.find((x) => x && x[3].toLowerCase() === k);
      if (t) setTool(t[0]);
      else handled = false;
    }
    if (handled) e.preventDefault();
  }
  win.el.addEventListener('keydown', onKey);
  // Clicking the title bar or a button in it takes the keyboard off the picture.
  win.el.addEventListener('pointerup', () => setTimeout(() => {
    const a = document.activeElement;
    if ((a === document.body || win.tools.contains(a)) && !$(':scope > .sheet-wrap', win.el)) refocus();
  }));
  root.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      setCursor();
      redrawOver();
    }
  });
  // Ctrl+D, Ctrl+R and Ctrl+0/+/− are Leafdeck's own until something says it wants them, as Designer's canvas does.
  const keysHere = (on) => shell.designer?.focus(on);
  root.addEventListener('focusin', () => keysHere(true));
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget)) keysHere(false);
  });
  win.cleanups.push(() => keysHere(false));

  /* ---------------- dropping files ---------------- */

  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE) && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  root.addEventListener('drop', async (e) => {
    let paths = [];
    try {
      paths = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]');
    } catch {}
    if (!paths.length) paths = [...e.dataTransfer.files].map((f) => shell.files.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    e.preventDefault();
    const p = paths.find((x) => OPENS.test(x));
    if (!p) return toast('That isn’t a picture Image Editor can open', 'error');
    if (!doc) return open(p);
    const r = await ask({
      win,
      title: `Open “${base(p)}”?`,
      message: 'It can replace the picture here, or go on top of it as a new layer.',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Open', value: 'open' }, { label: 'Add as Layer', value: 'layer', primary: true }],
    });
    if (r?.button === 'open') open(p);
    else if (r?.button === 'layer') addLayerFromFile(p);
  });

  /* ---------------- start ---------------- */

  win.imageEditor = { open: (p) => open(p), confirmLeave };
  drawColors();
  setTool('brush');
  changed();
  const asked = pending;
  pending = null;
  const lastFile = stored(LAST);
  if (asked) open(asked);
  else if (lastFile) open(lastFile, { quiet: true });
}
