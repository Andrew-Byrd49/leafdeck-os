// What pages and the main process ask the person, drawn by Leafdeck rather than the system (GTK) on Linux: context
// menus, a site's alert / confirm / prompt, "Leave site?", sign-in for sites that ask for a username and password,
// choosing a device, a certificate or a screen to share, and colors for a site's color fields. The main process
// (electron/main.cjs) sends each request; the answer goes back with its id.
import { showMenu, closeMenu, menuOwner } from './wm.js';
import { shell } from './shell.js';
import { ask } from './dialogs.js';
import { pickColor } from './colorpicker.js';
import { el } from './util.js';
import { icon } from './icons.js';
import { webviewFor, windowForWebContents } from './apps/browser.js';

const hostOf = (origin) => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin || 'This page';
  }
};

/** Where a context menu's point is on screen: Electron gives it in the Leafdeck window's pixels, even for a page. */
function pagePoint(webContentsId, x, y, zoom = 1) {
  return { x: x / zoom, y: y / zoom, wv: webContentsId ? webviewFor(webContentsId) : null };
}

if (shell?.platform === 'linux') {
  shell.on('shell:context-menu', ({ id, webContentsId, x, y, zoom, items }) => {
    const at = pagePoint(webContentsId, x, y, zoom);
    if (webContentsId && !at.wv) return;
    showMenu(
      at.x,
      at.y,
      // The page gets its focus back first: clicking the menu gave it to Leafdeck, and Chromium sends edit commands (cut,
      // copy, paste, a spelling suggestion) to whichever page has it.
      items.map((it) => (it === '-' ? '-' : { label: it.label, key: it.key, disabled: it.disabled, act: () => (at.wv?.focus(), shell.menuChoose(id, it.act)) })),
      { keepFocus: true },
    );
  });

  // A click in a page while Leafdeck's menu for it is open (electron/webview-preload.cjs): this page never sees it.
  shell.on('shell:menu-dismiss', () => closeMenu());

  /* Dropdowns (a <select>'s list): Leafdeck's menu, kept on the field's screen and scrolling when it's long. Chromium's
     own list fits whichever screen Leafdeck's window mostly covers, and the window spans them all. Leafdeck's own here;
     a site's through its webview preload, which sends the list with the field's position in the page. */
  const dropdown = (el) => el instanceof HTMLSelectElement && !el.disabled && !el.multiple && el.size <= 1;
  const optionItems = (select) => {
    const item = (o) => ({ label: o.label || o.textContent.trim(), checked: o.selected, disabled: o.disabled, index: o.index });
    return [...select.children].flatMap((c) =>
      c instanceof HTMLOptGroupElement ? [{ header: c.label }, ...[...c.children].filter((o) => o instanceof HTMLOptionElement).map(item)] : c instanceof HTMLOptionElement ? [item(c)] : [],
    );
  };
  const openDropdown = (select) => {
    if (menuOwner() === select) return closeMenu();
    select.focus();
    const r = select.getBoundingClientRect();
    const choose = (i) => {
      const o = select.options[i];
      if (!o || o.selected) return;
      o.selected = true;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const items = optionItems(select).map((it) => (it.header != null ? it : { ...it, act: () => choose(it.index) }));
    showMenu(r.left, r.bottom + 2, items, { owner: select, minWidth: r.width, flipTo: r.top - 2, near: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
  };
  document.addEventListener(
    'mousedown',
    (e) => {
      const select = e.target.closest?.('select');
      if (e.button !== 0 || !dropdown(select)) return;
      e.preventDefault();
      openDropdown(select);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!dropdown(e.target) || !(e.key === ' ' || e.key === 'F4' || (e.altKey && /^Arrow(Down|Up)$/.test(e.key)))) return;
      e.preventDefault();
      openDropdown(e.target);
    },
    true,
  );
  shell.on('shell:pick-option', ({ id, webContentsId, x, y, top, width, zoom, items }) => {
    const wv = webviewFor(webContentsId);
    if (!wv) return shell.pickOptionAnswer(id, null);
    const r = wv.getBoundingClientRect();
    let answered = false;
    const answer = (index) => answered || ((answered = true), shell.pickOptionAnswer(id, index));
    showMenu(
      r.left + x * zoom,
      r.top + y * zoom,
      items.map((it) => (it.header != null ? it : { ...it, act: () => answer(it.index) })),
      // Closed without a choice (Escape, a click elsewhere): after the act, which runs right after onClose.
      { minWidth: width * zoom, flipTo: r.top + top * zoom, near: { x: r.left + (x + width / 2) * zoom, y: r.top + (top + 2) * zoom }, onClose: () => setTimeout(() => answer(null)) },
    );
  });

  // Color fields: Leafdeck's color picker instead of GTK's chooser. Leafdeck's own (Calendar's) here; a site's
  // through its webview preload, which asks with the field's position in the page (or none, inside a frame).
  const setColor = (input, v) => {
    if (!v || v === input.value) return;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  document.addEventListener(
    'click',
    (e) => {
      const input = e.target.closest?.('input[type="color"]');
      if (!input || input.disabled) return;
      e.preventDefault();
      const r = input.getBoundingClientRect();
      pickColor(r.left, r.bottom + 6, { value: input.value, onDone: (v) => setColor(input, v) });
    },
    true,
  );
  shell.on('shell:pick-color', ({ id, webContentsId, x, y, zoom, value }) => {
    const wv = webviewFor(webContentsId);
    if (!wv) return shell.pickColorAnswer(id, null);
    const r = wv.getBoundingClientRect();
    const at = x == null ? { x: r.left + r.width / 2 - 120, y: r.top + r.height / 3 } : { x: r.left + x * zoom, y: r.top + y * zoom };
    pickColor(at.x, at.y, { value, onDone: (v) => shell.pickColorAnswer(id, v || null) });
  });

  // A site's sign-in, certificate, device, Bluetooth pairing or screen-sharing question (electron/siteprompts.cjs).
  const prompts = new Map(); // id -> dialog api
  shell.on('shell:site-prompt-update', ({ id, choices }) => prompts.get(id)?.setChoices(choices));
  shell.on('shell:site-prompt-cancel', ({ id }) => prompts.get(id)?.close(null));
  shell.on('shell:site-prompt', async (req) => {
    const win = windowForWebContents(req.webContentsId);
    const site = hostOf(req.origin);
    const onMount = (api) => prompts.set(req.id, api);
    let value = null;
    if (req.kind === 'login') {
      const r = await ask({
        win,
        onMount,
        icon: 'key',
        title: req.proxy ? 'Sign in to the proxy' : `Sign in to ${req.host}`,
        message: req.realm ? `The site says: “${req.realm}”` : '',
        detail: req.secure ? '' : 'Your username and password will be sent without encryption (this connection isn’t secure).',
        fields: [
          { name: 'username', label: 'Username', autocomplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
        ],
        buttons: [{ label: 'Cancel', value: null }, { label: 'Sign in', value: 'ok', primary: true }],
      });
      value = r ? r.values : null;
    } else if (req.kind === 'certificate') {
      const r = await ask({
        win,
        onMount,
        icon: 'shield',
        title: 'Choose a certificate',
        message: `${req.host} wants to know who you are. Choose the certificate to identify yourself with.`,
        choices: req.choices,
        choice: req.choices[0]?.value,
        buttons: [{ label: 'Don’t send one', value: null }, { label: 'Send', value: 'ok', primary: true }],
      });
      value = r?.choice ?? null;
    } else if (req.kind === 'device') {
      const what = { hid: 'device', usb: 'USB device', serial: 'serial port', bluetooth: 'Bluetooth device' }[req.device] || 'device';
      const r = await ask({
        win,
        onMount,
        icon: req.device === 'bluetooth' ? 'bluetooth' : 'link',
        title: `${site} wants to connect to a ${what}`,
        message: req.device === 'bluetooth' ? 'Looking for devices nearby…' : '',
        choices: req.choices,
        emptyText: req.device === 'bluetooth' ? 'No devices found yet. Make sure yours is on and ready to pair.' : `No compatible ${what}s are connected.`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Connect', value: 'ok', primary: true }],
      });
      value = r?.choice ?? null;
    } else if (req.kind === 'bt-pair') {
      const provide = req.pairing === 'providePin';
      const r = await ask({
        win,
        onMount,
        icon: 'bluetooth',
        title: 'Pair with this device?',
        message: provide ? 'Enter the PIN shown on the device.' : req.pin ? `Check that the device shows ${req.pin}.` : `${site} wants to pair with a Bluetooth device.`,
        fields: provide ? [{ name: 'pin', label: 'PIN' }] : [],
        buttons: [{ label: 'Cancel', value: null }, { label: 'Pair', value: 'ok', primary: true }],
      });
      value = r ? (provide ? { pin: r.values.pin } : { ok: true }) : null;
    } else if (req.kind === 'share-screen') {
      const r = await ask({
        win,
        onMount,
        icon: 'display',
        title: `Share your screen with ${site}?`,
        message: req.audio ? 'Choose what to share. A page’s sound is shared with it.' : 'Choose what to share.',
        choices: req.choices,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Share', value: 'ok', primary: true }],
      });
      value = r?.choice ?? null;
    }
    prompts.delete(req.id);
    shell.siteAnswer(req.id, value);
  });

  // A page's alert / confirm / prompt, and "Leave site?": a sheet over that page's window.
  shell.on('shell:page-dialog', async (req) => {
    const win = windowForWebContents(req.webContentsId);
    const title = `${hostOf(req.origin)} says`;
    let value = null;
    if (req.kind === 'alert') {
      await ask({ win, title, message: req.message, buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    } else if (req.kind === 'confirm') {
      value = (await ask({ win, title, message: req.message }))?.button === 'ok';
    } else if (req.kind === 'prompt') {
      const r = await ask({ win, title, message: req.message, fields: [{ name: 'text', value: req.value }] });
      value = r ? r.values.text : null;
    } else if (req.kind === 'leave') {
      const r = await ask({
        win,
        title: 'Leave site?',
        message: 'Changes you made may not be saved.',
        buttons: [{ label: 'Stay', value: null }, { label: 'Leave', value: 'leave', primary: true }],
      });
      value = r?.button === 'leave';
    }
    shell.pageDialogAnswer(req.id, value);
  });

  /* A site's popup (a "Sign in with…" or consent screen) in Leafdeck OS: the page is a view the main process lays over
     Leafdeck's window (popupInLeafdeck in main.cjs); this is the sheet around it, over every screen like the computer's
     dialogs. Leafdeck's UI can't draw over the page, so the sheet only frames it: its title, its address, and Close. */
  const popups = new Map(); // id -> { wrap, update(info), ro }
  shell.on('shell:popup', ({ id, width, height, url }) => {
    const w = Math.min(Math.max(width, 380), 720);
    const h = Math.min(Math.max(height, 420), 860);
    const wrap = el(`<div class="sheet-wrap screen popup-wrap"><div class="sheet popup-sheet" role="dialog" aria-modal="true" style="--pw:${w}px; --ph:${h}px">
      <div class="popup-head"><span class="popup-icon">${icon('lock', 13)}</span><div class="popup-title"><b></b><small></small></div>
        <button type="button" class="icon-btn" title="Close">${icon('x', 15)}</button></div>
      <div class="popup-page"></div></div></div>`);
    const page = wrap.querySelector('.popup-page');
    const update = ({ url: u, title } = {}) => {
      let host = u || '';
      try {
        host = new URL(u).host || u;
      } catch {}
      wrap.querySelector('.popup-title b').textContent = title || host || 'Loading…';
      wrap.querySelector('.popup-title small').textContent = title ? host : '';
      wrap.querySelector('.popup-icon').hidden = !/^https:/i.test(u || '');
    };
    update({ url });
    // Where the page goes: the sheet's page area, in the window's pixels (the UI isn't zoomed).
    const place = () => {
      const r = page.getBoundingClientRect();
      shell.popup.bounds(id, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(place);
    ro.observe(page);
    ro.observe(document.documentElement);
    wrap.addEventListener('transitionend', place);
    wrap.querySelector('.popup-head .icon-btn').onclick = () => shell.popup.close(id);
    popups.set(id, { wrap, update, ro });
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
  });
  shell.on('shell:popup-update', ({ id, ...info }) => popups.get(id)?.update(info));
  shell.on('shell:popup-closed', ({ id }) => {
    const p = popups.get(id);
    if (!p) return;
    popups.delete(id);
    p.ro.disconnect();
    p.wrap.remove();
  });
}
