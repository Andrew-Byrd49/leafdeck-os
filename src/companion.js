// Companion devices (the Android app): bearer tokens and pairing, the incremental changes feed,
// shared browsing history, open tabs, send-to-device, and the pruning the cron does.
// The shapes are documented in docs/companion-api.md.
import { randomId, sha256, b64url } from './integrations/util.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const err = (status, message) => Object.assign(new Error(message), { status });

const PAIR_TTL = 10 * 60 * 1000;
const TOMBSTONE_DAYS = 30;
const SEND_DAYS = 7;
const MAX_TABS = 50;
const PAGE = 500;

const tokenHash = async (token) => b64url(await sha256(token));
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const isWebUrl = (u) => /^https?:\/\/[^\s]+$/i.test(u) && u.length <= 2048;
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/* ---------------- Who is calling ---------------- */

/**
 * The device behind a request: `{ id, kind, owner }`.
 * A valid `Authorization: Bearer ldk_…` header is a paired device; anything else is left to the
 * caller's own check (Access / API token) and treated as the owner, pseudo-device 'desktop'.
 * Returns `{ revoked: true }` for a token that was revoked, so the device can tell and pair again.
 */
export async function identifyDevice(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(ldk_[A-Za-z0-9_-]{20,})$/i);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT id, kind, revoked FROM devices WHERE token_hash = ?1').bind(await tokenHash(m[1])).first();
  // A bearer token that matches nothing is treated as revoked — it must never fall through to owner access.
  if (!row || row.revoked) return { revoked: true };
  return { id: row.id, kind: row.kind, owner: false };
}

export const OWNER = { id: 'desktop', kind: 'desktop', owner: true };

/** Remember when a device was last heard from (cheap; fire-and-forget). */
export function touchDevice(env, ctx, device) {
  ctx.waitUntil(env.DB.prepare('UPDATE devices SET last_seen = ?1 WHERE id = ?2').bind(Date.now(), device.id).run().catch(() => {}));
}

/* ---------------- Live updates ---------------- */

/** Tell every connected device that something changed (they then fetch /api/changes). */
export function notify(env, ctx) {
  if (!env.LIVE) return;
  const hub = env.LIVE.get(env.LIVE.idFromName('hub'));
  ctx.waitUntil(hub.fetch('https://live/notify', { method: 'POST' }).catch(() => {}));
}

/* ---------------- Epoch ---------------- */

export async function getEpoch(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'epoch'").first();
  return Number(row?.value) || 1;
}

export const bumpEpoch = (env) =>
  env.DB.prepare("INSERT INTO meta (key, value) VALUES ('epoch', '2') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)");

/* ---------------- Routes ---------------- */

/** Handles /api/changes, /api/history, /api/devices, /api/sends, /api/live. Returns null if the path isn't ours. */
export async function handleCompanion(request, env, ctx, parts, url, device) {
  const [, area, id, action] = parts;
  const method = request.method;

  if (area === 'changes' && method === 'GET') return changes(env, url, device);
  if (area === 'history') return history(request, env, ctx, parts, url, device);
  if (area === 'devices') return devices(request, env, ctx, parts, device);
  if (area === 'sends') return sends(request, env, ctx, id, action, url, device);
  if (area === 'live') return live(request, env);
  return null;
}

/* ---------------- Pairing & claiming ---------------- */

