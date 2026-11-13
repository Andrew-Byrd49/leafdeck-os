// Leafdeck Store: free apps from verified publishers, signed and sandboxed, that run like the ones App Builder makes.
// The work is electron/appstore.cjs; publishing is in App Builder.
import { esc } from '../util.js';
import { icon, appIcon } from '../icons.js';
import { registerApp, openApp, toast, wins } from '../wm.js';
import { confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';
import { userApps, onUserApps, refreshUserApps, openUserApp, describePermission, revoke } from '../userapps.js';

const as = shell?.appStore || null;

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Shared by every view: the store's listings and what's being installed.
let catalog = new Map(); // id -> the store's listing
let loaded = false;
let catalogError = null;
let fetching = null;
const busy = new Map(); // id -> what's happening to it
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

const ownedApps = () => userApps().filter((a) => a.store);
const owned = (id) => ownedApps().find((a) => a.id === id);
const waitingUpdates = () => [...catalog.values()].filter((a) => a.update);
const nameOf = (id) => catalog.get(id)?.name || owned(id)?.name || id;
const byName = (a, b) => a.name.localeCompare(b.name);

function loadCatalog() {
  fetching ||= as
    .catalog()
    .then((list) => {
      catalog = new Map(list.map((a) => [a.id, a]));
      loaded = true;
      catalogError = null;
    })
    .catch((err) => {
      catalogError = err;
    })
    .finally(() => {
      fetching = null;
      changed();
    });
  return fetching;
}

async function openStoreApp(id) {
  await refreshUserApps();
  try {
    openUserApp(id);
  } catch (err) {
    toast(cleanError(err), 'error');
  }
}

async function install(id, verb) {
  busy.set(id, verb);
  changed();
  try {
    await as.install(id);
    await refreshUserApps();
    await loadCatalog();
    toast(`${nameOf(id)} is ${verb === 'Updating' ? 'up to date' : 'installed'}`, '', { label: 'Open', act: () => openStoreApp(id) });
  } catch (err) {
    toast(cleanError(err), 'error');
  }
  busy.delete(id);
  changed();
}

async function remove(id, win) {
  const name = nameOf(id);
  if (!(await confirmDialog(`Remove ${name}?`, { ok: 'Remove', danger: true, win, detail: 'What it saved stays in Leafdeck. If you install it again, it asks for your approval again.' }))) return;
  busy.set(id, 'Removing');
  changed();
  try {
    await as.remove(id);
    await refreshUserApps();
    revoke(id);
    await loadCatalog();
    toast(`${name} was removed`);
  } catch (err) {
    toast(cleanError(err), 'error');
  }
  busy.delete(id);
  changed();
}

async function customize(id, win) {
  const name = nameOf(id);
  const ok = await confirmDialog(`Make your own copy of ${name}?`, { ok: 'Make a copy', win, detail: 'It becomes an app in App Builder that you and your agent can change. It won’t get updates from the store.' });
  if (!ok) return;
  try {
    const m = await as.customize(id);
    await refreshUserApps();
    openApp('appbuilder', { record: m.id });
  } catch (err) {
    toast(cleanError(err), 'error');
  }
}

/** The button(s) for an app: Install, Open, or what's happening to it. */
function actions(id, { page = false } = {}) {
  const verb = busy.get(id);
  if (verb) return `<span class="ga-job"><span class="ga-job-text">${esc(verb)}…</span><span class="progress"><i class="indeterminate" style="width:30%"></i></span></span>`;
  const m = owned(id);
  if (!m) return `<button class="btn small primary" data-st="install" data-id="${esc(id)}">Install</button>`;
  return `${catalog.get(id)?.update && !m.blocked ? `<button class="btn small" data-st="update" data-id="${esc(id)}">Update</button>` : ''}
    ${m.blocked ? '' : `<button class="btn small${page ? ' primary' : ''}" data-st="open" data-id="${esc(id)}">Open</button>`}
    ${page ? `<button class="btn small" data-st="remove" data-id="${esc(id)}">Remove</button>` : ''}
    ${page && !m.blocked ? `<button class="btn small" data-st="customize" data-id="${esc(id)}">Make it yours</button>` : ''}`;
}

const verifiedTick = `<span class="ga-verified" title="A publisher the Leafdeck team has verified">${icon('tick', 10)}</span>`;
const storeIcon = (a, cls = '') => `<span class="ga-store-icon ${cls}">${appIcon({ ...a, icon: a.icon || 'sparkle' })}</span>`;

function card(a) {
  return `<div class="ga-card" data-app="${esc(a.id)}" tabindex="0">
    ${storeIcon(a)}
    <div class="ga-card-text"><b>${esc(a.name)}</b><small>${esc(a.description)}</small>
      <span class="ga-dev">${esc(a.publisher.name)}${verifiedTick}</span></div>
    <div class="ga-act" data-act-for="${esc(a.id)}">${actions(a.id)}</div>
  </div>`;
}

const bytes = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};

