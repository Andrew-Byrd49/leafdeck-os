// Claude Settings' main-process half (the app is public/js/apps/claudesettings.js): Claude Code's instructions, memory,
// skills, agents, settings, hooks and connections as they are on disk, plus what Claude Code itself says it loads.
// - state(): reads the files, for you and for one folder. MCP secrets never leave here.
// - probe(): starts `claude -p` in a folder without sending it a message and asks what a session there would load (the
//   same control requests /context, /memory and /skills use). No conversation, nothing to bill, nothing saved.
// - read/save/remove: only files in the shapes Claude Code reads (kindOf); skills from plugins or synced from claude.ai read only.
// - History: every save here, and everything that changes during a turn of the app's chat, is kept with its before and
//   after (in the profile, private to the user), so it can be looked at and undone. ~/.claude.json isn't tracked:
//   Claude Code rewrites it all the time, and only `claude mcp` should change it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// { exe(): Claude Code's path, dir(): this app's folder in the profile, projects(): the Claude Code app's folders }
let deps = null;
const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const USER_JSON = path.join(HOME, '.claude.json');
const MAX_FILE = 1024 * 1024; // files larger than this aren't instructions; they aren't read or tracked
const MAX_TRACKED = 3000;
const MAX_HISTORY = 200;
const PROBE_MS = 60_000;
const PROBE_TTL = 5 * 60_000;

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size <= MAX_FILE ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const within = (root, p) => p === root || p.startsWith(root + path.sep);
/** Claude Code's folder name for a project's transcripts and memory. */
const slugOf = (folder) => folder.replace(/[^a-zA-Z0-9]/g, '-');
const memoryDir = (folder) => path.join(CLAUDE, 'projects', slugOf(folder), 'memory');
/** Atomic, keeping the file's mode. Private by default: these can hold API keys. */
function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(p).mode & 0o777;
  } catch {}
  const tmp = `${p}.ld-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, p);
}
/** Markdown files under a folder, a few levels down. */
function walk(dir, { depth = 4, skip = null, out = [] } = {}) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    if (out.length >= MAX_TRACKED) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && e.name !== 'node_modules' && !skip?.(p)) walk(p, { depth: depth - 1, skip, out });
    } else if (e.name.endsWith('.md') && (e.isFile() || e.isSymbolicLink())) out.push(p);
  }
  return out;
}
/** name, description and type from a file's front matter, top level or under metadata. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  lines.forEach((line, i) => {
    const f = /^\s*(name|description|type|model):\s*(.*)$/.exec(line);
    if (!f || out[f[1]]) return;
    let v = f[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      v = '';
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) v += `${lines[j].trim()} `;
    }
    out[f[1]] = v.trim().replace(/^(['"])(.*)\1$/, '$2');
  });
  return out;
}
function info(p, extra = {}) {
  let size = 0;
  let mtime = 0;
  let exists = false;
  try {
    const st = fs.statSync(p);
    exists = st.isFile();
    size = st.size;
    mtime = st.mtimeMs;
  } catch {}
  return { path: p, exists, size, mtime, tokens: Math.ceil(size / 4), kind: kindOf(p), ...extra };
}

/* ---------------- which folders ---------------- */

/** The Claude Code app's folders, and folders you've trusted Claude Code in from a terminal. Starting Claude Code in a
 * folder (probe) runs that folder's hooks, so it stays with folders you already work in. */
let foldersCache = null; // kindOf asks once per file, and ~/.claude.json can be megabytes
function folders() {
  if (foldersCache && Date.now() - foldersCache.at < 3000) return foldersCache.list;
  const set = new Set();
  for (const p of deps?.projects?.() || []) if (isDir(p)) set.add(path.resolve(p));
  const cfg = readJson(USER_JSON);
  if (isObj(cfg?.projects)) for (const [p, v] of Object.entries(cfg.projects)) if (v?.hasTrustDialogAccepted && isDir(p)) set.add(path.resolve(p));
  set.delete(HOME);
  const list = [...set].sort((a, b) => path.basename(a).localeCompare(path.basename(b))).map((p) => ({ path: p, name: path.basename(p) }));
  foldersCache = { at: Date.now(), list };
  return list;
}
function folderOf(folder) {
  const f = String(folder || '');
  if (!f) return '';
  if (!folders().some((x) => x.path === f)) throw new Error('That folder isn’t one Claude Code knows about');
  return f;
}

/* ---------------- what may be touched ---------------- */

const CONFIG_DIR_PATTERNS = [
  [/^CLAUDE\.md$/, 'write'],
  [/^settings(\.local)?\.json$/, 'write'],
  [/^(rules|agents|commands|output-styles)\/.+\.md$/, 'write'],
  [/^skills\/(?!synced\/).+\.md$/, 'write'],
];
/** 'write', 'read' or null, from the path's shape alone. */
function shapeOf(abs) {
  const inConfig = (root) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    return CONFIG_DIR_PATTERNS.find(([re]) => re.test(rel))?.[1] || null;
  };
  if (within(CLAUDE, abs)) {
    const rel = path.relative(CLAUDE, abs).split(path.sep).join('/');
    if (/^projects\/[^/]+\/memory\/[^/]+\.md$/.test(rel)) return 'write';
    if (/^(skills\/synced|plugins)\/.+\/(SKILL\.md|[^/]+\.md)$/.test(rel)) return 'read';
    return inConfig(CLAUDE);
  }
  for (const { path: f } of folders()) {
    if (!within(f, abs)) continue;
    const rel = path.relative(f, abs).split(path.sep).join('/');
    // Not .mcp.json: it can hold a connection's keys, and those stay out of the page (`claude mcp` changes it).
    if (/^(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/.test(rel)) return 'write';
    if (rel.startsWith('.claude/')) return inConfig(path.join(f, '.claude'));
  }
  return null;
}
/** A link in the path can't take a write somewhere else. */
function kindOf(p) {
  const abs = path.resolve(String(p || ''));
  const shape = shapeOf(abs);
  if (shape !== 'write') return shape;
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  try {
    const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
    if (real !== abs && shapeOf(real) !== 'write') return 'read';
  } catch {
    return 'read';
  }
  return 'write';
}
function checked(p, need) {
  const abs = path.resolve(String(p || ''));
  const k = kindOf(abs);
  if (!k || (need === 'write' && k !== 'write')) throw new Error(need === 'write' ? 'Claude Settings can’t change that file' : 'Claude Settings can’t open that file');
  return abs;
}

/* ---------------- what's on disk ---------------- */

function settingsFile(p) {
  if (!fs.existsSync(p)) return { path: p, exists: false, data: {} };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return isObj(data) ? { path: p, exists: true, data } : { path: p, exists: true, data: {}, error: 'This file isn’t a JSON object' };
  } catch (err) {
    return { path: p, exists: true, data: {}, error: err.message };
  }
}
const scopePath = (scope, folder) => {
  if (scope === 'user') return path.join(CLAUDE, 'settings.json');
  if (!folder) throw new Error('Pick a folder first');
  return path.join(folder, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
};
/** Named files of one kind (agents, commands, rules), for you or a folder. */
function named(root, group) {
  return walk(root).map((p) => {
    const fm = frontmatter(readText(p));
    return info(p, { group, name: fm.name || path.basename(p, '.md'), description: fm.description || '', model: fm.model || '' });
  });
}
function skillsIn(root, group) {
  let list = [];
  try {
    list = fs.readdirSync(root, { withFileTypes: true });
  } catch {}
  return list
    .filter((e) => e.name !== 'synced' && (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => {
      const p = path.join(root, e.name, 'SKILL.md');
      const fm = frontmatter(readText(p));
      return info(p, { group, name: fm.name || e.name, description: fm.description || '' });
    });
}
function memoryOf(folder) {
  const dir = memoryDir(folder);
  const files = walk(dir, { depth: 0 }).map((p) => {
    const fm = frontmatter(readText(p));
    const name = path.basename(p);
    return info(p, { name: fm.name || name, description: name === 'MEMORY.md' ? 'The index: Claude reads this at the start of every session here' : fm.description || '', type: fm.type || '', index: name === 'MEMORY.md' });
  });
  files.sort((a, b) => b.index - a.index || b.mtime - a.mtime);
  return { dir, folder, files };
}

// MCP: what each connection is, without its secrets. Token-looking arguments go too (`--token abc`, `--key=abc`).
const SECRET_FLAG = /(token|key|secret|passw|auth|bearer|credential)/i;
function safeArgs(args) {
  const out = [];
  let hideNext = false;
  for (const a of Array.isArray(args) ? args.map(String) : []) {
    if (hideNext) {
      out.push('•••');
      hideNext = false;
    } else if (/^--?[\w-]+=/.test(a) && SECRET_FLAG.test(a.split('=')[0])) out.push(`${a.split('=')[0]}=•••`);
    else if (/^--?[\w-]+$/.test(a) && SECRET_FLAG.test(a)) {
      out.push(a);
      hideNext = true;
    } else if (/^[A-Za-z0-9_\-+/=.]{32,}$/.test(a)) out.push('•••');
    else out.push(a);
  }
  return out;
}
function safeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname}`;
  } catch {
    return '';
  }
}
function mcpEntry(name, c, scope) {
  if (!isObj(c)) return null;
  const transport = c.type || (c.url ? 'http' : 'stdio');
  return {
    name,
    scope,
    transport,
    what: c.url ? safeUrl(c.url) : [c.command, ...safeArgs(c.args)].filter(Boolean).join(' '),
    // Only that they're set, never their values.
    secrets: [...Object.keys(isObj(c.env) ? c.env : {}), ...Object.keys(isObj(c.headers) ? c.headers : {})].slice(0, 12),
  };
}
function mcpList(folder) {
  const cfg = readJson(USER_JSON);
  const out = [];
  const add = (servers, scope) => {
    if (isObj(servers)) for (const [n, c] of Object.entries(servers)) out.push(mcpEntry(n, c, scope));
  };
  add(cfg?.mcpServers, 'user');
  if (folder) {
    add(cfg?.projects?.[folder]?.mcpServers, 'local');
    add(readJson(path.join(folder, '.mcp.json'))?.mcpServers, 'project');
  }
  return out.filter(Boolean);
}
function hooksOf(file, scope) {
  const out = [];
  const hooks = file.data?.hooks;
  if (!isObj(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) =>
      (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => out.push({ scope, event, group: gi, index: hi, matcher: String(g.matcher || ''), type: String(h?.type || ''), what: String(h?.command || h?.prompt || h?.url || '').slice(0, 1000) })),
    );
  }
  return out;
}

