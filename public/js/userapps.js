// User apps in the Leafdeck UI: registers each app from Documents\Leafdeck Apps as a Leafdeck app ("user:<id>"),
// hosts it in a sandboxed <webview>, asks you to approve its permissions, and answers its `window.leafdeck` calls
// (electron/app-preload.cjs) — checking every call against the permissions you approved. Main-process side:
// electron/userapps.cjs. Built with App Builder (apps/appbuilder.js).
import { store } from './store.js';
import { shell } from './shell.js';
import { $, el, esc } from './util.js';
import { icon, ICONS } from './icons.js';
import { registerApp, registry, openApp, wins, closeWindow, toast, refreshAppIcon, renderDock } from './wm.js';
import { COLLECTIONS } from './schemas.js';

const PARTITION = 'persist:leafapps';
const LS_GRANTS = 'ws:app-grants';
const LS_OFF = 'ws:userapps-off';
const OWN = 'appdata'; // every app's own records live here, tagged with the app's id
const MAX_RECORD = 200_000;

let apps = new Map(); // id -> manifest (+ path, hasIndex, broken)
let appsDir = '';
const listeners = new Set();
export const onUserApps = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((f) => f());

export const userApps = () => [...apps.values()];
export const userAppsDir = () => appsDir;
export const appWindowId = (id) => 'user:' + id;

/* ---------------- Grants (approved permissions, per device) ---------------- */

const readGrants = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_GRANTS)) || {};
  } catch {
    return {};
  }
};
const writeGrants = (g) => {
  try {
    localStorage.setItem(LS_GRANTS, JSON.stringify(g));
  } catch {}
};
export const grantedFor = (id) => readGrants()[id] || null; // the permission list you approved, or null
export const isApproved = (m) => {
  const g = grantedFor(m.id);
  return !!g && m.permissions.every((p) => g.includes(p));
};
const approve = (m) => writeGrants({ ...readGrants(), [m.id]: [...m.permissions] });
export function revoke(id) {
  const g = readGrants();
  delete g[id];
  writeGrants(g);
  const w = wins.get(appWindowId(id));
  if (w) mountApp(w, id);
  emit();
}

export const appsOff = () => {
  try {
    return localStorage.getItem(LS_OFF) === '1';
  } catch {
    return false;
  }
};
export function setAppsOff(off) {
  try {
    localStorage.setItem(LS_OFF, off ? '1' : '0');
  } catch {}
  for (const id of apps.keys()) {
    const w = wins.get(appWindowId(id));
    if (w) mountApp(w, id);
  }
  emit();
}

/** "tasks:read" → "Read your tasks", and so on, for the consent screen. */
export function describePermission(p) {
  const [what, how] = p.split(':');
  if (p === 'notify') return { icon: 'bolt', text: 'Show notifications' };
  if (what === 'network') return { icon: 'globe', text: `Connect to ${how}`, warn: true };
  if (what === 'local') return { icon: 'link', text: `Connect to a program on this computer (port ${how})`, warn: true };
  return how === 'write' ? { icon: 'refresh', text: `Read and change your ${what}`, warn: true } : { icon: 'eye', text: `Read your ${what}` };
}

/* ---------------- Registering apps ---------------- */

function register(m) {
  const id = appWindowId(m.id);
  registerApp({
    id,
    name: m.name,
    icon: m.icon || 'sparkle',
    glyph: m.glyph || undefined,
    color: m.color || 'green',
    size: m.size || [960, 680],
    min: [360, 260],
    userApp: m.id,
    mount: (win) => mountApp(win, m.id),
  });
}

export async function refreshUserApps() {
  if (!shell?.userApps) return;
  let res;
  try {
    res = await shell.userApps.list();
  } catch {
    return;
  }
  appsDir = res.dir;
  const next = new Map(res.apps.map((a) => [a.id, a]));
  for (const id of apps.keys()) {
    if (next.has(id)) continue;
    registry.delete(appWindowId(id));
    const w = wins.get(appWindowId(id));
    if (w) closeWindow(w);
  }
  apps = next;
  for (const m of apps.values()) {
    register(m);
    refreshAppIcon(appWindowId(m.id));
  }
  renderDock();
  emit();
}