let pendingView = null; // where a window opened by openApp('appstore', { app | search }) starts

registerApp({
  id: 'appstore',
  name: 'Leafdeck Store',
  icon: 'leaf',
  color: 'teal',
  size: [1000, 680],
  min: [620, 420],
  hidden: !as,
  launch(opts = {}) {
    // An app's page or a search: the open window goes there, or the new one starts there.
    const v = opts.app ? { kind: 'app', id: String(opts.app) } : opts.search ? { kind: 'search', q: String(opts.search) } : null;
    const w = wins.get('appstore');
    if (w?.leafStore && v) w.leafStore.go(v);
    else pendingView = v;
  },
  mount(win) {
    if (!as) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">The Leafdeck Store is part of the Leafdeck app</div></div>`;
      return;
    }
    win.tools.innerHTML = `<label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search the store" aria-label="Search the store"></label>`;
    win.body.innerHTML = `<div class="ga">
      <nav class="ga-nav">
        <button data-nav="all">${icon('grid', 14)}<span>All apps</span></button>
        <div class="ga-nav-h">Your apps</div>
        <button data-nav="installed">${icon('tick', 14)}<span>Installed</span><small data-count="installed"></small></button>
        <button data-nav="updates">${icon('refresh', 14)}<span>Updates</span><small data-count="updates"></small></button>
      </nav>
      <main class="ga-main"></main>
    </div>`;
    const main = win.body.querySelector('.ga-main');
    const input = win.tools.querySelector('input');
    let view = null;
    let history = [];
    let token = 0; // the latest load; an older one finishing late is ignored

    const counts = () => {
      win.body.querySelector('[data-count="installed"]').textContent = ownedApps().length || '';
      const u = win.body.querySelector('[data-count="updates"]');
      const waiting = waitingUpdates().length;
      u.textContent = waiting || '';
      u.classList.toggle('ga-badge', !!waiting);
    };
    const markNav = () => {
      for (const b of win.body.querySelectorAll('.ga-nav button')) b.classList.toggle('on', b.dataset.nav === view?.kind);
    };
    // Installs and listings: just the buttons, so a page doesn't jump.
    const refreshActions = () => {
      counts();
      for (const a of main.querySelectorAll('[data-act-for]')) a.innerHTML = actions(a.dataset.actFor, { page: a.classList.contains('ga-page-act') });
      if (view?.kind === 'installed' || view?.kind === 'updates') draw();
    };

    const loading = (text = 'Loading…') => (main.innerHTML = `<div class="ga-loading">${esc(text)}</div>`);
    const failed = () =>
      (main.innerHTML = `<div class="empty"><div class="empty-title">The Leafdeck store isn’t available</div><p>${esc(cleanError(catalogError))}</p>
        <button class="btn small" data-st="retry">Try again</button></div>`);
    const unreachable = () => catalogError && !loaded;

    async function draw() {
      const my = ++token;
      markNav();
      counts();
      const v = view;
      if (v.kind === 'all') {
        loading();
        await loadCatalog();
        if (my !== token) return;
        if (unreachable()) return failed();
        main.innerHTML = `<h2 class="ga-h">All apps</h2>
          <p class="ga-lede">Free apps from verified publishers. Each one runs in its own sandbox and asks before it sees your data.</p>
          ${catalog.size ? `<div class="ga-grid">${[...catalog.values()].map(card).join('')}</div>` : `<div class="empty small"><p>No apps here yet.</p></div>`}`;
        main.scrollTop = v.scroll || 0;
      } else if (v.kind === 'search') {
        loading();
        if (!loaded) await loadCatalog();
        if (my !== token) return;
        if (unreachable()) return failed();
        const needle = v.q.toLocaleLowerCase();
        const list = [...catalog.values()].filter((a) => `${a.name} ${a.description} ${a.publisher.name}`.toLocaleLowerCase().includes(needle));
        main.innerHTML = `<h2 class="ga-h">Results for “${esc(v.q)}”</h2>
          ${list.length ? `<div class="ga-grid">${list.map(card).join('')}</div>` : `<div class="empty small"><p>Nothing in the store matches that.</p></div>`}`;
        main.scrollTop = v.scroll || 0;
      } else if (v.kind === 'installed') {
        const list = ownedApps().sort(byName);
        const keep = main.scrollTop;
        main.innerHTML = `<h2 class="ga-h">Installed</h2>
          ${list.length ? `<div class="ga-rows">${list.map((a) => `<div class="ga-row" data-app="${esc(a.id)}">
              ${storeIcon(a, 'small')}
              <span class="ga-row-text"><b>${esc(a.name)}</b><small>${esc([a.version, a.store.publisher.name, a.blocked ? 'Taken down' : ''].filter(Boolean).join(' · '))}</small></span>
              <span class="ga-act" data-act-for="${esc(a.id)}">${actions(a.id)}</span>
              ${busy.has(a.id) ? '' : `<button class="icon-btn" data-st="remove" data-id="${esc(a.id)}" title="Remove ${esc(a.name)}">${icon('trash', 13)}</button>`}
            </div>`).join('')}</div>` : `<div class="empty small"><p>Apps you install are listed here.</p></div>`}`;
        main.scrollTop = keep;
      } else if (v.kind === 'updates') {
        if (!loaded && !catalogError) {
          loading('Checking for updates…');
          await loadCatalog(); // redraws when it's done
          return;
        }
        if (unreachable()) return failed();
        const list = waitingUpdates();
        main.innerHTML = `<div class="ga-h-row"><h2 class="ga-h">Updates</h2><button class="btn small" data-st="check">Check again</button></div>
          ${list.length ? `<div class="ga-rows">${list.map((a) => `<div class="ga-row" data-app="${esc(a.id)}">
              ${storeIcon(a, 'small')}
              <span class="ga-row-text"><b>${esc(a.name)}</b><small>${a.permissions.some((p) => !owned(a.id)?.permissions.includes(p)) ? 'Asks for more permissions' : `→ ${esc(a.version)}`}</small></span>
              <span class="ga-act" data-act-for="${esc(a.id)}">${actions(a.id)}</span></div>`).join('')}</div>` : `<div class="empty small"><p>Your apps are up to date.</p></div>`}`;
      } else if (v.kind === 'app') {
        loading();
        if (!catalog.has(v.id)) await loadCatalog();
        if (my !== token) return;
        const mine = owned(v.id);
        const a = catalog.get(v.id) || (mine && { ...mine, publisher: mine.store.publisher, at: mine.store.at });
        if (!a) {
          if (unreachable()) return failed();
          main.innerHTML = `<div class="empty"><div class="empty-title">That app isn’t in the store any more</div></div>`;
          return;
        }
        const facts = [
          ['Version', a.version],
          ['Updated', new Date(a.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })],
          a.download && ['Download', bytes(a.download)],
          ['Price', 'Free'],
        ].filter(Boolean);
        main.innerHTML = `<div class="ga-page">
          ${history.length ? `<button class="ga-back" data-st="back">${icon('left', 13)} Back</button>` : ''}
          <div class="ga-head">${storeIcon(a, 'big')}
            <div class="ga-head-text"><h2>${esc(a.name)}</h2><p>${esc(a.description)}</p>
              <span class="ga-dev">${esc(a.publisher.name)}${verifiedTick} Verified publisher${a.publisher.domain ? ` · ${esc(a.publisher.domain)}` : ''}</span></div>
            <div class="ga-act ga-page-act" data-act-for="${esc(a.id)}">${actions(a.id, { page: true })}</div></div>
          ${mine?.blocked ? `<div class="ga-note">This app was taken down from the store and can’t be opened. Reason: ${esc(mine.blocked)}</div>` : ''}
          <h3 class="ga-sub">What it asks for</h3>
          <ul class="ua-perms">${a.permissions.length ? a.permissions.map((p) => { const d = describePermission(p); return `<li class="${d.warn ? 'warn' : ''}">${icon(d.icon, 14)}<span>${esc(d.text)}</span></li>`; }).join('') : `<li>${icon('check', 14)}<span>Only its own data. It can’t see your other records.</span></li>`}</ul>
          <p class="ga-lede ga-after">You approve this the first time it opens, and again if it ever asks for more.</p>
          <dl class="ga-facts">${facts.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
        </div>`;
        main.scrollTop = 0;
      }
    }

    function go(next, { push = true } = {}) {
      if (push && view) history.push({ ...view, scroll: main.scrollTop });
      if (history.length > 30) history.shift();
      view = next;
      if (next.kind !== 'search') input.value = '';
      draw();
    }
    win.leafStore = { go: (v) => go(v) };

    win.body.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        history = [];
        return go({ kind: nav.dataset.nav }, { push: false });
      }
      const b = e.target.closest('[data-st]');
      if (b) {
        e.stopPropagation();
        const id = b.dataset.id;
        const act = b.dataset.st;
        if (act === 'install') install(id, 'Installing');
        else if (act === 'update') install(id, 'Updating');
        else if (act === 'open') openStoreApp(id);
        else if (act === 'remove') remove(id, win);
        else if (act === 'customize') customize(id, win);
        else if (act === 'retry') {
          catalogError = null;
          draw();
        } else if (act === 'check') {
          loading('Checking for updates…');
          loadCatalog().then(() => catalogError && toast(cleanError(catalogError), 'error'));
        } else if (act === 'back') {
          view = history.pop();
          draw();
        }
        return;
      }
      const row = e.target.closest('[data-app]');
      if (row) go({ kind: 'app', id: row.dataset.app });
    });
    win.body.addEventListener('keydown', (e) => {
      const c = e.target.closest?.('.ga-card');
      if (c && e.key === 'Enter') go({ kind: 'app', id: c.dataset.app });
    });
    let searchTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      searchTimer = setTimeout(() => {
        if (q) {
          if (view?.kind === 'search') view = { kind: 'search', q };
          else go({ kind: 'search', q });
          draw();
        } else if (view?.kind === 'search') {
          view = history.pop() || { kind: 'all' };
          draw();
        }
      }, 300);
    });

    listeners.add(refreshActions);
    win.cleanups.push(() => listeners.delete(refreshActions));

    view = pendingView || { kind: 'all' };
    pendingView = null;
    if (view.kind === 'search') input.value = view.q;
    draw();
    if (view.kind === 'installed') loadCatalog(); // for the Updates count
  },
});

if (as) onUserApps(changed);
