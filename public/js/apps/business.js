import { store } from '../store.js';
import { esc } from '../util.js';
import { registerApp } from '../wm.js';
import { pill, avatar, schemas } from '../schemas.js';
import { collectionApp, stat } from './collection.js';

const main = (title, sub) => `<div class="cell-main"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
const PRIORITY = { High: 0, Medium: 1, Low: 2 };

/* ---------------- Contacts ---------------- */

const TYPES = schemas.contacts.fields.find((f) => f.k === 'type').opts;
registerApp(
  collectionApp({
    id: 'contacts',
    name: 'Contacts',
    icon: 'users',
    color: 'blue',
    col: 'contacts',
    sort: (a, b) => (a.name || '').localeCompare(b.name || ''),
    filters: [{ v: '', l: 'All types' }, ...TYPES.map((t) => ({ v: t, l: t + 's', fn: (r) => r.type === t }))],
    summary: (rows, all) => {
      const n = (t) => all.filter((r) => r.type === t).length;
      return stat('People', all.length) + stat('Clients', n('Client')) + stat('Leads', n('Lead'));
    },
    columns: [
      { l: 'Name', v: (r) => `<div class="cell-person">${avatar(r.name)}${main(r.name, r.company)}</div>` },
      { l: 'Type', v: (r) => pill(r.type) },
      { l: 'Email', v: (r) => (r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '') },
      { l: 'Phone', v: (r) => (r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '') },
      { l: 'Tags', v: (r) => (r.tags || '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('') },
    ],
  }),
);

/* ---------------- Tasks (the planner itself lives in tasks.js) ---------------- */

export function toggleTask(t) {
  const next = { ...t, status: t.status === 'Done' ? 'To Do' : 'Done' };
  schemas.tasks.beforeSave(next, t);
  store.save('tasks', next);
}

export const taskSort = (a, b) =>
  (a.status === 'Done') - (b.status === 'Done') ||
  (a.due || '9999').localeCompare(b.due || '9999') ||
  (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1);
