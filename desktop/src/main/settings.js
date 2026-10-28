const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const commands = require('./commands');

// Non-secret user preferences, stored as JSON in the app's userData folder.
// Secrets live elsewhere, encrypted with safeStorage: provider API keys in
// secrets.js.

const PROVIDER_IDS = ['gemini', 'groq', 'local'];

// Default shortcuts: adjacent keys, one hand. If one is taken on this PC,
// main.js falls back to the next free entry in HOTKEY_FALLBACKS.
const HOTKEY_FALLBACKS = {
  captureHotkey: ['Alt+Shift+S', 'Ctrl+Alt+S', 'Ctrl+Shift+Space'],
  selectionHotkey: ['Alt+Shift+A', 'Ctrl+Alt+A', 'Ctrl+Shift+X'],
};
// Defaults of earlier versions, migrated to the new ones on load.
const OLD_DEFAULT_HOTKEYS = new Set(['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+X']);

const DEFAULTS = {
  defaultModel: '',
  defaultAction: 'explain',
  localOnly: false,
  autoUpdate: true,
  launchAtLogin: true,
  ocrEnabled: true,
  maskOutside: true,
  maxTurns: 10,
  captureHotkey: HOTKEY_FALLBACKS.captureHotkey[0],
  selectionHotkey: HOTKEY_FALLBACKS.selectionHotkey[0],
  selectionBubble: true,
  // GPU acceleration costs ~100-150 MB for a GPU process; the UI is simple
  // enough to render in software at full speed. Takes effect after restart.
  hardwareAcceleration: false,
  // Model sources. `enabled` = shown in the model menu; `models` is the
  // user's chosen list: [{ id, vision, reasoning, latencyMs }].
  providers: {
    gemini: { enabled: true, models: [] },
    groq: { enabled: true, models: [] },
    local: { enabled: true, baseUrl: '', label: 'Local', models: [] },
  },
  commands: commands.DEFAULT_COMMANDS,
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
  cache.providers = { ...structuredClone(DEFAULTS.providers) };
  for (const [id, p] of Object.entries(saved.providers || {})) cache.providers[id] = { ...cache.providers[id], ...p };
  cache.commands = commands.clean(saved.commands ?? DEFAULTS.commands);
  // Migrations from earlier versions.
  // The cloud-backend source was removed: drop its leftovers so they are not rewritten forever.
  delete cache.backendUrl;
  delete cache.firebaseApiKey;
  delete cache.providers.cloud;
  if (String(cache.defaultModel).startsWith('cloud:')) cache.defaultModel = '';
  if ('clipboardHotkey' in saved) {
    if (!('selectionHotkey' in saved)) cache.selectionHotkey = saved.clipboardHotkey;
    delete cache.clipboardHotkey;
  }
  for (const key of ['captureHotkey', 'selectionHotkey']) {
    if (OLD_DEFAULT_HOTKEYS.has(cache[key])) cache[key] = DEFAULTS[key];
  }
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
  for (const id of PROVIDER_IDS) {
    if (typeof patch[id]?.enabled === 'boolean') next[id].enabled = patch[id].enabled;
  }
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
    if (key === 'providers' || key === 'commands' || !(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) continue;
    next[key] = value;
  }
  if (patch?.providers && typeof patch.providers === 'object') next.providers = cleanProviders(current.providers, patch.providers);
  if (Array.isArray(patch?.commands)) next.commands = commands.clean(patch.commands);
  for (const key of ['captureHotkey', 'selectionHotkey']) next[key] = String(next[key] || '').slice(0, 60);
  next.maxTurns = Math.min(50, Math.max(1, Math.round(next.maxTurns)));
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return get();
}

module.exports = { get, update, DEFAULTS, PROVIDER_IDS, HOTKEY_FALLBACKS, checkUrl };
