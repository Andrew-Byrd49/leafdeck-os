// Claude Code control: an MCP server inside Leafdeck that lets Claude Code see and operate the desktop and
// every site window — list windows, open, read the page, click, fill, type, screenshot, run script.
//
// Off by default (Settings → Claude → Claude Code control). When on, it listens on 127.0.0.1 only,
// every request needs the bearer token Leafdeck generated, and requests carrying an Origin header (web pages)
// are refused. Pages are driven through Chromium's own debugger on each window's web contents, the same
// mechanism the Claude in Chrome extension uses; nothing is exposed on a debugging port.
const http = require('node:http');
const crypto = require('node:crypto');
const { app, webContents, nativeImage } = require('electron');
const { readConfig, writeConfig, isWebUrl } = require('./common.cjs');
const userApps = require('./userapps.cjs');

const DEFAULT_PORT = 48333;
let deps = null; // { win(), isOurWebview(wc), onActivity(active) }

/* The menu bar's "Claude Code" badge shows only while an agent is actually doing something: from the start of
   a tool call until a few seconds after the last one finishes (so a quick run of calls doesn't flicker). */
let running = 0;
let idleTimer = null;
let shownActive = false;
function setActive(on) {
  if (on === shownActive) return;
  shownActive = on;
  deps?.onActivity?.(on);
}
function callStarted() {
  running++;
  clearTimeout(idleTimer);
  setActive(true);
}
function callEnded() {
  running = Math.max(0, running - 1);
  if (running) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => !running && setActive(false), 4000);
}
let server = null;
const transports = new Map(); // session id -> transport

const cfg = () => ({ enabled: false, port: DEFAULT_PORT, token: '', builderToken: '', assistantToken: '', ...(readConfig().mcp || {}) });
function ensureToken() {
  const c = cfg();
  if (!c.token || !c.builderToken || !c.assistantToken) {
    if (!c.token) c.token = crypto.randomBytes(24).toString('base64url');
    // App Builder's own connection: it can only see and drive the user's apps, never sites or the desktop.
    if (!c.builderToken) c.builderToken = crypto.randomBytes(24).toString('base64url');
    // The Claude assistant's (bottom-left button): full control, even with Claude Code control off, because it's
    // Leafdeck's own chat and the user approves each action that changes something.
    if (!c.assistantToken) c.assistantToken = crypto.randomBytes(24).toString('base64url');
    writeConfig({ mcp: c });
  }
  return c;
}
/** What App Builder hands an agent: the server address and the builder-scoped token (starting the server if needed). */
function builderConnection() {
  const c = ensureToken();
  if (!server) start();
  return { url: url(c), token: c.builderToken, port: c.port };
}
/** The Claude assistant's connection (full scope, its own token). */
function assistantConnection() {
  const c = ensureToken();
  if (!server) start();
  return { url: url(c), token: c.assistantToken, port: c.port };
}
const url = (c) => `http://127.0.0.1:${c.port}/mcp`;
const command = (c) => `claude mcp add --transport http leafdeck ${url(c)} --header "Authorization: Bearer ${c.token}"`;

function status() {
  const c = cfg();
  return { enabled: !!c.enabled, port: c.port, token: c.token, url: url(c), command: c.token ? command(c) : '', connected: transports.size, listening: !!server };
}

/* ---------------- Windows ---------------- */

