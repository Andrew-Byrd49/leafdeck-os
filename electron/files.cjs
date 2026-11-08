// Files (public/js/apps/files.js): the file manager on Linux and Leafdeck OS. Folders, your places and drives, copy and
// move, rename, Trash (the freedesktop.org Trash, shared with every other Linux app), live updates while a folder is open,
// search, and extracting archives (extract below). File contents for previews and thumbnails are served to Leafdeck's
// own page at leafdeck://app/~file (serveFile below), which websites can't reach: they run in other sessions.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const drives = require('./drives.cjs');

const HOME = os.homedir();
const TRASH = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'Trash');

/* ---------------- kinds ---------------- */

const KINDS = {
  image: 'png jpg jpeg gif webp avif bmp svg ico heic tif tiff',
  video: 'mp4 m4v webm mkv mov avi ogv',
  audio: 'mp3 m4a aac ogg oga opus flac wav weba',
  pdf: 'pdf',
  text: 'txt md markdown log csv tsv ini conf cfg toml yaml yml json xml rtf env',
  code: 'js mjs cjs ts tsx jsx css scss html htm py rb go rs c h cpp hpp java kt swift sh bash zsh fish sql php lua pl r cs vue svelte',
  archive: 'zip tar gz tgz bz2 xz zst 7z rar',
  doc: 'doc docx odt pages',
  sheet: 'xls xlsx ods numbers',
  slides: 'ppt pptx odp key',
  app: 'appimage flatpakref desktop exe msi deb rpm',
};
const BY_EXT = new Map(Object.entries(KINDS).flatMap(([kind, list]) => list.split(' ').map((e) => [e, kind])));
const kindOf = (name, dir) => (dir ? 'folder' : BY_EXT.get(path.extname(name).slice(1).toLowerCase()) || 'file');

/* ---------------- reading ---------------- */

/** Whether a folder has nothing you'd see in it (hidden files don't count). One that can't be read isn't called empty. */
async function looksEmpty(full) {
  try {
    for await (const it of await fsp.opendir(full)) if (!it.name.startsWith('.')) return false;
    return true;
  } catch {
    return false;
  }
}

async function entry(dir, name) {
  const full = path.join(dir, name);
  let st;
  let link = false;
  try {
    const l = await fsp.lstat(full);
    link = l.isSymbolicLink();
    st = link ? await fsp.stat(full).catch(() => l) : l;
  } catch {
    return null;
  }
  const isDir = st.isDirectory();
  return { name, path: full, dir: isDir, empty: isDir && (await looksEmpty(full)), size: isDir ? null : st.size, mtime: st.mtimeMs, added: st.birthtimeMs || st.mtimeMs, kind: kindOf(name, isDir), hidden: name.startsWith('.'), link };
}

/** A folder's contents. Folders you can't open answer with the reason. */
async function list(dir) {
  const full = path.resolve(String(dir || HOME));
  const names = await fsp.readdir(full).catch((err) => {
    throw new Error(err.code === 'EACCES' ? 'You don’t have permission to open this folder.' : err.code === 'ENOENT' ? 'This folder doesn’t exist anymore.' : err.message);
  });
  const entries = (await Promise.all(names.map((n) => entry(full, n)))).filter(Boolean);
  let writable = true;
  try {
    fs.accessSync(full, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  return { path: full, parent: full === '/' ? null : path.dirname(full), entries, writable };
}

/** Your folders (from xdg-user-dirs, the standard list every Linux desktop uses), drives, and the Trash. */
function userDirs() {
  const found = {};
  try {
    const text = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'user-dirs.dirs'), 'utf8');
    for (const m of text.matchAll(/^XDG_(\w+)_DIR="([^"]*)"/gm)) found[m[1]] = m[2].replace('$HOME', HOME);
  } catch {}
  return found;
}

/**
 * The Desktop folder (xdg-user-dirs' DESKTOP, or ~/Desktop): what's in it shows on Leafdeck's desktop beside the apps.
 * It's made the first time something goes on the desktop, not before. { path, exists }
 */
