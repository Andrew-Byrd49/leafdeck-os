// Morning briefing: a full-screen summary of the day that comes up over the whole desktop once a day at a set time
// (9:00 on weekdays by default). Schedule, today's top 3, inbox and this week's tasks; sections, time and
// days are customizable from the briefing itself (⚙) or Settings → Desktop.
//
// Timing: shows at the set time; if Leafdeck is closed then, it shows the first time you use it that morning (until
// noon, or three hours after the set time if that's later). Never interrupts a focus session or typing: it waits
// and offers itself with a toast instead. "Seen today" is a synced pref, so a second computer won't show it again.
import { store } from './store.js';
import { $, $$, el, esc, today, addDays, relDay, fmtTime } from './util.js';
import { icon } from './icons.js';
import { openApp, toast } from './wm.js';
import { schemas } from './schemas.js';
import { integrations, gmailAccounts, fetchMail, available as cloudAvailable } from './integrations.js';
import { focusSession, openFocusSetup } from './focus.js';

export const SECTIONS = {
  schedule: { label: 'Schedule', icon: 'calendar', wide: true },
  top3: { label: 'Today’s top 3', icon: 'target', wide: true },
  inbox: { label: 'Inbox', icon: 'mail' },
  week: { label: 'This week', icon: 'flag' },
};
const DEFAULTS = { enabled: true, time: '09:00', days: [1, 2, 3, 4, 5], order: Object.keys(SECTIONS), hidden: [], sound: true };
const LS_SNOOZE = 'ws:briefing-snooze';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const briefingConfig = () => {
  const c = { ...DEFAULTS, ...(store.prefs.briefing || {}) };
  // Sections added in later versions show up at the end of an older saved order.
  c.order = [...c.order.filter((k) => SECTIONS[k]), ...Object.keys(SECTIONS).filter((k) => !c.order.includes(k))];
  return c;
};
const saveConfig = (patch) => store.setPrefs({ briefing: { ...briefingConfig(), ...patch } });

/** Today's top 3 task ids (empty if none were picked today). Shown first in the Today widget. */
export const todaysTop3 = () => (store.prefs.top3?.date === today() ? store.prefs.top3.ids || [] : []);

/* ---------------- Scheduling ---------------- */

let overlay = null;
let lastKey = 0;
let offeredOn = '';

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function isDue(now = new Date()) {
  const c = briefingConfig();
  if (!c.enabled || !c.days.includes(now.getDay())) return false;
  if (store.prefs.briefingSeen === today()) return false;
  let snooze = 0;
  try {
    snooze = Number(localStorage.getItem(LS_SNOOZE)) || 0;
  } catch {}
  if (snooze > Date.now()) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(c.time);
  return mins >= start && mins <= Math.max(12 * 60, start + 180);
}

/** A focus session, or you were typing a moment ago: offer the briefing instead of covering your work. */
function busy() {
  if (focusSession()?.phase === 'focus') return 'focus';
  const ae = document.activeElement;
  const typing = ae && (ae.matches?.('input, textarea, select, [contenteditable], [contenteditable] *') || ae.tagName === 'WEBVIEW');
  if (typing && Date.now() - lastKey < 20_000) return 'typing';
  return '';
}

function tick() {
  if (overlay || store.mode === 'loading' || !isDue()) return;
  if (busy()) {
    if (offeredOn !== today()) {
      offeredOn = today();
      toast('Your morning briefing is ready', '', { label: 'Open', act: () => openBriefing() });
    }
    return;
  }
  openBriefing({ auto: true });
}

export function initBriefing() {
  addEventListener('keydown', () => (lastKey = Date.now()), true);
  setInterval(tick, 30_000);
  addEventListener('focus', () => setTimeout(tick, 1500));
  document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(tick, 1500));
  setTimeout(tick, 4000); // after the desktop has drawn
}

/* ---------------- Data ---------------- */

const isOpenTask = (t) => t.status !== 'Done';
const PRI = { High: 0, Medium: 1, Low: 2 };

