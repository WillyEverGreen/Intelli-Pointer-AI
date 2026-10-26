const path = require('node:path');
const { app } = require('electron');

// Local OCR with tesseract.js (WebAssembly, runs on this PC). The English
// model is downloaded once on first use and cached in userData; after that
// OCR works offline and no screen content leaves the machine for OCR.

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('eng', 1, { cachePath: path.join(app.getPath('userData'), 'ocr-cache') }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// Start loading the model in the background so the first capture is fast.
function warmUp() {
  getWorker().catch(() => {});
}

// Returns { text, confidence } where confidence is 0-100.
async function recognize(pngBuffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(pngBuffer);
  return { text: (data.text || '').trim(), confidence: Math.round(data.confidence || 0) };
}

async function shutdown() {
  if (!workerPromise) return;
  try {
    await (await workerPromise).terminate();
  } catch {
    /* already gone */
  }
}

module.exports = { warmUp, recognize, shutdown };
