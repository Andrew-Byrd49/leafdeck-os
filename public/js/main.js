import { store } from './store.js';
import { $, frame } from './util.js';
import { openApp, initDock, renderDock, restoreSession, screensSettled, toast, setDockScale, setDockScreen, setDesktopPlaces, setExtraBars, screens, adoptScreen } from './wm.js';
import './apps/business.js';
import './apps/tasks.js';
import './apps/calendar.js';
import './apps/notes.js';
import { ACCENTS } from './apps/system.js';
import { initDesktop, renderIcons } from './desktop.js';
import { initMenubar } from './menubar.js';
import { initWidgets, enterWidgetEdit, openWidgetGallery, resetWidgetArrangement, widgetsArranged } from './widgets.js';
import { initSearch } from './search.js';
import { shell } from './shell.js';
import { prunePages, setRestoring } from './apps/browser.js';
import './apps/taskmanager.js';
import { initDownloadIndicator } from './apps/downloads.js';
import './apps/history.js';
import './apps/bookmarks.js';
import './apps/passwords.js';
import { schemas } from './schemas.js';
import { initIntegrations } from './integrations.js';
import { initFocus } from './focus.js';
import { initMeetings } from './meetings.js';
import './layouts.js';
import { initDevices } from './devices.js';
import { initReminders } from './reminders.js';
import { initUserApps } from './userapps.js';
import { initNativeWindows } from './nativewin.js';
import { initBriefing } from './briefing.js';
import { initAssistant } from './assistant.js';
import './pageui.js';
import './steady.js';
import './switcher.js';
import './printui.js';
import './osdialogs.js';
import './apps/appbuilder.js';
import './apps/terminal.js';
import './apps/claudecode.js';
import './apps/claudesettings.js';
import './apps/files.js';
import './apps/viewer.js';
import './apps/imageeditor.js';
import './apps/editor.js';
import './apps/devtools.js';
import './apps/appdisplay.js';
import './apps/store.js';
import './apps/designer.js';
import './apps/siteeditor.js';
import { isScreenPage, refreshInfo, perScreen, screensInfo, SCREEN } from './screens.js';

// Built-in wallpapers that were replaced: anyone still on one gets its successor.
const RETIRED_WALLPAPERS = {
  '/wallpapers/ridge.jpg': '/wallpapers/peaks.jpg',
  '/wallpapers/fern.jpg': '/wallpapers/pines.jpg',
  '/wallpapers/hills.jpg': '/wallpapers/meadow.jpg',
};

/** 'dark' (the default), 'light' or 'system'. Sites in the desktop app follow it too, once it's been chosen. */
let sentTheme;
function applyTheme(theme) {
  const t = ['light', 'system'].includes(theme) ? theme : 'dark';
  if (t === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('ws:theme', t); // read by theme.js on the next start
  } catch {}
  if (theme && theme !== sentTheme) {
    sentTheme = theme;
    shell?.setTheme?.(theme);
  }
}

