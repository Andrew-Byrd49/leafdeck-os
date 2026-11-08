// The Claude assistant: a button at the bottom left of the Dock's screen (where Windows has its Start button) that
// opens a chat with Claude for anything: a quick question, writing, or doing something on the computer with the
// leafdeck_* tools. The conversation runs in Claude Code in the background (electron/agentchat.cjs, id "@assistant")
// and keeps going when the panel closes; the button shows when Claude is working or waiting for you.
// The chat can also move into a window of its own ("Open in a window"), to keep beside your work: then the button
// brings that window forward, and closing it puts the chat back in the panel.
// In safe mode (Leafdeck OS, safemode.js) the same button and panel hold the safe-mode conversation ("@safemode"):
// Claude with the report on what went wrong, kept outside Leafdeck's profile so it continues across attempts.
import { icon } from './icons.js';
import { screens, dockScreen, toast, registerApp, openApp, wins, activeWindow, minimize, closeWindow } from './wm.js';
import { shell } from './shell.js';
import { createChat, listen } from './agentchat.js';

let ID = '@assistant';
const LOGO = '<img class="cl-logo" src="/img/claude.png" alt="" draggable="false">';
let TEXT = {
  title: 'Claude',
  placeholder: 'Ask Claude anything…',
  emptyTitle: 'How can I help?',
  emptyText: 'Ask a question, get something written, or have Claude do it for you in Leafdeck. It asks before it clicks, types or changes anything; Settings → Claude says what it may do on its own.',
  suggestions: ['What’s on my calendar this week?', 'Summarize the page I have open', 'Draft a thank-you note to a client', 'Which tasks are overdue?'],
  clearConfirm: 'Start a new conversation? Claude won’t remember this one.',
  terminal: false,
};
const SAFE_TEXT = {
  ...TEXT,
  title: 'Claude · Safe mode',
  placeholder: 'Tell Claude what happened…',
  emptyTitle: 'Let’s get Leafdeck working again',
  emptyText: 'Leafdeck is in safe mode. Claude has the report on what went wrong and can change settings, look at the log and fix the code; it asks before it changes anything.',
  suggestions: ['What went wrong?', 'What did safe mode skip?', 'Reset the display arrangement', 'How do I get back to normal?'],
  clearConfirm: 'Start a new safe-mode conversation? Claude won’t remember this one, but the report stays.',
};

// The Claude wordmark, inline so its lettering takes the theme's text color.
let wordmark = null;
const loadWordmark = () => (wordmark ||= fetch('/img/claude-wordmark.svg').then((r) => (r.ok ? r.text() : '')).catch(() => ''));

let btn = null;
let panel = null;
let chat = null;
let busy = false;
let waiting = false;
const WIN = 'claude'; // the window's app id
const win = () => wins.get(WIN);
const HEAD_BUTTONS = `<button class="tb-btn" data-cl="settings" title="Claude settings: permissions and preferences">${icon('sliders', 14)}</button>
  <button class="tb-btn cl-to-win" data-cl="window" title="Open in a window">${icon('new-window', 14)}</button>
  <button class="tb-btn cl-to-panel" data-cl="panel" title="Back to the Dock button">${icon('down', 14)}</button>`;

/** Place the button and panel on the Dock's screen, bottom left. */
function place() {
  if (!btn) return;
  const s = screens()[dockScreen()];
  const bottom = Math.max(0, innerHeight - s.y - s.h);
  btn.style.left = `${s.x}px`;
  btn.style.bottom = `${bottom}px`;
  if (panel) {
    panel.style.left = `${s.x + 10}px`;
    panel.style.bottom = `${bottom + btn.offsetHeight + 10}px`;
    panel.style.height = `${Math.max(320, Math.min(720, s.h - btn.offsetHeight - 70))}px`;
  }
}

function drawButton() {
  btn.classList.toggle('busy', busy && !waiting);
  btn.classList.toggle('waiting', waiting);
  btn.classList.toggle('open', (!!panel && !panel.hidden) || !!win());
  btn.title = waiting ? 'Claude is waiting for you' : busy ? 'Claude is working' : 'Claude';
}

async function installed() {
  const agents = await shell.userApps?.agents().catch(() => null);
  return !!agents?.claude?.installed;
}

/** Show the chat (or how to set it up) in the window when there is one, else the panel. One at a time: a second call
 * while the first is still checking waits for it (else there'd be two chats). */
let filling = null;
const fill = () => (filling ||= doFill().finally(() => (filling = null)));
async function doFill() {
  const host = win()?.body || panel;
  if (!host) return;
  if (await installed()) {
    const headLogo = await loadWordmark();
    if (!chat) {
      // Talking to Claude (electron/voice.cjs) is Linux only: the microphone button and the Copilot key.
      chat = createChat(ID, { text: TEXT, emptyIcon: LOGO, headLogo, headButtons: HEAD_BUTTONS, voice: shell.platform === 'linux' && !!shell.voice });
      chat.el.classList.add('cl-chat'); // the assistant's own look (app.css)
    }
    host.replaceChildren(chat.el);
    chat.focus();
    return;
  }
  host.innerHTML = `<div class="cl-setup">${LOGO}<b>Set up Claude</b>
    <p>Claude runs through Claude Code on this computer, with your own Claude subscription (Pro, Max or Team). Install it once and sign in; then ask Claude anything from here.</p>
    <button class="btn primary" data-cl="install">${icon('download', 12)} Install Claude Code</button>
    <button class="btn" data-cl="recheck">I’ve installed it</button>
    <button class="btn" data-cl="settings">${icon('sliders', 12)} Claude settings</button></div>`;
}

