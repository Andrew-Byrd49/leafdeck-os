// Runs in an isolated world inside every website webview. It exposes nothing to the page. It only:
// - fills a login when Leafdeck's main process sends one (after verifying the page's real origin), and
// - reports a submitted login so Leafdeck can offer to save it (the main process decides the site from
//   the frame itself, so a page can't claim to be another site), and
// - asks for Leafdeck OS's on-screen keyboard when a text field is tapped (main ignores it outside the OS session).
const { ipcRenderer } = require('electron');

const editable = (el) =>
  !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(el.type)));
let touchedAt = 0;
addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touchedAt = Date.now();
  if (editable(e.target)) ipcRenderer.send('leafdeck:osk'); // already focused: no focusin follows
}, true);
addEventListener('focusin', (e) => Date.now() - touchedAt < 1000 && editable(e.target) && ipcRenderer.send('leafdeck:osk'), true);
// Where the last right-click was, in the page's own coordinates (the menu's are the window's): Designer's "Capture
// Element in Designer" starts there (electron/main.cjs reads it from this world).
addEventListener('contextmenu', (e) => (globalThis.__ldContextAt = { x: e.clientX, y: e.clientY }), true);
// The Site Editor's in-page script (public/js/siteeditor/inpage.js, in its own isolated world) reports what the user
// did on the page as a DOM event with a JSON string; main (electron/siteeditor.cjs) only listens while the editor is
// on that page, and treats it as data.
document.addEventListener('leafdeck-site-editor', (e) => typeof e.detail === 'string' && ipcRenderer.send('leafdeck:site-editor', e.detail), true);

const visible = (el) => {
  if (!el || el.disabled || el.readOnly) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
};

// Native setter + input/change events so frameworks (React, Vue…) register the new value.
const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

const TEXTISH = 'input[autocomplete~="username"], input[type="email"], input[type="text"], input[type="tel"], input:not([type])';
const IDENTIFIER =
  'input[autocomplete~="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="user" i], input[id*="email" i]';

/** The username field for a password field: the last visible text-like input before it. */
function usernameFor(pw) {
  return [...(pw.form || document).querySelectorAll(TEXTISH)]
    .filter(visible)
    .filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)
    .pop();
}

function fill({ username, password }) {
  const pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (pw) {
    setValue(pw, password);
    const user = usernameFor(pw);
    if (user && username) setValue(user, username);
    pw.focus();
    return true;
  }
  // Username-first sign-in steps (Google, Microsoft…): fill the identifier field.
  const id = [...document.querySelectorAll(IDENTIFIER)].find(visible);
  if (id && username) {
    setValue(id, username);
    id.focus();
    return true;
  }
  return false;
}

ipcRenderer.on('leafdeck:fill', (_event, data) => {
  let filled = false;
  try {
    filled = fill(data);
  } finally {
    ipcRenderer.send('leafdeck:fill-result', filled);
  }
});

/* ---------- Offer to save logins ---------- */

let lastSent = '';

function capture(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const pw = [...root.querySelectorAll('input[type="password"]')].find((p) => p.value);
  if (!pw) {
    // A username-only step: remember the identifier for the password step that follows.
    const id = [...root.querySelectorAll(IDENTIFIER)].find((el) => visible(el) && el.value);
    if (id) ipcRenderer.send('leafdeck:identifier', id.value);
    return;
  }
  const username = usernameFor(pw)?.value || '';
  const key = `${location.host}\n${username}\n${pw.value}`;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('leafdeck:login-submitted', { username, password: pw.value });
}

const run = (scope) => {
  try {
    capture(scope);
  } catch {
    /* never break the page */
  }
  try {
    captureForms(scope); // addresses and cards (below)
  } catch {}
};

document.addEventListener('submit', (e) => run(e.target), true);
document.addEventListener(
  'click',
  (e) => {
    const b = e.target.closest?.('button, input[type="submit"], input[type="button"], [role="button"]');
    if (b) run(b.closest('form') || document);
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Enter' && e.target?.tagName === 'INPUT') run(e.target.form || document);
  },
  true,
);

/* Passkeys: Chromium's "conditional" (autofill-style) passkey requests have no quiet UI in Electron, so a
   sign-in page that asks for passkey suggestions (Google, GitHub, Microsoft…) would pop the full Windows
   Security prompt as soon as it loads — offering whatever passkey Windows has saved. Tell pages that
   autofill passkeys aren't available, and leave conditional requests pending (as Chrome does until you pick
   one) so nothing pops up. Clicking a site's "Sign in with a passkey" button still opens Windows Hello. */
