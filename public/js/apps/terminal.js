// Terminal: real shells inside Leafdeck (Linux), with tabs, and panes within a tab (split side by side or stacked, as
// often as you like). The shells run on pseudo-terminals (electron/terminal.cjs + pty-helper.py): in leafdeckd on
// Leafdeck OS, so they outlive a reload or a restart of Leafdeck and this window takes them back when it opens, in the
// same tabs and panes; elsewhere in the main process. This draws them with xterm.js (public/vendor/xterm).
// Pinned folders (Folders, Ctrl+Shift+G) jump a pane there, or open a new tab or pane in one, without typing the path.
// While a terminal has focus, Leafdeck's own Ctrl/Alt shortcuts step aside so the shell gets them (Ctrl+R, Ctrl+W, Ctrl+D…).
import { esc, $, $$ } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, addResolver, openApp, wins, toast, closeWindow } from '../wm.js';
import { shell } from '../shell.js';

const supported = !!shell?.term && shell.platform === 'linux';
let xtermMods = null;

/**
 * Paste the clipboard into a shell: its text, or for an image alone (a screenshot), the path of a file holding it.
 * readText() can't be used for this: with only an image on the clipboard, it returns the image's bytes as text.
 * (The Claude Code app's terminal drawer, shellview.js, uses it too.)
 */
export async function pasteClipboard(id) {
  const items = await navigator.clipboard.read();
  const text = items.find((it) => it.types.includes('text/plain'));
  if (text) {
    const t = await (await text.getType('text/plain')).text();
    if (t) shell.term.write(id, t);
    return;
  }
  for (const it of items) {
    const type = it.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await it.getType(type);
    return shell.term.pasteImage(id, new Uint8Array(await blob.arrayBuffer()), type);
  }
}

export async function loadXterm() {
  if (!xtermMods) {
    if (!document.querySelector('link[href="/vendor/xterm/xterm.css"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/vendor/xterm/xterm.css';
      document.head.append(l);
    }
    const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
      import('/vendor/xterm/xterm.mjs'),
      import('/vendor/xterm/addon-fit.mjs'),
      import('/vendor/xterm/addon-webgl.mjs'),
    ]);
    xtermMods = { Terminal, FitAddon, WebglAddon };
  }
  return xtermMods;
}

/** xterm colors from Leafdeck's own theme (re-read when light/dark or the accent changes). The background is clear: `.term`
    paints it, at Settings → Appearance → Terminal background (`--term-opacity`). It keeps its color (alpha 0) because
    xterm draws inverse text in it, made opaque. */
export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => cs.getPropertyValue(n).trim() || d;
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    background: dark ? '#14161900' : '#fbfbfa00',
    foreground: dark ? '#e8e8ec' : '#1d1f1e',
    cursor: v('--accent', '#34c77b'),
    cursorAccent: dark ? '#141619' : '#fbfbfa',
    selectionBackground: dark ? 'rgba(52,199,123,0.35)' : 'rgba(52,199,123,0.28)',
    black: dark ? '#1c1e21' : '#1d1f1e', brightBlack: '#6b7072',
    red: '#ff6961', brightRed: '#ff8a84',
    green: v('--accent', '#34c77b'), brightGreen: '#5fe09a',
    yellow: '#f2c94c', brightYellow: '#ffd60a',
    blue: '#64a8ff', brightBlue: '#8cc0ff',
    magenta: '#d38bff', brightMagenta: '#e3aeff',
    cyan: '#4fd6d2', brightCyan: '#7fe7e3',
    white: dark ? '#d8d8dc' : '#3a3d3c', brightWhite: dark ? '#ffffff' : '#111312',
  };
}

/* ---------------- pinned folders (this computer only: paths mean nothing elsewhere) ---------------- */

const PINS = 'terminal:pins';
const LAYOUT = 'terminal:layout';
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
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
/** Shells another app shows in its own window (shellview.js, the Claude Code app): a Terminal window doesn't adopt them. */
const CLAIMED = 'terminal:claimed';
export const claimed = () => store.get(CLAIMED, []).filter((s) => typeof s === 'string');
export const claimShell = (sid) => store.set(CLAIMED, [...new Set([...claimed(), sid])]);
export const releaseShell = (sid) => store.set(CLAIMED, claimed().filter((s) => s !== sid));
/** Each Terminal window keeps its own tabs and panes: the first window ('terminal') under LAYOUT, others under their id. */
const layoutKey = (winId) => (winId === 'terminal' ? LAYOUT : `${LAYOUT}:${winId}`);
/** Drags a pane takes: files (Leafdeck's own, as Files and the desktop drag them, or another program's) and text. */
const FILES_DRAG = 'application/x-leafdeck-files';
const droppable = (dt) => !!dt && ['Files', FILES_DRAG, 'text/plain'].some((t) => dt.types.includes(t));
/** A path as the shell reads it: bare when that's safe, otherwise in single quotes. */
const shellQuote = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`);
const isTerminalWin = (id) => id === 'terminal' || /^terminal:\d+$/.test(id);
const pins = () => store.get(PINS, []).filter((p) => typeof p === 'string');
let home = '';
const tilde = (p) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
const folderName = (p) => (p === home ? 'Home' : p.split('/').filter(Boolean).pop() || '/');
/** A path as the shell should see it, whatever characters it has. */
const quote = (p) => `'${p.replace(/'/g, `'\\''`)}'`;

