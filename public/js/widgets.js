// Widgets: editable boards of widget instances, on the desktop and on the app screen (appscreen.js).
//
// Each board's layout lives in prefs (synced with other settings): widgetLayout for the desktop, appScreenWidgets for
// the app screen, each [{ id, type, size, cfg }].
// Sizes come in cells: s = 1×1, m = 2×1, l = 2×2. Edit mode adds remove / resize / move, an "Add Widget" gallery and
// per-widget options (also available by right-clicking a widget).
//
// On the desktop a widget goes anywhere on any screen: `pos` is { screen (connector name), x, y } from that screen's
// corner, and later in the list is in front. One with no `pos` yet flows into free space from the top corner; saving
// the layout pins what shows, so moving one widget never rearranges the rest. On the app screen, and on a very narrow
// window, a board is a grid and order is all there is.

import { store } from './store.js';
import {
  $, $$, esc, el, uid, today, addDays, relDay, fmtTime, debounce, frame, isoDate,
} from './util.js';
import { icon, appIcon } from './icons.js';
import { openApp, showMenu, toast, getApp, screens, workArea, widgetsHome, desktopHere } from './wm.js';
import { refName, schemas } from './schemas.js';
import { toggleTask, taskSort } from './apps/business.js';
import { calendarItems } from './apps/calendar.js';
import { favicon, openBookmark } from './apps/bookmarks.js';
import { linkAppId } from './apps/system.js';
import { integrations, gmailAccounts, fetchMail, fetchInvite, connectGoogle, onIntegrations, available as cloudAvailable } from './integrations.js';
import { todaysTop3 } from './briefing.js';
import { openWebPage } from './apps/browser.js';
import { shell } from './shell.js';

const CELL = 168;
const GAP = 14;
const SPAN = { s: [1, 1], m: [2, 1], l: [2, 2] };
const SIZE_LABEL = { s: 'Small', m: 'Medium', l: 'Large' };

const openPage = (url) => (shell ? openWebPage(url) : window.open(url, '_blank', 'noopener'));

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const head = (app, ic, title, extra = '') =>
  `<header data-open-app="${app}">${icon(ic, 13)}<span>${esc(title)}</span>${extra}</header>`;
const empty = (ic, text) => `<div class="w-empty">${icon(ic, 20)}<span>${esc(text)}</span></div>`;
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};

/** Big number + subtitle, with optional detail that sits beside it (Medium) or below it (Small). */
const metric = (big, sub, side = '', tone = '') =>
  `<div class="w-metric"><div class="w-metric-main"><div class="w-big ${tone}">${big}</div><div class="w-sub">${sub}</div></div>
    ${side ? `<div class="w-metric-side">${side}</div>` : ''}</div>`;
const bar = (label, pct, cls = '') => `<div class="w-bar ${cls}"><span>${label}</span><i style="--w:${Math.max(0, Math.min(100, pct))}%"></i></div>`;

/* ---------------- Widget types ---------------- */

