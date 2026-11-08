// One Claude Code session in the Claude Code app, the way the Claude desktop app shows it: the transcript (Claude's
// replies as Markdown, each tool call as a card: a command with its output, an edit as a diff, a file read, a search),
// the cards that wait for you above the composer (approve a step, answer Claude's questions, approve its plan), its
// task list, and the composer: permission mode, model, effort and Ultracode, a context meter, "/" for commands and skills, "@" for
// files, pasted and attached images, and messages that queue while Claude works.
// The work happens in electron/agentchat.cjs; events arrive through agentchat.js's listen().
import { shell } from '../shell.js';
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { toast, showMenu } from '../wm.js';
import { listen } from '../agentchat.js';
import { pickFiles } from '../filepicker.js';
import { markdown } from './markdown.js';
import { editHtml, addedHtml, editCounts } from './diff.js';

export const MODES = [
  { id: 'default', label: 'Ask permissions', short: 'Ask', hint: 'Claude asks before it edits files or runs commands' },
  { id: 'acceptEdits', label: 'Auto-accept edits', short: 'Accept edits', hint: 'Edits go through; commands still ask' },
  { id: 'plan', label: 'Plan mode', short: 'Plan', hint: 'Claude researches and plans, and changes nothing until you approve' },
  { id: 'auto', label: 'Auto mode', short: 'Auto', hint: 'Claude decides what is safe to run; risky steps still ask' },
  { id: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', hint: 'Everything runs without asking' },
];
const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];
const FALLBACK_MODELS = [
  { value: 'default', name: 'Default', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], auto: true },
  { value: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], auto: true },
  { value: 'sonnet', name: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], auto: true },
  { value: 'haiku', name: 'Haiku', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], auto: true },
];
const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
// Commands handled here rather than sent to Claude Code.
const LOCAL_COMMANDS = [
  { name: 'clear', description: 'Start a new session in this folder', local: true },
  { name: 'model', description: 'Choose the model', local: true },
  { name: 'mode', description: 'Choose the permission mode', local: true },
  { name: 'ultracode', description: 'Turn Ultracode on or off for this session', local: true },
];
const ULTRA_HINT = 'Ultracode: Claude plans and runs multi-agent workflows for every substantive task (more thorough, uses many more tokens). Applies to this session.';

// Past this many tokens the composer warns: each reply reads the whole conversation again, and with a 1M window nothing
// compacts it on its own until much later.
const CTX_WARN = 200000;
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n || 0));
const fmtSecs = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
// A dev server Claude started (its output names the address): the app offers it as a preview.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/g;
const linkify = (html) => html.replace(LOCAL_URL, (u) => `<a href="#" data-url="${u.replace('0.0.0.0', 'localhost')}">${u}</a>`);
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/* ---------------- how each tool shows ---------------- */

