// Connected accounts (client side): talks to the Worker's /api/integrations routes.

import { store } from './store.js';
import { shell } from './shell.js';
import { toast } from './wm.js';

export const integrations = {
  loaded: false,
  googleConfigured: false,
  tokenKeyConfigured: false,
  redirectUri: '',
  connections: [],
};

const listeners = new Set();
export const onIntegrations = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn(integrations));

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const available = () => store.mode === 'cloud';
const post = (path, body) => store.api(path, { method: 'POST', body: JSON.stringify(body || {}) });

export async function loadIntegrations() {
  if (!available()) return integrations;
  try {
    Object.assign(integrations, await store.api('/integrations'), { loaded: true });
    emit();
  } catch {
    /* server unreachable: keep what we had */
  }
  return integrations;
}

/** Re-read events from the server (synced calendars change them in the background). */
export async function refreshEvents() {
  if (!available()) return;
  try {
    store.replaceCollection('events', await store.api('/events'));
  } catch {}
}

export async function syncNow(id) {
  const { results } = await post('/integrations/sync', { id, timeZone: timeZone() });
  await Promise.all([loadIntegrations(), refreshEvents()]);
  return results;
}

/**
 * Google sign-in happens in Chrome or Edge, never in Leafdeck: Google blocks sign-in inside embedded browsers, and
 * with Leafdeck as the default browser "your normal browser" would be Leafdeck itself.
 * We watch for the new/reconnected account to show up, then pull its events.
 */
export async function connectGoogle() {
  const { url } = await post('/integrations/google/start', { timeZone: timeZone() });
  const before = new Set(integrations.connections.map((c) => `${c.id}|${c.status}`));
  if (shell?.openInBrowser) shell.openInBrowser(url);
  else if (shell) shell.openExternal(url);
  else window.open(url, '_blank', 'noopener');
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      await loadIntegrations();
      const fresh = integrations.connections.find((c) => c.provider === 'google' && c.status === 'ok' && !before.has(`${c.id}|${c.status}`));
      if (!fresh && Date.now() - started < 5 * 60_000) return;
      clearInterval(timer);
      if (fresh) {
        toast(`Connected ${fresh.name}`);
        await syncNow(fresh.id).catch(() => {});
      }
      resolve(fresh || null);
    }, 2500);
  });
}

export async function subscribe(url, name, color) {
  const r = await post('/integrations/ics', { url, name, color, timeZone: timeZone() });
  await Promise.all([loadIntegrations(), refreshEvents()]);
  return r;
}

export async function updateConnection(id, patch) {
  await store.api(`/integrations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  await loadIntegrations();
  if (patch.calendars) await syncNow(id);
}

export async function disconnect(id) {
  await store.api(`/integrations/${id}`, { method: 'DELETE' });
  await Promise.all([loadIntegrations(), refreshEvents()]);
}

/** Google accounts that can show mail (connected after Gmail access was added). */
export const gmailAccounts = () => integrations.connections.filter((c) => c.provider === 'google' && c.status !== 'needs_reauth');

/** Recent inbox messages for a Google account: { messages, unreadCount, email }. Throws with .needsScope / .status. */
export async function fetchMail(id, { max = 12, unreadOnly = false } = {}) {
  try {
    return await store.api(`/integrations/${encodeURIComponent(id)}/mail?max=${max}${unreadOnly ? '&unread=1' : ''}`);
  } catch (err) {
    if (err.body?.needsScope) err.needsScope = true;
    throw err;
  }
}

/** The calendar invite attached to one message: { summary, method, start: { date } | { at } }, or null. */
export async function fetchInvite(id, messageId) {
  const res = await store.api(`/integrations/${encodeURIComponent(id)}/mail/${encodeURIComponent(messageId)}/invite`);
  return res?.invite || null;
}

/** Calendars new or edited events can be saved to ("connectionId:calendarId"). */
export function writableCalendars() {
  return integrations.connections
    .filter((c) => c.provider === 'google' && c.status !== 'needs_reauth')
    .flatMap((c) => c.calendars.filter((k) => k.selected && k.writable).map((k) => ({ value: `${c.id}:${k.id}`, name: k.name, account: c.name, color: k.color })));
}

export function calendarInfo(value) {
  if (!value) return null;
  const i = value.indexOf(':');
  const conn = integrations.connections.find((c) => c.id === value.slice(0, i));
  const cal = conn?.calendars.find((k) => k.id === value.slice(i + 1));
  return conn ? { conn, cal, name: cal?.name || conn.name, provider: conn.provider } : null;
}

export function initIntegrations() {
  if (!available()) return;
  loadIntegrations();
  // The Worker syncs every 15 minutes; pick up its changes regularly and when you come back to Leafdeck.
  setInterval(() => {
    loadIntegrations();
    refreshEvents();
  }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => !document.hidden && refreshEvents());
}
