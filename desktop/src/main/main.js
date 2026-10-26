const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, clipboard, nativeImage, shell, Notification, nativeTheme,
} = require('electron');
const settings = require('./settings');
const auth = require('./auth');
const capture = require('./capture');
const ocr = require('./ocr');
const api = require('./api');
const latency = require('./latency');
const selection = require('./selection');
const { makeIcon } = require('./icon');

const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // backend limit is 4 MB decoded
const PANEL_SIZE = { width: 460, height: 600 };

let panel = null;
let tray = null;
let pinned = true;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- floating panel ----------

function createPanel() {
  panel = new BrowserWindow({
    ...PANEL_SIZE,
    minWidth: 340,
    minHeight: 160,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    title: 'IntelliPointer AI',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1e21' : '#ffffff', // matches theme.css, avoids a flash
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  panel.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  panel.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      panel.hide();
    }
  });
  // Never navigate away from the bundled UI; links open in the real browser.
  panel.webContents.on('will-navigate', (e) => e.preventDefault());
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Place the panel next to the selection, not on top of it.
function placePanel(bbox) {
  const [w, h] = panel.getSize();
  const display = bbox ? screen.getDisplayMatching(bbox) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const gap = 12;
  const clampY = (y) => Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
  const clampX = (x) => Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
  let pos = { x: wa.x + wa.width - w - gap, y: wa.y + wa.height - h - gap };
  if (bbox) {
    if (bbox.x + bbox.width + gap + w <= wa.x + wa.width) pos = { x: bbox.x + bbox.width + gap, y: clampY(bbox.y) };
    else if (bbox.x - gap - w >= wa.x) pos = { x: bbox.x - gap - w, y: clampY(bbox.y) };
    else if (bbox.y + bbox.height + gap + h <= wa.y + wa.height) pos = { x: clampX(bbox.x), y: bbox.y + bbox.height + gap };
    else if (bbox.y - gap - h >= wa.y) pos = { x: clampX(bbox.x), y: bbox.y - gap - h };
  }
  panel.setPosition(Math.round(pos.x), Math.round(pos.y));
}

function showPanel({ focus = true, bbox = null } = {}) {
  if (bbox || !panel.isVisible()) placePanel(bbox);
  if (focus) {
    panel.show();
    panel.focus();
  } else {
    panel.showInactive(); // don't steal keyboard focus from the user's app
  }
}

// ---------- "Ask AI" bubble for text selected in other apps ----------

const BUBBLE_SIZE = { width: 340, height: 50 };
let bubble = null;
let bubbleText = '';
let bubbleAnchor = null;
let bubbleTimer = null;
let bubbleHover = false;
let lastBubble = { text: '', at: 0 };

function createBubble() {
  bubble = new BrowserWindow({
    ...BUBBLE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false, // never steal focus from the app the user is reading
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bubble.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  bubble.setAlwaysOnTop(true, 'pop-up-menu');
  bubble.loadFile(path.join(__dirname, '..', 'renderer', 'bubble.html'));
  bubble.webContents.on('will-navigate', (e) => e.preventDefault());
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  if (bubble && !bubble.isDestroyed() && bubble.isVisible()) bubble.hide();
  bubbleHover = false;
}

function armBubbleTimer() {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubbleHover ? armBubbleTimer() : hideBubble()), 6000);
}

