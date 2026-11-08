// Task reminders on the desktop. A task with `remindAt` ("YYYY-MM-DDTHH:MM", local time) pops a card at that
// time with Done / Snooze / Open; it stays until you act on it. In the desktop app a system notification is shown
// too when Leafdeck isn't the focused window.
import { store } from './store.js';
import { shell } from './shell.js';
import { $, el, esc, fmtTime, relDay } from './util.js';
import { icon } from './icons.js';
import { openApp } from './wm.js';
import { schemas } from './schemas.js';

const LS = 'ws:reminded'; // { taskId: remindAt it already fired for } — per device, so each device reminds once
const LATE_LIMIT = 12 * 3600_000; // a reminder missed by more than this (computer was off) is skipped
const TICK = 15_000;

const pad = (n) => String(n).padStart(2, '0');
/** A Date as the local "YYYY-MM-DDTHH:MM" the remindAt field uses. */
export const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const remindTime = (t) => (t?.remindAt ? new Date(t.remindAt).getTime() : NaN);

let fired = {};
try {
  fired = JSON.parse(localStorage.getItem(LS)) || {};
} catch {}
const saveFired = () => {
  try {
    localStorage.setItem(LS, JSON.stringify(fired));
  } catch {}
};

let box = null;
const shown = new Map(); // taskId → card element

export function initReminders() {
  box = el('<div id="reminders" aria-live="assertive"></div>');
  document.body.append(box);
  check();
  setInterval(check, TICK);
  addEventListener('focus', check);
  // A task finished, deleted or rescheduled elsewhere (here or on the phone): drop its card.
  store.addEventListener('change', (e) => {
    if (!['tasks', '*'].includes(e.detail.col)) return;
    for (const [id, card] of shown) {
      const t = store.get('tasks', id);
      if (!t || t.status === 'Done' || t.remindAt !== card.dataset.at) close(id);
    }
    check();
  });
}

function check() {
  const now = Date.now();
  // Forget fired entries for tasks that no longer exist, so the map doesn't grow forever.
  const tasks = store.all('tasks');
  for (const id of Object.keys(fired)) if (!tasks.some((t) => t.id === id)) delete fired[id];
  for (const t of tasks) {
    if (!t.remindAt || t.status === 'Done' || fired[t.id] === t.remindAt) continue;
    const at = remindTime(t);
    if (!(at <= now)) continue;
    fired[t.id] = t.remindAt;
    if (now - at > LATE_LIMIT) continue;
    show(t);
  }
  saveFired();
}

function detail(t) {
  const due = t.due ? relDay(t.due) + (t.dueTime ? ` at ${fmtTime(t.dueTime)}` : '') : '';
  return due ? `Due ${due}` : '';
}

function show(t) {
  close(t.id);
  const sub = detail(t);
  const card = el(`<div class="reminder" role="alertdialog" data-at="${esc(t.remindAt)}">
    <div class="rm-head"><span class="rm-ic">${icon('clock', 15)}</span><span class="rm-kind">Reminder</span>
      <button class="rm-x" data-rm="dismiss" title="Dismiss">${icon('x', 13)}</button></div>
    <b class="rm-title">${esc(schemas.tasks.title(t))}</b>${sub ? `<small class="rm-sub">${esc(sub)}</small>` : ''}
    <div class="rm-acts"><button class="btn small primary" data-rm="done">${icon('tick', 12)} Done</button>
      <button class="btn small" data-rm="snooze">Snooze 10 min</button><button class="btn small" data-rm="open">Open</button></div></div>`);
  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-rm]')?.dataset.rm;
    if (!act) return;
    const cur = store.get('tasks', t.id);
    if (act === 'done' && cur) store.save('tasks', { ...cur, status: 'Done', completedAt: Date.now() });
    if (act === 'snooze' && cur) store.save('tasks', { ...cur, remindAt: localStamp(new Date(Date.now() + 10 * 60_000)) });
    if (act === 'open') openApp('tasks', { record: t.id });
    close(t.id);
  });
  box.append(card);
  shown.set(t.id, card);
  chime();
  // Windows notification when Leafdeck isn't in front (clicking it brings Leafdeck forward, card waiting).
  if (shell?.notify && !document.hasFocus()) shell.notify({ title: schemas.tasks.title(t), body: sub || 'Task reminder' });
}

function close(id) {
  const card = shown.get(id);
  if (!card) return;
  shown.delete(id);
  card.classList.add('out');
  setTimeout(() => card.remove(), 250);
}

/** Two soft notes, quieter than the focus-session chime. */
function chime() {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16);
      o.stop(ctx.currentTime + i * 0.16 + 0.55);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {}
}
