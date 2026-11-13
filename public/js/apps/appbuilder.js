// App Builder: build Leafdeck apps with Claude, laid out like Claude Design. The home page is your apps and a box for
// the next one; each app has a workspace with the running app beside a chat. Pin comments on the app for Claude, pick an
// element to talk about, keep as many chats per app as you like (each remembers its conversation), and take Claude's
// suggestions for the next step. The apps run through ../userapps.js (here in a preview, and in their own windows);
// their files are in Documents/Leafdeck Apps (electron/userapps.cjs). The chats are Claude Code sessions in the app's
// folder (electron/agentchat.cjs, "@app:<id>:<n>"); how much Claude asks before building is set in Settings here.
import { $, esc } from '../util.js';
import { icon, appIcon } from '../icons.js';
import { registerApp, toast, openApp, showMenu, focus as focusWin } from '../wm.js';
import { ask, confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';
import { listen } from '../agentchat.js';
import { createSession } from '../claudecode/session.js';
import { userApps, userAppsDir, onUserApps, refreshUserApps, openUserApp, grantedFor, isApproved, revoke, appsOff, setAppsOff, describePermission, mountApp, previewHosts } from '../userapps.js';

// Apps from the store are managed in the Leafdeck Store; this is for the ones you build.
const myApps = () => userApps().filter((a) => !a.store);
const appOf = (id) => myApps().find((a) => a.id === id);
const chatIdOf = (id, n) => `@app:${id}:${n}`;

const EXAMPLES = [
  { title: 'Lead follow-ups', name: 'Lead Follow-ups', prompt: 'A follow-up board for my contacts whose type is "Lead": cards with name, company and when I last reached out. Let me log a touchpoint (date, how, notes) on each card, kept in the app’s own data. Sort by who has waited longest and mark anyone with no touchpoint in 14 days.' },
  { title: 'Daily standup', name: 'Daily Standup', prompt: 'A daily standup page: tasks I finished yesterday, tasks due today or overdue, and today’s events, each as a short list, with a "Copy summary" button that copies a plain-text update to the clipboard.' },
  { title: 'Event weather', name: 'Event Weather', prompt: 'A page listing my Leafdeck events in the next 7 days that have a location, with the National Weather Service forecast for each one from api.weather.gov (let me pin a city per event if an address can’t be placed).' },
];

// How much Claude asks (config.json "appbuilder.ask"; the wording Claude gets is in electron/userapps.cjs).
const ASK = [
  ['lots', 'Ask a lot', 'Before building or changing much, Claude asks who it’s for, which records to use and how it should look, and again before anything hard to undo.'],
  ['some', 'Ask when it matters', 'Questions only when a request is ambiguous or a choice has consequences, like a new permission.'],
  ['rarely', 'Rarely', 'Claude makes sensible choices and says what it assumed.'],
  ['never', 'Never, just build', 'No questions at all.'],
];
const askLabel = (k) => ASK.find((a) => a[0] === k)?.[1] || ASK[0][1];
const WIDTHS = [['fit', 'Fit'], ['phone', 'Phone'], ['tablet', 'Tablet']];
const MODES = [['browse', 'Browse', 'mouse', 'Use the app'], ['select', 'Select', 'target', 'Pick an element to talk about'], ['comment', 'Comment', 'pin', 'Click where a comment for Claude goes']];

const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
const uid = () => Math.random().toString(36).slice(2, 10);
const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const cleanTitle = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
// A name from the first words of a description ("Build me a reading list tracker that…" → "Reading List Tracker").
const STOP = new Set(['build', 'make', 'create', 'write', 'i', "i'd", 'want', 'need', 'like', 'please', 'me', 'a', 'an', 'the', 'my', 'our', 'app', 'page', 'tool', 'simple', 'small', 'little', 'new', 'that', 'which', 'for', 'to', 'of', 'with', 'us', 'can', 'could', 'you']);
const BREAK = new Set(['that', 'which', 'for', 'from', 'with', 'to', 'of', 'in', 'on', 'and', 'where', 'so', 'using', 'showing', 'listing']);
export function deriveName(text) {
  const words = String(text).split(/[\n.,;:!?()"]/)[0].replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && STOP.has(words[0].toLowerCase())) words.shift();
  const out = [];
  for (const w of words) {
    if (BREAK.has(w.toLowerCase()) && out.length) break;
    out.push(w[0].toUpperCase() + w.slice(1));
    if (out.length === 3) break;
  }
  return (out.join(' ') || 'New App').slice(0, 40);
}

// Claude ends each reply with a fenced "suggestions" block (see the builder prompt): taken out of the text, shown as buttons.
const SUGG_DONE = /\n*```suggestions[^\n]*\n([\s\S]*?)```[ \t]*/g;
const SUGG_OPEN = /\n*```suggestions[\s\S]*$/;
export function splitSuggestions(text, final) {
  let list = null;
  let out = String(text).replace(SUGG_DONE, (_, body) => {
    list = body.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 3);
    return '\n';
  });
  if (!final) out = out.replace(SUGG_OPEN, '');
  return { text: out.trim(), suggestions: list };
}

registerApp({
  id: 'appbuilder',
  name: 'App Builder',
  icon: 'sparkle',
  color: 'green',
  size: [1280, 800],
  min: [820, 500],
  openRecord(win, id) {
    win.builder?.open(id);
  },
  mount(win) {
    if (!shell?.userApps) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">App Builder lives in the Leafdeck app</div>
        <p>Building apps with Claude needs the desktop app, where your apps run on your own computer.</p></div>`;
      return;
    }
    let view = 'home'; // 'home' | <app id>
    let agents = {};
    let prefs = { ask: 'lots' };
    let publisher = null;
    const states = new Map(); // app id -> { chats, current, comments, nextComment } (electron/userapps.cjs, builder.json)
    const sessions = new Map(); // chat id -> session (claudecode/session.js)
    const suggestions = new Map(); // chat id -> Claude's suggestions after its last reply
    const lastSaved = new Map(); // app id -> when a version was saved before a message
    const watched = new Set(); // chat ids with a listener
    let ws = null; // the open workspace: { id, host, mode, width, selected, logs, hooked }
    const claudeReady = () => !!agents.claude?.installed;

    win.cleanups.push(() => {
      leaveWorkspace();
      sessions.forEach((s) => s.destroy());
    });

    const loadStatus = async () => {
      [agents, prefs] = await Promise.all([shell.userApps.agents().catch(() => ({})), shell.userApps.prefs().catch(() => prefs)]);
    };
    const onFocus = async () => {
      const before = JSON.stringify(agents);
      await loadStatus();
      if (JSON.stringify(agents) !== before && view === 'home') drawHome();
    };
    addEventListener('focus', onFocus);
    win.cleanups.push(() => removeEventListener('focus', onFocus));

    /* ================= Home: your apps, and the next one ================= */

    const status = (m) => (m.broken ? 'Needs a fix' : !m.hasIndex ? 'Not built yet' : !isApproved(m) ? 'Waiting for your approval' : 'Updated ' + ago(m.modified));
    const installCard = () => `<div class="ab-conn warn"><div class="ab-conn-head">${icon('download', 15)}<b>Install Claude Code to start</b></div>
      <p>App Builder talks to Claude Code on this computer. Install opens a terminal that sets it up and signs you in; it needs a Claude subscription (Pro, Max or Team).</p>
      <div class="ab-row"><button class="btn small primary" data-install="claude">Install Claude Code</button></div></div>`;

    function drawHome() {
      view = 'home';
      win.setTitle('App Builder');
      win.tools.innerHTML = `<button class="tb-pill" data-ab="folder" title="Open the Leafdeck Apps folder">${icon('folder', 12)} Apps folder</button>
        <button class="tb-btn" data-ab="settings" title="Settings">${icon('sliders', 15)}</button>`;
      const list = myApps().sort((a, b) => (b.modified || 0) - (a.modified || 0));
      win.body.innerHTML = `<div class="ab-home"><div class="ab-home-in">
        <section class="ab-hero">
          <span class="ab-kicker">${icon('sparkle', 13)} App Builder</span>
          <h1>What do you want to build?</h1>
          <p>Describe a tool for your work. Claude builds it as a Leafdeck app: its own window, Leafdeck’s look, and your records only with your OK.</p>
          <form class="ab-ask">
            <textarea name="description" rows="3" placeholder="A follow-up board for my leads that…" aria-label="What should it do?"></textarea>
            <div class="ab-ask-row">
              <label class="ab-name" title="The app’s name (Leafdeck suggests one from your description)">${icon('tag', 12)}<input name="name" maxlength="40" placeholder="Name" aria-label="App name"></label>
              <span class="grow"></span>
              <button type="button" class="ab-asklevel" data-ab="settings" title="How much Claude asks before building">${icon('claude', 12)} ${esc(askLabel(prefs.ask))}</button>
              <button type="submit" class="btn primary" ${claudeReady() ? '' : 'disabled title="Install Claude Code first"'}>${icon('sparkle', 12)} Build it</button>
            </div>
          </form>
          <div class="ab-chips">${EXAMPLES.map((x, i) => `<button type="button" class="chip-btn" data-example="${i}">${esc(x.title)}</button>`).join('')}</div>
        </section>
        ${claudeReady() ? '' : installCard()}
        <div class="ab-grid-head"><h3>Your apps</h3><label class="ab-off"><input type="checkbox" data-off ${appsOff() ? '' : 'checked'}><span>Apps can run</span></label></div>
        ${list.length
          ? `<div class="ab-grid">${list
              .map((m) => `<div class="ab-tile" role="button" tabindex="0" data-app="${esc(m.id)}">${appIcon({ ...m, icon: m.icon || 'sparkle' })}
                <div class="ab-tile-text"><b>${esc(m.name)}</b><p>${esc(m.description || 'No description yet.')}</p><small>${esc(status(m))}</small></div>
                <button class="tb-btn ab-tile-open" data-openapp="${esc(m.id)}" title="Open ${esc(m.name)} in its window" ${m.hasIndex ? '' : 'disabled'}>${icon('new-window', 14)}</button></div>`)
              .join('')}</div>`
          : '<p class="ab-none">Nothing yet. Describe your first app above.</p>'}
      </div></div>`;
      const ta = $('.ab-ask textarea', win.body);
      const name = $('.ab-ask input[name=name]', win.body);
      let typedName = false;
      name.addEventListener('input', () => (typedName = !!name.value.trim()));
      ta.addEventListener('input', () => !typedName && (name.value = ta.value.trim() ? deriveName(ta.value) : ''));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          build($('.ab-ask', win.body));
        }
      });
      ta.focus();
    }

    async function build(form) {
      const desc = form.description.value.trim();
      if (!desc) return form.description.focus();
      if (!claudeReady()) return toast('Install Claude Code first (Settings).');
      const name = form.name.value.trim() || deriveName(desc);
      try {
        const m = await shell.userApps.create({ name, description: desc });
        await refreshUserApps();
        await openWorkspace(m.id);
        currentSession()?.send(`${desc}\n\n(That’s the brief; it’s in BRIEF.md too. Follow the guide in this folder. Once it runs, check it in Leafdeck with a screenshot and the logs.)`);
      } catch (err) {
        toast(cleanErr(err), 'error');
      }
    }

    /* ================= Workspace: the app beside its chats ================= */

    const stateOf = (id) => states.get(id);
    const saveState = (id, patch) => shell.userApps.setBuilderState(id, patch).then((st) => states.set(id, st), (err) => toast(cleanErr(err), 'error'));

    async function openWorkspace(id) {
      const m = appOf(id);
      if (!m) return drawHome();
      leaveWorkspace();
      view = id;
      let st;
      try {
        st = await shell.userApps.builderState(id);
        if (!st.chats.length) {
          await shell.userApps.newChat(id);
          st = await shell.userApps.builderState(id);
        }
      } catch (err) {
        toast(cleanErr(err), 'error');
        return drawHome();
      }
      if (view !== id) return;
      states.set(id, st);
      ws = { id, mode: 'browse', width: 'fit', selected: null, logs: false, host: null, hooked: null };
      win.setTitle(m.name);
      win.tools.innerHTML = `<button class="tb-pill" data-ab="home" title="All your apps">${icon('left', 12)} Apps</button>
        <button class="tb-pill" data-ab="openapp" title="Open the app in its own window" ${m.hasIndex ? '' : 'disabled'}>${icon('new-window', 12)} Open in window</button>
        <button class="tb-btn" data-ab="more" title="More">${icon('dots', 15)}</button>`;
      win.body.innerHTML = `<div class="ab-ws">
        <section class="ab-chatcol">
          <header class="ab-chathead">
            <button class="ab-chatpick" data-ab="chats" title="This app’s chats"><b class="ab-chattitle"></b>${icon('down', 10)}</button>
            <span class="grow"></span>
            <button class="tb-btn" data-ab="newchat" title="New chat">${icon('plus', 14)}</button>
          </header>
          <div class="ab-session"></div>
        </section>
        <section class="ab-prev">
          <div class="ab-prevbar">
            <div class="seg ab-modes">${MODES.map(([k, l, ic, t]) => `<button type="button" data-mode="${k}" class="${k === 'browse' ? 'on' : ''}" title="${esc(t)}">${icon(ic, 13)}<span class="seg-label">${l}</span></button>`).join('')}</div>
            <button type="button" class="ab-comment-count" data-ab="comments" hidden></button>
            <span class="grow"></span>
            <div class="seg ab-widths">${WIDTHS.map(([k, l]) => `<button type="button" data-width="${k}" class="${k === 'fit' ? 'on' : ''}">${l}</button>`).join('')}</div>
            <button class="tb-btn" data-ab="reload" title="Reload the app">${icon('refresh', 14)}</button>
            <button class="tb-btn ab-logbtn" data-ab="logs" title="Logs">${icon('list', 14)}<i class="ab-badge" hidden></i></button>
          </div>
          <div class="ab-stage" data-width="fit"><div class="ab-device">
            <div class="ab-fakebar"><span class="ab-fakeicon">${icon(m.icon || 'sparkle', 13)}</span><span class="ab-faketitle">${esc(m.name)}</span><div class="ab-faketools win-tools"></div></div>
            <div class="ab-frame"></div></div></div>
          <div class="ab-logs" hidden></div>
        </section></div>`;
      // The preview is a host for the app, shaped like a window (userapps.js mountApp): the app's toolbar controls
      // land in the fake title bar, the app itself in the frame.
      const host = {
        body: $('.ab-frame', win.body),
        tools: $('.ab-faketools', win.body),
        cleanups: [],
        userApp: id,
        appView: null,
        appToolbar: [],
        setTitle: (t) => {
          const el = $('.ab-faketitle', win.body);
          if (el) el.textContent = t;
        },
        close: () => {
          host.body.innerHTML = `<div class="empty ua-msg"><div class="empty-title">Not running</div><p>Allow what the app asks for to see it here.</p><button class="btn small" data-ab="reload">Try again</button></div>`;
        },
        focus: () => focusWin(win),
        onPage: (ev) => onPage(ev),
      };
      ws.host = host;
      previewHosts.add(host);
      // Whenever the app's page is (re)loaded, the overlay goes back in: the watcher reloads it on every save.
      const mo = new MutationObserver(() => hookView());
      mo.observe(host.body, { childList: true, subtree: true });
      ws.unobserve = () => mo.disconnect();
      mountApp(host, id);
      hookView();
      showChat(st.current || st.chats.at(-1).n);
      refreshLogs();
    }

    function leaveWorkspace() {
      if (!ws) return;
      ws.unobserve?.();
      ws.host?.cleanups.forEach((f) => f());
      if (ws.host) previewHosts.delete(ws.host);
      $('.ab-session .ccs', win.body)?.remove(); // keeps the session alive for next time
      ws = null;
    }

    function hookView() {
      const wv = ws?.host.appView;
      if (!wv || ws.hooked === wv) return;
      ws.hooked = wv;
      wv.addEventListener('dom-ready', () => startOverlay());
    }
    const wcId = () => {
      try {
        return ws?.host.appView?.getWebContentsId();
      } catch {
        return null;
      }
    };
    const page = (mode, opts) => {
      const w = wcId();
      return w ? shell.userApps.page(w, mode, opts).catch(() => null) : Promise.resolve(null);
    };
    const pins = () => (stateOf(ws.id)?.comments || []).filter((c) => c.status !== 'resolved');
    async function startOverlay() {
      if (!ws) return;
      await page('start', { mode: ws.mode, comments: pins(), designer: false });
      if (ws.selected) await page('select', { selector: ws.selected.selector, scroll: false });
    }
    function setMode(mode) {
      if (!ws) return;
      ws.mode = mode;
      for (const b of win.body.querySelectorAll('.ab-modes [data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
      page('mode', { mode });
    }
    function setWidth(w) {
      if (!ws) return;
      ws.width = w;
      $('.ab-stage', win.body).dataset.width = w;
      for (const b of win.body.querySelectorAll('.ab-widths [data-width]')) b.classList.toggle('on', b.dataset.width === w);
    }
    const reloadPreview = () => {
      if (!ws) return;
      mountApp(ws.host, ws.id);
      hookView();
    };

    /* ----- what happens in the app's page: selections and comments (siteeditor/inpage.js) ----- */
    function onPage(ev) {
      if (!ws) return;
      const st = stateOf(ws.id);
      if (ev.t === 'select') {
        ws.selected = ev.info;
        drawStrip();
      } else if (ev.t === 'comment') {
        const c = { id: uid(), n: st.nextComment || 1, selector: ev.selector, label: ev.label || ev.selector, offset: ev.offset, rect: ev.rect, text: String(ev.text || '').trim(), status: 'open', at: Date.now(), replies: [] };
        st.comments.push(c);
        st.nextComment = c.n + 1;
        saveState(ws.id, { comments: st.comments, nextComment: st.nextComment });
        page('pins', { comments: pins(), active: c.id });
        drawStrip();
      } else if (ev.t === 'reply') {
        const c = st.comments.find((x) => x.id === ev.id);
        if (!c) return;
        c.replies.push({ from: 'user', text: String(ev.text || '').trim(), at: Date.now() });
        c.status = 'open'; // a reply after Claude answered is a new instruction
        saveState(ws.id, { comments: st.comments });
        page('pins', { comments: pins(), active: c.id });
        drawStrip();
      } else if (ev.t === 'resolve') {
        const c = st.comments.find((x) => x.id === ev.id);
        if (!c) return;
        c.status = 'resolved';
        saveState(ws.id, { comments: st.comments });
        page('pins', { comments: pins(), active: null });
        drawStrip();
      }
    }
    function removeComment(cid) {
      const st = stateOf(ws.id);
      st.comments = st.comments.filter((c) => c.id !== cid);
      saveState(ws.id, { comments: st.comments });
      page('pins', { comments: pins(), active: null });
      drawStrip();
    }
    function clearSelection() {
      if (!ws) return;
      ws.selected = null;
      page('select', { selector: null });
      drawStrip();
    }

    /* ----- the strip above the composer: the element picked, the comments going with the message, suggestions ----- */
    function drawStrip() {
      if (!ws) return;
      const s = currentSession();
      if (!s) return;
      let strip = s.el.querySelector('.ab-strip');
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'ab-strip';
        (s.el.querySelector('.ccs-compose') || s.el).prepend(strip);
      }
      const st = stateOf(ws.id);
      const open = st.comments.filter((c) => c.status === 'open');
      const sent = st.comments.filter((c) => c.status === 'sent');
      const sugg = suggestions.get(chatIdOf(ws.id, st.current)) || [];
      const parts = [];
      if (ws.selected) {
        const sel = ws.selected;
        parts.push(`<span class="ab-ctx" title="${esc(sel.selector)}">${icon('target', 11)}<span>${esc(sel.label || sel.tag || sel.selector)}</span><button type="button" class="ab-ctx-x" data-ab="unselect" title="Forget this element">${icon('x', 10)}</button></span>`);
      }
      if (open.length || sent.length) {
        parts.push(`<button type="button" class="ab-ctx ab-ctx-btn" data-ab="comments" title="See the comments">${icon('pin', 11)}<span>${open.length ? `${open.length} comment${open.length === 1 ? '' : 's'} go${open.length === 1 ? 'es' : ''} with your message` : `${sent.length} with Claude`}</span></button>`);
        if (open.length) parts.push(`<button type="button" class="chip-btn ab-sendc" data-ab="sendcomments">${icon('send', 11)} Send comments</button>`);
      }
      const chips = sugg.map((t) => `<button type="button" class="chip-btn ab-sugg" data-sugg="${esc(t)}">${icon('sparkle', 11)} ${esc(t)}</button>`).join('');
      strip.innerHTML = (parts.length ? `<div class="ab-strip-ctx">${parts.join('')}</div>` : '') + (chips ? `<div class="ab-strip-sugg">${chips}</div>` : '');
      strip.hidden = !parts.length && !chips;
      const cc = $('.ab-comment-count', win.body);
      if (cc) {
        const n = pins().length;
        cc.hidden = !n;
        cc.innerHTML = `${icon('pin', 11)} ${n}`;
        cc.title = `${n} comment${n === 1 ? '' : 's'} on the app`;
      }
    }

    // Before a message goes: a version of the files (at most one every 15 minutes), the element picked and the open
    // comments, each with where it is, plus a screenshot of the app with the pins on it.
    async function beforeSend(id, text) {
      if (Date.now() - (lastSaved.get(id) || 0) > 15 * 60_000 && appOf(id)?.hasIndex) {
        lastSaved.set(id, Date.now());
        await shell.userApps.saveVersion(id, 'Before: ' + text.slice(0, 60)).catch(() => {});
      }
      if (!ws || ws.id !== id) return null;
      const st = stateOf(id);
      const open = st.comments.filter((c) => c.status === 'open');
      const out = { text, images: [] };
      const lines = [];
      if (ws.selected) {
        const s = ws.selected;
        lines.push(`About this element in the app: \`${s.selector}\`${s.label ? ` ("${s.label}")` : ''}${s.text && s.text !== s.label ? `, text "${String(s.text).slice(0, 120)}"` : ''}.`);
      }
      if (open.length) {
        lines.push(`Comments pinned on the running app (the screenshot shows their numbers):`);
        for (const c of open) {
          const where = c.rect ? ` ${Math.round(c.rect.w)}×${Math.round(c.rect.h)} at ${Math.round(c.rect.x)},${Math.round(c.rect.y)}` : '';
          lines.push(`${c.n}. On \`${c.selector}\` ("${c.label}",${where}): "${c.text}"`);
          for (const r of c.replies) lines.push(`   ${r.from === 'claude' ? 'You answered' : 'Then I said'}: "${r.text}"`);
        }
        lines.push('Do what each comment asks and answer them by number.');
        await page('quiet', { on: true });
        await page('pins', { comments: pins(), active: null });
        const w = wcId();
        const shot = w ? await shell.userApps.shot(w).catch(() => null) : null;
        await page('quiet', { on: false });
        if (shot) out.images.push({ media_type: 'image/png', data: shot.split(',')[1] });
        for (const c of open) c.status = 'sent';
        saveState(id, { comments: st.comments });
        page('pins', { comments: pins(), active: null });
      }
      if (lines.length) out.text = `${text}\n\n${lines.join('\n')}`;
      if (ws.selected) clearSelection();
      else drawStrip();
      return out;
    }

    // Claude's reply: numbered answers go under the comments; when the turn ends they're resolved.
    function answers(id, text) {
      const st = stateOf(id);
      if (!st) return;
      const sent = st.comments.filter((c) => c.status === 'sent');
      if (!sent.length) return;
      let changed = false;
      for (const c of sent) {
        const m = new RegExp(`^\\s*(?:\\*\\*)?(?:Comment\\s+)?${c.n}\\s*[.:)]\\s*(?:\\*\\*)?\\s*(.+)$`, 'im').exec(text);
        if (m && !c.replies.some((r) => r.from === 'claude' && r.text === m[1].trim())) {
          c.replies.push({ from: 'claude', text: m[1].replace(/\*\*/g, '').trim().slice(0, 600), at: Date.now() });
          changed = true;
        }
      }
      if (changed) saveState(id, { comments: st.comments });
    }
    function turnDone(id) {
      const st = stateOf(id);
      if (!st) return;
      let changed = false;
      for (const c of st.comments) if (c.status === 'sent') (c.status = 'resolved'), (changed = true);
      if (changed) saveState(id, { comments: st.comments });
      if (ws?.id === id) {
        page('pins', { comments: pins(), active: null });
        drawStrip();
      }
    }

    /* ----- chats: one app, as many conversations as you like ----- */
    const currentSession = () => (ws ? sessions.get(chatIdOf(ws.id, stateOf(ws.id).current)) : null);
    const chatOf = (id, n) => stateOf(id)?.chats.find((c) => c.n === n);

    function sessionFor(id, n) {
      const cid = chatIdOf(id, n);
      if (!sessions.has(cid)) {
        const s = createSession(cid, {
          cwd: () => `${userAppsDir()}/${id}`,
          cwdLabel: () => appOf(id)?.name || id,
          openFile: (f) => openApp('editor', { file: String(f).startsWith('/') ? String(f) : `${userAppsDir()}/${id}/${String(f).replace(/^"|"$/g, '').replace(/:\d+$/, '')}` }),
          openUrl: async (u) => (await import('./browser.js')).openWebPage(u),
          newSession: () => newChat(id),
          transform: (text, final, replay) => {
            const { text: shown, suggestions: list } = splitSuggestions(text, final);
            if (final) {
              if (list) suggestions.set(cid, list);
              if (!replay) answers(id, text);
              if (ws?.id === id && stateOf(id).current === n) drawStrip();
            }
            return shown;
          },
          empty: () => {
            const m = appOf(id);
            return {
              title: m?.hasIndex ? `What should change in ${m.name}?` : `Let’s build ${m?.name || 'your app'}`,
              text: m?.hasIndex ? 'Say what to add or fix. Pick an element at right to talk about it, or pin comments on the app and send them along.' : 'Describe what it should do. Claude builds it here, and you watch it come together at right.',
              starters: m?.hasIndex
                ? ['Something isn’t working: check the logs and a screenshot, then fix it', 'Match Leafdeck’s look more closely', 'Add an empty state for when there’s no data yet', 'Make it work in a narrow window']
                : ['Read BRIEF.md and build it', 'Ask me what you need to know first', 'Suggest what this app could do'],
            };
          },
          beforeSend: (text) => beforeSend(id, text),
        });
        sessions.set(cid, s);
      }
      if (!watched.has(cid)) {
        watched.add(cid);
        const off = listen(cid, (ev) => {
          const c = chatOf(id, n);
          if (ev.t === 'user' && c) {
            c.at = Date.now();
            if (!c.title) {
              titleChat(id, n, cleanTitle(ev.text));
              shell.agentChat.title(cid, ev.text).then((t) => {
                const now = chatOf(id, n);
                if (t && now && now.title === cleanTitle(ev.text)) titleChat(id, n, t);
              }, () => {});
            } else saveState(id, { chats: stateOf(id).chats });
          }
          if (ev.t === 'done') turnDone(id);
        });
        win.cleanups.push(off);
      }
      return sessions.get(cid);
    }
    function titleChat(id, n, title) {
      const st = stateOf(id);
      if (!st) return;
      st.chats = st.chats.map((c) => (c.n === n ? { ...c, title: cleanTitle(title) } : c));
      saveState(id, { chats: st.chats });
      if (ws?.id === id && st.current === n) $('.ab-chattitle', win.body).textContent = cleanTitle(title) || 'New chat';
    }
    function showChat(n) {
      if (!ws) return;
      const st = stateOf(ws.id);
      if (st.current !== n) {
        st.current = n;
        saveState(ws.id, { current: n });
      }
      const slot = $('.ab-session', win.body);
      const s = sessionFor(ws.id, n);
      slot.replaceChildren(s.el);
      s.shown();
      $('.ab-chattitle', win.body).textContent = chatOf(ws.id, n)?.title || 'New chat';
      drawStrip();
      s.focus();
    }
    async function newChat(id) {
      try {
        const n = await shell.userApps.newChat(id);
        states.set(id, await shell.userApps.builderState(id));
        if (ws?.id === id) showChat(n);
        return n;
      } catch (err) {
        toast(cleanErr(err), 'error');
      }
    }
    async function removeChat(id, n) {
      const c = chatOf(id, n);
      if (!(await confirmDialog(`Delete the chat “${c?.title || 'New chat'}”?`, { ok: 'Delete', danger: true, win, detail: 'Claude won’t remember this conversation. The app and its files stay.' }))) return;
      const cid = chatIdOf(id, n);
      sessions.get(cid)?.destroy();
      sessions.delete(cid);
      suggestions.delete(cid);
      try {
        states.set(id, await shell.userApps.removeChat(id, n));
      } catch (err) {
        return toast(cleanErr(err), 'error');
      }
      const st = stateOf(id);
      if (!st.chats.length) return newChat(id);
      if (ws?.id === id) showChat(st.current || st.chats.at(-1).n);
    }
    function chatsMenu(btn) {
      const st = stateOf(ws.id);
      const r = btn.getBoundingClientRect();
      const list = [...st.chats].sort((a, b) => (b.at || 0) - (a.at || 0));
      showMenu(r.left, r.bottom + 4, [
        { header: 'Chats about this app' },
        ...list.map((c) => ({ label: c.title || 'New chat', key: ago(c.at), checked: c.n === st.current, act: () => showChat(c.n) })),
        '-',
        { label: 'New chat', act: () => newChat(ws.id) },
        { label: 'Rename…', act: () => renameChat(ws.id, st.current) },
        { label: 'Continue in Terminal', act: () => toTerminal(chatIdOf(ws.id, st.current)) },
        '-',
        { label: 'Delete chat', act: () => removeChat(ws.id, st.current) },
      ], { minWidth: 240 });
    }
    async function renameChat(id, n) {
      const c = chatOf(id, n);
      const r = await ask({ title: 'Rename this chat', win, fields: [{ name: 'title', label: 'Title', value: c?.title || '' }], buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', primary: true }] });
      if (r?.value === 'ok') titleChat(id, n, r.values.title);
    }
    async function toTerminal(cid) {
      try {
        await shell.agentChat.terminal(cid);
        toast('The chat continues in the Terminal. Come back here any time.');
      } catch (err) {
        toast(cleanErr(err), 'error');
      }
    }

    /* ----- logs, under the preview ----- */
    async function refreshLogs() {
      if (!ws) return;
      const id = ws.id;
      const logs = await shell.userApps.logs(id).catch(() => null);
      if (!ws || ws.id !== id || !logs) return;
      const errors = logs.filter((l) => l.level === 'error').length;
      const badge = $('.ab-badge', win.body);
      if (!badge) return;
      badge.hidden = !errors;
      badge.textContent = errors > 99 ? '99+' : errors;
      const box = $('.ab-logs', win.body);
      box.hidden = !ws.logs;
      if (!ws.logs) return;
      const old = $('.ab-log', box);
      const atBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 30;
      box.innerHTML = `<div class="ab-logs-head"><b>${icon('list', 12)} Logs</b><small>${errors ? `${errors} error${errors === 1 ? '' : 's'}` : 'No errors'} since Leafdeck started</small><span class="grow"></span><button class="btn small" data-ab="clearlogs">Clear</button><button class="tb-btn" data-ab="logs" title="Close">${icon('x', 12)}</button></div>
        ${logs.length ? `<pre class="ab-log">${logs.slice(-80).map((l) => `<span class="lv-${esc(l.level)}">${esc(new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}  ${esc(l.text)}</span>`).join('\n')}</pre>` : '<p class="ab-muted">Console output and errors from the app appear here. Claude reads them too.</p>'}`;
      if (atBottom) {
        const pre = $('.ab-log', box);
        if (pre) pre.scrollTop = pre.scrollHeight;
      }
    }
    const tick = setInterval(() => ws && !document.hidden && refreshLogs(), 5000);
    win.cleanups.push(() => clearInterval(tick));

    /* ================= Sheets: settings, versions, permissions, comments, publishing ================= */

    function settingsSheet() {
      const sheet = win.sheet(`<div class="ab-sheet"><h2>App Builder settings</h2>
        <h5>How much Claude asks</h5>
        <div class="ab-radios">${ASK.map(([k, l, d]) => `<label class="ab-radio"><input type="radio" name="ask" value="${k}" ${prefs.ask === k ? 'checked' : ''}><span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`).join('')}</div>
        <p class="ab-muted">Takes effect with the next message. Every chat also gets Claude Code’s own memory of this app’s folder, and BRIEF.md keeps what you’ve decided.</p>
        <h5>Your apps</h5>
        <label class="ab-radio"><input type="checkbox" name="run" ${appsOff() ? '' : 'checked'}><span><b>Apps can run</b><small>Off stops every app you built from opening, here and in their windows.</small></span></label>
        <h5>Claude Code</h5>
        <div class="ab-agent"><span>${icon(claudeReady() ? 'check' : 'download', 14)}<b>Claude Code</b><small>${claudeReady() ? 'Installed' : 'Not installed'}</small></span>${claudeReady() ? '' : '<button class="btn small primary" data-install="claude">Install</button>'}</div>
        <div class="ab-sheet-actions"><span class="grow"></span><button class="btn" data-close>Done</button></div></div>`);
      sheet.el.addEventListener('change', async (e) => {
        if (e.target.name === 'ask') {
          try {
            prefs = await shell.userApps.setPrefs({ ask: e.target.value });
            const pill = $('.ab-asklevel', win.body);
            if (pill) pill.innerHTML = `${icon('claude', 12)} ${esc(askLabel(prefs.ask))}`;
          } catch (err) {
            toast(cleanErr(err), 'error');
          }
        }
        if (e.target.name === 'run') {
          setAppsOff(!e.target.checked);
          const box = $('[data-off]', win.body);
          if (box) box.checked = e.target.checked;
          if (ws) reloadPreview();
        }
      });
      sheet.el.addEventListener('click', (e) => e.target.closest('[data-close]') && sheet.close());
    }

    async function versionsSheet(id) {
      const versions = await shell.userApps.versions(id).catch(() => []);
      const sheet = win.sheet(`<div class="ab-sheet"><h2>Versions</h2>
        <p class="ab-muted">Leafdeck saves one before Claude changes things (at most every 15 minutes). Restoring saves the current files first.</p>
        <div class="ab-row"><button class="btn small" data-save>Save a version now</button></div>
        ${versions.length ? `<ul class="ab-versions">${versions.map((v) => `<li><span>${esc(v.label || 'Saved')}<small>${esc(new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small></span><button class="btn small" data-restore="${esc(v.id)}">Restore</button></li>`).join('')}</ul>` : '<p class="ab-muted">No versions yet.</p>'}
        <div class="ab-sheet-actions"><span class="grow"></span><button class="btn" data-close>Done</button></div></div>`);
      sheet.el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-close]')) return sheet.close();
        if (e.target.closest('[data-save]')) {
          await shell.userApps.saveVersion(id, 'Saved by you').catch((err) => toast(cleanErr(err), 'error'));
          toast('Version saved');
          sheet.close();
          return versionsSheet(id);
        }
        const r = e.target.closest('[data-restore]');
        if (r) {
          try {
            await shell.userApps.restore(id, r.dataset.restore);
            toast('Restored. The current files were saved as a version first.');
          } catch (err) {
            toast(cleanErr(err), 'error');
          }
          sheet.close();
        }
      });
    }

    function permissionsSheet(id) {
      const m = appOf(id);
      const granted = grantedFor(id);
      const perms = m.permissions || [];
      const sheet = win.sheet(`<div class="ab-sheet"><h2>What ${esc(m.name)} may do</h2>
        ${perms.length ? `<ul class="ua-perms">${perms.map((p) => { const d = describePermission(p); return `<li class="${d.warn ? 'warn' : ''}">${icon(d.icon, 13)}<span>${esc(d.text)}</span>${granted?.includes(p) ? '' : '<em>Not approved</em>'}</li>`; }).join('')}</ul>` : '<p class="ab-muted">Only its own data. It can’t see your other records.</p>'}
        <p class="ab-muted">${granted ? 'You approved these. Revoking asks you again the next time it opens.' : 'You’ll be asked to approve when it opens.'}</p>
        <div class="ab-sheet-actions">${granted ? '<button class="btn danger" data-revoke>Revoke approval</button>' : ''}<span class="grow"></span><button class="btn" data-close>Done</button></div></div>`);
      sheet.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) return sheet.close();
        if (e.target.closest('[data-revoke]')) {
          revoke(id);
          sheet.close();
          reloadPreview();
        }
      });
    }

    function commentsSheet(id) {
      const st = stateOf(id);
      const list = [...st.comments].reverse();
      const sheet = win.sheet(`<div class="ab-sheet"><h2>Comments on ${esc(appOf(id)?.name || 'the app')}</h2>
        ${list.length ? `<ul class="ab-comments">${list.map((c) => `<li class="${esc(c.status)}"><i>${c.n}</i><div><b>${esc(c.label)}</b><p>${esc(c.text)}</p>
            ${c.replies.map((r) => `<p class="ab-reply ${r.from}">${r.from === 'claude' ? icon('claude', 11) : ''}${esc(r.text)}</p>`).join('')}
            <small>${c.status === 'open' ? 'Goes with your next message' : c.status === 'sent' ? 'With Claude now' : 'Resolved'}</small></div>
            <button class="ab-ctx-x" data-remove="${c.id}" title="Delete">${icon('x', 11)}</button></li>`).join('')}</ul>` : `<p class="ab-muted">None yet. Switch the preview to <b>Comment</b> and click where it goes; tell Claude what to do there.</p>`}
        <div class="ab-sheet-actions">${st.comments.some((c) => c.status === 'resolved') ? '<button class="btn" data-clear>Clear resolved</button>' : ''}<span class="grow"></span><button class="btn" data-close>Done</button></div></div>`);
      sheet.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) return sheet.close();
        const rm = e.target.closest('[data-remove]');
        if (rm) {
          removeComment(rm.dataset.remove);
          sheet.close();
          return commentsSheet(id);
        }
        if (e.target.closest('[data-clear]')) {
          st.comments = st.comments.filter((c) => c.status !== 'resolved');
          saveState(id, { comments: st.comments });
          drawStrip();
          sheet.close();
        }
      });
    }

    /* ----- publishing to the store ----- */
    const loadPublisher = async () => (publisher ||= await shell.appStore.publisherStatus().catch(() => ({ key: false })));
    const addPublisherKey = () =>
      ask({
        title: 'Add your publisher key',
        message: 'Leafdeck keeps it encrypted on this computer.',
        win,
        fields: [{ name: 'key', label: 'Publisher key', type: 'password', autocomplete: 'off' }],
        buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true }],
        check: async (r, api) => {
          try {
            publisher = await shell.appStore.setPublisherKey(r.values.key);
            return true;
          } catch (err) {
            api.setError(cleanErr(err));
            return false;
          }
        },
      });
    async function publishSheet(id) {
      const m = appOf(id);
      const [check] = await Promise.all([shell.appStore.preflight(id).catch(() => null), loadPublisher()]);
      let body;
      if (!publisher?.key) body = `<p>Publishing is open to verified publishers for now. If the Leafdeck team gave you a key, add it here.</p><div class="ab-row"><button class="btn small" data-pub="key">Add publisher key</button></div>`;
      else if (publisher.error) body = `<p class="ab-warn">${icon('flag', 13)} ${esc(publisher.error)}</p><div class="ab-row"><button class="btn small" data-pub="retry">Try again</button><button class="btn small" data-pub="forget">Remove key</button></div>`;
      else {
        const errors = check?.errors || ['Leafdeck couldn’t read this app’s folder'];
        body = `<p>${check?.link ? `Published as version ${esc(check.link.version)}.` : 'Not published yet.'} Publishing as ${esc(publisher.publisher?.name || 'you')}.</p>
          ${errors.length ? `<p>Fix these first:</p><ul class="ab-list">${errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
          <div class="ab-row"><button class="btn small primary" data-pub="publish" ${errors.length ? 'disabled' : ''}>${check?.link ? 'Publish update' : 'Publish'}</button><button class="btn small" data-pub="forget">Remove key</button><small>Claude’s notes, chats and hidden files stay on this computer.</small></div>`;
      }
      const sheet = win.sheet(`<div class="ab-sheet"><h2>${icon('upload', 16)} ${esc(m.name)} in the Leafdeck store</h2>${body}<div class="ab-sheet-actions"><span class="grow"></span><button class="btn" data-close>Done</button></div></div>`);
      sheet.el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-close]')) return sheet.close();
        const act = e.target.closest('[data-pub]')?.dataset.pub;
        if (!act) return;
        if (act === 'publish') {
          const perms = m.permissions || [];
          const detail = perms.length ? `It will ask each person for: ${perms.map((p) => describePermission(p).text.toLowerCase()).join(', ')}.` : 'It uses only its own data.';
          if (!(await confirmDialog(`Publish “${m.name}” to the Leafdeck store?`, { ok: 'Publish', win, detail: `Anyone with Leafdeck will be able to install it. ${detail}` }))) return;
          sheet.close();
          try {
            const r = await shell.appStore.publish(id);
            toast(`${m.name} ${r.version} is in the store`);
          } catch (err) {
            await ask({ title: 'It wasn’t published', detail: cleanErr(err), win, buttons: [{ label: 'OK', value: 'ok', primary: true }] });
          }
          await refreshUserApps();
          return;
        }
        if (act === 'key') await addPublisherKey();
        else if (act === 'forget') {
          if (!(await confirmDialog('Remove your publisher key from this computer?', { ok: 'Remove', danger: true, win, detail: 'Your published apps stay in the store. You’ll need the key again to update them.' }))) return;
          publisher = await shell.appStore.forgetPublisherKey();
        } else publisher = null;
        sheet.close();
        publishSheet(id);
      });
    }

    async function removeApp(id) {
      const m = appOf(id);
      if (!(await confirmDialog(`Remove “${m?.name || id}”?`, { ok: 'Remove', danger: true, win, detail: 'Its folder, with its chats, moves to Leafdeck Apps/.trash; nothing is deleted.' }))) return;
      for (const c of stateOf(id)?.chats || []) {
        const cid = chatIdOf(id, c.n);
        shell.agentChat.stop(cid).catch(() => {});
        sessions.get(cid)?.destroy();
        sessions.delete(cid);
      }
      try {
        await shell.userApps.remove(id);
      } catch (err) {
        return toast(cleanErr(err), 'error');
      }
      revoke(id);
      states.delete(id);
      await refreshUserApps();
      drawHome();
    }

    function moreMenu(btn) {
      const id = ws.id;
      const r = btn.getBoundingClientRect();
      showMenu(Math.max(8, r.right - 240), r.bottom + 4, [
        { label: 'Comments…', act: () => commentsSheet(id) },
        { label: 'Versions…', act: () => versionsSheet(id) },
        { label: 'Permissions…', act: () => permissionsSheet(id) },
        { label: 'Publish to the store…', act: () => publishSheet(id) },
        '-',
        { label: 'Open folder', act: () => shell.userApps.openFolder(id) },
        { label: 'Continue this chat in Terminal', act: () => toTerminal(chatIdOf(id, stateOf(id).current)) },
        '-',
        { label: 'Settings…', act: settingsSheet },
        '-',
        { label: 'Remove app…', act: () => removeApp(id) },
      ], { minWidth: 240 });
    }

    /* ================= events ================= */

    win.el.addEventListener('submit', (e) => {
      if (!e.target.closest('.ab-ask')) return;
      e.preventDefault();
      build(e.target);
    });
    win.el.addEventListener('change', (e) => {
      if (e.target.matches('[data-off]')) {
        setAppsOff(!e.target.checked);
        if (ws) reloadPreview();
      }
    });
    win.el.addEventListener('keydown', (e) => {
      const tile = e.target.closest?.('.ab-tile[data-app]');
      if (tile && e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openWorkspace(tile.dataset.app);
      }
    });
    win.el.addEventListener('click', async (e) => {
      const t = e.target;
      const sugg = t.closest('[data-sugg]');
      if (sugg) return currentSession()?.send(sugg.dataset.sugg);
      const ab = t.closest('[data-ab]')?.dataset.ab;
      if (ab) {
        if (ab === 'home') return drawHome();
        if (ab === 'folder') return shell.userApps.openFolder('');
        if (ab === 'settings') return settingsSheet();
        if (!ws) return;
        if (ab === 'openapp') return openUserApp(ws.id);
        if (ab === 'more') return moreMenu(t.closest('[data-ab]'));
        if (ab === 'chats') return chatsMenu(t.closest('[data-ab]'));
        if (ab === 'newchat') return newChat(ws.id);
        if (ab === 'reload') return reloadPreview();
        if (ab === 'logs') {
          ws.logs = !ws.logs;
          return refreshLogs();
        }
        if (ab === 'clearlogs') {
          await shell.userApps.logs(ws.id, true).catch(() => {});
          return refreshLogs();
        }
        if (ab === 'unselect') return clearSelection();
        if (ab === 'comments') return commentsSheet(ws.id);
        if (ab === 'sendcomments') return currentSession()?.send('Please do what the comments pinned on the app ask.');
        return;
      }
      const mode = t.closest('.ab-modes [data-mode]');
      if (mode) return setMode(mode.dataset.mode);
      const width = t.closest('.ab-widths [data-width]');
      if (width) return setWidth(width.dataset.width);
      const inst = t.closest('[data-install]');
      if (inst) {
        try {
          await shell.userApps.installAgent(inst.dataset.install);
          toast('Installing in a new terminal window. Come back here when it’s done.');
        } catch (err) {
          toast(cleanErr(err), 'error');
        }
        return;
      }
      const ex = t.closest('[data-example]');
      if (ex) {
        const x = EXAMPLES[Number(ex.dataset.example)];
        const form = $('.ab-ask', win.body);
        form.description.value = x.prompt;
        form.name.value = x.name;
        form.description.focus();
        return;
      }
      const op = t.closest('[data-openapp]');
      if (op) {
        e.stopPropagation();
        return openUserApp(op.dataset.openapp);
      }
      const tile = t.closest('.ab-tile[data-app]');
      if (tile) return openWorkspace(tile.dataset.app);
    });

    win.builder = { open: (id) => openWorkspace(id) };
    win.cleanups.push(
      onUserApps(() => {
        if (view === 'home') return drawHome();
        const m = appOf(view);
        if (!m) return drawHome();
        win.setTitle(m.name);
        const ob = $('[data-ab="openapp"]', win.tools);
        if (ob) ob.disabled = !m.hasIndex;
      })
    );
    loadStatus().then(() => view === 'home' && drawHome());
  },
});
