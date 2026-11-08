// The app display (Leafdeck OS): programs started from Leafdeck's Terminal open their windows here, and Leafdeck shows
// them in one of its own windows (public/js/apps/appdisplay.js). Without it they'd connect to the session's compositor,
// and cage shows any new window full screen on top of Leafdeck, stretched over every display, with no way back.
//
// The display is a second cage with no screen (electron/appdisplay.sh), run as the user unit leafdeck-apps so it and the
// programs in it outlive a restart of Leafdeck, like the shells in leafdeckd. Its picture and input go over VNC on a
// socket in the runtime folder; its windows (titles, which is in front) come from wlr-foreign-toplevel-management
// (electron/wltoplevels.cjs). That same protocol on the real screen catches whatever still opens there and puts Leafdeck
// back in front.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const wltoplevels = require('./wltoplevels.cjs');

const UNIT = 'leafdeck-apps';
// Inside a packaged app the script is unpacked next to app.asar (electron-builder asarUnpack): sh can't read the archive.
const SCRIPT = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'appdisplay.sh');
const runtimeDir = () => process.env.XDG_RUNTIME_DIR || path.join('/run/user', String(os.userInfo().uid));
const ENV_FILE = () => path.join(runtimeDir(), 'leafdeck', 'apps.env');
const VNC_SOCKET = () => path.join(runtimeDir(), 'leafdeck', 'apps.vnc');
// Leafdeck's own windows on the real screen (the desktop, the lock screen). Anything else there is a program that got
// past the app display: one started before it existed, or by something other than the Terminal.
const OWN_APP_IDS = new Set(['leafdeck']);
// Windows the guard leaves alone: wl-copy and wl-paste (run on the real screen by clipboardTools) open a tiny window
// for a moment to reach the clipboard, cage having no data-control protocol; taking focus back would break the copy.
const PASS_APP_IDS = new Set(['wl-clipboard']);

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let displayEnv = null; // { WAYLAND_DISPLAY, DISPLAY } once the display runs
let starting = null;
let watcher = null;
let guard = null; // the real screen's windows (guardScreen)
let isNative = () => false; // programs' windows are in Leafdeck frames (electron/compositor.cjs): nothing to guard
let current = []; // the display's windows, oldest first
let send = () => {};
let clipboardBin = null; // the folder of the clipboard tools that reach the real screen (clipboardTools)

