import { store } from './store.js';
import { $, $$ } from './util.js';
import {
  activeWindow, wins, registry, openApp, showMenu, closeMenu, menuOwner,
  minimize, toggleMax, closeWindow, minimizeAll, closeAll, appMenuItems, toast, togglePinned, toggleMini, schemeMenuItems, snapTo, pair, unpair,
  screens, barScreens,
} from './wm.js';
import { schemas } from './schemas.js';
import { linkAppId } from './apps/system.js';
import { shell } from './shell.js';
import { openImport } from './apps/bookmarks.js';
import { otherTabsMenuItems } from './devices.js';
import { toggleOverview } from './overview.js';
import { openFocusSetup } from './focus.js';
import { toggleAppScreen } from './appscreen.js';
import { layoutMenuItems } from './layouts.js';
import { openWebPage, openBurnerWindow } from './apps/browser.js';
import { toggleKeyboard, keyboardOpen } from './osk.js';
import { toggleTouches, touchesShown } from './touches.js';
import { addSearch } from './search.js';

/* Leafdeck app updates (installed copy only): the main process downloads them in the background. */
let appUpdate = null;
if (shell?.appUpdate) {
  shell.appUpdate('status').then((u) => (appUpdate = u));
  shell.on('shell:app-update', (u) => {
    if (u.state === 'ready' && appUpdate?.state !== 'ready') {
      toast(`Leafdeck ${u.latest} is ready — it installs when you quit, or use Restart to Update in the Leafdeck menu`);
    }
    appUpdate = u;
  });
}

async function checkForAppUpdate() {
  toast('Checking for updates…');
  const u = await shell.appUpdate('check');
  const msg = {
    dev: 'This is the dev copy (npm run app) — it runs from source, so there’s nothing to update',
    none: `Leafdeck ${u.current} is up to date`,
    downloading: `Downloading Leafdeck ${u.latest}…`,
    ready: `Leafdeck ${u.latest} is ready — choose Restart to Update`,
    error: `Couldn’t check for updates: ${u.error}`,
  }[u.state];
  if (msg) toast(msg, u.state === 'error' ? 'error' : '');
}

const NEW = ['tasks', 'notes', 'contacts', 'events'];

/* Your folders for the Go menu (Linux: the Files app's places). */
let places = null;
if (shell?.files && shell.platform === 'linux') shell.files.places().then((p) => (places = p)).catch(() => {});

// Restart, Shut Down and Sign Out ask first, in a notice with the button to go ahead.
const confirmThen = (msg, label, act) => toast(msg, '', { label, act });
const power = (act) => shell.os.power(act).catch((err) => toast(err.message, 'error'));

/** Leafdeck OS: the Leafdeck menu is the computer's menu (power, lock, settings), not a browser app's. */
function sessionLogoMenu(w) {
  return [
    ...(w ? [...appMenuItems(w.id), '-'] : []),
    { label: 'About Leafdeck', act: () => openApp('about') },
    appUpdate?.state === 'ready'
      ? { label: `Restart to Update (${appUpdate.latest})`, act: () => shell.appUpdate('install') }
      : shell?.appUpdate && { label: appUpdate?.state === 'downloading' ? `Downloading Update… ${appUpdate.percent || 0}%` : 'Check for Updates…', act: checkForAppUpdate },
    '-',
    { label: 'Settings…', act: () => openApp('settings') },
    shell.os?.displays && { label: 'Displays…', act: () => openApp('settings', { tab: 'displays' }) },
    { label: 'Task Manager', key: 'Shift+Esc', act: () => openApp('taskmanager') },
    { label: 'Restart Leafdeck', act: () => shell.windowAction('restart-leafdeck') },
    '-',
    { label: 'Lock Screen', key: 'Ctrl+Alt+L', act: () => shell.os.lock() },
    { label: 'Sleep', act: () => power('sleep') },
    { label: 'Restart…', act: () => confirmThen('Restart the computer?', 'Restart', () => power('restart')) },
    { label: 'Shut Down…', act: () => confirmThen('Shut down the computer?', 'Shut Down', () => power('shutdown')) },
    '-',
    { label: 'Sign Out…', act: () => confirmThen('Sign out? Your windows and terminals close.', 'Sign Out', () => shell.windowAction('sign-out')) },
  ];
}

