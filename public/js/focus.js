// Focus sessions: pick what you're working on, a time box and the windows you need. Everything else is put
// away, distracting sites are blocked (desktop app) and web notifications are held. Presets: Pomodoro (25/5 ×4), Deep work (50/10 ×2), or custom.
//
// The session lives in localStorage (per computer) so a reload or restart picks it back up.

import { store } from './store.js';
import { $, $$, esc, el, fmtMinutes } from './util.js';
import { icon } from './icons.js';
import { wins, activeWindow, minimize, restore, focus as focusWindow, toast } from './wm.js';
import { shell } from './shell.js';

const LS = 'ws:focus';
const MIN = 60_000;
export const DEFAULT_BLOCKS = ['youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'reddit.com', 'netflix.com', 'twitch.tv', 'pinterest.com'];
export const PRESETS = {
  pomodoro: { label: 'Pomodoro', focus: 25, break: 5, rounds: 4, hint: '25 min on, 5 off, four rounds' },
  deep: { label: 'Deep work', focus: 50, break: 10, rounds: 2, hint: '50 min on, 10 off, two rounds' },
  custom: { label: 'Custom', focus: 45, break: 0, rounds: 1, hint: 'Your own timing' },
};

let s = null; // the active session
let tick = null;
let bar = null;
let lastPhaseKey = '';

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(LS));
  } catch {
    return null;
  }
};
const persist = () => {
  try {
    if (s) localStorage.setItem(LS, JSON.stringify(s));
    else localStorage.removeItem(LS);
  } catch {}
};
export const focusSession = () => s;

/* The phone sees (and can start or end) the session through the focus/state record — docs/companion-api.md. */
const ME = 'desktop';
function publish(active = !!s) {
  const prev = store.get('focus', 'state') || {};
  const state = active
    ? { id: 'state', active: true, title: s.title, taskId: s.taskId, phase: s.phase, endsAt: s.pausedAt ? null : s.phaseEnd, round: s.round, rounds: s.rounds, focusMin: s.focusMin, breakMin: s.breakMin, blocked: s.blocked, startedBy: prev.active && prev.startedBy ? prev.startedBy : ME, updatedBy: ME }
    : { id: 'state', active: false, startedBy: prev.startedBy || ME, updatedBy: ME };
  const strip = ({ updatedAt, createdAt, ...rest }) => JSON.stringify(rest);
  if (strip(prev) === strip(state)) return;
  store.save('focus', state);
}
function onRemoteFocus() {
  const st = store.get('focus', 'state');
  if (!st || st.updatedBy === ME) return;
  if (st.active && !s) {
    const left = st.endsAt ? Math.max(1, Math.round((st.endsAt - Date.now()) / MIN)) : st.focusMin;
    if (st.phase === 'focus' && left >= 1) {
      startFocus({ title: st.title || 'Focus session', taskId: st.taskId || '', focusMin: left, breakMin: st.breakMin || 0, rounds: Math.max(1, (st.rounds || 1) - (st.round || 1) + 1), blocked: st.blocked || [], remote: true });
    }
  } else if (!st.active && s) {
    finish('ended', true);
  }
}

/** Tell the app which sites to block (focus phases only) and that notifications should be held. */
function applyBlocks() {
  shell?.focus?.set(s ? { blocked: s.phase === 'focus' ? s.blocked : [] } : null).catch(() => {});
}

const hostList = (text) =>
  [...new Set(String(text || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))];

/* ---------------- Setup ---------------- */

