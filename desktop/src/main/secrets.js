const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

// Provider API keys entered by the user (Gemini, Groq, local server).
// Stored encrypted with Electron safeStorage (Windows DPAPI, bound to this
// Windows user) and kept in main-process memory only: renderers can learn
// whether a key is set and its last 4 characters, never the key itself.

const NAMES = ['gemini', 'groq', 'local'];
const file = () => path.join(app.getPath('userData'), 'provider-keys.bin');
let keys = {};
let available = false;

async function load() {
  available = await safeStorage.isAsyncEncryptionAvailable();
  if (!available || !fs.existsSync(file())) return;
  try {
    const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file()));
    keys = JSON.parse(result);
  } catch {
    keys = {}; // unreadable (e.g. copied from another Windows account)
  }
}

async function persist() {
  const present = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
  if (!Object.keys(present).length) {
    fs.rmSync(file(), { force: true });
    return;
  }
  fs.writeFileSync(file(), await safeStorage.encryptStringAsync(JSON.stringify(present)));
}

function get(name) {
  return keys[name] || '';
}

// value: string to store, '' to remove.
async function set(name, value) {
  if (!NAMES.includes(name)) throw new Error(`Unknown key ${name}`);
  const v = String(value || '').trim();
  if (v.length > 400 || /\s/.test(v)) throw new Error('That does not look like an API key.');
  if (v && !available) throw new Error('Windows secure storage is unavailable, so the key cannot be saved safely.');
  keys[name] = v;
  await persist();
}

function status() {
  return Object.fromEntries(NAMES.map((n) => [n, { set: Boolean(keys[n]), hint: keys[n] ? `…${keys[n].slice(-4)}` : '' }]));
}

module.exports = { load, get, set, status };
