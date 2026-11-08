// Designer: design one UI element at a time (a button, a menu, an input field) on a Figma-style canvas, or capture one
// from anywhere (any site window, Leafdeck itself, another browser, a screenshot), then hand it to Claude to build.
// The canvas is designer/editor.js; panels: designer/layers.js, inspector.js, handoff.js; capture: designer/capture.js
// (+ inpage.js, which runs inside pages); storage: designer/storage.js (electron/designer.cjs in the app); the icon
// library: designer/iconpicker.js. Markup (drawing on the design to show Claude what you mean) is in the editor.
// Designer has two halves: UI Designer (all of the above) and Graphic Designer (graphic/app.js: vector artwork, like a
// simpler Illustrator). The home screen switches between them; a design's kind ('graphic' or not) says which opens it.
import { $, esc, uid, debounce } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, openApp, wins, showMenu, minimize } from '../wm.js';
import { ask, confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';
import { createChat, listen } from '../agentchat.js';
import { storage } from '../designer/storage.js';
import { createEditor, renderStatic, MARK_TOOLS, MARK_COLORS } from '../designer/editor.js';
import { createIconPicker, ICON_MIME } from '../designer/iconpicker.js';
import { createLayers } from '../designer/layers.js';
import { createInspector } from '../designer/inspector.js';
import { createHandoff, componentOf } from '../designer/handoff.js';
import { templates, makeTemplate } from '../designer/templates.js';
import { glyph } from '../designer/glyphs.js';
import { assetsUsed, exportComponent, previewPage, handoffMarkdown, statesOf, makeNode, layoutOf, walk, FRAMEWORKS } from '../designer/model.js';
import { captureHtml, svgSize, bookmarklet, inPage } from '../designer/capture.js';
import { mountGraphic, newGraphicDoc, GRAPHIC_PRESETS } from '../graphic/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (t) => {
  const m = Math.round((Date.now() - (t || 0)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
const readFileAs = (file, how) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r[how](file);
  });
const chooseFile = (accept) =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });

/* ---------------- captures that arrive while Designer is closed (right-click → Capture Element in Designer) ---------------- */

const pending = [];
/** A capture from elsewhere in Leafdeck (the Site Editor's "Edit in Designer"): into Designer, opening it if needed. */
export function captureToDesigner(cap) {
  pending.push(cap);
  const w = openApp('designer');
  w?.designer?.takePending();
}
if (shell?.on) {
  shell.on('designer:capture-start', () => toast('Click the element to capture. ↑ ↓ choose its parent or child, Enter takes it, Esc cancels.'));
  shell.on('designer:captured', (r) => {
    if (r?.error) return toast(`Couldn’t capture that: ${r.error}`, 'error');
    if (!r?.cap) return;
    pending.push(r.cap);
    const w = openApp('designer');
    w?.designer?.takePending();
  });
}

