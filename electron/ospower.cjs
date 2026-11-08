// Leafdeck OS: power settings (Settings → Power) and what happens when the computer is left alone.
// Power modes through power-profiles-daemon's D-Bus API (tuned-ppd provides it on Fedora). The lid and the power button
// are logind's: it acts on them even when Leafdeck isn't running, so Leafdeck only changes its settings, through a small
// root helper (os/leafdeck-power), and reads them back from logind. Sleeping when idle, turning the screen off, battery
// saver and Keep awake happen here. cage can't power a screen down, so "off" is a black window above everything (an OLED
// panel's pixels are then off) with the built-in screens' backlight at zero; any input brings it back.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { BrowserWindow, powerMonitor } = require('electron');
const osSystem = require('./ossystem.cjs');

let deps = null; // { settings(), saveSettings(patch), idleMs(), touch(), lock(reason), isLocked(), send(channel, payload) }

const run = (cmd, args, timeout = 6000) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve(String(stdout)),
    ),
  );
const quiet = (p) => p.catch(() => null);

/* ---------------- D-Bus (busctl) ---------------- */

const LOGIND = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'];
const PPD = ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles'];
const unwrap = (v) => (v && typeof v === 'object' && 'data' in v ? unwrap(v.data) : Array.isArray(v) ? v.map(unwrap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)])) : v);
async function prop([dest, obj, iface], name) {
  const out = await quiet(run('busctl', ['--system', '--json=short', 'get-property', dest, obj, iface, name], 3000));
  try {
    return out ? unwrap(JSON.parse(out)) : null;
  } catch {
    return null;
  }
}
async function call([dest, obj, iface], method) {
  const out = await quiet(run('busctl', ['--system', '--json=short', 'call', dest, obj, iface, method], 3000));
  try {
    return out ? unwrap(JSON.parse(out))[0] : null;
  } catch {
    return null;
  }
}

/* ---------------- power modes ---------------- */

const MODES = ['power-saver', 'balanced', 'performance'];
/** { active, available: [...], degraded: why performance is held back ('' if it isn't) }, or null without the service. */
async function modes() {
  const [active, list, degraded] = await Promise.all([prop(PPD, 'ActiveProfile'), prop(PPD, 'Profiles'), prop(PPD, 'PerformanceDegraded')]);
  if (!active) return null;
  return { active, available: MODES.filter((m) => (list || []).some((p) => p.Profile === m)), degraded: degraded || '' };
}
async function setMode(mode, { bySaver = false } = {}) {
  if (!MODES.includes(mode)) throw new Error('Unknown power mode');
  await run('busctl', ['--system', 'set-property', ...PPD, 'ActiveProfile', 's', mode]);
  // Choosing a mode yourself ends battery saver's turn: plugging in won't switch it back.
  if (!bySaver && deps.settings().saverFrom) deps.saveSettings({ saverFrom: '' });
  return modes();
}

/* ---------------- sleep, hibernate, lid, power button ---------------- */

const HELPERS = ['/usr/libexec/leafdeck/leafdeck-power', '/usr/local/sbin/leafdeck-power'];
let helperOk = false; // the helper is installed and its sudo rule works (checked until it does)
const helper = () => HELPERS.find((h) => fs.existsSync(h));
async function canChange() {
  if (!helperOk) helperOk = !!helper() && !!(await quiet(run('sudo', ['-n', helper(), '--check'], 5000)));
  return helperOk;
}
const runHelper = (...args) => run('sudo', ['-n', helper(), ...args], 15000);

const yes = (v) => v === 'yes' || v === 'challenge'; // challenge: allowed after the polkit agent (Leafdeck's) asks
/** Why hibernating isn't possible, in words for Settings ('' when it is). */
function hibernateWhy() {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  if (/\[(integrity|confidentiality)\]/.test(read('/sys/kernel/security/lockdown')))
    return 'Secure Boot is on, and Linux can’t hibernate while Secure Boot locks the kernel down. Sleep works as usual.';
  const mem = Number((read('/proc/meminfo').match(/^MemTotal:\s+(\d+)/m) || [])[1]) || 0;
  const swap = read('/proc/swaps')
    .split('\n')
    .slice(1)
    .filter((l) => l && !l.startsWith('/dev/zram'))
    .reduce((n, l) => n + (Number(l.split(/\s+/)[2]) || 0), 0);
  if (swap < mem) return 'Hibernating needs a swap partition or file at least as big as the memory (zram doesn’t count).';
  return 'This computer doesn’t support hibernating.';
}
let hibernateCache = null;
async function sleepInfo() {
  if (!hibernateCache) {
    const [suspend, hibernate, then] = await Promise.all([call(LOGIND, 'CanSuspend'), call(LOGIND, 'CanHibernate'), call(LOGIND, 'CanSuspendThenHibernate')]);
    hibernateCache = { suspend: yes(suspend), hibernate: yes(hibernate), suspendThenHibernate: yes(then) };
    hibernateCache.hibernateWhy = hibernateCache.hibernate ? '' : hibernateWhy();
  }
  return hibernateCache;
}