const TYPES = {
  clock: {
    name: 'Clock',
    desc: 'Time, date and a summary of your day',
    icon: 'clock',
    sizes: ['s', 'm'],
    render(w) {
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, '');
      const ampm = now.getHours() < 12 ? 'AM' : 'PM';
      const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      if (w.size === 's') {
        return `<div class="w-clock w-clock-s"><div class="w-clock-time"><span>${time}</span><small>${ampm}</small></div>
          <div class="w-clock-side"><b>${esc(now.toLocaleDateString('en-US', { weekday: 'long' }))}</b><span>${esc(now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))}</span></div></div>`;
      }
      const tasks = store.all('tasks').filter((t) => t.status !== 'Done' && t.due && t.due <= today()).length;
      const events = store.all('events').filter((e) => e.date === today()).length;
      const name = store.prefs.userName ? `, ${esc(store.prefs.userName)}` : '';
      return `<div class="w-clock">
        <div class="w-clock-time"><span>${time}</span><small>${ampm}</small></div>
        <div class="w-clock-side"><b>${greeting()}${name}</b><span>${esc(date)}</span>
          <small>${tasks} task${tasks === 1 ? '' : 's'} due · ${events} event${events === 1 ? '' : 's'} today</small></div></div>`;
    },
  },

  today: {
    name: 'Today',
    desc: 'Tasks due today, overdue or in progress',
    icon: 'check',
    sizes: ['m', 'l'],
    render(w) {
      // Today's top 3 (picked in the morning briefing) lead the list, starred.
      const top = todaysTop3();
      const list = store
        .all('tasks')
        .filter((t) => t.status !== 'Done' && (top.includes(t.id) || t.status === 'In Progress' || (t.due && t.due <= addDays(1))))
        .sort((a, b) => (top.includes(a.id) ? top.indexOf(a.id) : 9) - (top.includes(b.id) ? top.indexOf(b.id) : 9) || taskSort(a, b));
      const max = w.size === 'l' ? 9 : 3;
      return `${head('tasks', 'check', 'Today', `<em>${list.length}</em>`)}
        <div class="w-tasks">${
          list.length
            ? list.slice(0, max).map((t) => `<div class="w-task">
                <button class="chk" data-toggle-task="${t.id}" aria-label="Complete">${icon('tick', 10, 3)}</button>
                <button class="w-task-main" data-open-rec="tasks:${t.id}"><span>${top.includes(t.id) ? `<i class="w-top3" title="One of today’s top 3">${icon('star', 11)}</i>` : ''}${esc(t.title)}</span>
                <small class="${t.due && t.due < today() ? 'txt-red' : ''}">${esc(t.due ? relDay(t.due) : t.status)}</small></button></div>`).join('')
            : empty('leaf', 'All clear for today')
        }</div>
        ${w.size === 'l' ? `<button class="w-add" data-add-task>${icon('plus', 12)} Add task</button>` : list.length > max ? `<span class="w-more">+${list.length - max} more</span>` : ''}`;
    },
  },

  agenda: {
    name: 'Up next',
    desc: 'Your upcoming events',
    icon: 'calendar',
    sizes: ['s', 'm', 'l'],
    render(w) {
      const list = store
        .all('events')
        .filter((e) => e.date >= today() && e.date <= addDays(w.size === 'l' ? 14 : 7))
        .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
      if (w.size === 's') {
        const e = list[0];
        return `${head('calendar', 'calendar', 'Up next')}${
          e
            ? `<button class="w-next" data-open-rec="events:${e.id}"><small>${esc(relDay(e.date))}${e.time ? ' · ' + esc(fmtTime(e.time)) : ''}</small>
                <b>${esc(e.title)}</b><span>${esc(e.location || refName('contacts', e.contactId) || '')}</span></button>`
            : empty('calendar', 'Nothing this week')
        }`;
      }
      const max = w.size === 'l' ? 7 : 3;
      return `${head('calendar', 'calendar', 'Up next')}
        <div class="w-agenda">${
          list.length
            ? list.slice(0, max).map((e) => `<button class="w-ev" data-open-rec="events:${e.id}"${e.color ? ` style="--bar:${esc(e.color)}"` : ''}>
                <i class="w-ev-bar"></i><span class="w-ev-card"><span class="w-ev-when"><b>${esc(relDay(e.date))}</b><small>${esc(fmtTime(e.time) || 'All day')}</small></span>
                <span class="w-ev-what"><b>${esc(e.title)}</b><small>${esc(e.location || refName('contacts', e.contactId) || '')}</small></span></span></button>`).join('')
            : empty('calendar', `Nothing in the next ${w.size === 'l' ? 14 : 7} days`)
        }</div>`;
    },
  },

  calendar: {
    name: 'Calendar',
    desc: 'This month at a glance',
    icon: 'calendar',
    sizes: ['s', 'm'],
    render(w) {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const start = new Date(first);
      start.setDate(1 - first.getDay());
      const items = calendarItems();
      const t = today();
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        if (i >= 35 && d.getMonth() !== now.getMonth()) break;
        const iso = isoDate(d);
        cells.push(`<span class="${d.getMonth() !== now.getMonth() ? 'out' : ''} ${iso === t ? 'today' : ''} ${items[iso]?.length ? 'has' : ''}">${d.getDate()}</span>`);
      }
      const grid = `<div class="w-cal"><div class="w-cal-title">${esc(now.toLocaleDateString('en-US', { month: 'long' }))}</div>
        <div class="w-cal-dow">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="w-cal-grid" data-open-app="calendar">${cells.join('')}</div></div>`;
      if (w.size === 's') return grid;
      const upcoming = Object.entries(items)
        .filter(([d]) => d >= t)
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([d, list]) => list.map((it) => ({ d, it })))
        .slice(0, 4);
      return `<div class="w-cal-m">${grid}<div class="w-cal-list">${
        upcoming.length
          ? upcoming.map(({ d, it }) => `<button data-open-rec="${it.col}:${it.r.id}"><small>${esc(relDay(d))}${it.time ? ' · ' + esc(fmtTime(it.time)) : ''}</small><b>${esc(it.label)}</b></button>`).join('')
          : empty('calendar', 'Nothing coming up')
      }</div></div>`;
    },
  },

  deadlines: {
    name: 'Deadlines',
    desc: 'Tasks due soon',
    icon: 'flag',
    sizes: ['m', 'l'],
    render(w) {
      const items = calendarItems();
      const t = today();
      const horizon = addDays(14);
      const list = Object.entries(items)
        .filter(([d]) => d <= horizon)
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([d, l]) => l.filter((it) => it.kind !== 'ev').map((it) => ({ d, it })));
      const max = w.size === 'l' ? 9 : 3;
      const KIND = { task: 'check' };
      return `${head('calendar', 'flag', 'Deadlines', list.length ? `<em>${list.length}</em>` : '')}
        <div class="w-dead">${
          list.length
            ? list.slice(0, max).map(({ d, it }) => `<button class="w-dead-row" data-open-rec="${it.col}:${it.r.id}">${icon(KIND[it.kind] || 'flag', 12)}
                <span>${esc(it.label)}</span><small class="${d < t ? 'txt-red' : d <= addDays(2) ? 'txt-yellow' : ''}">${esc(relDay(d))}</small></button>`).join('')
            : empty('tick', 'Nothing due in the next two weeks')
        }</div>`;
    },
  },

  performance: {
    name: 'Performance',
    desc: 'CPU, memory, temperature and battery, live',
    icon: 'activity',
    sizes: ['s', 'm', 'l'],
    render(w) {
      startPerf();
      const body = shell ? perfBody(w.size) : empty('activity', 'Only in the Leafdeck app');
      return `${head('taskmanager', 'activity', 'Performance')}<div class="w-perf" data-pf="${w.size}">${body}</div>`;
    },
  },

  quicknote: {
    name: 'Quick note',
    desc: 'A sticky note on your desktop',
    icon: 'note',
    sizes: ['s', 'm', 'l'],
    render(w) {
      return `${head('notes', 'note', w.cfg?.title || 'Quick note')}
        <textarea class="w-note" data-note-for="${w.id}" placeholder="Jot something down…" spellcheck="false">${esc(w.cfg?.text ?? '')}</textarea>`;
    },
  },

  note: {
    name: 'Pinned note',
    desc: 'Keep one of your notes on the desktop',
    icon: 'pin',
    sizes: ['s', 'm', 'l'],
    configurable: true,
    render(w) {
      const notes = [...store.all('notes')];
      const n = (w.cfg?.noteId && store.get('notes', w.cfg.noteId)) || notes.find((x) => x.pinned) || notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (!n) return `${head('notes', 'pin', 'Pinned note')}${empty('note', 'No notes yet')}`;
      return `${head('notes', 'pin', schemas.notes.title(n))}
        <button class="w-pinned" data-open-rec="notes:${n.id}">${esc(n.format === 'html' ? n.text || '' : n.body || '').replace(/\n/g, '<br>')}</button>`;
    },
    options(w) {
      const notes = [...store.all('notes')].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
      return [{ header: 'Show note' }, ...notes.map((n) => ({ label: schemas.notes.title(n), checked: w.cfg?.noteId === n.id, act: () => setCfg(w.id, { noteId: n.id }) }))];
    },
  },

  gmail: {
    name: 'Gmail',
    desc: 'Recent inbox from a Google account — add one widget per account',
    icon: 'mail',
    sizes: ['s', 'm', 'l'],
    configurable: true,
    render(w) {
      const acct = mailAccount(w);
      const st = mail.get(w.id) || {};
      const email = st.data?.email || acct?.name || '';
      const unread = st.data?.unreadCount;
      const title = w.cfg?.unreadOnly ? 'Unread' : 'Inbox';
      const header = `<header data-open-url="${esc(gmailUrl(email))}" title="${esc(email || 'Open Gmail')}">${icon('mail', 13)}<span>${title}</span>${gmailAccounts().length > 1 && email ? `<small class="w-acct">${esc(email)}</small>` : ''}${
        unread > 0 ? `<em>${unread > 99 ? '99+' : unread}</em>` : ''
      }</header>`;
      if (!cloudAvailable()) return `${header}${empty('mail', 'Mail needs your Leafdeck server — check Settings → Leafdeck app')}`;
      if (!acct) {
        if (!integrations.loaded) return `${header}${empty('mail', 'Loading…')}`;
        return `${header}<div class="w-empty">${icon('mail', 20)}<span>${
          integrations.googleConfigured ? 'Connect a Google account to see your inbox' : 'Google sign-in isn’t set up on your server yet'
        }</span>${integrations.googleConfigured ? '<button class="btn small primary" data-mail-connect>Connect Google</button>' : ''}</div>`;
      }
      if (!acct.gmail || st.needsScope) {
        return `${header}<div class="w-empty">${icon('mail', 20)}<span>Reconnect ${esc(acct.name)} to allow Gmail access</span>
          <button class="btn small primary" data-mail-connect>Reconnect Google</button></div>`;
      }
      if (!st.data) {
        if (!st.loading && !st.error) setTimeout(() => loadMail(w), 0);
        return `${header}${st.error ? empty('flag', st.error) : empty('mail', 'Loading…')}`;
      }
      const list = st.data.messages.slice(0, MAIL_ROWS[w.size]);
      return `${header}<div class="w-mail w-mail-${w.size}">${
        list.length
          ? list
              .map(
                (m) => `<div class="w-msg${m.unread ? ' unread' : ''}" role="button" tabindex="0" data-mail="${esc(m.threadId)}" title="${esc(m.snippet || m.subject)}">
            <span class="w-msg-top"><b class="w-msg-from">${esc(m.from)}</b><small class="w-msg-when">${esc(mailWhen(m.date))}</small></span>
            <span class="w-msg-subject">${esc(m.subject)}</span>${w.size === 'l' ? `<small class="w-msg-snip">${esc(m.snippet)}</small>` : ''}
            <span class="w-msg-acts"><button data-mail-act="task" title="Add as a task">${icon('check', 12)}</button><button data-mail-act="note" title="Start a note from this email">${icon('note', 12)}</button><button data-mail-act="contact" title="Save the sender as a contact">${icon('user', 12)}</button></span></div>`,
              )
              .join('')
          : empty('mail', w.cfg?.unreadOnly ? 'No unread mail' : 'Your inbox is empty')
      }</div>${st.error ? `<div class="w-mail-err">${esc(st.error)}</div>` : ''}`;
    },
    options(w) {
      const accounts = gmailAccounts();
      return [
        { header: 'Account' },
        ...accounts.map((a) => ({ label: a.name, checked: mailAccount(w)?.id === a.id, act: () => setCfg(w.id, { account: a.id }) })),
        {
          label: 'Connect another Google account…',
          act: () => {
            toast('Sign in with the other Google account in the window that opens');
            connectGoogle().then((fresh) => {
              if (!fresh) return;
              setCfg(w.id, { account: fresh.id }); // this widget shows the account you just added
              loadMail(w, true);
            });
          },
        },
        '-',
        { label: 'Unread only', checked: !!w.cfg?.unreadOnly, act: () => setCfg(w.id, { unreadOnly: !w.cfg?.unreadOnly }) },
        { label: 'Refresh now', act: () => loadMail(w, true) },
      ];
    },
  },
  bookmarks: {
    name: 'Bookmarks',
    desc: 'Browse your bookmark folders, like a bookmarks bar',
    icon: 'star',
    sizes: ['s', 'm', 'l'],
    configurable: true,
    render(w) {
      const { root, cur, folders, here, subtree } = folderView(w);
      const max = BM_ROWS[w.size];
      const q = bmFilters.get(w.id) || '';
      const title = cur ? cur.split('/').pop() : 'Bookmarks';
      const header = `<header data-bm-open="${esc(cur)}" title="Open in Bookmarks">${icon('star', 13)}<span>${esc(title)}</span><em>${subtree.length >= 400 ? '400+' : subtree.length}</em></header>`;
      if (!store.all('bookmarks').length) return `${header}${empty('star', 'Save or import bookmarks to see them here')}`;

      // The folder view: a row to go up, then subfolders, then this folder's own bookmarks.
      const rows = [];
      if (cur !== root) {
        const parent = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
        const label = parent && parent !== root ? parent.split('/').pop() : root ? root.split('/').pop() : 'Bookmarks';
        rows.push(`<button class="w-bm w-bm-up" data-bm-nav="${esc(parent)}">${icon('left', 13)}<span class="w-bm-name">${esc(label)}</span></button>`);
      }
      for (const [name, n] of folders) {
        const path = cur ? `${cur}/${name}` : name;
        rows.push(`<button class="w-bm w-bm-folder" data-bm-nav="${esc(path)}" title="${esc(name)}">${icon('folder', 14)}<span class="w-bm-name">${esc(name)}</span><small class="w-bm-count">${n}</small></button>`);
      }
      for (const b of here) rows.push(bookmarkRow(b));
      let shown = rows;
      if (rows.length > max) {
        shown = [...rows.slice(0, max - 1), `<button class="w-bm w-bm-more" data-bm-open="${esc(cur)}">${icon('dots', 14)}<span class="w-bm-name">${rows.length - (max - 1)} more…</span></button>`];
      }

      // A flat list of everything under this folder, used by the filter box (large size).
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      let hits = 0;
      const results = subtree
        .map((b) => {
          const text = bmText(b);
          const hit = words.every((x) => text.includes(x));
          const hidden = !hit || hits >= max;
          if (hit) hits++;
          return bookmarkRow(b, { text, hidden });
        })
        .join('');
      return `${header}
        ${w.size === 'l' ? `<input class="w-bm-filter" data-bm-filter placeholder="Filter ${esc(title.toLowerCase())}" value="${esc(q)}" spellcheck="false">` : ''}
        <div class="w-bms w-bms-${w.size} w-bm-tree"${q ? ' hidden' : ''}>${shown.join('') || empty('star', 'This folder is empty')}</div>
        <div class="w-bms w-bms-${w.size} w-bm-results"${q ? '' : ' hidden'}>${results}<div class="w-bm-none"${hits ? ' hidden' : ''}>No matches</div></div>`;
    },
    options(w) {
      const auto = autoRoot();
      const chosen = w.cfg?.folder;
      const sort = w.cfg?.sort || 'order';
      const tops = topFolders(auto).slice(0, 14);
      const pick = (folder) => {
        bmNav.delete(w.id);
        setCfg(w.id, { folder });
      };
      return [
        { header: 'Start in' },
        { label: auto ? `${auto.split('/').pop()} (automatic)` : 'All bookmarks (automatic)', checked: chosen == null, act: () => pick(null) },
        auto && { label: 'All bookmarks', checked: chosen === '', act: () => pick('') },
        ...tops.map((f) => ({ label: f.split('/').pop(), checked: chosen === f, act: () => pick(f) })),
        '-',
        { header: 'Sort bookmarks' },
        { label: 'Bookmark order', checked: sort === 'order', act: () => setCfg(w.id, { sort: 'order' }) },
        { label: 'A–Z', checked: sort === 'az', act: () => setCfg(w.id, { sort: 'az' }) },
        { label: 'Recently added', checked: sort === 'recent', act: () => setCfg(w.id, { sort: 'recent' }) },
      ];
    },
  },
  links: {
    name: 'Quick links',
    desc: 'Your connections or a bookmark folder, one click away',
    icon: 'link',
    sizes: ['s', 'm', 'l'],
    configurable: true,
    render(w) {
      const max = { s: 4, m: 8, l: 16 }[w.size];
      const src = w.cfg?.source || 'connections';
      let items;
      if (src === 'connections') {
        items = store.all('links').map((l) => ({ kind: 'app', id: linkAppId(l), name: l.name, app: getApp(linkAppId(l)) }));
      } else {
        const folder = src.slice(7);
        items = store.all('bookmarks')
          .filter((b) => b.folder === folder || (b.folder || '').startsWith(folder + '/'))
          .map((b) => ({ kind: 'bookmark', id: b.id, name: b.title || hostOf(b.url), url: b.url }));
      }
      const title = src === 'connections' ? 'Quick links' : src.slice(7).split('/').pop();
      return `${head(src === 'connections' ? 'connections' : 'bookmarks', 'link', title)}
        <div class="w-links w-links-${w.size}">${
          items.length
            ? items.slice(0, max).map((it) => `<button class="w-link" data-link="${it.kind}:${it.id}" title="${esc(it.name)}">
                ${it.kind === 'app' && it.app ? appIcon(it.app) : `<span class="w-link-fav"><img class="fav" src="${esc(favicon(it.url))}" alt="" referrerpolicy="no-referrer"></span>`}
                <span>${esc(it.name)}</span></button>`).join('')
            : empty('link', src === 'connections' ? 'Add connections to see them here' : 'This folder is empty')
        }</div>`;
    },
    options(w) {
      const src = w.cfg?.source || 'connections';
      const folders = [...new Set(store.all('bookmarks').map((b) => b.folder).filter(Boolean))].sort().slice(0, 14);
      return [
        { header: 'Show' },
        { label: 'Connections', checked: src === 'connections', act: () => setCfg(w.id, { source: 'connections' }) },
        ...folders.map((f) => ({ label: `Bookmarks: ${f}`, checked: src === 'folder:' + f, act: () => setCfg(w.id, { source: 'folder:' + f }) })),
      ];
    },
  },
};

