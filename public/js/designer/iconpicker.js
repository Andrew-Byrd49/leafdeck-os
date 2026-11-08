// Designer's icon library: about 8,400 icons from Lucide and Tabler (icons.json, built by scripts/designer-icons.mjs,
// loaded the first time the panel opens). Search by name or tag; click inserts the icon as an SVG layer drawn in
// currentColor (so the layer's color sets it), or drag it onto the canvas or into a frame. Its color is the one chosen
// in the panel, or (Auto) the color of the text it goes next to.
import { esc } from '../util.js';
import { glyph } from './glyphs.js';

export const ICON_MIME = 'application/x-leafdeck-icon';
const PREFS = 'designer:icons';
const PAGE = 240;

let lib = null;
/** The library: { sets, icons: [{ set, name, body, tags, key }] }, loaded once. */
export function loadIcons() {
  lib ??= fetch(new URL('./icons.json', import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`The icon library didn’t load (${r.status})`);
      return r.json();
    })
    .then((d) => ({ sets: d.sets, icons: d.icons.map(([set, name, body, tags]) => ({ set, name, body, tags, key: `${set}/${name}` })) }))
    .catch((err) => {
      lib = null;
      throw err;
    });
  return lib;
}

/** An icon as standalone SVG markup, `size` pixels, its strokes `stroke` wide (outline sets). */
export function iconSvg(sets, ic, { size = 24, stroke = 2 } = {}) {
  const attrs = sets[ic.set].svg.replace(/stroke-width="[\d.]+"/, `stroke-width="${stroke}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ${attrs}>${ic.body}</svg>`;
}

const readPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREFS)) || {};
  } catch {
    return {};
  }
};

/**
 * The floating Icons panel. `opts.insert(icon, { svg, size, color, stroke })` adds a picked icon (or replaces the icon
 * being swapped: `open({ swap })`); `opts.onClose()` runs when it's closed.
 */
