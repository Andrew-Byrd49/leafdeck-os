// Leafdeck OS: system status in the menu bar, each icon with its own panel (Claude usage, network, sound, battery, power).
// Only in the Leafdeck OS session, where Leafdeck is the whole screen; the work happens in electron/ossystem.cjs.
import { shell } from './shell.js';
import { esc } from './util.js';
import { icon } from './icons.js';
import { toast, setScreens, screens, screensSettled, openApp, wins } from './wm.js';
import { store } from './store.js';
import { initKeyboard, toggleKeyboard, keyboardOpen } from './osk.js';
import { initSnip } from './snip.js';
import { openWebPage } from './apps/browser.js';
import { claimed } from './apps/terminal.js';

let st = { battery: null, network: null, sound: null, brightness: null, bluetooth: null, windows: false };
let audio = null; // the sound panel's outputs and inputs (shell.os.audioDevices)
let airplayOpen = false;
const trays = new Set(); // the tray in each menu bar (the main one's, and other screens' own)
let panel = null;
let view = 'power'; // what the open panel shows: the part for the tray icon you clicked ('network', 'sound', 'battery', 'power')
let nets = null; // Wi-Fi networks from the last scan
let scanning = false;
let asking = null; // the secured network we're asking a password for
let bt = null; // Bluetooth devices: known ones, plus nearby ones after a search
let btScanning = false;
let btPairing = null; // address of the device being paired
let btCode = null; // { mac, code }: the code to type on the keyboard being paired
let usage = null; // your Claude plan's limits (electron/claudeusage.cjs), or { signedIn: false }
let power = null; // power mode, hibernate and Keep awake (electron/ospower.cjs), loaded when the battery or power panel opens

const netIcon = (n) => (!n || !n.connected ? (n?.wifi && !n.wifi.enabled ? 'wifi-off' : 'wifi-off') : n.kind === 'ethernet' ? 'ethernet' : 'wifi');
const netLabel = (n) => (!n ? 'No network' : n.connected ? (n.kind === 'ethernet' ? 'Wired' : n.name || 'Wi-Fi') : n.wifi?.enabled === false ? 'Wi-Fi off' : 'Not connected');
const batteryText = (b) => (b ? `${b.percent}%` : '');

// Claude usage: how far into each limit, and when it starts over.
const usageLevel = (pct) => (pct >= 90 ? ' high' : pct >= 75 ? ' warn' : '');
function resetText(iso) {
  if (!iso) return '';
  const d = new Date(Math.round(Date.parse(iso) / 60e3) * 60e3); // the server says 3:59:59.98 for 4:00
  const ms = d - Date.now();
  if (ms <= 0) return 'Resets now';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ms < 5 * 3600e3) {
    const mins = Math.ceil(ms / 60e3);
    const h = Math.floor(mins / 60);
    return `Resets in ${h ? `${h} hr ` : ''}${mins % 60} min · ${time}`;
  }
  return `Resets ${dayAndTime(d)}`;
}
const dayAndTime = (d) => `${d.toDateString() === new Date().toDateString() ? 'today' : d.toLocaleDateString([], { weekday: 'long' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
// Where a weekly limit is heading: this week's average pace carried forward from `at`, when the numbers were read, so
// last known numbers stay fair offline. Nothing in the first 12 hours: the server's whole percents are too rough then.
const WEEK = 7 * 24 * 3600e3;
function projectionText(l, at) {
  const end = Date.parse(l.resetsAt);
  const elapsed = at - (end - WEEK);
  if (!l.weekly || !(elapsed >= 12 * 3600e3 && elapsed < WEEK) || l.percent <= 0 || l.percent >= 100) return null;
  const runsOut = at + ((100 - l.percent) * elapsed) / l.percent;
  if (runsOut >= end) return { text: `At this pace, you'll use about ${Math.round((l.percent * WEEK) / elapsed)}% by the reset` };
  if (runsOut <= Date.now()) return null;
  const quarter = 15 * 60e3;
  return { text: `At this pace, you'll run out ${dayAndTime(new Date(Math.round(runsOut / quarter) * quarter))}`, warn: true };
}
async function loadUsage(force) {
  try {
    usage = await shell.os.claudeUsage(force);
  } catch {
    if (!usage) return;
  }
  drawTray();
  if (panel && view === 'claude') drawPanel();
}

let warnedAt = 101;
function batteryWarning() {
  const b = st.battery;
  if (!b || b.charging) return void (warnedAt = 101);
  for (const level of [20, 10, 5]) {
    if (b.percent <= level && warnedAt > level) {
      warnedAt = level;
      toast(level === 5 ? `Battery at ${b.percent}%. Plug in now: the computer will sleep soon.` : `Battery at ${b.percent}%. Plug in soon.`, level <= 10 ? 'error' : '');
      break;
    }
  }
}

let portalShown = ''; // the network we last offered to sign in to
function signInToNetwork() {
  const url = st.network?.portalUrl;
  if (url) openWebPage(url);
}