export function initUserApps() {
  if (!shell?.userApps) return;
  refreshUserApps();
  // Leafdeck watches the apps folder: reload an app's window a moment after its files change.
  shell.on('shell:user-apps', async ({ id }) => {
    const before = id && apps.get(id);
    await refreshUserApps();
    if (!id) return;
    const w = wins.get(appWindowId(id));
    if (!w) return;
    const m = apps.get(id);
    const permsChanged = JSON.stringify(before?.permissions) !== JSON.stringify(m?.permissions);
    if (!m || permsChanged || !w.appView || !isApproved(m)) mountApp(w, id);
    else {
      w.setTitle(m.name);
      try {
        w.appView.reloadIgnoringCache();
      } catch {}
    }
  });
  // Light/dark and accent follow Leafdeck.
  store.addEventListener('change', (e) => ['settings', '*'].includes(e.detail.col) && broadcastTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', broadcastTheme);
}

/** Open (or bring forward) an app; `reload` reloads its page — what the agent's leafdeck_app_open does. */
export function openUserApp(id, { reload = false } = {}) {
  const m = apps.get(id);
  if (!m) throw new Error(`No app "${id}" in ${appsDir}`);
  const existed = wins.has(appWindowId(id));
  const w = openApp(appWindowId(id));
  if (existed && reload) {
    if (w.appView && isApproved(m)) w.appView.reloadIgnoringCache();
    else mountApp(w, id);
  }
  return { window: w.id, pending: appsOff() ? 'turned-off' : !isApproved(m) ? 'permissions' : m.hasIndex ? '' : 'no-index' };
}

/* ---------------- Hosting one app ---------------- */

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const t = document.documentElement.dataset.theme;
  const dark = t === 'light' ? false : t === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
  return { dark, accent: cs.getPropertyValue('--accent').trim() || '#34c77b', accentInk: cs.getPropertyValue('--accent-ink').trim() || '#07130c' };
}
function broadcastTheme() {
  const t = theme();
  for (const w of wins.values()) if (w.appView && w.userApp) send(w.appView, 'leafapp:event', { type: 'theme', detail: t });
}
const send = (wv, ch, payload) => {
  try {
    wv.send(ch, payload);
  } catch {}
};

function mountApp(win, id) {
  const m = apps.get(id);
  win.cleanups.forEach((f) => f());
  win.cleanups.length = 0;
  win.appView = null;
  win.userApp = id;
  win.tools.innerHTML = '';
  if (!m) {
    win.body.innerHTML = `<div class="empty"><div class="empty-title">This app is gone</div><p>It was removed from your Leafdeck Apps folder.</p></div>`;
    return;
  }
  win.setTitle(m.name);
  // The app's own controls (leafdeck.toolbar.set) go first, then Leafdeck's reload.
  win.appToolbar = [];
  win.tools.innerHTML = `<div class="ua-tools"></div><span class="ua-sep" hidden></span>
    <button class="tb-btn" data-ua="reload" title="Reload">${icon('refresh', 14)}</button>`;
  win.tools.onclick = (e) => {
    const b = e.target.closest('[data-ua]');
    if (!b) return;
    if (b.dataset.ua === 'reload') mountApp(win, id);
  };
  if (appsOff()) return message(win, 'Your apps are turned off', 'Turn them back on in App Builder.', 'Open App Builder', () => openApp('appbuilder'));
  if (m.broken) return message(win, 'This app can’t start', m.broken, 'Open App Builder', () => openApp('appbuilder', { record: id }));
  if (!m.hasIndex) return message(win, 'Nothing here yet', 'This app has no index.html yet. Ask your agent to build it.', 'Open App Builder', () => openApp('appbuilder', { record: id }));
  if (!isApproved(m)) return consent(win, m);
  startApp(win, m);
}

/* ---------- The app's controls in the window's title bar (leafdeck.toolbar.set) ---------- */

let iconCache = null;
/** Leafdeck's line icons (the inner SVG of each), so apps draw the same icons as built-in apps. */
function iconPaths() {
  if (!iconCache) iconCache = Object.fromEntries(ICONS.map((n) => [n, icon(n, 16).replace(/^<svg[^>]*>|<\/svg>$/g, '')]));
  return iconCache;
}

