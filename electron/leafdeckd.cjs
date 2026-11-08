// leafdeckd: Leafdeck OS's own services for the signed-in person (os/ARCHITECTURE.md). A systemd user service
// (os/leafdeckd.service) running on the system's Node, outside Leafdeck, so restarting or crashing Leafdeck loses
// nothing: shells keep running, notifications keep arriving. Leafdeck connects over a socket only this account can open
// (electron/leafdeckd-client.cjs).
//
// Protocol: one JSON object per line. Requests { id, method, params } get { id, result } or { id, error }; events go to
// every connected client as { event, data }. Terminal output is base64 (it's raw bytes, not always whole UTF-8).
//
// Today: terminals (terminal.cjs), Claude Code chats' processes (chathost.cjs), notifications (osnotify.cjs), and links
// opened by other programs (os/leafdeck-open, the session's web browser). Next: devices, screens and power over D-Bus.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const terminal = require('./terminal.cjs');
const notify = require('./osnotify.cjs');
const chats = require('./chathost.cjs');
const { socketPath } = require('./leafdeckd-client.cjs');

const VERSION = 1;
const clients = new Set();
const leafdecks = new Set(); // clients that are Leafdeck itself (they said hello as 'leafdeck')

function broadcast(event, data) {
  const line = JSON.stringify({ event, data }) + '\n';
  for (const c of clients) c.write(line);
}

terminal.init({ send: (event, p) => broadcast(event, event === 'term:data' ? { id: p.id, data: p.data.toString('base64') } : p) });
notify.init({ send: broadcast });
chats.init({ send: (sock, event, data) => sock.write(JSON.stringify({ event, data }) + '\n') });

const str = (v, max = 1 << 20) => String(v ?? '').slice(0, max);
const methods = {
  ping: () => ({ version: VERSION, pid: process.pid }),
  hello: (p, sock) => {
    if (p.role === 'leafdeck') leafdecks.add(sock);
    return { version: VERSION };
  },
  // A link from another program (gh auth login, a sign-in flow, xdg-open): Leafdeck opens it.
  'open-url': (p) => {
    const url = str(p.url, 8000);
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
    const open = [...leafdecks].filter((s) => !s.destroyed);
    if (!open.length) throw new Error('Leafdeck isn’t running');
    for (const s of open) s.write(JSON.stringify({ event: 'open-url', data: { url } }) + '\n');
    return true;
  },
  // A picture from another program (xdg-open photo.jpg, a file manager's double-click): Image Viewer shows it.
  'open-file': (p) => {
    const file = str(p.path, 4096);
    if (!file.startsWith('/')) throw new Error('Give the file’s full path');
    const open = [...leafdecks].filter((s) => !s.destroyed);
    if (!open.length) throw new Error('Leafdeck isn’t running');
    for (const s of open) s.write(JSON.stringify({ event: 'open-file', data: { path: file } }) + '\n');
    return true;
  },
  'term.open': (p) => terminal.open({ cols: p.cols, rows: p.rows, cwd: p.cwd, env: p.env }),
  'term.write': (p) => terminal.write(str(p.id, 40), str(p.data)),
  'term.resize': (p) => terminal.resize(str(p.id, 40), p.cols, p.rows),
  'term.close': (p) => terminal.close(str(p.id, 40)),
  'term.closeAll': () => terminal.closeAll(),
  'term.info': (p) => terminal.info(str(p.id, 40)),
  'term.list': () => terminal.list().map((t) => ({ id: t.id, buffer: t.buffer.toString('base64') })),
  'chat.open': (p, sock) => chats.open({ key: str(p.key, 200), exe: str(p.exe, 4096), args: p.args, cwd: str(p.cwd, 4096), env: p.env }, sock),
  'chat.write': (p) => chats.write(p),
  'chat.end': (p) => chats.end(p),
  'chat.kill': (p) => chats.kill(p),
  'chat.ack': (p) => chats.ack(p),
  'chat.attach': (p, sock) => chats.attach(p, sock),
  'chat.list': () => chats.list(),
  'notify.invoke': (p) => notify.invoke(p.id, p.key),
  'notify.closed': (p) => notify.closed(p.id, p.reason),
  'notify.list': () => notify.list(),
};

function serve(sock) {
  clients.add(sock);
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', async (chunk) => {
    buf += chunk;
    if (buf.length > 8 << 20) return sock.destroy(); // a client gone wrong
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
      const fn = Object.hasOwn(methods, msg.method) ? methods[msg.method] : null;
      let reply;
      try {
        if (!fn) throw new Error(`Unknown method: ${msg.method}`);
        reply = { id: msg.id, result: (await fn(msg.params || {}, sock)) ?? null };
      } catch (err) {
        reply = { id: msg.id, error: err.message };
      }
      if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    clients.delete(sock);
    leafdecks.delete(sock);
    chats.detach(sock);
  });
}

function listen() {
  const file = socketPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700); // only this account
  const server = net.createServer(serve);
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    // A socket file is there: another leafdeckd answering means this one isn't needed; a stale file is replaced.
    const probe = net.connect(file);
    probe.on('connect', () => {
      console.error('leafdeckd is already running');
      process.exit(0);
    });
    probe.on('error', () => {
      fs.rmSync(file, { force: true });
      server.listen(file);
    });
  });
  server.listen(file, () => console.log(`leafdeckd ${VERSION} listening on ${file}`));
  const stop = () => {
    terminal.closeAll();
    chats.closeAll();
    notify.stop();
    server.close();
    fs.rmSync(file, { force: true });
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

listen();
