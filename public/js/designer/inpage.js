// Designer's element capture. This one function runs inside a page: a site window (electron/designer.cjs injects it in
// an isolated world), Leafdeck's own interface, a hidden frame holding pasted HTML, or another browser (as a
// bookmarklet). It must stay self-contained: no imports, nothing from outside the function.
//
//   inPage('pick', { at, hint, exclude, copy })  → Promise of a capture, or null when cancelled (Esc)
//     Hover to highlight, click (or Enter) to capture; ↑ / ↓ walk to the parent / back to the child.
//     at: { x, y } starts on the element there; exclude: an element never to pick (Designer's own window);
//     copy: put the capture on the clipboard (the bookmarklet), for pasting into Designer.
//   inPage('serialize', { el | selector }) → a capture of that element now
//   inPage('cancel') stops a pick; inPage('unmark') removes the marker a pick left (see `mark`).
//
// A capture: { v: 1, url, title, root, html, fonts, fontSheets, images, rect, dpr, token }
//   root: { t: tag, r: { x, y, w, h } (relative to the root), s: { computed styles that aren't the default },
//           a: attributes, c: children, text / runs / tr / lines (text), svg, img, value, ph, before / after }
export default function inPage(mode, opts = {}) {
  const W = window;
  const KEY = '__leafdeckDesignerPick';
  const MARK = 'data-ld-capture';
  if (mode === 'cancel') return W[KEY]?.cancel(), true;
  if (mode === 'unmark') {
    document.querySelectorAll(`[${MARK}], [data-ld-focus]`).forEach((e) => (e.removeAttribute(MARK), e.removeAttribute('data-ld-focus')));
    return true;
  }

  /* ---------------- serializing ---------------- */

  // Computed styles worth keeping, with the value that means "nothing set".
  const PROPS = {
    display: '', position: 'static', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'justify-content': 'normal', 'align-items': 'normal',
    'align-self': 'auto', 'flex-grow': '0', 'row-gap': 'normal', 'column-gap': 'normal',
    'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
    'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
    'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none',
    'border-top-color': '', 'border-right-color': '', 'border-bottom-color': '', 'border-left-color': '',
    'border-top-left-radius': '0px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px',
    'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'background-size': 'auto', 'background-position': '0% 0%',
    'background-repeat': 'repeat', 'background-clip': 'border-box',
    'box-shadow': 'none', opacity: '1', color: '', 'font-family': '', 'font-size': '', 'font-weight': '', 'font-style': 'normal',
    'line-height': 'normal', 'letter-spacing': 'normal', 'text-align': 'start', 'text-transform': 'none', 'text-decoration-line': 'none',
    'text-decoration-color': '', 'text-decoration-style': 'solid', 'white-space': 'normal', 'text-overflow': 'clip', 'text-shadow': 'none',
    'overflow-x': 'visible', 'overflow-y': 'visible', 'outline-style': 'none', 'outline-width': '', 'outline-color': '', 'outline-offset': '0px',
    filter: 'none', 'backdrop-filter': 'none', 'mix-blend-mode': 'normal', cursor: 'auto', transform: 'none', 'object-fit': 'fill',
    visibility: 'visible', 'z-index': 'auto', '-webkit-line-clamp': 'none', 'box-sizing': '', width: '', height: '',
    top: 'auto', left: 'auto', right: 'auto', bottom: 'auto', fill: '', stroke: '', 'pointer-events': 'auto',
  };
  const ALWAYS = new Set(['display', 'color', 'font-family', 'font-size', 'font-weight']);
  const SKIP_TAGS = /^(script|style|template|noscript|meta|link|head|title|base)$/;

  function serialize(rootEl) {
    const doc = rootEl.ownerDocument;
    const win = doc.defaultView;
    const R = rootEl.getBoundingClientRect();
    const images = new Set();
    const families = new Set();
    let count = 0;
    const rel = (r) => ({ x: round(r.left - R.left), y: round(r.top - R.top), w: round(r.width), h: round(r.height) });
    const round = (n) => Math.round(n * 100) / 100;
    const styles = (cs) => {
      const o = {};
      for (const k in PROPS) {
        const v = cs.getPropertyValue(k);
        if (v && (ALWAYS.has(k) || v !== PROPS[k])) o[k] = v;
      }
      // Border colors only matter where there's a border.
      for (const side of ['top', 'right', 'bottom', 'left']) if (o[`border-${side}-style`] == null || o[`border-${side}-width`] == null) delete o[`border-${side}-color`];
      if (!o['outline-style']) delete o['outline-width'], delete o['outline-color'];
      if (!o['text-decoration-line']) delete o['text-decoration-color'];
      return o;
    };
    const urlsIn = (v) => {
      const out = [];
      String(v || '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, q, u) => out.push(u));
      return out;
    };
    const absUrl = (u) => {
      try {
        return new URL(u, doc.baseURI).href;
      } catch {
        return u;
      }
    };
    const collapse = (t, ws) => (/^(pre|pre-wrap|break-spaces)$/.test(ws) ? t : /^pre-line$/.test(ws) ? t.replace(/[ \t]+/g, ' ') : t.replace(/\s+/g, ' '));
    const lineCount = (rects) => new Set([...rects].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    const famOf = (f) => String(f || '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const visual = (s) =>
      (s['background-color'] && s['background-color'] !== 'rgba(0, 0, 0, 0)') || (s['background-image'] && s['background-image'] !== 'none') ||
      parseFloat(s['border-top-width']) || parseFloat(s['border-right-width']) || parseFloat(s['border-bottom-width']) || parseFloat(s['border-left-width']) ||
      (s['box-shadow'] && s['box-shadow'] !== 'none') || parseFloat(s['padding-left']) || parseFloat(s['padding-right']) || parseFloat(s['padding-top']) || parseFloat(s['padding-bottom']);

    function svgMarkup(svg) {
      const copy = svg.cloneNode(true);
      const DEF = { fill: 'rgb(0, 0, 0)', stroke: 'none', 'stroke-width': '1px', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-dasharray': 'none', opacity: '1', 'fill-opacity': '1', 'stroke-opacity': '1', 'fill-rule': 'nonzero' };
      const from = [svg, ...svg.querySelectorAll('*')];
      const to = [copy, ...copy.querySelectorAll('*')];
      from.forEach((node, i) => {
        const cs = win.getComputedStyle(node);
        for (const k in DEF) if (cs.getPropertyValue(k) !== DEF[k]) to[i].style.setProperty(k, cs.getPropertyValue(k));
        if (node.tagName === 'text') for (const k of ['font-family', 'font-size', 'font-weight']) to[i].style.setProperty(k, cs.getPropertyValue(k));
        for (const a of ['href', 'xlink:href']) {
          const v = node.getAttribute(a);
          if (node.tagName === 'image' && v && !v.startsWith('#')) to[i].setAttribute(a, absUrl(v)), images.add(absUrl(v));
        }
      });
      copy.style.color = win.getComputedStyle(svg).color;
      // What it draws from elsewhere on the page: <use> symbols, and gradients, masks, clip paths, filters and markers
      // referenced as url(#id). Brought inside, so the SVG works on its own.
      const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const refs = (el) => {
        const ids = [];
        const ref = el.getAttribute?.('href') || el.getAttribute?.('xlink:href') || '';
        if (el.tagName === 'use' && ref.startsWith('#')) ids.push(ref.slice(1));
        const cs = el.nodeType === 1 ? win.getComputedStyle(el) : null;
        for (const k of ['fill', 'stroke', 'mask', 'clip-path', 'filter', 'marker-start', 'marker-mid', 'marker-end']) {
          const v = (cs?.getPropertyValue(k) || '') + ' ' + (el.getAttribute?.(k) || '');
          for (const m of v.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) ids.push(m[1]);
        }
        return ids;
      };
      const pending = [svg, ...svg.querySelectorAll('*')].flatMap(refs);
      for (let n = 0; pending.length && n < 60; n++) {
        const id = pending.shift();
        const target = doc.getElementById(id);
        if (!target || svg.contains(target) || defs.querySelector(`#${CSS.escape(id)}`)) continue;
        const c = target.cloneNode(true);
        defs.append(c);
        pending.push(...[target, ...target.querySelectorAll('*')].flatMap(refs));
      }
      if (defs.childNodes.length) copy.prepend(defs);
      const r = svg.getBoundingClientRect();
      copy.setAttribute('width', round(r.width));
      copy.setAttribute('height', round(r.height));
      if (!copy.getAttribute('xmlns')) copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copy.removeAttribute('class');
      return new XMLSerializer().serializeToString(copy);
    }

    function pseudo(el, which, box) {
      const cs = win.getComputedStyle(el, which);
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal' || cs.display === 'none') return null;
      const s = styles(cs);
      const w = parseFloat(cs.width) || 0;
      const h = parseFloat(cs.height) || 0;
      let text = '';
      const m = /^"(.*)"$/s.exec(content);
      if (m) text = m[1].replace(/\\"/g, '"');
      else if (/^url\(/.test(content)) urlsIn(content).forEach((u) => images.add(absUrl(u)));
      urlsIn(s['background-image']).forEach((u) => images.add(absUrl(u)));
      if (!text && !w && !h) return null;
      famOf(s['font-family']).slice(0, 1).forEach((f) => families.add(f.toLowerCase()));
      return { text, img: /^url\(/.test(content) ? absUrl(urlsIn(content)[0]) : undefined, s, w, h, box };
    }

    function walkEl(el, depth) {
      if (depth > 60 || ++count > 5000) return null;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.test(tag) || el.hasAttribute?.('data-ld-overlay')) return null;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none') return null;
      const r = el.getBoundingClientRect();
      const s = styles(cs);
      const node = { t: tag, r: rel(r), s };
      if (cs.transform !== 'none' && el.offsetWidth != null) Object.assign(node, { ow: el.offsetWidth, oh: el.offsetHeight });
      const a = {};
      for (const k of ['id', 'role', 'aria-label', 'type', 'placeholder', 'href', 'alt', 'title', 'name', 'disabled', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed']) {
        const v = el.getAttribute(k);
        if (v != null) a[k] = k === 'href' ? absUrl(v).slice(0, 300) : String(v).slice(0, 200);
      }
      const cls = String(el.getAttribute('class') || '').trim();
      if (cls) a.class = cls.split(/\s+/).slice(0, 6).join(' ');
      if (Object.keys(a).length) node.a = a;
      famOf(s['font-family']).slice(0, 1).forEach((f) => families.add(f.toLowerCase()));
      urlsIn(s['background-image']).forEach((u) => images.add(absUrl(u)));

      if (tag === 'svg') {
        node.svg = svgMarkup(el);
        return node;
      }
      if (tag === 'img' || (tag === 'input' && el.type === 'image')) {
        const src = el.currentSrc || el.src;
        if (src) images.add(src), (node.img = src);
        return node;
      }
      if (tag === 'canvas') {
        try {
          node.img = el.toDataURL('image/png');
        } catch {}
        return node;
      }
      if (tag === 'video') {
        try {
          const c = doc.createElement('canvas');
          c.width = el.videoWidth;
          c.height = el.videoHeight;
          c.getContext('2d').drawImage(el, 0, 0);
          node.img = c.toDataURL('image/jpeg', 0.85);
        } catch {
          if (el.poster) images.add(absUrl(el.poster)), (node.img = absUrl(el.poster));
        }
        return node;
      }
      if (tag === 'iframe' || tag === 'object' || tag === 'embed') return (node.frame = true), node;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (tag === 'select') node.value = el.selectedOptions?.[0]?.textContent?.trim() || '';
        else if (!/^(checkbox|radio|range|color|file|submit|button|reset|hidden)$/.test(el.type)) {
          node.value = el.type === 'password' ? '•'.repeat(String(el.value).length) : el.value;
          node.ph = el.getAttribute('placeholder') || '';
          node.phColor = win.getComputedStyle(el, '::placeholder').color;
        } else if (/^(submit|button|reset)$/.test(el.type)) node.value = el.value;
        if (/^(checkbox|radio)$/.test(el.type)) node.checked = el.checked;
        return node;
      }

      const before = pseudo(el, '::before', r);
      const after = pseudo(el, '::after', r);
      if (before) node.before = before;
      if (after) node.after = after;

      // Children, through open shadow roots and slots (what's actually drawn).
      const kids = [];
      const list = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
      const add = (n) => {
        if (n.nodeType === 3) {
          const raw = n.textContent;
          if (!raw.trim()) return;
          const range = doc.createRange();
          range.selectNodeContents(n);
          const br = range.getBoundingClientRect();
          if (!br.width && !br.height) return;
          kids.push({ text: collapse(raw, cs.whiteSpace), r: rel(br), lines: lineCount(range.getClientRects()) });
        } else if (n.nodeType === 1) {
          if (n.tagName === 'SLOT') return n.assignedNodes({ flatten: true }).forEach(add);
          const c = walkEl(n, depth + 1);
          if (c) kids.push(c);
        }
      };
      list.forEach(add);
      node.c = kids;

      // Text with inline formatting (<b>, <a>, <em>…) inside: one text layer, with its runs. (A raw text run has no
      // tag; an element that already became text has one, and only counts if it's a plain inline one.)
      const isRun = (k) => k.t == null;
      const inlineOnly = node.c.length && node.c.some(isRun) && node.c.every((k) => isRun(k) || isPlainInline(k));
      if (inlineOnly) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        const runs = [];
        const flat = (k, inherited) => {
          if (isRun(k)) return runs.push({ text: k.text, s: inherited });
          const st = { ...inherited };
          for (const p of ['color', 'font-weight', 'font-style', 'text-decoration-line', 'font-size', 'font-family']) if (k.s[p] && k.s[p] !== s[p]) st[p] = k.s[p];
          if (k.t === 'a' && k.a?.href) st.__href = k.a.href;
          if (k.runs) k.runs.forEach((r) => runs.push({ text: r.text, s: { ...st, ...r.s } }));
          else if (k.text != null) runs.push({ text: k.text, s: st });
          else (k.c || []).forEach((x) => flat(x, st));
        };
        node.c.forEach((k) => flat(k, {}));
        const pre = /^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace);
        if (!pre && runs.length) {
          runs[0].text = runs[0].text.replace(/^\s+/, '');
          runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
        }
        const text = runs.map((x) => x.text).join('');
        const tr = range.getBoundingClientRect();
        node.text = text;
        if (runs.some((x) => Object.keys(x.s).length)) node.runs = runs.filter((x) => x.text);
        node.tr = rel(tr);
        node.lines = lineCount(range.getClientRects());
        delete node.c;
      }
      return node;
    }
    const isPlainInline = (k) =>
      /^inline$/.test(k.s.display) && !visual(k.s) && !k.svg && !k.img && !k.before && !k.after && k.value == null && (k.c || []).every((x) => x.t == null || isPlainInline(x));

    const root = walkEl(rootEl, 0);

    // Fonts: the @font-face rules for the families used, from the stylesheets we can read; the rest by address.
    const fonts = [];
    const fontSheets = [];
    const scan = (rules, href) => {
      for (const rule of rules) {
        if (rule.type === 5 /* @font-face */) {
          const fam = famOf(rule.style.getPropertyValue('font-family'))[0];
          if (!fam || !families.has(fam.toLowerCase())) continue;
          const range = rule.style.getPropertyValue('unicode-range');
          if (range && !/U\+0(000)?-|U\+0-|U\+20(-|,|$)|U\+0000/i.test(range)) continue; // only the Latin subset
          const src = rule.style.getPropertyValue('src');
          const urls = [];
          src.replace(/url\(\s*(['"]?)(.*?)\1\s*\)\s*(format\(\s*['"]?([\w-]+)['"]?\s*\))?/g, (_, q, u, f, fmt) => urls.push({ u, fmt: fmt || '' }));
          const best = urls.find((x) => /woff2/.test(x.fmt + x.u)) || urls.find((x) => /woff/.test(x.fmt + x.u)) || urls[0];
          if (best && fonts.length < 16) {
            let u = best.u;
            try {
              u = new URL(u, href || doc.baseURI).href;
            } catch {}
            fonts.push({ family: fam, weight: rule.style.getPropertyValue('font-weight') || 'normal', style: rule.style.getPropertyValue('font-style') || 'normal', src: u });
          }
        } else if (rule.styleSheet) {
          try {
            scan(rule.styleSheet.cssRules, rule.styleSheet.href || href);
          } catch {
            rule.styleSheet.href && fontSheets.push(rule.styleSheet.href);
          }
        } else if (rule.cssRules) scan(rule.cssRules, href);
      }
    };
    const sheets = [...doc.styleSheets, ...(doc.adoptedStyleSheets || [])];
    for (const sh of sheets) {
      try {
        scan(sh.cssRules, sh.href);
      } catch {
        if (sh.href) fontSheets.push(sh.href);
      }
    }

    // The original markup, for reference: trimmed, without scripts or huge inline data.
    let html = '';
    try {
      const clone = rootEl.cloneNode(true);
      clone.querySelectorAll?.('script, style, noscript, template').forEach((x) => x.remove());
      clone.removeAttribute?.(MARK);
      for (const x of [clone, ...(clone.querySelectorAll?.('*') || [])]) {
        for (const at of [...(x.attributes || [])]) if (at.value.length > 300 || /^on/i.test(at.name)) x.setAttribute(at.name, at.value.length > 300 ? at.value.slice(0, 80) + '…' : '');
      }
      html = (clone.outerHTML || '').slice(0, 40000);
    } catch {}

    // What it sits on: the first background behind it (for a transparent button on a dark page).
    let backdrop = '';
    for (let a = rootEl.parentElement; a && !backdrop; a = a.parentElement) {
      const bg = win.getComputedStyle(a).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') backdrop = bg;
    }

    return {
      v: 1,
      backdrop: backdrop || 'rgb(255, 255, 255)',
      url: doc.location?.href || '',
      title: doc.title || '',
      root,
      html,
      fonts,
      families: [...families],
      fontSheets: [...new Set(fontSheets)].slice(0, 12),
      images: [...images].filter((u) => u && !u.startsWith('data:')).slice(0, 80),
      rect: { x: R.left, y: R.top, w: R.width, h: R.height },
      dpr: win.devicePixelRatio || 1,
    };
  }

  const mark = (el) => {
    const token = Math.random().toString(36).slice(2, 10);
    el.setAttribute(MARK, token);
    return token;
  };

  if (mode === 'serialize') {
    const el = opts.el || document.querySelector(opts.selector);
    if (!el) return null;
    return serialize(el);
  }

  /* ---------------- picking ---------------- */

  if (mode !== 'pick') return null;
  W[KEY]?.cancel();
  const doc = document;
  return new Promise((resolve) => {
    const host = doc.createElement('div');
    host.setAttribute('data-ld-overlay', '');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>
      .box { position: fixed; border: 1.5px solid #0d99ff; background: rgba(13, 153, 255, 0.12); border-radius: 2px; pointer-events: none; transition: all 0.06s ease-out; box-sizing: border-box; }
      .pad { position: absolute; inset: 0; border-style: solid; border-color: rgba(147, 196, 125, 0.35); box-sizing: border-box; }
      .tag { position: absolute; left: -1.5px; top: -24px; white-space: nowrap; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: #0d99ff; padding: 5px 7px; border-radius: 4px; }
      .tag i { font-style: normal; font-weight: 400; opacity: 0.8; margin-left: 6px; }
      .tag.below { top: auto; bottom: -24px; }
      .bar { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); font: 500 12.5px/1.3 system-ui, sans-serif; color: #fff;
        background: rgba(20, 22, 26, 0.92); padding: 10px 16px; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.35); white-space: nowrap; }
      .bar b { color: #7cc4ff; font-weight: 600; }
      .bar kbd { font: inherit; background: rgba(255,255,255,0.14); border-radius: 4px; padding: 1px 6px; margin: 0 2px; }
      .done { position: fixed; left: 50%; top: 22px; transform: translateX(-50%); font: 600 13px system-ui, sans-serif; color: #fff; background: #1f9d45; padding: 10px 16px; border-radius: 10px; }
    </style><div class="box" hidden><div class="pad"></div><span class="tag"></span></div>
    <div class="bar"><b>${opts.copy ? 'Leafdeck Designer' : 'Capture an element'}</b> · Click to capture · <kbd>↑</kbd><kbd>↓</kbd> parent / child · <kbd>Enter</kbd> capture · <kbd>Esc</kbd> cancel</div>`;
    (doc.documentElement || doc.body).append(host);
    const box = sh.querySelector('.box');
    const pad = sh.querySelector('.pad');
    const tag = sh.querySelector('.tag');
    let target = null;
    let down = [];
    let done = false;

    const deepAt = (x, y) => {
      let e = doc.elementFromPoint(x, y);
      while (e?.shadowRoot) {
        const inner = e.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === e) break;
        e = inner;
      }
      return e;
    };
    const parentOf = (e) => e.parentElement || e.getRootNode?.().host || null;
    const exclude = opts.exclude || (opts.excludeSelector && doc.querySelector(opts.excludeSelector));
    const allowed = (e) => e && e !== host && e !== doc.documentElement && !(exclude && exclude.contains(e));
    const draw = () => {
      if (!target) return (box.hidden = true);
      const r = target.getBoundingClientRect();
      const cs = getComputedStyle(target);
      box.hidden = false;
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      pad.style.borderWidth = ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue('padding-' + s)).join(' ');
      const cls = String(target.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
      tag.innerHTML = '';
      tag.append(target.tagName.toLowerCase() + (cls ? '.' + cls.slice(0, 28) : ''));
      const i = doc.createElement('i');
      i.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
      tag.append(i);
      tag.classList.toggle('below', r.top < 30);
    };
    const set = (e) => {
      if (!allowed(e)) return;
      target = e;
      draw();
    };
    const onMove = (e) => {
      const t = deepAt(e.clientX, e.clientY);
      if (t && t !== target && !down.includes(t) && allowed(t)) {
        down = [];
        set(t);
      }
    };
    const block = (e) => {
      if (e.isTrusted === false) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onDown = (e) => {
      block(e);
      // No hover yet (the pointer hadn't moved): what's under the click.
      if (e.button === 0 && !target) set(deepAt(e.clientX, e.clientY));
      if (e.button === 0) finish(target);
      else if (e.button === 2) finish(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') return block(e), finish(null);
      if (e.key === 'Enter') return block(e), finish(target);
      if (e.key === 'ArrowUp' && target) {
        block(e);
        const p = parentOf(target);
        if (allowed(p) && p !== doc.body) down.push(target), set(p);
      } else if (e.key === 'ArrowDown' && target) {
        block(e);
        set(down.pop() || target.firstElementChild || target);
      }
    };
    const onScroll = () => draw();
    const events = [['pointermove', onMove], ['pointerdown', onDown], ['mousedown', block], ['mouseup', block], ['pointerup', block], ['click', block], ['dblclick', block], ['contextmenu', block], ['keydown', onKey], ['keyup', block], ['scroll', onScroll]];
    events.forEach(([t, f]) => W.addEventListener(t, f, true));

    function finish(el) {
      if (done) return;
      done = true;
      delete W[KEY];
      host.remove();
      // Keep swallowing the rest of this click so the page doesn't act on it.
      setTimeout(() => events.forEach(([t, f]) => W.removeEventListener(t, f, true)), 350);
      if (!el) return resolve(null);
      let cap = null;
      try {
        const token = opts.mark ? mark(el) : null;
        cap = serialize(el);
        cap.token = token;
      } catch (err) {
        cap = { error: String(err && err.message || err) };
      }
      if (opts.copy && cap && !cap.error) {
        const text = 'LEAFDECK-ELEMENT/1\n' + JSON.stringify(cap);
        const fallback = () => {
          const ta = doc.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          doc.body.append(ta);
          ta.select();
          doc.execCommand('copy');
          ta.remove();
        };
        (navigator.clipboard?.writeText(text) || Promise.reject()).catch(fallback).finally(() => {
          const note = doc.createElement('div');
          note.style.cssText = 'all: initial; position: fixed; left: 50%; top: 22px; transform: translateX(-50%); z-index: 2147483647; font: 600 13px system-ui, sans-serif; color: #fff; background: #1f9d45; padding: 10px 16px; border-radius: 10px;';
          note.textContent = 'Copied. Paste it into Leafdeck Designer (Ctrl+V).';
          (doc.body || doc.documentElement).append(note);
          setTimeout(() => note.remove(), 2600);
        });
      }
      resolve(cap);
    }
    W[KEY] = { cancel: () => finish(null) };

    if (opts.at) set(deepAt(opts.at.x, opts.at.y));
  });
}
