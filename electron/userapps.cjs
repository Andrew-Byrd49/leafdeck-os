// User apps: small web apps you build with an AI coding agent (Claude Code, Codex) that run inside Leafdeck.
//
// Each app is a folder in Documents\Leafdeck Apps\<id>\ with a manifest.json and plain HTML/CSS/JS. Leafdeck serves
// it at leafapp://<id>/ in its own sandboxed webview (own process, no Node, strict CSP), and the app talks to
// Leafdeck only through the `window.leafdeck` bridge (electron/app-preload.cjs → public/js/userapps.js), which checks
// the permissions in its manifest. Apps live outside Leafdeck's own (sealed, integrity-checked) code, so they survive
// updates and can never change the core. Agent guide: electron/app-sdk/GUIDE.md (copied into each app folder).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, shell } = require('electron');

const PARTITION = 'persist:leafapps';
const SCHEME = 'leafapp';
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SDK_DIR = path.join(__dirname, 'app-sdk');
const MAX_LOG = 300;
const MAX_VERSIONS = 20;

/** Built-in collections an app may ask for ("tasks:read", "contacts:write"…). */
const COLLECTIONS = ['tasks', 'notes', 'contacts', 'sprints', 'events', 'bookmarks'];

let deps = null; // { win(), onChange(id|null) }
const logs = new Map(); // app id -> [{ at, level, text }]

// LEAFDECK_APPS_DIR overrides the folder (development and testing).
const appsDir = () => process.env.LEAFDECK_APPS_DIR || path.join(app.getPath('documents'), 'Leafdeck Apps');
const appDir = (id) => {
  if (!ID.test(String(id || ''))) throw new Error('Bad app id');
  return path.join(appsDir(), id);
};

/* ---------------- Manifest ---------------- */

function readManifest(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(appDir(id), 'manifest.json'), 'utf8'));
  return normalizeManifest(id, raw);
}

/** Only the fields Leafdeck understands, with unknown permissions dropped (and reported). */
function normalizeManifest(id, m) {
  const perms = [];
  const ignored = [];
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    const s = String(p).trim().toLowerCase();
    const [what, how] = s.split(':');
    if (COLLECTIONS.includes(what) && ['read', 'write'].includes(how)) perms.push(s);
    else if (s === 'notify') perms.push(s);
    else if (what === 'network' && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(how || '')) perms.push(s);
    // A program of the user's own on this computer (a helper that runs tools for the app), over plain http on loopback.
    else if (what === 'local' && /^\d{4,5}$/.test(how || '') && +how >= 1024 && +how <= 65535) perms.push(s);
    else ignored.push(String(p));
  }
  return {
    id,
    name: String(m.name || id).slice(0, 40),
    description: String(m.description || '').slice(0, 300),
    version: String(m.version || '0.1.0').slice(0, 20),
    icon: /^[a-z-]{2,20}$/.test(m.icon || '') ? m.icon : 'sparkle',
    glyph: typeof m.glyph === 'string' ? [...m.glyph].slice(0, 2).join('') : '',
    color: /^[a-z]{3,10}$/.test(m.color || '') ? m.color : 'green',
    size: Array.isArray(m.size) && m.size.length === 2 ? m.size.map((n) => Math.max(320, Math.min(2400, Number(n) || 800))) : [960, 680],
    permissions: [...new Set(perms)].sort(),
    ignoredPermissions: ignored,
  };
}

function list() {
  let names = [];
  try {
    names = fs.readdirSync(appsDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && ID.test(d.name)).map((d) => d.name);
  } catch {}
  const out = [];
  for (const id of names) {
    try {
      const m = readManifest(id);
      out.push({ ...m, path: appDir(id), modified: newestMtime(appDir(id)), hasIndex: fs.existsSync(path.join(appDir(id), 'index.html')) });
    } catch (err) {
      out.push({ id, name: id, broken: `manifest.json: ${err.message}`, path: appDir(id), permissions: [], modified: 0 });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

function newestMtime(dir) {
  let newest = 0;
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.versions' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  try {
    walk(dir, 0);
  } catch {}
  return newest;
}

/* ---------------- Creating ---------------- */

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'my-app';

function create({ name, description = '' } = {}) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) throw new Error('Give the app a name');
  fs.mkdirSync(appsDir(), { recursive: true });
  let id = slug(name);
  if (id.length < 2) id = 'app-' + id;
  for (let n = 2; fs.existsSync(path.join(appsDir(), id)); n++) id = `${slug(name).slice(0, 33)}-${n}`;
  const dir = appDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name, description: String(description).slice(0, 300), version: '0.1.0', icon: 'sparkle', color: 'green', permissions: [] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'index.html'), starterHtml(name));
  fs.writeFileSync(path.join(dir, 'app.js'), STARTER_JS);
  fs.writeFileSync(path.join(dir, 'style.css'), STARTER_CSS);
  fs.writeFileSync(path.join(dir, 'BRIEF.md'), brief(name, description));
  writeGuides(dir);
  return { ...readManifest(id), path: dir };
}