/** Settings → Appearance → Accent color: a named one, or a custom '#rrggbb'. Text on a dark custom accent turns white. */
function applyAccent(accent) {
  const root = document.documentElement.style;
  const custom = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : '';
  root.setProperty('--accent', ACCENTS[accent] || custom || ACCENTS.green);
  if (!custom) return root.removeProperty('--accent-ink');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(custom.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  root.setProperty('--accent-ink', 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18 ? '#ffffff' : '#07130c');
}

function applyPrefs() {
  const p = store.prefs;
  if (RETIRED_WALLPAPERS[p.wallpaper]) setTimeout(() => store.setPrefs({ wallpaper: RETIRED_WALLPAPERS[p.wallpaper] }), 0);
  applyAccent(p.accent);
  applyTheme(p.theme);
  let wall = '/wallpaper.jpg';
  try {
    wall = localStorage.getItem('ws:wallpaper') || RETIRED_WALLPAPERS[p.wallpaper] || p.wallpaper || wall;
  } catch {}
  showWallpaper(wall);
  document.title = 'Leafdeck';
  $('#icons').hidden = !!p.hideIcons;
  // Settings → Desktop: icon size and spacing, Dock size and where it sits.
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const root = document.documentElement;
  root.style.setProperty('--icon-scale', num(p.iconScale, 0.6, 1.6, 1));
  root.style.setProperty('--icon-gap', `${num(p.iconSpacing, 0, 40, 4)}px`);
  root.style.setProperty('--dock-scale', num(p.dockScale, 0.6, 1.5, 1));
  root.style.setProperty('--term-opacity', num(p.termOpacity, 0.3, 1, 1)); // Settings → Appearance → Terminal background
  root.toggleAttribute('data-term-blur', !!p.termBlur && num(p.termOpacity, 0.3, 1, 1) < 1); // …and the blur behind it
  root.dataset.dock = ['left', 'right'].includes(p.dockPosition) ? p.dockPosition : 'center';
  setDockScale(num(p.dockScale, 0.6, 1.5, 1));
  setDockScreen(p.dockScreen);
  setExtraBars({ bars: p.barScreens, docks: p.dockScreens }); // Settings → Displays: a menu bar, a Dock on other screens too
  setDesktopPlaces({ widgets: { screen: p.widgetsScreen, side: p.widgetsSide }, icons: { screen: p.iconsScreen, side: p.iconsSide } });
}

/** Where the wallpaper goes: across the whole page (one picture spanning every screen), or with Settings → Appearance →
    Wallpaper on several screens → Each screen, the whole picture on each screen. */
const wallRects = () => (store.prefs.wallpaperScreens === 'each' && screens().length > 1 ? screens() : null);
/** One surface per screen (screens.js), the picture across every screen: this page shows its part of it. The box of all
    the screens, in this page's pixels (it starts left of and above this screen by this screen's place). */
function wallSpan() {
  const info = screensInfo();
  if (!perScreen() || store.prefs.wallpaperScreens === 'each' || info.screens.length < 2) return null;
  const me = info.screens.find((s) => s.name === (SCREEN || info.main));
  if (!me) return null;
  return { x: -me.x, y: -me.y, w: Math.max(...info.screens.map((s) => s.x + s.w)), h: Math.max(...info.screens.map((s) => s.y + s.h)) };
}
let wallShown = '';
function showWallpaper(wall) {
  const rects = wallRects();
  const span = wallSpan();
  const key = JSON.stringify([wall, rects, span]);
  if (key === wallShown) return;
  wallShown = key;
  const el = $('#wallpaper');
  const url = `url(${JSON.stringify(wall)})`;
  Object.assign(el.style, span ? { inset: 'auto', left: `${span.x}px`, top: `${span.y}px`, width: `${span.w}px`, height: `${span.h}px` } : { inset: '', left: '', top: '', width: '', height: '' });
  el.classList.toggle('per-screen', !!rects);
  el.style.backgroundImage = rects ? 'none' : url;
  el.replaceChildren(
    ...(rects || []).map((r) => {
      const d = document.createElement('div');
      d.className = 'wall-screen';
      Object.assign(d.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, backgroundImage: url });
      return d;
    }),
  );
  frostWallpaper(wall, rects, span);
}

/**
 * "Frosted glass" without live backdrop blur: blur the wallpaper once into a small image and expose it
 * as --wall-blur. Glass panels paint it as a screen-fixed background, so they look blurred for free
 * instead of re-blurring on every frame a window moves.
 */
let frostedFor = null;
function frostWallpaper(src, rects, span = null) {
  const key = JSON.stringify([src, rects, span]);
  if (frostedFor === key) return;
  frostedFor = key;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (frostedFor !== key) return;
    try {
      // Match "cover" cropping at the screen's aspect ratio, at low resolution (blur hides it).
      // A hidden/not-yet-laid-out page can report a 0×0 viewport; fall back to the screen's shape.
      const vw = innerWidth || screen.width || 16;
      const vh = innerHeight || screen.height || 9;
      const w = 400;
      const h = Math.max(1, Math.round((w * vh) / vw));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.filter = 'blur(6px) saturate(150%)';
      // Overdraw past the edges so the blur doesn't fade to transparent at the borders.
      const cover = (x, y, bw, bh) => {
        const s = Math.max(bw / img.width, bh / img.height);
        const dw = img.width * s;
        const dh = img.height * s;
        ctx.drawImage(img, x + (bw - dw) / 2 - 12, y + (bh - dh) / 2 - 12, dw + 24, dh + 24);
      };
      const k = w / vw;
      if (span) cover(span.x * k, span.y * k, span.w * k, span.h * k); // this screen's part of the picture across them all
      else if (!rects) cover(0, 0, w, h);
      else
        for (const r of rects) {
          // Each screen's own copy, clipped to it, so the panels' glass matches the picture behind them.
          const [x, y, rw, rh] = [(r.x * w) / vw, (r.y * h) / vh, (r.w * w) / vw, (r.h * h) / vh];
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, rw, rh);
          ctx.clip();
          cover(x, y, rw, rh);
          ctx.restore();
        }
      c.toBlob((blob) => {
        if (!blob || frostedFor !== key) return;
        document.documentElement.style.setProperty('--wall-blur', `url(${URL.createObjectURL(blob)})`);
        document.body.classList.add('frosted');
      }, 'image/jpeg', 0.85);
    } catch {
      // Cross-origin wallpaper without CORS: canvas is tainted, keep live blur instead.
      document.body.classList.remove('frosted');
    }
  };
  img.onerror = () => document.body.classList.remove('frosted');
  img.src = src;
}

/* ---------------- Desktop menu ---------------- */

