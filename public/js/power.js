// Settings → Power (Leafdeck OS): the battery, power mode and battery saver, when the screen turns off and the computer
// sleeps (on battery and plugged in), what the lid and power button do, hibernating, and how the battery charges. The
// work is electron/ospower.cjs's; the lid, the power button and charging go through its root helper (os/leafdeck-power),
// so they're read back from the system each time rather than kept here.
import { shell } from './shell.js';
import { esc } from './util.js';
import { icon } from './icons.js';
import { toast } from './wm.js';

let host = null;
let data = null; // os:power-info
let cfg = null; // os:settings
let timer = 0;

const errText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const row = (label, control, hint = '') =>
  `<div class="set-row"><div><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="set-ctl">${control}</div></div>`;
const select = (attrs, options, value, disabled) =>
  `<select ${attrs} ${disabled ? 'disabled' : ''}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
/** On battery and plugged in, side by side (only plugged in for a computer without a battery). */
const pair = (battery, ac) =>
  `<div class="pw-pair">${data.battery ? `<label><small>${icon('battery', 11)} On battery</small>${battery}</label>` : ''}<label><small>${icon('bolt', 11)} Plugged in</small>${ac}</label></div>`;

const minutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const span = (m) => (m < 60 ? `${m} minute${m > 1 ? 's' : ''}` : `${m / 60} hour${m > 60 ? 's' : ''}`);
const after = (list) => list.map((m) => [m, m ? `After ${span(m)}` : 'Never']);
const SCREEN_BAT = after([1, 2, 5, 10, 15, 30, 0]);
const SCREEN_AC = after([1, 2, 5, 10, 15, 30, 60, 0]);
const SLEEP_BAT = after([5, 10, 15, 30, 60, 0]);
const SLEEP_AC = after([15, 30, 60, 120, 180, 0]);

const MODES = {
  'power-saver': ['Power saver', 'Slower, cooler and quieter; the battery lasts longest'],
  balanced: ['Balanced', 'Fast when you need it, frugal when you don’t'],
  performance: ['Performance', 'Fastest, at the cost of battery, heat and fan noise'],
};
const DEGRADED = { 'lap-detected': 'Held back: the computer is on your lap', 'high-operating-temperature': 'Held back: the computer is too hot' };
const CHARGE_MODES = {
  Fast: ['Fast', 'Charges as quickly as it can'],
  Standard: ['Standard', 'Charges fully at the normal rate'],
  Long_Life: ['Protect battery', 'Stops charging well short of full, so the battery ages slower. Best when it’s mostly plugged in'],
  Adaptive: ['Adaptive', 'Learns when you unplug and charges to suit'],
  Trickle: ['Trickle', 'Charges slowly'],
  Custom: ['Custom', 'Charges between the levels set in the firmware'],
};

function lidOptions(s, cur) {
  const list = [['suspend', 'Sleep']];
  if (s.hibernate) list.push(['hibernate', 'Hibernate']);
  if (s.suspendThenHibernate) list.push(['suspend-then-hibernate', 'Sleep, then hibernate']);
  list.push(['lock', 'Turn off the screen']);
  return withCurrent(list, cur);
}
function keyOptions(s, cur) {
  const list = [['suspend', 'Sleep']];
  if (s.hibernate) list.push(['hibernate', 'Hibernate']);
  list.push(['poweroff', 'Shut down'], ['ignore', 'Do nothing']);
  return withCurrent(list, cur);
}
// logind may be set to something Settings doesn't offer (by hand, or by another desktop): show it as it is.
const OTHER = { ignore: 'Do nothing', poweroff: 'Shut down', reboot: 'Restart', halt: 'Halt', kexec: 'Restart (kexec)', 'hybrid-sleep': 'Hybrid sleep', 'factory-reset': 'Factory reset', lock: 'Lock' };
const withCurrent = (list, cur) => (list.some(([v]) => v === cur) ? list : [...list, [cur, OTHER[cur] || cur]]);

function batteryCard(b) {
  if (!b) return '';
  const state = b.status === 'Full' || (b.charging && b.percent >= 100) ? 'Fully charged' : b.status === 'Charging' ? 'Charging' : b.charging ? 'Plugged in, not charging' : 'On battery';
  const time = b.minutes ? (b.status === 'Charging' ? `full in ${minutes(b.minutes)}` : `about ${minutes(b.minutes)} left`) : '';
  const facts = [b.health != null && `Health ${b.health}%`, b.cycles && `${b.cycles} charge cycles`, b.watts && `${b.status === 'Charging' ? 'Charging at' : 'Using'} ${b.watts} W`].filter(Boolean);
  return `<div class="pw-battery${b.charging ? ' charging' : ''}${b.percent <= 15 && !b.charging ? ' low' : ''}">
    <div class="pw-batt"><i style="width:${b.percent}%"></i></div>
    <div class="pw-batt-text"><b>${b.percent}%</b><span>${esc([state, time].filter(Boolean).join(' · '))}</span><small>${esc(facts.join(' · '))}</small></div></div>`;
}

function draw() {
  if (!host?.isConnected) return stop();
  if (!data) return void (host.innerHTML = '<div class="set-group"><div class="set-row"><span class="muted">Loading…</span></div></div>');
  const { modes: m, sleep: s, buttons: btn, battery: b } = data;
  const locked = !btn.canChange;
  const needSetup = locked ? 'Run os/setup-fedora.sh once to change this' : '';

  const modeGroup = m
    ? `<div class="set-group">
        ${row('Power mode', `<div class="set-seg">${m.available.map((k) => `<button data-pw-mode="${k}" class="${m.active === k ? 'on' : ''}">${esc(MODES[k][0])}</button>`).join('')}</div>`, (m.active === 'performance' && DEGRADED[m.degraded]) || MODES[m.active]?.[1] || '')}
        ${b ? row('Battery saver', select('data-pw-set="saverAt"', [[0, 'Off'], [10, 'At 10%'], [20, 'At 20%'], [30, 'At 30%'], [50, 'At 50%']], cfg.saverAt), cfg.saverFrom ? 'On now: Power saver until you plug in' : 'Switches to Power saver on battery at this level, and back when you plug in') : ''}
      </div>`
    : '';

  const idleGroup = `<div class="set-group">
      ${row('Turn off the screen', pair(select('data-pw-set="screenOffAfter"', SCREEN_BAT, cfg.screenOffAfter), select('data-pw-set="screenOffAfterAc"', SCREEN_AC, cfg.screenOffAfterAc)), 'When you haven’t used the computer. Anything you press or touch turns it back on')}
      ${row('Sleep', pair(select('data-pw-set="sleepAfter"', SLEEP_BAT, cfg.sleepAfter), select('data-pw-set="sleepAfterAc"', SLEEP_AC, cfg.sleepAfterAc)), 'Not while something is playing, or a program asks to stay awake. Locks first')}
      ${row('Keep awake', `<label class="switch"><input type="checkbox" data-pw-awake ${data.awake ? 'checked' : ''}><span></span></label>`, 'No screen off, sleep or lock until you turn this off (or Leafdeck restarts). Also in the battery menu')}
    </div>`;

  const lidHint = btn.docked ? 'With another screen in use, closing the lid doesn’t do anything' : 'Turn off the screen: it locks and stays on, for downloads or music with the lid closed';
  const buttonsGroup = `<div class="set-group">
      ${btn.hasLid ? row('When the lid is closed', pair(select('data-pw-btn="lid"', lidOptions(s, btn.lid), btn.lid, locked), select('data-pw-btn="lidAc"', lidOptions(s, btn.lidAc), btn.lidAc, locked)), needSetup || lidHint) : ''}
      ${row('Power button', select('data-pw-btn="key"', keyOptions(s, btn.key), btn.key, locked), needSetup || 'Holding it down always shuts down')}
      ${row('Hibernate', s.hibernate ? `<button class="btn small" data-pw-hibernate>${icon('moon', 12)} Hibernate now</button>` : '<span class="muted small">Not available</span>', s.hibernate ? 'Saves everything to disk and turns off: no battery used, and it all comes back when you turn it on' : s.hibernateWhy)}
    </div>`;

  let chargeGroup = '';
  if (b?.chargeModes?.length) {
    const cur = CHARGE_MODES[b.chargeMode];
    chargeGroup = `<div class="set-group">${row('Battery charging', `<div class="set-seg">${b.chargeModes.map((k) => `<button data-pw-charge="${esc(k)}" class="${b.chargeMode === k ? 'on' : ''}" ${locked ? 'disabled' : ''}>${esc(CHARGE_MODES[k]?.[0] || k)}</button>`).join('')}</div>`, needSetup || cur?.[1] || '')}</div>`;
  } else if (b?.chargeLimit != null) {
    chargeGroup = `<div class="set-group">${row('Stop charging at', select('data-pw-limit', [100, 90, 85, 80, 70, 60].map((v) => [v, v === 100 ? 'Full (100%)' : `${v}%`]), b.chargeLimit, locked), needSetup || 'Keeping a battery below full helps it last more years, if the computer is mostly plugged in')}</div>`;
  }

  host.innerHTML = `${batteryCard(b)}${modeGroup}${idleGroup}${buttonsGroup}${chargeGroup}`;
}

async function load() {
  try {
    [data, cfg] = await Promise.all([shell.os.powerInfo(), shell.os.settings()]);
  } catch (err) {
    host.innerHTML = `<div class="set-group"><div class="set-row"><span class="muted">${esc(errText(err))}</span></div></div>`;
    return;
  }
  draw();
}

function stop() {
  clearInterval(timer);
  timer = 0;
}

async function onClick(e) {
  const t = e.target.closest('[data-pw-mode], [data-pw-charge], [data-pw-hibernate]');
  if (!t || t.disabled) return;
  try {
    if (t.dataset.pwMode) {
      data.modes = await shell.os.setPowerMode(t.dataset.pwMode);
      cfg.saverFrom = '';
    } else if (t.dataset.pwCharge) data.battery = await shell.os.setCharge(t.dataset.pwCharge);
    else if (t.hasAttribute('data-pw-hibernate')) return void (await shell.os.power('hibernate'));
    draw();
  } catch (err) {
    toast(errText(err), 'error');
    load();
  }
}
async function onChange(e) {
  const t = e.target;
  try {
    if (t.dataset.pwSet) cfg = await shell.os.settings({ [t.dataset.pwSet]: Number(t.value) });
    else if (t.dataset.pwBtn) data.buttons = await shell.os.setPowerButtons({ [t.dataset.pwBtn]: t.value });
    else if (t.hasAttribute('data-pw-limit')) data.battery = await shell.os.setCharge(Number(t.value));
    else if (t.hasAttribute('data-pw-awake')) data.awake = await shell.os.keepAwake(t.checked);
    else return;
    draw();
  } catch (err) {
    toast(errText(err), 'error');
    load();
  }
}

/** Draw the page into `el` (each time it's shown). The battery line stays current while it's open. */
export function mountPower(el) {
  if (host !== el) {
    host = el;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
  }
  draw();
  load();
  stop();
  timer = setInterval(async () => {
    if (!host?.isConnected || host.closest('section')?.hidden) return stop();
    if (!data) return;
    data.battery = await shell.os.powerInfo().then((i) => i.battery).catch(() => data.battery);
    if (!host.contains(document.activeElement) || document.activeElement === document.body) draw();
  }, 30_000);
}
