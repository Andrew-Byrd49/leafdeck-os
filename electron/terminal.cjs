// Terminal windows for Leafdeck on Linux: each one is a shell on a real pseudo-terminal (electron/pty-helper.py),
// relayed to the Terminal app (public/js/apps/terminal.js). Programs that draw full screen, like Claude Code, vim or htop,
// work because the shell really has a terminal. Plain Node (no Electron): on Leafdeck OS it runs inside leafdeckd
// (electron/leafdeckd.cjs), so shells outlive Leafdeck itself; elsewhere in Leafdeck's main process.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

let send = () => {};
const terms = new Map(); // id -> { child, ctl, out: Buffer[], outSize }
let seq = 0;
// Recent output kept per terminal and replayed when the Terminal app attaches again (after a reload or a restart), so
// it shows the screen as it was. Full-screen programs redraw anyway once the size is set.
const KEEP = 256 * 1024;
function keep(t, d) {
  t.out.push(d);
  t.outSize += d.length;
  while (t.outSize > KEEP && t.out.length > 1) t.outSize -= t.out.shift().length;
}

// Inside a packaged app the helper is unpacked next to app.asar (electron-builder asarUnpack), since Python can't read the archive.
const HELPER = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'pty-helper.py');

function available() {
  return process.platform === 'linux' && fs.existsSync(HELPER);
}

/** `env`: the session's environment as Leafdeck sees it (display, language…), over this process's own. */
function open({ cols = 100, rows = 30, cwd, env: extra } = {}) {
  if (!available()) throw new Error('The terminal needs Leafdeck on Linux');
  const id = `t${++seq}`;
  const home = os.homedir();
  const env = {
    ...process.env,
    ...(extra && typeof extra === 'object' ? extra : {}),
    // LEAFDECK_BIN: Leafdeck OS's own tools ahead of the system's (the app display's clipboard, electron/appdisplay.cjs).
    PATH: [extra?.LEAFDECK_BIN, path.join(home, '.local', 'bin'), process.env.PATH || '/usr/bin:/bin'].filter(Boolean).join(':'),
    LEAFDECK_TERM_CWD: cwd && fs.existsSync(cwd) ? cwd : home,
  };
  // Electron's own variables shouldn't leak into the user's shell.
  for (const k of Object.keys(env)) if (/^(ELECTRON_|CHROME_|GOOGLE_API)/.test(k) || k === 'LEAFDECK_SESSION') delete env[k];
  const child = spawn('python3', [HELPER], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const ctl = child.stdio[3];
  const t = { child, ctl, out: [], outSize: 0 };
  terms.set(id, t);
  const data = (d) => {
    keep(t, d);
    send('term:data', { id, data: d });
  };
  child.stdout.on('data', data);
  child.stderr.on('data', data);
  child.on('exit', (code) => {
    terms.delete(id);
    send('term:exit', { id, code });
  });
  child.on('error', (err) => send('term:data', { id, data: Buffer.from(`\r\nCouldn’t start the terminal: ${err.message}\r\n`) }));
  resize(id, cols, rows);
  return { id };
}

function write(id, data) {
  const t = terms.get(id);
  if (!t) return false;
  t.child.stdin.write(typeof data === 'string' ? data : Buffer.from(data));
  return true;
}

function resize(id, cols, rows) {
  const t = terms.get(id);
  if (!t) return false;
  const c = Math.max(2, Math.min(1000, Math.floor(Number(cols) || 80)));
  const r = Math.max(1, Math.min(500, Math.floor(Number(rows) || 24)));
  t.ctl.write(JSON.stringify({ cols: c, rows: r }) + '\n');
  return true;
}

function close(id) {
  const t = terms.get(id);
  if (!t) return false;
  t.child.stdin.end(); // the helper hangs up the shell
  setTimeout(() => {
    try {
      if (t.child.exitCode == null) t.child.kill();
    } catch {}
  }, 1500);
  return true;
}

/**
 * Where a terminal's shell is: its current folder (for pinning it, and for new panes that start beside it), and whether
 * a program is running in it (`busy`: a program has the terminal, so typing a cd would go to that program, not the
 * shell), and which (`program`). The shell is the pty helper's child; /proc has its folder, and the terminal's foreground
 * process group.
 */
function info(id) {
  const t = terms.get(id);
  if (!t?.child.pid) return null;
  try {
    const kids = fs.readFileSync(`/proc/${t.child.pid}/task/${t.child.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    const pid = Number(kids[0]) || t.child.pid;
    // /proc/<pid>/stat: "pid (name) state ppid pgrp session tty_nr tpgid …"; the name may hold spaces and parentheses.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(fields[2]);
    const tpgid = Number(fields[5]);
    const busy = tpgid > 0 && tpgid !== pgrp;
    // The running program's name (e.g. "claude"), from the foreground group's leader.
    let program = '';
    if (busy) try { program = fs.readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim(); } catch {}
    return { cwd: fs.readlinkSync(`/proc/${pid}/cwd`), busy, program };
  } catch {
    return null;
  }
}

/** The running terminals and their recent output, for the Terminal app to attach to. */
const list = () => [...terms].map(([id, t]) => ({ id, buffer: Buffer.concat(t.out) }));

function closeAll() {
  for (const id of [...terms.keys()]) close(id);
}

function init(d) {
  send = d.send;
}

module.exports = { init, available, open, write, resize, close, closeAll, list, info };
