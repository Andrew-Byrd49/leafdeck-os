// Designer's Layers panel: the tree, top-most first as in Figma. Click selects (Ctrl toggles, Shift adds), double-click
// renames, the eye and lock show on hover, and dragging a row reorders it or drops it into a frame.
import { esc } from '../util.js';
import { glyph } from './glyphs.js';
import { layoutOf, STATES } from './model.js';

export function createLayers(panel, ed, opts = {}) {
  const open = new Set(); // expanded frames
  let renaming = null;
  let dragId = null;

  const iconFor = (n) => {
    if (n.variant) return glyph('state', 14);
    if (n.ref) return glyph('ref', 14);
    if (n.type === 'frame') {
      const L = layoutOf(n);
      if (L) return glyph(L.mode === 'column' ? 'column' : 'row', 14);
      return glyph(!ed.parentOf(n.id) ? 'component' : n.fills?.length || n.stroke ? 'frame' : 'group', 14);
    }
    return glyph(n.type, 14);
  };

  function render() {
    // Keep the selection's ancestors open, so the selected rows are visible.
    for (const id of ed.sel) for (let p = ed.parentOf(id); p; p = ed.parentOf(p.id)) open.add(p.id);
    const rows = [];
    const rec = (list, depth) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        const kids = n.children?.length;
        const isOpen = open.has(n.id) || (depth === 0 && !open.has('!' + n.id) && kids && list.length < 4);
        const on = ed.sel.includes(n.id);
        const state = n.variant ? STATES[n.variant.state]?.label || n.variant.state : '';
        rows.push(`<div class="dzl-row${on ? ' on' : ''}${n.hidden ? ' dim' : ''}${depth === 0 ? ' top' : ''}" data-id="${n.id}" draggable="true" style="--d:${depth}">
          ${kids ? `<button type="button" class="dzl-caret${isOpen ? ' open' : ''}" data-caret tabindex="-1">${glyph('caret', 12)}</button>` : '<span class="dzl-caret"></span>'}
          <span class="dzl-ic">${iconFor(n)}</span>
          <span class="dzl-name">${n.type === 'text' && !n.name ? esc(n.text.slice(0, 40)) : esc(n.name)}${state ? `<small>${esc(state)}</small>` : ''}</span>
          <span class="dzl-tools${n.locked || n.hidden ? ' keep' : ''}">
            <button type="button" data-lock title="${n.locked ? 'Unlock' : 'Lock'}" class="${n.locked ? 'set' : ''}" tabindex="-1">${glyph(n.locked ? 'lock' : 'unlock', 14)}</button>
            <button type="button" data-eye title="${n.hidden ? 'Show' : 'Hide'}" class="${n.hidden ? 'set' : ''}" tabindex="-1">${glyph(n.hidden ? 'eye-off' : 'eye', 14)}</button>
          </span>
        </div>`);
        if (kids && isOpen) rec(n.children, depth + 1);
      }
    };
    rec(ed.doc.nodes, 0);
    panel.innerHTML = rows.length ? rows.join('') : `<p class="dzl-empty">No layers yet. Draw a frame with <kbd>F</kbd>, pick a template, or capture an element with <kbd>C</kbd>.</p>`;
    panel.querySelector('.dzl-row.on')?.scrollIntoView({ block: 'nearest' });
  }

  function rename(id) {
    const row = panel.querySelector(`.dzl-row[data-id="${id}"] .dzl-name`);
    const n = ed.node(id);
    if (!row || !n) return;
    renaming = id;
    const input = document.createElement('input');
    input.className = 'dzl-rename';
    input.value = n.name;
    row.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (renaming !== id) return;
      renaming = null;
      const v = input.value.trim();
      if (save && v && v !== n.name) {
        ed.checkpoint();
        n.name = v;
        // A component's states follow its name.
        for (const s of ed.doc.nodes.filter((x) => x.variant?.of === id)) s.name = `${v} / ${s.name.split('/').pop().trim()}`;
        ed.commit();
      } else render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }

  panel.addEventListener('click', (e) => {
    const row = e.target.closest('.dzl-row');
    if (!row) return ed.select([]);
    const id = row.dataset.id;
    const n = ed.node(id);
    if (e.target.closest('[data-caret]')) {
      const isOpen = e.target.closest('[data-caret]').classList.contains('open');
      if (isOpen) open.delete(id), open.add('!' + id);
      else open.add(id), open.delete('!' + id);
      return render();
    }
    if (e.target.closest('[data-eye]') || e.target.closest('[data-lock]')) {
      const prop = e.target.closest('[data-eye]') ? 'hidden' : 'locked';
      ed.checkpoint();
      if (n[prop]) delete n[prop];
      else n[prop] = true;
      return ed.commit();
    }
    if (e.ctrlKey || e.metaKey) ed.select([id], { toggle: true });
    else if (e.shiftKey) ed.select([id], { add: true });
    else ed.select([id]);
    ed.viewport.focus({ preventScroll: true });
  });
  panel.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.dzl-row');
    if (row && e.target.closest('.dzl-name')) rename(row.dataset.id);
    else if (row && !e.target.closest('button')) ed.fit([row.dataset.id], { max: 4 });
  });
  panel.addEventListener('pointerover', (e) => {
    const row = e.target.closest('.dzl-row');
    ed.hoverLayer(row ? row.dataset.id : null);
  });
  panel.addEventListener('pointerleave', () => ed.hoverLayer(null));

  /* ----- drag to reorder / move into a frame ----- */

  const clear = () => panel.querySelectorAll('.drop-above, .drop-below, .drop-inside').forEach((r) => r.classList.remove('drop-above', 'drop-below', 'drop-inside'));
  const zone = (row, e) => {
    const r = row.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const n = ed.node(row.dataset.id);
    if (n?.type === 'frame' && f > 0.28 && f < 0.72) return 'inside';
    return f < 0.5 ? 'above' : 'below';
  };
  panel.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.dzl-row');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    if (!ed.sel.includes(dragId)) ed.select([dragId]);
  });
  panel.addEventListener('dragover', (e) => {
    const row = e.target.closest('.dzl-row');
    if (!dragId || !row) return;
    const target = row.dataset.id;
    if (target === dragId || isInside(dragId, target)) return;
    e.preventDefault();
    clear();
    row.classList.add('drop-' + zone(row, e));
  });
  panel.addEventListener('dragleave', (e) => !panel.contains(e.relatedTarget) && clear());
  panel.addEventListener('drop', (e) => {
    const row = e.target.closest('.dzl-row');
    clear();
    if (!dragId || !row) return;
    e.preventDefault();
    const target = row.dataset.id;
    if (target === dragId || isInside(dragId, target)) return;
    const z = zone(row, e);
    const ids = ed.topSel().includes(dragId) ? ed.topSel() : [dragId];
    ed.checkpoint();
    for (const id of ids) {
      if (id === target || isInside(id, target)) continue;
      if (z === 'inside') {
        ed.reparent(id, target, null);
        open.add(target);
      } else {
        const p = ed.parentOf(target);
        const list = p ? p.children : ed.doc.nodes;
        let index = list.findIndex((n) => n.id === target) + (z === 'above' ? 1 : 0); // the list is drawn top-most first
        const cur = ed.parentOf(id);
        const curList = cur ? cur.children : ed.doc.nodes;
        if (curList === list && list.findIndex((n) => n.id === id) < index) index--;
        ed.reparent(id, p ? p.id : null, index);
      }
    }
    dragId = null;
    ed.commit();
  });
  panel.addEventListener('dragend', () => {
    dragId = null;
    clear();
  });
  const isInside = (a, b) => {
    for (let p = ed.parentOf(b); p; p = ed.parentOf(p.id)) if (p.id === a) return true;
    return false;
  };

  ed.on('select', () => !renaming && render());
  ed.on('change', () => !renaming && render());
  ed.on('rename', (id) => id && rename(id));
  render();
  return { render, rename };
}
