// Calendar subscriptions by link (.ics / webcal): fetch, parse (RFC 5545), expand recurrences into a window.
import { wallToInstant, toLocal, validTz, addDaysIso } from './util.js';

const MAX_BYTES = 10 * 1024 * 1024;
const DAY = 86_400_000;

// Outlook/Exchange feeds use Windows zone names.
const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  UTC: 'UTC',
};
const zone = (tzid, fallback) => {
  if (!tzid) return fallback;
  const name = WINDOWS_TZ[tzid] || tzid.replace(/^\/.*?\//, ''); // some feeds prefix "/mozilla.org/…/"
  const v = validTz(name);
  return v === 'UTC' && name !== 'UTC' ? fallback : v;
};

/* ---------- Fetch ---------- */

export async function fetchIcs(rawUrl) {
  const url = String(rawUrl || '').trim().replace(/^webcals?:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a calendar link starting with https:// or webcal://');
  const res = await fetch(url, { headers: { accept: 'text/calendar, */*' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`The calendar link returned ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('That calendar is too large to sync (over 10 MB).');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link didn’t return a calendar (.ics) file.');
  return { url, text };
}

/* ---------- Parse ---------- */

function parseLine(line) {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {};
  for (const p of ps) {
    const k = p.indexOf('=');
    if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDate(l) {
  const v = String(l.value || '').trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  return {
    y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
    isDate: l.params?.VALUE === 'DATE' || !m[4],
    utc: !!m[7],
    tzid: l.params?.TZID || '',
  };
}

export function parseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  const stack = [];
  let cur = null;
  let name = '';
  let color = '';
  let method = '';
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const l = parseLine(raw);
    if (l.name === 'BEGIN') {
      stack.push(l.value.toUpperCase());
      if (l.value.toUpperCase() === 'VEVENT') cur = { exdates: [] };
      continue;
    }
    if (l.name === 'END') {
      if (stack.pop() === 'VEVENT' && cur) {
        if (cur.start) events.push(cur);
        cur = null;
      }
      continue;
    }
    const where = stack[stack.length - 1];
    if (where === 'VCALENDAR') {
      if (l.name === 'X-WR-CALNAME') name = unescapeText(l.value);
      if (l.name === 'X-APPLE-CALENDAR-COLOR') color = l.value.slice(0, 7);
      if (l.name === 'METHOD') method = l.value.toUpperCase(); // REQUEST / CANCEL / REPLY in emailed invites
      continue;
    }
    if (where !== 'VEVENT' || !cur) continue; // skip alarms, time-zone definitions, etc.
    switch (l.name) {
      case 'UID': cur.uid = l.value; break;
      case 'SUMMARY': cur.summary = unescapeText(l.value); break;
      case 'LOCATION': cur.location = unescapeText(l.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(l.value); break;
      case 'URL': cur.url = l.value; break;
      case 'STATUS': cur.status = l.value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseDate(l); break;
      case 'DTEND': cur.end = parseDate(l); break;
      case 'DURATION': cur.duration = l.value; break;
      case 'RRULE': cur.rrule = Object.fromEntries(l.value.split(';').map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v])); break;
      case 'EXDATE': for (const v of l.value.split(',')) cur.exdates.push(parseDate({ params: l.params, value: v })); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(l); break;
      case 'LAST-MODIFIED': cur.updated = l.value; break;
      case 'DTSTAMP': cur.updated ||= l.value; break;
    }
  }
  return { name, color, method, events };
}

/** When a single parsed event starts: { date } for all-day events, else { at } (epoch ms; floating times read in `tz`). */
export function eventStart(ev, tz = 'UTC') {
  const s = ev?.start;
  if (!s) return null;
  if (s.isDate) return { date: isoOf(s.y, s.m, s.d) };
  return { at: instant(s, tz).getTime() };
}

/* ---------- Expand into concrete occurrences ---------- */

function durationMs(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * 3600e3 + (+m[5] || 0) * 60e3 + (+m[6] || 0) * 1e3);
}

const instant = (dt, tz) => (dt.utc ? new Date(Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s)) : wallToInstant(dt.y, dt.m, dt.d, dt.h, dt.mi, dt.s, zone(dt.tzid, tz)));
const isoOf = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Wall-clock dates (y, m, d) of every occurrence, in order, until `endMs` or the rule's COUNT/UNTIL. */
function* occurrenceDates(ev, rule, endMs, untilMs) {
  const interval = Math.max(1, +rule.INTERVAL || 1);
  const freq = rule.FREQ;
  const s = ev.start;
  const days = (rule.BYDAY || '').split(',').filter(Boolean);
  const monthDays = (rule.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const months = (rule.BYMONTH || '').split(',').filter(Boolean).map(Number);
  const base = Date.UTC(s.y, s.m - 1, s.d);
  const limit = Math.min(endMs, untilMs ?? Infinity) + DAY;
  const at = (ms) => {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), ms };
  };

  for (let i = 0, guard = 0; guard < 5000; i++, guard++) {
    let candidates = [];
    if (freq === 'DAILY') candidates = [base + i * interval * DAY];
    else if (freq === 'WEEKLY') {
      // Week starts Monday; with BYDAY, every listed weekday in each interval-th week.
      const startDow = new Date(base).getUTCDay();
      const weekStart = base - ((startDow + 6) % 7) * DAY + i * interval * 7 * DAY;
      const wanted = days.length ? days.map((x) => DOW[x.slice(-2)]) : [startDow];
      candidates = wanted.map((dw) => weekStart + ((dw + 6) % 7) * DAY).sort((a, b) => a - b);
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const y0 = new Date(base).getUTCFullYear();
      const m0 = new Date(base).getUTCMonth();
      const monthList =
        freq === 'MONTHLY' ? [m0 + i * interval] : (months.length ? months.map((m) => m - 1) : [m0]).map((m) => m + 12 * i * interval);
      for (const mIdx of monthList) {
        const y = y0 + Math.floor(mIdx / 12);
        const mo = ((mIdx % 12) + 12) % 12;
        const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        if (monthDays.length) {
          for (const md of monthDays) {
            const dd = md > 0 ? md : daysInMonth + md + 1;
            if (dd >= 1 && dd <= daysInMonth) candidates.push(Date.UTC(y, mo, dd));
          }
        } else if (days.length) {
          // e.g. 2TU = second Tuesday, -1FR = last Friday
          for (const spec of days) {
            const n = parseInt(spec, 10) || 0;
            const dw = DOW[spec.slice(-2)];
            const matches = [];
            for (let dd = 1; dd <= daysInMonth; dd++) if (new Date(Date.UTC(y, mo, dd)).getUTCDay() === dw) matches.push(dd);
            const pick = n > 0 ? [matches[n - 1]] : n < 0 ? [matches[matches.length + n]] : matches;
            for (const dd of pick) if (dd) candidates.push(Date.UTC(y, mo, dd));
          }
        } else if (s.d <= daysInMonth) candidates.push(Date.UTC(y, mo, s.d));
      }
      candidates.sort((a, b) => a - b);
    } else {
      yield at(base);
      return;
    }
    for (const c of candidates) {
      if (c < base) continue;
      if (c > limit) return;
      yield at(c);
    }
  }
}

/**
 * Concrete occurrences between `from` and `to` (Date), converted to `tz` (the user's zone).
 * Returns Leafdeck event fields with a stable ext.eventId per occurrence.
 */
export function expand(parsed, from, to, tz) {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const overrides = new Map(); // "uid|instant" → override event
  for (const ev of parsed.events) if (ev.recurrenceId) overrides.set(`${ev.uid}|${instant(ev.recurrenceId, tz).getTime()}`, ev);
  const out = [];

  const emit = (ev, startMs, lenMs, allDay, occurrenceKey) => {
    if (ev.status === 'CANCELLED') return;
    const endMs = startMs + lenMs;
    if (endMs < fromMs || startMs > toMs) return;
    const rec = {
      title: ev.summary || '(No title)',
      location: ev.location || '',
      notes: ev.description || '',
      url: ev.url || '',
      readOnly: true,
      ext: { eventId: occurrenceKey, updated: ev.updated || '' },
    };
    if (allDay) {
      const d = new Date(startMs);
      rec.date = isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      rec.time = '';
      rec.endTime = '';
      const days = Math.max(1, Math.round(lenMs / DAY));
      rec.endDate = days > 1 ? addDaysIso(rec.date, days - 1) : '';
    } else {
      const s = toLocal(new Date(startMs), tz);
      const e = toLocal(new Date(endMs), tz);
      rec.date = s.date;
      rec.time = s.time;
      rec.endTime = e.time;
      rec.endDate = e.date > s.date ? e.date : '';
    }
    out.push(rec);
  };

  for (const ev of parsed.events) {
    if (ev.recurrenceId) continue; // handled as overrides of their series
    const allDay = ev.start.isDate;
    const evTz = ev.start.utc ? 'UTC' : zone(ev.start.tzid, tz);
    const startMs = allDay ? Date.UTC(ev.start.y, ev.start.m - 1, ev.start.d) : instant(ev.start, tz).getTime();
    let lenMs = ev.end ? (allDay ? Date.UTC(ev.end.y, ev.end.m - 1, ev.end.d) : instant(ev.end, tz).getTime()) - startMs : durationMs(ev.duration);
    if (!(lenMs > 0)) lenMs = allDay ? DAY : 0;
    const uid = ev.uid || `${ev.summary}|${startMs}`;

    if (!ev.rrule) {
      emit(ev, startMs, lenMs, allDay, `${uid}|${startMs}`);
      continue;
    }
    const until = ev.rrule.UNTIL ? parseDate({ value: ev.rrule.UNTIL }) : null;
    // UNTIL is a date (inclusive) or a time — UTC when it ends in "Z", otherwise the event's own zone.
    const untilMs = !until ? null : until.isDate ? Date.UTC(until.y, until.m - 1, until.d) + DAY - 1 : instant({ ...until, tzid: until.utc ? '' : ev.start.tzid }, tz).getTime();
    const count = +ev.rrule.COUNT || Infinity;
    const excluded = new Set(ev.exdates.filter(Boolean).map((x) => (allDay || x.isDate ? Date.UTC(x.y, x.m - 1, x.d) : instant(x, tz).getTime())));
    let n = 0;
    for (const day of occurrenceDates(ev, ev.rrule, toMs, untilMs)) {
      if (n >= count) break;
      const occMs = allDay ? day.ms : wallToInstant(day.y, day.m, day.d, ev.start.h, ev.start.mi, ev.start.s, evTz).getTime();
      if (untilMs != null && occMs > untilMs) break;
      n++;
      const dayKey = allDay ? day.ms : occMs;
      if (excluded.has(dayKey) || (!allDay && excluded.has(Date.UTC(day.y, day.m - 1, day.d)))) continue;
      const override = overrides.get(`${uid}|${occMs}`);
      if (override) {
        const oStart = override.start.isDate ? Date.UTC(override.start.y, override.start.m - 1, override.start.d) : instant(override.start, tz).getTime();
        const oLen = override.end ? (override.start.isDate ? Date.UTC(override.end.y, override.end.m - 1, override.end.d) : instant(override.end, tz).getTime()) - oStart : lenMs;
        emit({ ...ev, ...override }, oStart, oLen, override.start.isDate, `${uid}|${occMs}`);
      } else emit(ev, occMs, lenMs, allDay, `${uid}|${occMs}`);
    }
  }
  return out;
}