const uiContents = () => {
  const w = deps?.win();
  if (!w || w.isDestroyed()) throw new Error('Leafdeck isn’t open');
  return w.webContents;
};
const uiEval = (js) => uiContents().executeJavaScript(js, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Leafdeck's windows as the renderer sees them, plus the web contents id of each awake site window. */
async function listWindows() {
  const list = await uiEval(`import('/js/wm.js').then((m) => [...m.wins.values()].map((w) => {
    let wc = null;
    try { wc = (w.web?.webview || w.appView)?.getWebContentsId() || null; } catch {}
    let url = '';
    try { url = w.web?.url?.() || w.appView?.getURL?.() || ''; } catch {}
    return { id: w.id, title: w.el.querySelector('.win-title-text')?.textContent || w.app.name, app: w.app.name, url, site: !!w.web, userApp: !!w.userApp,
      sleeping: !!w.web?.sleeping, minimized: !!w.minimized, active: w === m.activeWindow(), webContentsId: wc };
  }))`);
  return list;
}

function formatWindows(list) {
  const rows = [`desktop — Leafdeck’s own desktop: icons, widgets, menus and app windows (use window id "desktop")`];
  for (const w of list) {
    const flags = [w.active && 'active', w.minimized && 'minimized', w.sleeping && 'asleep (focus it to wake)'].filter(Boolean);
    rows.push(`${w.id} — ${w.site ? 'site' : w.userApp ? 'user app' : 'app'}: ${w.title}${w.url ? ` <${w.url}>` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
  }
  return rows.join('\n');
}

/** Resolve a tool's `window` argument to web contents, waking a sleeping site window first. */
async function targetIn(id, scope = 'full') {
  if (scope === 'builder' && !String(id || '').startsWith('user:')) {
    throw new Error('This connection can only work with the apps you build (window ids starting with "user:"). Use leafdeck_app_open to open one.');
  }
  if (!id || id === 'desktop') return { wc: uiContents(), ui: true };
  let list = await listWindows();
  let w = list.find((x) => x.id === id);
  if (!w) throw new Error(`No window "${id}". Call leafdeck_windows for the current list.`);
  if (w.userApp) {
    if (!w.webContentsId) throw new Error(`"${id}" isn’t running yet (it may be waiting for the user to approve its permissions, or have no index.html). ${scope === "builder" ? "Ask the user to approve it in Leafdeck, then try again." : "Check leafdeck_screenshot on \"desktop\"."}`);
    const wc = webContents.fromId(w.webContentsId);
    if (!deps.isOurWebview(wc)) throw new Error('That window is no longer open');
    return { wc, ui: false, info: w };
  }
  if (!w.site) throw new Error(`"${id}" is a Leafdeck app window, not a site. Drive it through the "desktop" window.`);
  if (w.sleeping || !w.webContentsId) {
    await uiEval(`import('/js/wm.js').then((m) => { const w = m.wins.get(${JSON.stringify(id)}); if (!w) return; m.focus(w); w.web?.wake?.(); })`);
    for (let i = 0; i < 40 && (!w || !w.webContentsId); i++) {
      await sleep(250);
      list = await listWindows();
      w = list.find((x) => x.id === id);
    }
    if (!w?.webContentsId) throw new Error('That window didn’t wake up');
    await sleep(800);
  }
  const wc = webContents.fromId(w.webContentsId);
  if (!deps.isOurWebview(wc)) throw new Error('That window is no longer open');
  return { wc, ui: false, info: w };
}

/* ---------------- Chromium debugger helpers ---------------- */

async function cdp(wc, method, params = {}) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger.sendCommand(method, params);
}

const INTERACTIVE = new Set(['textbox', 'searchbox', 'combobox', 'button', 'link', 'checkbox', 'radio', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'heading', 'img', 'StaticText', 'cell', 'columnheader', 'row', 'treeitem', 'dialog', 'alert', 'status']);
const SKIP = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);

/** The page as an accessibility outline. Each line's uid is what click/fill take. */
async function snapshot(wc, max = 500) {
  const { nodes } = await cdp(wc, 'Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const walk = (nid, depth) => {
    const n = byId.get(nid);
    if (!n) return;
    const role = n.role?.value || '';
    const name = String(n.name?.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const value = n.value?.value;
    const props = (n.properties || [])
      .filter((p) => ['focused', 'checked', 'disabled', 'expanded', 'selected', 'pressed', 'required', 'invalid', 'readonly'].includes(p.name))
      .filter((p) => p.value?.value !== false && p.value?.value !== 'false')
      .map((p) => (p.value?.value === true ? p.name : `${p.name}=${p.value?.value}`));
    const show = !n.ignored && n.backendDOMNodeId != null && !SKIP.has(role) && (name || value != null || INTERACTIVE.has(role));
    let d = depth;
    if (show && lines.length < max) {
      lines.push(`${'  '.repeat(Math.min(depth, 14))}uid=${n.backendDOMNodeId} ${role}${name ? ` "${name}"` : ''}${value != null && value !== '' ? ` value="${String(value).slice(0, 80)}"` : ''}${props.length ? ` [${props.join(', ')}]` : ''}`);
      d = depth + 1;
    }
    for (const c of n.childIds || []) walk(c, d);
  };
  if (nodes.length) walk(nodes[0].nodeId, 0);
  return lines.join('\n') + (lines.length >= max ? `\n… truncated at ${max} nodes; use leafdeck_find or evaluate for more` : '');
}

async function center(wc, uid) {
  await cdp(wc, 'DOM.enable');
  await cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: uid }).catch(() => {});
  const { quads } = await cdp(wc, 'DOM.getContentQuads', { backendNodeId: uid });
  const q = quads?.[0];
  if (!q) throw new Error(`uid ${uid} isn’t visible on the page`);
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function click(wc, uid, { double = false, button = 'left' } = {}) {
  const { x, y } = await center(wc, uid);
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= (double ? 2 : 1); i++) {
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
  return { x: Math.round(x), y: Math.round(y) };
}

async function fill(wc, uid, text) {
  await cdp(wc, 'DOM.enable');
  const { object } = await cdp(wc, 'DOM.resolveNode', { backendNodeId: uid });
  const { result } = await cdp(wc, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    returnByValue: true,
    arguments: [{ value: text }],
    functionDeclaration: `function (text) {
      this.focus?.();
      if (this.tagName === 'SELECT') {
        const o = [...this.options].find((o) => o.value === text || o.textContent.trim() === text);
        if (!o) return 'no option matches ' + JSON.stringify(text);
        this.value = o.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
        return 'selected';
      }
      if (this.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('delete', false); return 'insert'; }
      const set = (v) => {
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value');
        if (d?.set) d.set.call(this, v); else this.value = v;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // Pickers and other non-typed inputs take a value directly (date: YYYY-MM-DD, time: HH:MM, color: #rrggbb).
      if (this.tagName === 'INPUT' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'number', 'range'].includes(this.type)) {
        set(text);
        if (this.value !== text && this.type !== 'number' && this.type !== 'range') return 'rejected — use the format ' + ({ date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www', color: '#rrggbb' })[this.type];
        return 'set';
      }
      if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) {
        const on = /^(true|1|yes|on|checked)$/i.test(text);
        if (this.checked !== on) this.click();
        return on ? 'checked' : 'unchecked';
      }
      if ('value' in this) {
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value');
        if (d?.set) d.set.call(this, ''); else this.value = '';
        this.dispatchEvent(new Event('input', { bubbles: true }));
        return 'insert';
      }
      return 'insert';
    }`,
  });
  if (result.value === 'insert') {
    await focusPage(wc);
    await cdp(wc, 'Input.insertText', { text });
    return 'filled';
  }
  return result.value;
}

const KEYS = {
  enter: ['Enter', 13], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27], backspace: ['Backspace', 8], delete: ['Delete', 46],
  arrowup: ['ArrowUp', 38], arrowdown: ['ArrowDown', 40], arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39], up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
  home: ['Home', 36], end: ['End', 35], pageup: ['PageUp', 33], pagedown: ['PageDown', 34], space: [' ', 32], f5: ['F5', 116],
};
/** Keyboard input goes to the page Leafdeck's UI has focused. App and site windows are <webview>s in that UI,
    so focus the right one first (a click in a window's title bar, for example, leaves focus in the UI). */
async function focusPage(wc) {
  const host = wc.hostWebContents;
  if (host && !host.isDestroyed()) {
    await host
      .executeJavaScript(
        `(() => { const v = [...document.querySelectorAll('webview')].find((w) => { try { return w.getWebContentsId() === ${wc.id}; } catch { return false; } }); if (v && document.activeElement !== v) v.focus(); })()`,
        true
      )
      .catch(() => {});
  }
  wc.focus();
}

async function press(wc, combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  const keyName = parts.pop() || '';
  let modifiers = 0;
  for (const m of parts.map((p) => p.toLowerCase())) {
    if (m === 'alt') modifiers |= 1;
    else if (m === 'control' || m === 'ctrl') modifiers |= 2;
    else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win') modifiers |= 4;
    else if (m === 'shift') modifiers |= 8;
  }
  await focusPage(wc);
  const known = KEYS[keyName.toLowerCase()];
  const key = known ? known[0] : keyName;
  const code = known ? known[1] : keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0;
  const printable = !known && keyName.length === 1 && !(modifiers & 6);
  // Enter carries a "\r" character like a real keyboard, or forms never submit on Enter.
  const enter = key === 'Enter' && !(modifiers & 6);
  const ch = printable ? keyName : enter ? '\r' : undefined;
  await cdp(wc, 'Input.dispatchKeyEvent', { type: ch ? 'keyDown' : 'rawKeyDown', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers, text: ch, unmodifiedText: ch });
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
}

async function screenshot(wc) {
  let img = await wc.capturePage();
  const { width } = img.getSize();
  if (width > 1400) img = img.resize({ width: 1400 });
  return img.toPNG().toString('base64');
}

const waitLoad = (wc, ms = 15_000) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, ms);
    wc.once('did-stop-loading', done);
  });

/* ---------------- The MCP server and its tools ---------------- */

/**
 * scope 'full': everything (Claude Code control). scope 'builder': App Builder sessions — only the app tools and
 * the window tools on "user:<id>" windows, plus read-only records; no sites, no desktop, no scripts.
 */
function buildServer(scope = 'full') {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = require('zod');
  const s = new McpServer({ name: scope === 'builder' ? 'leafdeck-app-builder' : 'leafdeck', version: app.getVersion() });
  const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
  const builder = scope === 'builder';
  const target = (id) => targetIn(id, scope);
  const W = z.string().describe(builder ? 'The app window id from leafdeck_app_open ("user:<id>")' : 'A window id from leafdeck_windows, or "desktop" for Leafdeck’s own desktop UI');
  const full = (name, description, shape, fn) => (builder ? null : tool(name, description, shape, fn));
  const tool = (name, description, shape, fn) =>
    s.registerTool(name, { description, inputSchema: shape }, async (args) => {
      callStarted();
      try {
        return await fn(args || {});
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message || err}` }], isError: true };
      } finally {
        callEnded();
      }
    });

  tool('leafdeck_windows', builder ? 'List the open windows of apps you built (ids start with "user:").' : 'List Leafdeck’s open windows: the desktop plus each app and site window, with ids, titles, URLs and state.', {}, async () => {
    const list = await listWindows();
    if (!builder) return text(formatWindows(list));
    const mine = list.filter((w) => w.userApp);
    return text(mine.length ? mine.map((w) => `${w.id} — ${w.title} <${w.url}>${w.active ? ' [active]' : ''}`).join('\n') : 'No app windows are open. Use leafdeck_app_open.');
  });
  full('leafdeck_open', 'Open a web address in a new site window, or open a Leafdeck app by id (tasks, contacts, calendar, notes, settings…). Returns the new window id.', {
    url: z.string().optional().describe('http(s) address to open'),
    app: z.string().optional().describe('Leafdeck app id to open instead of a URL'),
  }, async ({ url: u, app: a }) => {
    if (u) {
      if (!isWebUrl(u)) throw new Error('Only http(s) addresses can be opened');
      const id = await uiEval(`import('/js/apps/browser.js').then((b) => b.openWebPage(${JSON.stringify(u)})?.id || '')`);
      await sleep(1500);
      return text(`Opened ${u} in window ${id}`);
    }
    if (a) {
      const id = await uiEval(`import('/js/wm.js').then((m) => m.openApp(${JSON.stringify(a)})?.id || '')`);
      if (!id) throw new Error(`No app "${a}"`);
      await sleep(400);
      return text(`Opened app ${id}`);
    }
    throw new Error('Give a url or an app id');
  });
  tool('leafdeck_focus', 'Bring a window to the front (wakes it if asleep).', { window: W }, async ({ window: id }) => {
    if (builder) await target(id);
    await uiEval(`import('/js/wm.js').then((m) => { const w = m.wins.get(${JSON.stringify(id)}); if (!w) throw new Error('No window ' + ${JSON.stringify(id)}); if (w.minimized) m.restore(w); m.focus(w); w.web?.wake?.(); })`);
    return text(`Focused ${id}`);
  });
  tool('leafdeck_close', 'Close a window.', { window: W }, async ({ window: id }) => {
    if (builder) await target(id);
    await uiEval(`import('/js/wm.js').then((m) => { const w = m.wins.get(${JSON.stringify(id)}); if (w) m.closeWindow(w); })`);
    return text(`Closed ${id}`);
  });
  full('leafdeck_navigate', 'Load a URL in an existing site window.', { window: W, url: z.string() }, async ({ window: id, url: u }) => {
    const { wc, ui } = await target(id);
    if (ui) throw new Error('The desktop can’t navigate; use leafdeck_open to open a site');
    if (!isWebUrl(u)) throw new Error('Only http(s) addresses');
    wc.loadURL(u);
    await waitLoad(wc);
    return text(`${id} is now at ${wc.getURL()} — ${wc.getTitle()}`);
  });
  tool('leafdeck_snapshot', 'Read a window as an accessibility outline (roles, names, values). Each line has a uid for leafdeck_click / leafdeck_fill. Prefer this over screenshots.', {
    window: W, max: z.number().int().min(50).max(2000).optional().describe('Maximum nodes (default 500)'),
  }, async ({ window: id, max }) => {
    const { wc, ui } = await target(id);
    const head = ui ? 'Leafdeck desktop' : `${wc.getTitle()} <${wc.getURL()}>`;
    return text(`${head}\n${await snapshot(wc, max || 500)}`);
  });
  tool('leafdeck_find', 'Find text in a window and return matching outline lines with uids.', { window: W, text: z.string() }, async ({ window: id, text: q }) => {
    const { wc } = await target(id);
    const lines = (await snapshot(wc, 2000)).split('\n').filter((l) => l.toLowerCase().includes(q.toLowerCase()));
    return text(lines.length ? lines.slice(0, 60).join('\n') : `No match for "${q}"`);
  });
  tool('leafdeck_click', 'Click an element by uid (from leafdeck_snapshot).', { window: W, uid: z.number().int(), double: z.boolean().optional(), button: z.enum(['left', 'right', 'middle']).optional() },
    async ({ window: id, uid, double, button }) => {
      const { wc } = await target(id);
      const at = await click(wc, uid, { double, button });
      await sleep(300);
      return text(`Clicked uid ${uid} at ${at.x},${at.y}`);
    });
  tool('leafdeck_fill', 'Set a field by uid, replacing its contents: text fields, textareas, editable areas, <select> (option text or value), checkboxes ("true"/"false"), and pickers — date "YYYY-MM-DD", time "HH:MM", datetime-local "YYYY-MM-DDTHH:MM", color "#rrggbb".',{ window: W, uid: z.number().int(), text: z.string() }, async ({ window: id, uid, text: v }) => {
    const { wc } = await target(id);
    return text(`${await fill(wc, uid, v)} (uid ${uid})`);
  });
  tool('leafdeck_type', 'Type text into whatever is focused in a window.', { window: W, text: z.string() }, async ({ window: id, text: v }) => {
    const { wc } = await target(id);
    await focusPage(wc);
    await cdp(wc, 'Input.insertText', { text: v });
    return text(`Typed ${v.length} characters`);
  });
  tool('leafdeck_press', 'Press a key or shortcut in a window, e.g. "Enter", "Tab", "Escape", "Control+a", "Shift+Tab".', { window: W, key: z.string() }, async ({ window: id, key }) => {
    const { wc } = await target(id);
    await press(wc, key);
    await sleep(200);
    return text(`Pressed ${key}`);
  });
  tool('leafdeck_scroll', 'Scroll a window (or an element by uid) by a number of pixels; positive is down.', { window: W, uid: z.number().int().optional(), dy: z.number().optional(), dx: z.number().optional() },
    async ({ window: id, uid, dy, dx }) => {
      const { wc } = await target(id);
      let x = 200;
      let y = 200;
      if (uid != null) ({ x, y } = await center(wc, uid));
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx || 0, deltaY: dy ?? 600 });
      await sleep(250);
      return text('Scrolled');
    });
  tool('leafdeck_screenshot', 'Screenshot a window (PNG). Use leafdeck_snapshot for reading; this is for layout and images.', { window: W }, async ({ window: id }) => {
    const { wc } = await target(id);
    return { content: [{ type: 'image', data: await screenshot(wc), mimeType: 'image/png' }] };
  });
  full('leafdeck_evaluate', 'Run JavaScript in a window and return the JSON result. In "desktop" the Leafdeck modules are importable, e.g. import("/js/store.js").', { window: W, script: z.string() }, async ({ window: id, script }) => {
    const { wc } = await target(id);
    const r = await wc.executeJavaScript(`(async () => { const __r = await (async () => (${script}))(); try { return JSON.stringify(__r); } catch { return String(__r); } })()`, true);
    return text(String(r ?? 'undefined').slice(0, 30_000));
  });
  tool('leafdeck_wait', 'Wait for text to appear in a window (or just wait a number of milliseconds).', { window: W.optional(), text: z.string().optional(), ms: z.number().int().max(60_000).optional() },
    async ({ window: id, text: t, ms }) => {
      if (!t) {
        await sleep(ms || 1000);
        return text('Waited');
      }
      const { wc } = await target(id || (builder ? '' : 'desktop'));
      const until = Date.now() + (ms || 15_000);
      while (Date.now() < until) {
        const hit = await wc.executeJavaScript(`document.body?.innerText.includes(${JSON.stringify(t)})`, true).catch(() => false);
        if (hit) return text(`Found "${t}"`);
        await sleep(400);
      }
      throw new Error(`"${t}" didn’t appear within ${ms || 15_000} ms`);
    });
  /* ----- App Builder: build Leafdeck apps (folders in Documents\Leafdeck Apps; guide: leafdeck_app_guide) ----- */
  tool('leafdeck_app_guide', 'The guide for building Leafdeck apps: how they run, manifest.json, permissions, the window.leafdeck API, styling, and rules. Read it before building or changing an app.', {}, async () =>
    text(userApps.guideText()),
  );
  tool('leafdeck_app_list', 'List the Leafdeck apps the user has built, with their ids, folders and permissions.', {}, async () => {
    const list = userApps.list();
    if (!list.length) return text(`No apps yet. Folder: ${userApps.appsDir()}`);
    return text(list.map((a) => `${a.id} — ${a.name}${a.broken ? ` [BROKEN: ${a.broken}]` : ''}\n  folder: ${a.path}\n  permissions: ${a.permissions.join(', ') || 'none'}${a.hasIndex ? '' : '\n  (no index.html yet)'}`).join('\n'));
  });
  tool('leafdeck_app_create', 'Create a new Leafdeck app folder with a starter app, a brief, and the guide. Returns its id and folder; then edit the files there.', {
    name: z.string().describe('The app’s name, e.g. "Lead Follow-ups"'),
    description: z.string().optional().describe('What the app should do (becomes BRIEF.md)'),
  }, async ({ name, description }) => {
    const m = userApps.create({ name, description });
    return text(`Created app "${m.name}" (id ${m.id}) in ${m.path}\nEdit the files there; Leafdeck reloads the app on every save. Open it with leafdeck_app_open { id: "${m.id}" }.`);
  });
  tool('leafdeck_app_open', 'Open a Leafdeck app the user built (or reload it if it’s open). Returns its window id ("user:<id>") for leafdeck_screenshot, leafdeck_snapshot and leafdeck_click.', {
    id: z.string().describe('The app id (its folder name)'),
  }, async ({ id }) => {
    userApps.appDir(id);
    const r = await uiEval(`import('/js/userapps.js').then(async (m) => { await m.refreshUserApps(); return m.openUserApp(${JSON.stringify(id)}, { reload: true }); })`);
    await sleep(1500);
    const why = { permissions: ' It is waiting for the user to approve its permissions in Leafdeck; ask them to look at the app window and click “Allow and open”. Don’t click it yourself.', 'no-index': ' It has no index.html yet.', 'turned-off': ' The user has turned apps off in App Builder.' }[r.pending] || '';
    return text(`Opened ${id} in window ${r.window}.${why}`);
  });
  tool('leafdeck_app_logs', 'Read a Leafdeck app’s console output and errors (newest last). Check this after every change.', {
    id: z.string().describe('The app id'),
    clear: z.boolean().optional().describe('Clear the log after reading, so the next read shows only new lines'),
  }, async ({ id, clear }) => {
    const lines = userApps.getLogs(id, { clear: !!clear });
    if (!lines.length) return text('No console output or errors.');
    return text(lines.slice(-120).map((l) => `${new Date(l.at).toISOString().slice(11, 19)} [${l.level}] ${l.text}`).join('\n'));
  });

  tool('leafdeck_records', 'Read Leafdeck’s own data: records of a collection (tasks, contacts, events, notes, bookmarks, links), optionally filtered by text.', {
    collection: z.string(), query: z.string().optional(), limit: z.number().int().max(500).optional(),
  }, async ({ collection, query, limit }) => {
    const rows = await uiEval(`import('/js/store.js').then((m) => m.store.all(${JSON.stringify(collection)}))`);
    const q = (query || '').toLowerCase();
    const hits = (rows || []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q)).slice(0, limit || 100);
    return text(JSON.stringify(hits, null, 1).slice(0, 60_000));
  });
  return s;
}

