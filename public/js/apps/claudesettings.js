// Claude Settings: everything that shapes how Claude Code behaves, in one place, with a prompt to have Claude change it.
// The left side is what's there: what a session reads and what it costs, instructions, memory, skills, agents and
// commands, permissions, hooks, connections, behavior, and a history of every change with its diff and an Undo. The right
// side is a chat with Claude, which works on those files and knows what's open here (createChat's opts.note).
// The main-process half is electron/claudeconfig.cjs: it reads the files, asks Claude Code what it would load, keeps the
// history, and never hands this page a connection's secrets.
import { esc, $, $$ } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, openApp, toast, mergeTitleBar } from '../wm.js';
import { shell } from '../shell.js';
import { createChat, listen } from '../agentchat.js';
import { confirmDialog, ask } from '../dialogs.js';
import { editHtml, addedHtml, editCounts } from '../claudecode/diff.js';

const CS = shell?.claudeSettings;
const supported = !!CS && !!shell?.agentChat;
const CHAT = '@claudesettings';

const PAGES = [
  ['overview', 'What Claude reads', 'eye'],
  ['instructions', 'Instructions', 'note'],
  ['memory', 'Memory', 'bookmark'],
  ['skills', 'Skills', 'sparkle'],
  ['agents', 'Agents & commands', 'users'],
  ['permissions', 'Permissions', 'shield'],
  ['hooks', 'Hooks', 'bolt'],
  ['connections', 'Connections', 'link'],
  ['behavior', 'Behavior', 'sliders'],
  ['history', 'History', 'clock'],
];
const SCOPES = {
  user: ['You, everywhere', 'Every session, in every folder'],
  project: ['This project, shared', 'Anyone with this project gets it, if the file is checked in'],
  local: ['This project, just you', 'Only you, only here'],
};
const SKILL_STATES = [
  ['on', 'On'],
  ['name-only', 'Name only'],
  ['user-invocable-only', 'Only when you type it'],
  ['off', 'Off'],
];
const MODES = [
  ['', 'Not set'],
  ['default', 'Ask before changing anything'],
  ['acceptEdits', 'Make edits without asking'],
  ['plan', 'Plan first, change nothing'],
  ['auto', 'Auto'],
  ['dontAsk', 'Only what the rules allow'],
  ['bypassPermissions', 'Never ask'],
];
const BEHAVIORS = [
  ['deny', 'Never', 'Claude can’t do these, whatever else is allowed.'],
  ['ask', 'Ask first', 'Claude always asks, even where something broader is allowed.'],
  ['allow', 'Without asking', 'Claude does these without asking.'],
];

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
const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const tokens = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const baseName = (p) => String(p || '').split('/').pop();
function when(t) {
  const d = new Date(t);
  const same = d.toDateString() === new Date().toDateString();
  return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const app = {
  id: 'claudesettings',
  name: 'Claude Settings',
  icon: 'sliders',
  color: 'orange',
  size: [1220, 780],
  min: [980, 540],
  hidden: !supported,
  openTab(win, tab) {
    win.claudeSettings?.go(tab);
  },
  canClose(win) {
    return win.claudeSettings?.leave() ?? true;
  },
  mount(win) {
    const S = {
      page: store.get('claudesettings.page', 'overview'),
      folder: store.get('claudesettings.folder', ''),
      scope: 'user',
      state: null,
      probe: null,
      probing: false,
      probeError: '',
      history: [],
      undone: [], // what they undid since their last message, for Claude's note
      file: null, // the file open in the editor: { path, kind, exists, text, draft, label }
      builtins: null,
      about: null,
      latest: null, // the change the banner is about
    };
    win.body.innerHTML = `<div class="cs">
      <nav class="cs-nav">
        <div class="cs-lights win-drag"></div>
        ${PAGES.map(([id, label, ic]) => `<button class="set-nav-item" data-go="${id}">${icon(ic, 15)}<span>${esc(label)}</span></button>`).join('')}
      </nav>
      <div class="cs-main">
        <div class="cs-bar win-drag">
          <b class="cs-title"></b><span class="grow"></span>
          <label class="cs-folder no-drag" title="Which folder to look at. Your own instructions and settings apply everywhere.">${icon('folder', 13)}<select aria-label="Folder"></select></label>
          <button class="tb-btn no-drag" data-act="refresh" title="Look again">${icon('refresh', 14)}</button>
          <button class="tb-btn no-drag" data-act="toggle-chat" title="Show or hide Claude">${icon('claude', 14)}</button>
        </div>
        <div class="cs-banner" hidden></div>
        <div class="cs-page"></div>
      </div>
      <aside class="cs-chat"></aside>
    </div>`;
    const root = $('.cs', win.body);
    const pageEl = $('.cs-page', root);
    const bannerEl = $('.cs-banner', root);
    mergeTitleBar(win, $('.cs-lights', root));
    root.classList.toggle('nochat', store.get('claudesettings.nochat', false));

    const fail = (err) => toast(clean(err), 'error');
    const tilde = (p) => (S.state?.home && String(p).startsWith(`${S.state.home}/`) ? `~${p.slice(S.state.home.length)}` : String(p));
    const dirty = () => !!S.file && S.file.draft !== S.file.text;
    const pageName = () => PAGES.find(([id]) => id === S.page)?.[1] || '';

    /* ---------------- the prompt ---------------- */

    const chat = createChat(CHAT, {
      emptyIcon: '<img class="cl-logo" src="/img/claude.png" alt="" draggable="false">',
      text: {
        title: 'Claude',
        placeholder: 'Tell Claude what to change…',
        emptyTitle: 'What should be different?',
        emptyText: 'Say it the way you’d say it to a person: “keep your answers short”, “never push without asking”, “stop suggesting that skill”. Claude finds the right place and makes the change, and you can see exactly what changed and undo it.',
        suggestions: ['Review my instructions for anything that conflicts or is out of date', 'What takes up the most room at the start of a session, and what could go?', 'Which of my skills and memories look out of date?'],
        clearConfirm: 'Start a new conversation? Claude won’t remember this one. The changes it made stay, and they stay in the History.',
        terminal: false,
      },
      noAlways: true,
      note: () => {
        const what = S.file ? `the file ${S.file.path}${dirty() ? ' (with edits the user hasn’t saved)' : ''}` : `the ${pageName()} page`;
        const undone = S.undone.length ? ` Since your last message they pressed Undo on: ${S.undone.join('; ')}, so those files are as they were before that change.` : '';
        S.undone = [];
        return `Open in the app: ${what}. Looking at: ${S.folder ? `the folder ${S.folder}` : 'everywhere, no one folder'}.${undone}`;
      },
    });
    chat.el.classList.add('cl-chat');
    $('.cs-chat', root).append(chat.el);
    /** Start a message for them to finish, in the prompt. */
    function prefill(text) {
      root.classList.remove('nochat');
      store.set('claudesettings.nochat', false);
      const ta = $('textarea', chat.el);
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
    }

    /* ---------------- loading ---------------- */

    async function loadState() {
      try {
        S.state = await CS.state(S.folder);
      } catch {
        S.folder = ''; // a folder that's gone
        store.set('claudesettings.folder', '');
        S.state = await CS.state('');
      }
      if (!S.folder || !S.state.settings[S.scope]) S.scope = 'user';
      const sel = $('.cs-folder select', root);
      sel.innerHTML = `<option value="">Everywhere</option>${S.state.folders.map((f) => `<option value="${esc(f.path)}" ${f.path === S.folder ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}`;
    }
    async function loadProbe(force) {
      const folder = S.folder;
      S.probing = true;
      S.probeError = '';
      if (!S.file) draw();
      try {
        const p = await CS.probe(folder, !!force);
        if (folder !== S.folder) return;
        S.probe = p;
      } catch (err) {
        if (folder !== S.folder) return;
        S.probe = null;
        S.probeError = clean(err);
      }
      S.probing = false;
      // Not over something being typed in the page. The prompt beside it is out of the way.
      const active = document.activeElement;
      if (!S.file && !(pageEl.contains(active) && active.matches('input, textarea, select'))) draw();
    }
    async function refresh(force) {
      await loadState();
      S.history = await CS.history();
      draw();
      loadProbe(force);
    }

    /* ---------------- pages ---------------- */

    const card = (rows) => `<div class="set-group cs-group">${rows.join('')}</div>`;
    const empty = (text) => `<div class="cs-none">${esc(text)}</div>`;
    const lead = (text) => `<p class="cs-lead">${esc(text)}</p>`;
    const sub = (text, right = '') => `<div class="cs-sub"><span>${esc(text)}</span>${right}</div>`;
    const asks = (label, text) => `<button class="chip-btn" data-prefill="${esc(text)}">${icon('claude', 12)} ${esc(label)}</button>`;
    const size = (f) => (f.exists ? `<span class="cs-num" title="About this many tokens, every time it’s read">${tokens(f.tokens)}</span>` : '<span class="cs-num cs-faint">Not created</span>');
    const fileRow = (f, title, desc, right = size(f)) => `<button class="cs-row" data-open="${esc(f.path)}" data-label="${esc(title)}"><span class="cs-row-text"><b>${esc(title)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</span>${right}${icon('right', 13)}</button>`;
    const scopeBar = () => {
      const list = S.folder ? ['user', 'project', 'local'] : ['user'];
      return `<div class="cs-scopes" role="tablist">${list.map((s) => `<button class="${s === S.scope ? 'on' : ''}" data-scope="${s}" title="${esc(SCOPES[s][1])}">${esc(SCOPES[s][0])}</button>`).join('')}</div>${S.folder ? '' : '<p class="cs-hint">Pick a folder at the top to set something for just one project.</p>'}`;
    };
    const scopeFile = () => S.state.settings[S.scope];
    const brokenFile = (f) => (f?.error ? `<div class="cs-warn">${icon('flag', 14)}<span><b>${esc(tilde(f.path))} has a mistake in it</b>, so Claude Code ignores it and nothing here can change it until it’s fixed. ${esc(f.error)}</span><button class="btn small" data-open="${esc(f.path)}">Open</button></div>` : '');

    const PAGE = {
      overview() {
        const p = S.probe;
        if (!p) return `${lead('Everything Claude takes in before you say a word. Less here leaves more room for your work.')}${S.probeError ? `<div class="cs-warn">${icon('flag', 14)}<span>${esc(S.probeError)}</span></div>` : '<div class="cs-none">Asking Claude Code what a session here would load…</div>'}`;
        const cats = [...p.categories].filter((c) => !c.deferred).sort((a, b) => b.tokens - a.tokens);
        const start = cats.reduce((t, c) => t + c.tokens, 0);
        const groups = { User: 'Your instructions', Project: 'This project', AutoMem: 'Memory', Local: 'Just you, this project' };
        const files = [...p.memoryFiles].sort((a, b) => b.tokens - a.tokens);
        return `${lead('Everything Claude takes in before you say a word. Less here leaves more room for your work.')}
          <div class="cs-summary"><b>${tokens(start)}</b> tokens at the start of a session${p.max ? ` (${Math.max(1, Math.round((start / p.max) * 100))}% of ${tokens(p.max)})` : ''}. ${p.version ? `Claude Code ${esc(p.version)}.` : ''}</div>
          ${sub('The parts')}
          ${card(cats.map((c) => `<div class="cs-row cs-static"><span class="cs-row-text"><b>${esc(c.name)}</b></span><span class="cs-num">${tokens(c.tokens)}</span></div>`))}
          ${sub('Files it reads')}
          ${files.length ? card(files.map((f) => fileRow({ ...f, exists: true }, tilde(f.path), groups[f.type] || f.type))) : empty('No instruction files here yet.')}
          ${sub('Have Claude look')}
          <div class="cs-actions">${asks('What could go?', 'What’s taking up the most room at the start of a session, and what could I cut?')}${asks('Move rarely used instructions out', 'Which instructions are only needed sometimes? Suggest moving them into skills so they load only when needed.')}</div>`;
      },
      instructions() {
        const list = S.state.instructions;
        const you = list.filter((f) => f.group === 'you');
        const here = list.filter((f) => f.group === 'folder');
        const about = S.about;
        const builtins = S.builtins || [];
        return `${lead('What you tell Claude to do, in plain language. New sessions read these; a session that’s already running keeps what it started with.')}
          ${sub('Everywhere', `<button class="btn small" data-create="rule" data-global="1">${icon('plus', 12)} New rule</button>`)}
          ${card(you.map((f) => fileRow(f, f.label, f.hint)))}
          ${
            S.folder
              ? `${sub(`In ${baseName(S.folder)}`, `<button class="btn small" data-create="rule">${icon('plus', 12)} New rule</button>`)}${card(here.map((f) => fileRow(f, f.label, f.hint)))}`
              : `<p class="cs-hint">Pick a folder at the top to see a project’s own instructions.</p>`
          }
          ${sub('About you, in Leafdeck')}
          <div class="set-group cs-group cs-about"><textarea data-about rows="3" placeholder="Who you are, what you work on, how you like answers…">${esc(about?.instructions || '')}</textarea><small>Only the Claude button reads this, at the start of each conversation. It’s the same note as in Settings → Claude.</small></div>
          ${
            builtins.length
              ? `${sub('Built into Leafdeck')}<div class="set-group cs-group">${builtins.map((b) => `<details class="set-details cs-builtin"><summary>${esc(b.name)}</summary><pre>${esc(b.text)}</pre></details>`).join('')}</div>`
              : ''
          }`;
      },
      memory() {
        const m = S.state.memory;
        const auto = S.state.settings[S.folder ? 'local' : 'user']?.data?.autoMemoryEnabled;
        const off = auto === false || S.probe?.autoMemory?.enabled === false;
        return `${lead('What Claude has written down to remember between sessions, kept per folder. It reads the index every time, and a memory when it seems relevant.')}
          ${S.folder ? '' : '<p class="cs-hint">This is the memory for your home folder. Pick a folder at the top to see that folder’s.</p>'}
          ${card([`<div class="cs-row cs-static"><span class="cs-row-text"><b>Claude keeps memory</b><small>Off: Claude neither reads nor writes it${S.folder ? ', in this folder' : ''}. What’s written stays.</small></span><label class="switch"><input type="checkbox" data-automem ${off ? '' : 'checked'}><span></span></label></div>`])}
          ${sub(`${m.files.length} ${m.files.length === 1 ? 'file' : 'files'}`)}
          ${m.files.length ? card(m.files.map((f) => fileRow(f, f.name, f.description, `${f.type ? `<span class="pill">${esc(f.type)}</span>` : ''}${size(f)}`))) : empty('Nothing remembered here yet.')}`;
      },
      skills() {
        const p = S.probe;
        const scope = S.folder ? 'local' : 'user';
        const overrides = S.state.settings[scope]?.data?.skillOverrides || {};
        const list = p
          ? p.skills
          : S.state.skills.map((s) => ({ name: s.name, display: s.name, description: s.description, source: s.group === 'folder' ? 'project' : 'user', tokens: s.tokens, state: overrides[s.name] || 'on', path: s.path, kind: s.kind, locked: '' }));
        const label = (src) => ({ user: 'Yours', project: 'This project', plugin: 'From plugins', 'claude.ai sync': 'From claude.ai', bundled: 'Built into Claude Code', builtin: 'Built into Claude Code' })[src] || src || 'Other';
        const groups = new Map();
        for (const s of list) (groups.get(label(s.source)) || groups.set(label(s.source), []).get(label(s.source))).push(s);
        // Claude Code's own total when it's said (it counts more than the descriptions), so this agrees with the first page.
        const total = p?.categories.find((c) => c.id === 'skills')?.tokens ?? list.filter((s) => s.state !== 'off' && s.state !== 'user-invocable-only').reduce((t, s) => t + (s.tokens || 0), 0);
        const row = (s) => `<div class="cs-row cs-static cs-skill">
            ${s.kind ? `<button class="cs-row-text cs-link" data-open="${esc(s.path)}" data-label="${esc(s.display)}">` : '<span class="cs-row-text">'}<b>${esc(s.display)}</b><small title="${esc(s.description)}">${esc(s.description)}</small>${s.kind ? '</button>' : '</span>'}
            <span class="cs-num" title="About this many tokens of its description in every session">${tokens(s.tokens)}</span>
            ${s.locked ? `<span class="pill" title="${esc(s.locked)}">Locked</span>` : `<select data-skill="${esc(s.name)}" aria-label="${esc(s.display)}">${SKILL_STATES.map(([v, l]) => `<option value="${v}" ${s.state === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`}
          </div>`;
        return `${lead('Things Claude knows how to do, used when they fit. Each one’s description is read in every session, and the rest only when it’s used.')}
          <div class="cs-summary"><b>${tokens(total)}</b> tokens in every session from ${list.length} skills. Changes here apply ${S.folder ? `in ${esc(baseName(S.folder))}, just for you` : 'everywhere'}.</div>
          <div class="cs-actions"><button class="btn small" data-create="skill">${icon('plus', 12)} New skill</button>${asks('Write one with Claude', 'I’d like a new skill that ')}${asks('Which don’t I need?', 'Which of my skills look like I don’t need them? Don’t change anything yet.')}</div>
          ${p || !S.probing ? '' : '<div class="cs-none">Asking Claude Code for the full list…</div>'}
          ${[...groups].map(([name, rows]) => `${sub(name)}${card(rows.map(row))}`).join('') || empty('No skills found.')}`;
      },
      agents() {
        const a = S.state.agents;
        const c = S.state.commands;
        const own = new Set(a.map((x) => x.name));
        const built = (S.probe?.agents || []).filter((x) => !own.has(x.name));
        const row = (f) => fileRow(f, f.name, f.description, `${f.group === 'folder' ? '<span class="pill">This project</span>' : ''}${size(f)}`);
        return `${lead('Agents are specialists Claude can hand part of a job to. Commands are prompts you start by typing their name after a slash.')}
          ${sub('Your agents', `<button class="btn small" data-create="agent">${icon('plus', 12)} New agent</button>`)}
          ${a.length ? card(a.map(row)) : empty('None yet.')}
          ${sub('Your commands')}
          ${c.length ? card(c.map(row)) : empty('None yet.')}
          <div class="cs-actions">${asks('Make an agent with Claude', 'I’d like an agent that ')}${asks('Make a command with Claude', 'I’d like a slash command that ')}</div>
          ${built.length ? `${sub('Available in every session')}${card(built.map((x) => `<div class="cs-row cs-static"><span class="cs-row-text"><b>${esc(x.name)}</b><small>${esc(x.description.slice(0, 220))}</small></span></div>`))}` : ''}`;
      },
      permissions() {
        const f = scopeFile();
        const perms = f.data.permissions || {};
        const mode = perms.defaultMode || '';
        const modes = MODES.some(([v]) => v === mode) ? MODES : [...MODES, [mode, mode]];
        return `${lead('What Claude may do without asking. “Never” wins over “Ask first”, which wins over “Without asking”, wherever they’re set.')}
          ${scopeBar()}${brokenFile(f)}
          ${card([`<div class="cs-row cs-static"><span class="cs-row-text"><b>When a session starts</b><small>For Claude Code in a terminal. Leafdeck’s own chats follow Settings → Claude and the chat’s own picker.</small></span><select data-mode>${modes.map(([v, l]) => `<option value="${esc(v)}" ${v === mode ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`])}
          ${BEHAVIORS.map(([b, label, hint]) => {
            const rules = Array.isArray(perms[b]) ? perms[b] : [];
            return `${sub(label)}<p class="cs-hint">${esc(hint)}</p>${rules.length ? card(rules.map((r, i) => `<div class="cs-row cs-static"><code class="cs-rule">${esc(r)}</code><button class="tb-btn" data-rule-remove="${b}:${i}" title="Remove">${icon('x', 13)}</button></div>`)) : empty('None.')}`;
          }).join('')}
          ${sub('Add a rule')}
          <form class="cs-add" data-rule-form>
            <select name="behavior">${BEHAVIORS.map(([b, l]) => `<option value="${b}">${esc(l)}</option>`).join('')}</select>
            <input name="rule" placeholder="Bash(git push:*)" spellcheck="false" aria-label="Rule">
            <button class="btn small primary">Add</button>
          </form>
          <div class="cs-actions">${asks('Describe it instead', 'From now on, ')}${asks('Check these', 'Look over my permission rules. Is anything riskier than it looks, or redundant? Don’t change anything yet.')}</div>`;
      },
      hooks() {
        const hooks = S.state.hooks;
        const broken = Object.values(S.state.settings).map(brokenFile).join('');
        return `${lead('Things that happen automatically at points in a session, every time, without Claude deciding to. Hooks run commands on this computer with your permissions, so read one before you keep it.')}
          ${broken}
          ${hooks.length ? card(hooks.map((h) => `<div class="cs-row cs-static cs-hook"><span class="cs-row-text"><b>${esc(h.event)}${h.matcher ? ` <span class="cs-faint">on ${esc(h.matcher)}</span>` : ''}</b><code>${esc(h.what)}</code><small>${esc(SCOPES[h.scope][0])}</small></span><button class="tb-btn" data-hook="${esc(h.scope)}|${esc(h.event)}|${h.group}|${h.index}" title="Remove">${icon('x', 13)}</button></div>`)) : empty('No hooks.')}
          <div class="cs-actions">${asks('Add one with Claude', 'Whenever ')}</div>`;
      },
      connections() {
        const list = S.state.connections;
        const scope = { user: 'Everywhere', local: 'This project, just you', project: 'This project, shared' };
        return `${lead('Other services and programs Claude can use (MCP servers). Keys and tokens are never shown here.')}
          ${list.length ? card(list.map((c) => `<div class="cs-row cs-static cs-hook"><span class="cs-row-text"><b>${esc(c.name)}</b><code>${esc(c.what)}</code><small>${esc(scope[c.scope] || c.scope)} · ${esc(c.transport)}${c.secrets.length ? ` · has its own ${esc(c.secrets.join(', '))} (hidden)` : ''}</small></span></div>`)) : empty('No connections here.')}
          <p class="cs-hint">Claude’s connections from your claude.ai account aren’t listed here: those are in your account’s settings. Changes to connections aren’t in the History; removing one means adding it back.</p>
          <div class="cs-actions">${asks('Add one with Claude', 'Connect Claude to ')}${asks('Remove one with Claude', 'Remove the connection to ')}</div>`;
      },
      behavior() {
        const f = scopeFile();
        const d = f.data;
        const opts = (key, list) => {
          const cur = d[key] ?? '';
          const all = list.some(([v]) => v === cur) ? list : [...list, [cur, cur]];
          return `<select data-field="${key}">${all.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        };
        const tri = (key) => {
          const cur = d[key] === true ? 'on' : d[key] === false ? 'off' : '';
          return `<select data-tri="${key}">${[['', 'Not set'], ['on', 'On'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        };
        const num = (key, ph) => `<input type="number" min="0" data-num="${key}" value="${esc(d[key] ?? '')}" placeholder="${esc(ph)}">`;
        const row = (label, hint, control) => `<div class="cs-row cs-static"><span class="cs-row-text"><b>${esc(label)}</b><small>${esc(hint)}</small></span>${control}</div>`;
        const models = [['', 'Not set'], ...(S.probe?.models || []).filter((m) => m.value !== 'default').map((m) => [m.value, m.name])];
        const styles = [['', 'Not set'], ...(S.probe?.styles || []).map((s) => (typeof s === 'string' ? [s, s] : [s.name || s.value, s.name || s.value]))];
        return `${lead('How sessions run. What’s set closer to the work wins: just you in this project, then the shared project, then you everywhere.')}
          ${scopeBar()}${brokenFile(f)}
          ${card([
            row('Model', 'Which Claude to start with. Leafdeck’s chats follow Settings → Claude first.', opts('model', models)),
            row('Answer style', 'How Claude writes to you.', opts('outputStyle', styles)),
            row('Language', 'Claude answers in this. Empty: whatever you write in.', `<input data-text="language" value="${esc(d.language ?? '')}" placeholder="English">`),
            row('Thinks before answering', 'Off is faster and cheaper, and worse on hard problems.', tri('alwaysThinkingEnabled')),
            row('Keeps memory', 'Whether Claude reads and writes memory.', tri('autoMemoryEnabled')),
            row('Runs hooks', 'Off turns every hook off without removing them.', `<select data-hooks>${[['', 'Not set'], ['on', 'On'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${(d.disableAllHooks === true ? 'off' : d.disableAllHooks === false ? 'on' : '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`),
            row('Summarize at', 'Tokens of conversation before Claude compacts it. Smaller costs less and forgets sooner.', num('autoCompactWindow', 'Default')),
            row('Keep past sessions for', 'Days of transcripts to keep on this computer.', num('cleanupPeriodDays', '30')),
          ])}
          <div class="cs-actions"><button class="btn small" data-open="${esc(f.path)}" data-label="${esc(SCOPES[S.scope][0])}">${icon('code', 12)} Edit the file</button><button class="btn small" data-act="leafdeck-settings">${icon('sliders', 12)} Leafdeck’s Claude settings</button>${asks('Something else', 'Change the setting so that ')}</div>`;
      },
      history() {
        const list = S.history;
        return `${lead('Every change made here or by Claude in this app, newest first. Changes made in other sessions aren’t here unless they happened while this chat was working.')}
          ${
            list.length
              ? list
                  .map((h) => {
                    const undone = new Set(h.undone || []);
                    const open = h.files.some((f) => !undone.has(f.path));
                    return `<div class="set-group cs-group cs-change">
                      <div class="cs-change-head"><span class="pill ${h.by === 'claude' ? 'cs-pill-claude' : ''}">${h.by === 'claude' ? 'Claude' : 'You'}</span><b title="${esc(h.label)}">${esc(h.label || 'A change')}</b><span class="grow"></span><small>${esc(when(h.at))}</small>${open ? `<button class="btn small" data-undo="${esc(h.id)}">${h.files.length > 1 ? 'Undo all' : 'Undo'}</button>` : '<span class="pill">Undone</span>'}</div>
                      ${h.files.map((f) => fileChange(h, f, undone.has(f.path))).join('')}
                    </div>`;
                  })
                  .join('')
              : empty('Nothing’s changed yet.')
          }`;
      },
    };
    function fileChange(h, f, undone) {
      const counts = f.before == null || f.after == null ? null : editCounts(f.before, f.after);
      const what = f.before == null ? 'New file' : f.after == null ? 'Deleted' : counts ? `+${counts.add ?? counts.added ?? 0} −${counts.del ?? counts.removed ?? 0}` : '';
      const body = f.before == null ? addedHtml(f.after) : editHtml(f.before, f.after ?? '');
      return `<details class="cs-file" ${h.files.length === 1 ? 'open' : ''}><summary><code>${esc(tilde(f.path))}</code><small>${esc(what)}</small><span class="grow"></span>${h.files.length === 1 ? '' : undone ? '<span class="pill">Undone</span>' : `<button class="btn small" data-undo="${esc(h.id)}" data-undo-file="${esc(f.path)}">Undo</button>`}</summary>${body}</details>`;
    }

    /* ---------------- the editor ---------------- */

    function drawEditor() {
      const f = S.file;
      const ro = f.kind !== 'write';
      pageEl.innerHTML = `<div class="cs-ed">
        <div class="cs-ed-head">
          <button class="tb-btn" data-act="close-file" title="Back">${icon('left', 15)}</button>
          <span class="cs-ed-name"><b>${esc(f.label || baseName(f.path))}</b><small>${esc(tilde(f.path))}</small></span>
          <span class="grow"></span>
          ${ro ? '<span class="pill" title="It’s managed elsewhere (a plugin or your claude.ai account): changes here would be overwritten.">Read only</span>' : `${f.exists ? `<button class="btn small" data-act="delete-file">${icon('trash', 12)} Delete</button>` : ''}<button class="btn small" data-act="revert-file">Revert</button><button class="btn small primary" data-act="save-file">Save</button>`}
        </div>
        <div class="cs-ed-notice" hidden></div>
        <textarea class="cs-ed-text" spellcheck="false" ${ro ? 'readonly' : ''} placeholder="${f.exists ? '' : 'This file doesn’t exist yet. Write here and save to create it.'}"></textarea>
        <div class="cs-ed-foot"><span class="cs-ed-count"></span><span class="grow"></span><span>New sessions pick up what you save.</span></div>
      </div>`;
      const ta = $('.cs-ed-text', pageEl);
      ta.value = f.draft;
      ta.addEventListener('input', () => {
        f.draft = ta.value;
        syncEditor();
      });
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (!ro) saveFile();
        }
      });
      syncEditor();
      showNotice();
    }
    function syncEditor() {
      const f = S.file;
      if (!f) return;
      const count = $('.cs-ed-count', pageEl);
      if (count) count.textContent = `About ${tokens(Math.ceil(new TextEncoder().encode(f.draft).length / 4))} tokens`;
      const save = $('[data-act="save-file"]', pageEl);
      const rev = $('[data-act="revert-file"]', pageEl);
      if (save) save.disabled = !dirty();
      if (rev) rev.disabled = !dirty();
    }
    function showNotice() {
      const n = $('.cs-ed-notice', pageEl);
      if (!n || !S.file?.theirs) return;
      n.hidden = false;
      n.innerHTML = `${icon('flag', 14)}<span>This file changed while you were editing it.</span><span class="grow"></span><button class="btn small" data-act="take-theirs">Use the new version</button><button class="btn small" data-act="keep-mine">Keep my edits</button>`;
    }
    async function openFile(path, label) {
      if (!(await leave())) return;
      try {
        const f = await CS.read(path);
        S.file = { ...f, draft: f.text, label };
        draw();
        $('.cs-ed-text', pageEl)?.focus();
      } catch (err) {
        fail(err);
      }
    }
    async function saveFile() {
      const f = S.file;
      if (!f || !dirty()) return;
      try {
        const saved = await CS.save(f.path, f.draft);
        S.file = { ...f, ...saved, draft: saved.text, theirs: null };
        toast('Saved');
        await afterChange();
      } catch (err) {
        ask({ title: 'That wasn’t saved', message: clean(err), buttons: [{ label: 'OK', value: 'ok', primary: true }], win });
      }
    }
    /** Fine to move on from what's open? */
    async function leave() {
      if (!dirty()) return true;
      const r = await ask({ title: 'Save your changes?', message: `${baseName(S.file.path)} has changes you haven’t saved.`, win, buttons: [{ label: 'Cancel', value: null }, { label: 'Don’t save', value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }] });
      if (!r) return false;
      if (r.button === 'save') {
        await saveFile();
        return !dirty();
      }
      S.file.draft = S.file.text;
      return true;
    }
    /** Something changed on disk (Claude, or a save here): show it, without losing what's being typed. */
    async function afterChange() {
      await loadState();
      S.history = await CS.history();
      if (S.file) {
        try {
          const now = await CS.read(S.file.path);
          if (now.text !== S.file.text) {
            if (dirty() && now.text !== S.file.draft) S.file.theirs = now.text;
            else S.file = { ...S.file, ...now, draft: now.text };
          } else S.file.exists = now.exists;
        } catch {}
      }
      draw();
      loadProbe(true);
    }

    /* ---------------- drawing ---------------- */

    function draw() {
      const scroll = pageEl.scrollTop;
      $$('[data-go]', root).forEach((b) => b.classList.toggle('on', b.dataset.go === S.page));
      $('.cs-title', root).textContent = pageName();
      if (!S.state) return;
      root.classList.toggle('editing', !!S.file);
      if (S.file) {
        const typing = document.activeElement === $('.cs-ed-text', pageEl);
        const pos = typing ? $('.cs-ed-text', pageEl).selectionStart : null;
        drawEditor();
        if (typing) {
          const ta = $('.cs-ed-text', pageEl);
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
        return;
      }
      pageEl.innerHTML = `<div class="cs-doc">${PAGE[S.page]?.() ?? ''}</div>`;
      pageEl.scrollTop = scroll;
    }
    function drawBanner() {
      const h = S.latest;
      bannerEl.hidden = !h;
      if (!h) return;
      const names = h.files.map((f) => baseName(f.path));
      bannerEl.innerHTML = `${icon('claude', 14)}<span>Claude changed <b>${esc(names.slice(0, 3).join(', '))}</b>${names.length > 3 ? ` and ${names.length - 3} more` : ''}</span><span class="grow"></span><button class="btn small" data-act="review">Review</button><button class="btn small" data-undo="${esc(h.id)}">Undo</button><button class="tb-btn" data-act="dismiss" title="Dismiss">${icon('x', 13)}</button>`;
    }
    async function go(page) {
      if (!PAGES.some(([id]) => id === page)) return;
      if (!(await leave())) return;
      S.file = null;
      S.page = page;
      store.set('claudesettings.page', page);
      pageEl.scrollTop = 0;
      draw();
    }

    /* ---------------- changing things ---------------- */

    async function setScoped(patch, scope = S.scope) {
      try {
        await CS.set(scope, S.folder, patch);
        await afterChange();
      } catch (err) {
        fail(err);
        draw();
      }
    }
    async function undo(id, file) {
      try {
        let r = await CS.undo(id, file || '', false);
        if (r.conflicts?.length) {
          const names = r.conflicts.map(baseName).join(', ');
          const ok = await confirmDialog(`${names} changed again after this. Undoing puts back the earlier version and replaces that later change. It stays in the History.`, { title: 'Undo anyway?', ok: 'Undo anyway', danger: true, win });
          if (!ok) return;
          r = await CS.undo(id, file || '', true);
        }
        toast('Undone');
        S.undone.push(file ? tilde(file) : `“${S.history.find((h) => h.id === id)?.label || 'a change'}”`);
        if (S.latest?.id === id) {
          S.latest = null;
          drawBanner();
        }
        await afterChange();
      } catch (err) {
        fail(err);
      }
    }
    async function createFile(kind, global) {
      const name = { rule: 'rule', skill: 'skill', agent: 'agent' }[kind];
      const where = global || !S.folder ? 'for every folder' : `in ${baseName(S.folder)}`;
      const r = await ask({ title: `New ${name}`, message: `A new ${name} ${where}.`, win, fields: [{ name: 'name', label: 'Name', placeholder: kind === 'rule' ? 'writing-style' : 'weekly-report' }], buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
      const n = r?.values?.name?.trim();
      if (!n) return;
      try {
        const file = await CS.create(kind, global ? '' : S.folder, n);
        await loadState();
        await openFile(file, n);
      } catch (err) {
        fail(err);
      }
    }

    root.addEventListener('click', async (e) => {
      const t = e.target;
      const go_ = t.closest('[data-go]');
      if (go_) return go(go_.dataset.go);
      const un = t.closest('[data-undo]');
      if (un) {
        e.preventDefault();
        return undo(un.dataset.undo, un.dataset.undoFile);
      }
      const open = t.closest('[data-open]');
      if (open) return openFile(open.dataset.open, open.dataset.label);
      const pre = t.closest('[data-prefill]');
      if (pre) return prefill(pre.dataset.prefill);
      const sc = t.closest('[data-scope]');
      if (sc) {
        S.scope = sc.dataset.scope;
        return draw();
      }
      const cr = t.closest('[data-create]');
      if (cr) return createFile(cr.dataset.create, !!cr.dataset.global);
      const rr = t.closest('[data-rule-remove]');
      if (rr) {
        const [b, i] = rr.dataset.ruleRemove.split(':');
        const perms = structuredClone(scopeFile().data.permissions || {});
        perms[b].splice(Number(i), 1);
        if (!perms[b].length) delete perms[b];
        return setScoped({ permissions: Object.keys(perms).length ? perms : null });
      }
      const hk = t.closest('[data-hook]');
      if (hk) {
        const [scope, event, group, index] = hk.dataset.hook.split('|');
        try {
          await CS.removeHook(scope, S.folder, event, Number(group), Number(index));
          await afterChange();
        } catch (err) {
          fail(err);
        }
        return;
      }
      const act = t.closest('[data-act]')?.dataset.act;
      if (act === 'refresh') return refresh(true);
      if (act === 'toggle-chat') {
        const off = root.classList.toggle('nochat');
        store.set('claudesettings.nochat', off);
        return;
      }
      if (act === 'leafdeck-settings') return openApp('settings', { tab: 'claude' });
      if (act === 'dismiss') {
        S.latest = null;
        return drawBanner();
      }
      if (act === 'review') {
        S.latest = null;
        drawBanner();
        return go('history');
      }
      if (act === 'close-file') {
        if (!(await leave())) return;
        S.file = null;
        return draw();
      }
      if (act === 'save-file') return saveFile();
      if (act === 'revert-file') {
        S.file.draft = S.file.text;
        S.file.theirs = null;
        return draw();
      }
      if (act === 'take-theirs') {
        S.file.draft = S.file.text = S.file.theirs;
        S.file.theirs = null;
        return draw();
      }
      if (act === 'keep-mine') {
        // Saving now writes over the new version, and it's in the History.
        S.file.text = S.file.theirs;
        S.file.theirs = null;
        return draw();
      }
      if (act === 'delete-file') {
        const ok = await confirmDialog(`Delete ${baseName(S.file.path)}? You can undo it from the History.`, { title: 'Delete this file?', ok: 'Delete', danger: true, win });
        if (!ok) return;
        try {
          await CS.remove(S.file.path);
          S.file = null;
          await afterChange();
        } catch (err) {
          fail(err);
        }
      }
    });
    root.addEventListener('submit', (e) => {
      const form = e.target.closest('[data-rule-form]');
      if (!form) return;
      e.preventDefault();
      const rule = form.elements.rule.value.trim();
      if (!rule) return;
      const b = form.elements.behavior.value;
      const perms = structuredClone(scopeFile().data.permissions || {});
      const list = Array.isArray(perms[b]) ? perms[b] : [];
      if (!list.includes(rule)) list.push(rule);
      perms[b] = list;
      setScoped({ permissions: perms });
    });
    root.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.matches('.cs-folder select')) {
        const was = S.folder;
        if (!(await leave())) {
          t.value = was;
          return;
        }
        S.file = null;
        S.folder = t.value;
        S.probe = null;
        store.set('claudesettings.folder', S.folder);
        return refresh();
      }
      if (t.matches('[data-about]')) {
        await shell.claude.set({ instructions: t.value });
        S.about = await shell.claude.settings();
        return toast('Saved');
      }
      if (t.matches('[data-skill]')) {
        const scope = S.folder ? 'local' : 'user';
        const all = { ...(S.state.settings[scope]?.data?.skillOverrides || {}) };
        if (t.value === 'on') delete all[t.dataset.skill];
        else all[t.dataset.skill] = t.value;
        const s = S.probe?.skills.find((x) => x.name === t.dataset.skill);
        if (s) s.state = t.value;
        return setScoped({ skillOverrides: Object.keys(all).length ? all : null }, scope);
      }
      if (t.matches('[data-automem]')) {
        const scope = S.folder ? 'local' : 'user';
        return setScoped({ autoMemoryEnabled: t.checked ? null : false }, scope);
      }
      if (t.matches('[data-mode]')) {
        if (t.value === 'bypassPermissions') {
          const ok = await confirmDialog('Claude will run commands and change files without ever asking, in every session this applies to. Only the “Never” rules still hold.', { title: 'Never ask?', ok: 'Never ask', danger: true, win });
          if (!ok) return draw();
        }
        const perms = { ...(scopeFile().data.permissions || {}) };
        if (t.value) perms.defaultMode = t.value;
        else delete perms.defaultMode;
        return setScoped({ permissions: Object.keys(perms).length ? perms : null });
      }
      if (t.matches('[data-field]')) return setScoped({ [t.dataset.field]: t.value || null });
      if (t.matches('[data-tri]')) return setScoped({ [t.dataset.tri]: t.value ? t.value === 'on' : null });
      if (t.matches('[data-hooks]')) return setScoped({ disableAllHooks: t.value ? t.value === 'off' : null });
      if (t.matches('[data-text]')) return setScoped({ [t.dataset.text]: t.value.trim() || null });
      if (t.matches('[data-num]')) {
        const n = parseInt(t.value, 10);
        return setScoped({ [t.dataset.num]: Number.isFinite(n) && n > 0 ? n : null });
      }
    });

    // Claude's turn ended: main has put what changed in the history by now.
    const off = listen(CHAT, async (ev) => {
      if (ev.t !== 'done') return;
      const before = S.history[0]?.id;
      await afterChange();
      const h = S.history[0];
      if (h && h.by === 'claude' && h.id !== before) {
        S.latest = h;
        drawBanner();
      }
    });

    win.claudeSettings = {
      go,
      leave,
      destroy() {
        off();
        chat.destroy();
      },
    };

    (async () => {
      await CS.settle().catch(() => null);
      try {
        await loadState();
        S.history = await CS.history();
        S.about = await shell.claude?.settings?.();
        S.builtins = await CS.builtins();
      } catch (err) {
        fail(err);
      }
      draw();
      loadProbe();
    })();
  },
  unmount(win) {
    win.claudeSettings?.destroy();
  },
};
registerApp(app);
