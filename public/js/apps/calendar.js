import { store } from '../store.js';
import { $, $$, esc, el, isoDate, today, fmtTime, parseDate } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, openApp } from '../wm.js';
import { shell } from '../shell.js';
import { editRecord } from '../schemas.js';
import {
  integrations, onIntegrations, loadIntegrations, syncNow, connectGoogle, subscribe, updateConnection, disconnect,
  writableCalendars, available,
} from '../integrations.js';

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Everything with a date, grouped by yyyy-mm-dd. Multi-day events appear on every day they span. */
export function calendarItems() {
  const map = {};
  const add = (date, item) => date && (map[date] ||= []).push(item);
  for (const r of [...store.all('events')]) {
    const item = { col: 'events', r, kind: 'ev', time: r.time, label: r.title, color: r.color };
    add(r.date, item);
    if (r.endDate && r.endDate > r.date) {
      const d = parseDate(r.date);
      for (let i = 0; i < 62; i++) {
        d.setDate(d.getDate() + 1);
        const iso = isoDate(d);
        if (iso > r.endDate) break;
        add(iso, { ...item, time: '', continued: true });
      }
    }
  }
  for (const r of [...store.all('tasks')])
    if (r.status !== 'Done') add(r.due, { col: 'tasks', r, kind: 'task', time: r.dueTime || '', label: r.title });
  for (const r of [...store.all('sprints')])
    if (r.status !== 'Done') add(r.date, { col: 'sprints', r, kind: 'sprint', time: r.time, label: r.name });
  for (const list of Object.values(map)) list.sort((a, b) => (a.time || '00').localeCompare(b.time || '00'));
  return map;
}

