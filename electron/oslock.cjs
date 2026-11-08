// Leafdeck OS lock screen. A separate full-screen window shown above Leafdeck (the compositor shows the newest window),
// unlocked with the computer account's password, checked by unix_chkpwd: the same helper Linux login screens use to
// check your own password without root. Or with a PIN, when one is set (os/leafdeck-pin, also used by the sign-in screen). Locks on request, after the idle time you choose, and before the computer sleeps.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { BrowserWindow, ipcMain, powerMonitor, app, webContents } = require('electron');

let deps = null; // { mainWindow(), appOrigin, appUrl, preloadDir, settings(), onLockChange(locked) }
let lockWin = null;
let locked = false;
let lastInput = Date.now();
let failures = 0;
let blockedUntil = 0;
let appearance = { wallpaper: '', accent: '#34c77b', name: '', theme: 'dark' };
// Sites playing sound, or video full screen, count as activity: no idle lock or sleep in a video call or a film.
const fullscreen = new Set();
const watching = new Set();

const CHKPWD = '/usr/sbin/unix_chkpwd';
// While locked, this file exists (in the per-user runtime folder, cleared at shutdown). If Leafdeck crashes while locked,
// the session starts it again; it sees the file and locks before anything else, so a crash never unlocks the computer.
const LOCK_FLAG = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'leafdeck-locked');
const setFlag = (on) => {
  try {
    if (on) fs.writeFileSync(LOCK_FLAG, String(Date.now()), { mode: 0o600 });
    else fs.rmSync(LOCK_FLAG, { force: true });
  } catch {}
};

/* unix_chkpwd must get the password on a real pipe. Node gives child processes a socket for stdin, and SELinux doesn't let
   the helper (chkpwd_t) read a socket inherited from the session, so it silently sees an empty password ("no password
   supplied") and every unlock fails. This small Python bridge reads the password from us and hands it on over os.pipe(). */
const CHK_BRIDGE = `import os, subprocess, sys
pw = sys.stdin.buffer.read()
r, w = os.pipe()
p = subprocess.Popen(["${CHKPWD}", sys.argv[1], "nonull"], stdin=r, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
os.close(r)
try:
    os.write(w, pw + b"\\0")
except OSError:
    pass
os.close(w)
sys.exit(p.wait())`;

/** Check the signed-in account's password. unix_chkpwd only answers for the user running it. */
function checkPassword(password) {
  return new Promise((resolve) => {
    const child = execFile('python3', ['-c', CHK_BRIDGE, os.userInfo().username], { timeout: 15000 }, (err) => resolve(!err));
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(String(password || '').slice(0, 500), 'utf8'));
  });
}

/* The PIN (os/leafdeck-pin, a root helper run through sudo -n). Without the helper or its sudo rule, there's no PIN. */
const PIN_HELPER = '/usr/local/sbin/leafdeck-pin';
const isPin = (s) => /^[0-9]{4,12}$/.test(s);
function pinHelper(cmd, input = '') {
  return new Promise((resolve) => {
    if (!fs.existsSync(PIN_HELPER)) return resolve({ ok: false, missing: true });
    const child = execFile('sudo', ['-n', PIN_HELPER, cmd], { timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code, out: String(stdout || ''), error: String(stderr || '').trim().split('\n').pop() }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(String(input), 'utf8'));
  });
}
/** { available: the helper and its sudo rule are installed, set, locked: too many wrong PINs }. */
async function pinStatus() {
  const r = await pinHelper('status');
  try {
    if (r.ok) return { available: true, ...JSON.parse(r.out) };
  } catch {}
  return { available: false, set: false, locked: false };
}

