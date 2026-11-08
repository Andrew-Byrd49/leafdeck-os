// Calendar sync: provider events ⇄ Leafdeck "events" records (stored in the generic records table).
import * as google from './google.js';
import { fetchIcs, parseIcs, expand } from './ics.js';
import { hashId, validTz, toLocal } from './util.js';

const DAY = 86_400_000;
const PAST_DAYS = 60;
const FUTURE_DAYS = 365;
const PROVIDER_FIELDS = ['title', 'date', 'time', 'endDate', 'endTime', 'location', 'notes', 'url', 'color', 'gcolor', 'readOnly', 'calendar', 'attendees'];
const sameValue = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

const cfgOf = (row) => JSON.parse(row.config || '{}');

/** What the UI may see about a connection (never tokens; subscription links only by host, they can be secret). */
export function publicConnection(row) {
  const cfg = cfgOf(row);
  let host = '';
  try {
    host = cfg.url ? new URL(cfg.url).host : '';
  } catch {}
  return {
    id: row.id,
    provider: row.provider,
    name: row.provider === 'ics' ? cfg.calendarName || row.name : row.name,
    status: row.status,
    error: row.error,
    lastSync: row.last_sync,
    color: cfg.color || '',
    host,
    // Gmail access was granted (accounts connected before Leafdeck asked for it need reconnecting).
    gmail: row.provider === 'google' && google.hasGmail(cfg),
    calendars:
      row.provider === 'google'
        ? (cfg.calendars || []).map(({ id, name, color, accessRole, primary, selected }) => ({ id, name, color, primary, selected, writable: google.writable({ accessRole }) }))
        : [{ id: 'ics', name: cfg.calendarName || row.name, color: cfg.color || '', selected: true, writable: false }],
  };
}

export const getConnection = (env, id) => env.DB.prepare('SELECT * FROM connections WHERE id = ?1').bind(id).first();

async function linkedEvents(env, connectionId) {
  const { results } = await env.DB.prepare("SELECT data FROM records WHERE collection = 'events' AND json_extract(data, '$.ext.connectionId') = ?1 AND deleted = 0")
    .bind(connectionId)
    .all();
  return results.map((r) => JSON.parse(r.data));
}

const upsert = (env, rec, now) =>
  env.DB.prepare(
    `INSERT INTO records (collection, id, data, created_at, updated_at, deleted) VALUES ('events', ?1, ?2, ?3, ?3, 0)
     ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0`,
  ).bind(rec.id, JSON.stringify(rec), now);
// A tombstone, not a delete, so companion devices drop the event too (see src/companion.js).
const remove = (env, id) => env.DB.prepare("UPDATE records SET deleted = 1, data = '{}', updated_at = ?2 WHERE collection = 'events' AND id = ?1 AND deleted = 0").bind(id, Date.now());

async function runBatches(env, statements) {
  for (let i = 0; i < statements.length; i += 90) await env.DB.batch(statements.slice(i, i + 90));
}

async function setStatus(env, row, status, error = null) {
  await env.DB.prepare('UPDATE connections SET status = ?1, error = ?2 WHERE id = ?3').bind(status, error, row.id).run();
}

/** Pull one connection's events for the sync window and reconcile them with Leafdeck's copies. */
export async function syncConnection(env, row) {
  const cfg = cfgOf(row);
  const tz = validTz(cfg.timeZone);
  const from = new Date(Date.now() - PAST_DAYS * DAY);
  const to = new Date(Date.now() + FUTURE_DAYS * DAY);
  const fromIso = toLocal(from, tz).date;
  const incoming = [];
  let syncedCalendars;

  try {
    if (row.provider === 'google') {
      // Refresh the calendar list (names, colors, new calendars) while keeping your choices.
      const fresh = await google.listCalendars(env, row);
      const prev = new Map((cfg.calendars || []).map((c) => [c.id, c]));
      cfg.calendars = fresh.map((c) => ({ ...c, selected: prev.has(c.id) ? prev.get(c.id).selected : c.primary }));
      const chosen = cfg.calendars.filter((c) => c.selected);
      syncedCalendars = new Set(chosen.map((c) => c.id));
      for (const cal of chosen) {
        for (const ev of await google.listEvents(env, row, cal.id, from.toISOString(), to.toISOString())) incoming.push(google.toRecord(ev, cal, tz));
      }
    } else if (row.provider === 'ics') {
      const { text } = await fetchIcs(cfg.url);
      const parsed = parseIcs(text);
      if (!cfg.calendarName && parsed.name) cfg.calendarName = parsed.name;
      syncedCalendars = new Set(['ics']);
      for (const r of expand(parsed, from, to, tz)) incoming.push({ ...r, color: cfg.color || parsed.color || '', ext: { ...r.ext, calendarId: 'ics' } });
    } else throw new Error(`Unknown provider ${row.provider}`);
  } catch (err) {
    const reauth = err instanceof google.ReauthError;
    await setStatus(env, row, reauth ? 'needs_reauth' : 'error', err.message);
    throw err;
  }

  const existing = await linkedEvents(env, row.id);
  const byKey = new Map(existing.map((e) => [`${e.ext.calendarId}|${e.ext.eventId}`, e]));
  const now = Date.now();
  const keep = new Set();
  const statements = [];
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const r of incoming) {
    const key = `${r.ext.calendarId}|${r.ext.eventId}`;
    const prev = byKey.get(key);
    const id = prev?.id || 'x' + (await hashId(`${row.id}|${key}`));
    if (keep.has(id)) continue;
    keep.add(id);
    // Provider fields come from the source; Leafdeck-only fields (linked contact, workspace) are kept.
    const rec = {
      ...(prev || {}),
      ...r,
      id,
      source: row.provider,
      calendar: `${row.id}:${r.ext.calendarId}`,
      ext: { ...r.ext, connectionId: row.id },
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    if (prev && PROVIDER_FIELDS.every((k) => sameValue(prev[k], rec[k])) && prev.ext?.updated === rec.ext.updated) continue;
    if (prev) updated++;
    else added++;
    statements.push(upsert(env, rec, now));
  }
  // Remove events that disappeared at the source (only inside the window, only for calendars we synced).
  for (const e of existing) {
    if (keep.has(e.id) || !syncedCalendars.has(e.ext.calendarId)) continue;
    if ((e.endDate || e.date) < fromIso) continue;
    statements.push(remove(env, e.id));
    removed++;
  }
  await runBatches(env, statements);
  await env.DB.prepare("UPDATE connections SET config = ?1, status = 'ok', error = NULL, last_sync = ?2 WHERE id = ?3")
    .bind(JSON.stringify(cfg), now, row.id)
    .run();
  return { added, updated, removed };
}