/** Everything the app shows for you, and for one folder if it's given. */
function state(folderArg) {
  const folder = folderOf(folderArg);
  const you = path.join(CLAUDE, 'CLAUDE.md');
  const inst = [info(you, { group: 'you', label: 'Your instructions', hint: 'Read at the start of every session, in every folder' }), ...walk(path.join(CLAUDE, 'rules')).map((p) => info(p, { group: 'you', label: `Rule: ${path.basename(p, '.md')}`, hint: 'A focused file of instructions' }))];
  const settings = { user: settingsFile(scopePath('user')) };
  const agents = named(path.join(CLAUDE, 'agents'), 'you');
  const commands = named(path.join(CLAUDE, 'commands'), 'you');
  const skills = skillsIn(path.join(CLAUDE, 'skills'), 'you');
  if (folder) {
    const dot = path.join(folder, '.claude');
    inst.push(
      info(path.join(folder, 'CLAUDE.md'), { group: 'folder', label: 'Project instructions', hint: 'Shared with anyone who has this project (usually checked in)' }),
      info(path.join(folder, 'CLAUDE.local.md'), { group: 'folder', label: 'Your notes for this project', hint: 'Just for you; keep it out of git' }),
    );
    for (const [file, label, hint] of [
      [path.join(dot, 'CLAUDE.md'), 'Project instructions (alternate place)', 'Same as CLAUDE.md, in the .claude folder'],
      [path.join(folder, 'AGENTS.md'), 'AGENTS.md', 'Instructions shared with other coding agents'],
    ])
      if (fs.existsSync(file)) inst.push(info(file, { group: 'folder', label, hint }));
    inst.push(...walk(path.join(dot, 'rules')).map((p) => info(p, { group: 'folder', label: `Rule: ${path.basename(p, '.md')}`, hint: 'A focused file of instructions' })));
    settings.project = settingsFile(scopePath('project', folder));
    settings.local = settingsFile(scopePath('local', folder));
    agents.push(...named(path.join(dot, 'agents'), 'folder'));
    commands.push(...named(path.join(dot, 'commands'), 'folder'));
    skills.push(...skillsIn(path.join(dot, 'skills'), 'folder'));
  }
  return {
    home: HOME,
    folder,
    folders: folders(),
    instructions: inst,
    memory: memoryOf(folder || HOME),
    settings,
    agents,
    commands,
    skills,
    hooks: Object.entries(settings).flatMap(([scope, f]) => hooksOf(f, scope)),
    connections: mcpList(folder),
    turn: fs.existsSync(turnFile()),
  };
}

