// Leafdeck OS sign-in screen: Leafdeck in greeter mode (LEAFDECK_GREETER=1, started by os/leafdeck-greeter under greetd).
// It shows the lock screen's page (public/lock.html, the same design), checks the password through greetd, and on
// success asks greetd to start the Leafdeck session, then exits. It runs as the greetd system account, before anyone
// is signed in, so it does nothing else: no sites, no user data, no network.
//
// greetd's protocol (GREETD_SOCK): each message is a 4-byte length (native byte order) followed by JSON.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, protocol, net: enet } = require('electron');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_CMD = ['/usr/libexec/leafdeck/leafdeck-session'];
const FAILED_DIR = '/run/leafdeck/failed'; // the session's note that Leafdeck kept crashing (os/leafdeck-session, mark)
const LAST_USER = path.join(os.homedir(), 'leafdeck-last-user'); // the greetd account's home (/var/lib/greetd)

// Like Leafdeck itself: an installed build never runs with remote debugging (it would give control of the sign-in).
if (app.isPackaged && (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe'))) app.exit(1);
// Nothing to keep between sign-ins: the browser profile goes in the greeter's runtime folder.
app.setPath('userData', path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'leafdeck-greeter'));
protocol.registerSchemesAsPrivileged([{ scheme: 'leafdeck', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/* ---------------- greetd ---------------- */

function greetd() {
  const sock = net.connect(process.env.GREETD_SOCK || '');
  let buf = Buffer.alloc(0);
  const waiting = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      waiting.shift()?.resolve(msg);
    }
  });
  sock.on('error', (err) => waiting.splice(0).forEach((w) => w.reject(err)));
  const ask = (req) =>
    new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      const body = Buffer.from(JSON.stringify(req), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      sock.write(Buffer.concat([head, body]));
    });
  return { ask, close: () => sock.end() };
}

/** Sign in: answer greetd's prompts with the password (or PIN), then start the session. With a PIN set, greetd's PAM
    stack asks twice: first os/leafdeck-pin (pam_exec), then the password check; both get what was typed. `safe` starts
    the session in safe mode (os/leafdeck-session --safe): the same session, with Leafdeck's own default settings. */
async function signIn(username, password, safe = false) {
  const g = greetd();
  try {
    let r = await g.ask({ type: 'create_session', username });
    while (r.type === 'auth_message') {
      // A password prompt gets the password; notes (info, error) just get acknowledged.
      const secret = r.auth_message_type === 'secret' || r.auth_message_type === 'visible';
      r = await g.ask({ type: 'post_auth_message_response', response: secret ? password : null });
    }
    if (r.type !== 'success') {
      await g.ask({ type: 'cancel_session' }).catch(() => {});
      return { ok: false, error: r.error_type === 'auth_error' ? '' : r.description || 'Couldn’t sign in' };
    }
    r = await g.ask({ type: 'start_session', cmd: safe ? [...SESSION_CMD, '--safe'] : SESSION_CMD, env: [] });
    if (r.type !== 'success') return { ok: false, error: r.description || 'Couldn’t start the session' };
    try {
      fs.writeFileSync(LAST_USER, username);
    } catch {}
    setTimeout(() => app.exit(0), 300); // greetd starts the session once the greeter is gone
    return { ok: true };
  } finally {
    g.close();
  }
}

/* ---------------- who can sign in ---------------- */

/** Whether the account has a sign-in PIN (os/leafdeck-pin). Its folder lets anyone see that, not read it. */
const hasPin = (user) => {
  try {
    return fs.statSync(path.join('/var/lib/leafdeck-pin', user)).isFile();
  } catch {
    return false;
  }
};

/** How the account's last session ended, when Leafdeck kept crashing: 'crashed' (safe mode took over) or 'safe-failed'
    (safe mode kept crashing too, and the session ended). The note must be the account's own file: the folder is
    writable by everyone. */