function lock(reason = 'manual') {
  if (locked) return;
  locked = true;
  failures = 0;
  console.log(`[lock] locked: ${reason}`);
  setFlag(true);
  lockWin = new BrowserWindow({
    fullscreen: true,
    frame: false,
    show: true,
    backgroundColor: '#0b0f0d',
    title: 'Leafdeck Locked',
    webPreferences: { preload: path.join(deps.preloadDir, 'lock-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockWin.setMenu?.(null);
  lockWin.loadURL(`${deps.appUrl}lock.html`);
  // Only an unlock closes it.
  lockWin.on('close', (e) => locked && e.preventDefault());
  lockWin.webContents.on('before-input-event', (e, input) => {
    // No reloading or dev tools from the lock screen.
    const k = String(input.key || '').toLowerCase();
    if ((input.control || input.meta) && ['r', 'i', 'j', 'w', 'q'].includes(k)) e.preventDefault();
    if (k === 'f5' || k === 'f12') e.preventDefault();
  });
  lockWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  lockWin.webContents.on('will-navigate', (e) => e.preventDefault());
  deps.onLockChange?.(true, reason);
}

function unlockNow() {
  locked = false;
  setFlag(false);
  lastInput = Date.now();
  const w = lockWin;
  lockWin = null;
  if (w && !w.isDestroyed()) w.destroy();
  const main = deps.mainWindow();
  if (main && !main.isDestroyed()) main.focus();
  deps.onLockChange?.(false);
}

const fromLock = (event) => lockWin && event.sender === lockWin.webContents;

function wireIpc() {
  ipcMain.handle('lock:info', async (event) => {
    if (!fromLock(event)) throw new Error('Not allowed');
    const u = os.userInfo();
    const pin = await pinStatus();
    return { ...appearance, user: u.username, host: os.hostname(), pin: pin.set, pinLocked: pin.locked };
  });
  ipcMain.handle('lock:unlock', async (event, password) => {
    if (!fromLock(event)) throw new Error('Not allowed');
    const now = Date.now();
    if (now < blockedUntil) return { ok: false, wait: Math.ceil((blockedUntil - now) / 1000) };
    password = String(password || '');
    // Digits may be the PIN; if they aren't, they may still be the password.
    if (isPin(password) && (await pinHelper('check', password)).ok) {
      unlockNow();
      return { ok: true };
    }
    if (await checkPassword(password)) {
      unlockNow();
      // The password works even when too many wrong PINs have turned the PIN off; it turns it back on.
      pinHelper('reset', password);
      return { ok: true };
    }
    failures++;
    const pinLocked = isPin(password) && (await pinStatus()).locked;
    // After 3 wrong tries, wait a little longer each time (5 s, 10 s, 20 s… up to 5 minutes).
    if (failures >= 3) blockedUntil = Date.now() + Math.min(300, 5 * 2 ** (failures - 3)) * 1000;
    return { ok: false, pinLocked, wait: failures >= 3 ? Math.ceil((blockedUntil - Date.now()) / 1000) : 0 };
  });
  ipcMain.handle('lock:power', (event, action) => {
    if (!fromLock(event)) throw new Error('Not allowed');
    if (!['restart', 'shutdown'].includes(action)) throw new Error('Not allowed');
    return deps.power(action);
  });
}

/** Anything typed or clicked anywhere in Leafdeck (including websites) counts as activity. */
function trackInput(contents) {
  contents.on('input-event', () => (lastInput = Date.now()));
  contents.on('enter-html-full-screen', () => fullscreen.add(contents));
  contents.on('leave-html-full-screen', () => fullscreen.delete(contents));
  contents.on('media-started-playing', () => watching.add(contents));
  contents.on('media-paused', () => watching.delete(contents));
  contents.on('destroyed', () => {
    fullscreen.delete(contents);
    watching.delete(contents);
  });
  contents.on('before-input-event', (e, input) => {
    lastInput = Date.now();
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    // Super+L or Ctrl+Alt+L locks, like other desktops.
    if (k === 'l' && (input.meta || (input.control && input.alt))) {
      e.preventDefault();
      lock('shortcut');
    }
  });
}

const playing = () =>
  webContents.getAllWebContents().some((c) => !c.isDestroyed() && (c.isCurrentlyAudible() || (watching.has(c) && fullscreen.has(c))));

/** How long nothing has happened: no input, and nothing playing. */
function idleMs() {
  if (playing()) lastInput = Date.now();
  return Date.now() - lastInput;
}

// Sleeping and turning the screen off when idle are electron/ospower.cjs's; locking is here.
function startIdleWatch() {
  setInterval(() => {
    const idle = idleMs();
    const { lockAfter = 5 } = deps.settings();
    if (!locked && Number(lockAfter) && idle >= Number(lockAfter) * 60_000) lock('idle');
  }, 15_000);
  // Lock before sleeping, so the screen is locked when the lid opens. Waking up counts as activity.
  powerMonitor.on('suspend', () => lock('sleep'));
  powerMonitor.on('resume', () => (lastInput = Date.now()));
  powerMonitor.on('lock-screen', () => lock('system'));
}

function init(d) {
  deps = d;
  wireIpc();
  app.on('web-contents-created', (_e, contents) => trackInput(contents));
  startIdleWatch();
  // Signing out isn't a crash: the next sign-in starts unlocked.
  app.on('will-quit', () => setFlag(false));
  // Locked when Leafdeck stopped: lock again as soon as the desktop has loaded, so the lock screen is the newest window.
  if (fs.existsSync(LOCK_FLAG)) {
    app.once('browser-window-created', (_e, w) => {
      let done = false;
      const relock = () => !done && ((done = true), lock('restored'));
      w.webContents.once('did-finish-load', relock);
      setTimeout(relock, 8000);
    });
  }
}

module.exports = {
  init,
  lock,
  isLocked: () => locked,
  idleMs,
  touch: () => (lastInput = Date.now()),
  pinStatus,
  setPin: (password, pin) => pinHelper('set', JSON.stringify({ password: String(password || ''), pin: String(pin || '') })),
  removePin: (password) => pinHelper('remove', String(password || '')),
  setAppearance: (a) => (appearance = { ...appearance, ...a }),
};
