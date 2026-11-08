/** Bridge to the Electron shell (electron/preload.cjs). `null` in a normal browser. */
export const shell = window.desktopShell?.isElectron ? window.desktopShell : null;
