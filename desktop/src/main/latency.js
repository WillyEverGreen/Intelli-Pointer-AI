const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Appends one row per completed AI request to userData/latency.csv so the
// numbers can be charted for the report. Contains timings only, no content.

const COLUMNS = [
  'timestamp', 'model', 'images', 'uploadBytes', 'captureMs', 'ocrMs',
  'requestToHeadersMs', 'firstTokenMs', 'totalMs', 'serverFirstTokenMs', 'outcome',
];

function file() {
  return path.join(app.getPath('userData'), 'latency.csv');
}

function record(row) {
  try {
    if (!fs.existsSync(file())) fs.writeFileSync(file(), `${COLUMNS.join(',')}\n`);
    const line = COLUMNS.map((c) => {
      const v = row[c] ?? '';
      return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    }).join(',');
    fs.appendFileSync(file(), `${line}\n`);
  } catch {
    /* metrics must never break the app */
  }
}

module.exports = { record, file };
