// Git for the Claude Code app (public/js/apps/claudecode.js): what a session's folder has changed (the Changes panel),
// the diff of one file, the files to offer after "@" in the composer, and worktrees, so sessions in the same repo can
// work side by side without touching each other's files. Worktrees go where Claude Code's own --worktree puts them:
// <repo>/.claude/worktrees/<name>, on a branch claude/<name>, kept out of the repo's status by .git/info/exclude.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function git(cwd, args, { max = 8 * 1024 * 1024, ok = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 20000, maxBuffer: max, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (ok.includes(code)) resolve(stdout);
      else reject(new Error(String(stderr || err?.message || 'git failed').trim().split('\n').pop()));
    });
  });
}

/** The repo a folder is in: { top, branch } or null when it isn't one. */
async function repoOf(cwd) {
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    return { top, branch: branch === 'HEAD' ? '' : branch };
  } catch {
    return null;
  }
}

const countLines = (file) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return 0;
    const b = fs.readFileSync(file);
    if (b.subarray(0, 8000).includes(0)) return 0; // binary
    let n = 0;
    for (const c of b) if (c === 10) n++;
    return n + (b.length && b[b.length - 1] !== 10 ? 1 : 0);
  } catch {
    return 0;
  }
};

/** What's changed in the folder against HEAD: { repo, branch, ahead, files: [{ path, status, add, del, binary }] }. */
async function status(cwd) {
  const r = await repoOf(cwd);
  if (!r) return { repo: false, files: [] };
  const [porc, num, ahead] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(cwd, ['diff', 'HEAD', '--numstat', '-z', '--no-renames']).catch(() => ''),
    git(cwd, ['rev-list', '--count', '@{upstream}..HEAD']).catch(() => ''),
  ]);
  const counts = new Map();
  for (const rec of num.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (m) counts.set(m[3], { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  const files = [];
  const parts = porc.split('\0');
  for (let i = 0; i < parts.length && files.length < 800; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const file = rec.slice(3);
    if (x === 'R' || x === 'C') i++; // the old name follows
    const untracked = x === '?';
    const st = untracked ? 'A' : x === 'D' || y === 'D' ? 'D' : x === 'A' ? 'A' : x === 'R' ? 'R' : 'M';
    const c = counts.get(file) || (untracked ? { add: countLines(path.join(r.top, file)), del: 0, binary: false } : { add: 0, del: 0, binary: false });
    files.push({ path: file, status: st, untracked, ...c });
  }
  // Paths from git are relative to the repo's top; the folder may be inside it.
  return { repo: true, top: r.top, branch: r.branch, ahead: Number(ahead) || 0, files };
}

/** The unified diff of one file against HEAD (an untracked file: all of it, added). */
async function diff(cwd, file) {
  const r = await repoOf(cwd);
  if (!r) throw new Error('Not a git repository');
  const rel = path.relative(r.top, path.resolve(r.top, String(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('That file isn’t in this repository');
  const tracked = await git(r.top, ['ls-files', '--error-unmatch', '--', rel]).then(() => true, () => false);
  const out = tracked
    ? await git(r.top, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3', '--', rel], { max: 4 * 1024 * 1024 }).catch(() => git(r.top, ['diff', '--cached', '--no-color', '-U3', '--', rel]))
    : await git(r.top, ['diff', '--no-index', '--no-color', '-U3', '--', '/dev/null', rel], { ok: [0, 1], max: 4 * 1024 * 1024 });
  return out.length > 600000 ? `${out.slice(0, 600000)}\n… (diff clipped)` : out;
}

/** Files to offer after "@": tracked and untracked-but-not-ignored, relative to the folder. Cached for a few seconds. */
const fileCache = new Map(); // cwd -> { at, list }
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target']);
async function files(cwd) {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < 15000) return hit.list;
  let list;
  try {
    list = (await git(cwd, ['ls-files', '-co', '--exclude-standard', '-z'], { max: 32 * 1024 * 1024 })).split('\0').filter(Boolean);
  } catch {
    // Not a repo: a quick walk that skips the usual heavy folders.
    list = [];
    const walk = (dir, rel, depth) => {
      if (list.length >= 8000 || depth > 7) return;
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) walk(path.join(dir, e.name), r, depth + 1);
        } else if (e.isFile()) list.push(r);
      }
    };
    walk(cwd, '', 0);
  }
  list = list.slice(0, 20000);
  fileCache.set(cwd, { at: Date.now(), list });
  return list;
}

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40) || 'session';

/** A new worktree for a session, from the repo's current HEAD: { path, branch }. */
async function addWorktree(cwd, hint) {
  const r = await repoOf(cwd);
  if (!r) throw new Error('This folder isn’t a git repository');
  const hasHead = await git(r.top, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  if (!hasHead) throw new Error('The repository has no commits yet: make a first commit, then start a session in a worktree');
  const name = `${slug(hint)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(r.top, '.claude', 'worktrees', name);
  const branch = `claude/${name}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // Keep the worktrees folder out of the main checkout's status (local to this clone, never committed).
  try {
    const common = path.resolve(r.top, (await git(r.top, ['rev-parse', '--git-common-dir'])).trim());
    const ex = path.join(common, 'info', 'exclude');
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!/^\/?\.claude\/worktrees\/?$/m.test(cur)) {
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.claude/worktrees/\n`);
    }
  } catch {}
  await git(r.top, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  // A session in a subfolder of the repo works in the same subfolder of its worktree.
  const sub = path.relative(r.top, cwd);
  const at = sub && !sub.startsWith('..') ? path.join(dir, sub) : dir;
  return { path: fs.existsSync(at) ? at : dir, root: dir, branch };
}

/** Remove a session's worktree if nothing in it would be lost (its branch stays). Returns false when it was kept. */
async function removeWorktree(root) {
  if (!root || !fs.existsSync(root)) return true;
  try {
    const dirty = (await git(root, ['status', '--porcelain'])).trim();
    if (dirty) return false;
    await git(root, ['worktree', 'remove', root]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { repoOf, status, diff, files, addWorktree, removeWorktree };