function showBubble({ text, x, y }) {
  if (!settings.get().selectionBubble || capture.isActive() || !bubble) return;
  const now = Date.now();
  // Dragging a scrollbar etc. re-detects an old selection: don't pop up again for it.
  if (text === lastBubble.text && now - lastBubble.at < 10000) return;
  lastBubble = { text, at: now };
  bubbleText = text.slice(0, 15000);

  const p = screen.screenToDipPoint({ x, y }); // the mouse hook reports physical pixels
  const wa = screen.getDisplayNearestPoint(p).workArea;
  const { width: w, height: h } = BUBBLE_SIZE;
  let bx = Math.round(p.x + 8);
  let by = Math.round(p.y + 16);
  if (bx + w > wa.x + wa.width) bx = wa.x + wa.width - w;
  if (by + h > wa.y + wa.height) by = Math.round(p.y - h - 12);
  // Rough box of the selected line, so the panel opens beside it rather than over it.
  bubbleAnchor = { x: Math.round(p.x) - 320, y: Math.round(p.y) - 24, width: 320, height: 48 };
  bubble.setBounds({ x: bx, y: by, width: w, height: h });
  bubble.webContents.send('bubble:show', { preview: bubbleText.slice(0, 200) });
  bubble.showInactive();
  armBubbleTimer();
}

function onGlobalMouseDown({ x, y }) {
  if (!bubble || !bubble.isVisible()) return;
  const p = screen.screenToDipPoint({ x, y });
  const b = bubble.getBounds();
  if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
  hideBubble();
}

function openWithText(text, { action = null, kind = 'selection', bbox = null } = {}) {
  panel.webContents.send('context:add', {
    contextId: `ctx-${Date.now()}`, mode: 'replace', kind, images: [], text: text.slice(0, 15000), action,
  });
  showPanel({ focus: !action, bbox });
}

// Hotkey: ask about the text selected in the foreground app. Tries UI
// Automation first (no side effects), then a Ctrl+C round-trip that restores
// the clipboard, then whatever is already on the clipboard.
async function askAboutSelection() {
  hideBubble();
  let text = await selection.readViaAutomation();
  if (!text) text = await selection.readViaCopy();
  if (text) return openWithText(text, { kind: 'selection' });
  return askAboutClipboard();
}

// ---------- capture pipeline ----------

function toAttachment(pngBuffer) {
  let buf = pngBuffer;
  let mime = 'image/png';
  if (buf.length > MAX_IMAGE_BYTES) {
    const img = nativeImage.createFromBuffer(pngBuffer);
    buf = img.toJPEG(90);
    mime = 'image/jpeg';
    let scale = 0.8;
    while (buf.length > MAX_IMAGE_BYTES && scale > 0.2) {
      const { width, height } = img.getSize();
      buf = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toJPEG(85);
      scale -= 0.2;
    }
  }
  const base64 = buf.toString('base64');
  return { mime, base64, bytes: buf.length, dataUrl: `data:${mime};base64,${base64}` };
}

async function runOcr(regions) {
  if (!settings.get().ocrEnabled) return { text: '', confidence: 0, ms: 0 };
  const t0 = performance.now();
  const parts = [];
  let confSum = 0;
  for (const [i, r] of regions.entries()) {
    try {
      const res = await ocr.recognize(r.png);
      confSum += res.confidence;
      if (res.text) parts.push(regions.length > 1 ? `[Region ${i + 1}]\n${res.text}` : res.text);
    } catch (err) {
      return { text: '', confidence: 0, ms: Math.round(performance.now() - t0), error: `OCR unavailable: ${err.message}` };
    }
  }
  return { text: parts.join('\n\n'), confidence: Math.round(confSum / regions.length), ms: Math.round(performance.now() - t0) };
}

