// Why is Claude asking for the administrator password? (Leafdeck OS; the popup is public/js/osdialogs.js.)
//
// polkit says which process is asking. If one of that process's ancestors is a Claude Code session, the command it's
// running is in the session's transcript, with the description Claude gave it: that's the reason the popup shows. (The
// system prompt, ADMIN_PROMPT in main.cjs, tells Claude to write it for this.) Claude's words only explain; what will
// actually run comes from polkit, and the popup always shows that too.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionsDir } = require('./agentchat.cjs');

const TAIL = 2 * 1024 * 1024;
// A running command reaches the transcript a moment after it starts (seen: under a second).
const WAIT_MS = 1500;
const POLL_MS = 150;

function parentOf(pid) {
  try {
    return Number(/^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]) || 0;
  } catch {
    return 0;
  }
}

/** When a process started (field 22 of its stat): a session file left by a dead process may name a reused pid. */
function startOf(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/** The Claude Code session this process runs under: { sessionId, cwd }, or null. */
function sessionOf(pid) {
  for (let p = Number(pid), n = 0; p > 1 && n < 64; p = parentOf(p), n++) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${p}.json`), 'utf8'));
      if (s.pid === p && s.sessionId && s.cwd && String(s.procStart) === startOf(p)) return s;
    } catch {
      /* not a session */
    }
  }
  return null;
}

function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(fs.fstatSync(fd).size, TAIL);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, fs.fstatSync(fd).size - len);
    return b.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The transcript's commands: the one running that's asking, or one that went to the background with pkexec in it. */
function findCommand(file) {
  let text;
  try {
    text = tail(file);
  } catch {
    return {};
  }
  const calls = new Map();
  const finished = new Set();
  let said = '';
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"') && !line.includes('"tool_result"')) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // the cut-off first line
    }
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (m.type === 'user' && b.type === 'tool_result') finished.add(b.tool_use_id);
      if (m.type !== 'assistant') continue;
      if (b.type === 'text') said = b.text;
      else if (b.type === 'tool_use' && b.name === 'Bash') calls.set(b.id, { ...b.input, said });
    }
  }
  const isAdmin = (c) => /\bpkexec\b/.test(String(c.command || ''));
  const running = [...calls].filter(([id]) => !finished.has(id)).map(([, c]) => c).reverse();
  return { running: running.find(isAdmin) || running[0], background: [...calls.values()].reverse().find((c) => c.run_in_background && isAdmin(c)) };
}

const words = (c) => String(c?.description || c?.said || '').replace(/\s+/g, ' ').trim().slice(0, 500);

/** pids: polkit's subject and caller. Resolves null when Claude isn't asking, else { reason } ('' if it gave none). */
async function explain(pids) {
  const session = (pids || []).map(sessionOf).find(Boolean);
  if (!session) return null;
  const file = path.join(sessionsDir(session.cwd), `${session.sessionId}.jsonl`);
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const { running, background } = findCommand(file);
    if (running) return { reason: words(running) };
    if (Date.now() >= until) return { reason: words(background) };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { explain };
