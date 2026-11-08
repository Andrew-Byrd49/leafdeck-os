import { store } from '../store.js';
import { $, esc, sum, money } from '../util.js';
import { icon } from '../icons.js';
import { schemas, editRecord, recordMatches } from '../schemas.js';

export const stat = (label, value, sub = '', tone = '') =>
  `<div class="stat ${tone}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

export const empty = (title, hint, cta) =>
  `<div class="empty"><div class="empty-title">${esc(title)}</div><p>${esc(hint)}</p>${
    cta ? `<button class="btn primary" data-act="new">${icon('plus', 13)} ${esc(cta)}</button>` : ''
  }</div>`;

/** Segmented control. */
export const seg = (name, options, value) =>
  `<div class="seg" data-seg="${name}">${options
    .map(
      ([v, label, ic]) =>
        `<button type="button" class="${v === value ? 'on' : ''}" data-v="${esc(v)}" title="${esc(label)}">${ic ? icon(ic, 14) : esc(label)}</button>`,
    )
    .join('')}</div>`;

/**
 * Builds an app around one collection with list and (optionally) board views.
 *
 * cfg: { id, name, icon, color, col, size,
 *        views: ['list','board'], boardField, columns: [{ l, v(r), cls }], card(r),
 *        filters: [{ v, l, fn(r) }], summary(rows, all), sort(a,b), onClick(e, r, win) -> handled?,
 *        boardTotal(rows) }
 */
export function collectionApp(cfg) {
  const sc = schemas[cfg.col];
  return {
    size: [960, 620],
    ...cfg,
    newLabel: sc.label,
    create: (win, defaults) => editRecord(win, cfg.col, null, defaults),
    openRecord: (win, id) => {
      const r = store.get(cfg.col, id);
      if (r) editRecord(win, cfg.col, r);
    },
    mount(win) {
      const st = { q: '', view: cfg.views?.[0] || 'list', filter: cfg.filters?.[0]?.v ?? null };

      win.tools.innerHTML = `
        ${cfg.filters ? `<select class="tb-select" data-filter>${cfg.filters.map((f) => `<option value="${esc(f.v)}">${esc(f.l)}</option>`).join('')}</select>` : ''}
        ${cfg.views?.length > 1 ? seg('view', cfg.views.map((v) => [v, v === 'board' ? 'Board' : 'List', v === 'board' ? 'kanban' : 'list']), st.view) : ''}
        <label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search ${esc(sc.plural.toLowerCase())}"></label>
        <button class="tb-btn" data-act="new" title="New ${esc(sc.label)}">${icon('plus', 16)}</button>`;

      const rows = () => {
        let r = [...store.all(cfg.col)];
        if (st.q) r = r.filter((x) => recordMatches(cfg.col, x, st.q));
        const f = cfg.filters?.find((x) => x.v === st.filter);
        if (f?.fn) r = r.filter(f.fn);
        return r.sort(cfg.sort || ((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
      };

      const table = (list) => {
        if (!list.length) return empty(st.q ? 'No matches' : `No ${sc.plural.toLowerCase()} yet`, st.q ? 'Try a different search.' : `Create your first ${sc.label.toLowerCase()} to get started.`, st.q ? '' : `New ${sc.label}`);
        return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cfg.columns
          .map((c) => `<th class="${c.cls || ''}">${esc(c.l)}</th>`)
          .join('')}</tr></thead><tbody>${list
          .map((r) => `<tr data-id="${r.id}">${cfg.columns.map((c) => `<td class="${c.cls || ''}">${c.v(r)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`;
      };

      const board = (list) => {
        const field = sc.fields.find((f) => f.k === cfg.boardField);
        return `<div class="board">${field.opts
          .map((opt) => {
            const items = list.filter((r) => (r[cfg.boardField] || field.opts[0]) === opt);
            return `<section class="board-col" data-v="${esc(opt)}">
              <header><span>${esc(opt)}</span><small>${items.length}${cfg.boardTotal ? ' · ' + cfg.boardTotal(items) : ''}</small></header>
              <div class="board-cards">${items.map((r) => `<article class="card" draggable="true" data-id="${r.id}">${cfg.card(r)}</article>`).join('')}</div>
              <button class="board-add" data-add="${esc(opt)}">${icon('plus', 12)} Add</button>
            </section>`;
          })
          .join('')}</div>`;
      };

      const draw = () => {
        const list = rows();
        win.body.innerHTML = `${cfg.summary ? `<div class="summary">${cfg.summary(list, [...store.all(cfg.col)])}</div>` : ''}
          <div class="view view-${st.view}">${st.view === 'board' ? board(list) : table(list)}</div>`;
      };

      win.tools.addEventListener('input', (e) => {
        if (e.target.type === 'search') {
          st.q = e.target.value;
          draw();
        }
      });
      win.tools.addEventListener('change', (e) => {
        if (e.target.matches('[data-filter]')) {
          st.filter = e.target.value;
          draw();
        }
      });
      win.tools.addEventListener('click', (e) => {
        const s = e.target.closest('[data-seg] button');
        if (s) {
          st.view = s.dataset.v;
          s.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === s));
          draw();
        }
        if (e.target.closest('[data-act=new]')) editRecord(win, cfg.col);
      });

      win.body.addEventListener('click', (e) => {
        if (cfg.onBodyClick?.(e, win)) return;
        if (e.target.closest('[data-act=new]')) return editRecord(win, cfg.col);
        const add = e.target.closest('[data-add]');
        if (add) return editRecord(win, cfg.col, null, { [cfg.boardField]: add.dataset.add });
        if (e.target.closest('a')) return;
        const holder = e.target.closest('[data-id]');
        if (!holder) return;
        const r = store.get(cfg.col, holder.dataset.id);
        if (!r) return;
        if (cfg.onClick?.(e, r, win)) return;
        editRecord(win, cfg.col, r);
      });

      // Board drag & drop
      let dragId = null;
      win.body.addEventListener('dragstart', (e) => {
        const c = e.target.closest('.card');
        if (!c) return;
        dragId = c.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
        requestAnimationFrame(() => c.classList.add('dragging'));
      });
      win.body.addEventListener('dragend', () => {
        dragId = null;
        win.body.querySelectorAll('.dragging, .drop').forEach((x) => x.classList.remove('dragging', 'drop'));
      });
      win.body.addEventListener('dragover', (e) => {
        const col = e.target.closest('.board-col');
        if (!col || !dragId) return;
        e.preventDefault();
        win.body.querySelectorAll('.board-col.drop').forEach((x) => x !== col && x.classList.remove('drop'));
        col.classList.add('drop');
      });
      win.body.addEventListener('drop', (e) => {
        const col = e.target.closest('.board-col');
        if (!col || !dragId) return;
        e.preventDefault();
        const r = store.get(cfg.col, dragId);
        if (r && r[cfg.boardField] !== col.dataset.v) {
          const next = { ...r, [cfg.boardField]: col.dataset.v };
          sc.beforeSave?.(next, r);
          store.save(cfg.col, next);
        }
      });

      win.watch(cfg.watch || [cfg.col, 'contacts', 'settings'], draw);
      draw();
      setTimeout(() => $('input[type=search]', win.tools)?.blur());
    },
  };
}

export const moneyTotal = (rows, k) => money(sum(rows, k), true);
