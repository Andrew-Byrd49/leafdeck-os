// Claude Code: the desktop app for Claude Code, in Leafdeck. Sessions down the side, grouped by the folder they work
// in; each session is Claude Code in that folder (headless: electron/agentchat.cjs), shown as the Claude desktop app
// shows it (claudecode/session.js): tool calls as cards with diffs and output, approvals, questions and plans you answer
// in place, and a composer with the permission mode, model, effort and context. Beside it, the Changes panel
// (claudecode/changes.js: the folder's git diff) and a terminal drawer with shells in the folder. A session can run in
// a git worktree of its own (electron/codegit.cjs), so several can work on one repo at once.
// A session can pop out into a window of its own; more windows of the app ('claudecode:2'…) show other sessions side
// by side. Sessions and their transcripts outlive the window (and Leafdeck; on Leafdeck OS the shells do too). The
// folders ("projects") and their sessions are kept by the main process (electron/main.cjs, PROJECTS).
import { esc, $ } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, addResolver, openApp, wins, toast, closeWindow, showMenu, mergeTitleBar, pair, setRect, screens } from '../wm.js';
import { shell } from '../shell.js';
import { listen } from '../agentchat.js';
import { ask, confirmDialog } from '../dialogs.js';
import { pickFiles } from '../filepicker.js';
import { createShellView } from '../shellview.js';
import { createSession, attachments, MODES } from '../claudecode/session.js';
import { createChanges } from '../claudecode/changes.js';

