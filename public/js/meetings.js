// Meeting notes that create themselves: every calendar event can have a note. Five minutes before a timed
// event starts, the note is created (if it isn't yet) and opened, prefilled with the attendees and an excerpt
// of the last note you took with the same people. Events keep no reference to notes (many are read-only
// copies from Google); the note carries the link: note.meeting = { eventId, date, emails, contactIds }.

import { store } from './store.js';
import { esc, fmtDate, fmtTime, isoDate } from './util.js';
import { openApp, toast } from './wm.js';
import { schemas } from './schemas.js';
import { focusSession } from './focus.js';

const LEAD_MIN = 5;
const LS = 'ws:meetings-opened';

export const noteForEvent = (eventId) => store.all('notes').find((n) => n.meeting?.eventId === eventId);

/** Who's in the meeting: the event's attendees (Google) plus its linked contact, matched to Contacts by email. */
function people(ev) {
  const list = [];
  for (const a of ev.attendees || []) {
    const email = String(a.email || '').toLowerCase();
    if (!email && !a.name) continue;
    list.push({ name: a.name || email.split('@')[0], email, status: a.status || '' });
  }
  const c = store.get('contacts', ev.contactId);
  if (c && !list.some((p) => p.email && p.email === String(c.email || '').toLowerCase())) {
    list.unshift({ name: c.name || c.email || 'Contact', email: String(c.email || '').toLowerCase(), contactId: c.id });
  }
  const contacts = store.all('contacts');
  for (const p of list) {
    if (p.contactId || !p.email) continue;
    const m = contacts.find((x) => String(x.email || '').toLowerCase() === p.email);
    if (m) {
      p.contactId = m.id;
      p.name = m.name || p.name;
    }
  }
  return list;
}

/** The most recent meeting note that shares an attendee (by email or contact) with this event. */
function lastNoteWith(ev) {
  const ps = people(ev);
  const emails = new Set(ps.map((p) => p.email).filter(Boolean));
  const cids = new Set(ps.map((p) => p.contactId).filter(Boolean));
  if (!emails.size && !cids.size) return null;
  return (
    store
      .all('notes')
      .filter((n) => n.meeting && n.meeting.eventId !== ev.id && ((n.meeting.emails || []).some((e) => emails.has(e)) || (n.meeting.contactIds || []).some((c) => cids.has(c))))
      .sort((a, b) => (b.meeting.date || '').localeCompare(a.meeting.date || '') || (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null
  );
}

const strip = (html) =>
  String(html || '')
    .replace(/<\/(p|h\d|li|blockquote|div|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** What you wrote last time: the part after the "Notes" heading (the rest of the note is the generated header). */
function writtenPart(n) {
  if (n.format !== 'html') return n.body || '';
  const i = (n.body || '').indexOf('<h3>Notes</h3>');
  return strip(i >= 0 ? n.body.slice(i + 14) : n.body);
}

export function buildMeetingNote(ev) {
  const ps = people(ev);
  const when = `${fmtDate(ev.date, { weekday: 'long', month: 'long', day: 'numeric' })}${ev.time ? ` · ${fmtTime(ev.time)}${ev.endTime ? `–${fmtTime(ev.endTime)}` : ''}` : ''}${ev.location ? ` · ${ev.location}` : ''}`;
  const prev = lastNoteWith(ev);
  // Drop the "Action items" section from the excerpt (its checklist rarely reads well as prose).
  const excerpt = prev ? writtenPart(prev).replace(/\n*Action items(\n[\s\S]*)?$/, '').trim() : '';
  let html = `<h1>${esc(ev.title || 'Meeting')}</h1><p><span style="color: #a3aaa6">${esc(when)}</span></p>`;
  if (ps.length) {
    html += `<h3>Attendees</h3><ul>${ps
      .map((p) => `<li>${esc(p.name)}${p.email && p.email !== p.name ? ` <span style="color: #a3aaa6">${esc(p.email)}</span>` : ''}${p.status === 'declined' ? ' <span style="color: #a3aaa6">(declined)</span>' : ''}</li>`)
      .join('')}</ul>`;
  }
  if (prev) {
    const body = excerpt ? esc(excerpt.slice(0, 700)).replace(/\n/g, '<br>') + (excerpt.length > 700 ? '…' : '') : '<span style="color: #a3aaa6">(nothing was written down)</span>';
    html += `<h3>Last time · ${esc(fmtDate(prev.meeting.date, { month: 'short', day: 'numeric' }))}${prev.title ? ` · ${esc(prev.title)}` : ''}</h3><blockquote>${body}</blockquote>`;
  }
  html += '<h3>Notes</h3><p><br></p><h3>Action items</h3><ul class="checklist"><li data-checked="false"><br></li></ul>';
  return { html, people: ps, prev };
}

/** The event's note, created now if it doesn't exist yet. */
export function ensureMeetingNote(ev) {
  const existing = noteForEvent(ev.id);
  if (existing) return existing;
  const { html, people: ps } = buildMeetingNote(ev);
  return store.save('notes', {
    title: ev.title || 'Meeting',
    body: html,
    text: strip(html),
    format: 'html',
    meeting: { eventId: ev.id, date: ev.date, time: ev.time || '', emails: ps.map((p) => p.email).filter(Boolean), contactIds: ps.map((p) => p.contactId).filter(Boolean) },
  });
}

export function openMeetingNote(ev) {
  const n = ensureMeetingNote(ev);
  openApp('notes', { record: n.id });
  return n;
}

/* ---------------- Five minutes before ---------------- */

const opened = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {};
  } catch {
    return {};
  }
};

function check() {
  if (store.prefs.meetingNotes === false) return;
  const now = Date.now();
  const today = isoDate();
  const seen = opened();
  for (const ev of [...store.all('events')]) {
    if (ev.date !== today || !ev.time || seen[ev.id]) continue;
    const start = new Date(`${ev.date}T${ev.time}:00`).getTime();
    if (!start || start - now > LEAD_MIN * 60_000 || start < now - 60_000) continue;
    seen[ev.id] = now;
    for (const [k, t] of Object.entries(seen)) if (now - t > 2 * 86_400_000) delete seen[k];
    try {
      localStorage.setItem(LS, JSON.stringify(seen));
    } catch {}
    const n = ensureMeetingNote(ev);
    const mins = Math.max(1, Math.round((start - now) / 60_000));
    if (focusSession()) toast(`${ev.title} starts in ${mins} min — your notes are ready in Notes`);
    else {
      openApp('notes', { record: n.id });
      toast(`${ev.title} starts in ${mins} min — notes ready`);
    }
  }
}

export function initMeetings() {
  // Events get a "Meeting notes" action on their sheet.
  const prev = schemas.events.actions;
  schemas.events.actions = (r) => [...((prev && prev(r)) || []).filter(Boolean), { label: noteForEvent(r.id) ? 'Open meeting notes' : 'Meeting notes', icon: 'note', act: () => openMeetingNote(r) }];
  setTimeout(check, 4000);
  setInterval(check, 30_000);
  document.addEventListener('visibilitychange', () => !document.hidden && check());
}
