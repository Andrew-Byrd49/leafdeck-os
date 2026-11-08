// The file picker window's only bridge (electron/osdesktop.cjs): the request it shows, the folders it browses or the
// printers it offers, and the answer. `desktopShell` carries just what public/js/filepicker.js, printsheet.js and
// dialogs.js use from Leafdeck's own bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  isElectron: true,
  platform: process.platform,
  files: {
    places: () => ipcRenderer.invoke('picker:places'),
    list: (dir) => ipcRenderer.invoke('picker:list', String(dir ?? '')),
    mkdir: (dir, name) => ipcRenderer.invoke('picker:mkdir', String(dir), name == null ? undefined : String(name)),
  },
  print: {
    printers: () => ipcRenderer.invoke('picker:printers'),
    options: (printer) => ipcRenderer.invoke('picker:printer-options', String(printer ?? '')),
    papers: () => ipcRenderer.invoke('picker:papers'),
  },
});

contextBridge.exposeInMainWorld('leafdeckPicker', {
  request: () => ipcRenderer.invoke('picker:request'),
  look: () => ipcRenderer.invoke('picker:look'),
  answer: (result) => ipcRenderer.invoke('picker:answer', result ?? null),
});
