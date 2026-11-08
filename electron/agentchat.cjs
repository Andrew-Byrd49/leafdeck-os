// Claude Code chats: Claude Code running in the background, shown as a chat in Leafdeck. Used by App Builder (one
// conversation per app) and by the Claude assistant (the button at the bottom left; id "@assistant").
// Claude Code runs headless (`-p`) with stream-json in and out, the same protocol the Agent SDK speaks:
//   stdin:  {type:'user', message} and control requests (initialize, interrupt) / responses (tool approvals)
//   stdout: system/assistant/user/result messages, stream_event deltas, and control_request can_use_tool
// Each conversation keeps its Claude session id and a transcript in its folder (.leafdeck-session.json,
// .leafdeck-chat.jsonl), so the chat survives restarts and "Open in terminal" resumes the same conversation.
// With leafdeckd running, the process lives there (electron/chathost.cjs), so a turn under way carries on through a restart
// of Leafdeck: .leafdeck-live.json holds what's only in memory here, and reattach() picks each chat up from it.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// { dir(id): where the transcript lives, launch(id): { cwd, args, mode, pickable, askUser } for starting Claude Code
//   (writes its config; pickable: the chat picks its own model, effort, permission mode and Ultracode (setPicks), askUser: Claude
//   may ask questions with AskUserQuestion), claudeExe(), send(channel, payload), freshMs(id): start a new conversation
//   after this long without a message (0: never), infoCache: a file to keep what Claude Code said about itself in,
//   autoAllow(id, tool, input): this permission request needs no answer from you }
let deps = null;
const sessions = new Map(); // conversation id -> session
const IDLE_MS = 15 * 60_000;
const MAX_LOG = 1500; // transcript entries kept per conversation
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let lastInfo = null; // models, slash commands, account: from the last Claude Code that started (initialize)
let host = null; // electron/chathost.cjs's client, when leafdeckd holds the processes

/* ---------------- transcript ---------------- */

const logFile = (id) => path.join(deps.dir(id), '.leafdeck-chat.jsonl');
const metaFile = (id) => path.join(deps.dir(id), '.leafdeck-session.json');

function readLog(id) {
  try {
    return fs
      .readFileSync(logFile(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-MAX_LOG);
  } catch {
    return [];
  }
}
function appendLog(id, entry) {
  try {
    fs.appendFileSync(logFile(id), JSON.stringify(entry) + '\n');
  } catch {}
}
function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')) || {};
  } catch {
    return {};
  }
}
function writeMeta(id, patch) {
  try {
    fs.writeFileSync(metaFile(id), JSON.stringify({ ...readMeta(id), ...patch }, null, 2));
  } catch {}
}


/* ---------------- what a hosted chat needs to carry on after a restart ---------------- */

const liveFile = (id) => path.join(deps.dir(id), '.leafdeck-live.json');
const queueFile = (id) => path.join(deps.dir(id), '.leafdeck-queue.json');
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) || null;
  } catch {
    return null;
  }
}
function writeJson(file, value) {
  try {
    const f = file();
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(value));
    fs.renameSync(`${f}.tmp`, f);
  } catch {}
}
function forgetLive(id) {
  try {
    fs.rmSync(liveFile(id), { force: true });
    fs.rmSync(queueFile(id), { force: true });
  } catch {}
}
/** Saved after anything that changes it. Queued messages have their own file: pictures make them large. */
function saveLive(s) {
  if (!s.child?.ack) return;
  writeJson(() => liveFile(s.id), {
    seq: s.child.seq,
    busy: s.busy,
    interrupted: !!s.interrupted,
    restartAfter: !!s.restartAfter,
    pending: [...s.pending.values()],
    allowAlways: [...s.allowAlways],
    model: s.model,
    mode: s.mode,
    context: s.context,
    ultracode: s.ultracode,
    afterTool: [...s.afterTool],
    tools: [...s.tools],
  });
  const queued = s.queue.map((q) => q.qid).join();
  if (queued !== s.queued) {
    s.queued = queued;
    if (queued) writeJson(() => queueFile(s.id), s.queue);
    else
      try {
        fs.rmSync(queueFile(s.id), { force: true });
      } catch {}
  }
  s.child.ack();
}
// What only updates the status line: not worth a write, since seeing it twice does no harm.
const passing = (m) => m.type === 'stream_event' || m.type === 'control_response' || (m.type === 'system' && ['api_retry', 'task_summary', 'thinking_tokens'].includes(m.subtype));

/* ---------------- friendly tool rows ---------------- */

