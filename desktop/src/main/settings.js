const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Non-secret user preferences, stored as JSON in the app's userData folder.
// Secrets live elsewhere, encrypted with safeStorage: the Firebase refresh
// token in auth.js and provider API keys in secrets.js.

const PROVIDER_IDS = ['gemini', 'groq', 'local'];

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
  // Model sources. `models` is the user's chosen list: [{ id, vision }].
  providers: {
    cloud: { enabled: true },
    gemini: { models: [] },
    groq: { models: [] },
    local: { baseUrl: '', label: 'Local', models: [] },
  },
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    /* first run */
  }
  cache = { ...structuredClone(DEFAULTS), ...saved };
  cache.providers = { ...structuredClone(DEFAULTS.providers), ...(saved.providers || {}) };
  return cache;
}

function get() {
  return structuredClone(load());
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const isPrivateHost = (h) => LOOPBACK.has(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith('.local');

// Throws unless the URL is HTTPS, or plain HTTP to this PC (or, if allowLan, the local network).
function checkUrl(value, what, { allowLan = false } = {}) {
  const url = new URL(value); // throws on garbage
  const plainOk = url.protocol === 'http:' && (allowLan ? isPrivateHost(url.hostname) : LOOPBACK.has(url.hostname));
  if (url.protocol !== 'https:' && !plainOk) {
    throw new Error(`${what} must use HTTPS (plain HTTP is only allowed for ${allowLan ? 'this PC or your local network' : 'localhost'}).`);
  }
  return url;
}

function cleanModels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((m) => m && typeof m.id === 'string' && m.id.length <= 200 && !seen.has(m.id) && seen.add(m.id))
    .slice(0, 300)
    .map((m) => ({
      id: m.id,
      vision: m.vision === true,
      reasoning: m.reasoning === true,
      // Last measured time to first token ("Test speed"), or null.
      latencyMs: Number.isFinite(m.latencyMs) && m.latencyMs > 0 && m.latencyMs < 600000 ? Math.round(m.latencyMs) : null,
    }));
}

function cleanProviders(current, patch) {
  const next = structuredClone(current);
  if (patch.cloud && typeof patch.cloud.enabled === 'boolean') next.cloud.enabled = patch.cloud.enabled;
  for (const id of PROVIDER_IDS) {
    if (patch[id]?.models !== undefined) next[id].models = cleanModels(patch[id].models);
  }
  if (patch.local) {
    if (typeof patch.local.baseUrl === 'string') {
      const raw = patch.local.baseUrl.trim();
      next.local.baseUrl = raw ? checkUrl(raw, 'Local server URL', { allowLan: true }).href.replace(/\/+$/, '') : '';
    }
    if (typeof patch.local.label === 'string') next.local.label = patch.local.label.trim().slice(0, 40) || 'Local';
  }
  return next;
}

// Only known keys with the right type are accepted from the renderer.
function update(patch) {
  const current = load();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'providers' || !(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) continue;
    next[key] = value;
  }
  if (patch?.providers && typeof patch.providers === 'object') next.providers = cleanProviders(current.providers, patch.providers);
  if (next.backendUrl) next.backendUrl = checkUrl(next.backendUrl, 'Backend URL').origin;
  next.maxTurns = Math.min(50, Math.max(1, Math.round(next.maxTurns)));
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return get();
}

module.exports = { get, update, DEFAULTS, PROVIDER_IDS, checkUrl };