const supported = !!shell?.agentChat && !!shell?.projects;
const termsOk = !!shell?.term && shell.platform === 'linux';
const APP = 'claudecode';
const isAppWin = (id) => id === APP || /^claudecode:\d+$/.test(id);
const POPOUT = /^claudecode:chat:([a-z0-9]{6,12}):(\d{1,4})$/;
const popoutId = (pid, n) => `claudecode:chat:${pid}:${n}`;
const chatId = (pid, n) => `@project:${pid}:${n}`;

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
let home = '';
const tilde = (p) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d` : d < 365 ? `${Math.round(d / 7)}w` : `${Math.round(d / 365)}y`;
};

/* ---------------- folders and sessions (shared by every window) ---------------- */

let projects = []; // [{ id, path, name, added, chats: [{ n, title, created, at, worktree, branch }], current, exists }]
let loaded = null;
let info = null; // what Claude Code said about itself: models, commands, account
const sessions = new Map(); // chat id -> the session view (claudecode/session.js), kept while Leafdeck runs
const previews = new Map(); // chat id -> { url, win }: the dev server a session started, and the browser window showing it
const states = new Map(); // chat id -> { busy, waiting }
const unseen = new Set(); // chats that finished or need you while nobody was looking
const redraw = () => {
  for (const [id, w] of wins) if (isAppWin(id)) w.ccDraw?.();
};
const redrawSide = () => {
  for (const [id, w] of wins) if (isAppWin(id)) w.ccSide?.();
};
async function load() {
  projects = await shell.projects.list().catch(() => []);
  if (!home) home = (await shell.files?.places?.().catch(() => null))?.home || '';
  info = await shell.agentChat.info().catch(() => null);
  for (const p of projects) for (const c of p.chats || []) watch(p, c);
  redraw();
}
const projectOf = (pid) => projects.find((p) => p.id === pid) || null;
const chatOf = (pid, n) => projectOf(pid)?.chats?.find((c) => c.n === n) || null;
async function update(pid, patch) {
  const p = await shell.projects.update(pid, patch);
  const i = projects.findIndex((x) => x.id === pid);
  if (i >= 0) {
    // The main process doesn't keep the times; ours stay.
    const at = new Map((projects[i].chats || []).map((c) => [c.n, c.at]));
    projects[i] = { ...projects[i], ...p, chats: (p.chats || []).map((c) => ({ ...c, at: at.get(c.n) || c.created })) };
  }
  redraw();
  return p;
}
const shownAnywhere = (pid, n) => [...wins.entries()].some(([id, w]) => (isAppWin(id) && w.ccShows?.(pid, n)) || id === popoutId(pid, n));

/** Working / waiting for you, for the dots in the sidebar; a session's title from its first message. */
const watched = new Set();
function watch(p, c) {
  const id = chatId(p.id, c.n);
  if (watched.has(id)) return;
  watched.add(id);
  const sync = (s, live) => {
    const was = states.get(id);
    const now = { busy: !!s.busy, waiting: !!s.pending?.length };
    states.set(id, now);
    if (live && !shownAnywhere(p.id, c.n)) {
      const title = chatOf(p.id, c.n)?.title || 'A session';
      const show = { label: 'Show', act: () => showChat(p.id, c.n) };
      if (now.waiting && !was?.waiting) {
        unseen.add(id);
        toast(`${title}: Claude needs your answer`, '', show);
      } else if (was?.busy && !now.busy && !now.waiting) {
        unseen.add(id);
        toast(`${title}: Claude finished`, '', show);
      }
    }
    if (!was || was.busy !== now.busy || was.waiting !== now.waiting) redrawSide();
  };
  shell.agentChat.history(id).then((h) => {
    sync(h, false);
    if (!c.title) {
      const first = h.log.find((e) => e.t === 'user');
      if (first) titleChat(p.id, c.n, first.text);
    }
  }, () => {});
  listen(id, (ev) => {
    if (ev.t === 'state') sync(ev, true);
    if (ev.t === 'info') info = ev.info;
    if (ev.t === 'user') {
      const cur = chatOf(p.id, c.n);
      if (cur) cur.at = Date.now();
      if (cur && !cur.title) {
        // The first words for now; then the title Claude Code writes for it, unless it's been renamed meanwhile.
        titleChat(p.id, c.n, ev.text);
        const first = cleanTitle(ev.text);
        shell.agentChat.title(id, ev.text).then((t) => {
          const now = chatOf(p.id, c.n);
          if (t && now && now.title === first) titleChat(p.id, c.n, t);
        }, () => {});
      }
      redrawSide();
    }
  });
}
const cleanTitle = (text) =>
  String(text)
    .replace(/@"?([^\s"]+)"?/g, (_, f) => f.split('/').pop())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
const titleChat = (pid, n, text) => {
  const p = projectOf(pid);
  if (!p || !String(text).trim()) return;
  update(pid, { chats: p.chats.map((c) => (c.n === n ? { ...c, title: cleanTitle(text) } : c)) });
};
async function newChat(pid) {
  const p = projectOf(pid);
  const n = Math.max(0, ...p.chats.map((c) => c.n)) + 1;
  const c = { n, title: '', created: Date.now(), at: Date.now() };
  await update(pid, { chats: [...p.chats, c], current: n });
  watch(p, c);
  return n;
}
async function removeChat(pid, n) {
  const p = projectOf(pid);
  const pop = wins.get(popoutId(pid, n));
  if (pop) closeWindow(pop);
  sessions.get(chatId(pid, n))?.destroy();
  sessions.delete(chatId(pid, n));
  states.delete(chatId(pid, n));
  unseen.delete(chatId(pid, n));
  const rest = p.chats.filter((c) => c.n !== n);
  await update(pid, { chats: rest, current: rest.at(-1)?.n ?? null });
}
async function addProject(dir) {
  const p = await shell.projects.add(dir);
  if (!projects.some((x) => x.id === p.id)) projects.push({ ...p, exists: true, chats: p.chats || [] });
  return projectOf(p.id);
}
function sessionFor(pid, n) {
  const id = chatId(pid, n);
  if (!sessions.has(id)) {
    const cwd = () => chatOf(pid, n)?.worktree || projectOf(pid)?.path || '';
    const s = createSession(id, {
      cwd,
      cwdLabel: () => {
        const c = chatOf(pid, n);
        return c?.branch ? `${projectOf(pid)?.name} (worktree ${c.branch})` : tilde(projectOf(pid)?.path || '');
      },
      files: () => shell.projects.files(pid, n),
      folderName: () => projectOf(pid)?.name || '',
      folderMenu: (btn) => emptyFolderMenu(btn, pid, n),
      openFile: (f) => openFileIn(cwd(), f),
      openUrl: async (u) => (await import('./browser.js')).openWebPage(u),
      newSession: () => {
        for (const [wid, w] of wins) if (isAppWin(wid) && w.ccShows?.(pid, n)) return w.ccNew?.(pid);
        showNew(pid);
      },
      changed: () => {
        for (const [wid, w] of wins) if (isAppWin(wid) && w.ccShows?.(pid, n)) w.ccChanged?.();
      },
      onUrl: (url) => {
        const p = previews.get(id);
        if (p?.url === url) return;
        previews.set(id, { url, win: p?.win || null });
        redraw();
      },
    });
    sessions.set(id, s);
  }
  return sessions.get(id);
}
/* A session nobody has said anything in can still change folders. A chat belongs to its folder, so it becomes a new one
   there, with what was being written and what was picked, in the same place on screen. */
async function moveEmptyChat(pid, n, toPid) {
  const from = sessions.get(chatId(pid, n));
  if (toPid === pid || !from?.isEmpty()) return;
  const st = from.state();
  const draft = from.takeDraft();
  let m;
  try {
    m = await newChat(toPid);
    const patch = {};
    if (st.mode) patch.mode = st.mode;
    if (st.pick?.model) patch.model = st.pick.model;
    if (st.pick?.effort) patch.effort = st.pick.effort;
    if (st.ultracode?.on) patch.ultracode = true;
    if (Object.keys(patch).length) await shell.agentChat.set(chatId(toPid, m), patch).catch(() => {});
  } catch (err) {
    from.giveDraft(draft);
    return toast(err.message, 'error');
  }
  sessionFor(toPid, m).giveDraft(draft);
  const pop = wins.get(popoutId(pid, n));
  if (pop) {
    const rect = pop.rect;
    const w = openApp(popoutId(toPid, m));
    if (w && rect) setRect(w, rect);
  }
  for (const [id, w] of wins) if (isAppWin(id)) w.ccMoved?.(pid, n, toPid, m);
  await removeChat(pid, n);
  redraw();
}
function emptyFolderMenu(btn, pid, n) {
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.top - 4, [
    { header: 'Work in' },
    ...projects.filter((x) => x.exists !== false).map((x) => ({ label: x.name, key: tilde(x.path).length > 28 ? '' : tilde(x.path), checked: x.id === pid, act: () => moveEmptyChat(pid, n, x.id) })),
    '-',
    { label: 'Choose a folder…', act: async () => {
      const res = await pickFiles({ mode: 'open', directory: true, title: 'Choose a folder for Claude to work in', accept: 'Choose' });
      const dir = res?.paths?.[0];
      if (!dir) return;
      try {
        const p = await addProject(dir);
        redraw();
        await moveEmptyChat(pid, n, p.id);
      } catch (err) {
        toast(err.message, 'error');
      }
    } },
  ], { up: true, minWidth: 220 });
}
function openFileIn(cwd, f) {
  const m = /^(.*?)(?::(\d+))?$/.exec(String(f).replace(/^"|"$/g, ''));
  const file = m[1].startsWith('/') ? m[1] : `${cwd}/${m[1]}`;
  openApp('editor', { file });
}
/** Show a session in the app window that has it, or the main one. */
function showChat(pid, n) {
  const pop = wins.get(popoutId(pid, n));
  if (pop) return openApp(pop.id);
  const w = [...wins.entries()].find(([id, x]) => isAppWin(id) && x.ccShows?.(pid, n))?.[1] || [...wins.entries()].find(([id]) => isAppWin(id))?.[1];
  if (w) {
    openApp(w.id);
    w.ccSelect?.(pid, n);
  } else {
    pendingShow = { pid, n };
    openApp(APP);
  }
}
function showNew(pid) {
  const w = [...wins.entries()].find(([id]) => isAppWin(id))?.[1];
  if (w) {
    openApp(w.id);
    w.ccNew?.(pid);
  } else {
    pendingShow = { pid, n: null };
    openApp(APP);
  }
}
let pendingShow = null;

/* ---------------- shells per folder (the terminal drawer) ---------------- */

const shellsKey = (key) => `claudecode:shells:${key}`;
const placeShells = new Map(); // place (project id, or project:n for a worktree) -> { ids, active, existing }
const shellViews = new Map(); // shell id -> view (shellview.js); one element, shown in whichever window drew it last
async function shellsOf(key) {
  if (placeShells.has(key)) return placeShells.get(key);
  const saved = store.get(shellsKey(key), { ids: [], active: null });
  const running = new Map(((await shell.term.list?.().catch(() => [])) || []).map((t) => [t.id, t]));
  const ids = (saved.ids || []).filter((id) => running.has(id));
  const m = { ids, active: ids.includes(saved.active) ? saved.active : ids[0] || null, existing: running };
  placeShells.set(key, m);
  saveShells(key);
  return m;
}
const saveShells = (key) => {
  const m = placeShells.get(key);
  if (m) store.set(shellsKey(key), { ids: m.ids, active: m.active });
};

/* ---------------- the app window ---------------- */

let startIn = null; // a folder to add and show (openApp('claudecode', { project }))
export function newClaudeCodeWindow() {
  let n = 2;
  while (wins.has(`claudecode:${n}`)) n++;
  return openApp(`claudecode:${n}`);
}

const NEW_PICKS = 'claudecode:newpicks';

const app = {
  id: APP,
  name: 'Claude Code',
  icon: 'claude',
  logo: '/img/claude.png',
  color: 'orange',
  size: [1280, 820],
  min: [760, 480],
  hidden: !supported,
  launch(opts) {
    startIn = typeof opts?.project === 'string' ? opts.project : null;
  },
  menuItems: () => (supported ? [{ label: 'New Claude Code Window', act: () => newClaudeCodeWindow() }] : []),
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Claude Code lives in the Leafdeck app</div><p>Running Claude Code on your projects needs the desktop app.</p></div>`;
      return;
    }
    loaded ||= load();
    const selKey = `claudecode:sel:${win.id}`;
    // What this window shows: a session ({ pid, n }) or the new-session screen ({ pid, n: null }).
    let sel = store.get(selKey, null);
    if (typeof sel === 'string') sel = { pid: sel, n: null }; // before sessions were picked per window
    const prefs = store.get(`claudecode:win:${win.id}`, {});
    let termOpen = !!prefs.term;
    let termH = prefs.termH || 260;
    let sideOpen = prefs.side !== false;
    // The sidebar's width: this window's, else the last one set in any window.
    const SIDE_W = 264;
    let sideW = prefs.sideW || store.get('claudecode:sideW', SIDE_W);
    let rightOpen = !!prefs.right;
    let rightW = prefs.rightW || 420;
    let query = '';
    const collapsed = new Set(store.get('claudecode:collapsed', []));
    const savePrefs = () => store.set(`claudecode:win:${win.id}`, { term: termOpen, termH, side: sideOpen, sideW, right: rightOpen, rightW, splitAt });

    // No title bar: the top row of the app is the window's (it drags it; the window buttons sit at its right end).
    win.body.innerHTML = `<div class="cc${sideOpen ? '' : ' noside'}" style="--side-w:${sideW}px"><aside class="cc-side"></aside><div class="cc-side-grip" title="Drag to resize, double-click for the usual width"></div>
      <section class="cc-main"><div class="cc-bar win-drag"><div class="cc-bar-in"></div><div class="cc-winbtns"></div></div><div class="cc-view"></div></section></div>`;
    const root = $('.cc', win.body);
    const side = $('.cc-side', win.body);
    const main = $('.cc-main', win.body);
    const barIn = $('.cc-bar-in', main);
    const view = $('.cc-view', main);
    mergeTitleBar(win, $('.cc-winbtns', main));
    // A narrow window (half a screen): the sidebar slides over the session instead of taking room from it.
    const ro = new ResizeObserver(() => {
      const narrow = root.clientWidth < 820;
      if (narrow !== root.classList.contains('narrow')) root.classList.toggle('narrow', narrow);
      if (!narrow) root.classList.remove('peek');
    });
    ro.observe(root);
    win.cleanups.push(() => ro.disconnect());
    let drawn = ''; // what the main area shows, so a sidebar update doesn't rebuild it
    // Split view: another session shown beside the focused one (sel), on its left or right; splitAt: the left pane's share.
    let other = store.get(`claudecode:split:${win.id}`, null); // { pid, n, side: 'left' | 'right' }
    let splitAt = prefs.splitAt || 0.5;
    const saveSplit = () => store.set(`claudecode:split:${win.id}`, other);
    let dragEndAt = 0;
    let newForm = null; // the new-session screen's text box and attachments
    const same = (a, b) => !!a && !!b && a.pid === b.pid && a.n === b.n;
    const otherOk = () => !!other && !!chatOf(other.pid, other.n) && !same(other, sel) && sel?.n != null;
    let changes = null; // the Changes panel for the session shown

    const dot = (id) => {
      const st = states.get(id);
      return `<i class="cc-dot${st?.waiting ? ' waiting' : st?.busy ? ' busy' : unseen.has(id) ? ' unseen' : ''}"></i>`;
    };

    /* ----- the sidebar: sessions by folder ----- */
    const drawSide = () => {
      const q = query.trim().toLowerCase();
      const groups = projects
        .map((p) => {
          const list = [...(p.chats || [])].filter((c) => !q || (c.title || 'New session').toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).sort((a, b) => (b.at || 0) - (a.at || 0));
          const open = !collapsed.has(p.id) || q;
          return `<div class="cc-group${p.exists ? '' : ' gone'}" data-pid="${esc(p.id)}">
            <div class="cc-group-head" role="button" tabindex="0" title="${esc(p.exists ? tilde(p.path) : 'Folder not found')}">
              <span class="cc-chev${open ? ' open' : ''}">${icon('right', 10)}</span>${icon('folder', 13)}<b>${esc(p.name)}</b>
              <span class="grow"></span>
              <button class="cc-x" data-group-menu title="More">${icon('dots', 12)}</button>
              <button class="cc-x" data-new-in title="New session in ${esc(p.name)}">${icon('plus', 12)}</button></div>
            ${open
              ? `<div class="cc-sessions">${list
                  .map((c) => {
                    const id = chatId(p.id, c.n);
                    const on = sel?.pid === p.id && sel?.n === c.n;
                    return `<div class="cc-sess${on ? ' on' : ''}${wins.has(popoutId(p.id, c.n)) ? ' out' : ''}" role="button" tabindex="0" data-chat="${c.n}">${dot(id)}
                      <span class="cc-sess-t">${esc(c.title || 'New session')}</span>
                      ${c.branch ? `<span class="cc-wt" title="Worktree on ${esc(c.branch)}">${icon('branch', 11)}</span>` : ''}
                      <small>${esc(ago(c.at))}</small>
                      <button class="cc-x" data-close-chat="${c.n}" title="Delete this session">${icon('x', 11)}</button></div>`;
                  })
                  .join('') || (q ? '' : '<p class="cc-none small">No sessions yet</p>')}</div>`
              : ''}</div>`;
        })
        .join('');
      const acct = info?.account;
      side.innerHTML = `<div class="cc-side-head win-drag"><img class="cc-side-logo" src="/img/claude-code.svg" alt="" draggable="false"><i class="cc-side-word" role="img" aria-label="Claude"></i><span class="grow"></span>
          <button class="tb-btn" data-cc="window" title="New window">${icon('new-window', 14)}</button></div>
        <div class="cc-side-top">
          <button class="cc-newbtn" data-cc="new">${icon('plus', 14)}<span>New session</span><kbd>Ctrl+N</kbd></button>
          <label class="cc-search">${icon('search', 13)}<input type="search" placeholder="Search sessions" value="${esc(query)}" spellcheck="false"></label></div>
        <div class="cc-groups">${projects.length ? groups : '<p class="cc-none">Pick a folder to start: a repo, a site, any project.</p>'}</div>
        <div class="cc-side-foot"><button class="cc-addfolder" data-cc="add">${icon('folder', 13)} Add a folder</button>
          ${acct ? `<span class="cc-acct" title="${esc(acct.email)}${info?.version ? ` · Claude Code ${esc(info.version)}` : ''}"><b>${esc(acct.email.split('@')[0] || acct.email)}</b><small>${esc(acct.plan || '')}</small></span>` : ''}</div>`;
      const input = $('.cc-search input', side);
      input.addEventListener('input', () => {
        query = input.value;
        const pos = input.selectionStart;
        drawSide();
        const again = $('.cc-search input', side);
        again.focus();
        again.setSelectionRange(pos, pos);
      });
    };

    /* ----- the main area ----- */
    const bar = (p, c) => {
      const cwd = c?.worktree || p.path;
      win.setTitle(c ? `${c.title || 'New session'} · Claude Code` : 'Claude Code');
      return `<button class="tb-btn" data-cc="side" title="${sideOpen ? 'Hide' : 'Show'} the sidebar">${icon('sidebar', 15)}</button>
        <div class="cc-title">${c ? `<b class="cc-title-t no-drag" data-cc="rename" title="Rename">${esc(c.title || 'New session')}</b>` : '<b>New session</b>'}
          <span class="cc-where"><span title="${esc(cwd)}">${icon('folder', 11)} ${esc(p.name)}</span><span class="cc-branch" hidden></span></span></div>
        <span class="grow"></span>
        ${c ? `<button class="tb-btn cc-openbtn" data-cc="open" title="Open the folder somewhere else">${icon('external', 14)}<span>Open</span>${icon('down', 10)}</button>
        <button class="tb-btn cc-previewbtn" data-cc="preview" hidden>${icon('globe', 14)}<span>Preview</span></button>
        ${termsOk ? `<button class="tb-btn cc-termbtn${termOpen ? ' on' : ''}" data-cc="term" title="Terminal in this folder (Ctrl+\`)">${icon('terminal', 15)}</button>` : ''}
        <button class="tb-btn cc-rightbtn${rightOpen ? ' on' : ''}" data-cc="right" title="Changes">${icon('panel', 15)}<span class="cc-badge" hidden></span></button>
        <button class="tb-btn" data-cc="popout" title="Open this session in its own window">${icon('new-window', 14)}</button>` : ''}`;
    };

    const drawMain = async () => {
      const p = projectOf(sel?.pid);
      if (!projects.length) {
        drawn = 'none';
        changes = null;
        barIn.innerHTML = `<button class="tb-btn" data-cc="side" title="Show or hide the sidebar">${icon('sidebar', 15)}</button>`;
        view.innerHTML = `<div class="cc-welcome"><img class="cl-logo" src="/img/claude-code.svg" alt="" draggable="false">
          <h2>Claude Code</h2>
          <p>Pick a folder and tell Claude what to build, fix or explain. Run several sessions at once, each in its own worktree if you like, review every change, and keep a terminal beside it.</p>
          <button class="btn primary" data-cc="add">${icon('folder', 12)} Choose a folder</button></div>`;
        return;
      }
      if (!p || sel.n == null || !chatOf(p.id, sel.n)) return drawNew(p || projects[0]);
      const c = chatOf(p.id, sel.n);
      const key = `${p.id}:${c.n}`;
      // The session layout stays put while the focused session changes (so the panes, and what's typed in them, stay).
      if (!$(':scope > .cc-split', view)) {
        drawn = '';
        view.innerHTML = `<div class="cc-split"><div class="cc-center"><div class="cc-chat"></div>
              <div class="cc-term" ${termOpen && termsOk ? '' : 'hidden'} style="height:${termH}px"><div class="cc-term-grip" title="Drag to resize"></div>
                <div class="cc-term-tabs"></div><div class="cc-term-views"></div></div></div>
            <div class="cc-right" ${rightOpen ? '' : 'hidden'} style="width:${rightW}px"><div class="cc-right-grip" title="Drag to resize"></div></div></div>`;
      }
      if (drawn !== key) {
        // The header, the Changes panel and the terminal follow the focused session.
        drawn = key;
        barIn.innerHTML = bar(p, c);
        const badge = () => {
          const b = $('.cc-badge', main);
          if (!b || drawn !== key) return;
          const n = changes.count();
          b.hidden = !n;
          b.textContent = n > 99 ? '99+' : String(n);
        };
        $('.cc-right .ccc', main)?.remove();
        changes = createChanges({
          git: () => shell.projects.git(p.id, c.n),
          diff: (f) => shell.projects.diff(p.id, c.n, f),
          ask: (text) => sessionFor(p.id, c.n).send(text),
          openFile: (f) => openApp('editor', { file: f }),
          counted: badge,
        });
        $('.cc-right', main).append(changes.el);
        changes.refresh();
        shell.projects.repo(p.id, c.n).then((r) => {
          const b = $('.cc-branch', main);
          if (b && r.repo?.branch && drawn === key) {
            b.hidden = false;
            b.innerHTML = `${icon('branch', 11)} ${esc(r.repo.branch)}`;
            b.title = c.worktree ? `A worktree of its own: ${c.worktree}` : `Branch ${r.repo.branch}`;
          }
        }, () => {});
      }
      const tt = $('.cc-title-t', main);
      if (tt) tt.textContent = c.title || 'New session';
      const pv = previews.get(chatId(p.id, c.n));
      const pb = $('.cc-previewbtn', main);
      if (pb) {
        pb.hidden = !pv;
        pb.title = pv ? `Open ${pv.url} beside this window` : '';
      }
      unseen.delete(chatId(p.id, c.n));
      drawPanes();
      if (termOpen && termsOk) drawTerm(p, c);
    };

    /* ----- the sessions shown: one, or two side by side ----- */
    const fill = (box, x, focusIt) => {
      const id = chatId(x.pid, x.n);
      if (wins.has(popoutId(x.pid, x.n))) {
        if (box.dataset.away !== id) {
          box.dataset.away = id;
          box.innerHTML = `<div class="cc-away">${icon('new-window', 18)}<b>This session is open in its own window</b><button class="btn small" data-cc="bringback" data-pid="${esc(x.pid)}" data-n="${x.n}">Bring it back here</button></div>`;
        }
        return;
      }
      delete box.dataset.away;
      const s = sessionFor(x.pid, x.n);
      if (!box.contains(s.el)) {
        box.replaceChildren(s.el);
        s.shown();
        if (focusIt) s.focus();
      }
    };
    const drawPanes = () => {
      const host = $('.cc-chat', main);
      if (!host) return;
      const two = otherOk();
      const left = two && other.side === 'left' ? other : sel;
      const right = two ? (other.side === 'left' ? sel : other) : null;
      const layout = two ? `${left.pid}:${left.n}|${right.pid}:${right.n}` : 'one';
      if (host._layout !== layout) {
        host._layout = layout;
        host.classList.toggle('split', two);
        delete host.dataset.away;
        const pane = (x, side) => `<div class="cc-pane" data-side="${side}" data-pid="${esc(x.pid)}" data-n="${x.n}"${side === 'left' ? ` style="flex-basis:${(splitAt * 100).toFixed(2)}%"` : ''}>
            <div class="cc-pane-head"><i class="cc-dot"></i><b></b><span class="cc-pane-where"></span><span class="grow"></span><button class="cc-x" data-unsplit title="Close this side">${icon('x', 11)}</button></div><div class="cc-pane-body"></div></div>`;
        host.innerHTML = two ? `${pane(left, 'left')}<div class="cc-pane-grip" title="Drag to resize"></div>${pane(right, 'right')}` : '';
      }
      if (!two) return fill(host, sel, true);
      for (const box of host.querySelectorAll('.cc-pane')) {
        const x = { pid: box.dataset.pid, n: Number(box.dataset.n) };
        const id = chatId(x.pid, x.n);
        const st = states.get(id);
        box.classList.toggle('on', same(x, sel));
        const cx = chatOf(x.pid, x.n);
        box.querySelector('.cc-pane-head b').textContent = cx?.title || 'New session';
        // Which folder each side works in (and its worktree's branch), so two sessions are never mixed up.
        const pr = projectOf(x.pid);
        const where = box.querySelector('.cc-pane-where');
        const label = `${pr?.name || ''}${cx?.branch ? ` · ${cx.branch}` : ''}`;
        if (where.dataset.label !== label) {
          where.dataset.label = label;
          where.innerHTML = `${icon('folder', 11)}<span>${esc(label)}</span>`;
          where.title = cx?.worktree || pr?.path || '';
        }
        box.querySelector('.cc-pane-head .cc-dot').className = `cc-dot${st?.waiting ? ' waiting' : st?.busy ? ' busy' : ''}`;
        fill(box.querySelector('.cc-pane-body'), x, same(x, sel));
      }
    };
    // Clicking into the other pane makes it the focused one (the header, Changes and terminal follow it).
    main.addEventListener('pointerdown', (e) => {
      const box = e.target.closest('.cc-pane:not(.on)');
      if (!box || e.target.closest('[data-unsplit]')) return;
      const was = sel;
      const wasSide = box.dataset.side === 'left' ? 'right' : 'left';
      sel = { pid: box.dataset.pid, n: Number(box.dataset.n) };
      other = { pid: was.pid, n: was.n, side: wasSide };
      store.set(selKey, sel);
      saveSplit();
      drawSide();
      drawMain();
    }, true);

    /* ----- dragging a session from the sidebar: split, open here, or out of the window into its own ----- */
    // "New session" drags too (x.n null): beside the session or out of the window it's a new session in the folder
    // shown, made when it's dropped; "here" is the new-session screen.
    const ZONE_TEXT = { left: 'Split: open on the left', right: 'Split: open on the right', center: 'Open here', out: 'Open in its own window' };
    function dragSession(x, startEv) {
      root.classList.remove('peek');
      document.body.classList.add('wm-busy');
      const c = chatOf(x.pid, x.n);
      const ghost = document.createElement('div');
      ghost.className = 'cc-ghost';
      ghost.innerHTML = `${icon('claude', 13)}<b>${esc(c?.title || 'New session')}</b><small></small>`;
      document.body.append(ghost);
      // The drop zones cover the chat (or, on the new-session screen, the whole view: open it there).
      const target = $('.cc-chat', main) || view;
      const canSplit = !!$('.cc-chat', main) && !(same(x, sel) && !otherOk());
      const drop = document.createElement('div');
      drop.className = 'cc-drop';
      drop.innerHTML = '<div class="cc-drop-hl"><span></span></div>';
      target.append(drop);
      let zone = null;
      const move = (cx, cy) => {
        const gw = ghost.offsetWidth;
        ghost.style.transform = `translate(${cx + 14 + gw > innerWidth ? cx - gw - 10 : cx + 14}px, ${cy + 10}px)`;
        const w = win.el.getBoundingClientRect();
        const r = target.getBoundingClientRect();
        if (cx < w.left || cx > w.right || cy < w.top || cy > w.bottom) zone = 'out';
        else if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) zone = null;
        else if (canSplit && cx < r.left + r.width * 0.3) zone = 'left';
        else if (canSplit && cx > r.right - r.width * 0.3) zone = 'right';
        else zone = 'center';
        drop.dataset.zone = zone && zone !== 'out' ? zone : '';
        drop.querySelector('span').textContent = ZONE_TEXT[zone] || '';
        ghost.querySelector('small').textContent = zone === 'out' ? ZONE_TEXT.out : '';
        ghost.classList.toggle('out', zone === 'out');
      };
      move(startEv.clientX, startEv.clientY);
      const end = async (cx, cy, cancel) => {
        document.body.classList.remove('wm-busy');
        ghost.remove();
        drop.remove();
        dragEndAt = Date.now();
        if (cancel || !zone) return;
        if (x.n == null) {
          if (zone === 'center') return select(x.pid, null);
          try {
            x = { pid: x.pid, n: await newChat(x.pid) };
          } catch (err) {
            return toast(err.message, 'error');
          }
        }
        const pop = wins.get(popoutId(x.pid, x.n));
        if (zone === 'out') {
          // Out of the window: the session in a window of its own, where it was let go. This window shows what's left.
          if (same(x, other)) other = null;
          else if (same(x, sel) && otherOk()) {
            sel = { pid: other.pid, n: other.n };
            other = null;
          }
          saveSplit();
          store.set(selKey, sel);
          const w = pop ? openApp(pop.id) : openApp(popoutId(x.pid, x.n));
          if (w) {
            // Its title row under the pointer, kept on the screen it was dropped on.
            const sc = screens().find((r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) || screens()[0];
            const ww = Math.min(w.rect?.w || 620, sc.w - 16);
            const wh = Math.min(w.rect?.h || 780, sc.h - 80);
            setRect(w, { x: Math.round(Math.max(sc.x + 8, Math.min(cx - ww / 2, sc.x + sc.w - ww - 8))), y: Math.round(Math.max(sc.y + 36, Math.min(cy - 20, sc.y + sc.h - wh - 70))), w: ww, h: wh });
          }
          return draw();
        }
        if (pop) closeWindow(pop); // back from its own window
        if (zone === 'center') return select(x.pid, x.n);
        // Beside the focused session: it opens on that side and takes the focus.
        if (same(x, sel)) other.side = zone === 'left' ? 'right' : 'left';
        else if (same(x, other)) other.side = zone;
        else {
          other = { pid: sel.pid, n: sel.n, side: zone === 'left' ? 'right' : 'left' };
          sel = { pid: x.pid, n: x.n };
        }
        const host = $('.cc-chat', main);
        if (host) host._layout = ''; // the sides may have swapped
        saveSplit();
        store.set(selKey, sel);
        draw();
      };
      return { move, end };
    }
    side.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.cc-sess, .cc-newbtn');
      if (!row || e.button !== 0 || e.target.closest('.cc-x')) return;
      const fresh = row.classList.contains('cc-newbtn');
      const pid = fresh ? (projectOf(sel?.pid) ? sel.pid : projects[0]?.id) : row.closest('.cc-group').dataset.pid;
      if (!pid) return;
      // No text selection from the press: once there is one, the next drag drags the text instead (and the pointer is
      // cancelled). It's still a click.
      e.preventDefault();
      const x = { pid, n: fresh ? null : Number(row.dataset.chat) };
      const x0 = e.clientX;
      const y0 = e.clientY;
      let d = null;
      const move = (ev) => {
        if (!d && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        d ||= dragSession(x, ev);
        d.move(ev.clientX, ev.clientY);
      };
      const stop = (ev, cancel) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', no);
        removeEventListener('keydown', onKey);
        d?.end(ev.clientX, ev.clientY, cancel);
      };
      const up = (ev) => stop(ev, false);
      const no = (ev) => stop(ev, true);
      const onKey = (ev) => ev.key === 'Escape' && stop({ clientX: 0, clientY: 0 }, true);
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', no);
      addEventListener('keydown', onKey);
    });
    // The line between the panes moves.
    main.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.cc-pane-grip');
      if (!grip || e.button !== 0) return;
      const host = grip.parentElement;
      const leftPane = host.querySelector('.cc-pane[data-side="left"]');
      grip.setPointerCapture(e.pointerId);
      root.classList.add('resizing');
      const mv = (ev) => {
        const r = host.getBoundingClientRect();
        splitAt = Math.max(0.25, Math.min(0.75, (ev.clientX - r.left) / r.width));
        leftPane.style.flexBasis = `${(splitAt * 100).toFixed(2)}%`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', mv);
        root.classList.remove('resizing');
        savePrefs();
      };
      grip.addEventListener('pointermove', mv);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('pointercancel', up, { once: true });
    });

    /* ----- a new session: pick the folder, the worktree, the mode, model and Ultracode, then say what to do ----- */
    const drawNew = (p) => {
      const key = `new:${p.id}`;
      sel = { pid: p.id, n: null };
      if (drawn === key) return;
      drawn = key;
      changes = null;
      // Another folder on this screen keeps what's been written and attached.
      const carry = newForm?.ta.isConnected ? { text: newForm.ta.value, atts: newForm.atts.take() } : null;
      const picks = store.get(NEW_PICKS, { mode: 'default', model: null, worktree: false, ultracode: false });
      barIn.innerHTML = bar(p, null);
      view.innerHTML = `<div class="cc-new">
          <div class="cc-new-in"><img class="cl-logo" src="/img/claude-code.svg" alt="" draggable="false">
          <h2>What should we work on?</h2>
          <form class="cc-new-box">
            <div class="ccs-atts" hidden></div>
            <textarea rows="3" placeholder="Describe a task, ask a question, or type / for commands" spellcheck="true"></textarea>
            <div class="ccs-row">
              <button type="button" class="ccs-chip ccs-attach" title="Attach images or files (or paste and drop them)">${icon('plus', 14)}</button>
              <button type="button" class="ccs-chip cc-pick-folder" title="${esc(p.path)}">${icon('folder', 12)}<span>${esc(p.name)}</span>${icon('down', 10)}</button>
              <button type="button" class="ccs-chip cc-pick-wt" hidden title="Work in a git worktree of its own, on a new branch, so other sessions in this repo aren't affected">${icon('branch', 12)}<span>Worktree</span></button>
              <button type="button" class="ccs-chip cc-pick-mode"></button>
              <span class="grow"></span>
              <button type="button" class="ccs-chip cc-pick-model"></button>
              <button type="button" class="ccs-chip ccs-ultra cc-pick-ultra" aria-pressed="false" title="Ultracode: Claude plans and runs multi-agent workflows for every substantive task (more thorough, uses many more tokens). Applies to this session, where the model offers it.">${icon('sparkle', 12)}<span>Ultracode</span></button>
              <button type="submit" class="ccs-send" title="Start (Enter)">${icon('up', 15)}</button>
            </div>
          </form>
          <div class="cc-new-recent"></div></div></div>`;
      const ta = $('.cc-new-box textarea', main);
      const wt = $('.cc-pick-wt', main);
      const drawPicks = () => {
        const m = MODES.find((x) => x.id === picks.mode) || MODES[0];
        $('.cc-pick-mode', main).innerHTML = `${icon(m.id === 'plan' ? 'note' : m.id === 'bypassPermissions' ? 'bolt' : m.id === 'default' ? 'key' : 'tick', 12)}<span>${esc(m.short)}</span>`;
        $('.cc-pick-mode', main).dataset.mode = m.id;
        $('.cc-pick-mode', main).title = `${m.label}: ${m.hint}`;
        const models = info?.models || [];
        const cm = models.find((x) => x.value === (picks.model || 'default'));
        $('.cc-pick-model', main).innerHTML = `<span>${esc(!picks.model ? 'Default model' : cm?.name || picks.model)}</span>${icon('down', 10)}`;
        wt.classList.toggle('on', !!picks.worktree);
        $('.cc-pick-ultra', main).setAttribute('aria-pressed', String(!!picks.ultracode));
      };
      drawPicks();
      shell.projects.repo(p.id).then((r) => {
        if (drawn !== key) return;
        wt.hidden = !r.repo;
        if (r.repo?.branch) wt.title = `Work in a git worktree of its own (a new branch from ${r.repo.branch}), so other sessions in this repo aren't affected`;
      }, () => {});
      // Recent sessions here, and the ones run in a terminal in this folder (pick one up: it resumes here).
      const recent = [...(p.chats || [])].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5);
      const listHtml = (cli) =>
        `${recent.length ? `<h5>Recent in ${esc(p.name)}</h5>${recent.map((c) => `<button type="button" class="cc-recent" data-recent="${c.n}">${dot(chatId(p.id, c.n))}<span>${esc(c.title || 'New session')}</span><small>${esc(ago(c.at))}</small></button>`).join('')}` : ''}
        ${cli.length ? `<h5>From the terminal</h5>${cli.slice(0, 8).map((x) => `<button type="button" class="cc-recent" data-adopt="${esc(x.id)}" data-at="${x.at}" title="Continue this session here. Close it in the terminal first so they don’t both write to it.">${icon('terminal', 12)}<span>${esc(x.title)}</span><small>${esc(ago(x.at))}</small></button>`).join('')}` : ''}`;
      $('.cc-new-recent', main).innerHTML = listHtml([]);
      shell.projects.terminalSessions(p.id).then((cli) => drawn === key && ($('.cc-new-recent', main).innerHTML = listHtml(cli)), () => {});
      const grow = () => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(300, Math.max(72, ta.scrollHeight))}px`;
      };
      ta.addEventListener('input', grow);
      // Full paths in @-mentions here: the folder can still change.
      const atts = attachments({
        root: $('.cc-new', main),
        box: $('.cc-new-box .ccs-atts', main),
        ta,
        cwd: () => null,
        folder: () => p.path,
        mention: (text) => {
          const at = ta.selectionStart ?? ta.value.length;
          const pad = at && !/\s/.test(ta.value[at - 1]) ? ' ' : '';
          ta.setRangeText(pad + text, at, ta.selectionEnd ?? at, 'end');
          grow();
          ta.focus();
        },
      });
      newForm = { ta, atts };
      if (carry) {
        ta.value = carry.text;
        atts.add(carry.atts);
        grow();
      }
      const start = async () => {
        const text = ta.value.trim();
        if (!text && !atts.list.length) return ta.focus();
        $('.cc-new-box', main).classList.add('starting');
        try {
          const n = await newChat(p.id);
          if (picks.worktree && !wt.hidden) {
            try {
              const c = await shell.projects.worktree(p.id, n, text || atts.list[0]?.name || 'session');
              Object.assign(chatOf(p.id, n), { worktree: c.worktree, branch: c.branch });
            } catch (err) {
              toast(`Couldn’t make a worktree: ${err.message}. The session works in the folder itself.`, 'error');
            }
          }
          const patch = {};
          if (picks.mode && picks.mode !== 'default') patch.mode = picks.mode;
          if (picks.model) patch.model = picks.model;
          if (picks.ultracode) patch.ultracode = true;
          if (Object.keys(patch).length) await shell.agentChat.set(chatId(p.id, n), patch).catch(() => {});
          select(p.id, n);
          const s = sessionFor(p.id, n);
          s.attach(atts.take());
          s.send(text);
        } catch (err) {
          toast(err.message, 'error');
          $('.cc-new-box', main)?.classList.remove('starting');
        }
      };
      $('.cc-new-box', main).addEventListener('submit', (e) => {
        e.preventDefault();
        start();
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          start();
        }
        if (e.key === 'Tab' && e.shiftKey) {
          e.preventDefault();
          const order = ['default', 'acceptEdits', 'plan'];
          picks.mode = order[(order.indexOf(picks.mode) + 1) % order.length];
          store.set(NEW_PICKS, picks);
          drawPicks();
        }
      });
      const menuAt = (btn, items) => {
        const r = btn.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, items, { minWidth: 220 });
      };
      $('.cc-new-box', main).addEventListener('click', (e) => {
        const t = e.target;
        if (t.closest('.ccs-attach')) return atts.pick();
        if (t.closest('.cc-pick-folder'))
          return menuAt(t.closest('button'), [
            { header: 'Work in' },
            ...projects.map((x) => ({ label: x.name, key: tilde(x.path).length > 28 ? '' : tilde(x.path), checked: x.id === p.id, act: () => select(x.id, null) })),
            '-',
            { label: 'Choose a folder…', act: () => chooseFolder() },
          ]);
        if (t.closest('.cc-pick-wt')) {
          picks.worktree = !picks.worktree;
          store.set(NEW_PICKS, picks);
          return drawPicks();
        }
        if (t.closest('.cc-pick-ultra')) {
          picks.ultracode = !picks.ultracode;
          store.set(NEW_PICKS, picks);
          return drawPicks();
        }
        if (t.closest('.cc-pick-mode'))
          return menuAt(t.closest('button'), [{ header: 'Permission mode' }, ...MODES.map((m) => ({ label: m.label, checked: picks.mode === m.id, act: () => {
            picks.mode = m.id;
            store.set(NEW_PICKS, picks);
            drawPicks();
          } }))]);
        if (t.closest('.cc-pick-model'))
          return menuAt(t.closest('button'), [{ header: 'Model' }, ...(info?.models?.length ? info.models : [{ value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'haiku', name: 'Haiku' }]).map((m) => ({ label: m.value === 'default' ? 'Default' : m.name, checked: (picks.model || 'default') === m.value, act: () => {
            picks.model = m.value === 'default' ? null : m.value;
            store.set(NEW_PICKS, picks);
            drawPicks();
          } }))]);
      });
      requestAnimationFrame(() => ta.focus());
    };

    /* ----- the terminal drawer ----- */
    const placeOf = (p, c) => (c?.worktree ? `${p.id}:${c.n}` : p.id);
    const drawTerm = async (p, c) => {
      const box = $('.cc-term', main);
      if (!box || box.hidden) return;
      const place = placeOf(p, c);
      const cwd = c?.worktree || p.path;
      const m = await shellsOf(place);
      if (!$('.cc-term', main) || drawn !== `${p.id}:${c.n}`) return;
      const viewsEl = $('.cc-term-views', main);
      if (!m.ids.length) {
        const v = await createShellView(viewsEl, { cwd, onExit: () => dropShell(place, v.id), onTitle: () => drawTabs(place) });
        if (!v) return;
        shellViews.set(v.id, v);
        m.ids.push(v.id);
        m.active = v.id;
        saveShells(place);
      }
      for (const id of m.ids) {
        let v = shellViews.get(id);
        if (!v) {
          v = await createShellView(viewsEl, { existing: m.existing.get(id), onExit: () => dropShell(place, id), onTitle: () => drawTabs(place) });
          if (!v) continue;
          shellViews.set(id, v);
        } else if (!viewsEl.contains(v.el)) v.moveTo(viewsEl);
        v.el.hidden = id !== m.active;
      }
      // Shells of another folder (the other pane's) step out of the drawer.
      for (const el of [...viewsEl.children]) if (!m.ids.some((id) => shellViews.get(id)?.el === el)) el.remove();
      drawTabs(place);
      shellViews.get(m.active)?.fit();
      return m;
    };
    const drawTabs = (place) => {
      const m = placeShells.get(place);
      const tabs = $('.cc-term-tabs', main);
      if (!m || !tabs) return;
      tabs.innerHTML = `${m.ids.map((id) => `<button class="cc-ttab${id === m.active ? ' on' : ''}" data-sid="${esc(id)}"><span>${esc(shellViews.get(id)?.title || 'Shell')}</span><i data-close-shell="${esc(id)}" title="Close">${icon('x', 10)}</i></button>`).join('')}
        <button class="tb-btn" data-cc="newshell" title="New shell in this folder">${icon('plus', 13)}</button><span class="grow"></span>
        <button class="tb-btn" data-cc="term" title="Hide the terminal">${icon('down', 13)}</button>`;
    };
    const curPlace = () => {
      const p = projectOf(sel?.pid);
      const c = p && chatOf(p.id, sel.n);
      return p && c ? { p, c, place: placeOf(p, c), cwd: c.worktree || p.path } : null;
    };
    const dropShell = (place, id) => {
      const m = placeShells.get(place);
      shellViews.get(id)?.close();
      shellViews.delete(id);
      if (!m) return;
      m.ids = m.ids.filter((x) => x !== id);
      if (m.active === id) m.active = m.ids.at(-1) || null;
      saveShells(place);
      const cur = curPlace();
      if (cur?.place === place) m.ids.length ? drawTerm(cur.p, cur.c) : drawTabs(place);
    };
    const addShell = async (run) => {
      const cur = curPlace();
      if (!cur) return;
      const m = await shellsOf(cur.place);
      const viewsEl = $('.cc-term-views', main);
      if (!viewsEl) return;
      const v = await createShellView(viewsEl, { cwd: cur.cwd, onExit: () => dropShell(cur.place, v.id), onTitle: () => drawTabs(cur.place) });
      if (!v) return;
      shellViews.set(v.id, v);
      m.ids.push(v.id);
      m.active = v.id;
      saveShells(cur.place);
      await drawTerm(cur.p, cur.c);
      v.focus();
      if (run) setTimeout(() => shell.term.write(v.id, `${run}\r`), 300);
    };
    const setTerm = async (open) => {
      termOpen = open;
      savePrefs();
      const box = $('.cc-term', main);
      if (!box) return;
      box.hidden = !termOpen;
      $('.cc-termbtn', main)?.classList.toggle('on', termOpen);
      const cur = curPlace();
      if (termOpen && cur) {
        await drawTerm(cur.p, cur.c);
        shellViews.get(placeShells.get(cur.place)?.active)?.focus();
      } else sessions.get(chatId(sel.pid, sel.n))?.focus();
    };

    const draw = () => {
      drawSide();
      drawMain();
    };
    win.ccDraw = draw;
    win.ccSide = drawSide;
    win.ccShows = (pid, n) => !win.minimized && (same(sel, { pid, n }) || (otherOk() && same(other, { pid, n })));
    win.ccChanged = () => changes?.soon(); // closed too: the button's count stays right
    win.ccSelect = (pid, n) => select(pid, n);
    win.ccNew = (pid) => select(pid || sel?.pid || projects[0]?.id, null);
    // An empty session changed folders (moveEmptyChat): the new one takes its place here.
    win.ccMoved = (pid, n, toPid, m) => {
      const was = { pid, n };
      if (same(sel, was)) {
        sel = { pid: toPid, n: m };
        store.set(selKey, sel);
      }
      if (same(other, was)) {
        other = { pid: toPid, n: m, side: other.side };
        saveSplit();
      }
      draw();
    };
    const select = (pid, n) => {
      root.classList.remove('peek');
      // The session beside this one: the two swap places as the focus moves.
      if (n != null && same(other, { pid, n }) && sel?.n != null) {
        other = { pid: sel.pid, n: sel.n, side: other.side === 'left' ? 'right' : 'left' };
        saveSplit();
      }
      sel = { pid, n: n ?? null };
      store.set(selKey, sel);
      if (n != null) update(pid, { current: n });
      draw();
    };
    const chooseFolder = async () => {
      const r = await pickFiles({ mode: 'open', directory: true, title: 'Choose a folder for Claude to work in', accept: 'Choose' });
      const dir = r?.paths?.[0];
      if (!dir) return;
      try {
        const p = await addProject(dir);
        redraw();
        select(p.id, null);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    // A session from the terminal becomes a session here: its transcript comes in and the next message resumes it.
    const adoptSession = async (pid, sid) => {
      try {
        const n = await newChat(pid);
        const { title } = await shell.projects.adopt(pid, n, sid);
        if (title) await update(pid, { chats: projectOf(pid).chats.map((x) => (x.n === n ? { ...x, title } : x)) });
        select(pid, n);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    const rename = async (pid, n) => {
      const c = chatOf(pid, n);
      if (!c) return;
      const r = await ask({ win, title: 'Rename session', fields: [{ name: 'title', label: 'Name', value: c.title || '' }], buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', primary: true }] });
      const t = r?.button === 'ok' ? String(r.values?.title || '').trim() : '';
      if (!t) return;
      await update(pid, { chats: projectOf(pid).chats.map((x) => (x.n === n ? { ...x, title: t.slice(0, 80) } : x)) });
      drawn = '';
      draw();
    };
    const deleteChat = async (pid, n) => {
      if (states.get(chatId(pid, n))?.busy) return toast('Stop Claude first, then delete the session.');
      const c = chatOf(pid, n);
      const detail = c?.worktree ? `Its worktree is removed too if it has no uncommitted changes; the branch ${c.branch} stays.` : '';
      if (!(await confirmDialog(`Delete “${c?.title || 'New session'}”? Claude won’t remember it.`, { ok: 'Delete', danger: true, win, detail }))) return;
      const wasShown = sel?.pid === pid && sel?.n === n;
      if (same(other, { pid, n })) {
        other = null;
        saveSplit();
      }
      await removeChat(pid, n);
      if (wasShown) {
        const rest = [...(projectOf(pid)?.chats || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
        select(pid, rest[0]?.n ?? null);
      }
    };
    const groupMenu = (btn, p) => {
      const r = btn.getBoundingClientRect();
      showMenu(r.left, r.bottom + 2, [
        { label: 'New session here', act: () => select(p.id, null) },
        { label: 'Show in Files', act: () => openApp('files', { reveal: p.path }) },
        { label: 'Copy path', act: () => navigator.clipboard.writeText(p.path) },
        { label: 'Rename…', act: async () => {
          const res = await ask({ win, title: 'Rename folder', message: 'The name in Claude Code only; the folder on disk keeps its name.', fields: [{ name: 'name', label: 'Name', value: p.name }], buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', primary: true }] });
          const name = res?.button === 'ok' ? String(res.values?.name || '').trim() : '';
          if (name) update(p.id, { name });
        } },
        '-',
        { label: 'Remove from Claude Code…', act: () => removeProject(p.id) },
      ]);
    };
    const removeProject = async (pid) => {
      const pr = projectOf(pid);
      if (!(await confirmDialog(`Remove “${pr.name}” from Claude Code? Its sessions here are deleted; the folder isn’t touched.`, { ok: 'Remove', win }))) return;
      for (const c of pr.chats || []) {
        const pop = wins.get(popoutId(pid, c.n));
        if (pop) closeWindow(pop);
        sessions.get(chatId(pid, c.n))?.destroy();
        sessions.delete(chatId(pid, c.n));
      }
      await shell.projects.remove(pid);
      projects = projects.filter((x) => x.id !== pid);
      if (sel?.pid === pid) sel = projects[0] ? { pid: projects[0].id, n: null } : null;
      redraw();
    };
    const openMenu = (btn) => {
      const cur = curPlace();
      if (!cur) return;
      const sid = sessions.get(chatId(cur.p.id, cur.c.n))?.state()?.sessionId;
      const r = btn.getBoundingClientRect();
      showMenu(r.left, r.bottom + 2, [
        { label: 'Show in Files', act: () => openApp('files', { reveal: cur.cwd }) },
        ...(termsOk ? [{ label: 'Terminal here', act: () => (termOpen ? addShell() : setTerm(true)) }] : []),
        ...(termsOk && sid
          ? [{ label: 'Continue in the terminal (claude --resume)', act: async () => {
              const id = await shell.agentChat.handoff(chatId(cur.p.id, cur.c.n)).catch(() => sid);
              if (!termOpen) {
                termOpen = true;
                savePrefs();
                $('.cc-term', main).hidden = false;
                $('.cc-termbtn', main)?.classList.add('on');
              }
              addShell(`claude --resume ${id || sid}`);
            } }]
          : []),
        '-',
        { label: 'Copy path', act: () => navigator.clipboard.writeText(cur.cwd) },
        ...(sid ? [{ label: 'Copy session ID', act: () => navigator.clipboard.writeText(sid) }] : []),
      ]);
    };

    win.body.addEventListener('click', async (e) => {
      const t = e.target;
      if (Date.now() - dragEndAt < 80) return; // the click that ends dragging a session
      const act = t.closest('[data-cc]')?.dataset.cc;
      // The sidebar sliding over a narrow window goes away when you click beside it.
      if (root.classList.contains('peek') && !t.closest('.cc-side') && act !== 'side') root.classList.remove('peek');
      const group = t.closest('.cc-group');
      const gp = group && projectOf(group.dataset.pid);
      if (t.closest('[data-group-menu]') && gp) return groupMenu(t.closest('[data-group-menu]'), gp);
      if (t.closest('[data-new-in]') && gp) return select(gp.id, null);
      if (t.closest('[data-close-chat]') && gp) return deleteChat(gp.id, Number(t.closest('[data-close-chat]').dataset.closeChat));
      if (t.closest('.cc-group-head') && gp) {
        collapsed.has(gp.id) ? collapsed.delete(gp.id) : collapsed.add(gp.id);
        store.set('claudecode:collapsed', [...collapsed]);
        return drawSide();
      }
      const srow = t.closest('.cc-sess');
      if (srow && gp) {
        const n = Number(srow.dataset.chat);
        const pop = wins.get(popoutId(gp.id, n));
        if (pop) return openApp(pop.id);
        return select(gp.id, n);
      }
      const rec = t.closest('[data-recent]');
      if (rec) return select(sel.pid, Number(rec.dataset.recent));
      const adopt = t.closest('[data-adopt]');
      if (adopt) {
        // One used in the last few minutes may still be open in a terminal; both writing to it would tangle it.
        if (Date.now() - Number(adopt.dataset.at) < 5 * 60000 && !(await confirmDialog('This session was active a few minutes ago and may still be open in a terminal. Continue it here anyway?', { ok: 'Continue here', win, detail: 'Quit it in the terminal first (Ctrl+D) so only one place writes to it.' }))) return;
        return adoptSession(sel.pid, adopt.dataset.adopt);
      }
      if (t.closest('[data-close-shell]')) {
        const cur = curPlace();
        return cur && dropShell(cur.place, t.closest('[data-close-shell]').dataset.closeShell);
      }
      const ttab = t.closest('.cc-ttab');
      if (ttab) {
        const cur = curPlace();
        const m = cur && placeShells.get(cur.place);
        if (!m) return;
        m.active = ttab.dataset.sid;
        saveShells(cur.place);
        await drawTerm(cur.p, cur.c);
        shellViews.get(m.active)?.focus();
        return;
      }
      const un = t.closest('[data-unsplit]');
      if (un) {
        // Closing the focused side leaves the other one focused.
        if (same({ pid: un.closest('.cc-pane').dataset.pid, n: Number(un.closest('.cc-pane').dataset.n) }, sel)) sel = { pid: other.pid, n: other.n };
        other = null;
        saveSplit();
        store.set(selKey, sel);
        return draw();
      }
      if (act === 'add') return chooseFolder();
      if (act === 'new') return select(sel?.pid || projects[0]?.id, null);
      if (act === 'window') return newClaudeCodeWindow();
      if (act === 'side' && root.classList.contains('narrow')) return root.classList.toggle('peek');
      if (act === 'side') {
        sideOpen = !sideOpen;
        savePrefs();
        root.classList.toggle('noside', !sideOpen);
        return;
      }
      if (act === 'rename' && sel?.n != null) return rename(sel.pid, sel.n);
      if (act === 'open') return openMenu(t.closest('[data-cc]'));
      if (act === 'preview' && sel?.n != null) {
        // The dev server's page in a browser window, paired beside this one; again brings that window back.
        const pv = previews.get(chatId(sel.pid, sel.n));
        if (!pv) return;
        if (pv.win && wins.has(pv.win)) return openApp(pv.win);
        const { openWebPage } = await import('./browser.js');
        const w = openWebPage(pv.url);
        if (w) {
          pv.win = w.id;
          pair(win, w);
        }
        return;
      }
      if (act === 'popout' && sel?.n != null) return openApp(popoutId(sel.pid, sel.n));
      if (act === 'bringback') {
        const b = t.closest('[data-cc]');
        const pop = wins.get(popoutId(b.dataset.pid || sel.pid, b.dataset.n ? Number(b.dataset.n) : sel.n));
        if (pop) closeWindow(pop);
        return;
      }
      if (act === 'term') return setTerm(!termOpen);
      if (act === 'right') {
        rightOpen = !rightOpen;
        savePrefs();
        $('.cc-right', main).hidden = !rightOpen;
        $('.cc-rightbtn', main)?.classList.toggle('on', rightOpen);
        if (rightOpen) changes?.refresh();
        return;
      }
      if (act === 'newshell') return addShell();
    });
    win.body.addEventListener('dblclick', (e) => {
      const srow = e.target.closest('.cc-sess');
      const group = e.target.closest('.cc-group');
      if (srow && group) rename(group.dataset.pid, Number(srow.dataset.chat));
    });
    win.body.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.classList.contains('peek')) {
        e.preventDefault();
        return root.classList.remove('peek');
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n' && !e.target.closest('.term-view')) {
        e.preventDefault();
        e.stopPropagation();
        return select(sel?.pid || projects[0]?.id, null);
      }
      if (e.ctrlKey && e.key === '`' && termsOk && sel?.n != null) {
        e.preventDefault();
        return setTerm(!termOpen);
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const r = e.target.closest?.('[role="button"]');
      if (r) {
        e.preventDefault();
        r.click();
      }
    });
    // The drawer resizes by its top edge; the Changes panel by its left edge.
    main.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.cc-term-grip, .cc-right-grip');
      if (!grip || e.button !== 0) return;
      const vertical = grip.classList.contains('cc-term-grip');
      const box = vertical ? $('.cc-term', main) : $('.cc-right', main);
      const outer = vertical ? $('.cc-center', main) : $('.cc-split', main);
      const start = vertical ? e.clientY : e.clientX;
      const s0 = vertical ? box.offsetHeight : box.offsetWidth;
      grip.setPointerCapture(e.pointerId);
      root.classList.add('resizing');
      const move = (ev) => {
        if (vertical) {
          termH = Math.max(120, Math.min(outer.clientHeight - 200, s0 + (start - ev.clientY)));
          box.style.height = `${termH}px`;
        } else {
          rightW = Math.max(280, Math.min(outer.clientWidth - 380, s0 + (start - ev.clientX)));
          box.style.width = `${rightW}px`;
        }
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        root.classList.remove('resizing');
        savePrefs();
        const cur = curPlace();
        if (cur) shellViews.get(placeShells.get(cur.place)?.active)?.fit();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('pointercancel', up, { once: true });
    });

    // The sidebar resizes by its right edge; a double-click puts it back to the usual width.
    const setSideW = (w) => {
      sideW = Math.round(Math.max(200, Math.min(520, root.clientWidth - 420, w)));
      root.style.setProperty('--side-w', `${sideW}px`);
    };
    const sideGrip = $('.cc-side-grip', root);
    sideGrip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = e.clientX;
      const w0 = side.offsetWidth;
      sideGrip.setPointerCapture(e.pointerId);
      root.classList.add('resizing', 'side-resizing');
      const move = (ev) => setSideW(w0 + (ev.clientX - start));
      const up = () => {
        sideGrip.removeEventListener('pointermove', move);
        root.classList.remove('resizing', 'side-resizing');
        store.set('claudecode:sideW', sideW);
        savePrefs();
        const cur = curPlace();
        if (cur) shellViews.get(placeShells.get(cur.place)?.active)?.fit();
      };
      sideGrip.addEventListener('pointermove', move);
      sideGrip.addEventListener('pointerup', up, { once: true });
      sideGrip.addEventListener('pointercancel', up, { once: true });
    });
    sideGrip.addEventListener('dblclick', () => {
      setSideW(SIDE_W);
      store.set('claudecode:sideW', sideW);
      savePrefs();
    });

    // Relative times in the sidebar stay current.
    const tick = setInterval(() => !document.hidden && drawSide(), 60000);
    win.cleanups.push(() => {
      clearInterval(tick);
      delete win.ccDraw;
      delete win.ccSide;
      delete win.ccShows;
      delete win.ccChanged;
      delete win.ccSelect;
      delete win.ccNew;
      delete win.ccMoved;
    });
    loaded.then(async () => {
      if (startIn) {
        const dir = startIn;
        startIn = null;
        try {
          const p = await addProject(dir);
          sel = { pid: p.id, n: null };
          store.set(selKey, sel);
        } catch (err) {
          toast(err.message, 'error');
        }
      }
      if (pendingShow) {
        sel = pendingShow;
        pendingShow = null;
      }
      if (!projectOf(sel?.pid)) {
        const p = projects[0];
        sel = p ? { pid: p.id, n: p.chats?.some((c) => c.n === p.current) ? p.current : null } : null;
      }
      draw();
    });
    draw();
  },
};
registerApp(app);
addResolver((id) => (/^claudecode:\d+$/.test(id) ? { ...app, id } : null));

