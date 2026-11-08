// The rescue screen (rescue.html, electron/rescue.cjs): what's running in Leafdeck, and a way out of whatever is stuck.
// A plain script on its own: it must not depend on the desktop's code, which may be the thing that's stuck.
(() => {
  const api = window.leafdeckRescue;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const mb = (bytes) => (bytes ? `${Math.round(bytes / 1048576)} MB` : '—');
  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };

  if (location.hash === '#asked') {
    $('title').textContent = 'What would you like to do?';
    $('sub').textContent = 'End a page, reload the desktop, or restart.';
  }

  async function draw() {
    let info;
    try {
      info = await api.info();
    } catch (err) {
      $('msg').textContent = err.message;
      return;
    }
    const rows = info.pages.filter((p) => ['app', 'site'].includes(p.kind)).sort((a, b) => b.cpu - a.cpu);
    $('list').innerHTML = rows.length
      ? rows
          .map((p) => {
            const desktop = p.kind === 'app';
            const stuck = desktop && !info.desktopAnswers;
            const name = desktop ? 'Leafdeck desktop' : p.title || hostOf(p.url) || 'Page';
            const note = stuck ? '<small class="rs-stuck">Not responding</small>' : desktop ? '' : `<small>${esc(hostOf(p.url))}</small>`;
            const btn = desktop ? '<button type="button" data-act="reload-desktop">Reload</button>' : `<button type="button" data-end="${p.webContentsId}">End page</button>`;
            return `<div class="rs-row"><div class="rs-name">${esc(name)}${note}</div><span class="rs-num${p.cpu > 50 ? ' rs-hot' : ''}">${p.shared ? '—' : Math.round(p.cpu) + '%'}</span><span class="rs-num">${mb(p.memory)}</span>${btn}</div>`;
          })
          .join('')
      : '<div class="rs-empty">Nothing is running.</div>';
  }

  // Restart and shut down ask once more: the button turns red, press it again.
  let armed = null;
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    $('msg').textContent = '';
    try {
      if (t.dataset.end) {
        t.disabled = true;
        await api.act('end-page', t.dataset.end);
        return draw();
      }
      const act = t.dataset.act;
      if (['restart', 'shutdown', 'restart-leafdeck', 'safe-mode'].includes(act) && armed !== t) {
        armed?.classList.remove('armed');
        armed = t;
        t.classList.add('armed');
        t.dataset.label ||= t.textContent;
        t.textContent = 'Press again to confirm';
        return;
      }
      if (act) await api.act(act);
    } catch (err) {
      $('msg').textContent = err.message;
    }
  });

  draw();
  setInterval(draw, 2000);
})();