// File → Print, through Leafdeck's print sheet: what an app says it can print (win.print), or the page in the window.
const pageOf = (w) => w?.el?.querySelector('webview');
const printable = (w) => (w?.print ? w.print.can() : !!pageOf(w));
function printWindow(w) {
  if (w?.print) return void w.print.run();
  const wv = pageOf(w);
  if (wv) shell.print.page(wv.getWebContentsId());
}

function menus() {
  const w = activeWindow();
  const p = store.prefs;
  const os = !!document.documentElement.dataset.session;
  return {
    // One Leafdeck menu: the active window's options first, then app-wide items.
    logo: () => os ? sessionLogoMenu(w) : [
      ...(w ? [...appMenuItems(w.id), '-'] : []),
      { label: 'About Leafdeck', act: () => openApp('about') },
      appUpdate?.state === 'ready'
        ? { label: `Restart to Update (${appUpdate.latest})`, act: () => shell.appUpdate('install') }
        : shell?.appUpdate && { label: appUpdate?.state === 'downloading' ? `Downloading Update… ${appUpdate.percent || 0}%` : 'Check for Updates…', act: checkForAppUpdate },
      '-',
      { label: 'Settings…', act: () => openApp('settings') },
      { label: 'Import Browser Data…', act: openImport },
      { label: 'Reload', key: 'F5', act: () => location.reload() },
      shell && { label: 'Toggle Full Screen', key: 'F11', act: () => shell.windowAction('fullscreen') },
      '-',
      { label: 'Minimize All Windows', act: minimizeAll, disabled: !wins.size },
      { label: 'Close All Windows', act: closeAll, disabled: !wins.size },
      shell && '-',
      shell && { label: 'Quit Leafdeck', act: () => shell.windowAction('close') },
    ],
    file: () => [
      shell && { label: os ? 'New Browser Window' : 'New Window', key: 'Ctrl+N', act: () => openWebPage('') },
      shell && { label: 'New Burner Window', key: 'Ctrl+Shift+N', act: () => openBurnerWindow('') },
      shell && '-',
      w?.app.create && { label: `New ${w.app.newLabel || 'Item'}`, act: () => w.app.create(w, {}) },
      w?.app.create && '-',
      ...NEW.map((col) => ({ label: `New ${schemas[col].label}`, act: () => openApp(schemas[col].app, { create: {} }) })),
      shell && '-',
      shell && { label: 'Print…', key: 'Ctrl+P', disabled: !printable(w), act: () => printWindow(w) },
      os && '-',
      os && { label: 'Take Screenshot', key: 'Print Screen', act: () => setTimeout(() => shell.os.snip(), 250) }, // once the menu is gone
      os && { label: 'Import Browser Data…', act: openImport },
    ],
    view: () => [
      { label: 'Morning Briefing', act: () => import('./briefing.js').then((b) => b.openBriefing()) },
      '-',
      { label: 'Widgets', checked: !p.hideWidgets, act: () => store.setPrefs({ hideWidgets: !p.hideWidgets }) },
      { label: 'Desktop Icons', checked: !p.hideIcons, act: () => store.setPrefs({ hideIcons: !p.hideIcons }) },
      os && navigator.maxTouchPoints > 0 && { label: 'On-Screen Keyboard', checked: keyboardOpen(), act: toggleKeyboard },
      os && { label: 'Show Touches', checked: touchesShown(), act: toggleTouches },
    ],
    go: () => [
      { label: 'All Apps', key: os ? 'Win' : '', act: toggleAppScreen },
      '-',
      // Your folders first, the way a file manager's Go menu works, then the apps.
      ...(places ? [
        ...places.folders.map((f) => ({ label: f.name, act: () => openApp('files', { reveal: f.path }) })),
        { label: places.computer.name, act: () => openApp('files', { reveal: places.computer.path }) },
        '-',
        { header: 'Apps' },
      ] : []),
      ...[...registry.values()].filter((a) => !a.hidden).sort((a, b) => (os ? a.name.localeCompare(b.name) : 0)).map((a) => ({ label: a.name, act: () => openApp(a.id) })),
      store.all('links').length && '-',
      ...store.all('links').map((l) => ({ label: l.name, act: () => openApp(linkAppId(l)) })),
    ],
    window: () => [
      { label: 'Show All Windows', key: 'F3', act: toggleOverview },
      { label: 'Focus Session…', key: 'F4', act: openFocusSetup },
      '-',
      { label: 'Save Windows as Layout…', act: () => openApp('layouts', { create: {} }) },
      { label: 'Layouts…', act: () => openApp('layouts') },
      ...layoutMenuItems(),
      layoutMenuItems().length ? null : '-',
      { label: 'Minimize', disabled: !w, act: () => minimize(w) },
      { label: 'Maximize', disabled: !w, act: () => toggleMax(w) },
      { label: 'Close Window', disabled: !w, act: () => closeWindow(w) },
      '-',
      { label: 'Keep on Top', checked: !!w?.pinned, disabled: !w, act: () => togglePinned(w) },
      { label: 'Mini Window', key: 'Alt+Shift+↓', checked: !!w?.mini, disabled: !w, act: () => toggleMini(w) },
      { label: 'Snap Left', key: 'Alt+Shift+←', disabled: !w, act: () => snapTo(w, 'left') },
      { label: 'Snap Right', key: 'Alt+Shift+→', disabled: !w, act: () => snapTo(w, 'right') },
      '-',
      ...schemeMenuItems(w),
      '-',
      w?.pair
        ? { label: `Unpair from ${wins.get(w.pair)?.app.name || 'window'}`, act: () => unpair(w) }
        : { header: 'Pair with (this window on the left)' },
      ...(w && !w.pair ? [...wins.values()].filter((x) => x !== w).slice(0, 8).map((x) => ({ label: x.app.name, act: () => pair(w, x) })) : []),
      '-',
      { label: 'Minimize All', disabled: !wins.size, act: minimizeAll },
      { label: 'Close All', disabled: !wins.size, act: closeAll },
      '-',
      ...otherTabsMenuItems(),
      wins.size && '-',
      ...[...wins.values()].map((x) => ({ label: x.app.name, checked: x === w, act: () => openApp(x.id) })),
    ],
  };
}