const TB_TYPES = ['segmented', 'search', 'select', 'button'];
const str = (v, n = 40) => (v == null ? '' : String(v).slice(0, n));
/** Keep only what the toolbar can draw: up to 8 controls, short labels, known icons. */
function cleanToolbar(items) {
  if (!Array.isArray(items)) throw new Error('toolbar.set expects an array of controls');
  const seen = new Set();
  return items.slice(0, 8).map((it, i) => {
    if (!it || !TB_TYPES.includes(it.type)) throw new Error(`Toolbar control ${i + 1}: type must be one of ${TB_TYPES.join(', ')}`);
    const id = str(it.id || `${it.type}-${i}`, 30);
    if (seen.has(id)) throw new Error(`Toolbar control ids must be unique ("${id}")`);
    seen.add(id);
    const ic = ICONS.includes(it.icon) ? it.icon : '';
    const opts = (Array.isArray(it.options) ? it.options : []).slice(0, 8).map((o) => (typeof o === 'object' && o ? { value: str(o.value), label: str(o.label), icon: ICONS.includes(o.icon) ? o.icon : '', title: str(o.title, 60) } : { value: str(o), label: str(o) }));
    if ((it.type === 'segmented' || it.type === 'select') && !opts.length) throw new Error(`Toolbar control "${id}" needs options`);
    return { type: it.type, id, label: str(it.label), title: str(it.title, 60), icon: ic, primary: !!it.primary, placeholder: str(it.placeholder, 40), value: str(it.value ?? (opts[0]?.value || ''), 80), options: opts, width: Number(it.width) > 0 ? Math.min(260, Math.max(100, Number(it.width))) : 0 };
  });
}

function renderToolbar(win, wv) {
  const box = $('.ua-tools', win.tools);
  if (!box) return;
  const items = win.appToolbar || [];
  // Keep typing in a search box when the app redraws its toolbar.
  const active = box.contains(document.activeElement) ? document.activeElement : null;
  const activeId = active?.closest('[data-tid]')?.dataset.tid;
  const caret = active?.selectionStart;
  box.innerHTML = items
    .map((it) => {
      const tid = esc(it.id);
      if (it.type === 'segmented')
        return `<div class="seg" data-tid="${tid}" role="group">${it.options.map((o) => `<button class="${o.value === it.value ? 'on' : ''}" data-v="${esc(o.value)}" title="${esc(o.title || o.label)}" aria-pressed="${o.value === it.value}">${o.icon ? icon(o.icon, 14) : esc(o.label)}</button>`).join('')}</div>`;
      if (it.type === 'search')
        return `<label class="tb-search" data-tid="${tid}"${it.width ? ` style="width:${it.width}px"` : ''}>${icon('search', 13)}<input type="search" placeholder="${esc(it.placeholder || 'Search')}" value="${esc(it.value)}" aria-label="${esc(it.placeholder || 'Search')}"></label>`;
      if (it.type === 'select')
        return `<select class="tb-select" data-tid="${tid}" title="${esc(it.title)}">${it.options.map((o) => `<option value="${esc(o.value)}"${o.value === it.value ? ' selected' : ''}>${esc(o.label || o.value)}</option>`).join('')}</select>`;
      if (it.label) return `<button class="tb-pill${it.primary ? ' primary' : ''}" data-tid="${tid}" title="${esc(it.title)}">${it.icon ? icon(it.icon, 12) + ' ' : ''}${esc(it.label)}</button>`;
      return `<button class="tb-btn" data-tid="${tid}" title="${esc(it.title || it.icon)}" aria-label="${esc(it.title || it.icon)}">${icon(it.icon || 'sparkle', 15)}</button>`;
    })
    .join('');
  $('.ua-sep', win.tools).hidden = !items.length;
  if (activeId) {
    const again = $(`[data-tid="${CSS.escape(activeId)}"] input`, box);
    if (again) {
      again.focus();
      if (caret != null) again.setSelectionRange(caret, caret);
    }
  }
  const fire = (id, value) => send(wv, 'leafapp:event', { type: 'toolbar', detail: value === undefined ? { id } : { id, value } });
  const item = (id) => items.find((x) => x.id === id);
  box.onclick = (e) => {
    const host = e.target.closest('[data-tid]');
    if (!host) return;
    const it = item(host.dataset.tid);
    if (it?.type === 'segmented') {
      const b = e.target.closest('[data-v]');
      if (!b || b.dataset.v === it.value) return;
      it.value = b.dataset.v;
      renderToolbar(win, wv);
      fire(it.id, it.value);
    } else if (it?.type === 'button') fire(it.id);
  };
  let timer = 0;
  box.oninput = (e) => {
    const host = e.target.closest('.tb-search[data-tid]');
    if (!host) return;
    const it = item(host.dataset.tid);
    it.value = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => fire(it.id, it.value), 120);
  };
  box.onchange = (e) => {
    const host = e.target.closest('select[data-tid]');
    if (!host) return;
    const it = item(host.dataset.tid);
    it.value = host.value;
    fire(it.id, it.value);
  };
  box.onkeydown = (e) => {
    const host = e.target.closest('.tb-search[data-tid]');
    if (!host) return;
    if (e.key === 'Escape' && e.target.value) {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (e.key === 'Enter') send(wv, 'leafapp:event', { type: 'toolbar', detail: { id: host.dataset.tid, value: e.target.value, submit: true } });
  };
}