function quietConditionalPasskeys() {
  const PKC = window.PublicKeyCredential;
  if (PKC) {
    if (PKC.isConditionalMediationAvailable) PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
    if (PKC.getClientCapabilities) {
      const caps = PKC.getClientCapabilities.bind(PKC);
      PKC.getClientCapabilities = () => caps().then((c) => ({ ...c, conditionalGet: false, conditionalCreate: false }));
    }
  }
  const creds = navigator.credentials;
  if (!creds?.get) return;
  const get = creds.get.bind(creds);
  creds.get = function (options) {
    if (options?.mediation === 'conditional' && options.publicKey) {
      return new Promise((_resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    return get(options);
  };
}
try {
  // Has to run in the page's own world, before its scripts.
  const { contextBridge, webFrame } = require('electron');
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: quietConditionalPasskeys });
  else webFrame.executeJavaScript(`(${quietConditionalPasskeys})()`);
} catch {
  /* never break the page */
}

/* Camera and microphone: Electron reports every permission it hasn't been given as "denied", so a video call site
   (Google Meet, Zoom, Teams…) that checks navigator.permissions first says the camera is blocked and never asks.
   Report "prompt" instead, as Chrome does, unless you blocked it for this site (main process: leafdeck:media-blocked);
   asking then shows Leafdeck's permission bar. */
function chromeLikeMediaPermissions(blocked) {
  const perms = navigator.permissions;
  const getState = Object.getOwnPropertyDescriptor(window.PermissionStatus?.prototype || {}, 'state')?.get;
  if (!perms?.query || !getState) return;
  const query = perms.query.bind(perms);
  perms.query = function (descriptor) {
    return query(descriptor).then((status) => {
      const name = descriptor?.name;
      if ((name === 'camera' || name === 'microphone') && !blocked[name]) {
        Object.defineProperty(status, 'state', {
          configurable: true,
          enumerable: true,
          get() {
            const s = getState.call(this);
            return s === 'denied' ? 'prompt' : s;
          },
        });
      }
      return status;
    });
  };
}
try {
  const { contextBridge, webFrame } = require('electron');
  const blocked = ipcRenderer.sendSync('leafdeck:media-blocked') || {};
  const args = [{ camera: !!blocked.camera, microphone: !!blocked.microphone }];
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: chromeLikeMediaPermissions, args });
  else webFrame.executeJavaScript(`(${chromeLikeMediaPermissions})(${JSON.stringify(args[0])})`);
} catch {
  /* never break the page */
}

/* On Linux a page's alert / confirm / prompt, print() and "Leave site?" are Leafdeck's own (public/js/pageui.js)
   instead of GTK boxes. They run in the page's world but keep their meaning: each waits for the answer, as the real
   ones do. `ask` is the only thing this hands the page, as an argument, never as a global. */
function ownPageDialogs(ask) {
  const text = (v) => (v === undefined ? '' : String(v));
  const define = (name, fn) => Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true });
  define('alert', function alert(message) {
    ask('alert', text(message));
  });
  define('confirm', function confirm(message) {
    return ask('confirm', text(message)) === true;
  });
  define('prompt', function prompt(message, value) {
    const r = ask('prompt', text(message), value == null ? '' : String(value));
    return typeof r === 'string' ? r : null;
  });
  define('print', function print() {
    ask('print', '');
  });
  // "Leave site?": Chromium asks when a beforeunload handler objects, but Electron leaves that to the app, and
  // without an answer it just stays. So each handler is watched: once one objects, the person decides (once per
  // leaving), and the main process lets the page go if they chose Leave (will-prevent-unload).
  const answered = new WeakSet();
  const after = (e, ret) => {
    if (answered.has(e) || !navigator.userActivation?.hasBeenActive) return; // Chromium only asks once you've used the page
    if (!(e.defaultPrevented || (e.returnValue !== '' && e.returnValue !== true) || ret != null)) return;
    answered.add(e);
    ask('leave', '');
  };
  const wrapped = new WeakMap();
  const watch = (fn) => {
    if (!wrapped.has(fn)) {
      wrapped.set(fn, function (e) {
        const r = typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e);
        after(e);
        return r;
      });
    }
    return wrapped.get(fn);
  };
  const { addEventListener: add, removeEventListener: remove } = EventTarget.prototype;
  EventTarget.prototype.addEventListener = function addEventListener(type, fn, opts) {
    return add.call(this, type, this === window && type === 'beforeunload' && fn ? watch(fn) : fn, opts);
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(type, fn, opts) {
    return remove.call(this, type, (this === window && type === 'beforeunload' && fn && wrapped.get(fn)) || fn, opts);
  };
  const attr = Object.getOwnPropertyDescriptor(window, 'onbeforeunload') || Object.getOwnPropertyDescriptor(Window.prototype, 'onbeforeunload');
  let handler = null;
  if (attr?.set) {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      enumerable: true,
      get: () => handler,
      set(v) {
        handler = typeof v === 'function' ? v : null;
        attr.set.call(
          window,
          handler &&
            function (e) {
              const r = handler.call(this, e);
              after(e, r);
              return r;
            },
        );
      },
    });
  }
}
if (process.platform === 'linux') {
  try {
    const { contextBridge } = require('electron');
    const ask = (kind, message, value) => ipcRenderer.sendSync('leafdeck:page-dialog', { kind: String(kind), message: String(message).slice(0, 10000), value: String(value ?? '').slice(0, 10000) });
    contextBridge.executeInMainWorld?.({ func: ownPageDialogs, args: [ask] });
  } catch {
    /* never break the page */
  }
}

// A site's color field: Leafdeck's color picker (public/js/pageui.js), next to the field, instead of GTK's chooser.
if (process.platform === 'linux') {
  addEventListener(
    'click',
    async (e) => {
      const input = e.target instanceof Element && e.target.closest('input[type="color"]');
      if (!input || input.disabled || !e.isTrusted) return;
      e.preventDefault();
      const r = input.getBoundingClientRect();
      const top = window === window.top;
      const v = await ipcRenderer.invoke('leafdeck:pick-color', { value: input.value, x: top ? r.left : null, y: top ? r.bottom + 6 : null });
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v) || v === input.value) return;
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    true,
  );
}

