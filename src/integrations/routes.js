// HTTP routes for connected accounts.
//   GET    /api/integrations                 → { googleConfigured, redirectUri, connections }
//   POST   /api/integrations/google/start    → { url } (Google consent screen)
//   POST   /api/integrations/ics             → subscribe to a calendar link
//   POST   /api/integrations/sync            → sync one ({ id }) or all connections
//   GET    /api/integrations/:id/mail        → recent Gmail inbox messages (Google accounts)
//   GET    /api/integrations/:id/mail/:messageId/invite → { invite } the message's calendar invite, or null
//   PATCH  /api/integrations/:id             → rename / recolor / choose calendars
//   DELETE /api/integrations/:id             → disconnect (events removed from Leafdeck, kept at the provider)
//   GET    /oauth/google/callback            → Google redirects here after consent
import * as google from './google.js';
import { fetchIcs, parseIcs } from './ics.js';
import { publicConnection, getConnection, syncConnection, syncAll, removeLinkedEvents } from './sync.js';
import { randomId, validTz } from './util.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

async function body(request) {
  const text = await request.text();
  if (text.length > 100_000) throw Object.assign(new Error('Body too large'), { status: 413 });
  return text ? JSON.parse(text) : {};
}

export async function handleIntegrations(request, env, ctx, parts, url) {
  const method = request.method;
  const [, , sub, action] = parts;

  if (!sub && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM connections ORDER BY created_at').all();
    return json({
      googleConfigured: google.configured(env),
      tokenKeyConfigured: !!env.TOKEN_KEY,
      redirectUri: google.redirectUri(url.origin),
      connections: results.map(publicConnection),
    });
  }

  if (sub === 'google' && action === 'start' && method === 'POST') {
    const b = await body(request);
    if (!env.TOKEN_KEY) return fail(400, 'Set the TOKEN_KEY secret on the Worker first.');
    return json({ url: await google.startAuth(env, url.origin, { timeZone: validTz(b.timeZone) }) });
  }

  if (sub === 'ics' && method === 'POST') {
    const b = await body(request);
    const { url: icsUrl, text } = await fetchIcs(b.url);
    const parsed = parseIcs(text);
    const id = 'c' + randomId(9);
    const cfg = { url: icsUrl, calendarName: String(b.name || '').trim() || parsed.name || new URL(icsUrl).host, color: String(b.color || parsed.color || '').slice(0, 9), timeZone: validTz(b.timeZone) };
    await env.DB.prepare("INSERT INTO connections (id, provider, name, config, status, created_at) VALUES (?1, 'ics', ?2, ?3, 'ok', ?4)")
      .bind(id, cfg.calendarName, JSON.stringify(cfg), Date.now())
      .run();
    const row = await getConnection(env, id);
    const result = await syncConnection(env, row);
    return json({ connection: publicConnection(await getConnection(env, id)), result });
  }

  if (sub === 'sync' && method === 'POST') {
    const b = await body(request);
    const rows = b.id ? [await getConnection(env, b.id)].filter(Boolean) : (await env.DB.prepare('SELECT * FROM connections').all()).results;
    const results = {};
    for (const row of rows) {
      if (b.timeZone) {
        const cfg = JSON.parse(row.config || '{}');
        cfg.timeZone = validTz(b.timeZone);
        row.config = JSON.stringify(cfg);
        await env.DB.prepare('UPDATE connections SET config = ?1 WHERE id = ?2').bind(row.config, row.id).run();
      }
      try {
        results[row.id] = await syncConnection(env, row);
      } catch (err) {
        results[row.id] = { error: err.message };
      }
    }
    return json({ results });
  }

  // Recent inbox for the Gmail widget: ?max=12&unread=1
  // One message's calendar invite (for dating tasks made from it): /mail/:messageId/invite
  if (sub && action === 'mail' && method === 'GET') {
    const row = await getConnection(env, sub);
    if (!row || row.provider !== 'google') return fail(404, 'Not found');
    if (row.status === 'needs_reauth') return fail(409, row.error || 'Reconnect this Google account.');
    const [messageId, what] = parts.slice(4);
    try {
      if (messageId && what === 'invite') return json(await google.mailInvite(env, row, messageId));
      if (messageId) return fail(404, 'Not found');
      return json(await google.listMail(env, row, { max: Number(url.searchParams.get('max')) || 12, unreadOnly: url.searchParams.get('unread') === '1' }));
    } catch (err) {
      if (err.code === 'scope') return json({ error: 'Reconnect this Google account to allow Gmail access.', needsScope: true }, 403);
      if (err instanceof google.ReauthError) {
        await env.DB.prepare("UPDATE connections SET status = 'needs_reauth', error = ?1 WHERE id = ?2").bind(err.message, row.id).run();
        return fail(409, err.message);
      }
      throw err;
    }
  }

  if (sub && !action && method === 'PATCH') {
    const row = await getConnection(env, sub);
    if (!row) return fail(404, 'Not found');
    const b = await body(request);
    const cfg = JSON.parse(row.config || '{}');
    let name = row.name;
    if (typeof b.name === 'string' && b.name.trim()) {
      if (row.provider === 'ics') cfg.calendarName = b.name.trim().slice(0, 80);
      else name = b.name.trim().slice(0, 80);
    }
    if (typeof b.color === 'string') cfg.color = b.color.slice(0, 9);
    const dropped = [];
    if (Array.isArray(b.calendars) && row.provider === 'google') {
      const chosen = new Map(b.calendars.map((c) => [c.id, !!c.selected]));
      cfg.calendars = (cfg.calendars || []).map((c) => {
        const selected = chosen.has(c.id) ? chosen.get(c.id) : c.selected;
        if (c.selected && !selected) dropped.push(c.id);
        return { ...c, selected };
      });
    }
    await env.DB.prepare('UPDATE connections SET name = ?1, config = ?2 WHERE id = ?3').bind(name, JSON.stringify(cfg), row.id).run();
    // Calendars you stop showing are removed from Leafdeck (they stay in Google).
    for (const calId of dropped) await removeLinkedEvents(env, row.id, calId);
    return json({ connection: publicConnection(await getConnection(env, row.id)) });
  }

  if (sub && !action && method === 'DELETE') {
    const row = await getConnection(env, sub);
    if (!row) return fail(404, 'Not found');
    const removed = await removeLinkedEvents(env, row.id);
    await env.DB.prepare('DELETE FROM connections WHERE id = ?1').bind(row.id).run();
    // Note: Google access stays granted until revoked at myaccount.google.com → Security → Third-party access.
    return json({ ok: true, removed });
  }

  return fail(404, 'Unknown integrations route');
}

const page = (title, message, ok) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b120e;color:#f2f2f5;font:15px/1.5 system-ui,sans-serif}
  .c{max-width:420px;padding:28px;border-radius:16px;background:#1c1e21;border:1px solid #333;text-align:center}
  h1{font-size:20px;margin:0 0 8px;color:${ok ? '#34c77b' : '#ff6961'}}p{margin:0;color:#aaa}</style></head>
  <body><div class="c"><h1>${title}</h1><p>${message}</p></div><script>${ok ? 'setTimeout(()=>window.close(),1500)' : ''}</script></body></html>`,
  { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function handleOAuthCallback(request, env, ctx, url) {
  if (url.pathname !== '/oauth/google/callback') return new Response('Not found', { status: 404 });
  try {
    const conn = await google.finishAuth(env, url.origin, url);
    // Pull events right away in the background.
    ctx.waitUntil(getConnection(env, conn.id).then((row) => row && syncConnection(env, row)).catch(() => {}));
    return page('Google Calendar connected', `${escapeHtml(conn.name)} is now connected to Leafdeck. You can close this tab.`, true);
  } catch (err) {
    return page('Couldn’t connect', escapeHtml(err.message), false);
  }
}

export const scheduledSync = (env) => syncAll(env);
