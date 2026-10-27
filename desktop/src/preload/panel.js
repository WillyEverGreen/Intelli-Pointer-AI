const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ip', {
  getSettings: invoke('settings:get'),
  updateSettings: invoke('settings:update'),
  listModels: invoke('models:list'),
  providerStatus: invoke('providers:status'),
  fetchProviderModels: invoke('providers:fetchModels'),
  saveProviders: invoke('providers:save'),
  speedTest: invoke('providers:speedTest'),
  checkHotkey: invoke('hotkeys:check'),
  onOpenSettings: (cb) => ipcRenderer.on('panel:open-settings', () => cb()),
  updateStatus: invoke('update:status'),
  checkForUpdates: invoke('update:check'),
  installUpdate: invoke('update:install'),
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
