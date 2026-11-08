import { store } from './store.js';
import { esc, el, $, $$, today, fmtDate, fmtTime, relDay } from './util.js';
import { icon, PALETTE } from './icons.js';
import { writableCalendars, calendarInfo } from './integrations.js';

/** Google Calendar's event colors (colorId → name, shade), in Google's order. '' = use the calendar's color. */
export const EVENT_COLORS = [
  ['', 'Calendar color', ''],
  ['11', 'Tomato', '#d50000'],
  ['4', 'Flamingo', '#e67c73'],
  ['6', 'Tangerine', '#f4511e'],
  ['5', 'Banana', '#f6bf26'],
  ['2', 'Sage', '#33b679'],
  ['10', 'Basil', '#0b8043'],
  ['7', 'Peacock', '#039be5'],
  ['9', 'Blueberry', '#3f51b5'],
  ['1', 'Lavender', '#7986cb'],
  ['3', 'Grape', '#8e24aa'],
  ['8', 'Graphite', '#616161'],
];
const eventColorHex = (id) => EVENT_COLORS.find(([k]) => k && k === String(id || ''))?.[2] || '';

/* ---------------- Shared helpers ---------------- */

export const refName = (col, id) => {
  const r = store.get(col, id);
  return r ? schemas[col].title(r) : '';
};

const PILL = {
  green: ['Done', 'Active', 'Client', 'Completed'],
  blue: ['In Progress', 'Sent', 'Partner'],
  yellow: ['Medium', 'Planning', 'On Hold', 'Draft'],
  red: ['High', 'Overdue'],
};
export function pill(text) {
  if (!text) return '';
  const color = Object.keys(PILL).find((c) => PILL[c].includes(text)) || 'gray';
  return `<span class="pill pill-${color}">${esc(text)}</span>`;
}

export const avatar = (name, size = 28) => {
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  const ini = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return `<span class="avatar" style="--h:${h};width:${size}px;height:${size}px;font-size:${size * 0.4}px">${esc(ini || '?')}</span>`;
};

export const hostLabel = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const distinct = (col, k, base = []) =>
  [...new Set([...base, ...store.all(col).map((r) => r[k]).filter(Boolean)])].sort();

