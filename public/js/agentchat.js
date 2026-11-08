// A Claude Code chat panel, shown in Leafdeck instead of a terminal: App Builder's conversation about one app, and the
// Claude assistant (assistant.js).
// The work happens in electron/agentchat.cjs (Claude Code in the background, stream-json); this draws it.
import { shell } from './shell.js';
import { esc } from './util.js';
import { icon } from './icons.js';
import { toast } from './wm.js';
import { confirmDialog } from './dialogs.js';

/* ---------------- a small, safe markdown renderer ---------------- */

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="#" data-url="${url}">${label}</a>`);
  return t;
}
export function markdown(src) {
  const out = [];
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flushPara();
      closeList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)/);
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      flushPara();
      closeList();
      out.push(`<h4>${inline(h[1])}</h4>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return out.join('');
}

/* ---------------- one shared event stream, fanned out by app id ---------------- */

const listeners = new Map(); // conversation id -> Set(fn)
let wired = false;
export function listen(id, fn) {
  if (!wired && shell?.on) {
    wired = true;
    shell.on('agentchat:event', ({ id: appId, ev }) => listeners.get(appId)?.forEach((f) => f(ev)));
  }
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => listeners.get(id)?.delete(fn);
}

// The wording, as App Builder uses it; the assistant passes its own.
const APP_TEXT = {
  title: 'Claude Code',
  placeholder: 'Ask Claude to build or change something…',
  emptyTitle: 'Talk to Claude about this app',
  emptyText: 'It reads the brief and Leafdeck’s guide, builds the app, and checks its work with screenshots. Changes show up in the app as it saves.',
  suggestions: ['Build it from the brief', 'Make it look like a built-in Leafdeck app', 'Add a way to edit and delete entries', 'Check it in dark mode and fix anything off'],
  clearConfirm: 'Start a new conversation? Claude won’t remember this one (your app stays as it is).',
  terminal: true,
};

/**
 * Mount a chat for one conversation. Returns { el, send(text), focus(), destroy() }.
 * opts.beforeSend(text): runs before a message goes out (App Builder saves a version there). A string it returns is
 * sent in place of the text (Designer adds a line about new markup).
 * opts.noAlways: no "Always allow" on what Claude asks (it goes by tool, and here some uses of a tool must always ask).
 * opts.note(): a line for Claude only that goes with each message, not shown in the chat (what's open in the app).
 * opts.text: wording that replaces APP_TEXT's (title, placeholder, empty state, suggestions, terminal: false hides
 * "Open in terminal").
 * opts.headLogo: markup shown at the top left in place of the title (the status still shows while it's working).
 * opts.headButtons: markup for more header buttons, before "Start a new conversation" (the caller handles their clicks).
 * opts.voice: a microphone button in the composer (electron/voice.cjs: the words show up as they're heard, and go as a
 * message when you stop). The Copilot key does the same through voiceToggle(); Escape keeps the words without sending.
 */
