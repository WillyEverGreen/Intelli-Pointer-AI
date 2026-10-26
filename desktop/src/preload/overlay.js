const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge for the selection overlay. No Node access leaks.
contextBridge.exposeInMainWorld('overlay', {
  onStart: (cb) => ipcRenderer.on('overlay:start', (_e, data) => cb(data)),
  onReset: (cb) => ipcRenderer.on('overlay:reset', () => cb()),
  ready: () => ipcRenderer.send('overlay:ready'),
  confirm: (payload) => ipcRenderer.send('overlay:confirm', payload),
  cancel: () => ipcRenderer.send('overlay:cancel'),
});
