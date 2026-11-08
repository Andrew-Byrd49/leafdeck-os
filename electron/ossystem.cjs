// Leafdeck OS: the system controls a desktop needs, for the Leafdeck session on Linux (see LEAFDECK_SESSION in main.cjs).
// Power through systemd/logind, sound through PipeWire (wpctl), brightness through brightnessctl, networking through
// NetworkManager (nmcli), battery from /sys. Every call degrades gracefully: a machine without a battery, a backlight or
// Wi-Fi simply reports null for that part, and the UI hides it.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const run = (cmd, args, { timeout = 8000, input } = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
      else resolve(String(stdout));
    });
    if (input != null) {
      child.stdin.end(input);
    }
  });
const quiet = (p) => p.catch(() => null);

/* nmcli's terse mode separates fields with ':' and escapes literal ':' as '\:'. */
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) cur += line[++i];
    else if (line[i] === ':') {
      out.push(cur);
      cur = '';
    } else cur += line[i];
  }
  out.push(cur);
  return out;
}

/* ---------------- battery ---------------- */

/** The battery and the charger in /sys, with a reader for their files; null without a battery. */
function supply() {
  const root = '/sys/class/power_supply';
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const read = (n, f) => {
    try {
      return fs.readFileSync(path.join(root, n, f), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const bat = names.find((n) => read(n, 'type') === 'Battery' && read(n, 'present') !== '0' && read(n, 'scope') !== 'Device'); // not a pen's or a mouse's
  if (!bat) return null;
  return { root, bat, ac: names.find((n) => read(n, 'type') === 'Mains'), read: (f, n = bat) => read(n, f) };
}

function battery() {
  const s = supply();
  if (!s) return null;
  const status = s.read('status') || 'Unknown';
  return {
    percent: Math.max(0, Math.min(100, Number(s.read('capacity')) || 0)),
    charging: status === 'Charging' || status === 'Full' || s.read('online', s.ac) === '1',
    status,
  };
}

/** More about the battery, for Settings → Power: time left, health, charge cycles, and how it charges (a laptop's
    "conservation" modes, as charge_types, or a charge limit, as charge_control_end_threshold; both need root to change). */
function batteryDetails() {
  const s = supply();
  if (!s) return null;
  const num = (f) => (s.read(f) == null || s.read(f) === '' ? null : Number(s.read(f)));
  // Energy (µWh, µW) on most laptops; charge (µAh, µA) on some. Either way the ratios are the same.
  const now = num('energy_now') ?? num('charge_now');
  const full = num('energy_full') ?? num('charge_full');
  const design = num('energy_full_design') ?? num('charge_full_design');
  const rate = Math.abs(num('power_now') ?? num('current_now') ?? 0);
  const b = battery();
  let minutes = null;
  if (rate > 0 && now != null && b.status === 'Discharging') minutes = Math.round((now / rate) * 60);
  else if (rate > 0 && now != null && full && b.status === 'Charging') minutes = Math.round(((full - now) / rate) * 60);
  const types = s.read('charge_types'); // "[Fast] Standard Long_Life"
  const limit = num('charge_control_end_threshold');
  return {
    ...b,
    minutes: minutes != null && minutes < 48 * 60 ? minutes : null,
    watts: num('power_now') != null ? Math.round(num('power_now') / 1e5) / 10 : null,
    health: full && design ? Math.min(100, Math.round((full / design) * 100)) : null,
    cycles: num('cycle_count') || null,
    chargeModes: types ? types.split(/\s+/).map((t) => t.replace(/[[\]]/g, '')) : null,
    chargeMode: types ? (types.match(/\[([^\]]+)\]/) || [])[1] || null : null,
    chargeLimit: Number.isFinite(limit) ? limit : null,
  };
}

/* ---------------- sound ---------------- */

async function sound() {
  const out = await quiet(run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 3000 }));
  const m = out && out.match(/Volume:\s*([\d.]+)(\s*\[MUTED\])?/);
  if (!m) return null;
  return { level: Math.round(Number(m[1]) * 100), muted: !!m[2] };
}
async function setVolume(level) {
  const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  await run('wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', `${v}%`]);
  if (v > 0) await quiet(run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', '0']));
  return sound();
}
async function setMuted(muted) {
  await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0']);
  return sound();
}