function open() {
  if (win()) return openApp(WIN);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'cl-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Claude');
    panel.addEventListener('click', onPanelClick);
    document.body.append(panel);
    fill();
  } else {
    panel.hidden = false;
    if (chat) {
      chat.focus();
      const sc = chat.el.querySelector('.ac-scroll');
      if (sc) sc.scrollTop = sc.scrollHeight;
    } else fill();
  }
  place();
  setTimeout(() => addEventListener('pointerdown', outside, true));
  addEventListener('keydown', onKey, true);
  drawButton();
}
function close() {
  if (!panel || panel.hidden) return;
  panel.hidden = true; // kept, so the conversation and anything you were typing are still there next time
  removeEventListener('pointerdown', outside, true);
  removeEventListener('keydown', onKey, true);
  drawButton();
}
function toggle() {
  const w = win();
  if (w) return activeWindow() === w && !w.minimized ? minimize(w) : openApp(WIN);
  panel && !panel.hidden ? close() : open();
}
const outside = (e) => panel && !panel.contains(e.target) && !btn.contains(e.target) && !e.target.closest?.('.ctx-menu, .modal, #toasts') && close();
const onKey = (e) => {
  if (e.key !== 'Escape' || !panel || panel.hidden) return;
  e.stopPropagation();
  // Listening: Escape stops that (the words stay in the box) and keeps the panel.
  if (chat?.voiceActive()) return chat.voiceCancel();
  close();
};

/** The Copilot key (electron/main.cjs): open Claude and listen; while listening, the same key sends. */
async function voiceKey() {
  if (!btn) return;
  if (chat?.voiceActive()) return chat.voiceToggle();
  if (win()) openApp(WIN);
  else if (!panel || panel.hidden) open();
  await fill();
  if (!chat) return; // the panel shows how to set Claude up
  chat.voiceToggle();
}

async function onPanelClick(e) {
  const t = e.target.closest('[data-cl]');
  if (!t) return;
  if (t.dataset.cl === 'window') {
    close();
    openApp(WIN);
  } else if (t.dataset.cl === 'panel') {
    const w = win();
    if (w) closeWindow(w); // unmount puts the chat back in the panel
    open();
  } else if (t.dataset.cl === 'settings') {
    close();
    openApp('settings', { tab: 'claude' });
  } else if (t.dataset.cl === 'install') {
    try {
      await shell.userApps.installAgent('claude');
      toast('Installing Claude Code in a new terminal window. Sign in there, then come back here.');
    } catch (err) {
      toast(err.message, 'error');
    }
  } else if (t.dataset.cl === 'recheck') fill();
}

export function initAssistant({ safe = false } = {}) {
  // Claude Code runs on this computer: only the desktop app has it.
  if (!shell?.agentChat || btn) return;
  if (safe) {
    ID = '@safemode';
    TEXT = SAFE_TEXT;
  }
  btn = document.createElement('button');
  btn.id = 'claude-btn';
  btn.setAttribute('aria-label', 'Claude');
  btn.innerHTML = `<span class="cl-btn-inner">${LOGO}<i class="cl-btn-dot"></i></span>`;
  btn.addEventListener('click', toggle);
  document.body.append(btn);
  // The chat in a window of its own. Not in the launcher or search: the Dock button and the panel open it.
  registerApp({
    id: WIN,
    name: 'Claude',
    icon: 'claude',
    logo: '/img/claude.png',
    color: 'orange',
    hidden: true,
    size: [460, 680],
    min: [340, 320],
    mount(w) {
      w.body.classList.add('cl-win');
      w.body.addEventListener('click', onPanelClick);
      fill();
      drawButton();
    },
    unmount() {
      // The same chat goes back to the panel, conversation and draft and all.
      if (chat && panel) panel.replaceChildren(chat.el);
      else if (chat) chat.el.remove();
      queueMicrotask(drawButton);
    },
  });
  document.documentElement.classList.add('has-claude'); // the Dock keeps clear of the button
  addEventListener('resize', place);
  addEventListener('screens', place);
  // The Dock moved screens (Settings → Desktop): placeDock() sets these, so follow them.
  new MutationObserver(place).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  place();
  // The Copilot key (electron/main.cjs, Leafdeck OS).
  shell.on('shell:shortcut', ({ name }) => name === 'voice' && voiceKey());
  // Listening (the Copilot key or the microphone button): the dot on the button shows it, panel open or not.
  shell.on('voice:event', (ev) => ev.t === 'state' && btn.classList.toggle('listening', ev.phase && ev.phase !== 'idle'));
  // Working / waiting for you, shown on the button even while the panel is closed. A question opens the panel.
  const sync = (s) => {
    busy = !!s.busy;
    waiting = !!s.pending?.length;
    drawButton();
  };
  shell.agentChat.history(ID).then(sync, () => {});
  listen(ID, (ev) => {
    if (ev.t === 'state') sync(ev);
    if (ev.t === 'ask' && (win() ? win().minimized : !panel || panel.hidden)) open();
  });
}

export const toggleAssistant = () => btn && toggle();

/** Open Claude in a window and send `text` as the user's message (safe mode's report). Nothing happens when Claude
 * Code isn't set up: the window then shows how to set it up instead. */
export async function assistantSend(text) {
  if (!btn) return false;
  openApp(WIN);
  await fill();
  if (!chat) return false;
  await chat.send(text);
  return true;
}
