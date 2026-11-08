// Leafdeck's own dialogs: questions, sign-ins and choices that would otherwise be system (GTK) message boxes, which in
// Leafdeck OS cover the whole screen. A dialog for a window (`win`) is a sheet over that window; one for the computer
// (a program asking for your password, a file to choose) sits over the whole screen. Each place shows one at a time;
// more wait their turn.
//
// On Windows, confirmDialog keeps the system's own box: there it looks right and Leafdeck behaves as it always has.
import { $, el, esc } from './util.js';
import { icon } from './icons.js';
import { shell } from './shell.js';

export const ownDialogs = shell?.platform === 'linux';

const queues = new WeakMap(); // container -> promise of the dialog showing there
let screenQueue = Promise.resolve();

/**
 * Ask something. Resolves to { button, values, choice } (button is the clicked button's value), or null when it's
 * dismissed (Esc, Cancel, or `api.close()`).
 *   title, message, detail: text (plain); icon: an icon name; code: { label, text } (a command, shown whole)
 *   fields: [{ name, label, type: 'text'|'password'|'number', value, placeholder, autocomplete }]
 *   choices: [{ value, label, sub, icon, thumb }] (a list to pick one from; thumb: a picture's address),
 *   choice: the one picked at first
 *   buttons: [{ label, value, primary, danger }] (default Cancel / OK); the primary one is also Enter
 *   win: a Leafdeck window to show it over (else the screen); wide: room for more content
 *   body: an element to show under the message (a file list, a preview); onMount(api) gets
 *   { el, setChoices(list), setError(text), close(result) } once it's on screen
 *   check(result, api): runs before it closes (a password to try); resolve false to keep it open
 *   now: show it at once, over whatever dialog is up (for a question that dialog asks)
 */
export function ask(opts) {
  const container = opts.win?.el && !$(':scope > .sheet-wrap', opts.win.el) ? opts.win.el : null;
  const run = () => show(container, opts);
  if (opts.now) return run(); // on top of the dialog asking it (a "Replace it?" inside the file picker)
  if (!container) return (screenQueue = screenQueue.then(run, run));
  const next = (queues.get(container) || Promise.resolve()).then(run, run);
  queues.set(container, next);
  return next;
}

/** Yes or no. On Windows the system's own box, as before. */
export function confirmDialog(message, { title = '', ok = 'OK', danger = false, win = null, detail = '', now = false } = {}) {
  if (!ownDialogs) return Promise.resolve(window.confirm(message));
  return ask({ title, message, detail, win, now, buttons: [{ label: 'Cancel', value: null }, { label: ok, value: 'ok', primary: true, danger }] }).then(
    (r) => r?.button === 'ok',
  );
}

function show(container, opts) {
  const { title = '', message = '', detail = '', fields = [], buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }] } = opts;
  return new Promise((resolve) => {
    const wrap = el(`<div class="sheet-wrap${container ? '' : ' screen'}"><form class="sheet ld-dialog${opts.wide ? ' wide' : ''}" role="alertdialog" aria-modal="true">
      <div class="dlg-main">
        ${opts.icon ? `<div class="dlg-icon">${icon(opts.icon, 22)}</div>` : ''}
        <div class="dlg-text">
          ${title ? `<h2>${esc(title)}</h2>` : ''}
          ${message ? `<p class="dlg-msg">${esc(message)}</p>` : ''}
          ${detail ? `<p class="dlg-detail">${esc(detail)}</p>` : ''}
          ${opts.code ? `<div class="dlg-code"><span>${esc(opts.code.label)}</span><pre>${esc(opts.code.text)}</pre></div>` : ''}
          <div class="dlg-fields">${fields
            .map(
              (f) => `<label class="field"><span>${esc(f.label || '')}</span><input name="${esc(f.name)}" type="${esc(f.type || 'text')}"
                value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="${esc(f.autocomplete || 'off')}" spellcheck="false"></label>`,
            )
            .join('')}</div>
          <div class="dlg-choices" role="listbox" hidden></div>
          <div class="dlg-extra"></div>
          <p class="dlg-error" hidden></p>
        </div>
      </div>
      <div class="sheet-foot"><span class="grow"></span>${buttons
        .map((b, i) => `<button type="${b.primary ? 'submit' : 'button'}" class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger-solid' : ''}" data-i="${i}">${esc(b.label)}</button>`)
        .join('')}</div></form></div>`);
    const form = wrap.firstElementChild;
    const list = $('.dlg-choices', form);
    const error = $('.dlg-error', form);
    let choice = opts.choice ?? null;
    let done = false;

    const values = () => Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name]?.value ?? '']));
    const finish = (result) => {
      if (done) return;
      done = true;
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 180);
      resolve(result);
    };
    const primary = buttons.find((b) => b.primary);
    let checking = false;
    const submit = async (b) => {
      if (b.value == null) return finish(null);
      if ((opts.choices && b.primary && choice == null) || checking) return;
      const result = { button: b.value, values: values(), choice };
      if (opts.check) {
        // Stays open while it's checked (a password); the check shows its own error and says whether to close.
        checking = true;
        form.classList.add('busy');
        const ok = await Promise.resolve(opts.check(result, api)).catch(() => false);
        checking = false;
        form.classList.remove('busy');
        if (!ok || done) return;
      }
      finish(result);
    };

    const setChoices = (items) => {
      list.hidden = !items;
      if (!items) return;
      if (choice != null && !items.some((c) => c.value === choice)) choice = null;
      list.innerHTML = items.length
        ? items
            .map(
              (c) => `<button type="button" class="dlg-choice${c.value === choice ? ' on' : ''}" role="option" data-value="${esc(c.value)}">
                ${c.thumb ? `<img class="dlg-thumb" src="${esc(c.thumb)}" alt="">` : c.icon ? icon(c.icon, 16) : ''}<span><b>${esc(c.label)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</span></button>`,
            )
            .join('')
        : `<div class="dlg-empty">${esc(opts.emptyText || 'Nothing to choose yet.')}</div>`;
      if (primary) $(`[data-i="${buttons.indexOf(primary)}"]`, form).disabled = choice == null;
    };
    const api = {
      el: form,
      setChoices,
      setError: (text) => {
        error.hidden = !text;
        error.textContent = text || '';
      },
      close: finish,
    };
    if (opts.choices) setChoices(opts.choices);
    if (opts.body) $('.dlg-extra', form).append(opts.body);

    list.addEventListener('click', (e) => {
      const b = e.target.closest('.dlg-choice');
      if (!b) return;
      choice = b.dataset.value;
      for (const x of list.children) x.classList.toggle('on', x === b);
      if (primary) $(`[data-i="${buttons.indexOf(primary)}"]`, form).disabled = false;
    });
    list.addEventListener('dblclick', (e) => e.target.closest('.dlg-choice') && primary && submit(primary));
    form.addEventListener('click', (e) => {
      const b = e.target.closest('.sheet-foot [data-i]');
      if (b && b.type !== 'submit') submit(buttons[b.dataset.i]);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (primary) submit(primary);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      finish(null);
    });

    (container || document.body).append(wrap);
    container?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // raise the window asking
    requestAnimationFrame(() => wrap.classList.add('open'));
    (form.querySelector('input') || form.querySelector('.btn.primary') || form.querySelector('.btn'))?.focus();
    opts.onMount?.(api);
  });
}