/* Gmail widget: recent inbox messages from a connected Google account (read-only, fetched via the Worker). */
const mail = new Map(); // widget id -> { data, error, needsScope, at, loading }
const MAIL_EVERY = 3 * 60_000;
const MAIL_ROWS = { s: 3, m: 5, l: 12 };

function mailAccount(w) {
  const accounts = gmailAccounts();
  return accounts.find((a) => a.id === w.cfg?.account) || accounts.find((a) => a.gmail) || accounts[0] || null;
}

async function loadMail(w, force = false) {
  const acct = mailAccount(w);
  const cur = mail.get(w.id) || {};
  if (!acct || cur.loading) return;
  if (!force && cur.at && Date.now() - cur.at < MAIL_EVERY && cur.account === acct.id && cur.unreadOnly === !!w.cfg?.unreadOnly) return;
  mail.set(w.id, { ...cur, loading: true, account: acct.id, unreadOnly: !!w.cfg?.unreadOnly });
  try {
    const data = await fetchMail(acct.id, { max: 25, unreadOnly: !!w.cfg?.unreadOnly });
    mail.set(w.id, { data, at: Date.now(), account: acct.id, unreadOnly: !!w.cfg?.unreadOnly });
  } catch (err) {
    mail.set(w.id, { ...cur, data: cur.data, loading: false, at: Date.now(), account: acct.id, unreadOnly: !!w.cfg?.unreadOnly, error: err.message, needsScope: !!err.needsScope });
  }
  renderWidgets();
}

const mailWhen = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const gmailUrl = (email, threadId) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(email || '')}#${threadId ? 'inbox/' + threadId : 'inbox'}`;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const INVITE_PREFIX = /^\s*(?:updated\s+)?invitation(?:\s+from\s+google\s+calendar)?(?:\s+with\s+note)?\s*:\s*/i;
const CANCELED = /^\s*cancell?ed\s+(?:event|invitation)/i;

/**
 * Fallback when the message has no .ics: Google's invite subjects carry the date after " @ ",
 * e.g. "Invitation: Team sync @ Mon Oct 20, 2026 2pm - 3pm (EDT) (me@x.com)" or "… @ Mon 20 Oct 2026 14:00 …".
 * Returns { title, due } or null. Recurring invites ("@ Weekly from 10am …") have no date and return null.
 */
