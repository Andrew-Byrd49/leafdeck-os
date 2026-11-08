// Leafdeck OS notifications: the session's notification service (org.freedesktop.Notifications), so notify-send,
// Linux apps and system services show their notifications as cards in Leafdeck. The D-Bus side is a small Python helper
// (electron/notify-helper.py, like the terminal's pty-helper.py); this relays between it and the UI.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Inside a packaged app the helper is unpacked next to app.asar (electron-builder asarUnpack), since Python can't read the archive.
const HELPER = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'notify-helper.py');

let send = () => {};
let child = null;
let starts = [];
let stopped = false;
// Open notifications, so the UI can show ones that arrived while it was loading (at sign-in, after a reload).
const open = new Map();

function start() {
  if (!fs.existsSync(HELPER) || stopped) return;
  // Keeps restarting after a crash, but gives up if it can't stay up (no D-Bus). When another service has the name
  // (a Leafdeck still running its own, while leafdeckd starts), it tries again every 15 seconds instead.
  starts = [...starts.filter((t) => Date.now() - t < 60_000), Date.now()];
  if (starts.length > 3) return console.error('[os] notifications: helper keeps stopping; giving up');
  let buf = '';
  let taken = false;
  child = spawn('python3', [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.notify) {
        open.set(msg.notify.id, msg.notify);
        send('os:notification', msg.notify);
      } else if (msg.close) {
        open.delete(msg.close);
        send('os:notification-close', { id: msg.close });
      }
      else if (msg.error) {
        taken = true;
        console.error('[os] notifications:', msg.error);
      }
    }
  });
  child.stderr.on('data', (d) => console.error('[os] notifications:', String(d).trim()));
  child.on('exit', () => {
    child = null;
    if (taken) starts.pop(); // not a crash
    if (!stopped) setTimeout(start, taken ? 15_000 : 2000);
  });
}

function init(opts) {
  send = opts.send;
  start();
}

const write = (obj) => child?.stdin.write(JSON.stringify(obj) + '\n');
/** The person clicked the card (key "default") or one of its buttons. */
function invoke(id, key) {
  open.delete(Number(id));
  write({ action: Number(id) || 0, key: String(key || 'default').slice(0, 120) });
}
/** The card went away: 1 expired, 2 dismissed. */
function closed(id, reason) {
  open.delete(Number(id));
  write({ closed: Number(id) || 0, reason: reason === 1 ? 1 : 2 });
}
const list = () => [...open.values()];

function stop() {
  stopped = true;
  child?.kill();
}

module.exports = { init, invoke, closed, list, stop };
