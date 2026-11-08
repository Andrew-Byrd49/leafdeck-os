// Printing with Leafdeck's own print sheet (public/js/printui.js) on Linux, in place of GTK's print dialog. The
// printers come from CUPS through Chromium; the page is laid out as a PDF (paper size, margins, scale, headers and
// footers, the pages you chose), which is the preview (served to the UI at /~print-preview) and, through CUPS's `lp`,
// exactly what the printer gets. The printer's own choices (paper sizes, trays, paper types, quality) come from its
// PPD through `lpoptions`. Without `lp`, printing goes through Chromium with the options it understands. "Save as PDF"
// writes the same PDF to a file you pick.
//
// A job is a page on screen, or a document: a PDF prints as it is (its own bytes, with only the pages you chose), and
// other files are laid out in a hidden window first. Chromium's PDF viewer has its own Print button and Ctrl+P, which
// would open GTK's dialog: watch() takes them over, inside the viewer. Other programs reach the sheet through the
// desktop portal (electron/osdesktop.cjs); portalSettings() and printFile() are for them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { BrowserWindow, dialog, app } = require('electron');

let host = () => null; // the Leafdeck window
let canPrint = () => false; // (webContents) => whether the UI may print it: Leafdeck's own page or one of its webviews
let appOrigin = ''; // where Leafdeck's page comes from: /~file and /~print-preview are on it
// job id -> { contents, hidden (a window made only for printing), title, url, whole: { key, pdf, pages } }, or a document
// (no contents): { pdf (its bytes), title, doc (pdf-lib's document, null when it can't be read: a locked PDF) }
const jobs = new Map();
const previews = new Map(); // preview key -> PDF bytes, or the HTML of a file being laid out
const ppdCache = new Map(); // printer name -> { at, options }
let seq = 0;
const LP = '/usr/bin/lp';
const hasLp = () => process.platform === 'linux' && fs.existsSync(LP);

function init(opts) {
  host = opts.host;
  canPrint = opts.canPrint;
  appOrigin = opts.appOrigin || '';
}

const tell = (what) => host()?.webContents.send('shell:print', what);

/** A page's title for the sheet, the PDF's name and the job's name: not its address (a page without a <title>). */
const titleOf = (contents) => {
  const t = (contents.getTitle() || '').trim();
  return !t || t === contents.getURL() || /^(data|about|blob|leafdeck|file):/i.test(t) ? '' : t;
};

const jobTitle = (job) => job.title || (job.contents ? titleOf(job.contents) : '');

const jobOf = (id) => {
  const job = jobs.get(Number(id));
  if (!job || job.contents?.isDestroyed()) throw new Error('That page is gone');
  return job;
};

/** Open the print sheet for what's laid out in a window (the context menu, the page's own print()). */
function open(contents, { hidden = null, title = '' } = {}) {
  const win = host();
  if (!win || (!hidden && !canPrint(contents))) return null;
  const id = ++seq;
  const url = hidden ? '' : contents.getURL();
  const job = { contents, hidden, title, url: /^https?:/.test(url) ? url : '' };
  jobs.set(id, job);
  contents.once('destroyed', () => jobs.delete(id));
  win.webContents.send('shell:print', {
    id,
    webContentsId: contents === win.webContents || hidden ? 0 : contents.id,
    title: jobTitle(job),
    url: job.url,
    lp: hasLp(),
  });
  return id;
}

/**
 * Print what a webview shows (Ctrl+P, File → Print, the page's own print()): the PDF, when there's one on the page. It's
 * what the person is after, and Chromium never finishes laying out a page with a PDF embedded in it.
 */
async function page(contents) {
  if (contents === host()?.webContents) return open(contents);
  const frame = viewerFrames(contents)[0];
  const url = frame && (await frame.executeJavaScript(`document.querySelector('pdf-viewer')?.originalUrl || ''`, true).catch(() => ''));
  if (url) return printViewer(contents, frame, url);
  return open(contents);
}

/** A window to lay something out in, never shown, that runs nothing the file has in it. */
const layoutWindow = () => new BrowserWindow({ show: false, webPreferences: { session: host()?.webContents.session, javascript: false, sandbox: true } });

/** Print some HTML of Leafdeck's own: it's laid out in a hidden window, then the sheet opens for it. */
async function openHtml(html, { title = '' } = {}) {
  const w = layoutWindow();
  const key = `html-${++seq}`;
  previews.set(key, String(html));
  try {
    await w.loadURL(`${appOrigin}/~print-preview?k=${encodeURIComponent(key)}`);
  } finally {
    previews.delete(key);
  }
  return open(w.webContents, { hidden: w, title });
}