function gather() {
  const t0 = today();
  const events = store.all('events').filter((e) => e.date === t0 || (e.date < t0 && e.endDate && e.endDate >= t0));
  const timed = events.filter((e) => e.time && e.date === t0).sort((a, b) => a.time.localeCompare(b.time));
  const allDay = events.filter((e) => !e.time || e.date !== t0);

  const tasks = store.all('tasks').filter(isOpenTask);
  const overdue = tasks.filter((t) => t.due && t.due < t0);
  const dueToday = tasks.filter((t) => t.due === t0);
  // Candidates for the top 3: late first, then today, in progress, the next few days; high priority first in each.
  const rank = (t) => (t.due && t.due < t0 ? 0 : t.due === t0 ? 1 : t.status === 'In Progress' ? 2 : t.due && t.due <= addDays(3) ? 3 : 4);
  const candidates = tasks
    .filter((t) => rank(t) < 4 || t.priority === 'High')
    .sort((a, b) => rank(a) - rank(b) || (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1) || (a.due || '9').localeCompare(b.due || '9'))
    .slice(0, 8);

  const weekEnd = addDays(7);
  const week = tasks
    .filter((t) => t.due > t0 && t.due <= weekEnd)
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((t) => ({ date: t.due, label: t.title, col: 'tasks', id: t.id }));

  return { timed, allDay, overdue, dueToday, candidates, week, freeBlocks: freeBlocks(timed) };
}

