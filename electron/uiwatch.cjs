'use strict';
/* Leafdeck OS: when the UI stops, the log says how.
 *
 * A frozen screen looks the same whatever froze it, and nothing else writes it down. So every couple of seconds the main
 * process asks the UI page two things: does its JavaScript answer, and does it get to draw a frame. When either doesn't
 * happen in time, one `[ui] stopped` line says which, with what the page's process and the GPU process were doing, how
 * many pictures each screen really showed, and (when the page's JavaScript is what's stuck) where it's stuck. A second
 * line says when it came back. Read them with: journalctl -b | grep '\[ui\]'
 *
 *   not answering  the page's main thread is busy or blocked: its JavaScript, or something it waits for
 *   not drawing    the page runs but its frames don't come: the GPU process or the compositor (cage)
 */
const fs = require('fs');
const { app } = require('electron');

const EVERY = 2000; // between checks
const LIMIT = 1500; // how long an answer or a frame may take
const STACK_AFTER = 4000; // still not answering after this: look where its JavaScript is

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let deps = null;
let checking = false;

/** CPU time used so far by the page's process, the GPU process and the main process, in clock ticks (Linux). */
function cpuTicks(wc) {
  const ticks = (pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(f[11]) + Number(f[12]); // utime + stime
    } catch {
      return NaN;
    }
  };
  const gpu = app.getAppMetrics().find((m) => m.type === 'GPU');
  return { at: Date.now(), page: ticks(wc.getOSProcessId()), gpu: ticks(gpu?.pid), main: ticks(process.pid) };
}

/** "page 100%, gpu 3%, main 0%" between two readings: percent of one core. */
function cpuBetween(a, b) {
  const pct = (k) => (Number.isFinite(b[k] - a[k]) ? `${Math.round(((b[k] - a[k]) * 1000) / (b.at - a.at || 1))}%` : '?');
  return `page ${pct('page')}, gpu ${pct('gpu')}, main ${pct('main')}`;
}

/** The debugger stays attached to the UI page with its Debugger domain on: a page that has stopped can't be attached
 *  to any more, and only one that was listening already can be paused and asked where it is. (Leafdeck's DevTools
 *  turns the domain off when it closes, so this is said again at every check.) */
function attach(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Debugger.enable').catch(() => {});
  } catch {}
}

/** Where the page's JavaScript is right now, by pausing it for a moment; '' when it can't be paused (it's blocked in
 *  the browser's own code, not running JavaScript). */
async function stackOf(wc) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) return '';
  let onMessage = null;
  try {
    const paused = new Promise((resolve) => {
      onMessage = (_e, method, params) => method === 'Debugger.paused' && resolve(params);
      dbg.on('message', onMessage);
    });
    dbg.sendCommand('Debugger.pause').catch(() => {});
    const params = await Promise.race([paused, wait(3000)]);
    if (!params) return '';
    return (params.callFrames || [])
      .slice(0, 8)
      .map((f) => `${f.functionName || '(anonymous)'} ${String(f.url || '').replace(/^.*\/js\//, '')}:${f.location.lineNumber + 1}`)
      .join(' < ');
  } catch {
    return '';
  } finally {
    if (onMessage) dbg.off('message', onMessage);
    dbg.sendCommand('Debugger.resume').catch(() => {});
  }
}

async function check() {
  const win = deps.mainWindow();
  if (checking || !win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed() || wc.isCrashed() || wc.isLoadingMainFrame()) return;
  checking = true;
  attach(wc);
  // A reload ends the page these questions were put to: they'd never be answered.
  let reloaded = false;
  const onNavigation = (details) => {
    if (details.frame === wc.mainFrame && !details.isSameDocument) reloaded = true;
  };
  wc.on('did-start-navigation', onNavigation);
  const gone = () => reloaded || win.isDestroyed() || wc.isDestroyed() || wc.isCrashed();
  try {
    const started = Date.now();
    let visibility = null; // the page's answer
    let drew = false;
    const settled = () => visibility !== null && (drew || visibility !== 'visible');
    let asked = 0;
    const ask = () => {
      asked = Date.now();
      wc.executeJavaScript('document.visibilityState')
        .then((v) => {
          visibility = String(v);
          if (visibility !== 'visible') return null; // a hidden page isn't asked to draw
          return wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => r(1)))').then(() => (drew = true));
        })
        .catch(() => (reloaded = true));
    };
    ask();
    while (!settled() && !gone() && Date.now() - started < LIMIT) await wait(100);
    if (settled() || gone()) return;

    const answering = visibility !== null;
    const before = cpuTicks(wc);
    const [fps] = await Promise.all([deps.screenFps().catch(() => ({})), wait(1000)]);
    if (settled() || gone()) {
      console.log(`[ui] stopped for ${((Date.now() - started) / 1000).toFixed(1)} s (${answering ? 'not drawing' : 'not answering'})`);
      return;
    }
    console.error(
      `[ui] stopped: ${answering ? 'the page runs but is not drawing' : 'the page is not answering'}` +
        `; cpu ${cpuBetween(before, cpuTicks(wc))}; screens ${JSON.stringify(fps)} fps` +
        `; ${deps.isLocked() ? 'locked' : 'not locked'}`
    );
    let looked = answering; // only a page that isn't answering has a stack worth reading
    while (!settled() && !gone()) {
      await wait(250);
      // A page that answers is asked again now and then: it may have been hidden since, or lost the frame it was promised.
      if (visibility !== null && Date.now() - asked > EVERY) ask();
      if (!looked && visibility === null && Date.now() - started > STACK_AFTER) {
        looked = true;
        const stack = await stackOf(wc);
        console.error(`[ui] stopped in: ${stack || "(couldn't pause it: it isn't in JavaScript)"}`);
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.error(reloaded || gone() ? `[ui] reloaded ${seconds} s after it stopped` : `[ui] back after ${seconds} s`);
  } finally {
    wc.off('did-start-navigation', onNavigation);
    checking = false;
  }
}

/** deps: { mainWindow(), isLocked(), screenFps() }. */
function init(d) {
  deps = d;
  setInterval(() => check().catch(() => (checking = false)), EVERY).unref();
}

module.exports = { init };