// Where sound goes and comes from: PipeWire's outputs (sinks) and inputs (sources), from pw-dump. Picking one makes it
// WirePlumber's default (remembered), and what's playing moves to it. Hidden: a device a filter plays into (the speakers
// behind their EQ: you pick the filter), and an output with nothing plugged in (the HDMI ports without a display).
function pwDump() {
  return new Promise((resolve, reject) =>
    execFile('pw-dump', [], { timeout: 4000, maxBuffer: 64 << 20 }, (err, out) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    }),
  );
}
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function audioDevice(p) {
  const name = String(p['node.name'] || '');
  const output = p['media.class'] === 'Audio/Sink';
  const desc = tidy(p['node.description'] || p['node.nick'] || name);
  if (name.startsWith('raop_sink.') || p['sess.media'] === 'raop') return { kind: 'airplay', label: desc };
  if (p['device.api'] === 'bluez5' || /^bluez_/.test(name)) return { kind: 'bluetooth', label: desc };
  if (p['device.api'] === 'alsa') {
    const profile = String(p['device.profile.description'] || '');
    if (p['device.icon_name'] === 'video-display' || /HDMI|DisplayPort/i.test(profile)) {
      // The display's own name when one is plugged in (alsa.name is "L27q-4A" then, "HDMI 2" when not).
      const own = tidy(p['alsa.name']);
      return { kind: 'display', label: own && !/^(HDMI|DP|DisplayPort)\s*\d*$/i.test(own) ? own : desc };
    }
    if (/^speakers?$/i.test(profile)) return { kind: 'speakers', label: 'Built-in speakers' };
    if (/microphone|^mic/i.test(profile)) return { kind: 'mic', label: /digital|internal/i.test(profile) ? 'Built-in microphone' : profile };
    if (/headphone/i.test(profile)) return { kind: 'headphones', label: 'Headphones' };
    return { kind: output ? 'speakers' : 'mic', label: profile || desc };
  }
  return { kind: output ? 'speakers' : 'mic', label: desc };
}

