// What a site asks for that needs the person's choice, answered in Leafdeck's UI (public/js/pageui.js) on Linux:
// signing in to a site that asks for a username and password (HTTP authentication), which certificate to identify
// yourself with, which device a site may use (WebHID, WebUSB, Web Serial, Web Bluetooth) and a Bluetooth pairing
// code, and which window or screen to share in a video call. Without these, Electron quietly refuses (or, for
// certificates, picks the first one). Windows keeps Electron's behavior as it was.
const { app, webContents } = require('electron');
const { hostOf, originOf } = require('./common.cjs');

let host = () => null; // the Leafdeck window
let isOurWebview = () => false;
const pending = new Map(); // id -> { answer(value), contents }
let seq = 0;

function send(channel, payload) {
  const win = host();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Ask the UI; `answer` gets the value it sends back (null when dismissed, or when the page goes away first). */
function ask(kind, contents, data, answer) {
  const id = ++seq;
  const entry = { contents, answer };
  pending.set(id, entry);
  const gone = () => {
    if (!pending.has(id)) return;
    send('shell:site-prompt-cancel', { id });
    settle(id, null);
  };
  contents.once('destroyed', gone);
  entry.unhook = () => contents.removeListener('destroyed', gone);
  send('shell:site-prompt', { id, kind, webContentsId: contents.id, origin: originOf(contents.getURL()) || '', ...data });
  return id;
}

function settle(id, value) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.unhook?.();
  try {
    entry.answer(value);
  } catch {
    /* the request already ended */
  }
}

/** The UI's answer to a prompt (site:answer). */
const answer = (id, value) => settle(Number(id), value ?? null);

const contentsOf = (frame) => {
  try {
    return frame ? webContents.fromFrame(frame) : null;
  } catch {
    return null;
  }
};
const hex = (n) => (typeof n === 'number' ? n.toString(16).padStart(4, '0') : '');

/* ---------------- devices ---------------- */

// The chooser on screen for each kind, so devices plugged in or found while it's open show up in it.
const choosers = new Map(); // kind -> { id, devices: Map(id -> choice), contents }
const LABELS = {
  hid: (d) => ({ value: d.deviceId, label: d.name || 'HID device', sub: `Vendor ${hex(d.vendorId)} · Product ${hex(d.productId)}` }),
  serial: (p) => ({ value: p.portId, label: p.displayName || p.portName || 'Serial port', sub: p.portName || '' }),
  usb: (d) => ({ value: d.deviceId, label: d.productName || 'USB device', sub: d.manufacturerName || `Vendor ${hex(d.vendorId)} · Product ${hex(d.productId)}` }),
  bluetooth: (d) => ({ value: d.deviceId, label: d.deviceName || 'Unknown device', sub: d.deviceId }),
};

function chooseDevice(kind, contents, list, callback) {
  const devices = new Map(list.map((d) => LABELS[kind](d)).map((c) => [c.value, c]));
  const chooser = { devices, contents, callback };
  choosers.set(kind, chooser);
  chooser.id = ask('device', contents, { device: kind, choices: [...devices.values()] }, (value) => {
    if (choosers.get(kind) === chooser) choosers.delete(kind);
    chooser.callback(typeof value === 'string' && devices.has(value) ? value : '');
  });
}

function deviceChanged(kind, added, device, contents) {
  const c = choosers.get(kind);
  if (!c || (contents && c.contents !== contents)) return;
  const choice = LABELS[kind](device);
  if (added) c.devices.set(choice.value, choice);
  else c.devices.delete(choice.value);
  send('shell:site-prompt-update', { id: c.id, choices: [...c.devices.values()] });
}

/* ---------------- screen sharing ---------------- */

async function shareScreen(request, callback) {
  const contents = contentsOf(request.frame);
  if (!contents || !isOurWebview(contents) || !request.videoRequested) return callback({});
  const win = host();
  const pages = webContents.getAllWebContents().filter((wc) => isOurWebview(wc) && !wc.isDestroyed() && wc.getURL());
  // A picture of each, to tell them apart; a page that doesn't draw (hidden, asleep) goes without one.
  const thumb = async (wc) => {
    try {
      const img = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(r, 1500))]);
      return img && !img.isEmpty() ? img.resize({ width: 240 }).toDataURL() : '';
    } catch {
      return '';
    }
  };
  const thumbs = await Promise.all([win.webContents, ...pages].map(thumb));
  const choices = [
    { value: 'screen', label: 'Your whole screen', sub: 'Everything in Leafdeck', thumb: thumbs[0] },
    ...pages.map((wc, i) => ({ value: String(wc.id), label: wc.getTitle() || hostOf(wc.getURL()), sub: wc === contents ? 'This page' : hostOf(wc.getURL()), thumb: thumbs[i + 1] })),
  ];
  ask('share-screen', contents, { choices, audio: !!request.audioRequested }, (value) => {
    const target = value === 'screen' ? win?.webContents : webContents.fromId(Number(value));
    if (!value || !target || target.isDestroyed() || (value !== 'screen' && !isOurWebview(target))) return callback({});
    try {
      // A page's own sound comes with it; the whole screen's sound can't be captured on Linux.
      callback({ video: target.mainFrame, ...(request.audioRequested && value !== 'screen' ? { audio: target.mainFrame } : {}) });
    } catch {
      callback({});
    }
  });
}

