// Task Manager's view of the whole computer: CPU, memory, disks and network for the Performance page, and every
// process for the Processes page. CPU and memory come from node:os and work everywhere; disks, network and processes
// read /proc and /sys, so they're Linux only (elsewhere they come back empty). Rates are measured between calls.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LINUX = process.platform === 'linux';
const TICK = 100; // USER_HZ: /proc/<pid>/stat counts CPU time in 1/100 s on every Linux we run on
const PAGE = 4096;

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
};
const readNum = (p) => Number(read(p)) || 0;

/* ---------------- CPU ---------------- */

let prevCpu = null; // per-core times from the last call

function cpu() {
  const cores = os.cpus();
  const times = cores.map((c) => {
    const t = c.times;
    return { busy: t.user + t.nice + t.sys + t.irq, total: t.user + t.nice + t.sys + t.irq + t.idle };
  });
  const perCore = times.map((t, i) => {
    const p = prevCpu?.[i];
    const total = p ? t.total - p.total : 0;
    return total > 0 ? Math.min(100, Math.max(0, ((t.busy - p.busy) / total) * 100)) : 0;
  });
  prevCpu = times;
  const speeds = cores.map((c) => c.speed).filter(Boolean);
  // The rated ("base") speed, where the kernel says; otherwise the fastest a core goes.
  const base = LINUX ? readNum('/sys/devices/system/cpu/cpu0/cpufreq/base_frequency') / 1000 || readNum('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq') / 1000 : 0;
  return {
    model: (cores[0]?.model || 'Processor').replace(/\s+/g, ' ').replace(/\((R|TM)\)/gi, '').trim(),
    usage: perCore.length ? perCore.reduce((a, b) => a + b, 0) / perCore.length : 0,
    perCore,
    speed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0, // MHz, now
    baseSpeed: base || Math.max(0, ...speeds),
    sockets: 1,
    physicalCores: LINUX ? physicalCores() : 0,
    logical: cores.length,
    uptime: os.uptime(),
    ...(LINUX ? counts() : {}),
  };
}

/** Processes (kernel threads included, as Windows counts its own) and threads on the whole machine. */
function counts() {
  let processes = 0;
  try {
    processes = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
  } catch {}
  const threads = Number(read('/proc/loadavg').split(' ')[3]?.split('/')[1]) || 0;
  return { processes, threads };
}

let coreCount = 0;
function physicalCores() {
  if (coreCount) return coreCount;
  const ids = new Set();
  for (const block of read('/proc/cpuinfo').split('\n\n')) {
    const phys = /physical id\s*:\s*(\d+)/.exec(block)?.[1];
    const core = /core id\s*:\s*(\d+)/.exec(block)?.[1];
    if (core != null) ids.add(`${phys}:${core}`);
  }
  return (coreCount = ids.size);
}

/* ---------------- memory ---------------- */

function memory() {
  const total = os.totalmem();
  if (!LINUX) return { total, used: total - os.freemem(), available: os.freemem(), cached: 0, free: os.freemem(), swapTotal: 0, swapUsed: 0, committed: 0 };
  const m = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const [k, v] = line.split(':');
    if (v) m[k] = parseInt(v, 10) * 1024;
  }
  const available = m.MemAvailable ?? m.MemFree;
  return {
    total,
    used: total - available,
    available,
    cached: (m.Cached || 0) + (m.Buffers || 0) + (m.SReclaimable || 0) - (m.Shmem || 0),
    free: m.MemFree || 0,
    swapTotal: m.SwapTotal || 0,
    swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
    committed: m.Committed_AS || 0,
    commitLimit: m.CommitLimit || 0,
  };
}

/* ---------------- sensors ---------------- */

let tempFile = null; // the CPU temperature's file in /sys, looked for once ('' when there is none)