const KIND_ORDER = ['speakers', 'headphones', 'mic', 'display', 'bluetooth', 'airplay'];
async function audioDevices() {
  let objs;
  try {
    objs = await pwDump();
  } catch {
    return null;
  }
  const props = (o) => o.info?.props || {};
  const defaults = {};
  for (const o of objs) {
    if (o.type !== 'PipeWire:Interface:Metadata' || o.props?.['metadata.name'] !== 'default') continue;
    for (const m of o.metadata || []) {
      if (m.key === 'default.audio.sink') defaults.sink = m.value?.name;
      if (m.key === 'default.audio.source') defaults.source = m.value?.name;
    }
  }
  const behind = new Set();
  const routes = new Map();
  for (const o of objs) {
    const p = props(o);
    if (p['node.link-group'] && /^Stream\/(Output|Input)\/Audio$/.test(p['media.class']) && p['target.object']) behind.add(String(p['target.object']));
    if (o.type === 'PipeWire:Interface:Device') routes.set(o.id, o.info?.params?.EnumRoute || []);
  }
  const unplugged = (p) => {
    const r = (routes.get(Number(p['device.id'])) || []).filter((x) => x.devices?.includes(Number(p['card.profile.device'])));
    return r.length > 0 && r.every((x) => x.available === 'no');
  };
  const outputs = [];
  const inputs = [];
  for (const o of objs) {
    const p = props(o);
    const cls = p['media.class'];
    if (o.type !== 'PipeWire:Interface:Node' || (cls !== 'Audio/Sink' && cls !== 'Audio/Source')) continue;
    const name = String(p['node.name'] || '');
    if (!name || behind.has(name) || unplugged(p)) continue;
    const output = cls === 'Audio/Sink';
    (output ? outputs : inputs).push({ name, ...audioDevice(p), active: name === defaults[output ? 'sink' : 'source'] });
  }
  const order = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label);
  return { outputs: outputs.sort(order), inputs: inputs.sort(order), input: await micLevel() };
}
async function setAudioDevice(name) {
  const node = (await pwDump()).find((o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === name && /^Audio\/(Sink|Source)$/.test(o.info.props['media.class']));
  if (!node) throw new Error('That device isn’t there anymore');
  await run('wpctl', ['set-default', String(node.id)]);
  return audioDevices();
}

// The microphone in use: its level and whether it's muted.
async function micLevel() {
  const out = await quiet(run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@'], { timeout: 3000 }));
  const m = out && out.match(/Volume:\s*([\d.]+)(\s*\[MUTED\])?/);
  return m ? { level: Math.round(Number(m[1]) * 100), muted: !!m[2] } : null;
}
async function setMicLevel(level) {
  const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  await run('wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SOURCE@', `${v}%`]);
  if (v > 0) await quiet(run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', '0']));
  return micLevel();
}
async function setMicMuted(muted) {
  await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', muted ? '1' : '0']);
  return micLevel();
}

/* ---------------- brightness ---------------- */

// A laptop can have one backlight per built-in panel (the Yoga Book 9 has two). Each backlight belongs to a display
// connector (its /sys path runs through card1-eDP-1), so the slider sets the panels that are showing Leafdeck, and is
// hidden when only an external display is in use.
function backlights() {
  const root = '/sys/class/backlight';
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.map((name) => {
    let output = null;
    try {
      output = (fs.realpathSync(path.join(root, name)).match(/\/card\d+-([A-Za-z]+-\d+)(?:\/|$)/) || [])[1] || null;
    } catch {}
    return { name, output };
  });
}

/** The backlights of the built-in panels in use; all of them when it can't tell which panel is which. */
async function activeBacklights() {
  const all = backlights();
  if (!all.length) return [];
  if (all.some((b) => !b.output)) return all;
  const on = new Set((await outputs()).filter((o) => o.enabled).map((o) => o.name));
  return on.size ? all.filter((b) => on.has(b.output)) : all;
}

async function brightness() {
  const [first] = await activeBacklights();
  if (!first) return null;
  const out = await quiet(run('brightnessctl', ['-m', '-d', first.name], { timeout: 3000 }));
  const parts = out && out.trim().split(',');
  if (!parts || parts.length < 4) return null;
  return { percent: Number(String(parts[3]).replace('%', '')) || 0 };
}
async function setBrightness(percent, { off = false } = {}) {
  const v = Math.max(off ? 0 : 5, Math.min(100, Math.round(Number(percent) || 0))); // never all the way to black, unless turning the screen off
  const list = await activeBacklights();
  await Promise.all(list.map((b) => run('brightnessctl', ['-q', '-d', b.name, 'set', `${v}%`])));
  return brightness();
}

/* ---------------- network ---------------- */

async function network() {
  const out = await quiet(run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'], { timeout: 4000 }));
  if (out == null) return null;
  const devices = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [device, type, state, connection] = splitTerse(l);
      return { device, type, state, connection };
    })
    .filter((d) => d.type === 'wifi' || d.type === 'ethernet');
  const wifiDev = devices.find((d) => d.type === 'wifi');
  const radio = wifiDev ? (await quiet(run('nmcli', ['radio', 'wifi'], { timeout: 3000 })))?.trim() === 'enabled' : null;
  const connected = devices.find((d) => d.state === 'connected');
  let signal = null;
  if (connected?.type === 'wifi') {
    const list = await quiet(run('nmcli', ['-t', '-f', 'ACTIVE,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'no'], { timeout: 4000 }));
    const active = list?.split('\n').map(splitTerse).find((f) => f[0] === 'yes');
    signal = active ? Number(active[1]) || null : null;
  }
  // A network with a sign-in page (a hotel's, a café's): NetworkManager's connectivity check lands on it.
  const portal = connected ? (await quiet(run('nmcli', ['-t', 'networking', 'connectivity'], { timeout: 3000 })))?.trim() === 'portal' : false;
  return {
    connected: !!connected,
    kind: connected?.type || null, // 'wifi' | 'ethernet' | null
    name: connected?.connection || null,
    signal,
    portal,
    portalUrl: portal ? await portalUrl() : null,
    wifi: wifiDev ? { device: wifiDev.device, enabled: radio } : null,
  };
}

/** The address NetworkManager checks the internet with: opening it shows the network's sign-in page. */
async function portalUrl() {
  const out = await quiet(
    run('busctl', ['get-property', 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager', 'ConnectivityCheckUri'], { timeout: 3000 }),
  );
  const m = /^s "(https?:\/\/[^"]+)"/.exec(out?.trim() || '');
  return m ? m[1] : 'http://neverssl.com/';
}

async function wifiList() {
  const out = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], { timeout: 15000 });
  const seen = new Map();
  let hidden = null; // networks that don't broadcast their name: one entry, where you type the name
  for (const line of out.split('\n').filter(Boolean)) {
    const [inUse, ssid, signal, security] = splitTerse(line);
    // enterprise: a work or school network, where you sign in with a username as well (WPA-Enterprise, 802.1X)
    const net = { ssid, signal: Number(signal) || 0, secure: !!security && security !== '--', enterprise: /802\.1X/i.test(security || ''), active: inUse === '*' };
    if (!ssid) {
      if (!hidden || net.signal > hidden.signal) hidden = { ...net, hidden: true, active: false };
      continue;
    }
    const prev = seen.get(ssid);
    if (!prev || net.active || net.signal > prev.signal) seen.set(ssid, { ...net, active: net.active || prev?.active || false });
  }
  const list = [...seen.values()].sort((a, b) => b.active - a.active || b.signal - a.signal).slice(0, 30);
  return hidden ? [...list, hidden] : list;
}

/**
 * Connect to a Wi-Fi network. The password goes to nmcli on stdin (--ask, or a passwd-file), never on a command line.
 * hidden: the network doesn't broadcast its name, so nmcli looks for it by the name you typed. username: a work or
 * school network (WPA-Enterprise), signed in to with PEAP and MSCHAPv2, which nearly all of them use.
 */
async function wifiConnect(ssid, password, { hidden = false, username = '' } = {}) {
  const name = String(ssid || '').slice(0, 64);
  if (!name) throw new Error('Pick a network');
  const known = await quiet(run('nmcli', ['-t', '-f', 'NAME', 'connection', 'show'], { timeout: 4000 }));
  if (username) {
    if (known?.split('\n').includes(name)) await quiet(run('nmcli', ['connection', 'delete', 'id', name], { timeout: 8000 }));
    await run('nmcli', [
      'connection', 'add', 'type', 'wifi', 'con-name', name, 'ifname', '*', 'ssid', name,
      'wifi-sec.key-mgmt', 'wpa-eap', '802-1x.eap', 'peap', '802-1x.phase2-auth', 'mschapv2',
      '802-1x.identity', String(username).slice(0, 200), '802-1x.password-flags', '0', ...(hidden ? ['802-11-wireless.hidden', 'yes'] : []),
    ], { timeout: 8000 });
    await run('nmcli', ['connection', 'up', 'id', name, 'passwd-file', '/dev/stdin'], { timeout: 45000, input: `802-1x.password:${password}\n` });
  } else if (!password && known?.split('\n').includes(name)) {
    await run('nmcli', ['connection', 'up', 'id', name], { timeout: 30000 });
  } else {
    const args = ['--ask', 'device', 'wifi', 'connect', name, ...(hidden ? ['hidden', 'yes'] : [])];
    await run('nmcli', args, { timeout: 45000, input: password ? `${password}\n` : '\n' });
  }
  return network();
}

async function setWifi(enabled) {
  await run('nmcli', ['radio', 'wifi', enabled ? 'on' : 'off']);
  return network();
}

/* ---------------- Bluetooth ---------------- */

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
// bluetoothctl colors its output and redraws its prompt even when it isn't talking to a terminal.
const plain = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x01\x02\r]/g, '');

