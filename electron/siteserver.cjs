// The Site Editor's dev servers (public/js/apps/siteeditor.js): start a project's site on this computer without a
// terminal. detect() works out how the project runs (its package.json dev script with the package manager its lockfile
// names, Wrangler, Hugo, Jekyll, Django) and otherwise serves the folder as plain HTML with a small static server here.
// A command runs in a login shell in the project's folder (its own process group, so stopping it stops what it
// started); the address comes from what it prints ("Local: http://localhost:5173/"), or from the port its framework
// uses once that answers. One server per project; the editor gets 'siteeditor:server' events (status, address,
// output), and every server stops when Leafdeck quits or restarts.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

let deps = null; // { projectPath(pid) -> folder | null, send(channel, payload) }
const servers = new Map(); // project id -> server
const LOG_MAX = 64 * 1024;

/* ---------------- how a project runs ---------------- */

const exists = (...p) => fs.existsSync(path.join(...p));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
/** The port a dev command's framework uses unless told otherwise (a hint: what it prints wins). */
function portOf(script) {
  const s = String(script || '');
  const flag = /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})\b/.exec(s);
  if (flag) return Number(flag[1]);
  if (/\bastro\b/.test(s)) return 4321;
  if (/\bvite\b|svelte-kit|\bremix vite|react-router dev/.test(s)) return 5173;
  if (/\bwrangler\b/.test(s)) return 8787;
  if (/\bgatsby\b/.test(s)) return 8000;
  if (/\beleventy\b|@11ty|http-server|live-server/.test(s)) return 8080;
  if (/\bhugo\b/.test(s)) return 1313;
  if (/\bjekyll\b/.test(s)) return 4000;
  if (/\bng serve\b|\bng\b.*serve/.test(s)) return 4200;
  if (/\bnext\b|\bnuxt\b|\bnuxi\b|react-scripts|\bremix\b|\bserve\b/.test(s)) return 3000;
  return 0;
}
/** The folder plain HTML is served from: the first with an index.html. */
function staticRoot(dir) {
  for (const sub of ['.', 'public', 'dist', 'build', 'site', '_site', 'docs', 'www', 'out', 'src']) if (exists(dir, sub, 'index.html')) return sub;
  return '.';
}
/**
 * How to run the project: { kind: 'command', command, port } or { kind: 'static', root } (a folder in the project).
 * `why` says what it went by, for the editor to show.
 */
