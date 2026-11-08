// External drives (Files and the file picker): USB sticks, disks and memory cards, through UDisks, the system service
// every Linux desktop uses. It mounts them in /run/media/<you>, with no password for whoever's at the computer. On other
// desktops the desktop mounts a drive when it's plugged in; in the Leafdeck session nothing else does, so this does.
// The computer's own disks (Windows, other partitions) are never touched: UDisks marks those HintSystem.
const { execFile, spawn } = require('node:child_process');

let send = () => {};
let mayMount = () => false;
let known = []; // what's plugged in, from the last look
const tried = new Set(); // drives mounted once since they were plugged in: one you've removed stays that way
let monitor = null;
let timer = 0;
let looking = null;
let again = false;
let told = '';

const run = (cmd, args, timeout = 30000) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out)))),
  );

/** Bytes (UDisks' paths end in a NUL) as text. */
const text = (bytes) => Buffer.from((bytes || []).filter(Boolean)).toString();

function sizeName(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Number(bytes) || 0;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  return `${n >= 100 || !u ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}

/** The external drives UDisks knows, one item a file system (a drive can have several): [{ id, device, name, mount, locked, disk, canPowerOff, auto }] */
async function read() {
  const out = await run('busctl', ['--system', '--json=short', 'call', 'org.freedesktop.UDisks2', '/org/freedesktop/UDisks2', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects']);
  const objects = JSON.parse(out).data[0];
  const prop = (o, name) => o?.[name]?.data;
  const list = [];
  for (const [id, ifaces] of Object.entries(objects)) {
    const block = ifaces['org.freedesktop.UDisks2.Block'];
    if (!block || prop(block, 'HintIgnore') || prop(block, 'HintSystem')) continue;
    const usage = prop(block, 'IdUsage');
    const crypt = ifaces['org.freedesktop.UDisks2.Encrypted'];
    const locked = usage === 'crypto' && prop(crypt, 'CleartextDevice') === '/';
    if (usage !== 'filesystem' && !locked) continue; // swap, a partition table, or an encrypted drive that's open (its contents are their own item)
    const disk = prop(block, 'Drive');
    const device = text(prop(block, 'PreferredDevice')) || text(prop(block, 'Device'));
    list.push({
      id,
      device,
      name: prop(block, 'IdLabel') || prop(block, 'HintName') || `${sizeName(prop(block, 'Size'))} drive`,
      mount: text(prop(ifaces['org.freedesktop.UDisks2.Filesystem'], 'MountPoints')?.[0]),
      locked,
      disk,
      canPowerOff: !!prop(objects[disk]?.['org.freedesktop.UDisks2.Drive'], 'CanPowerOff'),
      auto: !!prop(block, 'HintAuto'),
    });
  }
  return list;
}

/** What to say about a UDisks failure ("Error mounting /dev/sda1: GDBus.Error:…: the reason"). */
const reason = (msg) => String(msg).split(/\n/)[0].replace(/^.*GDBus\.Error:[^:]*:\s*/, '').trim();

async function mountOne(d) {
  const out = await run('udisksctl', ['mount', '-b', d.device, '--no-user-interaction']);
  return /\bat (.+?)\.?\s*$/.exec(out.trim())?.[1] || '';
}

/** Look again, mount what's newly plugged in, and tell the UI. Calls overlapping one in progress run once after it. */
function refresh() {
  if (looking) {
    again = true;
    return looking;
  }
  looking = (async () => {
    let list = [];
    try {
      list = await read();
    } catch (e) {
      if (known.length) console.warn('[drives]', e.message);
    }
    const here = new Set(list.map((d) => d.id));
    for (const id of tried) if (!here.has(id)) tried.delete(id); // unplugged: mount it again next time
    known = list;
    let changed = false;
    for (const d of list) {
      if (d.mount || d.locked) tried.add(d.id); // already open, or nothing to mount until it's unlocked
      if (tried.has(d.id) || !d.auto || !mayMount()) continue;
      tried.add(d.id);
      try {
        d.mount = await mountOne(d);
        changed = true;
      } catch (e) {
        console.warn(`[drives] couldn't mount ${d.device}: ${reason(e.message)}`); // it stays in Files; opening it there says why
      }
    }
    if (changed) known = await read().catch(() => known);
    // UDisks reports the computer's own disks too, so most changes aren't news.
    const now = JSON.stringify(known);
    if (now !== told) {
      told = now;
      send('files:drives', {});
    }
  })().finally(() => {
    looking = null;
    if (again) {
      again = false;
      refresh();
    }
  });
  return looking;
}

function soon() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 400);
}

/**
 * UDisks reports every change; a drive arriving is a burst of them. The shell around udisksctl is so it can't outlive
 * Leafdeck: it ignores a closed pipe (it would stay behind after a crash), but `read` ends when our end of stdin closes.
 */
function watch() {
  monitor = spawn('sh', ['-c', 'udisksctl monitor & read _; kill $!'], { stdio: ['pipe', 'pipe', 'ignore'] });
  monitor.stdout.on('data', soon);
  monitor.on('error', () => {});
  monitor.on('close', () => {
    monitor = null;
    setTimeout(watch, 10000).unref();
  });
}

/** What's plugged in and isn't open, for Files to offer. */
const unmounted = () => known.filter((d) => !d.mount).map((d) => ({ id: `drive:${d.id}`, name: d.name, device: d.device, locked: d.locked }));
/** The external drive mounted at a place, if it's one (a mount in /mnt, say, isn't Leafdeck's to remove). */
const mountedAt = (where) => known.find((d) => d.mount === where) || null;

const find = (device) => {
  const d = known.find((x) => x.device === device);
  if (!d) throw new Error('That drive isn’t plugged in anymore.');
  return d;
};

/** Open a drive that isn't mounted (one you removed but left in, or one UDisks wouldn't mount by itself). Its path. */
async function mount(device) {
  const d = find(String(device));
  if (d.locked) throw new Error(`“${d.name}” is encrypted, and Leafdeck can’t unlock encrypted drives yet.`);
  if (d.mount) return d.mount;
  try {
    const where = await mountOne(d);
    await refresh();
    return where || known.find((x) => x.id === d.id)?.mount || '';
  } catch (e) {
    throw new Error(`“${d.name}” couldn’t be opened: ${reason(e.message)}`);
  }
}

/** Safely remove a drive: every file system on it is unmounted (which finishes writing), then it's powered off when it can be. */
async function eject(device) {
  const d = find(String(device));
  const parts = d.disk && d.disk !== '/' ? known.filter((x) => x.disk === d.disk) : [d];
  try {
    for (const p of parts) if (p.mount) await run('udisksctl', ['unmount', '-b', p.device], 120000);
    // Only the unmounting matters for your files, so a drive that won't power off is still safe to pull out.
    if (d.canPowerOff) await run('udisksctl', ['power-off', '-b', d.device]).catch((e) => console.warn('[drives] power off:', reason(e.message)));
  } catch (e) {
    throw new Error(/busy/i.test(e.message) ? `“${d.name}” is still being used. Close anything that’s using it and try again.` : `“${d.name}” couldn’t be removed: ${reason(e.message)}`);
  } finally {
    await refresh();
  }
  return d.name;
}

function init(opts) {
  send = opts.send;
  mayMount = opts.mayMount;
  watch();
  refresh();
}

function stop() {
  clearTimeout(timer);
  monitor?.removeAllListeners('close');
  monitor?.stdin.end();
}

module.exports = { init, refresh, stop, unmounted, mountedAt, mount, eject };