registerApp({
  id: 'designer',
  name: 'Designer',
  icon: 'pen',
  color: 'purple',
  size: [1320, 820],
  min: [760, 480],
  mount(win) {
    let ed = null;
    let current = null; // { id, saved: Set(asset ids), mtime }
    let chat = null;
    let unlisten = null;
    let pendingTrace = null;
    let buildExists = false;
    let session = false;
    let thumbTimer = null;
    let tab = 'design';
    let icons = null; // the Icons panel
    let markTool = 'pen'; // the markup tool the toolbar's pen picks
    let markupSaid = ''; // the markup Claude was last told about
    let gfx = null; // Graphic Designer, when a graphic document is open
    let mode = (() => {
      try {
        return localStorage.getItem('designer:mode') === 'graphic' ? 'graphic' : 'ui';
      } catch {
        return 'ui';
      }
    })();
    shell?.info?.().then((i) => (session = !!i?.session)).catch(() => {});

    win.designer = {
      takePending: () => takePending(),
      open: (id) => openDesign(id),
      get editor() {
        return ed;
      },
      get graphic() {
        return gfx?.ed || null;
      },
    };
    // Window animations (opening, maximizing) move the canvas under the overlay: draw it again when they end.
    const redraw = () => ed?.drawOverlay();
    win.el.addEventListener('transitionend', redraw);
    win.el.addEventListener('animationend', redraw);
    win.cleanups.push(() => {
      saveNow();
      gfx?.save();
      gfx?.destroy();
      unlisten?.();
      chat?.destroy();
      ed?.destroy();
      shell?.designer?.focus(false);
    });

    /* ================= Home: your designs, templates, ways to capture ================= */

    async function home() {
      if (current) {
        await saveNow();
        await snapThumb();
      }
      if (gfx) await gfx.close();
      closeEditor();
      win.setTitle('Designer');
      if (mode === 'graphic') return graphicHome();
      win.tools.innerHTML = `<button class="tb-pill" data-h="folder" title="Open the designs folder" ${shell?.designer ? '' : 'hidden'}>${icon('folder', 12)} Folder</button>
        <button class="tb-pill primary" data-h="new">${icon('plus', 12)} New design</button>`;
      win.body.innerHTML = `<div class="dzh">
        ${modeSwitch()}
        <header class="dzh-hero">
          <div><h2>Design an element. Hand it to Claude.</h2>
          <p>Draw a button, a menu or an input field the way you would in Figma, or capture one from any window, with its real styles, states, images and fonts. Then Claude builds it.</p></div>
        </header>
        <div class="dzh-start">
          <button class="dzh-tile" data-h="new"><span>${glyph('frame', 22)}</span><b>Blank design</b><small>Start with an empty canvas</small></button>
          <button class="dzh-tile" data-h="capture"><span>${glyph('capture', 22)}</span><b>Capture from a window</b><small>Pick an element in any site or app</small></button>
          <button class="dzh-tile" data-h="screen"><span>${glyph('image', 22)}</span><b>Capture the screen</b><small>Anything else: a picture Claude can rebuild</small></button>
          <button class="dzh-tile" data-h="paste"><span>${glyph('code', 22)}</span><b>Paste</b><small>HTML, SVG, an image or copied layers</small></button>
          <button class="dzh-tile" data-h="bookmarklet"><span>${glyph('svg', 22)}</span><b>From another browser</b><small>A bookmarklet for Chrome, Edge, Firefox</small></button>
        </div>
        <h3>Start from</h3>
        <div class="dzh-templates">${templates.map((t) => `<button class="dzh-tpl" data-tpl="${t.id}"><span class="dzh-tpl-art" data-art="${t.id}"></span><b>${esc(t.label)}</b></button>`).join('')}</div>
        <h3>Your designs <small class="dzh-count"></small></h3>
        <div class="dzh-grid"><p class="dzh-muted">Loading…</p></div>
      </div>`;
      // Template previews, drawn from the templates themselves.
      for (const box of win.body.querySelectorAll('[data-art]')) {
        const frames = makeTemplate(box.dataset.art);
        const inner = document.createElement('div');
        inner.className = 'dzh-tpl-inner';
        inner.append(renderStatic([frames[0]]));
        box.append(inner);
        requestAnimationFrame(() => {
          const r = inner.firstElementChild?.getBoundingClientRect();
          const b = box.getBoundingClientRect();
          if (r?.width) inner.style.transform = `translate(-50%, -50%) scale(${Math.min(1, (b.width - 24) / r.width, (b.height - 20) / r.height)})`;
        });
      }
      let list = [];
      try {
        list = (await storage.list()).filter((d) => d.kind !== 'graphic');
      } catch (err) {
        toast(err.message, 'error');
      }
      const grid = $('.dzh-grid', win.body);
      if (!grid || mode !== 'ui') return;
      $('.dzh-count', win.body).textContent = list.length || '';
      grid.innerHTML = list.length
        ? list
            .map(
              (d) => `<button class="dzh-card" data-open="${d.id}">
            <span class="dzh-thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : glyph('component', 28)}</span>
            <b>${esc(d.name)}</b><small>${esc(ago(d.updatedAt))}${d.frames ? ` · ${d.frames} frame${d.frames === 1 ? '' : 's'}` : ''}</small></button>`,
            )
            .join('')
        : `<p class="dzh-muted">Nothing yet. Designs are saved ${shell?.designer ? 'in Documents › Leafdeck Designs, one folder each,' : 'in this browser'} as you work.</p>`;
    }

    const modeSwitch = () => `<nav class="dzh-modes" role="tablist" aria-label="Designer">
        <button type="button" role="tab" data-h="mode-ui" class="${mode === 'ui' ? 'on' : ''}">${glyph('frame', 15)} UI Designer</button>
        <button type="button" role="tab" data-h="mode-graphic" class="${mode === 'graphic' ? 'on' : ''}">${glyph('pen-tool', 15)} Graphic Designer</button>
      </nav>`;
    function setMode(m) {
      mode = m;
      try {
        localStorage.setItem('designer:mode', m);
      } catch {}
      home();
    }

    /** Graphic Designer's home: new documents by size, and your artwork. */
    async function graphicHome() {
      win.tools.innerHTML = `<button class="tb-pill" data-h="folder" title="Open the designs folder" ${shell?.designer ? '' : 'hidden'}>${icon('folder', 12)} Folder</button>
        <button class="tb-pill primary" data-h="gnew" data-size="1080x1080">${icon('plus', 12)} New artwork</button>`;
      const presets = GRAPHIC_PRESETS.filter(([n]) => !/landscape|Icon|Poster/.test(n));
      win.body.innerHTML = `<div class="dzh">
        ${modeSwitch()}
        <header class="dzh-hero">
          <div><h2>Draw logos, illustrations, posters and posts.</h2>
          <p>Vector artwork with the pen, shapes, type and gradients, on as many artboards as you need. Export PNG, JPG, SVG or PDF.</p></div>
        </header>
        <h3>New artwork</h3>
        <div class="dzh-start gx-sizes">
          ${presets.map(([n, w, h]) => `<button class="dzh-tile" data-h="gnew" data-size="${w}x${h}" data-name="${esc(n)}"><span class="gx-size-art"><i style="width:${Math.round((34 * w) / Math.max(w, h))}px;height:${Math.round((34 * h) / Math.max(w, h))}px"></i></span><b>${esc(n)}</b><small>${w} × ${h}</small></button>`).join('')}
          <button class="dzh-tile" data-h="gcustom"><span>${glyph('artboard', 22)}</span><b>Custom size</b><small>Any width and height</small></button>
          <button class="dzh-tile" data-h="gopen"><span>${glyph('svg', 22)}</span><b>Open an SVG</b><small>Edit any SVG file's paths</small></button>
        </div>
        <h3>Your artwork <small class="dzh-count"></small></h3>
        <div class="dzh-grid"><p class="dzh-muted">Loading…</p></div>
      </div>`;
      let list = [];
      try {
        list = (await storage.list()).filter((d) => d.kind === 'graphic');
      } catch (err) {
        toast(err.message, 'error');
      }
      const grid = $('.dzh-grid', win.body);
      if (!grid || mode !== 'graphic') return;
      $('.dzh-count', win.body).textContent = list.length || '';
      grid.innerHTML = list.length
        ? list
            .map(
              (d) => `<button class="dzh-card" data-open="${d.id}">
            <span class="dzh-thumb gx-thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : glyph('pen-tool', 28)}</span>
            <b>${esc(d.name)}</b><small>${esc(ago(d.updatedAt))}${d.frames > 1 ? ` · ${d.frames} artboards` : ''}</small></button>`,
            )
            .join('')
        : `<p class="dzh-muted">Nothing yet. Artwork is saved ${shell?.designer ? 'in Documents › Leafdeck Designs' : 'in this browser'} as you work.</p>`;
    }
    async function newGraphic({ w = 1080, h = 1080, name = 'Untitled artwork', svg = null } = {}) {
      const id = uid().replace(/[^a-z0-9]/g, '');
      const doc = newGraphicDoc(id, { name, w, h });
      await storage.write(id, doc, {}, []);
      await openDesign(id);
      if (svg && gfx) {
        gfx.ed.importSvgText(svg, { at: null, name });
        // The artboard takes the drawing's size.
        gfx.ed.boardFitArt(gfx.ed.doc.artboards[0].id);
        gfx.ed.fit();
      }
    }
    async function customSize() {
      const r = await ask({ title: 'New artwork', win, fields: [{ name: 'w', label: 'Width (px)', value: '1200' }, { name: 'h', label: 'Height (px)', value: '800' }], buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
      const w = Math.round(parseFloat(r?.values?.w));
      const h = Math.round(parseFloat(r?.values?.h));
      if (r && w > 0 && h > 0) newGraphic({ w: Math.min(w, 20000), h: Math.min(h, 20000) });
    }
    async function openSvgFile() {
      const f = await chooseFile('.svg,image/svg+xml');
      if (!f) return;
      newGraphic({ name: f.name.replace(/\.svg$/i, ''), svg: await readFileAs(f, 'readAsText') });
    }

    win.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-h], [data-tpl], [data-open]');
      if (!b || ed || gfx) return;
      if (b.dataset.open) return openDesign(b.dataset.open);
      if (b.dataset.h === 'mode-ui' || b.dataset.h === 'mode-graphic') return setMode(b.dataset.h.slice(5));
      if (b.dataset.h === 'gnew') {
        const [w, h] = b.dataset.size.split('x').map(Number);
        return newGraphic({ w, h, name: b.dataset.name ? `Untitled ${b.dataset.name.toLowerCase()}` : 'Untitled artwork' });
      }
      if (b.dataset.h === 'gcustom') return customSize();
      if (b.dataset.h === 'gopen') return openSvgFile();
      if (b.dataset.tpl) return newDesign({ template: b.dataset.tpl });
      const act = b.dataset.h;
      if (act === 'new') return newDesign();
      if (act === 'capture') return newDesign({ then: (anchor) => captureMenu(anchor) });
      if (act === 'screen') return newDesign({ then: () => captureScreen() });
      if (act === 'paste') return newDesign({ then: () => pasteNow() });
      if (act === 'bookmarklet') return bookmarkletDialog();
    });
    win.body.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('[data-open]');
      if (!card || ed || gfx) return;
      e.preventDefault();
      const id = card.dataset.open;
      showMenu(e.clientX, e.clientY, [
        { label: 'Open', act: () => openDesign(id) },
        { label: 'Duplicate', act: () => duplicateDesign(id) },
        shell?.designer ? { label: 'Show in Folder', act: () => revealDesign(id) } : null,
        '-',
        { label: 'Delete…', act: () => deleteDesign(id) },
      ]);
    });
    win.tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-h]');
      if (!b) return;
      if (b.dataset.h === 'gnew') return newGraphic();
      if (b.dataset.h === 'new') newDesign();
      if (b.dataset.h === 'folder') revealDesign(null);
    });

    async function revealDesign(id) {
      try {
        if (session || shell.platform === 'linux') {
          const dir = await shell.designer.dir(id);
          openApp('files', { reveal: dir });
        } else await shell.designer.openFolder(id);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    async function deleteDesign(id) {
      if (!(await confirmDialog('Delete this design?', { title: 'Delete design', ok: 'Delete', danger: true, win, detail: shell?.designer ? 'Its folder goes to the Trash.' : '' }))) return;
      await storage.remove(id);
      home();
    }
    async function duplicateDesign(id) {
      const { doc, assets } = await storage.read(id);
      const nid = uid().replace(/[^a-z0-9]/g, '');
      await storage.write(nid, { ...doc, id: nid, name: doc.name + ' copy', updatedAt: Date.now() }, assets, Object.keys(assets));
      home();
    }

    async function newDesign({ template = null, then = null } = {}) {
      const id = uid().replace(/[^a-z0-9]/g, '');
      const tpl = template ? templates.find((t) => t.id === template) : null;
      const doc = { id, name: tpl ? tpl.label : 'Untitled design', nodes: [], assets: {}, fonts: [], meta: {}, createdAt: Date.now(), updatedAt: Date.now() };
      await storage.write(id, { ...doc, assets: undefined }, {}, []);
      await openDesign(id);
      if (template) insertTemplate(template, { fit: true });
      if (then) then($('[data-t="capture"]', win.tools));
    }

    /* ================= the editor ================= */

    function closeEditor() {
      gfx?.destroy();
      gfx = null;
      unlisten?.();
      unlisten = null;
      chat?.destroy();
      chat = null;
      ed?.destroy();
      ed = null;
      icons = null;
      markupSaid = '';
      current = null;
      pendingTrace = null;
      shell?.designer?.focus(false);
    }

    async function openDesign(id) {
      let data;
      try {
        data = await storage.read(id);
      } catch (err) {
        toast(`Couldn’t open that design: ${err.message}`, 'error');
        return home();
      }
      closeEditor();
      if (data.doc?.kind === 'graphic') {
        if (mode !== 'graphic') {
          mode = 'graphic';
          try {
            localStorage.setItem('designer:mode', mode);
          } catch {}
        }
        gfx = mountGraphic(win, { id, doc: data.doc, assets: data.assets || {}, storage, toast, home: () => home(), chooseFile, readFileAs });
        return;
      }
      const doc = { ...data.doc, id, assets: data.assets || {} };
      current = { id, saved: new Set(Object.keys(data.assets || {})), mtime: data.mtime || 0 };
      win.setTitle(doc.name);
      win.tools.innerHTML = `<button class="tb-btn" data-t="home" title="All designs">${icon('grid', 15)}</button>
        <button class="tb-btn" data-t="left" title="Show or hide Layers (Ctrl+Alt+[)">${glyph('panel-left', 16)}</button>
        <input class="dz-name" value="${esc(doc.name)}" spellcheck="false" aria-label="Design name">
        <span class="grow"></span>
        <button class="tb-btn" data-t="undo" title="Undo (Ctrl+Z)">${glyph('undo', 16)}</button>
        <button class="tb-btn" data-t="redo" title="Redo (Ctrl+Shift+Z)">${glyph('redo', 16)}</button>
        <button class="tb-pill" data-t="capture" title="Capture an element (C)">${glyph('capture', 13)} Capture</button>
        <button class="tb-pill" data-t="insert" title="Insert an icon or a template">${icon('plus', 12)} Insert</button>
        <button class="tb-pill dz-zoom" data-t="zoom" title="Zoom">100%</button>
        <button class="tb-btn" data-t="right" title="Show or hide the side panel (Ctrl+Alt+])">${glyph('panel-right', 16)}</button>`;
      win.body.innerHTML = `<div class="dz">
        <aside class="dz-left"><div class="dz-left-head"><span>Layers</span><span class="grow"></span><button type="button" class="dzi-icon" data-panel="left" title="Hide Layers (Ctrl+Alt+[)">${glyph('panel-left', 14)}</button></div><div class="dz-layers"></div></aside>
        <div class="dz-split" data-split="left" title="Drag to resize"></div>
        <section class="dz-center">
          <div class="dz-canvas"></div>
          <div class="dz-toolbar" role="toolbar" aria-label="Tools">
            ${[['move', 'move', 'Move (V)'], ['hand', 'hand', 'Hand (H, or hold Space)'], '|', ['frame', 'frame', 'Frame (F)'], ['rect', 'rect', 'Rectangle (R)'], ['ellipse', 'ellipse', 'Ellipse (O)'], ['text', 'text', 'Text (T)'], '|', ['icons', 'icons', 'Icons (I)'], ['image', 'image', 'Image or SVG…'], '|', ['markup', 'pen', 'Markup: draw on the design to show Claude what you mean (P)'], ['capture', 'capture', 'Capture an element (C)']]
              .map((t) => (t === '|' ? '<i></i>' : `<button type="button" data-tool="${t[0]}" title="${esc(t[2])}">${glyph(t[1], 18)}</button>`))
              .join('')}
          </div>
          <div class="dz-markbar" role="toolbar" aria-label="Markup" hidden>
            ${[['pen', 'Pen (P)'], ['line', 'Line (L)'], ['arrow', 'Arrow (Shift+L)'], ['box', 'Box (B)'], ['note', 'Note (N)'], ['eraser', 'Eraser']].map(([t, label]) => `<button type="button" data-mtool="${t}" title="${label}">${glyph(t, 16)}</button>`).join('')}
            <i></i>
            ${MARK_COLORS.map((c) => `<button type="button" class="dz-mcolor" data-mcolor="${c}" style="--c:${c}" title="Color"></button>`).join('')}
            <i></i>
            <button type="button" data-mact="show" title="Hide the markup">${glyph('eye', 16)}</button>
            <button type="button" data-mact="clear" title="Clear all markup">${glyph('trash', 16)}</button>
            <button type="button" data-mact="done" class="dz-mdone">Done</button>
          </div>
          <div class="dz-banner" hidden><span></span><button class="btn small" data-cancel-pick>Cancel</button></div>
          <div class="dz-drop-hint" hidden>Drop images, SVG or HTML files</div>
          <div class="dz-big" hidden><header><b></b><span class="grow"></span><button class="btn small" data-big-close>Close</button></header><iframe title="Preview"></iframe></div>
        </section>
        <div class="dz-split" data-split="right" title="Drag to resize"></div>
        <aside class="dz-right">
          <div class="dz-tabs" role="tablist">
            <button type="button" data-tab="design">Design</button>
            <button type="button" data-tab="build">Build</button>
            ${shell?.agentChat ? `<button type="button" data-tab="claude">${glyph('claude', 13)} Claude</button>` : ''}
            <span class="grow"></span>
            <button type="button" class="dzi-icon" data-panel="right" title="Hide the side panel (Ctrl+Alt+])">${glyph('panel-right', 14)}</button>
          </div>
          <div class="dz-pane" data-pane="design"></div>
          <div class="dz-pane" data-pane="build" hidden></div>
          <div class="dz-pane dz-chat" data-pane="claude" hidden></div>
        </aside>
      </div>`;
      applyPanelWidths();
      const canvas = $('.dz-canvas', win.body);
      ed = createEditor(canvas, { nativePaste: !shell?.designer, onFocus: (f) => shell?.designer?.focus(f) });
      createLayers($('.dz-layers', win.body), ed);
      createInspector($('[data-pane="design"]', win.body), ed, {
        toast,
        chooseImage: async () => {
          const f = await chooseFile('image/*');
          return f ? readFileAs(f, 'readAsDataURL') : null;
        },
        editSvg,
        trace: (n) => trace(n),
        canTrace: !!shell?.agentChat,
        swapIcon: (n) => icons?.open({ swap: n }),
      });
      icons = createIconPicker($('.dz-center', win.body), { insert: (ic, o, swap) => insertIcon(ic, o, swap), onClose: () => (drawChrome(), ed?.viewport.focus({ preventScroll: true })) });
      const handoff = createHandoff($('[data-pane="build"]', win.body), ed, {
        win,
        files: !!shell?.designer,
        canBuild: !!shell?.agentChat,
        toast,
        build: (comp, o) => buildWithClaude(comp, o),
        sendToSite: (comp) => sendToSite(comp),
        writeHandoff: (comp, o) => writeHandoff(comp, o),
        buildUrl: () => (buildExists && shell?.designer ? `leafdesign://${current.id}/build/index.html?t=${Date.now()}` : null),
        expand: (o) => expandPreview(o),
      });
      current.handoff = handoff;
      ed.on('change', () => {
        scheduleSave();
        drawChrome();
      });
      ed.on('view', () => {
        scheduleSave();
        drawChrome();
      });
      ed.on('tool', (t) => {
        if (MARK_TOOLS.includes(t)) markTool = t;
        drawChrome();
      });
      ed.on('marks', drawChrome);
      ed.on('select', drawChrome);
      ed.on('paste-request', ({ here }) => pasteNow({ here }));
      ed.on('capture', () => captureMenu($('[data-tool="capture"]', win.body)));
      ed.on('copied', (n) => toast(`Copied ${n} layer${n === 1 ? '' : 's'}`));
      ed.on('captured', ({ states, host }) => toast(`Captured${host ? ' from ' + host : ''}${states.length ? ` with ${states.length} state${states.length === 1 ? '' : 's'} (${states.map((s) => s.variant.state).join(', ')})` : ''}. The original is below it.`));
      ed.load(doc);
      applyCanvasColor();
      setTab(tab === 'claude' && !shell?.agentChat ? 'design' : tab);
      drawChrome();
      ed.viewport.focus({ preventScroll: true });
      // Claude can change design.json and build things: look when it finishes a turn.
      if (shell?.agentChat) unlisten = listen('@design:' + id, (ev) => ev.t === 'done' && afterClaude());
      checkBuild();
      takePending();
    }

    /* ----- panel widths (drag the edges) and the big preview ----- */

    const PANELS = 'designer:panels';
    const panelPrefs = () => {
      try {
        return JSON.parse(localStorage.getItem(PANELS)) || {};
      } catch {
        return {};
      }
    };
    function applyPanelWidths() {
      const w = panelPrefs();
      if (w.left) $('.dz-left', win.body).style.width = w.left + 'px';
      if (w.right) $('.dz-right', win.body).style.width = w.right + 'px';
      $('.dz', win.body).classList.toggle('hide-left', !!w.hideLeft);
      $('.dz', win.body).classList.toggle('hide-right', !!w.hideRight);
    }
    /** Collapse or bring back Layers ('left') or the Design / Build / Claude panel ('right'); remembered. */
    function togglePanel(side, hide) {
      const dz = $('.dz', win.body);
      if (!dz) return;
      hide ??= !dz.classList.contains('hide-' + side);
      dz.classList.toggle('hide-' + side, hide);
      try {
        localStorage.setItem(PANELS, JSON.stringify({ ...panelPrefs(), [side === 'left' ? 'hideLeft' : 'hideRight']: hide }));
      } catch {}
      if (!hide && side === 'right' && tab === 'claude') chat?.focus();
      drawChrome();
    }
    win.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-panel]');
      if (b && ed) togglePanel(b.dataset.panel, true);
    });
    win.body.addEventListener('pointerdown', (e) => {
      const sp = e.target.closest('[data-split]');
      if (!sp || !ed) return;
      const side = sp.dataset.split;
      const panel = $(side === 'left' ? '.dz-left' : '.dz-right', win.body);
      const w0 = panel.getBoundingClientRect().width;
      const x0 = e.clientX;
      sp.setPointerCapture(e.pointerId);
      document.body.classList.add('dz-resizing');
      const move = (ev) => {
        const w = Math.max(side === 'left' ? 180 : 240, Math.min(side === 'left' ? 420 : 640, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0)));
        panel.style.width = w + 'px';
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        document.body.classList.remove('dz-resizing');
        ed?.drawOverlay();
        try {
          const saved = JSON.parse(localStorage.getItem(PANELS) || '{}');
          saved[side] = Math.round(panel.getBoundingClientRect().width);
          localStorage.setItem(PANELS, JSON.stringify(saved));
        } catch {}
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    /** The Build tab's preview, big, over the canvas. */
    function expandPreview({ title, src, srcdoc }) {
      const big = $('.dz-big', win.body);
      if (!big) return;
      const old = $('iframe', big);
      const frame = document.createElement('iframe');
      frame.title = 'Preview';
      if (src) {
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups');
        frame.src = src;
      } else {
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.srcdoc = srcdoc;
      }
      old.replaceWith(frame);
      $('header b', big).textContent = title;
      big.hidden = false;
    }
    win.body.addEventListener('click', (e) => {
      if (e.target.closest('[data-big-close]')) $('.dz-big', win.body).hidden = true;
    });

    function drawChrome() {
      if (!ed) return;
      const marking = MARK_TOOLS.includes(ed.tool);
      win.body.querySelectorAll('.dz-toolbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === ed.tool || (b.dataset.tool === 'markup' && marking) || (b.dataset.tool === 'icons' && !!icons?.isOpen)));
      const mb = $('.dz-markbar', win.body);
      if (mb) {
        mb.hidden = !marking;
        mb.querySelectorAll('[data-mtool]').forEach((b) => b.classList.toggle('on', b.dataset.mtool === ed.tool));
        mb.querySelectorAll('[data-mcolor]').forEach((b) => b.classList.toggle('on', b.dataset.mcolor === ed.marks.color));
        const show = $('[data-mact="show"]', mb);
        show.innerHTML = glyph(ed.marks.shown ? 'eye' : 'eye-off', 16);
        show.title = ed.marks.shown ? 'Hide the markup (Claude won’t see it either)' : 'Show the markup';
        $('[data-mact="clear"]', mb).disabled = !ed.doc.marks.length;
      }
      const dz = $('.dz', win.body);
      $('[data-t="left"]', win.tools)?.classList.toggle('on', !!dz && !dz.classList.contains('hide-left'));
      $('[data-t="right"]', win.tools)?.classList.toggle('on', !!dz && !dz.classList.contains('hide-right'));
      const z = $('.dz-zoom', win.tools);
      if (z) z.textContent = Math.round(ed.view.z * 100) + '%';
      const u = $('[data-t="undo"]', win.tools);
      if (u) u.disabled = !ed.canUndo;
      const r = $('[data-t="redo"]', win.tools);
      if (r) r.disabled = !ed.canRedo;
      applyCanvasColor();
    }
    const applyCanvasColor = () => {
      const c = $('.dz-viewport', win.body);
      if (c) c.style.backgroundColor = ed?.doc.canvas || '';
    };

    function setTab(t) {
      tab = t;
      win.body.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      win.body.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t));
      if (t === 'build') current?.handoff.render();
      if (t === 'claude') ensureChat()?.focus();
    }

    win.tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b || !ed) return;
      const t = b.dataset.t;
      if (t === 'home') return home();
      if (t === 'left' || t === 'right') return togglePanel(t);
      if (t === 'undo') return ed.undo();
      if (t === 'redo') return ed.redo();
      if (t === 'capture') return captureMenu(b);
      if (t === 'insert') return insertMenu(b);
      if (t === 'zoom') {
        const r = b.getBoundingClientRect();
        return showMenu(r.left, r.bottom + 4, [
          { label: 'Zoom in', key: 'Ctrl +', act: () => ed.zoomTo(ed.view.z * 1.5) },
          { label: 'Zoom out', key: 'Ctrl −', act: () => ed.zoomTo(ed.view.z / 1.5) },
          '-',
          { label: 'Zoom to fit', key: 'Shift+1', act: () => ed.fit() },
          { label: 'Zoom to selection', key: 'Shift+2', act: () => ed.fit(ed.sel, { max: 8 }), disabled: !ed.sel.length },
          '-',
          { label: '50%', act: () => ed.zoomTo(0.5) },
          { label: '100%', key: 'Shift+0', act: () => ed.zoomTo(1) },
          { label: '200%', act: () => ed.zoomTo(2) },
          { label: '400%', act: () => ed.zoomTo(4) },
        ]);
      }
    });
    win.tools.addEventListener('change', (e) => {
      if (!e.target.matches('.dz-name') || !ed) return;
      const v = e.target.value.trim() || 'Untitled design';
      ed.checkpoint();
      ed.doc.name = v;
      win.setTitle(v);
      ed.commit({ quiet: true });
    });
    win.tools.addEventListener('keydown', (e) => {
      if (e.target.matches('.dz-name') && e.key === 'Enter') ed?.viewport.focus();
    });

    win.body.addEventListener('click', (e) => {
      if (!ed) return;
      const tb = e.target.closest('.dz-toolbar [data-tool]');
      if (tb) {
        const t = tb.dataset.tool;
        if (t === 'image') return importFile();
        if (t === 'capture') return captureMenu(tb);
        if (t === 'icons') return icons.toggle(), drawChrome();
        ed.setTool(t === 'markup' ? (MARK_TOOLS.includes(ed.tool) ? 'move' : markTool) : t);
        return ed.viewport.focus();
      }
      const mb = e.target.closest('[data-mtool], [data-mcolor], [data-mact]');
      if (mb) {
        if (mb.dataset.mtool) ed.setTool(mb.dataset.mtool);
        if (mb.dataset.mcolor) ed.marks.color = mb.dataset.mcolor;
        if (mb.dataset.mact === 'show') ed.marks.shown = !ed.marks.shown;
        if (mb.dataset.mact === 'done') ed.setTool('move');
        if (mb.dataset.mact === 'clear') {
          ed.marks.clear();
          toast('Markup cleared', '', { label: 'Undo', act: () => ed?.undo() });
        }
        return ed.viewport.focus();
      }
      const tabB = e.target.closest('[data-tab]');
      if (tabB) return setTab(tabB.dataset.tab);
      if (e.target.closest('[data-cancel-pick]')) return cancelPick();
    });

    win.body.addEventListener('keydown', (e) => {
      if (!ed) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        return togglePanel(e.code === 'BracketLeft' ? 'left' : 'right');
      }
      if (ctrl && !e.altKey && e.code === 'Backslash') {
        // Both panels: hide them for a canvas-only view, or bring them back.
        e.preventDefault();
        const dz = $('.dz', win.body);
        const hide = !(dz.classList.contains('hide-left') && dz.classList.contains('hide-right'));
        togglePanel('left', hide);
        return togglePanel('right', hide);
      }
      if (e.target === ed.viewport && !ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        icons.open();
        drawChrome();
      }
    });

    /* ----- icons ----- */

    const iconNode = (ic, { svg, size, color, stroke }, frame = null) =>
      makeNode('svg', { name: ic.name, markup: svgSize(svg).markup, w: size, h: size, color: color || textColorIn(frame), icon: { set: ic.set, name: ic.name, stroke } });
    /** Auto color: the color of the text in the frame an icon goes into (a button's label), or near-black. */
    function textColorIn(frame) {
      for (const n of frame?.children || []) {
        if (n.type === 'text' && n.font?.color) return n.font.color;
        if (n.type === 'svg' && n.icon && n.color) return n.color;
      }
      for (const n of frame?.children || []) {
        const c = n.type === 'frame' && textColorIn(n);
        if (c && c !== '#1d1f1e') return c;
      }
      return '#1d1f1e';
    }
    /**
     * Put an icon in: into the selected frame, beside the selected layer in its frame, or in the middle of the view.
     * `swap`: a layer whose icon this one replaces (same size and color).
     */
    function insertIcon(ic, o, swap = null) {
      if (!ed) return;
      const old = swap && ed.node(swap.id);
      if (old) {
        ed.checkpoint();
        if (!old.icon || old.name === old.icon.name) old.name = ic.name;
        old.markup = svgSize(o.svg).markup;
        old.icon = { set: ic.set, name: ic.name, stroke: o.stroke };
        return ed.commit();
      }
      const one = ed.sel.length === 1 ? ed.node(ed.sel[0]) : null;
      if (one?.type === 'frame' && !one.locked) return ed.insert([iconNode(ic, o, one)], { into: one.id });
      const parent = one && ed.parentOf(one.id);
      const n = iconNode(ic, o, parent);
      if (parent && !parent.locked) {
        if (!layoutOf(parent)) Object.assign(n, { x: Math.round(one.x + one.w + 8), y: Math.round(one.y + (one.h - n.h) / 2) });
        return ed.insert([n], { into: parent.id, index: parent.children.indexOf(one) + 1, keepPositions: true });
      }
      const vr = ed.viewport.getBoundingClientRect();
      const c = ed.toWorld(vr.left + vr.width / 2, vr.top + vr.height / 2);
      ed.insert([n], { into: null, at: { x: Math.round(c.x - n.w / 2), y: Math.round(c.y - n.h / 2) } });
    }
    /** An icon dragged from the Icons panel: where it's dropped, in the frame under it. */
    function dropIcon(d, clientX, clientY) {
      const w = ed.toWorld(clientX, clientY);
      const into = ed.frameAt(clientX, clientY);
      const n = iconNode(d, d, into && ed.node(into));
      n.x = Math.round(w.x - n.w / 2);
      n.y = Math.round(w.y - n.h / 2);
      if (!into) return ed.insert([n], { into: null, at: { x: n.x, y: n.y } });
      const r = ed.worldRect(into);
      n.x -= Math.round(r.x);
      n.y -= Math.round(r.y);
      ed.insert([n], { into, keepPositions: true });
    }

    /* ----- drop files onto the canvas ----- */

    win.body.addEventListener('dragover', (e) => {
      if (ed && e.dataTransfer?.types.includes(ICON_MIME) && e.target.closest('.dz-viewport')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        return;
      }
      if (!ed || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      $('.dz-drop-hint', win.body).hidden = false;
    });
    win.body.addEventListener('dragleave', (e) => {
      if (ed && !win.body.contains(e.relatedTarget)) $('.dz-drop-hint', win.body).hidden = true;
    });
    win.body.addEventListener('drop', async (e) => {
      if (ed && e.dataTransfer?.types.includes(ICON_MIME)) {
        e.preventDefault();
        try {
          dropIcon(JSON.parse(e.dataTransfer.getData(ICON_MIME)), e.clientX, e.clientY);
        } catch (err) {
          toast(err.message, 'error');
        }
        return ed.viewport.focus();
      }
      if (!ed || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      $('.dz-drop-hint', win.body).hidden = true;
      const vr = ed.viewport.getBoundingClientRect();
      const v = ed.view;
      const point = { x: (e.clientX - vr.left - v.x) / v.z, y: (e.clientY - vr.top - v.y) / v.z };
      for (const f of e.dataTransfer.files) await importOne(f, point).catch((err) => toast(err.message, 'error'));
    });

    async function importOne(f, point = null) {
      if (/svg/.test(f.type) || /\.svg$/i.test(f.name)) return ed.importSvg(await readFileAs(f, 'readAsText'), { point, name: f.name.replace(/\.\w+$/, '') });
      if (/^image\//.test(f.type)) return ed.importImage(await readFileAs(f, 'readAsDataURL'), { point, name: f.name.replace(/\.\w+$/, '') });
      if (/html?$/i.test(f.name) || f.type === 'text/html') {
        const cap = await captureHtml(await readFileAs(f, 'readAsText'));
        return ed.importCapture(cap, { at: point, name: f.name.replace(/\.\w+$/, '') });
      }
      throw new Error(`${f.name}: Designer takes images, SVG and HTML files`);
    }
    async function importFile() {
      const f = await chooseFile('image/*,.svg,.html,.htm');
      if (f) await importOne(f).catch((err) => toast(err.message, 'error'));
    }

    /* ----- templates ----- */

    function insertMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'Icon…', key: 'I', act: () => (icons.open(), drawChrome()) },
        { label: 'Image or SVG…', act: () => importFile() },
        '-',
        { header: 'Start from' },
        ...templates.map((t) => ({ label: t.label, act: () => insertTemplate(t.id, { fit: true }) })),
      ]);
    }
    function insertTemplate(id, { fit = false } = {}) {
      const frames = makeTemplate(id);
      let x = 0;
      for (const f of frames) {
        f.x = x;
        f.y = 0;
        x += Math.max(f.w, 60) + 40;
      }
      ed.insert(frames, { into: null });
      ed.select([frames[0].id]);
      if (fit) requestAnimationFrame(() => ed.fit(frames.map((f) => f.id), { max: 2 }));
    }

    /* ================= capturing ================= */

    /** The windows you can pick an element in: sites, apps you built, and Leafdeck itself. */
    function captureMenu(anchor) {
      if (!ed) return;
      const items = [{ header: 'Pick an element in' }];
      for (const w of wins.values()) {
        if (w.id === 'designer') continue;
        const wv = w.el.querySelector('webview');
        if (!wv) continue;
        const title = $('.win-title-text', w.el)?.textContent || w.app.name;
        items.push({ label: title.length > 48 ? title.slice(0, 47) + '…' : title, act: () => pickIn(w, wv) });
      }
      if (items.length === 1) items.push({ label: 'No site windows are open', disabled: true });
      items.push({ label: 'Leafdeck itself (its own interface)', act: () => pickIn(null) }, '-');
      items.push(
        { label: 'Capture the Screen…', act: () => captureScreen() },
        { label: 'Paste', key: 'Ctrl+V', act: () => pasteNow() },
        { label: 'From Another Browser…', act: () => bookmarkletDialog() },
        { label: 'Import a File…', act: () => importFile() },
      );
      const r = (anchor || win.el).getBoundingClientRect();
      showMenu(r.left, anchor ? r.bottom + 4 : r.top + 40, items);
    }

    let picking = false;
    function banner(text) {
      const b = $('.dz-banner', win.body);
      if (!b) return;
      b.hidden = !text;
      if (text) $('span', b).textContent = text;
    }
    function cancelPick() {
      shell?.designer?.cancel();
      inPage('cancel');
    }

    async function pickIn(w, webview) {
      if (picking) return cancelPick();
      picking = true;
      const where = w ? $('.win-title-text', w.el)?.textContent || 'that window' : 'Leafdeck';
      banner(`Click an element in ${where}. ↑ ↓ choose its parent or child · Enter captures · Esc cancels`);
      toast(`Click an element in ${where}. Esc cancels.`);
      try {
        let cap;
        if (shell?.designer) {
          let wcId = 0;
          if (w) {
            openApp(w.id);
            wcId = webview.getWebContentsId();
            webview.focus();
          }
          cap = await shell.designer.pick(wcId, { exclude: w ? null : '.win[data-app="designer"]' });
        } else {
          // In a browser tab: only Leafdeck's own page can be picked, without states or fetched images.
          cap = await inPage('pick', { exclude: win.el });
        }
        if (wins.get('designer') !== win) return; // Designer was closed meanwhile
        openApp('designer');
        if (cap && ed) {
          ed.importCapture(cap);
          ed.viewport.focus();
        }
      } catch (err) {
        if (wins.get('designer') === win) openApp('designer');
        toast(`Couldn’t capture that: ${err.message}`, 'error');
      } finally {
        picking = false;
        banner(null);
      }
    }

    function takePending() {
      if (!pending.length) return;
      if (!ed) {
        const cap = pending[0];
        let host = '';
        try {
          host = new URL(cap.url).hostname.replace(/^www\./, '');
        } catch {}
        return newDesign({ then: () => {} }).then(() => {
          ed.doc.name = host ? `From ${host}` : 'Captured element';
          $('.dz-name', win.tools).value = ed.doc.name;
          win.setTitle(ed.doc.name);
          takePending();
        });
      }
      while (pending.length) {
        try {
          ed.importCapture(pending.shift());
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    }

    /** Anything on screen, as a picture (Claude can rebuild it as layers). */
    async function captureScreen() {
      if (!shell?.designer) return toast('Capturing the screen needs the Leafdeck app.');
      let res;
      try {
        if (session) {
          // Leafdeck OS: the whole screen, without Designer in the way.
          minimize(win);
          await sleep(450);
          res = await shell.designer.screen().finally(() => openApp('designer'));
        } else res = await shell.designer.screen();
      } catch (err) {
        return toast(`Couldn’t capture the screen: ${err.message}`, 'error');
      }
      let image = res.image;
      if (res.kind === 'sources') {
        image = await chooseSource(res.sources);
        if (!image) return;
      }
      const cropped = await cropDialog(image);
      if (!cropped) return;
      const [n] = await ed.importImage(cropped.url, { name: 'Screen capture', density: cropped.density, into: null });
      if (n && shell?.agentChat) toast('Captured. Select it and choose “Rebuild as layers with Claude” to make it editable.');
    }

    function chooseSource(sources) {
      return new Promise((resolve) => {
        const body = document.createElement('div');
        body.className = 'dz-sources';
        body.innerHTML = sources.map((s, i) => `<button type="button" data-i="${i}"><img src="${esc(s.image)}" alt=""><span>${s.icon ? `<img src="${esc(s.icon)}" alt="">` : ''}${esc(s.name)}</span></button>`).join('');
        let chosen = null;
        ask({
          title: 'Capture a window',
          message: 'Choose a window or a screen. Next, you can select part of it.',
          body,
          wide: true,
          win,
          buttons: [{ label: 'Cancel', value: null }],
          onMount(api) {
            body.addEventListener('click', (e) => {
              const b = e.target.closest('[data-i]');
              if (!b) return;
              chosen = sources[+b.dataset.i].image;
              api.close({ button: 'ok' });
            });
          },
        }).then(() => resolve(chosen));
      });
    }

    /** Select part of a picture. Resolves { url, density } or null. */
    function cropDialog(src) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'dz-crop';
        wrap.innerHTML = `<div class="dz-crop-stage"><img alt="" draggable="false"><div class="dz-crop-sel" hidden></div></div>
          <div class="dz-crop-bar"><span>Drag to select the element</span><span class="grow"></span>
          <button class="btn small" data-c="cancel">Cancel</button><button class="btn small" data-c="all">Whole picture</button><button class="btn small primary" data-c="ok" disabled>Capture selection</button></div>`;
        win.el.append(wrap);
        const img = $('img', wrap);
        const selEl = $('.dz-crop-sel', wrap);
        const stage = $('.dz-crop-stage', wrap);
        let r = null;
        img.src = src;
        const finish = (rect) => {
          wrap.remove();
          if (!rect) return resolve(null);
          const scale = img.naturalWidth / img.getBoundingClientRect().width;
          const c = document.createElement('canvas');
          const full = rect === 'all';
          const sx = full ? 0 : Math.round(rect.x * scale);
          const sy = full ? 0 : Math.round(rect.y * scale);
          c.width = full ? img.naturalWidth : Math.max(1, Math.round(rect.w * scale));
          c.height = full ? img.naturalHeight : Math.max(1, Math.round(rect.h * scale));
          c.getContext('2d').drawImage(img, sx, sy, c.width, c.height, 0, 0, c.width, c.height);
          resolve({ url: c.toDataURL('image/png'), density: session ? devicePixelRatio : 1 });
        };
        stage.addEventListener('pointerdown', (e) => {
          const b = img.getBoundingClientRect();
          const x0 = e.clientX - b.left;
          const y0 = e.clientY - b.top;
          stage.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const x1 = Math.max(0, Math.min(b.width, ev.clientX - b.left));
            const y1 = Math.max(0, Math.min(b.height, ev.clientY - b.top));
            r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
            Object.assign(selEl.style, { left: img.offsetLeft + r.x + 'px', top: img.offsetTop + r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
            selEl.hidden = false;
            $('[data-c="ok"]', wrap).disabled = r.w < 3 || r.h < 3;
          };
          const up = () => {
            stage.removeEventListener('pointermove', move);
            stage.removeEventListener('pointerup', up);
          };
          stage.addEventListener('pointermove', move);
          stage.addEventListener('pointerup', up);
        });
        wrap.addEventListener('click', (e) => {
          const c = e.target.closest('[data-c]')?.dataset.c;
          if (c === 'cancel') finish(null);
          if (c === 'all') finish('all');
          if (c === 'ok' && r) finish(r);
        });
        wrap.addEventListener('keydown', (e) => e.key === 'Escape' && finish(null));
        wrap.tabIndex = -1;
        wrap.focus();
      });
    }

    /* ----- the clipboard ----- */

    async function pasteNow({ here = false } = {}) {
      if (!ed) return;
      let data = { text: '', html: '', image: null };
      try {
        if (shell?.designer) data = await shell.designer.clipboard();
        else {
          for (const item of await navigator.clipboard.read()) {
            if (item.types.includes('text/plain')) data.text = await (await item.getType('text/plain')).text();
            if (item.types.includes('text/html')) data.html = await (await item.getType('text/html')).text();
            const imgType = item.types.find((t) => t.startsWith('image/'));
            if (imgType) data.image = await readFileAs(await item.getType(imgType), 'readAsDataURL');
          }
        }
      } catch {
        return toast('Couldn’t read the clipboard', 'error');
      }
      try {
        const added = await ed.paste(data, { here });
        if (!added?.length) toast('Nothing to paste: copy an element, HTML, SVG or an image first.');
      } catch (err) {
        toast(`Couldn’t paste that: ${err.message}`, 'error');
      }
    }
    // In a browser tab the page's own paste event carries the clipboard.
    win.body.addEventListener('paste', async (e) => {
      if (!ed || shell?.designer || e.target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      e.preventDefault();
      const cd = e.clipboardData;
      const file = [...(cd.files || [])].find((f) => f.type.startsWith('image/'));
      const data = { text: cd.getData('text/plain'), html: cd.getData('text/html'), image: file ? await readFileAs(file, 'readAsDataURL') : null };
      ed.paste(data).catch((err) => toast(err.message, 'error'));
    });

    function bookmarkletDialog() {
      const href = bookmarklet();
      const body = document.createElement('div');
      body.className = 'dz-bm';
      body.innerHTML = `<ol>
          <li>Show the bookmarks bar in your other browser (Ctrl+Shift+B in Chrome and Edge).</li>
          <li>Drag this button onto it: <a class="btn primary small" href="${esc(href)}" draggable="true" data-bm>${glyph('capture', 13)} Capture for Leafdeck</a></li>
          <li>On any site, click the bookmark, then click the element you want. It’s copied.</li>
          <li>Back in Designer, press <kbd>Ctrl+V</kbd>.</li>
        </ol>
        <p class="dzi-note">Can’t drag it? Copy the code below, make a new bookmark, and paste it as the address. Images and fonts stay links to the site; states (hover…) come only from captures inside Leafdeck.</p>`;
      body.querySelector('[data-bm]').addEventListener('click', (e) => {
        e.preventDefault();
        toast('Drag it to your other browser’s bookmarks bar.');
      });
      ask({ title: 'Capture from another browser', body, win, wide: true, buttons: [{ label: 'Copy code', value: 'copy' }, { label: 'Done', value: 'ok', primary: true }] }).then((r) => {
        if (r?.button === 'copy') navigator.clipboard.writeText(href).then(() => toast('Bookmarklet copied. Paste it as a new bookmark’s address.'));
      });
    }

    async function editSvg(n) {
      const ta = document.createElement('textarea');
      ta.className = 'dz-code-edit';
      ta.spellcheck = false;
      ta.value = n.markup;
      const res = await ask({ title: 'SVG code', body: ta, win, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }], onMount: () => ta.focus() });
      if (res?.button !== 'ok') return;
      const s = svgSize(ta.value);
      if (!s) return toast('That isn’t valid SVG', 'error');
      ed.checkpoint();
      n.markup = s.markup;
      ed.commit();
    }

    /* ================= saving ================= */

    const scheduleSave = debounce(() => saveNow(), 600);
    async function saveNow() {
      if (!ed || !current) return;
      const { id } = current;
      const doc = ed.doc;
      try {
        // Claude changed the design while you weren't looking: take its version (Undo brings yours back).
        const m = await storage.stat(id);
        if (m && current.mtime && m > current.mtime + 1 && storage.kind === 'files') return reloadExternal(true);
        const used = new Set([...assetsUsed(doc.nodes), ...(doc.fonts || []).map((f) => f.asset), ...Object.values(doc.meta || {}).map((x) => x?.source?.shot).filter(Boolean)]);
        const fresh = {};
        for (const a of used) if (!current.saved.has(a) && doc.assets[a]) fresh[a] = doc.assets[a];
        const { assets, ...rest } = doc;
        current.mtime = await storage.write(id, { ...rest, view: ed.view, updatedAt: Date.now(), version: 1 }, fresh, [...used]);
        Object.keys(fresh).forEach((a) => current.saved.add(a));
        for (const a of [...current.saved]) if (!used.has(a)) current.saved.delete(a);
        clearTimeout(thumbTimer);
        thumbTimer = setTimeout(() => snapThumb(), 15000);
      } catch (err) {
        toast(`Couldn’t save: ${err.message}`, 'error');
      }
    }

    /** A picture of the design for the gallery: what's on the canvas, overlay hidden for a moment. */
    async function snapThumb() {
      if (!ed || !current || !shell?.designer || win.minimized || !win.el.isConnected || ed.editing) return;
      const vr = ed.viewport.getBoundingClientRect();
      const rects = ed.doc.nodes.filter((n) => !n.hidden && !n.ref).map((n) => ed.screenRect(n.id)).filter(Boolean);
      if (!rects.length) return;
      let x = Math.max(0, Math.min(...rects.map((r) => r.x)) - 16);
      let y = Math.max(0, Math.min(...rects.map((r) => r.y)) - 16);
      const x2 = Math.min(vr.width, Math.max(...rects.map((r) => r.x + r.w)) + 16);
      const y2 = Math.min(vr.height, Math.max(...rects.map((r) => r.y + r.h)) + 16);
      if (x2 - x < 8 || y2 - y < 8) return;
      ed.viewport.classList.add('dz-snapping');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const url = await shell.designer.snap({ x: vr.left + x, y: vr.top + y, w: x2 - x, h: y2 - y });
        if (url) await storage.thumb(current.id, await shrink(url, 480, 300));
      } catch {}
      ed?.viewport.classList.remove('dz-snapping');
    }
    async function shrink(url, maxW, maxH) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }

    /**
     * A picture of one component at 2x for the hand-off: zoom to it, hide the overlay, snap, zoom back. Without the
     * markup, or with `marks` (and what's around them: the markup is about the design as it stands).
     */
    async function snapComponent(comp, { marks = null } = {}) {
      if (!shell?.designer) return null;
      const before = { ...ed.view };
      const include = marks?.length ? marks.map((m) => ed.marks.box(m)).reduce((a, b) => {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
      }) : null;
      if (include) Object.assign(include, { x: include.x - 12, y: include.y - 12, w: include.w + 24, h: include.h + 24 });
      ed.fit([comp.id], { max: 2, pad: 40, include });
      if (!include) ed.solo(comp.id);
      ed.viewport.classList.add('dz-snapping');
      ed.viewport.classList.toggle('dz-no-marks', !include);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const vr = ed.viewport.getBoundingClientRect();
        let r = ed.screenRect(comp.id);
        if (include) {
          const v = ed.view;
          const m = { x: v.x + include.x * v.z, y: v.y + include.y * v.z, w: include.w * v.z, h: include.h * v.z };
          const x = Math.min(r.x, m.x);
          const y = Math.min(r.y, m.y);
          r = { x, y, w: Math.max(r.x + r.w, m.x + m.w) - x, h: Math.max(r.y + r.h, m.y + m.h) - y };
        }
        const x = Math.max(0, r.x);
        const y = Math.max(0, r.y);
        return await shell.designer.snap({ x: vr.left + x, y: vr.top + y, w: Math.min(r.x + r.w, vr.width) - x, h: Math.min(r.y + r.h, vr.height) - y });
      } catch {
        return null;
      } finally {
        ed.solo(null);
        ed.viewport.classList.remove('dz-snapping', 'dz-no-marks');
        ed.setView(before);
      }
    }

    /**
     * The markup that goes with a component: what's drawn on or near it (or one of its states), and sketches away from
     * every frame (something new to make). None while the markup is hidden.
     */
    function markupFor(comp) {
      if (!ed.marks.shown || !ed.doc.marks.length) return [];
      const near = (n) => {
        const r = ed.worldRect(n.id);
        return r ? ed.marks.in(r, 120) : [];
      };
      const mine = new Set([comp, ...statesOf(ed.doc, comp)].flatMap(near));
      const others = new Set(ed.doc.nodes.filter((n) => n !== comp && n.variant?.of !== comp.id).flatMap(near));
      return ed.doc.marks.filter((m) => mine.has(m) || !others.has(m));
    }

    /* ================= Claude ================= */

    function ensureChat() {
      if (!shell?.agentChat || !current) return null;
      if (!chat) {
        chat = createChat('@design:' + current.id, {
          text: {
            title: 'Claude',
            placeholder: 'Ask Claude to build this, or to change the design…',
            emptyTitle: 'Bring it to life',
            emptyText: 'Claude reads the hand-off for the selected component (its spec, code, states and your notes) and builds it. It can also change the design itself, or rebuild a screenshot as layers.',
            suggestions: ['Build the selected component', 'Make it accessible and keyboard-friendly', 'Add a loading state to the design', 'Suggest three visual variations'],
            clearConfirm: 'Start a new conversation? Claude won’t remember this one (your design and build stay as they are).',
            terminal: false,
          },
          emptyIcon: glyph('claude', 16),
          // Before each message: the hand-off for what's selected, fresh, and the design saved. New markup gets a
          // line in the message, so Claude looks at it.
          beforeSend: async (text) => {
            await saveNow();
            const comp = current.handoff.component;
            const marks = comp ? await writeHandoff(comp).catch(() => []) : [];
            const said = JSON.stringify(marks.map((m) => [m.kind, m.pts, m.text]));
            if (said === markupSaid) return;
            markupSaid = said;
            if (marks.length) return `${text}\n\n(I marked up the design to show what I mean: see handoff/markup.png and “The user’s markup” in handoff/spec.md.)`;
          },
        });
        $('[data-pane="claude"]', win.body).append(chat.el);
      }
      return chat;
    }

    /**
     * handoff/: spec.md, component.html, styles.css, preview.png, original.png and markup.png (what the user drew) for
     * a component. Resolves the markup that went with it.
     */
    async function writeHandoff(comp, { reveal = false } = {}) {
      if (!shell?.designer) return [];
      await saveNow();
      const doc = ed.doc;
      const meta = doc.meta[comp.id] || {};
      const framework = meta.framework || doc.framework || 'html';
      const assetPath = (id) => '../' + current.handoff.assetPath(id);
      const code = exportComponent(doc, comp, { assetPath });
      const marks = markupFor(comp);
      const files = {
        'handoff/spec.md': handoffMarkdown(doc, comp, { framework, code: exportComponent(doc, comp, { assetPath: current.handoff.assetPath }), files: true, marks }),
        'handoff/component.html': previewPage(doc, comp, { assetPath }).replace(/<style>[\s\S]*<\/style>/, '<link rel="stylesheet" href="styles.css">\n<style>html, body { margin: 0; } body { display: grid; place-items: center; min-height: 100vh; background: #f4f5f7; } .stage { padding: 48px; }</style>'),
        'handoff/styles.css': code.css,
      };
      const png = await snapComponent(comp);
      if (png) files['handoff/preview.png'] = png;
      if (meta.source?.shot && doc.assets[meta.source.shot]) files['handoff/original.png'] = doc.assets[meta.source.shot];
      files['handoff/markup.png'] = marks.length ? await snapComponent(comp, { marks }) : null; // null: an old one goes
      await shell.designer.writeFiles(current.id, files);
      if (reveal) toast('Hand-off saved in the design’s folder', '', { label: 'Show', act: () => revealDesign(current.id) });
      return marks;
    }

    async function buildWithClaude(comp, { framework }) {
      const c = ensureChat();
      if (!c) return;
      setTab('claude');
      const states = statesOf(ed.doc, comp);
      c.send(`Build “${comp.name}” as ${FRAMEWORKS[framework] || framework}. Read handoff/spec.md (and look at handoff/preview.png${ed.doc.meta[comp.id]?.source?.shot ? ' and handoff/original.png' : ''}), then put the component in build/ and a demo of it${states.length ? ` in every state (${['default', ...states.map((s) => s.variant.state)].join(', ')})` : ''} in build/index.html.`);
    }

    /** A component captured from a site in the Site Editor goes back there as a change, shown live on the page. */
    async function sendToSite(comp) {
      const site = ed.doc.meta[comp.id]?.source?.site;
      if (!site) return;
      await saveNow();
      const code = exportComponent(ed.doc, comp); // assets inline, so the page can show it as is
      const m = await import('./siteeditor.js');
      m.receiveComponent({ project: site.project, selector: site.selector, url: site.url, html: code.html, css: code.css, design: { id: current.id, name: comp.name }, name: comp.name });
    }

    /** Claude rebuilds a picture as real layers: it writes HTML for it, Designer captures that. */
    async function trace(n) {
      const c = ensureChat();
      if (!c || !shell?.designer) return;
      const src = ed.doc.assets[(n.src || '').replace('asset:', '')] || n.src;
      if (!/^data:image\//.test(src)) return toast('That image isn’t stored in the design', 'error');
      const file = `trace/${n.id}`;
      await shell.designer.writeFiles(current.id, { [`${file}.png`]: src });
      pendingTrace = { id: n.id, file: `${file}.html` };
      setTab('claude');
      c.send(`Recreate the picture ${file}.png as HTML and CSS, written to ${file}.html. It's a UI element ${Math.round(n.w)}×${Math.round(n.h)} px; match it exactly: layout (use flexbox where it's laid out in rows or columns), spacing, colors, corner radii, shadows, fonts and text. Draw icons as inline SVG. Plain HTML with one <style> block, no scripts, no page margins, and the element as the only thing in <body>, at that size.`);
    }

    async function afterClaude() {
      if (!ed || !current) return;
      await reloadExternal(false);
      await checkBuild(true);
      if (pendingTrace && shell?.designer) {
        const t = pendingTrace;
        const f = await shell.designer.readFile(current.id, t.file).catch(() => null);
        if (f?.text) {
          pendingTrace = null;
          try {
            const cap = await captureHtml(f.text);
            const src = ed.node(t.id);
            ed.importCapture(cap, { at: src ? { x: src.x + src.w + 60, y: src.y } : null, name: 'Rebuilt ' + (src?.name || 'element') });
          } catch (err) {
            toast(`Couldn’t turn Claude’s HTML into layers: ${err.message}`, 'error');
          }
        }
      }
    }

    /** design.json changed on disk (Claude edited it): load it, keeping Undo. */
    async function reloadExternal(fromSave) {
      if (!current || storage.kind !== 'files') return;
      const m = await storage.stat(current.id).catch(() => 0);
      if (!m || m <= current.mtime + 1) return;
      try {
        const { doc, assets, mtime } = await storage.read(current.id);
        current.mtime = mtime;
        Object.keys(assets || {}).forEach((a) => current.saved.add(a));
        ed.replace({ ...doc, assets });
        toast(fromSave ? 'Claude changed the design, so it was reloaded. Undo brings back your last change.' : 'Claude updated the design', '', { label: 'Undo', act: () => ed.undo() });
      } catch (err) {
        toast(`Couldn’t load Claude’s changes: ${err.message}`, 'error');
      }
    }

    async function checkBuild(show = false) {
      if (!shell?.designer || !current) return;
      const f = await shell.designer.readFile(current.id, 'build/index.html').catch(() => null);
      const had = buildExists;
      buildExists = !!f?.text;
      if (buildExists && show && (!had || tab === 'build')) {
        current.handoff.showBuild();
        if (!had) toast('Claude’s build is ready', '', { label: 'Show', act: () => setTab('build') });
      } else if (buildExists !== had) current.handoff.render();
    }

    // Right-click on the canvas: the usual commands.
    win.body.addEventListener('contextmenu', (e) => {
      if (!ed || !e.target.closest('.dz-viewport')) return;
      e.preventDefault();
      const has = ed.sel.length > 0;
      const freeable = ed.sel.some((id) => { for (const { node } of walk([ed.node(id)])) if (layoutOf(node)) return true; return false; });
      showMenu(e.clientX, e.clientY, [
        { label: 'Paste', key: 'Ctrl+V', act: () => pasteNow() },
        { label: 'Capture an Element…', key: 'C', act: () => captureMenu(null) },
        '-',
        { label: 'Copy', key: 'Ctrl+C', act: () => ed.copy(), disabled: !has },
        { label: 'Duplicate', key: 'Ctrl+D', act: () => ed.ops.duplicate(), disabled: !has },
        { label: 'Delete', key: 'Del', act: () => ed.ops.delete(), disabled: !has },
        '-',
        { label: 'Group Selection', key: 'Ctrl+G', act: () => ed.ops.group(), disabled: !has },
        { label: 'Ungroup', key: 'Ctrl+Shift+G', act: () => ed.ops.ungroup(), disabled: !has },
        { label: 'Add Auto Layout', key: 'Shift+A', act: () => ed.ops.autoLayout(), disabled: !has },
        { label: 'Convert to Free Design', key: 'Alt+Shift+A', act: () => ed.ops.freeLayout({ deep: true }), disabled: !freeable },
        '-',
        { label: 'Bring to Front', key: 'Ctrl+Shift+]', act: () => ed.ops.order(Infinity), disabled: !has },
        { label: 'Send to Back', key: 'Ctrl+Shift+[', act: () => ed.ops.order(-Infinity), disabled: !has },
        '-',
        { label: 'Show/Hide', key: 'Ctrl+Shift+H', act: () => ed.ops.toggle('hidden'), disabled: !has },
        { label: 'Lock/Unlock', key: 'Ctrl+Shift+L', act: () => ed.ops.toggle('locked'), disabled: !has },
        '-',
        { label: 'Build with Claude', act: () => { const c = componentOf(ed, ed.sel[0]); if (c) { setTab('build'); buildWithClaude(c, { framework: ed.doc.meta[c.id]?.framework || ed.doc.framework || 'html' }); } }, disabled: !has || !shell?.agentChat },
      ]);
    });

    home();
  },
});