// A site's dropdown (a <select>'s list): Leafdeck's menu (public/js/pageui.js), kept on the field's screen and scrolling
// when it's long. Chromium's own list fits whichever screen Leafdeck's window mostly covers, and that window spans them
// all. Only in the top frame (a frame's positions aren't the page's): a frame keeps Chromium's list.
let menuUp = false; // a Leafdeck menu for this page is open (a dropdown's or the context menu): a click here closes it
let shownSelect = null; // the <select> whose list is open
const dropdown = (el) => el instanceof HTMLSelectElement && !el.disabled && !el.multiple && el.size <= 1;
/** A <select>'s list for showMenu: its options, with each group's label as a header. */
function optionItems(select) {
  const item = (o) => ({ label: o.label || o.textContent.trim(), checked: o.selected, disabled: o.disabled, index: o.index });
  return [...select.children].flatMap((c) =>
    c instanceof HTMLOptGroupElement ? [{ header: c.label }, ...[...c.children].filter((o) => o instanceof HTMLOptionElement).map(item)] : c instanceof HTMLOptionElement ? [item(c)] : [],
  );
}
async function openDropdown(select) {
  select.focus();
  const r = select.getBoundingClientRect();
  shownSelect = select;
  menuUp = true;
  const i = await ipcRenderer.invoke('leafdeck:pick-option', { x: r.left, y: r.bottom + 2, top: r.top - 2, width: r.width, items: optionItems(select) });
  if (shownSelect === select) (shownSelect = null), (menuUp = false);
  const o = Number.isInteger(i) && select.options[i];
  if (!o || o.disabled || o.selected) return;
  o.selected = true;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
if (process.platform === 'linux') {
  addEventListener('contextmenu', () => (menuUp = true), true);
  addEventListener(
    'pointerdown',
    (e) => {
      if (!menuUp || !e.isTrusted) return;
      menuUp = false;
      ipcRenderer.send('leafdeck:menu-dismiss');
    },
    true,
  );
  addEventListener(
    'keydown',
    (e) => {
      if (!menuUp || e.key !== 'Escape' || !e.isTrusted) return;
      e.preventDefault();
      menuUp = false;
      ipcRenderer.send('leafdeck:menu-dismiss');
    },
    true,
  );
  if (window === window.top) {
    addEventListener(
      'mousedown',
      (e) => {
        const select = e.target instanceof Element && e.target.closest('select');
        if (!e.isTrusted || e.button !== 0 || !dropdown(select)) return;
        e.preventDefault();
        if (shownSelect !== select) openDropdown(select); // its list was open: this click closed it (pointerdown above)
      },
      true,
    );
    addEventListener(
      'keydown',
      (e) => {
        if (!e.isTrusted || !dropdown(e.target) || !(e.key === ' ' || e.key === 'F4' || (e.altKey && /^Arrow(Down|Up)$/.test(e.key)))) return;
        e.preventDefault();
        openDropdown(e.target);
      },
      true,
    );
  }
}

/* Site icons for Leafdeck's Dock and title bars: the page's declared webclip (apple-touch-icon) and favicons,
   read from this isolated world so the page can't tamper with the lookup. Only http(s)/data image URLs. */
const iconUrl = (u) => /^(https?:|data:image\/)/i.test(u || '') && u.length < 4096;
function reportIcons() {
  if (window.top !== window) return;
  const size = (l) => Math.max(0, ...String(l.getAttribute('sizes') || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
  const links = [...document.querySelectorAll('link[rel][href]')].filter((l) => iconUrl(l.href));
  const rels = (l) => l.rel.toLowerCase().split(/\s+/);
  const best = (list) => list.sort((a, b) => size(b) - size(a))[0]?.href || '';
  const clip = best(links.filter((l) => rels(l).some((r) => r.startsWith('apple-touch-icon'))));
  const icons = links.filter((l) => rels(l).includes('icon'));
  const large = best(icons.filter((l) => size(l) >= 96 || /\.svg(\?|$)/i.test(l.href)));
  const fav = icons.find((l) => size(l) >= 16 && size(l) <= 64)?.href || icons[0]?.href || '';
  ipcRenderer.sendToHost('leafdeck:icons', { clip, large, fav, origin: location.origin });
}
let iconTimer;
const queueIcons = () => {
  clearTimeout(iconTimer);
  iconTimer = setTimeout(() => {
    try {
      reportIcons();
    } catch {}
  }, 300);
};
document.addEventListener('DOMContentLoaded', () => {
  queueIcons();
  // Single-page apps swap icons later (e.g. unread counts); watch <head> for that.
  try {
    new MutationObserver(queueIcons).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] });
  } catch {}
});
window.addEventListener('load', queueIcons);

/* ================= Autofill menu (like Chrome's) =================
   Click a login, address or card field and a small menu lists what Leafdeck has saved for it. The menu
   lives in a closed shadow root, so the page can't read it; only real (trusted) clicks and keys pick an
   item; and the values come from the main process, which checks this page's real address first. */