const LEAFDECK_TOOLS = {
  leafdeck_app_open: 'Opened the app',
  leafdeck_app_logs: 'Read the app’s log',
  leafdeck_app_guide: 'Read the app guide',
  leafdeck_app_list: 'Listed your apps',
  leafdeck_app_create: 'Created an app',
  leafdeck_screenshot: 'Took a screenshot',
  leafdeck_snapshot: 'Read the window',
  leafdeck_click: 'Clicked',
  leafdeck_fill: 'Filled in a field',
  leafdeck_type: 'Typed',
  leafdeck_press: 'Pressed a key',
  leafdeck_scroll: 'Scrolled',
  leafdeck_find: 'Looked for something on the page',
  leafdeck_wait: 'Waited',
  leafdeck_records: 'Read your records',
  leafdeck_windows: 'Listed open windows',
  leafdeck_open: 'Opened a window',
  leafdeck_focus: 'Switched windows',
  leafdeck_close: 'Closed a window',
  leafdeck_navigate: 'Went to a page',
  leafdeck_evaluate: 'Ran a script in a window',
};
// What an approval card asks for ("Claude wants to click in a window").
const LEAFDECK_ASKS = {
  leafdeck_click: 'Click in a window',
  leafdeck_fill: 'Fill in a field',
  leafdeck_type: 'Type in a window',
  leafdeck_press: 'Press a key',
  leafdeck_navigate: 'Go to a web page',
  leafdeck_close: 'Close a window',
  leafdeck_evaluate: 'Run a script in a window',
  leafdeck_app_create: 'Create a Leafdeck app',
};
const base = (p) => (p ? path.basename(String(p)) : '');
// Long errors keep their start and their end: a traceback's actual error is its last line.
function clipError(text) {
  text = text.trim();
  return text.length <= 300 ? text : `${text.slice(0, 120)} … ${text.slice(-180)}`;
}
function describeTool(name, input = {}) {
  const n = String(name || '');
  if (n.startsWith('mcp__leafdeck__')) {
    const t = n.slice('mcp__leafdeck__'.length);
    return { icon: t === 'leafdeck_screenshot' ? 'eye' : 'leaf', text: LEAFDECK_TOOLS[t] || t.replace(/^leafdeck_/, '').replace(/_/g, ' ') };
  }
  switch (n) {
    case 'Write':
      return { icon: 'note', text: `Wrote ${base(input.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
      return { icon: 'note', text: `Edited ${base(input.file_path)}` };
    case 'Read':
      return { icon: 'eye', text: `Read ${base(input.file_path)}` };
    case 'Glob':
    case 'Grep':
      return { icon: 'search', text: `Searched ${input.pattern ? `for “${String(input.pattern).slice(0, 40)}”` : 'the files'}` };
    case 'Bash':
    case 'PowerShell':
      return { icon: 'bolt', text: input.description || `Ran ${String(input.command || '').slice(0, 60)}`, detail: String(input.command || '').slice(0, 400) };
    case 'WebFetch':
      return { icon: 'globe', text: `Opened ${String(input.url || '').slice(0, 60)}` };
    case 'WebSearch':
      return { icon: 'search', text: `Searched the web for “${String(input.query || '').slice(0, 40)}”` };
    case 'TodoWrite':
      return { icon: 'list', text: 'Updated its plan' };
    case 'Task':
    case 'Agent':
      return { icon: 'sparkle', text: input.description || 'Started a helper' };
    default:
      return { icon: 'sparkle', text: n };
  }
}
/** What an approval card says: "Run npm install", "Edit app.js". */
function describeAsk(name, input = {}) {
  const d = describeTool(name, input);
  if (name === 'Bash' || name === 'PowerShell') return { title: 'Run a command', detail: String(input.command || '').slice(0, 600), note: input.description || '' };
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return { title: `${name === 'Write' ? 'Write' : 'Edit'} ${base(input.file_path)}`, detail: String(input.file_path || ''), note: '' };
  if (name === 'WebFetch') return { title: 'Open a web page', detail: String(input.url || ''), note: '' };
  const t = String(name || '').replace(/^mcp__leafdeck__/, '');
  if (LEAFDECK_ASKS[t]) {
    const what = input.url || input.key || input.text || input.value || input.script || input.name || '';
    return { title: LEAFDECK_ASKS[t], detail: [input.window && `In: ${input.window}`, what && String(what).slice(0, 400)].filter(Boolean).join('\n'), note: '' };
  }
  return { title: d.text, detail: JSON.stringify(input).slice(0, 400), note: '' };
}

/* ---------------- what Claude Code says about itself ---------------- */

function pickInfo(r = {}) {
  return {
    version: r.claude_code_version || null,
    account: r.account ? { email: r.account.email || '', plan: r.account.subscriptionType || '', org: r.account.organization || '' } : null,
    models: (r.models || []).map((m) => ({ value: m.value, name: m.displayName || m.value, description: m.description || '', efforts: m.supportedEffortLevels || [], auto: !!m.supportsAutoMode })),
    commands: (r.commands || []).map((c) => ({ name: c.name, description: String(c.description || '').slice(0, 240), hint: c.argumentHint || '', builtin: !!c.builtin, aliases: c.aliases || [] })),
    agents: (r.agents || []).map((a) => a.name),
    outputStyle: r.output_style || 'default',
  };
}
function saveInfo(info) {
  lastInfo = info;
  try {
    if (deps.infoCache) fs.writeFileSync(deps.infoCache, JSON.stringify(info));
  } catch {}
}
function info(id) {
  const s = id && sessions.get(id);
  if (s?.info) return s.info;
  if (!lastInfo && deps.infoCache) {
    try {
      lastInfo = JSON.parse(fs.readFileSync(deps.infoCache, 'utf8'));
    } catch {}
  }
  return lastInfo;
}

/** A tool's input as the transcript keeps it: long strings (a whole file written, a big edit) are clipped. */
function keepInput(input) {
  const clip = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}\n… (${v.length - n} more characters)` : v);
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') out[k] = clip(v, 24000);
    else if (Array.isArray(v) && k === 'edits') out[k] = v.slice(0, 40).map((e) => ({ old_string: clip(e?.old_string, 8000), new_string: clip(e?.new_string, 8000), replace_all: !!e?.replace_all }));
    else if (Array.isArray(v) || (v && typeof v === 'object')) {
      const j = JSON.stringify(v);
      out[k] = j.length > 24000 ? clip(j, 24000) : v;
    } else out[k] = v;
  }
  return out;
}

