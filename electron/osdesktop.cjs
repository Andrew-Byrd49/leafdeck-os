// Leafdeck OS desktop services: the file picker every program gets (the desktop portal's FileChooser), the print sheet
// (its Print), "allow this app to…" questions (its Access portal), the file manager behind "Show in folder" (org.freedesktop.FileManager1) and the
// polkit agent that asks for an administrator's password. The D-Bus side is a small Python helper
// (electron/desktop-helper.py, like notify-helper.py); this relays between it and the UI, which draws the dialogs
// (public/js/filepicker.js, public/js/pageui.js).
//
// These run with Leafdeck, not in leafdeckd: every one of them is a question for the person, and without Leafdeck on
// screen there's no one to ask. Programs that ask while Leafdeck restarts get "canceled".
//
// The file picker is its own window (public/picker.html), not a dialog in Leafdeck's page: when Leafdeck itself asks
// (a site's upload button, "Save as…"), Chromium makes the asking window modal by ignoring all of its input until the
// portal answers, so a picker drawn inside that window could never be clicked, and the whole screen froze. The print
// sheet a program gets through the portal is in that window for the same reason: Leafdeck's own PDF viewer could ask too
// (a PDF that prints itself), and PDFs Leafdeck shows go through electron/printing.cjs without the portal otherwise.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { BrowserWindow, ipcMain } = require('electron');
const files = require('./files.cjs');
const adminWhy = require('./adminwhy.cjs');
const printing = require('./printing.cjs');

const HELPER = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'desktop-helper.py');

let send = () => {};
let onShow = () => {};
let mainWindow = () => null;
let appUrl = '';
let child = null;
let starts = [];
let stopped = false;
const open = new Map(); // request id -> request, so a reloaded UI can show them again
const pickers = new Map(); // request id -> the file picker's window
const FILE_KINDS = new Set(['open-file', 'save-file', 'save-files', 'print-settings']); // what shows in its own window
const printChoices = new Map(); // token -> what the sheet chose, for the document the program sends next
const replies = new Map(); // seq -> resolve
let seq = 0;

/* ---------------- file type filters ----------------
   Portals describe a filter with glob patterns and MIME types ("image/*" from a site's accept="image/*"). The picker
   only matches names, so MIME types become patterns here, from the freedesktop.org shared MIME database. */

let globs = null; // mime -> [glob]
function mimeGlobs() {
  if (globs) return globs;
  globs = new Map();
  for (const dir of ['/usr/share/mime', '/usr/local/share/mime']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, 'globs2'), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [, mime, glob] = line.split(':');
      if (!mime || !glob) continue;
      if (!globs.has(mime)) globs.set(mime, []);
      globs.get(mime).push(glob);
    }
  }
  return globs;
}

function patternsFor(mime) {
  const m = String(mime).toLowerCase();
  if (m === '*' || m === '*/*' || m === 'application/octet-stream') return ['*'];
  const all = mimeGlobs();
  if (m.endsWith('/*')) return [...all].filter(([k]) => k.startsWith(m.slice(0, -1))).flatMap(([, g]) => g);
  return all.get(m) || [];
}

const normalize = (filters = []) =>
  filters
    .map((f) => ({ name: String(f.name || 'Files').slice(0, 200), globs: [...new Set([...(f.globs || []), ...(f.mimes || []).flatMap(patternsFor)])].slice(0, 400) }))
    .filter((f) => f.globs.length);

/* ---------------- the helper ---------------- */

/** A password request: when Claude's the one asking, it comes with Claude's reason. */
async function showAuth(r) {
  const pids = r.pids;
  delete r.pids;
  const claude = await adminWhy.explain(pids).catch(() => null);
  if (claude) r.claude = claude;
  if (open.has(r.id)) send('os:desktop-request', r);
}

