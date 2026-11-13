// Site Editor's in-page half. This one function runs inside the site being edited (electron/siteeditor.cjs injects it
// in an isolated world: the page's DOM, none of its scripts). It must stay self-contained: no imports, nothing from
// outside the function. The editor (public/js/apps/siteeditor.js) calls it through the main process:
//
//   sitePage('start', { mode, changes, comments, selected })  install (or update) the overlay, re-apply the pending
//                                                              changes and draw the comment pins
//   sitePage('mode', { mode })          'browse' (the page works as usual) | 'select' | 'comment'
//   sitePage('info', { selector, props })  what the inspector shows for an element: tag, classes, text, computed styles
//                                       (`styles` as shown, `base` without the editor's own style changes), its parent's
//                                       layout, the path down to it, its children, and what its classes match
//   sitePage('select', { selector })    select an element (from the Changes list), or null to deselect
//   sitePage('apply', change)           show a change live: { id, kind: 'style' | 'text' | 'component', selector, ... }.
//                                       Style changes are rules in the overlay's own stylesheet, so one can apply to
//                                       everything a class matches (`target`), to a state (`state`: 'hover') or under
//                                       a width (`media`: 'max-width: 768px'), and they outlive a framework re-render
//   sitePage('hint', { kind, side })    show the selection's padding, margin or gap as bands ('padding', 'margin', 'gap';
//                                       side 'top' | 'right' | 'bottom' | 'left' | 'all'), or nothing without a kind
//   sitePage('revert', { id })          take it back
//   sitePage('pins', { comments, active })  redraw the comment pins (and open one's thread)
//   sitePage('vars')                    the page's custom properties: [{ name, value }]
//   sitePage('widths')                  the page's breakpoints, from its media queries: ['max-width: 768px', …]
//   sitePage('verify', { changes })     after Claude's turn and a reload: which changes the page now has on its own
//   sitePage('quiet', { on })           hide the overlay's boxes for a screenshot (pins stay)
//   sitePage('stop')                    revert everything and remove the overlay
//
// What happens in the page comes back as events: document.dispatchEvent('leafdeck-site-editor', detail: JSON), which
// the webview preload forwards to the main process, and it to the editor:
//   { t: 'select', info }          an element was clicked (info as 'info' returns; null when deselected)
//   { t: 'text', selector, before, after }   text edited in place (double-click)
//   { t: 'comment', selector, offset, text, rect }   a new comment, pinned to an element
//   { t: 'reply', id, text } { t: 'resolve', id } { t: 'pin', id }   on a comment's thread
//   { t: 'designer', selector }    "Edit in Designer" from the selection's toolbar
//   { t: 'key', key }              'undo' | 'redo' pressed on the page (Ctrl+Z, Ctrl+Shift+Z)
export default function sitePage(mode, opts = {}) {
  const W = window;
  const D = document;
  const KEY = '__leafdeckSiteEditor';
  const EVENT = 'leafdeck-site-editor';
  const emit = (ev) => D.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(ev) }));
  const round = (n) => Math.round(n * 100) / 100;

  /* ---------------- finding elements again: a selector that survives a reload ---------------- */

  const DYNAMIC = /^(css-|sc-|_|jsx-|svelte-|emotion-|chakra-|mui-|Mui|v-|data-v-)|[0-9a-f]{6,}|__[A-Za-z0-9]{5,}$/;
  const classesOf = (el) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '').trim().split(/\s+/).filter((c) => c && !DYNAMIC.test(c)).slice(0, 4);
  const cssEsc = (s) => (W.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));
  const unique = (sel, el) => {
    try {
      const all = D.querySelectorAll(sel);
      return all.length === 1 && all[0] === el;
    } catch {
      return false;
    }
  };
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el === D.body) return 'body';
    if (el === D.documentElement) return 'html';
    if (el.id && !DYNAMIC.test(el.id) && unique('#' + cssEsc(el.id), el)) return '#' + cssEsc(el.id);
    const parts = [];
    let e = el;
    while (e && e !== D.body && e !== D.documentElement) {
      const tag = e.tagName.toLowerCase();
      let seg = tag;
      if (e.id && !DYNAMIC.test(e.id)) {
        parts.unshift('#' + cssEsc(e.id));
        break;
      }
      const cls = classesOf(e);
      if (cls.length) seg += '.' + cls.map(cssEsc).join('.');
      const whole = [seg, ...parts].join(' > ');
      if (unique(whole, el)) {
        parts.unshift(seg);
        break;
      }
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(seg);
      e = p;
    }
    const sel = parts.join(' > ');
    return unique(sel, el) ? sel : 'body > ' + sel;
  }
  const find = (sel) => {
    try {
      return sel ? D.querySelector(sel) : null;
    } catch {
      return null;
    }
  };

  /* ---------------- what the inspector shows ---------------- */

  const SIDES = ['top', 'right', 'bottom', 'left'];
  const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const STYLE_PROPS = [
    // layout
    'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'justify-items', 'gap', 'row-gap', 'column-gap',
    'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
    'flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'justify-self', 'order', 'grid-column', 'grid-row',
    // size and position
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'overflow-x', 'overflow-y', 'aspect-ratio', 'box-sizing', 'object-fit', 'object-position',
    'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
    ...SIDES.map((x) => `padding-${x}`), ...SIDES.map((x) => `margin-${x}`),
    // type
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-decoration-line',
    'text-decoration-color', 'text-decoration-style', 'text-underline-offset', 'white-space', 'text-overflow', 'text-indent', 'word-break', 'overflow-wrap', 'text-wrap', 'text-shadow',
    'vertical-align', 'list-style-type',
    // backgrounds and borders
    'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-clip', 'background-attachment',
    ...CORNERS.map((x) => `border-${x}-radius`), ...SIDES.flatMap((x) => [`border-${x}-width`, `border-${x}-style`, `border-${x}-color`]),
    'outline-width', 'outline-style', 'outline-color', 'outline-offset',
    // effects
    'box-shadow', 'opacity', 'mix-blend-mode', 'filter', 'backdrop-filter', 'transform', 'transform-origin', 'transition', 'cursor', 'pointer-events', 'visibility',
  ];
  // Text that can be edited in place: 'plain' (no tags inside) or 'inline' (only links, bold, spans… inside, kept
  // while editing); null for anything with blocks or nothing to edit.
  const INLINE = /^(a|b|i|em|strong|span|code|small|br|sup|sub|mark|u|s|abbr|time|kbd|q|cite|del|ins|wbr|label|font)$/i;
  const VOID = /^(input|textarea|select|img|svg|video|canvas|iframe|br|hr|picture|audio|object|embed|button)$/i;
  const textKind = (el) => {
    if (!el || (VOID.test(el.tagName) && el.tagName !== 'BUTTON') || !/\S/.test(el.textContent || '')) return null;
    if (!el.children.length) return 'plain';
    for (const d of el.querySelectorAll('*')) if (!INLINE.test(d.tagName)) return null;
    return 'inline';
  };
  const editableText = (el) => !!textKind(el);
  /** Markup from an in-place edit, without anything that runs. */
  const cleanHtml = (html) => {
    const tpl = D.createElement('template');
    tpl.innerHTML = String(html || '');
    tpl.content.querySelectorAll('script, style, iframe, object, embed').forEach((e) => e.remove());
    for (const e of tpl.content.querySelectorAll('*')) for (const a of [...e.attributes]) if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name);
    return tpl.innerHTML;
  };
  const normHtml = (s) => String(s || '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  const label = (el) => {
    const cls = classesOf(el);
    return el.tagName.toLowerCase() + (el.id && !DYNAMIC.test(el.id) ? '#' + el.id : cls.length ? '.' + cls[0] : '');
  };
  const inFlow = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
  };
  /**
   * Run `fn` with the page's transitions off: a value that just changed reads as where it ends up, not where its
   * transition starts. (A second stylesheet of the overlay's, off except in here.)
   */
  function settled(S, fn) {
    if (!S) return fn();
    if (!S.still || !S.still.isConnected) {
      S.still = D.createElement('style');
      S.still.setAttribute('data-ld-overlay', '');
      S.still.textContent = '*, *::before, *::after { transition: none !important; }';
      (D.head || D.documentElement).append(S.still);
    }
    const sheet = S.still.sheet;
    const flush = () => void getComputedStyle(D.documentElement).opacity;
    sheet.disabled = false;
    flush();
    try {
      return fn();
    } finally {
      flush();
      sheet.disabled = true;
      flush();
    }
  }
  function info(el, extra = null) {
    if (!el) return null;
    const S = W[KEY];
    const more = Array.isArray(extra) ? extra : S?.extra || [];
    const props = [...new Set([...STYLE_PROPS, ...more.filter((p) => typeof p === 'string' && /^-?-?[a-z][a-z0-9-]*$/i.test(p)).slice(0, 120)])];
    // `styles` is how it looks now; `base` how the project has it (the editor's own style rules off).
    const sheet = S?.style?.isConnected ? S.style.sheet : null;
    const ours = !!sheet && sheet.cssRules.length > 0;
    const read = (list) => {
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of list) out[p] = cs.getPropertyValue(p).trim();
      return out;
    };
    const without = (fn) => {
      if (!ours) return fn();
      sheet.disabled = true;
      try {
        return fn();
      } finally {
        sheet.disabled = false;
      }
    };
    const moving = props.filter((p) => /^transition/.test(p)); // read as they are: `settled` turns them off
    const rest = props.filter((p) => !/^transition/.test(p));
    const styles = read(moving);
    const base = without(() => read(moving));
    let r = null;
    settled(S, () => {
      Object.assign(styles, read(rest));
      r = el.getBoundingClientRect();
      Object.assign(base, ours ? without(() => read(rest)) : read(rest));
    });
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const sel = cssPath(el);
    // The parent's layout: what "fill" and "hug" mean for this element, and whether it has a place in a flex or grid.
    const par = el.parentElement;
    const pcs = par ? getComputedStyle(par) : null;
    const path = [];
    for (let e = el.parentElement; e && e !== D.documentElement && path.length < 24; e = e.parentElement) path.unshift({ label: label(e), selector: cssPath(e) });
    const kids = [...el.children].filter((c) => !c.hasAttribute('data-ld-overlay') && !/^(script|style|link|meta|template|noscript)$/i.test(c.tagName));
    const nth = (c) => {
      const same = [...el.children].filter((x) => x.tagName === c.tagName);
      return `${sel} > ${c.tagName.toLowerCase()}${same.length > 1 ? `:nth-of-type(${same.indexOf(c) + 1})` : ''}`;
    };
    // How its children sit now: side by side or stacked (what "Add auto layout" keeps).
    const flowKids = kids.filter(inFlow).slice(0, 6).map((c) => c.getBoundingClientRect()).filter((b) => b.width && b.height);
    let flow = 'column';
    if (flowKids.length > 1 && flowKids.slice(1).every((b, i) => b.left >= flowKids[i].right - 1)) flow = 'row';
    const count = (q) => {
      try {
        return D.querySelectorAll(q).length;
      } catch {
        return 0;
      }
    };
    const tag = el.tagName.toLowerCase();
    const targets = [...classesOf(el).map((c) => '.' + cssEsc(c)), tag].map((q) => ({ selector: q, count: count(q) })).filter((t) => t.count > 0);
    return {
      selector: sel,
      tag,
      id: el.id || '',
      classes: classesOf(el),
      label: label(el),
      text: text.slice(0, 2000),
      editableText: textKind(el) === 'plain',
      textKind: textKind(el),
      inner: el.innerHTML.slice(0, 4000),
      rect: { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) },
      html: el.outerHTML.slice(0, 4000),
      styles,
      base,
      parent: pcs ? { label: label(par), display: pcs.display, direction: pcs.flexDirection, wrap: pcs.flexWrap, alignItems: pcs.alignItems } : null,
      path,
      children: kids.slice(0, 60).map((c) => ({ label: label(c), selector: nth(c), text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) })),
      childCount: kids.length,
      flow,
      targets,
      viewport: { w: W.innerWidth, h: W.innerHeight },
    };
  }

  /* ---------------- the overlay ---------------- */

  const CSS_TEXT = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; }
    .box, .chg, .pin, .pop, .bar, .ed { position: fixed; box-sizing: border-box; }
    .hover { border: 1.5px solid rgba(13, 153, 255, 0.95); background: rgba(13, 153, 255, 0.08); border-radius: 2px; }
    .hover .pad { position: absolute; inset: 0; border: 0 solid rgba(13, 153, 255, 0.18); }
    .sel { border: 2px solid #0d99ff; border-radius: 2px; }
    .box[hidden], .pop[hidden], .bar[hidden], .pin[hidden], .ed[hidden] { display: none; }
    .tag { position: absolute; left: -2px; top: -24px; background: #0d99ff; color: #fff; font-weight: 600; font-size: 11px; padding: 3px 7px; border-radius: 4px 4px 4px 0; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .tag.below { top: auto; bottom: -24px; border-radius: 0 4px 4px 4px; }
    .tag i { font-style: normal; opacity: 0.75; margin-left: 8px; }
    .tools { position: absolute; right: -2px; top: -30px; display: flex; gap: 4px; pointer-events: auto; }
    .tools.below { top: auto; bottom: -30px; }
    .tools button { all: initial; font: 600 11px system-ui, sans-serif; color: #fff; background: #1d1f23; padding: 5px 9px; border-radius: 6px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .tools button:hover { background: #0d99ff; }
    .chg { border: 1.5px dashed rgba(151, 71, 255, 0.85); border-radius: 2px; }
    .chg.done { border-color: rgba(31, 157, 69, 0.85); }
    .pin { width: 26px; height: 26px; margin: -26px 0 0 0; border-radius: 13px 13px 13px 2px; background: #ff9f0a; color: #1d1f23; font-weight: 700; font-size: 12px; display: grid; place-items: center; box-shadow: 0 0 0 2px #fff, 0 3px 10px rgba(0,0,0,0.3); pointer-events: auto; cursor: pointer; }
    .pin.replied { background: #30d158; }
    .pin.resolved { background: #c7c7cc; opacity: 0.8; }
    .pin.active { transform: scale(1.15); box-shadow: 0 0 0 2px #fff, 0 0 0 4px #ff9f0a, 0 3px 10px rgba(0,0,0,0.3); }
    .pin.replied.active { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #30d158, 0 3px 10px rgba(0,0,0,0.3); }
    .pop { width: 300px; max-width: calc(100vw - 24px); background: #1d1f23; color: #fff; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08); pointer-events: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
    .pop h5 { all: initial; font: 600 11px system-ui, sans-serif; color: #9a9ca3; text-transform: uppercase; letter-spacing: 0.04em; display: flex; justify-content: space-between; align-items: center; }
    .pop h5 button { all: initial; font: 500 11px system-ui, sans-serif; color: #9a9ca3; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
    .pop h5 button:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .msg { font-size: 12.5px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: break-word; }
    .msg.claude { padding: 8px 10px; border-radius: 8px; background: rgba(217, 119, 87, 0.18); border-left: 3px solid #d97757; }
    .msg small { display: block; color: #9a9ca3; font-size: 10.5px; margin-bottom: 2px; }
    .thread { display: flex; flex-direction: column; gap: 8px; max-height: 40vh; overflow: auto; }
    .pop textarea { all: initial; display: block; box-sizing: border-box; width: 100%; min-height: 56px; resize: vertical; font: 12.5px/1.4 system-ui, sans-serif; color: #fff; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); border-radius: 7px; padding: 7px 9px; white-space: pre-wrap; }
    .pop textarea:focus { border-color: #0d99ff; }
    .row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
    .row .grow { flex: 1; color: #9a9ca3; font-size: 11px; }
    .row button { all: initial; font: 600 12px system-ui, sans-serif; cursor: pointer; padding: 6px 11px; border-radius: 7px; color: #fff; background: rgba(255,255,255,0.1); }
    .row button.pri { background: #0d99ff; }
    .row button:hover { filter: brightness(1.12); }
    .bar { left: 50%; bottom: 18px; transform: translateX(-50%); background: rgba(29, 31, 35, 0.94); padding: 9px 14px; border-radius: 10px; font-weight: 500; box-shadow: 0 8px 30px rgba(0,0,0,0.35); width: max-content; max-width: calc(100vw - 24px); text-align: center; line-height: 1.7; }
    .bar b { color: #7cc4ff; font-weight: 600; }
    .bar kbd { font: inherit; background: rgba(255,255,255,0.14); border-radius: 4px; padding: 1px 6px; margin: 0 2px; }
    .ed { border: 2px solid #ff9f0a; border-radius: 2px; }
    .band { position: fixed; box-sizing: border-box; }
    .band.padding { background: rgba(48, 209, 88, 0.38); }
    .band.margin { background: rgba(255, 159, 10, 0.4); }
    .band.gap { background: repeating-linear-gradient(-45deg, rgba(255, 55, 150, 0.6) 0 1.5px, rgba(255, 55, 150, 0.16) 1.5px 6px); }
  `;

  function install() {
    let S = W[KEY];
    if (S && S.host.isConnected) return S;
    if (S) S.host.remove();
    const host = D.createElement('leafdeck-site-editor');
    host.setAttribute('data-ld-overlay', '');
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>${CSS_TEXT}</style>
      <div class="box hover" hidden><div class="pad"></div><span class="tag"></span></div>
      <div class="box sel" hidden><span class="tag"></span><span class="tools"><button data-act="edit-text" hidden>Edit text</button><button data-act="comment" hidden>Comment</button><button data-act="designer">Edit in Designer</button></span></div>
      <div class="box ed" hidden></div>
      <div class="chgs"></div><div class="hints"></div><div class="pins"></div>
      <div class="pop" hidden></div>
      <div class="bar" hidden></div>`;
    (D.documentElement || D.body).append(host);
    S = W[KEY] = {
      host, sh, mode: 'browse',
      hover: null, selected: null, editing: null,
      changes: new Map(), // id -> { change, el, orig }
      style: null, // the <style> the style changes are rules of
      hint: null, // { kind, side }: the selection's padding, margin or gap, shown as bands
      extra: [], // properties the inspector wants besides STYLE_PROPS
      comments: [], active: null, draft: null, // draft: { el, offset, x, y }
      quiet: false,
      $: (s) => sh.querySelector(s),
    };
    wire(S);
    return S;
  }

  const rectOf = (el) => el.getBoundingClientRect();
  const place = (box, r) => Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });

  function draw(S) {
    const hov = S.$('.hover');
    const sel = S.$('.sel');
    if (S.quiet) {
      hov.hidden = sel.hidden = true;
    } else {
      if (S.hover && S.hover.isConnected && S.hover !== S.selected && S.mode === 'select') {
        const r = rectOf(S.hover);
        hov.hidden = false;
        place(hov, r);
        const cs = getComputedStyle(S.hover);
        hov.querySelector('.pad').style.borderWidth = ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue('padding-' + s)).join(' ');
        const tag = hov.querySelector('.tag');
        tag.textContent = label(S.hover);
        const i = D.createElement('i');
        i.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
        tag.append(i);
        tag.classList.toggle('below', r.top < 30);
      } else hov.hidden = true;
      if (S.selected && S.selected.isConnected && !S.editing) {
        const r = rectOf(S.selected);
        sel.hidden = false;
        place(sel, r);
        const tag = sel.querySelector('.tag');
        tag.textContent = label(S.selected);
        tag.classList.toggle('below', r.top < 34);
        sel.querySelector('.tools').classList.toggle('below', r.top < 34);
        sel.querySelector('[data-act="edit-text"]').hidden = !textKind(S.selected);
      } else sel.hidden = true;
    }
    const ed = S.$('.ed');
    if (S.editing && S.editing.isConnected) {
      ed.hidden = false;
      place(ed, rectOf(S.editing));
    } else ed.hidden = true;
    // Changed elements: a dashed outline (not while the page is photographed).
    const chgs = S.$('.chgs');
    chgs.innerHTML = '';
    if (!S.quiet && S.mode !== 'browse') {
      for (const { change, el } of S.changes.values()) {
        const target = change.kind === 'component' ? find(change.selector) : el;
        if (!target || !target.isConnected || target === S.selected) continue;
        const b = D.createElement('div');
        b.className = 'chg' + (change.status === 'applied' ? ' done' : '');
        place(b, rectOf(target));
        chgs.append(b);
      }
    }
    const hints = S.$('.hints');
    hints.innerHTML = '';
    if (!S.quiet && S.hint && S.selected?.isConnected && !S.editing) drawHint(S, hints);
    drawPins(S);
  }

  /** The selection's padding (inside), margin (outside) or the gaps between its children, as colored bands. */
  function drawHint(S, into) {
    const el = S.selected;
    const { kind, side = 'all' } = S.hint;
    const r = rectOf(el);
    const cs = getComputedStyle(el);
    const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    const want = (x) => side === 'all' || side === x || (side === 'x' && (x === 'left' || x === 'right')) || (side === 'y' && (x === 'top' || x === 'bottom'));
    const band = (x, y, w, h) => {
      if (!(w > 0 && h > 0)) return;
      const b = D.createElement('div');
      b.className = 'band ' + kind;
      Object.assign(b.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      into.append(b);
    };
    if (kind === 'padding') {
      const b = SIDES.map((x) => n(`border-${x}-width`));
      const p = SIDES.map((x) => n(`padding-${x}`));
      const x = r.left + b[3];
      const y = r.top + b[0];
      const w = r.width - b[3] - b[1];
      const h = r.height - b[0] - b[2];
      if (want('top')) band(x, y, w, p[0]);
      if (want('bottom')) band(x, y + h - p[2], w, p[2]);
      if (want('left')) band(x, y + p[0], p[3], h - p[0] - p[2]);
      if (want('right')) band(x + w - p[1], y + p[0], p[1], h - p[0] - p[2]);
    } else if (kind === 'margin') {
      const m = SIDES.map((x) => n(`margin-${x}`));
      if (want('top')) band(r.left, r.top - m[0], r.width, m[0]);
      if (want('bottom')) band(r.left, r.bottom, r.width, m[2]);
      if (want('left')) band(r.left - m[3], r.top, m[3], r.height);
      if (want('right')) band(r.right, r.top, m[1], r.height);
    } else if (kind === 'gap') {
      const kids = [...el.children].filter((c) => !c.hasAttribute('data-ld-overlay') && inFlow(c)).map(rectOf).filter((b) => b.width || b.height);
      for (let i = 0; i + 1 < kids.length; i++) {
        const a = kids[i];
        const b = kids[i + 1];
        if (b.left >= a.right - 0.5) band(a.right, Math.min(a.top, b.top), b.left - a.right, Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top));
        else if (b.top >= a.bottom - 0.5) band(Math.min(a.left, b.left), a.bottom, Math.max(a.right, b.right) - Math.min(a.left, b.left), b.top - a.bottom);
      }
    }
  }

  function drawPins(S) {
    const pins = S.$('.pins');
    pins.innerHTML = '';
    for (const c of S.comments) {
      const el = find(c.selector);
      if (!el) continue;
      const r = rectOf(el);
      const x = r.left + r.width * (c.offset?.x ?? 0.5);
      const y = r.top + r.height * (c.offset?.y ?? 0.5);
      if (x < -30 || y < -30 || x > innerWidth + 30 || y > innerHeight + 30) continue;
      const p = D.createElement('div');
      p.className = 'pin' + (c.status === 'resolved' ? ' resolved' : c.replies?.length ? ' replied' : '') + (c.id === S.active ? ' active' : '');
      p.dataset.id = c.id;
      p.textContent = c.n;
      p.title = c.text;
      Object.assign(p.style, { left: x + 'px', top: y + 'px' });
      pins.append(p);
    }
    if (S.draft) {
      const p = D.createElement('div');
      p.className = 'pin active';
      p.textContent = '+';
      Object.assign(p.style, { left: S.draft.x + 'px', top: S.draft.y + 'px' });
      pins.append(p);
    }
    positionPop(S);
  }

  /* ---------------- the comment popover: a new comment, or a thread ---------------- */

  const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function openPop(S, html, anchor) {
    const pop = S.$('.pop');
    pop.hidden = false;
    pop.innerHTML = html;
    pop._anchor = anchor; // () => { x, y }
    positionPop(S);
    const ta = pop.querySelector('textarea');
    if (ta) setTimeout(() => ta.focus(), 0);
  }
  function closePop(S) {
    const pop = S.$('.pop');
    pop.hidden = true;
    pop.innerHTML = '';
    pop._anchor = null;
    S.draft = null;
    S.active = null;
    drawPins(S);
  }
  function positionPop(S) {
    const pop = S.$('.pop');
    if (pop.hidden || !pop._anchor) return;
    const a = pop._anchor();
    if (!a) return closePop(S);
    const w = pop.offsetWidth || 300;
    const h = pop.offsetHeight || 120;
    let x = a.x + 18;
    let y = a.y + 6;
    if (x + w > innerWidth - 12) x = Math.max(12, a.x - w - 18);
    if (y + h > innerHeight - 12) y = Math.max(12, innerHeight - h - 12);
    Object.assign(pop.style, { left: x + 'px', top: y + 'px' });
  }
  const anchorFor = (S, c) => () => {
    const el = find(c.selector);
    if (!el) return null;
    const r = rectOf(el);
    return { x: r.left + r.width * (c.offset?.x ?? 0.5), y: r.top + r.height * (c.offset?.y ?? 0.5) };
  };
  function startDraft(S, x, y) {
    const el = deepAt(S, x, y) || D.body;
    const r = rectOf(el);
    S.draft = { el, selector: cssPath(el), offset: { x: r.width ? round((x - r.left) / r.width) : 0.5, y: r.height ? round((y - r.top) / r.height) : 0.5 }, x, y, rect: { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) } };
    S.active = null;
    drawPins(S);
    openPop(S, `<h5>Comment on <span style="color:#fff;text-transform:none;letter-spacing:0">${escHtml(label(el))}</span><button data-act="close">✕</button></h5>
      <textarea placeholder="Tell Claude what to do here…"></textarea>
      <div class="row"><span class="grow">Ctrl+Enter posts</span><button data-act="cancel">Cancel</button><button class="pri" data-act="post">Post</button></div>`, () => ({ x: S.draft?.x, y: S.draft?.y }));
  }
  function openThread(S, id) {
    const c = S.comments.find((x) => x.id === id);
    if (!c) return;
    S.active = id;
    S.draft = null;
    drawPins(S);
    emit({ t: 'pin', id });
    const msgs = [`<div class="msg"><small>You · on ${escHtml(c.label || c.selector)}</small>${escHtml(c.text)}</div>`];
    for (const r of c.replies || []) msgs.push(`<div class="msg${r.from === 'claude' ? ' claude' : ''}"><small>${r.from === 'claude' ? 'Claude' : 'You'}</small>${escHtml(r.text)}</div>`);
    openPop(S, `<h5>Comment ${c.n}${c.status === 'resolved' ? ' · resolved' : c.status === 'sent' ? ' · sent to Claude' : ''}<button data-act="close">✕</button></h5>
      <div class="thread">${msgs.join('')}</div>
      ${c.status === 'resolved' ? '' : `<textarea placeholder="Reply…"></textarea>
      <div class="row"><button data-act="resolve" title="Done: Claude did what the comment asked">Resolve</button><span class="grow"></span><button class="pri" data-act="reply">Reply</button></div>`}`, anchorFor(S, c));
    requestAnimationFrame(() => {
      const t = S.$('.thread');
      if (t) t.scrollTop = t.scrollHeight;
    });
  }

  /* ---------------- picking ---------------- */

  const deepAt = (S, x, y) => {
    let e = D.elementFromPoint(x, y);
    while (e?.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e && e !== S.host && e !== D.documentElement ? e : null;
  };

  function setSelected(S, el, { silent = false } = {}) {
    if (S.editing) endEdit(S, true);
    S.selected = el && el.isConnected ? el : null;
    draw(S);
    if (!silent) emit({ t: 'select', info: info(S.selected) });
  }

  function startEdit(S, el) {
    const kind = textKind(el);
    if (!kind) return;
    if (S.editing && S.editing !== el) endEdit(S, true);
    S.editing = el;
    S.editKind = kind;
    S.editBefore = { text: el.textContent, html: el.innerHTML };
    el.setAttribute('contenteditable', kind === 'plain' ? 'plaintext-only' : 'true');
    el.setAttribute('data-ld-editing', '');
    // Pasted text comes in as text, not as someone else's markup and styles.
    S.onPaste = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.clipboardData?.getData('text/plain') || '';
      if (t) D.execCommand('insertText', false, t);
    };
    el.addEventListener('paste', S.onPaste, true);
    el.focus();
    const sel = getSelection();
    const range = D.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    draw(S);
    S.$('.bar').hidden = false;
    S.$('.bar').innerHTML = `<b>Editing text</b> · <kbd>Enter</kbd> keep · <kbd>Shift+Enter</kbd> line break · <kbd>Esc</kbd> cancel${kind === 'inline' ? ' · links and formatting stay' : ''}`;
  }
  function endEdit(S, keep) {
    const el = S.editing;
    if (!el) return;
    S.editing = null;
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-ld-editing');
    el.removeEventListener('paste', S.onPaste, true);
    const after = { text: el.textContent, html: el.innerHTML };
    const before = S.editBefore;
    const rich = S.editKind === 'inline';
    el.innerHTML = before.html; // back to how it was: the editor applies the edit as a change (revertable, sendable)
    if (keep && (rich ? normHtml(after.html) !== normHtml(before.html) : after.text !== before.text)) {
      emit({ t: 'text', selector: cssPath(el), before: before.text, after: after.text, rich, beforeHtml: before.html, afterHtml: cleanHtml(after.html) });
    }
    el.blur?.();
    showBar(S);
    draw(S);
  }

  function showBar(S) {
    const bar = S.$('.bar');
    if (S.mode === 'select') {
      bar.hidden = false;
      bar.innerHTML = `<b>Select</b> · Click an element · <kbd>↑</kbd> parent · double-click or <kbd>Enter</kbd> edits its text · <kbd>Esc</kbd> deselect`;
    } else if (S.mode === 'comment') {
      bar.hidden = false;
      bar.innerHTML = `<b>Comment</b> · Click where the comment goes`;
    } else bar.hidden = true;
  }

  function wire(S) {
    const { sh } = S;
    const inOverlay = (e) => e.composedPath().includes(S.host);
    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      if (S.mode !== 'select' || S.editing || inOverlay(e)) return;
      if (Date.now() < (S.ignoreMovesUntil || 0)) return; // the editor moving the pointer off what was just clicked
      const t = deepAt(S, e.clientX, e.clientY);
      if (t !== S.hover) {
        S.hover = t;
        draw(S);
      }
    };
    const onDown = (e) => {
      if (inOverlay(e)) return;
      if (S.mode === 'browse') return;
      if (S.editing) {
        if (e.composedPath().includes(S.editing)) return; // typing / placing the caret
        block(e);
        return endEdit(S, true);
      }
      block(e);
      if (e.button !== 0) return;
      if (S.mode === 'comment') {
        if (!S.$('.pop').hidden && !S.draft) return closePop(S);
        startDraft(S, e.clientX, e.clientY);
        return;
      }
      if (!S.$('.pop').hidden) closePop(S);
      const t = deepAt(S, e.clientX, e.clientY);
      // A double-click on the selected element edits its text (pointer events carry no click count: time it ourselves).
      const now = Date.now();
      const twice = t && t === S.lastDown && now - (S.lastDownAt || 0) < 450;
      S.lastDown = t;
      S.lastDownAt = now;
      if (twice && t === S.selected && editableText(t)) return startEdit(S, t);
      S.ignoreMovesUntil = now + 900;
      S.hover = null;
      setSelected(S, t);
    };
    const onKey = (e) => {
      if (S.editing) {
        if (e.key === 'Escape') return block(e), endEdit(S, false);
        if (e.key === 'Enter' && !e.shiftKey) return block(e), endEdit(S, true);
        return;
      }
      if (inOverlay(e)) {
        const pop = S.$('.pop');
        if (e.key === 'Escape') return block(e), closePop(S);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !pop.hidden) {
          block(e);
          pop.querySelector('[data-act="post"], [data-act="reply"]')?.click();
        }
        return;
      }
      if (S.mode === 'browse') return;
      if (S.undoKeys && (e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
        block(e);
        return emit({ t: 'key', key: e.shiftKey || /y/i.test(e.key) ? 'redo' : 'undo' });
      }
      if (e.key === 'Escape') {
        block(e);
        if (!S.$('.pop').hidden) return closePop(S);
        if (S.selected) return setSelected(S, null);
        return;
      }
      if (S.mode === 'select' && S.selected) {
        if (e.key === 'ArrowUp') {
          block(e);
          const p = S.selected.parentElement || S.selected.getRootNode?.().host;
          if (p && p !== D.documentElement) setSelected(S, p);
        } else if (e.key === 'ArrowDown') {
          block(e);
          if (S.selected.firstElementChild) setSelected(S, S.selected.firstElementChild);
        } else if (e.key === 'Enter' && editableText(S.selected)) {
          block(e);
          startEdit(S, S.selected);
        }
      }
    };
    const swallow = (e) => {
      if (S.mode === 'browse' || inOverlay(e)) return;
      if (S.editing && e.composedPath().includes(S.editing)) return;
      block(e);
    };
    W.addEventListener('pointermove', onMove, true);
    W.addEventListener('pointerdown', onDown, true);
    for (const t of ['mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu']) W.addEventListener(t, swallow, true);
    W.addEventListener('keydown', onKey, true);
    W.addEventListener('keyup', (e) => S.mode !== 'browse' && !S.editing && !inOverlay(e) && block(e), true);
    W.addEventListener('keypress', (e) => S.mode !== 'browse' && !S.editing && !inOverlay(e) && block(e), true);
    const redraw = () => draw(S);
    W.addEventListener('scroll', redraw, true);
    W.addEventListener('resize', redraw);
    let mo = null;
    try {
      let t = null;
      mo = new MutationObserver(() => {
        if (S.style && !S.style.isConnected) writeStyles(S); // a framework re-rendered <head>
        clearTimeout(t);
        t = setTimeout(redraw, 60);
      });
      mo.observe(D.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch {}
    S.mo = mo;
    S.off = () => {
      W.removeEventListener('pointermove', onMove, true);
      W.removeEventListener('pointerdown', onDown, true);
      W.removeEventListener('keydown', onKey, true);
      W.removeEventListener('scroll', redraw, true);
      W.removeEventListener('resize', redraw);
      mo?.disconnect();
    };

    // The overlay's own buttons.
    sh.addEventListener('click', (e) => {
      const pin = e.target.closest?.('.pin');
      if (pin?.dataset.id) return openThread(S, pin.dataset.id);
      const b = e.target.closest?.('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const pop = S.$('.pop');
      const ta = pop.querySelector('textarea');
      if (act === 'close' || act === 'cancel') return closePop(S);
      if (act === 'designer' && S.selected) return emit({ t: 'designer', selector: cssPath(S.selected) });
      if (act === 'comment' && S.selected) {
        const r = S.selected.getBoundingClientRect();
        return startDraft(S, r.left + Math.min(r.width, 24), r.top + Math.min(r.height / 2, 24), S.selected);
      }
      if (act === 'edit-text' && S.selected) return startEdit(S, S.selected);
      if (act === 'post' && S.draft) {
        const text = (ta?.value || '').trim();
        if (!text) return ta?.focus();
        const d = S.draft;
        emit({ t: 'comment', selector: d.selector, offset: d.offset, text, rect: d.rect, label: label(d.el) });
        return closePop(S);
      }
      if (act === 'reply' && S.active) {
        const text = (ta?.value || '').trim();
        if (!text) return ta?.focus();
        emit({ t: 'reply', id: S.active, text });
        ta.value = '';
        return;
      }
      if (act === 'resolve' && S.active) {
        emit({ t: 'resolve', id: S.active });
        return closePop(S);
      }
    });
    sh.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /* ---------------- changes shown live ---------------- */

  // Style changes are rules in a stylesheet of the overlay's own: `target` (the element's own selector unless the
  // change is for everything a class or tag matches), `state` (':hover'…) and `media` ('max-width: 768px'). Each is
  // !important and a notch more specific than anything the page has, so it shows whatever the page's CSS says; the
  // marker in the selector is also how the main process tells these rules from the page's.
  const STATES = ['hover', 'focus', 'focus-visible', 'focus-within', 'active'];
  const MARK = ':not(#ld-site-editor):not(#ld-site-editor)';
  const mediaOf = (c) => (/^(max|min)-width: \d+(\.\d+)?px$/.test(c.media || '') ? c.media : '');
  const stateOf = (c) => (STATES.includes(c.state) ? c.state : '');
  const validSel = (q) => {
    try {
      D.querySelector(q);
      return true;
    } catch {
      return false;
    }
  };
  function writeStyles(S) {
    const list = [...S.changes.values()].map((e) => e.change).filter((c) => c.kind === 'style' && Object.keys(c.props || {}).length);
    if (!list.length) {
      S.style?.remove();
      S.style = null;
      return;
    }
    if (!S.style || !S.style.isConnected) {
      S.style = D.createElement('style');
      S.style.setAttribute('data-ld-overlay', '');
      (D.head || D.documentElement).append(S.style);
    }
    const sheet = S.style.sheet;
    while (sheet.cssRules.length) sheet.deleteRule(0);
    // Later wins among equals: plain rules, then states, then widths (desktop-first: narrower max-widths later;
    // mobile-first: wider min-widths later).
    const order = (c) => {
      const m = mediaOf(c);
      const w = m ? parseFloat(m.split(': ')[1]) : 0;
      return (m ? (m.startsWith('max') ? 2e6 - w : 4e6 + w) : 0) + (stateOf(c) ? 0.5 : 0);
    };
    for (const c of list.sort((a, b) => order(a) - order(b))) {
      const q = c.target && validSel(c.target) ? c.target : c.selector;
      if (!validSel(q)) continue;
      const st = stateOf(c);
      const sel = `:is(${q})${st ? ':' + st : ''}${MARK}`;
      const m = mediaOf(c);
      try {
        const i = sheet.insertRule(m ? `@media (${m}) { ${sel} {} }` : `${sel} {}`, sheet.cssRules.length);
        const rule = m ? sheet.cssRules[i].cssRules[0] : sheet.cssRules[i];
        for (const [prop, v] of Object.entries(c.props)) if (v.after !== '' && v.after != null) rule.style.setProperty(prop, String(v.after).replace(/\s*!important\s*$/i, ''), 'important');
      } catch {}
    }
  }

  function apply(S, change) {
    revert(S, change.id, { keep: true });
    const el = find(change.selector) || (change.kind === 'style' && change.target ? find(change.target) : null);
    if (!el) return { ok: false, error: 'Element not found' };
    const entry = { change, el, orig: {} };
    if (change.kind === 'style') {
      S.changes.set(change.id, entry);
      writeStyles(S);
      draw(S);
      return { ok: true };
    } else if (change.kind === 'text') {
      entry.orig.html = el.innerHTML;
      if (change.rich && change.afterHtml != null) el.innerHTML = cleanHtml(change.afterHtml);
      else el.textContent = change.after;
    } else if (change.kind === 'component') {
      const tpl = D.createElement('template');
      tpl.innerHTML = change.html || '';
      const fresh = tpl.content.firstElementChild;
      if (!fresh) return { ok: false, error: 'No markup' };
      fresh.setAttribute('data-ld-component', change.id);
      const style = D.createElement('style');
      style.setAttribute('data-ld-overlay', '');
      style.textContent = change.css || '';
      D.head.append(style);
      entry.orig.node = el;
      entry.orig.style = style;
      el.replaceWith(fresh);
      entry.el = fresh;
      if (S.selected === el) S.selected = fresh;
    }
    S.changes.set(change.id, entry);
    draw(S);
    return { ok: true };
  }
  function revert(S, id, { keep = false } = {}) {
    const entry = S.changes.get(id);
    if (!entry) return;
    const { change, el, orig } = entry;
    S.changes.delete(id);
    if (change.kind === 'style') {
      if (!keep) writeStyles(S);
    } else if (change.kind === 'text' && el) el.innerHTML = orig.html;
    else if (change.kind === 'component') {
      if (el?.isConnected && orig.node) el.replaceWith(orig.node);
      orig.style?.remove();
      if (S.selected === el) S.selected = orig.node;
    }
    if (!keep) draw(S);
  }

  /**
   * Does the page, as served now, have each change? (Run after Claude's turn and a reload, before anything's
   * re-applied.) A style change is in the page when setting it on the element makes no difference anymore; one for a
   * state, or for a width the page isn't at, can't be told from here ('unknown').
   */
  function verify(changes) {
    const out = {};
    const still = D.createElement('style');
    still.textContent = '*, *::before, *::after { transition: none !important; }';
    (D.head || D.documentElement).append(still);
    try {
      for (const c of changes) {
        const el = find(c.selector);
        if (!el) {
          out[c.id] = c.kind === 'component' ? 'unknown' : false;
          continue;
        }
        if (c.kind === 'text') out[c.id] = (el.textContent || '').replace(/\s+/g, ' ').trim() === String(c.after || '').replace(/\s+/g, ' ').trim() || (!!c.afterHtml && normHtml(el.innerHTML) === normHtml(c.afterHtml));
        else if (c.kind === 'style') {
          if (stateOf(c) || (mediaOf(c) && !W.matchMedia(`(${mediaOf(c)})`).matches)) {
            out[c.id] = 'unknown';
            continue;
          }
          const cs = getComputedStyle(el);
          const props = Object.entries(c.props || {}).filter(([, v]) => v.after !== '' && v.after != null);
          const have = props.map(([prop]) => cs.getPropertyValue(prop));
          const was = el.getAttribute('style');
          for (const [prop, v] of props) el.style.setProperty(prop, String(v.after), 'important');
          const want = props.map(([prop]) => cs.getPropertyValue(prop));
          if (was == null) el.removeAttribute('style');
          else el.setAttribute('style', was);
          out[c.id] = props.every(([, v], i) => have[i] === want[i] || have[i].replace(/\s/g, '') === String(v.after).replace(/\s/g, ''));
        } else if (c.kind === 'component') out[c.id] = c.before ? el.outerHTML.slice(0, 4000) !== c.before : 'unknown';
      }
    } finally {
      still.remove();
    }
    return out;
  }

  /** The page's custom properties (from :root and html rules): what a color or a size can be set to by name. */
  function vars() {
    const names = new Set();
    const walk = (rules) => {
      for (const r of rules || []) {
        if (r.cssRules && !r.selectorText) walk(r.cssRules); // @media, @layer, @supports
        if (!r.selectorText || !/(^|,)\s*(:root|html|body)\b/.test(r.selectorText)) continue;
        for (const name of r.style) if (name.startsWith('--')) names.add(name);
      }
    };
    for (const sheet of D.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {} // another origin's stylesheet
    }
    const cs = getComputedStyle(D.body || D.documentElement);
    return [...names].slice(0, 400).map((name) => ({ name, value: cs.getPropertyValue(name).trim().slice(0, 120) })).filter((v) => v.value);
  }

  /** The widths the page's own media queries turn on (its breakpoints), as 'max-width: 768px' / 'min-width: 1024px'. */
  function widths() {
    const out = new Set();
    const add = (kind, n, unit) => {
      const v = Math.round(parseFloat(n) * (unit === 'px' ? 1 : 16));
      if (v > 0) out.add(`${kind}-width: ${v}px`);
    };
    const walk = (rules) => {
      for (const r of rules || []) {
        const q = r.media?.mediaText || '';
        for (const m of q.matchAll(/\((max|min)-width:\s*([\d.]+)(px|em|rem)\)/g)) add(m[1], m[2], m[3]);
        for (const m of q.matchAll(/\(\s*width\s*(<|>)=?\s*([\d.]+)(px|em|rem)\s*\)/g)) add(m[1] === '<' ? 'max' : 'min', m[2], m[3]);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const sheet of D.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {} // another origin's stylesheet
    }
    const n = (s) => parseFloat(s.split(': ')[1]);
    return [...out].sort((a, b) => (a[1] === b[1] ? (a[1] === 'a' ? n(b) - n(a) : n(a) - n(b)) : a[1] === 'a' ? -1 : 1)).slice(0, 16);
  }

  /* ---------------- the entry point ---------------- */

  if (mode === 'stop') {
    const S = W[KEY];
    if (!S) return true;
    if (S.editing) endEdit(S, false);
    for (const id of [...S.changes.keys()]) revert(S, id, { keep: true });
    S.style?.remove();
    S.still?.remove();
    S.off?.();
    S.host.remove();
    delete W[KEY];
    return true;
  }
  if (mode === 'verify') return verify(Array.isArray(opts.changes) ? opts.changes : []);
  if (mode === 'info') {
    if (W[KEY] && Array.isArray(opts.props)) W[KEY].extra = opts.props;
    return info(find(opts.selector), opts.props);
  }
  if (mode === 'vars') return vars();
  if (mode === 'widths') return widths();

  const S = install();
  if (mode === 'start') {
    if (opts.mode) S.mode = opts.mode;
    // App Builder uses the overlay without Designer: the selection's toolbar then offers a comment instead.
    S.$('[data-act="designer"]').hidden = opts.designer === false;
    S.$('[data-act="comment"]').hidden = opts.designer !== false;
    for (const id of [...S.changes.keys()]) revert(S, id, { keep: true });
    writeStyles(S);
    for (const c of opts.changes || []) if (c.status !== 'applied') apply(S, c);
    if (Array.isArray(opts.props)) S.extra = opts.props;
    S.undoKeys = !!opts.undo; // the Site Editor undoes changes itself; elsewhere Ctrl+Z stays the page's
    S.hint = null;
    S.comments = Array.isArray(opts.comments) ? opts.comments : [];
    if (opts.selected) S.selected = find(opts.selected);
    showBar(S);
    draw(S);
    return { ok: true, url: location.href, title: D.title };
  }
  if (mode === 'mode') {
    S.mode = ['browse', 'select', 'comment'].includes(opts.mode) ? opts.mode : 'browse';
    if (S.editing) endEdit(S, true);
    S.hover = null;
    if (S.mode === 'browse') closePop(S);
    showBar(S);
    draw(S);
    return true;
  }
  if (mode === 'select') {
    const el = find(opts.selector);
    setSelected(S, el, { silent: true });
    if (el && opts.scroll !== false) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return info(el);
  }
  if (mode === 'edit') {
    const el = find(opts.selector);
    if (!el || !textKind(el)) return false;
    if (S.selected !== el) setSelected(S, el, { silent: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    startEdit(S, el);
    return true;
  }
  if (mode === 'parent') {
    const el = find(opts.selector);
    const p = el && (el.parentElement || el.getRootNode?.().host);
    if (!p || p === D.documentElement) return null;
    setSelected(S, p, { silent: true });
    return info(p);
  }
  if (mode === 'apply') return apply(S, opts);
  if (mode === 'hint') {
    S.hint = ['padding', 'margin', 'gap'].includes(opts.kind) ? { kind: opts.kind, side: opts.side || 'all' } : null;
    draw(S);
    return true;
  }
  if (mode === 'revert') return revert(S, opts.id), true;
  if (mode === 'pins') {
    S.comments = Array.isArray(opts.comments) ? opts.comments : S.comments;
    if (opts.active !== undefined) {
      if (opts.active) openThread(S, opts.active);
      else closePop(S);
    } else if (S.active && !S.comments.some((c) => c.id === S.active)) closePop(S);
    else if (S.active) openThread(S, S.active);
    drawPins(S);
    return true;
  }
  if (mode === 'quiet') {
    S.quiet = !!opts.on;
    S.$('.bar').hidden = S.quiet || S.mode === 'browse';
    if (S.quiet) S.$('.pop').hidden = true;
    else if (S.active) openThread(S, S.active);
    draw(S);
    return true;
  }
  return null;
}