/** POST /api/devices/claim — the phone turns a pairing code into its own bearer token. No auth needed. */
export async function claimDevice(request, env) {
  const b = await readBody(request);
  const code = clean(b.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return fail(400, 'Missing pairing code');
  const now = Date.now();
  const row = await env.DB.prepare('SELECT code, expires_at FROM pairings WHERE code = ?1').bind(code).first();
  if (!row || row.expires_at < now) {
    if (row) await env.DB.prepare('DELETE FROM pairings WHERE code = ?1').bind(code).run();
    return fail(400, 'That pairing code is wrong or has expired — show a new one on the desktop');
  }
  const kind = ['android'].includes(b.kind) ? b.kind : 'android';
  const name = clean(b.name, 60) || 'Phone';
  const deviceId = 'dev_' + randomId(9);
  const token = 'ldk_' + randomId(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pairings WHERE code = ?1').bind(code),
    env.DB.prepare('INSERT INTO devices (id, name, kind, token_hash, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
      .bind(deviceId, name, kind, await tokenHash(token), now),
  ]);
  return json({ token, deviceId, name });
}

async function devices(request, env, ctx, parts, device) {
  const [, , id, sub] = parts;
  const method = request.method;
  const now = Date.now();

  if (!id && method === 'GET') return json(await listDevices(env));

  if (id === 'pair' && method === 'POST') {
    if (!device.owner) return fail(403, 'Only the desktop can pair new devices');
    // Readable code, no ambiguous letters.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    const expiresAt = now + PAIR_TTL;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pairings WHERE expires_at < ?1').bind(now),
      env.DB.prepare('INSERT INTO pairings (code, expires_at) VALUES (?1, ?2)').bind(raw, expiresAt),
    ]);
    return json({ code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt });
  }

  // "me" is the caller; the owner may also address itself as "desktop".
  const target = id === 'me' ? device.id : id;

  if (sub === 'tabs' && method === 'PUT') {
    if (target !== device.id) return fail(403, 'A device can only report its own tabs');
    const b = await readBody(request);
    const tabs = (Array.isArray(b.tabs) ? b.tabs : [])
      .filter((t) => t && isWebUrl(String(t.url)))
      .slice(0, MAX_TABS)
      .map((t) => ({ url: clean(t.url, 2048), title: clean(t.title, 300) }));
    await env.DB.prepare('UPDATE devices SET tabs = ?1, tabs_at = ?2, last_seen = ?2 WHERE id = ?3').bind(JSON.stringify(tabs), now, target).run();
    notify(env, ctx);
    return json({ ok: true });
  }

  if (!sub && method === 'PUT') {
    if (target !== device.id) return fail(403, 'A device can only rename itself');
    const b = await readBody(request);
    const name = clean(b.name, 60);
    if (!name) return fail(400, 'Name is required');
    await env.DB.prepare('UPDATE devices SET name = ?1 WHERE id = ?2').bind(name, target).run();
    notify(env, ctx);
    return json({ ok: true });
  }

  if (!sub && method === 'DELETE') {
    if (!device.owner) return fail(403, 'Only the desktop can remove devices');
    if (target === 'desktop') return fail(400, 'The desktop can’t be removed');
    await env.DB.prepare("UPDATE devices SET revoked = 1, token_hash = NULL, tabs = '[]' WHERE id = ?1").bind(target).run();
    notify(env, ctx);
    return json({ ok: true });
  }

  return fail(405, 'Method not allowed');
}

async function listDevices(env) {
  const { results } = await env.DB.prepare('SELECT id, name, kind, tabs, tabs_at, created_at, last_seen FROM devices WHERE revoked = 0 ORDER BY created_at').all();
  return results.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    createdAt: d.created_at,
    lastSeen: d.last_seen,
    tabs: safeJson(d.tabs, []),
    tabsAt: d.tabs_at,
  }));
}

/* ---------------- Changes feed ---------------- */

async function changes(env, url, device) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = Math.min(PAGE, Math.max(1, Number(url.searchParams.get('limit')) || PAGE));
  const [recs, hist, snds, devs, epoch] = await Promise.all([
    env.DB.prepare('SELECT collection, id, data, deleted, updated_at FROM records WHERE updated_at > ?1 ORDER BY updated_at LIMIT ?2').bind(since, limit).all(),
    env.DB.prepare('SELECT id, url, title, host, visited_at, device_id, deleted, updated_at FROM history WHERE updated_at > ?1 AND device_id != ?3 ORDER BY updated_at LIMIT ?2')
      .bind(since, limit, device.id).all(),
    env.DB.prepare("SELECT id, from_device, to_device, url, title, created_at, opened_at FROM sends WHERE created_at > ?1 AND from_device != ?3 AND (to_device = ?3 OR to_device = 'all') ORDER BY created_at LIMIT ?2")
      .bind(since, limit, device.id).all(),
    listDevices(env),
    getEpoch(env),
  ]);

  // Each source is paged on its own timestamp. A full page is trimmed of its last timestamp so a
  // batch written in one instant is never split across pages; the cursor is the earliest full page's end.
  const pages = [
    page(recs.results, 'updated_at', limit),
    page(hist.results, 'updated_at', limit),
    page(snds.results, 'created_at', limit),
  ];
  const more = pages.some((p) => p.more);
  const ends = pages.filter((p) => p.rows.length).map((p) => p.end);
  const cursor = more ? Math.min(...pages.filter((p) => p.more).map((p) => p.end)) : ends.length ? Math.max(...ends) : since;
  const keep = (p, key) => (more ? p.rows.filter((r) => r[key] <= cursor) : p.rows);

  return json({
    epoch,
    cursor,
    more,
    records: keep(pages[0], 'updated_at').map((r) => ({ collection: r.collection, id: r.id, data: r.deleted ? null : safeJson(r.data, null), updatedAt: r.updated_at })),
    history: keep(pages[1], 'updated_at').map(publicVisit),
    sends: keep(pages[2], 'created_at').map(publicSend),
    devices: devs,
  });
}