/** "a, b" → ['a', 'b'] for comma-separated tag fields. */
export const splitTags = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
/** Every tag used on a task, most used first. */
export function taskTags(rows = store.all('tasks')) {
  const n = new Map();
  for (const r of rows) for (const t of splitTags(r.tags)) n.set(t, (n.get(t) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/* ---------------- Schemas ---------------- */

export const schemas = {
  contacts: {
    label: 'Contact',
    plural: 'Contacts',
    app: 'contacts',
    title: (r) => r.name || 'Unnamed',
    sub: (r) => [r.company, r.type, r.email].filter(Boolean).join(' · '),
    search: ['name', 'company', 'email', 'phone', 'tags', 'notes', 'type'],
    fields: [
      { k: 'name', l: 'Name', t: 'text', req: true },
      { k: 'company', l: 'Company / Organization', t: 'text' },
      { k: 'type', l: 'Type', t: 'select', opts: ['Lead', 'Client', 'Partner', 'Vendor', 'Other'] },
      { k: 'email', l: 'Email', t: 'email' },
      { k: 'phone', l: 'Phone', t: 'tel' },
      { k: 'website', l: 'Website', t: 'url' },
      { k: 'tags', l: 'Tags', t: 'text', ph: 'comma, separated' },
      { k: 'address', l: 'Address', t: 'textarea', rows: 2, w: 2 },
      { k: 'notes', l: 'Notes', t: 'textarea', w: 2 },
    ],
    actions: (r) => [
      r.email && { label: 'Email', icon: 'mail', href: `mailto:${r.email}` },
      r.phone && { label: 'Call', icon: 'phone', href: `tel:${r.phone}` },
    ],
    related(r) {
      const groups = [
        ['events', 'Events', (d) => d.contactId === r.id, (d) => fmtDate(d.date)],
      ];
      return relatedHTML(groups);
    },
  },

  tasks: {
    label: 'Task',
    plural: 'Tasks',
    app: 'tasks',
    title: (r) => r.title || 'Untitled task',
    sub: (r) => [r.due && relDay(r.due) + (r.dueTime ? ` ${fmtTime(r.dueTime)}` : ''), r.status].filter(Boolean).join(' · '),
    search: ['title', 'notes', 'tags'],
    fields: [
      { k: 'title', l: 'Task', t: 'text', req: true, w: 2 },
      { k: 'sprintId', l: 'Sprint', t: 'ref', ref: 'sprints' },
      { k: 'due', l: 'Due', t: 'date' },
      { k: 'dueTime', l: 'Time', t: 'time' },
      { k: 'remindAt', l: 'Remind me', t: 'datetime-local' },
      { k: 'priority', l: 'Priority', t: 'select', opts: ['Low', 'Medium', 'High'] },
      { k: 'status', l: 'Status', t: 'select', opts: ['To Do', 'In Progress', 'Done'] },
      { k: 'contactId', l: 'Related contact', t: 'ref', ref: 'contacts' },
      { k: 'tags', l: 'Tags', t: 'text', ph: 'comma, separated', suggest: () => taskTags() },
      { k: 'url', l: 'Link', t: 'url', ph: 'example.com' },
      { k: 'notes', l: 'Notes', t: 'textarea', w: 2 },
    ],
    defaults: () => ({ status: 'To Do', priority: 'Medium' }),
    beforeSave: (r, prev) => {
      if (r.status === 'Done' && prev?.status !== 'Done') r.completedAt = Date.now();
      if (r.status !== 'Done') delete r.completedAt;
    },
  },

  // A sprint is a focused block of time on one day that groups the tasks you'll work through in it.
  sprints: {
    label: 'Sprint',
    plural: 'Sprints',
    app: 'tasks',
    title: (r) => r.name || 'Untitled sprint',
    sub: (r) => [fmtDate(r.date), r.time && fmtTime(r.time)].filter(Boolean).join(' · '),
    search: ['name', 'notes'],
    fields: [
      { k: 'name', l: 'Sprint', t: 'text', req: true, w: 2 },
      { k: 'date', l: 'Date', t: 'date', req: true },
      { k: 'time', l: 'Start time', t: 'time' },
      { k: 'endTime', l: 'End time', t: 'time' },
      { k: 'status', l: 'Status', t: 'select', opts: ['Planned', 'Done'] },
      { k: 'notes', l: 'Notes', t: 'textarea', w: 2 },
    ],
    defaults: () => ({ date: today(), status: 'Planned' }),
    beforeSave: (r) => {
      if (r.endTime && r.time && r.endTime <= r.time) r.endTime = '';
    },
    related: (r) => relatedHTML([['tasks', 'Tasks', (t) => t.sprintId === r.id, (t) => [t.status, t.due && relDay(t.due)].filter(Boolean).join(' · ')]]),
  },

  events: {
    label: 'Event',
    plural: 'Events',
    app: 'calendar',
    title: (r) => r.title || 'Untitled event',
    sub: (r) => [fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' }), r.location].filter(Boolean).join(' · '),
    search: ['title', 'location', 'notes'],
    fields: [
      { k: 'title', l: 'Event', t: 'text', req: true, w: 2 },
      { k: 'date', l: 'Date', t: 'date', req: true },
      { k: 'endDate', l: 'Ends (for multi-day events)', t: 'date' },
      { k: 'time', l: 'Start time', t: 'time' },
      { k: 'endTime', l: 'End time', t: 'time' },
      { k: 'calendar', l: 'Calendar', t: 'calendar' },
      { k: 'gcolor', l: 'Color', t: 'gcolor', w: 2 },
      { k: 'location', l: 'Location / link', t: 'text' },
      { k: 'contactId', l: 'With', t: 'ref', ref: 'contacts' },
      { k: 'notes', l: 'Notes', t: 'textarea', w: 2 },
    ],
    defaults: () => ({ date: today(), calendar: store.prefs.defaultCalendar || '' }),
    beforeSave: (r) => {
      if (r.endDate && r.endDate <= r.date) r.endDate = '';
      // Show the chosen color right away; for Google events the server confirms it (and syncs it to Google).
      if (r.gcolor) r.color = eventColorHex(r.gcolor);
      else if (!r.calendar) r.color = '';
    },
    // Events from subscribed (read-only) calendars can be viewed but not changed.
    readOnly: (r) => r.readOnly && `From ${calendarInfo(r.calendar)?.name || 'a subscribed calendar'} — read-only. Change it in the calendar it comes from.`,
    actions: (r) => [r.url && { label: r.source === 'google' ? 'Open in Google Calendar' : 'Open link', icon: 'external', href: r.url }],
  },

  notes: {
    label: 'Note',
    plural: 'Notes',
    app: 'notes',
    // Rich-text notes keep HTML in body and plain text in text (older notes are plain text in body).
    title: (r) => r.title || (r.format === 'html' ? r.text || '' : r.body || '').split('\n')[0].slice(0, 60) || 'New note',
    sub: (r) => (r.format === 'html' ? r.text || '' : r.body || '').replace(/\s+/g, ' ').slice(0, 80),
    search: ['title', 'text', 'body'],
    fields: [
      { k: 'title', l: 'Title', t: 'text', w: 2 },
      { k: 'body', l: 'Note', t: 'textarea', rows: 10, w: 2 },
    ],
  },

  bookmarks: {
    label: 'Bookmark',
    plural: 'Bookmarks',
    app: 'bookmarks',
    title: (r) => r.title || r.url,
    sub: (r) => [hostLabel(r.url), r.folder].filter(Boolean).join(' · '),
    search: ['title', 'url', 'folder', 'tags'],
    fields: [
      { k: 'title', l: 'Title', t: 'text', w: 2 },
      { k: 'url', l: 'URL', t: 'url', req: true, w: 2 },
      { k: 'folder', l: 'Folder', t: 'text', ph: 'e.g. Dev/Cloudflare', suggest: () => distinct('bookmarks', 'folder') },
      { k: 'tags', l: 'Tags', t: 'text', ph: 'comma, separated' },
    ],
    defaults: () => ({ folder: 'Leafdeck' }),
  },

  links: {
    label: 'Connection',
    plural: 'Connections',
    app: 'connections',
    title: (r) => r.name || 'Connection',
    sub: (r) => r.url,
    search: ['name', 'url', 'category'],
    fields: [
      { k: 'name', l: 'Name', t: 'text', req: true },
      { k: 'category', l: 'Category', t: 'text', suggest: () => distinct('links', 'category', ['Email', 'Files', 'Finance', 'Marketing', 'Design', 'Dev', 'Social']) },
      { k: 'url', l: 'URL', t: 'url', req: true, w: 2 },
      { k: 'logo', l: 'Logo image URL', t: 'url', ph: 'Leave blank to use the site’s own logo automatically', w: 2 },
      { k: 'noLogo', l: 'Use a letter icon instead of the logo', t: 'checkbox', w: 2 },
      { k: 'glyph', l: 'Letter / emoji (when there’s no logo)', t: 'text', ph: 'e.g. S or 💳', max: 2 },
      { k: 'color', l: 'Letter icon color', t: 'color', w: 2 },
      { k: 'separateSession', l: 'Use a separate login (e.g. a second account) — desktop app only', t: 'checkbox', w: 2 },
      { k: 'embed', l: 'In the web version, try opening inside a window (most sites block this)', t: 'checkbox', w: 2 },
      { k: 'desktop', l: 'Show on desktop', t: 'checkbox' },
    ],
    defaults: () => ({ color: 'blue', desktop: true, url: 'https://' }),
  },
};

/** Collections that power the search and calendar, in display order. */
export const COLLECTIONS = Object.keys(schemas);

export function recordMatches(col, r, q) {
  const sc = schemas[col];
  const hay = [sc.title(r), ...(sc.search || []).map((k) => r[k])].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

function relatedHTML(groups) {
  return groups
    .map(([col, label, pred, sub]) => {
      const rows = store.all(col).filter(pred);
      if (!rows.length) return '';
      return `<div class="related-group"><h4>${label} <span>${rows.length}</span></h4>${rows
        .slice(0, 8)
        .map(
          (x) => `<button type="button" class="related-row" data-open="${col}:${x.id}">
            <span>${esc(schemas[col].title(x))}</span><small>${esc(sub(x) || '')}</small></button>`,
        )
        .join('')}</div>`;
    })
    .join('');
}

/* ---------------- Form builder ---------------- */

function inputHTML(f, v) {
  const name = `name="${f.k}"`;
  const req = f.req ? 'required' : '';
  const ph = f.ph ? `placeholder="${esc(f.ph)}"` : '';
  switch (f.t) {
    case 'textarea':
      return `<textarea ${name} rows="${f.rows || 4}" ${ph}>${esc(v)}</textarea>`;
    case 'select':
      return `<select ${name}>${f.opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'ref': {
      const sc = schemas[f.ref];
      const opts = store
        .all(f.ref)
        .map((r) => [r.id, sc.title(r)])
        .sort((a, b) => a[1].localeCompare(b[1]));
      return `<select ${name}><option value="">—</option>${opts
        .map(([id, t]) => `<option value="${id}" ${id === v ? 'selected' : ''}>${esc(t)}</option>`)
        .join('')}</select>`;
    }
    case 'number':
      return `<input type="number" step="any" ${name} value="${v ?? ''}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${req}>`;
    case 'checkbox':
      return `<input type="checkbox" ${name} ${v ? 'checked' : ''}>`;
    case 'color':
      return `<div class="swatches">${Object.keys(PALETTE)
        .map(
          (c) => `<label class="swatch" style="--c1:${PALETTE[c][0]};--c2:${PALETTE[c][1]}" title="${c}">
            <input type="radio" ${name} value="${c}" ${c === v ? 'checked' : ''}><span></span></label>`,
        )
        .join('')}</div>`;
    case 'gcolor':
      return `<div class="swatches">${EVENT_COLORS.map(
        ([id, label, hex]) => `<label class="swatch${id ? '' : ' swatch-auto'}" ${hex ? `style="--c1:${hex};--c2:${hex}"` : ''} title="${label}">
            <input type="radio" ${name} value="${id}" ${String(v || '') === id ? 'checked' : ''}><span></span></label>`,
      ).join('')}</div>`;
    case 'calendar': {
      // Leafdeck only, or one of your connected calendars you can write to.
      const opts = writableCalendars();
      const cur = v && !opts.some((o) => o.value === v) ? calendarInfo(v) : null;
      return `<select ${name}><option value="">Leafdeck only</option>${opts
        .map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.name)} — ${esc(o.account)}</option>`)
        .join('')}${cur ? `<option value="${esc(v)}" selected>${esc(cur.name)}</option>` : ''}</select>`;
    }
    default: {
      const list = f.suggest ? `list="dl-${f.k}"` : '';
      const dl = f.suggest
        ? `<datalist id="dl-${f.k}">${f.suggest().map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`
        : '';
      // URLs: a plain text box (type=url would reject "example.com"); normalizeUrl adds https:// on save.
      const type = f.t === 'url' ? 'text" inputmode="url" spellcheck="false' : f.t;
      return `<input type="${type}" ${name} value="${esc(v)}" ${ph} ${req} ${list} ${f.max ? `maxlength="${f.max}"` : ''}>${dl}`;
    }
  }
}

/** "example.com" → "https://example.com"; a lone "https://" (the prefilled start) counts as empty. */
export function normalizeUrl(value) {
  let v = String(value || '').trim();
  v = v.replace(/^(https?:\/\/)+(?=https?:\/\/)/i, ''); // pasted a full URL after the prefilled https://
  if (/^https?:\/\/?$/i.test(v)) return '';
  if (v && !/^[a-z][a-z\d+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  return v;
}

function readForm(form, sc) {
  const out = {};
  for (const f of sc.fields) {
    const inp = form.elements[f.k];
    if (!inp) continue;
    if (f.t === 'checkbox') out[f.k] = inp.checked;
    else if (f.t === 'number') out[f.k] = inp.value === '' ? null : Number(inp.value);
    else if (f.t === 'url') out[f.k] = normalizeUrl(inp.value);
    else out[f.k] = (inp.value || '').trim();
  }
  return out;
}

/**
 * Open a sheet in `win` to create or edit a record.
 * `rec` null → new record seeded from schema defaults + `defaults`.
 */
export function editRecord(win, col, rec = null, defaults = {}) {
  const sc = schemas[col];
  const isNew = !rec?.id;
  const r = isNew ? { ...(sc.defaults?.() || {}), ...defaults } : { ...rec };
  const actions = (!isNew && sc.actions?.(r)?.filter(Boolean)) || [];
  const locked = !isNew && sc.readOnly?.(r); // a message when the record can't be edited here

  const form = el(`<form class="rec-form" novalidate>
    <div class="sheet-head">
      <div><h2>${isNew ? 'New ' + esc(sc.label) : esc(sc.title(r))}</h2>
      ${!isNew ? `<small>Updated ${new Date(r.updatedAt || Date.now()).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</small>` : ''}</div>
      <div class="sheet-actions">${actions
        .map((a, i) =>
          a.href
            ? `<a class="btn small" href="${esc(a.href)}" target="_blank" rel="noopener">${icon(a.icon, 13)} ${esc(a.label)}</a>`
            : `<button type="button" class="btn small" data-action="${i}">${icon(a.icon, 13)} ${esc(a.label)}</button>`,
        )
        .join('')}</div>
    </div>
    <div class="sheet-scroll">
      ${locked ? `<div class="sheet-note">${icon('shield', 14)}<span>${esc(locked)}</span></div>` : ''}
      <div class="form-grid">${sc.fields
        .map((f) =>
          f.t === 'checkbox'
            ? `<label class="field check ${f.w === 2 ? 'span2' : ''}">${inputHTML(f, r[f.k])}<span>${esc(f.l)}</span></label>`
            : `<label class="field ${f.w === 2 ? 'span2' : ''}"><span>${esc(f.l)}${f.req ? ' <i>*</i>' : ''}</span>${inputHTML(f, r[f.k])}</label>`,
        )
        .join('')}</div>
      ${!isNew && sc.related ? `<div class="related">${sc.related(r)}</div>` : ''}
    </div>
    <div class="sheet-foot">
      ${!isNew && !locked ? `<button type="button" class="btn danger" data-del>${icon('trash', 13)} Delete</button>` : ''}
      <span class="grow"></span>
      <button type="button" class="btn" data-cancel>${locked ? 'Close' : 'Cancel'}</button>
      ${locked ? '' : `<button type="submit" class="btn primary">${isNew ? 'Create' : 'Save'}</button>`}
    </div>
  </form>`);

  const sh = win.sheet(form);
  if (locked) $$('.form-grid input, .form-grid select, .form-grid textarea', form).forEach((x) => (x.disabled = true));

  form.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-cancel]')) return sh.close();
    const act = t.closest('[data-action]');
    if (act) return actions[act.dataset.action].act?.(r, sh);
    const open = t.closest('[data-open]');
    if (open) {
      const [c, id] = open.dataset.open.split(':');
      return editRecord(win, c, store.get(c, id));
    }
    const del = t.closest('[data-del]');
    if (del) {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.lastChild.textContent = ' Click again to delete';
        return;
      }
      store.remove(col, r.id);
      sh.close();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = readForm(form, sc);
    const missing = sc.fields.find((f) => f.req && (data[f.k] === '' || data[f.k] == null));
    if (missing) {
      const inp = form.elements[missing.k];
      inp?.classList.add('invalid');
      inp?.focus();
      return;
    }
    const next = { ...r, ...data };
    sc.beforeSave?.(next, isNew ? null : rec);
    store.save(col, next);
    sh.close();
  });

  setTimeout(() => $('input:not([type=checkbox]):not([type=radio]), textarea, select', form)?.focus(), 60);
  return sh;
}
