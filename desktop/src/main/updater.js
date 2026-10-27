const { app, Notification } = require('electron');
const settings = require('./settings');
const { log } = require('./log');

// Automatic updates from GitHub Releases (electron-updater). The installed app
// checks shortly after start and every few hours, downloads a newer release in
// the background, and installs it when the app quits or the user chooses
// "Restart to update". Only installed builds update: running from source or a
// portable folder does nothing.

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let onChange = () => {};
let state = { status: 'idle', version: null, percent: 0, message: '' };

function set(patch) {
  state = { ...state, ...patch };
  onChange(state);
}

function getState() {
  return { ...state, supported: Boolean(autoUpdater), current: app.getVersion() };
}

function init({ onStateChange } = {}) {
  if (onStateChange) onChange = onStateChange;
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('update.unavailable', { error: err.message });
    return;
  }
  autoUpdater.autoDownload = false; // decided per check, so the setting can be switched off
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: () => {}, warn: (m) => log('update.warn', { message: String(m) }), error: (m) => log('update.error', { message: String(m) }), debug: () => {} };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', message: 'You have the latest version.' }));
  autoUpdater.on('update-available', (info) => {
    log('update.available', { version: info.version });
    set({ status: 'downloading', version: info.version, percent: 0, message: `Downloading ${info.version}…` });
    autoUpdater.downloadUpdate().catch((err) => fail(err));
  });
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    log('update.downloaded', { version: info.version });
    set({ status: 'ready', version: info.version, percent: 100, message: `Version ${info.version} is ready. It installs when you quit, or restart now.` });
    new Notification({ title: 'IntelliPointer update ready', body: `Version ${info.version} installs when you quit the app, or choose "Restart to update" in the tray menu.` }).show();
  });
  autoUpdater.on('error', (err) => fail(err));

  setTimeout(() => check(), FIRST_CHECK_MS).unref();
  setInterval(() => check(), CHECK_EVERY_MS).unref();
}

function fail(err) {
  log('update.error', { error: err.message });
  set({ status: 'error', message: 'Could not check for updates. Try again later.' });
}

// Background checks respect the "update automatically" setting; a manual
// check (the Settings button) always runs and downloads what it finds.
async function check({ manual = false } = {}) {
  if (!autoUpdater) return getState();
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return getState();
  if (!manual && !settings.get().autoUpdate) return getState();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    fail(err);
  }
  return getState();
}

function installNow() {
  if (!autoUpdater || state.status !== 'ready') return false;
  app.isQuitting = true; // let the windows close instead of hiding to the tray
  autoUpdater.quitAndInstall(false, true);
  return true;
}

module.exports = { init, check, installNow, getState };