function handleLine(msg) {
  if (msg.request) {
    const r = msg.request;
    if (r.filters) r.filters = normalize(r.filters);
    open.set(r.id, r);
    if (r.kind === 'print-document') printDocument(r);
    else if (FILE_KINDS.has(r.kind)) showPicker(r);
    else if (r.kind === 'auth') showAuth(r);
    else send('os:desktop-request', r);
  } else if (msg.cancel) {
    open.delete(msg.cancel);
    closePicker(msg.cancel);
    send('os:desktop-cancel', { id: msg.cancel });
  } else if (msg.show) {
    onShow(msg.show.kind, (msg.show.paths || []).filter((p) => typeof p === 'string' && p.startsWith('/')));
  } else if (msg.reply != null) {
    replies.get(msg.reply)?.({ ok: !!msg.ok, error: String(msg.error || '') });
    replies.delete(msg.reply);
  } else if (msg.error) console.error('[os] desktop services:', msg.error);
}

function start() {
  if (!fs.existsSync(HELPER) || stopped) return;
  starts = [...starts.filter((t) => Date.now() - t < 60_000), Date.now()];
  if (starts.length > 3) return console.error('[os] desktop services: helper keeps stopping; giving up');
  let buf = '';
  child = spawn('python3', [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        handleLine(JSON.parse(line));
      } catch {
        /* not ours */
      }
    }
  });
  child.stderr.on('data', (d) => console.error('[os] desktop services:', String(d).trim()));
  child.on('exit', () => {
    child = null;
    // Whatever it was asking is gone with it.
    for (const id of open.keys()) {
      closePicker(id);
      send('os:desktop-cancel', { id });
    }
    open.clear();
    for (const r of replies.values()) r({ ok: false, error: 'Leafdeck’s desktop services stopped' });
    replies.clear();
    if (!stopped) setTimeout(start, 2000);
  });
}

/* ---------------- the file picker's window ----------------
   Transparent and over everything, like the lock screen: the page shows Leafdeck's picker (public/js/filepicker.js) on
   the main screen, with the shade over the rest. Its only bridge is electron/picker-preload.cjs. */

const pickerFor = (event) => [...pickers].find(([, w]) => !w.isDestroyed() && w.webContents === event.sender)?.[0];

/** What the picker page needs to look like Leafdeck's: the theme and accent, and where the main screen is. */
async function look() {
  const wc = mainWindow()?.webContents;
  if (!wc || wc.isDestroyed()) return null;
  const read = `(() => { const d = document.documentElement; return { className: d.className, theme: d.dataset.theme || '',
    vars: [...d.style].filter((k) => k.startsWith('--') && !k.startsWith('--wall')).map((k) => [k, d.style.getPropertyValue(k)]) }; })()`;
  // The page runs scripts even while Chromium ignores its input; if it's stuck, the picker uses its defaults.
  return Promise.race([wc.executeJavaScript(read, true).catch(() => null), new Promise((r) => setTimeout(() => r(null), 800))]);
}

