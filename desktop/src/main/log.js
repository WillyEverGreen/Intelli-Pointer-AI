const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Small diagnostics log: %APPDATA%\IntelliPointer AI\logs\main.log (rotated
// at 512 KB). Records events and timings only, never selected text,
// screenshots, prompts or keys.

const MAX_BYTES = 512 * 1024;
let file = null;

function logFile() {
  if (!file) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
  }
  return file;
}

function log(event, fields = {}) {
  try {
    const f = logFile();
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.1`);
    fs.appendFileSync(f, `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
  } catch {
    /* logging must never break the app */
  }
}

module.exports = { log, logFile };