function message(win, title, text, action, act) {
  win.body.innerHTML = `<div class="empty ua-msg"><div class="empty-title">${esc(title)}</div><p>${esc(text)}</p>
    ${action ? `<button class="btn small" data-act>${esc(action)}</button>` : ''}</div>`;
  $('[data-act]', win.body)?.addEventListener('click', act);
}

/** Before an app runs (and whenever it asks for more), you approve what it may do. */
function consent(win, m) {
  const before = grantedFor(m.id) || [];
  const fresh = m.permissions.filter((p) => !before.includes(p));
  const rows = m.permissions.length
    ? m.permissions
        .map((p) => {
          const d = describePermission(p);
          return `<li class="${d.warn ? 'warn' : ''}">${icon(d.icon, 14)}<span>${esc(d.text)}</span>${fresh.includes(p) && before.length ? '<em>New</em>' : ''}</li>`;
        })
        .join('')
    : `<li>${icon('check', 14)}<span>Only its own data. It can’t see your other records.</span></li>`;
  win.body.innerHTML = `<div class="ua-consent">
    <div class="ua-c-head"><div class="ua-c-icon">${icon(m.icon || 'sparkle', 26)}</div>
      <div><h2>${esc(m.name)}</h2><p>${esc(m.description || 'An app you built for Leafdeck.')}</p></div></div>
    <h5>${before.length ? 'This app now wants to' : 'This app wants to'}</h5>
    <ul class="ua-perms">${rows}</ul>
    ${m.ignoredPermissions?.length ? `<p class="ua-c-note">Ignored (not supported): ${esc(m.ignoredPermissions.join(', '))}</p>` : ''}
    <p class="ua-c-note">It runs in its own sandbox: no access to your passwords, cookies, other sites, files, or Leafdeck itself.</p>
    <div class="ua-c-actions"><button class="btn" data-c="no">Not now</button><button class="btn primary" data-c="yes">Allow and open</button></div></div>`;
  win.body.querySelector('.ua-consent').addEventListener('click', (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'yes') {
      approve(m);
      emit();
      mountApp(win, m.id);
    } else if (c === 'no') closeWindow(win);
  });
}