/* ----- Documents: a file, or a PDF on screen ----- */

const nameOf = (file) => path.basename(file);
const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const WEB_PAGE = /\.(html?|xhtml)$/i;
const OFFICE = /\.(docx?|docm|odt|rtf|xlsx?|xlsm|ods|pptx?|odp)$/i;
const MAX_TEXT = 20 * 1024 * 1024;
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Print a PDF's bytes: the sheet opens for them as they are. */
function openPdf(pdf, title, { contents = null } = {}) {
  const win = host();
  if (!win) return null;
  const id = ++seq;
  jobs.set(id, { pdf, title });
  win.webContents.send('shell:print', { id, webContentsId: contents && contents !== win.webContents ? contents.id : 0, title, document: true, lp: hasLp() });
  return id;
}

/** The app that turns office documents into PDFs, where the computer has one. */
const officeApp = () => {
  for (const dir of (process.env.PATH || '/usr/bin').split(':')) {
    for (const name of ['soffice', 'libreoffice']) if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return '';
};

async function officeToPdf(file) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'leafdeck-print-'));
  try {
    await new Promise((resolve, reject) =>
      execFile(officeApp(), ['--headless', '--norestore', `-env:UserInstallation=file://${tmp}/profile`, '--convert-to', 'pdf', '--outdir', tmp, file], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve())),
    );
    return await fs.promises.readFile(path.join(tmp, `${path.basename(file, path.extname(file))}.pdf`));
  } finally {
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Print a file (Files, the desktop). Resolves to '', or what to tell the person when it can't be printed. */
async function openFile(file) {
  const p = path.resolve(String(file));
  const name = nameOf(p);
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return `“${name}” isn’t a file`;
    if (/\.pdf$/i.test(p)) {
      const pdf = await fs.promises.readFile(p);
      if (pdf.subarray(0, 1024).indexOf('%PDF') < 0) return `“${name}” isn’t a PDF that can be printed`;
      openPdf(pdf, name);
    } else if (OFFICE.test(p)) {
      if (!officeApp()) return `Leafdeck can’t print ${path.extname(p).slice(1).toLowerCase()} files yet: there’s no office app on this computer to lay them out.`;
      tell({ notice: `Getting “${name}” ready to print…` });
      openPdf(await officeToPdf(p), name);
    } else if (PICTURE.test(p)) {
      const src = `/~file?p=${encodeURIComponent(p)}`;
      await openHtml(`<!doctype html><meta charset="utf-8"><title>${htmlEsc(name)}</title><style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100vh;object-fit:contain}</style><img src="${htmlEsc(src)}" alt="">`, { title: name });
    } else if (WEB_PAGE.test(p)) {
      const w = layoutWindow();
      await w.loadFile(p);
      open(w.webContents, { hidden: w, title: name });
    } else {
      if (st.size > MAX_TEXT) return `“${name}” is too long to print`;
      const bytes = await fs.promises.readFile(p);
      if (bytes.subarray(0, 8192).includes(0)) return `Leafdeck can’t print this kind of file yet`;
      await openHtml(`<!doctype html><meta charset="utf-8"><title>${htmlEsc(name)}</title><style>body{margin:0}pre{margin:0;font:10.5pt/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>${htmlEsc(bytes.toString('utf8'))}</pre>`, { title: name });
    }
    return '';
  } catch (e) {
    return `Couldn’t print “${name}”: ${e.message}`;
  }
}

/* ----- Chromium's PDF viewer: its Print button and Ctrl+P open the sheet -----
   They end in the viewer's pluginController_.print(), which Chromium answers with the system's dialog, and Electron has
   no event for it, so the viewer's own function is replaced, in the viewer's frame. */

const VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';
const viewerFrames = (contents) => {
  try {
    return contents.mainFrame.framesInSubtree.filter((f) => f.url.startsWith(VIEWER));
  } catch {
    return [];
  }
};
// Resolves with the document's address when someone asks to print, or '' if the viewer never came up.
const TAKE_PRINT = `new Promise((resolve) => {
  const until = Date.now() + 60000;
  const tick = () => {
    const v = document.querySelector('pdf-viewer');
    const c = v && v.pluginController_;
    if (!c) return Date.now() > until ? resolve('') : setTimeout(tick, 100);
    const asked = () => resolve(v.originalUrl || location.href);
    c.print = asked;
    if (v.currentController) v.currentController.print = asked; // the same one, unless the viewer is drawing with ink
  };
  tick();
})`;
// Chromium's own print, past that: for a document with no address to fetch again (a link that only works once, a blob:).
// It asks the desktop portal, and that's the print sheet as well (electron/osdesktop.cjs), just with no preview.
const PRINT_ITSELF = `(() => {
  const c = document.querySelector('pdf-viewer').pluginController_;
  Object.getPrototypeOf(c).print.call(c);
})()`;
// Without the portal's Print, Chromium falls back on GTK's own dialog: asking also starts the portal if it isn't running.
const portalPrints = () =>
  new Promise((resolve) =>
    execFile('gdbus', ['introspect', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop'], { timeout: 5000 }, (err, out) =>
      resolve(!err && /interface org\.freedesktop\.portal\.Print\b/.test(String(out))),
    ),
  );
const watched = new WeakSet();

function takeViewers(contents) {
  for (const frame of viewerFrames(contents)) {
    if (watched.has(frame)) continue;
    watched.add(frame);
    (async () => {
      for (;;) {
        const url = await frame.executeJavaScript(TAKE_PRINT, true);
        if (!url) return;
        printViewer(contents, frame, url).catch((e) => console.warn('[print]', e.message));
      }
    })().catch(() => {}); // the viewer closed
  }
}

/** Keep a page's PDF viewers (now and later ones) printing through the sheet. */
function watch(contents) {
  contents.on('did-frame-finish-load', () => takeViewers(contents));
}

/** The name to print a document under, from its address. */
function docTitle(contents, url) {
  const title = (contents !== host()?.webContents && titleOf(contents)) || '';
  if (title) return title;
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'Document';
  } catch {
    return 'Document';
  }
}

/** Someone asked to print the PDF in a viewer: get its bytes and open the sheet. */
async function printViewer(contents, frame, url) {
  if (contents.isDestroyed() || !canPrint(contents) || !URL.canParse(url)) return null;
  const u = new URL(url);
  const ours = url.startsWith(`${appOrigin}/`); // not u.origin: it's "null" for a scheme of our own
  if (ours && u.pathname === '/~print-preview') return null; // the sheet's own preview
  const own = ours && u.pathname === '/~file';
  if (own || u.protocol === 'file:') {
    // A file on this computer, shown by Leafdeck's page or by a tab of a file (never one a site embeds).
    const fromPage = contents === host()?.webContents || contents.getURL().startsWith('file:');
    if (!fromPage) return null;
    const problem = await openFile(own ? u.searchParams.get('p') || '' : decodeURIComponent(u.pathname));
    if (problem) tell({ error: problem });
    return null;
  }
  let pdf = null;
  if (/^https?:$/.test(u.protocol)) {
    try {
      const res = await contents.session.fetch(url, { credentials: 'include' });
      if (res.ok) pdf = Buffer.from(await res.arrayBuffer());
    } catch {
      // Offline, or gone by now: Chromium still has what it showed.
    }
  }
  if (!pdf || pdf.subarray(0, 1024).indexOf('%PDF') < 0) {
    if (await portalPrints()) await frame.executeJavaScript(PRINT_ITSELF, true);
    else tell({ error: 'Couldn’t get this PDF to print it. Download it, then print the downloaded file.' });
    return null;
  }
  return openPdf(pdf, docTitle(contents, url), { contents });
}

/* ----- Printers and their options ----- */

const STATE = { 3: 'Ready', 4: 'Printing', 5: 'Stopped' }; // CUPS printer-state
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout))));

/**
 * The printers CUPS can print to, with what `lpoptions -p` knows about each: its name for people, where it is. `lpstat -e`
 * has them all; `lpstat -p` only the ones added by hand, not the ones CUPS finds on the network by itself, but it knows
 * how the added ones are doing.
 */
async function cupsPrinters() {
  const [all, list, def] = await Promise.all([run('/usr/bin/lpstat', ['-e']), run('/usr/bin/lpstat', ['-p']), run('/usr/bin/lpstat', ['-d'])]);
  const defName = (/destination:\s*(\S+)/.exec(def) || [])[1] || '';
  const found = new Map();
  for (const line of all.split('\n')) if (/^\S+$/.test(line.trim())) found.set(line.trim(), { name: line.trim(), state: '' });
  for (const line of list.split('\n')) {
    const m = /^printer (\S+) (is idle|now printing|disabled)/.exec(line);
    if (m) found.set(m[1], { name: m[1], state: { 'is idle': 'Ready', 'now printing': 'Printing', disabled: 'Stopped' }[m[2]] });
  }
  return Promise.all(
    [...found.values()].map(async (p) => {
      const attrs = {};
      for (const m of (await run('/usr/bin/lpoptions', ['-p', p.name])).matchAll(/(\S+?)=(?:'([^']*)'|"([^"]*)"|(\S+))/g)) attrs[m[1]] = m[2] ?? m[3] ?? m[4];
      const state = attrs['printer-is-accepting-jobs'] === 'false' ? 'Not accepting jobs' : p.state;
      return {
        name: p.name,
        displayName: attrs['printer-info'] || p.name.replace(/_/g, ' '),
        description: attrs['printer-info'] || '',
        location: attrs['printer-location'] || '',
        model: attrs['printer-make-and-model'] || '',
        isDefault: p.name === defName,
        state,
      };
    }),
  );
}

const chromiumPrinters = async (contents) =>
  (await contents.getPrintersAsync()).map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    description: p.description || '',
    location: p.options?.['printer-location'] || '',
    model: p.options?.['printer-make-and-model'] || '',
    isDefault: !!p.isDefault,
    state: STATE[p.status] || '',
  }));

