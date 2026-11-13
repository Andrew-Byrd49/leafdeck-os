// Site Editor: a site in development (a Claude Code project, at its local dev address) in a webview, with a hands-on
// layer over it. Select any element and change its CSS in the inspector (siteeditor/inspector.js: auto layout, size,
// position, spacing, type, backgrounds, borders, effects, any other property), for that element or everything with its
// class, in a state (:hover) or at some widths only; edit text in place, pin comments on the page, and send it all to
// Claude, which works in the project's folder and puts the changes into the source. After its turn the page reloads and each change is checked against the page;
// Claude's answers to comments thread under their pins. "Edit in Designer" takes an element to Leafdeck Designer and
// "Send back to site" brings the redesigned component here as a change.
// The page half is public/js/siteeditor/inpage.js (injected by electron/siteeditor.cjs, which also finds where styles
// come from over CDP and keeps the state and hand-off in the profile, outside the project).
import { esc, $, uid, debounce } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, openApp, wins, toast, showMenu, focus, closeMenu, activeWindow } from '../wm.js';
import { shell } from '../shell.js';
import { createChat, listen } from '../agentchat.js';
import { confirmDialog, ask } from '../dialogs.js';
import { glyph } from '../designer/glyphs.js';
import { createInspector } from '../siteeditor/inspector.js';
import { pickFiles } from '../filepicker.js';

const supported = !!shell?.siteEditor && !!shell?.projects && !!shell?.agentChat;
const APP = 'siteeditor';
const PARTITION = 'persist:web';
const chatIdOf = (pid) => `@site:${pid}`;

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/** origin + path + query: the page a change or comment belongs to. */
const pageOf = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname + x.search;
  } catch {
    return String(u || '');
  }
};
const short = (s, n = 60) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
/* ---------------- state per project (electron/siteeditor.cjs keeps it in the profile) ---------------- */

const blank = () => ({ v: 1, url: '', changes: [], comments: [], next: { change: 1, comment: 1 } });
const states = new Map(); // pid -> state
async function loadState(pid) {
  if (!states.has(pid)) {
    const s = (await shell.siteEditor.state(pid).catch(() => null)) || blank();
    s.changes ||= [];
    s.comments ||= [];
    s.next ||= { change: 1, comment: 1 };
    states.set(pid, s);
  }
  return states.get(pid);
}
const savers = new Map();
function saveState(pid) {
  if (!savers.has(pid)) savers.set(pid, debounce(() => shell.siteEditor.save(pid, states.get(pid)).catch((e) => toast(`Couldn’t save the site edits: ${e.message}`, 'error')), 300));
  savers.get(pid)();
}

/** A component designed in Designer, coming back to the site (designer/handoff.js → "Send back to site"). */
export async function receiveComponent({ project, selector, url, html, css, design, name }) {
  if (!supported) return;
  const s = await loadState(project);
  const old = s.changes.find((c) => c.kind === 'component' && c.selector === selector && c.status !== 'applied');
  const ch = old || { id: uid(), n: s.next.change++, kind: 'component', page: pageOf(url), selector, label: name || selector, status: 'pending', created: Date.now() };
  Object.assign(ch, { html, css, design, status: 'pending' });
  if (!old) s.changes.push(ch);
  saveState(project);
  const w = openApp(APP, { project, url });
  w?.siteEditor?.refresh(ch);
  toast(`“${name || 'The component'}” is in the site’s changes, shown on the page. Send it to Claude when you’re ready.`);
}

/* ---------------- the app ---------------- */

