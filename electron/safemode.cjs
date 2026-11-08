// Leafdeck OS safe mode (os/leafdeck-session --safe, LEAFDECK_SAFE=1): Leafdeck with its default settings, started
// when Leafdeck kept crashing, from the sign-in screen's Safe mode button, or from Restart into safe mode. Here: the
// report on what may be wrong (the last session's log, the settings that were skipped, the database, Claude Code, the
// network…), written where Claude can read it, the one-click fixes the safe-mode banner offers, and the words Claude
// starts the safe-mode conversation with (electron/SAFEMODE.md). The session script decides what runs; main.cjs skips
// saved display arrangements, leafdeckd and the window layout when SAFE is set; this module only looks and fixes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ENV_FILE = path.join(os.homedir(), '.config', 'leafdeck-session.env');
const SHIPPED = ['/usr/lib/leafdeck/leafdeck', '/opt/Leafdeck/leafdeck'];
const SESSION_SCRIPT = ['/usr/libexec/leafdeck/leafdeck-session', '/usr/local/bin/leafdeck-session'].find((p) => fs.existsSync(p)) || '/usr/libexec/leafdeck/leafdeck-session';
const JOURNAL_LINES = 200;
const MB = 1024 * 1024;

let deps = null; // { userData, originalUserData, version, electron, chrome, claudeExe(), readConfig(), writeConfig(patch) }
let collected = null; // the report, once made (safe mode lasts one start; the files are rewritten each start)
let firstAsk = true; // the first message goes to Claude once per start, not again after F5

/** Where the report and the safe-mode conversation live: outside Leafdeck's profile, so a broken profile doesn't lose
 * them, and the same conversation continues across attempts. */
const stateDir = () => {
  const d = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'leafdeck', 'safe-mode');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** Why safe mode: 'crashed' (Leafdeck crashed three times right after starting), 'asked' (Restart into safe mode), or
 * 'signin' (the sign-in screen's Safe mode button), with the crash's exit code when there was one. */
function reason() {
  const r = String(process.env.LEAFDECK_SAFE_REASON || '');
  return { reason: ['crashed', 'asked', 'signin'].includes(r) ? r : 'asked', exitCode: /^\d+$/.test(process.env.LEAFDECK_SAFE_EXIT || '') ? Number(process.env.LEAFDECK_SAFE_EXIT) : null };
}

/** Leafdeck's database, before it's opened: a corrupt one would stop Leafdeck from starting at all. Missing is fine
 * (a fresh profile). */
function checkDatabase(dir) {
  const file = path.join(dir, 'leafdeck.db');
  if (!fs.existsSync(file)) return { ok: true, detail: 'No database yet', size: 0 };
  const size = fs.statSync(file).size;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('PRAGMA quick_check').all();
      const first = String(rows[0]?.quick_check ?? Object.values(rows[0] || {})[0] ?? '');
      return first === 'ok' ? { ok: true, detail: `Checked, ${Math.round(size / MB)} MB`, size } : { ok: false, detail: rows.map((r) => Object.values(r)[0]).join('; ').slice(0, 400), size };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, detail: err.message.slice(0, 400), size };
  }
}