const ADDRESS_TOKENS = {
  name: 'name', 'given-name': 'given', 'additional-name': 'middle', 'family-name': 'family', organization: 'organization',
  'street-address': 'street', 'address-line1': 'line1', 'address-line2': 'line2', 'address-line3': 'line3',
  'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'postal', country: 'country', 'country-name': 'country',
  tel: 'phone', 'tel-national': 'phone', email: 'email',
};
const CARD_TOKENS = {
  'cc-name': 'name', 'cc-given-name': 'given', 'cc-family-name': 'family', 'cc-number': 'number',
  'cc-exp': 'exp', 'cc-exp-month': 'month', 'cc-exp-year': 'year', 'cc-csc': 'csc',
};
// Fallbacks for fields without autocomplete hints, matched against their label, name, id and placeholder.
const HEURISTICS = [
  [/card.?num|cc.?num|credit.?card|debit.?card|cardnumber|acct.?num/, 'card', 'number'],
  [/name.?on.?card|card.?holder|cc.?name|holder.?name/, 'card', 'name'],
  [/exp\w*.?(month|mm\b)|cc.?month|\bexp.?m\b/, 'card', 'month'],
  [/exp\w*.?(year|yy)|cc.?year|\bexp.?y\b/, 'card', 'year'],
  [/expir|exp.?date|mm.?.?yy|valid.?thru/, 'card', 'exp'],
  [/cvc|cvv|csc|security.?code|card.?code/, 'card', 'csc'],
  [/e.?mail/, 'address', 'email'],
  [/full.?name|^name$|your.?name|contact.?name|recipient/, 'address', 'name'],
  [/first.?name|given.?name|\bfname\b|forename/, 'address', 'given'],
  [/last.?name|family.?name|surname|\blname\b/, 'address', 'family'],
  [/company|organi[sz]ation|business.?name/, 'address', 'organization'],
  [/address.?(line)?.?2|apartment|\bapt\b|suite|\bunit\b/, 'address', 'line2'],
  [/street|address.?(line)?.?1|^address$|addr1|billing.?address|shipping.?address|mailing.?address/, 'address', 'line1'],
  [/\bcity\b|town|locality|suburb/, 'address', 'city'],
  [/\bstate\b|province|region|county/, 'address', 'state'],
  [/\bzip\b|zip.?code|postal|post.?code/, 'address', 'postal'],
  [/country/, 'address', 'country'],
  [/phone|mobile|\btel\b|telephone|cell/, 'address', 'phone'],
];
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const COUNTRY_ALIASES = { us: ['us', 'usa', 'united states', 'united states of america'], gb: ['gb', 'uk', 'united kingdom', 'great britain'], ca: ['ca', 'canada'] };

const FILLABLE_INPUT = /^(text|email|tel|number|search|url|password|)$/;
const isField = (el) => (el?.tagName === 'INPUT' && FILLABLE_INPUT.test(el.type)) || el?.tagName === 'SELECT';

function fieldHint(el) {
  const label = [...(el.labels || [])].map((l) => l.textContent).join(' ');
  return [label, el.getAttribute('aria-label'), el.placeholder, el.name, el.id].filter(Boolean).join(' ').toLowerCase().slice(0, 300);
}

const passwordsIn = (scope) => [...scope.querySelectorAll('input[type="password"]')].filter(visible);

function isNewPassword(el) {
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (ac.includes('new-password')) return true;
  if (ac.includes('current-password')) return false;
  const h = fieldHint(el);
  if (/current|old|existing/.test(h)) return false;
  if (/new|confirm|repeat|retype|again|create|choose|sign.?up|register/.test(h)) return true;
  return passwordsIn(el.form || document).length >= 2; // sign-up / change-password forms have two
}

