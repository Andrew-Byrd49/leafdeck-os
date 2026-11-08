'use strict';
// Leafdeck OS: keys the kernel never turns into key events. The Lenovo Yoga Book 9 Bluetooth keyboard sends Fn+PrtSc
// as consumer report 03 10 00 32, a usage outside the range its descriptor declares, so the kernel drops it. Here the
// keyboard's hidraw node is read directly (readable through os/70-leafdeck-keys.rules) and that report starts a
// screenshot. Plain PrtSc is an ordinary Print Screen key and goes through before-input-event as before.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const KEYBOARDS = [{ id: 'HID_ID=0005:000017EF:0000616A', reports: { snip: Buffer.from('03100032', 'hex') } }];

function findNodes() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync('/sys/class/hidraw');
  } catch {
    return out;
  }
  for (const name of names) {
    let uevent = '';
    try {
      uevent = fs.readFileSync(path.join('/sys/class/hidraw', name, 'device', 'uevent'), 'utf8');
    } catch {
      continue;
    }
    const kb = KEYBOARDS.find((k) => uevent.split('\n').includes(k.id));
    if (kb) out.push({ node: `/dev/${name}`, kb });
  }
  return out;
}

/** Watch the keyboards this knows about; onKey('snip') when one asks for a screenshot. Rescans for reconnects. */
function init({ onKey }) {
  const readers = new Map(); // node -> child
  const warned = new Set();
  const scan = () => {
    for (const { node, kb } of findNodes()) {
      if (readers.has(node)) continue;
      try {
        fs.accessSync(node, fs.constants.R_OK);
      } catch {
        if (!warned.has(node)) console.warn(`oskeys: can't read ${node}; install os/70-leafdeck-keys.rules`);
        warned.add(node);
        continue;
      }
      // cat does the blocking reads, so none of Node's thread pool waits on the keyboard. Each read is one report;
      // under load several can arrive in one chunk, hence the search.
      const child = spawn('cat', [node], { stdio: ['ignore', 'pipe', 'ignore'] });
      readers.set(node, child);
      child.stdout.on('data', (chunk) => {
        for (const [name, bytes] of Object.entries(kb.reports)) if (chunk.includes(bytes)) onKey(name);
      });
      const gone = () => readers.get(node) === child && readers.delete(node);
      child.on('exit', gone);
      child.on('error', gone);
    }
  };
  scan();
  setInterval(scan, 5000).unref();
  return { stop: () => readers.forEach((c) => c.kill()) };
}

module.exports = { init };