async function refresh() {
  try {
    st = await shell.os.status();
  } catch {
    return;
  }
  // Just joined a network that wants you to sign in first: say so, once per network.
  if (st.network?.portal && portalShown !== st.network.name) {
    portalShown = st.network.name;
    toast(`${st.network.name || 'This network'} needs you to sign in`, '', { label: 'Sign in', act: signInToNetwork });
  } else if (!st.network?.portal) portalShown = '';
  batteryWarning();
  loadUsage(false);
  drawTray();
  if (panel && !panel.querySelector('.os-pass')?.contains(document.activeElement)) drawPanel(); // not while you type a password
}

// The keyboard button is for touch screens (the keyboard also comes up on its own when you tap a text field).
const hasTouch = navigator.maxTouchPoints > 0;

const trayShown = new WeakMap(); // per tray: the HTML it's showing

function drawTray() {
  for (const t of trays) if (!t.isConnected) trays.delete(t);
  if (!trays.size) return;
  const b = st.battery;
  const s = st.sound;
  const session = usage?.limits?.find((l) => l.kind === 'session') || usage?.limits?.[0];
  const worst = Math.max(0, ...(usage?.limits || []).map((l) => l.percent));
  const html = `
    ${usage?.signedIn ? `<button class="os-ti os-cu-ti${usageLevel(worst)}" data-os="panel" data-view="claude" title="${usage.expired ? 'Claude usage: open Claude Code to sign in again' : session ? `Claude: ${session.percent}% of your ${session.kind === 'session' ? 'session' : 'limit'} used` : 'Claude usage'}"><span class="os-claude" aria-hidden="true"></span>${session && !usage.expired ? `${session.percent}%` : ''}</button>` : ''}
    <button class="os-ti" data-os="panel" data-view="network" title="${esc(netLabel(st.network))}">${icon(netIcon(st.network), 15)}</button>
    ${s ? `<button class="os-ti" data-os="panel" data-view="sound" title="Volume ${s.muted ? 'muted' : s.level + '%'}">${icon(s.muted || s.level === 0 ? 'volume-x' : 'volume', 15)}</button>` : ''}
    ${hasTouch ? `<button class="os-ti${keyboardOpen() ? ' on' : ''}" data-os="keyboard" title="On-screen keyboard" aria-label="On-screen keyboard">${icon('keyboard', 15)}</button>` : ''}
    ${b ? `<button class="os-ti os-bat${b.charging ? ' charging' : ''}${b.percent <= 15 && !b.charging ? ' low' : ''}" data-os="panel" data-view="battery" title="Battery ${b.percent}%${b.charging ? ', charging' : ''}"><span class="os-battw"><span class="os-batt"><i style="width:${b.percent}%"></i></span>${b.charging ? '<svg class="os-bolt" viewBox="0 0 10 14" aria-hidden="true"><path d="M6 0.5 1 8h3.2L3.6 13.5 9 5.8H5.6z"/></svg>' : ''}</span>${batteryText(b)}</button>` : ''}
    <button class="os-ti os-power" data-os="panel" data-view="power" title="Power" aria-label="Power">${icon('power', 15)}</button>`;
  // Only what changed: the status comes in every few seconds, mostly the same, and a repaint here redraws the box around
  // it and everything else changing on the other screens (public/js/steady.js).
  for (const t of trays) {
    if (trayShown.get(t) === html) continue;
    trayShown.set(t, html);
    t.innerHTML = html;
  }
}

function slider(kind, value, iconName, label, disabled) {
  return `<div class="os-row os-slider"><button class="os-ib" data-os="${kind}-icon" title="${esc(label)}">${icon(iconName, 16)}</button>
    <input type="range" min="0" max="100" value="${value}" data-os="${kind}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}><span class="os-val">${value}%</span></div>`;
}

// A network that doesn't broadcast its name (asking === HIDDEN) shows as "Hidden network": you type its name and password.
const HIDDEN = '\0hidden';
function netRow(w) {
  if (w.hidden) {
    return `<li><button class="os-net hidden" data-os="net" data-hidden="1">
      ${icon('wifi', 14)}<span>Hidden network</span><small>${w.secure ? '' : 'Open'}</small>${w.secure ? icon('lock', 12) : ''}</button>
      ${asking === HIDDEN ? `<form class="os-pass os-pass-hidden" data-hidden="1"><input name="ssid" placeholder="Network name" autocomplete="off" spellcheck="false" required>
        <input name="password" type="password" placeholder="Password${w.secure ? '' : ' (if it has one)'}" autocomplete="off" ${w.secure ? 'required' : ''}><button class="btn small primary">Join</button></form>` : ''}</li>`;
  }
  return `<li><button class="os-net${w.active ? ' on' : ''}" data-os="net" data-ssid="${esc(w.ssid)}" data-secure="${w.secure ? 1 : 0}">
      ${icon('wifi', 14)}<span>${esc(w.ssid)}</span><small>${w.active ? 'Connected' : w.secure ? '' : 'Open'}</small>${w.secure ? icon('lock', 12) : ''}</button>
      ${
        asking !== w.ssid
          ? ''
          : w.enterprise // a work or school network: you sign in with your account there
            ? `<form class="os-pass os-pass-hidden" data-ssid="${esc(w.ssid)}" data-enterprise="1"><input name="username" placeholder="Username" autocomplete="off" spellcheck="false" required>
              <input name="password" type="password" placeholder="Password" autocomplete="off" required><button class="btn small primary">Join</button></form>`
            : `<form class="os-pass" data-ssid="${esc(w.ssid)}"><input type="password" placeholder="Password for ${esc(w.ssid)}" autocomplete="off" required><button class="btn small primary">Join</button></form>`
      }</li>`;
}