/** The CPU's temperature in °C (the package sensor where there is one), or null where no sensor is readable. */
function temperature() {
  if (!LINUX) return null;
  if (tempFile === null) {
    tempFile = '';
    const DRIVERS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal', 'soc_thermal', 'acpitz'];
    let best = null;
    try {
      for (const h of fs.readdirSync('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${h}`;
        const rank = DRIVERS.indexOf(read(`${dir}/name`));
        if (rank < 0 || (best && best.rank <= rank)) continue;
        const inputs = fs.readdirSync(dir).filter((f) => /^temp\d+_input$/.test(f)).sort();
        if (!inputs.length) continue;
        // The whole package's sensor over one core's.
        const pkg = inputs.find((f) => /package|tctl|tdie|cpu/i.test(read(`${dir}/${f.replace('_input', '_label')}`)));
        best = { rank, file: `${dir}/${pkg || inputs[0]}` };
      }
    } catch {}
    tempFile = best?.file || '';
  }
  if (!tempFile) return null;
  const c = readNum(tempFile) / 1000;
  return c > 0 && c < 150 ? Math.round(c) : null; // acpitz says -273 where it has nothing to read
}

let fanFiles = null;

/** The fastest fan's speed in rpm (0 when they're all stopped), or null without a readable fan sensor. */
function fan() {
  if (!LINUX) return null;
  if (fanFiles === null) {
    fanFiles = [];
    try {
      for (const h of fs.readdirSync('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${h}`;
        for (const f of fs.readdirSync(dir)) if (/^fan\d+_input$/.test(f)) fanFiles.push(`${dir}/${f}`);
      }
    } catch {}
  }
  let max = null;
  for (const f of fanFiles) {
    const v = read(f); // some ACPI fans list a file that can't be read ("No such device")
    if (v !== '' && (max === null || Number(v) > max)) max = Number(v);
  }
  return max;
}

/* ---------------- disks ---------------- */

let prevDisk = null; // { at, byName: { name: { read, write, busy } } }

/** Real disks only: no partitions, loop devices, RAM disks or zram (swap in memory). */
function diskNames() {
  let names = [];
  try {
    names = fs.readdirSync('/sys/block');
  } catch {}
  return names.filter((n) => !/^(loop|ram|zram|dm-|md|sr|fd)/.test(n));
}

function disks() {
  if (!LINUX) return [];
  const now = Date.now();
  const stats = {};
  for (const line of read('/proc/diskstats').split('\n')) {
    const f = line.trim().split(/\s+/);
    // fields: major minor name reads . sectorsRead . writes . sectorsWritten . inFlight ioTicks ...
    if (f.length >= 13) stats[f[2]] = { read: Number(f[5]) * 512, write: Number(f[9]) * 512, busy: Number(f[12]) };
  }
  const prev = prevDisk;
  prevDisk = { at: now, byName: stats };
  const secs = prev ? (now - prev.at) / 1000 : 0;
  return diskNames().map((name, i) => {
    const s = stats[name] || { read: 0, write: 0, busy: 0 };
    const p = prev?.byName[name];
    const sys = `/sys/block/${name}`;
    const nvme = name.startsWith('nvme');
    const rotational = read(`${sys}/queue/rotational`) === '1';
    return {
      name,
      index: i,
      model: read(`${sys}/device/model`) || read(`${sys}/device/name`) || name,
      kind: rotational ? 'HDD' : nvme ? 'SSD (NVMe)' : read(`${sys}/removable`) === '1' ? 'Removable' : 'SSD',
      capacity: readNum(`${sys}/size`) * 512,
      readRate: p && secs ? Math.max(0, (s.read - p.read) / secs) : 0,
      writeRate: p && secs ? Math.max(0, (s.write - p.write) / secs) : 0,
      active: p && secs ? Math.min(100, Math.max(0, ((s.busy - p.busy) / (secs * 1000)) * 100)) : 0,
    };
  });
}

/* ---------------- network ---------------- */

let prevNet = null;

function network() {
  if (!LINUX) return [];
  const now = Date.now();
  const stats = {};
  for (const line of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    stats[name.trim()] = { rx: f[0], tx: f[8] };
  }
  const prev = prevNet;
  prevNet = { at: now, byName: stats };
  const secs = prev ? (now - prev.at) / 1000 : 0;
  const addrs = os.networkInterfaces();
  // Hardware adapters only (they have a device); skips lo, bridges, VPN tunnels and container links.
  return Object.keys(stats)
    .filter((n) => fs.existsSync(`/sys/class/net/${n}/device`))
    .map((name) => {
      const s = stats[name];
      const p = prev?.byName[name];
      const wifi = fs.existsSync(`/sys/class/net/${name}/wireless`);
      const v4 = (addrs[name] || []).find((a) => a.family === 'IPv4');
      const v6 = (addrs[name] || []).find((a) => a.family === 'IPv6' && !a.address.startsWith('fe80'));
      const speed = Number(read(`/sys/class/net/${name}/speed`)); // Mbit/s; -1 or unreadable on Wi-Fi
      return {
        name,
        kind: wifi ? 'Wi-Fi' : 'Ethernet',
        up: read(`/sys/class/net/${name}/operstate`) === 'up',
        ipv4: v4?.address || '',
        ipv6: v6?.address || '',
        linkSpeed: speed > 0 ? speed * 1e6 : 0,
        sendRate: p && secs ? Math.max(0, (s.tx - p.tx) / secs) : 0,
        receiveRate: p && secs ? Math.max(0, (s.rx - p.rx) / secs) : 0,
      };
    });
}

/* ---------------- processes ---------------- */

let prevProc = null; // { at, byPid: Map(pid -> { cpu, io, start }) }
let users = null;

function userName(uid) {
  if (!users) {
    users = new Map();
    for (const line of read('/etc/passwd').split('\n')) {
      const f = line.split(':');
      if (f.length > 2) users.set(Number(f[2]), f[0]);
    }
  }
  return users.get(uid) ?? String(uid);
}

async function readProc(pid) {
  const dir = `/proc/${pid}`;
  const [stat, status, cmdline, io] = await Promise.all(
    ['stat', 'status', 'cmdline', 'io'].map((f) => fsp.readFile(`${dir}/${f}`, 'utf8').catch(() => '')),
  );
  if (!stat || !cmdline) return null; // gone, or a kernel thread (no command line)
  // comm can contain spaces and parentheses, so split after the last ')'.
  const close = stat.lastIndexOf(')');
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const f = stat.slice(close + 2).split(' '); // f[0] is field 3 (state)
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(\\d+)`, 'm').exec(status);
    return m ? Number(m[1]) : 0;
  };
  const argv = cmdline.split('\0').filter(Boolean);
  const exe = path.basename(argv[0] || comm);
  return {
    pid,
    ppid: Number(f[1]),
    state: f[0],
    // The program's file name, like Windows shows: comm is cut to 15 characters and threads can rename it. Some
    // daemons rewrite their command line into a title ("sshd: andrew"); those keep comm.
    name: argv[0] && !/[:\s]/.test(argv[0]) ? exe : comm,
    command: argv.join(' ').slice(0, 300),
    uid: field('Uid'),
    threads: Number(f[17]) || 1,
    start: Number(f[19]),
    cpuTicks: Number(f[11]) + Number(f[12]),
    // What the process itself is holding, like Windows' "private working set": not shared libraries or files.
    memory: (field('RssAnon') + field('RssShmem')) * 1024 || Number(f[21]) * PAGE,
    io: io ? Number(/read_bytes:\s*(\d+)/.exec(io)?.[1] || 0) + Number(/^write_bytes:\s*(\d+)/m.exec(io)?.[1] || 0) : null,
  };
}

/** Every process with a command line (kernel threads are left out), with CPU (% of the whole machine) and disk rates. */
async function processes() {
  if (!LINUX) return { supported: false, list: [] };
  const now = Date.now();
  const pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n)).map(Number);
  const list = (await Promise.all(pids.map(readProc))).filter(Boolean);
  const prev = prevProc;
  const secs = prev ? (now - prev.at) / 1000 : 0;
  const ncpu = os.cpus().length || 1;
  const byPid = new Map();
  let threads = 0;
  for (const p of list) {
    const was = prev?.byPid.get(p.pid);
    const same = was && was.start === p.start; // not a new process that reused the pid
    p.cpu = same && secs ? Math.max(0, ((p.cpuTicks - was.cpu) / TICK / secs / ncpu) * 100) : 0;
    p.disk = same && secs && p.io != null && was.io != null ? Math.max(0, (p.io - was.io) / secs) : 0;
    p.user = userName(p.uid);
    p.mine = p.uid === process.getuid();
    byPid.set(p.pid, { cpu: p.cpuTicks, io: p.io, start: p.start });
    threads += p.threads;
    delete p.cpuTicks;
    delete p.io;
    delete p.start;
  }
  prevProc = { at: now, byPid };
  return { supported: true, list, threads };
}

/** End a process: ask it to quit, and force it if it's still there after `graceMs`. */
async function endProcess(pid, { force = false, graceMs = 3000 } = {}) {
  if (!LINUX) throw new Error('Only available on Linux');
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Not a process');
  const started = () => read(`/proc/${pid}/stat`).split(') ')[1]?.split(' ')[19];
  const start = started();
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    throw new Error(err.code === 'EPERM' ? 'That process belongs to the system or another user' : err.code === 'ESRCH' ? 'That process has already ended' : err.message);
  }
  if (!force)
    setTimeout(() => {
      if (start && started() !== start) return; // ended, and maybe the pid went to something new
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }, graceMs).unref();
  return { ok: true };
}

/** One sample of the whole machine for the Performance page and the Performance widget. */
function system() {
  return { at: Date.now(), cpu: cpu(), memory: memory(), disks: disks(), network: network(), temp: temperature(), fan: fan(), linux: LINUX };
}

/* Frames per second on each screen, from fps-helper.py. The helper stays up between the widget's samples and goes away
   once they stop. */
const FPS_HELPER = path.join(__dirname, 'fps-helper.py').replace('app.asar', 'app.asar.unpacked');
const FPS_WINDOW = 1; // seconds watched per sample
const FPS_IDLE = 10_000;
let fpsChild = null;
let fpsPending = null; // { resolve, timer } of the one sample in progress
let fpsIdleTimer = 0;

function fpsAnswer(value) {
  if (!fpsPending) return;
  const { resolve, timer } = fpsPending;
  fpsPending = null;
  clearTimeout(timer);
  resolve(value);
}

function fpsStart() {
  let buf = '';
  const child = spawn('python3', ['-I', FPS_HELPER], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        fpsAnswer(JSON.parse(line));
      } catch {
        fpsAnswer({});
      }
    }
  });
  const gone = () => {
    if (fpsChild === child) fpsChild = null;
    fpsAnswer({});
  };
  child.on('error', gone);
  child.on('close', gone);
  return child;
}

/** { screen name: frames per second }, measured now over about a second; {} when the screens can't be read. */
function screenFps() {
  if (!LINUX) return Promise.resolve({});
  clearTimeout(fpsIdleTimer);
  fpsIdleTimer = setTimeout(() => fpsChild?.kill(), FPS_IDLE);
  fpsIdleTimer.unref();
  if (fpsPending) return fpsPending.promise;
  fpsChild ??= fpsStart();
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  fpsPending = { promise, resolve, timer: setTimeout(() => fpsChild?.kill(), (FPS_WINDOW + 3) * 1000) };
  fpsChild.stdin.write(`${FPS_WINDOW}\n`);
  return promise;
}

module.exports = { system, processes, endProcess, screenFps };
