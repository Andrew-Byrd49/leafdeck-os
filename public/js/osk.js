// Leafdeck OS on-screen keyboard: for touch screens, or when the Bluetooth keyboard isn't with you. It comes up when you
// tap a text field (in Leafdeck or in a site), or from the keyboard button in the menu bar. Keys never take focus; each
// one is typed into whatever has it by the main process (os:key in electron/main.cjs), so sites and the terminal get
// ordinary key presses. On stacked screens (both panels of a Yoga Book 9) it fills the lower half of the second screen,
// like the keyboard Lenovo shows there; otherwise it sits at the bottom of the screen.
import { shell } from './shell.js';
import { screens, setKeyboardArea, dockScreen } from './wm.js';

const LAYERS = {
  abc: ['qwertyuiop', 'asdfghjkl', ['shift', ...'zxcvbnm', 'back'], ['sym', ',', 'space', '.', 'enter']],
  sym: ['1234567890', '-/:;()$&@"', ['more', ...".,?!'_", 'back'], ['abc', ',', 'space', '.', 'enter']],
  more: ['[]{}#%^*+=', '\\|~<>€£¥•`', ['sym', ...".,?!'", 'back'], ['abc', ',', 'space', '.', 'enter']],
};
// The top row is always there: what a terminal and text editing need.
const TOP = ['esc', 'tab', 'ctrl', 'alt', 'left', 'up', 'down', 'right', 'hide'];
const LABEL = {
  shift: '⇧', back: '⌫', sym: '123', more: '#+=', abc: 'ABC', space: '', enter: '⏎',
  esc: 'Esc', tab: 'Tab', ctrl: 'Ctrl', alt: 'Alt', left: '←', up: '↑', down: '↓', right: '→', hide: '⌄',
};
const NAMES = { shift: 'Shift', back: 'Backspace', sym: 'Numbers and symbols', more: 'More symbols', abc: 'Letters', space: 'Space', enter: 'Enter', hide: 'Hide keyboard' };
const SPECIAL = { back: 'Backspace', enter: 'Enter', esc: 'Escape', tab: 'Tab', left: 'Left', right: 'Right', up: 'Up', down: 'Down' };

let kb = null;
let layer = 'abc';
let shift = false; // one letter; a second tap locks it (caps)
let caps = false;
const mods = new Set(); // ctrl / alt, for the next key
// A tap on the keyboard takes focus from a site (Leafdeck's page gets it), so the site that last had it is remembered;
// the main process gives focus back to it with each key. Webviews get no focus events, so it's checked a few times a
// second (reading document.activeElement costs nothing).
let lastSite = null;
function noteFocus() {
  const a = document.activeElement;
  if (a?.tagName === 'WEBVIEW') lastSite = a;
  else if (a && a !== document.body) lastSite = null; // a field in Leafdeck itself
}

const h = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function draw() {
  const key = (k) => {
    const special = k.length > 1;
    const upper = shift || caps;
    const text = special ? LABEL[k] : upper ? k.toUpperCase() : k;
    const on = (k === 'shift' && (shift || caps)) || ((k === 'ctrl' || k === 'alt') && mods.has(k === 'ctrl' ? 'control' : 'alt'));
    return `<button type="button" tabindex="-1" class="osk-key${special ? ` osk-${k}` : ''}${on ? ' on' : ''}${k === 'shift' && caps ? ' caps' : ''}" data-k="${h(k)}"${special ? ` aria-label="${h(NAMES[k] || LABEL[k])}"` : ''}>${h(text)}</button>`;
  };
  kb.innerHTML = [TOP, ...LAYERS[layer]].map((row, i) => `<div class="osk-row${i === 0 ? ' osk-top' : ''}">${[...row].map(key).join('')}</div>`).join('');
}

/** Where it goes: the lower half of a built-in screen that sits below another one (a Yoga Book 9's bottom panel), the
 * way Lenovo shows its keyboard there; else the bottom of the main screen. */