function drawPanel() {
  const n = st.network;
  const s = st.sound;
  const b = st.brightness;
  const bat = st.battery;
  const wifiOn = n?.wifi?.enabled;
  const wifiTile = `<button class="os-tile${n?.connected ? ' on' : ''}" data-os="${n?.wifi ? 'wifi-toggle' : 'none'}">
        ${icon(netIcon(n), 18)}<span><b>${n?.kind === 'ethernet' ? 'Network' : 'Wi-Fi'}</b><small>${esc(netLabel(n))}</small></span></button>`;
  const batTile = `<button class="os-tile${bat?.charging ? ' on' : ''}" data-os="none" ${bat ? '' : 'hidden'}>
        ${icon('battery', 18)}<span><b>Battery</b><small>${bat ? `${bat.percent}% · ${bat.charging ? 'Charging' : 'On battery'}` : ''}</small></span></button>`;
  const volume = s ? slider('volume', s.muted ? 0 : s.level, s.muted || s.level === 0 ? 'volume-x' : 'volume', s.muted ? 'Unmute' : 'Mute') : `<div class="os-row os-muted">${icon('volume-x', 16)}<span>No sound output</span></div>`;
  const wifiList = n?.wifi ? `<div class="os-sec">
      <div class="os-sec-head"><b>Wi-Fi networks</b>${wifiOn ? `<button class="os-link" data-os="scan">${scanning ? 'Scanning…' : nets ? 'Rescan' : 'Show networks'}</button>` : '<small>Wi-Fi is off</small>'}</div>
      ${wifiOn && nets ? `<ul class="os-nets">${nets.length ? nets.map(netRow).join('') : '<li class="os-empty">No networks found</li>'}</ul>` : ''}
    </div>` : '';
  panel.dataset.view = view;
  // A network with a sign-in page (a hotel's, a café's): until you sign in there, nothing else gets through.
  const portal = n?.portal
    ? `<div class="os-row os-portal">${icon('globe', 16)}<span>${esc(n.name || 'This network')} needs you to sign in</span><button class="btn small primary" data-os="portal">Sign in</button></div>`
    : '';
  if (view === 'claude') panel.innerHTML = usagePanel();
  else if (view === 'network') panel.innerHTML = `<div class="os-tiles">${wifiTile}${btTile()}</div>${portal}${wifiList}${btSection()}`;
  else if (view === 'sound') panel.innerHTML = volume + audioSections();
  else if (view === 'battery') panel.innerHTML = `<div class="os-tiles">${batTile}${awakeTile()}</div>${b ? slider('brightness', b.percent, 'sun', 'Brightness') : ''}${modeRow()}`;
  else
    panel.innerHTML = `
    <div class="os-tiles">
      <button class="os-tile" data-os="screenshot" title="Print Screen · Ctrl+Print Screen for the whole screen">
        ${icon('crop', 18)}<span><b>Screenshot</b><small>Select an area</small></span></button>
    </div>
    <div class="os-power-row">
      <button class="os-pw" data-os="lock">${icon('lock', 16)}<span>Lock</span></button>
      <button class="os-pw" data-os="power" data-act="sleep">${icon('moon', 16)}<span>Sleep</span></button>
      ${power?.sleep?.hibernate ? `<button class="os-pw" data-os="power" data-act="hibernate">${icon('moon', 16)}<span>Hibernate</span></button>` : ''}
      <button class="os-pw" data-os="power" data-act="restart">${icon('refresh', 16)}<span>Restart</span></button>
      <button class="os-pw" data-os="power" data-act="shutdown">${icon('power', 16)}<span>Shut down</span></button>
      <button class="os-pw" data-os="signout">${icon('logout', 16)}<span>Sign out</span></button>
      ${st.windows ? `<button class="os-pw os-pw-wide" data-os="power" data-act="windows">${icon('restart-other', 16)}<span>Restart into Windows</span></button>` : ''}
    </div>`;
}

