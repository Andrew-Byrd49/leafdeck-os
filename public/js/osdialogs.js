// The computer's questions in Leafdeck OS (electron/osdesktop.cjs): a program wants to do something that needs your
// permission (Access), or needs an administrator's password (polkit). Each one is a dialog over the whole screen; when
// the program gives up first, its dialog closes. (A program that wants a file gets the file picker in its own window:
// public/picker.html.)
import { shell } from './shell.js';
import { ask } from './dialogs.js';

const closers = new Map(); // request id -> close the dialog showing it
const shown = new Set();

async function handle(req) {
  if (shown.has(req.id)) return;
  shown.add(req.id);
  const app = req.app ? req.app.replace(/\.desktop$/, '') : '';
  try {
    if (req.kind === 'access') {
      const r = await ask({
        icon: 'shield',
        title: req.title || 'Allow access?',
        message: req.subtitle,
        detail: [req.body, app && `Asked by ${app}`].filter(Boolean).join('\n'),
        buttons: [{ label: req.deny, value: null }, { label: req.grant, value: 'allow', primary: true }],
        onMount: (api) => closers.set(req.id, () => api.close(null)),
      });
      await shell.os.desktopAnswer(req.id, { allow: r?.button === 'allow' });
    } else if (req.kind === 'auth') {
      // polkit's message names the command: "… to run `/usr/bin/foo --bar' as the super user". Claude's reason is only
      // Claude's words, so what will really run is always beside it.
      const command = /`(.*)'/s.exec(req.message || '')?.[1];
      const asClaude = !!req.claude;
      const r = await ask({
        icon: 'lock',
        title: asClaude ? 'Claude is asking for your administrator password' : 'Administrator password needed',
        message: asClaude
          ? req.claude.reason ? `Claude says: ${req.claude.reason}` : 'Claude didn’t say why. Check the command before you allow it.'
          : req.message || 'A program wants to make changes that need an administrator.',
        detail: asClaude ? (command ? '' : req.message) : req.program ? `Program: ${req.program}` : '',
        code: asClaude && command ? { label: 'This will run as administrator:', text: command } : null,
        fields: [{ name: 'password', type: 'password', label: req.me ? 'Your password' : `Password for ${req.user}`, autocomplete: 'current-password' }],
        buttons: [{ label: 'Cancel', value: null }, { label: 'Allow', value: 'ok', primary: true }],
        onMount: (api) => closers.set(req.id, () => api.close(null)),
        check: async (res, api) => {
          if (!res.values.password) return false;
          api.setError('');
          const out = await shell.os.desktopAuth(req.id, res.values.password);
          if (out.ok) return true;
          api.setError(out.error);
          const input = api.el.querySelector('input');
          input.value = '';
          input.focus();
          return false;
        },
      });
      if (!r) await shell.os.desktopAnswer(req.id, null);
    }
  } finally {
    closers.delete(req.id);
    shown.delete(req.id);
  }
}

if (shell?.platform === 'linux' && shell.os?.desktopPending) {
  shell.on('os:desktop-request', handle);
  shell.on('os:desktop-cancel', ({ id }) => closers.get(id)?.());
  // Questions asked while the UI was loading (sign-in, a reload).
  shell.os.desktopPending().then((list) => list.forEach(handle), () => {});
}
