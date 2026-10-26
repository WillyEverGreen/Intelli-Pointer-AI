const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge for the selection overlay. No Node access leaks.
contextBridge.exposeInMainWorld('overlay', {
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, data) => cb(data)),
  onFrame: (cb) => ipcRenderer.on('overlay:frame', (_e, data) => cb(data)),
  onReset: (cb) => ipcRenderer.on('overlay:reset', () => cb()),
  shown: () => ipcRenderer.send('overlay:shown'),
  confirm: (payload) => ipcRenderer.send('overlay:confirm', payload),
  cancel: () => ipcRenderer.send('overlay:cancel'),
});
