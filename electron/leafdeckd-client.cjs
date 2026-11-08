// Leafdeck's connection to leafdeckd (electron/leafdeckd.cjs), Leafdeck OS's user services. Requests return promises;
// events arrive through onEvent. If leafdeckd goes away (an update restarts it), this keeps trying to reconnect.
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** $XDG_RUNTIME_DIR/leafdeck/daemon.sock: the runtime folder belongs to this account and is cleared at shutdown. */
const socketPath = () => path.join(process.env.XDG_RUNTIME_DIR || path.join('/run/user', String(os.userInfo().uid)), 'leafdeck', 'daemon.sock');

let sock = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject }
const listeners = new Set();
let reconnecting = false;

function attach(s) {
  sock = s;
  s.setEncoding('utf8');
  let buf = '';
  s.on('data', (chunk) => {
    buf += chunk;
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
      if (msg.event) for (const fn of listeners) fn(msg.event, msg.data);
      else if (pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    }
  });
  s.on('error', () => {});
  s.on('close', () => {
    if (sock === s) sock = null;
    for (const p of pending.values()) p.reject(new Error('Leafdeck’s services stopped'));
    pending.clear();
    reconnect();
  });
}

const tryConnect = () =>
  new Promise((resolve) => {
    const s = net.connect(socketPath());
    s.once('connect', () => {
      attach(s);
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });

async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  while (!sock) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await tryConnect()) for (const fn of listeners) fn('daemon:reconnected', {});
  }
  reconnecting = false;
}

/**
 * Connect to leafdeckd, starting it through systemd if it isn't running yet (its unit ships with Leafdeck OS). Resolves
 * false when there's no leafdeckd here (Leafdeck on another Linux): Leafdeck then runs these services itself.
 */
async function start() {
  if (await tryConnect()) return true;
  const started = await new Promise((resolve) =>
    execFile('systemctl', ['--user', 'start', 'leafdeckd.service'], { timeout: 8000 }, (err) => resolve(!err)),
  );
  if (!started) return false;
  for (let i = 0; i < 30; i++) {
    if (await tryConnect()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function request(method, params = {}) {
  if (!sock) return Promise.reject(new Error('Leafdeck’s services aren’t running'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

const onEvent = (fn) => listeners.add(fn);

module.exports = { socketPath, start, request, onEvent, connected: () => !!sock };