const lidPath = (() => {
  try {
    const d = fs.readdirSync('/proc/acpi/button/lid')[0];
    return d ? `/proc/acpi/button/lid/${d}/state` : null;
  } catch {
    return null;
  }
})();
function lidClosed() {
  try {
    return lidPath ? /closed/.test(fs.readFileSync(lidPath, 'utf8')) : false;
  } catch {
    return false;
  }
}

/** What logind does with the lid and the power button now (its settings, whoever wrote them). */
let buttonsCache = null;
async function buttons() {
  const [lid, lidAc, key, docked] = await Promise.all([
    prop(LOGIND, 'HandleLidSwitch'),
    prop(LOGIND, 'HandleLidSwitchExternalPower'),
    prop(LOGIND, 'HandlePowerKey'),
    prop(LOGIND, 'Docked'),
  ]);
  buttonsCache = { lid: lid || 'suspend', lidAc: lidAc || lid || 'suspend', key: key || 'poweroff', docked: !!docked, hasLid: !!lidPath, canChange: await canChange() };
  return buttonsCache;
}
async function setButtons(patch) {
  if (!(await canChange())) throw new Error('Run os/setup-fedora.sh once to change these');
  const cur = await buttons();
  const next = { lid: cur.lid, lidAc: cur.lidAc, key: cur.key, ...patch };
  await runHelper('buttons', String(next.lid), String(next.lidAc), String(next.key));
  // logind rereads its settings in the background.
  await new Promise((r) => setTimeout(r, 300));
  return buttons();
}

async function setCharge(value) {
  if (!(await canChange())) throw new Error('Run os/setup-fedora.sh once to change this');
  if (typeof value === 'number') {
    await runHelper('limit', String(Math.round(value)));
    deps.saveSettings({ chargeLimit: Math.round(value) }); // some laptops forget it at startup; Leafdeck sets it again
  } else await runHelper('charge', String(value));
  return osSystem.batteryDetails();
}

/** Everything Settings → Power shows. */
async function info() {
  const [m, s, b] = await Promise.all([modes(), sleepInfo(), buttons()]);
  return { modes: m, sleep: s, buttons: b, battery: osSystem.batteryDetails(), awake, onBattery: powerMonitor.isOnBatteryPower() };
}

/* ---------------- the screen off ---------------- */

const BRIGHT_FLAG = path.join(process.env.XDG_RUNTIME_DIR || require('node:os').tmpdir(), 'leafdeck-screen-off');
let cover = null; // { win, reason: 'idle' | 'lid', since }
let backlight = null; // the brightness to come back to

