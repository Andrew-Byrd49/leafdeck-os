// Designer's Build panel: everything about turning the selected component into real code. Its states, what it should
// do, what to build it as, a live preview (hover it: the states are real CSS), the generated HTML and CSS, and the
// hand-off to Claude.
import { esc, download } from '../util.js';
import { showMenu } from '../wm.js';
import { ask } from '../dialogs.js';
import { glyph } from './glyphs.js';
import { STATES, FRAMEWORKS, statesOf, exportComponent, previewPage, handoffMarkdown, cloneNode, slug } from './model.js';

/** The component a layer belongs to (its top-level frame; a state's or a reference picture's component). */
export function componentOf(ed, id) {
  let top = id && ed.info(id)?.top;
  if (!top) return null;
  if (top.variant) top = ed.node(top.variant.of) || top;
  if (top.ref) top = ed.node(top.ref) || top;
  return top.type === 'frame' ? top : null;
}

/** Long data URLs shortened, for showing code. */
const shorten = (s) => s.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{120,}/g, (m) => m.slice(0, 48) + '…');

export function createHandoff(pane, ed, ctx) {
  let comp = null;
  let codeTab = 'html';
  let previewOf = 'live'; // 'live' | a state frame id | 'build'
  let notesTimer = null;

  const meta = () => (ed.doc.meta[comp.id] ||= {});
  const framework = () => meta().framework || ed.doc.framework || 'html';
  const assetPath = (id) => `assets/${id}.${(/^data:[\w]+\/([\w+.-]+)/.exec(ed.doc.assets[id] || '')?.[1] || 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`;

  function pick() {
    const fromSel = ed.sel.length ? componentOf(ed, ed.sel[0]) : null;
    const comps = ed.doc.nodes.filter((n) => n.type === 'frame' && !n.variant);
    comp = fromSel || (comp && ed.node(comp.id) && !comp.variant ? ed.node(comp.id) : null) || comps[0] || null;
    return comps;
  }

  function render() {
    const comps = pick();
    if (!comp) {
      pane.innerHTML = `<div class="dzb-empty">${glyph('component', 28)}<p>Make a component first: draw a frame, start from a template, or capture an element. Then build it here.</p></div>`;
      return;
    }
    const states = statesOf(ed.doc, comp);
    if (previewOf !== 'live' && previewOf !== 'build' && !states.some((s) => s.id === previewOf)) previewOf = 'live';
    const m = meta();
    const missing = Object.entries(STATES).filter(([k]) => !states.some((s) => s.variant.state === k));
    const code = exportComponent(ed.doc, comp);
    const shown = codeTab === 'html' ? code.html : codeTab === 'css' ? code.css : handoffMarkdown(ed.doc, comp, { framework: framework(), code: exportComponent(ed.doc, comp, { assetPath }) });
    pane.innerHTML = `<div class="dzb">
      <div class="dzb-row"><select class="dzi-select" data-comp title="Component">${comps.map((c) => `<option value="${c.id}"${c.id === comp.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <section class="dzb-sec"><h4>States</h4>
        <div class="dzb-states">
          <button type="button" class="dzb-chip${ed.sel.includes(comp.id) ? ' on' : ''}" data-select="${comp.id}">Default</button>
          ${states.map((s) => `<button type="button" class="dzb-chip${ed.sel.includes(s.id) ? ' on' : ''}" data-select="${s.id}">${glyph('state', 11)} ${esc(STATES[s.variant.state]?.label || s.variant.state)}</button>`).join('')}
          <button type="button" class="dzb-chip add" data-add-state>${glyph('plus', 12)} State</button>
        </div>
        <p class="dzi-note">Each state is a copy of the component you can change freely. The code gets the differences as ${states.length ? states.map((s) => `<code>${esc(STATES[s.variant.state]?.sel || '.is-' + s.variant.state)}</code>`).join(' ') : '<code>:hover</code>, <code>:focus-visible</code>…'}.</p>
      </section>
      <section class="dzb-sec"><h4>What should it do?</h4>
        <textarea class="dzb-notes" data-notes rows="4" placeholder="Opens a menu of the user’s workspaces; Enter picks one; shows a spinner while it switches…">${esc(m.notes || '')}</textarea>
      </section>
      <section class="dzb-sec"><h4>Build as</h4>
        <div class="dzb-row"><select class="dzi-select" data-framework>${Object.entries(FRAMEWORKS).map(([k, v]) => `<option value="${k}"${k === framework() ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      </section>
      <div class="dzb-actions">
        ${m.source?.site && ctx.sendToSite ? `<button type="button" class="btn primary" data-send-site title="Back to the Site Editor: shown on the page as a change, for Claude to put into the source">${glyph('corners', 14)} Send back to site</button>` : ''}
        ${ctx.canBuild ? `<button type="button" class="btn${m.source?.site ? '' : ' primary'}" data-build>${glyph('claude', 14)} Build with Claude</button>` : ''}
        <button type="button" class="btn" data-copy-prompt>${glyph('code', 14)} Copy prompt for AI</button>
        ${ctx.files ? `<button type="button" class="btn" data-save>Save hand-off files</button>` : `<button type="button" class="btn" data-download>Download HTML</button>`}
      </div>
      <section class="dzb-sec"><h4>Preview <span class="grow"></span>
          <span class="dzb-seg"><button type="button" data-preview="live" class="${previewOf === 'live' ? 'on' : ''}" title="Interactive: hover, press and tab to it">Live</button>${states.map((s) => `<button type="button" data-preview="${s.id}" class="${previewOf === s.id ? 'on' : ''}">${esc(STATES[s.variant.state]?.label || s.variant.state)}</button>`).join('')}${ctx.buildUrl() ? `<button type="button" data-preview="build" class="${previewOf === 'build' ? 'on' : ''}" title="What Claude built (build/index.html)">Claude’s build</button>` : ''}</span>
          ${previewOf === 'build' ? `<button type="button" class="dzi-icon" data-reload title="Reload">${glyph('play', 12)}</button>` : ''}
          ${ctx.expand ? `<button type="button" class="dzi-icon" data-expand title="Show it big, over the canvas">${glyph('corners', 14)}</button>` : ''}</h4>
        <div class="dzb-preview"><iframe title="Preview" ${previewOf === 'build' ? `src="${esc(ctx.buildUrl())}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"` : 'sandbox="allow-same-origin"'}></iframe></div>
      </section>
      <section class="dzb-sec"><h4>Code <span class="grow"></span>
          <span class="dzb-seg">${[['html', 'HTML'], ['css', 'CSS'], ['prompt', 'Prompt']].map(([k, l]) => `<button type="button" data-code="${k}" class="${codeTab === k ? 'on' : ''}">${l}</button>`).join('')}</span>
          <button type="button" class="dzi-icon" data-copy-code title="Copy">${glyph('code', 14)}</button></h4>
        <pre class="dzb-code">${esc(shorten(shown))}</pre>
      </section>
    </div>`;
    if (previewOf !== 'build') {
      const frame = pane.querySelector('iframe');
      const target = previewOf === 'live' ? comp : ed.node(previewOf);
      frame.srcdoc = previewPage(ed.doc, target);
    }
    pane._code = shown;
  }

  async function addState() {
    const states = statesOf(ed.doc, comp);
    const r = pane.querySelector('[data-add-state]').getBoundingClientRect();
    const items = Object.entries(STATES)
      .filter(([k]) => !states.some((s) => s.variant.state === k))
      .map(([k, s]) => ({ label: s.label, key: s.sel, act: () => makeState(k) }));
    showMenu(r.left, r.bottom + 4, [...items, '-', { label: 'Other state…', act: async () => {
      const res = await ask({ title: 'New state', message: 'A name for it, like “loading” or “expanded”. The code gets it as a class (.is-loading).', fields: [{ name: 'name', label: 'State', placeholder: 'loading' }], win: ctx.win });
      const name = slug(res?.values?.name || '');
      if (res && name && name !== 'layer') makeState(name);
    } }]);
  }

  function makeState(state) {
    const states = statesOf(ed.doc, comp);
    const last = states[states.length - 1] || comp;
    const v = cloneNode(comp, { links: true });
    v.variant = { of: comp.id, state };
    v.name = `${comp.name} / ${STATES[state]?.label || state[0].toUpperCase() + state.slice(1)}`;
    v.x = last.x + last.w + 40;
    v.y = comp.y;
    // A head start that's easy to change: the usual look of each state.
    if (state === 'disabled') v.opacity = 0.45;
    if (state === 'focus') v.effects = [...(v.effects || []), { type: 'drop', x: 0, y: 0, blur: 0, spread: 3, color: 'rgba(10, 132, 255, 0.45)' }];
    ed.insert([v], { into: null, at: { x: v.x, y: v.y } });
    ed.fit([comp.id, v.id], { max: 2 });
  }

  pane.addEventListener('click', async (e) => {
    const t = e.target;
    const b = t.closest('button');
    if (!b) return;
    if (b.dataset.select) {
      ed.select([b.dataset.select]);
      return ed.fit([b.dataset.select], { max: 2 });
    }
    if (b.hasAttribute('data-add-state')) return addState();
    if (b.dataset.preview) {
      previewOf = b.dataset.preview;
      return render();
    }
    if (b.hasAttribute('data-expand')) {
      const target = previewOf === 'live' || previewOf === 'build' ? comp : ed.node(previewOf);
      return ctx.expand(previewOf === 'build' ? { title: `${comp.name}: Claude’s build`, src: ctx.buildUrl() } : { title: `${target.name}${previewOf === 'live' ? ' (live: hover it, press it, Tab to it)' : ''}`, srcdoc: previewPage(ed.doc, target) });
    }
    if (b.hasAttribute('data-reload')) {
      const f = pane.querySelector('iframe');
      f.src = ctx.buildUrl();
      return;
    }
    if (b.dataset.code) {
      codeTab = b.dataset.code;
      return render();
    }
    if (b.hasAttribute('data-copy-code')) {
      const full = codeTab === 'html' ? exportComponent(ed.doc, comp).html : codeTab === 'css' ? exportComponent(ed.doc, comp).css : pane._code;
      return navigator.clipboard.writeText(full).then(() => ctx.toast('Copied'));
    }
    if (b.hasAttribute('data-copy-prompt')) {
      const md = handoffMarkdown(ed.doc, comp, { framework: framework(), code: exportComponent(ed.doc, comp, { assetPath }) });
      return navigator.clipboard.writeText(md).then(() => ctx.toast('Prompt copied. Paste it into any AI chat (images are referenced as files in assets/).'));
    }
    if (b.hasAttribute('data-build')) return ctx.build(comp, { framework: framework() });
    if (b.hasAttribute('data-send-site')) return ctx.sendToSite(comp);
    if (b.hasAttribute('data-save')) return ctx.writeHandoff(comp, { reveal: true });
    if (b.hasAttribute('data-download')) return download(`${slug(comp.name)}.html`, previewPage(ed.doc, comp), 'text/html');
  });
  pane.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-comp]')) {
      ed.select([t.value]);
      ed.fit([t.value], { max: 2 });
    }
    if (t.matches('[data-framework]')) {
      ed.checkpoint();
      meta().framework = t.value;
      ed.doc.framework = t.value; // the next component starts with the same
      ed.commit({ quiet: true });
      render();
    }
  });
  pane.addEventListener('input', (e) => {
    if (!e.target.matches('[data-notes]')) return;
    const v = e.target.value;
    const c = comp;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      ed.checkpoint('notes');
      (ed.doc.meta[c.id] ||= {}).notes = v;
      ed.commit({ quiet: true });
    }, 400);
  });
  pane.addEventListener('keydown', (e) => e.stopPropagation());

  let pending = null;
  const later = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      if (pane.offsetParent && !pane.contains(document.activeElement)) render();
    });
  };
  ed.on('select', later);
  ed.on('change', later);
  return {
    render,
    get component() {
      pick();
      return comp;
    },
    showBuild() {
      previewOf = 'build';
      render();
    },
    assetPath,
  };
}
