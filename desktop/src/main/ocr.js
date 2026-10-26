const path = require('node:path');
const { app } = require('electron');

// Local OCR with tesseract.js (WebAssembly, runs on this PC). The English
// model is downloaded once on first use and cached in userData; after that
// OCR works offline and no screen content leaves the machine for OCR.
//
// To stay light, the OCR engine is only loaded when a capture starts (the
// user spends a moment selecting, which hides the load time) and is unloaded
// again after a few idle minutes.

const IDLE_UNLOAD_MS = 5 * 60 * 1000;
let workerPromise = null;
let idleTimer = null;

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('eng', 1, { cachePath: path.join(app.getPath('userData'), 'ocr-cache') }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  scheduleUnload();
  return workerPromise;
}

function scheduleUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdown, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

// Start loading the engine in the background (called when a capture starts).
function warmUp() {
  getWorker().catch(() => {});
}

// Returns { text, confidence } where confidence is 0-100.
async function recognize(pngBuffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(pngBuffer);
  scheduleUnload();
  return { text: (data.text || '').trim(), confidence: Math.round(data.confidence || 0) };
}

async function shutdown() {
  clearTimeout(idleTimer);
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    await (await pending).terminate();
  } catch {
    /* already gone */
  }
}

module.exports = { warmUp, recognize, shutdown };
