// Notes: a rich-text notebook.
//
// A note keeps its content as HTML in `body` (format: 'html') and a plain-text copy in `text` for search,
// previews and widgets. Older plain-text notes are converted the first time they're edited. Images and
// voice memos are stored on your Leafdeck server (/api/media) and referenced by id, so notes stay small.
// Everything that comes in (pasted HTML, saved notes) goes through `clean()`, an allowlist sanitizer.

import { store } from '../store.js';
import { esc, $, $$, debounce, el } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, showMenu, placePopup } from '../wm.js';
import { schemas, recordMatches } from '../schemas.js';
import { shell } from '../shell.js';
import { openWebPage } from './browser.js';

const sc = schemas.notes;

/* ---------------- Icons for the editor toolbar ---------------- */

const P = {
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
  alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  bullets: '<path d="M10 7h10M10 12h10M10 17h10"/><circle cx="5" cy="7" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="17" r="1.2"/>',
  numbers: '<path d="M10 7h10M10 12h10M10 17h10M4 6l1.5-1v4M4 15.5c0-1 2.5-1 2.5.2 0 1-2.5 2.3-2.5 2.3h2.6"/>',
  checks: '<rect x="3.5" y="4.5" width="5" height="5" rx="1.2"/><path d="M4.8 7l1.1 1.1L8 5.8M12 7h8M3.5 14.5h5v5h-5zM12 17h8"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  marker: '<path d="M14.5 4.5l5 5L11 18H6v-5z"/><path d="M4 21h16"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M3.5 15h17M10 4.5v15"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
};
const ico = (n, s = 16) =>
  `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;

/* ---------------- Styles you can pick ---------------- */

const BLOCKS = [
  ['H1', 'Title', 'H1'],
  ['H2', 'Heading', 'H2'],
  ['H3', 'Subheading', 'H3'],
  ['P', 'Body', 'Aa'],
  ['BLOCKQUOTE', 'Quote', '“'],
  ['PRE', 'Code', '{ }'],
];
// Text colors chosen to read well on the dark page.
const COLORS = [
  ['Default', ''],
  ['Gray', '#a3aaa6'],
  ['Red', '#ff8a80'],
  ['Orange', '#ffb36b'],
  ['Yellow', '#ffe07a'],
  ['Green', '#7ee0a6'],
  ['Blue', '#82b6ff'],
  ['Purple', '#c9a2ff'],
  ['Pink', '#ff9ccf'],
];
const HIGHLIGHTS = [
  ['None', ''],
  ['Yellow', 'rgba(255, 214, 10, 0.32)'],
  ['Green', 'rgba(52, 199, 123, 0.3)'],
  ['Blue', 'rgba(90, 160, 255, 0.3)'],
  ['Purple', 'rgba(175, 120, 255, 0.32)'],
  ['Pink', 'rgba(255, 105, 180, 0.3)'],
  ['Red', 'rgba(255, 80, 70, 0.3)'],
];
const SIZES = [
  ['Small', '13px'],
  ['Normal', ''],
  ['Large', '18px'],
  ['Huge', '24px'],
];

/* ---------------- Sanitizing ---------------- */

const KEEP = new Set(['P', 'DIV', 'BR', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'CODE', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'SPAN', 'MARK', 'A', 'SUB', 'SUP', 'HR', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'AUDIO', 'VIDEO', 'CANVAS', 'HEAD', 'TITLE']);
const STYLE_KEYS = ['color', 'background-color', 'text-align', 'font-size', 'font-weight', 'font-style', 'text-decoration-line'];
const CLASSES = new Set(['checklist', 'nt-img', 'nt-audio', 'nt-table']);
const FONT_SIZES = { 1: '11px', 2: '13px', 3: '', 4: '18px', 5: '24px', 6: '30px', 7: '36px' };

function cleanStyle(node) {
  const out = [];
  for (const k of STYLE_KEYS) {
    const v = node.style.getPropertyValue(k);
    if (v && !/url\(|expression|javascript:/i.test(v)) out.push(`${k}: ${v}`);
  }
  return out.join('; ');
}

/** Allowlist sanitizer: unknown tags are unwrapped (their text kept), dangerous ones removed, attributes filtered. */
function clean(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const walk = (parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3) continue;
      if (node.nodeType !== 1) {
        node.remove();
        continue;
      }
      let n = node;
      if (n.tagName === 'FONT') {
        // Old-style <font> (from paste or execCommand) becomes a span with the same look.
        const span = doc.createElement('span');
        const size = FONT_SIZES[n.getAttribute('size')];
        if (size) span.style.fontSize = size;
        if (n.getAttribute('color')) span.style.color = n.getAttribute('color');
        span.append(...n.childNodes);
        n.replaceWith(span);
        n = span;
      }
      if (DROP.has(n.tagName)) {
        n.remove();
        continue;
      }
      if (!KEEP.has(n.tagName)) {
        const kids = [...n.childNodes];
        n.replaceWith(...kids);
        kids.forEach((k) => k.nodeType === 1 && walk({ childNodes: [k] }));
        continue;
      }
      const isAudio = n.tagName === 'DIV' && n.classList.contains('nt-audio');
      const keep = {};
      const style = cleanStyle(n);
      if (style) keep.style = style;
      const cls = [...n.classList].filter((c) => CLASSES.has(c)).join(' ');
      if (cls) keep.class = cls;
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) keep.href = href;
      }
      if (n.tagName === 'IMG') {
        const media = n.getAttribute('data-media') || '';
        const src = n.getAttribute('src') || '';
        if (/^[0-9a-f-]{36}$/.test(media)) keep['data-media'] = media;
        else if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src)) keep.src = src;
        else if (/^https:\/\//i.test(src)) keep.src = src;
        else {
          n.remove();
          continue;
        }
        keep.alt = (n.getAttribute('alt') || '').slice(0, 200);
        keep.class = 'nt-img';
      }
      if (n.tagName === 'LI' && n.hasAttribute('data-checked')) keep['data-checked'] = n.getAttribute('data-checked') === 'true' ? 'true' : 'false';
      if ((n.tagName === 'TD' || n.tagName === 'TH') && /^\d{1,2}$/.test(n.getAttribute('colspan') || '')) keep.colspan = n.getAttribute('colspan');
      if (n.tagName === 'OL' && /^\d{1,4}$/.test(n.getAttribute('start') || '')) keep.start = n.getAttribute('start');
      if (isAudio) {
        const media = n.getAttribute('data-media') || '';
        if (!/^[0-9a-f-]{36}$/.test(media)) {
          n.remove();
          continue;
        }
        keep['data-media'] = media;
        keep['data-duration'] = String(Math.round(Number(n.getAttribute('data-duration')) || 0));
        keep['data-peaks'] = (n.getAttribute('data-peaks') || '').replace(/[^\d,]/g, '').slice(0, 400);
        n.replaceChildren(); // the player is rebuilt when the note is shown
      }
      for (const a of [...n.attributes]) n.removeAttribute(a.name);
      for (const [k, v] of Object.entries(keep)) n.setAttribute(k, v);
      if (!isAudio) walk(n);
    }
  };
  walk(doc.body);
  // Empty blocks keep a line break so they stay visible and clickable.
  return doc.body.innerHTML.replace(/<(p|h1|h2|h3|li|blockquote)([^>]*)><\/\1>/g, '<$1$2><br></$1>');
}

/** A plain-text note (from before rich text) as paragraphs. */
const fromPlain = (text) =>
  String(text || '')
    .split('\n')
    .map((l) => (l.trim() ? `<p>${esc(l)}</p>` : '<p><br></p>'))
    .join('') || '<p><br></p>';

const noteHtml = (n) => (n.format === 'html' ? clean(n.body) : fromPlain(n.body)) || '<p><br></p>';
const noteText = (n) => (n.format === 'html' ? n.text || '' : n.body || '');
const preview = (n) => noteText(n).replace(/\s+/g, ' ').trim().slice(0, 110);

/* ---------------- Media (images and voice memos on your server) ---------------- */

const authHeaders = () => {
  try {
    const t = localStorage.getItem('ws:token');
    return t ? { 'x-api-token': t } : {};
  } catch {
    return {};
  }
};

async function uploadMedia(blob) {
  const res = await fetch('/api/media', { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream', ...authHeaders() }, body: blob });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
  return j.id;
}

const mediaCache = new Map(); // id -> Promise<object URL>
function mediaUrl(id) {
  if (!mediaCache.has(id)) {
    const p = fetch(`/api/media/${encodeURIComponent(id)}`, { headers: authHeaders() }).then(async (res) => {
      if (!res.ok) throw new Error(`Couldn’t load media (${res.status})`);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => mediaCache.delete(id));
    mediaCache.set(id, p);
  }
  return mediaCache.get(id);
}

/** Fit big photos to 1800px and re-encode, so notes load fast. GIFs are kept as they are (animation). */
async function shrinkImage(file) {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1_500_000 && /^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/webp', 0.86));
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ---------------- The app ---------------- */

function dateTile(ts) {
  const d = new Date(ts || Date.now());
  return `<span class="nt-tile"><i>${d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</i><b>${d.getDate()}</b></span>`;
}

registerApp({
  id: 'notes',
  name: 'Notes',
  icon: 'note',
  color: 'yellow',
  size: [1120, 740],
  min: [560, 380],
  newLabel: 'Note',
  create(win, d = {}) {
    const n = store.save('notes', { title: d.title || '', body: '<p><br></p>', text: '', format: 'html' });
    win.select(n.id, true);
  },
  openRecord: (win, id) => win.select(id),
  mount(win) {
    let sel = null;
    let q = '';
    let sidebar = true;
    let recording = null;
    const audio = new Map(); // media id -> { el, player }

    win.body.innerHTML = `<div class="nt">
      <div class="nt-bar">
        <div class="nt-group">
          <button class="nt-btn" data-nav="prev" title="Previous note">${ico('up', 15)}</button>
          <button class="nt-btn" data-nav="next" title="Next note">${ico('down', 15)}</button>
        </div>
        <button class="nt-btn nt-round" data-nav="sidebar" title="Show or hide the list">${ico('sidebar', 15)}</button>
        <button class="nt-pill" data-act="new">New Note</button>
        <div class="nt-group nt-format">
          <button class="nt-btn nt-color" data-menu="color" title="Text color"><i class="nt-dot"></i>${ico('chev', 11)}</button>
          <span class="nt-sep"></span>
          <button class="nt-btn nt-text" data-menu="size" title="Text size">Aa</button>
          <button class="nt-btn nt-text nt-block" data-menu="block" title="Paragraph style"><span>Aa</span>${ico('chev', 11)}</button>
          <span class="nt-sep"></span>
          <button class="nt-btn nt-text" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button class="nt-btn nt-text" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button class="nt-btn nt-text" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button class="nt-btn nt-text" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <span class="nt-sep"></span>
          <button class="nt-btn" data-cmd="justifyLeft" title="Align left">${ico('alignL', 15)}</button>
          <button class="nt-btn" data-cmd="justifyCenter" title="Center">${ico('alignC', 15)}</button>
          <button class="nt-btn" data-cmd="justifyRight" title="Align right">${ico('alignR', 15)}</button>
          <span class="nt-sep"></span>
          <button class="nt-btn" data-cmd="insertUnorderedList" title="Bulleted list">${ico('bullets', 15)}</button>
          <button class="nt-btn" data-cmd="insertOrderedList" title="Numbered list">${ico('numbers', 15)}</button>
          <button class="nt-btn" data-act="checklist" title="Checklist">${ico('checks', 15)}</button>
        </div>
        <div class="nt-group">
          <button class="nt-btn nt-mic" data-act="record" title="Record a voice memo">${ico('mic', 15)}<span class="nt-rec-time"></span></button>
          <button class="nt-btn" data-act="link" title="Link (Ctrl+K)">${ico('link', 15)}</button>
          <button class="nt-btn" data-menu="highlight" title="Highlight">${ico('marker', 15)}</button>
          <button class="nt-btn" data-act="table" title="Insert a table">${ico('table', 15)}</button>
          <button class="nt-btn" data-act="image" title="Insert an image">${ico('image', 15)}</button>
        </div>
        <input type="file" accept="image/*" multiple hidden data-file>
      </div>
      <div class="nt-main">
        <aside class="nt-side">
          <label class="nt-search">${icon('search', 13)}<input type="search" placeholder="Search" spellcheck="false"></label>
          <div class="nt-list"></div>
        </aside>
        <section class="nt-page"></section>
      </div>
    </div>`;

    const root = $('.nt', win.body);
    const bar = $('.nt-bar', root);
    const listEl = $('.nt-list', root);
    const page = $('.nt-page', root);
    let titleEl = null;
    let ed = null;

    const notes = () =>
      store
        .all('notes')
        .filter((n) => !q || recordMatches('notes', n, q))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));

    /* ----- List ----- */

    const drawList = () => {
      const list = notes();
      if (!list.length) {
        listEl.innerHTML = `<div class="nt-empty-list">${q ? 'No matching notes.' : 'No notes yet.'}</div>`;
        return;
      }
      let group = '';
      listEl.innerHTML = list
        .map((n) => {
          const g = n.pinned ? 'Pinned' : new Date(n.updatedAt || Date.now()).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
          const head = g !== group ? `<h5>${esc(g)}</h5>` : '';
          group = g;
          return `${head}<button class="nt-item ${n.id === sel ? 'on' : ''}" data-id="${n.id}">
            ${dateTile(n.updatedAt)}<span class="nt-item-text"><b>${n.meeting ? icon('calendar', 11) + ' ' : ''}${esc(sc.title(n))}</b><small>${esc(preview(n) || 'No additional text')}</small></span></button>`;
        })
        .join('');
    };

    /* ----- Page ----- */

    const save = debounce(() => {
      const n = store.get('notes', sel);
      if (!n || !ed) return;
      const html = serialize();
      const text = ed.innerText.replace(/\n{3,}/g, '\n\n').trim();
      const title = titleEl.value;
      if (n.format === 'html' && html === n.body && title === (n.title || '')) return;
      store.save('notes', { ...n, title, body: html, text, format: 'html' });
    }, 450);

    /** The editor's HTML for storage: players and temporary image URLs stripped, then sanitized. */
    function serialize() {
      const c = ed.cloneNode(true);
      for (const a of c.querySelectorAll('.nt-audio')) {
        a.replaceChildren();
        a.removeAttribute('contenteditable');
      }
      for (const img of c.querySelectorAll('img[data-media]')) img.removeAttribute('src');
      for (const img of c.querySelectorAll('img.uploading')) img.remove();
      return clean(c.innerHTML);
    }

    function hydrate(scope = ed) {
      for (const img of scope.querySelectorAll('img[data-media]')) {
        if (img.src) continue;
        mediaUrl(img.dataset.media)
          .then((u) => (img.src = u))
          .catch(() => img.classList.add('missing'));
      }
      for (const a of scope.querySelectorAll('.nt-audio')) {
        if (a.querySelector('.nt-play')) continue;
        a.setAttribute('contenteditable', 'false');
        const peaks = (a.dataset.peaks || '').split(',').map(Number).filter((x) => x >= 0);
        const bars = (peaks.length ? peaks : Array(40).fill(4)).map((p) => `<i style="height:${Math.max(12, Math.min(100, p * 10))}%"></i>`).join('');
        a.innerHTML = `<button class="nt-play" type="button" title="Play">${ico('play', 14)}</button><span class="nt-wave">${bars}</span><span class="nt-dur">${fmtTime(Number(a.dataset.duration) || 0)}</span>`;
      }
    }

    const drawPage = () => {
      for (const { player } of audio.values()) player.pause();
      audio.clear();
      const n = store.get('notes', sel);
      if (!n) {
        ed = titleEl = null;
        page.innerHTML = `<div class="nt-blank"><div class="empty-title">No note selected</div><p>Pick a note or start a new one.</p>
          <button class="btn primary" data-act="new">${icon('plus', 13)} New note</button></div>`;
        return;
      }
      page.innerHTML = `<div class="nt-doc">
          <div class="nt-meta">
            <small>${esc(new Date(n.updatedAt || Date.now()).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }))}</small>
            <span class="grow"></span>
            <button class="nt-btn ${n.pinned ? 'on' : ''}" data-act="pin" title="${n.pinned ? 'Unpin' : 'Pin to the top'}">${icon('pin', 14)}</button>
            <button class="nt-btn" data-act="delete" title="Delete note">${icon('trash', 14)}</button>
          </div>
          <input class="nt-title" placeholder="Title" value="${esc(n.title || '')}" spellcheck="true">
          <div class="nt-editor" contenteditable="true" spellcheck="true" data-placeholder="Start writing… (# for a heading, - for a list, [] for a checklist)">${noteHtml(n)}</div>
        </div>`;
      titleEl = $('.nt-title', page);
      ed = $('.nt-editor', page);
      document.execCommand('defaultParagraphSeparator', false, 'p');
      hydrate();
      markEmpty();
      updateBar();
    };

    win.select = (id, focusTitle) => {
      save.flush?.();
      sel = id;
      drawList();
      drawPage();
      setTimeout(() => (focusTitle ? titleEl : ed)?.focus(), 30);
    };

    /* ----- Formatting ----- */

    let savedRange = null;
    const inEditor = (node) => !!ed && !!node && ed.contains(node.nodeType === 1 ? node : node.parentNode);
    const keepSelection = () => {
      const s = getSelection();
      if (s.rangeCount && inEditor(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    };
    const restoreSelection = () => {
      if (!ed) return false;
      // The live selection wins when it's already in the note; the saved one is only for when focus left
      // (a toolbar menu, the link box, the file picker).
      const live = getSelection();
      if (document.activeElement === ed && live.rangeCount && inEditor(live.anchorNode)) return true;
      ed.focus();
      if (savedRange && inEditor(savedRange.startContainer)) {
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(savedRange);
      }
      return true;
    };
    const exec = (cmd, value = null) => {
      if (!restoreSelection()) return;
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(cmd, false, value);
      keepSelection();
      save();
      updateBar();
    };
    const blockOf = (node) => {
      while (node && node !== ed) {
        if (node.nodeType === 1 && /^(P|H1|H2|H3|BLOCKQUOTE|PRE|LI|DIV|TD|TH)$/.test(node.tagName)) return node;
        node = node.parentNode;
      }
      return null;
    };

    /** Apply a CSS property to the selection; '' removes it (uses a marker color, then cleans it up). */
    function styleSelection(cmd, prop, value) {
      const MARK = 'rgb(1, 2, 3)';
      exec(cmd, value || MARK);
      if (value) return;
      for (const elx of ed.querySelectorAll('[style]')) {
        const v = elx.style.getPropertyValue(prop);
        if (v && v.replace(/\s/g, '') === MARK.replace(/\s/g, '')) elx.style.removeProperty(prop);
        if (!elx.getAttribute('style')) elx.removeAttribute('style');
      }
      save();
    }

    function setSize(px) {
      exec('fontSize', '7');
      for (const s of ed.querySelectorAll('span[style*="xxx-large"], font[size="7"]')) {
        if (s.tagName === 'FONT') {
          const span = document.createElement('span');
          span.append(...s.childNodes);
          s.replaceWith(span);
          if (px) span.style.fontSize = px;
          continue;
        }
        if (px) s.style.fontSize = px;
        else s.style.removeProperty('font-size');
        if (!s.getAttribute('style')) s.removeAttribute('style');
      }
      save();
    }

    function setBlock(tag) {
      exec('formatBlock', tag);
    }

    function toggleChecklist() {
      if (!restoreSelection()) return;
      const li = blockOf(getSelection().anchorNode);
      const list = li?.closest?.('ul, ol');
      if (list?.classList.contains('checklist')) {
        exec('insertUnorderedList'); // turns the list off
        return;
      }
      if (!list || list.tagName !== 'UL') exec('insertUnorderedList');
      const ul = blockOf(getSelection().anchorNode)?.closest?.('ul');
      if (ul) {
        ul.classList.add('checklist');
        for (const item of ul.children) if (!item.hasAttribute('data-checked')) item.setAttribute('data-checked', 'false');
      }
      save();
    }

    function insertHtml(html) {
      if (!restoreSelection()) return;
      document.execCommand('insertHTML', false, html);
      keepSelection();
      hydrate();
      save();
    }

    function insertTable() {
      const row = '<tr><td><br></td><td><br></td><td><br></td></tr>';
      insertHtml(`<table class="nt-table"><tbody>${row.replace(/td>/g, 'th>')}${row}${row}</tbody></table><p><br></p>`);
    }

    /* ----- Links: a small inline box instead of a dialog ----- */

    function linkBox() {
      if (!restoreSelection()) return;
      keepSelection();
      const a = getSelection().anchorNode?.parentElement?.closest('a');
      const btn = $('[data-act=link]', bar);
      const r = btn.getBoundingClientRect();
      const box = el(`<form class="nt-linkbox"><input type="url" placeholder="Paste or type a link" spellcheck="false" value="${esc(a?.getAttribute('href') || '')}">
        <button class="btn small primary">${a ? 'Update' : 'Add'}</button>${a ? '<button type="button" class="btn small" data-unlink>Remove</button>' : ''}</form>`);
      document.body.append(box);
      placePopup(box, r.left, r.bottom + 6, { flipTo: r.top - 6, near: { x: r.left, y: r.top } });
      const input = $('input', box);
      setTimeout(() => input.focus(), 0);
      const close = () => {
        box.remove();
        removeEventListener('pointerdown', outside, true);
      };
      const outside = (e) => !box.contains(e.target) && close();
      addEventListener('pointerdown', outside, true);
      box.addEventListener('keydown', (e) => e.key === 'Escape' && (close(), restoreSelection()));
      box.addEventListener('click', (e) => {
        if (!e.target.closest('[data-unlink]')) return;
        close();
        if (a) {
          a.replaceWith(...a.childNodes);
          save();
        }
      });
      box.addEventListener('submit', (e) => {
        e.preventDefault();
        let href = input.value.trim();
        close();
        if (!href) return;
        if (!/^(https?:|mailto:)/i.test(href)) href = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href) ? 'mailto:' : 'https://') + href;
        if (a) {
          a.setAttribute('href', href);
          save();
          return;
        }
        const sel2 = savedRange && !savedRange.collapsed;
        if (sel2) exec('createLink', href);
        else insertHtml(`<a href="${esc(href)}">${esc(href.replace(/^mailto:/, ''))}</a>&nbsp;`);
      });
    }

    const openLink = (href) => (shell ? openWebPage(href) : window.open(href, '_blank', 'noopener'));

    /* ----- Images ----- */

    async function addImages(files) {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        let blob;
        try {
          blob = await shrinkImage(file);
        } catch {
          toast('That image couldn’t be read', 'error');
          continue;
        }
        const tmp = URL.createObjectURL(blob);
        const token = 'up' + Math.random().toString(36).slice(2);
        insertHtml(`<img class="nt-img uploading" data-tmp="${token}" src="${tmp}" alt="">`);
        const img = ed?.querySelector(`img[data-tmp="${token}"]`);
        try {
          const id = await uploadMedia(blob);
          mediaCache.set(id, Promise.resolve(tmp));
          if (img) {
            img.dataset.media = id;
            img.classList.remove('uploading');
            img.removeAttribute('data-tmp');
          }
        } catch (err) {
          if (store.mode !== 'cloud' && blob.size < 1_500_000 && img) {
            // Working offline: keep a small image inside the note itself.
            img.src = await blobToDataUrl(blob);
            img.classList.remove('uploading');
            img.removeAttribute('data-tmp');
          } else {
            img?.remove();
            toast(`Image not added: ${err.message}`, 'error');
          }
        }
        save();
      }
    }

    /* ----- Voice memos ----- */

    async function toggleRecord() {
      const btn = $('[data-act=record]', bar);
      if (recording) return recording.stop();
      if (!ed) return toast('Open a note first');
      keepSelection();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        return toast('Leafdeck couldn’t use the microphone', 'error');
      }
      const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 48000 });
      const chunks = [];
      const started = Date.now();
      const label = $('.nt-rec-time', btn);
      const tick = setInterval(() => {
        const s = (Date.now() - started) / 1000;
        label.textContent = fmtTime(s);
        if (s >= 15 * 60) mr.stop(); // 15-minute cap
      }, 250);
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        clearInterval(tick);
        stream.getTracks().forEach((t) => t.stop());
        btn.classList.remove('recording');
        label.textContent = '';
        recording = null;
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (blob.size < 1000) return;
        // Waveform: 40 bars from the recording's loudness.
        let duration = (Date.now() - started) / 1000;
        let peaks = [];
        try {
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
          ctx.close();
          duration = buf.duration || duration;
          const data = buf.getChannelData(0);
          const step = Math.max(1, Math.floor(data.length / 40));
          for (let i = 0; i < 40; i++) {
            let max = 0;
            for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 8) max = Math.max(max, Math.abs(data[j]));
            peaks.push(max);
          }
          const top = Math.max(...peaks, 0.01);
          peaks = peaks.map((p) => Math.max(1, Math.round((p / top) * 10)));
        } catch {}
        toast('Saving voice memo…');
        try {
          const id = await uploadMedia(blob);
          mediaCache.set(id, Promise.resolve(URL.createObjectURL(blob)));
          insertHtml(`<div class="nt-audio" data-media="${id}" data-duration="${Math.round(duration)}" data-peaks="${peaks.join(',')}"></div><p><br></p>`);
        } catch (err) {
          toast(`Voice memo not saved: ${err.message}`, 'error');
        }
      };
      mr.start(1000);
      recording = mr;
      btn.classList.add('recording');
      btn.title = 'Stop recording';
    }

    async function playAudio(block) {
      const id = block.dataset.media;
      let rec = audio.get(id);
      if (!rec) {
        let src;
        try {
          src = await mediaUrl(id);
        } catch (err) {
          return toast(err.message, 'error');
        }
        const player = new Audio(src);
        rec = { player, block };
        audio.set(id, rec);
        const bars = $$('.nt-wave i', block);
        player.addEventListener('timeupdate', () => {
          const d = player.duration && isFinite(player.duration) ? player.duration : Number(block.dataset.duration) || 1;
          const at = Math.floor((player.currentTime / d) * bars.length);
          bars.forEach((b, i) => b.classList.toggle('on', i < at));
          $('.nt-dur', block).textContent = fmtTime(Math.max(0, d - player.currentTime));
        });
        const sync = () => ($('.nt-play', block).innerHTML = ico(player.paused ? 'play' : 'pause', 14));
        player.addEventListener('play', sync);
        player.addEventListener('pause', sync);
        player.addEventListener('ended', () => {
          bars.forEach((b) => b.classList.remove('on'));
          $('.nt-dur', block).textContent = fmtTime(Number(block.dataset.duration) || 0);
        });
      }
      for (const [k, o] of audio) if (k !== id) o.player.pause();
      if (rec.player.paused) rec.player.play();
      else rec.player.pause();
    }

    /* ----- Toolbar state ----- */

    const updateBar = () => {
      const s = getSelection();
      const active = ed && s.rangeCount && inEditor(s.anchorNode);
      for (const b of $$('[data-cmd]', bar)) {
        let on = false;
        try {
          on = active && document.queryCommandState(b.dataset.cmd);
        } catch {}
        b.classList.toggle('on', !!on);
      }
      const blk = active ? blockOf(s.anchorNode) : null;
      const tag = blk?.closest?.('h1, h2, h3, blockquote, pre')?.tagName || 'P';
      $('.nt-block span', bar).textContent = BLOCKS.find((x) => x[0] === tag)?.[2] || 'Aa';
      $('[data-act=checklist]', bar).classList.toggle('on', !!blk?.closest?.('ul.checklist'));
      let color = '';
      try {
        color = active ? document.queryCommandValue('foreColor') : '';
      } catch {}
      $('.nt-dot', bar).style.background = color && active ? color : '';
    };

    const onSelection = () => {
      if (!ed) return;
      keepSelection();
      updateBar();
    };
    document.addEventListener('selectionchange', onSelection);
    win.cleanups.push(() => document.removeEventListener('selectionchange', onSelection));
    win.cleanups.push(() => {
      save.flush?.();
      recording?.stop();
      for (const { player } of audio.values()) player.pause();
    });

    /* ----- Menus from the toolbar ----- */

    const menuAt = (btn, items) => {
      const r = btn.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, items, { owner: btn });
    };
    const MENUS = {
      color: (b) => menuAt(b, COLORS.map(([label, v]) => ({ label, act: () => styleSelection('foreColor', 'color', v) }))),
      highlight: (b) => menuAt(b, HIGHLIGHTS.map(([label, v]) => ({ label, act: () => styleSelection('hiliteColor', 'background-color', v) }))),
      size: (b) => menuAt(b, SIZES.map(([label, v]) => ({ label, act: () => setSize(v) }))),
      block: (b) => menuAt(b, BLOCKS.map(([tag, label]) => ({ label, act: () => setBlock(tag) }))),
    };

    // Toolbar buttons must not take focus away from the text you're formatting.
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.cmd) return exec(b.dataset.cmd);
      if (b.dataset.menu) return MENUS[b.dataset.menu](b);
      const nav = b.dataset.nav;
      if (nav === 'sidebar') {
        sidebar = !sidebar;
        root.classList.toggle('no-side', !sidebar);
        return;
      }
      if (nav === 'prev' || nav === 'next') {
        const list = notes();
        const i = list.findIndex((n) => n.id === sel);
        const next = list[i + (nav === 'next' ? 1 : -1)];
        if (next) win.select(next.id);
        return;
      }
      const act = b.dataset.act;
      if (act === 'checklist') return toggleChecklist();
      if (act === 'record') return toggleRecord();
      if (act === 'link') return linkBox();
      if (act === 'table') return insertTable();
      if (act === 'image') {
        keepSelection();
        return $('[data-file]', bar).click();
      }
    });
    $('[data-file]', bar).addEventListener('change', (e) => {
      addImages([...e.target.files]);
      e.target.value = '';
    });

    /* ----- Editing ----- */

    // Markdown-style shortcuts at the start of a line, triggered by the space after them.
    const SHORTCUTS = { '#': 'H1', '##': 'H2', '###': 'H3', '>': 'BLOCKQUOTE', '```': 'PRE' };
    function shortcut(e) {
      if (e.key !== ' ') return false;
      const s = getSelection();
      if (!s.isCollapsed || !s.rangeCount) return false;
      const blk = blockOf(s.anchorNode);
      if (!blk || blk.tagName === 'PRE') return false;
      const before = blk.textContent.slice(0, s.anchorOffset);
      if (s.anchorNode.nodeType !== 3 || blk.firstChild !== s.anchorNode && blk.textContent.indexOf(before) !== 0) return false;
      const marker = before.trim();
      const kind = SHORTCUTS[marker] || ({ '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'check', '[ ]': 'check' })[marker];
      if (!kind || before !== marker) return false;
      e.preventDefault();
      s.anchorNode.textContent = s.anchorNode.textContent.slice(marker.length);
      if (!blk.textContent) blk.innerHTML = '<br>';
      const r = document.createRange();
      r.setStart(blk.firstChild || blk, 0);
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
      keepSelection();
      if (kind === 'ul') {
        exec('insertUnorderedList');
        // Chromium joins a new list onto an adjacent one; a bullet list next to a checklist stays its own list.
        const li = blockOf(getSelection().anchorNode)?.closest?.('li');
        const ul = li?.parentNode;
        if (li && ul?.classList?.contains('checklist') && !li.hasAttribute('data-checked')) {
          const after = [...ul.children].slice([...ul.children].indexOf(li));
          const plain = document.createElement('ul');
          plain.append(...after.filter((x) => !x.hasAttribute('data-checked')));
          ul.after(plain);
          const rest = after.filter((x) => x.hasAttribute('data-checked'));
          if (rest.length) {
            const tail = document.createElement('ul');
            tail.className = 'checklist';
            tail.append(...rest);
            plain.after(tail);
          }
          if (!ul.children.length) ul.remove();
          const r2 = document.createRange();
          r2.selectNodeContents(li);
          r2.collapse(true);
          getSelection().removeAllRanges();
          getSelection().addRange(r2);
          save();
        }
      } else if (kind === 'ol') exec('insertOrderedList');
      else if (kind === 'check') toggleChecklist();
      else setBlock(kind);
      return true;
    }

    function tableKey(e) {
      if (e.key !== 'Tab') return false;
      const cell = blockOf(getSelection().anchorNode)?.closest?.('td, th');
      if (!cell) return false;
      e.preventDefault();
      const cells = [...cell.closest('table').querySelectorAll('td, th')];
      let i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
      if (i >= cells.length) {
        const tr = cell.closest('tr');
        const row = tr.cloneNode(true);
        row.querySelectorAll('td, th').forEach((c) => {
          const td = document.createElement('td');
          td.innerHTML = '<br>';
          c.replaceWith(td);
        });
        tr.parentNode.append(row);
        save();
        i = cells.length;
      }
      const target = [...cell.closest('table').querySelectorAll('td, th')][Math.max(0, i)];
      const r = document.createRange();
      r.selectNodeContents(target);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    }

    page.addEventListener('keydown', (e) => {
      if (e.target === titleEl && e.key === 'Enter') {
        e.preventDefault();
        ed.focus();
        return;
      }
      if (e.target !== ed && !ed?.contains(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        return linkBox();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        return exec('strikeThrough');
      }
      if (shortcut(e) || tableKey(e)) return;
      // Enter on an empty checklist item ends the list; new items start unchecked.
      if (e.key === 'Enter' && !e.shiftKey) {
        const li = blockOf(getSelection().anchorNode)?.closest?.('ul.checklist > li');
        if (li) setTimeout(() => {
          for (const item of li.parentNode?.children || []) if (!item.hasAttribute('data-checked')) item.setAttribute('data-checked', 'false');
          const cur = blockOf(getSelection().anchorNode)?.closest?.('ul.checklist > li');
          if (cur && cur !== li) cur.setAttribute('data-checked', 'false');
        }, 0);
      }
    });

    const markEmpty = () => ed?.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img, .nt-audio, table, li, hr'));
    page.addEventListener('input', (e) => {
      if (e.target === titleEl || e.target === ed || ed?.contains(e.target)) save();
      markEmpty();
    });

    page.addEventListener('paste', (e) => {
      if (!ed || !ed.contains(e.target)) return;
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        keepSelection();
        return addImages(files);
      }
      const html = e.clipboardData?.getData('text/html');
      if (html) {
        e.preventDefault();
        document.execCommand('insertHTML', false, clean(html.replace(/<!--[\s\S]*?-->/g, '')));
        hydrate();
        save();
      }
    });

    page.addEventListener('dragover', (e) => {
      if (ed && [...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) e.preventDefault();
    });
    page.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!ed || !files.length) return;
      e.preventDefault();
      const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (r && inEditor(r.startContainer)) savedRange = r;
      addImages(files);
    });

    page.addEventListener('click', (e) => {
      const play = e.target.closest('.nt-play');
      if (play) return playAudio(play.closest('.nt-audio'));
      const wave = e.target.closest('.nt-wave');
      if (wave) {
        const rec = audio.get(wave.closest('.nt-audio').dataset.media);
        if (rec?.player.duration && isFinite(rec.player.duration)) {
          const r = wave.getBoundingClientRect();
          rec.player.currentTime = ((e.clientX - r.left) / r.width) * rec.player.duration;
        }
        return;
      }
      // Checklist boxes are drawn in the item's left margin.
      const li = e.target.closest('ul.checklist > li');
      if (li && e.offsetX < 0 && e.target === li) {
        li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
        save();
        return;
      }
      // The H1/H2/H3 label in a heading's left margin opens the paragraph-style menu for that block.
      const h = e.target.closest('.nt-editor h1, .nt-editor h2, .nt-editor h3');
      if (h && e.offsetX < 0 && e.target === h) {
        const r = document.createRange();
        r.selectNodeContents(h);
        r.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        keepSelection();
        showMenu(e.clientX, e.clientY + 8, BLOCKS.map(([tag, label]) => ({ label, checked: tag === h.tagName, act: () => setBlock(tag) })));
        return;
      }
      const a = e.target.closest('.nt-editor a[href]');
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openLink(a.href);
      }
    });

    page.addEventListener('contextmenu', (e) => {
      if (!ed || !ed.contains(e.target)) return;
      const a = e.target.closest('a[href]');
      const cell = e.target.closest('td, th');
      if (!a && !cell) return;
      e.preventDefault();
      e.stopPropagation();
      const items = [];
      if (a) items.push({ label: 'Open link', act: () => openLink(a.href) }, { label: 'Edit link…', act: () => linkBox() }, { label: 'Remove link', act: () => (a.replaceWith(...a.childNodes), save()) });
      if (cell) {
        const tr = cell.closest('tr');
        const table = cell.closest('table');
        const col = [...tr.children].indexOf(cell);
        const blank = (tag = 'td') => {
          const c = document.createElement(tag);
          c.innerHTML = '<br>';
          return c;
        };
        if (a) items.push('-');
        items.push(
          { label: 'Add row below', act: () => { const row = document.createElement('tr'); [...tr.children].forEach(() => row.append(blank())); tr.after(row); save(); } },
          { label: 'Add column right', act: () => { for (const r of table.rows) r.children[col]?.after(blank(r.children[col]?.tagName === 'TH' ? 'th' : 'td')); save(); } },
          '-',
          { label: 'Delete row', act: () => { tr.remove(); if (!table.rows.length) table.remove(); save(); } },
          { label: 'Delete column', act: () => { for (const r of [...table.rows]) r.children[col]?.remove(); if (!table.rows[0]?.children.length) table.remove(); save(); } },
          { label: 'Delete table', act: () => { table.remove(); save(); } },
        );
      }
      showMenu(e.clientX, e.clientY, items);
    });

    win.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act=new]')) {
        save.flush?.();
        return this.create(win);
      }
      if (e.target.closest('[data-act=pin]')) {
        save.flush?.();
        const n = store.get('notes', sel);
        store.save('notes', { ...n, pinned: !n.pinned });
        e.target.closest('[data-act=pin]').classList.toggle('on', !n.pinned);
        return;
      }
      const del = e.target.closest('[data-act=delete]');
      if (del) {
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm');
          del.title = 'Click again to delete';
          setTimeout(() => del.isConnected && del.classList.remove('confirm'), 3000);
          return;
        }
        store.remove('notes', sel);
        sel = notes()[0]?.id || null;
        drawList();
        drawPage();
      }
    });

    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b && b.dataset.id !== sel) win.select(b.dataset.id);
    });
    listEl.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      e.preventDefault();
      const n = store.get('notes', b.dataset.id);
      showMenu(e.clientX, e.clientY, [
        { label: n.pinned ? 'Unpin' : 'Pin to the top', act: () => store.save('notes', { ...n, pinned: !n.pinned }) },
        { label: 'Delete note', act: () => { store.remove('notes', n.id); if (n.id === sel) { sel = notes()[0]?.id || null; drawPage(); } } },
      ]);
    });
    $('.nt-search input', root).addEventListener('input', (e) => {
      q = e.target.value;
      drawList();
    });

    // Saves from this window only refresh the list; the page is left alone so typing isn't disturbed.
    win.watch(['notes', 'settings'], () => {
      drawList();
      if (sel && !store.get('notes', sel)) {
        sel = notes()[0]?.id || null;
        drawPage();
      }
    });

    sel = notes()[0]?.id || null;
    drawList();
    drawPage();
  },
});
