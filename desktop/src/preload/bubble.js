const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onShow: (cb) => ipcRenderer.on('bubble:show', (_e, d) => cb(d)),
  act: (actionId) => ipcRenderer.send('bubble:action', actionId),
  close: () => ipcRenderer.send('bubble:close'),
  hover: (inside) => ipcRenderer.send('bubble:hover', inside),
  resize: (width, height) => ipcRenderer.send('bubble:resize', width, height),
});
