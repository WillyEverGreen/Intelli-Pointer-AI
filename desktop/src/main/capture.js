const path = require('node:path');
const { BrowserWindow, screen, desktopCapturer } = require('electron');
const { log } = require('./log');

// Screen capture + selection overlays.
//
// Design (instant overlay):
//  1. On the hotkey, a pre-created transparent overlay per display is shown
//     right away. The live screen shows through, dimmed, and the user can
//     start dragging immediately.
//  2. In parallel the screen is captured. The overlays use content
//     protection (WDA_EXCLUDEFROMCAPTURE), so they never appear in the shot.
//  3. The screenshot is sent to the overlay, which swaps it in as a frozen
//     background. Crops always come from that image, in physical pixels
//     (correct under any Windows scaling), with annotations drawn on top.
// Nothing is ever drawn on the real desktop or the app underneath.

const overlays = new Map(); // displayId -> BrowserWindow
const hideTimers = new Map(); // displayId -> timeout
let session = null; // { resolve, reject, t0, captureMs, overlayShownMs }
let shownWaiter = null; // called when the focused overlay reports it has painted

function createOverlay(display) {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep it ready to paint while hidden
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // excluded from screenshots, including our own
  win.setBounds(display.bounds); // re-apply: Windows may adjust bounds on mixed-DPI setups
  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), { query: { displayId: String(display.id) } });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) log('overlay.console_error', { message: String(e.message).slice(0, 300) });
  });
  win.webContents.on('render-process-gone', (_e, details) => log('overlay.crashed', { reason: details.reason }));
  win.on('closed', () => overlays.delete(display.id));
  overlays.set(display.id, win);
  return win;
}

function rebuildOverlays() {
  for (const win of overlays.values()) win.destroy();
  overlays.clear();
  for (const d of screen.getAllDisplays()) createOverlay(d);
}

// desktopCapturer's first call blocks the main thread for seconds while it
// initialises; pay that once at startup instead of on the first hotkey.
function warmUp() {
  const t0 = performance.now();
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    .then(() => log('capture.warmup', { ms: Math.round(performance.now() - t0) }))
    .catch((err) => log('capture.warmup_error', { error: err.message }));
}

function init() {
  rebuildOverlays();
  setTimeout(warmUp, 1500);
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => {
      if (!session) rebuildOverlays();
    });
  }
}

async function grabDisplays(displays) {
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

// Opens the overlays immediately and captures the screens behind them.
// Resolves with the user's confirmed selection
// { displayId, displayBounds, regions, action, captureMs, overlayShownMs } or null if cancelled.
function startSelection() {
  if (session) return Promise.resolve(null);
  const t0 = performance.now();
  const displays = screen.getAllDisplays();
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  return new Promise((resolve, reject) => {
    session = { resolve, reject, t0, captureMs: null, overlayShownMs: null };

    for (const d of displays) {
      let win = overlays.get(d.id);
      if (!win || win.isDestroyed()) win = createOverlay(d);
      clearTimeout(hideTimers.get(d.id));
      win.setOpacity(1);
      win.setBounds(d.bounds);
      win.webContents.send('overlay:show', { scaleFactor: d.scaleFactor });
      win.showInactive();
    }
    const focusWin = overlays.get(cursorDisplay.id);
    if (focusWin) {
      focusWin.focus();
      focusWin.moveTop();
    }
    // getSources blocks the main thread briefly, so start it only once the
    // overlay has painted (the renderer says so), or after 120 ms at most.
    const begin = new Promise((r) => {
      const timer = setTimeout(r, 120);
      shownWaiter = () => {
        clearTimeout(timer);
        r();
      };
    });

    begin
      .then(() => {
        shownWaiter = null;
        if (!session || session.resolve !== resolve) return null;
        session.overlayShownMs = Math.round(performance.now() - t0);
        return grabDisplays(displays);
      })
      .then((shots) => {
        if (!shots || !session || session.resolve !== resolve) return; // cancelled meanwhile
        session.captureMs = Math.round(performance.now() - t0);
        let sent = 0;
        for (const { display, image } of shots) {
          const win = overlays.get(display.id);
          if (!image || !win || win.isDestroyed()) continue;
          const { width, height } = image.getSize();
          win.webContents.send('overlay:frame', { width, height, bitmap: image.toBitmap() }); // BGRA
          sent += 1;
        }
        log('capture.timing', { overlayShownMs: session.overlayShownMs, captureMs: session.captureMs, displays: displays.length });
        if (!sent) throw new Error('Screen capture returned no images. Check Windows privacy settings for screen capture.');
      })
      .catch((err) => {
        if (!session || session.resolve !== resolve) return;
        session = null;
        hideAll();
        reject(err);
      });
  });
}

// Hides the overlays without a stale frame on the next show: fade to
// invisible at once, let the renderer clear, then hide.
function hideAll() {
  for (const [id, win] of overlays) {
    if (win.isDestroyed()) continue;
    win.setOpacity(0);
    win.webContents.send('overlay:reset');
    clearTimeout(hideTimers.get(id));
    hideTimers.set(id, setTimeout(() => {
      if (!win.isDestroyed()) win.hide();
    }, 150));
  }
}

function finish(result) {
  if (!session) return;
  const { resolve, captureMs, overlayShownMs, t0 } = session;
  session = null;
  hideAll();
  if (!result) log('capture.cancelled', { afterMs: Math.round(performance.now() - t0) });
  resolve(result ? { ...result, captureMs, overlayShownMs } : null);
}

function onOverlayConfirm(webContents, payload) {
  const win = BrowserWindow.fromWebContents(webContents);
  const displayId = [...overlays.entries()].find(([, w]) => w === win)?.[0];
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return finish(null);
  finish({ ...payload, displayId, displayBounds: display.bounds });
}

function onOverlayShown() {
  shownWaiter?.();
}

module.exports = {
  init, startSelection, onOverlayShown, onOverlayConfirm, cancel: () => finish(null), isActive: () => Boolean(session),
};