const awakeTile = () =>
  power ? `<button class="os-tile${power.awake ? ' on' : ''}" data-os="keep-awake" title="No screen off, sleep or lock until you turn it off">
    ${icon('sun', 18)}<span><b>Keep awake</b><small>${power.awake ? 'On' : 'Off'}</small></span></button>` : '';
const MODE_NAMES = { 'power-saver': 'Power saver', balanced: 'Balanced', performance: 'Performance' };
const modeRow = () =>
  power?.modes?.available?.length > 1
    ? `<div class="os-modes" role="group" aria-label="Power mode">${power.modes.available.map((m) => `<button data-os="power-mode" data-mode="${m}" class="${power.modes.active === m ? 'on' : ''}">${MODE_NAMES[m]}</button>`).join('')}</div>`
    : '';
async function loadPower() {
  power = await shell.os.powerInfo?.().catch(() => power);
  if (panel && (view === 'battery' || view === 'power')) drawPanel();
}

function usagePanel() {
  const u = usage;
  const head = `<div class="os-cu-head"><span class="os-claude" aria-hidden="true"></span><b>${esc(u?.plan || 'Claude')}</b>${u?.stale ? '<small>Offline · last known</small>' : ''}</div>`;
  if (!u) return `${head}<div class="os-row os-muted"><span>Loading usage…</span></div>`;
  if (!u.signedIn || u.expired)
    return `${head}<div class="os-row os-muted"><span>${u.expired ? 'Your Claude Code sign-in has expired. Open Claude Code to sign in again.' : 'Sign in to Claude Code to see your usage.'}</span></div>
      <div class="os-cu-foot"><button class="btn small primary" data-os="claude-code">Open Terminal</button></div>`;
  const bar = (pct, cls = '') => `<div class="os-cu-bar${cls || usageLevel(pct)}"><i style="width:${Math.min(100, pct)}%"></i></div>`;
  const rows = u.limits.map((l) => {
    const p = projectionText(l, u.at);
    return `<div class="os-cu">
      <div class="os-cu-top"><b>${esc(l.label)}</b><span>${l.percent}% used</span></div>
      ${bar(l.percent, l.severity !== 'normal' && l.percent < 75 ? ' warn' : '')}
      <small>${esc(resetText(l.resetsAt))}</small>${p ? `<small class="os-cu-pace${p.warn ? ' warn' : ''}">${esc(p.text)}</small>` : ''}</div>`;
  });
  const x = u.extra;
  if (x) {
    const money = (n) => (n == null ? '' : (n / 10 ** x.decimals).toLocaleString([], { style: 'currency', currency: x.currency }));
    rows.push(`<div class="os-cu"><div class="os-cu-top"><b>Extra usage</b><span>${x.percent == null ? '' : `${x.percent}% used`}</span></div>
      ${x.percent == null ? '' : bar(x.percent)}<small>${esc([money(x.used), x.limit == null ? '' : `of ${money(x.limit)} this month`].filter(Boolean).join(' '))}</small></div>`);
  }
  return `${head}${rows.join('') || '<div class="os-row os-muted"><span>No limits to show</span></div>'}
    <div class="os-cu-foot"><button class="os-link" data-os="claude-usage-page">Usage on claude.ai</button></div>`;
}

// Where sound goes and comes from. AirPlay speakers on the network (an office can have dozens) fold away.
const AUDIO_ICON = { speakers: 'volume', headphones: 'headphones', mic: 'mic', display: 'display', bluetooth: 'headphones', airplay: 'airplay' };
function audioRow(d, input) {
  const tip = input && d.kind === 'bluetooth' ? ' title="Using its microphone switches it to call quality, so it sounds worse while recording"' : '';
  return `<li><button class="os-net${d.active ? ' on' : ''}" data-os="audio-dev" data-name="${esc(d.name)}"${tip}>
    ${icon(AUDIO_ICON[d.kind] || (input ? 'mic' : 'volume'), 14)}<span>${esc(d.label)}</span><small>${d.active ? 'In use' : ''}</small></button></li>`;
}
function audioSections() {
  if (!audio) return '';
  const near = audio.outputs.filter((d) => d.kind !== 'airplay');
  const air = audio.outputs.filter((d) => d.kind === 'airplay');
  const showAir = airplayOpen || air.some((d) => d.active);
  const mic = audio.input;
  return `<div class="os-sec">
      <div class="os-sec-head"><b>Output</b></div>
      <ul class="os-nets">${near.map((d) => audioRow(d, false)).join('') || '<li class="os-empty">No speakers or headphones</li>'}</ul>
    </div>
    ${air.length ? `<div class="os-sec">
      <div class="os-sec-head"><b>AirPlay</b>${air.some((d) => d.active) ? '' : `<button class="os-link" data-os="airplay-toggle">${showAir ? 'Hide' : `Show ${air.length}`}</button>`}</div>
      ${showAir ? `<ul class="os-nets">${air.map((d) => audioRow(d, false)).join('')}</ul>` : ''}
    </div>` : ''}
    <div class="os-sec">
      <div class="os-sec-head"><b>Input</b></div>
      ${mic ? slider('mic', mic.muted ? 0 : mic.level, mic.muted ? 'volume-x' : 'mic', mic.muted ? 'Unmute the microphone' : 'Mute the microphone') : ''}
      <ul class="os-nets">${audio.inputs.map((d) => audioRow(d, true)).join('') || '<li class="os-empty">No microphones</li>'}</ul>
    </div>`;
}
async function loadAudio() {
  audio = await shell.os.audioDevices().catch(() => audio);
  if (panel && view === 'sound') drawPanel();
}

