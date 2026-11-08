// Leafdeck OS lock screen (public/lock.html), shown by electron/oslock.cjs above everything else. The same page is the
// sign-in screen (electron/greeter.cjs, mode 'greeter'): there it signs in, and offers every account on the computer.
(() => {
  const api = window.leafdeckLock;
  const $ = (id) => document.getElementById(id);
  const pw = $('pw');
  const msg = $('msg');
  const form = $('form');
  let greeter = false;
  let user = ''; // the account to sign in as (greeter)
  let pin = false; // the account has a PIN (os/leafdeck-pin)
  let pinLocked = false; // too many wrong PINs: the password is needed
  let safe = false; // greeter: sign in to safe mode (os/leafdeck-session --safe)
  let failed = ''; // greeter: how the account's last session ended ('crashed', 'safe-failed'; electron/greeter.cjs)
  const note = $('note');
  const safeToggle = $('safeToggle');
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const showUser = (name) => {
    $('name').textContent = name;
    $('avatar').textContent = (name.trim()[0] || '?').toUpperCase();
  };
  const setPin = (has, off) => {
    pin = !!has;
    pinLocked = !!off;
    pw.placeholder = pin && !pinLocked ? 'PIN or password' : 'Password';
    pw.setAttribute('aria-label', `${pw.placeholder} for ${$('name').textContent}`);
  };

  function tick() {
    const d = new Date();
    $('time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
    $('date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  tick();
  setInterval(tick, 1000);

  // Who's signed in, their wallpaper and accent. Retried: the very first request can arrive before Leafdeck is ready.
  const loadInfo = (tries = 0) =>
    api
      ?.info()
      .then((i) => {
        if (i.wallpaper) $('wall').style.backgroundImage = `url("${i.wallpaper.replace(/"/g, '%22')}")`;
        if (i.accent) document.documentElement.style.setProperty('--accent', i.accent);
        showUser(i.name || i.user || '');
        setPin(i.pin, i.pinLocked);
        if (pinLocked) msg.textContent = 'Too many wrong PINs. Use your password.';
        if (i.mode === 'greeter' && !greeter) setUpGreeter(i);
      })
      .catch(() => tries < 10 && setTimeout(() => loadInfo(tries + 1), 300));
  loadInfo();
  // Locked again after a restart, the lock screen can open before Leafdeck has said which wallpaper and accent to use.
  [3000, 8000].forEach((ms) => setTimeout(() => !$('wall').style.backgroundImage && loadInfo(), ms));

  /** Sign-in screen: "Sign in" wording, and a row of accounts to choose from when there's more than one. */
  function setUpGreeter(i) {
    greeter = true;
    user = i.user;
    document.body.classList.add('greeter');
    document.title = 'Sign in';
    form.querySelector('.lk-go').setAttribute('aria-label', 'Sign in');
    LABEL.enter = 'Sign in';
    // Safe mode: Leafdeck with its default settings, and Claude to help fix what's wrong (os/leafdeck-session --safe).
    // Offered up front when the last session ended with Leafdeck crashing.
    safeToggle.hidden = false;
    safeToggle.addEventListener('click', () => setSafe(!safe));
    setFailed(i.failed);
    const list = Array.isArray(i.users) ? i.users : [];
    if (list.length < 2) return;
    const row = document.createElement('div');
    row.className = 'lk-users';
    row.innerHTML = list
      .map((u) => `<button type="button" class="lk-user${u.user === user ? ' on' : ''}" data-user="${esc(u.user)}" data-name="${esc(u.name)}" data-pin="${u.pin ? 1 : ''}" data-failed="${esc(u.failed || '')}">
        <span class="lk-user-av">${esc((u.name.trim()[0] || '?').toUpperCase())}</span><span>${esc(u.name)}</span></button>`)
      .join('');
    row.addEventListener('click', (e) => {
      const b = e.target.closest('[data-user]');
      if (!b) return;
      user = b.dataset.user;
      showUser(b.dataset.name);
      setPin(b.dataset.pin, false);
      setFailed(b.dataset.failed);
      if (!kb.hidden) showKb(true);
      row.querySelectorAll('.lk-user').forEach((x) => x.classList.toggle('on', x === b));
      pw.value = '';
      msg.textContent = '';
      pw.focus();
    });
    document.querySelector('.lk-foot').before(row);
  }

  /** The account's last session ended with Leafdeck crashing: say so, and start from safe mode. */
  function setFailed(how) {
    failed = how === 'crashed' || how === 'safe-failed' ? how : '';
    setSafe(!!failed);
  }
  function setSafe(on) {
    safe = !!on;
    safeToggle.setAttribute('aria-pressed', String(safe));
    document.body.classList.toggle('safe', safe);
    const why = failed === 'safe-failed' ? 'Leafdeck couldn’t start last time, even in safe mode.' : failed ? 'Leafdeck couldn’t start last time.' : '';
    const what = safe ? 'Safe mode starts Leafdeck with its default settings, and Claude helps fix what’s wrong.' : '';
    note.textContent = [why, what].filter(Boolean).join(' ');
    note.hidden = !note.textContent;
    form.querySelector('.lk-go').setAttribute('aria-label', safe ? 'Sign in to safe mode' : 'Sign in');
    LABEL.enter = safe ? 'Safe mode' : 'Sign in';
    if (!kb.hidden) drawKb();
  }

  let busy = false;
  let waitTimer = 0;
  function waitFor(seconds) {
    pw.disabled = true;
    let left = seconds;
    const show = () => (msg.textContent = `Too many tries. Try again in ${left}s.`);
    show();
    clearInterval(waitTimer);
    waitTimer = setInterval(() => {
      left -= 1;
      if (left > 0) return show();
      clearInterval(waitTimer);
      pw.disabled = false;
      msg.textContent = '';
      pw.focus();
    }, 1000);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !pw.value) return;
    busy = true;
    form.classList.add('checking');
    msg.textContent = '';
    const r = await api.unlock(pw.value, greeter ? user : undefined, greeter && safe).catch(() => ({ ok: false }));
    busy = false;
    if (r.ok) {
      if (greeter) msg.textContent = safe ? 'Signing in to safe mode…' : 'Signing in…'; // the session starts as this screen goes away
      return;
    }
    form.classList.remove('checking');
    pw.value = '';
    form.classList.remove('shake');
    void form.offsetWidth; // restart the animation
    form.classList.add('shake');
    if (r.pinLocked) setPin(pin, true);
    if (r.wait) waitFor(r.wait);
    else {
      msg.textContent = r.error || (r.pinLocked ? 'Too many wrong PINs. Use your password.' : pin && !pinLocked ? 'Wrong PIN or password' : 'Wrong password');
      pw.focus();
    }
  });

  // Caps Lock hint.
  pw.addEventListener('keyup', (e) => {
    if (busy || pw.disabled || /Too many/.test(msg.textContent)) return;
    if (e.getModifierState?.('CapsLock')) msg.textContent = 'Caps Lock is on';
    else if (msg.textContent === 'Caps Lock is on') msg.textContent = '';
  });

  // Typing anywhere goes to the password box; clicking the wallpaper focuses it.
  addEventListener('keydown', (e) => {
    if (document.activeElement !== pw && !pw.disabled && e.key.length === 1) pw.focus();
  });
  addEventListener('pointerdown', (e) => {
    if (!e.target.closest('button, input')) setTimeout(() => pw.focus());
  });

  // Restart and Shut down: second click confirms.
  let armed = null;
  document.querySelector('.lk-foot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-power]');
    if (!b) return;
    const act = b.dataset.power;
    if (armed !== act) {
      armed = act;
      document.querySelectorAll('.lk-foot button').forEach((x) => x.classList.remove('armed'));
      b.classList.add('armed');
      b.querySelector('span').textContent = act === 'restart' ? 'Restart?' : 'Shut down?';
      setTimeout(() => {
        if (armed !== act) return;
        armed = null;
        b.classList.remove('armed');
        b.querySelector('span').textContent = act === 'restart' ? 'Restart' : 'Shut down';
      }, 4000);
      return;
    }
    api.power(act);
  });

  // On-screen keyboard: for touch, or when the Bluetooth keyboard isn't connected. Opens on its own when you touch the screen.
  const kb = $('kb');
  const kbToggle = $('kbToggle');
  const LAYERS = {
    abc: ['qwertyuiop', 'asdfghjkl', ['shift', ...'zxcvbnm', 'back'], ['sym', 'space', 'enter']],
    sym: ['1234567890', '-/:;()$&@"', ['more', ...".,?!'_", 'back'], ['abc', 'space', 'enter']],
    more: ['[]{}#%^*+=', '\\|~<>€£¥•`', ['sym', ...".,?!'", 'back'], ['abc', 'space', 'enter']],
    pin: ['123', '456', '789', ['abc', '0', 'back'], ['enter']],
  };
  const LABEL = { shift: '⇧', back: '⌫', sym: '123', more: '#+=', abc: 'ABC', space: '', enter: 'Unlock' };
  let layer = 'abc';
  let shift = false;
  function drawKb() {
    kb.innerHTML = LAYERS[layer]
      .map((row) => `<div class="kb-row">${[...row].map((k) => {
        const special = k.length > 1;
        const text = special ? LABEL[k] : shift ? k.toUpperCase() : k;
        const cls = `kb-key${special ? ` kb-${k}` : ''}${k === 'shift' && shift ? ' on' : ''}`;
        const h = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<button type="button" class="${cls}" data-k="${h(k)}"${special ? ` aria-label="${k}"` : ''}>${h(text)}</button>`;
      }).join('')}</div>`)
      .join('');
  }
  function showKb(on) {
    kb.hidden = !on;
    document.body.classList.toggle('kb', on);
    kbToggle.setAttribute('aria-pressed', String(on));
    layer = pin && !pinLocked ? 'pin' : 'abc'; // a number pad for the PIN
    shift = false;
    if (on) drawKb();
  }
  kbToggle.addEventListener('click', () => showKb(kb.hidden));
  // Keys don't take focus, so the password box keeps it (and a real keyboard still works alongside).
  kb.addEventListener('pointerdown', (e) => {
    const key = e.target.closest('[data-k]');
    e.preventDefault();
    if (!key || pw.disabled || busy) return;
    const k = key.dataset.k;
    if (k === 'shift') shift = !shift;
    else if (k === 'sym' || k === 'more' || k === 'abc') {
      layer = k;
      shift = false;
    } else if (k === 'back') pw.value = pw.value.slice(0, -1);
    else if (k === 'enter') return form.requestSubmit();
    else {
      pw.value += k === 'space' ? ' ' : shift ? k.toUpperCase() : k;
      shift = false;
      if (/^Wrong/.test(msg.textContent)) msg.textContent = '';
    }
    drawKb();
  });
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && kb.hidden && !e.target.closest('.lk-foot')) showKb(true);
  }, true);

  pw.focus();
})();