/* ---------------- HTTP (localhost, bearer token) ---------------- */

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5_000_000) reject(new Error('Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

async function handle(req, res) {
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
  const c = cfg();
  const deny = (code, msg) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  };
  if (!req.url.startsWith('/mcp')) return deny(404, 'Not found');
  const host = String(req.headers.host || '').split(':')[0];
  if (req.headers.origin || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return deny(403, 'Local clients only');
  const auth = req.headers.authorization || '';
  const scope =
    (c.enabled && c.token && auth === `Bearer ${c.token}`) || (c.assistantToken && auth === `Bearer ${c.assistantToken}`) ? 'full' : c.builderToken && auth === `Bearer ${c.builderToken}` ? 'builder' : '';
  if (!scope) return deny(401, 'Bad token');
  let body;
  if (req.method === 'POST') {
    try {
      body = JSON.parse((await readBody(req)) || 'null');
    } catch {
      return deny(400, 'Invalid JSON');
    }
  }
  const sid = req.headers['mcp-session-id'];
  let transport = sid && transports.get(String(sid));
  if (!transport) {
    // A session id from before Leafdeck restarted. The chats outlive a restart (electron/chathost.cjs), so their Claude
    // Code still has one: "not found" is what the protocol says makes a client connect again.
    if (sid) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
    }
    if (!(req.method === 'POST' && isInitializeRequest(body))) return deny(400, 'No session; send an initialize request first');
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await buildServer(scope).connect(transport);
  }
  await transport.handleRequest(req, res, body);
}

function start() {
  if (server) return status();
  const c = ensureToken();
  server = http.createServer((req, res) => handle(req, res).catch((err) => {
    try {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } catch {}
  }));
  server.on('error', (err) => {
    console.warn('Claude Code control server:', err.message);
    server = null;
  });
  server.listen(c.port, '127.0.0.1');
  return status();
}

function stop() {
  for (const t of transports.values()) t.close().catch(() => {});
  transports.clear();
  running = 0;
  clearTimeout(idleTimer);
  setActive(false);
  if (server) {
    server.close();
    server = null;
  }
}

function setEnabled(on) {
  const c = ensureToken();
  writeConfig({ mcp: { ...c, enabled: !!on } });
  if (on) start();
  else stop();
  return status();
}

function regenerate() {
  const c = cfg();
  writeConfig({ mcp: { ...c, token: crypto.randomBytes(24).toString('base64url') } });
  if (server) {
    stop();
    start();
  }
  return status();
}

function init(d) {
  deps = d;
  if (cfg().enabled) start();
  app.on('will-quit', stop);
}

module.exports = { init, status, setEnabled, regenerate, start, stop, builderConnection, assistantConnection };