let printerList = { at: 0, list: [] };

/** The printers to offer: CUPS's own list (what `lp` prints to), or Chromium's where there's no `lp`. */
async function printers() {
  if (hasLp()) {
    if (printerList.list.length && Date.now() - printerList.at < 30_000) return printerList.list; // asking takes a second or more
    const list = await cupsPrinters();
    printerList = { at: Date.now(), list };
    if (list.length) return list;
  }
  const contents = host()?.webContents;
  return contents ? chromiumPrinters(contents) : [];
}

// Paper sizes: inches, by the names printers (PPDs) and Chromium use. PWG names (na_letter_8.5x11in) carry their size.
const PAPER = {
  Letter: [8.5, 11, 'Letter'], Legal: [8.5, 14, 'Legal'], Tabloid: [11, 17, 'Tabloid'], Ledger: [17, 11, 'Ledger'],
  Executive: [7.25, 10.5, 'Executive'], Statement: [5.5, 8.5, 'Statement'], Oficio: [8.5, 13.4, 'Oficio'],
  A3: [11.69, 16.54, 'A3'], A4: [8.27, 11.69, 'A4'], A5: [5.83, 8.27, 'A5'], A6: [4.13, 5.83, 'A6'],
  B4: [9.84, 13.9, 'B4'], B5: [6.93, 9.84, 'B5'], Env10: [4.13, 9.5, 'Envelope #10'], EnvDL: [4.33, 8.66, 'Envelope DL'],
  EnvC5: [6.38, 9.02, 'Envelope C5'], EnvMonarch: [3.88, 7.5, 'Envelope Monarch'],
  '3.5x5': [3.5, 5, '3.5 × 5 photo'], '4x6': [4, 6, '4 × 6 photo'], '5x7': [5, 7, '5 × 7 photo'], '8x10': [8, 10, '8 × 10 photo'],
};
const STANDARD = ['Letter', 'Legal', 'Tabloid', 'Executive', 'Statement', 'A3', 'A4', 'A5', 'Env10', 'EnvDL'];
// The usual sizes first, in a familiar order; a printer's other sizes (photo paper, odd envelopes) after them.
const ORDER = [...STANDARD, 'Ledger', 'Oficio', 'A6', 'B4', 'B5', 'EnvC5', 'EnvMonarch'];
const rank = (p) => (ORDER.includes(p.name) ? ORDER.indexOf(p.name) : ORDER.length + (PAPER[p.name] ? 0 : 1));
const sortPapers = (list) => list.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
const mm = (inches) => Math.round(inches * 25.4);
const dims = (w, h, metric) => (metric ? `${mm(w)} × ${mm(h)} mm` : `${+w.toFixed(2)} × ${+h.toFixed(2)} in`);

