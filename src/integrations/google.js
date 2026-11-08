// Google: OAuth (authorization code + PKCE), Calendar list/events with two-way mapping, and a read-only Gmail inbox.
import { randomId, sha256, b64url, seal, unseal, toLocal, addDaysIso } from './util.js';
import { parseIcs, eventStart } from './ics.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  GMAIL_SCOPE,
];

export const configured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const redirectUri = (origin) => `${origin}/oauth/google/callback`;

export class ReauthError extends Error {}

/** Begin sign-in: remember a PKCE verifier for this attempt and return Google's consent URL. */
export async function startAuth(env, origin, data = {}) {
  if (!configured(env)) throw new Error('Google sign-in isn’t set up on the Worker yet.');
  const state = randomId(24);
  const verifier = randomId(48);
  const challenge = b64url(await sha256(verifier));
  await env.DB.prepare('DELETE FROM oauth_pending WHERE created_at < ?1').bind(Date.now() - 15 * 60_000).run();
  await env.DB.prepare('INSERT INTO oauth_pending (state, provider, verifier, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(state, 'google', verifier, JSON.stringify(data), Date.now())
    .run();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Google token error ${res.status}`);
    err.code = json.error;
    throw err;
  }
  return json;
}

const emailFromIdToken = (idToken) => {
  try {
    return JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || '';
  } catch {
    return '';
  }
};

/** Finish sign-in from Google's redirect: exchange the code, store encrypted tokens, return the connection. */
export async function finishAuth(env, origin, url) {
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const pending = state && (await env.DB.prepare('SELECT * FROM oauth_pending WHERE state = ?1').bind(state).first());
  if (state) await env.DB.prepare('DELETE FROM oauth_pending WHERE state = ?1').bind(state).run();
  if (!pending || Date.now() - pending.created_at > 15 * 60_000) throw new Error('This sign-in link expired. Start again from Leafdeck.');
  if (error) throw new Error(error === 'access_denied' ? 'Google sign-in was canceled.' : `Google returned an error: ${error}`);

  const tokens = await tokenRequest({
    code: url.searchParams.get('code'),
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(origin),
    grant_type: 'authorization_code',
    code_verifier: pending.verifier,
  });
  if (!tokens.refresh_token) throw new Error('Google didn’t grant offline access. Remove Leafdeck from your Google account’s third-party access and try again.');
  const email = emailFromIdToken(tokens.id_token);
  const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean); // what was actually granted
  const secret = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + (tokens.expires_in - 60) * 1000 };
  const data = JSON.parse(pending.data || '{}');

  const calendars = (await listCalendarsWithToken(tokens.access_token)).map((c) => ({ ...c, selected: c.primary || c.selected }));
  const existing = await env.DB.prepare("SELECT * FROM connections WHERE provider = 'google' AND name = ?1").bind(email).first();
  if (existing) {
    // Reconnecting the same account: keep which calendars were chosen.
    const cfg = JSON.parse(existing.config || '{}');
    const chosen = new Set((cfg.calendars || []).filter((c) => c.selected).map((c) => c.id));
    cfg.calendars = calendars.map((c) => ({ ...c, selected: chosen.size ? chosen.has(c.id) : c.selected }));
    cfg.timeZone = data.timeZone || cfg.timeZone;
    cfg.scopes = scopes;
    await env.DB.prepare("UPDATE connections SET secret = ?1, config = ?2, status = 'ok', error = NULL WHERE id = ?3")
      .bind(await seal(env, secret), JSON.stringify(cfg), existing.id)
      .run();
    return { id: existing.id, name: email };
  }
  const id = 'g' + randomId(9);
  const cfg = { email, timeZone: data.timeZone || 'UTC', calendars, scopes };
  await env.DB.prepare("INSERT INTO connections (id, provider, name, config, secret, status, created_at) VALUES (?1, 'google', ?2, ?3, ?4, 'ok', ?5)")
    .bind(id, email || 'Google account', JSON.stringify(cfg), await seal(env, secret), Date.now())
    .run();
  return { id, name: email };
}

/** A valid access token for a connection, refreshing (and re-storing) it when needed. */
async function accessToken(env, conn, force = false) {
  const t = await unseal(env, conn.secret);
  if (!force && t.expires_at > Date.now() + 30_000) return t.access_token;
  try {
    const r = await tokenRequest({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    });
    const next = { ...t, access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 60) * 1000 };
    conn.secret = await seal(env, next);
    await env.DB.prepare('UPDATE connections SET secret = ?1 WHERE id = ?2').bind(conn.secret, conn.id).run();
    return next.access_token;
  } catch (err) {
    if (err.code === 'invalid_grant') throw new ReauthError('Google access was revoked or expired — reconnect this account.');
    throw err;
  }
}

async function api(env, conn, path, opts = {}, retried = false) {
  const token = await accessToken(env, conn, retried);
  const res = await fetch(path.startsWith('https://') ? path : API + path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401 && !retried) return api(env, conn, path, opts, true);
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const gmail = path.startsWith(GMAIL);
    const err = new Error(`${gmail ? 'Gmail' : 'Google Calendar'}: ${json.error?.message || res.statusText}`);
    err.status = res.status;
    // 403 with an insufficient-scope reason: the account was connected before Leafdeck asked for Gmail access.
    if (res.status === 403 && /scope|insufficient/i.test(JSON.stringify(json.error || ''))) err.code = 'scope';
    throw err;
  }
  return json;
}

/* ---------------- Gmail (read-only inbox) ---------------- */

export const hasGmail = (cfg) => Array.isArray(cfg?.scopes) && cfg.scopes.includes(GMAIL_SCOPE);

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
const parseFrom = (v) => {
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || m[2], email: m[2] } : { name: v.replace(/^<|>$/g, ''), email: v.replace(/^<|>$/g, '') };
};

// Gmail's snippets come HTML-escaped ("Our Work&quot;", "Edna&#39;s").
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) =>
  String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });

/** Recent inbox messages (newest first) with the unread count, without bodies. */
export async function listMail(env, conn, { max = 12, unreadOnly = false } = {}) {
  const q = unreadOnly ? 'in:inbox is:unread' : 'in:inbox';
  const n = Math.min(25, Math.max(1, max | 0));
  const [list, label] = await Promise.all([
    api(env, conn, `${GMAIL}/messages?maxResults=${n}&q=${encodeURIComponent(q)}`),
    api(env, conn, `${GMAIL}/labels/INBOX`).catch(() => null),
  ]);
  const ids = (list.messages || []).map((m) => m.id);
  const metas = await Promise.all(
    ids.map((id) => api(env, conn, `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
  );
  const messages = metas.map((m) => {
    const from = parseFrom(header(m, 'from'));
    const labels = m.labelIds || [];
    return {
      id: m.id,
      threadId: m.threadId,
      from: from.name,
      fromEmail: from.email,
      subject: header(m, 'subject') || '(no subject)',
      snippet: decodeEntities(m.snippet).slice(0, 160),
      date: Number(m.internalDate) || Date.parse(header(m, 'date')) || 0,
      unread: labels.includes('UNREAD'),
      important: labels.includes('IMPORTANT'),
      attachments: /multipart\/mixed/i.test(m.payload?.mimeType || ''),
    };
  });
  messages.sort((a, b) => b.date - a.date);
  return { messages, unreadCount: label?.messagesUnread ?? messages.filter((m) => m.unread).length, email: JSON.parse(conn.config || '{}').email || conn.name };
}

