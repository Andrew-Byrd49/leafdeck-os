// Leafdeck OS screenshots, like the Windows Snipping Tool: Print Screen (or Super+Shift+S) freezes the screen; drag to
// select an area, or click a window or an empty part of a screen to take just that. It's copied to the clipboard and
// saved in Pictures/Screenshots (electron/main.cjs, os:snip-save). Esc cancels. Ctrl+Print Screen takes the whole screen.
import { shell } from './shell.js';
import { el, $ } from './util.js';
import { toast, openApp, wins, screens } from './wm.js';

let open = null;

/** The frozen screen (a capture at `path`), with a selection drawn over it. */
async function snip({ path }) {
  if (open) return;
  const img = new Image();
  img.src = `/~file?p=${encodeURIComponent(path)}`;
  try {
    await img.decode();
  } catch {
    shell.os.snipCancel();
    return toast('Couldn’t take a screenshot', 'error');
  }
  // What a click picks: the window under the pointer (front first), else the screen it's on.
  const winRects = [...wins.values()]
    .filter((w) => !w.minimized && w.el.isConnected && !w.el.classList.contains('hidden'))
    .sort((a, b) => b.z - a.z)
    .map((w) => w.el.getBoundingClientRect());
  const screenRects = screens();
  const ui = el(`<div class="snip" role="dialog" aria-label="Screenshot">
    <div class="snip-shade"></div>
    <div class="snip-sel" hidden><span class="snip-size"></span></div>
    <div class="snip-hint">Drag to select an area · Click a window or a screen · Esc to cancel</div>
  </div>`);
  ui.prepend(img);
  img.className = 'snip-shot';
  img.draggable = false;
  document.body.append(ui);
  // The hint goes on the main screen, wherever that is.
  const main = screenRects[0];
  Object.assign($('.snip-hint', ui).style, { left: `${main.x + main.w / 2}px`, top: `${main.y + 18}px` });
  const sel = $('.snip-sel', ui);
  const shade = $('.snip-shade', ui);
  const size = $('.snip-size', ui);
  const ratio = img.naturalWidth / innerWidth; // the capture's pixels per page pixel (2 on a 2x screen)
  open = { ui };

  const show = (r, preview = false) => {
    if (!r || r.w < 1 || r.h < 1) {
      sel.hidden = true;
      shade.hidden = false;
      return;
    }
    sel.hidden = false;
    shade.hidden = true; // the selection's own shadow darkens the rest
    sel.classList.toggle('preview', preview);
    Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    size.textContent = `${Math.round(r.w * ratio)} × ${Math.round(r.h * ratio)}`;
  };
  const inside = (r, x, y) => x >= (r.x ?? r.left) && y >= (r.y ?? r.top) && x < (r.x ?? r.left) + (r.w ?? r.width) && y < (r.y ?? r.top) + (r.h ?? r.height);
  const clickTarget = (x, y) => {
    const w = winRects.find((r) => inside(r, x, y));
    if (w) return { x: w.left, y: w.top, w: w.width, h: w.height };
    const s = screenRects.find((r) => inside(r, x, y)) || main;
    return { x: s.x, y: s.y, w: s.w, h: s.h };
  };

  function finish(r) {
    close();
    if (!r) return void shell.os.snipCancel();
    // Crop from the capture (the overlay itself is never in the picture), clipped to the capture's edges.
    const sx = Math.max(0, Math.round(r.x * ratio));
    const sy = Math.max(0, Math.round(r.y * ratio));
    const sw = Math.min(img.naturalWidth - sx, Math.round(r.w * ratio));
    const sh = Math.min(img.naturalHeight - sy, Math.round(r.h * ratio));
    if (sw < 2 || sh < 2) return void shell.os.snipCancel();
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    flash(r);
    c.toBlob(async (blob) => {
      try {
        const file = await shell.os.snipSave(new Uint8Array(await blob.arrayBuffer()));
        toast('Screenshot copied and saved', '', { label: 'Show', act: () => openApp('files', { reveal: file }) });
      } catch (err) {
        toast(`Couldn’t save the screenshot: ${err.message}`, 'error');
      }
    }, 'image/png');
  }

  let start = null;
  let dragging = false;
  ui.addEventListener('pointermove', (e) => {
    if (!start) return show(clickTarget(e.clientX, e.clientY), true);
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
    dragging = true;
    show({ x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) });
  });
  ui.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return finish(null); // right-click cancels, like the Snipping Tool
    ui.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    dragging = false;
  });
  ui.addEventListener('pointerup', (e) => {
    if (!start) return;
    const r = dragging
      ? { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) }
      : clickTarget(e.clientX, e.clientY);
    start = null;
    finish(r.w >= 3 && r.h >= 3 ? r : null);
  });
  ui.addEventListener('contextmenu', (e) => e.preventDefault());
  const onKey = (e) => {
    if (e.key === 'Escape') finish(null);
    else if (e.key === 'Enter') finish(screenRects[0]); // the whole main screen
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  addEventListener('keydown', onKey, true);
  function close() {
    removeEventListener('keydown', onKey, true);
    ui.remove();
    open = null;
  }
}

/** A quick white flash over what was taken. */
function flash(r) {
  const f = el('<div class="snip-flash"></div>');
  Object.assign(f.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  document.body.append(f);
  setTimeout(() => f.remove(), 350);
}

/** Called once in the Leafdeck OS session. */
export function initSnip() {
  shell.on('os:snip', snip);
}