function inviteFromSubject(subject, sentAt = Date.now()) {
  const s = String(subject || '');
  const at = s.lastIndexOf(' @ ');
  if (at < 0 || !INVITE_PREFIX.test(s) || CANCELED.test(s)) return null;
  const tail = s.slice(at + 3);
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  const md = tail.match(new RegExp(`\\b${mon}\\s+(\\d{1,2})\\b`, 'i')); // Oct 20
  const dm = tail.match(new RegExp(`\\b(\\d{1,2})\\.?\\s+${mon}`, 'i')); // 20 Oct
  const hit = md && (!dm || md.index <= dm.index) ? { m: md[1], d: md[2] } : dm ? { m: dm[2], d: dm[1] } : null;
  if (!hit) return null;
  const month = MONTHS.indexOf(hit.m.toLowerCase().slice(0, 3));
  const day = +hit.d;
  const sent = new Date(sentAt);
  let year = +(tail.match(/\b(20\d{2})\b/) || [])[1] || sent.getFullYear();
  let date = new Date(year, month, day);
  // No year in the subject: an invite is for a coming date, so a month well before the email means next year.
  if (!/\b20\d{2}\b/.test(tail) && date < sent - 31 * 86_400_000) date = new Date(++year, month, day);
  if (date.getMonth() !== month || date.getDate() !== day) return null; // e.g. "Feb 31"
  return { title: s.slice(0, at).replace(INVITE_PREFIX, '').trim(), due: isoDate(date) };
}

/** The date (and event name) for a task made from an email that's a calendar invite, or null. */
async function inviteFor(m, accountId) {
  if (accountId && m.id) {
    try {
      const inv = await fetchInvite(accountId, m.id);
      if (inv?.method === 'CANCEL') return null;
      if (inv?.start) return { title: inv.summary, due: inv.start.date || isoDate(new Date(inv.start.at)) };
    } catch {
      // Offline or the server is older than this lookup — the subject may still say when.
    }
  }
  return inviteFromSubject(m.subject, m.date);
}

/** One click from a message to a task, a note, or a contact — each keeps the link back to the thread. */
async function emailAction(kind, m, threadUrl, accountId) {
  const from = m.from || m.fromEmail || 'Unknown sender';
  const sender = (m.fromEmail || '').toLowerCase();
  const contact = sender && store.all('contacts').find((c) => String(c.email || '').toLowerCase() === sender);
  if (kind === 'task') {
    const invite = await inviteFor(m, accountId);
    const title = invite?.title || m.subject || `Email from ${from}`;
    store.save('tasks', {
      title,
      status: 'To Do',
      priority: 'Medium',
      ...(invite?.due ? { due: invite.due } : {}),
      contactId: contact?.id || '',
      notes: `From ${from}${m.fromEmail ? ` <${m.fromEmail}>` : ''} · ${new Date(m.date).toLocaleDateString()}\n${m.snippet || ''}\n\nEmail: ${threadUrl}`,
    });
    return toast(`Added task “${title}”${invite?.due ? ` · due ${relDay(invite.due)}` : ''}`);
  }
  if (kind === 'note') {
    const html = `<h1>${esc(m.subject || 'Email')}</h1><p><span style="color: #a3aaa6">From ${esc(from)}${m.fromEmail ? ` · ${esc(m.fromEmail)}` : ''} · ${esc(new Date(m.date).toLocaleString())}</span></p>${
      m.snippet ? `<blockquote>${esc(m.snippet)}</blockquote>` : ''
    }<p><a href="${esc(threadUrl)}">Open the email in Gmail</a></p><h3>Notes</h3><p><br></p>`;
    const n = store.save('notes', { title: m.subject || `Email from ${from}`, body: html, text: `${m.subject || ''}\nFrom ${from}\n${m.snippet || ''}`, format: 'html' });
    return openApp('notes', { record: n.id });
  }
  if (kind === 'contact') {
    if (contact) {
      toast(`${contact.name || from} is already in Contacts`);
      return openApp('contacts', { record: contact.id });
    }
    if (!m.fromEmail) return toast('This message has no sender address', 'error');
    const c = store.save('contacts', { name: from === m.fromEmail ? from.split('@')[0] : from, email: m.fromEmail, type: 'Lead', notes: `From the email “${m.subject || ''}” · ${threadUrl}` });
    toast(`Added ${c.name} to Contacts`);
    return openApp('contacts', { record: c.id });
  }
}

function refreshAllMail(force = false) {
  for (const w of allWidgets()) if (w.type === 'gmail') loadMail(w, force);
}

/* Bookmarks widget: browse folders like a bookmarks bar. Where you've navigated to is kept per widget
   (not saved); the folder it starts in and the sort order are. */
const bmFilters = new Map(); // widget id -> filter text
const bmNav = new Map(); // widget id -> folder being browsed
const BM_ROWS = { s: 4, m: 8, l: 18 };

const bmText = (b) => `${b.title || hostOf(b.url)} ${b.url} ${b.folder || ''} ${b.tags || ''}`.toLowerCase();
const bookmarkRow = (b, { text, hidden } = {}) => `<button class="w-bm" data-link="bookmark:${esc(b.id)}"${text ? ` data-text="${esc(text)}"` : ''} title="${esc(b.url)}"${hidden ? ' hidden' : ''}>
  <img class="fav" src="${esc(favicon(b.url))}" alt="" referrerpolicy="no-referrer" loading="lazy">
  <span class="w-bm-name">${esc(b.title || hostOf(b.url))}</span></button>`;