const barHtml = (main) => `<div class="mb-bg"></div>
    <div class="mb-left">
      <button class="mb-item mb-logo" data-menu="logo" aria-label="Leafdeck menu" title="Leafdeck"><img src="/img/leafdeck-logo.svg" alt="Leafdeck" draggable="false"></button>
      <button class="mb-item" data-menu="file">File</button>
      <button class="mb-item" data-menu="view">View</button>
      <button class="mb-item" data-menu="go">Go</button>
      <button class="mb-item" data-menu="window">Window</button>
    </div>
    <div class="mb-right">
      <span class="mb-mcp" hidden title="Claude Code is working in Leafdeck right now (Settings → Claude)"><i class="mb-dot"></i>Claude Code</span>
      <span class="mb-sync" role="status"></span>
      <span class="mb-clock"></span>
      ${shell && main ? `<div class="mb-winctl">
        <button data-shell="minimize" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg></button>
        <button data-shell="toggle-maximize" title="Maximize" aria-label="Maximize"><svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5"/></svg></button>
        <button data-shell="close" title="Quit" aria-label="Quit"><svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg></button>
      </div>` : shell ? '<div class="mb-winctl"></div>' : ''}
    </div>`;

// Every menu bar: the main one (#menubar) and other screens' own (.menubar-extra, Settings → Displays → Menu bar).
const bars = () => $$('#menubar, .menubar-extra');
let mcpActive = false;
let trayModule = null; // ostray.js, in the Leafdeck OS session

/** Both sides of a bar are as wide as the fuller one, so its search stays centered and fills the space between, up to
 * --search-max: past that the sides grow instead. Sets --mb-side on `target` (the root for the main bar: #search is
 * outside it; another screen's bar holds its own search). */
function fitBar(mb, target) {
  const left = $('.mb-left', mb);
  const right = $('.mb-right', mb);
  const fit = () => {
    const css = getComputedStyle(document.documentElement);
    const max = parseFloat(css.getPropertyValue('--search-max')) || Infinity;
    const notch = parseFloat(css.getPropertyValue('--mb-notch')) || 0;
    const side = Math.max(left.offsetLeft + left.offsetWidth + 12, mb.clientWidth - right.offsetLeft + 12, (mb.clientWidth - max) / 2 - notch);
    target.style.setProperty('--mb-side', `${Math.ceil(side)}px`);
  };
  const fits = new ResizeObserver(fit);
  for (const x of [mb, left, right]) fits.observe(x);
}