/* ---------------- sessions ---------------- */

function emit(id, ev) {
  if (ev.t === 'state' && sessions.has(id)) saveLive(sessions.get(id));
  deps.send('agentchat:event', { id, ev });
}
function record(id, entry) {
  const e = { at: Date.now(), ...entry };
  appendLog(id, e);
  emit(id, e);
}

function status(id) {
  const s = sessions.get(id);
  const meta = readMeta(id);
  return {
    running: !!s?.child,
    busy: !!s?.busy,
    pending: s ? [...s.pending.values()] : [],
    sessionId: meta.claude || null,
    model: s?.model || meta.model || null,
    // What the chat picked (pickable chats): the permission mode it runs in now, the model and effort it asked for.
    mode: s?.mode || meta.mode || null,
    pick: { model: meta.pickModel || null, effort: meta.effort || null },
    // Ultracode (Claude orchestrates multi-agent workflows for the whole session): whether it's on in the process (or
    // asked for its next start), and whether this account and model offer it (null until a Claude Code has said).
    ultracode: { on: s?.child && s.ultracode ? s.ultracode.on : !!meta.ultracode, available: s?.ultracode ? s.ultracode.available : null },
    queue: s ? s.queue.map((q) => ({ qid: q.qid, text: q.text, images: q.images.length })) : [],
    context: s?.context || meta.context || null,
    cwd: s?.cwd || null,
    // Claude Code's guess at your next message, after a turn (the composer shows it until you type or send).
    suggestion: s?.suggestion || null,
  };
}

function ensure(id) {
  let s = sessions.get(id);
  if (s?.child) return s;
  const exe = deps.claudeExe();
  if (!exe) throw new Error('Claude Code isn’t installed. Install it from App Builder first.');
  const L = deps.launch(id);
  const { cwd } = L;
  let extra = [...(L.args || [])];
  let mode = L.mode || 'acceptEdits';
  const meta = readMeta(id);
  if (L.pickable) {
    // The chat's own picks win over the launch's defaults (Settings → Claude).
    if (MODES.includes(meta.mode)) mode = meta.mode;
    if (meta.pickModel) {
      const i = extra.indexOf('--model');
      if (i >= 0) extra.splice(i, 2);
      extra.push('--model', meta.pickModel);
    }
    if (EFFORTS.includes(meta.effort)) extra.push('--effort', meta.effort);
    // Ultracode lasts as long as the process: a chat that asked for it starts with it again.
    if (meta.ultracode === true) extra.push('--settings', JSON.stringify({ ultracode: true }));
  }
  // Pickable chats (the Claude Code app) get a suggested next message after each turn, like the terminal (a
  // `prompt_suggestion` message; the flag needs print mode with stream-json output, which this is).
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...(L.pickable ? ['--prompt-suggestions'] : []), '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--permission-mode', mode, ...(L.askUser ? [] : ['--disallowedTools', 'AskUserQuestion']), ...extra];
  if (meta.claude) args.push('--resume', meta.claude);
  const env = { ...process.env };
  const child = host?.available() ? host.spawn(id, exe, args, { cwd, env }) : spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  // What the last process said about Ultracode holds until this one says (so the toggle doesn't blink on a restart).
  s = newSession(id, child, cwd, { model: meta.model || null, mode, context: meta.context || null, ultracode: s?.ultracode ? { on: meta.ultracode === true, available: s.ultracode.available } : null });
  connect(s);
  s.ctl('initialize')
    .then((r) => {
      s.info = pickInfo(r);
      if (r.current_permission_mode && MODES.includes(r.current_permission_mode)) s.mode = r.current_permission_mode;
      saveInfo(s.info);
      emit(id, { t: 'info', info: s.info });
      emit(id, { t: 'state', ...status(id) });
      if (L.pickable) readUltracode(s);
    })
    .catch(() => {});
  emit(id, { t: 'state', ...status(id) });
  return s;
}

function newSession(id, child, cwd, fields) {
  // seq starts from the time: answers to a request the last Leafdeck made mustn't match one of this Leafdeck's.
  const s = { id, child, cwd, buf: '', busy: false, pending: new Map(), allowAlways: new Set(), live: '', stderr: '', idle: 0, seq: Date.now(), reqs: new Map(), queue: [], info: null, afterTool: new Map(), tools: new Map(), ...fields };
  sessions.set(id, s);
  return s;
}