/** The agent guide, as CLAUDE.md (Claude Code) and AGENTS.md (Codex). Refreshed so apps get the current API. */
function writeGuides(dir) {
  const guide = fs.readFileSync(path.join(SDK_DIR, 'GUIDE.md'), 'utf8');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(dir, f), guide);
}

const brief = (name, description) => `# ${name}

${description ? description.trim() : '(Describe what this app should do.)'}

---
Written by Leafdeck's App Builder. Edit it any time: it's the brief your agent works from.
`;

const starterHtml = (name) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name.replace(/[<>&"]/g, '')}</title>
  <link rel="stylesheet" href="/_leafdeck/app.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <!-- Starter example laid out like a built-in Leafdeck app: controls in the window's title bar (app.js),
       stat tiles, then the main content. No page title: the window already shows the app's name. -->
  <main class="ld-page">
    <div class="ld-summary">
      <div class="ld-stat"><span>Items</span><b id="count">0</b><small>Saved in this app</small></div>
      <div class="ld-stat good"><span>Done</span><b id="done">0</b></div>
    </div>

    <section class="ld-panel">
      <div class="ld-section-title">Items <small id="shown"></small></div>
      <ul id="items" class="ld-list"></ul>
      <div id="empty" class="ld-empty small" hidden>
        <div class="ld-empty-title">Nothing here yet</div>
        <p>This app is ready for your agent. Describe what to build in App Builder.</p>
        <button type="button" class="ld-btn ld-primary" data-new><span data-icon="plus"></span> Add an item</button>
      </div>
    </section>
  </main>

  <!-- Add/edit forms open as a sheet from the top of the window, like Leafdeck's record forms. -->
  <div class="ld-sheet-wrap" id="sheet" hidden>
    <form class="ld-sheet" id="add">
      <div class="ld-sheet-head"><h2>New item</h2></div>
      <div class="ld-sheet-body">
        <label class="ld-field"><span>Name</span><input name="text" required autocomplete="off"></label>
      </div>
      <div class="ld-sheet-foot">
        <button type="button" class="ld-btn" data-close>Cancel</button>
        <button class="ld-btn ld-primary">Add</button>
      </div>
    </form>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;

const STARTER_JS = `// Starter example: a small list kept in this app's own records (synced to every device through Leafdeck).
// It shows the patterns a built-in app uses; see CLAUDE.md / AGENTS.md. Your agent will replace it.
const $ = (sel) => document.querySelector(sel);
let query = '';

// Controls in the window's title bar, drawn by Leafdeck like a built-in app's toolbar.
leafdeck.toolbar.set([
  { type: 'search', id: 'search', placeholder: 'Search items' },
  { type: 'button', id: 'add', icon: 'plus', title: 'New item' },
]);
leafdeck.on('toolbar', ({ id, value }) => {
  if (id === 'search') {
    query = value.toLowerCase();
    draw();
  }
  if (id === 'add') openSheet();
});

async function draw() {
  const items = (await leafdeck.data.list('item')).sort((a, b) => a.createdAt - b.createdAt);
  const shown = items.filter((it) => !query || it.text.toLowerCase().includes(query));
  $('#count').textContent = items.length;
  $('#done').textContent = items.filter((it) => it.done).length;
  $('#shown').textContent = query ? \`\${shown.length} of \${items.length}\` : '';
  $('#empty').hidden = items.length > 0;
  const list = $('#items');
  list.innerHTML = '';
  for (const it of shown) {
    const li = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!it.done;
    box.setAttribute('aria-label', 'Done');
    box.onchange = () => leafdeck.data.save('item', { ...it, done: box.checked });
    const text = document.createElement('span');
    text.className = 'ld-grow';
    text.textContent = it.text;
    const del = document.createElement('button');
    del.className = 'ld-icon-btn';
    del.title = 'Remove';
    del.dataset.icon = 'trash';
    del.onclick = () => leafdeck.data.remove(it.id);
    li.append(box, text, del);
    list.append(li);
  }
}

/* The sheet: open, close on Cancel / Escape / a click outside. */
const sheet = $('#sheet');
function openSheet() {
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  sheet.querySelector('input').focus();
}
function closeSheet() {
  sheet.classList.remove('open');
  setTimeout(() => (sheet.hidden = true), 180);
}
sheet.addEventListener('click', (e) => (e.target === sheet || e.target.closest('[data-close]')) && closeSheet());
addEventListener('keydown', (e) => e.key === 'Escape' && !sheet.hidden && closeSheet());
document.addEventListener('click', (e) => e.target.closest('[data-new]') && openSheet());

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.elements.text;
  if (!input.value.trim()) return;
  await leafdeck.data.save('item', { text: input.value.trim(), done: false });
  input.value = '';
  closeSheet();
});

leafdeck.on('change', draw); // fires when this app's data (or a collection it reads) changes, on any device
leafdeck.ready().then(draw);
`;

const STARTER_CSS = `/* This app's own styles. Leafdeck's base styles come from /_leafdeck/app.css: use its ld-* classes and
   --ld-* colors first, and keep additions here small so the app keeps looking like Leafdeck. */
`;

/* ---------------- Serving (leafapp://<id>/…) ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

/** Scripts only from the app's own folder (no CDNs); network only to hosts (and local ports) the manifest declares. */
function csp(manifest) {
  const hosts = [
    ...manifest.permissions.filter((p) => p.startsWith('network:')).map((p) => 'https://' + p.slice(8)),
    ...manifest.permissions.filter((p) => p.startsWith('local:')).flatMap((p) => [`http://127.0.0.1:${p.slice(6)}`, `http://localhost:${p.slice(6)}`]),
  ];
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${hosts.join(' ')}`.trim(),
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

async function serve(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const id = url.hostname;
  if (!ID.test(id)) return new Response('Not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // Leafdeck's own files for apps: base styles at /_leafdeck/app.css.
  const root = rel.startsWith('/_leafdeck/') ? SDK_DIR : appDir(id);
  if (rel.startsWith('/_leafdeck/')) rel = rel.slice('/_leafdeck'.length);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || /[\\/]\.(versions|git)([\\/]|$)/.test(file)) return new Response('Forbidden', { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
    if (file.endsWith('.html')) {
      let manifest;
      try {
        manifest = readManifest(id);
      } catch {
        manifest = { permissions: [] };
      }
      headers['content-security-policy'] = csp(manifest);
    }
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/* ---------------- Watching (live reload while your agent edits) ---------------- */

let watcher = null;
const pendingChange = new Map();
function watch() {
  if (watcher) return;
  try {
    fs.mkdirSync(appsDir(), { recursive: true });
    watcher = fs.watch(appsDir(), { recursive: true }, (_ev, file) => {
      if (!file) return;
      const parts = String(file).split(/[\\/]/);
      const id = parts[0];
      if (!ID.test(id) || parts.includes('.versions') || parts.includes('node_modules') || parts.includes('.git')) {
        if (parts.length === 1) notifySoon(null); // an app folder was added or removed
        return;
      }
      notifySoon(id);
    });
  } catch (err) {
    console.warn('Leafdeck Apps watcher:', err.message);
  }
}
function notifySoon(id) {
  const key = id || '*';
  clearTimeout(pendingChange.get(key));
  pendingChange.set(key, setTimeout(() => {
    pendingChange.delete(key);
    deps?.onChange(id);
  }, 250));
}

/* ---------------- Logs (what the agent reads to fix errors) ---------------- */

function attachLogs(contents) {
  const idOf = () => {
    try {
      return new URL(contents.getURL()).hostname;
    } catch {
      return '';
    }
  };
  const push = (level, text) => {
    const id = idOf();
    if (!ID.test(id)) return;
    const arr = logs.get(id) || [];
    arr.push({ at: Date.now(), level, text: String(text).slice(0, 4000) });
    if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
    logs.set(id, arr);
  };
  contents.on('console-message', (e, level, message, line, sourceId) => {
    // Electron ≥ 35 passes one details object; older versions pass positional arguments.
    const d = e && typeof e === 'object' && 'message' in e ? e : { level, message, lineNumber: line, sourceId };
    const lv = typeof d.level === 'string' ? d.level : ['debug', 'info', 'warning', 'error'][d.level] || 'info';
    push(lv, `${d.message}${d.sourceId ? ` (${String(d.sourceId).replace(/^leafapp:\/\/[^/]+/, '')}:${d.lineNumber})` : ''}`);
  });
  contents.on('did-fail-load', (_e, code, desc, url, isMain) => isMain && push('error', `Failed to load ${url}: ${desc} (${code})`));
  contents.on('render-process-gone', (_e, d) => push('error', `The app crashed (${d.reason})`));
  contents.on('preload-error', (_e, p, err) => push('error', `Bridge failed to load: ${err.message}`));
}

const getLogs = (id, { clear = false } = {}) => {
  appDir(id);
  const arr = logs.get(id) || [];
  if (clear) logs.delete(id);
  return arr;
};

/* ---------------- Versions (snapshots you can roll back to) ---------------- */

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, skip);
    else fs.copyFileSync(a, b);
  }
}
const versionsDir = (id) => path.join(appDir(id), '.versions');
const skipMeta = (n) => n === '.versions' || n === 'node_modules' || n === '.git';

function saveVersion(id, label = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const to = path.join(versionsDir(id), stamp);
  copyDir(appDir(id), to, skipMeta);
  fs.writeFileSync(path.join(to, '.label'), String(label).slice(0, 80));
  const all = fs.readdirSync(versionsDir(id)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) fs.rmSync(path.join(versionsDir(id), old), { recursive: true, force: true });
  return stamp;
}

function versions(id) {
  try {
    return fs.readdirSync(versionsDir(id)).sort().reverse().map((v) => {
      let label = '';
      try {
        label = fs.readFileSync(path.join(versionsDir(id), v, '.label'), 'utf8');
      } catch {}
      return { id: v, label, at: Date.parse(v.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z')) || 0 };
    });
  } catch {
    return [];
  }
}

function restoreVersion(id, version) {
  if (!/^[\dT:.Z-]+$/.test(String(version))) throw new Error('Bad version');
  const from = path.join(versionsDir(id), version);
  if (!fs.existsSync(from)) throw new Error('That version is gone');
  saveVersion(id, 'Before restoring'); // so a restore can itself be undone
  for (const e of fs.readdirSync(appDir(id), { withFileTypes: true })) {
    if (!skipMeta(e.name)) fs.rmSync(path.join(appDir(id), e.name), { recursive: true, force: true });
  }
  copyDir(from, appDir(id), (n) => n === '.label');
  return true;
}

/** Removing moves the folder to Leafdeck Apps\.trash (nothing is deleted outright). */
function remove(id) {
  const trash = path.join(appsDir(), '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(appDir(id), path.join(trash, `${id}-${Date.now()}`));
  logs.delete(id);
  return true;
}

/* ---------------- Agents (Claude Code, Codex) ---------------- */

const AGENTS = {
  claude: { label: 'Claude Code', cmd: 'claude' },
  codex: { label: 'Codex', cmd: 'codex' },
};
const FIRST_PROMPT = 'Read BRIEF.md and build this Leafdeck app. Follow the guide in this folder, then open the app in Leafdeck and check it with a screenshot and the logs.';

// Where the installers put each CLI, for when Leafdeck's PATH is older than the install.
const KNOWN_BINS = process.platform === 'win32'
  ? {
      claude: [path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')],
      codex: [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd')],
    }
  : {
      claude: [path.join(os.homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', path.join(os.homedir(), '.npm-global', 'bin', 'claude')],
      codex: [path.join(os.homedir(), '.local', 'bin', 'codex'), '/usr/local/bin/codex', path.join(os.homedir(), '.npm-global', 'bin', 'codex')],
    };

/** Open a terminal window on Linux running a shell script (kept open afterwards). Tries the common terminals. */
function linuxTerminal(dir, title, script) {
  const { spawn } = require('node:child_process');
  const body = `${script}\nprintf '\\n[Press Enter to close]'; read _`;
  const opts = { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}` } };
  const tries = [
    ['kgx', ['--title', title, '--', 'bash', '-c', body]], // GNOME Console
    ['gnome-terminal', ['--title', title, '--', 'bash', '-c', body]],
    ['konsole', ['--title', title, '-e', 'bash', '-c', body]],
    ['xfce4-terminal', ['--title', title, '-e', `bash -c ${JSON.stringify(body)}`]],
    ['x-terminal-emulator', ['-e', 'bash', '-c', body]],
    ['xterm', ['-T', title, '-e', 'bash', '-c', body]],
  ];
  for (const [cmd, args] of tries) {
    if (!which(cmd)) continue;
    spawn(cmd, args, opts).unref();
    return true;
  }
  throw new Error('No terminal app found. Install GNOME Console (kgx) or gnome-terminal.');
}
function which(cmd) {
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const hit = out.split(/\r?\n/).find(Boolean);
    if (hit) return hit;
  } catch {}
  return (KNOWN_BINS[cmd] || []).find((p) => p && fs.existsSync(p)) || '';
}