/** The menus and status of one menu bar. */
function wireBar(mb) {
  const open = (btn) => {
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, menus()[btn.dataset.menu](), { owner: btn });
  };
  mb.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    if (menuOwner() === btn) closeMenu();
    else open(btn);
  });
  mb.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('[data-menu]');
    const owner = menuOwner();
    if (btn && owner && owner !== btn && owner.closest('#menubar, .menubar-extra') === mb) open(btn);
  });
  $('.mb-mcp', mb).hidden = !mcpActive;
}

/** A menu bar for each screen that has one of its own (wm.js barScreens), along its top edge. */
function placeBars() {
  const all = screens();
  const want = barScreens();
  for (const b of $$('.menubar-extra')) if (!want.includes(Number(b.dataset.screen))) b.remove();
  let added = false;
  for (const n of want) {
    let mb = $(`.menubar-extra[data-screen="${n}"]`);
    if (!mb) {
      mb = document.createElement('header');
      mb.className = 'menubar-extra';
      mb.dataset.screen = n;
      mb.innerHTML = barHtml(false);
      const search = document.createElement('div');
      search.className = 'mb-search';
      mb.append(search);
      $('#menubar').after(mb);
      wireBar(mb);
      addSearch(search);
      fitBar(mb, mb);
      const ctl = $('.mb-winctl', mb);
      if (ctl && trayModule) trayModule.addTray(ctl);
      added = true;
    }
    const s = all[n];
    Object.assign(mb.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px` });
    // Its search's results are sized to this screen (they go by the main screen's size otherwise).
    mb.style.setProperty('--main-w', `${s.w}px`);
    mb.style.setProperty('--main-h', `${s.h}px`);
  }
  if (added) {
    drawSync();
    tick();
  }
}

function drawSync(e) {
  const s = store.status;
  const labels = { saved: 'All changes saved', saving: 'Saving…', error: 'Sync error', local: 'Saved in this browser only', idle: '' };
  for (const sync of $$('.mb-sync')) {
    sync.className = `mb-sync s-${s}`;
    sync.title = (labels[s] || '') + (e?.detail?.message ? ` — ${e.detail.message}` : '');
    sync.innerHTML = `<i></i><span>${s === 'error' ? 'Sync error' : s === 'local' ? 'Local' : ''}</span>`;
  }
}

const clockShown = new WeakMap(); // per menu bar's clock: what it's showing

function tick() {
  const d = new Date();
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = `<span class="mb-date">${date}</span>${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  const title = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  for (const mb of bars()) {
    const clock = $('.mb-clock', mb);
    // Only when the minute changes: rewriting the same text still repaints it, and one surface spans every screen, so a
    // clock on each menu bar makes Chromium redraw the box around them all (public/js/steady.js).
    if (clockShown.get(clock) !== time) {
      clockShown.set(clock, time);
      clock.innerHTML = time;
      clock.title = title;
    }
  }
}

export function initMenubar() {
  const mb = $('#menubar');
  mb.innerHTML = barHtml(true);
  fitBar(mb, document.documentElement);
  mb.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shell]');
    if (b) shell.windowAction(b.dataset.shell);
  });
  // Leafdeck OS session: there's no window to minimize or close, only a session to leave.
  shell?.info?.().then((info) => {
    if (!info?.session) return;
    document.documentElement.dataset.session = '1';
    const ctl = mb.querySelector('.mb-winctl');
    if (ctl) {
      ctl.innerHTML = '';
      import('./ostray.js').then((m) => {
        trayModule = m;
        m.initOsTray(ctl);
        for (const x of $$('.menubar-extra .mb-winctl')) m.addTray(x);
      });
    }
  });
  wireBar(mb);
  addEventListener('screens', placeBars);

  // Shown only while an agent is working in Leafdeck (a tool call is running, or just finished).
  shell?.on?.('shell:mcp', ({ active }) => {
    mcpActive = !!active;
    for (const el of $$('.mb-mcp')) el.hidden = !mcpActive;
  });
  store.addEventListener('status', drawSync);
  setInterval(tick, 1000);

  drawSync();
  tick();
}
