// The windows of a wlroots compositor, from outside it: a minimal Wayland client (wire protocol over the compositor's
// socket, no libraries) for wlr-foreign-toplevel-management-unstable-v1. cage implements it, so Leafdeck learns which
// windows an app display holds (title, app id) and can ask one to close or come to the front. Plain Node, no Electron.
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const MANAGER = 'zwlr_foreign_toplevel_manager_v1';
// Handle requests and events (protocol version 3).
const REQ = { activate: 4, close: 5, destroy: 7 };
const EV = { title: 0, appId: 1, state: 4, done: 5, closed: 6 };
const STATE = { 0: 'maximized', 1: 'minimized', 2: 'activated', 3: 'fullscreen' };

function socketPath(display) {
  if (display.startsWith('/')) return display;
  return path.join(process.env.XDG_RUNTIME_DIR || path.join('/run/user', String(os.userInfo().uid)), display);
}

/** Encode a message: object id, opcode and arguments (numbers are uint32, strings are Wayland strings). */
function message(id, opcode, args = []) {
  const parts = [];
  for (const a of args) {
    if (typeof a === 'number') {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(a >>> 0);
      parts.push(b);
    } else {
      const s = Buffer.from(`${a}\0`, 'utf8');
      const b = Buffer.alloc(4 + Math.ceil(s.length / 4) * 4);
      b.writeUInt32LE(s.length);
      s.copy(b, 4);
      parts.push(b);
    }
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(id);
  head.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([head, body]);
}

/** A string argument at `off` in `buf`: [value, offset after it]. */
function readString(buf, off) {
  const len = buf.readUInt32LE(off);
  const value = len ? buf.toString('utf8', off + 4, off + 4 + len - 1) : null;
  return [value, off + 4 + Math.ceil(len / 4) * 4];
}

/**
 * Watch the toplevel windows on the compositor at `display` (a WAYLAND_DISPLAY name or an absolute socket path).
 * `onChange(windows)` gets the full list, oldest first: [{ id, title, appId, states }]. The newest is on top in cage.
 * Resolves with { windows(), activate(id), close(id), stop() }, or rejects when the compositor can't be reached or
 * doesn't offer the protocol.
 */
function watch(display, onChange = () => {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath(display));
    let nextId = 2; // 1 is wl_display
    const REGISTRY = nextId++;
    const SYNC = nextId++;
    let manager = 0;
    let seat = 0;
    const toplevels = new Map(); // object id -> { id, title, appId, states, ready }
    let buf = Buffer.alloc(0);
    let settled = false;
    const send = (id, op, args) => sock.writable && sock.write(message(id, op, args));
    const list = () =>
      [...toplevels.values()].filter((t) => t.ready).map(({ id, title, appId, states }) => ({ id, title, appId, states }));
    const api = {
      windows: list,
      activate(id) {
        if (toplevels.has(id) && seat) send(id, REQ.activate, [seat]);
      },
      close(id) {
        if (toplevels.has(id)) send(id, REQ.close);
      },
      stop() {
        sock.destroy();
      },
    };
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    function event(id, op, body) {
      if (id === 1 && op === 0) {
        const [msg] = readString(body, 8);
        fail(new Error(`Wayland error ${body.readUInt32LE(4)}: ${msg}`));
        sock.destroy();
      } else if (id === REGISTRY && op === 0) {
        const name = body.readUInt32LE(0);
        const [iface, off] = readString(body, 4);
        const version = body.readUInt32LE(off);
        if (iface === MANAGER && !manager) {
          manager = nextId++;
          send(REGISTRY, 0, [name, iface, Math.min(version, 3), manager]);
        } else if (iface === 'wl_seat' && !seat) {
          seat = nextId++;
          send(REGISTRY, 0, [name, iface, 1, seat]);
        }
      } else if (id === SYNC && op === 0) {
        // Every global has been announced (and the binds sent before this reply).
        if (!manager) return fail(new Error(`The compositor doesn’t offer ${MANAGER}`));
        settled = true;
        resolve(api);
      } else if (id === manager && op === 0) {
        const handle = body.readUInt32LE(0);
        toplevels.set(handle, { id: handle, title: '', appId: '', states: [], ready: false });
      } else if (toplevels.has(id)) {
        const t = toplevels.get(id);
        if (op === EV.title) t.title = readString(body, 0)[0] || '';
        else if (op === EV.appId) t.appId = readString(body, 0)[0] || '';
        else if (op === EV.state) {
          const n = body.readUInt32LE(0) / 4;
          t.states = Array.from({ length: n }, (_, i) => STATE[body.readUInt32LE(4 + i * 4)]).filter(Boolean);
        } else if (op === EV.done) {
          t.ready = true;
          onChange(list());
        } else if (op === EV.closed) {
          toplevels.delete(id);
          send(id, REQ.destroy);
          if (t.ready) onChange(list());
        }
      }
    }

    sock.on('connect', () => {
      send(1, 1, [REGISTRY]); // wl_display.get_registry
      send(1, 0, [SYNC]); // wl_display.sync
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const size = buf.readUInt32LE(4) >>> 16;
        if (size < 8 || buf.length < size) break;
        event(buf.readUInt32LE(0), buf.readUInt32LE(4) & 0xffff, buf.subarray(8, size));
        buf = buf.subarray(size);
      }
    });
    sock.on('error', fail);
    sock.on('close', () => {
      fail(new Error('The compositor closed the connection'));
      if (toplevels.size) {
        toplevels.clear();
        onChange([]);
      }
      api.onClose?.();
    });
  });
}

module.exports = { watch };