function page(rows, key, limit) {
  if (rows.length < limit) return { rows, end: rows.length ? rows[rows.length - 1][key] : 0, more: false };
  const last = rows[rows.length - 1][key];
  const trimmed = rows.filter((r) => r[key] < last);
  // Everything on the page shares one timestamp: send it whole rather than loop forever.
  if (!trimmed.length) return { rows, end: last, more: true };
  return { rows: trimmed, end: trimmed[trimmed.length - 1][key], more: true };
}

const publicVisit = (r) => ({ id: r.id, url: r.url, title: r.title, host: r.host, visitedAt: r.visited_at, deviceId: r.device_id, deviceName: r.device_name, deleted: r.deleted, updatedAt: r.updated_at });
const publicSend = (s) => ({ id: s.id, from: s.from_device, to: s.to_device, url: s.url, title: s.title, createdAt: s.created_at, openedAt: s.opened_at });

/* ---------------- History ---------------- */

const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const words = (q) => String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
const wordClauses = (ws) => ws.map(() => "(h.url LIKE ? ESCAPE '\\' OR h.title LIKE ? ESCAPE '\\')");
const wordArgs = (ws) => ws.flatMap((w) => [like(w), like(w)]);

async function history(request, env, ctx, parts, url, device) {
  const [, , id] = parts;
  const method = request.method;
  const now = Date.now();

  if (!id && method === 'GET') {
    const q = words(url.searchParams.get('q'));
    const before = Number(url.searchParams.get('before')) || now + 1;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 300));
    const where = ['h.deleted = 0', 'h.visited_at < ?', ...wordClauses(q)].join(' AND ');
    const { results } = await env.DB.prepare(
      `SELECT h.id, h.url, h.title, h.host, h.visited_at, h.device_id, h.deleted, h.updated_at, d.name AS device_name
       FROM history h LEFT JOIN devices d ON d.id = h.device_id WHERE ${where} ORDER BY h.visited_at DESC LIMIT ?`,
    ).bind(before, ...wordArgs(q), limit).all();
    return json(results.map(publicVisit));
  }

  if (id === 'search' && method === 'GET') {
    const q = words(url.searchParams.get('q'));
    if (!q.length) return json([]);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 8));
    const where = ['h.deleted = 0', ...wordClauses(q)].join(' AND ');
    const { results } = await env.DB.prepare(
      `SELECT h.url, h.title, h.host, MAX(h.visited_at) AS visitedAt, COUNT(*) AS visits FROM history h WHERE ${where} GROUP BY h.url ORDER BY visitedAt DESC LIMIT ?`,
    ).bind(...wordArgs(q), limit).all();
    return json(results);
  }

  if (id === '_bulk' && method === 'POST') {
    const rows = await readBody(request);
    if (!Array.isArray(rows)) return fail(400, 'Expected an array');
    const statements = [];
    for (const r of rows.slice(0, 1000)) {
      if (!r || !/^[A-Za-z0-9_-]{8,64}$/.test(String(r.id)) || !isWebUrl(String(r.url))) continue;
      const u = clean(r.url, 2048);
      statements.push(
        env.DB.prepare(
          `INSERT INTO history (id, url, title, host, visited_at, device_id, deleted, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
           ON CONFLICT (id) DO UPDATE SET title = CASE WHEN excluded.title = '' THEN history.title ELSE excluded.title END,
             visited_at = MAX(history.visited_at, excluded.visited_at), updated_at = excluded.updated_at`,
        ).bind(r.id, u, clean(r.title, 500), clean(r.host, 253) || hostOf(u), Number(r.visitedAt) || now, device.id, now),
      );
    }
    for (let i = 0; i < statements.length; i += 90) await env.DB.batch(statements.slice(i, i + 90));
    if (statements.length) notify(env, ctx);
    return json({ ok: true, count: statements.length });
  }

  if (id === '_clear' && method === 'POST') {
    const b = await readBody(request);
    const since = Math.max(0, Number(b.since) || 0);
    const r = await env.DB.prepare("UPDATE history SET deleted = 1, title = '', updated_at = ?1 WHERE deleted = 0 AND visited_at >= ?2").bind(now, since).run();
    notify(env, ctx);
    return json({ ok: true, count: r.meta?.changes || 0 });
  }

  if (id && method === 'DELETE') {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return fail(400, 'Invalid id');
    await env.DB.prepare("UPDATE history SET deleted = 1, title = '', updated_at = ?1 WHERE id = ?2").bind(now, id).run();
    notify(env, ctx);
    return json({ ok: true });
  }

  return fail(405, 'Method not allowed');
}