// Checked in /sys first: bluetoothctl can wait a long time when there's no adapter or the service isn't running.
function hasBluetooth() {
  try {
    return fs.readdirSync('/sys/class/bluetooth').some((n) => n.startsWith('hci'));
  } catch {
    return false;
  }
}

function parseDevices(out) {
  const seen = new Map();
  for (const m of plain(out).matchAll(/Device ([0-9A-F]{2}(?::[0-9A-F]{2}){5}) ([^\n]*)/gi)) {
    const mac = m[1].toUpperCase();
    const name = m[2].replace(/\s*(RSSI|TxPower|ManufacturerData|UUIDs|Connected|Paired|ServicesResolved|Trusted)\b.*$/, '').trim();
    if (name && !seen.has(mac)) seen.set(mac, { mac, name });
  }
  return [...seen.values()];
}

async function bluetooth() {
  if (!hasBluetooth()) return null;
  const out = await quiet(run('bluetoothctl', ['show'], { timeout: 3000 }));
  if (!out || /No default controller/i.test(out)) return null;
  const powered = /Powered:\s*yes/i.test(out);
  const connected = powered ? parseDevices(await quiet(run('bluetoothctl', ['devices', 'Connected'], { timeout: 3000 }))) : [];
  return { powered, connected: connected.map((d) => d.name) };
}

/** Known devices, plus whatever is nearby when `scan` is set (a 10-second search). */
async function btList(scan) {
  if (!hasBluetooth()) throw new Error('This computer has no Bluetooth');
  const found = scan ? await quiet(run('bluetoothctl', ['--timeout', '10', 'scan', 'on'], { timeout: 16000 })) : '';
  const [all, paired, connected] = await Promise.all(
    [['devices'], ['devices', 'Paired'], ['devices', 'Connected']].map((a) => quiet(run('bluetoothctl', a, { timeout: 4000 })))
  );
  const pairedSet = new Set(parseDevices(paired).map((d) => d.mac));
  const connSet = new Set(parseDevices(connected).map((d) => d.mac));
  const byMac = new Map([...parseDevices(found), ...parseDevices(all)].map((d) => [d.mac, d]));
  // Unnamed devices show their address as the name; nobody can tell those apart, so only show them once paired.
  const unnamed = (d) => d.name.replace(/-/g, ':').toUpperCase() === d.mac;
  return [...byMac.values()]
    .filter((d) => pairedSet.has(d.mac) || !unnamed(d))
    .map((d) => ({ ...d, paired: pairedSet.has(d.mac), connected: connSet.has(d.mac) }))
    .sort((a, b) => b.connected - a.connected || b.paired - a.paired || a.name.localeCompare(b.name))
    .slice(0, 40);
}

async function btPower(on) {
  if (!hasBluetooth()) throw new Error('This computer has no Bluetooth');
  let out = await run('bluetoothctl', ['power', on ? 'on' : 'off'], { timeout: 8000 }).catch((e) => e.message);
  // Turned off with the airplane-mode switch: unblock it, then try again.
  if (on && /Blocked|Failed/i.test(plain(out))) {
    await quiet(run('rfkill', ['unblock', 'bluetooth'], { timeout: 4000 }));
    out = await run('bluetoothctl', ['power', 'on'], { timeout: 8000 });
  }
  return bluetooth();
}

