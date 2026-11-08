// The print sheet (Linux): where to print (a printer, or Save as PDF), which pages, how many copies, the paper, the
// layout, margins, scale, headers and footers, and what the printer itself offers (trays, paper types, quality), with
// a preview of what comes out. Nothing on this computer shows GTK's print dialog in its place; electron/printing.cjs
// does the printing. It's drawn in Leafdeck's page (public/js/printui.js) and, when another program asks through the
// desktop portal, in a window of its own (public/js/picker.js).
//
// mode: 'page' lays a page out (all the choices); 'document' prints a PDF as it is, so its pages keep their own layout;
// 'settings' only asks: another program does the printing, so there's nothing to preview or save.
import { $, el, esc, debounce } from './util.js';
import { shell } from './shell.js';
import { ask } from './dialogs.js';

const PDF = '/pdf'; // "Save as PDF", among the printers (CUPS names can't have a slash)
const LS = 'ld.print'; // what you chose last time
const PAGES_RE = /^\s*\d+\s*(-\s*\d+\s*)?(,\s*\d+\s*(-\s*\d+\s*)?)*$/;
const PREVIEWED = ['pagesMode', 'pages', 'pageSize', 'margins', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'scale', 'headers', 'backgrounds'];

const remembered = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {};
  } catch {
    return {};
  }
};
const remember = (o) => {
  try {
    localStorage.setItem(LS, JSON.stringify(o));
  } catch {}
};
// What a document or another program's print leaves alone of what you chose for pages last time.
const pageChoices = (last) => Object.fromEntries(['margins', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'scale', 'headers', 'backgrounds'].filter((k) => k in last).map((k) => [k, last[k]]));
const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const reason = (e) => String(e?.message || e || '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');