function desktopDir(create = false) {
  let p = userDirs().DESKTOP;
  if (!p || path.resolve(p) === HOME) p = path.join(HOME, 'Desktop'); // a desktop that is the home folder would show all of it
  if (create && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return { path: path.resolve(p), exists: fs.existsSync(p) };
}

function places() {
  const dirs = { DESKTOP: 'Desktop', DOCUMENTS: 'Documents', DOWNLOAD: 'Downloads', PICTURES: 'Pictures', MUSIC: 'Music', VIDEOS: 'Videos' };
  const found = userDirs();
  const folders = [{ id: 'home', name: 'Home', path: HOME }];
  for (const [key, name] of Object.entries(dirs)) {
    const p = found[key] || path.join(HOME, name);
    if (p !== HOME && fs.existsSync(p)) folders.push({ id: key.toLowerCase(), name, path: p });
  }
  // Drives: USB sticks and disks mounted for you (udisks puts them in /run/media/<you>), and other partitions.
  const mounted = [];
  try {
    const user = os.userInfo().username;
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [dev, mnt] = line.split(' ');
      const where = (mnt || '').replace(/\\040/g, ' ');
      if (dev?.startsWith('/dev/') && (where.startsWith(`/run/media/${user}/`) || where.startsWith(`/media/${user}/`) || where.startsWith('/mnt/'))) {
        mounted.push({ id: `drive:${where}`, name: path.basename(where), path: where, removable: !where.startsWith('/mnt/'), device: drives.mountedAt(where)?.device || '' });
      }
    }
  } catch {}
  return { folders, drives: mounted, unmounted: drives.unmounted(), computer: { id: 'computer', name: 'This computer', path: '/' }, trash: path.join(TRASH, 'files'), home: HOME };
}

/** A text file's beginning, for previews. */
async function readText(file, max = 512 * 1024) {
  const fh = await fsp.open(String(file), 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    return { text, truncated: bytesRead === max, binary: text.includes('\u0000') };
  } finally {
    await fh.close();
  }
}

/* ---------------- archives ---------------- */

const ARCHIVE_ROWS = 5000; // entries a preview gets at most (it says how many more there are)
const dosDate = (d, t) => new Date(((d >> 9) & 0x7f) + 1980, ((d >> 5) & 0xf) - 1, d & 0x1f, t >> 11, (t >> 5) & 0x3f, (t & 0x1f) * 2).getTime();

/** A zip's entries from its central directory (no tool needed; Zip64 too). Names are UTF-8 where the entry says so, else CP437, read as Latin-1. */
async function zipEntries(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557 + 20); // the end record, its comment, and a Zip64 locator before it
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const where = Number(tail.readBigUInt64LE(eocd - 20 + 8));
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, where);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('Not a zip file');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > 64 * 1024 * 1024) throw new Error('Too many entries to list');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let total = 0;
    let unpacked = 0;
    for (let at = 0, n = 0; n < count && at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50; n++) {
      const flags = cd.readUInt16LE(at + 8);
      const time = cd.readUInt16LE(at + 12);
      const date = cd.readUInt16LE(at + 14);
      let packed = cd.readUInt32LE(at + 20);
      let bytes = cd.readUInt32LE(at + 24);
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen);
      if (bytes === 0xffffffff || packed === 0xffffffff) {
        // Zip64: the real sizes are in the extra field, in the order of the 32-bit fields that overflowed.
        for (let x = at + 46 + nameLen, end = x + extraLen; x + 4 <= end; ) {
          const id = cd.readUInt16LE(x);
          const len = cd.readUInt16LE(x + 2);
          if (id === 1) {
            let f = x + 4;
            if (bytes === 0xffffffff && f + 8 <= x + 4 + len) { bytes = Number(cd.readBigUInt64LE(f)); f += 8; }
            if (packed === 0xffffffff && f + 8 <= x + 4 + len) packed = Number(cd.readBigUInt64LE(f));
            break;
          }
          x += 4 + len;
        }
      }
      at += 46 + nameLen + extraLen + commentLen;
      const dir = name.endsWith('/');
      total++;
      unpacked += bytes;
      if (entries.length < ARCHIVE_ROWS) entries.push({ path: dir ? name.slice(0, -1) : name, dir, size: bytes, packed, mtime: dosDate(date, time), locked: !!(flags & 1) });
    }
    return { format: 'zip', entries, total, unpacked };
  } finally {
    await fh.close();
  }
}

