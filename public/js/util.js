export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const moneyShort = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const money = (n, short = false) => (short ? moneyShort : moneyFmt).format(Number(n) || 0);
export const compact = (n) =>
  '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0);

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDate();
export const addDays = (n, from = new Date()) => {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
export const parseDate = (s) => (s ? new Date(s + 'T00:00:00') : null);

export function fmtDate(s, opts = { month: 'short', day: 'numeric' }) {
  if (!s) return '';
  const d = parseDate(s);
  const o = { ...opts };
  if (d.getFullYear() !== new Date().getFullYear() && !o.year) o.year = 'numeric';
  return d.toLocaleDateString('en-US', o);
}

export function relDay(s) {
  if (!s) return '';
  const diff = Math.round((parseDate(s) - parseDate(today())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0 && diff > -7) return `${-diff} days ago`;
  if (diff > 0 && diff < 7) return parseDate(s).toLocaleDateString('en-US', { weekday: 'long' });
  return fmtDate(s);
}

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

export const fmtMinutes = (m) => {
  m = Math.round(m || 0);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};

export const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};

export function debounce(fn, ms = 300) {
  let t;
  let pending = null;
  const d = (...a) => {
    clearTimeout(t);
    pending = a;
    t = setTimeout(() => {
      pending = null;
      fn(...a);
    }, ms);
  };
  /** Run a waiting call now (e.g. save before switching away). */
  d.flush = () => {
    if (!pending) return;
    clearTimeout(t);
    const a = pending;
    pending = null;
    fn(...a);
  };
  return d;
}

/** Coalesce many calls within a frame into one. */
export function frame(fn) {
  let q = false;
  return () => {
    if (q) return;
    q = true;
    requestAnimationFrame(() => {
      q = false;
      fn();
    });
  };
}

export const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

export const sum = (rows, f) => rows.reduce((t, r) => t + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);

export function hashHue(str = '') {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