/* ---------------- shells ---------------- */

const sessions = new Map(); // shell id -> { id, term, fit, el, title, exited }
let startIn = null; // a folder for the next new window's first shell (openApp('terminal', { cwd }), e.g. from Files)
let dataWired = false;
function wireData() {
  if (dataWired) return;
  dataWired = true;
  shell.on('term:data', ({ id, data }) => sessions.get(id)?.term.write(data));
  shell.on('term:exit', ({ id, code }) => {
    const s = sessions.get(id);
    if (!s) return;
    s.exited = true;
    s.term.write(`\r\n\x1b[2m[Process exited${code ? ` with code ${code}` : ''}. Press any key to close.]\x1b[0m\r\n`);
  });
}
/** Scroll steps per row the wheel or touchpad moves, in programs that have the mouse (see wheel() below). */
const WHEEL_SPEED = 0.75;
/** Where a shell is: { cwd, busy } (busy: a program is running in it), or null when that can't be told. */
const where = (id) => (shell.term.info ? shell.term.info(id).catch(() => null) : Promise.resolve(null));
// Windows take back their shells one at a time, so two of them never both adopt the same one.
let restoring = Promise.resolve();

/** Another Terminal window ('terminal:2', 'terminal:3'…): the first number no open window has. */
export function newTerminalWindow(cwd) {
  let n = 2;
  while (wins.has(`terminal:${n}`)) n++;
  return openApp(`terminal:${n}`, cwd ? { cwd } : {});
}

