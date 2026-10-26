const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ip', {
  getSettings: invoke('settings:get'),
  updateSettings: invoke('settings:update'),
  authStatus: invoke('auth:status'),
  signIn: invoke('auth:signIn'),
  signOut: invoke('auth:signOut'),
  listModels: invoke('models:list'),
  providerStatus: invoke('providers:status'),
  fetchProviderModels: invoke('providers:fetchModels'),
  saveProviders: invoke('providers:save'),
  speedTest: invoke('providers:speedTest'),
  usage: invoke('usage:get'),
  capture: invoke('capture:start'),
  ask: invoke('ask:start'),
  cancel: invoke('ask:cancel'),
  copy: invoke('clipboard:write'),
  pin: invoke('panel:pin'),
  resize: invoke('panel:resize'),
  hide: invoke('panel:hide'),
  openLatencyLog: invoke('open:latencyLog'),
  openDiagnostics: invoke('open:diagnostics'),
  onContext: (cb) => ipcRenderer.on('context:add', (_e, d) => cb(d)),
  onOcr: (cb) => ipcRenderer.on('context:ocr', (_e, d) => cb(d)),
  onAskEvent: (cb) => ipcRenderer.on('ask:event', (_e, d) => cb(d)),
});