function failed(user, uid) {
  try {
    const file = path.join(FAILED_DIR, user);
    if (fs.statSync(file).uid !== uid) return '';
    const word = fs.readFileSync(file, 'utf8').split(/\s+/)[0];
    return ['crashed', 'safe-failed'].includes(word) ? word : '';
  } catch {
    return '';
  }
}

/** People with accounts on this computer (regular accounts with a login shell), the last one to sign in first. */
function users() {
  let list = [];
  try {
    list = fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .map((l) => l.split(':'))
      .filter((f) => f.length >= 7 && Number(f[2]) >= 1000 && Number(f[2]) < 60000 && !/nologin|false$/.test(f[6]))
      .map((f) => ({ user: f[0], name: f[4].split(',')[0] || f[0], pin: hasPin(f[0]), failed: failed(f[0], Number(f[2])) }));
  } catch {}
  let last = '';
  try {
    last = fs.readFileSync(LAST_USER, 'utf8').trim();
  } catch {}
  return list.sort((a, b) => (b.user === last) - (a.user === last));
}

/* ---------------- the window ---------------- */

let win = null;
const fromGreeter = (event) => win && event.sender === win.webContents;
let failures = 0;
let blockedUntil = 0;

ipcMain.handle('lock:info', (event) => {
  if (!fromGreeter(event)) throw new Error('Not allowed');
  const list = users();
  return { mode: 'greeter', users: list, user: list[0]?.user || '', name: list[0]?.name || '', pin: !!list[0]?.pin, failed: list[0]?.failed || '', host: os.hostname(), wallpaper: '/wallpaper.jpg', accent: '#34c77b', theme: 'dark' };
});
ipcMain.handle('lock:unlock', async (event, password, username, safe) => {
  if (!fromGreeter(event)) throw new Error('Not allowed');
  const now = Date.now();
  if (now < blockedUntil) return { ok: false, wait: Math.ceil((blockedUntil - now) / 1000) };
  const user = String(username || users()[0]?.user || '');
  if (!users().some((u) => u.user === user)) return { ok: false };
  const r = await signIn(user, String(password || '').slice(0, 500), safe === true).catch((err) => ({ ok: false, error: err.message }));
  if (r.ok) return r;
  // Same pacing as the lock screen: after 3 wrong tries, wait 5 s, 10 s, 20 s… up to 5 minutes.
  if (!r.error && ++failures >= 3) blockedUntil = Date.now() + Math.min(300, 5 * 2 ** (failures - 3)) * 1000;
  return { ...r, wait: !r.error && failures >= 3 ? Math.ceil((blockedUntil - Date.now()) / 1000) : 0 };
});
ipcMain.handle('lock:power', (event, action) => {
  if (!fromGreeter(event)) throw new Error('Not allowed');
  const verb = { restart: 'reboot', shutdown: 'poweroff' }[action];
  if (!verb) throw new Error('Not allowed');
  spawn('systemctl', [verb], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

app.whenReady().then(async () => {
  // One screen, the way a session starts (an external display when one is connected, else the built-in one, turned the
  // right way): left alone, cage would stretch the sign-in across every screen. The person's own arrangement is in their
  // account, which this can't read.
  await require('./ossystem.cjs').applyScreens({}).catch(() => {});
  // Only the page's own files (public/), nothing else on disk and nothing from the network.
  protocol.handle('leafdeck', (req) => {
    const file = path.normalize(path.join(PUBLIC, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) return new Response('Not found', { status: 404 });
    return enet.fetch(`file://${file}`);
  });
  win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: '#0b0f0d',
    title: 'Leafdeck',
    webPreferences: { preload: path.join(__dirname, 'lock-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu?.(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
  win.webContents.on('before-input-event', (e, input) => {
    const k = String(input.key || '').toLowerCase();
    if ((input.control || input.meta) && ['r', 'i', 'j', 'w', 'q'].includes(k)) e.preventDefault();
    if (k === 'f5' || k === 'f12') e.preventDefault();
  });
  win.loadURL('leafdeck://app/lock.html');
});
app.on('window-all-closed', () => app.exit(0));