/* ---------------- Send to device ---------------- */

async function sends(request, env, ctx, id, action, url, device) {
  const method = request.method;
  const now = Date.now();

  if (!id && method === 'POST') {
    const b = await readBody(request);
    const u = clean(b.url, 2048);
    if (!isWebUrl(u)) return fail(400, 'A web address is required');
    const to = clean(b.to, 40) || 'all';
    if (to !== 'all') {
      const target = await env.DB.prepare('SELECT id FROM devices WHERE id = ?1 AND revoked = 0').bind(to).first();
      if (!target) return fail(404, 'Unknown device');
    }
    const sendId = 's_' + randomId(9);
    await env.DB.prepare('INSERT INTO sends (id, from_device, to_device, url, title, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(sendId, device.id, to, u, clean(b.title, 300), now).run();
    notify(env, ctx);
    return json({ ok: true, id: sendId });
  }

  if (!id && method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const { results } = await env.DB.prepare(
      "SELECT id, from_device, to_device, url, title, created_at, opened_at FROM sends WHERE created_at > ?1 AND from_device != ?2 AND (to_device = ?2 OR to_device = 'all') AND opened_at IS NULL ORDER BY created_at DESC LIMIT 100",
    ).bind(since, device.id).all();
    return json(results.map(publicSend));
  }

  if (id && action === 'opened' && method === 'POST') {
    await env.DB.prepare('UPDATE sends SET opened_at = ?1 WHERE id = ?2 AND opened_at IS NULL').bind(now, id).run();
    return json({ ok: true });
  }

  return fail(405, 'Method not allowed');
}

/* ---------------- Live (WebSocket hub) ---------------- */

function live(request, env) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'Expected a WebSocket');
  if (!env.LIVE) return fail(404, 'Live updates aren’t set up on this server');
  return env.LIVE.get(env.LIVE.idFromName('hub')).fetch(request);
}

/* ---------------- Cron: pruning ---------------- */

/** Hard-delete old tombstones, old sends, expired pairings and history past its retention. */
export async function pruneCompanion(env) {
  const now = Date.now();
  const prefsRow = await env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'prefs' AND deleted = 0").first();
  const prefs = safeJson(prefsRow?.data, {});
  const days = prefs.historyRetentionDays === undefined ? 365 : Math.max(0, Number(prefs.historyRetentionDays) || 0);
  const statements = [
    env.DB.prepare('DELETE FROM records WHERE deleted = 1 AND updated_at < ?1').bind(now - TOMBSTONE_DAYS * 86400e3),
    env.DB.prepare('DELETE FROM history WHERE deleted = 1 AND updated_at < ?1').bind(now - TOMBSTONE_DAYS * 86400e3),
    env.DB.prepare('DELETE FROM sends WHERE created_at < ?1').bind(now - SEND_DAYS * 86400e3),
    env.DB.prepare('DELETE FROM pairings WHERE expires_at < ?1').bind(now),
  ];
  if (days > 0) statements.push(env.DB.prepare('DELETE FROM history WHERE visited_at < ?1').bind(now - days * 86400e3));
  await env.DB.batch(statements);
}

/* ---------------- Helpers ---------------- */

async function readBody(request) {
  const text = await request.text();
  if (text.length > 1_000_000) throw err(413, 'Body too large');
  return text ? JSON.parse(text) : {};
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