export function createIconPicker(host, opts = {}) {
  const prefs = { size: 24, stroke: 2, color: '', set: 'all', recent: [], ...readPrefs() }; // color '': Auto
  const save = () => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch {}
  };
  const el = document.createElement('div');
  el.className = 'dz-icons';
  el.hidden = true;
  el.innerHTML = `<header><b>Icons</b><small class="dzic-count"></small><span class="grow"></span><button type="button" class="dzi-icon" data-ic="close" title="Close (Esc)">${glyph('close', 14)}</button></header>
    <label class="dzic-search">${glyph('search', 14)}<input type="search" placeholder="Search icons (arrow, user, cart…)" spellcheck="false" aria-label="Search icons"></label>
    <div class="dzic-sets" role="tablist"></div>
    <div class="dzic-swap" hidden></div>
    <div class="dzic-grid" role="listbox" aria-label="Icons"><p class="dzic-msg">Loading icons…</p></div>
    <footer>
      <span class="dzic-name">Click to insert, or drag onto the canvas</span>
      <div class="dzic-opts">
        <label class="dzi-num" title="Size (px)"><span class="dzi-l">${glyph('rect', 12)}</span><input data-o="size" type="number" min="8" max="512" step="1"></label>
        <label class="dzi-num" title="Stroke width (outline icons)"><span class="dzi-l">${glyph('line', 12)}</span><input data-o="stroke" type="number" min="0.5" max="4" step="0.25"></label>
        <label class="dzi-color" title="Color. Empty: Auto, the color of the text it goes next to"><input type="color" class="dzic-color" data-o="color"><input data-o="hex" maxlength="7" spellcheck="false" placeholder="Auto" aria-label="Color"></label>
      </div>
      <small class="dzic-credit">Lucide (ISC) and Tabler Icons (MIT)</small>
    </footer>`;
  host.append(el);
  const $ = (s) => el.querySelector(s);
  const input = $('.dzic-search input');
  const grid = $('.dzic-grid');
  let data = null;
  let results = [];
  let shown = 0;
  let swap = null; // the layer whose icon is being replaced
  const full = (c) => (c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c);
  function drawOpts() {
    $('[data-o="size"]').value = prefs.size;
    $('[data-o="stroke"]').value = prefs.stroke;
    $('[data-o="color"]').value = full(prefs.color || '#1d1f1e');
    $('[data-o="hex"]').value = prefs.color.replace('#', '').toUpperCase();
    $('.dzic-color').classList.toggle('auto', !prefs.color);
  }
  drawOpts();

  async function open({ swap: target = null } = {}) {
    swap = target;
    el.hidden = false;
    const sw = $('.dzic-swap');
    sw.hidden = !swap;
    if (swap) sw.innerHTML = `Pick an icon to replace <b>${esc(swap.name)}</b><button type="button" class="btn small" data-ic="unswap">Insert instead</button>`;
    input.focus();
    input.select();
    if (data) return search();
    try {
      data = await loadIcons();
    } catch (err) {
      grid.innerHTML = `<p class="dzic-msg">${esc(err.message)}</p>`;
      return;
    }
    $('.dzic-count').textContent = data.icons.length.toLocaleString();
    const sets = [['all', 'All'], ...Object.entries(data.sets).map(([id, s]) => [id, s.label])];
    if (!sets.some(([id]) => id === prefs.set)) prefs.set = 'all';
    $('.dzic-sets').innerHTML = sets.map(([id, label]) => `<button type="button" data-set="${id}" role="tab">${esc(label)}</button>`).join('');
    search();
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    swap = null;
    opts.onClose?.();
  }

  /** Every word has to be in the name or the tags; names that match best come first. */
  function search() {
    if (!data) return;
    el.querySelectorAll('[data-set]').forEach((b) => b.classList.toggle('on', b.dataset.set === prefs.set));
    const words = input.value.toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
    const pool = prefs.set === 'all' ? data.icons : data.icons.filter((ic) => ic.set === prefs.set);
    if (!words.length) {
      const recent = prefs.recent.map((k) => data.icons.find((ic) => ic.key === k)).filter((ic) => ic && pool.includes(ic));
      results = [...new Set([...recent, ...pool])];
      draw(recent.length);
      return;
    }
    const q = words.join('-');
    const scored = [];
    for (const ic of pool) {
      let score = 0;
      for (const w of words) {
        if (ic.name.includes(w)) score += ic.name === w || ic.name.startsWith(w + '-') ? 4 : ic.name.startsWith(w) ? 3 : 2;
        else if (ic.tags.includes(w)) score += 1;
        else {
          score = 0;
          break;
        }
      }
      if (!score) continue;
      if (ic.name === q) score += 10;
      scored.push([score - ic.name.length / 100, ic]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    results = scored.map((s) => s[1]);
    draw(0);
  }
  function draw(recent) {
    shown = 0;
    grid.innerHTML = results.length ? '' : `<p class="dzic-msg">No icons match “${esc(input.value.trim())}”.</p>`;
    grid.scrollTop = 0;
    grid.dataset.recent = recent;
    more();
  }
  /** The next page of results (more as you scroll). */
  function more() {
    const recent = +grid.dataset.recent || 0;
    const next = results.slice(shown, shown + PAGE);
    const html = next.map((ic, j) => {
      const i = shown + j;
      const head = i === 0 && recent ? '<h5>Recent</h5>' : i === recent && recent ? '<h5>All icons</h5>' : '';
      return `${head}<button type="button" class="dzic-ic" data-i="${i}" draggable="true" title="${esc(ic.name)} · ${esc(data.sets[ic.set].label)}">${iconSvg(data.sets, ic, { size: 20, stroke: Math.min(2, prefs.stroke) })}</button>`;
    });
    grid.insertAdjacentHTML('beforeend', html.join(''));
    shown += next.length;
  }
  grid.addEventListener('scroll', () => {
    if (shown < results.length && grid.scrollTop + grid.clientHeight > grid.scrollHeight - 200) more();
  });

  /** What a pick inserts: the icon at the size, stroke and color chosen below the grid. */
  function picked(ic) {
    prefs.recent = [ic.key, ...prefs.recent.filter((k) => k !== ic.key)].slice(0, 16);
    save();
    return { svg: iconSvg(data.sets, ic, { size: prefs.size, stroke: prefs.stroke }), size: prefs.size, color: prefs.color, stroke: prefs.stroke };
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ic], [data-set], [data-i]');
    if (!b) return;
    if (b.dataset.ic === 'close') return close();
    if (b.dataset.ic === 'unswap') {
      swap = null;
      $('.dzic-swap').hidden = true;
      return;
    }
    if (b.dataset.set) {
      prefs.set = b.dataset.set;
      save();
      return search();
    }
    const ic = results[+b.dataset.i];
    if (!ic) return;
    opts.insert?.(ic, picked(ic), swap);
    if (swap) close();
  });
  el.addEventListener('dragstart', (e) => {
    const b = e.target.closest('[data-i]');
    const ic = b && results[+b.dataset.i];
    if (!ic) return;
    const p = picked(ic);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(ICON_MIME, JSON.stringify({ set: ic.set, name: ic.name, ...p }));
    e.dataTransfer.setData('text/plain', p.svg);
  });
  el.addEventListener('pointerover', (e) => {
    const b = e.target.closest('[data-i]');
    const ic = b && results[+b.dataset.i];
    $('.dzic-name').textContent = ic ? `${ic.name} · ${data.sets[ic.set].label}` : 'Click to insert, or drag onto the canvas';
  });
  input.addEventListener('input', () => search());
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') return e.preventDefault(), close();
    if (e.key === 'Enter' && e.target === input && results[0]) {
      e.preventDefault();
      opts.insert?.(results[0], picked(results[0]), swap);
      if (swap) close();
    }
  });
  el.addEventListener('change', (e) => {
    const o = e.target.dataset.o;
    if (o === 'size') prefs.size = Math.max(8, Math.min(512, Math.round(+e.target.value) || 24));
    if (o === 'stroke') prefs.stroke = Math.max(0.5, Math.min(4, +e.target.value || 2));
    if (o === 'color') prefs.color = e.target.value;
    if (o === 'hex') {
      const v = e.target.value.trim().replace(/^#/, '').toLowerCase();
      if (!v || /^auto$/.test(v)) prefs.color = '';
      else if (/^[0-9a-f]{3}([0-9a-f]{3})?$/.test(v)) prefs.color = '#' + v;
    }
    drawOpts();
    save();
    if (o === 'stroke') search();
  });
  $('[data-o="color"]').addEventListener('input', (e) => ($('[data-o="hex"]').value = e.target.value.replace('#', '').toUpperCase()));

  return {
    el,
    open,
    close,
    toggle: () => (el.hidden ? open() : close()),
    get isOpen() {
      return !el.hidden;
    },
  };
}