/** The deepest folder that holds every bookmark (e.g. "Imported/Bookmarks bar"): the natural place to start. */
function autoRoot() {
  let prefix = null;
  for (const b of store.all('bookmarks')) {
    const parts = (b.folder || '').split('/').filter(Boolean);
    if (prefix === null) prefix = parts;
    else {
      let i = 0;
      while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (!prefix.length) break;
  }
  return (prefix || []).join('/');
}

/** Folders directly inside `root`, as full paths. */
function topFolders(root) {
  const set = new Set();
  for (const b of store.all('bookmarks')) {
    const f = b.folder || '';
    if (!(root ? f.startsWith(root + '/') : f)) continue;
    const name = (root ? f.slice(root.length + 1) : f).split('/')[0];
    if (name) set.add(root ? `${root}/${name}` : name);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function folderView(w) {
  const root = w.cfg?.folder ?? autoRoot();
  let cur = bmNav.get(w.id) ?? root;
  if (!(cur === root || (root ? cur.startsWith(root + '/') : true))) cur = root; // never above the start folder
  const sub = new Map();
  const here = [];
  const subtree = [];
  for (const b of store.all('bookmarks')) {
    const f = b.folder || '';
    if (f === cur) here.push(b);
    else if (cur ? f.startsWith(cur + '/') : f) {
      const name = (cur ? f.slice(cur.length + 1) : f).split('/')[0];
      sub.set(name, (sub.get(name) || 0) + 1);
    } else continue;
    subtree.push(b);
  }
  const sort = w.cfg?.sort || 'order';
  if (sort === 'az') here.sort((a, b) => (a.title || hostOf(a.url)).localeCompare(b.title || hostOf(b.url)));
  else if (sort === 'recent') here.reverse();
  return { root, cur, folders: [...sub].sort((a, b) => a[0].localeCompare(b[0])), here, subtree: subtree.slice(0, 400) };
}

/** Large size: typing filters everything under the current folder instead of browsing it. */
function applyBookmarkFilter(node, q, max) {
  const tree = $('.w-bm-tree', node);
  const results = $('.w-bm-results', node);
  if (!tree || !results) return;
  tree.hidden = !!q;
  results.hidden = !q;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const row of $$('.w-bm', results)) {
    const hit = words.every((x) => (row.dataset.text || '').includes(x));
    row.hidden = !hit || shown >= max;
    if (hit) shown++;
  }
  $('.w-bm-none', results).hidden = shown > 0;
}


/* ---------------- Boards ---------------- */

// A board is one grid of widgets with a layout of its own: the desktop's (#widgets), and the app screen's
// (appscreen.js), which mounts its board each time it opens. Widget ids are unique across boards.
const DEFAULT_LAYOUT = [
  ['clock', 'm'], ['today', 'l'], ['agenda', 'm'], ['quicknote', 'm'],
];
const BOARDS = {
  desktop: { key: 'widgetLayout', defaults: DEFAULT_LAYOUT, root: () => $('#widgets') },
  apps: { key: 'appScreenWidgets', defaults: [['today', 'l'], ['agenda', 'm'], ['quicknote', 's']], root: () => $('.as-widgets') },
};

/* ---------------- Layout state ---------------- */

let editing = null; // the board being edited, or null
let dragging = false;

export const widgetEditing = () => editing;

const unsaved = {}; // a board's starting layout until it's first saved, so its ids hold still
function layout(board = 'desktop') {
  const b = BOARDS[board];
  const l = store.prefs[b.key];
  if (Array.isArray(l)) return l.filter((w) => TYPES[w.type]);
  if (unsaved[board]) return unsaved[board];
  const fresh = ([type, size]) => ({ id: uid(), type, size, cfg: {} });
  if (board !== 'desktop') return (unsaved[board] = b.defaults.map(fresh));
  // First run on this layout system: build from the old on/off settings and the single quick note.
  const off = store.prefs.widgets || {};
  return (unsaved[board] = DEFAULT_LAYOUT.filter(([t]) => off[t] !== false).map(([type, size]) => ({
    ...fresh([type, size]),
    cfg: type === 'quicknote' ? { text: store.prefs.quickNote || '' } : {},
  })));
}
const allWidgets = () => Object.keys(BOARDS).flatMap((b) => layout(b));
const boardOf = (id) => Object.keys(BOARDS).find((b) => layout(b).some((w) => w.id === id)) || 'desktop';
const saveLayout = (l, board = 'desktop') => store.setPrefs({ [BOARDS[board].key]: board === 'desktop' ? withPins(l) : l });
const updateWidget = (id, patch) => {
  const b = boardOf(id);
  saveLayout(layout(b).map((w) => (w.id === id ? { ...w, ...patch } : w)), b);
};
const setCfg = (id, patch) => {
  const w = allWidgets().find((x) => x.id === id);
  if (w) updateWidget(id, { cfg: { ...(w.cfg || {}), ...patch } });
};
const setSize = (id, size) => updateWidget(id, { size });
function removeWidget(id) {
  const b = boardOf(id);
  saveLayout(layout(b).filter((w) => w.id !== id), b);
}
/** `at`: the point on the desktop it should sit around; without one it goes in the first free space. */
export function addWidget(type, size, board = 'desktop', at = null) {
  const t = TYPES[type];
  const s = t.sizes.includes(size) ? size : t.sizes[0];
  const cfg = {};
  if (type === 'gmail') {
    // A second Gmail widget starts on the first account no other Gmail widget shows yet.
    const used = new Set(allWidgets().filter((w) => w.type === 'gmail').map((w) => mailAccount(w)?.id));
    const free = gmailAccounts().find((a) => !used.has(a.id));
    if (free) cfg.account = free.id;
  }
  const pos = board === 'desktop' && at && !narrow() ? posAround(at, s) : null;
  saveLayout([...layout(board), { id: uid(), type, size: s, cfg, ...(pos ? { pos } : {}) }], board);
  if (board === 'desktop' && store.prefs.hideWidgets) store.setPrefs({ hideWidgets: false });
}

/* ---------------- Places on the desktop ---------------- */

const MARGIN = 20; // from the edges of the free space, where widgets snap and start
const SNAP = 8;
const SAFE_BANNER = 42; // safe mode's banner, under the main screen's menu bar

const sizeOf = (size) => {
  const [c, r] = SPAN[size];
  return { w: c * CELL + (c - 1) * GAP, h: r * CELL + (r - 1) * GAP };
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A window too narrow to arrange anything in: the desktop's board stays a grid (app.css). */
const narrow = () => matchMedia('(max-width: 760px)').matches;
const screenIndexAt = (x, y) => screens().findIndex((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);

/** Screen n's edges for widgets: below its menu bar, down to its bottom edge; `floor` is the top of its Dock, if any. */
function edgesOf(n) {
  const all = screens();
  const i = all[n] ? n : 0;
  const a = workArea(i);
  const top = a.y + (i === 0 && document.documentElement.dataset.safe ? SAFE_BANNER : 0);
  return { x: all[i].x, y: top, r: all[i].x + all[i].w, b: all[i].y + all[i].h, floor: a.y + a.h };
}
/** A widget's corner kept on screen n: a widget is never cut off by an edge or across two screens. */
function keepOn(n, x, y, size) {
  const e = edgesOf(n);
  const { w, h } = sizeOf(size);
  return { x: clamp(x, e.x, e.r - w), y: clamp(y, e.y, e.b - h) };
}
const posOf = (n, x, y) => {
  const s = screens()[n] || screens()[0];
  return { screen: s.name || '', x: x - s.x, y: y - s.y };
};
function posAround({ x, y }, size) {
  const { w, h } = sizeOf(size);
  const n = Math.max(0, screenIndexAt(x, y));
  const p = keepOn(n, x - w / 2, y - h / 2, size);
  return posOf(n, p.x, p.y);
}

/** Widgets with no place yet: in the first free cell, across rows from the home corner, as many columns as they need. */
function flow(loose, taken, spots) {
  const { n, side } = widgetsHome();
  const e = edgesOf(n);
  const step = CELL + GAP;
  const left = e.x + MARGIN;
  const right = e.r - MARGIN;
  const rows = Math.max(1, Math.floor((e.floor - MARGIN - (e.y + MARGIN) + GAP) / step));
  const start = e.r - e.x <= 1280 ? 2 : 4;
  const most = Math.max(start, Math.floor((right - left + GAP) / step));
  for (let cols = start; ; cols++) {
    const origin = side === 'right' ? right - cols * step + GAP : left;
    const here = [];
    let fits = true;
    for (const w of loose) {
      const [cw, rh] = SPAN[w.size];
      const box = sizeOf(w.size);
      let spot = null;
      for (let r = 0; !spot && r + rh <= rows; r++)
        for (let c = 0; !spot && c + cw <= cols; c++) {
          const t = { x: origin + c * step, y: e.y + MARGIN + r * step, ...box };
          if (![...taken, ...here].some((o) => overlaps(o, t))) spot = t;
        }
      if (!spot) {
        fits = false;
        spot = { x: clamp(origin, e.x, e.r - box.w), y: e.y + MARGIN, ...box }; // no room anywhere: on top of the others
      }
      here.push({ ...spot, id: w.id, n });
    }
    if (fits || cols >= most) {
      for (const h of here) spots.set(h.id, h);
      return;
    }
  }
}

/** Where each desktop widget shows on this page (id → { x, y, w, h, n }); null when the board is a grid. */
function arrangement(list = layout('desktop')) {
  if (narrow()) return null;
  const all = screens();
  const spots = new Map();
  const loose = [];
  for (const w of list) {
    if (!w.pos) {
      if (desktopHere(widgetsHome().name)) loose.push(w);
      continue;
    }
    if (!desktopHere(w.pos.screen)) continue; // on another screen's page (one surface per screen)
    // Its screen isn't connected: the main one until it's back. Nothing is saved, so it goes back then too.
    const n = Math.max(0, all.findIndex((s) => s.name && s.name === w.pos.screen));
    const s = all[n];
    spots.set(w.id, { ...keepOn(n, s.x + w.pos.x, s.y + w.pos.y, w.size), ...sizeOf(w.size), id: w.id, n });
  }
  if (loose.length) flow(loose, [...spots.values()], spots);
  return spots;
}

/** A layout about to be saved: what has no place yet stays where it shows now, whatever else changes. */
function withPins(l) {
  const now = arrangement();
  return l.map((w) => {
    const s = !w.pos && now?.get(w.id);
    return s ? { ...w, pos: posOf(s.n, s.x, s.y) } : w;
  });
}

/** Back to flowing from the corner (Settings → Desktop, the desktop's menu). */
export function resetWidgetArrangement() {
  store.setPrefs({ widgetLayout: layout('desktop').map(({ pos, ...w }) => w) });
}
export const widgetsArranged = () => layout('desktop').some((w) => w.pos);

/* ---------------- Rendering ---------------- */

function editControls(w) {
  return `<button class="wd-remove" data-wd="remove" title="Remove widget" aria-label="Remove widget">${icon('x', 11, 3)}</button>
    ${TYPES[w.type].configurable ? `<button class="wd-config" data-wd="config" title="Widget options" aria-label="Widget options">${icon('dots', 13)}</button>` : ''}
    ${TYPES[w.type].sizes.length > 1 ? `<span class="wd-resize" data-wd="resize" title="Drag to resize"></span>` : ''}`;
}

/** Every board that's on screen. */
export function renderWidgets() {
  if (dragging) return;
  for (const board of Object.keys(BOARDS)) renderBoard(board);
}

function renderBoard(board) {
  const root = BOARDS[board].root();
  if (!root) return;
  const edit = editing === board;
  root.classList.toggle('editing', edit);
  if (board === 'desktop') {
    root.hidden = !!store.prefs.hideWidgets && !edit;
    $('#widget-bar').hidden = !edit;
  }

  const spots = board === 'desktop' ? arrangement() : null;
  const list = layout(board).filter((w) => !spots || spots.has(w.id));
  const keep = new Set(list.map((w) => w.id));
  for (const node of $$('.widget[data-wid]', root)) if (!keep.has(node.dataset.wid)) node.remove();

  let prev = null;
  for (const w of list) {
    let node = root.querySelector(`[data-wid="${w.id}"]`);
    if (!node) {
      node = document.createElement('div');
      node.dataset.wid = w.id;
    }
    node.className = `widget w-${w.size}`;
    node.dataset.w = w.type;
    if (spots) {
      // Front to back by z-index, not page order: moving a node would restart its entrance animation.
      if (!node.isConnected) root.append(node);
      const s = spots.get(w.id);
      Object.assign(node.style, { left: `${s.x}px`, top: `${s.y}px`, zIndex: list.indexOf(w) + 1 });
    } else {
      if (board === 'desktop') Object.assign(node.style, { left: '', top: '', zIndex: '' });
      // Only move nodes that are out of place — moving restarts their entrance animation.
      if (!node.isConnected || node.previousElementSibling !== prev) {
        if (prev) prev.after(node);
        else root.prepend(node);
      }
      prev = node;
    }
    if (node.contains(document.activeElement) && document.activeElement.matches('textarea')) continue; // typing
    try {
      node.innerHTML = TYPES[w.type].render(w) + (edit ? editControls(w) : '');
      if (w.type === 'performance') drawPerfGraphs(node);
    } catch (err) {
      console.error(err);
      node.innerHTML = empty('flag', 'This widget couldn’t load') + (edit ? editControls(w) : '');
    }
  }

  // The app screen's board always has the add tile, so adding one is never hidden behind a menu. The desktop's has no
  // next cell for one to sit in: edit mode's bar has the button.
  const showAdd = board !== 'desktop';
  let add = $('.widget-add', root);
  if (showAdd && !add) {
    add = el(`<button class="widget w-s widget-add" data-wd="gallery">${icon('plus', 22)}<span>Add widget</span></button>`);
    root.append(add);
  } else if (showAdd) root.append(add);
  else add?.remove();

  if (board === 'desktop' && !list.length && !edit) root.hidden = true;
  if (board === 'desktop') announcePlaces(root, spots);
}

// Desktop icons keep out from under widgets (desktop.js): tell them when what they're avoiding has changed.
let lastPlaces = null;
function announcePlaces(root, spots) {
  const now = root.hidden || !spots ? '' : JSON.stringify([...spots.values()].map((s) => [s.x, s.y, s.w, s.h]));
  if (now === lastPlaces) return;
  lastPlaces = now;
  dispatchEvent(new Event('widgets-placed'));
}

/* ---------------- Edit mode ---------------- */

export function enterWidgetEdit(board = 'desktop') {
  if (editing && editing !== board) exitWidgetEdit();
  editing = board;
  if (board === 'desktop' && store.prefs.hideWidgets) store.setPrefs({ hideWidgets: false });
  if (!Array.isArray(store.prefs[BOARDS[board].key])) saveLayout(layout(board), board);
  renderWidgets();
}

export function exitWidgetEdit() {
  if (!editing) return;
  editing = null;
  closeGallery();
  renderWidgets();
}

function widgetMenu(w, x, y) {
  const t = TYPES[w.type];
  const board = boardOf(w.id);
  showMenu(x, y, [
    { header: t.name },
    ...(t.sizes.length > 1 ? t.sizes.map((s) => ({ label: SIZE_LABEL[s], checked: w.size === s, act: () => setSize(w.id, s) })) : []),
    ...(t.options ? ['-', ...t.options(w)] : []),
    '-',
    editing === board ? { label: 'Done Editing', act: exitWidgetEdit } : { label: 'Edit Widgets', act: () => enterWidgetEdit(board) },
    { label: 'Add Widget…', act: () => openWidgetGallery(board) },
    { label: 'Remove Widget', act: () => removeWidget(w.id) },
  ]);
}

/* Gallery */

function closeGallery() {
  $('#widget-gallery')?.remove();
}

export const widgetGalleryOpen = () => !!$('#widget-gallery');

/** `at`: where the first one added goes on the desktop (where you right-clicked). */
export function openWidgetGallery(board = 'desktop', at = null) {
  if (editing !== board) enterWidgetEdit(board);
  closeGallery();
  const g = el(`<div id="widget-gallery"><div class="wg-panel">
      <div class="wg-head"><div><h2>Add a widget</h2><small>Pick a widget and a size. You can resize it and drag it anywhere afterwards.</small></div>
        <button class="tb-btn" data-wg="close" title="Close">${icon('x', 15)}</button></div>
      <div class="wg-grid">${Object.entries(TYPES)
        .map(([type, t]) => `<div class="wg-card">
          <span class="wg-icon">${icon(t.icon, 18)}</span>
          <div class="wg-text"><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></div>
          <div class="wg-sizes">${t.sizes.map((s) => `<button class="wg-size" data-add="${type}:${s}" title="Add ${SIZE_LABEL[s]}">
              <i class="wg-shape wg-shape-${s}"></i>${SIZE_LABEL[s]}</button>`).join('')}</div></div>`)
        .join('')}</div></div></div>`);
  document.body.append(g);
  g.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), closeGallery()));
  g.addEventListener('click', (e) => {
    if (e.target === g || e.target.closest('[data-wg=close]')) return closeGallery();
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const [type, size] = b.dataset.add.split(':');
    addWidget(type, size, board, at);
    at = null;
    toast(`Added ${TYPES[type].name}`);
    // Bring the new widget into view (the app screen's board scrolls).
    if (board !== 'desktop') setTimeout(() => $$('.widget[data-wid]', BOARDS[board].root() || document).pop()?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 120);
  });
}

/* Drag anywhere (the desktop): on the screen under the pointer, snapping to the free space's edges and to other widgets. Alt: no snapping. */

/** `pos` moved to the nearest of `starts` (for its near edge) or `ends` (for its far edge), when one is within SNAP. */
function snapped(pos, size, starts, ends) {
  let best = pos;
  let dist = SNAP + 1;
  for (const [targets, off] of [[starts, 0], [ends, size]])
    for (const t of targets) {
      const d = Math.abs(t - off - pos);
      if (d < dist) [best, dist] = [t - off, d];
    }
  return best;
}

function startMove(node, w, e) {
  const spot = arrangement()?.get(w.id);
  if (!spot) return;
  const start = { ...spot, x: node.offsetLeft, y: node.offsetTop }; // where it shows, under the pointer
  const sx = e.clientX;
  const sy = e.clientY;
  const { w: W, h: H } = sizeOf(w.size);
  let moved = false;
  let { n, x, y } = start;
  // Over a page in a window, the pointer would otherwise stop reporting here.
  node.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!moved) {
      moved = true;
      dragging = true;
      node.classList.add('dragging');
      node.style.zIndex = 9999;
    }
    const over = screenIndexAt(ev.clientX, ev.clientY);
    if (over >= 0) n = over; // in a gap beside a smaller screen: still the last one
    ({ x, y } = keepOn(n, start.x + ev.clientX - sx, start.y + ev.clientY - sy, w.size));
    if (!ev.altKey) {
      const edge = edgesOf(n);
      const others = [...arrangement().values()].filter((o) => o.id !== w.id && o.n === n);
      x = snapped(x, W, [edge.x + MARGIN, ...others.flatMap((o) => [o.x, o.x + o.w + GAP])], [edge.r - MARGIN, ...others.flatMap((o) => [o.x + o.w, o.x - GAP])]);
      y = snapped(y, H, [edge.y + MARGIN, ...others.flatMap((o) => [o.y, o.y + o.h + GAP])], [edge.floor - MARGIN, ...others.flatMap((o) => [o.y + o.h, o.y - GAP])]);
      ({ x, y } = keepOn(n, x, y, w.size));
    }
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!moved) return;
    dragging = false;
    node.classList.remove('dragging');
    // Last in the list: dropped on another widget, it stays in front.
    const list = layout('desktop');
    const me = list.find((o) => o.id === w.id);
    if (me) saveLayout([...list.filter((o) => o !== me), { ...me, pos: posOf(n, x, y) }]);
    renderWidgets();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