const KIND_ICON = { task: 'check', sprint: 'bolt', ev: 'calendar' };
const GOOGLE_LOGO = 'https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png';
const ago = (ts) => {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/* ---------------- Calendars sheet: connect, choose, sync, disconnect ---------------- */

export function openCalendarsSheet(win) {
  const node = el('<div class="cals"></div>');
  const sh = win.sheet(node);
  let view = 'list'; // list | google-setup | subscribe

  const status = (c) =>
    c.status === 'needs_reauth'
      ? '<span class="pill pill-yellow">Needs reconnecting</span>'
      : c.status === 'error'
        ? `<span class="pill pill-red" title="${esc(c.error || '')}">Sync error</span>`
        : `<span class="muted small">Synced ${ago(c.lastSync)}</span>`;

  const draw = () => {
    if (!available()) {
      node.innerHTML = `<div class="sheet-head"><div><h2>Calendars</h2></div></div>
        <div class="sheet-scroll"><p class="muted">Connecting calendars needs your Leafdeck server (the Worker). It isn’t reachable right now.</p></div>
        <div class="sheet-foot"><span class="grow"></span><button class="btn primary" data-close>Done</button></div>`;
      return;
    }
    if (view === 'google-setup' && store.local) {
      node.innerHTML = `<form class="rec-form" data-google-client-form><div class="sheet-head"><div><h2>Set up Google sign-in</h2>
          <small>One-time setup (about 10 minutes): Google needs to know about your Leafdeck before you can connect.</small></div></div>
        <div class="sheet-scroll"><ol class="cal-steps">
          <li>Open <b>console.cloud.google.com</b> and create a project (for example “Leafdeck”).</li>
          <li>In <b>APIs &amp; Services → Library</b>, enable the <b>Google Calendar API</b> and the <b>Gmail API</b>.</li>
          <li>In <b>Google Auth Platform</b> (OAuth consent screen), choose <b>External</b>, fill in the app name and your email, and add your Google address under <b>Test users</b>.
            Then set it to <b>In production</b> — otherwise Google signs you out every 7 days. You’ll see an “unverified app” warning once; choose <b>Advanced → Continue</b>.</li>
          <li>In <b>Clients</b> (Credentials), create an <b>OAuth client ID</b> of type <b>Desktop app</b>. It needs no redirect address.</li>
          <li>Paste its client ID and secret here. They’re encrypted on this computer.</li>
        </ol>
        <div class="form-grid">
          <label class="field span2"><span>Client ID <i>*</i></span><input name="id" required autocomplete="off" placeholder="…apps.googleusercontent.com"></label>
          <label class="field span2"><span>Client secret <i>*</i></span><input name="secret" type="password" required autocomplete="off"></label>
        </div></div>
        <div class="sheet-foot"><button type="button" class="btn" data-view="list">Back</button><span class="grow"></span>
          <button type="submit" class="btn primary">Save</button></div></form>`;
      return;
    }
    if (view === 'google-setup') {
      node.innerHTML = `<div class="sheet-head"><div><h2>Set up Google sign-in</h2>
          <small>One-time setup (about 10 minutes): Google needs to know about your Leafdeck before you can connect.</small></div></div>
        <div class="sheet-scroll"><ol class="cal-steps">
          <li>Open <b>console.cloud.google.com</b> and create a project (for example “Leafdeck”).</li>
          <li>In <b>APIs &amp; Services → Library</b>, enable the <b>Google Calendar API</b>.</li>
          <li>In <b>Google Auth Platform</b> (OAuth consent screen), choose <b>External</b>, fill in the app name and your email, and add your Google address under <b>Test users</b>.
            Then set it to <b>In production</b> — otherwise Google signs you out every 7 days. You’ll see an “unverified app” warning once; choose <b>Advanced → Continue</b>.</li>
          <li>In <b>Clients</b> (Credentials), create an <b>OAuth client ID</b> of type <b>Web application</b> and add this <b>Authorized redirect URI</b>:
            <div class="copy-row"><code>${esc(integrations.redirectUri)}</code><button class="btn small" data-copy="${esc(integrations.redirectUri)}">${icon('copy', 12)} Copy</button></div>
            When you deploy the Worker, add its address too (…/oauth/google/callback).</li>
          <li>Put the client ID and secret in <code>.dev.vars</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then restart <code>npm run dev</code>.
            For the deployed Worker: <code>npx wrangler secret put GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.</li>
        </ol>${integrations.tokenKeyConfigured ? '' : '<p class="txt-red small">The Worker also needs its TOKEN_KEY secret (see README).</p>'}</div>
        <div class="sheet-foot"><button class="btn" data-view="list">Back</button><span class="grow"></span>
          <button class="btn primary" data-recheck>I’ve done this — check again</button></div>`;
      return;
    }
    if (view === 'subscribe') {
      node.innerHTML = `<form class="rec-form" data-subscribe-form>
        <div class="sheet-head"><div><h2>Subscribe to a calendar</h2>
          <small>Paste a calendar’s subscription link (.ics or webcal://). Events show read-only and refresh every 15 minutes.</small></div></div>
        <div class="sheet-scroll"><div class="form-grid">
          <label class="field span2"><span>Calendar link <i>*</i></span><input name="url" placeholder="https://… or webcal://…" required></label>
          <label class="field"><span>Name</span><input name="name" placeholder="Use the calendar’s own name"></label>
          <label class="field"><span>Color</span><input name="color" type="color" value="#0a84ff"></label>
        </div>
        <p class="muted small">Where to find it — <b>iCloud:</b> Calendar → share → Public Calendar · <b>Outlook:</b> Settings → Shared calendars → Publish → ICS ·
          <b>Google:</b> calendar settings → “Secret address in iCal format” · Most other apps have “Subscribe” or “Export link”.</p></div>
        <div class="sheet-foot"><button type="button" class="btn" data-view="list">Back</button><span class="grow"></span>
          <button type="submit" class="btn primary">Subscribe</button></div></form>`;
      setTimeout(() => $('[name=url]', node)?.focus(), 60);
      return;
    }
    const conns = integrations.connections;
    const writable = writableCalendars();
    node.innerHTML = `<div class="sheet-head"><div><h2>Calendars</h2><small>Connected calendars sync every 15 minutes${store.local ? ' while Leafdeck is open' : ', even when Leafdeck is closed'}.</small></div>
        <div class="sheet-actions"><button class="btn small" data-sync-all ${conns.length ? '' : 'disabled'}>${icon('refresh', 12)} Sync now</button></div></div>
      <div class="sheet-scroll">
        ${conns.length ? '' : '<p class="muted">No calendars connected yet.</p>'}
        ${conns
          .map(
            (c) => `<section class="cal-conn" data-conn="${c.id}">
              <header>${c.provider === 'google' ? `<img src="${GOOGLE_LOGO}" alt="" class="cal-logo">` : `<span class="cal-logo cal-logo-ics">${icon('link', 13)}</span>`}
                <span class="cal-conn-name"><b>${esc(c.name)}</b><small>${c.provider === 'google' ? 'Google Calendar · two-way' : `Subscription · read-only${c.host ? ' · ' + esc(c.host) : ''}`}</small></span>
                ${status(c)}
                <button class="icon-btn" data-conn-sync title="Sync now">${icon('refresh', 13)}</button>
                ${c.provider === 'google' && c.status === 'needs_reauth' ? '<button class="btn small" data-connect-google>Reconnect</button>' : ''}
                <button class="icon-btn" data-disconnect title="Disconnect">${icon('trash', 13)}</button></header>
              ${c.status === 'error' && c.error ? `<p class="txt-red small">${esc(c.error)}</p>` : ''}
              ${
                c.provider === 'google'
                  ? `<div class="cal-list">${c.calendars
                      .map((k) => `<label class="cal-item"><input type="checkbox" data-cal="${esc(k.id)}" ${k.selected ? 'checked' : ''}>
                        <i class="cal-swatch" style="background:${esc(k.color || '#888')}"></i><span>${esc(k.name)}</span>${k.writable ? '' : '<small class="muted">read-only</small>'}</label>`)
                      .join('')}</div>`
                  : `<div class="cal-list"><label class="cal-item"><input type="color" data-ics-color value="${esc(c.color || '#0a84ff')}"><span>Color</span></label></div>`
              }
            </section>`,
          )
          .join('')}
        <div class="cal-add">
          <button class="btn" data-connect-google><img src="${GOOGLE_LOGO}" alt="" class="cal-logo">Connect Google Calendar</button>
          <button class="btn" data-view="subscribe">${icon('link', 13)} Subscribe by link…</button>
        </div>
        ${
          writable.length
            ? `<label class="field cal-default"><span>New events go to</span><select data-default-cal>
                <option value="">Leafdeck only</option>${writable.map((o) => `<option value="${esc(o.value)}" ${store.prefs.defaultCalendar === o.value ? 'selected' : ''}>${esc(o.name)} — ${esc(o.account)}</option>`).join('')}</select></label>`
            : ''
        }
      </div>
      <div class="sheet-foot"><span class="grow"></span><button class="btn primary" data-close>Done</button></div>`;
  };

  const run = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(cleanError(err), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  node.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return sh.close();
    const v = t.closest('[data-view]');
    if (v) {
      view = v.dataset.view;
      return draw();
    }
    const copy = t.closest('[data-copy]');
    if (copy) return navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('Copied'));
    if (t.closest('[data-recheck]')) {
      return run(null, async () => {
        await loadIntegrations();
        if (integrations.googleConfigured) {
          view = 'list';
          toast('Google sign-in is ready — click Connect Google Calendar');
        } else {
          // Say which server answered: usually the credentials went to one Worker and Leafdeck is talking to another.
          const server = shell ? (await shell.info()).serverUrl : location.origin;
          toast(`${server.replace(/^https?:\/\//, '')} has no Google credentials yet — check the server address in Settings → Leafdeck app`, 'error');
        }
        draw();
      });
    }
    const g = t.closest('[data-connect-google]');
    if (g) {
      if (!integrations.googleConfigured) {
        view = 'google-setup';
        return draw();
      }
      return run(g, async () => {
        toast('Finish signing in to Google in your browser…');
        const c = await connectGoogle();
        if (!c) toast('Didn’t see a new Google account — try again if sign-in didn’t finish.', 'error');
      });
    }
    if (t.closest('[data-sync-all]')) return run(t.closest('[data-sync-all]'), async () => report(await syncNow()));
    const conn = t.closest('[data-conn]')?.dataset.conn;
    if (conn && t.closest('[data-conn-sync]')) return run(t.closest('[data-conn-sync]'), async () => report(await syncNow(conn)));
    const del = t.closest('[data-disconnect]');
    if (conn && del) {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.title = 'Click again to disconnect (events are removed from Leafdeck, not from the calendar)';
        return setTimeout(() => del.classList.remove('confirm'), 3500);
      }
      return run(del, async () => {
        await disconnect(conn);
        toast('Disconnected');
      });
    }
  });

  node.addEventListener('change', (e) => {
    const t = e.target;
    const conn = t.closest('[data-conn]')?.dataset.conn;
    if (conn && t.matches('[data-cal]')) {
      const calendars = $$('[data-cal]', t.closest('[data-conn]')).map((x) => ({ id: x.dataset.cal, selected: x.checked }));
      return run(null, () => updateConnection(conn, { calendars }));
    }
    if (conn && t.matches('[data-ics-color]')) return run(null, () => updateConnection(conn, { color: t.value }).then(() => syncNow(conn)));
    if (t.matches('[data-default-cal]')) store.setPrefs({ defaultCalendar: t.value });
  });

  node.addEventListener('submit', (e) => {
    if (e.target.matches('[data-google-client-form]')) {
      e.preventDefault();
      const f = e.target.elements;
      return run(e.target.querySelector('[type=submit]'), async () => {
        await shell.secrets.set('googleClientId', f.id.value);
        await shell.secrets.set('googleClientSecret', f.secret.value);
        await loadIntegrations();
        view = 'list';
        toast('Google sign-in is ready — click Connect Google Calendar');
        draw();
      });
    }
    if (!e.target.matches('[data-subscribe-form]')) return;
    e.preventDefault();
    const f = e.target.elements;
    run(e.target.querySelector('[type=submit]'), async () => {
      const r = await subscribe(f.url.value, f.name.value, f.color.value);
      toast(`Subscribed — ${r.result.added} events added`);
      view = 'list';
      draw();
    });
  });

  const report = (results) => {
    const vals = Object.values(results || {});
    const errors = vals.filter((r) => r.error);
    if (errors.length) toast(errors[0].error, 'error');
    else {
      const n = vals.reduce((t, r) => t + (r.added || 0) + (r.updated || 0) + (r.removed || 0), 0);
      toast(n ? `Synced — ${n} change${n === 1 ? '' : 's'}` : 'Everything’s up to date');
    }
  };

  const off = onIntegrations(() => view === 'list' && node.isConnected && draw());
  win.cleanups.push(off);
  draw();
  loadIntegrations();
  return sh;
}

