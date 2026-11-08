// Leafdeck OS: scheduler settings for Leafdeck's own processes, so the desktop keeps drawing at the screens' rate while
// builds, encodes and Claude sessions load the CPU. Every thread of Leafdeck's processes (the browser, the GPU process,
// the desktop's renderer, helpers) gets a 0.5 ms EEVDF slice in place of the kernel's 2.8 ms: a thread that wakes to
// draw a frame then preempts a busy one within half a millisecond instead of waiting out that one's slice. Measured on
// the Yoga Book 9i with three screens and a 14-thread CPU burn: 60 fps with no frame over 20 ms, against 7-43 late
// frames and 33-100 ms stalls without. cage gets the same slice from os/leafdeck-session; the CPU weight of the session
// and of Leafdeck's own scope is the systemd drop-ins in os/. Set with chrt (util-linux 2.41+); an older one is skipped.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const SLICE_NS = 500000;
const EVERY_MS = 10000; // new helpers (a site's renderer) appear at any time
const done = new Set(); // thread ids already set
let supported = null;

/** Thread ids of Leafdeck's processes that haven't been set yet (zygotes aren't in getAppMetrics; they're idle). */
function newThreads() {
  const out = [];
  for (const pid of new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)])) {
    let names;
    try {
      names = fs.readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const name of names) {
      const tid = Number(name);
      if (tid && !done.has(tid)) out.push(tid);
    }
  }
  return out;
}

function apply() {
  if (supported === false) return;
  const list = newThreads();
  if (!list.length) return;
  list.forEach((tid) => done.add(tid));
  // One shell for the batch; a thread that ended in between is skipped.
  execFile(
    '/bin/sh',
    ['-c', 'for t; do chrt -o -T "$SLICE" -p 0 "$t" 2>/dev/null; done', 'sh', ...list.map(String)],
    { env: { ...process.env, SLICE: String(SLICE_NS) } },
    () => {},
  );
}

function init() {
  if (process.platform !== 'linux') return;
  execFile('chrt', ['-o', '-T', String(SLICE_NS), '-p', '0', String(process.pid)], (err) => {
    supported = !err;
    if (err) return console.warn('sched: chrt can’t set a slice (util-linux 2.41+ needed):', err.message.split('\n')[0]);
    apply();
    setInterval(apply, EVERY_MS).unref();
  });
}

module.exports = { init };