/** A tool's output. Its stdin is closed so one that asks a question (7z, a password) fails instead of waiting; past the timeout it's killed outright (7z catches SIGTERM). */
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 20000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL', ...opts }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: err })) : resolve(out)));
    child.stdin?.end();
  });

/** A tar's entries (plain or compressed: tar tells gzip, bzip2, xz and zstd apart itself). */
async function tarEntries(file) {
  const out = await run('tar', ['-tvf', file]);
  const entries = [];
  let total = 0;
  let unpacked = 0;
  // GNU tar: "-rw-r--r-- owner/group     1234 2026-11-06 15:20 dir/name"
  for (const line of out.split('\n')) {
    const m = /^([-dlbcps][-rwxsStT]{9})\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?)\s+(.*)$/.exec(line);
    if (!m) continue;
    const dir = m[1][0] === 'd';
    const name = m[4].replace(/ -> .*$/, '').replace(/^\.\//, '').replace(/\/$/, '');
    if (!name || name === '.') continue;
    total++;
    unpacked += Number(m[2]);
    if (entries.length < ARCHIVE_ROWS) entries.push({ path: name, dir, size: Number(m[2]), mtime: new Date(m[3]).getTime() });
  }
  return { format: 'tar', entries, total, unpacked };
}

/** 7-Zip's listing, for .7z and .rar (and anything else it knows), when 7z is installed. */
async function sevenEntries(file) {
  // -p (an empty password): an archive with encrypted headers fails right away instead of asking for one.
  const out = await run('7z', ['l', '-slt', '-ba', '-p', file]).catch((e) => {
    if (e.code === 'ENOENT') throw new Error('Install 7-Zip to see inside this archive');
    throw new Error(/encrypted|password/i.test(String(e.stderr || '')) ? 'This archive is password-protected' : 'This archive can’t be read');
  });
  const entries = [];
  let total = 0;
  let unpacked = 0;
  for (const block of out.split(/\n\s*\n/)) {
    const f = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(' = ');
      if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 3).trim();
    }
    if (!f.Path) continue;
    const dir = /^D/.test(f.Attributes || '') || f.Folder === '+';
    total++;
    unpacked += Number(f.Size) || 0;
    if (entries.length < ARCHIVE_ROWS) entries.push({ path: f.Path.replace(/\/$/, ''), dir, size: Number(f.Size) || 0, packed: Number(f['Packed Size']) || undefined, mtime: f.Modified ? new Date(f.Modified).getTime() : 0, locked: f.Encrypted === '+' });
  }
  return { format: '7z', entries, total, unpacked };
}

/**
 * What's inside an archive, for Files' preview: { format, entries: [{ path, dir, size, packed?, mtime, locked? }], total,
 * unpacked }, entries capped at ARCHIVE_ROWS (total says how many there really are). A lone compressed file (notes.txt.gz)
 * comes back as { format: 'gzip', single: 'notes.txt' }.
 */
async function archiveList(file) {
  const p = path.resolve(String(file));
  const ext = path.extname(p).slice(1).toLowerCase();
  let r;
  if (ext === 'zip') r = await zipEntries(p);
  else if (ext === '7z' || ext === 'rar') r = await sevenEntries(p);
  else {
    // notes.txt.gz is one compressed file, not a tar; so is a .gz that tar finds nothing in (it doesn't fail on one).
    const compressed = ['gz', 'bz2', 'xz', 'zst'].includes(ext);
    const single = { format: ext, single: path.basename(p, path.extname(p)), entries: [], total: 0, unpacked: 0 };
    const inner = path.extname(single.single).toLowerCase();
    if (compressed && inner && inner !== '.tar') return single;
    try {
      r = await tarEntries(p);
    } catch {
      if (compressed) return single;
      throw new Error('This archive can’t be read');
    }
    if (compressed && !r.total) return single;
  }
  for (const en of r.entries) en.kind = kindOf(en.path, en.dir);
  return r;
}

/* ---------------- extracting ---------------- */