/** Open the Calendar app with its Calendars sheet (used from Settings). */
export function manageCalendars() {
  const w = openApp('calendar');
  if (w) openCalendarsSheet(w);
}

registerApp({
  id: 'calendar',
  name: 'Calendar',
  icon: 'calendar',
  color: 'red',
  size: [1100, 720],
  min: [640, 480],
  newLabel: 'Event',
  create: (win, d) => editRecord(win, 'events', null, d),
  openRecord: (win, id) => {
    const r = store.get('events', id);
    if (r) editRecord(win, 'events', r);
  },
  mount(win) {
    const cur = new Date();
    cur.setDate(1);
    let sel = today();

    win.tools.innerHTML = `
      <button class="tb-pill" data-calendars title="Connect and choose calendars">${icon('calendar', 12)} Calendars</button>
      <button class="tb-btn" data-nav="-1" title="Previous month">${icon('left', 15)}</button>
      <button class="tb-pill" data-nav="0">Today</button>
      <button class="tb-btn" data-nav="1" title="Next month">${icon('right', 15)}</button>
      <button class="tb-btn" data-act="new" title="New event">${icon('plus', 16)}</button>`;

    const chip = (it, full = false) =>
      `<button class="cal-chip k-${it.kind} ${it.color ? 'has-color' : ''} ${it.continued ? 'continued' : ''}"
        ${it.color ? `style="--evc:${esc(it.color)}"` : ''} data-open="${it.col}:${it.r.id}" title="${esc(it.label)}">
        ${it.kind !== 'ev' ? icon(KIND_ICON[it.kind], 11) : ''}${it.time ? `<em>${esc(fmtTime(it.time))}</em>` : ''}<span>${esc(it.label)}</span>
        ${full && it.r.location ? `<small>${esc(it.r.location)}</small>` : ''}</button>`;

    const legend = () => {
      const cals = integrations.connections.flatMap((c) => (c.provider === 'google' ? c.calendars.filter((k) => k.selected) : c.calendars)).slice(0, 6);
      return cals.map((k) => `<span><i style="background:${esc(k.color || '#888')}"></i>${esc(k.name)}</span>`).join('');
    };

    const draw = () => {
      const items = calendarItems();
      const start = new Date(cur);
      start.setDate(1 - start.getDay());
      const days = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push(d);
      }
      const t = today();
      const selItems = items[sel] || [];
      win.body.innerHTML = `<div class="cal">
        <div class="cal-main">
          <h1 class="cal-title">${cur.toLocaleDateString('en-US', { month: 'long' })} <span>${cur.getFullYear()}</span></h1>
          <div class="cal-dow">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<span>${d}</span>`).join('')}</div>
          <div class="cal-grid">${days
            .map((d) => {
              const iso = isoDate(d);
              const list = items[iso] || [];
              const cls = [d.getMonth() !== cur.getMonth() && 'out', iso === t && 'today', iso === sel && 'sel'].filter(Boolean).join(' ');
              return `<div class="cal-day ${cls}" data-date="${iso}"><span class="cal-num">${d.getDate()}</span>
                ${list.slice(0, 3).map((it) => chip(it)).join('')}${list.length > 3 ? `<span class="cal-more">+${list.length - 3} more</span>` : ''}</div>`;
            })
            .join('')}</div>
        </div>
        <aside class="cal-side">
          <h3>${esc(parseDate(sel).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</h3>
          ${selItems.length ? selItems.map((it) => chip(it, true)).join('') : '<p class="muted">Nothing scheduled.</p>'}
          <button class="btn small" data-new-on="${sel}">${icon('plus', 12)} Add event</button>
          <div class="cal-legend">
            <span><i class="k-ev"></i>Events</span><span><i class="k-task"></i>Tasks</span>${legend()}
          </div>
        </aside></div>`;
    };

    win.tools.addEventListener('click', (e) => {
      if (e.target.closest('[data-calendars]')) return openCalendarsSheet(win);
      const n = e.target.closest('[data-nav]');
      if (n) {
        const v = Number(n.dataset.nav);
        if (v === 0) {
          const d = new Date();
          cur.setFullYear(d.getFullYear(), d.getMonth(), 1);
          sel = today();
        } else cur.setMonth(cur.getMonth() + v);
        draw();
      }
      if (e.target.closest('[data-act=new]')) editRecord(win, 'events', null, { date: sel });
    });

    win.body.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      if (open) {
        const [col, id] = open.dataset.open.split(':');
        return editRecord(win, col, store.get(col, id));
      }
      const nw = e.target.closest('[data-new-on]');
      if (nw) return editRecord(win, 'events', null, { date: nw.dataset.newOn });
      const day = e.target.closest('[data-date]');
      if (day) {
        sel = day.dataset.date;
        const d = parseDate(sel);
        if (d.getMonth() !== cur.getMonth()) cur.setFullYear(d.getFullYear(), d.getMonth(), 1);
        draw();
      }
    });
    win.body.addEventListener('dblclick', (e) => {
      const day = e.target.closest('[data-date]');
      if (day && !e.target.closest('[data-open]')) editRecord(win, 'events', null, { date: day.dataset.date });
    });

    win.watch(['events', 'tasks', 'sprints'], draw);
    win.cleanups.push(onIntegrations(draw));
    draw();
  },
});