function btTile() {
  const b = st.bluetooth;
  if (!b) return '';
  const sub = !b.powered ? 'Off' : b.connected.length ? b.connected.join(', ') : 'On';
  return `<button class="os-tile${b.powered ? ' on' : ''}" data-os="bt-toggle">
    ${icon(b.powered ? 'bluetooth' : 'bluetooth-off', 18)}<span><b>Bluetooth</b><small>${esc(sub)}</small></span></button>`;
}

function btSection() {
  const b = st.bluetooth;
  if (!b?.powered) return '';
  const row = (d) => {
    const pairing = btPairing === d.mac;
    const note = pairing ? 'Pairing…' : d.connected ? 'Connected' : d.paired ? 'Not connected' : 'Pair';
    const code = btCode?.mac === d.mac ? `<div class="os-bt-code">Type <b>${esc(btCode.code)}</b> on the keyboard, then press Enter</div>` : '';
    return `<li><div class="os-bt-row"><button class="os-net${d.connected ? ' on' : ''}" data-os="bt-dev" data-mac="${esc(d.mac)}" ${btPairing ? 'disabled' : ''}>
        ${icon('bluetooth', 14)}<span>${esc(d.name)}</span><small>${note}</small></button>
        ${d.paired && !pairing ? `<button class="os-ib os-bt-forget" data-os="bt-forget" data-mac="${esc(d.mac)}" title="Forget ${esc(d.name)}" aria-label="Forget ${esc(d.name)}">${icon('x', 12)}</button>` : ''}</div>${code}</li>`;
  };
  return `<div class="os-sec">
    <div class="os-sec-head"><b>Bluetooth devices</b><button class="os-link" data-os="bt-scan" ${btScanning || btPairing ? 'disabled' : ''}>${btScanning ? 'Searching…' : 'Find devices'}</button></div>
    ${bt ? `<ul class="os-nets">${bt.length ? bt.map(row).join('') : `<li class="os-empty">${btScanning ? 'Searching…' : 'No devices yet. Put yours in pairing mode, then Find devices.'}</li>`}</ul>` : ''}
  </div>`;
}

const VIEW_LABELS = { claude: 'Claude usage', network: 'Wi-Fi and Bluetooth', sound: 'Sound', battery: 'Battery, brightness and power mode', power: 'Power' };
function openPanel(v, button) {
  if (panel && view === v) return closePanel();
  view = v;
  asking = null;
  armed = null;
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'os-panel';
    panel.setAttribute('role', 'dialog');
    document.body.append(panel);
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('change', onPanelChange);
    panel.addEventListener('submit', onPanelSubmit);
    setTimeout(() => addEventListener('pointerdown', outside, true));
    addEventListener('keydown', onKey, true);
  }
  panel.setAttribute('aria-label', VIEW_LABELS[v]);
  // Under the icon you clicked (in whichever screen's menu bar), kept on the screen.
  const r = button?.getBoundingClientRect();
  panel.style.right = r ? `${Math.max(10, innerWidth - r.right)}px` : '';
  panel.style.top = r ? `${r.bottom + 8}px` : '';
  const s = r && screens().find((x) => r.left >= x.x && r.left < x.x + x.w && r.top >= x.y && r.top < x.y + x.h);
  panel.style.maxHeight = s ? `${s.y + s.h - r.bottom - 24}px` : '';
  drawPanel();
  refresh().then(() => {
    if (v === 'network' && st.bluetooth?.powered && !bt) loadBt(false);
    if (v === 'network' && st.network?.wifi?.enabled && !nets && !scanning) scanWifi();
  });
  if (v === 'claude') loadUsage(true);
  if (v === 'sound') loadAudio();
  if (v === 'battery' || v === 'power') loadPower();
}
function closePanel() {
  panel?.remove();
  panel = null;
  asking = null;
  removeEventListener('pointerdown', outside, true);
  removeEventListener('keydown', onKey, true);
}
const outside = (e) => panel && !panel.contains(e.target) && ![...trays].some((t) => t.contains(e.target)) && closePanel();
const onKey = (e) => e.key === 'Escape' && panel && (e.stopPropagation(), closePanel());

