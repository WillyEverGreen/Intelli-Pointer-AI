const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { clipboard } = require('electron');
const { log } = require('./log');
const clip = require('./clipboard');

// Bridge to the native helper (native/selection-helper.cs, which documents
// the protocol). Runs the compiled IntelliPointerHelper.exe when available;
// falls back to compiling the same source in PowerShell.
// Emits:
//   'selection' { text, x, y }  user finished selecting text in another app (physical px)
//   'down'      { x, y }        left mouse button pressed anywhere (physical px)

const events = new EventEmitter();
let child = null;
let ready = false;
let restarts = 0;
let watching = true;
let stopping = false;
let nextId = 1;
let startedAt = 0;
const waiters = new Map(); // id -> { resolve, timer }
let lastSelection = { text: '', at: 0 }; // most recent mouse selection seen by the hook

// Returns [command, args, kind] for the best available helper.
function helperCommand() {
  const ps = (script) => [
    // ExecutionPolicy Bypass applies to this one child process only; no system setting changes.
    'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(process.pid)], 'powershell',
  ];
  // Tests substitute a stand-in that speaks the same protocol (no mouse hook).
  if (process.env.IP_SELECTION_HELPER_TEST) return ps(process.env.IP_SELECTION_HELPER_TEST);
  // Installed app: the exe is built by scripts/install-app.mjs.
  const shipped = path.join(__dirname, 'native', 'IntelliPointerHelper.exe');
  if (require('node:fs').existsSync(shipped)) return [shipped, [String(process.pid)], 'exe'];
  // Running from source: compile once and cache.
  try {
    return [require('../../scripts/build-helper').ensureCached(), [String(process.pid)], 'exe'];
  } catch (err) {
    log('helper.build_error', { error: err.message.slice(0, 300) });
  }
  return ps(path.join(__dirname, 'native', 'selection-helper.ps1'));
}

function start() {
  if (process.platform !== 'win32' || child) return;
  startedAt = Date.now();
  const [command, args, kind] = helperCommand();
  // Automated tests run the real helper without its system-wide mouse hook.
  if (process.env.IP_HELPER_NO_HOOK === '1' && kind === 'exe') args.push('--no-hook');
  log('helper.start', { kind });
  child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Lines can be large (a screenshot is ~11 MB of base64), so split on raw
  // bytes and only ever scan each new chunk once.
  let pending = [];
  child.stdout.on('data', (chunk) => {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      pending.push(chunk.subarray(start, nl));
      const line = (pending.length === 1 ? pending[0] : Buffer.concat(pending)).toString('utf8').trim();
      pending = [];
      start = nl + 1;
      handleLine(line);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  function handleLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      ready = true;
      restarts = 0;
      log('helper.ready', { ms: Date.now() - startedAt });
      send(`watch ${watching ? 1 : 0}`);
    } else if (msg.type === 'selection') {
      lastSelection = { text: msg.text, at: Date.now() };
      events.emit('selection', msg);
    } else if (msg.type === 'down') {
      events.emit('down', msg);
    } else if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id);
      waiters.delete(msg.id);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => log('helper.stderr', { text: String(d).trim().slice(0, 500) }));
  child.on('error', (err) => log('helper.spawn_error', { error: err.message }));
  child.on('exit', (code) => {
    log('helper.exit', { code, wasReady: ready });
    child = null;
    ready = false;
    for (const w of waiters.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    waiters.clear();
    if (restarts < 3 && !stopping) {
      restarts += 1;
      setTimeout(start, 2000 * restarts);
    }
  });
}

function stop() {
  stopping = true;
  if (child) {
    send('exit');
    setTimeout(() => child?.kill(), 500);
  }
}

function send(line) {
  if (child && ready) child.stdin.write(`${line}\n`);
}

// Sends "<name> <id> [args...]" and resolves with the matching reply, or null on timeout.
function request(cmd, timeoutMs) {
  if (!child || !ready) return Promise.resolve(null);
  const id = String(nextId++);
  const [name, ...args] = cmd.split(' ');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      resolve(null);
    }, timeoutMs);
    waiters.set(id, { resolve, timer });
    send([name, id, ...args].join(' '));
  });
}

function setWatching(on) {
  watching = Boolean(on);
  send(`watch ${watching ? 1 : 0}`);
}

// Selected text via UI Automation (no keystrokes, clipboard untouched).
async function readViaAutomation() {
  const res = await request('getsel', 700);
  return { text: (res?.text || '').trim(), ms: res?.ms ?? null, timedOut: res === null };
}

// Fallback: press Ctrl+C in the foreground app, read the clipboard, then put
// the user's previous clipboard contents back.
async function readViaCopy() {
  if (!child || !ready) return { text: '', skipped: false, timedOut: true };
  const saved = await clip.snapshot();
  clipboard.clear();
  let text = '';
  let sent = null;
  try {
    sent = await request('copy', 1000);
    if (sent && !sent.skipped) {
      for (let i = 0; i < 30 && !text; i++) {
        await new Promise((r) => setTimeout(r, 15));
        text = await clip.readText();
      }
    }
  } finally {
    await clip.restore(saved);
  }
  return { text: text.trim(), skipped: Boolean(sent?.skipped), timedOut: sent === null };
}

// Copies a screen rectangle (physical pixels) with the helper's BitBlt.
// Resolves { width, height, bitmap: Buffer (BGRA), ms } or null if the
// helper is unavailable or fails, so callers can fall back.
async function grab({ x, y, width, height }) {
  const res = await request(`grab ${Math.round(x)} ${Math.round(y)} ${Math.round(width)} ${Math.round(height)}`, 2000);
  if (!res || res.error || !res.data) {
    if (res?.error) log('helper.grab_error', { error: res.error });
    return null;
  }
  return { width: res.width, height: res.height, bitmap: Buffer.from(res.data, 'base64'), ms: res.ms };
}

// Text the user selected with the mouse within the last `maxAgeMs`.
function recentSelection(maxAgeMs = 120000) {
  return Date.now() - lastSelection.at <= maxAgeMs ? lastSelection.text.trim() : '';
}

module.exports = {
  start, stop, setWatching, readViaAutomation, readViaCopy, recentSelection, grab, events, isAvailable: () => ready,
};
