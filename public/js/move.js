// "Move to another computer": export everything Leafdeck keeps on this computer to one passphrase-encrypted file,
// and bring it in on the other one (Windows → Leafdeck OS). The work is in electron/move.cjs; passwords and
// sign-ins never come through here.

import { store } from './store.js';
import { $, esc, el } from './util.js';
import { icon } from './icons.js';
import { toast } from './wm.js';
import { shell } from './shell.js';

const plain = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const size = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// The desktop's own settings in this window's storage. ws:data is the offline copy of records (moved separately).
function desktopStorage() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('ws:') && k !== 'ws:data') out[k] = localStorage.getItem(k);
  }
  return out;
}

/** The UI's own parts of a move file or backup: the desktop's settings and the records (electron/move.cjs's `ui`). */
export const uiParts = () => ({ localStorage: desktopStorage(), collections: store.data, storeMode: store.local ? 'local' : store.mode });

const WHAT = [
  ['key', 'Saved passwords, addresses and cards'],
  ['globe', 'Website sign-ins, so you stay logged in'],
  ['clock', 'Browsing history'],
  ['shield', 'Browsing settings, site permissions and your server connection'],
  ['sparkle', 'Theme, wallpaper, open windows and the apps you built'],
];

export function openExportSheet(win) {
  const node = el(`<form class="rec-form move">
    <div class="sheet-head"><div><h2>Move to another computer</h2>
      <small>Saves everything Leafdeck keeps on this computer to one file, locked with a passphrase. Open it in Leafdeck on the other computer — or in Leafdeck OS.</small></div></div>
    <div class="sheet-scroll">
      <ul class="move-what">${WHAT.map(([i, t]) => `<li>${icon(i, 14)} ${esc(t)}</li>`).join('')}</ul>
      <p class="muted small">Your records, bookmarks and calendars already live on your server and come along when the other computer connects to it.</p>
      <div class="form-grid">
        <label class="field span2"><span>Passphrase</span><input type="password" name="p1" minlength="8" required autocomplete="new-password" placeholder="At least 8 characters"></label>
        <label class="field span2"><span>Passphrase again</span><input type="password" name="p2" minlength="8" required autocomplete="new-password"></label>
      </div>
      <p class="muted small">You’ll need it to open the file. Leafdeck can’t recover it. Anyone with the file and the passphrase gets your passwords, so delete the file once you’ve moved.</p>
      <div class="imp-result" data-result></div>
    </div>
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary" data-go>${icon('download', 12)} Save file…</button></div></form>`);
  const sh = win.sheet(node);
  const result = $('[data-result]', node);
  node.elements.p1.focus();

  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]')) sh.close();
    const r = e.target.closest('[data-reveal]');
    if (r) shell.move.reveal(r.dataset.reveal);
  });
  node.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = node.elements;
    if (f.p1.value !== f.p2.value) {
      result.innerHTML = '<span class="txt-red">The passphrases don’t match.</span>';
      return;
    }
    const go = $('[data-go]', node);
    go.disabled = true;
    result.innerHTML = '<span class="muted">Collecting your things…</span>';
    try {
      const r = await shell.move.exportAll({ passphrase: f.p1.value, ui: uiParts() });
      if (r.canceled) {
        result.innerHTML = '';
        return;
      }
      const c = r.summary.counts;
      result.innerHTML = `<div>${icon('tick', 13, 2.4)} Saved <b>${esc(r.file.split(/[\\/]/).pop())}</b> (${size(r.size)}) — ${plural(c.passwords, 'password')}, sign-ins for ${plural(c.sites, 'site')}, ${plural(c.history, 'history entry', 'history entries')}${c.apps ? `, ${plural(c.apps, 'app')}` : ''}.</div>
        <div class="imp-warn">${icon('leaf', 14)} <span>Copy it to a USB drive or your cloud storage. Then in Leafdeck OS open <b>Settings → Move from another computer</b>.</span>
        <button type="button" class="btn small" data-reveal="${esc(r.file)}">Show file</button></div>`;
      f.p1.value = f.p2.value = '';
      go.remove();
      $('[data-cancel]', node).textContent = 'Done';
    } catch (err) {
      result.innerHTML = `<span class="txt-red">${esc(plain(err))}</span>`;
    } finally {
      go.disabled = false;
    }
  });
  return sh;
}

