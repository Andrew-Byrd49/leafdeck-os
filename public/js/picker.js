// The file picker's own window (public/picker.html, electron/osdesktop.cjs): Leafdeck's picker for one program's
// "Open…" or "Save…", or the print sheet for its "Print…", dressed like the desktop behind it and placed on its main screen.
import { pickFiles } from './filepicker.js';
import { printSheet } from './printsheet.js';

const bridge = window.leafdeckPicker;
const MODES = { 'open-file': 'open', 'save-file': 'save', 'save-files': 'save-files' };

async function run() {
  const [req, look] = await Promise.all([bridge.request(), bridge.look().catch(() => null)]);
  if (!req) return bridge.answer(null);
  if (look) {
    const root = document.documentElement;
    root.className = look.className;
    if (look.theme) root.dataset.theme = look.theme;
    for (const [k, v] of look.vars) root.style.setProperty(k, v);
  }
  if (req.kind === 'print-settings') {
    // GTK and Chromium ask with a title like "Print" or "&Print…", not the document's name.
    const print = await printSheet({ title: /^&?print(…|\.\.\.)?$/i.test(req.title || '') ? '' : req.title, mode: 'settings' });
    return bridge.answer(print ? { print } : null);
  }
  const r = await pickFiles({ ...req, mode: MODES[req.kind] || 'open' });
  await bridge.answer(r);
}

run().catch((e) => {
  console.error(e);
  bridge.answer(null);
});
