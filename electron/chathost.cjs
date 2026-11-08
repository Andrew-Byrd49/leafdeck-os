// Claude Code chats' processes, held outside Leafdeck so a restart or crash of Leafdeck doesn't stop them
// (electron/agentchat.cjs is the chat itself). The first half runs in leafdeckd (electron/leafdeckd.cjs), plain Node; it
// knows nothing about what's in the lines. The second half (client) is Leafdeck's side: a stand-in for a child process.
//
// Each line Claude Code prints gets a number and is kept until Leafdeck says it's safe (ack: its effects are on disk).
// After a restart Leafdeck attaches from the last number it saved, so nothing is lost and nothing is applied twice.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

let send = () => {}; // (client socket, event, data)
const chats = new Map(); // chat id -> { key, child, cwd, client, seq, held: [[seq, line]], size, tail, stderr, exit }
// With no Leafdeck attached, Claude Code waits (its output pipe fills) rather than this filling up memory.
const HOLD_MAX = 64 << 20;
const KILL_AFTER_MS = 1500;
const STDIN_PIECE = 768 * 1024; // bytes per chat.write: a message with pictures can be 80 MB

const tell = (c, event, data = {}) => {
  if (c.client && !c.client.destroyed) send(c.client, event, { key: c.key, ...data });
};

function line(c, text) {
  if (!text.trim()) return;
  const seq = ++c.seq;
  c.held.push([seq, text]);
  c.size += text.length;
  if (c.client) tell(c, 'chat:out', { seq, line: text });
  else if (c.size > HOLD_MAX) c.child.stdout.pause();
}

function finish(c, code) {
  if (c.exit) return;
  c.exit = { code };
  line(c, c.tail);
  c.tail = '';
  if (chats.get(c.key) !== c) return;
  if (c.client && !c.client.destroyed) {
    tell(c, 'chat:exit', { code });
    chats.delete(c.key);
  }
  // Otherwise it stays until Leafdeck attaches and has read the end of it.
}

function open({ key, exe, args, cwd, env }, client) {
  const old = chats.get(key);
  if (old) {
    chats.delete(key);
    old.child.kill();
  }
  const child = spawn(exe, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const c = { key, child, cwd, client, seq: 0, held: [], size: 0, tail: '', stderr: '', exit: null };
  chats.set(key, c);
  child.stdin.on('error', () => {}); // it went away; 'close' says so
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    const parts = d.split('\n');
    parts[0] = c.tail + parts[0];
    c.tail = parts.pop();
    for (const p of parts) line(c, p);
  });
  child.stderr.on('data', (d) => {
    c.stderr = (c.stderr + d).slice(-2000);
    tell(c, 'chat:err', { data: d });
  });
  child.on('error', (err) => {
    tell(c, 'chat:error', { message: err.message });
    finish(c, null);
  });
  // 'close' comes after the last output; a helper still holding the pipes shouldn't keep it from ending.
  child.on('close', (code) => finish(c, code));
  child.on('exit', (code) => setTimeout(() => finish(c, code), 2000).unref());
  return true;
}

function write({ key, data }) {
  const c = chats.get(key);
  if (!c || c.exit) return false;
  c.child.stdin.write(Buffer.from(String(data), 'base64'));
  return true;
}

/** The chat is over: Claude Code finishes up when its input ends, and is stopped if it doesn't. */
function end({ key }) {
  const c = chats.get(key);
  if (!c) return false;
  c.child.stdin.end();
  setTimeout(() => c.child.exitCode == null && c.child.kill(), KILL_AFTER_MS).unref();
  return true;
}

function kill({ key }) {
  const c = chats.get(key);
  if (!c) return false;
  c.child.kill();
  return true;
}

function drop(c, seq) {
  let n = 0;
  while (n < c.held.length && c.held[n][0] <= seq) c.size -= c.held[n++][1].length;
  if (n) c.held.splice(0, n);
}

function ack({ key, seq }) {
  const c = chats.get(key);
  if (c) drop(c, Number(seq) || 0);
  return true;
}

