// Window overview: every open window as a card you can search, pick, or close (F3, or Window → Show All Windows).
// Site windows show a live screenshot; app windows show a scaled copy of their contents.

import { $, $$, esc, el } from './util.js';
import { icon, appIcon } from './icons.js';
import { wins, focus, restore, closeWindow, activeWindow } from './wm.js';

let root = null;
let sel = 0;

export const overviewOpen = () => !!root;
export function toggleOverview() {
  if (root) closeOverview();
  else openOverview();
}

export const titleOf = (w) => $('.win-title-text', w.el)?.textContent || w.app.name;
const urlOf = (w) => {
  try {
    return w.web?.url?.() || '';
  } catch {
    return '';
  }
};
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function openOverview() {
  if (root) return;
  const list = [...wins.values()].sort((a, b) => b.z - a.z);
  const sites = list.filter((w) => w.web);
  const apps = list.filter((w) => !w.web);
  const card = (w) => `<button class="ov-card ${w.minimized ? 'minimized' : ''} ${w === activeWindow() ? 'active' : ''}" data-id="${esc(w.id)}" data-text="${esc(`${titleOf(w)} ${urlOf(w)} ${w.app.name}`.toLowerCase())}">
      <span class="ov-head">${appIcon(w.app.smallLogo ? { ...w.app, logo: w.app.smallLogo, logoFull: false } : w.app)}<span class="ov-title">${esc(titleOf(w))}</span>
        ${w.minimized ? '<small class="ov-tag">minimized</small>' : w.web?.sleeping ? '<small class="ov-tag">asleep</small>' : ''}
        <span class="ov-x" data-close title="Close window">${icon('x', 12)}</span></span>
      <span class="ov-shot"><span class="ov-fallback">${appIcon(w.app)}<small>${esc(hostOf(urlOf(w)) || w.app.name)}</small></span></span>
    </button>`;
  const group = (name, items) => (items.length ? `<h4>${name} <em>${items.length}</em></h4><div class="ov-grid">${items.map(card).join('')}</div>` : '');
  root = el(`<div id="overview" role="dialog" aria-label="All windows">
    <div class="ov-top"><label class="ov-search">${icon('search', 14)}<input placeholder="Type to find a window" autocomplete="off" spellcheck="false"></label>
      <span class="muted small">Enter opens · Esc closes · ${list.length} window${list.length === 1 ? '' : 's'}</span></div>
    <div class="ov-body">${list.length ? group('Sites', sites) + group('Apps', apps) : '<div class="ov-empty">No windows open</div>'}</div>
  </div>`);
  document.body.append(root);
  sel = 0;
  highlight();

  // Previews, filled in after the cards are on screen.
  for (const w of list) {
    const shot = $(`.ov-card[data-id="${CSS.escape(w.id)}"] .ov-shot`, root);
    if (shot) fillPreview(w, shot);
  }

  const input = $('input', root);
  setTimeout(() => input.focus(), 20);
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    for (const c of $$('.ov-card', root)) c.hidden = !!q && !c.dataset.text.includes(q);
    for (const h of $$('h4', root)) {
      const grid = h.nextElementSibling;
      h.hidden = grid.hidden = ![...grid.children].some((c) => !c.hidden);
    }
    sel = 0;
    highlight();
  });
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.classList.contains('ov-body')) return closeOverview();
    const c = e.target.closest('.ov-card');
    if (!c) return;
    const w = wins.get(c.dataset.id);
    if (e.target.closest('[data-close]')) {
      e.stopPropagation();
      if (w) closeWindow(w);
      c.remove();
      if (!wins.size) closeOverview();
      return;
    }
    pick(w);
  });
  root.addEventListener('keydown', onKey);
}

function visible() {
  return $$('.ov-card:not([hidden])', root);
}
function highlight() {
  const cards = visible();
  sel = Math.max(0, Math.min(sel, cards.length - 1));
  cards.forEach((c, i) => c.classList.toggle('sel', i === sel));
  cards[sel]?.scrollIntoView({ block: 'nearest' });
}
function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    return closeOverview();
  }
  const cards = visible();
  if (e.key === 'Enter') {
    e.preventDefault();
    const c = cards[sel];
    return c && pick(wins.get(c.dataset.id));
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const cols = Math.max(1, Math.round(($('.ov-grid', root)?.clientWidth || 1) / 300));
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : -cols;
    sel = (sel + step + cards.length) % Math.max(1, cards.length);
    highlight();
  }
}
function pick(w) {
  closeOverview();
  if (!w) return;
  if (w.minimized) restore(w);
  focus(w);
}

export function closeOverview() {
  if (!root) return;
  root.remove();
  root = null;
}

/** A window's preview in `shot` (an .ov-shot): a site's live screenshot, or a scaled copy of an app's contents. */
export function fillPreview(w, shot) {
  if (w.web) {
    const wv = w.web.webview;
    if (!wv || w.web.sleeping || w.minimized) return;
    Promise.resolve()
      .then(() => wv.capturePage())
      .then((img) => {
        const url = img?.toDataURL?.();
        if (url && shot.isConnected) {
          shot.style.backgroundImage = `url(${url})`;
          shot.classList.add('has-shot');
        }
      })
      .catch(() => {});
    return;
  }
  const body = $('.win-body', w.el);
  if (!body) return;
  const r = w.max ? { w: innerWidth, h: innerHeight } : w.rect;
  const clone = body.cloneNode(true);
  clone.querySelectorAll('webview, video, iframe, script').forEach((n) => n.remove());
  clone.className = 'ov-clone win-body';
  clone.style.width = `${r.w}px`;
  clone.style.height = `${Math.max(100, r.h - 38)}px`;
  shot.append(clone);
  requestAnimationFrame(() => {
    const box = shot.getBoundingClientRect();
    const scale = Math.min(box.width / r.w, box.height / Math.max(100, r.h - 38));
    clone.style.transform = `scale(${scale})`;
    shot.classList.add('has-shot');
  });
}
