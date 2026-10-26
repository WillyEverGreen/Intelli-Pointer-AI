const path = require('node:path');
const { BrowserWindow, screen, desktopCapturer } = require('electron');

// Screen capture + selection overlays.
//
// Design: we capture every display FIRST, then show a full-screen overlay per
// display that paints the frozen screenshot. So:
//  - the overlay itself can never appear in the captured image,
//  - nothing is ever drawn on the real desktop or the app underneath,
//  - crops come from physical pixels (correct under any Windows scaling).
// Overlay windows are created ahead of time and reused, so showing them only
// costs the capture + one paint.

const overlays = new Map(); // displayId -> BrowserWindow
let session = null; // { resolve, reject, displays }

function createOverlay(display) {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBounds(display.bounds); // re-apply: Windows may adjust bounds on mixed-DPI setups
  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), { query: { displayId: String(display.id) } });
  win.on('closed', () => overlays.delete(display.id));
  overlays.set(display.id, win);
  return win;
}

function rebuildOverlays() {
  for (const win of overlays.values()) win.destroy();
  overlays.clear();
  for (const d of screen.getAllDisplays()) createOverlay(d);
}

function init() {
  rebuildOverlays();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => {
      if (!session) rebuildOverlays();
    });
  }
}

async function grabDisplays() {
  const displays = screen.getAllDisplays();
  const phys = (d) => ({ width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) });
  const maxW = Math.max(...displays.map((d) => phys(d).width));
  const maxH = Math.max(...displays.map((d) => phys(d).height));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });

  return displays.map((d) => {
    let src = sources.find((s) => s.display_id === String(d.id));
    if (!src && sources.length === 1 && displays.length === 1) src = sources[0];
    if (!src) return { display: d, image: null };
    const size = phys(d);
    let image = src.thumbnail;
    const got = image.getSize();
    if (got.width !== size.width || got.height !== size.height) image = image.resize(size);
    return { display: d, image };
  });
}

// Captures all screens and opens the overlays. Resolves with the user's
// confirmed selection { displayId, displayBounds, regions, action } or null if cancelled.
async function startSelection() {
  if (session) return null;
  const t0 = performance.now();
  const shots = await grabDisplays();
  const captureMs = Math.round(performance.now() - t0);

  return new Promise((resolve, reject) => {
    session = { resolve, reject, captureMs, pendingReady: 0 };
    for (const { display, image } of shots) {
      let win = overlays.get(display.id);
      if (!win || win.isDestroyed()) win = createOverlay(display);
      if (!image) continue;
      const { width, height } = image.getSize();
      session.pendingReady += 1;
      win.setBounds(display.bounds);
      win.webContents.send('overlay:start', {
        width,
        height,
        bitmap: image.toBitmap(), // BGRA, swizzled in the renderer
        scaleFactor: display.scaleFactor,
      });
    }
    if (session.pendingReady === 0) {
      session = null;
      reject(new Error('Screen capture returned no images. Check Windows privacy settings for screen capture.'));
    }
  });
}

// Renderer painted its screenshot: show that overlay now (no black flash).
function onOverlayReady(webContents) {
  const win = BrowserWindow.fromWebContents(webContents);
  if (!session || !win) return;
  win.show();
  win.focus();
  win.moveTop();
}

function finish(result) {
  if (!session) return;
  const { resolve, captureMs } = session;
  session = null;
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue;
    win.hide();
    win.webContents.send('overlay:reset');
  }
  resolve(result ? { ...result, captureMs } : null);
}

function onOverlayConfirm(webContents, payload) {
  const win = BrowserWindow.fromWebContents(webContents);
  const displayId = [...overlays.entries()].find(([, w]) => w === win)?.[0];
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return finish(null);
  finish({ ...payload, displayId, displayBounds: display.bounds });
}

module.exports = { init, startSelection, onOverlayReady, onOverlayConfirm, cancel: () => finish(null), isActive: () => Boolean(session) };
