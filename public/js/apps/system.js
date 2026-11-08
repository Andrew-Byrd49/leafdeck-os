import { store } from '../store.js';
import { esc, $, $$, download, today } from '../util.js';
import { icon, appIcon } from '../icons.js';
import { registerApp, addResolver, openApp, toast, getApp, refreshAppIcon, setBadge, badgeFromTitle, screens } from '../wm.js';
import { confirmDialog } from '../dialogs.js';
import { editRecord } from '../schemas.js';
import { collectionApp } from './collection.js';
import { sampleData } from '../sample.js';
import { shell } from '../shell.js';
import { mountWeb, SHARED_PARTITION, ENGINES, refreshSaverSettings, openSessionWindow } from './browser.js';
import { openClearDataSheet } from './history.js';
import { manageCalendars } from './calendar.js';
import { enterWidgetEdit, openWidgetGallery, resetWidgetArrangement } from '../widgets.js';
import { openImportSheet } from './bookmarks.js';
import { mountDisplays } from '../displays.js';
import { mountPower } from '../power.js';
import { mountMouse } from '../mouse.js';
import { mountBackup } from '../backup.js';
import { pickColor } from '../colorpicker.js';
import { openExportSheet, openImportMoveSheet } from '../move.js';

/* ---------------- Connections ---------------- */

const PRESETS = [
  ['Gmail', 'https://mail.google.com', 'red', 'M', 'Email'],
  ['Google Drive', 'https://drive.google.com', 'yellow', 'D', 'Files'],
  ['Google Calendar', 'https://calendar.google.com', 'blue', '31', 'Calendar'],
  ['Google Docs', 'https://docs.google.com/document', 'blue', 'D', 'Docs'],
  ['Google Sheets', 'https://docs.google.com/spreadsheets', 'green', 'S', 'Docs'],
  ['Google Meet', 'https://meet.google.com', 'green', 'M', 'Meetings'],
  ['Stripe', 'https://dashboard.stripe.com', 'indigo', 'S', 'Finance'],
  ['QuickBooks', 'https://app.qbo.intuit.com', 'green', 'qb', 'Finance'],
  ['Canva', 'https://www.canva.com', 'teal', 'Ca', 'Design'],
  ['Notion', 'https://www.notion.so', 'graphite', 'N', 'Docs'],
  ['GitHub', 'https://github.com', 'graphite', 'GH', 'Dev'],
  ['Cloudflare', 'https://dash.cloudflare.com', 'orange', 'C', 'Dev'],
  ['Slack', 'https://app.slack.com', 'purple', 'S', 'Chat'],
  ['Zoom', 'https://zoom.us/meeting', 'blue', 'Z', 'Meetings'],
  ['Mailchimp', 'https://admin.mailchimp.com', 'yellow', 'Mc', 'Marketing'],
];

const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export const linkAppId = (l) => 'link:' + l.id;

/* ---- Brand logos ----
   Official high-res icons where we know a stable URL; otherwise the site's own favicon
   via Google's favicon service (largest size available, up to 128px). */

/* Built-in wallpapers: [pref value ('' = the original), name, thumbnail]. */
const WALLPAPERS = [
  ['', 'Leaf', '/wallpapers/leaf-thumb.jpg'],
  ['/wallpapers/waves.jpg', 'Waves', '/wallpapers/waves-thumb.jpg'],
  ['/wallpapers/swimmer.jpg', 'Swimmer', '/wallpapers/swimmer-thumb.jpg'],
  ['/wallpapers/peaks.jpg', 'Peaks', '/wallpapers/peaks-thumb.jpg'],
  ['/wallpapers/pines.jpg', 'Pines', '/wallpapers/pines-thumb.jpg'],
  ['/wallpapers/kayak.jpg', 'Kayak', '/wallpapers/kayak-thumb.jpg'],
  ['/wallpapers/meadow.jpg', 'Meadow', '/wallpapers/meadow-thumb.jpg'],
  ['/wallpapers/swirl.jpg', 'Swirl', '/wallpapers/swirl-thumb.jpg'],
  ['/wallpapers/forest.jpg', 'Forest', '/wallpapers/forest-thumb.jpg'],
  ['/wallpapers/amber.jpg', 'Amber', '/wallpapers/amber-thumb.jpg'],
  ['/wallpapers/rain.jpg', 'Rain', '/wallpapers/rain-thumb.jpg'],
  ['/wallpapers/larches.jpg', 'Larches', '/wallpapers/larches-thumb.jpg'],
];
const hasCustomWallpaper = () => {
  try {
    return !!localStorage.getItem('ws:wallpaper');
  } catch {
    return false;
  }
};

const GOOGLE_PRODUCT = (name) => `https://www.gstatic.com/images/branding/product/2x/${name}_2020q4_48dp.png`;
const GOOGLE_HOSTS = {
  'mail.google.com': 'gmail',
  'drive.google.com': 'drive',
  'calendar.google.com': 'calendar',
  'meet.google.com': 'meet',
  'keep.google.com': 'keep',
  'chat.google.com': 'chat',
  'forms.google.com': 'forms',
  'admin.google.com': 'admin',
};
const GOOGLE_DOCS_PATHS = [['/spreadsheets', 'sheets'], ['/presentation', 'slides'], ['/forms', 'forms'], ['/document', 'docs']];
const KNOWN_LOGOS = {
  'github.com': 'https://github.githubassets.com/apple-touch-icon-180x180.png',
  'zoom.us': 'https://zoom.us/apple-touch-icon.png',
};
// App domains whose own favicon is tiny; use the product's main site instead.
const FAVICON_DOMAIN = { 'qbo.intuit.com': 'quickbooks.intuit.com' };
// Subdomains that are just the "app" part of a product; the favicon lives on the main domain.
const APP_PREFIX = /^(www|app|apps|dash|dashboard|admin|my|portal|account|accounts|login|us\d*)\./;

/**
 * A Connection's icon, best first: your own logo, the official Google product icon, a known webclip, the
 * site's own webclip (saved the first time you open it), then Google's favicon service.
 * `full`: the image is a finished square icon (a webclip) that should fill the tile.
 */
