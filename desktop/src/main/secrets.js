const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { log } = require('./log');

// Provider API keys entered by the user (Gemini, Groq, local server).
//
// Stored encrypted with Windows DPAPI for the current Windows user, so they
// survive restarts, updates and reinstalls, and only this user on this PC can
// decrypt them. Kept in main-process memory after loading: renderers can learn
// whether a key is set and its last 4 characters, never the key itself.
//
// DPAPI is called through PowerShell (System.Security.Cryptography.ProtectedData)
// instead of Electron's safeStorage: its async API keeps its encryption key in
// memory only, so keys saved by one run could not be read by the next.

const NAMES = ['gemini', 'groq', 'local'];
const ENTROPY = 'IntelliPointer.provider-keys.v1';
const file = () => path.join(app.getPath('userData'), 'provider-keys.dpapi');
const legacyFile = () => path.join(app.getPath('userData'), 'provider-keys.bin');

let keys = {};
let loading = null;
let problem = '';

// protect | unprotect a base64 payload. The secret travels over stdin, never the command line.
function dpapi(mode, inputB64) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd().Trim()',
    `$e = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    '$s = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$b = [Convert]::FromBase64String($in)',
    mode === 'protect'
      ? '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $e, $s)))'
      : '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $e, $s)))',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error('Windows encryption timed out')); }, 20000);
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(err.trim().split(/\r?\n/)[0] || `exit ${code}`));
    });
    ps.stdin.end(inputB64);
  });
}

async function doLoad() {
  keys = {};
  problem = '';
  if (fs.existsSync(file())) {
    try {
      const json = Buffer.from(await dpapi('unprotect', fs.readFileSync(file(), 'utf8').trim()), 'base64').toString('utf8');
      keys = JSON.parse(json);
    } catch (err) {
      // Unreadable (for example copied from another Windows account). Keep the file, tell the user.
      problem = 'Saved API keys could not be read on this Windows account. Enter them again.';
      log('secrets.unreadable', { error: err.message });
    }
  }
  // An earlier version used Electron safeStorage, which could not be read back after a restart.
  if (fs.existsSync(legacyFile())) fs.rmSync(legacyFile(), { force: true });
}

// Safe to call more than once; everything that needs keys waits on whenLoaded().
function load() {
  if (!loading) loading = doLoad();
  return loading;
}
const whenLoaded = () => load();

async function persist() {
  const present = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
  if (!Object.keys(present).length) {
    fs.rmSync(file(), { force: true });
    return;
  }
  const blob = await dpapi('protect', Buffer.from(JSON.stringify(present), 'utf8').toString('base64'));
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), blob);
}

function get(name) {
  return keys[name] || '';
}

// value: string to store, '' to remove.
async function set(name, value) {
  if (!NAMES.includes(name)) throw new Error(`Unknown key ${name}`);
  await whenLoaded();
  const v = String(value || '').trim();
  if (v.length > 400 || /\s/.test(v)) throw new Error('That does not look like an API key.');
  keys[name] = v;
  problem = '';
  await persist();
}

function status() {
  return Object.fromEntries(NAMES.map((n) => [n, { set: Boolean(keys[n]), hint: keys[n] ? `…${keys[n].slice(-4)}` : '' }]));
}

module.exports = { load, whenLoaded, get, set, status, problem: () => problem };
