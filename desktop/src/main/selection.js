const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { clipboard } = require('electron');

// Bridge to native/selection-helper.ps1 (see that file for what it does).
// Emits:
//   'selection' { text, x, y }  user finished selecting text in another app (physical px)
//   'down'      { x, y }        left mouse button pressed anywhere (physical px)

const events = new EventEmitter();
let child = null;
let ready = false;
let restarts = 0;
let watching = true;
const waiters = []; // { type, resolve, timer }

function helperPath() {
  // In a packaged app the script is unpacked next to app.asar so PowerShell can read it.
  return path.join(__dirname, 'native', 'selection-helper.ps1').replace('app.asar', 'app.asar.unpacked');
}

function start() {
  if (process.platform !== 'win32' || child) return;
  // ExecutionPolicy Bypass applies to this one child process only; no system setting changes.
  child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath(), String(process.pid)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'ready') {
        ready = true;
        restarts = 0;
        send(`watch ${watching ? 1 : 0}`);
      } else if (msg.type === 'selection' || msg.type === 'down') {
        events.emit(msg.type, msg);
      } else {
        const i = waiters.findIndex((w) => w.type === msg.type);
        if (i !== -1) {
          const [w] = waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    }
  });
  child.stderr.on('data', (d) => console.error('[selection-helper]', String(d).trim()));
  child.on('exit', () => {
    child = null;
    ready = false;
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    if (restarts < 3 && !stopping) {
      restarts += 1;
      setTimeout(start, 2000 * restarts);
    }
  });
}

let stopping = false;
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

function request(line, type, timeoutMs) {
  if (!child || !ready) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.findIndex((w) => w.resolve === resolve);
      if (i !== -1) waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    waiters.push({ type, resolve, timer });
    send(line);
  });
}

function setWatching(on) {
  watching = Boolean(on);
  send(`watch ${watching ? 1 : 0}`);
}

// Selected text via UI Automation (no keystrokes, clipboard untouched).
async function readViaAutomation() {
  const res = await request('getsel', 'sel-result', 1500);
  return (res?.text || '').trim();
}

// Fallback: press Ctrl+C in the foreground app, read the clipboard, then put
// the user's previous clipboard contents back.
async function readViaCopy() {
  const saved = { text: clipboard.readText(), html: clipboard.readHTML(), image: clipboard.readImage() };
  clipboard.clear();
  const sent = await request('copy', 'copy-sent', 2500);
  let text = '';
  if (sent && !sent.skipped) {
    for (let i = 0; i < 25 && !text; i++) {
      await new Promise((r) => setTimeout(r, 20));
      text = clipboard.readText();
    }
  }
  const restore = {};
  if (saved.text) restore.text = saved.text;
  if (saved.html) restore.html = saved.html;
  if (!saved.image.isEmpty()) restore.image = saved.image;
  if (Object.keys(restore).length) clipboard.write(restore);
  else clipboard.clear();
  return text.trim();
}

module.exports = { start, stop, setWatching, readViaAutomation, readViaCopy, events, isAvailable: () => ready };