export function brandIcon(l) {
  if (l.noLogo) return { url: '' };
  if (l.logo) return { url: l.logo };
  let u;
  try {
    u = new URL(l.url);
  } catch {
    return { url: '' };
  }
  const h = u.hostname.toLowerCase();
  if (GOOGLE_HOSTS[h]) return { url: GOOGLE_PRODUCT(GOOGLE_HOSTS[h]) };
  if (h === 'docs.google.com') {
    const hit = GOOGLE_DOCS_PATHS.find(([p]) => u.pathname.startsWith(p));
    return { url: GOOGLE_PRODUCT(hit ? hit[1] : 'docs') };
  }
  const base = h.replace(APP_PREFIX, '');
  if (KNOWN_LOGOS[base]) return { url: KNOWN_LOGOS[base], full: true };
  if (l.touchIcon) return { url: l.touchIcon, full: true };
  return { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(FAVICON_DOMAIN[base] || base)}&sz=128` };
}
export const brandLogo = (l) => brandIcon(l).url;

/** Remember the icons a Connection's site reports (only for the Connection's own site, not pages it links to). */
function saveSiteIcons(l, { clip, fav }, pageUrl) {
  const site = (x) => {
    try {
      return new URL(x).hostname.replace(APP_PREFIX, '');
    } catch {
      return '';
    }
  };
  if (!site(pageUrl) || site(pageUrl) !== site(l.url)) return;
  const cur = store.get('links', l.id);
  if (!cur || ((cur.touchIcon || '') === clip && (cur.favIcon || '') === fav)) return;
  store.save('links', { ...cur, touchIcon: clip, favIcon: fav });
  refreshAppIcon(`link:${l.id}`);
}

addResolver((id) => {
  if (!id.startsWith('link:')) return null;
  const l = store.get('links', id.slice(5));
  if (!l) return null;
  return {
    id,
    name: l.name,
    glyph: l.glyph || (l.name || '?')[0].toUpperCase(),
    color: l.color || 'blue',
    logo: brandIcon(l).url,
    logoFull: !!brandIcon(l).full,
    smallLogo: l.logo ? '' : l.favIcon || '',
    size: 'browser',
    sizeKey: 'browser',
    isLink: true,
    // Extra sessions: the same connection signed in to other accounts. Each keeps its own logins.
    menuItems: () => {
      if (!shell) return [];
      const n = l.sessions || 1;
      const open = (i) => openSessionWindow(l.url, `persist:link-${l.id}-s${i}`, `Session ${i}`);
      return [
        '-',
        ...Array.from({ length: n - 1 }, (_, k) => ({ label: `Session ${k + 2}`, act: () => open(k + 2) })),
        {
          label: 'Open in New Session',
          act: () => {
            const cur = store.get('links', l.id) || l;
            const next = (cur.sessions || 1) + 1;
            store.save('links', { ...cur, sessions: next });
            open(next);
          },
        },
      ];
    },
    launch(opts) {
      if (shell || l.embed) return true;
      if (!opts.restore) window.open(l.url, '_blank', 'noopener');
      return false;
    },
    mount(win) {
      if (shell) {
        // Desktop app: a real browser view with persistent logins.
        let pageUrl = l.url;
        mountWeb(win, {
          url: l.url,
          partition: l.separateSession ? `persist:link-${l.id}` : SHARED_PARTITION,
          onUrl: (u) => (pageUrl = u),
          onTitle: (t) => setBadge(`link:${l.id}`, badgeFromTitle(t)),
          onIcons: (icons) => saveSiteIcons(l, icons, pageUrl),
        });
        return;
      }
      win.tools.innerHTML = `<span class="tb-url">${icon('globe', 12)} ${esc(host(l.url))}</span>
        <button class="tb-btn" data-reload title="Reload">${icon('refresh', 14)}</button>
        <button class="tb-btn" data-ext title="Open in a browser tab">${icon('external', 14)}</button>`;
      win.body.innerHTML = `<div class="embed"><iframe src="${esc(l.url)}" referrerpolicy="strict-origin-when-cross-origin"
          allow="clipboard-read; clipboard-write; fullscreen; camera; microphone"></iframe>
        <div class="embed-note">Page blank? Some sites refuse to load inside other apps.
          <button class="btn small" data-ext>${icon('external', 12)} Open in new tab</button></div></div>`;
      win.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-ext]')) window.open(l.url, '_blank', 'noopener');
        if (e.target.closest('[data-reload]')) $('iframe', win.body).src = l.url;
      });
    },
  };
});

/* Settings → Desktop → Dock and icons screen: listed when Leafdeck spans more than one screen (Leafdeck OS);
   "" is the main one. */
function fillDockScreens(root = document) {
  const all = screens();
  const builtIn = all.filter((s) => s.internal).length;
  const name = (s) => (s.internal ? (builtIn > 1 ? `Built-in screen (${s.name})` : 'Built-in screen') : s.name || 'Screen');
  for (const r of $$('[data-multi-screen-row]', root)) r.hidden = all.length < 2;
  for (const r of $$('[data-screen-row]', root)) {
    r.hidden = all.length < 2;
    const sel = $('select', r);
    const cur = getPath(store.prefs, sel.dataset.pref) || '';
    const opts = [['', `${name(all[0])} · main screen`], ...all.slice(1).map((s) => [s.name, name(s)])];
    if (cur && !opts.some(([v]) => v === cur)) opts.push([cur, `${cur} (not connected)`]);
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  }
}
addEventListener('screens', () => fillDockScreens());

registerApp(
  collectionApp({
    id: 'connections',
    name: 'Connections',
    icon: 'link',
    color: 'graphite',
    col: 'links',
    size: [900, 600],
    sort: (a, b) => (a.name || '').localeCompare(b.name || ''),
    summary: () =>
      `<div class="presets"><span class="muted">Quick add</span>${PRESETS.map(
        (p, i) => `<button class="chip-btn" data-preset="${i}">${esc(p[0])}</button>`,
      ).join('')}</div>`,
    onBodyClick: (e, win) => {
      const p = e.target.closest('[data-preset]');
      if (!p) return false;
      const [name, url, color, glyph, category] = PRESETS[p.dataset.preset];
      editRecord(win, 'links', null, { name, url, color, glyph, category });
      return true;
    },
    onClick: (e, r) => {
      if (!e.target.closest('[data-launch]')) return false;
      openApp(linkAppId(r));
      return true;
    },
    columns: [
      { l: 'App', v: (r) => `<div class="cell-person"><span class="mini-icon">${appIcon(getApp(linkAppId(r)) || { icon: 'globe', color: r.color })}</span><div class="cell-main"><b>${esc(r.name)}</b><small>${esc(host(r.url))}</small></div></div>` },
      { l: 'Category', v: (r) => (r.category ? `<span class="chip">${esc(r.category)}</span>` : '') },
      { l: 'Opens in', v: (r) => (shell || r.embed ? 'Desktop window' : 'Browser tab') },
      { l: '', v: () => `<button class="btn small" data-launch>${icon('external', 12)} Open</button>`, cls: 'num' },
    ],
  }),
);

/* ---------------- Settings ---------------- */

export const ACCENTS = {
  green: '#34c77b',
  blue: '#0a84ff',
  teal: '#40c8e0',
  purple: '#bf5af2',
  pink: '#ff375f',
  orange: '#ff9f0a',
  yellow: '#ffd60a',
  graphite: '#98989d',
};

const THEMES = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['system', 'Match computer'],
];

const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
function setPathPrefs(p, v) {
  const [k, sub] = p.split('.');
  if (sub) store.setPrefs({ [k]: { ...(store.prefs[k] || {}), [sub]: v } });
  else store.setPrefs({ [k]: v });
}

// The backup reminder's button (electron/backup.cjs) opens Settings → Backup.
shell?.on?.('backup:open', () => openApp('settings', { tab: 'backup' }));

const secretInput = (key, ph) =>
  `<div class="set-inline"><input type="password" data-secret="${key}" data-ph="${esc(ph)}" placeholder="${esc(ph)}" autocomplete="off"><button class="btn small" data-secret-save="${key}">Save</button></div>`;

const row = (label, control, hint = '') =>
  `<div class="set-row"><div><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="set-ctl">${control}</div></div>`;
const text = (path, ph = '', type = 'text') =>
  `<input type="${type}" data-pref="${path}" value="${esc(getPath(store.prefs, path) ?? '')}" placeholder="${esc(ph)}">`;
/** A slider that previews live (CSS variable `live`) and saves when let go. `px`: the value is pixels; else a scale (%). */
const sliderText = (v, px) => (px ? `${v} px` : `${Math.round(v * 100)}%`);
const slider = (path, min, max, step, dflt, live, px = false) => {
  const v = Number(store.prefs[path] ?? dflt);
  return `<div class="set-range"><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-pref="${path}" data-number data-live="${live}" ${px ? 'data-px' : ''}>
    <output>${sliderText(v, px)}</output></div>`;
};
/** Left or right (Settings → Desktop: icons). */
const sideSeg = (path, d) =>
  `<div class="set-seg">${[['left', 'Left'], ['right', 'Right']].map(([v, l]) => `<button data-side-pref="${path}" data-v="${v}" class="${(getPath(store.prefs, path) || d) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const toggle = (path, invert = false, checked) => {
  const v = checked ?? (invert ? !getPath(store.prefs, path) : !!getPath(store.prefs, path));
  return `<label class="switch"><input type="checkbox" data-pref="${path}" ${invert ? 'data-invert' : ''} ${v ? 'checked' : ''}><span></span></label>`;
};

/** Settings → Claude: Claude Code as the Claude button and the Claude Code app run it (electron/main.cjs, claudePrefs),
 * and Claude Code control for sessions you start in a terminal. */
const CLAUDE_ALLOWS = [
  ['commands', 'Run commands', 'Terminal commands on this computer'],
  ['act', 'Click, type and press keys', 'In any window: sites, apps and the desktop'],
  ['navigate', 'Go to web pages', 'Open an address in a window, or fetch a page to read'],
  ['close', 'Close windows', ''],
  ['script', 'Run scripts in windows', 'JavaScript in a site or app window'],
  ['apps', 'Create Leafdeck apps', 'New apps in App Builder'],
];
const CLAUDE_MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const CLAUDE_FRESH = [[0, 'Never'], [8, '8 hours'], [48, '48 hours'], [168, 'A week']];
/** Settings → Claude → Voice (Linux): talking to Claude with the Copilot key (electron/voice.cjs). Redrawn on its own
 * as a model downloads. */
function voiceRows(v) {
  const sw = (attrs, on) => `<label class="switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;
  const m = v.models[v.model];
  const modelState = m.ready
    ? `<span class="pill pill-green">Downloaded</span><button class="btn small" data-voice-remove title="Delete the model file">${icon('trash', 12)}</button>`
    : m.downloading != null
      ? `<span class="pill">Downloading… ${m.downloading}%</span>`
      : `<button class="btn small" data-voice-download>${icon('download', 12)} Download (${m.size})</button>`;
  return `${row('Copilot key', sw('data-voice="key"', v.key), 'Press it to talk to Claude: the Claude panel opens and listens, showing the words as it hears them; the same key again (or a pause) sends. The microphone button in the panel does the same.')}
    ${row('Speech recognition', v.installed ? '<span class="pill pill-green">Installed</span>' : `<div class="set-cmd"><code data-voice-install>${esc(v.install)}</code><div class="set-inline"><button class="btn small" data-voice-copy>Copy command</button><button class="btn small" data-voice-recheck>I’ve installed it</button></div></div>`, 'whisper.cpp turns your words into text on this computer. Nothing is sent anywhere for it.')}
    ${row('Speech model', `<div class="set-inline"><select data-voice="model">${Object.entries(v.models).map(([k, x]) => `<option value="${k}" ${v.model === k ? 'selected' : ''}>${esc(x.label)} · ${x.size}</option>`).join('')}</select>${modelState}</div>`, 'Downloaded once, into Leafdeck’s own folder. Base is quick; Small hears better.')}`;
}
function claudeSection(sd) {
  const mcpRows = `${row('Claude Code control', `<label class="switch"><input type="checkbox" data-mcp-enabled ${sd.mcp?.enabled ? 'checked' : ''}><span></span></label>`, 'Lets Claude Code see and operate Leafdeck — the desktop and every site window — through a local MCP server. Only this computer can connect, with the token below')}
    ${sd.mcp?.enabled ? row('Connect Claude Code', `<div class="set-cmd"><code data-mcp-cmd>${esc(sd.mcp.command)}</code><div class="set-inline"><button class="btn small" data-mcp-copy>Copy command</button><button class="btn small" data-mcp-regen>New token</button></div></div>`, `Run it once in a terminal, then Claude Code has the Leafdeck tools in every session${sd.mcp.connected ? ` · ${sd.mcp.connected} connected now` : ''}`) : ''}`;
  const c = sd.claude;
  if (!c) return `<section><h3>${icon('globe', 14)} Leafdeck app</h3><div class="set-group">${mcpRows}</div></section>`;
  const sw = (attrs, on) => `<label class="switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;
  return `<section><h3>${icon('claude', 14)} Claude</h3><div class="set-group">
      ${row('Claude Code', c.installed ? '<span class="pill pill-green">Installed</span>' : `<button class="btn small" data-claude-install>${icon('download', 12)} Install Claude Code</button>`, 'The Claude button at the bottom left and the Claude Code app run Claude Code on this computer, with your Claude subscription. These settings apply to both; App Builder and Designer chats have their own setup.')}
      ${row('Model', `<select data-claude="model">${CLAUDE_MODELS.map(([v, l]) => `<option value="${v}" ${c.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'Default is whatever Claude Code is set to')}
      ${row('About you', `<textarea data-claude="instructions" rows="3" placeholder="Who you are, what you work on, how you like answers…">${esc(c.instructions)}</textarea>`, 'Claude reads this at the start of every conversation')}
      ${row('Claude Settings', `<button class="btn small" data-claude-settings>${icon('sliders', 12)} Open</button>`, 'Your instructions, what Claude remembers, skills, permissions and hooks, all in one app, with a prompt to have Claude change them.')}
      ${row('Start fresh after', `<select data-claude="fresh">${CLAUDE_FRESH.map(([v, l]) => `<option value="${v}" ${c.fresh === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'Without a message for this long, the Claude button starts a new conversation. What Claude remembers about you stays.')}
    </div>
    ${sd.voice?.supported ? `<h4 class="set-sub">Voice</h4><div class="set-group" data-voice-group>${voiceRows(sd.voice)}</div>` : ''}
    <h4 class="set-sub">Permissions</h4><div class="set-group">
      ${row('Before Claude acts', `<select data-claude="ask"><option value="1" ${c.ask ? 'selected' : ''}>Ask me first</option><option value="0" ${c.ask ? '' : 'selected'}>Never ask</option></select>`, 'Looking around (reading windows, screenshots, your records, searching the web) never asks. Everything else does, except what you allow below.')}
      <div data-claude-allows ${c.ask ? '' : 'hidden'}>
        ${row('Edit files', sw('data-claude="edits"', c.edits), 'Create and change files without asking')}
        ${CLAUDE_ALLOWS.map(([k, label, hint]) => row(label, sw(`data-claude-allow="${k}"`, c.allow.includes(k)), hint)).join('')}
      </div>
    </div>
    <h4 class="set-sub">Claude Code in a terminal</h4><div class="set-group">${mcpRows}</div></section>`;
}

registerApp({
  id: 'settings',
  name: 'Settings',
  icon: 'sliders',
  color: 'gray',
  size: [920, 680],
  min: [560, 400],
  openTab(win, tab) {
    win.setPage?.(String(tab));
  },
  mount(win) {
    // One page per section, chosen in the sidebar (built from the sections' headings, so it always matches them).
    let page = '';
    const showPage = () => {
      const sections = $$('.settings > section', win.body);
      sections.forEach((sec) => (sec.dataset.page ||= sec.querySelector('h3')?.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')));
      if (!sections.length) return; // not drawn yet; the page asked for shows once it is
      if (!sections.some((sec) => sec.dataset.page === page)) page = sections[0].dataset.page;
      sections.forEach((sec) => (sec.hidden = sec.dataset.page !== page));
      $('.set-nav', win.body).innerHTML = sections
        .map((sec) => `<button class="set-nav-item${sec.dataset.page === page ? ' on' : ''}" data-set-page="${esc(sec.dataset.page)}">${sec.querySelector('h3').innerHTML}</button>`)
        .join('');
      const host = $('[data-displays]', win.body);
      if (host && page === 'displays') mountDisplays(host);
      const power = $('[data-power]', win.body);
      if (power && page === 'power') mountPower(power);
      const mouse = $('[data-mouse]', win.body);
      if (mouse && page === 'mouse') mountMouse(mouse);
      const backup = $('[data-backup]', win.body);
      if (backup && page === 'backup') mountBackup(backup, win);
    };
    win.setPage = (p) => {
      page = p;
      showPage();
    };
    // Sliders preview as they move (the setting is saved when you let go).
    win.body.addEventListener('input', (e) => {
      const t = e.target.closest('input[type="range"][data-live]');
      if (!t) return;
      const px = t.hasAttribute('data-px');
      document.documentElement.style.setProperty(t.dataset.live, t.value + (px ? 'px' : ''));
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = sliderText(Number(t.value), px);
      if (t.dataset.pref === 'termOpacity') {
        // The blur only matters below 100%; preview it with the slider.
        $('[data-term-blur-row]', win.body).hidden = Number(t.value) >= 1;
        document.documentElement.toggleAttribute('data-term-blur', !!store.prefs.termBlur && Number(t.value) < 1);
      }
    });
    win.body.addEventListener('click', (e) => {
      const side = e.target.closest('[data-side-pref]');
      if (side) {
        store.setPrefs({ [side.dataset.sidePref]: side.dataset.v });
        $$(`[data-side-pref="${side.dataset.sidePref}"]`, win.body).forEach((x) => x.classList.toggle('on', x === side));
        return;
      }
      const ws = e.target.closest('[data-wall-screens]');
      if (ws) {
        store.setPrefs({ wallpaperScreens: ws.dataset.wallScreens });
        $$('[data-wall-screens]', win.body).forEach((x) => x.classList.toggle('on', x === ws));
        return;
      }
      const d = e.target.closest('[data-dock-pos]');
      if (d) {
        store.setPrefs({ dockPosition: d.dataset.dockPos });
        $$('[data-dock-pos]', win.body).forEach((x) => x.classList.toggle('on', x === d));
        return;
      }
      const b = e.target.closest('[data-set-page]');
      if (!b) return;
      page = b.dataset.setPage;
      showPage();
      $('.settings', win.body).scrollTop = 0;
    });

    // sd: data from the desktop app (null in the web version), fetched before drawing.
    const draw = (sd = null) => {
      const p = store.prefs;
      win.body.innerHTML = `<div class="set-shell"><nav class="set-nav" aria-label="Settings"></nav><div class="settings">
        <section><h3>${icon('user', 14)} General</h3><div class="set-group">
          ${row('Your name', text('userName', 'Used in greetings'))}
        </div></section>

        <section><h3>${icon('sparkle', 14)} Appearance</h3><div class="set-group">
          ${row('Theme', `<div class="seg">${THEMES.map(([k, label]) => `<button class="${(p.theme || 'dark') === k ? 'on' : ''}" data-theme-pick="${k}">${label}</button>`).join('')}</div>`, shell ? 'Websites follow it too' : '')}
          ${row('Accent color', `<div class="accent-pick">${Object.entries(ACCENTS)
            .map(([k, c]) => `<button class="accent-dot ${(p.accent || 'green') === k ? 'on' : ''}" data-accent="${k}" style="--c:${c}" title="${k}"></button>`)
            .join('')}${(() => {
              const custom = /^#[0-9a-f]{6}$/i.test(p.accent || '') ? p.accent : '';
              return `<button class="accent-dot accent-custom ${custom ? 'on' : ''}" data-accent-custom="${custom}" ${custom ? `style="--c:${custom}"` : ''} title="Custom color…" aria-label="Custom color"></button>`;
            })()}</div>`)}
          <div class="set-row set-row-stack"><div><span>Wallpaper</span><small>Pick one, or use your own below</small></div>
            <div class="wall-grid">${WALLPAPERS.map(([value, name, thumb]) => `<button class="wall-tile ${!hasCustomWallpaper() && (p.wallpaper || '') === value ? 'on' : ''}" data-wall="${esc(value)}" title="${esc(name)}" style="--thumb:url('${thumb}')"><span>${esc(name)}</span></button>`).join('')}</div></div>
          ${row('Custom wallpaper', `<div class="set-inline">
              <input type="url" data-pref="wallpaper" value="${esc(WALLPAPERS.some(([v]) => v === (p.wallpaper || '')) ? '' : p.wallpaper || '')}" placeholder="Image URL (blank = default)">
              <label class="btn small">${icon('upload', 12)} Upload<input type="file" accept="image/*" data-wall-file hidden></label>
              <button class="btn small" data-wall-reset>Reset</button></div>`, 'Uploaded images are saved in this browser only')}
          <div class="set-row" data-multi-screen-row hidden><div><span>Wallpaper on several screens</span><small>One picture spread across them, or the whole picture on each</small></div>
            <div class="set-seg">${[['', 'Span'], ['each', 'Each screen']]
              .map(([v, l]) => `<button data-wall-screens="${v}" class="${(p.wallpaperScreens || '') === v ? 'on' : ''}">${l}</button>`)
              .join('')}</div></div>
          ${shell?.term && shell.platform === 'linux' ? row('Terminal background', slider('termOpacity', 0.3, 1, 0.05, 1, '--term-opacity'), 'Lower lets what’s behind the Terminal show through') : ''}
          ${shell?.term && shell.platform === 'linux' ? row('Blur behind the Terminal', toggle('termBlur'), 'Blurs what shows through, so the text stays easy to read').replace('<div class="set-row"', `<div class="set-row" data-term-blur-row ${Number(p.termOpacity ?? 1) < 1 ? '' : 'hidden'}`) : ''}
        </div></section>

        <section><h3>${icon('grid', 14)} Desktop</h3><div class="set-group">
          ${row('Show widgets', toggle('hideWidgets', true))}
          ${row('Show desktop icons', toggle('hideIcons', true))}
          ${row('Icon size', slider('iconScale', 0.6, 1.6, 0.05, 1, '--icon-scale'))}
          ${row('Icon spacing', slider('iconSpacing', 0, 40, 2, 4, '--icon-gap', true))}
          ${row('Dock size', slider('dockScale', 0.6, 1.5, 0.05, 1, '--dock-scale'))}
          ${row('Dock position', `<div class="set-seg">${[['left', 'Bottom left'], ['center', 'Center'], ['right', 'Bottom right']]
            .map(([v, l]) => `<button data-dock-pos="${v}" class="${(p.dockPosition || 'center') === v ? 'on' : ''}">${l}</button>`)
            .join('')}</div>`)}
          <div class="set-row" data-screen-row hidden><div><span>Dock screen</span><small>The main screen keeps the menu bar</small></div>
            <div class="set-ctl"><select data-pref="dockScreen"></select></div></div>
          ${row('Desktop icons side', sideSeg('iconsSide', 'right'))}
          <div class="set-row" data-screen-row hidden><div><span>Desktop icons screen</span></div>
            <div class="set-ctl"><select data-pref="iconsScreen"></select></div></div>
          ${row('Morning briefing', `<div class="set-inline"><button class="btn small" data-briefing-open>Show now</button><button class="btn small" data-briefing-custom>Customize…</button></div>`, (() => { const b = { time: '09:00', enabled: true, days: [1, 2, 3, 4, 5], ...(p.briefing || {}) }; if (!b.enabled) return 'Off'; const [h, m] = b.time.split(':').map(Number); const t = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return `Covers the desktop at ${t}${b.days.length === 5 && !b.days.includes(0) && !b.days.includes(6) ? ' on weekdays' : b.days.length === 7 ? ' every day' : ''}`; })())}
          ${row('Widgets', `<div class="set-inline"><button class="btn small" data-widgets-edit>Edit widgets</button><button class="btn small" data-widgets-add>${icon('plus', 12)} Add…</button><button class="btn small" data-widgets-reset>Reset arrangement</button></div>`, 'Edit widgets, then drag them anywhere on your screens. Or right-click the desktop or any widget.')}
        </div></section>

        ${document.documentElement.dataset.session && shell?.os?.displays ? `<section data-page="displays"><h3>${icon('display', 14)} Displays</h3><div data-displays></div></section>` : ''}
        ${document.documentElement.dataset.session && shell?.os?.mouse ? `<section data-page="mouse"><h3>${icon('mouse', 14)} Mouse</h3><div data-mouse></div></section>` : ''}
        ${document.documentElement.dataset.session && shell?.os?.powerInfo ? `<section data-page="power"><h3>${icon('battery', 14)} Power</h3><div class="pw" data-power></div></section>` : ''}
        ${document.documentElement.dataset.session ? `<section><h3>${icon('leaf', 14)} Leafdeck OS</h3><div class="set-group">
          ${row('Lock the screen', `<select data-os-lockafter>${[[1, 'After 1 minute'], [2, 'After 2 minutes'], [5, 'After 5 minutes'], [10, 'After 10 minutes'], [15, 'After 15 minutes'], [30, 'After 30 minutes'], [60, 'After 1 hour'], [0, 'Never']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`, 'When you’re away, and always before sleep. Ctrl+Alt+L locks now.')}
          ${row('Sign-in PIN', `<div class="set-inline" data-os-pin><span class="muted">Loading…</span></div>`, 'A number that signs in and unlocks the screen, as well as your password. After 5 wrong tries it stops working until the password is used.')}
          ${row('Move from another computer', `<button class="btn small" data-move-import>${icon('upload', 12)} Import…</button>`, 'Bring your passwords, sign-ins, history and settings over from Leafdeck on Windows')}
          ${row('Lock now', `<div class="set-inline"><button class="btn small" data-os-lock>${icon('lock', 12)} Lock</button><button class="btn small" data-os-restart>Restart Leafdeck</button><button class="btn small" data-os-safe>Restart into safe mode</button></div>`, 'Restart Leafdeck after changing its code; you stay signed in. Safe mode starts it with its default settings, and Claude helps fix what’s wrong.')}
          <div class="os-about" data-os-about><p class="muted">Loading…</p></div>
        </div></section>` : ''}
        ${store.mode === 'cloud' && !store.local ? `<section><h3>${icon('clock', 14)} Browsing history</h3><div class="set-group">
          ${row('Keep browsing history', `<select data-pref="historyRetentionDays" data-number>${[[90, '90 days'], [365, '1 year'], [730, '2 years'], [0, 'Forever']].map(([v, l]) => `<option value="${v}" ${(p.historyRetentionDays ?? 365) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'History older than this is removed from your server')}
        </div></section>` : ''}


        ${shell ? `${claudeSection(sd)}


        <section><h3>${icon('shield', 14)} Browsing & privacy</h3><div class="set-group">
          ${row('Default browser', sd.info.packaged ? `<button class="btn small" data-default-browser>Make Leafdeck your default…</button>` : '<span class="muted small">Available in the installed app</span>', 'Links from other apps open in Leafdeck')}
          ${row('Search engine', `<select data-pref="searchEngine">${Object.entries(ENGINES).map(([k, [n]]) => `<option value="${k}" ${(p.searchEngine || 'google') === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`)}
          ${row('Email links', `<select data-browsing="emailLinks">
              <option value="gmail" ${sd.browsing.emailLinks !== 'system' ? 'selected' : ''}>Open in Gmail (in Leafdeck)</option>
              <option value="system" ${sd.browsing.emailLinks === 'system' ? 'selected' : ''}>Open your computer’s mail app</option></select>`, 'What a “mailto:” link does')}
          ${row('Secure DNS', `<select data-browsing="dnsMode">
              <option value="protected" ${sd.browsing.dnsMode === 'protected' ? 'selected' : ''}>Protected — blocks malware & phishing</option>
              <option value="standard" ${sd.browsing.dnsMode === 'standard' ? 'selected' : ''}>Standard — encrypted, no filtering</option>
              <option value="system" ${sd.browsing.dnsMode === 'system' ? 'selected' : ''}>Use my network’s DNS</option></select>`, 'Encrypted DNS through Cloudflare')}
          ${row('HTTPS-first', `<label class="switch"><input type="checkbox" data-browsing="httpsFirst" ${sd.browsing.httpsFirst ? 'checked' : ''}><span></span></label>`, 'Upgrade sites to secure connections; warn before loading insecure ones')}
          ${row('Block ads & trackers', `<label class="switch"><input type="checkbox" data-browsing="adblock" ${sd.browsing.adblock ? 'checked' : ''}><span></span></label>`, 'EasyList & EasyPrivacy, refreshed daily. The shield in a site’s toolbar shows what was blocked and can pause it there')}
          ${row('Ad blocking paused on', sd.browsing.adblockAllow?.length ? `<div class="set-chips">${sd.browsing.adblockAllow.map((h) => `<span class="chip">${esc(h)} <button class="chip-x" data-adblock-resume="${esc(h)}" title="Resume blocking">×</button></span>`).join('')}</div>` : '<span class="muted small">No sites</span>')}
          ${row('Downloads folder', `<div class="set-inline"><span class="set-path" title="${esc(sd.browsing.downloadFolder)}">${esc(sd.browsing.downloadFolder)}</span><button class="btn small" data-dl-folder-change>Change…</button></div>`)}
          ${row('Ask where to save each file', `<label class="switch"><input type="checkbox" data-browsing="askWhereToSave" ${sd.browsing.askWhereToSave ? 'checked' : ''}><span></span></label>`)}
          ${row('Clear browsing data', `<button class="btn small" data-clear-data>Clear…</button>`, 'History, cache, cookies')}
          ${row('Move to another computer', `<div class="set-inline"><button class="btn small" data-move-export>${icon('download', 12)} Export everything…</button>${document.documentElement.dataset.session ? '' : `<button class="btn small" data-move-import>Import…</button>`}</div>`, 'One passphrase-locked file with your passwords, sign-ins, history, settings and apps — for Leafdeck OS or a new PC')}
          ${row('Import browser data', `<button class="btn small" data-open-import>${icon('download', 12)} Import…</button>`, 'Bookmarks and passwords from Chrome, Edge, Firefox and more')}
          ${row('Saved passwords', `<button class="btn small" data-open-passwords>${icon('key', 12)} Open Passwords</button>`, 'Encrypted on this computer, never synced')}
          ${row('Never save passwords for', sd.browsing.neverSave.length ? `<div class="set-chips">${sd.browsing.neverSave.map((h) => `<span class="chip">${esc(h)} <button class="chip-x" data-never-forget="${esc(h)}" title="Remove">×</button></span>`).join('')}</div>` : '<span class="muted small">No sites</span>')}
          ${row('Site permissions', `<button class="btn small" data-perm-reset>Reset all</button>`, 'Forget every “Allow / Block” choice for camera, mic, notifications…')}
          ${row('Website logins', `<button class="btn small danger" data-clear-web>Sign out of all sites</button>`, 'Clears cookies and saved sessions for connections')}
        </div></section>

        <section><h3>${icon('chart', 14)} Performance</h3><div class="set-group">
          ${row('Sleep inactive windows', `<select data-browsing="sleepAfterMin" data-number>${[[0, 'Never'], [15, 'After 15 minutes'], [30, 'After 30 minutes'], [60, 'After 1 hour'], [120, 'After 2 hours'], [240, 'After 4 hours']].map(([v, l]) => `<option value="${v}" ${sd.browsing.sleepAfterMin === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'Unloads sites you haven’t used to free memory; they reload when you open them')}
          ${row('Pause minimized windows', `<label class="switch"><input type="checkbox" data-browsing="pauseMinimized" ${sd.browsing.pauseMinimized ? 'checked' : ''}><span></span></label>`, 'Freezes minimized sites’ timers and scripts — nothing reloads')}
          ${row('Always keep awake', sd.browsing.keepAwake.length ? `<div class="set-chips">${sd.browsing.keepAwake.map((h) => `<span class="chip">${esc(h)} <button class="chip-x" data-awake-remove="${esc(h)}" title="Remove">×</button></span>`).join('')}</div>` : '<span class="muted small">No sites — add from a site’s ⋯ menu</span>', 'Never paused or put to sleep. Sites playing audio are always kept awake.')}
          ${row('Task Manager', `<button class="btn small" data-open-tm>Open</button>`, 'Shift+Esc — memory and CPU for every site')}
        </div></section>

        <section><h3>${icon('sparkle', 14)} About</h3><div class="set-group">
          ${row('Version', `<span class="muted small">Leafdeck ${esc(sd.info.version)} · Chromium ${esc(sd.info.chrome)} · Electron ${esc(sd.info.electron)}</span>`)}
          ${row('Security updates', `<div class="set-inline"><span class="muted small" data-update-status></span><button class="btn small" data-check-updates>Check now</button></div>`, 'Chromium security fixes arrive through Electron updates')}
        </div></section>` : ''}

        <section><h3>${icon('calendar', 14)} Connected calendars</h3><div class="set-group">
          ${row('Meeting notes', `<label class="switch"><input type="checkbox" data-meeting-notes ${p.meetingNotes !== false ? 'checked' : ''}><span></span></label>`, 'Five minutes before a timed event, open a note for it prefilled with the attendees and your last notes with them')}
          ${row('Calendars', `<button class="btn small" data-manage-calendars>Manage…</button>`, 'Google Calendar (two-way) and calendar subscription links')}
        </div></section>

        <section><h3>${icon('inbox', 14)} Data</h3><div class="set-group">
          ${store.local
            ? row('Storage', '<span class="pill pill-green">On this computer</span>', 'Records and note media are kept in Leafdeck’s own folder. No account or server needed')
            : row('Storage', store.mode === 'cloud' ? '<span class="pill pill-green">Cloudflare D1</span>' : '<span class="pill pill-yellow">This browser only</span>', store.mode === 'cloud' ? 'Synced to your Worker’s database' : 'Deploy the Worker to sync across devices')}
          ${shell && store.local ? `<details class="set-details"><summary>Import from a Leafdeck server</summary>
            ${row('Server address', `<div class="set-inline"><input type="url" data-server-url placeholder="https://leafdeck.example.workers.dev"><button class="btn small" data-server-save>Save</button></div>`, 'The Worker your records used to live on')}
            ${row('Cloudflare Access', `<button class="btn small" data-server-signin>Sign in to server</button>`, 'If the Worker is behind Access, sign in once here')}
            ${row('API token', secretInput('apiToken', 'Only if you set API_TOKEN'), 'Encrypted on this computer')}
            ${row('Access service token', `<div class="set-stack">${secretInput('accessClientId', 'Client ID')}${secretInput('accessClientSecret', 'Client secret')}</div>`, 'Optional alternative to signing in — encrypted on this computer')}
            ${row('Bring everything here', `<button class="btn small" data-server-import>${icon('download', 12)} Import</button>`, 'Copies your records and note media onto this computer, replacing what’s here. Connected calendars are connected again here')}
          </details>` : ''}
          ${shell ? '' : row('API token', `<div class="set-inline"><input type="password" data-api-token placeholder="Only if you set API_TOKEN" autocomplete="off"><button class="btn small" data-token-save>Save</button></div>`, 'Stored in this browser only')}
          ${row('Records as JSON', `<div class="set-inline"><button class="btn small" data-export>${icon('download', 12)} Export JSON</button>
            <label class="btn small">${icon('upload', 12)} Import JSON<input type="file" accept="application/json" data-import hidden></label></div>`, 'Import replaces everything')}
          ${row('Sample data', `<button class="btn small" data-sample>Load sample data</button>`, 'Replaces current records with a demo set')}
          ${row('Erase everything', `<button class="btn small danger" data-erase>Erase all data</button>`)}
        </div></section>
        ${shell?.backup && store.local ? `<section data-page="backup"><h3>${icon('archive', 14)} Backup</h3><div data-backup></div></section>` : ''}
      </div></div>`;
      fillDockScreens(win.body);
      showPage();
    };

    // Leafdeck OS: lock setting and About this computer (Settings → Power is public/js/power.js), filled in after each draw.
    const fillOs = async () => {
      if (!document.documentElement.dataset.session || !shell?.os) return;
      const sel = win.body.querySelector('[data-os-lockafter]');
      const box = win.body.querySelector('[data-os-about]');
      try {
        const [cfg, a] = await Promise.all([shell.os.settings(), shell.os.about()]);
        if (sel) sel.value = String(cfg.lockAfter ?? 5);
        const gb = (n) => `${(n / 1024 ** 3).toFixed(n > 100 * 1024 ** 3 ? 0 : 1)} GB`;
        const up = Math.floor(a.uptime / 3600) ? `${Math.floor(a.uptime / 3600)} h ${Math.floor((a.uptime % 3600) / 60)} min` : `${Math.floor(a.uptime / 60)} min`;
        if (box)
          box.innerHTML = [
            ['Computer', `${esc(a.host)} · signed in as ${esc(a.user)}`],
            ['System', `${esc(a.system)} · Linux ${esc(a.kernel)}`],
            ['Processor', `${esc(a.cpu)} · ${a.cores} cores`],
            ['Memory', gb(a.memory)],
            a.disk && ['Storage', `${gb(a.disk.avail)} free of ${gb(a.disk.size)}`],
            ['Up for', up],
          ]
            .filter(Boolean)
            .map(([k, v]) => `<div class="os-about-row"><span>${k}</span><b>${v}</b></div>`)
            .join('');
      } catch (err) {
        if (box) box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
      }
    };
    new MutationObserver(() => win.body.querySelector('[data-os-about] .muted') && fillOs()).observe(win.body, { childList: true });
    fillOs();

    // Sign-in PIN (os/leafdeck-pin): its state, or a form to set or remove it.
    const fillPin = async (mode = '') => {
      const box = win.body.querySelector('[data-os-pin]');
      if (!box || !shell?.os?.pinStatus) return;
      const st = await shell.os.pinStatus().catch(() => ({ available: false }));
      if (!st.available) return void (box.innerHTML = `<span class="muted">Not installed yet: run os/use-leafdeck-signin.sh</span>`);
      const pinInput = (name, placeholder) => `<input type="password" name="${name}" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="${placeholder}" required>`;
      if (mode === 'set')
        box.innerHTML = `<form class="set-stack" data-pin-form="set">
          <input type="password" name="password" autocomplete="current-password" placeholder="Your account password" required>
          ${pinInput('pin', `${st.set ? 'New' : 'A'} PIN, 4 to 12 digits`)}${pinInput('pin2', 'The PIN again')}
          <div class="set-inline"><button class="btn small primary">Save PIN</button><button type="button" class="btn small" data-pin-mode="">Cancel</button></div>
          <small class="txt-red" data-pin-err></small></form>`;
      else if (mode === 'remove')
        box.innerHTML = `<form class="set-stack" data-pin-form="remove">
          <input type="password" name="password" autocomplete="current-password" placeholder="Your account password" required>
          <div class="set-inline"><button class="btn small danger">Remove PIN</button><button type="button" class="btn small" data-pin-mode="">Cancel</button></div>
          <small class="txt-red" data-pin-err></small></form>`;
      else
        box.innerHTML = st.set
          ? `<span class="muted">${st.locked ? 'Off until you use your password' : 'On'}</span><button class="btn small" data-pin-mode="set">Change…</button><button class="btn small" data-pin-mode="remove">Remove…</button>`
          : `<button class="btn small" data-pin-mode="set">${icon('lock', 12)} Set up a PIN…</button>`;
      box.querySelector('input')?.focus();
    };
    // Easy to guess: one digit repeated, or counting up or down (1234, 9876).
    const weakPin = (pin) => [...pin].every((d, i) => i === 0 || d === pin[0]) || [1, -1].some((step) => [...pin].every((d, i) => i === 0 || Number(d) === (Number(pin[i - 1]) + step + 10) % 10));
    win.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pin-mode]');
      if (b) fillPin(b.dataset.pinMode);
    });
    win.body.addEventListener('submit', async (e) => {
      const f = e.target.closest('[data-pin-form]');
      if (!f) return;
      e.preventDefault();
      const err = f.querySelector('[data-pin-err]');
      const v = (n) => f.elements[n]?.value || '';
      if (f.dataset.pinForm === 'set') {
        if (!/^[0-9]{4,12}$/.test(v('pin'))) return void (err.textContent = 'A PIN is 4 to 12 digits.');
        if (v('pin') !== v('pin2')) return void (err.textContent = 'The two PINs don’t match.');
        if (weakPin(v('pin'))) return void (err.textContent = 'That PIN is easy to guess. Try another.');
      }
      f.querySelectorAll('button, input').forEach((x) => (x.disabled = true));
      err.textContent = '';
      try {
        if (f.dataset.pinForm === 'set') await shell.os.setPin(v('password'), v('pin'));
        else await shell.os.removePin(v('password'));
        toast(f.dataset.pinForm === 'set' ? 'PIN saved. Use it to sign in and unlock.' : 'PIN removed');
        fillPin();
      } catch (x) {
        f.querySelectorAll('button, input').forEach((el) => (el.disabled = false));
        err.textContent = String(x?.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        f.elements.password.select();
      }
    });
    new MutationObserver(() => win.body.querySelector('[data-os-pin] > .muted:only-child') && fillPin()).observe(win.body, { childList: true });
    fillPin();

    win.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-os-lockafter]')) return void shell.os.settings({ lockAfter: Number(t.value) });
      if (t.dataset.pref) {
        let v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.hasAttribute('data-number') ? (t.value === '' ? null : Number(t.value)) : t.value.trim();
        if (t.hasAttribute('data-invert')) v = !v;
        setPathPrefs(t.dataset.pref, v);
      }
      if (t.dataset.browsing) {
        const value = t.type === 'checkbox' ? t.checked : t.hasAttribute('data-number') ? Number(t.value) : t.value;
        shell.browsing.set({ [t.dataset.browsing]: value }).then(() => {
          refreshSaverSettings();
          toast('Saved');
        });
      }
      if (t.dataset.voice) {
        shell.voice
          .set({ [t.dataset.voice]: t.type === 'checkbox' ? t.checked : t.value })
          .then((v) => {
            $('[data-voice-group]', win.body).innerHTML = voiceRows(v);
            toast('Saved');
          })
          .catch((err) => toast(err.message, 'error'));
      }
      if (t.dataset.claude || t.dataset.claudeAllow) {
        // Settings → Claude. Takes effect the next time Claude starts (an idle chat restarts on its next message).
        const patch = t.dataset.claudeAllow
          ? { allow: $$('[data-claude-allow]', win.body).filter((x) => x.checked).map((x) => x.dataset.claudeAllow) }
          : { [t.dataset.claude]: t.type === 'checkbox' ? t.checked : t.dataset.claude === 'ask' ? t.value === '1' : t.value };
        shell.claude
          .set(patch)
          .then((c) => {
            $('[data-claude-allows]', win.body).hidden = !c.ask;
            toast('Saved');
          })
          .catch((err) => toast(err.message, 'error'));
      }
      if (t.matches('[data-wall-file]') && t.files[0]) {
        const fr = new FileReader();
        fr.onload = () => {
          try {
            localStorage.setItem('ws:wallpaper', fr.result);
            store.emit('settings');
            toast('Wallpaper updated');
          } catch {
            toast('That image is too large — try one under 4 MB.', 'error');
          }
        };
        fr.readAsDataURL(t.files[0]);
      }
      if (t.matches('[data-import]') && t.files[0]) {
        t.files[0].text().then(async (txt) => {
          try {
            const j = JSON.parse(txt);
            if (!(await confirmDialog('Replace ALL current data with this backup?', { ok: 'Replace', danger: true }))) return;
            await store.replaceAll(j.collections || j);
            toast('Backup imported');
            drawAll();
          } catch {
            toast('That file is not a valid backup.', 'error');
          }
        });
      }
    });

    win.body.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.closest('[data-briefing-open]')) return import('../briefing.js').then((b) => b.openBriefing());
      if (t.closest('[data-os-lock]')) return shell.os.lock();
      if (t.closest('[data-os-restart]')) return shell.windowAction('restart-leafdeck');
      if (t.closest('[data-claude-settings]')) return openApp('claudesettings');
      if (t.closest('[data-os-safe]')) return confirmDialog('Restart Leafdeck into safe mode? It starts with its default settings (no saved display arrangement or window layout) and opens Claude with what it found. Try Leafdeck now there brings the normal start back.', { title: 'Safe mode', ok: 'Restart into safe mode', win }).then((ok) => ok && shell.windowAction('safe-mode'));
      if (t.closest('[data-briefing-custom]')) return import('../briefing.js').then((b) => b.customizeBriefing());
      const acc = t.closest('[data-accent]');
      if (acc) {
        store.setPrefs({ accent: acc.dataset.accent });
        $$('[data-accent], [data-accent-custom]', win.body).forEach((b) => b.classList.toggle('on', b === acc));
      }
      // Any color: previewed live, kept when the picker closes.
      const custom = t.closest('[data-accent-custom]');
      if (custom) {
        const r = custom.getBoundingClientRect();
        const root = document.documentElement.style;
        const before = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        pickColor(r.left, r.bottom + 8, {
          value: custom.dataset.accentCustom || before,
          title: 'Accent color',
          onChange: (c) => root.setProperty('--accent', c),
          onDone: (c) => {
            if (!/^#[0-9a-f]{6}$/i.test(c || '')) return void root.setProperty('--accent', before);
            custom.dataset.accentCustom = c;
            custom.style.setProperty('--c', c);
            store.setPrefs({ accent: c });
            $$('[data-accent], [data-accent-custom]', win.body).forEach((b) => b.classList.toggle('on', b === custom));
          },
        });
        return;
      }
      const th = t.closest('[data-theme-pick]');
      if (th) {
        store.setPrefs({ theme: th.dataset.themePick });
        $$('[data-theme-pick]', win.body).forEach((b) => b.classList.toggle('on', b === th));
        return;
      }
      const wall = t.closest('[data-wall]');
      if (wall) {
        localStorage.removeItem('ws:wallpaper');
        store.setPrefs({ wallpaper: wall.dataset.wall });
        $$('[data-wall]', win.body).forEach((x) => x.classList.toggle('on', x === wall));
        const custom = $('input[data-pref="wallpaper"]', win.body);
        if (custom) custom.value = ''; // built-in wallpapers aren't shown as a custom address
        return;
      }
      if (t.closest('[data-wall-reset]')) {
        localStorage.removeItem('ws:wallpaper');
        store.setPrefs({ wallpaper: '' });
        drawAll();
      }
      if (t.closest('[data-server-save]')) {
        const res = await shell.setServerUrl($('[data-server-url]', win.body).value);
        toast(res?.ok ? 'Saved' : res?.error || 'Could not use that address.', res?.ok ? undefined : 'error');
      }
      const imp = t.closest('[data-server-import]');
      if (imp) {
        const ok = await confirmDialog('Your records and note media are copied onto this computer, replacing the records here. The server isn’t changed.', {
          title: 'Import from your Leafdeck server?',
          ok: 'Import',
          win,
        });
        if (!ok) return;
        imp.disabled = true;
        const r = await shell.importFromServer();
        imp.disabled = false;
        if (!r.ok) return toast(r.error, 'error');
        toast(`Imported ${r.records} records and ${r.media} media files${r.missing ? ` (${r.missing} couldn’t be copied)` : ''}`);
        setTimeout(() => location.reload(), 1200);
        return;
      }
      const voiceAct = ['download', 'remove', 'copy', 'recheck'].find((k) => t.closest(`[data-voice-${k}]`));
      if (voiceAct) {
        const group = $('[data-voice-group]', win.body);
        try {
          if (voiceAct === 'copy') {
            await navigator.clipboard.writeText($('[data-voice-install]', win.body)?.textContent || '');
            return toast('Copied');
          }
          const v = await shell.voice.status();
          if (voiceAct === 'download') {
            shell.voice.download(v.model).catch((err) => toast(err.message, 'error')); // progress comes as events
            group.innerHTML = voiceRows({ ...v, models: { ...v.models, [v.model]: { ...v.models[v.model], downloading: 0 } } });
          } else if (voiceAct === 'remove') group.innerHTML = voiceRows(await shell.voice.removeModel(v.model));
          else group.innerHTML = voiceRows(v);
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      if (t.closest('[data-claude-install]')) {
        try {
          await shell.userApps.installAgent('claude');
          toast('Installing Claude Code in a new terminal window. Sign in there, then come back.');
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      if (t.closest('[data-mcp-copy]')) {
        await navigator.clipboard.writeText($('[data-mcp-cmd]', win.body).textContent);
        return toast('Command copied — paste it in a terminal');
      }
      if (t.closest('[data-mcp-regen]')) {
        await shell.mcp.regenerate();
        drawAll();
        return toast('New token — run the new command so Claude Code reconnects');
      }
      if (t.closest('[data-server-signin]')) {
        const r = await shell.signInToServer();
        if (r.ok) toast('Signed in to the server');
      }
      const saveSecret = t.closest('[data-secret-save]');
      if (saveSecret) {
        const key = saveSecret.dataset.secretSave;
        const input = $(`[data-secret="${key}"]`, win.body);
        await shell.secrets.set(key, input.value);
        toast(input.value ? 'Saved securely' : 'Removed');
        drawAll();
      }
      if (t.closest('[data-manage-calendars]')) manageCalendars();
      if (t.closest('[data-widgets-edit]')) enterWidgetEdit();
      if (t.closest('[data-widgets-add]')) openWidgetGallery();
      if (t.closest('[data-widgets-reset]')) resetWidgetArrangement();
      if (t.closest('[data-open-import]')) openImportSheet(win);
      if (t.closest('[data-move-export]')) openExportSheet(win);
      if (t.closest('[data-move-import]')) openImportMoveSheet(win);
      if (t.closest('[data-default-browser]')) shell.openDefaultApps();
      if (t.closest('[data-open-tm]')) openApp('taskmanager');
      const awake = t.closest('[data-awake-remove]');
      if (awake) {
        await shell.perf.keepAwake(awake.dataset.awakeRemove, false);
        drawAll();
      }
      if (t.closest('[data-clear-data]')) openClearDataSheet(win);
      if (t.closest('[data-dl-folder-change]') && (await shell.browsing.chooseDownloadFolder())) drawAll();
      const resume = t.closest('[data-adblock-resume]');
      if (resume) {
        await shell.adblock.allow(resume.dataset.adblockResume, false);
        drawAll();
      }
      const never = t.closest('[data-never-forget]');
      if (never) {
        await shell.browsing.forgetNeverSave(never.dataset.neverForget);
        drawAll();
      }
      if (t.closest('[data-check-updates]')) {
        const status = $('[data-update-status]', win.body);
        status.textContent = 'Checking…';
        const u = await shell.checkUpdates(true);
        status.textContent = !u ? 'Couldn’t check right now' : u.available ? `Electron ${u.latest} is available — rebuild Leafdeck` : 'Up to date';
      }
      if (t.closest('[data-open-passwords]')) openApp('passwords');
      if (t.closest('[data-perm-reset]')) {
        await shell.permissions.reset();
        toast('Site permissions reset');
      }
      if (t.closest('[data-clear-web]')) {
        if (!(await confirmDialog('Sign out of every site opened from Connections?', { ok: 'Sign out', danger: true }))) return;
        await shell.clearWebData();
        toast('Signed out of all sites');
      }
      if (t.closest('[data-token-save]')) {
        const v = $('[data-api-token]', win.body).value.trim();
        if (v) localStorage.setItem('ws:token', v);
        else localStorage.removeItem('ws:token');
        location.reload();
      }
      if (t.closest('[data-export]')) {
        download(`leafdeck-backup-${today()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), collections: store.data }, null, 2));
      }
      if (t.closest('[data-sample]')) {
        if (!(await confirmDialog('Replace your current records with sample data? (Settings are kept.)', { ok: 'Replace', danger: true }))) return;
        await store.replaceAll({ ...sampleData(), settings: store.all('settings') });
        toast('Sample data loaded');
        drawAll();
      }
      if (t.closest('[data-erase]')) {
        if (!(await confirmDialog('Erase ALL records and settings? This cannot be undone. (Export a backup first if unsure.)', { ok: 'Erase', danger: true }))) return;
        await store.replaceAll({ settings: [{ id: 'prefs', onboarded: true, userName: store.prefs.userName }] });
        toast('All data erased');
        drawAll();
      }
    });

    win.el.addEventListener('change', (e) => {
      const mn = e.target.closest('[data-meeting-notes]');
      if (mn) store.setPrefs({ meetingNotes: mn.checked });
    });
    win.el.addEventListener('change', async (e) => {
      const m = e.target.closest('[data-mcp-enabled]');
      if (!m) return;
      await shell.mcp.set({ enabled: m.checked });
      drawAll();
    });

    const drawAll = async () => {
      if (!shell) return draw();
      const [info, secrets, browsing, mcp, claude, voice] = await Promise.all([shell.info(), shell.secrets.status(), shell.browsing.settings(), shell.mcp?.status(), shell.claude?.settings().catch(() => null), shell.voice?.status().catch(() => null)]);
      draw({ info, secrets, browsing, mcp, claude, voice });
      const inp = $('[data-server-url]', win.body);
      if (inp) inp.value = info.serverUrl;
      // Secrets are write-only from here: show whether one is set, never its value.
      for (const [key, set] of Object.entries(secrets)) {
        const field = $(`[data-secret="${key}"]`, win.body);
        if (field) field.placeholder = set ? '•••••••• saved — type to replace, or clear and Save' : field.dataset.ph;
      }
    };
    win.watch(['links'], drawAll);
    drawAll();
  },
});

/* ---------------- About ---------------- */

registerApp({
  id: 'about',
  name: 'About Leafdeck',
  icon: 'leaf',
  color: 'green',
  hidden: true,
  size: [400, 420],
  mount(win) {
    win.body.innerHTML = `<div class="about">
      <img class="about-logo" src="${document.documentElement.dataset.session ? '/img/leafdeck-os-logo.svg' : '/img/leafdeck-logo.svg'}" alt="Leafdeck" draggable="false">
      <div class="about-version">${shell ? 'Version …' : 'Web version'}</div>
      <dl class="about-details"></dl>
      <div class="about-update"></div>
      <p class="about-note">Your work, in one place.</p></div>`;
    if (!shell) return;

    const drawUpdate = (u) => {
      const box = $('.about-update', win.body);
      if (!box || !u) return;
      const line = {
        dev: 'Dev copy — runs from source, updates don’t apply',
        idle: 'Updates are checked automatically',
        checking: 'Checking for updates…',
        none: 'Leafdeck is up to date',
        downloading: `Downloading ${u.latest || 'update'}… ${u.percent || 0}%`,
        ready: `Version ${u.latest} is ready to install`,
        installing: 'Installing…',
        error: `Couldn’t check for updates: ${u.error || 'unknown error'}`,
      }[u.state] || '';
      const button =
        u.state === 'ready'
          ? '<button class="btn primary small" data-about="install">Restart to Update</button>'
          : u.state !== 'dev' && u.state !== 'checking' && u.state !== 'downloading'
            ? '<button class="btn small" data-about="check">Check for Updates</button>'
            : '';
      box.innerHTML = `<span class="${u.state === 'error' ? 'about-error' : ''}">${esc(line)}</span>${button}`;
    };

    Promise.all([shell.info(), shell.appUpdate?.('status')]).then(([info, u]) => {
      $('.about-version', win.body).textContent = `Version ${info.version}${info.packaged ? '' : ' (dev)'}`;
      $('.about-details', win.body).innerHTML = [
        ['Chromium', info.chrome],
        ['Electron', info.electron],
        store.local ? ['Data', 'On this computer'] : ['Server', (info.serverUrl || '').replace(/^https?:\/\//, '')],
      ]
        .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || '—')}</dd>`)
        .join('');
      drawUpdate(u);
    });
    const off = shell.on('shell:app-update', drawUpdate);
    win.cleanups.push(off);
    // A speech model downloading: its row follows along.
    if (shell.voice) {
      let voiceTimer = 0;
      win.cleanups.push(
        shell.on('voice:event', (ev) => {
          if (ev.t !== 'download' && ev.t !== 'status') return;
          clearTimeout(voiceTimer);
          voiceTimer = setTimeout(async () => {
            const group = $('[data-voice-group]', win.body);
            if (group) group.innerHTML = voiceRows(await shell.voice.status());
          }, ev.t === 'status' ? 0 : 150);
        }),
      );
    }
    win.body.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-about]')?.dataset.about;
      if (act === 'check') drawUpdate(await shell.appUpdate('check'));
      if (act === 'install') shell.appUpdate('install');
    });
  },
});

/* ---------------- Welcome ---------------- */

registerApp({
  id: 'welcome',
  name: 'Welcome',
  icon: 'sparkle',
  color: 'green',
  hidden: true,
  size: [560, 520],
  mount(win) {
    win.body.innerHTML = `<div class="welcome">
      <img class="welcome-logo" src="/img/leafdeck-logo.svg" alt="Leafdeck" draggable="false">
      <h1>Welcome to Leafdeck</h1>
      <p>One place for your work: tasks, calendar, notes, contacts and the sites and apps you use.</p>
      <ul>
        <li>${icon('search', 14)} <span><b>Search</b> anything, or type a web address, in the middle of the menu bar (or press <kbd>Ctrl</kbd> <kbd>K</kbd>).</span></li>
        <li>${icon('grid', 14)} <span><b>Double-click</b> desktop icons to open apps — open apps appear in the <b>Dock</b>.</span></li>
        <li>${icon('link', 14)} <span>Add your tools in <b>Connections</b> — they become desktop apps too.</span></li>
      </ul>
      <label class="field"><span>What should we call you?</span><input class="welcome-name" value="${esc(store.prefs.userName || '')}" placeholder="Your first name"></label>
      <div class="welcome-actions">
        <button class="btn" data-start="empty">Start fresh</button>
        <button class="btn primary" data-start="sample">Explore with sample data</button>
      </div></div>`;
    win.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-start]');
      if (!b) return;
      const userName = $('.welcome-name', win.body).value.trim();
      if (b.dataset.start === 'sample') await store.replaceAll({ ...sampleData(), settings: store.all('settings') });
      store.setPrefs({ onboarded: true, userName });
      win.close();
    });
  },
});