async function startCapture(mode = 'replace') {
  if (capture.isActive()) return;
  hideBubble();
  const tHotkey = performance.now();
  const panelWasVisible = panel.isVisible();
  if (panelWasVisible) panel.hide(); // keep our own panel out of the screenshot

  let result;
  try {
    result = await capture.startSelection();
  } catch (err) {
    new Notification({ title: 'IntelliPointer', body: err.message }).show();
    return;
  }
  if (!result) {
    if (panelWasVisible) panel.showInactive();
    return;
  }
  const selectionMs = Math.round(performance.now() - tHotkey);

  const regions = result.regions.map((r) => ({ ...r, png: Buffer.from(r.png) }));
  const bounds = result.displayBounds;
  const union = regions.reduce(
    (u, r) => ({
      x1: Math.min(u.x1, bounds.x + r.bbox.x), y1: Math.min(u.y1, bounds.y + r.bbox.y),
      x2: Math.max(u.x2, bounds.x + r.bbox.x + r.bbox.width), y2: Math.max(u.y2, bounds.y + r.bbox.y + r.bbox.height),
    }),
    { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
  );
  const bbox = { x: union.x1, y: union.y1, width: union.x2 - union.x1, height: union.y2 - union.y1 };

  // Show the panel straight away with thumbnails; OCR text follows.
  const attachments = regions.map((r, i) => ({ label: `Region ${i + 1}`, width: r.width, height: r.height, ...toAttachment(r.png) }));
  const contextId = `ctx-${Date.now()}`;
  panel.webContents.send('context:add', {
    contextId, mode, kind: 'screen', images: attachments, action: result.action || null,
    timings: { captureMs: result.captureMs, selectionMs },
  });
  showPanel({ focus: !result.action, bbox });

  const o = await runOcr(regions);
  panel.webContents.send('context:ocr', { contextId, text: o.text, confidence: o.confidence, error: o.error || null, ocrMs: o.ms });
}

function askAboutClipboard() {
  const image = clipboard.readImage();
  const text = clipboard.readText().trim();
  const contextId = `ctx-${Date.now()}`;
  if (!image.isEmpty()) {
    const att = { label: 'Clipboard image', ...image.getSize(), ...toAttachment(image.toPNG()) };
    panel.webContents.send('context:add', { contextId, mode: 'replace', kind: 'clipboard', images: [att], text: '' });
  } else if (text) {
    panel.webContents.send('context:add', { contextId, mode: 'replace', kind: 'clipboard', images: [], text: text.slice(0, 15000) });
  } else {
    new Notification({ title: 'IntelliPointer', body: 'Clipboard is empty. Copy some text or an image first (Ctrl+C).' }).show();
    return;
  }
  showPanel({ focus: true });
}

// ---------- hotkeys & tray ----------

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const s = settings.get();
  const failed = [];
  if (!globalShortcut.register(s.captureHotkey, () => startCapture('replace'))) failed.push(s.captureHotkey);
  if (!globalShortcut.register(s.clipboardHotkey, askAboutSelection)) failed.push(s.clipboardHotkey);
  return failed;
}