export function createChat(id, opts = {}) {
  const T = { ...APP_TEXT, ...opts.text };
  const voiceOn = !!opts.voice && !!shell?.voice;
  const el = document.createElement('section');
  el.className = 'ac';
  el.innerHTML = `<header class="ac-head">
      ${opts.headLogo ? `<span class="ac-brand" role="img" aria-label="${esc(T.title)}">${opts.headLogo}</span>` : ''}
      <span class="ac-dot"></span><b class="ac-status">${opts.headLogo ? '' : esc(T.title)}</b><small class="ac-activity"></small>
      <span class="grow"></span>
      <button class="btn small ac-stop" hidden>${icon('stop', 11)} Stop</button>
      ${T.terminal ? `<button class="tb-btn ac-term" title="Open this conversation in a terminal">${icon('external', 14)}</button>` : ''}
      ${opts.headButtons || ''}
      <button class="tb-btn ac-clear" title="Start a new conversation">${icon('refresh', 14)}</button>
    </header>
    <div class="ac-scroll"><div class="ac-log"></div></div>
    <form class="ac-compose">
      <textarea rows="1" placeholder="${esc(T.placeholder)}" aria-label="Message Claude"></textarea>
      ${voiceOn ? `<button type="button" class="ac-mic" title="Talk to Claude (or press the Copilot key)" aria-label="Talk to Claude"><span class="ac-ring"></span>${icon('mic', 15)}</button>` : ''}
      <button class="btn primary ac-send" title="Send (Enter)">${icon('send', 15)}</button>
    </form>`;
  const $ = (s) => el.querySelector(s);
  const logEl = $('.ac-log');
  const scroller = $('.ac-scroll');
  const ta = $('textarea');
  let state = { running: false, busy: false, pending: [] };
  let live = null; // the streaming assistant bubble
  let lastTool = null; // the last tool row (screenshots attach under it)
  let loaded = false;

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const toBottom = (force) => {
    if (force || nearBottom()) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  };
  const add = (html, cls) => {
    const stick = nearBottom();
    const node = document.createElement('div');
    node.className = cls;
    node.innerHTML = html;
    logEl.append(node);
    if (stick) toBottom(true);
    return node;
  };

  function empty() {
    if (logEl.children.length) return;
    add(`<div class="ac-empty-title">${opts.emptyIcon || icon('sparkle', 16)} ${esc(T.emptyTitle)}</div>
      <p>${esc(T.emptyText)}</p>
      <div class="ac-sugg">${T.suggestions.map((s) => `<button class="chip-btn" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div>`, 'ac-empty');
  }

  function render(e, { replay } = {}) {
    if (e.t !== 'live' && e.t !== 'live-start') $('.ac-empty')?.remove();
    switch (e.t) {
      case 'user':
        lastTool = null;
        add(esc(e.text).replace(/\n/g, '<br>'), 'ac-msg ac-user');
        break;
      case 'live-start':
        live = add('', 'ac-msg ac-bot ac-live');
        live._text = '';
        break;
      case 'live':
        if (!live) {
          live = add('', 'ac-msg ac-bot ac-live');
          live._text = '';
        }
        live._text += e.text;
        live.innerHTML = markdown(live._text);
        toBottom();
        break;
      case 'assistant':
        if (live && !replay) {
          live.classList.remove('ac-live');
          live.innerHTML = markdown(e.text);
          live = null;
        } else add(markdown(e.text), 'ac-msg ac-bot');
        lastTool = null;
        break;
      case 'tool':
        lastTool = add(`${icon(e.icon || 'sparkle', 13)}<span>${esc(e.text)}</span>${e.detail ? `<code>${esc(e.detail)}</code>` : ''}`, 'ac-tool');
        lastTool.dataset.tool = e.toolId || '';
        break;
      case 'tool-error':
        // A step that didn't work (a command's exit code, a missing file): routine while Claude works, so it's shown
        // quietly, two lines until clicked. Errors that stop the conversation stay red.
        add(`${icon('x', 13)}<span>${esc(e.text || 'That step failed')}</span>`, 'ac-tool ac-tool-fail');
        break;
      case 'image': {
        const host = (e.toolId && logEl.querySelector(`[data-tool="${CSS.escape(e.toolId)}"]`)) || lastTool;
        const img = document.createElement('img');
        img.className = 'ac-shot';
        img.src = e.src;
        img.alt = 'Screenshot Claude took';
        if (host) host.after(img);
        else logEl.append(img);
        toBottom();
        break;
      }
      case 'ask':
        drawAsk(e);
        break;
      case 'answer':
        logEl.querySelectorAll('.ac-ask').forEach((n) => n.dataset.answered && n.remove());
        add(`${icon(e.allow ? 'tick' : 'x', 13)}<span>${e.allow ? 'Allowed' : 'Declined'}: ${esc(e.title || '')}</span>`, 'ac-tool');
        break;
      case 'done':
        if (live) {
          live.classList.remove('ac-live');
          live = null;
        }
        if (!e.ok) add(`${icon('flag', 13)}<span>${esc(e.text || 'Something went wrong')}</span>`, 'ac-tool ac-tool-err');
        else if (e.stopped) add('<span>Stopped</span>', 'ac-sep');
        else if (!replay && e.ms) add(`<span>Done in ${Math.max(1, Math.round(e.ms / 1000))}s</span>`, 'ac-sep');
        break;
      case 'error':
        add(`${icon('flag', 13)}<span>${esc(e.text)}</span>`, 'ac-tool ac-tool-err');
        break;
      case 'activity':
        if (state.busy) $('.ac-activity').textContent = e.text;
        break;
      case 'state':
        state = e;
        drawState();
        break;
      case 'cleared':
        logEl.innerHTML = '';
        live = null;
        empty();
        break;
    }
  }

  function drawAsk(a) {
    if (logEl.querySelector(`[data-req="${CSS.escape(a.requestId)}"]`)) return;
    const node = add(`<div class="ac-ask-head">${icon('key', 14)}<b>Claude wants to ${esc(a.title.charAt(0).toLowerCase() + a.title.slice(1))}</b></div>
      ${a.note ? `<p>${esc(a.note)}</p>` : ''}
      ${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}
      <div class="ac-ask-actions"><button class="btn small" data-ans="deny">Deny</button><span class="grow"></span>
        ${opts.noAlways ? '' : `<button class="btn small" data-ans="always" title="Don’t ask again for ${esc(a.tool)} in this conversation">Always allow</button>`}
        <button class="btn small primary" data-ans="allow">Allow</button></div>`, 'ac-ask');
    node.dataset.req = a.requestId;
    node.querySelector('[data-ans="allow"]').focus({ preventScroll: true });
  }

  function drawState() {
    const waiting = state.pending?.length;
    el.classList.toggle('busy', !!state.busy);
    el.classList.toggle('waiting', !!waiting);
    $('.ac-status').textContent = waiting ? 'Waiting for you' : state.busy ? 'Working' : opts.headLogo ? '' : T.title;
    if (!state.busy) $('.ac-activity').textContent = '';
    $('.ac-stop').hidden = !state.busy;
    $('.ac-send').disabled = !!state.busy || vphase !== 'idle';
    ta.placeholder = vphase === 'listening' ? 'Listening…' : vphase === 'transcribing' ? 'Working out the words…' : state.busy ? 'Claude is working…' : T.placeholder;
  }

  async function load() {
    try {
      const h = await shell.agentChat.history(id);
      logEl.innerHTML = '';
      for (const e of h.log) render(e, { replay: true });
      state = h;
      for (const a of h.pending || []) drawAsk(a);
      drawState();
    } catch (err) {
      add(`${icon('flag', 13)}<span>${esc(err.message)}</span>`, 'ac-tool ac-tool-err');
    }
    loaded = true;
    empty();
    toBottom(true);
  }

  async function send(text) {
    const t = String(text ?? ta.value).trim();
    if (!t || state.busy) return;
    if (text == null) ta.value = '';
    grow();
    try {
      const instead = await opts.beforeSend?.(t);
      const note = opts.note?.();
      state = await shell.agentChat.send(id, typeof instead === 'string' ? instead : t, note ? { note } : undefined);
      drawState();
    } catch (err) {
      toast(err.message, 'error');
      if (text == null) ta.value = t;
    }
  }

  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
  };

  /* ----- talking (opts.voice) ----- */
  let vphase = 'idle'; // 'listening' | 'transcribing'
  let heardBase = ''; // what was in the box before listening started; the words heard follow it
  const mic = $('.ac-mic');
  const withBase = (text) => (heardBase ? `${heardBase} ${text}` : text);
  async function voiceToggle() {
    if (!voiceOn) return;
    if (vphase === 'listening') return shell.voice.stop().catch((err) => toast(err.message, 'error'));
    if (vphase === 'transcribing') return;
    if (state.busy) return toast('Claude is still working on the last one.');
    try {
      await shell.voice.start();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  const voiceCancel = () => voiceOn && vphase !== 'idle' && shell.voice.cancel().catch(() => {});
  function onVoice(ev) {
    switch (ev.t) {
      case 'state':
        if (ev.phase === 'listening' && vphase === 'idle') heardBase = ta.value.trim();
        vphase = ev.phase || 'idle';
        el.classList.toggle('listening', vphase === 'listening');
        el.classList.toggle('transcribing', vphase === 'transcribing');
        if (vphase === 'idle') mic?.style.setProperty('--lvl', 0);
        mic && (mic.title = vphase === 'listening' ? 'Send what you said (or press the Copilot key); Escape keeps it without sending' : 'Talk to Claude (or press the Copilot key)');
        drawState();
        break;
      case 'level':
        mic?.style.setProperty('--lvl', String(Math.max(0, Math.min(1, ev.v || 0))));
        break;
      case 'partial':
        ta.value = withBase(ev.text);
        grow();
        break;
      case 'final':
        if (ev.text) {
          ta.value = withBase(ev.text);
          grow();
          send();
        } else {
          ta.value = heardBase;
          grow();
          toast('Didn’t catch that. Try again a little closer to the microphone.');
        }
        break;
      case 'error':
        toast(ev.text, 'error');
        break;
    }
  }
  let offVoice = null;
  if (voiceOn) {
    mic.addEventListener('click', voiceToggle);
    offVoice = shell.on('voice:event', onVoice);
    shell.voice.status().then((s) => s.listening && onVoice({ t: 'state', phase: s.phase }), () => {});
  }

  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && vphase !== 'idle') {
      e.preventDefault();
      e.stopPropagation();
      return voiceCancel();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (vphase === 'listening') return voiceToggle(); // ends the recording; the final words are what gets sent
      if (vphase === 'transcribing') return;
      send();
    }
  });
  $('.ac-compose').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const ans = t.closest('[data-ans]');
    if (ans) {
      const card = ans.closest('.ac-ask');
      card.dataset.answered = '1';
      card.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await shell.agentChat.answer(id, card.dataset.req, ans.dataset.ans === 'deny' ? 'deny' : 'allow', ans.dataset.ans === 'always');
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const sugg = t.closest('[data-sugg]');
    if (sugg) return send(sugg.dataset.sugg);
    const link = t.closest('a[data-url]');
    if (link) {
      e.preventDefault();
      return (await import('./apps/browser.js')).openWebPage(link.dataset.url);
    }
    if (t.closest('.ac-stop')) return shell.agentChat.interrupt(id);
    if (t.closest('.ac-term')) {
      try {
        await shell.agentChat.terminal(id);
        toast('Opened this conversation in a terminal. Come back here any time to keep going in Leafdeck.');
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    if (t.closest('.ac-clear')) {
      if (state.busy) return toast('Stop Claude first, then start a new conversation.');
      if (!(await confirmDialog(T.clearConfirm, { ok: 'Start over' }))) return;
      return shell.agentChat.clear(id);
    }
    if (t.closest('.ac-tool-fail') && !getSelection().toString()) return t.closest('.ac-tool-fail').classList.toggle('open');
    if (t.closest('.ac-shot')) return t.closest('.ac-shot').classList.toggle('big');
  });

  const off = listen(id, (ev) => loaded && render(ev));
  load();

  return {
    el,
    send,
    focus: () => ta.focus(),
    destroy: () => {
      off();
      offVoice?.();
    },
    voiceToggle,
    voiceCancel,
    voiceActive: () => vphase !== 'idle',
  };
}
