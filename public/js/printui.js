// Printing in Leafdeck's page (Linux): electron/printing.cjs asks for the print sheet (public/js/printsheet.js) when a
// page, a file or a PDF on screen is to be printed, and says here when it can't be.
import { toast } from './wm.js';
import { shell } from './shell.js';
import { printSheet } from './printsheet.js';
import { windowForWebContents } from './apps/browser.js';

async function openPrint({ id, webContentsId, title, document: asIs, error, notice }) {
  if (error) return void toast(error, 'error');
  if (notice) return void toast(notice);
  await printSheet({
    id,
    title,
    mode: asIs ? 'document' : 'page',
    win: webContentsId ? windowForWebContents(webContentsId) : null,
    notify: (text) => toast(text),
  });
  shell.print.done(id);
}

if (shell?.platform === 'linux') shell.on('shell:print', (req) => openPrint(req));