const EXTRACT_TIMEOUT = 10 * 60 * 1000; // a big archive on a slow stick takes a while; past this it's stopped
const DECOMPRESSOR = { gz: 'gzip', bz2: 'bzip2', xz: 'xz', zst: 'zstd' };

/** "Project", "Project 2", "Project 3"… whichever isn't taken in `dir`; a file keeps its extension ("notes 2.txt"). */
function numberedName(dir, name, isDir = false) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = isDir || name.startsWith('.') ? '' : path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!fs.existsSync(path.join(dir, `${base} ${i}${ext}`))) return `${base} ${i}${ext}`;
}

/** What the tool said went wrong, in a sentence. */
const extractError = (e, tool) => {
  if (e.killed || e.signal) return new Error('Extracting took too long and was stopped.');
  const said = String(e.stderr || '').trim().split('\n').filter(Boolean).pop() || '';
  if (/no space left/i.test(said)) return new Error('There isn’t enough room on this drive.');
  if (/password|encrypted/i.test(said)) return new Error('This archive is password-protected.');
  return new Error(said ? `${tool}: ${said.replace(/^\S+:\s*/, '')}` : 'This archive couldn’t be extracted.');
};

/** Decompress one file (notes.txt.gz → notes.txt), streaming the tool's output to `to` (which must not exist). */
const decompress = (cmd, from, to) =>
  new Promise((resolve, reject) => {
    const out = fs.createWriteStream(to, { flags: 'wx' });
    const child = spawn(cmd, ['-dc', from], { stdio: ['ignore', 'pipe', 'pipe'], timeout: EXTRACT_TIMEOUT });
    let stderr = '';
    let code = null;
    const done = () => (code === 0 ? resolve() : reject(extractError({ stderr, killed: child.killed }, cmd)));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.pipe(out);
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`Install ${cmd} to extract this file.`) : e));
    out.on('error', reject);
    child.on('close', (c) => { code = c; if (out.writableFinished) done(); });
    out.on('finish', () => { if (code !== null) done(); });
  });

/** Where an archive's contents go when its own folder can't be written (a read-only drive, /usr/share): Downloads. */
function fallbackDir() {
  const d = userDirs().DOWNLOAD || path.join(HOME, 'Downloads');
  fs.mkdirSync(d, { recursive: true });
  return path.resolve(d);
}

/**
 * Unpack an archive beside itself (or into `into`): Project.zip → a folder "Project" (numbered if that's taken), unless
 * it holds a single file or folder at the top, which lands as itself, so Project.zip holding Project/ doesn't nest
 * twice. A lone compressed file (notes.txt.gz) becomes notes.txt. The work happens in a hidden folder beside the archive,
 * so a failed extraction leaves nothing behind. Returns the path of what was made. Password-protected archives are
 * refused up front; zip is unzip's (7z's without it), tar is tar's, .7z and .rar are 7-Zip's.
 */