/** A paper size by its name: { name, label, width, height } (inches), or null for one we don't know. */
function paper(name) {
  const known = PAPER[name];
  if (known) return { name, label: `${known[2]} (${dims(known[0], known[1], /^(A|B|Env(DL|C5))/.test(name))})`, width: known[0], height: known[1] };
  const m = /^(?:[a-z]+_)?([a-z0-9-]+)_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(in|mm)$/i.exec(name); // PWG self-describing names
  if (!m) return null;
  const [w, h] = m[4] === 'mm' ? [Number(m[2]) / 25.4, Number(m[3]) / 25.4] : [Number(m[2]), Number(m[3])];
  const pretty = m[1].replace(/^(na-|iso-|jis-|jpn-|prc-|om-)/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { name, label: `${pretty} (${dims(w, h, m[4] === 'mm')})`, width: w, height: h };
}

const standardPapers = () => STANDARD.map(paper);

// A PPD option's choices, labeled for people: "DuplexNoTumble" says little, "PhotographicHighGloss" less.
const CHOICE = {
  Auto: 'Automatic', Main: 'Main tray', Alternate: 'Alternate tray', Rear: 'Rear tray', Manual: 'Manual feed', Upper: 'Upper tray', Lower: 'Lower tray',
  Stationery: 'Plain paper', StationeryPreprinted: 'Preprinted', StationeryLetterhead: 'Letterhead', StationeryColored: 'Colored paper',
  StationeryCoated: 'Coated paper', StationeryHeavyweight: 'Heavyweight paper', Photographic: 'Photo paper', PhotographicHighGloss: 'High-gloss photo paper',
  PhotographicGlossy: 'Glossy photo paper', PhotographicSemiGloss: 'Semi-gloss photo paper', PhotographicMatte: 'Matte photo paper', Envelope: 'Envelope',
  Labels: 'Labels', Transparency: 'Transparency', Cardstock: 'Cardstock', Draft: 'Draft', Normal: 'Normal', High: 'High', FaceUp: 'Face up', FaceDown: 'Face down',
};
const words = (s) => String(s).replace(/^Com\.[a-z]+(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).trim();
const choiceLabel = (v) => CHOICE[v] || words(v);

/**
 * What a printer offers, from its PPD (`lpoptions -l`): paper sizes it knows, whether it prints on both sides and in
 * color, and the choices worth a control (tray, paper type, quality, output bin) as { key, label, value, choices }.
 */
async function printerOptions(name) {
  if (!name || !hasLp()) return null;
  const cached = ppdCache.get(name);
  if (cached && Date.now() - cached.at < 60_000) return cached.options;
  // A printer found on the network is asked over the network: 7 seconds was seen, for one that's working.
  const out = await new Promise((resolve) => execFile('/usr/bin/lpoptions', ['-p', name, '-l'], { timeout: 20_000 }, (err, stdout) => resolve(err ? '' : String(stdout))));
  if (!out) return { papers: null, duplex: null, color: null, extras: [] }; // not an answer to remember
  const options = { papers: null, duplex: null, color: null, extras: [] };
  for (const line of out.split('\n')) {
    const m = /^([^/:]+)\/([^:]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const choices = m[3].split(/\s+/).filter(Boolean);
    const value = (choices.find((c) => c.startsWith('*')) || choices[0] || '').replace(/^\*/, '');
    const plain = choices.map((c) => c.replace(/^\*/, ''));
    if (key === 'PageSize') {
      options.papers = sortPapers(plain.filter((c) => !/\.|Custom/i.test(c)).map(paper).filter(Boolean));
      if (options.papers.length) options.paper = options.papers.some((p) => p.name === value) ? value : options.papers[0].name;
    } else if (key === 'Duplex') options.duplex = plain.some((c) => c !== 'None');
    else if (key === 'ColorModel') options.color = plain.some((c) => /RGB|CMYK|Color/i.test(c));
    else if (['InputSlot', 'MediaType', 'cupsPrintQuality', 'Resolution', 'OutputBin'].includes(key) && plain.length > 1) {
      const label = { InputSlot: 'Paper source', MediaType: 'Paper type', cupsPrintQuality: 'Quality', Resolution: 'Resolution', OutputBin: 'Output tray' }[key];
      if (key === 'Resolution' && options.extras.some((x) => x.key === 'cupsPrintQuality')) continue; // one quality control
      options.extras.push({ key, label, value, choices: plain.map((c) => ({ value: c, label: choiceLabel(c) })) });
    }
  }
  ppdCache.set(name, { at: Date.now(), options });
  return options;
}

/* ----- The PDF: what the preview shows and the printer gets ----- */

// Chromium's page ranges are 0-based; the sheet's "1-3, 5" is how people count.
function ranges(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from >= 1 && to >= from) out.push({ from: from - 1, to: to - 1 });
  }
  return out;
}

/** The pages to print as Chromium's "1-3,5" (1-based), or '' for all of them. `total` resolves odd and even pages. */
function pageRanges(o, total) {
  if (o.pagesMode === 'odd' || o.pagesMode === 'even') {
    const want = o.pagesMode === 'odd' ? 1 : 0;
    return Array.from({ length: total }, (_, i) => i + 1).filter((n) => n % 2 === want).join(',');
  }
  if (o.pagesMode === 'custom') return ranges(o.pages).filter((r) => r.from < total).map((r) => `${r.from + 1}-${Math.min(r.to, total - 1) + 1}`).join(',');
  return '';
}

const inches = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(3, Number(v)) : fallback);

