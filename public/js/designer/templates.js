// Starting points: common elements, built from real layers (auto layout, states), ready to restyle.
import { makeNode, cloneNode, walk } from './model.js';

const text = (t, font, o = {}) => makeNode('text', { text: t, name: o.name || t, font: { family: 'Inter, system-ui, sans-serif', lineHeight: 'auto', letterSpacing: 0, align: 'left', ...font }, ...o });
const frame = (o) => makeNode('frame', { fills: [], ...o });
const auto = (mode, o = {}) => ({ mode, gap: 0, padding: [0, 0, 0, 0], align: 'center', justify: 'start', ...o });
const solid = (color) => [{ type: 'solid', color }];
const shadow = (y, blur, color, spread = 0) => ({ type: 'drop', x: 0, y, blur, spread, color });
const svg = (name, paths, color, size = 16) =>
  makeNode('svg', { name, w: size, h: size, color, markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>` });

/** A state of `base`: a linked copy with `edit` applied to it (and to its layers by name). */
function state(base, st, edit) {
  const v = cloneNode(base, { links: true });
  v.variant = { of: base.id, state: st };
  v.name = `${base.name} / ${st[0].toUpperCase() + st.slice(1)}`;
  edit(v, (name) => [...walk([v])].map((x) => x.node).find((n) => n.name === name));
  return v;
}

const TEMPLATES = {
  button: {
    label: 'Button',
    make() {
      const b = frame({ name: 'Button', tag: 'button', fills: solid('#0a84ff'), radius: 8, sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { gap: 8, padding: [10, 18, 10, 18], justify: 'center' }) });
      b.children.push(text('Button', { size: 14, weight: 600, color: '#ffffff' }, { name: 'Label' }));
      return [
        b,
        state(b, 'hover', (v) => (v.fills = solid('#0071e3'))),
        state(b, 'pressed', (v) => (v.fills = solid('#0062c4'))),
        state(b, 'focus', (v) => (v.effects = [shadow(0, 0, 'rgba(10, 132, 255, 0.45)', 3)])),
        state(b, 'disabled', (v) => (v.opacity = 0.45)),
      ];
    },
  },
  secondary: {
    label: 'Secondary button',
    make() {
      const b = frame({ name: 'Secondary button', tag: 'button', fills: solid('#ffffff'), stroke: { color: '#d1d1d6', width: 1 }, radius: 8, effects: [shadow(1, 2, 'rgba(0, 0, 0, 0.06)')], sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { gap: 8, padding: [9, 16, 9, 16], justify: 'center' }) });
      b.children.push(svg('Icon', '<path d="M12 5v14M5 12h14"/>', '#1d1d1f', 16), text('New item', { size: 14, weight: 500, color: '#1d1d1f' }, { name: 'Label' }));
      return [b, state(b, 'hover', (v) => (v.fills = solid('#f5f5f7'))), state(b, 'pressed', (v) => (v.fills = solid('#ebebf0')))];
    },
  },
  input: {
    label: 'Input field',
    make() {
      const root = frame({ name: 'Text field', tag: 'label', sizing: { w: 'hug', h: 'hug' }, layout: auto('column', { gap: 6, align: 'start' }) });
      const field = frame({ name: 'Field', tag: 'input', w: 280, h: 40, fills: solid('#ffffff'), stroke: { color: '#d1d1d6', width: 1 }, radius: 8, sizing: { w: 'fixed', h: 'hug' }, layout: auto('row', { gap: 8, padding: [10, 12, 10, 12] }) });
      field.children.push(text('you@example.com', { size: 14, color: '#8e8e93' }, { name: 'Placeholder', role: 'placeholder', sizing: { w: 'fill', h: 'hug' } }));
      root.children.push(text('Email', { size: 13, weight: 500, color: '#3a3a3c' }, { name: 'Label' }), field, text('We’ll never share it.', { size: 12, color: '#8e8e93' }, { name: 'Hint' }));
      return [
        root,
        state(root, 'focus', (v, by) => {
          by('Field').stroke = { color: '#0a84ff', width: 1.5 };
          by('Field').effects = [shadow(0, 0, 'rgba(10, 132, 255, 0.25)', 3)];
        }),
        state(root, 'error', (v, by) => {
          by('Field').stroke = { color: '#ff3b30', width: 1.5 };
          Object.assign(by('Hint'), { text: 'Enter a valid email address.', font: { ...by('Hint').font, color: '#ff3b30' } });
        }),
      ];
    },
  },
  search: {
    label: 'Search field',
    make() {
      const s = frame({ name: 'Search', tag: 'div', attrs: { role: 'search' }, w: 260, h: 36, fills: solid('#f2f2f7'), radius: 18, sizing: { w: 'fixed', h: 'hug' }, layout: auto('row', { gap: 8, padding: [9, 14, 9, 12] }) });
      s.children.push(svg('Magnifier', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', '#8e8e93', 16), text('Search', { size: 14, color: '#8e8e93' }, { name: 'Placeholder', role: 'placeholder', sizing: { w: 'fill', h: 'hug' } }), text('⌘K', { size: 12, weight: 500, color: '#aeaeb2' }, { name: 'Shortcut' }));
      return [s, state(s, 'focus', (v) => Object.assign(v, { fills: solid('#ffffff'), stroke: { color: '#0a84ff', width: 1.5 } }))];
    },
  },
  menu: {
    label: 'Menu',
    make() {
      const m = frame({ name: 'Menu', tag: 'div', attrs: { role: 'menu' }, w: 220, fills: solid('#ffffff'), radius: 10, stroke: { color: 'rgba(0, 0, 0, 0.08)', width: 1 }, effects: [shadow(8, 24, 'rgba(0, 0, 0, 0.14)'), shadow(1, 3, 'rgba(0, 0, 0, 0.08)')], sizing: { w: 'fixed', h: 'hug' }, layout: auto('column', { gap: 2, padding: [6, 6, 6, 6], align: 'stretch' }) });
      const item = (label, key, icon, hover = false) => {
        const it = frame({ name: label, tag: 'button', attrs: { role: 'menuitem' }, fills: hover ? solid('#0a84ff') : [], radius: 6, sizing: { w: 'fill', h: 'hug' }, layout: auto('row', { gap: 10, padding: [7, 10, 7, 10] }) });
        const c = hover ? '#ffffff' : '#1d1d1f';
        it.children.push(svg('Icon', icon, c, 15), text(label, { size: 13.5, color: c }, { name: 'Label', sizing: { w: 'fill', h: 'hug' } }), text(key, { size: 12.5, color: hover ? 'rgba(255, 255, 255, 0.8)' : '#8e8e93' }, { name: 'Shortcut' }));
        return it;
      };
      const div = makeNode('rect', { name: 'Divider', h: 1, w: 200, fills: solid('rgba(0, 0, 0, 0.08)'), sizing: { w: 'fill', h: 'fixed' } });
      m.children.push(item('New file', 'Ctrl N', '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>', true), item('Open…', 'Ctrl O', '<path d="M3 7h6l2 2h10v10H3z"/>'), item('Duplicate', 'Ctrl D', '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'), div, item('Delete', 'Del', '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'));
      return [m];
    },
  },
  toggle: {
    label: 'Toggle',
    make() {
      const t = frame({ name: 'Toggle', tag: 'button', attrs: { role: 'switch', 'aria-checked': 'false' }, w: 44, h: 26, fills: solid('#e5e5ea'), radius: 13, layout: { mode: 'none' } });
      const knob = makeNode('ellipse', { name: 'Knob', x: 2, y: 2, w: 22, h: 22, fills: solid('#ffffff'), effects: [shadow(1, 3, 'rgba(0, 0, 0, 0.2)')] });
      t.children.push(knob);
      return [t, state(t, 'checked', (v, by) => ((v.fills = solid('#34c759')), (by('Knob').x = 20)))];
    },
  },
  checkbox: {
    label: 'Checkbox',
    make() {
      const row = frame({ name: 'Checkbox', tag: 'label', sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { gap: 8 }) });
      const box = frame({ name: 'Box', w: 18, h: 18, radius: 5, fills: solid('#ffffff'), stroke: { color: '#c7c7cc', width: 1.5 }, layout: auto('row', { justify: 'center' }) });
      const tick = svg('Tick', '<path d="M5 12.5l4.5 4.5L19 7.5"/>', '#ffffff', 13);
      tick.hidden = true;
      box.children.push(tick);
      row.children.push(box, text('Remember me', { size: 14, color: '#1d1d1f' }, { name: 'Label' }));
      return [row, state(row, 'checked', (v, by) => (Object.assign(by('Box'), { fills: solid('#0a84ff'), stroke: undefined }), (by('Tick').hidden = false)))];
    },
  },
  segmented: {
    label: 'Segmented control',
    make() {
      const s = frame({ name: 'Segmented control', tag: 'div', attrs: { role: 'tablist' }, fills: solid('#f2f2f7'), radius: 9, sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { gap: 2, padding: [2, 2, 2, 2] }) });
      ['Day', 'Week', 'Month'].forEach((l, i) => {
        const seg = frame({ name: l, tag: 'button', attrs: { role: 'tab', 'aria-selected': String(!i) }, fills: i ? [] : solid('#ffffff'), radius: 7, effects: i ? undefined : [shadow(1, 3, 'rgba(0, 0, 0, 0.12)')], sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { padding: [6, 16, 6, 16], justify: 'center' }) });
        seg.children.push(text(l, { size: 13, weight: i ? 500 : 600, color: '#1d1d1f' }, { name: 'Label' }));
        s.children.push(seg);
      });
      return [s];
    },
  },
  card: {
    label: 'Card',
    make() {
      const c = frame({ name: 'Card', tag: 'section', w: 300, fills: solid('#ffffff'), radius: 14, stroke: { color: 'rgba(0, 0, 0, 0.06)', width: 1 }, effects: [shadow(4, 16, 'rgba(0, 0, 0, 0.08)')], sizing: { w: 'fixed', h: 'hug' }, layout: auto('column', { gap: 10, padding: [20, 20, 20, 20], align: 'start' }) });
      const btn = TEMPLATES.button.make()[0];
      btn.children[0].text = 'Get started';
      c.children.push(text('Pro plan', { size: 17, weight: 600, color: '#1d1d1f' }, { name: 'Title' }), text('Everything in Free, plus unlimited projects and priority support.', { size: 14, color: '#6e6e73', lineHeight: 20 }, { name: 'Body', sizing: { w: 'fill', h: 'hug' } }), btn);
      return [c, state(c, 'hover', (v) => (v.effects = [shadow(10, 30, 'rgba(0, 0, 0, 0.14)')]))];
    },
  },
  chip: {
    label: 'Chip',
    make() {
      const c = frame({ name: 'Chip', tag: 'span', fills: solid('#e8f2ff'), radius: 999, sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { gap: 6, padding: [4, 10, 4, 8] }) });
      c.children.push(makeNode('ellipse', { name: 'Dot', w: 6, h: 6, fills: solid('#0a84ff') }), text('In review', { size: 12, weight: 600, color: '#0a63c9' }, { name: 'Label' }));
      return [c];
    },
  },
  tooltip: {
    label: 'Tooltip',
    make() {
      const t = frame({ name: 'Tooltip', tag: 'div', attrs: { role: 'tooltip' }, fills: solid('#1d1d1f'), radius: 6, effects: [shadow(4, 12, 'rgba(0, 0, 0, 0.2)')], sizing: { w: 'hug', h: 'hug' }, layout: auto('row', { gap: 6, padding: [6, 10, 6, 10] }) });
      t.children.push(text('Copy link', { size: 12, weight: 500, color: '#ffffff' }, { name: 'Label' }), text('Ctrl C', { size: 12, color: 'rgba(255, 255, 255, 0.55)' }, { name: 'Shortcut' }));
      return [t];
    },
  },
};

export const templates = Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label }));
/** A template's frames: [component, …its states], with fresh ids. */
export const makeTemplate = (id) => TEMPLATES[id].make();