/**
 * Pair, trust and connect a device. Keyboards usually show a code to type on them: `onCode(code)` gets it, so Leafdeck
 * can show it. Done in one bluetoothctl session so its pairing agent is there to receive the code.
 */
function btPair(mac, onCode) {
  if (!MAC.test(String(mac))) return Promise.reject(new Error('Unknown device'));
  mac = String(mac).toUpperCase();
  return new Promise((resolve, reject) => {
    const child = spawn('bluetoothctl', [], { env: { ...process.env, LC_ALL: 'C' } });
    let text = '';
    let stage = 'find'; // find → pair → connect
    let done = false;
    const send = (line) => {
      try {
        child.stdin.write(`${line}\n`);
      } catch {}
    };
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(findTimer);
      send('scan off');
      send('quit');
      setTimeout(() => child.kill(), 1500);
      if (err) reject(err);
      else resolve(btList(false).catch(() => []));
    };
    const timer = setTimeout(() => finish(new Error('Pairing took too long. Put the device in pairing mode and try again.')), 75000);
    const startPair = () => {
      if (stage !== 'find') return;
      stage = 'pair';
      send('scan off');
      send(`pair ${mac}`);
    };
    // Pairing needs a recent sighting of the device: search until it shows up (or 8 seconds), then pair.
    const findTimer = setTimeout(startPair, 8000);
    child.on('error', (err) => finish(err));
    child.on('exit', () => finish(stage === 'connect' ? null : new Error('Bluetooth stopped unexpectedly')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      text += plain(chunk);
      // Each complete line once; then a question still waiting on the last line (it has no newline until answered).
      let nl;
      while (!done && (nl = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, nl);
        text = text.slice(nl + 1);
        handle(line);
      }
      if (!done && (/\(yes\/no\):?\s*$/i.test(text) || /Enter (PIN code|passkey)[^\n]*:\s*$/i.test(text))) {
        const line = text;
        text = '';
        handle(line);
      }
      if (text.length > 4000) text = text.slice(-1000);
    });
    function handle(line) {
      if (stage === 'find' && line.toUpperCase().includes(mac)) return startPair();
      let code = line.match(/(?:Passkey|PIN code):\s*(\d{4,6})/i);
      if (code && !/Enter/i.test(line)) return onCode?.(code[1]);
      if ((code = line.match(/Confirm passkey\s*(\d+)/i))) {
        onCode?.(code[1]);
        return send('yes');
      }
      if (/Request confirmation|Authorize service|\(yes\/no\)/i.test(line)) return send('yes');
      // Old keyboards that want a PIN typed here instead: offer the usual 0000.
      if (/Enter (PIN|passkey)/i.test(line)) return send('0000');
      if (stage === 'pair' && /Pairing successful|AlreadyExists/i.test(line)) {
        stage = 'connect';
        send(`trust ${mac}`);
        return send(`connect ${mac}`);
      }
      if (stage === 'pair' && /Failed to pair|not available/i.test(line)) {
        const why = /not available/i.test(line)
          ? 'Device not found. Put it in pairing mode and search again.'
          : /AuthenticationFailed|AuthenticationCanceled|AuthenticationRejected/i.test(line)
          ? 'The code wasn’t accepted. Try again, and type the code on the device, then press Enter.'
          : `Couldn’t pair: ${line.replace(/^.*Failed to pair:?\s*/i, '') || 'unknown error'}`;
        return finish(new Error(why));
      }
      // Paired and trusted: it reconnects on its own even if this first connection doesn't take.
      if (stage === 'connect' && /Connection successful|Failed to connect/i.test(line)) return finish(null);
    }
    send('agent KeyboardDisplay');
    send('default-agent');
    send('power on');
    send('scan on');
  });
}

async function btConnect(mac, connect) {
  if (!MAC.test(String(mac))) throw new Error('Unknown device');
  const out = plain(await run('bluetoothctl', [connect ? 'connect' : 'disconnect', String(mac)], { timeout: 20000 }).catch((e) => e.message));
  if (connect && !/Connection successful/i.test(out)) throw new Error('Couldn’t connect. Make sure the device is on and nearby.');
  return btList(false);
}

async function btForget(mac) {
  if (!MAC.test(String(mac))) throw new Error('Unknown device');
  await quiet(run('bluetoothctl', ['remove', String(mac)], { timeout: 8000 }));
  return btList(false);
}

/* ---------------- Restart into Windows ---------------- */

