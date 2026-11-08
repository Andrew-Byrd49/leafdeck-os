// Leafdeck — Cloudflare Worker
// Serves the static desktop UI from ./public and a small JSON document API backed by D1.
//
//   GET    /api/data              -> { collections: { [name]: Record[] } }
//   GET    /api/:collection       -> Record[]
//   PUT    /api/:collection/:id   -> upsert one record (body = record JSON)
//   POST   /api/:collection/_bulk -> upsert many records (body = Record[])
//   DELETE /api/:collection/:id   -> delete one record
//   POST   /api/import            -> replace everything (body = { collections })
//   /api/integrations/*, /oauth/*  -> connected calendars (see integrations/routes.js)
//   /api/changes, /api/history, /api/devices, /api/sends, /api/live -> companion devices (see docs/companion-api.md)

import { handleIntegrations, handleOAuthCallback, scheduledSync } from './integrations/routes.js';
import { beforeSaveEvent, beforeDeleteEvent } from './integrations/sync.js';
import { identifyDevice, OWNER, touchDevice, notify, getEpoch, bumpEpoch, handleCompanion, claimDevice, pruneCompanion } from './companion.js';
export { Live } from './live.js';

const COLLECTION = /^[a-z][a-z0-9_]{0,31}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 1_000_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const fail = (status, error) => json({ error }, status);

function authorized(request, env) {
  if (!env.API_TOKEN) return true;
  return request.headers.get('x-api-token') === env.API_TOKEN;
}

async function readJson(request, max = MAX_BODY) {
  const text = await request.text();
  if (text.length > max) throw Object.assign(new Error('Body too large'), { status: 413 });
  return JSON.parse(text);
}

function upsert(env, collection, record, now) {
  return env.DB.prepare(
    `INSERT INTO records (collection, id, data, created_at, updated_at, deleted)
     VALUES (?1, ?2, ?3, ?4, ?4, 0)
     ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0`,
  ).bind(collection, record.id, JSON.stringify(record), now);
}

// Deleted rows stay as tombstones so other devices learn about the deletion (pruned after 30 days).
const tombstone = (env, collection, id, now) =>
  env.DB.prepare("UPDATE records SET deleted = 1, data = '{}', updated_at = ?3 WHERE collection = ?1 AND id = ?2 AND deleted = 0").bind(collection, id, now);