function makeCover() {
  const w = new BrowserWindow({
    fullscreen: true,
    frame: false,
    show: true,
    backgroundColor: '#000000',
    title: 'Leafdeck Screen Off',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.setMenu?.(null);
  w.loadURL('data:text/html,<html style="background:%23000;cursor:none;height:100%25"></html>');
  // Any key, click, touch or real movement wakes it. The first moment is ignored: the compositor reports the pointer
  // entering the new window, and a hand just leaving the keyboard shouldn't undo it.
  const wake = () => cover && Date.now() - cover.since > 1200 && screenOn();
  w.webContents.on('before-input-event', (e) => {
    e.preventDefault();
    wake();
  });
  w.webContents.on('input-event', wake);
  w.on('closed', () => cover?.win === w && screenOn());
  return w;
}
async function screenOff(reason) {
  if (cover) return;
  cover = { win: null, reason, since: Date.now() };
  cover.win = makeCover();
  const b = await quiet(osSystem.brightness());
  if (b && cover && b.percent > 0) {
    backlight = b.percent;
    // If Leafdeck stops while the screen is off, the next start puts the brightness back (restoreBacklight).
    quiet(fs.promises.writeFile(BRIGHT_FLAG, String(backlight)));
    quiet(osSystem.setBrightness(0, { off: true }));
  }
}
function screenOn() {
  if (!cover) return;
  const w = cover.win;
  cover = null;
  if (w && !w.isDestroyed()) w.destroy();
  if (backlight) quiet(osSystem.setBrightness(backlight));
  backlight = null;
  fs.rm(BRIGHT_FLAG, { force: true }, () => {});
  deps.touch();
}
function restoreBacklight() {
  try {
    const pct = Number(fs.readFileSync(BRIGHT_FLAG, 'utf8'));
    if (pct > 0) quiet(osSystem.setBrightness(pct));
    fs.rmSync(BRIGHT_FLAG, { force: true });
  } catch {}
}
/** The lock screen just opened (it's the newest window, so it would show): keep the screen off above it. */
function onLock() {
  if (!cover) return;
  const old = cover.win;
  cover.win = makeCover();
  cover.since = Date.now();
  if (old && !old.isDestroyed()) old.destroy();
}

/* ---------------- left alone ---------------- */

let awake = false; // Keep awake: no screen off, sleep or lock until it's turned off
function keepAwake(on) {
  awake = !!on;
  if (awake) deps.touch();
  return awake;
}

// Another program asking the computer not to idle (a video player, a presentation, through logind).
const idleInhibited = async () => /\bidle\b/.test((await prop(LOGIND, 'BlockInhibited')) || '');

let slept = false;
async function tick() {
  if (awake) return deps.touch();
  const s = deps.settings();
  const onBattery = powerMonitor.isOnBatteryPower();
  const idle = deps.idleMs();
  const offAfter = Number(onBattery ? s.screenOffAfter : s.screenOffAfterAc) || 0;
  const sleepAfter = Number(onBattery ? s.sleepAfter : s.sleepAfterAc) || 0;
  if (idle < 60_000) slept = false;
  const wantOff = !cover && offAfter && idle >= offAfter * 60_000;
  const wantSleep = !slept && sleepAfter && idle >= sleepAfter * 60_000;
  if ((wantOff || wantSleep) && !(await idleInhibited())) {
    if (wantOff) screenOff('idle');
    if (wantSleep) {
      slept = true;
      quiet(osSystem.power('sleep'));
    }
  }
  batterySaver(s).catch(() => {});
}

/* Battery saver: on battery, at or below the level you choose, switch to Power saver; plugged in again, back to the mode
   from before (unless you've chosen one yourself since). saverFrom is that mode, kept so a restart doesn't lose it. */
async function batterySaver(s) {
  const b = osSystem.battery();
  if (!b) return;
  const at = Number(s.saverAt ?? 20);
  if (!b.charging && at && b.percent <= at && !s.saverFrom) {
    const m = await modes();
    if (!m || m.active === 'power-saver' || !m.available.includes('power-saver')) return;
    deps.saveSettings({ saverFrom: m.active });
    await setMode('power-saver', { bySaver: true });
    deps.send('os:toast', { text: `Battery saver is on (${b.percent}%): Power saver mode until you plug in` });
  } else if (b.charging && s.saverFrom) {
    const m = await modes();
    deps.saveSettings({ saverFrom: '' });
    if (m?.active === 'power-saver') await setMode(s.saverFrom, { bySaver: true });
  }
}

/* The lid, when logind is set to lock rather than sleep ("Turn off the screen"): Leafdeck locks and turns the screen off
   itself, and turns it back on when the lid opens. Docked (another screen in use), logind ignores the lid; so does this. */
let lidWas = false;
function watchLid() {
  if (!lidPath) return;
  lidWas = lidClosed();
  setInterval(async () => {
    const closed = lidClosed();
    if (closed === lidWas) return;
    lidWas = closed;
    if (!closed) return void (cover?.reason === 'lid' && screenOn());
    const b = await buttons();
    if ((powerMonitor.isOnBatteryPower() ? b.lid : b.lidAc) !== 'lock' || b.docked) return;
    deps.lock('lid');
    screenOff('lid');
  }, 2000);
}

function init(d) {
  deps = d;
  restoreBacklight();
  setInterval(() => tick().catch(() => {}), 15_000);
  watchLid();
  powerMonitor.on('resume', () => {
    slept = false;
    if (cover?.reason === 'idle') screenOn();
  });
  // Plugging in or out changes which timers apply, and battery saver's turn.
  powerMonitor.on('on-ac', () => tick().catch(() => {}));
  powerMonitor.on('on-battery', () => tick().catch(() => {}));
  // A charge limit some laptops forget at startup.
  const limit = Number(d.settings().chargeLimit);
  const now = osSystem.batteryDetails()?.chargeLimit;
  if (limit && now != null && now !== limit) canChange().then((ok) => ok && quiet(runHelper('limit', String(limit))));
}

module.exports = { init, info, modes, setMode, sleepInfo, setButtons, setCharge, keepAwake, isAwake: () => awake, onLock, screenOff, screenOn };
