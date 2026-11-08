// Tasks: the planner window.
//   left   — All / Tags
//   center — Today, Week, Month or Archive: sprints first, then tasks, with inline "Add" rows
//   right  — a day or week timeline of events (local + synced) and sprints
// A sprint is a block of time on one day that groups the tasks you'll work through in it (sprints collection);
// tasks point at it with sprintId.
import { store } from '../store.js';
import { $, $$, esc, today, addDays, parseDate, isoDate, relDay, fmtTime } from '../util.js';
import { remindTime } from '../reminders.js';
import { icon } from '../icons.js';
import { registerApp, toast } from '../wm.js';
import { editRecord, refName, splitTags, taskTags, hostLabel } from '../schemas.js';
import { seg, empty } from './collection.js';
import { toggleTask, taskSort } from './business.js';
import { calendarItems } from './calendar.js';
import { openWebPage } from './browser.js';
import { shell } from '../shell.js';

const HOUR_H = 44; // timeline pixels per hour
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const openPage = (url) => (shell ? openWebPage(url) : window.open(url, '_blank', 'noopener'));

/* ---------- dates & times ---------- */

const mins = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** "09:30" → "9:30am", "14:00" → "2pm" */
const hm = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
};
const span = (a, b) => (a ? `${hm(a)}${b ? ' – ' + hm(b) : ''}` : '');
const weekStart = (iso) => {
  const d = parseDate(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start Monday
  return isoDate(d);
};
const monthStart = (iso) => iso.slice(0, 8) + '01';
const monthEnd = (iso) => {
  const d = parseDate(monthStart(iso));
  d.setMonth(d.getMonth() + 1, 0);
  return isoDate(d);
};
const shiftMonth = (iso, n) => {
  const d = parseDate(monthStart(iso));
  d.setMonth(d.getMonth() + n);
  return isoDate(d);
};
const shift = (iso, n) => addDays(n, parseDate(iso));
const dayLabel = (iso, long = false) => parseDate(iso).toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
const monthLabel = (iso) => parseDate(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const rangeLabel = (a, b) => {
  const da = parseDate(a);
  const db = parseDate(b);
  const same = da.getMonth() === db.getMonth();
  return `${da.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${db.toLocaleDateString('en-US', same ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
};
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

function range(view, anchor) {
  if (view === 'week') {
    const s = weekStart(anchor);
    return [s, shift(s, 6)];
  }
  if (view === 'month') return [monthStart(anchor), monthEnd(anchor)];
  return [anchor, anchor];
}

/* ---------- filters ---------- */

const navTag = (nav) => (nav.startsWith('tag:') ? nav.slice(4) : '');
const navMatch = (nav) => (t) => (nav.startsWith('tag:') ? splitTags(t.tags).includes(nav.slice(4)) : true);
const isOpen = (t) => t.status !== 'Done';
const sprintSort = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '99').localeCompare(b.time || '99') || (a.createdAt || 0) - (b.createdAt || 0);

/** Lay overlapping timed items side by side: each gets .lane and .n (lanes in its cluster). */
function packLanes(list) {
  list.sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = null;
  for (const x of list) {
    if (!cluster || x.start >= cluster.maxEnd) cluster = { items: [], lanes: [], maxEnd: 0 };
    let lane = cluster.lanes.findIndex((end) => end <= x.start);
    if (lane < 0) lane = cluster.lanes.push(0) - 1;
    cluster.lanes[lane] = x.end;
    cluster.maxEnd = Math.max(cluster.maxEnd, x.end);
    cluster.items.push(x);
    x.lane = lane;
    x.cluster = cluster;
  }
  for (const x of list) x.n = x.cluster.lanes.length;
  return list;
}

/* ---------- the app ---------- */

registerApp({
  id: 'tasks',
  name: 'Tasks',
  icon: 'check',
  color: 'orange',
  size: [1360, 800],
  min: [760, 520],
  newLabel: 'Task',
  create: (win, defaults) => editRecord(win, 'tasks', null, defaults),
  openRecord(win, id) {
    const t = store.get('tasks', id);
    if (t) return editRecord(win, 'tasks', t);
    const s = store.get('sprints', id);
    if (s) editRecord(win, 'sprints', s);
  },

  mount(win) {
    const st = {
      view: 'today', // today | week | month | archive
      anchor: today(), // the day (or a day in the week / month) the center shows
      nav: 'all', // all | tag:<name>
      q: '',
      tl: 'day', // timeline: day | week
      sel: today(), // timeline day (or a day in its week)
      collapsed: new Set(),
      inline: null, // an "Add…" row that's open: task:<sprintId> | day:<iso> | sprint:<iso>
    };

    win.tools.innerHTML = `
      ${seg('view', [['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['archive', 'Archive']], st.view)}
      <label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search tasks"></label>
      <button class="tb-btn" data-act="new" title="New task">${icon('plus', 16)}</button>`;

    /* ----- rows ----- */

    const taskRow = (t, ctx) => {
      const done = t.status === 'Done';
      const tags = splitTags(t.tags);
      const meta = [
        t.url ? `<a class="pl-link" href="${esc(t.url)}" title="${esc(t.url)}">${icon('link', 11)}<span>${esc(hostLabel(t.url) || t.url)}</span></a>` : '',
        ...tags.slice(0, 2).map((x) => `<span class="pl-tag">${icon('tag', 10)}${esc(x)}</span>`),
        tags.length > 2 ? `<span class="pl-more">${tags.length - 2} more…</span>` : '',
        ctx.showDue && t.due && !done ? `<span class="pl-due${t.due < today() ? ' late' : ''}">${esc(relDay(t.due) + (t.dueTime ? ' ' + fmtTime(t.dueTime) : ''))}</span>` : '',
        !ctx.showDue && t.dueTime && !done ? `<span class="pl-due">${esc(fmtTime(t.dueTime))}</span>` : '',
        t.remindAt && !done && remindTime(t) > Date.now() ? `<span class="pl-remind" title="Reminder ${esc(new Date(t.remindAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}">${icon('clock', 11)}</span>` : '',
        ctx.showSprint && t.sprintId && store.get('sprints', t.sprintId) ? `<span class="pl-tag">${icon('bolt', 10)}${esc(refName('sprints', t.sprintId))}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="pl-task${done ? ' done' : ''}" data-task="${t.id}" draggable="true">
        <button class="chk${done ? ' on' : ''}" data-toggle="${t.id}" aria-label="Toggle done">${icon('tick', 11, 3)}</button>
        <div class="pl-main"><b>${esc(t.title)}</b>${meta ? `<span class="pl-meta">${meta}</span>` : ''}</div>
      </div>`;
    };

    const addRow = (key, label) => `<button class="pl-add" data-add="${esc(key)}">${icon(key.startsWith('sprint') ? 'bolt' : 'plus', 12)} ${label}</button>`;

    const sprintBlock = (s, tasks, ctx) => {
      const open = tasks.filter(isOpen).length;
      const collapsed = st.collapsed.has(s.id);
      const when = [span(s.time, s.endTime), ctx.showDate ? dayLabel(s.date) : ''].filter(Boolean).join(' · ');
      return `<section class="pl-sprint${collapsed ? ' collapsed' : ''}${s.status === 'Done' ? ' done' : ''} c-orange" data-sprint="${s.id}">
        <header>
          <span class="pl-bolt">${icon('bolt', 14)}</span>
          <button class="pl-sprint-name" data-open-sprint="${s.id}" title="Open this sprint"><b>${esc(s.name)}</b>${when ? `<small>${esc(when)}</small>` : ''}</button>
          <small class="pl-count">${open ? `${open} task${open === 1 ? '' : 's'}` : tasks.length ? 'All done' : 'No tasks yet'}</small>
          <button class="icon-btn" data-collapse="${s.id}" title="${collapsed ? 'Show tasks' : 'Hide tasks'}">${icon(collapsed ? 'left' : 'down', 13)}</button>
        </header>
        <div class="pl-sprint-tasks">${tasks.map((t) => taskRow(t, { ...ctx, showDue: false })).join('')}${addRow('task:' + s.id, 'Add a task')}</div>
      </section>`;
    };

    const dayGroup = (iso, tasks, ctx) => `<div class="pl-group" data-day="${iso}">
        <h3 class="pl-day${iso === today() ? ' today' : ''}${iso < today() ? ' past' : ''}">${iso === today() ? 'Today' : esc(dayLabel(iso))}<small>${tasks.filter(isOpen).length || ''}</small></h3>
        ${tasks.sort(taskSort).map((t) => taskRow(t, ctx)).join('')}${addRow('day:' + iso, 'Add a task')}
      </div>`;

    /* ----- center ----- */

    const centerHTML = () => {
      const match = navMatch(st.nav);
      const all = store.all('tasks').filter(match);
      const ctx = { showDue: false, showSprint: false, showDate: st.view !== 'today' };
      const navTitle = navTag(st.nav) ? '#' + navTag(st.nav) : '';

      if (st.q) {
        const q = st.q.toLowerCase();
        const hits = all.filter((t) => `${t.title} ${t.notes || ''} ${t.tags || ''}`.toLowerCase().includes(q)).sort(taskSort).slice(0, 80);
        return `<header class="pl-head"><h1>Search</h1><small>${hits.length} match${hits.length === 1 ? '' : 'es'}${navTitle ? ' in ' + esc(navTitle) : ''}</small></header>
          <div class="pl-list" data-dropzone="list">${hits.length ? hits.map((t) => taskRow(t, { ...ctx, showDue: true, showSprint: true })).join('') : empty('No matches', 'Try a different search.')}</div>`;
      }

      if (st.view === 'archive') {
        const done = all.filter((t) => t.status === 'Done').sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0));
        const groups = {};
        for (const t of done) (groups[isoDate(new Date(t.completedAt || t.updatedAt || 0))] ||= []).push(t);
        return `<header class="pl-head"><h1>Archive</h1><small>${done.length} completed${navTitle ? ' · ' + esc(navTitle) : ''}</small></header>
          ${done.length ? Object.entries(groups).slice(0, 60).map(([iso, list]) => `<div class="pl-group"><h3 class="pl-day">${esc(relDay(iso))}<small>${list.length}</small></h3>${list.map((t) => taskRow(t, ctx)).join('')}</div>`).join('')
            : empty('Nothing archived yet', 'Tasks you check off land here.')}`;
      }

      const [from, to] = range(st.view, st.anchor);
      const t0 = today();
      const title =
        st.view === 'today' ? (st.anchor === t0 ? 'Today' : st.anchor === shift(t0, 1) ? 'Tomorrow' : st.anchor === shift(t0, -1) ? 'Yesterday' : parseDate(st.anchor).toLocaleDateString('en-US', { weekday: 'long' }))
        : st.view === 'week' ? (from === weekStart(t0) ? 'This Week' : from === weekStart(shift(t0, 7)) ? 'Next Week' : 'Week')
        : from === monthStart(t0) ? 'This Month' : monthLabel(from);
      const sub = st.view === 'today' ? dayLabel(st.anchor, true) : st.view === 'week' ? rangeLabel(from, to) : from === monthStart(t0) ? monthLabel(from) : '';

      // Sprints in the period, or with a tag selected, those holding a matching task.
      const allSprints = [...store.all('sprints')];
      const tasksOf = (s) => store.all('tasks').filter((t) => t.sprintId === s.id);
      const sprints = allSprints
        .filter((s) => s.date >= from && s.date <= to)
        .filter((s) => st.nav === 'all' || tasksOf(s).some(match))
        .sort(sprintSort);
      const shown = new Set(sprints.map((s) => s.id));
      const loose = all.filter((t) => !shown.has(t.sprintId));
      // Finished tasks stay visible on their day (struck through) only for today and later; older ones live in Archive.
      const inRange = loose.filter((t) => t.due && t.due >= from && t.due <= to && (isOpen(t) || t.due >= t0));
      const overdue = st.view === 'today' && st.anchor === t0 ? loose.filter((t) => isOpen(t) && t.due && t.due < t0) : [];
      const unscheduled = st.view === 'today' ? loose.filter((t) => isOpen(t) && !t.due) : [];

      let tasksHTML;
      if (st.view === 'today') {
        tasksHTML = `${overdue.length ? `<div class="pl-group" data-day="${st.anchor}"><h3 class="pl-day late">Overdue<small>${overdue.length}</small></h3>${overdue.sort(taskSort).map((t) => taskRow(t, { ...ctx, showDue: true })).join('')}</div>` : ''}
          <div class="pl-group" data-day="${st.anchor}">${inRange.sort(taskSort).map((t) => taskRow(t, ctx)).join('')}${addRow('day:' + st.anchor, 'Add a task')}</div>
          ${unscheduled.length ? `<details class="pl-someday"${navTitle ? ' open' : ''}><summary>No due date<small>${unscheduled.length}</small></summary><div class="pl-group" data-day="">${unscheduled.sort(taskSort).map((t) => taskRow(t, ctx)).join('')}${addRow('day:', 'Add a task')}</div></details>` : ''}`;
      } else {
        const groups = {};
        for (const t of inRange) (groups[t.due] ||= []).push(t);
        const days = Object.keys(groups).sort();
        // In Week, show every day so there's always a place to add to; in Month, only days with tasks.
        const list = st.view === 'week' ? Array.from({ length: 7 }, (_, i) => shift(from, i)) : days;
        tasksHTML = list.length
          ? list.map((iso) => dayGroup(iso, groups[iso] || [], ctx)).join('')
          : `<div class="pl-group" data-day="${t0 >= from && t0 <= to ? t0 : from}">${empty('Nothing due this month', 'Add a task, or drag one here from another view.')}${addRow('day:' + (t0 >= from && t0 <= to ? t0 : from), 'Add a task')}</div>`;
      }

      const sprintDay = st.view === 'today' ? st.anchor : t0 >= from && t0 <= to ? t0 : from;
      return `<header class="pl-head">
          <button class="icon-btn" data-page="-1" title="Previous">${icon('left', 15)}</button>
          <div class="pl-title"><h1><button data-today title="Back to today">${esc(title)}</button></h1>${sub || navTitle ? `<small>${esc([navTitle, sub].filter(Boolean).join(' · '))}</small>` : ''}</div>
          <button class="icon-btn" data-page="1" title="Next">${icon('right', 15)}</button>
        </header>
        <h2 class="pl-h">Sprints</h2>
        <div class="pl-sprints">${sprints.map((s) => sprintBlock(s, tasksOf(s).filter(match).sort(taskSort), ctx)).join('')}${addRow('sprint:' + sprintDay, 'Create sprint')}</div>
        <h2 class="pl-h">Tasks</h2>
        <div class="pl-list" data-dropzone="list">${tasksHTML}</div>`;
    };

    /* ----- left nav ----- */

    const navHTML = () => {
      const tasks = [...store.all('tasks')];
      const open = tasks.filter(isOpen);
      const tags = taskTags(tasks).slice(0, 14);
      const item = (key, ic, label, n, cls = '') =>
        `<button class="pl-nav-item${st.nav === key ? ' on' : ''}${cls ? ' ' + cls : ''}" data-nav="${esc(key)}">${ic}<span>${esc(label)}</span>${n ? `<em>${n}</em>` : ''}</button>`;
      return `<nav class="pl-nav">
        <div class="pl-nav-scroll">
          ${item('all', icon('check', 15), 'All tasks', open.length)}
          ${tags.length ? `<div class="pl-nav-h">${icon('tag', 13)}<span>Tags</span></div>${tags.map((x) => item('tag:' + x, '<i class="pl-hash">#</i>', x, open.filter((t) => splitTags(t.tags).includes(x)).length)).join('')}` : ''}
        </div>
      </nav>`;
    };

    /* ----- timeline ----- */

    const timelineHTML = () => {
      const items = calendarItems();
      const t0 = today();
      const days = st.tl === 'week' ? Array.from({ length: 7 }, (_, i) => shift(weekStart(st.sel), i)) : [st.sel];
      const label = st.tl === 'week' ? rangeLabel(days[0], days[6]) : st.sel === t0 ? `Today · ${dayLabel(st.sel)}` : dayLabel(st.sel);
      const nowTop = (nowMinutes() / 60) * HOUR_H;

      const chip = (it) => `<button class="tl-chip k-${it.kind}${it.color ? ' has-color' : ''}" ${it.color ? `style="--evc:${esc(it.color)}"` : ''} data-open="${it.col}:${it.r.id}" title="${esc(it.label)}">${esc(it.label)}</button>`;
      const column = (iso) => {
        const list = items[iso] || [];
        const timed = packLanes(
          list
            .filter((it) => it.time)
            .map((it) => {
              const start = mins(it.time);
              const end = it.r.endTime && mins(it.r.endTime) > start ? mins(it.r.endTime) : start + 60;
              return { it, start, end };
            }),
        );
        const blocks = timed
          .map(({ it, start, end, lane, n }) => {
            const h = Math.max(20, ((end - start) / 60) * HOUR_H - 2);
            return `<button class="tl-item k-${it.kind}${it.color ? ' has-color' : ''}${h < 34 ? ' tight' : ''}"
              style="top:${(start / 60) * HOUR_H}px;height:${h}px;left:calc(${(lane / n) * 100}% + 1px);width:calc(${100 / n}% - 3px);${it.color ? `--evc:${esc(it.color)}` : ''}"
              data-open="${it.col}:${it.r.id}" title="${esc(it.label)}"><em>${esc(span(it.time, it.r.endTime))}</em><span>${it.kind === 'sprint' ? icon('bolt', 10) : ''}${esc(it.label)}</span></button>`;
          })
          .join('');
        return `<div class="tl-col${iso === t0 ? ' today' : ''}" data-tl-col="${iso}" style="height:${24 * HOUR_H}px">${blocks}${iso === t0 ? `<i class="tl-now" style="top:${nowTop}px"></i>` : ''}</div>`;
      };
      const allDay = (iso) => {
        const list = (items[iso] || []).filter((it) => !it.time);
        return `<div class="tl-allday-col">${list.slice(0, 3).map(chip).join('')}${list.length > 3 ? `<small class="tl-more">+${list.length - 3} more</small>` : ''}</div>`;
      };

      return `<aside class="pl-tl${st.tl === 'week' ? ' week' : ''}" style="--n:${days.length}">
        <div class="pl-tl-top">${seg('tl', [['week', 'Week'], ['day', 'Day']], st.tl)}</div>
        <div class="pl-tl-nav">
          <button class="icon-btn" data-tl-page="-1" title="Previous">${icon('left', 14)}</button>
          <button class="pl-tl-label" data-tl-today title="Back to today">${esc(label)}</button>
          <button class="icon-btn" data-tl-page="1" title="Next">${icon('right', 14)}</button>
        </div>
        ${st.tl === 'week' ? `<div class="tl-head"><span></span>${days.map((d) => `<button class="tl-dayh${d === t0 ? ' today' : ''}${d === st.sel ? ' sel' : ''}" data-tl-day="${d}"><small>${DOW[parseDate(d).getDay()]}</small><b>${parseDate(d).getDate()}</b></button>`).join('')}</div>` : ''}
        <div class="tl-allday"><span>all day</span>${days.map(allDay).join('')}</div>
        <div class="tl-scroll">
          <div class="tl-grid">
            <div class="tl-hours" style="height:${24 * HOUR_H}px">${Array.from({ length: 24 }, (_, h) => `<span style="top:${h * HOUR_H}px">${h ? hm(toTime(h * 60)) : ''}</span>`).join('')}${days.includes(t0) ? `<b class="tl-now-label" style="top:${nowTop}px">${esc(hm(toTime(nowMinutes())))}</b>` : ''}</div>
            ${days.map(column).join('')}
          </div>
        </div>
      </aside>`;
    };

    /* ----- draw ----- */

    let tlScrolled = false;
    const draw = () => {
      const centerEl = $('.pl-center', win.body);
      const tlEl = $('.tl-scroll', win.body);
      const keep = { center: centerEl?.scrollTop || 0, tl: tlEl?.scrollTop ?? null, nav: $('.pl-nav-scroll', win.body)?.scrollTop || 0 };
      win.body.innerHTML = `<div class="pl">${navHTML()}<main class="pl-center">${centerHTML()}</main>${timelineHTML()}</div>`;
      $('.pl-center', win.body).scrollTop = keep.center;
      $('.pl-nav-scroll', win.body).scrollTop = keep.nav;
      const tl = $('.tl-scroll', win.body);
      if (tl) {
        if (keep.tl != null && tlScrolled) tl.scrollTop = keep.tl;
        else {
          // First draw (or the timeline just came back): start a little before now, or at 8am.
          const m = st.sel === today() || st.tl === 'week' ? nowMinutes() : 8 * 60;
          tl.scrollTop = Math.max(0, (Math.min(m, 8 * 60) / 60) * HOUR_H - 20);
          tlScrolled = true;
        }
      }
      if (st.inline) openInline(st.inline);
    };

    // A live bit that shouldn't redraw everything: the "now" line.
    let lastMinute = -1;
    win.every(1000, () => {
      const minute = nowMinutes();
      if (minute !== lastMinute) {
        lastMinute = minute;
        const top = (minute / 60) * HOUR_H + 'px';
        $$('.tl-now, .tl-now-label', win.body).forEach((el) => (el.style.top = top));
        const lbl = $('.tl-now-label', win.body);
        if (lbl) lbl.textContent = hm(toTime(minute));
      }
    });

    /* ----- inline "Add…" rows ----- */

    function openInline(key) {
      const btn = $(`[data-add="${CSS.escape(key)}"]`, win.body);
      if (!btn) return;
      const isSprint = key.startsWith('sprint:');
      const form = document.createElement('form');
      form.className = 'pl-inline';
      form.dataset.key = key;
      form.innerHTML = `${icon(isSprint ? 'bolt' : 'plus', 12)}<input placeholder="${isSprint ? 'Sprint name — press Enter' : 'Task — press Enter, Esc to close'}" autocomplete="off" spellcheck="false">`;
      btn.replaceWith(form);
      $('input', form).focus();
    }

    function saveInline(form) {
      if (form.dataset.done) return;
      const text = $('input', form).value.trim();
      const key = form.dataset.key;
      if (!text) {
        st.inline = null;
        return draw();
      }
      form.dataset.done = '1';
      const [kind, arg] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const tags = navTag(st.nav);
      if (kind === 'sprint') {
        store.save('sprints', { name: text, date: arg || today(), status: 'Planned' });
      } else if (kind === 'task') {
        const s = store.get('sprints', arg);
        store.save('tasks', { title: text, status: 'To Do', priority: 'Medium', sprintId: arg, due: s?.date || '', tags });
      } else {
        store.save('tasks', { title: text, status: 'To Do', priority: 'Medium', due: arg, tags });
      }
      // The store change redraws; st.inline stays set so the row reopens for the next one.
    }

    win.body.addEventListener('submit', (e) => {
      const form = e.target.closest('form.pl-inline');
      if (!form) return;
      e.preventDefault();
      saveInline(form);
    });
    win.body.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target.closest('form.pl-inline')) {
        st.inline = null;
        draw();
      }
    });
    win.body.addEventListener('focusout', (e) => {
      const form = e.target.closest('form.pl-inline');
      if (!form || form.dataset.done) return;
      // Clicking away: keep what was typed, otherwise close the row.
      if ($('input', form).value.trim()) saveInline(form);
      else {
        st.inline = null;
        setTimeout(draw, 0);
      }
    });

    /* ----- clicks ----- */

    win.tools.addEventListener('input', (e) => {
      if (e.target.type === 'search') {
        st.q = e.target.value.trim();
        draw();
      }
    });
    win.tools.addEventListener('click', (e) => {
      const s = e.target.closest('[data-seg=view] button');
      if (s) {
        st.view = s.dataset.v;
        s.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === s));
        draw();
      }
      if (e.target.closest('[data-act=new]')) editRecord(win, 'tasks', null, { due: st.view === 'today' ? st.anchor : today(), tags: navTag(st.nav) });
    });

    win.body.addEventListener('click', (e) => {
      const t = e.target;
      const nav = t.closest('[data-nav]');
      if (nav) {
        st.nav = nav.dataset.nav;
        return draw();
      }
      const page = t.closest('[data-page]');
      if (page) {
        const n = Number(page.dataset.page);
        st.anchor = st.view === 'week' ? shift(st.anchor, 7 * n) : st.view === 'month' ? shiftMonth(st.anchor, n) : shift(st.anchor, n);
        return draw();
      }
      if (t.closest('[data-today]')) {
        st.anchor = today();
        return draw();
      }
      const tog = t.closest('[data-toggle]');
      if (tog) {
        const r = store.get('tasks', tog.dataset.toggle);
        return r && toggleTask(r);
      }
      const link = t.closest('a.pl-link');
      if (link) {
        e.preventDefault();
        return openPage(link.href);
      }
      const os = t.closest('[data-open-sprint]');
      if (os) return editRecord(win, 'sprints', store.get('sprints', os.dataset.openSprint));
      const col = t.closest('[data-collapse]');
      if (col) {
        const id = col.dataset.collapse;
        st.collapsed.has(id) ? st.collapsed.delete(id) : st.collapsed.add(id);
        return draw();
      }
      const add = t.closest('[data-add]');
      if (add) {
        st.inline = add.dataset.add;
        return openInline(st.inline);
      }
      const tseg = t.closest('[data-seg=tl] button');
      if (tseg) {
        st.tl = tseg.dataset.v;
        tlScrolled = false;
        return draw();
      }
      const tp = t.closest('[data-tl-page]');
      if (tp) {
        st.sel = shift(st.sel, Number(tp.dataset.tlPage) * (st.tl === 'week' ? 7 : 1));
        return draw();
      }
      if (t.closest('[data-tl-today]')) {
        st.sel = today();
        return draw();
      }
      const td = t.closest('[data-tl-day]');
      if (td) {
        st.sel = td.dataset.tlDay;
        st.tl = 'day';
        return draw();
      }
      const open = t.closest('[data-open]');
      if (open) {
        const [c, id] = open.dataset.open.split(':');
        const r = store.get(c, id);
        return r && editRecord(win, c, r);
      }
      const row = t.closest('.pl-task');
      if (row && !t.closest('button, a, input')) {
        const r = store.get('tasks', row.dataset.task);
        return r && editRecord(win, 'tasks', r);
      }
    });

    // Double-click an empty spot on the timeline: a new sprint at that time (snapped to the half hour).
    win.body.addEventListener('dblclick', (e) => {
      const col = e.target.closest('[data-tl-col]');
      if (!col || e.target.closest('[data-open]')) return;
      const m = Math.max(0, Math.min(23 * 60, Math.floor(((e.clientY - col.getBoundingClientRect().top) / HOUR_H) * 2) * 30));
      editRecord(win, 'sprints', null, { date: col.dataset.tlCol, time: toTime(m), endTime: toTime(Math.min(24 * 60 - 1, m + 60)) });
    });

    /* ----- drag tasks between sprints and days ----- */

    let dragId = null;
    win.body.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.pl-task');
      if (!row) return;
      dragId = row.dataset.task;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    const clearDrop = () => $$('.dragging, .drop', win.body).forEach((x) => x.classList.remove('dragging', 'drop'));
    win.body.addEventListener('dragend', () => {
      dragId = null;
      clearDrop();
    });
    const dropTarget = (el) => el.closest('.pl-sprint') || el.closest('[data-day]') || el.closest('[data-dropzone]');
    win.body.addEventListener('dragover', (e) => {
      if (!dragId) return;
      const zone = dropTarget(e.target);
      if (!zone) return;
      e.preventDefault();
      $$('.drop', win.body).forEach((x) => x !== zone && x.classList.remove('drop'));
      zone.classList.add('drop');
    });
    win.body.addEventListener('drop', (e) => {
      if (!dragId) return;
      const zone = dropTarget(e.target);
      const t = store.get('tasks', dragId);
      clearDrop();
      if (!zone || !t) return;
      e.preventDefault();
      if (zone.dataset.sprint) {
        const s = store.get('sprints', zone.dataset.sprint);
        if (!s || t.sprintId === s.id) return;
        store.save('tasks', { ...t, sprintId: s.id, due: t.due || s.date });
        return toast(`Moved to ${s.name}`);
      }
      const day = zone.dataset.day;
      const next = { ...t, sprintId: '' };
      if (day !== undefined) next.due = day; // '' = the "No due date" group
      if (next.sprintId === (t.sprintId || '') && next.due === (t.due || '')) return;
      store.save('tasks', next);
    });

    win.watch(['tasks', 'sprints', 'events', 'settings', 'contacts'], draw);
    draw();
    setTimeout(() => $('input[type=search]', win.tools)?.blur());
  },
});
