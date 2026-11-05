// The only things Reality's window gets from the desktop shell: the system's own
// folder explorer, and the startup progress while the app readies the machine.
// Everything else stays the web app, isolated as in the browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** Opens the folder explorer; resolves with the chosen path, or null on cancel. */
  chooseFolder: () => ipcRenderer.invoke('desktop:choose-folder'),
  /** Shows a folder in the system's file manager. */
  openPath: (target) => ipcRenderer.invoke('desktop:open-path', target),
  /** Lines of the startup chain, for the window's own "Reality starts…" page. */
  onBootLog: (show) => ipcRenderer.on('desktop:boot', (_event, line) => show(line)),
});
