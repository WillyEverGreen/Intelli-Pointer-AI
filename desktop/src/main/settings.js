const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Non-secret user preferences, stored as JSON in the app's userData folder.
// Secrets (the Firebase refresh token) live in auth.js, encrypted with safeStorage.

const DEFAULTS = {
  backendUrl: 'http://127.0.0.1:8080',
  firebaseApiKey: '',
  defaultModel: '',
  defaultAction: 'explain',
  localOnly: false,
  ocrEnabled: true,
  maskOutside: true,
  maxTurns: 10,
  captureHotkey: 'CommandOrControl+Shift+Space',
  clipboardHotkey: 'CommandOrControl+Shift+X',
  selectionBubble: true,
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get() {
  return { ...load() };
}

// Only known keys with the right type are accepted from the renderer.
function update(patch) {
  const current = load();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) continue;
    next[key] = value;
  }
  if (next.backendUrl) {
    const url = new URL(next.backendUrl); // throws on garbage
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('Backend URL must use HTTPS (plain HTTP is only allowed for localhost).');
    }
    next.backendUrl = url.origin;
  }
  next.maxTurns = Math.min(50, Math.max(1, Math.round(next.maxTurns)));
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return get();
}

module.exports = { get, update, DEFAULTS };