/* ---------------- wiring ---------------- */

function init(opts) {
  host = opts.host;
  isOurWebview = opts.isOurWebview;

  // A site (or a proxy) that asks for a username and password.
  app.on('login', (event, contents, details, authInfo, callback) => {
    if (!contents || !isOurWebview(contents)) return;
    event.preventDefault();
    const where = authInfo.port && ![80, 443].includes(authInfo.port) ? `${authInfo.host}:${authInfo.port}` : authInfo.host;
    ask('login', contents, { host: where, realm: authInfo.realm || '', proxy: !!authInfo.isProxy, secure: /^https:/i.test(details.url) }, (v) =>
      v && typeof v.username === 'string' ? callback(v.username, String(v.password ?? '')) : callback(),
    );
  });

  // Which certificate identifies you to a site that asks for one.
  app.on('select-client-certificate', (event, contents, url, list, callback) => {
    if (!isOurWebview(contents) || !list.length) return;
    event.preventDefault();
    const choices = list.map((c, i) => ({
      value: String(i),
      label: c.subjectName || 'Certificate',
      sub: `From ${c.issuerName || 'an unknown issuer'} · expires ${new Date(c.validExpiry * 1000).toLocaleDateString()}`,
    }));
    ask('certificate', contents, { host: hostOf(url), choices }, (v) => (v != null && list[Number(v)] ? callback(list[Number(v)]) : callback()));
  });
}

/** A site session (its partition): device choosers, Bluetooth pairing, screen sharing. */
function attach(s) {
  s.on('select-hid-device', (event, details, callback) => {
    const contents = contentsOf(details.frame);
    if (!isOurWebview(contents)) return;
    event.preventDefault();
    chooseDevice('hid', contents, details.deviceList, (id) => callback(id || null));
  });
  s.on('hid-device-added', (_e, d) => deviceChanged('hid', true, d.device, contentsOf(d.frame)));
  s.on('hid-device-removed', (_e, d) => deviceChanged('hid', false, d.device, contentsOf(d.frame)));
  s.on('select-usb-device', (event, details, callback) => {
    const contents = contentsOf(details.frame);
    if (!isOurWebview(contents)) return;
    event.preventDefault();
    chooseDevice('usb', contents, details.deviceList, (id) => (id ? callback(id) : callback()));
  });
  s.on('usb-device-added', (_e, device, contents) => deviceChanged('usb', true, device, contents));
  s.on('usb-device-removed', (_e, device, contents) => deviceChanged('usb', false, device, contents));
  s.on('select-serial-port', (event, portList, contents, callback) => {
    if (!isOurWebview(contents)) return;
    event.preventDefault();
    chooseDevice('serial', contents, portList, (id) => callback(id));
  });
  s.on('serial-port-added', (_e, port, contents) => deviceChanged('serial', true, port, contents));
  s.on('serial-port-removed', (_e, port, contents) => deviceChanged('serial', false, port, contents));

  s.setBluetoothPairingHandler((details, callback) => {
    const contents = contentsOf(details.frame);
    if (!isOurWebview(contents)) return callback({ confirmed: false });
    ask('bt-pair', contents, { pairing: details.pairingKind, pin: details.pin || '' }, (v) =>
      callback(details.pairingKind === 'providePin' ? (v?.pin ? { confirmed: true, pin: String(v.pin) } : { confirmed: false }) : { confirmed: !!v?.ok }),
    );
  });

  s.setDisplayMediaRequestHandler((request, callback) => shareScreen(request, callback).catch(() => callback({})));
}

/** A site's page: Web Bluetooth asks it (not the session) which device, again each time it finds more. */
function attachContents(contents) {
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    const c = choosers.get('bluetooth');
    if (c && c.contents === contents) {
      for (const d of devices) c.devices.set(d.deviceId, LABELS.bluetooth(d));
      c.callback = callback;
      send('shell:site-prompt-update', { id: c.id, choices: [...c.devices.values()] });
      return;
    }
    chooseDevice('bluetooth', contents, devices, callback);
  });
}

module.exports = { init, attach, attachContents, answer };