export async function syncAll(env) {
  const { results } = await env.DB.prepare("SELECT * FROM connections WHERE status != 'needs_reauth'").all();
  const out = {};
  for (const row of results) {
    try {
      out[row.id] = await syncConnection(env, row);
    } catch (err) {
      out[row.id] = { error: err.message };
    }
  }
  return out;
}

/** Remove a connection's events from Leafdeck (they stay in the provider). */
export async function removeLinkedEvents(env, connectionId, calendarId = null) {
  const events = (await linkedEvents(env, connectionId)).filter((e) => !calendarId || e.ext.calendarId === calendarId);
  await runBatches(env, events.map((e) => remove(env, e.id)));
  return events.length;
}

/* ---------------- Two-way: Leafdeck edits → Google ---------------- */

const reason = (err) => (err instanceof google.ReauthError ? 'reconnect your Google account' : err.message);

/**
 * Called before an event is saved. Pushes it to (or moves/removes it from) its Google calendar
 * and returns the record to store, plus a warning if the provider couldn't be updated.
 */
export async function beforeSaveEvent(env, rec, prev) {
  if (prev?.readOnly) return { record: prev, warning: 'This event comes from a read-only calendar, so it can’t be changed here.' };
  const target = rec.calendar || '';
  const linked = prev?.ext?.connectionId ? `${prev.ext.connectionId}:${prev.ext.calendarId}` : '';
  try {
    if (linked && linked !== target) {
      await deleteRemote(env, prev);
      for (const k of ['ext', 'url', 'color']) delete rec[k];
      rec.source = 'leafdeck';
    }
    if (target) {
      const i = target.indexOf(':');
      const [connId, calId] = [target.slice(0, i), target.slice(i + 1)];
      const row = await getConnection(env, connId);
      if (!row || row.provider !== 'google') throw new Error('That calendar is no longer connected');
      const cfg = cfgOf(row);
      const cal = (cfg.calendars || []).find((c) => c.id === calId);
      if (!google.writable(cal)) throw new Error('that calendar is read-only');
      const body = google.fromRecord(rec, validTz(cfg.timeZone));
      const updating = linked === target && prev.ext.eventId;
      if (!updating && body.colorId == null) delete body.colorId; // new events: just use the calendar's color
      const ev = updating
        ? await google.updateEvent(env, row, calId, prev.ext.eventId, body)
        : await google.createEvent(env, row, calId, body);
      rec.ext = { connectionId: connId, calendarId: calId, eventId: ev.id, etag: ev.etag, updated: ev.updated, colorId: ev.colorId || '' };
      rec.source = 'google';
      rec.url = ev.htmlLink || '';
      rec.color = google.eventColor(ev, cal); // keeps a color set on the event in Google
    }
    return { record: rec };
  } catch (err) {
    if (err instanceof google.ReauthError) await setStatus(env, { id: (target || linked).split(':')[0] }, 'needs_reauth', err.message);
    return { record: rec, warning: `Saved in Leafdeck, but Google Calendar wasn’t updated (${reason(err)}).` };
  }
}

async function deleteRemote(env, prev) {
  if (prev?.source !== 'google' || !prev.ext?.eventId) return;
  const row = await getConnection(env, prev.ext.connectionId);
  if (row) await google.deleteEvent(env, row, prev.ext.calendarId, prev.ext.eventId);
}

/** Called before an event is deleted: removes it from Google too. */
export async function beforeDeleteEvent(env, prev) {
  if (prev?.readOnly) return { blocked: 'This event comes from a read-only calendar. Remove it in the calendar it came from.' };
  try {
    await deleteRemote(env, prev);
    return {};
  } catch (err) {
    return { warning: `Deleted in Leafdeck, but not from Google Calendar (${reason(err)}).` };
  }
}