export function openFocusSetup() {
  if (s) return toast('A focus session is already running — end it from the bar first');
  $('.focus-setup')?.remove();
  const tasks = store.all('tasks').filter((t) => t.status !== 'Done').sort((a, b) => (a.due || '9').localeCompare(b.due || '9')).slice(0, 40);
  const open = [...wins.values()].sort((a, b) => b.z - a.z);
  const active = activeWindow();
  const saved = store.prefs.focusBlocks;
  const blocks = Array.isArray(saved) ? saved : DEFAULT_BLOCKS;
  const preset = store.prefs.focusPreset || 'pomodoro';
  const titleOf = (w) => $('.win-title-text', w.el)?.textContent || w.app.name;

  const panel = el(`<div class="focus-setup" role="dialog" aria-label="Focus session">
    <h2>${icon('target', 18)} Focus session</h2>
    <div class="fs-grid">
      <label class="field span2"><span>What are you working on?</span>
        <select data-task><option value="">Pick a task, or describe it below</option>${tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}${t.due ? ` · ${esc(t.due)}` : ''}</option>`).join('')}</select></label>
      <label class="field span2"><span>Describe it</span><input data-title placeholder="e.g. Draft the Brightline proposal" autocomplete="off"></label>
      <div class="field span2"><span>Timing</span>
        <div class="fs-presets">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="fs-preset ${k === preset ? 'on' : ''}" data-preset="${k}"><b>${p.label}</b><small>${p.hint}</small></button>`).join('')}</div>
        <div class="fs-custom" ${preset === 'custom' ? '' : 'hidden'}>
          <label>Focus <input type="number" data-focus-min min="5" max="240" value="${PRESETS.custom.focus}"> min</label>
          <label>Break <input type="number" data-break-min min="0" max="60" value="${PRESETS.custom.break}"> min</label>
          <label>Rounds <input type="number" data-rounds min="1" max="12" value="${PRESETS.custom.rounds}"></label>
        </div></div>
      <div class="field span2"><span>Keep these windows (the rest are put away until you're done)</span>
        <div class="fs-windows">${
          open.length
            ? open.map((w) => `<label class="fs-win"><input type="checkbox" data-keep="${esc(w.id)}" ${w === active ? 'checked' : ''}><span>${esc(titleOf(w))}</span></label>`).join('')
            : '<span class="muted small">No windows open — open what you need, or just start.</span>'
        }</div></div>
      <label class="field span2"><span>Block these sites while focusing ${shell ? '' : '<small class="muted">(desktop app only)</small>'}</span>
        <textarea data-blocks rows="2" spellcheck="false">${esc(blocks.join(', '))}</textarea></label>
    </div>
    <div class="fs-foot"><span class="muted small">F4 opens this. Notifications from sites are held during the session.</span><span class="grow"></span>
      <button class="btn" data-cancel>Cancel</button><button class="btn primary" data-start>${icon('play', 12)} Start</button></div>
  </div>`);
  document.body.append(panel);
  const close = () => panel.remove();
  panel.addEventListener('change', (e) => {
    if (e.target.matches('[data-task]')) {
      const t = store.get('tasks', e.target.value);
      if (t) $('[data-title]', panel).value = t.title;
    }
  });
  panel.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) {
      $$('.fs-preset', panel).forEach((b) => b.classList.toggle('on', b === p));
      $('.fs-custom', panel).hidden = p.dataset.preset !== 'custom';
      return;
    }
    if (e.target.closest('[data-cancel]')) return close();
    if (e.target.closest('[data-start]')) {
      const presetKey = $('.fs-preset.on', panel)?.dataset.preset || 'pomodoro';
      const P = PRESETS[presetKey];
      const num = (sel, fallback, lo, hi) => Math.min(hi, Math.max(lo, Number($(sel, panel).value) || fallback));
      const focusMin = presetKey === 'custom' ? num('[data-focus-min]', P.focus, 5, 240) : P.focus;
      const breakMin = presetKey === 'custom' ? num('[data-break-min]', P.break, 0, 60) : P.break;
      const rounds = presetKey === 'custom' ? num('[data-rounds]', P.rounds, 1, 12) : P.rounds;
      const taskId = $('[data-task]', panel).value;
      const title = $('[data-title]', panel).value.trim() || store.get('tasks', taskId)?.title || 'Focus session';
      const blocked = hostList($('[data-blocks]', panel).value);
      store.setPrefs({ focusBlocks: blocked, focusPreset: presetKey });
      close();
      startFocus({ title, taskId, focusMin, breakMin, rounds, keep: $$('[data-keep]:checked', panel).map((c) => c.dataset.keep), blocked });
    }
  });
  panel.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  setTimeout(() => $('[data-title]', panel).focus(), 30);
}

/* ---------------- Running ---------------- */

export function startFocus({ title, taskId = '', focusMin, breakMin = 0, rounds = 1, keep = [], blocked = [], remote = false }) {
  if (s) return;
  const now = Date.now();
  const put = [];
  for (const w of wins.values()) {
    if (keep.includes(w.id) || w.minimized) continue;
    minimize(w);
    put.push(w.id);
  }
  for (const id of keep) {
    const w = wins.get(id);
    if (w?.minimized) restore(w);
  }
  const front = keep.map((id) => wins.get(id)).find(Boolean);
  if (front) focusWindow(front);
  s = { title, taskId, focusMin, breakMin, rounds, round: 1, phase: 'focus', phaseStart: now, phaseEnd: now + focusMin * MIN, pausedAt: null, focusedMs: 0, keep, put, blocked, startedAt: now };
  persist();
  begin();
  if (!remote) publish();
  toast(`Focus: ${title} — ${fmtMinutes(focusMin)}${rounds > 1 ? ` × ${rounds}` : ''}${remote ? ' (started on another device)' : ''}`);
}

function begin() {
  document.body.classList.add('focusing');
  applyBlocks();
  showBar();
  clearInterval(tick);
  tick = setInterval(update, 1000);
  update();
}

