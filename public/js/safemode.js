// Leafdeck OS safe mode (os/leafdeck-session --safe, electron/safemode.cjs): the banner at the top of the screen while
// Leafdeck runs with its default settings, the list of what safe mode found with its one-click fixes, and the first
// message to Claude, who gets the report (assistant.js holds the conversation).
import { shell } from './shell.js';
import { icon } from './icons.js';
import { toast } from './wm.js';
import { confirmDialog } from './dialogs.js';
import { esc } from './util.js';
import { assistantSend } from './assistant.js';

let bar = null;
let panel = null;
let report = null;

const WHY = {
  crashed: (r) => `Leafdeck crashed three times right after starting${r.exitCode != null ? ` (exit code ${r.exitCode})` : ''}, so it started with its default settings.`,
  signin: () => 'You chose Safe mode when signing in: Leafdeck started with its default settings.',
  asked: () => 'Leafdeck restarted with its default settings, as you asked.',
};
const LEVEL = { bad: 'Problem', warn: 'Check', ok: 'Fine', info: '' };

export async function initSafeMode() {
  if (!shell?.safe || bar) return;
  bar = document.createElement('div');
  bar.id = 'safebar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Safe mode');
  bar.innerHTML = `<span class="sb-badge">${icon('shield', 13)} Safe mode</span>
    <span class="sb-text">Looking at what went wrong…</span>
    <span class="grow"></span>
    <button class="btn small" data-sb="checks">${icon('list', 12)} What safe mode found <b class="sb-count" hidden></b></button>
    <button class="btn small" data-sb="claude">${icon('claude', 12)} Ask Claude</button>
    <button class="btn small primary" data-sb="try" title="Restart Leafdeck normally, with your settings">${icon('play', 12)} Try Leafdeck now</button>
    <button class="btn small" data-sb="signout">${icon('logout', 12)} Sign out</button>`;
  document.body.append(bar);
  bar.addEventListener('click', onClick);
  try {
    report = await shell.safe.report();
  } catch (err) {
    bar.querySelector('.sb-text').textContent = `Couldn’t look at what went wrong: ${err.message}`;
    return;
  }
  draw();
  // The report goes to Claude once per start (not again after a reload of the desktop).
  if (report.first) assistantSend(report.message).catch((err) => toast(err.message, 'error'));
}

function draw() {
  const r = report;
  bar.querySelector('.sb-text').textContent = `${(WHY[r.reason] || WHY.asked)(r)}${r.temporaryProfile ? ' Your data isn’t loaded: the database failed its check.' : ''}`;
  const n = r.checks.filter((c) => c.level === 'bad' || c.level === 'warn').length;
  const count = bar.querySelector('.sb-count');
  count.textContent = String(n);
  count.hidden = !n;
  if (panel && !panel.hidden) drawPanel();
}

function drawPanel() {
  panel.innerHTML = `<div class="sb-panel-head"><b>What safe mode found</b><span class="grow"></span><small>The report is in ${esc(report.files.dir)}</small><button class="tb-btn" data-sb="close" title="Close">${icon('x', 14)}</button></div>
    <div class="sb-list">${report.checks
      .map(
        (c) => `<div class="sb-check sb-${c.level}"><i class="sb-dot"></i><div class="sb-body"><div class="sb-title">${esc(c.title)}${LEVEL[c.level] ? `<small>${LEVEL[c.level]}</small>` : ''}</div><div class="sb-detail">${esc(c.detail)}</div>${c.fix ? `<small class="sb-note">${esc(c.fix.note || '')}</small>` : ''}</div>${c.fix ? `<button class="btn small" data-fix="${esc(c.fix.id)}" data-confirm="${c.fix.confirm ? 1 : ''}" data-title="${esc(c.title)}">${esc(c.fix.label)}</button>` : ''}</div>`,
      )
      .join('')}</div>`;
}

function openPanel() {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'safepanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'What safe mode found');
    panel.addEventListener('click', onClick);
    document.body.append(panel);
  }
  panel.hidden = false;
  drawPanel();
  setTimeout(() => addEventListener('pointerdown', outside, true));
  addEventListener('keydown', onKey, true);
}
function closePanel() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  removeEventListener('pointerdown', outside, true);
  removeEventListener('keydown', onKey, true);
}
const outside = (e) => panel && !panel.contains(e.target) && !bar.contains(e.target) && !e.target.closest?.('.modal') && closePanel();
const onKey = (e) => e.key === 'Escape' && panel && !panel.hidden && (e.stopPropagation(), closePanel());

async function onClick(e) {
  const fix = e.target.closest('[data-fix]');
  if (fix) return runFix(fix);
  const b = e.target.closest('[data-sb]');
  if (!b) return;
  const act = b.dataset.sb;
  if (act === 'checks') return panel && !panel.hidden ? closePanel() : openPanel();
  if (act === 'close') return closePanel();
  if (act === 'claude') {
    closePanel();
    return assistantSend('').catch(() => {}); // opens the window; an empty message sends nothing
  }
  if (act === 'try') {
    if (await confirmDialog('Restart Leafdeck normally? Your settings apply again. If it crashes, safe mode comes back on its own and this conversation continues.', { title: 'Try Leafdeck now', ok: 'Restart Leafdeck' })) shell.windowAction('restart-leafdeck');
    return;
  }
  if (act === 'signout') {
    if (await confirmDialog('Sign out? The sign-in screen offers safe mode again if Leafdeck can’t start.', { title: 'Sign out', ok: 'Sign out' })) shell.windowAction('sign-out');
  }
}

async function runFix(b) {
  const id = b.dataset.fix;
  if (b.dataset.confirm && !(await confirmDialog(`${b.dataset.title}: ${b.textContent.trim()}? The old file is kept, nothing is deleted.`, { title: 'Safe mode', ok: b.textContent.trim(), danger: true }))) return;
  b.disabled = true;
  try {
    const r = await shell.safe.fix(id);
    toast(r.message, r.ok ? '' : 'error');
    report = await shell.safe.report();
    draw();
    if (r.restart && (await confirmDialog(`${r.message} Restart Leafdeck in safe mode now so it takes effect?`, { title: 'Safe mode', ok: 'Restart now' }))) shell.windowAction('safe-mode');
  } catch (err) {
    toast(err.message, 'error');
    b.disabled = false;
  }
}