/* Drag to reorder (within a grid board) */

function startReorder(node, e) {
  const root = node.parentElement;
  const board = root.dataset.board;
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!moved) {
      moved = true;
      dragging = true;
      node.classList.add('dragging');
    }
    node.style.translate = `${ev.clientX - sx}px ${ev.clientY - sy}px`;
    node.style.pointerEvents = 'none';
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.widget[data-wid]');
    node.style.pointerEvents = '';
    if (!over || over === node || over.parentElement !== root) return;
    const r = over.getBoundingClientRect();
    const before = ev.clientX < r.left + r.width / 2;
    // Re-measure after moving so the dragged widget stays under the pointer.
    const prevRect = node.getBoundingClientRect();
    root.insertBefore(node, before ? over : over.nextSibling);
    const now = node.getBoundingClientRect();
    const [tx, ty] = (node.style.translate || '0px 0px').split(' ').map(parseFloat);
    node.style.translate = `${tx + prevRect.left - now.left}px ${ty + prevRect.top - now.top}px`;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    node.classList.remove('dragging');
    node.style.translate = '';
    dragging = false;
    if (!moved) return;
    const order = $$('.widget[data-wid]', root).map((n) => n.dataset.wid);
    const current = layout(board);
    saveLayout(order.map((id) => current.find((w) => w.id === id)).filter(Boolean), board);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/* Drag the corner to resize (snaps to the nearest allowed size) */