function createTray() {
  tray = new Tray(makeIcon(32));
  tray.setToolTip('IntelliPointer AI');
  const s = settings.get();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Capture screen region   (${s.captureHotkey})`, click: () => startCapture('replace') },
    { label: `Ask about selected text: select it, press ${s.clipboardHotkey}`, enabled: false },
    { label: 'Ask about clipboard', click: askAboutClipboard },
    { label: 'Show panel', click: () => showPanel({ focus: true }) },
    { type: 'separator' },
    { label: 'Open latency log', click: () => shell.showItemInFolder(latency.file()) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showPanel({ focus: true }));
}

// Written by scripts/install-app.mjs; absent when running from source.
function buildInfo() {
  try {
    return require('../build-info.json');
  } catch {
    return { version: app.getVersion(), commit: 'source', builtAt: null };
  }
}

// ---------- IPC ----------

const fromPanel = (e) => panel && e.sender === panel.webContents;

function handlePanel(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromPanel(e)) throw new Error('Forbidden');
    return fn(e, ...args);
  });
}

function registerIpc() {
  ipcMain.on('overlay:ready', (e) => capture.onOverlayReady(e.sender));
  ipcMain.on('overlay:confirm', (e, payload) => capture.onOverlayConfirm(e.sender, payload));
  ipcMain.on('overlay:cancel', () => capture.cancel());

  const fromBubble = (e) => bubble && e.sender === bubble.webContents;
  ipcMain.on('bubble:action', (e, actionId) => {
    if (!fromBubble(e) || !bubbleText) return;
    const text = bubbleText;
    hideBubble();
    openWithText(text, { action: typeof actionId === 'string' ? actionId : null, bbox: bubbleAnchor });
  });
  ipcMain.on('bubble:close', (e) => {
    if (fromBubble(e)) hideBubble();
  });
  ipcMain.on('bubble:hover', (e, inside) => {
    if (fromBubble(e)) bubbleHover = Boolean(inside);
  });

  handlePanel('settings:get', () => ({ ...settings.get(), latencyFile: latency.file(), build: buildInfo() }));
  handlePanel('settings:update', (_e, patch) => {
    const next = settings.update(patch);
    const failed = registerHotkeys();
    if (next.ocrEnabled) ocr.warmUp();
    selection.setWatching(next.selectionBubble);
    if (!next.selectionBubble) hideBubble();
    return { settings: next, hotkeyErrors: failed };
  });
  handlePanel('auth:status', () => auth.status());
  handlePanel('auth:signIn', (_e, { email, password, create }) => auth.signIn(String(email), String(password), { create: Boolean(create) }));
  handlePanel('auth:signOut', () => auth.signOut());
  handlePanel('models:list', () => api.listModels());
  handlePanel('usage:get', () => api.usage());
  handlePanel('capture:start', (_e, mode) => startCapture(mode === 'append' ? 'append' : 'replace'));
  handlePanel('ask:cancel', (_e, reqId) => api.cancel(reqId));
  handlePanel('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  handlePanel('panel:pin', (_e, value) => {
    pinned = Boolean(value);
    panel.setAlwaysOnTop(pinned);
    return pinned;
  });
  handlePanel('panel:resize', (_e, height) => {
    const [w] = panel.getSize();
    panel.setSize(w, Math.max(160, Math.min(1000, Math.round(height))));
  });
  handlePanel('panel:hide', () => panel.hide());
  handlePanel('open:latencyLog', () => shell.showItemInFolder(latency.file()));

  handlePanel('ask:start', async (e, { reqId, body, cacheable, meta }) => {
    if (settings.get().localOnly) throw new Error('Local-only mode is on: nothing is sent to the cloud.');
    const sender = e.sender;
    const result = await api.ask({ reqId, body, cacheable }, (event, data) => {
      if (!sender.isDestroyed()) sender.send('ask:event', { reqId, event, data });
    });
    latency.record({
      timestamp: new Date().toISOString(),
      model: body.model,
      images: body.messages.reduce((n, m) => n + (m.images?.length || 0), 0),
      uploadBytes: result.timings.uploadBytes,
      captureMs: meta?.captureMs,
      ocrMs: meta?.ocrMs,
      requestToHeadersMs: result.timings.requestToHeadersMs,
      firstTokenMs: result.timings.firstTokenMs,
      totalMs: result.timings.totalMs,
      serverFirstTokenMs: result.serverTimings?.firstTokenMs,
      outcome: result.outcome,
    });
    return { outcome: result.outcome };
  });
}

// ---------- lifecycle ----------

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.intellipointer.desktop');
  await auth.restore();
  createPanel();
  createBubble();
  capture.init();
  selection.events.on('selection', showBubble);
  selection.events.on('down', onGlobalMouseDown);
  selection.setWatching(settings.get().selectionBubble);
  selection.start();
  createTray();
  registerIpc();
  const failed = registerHotkeys();
  if (failed.length) {
    new Notification({ title: 'IntelliPointer', body: `Hotkey already in use: ${failed.join(', ')}. Change it in Settings.` }).show();
  }
  if (settings.get().ocrEnabled) ocr.warmUp();
  showPanel({ focus: true }); // first launch: show the panel so users find settings
});

app.on('second-instance', () => showPanel({ focus: true }));
app.on('window-all-closed', () => {
  /* tray app: keep running */
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  selection.stop();
  ocr.shutdown();
});