function showPicker(r) {
  const w = new BrowserWindow({
    fullscreen: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: true,
    title: r.title || 'Choose a File',
    webPreferences: { preload: path.join(__dirname, 'picker-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pickers.set(r.id, w);
  w.setMenu?.(null);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('before-input-event', (e, input) => {
    const k = String(input.key || '').toLowerCase();
    if ((input.control || input.meta) && ['r', 'w', 'q'].includes(k)) e.preventDefault();
    if (k === 'f5') e.preventDefault();
  });
  // Closed without an answer (or its page crashed): canceled.
  w.on('closed', () => {
    if (pickers.get(r.id) === w) pickers.delete(r.id);
    answer(r.id, null);
    mainWindow()?.focus();
  });
  w.webContents.on('render-process-gone', () => !w.isDestroyed() && w.destroy());
  w.loadURL(`${appUrl}picker.html`);
}

function closePicker(id) {
  const w = pickers.get(Number(id));
  pickers.delete(Number(id));
  if (w && !w.isDestroyed()) w.destroy();
}

function wireIpc() {
  const from = (fn) => (event, ...args) => {
    const id = pickerFor(event);
    if (id == null) throw new Error('Not allowed');
    return fn(id, ...args);
  };
  ipcMain.handle('picker:request', from((id) => open.get(id) || null));
  ipcMain.handle('picker:look', from(() => look()));
  ipcMain.handle('picker:answer', from((id, result) => {
    answer(id, result);
    closePicker(id);
  }));
  ipcMain.handle('picker:places', from(() => files.places()));
  ipcMain.handle('picker:list', from((_id, dir) => files.list(String(dir || ''))));
  ipcMain.handle('picker:mkdir', from((_id, dir, name) => files.mkdir(String(dir), name ? String(name) : undefined)));
  ipcMain.handle('picker:printers', from(() => printing.printers()));
  ipcMain.handle('picker:printer-options', from((_id, printer) => printing.printerOptions(String(printer || ''))));
  ipcMain.handle('picker:papers', from(() => printing.standardPapers()));
}

/** opts: { send(channel, payload), onShow(kind, paths), mainWindow(), appUrl } */
function init(opts) {
  send = opts.send;
  onShow = opts.onShow;
  mainWindow = opts.mainWindow || mainWindow;
  appUrl = opts.appUrl || '';
  wireIpc();
  start();
}

const write = (obj) => child?.stdin.write(JSON.stringify(obj) + '\n');

/** A program's document is ready to print: with the choices it got from the sheet, or the sheet asks now. */
function printDocument(r) {
  const chosen = printChoices.get(r.token);
  printChoices.delete(r.token);
  if (!chosen) {
    r.kind = 'print-settings';
    return showPicker(r);
  }
  sendToPrinter(r, chosen);
}

function sendToPrinter(r, choices) {
  printing.printFile(r.file, r.title, choices).then(
    () => write({ answer: r.id, result: { printed: true } }),
    (e) => {
      printing.tell({ error: e.message });
      write({ answer: r.id, result: null });
    },
  );
  open.delete(r.id);
}

/** The print sheet's answer: to the program that asked first, or for the document that came without choices. */
function answerPrint(req, choices) {
  if (!choices || !String(choices.printer || '')) return write({ answer: req.id, result: null });
  if (req.file) return sendToPrinter(req, choices);
  const token = ++seq;
  printChoices.set(token, choices);
  for (const old of [...printChoices.keys()].slice(0, -20)) printChoices.delete(old);
  write({ answer: req.id, result: { ...printing.portalSettings(choices), token } });
}

/** The person's answer: { paths, filter } for a file picker, { allow } for Access; null when they canceled. */
function answer(id, result) {
  const req = open.get(Number(id));
  if (!open.delete(Number(id))) return;
  if (req.kind === 'print-settings') return answerPrint(req, result?.print);
  let r = null;
  if (result && typeof result === 'object') {
    r = {};
    if (Array.isArray(result.paths)) r.paths = result.paths.filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, 1000);
    if (typeof result.filter === 'string') r.filter = result.filter;
    if ('allow' in result) r.allow = !!result.allow;
  }
  write({ answer: Number(id), result: r });
}

/** A password for a polkit request: resolves { ok, error } once polkit's helper has checked it. */
function auth(id, password) {
  if (!child || !open.has(Number(id))) return Promise.resolve({ ok: false, error: 'This request is gone' });
  const n = ++seq;
  return new Promise((resolve) => {
    replies.set(n, (r) => {
      if (r.ok) open.delete(Number(id));
      resolve(r);
    });
    write({ auth: Number(id), seq: n, password: String(password) });
  });
}

// What the desktop page shows: the file picker has its own window.
const list = () => [...open.values()].filter((r) => !FILE_KINDS.has(r.kind));

function stop() {
  stopped = true;
  child?.kill();
  for (const id of [...pickers.keys()]) closePicker(id);
}

module.exports = { init, answer, auth, list, stop, patternsFor };
