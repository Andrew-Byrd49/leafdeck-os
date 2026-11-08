// The rescue screen's only bridge to Leafdeck (electron/rescue.cjs): what's running, and what to do about it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leafdeckRescue', {
  info: () => ipcRenderer.invoke('rescue:info'),
  act: (action, webContentsId) => ipcRenderer.invoke('rescue:act', String(action), webContentsId == null ? undefined : Number(webContentsId)),
});
