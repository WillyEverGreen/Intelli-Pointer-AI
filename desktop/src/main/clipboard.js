const { clipboard, ClipboardItem, nativeImage } = require('electron');
const { log } = require('./log');

// Clipboard helpers for Electron's async (W3C-style) clipboard API.

// Copies the current clipboard contents into memory so they can be put back
// later. Items returned by clipboard.read() read lazily from the live
// clipboard, so every payload is materialised here.
async function snapshot() {
  const out = [];
  try {
    for (const item of await clipboard.read()) {
      const data = {};
      for (const type of item.types) {
        try {
          data[type] = await item.getType(type);
        } catch {
          /* format not readable; skip it */
        }
      }
      if (Object.keys(data).length) out.push(data);
    }
  } catch (err) {
    log('clipboard.snapshot_error', { error: err.message });
  }
  return out;
}

async function restore(saved) {
  try {
    if (!saved.length) {
      clipboard.clear();
      return;
    }
    await clipboard.write(saved.map((data) => new ClipboardItem(data)));
  } catch (err) {
    // Some formats can't be written back; keep at least the text.
    log('clipboard.restore_error', { error: err.message });
    const text = saved.find((d) => d['text/plain'])?.['text/plain'];
    if (text) await clipboard.writeText(typeof text === 'string' ? text : await text.text());
  }
}

async function readText() {
  try {
    return (await clipboard.readText()) || '';
  } catch {
    return '';
  }
}

// PNG bytes of an image on the clipboard, or null.
async function readImagePng() {
  try {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t === 'image/png') || item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const buf = Buffer.from(await (await item.getType(type)).arrayBuffer());
      if (type === 'image/png') return buf;
      const img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) return img.toPNG();
    }
  } catch (err) {
    log('clipboard.image_error', { error: err.message });
  }
  return null;
}

module.exports = { snapshot, restore, readText, readImagePng };
