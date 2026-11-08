// Alt+Tab (Leafdeck OS): switch windows the way Windows does. Hold Alt and press Tab to step through the open windows,
// most recently used first; let go of Alt to switch. Shift+Tab or the arrow keys step back and forth, Esc cancels, and a
// click picks one. The main process watches the keys wherever the keyboard is (a site, a terminal) and sends each step
// (shell:switcher). A quick Alt+Tab switches to the last window without showing anything.

import { esc, el } from './util.js';
import { appIcon } from './icons.js';
import { wins, focus, restore } from './wm.js';
import { shell } from './shell.js';
import { titleOf, fillPreview, overviewOpen, closeOverview } from './overview.js';

const SHOW_AFTER = 150; // ms of holding Alt before the strip shows

let list = null; // the windows, most recently used first, while switching
let sel = 0;
let root = null;
let showTimer = 0;

function step(dir) {
  if (!list) {
    list = [...wins.values()].sort((a, b) => b.z - a.z);
    if (!list.length) return (list = null);
    sel = 0;
    showTimer = setTimeout(show, SHOW_AFTER);
  }
  sel = (sel + dir + list.length) % list.length;
  highlight();
}

function show() {
  if (!list || root) return;
  root = el(`<div id="switcher" role="listbox" aria-label="Switch windows"><div class="sw-strip">${list
    .map(
      (w, i) => `<button class="sw-tile${w.minimized ? ' minimized' : ''}" data-i="${i}" role="option">
        <span class="sw-head">${appIcon(w.app.smallLogo ? { ...w.app, logo: w.app.smallLogo, logoFull: false } : w.app)}<span class="sw-title">${esc(titleOf(w))}</span></span>
        <span class="ov-shot"><span class="ov-fallback">${appIcon(w.app)}</span></span></button>`,
    )
    .join('')}</div></div>`);
  root.addEventListener('pointerover', (e) => {
    const t = e.target.closest('.sw-tile');
    if (t) (sel = +t.dataset.i), highlight();
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('.sw-tile');
    if (t) (sel = +t.dataset.i), finish(true);
    else finish(false);
  });
  document.body.append(root);
  root.querySelectorAll('.sw-tile').forEach((t) => fillPreview(list[+t.dataset.i], t.querySelector('.ov-shot')));
  highlight();
}

function highlight() {
  root?.querySelectorAll('.sw-tile').forEach((t) => {
    const on = +t.dataset.i === sel;
    t.classList.toggle('sel', on);
    t.setAttribute('aria-selected', on);
    if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function finish(pick) {
  clearTimeout(showTimer);
  const w = pick && list?.[sel];
  root?.remove();
  root = null;
  list = null;
  if (!w || !wins.has(w.id)) return;
  if (overviewOpen()) closeOverview();
  if (w.minimized) restore(w);
  focus(w);
}

shell?.on('shell:switcher', ({ step: dir, done, cancel } = {}) => {
  if (dir) step(dir);
  else if (done) finish(true);
  else if (cancel) finish(false);
});