/** Show the sheet. notify(text) tells you how it went; `win` is the window it belongs to. Resolves when it closes, to the choices in 'settings' mode. */
export async function printSheet({ id = 0, title = '', mode = 'page', win = null, notify = () => {} }) {
  const settingsOnly = mode === 'settings';
  const asIs = mode === 'document';
  const last = remembered();
  const printers = await shell.print.printers(id).catch(() => []);
  const def = printers.find((p) => p.name === last.printer) || printers.find((p) => p.isDefault) || printers[0];
  const standard = await shell.print.papers().catch(() => [{ name: 'Letter', label: 'Letter (8.5 × 11 in)' }, { name: 'A4', label: 'A4 (210 × 297 mm)' }, { name: 'Legal', label: 'Legal (8.5 × 14 in)' }]);
  const body = el(`<div class="pr${settingsOnly ? ' pr-settings' : ''}">
    <div class="pr-opts">
      <label class="field"><span>Destination</span><select name="printer">
        ${printers.map((p) => option(p.name, p.displayName, p === def)).join('')}
        ${settingsOnly ? '' : option(PDF, 'Save as PDF', !def)}</select></label>
      <p class="pr-sub" data-dest></p>
      <label class="field"><span>Pages</span><select name="pagesMode">
        ${option('all', 'All')}${option('odd', 'Odd pages only')}${option('even', 'Even pages only')}${option('custom', 'Custom…')}</select></label>
      <label class="field" data-custom hidden><input name="pages" placeholder="1-5, 8, 11-13" autocomplete="off" spellcheck="false" aria-label="Which pages"></label>
      <div class="pr-row" data-printer-only>
        <label class="field"><span>Copies</span><input name="copies" type="number" min="1" max="99" value="1"></label>
        <label class="field check" data-collate hidden><input type="checkbox" name="collate" checked><span>Collate</span></label>
      </div>
      <div class="field" data-page-only><span>Layout</span><div class="seg pr-seg" data-layout>
        <button type="button" data-v="portrait">Portrait</button><button type="button" data-v="landscape">Landscape</button></div></div>
      <label class="field"><span>Paper size</span><select name="pageSize"></select></label>
      <label class="field" data-printer-only data-color><span>Color</span><select name="color">${option('color', 'Color')}${option('bw', 'Black and white')}</select></label>
      <label class="field" data-printer-only data-duplex><span>Two-sided</span><select name="sides">
        ${option('off', 'Off')}${option('long', 'On, flip on the long edge')}${option('short', 'On, flip on the short edge')}</select></label>
      <details class="pr-more">
        <summary>More settings</summary>
        <div class="pr-more-body">
          <label class="field" data-page-only><span>Margins</span><select name="margins">
            ${option('default', 'Default')}${option('none', 'None')}${option('minimal', 'Minimal')}${option('custom', 'Custom…')}</select></label>
          <div class="pr-margins" data-custom-margins hidden>
            ${['Top', 'Bottom', 'Left', 'Right'].map((side) => `<label class="field"><span>${side}</span><div class="pr-unit"><input name="margin${side}" type="number" min="0" max="3" step="0.05" value="0.4"><span>in</span></div></label>`).join('')}
          </div>
          <label class="field" data-page-only><span>Scale</span><div class="pr-unit"><input name="scale" type="number" min="10" max="200" step="5" value="100"><span>%</span></div></label>
          <label class="field" data-printer-only><span>Pages per sheet</span><select name="perSheet">${[1, 2, 4, 6, 9, 16].map((n) => option(n, n)).join('')}</select></label>
          <div class="pr-extras" data-extras></div>
          <label class="field check" data-page-only><input type="checkbox" name="headers"><span>Headers and footers</span></label>
          <label class="field check" data-page-only><input type="checkbox" name="backgrounds" checked><span>Background graphics</span></label>
        </div>
      </details>
    </div>
    ${settingsOnly ? '' : `<div class="pr-side">
      <div class="pr-bar"><span data-count>Preview</span><span data-paper></span></div>
      <div class="pr-preview"><div class="pr-wait">Making the preview…</div></div>
    </div>`}
  </div>`);
  const field = (n) => body.querySelector(`[name="${n}"]`);
  const part = (n) => body.querySelector(`[${n}]`);
  const toPdf = () => field('printer').value === PDF;
  let layout = last.landscape ? 'landscape' : 'portrait';
  let printerOpts = null; // what the chosen printer offers (electron/printing.cjs printerOptions)
  let total = 0; // the whole page's page count, once the preview has it

  if (asIs) for (const x of body.querySelectorAll('[data-page-only]')) x.remove();
  if (settingsOnly) for (const x of body.querySelectorAll('[name="margins"], [data-custom-margins], [name="scale"], [name="headers"], [name="backgrounds"]')) x.closest('.field, .pr-margins').hidden = true;

  // Last time's choices.
  for (const n of ['pageSize', 'color', 'sides', 'margins', 'scale', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight']) if (last[n] != null && field(n)) field(n).value = last[n];
  for (const n of ['headers', 'backgrounds']) if (typeof last[n] === 'boolean' && field(n)) field(n).checked = last[n];
  if (mode === 'page' && (last.margins && last.margins !== 'default' || (last.scale && last.scale !== 100) || last.headers)) $('.pr-more', body).open = true;

  const options = () => ({
    printer: field('printer').value,
    pagesMode: field('pagesMode').value,
    pages: field('pages').value,
    copies: Number(field('copies').value) || 1,
    collate: field('collate').checked,
    landscape: layout === 'landscape',
    pageSize: field('pageSize').value,
    color: field('color').value === 'color',
    sides: field('sides').value,
    margins: field('margins')?.value,
    marginTop: field('marginTop')?.value,
    marginBottom: field('marginBottom')?.value,
    marginLeft: field('marginLeft')?.value,
    marginRight: field('marginRight')?.value,
    scale: Number(field('scale')?.value) || 100,
    perSheet: Number(field('perSheet').value) || 1,
    headers: !!field('headers')?.checked,
    backgrounds: !!field('backgrounds')?.checked,
    extras: Object.fromEntries([...body.querySelectorAll('[data-extras] select')].map((s) => [s.dataset.key, s.value])),
  });

  /** The paper sizes to offer: the printer's own, or the usual ones; keeps the chosen size when it's among them. */
  const fillPapers = (papers, preferred) => {
    const sel = field('pageSize');
    const current = sel.value || preferred || last.pageSize;
    const pick = papers.some((p) => p.name === current) ? current : papers.some((p) => p.name === preferred) ? preferred : papers[0]?.name;
    sel.innerHTML = papers.map((p) => option(p.name, p.label, p.name === pick)).join('');
  };
  const fillExtras = (extras) => {
    part('data-extras').innerHTML = extras
      .map((x) => `<label class="field"><span>${esc(x.label)}</span><select data-key="${esc(x.key)}">${x.choices.map((c) => option(c.value, c.label, c.value === x.value)).join('')}</select></label>`)
      .join('');
  };

  const preview = $('.pr-preview', body);
  const bar = { count: part('data-count'), paper: part('data-paper') };
  let shown = 0;
  let closed = false; // a printer's options can arrive after the sheet is gone
  const refresh = async () => {
    if (settingsOnly || closed) return;
    const n = ++shown;
    const o = options();
    if (o.pagesMode === 'custom' && !PAGES_RE.test(o.pages)) {
      field('pages').classList.toggle('invalid', !!o.pages.trim());
      bar.count.textContent = o.pages.trim() ? 'Pages like 1-5, 8' : 'Which pages?';
      return;
    }
    field('pages').classList.remove('invalid');
    try {
      const r = await shell.print.preview(id, o);
      if (n !== shown) return;
      total = r.total;
      preview.innerHTML = `<iframe src="${esc(r.url)}#toolbar=0&view=FitH" title="Preview"></iframe>`;
      bar.count.textContent = !r.total ? 'Preview' : r.pages === r.total ? plural(r.total, 'page') : `${r.pages} of ${plural(r.total, 'page')}`;
      field('pages').classList.remove('invalid');
    } catch (e) {
      if (n !== shown) return;
      preview.innerHTML = `<div class="pr-wait">${esc(reason(e) || 'No preview')}</div>`;
      bar.count.textContent = reason(e) || 'No preview';
      if (o.pagesMode === 'custom') field('pages').classList.add('invalid');
    }
  };
  const later = debounce(refresh, 350);
  const describePaper = () => {
    if (settingsOnly) return;
    const size = field('pageSize').selectedOptions[0]?.textContent.replace(/\s*\(.*\)$/, '') || '';
    bar.paper.textContent = asIs ? size : `${size} · ${layout === 'landscape' ? 'Landscape' : 'Portrait'}`;
  };

  /** The destination changed: what to show for it, and what this printer offers. */
  const applyPrinter = async () => {
    const pdf = toPdf();
    for (const x of body.querySelectorAll('[data-printer-only]')) x.hidden = pdf;
    const dest = part('data-dest');
    const p = printers.find((x) => x.name === field('printer').value);
    if (pdf) {
      dest.textContent = 'Saves the page as a PDF file you choose.';
      printerOpts = null;
      fillPapers(standard);
      fillExtras([]);
      describePaper();
      return;
    }
    dest.textContent = p ? [p.state, p.location || p.description].filter(Boolean).join(' · ') : 'No printers found.';
    dest.classList.toggle('bad', p?.state === 'Stopped');
    const name = p?.name;
    if (!name) return;
    const opts = await shell.print.options(name).catch(() => null);
    if (closed || field('printer').value !== name) return; // closed, or changed again meanwhile
    printerOpts = opts;
    fillPapers(opts?.papers?.length ? opts.papers : standard, opts?.paper);
    fillExtras(opts?.extras || []);
    part('data-duplex').hidden = opts?.duplex === false;
    part('data-color').hidden = opts?.color === false;
    describePaper();
    later();
  };

  const sync = () => {
    part('data-custom').hidden = field('pagesMode').value !== 'custom';
    part('data-collate').hidden = (Number(field('copies').value) || 1) < 2;
    if (field('margins') && !settingsOnly) part('data-custom-margins').hidden = field('margins').value !== 'custom';
    for (const b of body.querySelectorAll('[data-layout] button')) b.classList.toggle('on', b.dataset.v === layout);
  };
  body.addEventListener('change', (e) => {
    sync();
    if (e.target.name === 'printer') applyPrinter();
    if (e.target.name === 'pagesMode' && e.target.value === 'custom') field('pages').focus();
    if (e.target.name === 'pageSize') describePaper();
    if (PREVIEWED.includes(e.target.name)) later();
  });
  body.addEventListener('input', (e) => {
    if (['pages', 'scale', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight'].includes(e.target.name)) later();
    if (e.target.name === 'copies') sync();
  });
  part('data-layout')?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === layout) return;
    layout = b.dataset.v;
    sync();
    describePaper();
    later();
  });
  sync();
  fillPapers(standard);
  describePaper();
  refresh();
  applyPrinter();

  let chosen = null;
  await ask({
    win,
    title: title && title !== 'Print' ? `Print “${title}”` : 'Print', // GTK programs ask with the title "Print"
    wide: !settingsOnly,
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Print', value: 'go', primary: true }],
    onMount: (api) => {
      api.el.classList.add('pr-dialog');
      const primary = $('.btn.primary', api.el);
      const label = () => (primary.textContent = toPdf() ? 'Save…' : 'Print');
      body.addEventListener('change', label);
      label();
      if (settingsOnly && !printers.length) primary.disabled = true;
    },
    check: async (_r, api) => {
      const o = options();
      if (o.pagesMode === 'custom' && !PAGES_RE.test(o.pages)) {
        api.setError('Say which pages to print, like 1-5, 8.');
        field('pages').focus();
        return false;
      }
      api.setError('');
      const keep = () => remember({
        printer: toPdf() ? last.printer : o.printer,
        landscape: o.landscape, pageSize: o.pageSize, color: o.color ? 'color' : 'bw', sides: o.sides,
        ...(mode === 'page' ? { margins: o.margins, marginTop: o.marginTop, marginBottom: o.marginBottom, marginLeft: o.marginLeft, marginRight: o.marginRight, scale: o.scale, headers: o.headers, backgrounds: o.backgrounds } : pageChoices(last)),
      });
      if (settingsOnly) {
        chosen = o;
        keep();
        return true;
      }
      try {
        if (toPdf()) {
          const r = await shell.print.savePdf(id, o);
          if (r?.canceled) return false;
          notify(`Saved ${r.file.split('/').pop()}`);
        } else {
          const r = await shell.print.run(id, o);
          const p = printers.find((x) => x.name === o.printer);
          notify(`Sent to ${p?.displayName || 'the printer'}${r?.pages ? ` (${plural(r.pages, 'page')}${o.copies > 1 ? `, ${o.copies} copies` : ''})` : ''}`);
        }
        keep();
        return true;
      } catch (e) {
        api.setError(reason(e));
        return false;
      }
    },
  });
  closed = true;
  return chosen;
}
