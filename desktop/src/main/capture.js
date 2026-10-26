const path = require('node:path');
const { BrowserWindow, screen, desktopCapturer } = require('electron');
const { log } = require('./log');
const selection = require('./selection');

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
      spellcheck: false,
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

function init() {
  rebuildOverlays();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => {
      if (!session) rebuildOverlays();
    });
  }
}

// Fast path: the selection helper copies each display with BitBlt (~50 ms,
// no warm-up). Returns null if any display can't be grabbed that way.
async function grabWithHelper(displays) {
  if (!selection.isAvailable()) return null;
  const shots = await Promise.all(displays.map(async (d) => {
    const rect = screen.dipToScreenRect(null, d.bounds); // physical pixels
    const res = await selection.grab(rect);
    return res && { display: d, width: res.width, height: res.height, bitmap: res.bitmap };
  }));
  return shots.every(Boolean) ? shots : null;
}

async function grabDisplays(displays) {
  const t0 = performance.now();
  const fast = await grabWithHelper(displays).catch((err) => {
    log('capture.helper_error', { error: err.message });
    return null;
  });
  if (fast) return { shots: fast, method: 'bitblt', ms: Math.round(performance.now() - t0) };
  const shots = await grabWithElectron(displays);
  return { shots, method: 'desktopCapturer', ms: Math.round(performance.now() - t0) };
}

async function grabWithElectron(displays) {
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
      .then((grabbed) => {
        if (!grabbed || !session || session.resolve !== resolve) return; // cancelled meanwhile
        session.captureMs = Math.round(performance.now() - t0);
        session.captureMethod = grabbed.method;
        let sent = 0;
        for (const shot of grabbed.shots) {
          const win = overlays.get(shot.display.id);
          if (!win || win.isDestroyed()) continue;
          // BitBlt shots are already raw BGRA; Electron's are NativeImages.
          const frame = shot.bitmap
            ? { width: shot.width, height: shot.height, bitmap: shot.bitmap }
            : shot.image && { ...shot.image.getSize(), bitmap: shot.image.toBitmap() };
          if (!frame) continue;
          win.webContents.send('overlay:frame', frame);
          sent += 1;
        }
        log('capture.timing', {
          overlayShownMs: session.overlayShownMs, captureMs: session.captureMs, grabMs: grabbed.ms, method: grabbed.method, displays: displays.length,
        });
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
  const { resolve, captureMs, overlayShownMs, captureMethod, t0 } = session;
  session = null;
  hideAll();
  if (!result) log('capture.cancelled', { afterMs: Math.round(performance.now() - t0) });
  resolve(result ? { ...result, captureMs, overlayShownMs, captureMethod } : null);
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