// A tiny root helper (os/leafdeck-boot-windows, installed with a sudo rule by os/setup-fedora.sh) sets the firmware's
// one-time "boot next" entry to Windows Boot Manager. The startup menu can't be used with a Bluetooth keyboard, so
// this is how you get to Windows from Leafdeck.
const BOOT_HELPER = '/usr/local/sbin/leafdeck-boot-windows';
let windowsCheck = null;
function hasWindows() {
  if (!windowsCheck) {
    windowsCheck = fs.existsSync(BOOT_HELPER)
      ? run('sudo', ['-n', BOOT_HELPER, '--check'], { timeout: 6000 }).then(() => true, () => false)
      : Promise.resolve(false);
  }
  return windowsCheck;
}

/* ---------------- screens ---------------- */

// Leafdeck is one full-screen window, and cage sizes it to every output in use, so the session decides which outputs are
// on and where they sit (through wlr-randr, wlr-output-management); the UI puts its menu bar, Dock and windows on them
// (setScreens in public/js/wm.js). Left alone, cage would stretch Leafdeck across every connected output side by side.
//
// Each set of connected screens has its own arrangement (Settings → Displays), saved under a key made of the screens'
// identities, so docking and undocking a laptop each come back as they were. Without a saved one: one screen, an
// external display when connected, else the built-in panel (or the choice from before Displays existed).
const INTERNAL = /^(eDP|LVDS|DSI)/i;
const TRANSFORMS = ['normal', '90', '180', '270'];

// wlr-randr's own notation for a mode: 2560x1440@59.951Hz.
const modeKey = (m) => `${m.width}x${m.height}@${Number(m.refresh || 0).toFixed(3)}Hz`;

/** The compositor's outputs: [{ id, name, description, internal, enabled, width, height, refresh, scale, transform, x, y,
 * dpi, modes }]. `id` stays the same for the same monitor (make, model and serial), whichever port it's plugged into. */
async function outputs() {
  const text = await quiet(run('wlr-randr', ['--json'], { timeout: 5000 }));
  if (!text) return [];
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = list.map((o) => {
    const all = Array.isArray(o.modes) ? o.modes : [];
    const mode = all.find((m) => m.current) || all.find((m) => m.preferred) || all[0] || {};
    const mm = Number(o.physical_size?.width) || 0;
    const seen = new Set();
    const modes = all
      .map((m) => ({ width: Number(m.width) || 0, height: Number(m.height) || 0, refresh: Number(m.refresh) || 0, preferred: !!m.preferred }))
      .filter((m) => m.width && m.height && !seen.has(modeKey(m)) && seen.add(modeKey(m)))
      .sort((a, b) => b.width * b.height - a.width * a.height || b.refresh - a.refresh);
    const name = String(o.name || '');
    return {
      id: String(o.description || name).replace(/\s*\([^()]*\)\s*$/, '').trim() || name,
      name,
      description: String(o.description || name).replace(/\s*\([^()]*\)\s*$/, '').trim() || name,
      internal: INTERNAL.test(name),
      enabled: !!o.enabled,
      width: Number(mode.width) || 0,
      height: Number(mode.height) || 0,
      refresh: Number(mode.refresh) || 0,
      scale: Number(o.scale) || 1,
      transform: TRANSFORMS.includes(String(o.transform)) ? String(o.transform) : 'normal',
      x: Number(o.position?.x) || 0,
      y: Number(o.position?.y) || 0,
      dpi: mm && mode.width ? Number(mode.width) / (mm / 25.4) : 0,
      modes,
    };
  });
  // Two identical monitors without serial numbers: tell them apart by port.
  for (const o of out) if (out.filter((x) => x.id === o.id).length > 1) o.id = `${o.id} (${o.name})`;
  return out;
}

/* Hardware the firmware doesn't fully describe, by computer model (DMI). */
const QUIRKS = [
  // Lenovo Yoga Book 9 (13IMU9): the top panel is mounted upside down.
  { model: /Yoga Book 9/i, outputs: { 'eDP-1': { transform: '180' } } },
];
let model = null;
function quirk(name) {
  if (model == null) {
    const read = (f) => {
      try {
        return fs.readFileSync(`/sys/class/dmi/id/${f}`, 'utf8').trim();
      } catch {
        return '';
      }
    };
    model = `${read('sys_vendor')} ${read('product_name')} ${read('product_version')}`;
  }
  return Object.assign({}, ...QUIRKS.filter((q) => q.model.test(model)).map((q) => q.outputs[name] || {}));
}

const autoScale = (o) => Number(process.env.LEAFDECK_SCREEN_SCALE) || (o.dpi >= 170 ? 2 : 1);
/** Width and height on the desktop, in layout pixels: turned sideways swaps them, scale divides them. */
function logicalSize(o, p) {
  const m = o.modes.find((x) => modeKey(x) === p.mode) || o;
  const side = p.transform === '90' || p.transform === '270';
  return { w: Math.round((side ? m.height : m.width) / p.scale), h: Math.round((side ? m.width : m.height) / p.scale) };
}
const preferredMode = (o) => modeKey(o.modes.find((m) => m.preferred) || o.modes[0] || o);