function detect(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const name = ['dev', 'develop', 'serve', 'start', 'preview'].find((n) => typeof scripts[n] === 'string');
  if (name) {
    const pm = exists(dir, 'pnpm-lock.yaml') ? 'pnpm' : exists(dir, 'yarn.lock') ? 'yarn' : exists(dir, 'bun.lockb') || exists(dir, 'bun.lock') ? 'bun' : 'npm';
    const run = pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`;
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).length;
    const install = deps && !exists(dir, 'node_modules') ? `${pm} install && ` : '';
    return { kind: 'command', command: install + run, port: portOf(scripts[name]), why: `package.json’s “${name}” script: ${scripts[name]}` };
  }
  if (['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].some((f) => exists(dir, f))) return { kind: 'command', command: 'npx wrangler dev', port: 8787, why: 'a Wrangler project' };
  if (['hugo.toml', 'hugo.yaml', 'hugo.json'].some((f) => exists(dir, f)) || (exists(dir, 'config.toml') && (exists(dir, 'content') || exists(dir, 'layouts')))) return { kind: 'command', command: 'hugo server', port: 1313, why: 'a Hugo site' };
  if (exists(dir, '_config.yml') && exists(dir, 'Gemfile')) return { kind: 'command', command: 'bundle exec jekyll serve', port: 4000, why: 'a Jekyll site' };
  if (exists(dir, 'manage.py')) return { kind: 'command', command: 'python3 manage.py runserver', port: 8000, why: 'a Django project' };
  const root = staticRoot(dir);
  return { kind: 'static', root, why: exists(dir, root, 'index.html') ? `plain HTML (${root === '.' ? 'index.html' : `${root}/index.html`})` : 'no dev server found: the folder as it is' };
}

/* ---------------- one server ---------------- */

const snapshot = (s) => (s ? { status: s.status, url: s.url, kind: s.kind, command: s.command, root: s.root, code: s.code ?? null, log: s.log } : { status: 'stopped', url: '', log: '' });
function emit(s, extra = {}) {
  deps.send('siteeditor:server', { project: s.pid, status: s.status, url: s.url, kind: s.kind, command: s.command, code: s.code ?? null, ...extra });
}
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
function addLog(s, text) {
  text = text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s.log = (s.log + text).slice(-LOG_MAX);
  s.pending += text;
  if (!s.flush) {
    // Batched: a busy server (every rebuild) shouldn't flood the UI.
    s.flush = setTimeout(() => {
      s.flush = null;
      const out = s.pending;
      s.pending = '';
      if (out) emit(s, { t: 'log', text: out });
    }, 120);
  }
  if (s.status === 'starting') {
    // The address it prints; a "Local:" one first, else the first on this computer.
    s.scan = (s.scan + text).slice(-8192);
    const lines = s.scan.split('\n');
    const at = (l) => /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"`<>)\]]*)?)/i.exec(l)?.[1];
    const url = at(lines.find((l) => /local/i.test(l) && at(l)) || '') || lines.map(at).find(Boolean);
    if (url) {
      s.scan = '';
      const u = new URL(url.replace(/[.,;:]+$/, ''));
      if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = 'localhost';
      ready(s, u.href);
    }
  }
}
/** Running at `url` once its port answers (some print the address a moment before they listen). */
async function ready(s, url) {
  if (s.status !== 'starting' || s.checking) return;
  s.checking = true;
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  for (let i = 0; i < 60 && s.status === 'starting'; i++) {
    if (await answers(port, u.hostname.replace(/^\[|\]$/g, ''))) {
      if (s.status !== 'starting') return;
      s.status = 'running';
      s.url = url;
      return emit(s);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  s.checking = false;
}
function answers(port, host = 'localhost') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(800, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function startCommand(s, dir) {
  const sh = process.env.SHELL || '/bin/bash';
  const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' }; // no browser windows of its own
  addLog(s, `$ ${s.command}\n`);
  const child = spawn(sh, ['-lc', s.command], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  s.child = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => addLog(s, d));
  child.stderr.on('data', (d) => addLog(s, d));
  child.on('error', (err) => addLog(s, `\n${err.message}\n`));
  child.on('exit', (code, signal) => {
    s.child = null;
    clearInterval(s.poll);
    if (s.stopping) {
      s.status = 'stopped';
      addLog(s, '\n(stopped)\n');
    } else {
      s.status = 'failed';
      s.code = code ?? signal;
      addLog(s, `\n(it stopped${code != null ? ` with exit code ${code}` : signal ? ` on ${signal}` : ''})\n`);
    }
    s.url = '';
    emit(s);
  });
  // A command that never prints its address: the port its framework uses, once it answers (if it wasn't already taken).
  if (s.port) {
    answers(s.port).then((taken) => {
      if (taken || s.status !== 'starting') return;
      s.poll = setInterval(async () => {
        if (s.status !== 'starting') return clearInterval(s.poll);
        if (await answers(s.port)) {
          clearInterval(s.poll);
          setTimeout(() => s.status === 'starting' && ready(s, `http://localhost:${s.port}/`), 1500); // its own line first
        }
      }, 800);
    });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Plain HTML: the folder's files on 127.0.0.1, never cached (the editor reloads after Claude's edits). */
async function startStatic(s, dir) {
  const root = path.resolve(dir, s.root || '.');
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.resolve(root, '.' + rel);
    if (!inside(file)) return res.writeHead(403).end();
    const stat = (f) => {
      try {
        return fs.statSync(f);
      } catch {
        return null;
      }
    };
    let st = stat(file);
    if (st?.isDirectory()) {
      if (!rel.endsWith('/')) return res.writeHead(301, { Location: rel + '/' }).end();
      const index = path.join(file, 'index.html');
      if (stat(index)) (file = index), (st = stat(index));
      else {
        const items = fs.readdirSync(file, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>${escHtml(rel)}</title><body style="font:14px system-ui;padding:24px"><h1 style="font-size:18px">${escHtml(rel)}</h1><ul>${items.map((d) => `<li><a href="${encodeURIComponent(d.name)}${d.isDirectory() ? '/' : ''}">${escHtml(d.name)}${d.isDirectory() ? '/' : ''}</a></li>`).join('')}</ul>`);
      }
    }
    if (!st && !path.extname(file) && stat(file + '.html')) (file += '.html'), (st = stat(file)); // /about → about.html
    let status = 200;
    if (!st) {
      status = 404;
      file = path.join(root, '404.html');
      st = stat(file);
      if (!st) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${rel}`);
    }
    res.writeHead(status, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    if (status === 200 && /\.html?$/.test(file)) addLog(s, `${req.method} ${rel}\n`);
  });
  s.http = server;
  // A port of its own from 5500 up, so the project's address stays the same from one start to the next.
  for (let port = 5500; port < 5600; port++) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      s.status = 'running';
      s.url = `http://localhost:${port}/`;
      addLog(s, `Serving ${s.root === '.' ? 'the project folder' : `${s.root}/`} at ${s.url}\n`);
      return emit(s);
    }
    if (s.stopping) return;
  }
  s.status = 'failed';
  addLog(s, 'No free port between 5500 and 5599.\n');
  emit(s);
}

/* ---------------- what the editor asks ---------------- */

function folderOf(pid) {
  const dir = deps.projectPath(pid);
  if (!dir || !fs.existsSync(dir)) throw new Error('That project’s folder isn’t there');
  return dir;
}
/** This project's server (status, address, output so far) and how it would run. */
function status(pid) {
  const s = servers.get(pid);
  let detected = null;
  try {
    detected = detect(folderOf(pid));
  } catch {}
  return { ...snapshot(s), detected };
}
/** Start it: `plan` is { command } (empty: plain HTML) or nothing for what detect() finds. Restarts a running one. */
async function start(pid, plan) {
  const dir = folderOf(pid);
  await stop(pid);
  const d = detect(dir);
  const command = plan && typeof plan.command === 'string' ? plan.command.trim() : d.kind === 'command' ? d.command : '';
  const s = { pid, kind: command ? 'command' : 'static', command, root: command ? '' : d.kind === 'static' ? d.root : staticRoot(dir), port: command ? (command === d.command ? d.port : portOf(command)) : 0, status: 'starting', url: '', log: '', pending: '', scan: '', flush: null, code: null };
  servers.set(pid, s);
  emit(s);
  if (s.kind === 'command') startCommand(s, dir);
  else await startStatic(s, dir);
  return snapshot(s);
}
/** Stop it, and everything it started (its process group); the end of a command arrives as an event. */
function stop(pid) {
  const s = servers.get(pid);
  if (!s || s.status === 'stopped' || s.status === 'failed') return Promise.resolve(true);
  s.stopping = true;
  clearInterval(s.poll);
  if (s.http) {
    return new Promise((resolve) => {
      s.http.close(() => resolve(true));
      s.http.closeAllConnections?.();
      s.status = 'stopped';
      s.url = '';
      addLog(s, '(stopped)\n');
      emit(s);
    });
  }
  const child = s.child;
  if (!child) return Promise.resolve(true);
  return new Promise((resolve) => {
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    const force = setTimeout(() => kill('SIGKILL'), 4000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve(true);
    });
    kill('SIGTERM');
  });
}
/** Leafdeck is quitting or restarting: nothing it started keeps running. */
function stopAll() {
  for (const s of servers.values()) {
    if (s.child) {
      try {
        process.kill(-s.child.pid, 'SIGTERM');
      } catch {}
    }
    s.http?.close();
    s.http?.closeAllConnections?.();
  }
  servers.clear();
}

function init(d) {
  deps = d;
  process.once('exit', stopAll);
}

module.exports = { init, detect, status, start, stop, stopAll };
