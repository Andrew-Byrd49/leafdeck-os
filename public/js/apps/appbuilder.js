// App Builder: create Leafdeck apps with an AI coding agent (Claude Code or Codex), then open, version and manage
// them. The apps themselves are hosted by ../userapps.js; files live in Documents\Leafdeck Apps (electron/userapps.cjs).
import { $, $$, esc } from '../util.js';
import { icon, appIcon } from '../icons.js';
import { registerApp, toast, openApp } from '../wm.js';
import { confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';
import { createChat } from '../agentchat.js';
import { userApps, userAppsDir, onUserApps, refreshUserApps, openUserApp, grantedFor, isApproved, revoke, appsOff, setAppsOff, describePermission, appWindowId } from '../userapps.js';

const EXAMPLES = [
  {
    title: 'Lead follow-ups',
    perms: 'contacts:read, notify',
    prompt: 'Build a follow-up board for my contacts whose type is "Lead". Show them as cards with name, company and the date I last reached out. Let me log a touchpoint (date, how, notes) on each card and keep those in the app\'s own data. Sort by who has waited longest, and mark anyone with no touchpoint in 14 days.',
  },
  {
    title: 'Event weather',
    perms: 'events:read, network:api.weather.gov',
    prompt: 'Build a page that lists my Leafdeck events in the next 7 days that have a location, and shows the National Weather Service forecast for each one using api.weather.gov (look up the location\'s coordinates from the address if the API needs them, or let me pin a city per event).',
  },
  {
    title: 'Daily standup',
    perms: 'tasks:read, events:read',
    prompt: 'Build a daily standup page: tasks I finished yesterday, tasks due today or overdue, and today\'s events, each as a short list. Add a "Copy summary" button that copies a plain-text standup update to the clipboard.',
  },
];

const FOLLOW_UPS = [
  'Something isn’t working. Open the app, check the logs and a screenshot, and fix it.',
  'Make the table sortable by any column and add a search box.',
  'Add a clear empty state for when there’s no data yet.',
  'Make it fit a narrow window, down to about 420 pixels wide.',
  'Match Leafdeck’s look more closely: use the ld- classes and variables from app.css.',
  'Add a way to export what’s on screen as a CSV file.',
];

const TIPS = [
  ['Describe the job, not the code', 'Say who uses it and what they need to see or do. Your agent picks the layout and code.'],
  ['Name the data', 'Say which Leafdeck records it should use (“my contacts tagged lead”, “today’s events”). The agent asks for just those permissions.'],
  ['One app per job', 'Small, focused apps are faster to build, easier to fix, and safer to give permissions to.'],
  ['Read the permission prompt', 'Leafdeck asks you before an app gets access to your records, notifications or the internet, and again whenever it wants more. It’s your guardrail.'],
  ['Save a version before big changes', 'If a change goes sideways, restore the last good version in App Builder and try again.'],
  ['Let the agent check its work', 'With Claude Code control on, the agent opens the app, takes screenshots and reads errors itself. Ask it to “check it in Leafdeck” after changes.'],
  ['Change direction in BRIEF.md', 'Edit the brief in the app’s folder and tell your agent “Read BRIEF.md again” to steer the whole app.'],
  ['Keep secrets out', 'Don’t paste API keys or passwords into prompts or app data. App records sync to your server and phone.'],
];

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
const copy = (text, what = 'Copied') => navigator.clipboard.writeText(text).then(() => toast(what));

registerApp({
  id: 'appbuilder',
  name: 'App Builder',
  icon: 'sparkle',
  color: 'green',
  size: [1040, 720],
  min: [640, 420],
  openRecord(win, id) {
    win.builder?.select(id);
  },
  mount(win) {
    if (!shell?.userApps) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">App Builder lives in the Leafdeck app</div>
        <p>Building apps with an AI agent needs the desktop app, where your apps run on your own computer.</p></div>`;
      return;
    }
    let view = 'guide'; // 'guide' | 'new' | <app id>
    let agents = {};
    let mcp = null;
    const chats = new Map(); // app id -> chat (agentchat.js)
    win.cleanups.push(() => chats.forEach((c) => c.destroy()));
    const lastSaved = new Map(); // app id -> time of the last automatic version
    const chatFor = (id) => {
      if (!chats.has(id))
        chats.set(id, createChat(id, {
          // A version before Claude changes things (at most one every 15 minutes, so the list stays useful).
          beforeSend: async (text) => {
            if (Date.now() - (lastSaved.get(id) || 0) < 15 * 60_000) return;
            lastSaved.set(id, Date.now());
            await shell.userApps.saveVersion(id, 'Before: ' + text.slice(0, 60)).catch(() => {});
          },
        }));
      return chats.get(id);
    };
    const chatReady = () => !!agents.claude?.installed;
    const logCard = (logs) => {
      const errors = logs.filter((l) => l.level === 'error');
      return `<div class="ab-row"><b>${icon('list', 13)} Log</b><small>${errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : 'No errors'} since Leafdeck started</small>
          <span class="grow"></span><button class="btn small" data-refresh-log>Refresh</button></div>
          ${logs.length ? `<pre class="ab-log">${logs.slice(-40).map((l) => `<span class="lv-${esc(l.level)}">${esc(new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}  ${esc(l.text)}</span>`).join('\n')}</pre>` : '<p class="ab-muted">Console output and errors from the app appear here (your agent reads them too).</p>'}`;
    };
    const refreshLog = async () => {
      const id = view;
      const card = $('.ab-logcard', main);
      if (!card || id === 'guide' || id === 'new') return;
      const logs = await shell.userApps.logs(id).catch(() => null);
      if (logs && view === id) card.innerHTML = logCard(logs);
    };

    win.tools.innerHTML = `<button class="tb-pill" data-ab="folder" title="Open the Leafdeck Apps folder">${icon('folder', 12)} Apps folder</button>
      <button class="tb-pill" data-ab="guide">${icon('note', 12)} Guide</button>
      <button class="tb-pill primary" data-ab="new">${icon('plus', 12)} New app</button>`;
    win.body.innerHTML = '<div class="ab"><aside class="ab-side"></aside><section class="ab-main"></section></div>';
    const side = $('.ab-side', win.body);
    const main = $('.ab-main', win.body);

    const loadStatus = async () => {
      [agents, mcp] = await Promise.all([shell.userApps.agents().catch(() => ({})), shell.mcp?.status().catch(() => null)]);
    };
    // An install finished in another window: notice when you come back.
    const onFocus = async () => {
      const before = JSON.stringify(agents);
      await loadStatus();
      if (JSON.stringify(agents) !== before) draw();
    };
    addEventListener('focus', onFocus);
    win.cleanups.push(() => removeEventListener('focus', onFocus));

    /* ----- the list of your apps ----- */
    const drawSide = () => {
      const list = userApps();
      side.innerHTML = `<h5>Your apps <small>${list.length || ''}</small></h5>
        ${list.length
          ? list
              .map((m) => `<button class="ab-item${view === m.id ? ' on' : ''}" data-app="${esc(m.id)}">${appIcon({ ...m, icon: m.icon || 'sparkle' })}
                <span><b>${esc(m.name)}</b><small>${m.broken ? 'Needs a fix' : !m.hasIndex ? 'Not built yet' : !isApproved(m) ? 'Waiting for your approval' : 'Updated ' + ago(m.modified)}</small></span></button>`)
              .join('')
          : '<p class="ab-none">No apps yet. Make your first one with New app.</p>'}
        <label class="ab-off"><input type="checkbox" data-off ${appsOff() ? '' : 'checked'}><span>Apps can run</span></label>`;
    };

    /* ----- right side ----- */
    // Agents: installed or not, with an Install button that opens a terminal and signs you in.
    const agentsCard = () => {
      const rows = Object.entries(agents).map(([k, a]) => `<div class="ab-agent"><span>${icon(a.installed ? 'check' : 'download', 14)}<b>${esc(a.label)}</b><small>${a.installed ? 'Installed' : 'Not installed'}</small></span>
        ${a.installed ? '' : `<button class="btn small ${k === 'claude' ? 'primary' : ''}" data-install="${k}">Install ${esc(a.label)}</button>`}</div>`).join('');
      const none = !Object.values(agents).some((a) => a.installed);
      return `<div class="ab-card ab-conn ${none ? 'warn' : 'ok'}">
        <div class="ab-conn-head">${icon(none ? 'download' : 'check', 15)}<b>${none ? 'Install an agent to start' : 'Your agents'}</b></div>
        ${rows}
        <p>${none ? 'Install opens a terminal that sets up the agent and signs you in. One is enough; Claude Code is the one we test with.' : 'Each “Start building” opens a terminal in the app’s folder, already connected to Leafdeck: the agent can open your app, take screenshots and read its errors, and nothing else.'}</p>
        <p class="ab-muted">An agent needs its own subscription (Claude Pro, Max or Team for Claude Code; ChatGPT Plus or Pro for Codex).</p></div>`;
    };
    const connectionCard = agentsCard;

    const agentButtons = (id, label = 'Start building', only = null) =>
      Object.entries(agents)
        .filter(([k]) => !only || only.includes(k))
        .map(([k, a]) => `<button class="btn ${k === 'claude' ? 'primary' : ''}" data-launch="${k}" data-id="${esc(id)}" ${a.installed ? '' : 'disabled'} title="${a.installed ? `Opens ${a.label} in this app’s folder` : `${a.label} isn’t installed on this computer`}">${icon('sparkle', 12)} ${label} with ${esc(a.label)}</button>`)
        .join('');

    const drawGuide = () => {
      main.innerHTML = `<div class="ab-scroll"><div class="ab-hero">
          <span class="ab-kicker">${icon('sparkle', 13)} App Builder</span>
          <h1>Build the app you need, with an AI agent.</h1>
          <p>Describe a tool you need. Claude Code or Codex writes it, Leafdeck runs it in its own sandboxed window, and it can use your Leafdeck data only with your permission.</p>
          <button class="btn primary" data-ab="new">${icon('plus', 12)} New app</button>
        </div>
        ${connectionCard()}
        <h3>How it works</h3>
        <ol class="ab-steps">
          <li><b>Describe it.</b> New app → a name and what it should do. Leafdeck makes a folder for it in <code>${esc(userAppsDir() || 'Documents\\Leafdeck Apps')}</code> with your brief and a guide for the agent.</li>
          <li><b>Talk to your agent.</b> “Start building” starts Claude Code on your brief, already connected to Leafdeck, in a chat right on the app’s page: watch it work, approve anything it asks to run, and send the next change. Prefer a terminal? Open the same conversation in one any time. (Codex opens in a terminal.)</li>
          <li><b>Watch it come together.</b> The app opens in Leafdeck and reloads every time the agent saves. The agent checks its own work with screenshots and the app’s error log; it can’t see anything else in Leafdeck.</li>
          <li><b>Approve what it can do.</b> The first time it runs, and whenever it asks for more, Leafdeck shows you exactly what the app wants (read your contacts, create tasks, reach a website) before it gets it.</li>
          <li><b>Keep improving it.</b> Come back any time and send the next change from the app’s page here. Save versions before big changes.</li>
        </ol>
        <h3>Example first prompts</h3>
        <div class="ab-examples">${EXAMPLES.map((x, i) => `<div class="ab-ex"><b>${esc(x.title)}</b><p>${esc(x.prompt)}</p>
          <div class="ab-ex-foot"><small>${icon('key', 11)} ${esc(x.perms)}</small><button class="btn small" data-example="${i}">Use this</button></div></div>`).join('')}</div>
        <h3>Good follow-up prompts</h3>
        <ul class="ab-follow">${FOLLOW_UPS.map((f) => `<li><span>${esc(f)}</span><button class="btn small" data-copy="${esc(f)}">Copy</button></li>`).join('')}</ul>
        <h3>Tips</h3>
        <div class="ab-tips">${TIPS.map(([t, d]) => `<div><b>${esc(t)}</b><p>${esc(d)}</p></div>`).join('')}</div>
        <h3>What apps can and can’t do</h3>
        <div class="ab-two">
          <div class="ab-card"><b>${icon('check', 13)} Can, with your OK</b><ul>
            <li>Run in their own window, with their own data synced to your devices</li>
            <li>Read or change the Leafdeck records you approve (tasks, contacts, events…)</li>
            <li>Show notifications, open sites and Leafdeck apps</li>
            <li>Reach websites you approve, one by one</li></ul></div>
          <div class="ab-card"><b>${icon('shield', 13)} Can’t, ever</b><ul>
            <li>Change Leafdeck itself, or other apps</li>
            <li>See your passwords, cookies, browsing or other sites</li>
            <li>Read or run files on your computer</li>
            <li>Load code from the internet</li></ul></div>
        </div></div>`;
    };

    const drawNew = (preset = {}) => {
      main.innerHTML = `<div class="ab-scroll"><form class="ab-new">
        <h2>New app</h2>
        <label class="field"><span>Name</span><input name="name" maxlength="40" required placeholder="Lead Follow-ups" value="${esc(preset.name || '')}"></label>
        <label class="field"><span>What should it do?</span>
          <textarea name="description" rows="8" required placeholder="Who it’s for, what it shows, what you want to do with it, and which Leafdeck data it should use.">${esc(preset.prompt || '')}</textarea></label>
        <p class="ab-hint">This becomes <code>BRIEF.md</code> in the app’s folder: the brief your agent builds from. You can keep refining it in the conversation.</p>
        <div class="ab-actions">${agentButtons('', 'Create and start building').replaceAll('data-launch', 'data-create-launch') || ''}
          <button type="submit" class="btn">Create only</button></div>
        ${Object.values(agents).some((a) => a.installed) ? '' : `<p class="ab-warn">${icon('flag', 13)} Neither Claude Code nor Codex is installed yet. Install one below, then come back. You can still create the app now.</p>`}
      </form>${connectionCard()}</div>`;
      $('input[name=name]', main).focus();
    };

    const drawApp = async (id) => {
      const m = userApps().find((a) => a.id === id);
      if (!m) {
        view = 'guide';
        return draw();
      }
      const granted = grantedFor(id);
      const [versions, logs] = await Promise.all([shell.userApps.versions(id).catch(() => []), shell.userApps.logs(id).catch(() => [])]);
      if (view !== id) return;
      main.innerHTML = `<div class="ab-scroll"><div class="ab-app-head">${appIcon({ ...m, icon: m.icon || 'sparkle' })}
          <div><h2>${esc(m.name)}</h2><p>${esc(m.description || 'No description yet.')}</p>
          <small>${esc(m.id)} · v${esc(m.version || '0.1.0')} · updated ${esc(ago(m.modified))}</small></div></div>
        ${m.broken ? `<p class="ab-warn">${icon('flag', 13)} ${esc(m.broken)}</p>` : ''}
        <div class="ab-actions"><button class="btn primary" data-open="${esc(id)}" ${m.hasIndex ? '' : 'disabled'}>${icon('external', 12)} Open app</button>
          ${agentButtons(id, 'Continue', chatReady() ? ['codex'] : null)}
          <button class="btn" data-folder="${esc(id)}">${icon('folder', 12)} Open folder</button></div>

        ${chatReady() ? '<div class="ab-chat-slot"></div>' : ''}
        <div class="ab-card" ${chatReady() ? 'hidden' : ''}><b>Next change</b>
          <textarea class="ab-next" rows="3" placeholder="What should change? e.g. “Add a filter for contacts tagged lead”"></textarea>
          <div class="ab-row">${Object.entries(agents).filter(([, a]) => a.installed).map(([k, a]) => `<button class="btn small" data-send="${k}" data-id="${esc(id)}">Send to ${esc(a.label)}</button>`).join('') || '<small>Install Claude Code or Codex to send changes from here.</small>'}
          <small>Opens a new terminal session in the app’s folder with this request.</small></div></div>

        <div class="ab-two">
          <div class="ab-card"><b>${icon('key', 13)} Permissions</b>
            ${m.permissions.length ? `<ul class="ua-perms small">${m.permissions.map((p) => { const d = describePermission(p); return `<li class="${d.warn ? 'warn' : ''}">${icon(d.icon, 12)}<span>${esc(d.text)}</span>${granted?.includes(p) ? '' : '<em>Not approved</em>'}</li>`; }).join('')}</ul>` : '<p class="ab-muted">Only its own data.</p>'}
            ${granted ? `<button class="btn small" data-revoke="${esc(id)}">Revoke approval</button>` : '<p class="ab-muted">You’ll be asked to approve when it opens.</p>'}</div>
          <div class="ab-card"><b>${icon('clock', 13)} Versions</b>
            <div class="ab-row"><button class="btn small" data-save-version="${esc(id)}">Save version now</button></div>
            ${versions.length ? `<ul class="ab-versions">${versions.slice(0, 8).map((v) => `<li><span>${esc(v.label || 'Saved')}<small>${esc(new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small></span><button class="btn small" data-restore="${esc(v.id)}" data-id="${esc(id)}">Restore</button></li>`).join('')}</ul>` : '<p class="ab-muted">No versions yet. Leafdeck saves one each time you start your agent.</p>'}</div>
        </div>

        <div class="ab-card ab-logcard">${logCard(logs)}</div>

        <div class="ab-row ab-danger"><button class="btn small danger" data-remove="${esc(id)}">Remove app</button>
          <small>Moves its folder to Leafdeck Apps\\.trash; nothing is deleted.</small></div>
        ${connectionCard()}</div>`;
      const slot = $('.ab-chat-slot', main);
      if (slot) {
        const chat = chatFor(id);
        const sc = chat.el.querySelector('.ac-scroll');
        const top = sc?.scrollTop;
        slot.replaceWith(chat.el);
        if (sc && top != null) sc.scrollTop = top;
      }
    };

    const draw = () => {
      drawSide();
      if (view === 'guide') drawGuide();
      else if (view === 'new') drawNew();
      else drawApp(view);
    };

    const launch = async (id, agent, prompt) => {
      if (agent === 'claude' && chatReady()) {
        view = id;
        draw();
        const chat = chatFor(id);
        chat.send(prompt || (await shell.userApps.firstPrompt()));
        try {
          openUserApp(id);
        } catch {}
        return;
      }
      try {
        await shell.userApps.saveVersion(id, prompt ? 'Before: ' + prompt.slice(0, 60) : 'Before agent session').catch(() => {});
        await shell.userApps.launchAgent(id, agent, prompt);
        toast(`Opened ${agents[agent]?.label || agent} for ${id}. Talk to it in the new terminal window.`);
        try {
          openUserApp(id);
        } catch {}
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    const create = async (form, agent) => {
      const f = form.elements;
      if (!f.name.value.trim()) return f.name.focus();
      if (!f.description.value.trim()) return f.description.focus();
      try {
        const m = await shell.userApps.create({ name: f.name.value, description: f.description.value });
        await refreshUserApps();
        view = m.id;
        draw();
        if (agent) await launch(m.id, agent);
        else toast(`Created ${m.name}. Start building when you’re ready.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    win.el.addEventListener('submit', (e) => {
      if (!e.target.closest('.ab-new')) return;
      e.preventDefault();
      create(e.target, null);
    });
    win.el.addEventListener('change', (e) => {
      if (e.target.matches('[data-off]')) setAppsOff(!e.target.checked);
    });
    win.el.addEventListener('click', async (e) => {
      const t = e.target;
      const ab = t.closest('[data-ab]')?.dataset.ab;
      if (ab === 'new') {
        view = 'new';
        return draw();
      }
      if (ab === 'guide') {
        view = 'guide';
        return draw();
      }
      if (ab === 'folder') return shell.userApps.openFolder('');
      const inst = t.closest('[data-install]');
      if (inst) {
        try {
          await shell.userApps.installAgent(inst.dataset.install);
          toast('Installing in a new terminal window. Come back here when it’s done.');
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      const item = t.closest('.ab-item[data-app]');
      if (item) {
        view = item.dataset.app;
        return draw();
      }
      const copyBtn = t.closest('[data-copy]');
      if (copyBtn) return copy(copyBtn.dataset.copy);
      const ex = t.closest('[data-example]');
      if (ex) {
        const x = EXAMPLES[Number(ex.dataset.example)];
        view = 'new';
        drawSide();
        return drawNew({ name: x.title, prompt: x.prompt });
      }
      const cl = t.closest('[data-create-launch]');
      if (cl) return create(cl.closest('form'), cl.dataset.createLaunch);
      const lb = t.closest('[data-launch]');
      if (lb) return launch(lb.dataset.id, lb.dataset.launch);
      const sendBtn = t.closest('[data-send]');
      if (sendBtn) {
        const text = $('.ab-next', main).value.trim();
        if (!text) return $('.ab-next', main).focus();
        await launch(sendBtn.dataset.id, sendBtn.dataset.send, `${text}\n\nThen check the app in Leafdeck (leafdeck_app_open, a screenshot and leafdeck_app_logs) and tell me what changed.`);
        $('.ab-next', main).value = '';
        return;
      }
      const op = t.closest('[data-open]');
      if (op) return openUserApp(op.dataset.open);
      const fo = t.closest('[data-folder]');
      if (fo) return shell.userApps.openFolder(fo.dataset.folder);
      const rv = t.closest('[data-revoke]');
      if (rv) {
        revoke(rv.dataset.revoke);
        return draw();
      }
      const sv = t.closest('[data-save-version]');
      if (sv) {
        await shell.userApps.saveVersion(sv.dataset.saveVersion, 'Saved by you');
        toast('Version saved');
        return draw();
      }
      const rs = t.closest('[data-restore]');
      if (rs) {
        await shell.userApps.restore(rs.dataset.id, rs.dataset.restore);
        toast('Restored. The current files were saved as a version first.');
        return draw();
      }
      if (t.closest('[data-refresh-log]')) return refreshLog();
      const rm = t.closest('[data-remove]');
      if (rm) {
        const m = userApps().find((a) => a.id === rm.dataset.remove);
        if (!(await confirmDialog(`Remove “${m?.name || rm.dataset.remove}”? Its folder moves to Leafdeck Apps\\.trash.`, { ok: 'Remove', danger: true }))) return;
        await shell.userApps.remove(rm.dataset.remove);
        revoke(rm.dataset.remove);
        await refreshUserApps();
        view = 'guide';
        return draw();
      }
    });

    win.builder = {
      select: (id) => {
        view = id;
        draw();
      },
    };
    const off = onUserApps(() => drawSide());
    win.cleanups.push(off);
    win.every(5000, () => {
      // Keep the log and status fresh, but never wipe a change you're typing.
      if (view !== 'guide' && view !== 'new' && !document.hidden && !win.minimized) refreshLog();
    });
    loadStatus().then(() => {
      if (!userApps().length) view = 'guide';
      draw();
    });
  },
});
