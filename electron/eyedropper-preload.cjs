// The eyedropper windows' only bridge (electron/eyedropper.cjs): this screen's picture, and the color picked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leafdeckEyedropper', {
  image: () => ipcRenderer.invoke('eyedropper:image'),
  done: (color) => ipcRenderer.send('eyedropper:done', typeof color === 'string' ? color : null),
});
