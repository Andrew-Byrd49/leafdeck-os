// Shared helpers for connected accounts: token encryption, hashing and time-zone math.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const randomId = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
/** Short, stable id (22 chars) derived from a string. */
export const hashId = async (text) => b64url((await sha256(text)).slice(0, 16));

/* ---------- Token encryption (AES-GCM with the TOKEN_KEY Worker secret) ---------- */

async function tokenKey(env) {
  if (!env.TOKEN_KEY) throw new Error('The TOKEN_KEY secret isn’t set on the Worker, so connected accounts can’t be stored safely.');
  const raw = fromB64(env.TOKEN_KEY);
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 random bytes, base64-encoded.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function unseal(env, sealed) {
  const [iv, ct] = String(sealed || '').split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await tokenKey(env), fromB64(ct));
  return JSON.parse(dec.decode(pt));
}

/* ---------- Time zones ---------- */

export function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const fmtCache = new Map();
function partsInZone(date, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

const pad = (n) => String(n).padStart(2, '0');

/** An instant → local date ('YYYY-MM-DD') and time ('HH:MM') in a time zone. */
export function toLocal(date, tz) {
  const p = partsInZone(date, tz);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}

/** Wall-clock time in a time zone → instant (handles DST by correcting the offset twice). */
export function wallToInstant(y, m, d, h = 0, mi = 0, s = 0, tz = 'UTC') {
  const target = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(new Date(guess), tz);
    guess += target - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(guess);
}

export const addDaysIso = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