/* ---------------- a session in a window of its own ---------------- */

const popout = {
  name: 'Claude Code',
  icon: 'claude',
  logo: '/img/claude.png',
  color: 'orange',
  hidden: true,
  size: [620, 780],
  min: [400, 360],
  mount(win) {
    const [, pid, n] = POPOUT.exec(win.id);
    win.body.classList.add('cc-popout');
    (loaded ||= load()).then(() => {
      const p = projectOf(pid);
      const c = chatOf(pid, Number(n));
      if (!p || !c) {
        win.body.innerHTML = `<div class="empty"><div class="empty-title">This session is gone</div></div>`;
        return;
      }
      const s = sessionFor(pid, Number(n));
      win.body.innerHTML = `<div class="cc-bar win-drag"><div class="cc-bar-in"><div class="cc-title"><b>${esc(c.title || 'New session')}</b><span class="cc-where"><span>${icon('folder', 11)} ${esc(p.name)}</span>${c.branch ? `<span class="cc-branch">${icon('branch', 11)} ${esc(c.branch)}</span>` : ''}</span></div><span class="grow"></span>
        <button class="tb-btn" data-cc="back" title="Back to the Claude Code window">${icon('down', 14)}</button></div><div class="cc-winbtns"></div></div><div class="cc-chat"></div>`;
      mergeTitleBar(win, $('.cc-winbtns', win.body));
      $('.cc-chat', win.body).append(s.el);
      s.shown();
      s.focus();
      unseen.delete(chatId(pid, Number(n)));
      win.body.addEventListener('click', (e) => {
        if (!e.target.closest('[data-cc="back"]')) return;
        closeWindow(win);
        showChat(pid, Number(n));
      });
      redraw();
    });
  },
  unmount() {
    // The app window takes the session back (its draw() re-hosts it); the session itself lives on.
    queueMicrotask(redraw);
  },
};
addResolver((id) => {
  const m = POPOUT.exec(id);
  if (!m) return null;
  const c = chatOf(m[1], Number(m[2]));
  const p = projectOf(m[1]);
  return { ...popout, id, name: c ? `${c.title || 'New session'} · ${p?.name || 'Claude Code'}` : 'Claude Code' };
});