/** Leafdeck is back: it gets every line after `from`, then the live ones (and the end, if Claude Code has stopped). */
function attach({ key, from }, client) {
  const c = chats.get(key);
  if (!c) return false;
  drop(c, Number(from) || 0);
  c.client = client;
  for (const [seq, text] of c.held) tell(c, 'chat:out', { seq, line: text });
  if (c.exit) {
    tell(c, 'chat:exit', { code: c.exit.code });
    chats.delete(key);
  } else c.child.stdout.resume();
  return true;
}

const list = () => [...chats.values()].map((c) => ({ key: c.key, cwd: c.cwd, stderr: c.stderr }));

/** A Leafdeck's connection closed: what it was attached to keeps running and keeps its output. */
function detach(client) {
  for (const c of chats.values()) if (c.client === client) c.client = null;
}

function closeAll() {
  for (const c of chats.values()) c.child.kill();
}

function init(d) {
  send = d.send;
}

/* ---------------- Leafdeck's side ---------------- */

/** `daemon`: electron/leafdeckd-client.cjs. A chat's process looks like a child process to agentchat.cjs. */
function client(daemon) {
  const children = new Map(); // chat id -> HostedChild
  const quiet = (method, params) => daemon.request(method, params).catch(() => {});
  let supported = false;

  class HostedChild extends EventEmitter {
    constructor(key) {
      super();
      this.key = key;
      this.seq = 0; // the last line handed to stdout's listeners
      this.exitCode = null;
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdin = {
        write: (text) => {
          const b = Buffer.from(text);
          for (let i = 0; i < b.length; i += STDIN_PIECE) quiet('chat.write', { key, data: b.subarray(i, i + STDIN_PIECE).toString('base64') });
        },
        end: () => quiet('chat.end', { key }),
      };
      children.set(key, this);
    }
    kill() {
      quiet('chat.kill', { key: this.key });
    }
    /** The lines so far have had their effect and it's saved: leafdeckd can let go of them. */
    ack() {
      quiet('chat.ack', { key: this.key, seq: this.seq });
    }
    ended(code) {
      if (children.get(this.key) === this) children.delete(this.key);
      this.exitCode = code ?? 1;
      this.emit('exit', code);
    }
  }

  daemon.onEvent((event, data) => {
    const child = data?.key && children.get(data.key);
    if (event === 'daemon:reconnected') return void sync();
    if (!child) return;
    if (event === 'chat:out') {
      child.seq = data.seq;
      child.stdout.emit('data', `${data.line}\n`);
    } else if (event === 'chat:err') child.stderr.emit('data', data.data);
    else if (event === 'chat:error') child.emit('error', new Error(data.message));
    else if (event === 'chat:exit') child.ended(data.code);
  });

  /** Asks leafdeckd what's running; null when it can't host chats (an older one, still running from before an update). */
  const list = () => daemon.request('chat.list').then((l) => ((supported = true), l), () => ((supported = false), null));

  // leafdeckd came back. If it restarted, what it held is gone; if only the connection dropped, carry on from where we were.
  async function sync() {
    const running = await list();
    const there = new Set((running || []).map((r) => r.key));
    for (const child of [...children.values()]) {
      if (there.has(child.key)) quiet('chat.attach', { key: child.key, from: child.seq });
      else child.ended(null);
    }
  }

  return {
    list,
    available: () => supported && daemon.connected(),
    spawn(key, exe, args, { cwd, env }) {
      const child = new HostedChild(key);
      daemon.request('chat.open', { key, exe, args, cwd, env }).catch((err) => {
        if (children.get(key) !== child) return;
        child.emit('error', err);
        child.ended(null);
      });
      return child;
    },
    /** The stand-in for a process that's already running; attach() once its listeners are on. */
    child: (key) => new HostedChild(key),
    attach: (key, from) => {
      const child = children.get(key);
      if (child) child.seq = from;
      return daemon.request('chat.attach', { key, from });
    },
  };
}

module.exports = { init, open, write, end, kill, ack, attach, list, detach, closeAll, client };