/** Gaps of an hour or more between 8 AM and 6 PM, from today's timed events (an hour long if no end time). */
function freeBlocks(timed) {
  const toMin = (t) => minutesOf(t);
  const now = new Date();
  let cursor = Math.max(8 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30); // from the next half hour
  const out = [];
  for (const e of timed) {
    const s = toMin(e.time);
    const end = e.endTime ? toMin(e.endTime) : s + 60;
    if (s - cursor >= 60) out.push([cursor, s]);
    cursor = Math.max(cursor, end);
  }
  if (18 * 60 - cursor >= 60) out.push([cursor, 18 * 60]);
  const fmt = (m) => fmtTime(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
  return out.slice(0, 3).map(([a, b]) => `${fmt(a)}–${fmt(b)}`);
}

function summaryLine(d, unread) {
  const parts = [];
  const n = (k, one, many) => (k ? `${k} ${k === 1 ? one : many}` : '');
  parts.push(n(d.timed.length, 'meeting', 'meetings'));
  parts.push(n(d.dueToday.length, 'task due', 'tasks due'));
  if (d.overdue.length) parts.push(n(d.overdue.length, 'overdue task', 'overdue tasks'));
  if (unread) parts.push(`${unread} unread email${unread === 1 ? '' : 's'}`);
  const list = parts.filter(Boolean);
  if (!list.length) return 'A clear calendar and nothing due. A good day to get ahead.';
  if (list.length === 1) return `${cap(list[0])} today.`;
  if (list.length === 2) return `${cap(list[0])} and ${list[1]}.`;
  return `${cap(list.slice(0, -1).join(', '))}, and ${list[list.length - 1]}.`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------- The overlay ---------------- */

export function openBriefing({ auto = false } = {}) {
  if (overlay) return;
  const c = briefingConfig();
  const d = gather();
  const name = (store.prefs.userName || '').trim().split(/\s+/)[0];
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const picked = new Set(todaysTop3().length ? todaysTop3() : d.candidates.slice(0, 3).map((t) => t.id));

  overlay = el(`<div class="bf" role="dialog" aria-modal="true" aria-label="Morning briefing">
    <div class="bf-bg"></div>
    <div class="bf-scroll"><div class="bf-in">
      <header class="bf-head">
        <div><small>${esc(now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))} · ${esc(now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</small>
          <h1>${esc(greeting)}${name ? `, ${esc(name)}` : ''}</h1>
          <p class="bf-summary">${esc(summaryLine(d, 0))}</p></div>
        <div class="bf-head-btns"><button class="bf-round" data-bf="custom" title="Customize briefing">${icon('sliders', 16)}</button>
          <button class="bf-round" data-bf="done" title="Close (Esc)">${icon('x', 16)}</button></div>
      </header>
      <div class="bf-stats">
        ${stat('Meetings', d.timed.length)}
        ${stat('Tasks due', d.dueToday.length + d.overdue.length, d.overdue.length ? `${d.overdue.length} overdue` : '')}
        <div class="bf-stat" data-unread><small>Unread mail</small><b>—</b></div>
        ${stat('Due this week', d.week.length)}
      </div>
      <div class="bf-grid">${c.order.filter((k) => !c.hidden.includes(k)).map((k) => section(k, d, picked)).join('')}</div>
      <footer class="bf-foot">
        <button class="btn" data-bf="snooze">Remind me in 30 min</button>
        <button class="btn" data-bf="focus">${icon('target', 13)} Start a focus session</button>
        <button class="btn primary" data-bf="done">Start my day ${icon('right', 13)}</button>
      </footer>
    </div></div>
  </div>`);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay?.classList.add('on'));
  if (auto && c.sound) chime();
  wire(overlay, d, picked);
  loadInbox(overlay, d);
  setTimeout(() => $('[data-bf=done].primary', overlay)?.focus({ preventScroll: true }), 50);
}

const stat = (label, value, sub = '', cls = '') =>
  `<div class="bf-stat ${cls}"><small>${esc(label)}</small><b>${esc(String(value))}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;

function section(key, d, picked) {
  const s = SECTIONS[key];
  const head = `<h2>${icon(s.icon, 14)} ${esc(s.label)}</h2>`;
  let body = '';
  if (key === 'schedule') {
    const rows = [
      ...d.allDay.map((e) => row(e, 'All day')),
      ...d.timed.map((e) => row(e, fmtTime(e.time) + (e.endTime ? `–${fmtTime(e.endTime)}` : ''))),
    ];
    body = rows.length ? `<div class="bf-list">${rows.join('')}</div>` : '<p class="bf-empty">No meetings today.</p>';
    if (d.freeBlocks.length) body += `<p class="bf-note">${icon('clock', 12)} Free: ${esc(d.freeBlocks.join(', '))}</p>`;
  } else if (key === 'top3') {
    body = d.candidates.length
      ? `<p class="bf-note">Pick up to three. They stay at the top of your Today widget until tomorrow.</p>
        <div class="bf-top3">${d.candidates
          .map((t) => {
            const late = t.due && t.due < today();
            const when = t.due ? (late ? `${relDay(t.due)} · late` : relDay(t.due)) : t.status;
            return `<label class="bf-pick${late ? ' late' : ''}"><input type="checkbox" data-pick="${esc(t.id)}" ${picked.has(t.id) ? 'checked' : ''}>
              <span><b>${esc(t.title)}</b><small>${esc([when, t.priority === 'High' ? 'High' : ''].filter(Boolean).join(' · '))}</small></span></label>`;
          })
          .join('')}</div>`
      : '<p class="bf-empty">Nothing due soon. Add a task to make it today’s priority.</p>';
    body += `<form class="bf-add"><input placeholder="Add a task for today" aria-label="Add a task for today"><button class="btn small">Add</button></form>`;
  } else if (key === 'inbox') {
    body = '<div class="bf-inbox"><p class="bf-empty">Loading…</p></div>';
  } else if (key === 'week') {
    body = d.week.length
      ? `<div class="bf-list">${d.week
          .slice(0, 5)
          .map((w) => `<button class="bf-row" data-open="${w.col}:${esc(w.id)}"><span>${esc(relDay(w.date))}</span><b>${esc(w.label)}</b></button>`)
          .join('')}</div>`
      : '<p class="bf-empty">No tasks due in the next 7 days.</p>';
  }
  return `<section class="bf-card${s.wide ? ' wide' : ''}" data-section="${key}">${head}${body}</section>`;
}

const row = (e, when) => `<button class="bf-row" data-open="events:${esc(e.id)}"><span>${esc(when)}</span><b>${esc(e.title)}</b>${e.location ? `<small>${esc(e.location)}</small>` : ''}</button>`;

async function loadInbox(root, d) {
  const box = $('.bf-inbox', root);
  const statEl = $('[data-unread] b', root);
  const setUnread = (n) => {
    if (statEl) statEl.textContent = n == null ? '—' : String(n);
    if (n) $('.bf-summary', root).textContent = summaryLine(d, n);
  };
  if (!cloudAvailable()) {
    if (box) box.innerHTML = '<p class="bf-empty">Mail needs your Leafdeck server.</p>';
    return setUnread(null);
  }
  for (let i = 0; i < 20 && !integrations.loaded; i++) await new Promise((r) => setTimeout(r, 250));
  const accts = gmailAccounts().filter((a) => a.gmail);
  if (!accts.length) {
    if (box) box.innerHTML = '<p class="bf-empty">Connect Google in Settings to see your inbox here.</p>';
    return setUnread(null);
  }
  let unread = 0;
  const msgs = [];
  await Promise.all(
    accts.slice(0, 3).map(async (a) => {
      try {
        const r = await fetchMail(a.id, { max: 5, unreadOnly: true });
        unread += r.unreadCount || 0;
        for (const m of r.messages || []) msgs.push({ ...m, account: r.email || a.name });
      } catch {}
    }),
  );
  if (!overlay || !root.isConnected) return;
  setUnread(unread);
  msgs.sort((a, b) => new Date(b.date) - new Date(a.date));
  if (box)
    box.innerHTML = msgs.length
      ? `<div class="bf-list">${msgs
          .slice(0, 4)
          .map((m) => `<button class="bf-row" data-mail="${esc(m.account || '')}"><b>${esc(m.from || m.fromEmail || 'Unknown')}</b><small>${esc(m.subject || '(no subject)')}</small></button>`)
          .join('')}</div>`
      : '<p class="bf-empty">Inbox zero. Nothing unread.</p>';
}

function wire(root, d, picked) {
  const limit = () => {
    const boxes = $$('[data-pick]', root);
    const n = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => (b.disabled = !b.checked && n >= 3));
  };
  limit();
  root.addEventListener('change', (e) => {
    if (!e.target.matches('[data-pick]')) return;
    e.target.checked ? picked.add(e.target.dataset.pick) : picked.delete(e.target.dataset.pick);
    limit();
  });
  root.addEventListener('submit', (e) => {
    if (!e.target.matches('.bf-add')) return;
    e.preventDefault();
    const input = $('input', e.target);
    const title = input.value.trim();
    if (!title) return input.focus();
    const t = store.save('tasks', { title, status: 'To Do', priority: 'Medium', due: today() });
    input.value = '';
    let list = $('.bf-top3', root);
    if (!list) {
      // No candidates yet: swap the empty message for a list.
      list = el('<div class="bf-top3"></div>');
      $('[data-section=top3] .bf-empty', root)?.replaceWith(list);
    }
    const label = el(`<label class="bf-pick"><input type="checkbox" data-pick="${esc(t.id)}"><span><b>${esc(t.title)}</b><small>Today</small></span></label>`);
    list.prepend(label);
    const cb = $('input', label);
    if ([...picked].length < 3) {
      cb.checked = true;
      picked.add(t.id);
    }
    limit();
  });
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-bf]')?.dataset.bf;
    if (act === 'done') return close(picked);
    if (act === 'snooze') {
      try {
        localStorage.setItem(LS_SNOOZE, String(Date.now() + 30 * 60_000));
      } catch {}
      toast('Briefing in 30 minutes');
      return close(picked, { seen: false });
    }
    if (act === 'focus') {
      close(picked);
      return openFocusSetup();
    }
    if (act === 'custom') return customize(root);
    const open = e.target.closest('[data-open]');
    if (open) {
      const [col, id] = open.dataset.open.split(':');
      close(picked);
      return openApp(schemas[col].app, { record: id });
    }
    if (e.target.closest('[data-mail]')) {
      close(picked);
      return import('./apps/browser.js').then((b) => b.openWebPage('https://mail.google.com/mail/'));
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('.bf-custom', root)) close(picked);
  });
}

function close(picked, { seen = true } = {}) {
  if (!overlay) return;
  const patch = { top3: { date: today(), ids: [...picked].slice(0, 3) } };
  if (seen) patch.briefingSeen = today();
  store.setPrefs(patch);
  const o = overlay;
  overlay = null;
  o.classList.remove('on');
  setTimeout(() => o.remove(), 260);
}

/* ---------------- Customize ---------------- */

function customize(root) {
  const c = briefingConfig();
  const panel = el(`<div class="bf-custom" role="dialog" aria-label="Customize briefing">
    <div class="bf-custom-in">
      <h2>Customize your briefing</h2>
      <label class="bf-opt"><span>Show the briefing</span><input type="checkbox" data-c="enabled" ${c.enabled ? 'checked' : ''}></label>
      <label class="bf-opt"><span>Time</span><input type="time" data-c="time" value="${esc(c.time)}"></label>
      <div class="bf-opt"><span>Days</span><div class="bf-days">${DAY_NAMES.map((n, i) => `<button type="button" class="${c.days.includes(i) ? 'on' : ''}" data-day="${i}">${n}</button>`).join('')}</div></div>
      <label class="bf-opt"><span>Play a sound</span><input type="checkbox" data-c="sound" ${c.sound ? 'checked' : ''}></label>
      <h3>Sections</h3>
      <ul class="bf-sections">${c.order
        .map((k, i) => `<li><label><input type="checkbox" data-show="${k}" ${c.hidden.includes(k) ? '' : 'checked'}> ${icon(SECTIONS[k].icon, 13)} ${esc(SECTIONS[k].label)}</label>
          <span><button type="button" class="icon-btn" data-move="${k}:-1" ${i === 0 ? 'disabled' : ''} title="Move up">${icon('up', 12)}</button>
          <button type="button" class="icon-btn" data-move="${k}:1" ${i === c.order.length - 1 ? 'disabled' : ''} title="Move down">${icon('down', 12)}</button></span></li>`)
        .join('')}</ul>
      <div class="bf-custom-foot"><button class="btn" data-c-preview>Preview with these settings</button><button class="btn primary" data-c-done>Done</button></div>
    </div></div>`);
  root.append(panel);
  const read = () => ({
    enabled: $('[data-c=enabled]', panel).checked,
    time: $('[data-c=time]', panel).value || '09:00',
    days: $$('[data-day].on', panel).map((b) => Number(b.dataset.day)),
    sound: $('[data-c=sound]', panel).checked,
    order: $$('[data-show]', panel).map((b) => b.dataset.show),
    hidden: $$('[data-show]', panel).filter((b) => !b.checked).map((b) => b.dataset.show),
  });
  panel.addEventListener('click', (e) => {
    const day = e.target.closest('[data-day]');
    if (day) day.classList.toggle('on');
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const [k, dir] = mv.dataset.move.split(':');
      const li = $(`[data-show="${k}"]`, panel).closest('li');
      const other = Number(dir) < 0 ? li.previousElementSibling : li.nextElementSibling;
      if (other) Number(dir) < 0 ? other.before(li) : other.after(li);
      $$('li', panel).forEach((x, i, all) => {
        $('[data-move$=":-1"]', x).disabled = i === 0;
        $('[data-move$=":1"]', x).disabled = i === all.length - 1;
      });
    }
    if (e.target.closest('[data-c-done]') || e.target.closest('[data-c-preview]')) {
      saveConfig(read());
      panel.remove();
      if (e.target.closest('[data-c-preview]')) {
        overlay?.remove();
        overlay = null;
        openBriefing();
      } else toast('Briefing settings saved');
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      panel.remove();
    }
  });
  $('[data-c=time]', panel).focus();
}

/** Open the customize panel without waiting for the morning (from Settings). */
export function customizeBriefing() {
  openBriefing();
  if (overlay) customize(overlay);
}

/* ---------------- Sound ---------------- */

function chime() {
  try {
    const ctx = new AudioContext();
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 1);
    });
    setTimeout(() => ctx.close(), 2000);
  } catch {}
}