let launchWith = null; // { project, url } from openApp(APP, …)
const app = {
  id: APP,
  name: 'Site Editor',
  icon: 'layout',
  color: 'purple',
  size: [1320, 820],
  min: [820, 500],
  hidden: !supported,
  launch(opts) {
    launchWith = opts?.project ? { project: String(opts.project), url: opts.url ? String(opts.url) : '' } : null;
    if (launchWith && wins.has(APP)) wins.get(APP).siteEditor?.show(launchWith.project, launchWith.url);
  },
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">The Site Editor lives in the Leafdeck app</div><p>Editing a site in development with Claude needs the desktop app and Claude Code.</p></div>`;
      return;
    }
    let projects = [];
    let pid = store.get('siteeditor:project', null);
    let state = null;
    let wv = null; // the <webview>
    let wcId = 0;
    let page = ''; // pageOf(the current address)
    let title = '';
    let mode = 'select';
    let tab = store.get('siteeditor:tab', 'edit');
    let sideOpen = store.get('siteeditor:side', true);
    let selected = null; // info from the page
    let activeComment = null;
    let chat = null;
    let unlisten = null;
    let verifyNext = false; // after Claude's turn: the next load checks the changes
    let server = { status: 'stopped', url: '', log: '', detected: null }; // the project's dev server (electron/siteserver.cjs)
    let logOpen = false; // the output drawer, opened by the user (it also opens while starting and when it fails)
    const startedHere = new Set(); // projects whose server this window started: stopped when it closes
    let scope = { target: '', state: '', media: '' }; // what the inspector's styles apply to: a class, a state, some widths
    let declared = null; // the selection's values as the project's CSS has them (electron/siteeditor.cjs inspect)
    let rules = null; // the page's rules for it, when the inspector's list is open
    let inspSeq = 0;
    let pageVars = []; // the page's custom properties
    let pageBreaks = []; // its breakpoints ('max-width: 768px'), and the widths the user asked for
    const customBreaks = [];
    let viewW = 0; // the page's width while it's narrowed (0: all the room there is)
    const undoStack = [];
    const redoStack = [];
    let liveOpen = false; // a drag is changing a value: one step to undo, however far it goes

    win.body.innerHTML = `<div class="se">
      <div class="se-top">
        <button class="se-proj" data-se="project" title="Project">${icon('folder', 14)}<b></b>${icon('down', 11)}</button>
        <button class="tb-btn" data-se="back" title="Back">${icon('left', 15)}</button>
        <button class="tb-btn" data-se="reload" title="Reload">${icon('refresh', 15)}</button>
        <button class="tb-btn se-srv" data-se="server" title="Dev server">${icon('play', 14)}<i></i></button>
        <form class="se-url"><input type="text" spellcheck="false" placeholder="http://localhost:5173/" aria-label="Address"></form>
        <button class="tb-btn se-width" data-se="width" title="Page width: see it, and style it, as a tablet or a phone has it">${icon('display', 14)}<b></b></button>
        <button class="tb-btn se-undo" data-se="undo" title="Undo (Ctrl+Z)">${glyph('undo', 15)}</button>
        <button class="tb-btn se-undo" data-se="redo" title="Redo (Ctrl+Shift+Z)">${glyph('redo', 15)}</button>
        <span class="se-modes" role="group" aria-label="Mode">
          <button type="button" data-mode="browse" title="Browse: the page works as usual">${icon('globe', 13)} Browse</button>
          <button type="button" data-mode="select" title="Select: click an element to adjust it (S)">${icon('target', 13)} Select</button>
          <button type="button" data-mode="comment" title="Comment: click where a comment goes (C)">${icon('pin', 13)} Comment</button>
        </span>
        <button class="btn primary se-send" data-se="send">${icon('claude', 13)} <span>Send to Claude</span></button>
        <button class="tb-btn se-sidebtn" data-se="side" title="Show or hide the panel">${icon('split-col', 15)}</button>
      </div>
      <div class="se-main">
        <div class="se-col">
          <div class="se-page"></div>
          <div class="se-log" hidden>
            <div class="se-log-head"><i class="se-log-dot"></i><b>Dev server</b><code></code><span class="se-log-status"></span><span class="se-log-acts"></span><button class="tb-btn" data-se="log-close" title="Hide the output">${icon('x', 13)}</button></div>
            <pre></pre>
          </div>
        </div>
        <aside class="se-side">
          <div class="se-tabs" role="tablist">
            <button type="button" data-tab="edit">Edit</button>
            <button type="button" data-tab="changes">Changes <i class="se-count" data-count="changes"></i></button>
            <button type="button" data-tab="comments">Comments <i class="se-count" data-count="comments"></i></button>
            <button type="button" data-tab="claude">${icon('claude', 12)} Claude</button>
          </div>
          <div class="se-pane" data-pane="edit"></div>
          <div class="se-pane" data-pane="changes" hidden></div>
          <div class="se-pane" data-pane="comments" hidden></div>
          <div class="se-pane se-pane-claude" data-pane="claude" hidden></div>
        </aside>
      </div>
    </div>`;
    const root = $('.se', win.body);
    const pageEl = $('.se-page', win.body);
    const urlInput = $('.se-url input', win.body);
    const pane = (k) => $(`.se-pane[data-pane="${k}"]`, win.body);

    const project = () => projects.find((p) => p.id === pid) || null;
    const run = (m, o) => (wcId ? shell.siteEditor.run(wcId, m, o).catch((e) => (m === 'start' ? null : (console.warn('site editor:', e.message), null))) : Promise.resolve(null));
    const pending = (c) => c.status !== 'applied';
    const pageChanges = () => (state?.changes || []).filter((c) => c.page === page);
    const pageComments = () => (state?.comments || []).filter((c) => c.page === page);
    const save = () => pid && saveState(pid);

    /* ----- the project and its page ----- */

    async function loadProjects() {
      projects = await shell.projects.list().catch(() => []);
    }
    async function show(id, url = '') {
      await loadProjects();
      if (id && !projects.some((p) => p.id === id)) id = null;
      if (pid && pid !== id) {
        await run('stop');
        chat?.destroy();
        chat = null;
        unlisten?.();
        unlisten = null;
        $('.se-pane-claude', win.body).replaceChildren();
      }
      if (pid !== id) undoStack.length = redoStack.length = 0;
      pid = id;
      store.set('siteeditor:project', pid);
      pick(null);
      activeComment = null;
      state = pid ? await loadState(pid) : null;
      server = { status: 'stopped', url: '', log: '', detected: null };
      if (pid) {
        if (url) state.url = url;
        unlisten = listen(chatIdOf(pid), (ev) => ev.t === 'done' && afterClaude(ev));
        server = (await shell.siteEditor.server.status(pid).catch(() => null)) || server;
        // Started from here last time: start it again (it stops when the window closes or Leafdeck quits).
        if (state.server?.started && !['running', 'starting'].includes(server.status)) startServer();
      }
      drawServer();
      drawTop();
      if (!pid) {
        destroyView();
        pageEl.innerHTML = `<div class="se-start"><div class="se-start-box">
          <h2>Edit a site in development, with Claude</h2>
          <p>Open a project’s site from its local dev server. Adjust elements, edit text and pin comments on the page; Claude puts it all into the source.</p>
          ${projects.length ? `<div class="se-start-list">${projects.map((p) => `<button type="button" class="se-start-proj" data-open="${esc(p.id)}">${icon('folder', 15)}<span><b>${esc(p.name)}</b><small>${esc(p.path)}</small></span></button>`).join('')}</div>` : ''}
          <button type="button" class="btn${projects.length ? '' : ' primary'}" data-se="add">${icon('plus', 12)} Add a project folder</button>
        </div></div>`;
        win.setTitle('Site Editor');
        drawAll();
        return;
      }
      win.setTitle(`${project().name} · Site Editor`);
      if (!state.url) {
        destroyView();
        drawStart();
        drawAll();
        return;
      }
      navigate(state.url);
      drawAll();
    }
    /** No address yet: start the project's dev server here (the command it found, editable), or open an address. */
    function drawStart() {
      const d = server.detected;
      const cmd = state.server?.command ?? (d?.kind === 'command' ? d.command : '');
      const busy = server.status === 'starting';
      pageEl.innerHTML = `<div class="se-start"><div class="se-start-box">
        <h2>${esc(project().name)}</h2>
        <p>Start its dev server here, or open the address it already runs on.</p>
        <form class="se-start-srv">
          <div class="se-start-url"><input type="text" name="command" value="${esc(cmd)}" spellcheck="false" placeholder="Empty: serve the folder as plain HTML" aria-label="Command that starts the dev server"><button class="btn primary" type="submit"${busy ? ' disabled' : ''}>${icon('play', 12)} ${busy ? 'Starting…' : 'Start'}</button></div>
          <p class="se-hint">${d ? `Found ${esc(d.why)}. ` : ''}It runs in the project’s folder; leave it empty to serve the folder as plain HTML.</p>
        </form>
        <div class="se-start-or">or open an address</div>
        <form class="se-start-url"><input type="text" value="http://localhost:${d?.port || 5173}/" spellcheck="false" aria-label="Address"><button class="btn" type="submit">Open</button></form>
      </div></div>`;
    }
    function destroyView() {
      if (wv) {
        wv.remove();
        wv = null;
      }
      wcId = 0;
      page = '';
    }
    function navigate(url) {
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
      state.url = url;
      save();
      urlInput.value = url;
      if (wv) {
        wv.loadURL(url).catch(() => {}); // the same address again loads it again (a server that just started)
        return;
      }
      pageEl.innerHTML = '';
      const view = document.createElement('webview');
      view.setAttribute('partition', PARTITION);
      view.setAttribute('allowpopups', '');
      view.setAttribute('src', url);
      pageEl.append(view);
      wv = view;
      view.addEventListener('dom-ready', () => {
        try {
          wcId = view.getWebContentsId();
        } catch {}
      });
      const loaded = (u) => {
        if (!u || /^about:blank/.test(u)) return;
        state.url = u;
        urlInput.value = u;
        page = pageOf(u);
        pick(null);
        save();
        start();
        run('vars').then((v) => (pageVars = Array.isArray(v) ? v : []));
        run('widths').then((w) => (pageBreaks = [...new Set([...(Array.isArray(w) ? w : []), ...customBreaks])]));
      };
      view.addEventListener('did-finish-load', () => loaded(view.getURL()));
      view.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && loaded(e.url));
      view.addEventListener('page-title-updated', (e) => (title = e.title));
      view.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3 || !e.isMainFrame) return; // aborted (a redirect) or a frame
        const off = !['running', 'starting'].includes(server.status);
        pageEl.insertAdjacentHTML('beforeend', `<div class="se-fail"><b>Couldn’t open ${esc(e.validatedURL || url)}</b><span>${esc(e.errorDescription || '')}. ${server.status === 'starting' ? 'The dev server is starting; the page opens when it’s ready.' : 'Is the dev server running?'}</span><span class="se-fail-acts">${off ? `<button class="btn small primary" data-se="srv-start">${icon('play', 11)} Start the dev server</button>` : ''}<button class="btn small" data-se="reload">Try again</button></span></div>`);
      });
      view.addEventListener('did-start-loading', () => $('.se-fail', pageEl)?.remove());
      view.addEventListener('focus', () => {
        closeMenu();
        focus(win);
      });
    }
    /** The overlay into the page, with this page's pending changes and comments. */
    async function start() {
      if (!wcId) return;
      if (verifyNext) {
        verifyNext = false;
        await verifyChanges();
      }
      const r = await run('start', { mode, changes: pageChanges().filter(pending), comments: pageComments(), selected: selected?.selector || null, props: extraProps(), undo: true });
      if (r?.title) title = r.title;
      if (selected && scope.state) shell.siteEditor.forceState(wcId, selected.selector, scope.state).catch(() => {}); // a reload let go of it
      drawAll();
    }

    /* ----- the project's dev server (electron/siteserver.cjs) ----- */

    const srvOn = () => ['running', 'starting'].includes(server.status);
    const srvLabel = () => (server.kind === 'static' ? 'plain HTML (built in)' : server.command || '');
    /** Start (or restart) it with the saved command, else the one it found; `command` changes the saved one. */
    async function startServer(command) {
      if (!pid) return;
      const id = pid;
      state.server = { ...(state.server || {}), started: true };
      // The command it found isn't saved: it follows the project (no "npm install &&" once node_modules is there).
      const found = server.detected?.kind === 'command' ? server.detected.command : '';
      if (command != null) {
        if (command === found) delete state.server.command;
        else state.server.command = command;
      }
      save();
      startedHere.add(id);
      const plan = state.server.command != null ? { command: state.server.command } : null;
      Object.assign(server, { status: 'starting', url: '', log: '' });
      drawServer();
      if (!state.url) drawStart();
      try {
        const r = await shell.siteEditor.server.start(id, plan);
        if (id !== pid) return;
        const before = server.status; // its 'running' event may have come first
        Object.assign(server, r, { detected: server.detected });
        if (server.status === 'running' && before !== 'running' && server.url) serverReady(server.url);
      } catch (err) {
        toast(`Couldn’t start the dev server: ${err.message}`, 'error');
        if (id === pid) server.status = 'failed';
      }
      if (id !== pid) return;
      drawServer();
      if (!state.url) drawStart();
    }
    async function stopServer() {
      if (!pid) return;
      state.server = { ...(state.server || {}), started: false };
      save();
      await shell.siteEditor.server.stop(pid).catch(() => {});
    }
    /** It's serving at `url`: show the page (the same page on it when the address was its own). */
    function serverReady(url) {
      const was = state.server?.origin;
      state.server = { ...(state.server || {}), origin: new URL(url).origin };
      save();
      let to = url;
      try {
        const cur = state.url ? new URL(state.url) : null;
        if (cur && (cur.origin === new URL(url).origin || cur.origin === was)) to = new URL(cur.pathname + cur.search + cur.hash, url).href;
      } catch {}
      if (!logOpen) $('.se-log', win.body).hidden = true;
      navigate(to);
      drawAll();
    }
    function onServer(ev) {
      if (ev.t === 'log') {
        server.log = (server.log + ev.text).slice(-65536);
        const pre = $('.se-log pre', win.body);
        const end = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        pre.textContent = server.log;
        if (end) pre.scrollTop = pre.scrollHeight;
        return;
      }
      const was = server.status;
      Object.assign(server, { status: ev.status, url: ev.url, kind: ev.kind, command: ev.command, code: ev.code });
      if (ev.status === 'running' && was !== 'running' && ev.url) serverReady(ev.url);
      if (ev.status === 'failed' && was !== 'failed') {
        $('.se-log', win.body).hidden = false; // what went wrong
        toast(`The dev server stopped${ev.code != null ? ` (exit code ${ev.code})` : ''}. Its output is below the page.`, 'error');
      }
      drawServer();
      if (!state?.url && pid) drawStart();
    }
    const offServer = shell.on('siteeditor:server', (ev) => ev && ev.project === pid && onServer(ev));
    /** The top bar's button and the output drawer. */
    function drawServer() {
      const btn = $('.se-srv', win.body);
      const st = server.status;
      btn.dataset.status = st;
      btn.title = st === 'running' ? `Dev server: running at ${server.url}` : st === 'starting' ? 'Dev server: starting…' : st === 'failed' ? 'Dev server: stopped with an error' : 'Dev server: not started here';
      btn.firstElementChild.outerHTML = icon(srvOn() ? 'terminal' : 'play', 14);
      const log = $('.se-log', win.body);
      log.dataset.status = st;
      if (st === 'starting') log.hidden = false;
      $('code', log).textContent = srvLabel();
      $('.se-log-status', log).textContent = st === 'running' ? server.url : st === 'starting' ? 'Starting…' : st === 'failed' ? `Stopped${server.code != null ? ` (exit code ${server.code})` : ''}` : 'Stopped';
      $('.se-log-acts', log).innerHTML = srvOn()
        ? `<button class="btn small" data-se="srv-restart">Restart</button><button class="btn small" data-se="srv-stop">Stop</button>`
        : `<button class="btn small primary" data-se="srv-start">${icon('play', 11)} Start</button>`;
      const pre = $('pre', log);
      pre.textContent = server.log || '';
      pre.scrollTop = pre.scrollHeight;
    }
    function serverMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      const log = $('.se-log', win.body);
      const cmd = state.server?.command ?? (server.detected?.kind === 'command' ? server.detected.command : '');
      showMenu(r.left, r.bottom + 4, [
        { label: srvOn() ? `Running: ${srvLabel()}` : `Command: ${cmd || 'plain HTML (built in)'}`, disabled: true },
        '-',
        srvOn() ? { label: 'Restart Dev Server', act: () => startServer() } : { label: 'Start Dev Server', act: () => startServer() },
        srvOn() ? { label: 'Stop Dev Server', act: () => stopServer() } : null,
        { label: log.hidden ? 'Show Output' : 'Hide Output', act: () => ((logOpen = log.hidden), (log.hidden = !log.hidden), drawServer()) },
        { label: 'Change Command…', act: () => changeCommand() },
      ].filter(Boolean));
    }
    async function changeCommand() {
      const d = server.detected;
      const cur = state.server?.command ?? (d?.kind === 'command' ? d.command : '');
      const r = await ask({
        win,
        title: 'Dev server command',
        message: 'The command that starts this project’s dev server, run in its folder. Leave it empty to serve the folder as plain HTML.',
        detail: d ? `Leafdeck found ${d.why}${d.kind === 'command' ? `: ${d.command}` : ''}.` : '',
        fields: [{ name: 'command', label: 'Command', value: cur, placeholder: 'npm run dev' }],
        buttons: [{ label: 'Cancel', value: null }, ...(d?.kind === 'command' && cur !== d.command ? [{ label: 'Use What It Found', value: 'reset' }] : []), { label: srvOn() ? 'Save and Restart' : 'Save and Start', value: 'ok', primary: true }],
      });
      if (!r?.button) return;
      if (r.button === 'reset') {
        delete state.server.command;
        return startServer();
      }
      startServer(String(r.values?.command || '').trim());
    }

    /* ----- the top bar ----- */

    function drawTop() {
      const p = project();
      $('.se-proj b', win.body).textContent = p ? p.name : 'Choose a project';
      root.classList.toggle('no-project', !p);
      root.classList.toggle('side-closed', !sideOpen);
      for (const b of win.body.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
      const n = (state?.changes || []).filter(pending).length + (state?.comments || []).filter((c) => c.status !== 'resolved' && !lastIsClaude(c)).length;
      const send = $('.se-send', win.body);
      send.disabled = !p || !n;
      send.querySelector('span').textContent = n ? `Send to Claude (${n})` : 'Send to Claude';
      const wb = $('.se-width', win.body);
      wb.classList.toggle('on', !!viewW);
      wb.querySelector('b').textContent = viewW ? String(viewW) : '';
    }
    const lastIsClaude = (c) => c.replies?.length && c.replies.at(-1).from === 'claude';

    function setMode(m) {
      mode = m;
      drawTop();
      run('mode', { mode });
      if (m === 'comment' && tab === 'edit') setTab('comments');
    }
    function setTab(t) {
      tab = t;
      store.set('siteeditor:tab', t);
      for (const b of win.body.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === t);
      for (const p of win.body.querySelectorAll('.se-pane')) p.hidden = p.dataset.pane !== t;
      if (t === 'claude') ensureChat()?.focus();
      drawPane();
    }
    function drawAll() {
      drawTop();
      for (const el of win.body.querySelectorAll('[data-count]')) {
        const k = el.dataset.count;
        const n = k === 'changes' ? (state?.changes || []).filter(pending).length : (state?.comments || []).filter((c) => c.status !== 'resolved').length;
        el.textContent = n || '';
      }
      setTab(tab);
    }
    function drawPane() {
      if (tab === 'edit') drawInspector();
      else if (tab === 'changes') drawChanges();
      else if (tab === 'comments') drawComments();
    }

    /* ----- the inspector (siteeditor/inspector.js draws it and reads its fields; the changes are kept here) ----- */

    const sameScope = (c) => (c.target || '') === scope.target && (c.state || '') === scope.state && (c.media || '') === scope.media;
    /** The pending style change the inspector is working on: the selection's (or its class's), in the scope chosen. */
    const styleChange = () => (selected && (state?.changes || []).find((c) => c.page === page && c.kind === 'style' && pending(c) && sameScope(c) && (scope.target || c.selector === selected.selector))) || null;
    /** Every pending style change that reaches the selection, whatever its scope. */
    const reaching = () => (selected ? (state?.changes || []).filter((c) => c.page === page && c.kind === 'style' && pending(c) && (c.target ? (selected.targets || []).some((t) => t.selector === c.target) : c.selector === selected.selector)) : []);
    const extraProps = () => [...new Set(reaching().flatMap((c) => Object.keys(c.props || {})))];
    const rulesOpen = () => store.get('siteeditor:inspector', {}).closed?.rules === false;

    /** A new selection (or none): its scope starts over, and what the project's CSS says about it is read. */
    function pick(inf) {
      const same = !!inf && inf.selector === selected?.selector;
      selected = inf || null;
      if (same) return;
      declared = null;
      rules = null;
      inspSeq++;
      if (scope.state && wcId) shell.siteEditor.forceState(wcId, null, '').catch(() => {});
      scope = { target: '', state: '', media: scope.media };
      if (selected) readDeclared();
    }
    async function readDeclared(withRules = rulesOpen()) {
      const sel = selected?.selector;
      if (!sel || !wcId) return;
      const seq = ++inspSeq;
      const r = await shell.siteEditor.inspect(wcId, sel, { props: [...new Set([...Object.keys(selected.styles), ...extraProps()])], state: scope.state, rules: withRules }).catch(() => null);
      if (seq !== inspSeq || selected?.selector !== sel) return;
      declared = r?.props || {};
      if (withRules) rules = r?.rules || [];
      if (tab === 'edit') drawInspector();
    }
    /** The selection as the page has it now (after a change, a resize, a state). */
    async function refreshSelected() {
      const sel = selected?.selector;
      if (sel) {
        const inf = await run('info', { selector: sel, props: extraProps() });
        if (inf && selected?.selector === sel) selected = inf;
      }
      drawAll();
    }
    async function setScope(patch) {
      if (!selected) return;
      if (patch.media === 'custom') {
        const r = await ask({ title: 'Style it at some widths only', message: 'What you set will apply only while the page is that wide: a media query in the project’s CSS.', fields: [{ name: 'w', label: 'Width in pixels', type: 'number', value: String(viewW || 768) }], buttons: [{ label: 'Cancel', value: null }, { label: 'This Width and Wider', value: 'min' }, { label: 'This Width and Narrower', value: 'max', primary: true }], win });
        const w = Math.round(parseFloat(r?.values?.w));
        if (!r || !(w > 0)) return drawInspector();
        patch = { media: `${r.button}-width: ${w}px` };
        if (!customBreaks.includes(patch.media)) customBreaks.push(patch.media);
        if (!pageBreaks.includes(patch.media)) pageBreaks.push(patch.media);
      }
      const sel = selected.selector;
      Object.assign(scope, patch);
      if ('state' in patch && wcId) await shell.siteEditor.forceState(wcId, scope.state ? sel : null, scope.state).catch(() => false);
      if (selected?.selector !== sel) return;
      if ('state' in patch) {
        declared = null;
        rules = null;
        readDeclared();
      }
      refreshSelected();
    }
    const inspector = createInspector(pane('edit'), {
      setProps: (props, o) => setProps(props, o),
      setScope: (patch) => setScope(patch),
      select: async (selector) => {
        const inf = await run('select', { selector });
        if (!inf) return;
        pick(inf);
        drawAll();
      },
      hint: (kind, side) => run('hint', { kind, side }),
      wantRules: () => readDeclared(true),
    });
    function drawInspector() {
      const host = pane('edit');
      if (!pid || !selected) {
        inspector.clear();
        host.innerHTML = !pid
          ? `<div class="se-empty"><p>Choose a project to start.</p></div>`
          : `<div class="se-empty">${icon('target', 26)}<p>${mode === 'select' ? 'Click anything on the page to change its layout, size, spacing, type, colors and the rest of its CSS. Double-click text to edit it in place.' : 'Switch to <b>Select</b> and click an element to change it.'}</p>
          <p class="se-hint">Changes show on the page right away and go to Claude when you send them; nothing in the project changes until then.</p></div>`;
        return;
      }
      const ch = styleChange();
      const others = new Set(reaching().filter((c) => c !== ch && (!c.state || c.state === scope.state)).flatMap((c) => Object.keys(c.props || {})));
      inspector.draw({ selected, declared, rules, change: ch, textChange: changeFor(selected.selector, 'text'), scope, vars: pageVars, breaks: pageBreaks, others });
    }

    /* ----- the page's width ----- */

    const WIDTHS = [[0, 'All the Room There Is'], [1024, 'Small Laptop · 1024'], [768, 'Tablet · 768'], [390, 'Phone · 390']];
    /** The media query a narrowed page stands for: the page's own breakpoint that covers it, when it has one. */
    function mediaFor(w) {
      if (!w) return '';
      const own = pageBreaks.filter((m) => /^max-width: /.test(m)).map((m) => parseFloat(m.slice(11))).filter((n) => n >= w).sort((a, b) => a - b)[0];
      return `max-width: ${own || (w <= 480 ? 480 : w)}px`;
    }
    function setWidth(w) {
      viewW = w ? Math.min(3000, Math.max(240, Math.round(w))) : 0;
      pageEl.classList.toggle('sized', !!viewW);
      pageEl.style.setProperty('--se-w', `${viewW}px`);
      scope.media = mediaFor(viewW); // what's set at a phone's width is for that width, until "All widths" is chosen
      drawTop();
      // The page lays out again at the new width: read the selection once it has.
      setTimeout(() => {
        if (selected) readDeclared();
        refreshSelected();
      }, 260);
    }
    function widthMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      const own = [...new Set(pageBreaks.map((m) => parseFloat(m.split(': ')[1])).filter((n) => n >= 240))].sort((a, b) => b - a).slice(0, 8);
      showMenu(r.left, r.bottom + 4, [
        ...WIDTHS.map(([w, label]) => ({ label, checked: viewW === w, act: () => setWidth(w) })),
        ...(own.length ? ['-', { header: 'This page’s breakpoints' }, ...own.map((w) => ({ label: `${w} px`, checked: viewW === w, act: () => setWidth(w) }))] : []),
        '-',
        {
          label: 'Another Width…',
          act: async () => {
            const a = await ask({ title: 'Page width', fields: [{ name: 'w', label: 'Width in pixels', type: 'number', value: String(viewW || 600) }], win });
            const w = parseFloat(a?.values?.w);
            if (a && w > 0) setWidth(w);
          },
        },
      ]);
    }

    /* ----- undo ----- */

    const snap = () => JSON.stringify(state.changes);
    /** Before a change to the changes: a step to come back to. */
    function remember() {
      if (!state) return;
      const s = snap();
      if (undoStack.at(-1) !== s) undoStack.push(s);
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
    }
    async function travel(from, to) {
      if (!state) return;
      const now = snap();
      let s = from.pop();
      while (s !== undefined && s === now) s = from.pop();
      if (s === undefined) return;
      to.push(now);
      state.changes = JSON.parse(s);
      liveOpen = false;
      save();
      await start(); // the page takes the changes as they are now
      await refreshSelected();
    }
    const undo = () => travel(undoStack, redoStack);
    const redo = () => travel(redoStack, undoStack);

    /* ----- changes ----- */

    const changeFor = (selector, kind) => (state?.changes || []).find((c) => c.page === page && c.selector === selector && c.kind === kind && pending(c)) || null;
    /** Set properties on the selection, in the scope chosen: { property: value }, null to take one back. `live`: a drag
        or a color being picked, shown on the page while the inspector's fields stay as they are. */
    function setProps(props, { live = false } = {}) {
      if (!selected || !state) return;
      const sel = selected.selector;
      let ch = styleChange();
      if (!ch && Object.values(props).every((v) => v == null || v === '')) return live ? null : drawAll();
      if (!liveOpen) remember();
      liveOpen = live;
      if (!ch) {
        ch = { id: uid(), n: state.next.change++, kind: 'style', page, selector: sel, label: selected.label, html: selected.html.slice(0, 1200), props: {}, origins: {}, status: 'pending', created: Date.now() };
        if (scope.target) ch.target = scope.target;
        if (scope.state) ch.state = scope.state;
        if (scope.media) ch.media = scope.media;
        state.changes.push(ch);
      }
      const fresh = [];
      for (const [prop, value] of Object.entries(props)) {
        const had = ch.props[prop];
        const before = had ? had.before : (selected.base?.[prop] ?? selected.styles[prop] ?? '');
        const written = !scope.target && declared?.[prop] && !declared[prop].inherited ? declared[prop].value : null;
        // Taken back, or back to how the project has it: not a change anymore.
        if (value == null || value === '' || value === before || value === written) {
          delete ch.props[prop];
          delete ch.origins[prop];
        } else if (had) had.after = value;
        else {
          ch.props[prop] = { before, after: value };
          if (declared?.[prop]) ch.origins[prop] = declared[prop];
          else fresh.push(prop);
        }
      }
      ch.status = 'pending';
      const gone = !Object.keys(ch.props).length;
      if (gone) state.changes = state.changes.filter((c) => c !== ch);
      const shown = gone ? run('revert', { id: ch.id }) : run('apply', ch);
      if (fresh.length && !gone && wcId) {
        shell.siteEditor.inspect(wcId, sel, { props: fresh, state: scope.state }).then((r) => {
          Object.assign(ch.origins, r?.props || {});
          save();
          if (tab === 'edit' && selected?.selector === sel) drawInspector();
        }, () => {});
      }
      save();
      if (live) return;
      drawAll();
      shown.then(refreshSelected); // what else moved with it (a width when the display changed)
    }
    /** A text edit: { after } from the inspector's box, or the page's { after, rich, beforeHtml, afterHtml } (in-place, formatting kept). */
    function setText({ after, rich = false, beforeHtml = null, afterHtml = null }) {
      if (!selected || !state) return;
      after = String(after ?? '');
      const sel = selected.selector;
      let ch = changeFor(sel, 'text');
      const before = ch?.before ?? selected.text;
      remember();
      const same = rich ? (afterHtml || '').replace(/\s+/g, ' ').trim() === (ch?.beforeHtml ?? beforeHtml ?? selected.inner ?? '').replace(/\s+/g, ' ').trim() : after.trim() === before.trim();
      if (same) {
        if (ch) {
          state.changes = state.changes.filter((c) => c !== ch);
          run('revert', { id: ch.id });
        }
      } else {
        if (!ch) {
          ch = { id: uid(), n: state.next.change++, kind: 'text', page, selector: sel, label: selected.label, html: selected.html.slice(0, 1200), status: 'pending', created: Date.now() };
          state.changes.push(ch);
        }
        Object.assign(ch, { before, after, status: 'pending' });
        if (rich) Object.assign(ch, { rich: true, beforeHtml: ch.beforeHtml ?? beforeHtml ?? selected.inner ?? '', afterHtml: afterHtml || '' });
        else Object.assign(ch, { rich: false, beforeHtml: undefined, afterHtml: undefined });
        run('apply', ch);
      }
      save();
      drawAll();
    }
    function removeChange(ch) {
      remember();
      state.changes = state.changes.filter((c) => c !== ch);
      if (ch.page === page) run('revert', { id: ch.id });
      save();
      drawAll();
    }
    function drawChanges() {
      const host = pane('changes');
      const list = state?.changes || [];
      if (!list.length) return (host.innerHTML = `<div class="se-empty">${icon('sliders', 26)}<p>No changes yet. Select an element and adjust it, edit text in place, or send a component here from Designer.</p></div>`);
      const scopeOf = (c) => [c.target && `every ${c.target}`, c.state && `:${c.state}`, c.media && c.media.replace('max-width: ', '≤ ').replace('min-width: ', '≥ ')].filter(Boolean).join(' · ');
      const kindOf = (c) => (c.kind === 'text' ? 'Text' : c.kind === 'component' ? 'Component' : [scopeOf(c), Object.keys(c.props || {}).join(', ')].filter(Boolean).join(': '));
      const status = (c) => ({ pending: '', sent: 'Sent', applied: 'Applied', missing: 'Not applied' })[c.status] || '';
      host.innerHTML = `<div class="se-list">
        ${list.map((c) => `<div class="se-item${c.status === 'applied' ? ' done' : c.status === 'missing' ? ' miss' : ''}${selected && c.selector === selected.selector && c.page === page ? ' on' : ''}" data-change="${c.id}" role="button" tabindex="0">
            <i class="se-n">${c.n}</i><span><b>${esc(c.label || c.selector)}</b><small>${esc(short(kindOf(c), 70))}${c.page !== page ? ` · ${esc(short(c.page.replace(/^https?:\/\/[^/]+/, '') || '/', 30))}` : ''}</small></span>
            ${status(c) ? `<em class="se-status">${status(c)}</em>` : ''}
            <button type="button" class="cc-x" data-remove-change="${c.id}" title="${c.status === 'applied' ? 'Remove from the list' : 'Take it back'}">${icon('x', 11)}</button></div>`).join('')}
        <div class="se-list-actions">${list.some((c) => c.status === 'applied') ? `<button type="button" class="btn small" data-se="clear-applied">Clear applied</button>` : ''}<button type="button" class="btn small" data-se="discard-all">Discard all</button></div>
      </div>`;
    }

    /* ----- comments ----- */

    function addComment(ev) {
      const c = { id: uid(), n: state.next.comment++, page, selector: ev.selector, label: ev.label || ev.selector, offset: ev.offset, rect: ev.rect, text: String(ev.text || '').slice(0, 4000), replies: [], status: 'open', created: Date.now() };
      state.comments.push(c);
      save();
      pins();
      drawAll();
    }
    function pins(active) {
      run('pins', { comments: pageComments(), ...(active !== undefined ? { active } : {}) });
    }
    function drawComments() {
      const host = pane('comments');
      const list = state?.comments || [];
      if (!list.length) return (host.innerHTML = `<div class="se-empty">${icon('pin', 26)}<p>No comments yet. Switch to <b>Comment</b> and click where it goes; tell Claude what you want there.</p><button type="button" class="btn small" data-mode="comment">${icon('pin', 12)} Comment</button></div>`);
      host.innerHTML = `<div class="se-list">
        ${list.map((c) => `<div class="se-item se-comment${c.status === 'resolved' ? ' done' : ''}${c.id === activeComment ? ' on' : ''}" data-comment="${c.id}" role="button" tabindex="0">
            <i class="se-n pin${lastIsClaude(c) ? ' replied' : ''}${c.status === 'resolved' ? ' resolved' : ''}">${c.n}</i>
            <span><b>${esc(short(c.text, 90))}</b><small>on ${esc(c.label)}${c.page !== page ? ` · ${esc(short(c.page.replace(/^https?:\/\/[^/]+/, '') || '/', 30))}` : ''}${c.replies?.length ? ` · ${c.replies.length} ${c.replies.length === 1 ? 'reply' : 'replies'}` : ''}</small>
              ${lastIsClaude(c) ? `<div class="se-reply">${icon('claude', 11)} ${esc(short(c.replies.at(-1).text, 160))}</div>` : ''}</span>
            ${c.status === 'resolved' ? `<em class="se-status">Resolved</em>` : c.status === 'sent' ? `<em class="se-status">Sent</em>` : ''}
            <button type="button" class="cc-x" data-remove-comment="${c.id}" title="Delete this comment">${icon('x', 11)}</button></div>`).join('')}
        <div class="se-list-actions">${list.some((c) => c.status === 'resolved') ? `<button type="button" class="btn small" data-se="clear-resolved">Clear resolved</button>` : ''}</div>
      </div>`;
    }

    /* ----- Claude ----- */

    function ensureChat() {
      if (!pid) return null;
      if (!chat) {
        chat = createChat(chatIdOf(pid), {
          emptyIcon: '<img class="cl-logo" src="/img/claude.png" alt="" draggable="false">',
          text: {
            title: 'Claude',
            placeholder: 'Ask Claude about this page, or send your changes…',
            emptyTitle: 'Hands on, then hand it over',
            emptyText: 'Adjust elements, edit text and pin comments on the page. Sending gives Claude the list with where each style comes from in the source, plus pictures; it edits the project and answers your comments under their pins.',
            suggestions: ['What does this page’s layout look like in the source?', 'Make the page responsive down to 360px', 'Find contrast problems on this page'],
            clearConfirm: 'Start a new conversation? Claude won’t remember this one (your changes and comments stay).',
            terminal: false,
          },
          // Anything pending goes with every message, so Claude's hand-off is always current.
          beforeSend: async (text) => {
            const n = await writeHandoff();
            if (!n) return;
            return `${text}\n\n(The hand-off in ${await shell.siteEditor.dir(pid)}/handoff/spec.md is current: ${n}.)`;
          },
        });
        chat.el.classList.add('cl-chat');
        $('.se-pane-claude', win.body).append(chat.el);
      }
      return chat;
    }
    /** The hand-off: spec.md and pictures for everything pending. Resolves to a short count, or '' when nothing's pending. */
    async function writeHandoff() {
      if (!state || !pid) return '';
      const changes = state.changes.filter(pending);
      const comments = state.comments.filter((c) => c.status !== 'resolved' && !lastIsClaude(c));
      const threads = state.comments.filter((c) => c.status !== 'resolved' && lastIsClaude(c)); // answered, waiting on the user: context only
      if (!changes.length && !comments.length) return '';
      const p = project();
      const files = {};
      await run('quiet', { on: true });
      try {
        const pagePng = wcId ? await shell.siteEditor.shot(wcId).catch(() => null) : null;
        if (pagePng) files['page.png'] = pagePng;
        for (const c of changes) {
          if (c.page !== page || !wcId) continue;
          const inf = await run('info', { selector: c.selector });
          const r = inf?.rect;
          if (r && r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0 && r.x < (wv?.clientWidth || 1e9) && r.y < (wv?.clientHeight || 1e9)) {
            const png = await shell.siteEditor.shot(wcId, { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), w: r.w + 16, h: r.h + 16 }).catch(() => null);
            if (png) files[`change-${c.n}.png`] = png;
          }
        }
      } finally {
        await run('quiet', { on: false });
      }
      const md = [];
      md.push(`# Site edits: ${p.name}`, '');
      md.push(`- Project folder: \`${p.path}\``);
      md.push(`- Page: ${title ? `${title} — ` : ''}${state.url}`);
      if (server.log && server.status !== 'stopped') {
        files['server.log'] = server.log.slice(-20000);
        md.push(`- Dev server: ${server.kind === 'static' ? 'Leafdeck’s built-in static server (plain HTML)' : `\`${server.command}\``}, run by the Site Editor${server.status === 'running' ? ` at ${server.url}` : `, now stopped${server.code != null ? ` (exit code ${server.code})` : ''}`}. Its recent output: server.log beside this file.`);
      }
      md.push(`- Written ${new Date().toLocaleString()}. Pictures beside this file: page.png (the page with the numbered comment pins)${changes.some((c) => files[`change-${c.n}.png`]) ? ', change-<n>.png (each changed element as it looks with the change applied)' : ''}.`);
      md.push('');
      if (changes.length) {
        md.push(`## Changes (${changes.length})`, '');
        for (const c of changes) {
          const where = c.page !== page ? ` (on ${c.page})` : '';
          if (c.kind === 'style') {
            md.push(`### Change ${c.n} · ${c.label} — styles${where}`, '', `Element: \`${c.selector}\``, '');
            if (c.target) md.push(`Applies to: every element matching \`${c.target}\`, not only this one. Change the rule for \`${c.target}\` (the element here is the one that was selected).`, '');
            if (c.state) md.push(`State: \`:${c.state}\` only. These are its styles in that state (“before” is how that state looks now); leave its resting styles alone.`, '');
            if (c.media) md.push(`Widths: only under \`@media (${c.media})\`. Leave it as it is at other widths.`, '');
            md.push('```html', c.html || '', '```', '');
            for (const [prop, v] of Object.entries(c.props || {})) {
              const o = c.origins?.[prop];
              let src = 'no rule found for it (the browser default, or set by a script)';
              if (o) {
                src = `set by \`${o.selector} { ${o.text} }\``;
                if (o.inherited) src += ` (inherited from ${o.inherited})`;
                if (o.media) src += ` under \`@media ${o.media}\``;
                if (o.file) src += ` in \`${o.file}${o.line ? ':' + o.line : ''}\``;
                else if (o.url) src += ` in ${o.url}${o.line ? ' line ' + o.line : ''}`;
                if (o.injected) src += ' (a stylesheet injected by a script)';
              }
              md.push(`- \`${prop}\`: \`${v.before || '(none)'}\` → \`${v.after}\` — ${src}`);
            }
            if (files[`change-${c.n}.png`]) md.push('', `Picture: change-${c.n}.png`);
            md.push('');
          } else if (c.kind === 'text') {
            md.push(`### Change ${c.n} · ${c.label} — text${where}`, '', `Element: \`${c.selector}\``, '', '```html', c.html || '', '```', '', `- Before: “${c.before}”`, `- After: “${c.after}”`, '');
            if (c.rich && c.afterHtml) md.push('The text has formatting inside; as markup, before and after:', '', '```html', c.beforeHtml || '', '```', '', '```html', c.afterHtml, '```', '');
          } else if (c.kind === 'component') {
            const ddir = c.design?.id && shell.designer ? await shell.designer.dir(c.design.id).catch(() => '') : '';
            md.push(`### Change ${c.n} · ${c.label} — component from Leafdeck Designer${where}`, '', `Replace the element \`${c.selector}\` with the component designed in Designer${c.design?.name ? ` (“${c.design.name}”)` : ''}.`);
            if (ddir) md.push(`The design's folder is \`${ddir}\`: read its \`handoff/spec.md\` (the full spec, layers and states; \`handoff/component.html\` and \`styles.css\` are the reference build, \`handoff/preview.png\` how it should look).`);
            md.push('', 'Reference markup and CSS as exported (class names are Designer’s; use the project’s own conventions):', '', '```html', c.html || '', '```', '', '```css', c.css || '', '```', '');
            if (c.before) md.push('The element as it is on the page now:', '', '```html', c.before, '```', '');
          }
        }
      }
      if (comments.length || threads.length) {
        md.push(`## Comments (${comments.length}${threads.length ? ` new or updated, ${threads.length} awaiting the user` : ''})`, '');
        md.push(`Each is pinned to a spot on the page (page.png shows the numbers). Do what it asks, then answer it in \`replies.json\` (see your instructions) by its id.`, '');
        for (const c of [...comments, ...threads]) {
          const waiting = threads.includes(c);
          md.push(`### Comment ${c.n} · on ${c.label}${c.page !== page ? ` (on ${c.page})` : ''}${waiting ? ' — answered; no new word from the user, nothing to do unless it relates' : c.replies?.length ? ' — the user replied' : ''}`, '', `- id: \`${c.id}\``, `- Element: \`${c.selector}\``, '');
          md.push(`> ${c.text.replace(/\n/g, '\n> ')}`, '');
          for (const r of c.replies || []) md.push(`**${r.from === 'claude' ? 'Claude' : 'User'}:** ${r.text}`, '');
        }
      }
      files['spec.md'] = md.join('\n');
      await shell.siteEditor.handoff(pid, files);
      for (const c of changes) if (c.status === 'pending' || c.status === 'missing') c.status = 'sent';
      undoStack.length = redoStack.length = 0; // what's sent is with Claude now
      for (const c of comments) if (c.status === 'open') c.status = 'sent';
      save();
      drawAll();
      pins();
      const parts = [changes.length && `${changes.length} change${changes.length === 1 ? '' : 's'}`, comments.length && `${comments.length} comment${comments.length === 1 ? '' : 's'}`].filter(Boolean);
      return parts.join(' and ');
    }
    async function sendToClaude() {
      const c = ensureChat();
      if (!c) return;
      if (!sideOpen) toggleSide(true);
      setTab('claude');
      const n = await writeHandoff();
      if (!n) return toast('Nothing to send yet: adjust something or pin a comment first.');
      const changes = state.changes.filter((c) => c.status === 'sent').length;
      const comments = state.comments.filter((c) => c.status === 'sent').length;
      const dir = await shell.siteEditor.dir(pid);
      // beforeSend writes the hand-off again (it's idempotent) and adds its own note; this message says what to do.
      c.send(`Put the edits from the Site Editor into the source: read ${dir}/handoff/spec.md (${n}, with pictures beside it)${changes ? ', make the source produce each change' : ''}${comments ? `, do what the comment${comments === 1 ? ' asks' : 's ask'} and answer ${comments === 1 ? 'it' : 'them'} in ${dir}/replies.json` : ''}. Tell me what you changed, by file.`);
    }
    /** After Claude's turn: reload, check the changes against the page, and thread its replies under the pins. */
    async function afterClaude(ev) {
      if (!state || !pid) return;
      if (ev?.ok === false) return; // the turn failed or was stopped: the chat shows why; nothing to check
      const replies = await shell.siteEditor.replies(pid).catch(() => []);
      let answered = 0;
      for (const r of replies) {
        const c = state.comments.find((x) => x.id === r.id || String(x.n) === r.id);
        if (!c || !r.text) continue;
        c.replies.push({ from: 'claude', text: r.text, at: Date.now(), done: r.done });
        if (c.status === 'sent') c.status = 'open';
        answered++;
      }
      if (answered) save();
      const sent = state.changes.filter((c) => c.status === 'sent' || c.status === 'missing');
      if (sent.length && wv) {
        verifyNext = true;
        wv.reload(); // the dev server has the new source; start() verifies, then re-applies what's left
      } else {
        drawAll();
        pins();
      }
      if (answered) toast(`Claude answered ${answered} comment${answered === 1 ? '' : 's'}`, '', { label: 'Show', act: () => setTab('comments') });
    }
    async function verifyChanges() {
      const sent = pageChanges().filter((c) => c.status === 'sent' || c.status === 'missing');
      if (!sent.length) return;
      const r = (await run('verify', { changes: sent })) || {};
      let ok = 0;
      for (const c of sent) {
        if (r[c.id] === true) {
          c.status = 'applied';
          ok++;
        } else if (r[c.id] === false) c.status = 'missing';
        else c.status = 'applied'; // can't tell (a component): trust Claude, the user can see it
      }
      save();
      const miss = sent.length - ok;
      toast(miss ? `${ok} of ${sent.length} changes are in the page; ${miss} ${miss === 1 ? 'isn’t' : 'aren’t'} (still shown as you set ${miss === 1 ? 'it' : 'them'})` : `All ${sent.length === 1 ? 'change is' : sent.length + ' changes are'} in the page`, miss ? 'error' : '', miss ? { label: 'Show', act: () => setTab('changes') } : null);
    }

    /* ----- Designer ----- */

    async function editInDesigner(selector) {
      if (!wcId || !shell.designer) return;
      toast('Capturing the element for Designer…');
      try {
        const cap = await shell.siteEditor.capture(wcId, selector);
        if (!cap) throw new Error('Nothing was captured');
        cap.site = { project: pid, url: state.url, selector, label: selected?.label || selector };
        const m = await import('./designer.js');
        m.captureToDesigner(cap);
      } catch (err) {
        toast(`Couldn’t take that to Designer: ${err.message}`, 'error');
      }
    }

    /* ----- what the page reports ----- */

    function onPageEvent(ev) {
      if (ev.t === 'key') return ev.key === 'redo' ? redo() : undo();
      if (ev.t === 'select') {
        pick(ev.info || null);
        if (selected && tab !== 'edit' && tab !== 'claude') setTab('edit');
        else drawPane();
        drawTop();
        // Read it again with the pointer off it: the resting look, not :hover's.
        if (selected) run('info', { selector: selected.selector, rest: selected.rect, props: extraProps() }).then((inf) => {
          if (inf && selected?.selector === inf.selector) {
            selected = inf;
            if (tab === 'edit') drawInspector();
          }
        });
      } else if (ev.t === 'text') {
        const edit = { after: ev.after, rich: !!ev.rich, beforeHtml: ev.beforeHtml ?? null, afterHtml: ev.afterHtml ?? null };
        if (!selected || selected.selector !== ev.selector) run('info', { selector: ev.selector }).then((inf) => {
          if (!inf) return;
          pick(inf);
          selected = { ...inf, text: ev.before, inner: ev.beforeHtml ?? inf.inner };
          setText(edit);
        });
        else setText(edit);
      } else if (ev.t === 'comment') addComment(ev);
      else if (ev.t === 'reply') {
        const c = state?.comments.find((x) => x.id === ev.id);
        if (!c) return;
        c.replies.push({ from: 'user', text: String(ev.text || '').slice(0, 4000), at: Date.now() });
        if (c.status === 'resolved') c.status = 'open';
        save();
        pins(c.id);
        drawAll();
      } else if (ev.t === 'resolve') {
        const c = state?.comments.find((x) => x.id === ev.id);
        if (!c) return;
        c.status = 'resolved';
        save();
        pins(null);
        drawAll();
      } else if (ev.t === 'pin') {
        activeComment = ev.id;
        if (tab === 'comments') drawComments();
      } else if (ev.t === 'designer') editInDesigner(ev.selector);
    }
    const offEvents = shell.on('siteeditor:event', ({ webContentsId, ev }) => webContentsId && webContentsId === wcId && onPageEvent(ev));

    /* ----- clicks and keys ----- */

    function toggleSide(open = !sideOpen) {
      sideOpen = open;
      store.set('siteeditor:side', sideOpen);
      drawTop();
    }
    async function addProject() {
      const r = await pickFiles({ mode: 'open', directory: true, title: 'Add a project folder', accept: 'Add' }).catch(() => null);
      const dir = r?.paths?.[0];
      if (!dir) return;
      try {
        const p = await shell.projects.add(dir);
        await show(p.id);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    function projectMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        ...projects.map((p) => ({ label: p.name, checked: p.id === pid, act: () => show(p.id) })),
        projects.length ? '-' : null,
        { label: 'Add a Project Folder…', act: () => addProject() },
        pid ? { label: 'Open in Claude Code', act: () => openApp('claudecode', { project: project()?.path }) } : null,
      ].filter(Boolean));
    }

    win.body.addEventListener('click', async (e) => {
      const t = e.target;
      const open = t.closest('[data-open]');
      if (open) return show(open.dataset.open);
      const modeBtn = t.closest('[data-mode]');
      if (modeBtn) return setMode(modeBtn.dataset.mode);
      const tabBtn = t.closest('[data-tab]');
      if (tabBtn) return setTab(tabBtn.dataset.tab);
      const rc = t.closest('[data-remove-change]');
      if (rc) {
        const ch = state.changes.find((c) => c.id === rc.dataset.removeChange);
        if (ch) removeChange(ch);
        return;
      }
      const rk = t.closest('[data-remove-comment]');
      if (rk) {
        state.comments = state.comments.filter((c) => c.id !== rk.dataset.removeComment);
        save();
        pins(null);
        return drawAll();
      }
      const chItem = t.closest('[data-change]');
      if (chItem) {
        const ch = state.changes.find((c) => c.id === chItem.dataset.change);
        if (!ch) return;
        if (ch.page !== page) return navigate(ch.page);
        const inf = await run('select', { selector: ch.selector });
        pick(inf);
        // Its scope too, so the inspector shows this change's values.
        if (inf && ch.kind === 'style') {
          scope = { target: ch.target || '', state: ch.state || '', media: ch.media || '' };
          if (scope.state) {
            await shell.siteEditor.forceState(wcId, inf.selector, scope.state).catch(() => false);
            readDeclared();
            return refreshSelected();
          }
        }
        drawAll();
        return;
      }
      const cItem = t.closest('[data-comment]');
      if (cItem) {
        const c = state.comments.find((x) => x.id === cItem.dataset.comment);
        if (!c) return;
        activeComment = c.id;
        if (c.page !== page) return navigate(c.page);
        if (mode === 'browse') setMode('select');
        pins(c.id);
        return drawComments();
      }
      const act = t.closest('[data-se]')?.dataset.se;
      if (!act) return;
      if (act === 'project') return projectMenu(t.closest('[data-se]'));
      if (act === 'server') return serverMenu(t.closest('[data-se]'));
      if (act === 'srv-start' || act === 'srv-restart') return startServer();
      if (act === 'srv-stop') return stopServer();
      if (act === 'log-close') {
        logOpen = false;
        $('.se-log', win.body).hidden = true;
        return;
      }
      if (act === 'add') return addProject();
      if (act === 'back') return wv?.canGoBack?.() && wv.goBack();
      if (act === 'reload') return wv ? wv.reload() : state?.url && navigate(state.url);
      if (act === 'side') return toggleSide();
      if (act === 'undo') return undo();
      if (act === 'redo') return redo();
      if (act === 'width') return widthMenu(t.closest('[data-se]'));
      if (act === 'send') return sendToClaude();
      if (act === 'designer' && selected) return editInDesigner(selected.selector);
      if (act === 'edit-text' && selected) {
        const ok = await run('edit', { selector: selected.selector });
        if (ok) wv?.focus();
        return;
      }
      if (act === 'parent' && selected) {
        const up = await run('parent', { selector: selected.selector });
        if (up) {
          pick(up);
          drawAll();
        }
        return;
      }
      if (act === 'comment-here' && selected) {
        setMode('comment');
        toast('Click the spot on the element the comment is about.');
        return;
      }
      if (act === 'revert-sel' && selected) {
        remember();
        for (const ch of state.changes.filter((c) => c.page === page && c.selector === selected.selector && pending(c))) {
          state.changes = state.changes.filter((c) => c !== ch);
          run('revert', { id: ch.id });
        }
        save();
        return refreshSelected();
      }
      if (act === 'clear-applied') {
        state.changes = state.changes.filter((c) => c.status !== 'applied');
        save();
        return drawAll();
      }
      if (act === 'discard-all') {
        if (!(await confirmDialog('Discard every change? The page goes back to how the project has it.', { ok: 'Discard', danger: true, win }))) return;
        remember();
        for (const ch of [...state.changes]) if (ch.page === page) run('revert', { id: ch.id });
        state.changes = [];
        save();
        return refreshSelected();
      }
      if (act === 'clear-resolved') {
        state.comments = state.comments.filter((c) => c.status !== 'resolved');
        save();
        pins();
        return drawAll();
      }
    });
    win.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-text]')) {
        run('revert', { id: 'live-text' }); // the preview while typing; the real change follows
        return setText({ after: t.value });
      }
    });
    // Typing in the text box shows on the page as you go.
    win.body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('[data-text]') && selected) run('apply', { id: 'live-text', kind: 'text', selector: selected.selector, after: t.value });
    });
    win.body.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.matches('.se-url')) return navigate(urlInput.value.trim());
      if (f.matches('.se-start-srv')) return startServer(f.querySelector('input').value.trim());
      if (f.matches('.se-start-url')) return navigate(f.querySelector('input').value.trim());
    });
    // Undo and redo. After a click on something that takes no focus the keyboard is on the document, not in the
    // window, so this listens there and answers when the window is the one in front.
    const onUndoKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !/^[zy]$/i.test(e.key) || e.defaultPrevented) return;
      const t = e.target;
      if (t === document.body || t === document.documentElement) { if (activeWindow() !== win) return; }
      else if (!win.el.contains(t)) return;
      // In a field with something typed, the field's own undo; anywhere else, the last change.
      else if (t.matches('textarea, [contenteditable]') || (t.matches('input') && (!t.closest('.se-pane[data-pane="edit"]') || t.value !== t.defaultValue))) return;
      e.preventDefault();
      if (e.shiftKey || /y/i.test(e.key)) redo();
      else undo();
    };
    document.addEventListener('keydown', onUndoKey);
    win.body.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 's' || e.key === 'S') setMode('select');
      else if (e.key === 'c' || e.key === 'C') setMode('comment');
      else if (e.key === 'b' || e.key === 'B') setMode('browse');
    });

    win.siteEditor = {
      show,
      /** A change arrived from outside (Designer): show it if it's on this page. */
      refresh: (ch) => {
        if (ch && ch.page === page) {
          run('info', { selector: ch.selector }).then((inf) => {
            if (inf && !ch.before) ch.before = inf.html;
            run('apply', ch);
            save();
          });
        }
        drawAll();
      },
      destroy: () => {
        offEvents?.();
        offServer?.();
        for (const id of startedHere) shell.siteEditor.server.stop(id).catch(() => {});
        unlisten?.();
        run('stop');
        inspector.destroy();
        document.removeEventListener('keydown', onUndoKey);
        chat?.destroy();
      },
    };
    show(launchWith?.project || pid, launchWith?.url || '');
    launchWith = null;
  },
  unmount(win) {
    win.siteEditor?.destroy();
  },
  menuItems: () => (supported ? [{ label: 'Open Project in Site Editor…', act: () => openApp(APP) }] : []),
};
registerApp(app);