// Says it's for an email address, in its type or its example ("you@company.com"). Goes before the wording of its
// label and placeholder: that example reads as a company and a name to the heuristics.
const declaresEmail = (el) =>
  el.tagName === 'INPUT' && (el.type === 'email' || /\S@\S+\.\S/.test(el.placeholder || '') || (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('email'));

/** What a field is for: { kind: 'login'|'address'|'card', part } or null. */
function classify(el) {
  if (!isField(el) || !visible(el)) return null;
  if (el.type === 'password') return { kind: 'login', part: isNewPassword(el) ? 'new-password' : 'password' };
  const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const tok = tokens.find((t) => t === 'username' || ADDRESS_TOKENS[t] || CARD_TOKENS[t]);
  if (tok === 'username') return { kind: 'login', part: 'username' };
  if (CARD_TOKENS[tok]) return { kind: 'card', part: CARD_TOKENS[tok] };
  // A text field just before a password field (or an email-first sign-in step) is the username.
  const scope = el.form || document;
  const pw = passwordsIn(scope)[0];
  if (el.tagName === 'INPUT' && pw && usernameFor(pw) === el) return { kind: 'login', part: 'username' };
  if (el.tagName === 'INPUT' && !pw && el.matches(IDENTIFIER) && !tok && document.querySelectorAll('input:not([type=hidden])').length <= 4) {
    return { kind: 'login', part: 'username' };
  }
  if (ADDRESS_TOKENS[tok]) return { kind: 'address', part: ADDRESS_TOKENS[tok] };
  if (declaresEmail(el)) return { kind: 'address', part: 'email' };
  if (el.type === 'tel') return { kind: 'address', part: 'phone' };
  const h = fieldHint(el);
  for (const [re, kind, part] of HEURISTICS) if (re.test(h)) return { kind, part };
  return null;
}

/* ---------- Remembered form entries ---------- */

// Ordinary text fields get suggestions of what you've typed there before (keyed by the field's name).
// Never for anything that looks sensitive, and never when the site says autocomplete="off".
const SENSITIVE_FIELD = /pass|pwd|pin\b|otp|one.?time|verif|code|token|secret|ssn|social.?sec|tax.?id|card|cc.?|cvv|cvc|captcha|iban|routing|account.?n/;
function entryKey(el) {
  if (el?.tagName !== 'INPUT' || !/^(text|email|tel|search|url|)$/.test(el.type) || el.readOnly || el.disabled) return null;
  if ((el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('off')) return null;
  const email = declaresEmail(el);
  const key = (String(el.name || el.id || '').trim() || (email ? 'email' : '')).toLowerCase().slice(0, 60);
  if (!key || (!email && (SENSITIVE_FIELD.test(key) || SENSITIVE_FIELD.test(fieldHint(el))))) return null;
  const info = classify(el);
  if (info && (info.kind === 'login' || info.kind === 'card')) return null;
  return key;
}

/* ---------- Menu ---------- */

const ICONS = {
  key: '<path d="M15 7a4 4 0 1 1-3.9 4.9L3 20v-3l1-1v-2h2l1-1v-2l1.6-1.6A4 4 0 0 1 15 7z"/><circle cx="16" cy="10" r="1"/>',
  pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7.5 12 13l8.5-5.5"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const svg = (name) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
const MANAGE = { login: 'Manage passwords…', address: 'Manage addresses…', card: 'Manage payment methods…', entry: '' };
const MENU_CSS = `
  :host { all: initial; }
  .m { position: fixed; z-index: 2147483647; min-width: 260px; max-width: 380px; padding: 5px; box-sizing: border-box;
    border-radius: 11px; background: #25282b; color: #ecefed; border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 14px 40px rgba(0,0,0,.45); font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .i { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 7px; cursor: default; }
  .i.on { background: #34c77b; color: #06281a; }
  .i svg { flex-shrink: 0; opacity: .85; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t small { font-size: 11.5px; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.12); }
  .f { font-size: 12px; opacity: .85; }
  .brand { margin: 2px 9px 3px; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; opacity: .55; }`;
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Draws a menu in this document (closed shadow root — the page can't read it) and reports picks.
 * Used for this frame's own fields, and by the main page for fields inside embedded frames.
 */
function createMenuView(onPick) {
  const host = document.createElement('leafdeck-autofill');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${MENU_CSS}</style><div class="m" role="listbox"></div>`;
  const box = root.querySelector('.m');
  let sel = 0;
  let count = 0;
  // Keep focus in the field while you click the menu; only real clicks count.
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const row = e.composedPath().find((n) => n.dataset?.i != null);
    if (row) onPick(Number(row.dataset.i));
  });
  box.addEventListener('mousemove', (e) => {
    const row = e.composedPath().find((n) => n.dataset?.i != null);
    if (!row || Number(row.dataset.i) === sel) return;
    sel = Number(row.dataset.i);
    root.querySelectorAll('.i').forEach((r) => r.classList.toggle('on', Number(r.dataset.i) === sel));
  });
  return {
    host,
    draw(items, footer, selected) {
      sel = selected;
      count = items.length;
      const rows = items
        .map((it, i) => `<div class="i${i === sel ? ' on' : ''}" data-i="${i}">${svg(it.icon)}<span class="t"><b>${escHtml(it.label)}</b>${it.sub ? `<small>${escHtml(it.sub)}</small>` : ''}</span></div>`)
        .join('');
      box.innerHTML = `<div class="brand">Leafdeck</div>${rows}${
        footer ? `<div class="sep"></div><div class="i f${sel === count ? ' on' : ''}" data-i="${count}">${svg('gear')}<span class="t"><b>${escHtml(footer)}</b></span></div>` : ''
      }`;
    },
    /** Place under (or above) a rectangle in this document's viewport. */
    place(r) {
      if (r.bottom < 0 || r.top > innerHeight) return false;
      const h = box.offsetHeight;
      const below = r.bottom + 4 + h <= innerHeight || r.top < h + 4;
      box.style.top = `${below ? r.bottom + 4 : r.top - h - 4}px`;
      box.style.left = `${Math.max(4, Math.min(r.left, innerWidth - box.offsetWidth - 4))}px`;
      box.style.minWidth = `${Math.max(260, Math.min(r.width, 380))}px`;
      return true;
    },
    show() {
      document.documentElement.appendChild(host);
    },
    remove() {
      host.remove();
    },
  };
}

// The menu for a field in this frame. In an embedded frame it's drawn by the main page instead.
const IS_TOP = window.top === window;
const DRAW_HERE = IS_TOP || window.parent !== window.top; // deeper-nested frames: draw locally (best effort)
const AF = { field: null, info: null, items: [], sel: 0, view: null, remote: false, nonce: '', token: 0, footer: '' };

function closeMenu() {
  if (AF.remote) ipcRenderer.send('leafdeck:af-hide', { nonce: AF.nonce });
  AF.view?.remove();
  AF.view = null;
  AF.remote = false;
  AF.items = [];
  AF.field = null;
}

function drawMenu() {
  if (!AF.field) return;
  if (AF.remote) {
    const r = AF.field.getBoundingClientRect();
    ipcRenderer.send('leafdeck:af-show', {
      nonce: AF.nonce,
      items: AF.items.map(({ icon, label, sub }) => ({ icon, label, sub })),
      footer: AF.footer,
      sel: AF.sel,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    });
    return;
  }
  AF.view.draw(AF.items, AF.footer, AF.sel);
  if (!AF.view.place(AF.field.getBoundingClientRect())) closeMenu();
}

// The fields a pick can fill along with this one: its form, or the dialog it's in, not the page behind that.
const fieldScope = (el) => el.form || el.closest('dialog, [role="dialog"]') || document;
const aloneInForm = (field) => ![...fieldScope(field).querySelectorAll('input, select')].some((el) => el !== field && classify(el)?.kind === 'address');

async function openMenu(field) {
  const info = classify(field);
  const key = entryKey(field);
  if ((!info || (info.kind === 'card' && info.part === 'csc')) && !key) return closeMenu();
  const token = ++AF.token;
  let items = [];
  let kind = info && !(info.kind === 'card' && info.part === 'csc') ? info.kind : 'entry';
  let part = info?.part;
  try {
    if (kind === 'login') items = await ipcRenderer.invoke('leafdeck:af-query', { kind, newPassword: part === 'new-password' });
    // An email box that looks like a sign-in, with no login saved for this site: it still wants an email address.
    if (kind === 'login' && !items?.length && part === 'username' && declaresEmail(field)) {
      kind = 'address';
      part = 'email';
    }
    if (kind === 'address') items = await ipcRenderer.invoke('leafdeck:af-query', { kind, part, prefix: field.value, alone: aloneInForm(field) });
    else if (kind === 'card') items = await ipcRenderer.invoke('leafdeck:af-query', { kind });
    // What you've typed in fields like this before, after what's saved.
    if ((key || part === 'email') && kind !== 'login' && kind !== 'card') {
      const known = new Set(items.map((it) => it.label.toLowerCase()));
      const typed = await ipcRenderer.invoke('leafdeck:af-query', { kind: 'entry', key, part, prefix: field.value });
      items = [...items, ...typed.filter((it) => !known.has(it.label.toLowerCase()))];
      if (!known.size) kind = 'entry';
    }
  } catch {}
  if (token !== AF.token || document.activeElement !== field) return;
  if (!items?.length) return closeMenu();
  const same = AF.field === field && AF.info?.kind === kind && (AF.view || AF.remote);
  if (!same) {
    closeMenu();
    AF.nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    AF.remote = !DRAW_HERE;
    if (!AF.remote) {
      AF.view = createMenuView((i) => choose(i));
      AF.view.show();
    }
  }
  AF.field = field;
  AF.info = { kind, part, key };
  AF.items = items;
  AF.footer = MANAGE[kind];
  AF.sel = Math.min(same ? AF.sel : 0, items.length - 1);
  drawMenu();
}

const menuOpen = () => !!(AF.field && (AF.view || AF.remote));

async function choose(i) {
  const { field, info, items } = AF;
  closeMenu();
  if (!field) return;
  if (i === items.length) return info.kind !== 'entry' && ipcRenderer.send('leafdeck:af-manage', info.kind);
  const item = items[i];
  if (!item) return;
  if (item.kind === 'entry' || item.kind === 'value') {
    setField(field, item.id);
    field.focus();
    return;
  }
  let data;
  try {
    data = await ipcRenderer.invoke('leafdeck:af-fill', { kind: info.kind, id: item.id });
  } catch {
    return;
  }
  if (info.kind === 'login') fillLogin(field, data, item.id === 'generate');
  else if (info.kind === 'address') fillFields(field, 'address', addressValues(data));
  else if (info.kind === 'card') fillFields(field, 'card', cardValues(data));
}

// From the main page: you clicked row i of the menu it drew for a field in this frame.
ipcRenderer.on('leafdeck:af-choose', (_e, m) => {
  if (AF.remote && m?.nonce === AF.nonce) choose(Number(m.i));
});

/* ---------- Drawing menus for embedded frames (main page only) ---------- */

const remote = { view: null, nonce: '', frameEl: null, rect: null, locating: '' };

function placeRemote() {
  if (!remote.view || !remote.frameEl || !remote.rect) return;
  const f = remote.frameEl.getBoundingClientRect();
  // The frame's content box: skip its border so the menu lines up with the field.
  const cs = getComputedStyle(remote.frameEl);
  const ox = f.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
  const oy = f.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
  const r = remote.rect;
  if (!remote.view.place({ left: ox + r.left, top: oy + r.top, bottom: oy + r.top + r.height, width: r.width })) hideRemote();
}

function hideRemote() {
  remote.view?.remove();
  remote.view = null;
  remote.frameEl = null;
  remote.nonce = '';
}

if (IS_TOP) {
  ipcRenderer.on('leafdeck:af-remote', (_e, m) => {
    if (m.action === 'hide') {
      if (m.nonce === remote.nonce) hideRemote();
      return;
    }
    if (m.nonce !== remote.nonce) {
      hideRemote();
      remote.nonce = m.nonce;
      remote.view = createMenuView((i) => ipcRenderer.send('leafdeck:af-picked', { nonce: m.nonce, i }));
    }
    remote.rect = m.rect;
    remote.view.draw(m.items, m.footer, m.sel);
    if (remote.frameEl) return placeRemote();
    // Which <iframe> is it? Ask each one; only the frame holding this menu's nonce answers.
    remote.locating = m.nonce;
    for (const f of document.querySelectorAll('iframe')) {
      try {
        f.contentWindow?.postMessage({ __leafdeckLocate: m.nonce }, '*');
      } catch {}
    }
  });
  window.addEventListener('message', (e) => {
    const nonce = e.data?.__leafdeckHere;
    if (!nonce || nonce !== remote.locating || nonce !== remote.nonce) return;
    const frameEl = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source);
    if (!frameEl) return;
    remote.frameEl = frameEl;
    remote.view.show();
    placeRemote();
  });
  window.addEventListener('scroll', () => placeRemote(), true);
  window.addEventListener('resize', () => placeRemote());
} else {
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && AF.remote && e.data?.__leafdeckLocate === AF.nonce) window.parent.postMessage({ __leafdeckHere: AF.nonce }, '*');
  });
}

/* ---------- Filling ---------- */

function setField(el, value) {
  if (value == null || value === '') return false;
  if (el.tagName === 'SELECT') return selectOption(el, value);
  const max = el.maxLength > 0 ? el.maxLength : 0;
  setValue(el, max ? String(value).slice(0, max) : String(value));
  return true;
}

function selectOption(el, value) {
  const v = String(value).trim().toLowerCase();
  const variants = new Set([v]);
  for (const [abbr, name] of Object.entries(US_STATES)) {
    if (v === abbr.toLowerCase()) variants.add(name.toLowerCase());
    if (v === name.toLowerCase()) variants.add(abbr.toLowerCase());
  }
  for (const list of Object.values(COUNTRY_ALIASES)) if (list.includes(v)) list.forEach((x) => variants.add(x));
  if (/^\d+$/.test(v)) {
    variants.add(String(Number(v)));
    variants.add(v.padStart(2, '0'));
    if (v.length === 4) variants.add(v.slice(2));
  }
  const opt = [...el.options].find((o) => variants.has(o.value.trim().toLowerCase()) || variants.has(o.textContent.trim().toLowerCase()));
  if (!opt) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function fillLogin(field, { username, password }, generated) {
  const scope = field.form || document;
  const pws = passwordsIn(scope);
  if (generated) {
    // New password + its confirmation; never the "current password" box on a change-password form.
    for (const p of pws) if (isNewPassword(p) || pws.length === 1) setValue(p, password);
    field.focus();
    return;
  }
  const pw = field.type === 'password' ? field : pws.find((p) => !isNewPassword(p)) || pws[0];
  if (pw && password) setValue(pw, password);
  const user = field.type !== 'password' ? field : pw && usernameFor(pw);
  if (user && username) setValue(user, username);
  (pw || field).focus();
}

function addressValues(a) {
  const words = String(a.name || '').trim().split(/\s+/).filter(Boolean);
  const lines = String(a.street || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return {
    name: a.name, given: words.length > 1 ? words.slice(0, -1).join(' ') : words[0], family: words.length > 1 ? words[words.length - 1] : '',
    organization: a.organization, street: lines.join(', '), line1: lines[0], line2: lines.slice(1).join(', '),
    city: a.city, state: a.state, postal: a.postal, country: a.country, phone: a.phone, email: a.email,
  };
}

function cardValues(c) {
  const words = String(c.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name: c.name, given: words.slice(0, -1).join(' ') || words[0], family: words.length > 1 ? words[words.length - 1] : '',
    number: c.number, month: c.expMonth, year: c.expYear, yy: String(c.expYear || '').slice(-2),
  };
}

/**
 * Fill every recognized field of this kind in the same form (empty ones, plus the one you clicked).
 * `field` is null when another frame triggered the fill: then fill this whole document's empty fields.
 */
function fillFields(field, kind, values) {
  const scope = field ? fieldScope(field) : document;
  for (const el of scope.querySelectorAll('input, select')) {
    const info = classify(el);
    if (!info || info.kind !== kind || (el !== field && el.value && el.tagName !== 'SELECT')) continue;
    let v = values[info.part];
    if (kind === 'card' && info.part === 'csc') continue;
    if (kind === 'card' && info.part === 'exp') {
      // Follow the field's own hint ("MM / YY" vs "MM / YYYY"); otherwise its length limit.
      const ph = el.placeholder || el.getAttribute('aria-label') || '';
      const long = /yyyy/i.test(ph) || (!/yy/i.test(ph) && el.maxLength >= 7);
      v = values.month && values.year ? `${values.month}/${long ? values.year : values.yy}` : '';
    }
    if (kind === 'card' && info.part === 'year' && el.tagName !== 'SELECT' && (el.maxLength === 2 || /^yy$/i.test(el.placeholder || ''))) v = values.yy;
    if (kind === 'address' && info.part === 'state' && el.tagName !== 'SELECT' && el.maxLength === 2) {
      const abbr = Object.entries(US_STATES).find(([, n]) => n.toLowerCase() === String(v || '').toLowerCase())?.[0];
      if (abbr) v = abbr;
    }
    if (kind === 'address' && info.part === 'name' && !v) v = [values.given, values.family].filter(Boolean).join(' ');
    setField(el, v);
  }
  field?.focus();
}

/* ---------- Offer to save addresses and cards you type ---------- */

let lastForm = '';
function captureForms(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const address = {};
  const card = {};
  const parts = { line1: '', line2: '', given: '', family: '', cgiven: '', cfamily: '', exp: '' };
  for (const el of root.querySelectorAll('input, select')) {
    const value = (el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent : el.value)?.trim();
    if (!value) continue;
    const info = classify(el);
    if (!info || info.kind === 'login') continue;
    if (info.kind === 'address') {
      if (['line1', 'line2', 'given', 'family'].includes(info.part)) parts[info.part] = value;
      else if (info.part !== 'middle') address[info.part] ||= value;
    } else if (info.part === 'number') card.number = value;
    else if (info.part === 'name') card.name = value;
    else if (info.part === 'given') parts.cgiven = value;
    else if (info.part === 'family') parts.cfamily = value;
    else if (info.part === 'month') card.expMonth = value;
    else if (info.part === 'year') card.expYear = value;
    else if (info.part === 'exp') parts.exp = value;
  }
  address.street ||= [parts.line1, parts.line2].filter(Boolean).join('\n');
  address.name ||= [parts.given, parts.family].filter(Boolean).join(' ');
  card.name ||= [parts.cgiven, parts.cfamily].filter(Boolean).join(' ');
  const exp = parts.exp.match(/(\d{1,2})\s*\/?\s*(\d{2,4})/);
  if (exp) [card.expMonth, card.expYear] = [exp[1], exp[2]];
  const out = {};
  if (address.name && (address.street || address.postal)) out.address = address;
  if (String(card.number || '').replace(/\D/g, '').length >= 12) out.card = card;
  // What you typed into ordinary fields, to suggest next time (sensitive fields are skipped by entryKey).
  const entries = [];
  for (const el of root.querySelectorAll('input')) {
    const key = el.value && visible(el) && entryKey(el);
    if (key) entries.push({ key, value: el.value.trim() });
  }
  if (entries.length) out.entries = entries.slice(0, 40);
  if (!out.address && !out.card && !out.entries) return;
  const key = JSON.stringify(out);
  if (key === lastForm) return;
  lastForm = key;
  ipcRenderer.send('leafdeck:af-submitted', out);
}

/* ---------- Wiring ---------- */

// Another frame filled an address or card: fill the matching fields here too (see applyToOtherFrames).
ipcRenderer.on('leafdeck:af-apply', (_e, m) => {
  try {
    if (m?.kind === 'card') fillFields(null, 'card', cardValues(m.data || {}));
    else if (m?.kind === 'address') fillFields(null, 'address', addressValues(m.data || {}));
  } catch {}
});

const wantsMenu = (el) => el?.tagName === 'INPUT' && (classify(el) || entryKey(el));

// Open on a real click into a field (like Chrome), or with ↓ from the keyboard.
document.addEventListener(
  'mousedown',
  (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    if (AF.view && e.composedPath().includes(AF.view.host)) return;
    const el = e.target;
    if (wantsMenu(el)) setTimeout(() => document.activeElement === el && openMenu(el), 0);
    else closeMenu();
  },
  true,
);

// Addresses and remembered entries narrow down as you type; other menus get out of the way.
let typingTimer;
document.addEventListener(
  'input',
  (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    const key = entryKey(el);
    if (menuOpen() && AF.field === el && !key) closeMenu();
    if (!key) return;
    const info = classify(el);
    if (info && info.kind !== 'address') return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (document.activeElement !== el) return;
      if (!el.value) return closeMenu();
      openMenu(el);
    }, 120);
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (!e.isTrusted) return;
    if (!menuOpen()) {
      if (e.key === 'ArrowDown' && wantsMenu(e.target)) {
        e.preventDefault();
        openMenu(e.target);
      }
      return;
    }
    if (e.target !== AF.field) return closeMenu();
    const n = AF.items.length + (AF.footer ? 1 : 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      AF.sel = (AF.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      drawMenu();
    } else if (e.key === 'Enter') choose(AF.sel);
    else if (e.key === 'Escape') closeMenu();
    else if (e.key === 'Delete' && e.shiftKey && AF.items[AF.sel]?.kind === 'entry') {
      // Shift+Delete forgets a remembered entry, like Chrome.
      ipcRenderer.send('leafdeck:af-forget', { key: AF.info.key, value: AF.items[AF.sel].id, everywhere: AF.info.part === 'email' });
      AF.items.splice(AF.sel, 1);
      if (!AF.items.length) return closeMenu();
      AF.sel = Math.min(AF.sel, AF.items.length - 1);
      drawMenu();
    } else return; // typing: handled by the input listener
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
document.addEventListener('focusout', (e) => e.target === AF.field && setTimeout(() => document.activeElement !== AF.field && closeMenu(), 150), true);
window.addEventListener('scroll', () => menuOpen() && drawMenu(), true);
window.addEventListener('resize', () => menuOpen() && drawMenu());
window.addEventListener('blur', () => setTimeout(() => !document.hasFocus() && closeMenu(), 150));