/* ---------------- what Claude Code says it loads ---------------- */

const probes = new Map(); // cwd -> { at, result, running }
function ask(cwd) {
  return new Promise((resolve, reject) => {
    const exe = deps.exe();
    if (!exe) return reject(new Error('Claude Code isn’t installed'));
    // No connections: starting them only to ask this would be slow, and they'd run for nothing.
    const child = spawn(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--permission-prompt-tool', 'stdio'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env } });
    const want = new Set(['initialize', 'get_context_usage', 'get_skills_dialog', 'get_memory_dialog', 'get_settings']);
    const got = {};
    let buf = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      err ? reject(err) : resolve(got);
    };
    const timer = setTimeout(() => finish(Object.keys(got).length ? null : new Error('Claude Code didn’t answer')), PROBE_MS);
    child.on('error', finish);
    child.on('exit', () => finish(Object.keys(got).length ? null : new Error('Claude Code stopped before it answered')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type !== 'control_response') continue;
        const r = m.response || {};
        if (r.subtype !== 'error') got[r.request_id] = r.response || {};
        want.delete(r.request_id);
        if (!want.size) finish();
      }
    });
    for (const subtype of want) child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: subtype, request: { subtype } })}\n`);
  });
}
function shapeProbe(cwd, got) {
  const ctx = got.get_context_usage || {};
  const init = got.initialize || {};
  const paths = new Map((ctx.skills?.skillFrontmatter || []).map((s) => [s.name, s.path]));
  return {
    at: Date.now(),
    cwd,
    version: init.claude_code_version || '',
    categories: (ctx.categories || []).filter((c) => c.id !== 'messages' && c.kind !== 'free' && c.kind !== 'buffer' && c.tokens > 0).map((c) => ({ id: c.id, name: c.name, tokens: c.tokens, deferred: c.kind === 'deferred' })),
    total: ctx.totalTokens || 0,
    max: ctx.maxTokens || 0,
    model: ctx.model || got.get_settings?.applied?.model || '',
    effort: got.get_settings?.applied?.effort || '',
    memoryFiles: (ctx.memoryFiles || []).map((f) => ({ path: f.path, type: f.type, tokens: f.tokens, kind: kindOf(f.path) })),
    skills: (got.get_skills_dialog?.skills || []).map((s) => {
      const p = paths.get(s.name);
      return { name: s.name, display: s.display_name || s.name, description: s.description || '', source: s.source || '', tokens: s.tokens || 0, state: s.state || 'on', locked: s.locked_by || '', path: p || '', kind: p ? kindOf(p) : null };
    }),
    agents: (init.agents || []).map((a) => ({ name: a.name, description: a.description || '', model: a.model || '' })),
    models: (init.models || []).map((m) => ({ value: m.value, name: m.displayName || m.value, description: m.description || '' })),
    styles: init.available_output_styles || [],
    style: init.output_style || 'default',
    autoMemory: got.get_memory_dialog?.auto_memory || null,
  };
}
/** What a new session in the folder (or your home folder) would load. Asked at most every few minutes. */
function probe(folderArg, force) {
  const cwd = folderOf(folderArg) || HOME;
  const c = probes.get(cwd);
  if (c?.running) return c.running;
  if (!force && c?.result && Date.now() - c.at < PROBE_TTL) return c.result;
  const running = ask(cwd)
    .then((got) => {
      const result = shapeProbe(cwd, got);
      probes.set(cwd, { at: Date.now(), result });
      return result;
    })
    .catch((err) => {
      probes.delete(cwd);
      throw err;
    });
  probes.set(cwd, { ...c, running });
  return running;
}

/* ---------------- history ---------------- */

const baseDir = () => {
  const d = path.join(deps.dir(), 'history');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const turnFile = () => path.join(deps.dir(), 'turn.json');
function addHistory(by, label, files) {
  if (!files.length) return null;
  const at = Date.now();
  const entry = { id: `${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at, by, label: String(label || '').slice(0, 300), files };
  fs.writeFileSync(path.join(baseDir(), `${entry.id}.json`), JSON.stringify(entry), { mode: 0o600 });
  const all = historyFiles();
  for (const old of all.slice(MAX_HISTORY)) fs.rmSync(path.join(baseDir(), old.name), { force: true });
  probes.clear();
  return entry;
}
function historyFiles() {
  return fs
    .readdirSync(baseDir())
    .filter((n) => n.endsWith('.json'))
    .map((name) => ({ name, at: fs.statSync(path.join(baseDir(), name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}
function history(limit = 60) {
  return historyFiles()
    .slice(0, limit)
    .map((f) => readJson(path.join(baseDir(), f.name)))
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}
/** Every file Claude reads that a change could land in: yours, each folder's, and all the memory folders. */
function trackedPaths() {
  const set = new Set([path.join(CLAUDE, 'CLAUDE.md'), path.join(CLAUDE, 'settings.json')]);
  const addConfig = (root) => {
    for (const d of ['rules', 'agents', 'commands', 'output-styles']) for (const p of walk(path.join(root, d))) set.add(p);
    for (const p of walk(path.join(root, 'skills'), { skip: (x) => path.basename(x) === 'synced' })) set.add(p);
  };
  addConfig(CLAUDE);
  try {
    for (const slug of fs.readdirSync(path.join(CLAUDE, 'projects'))) for (const p of walk(path.join(CLAUDE, 'projects', slug, 'memory'), { depth: 0 })) set.add(p);
  } catch {}
  for (const { path: f } of folders()) {
    const dot = path.join(f, '.claude');
    for (const p of [path.join(f, 'CLAUDE.md'), path.join(f, 'CLAUDE.local.md'), path.join(f, 'AGENTS.md'), path.join(dot, 'CLAUDE.md'), path.join(dot, 'settings.json'), path.join(dot, 'settings.local.json')]) set.add(p);
    addConfig(dot);
  }
  return [...set].slice(0, MAX_TRACKED);
}
function snapshot() {
  const files = {};
  for (const p of trackedPaths()) {
    const t = readText(p);
    if (t != null) files[p] = t;
  }
  return files;
}
/** A turn of the chat is starting: remember how everything is now. Kept on disk: the turn outlives a restart of Leafdeck. */
function turnStart(label) {
  turnEnd();
  fs.mkdirSync(deps.dir(), { recursive: true });
  fs.writeFileSync(turnFile(), JSON.stringify({ label: String(label || ''), files: snapshot() }), { mode: 0o600 });
}
/** The turn is over: what changed goes in the history. The history entry, or null if nothing did. */
function turnEnd() {
  const base = readJson(turnFile());
  if (!base) return null;
  fs.rmSync(turnFile(), { force: true });
  const now = snapshot();
  const files = [];
  for (const p of new Set([...Object.keys(base.files || {}), ...Object.keys(now)])) {
    const before = base.files?.[p] ?? null;
    const after = now[p] ?? null;
    if (before !== after) files.push({ path: p, before, after });
  }
  probes.clear();
  return addHistory('claude', base.label, files);
}
function undo(id, onlyPath, force) {
  const file = path.join(baseDir(), `${String(id).replace(/[^a-z0-9]/g, '')}.json`);
  const entry = readJson(file);
  if (!entry) throw new Error('That change isn’t in the history anymore');
  const files = (entry.files || []).filter((f) => !onlyPath || f.path === onlyPath);
  // Changed again since? Undoing would lose that, so say so first.
  const conflicts = files.filter((f) => (readText(f.path) ?? null) !== f.after).map((f) => f.path);
  if (conflicts.length && !force) return { conflicts };
  const done = [];
  for (const f of files) {
    const abs = checked(f.path, 'write');
    const current = readText(abs) ?? null;
    if (f.before == null) fs.rmSync(abs, { force: true });
    else writeFile(abs, f.before);
    done.push({ path: abs, before: current, after: f.before });
  }
  entry.undone = [...new Set([...(entry.undone || []), ...files.map((f) => f.path)])];
  fs.writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  addHistory('you', `Undid: ${entry.label || 'a change'}`, done.filter((d) => d.before !== d.after));
  return { ok: true };
}

/* ---------------- changing things ---------------- */

const home = (p) => (within(HOME, p) ? `~${p.slice(HOME.length)}` : p);
function read(p) {
  const abs = checked(p, 'read');
  const text = readText(abs);
  return { path: abs, kind: kindOf(abs), exists: text != null, text: text ?? '' };
}
function save(p, text) {
  const abs = checked(p, 'write');
  const t = String(text ?? '');
  if (Buffer.byteLength(t) > MAX_FILE) throw new Error('That’s too long to save here');
  if (abs.endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(t);
    } catch (err) {
      throw new Error(`That isn’t valid JSON: ${err.message}`);
    }
    if (!isObj(data)) throw new Error('A settings file has to be a JSON object');
  }
  const before = readText(abs);
  if (before === t) return read(abs);
  writeFile(abs, t);
  addHistory('you', `Edited ${home(abs)}`, [{ path: abs, before, after: t }]);
  return read(abs);
}
function remove(p) {
  const abs = checked(p, 'write');
  const before = readText(abs);
  if (before == null) return { ok: true };
  fs.rmSync(abs, { force: true });
  const files = [{ path: abs, before, after: null }];
  // A memory's pointer in the index goes with it, or Claude would keep looking for a file that's gone.
  const index = path.join(path.dirname(abs), 'MEMORY.md');
  if (/\/memory\/[^/]+\.md$/.test(abs) && abs !== index && within(CLAUDE, abs)) {
    const was = readText(index);
    const now = was?.split('\n').filter((line) => !line.includes(`(${path.basename(abs)})`)).join('\n');
    if (was != null && now !== was) {
      writeFile(index, now);
      files.push({ path: index, before: was, after: now });
    }
  }
  addHistory('you', `Deleted ${home(abs)}`, files);
  // A skill is its folder: don't leave an empty one behind.
  if (path.basename(abs) === 'SKILL.md') {
    try {
      fs.rmdirSync(path.dirname(abs));
    } catch {}
  }
  return { ok: true };
}
/** Merge into one settings file; a null value removes the key. Keeps everything else in the file. */
function setSettings(scope, folderArg, patch) {
  if (!['user', 'project', 'local'].includes(scope)) throw new Error('Bad settings scope');
  const file = scopePath(scope, folderOf(folderArg));
  const cur = settingsFile(file);
  if (cur.error) throw new Error(`${home(file)} has a mistake in it, so it wasn’t changed: ${cur.error}`);
  const next = { ...cur.data };
  for (const [k, v] of Object.entries(isObj(patch) ? patch : {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v == null) delete next[k];
    else next[k] = v;
  }
  save(file, `${JSON.stringify(next, null, 2)}\n`);
  return settingsFile(file);
}
function removeHook(scope, folderArg, event, group, index) {
  const file = settingsFile(scopePath(scope, folderOf(folderArg)));
  const hooks = structuredClone(file.data.hooks || {});
  const g = hooks[event]?.[group];
  if (!g?.hooks?.[index]) throw new Error('That hook has already changed. Look again.');
  g.hooks.splice(index, 1);
  if (!g.hooks.length) hooks[event].splice(group, 1);
  if (!hooks[event].length) delete hooks[event];
  return setSettings(scope, folderArg, { hooks: Object.keys(hooks).length ? hooks : null });
}
const NEW_FILES = {
  skill: { dir: (n) => `skills/${n}/SKILL.md`, text: (n) => `---\nname: ${n}\ndescription: What this skill does and when Claude should use it.\n---\n\n# ${n}\n\nThe steps Claude should follow.\n` },
  agent: { dir: (n) => `agents/${n}.md`, text: (n) => `---\nname: ${n}\ndescription: What this agent is for and when Claude should hand work to it.\n---\n\nYou are a specialist in…\n` },
  rule: { dir: (n) => `rules/${n}.md`, text: () => 'A short, focused set of instructions.\n' },
};
/** A new skill, agent or rule from a name: the file's path. An existing one is left alone. */
function create(kind, folderArg, nameArg) {
  const t = NEW_FILES[kind];
  if (!t) throw new Error('Bad kind');
  const name = String(nameArg || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!name) throw new Error('Give it a name with letters or numbers');
  const folder = folderOf(folderArg);
  const file = path.join(folder ? path.join(folder, '.claude') : CLAUDE, ...t.dir(name).split('/'));
  if (fs.existsSync(file)) return file;
  save(file, t.text(name));
  return file;
}

/* ---------------- the chat ---------------- */

/** How the chat starts: read and edit what's safe to undo without asking; anything else (settings, commands) asks. */
/**
 * Whether this chat's edit goes ahead without asking. Allow rules can't say so for a folder's .claude (Claude Code asks
 * about that folder whatever they say), so it's asked here. Settings files always ask, and so does a skill or agent
 * that gives itself permissions, which is the same thing by another route.
 */
const GRANTS = /^\s*(allowed-tools|permissionMode|hooks|mcpServers)\s*:/m;
function chatMayEdit(tool, input) {
  if (tool !== 'Edit' && tool !== 'Write') return false;
  const p = input?.file_path;
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  if (/^settings(\.local)?\.json$/.test(path.basename(p))) return false;
  if (GRANTS.test(String(input.content ?? input.new_string ?? ''))) return false;
  try {
    return kindOf(p) === 'write';
  } catch {
    return false;
  }
}

function chatLaunch() {
  const dirs = ['rules', 'agents', 'commands', 'skills', 'output-styles'];
  const abs = (p) => `/${p}`; // permission rules write an absolute path with a leading //
  const edits = [`~/.claude/CLAUDE.md`, ...dirs.map((d) => `~/.claude/${d}/**`), `~/.claude/projects/*/memory/**`];
  const list = folders();
  for (const { path: f } of list) {
    if (/[,\s()]/.test(f)) continue; // can't be said in a permission rule
    edits.push(abs(`${f}/CLAUDE.md`), abs(`${f}/CLAUDE.local.md`), abs(`${f}/.claude/CLAUDE.md`), ...dirs.map((d) => abs(`${f}/.claude/${d}/**`)));
  }
  const allowed = ['Read', 'Glob', 'Grep', ...edits.map((p) => `Edit(${p})`), ...edits.map((p) => `Write(${p})`)];
  const outside = list.filter((f) => !within(HOME, f.path)).flatMap((f) => ['--add-dir', f.path]);
  // It runs in the home folder, where reading needs no permission: where keys are kept stays off limits.
  const secrets = ['~/.claude/.credentials.json', '~/.claude.json', '~/.ssh/**', '~/.gnupg/**', '~/.aws/**'].map((p) => `Read(${p})`);
  return { cwd: HOME, args: ['--append-system-prompt', chatPrompt(list), '--allowedTools', allowed.join(','), '--disallowedTools', secrets.join(','), ...outside], mode: 'default' };
}
function chatPrompt(list) {
  return `You are Claude, working in Leafdeck's Claude Settings app. It's where the user sets how Claude behaves: your instructions, memory, skills, agents, permissions, hooks and connections. They tell you here what they'd like different, and you make the change in the right file. They see the app beside this chat, and may not be technical.

Where things live:
- Instructions for every session: ~/.claude/CLAUDE.md, and focused files in ~/.claude/rules/.
- Instructions for one project: <folder>/CLAUDE.md (shared with the project, usually in git), <folder>/CLAUDE.local.md (just this user), <folder>/.claude/rules/.
- Memory you keep per folder: ~/.claude/projects/<the folder with every non-alphanumeric character replaced by ->/memory/, one fact per file with a one-line pointer in MEMORY.md.
- Skills: ~/.claude/skills/<name>/SKILL.md or <folder>/.claude/skills/. Agents: ~/.claude/agents/ or <folder>/.claude/agents/.
- Settings (model, permissions, hooks, skillOverrides and the rest): ~/.claude/settings.json, <folder>/.claude/settings.json (shared), <folder>/.claude/settings.local.json (just this user).
- Connections (MCP servers): run \`claude mcp add\` / \`claude mcp remove\` (\`--scope user\` for every folder). Don't edit ~/.claude.json by hand; don't read or print ~/.claude/.credentials.json, and never repeat the value of a token, key or password you come across.
- Leafdeck's own Settings → Claude (the "About you" note, how its chats ask permission) is in Leafdeck's config, which you can't change: tell the user where to find it.

The folders the user works in: ${list.map((f) => f.path).join(', ') || '(none yet)'}. Each message ends with a note of what they have open in the app; "this" means that.

How to work:
- Read a file before changing it. Change as little as you can, in the user's voice and the file's format. Keep everything else in a settings file as it is.
- Pick the narrowest place that does what they asked: one project's file for something about that project, the global file only for what's true everywhere. If you can't tell, ask one short question.
- Instructions cost attention in every session, so keep them short and specific, and remove what a change makes redundant rather than piling on.
- Something that must happen automatically every time ("whenever you edit a file, …", "before every commit, …") is a hook in settings, not an instruction. Something Claude must not do is a deny rule in permissions, plus an instruction if the reason matters.
- Asked to review or tidy something, say what you found and propose changes first, unless they asked you to go ahead.
- Don't save memories of your own from this chat; only change memory when they ask.

Instructions, memory, skills and agents change without asking. Settings files, commands, and a skill or agent that gives itself permissions (allowed-tools, permissionMode, hooks, mcpServers) need the user's approval, because they decide what Claude may do unattended. The app asks them for you, on a card, when you make the change: so once they've asked for a change, make it, and don't ask in words first. If they decline on the card, ask what they'd like instead. Whatever you change, the app shows the user the diff with an Undo, so don't paste the file back. Finish with one or two plain sentences: what's different now, and where. New sessions pick up instructions; a session already running keeps the ones it started with. The chat renders simple Markdown (no tables).`;
}

function init(d) {
  deps = d;
}

module.exports = { init, state, probe, read, save, remove, setSettings, removeHook, create, history, undo, turnStart, turnEnd, chatLaunch, chatMayEdit };