async function extract(file, into) {
  const p = path.resolve(String(file));
  let dir = into ? path.resolve(String(into)) : path.dirname(p);
  await fsp.access(dir, fs.constants.W_OK).catch(() => { dir = fallbackDir(); });
  const ext = path.extname(p).slice(1).toLowerCase();
  const listing = await archiveList(p);
  if (listing.entries.some((e) => e.locked)) throw new Error('This archive is password-protected.');
  if (listing.single) {
    const tool = DECOMPRESSOR[listing.format];
    if (!tool) throw new Error('This archive couldn’t be extracted.');
    const to = path.join(dir, numberedName(dir, listing.single));
    await decompress(tool, p, to).catch(async (e) => {
      await fsp.rm(to, { force: true });
      throw e;
    });
    return to;
  }
  let stem = path.basename(p, path.extname(p));
  if (/\.tar$/i.test(stem)) stem = stem.slice(0, -4);
  const tmp = path.join(dir, `.extracting-${stem}-${Date.now().toString(36)}`);
  await fsp.mkdir(tmp);
  try {
    const opts = { timeout: EXTRACT_TIMEOUT, maxBuffer: 16 * 1024 * 1024 };
    const seven = () =>
      run('7z', ['x', '-y', '-p', '-bso0', '-bsp0', `-o${tmp}`, p], opts).catch((e) => {
        throw e.code === 'ENOENT' ? new Error('Install 7-Zip to extract this archive.') : extractError(e, '7-Zip');
      });
    if (ext === 'zip') {
      // unzip exits 1 for warnings (an entry with ".." in its name, skipped) with everything else extracted.
      await run('unzip', ['-qq', '-o', p, '-d', tmp], opts).catch((e) => {
        if (e.code === 1) return;
        if (e.code === 'ENOENT') return seven();
        throw extractError(e, 'unzip');
      });
    } else if (ext === '7z' || ext === 'rar') await seven();
    else await run('tar', ['-xf', p, '-C', tmp], opts).catch((e) => { throw extractError(e, 'tar'); });
    const top = await fsp.readdir(tmp);
    let made;
    if (top.length === 1) {
      const isDir = (await fsp.lstat(path.join(tmp, top[0]))).isDirectory();
      made = path.join(dir, numberedName(dir, top[0], isDir));
      await fsp.rename(path.join(tmp, top[0]), made);
      await fsp.rm(tmp, { recursive: true, force: true });
    } else {
      made = path.join(dir, numberedName(dir, stem, true));
      await fsp.rename(tmp, made);
    }
    return made;
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Save a text file (Text Editor). Writes in place, so the file keeps its permissions, owner and links. */
async function writeText(file, text) {
  await fsp.writeFile(String(file), String(text), 'utf8');
  return { mtime: (await fsp.stat(String(file))).mtimeMs };
}

/** Save a binary file (Image Editor). In place, like writeText. */
async function writeBytes(file, bytes) {
  await fsp.writeFile(String(file), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { mtime: (await fsp.stat(String(file))).mtimeMs };
}

/** Search a folder and the folders inside it, by name. Skips hidden folders and stops after 4 seconds or 400 matches. */
async function search(dir, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const until = Date.now() + 4000;
  const found = [];
  const queue = [path.resolve(String(dir || HOME))];
  while (queue.length && found.length < 400 && Date.now() < until) {
    const d = queue.shift();
    let items;
    try {
      items = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (it.name.startsWith('.') || it.name === 'node_modules') continue;
      if (it.name.toLowerCase().includes(q)) {
        const e = await entry(d, it.name);
        if (e) found.push(e);
      }
      if (it.isDirectory()) queue.push(path.join(d, it.name));
    }
  }
  return found;
}

/* ---------------- changing ---------------- */

const validName = (name) => {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\0')) throw new Error('That name can’t be used.');
  if (Buffer.byteLength(n) > 255) throw new Error('That name is too long.');
  return n;
};

/** A name that isn't taken in `dir`: "Report.pdf" → "Report copy.pdf", "Report copy 2.pdf"… */
function freeName(dir, name, suffix = 'copy') {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = name.startsWith('.') || !path.extname(name) ? '' : path.extname(name);
  const base = name.slice(0, name.length - ext.length).replace(new RegExp(` ${suffix}( \\d+)?$`), '');
  for (let i = 1; ; i++) {
    const n = `${base} ${suffix}${i > 1 ? ` ${i}` : ''}${ext}`;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
}

/** A new folder: "New folder", or "New folder 2", "New folder 3"… when that's taken. Returns its path. */
async function mkdir(parent, name = 'New folder') {
  const dir = path.resolve(String(parent));
  let n = validName(name);
  for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${validName(name)} ${i}`;
  await fsp.mkdir(path.join(dir, n));
  return path.join(dir, n);
}

async function rename(file, name) {
  const from = path.resolve(String(file));
  const to = path.join(path.dirname(from), validName(name));
  if (to === from) return to;
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`There’s already something called “${path.basename(to)}” here.`);
  await fsp.rename(from, to);
  return to;
}

/**
 * Copy or move files into a folder. Names already there get " copy" (copying) instead of overwriting anything. Moving
 * between drives copies and then removes the original. Returns the new paths.
 */
async function paste(paths, into, move = false) {
  const dest = path.resolve(String(into));
  const out = [];
  for (const p of (Array.isArray(paths) ? paths : []).map((x) => path.resolve(String(x)))) {
    if (dest === p || dest.startsWith(p + path.sep)) throw new Error(`“${path.basename(p)}” can’t go inside itself.`);
    if (move && path.dirname(p) === dest) {
      out.push(p);
      continue;
    }
    const target = path.join(dest, freeName(dest, path.basename(p)));
    if (move) {
      try {
        await fsp.rename(p, target);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.cp(p, target, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        await fsp.rm(p, { recursive: true, force: true });
      }
    } else await fsp.cp(p, target, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    out.push(target);
  }
  return out;
}

/* ---------------- Trash ---------------- */

/* The freedesktop.org Trash, done here rather than through whatever desktop environment happens to be around: the
   home Trash for things on the same drive as your home folder, and <drive>/.Trash-<uid> for things on other drives (so
   deleting from a USB stick doesn't copy everything onto the internal disk). Each item gets a .trashinfo recording
   where it came from and when, which is what Put back reads. */
const UID = os.userInfo().uid;

/** The top of the file system `p` is on (where a drive is mounted). */
async function mountTop(p, dev) {
  let top = p;
  while (top !== '/') {
    const up = path.dirname(top);
    if ((await fsp.stat(up)).dev !== dev) break;
    top = up;
  }
  return top;
}

const stamp = (d = new Date()) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};

async function trashOne(file) {
  const st = await fsp.lstat(file);
  await fsp.mkdir(path.join(TRASH, 'files'), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(TRASH, 'info'), { recursive: true, mode: 0o700 });
  let dir = TRASH;
  let top = null;
  if (st.dev !== (await fsp.stat(TRASH)).dev) {
    top = await mountTop(file, st.dev);
    dir = path.join(top, `.Trash-${UID}`);
    await fsp.mkdir(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(dir, 'info'), { recursive: true, mode: 0o700 });
  }
  // Claim a name by creating its .trashinfo exclusively (two deletes at once can't take the same one).
  const name = path.basename(file);
  const where = top ? path.relative(top, file) : file;
  const info = `[Trash Info]\nPath=${encodeURIComponent(where).replace(/%2F/g, '/')}\nDeletionDate=${stamp()}\n`;
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${name}.${i}`;
    const infoPath = path.join(dir, 'info', `${n}.trashinfo`);
    if (fs.existsSync(path.join(dir, 'files', n))) continue;
    try {
      await fsp.writeFile(infoPath, info, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      await fsp.rename(file, path.join(dir, 'files', n));
    } catch (err) {
      await fsp.rm(infoPath, { force: true });
      throw new Error(err.code === 'EACCES' || err.code === 'EPERM' ? `You don’t have permission to delete “${name}”.` : err.message);
    }
    return path.join(dir, 'files', n);
  }
}

async function trash(paths) {
  for (const p of Array.isArray(paths) ? paths : []) await trashOne(path.resolve(String(p)));
  return true;
}

/**
 * Every Trash: yours (~/.local/share/Trash), and the one on each drive (<drive>/.Trash-<uid>), where things deleted from
 * that drive go. Each has files/ and info/ (<name>.trashinfo: where it came from, and when).
 */
function trashDirs() {
  const dirs = [{ dir: TRASH, top: null }];
  for (const d of places().drives) {
    const t = path.join(d.path, `.Trash-${os.userInfo().uid}`);
    if (fs.existsSync(t)) dirs.push({ dir: t, top: d.path });
  }
  return dirs;
}

/** What's in the Trash, with where each thing came from. Each item's `path` is where it is in the Trash. */
async function trashList() {
  const out = [];
  for (const { dir, top } of trashDirs()) {
    const files = path.join(dir, 'files');
    for (const name of await fsp.readdir(files).catch(() => [])) {
      const e = await entry(files, name);
      if (!e) continue;
      try {
        const info = fs.readFileSync(path.join(dir, 'info', `${name}.trashinfo`), 'utf8');
        const orig = decodeURIComponent((info.match(/^Path=(.*)$/m) || [])[1] || '');
        e.origPath = top && !path.isAbsolute(orig) ? path.join(top, orig) : orig; // a drive's Trash stores paths from its top
        e.deletedAt = Date.parse((info.match(/^DeletionDate=(.*)$/m) || [])[1] || '') || e.mtime;
      } catch {}
      out.push(e);
    }
  }
  return out;
}

/** An item in one of the Trashes (by its path there), and its .trashinfo. Anything else is refused. */
function inTrash(p) {
  const file = path.resolve(String(p));
  const dir = trashDirs().find((t) => path.dirname(file) === path.join(t.dir, 'files'));
  if (!dir) throw new Error('That isn’t in the Trash.');
  return { file, info: path.join(dir.dir, 'info', `${path.basename(file)}.trashinfo`), top: dir.top };
}

/** Put things back where they were (next to anything that has taken their name since). */
async function restore(paths) {
  for (const p of Array.isArray(paths) ? paths : []) {
    const { file, info, top } = inTrash(p);
    let orig;
    try {
      orig = decodeURIComponent((fs.readFileSync(info, 'utf8').match(/^Path=(.*)$/m) || [])[1] || '');
    } catch {}
    if (!orig) orig = path.join(top || HOME, path.basename(file));
    if (!path.isAbsolute(orig)) orig = path.join(top || HOME, orig);
    await fsp.mkdir(path.dirname(orig), { recursive: true });
    const target = path.join(path.dirname(orig), freeName(path.dirname(orig), path.basename(orig), 'restored'));
    await fsp.rename(file, target);
    await fsp.rm(info, { force: true });
  }
  return true;
}

/** Delete for good: some things in the Trash (by their paths there), or all of it. */
async function deleteForever(paths) {
  const all = paths === 'all' ? (await trashList()).map((e) => e.path) : Array.isArray(paths) ? paths : [];
  for (const p of all) {
    const { file, info } = inTrash(p);
    await fsp.rm(file, { recursive: true, force: true });
    await fsp.rm(info, { force: true });
  }
  return true;
}

/* ---------------- watching ---------------- */

let send = () => {};
const watchers = new Map(); // dir -> { watcher, count, timer }

/** Tell the page when an open folder changes (a download finishing, a file saved by another app). */
function watch(dir) {
  const d = path.resolve(String(dir));
  const w = watchers.get(d);
  if (w) return void w.count++;
  try {
    const entry = { count: 1, timer: 0, watcher: null };
    entry.watcher = fs.watch(d, () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => send('files:changed', { dir: d }), 250);
    });
    entry.watcher.on('error', () => unwatch(d, true));
    watchers.set(d, entry);
  } catch {}
}
function unwatch(dir, all = false) {
  const d = path.resolve(String(dir));
  const w = watchers.get(d);
  if (!w || (--w.count > 0 && !all)) return;
  clearTimeout(w.timer);
  w.watcher?.close();
  watchers.delete(d);
}

/* ---------------- serving file contents to Leafdeck's page ---------------- */

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  wav: 'audio/wav', weba: 'audio/webm', pdf: 'application/pdf',
};

/**
 * leafdeck://app/~file?p=<absolute path>: a file's contents, for previews and thumbnails in Files. Byte ranges are
 * supported, so videos can seek. SVGs are sandboxed (no scripts). Only Leafdeck's own page can ask for these.
 */
async function serveFile(request) {
  const file = path.resolve(new URL(request.url).searchParams.get('p') || '');
  let st;
  try {
    st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  let start = 0;
  let end = st.size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } });
  }
  const stream = fs.createReadStream(file, { start, end });
  const body = new ReadableStream({
    start(c) {
      stream.on('data', (d) => c.enqueue(new Uint8Array(d)));
      stream.on('end', () => c.close());
      stream.on('error', (e) => c.error(e));
    },
    cancel() {
      stream.destroy();
    },
  });
  headers['content-length'] = String(end - start + 1);
  if (range) headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** The program the computer opens a file with (its .desktop name), from the freedesktop.org MIME settings. */