function rel(p, cwd) {
  const s = String(p || '');
  if (cwd && s.startsWith(cwd + '/')) return s.slice(cwd.length + 1);
  return s;
}
// A field of a workflow script's meta ({ name: 'Review', description: '…' }), for its card.
const workflowMeta = (input, key) => {
  const m = new RegExp(`\\bmeta\\s*=\\s*\\{[\\s\\S]*?\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(String(input.script || ''));
  return m ? m[2].replace(/\\(.)/g, '$1') : '';
};
/** { icon, verb, target, mono, open } for a tool call's header row. */
function toolHead(name, input = {}, cwd) {
  const n = String(name || '');
  if (n.startsWith('mcp__')) {
    const [, server, ...rest] = n.split('__');
    const t = rest.join('__');
    return { icon: server === 'leafdeck' ? 'leaf' : 'link', verb: t.replace(/^leafdeck_/, '').replace(/_/g, ' '), target: server, mono: false };
  }
  // Plan mode writes its plan to ~/.claude/plans: the plan card shows it, so the write is just a line.
  if ((n === 'Write' || n === 'Edit') && /\/\.claude\/plans\//.test(String(input.file_path || ''))) return { icon: 'note', verb: n === 'Write' ? 'Wrote the plan' : 'Updated the plan', target: '', mono: false, plan: true };
  switch (n) {
    case 'Bash':
    case 'PowerShell':
      return { icon: 'terminal', verb: input.description ? short(input.description, 90) : 'Ran', target: input.description ? '' : short(String(input.command || '').split('\n')[0], 90), mono: !input.description };
    case 'Read':
      return { icon: 'eye', verb: 'Read', target: rel(input.file_path, cwd), mono: true, file: input.file_path };
    case 'Write':
      return { icon: 'text-file', verb: 'Wrote', target: rel(input.file_path, cwd), mono: true, open: true, file: input.file_path };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: 'note', verb: 'Edited', target: rel(input.file_path || input.notebook_path, cwd), mono: true, open: true, file: input.file_path || input.notebook_path };
    case 'Glob':
      return { icon: 'search', verb: 'Found files', target: input.pattern || '', mono: true };
    case 'Grep':
      return { icon: 'search', verb: 'Searched for', target: input.pattern || '', mono: true };
    case 'WebFetch':
      return { icon: 'globe', verb: 'Fetched', target: input.url || '', mono: false };
    case 'WebSearch':
      return { icon: 'search', verb: 'Searched the web for', target: input.query || '', mono: false };
    case 'Task':
    case 'Agent':
      return { icon: 'sparkle', verb: input.subagent_type && input.subagent_type !== 'general-purpose' ? `${input.subagent_type} agent` : 'Agent', target: input.description || '', mono: false };
    case 'Workflow':
      return { icon: 'sparkle', verb: 'Ran a workflow', target: workflowMeta(input, 'name') || input.name || '', mono: false };
    case 'Skill':
      return { icon: 'bolt', verb: 'Used the skill', target: input.skill || input.name || '', mono: true };
    case 'TodoWrite':
      return { icon: 'list', verb: 'Updated the tasks', target: '', mono: false };
    default:
      return { icon: 'sparkle', verb: n.replace(/([a-z])([A-Z])/g, '$1 $2'), target: '', mono: false };
  }
}

/** The body of a tool card: what went in (the command, the diff) and, once it's back, what came out. */
function toolInputHtml(name, input = {}) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `<pre class="ccs-cmd"><span class="ccs-prompt">$</span> ${esc(input.command || '')}</pre>`;
    case 'Edit':
      return editHtml(input.old_string, input.new_string);
    case 'MultiEdit':
      return (input.edits || []).map((e) => editHtml(e.old_string, e.new_string)).join('');
    case 'Write':
      return addedHtml(input.content);
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
    case 'Skill':
      return '';
    case 'WebFetch':
      return input.prompt ? `<p class="ccs-tool-note">${esc(input.prompt)}</p>` : '';
    case 'Workflow': {
      // The script itself is long and of little use here: what it's for is enough.
      const d = workflowMeta(input, 'description');
      return d ? `<p class="ccs-tool-note">${esc(d)}</p>` : '';
    }
    case 'Task':
    case 'Agent':
      return input.prompt ? `<div class="ccs-tool-prompt">${markdown(input.prompt)}</div>` : '';
    default: {
      const j = JSON.stringify(input, null, 2);
      return j && j !== '{}' ? `<pre class="ccs-json">${esc(j)}</pre>` : '';
    }
  }
}
const editMeta = (name, input = {}) => {
  if (name === 'Edit') return editCounts(input.old_string, input.new_string);
  if (name === 'MultiEdit') return (input.edits || []).reduce((t, e) => {
    const c = editCounts(e.old_string, e.new_string);
    return { add: t.add + c.add, del: t.del + c.del };
  }, { add: 0, del: 0 });
  if (name === 'Write') return { add: String(input.content || '').split('\n').length, del: 0 };
  return null;
};
const HIDDEN_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);

/* ---------------- what's attached to a message: a session's composer, and the new-session screen ---------------- */

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const readImage = (file) =>
  new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(fr.result));
      res(m ? { kind: 'image', media_type: m[1], data: m[2], name: file.name || 'Pasted image' } : null);
    };
    fr.onerror = () => res(null);
    fr.readAsDataURL(file);
  });

/**
 * Pasted, dropped and picked attachments, shown in box. root: where files can be dropped (it gets .dropping); ta: where
 * they're pasted; cwd(): what @-mentions are relative to (none: the full path); folder(): where the picker opens;
 * mention(text): put an @-mention of a file that isn't a picture into the message.
 */
export function attachments({ root, box, ta, cwd, folder, mention }) {
  let list = []; // { kind: 'image', media_type, data, name } | { kind: 'path', path, name, image }
  const draw = () => {
    box.hidden = !list.length;
    box.innerHTML = list
      .map((a, i) => `<span class="ccs-att">${a.kind === 'image' ? `<img src="data:${esc(a.media_type)};base64,${a.data}" alt="">` : a.image ? icon('image', 13) : icon('text-file', 13)}<span>${esc(a.name)}</span><button type="button" class="cc-x" data-unatt="${i}" title="Remove">${icon('x', 10)}</button></span>`)
      .join('');
  };
  const addPath = (p) => {
    if (!p) return;
    if (IMG.test(p)) list.push({ kind: 'path', path: p, name: p.split('/').pop(), image: true });
    else {
      // Other files go in as an @-mention: Claude Code reads them in with the message.
      const r = rel(p, cwd?.());
      mention(`@${/\s/.test(r) ? `"${r}"` : r} `);
    }
    draw();
  };
  box.addEventListener('click', (e) => {
    const un = e.target.closest('[data-unatt]');
    if (!un) return;
    list.splice(Number(un.dataset.unatt), 1);
    draw();
  });
  ta.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const a = await readImage(f);
      if (a) list.push(a);
    }
    draw();
  });
  root.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      root.classList.add('dropping');
    }
  });
  root.addEventListener('dragleave', (e) => !root.contains(e.relatedTarget) && root.classList.remove('dropping'));
  root.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    root.classList.remove('dropping');
    for (const f of e.dataTransfer.files) {
      const p = shell.files?.pathForFile?.(f);
      if (p) addPath(p);
      else if (f.type.startsWith('image/')) {
        const a = await readImage(f);
        if (a) list.push(a);
      }
    }
    draw();
  });
  return {
    get list() {
      return list;
    },
    /** All of them, leaving none. */
    take() {
      const was = list;
      list = [];
      draw();
      return was;
    },
    /** These as well as what's there. */
    add(more) {
      list.push(...(more || []));
      draw();
    },
    async pick() {
      const r = await pickFiles({ mode: 'open', multiple: true, title: 'Attach to your message', accept: 'Attach', folder: folder?.() });
      for (const p of r?.paths || []) addPath(p);
    },
    payload: () => ({ images: list.filter((a) => a.kind === 'image').map((a) => ({ media_type: a.media_type, data: a.data })), imagePaths: list.filter((a) => a.kind === 'path').map((a) => a.path) }),
  };
}

/* ---------------- the session ---------------- */

/**
 * ctx: { cwd(): the folder it works in, files(): paths for "@", openFile(path), openUrl(url), newSession(),
 *        changed(): something may have changed on disk (the Changes panel refreshes), onActivity(state),
 *        folderName() and folderMenu(button): the folder chip, shown until the first message }
 * Returns { el, focus(), destroy(), send(text), setDraft(text), attach(list), isEmpty(), takeDraft(), giveDraft(d) }.
 */
export function createSession(id, ctx = {}) {
  const el = document.createElement('section');
  el.className = 'ccs';
  el.innerHTML = `<div class="ccs-scroll"><div class="ccs-log"></div><div class="ccs-working" hidden><span class="ccs-spark"></span><span class="ccs-wtext">Working…</span><small class="ccs-wtime"></small></div></div>
    <button class="ccs-jump" hidden title="Jump to the latest">${icon('down', 14)}</button>
    <div class="ccs-dock"></div>
    <form class="ccs-compose">
      <div class="ccs-pop" hidden></div>
      <div class="ccs-atts" hidden></div>
      <textarea rows="1" placeholder="Ask Claude to build, fix or explain something…" aria-label="Message Claude Code" spellcheck="true"></textarea>
      <div class="ccs-row">
        <button type="button" class="ccs-chip ccs-attach" title="Attach images or files (or paste and drop them)">${icon('plus', 14)}</button>
        <button type="button" class="ccs-chip ccs-folder" hidden></button>
        <button type="button" class="ccs-chip ccs-mode" title="Permission mode (Shift+Tab)"></button>
        <span class="ccs-ghost-hint" hidden><kbd>Tab</kbd> uses the suggestion</span>
        <span class="grow"></span>
        <button type="button" class="ccs-chip ccs-model" title="Model"></button>
        <button type="button" class="ccs-chip ccs-effort" title="Effort: how hard Claude thinks"></button>
        <button type="button" class="ccs-chip ccs-ultra" aria-pressed="false" title="${ULTRA_HINT}" hidden>${icon('sparkle', 12)}<span>Ultracode</span></button>
        <button type="button" class="ccs-ctx" title="Context"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" class="bg"/><circle cx="10" cy="10" r="7.5" class="fg" pathLength="100"/></svg><span class="ccs-ctx-n"></span></button>
        <button type="submit" class="ccs-send" title="Send (Enter)">${icon('up', 15)}</button>
        <button type="button" class="ccs-stop" title="Stop (Esc)" hidden><i></i></button>
      </div>
    </form>`;
  const $ = (s) => el.querySelector(s);
  const logEl = $('.ccs-log');
  const scroller = $('.ccs-scroll');
  const ta = $('textarea');
  const dock = $('.ccs-dock');
  const pop = $('.ccs-pop');
  const working = $('.ccs-working');
  let state = { busy: false, pending: [], queue: [], mode: null, pick: {}, context: null };
  let ctxWarned = false; // the "past 200k tokens" notice is shown once per climb
  let info = null;
  let loaded = false;
  let live = null; // the reply being written
  let liveRaf = 0;
  let suggestion = null; // Claude Code's guess at your next message, shown in the empty composer (Tab takes it)
  let dismissed = null; // the suggestion you cleared with Escape, so a state refresh doesn't bring it back
  const cards = new Map(); // tool id -> card element
  let lastCard = null;
  let todos = null; // the latest task list
  let startedAt = 0;
  let timer = 0;
  const draftKey = `claudecode:draft:${id}`;
  const userHistory = [];
  let histAt = -1;

  /* ----- scrolling ----- */
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  let stick = true;
  scroller.addEventListener('scroll', () => {
    stick = nearBottom();
    $('.ccs-jump').hidden = stick;
  });
  const toBottom = (force) => {
    if (force || stick) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  };
  const add = (html, cls) => {
    const node = document.createElement('div');
    node.className = cls;
    node.innerHTML = html;
    logEl.append(node);
    toBottom();
    return node;
  };

  function empty() {
    if (logEl.children.length) return drawFolder();
    add(`<img class="cl-logo" src="/img/claude-code.svg" alt="" draggable="false"><h3>What should we work on?</h3>
      <p>Claude Code works in <b>${esc(ctx.cwdLabel?.() || 'this folder')}</b> with your settings, CLAUDE.md and skills.</p>
      <div class="ccs-sugg">${['Explain how this project is laid out', 'Review my uncommitted changes', 'Find and fix a bug', 'Write tests for the code I changed'].map((s) => `<button type="button" class="chip-btn" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div>`, 'ccs-empty');
    drawFolder();
  }
  // Nothing said yet: the session can still move to another folder (the app makes it a new one there).
  const isEmpty = () => loaded && !!$('.ccs-empty') && !state.busy && !state.queue?.length;
  function drawFolder() {
    const b = $('.ccs-folder');
    const show = !!ctx.folderMenu && isEmpty();
    b.hidden = !show;
    if (!show) return;
    b.innerHTML = `${icon('folder', 12)}<span>${esc(ctx.folderName?.() || '')}</span>${icon('down', 10)}`;
    b.title = `Claude will work in ${ctx.cwd?.() || 'this folder'}. Choose another folder before you start.`;
  }

  /* ----- the transcript ----- */
  function render(e, { replay } = {}) {
    if (!['live', 'live-start', 'state', 'context', 'info', 'activity'].includes(e.t)) {
      $('.ccs-empty')?.remove();
      drawFolder();
    }
    switch (e.t) {
      case 'user': {
        lastCard = null;
        userHistory.push(e.text);
        const pics = (e.srcs || []).map((s) => `<img src="${esc(s)}" alt="">`).join('');
        const n = e.images && !e.srcs?.length ? `<span class="ccs-imgs">${icon('image', 12)} ${e.images} image${e.images === 1 ? '' : 's'}</span>` : '';
        add(`${pics ? `<div class="ccs-pics">${pics}</div>` : ''}${n}${e.text ? `<div class="ccs-utext">${esc(e.text)}</div>` : ''}`, 'ccs-user');
        if (!replay) stick = true;
        toBottom(!replay);
        break;
      }
      case 'live-start':
        live = add('', 'ccs-bot ccs-live');
        live._text = '';
        break;
      case 'live':
        if (!live) {
          live = add('', 'ccs-bot ccs-live');
          live._text = '';
        }
        live._text += e.text;
        // Shown every 80 ms, not every frame: the text still streams, and the screens are redrawn a fifth as often
        // (one surface spans them all; see steady.js).
        if (!liveRaf)
          liveRaf = setTimeout(() => {
            liveRaf = 0;
            if (live) live.innerHTML = markdown(live._text);
            toBottom();
          }, 80);
        break;
      case 'assistant':
        clearTimeout(liveRaf);
        liveRaf = 0;
        if (live && !replay) {
          live.classList.remove('ccs-live');
          live.innerHTML = markdown(e.text);
          live = null;
        } else add(markdown(e.text), 'ccs-bot');
        lastCard = null;
        toBottom();
        break;
      case 'thinking':
        add(`<details><summary>${icon('sparkle', 12)} Thinking</summary><div class="ccs-think-body">${markdown(e.text)}</div></details>`, 'ccs-think');
        break;
      case 'tool':
        if (HIDDEN_TOOLS.has(e.name)) break;
        if (e.name === 'TodoWrite') {
          todos = e.input?.todos || [];
          lastCard = add(todoHtml(todos), 'ccs-todos-inline');
          drawDock();
          break;
        }
        lastCard = toolCard(e);
        break;
      case 'tool-result': {
        const card = cards.get(e.toolId);
        if (!card) break;
        card.classList.remove('running');
        card.classList.toggle('failed', !!e.error && !e.declined);
        card.classList.toggle('declined', !!e.declined);
        card._result = e;
        if (!e.error && card._name === 'Bash') {
          const url = String(e.text || '').match(LOCAL_URL)?.at(-1);
          if (url) ctx.onUrl?.(url.replace('0.0.0.0', 'localhost'));
        }
        if (card.classList.contains('open')) fillOutput(card);
        else if (e.error && !e.declined && card._name === 'Bash') toggleCard(card, true);
        if (!replay && /^(Edit|MultiEdit|Write|NotebookEdit|Bash)$/.test(card._name)) ctx.changed?.();
        break;
      }
      case 'tool-error': {
        // Transcripts from before tool results were kept: the failure is all there is.
        const card = cards.get(e.toolId);
        if (card && !card._result) {
          card.classList.remove('running');
          card.classList.add('failed');
          card._result = { text: e.text, error: true };
        }
        break;
      }
      case 'image': {
        const card = (e.toolId && cards.get(e.toolId)) || lastCard;
        const img = document.createElement('img');
        img.className = 'ccs-shot';
        img.src = e.src;
        img.alt = 'Screenshot';
        (card?.querySelector('.ccs-tool-body') ? card : logEl).append(img);
        toBottom();
        break;
      }
      case 'answer':
        answerRow(e);
        break;
      case 'done':
        clearTimeout(liveRaf);
        liveRaf = 0;
        if (live) {
          live.classList.remove('ccs-live');
          if (!live._text) live.remove();
          live = null;
        }
        for (const c of cards.values()) if (c.classList.contains('running')) c.classList.remove('running');
        if (!e.ok) add(`${icon('flag', 13)}<span>${esc(e.text || 'Something went wrong')}</span>`, 'ccs-err');
        else if (e.stopped) add('<span>Stopped</span>', 'ccs-sep');
        else if (e.ms) add(`<span>${fmtSecs(e.ms)}${e.usage ? ` · ${fmtTokens(e.usage.input)} tokens read, ${fmtTokens(e.usage.output)} written` : ''}</span>`, 'ccs-sep ccs-turn');
        if (!replay) ctx.changed?.();
        break;
      case 'error':
        add(`${icon('flag', 13)}<span>${esc(e.text)}</span>`, 'ccs-err');
        break;
      case 'compacted':
        ctxWarned = false;
        add(`<span>Conversation compacted${e.pre ? ` (was ${fmtTokens(e.pre)} tokens)` : ''}</span>`, 'ccs-sep');
        break;
      case 'activity':
        if (state.busy) $('.ccs-wtext').textContent = e.text;
        break;
      case 'state':
        state = e;
        if (e.busy) suggestion = null;
        else if (e.suggestion && e.suggestion !== dismissed) suggestion = e.suggestion;
        drawState();
        break;
      case 'suggestion':
        if (!replay) {
          suggestion = e.text || null;
          drawGhost();
        }
        break;
      case 'context':
        state.context = { used: e.used, max: e.max, pct: e.pct };
        drawCtx();
        if (e.used >= CTX_WARN && !ctxWarned && !replay) {
          ctxWarned = true;
          add(`${icon('flag', 13)}<span>The conversation is past ${fmtTokens(CTX_WARN)} tokens (${fmtTokens(e.used)} now). Every reply reads all of it again, so each turn costs more. <button type="button" data-ctx-compact>Compact it</button> or start a new session.</span>`, 'ccs-err ccs-ctxwarn');
        } else if (e.used < CTX_WARN) ctxWarned = false;
        break;
      case 'info':
        info = e.info;
        drawPicks();
        break;
      case 'unqueued':
        if (e.items?.length) setDraft([ta.value, ...e.items].filter(Boolean).join('\n\n'));
        break;
      case 'cleared':
        logEl.innerHTML = '';
        cards.clear();
        todos = null;
        live = null;
        empty();
        drawDock();
        break;
    }
  }

  function toolCard(e) {
    const h = toolHead(e.name, e.input, ctx.cwd?.());
    const meta = h.plan ? null : editMeta(e.name, e.input);
    const node = add(`<button type="button" class="ccs-tool-head">
        <span class="ccs-tool-ic">${icon(h.icon, 13)}</span>
        <span class="ccs-tool-verb">${esc(h.verb)}</span>${h.target ? `<span class="ccs-tool-target${h.mono ? ' mono' : ''}"${h.file ? ` data-file="${esc(h.file)}"` : ''}>${esc(h.target)}</span>` : ''}
        ${meta ? `<span class="ccs-counts"><b class="add">+${meta.add}</b>${meta.del ? ` <b class="del">−${meta.del}</b>` : ''}</span>` : ''}
        <span class="grow"></span><span class="ccs-tool-state"></span><span class="ccs-chev">${icon('right', 11)}</span>
      </button><div class="ccs-tool-body" hidden></div>`, `ccs-tool running t-${String(e.name).replace(/\W/g, '')}`);
    node._name = e.name;
    node._input = e.input || {};
    node.dataset.tool = e.toolId || '';
    if (e.toolId) cards.set(e.toolId, node);
    // Edits show their diff right away, as in the desktop app; the rest open on a click.
    if (/^(Edit|MultiEdit|Write)$/.test(e.name) && !h.plan) toggleCard(node, true);
    return node;
  }
  function toggleCard(card, open = !card.classList.contains('open')) {
    card.classList.toggle('open', open);
    const body = card.querySelector('.ccs-tool-body');
    body.hidden = !open;
    if (open && !card._filled) {
      card._filled = true;
      body.insertAdjacentHTML('afterbegin', toolInputHtml(card._name, card._input));
      fillOutput(card);
    }
  }
  function fillOutput(card) {
    const r = card._result;
    const body = card.querySelector('.ccs-tool-body');
    if (!r || !card._filled || body.querySelector('.ccs-out')) return;
    // Edits' results just say it worked; reads are the file itself. Neither is worth showing unless it failed.
    if (!r.error && /^(Edit|MultiEdit|Write|Read|TodoWrite)$/.test(card._name)) return;
    const text = String(r.text || '').trim();
    if (!text) return;
    const out = document.createElement('div');
    out.className = `ccs-out${r.error ? ' err' : ''}`;
    if (card._name === 'Task' || card._name === 'Agent' || card._name.startsWith('mcp__') && !text.startsWith('{')) out.innerHTML = `<div class="ccs-out-md">${markdown(text)}</div>`;
    else out.innerHTML = `<pre>${linkify(esc(text))}</pre>`;
    body.append(out);
  }
  const todoHtml = (list) =>
    `<div class="ccs-todo-head">${icon('list', 13)} Tasks <small>${list.filter((t) => t.status === 'completed').length} of ${list.length} done</small></div>
    <ul>${list.map((t) => `<li class="${esc(t.status || 'pending')}"><span class="cm-check${t.status === 'completed' ? ' on' : ''}"></span>${esc(t.status === 'in_progress' ? t.activeForm || t.content : t.content)}</li>`).join('')}</ul>`;

  function answerRow(e) {
    if (e.kind === 'question') {
      const a = e.answers || {};
      add(`${icon('sparkle', 13)}<div>${Object.entries(a).map(([q, v]) => `<div><span>${esc(q)}</span> <b>${esc(v)}</b></div>`).join('') || '<span>Skipped the question</span>'}</div>`, 'ccs-answered');
      return;
    }
    if (e.kind === 'plan') {
      const how = e.mode === 'acceptEdits' ? ', edits auto-accepted' : e.mode === 'auto' ? ', in auto mode' : '';
      const node = add(`<details${e.allow ? '' : ' open'}><summary>${icon(e.allow ? 'tick' : 'note', 13)} ${e.allow ? `Plan approved${how}` : 'Kept planning'}</summary>
        ${e.plan ? `<div class="ccs-plan-md">${markdown(e.plan)}</div>` : ''}${e.feedback ? `<p class="ccs-fb">${esc(e.feedback)}</p>` : ''}</details>`, 'ccs-planrow');
      node.classList.toggle('kept', !e.allow);
      return;
    }
    add(`${icon(e.allow ? 'tick' : 'x', 12)}<span>${e.allow ? 'Allowed' : 'Declined'}: ${esc(e.title || '')}</span>`, `ccs-perm${e.allow ? '' : ' no'}`);
  }

  /* ----- what waits for you, above the composer ----- */
  function drawDock() {
    const ask = state.pending?.[0];
    const parts = [];
    if (todos?.length && todos.some((t) => t.status !== 'completed') && state.busy) {
      const cur = todos.find((t) => t.status === 'in_progress');
      const done = todos.filter((t) => t.status === 'completed').length;
      parts.push(`<details class="ccs-todobar"><summary><span class="ccs-prog"><i style="width:${Math.round((done / todos.length) * 100)}%"></i></span><b>${done}/${todos.length}</b><span>${esc(cur ? cur.activeForm || cur.content : 'Tasks')}</span></summary>${todoHtml(todos)}</details>`);
    }
    for (const q of state.queue || []) parts.push(`<div class="ccs-queued">${icon('clock', 12)}<span>${esc(q.text || `${q.images} image${q.images === 1 ? '' : 's'}`)}</span><small>Queued</small><button type="button" class="ccs-now" data-send-now="${esc(q.qid)}" title="Stop Claude and send this now">Send now</button><button type="button" class="cc-x" data-dequeue="${esc(q.qid)}" title="Take it back">${icon('x', 11)}</button></div>`);
    const key = `${ask?.requestId || ''}|${parts.join('')}`;
    if (dock._key === key) return;
    // Keep a card that's being filled in (an answer half chosen) when only the rest changes.
    const keepAsk = ask && dock._ask === ask.requestId ? dock.querySelector('[data-req]') : null;
    dock._key = key;
    dock.innerHTML = parts.join('');
    if (keepAsk) dock.append(keepAsk);
    else if (ask) dock.append(askCard(ask, state.pending.length - 1));
    dock._ask = ask?.requestId || null;
    if (ask && !keepAsk) requestAnimationFrame(() => dock.querySelector('[data-focus]')?.focus({ preventScroll: true }));
    el.classList.toggle('asking', !!ask);
  }

  function askCard(a, more) {
    const node = document.createElement('div');
    node.dataset.req = a.requestId;
    const extra = more > 0 ? `<small class="ccs-more">+${more} more waiting</small>` : '';
    if (a.kind === 'question') {
      const qs = a.input?.questions || [];
      node.className = 'ccs-ask ccs-q';
      node.innerHTML = `<div class="ccs-ask-title">${icon('sparkle', 14)}<b>Claude has ${qs.length === 1 ? 'a question' : `${qs.length} questions`}</b>${extra}</div>
        ${qs
          .map((q, qi) => `<fieldset data-q="${qi}"><legend>${q.header ? `<span class="ccs-qh">${esc(q.header)}</span>` : ''}${esc(q.question)}</legend>
            <div class="ccs-opts">${(q.options || [])
              .map((o, oi) => `<label class="ccs-opt"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}-${esc(a.requestId)}" value="${esc(o.label)}" ${qi === 0 && oi === 0 ? 'data-focus' : ''}><span><b>${esc(o.label)}</b>${o.description && o.description !== o.label ? `<small>${esc(o.description)}</small>` : ''}</span></label>`)
              .join('')}
              <label class="ccs-opt ccs-other"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}-${esc(a.requestId)}" value="__other"><span><input type="text" placeholder="Something else…" data-other></span></label></div></fieldset>`)
          .join('')}
        <div class="ccs-ask-actions"><button type="button" class="btn small" data-ans="skip">Skip</button><span class="grow"></span><button type="button" class="btn small primary" data-ans="submit">Submit answers</button></div>`;
      return node;
    }
    if (a.kind === 'plan') {
      node.className = 'ccs-ask ccs-plan';
      node.innerHTML = `<div class="ccs-ask-title">${icon('note', 14)}<b>Claude’s plan</b>${extra}<span class="grow"></span><small>Approve it to let Claude start</small></div>
        <div class="ccs-plan-md">${markdown(a.input?.plan || '')}</div>
        <textarea rows="1" placeholder="Tell Claude what to change (for Keep planning)" data-fb></textarea>
        <div class="ccs-ask-actions"><button type="button" class="btn small" data-ans="keep">Keep planning</button><span class="grow"></span>
          <button type="button" class="btn small" data-ans="approve" data-mode="default">Approve, ask before edits</button>
          <button type="button" class="btn small primary" data-ans="approve" data-mode="acceptEdits" data-focus>Approve and auto-accept edits</button></div>`;
      return node;
    }
    const inp = a.input || {};
    let detail = '';
    if (a.tool === 'Edit') detail = editHtml(inp.old_string, inp.new_string);
    else if (a.tool === 'MultiEdit') detail = (inp.edits || []).map((x) => editHtml(x.old_string, x.new_string)).join('');
    else if (a.tool === 'Write') detail = addedHtml(inp.content, { max: 80 });
    else if (a.tool === 'Bash' || a.tool === 'PowerShell') detail = `<pre class="ccs-cmd"><span class="ccs-prompt">$</span> ${esc(inp.command || '')}</pre>`;
    else if (a.detail) detail = `<pre class="ccs-json">${esc(a.detail)}</pre>`;
    const path = inp.file_path ? rel(inp.file_path, ctx.cwd?.()) : '';
    const verb = a.tool === 'Bash' || a.tool === 'PowerShell' ? 'run this command' : a.tool === 'Write' ? (path ? `create ${path}` : 'write a file') : /Edit/.test(a.tool) ? (path ? `edit ${path}` : 'edit a file') : a.title.charAt(0).toLowerCase() + a.title.slice(1);
    node.className = 'ccs-ask ccs-perm-card';
    node.innerHTML = `<div class="ccs-ask-title">${icon('key', 14)}<b>Allow Claude to ${esc(verb)}?</b>${extra}</div>
      ${a.note ? `<p class="ccs-ask-note">${esc(a.note)}</p>` : ''}
      ${detail ? `<div class="ccs-ask-detail">${detail}</div>` : ''}
      <div class="ccs-ask-actions"><button type="button" class="btn small" data-ans="deny" title="Esc">Deny</button>
        <input type="text" class="ccs-deny-why" placeholder="or tell Claude what to do instead…" data-why>
        <button type="button" class="btn small" data-ans="always" title="Don’t ask again for ${esc(a.tool)} in this session">Always allow</button>
        <button type="button" class="btn small primary" data-ans="allow" data-focus title="Enter">Allow</button></div>`;
    return node;
  }

  async function answerAsk(card, kind) {
    const req = card.dataset.req;
    const a = state.pending.find((p) => p.requestId === req);
    if (!a) return;
    let decision = 'allow';
    const extra = {};
    let always = false;
    if (a.kind === 'question') {
      if (kind === 'skip') decision = 'deny';
      else {
        const answers = {};
        (a.input?.questions || []).forEach((q, qi) => {
          const fs = card.querySelector(`[data-q="${qi}"]`);
          const picked = [...fs.querySelectorAll('input:checked')].map((i) => (i.value === '__other' ? fs.querySelector('[data-other]').value.trim() : i.value)).filter(Boolean);
          if (picked.length) answers[q.question] = picked.join(', ');
        });
        if (!Object.keys(answers).length) return toast('Pick an answer first (or Skip)');
        extra.answers = answers;
      }
    } else if (a.kind === 'plan') {
      if (kind === 'keep') {
        decision = 'deny';
        extra.feedback = card.querySelector('[data-fb]').value;
      } else extra.mode = card.querySelector('[data-ans]:focus')?.dataset.mode || card._mode || 'acceptEdits';
    } else {
      decision = kind === 'deny' ? 'deny' : 'allow';
      always = kind === 'always';
      if (decision === 'deny') extra.feedback = card.querySelector('[data-why]')?.value || '';
    }
    card.querySelectorAll('button, input, textarea').forEach((b) => (b.disabled = true));
    try {
      await shell.agentChat.answer(id, req, decision, always, extra);
    } catch (err) {
      toast(err.message, 'error');
      card.querySelectorAll('button, input, textarea').forEach((b) => (b.disabled = false));
    }
  }

  /* ----- state: working, the composer's controls ----- */
  function drawState() {
    el.classList.toggle('busy', !!state.busy);
    working.hidden = !state.busy;
    $('.ccs-stop').hidden = !state.busy;
    drawFolder();
    $('.ccs-send').classList.toggle('queue', !!state.busy);
    $('.ccs-send').title = state.busy ? 'Queue this message for when Claude finishes (Enter), or stop Claude and send it now (Ctrl+Enter)' : 'Send (Enter)';
    if (state.busy && !startedAt) {
      startedAt = Date.now();
      $('.ccs-wtext').textContent = 'Working…';
      clearInterval(timer);
      timer = setInterval(() => ($('.ccs-wtime').textContent = fmtSecs(Date.now() - startedAt)), 1000);
    }
    if (!state.busy) {
      startedAt = 0;
      clearInterval(timer);
      $('.ccs-wtime').textContent = '';
    }
    drawGhost();
    drawPicks();
    drawCtx();
    drawDock();
    ctx.onActivity?.(state);
  }
  // The suggestion sits where the placeholder is, while the composer is empty and Claude is done.
  const ghostShown = () => !!suggestion && !state.busy && !ta.value && !atts.list.length;
  function drawGhost() {
    const show = ghostShown();
    ta.placeholder = show ? suggestion : state.busy ? 'Claude is working. Type to queue a message…' : 'Ask Claude to build, fix or explain something…';
    $('.ccs-compose').classList.toggle('ccs-suggesting', show);
    $('.ccs-ghost-hint').hidden = !show;
  }
  function takeGhost() {
    const text = suggestion;
    dismissed = text;
    suggestion = null;
    setDraft(text);
    ta.setSelectionRange(text.length, text.length);
    drawGhost();
    ta.focus();
  }
  const models = () => (info?.models?.length ? info.models : FALLBACK_MODELS);
  const curModel = () => {
    const v = state.pick?.model || 'default';
    return models().find((m) => m.value === v) || { value: v, name: v, efforts: FALLBACK_MODELS[0].efforts };
  };
  const familyOf = (s) => MODEL_FAMILIES.find((f) => String(s || '').toLowerCase().includes(f)) || null;
  // The model the process says it runs (claude-fable-5-1 → the list's Fable 5.1). A resumed session keeps the model it
  // last ran, so this can differ from the pick.
  const runningModel = () => {
    const v = state.model;
    if (!v) return null;
    const fam = familyOf(v);
    return models().find((m) => m.value === v) || (fam && models().find((m) => m.value === fam)) || { value: v, name: v };
  };
  function drawPicks() {
    const m = modeOf(state.mode || 'default');
    const mb = $('.ccs-mode');
    mb.innerHTML = `${icon(m.id === 'plan' ? 'note' : m.id === 'bypassPermissions' ? 'bolt' : m.id === 'default' ? 'key' : 'tick', 12)}<span>${esc(m.short)}</span>`;
    mb.dataset.mode = m.id;
    mb.title = `${m.label}: ${m.hint} (Shift+Tab to switch)`;
    const cm = curModel();
    const rm = runningModel();
    // What was picked, by family (the default entry says which model it is in its description).
    const pickedFam = cm.value === 'default' ? familyOf(cm.description) : familyOf(cm.value) || familyOf(cm.name);
    const mismatch = !!(rm && pickedFam && familyOf(rm.value) && familyOf(rm.value) !== pickedFam);
    const modelBtn = $('.ccs-model');
    modelBtn.innerHTML = `<span>${esc(rm ? rm.name : cm.value === 'default' ? 'Default model' : cm.name)}</span>${icon('down', 10)}`;
    modelBtn.classList.toggle('ccs-mismatch', mismatch);
    modelBtn.title = mismatch
      ? `This session is running ${rm.name} (${state.model}), not ${cm.value === 'default' ? 'the default' : cm.name} as picked: a resumed session keeps the model it last ran. Choose a model to switch.`
      : rm ? `Model: ${state.model}${cm.value === 'default' ? ' (Claude Code’s default)' : ''}` : `Model: ${cm.value === 'default' ? 'Claude Code’s default' : cm.name}`;
    const eff = $('.ccs-effort');
    eff.hidden = !cm.efforts?.length;
    eff.innerHTML = `<span class="ccs-bars" data-level="${esc(state.pick?.effort || '')}"><i></i><i></i><i></i></span><span>${esc(state.pick?.effort ? EFFORT_LABEL[state.pick.effort] : 'Effort')}</span>`;
    // Ultracode only where Claude Code says this account and model offer it.
    const ub = $('.ccs-ultra');
    ub.hidden = state.ultracode?.available !== true;
    ub.setAttribute('aria-pressed', String(!!state.ultracode?.on));
  }
  function drawCtx() {
    const c = state.context;
    const b = $('.ccs-ctx');
    b.hidden = !c?.max;
    if (!c?.max) return;
    const pct = Math.min(100, Math.round((c.used / c.max) * 100));
    const heavy = c.used >= CTX_WARN;
    b.querySelector('.fg').style.strokeDasharray = `${pct} 100`;
    b.querySelector('.ccs-ctx-n').textContent = fmtTokens(c.used);
    b.classList.toggle('warn', heavy || pct >= 70);
    b.title = `Context: ${fmtTokens(c.used)} of ${fmtTokens(c.max)} tokens (${pct}%).${heavy ? ` Past ${fmtTokens(CTX_WARN)}: every reply reads all of it again, so each turn costs more.` : ''} Click to compact.`;
  }
  const set = async (patch) => {
    try {
      state = { ...state, ...(await shell.agentChat.set(id, patch)) };
      drawState();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const menuAt = (btn, items) => {
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.top - 4, items, { up: true, minWidth: 220 });
  };
  function modeMenu(btn = $('.ccs-mode')) {
    const autoOk = curModel().auto !== false;
    menuAt(btn, [{ header: 'Permission mode' }, ...MODES.filter((m) => m.id !== 'auto' || autoOk).map((m) => ({ label: m.label, checked: (state.mode || 'default') === m.id, act: () => set({ mode: m.id }) }))]);
  }
  function modelMenu(btn = $('.ccs-model')) {
    const cur = state.pick?.model || 'default';
    menuAt(btn, [{ header: 'Model' }, ...models().map((m) => ({ label: m.value === 'default' ? m.name.replace(/\s*\(recommended\)/i, '') + (m.description ? ` · ${m.description.split('·')[0].trim()}` : '') : m.name, checked: cur === m.value, act: () => set({ model: m.value === 'default' ? null : m.value }) }))]);
  }
  function effortMenu(btn = $('.ccs-effort')) {
    const cur = state.pick?.effort || '';
    menuAt(btn, [{ header: 'Effort' }, { label: 'Claude Code’s setting', checked: !cur, act: () => set({ effort: null }) }, ...(curModel().efforts || []).map((e) => ({ label: EFFORT_LABEL[e] || e, checked: cur === e, act: () => set({ effort: e }) }))]);
  }
  const toggleUltra = () => set({ ultracode: !state.ultracode?.on });
  const cycleMode = () => {
    const order = ['default', 'acceptEdits', 'plan', ...(curModel().auto !== false ? ['auto'] : [])];
    const i = order.indexOf(state.mode || 'default');
    set({ mode: order[(i + 1) % order.length] });
  };

  /* ----- loading ----- */
  async function load() {
    try {
      const h = await shell.agentChat.history(id);
      info = h.info || null;
      logEl.innerHTML = '';
      live = null;
      for (const e of h.log) render(e, { replay: true });
      // A reply being written right now (a reload or a restart of Leafdeck in the middle of it).
      if (h.live) render({ t: 'live', text: h.live }, { replay: true });
      state = h;
      drawState();
    } catch (err) {
      add(`${icon('flag', 13)}<span>${esc(err.message)}</span>`, 'ccs-err');
    }
    loaded = true;
    empty();
    toBottom(true);
    // Start Claude Code now if it isn't running, so the models and commands are its own (no message is sent).
    if (!state.running) shell.agentChat.warm(id).then((s) => {
      if (s.info) info = s.info;
      state = { ...state, ...s };
      drawState();
    }, () => {});
  }

  /* ----- the composer ----- */
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(260, ta.scrollHeight)}px`;
  };
  function setDraft(text) {
    ta.value = text;
    grow();
    saveDraft();
  }
  let draftT = 0;
  const saveDraft = () => {
    clearTimeout(draftT);
    draftT = setTimeout(() => {
      try {
        if (ta.value) localStorage.setItem(draftKey, ta.value);
        else localStorage.removeItem(draftKey);
      } catch {}
    }, 300);
  };
  function insertAtCursor(text) {
    const s = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, s);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + pad + text + ta.value.slice(ta.selectionEnd ?? s);
    const at = s + pad.length + text.length;
    ta.setSelectionRange(at, at);
    grow();
    ta.focus();
  }
  const atts = attachments({ root: el, box: $('.ccs-atts'), ta, cwd: () => ctx.cwd?.(), folder: () => ctx.cwd?.(), mention: insertAtCursor });

  async function send(textArg, { now = false } = {}) {
    const text = String(textArg ?? ta.value).trim();
    if (!text && !atts.list.length) return;
    closePop();
    // Commands handled here.
    const cmd = /^\/(\S+)\s*$/.exec(text);
    if (cmd && !atts.list.length) {
      if (cmd[1] === 'clear' || cmd[1] === 'new' || cmd[1] === 'reset') {
        setDraft('');
        return ctx.newSession?.();
      }
      if (cmd[1] === 'model') {
        setDraft('');
        return modelMenu();
      }
      if (cmd[1] === 'mode') {
        setDraft('');
        return modeMenu();
      }
      if (cmd[1] === 'ultracode') {
        setDraft('');
        if (state.ultracode?.available === false) return toast('Ultracode isn’t available with this model.');
        return toggleUltra();
      }
    }
    const { images, imagePaths } = atts.payload();
    const keep = { text: ta.value, atts: atts.take() };
    if (textArg == null) setDraft('');
    histAt = -1;
    try {
      state = { ...state, ...(await shell.agentChat.send(id, text, { images, imagePaths, queue: true, now })) };
      drawState();
      stick = true;
      toBottom(true);
    } catch (err) {
      toast(err.message, 'error');
      if (textArg == null) setDraft(keep.text);
      atts.add(keep.atts);
    }
  }

  /* ----- "/" and "@" suggestions ----- */
  let popItems = [];
  let popSel = 0;
  let popKind = null; // 'slash' | 'file'
  let popRange = null; // [start, end] of the text being completed
  let fileList = null;
  let fileListAt = 0;
  const closePop = () => {
    pop.hidden = true;
    popKind = null;
    popItems = [];
  };
  function drawPop() {
    if (!popItems.length) return closePop();
    pop.hidden = false;
    pop.innerHTML = popItems
      .map((it, i) => `<button type="button" class="ccs-pop-item${i === popSel ? ' on' : ''}" data-pop="${i}">${popKind === 'slash' ? `<b>/${esc(it.name)}</b>${it.hint ? `<i>${esc(it.hint)}</i>` : ''}<small>${esc(it.description || '')}</small>` : `${icon('text-file', 12)}<b>${esc(it.split('/').pop())}</b><small>${esc(it)}</small>`}</button>`)
      .join('');
    pop.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  const fuzzy = (q, s) => {
    let i = 0;
    for (const c of s) if (c === q[i]) i++;
    return i === q.length;
  };
  async function suggest() {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const slash = /^\/([\w:.-]*)$/.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      const all = [...LOCAL_COMMANDS, ...(info?.commands || []).filter((c) => !['clear', 'model', 'config', 'color', 'heapdump', 'doctor', 'login', 'logout', 'exit', 'vim', 'terminal-setup', 'ide', 'theme', 'ultracode'].includes(c.name))];
      popItems = all.filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((x) => x.startsWith(q))).concat(all.filter((c) => q && !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))).slice(0, 40);
      popKind = 'slash';
      popRange = [0, pos];
      popSel = Math.min(popSel, Math.max(0, popItems.length - 1));
      return drawPop();
    }
    const at = /(^|\s)@("?)([^\s"]*)$/.exec(before);
    if (at) {
      if (!fileList || Date.now() - fileListAt > 15000) {
        fileListAt = Date.now();
        fileList = (await ctx.files?.().catch(() => [])) || [];
        if (ta.selectionStart !== pos) return;
      }
      const q = at[3].toLowerCase();
      const scored = [];
      for (const f of fileList) {
        const lf = f.toLowerCase();
        const base = lf.slice(lf.lastIndexOf('/') + 1);
        let s = -1;
        if (!q) s = 100 - f.split('/').length;
        else if (base.startsWith(q)) s = 300 - f.length / 100;
        else if (lf.startsWith(q)) s = 250 - f.length / 100;
        else if (lf.includes(q)) s = 200 - f.length / 100;
        else if (fuzzy(q, lf)) s = 100 - f.length / 100;
        if (s >= 0) scored.push([s, f]);
        if (scored.length > 4000) break;
      }
      scored.sort((a, b) => b[0] - a[0]);
      popItems = scored.slice(0, 12).map((x) => x[1]);
      popKind = 'file';
      popRange = [pos - at[3].length - 1 - at[2].length, pos];
      popSel = Math.min(popSel, Math.max(0, popItems.length - 1));
      return drawPop();
    }
    closePop();
  }
  function pick(i = popSel) {
    const it = popItems[i];
    if (!it) return;
    const kind = popKind;
    const [a, b] = popRange;
    const ins = kind === 'slash' ? `/${it.name} ` : `@${/\s/.test(it) ? `"${it}"` : it} `;
    ta.value = ta.value.slice(0, a) + ins + ta.value.slice(b);
    const caret = a + ins.length;
    ta.setSelectionRange(caret, caret);
    grow();
    closePop();
    ta.focus();
    // A local command runs as soon as it's chosen.
    if (kind === 'slash' && it.local) send();
  }

  /* ----- events ----- */
  ta.addEventListener('input', () => {
    grow();
    saveDraft();
    popSel = 0;
    suggest();
    drawGhost();
  });
  ta.addEventListener('keydown', (e) => {
    if (!pop.hidden && popItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        popSel = (popSel + (e.key === 'ArrowDown' ? 1 : popItems.length - 1)) % popItems.length;
        return drawPop();
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        return pick();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return closePop();
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      return cycleMode();
    }
    if (ghostShown() && (e.key === 'Tab' || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Tab') return takeGhost();
      dismissed = suggestion;
      suggestion = null;
      return drawGhost();
    }
    if (e.key === 'Escape' && state.busy) {
      e.preventDefault();
      e.stopPropagation();
      return shell.agentChat.interrupt(id);
    }
    if (e.key === 'ArrowUp' && !ta.value.includes('\n') && ta.selectionStart === 0 && userHistory.length && (histAt >= 0 || !ta.value)) {
      e.preventDefault();
      histAt = histAt < 0 ? userHistory.length - 1 : Math.max(0, histAt - 1);
      ta.value = userHistory[histAt];
      return grow();
    }
    if (e.key === 'ArrowDown' && histAt >= 0 && !ta.value.includes('\n')) {
      e.preventDefault();
      histAt++;
      ta.value = histAt < userHistory.length ? userHistory[histAt] : '';
      if (histAt >= userHistory.length) histAt = -1;
      return grow();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Ctrl+Enter while Claude works: don't wait, stop it and send this now.
      send(undefined, { now: e.ctrlKey || e.metaKey });
    }
  });
  ta.addEventListener('blur', () => setTimeout(() => !pop.matches(':hover') && closePop(), 150));
  $('.ccs-compose').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pop]');
    if (b) pick(Number(b.dataset.pop));
  });
  dock.addEventListener('keydown', (e) => {
    const card = e.target.closest('[data-req]');
    if (!card) return;
    if (card.classList.contains('ccs-perm-card')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        answerAsk(card, 'deny');
      } else if (e.key === 'Enter' && e.target.matches('[data-why]')) {
        e.preventDefault();
        answerAsk(card, 'deny');
      }
    }
    if (e.key === 'Enter' && e.target.matches('[data-other]')) {
      e.preventDefault();
      card.querySelector('[data-ans="submit"]').click();
    }
  });
  dock.addEventListener('input', (e) => {
    // Typing an "other" answer picks it.
    if (e.target.matches('[data-other]')) {
      const r = e.target.closest('.ccs-other').querySelector('input[value="__other"]');
      r.checked = !!e.target.value.trim() || r.checked;
    }
    if (e.target.matches('[data-fb]')) {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
    }
  });
  dock.addEventListener('focusin', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) b.closest('[data-req]')._mode = b.dataset.mode;
  });

  el.addEventListener('click', async (e) => {
    const t = e.target;
    const ans = t.closest('[data-ans]');
    if (ans) {
      const card = ans.closest('[data-req]');
      if (ans.dataset.mode) card._mode = ans.dataset.mode;
      return answerAsk(card, ans.dataset.ans);
    }
    const now = t.closest('[data-send-now]');
    if (now) {
      now.disabled = true;
      try {
        state = { ...state, ...(await shell.agentChat.sendNow(id, now.dataset.sendNow)) };
        drawState();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const dq = t.closest('[data-dequeue]');
    if (dq) {
      const text = await shell.agentChat.dequeue(id, dq.dataset.dequeue).catch(() => null);
      if (text && !ta.value.trim()) setDraft(text);
      return;
    }
    const sugg = t.closest('[data-sugg]');
    if (sugg) return send(sugg.dataset.sugg);
    const copy = t.closest('.cm-copy');
    if (copy) {
      navigator.clipboard.writeText(copy.closest('.cm-code').querySelector('code').textContent).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1400);
      });
      return;
    }
    const link = t.closest('a[data-url]');
    if (link) {
      e.preventDefault();
      return ctx.openUrl?.(link.dataset.url);
    }
    // A file named in a reply, or a tool card's file: open it.
    const file = t.closest('[data-file]');
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      return ctx.openFile?.(file.dataset.file);
    }
    const head = t.closest('.ccs-tool-head');
    if (head && !getSelection().toString()) return toggleCard(head.closest('.ccs-tool'));
    if (t.closest('.ccs-shot')) return t.closest('.ccs-shot').classList.toggle('big');
    if (t.closest('.ccs-jump')) {
      stick = true;
      return toBottom(true);
    }
    if (t.closest('.ccs-stop')) return shell.agentChat.interrupt(id);
    if (t.closest('[data-ctx-compact]')) return send('/compact');
    if (t.closest('.ccs-mode')) return modeMenu();
    if (t.closest('.ccs-model')) return modelMenu();
    if (t.closest('.ccs-effort')) return effortMenu();
    if (t.closest('.ccs-ultra')) return toggleUltra();
    if (t.closest('.ccs-ctx')) {
      const c = state.context;
      return menuAt(t.closest('.ccs-ctx'), [{ header: c ? `${fmtTokens(c.used)} of ${fmtTokens(c.max)} tokens (${Math.round((c.used / c.max) * 100)}%)` : 'Context' }, { label: 'Compact the conversation', act: () => send('/compact') }, { label: 'Start a new session', act: () => ctx.newSession?.() }]);
    }
    if (t.closest('.ccs-attach')) return atts.pick();
    if (t.closest('.ccs-folder')) return ctx.folderMenu?.(t.closest('.ccs-folder'));
  });

  const off = listen(id, (ev) => loaded && render(ev));
  try {
    const d = localStorage.getItem(draftKey);
    if (d) {
      ta.value = d;
      requestAnimationFrame(grow);
    }
  } catch {}
  load();

  return {
    el,
    send,
    setDraft,
    attach: (list) => atts.add(list),
    isEmpty,
    // What's being written, to go with the session to another folder.
    takeDraft() {
      const d = { text: ta.value, atts: atts.take() };
      setDraft('');
      return d;
    },
    giveDraft(d) {
      setDraft(d.text || '');
      atts.add(d.atts);
    },
    state: () => state,
    focus: () => ta.focus({ preventScroll: true }),
    // Put in a window, or back in one: the browser forgets a taken-out element's scroll position. Opens at the latest.
    shown: () => {
      stick = true;
      $('.ccs-jump').hidden = true;
      toBottom(true);
    },
    destroy: () => {
      off();
      clearInterval(timer);
    },
  };
}