const desktopMenu = (at) => {
  const p = store.prefs;
  return [
    ...['tasks', 'notes', 'contacts', 'events'].map((col) => ({ label: `New ${schemas[col].label}`, act: () => openApp(schemas[col].app, { create: {} }) })),
    '-',
    { label: 'Add Connection…', act: () => openApp('connections', { create: {} }) },
    { label: 'Change Wallpaper…', act: () => openApp('settings') },
    '-',
    { label: 'Edit Widgets', act: enterWidgetEdit },
    { label: 'Add Widget…', act: () => openWidgetGallery('desktop', at) },
    { label: 'Reset Widget Arrangement', disabled: !widgetsArranged(), act: resetWidgetArrangement },
    { label: 'Show Widgets', checked: !p.hideWidgets, act: () => store.setPrefs({ hideWidgets: !p.hideWidgets }) },
  ];
};

/* ---------------- Boot ---------------- */

// Broken images: logo tiles fall back to their letter; favicons just hide. (No inline onerror — the app's CSP forbids it.)
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img?.tagName !== 'IMG') return;
    if (img.parentNode?.classList?.contains('ai-logo')) img.parentNode.classList.add('ai-noimg');
    else if (img.classList.contains('fav')) img.style.visibility = 'hidden';
  },
  true,
);

async function boot() {
  if (shell) {
    document.body.classList.add('is-electron');
  }
  // Leafdeck OS, one surface per screen: which screen this page is, before anything is put on one (screens.js).
  if (shell) await refreshInfo();
  await store.load();
  if (shell && store.mode === 'local' && !isScreenPage) {
    setTimeout(() => toast(`Couldn’t open Leafdeck’s data (${store.loadError || 'no answer'}) — changes are kept in this window only for now.`, 'error'), 800);
  }
  applyPrefs();
  // Server-side messages (e.g. “saved, but Google Calendar wasn’t updated”).
  store.addEventListener('notice', (e) => toast(e.detail.message, e.detail.kind));
  // A screen's own page (one surface per screen) shows that screen's windows, and its menu bar, Dock, widgets and icons
  // when they're on it; what Leafdeck does once (syncing, reminders, the briefing, Claude) is the main page's.
  if (!isScreenPage) initIntegrations();
  initMenubar();
  initDownloadIndicator();
  initDock();
  renderDock();
  // Leafdeck OS safe mode (safemode.js): no saved windows, no welcome, no briefing; a banner, and Claude with the report.
  const info = shell ? await shell.info().catch(() => null) : null;
  const safe = !!info?.safe;
  if (safe) document.documentElement.dataset.safe = '1';
  if (!isScreenPage) initAssistant({ safe });
  initDesktop({ desktopMenu });
  renderIcons();
  initWidgets();
  initSearch();

  const refresh = frame(() => {
    applyPrefs();
    renderDock();
    renderIcons();
  });
  store.addEventListener('change', (e) => ['*', 'settings', 'links'].includes(e.detail.col) && refresh());
  // Screens added, removed or rearranged: the wallpaper follows them (when it's on each screen).
  addEventListener('screens', () => applyPrefs());
  addEventListener('screens-info', () => applyPrefs()); // one surface per screen: where this screen is among them
  // Re-crop the frosted wallpaper if the screen's aspect ratio changes.
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      frostedFor = null;
      wallShown = '';
      applyPrefs();
    }, 400);
  });

  await screensSettled(); // Leafdeck OS: the window covers every screen before windows reopen where they were
  setRestoring(true); // reopened site windows start asleep; the front one wakes right away
  if (!safe) restoreSession(info?.bootId);
  setRestoring(false);
  initUserApps();
  if (isScreenPage) {
    document.body.classList.add('ready');
    return;
  }
  initFocus();
  initMeetings();
  initDevices();
  initReminders();
  initNativeWindows();
  if (!safe) initBriefing();
  if (shell) prunePages();
  if (!store.prefs.onboarded && !safe) openApp('welcome');
  if (safe) import('./safemode.js').then((m) => m.initSafeMode());
  // A screen's page closed (unplugged, or it's the main screen now): its windows come here.
  shell?.on?.('screens:adopt', ({ screen } = {}) => typeof screen === 'string' && adoptScreen(screen));
  shell?.ready(); // the app can now hand over links (e.g. from Windows as the default browser)
  document.body.classList.add('ready');
}

boot();

addEventListener('keydown', (e) => {
  if (window.desktopShell || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'F3') {
    e.preventDefault();
    import('./overview.js').then((m) => m.toggleOverview());
  } else if (e.key === 'F4') {
    e.preventDefault();
    import('./focus.js').then((m) => m.openFocusSetup());
  } else if (e.altKey && e.shiftKey && e.key.startsWith('Arrow')) {
    e.preventDefault();
    import('./apps/browser.js').then((m) => m.runShortcut('snap-' + e.key.slice(5).toLowerCase()));
  }
});