/** Listens to a session's process, and gives the session its ways of talking to it. */
function connect(s) {
  const { id, child } = s;
  const write = (obj) => {
    try {
      child.stdin.write(JSON.stringify(obj) + '\n');
    } catch {}
  };
  s.write = write;
  // A control request that wants its answer (the response comes back as a control_response with the same id).
  s.ctl = (subtype, extra2 = {}) =>
    new Promise((resolve, reject) => {
      const rid = `ld-${subtype}-${++s.seq}`;
      const timer = setTimeout(() => s.reqs.delete(rid) && reject(new Error('Claude Code didn’t answer')), 20000);
      s.reqs.set(rid, { resolve, reject, timer });
      write({ type: 'control_request', request_id: rid, request: { subtype, ...extra2 } });
    });

  child.stdout.on('data', (d) => {
    s.buf += d;
    let i;
    while ((i = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, i).trim();
      s.buf = s.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        onMessage(s, m);
      } catch (err) {
        console.error('agentchat', err);
      }
      if (!passing(m)) saveLive(s);
    }
  });
  child.stderr.on('data', (d) => (s.stderr = (s.stderr + d).slice(-2000)));
  child.on('error', (err) => record(id, { t: 'error', text: `Couldn’t start Claude Code: ${err.message}` }));
  child.on('exit', (code) => {
    const was = sessions.get(id);
    if (was !== s) return;
    const hosted = !!s.child?.ack;
    s.child = null;
    for (const r of s.reqs.values()) {
      clearTimeout(r.timer);
      r.reject(new Error('Claude Code stopped'));
    }
    s.reqs.clear();
    // Leafdeck quitting or an idle session ending isn't a failure; only report exits nobody asked for.
    if (!s.quiet && (s.busy || (code && code !== 0 && !s.stopping))) {
      const why = s.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      record(id, { t: 'error', text: s.stopping ? 'Stopped.' : `Claude Code stopped unexpectedly${why ? `: ${why}` : '.'}` });
    }
    s.busy = false;
    s.pending.clear();
    if (hosted) forgetLive(id);
    // Messages still waiting for their turn would be lost with the process: they go back to the composer.
    if (s.queue.length) emit(id, { t: 'unqueued', items: s.queue.map((q) => q.text) });
    s.queue = [];
    emit(id, { t: 'state', ...status(id) });
  });
}

/** Leafdeck has just started: every chat whose Claude Code is still running in leafdeckd carries on from where it was. */
async function reattach() {
  const running = host ? await host.list() : null;
  for (const r of running || []) {
    const id = r.key;
    const saved = readJson(() => liveFile(id)) || {};
    const meta = readMeta(id);
    // Also brings back what its Claude Code connects to (the server behind the leafdeck_* tools starts on demand).
    let L = {};
    try {
      L = deps.launch(id);
    } catch {}
    const s = newSession(id, host.child(id), r.cwd, {
      stderr: r.stderr || '',
      busy: !!saved.busy,
      interrupted: !!saved.interrupted,
      restartAfter: !!saved.restartAfter,
      pending: new Map((saved.pending || []).map((a) => [a.requestId, a])),
      allowAlways: new Set(saved.allowAlways || []),
      model: saved.model || meta.model || null,
      mode: saved.mode || meta.mode || 'acceptEdits',
      context: saved.context || meta.context || null,
      ultracode: saved.ultracode || null,
      afterTool: new Map(saved.afterTool || []),
      tools: new Map(saved.tools || []),
      queue: readJson(() => queueFile(id)) || [],
    });
    s.queued = s.queue.map((q) => q.qid).join();
    connect(s);
    try {
      // What it did while Leafdeck was away comes through here, as if it were happening now.
      await host.attach(id, saved.seq || 0);
    } catch (err) {
      console.error('agentchat: reattach', err);
    }
    if (s.child && !s.busy && !s.pending.size) bumpIdle(s);
    if (s.child && L.pickable) readUltracode(s);
  }
}

/** Whether Ultracode is on and offered, from Claude Code itself (get_settings); left as it was when it can't say. */
function readUltracode(s) {
  return s
    .ctl('get_settings')
    .then((r) => {
      const a = r.applied || {};
      s.ultracode = { on: !!a.ultracode, available: !!a.ultracodeAvailable };
    })
    .catch(() => {})
    .then(() => emit(s.id, { t: 'state', ...status(s.id) }));
}

function bumpIdle(s) {
  clearTimeout(s.idle);
  s.idle = setTimeout(() => {
    if (!s.busy && !s.pending.size) stop(s.id, { quiet: true });
  }, IDLE_MS);
}