const fromB64url = (s) => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
const isCalendarPart = (p) => /^(text\/calendar|application\/ics)$/i.test(p.mimeType || '') || /\.ics$/i.test(p.filename || '');

/**
 * The calendar invite attached to one message, if any: { summary, method, start: { date } | { at } }.
 * Google, Outlook and Apple invites all carry a text/calendar part (inline or as invite.ics).
 */
export async function mailInvite(env, conn, messageId) {
  const msg = await api(env, conn, `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`);
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (isCalendarPart(p)) parts.push(p);
    for (const c of p.parts || []) walk(c);
  };
  walk(msg.payload);
  const tz = JSON.parse(conn.config || '{}').timeZone || 'UTC';
  for (const p of parts) {
    let data = p.body?.data;
    if (!data && p.body?.attachmentId) {
      data = (await api(env, conn, `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(p.body.attachmentId)}`)).data;
    }
    if (!data) continue;
    const parsed = parseIcs(fromB64url(data));
    const ev = parsed.events[0];
    const start = eventStart(ev, tz);
    if (start) return { invite: { summary: ev.summary || '', method: parsed.method, start } };
  }
  return { invite: null };
}

async function listCalendarsWithToken(token) {
  const res = await fetch(`${API}/users/me/calendarList?minAccessRole=reader&maxResults=250`, { headers: { authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google Calendar: ${json.error?.message || res.statusText}`);
  return (json.items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    accessRole: c.accessRole,
    primary: !!c.primary,
    selected: !!c.selected,
  }));
}

export async function listCalendars(env, conn) {
  const token = await accessToken(env, conn);
  return listCalendarsWithToken(token);
}

/** Every event (recurring ones expanded) in a time window. */
export async function listEvents(env, conn, calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ singleEvents: 'true', timeMin, timeMax, maxResults: '2500', showDeleted: 'false' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api(env, conn, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
    out.push(...(page.items || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken && out.length < 10_000);
  return out.filter((e) => e.status !== 'cancelled');
}

export const writable = (cal) => cal && (cal.accessRole === 'owner' || cal.accessRole === 'writer');

/** Google event → Leafdeck event fields. */
// Google's per-event colors (colorId 1–11), as Google Calendar shows them. An event without one uses its calendar's color.
export const EVENT_COLORS = {
  1: '#7986cb', // Lavender
  2: '#33b679', // Sage
  3: '#8e24aa', // Grape
  4: '#e67c73', // Flamingo
  5: '#f6bf26', // Banana
  6: '#f4511e', // Tangerine
  7: '#039be5', // Peacock
  8: '#616161', // Graphite
  9: '#3f51b5', // Blueberry
  10: '#0b8043', // Basil
  11: '#d50000', // Tomato
};
export const eventColor = (ev, cal) => EVENT_COLORS[ev?.colorId] || cal?.color || '';

export function toRecord(ev, cal, tz) {
  const r = {
    title: ev.summary || '(No title)',
    location: ev.location || '',
    notes: ev.description || '',
    url: ev.htmlLink || '',
    color: eventColor(ev, cal),
    gcolor: EVENT_COLORS[ev.colorId] ? String(ev.colorId) : '', // the event's own color in Google ('' = calendar color)
    attendees: (ev.attendees || [])
      .slice(0, 60)
      .filter((a) => a.email || a.displayName)
      .map((a) => ({ name: String(a.displayName || '').slice(0, 120), email: String(a.email || '').toLowerCase().slice(0, 254), status: a.responseStatus || '', self: !!a.self })),
    readOnly: !writable(cal) || !!ev.locked || ev.eventType === 'birthday',
    ext: { calendarId: cal.id, eventId: ev.id, etag: ev.etag, updated: ev.updated, colorId: ev.colorId || '' },
  };
  if (ev.start?.date) {
    r.date = ev.start.date;
    r.time = '';
    r.endTime = '';
    const lastDay = addDaysIso(ev.end?.date || ev.start.date, -1);
    r.endDate = lastDay > r.date ? lastDay : '';
  } else {
    const s = toLocal(new Date(ev.start.dateTime), tz);
    const e = toLocal(new Date(ev.end?.dateTime || ev.start.dateTime), tz);
    r.date = s.date;
    r.time = s.time;
    r.endTime = e.time;
    r.endDate = e.date > s.date ? e.date : '';
  }
  return r;
}

/** Leafdeck event → Google event body. */
export function fromRecord(rec, tz) {
  const body = { summary: rec.title || '(No title)', location: rec.location || '', description: rec.notes || '' };
  // The event's color in Google; null clears it back to the calendar's color.
  body.colorId = EVENT_COLORS[rec.gcolor] ? String(rec.gcolor) : null;
  if (rec.time) {
    const endDate = rec.endDate || rec.date;
    let endTime = rec.endTime;
    if (!endTime || (endDate === rec.date && endTime <= rec.time)) {
      const [h, m] = rec.time.split(':').map(Number);
      endTime = `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(h >= 23 ? 59 : m).padStart(2, '0')}`;
    }
    body.start = { dateTime: `${rec.date}T${rec.time}:00`, timeZone: tz };
    body.end = { dateTime: `${endDate}T${endTime}:00`, timeZone: tz };
  } else {
    body.start = { date: rec.date };
    body.end = { date: addDaysIso(rec.endDate || rec.date, 1) };
  }
  return body;
}

export function createEvent(env, conn, calendarId, body) {
  return api(env, conn, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) });
}
export function updateEvent(env, conn, calendarId, eventId, body) {
  return api(env, conn, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(body) });
}
export async function deleteEvent(env, conn, calendarId, eventId) {
  try {
    await api(env, conn, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err; // already gone is fine
  }
}