const defaultApp = (file) =>
  new Promise((resolve) =>
    execFile('xdg-mime', ['query', 'filetype', file], { timeout: 3000 }, (err, mime) =>
      err || !mime.trim() ? resolve('') : execFile('xdg-mime', ['query', 'default', mime.trim()], { timeout: 3000 }, (e, app) => resolve(e ? '' : app.trim())),
    ),
  );

// Fedora's own file manager says it opens archives, and so Word documents (they're zip files underneath). It isn't part
// of Leafdeck OS: it never opens a file or appears under "Open with".
const NOT_AN_APP = new Set(['leafdeck-open.desktop', 'org.gnome.Nautilus.desktop', 'nautilus-autorun-software.desktop']);

/** The apps the freedesktop.org MIME settings give a file's type: { def, ids }, `def` the default's .desktop name. */
async function mimeApps(p) {
  const mime = await new Promise((resolve) => execFile('xdg-mime', ['query', 'filetype', p], { timeout: 3000 }, (e, out) => resolve(e ? '' : out.trim())));
  if (!mime) return { def: '', ids: [] };
  const out = await new Promise((resolve) => execFile('gio', ['mime', mime], { timeout: 3000 }, (e, o) => resolve(e ? '' : o)));
  const def = /: (\S+\.desktop)$/.exec(out.split('\n')[0].trim())?.[1] || '';
  return { def, ids: [...new Set([def, ...(out.split(/Registered applications:/)[1] || '').split(/Recommended applications:/)[0].split('\n').map((l) => l.trim())])].filter((id) => id.endsWith('.desktop')) };
}