const remaining = () => Math.max(0, (s.pausedAt ? s.phaseEnd - s.pausedAt : s.phaseEnd - Date.now()));
const mmss = (ms) => {
  const t = Math.ceil(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function update() {
  if (!s) return;
  if (!s.pausedAt && Date.now() >= s.phaseEnd) nextPhase();
  if (!s) return;
  drawBar();
}

function nextPhase() {
  const now = Date.now();
  if (s.phase === 'focus') {
    s.focusedMs += s.phaseEnd - s.phaseStart;
    if (s.round >= s.rounds) return finish('done');
    if (s.breakMin > 0) {
      s.phase = 'break';
      s.phaseStart = now;
      s.phaseEnd = now + s.breakMin * MIN;
      chime('break');
      toast(`Break time — ${fmtMinutes(s.breakMin)}. Round ${s.round} of ${s.rounds} done.`);
    } else {
      s.round++;
      s.phaseStart = now;
      s.phaseEnd = now + s.focusMin * MIN;
      chime('focus');
      toast(`Round ${s.round} of ${s.rounds}`);
    }
  } else {
    s.round++;
    s.phase = 'focus';
    s.phaseStart = now;
    s.phaseEnd = now + s.focusMin * MIN;
    chime('focus');
    toast(`Back to it — round ${s.round} of ${s.rounds}`);
  }
  persist();
  applyBlocks();
  publish();
}

export function pauseFocus() {
  if (!s || s.pausedAt) return;
  s.pausedAt = Date.now();
  persist();
  drawBar();
}
export function resumeFocus() {
  if (!s || !s.pausedAt) return;
  const paused = Date.now() - s.pausedAt;
  s.phaseStart += paused;
  s.phaseEnd += paused;
  s.pausedAt = null;
  persist();
  drawBar();
}
export function extendFocus(min = 5) {
  if (!s) return;
  s.phaseEnd += min * MIN;
  persist();
  drawBar();
}

/** End the session now. */
export function endFocus() {
  if (!s) return;
  if (s.phase === 'focus') s.focusedMs += Math.max(0, (s.pausedAt || Date.now()) - s.phaseStart);
  finish('ended');
}

function finish(how, remote = false) {
  const done = s;
  s = null;
  persist();
  if (!remote) publish(false);
  clearInterval(tick);
  tick = null;
  bar?.remove();
  bar = null;
  document.body.classList.remove('focusing');
  applyBlocks();
  for (const id of done.put) {
    const w = wins.get(id);
    if (w?.minimized) restore(w);
  }
  const minutes = Math.round(done.focusedMs / MIN);
  if (how === 'done') chime('done');
  toast(minutes >= 1 ? `Focus session ${how === 'done' ? 'complete' : 'ended'} — ${fmtMinutes(minutes)} focused` : 'Focus session ended');
}

/* ---------------- The bar ---------------- */

function showBar() {
  bar?.remove();
  bar = el(`<div class="focus-bar" role="status">
    <svg class="focus-ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="fr-bg" cx="18" cy="18" r="15.5"/><circle class="fr-fg" cx="18" cy="18" r="15.5"/></svg>
    <div class="focus-text"><b></b><small></small></div>
    <button class="fb-btn" data-f="pause" title="Pause"></button>
    <button class="fb-btn" data-f="plus" title="Add 5 minutes">+5</button>
    <button class="fb-btn fb-end" data-f="end" title="End the session">End</button>
  </div>`);
  document.body.append(bar);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    if (b.dataset.f === 'pause') s?.pausedAt ? resumeFocus() : pauseFocus();
    else if (b.dataset.f === 'plus') extendFocus(5);
    else if (b.dataset.f === 'end') endFocus();
  });
}

function drawBar() {
  if (!bar || !s) return;
  const total = (s.phase === 'focus' ? s.focusMin : s.breakMin) * MIN;
  const left = remaining();
  const frac = total ? 1 - left / total : 1;
  const C = 2 * Math.PI * 15.5;
  const key = `${s.phase}${s.round}`;
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    bar.classList.toggle('break', s.phase === 'break');
  }
  bar.classList.toggle('paused', !!s.pausedAt);
  $('.fr-fg', bar).style.strokeDasharray = `${C * frac} ${C}`;
  $('.focus-text b', bar).textContent = s.phase === 'focus' ? s.title : 'Break';
  $('.focus-text small', bar).textContent = `${s.pausedAt ? 'Paused · ' : ''}${s.phase === 'focus' ? 'Focus' : 'Break'}${s.rounds > 1 ? ` · round ${s.round} of ${s.rounds}` : ''} — ${mmss(left)}`;
  $('[data-f=pause]', bar).innerHTML = icon(s.pausedAt ? 'play' : 'pause', 13);
  $('[data-f=pause]', bar).title = s.pausedAt ? 'Resume' : 'Pause';
}

/** A short, soft two-note chime. */
function chime(kind) {
  try {
    const ctx = new AudioContext();
    const notes = kind === 'break' ? [660, 880] : kind === 'done' ? [660, 880, 1100] : [880, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.45);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

/** Resume a session after a reload or restart. */
export function initFocus() {
  const saved = load();
  if (saved && saved.phaseEnd && Date.now() < saved.phaseEnd + 24 * 3600_000) {
    s = { ...saved, put: [] }; // windows were already put away; the new session can't know which
    if (s.pausedAt) s.pausedAt = Date.now(); // treat the downtime as a pause
    begin();
  } else {
    try {
      localStorage.removeItem(LS);
    } catch {}
  }
  // "End focus session" buttons elsewhere (e.g. the blocked-site page).
  document.addEventListener('click', (e) => e.target.closest?.('[data-focus-end]') && endFocus());
  // Started or ended from the phone.
  store.addEventListener('change', (e) => (e.detail.col === 'focus' || e.detail.col === '*') && onRemoteFocus());
  onRemoteFocus();
}