function onMessage(s, m) {
  const id = s.id;
  // Sub-agent traffic (parent_tool_use_id set) stays out of the main conversation.
  const top = !m.parent_tool_use_id;
  if (m.type === 'control_response') {
    const r = s.reqs.get(m.response?.request_id);
    if (!r) return;
    s.reqs.delete(m.response.request_id);
    clearTimeout(r.timer);
    if (m.response.subtype === 'error') r.reject(new Error(String(m.response.error || 'Claude Code said no')));
    else r.resolve(m.response.response || {});
    return;
  }
  if (m.type === 'system' && m.subtype === 'init') {
    if (m.session_id) writeMeta(id, { claude: m.session_id, model: m.model || null });
    s.model = m.model || s.model;
    if (MODES.includes(m.permissionMode)) s.mode = m.permissionMode;
    emit(id, { t: 'state', ...status(id) });
    return;
  }
  if (m.type === 'system' && m.subtype === 'status') {
    // The permission mode changed (leaving plan mode, or set from here).
    if (MODES.includes(m.permissionMode) && m.permissionMode !== s.mode) {
      s.mode = m.permissionMode;
      emit(id, { t: 'state', ...status(id) });
    }
    if (m.status === 'compacting') emit(id, { t: 'activity', text: 'Compacting the conversation…' });
    return;
  }
  if (m.type === 'system' && m.subtype === 'compact_boundary') return record(id, { t: 'compacted', pre: m.compact_metadata?.pre_tokens || 0 });
  if (m.type === 'prompt_suggestion') {
    const text = typeof m.suggestion === 'string' ? m.suggestion.trim().slice(0, 2000) : '';
    if (!text || s.busy) return;
    s.suggestion = text;
    emit(id, { t: 'suggestion', text });
    return;
  }
  if (m.type === 'system' && m.subtype === 'api_retry') return emit(id, { t: 'activity', text: 'Retrying the connection…' });
  if (m.type === 'system' && m.subtype === 'task_summary' && m.detail) return emit(id, { t: 'activity', text: m.detail });
  if (m.type === 'system' && m.subtype === 'thinking_tokens') return emit(id, { t: 'activity', text: 'Thinking…' });
  if (m.type === 'stream_event' && top) {
    const ev = m.event || {};
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') emit(id, { t: 'activity', text: 'Thinking…' });
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') emit(id, { t: 'activity', text: `Using ${String(ev.content_block.name || 'a tool').replace(/^mcp__\w+?__/, '')}…` });
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
      s.live = '';
      emit(id, { t: 'live-start' });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      s.live += ev.delta.text;
      emit(id, { t: 'live', text: ev.delta.text });
    }
    return;
  }
  if (m.type === 'assistant' && top) {
    // The model this reply came from. A resumed session keeps the model it last ran, whatever the pick says, so the
    // composer shows this rather than the pick.
    const ran = m.message?.model;
    if (ran && !ran.startsWith('<') && ran !== s.model) {
      s.model = ran;
      writeMeta(id, { model: ran });
      emit(id, { t: 'state', ...status(id) });
    }
    for (const block of m.message?.content || []) {
      if (block.type === 'thinking' && block.thinking?.trim()) record(id, { t: 'thinking', text: block.thinking.slice(0, 20000) });
      if (block.type === 'text' && block.text.trim()) record(id, { t: 'assistant', text: block.text });
      // ToolSearch is Claude Code loading its own tools: nothing the user needs to see.
      if (block.type === 'tool_use' && block.name !== 'ToolSearch') {
        const d = describeTool(block.name, block.input);
        s.tools.set(block.id, block.name);
        record(id, { t: 'tool', toolId: block.id, name: block.name, ...d, input: keepInput(block.input) });
      }
    }
    s.live = '';
    return;
  }
  if (m.type === 'user' && top) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const parts = Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }];
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const img = parts.find((p) => p.type === 'image' && p.source?.type === 'base64');
      // Screenshots go to the chat now but aren't saved in the transcript (they're large).
      if (img) emit(id, { t: 'image', toolId: block.tool_use_id, src: `data:${img.source.media_type};base64,${img.source.data}` });
      const declined = text.startsWith('The user declined this in Leafdeck');
      // The full result (clipped), for the Claude Code app's tool cards; the rest show only failures.
      const shown = s.tools.delete(block.tool_use_id);
      if (shown) record(id, { t: 'tool-result', toolId: block.tool_use_id, text: text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length - 8000} more characters)` : text, error: !!block.is_error, declined });
      // A step you declined already shows as "Declined: …".
      if (block.is_error && !declined) record(id, { t: 'tool-error', toolId: block.tool_use_id, text: clipError(text) });
      // Leaving plan mode: the mode the user picked when approving the plan, once Claude Code has switched out of plan.
      const after = s.afterTool.get(block.tool_use_id);
      if (after) {
        s.afterTool.delete(block.tool_use_id);
        if (!block.is_error) setMode(id, after);
      }
    }
    return;
  }
  if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
    const r = m.request;
    const kind = r.tool_name === 'AskUserQuestion' ? 'question' : r.tool_name === 'ExitPlanMode' ? 'plan' : 'permission';
    if (kind === 'permission' && (s.allowAlways.has(r.tool_name) || deps.autoAllow?.(id, r.tool_name, r.input))) return answer(id, m.request_id, 'allow', { input: r.input });
    const ask = { requestId: m.request_id, kind, toolId: r.tool_use_id || null, tool: r.tool_name, input: r.input, ...describeAsk(r.tool_name, r.input) };
    if (kind === 'question') ask.title = 'Answer a question';
    if (kind === 'plan') ask.title = 'Start on its plan';
    s.pending.set(m.request_id, ask);
    emit(id, { t: 'ask', ...ask });
    emit(id, { t: 'state', ...status(id) });
    return;
  }
  if (m.type === 'control_request') {
    // Anything else Claude Code asks the host (hooks, MCP over the control channel): we don't handle it.
    s.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not supported by Leafdeck' } });
    return;
  }
  if (m.type === 'result') {
    s.busy = false;
    writeMeta(id, { at: Date.now() });
    const usage = m.usage ? { input: (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0), output: m.usage.output_tokens || 0 } : null;
    // A turn you stopped ends as an error in Claude Code; here it's just "Stopped".
    if (s.interrupted) record(id, { t: 'done', ok: true, stopped: true });
    else record(id, { t: 'done', ok: !m.is_error, ms: m.duration_ms || 0, cost: m.total_cost_usd || 0, turns: m.num_turns || 0, usage, text: m.is_error ? String(m.result || m.subtype || 'Something went wrong').slice(0, 400) : '' });
    s.interrupted = false;
    // How full the context is now, for the composer's meter.
    s.ctl('get_context_usage')
      .then((r) => {
        s.context = { used: r.totalTokens || 0, max: r.maxTokens || 0, pct: r.percentage || 0 };
        writeMeta(id, { context: s.context });
        emit(id, { t: 'context', ...s.context });
      })
      .catch(() => {});
    // The next message that waited for this turn goes now.
    const next = s.queue.shift();
    if (next) deliver(s, next);
    else if (s.restartAfter) {
      s.restartAfter = false;
      stop(id, { quiet: true });
    }
    emit(id, { t: 'state', ...status(id) });
    if (!next) bumpIdle(s);
  }
}

/* ---------------- sessions started in a terminal ---------------- */
// Claude Code keeps each session as ~/.claude/projects/<the folder, every other character as "-">/<session id>.jsonl.
// The Claude Code app lists the ones you ran in a terminal there and can take one over: its transcript comes in, and
// the chat resumes it (--resume).

const os = require('node:os');
const sessionsDir = (cwd) => path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
const SYSTEM_TEXT = /^\s*<(command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|user-memory-input|task-notification)>/;
function readPart(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(len);
    const n = fs.readSync(fd, b, 0, len, start);
    return b.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
const firstText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');
/** A user message as typed: slash commands as "/name args", Claude Code's own notes left out (null). */
function typed(content) {
  const t = firstText(content);
  const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/.exec(t);
  if (cmd) return `${cmd[1].trim()}${cmd[2]?.trim() ? ` ${cmd[2].trim()}` : ''}`;
  if (!t.trim() || SYSTEM_TEXT.test(t) || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return null;
  return t;
}
/** The terminal sessions in a folder, newest first: [{ id, title, at }]. `skip`: session ids that are Leafdeck's. */
function terminalSessions(cwd, skip = new Set()) {
  const dir = sessionsDir(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f)).map((f) => ({ f, st: fs.statSync(path.join(dir, f)) }));
  } catch {
    return [];
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const { f, st } of files) {
    if (out.length >= 15) break;
    const id = f.slice(0, 36);
    if (skip.has(id) || st.size < 200) continue;
    const file = path.join(dir, f);
    const head = readPart(file, 0, 48 * 1024);
    // Headless sessions (scripts, Leafdeck's own chats) aren't ones to pick up.
    if (/"entrypoint":"sdk/.test(head) || !/"entrypoint":"cli"/.test(head)) continue;
    const tail = st.size > 48 * 1024 ? readPart(file, Math.max(0, st.size - 64 * 1024), 64 * 1024) : head;
    const titles = [...tail.matchAll(/"type":"(?:ai|custom)-title","(?:aiTitle|customTitle)":"((?:[^"\\]|\\.)*)"/g)];
    let title = titles.length ? JSON.parse(`"${titles.at(-1)[1]}"`) : '';
    if (!title) {
      for (const line of head.split('\n')) {
        if (!line.includes('"type":"user"')) continue;
        try {
          const m = JSON.parse(line);
          const t = !m.isMeta && !m.isSidechain && typed(m.message?.content);
          if (t) {
            title = t.replace(/\s+/g, ' ').trim().slice(0, 70);
            break;
          }
        } catch {}
      }
    }
    if (title) out.push({ id, title, at: st.mtimeMs });
  }
  return out;
}
/** Take over a terminal session: its transcript in our format, and the chat resumes it. */
function adopt(id, cwd, sid) {
  if (!/^[0-9a-f-]{36}$/.test(String(sid))) throw new Error('Bad session id');
  const file = path.join(sessionsDir(cwd), `${sid}.jsonl`);
  const log = [];
  const tools = new Set();
  let title = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(m.timestamp) || 0;
    if (m.type === 'ai-title' || m.type === 'custom-title') title = m.customTitle || m.aiTitle || title;
    if (m.isSidechain || m.isMeta) continue;
    if (m.type === 'system' && m.subtype === 'compact_boundary') log.push({ at, t: 'compacted', pre: m.compactMetadata?.preTokens || 0 });
    if (m.type === 'user' && !m.isCompactSummary) {
      const content = m.message?.content;
      const text = typed(content);
      const images = Array.isArray(content) ? content.filter((c) => c?.type === 'image').length : 0;
      if (text || images) log.push({ at, t: 'user', text: (text || '').slice(0, 20000), ...(images ? { images } : {}) });
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type !== 'tool_result' || !tools.has(c.tool_use_id)) continue;
        const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
        const t = parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        log.push({ at, t: 'tool-result', toolId: c.tool_use_id, text: t.length > 8000 ? `${t.slice(0, 8000)}\n… (${t.length - 8000} more characters)` : t, error: !!c.is_error });
      }
    }
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'thinking' && b.thinking?.trim()) log.push({ at, t: 'thinking', text: b.thinking.slice(0, 20000) });
        if (b.type === 'text' && b.text.trim()) log.push({ at, t: 'assistant', text: b.text });
        if (b.type === 'tool_use' && b.name !== 'ToolSearch') {
          tools.add(b.id);
          log.push({ at, t: 'tool', toolId: b.id, name: b.name, ...describeTool(b.name, b.input), input: keepInput(b.input) });
        }
      }
    }
  }
  stop(id, { quiet: true });
  fs.writeFileSync(logFile(id), log.slice(-MAX_LOG).map((e) => JSON.stringify(e)).join('\n') + (log.length ? '\n' : ''));
  writeMeta(id, { claude: sid, at: Date.now(), context: null });
  emit(id, { t: 'cleared' });
  return { title: String(title || '').slice(0, 80) };
}

/* ---------------- API (IPC) ---------------- */

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Images to send with a message: { media_type, data } (pasted) or a path on disk (attached), at most 8, 8 MB each. */
function imagesOf(opts = {}) {
  const out = [];
  for (const im of opts.images || []) if (im && Object.values(IMAGE_TYPES).includes(im.media_type) && typeof im.data === 'string' && im.data.length < 11_000_000) out.push({ media_type: im.media_type, data: im.data });
  for (const p of opts.imagePaths || []) {
    const type = IMAGE_TYPES[path.extname(String(p)).toLowerCase()];
    try {
      if (type && fs.statSync(p).size < 8_000_000) out.push({ media_type: type, data: fs.readFileSync(p).toString('base64') });
    } catch {}
  }
  return out.slice(0, 8);
}
function deliver(s, { text, images, note }) {
  s.busy = true;
  s.interrupted = false;
  s.suggestion = null;
  clearTimeout(s.idle);
  const entry = { at: Date.now(), t: 'user', text: text.slice(0, 20000), ...(images.length ? { images: images.length } : {}) };
  appendLog(s.id, entry);
  // The pictures go to the chat now; the transcript only counts them (they're large).
  emit(s.id, { ...entry, srcs: images.map((im) => `data:${im.media_type};base64,${im.data}`) });
  // opts.note: for Claude only, it isn't shown in the chat (Claude Settings: what's open in the app).
  const said = (note ? `${text}\n\n(${note})` : text).slice(0, 20000);
  const content = images.length ? [{ type: 'text', text: said }, ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } }))] : said;
  s.write({ type: 'user', message: { role: 'user', content } });
}

function send(id, text, opts = {}) {
  const t = String(text || '').trim();
  const images = imagesOf(opts);
  if (!t && !images.length) throw new Error('Type a message first');
  // While Claude works, a message waits for its turn (opts.queue: the Claude Code app; others send one at a time).
  const cur = sessions.get(id);
  // opts.now: it doesn't wait; Claude stops what it's doing and this goes next.
  if (cur?.child && cur.busy && (opts.queue || opts.now)) {
    const q = { qid: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, images };
    cur.queue.push(q);
    if (opts.now) jumpQueue(cur, q);
    emit(id, { t: 'state', ...status(id) });
    return status(id);
  }
  // A conversation left alone long enough starts over (the assistant: Settings → Claude). Claude Code's memory of the
  // user is per folder, not per conversation, so it carries over.
  const fresh = deps.freshMs?.(id) || 0;
  const meta = readMeta(id);
  if (fresh && meta.claude && meta.at && Date.now() - meta.at > fresh && !sessions.get(id)?.busy) clear(id);
  const s = ensure(id);
  writeMeta(id, { at: Date.now() });
  deliver(s, { text: t, images, note: opts.note });
  emit(id, { t: 'state', ...status(id) });
  return status(id);
}

/** A queued message taken back before its turn came. */
function dequeue(id, qid) {
  const s = sessions.get(id);
  if (!s) return null;
  const q = s.queue.find((x) => x.qid === qid);
  s.queue = s.queue.filter((x) => x.qid !== qid);
  emit(id, { t: 'state', ...status(id) });
  return q ? q.text : null;
}

/** A queued message sent now: it moves to the front, and the turn under way stops so it goes as soon as Claude has. */
function sendNow(id, qid) {
  const s = sessions.get(id);
  const q = s?.queue.find((x) => x.qid === qid);
  if (!q) return s ? status(id) : null;
  if (!s.child || !s.busy) {
    s.queue = s.queue.filter((x) => x !== q);
    if (s.child) deliver(s, q);
  } else jumpQueue(s, q);
  emit(id, { t: 'state', ...status(id) });
  return status(id);
}
function jumpQueue(s, q) {
  s.queue = [q, ...s.queue.filter((x) => x !== q)];
  // What Claude was waiting on you for is declined: the turn ends with the interrupt (the result delivers the queue).
  for (const reqId of [...s.pending.keys()]) answer(s.id, reqId, 'deny', { feedback: 'The user sent a new message instead.' });
  if (!s.interrupted) interrupt(s.id);
}

/**
 * Answer what Claude asked. decision 'allow' | 'deny'; extra.always: allow this tool for the rest of the conversation;
 * extra.answers: { question: label(s) } for AskUserQuestion; extra.mode: the permission mode to work in after an
 * approved plan; extra.feedback: what to tell Claude with a "no" (keep planning, do it differently).
 */
function answer(id, requestId, decision, { input, always, answers, mode, feedback } = {}) {
  const s = sessions.get(id);
  if (!s?.child) throw new Error('That session has ended');
  const ask = s.pending.get(requestId);
  s.pending.delete(requestId);
  if (always && ask) s.allowAlways.add(ask.tool);
  const allow = decision === 'allow';
  const fb = String(feedback || '').trim().slice(0, 4000);
  let response;
  if (allow && ask?.kind === 'question') response = { behavior: 'allow', updatedInput: { ...ask.input, answers: answers && typeof answers === 'object' ? answers : {} } };
  else if (allow) response = { behavior: 'allow', updatedInput: input || ask?.input || {} };
  else if (ask?.kind === 'plan') response = { behavior: 'deny', message: fb ? `The user wants to keep planning. Their feedback: ${fb}` : 'The user wants to keep planning. Ask them what to change.' };
  else if (ask?.kind === 'question') response = { behavior: 'deny', message: fb ? `The user skipped the question and said: ${fb}` : 'The user skipped the question. Continue with your best judgment, or ask in plain text.' };
  else response = { behavior: 'deny', message: fb ? `The user declined this in Leafdeck and said: ${fb}` : 'The user declined this in Leafdeck. Ask them what they’d like instead.' };
  s.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  if (allow && ask?.kind === 'plan' && MODES.includes(mode) && ask.toolId) s.afterTool.set(ask.toolId, mode);
  if (ask) record(id, { t: 'answer', allow, kind: ask.kind || 'permission', title: ask.title, ...(ask.kind === 'question' && allow ? { answers } : {}), ...(ask.kind === 'plan' ? { plan: String(ask.input?.plan || '').slice(0, 20000), mode: allow ? mode || null : null, feedback: fb } : {}) });
  emit(id, { t: 'state', ...status(id) });
  return true;
}

/** The permission mode, now (a running session switches at once) and for the next start. */
function setMode(id, mode) {
  if (!MODES.includes(mode)) throw new Error('Unknown permission mode');
  writeMeta(id, { mode });
  const s = sessions.get(id);
  if (s?.child) {
    s.mode = mode;
    s.ctl('set_permission_mode', { mode }).catch((err) => record(id, { t: 'error', text: `Couldn’t switch modes: ${err.message}` }));
  }
  emit(id, { t: 'state', ...status(id) });
  return status(id);
}
/** A chat's own model, effort and Ultracode (pickable chats). The model and Ultracode switch at once; effort on the next
 * start, which is now for a session that's idle (it resumes the same conversation). */
function setPicks(id, { model, effort, mode, ultracode } = {}) {
  const s = sessions.get(id);
  if (model !== undefined) {
    const m = model ? String(model).slice(0, 80) : null;
    writeMeta(id, { pickModel: m });
    // Another model may not offer Ultracode: ask again once it's switched.
    if (s?.child) s.ctl('set_model', { model: m || 'default' }).then(() => (readUltracode(s), s.ctl('get_context_usage'))).then((r) => {
      s.context = { used: r.totalTokens || 0, max: r.maxTokens || 0, pct: r.percentage || 0 };
      emit(id, { t: 'context', ...s.context });
    }).catch((err) => record(id, { t: 'error', text: `Couldn’t switch models: ${err.message}` }));
  }
  if (effort !== undefined) {
    writeMeta(id, { effort: EFFORTS.includes(effort) ? effort : null });
    if (s?.child) {
      if (s.busy || s.pending.size) s.restartAfter = true;
      else stop(id, { quiet: true });
    }
  }
  if (typeof ultracode === 'boolean') {
    writeMeta(id, { ultracode });
    if (s?.child) {
      if (s.ultracode) s.ultracode = { ...s.ultracode, on: ultracode };
      s.ctl('apply_flag_settings', { settings: { ultracode } })
        .catch((err) => record(id, { t: 'error', text: `Couldn’t turn Ultracode ${ultracode ? 'on' : 'off'}: ${err.message}` }))
        .then(() => readUltracode(s));
    }
  }
  if (mode !== undefined) return setMode(id, mode);
  emit(id, { t: 'state', ...status(id) });
  return status(id);
}

/** A short title for the conversation, written by Claude Code from what it's about (as the desktop app names
 * sessions). Null when it can't. */
async function title(id, description) {
  const s = sessions.get(id);
  if (!s?.child) return null;
  try {
    const r = await s.ctl('generate_session_title', { description: String(description || '').slice(0, 2000), persist: true });
    return typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** Start Claude Code without a message (the models, commands and account come with it). */
function warm(id) {
  const s = ensure(id);
  if (!s.busy) bumpIdle(s);
  return { ...status(id), info: s.info || info() };
}

function interrupt(id) {
  const s = sessions.get(id);
  if (!s?.child) return false;
  s.interrupted = true;
  saveLive(s);
  s.write({ type: 'control_request', request_id: `ld-int-${Date.now()}`, request: { subtype: 'interrupt' } });
  return true;
}

function stop(id, { quiet } = {}) {
  const s = sessions.get(id);
  if (!s?.child) return false;
  s.stopping = !quiet;
  s.quiet = !!quiet;
  try {
    s.child.stdin.end();
  } catch {}
  const child = s.child;
  setTimeout(() => {
    try {
      if (child.exitCode == null) child.kill();
    } catch {}
  }, 1500);
  return true;
}

function history(id) {
  return { log: readLog(id), ...status(id), info: info(id), live: sessions.get(id)?.live || '' };
}

function clear(id) {
  stop(id, { quiet: true });
  try {
    fs.rmSync(logFile(id), { force: true });
  } catch {}
  writeMeta(id, { claude: null });
  emit(id, { t: 'cleared' });
  return true;
}

/** The session id, for "Open in terminal" (the chat process is stopped first so they don't both run). */
function handoff(id) {
  stop(id, { quiet: true });
  return readMeta(id).claude || null;
}

function stopAll() {
  for (const id of sessions.keys()) stop(id, { quiet: true });
}

/** Leafdeck is about to restart. Chats in leafdeckd carry on. One running here can't: left alone it would keep working
 * with nobody listening, so it stops now, and resumes the conversation on its next message. */
function beforeRestart() {
  for (const s of sessions.values()) {
    if (!s.child) continue;
    if (s.child.ack) saveLive(s);
    else {
      if (s.busy) appendLog(s.id, { at: Date.now(), t: 'error', text: 'Stopped when Leafdeck restarted.' });
      s.quiet = true;
      s.child.kill();
    }
  }
}

function useHost(h) {
  host = h;
}

/** Settings changed: sessions that aren't doing anything stop now and start again (with the new settings, resuming
 * the same conversation) on their next message. A busy one picks them up when it next starts. */
function restartIdle() {
  for (const s of sessions.values()) if (s.child && !s.busy && !s.pending.size) stop(s.id, { quiet: true });
}

function init(d) {
  deps = d;
}

module.exports = { init, useHost, reattach, beforeRestart, send, answer, interrupt, stop, history, clear, handoff, status, stopAll, restartIdle, dequeue, sendNow, setMode, setPicks, warm, info, title, terminalSessions, adopt, sessionsDir, meta: readMeta };