function margins(o) {
  const def = 0.4; // Chromium's own (1 cm)
  switch (o.margins) {
    case 'none': return { top: 0, bottom: 0, left: 0, right: 0 };
    case 'minimal': return { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 };
    case 'custom': return { top: inches(o.marginTop, def), bottom: inches(o.marginBottom, def), left: inches(o.marginLeft, def), right: inches(o.marginRight, def) };
    default: return { top: def, bottom: def, left: def, right: def };
  }
}

const HF = 'font-size:8.5px;font-family:system-ui,sans-serif;color:#666;width:100%;padding:0 0.4in;display:flex;justify-content:space-between;gap:12px;';
const CELL = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

/** printToPDF's options for the sheet's choices (without the page ranges). */
function pdfOptions(o = {}, job = {}) {
  const size = paper(o.pageSize) || paper('Letter');
  const m = margins(o);
  const headers = !!o.headers;
  if (headers) {
    // Headers and footers are drawn inside the margins; make room for them.
    m.top = Math.max(m.top, 0.4);
    m.bottom = Math.max(m.bottom, 0.4);
  }
  return {
    landscape: !!o.landscape,
    printBackground: o.backgrounds !== false,
    pageSize: PAPER[size.name] && ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid', 'Ledger'].includes(size.name) ? size.name : { width: size.width, height: size.height },
    margins: m,
    scale: Math.min(2, Math.max(0.1, (Number(o.scale) || 100) / 100)),
    displayHeaderFooter: headers,
    headerTemplate: headers ? `<div style="${HF}"><span class="date" style="${CELL}"></span><span class="title" style="${CELL}"></span></div>` : undefined,
    footerTemplate: headers
      ? `<div style="${HF}"><span style="${CELL}">${job.url ? '<span class="url"></span>' : ''}</span><span style="flex:none"><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`
      : undefined,
  };
}

/** How many pages a PDF has (Chromium writes each page's object in plain text). */
const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

/** pdf-lib (electron/vendor), loaded when it's first needed: half a megabyte most sessions never use. */
const pdfLib = () => require('./vendor/pdf-lib/pdf-lib.min.cjs');

/**
 * A document with only the pages you chose. A PDF that can't be opened to take pages out (a locked one) keeps them all,
 * and `lp` says which to print to CUPS instead.
 */
async function renderDocument(job, o) {
  if (job.doc === undefined) {
    job.doc = await pdfLib().PDFDocument.load(job.pdf, { updateMetadata: false }).catch(() => null);
  }
  const total = job.doc ? job.doc.getPageCount() : pageCount(job.pdf);
  if (!job.doc) {
    const lp = o.pagesMode === 'odd' || o.pagesMode === 'even' ? { 'page-set': o.pagesMode } : o.pagesMode === 'custom' ? { 'page-ranges': ranges(o.pages).map((r) => `${r.from + 1}-${r.to + 1}`).join(',') } : null;
    return { pdf: job.pdf, pages: total, total, lp };
  }
  const chosen = pageRanges(o, total);
  if (o.pagesMode === 'even' && !chosen) throw new Error('The document has no even pages');
  if (o.pagesMode === 'custom' && !chosen) throw new Error(total === 1 ? 'The document has only 1 page' : `Choose pages between 1 and ${total}`);
  if (!chosen) return { pdf: job.pdf, pages: total, total };
  const want = chosen.split(',').flatMap((part) => {
    const [from, to = from] = part.split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  });
  const out = await pdfLib().PDFDocument.create();
  for (const pg of await out.copyPages(job.doc, want)) out.addPage(pg);
  return { pdf: Buffer.from(await out.save()), pages: want.length, total };
}

/** printToPDF, but a page that never finishes (Chromium has no limit of its own) ends in a message on the sheet. */
function layOut(contents, options) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('This page didn’t finish laying out for printing')), 45_000);
  });
  return Promise.race([contents.printToPDF(options), late]).finally(() => clearTimeout(timer));
}

/** The page as a PDF with the sheet's choices: { pdf, pages, total } (the pages it has, and the whole page's count). */
async function render(job, o) {
  if (job.pdf) return renderDocument(job, o);
  const base = pdfOptions(o, job);
  const key = JSON.stringify(base);
  // The whole page (every page) is rendered once per layout: it's the preview for "all pages" and the count for the rest.
  if (!job.whole || job.whole.key !== key) {
    const pdf = await layOut(job.contents, base);
    job.whole = { key, pdf, pages: pageCount(pdf) };
  }
  const total = job.whole.pages;
  const pageRangesText = pageRanges(o, total);
  if (o.pagesMode === 'even' && !pageRangesText) throw new Error('The page has no even pages');
  if (o.pagesMode === 'custom' && !pageRangesText) throw new Error(total === 1 ? 'The page has only 1 page' : `Choose pages between 1 and ${total}`);
  if (!pageRangesText) return { pdf: job.whole.pdf, pages: total, total };
  const pdf = await layOut(job.contents, { ...base, pageRanges: pageRangesText });
  return { pdf, pages: pageCount(pdf), total };
}