/** The key a set of connected screens is saved under. */
const profileKey = (list) => list.map((o) => o.id).sort().join(' + ');

/** Which outputs to use when nothing is saved: a choice from before Displays existed (an output name, or "built-in"
 * for every built-in panel, stacked: the Yoga Book 9's two screens), else $LEAFDECK_SCREEN, else one screen: an external
 * display when one is connected (a docked laptop, a monitor on a mini PC), otherwise the built-in panel. */
function chooseOutputs(list, choice) {
  const wanted = String(choice || process.env.LEAFDECK_SCREEN || 'auto');
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  if (wanted === 'built-in') {
    const panels = sorted.filter((o) => o.internal);
    if (panels.length) return panels;
  }
  const byName = list.find((o) => o.name === wanted);
  if (byName) return [byName];
  const one = sorted.find((o) => !o.internal) || sorted[0];
  return one ? [one] : [];
}

/** The arrangement to use when none is saved: the chosen outputs stacked top to bottom, at a scale that suits their
 * density (a 14" 2880x1800 panel gets 2x), turned the way the hardware needs. */
function autoProfile(list, choice) {
  const on = chooseOutputs(list, choice);
  const outputs = {};
  for (const o of list) outputs[o.id] = { on: on.includes(o), x: 0, y: 0, scale: autoScale(o), transform: quirk(o.name).transform || 'normal', mode: preferredMode(o) };
  let y = 0;
  for (const o of on) {
    outputs[o.id].y = y;
    y += logicalSize(o, outputs[o.id]).h;
  }
  return { main: on[0]?.id || list[0]?.id, outputs };
}

/** A saved (or edited) arrangement, checked against the screens actually connected. At least the main screen is on. */
function sanitize(profile, list) {
  const auto = autoProfile(list);
  const outputs = {};
  for (const o of list) {
    const p = profile?.outputs?.[o.id] || { ...auto.outputs[o.id], on: false };
    const mode = o.modes.some((m) => modeKey(m) === p.mode) ? p.mode : preferredMode(o);
    outputs[o.id] = {
      on: !!p.on,
      x: Math.round(Number(p.x) || 0),
      y: Math.round(Number(p.y) || 0),
      scale: Math.min(3, Math.max(0.5, Math.round((Number(p.scale) || 1) * 4) / 4)),
      transform: TRANSFORMS.includes(String(p.transform)) ? String(p.transform) : 'normal',
      mode,
    };
  }
  let main = list.find((o) => o.id === profile?.main && outputs[o.id].on)?.id || list.find((o) => outputs[o.id].on)?.id;
  if (!main) {
    main = auto.main;
    outputs[main] = { ...auto.outputs[main], on: true };
  }
  // The desktop starts at 0,0: the top-left corner of the screens in use.
  const on = list.filter((o) => outputs[o.id].on);
  const x0 = Math.min(...on.map((o) => outputs[o.id].x));
  const y0 = Math.min(...on.map((o) => outputs[o.id].y));
  for (const o of on) {
    outputs[o.id].x -= x0;
    outputs[o.id].y -= y0;
  }
  return { main, outputs };
}

let mainScreen = null; // the id of the screen with the menu bar and the Dock

/** Set the outputs to an arrangement. Idempotent: only what differs is changed. */
async function applyProfile(list, profile) {
  const args = [];
  for (const o of list) {
    const p = profile.outputs[o.id];
    if (!p.on) {
      if (o.enabled) args.push('--output', o.name, '--off');
      continue;
    }
    const a = [];
    if (!o.enabled) a.push('--on');
    if (!o.enabled || modeKey(o) !== p.mode) a.push('--mode', p.mode);
    if (!o.enabled || o.x !== p.x || o.y !== p.y) a.push('--pos', `${p.x},${p.y}`);
    if (!o.enabled || o.scale !== p.scale) a.push('--scale', String(p.scale));
    if (!o.enabled || o.transform !== p.transform) a.push('--transform', p.transform);
    if (a.length) args.push('--output', o.name, ...a);
  }
  if (args.length) await run('wlr-randr', args, { timeout: 8000 });
  mainScreen = profile.main;
}

/** Arrange the screens: the saved arrangement for the screens connected now, else the automatic one. `settings` is
 * Leafdeck OS's settings ({ displays: { [key]: arrangement }, screen }). Returns the arrangement used. */
async function applyScreens(settings = {}) {
  const list = await outputs();
  if (!list.length) return null;
  const saved = settings.displays?.[profileKey(list)];
  const profile = saved ? sanitize(saved, list) : autoProfile(list, settings.screen);
  await applyProfile(list, profile);
  return profile;
}