// Two-step confirm for actions that end what you're doing.
let armed = null;
async function onPanelClick(e) {
  const t = e.target.closest('[data-os]');
  if (!t) return;
  const kind = t.dataset.os;
  try {
    if (kind === 'wifi-toggle') {
      st.network = await shell.os.setWifi(!st.network?.wifi?.enabled);
      nets = null;
      drawPanel();
      drawTray();
    } else if (kind === 'volume-icon' && st.sound) {
      st.sound = await shell.os.setMuted(!st.sound.muted);
      drawPanel();
      drawTray();
    } else if (kind === 'mic-icon' && audio?.input) {
      audio.input = await shell.os.setMicMuted(!audio.input.muted);
      drawPanel();
    } else if (kind === 'audio-dev') {
      if (t.classList.contains('on')) return;
      audio = await shell.os.setAudioDevice(t.dataset.name);
      await refresh(); // the volume slider is the new output's
      drawPanel();
    } else if (kind === 'airplay-toggle') {
      airplayOpen = !airplayOpen;
      drawPanel();
    } else if (kind === 'scan') {
      await scanWifi();
    } else if (kind === 'claude-usage-page') {
      closePanel();
      openWebPage('https://claude.ai/settings/usage');
    } else if (kind === 'claude-code') {
      closePanel();
      openApp('terminal');
    } else if (kind === 'portal') {
      signInToNetwork();
    } else if (kind === 'net') {
      if (t.classList.contains('on')) return;
      if (t.dataset.hidden) {
        asking = asking === HIDDEN ? null : HIDDEN;
        drawPanel();
        panel.querySelector('.os-pass-hidden input')?.focus();
      } else if (t.dataset.secure === '1') {
        asking = asking === t.dataset.ssid ? null : t.dataset.ssid;
        drawPanel();
        panel.querySelector('.os-pass input')?.focus();
      } else await join(t.dataset.ssid, '');
    } else if (kind === 'bt-toggle') {
      st.bluetooth = await shell.os.btPower(!st.bluetooth?.powered);
      bt = null;
      drawPanel();
      if (st.bluetooth?.powered) loadBt(false);
    } else if (kind === 'bt-scan') {
      await loadBt(true);
    } else if (kind === 'bt-dev') {
      const d = bt?.find((x) => x.mac === t.dataset.mac);
      if (!d || btPairing) return;
      if (!d.paired) return pairBt(d);
      toast(d.connected ? `Disconnecting ${d.name}…` : `Connecting ${d.name}…`);
      bt = await shell.os.btConnect(d.mac, !d.connected);
      refresh();
    } else if (kind === 'bt-forget') {
      const d = bt?.find((x) => x.mac === t.dataset.mac);
      if (!d) return;
      if (armed !== `forget:${d.mac}`) {
        armed = `forget:${d.mac}`;
        t.classList.add('armed');
        t.title = `Click again to forget ${d.name}`;
        setTimeout(() => armed === `forget:${d.mac}` && ((armed = null), panel && drawPanel()), 4000);
        return;
      }
      armed = null;
      bt = await shell.os.btForget(d.mac);
      refresh();
    } else if (kind === 'keep-awake' && power) {
      power.awake = await shell.os.keepAwake(!power.awake);
      drawPanel();
    } else if (kind === 'power-mode' && power) {
      power.modes = await shell.os.setPowerMode(t.dataset.mode);
      drawPanel();
    } else if (kind === 'screenshot') {
      closePanel();
      // Once the screen has been drawn without the panel, so it isn't in the picture.
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => shell.os.snip(), 30)));
    } else if (kind === 'lock') {
      closePanel();
      await shell.os.lock();
    } else if (kind === 'power' || kind === 'signout') {
      const act = kind === 'signout' ? 'signout' : t.dataset.act;
      if (act !== 'sleep' && act !== 'hibernate' && armed !== act) {
        armed = act;
        panel.querySelectorAll('.os-pw').forEach((b) => b.classList.remove('armed'));
        t.classList.add('armed');
        t.querySelector('span').textContent = { restart: 'Restart?', shutdown: 'Shut down?', signout: 'Sign out?', windows: 'Restart into Windows?' }[act];
        setTimeout(() => armed === act && ((armed = null), panel && drawPanel()), 4000);
        return;
      }
      armed = null;
      closePanel();
      if (act === 'signout') shell.windowAction('sign-out');
      else await shell.os.power(act);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

let volTimer = 0;
function onPanelInput(e) {
  const t = e.target;
  const val = t.closest('.os-slider')?.querySelector('.os-val');
  if (val) val.textContent = `${t.value}%`;
  // Live while dragging, but at most every 80 ms.
  clearTimeout(volTimer);
  volTimer = setTimeout(() => apply(t), 80);
}
function onPanelChange(e) {
  const val = e.target.closest(".os-slider")?.querySelector(".os-val");
  if (val) val.textContent = `${e.target.value}%`;
  apply(e.target);
}
async function apply(t) {
  try {
    if (t.dataset.os === 'volume') st.sound = await shell.os.setVolume(Number(t.value));
    if (t.dataset.os === 'brightness') st.brightness = await shell.os.setBrightness(Number(t.value));
    if (t.dataset.os === 'mic' && audio) audio.input = await shell.os.setMicVolume(Number(t.value));
    drawTray();
  } catch (err) {
    toast(err.message, 'error');
  }
}
async function onPanelSubmit(e) {
  e.preventDefault();
  const f = e.target.closest('.os-pass');
  if (f?.dataset.hidden) await join(f.elements.ssid.value.trim(), f.elements.password.value, { hidden: true });
  else if (f?.dataset.enterprise) await join(f.dataset.ssid, f.elements.password.value, { username: f.elements.username.value.trim() });
  else if (f) await join(f.dataset.ssid, f.querySelector('input').value);
}
async function join(ssid, password, opts) {
  if (!ssid) return;
  toast(`Connecting to ${ssid}…`);
  try {
    st.network = await shell.os.wifiConnect(ssid, password, opts);
    asking = null;
    nets = await shell.os.wifiList().catch(() => nets);
    toast(st.network?.connected ? `Connected to ${st.network.name || ssid}` : `Couldn’t connect to ${ssid}`, st.network?.connected ? '' : 'error');
  } catch (err) {
    toast(`Couldn’t connect to ${ssid}: ${err.message}`, 'error');
  }
  if (panel) drawPanel();
  drawTray();
}

async function scanWifi() {
  scanning = true;
  if (panel) drawPanel();
  nets = await shell.os.wifiList().catch((err) => (toast(err.message, 'error'), []));
  scanning = false;
  if (panel) drawPanel();
}

async function loadBt(scan) {
  if (scan) btScanning = true;
  if (panel) drawPanel();
  try {
    bt = await shell.os.btList(scan);
  } catch (err) {
    toast(err.message, 'error');
    bt = bt || [];
  }
  btScanning = false;
  if (panel) drawPanel();
}

async function pairBt(d) {
  btPairing = d.mac;
  btCode = null;
  drawPanel();
  toast(`Pairing ${d.name}…`);
  try {
    bt = await shell.os.btPair(d.mac);
    const now = bt.find((x) => x.mac === d.mac);
    toast(now?.connected ? `${d.name} is connected` : `${d.name} is paired. It connects when it's turned on.`);
  } catch (err) {
    toast(err.message, 'error');
  }
  btPairing = null;
  btCode = null;
  refresh();
}

/* ---------------- Notifications from Linux apps and services (electron/osnotify.cjs) ---------------- */

const notes = new Map(); // id → { card, timer }
function noteBox() {
  let box = document.getElementById('reminders');
  if (!box) {
    box = document.createElement('div');
    box.id = 'reminders';
    box.setAttribute('aria-live', 'assertive');
    document.body.append(box);
  }
  return box;
}
// Apps may send simple markup (<b>, <a href>, &amp;): shown as plain text.
const plainText = (s) => new DOMParser().parseFromString(`<body>${String(s || '')}</body>`, 'text/html').body.textContent || '';

function showNote(n) {
  const actions = (n.actions || []).filter(([key]) => key !== 'default');
  const clickable = (n.actions || []).some(([key]) => key === 'default');
  const app = n.app && n.app !== 'notify-send' ? n.app : 'Notification';
  const card = document.createElement('div');
  card.className = `reminder os-note${n.urgency === 2 ? ' critical' : ''}${clickable ? ' clickable' : ''}`;
  card.setAttribute('role', n.urgency === 2 ? 'alertdialog' : 'status');
  card.innerHTML = `<div class="rm-head"><span class="rm-ic">${icon('bell', 15)}</span><span class="rm-kind">${esc(plainText(app))}</span>
      <button class="rm-x" data-note="dismiss" title="Dismiss">${icon('x', 13)}</button></div>
    <b class="rm-title">${esc(plainText(n.summary))}</b>${n.body ? `<div class="rm-body">${esc(plainText(n.body))}</div>` : ''}
    ${actions.length ? `<div class="rm-acts">${actions.map(([key, label], i) => `<button class="btn small${i === 0 ? ' primary' : ''}" data-note="act" data-key="${esc(key)}">${esc(label)}</button>`).join('')}</div>` : ''}`;
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-note]');
    if (b?.dataset.note === 'dismiss') return closeNote(n.id, 2);
    if (b?.dataset.note === 'act') shell.os.notificationAction(n.id, b.dataset.key);
    else if (clickable) shell.os.notificationAction(n.id, 'default');
    else return;
    closeNote(n.id, 0);
  });
  const prev = notes.get(n.id);
  if (prev) {
    clearTimeout(prev.timer);
    prev.card.replaceWith(card);
  } else noteBox().append(card);
  // Critical ones stay until dismissed; others leave after the app's timeout (or 8 seconds), unless they have buttons.
  const life = n.urgency === 2 ? 0 : n.timeout > 0 ? Math.max(3000, n.timeout) : actions.length ? 20000 : 8000;
  notes.set(n.id, { card, timer: life ? setTimeout(() => closeNote(n.id, 1), life) : 0 });
  while (notes.size > 4) closeNote(notes.keys().next().value, 1);
}
/** reason: 1 expired, 2 dismissed (both reported to the app), 0 nothing to report (an action was taken, or the app closed it). */
function closeNote(id, reason) {
  const n = notes.get(id);
  if (!n) return;
  notes.delete(id);
  clearTimeout(n.timer);
  n.card.classList.add('out');
  setTimeout(() => n.card.remove(), 250);
  if (reason) shell.os.notificationClosed(id, reason).catch(() => {});
}

