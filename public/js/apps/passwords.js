// Passwords, addresses and payment methods — views onto the encrypted stores kept by the Electron main process.
// The UI receives usernames, sites, addresses and the last 4 digits of cards; a password only crosses over
// when you click Reveal, and a full card number never does.

import { $, esc, el, debounce } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast } from '../wm.js';
import { shell } from '../shell.js';
import { favicon, openImportSheet } from './bookmarks.js';

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const TABS = [
  ['passwords', 'Passwords', 'key'],
  ['addresses', 'Addresses', 'place'],
  ['cards', 'Payment methods', 'card'],
];
// Which autofill setting each tab's switch controls.
const SETTING = { passwords: 'passwords', addresses: 'addresses', cards: 'cards' };
const TAB_FOR_KIND = { login: 'passwords', address: 'addresses', card: 'cards' };

function editLogin(win, entry, onSaved) {
  const isNew = !entry;
  const e = entry || {};
  const form = el(`<form class="rec-form" novalidate>
    <div class="sheet-head"><div><h2>${isNew ? 'New password' : esc(e.host)}</h2>
      <small>Stored encrypted on this computer only</small></div></div>
    <div class="sheet-scroll"><div class="form-grid">
      <label class="field span2"><span>Website <i>*</i></span><input name="url" type="url" value="${esc(e.url || '')}" placeholder="https://example.com/login" required></label>
      <label class="field"><span>Username or email</span><input name="username" value="${esc(e.username || '')}" autocomplete="off"></label>
      <label class="field"><span>Password${isNew ? ' <i>*</i>' : ''}</span>
        <div class="pw-input"><input name="password" type="password" autocomplete="new-password" placeholder="${isNew ? '' : 'Leave blank to keep the current password'}">
        <button type="button" class="icon-btn" data-show title="Show">${icon('eye', 13)}</button></div></label>
      <label class="field"><span>Name</span><input name="name" value="${esc(e.name || '')}"></label>
      <label class="field span2"><span>Note</span><textarea name="note" rows="2">${esc(e.note || '')}</textarea></label>
    </div></div>
    <div class="sheet-foot"><span class="grow"></span>
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">${isNew ? 'Save' : 'Save changes'}</button></div>
  </form>`);
  const sh = win.sheet(form);
  form.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-cancel]')) sh.close();
    if (ev.target.closest('[data-show]')) {
      const p = form.elements.password;
      p.type = p.type === 'password' ? 'text' : 'password';
    }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    try {
      await shell.vault.save({
        id: e.id,
        url: f.url.value,
        username: f.username.value.trim(),
        password: f.password.value,
        name: f.name.value.trim(),
        note: f.note.value.trim(),
      });
      sh.close();
      onSaved?.();
    } catch (err) {
      toast(cleanError(err), 'error');
    }
  });
  setTimeout(() => form.elements.url.focus(), 60);
}

/** A simple form sheet for an address or a card. `fields`: [name, label, attrs, span2]. */
function editSheet(win, { title, sub, fields, values, onSave }) {
  const form = el(`<form class="rec-form" novalidate>
    <div class="sheet-head"><div><h2>${esc(title)}</h2><small>${esc(sub)}</small></div></div>
    <div class="sheet-scroll"><div class="form-grid">${fields
      .map(
        ([name, label, attrs = '', wide]) => `<label class="field ${wide ? 'span2' : ''}"><span>${esc(label)}</span>${
          name === 'street'
            ? `<textarea name="street" rows="2" autocomplete="off">${esc(values[name] || '')}</textarea>`
            : `<input name="${name}" value="${esc(values[name] || '')}" autocomplete="off" ${attrs}>`
        }</label>`,
      )
      .join('')}</div></div>
    <div class="sheet-foot"><span class="grow"></span>
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">Save</button></div>
  </form>`);
  const sh = win.sheet(form);
  form.addEventListener('click', (ev) => ev.target.closest('[data-cancel]') && sh.close());
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(fields.map(([name]) => [name, form.elements[name].value.trim()]));
    try {
      await onSave(data);
      sh.close();
    } catch (err) {
      toast(cleanError(err), 'error');
    }
  });
  setTimeout(() => form.querySelector('input, textarea')?.focus(), 60);
}