/** For Settings → Displays: the screens, and the arrangement in use (saved or automatic) under its key. */
async function displays(settings = {}) {
  const list = await outputs();
  const key = profileKey(list);
  const saved = settings.displays?.[key];
  return { key, saved: !!saved, profile: saved ? sanitize(saved, list) : autoProfile(list, settings.screen), outputs: list };
}

/** Try an arrangement from Settings (not saved here: main.cjs keeps it only once it's confirmed). */
async function setDisplays(profile) {
  const list = await outputs();
  const clean = sanitize(profile, list);
  await applyProfile(list, clean);
  return { key: profileKey(list), profile: clean };
}

/** Where each screen in use sits, in layout pixels from the top left of Leafdeck's window: the main screen first. */
async function layout() {
  const on = (await outputs()).filter((o) => o.enabled && o.width && o.height);
  if (!on.length) return [];
  const x0 = Math.min(...on.map((o) => o.x));
  const y0 = Math.min(...on.map((o) => o.y));
  const main = on.find((o) => o.id === mainScreen) || on[0];
  return on
    .map((o) => {
      const { w, h } = logicalSize(o, { mode: modeKey(o), scale: o.scale, transform: o.transform });
      return { name: o.name, internal: o.internal, main: o === main, x: o.x - x0, y: o.y - y0, w, h };
    })
    .sort((a, b) => b.main - a.main || a.y - b.y || a.x - b.x);
}

/* ---------------- power ---------------- */

const POWER = { shutdown: 'poweroff', restart: 'reboot', sleep: 'suspend', hibernate: 'hibernate' };
async function power(action) {
  if (action === 'windows') {
    if (!(await hasWindows())) throw new Error('Windows isn’t set up as a startup choice on this computer');
    await run('sudo', ['-n', BOOT_HELPER], { timeout: 10000 });
    spawn('systemctl', ['reboot'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  const verb = POWER[action];
  if (!verb) throw new Error('Unknown power action');
  // logind lets the active local session do these without a password.
  spawn('systemctl', [verb], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

/* Screenshots: taken through the compositor (grim), kept in ~/Pictures/Screenshots as "Screenshot 2026-10-23 at
   19.04.31.png". Selecting an area (public/js/snip.js) works on a frozen capture of the whole screen, so what's chosen is
   exactly what was on screen when Print Screen was pressed. */
function shotFile() {
  const dir = path.join(require('node:os').homedir(), 'Pictures', 'Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  let file = path.join(dir, `${base}.png`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).png`);
  return file;
}

/** The whole screen, saved. */
async function screenshot() {
  const file = shotFile();
  await run('grim', [file], { timeout: 10000 });
  return file;
}

/** The whole screen as it is right now, in a private temporary file (the runtime folder only you can read). Uncompressed
    (-l 0): it's only read once, from memory, and compressing a big screen is most of the wait (1.5 s vs 0.3 s at 2904×3600). */
async function captureScreen() {
  const file = path.join(process.env.XDG_RUNTIME_DIR || require('node:os').tmpdir(), `leafdeck-snip-${Date.now()}.png`);
  await run('grim', ['-l', '0', file], { timeout: 10000 });
  return file;
}

/** Save a screenshot's PNG (an area chosen from a capture). */
function saveScreenshot(png) {
  const file = shotFile();
  fs.writeFileSync(file, png);
  return file;
}

/** About this computer, for Settings. */
async function about() {
  const os = require('node:os');
  const rel = (() => {
    try {
      const t = fs.readFileSync('/etc/os-release', 'utf8');
      return (t.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || 'Linux';
    } catch {
      return 'Linux';
    }
  })();
  const df = await quiet(run('df', ['-B1', '--output=size,avail', os.homedir()], { timeout: 3000 }));
  const [size, avail] = (df?.trim().split('\n')[1] || '').trim().split(/\s+/).map(Number);
  const cpu = os.cpus()[0]?.model?.replace(/\s+/g, ' ').trim() || '';
  return {
    host: os.hostname(),
    user: os.userInfo().username,
    system: rel,
    kernel: os.release(),
    cpu,
    cores: os.cpus().length,
    memory: os.totalmem(),
    disk: size ? { size, avail } : null,
    uptime: os.uptime(),
  };
}

async function status() {
  const [net, snd, light, bt, windows] = await Promise.all([network(), sound(), brightness(), bluetooth(), hasWindows()]);
  return { battery: battery(), network: net, sound: snd, brightness: light, bluetooth: bt, windows };
}

module.exports = {
  status, battery, batteryDetails, sound, setVolume, setMuted, audioDevices, setAudioDevice, setMicLevel, setMicMuted, brightness, setBrightness, wifiList, wifiConnect, setWifi, power, screenshot, captureScreen, saveScreenshot, about,
  btList, btPower, btPair, btConnect, btForget, outputs, applyScreens, layout, displays, setDisplays,
};
