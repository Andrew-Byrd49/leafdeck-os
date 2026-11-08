// DevTools in a Leafdeck window (Leafdeck OS). Chromium opens a page's DevTools as a window of its own, and in the
// session that window takes the whole screen (cage shows one window at a time) with no way back to Leafdeck. So there,
// DevTools is Chromium's DevTools frontend running in a webview of a Leafdeck window (public/js/apps/devtools.js), in
// its standalone mode: it talks to the page over a WebSocket, the way it does for remote debugging. That WebSocket is
// served here, on 127.0.0.1 behind a random token, and carries the protocol to and from the page's webContents.debugger.
// (setDevToolsWebContents with a webview loads the frontend without its connection to the page in this Electron.)
//
// The page's debugger is shared: light/dark emulation, freezing and the leafdeck_* tools use it too. A bridge attaches
// it only if nobody has, and on closing detaches only what it attached and nobody else still needs.
const http = require('http');
const crypto = require('crypto');

const FRONTEND = 'devtools://devtools/bundled/devtools_app.html';
const ORIGIN = 'devtools://devtools';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let server = null;
let port = 0;
const bridges = new Map(); // token -> { wc, at, keepAttached, socket, onClose }

async function listen() {
  if (server) return;
  server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => upgrade(req, socket));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
}

/**
 * A frontend address for this page's DevTools, good for one connection.
 * at: { x, y } in the page, to show that element; keepAttached(): whether the page's debugger must stay attached
 * after DevTools closes; onClose(): DevTools lost the page (it closed, crashed or was detached).
 */
async function frontendUrl(wc, { at = null, keepAttached = () => false, onClose = () => {} } = {}) {
  await listen();
  const token = crypto.randomBytes(24).toString('hex');
  bridges.set(token, { wc, at, keepAttached, onClose, socket: null });
  return `${FRONTEND}?ws=127.0.0.1:${port}/${token}`;
}

/** Whether a page's DevTools is open (or opening). */
const isOpen = (wc) => [...bridges.values()].some((b) => b.wc === wc);

/** Show the element at { x, y } in a page's open DevTools. */
function inspect(wc, at) {
  for (const b of bridges.values()) {
    if (b.wc === wc && b.send) reveal({ ...b, at }, b.send);
  }
}

/** Close the DevTools connection(s) of a page. */
function close(wc) {
  for (const [token, b] of bridges) if (b.wc === wc) end(token);
}

function upgrade(req, socket) {
  const token = (req.url || '').replace(/^\//, '');
  const b = bridges.get(token);
  const key = req.headers['sec-websocket-key'];
  if (!b || b.socket || req.headers.origin !== ORIGIN || !key || b.wc.isDestroyed()) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  b.socket = socket;

  const dbg = b.wc.debugger;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      b.mine = true;
    }
  } catch (err) {
    console.error('[devtools]', err.message);
    return end(token);
  }
  const send = (obj) => socket.writable && socket.write(frame(JSON.stringify(obj)));
  b.send = send;
  b.onMessage = (_e, method, params, sessionId) => send(sessionId ? { method, params, sessionId } : { method, params });
  b.onDetach = () => end(token);
  b.onGone = () => end(token);
  dbg.on('message', b.onMessage);
  dbg.on('detach', b.onDetach);
  b.wc.once('destroyed', b.onGone);

  let revealed = !b.at;
  const command = async (msg) => {
    let reply;
    try {
      reply = { id: msg.id, result: await dbg.sendCommand(msg.method, msg.params || {}, msg.sessionId) };
    } catch (err) {
      reply = { id: msg.id, error: { code: -32000, message: err.message } };
    }
    if (msg.sessionId) reply.sessionId = msg.sessionId;
    send(reply);
    // Inspect: once the frontend has the page's document, show the element that was right-clicked.
    if (!revealed && !msg.sessionId && msg.method === 'DOM.getDocument' && reply.result) {
      revealed = true;
      setTimeout(() => reveal(b, send), 150);
    }
  };
  readFrames(socket, (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg && typeof msg.method === 'string') command(msg);
  }, () => end(token));
}

async function reveal(b, send) {
  try {
    const { backendNodeId } = await b.wc.debugger.sendCommand('DOM.getNodeForLocation', { x: Math.round(b.at.x), y: Math.round(b.at.y) });
    // What the page sends when you pick an element with DevTools' own picker: the Elements panel opens on it.
    if (backendNodeId) send({ method: 'Overlay.inspectNodeRequested', params: { backendNodeId } });
  } catch {}
}

function end(token) {
  const b = bridges.get(token);
  if (!b) return;
  bridges.delete(token);
  if (b.socket?.writable) {
    b.socket.write(Buffer.from([0x88, 0x00])); // close frame
    b.socket.end();
  }
  const wc = b.wc;
  if (!wc.isDestroyed()) {
    wc.removeListener('destroyed', b.onGone || (() => {}));
    if (b.onMessage) wc.debugger.removeListener('message', b.onMessage);
    if (b.onDetach) wc.debugger.removeListener('detach', b.onDetach);
    if (wc.debugger.isAttached()) {
      if (b.mine && !b.keepAttached()) {
        try {
          wc.debugger.detach();
        } catch {}
      } else if (b.socket) {
        // Someone else still uses the debugger: don't leave the page stopped at a breakpoint or highlighted.
        for (const m of ['Debugger.disable', 'Overlay.disable']) wc.debugger.sendCommand(m).catch(() => {});
      }
    }
  }
  b.onClose();
}

/* ----- WebSocket frames (RFC 6455): text in and out, ping, close ----- */

function frame(text) {
  const data = Buffer.from(text);
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, data]);
}

function readFrames(socket, onText, onEnd) {
  let buf = Buffer.alloc(0);
  let parts = []; // a fragmented message so far
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (!masked) return socket.destroy(); // clients must mask
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) return onEnd(); // answered with a close frame
      if (op === 0x9) {
        if (socket.writable) socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); // pong (ping payloads are < 126 bytes)
        continue;
      }
      if (op === 0x1 || op === 0x0) {
        parts.push(data);
        if (fin) {
          onText(Buffer.concat(parts).toString('utf8'));
          parts = [];
        }
      }
    }
  });
  socket.on('close', onEnd);
  socket.on('error', () => socket.destroy());
}

module.exports = { frontendUrl, isOpen, inspect, close };