function place() {
  const all = screens();
  const n = all.findIndex((s, i) => i > 0 && s.internal && all.some((t) => t !== s && Math.abs(t.y + t.h - s.y) < 4 && t.x < s.x + s.w && s.x < t.x + t.w));
  const two = n > 0;
  const s = all[two ? n : 0];
  const height = Math.round(two ? Math.min(s.h * 0.55, 520) : Math.min(s.h * 0.4, 330));
  Object.assign(kb.style, { left: `${s.x}px`, width: `${s.w}px`, top: `${s.y + s.h - height}px`, height: `${height}px` });
  kb.classList.toggle('osk-own-screen', two);
  // On the Dock's screen it covers the Dock. Maximized windows on its screen fit above it.
  document.body.classList.toggle('osk-open', !kb.hidden && (two ? n : 0) === dockScreen());
  setKeyboardArea(kb.hidden ? null : { screen: two ? n : 0, height });
}

export function showKeyboard(on = true) {
  if (!kb) return;
  if (on && !kb.hidden) return;
  kb.hidden = !on;
  layer = 'abc';
  shift = caps = false;
  mods.clear();
  if (on) {
    draw();
    place();
  }
  if (!on) {
    document.body.classList.remove('osk-open');
    setKeyboardArea(null);
  }
  dispatchEvent(new CustomEvent('osk', { detail: { open: on } }));
}
export const toggleKeyboard = () => showKeyboard(!!kb?.hidden);
export const keyboardOpen = () => !!kb && !kb.hidden;

function press(k) {
  if (k === 'hide') return showKeyboard(false);
  if (k === 'shift') {
    if (caps) caps = shift = false;
    else if (shift) (caps = true), (shift = false);
    else shift = true;
    return draw();
  }
  if (k === 'sym' || k === 'more' || k === 'abc') {
    layer = k;
    shift = false;
    return draw();
  }
  if (k === 'ctrl' || k === 'alt') {
    const m = k === 'ctrl' ? 'control' : 'alt';
    mods.has(m) ? mods.delete(m) : mods.add(m);
    return draw();
  }
  const active = document.activeElement;
  const site = active?.tagName === 'WEBVIEW' ? active : active === document.body && lastSite?.isConnected ? lastSite : null;
  const target = typeof site?.getWebContentsId === 'function' ? site.getWebContentsId() : null;
  const m = [...mods];
  if (SPECIAL[k]) shell.os.key(target, { key: SPECIAL[k], mods: m });
  else if (k === 'space') shell.os.key(target, { text: ' ' });
  else if (m.length && /^[a-z0-9]$/i.test(k)) shell.os.key(target, { key: k, mods: m });
  else shell.os.key(target, { text: shift || caps ? k.toUpperCase() : k });
  const redraw = shift || mods.size;
  shift = false;
  mods.clear();
  if (redraw) draw();
}

/** Called once in the Leafdeck OS session. */
export function initKeyboard() {
  if (kb || !shell?.os?.key) return;
  kb = document.createElement('div');
  kb.className = 'osk';
  kb.hidden = true;
  kb.setAttribute('role', 'group');
  kb.setAttribute('aria-label', 'On-screen keyboard');
  document.body.append(kb);
  // Keys don't take focus (that would take it from the text field), and repeat while held: Backspace, arrows.
  let repeat = 0;
  const stop = () => clearTimeout(repeat);
  kb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    b.classList.add('down');
    press(k);
    if (['back', 'left', 'right', 'up', 'down', 'space'].includes(k)) {
      const again = (ms) => (repeat = setTimeout(() => (press(k), again(60)), ms));
      again(450);
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    kb.addEventListener(ev, (e) => {
      stop();
      e.target.closest?.('[data-k]')?.classList.remove('down');
    });
  }
  kb.addEventListener('mousedown', (e) => e.preventDefault());
  // Tapping a text field in Leafdeck brings it up; sites ask through the main process (os:osk).
  let touchedAt = 0;
  addEventListener('pointerdown', (e) => e.pointerType === 'touch' && !kb.contains(e.target) && (touchedAt = Date.now()), true);
  addEventListener('focusin', (e) => {
    const t = e.target;
    const editable = t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(t.type));
    if (editable && Date.now() - touchedAt < 1000) showKeyboard(true);
  }, true);
  setInterval(noteFocus, 200);
  // A site's text field was tapped: that site gets the keys.
  shell.on('os:osk', ({ show, site }) => {
    const w = site && [...document.querySelectorAll('webview')].find((v) => v.getWebContentsId?.() === site);
    if (w) lastSite = w;
    showKeyboard(show !== false);
  });
  for (const ev of ['resize', 'screens']) addEventListener(ev, () => !kb.hidden && place());
}
