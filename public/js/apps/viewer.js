// Image Viewer: pictures on this computer (Linux and Leafdeck OS), opened from Files or dropped on it. The picture fills
// the window and ← → step through the others in its folder (or swipe). Zoom with the wheel, a pinch, + and − (0 fits,
// 1 is actual size, double-click switches between them); drag to move around a zoomed picture. R turns it, Delete moves
// it to the Trash, Ctrl+C copies it; the rest is in the right-click menu. The only other UI: where you are in the
// folder and the zoom, in the title bar, and arrows at the sides while the pointer is over the picture. It's the
// computer's image viewer too: pictures other programs open (xdg-open) arrive here (os/leafdeck-open).
import { esc, $ } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, showMenu, openApp, forgetOnNewBoot } from '../wm.js';
import { shell } from '../shell.js';

const supported = !!shell?.files && shell.platform === 'linux';
const SHOWS = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i; // what Leafdeck can draw (Files also lists HEIC and TIFF)
const DRAG_TYPE = 'application/x-leafdeck-files'; // files dragged from Files
const LAST = 'viewer:last'; // the picture to show again after restarting Leafdeck
forgetOnNewBoot(LAST);
const fileUrl = (p) => `/~file?p=${encodeURIComponent(p)}`;
const base = (p) => p.split('/').pop();
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const MAX_ZOOM = 16;

let pending = null; // the picture for a new window (openApp('viewer', { file }))
const last = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};
const remember = (p) => {
  try {
    if (p) localStorage.setItem(LAST, p);
    else localStorage.removeItem(LAST);
  } catch {}
};

if (supported) shell.on?.('shell:open-file', ({ path } = {}) => typeof path === 'string' && openApp('viewer', { file: path }));