function editAddress(win, a) {
  editSheet(win, {
    title: a ? 'Edit address' : 'New address',
    sub: 'Stored encrypted on this computer only — filled into forms when you pick it',
    fields: [
      ['name', 'Full name', '', true],
      ['organization', 'Organization', '', true],
      ['street', 'Street address', '', true],
      ['city', 'City'],
      ['state', 'State / province'],
      ['postal', 'ZIP / postal code'],
      ['country', 'Country', 'placeholder="United States"'],
      ['phone', 'Phone', 'type="tel"'],
      ['email', 'Email', 'type="email"'],
    ],
    values: a || {},
    onSave: (data) => shell.autofill.save('address', { ...data, id: a?.id }),
  });
}

function editCard(win, c) {
  editSheet(win, {
    title: c ? `Edit ${c.brand} •••• ${c.last4}` : 'New card',
    sub: 'Encrypted on this computer only. Leafdeck never stores the security code (CVC).',
    fields: [
      ['number', 'Card number', `inputmode="numeric" placeholder="${c ? `•••• ${esc(c.last4)} — leave blank to keep` : ''}"`, true],
      ['name', 'Name on card', '', true],
      ['expMonth', 'Expiry month', 'inputmode="numeric" placeholder="MM" maxlength="2"'],
      ['expYear', 'Expiry year', 'inputmode="numeric" placeholder="YYYY" maxlength="4"'],
      ['nickname', 'Nickname', 'placeholder="e.g. Business Visa"', true],
    ],
    values: c ? { name: c.name, expMonth: c.expMonth, expYear: c.expYear, nickname: c.nickname } : {},
    onSave: (data) => shell.autofill.save('card', { ...data, id: c?.id }),
  });
}