/** The sheet's preview: an address the UI can show in a frame, with the page counts. */
async function preview(id, o) {
  const job = jobOf(id);
  const { pdf, pages, total } = await render(job, o);
  const key = `${id}-${++seq}`;
  for (const k of previews.keys()) if (k.startsWith(`${id}-`)) previews.delete(k); // one preview per job
  previews.set(key, pdf);
  return { url: `/~print-preview?k=${encodeURIComponent(key)}`, pages, total };
}

function servePreview(request) {
  const pdf = previews.get(new URL(request.url).searchParams.get('k') || '');
  if (!pdf) return new Response('Not found', { status: 404 });
  if (typeof pdf === 'string') return new Response(pdf, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff' } });
}

/* ----- Printing ----- */

const copiesOf = (o) => Math.max(1, Math.min(99, Number(o.copies) || 1));
const PER_SHEET = [1, 2, 4, 6, 9, 16];
const perSheet = (o) => (PER_SHEET.includes(Number(o.perSheet)) ? Number(o.perSheet) : 1);
const sides = (o) => ({ long: 'two-sided-long-edge', short: 'two-sided-short-edge' })[o.sides] || 'one-sided';

/** Print: the PDF through `lp`, so what you saw is what comes out. Resolves to { job: 'printer-12', pages }. */
async function print(id, o = {}) {
  const job = jobOf(id);
  if (!o.printer) throw new Error('Choose a printer');
  if (!hasLp()) {
    if (!job.contents) throw new Error('This computer has no printing service');
    return printWithChromium(job, o);
  }
  const { pdf, pages, lp } = await render(job, o);
  const file = path.join(app.getPath('temp'), `leafdeck-print-${process.pid}-${++seq}.pdf`);
  await fs.promises.writeFile(file, pdf, { mode: 0o600 });
  try {
    // A document keeps its own pages: each one is fitted to the paper, the way it's turned.
    const printed = await printFile(file, jobTitle(job), o, job.pdf ? { 'fit-to-page': 'true', ...lp } : {});
    return { job: printed, pages };
  } finally {
    fs.promises.unlink(file).catch(() => {}); // lp has handed it to CUPS, which keeps its own copy
  }
}

/** Hand a file to CUPS with the sheet's choices. Resolves to its job's name ('printer-12'). */
async function printFile(file, title, o, more = {}) {
  if (!o.printer) throw new Error('Choose a printer');
  if (!hasLp()) throw new Error('This computer has no printing service');
  const args = ['-d', String(o.printer), '-n', String(copiesOf(o)), '-t', (title || 'Leafdeck').slice(0, 120)];
  const opt = (k, v) => args.push('-o', `${k}=${v}`);
  for (const [k, v] of Object.entries(more)) opt(k, v);
  const size = paper(o.pageSize);
  if (size) opt('media', size.name);
  opt('sides', sides(o));
  opt('print-color-mode', o.color === false ? 'monochrome' : 'color');
  if (perSheet(o) > 1) opt('number-up', perSheet(o));
  if (copiesOf(o) > 1) opt('collate', o.collate === false ? 'false' : 'true');
  for (const [k, v] of Object.entries(o.extras || {})) if (/^[A-Za-z]+$/.test(k) && /^[\w.-]+$/.test(String(v))) opt(k, v);
  args.push(file);
  const out = await new Promise((resolve, reject) =>
    execFile(LP, args, { timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(lpError(stderr || err.message))) : resolve(String(stdout)))),
  );
  return (/request id is (\S+)/.exec(out) || [])[1] || '';
}

/* ----- Another program's print, through the desktop portal: what the sheet chose, the way GTK writes it ----- */

const GTK_PAPER = { Letter: 'na_letter', Legal: 'na_legal', Executive: 'na_executive', Tabloid: 'na_ledger', A3: 'iso_a3', A4: 'iso_a4', A5: 'iso_a5', A6: 'iso_a6', B5: 'iso_b5' };