const run = (cmd, args, { timeout = 4000, env } = {}) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 4 * MB, env: env || process.env }, (err, out, errOut) => resolve(err && !out ? null : String(out || '') + (errOut && !out ? String(errOut) : ''))));
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const readText = (p, max = 20000) => {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const envLines = () => readText(ENV_FILE).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
const envValue = (name) => {
  const m = envLines().find((l) => l.replace(/^export\s+/, '').startsWith(`${name}=`));
  return m ? m.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : '';
};

/* ---------------- the report ---------------- */

/** Everything worth knowing, gathered once (a few seconds at most). Each probe fails on its own. */
async function collect() {
  if (collected) return collected;
  const why = reason();
  const home = os.homedir();
  const [journal, daemonLog, sysErrors, active, failed, nm, randr, df, bootc, claudeVersion, gitStatus, gitLog] = await Promise.all([
    run('journalctl', ['--user', '-b', '-t', 'leafdeck-session', '-n', String(JOURNAL_LINES), '--no-pager', '-o', 'short']),
    run('journalctl', ['--user', '-b', '-u', 'leafdeckd.service', '-n', '40', '--no-pager', '-o', 'short']),
    run('journalctl', ['-b', '-p', 'err', '-n', '40', '--no-pager', '-o', 'short']),
    run('systemctl', ['--user', 'is-active', 'leafdeckd.service']),
    run('systemctl', ['--user', 'is-failed', 'leafdeckd.service']),
    run('nmcli', ['-t', '-f', 'STATE,CONNECTIVITY', 'general']),
    run('wlr-randr', []),
    run('df', ['-B1', '--output=size,avail', home]),
    exists('/usr/bin/bootc') ? run('bootc', ['status', '--json'], { timeout: 8000 }) : Promise.resolve(null),
    deps.claudeExe() ? run(deps.claudeExe(), ['--version'], { timeout: 8000 }) : Promise.resolve(null),
    envValue('LEAFDECK_DEV_TREE') ? run('git', ['-C', envValue('LEAFDECK_DEV_TREE'), 'status', '--short']) : Promise.resolve(null),
    envValue('LEAFDECK_DEV_TREE') ? run('git', ['-C', envValue('LEAFDECK_DEV_TREE'), 'log', '-3', '--oneline']) : Promise.resolve(null),
  ]);
  const checks = [];
  const add = (id, title, level, detail, fix = null) => checks.push({ id, title, level, detail: String(detail || '').slice(0, 600), fix });

  // Why we're here.
  const whyText = why.reason === 'crashed' ? `Leafdeck crashed three times right after starting${why.exitCode != null ? ` (exit code ${why.exitCode})` : ''}, so the session started it in safe mode.` : why.reason === 'signin' ? 'You chose Safe mode on the sign-in screen.' : 'You chose Restart into safe mode.';
  add('reason', 'Why safe mode', why.reason === 'crashed' ? 'bad' : 'info', whyText);

  // The last session's log: Leafdeck's own console output, and the compositor's.
  const logText = String(journal || '').trim();
  const logLines = logText ? logText.split('\n') : [];
  // Lines that look like errors, less the compositor's and the GPU stack's everyday noise (wlroots' DRM retries, EGL on
  // a VM without a GPU), which would drown the real ones.
  const NOISE = /backend\/drm\/|\[backend\/|gl_display\.cc|gl_ozone_egl|angle_platform|egl_util|viz_main_impl|ERR: Display\.cpp|gpu_process|dri3|libEGL warning|Atomic commit failed/i;
  const errorLines = logLines.filter((l) => !NOISE.test(l) && /error|crash|segmentation|sigsegv|sigabrt|fatal|cannot find module|syntaxerror|typeerror|referenceerror|uncaught|exit code|killed|crashed three times/i.test(l));
  add('journal', 'Last session’s log', errorLines.length ? 'warn' : 'info', logLines.length ? `${logLines.length} lines; ${errorLines.length} look like errors.${errorLines.length ? '\n' + errorLines.slice(-3).map((l) => l.replace(/^\S+ \d+ [\d:]+ \S+ \S+: /, '')).join('\n') : ''}` : 'Nothing in the journal for this session (journalctl --user -t leafdeck-session).');

  // Per-user session settings: skipped in safe mode, and the usual suspect.
  const envText = readText(ENV_FILE);
  const lines = envLines();
  if (envText) {
    const dev = envValue('LEAFDECK_DEV_TREE');
    const devOk = dev && exists(path.join(dev, 'node_modules', 'electron', 'dist', 'electron')) && exists(path.join(dev, 'electron', 'main.cjs'));
    add('env', 'Session settings (~/.config/leafdeck-session.env)', 'warn', `Skipped in safe mode. ${lines.length} setting${lines.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, { id: 'env', label: 'Set the file aside', note: 'Leafdeck starts with its defaults; the file is kept with a new name.' });
    if (dev) add('devtree', 'Development tree', devOk ? 'warn' : 'bad', devOk ? `${dev}: the code Leafdeck normally runs. Changes there are the first thing to suspect.${gitStatus?.trim() ? `\nUncommitted changes:\n${gitStatus.trim().split('\n').slice(0, 8).join('\n')}` : ''}${gitLog?.trim() ? `\nLatest commits:\n${gitLog.trim()}` : ''}` : `${dev}: missing or incomplete (no Electron or no electron/main.cjs), so Leafdeck couldn’t start from it.`, { id: 'devtree', label: 'Use the shipped Leafdeck', note: 'Turns LEAFDECK_DEV_TREE off in the settings file.' });
  } else add('env', 'Session settings', 'ok', 'No ~/.config/leafdeck-session.env: Leafdeck runs with its defaults.');

  // The app itself.
  const shipped = SHIPPED.find(exists);
  const running = process.execPath;
  const isShipped = !!shipped && running.startsWith(path.dirname(shipped) + path.sep);
  add('app', 'Leafdeck', shipped ? 'ok' : 'warn', `${isShipped ? `Running the shipped Leafdeck (${shipped})` : `Running ${running}${shipped ? ` (the shipped one is ${shipped})` : '; no shipped Leafdeck found'}`}: version ${deps.version}, Electron ${deps.electron}, Chromium ${deps.chrome}.`);

  // The profile: database and settings file.
  const db = deps.database || checkDatabase(deps.originalUserData);
  if (deps.originalUserData !== deps.userData) add('database', 'Leafdeck’s database', 'bad', `${path.join(deps.originalUserData, 'leafdeck.db')} failed its check (${db.detail}), so safe mode is running on a temporary profile: your data, sign-ins and settings aren’t loaded. Setting the database aside starts fresh; the old file is kept for repair.`, { id: 'database', label: 'Set the database aside', note: 'Keeps the old file next to a fresh one. Leafdeck restarts.', confirm: true });
  else add('database', 'Leafdeck’s database', db.ok ? 'ok' : 'bad', db.ok ? `${db.detail} (${path.join(deps.userData, 'leafdeck.db')}).` : `Failed its check: ${db.detail}`, db.ok ? null : { id: 'database', label: 'Set the database aside', note: 'Keeps the old file next to a fresh one. Leafdeck restarts.', confirm: true });
  let config = null;
  const configFile = path.join(deps.originalUserData, 'config.json');
  try {
    config = exists(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    const saved = Object.keys(config.os?.displays || {}).length;
    const choice = config.os?.screen;
    add('displays', 'Display arrangements', saved || choice ? 'warn' : 'ok', saved || choice ? `${saved} saved arrangement${saved === 1 ? '' : 's'}${choice ? `, screen choice “${choice}”` : ''}, skipped in safe mode: the screens are in their automatic arrangement.` : 'None saved: the screens are in their automatic arrangement.', saved || choice ? { id: 'displays', label: 'Reset to automatic', note: 'Forgets the saved arrangements; set them again in Settings → Displays.' } : null);
  } catch (err) {
    add('config', 'Settings file', 'bad', `${configFile} can’t be read: ${err.message}`, { id: 'config', label: 'Set the settings file aside', note: 'Leafdeck’s settings go back to their defaults; the file is kept.' });
  }

  // Disk, network, services, Claude Code.
  const [size, avail] = (df?.trim().split('\n')[1] || '').trim().split(/\s+/).map(Number);
  if (size) add('disk', 'Disk space', avail < 500 * MB ? 'bad' : avail < 2000 * MB ? 'warn' : 'ok', `${Math.round(avail / MB / 1024 * 10) / 10} GB free of ${Math.round(size / MB / 1024)} GB in your home folder.${avail < 500 * MB ? ' Leafdeck and Claude Code can’t work without free space.' : ''}`);
  const [nmState, nmConn] = (nm || '').trim().split(':');
  add('network', 'Network', nmState === 'connected' && nmConn !== 'none' ? 'ok' : 'warn', nm ? `${nmState || 'unknown'}${nmConn ? `, connectivity ${nmConn}` : ''}.${nmState !== 'connected' ? ' Claude needs the internet; the network panel in the menu bar joins Wi‑Fi.' : ''}` : 'NetworkManager didn’t answer.');
  const activeState = (active || '').trim();
  add('leafdeckd', 'Leafdeck’s services (leafdeckd)', activeState === 'active' ? 'ok' : 'warn', `${activeState || 'unknown'}${(failed || '').trim() === 'failed' ? ', failed' : ''}; safe mode doesn’t use it (terminals run inside Leafdeck).${daemonLog?.trim() ? `\n${daemonLog.trim().split('\n').slice(-3).join('\n')}` : ''}`, activeState === 'active' ? null : { id: 'leafdeckd', label: 'Restart the services' });
  const claude = deps.claudeExe();
  const creds = exists(path.join(os.homedir(), '.claude', '.credentials.json'));
  add('claude', 'Claude Code', claude && creds ? 'ok' : 'bad', claude ? `${(claudeVersion || '').trim() || claude}${creds ? ', signed in.' : ', but not signed in: the Claude panel’s Set up button runs the sign-in.'}` : 'Not installed. The Claude panel’s Set up button installs it; until then, the Terminal and the fixes here still work.');

  // Screens and the system image.
  const outputs = (randr || '').split('\n').filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[0]).filter(Boolean);
  if (randr) add('screens', 'Screens', 'info', `${outputs.length} connected: ${outputs.join(', ')}.`);
  if (bootc) {
    try {
      const st = JSON.parse(bootc);
      const booted = st.status?.booted?.image?.image?.image || '';
      const rollback = st.status?.rollback?.image?.image?.image || '';
      add('image', 'System image', 'info', `${booted || 'unknown'}${rollback ? `; a previous image is there to roll back to (${rollback}): sudo bootc rollback` : '; no previous image to roll back to'}.`);
    } catch {}
  }

  // The files Claude reads.
  const dir = stateDir();
  const journalFile = path.join(dir, 'journal.txt');
  const reportFile = path.join(dir, 'report.md');
  fs.writeFileSync(journalFile, [`# journalctl --user -b -t leafdeck-session -n ${JOURNAL_LINES}`, logText || '(nothing)', '', '# journalctl --user -b -u leafdeckd.service -n 40', (daemonLog || '').trim() || '(nothing)', '', '# journalctl -b -p err -n 40 (system errors; may be denied)', (sysErrors || '').trim() || '(nothing or not readable)', ''].join('\n'));
  const md = [
    `# Leafdeck safe mode report`,
    ``,
    `Written ${new Date().toISOString()} by Leafdeck ${deps.version} (Electron ${deps.electron}, Chromium ${deps.chrome}) for ${os.userInfo().username}@${os.hostname()}.`,
    ``,
    `## Why`,
    ``,
    whyText,
    ``,
    `## Checks`,
    ``,
    ...checks.map((c) => `- **${c.title}** (${c.level}): ${c.detail.replace(/\n/g, '\n  ')}`),
    ``,
    `## Paths`,
    ``,
    `- Session script: ${SESSION_SCRIPT}`,
    `- Session settings file: ${ENV_FILE}${envText ? '' : ' (absent)'}`,
    `- Leafdeck profile: ${deps.originalUserData}${deps.originalUserData !== deps.userData ? ` (safe mode is running on a temporary profile: ${deps.userData})` : ''}`,
    `- Safe-mode files (this report, the journal, this conversation): ${dir}`,
    `- Shipped Leafdeck: ${shipped || 'none'}`,
    `- Claude Code: ${claude || 'not installed'}`,
    ``,
    `## Session settings file`,
    ``,
    '```',
    envText.trim() || '(absent)',
    '```',
    ``,
    `## Screens (wlr-randr)`,
    ``,
    '```',
    (randr || '').trim() || '(no answer)',
    '```',
    ``,
    `The last session's log is in journal.txt beside this file.`,
    ``,
  ].join('\n');
  fs.writeFileSync(reportFile, md);
  collected = { ...why, checks, files: { report: reportFile, journal: journalFile, dir }, temporaryProfile: deps.originalUserData !== deps.userData };
  return collected;
}

/** The report, plus whether this is the first time it's asked for since Leafdeck started (the UI then opens Claude). */
async function report() {
  const r = await collect();
  const first = firstAsk;
  firstAsk = false;
  return { ...r, first, message: firstMessage(r) };
}

/** What the UI sends to Claude to begin with: short; the details are in the files. */
function firstMessage(r) {
  const why = r.reason === 'crashed' ? `Leafdeck crashed three times right after starting${r.exitCode != null ? ` (exit code ${r.exitCode})` : ''} and the session started it in safe mode` : r.reason === 'signin' ? 'I chose Safe mode on the sign-in screen because Leafdeck wasn’t working for me' : 'I restarted Leafdeck into safe mode because something wasn’t working';
  const notable = r.checks.filter((c) => c.level === 'bad' || c.level === 'warn').filter((c) => c.id !== 'reason');
  return [`${why}. Safe mode found:`, ...notable.map((c) => `- ${c.title}: ${c.detail.split('\n')[0]}`), ...(notable.length ? [] : ['- nothing out of the ordinary']), '', 'Please read the report and the log, tell me what you think went wrong, and help me fix it so Leafdeck starts normally again.'].join('\n');
}

/** What Claude is told at the start of the safe-mode conversation (electron/SAFEMODE.md with the paths filled in). */
function prompt() {
  const dir = stateDir();
  return readText(path.join(__dirname, 'SAFEMODE.md'), 60000)
    .replace(/\{\{STATE_DIR\}\}/g, dir)
    .replace(/\{\{ENV_FILE\}\}/g, ENV_FILE)
    .replace(/\{\{PROFILE\}\}/g, deps.originalUserData)
    .replace(/\{\{SESSION_SCRIPT\}\}/g, SESSION_SCRIPT)
    .replace(/\{\{SHIPPED\}\}/g, SHIPPED.find(exists) || '/usr/lib/leafdeck/leafdeck');
}

/* ---------------- fixes ---------------- */

/** Set a file aside under a dated name (never deleted). Returns the new name, or '' if there was nothing. */
function setAside(file, tag) {
  if (!exists(file)) return '';
  const to = `${file}.${tag}-${stamp()}`;
  fs.renameSync(file, to);
  return to;
}

const FIXES = {
  env() {
    const to = setAside(ENV_FILE, 'disabled');
    return { ok: true, message: to ? `Set aside as ${path.basename(to)}. Leafdeck starts with its defaults next time.` : 'There was no settings file.' };
  },
  devtree() {
    const text = readText(ENV_FILE);
    if (!/^\s*(export\s+)?LEAFDECK_DEV_TREE=/m.test(text)) return { ok: true, message: 'No development tree is set.' };
    fs.writeFileSync(ENV_FILE, text.replace(/^(\s*)((export\s+)?LEAFDECK_DEV_TREE=.*)$/gm, `$1# turned off by safe mode ${stamp()}: $2`));
    return { ok: true, message: 'LEAFDECK_DEV_TREE is off. Leafdeck runs the shipped build next time; turn it back on in the settings file when the tree is fixed.' };
  },
  displays() {
    const os_ = { ...(deps.readConfig().os || {}) };
    delete os_.displays;
    delete os_.screen;
    deps.writeConfig({ os: os_ });
    return { ok: true, message: 'Display arrangements reset. Settings → Displays can set them again.' };
  },
  config() {
    const to = setAside(path.join(deps.originalUserData, 'config.json'), 'broken');
    return { ok: true, message: to ? `Set aside as ${path.basename(to)}. Leafdeck’s settings start from their defaults.` : 'There was no settings file.', restart: true };
  },
  database() {
    const base = path.join(deps.originalUserData, 'leafdeck.db');
    const tag = stamp();
    const moved = ['', '-wal', '-shm'].map((suffix) => (exists(base + suffix) ? (fs.renameSync(base + suffix, `${base}.broken-${tag}${suffix}`), true) : false)).some(Boolean);
    return { ok: true, message: moved ? `The database is set aside as leafdeck.db.broken-${tag}. Leafdeck starts with a fresh one.` : 'There was no database.', restart: true };
  },
  async leafdeckd() {
    const out = await run('systemctl', ['--user', 'restart', 'leafdeckd.service'], { timeout: 10000 });
    const state = ((await run('systemctl', ['--user', 'is-active', 'leafdeckd.service'])) || '').trim();
    return { ok: state === 'active', message: state === 'active' ? 'Leafdeck’s services are running again.' : `Still ${state || 'not running'}${out?.trim() ? `: ${out.trim()}` : ''}.` };
  },
};

async function fix(id) {
  const f = FIXES[String(id)];
  if (!f) throw new Error('Unknown fix');
  const r = await f();
  collected = null; // the report is out of date now
  return r;
}

function init(d) {
  deps = d;
}

module.exports = { init, reason, checkDatabase, report, prompt, fix, stateDir, ENV_FILE };