registerApp({
  id: 'viewer',
  name: 'Image Viewer',
  icon: 'image',
  color: 'pink',
  size: [960, 680],
  min: [360, 260],
  hidden: !supported,
  launch(opts) {
    pending = typeof opts?.file === 'string' ? opts.file : null;
  },
  openFile(win, file) {
    win.viewer?.open(String(file));
  },
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Image Viewer runs on Leafdeck OS</div>
        <p>It shows pictures from this computer’s files, which needs Linux.</p></div>`;
      return;
    }
    win.body.innerHTML = `<div class="iv" tabindex="0">
        <div class="iv-stage"><img class="iv-img" alt="" draggable="false" hidden></div>
        <div class="iv-msg" hidden></div>
        <button class="iv-nav iv-prev" data-iv="prev" title="Previous (←)" hidden>${icon('left', 20)}</button>
        <button class="iv-nav iv-next" data-iv="next" title="Next (→)" hidden>${icon('right', 20)}</button>
      </div>`;
    win.tools.innerHTML = `<span class="iv-count"></span><button class="tb-btn iv-zoom" data-iv="zoom" title="Zoom to fit or actual size" hidden></button>`;
    const root = $('.iv', win.body);
    const stage = $('.iv-stage', root);
    const img = $('.iv-img', root);
    const msg = $('.iv-msg', root);
    const countEl = $('.iv-count', win.tools);
    const zoomEl = $('.iv-zoom', win.tools);

    let list = []; // the pictures in the folder, by name
    let idx = -1;
    let cur = null; // the picture shown
    let seq = 0; // the latest open(), so a slow load can't replace a newer picture
    // The view: scale null fits the window (never larger than actual size); px, py move it from the center.
    let scale = null;
    let rot = 0;
    let px = 0;
    let py = 0;

    /* ---------------- the view ---------------- */

    const dims = () => (rot % 180 ? [img.naturalHeight, img.naturalWidth] : [img.naturalWidth, img.naturalHeight]);
    const fit = () => {
      const [w, h] = dims();
      return w && h ? Math.min(1, stage.clientWidth / w, stage.clientHeight / h) : 1;
    };
    const zoom = () => scale ?? fit();
    function layout() {
      if (!img.naturalWidth || img.hidden) return;
      const s = zoom();
      const [w, h] = dims();
      // A zoomed picture moves only as far as its edges.
      const mx = Math.max(0, (w * s - stage.clientWidth) / 2);
      const my = Math.max(0, (h * s - stage.clientHeight) / 2);
      px = Math.min(mx, Math.max(-mx, px));
      py = Math.min(my, Math.max(-my, py));
      img.style.width = `${img.naturalWidth}px`;
      img.style.height = `${img.naturalHeight}px`;
      img.style.transform = `translate(-50%, -50%) translate(${px}px, ${py}px) rotate(${rot}deg) scale(${s})`;
      stage.classList.toggle('zoomed', scale != null && (mx > 0 || my > 0));
      zoomEl.hidden = false;
      zoomEl.textContent = `${Math.round(s * 100)}%`;
    }
    /** Zoom to `s` around a point (cx, cy from the stage's center); at or below the fit, back to fitting. */
    function zoomTo(s, cx = 0, cy = 0) {
      if (!cur || img.hidden) return;
      const f = fit();
      s = Math.min(MAX_ZOOM, s);
      if (s <= f + 1e-3) {
        scale = null;
        px = py = 0;
        return layout();
      }
      const k = s / zoom();
      px = cx - (cx - px) * k;
      py = cy - (cy - py) * k;
      scale = s;
      layout();
    }
    const fromCenter = (x, y) => {
      const r = stage.getBoundingClientRect();
      return [x - r.left - r.width / 2, y - r.top - r.height / 2];
    };
    function turn(d) {
      rot = (rot + d + 360) % 360;
      scale = null;
      px = py = 0;
      layout();
    }

    /* ---------------- pictures ---------------- */

    function message(title, text, files = false) {
      msg.hidden = false;
      msg.innerHTML = `<div class="empty"><div class="empty-title">${esc(title)}</div><p>${esc(text)}</p>
        ${files ? `<button class="btn small" data-iv="files">${icon('folder', 13)} Open Files</button>` : ''}</div>`;
    }
    function clear() {
      cur = null;
      list = [];
      idx = -1;
      img.hidden = true;
      img.removeAttribute('src');
      zoomEl.hidden = true;
      win.setTitle('Image Viewer');
      remember(null);
      drawCount();
      message('No picture open', 'Open one from Files, or drag it here.', true);
    }
    function drawCount() {
      const many = list.length > 1;
      countEl.textContent = many ? `${idx + 1} of ${list.length}` : '';
      root.querySelectorAll('.iv-nav').forEach((b) => (b.hidden = !many));
    }

    /** Show a picture. `step`: moving through the folder already listed. `quiet`: if it's gone, show nothing instead. */
    async function open(p, { step = false, quiet = false } = {}) {
      if (!p || p === cur) return;
      const n = ++seq;
      cur = p;
      remember(p);
      win.setTitle(base(p));
      scale = null;
      rot = 0;
      px = py = 0;
      msg.hidden = true;
      img.onload = () => {
        if (n !== seq) return;
        img.hidden = false;
        layout();
      };
      img.onerror = () => {
        if (n !== seq) return;
        img.hidden = true;
        zoomEl.hidden = true;
        if (quiet) return clear();
        message(`Can’t show “${base(p)}”`, SHOWS.test(p) ? 'It may be damaged, or no longer there.' : 'Image Viewer can’t show this kind of picture yet.');
      };
      img.src = fileUrl(p);
      root.focus({ preventScroll: true });
      if (!step) {
        list = [p];
        const dir = p.slice(0, p.lastIndexOf('/')) || '/';
        try {
          const { entries } = await shell.files.list(dir);
          if (n !== seq) return;
          list = entries
            .filter((e) => !e.dir && SHOWS.test(e.name) && (!e.hidden || e.path === p))
            .map((e) => e.path)
            .sort((a, b) => byName.compare(base(a), base(b)));
          if (!list.includes(p)) list = [p];
        } catch {}
      }
      idx = list.indexOf(p);
      drawCount();
      // The neighbors load ahead, so stepping is instant.
      if (list.length > 1) for (const d of [1, -1]) new Image().src = fileUrl(list[(idx + d + list.length) % list.length]);
    }
    function go(d) {
      if (list.length < 2) return;
      idx = (idx + d + list.length) % list.length;
      open(list[idx], { step: true });
    }

    async function trash() {
      if (!cur) return;
      const p = cur;
      try {
        await shell.files.trash([p]);
      } catch (x) {
        return toast(x.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      }
      toast(`“${base(p)}” moved to the Trash`);
      const at = list.indexOf(p);
      const rest = list.filter((x) => x !== p);
      if (!rest.length) return clear();
      list = rest;
      cur = null;
      idx = Math.min(at, rest.length - 1);
      open(rest[idx], { step: true });
    }

    async function copyPicture() {
      if (!cur || img.hidden) return;
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Picture copied');
      } catch {
        toast('Couldn’t copy this picture', 'error');
      }
    }

    /* ---------------- pointer, touch, wheel ---------------- */

    // One pointer drags a zoomed picture (or, fitted, swipes to the next one); two pinch.
    const pts = new Map();
    let gesture = null;
    function begin() {
      const p = [...pts.values()];
      if (p.length >= 2) gesture = { pinch: true, d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1, s: zoom() };
      else if (p.length === 1) gesture = { x: p[0][0], y: p[0][1], px, py };
      else gesture = null;
    }
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || img.hidden) return;
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      begin();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !gesture) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (gesture.pinch) {
        const [a, b] = [...pts.values()];
        zoomTo((gesture.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / gesture.d, ...fromCenter((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
      } else if (scale != null) {
        px = gesture.px + e.clientX - gesture.x;
        py = gesture.py + e.clientY - gesture.y;
        layout();
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const g = gesture;
      pts.delete(e.pointerId);
      if (g && !g.pinch && scale == null && !pts.size && e.type === 'pointerup') {
        const dx = e.clientX - g.x;
        if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(e.clientY - g.y)) go(dx < 0 ? 1 : -1);
      }
      begin(); // a pinch that loses a finger carries on as a drag
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('dblclick', (e) => {
      if (scale != null) return zoomTo(0);
      zoomTo(fit() >= 1 ? 2 : 1, ...fromCenter(e.clientX, e.clientY));
    });
    // The wheel zooms; a touchpad pinch arrives as Ctrl+wheel, in smaller steps.
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        zoomTo(zoom() * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), ...fromCenter(e.clientX, e.clientY));
      },
      { passive: false },
    );
    const ro = new ResizeObserver(() => layout());
    ro.observe(stage);
    win.cleanups.push(() => ro.disconnect());

    /* ---------------- keys, buttons, menu, drop ---------------- */

    root.addEventListener('keydown', (e) => {
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'c') copyPicture();
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) go(1);
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === ' ') go(-1);
      else if (k === 'Home' && list.length) open(list[0], { step: true });
      else if (k === 'End' && list.length) open(list[list.length - 1], { step: true });
      else if (k === '+' || k === '=') zoomTo(zoom() * 1.25);
      else if (k === '-') zoomTo(zoom() / 1.25);
      else if (k === '0') zoomTo(0);
      else if (k === '1') zoomTo(1);
      else if (k === 'e' && cur) openApp('imageeditor', { file: cur });
      else if (k === 'r') turn(90);
      else if (k === 'R') turn(-90);
      else if (k === 'Delete') trash();
      else return;
      e.preventDefault();
    });
    win.body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-iv]')?.dataset.iv;
      if (a === 'prev') go(-1);
      else if (a === 'next') go(1);
      else if (a === 'files') openApp('files');
    });
    zoomEl.addEventListener('click', () => (scale == null ? zoomTo(1) : zoomTo(0)));
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!cur) return;
      const shown = !img.hidden;
      showMenu(e.clientX, e.clientY, [
        shown && { label: 'Zoom to fit', key: '0', act: () => zoomTo(0) },
        shown && { label: 'Actual size', key: '1', act: () => zoomTo(1) },
        shown && { label: 'Turn right', key: 'R', act: () => turn(90) },
        shown && { label: 'Turn left', key: 'Shift+R', act: () => turn(-90) },
        shown && '-',
        shown && { label: 'Copy', key: 'Ctrl+C', act: copyPicture },
        { label: 'Edit in Image Editor', key: 'E', act: () => openApp('imageeditor', { file: cur }) },
        { label: 'Copy location', act: () => shell.files.copyPath([cur]).then(() => toast('Location copied')) },
        { label: 'Show in Files', act: () => openApp('files', { reveal: cur }) },
        '-',
        { label: 'Move to Trash', key: 'Delete', act: trash },
      ]);
    });
    root.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    root.addEventListener('drop', (e) => {
      let paths = [];
      try {
        paths = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]');
      } catch {}
      if (!paths.length) return;
      e.preventDefault();
      const p = paths.find((x) => SHOWS.test(x));
      if (p) open(p);
      else toast('That isn’t a picture Image Viewer can show', 'error');
    });

    win.viewer = { open: (p) => open(p) };
    win.print = {
      can: () => cur != null,
      async run() {
        const problem = await shell.print.file(cur).catch((x) => x.message);
        if (problem) toast(problem, 'error');
      },
    };
    // The picture asked for, or (after restarting Leafdeck) the one shown before, if it's still there.
    const asked = pending;
    pending = null;
    if (asked) open(asked);
    else if (last()) open(last(), { quiet: true });
    else clear();
  },
});