async function handleApi(request, env, ctx, parts, url) {
  const [, collection, id] = parts;
  const method = request.method;

  // A phone turning its pairing code into a token has no credentials yet.
  if (collection === 'devices' && id === 'claim' && method === 'POST') return claimDevice(request, env);

  // Who's calling: a paired device (bearer token) or the owner (Access / API token).
  let device = await identifyDevice(request, env);
  if (device?.revoked) return fail(401, 'Device revoked');
  if (!device) {
    if (!authorized(request, env)) return fail(401, 'Unauthorized');
    device = OWNER;
  } else touchDevice(env, ctx, device);

  if (['changes', 'history', 'devices', 'sends', 'live'].includes(collection)) {
    return (await handleCompanion(request, env, ctx, parts, url, device)) || fail(404, 'Not found');
  }

  // Note media (images, voice memos): POST raw bytes with their content type → { id }; GET /api/media/:id.
  if (collection === 'media') {
    if (!env.MEDIA) return fail(404, 'Media storage isn’t set up on this server — deploy the Worker with its MEDIA bucket');
    if (method === 'POST' && !id) {
      const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^(image\/(png|jpeg|webp|gif)|audio\/(webm|ogg|mp4|mpeg|wav))$/.test(type)) return fail(415, 'Only images and audio can be stored');
      if (Number(request.headers.get('content-length') || 0) > 25_000_000) return fail(413, 'Too large (25 MB max)');
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return fail(400, 'Empty file');
      if (buf.byteLength > 25_000_000) return fail(413, 'Too large (25 MB max)');
      const key = crypto.randomUUID();
      await env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
      return json({ id: key, type, size: buf.byteLength });
    }
    if ((method === 'GET' || method === 'HEAD') && id) {
      if (!/^[0-9a-f-]{36}$/.test(id)) return fail(404, 'Not found');
      const obj = await env.MEDIA.get(id);
      if (!obj) return fail(404, 'Not found');
      const headers = new Headers({ 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      obj.writeHttpMetadata(headers);
      headers.set('content-length', String(obj.size));
      return new Response(method === 'HEAD' ? null : obj.body, { headers });
    }
    return fail(405, 'Method not allowed');
  }

  // App updates (Leafdeck checks here): /api/updates/latest.yml and the installer it points to, from R2.
  if (collection === 'updates') {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'Method not allowed');
    if (!env.UPDATES) return fail(404, 'Updates are not set up on this server');
    const key = parts.slice(2).map(decodeURIComponent).join('/');
    if (!/^[\w.\- ]+$/.test(key)) return fail(404, 'Not found');
    const ranged = request.headers.has('range');
    const obj = await env.UPDATES.get(key, ranged ? { range: request.headers } : {});
    if (!obj) return fail(404, 'Not found');
    const headers = new Headers({ 'cache-control': 'no-store', 'accept-ranges': 'bytes' });
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    if (ranged && obj.range) {
      const r = obj.range;
      const offset = 'suffix' in r ? obj.size - r.suffix : r.offset || 0;
      const length = 'suffix' in r ? r.suffix : r.length ?? obj.size - offset;
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      headers.set('content-length', String(length));
      return new Response(method === 'HEAD' ? null : obj.body, { status: 206, headers });
    }
    headers.set('content-length', String(obj.size));
    return new Response(method === 'HEAD' ? null : obj.body, { headers });
  }

  if (collection === 'integrations') {
    if (!device.owner) return fail(403, 'Connected accounts are managed from the desktop');
    // Connection problems (bad link, provider errors) are shown to the user as-is.
    return handleIntegrations(request, env, ctx, parts, url).catch((err) =>
      err instanceof SyntaxError ? fail(400, 'Invalid JSON') : fail(err.status && err.status < 500 ? err.status : 400, err.message),
    );
  }

  if (collection === 'data' && method === 'GET') {
    const cursor = Date.now(); // taken before the read, so a write landing during it still shows up in /changes
    const [{ results }, epoch] = await Promise.all([env.DB.prepare('SELECT collection, data FROM records WHERE deleted = 0').all(), getEpoch(env)]);
    const collections = {};
    for (const row of results) (collections[row.collection] ||= []).push(JSON.parse(row.data));
    return json({ collections, epoch, cursor, local: !!env.LOCAL });
  }

  if (collection === 'import' && method === 'POST') {
    // On this computer (the app's local data) a full backup may be larger than a Worker request should be.
    const body = await readJson(request, env.LOCAL ? 200_000_000 : MAX_BODY);
    const now = Date.now();
    const statements = [env.DB.prepare('DELETE FROM records'), bumpEpoch(env)];
    for (const [name, rows] of Object.entries(body.collections || {})) {
      if (!COLLECTION.test(name) || !Array.isArray(rows)) continue;
      for (const row of rows) if (row && ID.test(row.id)) statements.push(upsert(env, name, row, now));
    }
    // D1 batches run as a single transaction; chunk to stay well under statement limits.
    for (let i = 0; i < statements.length; i += 90) await env.DB.batch(statements.slice(i, i + 90));
    notify(env, ctx);
    return json({ ok: true, count: statements.length - 2 });
  }

  if (!collection || !COLLECTION.test(collection)) return fail(404, 'Unknown collection');

  if (!id) {
    if (method !== 'GET') return fail(405, 'Method not allowed');
    const { results } = await env.DB.prepare('SELECT data FROM records WHERE collection = ?1 AND deleted = 0')
      .bind(collection)
      .all();
    return json(results.map((r) => JSON.parse(r.data)));
  }

  if (id === '_bulk' && method === 'POST') {
    const rows = await readJson(request);
    if (!Array.isArray(rows)) return fail(400, 'Expected an array');
    const now = Date.now();
    const statements = rows.filter((r) => r && typeof r === 'object' && ID.test(r.id)).map((r) => upsert(env, collection, r, now));
    for (let i = 0; i < statements.length; i += 90) await env.DB.batch(statements.slice(i, i + 90));
    notify(env, ctx);
    return json({ ok: true, count: statements.length });
  }

  if (!ID.test(id)) return fail(400, 'Invalid id');

  if (method === 'PUT') {
    let record = await readJson(request);
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return fail(400, 'Expected an object');
    record.id = id;
    let warning;
    // A device that edited offline says which version it started from; refuse if the row moved on since.
    const ifMatch = request.headers.get('if-match');
    if (ifMatch) {
      const row = await env.DB.prepare('SELECT data, updated_at, deleted FROM records WHERE collection = ?1 AND id = ?2').bind(collection, id).first();
      if (row && String(row.updated_at) !== ifMatch.replace(/"/g, '')) {
        return json({ error: 'Changed on another device', record: row.deleted ? null : JSON.parse(row.data), updatedAt: row.updated_at }, 409);
      }
    }
    // Events may live on a connected calendar: push the change there and return the stored record.
    if (collection === 'events') {
      const prev = await existing(env, collection, id);
      ({ record, warning } = await beforeSaveEvent(env, record, prev));
    }
    const now = Date.now();
    await upsert(env, collection, record, now).run();
    notify(env, ctx);
    return json({ ok: true, record, updatedAt: now, warning });
  }

  if (method === 'DELETE') {
    let warning;
    if (collection === 'events') {
      const r = await beforeDeleteEvent(env, await existing(env, collection, id));
      if (r.blocked) return json({ ok: false, error: r.blocked, record: await existing(env, collection, id) }, 409);
      warning = r.warning;
    }
    await tombstone(env, collection, id, Date.now()).run();
    notify(env, ctx);
    return json({ ok: true, warning });
  }

  return fail(405, 'Method not allowed');
}

async function existing(env, collection, id) {
  const row = await env.DB.prepare('SELECT data FROM records WHERE collection = ?1 AND id = ?2 AND deleted = 0').bind(collection, id).first();
  return row ? JSON.parse(row.data) : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'oauth') return handleOAuthCallback(request, env, ctx, url);
    if (parts[0] !== 'api') return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx, parts, url);
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'Invalid JSON');
      console.error(err);
      return fail(err.status || 500, err.status ? err.message : 'Internal error');
    }
  },

  // Cron trigger: keep connected calendars in sync; prune old tombstones, sends and history.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledSync(env));
    ctx.waitUntil(pruneCompanion(env).catch((e) => console.error('prune', e)));
  },
};