function startApp(win, m) {
  const granted = new Set(grantedFor(m.id));
  win.body.innerHTML = '<div class="embed userapp"></div>';
  const wrap = $('.embed', win.body);
  const wv = document.createElement('webview');
  wv.setAttribute('partition', PARTITION);
  wv.setAttribute('src', `leafapp://${m.id}/index.html`);
  wrap.append(wv);
  win.appView = wv;

  const canRead = (col) => COLLECTIONS.includes(col) && (granted.has(`${col}:read`) || granted.has(`${col}:write`));
  const canWrite = (col) => COLLECTIONS.includes(col) && granted.has(`${col}:write`);
  const plain = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  const mine = (r) => r && r.app === m.id;
  const own = (r) => {
    if (!r) return null;
    const { app, ...rest } = r;
    return plain(rest);
  };
  const checkSize = (rec) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('Expected a record object');
    if (JSON.stringify(rec).length > MAX_RECORD) throw new Error('That record is too big (keep records under 200 KB)');
  };
  const matches = (r, q) => !q || typeof q !== 'object' || Object.entries(q).every(([k, v]) => r[k] === v);

  const methods = {
    'records.list': (col, query) => {
      if (!canRead(col)) throw new Error(`No permission to read ${col}. Add "${col}:read" to manifest.json.`);
      return store.all(col).filter((r) => matches(r, query)).map(plain);
    },
    'records.get': (col, rid) => {
      if (!canRead(col)) throw new Error(`No permission to read ${col}. Add "${col}:read" to manifest.json.`);
      return plain(store.get(col, rid));
    },
    'records.save': (col, rec) => {
      if (!canWrite(col)) throw new Error(`No permission to change ${col}. Add "${col}:write" to manifest.json.`);
      checkSize(rec);
      return plain(store.save(col, rec));
    },
    'records.remove': (col, rid) => {
      if (!canWrite(col)) throw new Error(`No permission to change ${col}. Add "${col}:write" to manifest.json.`);
      store.remove(col, rid);
      return true;
    },
    'data.list': (kind) => store.all(OWN).filter((r) => mine(r) && (!kind || r.kind === kind)).map(own),
    'data.get': (rid) => {
      const r = store.get(OWN, rid);
      return mine(r) ? own(r) : null;
    },
    'data.save': (kind, rec) => {
      checkSize(rec);
      if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,30}$/i.test(kind)) throw new Error('kind must be a short name like "client"');
      if (rec.id) {
        const prev = store.get(OWN, rec.id);
        if (prev && !mine(prev)) throw new Error('That record belongs to another app');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(rec.id)) throw new Error('Record ids may only use letters, numbers, - and _');
      }
      return own(store.save(OWN, { ...rec, app: m.id, kind }));
    },
    'data.remove': (rid) => {
      const r = store.get(OWN, rid);
      if (!mine(r)) throw new Error('No such record');
      store.remove(OWN, rid);
      return true;
    },
    notify: (title, body) => {
      if (!granted.has('notify')) throw new Error('No permission to notify. Add "notify" to manifest.json.');
      const t = String(title || '').slice(0, 120);
      const b = String(body || '').slice(0, 300);
      toast(`${m.name}: ${t}${b ? ' — ' + b : ''}`);
      if (shell?.notify && !document.hasFocus()) shell.notify({ title: `${m.name}: ${t}`, body: b });
      return true;
    },
    openUrl: async (u) => {
      if (!/^https?:\/\//i.test(String(u))) throw new Error('Only http(s) addresses can be opened');
      (await import('./apps/browser.js')).openWebPage(String(u));
      return true;
    },
    openApp: (appId, rid) => {
      const target = String(appId || '');
      if (!registry.has(target) || /^(user|web|link):/.test(target)) throw new Error(`No built-in app "${target}"`);
      openApp(target, rid ? { record: String(rid) } : {});
      return true;
    },
    setTitle: (t) => {
      win.setTitle(String(t || m.name).slice(0, 80));
      return true;
    },
    'toolbar.set': (items) => {
      win.appToolbar = cleanToolbar(items);
      renderToolbar(win, wv);
      return true;
    },
  };

  wv.addEventListener('ipc-message', async (e) => {
    if (e.channel !== 'leafapp:call') return;
    const { id: callId, method, args } = e.args[0] || {};
    const fn = methods[method];
    try {
      if (!fn) throw new Error(`Unknown method ${method}`);
      send(wv, 'leafapp:reply', { id: callId, ok: true, result: await fn(...(Array.isArray(args) ? args : [])) });
    } catch (err) {
      send(wv, 'leafapp:reply', { id: callId, ok: false, error: err.message });
    }
  });
  // A reload starts with an empty toolbar; the app sets it again (often before dom-ready, so clear it here).
  wv.addEventListener('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isInPlace) return;
    win.appToolbar = [];
    renderToolbar(win, wv);
  });
  wv.addEventListener('dom-ready', () => {
    send(wv, 'leafapp:event', { type: 'ready', detail: { app: { id: m.id, name: m.name, permissions: [...granted] }, theme: theme(), icons: iconPaths() } });
  });
  wv.addEventListener('focus', () => import('./wm.js').then((wm) => wm.focus(win)));
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return;
    wrap.append(el(`<div class="web-error"><b>This app couldn’t load</b><span>${esc(e.errorDescription || 'Unknown error')}</span></div>`));
  });
  wv.addEventListener('render-process-gone', () => {
    wrap.append(el(`<div class="web-error"><b>This app crashed</b><span>Your agent can see the error with leafdeck_app_logs.</span>
      <div class="row"><button class="btn small" data-reload>Reload</button></div></div>`));
    $('[data-reload]', wrap)?.addEventListener('click', () => mountApp(win, m.id));
  });

  // Tell the app when data it can see changes (its own, or a collection it may read), here or on another device.
  const onChange = (e) => {
    const col = e.detail.col;
    if (col === '*' || col === OWN || canRead(col)) send(wv, 'leafapp:event', { type: 'change', detail: { collection: col === OWN ? 'data' : col } });
  };
  store.addEventListener('change', onChange);
  win.cleanups.push(() => store.removeEventListener('change', onChange));
}