const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** Open a terminal that installs the agent, then signs in (the user finishes sign-in in the browser it opens). */
function installAgent(agent) {
  const a = AGENTS[agent];
  if (!a) throw new Error('Unknown agent');
  const { spawn } = require('node:child_process');
  const ps = agent === 'claude'
    ? "Write-Host 'Installing Claude Code...' ; irm https://claude.ai/install.ps1 | iex ; $env:Path = (Join-Path $env:USERPROFILE '.local\\bin') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path ; Write-Host '' ; Write-Host 'Installed. Signing you in: follow the prompts, then you can close this window.' ; claude auth login"
    : "Write-Host 'Installing Codex...' ; npm install -g @openai/codex ; $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path ; Write-Host '' ; Write-Host 'Installed. Signing you in: follow the prompts, then you can close this window.' ; codex login";
  if (process.platform === 'linux') {
    const sh = agent === 'claude'
      ? "echo 'Installing Claude Code...'; curl -fsSL https://claude.ai/install.sh | bash; export PATH=\"$HOME/.local/bin:$PATH\"; echo; echo 'Installed. Signing you in: follow the prompts, then you can close this window.'; claude auth login"
      : "echo 'Installing Codex...'; npm install -g @openai/codex; echo; echo 'Installed. Signing you in: follow the prompts, then you can close this window.'; codex login";
    linuxTerminal(os.homedir(), `Install ${a.label}`, sh);
    return { ok: true };
  }
  if (process.platform !== 'win32') throw new Error('Install it from its website, then come back');
  const args = ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(ps)];
  const wt = which('wt.exe');
  if (wt) spawn(wt, ['--title', `Install ${a.label}`, ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  else spawn('cmd.exe', ['/c', 'start', `Install ${a.label}`, ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true };
}

const agentStatus = () => Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { label: a.label, installed: !!which(a.cmd) }]));

