// An embedded shell: one xterm.js view on one of Leafdeck's pseudo-terminals (shell.term), for an app that wants a
// terminal inside its own layout (the Claude Code app's terminal drawer). The Terminal app (apps/terminal.js) is the
// full thing, with tabs, panes and folders; this is one shell in one element, that can move between elements.
// Shells opened here are claimed (claimShell), so a Terminal window doesn't adopt them after a reload; on Leafdeck OS
// they outlive Leafdeck itself, and an app takes them back with `existing` from shell.term.list().
import { shell } from './shell.js';
import { loadXterm, themeColors, claimShell, releaseShell, pasteClipboard } from './apps/terminal.js';
import { toast } from './wm.js';

const views = new Map(); // shell id -> view
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  shell.on('term:data', ({ id, data }) => views.get(id)?.term.write(data));
  shell.on('term:exit', ({ id, code }) => {
    const v = views.get(id);
    if (!v) return;
    v.exited = true;
    v.term.write(`\r\n\x1b[2m[Process exited${code ? ` with code ${code}` : ''}. Press any key to close.]\x1b[0m\r\n`);
    v.onExit?.(code);
  });
  new MutationObserver(() => views.forEach((v) => (v.term.options.theme = themeColors()))).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
}

/**
 * Open a shell in `host` (which must be in the page: xterm measures it). opts.cwd: where a new shell starts;
 * opts.existing: a running shell from shell.term.list() to take back instead. opts.onExit(code), opts.onTitle(title).
 * Returns { id, el, term, title, exited, focus(), fit(), moveTo(host), close() } or null when no shell could start.
 */
export async function createShellView(host, { cwd, existing, onExit, onTitle } = {}) {
  wire();
  const { Terminal, FitAddon, WebglAddon } = await loadXterm();
  const el = document.createElement('div');
  el.className = 'term-view shellview';
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
  host.append(el);
  term.open(el);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    /* DOM renderer */
  }
  const v = { id: null, el, term, title: 'Shell', exited: false, onExit, onTitle };
  const resize = () => {
    if (!v.id || v.exited || !el.isConnected || !el.clientWidth) return;
    try {
      fit.fit();
      shell.term.resize(v.id, term.cols, term.rows).catch(() => {});
    } catch {}
  };
  let opened = existing;
  if (opened) term.write(opened.buffer || '');
  else {
    try {
      fit.fit();
      opened = await shell.term.open({ cols: term.cols, rows: term.rows, cwd: cwd || undefined });
    } catch (err) {
      term.write(`Couldn’t start a shell: ${err.message}\r\n`);
      return null;
    }
  }
  v.id = opened.id;
  views.set(v.id, v);
  claimShell(v.id);
  term.onData((d) => (v.exited ? v.close() : shell.term.write(v.id, d)));
  term.onTitleChange((t) => {
    v.title = String(t || 'Shell').slice(0, 60);
    onTitle?.(v.title);
  });
  // While the shell has the keyboard, Leafdeck's own Ctrl/Alt shortcuts step aside; Ctrl+Shift+C/V copy and paste.
  term.textarea?.addEventListener('focus', () => shell.term.focus(true));
  term.textarea?.addEventListener('blur', () => shell.term.focus(false));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (k === 'v') {
      navigator.clipboard.readText().then((t) => t && term.paste(t));
      return false;
    }
    return true;
  });
  // Right-click pastes, as in the Terminal app; with a selection, it copies. (Leafdeck's menu for editable text
  // pasted twice here.)
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (v.exited) return;
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection();
      toast('Copied');
    } else pasteClipboard(v.id).catch(() => {});
  });
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(resize);
  });
  ro.observe(el);
  v.fit = resize;
  v.focus = () => term.focus();
  v.moveTo = (h) => {
    h.append(el);
    resize();
  };
  v.close = () => {
    ro.disconnect();
    views.delete(v.id);
    releaseShell(v.id);
    if (!v.exited) shell.term.close(v.id).catch(() => {});
    term.dispose();
    el.remove();
  };
  resize();
  return v;
}