const terminalApp = {
  id: 'terminal',
  name: 'Terminal',
  icon: 'terminal',
  color: 'graphite',
  size: [880, 560],
  min: [420, 260],
  hidden: !supported, // not on the desktop or in search where it can't run
  launch(opts) {
    startIn = typeof opts?.cwd === 'string' ? opts.cwd : null;
  },
  openHere(win, cwd) {
    win.termNewTab?.(null, cwd);
  },
  menuItems: () => (supported ? [{ label: 'New Terminal Window', act: () => newTerminalWindow() }] : []),
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Terminal runs on Leafdeck OS</div>
        <p>Leafdeck’s terminal needs Linux. On Windows, use Windows Terminal.</p></div>`;
      return;
    }
    wireData();
    if (!home) shell.files?.places?.().then((p) => (home = p.home || ''), () => {});
    win.body.innerHTML = '<div class="term"><div class="term-tabs"></div><div class="term-stack"></div><div class="term-folders" hidden></div></div>';
    win.tools.innerHTML = `<button class="tb-btn" data-term="claude" title="Claude Code in this folder"><img class="term-claude-logo" src="/img/claude-symbol.png" alt="" draggable="false"></button>
      <button class="tb-btn" data-term="split-row" title="Split side by side (Ctrl+Shift+E)">${icon('split-row', 15)}</button>
      <button class="tb-btn" data-term="split-col" title="Split stacked (Ctrl+Shift+O)">${icon('split-col', 15)}</button>
      <button class="tb-btn" data-term="folders" title="Folders (Ctrl+Shift+G)">${icon('folder', 15)}</button>
      <button class="tb-btn" data-term="new" title="New tab (Ctrl+Shift+T)">${icon('plus', 15)}</button>
      <button class="tb-btn" data-term="window" title="New window (Ctrl+Shift+N)">${icon('new-window', 15)}</button>`;
    const tabsEl = $('.term-tabs', win.body);
    const stack = $('.term-stack', win.body);
    const foldersEl = $('.term-folders', win.body);

    /* A tab is a tree of panes: { t: 'pane', sid } or { t: 'split', dir: 'row' (side by side) | 'col' (stacked),
       ratio, a, b }. `active` is the pane with the keyboard. */
    let tabs = [];
    let current = null;
    let seq = 0;
    const tabOf = (sid) => tabs.find((t) => panesOf(t.root).includes(sid));
    const panesOf = (n) => (!n ? [] : n.t === 'pane' ? [n.sid] : [...panesOf(n.a), ...panesOf(n.b)]);
    const cur = () => tabs.find((t) => t.id === current);
    /** The tree without pane `sid` (its neighbor takes the space), or null when it was the only pane. */
    const without = (n, sid) => {
      if (n.t === 'pane') return n.sid === sid ? null : n;
      const a = without(n.a, sid);
      const b = without(n.b, sid);
      return !a ? b : !b ? a : { ...n, a, b };
    };
    /** The tree with pane `sid` placed against one side ('left', 'right', 'top', 'bottom') of pane `target`. */
    const beside = (n, target, sid, side) => {
      if (n.t === 'split') return { ...n, a: beside(n.a, target, sid, side), b: beside(n.b, target, sid, side) };
      if (n.sid !== target) return n;
      const moved = { t: 'pane', sid };
      const first = side === 'left' || side === 'top';
      return { t: 'split', dir: side === 'left' || side === 'right' ? 'row' : 'col', ratio: 0.5, a: first ? moved : n, b: first ? n : moved };
    };
    /** The tree with two panes trading places. */
    const swap = (n, x, y) => (n.t === 'pane' ? { t: 'pane', sid: n.sid === x ? y : n.sid === y ? x : n.sid } : { ...n, a: swap(n.a, x, y), b: swap(n.b, x, y) });
    const LAYOUT_KEY = layoutKey(win.id);
    const save = () => store.set(LAYOUT_KEY, { tabs: tabs.map(({ root, active }) => ({ root, active })), current: tabs.findIndex((t) => t.id === current) });

    /** A shell drawn in its own element: a new one (in `cwd`), or one still running from before (`existing`). */
    async function makeSession(existing, cwd) {
      const { Terminal, FitAddon, WebglAddon } = await loadXterm();
      const el = document.createElement('div');
      el.className = 'term-view';
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Code", "DejaVu Sans Mono", "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        allowProposedApi: false,
        scrollback: 5000,
        allowTransparency: true,
        theme: themeColors(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // xterm needs to be in the page to measure; a hidden holder until the pane is placed.
      stack.append(el);
      term.open(el);
      // Draw with WebGL where there's a GPU: xterm's DOM renderer rebuilds rows in the page, on the main thread that moves
      // the windows. Without WebGL (the VM) or if its context is lost, the DOM renderer.
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {
        /* DOM renderer */
      }
      let opened = existing;
      if (opened) term.write(opened.buffer); // the screen as it was; the size is set again once the pane is placed
      else {
        try {
          fit.fit();
          opened = await shell.term.open({ cols: term.cols, rows: term.rows, cwd: cwd || undefined });
        } catch (err) {
          term.write(`Couldn’t start a shell: ${err.message}\r\n`);
          return null;
        }
      }
      const s = { id: opened.id, term, fit, el, title: 'Shell', exited: false };
      sessions.set(s.id, s);
      term.onData((d) => {
        if (s.exited) return closePane(s.id);
        shell.term.write(s.id, d);
      });
      term.onTitleChange((t) => {
        s.title = String(t || 'Shell').slice(0, 60);
        const label = $(`.term-pane[data-sid="${CSS.escape(s.id)}"] .term-grip span`, stack);
        if (label) label.textContent = s.title;
        drawTabs();
      });
      term.attachCustomKeyEventHandler((e) => keys(e, s));
      term.attachCustomWheelEventHandler((e) => wheel(e, s));
      el.addEventListener('dragover', (e) => {
        if (!droppable(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      el.addEventListener('drop', (e) => {
        if (!droppable(e.dataTransfer)) return;
        e.preventDefault();
        drop(e.dataTransfer, s);
      });
      // Tell Leafdeck when a terminal has the keyboard, so its shortcuts step aside; and that pane becomes the active one.
      term.textarea?.addEventListener('focus', () => {
        shell.term.focus(true);
        setActive(s.id, false);
      });
      term.textarea?.addEventListener('blur', () => shell.term.focus(false));
      return s;
    }

    const paste = (s) => pasteClipboard(s.id);

    /**
     * Files dropped on a pane (from Files, the desktop or another program) type their paths, quoted for the shell and
     * as a paste, as other terminals do: Claude Code takes a dropped image as one. Dropped text types itself.
     */
    function drop(dt, s) {
      let paths = [];
      try {
        const raw = dt.getData(FILES_DRAG);
        paths = raw ? JSON.parse(raw) : [...dt.files].map((f) => shell.files?.pathForFile?.(f)).filter(Boolean);
      } catch {}
      const text = paths.length ? paths.map(shellQuote).join(' ') + ' ' : dt.getData('text/plain');
      if (!text || s.exited) return;
      s.term.paste(text);
      s.term.focus();
    }

    /**
     * The wheel in a program that has the mouse (Claude Code's fullscreen view, vim, less) or the whole screen: one
     * scroll step per row the wheel or touchpad moved, as other terminals send. xterm.js sends at most one per event,
     * and a touchpad's small movements count for a third of that, so Claude Code (which scrolls a row per step in
     * xterm.js) crawled. In the shell itself, xterm scrolls its own history as usual.
     */
    function wheel(e, s) {
      const core = s.term._core;
      const mouse = core?.coreMouseService;
      const cell = core?._renderService?.dimensions?.css?.cell?.height;
      const grabbed = !!mouse?.areMouseEventsActive;
      if (!e.deltaY || e.shiftKey || !cell || (!grabbed && s.term.buffer.active.type !== 'alternate')) return true;
      const rows = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * s.term.rows : e.deltaY / cell;
      s.wheelRest = (s.wheelRest || 0) + rows * WHEEL_SPEED;
      const n = Math.trunc(s.wheelRest);
      s.wheelRest -= n;
      e.preventDefault();
      if (!n) return false;
      if (grabbed) {
        const at = core._mouseService?.getMouseReportCoords(e, core.screenElement);
        if (!at) return false;
        for (let i = 0; i < Math.abs(n); i++)
          mouse.triggerMouseEvent({ ...at, button: 4, action: n < 0 ? 0 : 1, ctrl: e.ctrlKey, alt: e.altKey, shift: false });
      } else shell.term.write(s.id, `\x1b${s.term.modes.applicationCursorKeysMode ? 'O' : '['}${n < 0 ? 'A' : 'B'}`.repeat(Math.abs(n)));
      return false;
    }

    /** Ctrl+Shift+C/V copy and paste, T/W a tab or pane, N a window, E/O split, G folders; Alt+arrows move between panes. */
    function keys(e, s) {
      if (e.type !== 'keydown') return true;
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.startsWith('Arrow')) {
        focusNeighbor(e.key.slice(5).toLowerCase());
        return false;
      }
      if (!e.ctrlKey || !e.shiftKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c') {
        const sel = s.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (k === 'v') {
        paste(s).catch(() => toast('Couldn’t read the clipboard', 'error'));
        return false;
      }
      const act = { t: () => newTab(), n: async () => newTerminalWindow((await where(s.id))?.cwd), w: () => closePane(s.id), e: () => split('row'), o: () => split('col'), g: () => openFolders() }[k];
      if (!act) return true;
      act();
      return false;
    }

    /* ---------------- tabs and panes ---------------- */

    async function newTab(existing, cwd) {
      const s = await makeSession(existing, cwd);
      if (!s) return;
      const tab = { id: `tab${++seq}`, root: { t: 'pane', sid: s.id }, active: s.id };
      tabs.push(tab);
      show(tab.id);
    }
    win.termNewTab = newTab;

    /** Split the active pane: the new one starts in the same folder. */
    async function split(dir, cwd) {
      const tab = cur();
      if (!tab) return newTab(null, cwd);
      const from = tab.active;
      const at = cwd ?? (await where(from))?.cwd ?? undefined;
      const s = await makeSession(null, at);
      if (!s) return;
      const replace = (n) => (n.t === 'pane' && n.sid === from ? { t: 'split', dir, ratio: 0.5, a: n, b: { t: 'pane', sid: s.id } } : n.t === 'split' ? { ...n, a: replace(n.a), b: replace(n.b) } : n);
      tab.root = replace(tab.root);
      tab.active = s.id;
      show(tab.id);
    }

    /** Close a pane (and its shell); its neighbor takes the space. The last pane closes the tab, the last tab the window. */
    function closePane(sid) {
      const s = sessions.get(sid);
      const tab = tabOf(sid);
      if (s) {
        if (!s.exited) shell.term.close(sid);
        s.term.dispose();
        s.el.remove();
        sessions.delete(sid);
      }
      if (!tab) return;
      tab.root = without(tab.root, sid);
      if (!tab.root) {
        const i = tabs.indexOf(tab);
        tabs.splice(i, 1);
        if (!tabs.length) {
          save();
          return closeWindow(win);
        }
        return show(tabs[Math.max(0, i - 1)].id);
      }
      if (tab.active === sid) tab.active = panesOf(tab.root)[0];
      show(tab.id);
    }

    function setActive(sid, focusIt = true) {
      const tab = tabOf(sid);
      if (!tab) return;
      tab.active = sid;
      $$('.term-pane', stack).forEach((p) => p.classList.toggle('on', p.dataset.sid === sid));
      if (focusIt) sessions.get(sid)?.term.focus();
      drawTabs();
      save();
    }

    /** Alt+arrows: the nearest pane in that direction. */
    function focusNeighbor(dir) {
      const tab = cur();
      if (!tab) return;
      const box = (sid) => $(`.term-pane[data-sid="${CSS.escape(sid)}"]`, stack)?.getBoundingClientRect();
      const a = box(tab.active);
      if (!a) return;
      const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
      let best = null;
      for (const sid of panesOf(tab.root)) {
        const b = box(sid);
        if (sid === tab.active || !b) continue;
        const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        const ok = { left: b.right <= a.left + 2, right: b.left >= a.right - 2, up: b.bottom <= a.top + 2, down: b.top >= a.bottom - 2 }[dir];
        if (!ok) continue;
        const d = Math.hypot(bc.x - ac.x, bc.y - ac.y);
        if (!best || d < best.d) best = { sid, d };
      }
      if (best) setActive(best.sid);
    }

    /* ---------------- drawing ---------------- */

    function drawTabs() {
      tabsEl.hidden = tabs.length < 2;
      tabsEl.innerHTML = tabs
        .map((t, i) => {
          const s = sessions.get(t.active);
          const n = panesOf(t.root).length;
          return `<button class="term-tab${t.id === current ? ' on' : ''}" data-tab="${t.id}"><span>${esc(s?.title || `Shell ${i + 1}`)}</span>${n > 1 ? `<small>${n}</small>` : ''}
            <i class="term-x" data-close="${t.id}" title="Close tab">${icon('x', 11)}</i></button>`;
        })
        .join('');
      win.setTitle(sessions.get(cur()?.active)?.title || 'Terminal');
    }

    let ro = null;
    /** Lay out the current tab's panes (the other tabs' shells keep running, out of sight). */
    function show(id) {
      current = id;
      const tab = cur();
      ro?.disconnect();
      // Only this window's shells: `sessions` holds every Terminal window's.
      for (const t of tabs) for (const sid of panesOf(t.root)) sessions.get(sid)?.el.remove();
      stack.innerHTML = '';
      if (!tab) return drawTabs();
      const split = tab.root.t === 'split';
      const build = (n) => {
        if (n.t === 'pane') {
          const p = document.createElement('div');
          p.className = `term-pane${n.sid === tab.active ? ' on' : ''}`;
          p.dataset.sid = n.sid;
          const s = sessions.get(n.sid);
          if (s) p.append(s.el);
          // In a split: a bar (on hover) to drag the pane elsewhere, or close it.
          if (split) {
            const bar = document.createElement('div');
            bar.className = 'term-pane-bar';
            bar.innerHTML = `<span class="term-grip" data-grip="${esc(n.sid)}" title="Drag to move this pane: onto another pane's edge, its middle to swap, or the tabs for a tab of its own">${icon('dots', 13)}<span>${esc(s?.title || 'Shell')}</span></span>
              <button class="term-pane-x" data-close-pane="${esc(n.sid)}" title="Close this pane (Ctrl+Shift+W)">${icon('x', 11)}</button>`;
            p.append(bar);
          }
          return p;
        }
        const box = document.createElement('div');
        box.className = `term-split term-${n.dir}`;
        const a = build(n.a);
        const b = build(n.b);
        a.style.flex = `${n.ratio} 1 0`;
        b.style.flex = `${1 - n.ratio} 1 0`;
        const bar = document.createElement('div');
        bar.className = 'term-divider';
        bar.addEventListener('pointerdown', (e) => dragDivider(e, n, box, a, b));
        box.append(a, bar, b);
        return box;
      };
      stack.append(build(tab.root));
      ro = new ResizeObserver(() => requestAnimationFrame(fitAll));
      $$('.term-pane', stack).forEach((p) => ro.observe(p));
      requestAnimationFrame(() => {
        fitAll();
        sessions.get(tab.active)?.term.focus();
      });
      drawTabs();
      save();
    }

    function fitAll() {
      for (const sid of panesOf(cur()?.root)) {
        const s = sessions.get(sid);
        if (!s || !s.el.isConnected || !s.el.offsetWidth) continue;
        try {
          s.fit.fit();
          shell.term.resize(s.id, s.term.cols, s.term.rows);
        } catch {}
      }
    }

    /** Drag a divider to share the space differently (each side keeps at least a tenth). */
    function dragDivider(e, node, box, a, b) {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const row = node.dir === 'row';
      box.classList.add('dragging');
      const move = (ev) => {
        const at = row ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
        node.ratio = Math.min(0.9, Math.max(0.1, at));
        a.style.flex = `${node.ratio} 1 0`;
        b.style.flex = `${1 - node.ratio} 1 0`;
      };
      const up = () => {
        box.classList.remove('dragging');
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        save();
        fitAll();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }

    /* ---------------- folders ---------------- */

    let here = null; // { cwd, busy } of the active pane, when the folders list opened
    let pick = 0;
    async function openFolders() {
      foldersEl.hidden = false;
      // The search box is made once (redrawing it would take the keyboard away from it); the rest follows the typing.
      foldersEl.innerHTML = `<div class="term-f-search">${icon('search', 13)}<input placeholder="Go to a folder, or type a path" spellcheck="false"></div>
        <div class="term-f-body"></div><div class="term-f-hint">Enter: go there · Ctrl+Enter: new tab · Shift+Enter: new pane · Esc: close</div>`;
      $('input', foldersEl).focus();
      pick = 0;
      here = await where(cur()?.active);
      drawFolders($('input', foldersEl).value);
    }
    function closeFolders() {
      foldersEl.hidden = true;
      sessions.get(cur()?.active)?.term.focus();
    }
    function folderChoices(q) {
      const list = [...new Set([...pins(), home].filter(Boolean))];
      const typed = q.trim().replace(/^~(?=\/|$)/, home);
      const match = (p) => !q || folderName(p).toLowerCase().includes(q.toLowerCase()) || tilde(p).toLowerCase().includes(q.toLowerCase());
      const out = list.filter(match).map((p) => ({ path: p, pinned: pins().includes(p) }));
      if (typed.startsWith('/') && !out.some((c) => c.path === typed)) out.unshift({ path: typed.replace(/\/+$/, '') || '/', typed: true });
      return out;
    }
    function drawFolders(q) {
      const choices = folderChoices(q);
      pick = Math.min(pick, Math.max(0, choices.length - 1));
      const canPin = here?.cwd && !pins().includes(here.cwd);
      $('.term-f-body', foldersEl).innerHTML = `${canPin ? `<button class="term-f-pin" data-f="pin">${icon('pin', 13)} Pin this folder <span>${esc(tilde(here.cwd))}</span></button>` : ''}
        <div class="term-f-list">${choices
          .map((c, i) => `<div class="term-f-item${i === pick ? ' on' : ''}" data-path="${esc(c.path)}" data-i="${i}">
            <button class="term-f-go" data-f="cd" title="Go there in this pane (Enter)">${icon(c.typed ? 'right' : 'folder', 14)}<span><b>${esc(c.typed ? 'Go to' : folderName(c.path))}</b><small>${esc(tilde(c.path))}</small></span></button>
            <button class="tb-btn" data-f="tab" title="Open in a new tab (Ctrl+Enter)">${icon('plus', 13)}</button>
            <button class="tb-btn" data-f="split" title="Open in a new pane beside this one (Shift+Enter)">${icon('split-row', 13)}</button>
            ${c.pinned ? `<button class="tb-btn" data-f="unpin" title="Unpin">${icon('x', 12)}</button>` : ''}
          </div>`)
          .join('') || '<div class="term-f-empty">No pinned folder matches. Type a path that starts with / or ~</div>'}</div>`;
    }
    /** Go to a folder in the active pane, or (how = 'tab' / 'split') in a new tab or pane. A pane that's running a program
     * (Claude Code, an editor) would get the cd typed into that program, so the folder opens in a new tab instead. */
    async function goFolder(path, how) {
      closeFolders();
      if (how === 'tab') return newTab(null, path);
      if (how === 'split') return split('row', path);
      const sid = cur()?.active;
      const now = sid && (await where(sid));
      if (!sid || !now || now.busy || sessions.get(sid)?.exited) {
        if (now?.busy) toast('A program is running in this pane, so the folder opened in a new tab');
        return newTab(null, path);
      }
      shell.term.write(sid, `\x15 cd -- ${quote(path)}\r`); // Ctrl+U clears anything half typed first
    }
    /** Claude Code in the active pane's folder: started in this pane when it's at a prompt (even if another pane already
     * runs Claude there); else the pane running it there if there is one in this window, or a new tab there. */
    async function claudeHere() {
      const sid = cur()?.active;
      const now = sid && (await where(sid));
      const dir = now?.cwd || home || undefined;
      // Is Claude running in a shell? Its program name, or (before leafdeckd reports program names) its title.
      const isClaude = (id, info) => info?.busy && (info.program ? info.program === 'claude' : /^[✳✻✽⠀-⣿]|claude/i.test(sessions.get(id)?.title || ''));
      if (sid && now && !now.busy && !sessions.get(sid)?.exited) return shell.term.write(sid, '\x15claude\r'); // Ctrl+U clears anything half typed
      for (const t of tabs) {
        for (const p of panesOf(t.root)) {
          const info = await where(p);
          if (dir && info?.cwd === dir && isClaude(p, info)) {
            show(t.id);
            return setActive(p);
          }
        }
      }
      await newTab(null, dir);
      const fresh = cur()?.active;
      if (fresh && fresh !== sid) shell.term.write(fresh, 'claude\r');
    }
    foldersEl.addEventListener('input', (e) => {
      pick = 0;
      drawFolders(e.target.value);
    });
    foldersEl.addEventListener('keydown', (e) => {
      const q = $('input', foldersEl).value;
      const choices = folderChoices(q);
      if (e.key === 'Escape') return closeFolders();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % Math.max(1, choices.length);
        return drawFolders(q);
      }
      if (e.key === 'Enter' && choices[pick]) {
        e.preventDefault();
        goFolder(choices[pick].path, e.ctrlKey ? 'tab' : e.shiftKey ? 'split' : 'cd');
      }
    });
    foldersEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      const f = b.dataset.f;
      if (f === 'pin' && here?.cwd) {
        store.set(PINS, [...pins(), here.cwd]);
        toast(`Pinned ${tilde(here.cwd)}`);
        return drawFolders($('input', foldersEl).value);
      }
      const path = b.closest('[data-path]')?.dataset.path;
      if (!path) return;
      if (f === 'unpin') {
        store.set(PINS, pins().filter((p) => p !== path));
        return drawFolders($('input', foldersEl).value);
      }
      goFolder(path, f);
    });
    // A click outside the list closes it.
    win.body.addEventListener('pointerdown', (e) => !foldersEl.hidden && !foldersEl.contains(e.target) && !e.target.closest('[data-term="folders"]') && closeFolders());

    /* ---------------- events ---------------- */

    tabsEl.addEventListener('click', (e) => {
      const x = e.target.closest('[data-close]');
      if (x) {
        const tab = tabs.find((t) => t.id === x.dataset.close);
        for (const sid of panesOf(tab?.root)) closePane(sid);
        return;
      }
      const t = e.target.closest('[data-tab]');
      if (t) show(t.dataset.tab);
    });
    win.tools.addEventListener('click', (e) => {
      const a = e.target.closest('[data-term]')?.dataset.term;
      if (a === 'new') newTab();
      else if (a === 'split-row') split('row');
      else if (a === 'split-col') split('col');
      else if (a === 'folders') foldersEl.hidden ? openFolders() : closeFolders();
      else if (a === 'claude') claudeHere();
      else if (a === 'window') where(cur()?.active).then((w) => newTerminalWindow(w?.cwd));
    });
    stack.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('[data-grip]');
      if (grip && e.button === 0) return dragPane(e, grip.dataset.grip);
      const x = e.target.closest('[data-close-pane]');
      if (x) {
        e.preventDefault();
        return closePane(x.dataset.closePane);
      }
      const p = e.target.closest('.term-pane');
      if (p && p.dataset.sid !== cur()?.active) setActive(p.dataset.sid);
    });

    /** Drag a pane by its bar: against another pane's edge (it splits there), onto its middle (they swap places), or
     * onto the tabs (a tab of its own). Where it would go is highlighted; Esc cancels. */
    function dragPane(e, src) {
      e.preventDefault();
      const tab = cur();
      if (!tab) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let ghost = null;
      let preview = null;
      let target = null; // { kind: 'side', sid, side } | { kind: 'swap', sid } | { kind: 'tab' }
      const wasHidden = tabsEl.hidden;
      const where = (x, y) => {
        const tb = tabsEl.getBoundingClientRect();
        if (y >= tb.top - 4 && y <= tb.bottom + 4 && x >= tb.left && x <= tb.right) return { kind: 'tab' };
        const p = document.elementFromPoint(x, y)?.closest('.term-pane');
        if (!p || !stack.contains(p) || p.dataset.sid === src) return null;
        const r = p.getBoundingClientRect();
        const fx = (x - r.left) / r.width;
        const fy = (y - r.top) / r.height;
        if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return { kind: 'swap', sid: p.dataset.sid, r };
        const side = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].sort((a, b) => a[1] - b[1])[0][0];
        return { kind: 'side', sid: p.dataset.sid, side, r };
      };
      const draw = (t) => {
        tabsEl.classList.toggle('drop-here', t?.kind === 'tab');
        if (!t || t.kind === 'tab') return preview && (preview.hidden = true);
        preview ||= stack.appendChild(Object.assign(document.createElement('div'), { className: 'term-drop' }));
        preview.hidden = false;
        const box = stack.getBoundingClientRect();
        let { left, top, width, height } = t.r;
        if (t.side === 'left' || t.side === 'right') width /= 2;
        if (t.side === 'top' || t.side === 'bottom') height /= 2;
        if (t.side === 'right') left += width;
        if (t.side === 'bottom') top += height;
        Object.assign(preview.style, { left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${width}px`, height: `${height}px` });
      };
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          ghost = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'term-ghost', textContent: sessions.get(src)?.title || 'Shell' }));
          $(`.term-pane[data-sid="${CSS.escape(src)}"]`, stack)?.classList.add('moving');
          // The tabs are a drop target too, even with only one tab.
          tabsEl.hidden = false;
          if (wasHidden) tabsEl.classList.add('drop-only');
        }
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
        target = where(ev.clientX, ev.clientY);
        draw(target);
      };
      const end = (apply) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('keydown', key, true);
        ghost?.remove();
        preview?.remove();
        tabsEl.classList.remove('drop-here', 'drop-only');
        tabsEl.hidden = wasHidden;
        $(`.term-pane[data-sid="${CSS.escape(src)}"]`, stack)?.classList.remove('moving');
        if (!apply || !ghost || !target) return;
        if (target.kind === 'swap') tab.root = swap(tab.root, src, target.sid);
        else if (target.kind === 'side') tab.root = beside(without(tab.root, src), target.sid, src, target.side);
        else if (target.kind === 'tab') {
          if (panesOf(tab.root).length < 2) return;
          tab.root = without(tab.root, src);
          if (tab.active === src) tab.active = panesOf(tab.root)[0];
          const t = { id: `tab${++seq}`, root: { t: 'pane', sid: src }, active: src };
          tabs.splice(tabs.indexOf(tab) + 1, 0, t);
          return show(t.id);
        }
        tab.active = src;
        show(tab.id);
      };
      const up = () => end(true);
      const key = (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('keydown', key, true);
    }
    stack.addEventListener('contextmenu', (e) => {
      // Right-click pastes, like many terminals; with a selection, it copies.
      const sid = e.target.closest('.term-pane')?.dataset.sid;
      const s = sessions.get(sid);
      if (!s) return;
      e.preventDefault();
      const sel = s.term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        s.term.clearSelection();
        toast('Copied');
      } else paste(s).catch(() => {});
    });

    const themeObs = new MutationObserver(() => {
      for (const t of tabs) for (const sid of panesOf(t.root)) { const s = sessions.get(sid); if (s?.term.options) s.term.options.theme = themeColors(); }
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    win.cleanups.push(() => {
      ro?.disconnect();
      themeObs.disconnect();
      shell.term.focus(false);
      // Moving to another screen (one surface per screen): its shells and layout stay for the page there, as on a reload.
      for (const t of tabs)
        for (const sid of panesOf(t.root)) {
          if (!win.moving) shell.term.close(sid);
          sessions.get(sid)?.term.dispose();
          sessions.delete(sid);
        }
      tabs = [];
      if (win.moving) return;
      if (win.id === 'terminal') store.set(LAYOUT, null);
      else store.del(LAYOUT_KEY);
    });

    /* Shells still running from before a reload or a restart come back in their tabs and panes (as saved); any others
       get a tab each. Otherwise (or when opened for a folder), a new shell. */
    const cwd = startIn;
    startIn = null;
    const restore = async () => {
      await loadXterm();
      const mine = new Set(claimed());
      const running = new Map(((await shell.term.list?.().catch(() => [])) || []).filter((t) => !sessions.has(t.id) && !mine.has(t.id)).map((t) => [t.id, t]));
      // Shells saved in another open Terminal window's layout are that window's to take back.
      const theirs = (n) => (!n || typeof n !== 'object' ? [] : n.t === 'pane' ? [n.sid] : [...theirs(n.a), ...theirs(n.b)]);
      for (const id of wins.keys())
        if (id !== win.id && isTerminalWin(id)) for (const t of store.get(layoutKey(id), null)?.tabs || []) for (const sid of theirs(t?.root)) running.delete(sid);
      const saved = store.get(LAYOUT_KEY, null);
      const keep = (n) => {
        if (!n || typeof n !== 'object') return null;
        if (n.t === 'pane') return running.has(n.sid) ? { t: 'pane', sid: n.sid } : null;
        if (n.t !== 'split') return null;
        const a = keep(n.a);
        const b = keep(n.b);
        return a && b ? { t: 'split', dir: n.dir === 'col' ? 'col' : 'row', ratio: Math.min(0.9, Math.max(0.1, Number(n.ratio) || 0.5)), a, b } : a || b;
      };
      for (const t of Array.isArray(saved?.tabs) ? saved.tabs : []) {
        const root = keep(t.root);
        if (!root) continue;
        for (const sid of panesOf(root)) {
          if (!(await makeSession(running.get(sid)))) return;
          running.delete(sid);
        }
        tabs.push({ id: `tab${++seq}`, root, active: panesOf(root).includes(t.active) ? t.active : panesOf(root)[0] });
      }
      for (const t of running.values()) {
        await makeSession(t);
        tabs.push({ id: `tab${++seq}`, root: { t: 'pane', sid: t.id }, active: t.id });
      }
      if (tabs.length) show(tabs[Math.min(Math.max(0, saved?.current ?? 0), tabs.length - 1)].id);
      if (!tabs.length || cwd) await newTab(null, cwd);
    };
    restoring = restoring.then(restore, restore);
  },
};
registerApp(terminalApp);
addResolver((id) => (/^terminal:\d+$/.test(id) ? { ...terminalApp, id } : null));