function startResize(node, w, e) {
  e.preventDefault();
  e.stopPropagation();
  const t = TYPES[w.type];
  const r = node.getBoundingClientRect();
  const spot = boardOf(w.id) === 'desktop' ? arrangement()?.get(w.id) : null;
  const sx = e.clientX;
  const sy = e.clientY;
  let size = w.size;
  dragging = true;
  node.classList.add('resizing');
  const move = (ev) => {
    const width = r.width + ev.clientX - sx;
    const height = r.height + ev.clientY - sy;
    const cols = width > CELL + GAP / 2 + 40 ? 2 : 1;
    const rows = height > CELL + GAP / 2 + 40 ? 2 : 1;
    // Nearest allowed size to the dragged shape.
    const best = t.sizes
      .map((s) => [s, Math.abs(SPAN[s][0] - cols) + Math.abs(SPAN[s][1] - rows)])
      .sort((a, b) => a[1] - b[1])[0][0];
    if (best !== size) {
      size = best;
      node.className = `widget w-${size} resizing`;
      node.innerHTML = t.render({ ...w, size }) + editControls(w);
      if (spot) {
        // Grown past an edge, it shows inside it; the saved place stays, for when it's smaller again.
        const p = keepOn(spot.n, spot.x, spot.y, size);
        Object.assign(node.style, { left: `${p.x}px`, top: `${p.y}px` });
      }
    }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    dragging = false;
    node.classList.remove('resizing');
    if (size !== w.size) setSize(w.id, size);
    else renderWidgets();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/* ---------------- Setup ---------------- */

/** What a widget does when you use it: the same on every board. */
function bindBoard(root, board) {
  root.dataset.board = board;
  const instance = (node) => layout(board).find((w) => w.id === node?.closest('[data-wid]')?.dataset.wid);

  // Quick notes save as you type (per widget).
  const saveNote = debounce((id, text) => setCfg(id, { text }), 600);
  root.addEventListener('input', (e) => {
    const ta = e.target.closest('[data-note-for]');
    if (ta) saveNote(ta.dataset.noteFor, ta.value);
  });

  root.addEventListener('pointerdown', (e) => {
    if (editing !== board || e.button !== 0) return;
    const node = e.target.closest('.widget[data-wid]');
    if (!node) return;
    if (e.target.closest('[data-wd=resize]')) return startResize(node, instance(node), e);
    if (e.target.closest('[data-wd], textarea')) return;
    if (board === 'desktop' && !narrow()) startMove(node, instance(node), e);
    else startReorder(node, e);
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-wd]')?.dataset.wd === 'gallery') return openWidgetGallery(board);
    if (editing === board) {
      const wd = t.closest('[data-wd]');
      const w = instance(t);
      if (wd?.dataset.wd === 'remove' && w) return removeWidget(w.id);
      if (wd?.dataset.wd === 'config' && w) {
        const r = wd.getBoundingClientRect();
        return showMenu(r.left, r.bottom + 4, [{ header: TYPES[w.type].name }, ...TYPES[w.type].options(w)]);
      }
      return; // in edit mode, widgets don't open things
    }
    const tog = t.closest('[data-toggle-task]');
    if (tog) {
      tog.classList.add('on');
      const task = store.get('tasks', tog.dataset.toggleTask);
      return setTimeout(() => task && toggleTask(task), 250);
    }
    const link = t.closest('[data-link]');
    if (link) {
      const [kind, id] = link.dataset.link.split(/:(.*)/);
      if (kind === 'app') return openApp(id);
      const b = store.get('bookmarks', id);
      return b && openBookmark(b);
    }
    const rec = t.closest('[data-open-rec]');
    if (rec) {
      const [col, id] = rec.dataset.openRec.split(':');
      return openApp(schemas[col]?.app || col, { record: id });
    }
    if (t.closest('[data-add-task]')) return openApp('tasks', { create: { due: today() } });
    const nav = t.closest('[data-bm-nav]');
    if (nav) {
      const w = instance(nav);
      if (!w) return;
      bmNav.set(w.id, nav.dataset.bmNav);
      bmFilters.delete(w.id);
      return renderWidgets();
    }
    const bmo = t.closest('[data-bm-open]');
    if (bmo) return openApp('bookmarks', { folder: bmo.dataset.bmOpen });
    if (t.closest('[data-mail-connect]')) return connectGoogle().then(() => refreshAllMail(true));
    const msg = t.closest('[data-mail]');
    if (msg) {
      const w = instance(msg);
      const email = (w && mail.get(w.id)?.data?.email) || mailAccount(w)?.name || '';
      const act = t.closest('[data-mail-act]');
      if (act) {
        const m = (w && mail.get(w.id)?.data?.messages || []).find((x) => x.threadId === msg.dataset.mail);
        return m && emailAction(act.dataset.mailAct, m, gmailUrl(email, m.threadId), mail.get(w.id)?.account || mailAccount(w)?.id);
      }
      return openPage(gmailUrl(email, msg.dataset.mail));
    }
    const u = t.closest('[data-open-url]');
    if (u) return openPage(u.dataset.openUrl);
    const h = t.closest('[data-open-app]');
    if (h) openApp(h.dataset.openApp);
  });

  root.addEventListener('input', (e) => {
    const f = e.target.closest('[data-bm-filter]');
    const node = f?.closest('.widget[data-wid]');
    const w = node && instance(node);
    if (!w) return;
    bmFilters.set(w.id, f.value);
    applyBookmarkFilter(node, f.value, BM_ROWS[w.size]);
  });
  root.addEventListener('keydown', (e) => {
    const f = e.target.closest('[data-bm-filter]');
    if (!f) return;
    if (e.key === 'Escape') {
      e.stopPropagation(); // the app screen would close
      f.value = '';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.blur();
    }
    if (e.key === 'Enter') $('.w-bms:not([hidden]) .w-bm:not([hidden])', f.closest('.widget'))?.click();
  });

  root.addEventListener('contextmenu', (e) => {
    const node = e.target.closest('.widget[data-wid]');
    if (!node || e.target.closest('textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    const w = instance(node);
    if (w) widgetMenu(w, e.clientX, e.clientY);
  });
}

/* Performance widget: the computer's CPU, memory, temperature and battery, sampled through the Task Manager's channel
   every couple of seconds while one shows. Each sample redraws the widgets' bodies in place; a full render (store changes)
   shows the latest sample. */
const PERF_EVERY = 2000;
const PERF_HISTORY = 60; // samples on the graphs: two minutes
const PERF_COLOR = { cpu: '#2a8fdc', memory: '#a24fd6' }; // the Task Manager's
const perf = { sys: null, cpu: [], memory: [], timer: 0, ticks: 0 };

const perfPct = (n) => `${Math.round(n || 0)}%`;
const perfGb = (n, d = 1) => (n / 1024 ** 3).toFixed(d);
const perfBits = (bytesPerSec) => {
  const b = (bytesPerSec || 0) * 8;
  if (b < 1000) return `${Math.round(b)} bps`;
  const u = ['Kbps', 'Mbps', 'Gbps'];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(b) / 3) - 1);
  const v = b / 1000 ** (i + 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};
const perfUp = (secs) => {
  const s = Math.floor(secs || 0);
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
  return `${Math.floor(s / 60)}m`;
};

function startPerf() {
  if (perf.timer || !shell?.perf?.system) return;
  perf.timer = setInterval(samplePerf, PERF_EVERY);
  samplePerf();
}

async function samplePerf() {
  const bodies = $$('.widget[data-w="performance"] .w-perf');
  if (!bodies.length) {
    // The last one's gone: stop, and start the graphs fresh next time.
    clearInterval(perf.timer);
    Object.assign(perf, { timer: 0, cpu: [], memory: [], ticks: 0 });
    return;
  }
  if (document.hidden) return;
  let sys;
  try {
    sys = await shell.perf.system();
  } catch {
    return;
  }
  const push = (arr, v) => {
    arr.push(v);
    if (arr.length > PERF_HISTORY) arr.shift();
  };
  // Usage is measured between calls: the very first sample in the app's life has nothing to measure against.
  if (perf.ticks++ || sys.cpu.usage > 0) push(perf.cpu, sys.cpu.usage);
  push(perf.memory, sys.memory.used);
  perf.sys = sys;
  for (const b of bodies) {
    if (!b.clientWidth) continue; // a hidden board; it's rendered when it shows
    b.innerHTML = perfBody(b.dataset.pf);
    drawPerfGraphs(b);
  }
}

/** The widget's body for a size, from the latest sample. */
function perfBody(size) {
  const p = perf.sys;
  if (!p) return empty('activity', 'Measuring…');
  const { cpu, memory: m, battery: b } = p;
  // The sensor reports °C (so the tone's limits are in °C); it's shown in °F.
  const temp = p.temp != null ? `${Math.round((p.temp * 9) / 5 + 32)}°F` : '';
  const tempTone = p.temp >= 90 ? 'txt-red' : p.temp >= 75 ? 'txt-yellow' : '';
  const memBar = bar(`Memory · ${perfGb(m.used)} of ${perfGb(m.total, 0)} GB`, (m.used / m.total) * 100);
  const batBar = b ? bar(`Battery · ${b.percent}%${b.charging ? ', charging' : ''}`, b.percent, b.charging ? 'good' : b.percent <= 15 ? 'bad' : '') : '';
  const graph = (key) => `<canvas class="w-perf-graph" data-graph="${key}" style="color:${PERF_COLOR[key]}"></canvas>`;
  if (size === 's') {
    return metric(perfPct(cpu.usage), `CPU${temp ? ` · <span class="${tempTone}">${temp}</span>` : ''}`, `<div class="w-bars">${memBar}${batBar}</div>`);
  }
  if (size === 'm') {
    return metric(
      perfPct(cpu.usage),
      `CPU · ${(cpu.speed / 1000).toFixed(1)} GHz${temp ? ` · <span class="${tempTone}">${temp}</span>` : ''}`,
      `<div class="w-perf-spark">${graph('cpu')}</div><div class="w-bars">${memBar}${batBar}</div>`,
    );
  }
  const disk = p.disks.length ? `<span>Disk <b>${perfPct(Math.max(...p.disks.map((d) => d.active)))}</b></span>` : '';
  const net = p.network.filter((n) => n.up).sort((x, y) => y.receiveRate + y.sendRate - x.receiveRate - x.sendRate)[0];
  const netText = net ? `<span>${esc(net.kind)} <b>↓ ${perfBits(net.receiveRate)} ↑ ${perfBits(net.sendRate)}</b></span>` : '';
  const fan = p.fan != null ? `<span>Fan <b>${p.fan ? `${p.fan} rpm` : 'off'}</b></span>` : '';
  return `<div class="w-perf-g"><div class="w-perf-lab"><span>CPU</span><b>${perfPct(cpu.usage)} · ${(cpu.speed / 1000).toFixed(1)} GHz${temp ? ` · <span class="${tempTone}">${temp}</span>` : ''}</b></div>${graph('cpu')}</div>
    <div class="w-perf-g"><div class="w-perf-lab"><span>Memory</span><b>${perfGb(m.used)} of ${perfGb(m.total, 0)} GB</b></div>${graph('memory')}</div>
    ${batBar ? `<div class="w-bars">${batBar}</div>` : ''}
    <div class="w-perf-foot">${disk}${netText}${fan}<span>Up <b>${perfUp(cpu.uptime)}</b></span></div>`;
}

/** Draws the graphs in a widget body: the last two minutes, newest at the right, filled under the line. */
function drawPerfGraphs(body) {
  for (const canvas of $$('canvas[data-graph]', body)) {
    const key = canvas.dataset.graph;
    const data = perf[key];
    const max = key === 'memory' ? perf.sys.memory.total : 100;
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (!canvas.clientWidth) continue;
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!data.length) continue;
    const color = getComputedStyle(canvas).color;
    const dx = w / (PERF_HISTORY - 1);
    const pts = data.map((v, i) => [w - (data.length - 1 - i) * dx, h - Math.min(1, Math.max(0, v / max)) * (h - 2 * dpr) - dpr]);
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = color;
    g.lineWidth = 1.5 * dpr;
    g.stroke();
    g.lineTo(pts.at(-1)[0], h);
    g.lineTo(pts[0][0], h);
    g.closePath();
    g.fillStyle = color;
    g.globalAlpha = 0.16;
    g.fill();
    g.globalAlpha = 1;
  }
}

/** A board that comes and goes with what holds it (the app screen): `root` is its grid. */
export function mountWidgetBoard(root, board) {
  bindBoard(root, board);
  renderBoard(board);
  refreshAllMail();
}

export function initWidgets() {
  const root = $('#widgets');
  const bar = el(`<div id="widget-bar" hidden>
      <button class="btn small" data-wbar="add">${icon('plus', 12)} Add Widget</button>
      <button class="btn small primary" data-wbar="done">Done</button></div>`);
  document.body.append(bar);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wbar]');
    if (b?.dataset.wbar === 'add') openWidgetGallery();
    if (b?.dataset.wbar === 'done') exitWidgetEdit();
  });
  bindBoard(root, 'desktop');

  // Mail: refresh every few minutes, when you come back to Leafdeck, and when accounts change.
  setInterval(() => !document.hidden && refreshAllMail(), 60_000);
  document.addEventListener('visibilitychange', () => !document.hidden && refreshAllMail());
  onIntegrations(() => renderWidgets());

  // Leave edit mode with Esc or by clicking the empty desktop.
  addEventListener('keydown', (e) => e.key === 'Escape' && editing && !$('#widget-gallery') && exitWidgetEdit());
  addEventListener('pointerdown', (e) => {
    if (editing === 'desktop' && e.target.closest('#desktop') && !e.target.closest('#widgets, .d-icon')) exitWidgetEdit();
  });

  const redraw = frame(renderWidgets);
  store.addEventListener('change', redraw);
  // Places depend on the screens: a widget stays on one that shrinks, and returns to one that comes back.
  for (const ev of ['resize', 'screens', 'screens-info']) addEventListener(ev, redraw);
  // Refresh time-relative content each minute, aligned to the minute.
  setTimeout(() => {
    redraw();
    setInterval(redraw, 60_000);
  }, 60_000 - (Date.now() % 60_000) + 50);
  renderWidgets();
}