/**
 * Open a terminal in the app's folder running the agent with the first prompt (or with `prompt`), connected to
 * Leafdeck through App Builder's own scoped MCP connection (electron/mcp.cjs builderConnection): the agent can open,
 * screenshot and drive the user's apps and read their logs, nothing else. Claude Code gets the connection as a
 * per-session --mcp-config file; Codex reads the app folder's .codex/config.toml with the token in an environment
 * variable. `dryRun` returns what would run, for tests.
 */
/** Connect Claude Code in this app's folder to Leafdeck (builder-scoped MCP) and pre-approve the Leafdeck tools,
    which the builder token already limits to the user's apps. Used by the terminal launch and the App Builder chat. */
function writeClaudeConfig(dir, conn) {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.leafdeck-*\n.versions/\n.codex/\n.claude/settings.local.json\nnode_modules/\n');
  if (!conn) return;
  fs.writeFileSync(path.join(dir, '.leafdeck-mcp.json'), JSON.stringify({ mcpServers: { leafdeck: { type: 'http', url: conn.url, headers: { Authorization: `Bearer ${conn.token}` } } } }, null, 2));
  const sdir = path.join(dir, '.claude');
  const sfile = path.join(sdir, 'settings.local.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(sfile, 'utf8')) || {}; } catch {}
  settings.permissions = settings.permissions || {};
  const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  if (!allow.includes('mcp__leafdeck__*')) allow.push('mcp__leafdeck__*');
  settings.permissions.allow = allow;
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(sfile, JSON.stringify(settings, null, 2) + '\n');
}

function launchAgent(id, agent = 'claude', prompt = FIRST_PROMPT, { dryRun = false, connection = null, resume = null } = {}) {
  const a = AGENTS[agent];
  if (!a) throw new Error('Unknown agent');
  const dir = appDir(id);
  const exe = which(a.cmd);
  if (!exe && !dryRun) throw new Error(`${a.label} isn’t installed (no “${a.cmd}” command found)`);
  const conn = connection || (deps?.builderConnection ? deps.builderConnection() : null);
  // The prompt goes in a file, so nothing the user typed is ever pasted into a command line.
  fs.writeFileSync(path.join(dir, '.leafdeck-prompt.txt'), String(prompt).slice(0, 4000));
  writeClaudeConfig(dir, null);
  const env = { ...process.env };
  let cmd = a.cmd;
  let args = [];
  if (agent === 'claude') {
    if (conn) {
      writeClaudeConfig(dir, conn);
      args.push('--mcp-config', '.leafdeck-mcp.json');
    }
    // "Open in terminal" from the chat: the same conversation, nothing new typed.
    if (resume) args.push('--resume', String(resume));
  } else if (agent === 'codex') {
    if (conn) {
      fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), `# Leafdeck App Builder connection (token comes from the LEAFDECK_MCP_TOKEN environment variable).\n[mcp_servers.leafdeck]\nurl = "${conn.url}"\nbearer_token_env_var = "LEAFDECK_MCP_TOKEN"\n`);
      env.LEAFDECK_MCP_TOKEN = conn.token;
    }
  }
  const quoted = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = `Set-Location -LiteralPath ${quoted(dir)}; ${conn && agent === 'codex' ? `$env:LEAFDECK_MCP_TOKEN = ${quoted(conn.token)}; ` : ''}& ${quoted(exe || cmd)} ${resume && agent === 'claude' ? '' : "(Get-Content -Raw -LiteralPath '.leafdeck-prompt.txt') "}${args.map(quoted).join(' ')}`;
  const plan = { dir, exe: exe || cmd, args, connected: !!conn, shell: ps };
  if (dryRun) return plan;
  const { spawn } = require('node:child_process');
  if (process.platform === 'win32') {
    const wt = which('wt.exe');
    const psArgs = ['powershell.exe', '-NoExit', '-NoProfile', '-EncodedCommand', encoded(ps)];
    if (wt) spawn(wt, ['-d', dir, '--title', `${a.label} · ${id}`, ...psArgs], { detached: true, stdio: 'ignore', windowsHide: false, env }).unref();
    else spawn('cmd.exe', ['/c', 'start', `${a.label} · ${id}`, ...psArgs], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false, env }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore', env }).unref();
  } else {
    // Linux: the same session in a terminal window. The prompt is read from its file, never put on a command line.
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const promptArg = resume && agent === 'claude' ? '' : `"$(cat .leafdeck-prompt.txt)" `;
    const sh = `cd ${q(dir)}${conn && agent === 'codex' ? `; export LEAFDECK_MCP_TOKEN=${q(conn.token)}` : ''}; ${q(exe || cmd)} ${promptArg}${args.map(q).join(' ')}`;
    linuxTerminal(dir, `${a.label} · ${id}`, sh);
  }
  return { ok: true, connected: !!conn };
}

/* ---------------- Wiring ---------------- */

function init({ protocolSession, win, onChange, builderConnection }) {
  deps = { win, onChange, builderConnection };
  protocolSession.protocol.handle(SCHEME, serve);
  // Apps get no device permissions (camera, microphone, location…) in this prototype.
  protocolSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  protocolSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  watch();
}

const isAppUrl = (u) => typeof u === 'string' && u.startsWith(`${SCHEME}://`);
const appIdOf = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === `${SCHEME}:` && ID.test(x.hostname) ? x.hostname : '';
  } catch {
    return '';
  }
};

const guideText = () => fs.readFileSync(path.join(SDK_DIR, 'GUIDE.md'), 'utf8');

module.exports = {
  PARTITION, SCHEME, COLLECTIONS, FIRST_PROMPT, init, list, create, readManifest, writeGuides, appsDir, appDir, attachLogs, getLogs,
  saveVersion, versions, restoreVersion, remove, launchAgent, installAgent, agentStatus, isAppUrl, appIdOf, guideText, writeClaudeConfig, which,
  openFolder: (id) => shell.openPath(id ? appDir(id) : (fs.mkdirSync(appsDir(), { recursive: true }), appsDir())),
};