function portalSettings(o) {
  const size = paper(o.pageSize) || paper('Letter');
  const [w, h] = [size.width * 25.4, size.height * 25.4];
  const custom = o.pagesMode === 'custom' ? ranges(o.pages) : [];
  const orientation = o.landscape ? 'landscape' : 'portrait';
  const format = GTK_PAPER[size.name] || size.name;
  return {
    settings: {
      printer: String(o.printer || ''),
      // Always one: the printer makes the copies and fits pages to a sheet (printFile). GTK 3 would do both in the file
      // as well, so two copies would come out as four.
      'n-copies': '1',
      collate: String(o.collate !== false),
      'use-color': String(o.color !== false),
      duplex: { long: 'horizontal', short: 'vertical' }[o.sides] || 'simplex', // GTK's names: horizontal flips on the long edge
      orientation,
      'number-up': '1',
      'paper-format': format,
      'paper-width': String(w),
      'paper-height': String(h),
      'print-pages': custom.length ? 'ranges' : 'all',
      'page-ranges': custom.map((r) => `${r.from}-${r.to}`).join(','),
      'page-set': o.pagesMode === 'odd' || o.pagesMode === 'even' ? o.pagesMode : 'all',
      ...Object.fromEntries(Object.entries(o.extras || {}).filter(([k, v]) => /^[A-Za-z]+$/.test(k) && /^[\w.-]+$/.test(String(v)))),
    },
    pageSetup: { PPDName: size.name, Name: format, DisplayName: size.label, Width: w, Height: h, MarginTop: 6.35, MarginBottom: 6.35, MarginLeft: 6.35, MarginRight: 6.35, Orientation: orientation },
  };
}

const lpError = (text) => {
  const t = String(text || '').replace(/^lp:\s*/, '').trim();
  if (/not accepting|is stopped|disabled/i.test(t)) return 'The printer isn’t accepting jobs right now';
  if (/unknown destination|does not exist/i.test(t)) return 'That printer is gone';
  if (/scheduler is not running|connection refused/i.test(t)) return 'The printing service isn’t running';
  return `Couldn’t print: ${t || 'the printer didn’t answer'}`;
};

/** Without `lp`: Chromium prints the page itself, with the choices it understands. */
function printWithChromium(job, o) {
  const size = paper(o.pageSize) || paper('Letter');
  const m = margins(o);
  return new Promise((resolve, reject) =>
    job.contents.print(
      {
        silent: true,
        deviceName: String(o.printer || ''),
        copies: copiesOf(o),
        collate: o.collate !== false,
        landscape: !!o.landscape,
        color: o.color !== false,
        printBackground: o.backgrounds !== false,
        pageRanges: ranges(pageRanges(o, job.whole?.pages || 9999) || '1-9999'),
        pageSize: PAPER[size.name] && ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid'].includes(size.name) ? size.name : { width: mm(size.width) * 1000, height: mm(size.height) * 1000 },
        duplexMode: { long: 'longEdge', short: 'shortEdge' }[o.sides] || 'simplex',
        scaleFactor: Math.min(200, Math.max(10, Number(o.scale) || 100)),
        pagesPerSheet: perSheet(o),
        margins: o.margins === 'none' ? { marginType: 'none' } : o.margins && o.margins !== 'default' ? { marginType: 'custom', top: m.top * 96, bottom: m.bottom * 96, left: m.left * 96, right: m.right * 96 } : { marginType: 'default' },
      },
      (ok, reason) => (ok ? resolve({ job: '', pages: 0 }) : reject(new Error(reason === 'cancelled' ? 'Printing was canceled' : `Couldn’t print: ${reason || 'the printer didn’t answer'}`))),
    ),
  );
}

/** Save as PDF: asks where (Leafdeck's own file picker in Leafdeck OS, through the desktop portal). */
async function savePdf(id, o = {}) {
  const job = jobOf(id);
  const name = (jobTitle(job).replace(/\.pdf$/i, '') || 'Page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'Page';
  const pick = await dialog.showSaveDialog(host(), {
    title: 'Save as PDF',
    defaultPath: path.join(app.getPath('documents'), `${name}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  const { pdf, pages, lp } = await render(job, o);
  if (lp) throw new Error('This PDF is locked, so only all of its pages can be saved');
  await fs.promises.writeFile(pick.filePath, pdf);
  return { file: pick.filePath, pages };
}

/** The sheet closed: forget the job (and the window made for it). */
function done(id) {
  const job = jobs.get(Number(id));
  jobs.delete(Number(id));
  for (const k of previews.keys()) if (k.startsWith(`${id}-`)) previews.delete(k);
  if (job?.hidden && !job.hidden.isDestroyed()) job.hidden.destroy();
}

module.exports = { init, open, page, openFile, watch, printers, printerOptions, standardPapers, preview, servePreview, print, printFile, portalSettings, tell, savePdf, done };
