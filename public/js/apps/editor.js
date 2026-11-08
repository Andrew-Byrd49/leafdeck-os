// Text Editor: plain text on this computer (Linux and Leafdeck OS): Markdown, notes, config files, code. One file at a
// time in a plain monospace text area; Ctrl+S saves it in place, Ctrl+O opens another (the file picker). Files opens
// text and code here on a double-click. A • in the title means unsaved changes, and closing or opening another file
// asks first. Tab types two spaces; nothing else is clever on purpose.
import { $ } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, toast, forgetOnNewBoot } from '../wm.js';
import { shell } from '../shell.js';
import { ask } from '../dialogs.js';
import { pickFiles } from '../filepicker.js';

const supported = !!shell?.files?.writeText && shell.platform === 'linux';
const MAX = 16 * 1024 * 1024; // larger than this isn't "a text file to edit"
const LAST = 'editor:last'; // the file to open again after restarting Leafdeck
forgetOnNewBoot(LAST);
const base = (p) => p.split('/').pop();
const errText = (x) => String(x?.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const remember = (p) => {
  try {
    if (p) localStorage.setItem(LAST, p);
    else localStorage.removeItem(LAST);
  } catch {}
};
const last = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};

let pending = null; // the file for a new window (openApp('editor', { file }))

registerApp({
  id: 'editor',
  name: 'Text Editor',
  icon: 'text-file',
  color: 'teal',
  size: [820, 640],
  min: [360, 240],
  hidden: !supported,
  launch(opts) {
    pending = typeof opts?.file === 'string' ? opts.file : null;
  },
  openFile(win, file) {
    win.editor?.open(String(file));
  },
  canClose(win) {
    return win.editor ? win.editor.settle() : true;
  },
  mount(win) {
    if (!supported) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Text Editor runs on Leafdeck OS</div>
        <p>It edits text files on this computer, which needs Linux.</p></div>`;
      return;
    }
    win.body.innerHTML = `<div class="te">
        <textarea class="te-text" spellcheck="false" autocapitalize="off" autocomplete="off" hidden></textarea>
        <div class="te-empty empty"><div class="empty-title">No file open</div>
          <p>Open a text file here, or double-click one in Files.</p>
          <button class="btn" data-te="open">Open…</button></div>
      </div>`;
    win.tools.innerHTML = `<span class="te-status muted"></span>
      <button class="tb-btn" data-te="open" title="Open (Ctrl+O)">${icon('folder', 15)}</button>
      <button class="tb-btn" data-te="save" title="Save (Ctrl+S)" disabled>${icon('download', 15)}</button>`;
    const text = $('.te-text', win.body);
    const empty = $('.te-empty', win.body);
    const status = $('.te-status', win.tools);
    const saveBtn = $('[data-te="save"]', win.tools);

    let file = null;
    let saved = ''; // the text as it is on disk
    const dirty = () => file != null && text.value !== saved;

    function draw() {
      win.setTitle(file ? `${dirty() ? '• ' : ''}${base(file)}` : 'Text Editor');
      saveBtn.disabled = !dirty();
      status.textContent = file ? (dirty() ? 'Edited' : '') : '';
      status.title = file || '';
    }

    async function save() {
      if (!file) return false;
      try {
        const value = text.value;
        await shell.files.writeText(file, value);
        saved = value;
        draw();
        return true;
      } catch (x) {
        toast(`Couldn’t save ${base(file)}: ${errText(x)}`, 'error');
        return false;
      }
    }

    /** Unsaved changes: save them, throw them away, or stay. Resolves true when it's fine to move on. */
    async function settle() {
      if (!dirty()) return true;
      const r = await ask({
        win,
        title: `Save changes to ${base(file)}?`,
        message: 'Your changes are lost if you don’t save them.',
        buttons: [
          { label: 'Don’t Save', value: 'discard', danger: true },
          { label: 'Cancel', value: null },
          { label: 'Save', value: 'save', primary: true },
        ],
      });
      if (r?.button === 'save') return save();
      return r?.button === 'discard';
    }

    async function open(p) {
      if (!p || p === file) return;
      if (!(await settle())) return;
      let r;
      try {
        r = await shell.files.readText(p, MAX + 1);
      } catch (x) {
        toast(`Couldn’t open ${base(p)}: ${errText(x)}`, 'error');
        if (p === last()) remember(null);
        return;
      }
      if (r.binary) return toast(`${base(p)} isn’t a text file.`, 'error');
      if (r.truncated) return toast(`${base(p)} is too large to edit here.`, 'error');
      file = p;
      saved = text.value = r.text;
      text.hidden = false;
      empty.hidden = true;
      text.setSelectionRange(0, 0);
      text.scrollTop = 0;
      text.focus();
      remember(p);
      draw();
    }

    async function choose() {
      const r = await pickFiles({ mode: 'open', title: 'Open', folder: file ? file.replace(/\/[^/]+$/, '') : undefined });
      if (r?.paths?.[0]) open(r.paths[0]);
    }

    text.addEventListener('input', draw);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  '); // keeps undo
      }
    });
    win.body.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        save();
      } else if (k === 'o') {
        e.preventDefault();
        choose();
      }
    });
    const act = (e) => {
      const a = e.target.closest('[data-te]')?.dataset.te;
      if (a === 'open') choose();
      else if (a === 'save') save();
    };
    win.body.addEventListener('click', act);
    win.tools.addEventListener('click', act);

    win.editor = { open, settle };
    win.print = {
      can: () => file != null,
      async run() {
        if (!(await settle())) return; // what prints is the file: changes are saved first, or left out
        const problem = await shell.print.file(file).catch((x) => x.message);
        if (problem) toast(problem, 'error');
      },
    };
    draw();
    const first = pending || last();
    pending = null;
    if (first) open(first);
  },
});