registerApp({
  id: 'passwords',
  name: 'Passwords',
  icon: 'key',
  size: [920, 620],
  min: [560, 380],
  openTab: (win, tab) => win.setTab?.(TAB_FOR_KIND[tab] || tab),
  mount(win) {
    if (!shell) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Passwords live in the Leafdeck app</div>
        <p>For security, saved passwords, addresses and cards are kept only in the Leafdeck desktop app, encrypted on your computer. They never sync to the web.</p></div>`;
      return;
    }
    let tab = 'passwords';
    let q = '';
    let entries = [];
    let af = { addresses: [], cards: [] };
    let settings = { passwords: true, addresses: true, cards: true };
    const revealed = new Map(); // id -> timeout

    win.tools.innerHTML = `<div class="seg" data-tabs>${TABS.map(([id, label, ic]) => `<button data-tab="${id}" title="${label}">${icon(ic, 13)}<span class="seg-label">${label}</span></button>`).join('')}</div>
      <label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Search"></label>
      <button class="tb-btn" data-import title="Import passwords from another browser">${icon('download', 15)}</button>
      <button class="tb-btn" data-new title="Add">${icon('plus', 16)}</button>`;

    const toggle = () => {
      const key = SETTING[tab];
      const label = { passwords: 'Offer to save and fill passwords', addresses: 'Save and fill addresses', cards: 'Save and fill payment methods' }[tab];
      const main = `<label class="af-toggle"><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}><span>${label}</span></label>`;
      if (tab !== 'addresses') return main;
      // Remembered form entries (what you typed into ordinary fields) live with addresses.
      const n = af.entryCount || 0;
      return `${main}<div class="af-toggle"><label class="af-inline"><input type="checkbox" data-setting="entries" ${settings.entries ? 'checked' : ''}><span>Suggest what I’ve typed in other form fields before</span></label>
        <span class="af-count">${n} remembered</span>${n ? '<button class="btn small" data-clear-entries>Clear</button>' : ''}</div>`;
    };

    const drawPasswords = () => {
      const ql = q.toLowerCase();
      const rows = entries.filter((e) => !ql || [e.host, e.username, e.name, e.note].join(' ').toLowerCase().includes(ql));
      return `<div class="summary">
          <div class="stat"><span>Saved logins</span><b>${entries.length}</b></div>
          <div class="stat good"><span>Protection</span><b>${icon('shield', 16)} Encrypted</b><small>Windows-protected, this computer only — never synced</small></div>
        </div>${toggle()}
        ${
          rows.length
            ? `<div class="pw-list">${rows
                .map(
                  (e) => `<div class="pw-row" data-id="${e.id}">
                <img class="fav" src="${esc(favicon(e.url))}" alt="" loading="lazy" referrerpolicy="no-referrer">
                <span class="pw-site"><b>${esc(e.name || e.host)}</b><small>${esc(e.host)}</small></span>
                <span class="pw-user">${esc(e.username || '—')}</span>
                <span class="pw-secret" data-secret>••••••••••</span>
                <span class="pw-actions">
                  <button class="icon-btn" data-copy="username" title="Copy username">${icon('user', 13)}</button>
                  <button class="icon-btn" data-copy="password" title="Copy password (clears in 30s)">${icon('copy', 13)}</button>
                  <button class="icon-btn" data-reveal title="Reveal for 15 seconds">${icon('eye', 13)}</button>
                  <button class="icon-btn" data-edit title="Edit">${icon('note', 13)}</button>
                  <button class="icon-btn" data-delete title="Delete">${icon('trash', 13)}</button>
                </span></div>`,
                )
                .join('')}</div>`
            : entries.length
              ? '<div class="empty small"><p>No passwords match.</p></div>'
              : `<div class="empty"><div class="empty-title">No saved passwords</div>
                <p>Import them from Chrome, Edge, Firefox or your password manager. Click a login field on a site and Leafdeck offers your saved accounts.</p>
                <button class="btn primary" data-import>${icon('download', 13)} Import passwords</button></div>`
        }`;
    };

    const drawAddresses = () => {
      const ql = q.toLowerCase();
      const rows = af.addresses.filter((a) => !ql || Object.values(a).join(' ').toLowerCase().includes(ql));
      return `${toggle()}${
        rows.length
          ? `<div class="pw-list">${rows
              .map(
                (a) => `<div class="pw-row" data-aid="${a.id}">
              <span class="af-ic">${icon('place', 15)}</span>
              <span class="pw-site"><b>${esc(a.name || a.organization || a.email || 'Address')}</b><small>${esc([a.street.split('\n')[0], a.city, a.state, a.postal].filter(Boolean).join(', '))}</small></span>
              <span class="pw-user">${esc(a.email || a.phone || '')}</span>
              <span class="pw-actions">
                <button class="icon-btn" data-edit title="Edit">${icon('note', 13)}</button>
                <button class="icon-btn" data-delete title="Delete">${icon('trash', 13)}</button>
              </span></div>`,
              )
              .join('')}</div>`
          : af.addresses.length
            ? '<div class="empty small"><p>No addresses match.</p></div>'
            : `<div class="empty"><div class="empty-title">No saved addresses</div>
              <p>Add one here, or fill in an address on a site and Leafdeck offers to save it. Then click a name or address field and pick it to fill the whole form.</p>
              <button class="btn primary" data-new>${icon('plus', 13)} Add address</button></div>`
      }`;
    };

    const drawCards = () => {
      const ql = q.toLowerCase();
      const rows = af.cards.filter((c) => !ql || [c.brand, c.last4, c.name, c.nickname].join(' ').toLowerCase().includes(ql));
      return `${toggle()}${
        rows.length
          ? `<div class="pw-list">${rows
              .map(
                (c) => `<div class="pw-row" data-cid="${c.id}">
              <span class="af-ic">${icon('card', 15)}</span>
              <span class="pw-site"><b>${esc(c.nickname || c.brand)} •••• ${esc(c.last4)}</b><small>${esc(c.name || '')}</small></span>
              <span class="pw-user">${c.expMonth && c.expYear ? `Expires ${esc(c.expMonth)}/${esc(String(c.expYear).slice(-2))}` : ''}</span>
              <span class="pw-actions">
                <button class="icon-btn" data-edit title="Edit">${icon('note', 13)}</button>
                <button class="icon-btn" data-delete title="Delete">${icon('trash', 13)}</button>
              </span></div>`,
              )
              .join('')}</div>`
          : af.cards.length
            ? '<div class="empty small"><p>No cards match.</p></div>'
            : `<div class="empty"><div class="empty-title">No saved payment methods</div>
              <p>Cards are encrypted on this computer and only filled into secure (https) checkout pages. The security code is never stored.</p>
              <button class="btn primary" data-new>${icon('plus', 13)} Add card</button></div>`
      }`;
    };

    const draw = () => {
      win.tools.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      $('[data-import]', win.tools).hidden = tab !== 'passwords';
      $('.tb-search input', win.tools).placeholder = `Search ${TABS.find((t) => t[0] === tab)[1].toLowerCase()}`;
      win.body.innerHTML = tab === 'addresses' ? drawAddresses() : tab === 'cards' ? drawCards() : drawPasswords();
    };

    const load = async () => {
      try {
        const st = await shell.vault.status();
        if (st.error) throw new Error(st.error);
        [entries, af, settings] = await Promise.all([shell.vault.list(), shell.autofill.list(), shell.autofill.settings()]);
      } catch (err) {
        win.body.innerHTML = `<div class="empty"><div class="empty-title">Couldn’t open saved passwords</div><p>${esc(cleanError(err))}</p></div>`;
        return;
      }
      draw();
    };

    win.setTab = (t) => {
      if (!TABS.some(([id]) => id === t)) return;
      tab = t;
      draw();
    };

    win.tools.addEventListener('input', debounce((e) => {
      if (!e.target.matches('.tb-search input')) return;
      q = e.target.value;
      draw();
    }, 100));

    win.el.addEventListener('change', async (e) => {
      const s = e.target.closest('[data-setting]');
      if (!s) return;
      settings = await shell.autofill.setSettings({ [s.dataset.setting]: s.checked });
    });

    // Two clicks to delete: the first arms the button.
    const armed = (btn) => {
      if (btn.classList.contains('confirm')) return true;
      btn.classList.add('confirm');
      btn.title = 'Click again to delete';
      setTimeout(() => btn.classList.remove('confirm'), 3000);
      return false;
    };

    win.el.addEventListener('click', async (e) => {
      if (e.target.closest('.sheet-wrap')) return;
      const t = e.target.closest('[data-tab]');
      if (t) return win.setTab(t.dataset.tab);
      if (e.target.closest('[data-import]')) return openImportSheet(win);
      const clear = e.target.closest('[data-clear-entries]');
      if (clear) {
        if (!clear.classList.contains('confirm')) {
          clear.classList.add('confirm');
          clear.textContent = 'Click again to clear';
          return setTimeout(() => clear.isConnected && ((clear.textContent = 'Clear'), clear.classList.remove('confirm')), 3000);
        }
        await shell.autofill.clearEntries();
        return toast('Form entries cleared');
      }
      if (e.target.closest('[data-new]')) {
        if (tab === 'addresses') return editAddress(win, null);
        if (tab === 'cards') return editCard(win, null);
        return editLogin(win, null, load);
      }
      try {
        const arow = e.target.closest('[data-aid]');
        if (arow) {
          const a = af.addresses.find((x) => x.id === arow.dataset.aid);
          if (e.target.closest('[data-edit]')) editAddress(win, a);
          const del = e.target.closest('[data-delete]');
          if (del && armed(del)) await shell.autofill.remove('address', a.id);
          return;
        }
        const crow = e.target.closest('[data-cid]');
        if (crow) {
          const c = af.cards.find((x) => x.id === crow.dataset.cid);
          if (e.target.closest('[data-edit]')) editCard(win, c);
          const del = e.target.closest('[data-delete]');
          if (del && armed(del)) await shell.autofill.remove('card', c.id);
          return;
        }
        const row = e.target.closest('[data-id]');
        if (!row) return;
        const id = row.dataset.id;
        const entry = entries.find((x) => x.id === id);
        const copy = e.target.closest('[data-copy]');
        if (copy) {
          await shell.vault.copy(id, copy.dataset.copy);
          toast(copy.dataset.copy === 'password' ? 'Password copied — clears in 30 seconds' : 'Username copied');
        } else if (e.target.closest('[data-reveal]')) {
          const secret = $('[data-secret]', row);
          clearTimeout(revealed.get(id));
          secret.textContent = await shell.vault.reveal(id);
          secret.classList.add('shown');
          revealed.set(id, setTimeout(() => {
            secret.textContent = '••••••••••';
            secret.classList.remove('shown');
          }, 15_000));
        } else if (e.target.closest('[data-edit]')) {
          editLogin(win, entry, load);
        } else {
          const del = e.target.closest('[data-delete]');
          if (del && armed(del)) await shell.vault.remove(id);
        }
      } catch (err) {
        toast(cleanError(err), 'error');
      }
    });

    win.cleanups.push(shell.on('shell:vault-changed', load));
    win.cleanups.push(shell.on('shell:autofill-changed', load));
    win.cleanups.push(() => revealed.forEach(clearTimeout));
    load();
  },
});
