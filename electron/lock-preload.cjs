// The lock screen's only bridge to Leafdeck: who's signed in, try a password, restart or shut down. The sign-in screen
// (electron/greeter.cjs) uses the same page and bridge; there, unlock signs in as `user`, in safe mode when `safe`.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leafdeckLock', {
  info: () => ipcRenderer.invoke('lock:info'),
  unlock: (password, user, safe) => ipcRenderer.invoke('lock:unlock', String(password || ''), user ? String(user) : undefined, safe === true),
  power: (action) => ipcRenderer.invoke('lock:power', action),
});