/**
 * Open with the computer's app for that kind of file. Resolves to an error message, or '' when it opened. Leafdeck
 * itself (os/leafdeck-open, the default for folders, PDFs and text in Leafdeck OS) doesn't count: Files already shows it.
 */
async function open(file) {
  const p = path.resolve(String(file));
  if ((await defaultApp(p)) === 'leafdeck-open.desktop') return 'No other app opens this file';
  if (NOT_AN_APP.has((await mimeApps(p)).def)) return 'No other app opens this file';
  return shell.openPath(p);
}

/** Where the computer's apps are described: the freedesktop.org data directories' applications folders. */
const appDirs = () =>
  [process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')]
    .filter(Boolean)
    .map((d) => path.join(d, 'applications'));
/** A .desktop file's path from its id (a "-" in the id may stand for a subfolder), or null. */
function desktopFile(id) {
  for (const dir of appDirs()) {
    for (const rel of [id, id.replace(/-/g, '/')]) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
/** A .desktop file's name, unless it's hidden from people. */
function desktopName(file) {
  try {
    const entry = fs.readFileSync(file, 'utf8').split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) || '';
    const val = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(entry)?.[1].trim();
    if (val('Hidden') === 'true' || val('NoDisplay') === 'true') return null;
    return val('Name') || null;
  } catch {
    return null;
  }
}

/**
 * The computer's apps that open a file, from the freedesktop.org MIME settings: [{ id, name, isDefault }], the default
 * first. Leafdeck itself (leafdeck-open) isn't one: Files offers Leafdeck's own apps.
 */
async function appsFor(file) {
  const { def, ids: all } = await mimeApps(path.resolve(String(file)));
  const ids = all.filter((id) => !NOT_AN_APP.has(id));
  const seen = new Set();
  const apps = [];
  for (const id of ids) {
    const f = desktopFile(id);
    const name = f && desktopName(f);
    if (!name || seen.has(name)) continue; // the same app as a Flatpak and a package
    seen.add(name);
    apps.push({ id, name, isDefault: id === def });
  }
  return apps;
}

/** Open a file with one of the computer's apps (an id from appsFor). Resolves to an error message, or '' when it opened. */
async function openWith(file, id) {
  const p = path.resolve(String(file));
  const desktop = /^[\w.+-]+\.desktop$/.test(String(id)) && desktopFile(String(id));
  if (!desktop) return 'That app isn’t on this computer';
  return new Promise((resolve) => execFile('gio', ['launch', desktop, p], { timeout: 10000 }, (e, _o, err) => resolve(e ? String(err || e.message).trim() || 'It didn’t open' : '')));
}

function init(opts) {
  send = opts.send;
}

module.exports = { init, list, places, desktopDir, readText, writeText, writeBytes, archiveList, extract, search, mkdir, rename, paste, trash, trashList, restore, deleteForever, watch, unwatch, serveFile, open, appsFor, openWith, kindOf };