export async function openImportMoveSheet(win) {
  const node = el(`<div class="rec-form move">
    <div class="sheet-head"><div><h2>Move from another computer</h2>
      <small>Bring in the file you saved in Leafdeck on your other computer (Settings → Move to another computer), or a backup from a USB drive (Settings → Backup).</small></div></div>
    <div class="sheet-scroll" data-body></div>
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-go hidden></button></div></div>`);
  const sh = win.sheet(node);
  const body = $('[data-body]', node);
  const go = $('[data-go]', node);
  let file = '';
  let step = 'pick';

  const pick = async () => {
    step = 'pick';
    go.hidden = true;
    body.innerHTML = '<p class="muted">Looking for your file…</p>';
    const found = await shell.move.find().catch(() => []);
    body.innerHTML = `${
      found.length
        ? `<div class="imp-sources">${found
            .map((f, i) => `<button class="imp-src" data-file="${i}"><b>${esc(f.name)}</b><span>${esc(f.dir)}</span><small>${size(f.size)} · ${new Date(f.modified).toLocaleString()}</small></button>`)
            .join('')}</div>`
        : '<p class="muted">No move file or backup in your Desktop, Downloads or Documents folders, or on a USB drive.</p>'
    }
      <div class="set-inline"><button class="btn small" data-choose>${icon('upload', 12)} Choose file…</button><button class="btn small" data-rescan>Look again</button></div>`;
    body.onclick = async (e) => {
      const b = e.target.closest('[data-file]');
      if (b) return unlock(found[b.dataset.file].file);
      if (e.target.closest('[data-rescan]')) return pick();
      if (e.target.closest('[data-choose]')) {
        const f = await shell.move.choose().catch(() => null);
        if (f) unlock(f);
      }
    };
  };

  const unlock = (f) => {
    step = 'unlock';
    file = f;
    body.onclick = null;
    body.innerHTML = `<p><b>${esc(f.split(/[\\/]/).pop())}</b></p>
      <div class="form-grid"><label class="field span2"><span>Passphrase</span><input type="password" data-pass autocomplete="off"></label></div>
      <div class="imp-result" data-result></div>`;
    go.hidden = false;
    go.textContent = 'Open';
    const pass = $('[data-pass]', body);
    pass.focus();
    pass.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  };

  const choose = (s) => {
    step = 'choose';
    const c = s.counts;
    const opt = (key, label, note, on = true) =>
      `<label class="field check span2"><input type="checkbox" data-part="${key}" ${on ? 'checked' : ''}><span>${label}${note ? `<br><small class="muted">${note}</small>` : ''}</span></label>`;
    body.innerHTML = `<p class="muted small">From <b>${esc(s.from?.computer || 'another computer')}</b>, saved ${esc(new Date(s.exportedAt).toLocaleString())}.</p>
      <div class="form-grid">
        ${c.passwords ? opt('passwords', plural(c.passwords, 'saved password'), 'Added to the ones here; a login you already have here gets the newer password') : ''}
        ${c.autofill ? opt('autofill', plural(c.autofill, 'address or card', 'addresses and cards')) : ''}
        ${c.sites ? opt('sites', `Website sign-ins (${plural(c.sites, 'site')})`, 'Some sites may still ask you to sign in again on a new computer') : ''}
        ${c.history ? opt('history', plural(c.history, 'history entry', 'history entries')) : ''}
        ${opt('settings', 'Browsing settings and server connection', s.server ? `Connects to ${esc(s.server)} — your records, bookmarks and calendars come from there` : '')}
        ${opt('desktop', 'Theme, wallpaper and open windows', 'Replaces the desktop setup here')}
        ${c.apps ? opt('apps', plural(c.apps, 'app you built', 'apps you built'), 'Apps with the same name here are kept as they are') : ''}
        ${s.storeMode === 'local' && c.records ? opt('records', plural(c.records, 'record'), 'They were saved only on that computer. Replaces the records here', !store.data || !Object.values(store.data).some((v) => v?.length)) : ''}
      </div>
      <div class="imp-result" data-result></div>`;
    go.textContent = 'Import';
  };

  const finish = (r) => {
    step = 'done';
    const d = r.done;
    const lines = [
      d.passwords && `Passwords: ${d.passwords.added} added, ${d.passwords.updated} updated`,
      d.autofill && `${plural(d.autofill.added, 'address or card', 'addresses and cards')} added`,
      d.sites != null && `${plural(d.sites, 'sign-in cookie')} restored`,
      d.history != null && `${plural(d.history, 'history entry', 'history entries')} added`,
      d.settings && 'Settings and server connection',
      d.apps && `${plural(d.apps.added, 'app')} added${d.apps.skipped ? ` (${d.apps.skipped} already here)` : ''}`,
      r.ui.localStorage && 'Theme, wallpaper and windows',
      r.ui.collections && `Records${d.media ? ` and ${plural(d.media, 'media file')}` : ''}`,
    ].filter(Boolean);
    body.innerHTML = `<div class="imp-result">${lines.map((l) => `<div>${icon('tick', 13, 2.4)} ${esc(l)}</div>`).join('')}</div>
      <div class="imp-warn">${icon('shield', 14)} <span>The file holds your passwords. Once everything looks right, delete it — and its copy on the USB drive or in the cloud.</span></div>`;
    $('[data-cancel]', node).hidden = true;
    go.textContent = 'Finish';
  };

  node.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel]')) return sh.close();
    if (!e.target.closest('[data-go]')) return;
    const out = $('[data-result]', body);
    if (step === 'done') return location.reload(); // starts fresh with the new settings, windows and sign-ins
    go.disabled = true;
    try {
      if (step === 'unlock') {
        if (out) out.innerHTML = '<span class="muted">Unlocking…</span>';
        choose(await shell.move.inspect(file, $('[data-pass]', body).value));
      } else if (step === 'choose') {
        const parts = [...body.querySelectorAll('[data-part]:checked')].map((i) => i.dataset.part);
        if (!parts.length) return;
        out.innerHTML = '<span class="muted">Importing…</span>';
        const r = await shell.move.apply(parts);
        // Keep this desktop's preferences when the file has none.
        if (r.ui.collections) await store.replaceAll({ ...r.ui.collections, settings: r.ui.collections.settings?.length ? r.ui.collections.settings : store.all('settings') });
        if (r.ui.localStorage) for (const [k, v] of Object.entries(r.ui.localStorage)) if (k.startsWith('ws:') && typeof v === 'string') localStorage.setItem(k, v);
        finish(r);
      }
    } catch (err) {
      if (out) out.innerHTML = `<span class="txt-red">${esc(plain(err))}</span>`;
      else toast(plain(err), 'error');
    } finally {
      go.disabled = false;
    }
  });

  pick();
  return sh;
}