function readEnv() {
  try {
    const env = {};
    for (const line of fs.readFileSync(ENV_FILE(), 'utf8').split('\n')) {
      const m = /^(WAYLAND_DISPLAY|DISPLAY)=(.+)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
    return env.WAYLAND_DISPLAY && env.DISPLAY ? env : null;
  } catch {
    return null;
  }
}

/** Whether something answers on a socket (files left by a display that's gone don't). */
const answers = (file) =>
  new Promise((resolve) => {
    const s = net.connect(file);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });

/** The display's environment, if it's up: written, and both its Wayland socket and its VNC socket answer. */
async function liveEnv() {
  const env = readEnv();
  if (!env || !(await answers(VNC_SOCKET()))) return null;
  return (await answers(path.join(runtimeDir(), env.WAYLAND_DISPLAY))) ? env : null;
}

/** Start the display unless it's already running (from before a restart of Leafdeck). Resolves with its environment. */
function ensure() {
  if (starting) return starting;
  starting = (async () => {
    const active = (await run('systemctl', ['--user', 'is-active', UNIT])) === 'active';
    if (!active || !(await liveEnv())) {
      if (active) await run('systemctl', ['--user', 'stop', UNIT]);
      await run('systemctl', ['--user', 'reset-failed', UNIT]);
      const args = ['--user', `--unit=${UNIT}`, '--collect', '--description=Leafdeck app display', '-p', 'PartOf=leafdeck-session.target', `--setenv=XDG_RUNTIME_DIR=${runtimeDir()}`];
      if (process.env.LEAFDECK_IN_VM) args.push('--setenv=LEAFDECK_IN_VM=1');
      if ((await run('systemd-run', [...args, '/bin/sh', SCRIPT])) === null) throw new Error('Couldn’t start the app display');
    }
    let env = null;
    for (let i = 0; i < 50 && !(env = await liveEnv()); i++) await sleep(100);
    if (!env) throw new Error('The app display didn’t start');
    displayEnv = env;
    return env;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** Follow the display's windows; when the display goes away (it crashed, or was stopped), start it again. */
async function follow() {
  let delay = 1000;
  for (;;) {
    try {
      const env = await ensure();
      watcher = await wltoplevels.watch(env.WAYLAND_DISPLAY, (list) => {
        current = list;
        send('appdisplay:windows', list);
      });
      delay = 1000;
      await new Promise((resolve) => (watcher.onClose = resolve));
    } catch (err) {
      console.error('App display:', err.message);
    }
    watcher = null;
    displayEnv = null;
    if (current.length) send('appdisplay:windows', (current = []));
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
}

/**
 * Keep Leafdeck in front on the real screen (`display`, the session's WAYLAND_DISPLAY). When another program's window
 * shows up there, Leafdeck's window that was in front is activated again, which raises it in cage, and
 * `onOutside({ id, title, appId })` tells the UI so it can offer to close the program.
 */
async function guardScreen(display, onOutside) {
  let own = 0; // Leafdeck's window that was in front last
  const told = new Set();
  let last = 0;
  const isOwn = (t) => OWN_APP_IDS.has(t.appId.toLowerCase());
  for (;;) {
    try {
      const w = await wltoplevels.watch(display, (list) => {
        if (isNative()) return; // Leafdeck's compositor puts programs' windows in Leafdeck frames
        for (const t of list) if (isOwn(t) && t.states.includes('activated')) own = t.id;
        const stray = list.filter((t) => !isOwn(t) && !PASS_APP_IDS.has(t.appId.toLowerCase()));
        for (const id of told) if (!stray.some((t) => t.id === id)) told.delete(id);
        // Back in front: straight away for a new window, and at most twice a second if one keeps taking focus.
        const fresh = stray.filter((t) => !told.has(t.id));
        if (own && (fresh.length || (stray.some((t) => t.states.includes('activated')) && Date.now() - last > 500))) {
          last = Date.now();
          w.activate(own);
        }
        for (const t of fresh) {
          told.add(t.id);
          onOutside({ id: t.id, title: t.title, appId: t.appId });
        }
      });
      guard = w;
      await new Promise((resolve) => (w.onClose = resolve));
    } catch (err) {
      console.error('Screen guard:', err.message);
    }
    guard = null;
    await sleep(5000);
  }
}

/**
 * The clipboard stays the real screen's. Programs in the display would copy to its own clipboard, which nothing else
 * sees (cage has no data-control protocol to bridge the two), so Claude Code's copy never reached Leafdeck. Shells get
 * wl-copy and wl-paste first on their PATH that run the real ones on `screen`.
 */
function clipboardTools(screen) {
  const dir = path.join(runtimeDir(), 'leafdeck', 'bin');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const tool of ['wl-copy', 'wl-paste']) {
      const real = (process.env.PATH || '/usr/bin').split(':').map((d) => path.join(d, tool)).find((f) => !f.startsWith(dir) && fs.existsSync(f));
      if (!real) continue;
      fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nWAYLAND_DISPLAY='${screen}' exec '${real}' "$@"\n`, { mode: 0o755 });
    }
    clipboardBin = dir;
  } catch (err) {
    console.error('App display clipboard:', err.message);
  }
}

/** Start the display and follow its windows (`send(channel, payload)` reaches the UI), and guard the real screen. */
function init(opts = {}) {
  send = opts.send || send;
  if (opts.native) isNative = opts.native;
  follow();
  if (opts.screen) {
    guardScreen(opts.screen, opts.onOutside || (() => {}));
    clipboardTools(opts.screen);
  }
  return ensure().catch(() => null);
}

/** The environment that sends a program's windows to the display ({} until it runs), and its clipboard to the screen. */
function env() {
  return displayEnv ? { ...displayEnv, ...(clipboardBin && { LEAFDECK_BIN: clipboardBin }) } : {};
}

/** The same, waiting a moment for the display if it's still starting (the first Terminal opens right at sign-in). */
async function envReady(ms = 3000) {
  if (!displayEnv && starting) await Promise.race([starting.catch(() => {}), sleep(ms)]);
  return env();
}

/** A connection to the display's VNC server (raw RFB), paused until the caller is ready for data. */
async function connect() {
  await ensure();
  return new Promise((resolve, reject) => {
    const s = net.connect(VNC_SOCKET());
    s.pause();
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

module.exports = {
  init,
  env,
  envReady,
  connect,
  windows: () => current,
  activate: (id) => watcher?.activate(Number(id)),
  close: (id) => watcher?.close(Number(id)),
  /** Close a program's window on the real screen (one the guard reported). */
  closeOutside: (id) => guard?.close(Number(id)),
};