/** The lock screen shows your wallpaper, accent and name. */
function syncAppearance() {
  const p = store.prefs || {};
  let wall = '';
  try {
    wall = localStorage.getItem('ws:wallpaper') || '';
  } catch {}
  wall = wall || p.wallpaper || '/wallpaper.jpg';
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  shell.os.setAppearance({ wallpaper: wall, accent, name: p.userName || '', theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' }).catch(() => {});
}

// The volume and brightness keys: the new level, briefly, at the bottom of the screen.
let levelEl = null;
let levelTimer = 0;
function showLevel({ kind, level }) {
  if (!level) return;
  st[kind] = level;
  drawTray();
  if (panel) drawPanel();
  const muted = kind === 'sound' && level.muted;
  const pct = kind === 'sound' ? (muted ? 0 : level.level) : level.percent;
  const name = kind === 'sound' ? (muted || pct === 0 ? 'volume-x' : 'volume') : 'sun';
  if (!levelEl) {
    levelEl = document.createElement('div');
    levelEl.className = 'os-level';
    document.body.append(levelEl);
  }
  levelEl.innerHTML = `${icon(name, 18)}<span class="os-level-bar"><span style="width:${pct}%"></span></span><span class="os-level-num">${muted ? 'Muted' : pct + '%'}</span>`;
  levelEl.title = kind === 'sound' ? 'Volume' : 'Brightness';
  levelEl.classList.remove('out');
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => levelEl.classList.add('out'), 1500);
}

/** Called by the menu bar when Leafdeck is running as the OS session. `host` replaces the window controls. */
export function initOsTray(host) {
  if (!shell?.os) return;
  syncAppearance();
  store.addEventListener?.('change', (e) => ['settings', '*'].includes(e.detail?.col) && syncAppearance());
  shell.on('os:toast', ({ text, kind, reveal }) => toast(text, kind || '', reveal ? { label: 'Show', act: () => openApp('files', { reveal }) } : null));
  initSnip();
  // Pairing a keyboard: it shows (or wants) a code. Shown in the Wi-Fi and Bluetooth panel and as a notice, in case it's closed.
  shell.on('os:bt-code', ({ mac, code }) => {
    btCode = { mac, code };
    toast(`Type ${code} on the keyboard, then press Enter`);
    if (panel) drawPanel();
  });
  shell.on('os:notification', showNote);
  shell.os.notifications().then((list) => list.forEach(showNote), () => {});
  shell.on('os:notification-close', ({ id }) => closeNote(id, 0));
  // Stacked screens: the menu bar, Dock and maximized windows each stay on one screen.
  shell.os.layout().then(({ screens }) => setScreens(screens), () => {});
  shell.on('os:layout', ({ screens }) => setScreens(screens));
  shell.on('os:resumed', () => refresh());
  shell.on('os:level', showLevel);
  // Shells outlive Leafdeck (they run in leafdeckd): if some of Terminal's are still running and no Terminal window came
  // back with the others, open one so they aren't left out of sight. Shells another app shows (the Claude Code app's
  // drawer) wait for that app. After restoreSession has reopened the saved windows.
  screensSettled().then(() => setTimeout(async () => {
    const running = await shell.term?.list?.().catch(() => []);
    const others = new Set(claimed());
    if (running?.some((t) => !others.has(t.id)) && ![...wins.values()].some((w) => w.app?.id === 'terminal')) openApp('terminal');
  }, 1500));
  initKeyboard();
  addEventListener('osk', () => drawTray());
  addTray(host);
  refresh();
  setInterval(refresh, 15000);
}

/** Show the tray in a menu bar: the main one's, or another screen's own (menubar.js). */
export function addTray(host) {
  if (!shell?.os || trays.has(host)) return;
  trays.add(host);
  host.classList.add('os-tray');
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-os="keyboard"]')) return toggleKeyboard();
    const b = e.target.closest('[data-os="panel"]');
    if (b) openPanel(b.dataset.view || 'power', b);
  });
  // The keyboard button mustn't take focus from the text field you're about to type in.
  host.addEventListener('mousedown', (e) => e.target.closest('[data-os="keyboard"]') && e.preventDefault());
  drawTray();
}
