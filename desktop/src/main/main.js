const path = require('node:path');
const {
  app, BrowserWindow, Tray, session, Menu, globalShortcut, ipcMain, screen, clipboard, nativeImage, shell, Notification, nativeTheme,
} = require('electron');
const settings = require('./settings');
const updater = require('./updater');
const capture = require('./capture');
const ocr = require('./ocr');
const api = require('./api');
const latency = require('./latency');
const selection = require('./selection');
const secrets = require('./secrets');
const providers = require('./providers');
const { log, logFile } = require('./log');

// Never show raw "JavaScript error in the main process" boxes: log the error
// and keep running. (Startup syntax errors are caught by `npm run check`.)
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    log(`main.${event}`, { error: String(err?.message || err), stack: String(err?.stack || '').split(/\r?\n/).slice(0, 4).join(' | ') });
  });
}
const clip = require('./clipboard');
const commandDefaults = require('./commands');
const { makeIcon } = require('./icon');

// Runs an async handler from a hotkey/menu and logs failures instead of dropping them.
const guarded = (name, fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((err) => {
  log(`${name}.error`, { error: err.message, stack: String(err.stack).split(/\r?\n/).slice(0, 3).join(' | ') });
});

const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // stays under the 4 MB image limit of the providers
const PANEL_SIZE = { width: 460, height: 600 };

let panel = null;
let tray = null;
let pinned = true;

// Keep Chromium lean: no spare pre-spawned renderer, no media-key/session
// services, no translate or autofill background work.
app.commandLine.appendSwitch('disable-features', [
  'SpareRendererForSitePerProcess', 'MediaSessionService', 'HardwareMediaKeyHandling', 'Translate', 'AutofillServerCommunication',
].join(','));
// Software rendering unless the user turns GPU acceleration on (saves ~100+ MB).
if (process.env.IP_GPU !== 'on' && !settings.get().hardwareAcceleration) app.disableHardwareAcceleration();
Menu.setApplicationMenu(null); // no default menu: less memory and startup work

// Windows 10 or 11 only: the screen capture, selection helper and tray behaviour are Windows-specific.
if (process.platform !== 'win32' || Number.parseInt(require('node:os').release(), 10) < 10) {
  require('electron').dialog.showErrorBox('IntelliPointer AI', 'IntelliPointer AI needs Windows 10 or Windows 11.');
  app.exit(1);
}

const SMOKE_TEST_OUT = (process.argv.find((a) => a.startsWith('--smoke-test=')) || '').slice('--smoke-test='.length);

// The smoke test may run while the user's copy is open, so it skips the lock.
// A second launch just shows the running copy's panel (see "second-instance")
// and exits at once, before creating windows or touching the shortcuts.
// Started by Windows at sign-in: stay in the tray, don't pop the panel open.
const BACKGROUND_START = process.argv.includes('--background');
const isPrimary = Boolean(SMOKE_TEST_OUT) || app.requestSingleInstanceLock();
if (!isPrimary) {
  app.exit(0);
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
      spellcheck: false,
    },
  });
  panel.setContentProtection(true); // never part of a screenshot or screen share, even for a frame
  panel.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'panel.html'));
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

// Every shortcut starts with the chat window out of the way. Resolves to
// whether it was visible, after giving the compositor a moment to remove it.
async function hidePanelForShortcut() {
  if (!panel.isVisible()) return false;
  panel.hide();
  await new Promise((r) => setTimeout(r, 80));
  return true;
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
      spellcheck: false,
    },
  });
  bubble.setAlwaysOnTop(true, 'pop-up-menu');
  bubble.setContentProtection(true);
  bubble.loadFile(path.join(__dirname, '..', 'renderer', 'bubble', 'bubble.html'));
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
  bubble.webContents.send('bubble:show', { preview: bubbleText.slice(0, 200), commands: pinnedCommands() });
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
// Last resort: the text most recently selected with the mouse (seen by the
// helper's hook), for apps that expose neither UIA selection nor Ctrl+C.
// With `commandId` (a command's own shortcut) the command runs straight away
// on the selection, or, if no text is selected, on a screen region instead.
async function askAboutSelection({ commandId = null } = {}) {
  const t0 = performance.now();
  // Our own panel must not be the foreground window (it would hide the user's
  // selection) and must not be on screen if this falls back to a capture.
  const panelWasVisible = await hidePanelForShortcut();
  try {
    return await askAboutSelectionInner({ commandId, t0 });
  } finally {
    if (panelWasVisible && !panel.isVisible() && !capture.isActive()) panel.showInactive();
  }
}

async function askAboutSelectionInner({ commandId, t0 }) {
  log('hotkey.pressed', { hotkey: commandId ? `command:${commandId}` : 'selection', helperReady: selection.isAvailable() });
  hideBubble();
  const auto = await selection.readViaAutomation();
  let text = auto.text;
  let source = 'automation';
  let copy = null;
  if (!text) {
    copy = await selection.readViaCopy();
    text = copy.text;
    source = 'copy';
  }
  if (!text) {
    text = selection.recentSelection();
    source = 'recent-mouse-selection';
  }
  log('hotkey.selection', {
    ms: Math.round(performance.now() - t0), source: text ? source : 'none', chars: text.length,
    automationMs: auto.ms, automationTimedOut: auto.timedOut, copySkipped: copy?.skipped, copyTimedOut: copy?.timedOut,
  });
  if (text) return openWithText(text, { kind: 'selection', action: commandId });
  if (commandId) return startCapture('replace', commandId);
  return askAboutClipboard({ fromHotkey: true });
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

// `presetAction`: a command to run on confirm (from a command's shortcut).
async function startCapture(mode = 'replace', presetAction = null) {
  if (capture.isActive()) return;
  log('hotkey.pressed', { hotkey: 'capture', mode });
  // Load OCR while the user is still selecting, so it is ready by confirm.
  if (settings.get().ocrEnabled) ocr.warmUp();
  hideBubble();
  const tHotkey = performance.now();
  const panelWasVisible = await hidePanelForShortcut(); // keep our own panel out of the screenshot

  let result;
  try {
    result = await capture.startSelection({ commands: pinnedCommands(), presetAction });
  } catch (err) {
    log('capture.error', { error: err.message });
    new Notification({ title: 'IntelliPointer', body: err.message }).show();
    return;
  }
  if (!result) {
    if (panelWasVisible) panel.showInactive();
    return;
  }
  const selectionMs = Math.round(performance.now() - tHotkey);
  log('capture.done', { captureMs: result.captureMs, overlayShownMs: result.overlayShownMs, selectionMs, regions: result.regions.length });

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
  const attachments = regions.map((r, i) => ({
    label: r.focus ? 'Marked area (zoomed)' : `Region ${i + 1}`,
    marked: Boolean(r.marked),
    focus: Boolean(r.focus),
    width: r.width,
    height: r.height,
    ...toAttachment(r.png),
  }));
  const contextId = `ctx-${Date.now()}`;
  panel.webContents.send('context:add', {
    contextId, mode, kind: 'screen', images: attachments, action: result.action || presetAction || null,
    timings: { captureMs: result.captureMs, selectionMs },
  });
  showPanel({ focus: !result.action, bbox });

  const o = await runOcr(regions.filter((r) => !r.focus)); // the close-up repeats text already in the full region
  panel.webContents.send('context:ocr', { contextId, text: o.text, confidence: o.confidence, error: o.error || null, ocrMs: o.ms });
}

async function askAboutClipboard({ fromHotkey = false } = {}) {
  const png = await clip.readImagePng();
  const text = png ? '' : (await clip.readText()).trim();
  const contextId = `ctx-${Date.now()}`;
  if (png) {
    const att = { label: 'Clipboard image', ...nativeImage.createFromBuffer(png).getSize(), ...toAttachment(png) };
    panel.webContents.send('context:add', { contextId, mode: 'replace', kind: 'clipboard', images: [att], text: '' });
  } else if (text) {
    panel.webContents.send('context:add', { contextId, mode: 'replace', kind: 'clipboard', images: [], text: text.slice(0, 15000) });
  } else {
    const body = fromHotkey
      ? "No selected text found. Select some text first. If an app won't share its selection, press Ctrl+C and then the shortcut."
      : 'Clipboard is empty. Copy some text or an image first (Ctrl+C).';
    new Notification({ title: 'IntelliPointer', body }).show();
    return;
  }
  showPanel({ focus: true });
}

// ---------- hotkeys & tray ----------

const prettyAccelerator = (a) => String(a || '').replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl');
const pinnedCommands = () => settings.get().commands.filter((c) => c.pinned).map(({ id, name }) => ({ id, name }));

// Shortcuts that could not be registered (another app owns them), and the
// ones actually in use (a default may have fallen back to an alternative).
let hotkeyErrors = [];
let activeHotkeys = {};

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const s = settings.get();
  const failed = [];
  activeHotkeys = {};
  const tryRegister = (accelerator, fn) => {
    if (!accelerator) return false;
    try {
      return globalShortcut.register(accelerator, fn);
    } catch (err) {
      log('hotkey.invalid', { accelerator, error: err.message });
      return false;
    }
  };
  const core = {
    captureHotkey: guarded('capture', () => startCapture('replace')),
    selectionHotkey: guarded('selection', () => askAboutSelection()),
  };
  for (const [key, fn] of Object.entries(core)) {
    // A default shortcut that is taken falls back to the next free one;
    // one the user picked is reported instead of silently replaced.
    const isDefault = s[key] === settings.DEFAULTS[key];
    const candidates = isDefault ? settings.HOTKEY_FALLBACKS[key] : [s[key]];
    const used = candidates.find((acc) => tryRegister(acc, fn));
    if (used) activeHotkeys[key] = used;
    else failed.push(s[key]);
  }
  for (const c of s.commands) {
    if (!c.shortcut) continue;
    if (tryRegister(c.shortcut, guarded(`command:${c.id}`, () => askAboutSelection({ commandId: c.id })))) activeHotkeys[`command:${c.id}`] = c.shortcut;
    else failed.push(c.shortcut);
  }
  hotkeyErrors = failed.map(prettyAccelerator);
  log('hotkeys.registered', { active: activeHotkeys, failed });
  updateTrayMenu();
  return hotkeyErrors;
}

// Whether a shortcut can be used: valid, not used by another command here,
// and not owned by another app. `forKey` is the setting being edited.
function checkHotkey(accelerator, forKey) {
  const acc = String(accelerator || '');
  if (!acc) return { ok: true };
  const mine = Object.entries(activeHotkeys).find(([k, a]) => a.toLowerCase() === acc.toLowerCase());
  if (mine) {
    if (mine[0] === forKey) return { ok: true };
    const what = mine[0] === 'captureHotkey' ? 'Select a screen region'
      : mine[0] === 'selectionHotkey' ? 'Ask about selected text'
        : `the “${settings.get().commands.find((c) => `command:${c.id}` === mine[0])?.name}” command`;
    return { ok: false, reason: `Already used here for ${what}.` };
  }
  try {
    if (!globalShortcut.register(acc, () => {})) return { ok: false, reason: 'Another app already uses this shortcut.' };
    globalShortcut.unregister(acc);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Not a valid shortcut.' };
  }
}

function createTray() {
  tray = new Tray(makeIcon(32));
  tray.setToolTip('IntelliPointer');
  tray.on('click', () => showPanel({ focus: true }));
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Select a screen region', accelerator: activeHotkeys.captureHotkey, click: guarded('capture', () => startCapture('replace')) },
    { label: 'Ask about clipboard', click: guarded('clipboard', () => askAboutClipboard()) },
    { label: 'Open IntelliPointer', click: () => showPanel({ focus: true }) },
    { type: 'separator' },
    { label: 'Settings', click: () => { showPanel({ focus: true }); panel.webContents.send('panel:open-settings'); } },
    { label: 'Open diagnostics log', click: () => shell.showItemInFolder(logFile()) },
    ...(updater.getState().status === 'ready'
      ? [{ label: `Restart to update to ${updater.getState().version}`, click: () => updater.installNow() }]
      : []),
    { type: 'separator' },
    { label: 'Quit IntelliPointer', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// Written by scripts/prepare-build.js; absent when running from source.
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

// Start with Windows, so the shortcuts work without opening the app first.
// Only the installed build registers itself (a dev run would register electron.exe).
function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.get().launchAtLogin), args: ['--background'] });
  } catch (err) {
    log('login-item.error', { error: err.message });
  }
}

function registerIpc() {
  ipcMain.on('overlay:shown', () => capture.onOverlayShown());
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
  // The bar sizes itself to its buttons; keep it inside the screen.
  ipcMain.on('bubble:resize', (e, width, height) => {
    if (!fromBubble(e)) return;
    const w = Math.min(720, Math.max(120, Math.round(Number(width) || 0)));
    const h = Math.min(80, Math.max(36, Math.round(Number(height) || 0)));
    const b = bubble.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    bubble.setBounds({ x: Math.min(b.x, wa.x + wa.width - w), y: b.y, width: w, height: h });
  });

  handlePanel('settings:get', () => ({
    ...settings.get(), latencyFile: latency.file(), build: buildInfo(), hotkeyErrors, activeHotkeys,
    defaultCommands: commandDefaults.DEFAULT_COMMANDS,
    defaults: { captureHotkey: settings.DEFAULTS.captureHotkey, selectionHotkey: settings.DEFAULTS.selectionHotkey },
  }));
  handlePanel('hotkeys:check', (_e, accelerator, forKey) => checkHotkey(accelerator, String(forKey || '')));
  handlePanel('open:diagnostics', () => shell.showItemInFolder(logFile()));
  handlePanel('settings:update', (_e, patch) => {
    const next = settings.update(patch);
    applyLoginItem();
    const failed = registerHotkeys();
    selection.setWatching(next.selectionBubble);
    if (!next.selectionBubble) hideBubble();
    return { settings: next, hotkeyErrors: failed };
  });
  handlePanel('models:list', () => api.listModels());
  handlePanel('providers:status', async () => {
    await secrets.whenLoaded();
    return { providers: settings.get().providers, keys: secrets.status(), keyProblem: secrets.problem() };
  });
  handlePanel('providers:fetchModels', (_e, provider, opts) => providers.fetchModels(String(provider), {
    apiKey: typeof opts?.apiKey === 'string' ? opts.apiKey.trim() : undefined,
    baseUrl: typeof opts?.baseUrl === 'string' ? opts.baseUrl.trim() : undefined,
  }));
  handlePanel('providers:speedTest', (_e, provider, model, opts) => providers.speedTest(String(provider), String(model), {
    apiKey: typeof opts?.apiKey === 'string' && opts.apiKey.trim() ? opts.apiKey.trim() : undefined,
    baseUrl: typeof opts?.baseUrl === 'string' && opts.baseUrl.trim() ? opts.baseUrl.trim() : undefined,
  }));
  // patch: { gemini|groq|local: { apiKey?, models?, baseUrl?, label? } }
  // apiKey: new key, '' to remove, undefined to keep.
  handlePanel('providers:save', async (_e, patch) => {
    for (const name of ['gemini', 'groq', 'local']) {
      if (typeof patch?.[name]?.apiKey === 'string') await secrets.set(name, patch[name].apiKey);
    }
    settings.update({ providers: patch || {} });
    return { providers: settings.get().providers, keys: secrets.status(), keyProblem: secrets.problem() };
  });
  handlePanel('update:status', () => updater.getState());
  handlePanel('update:check', () => updater.check({ manual: true }));
  handlePanel('update:install', () => updater.installNow());
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
    if (settings.get().localOnly && !String(body?.model).startsWith('local:')) {
      throw new Error('Local-only mode is on: choose a model from your local server, or turn the mode off in Settings.');
    }
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

// `--smoke-test=<file>`: boot every window of an installed build, check that
// its scripts and libraries loaded, write a JSON report and exit. Starts no
// tray, hotkeys or selection helper. Used by scripts/install-app.mjs.
async function runSmokeTest(outFile) {
  const report = { ok: true, checks: [] };
  const check = (name, pass, detail = '') => {
    report.checks.push({ name, pass, detail });
    if (!pass) report.ok = false;
  };
  const errors = [];
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) errors.push(`${path.basename(w.webContents.getURL().split('?')[0])}: ${e.message}`);
    });
  }
  // Each window gets 15 s to load (a locked screen can stall rendering), so
  // this reports a failure instead of hanging.
  const loaded = (w) => new Promise((resolve) => {
    if (!w.webContents.isLoading()) return resolve(true);
    const timer = setTimeout(() => resolve(false), 15000);
    w.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const loadResults = await Promise.all(wins.map(loaded));
  await new Promise((r) => setTimeout(r, 1500)); // let the panel finish its startup calls

  for (const [i, w] of wins.entries()) {
    const page = path.basename(w.webContents.getURL().split('?')[0]);
    if (!loadResults[i]) {
      check(`${page} loaded`, false, 'did not finish loading within 15 s (is the screen locked?)');
      continue;
    }
    const libs = page === 'panel.html' ? "&& typeof marked === 'object' && typeof DOMPurify === 'function' && typeof hljs === 'object' && typeof window.ip === 'object'" : '';
    const ok = await w.webContents.executeJavaScript(`typeof window.ipIcon === 'function' && document.querySelectorAll('svg.icon').length > 0 ${libs}`);
    check(`${page} loaded with icons${libs ? ' and libraries' : ''}`, ok);
  }
  const pages = wins.map((w) => path.basename(w.webContents.getURL().split('?')[0]));
  check('panel, overlay and Ask bar windows exist', ['panel.html', 'overlay.html', 'bubble.html'].every((p) => pages.includes(p)), pages.join(', '));
  const nativeDir = path.join(__dirname, 'native');
  check(app.isPackaged ? 'native helper exe bundled' : 'native helper source present',
    require('node:fs').existsSync(path.join(nativeDir, app.isPackaged ? 'IntelliPointerHelper.exe' : 'selection-helper.cs')));
  try {
    require.resolve('tesseract.js');
    check('OCR engine bundled', true);
  } catch (err) {
    check('OCR engine bundled', false, err.message);
  }
  check('no renderer console errors', errors.length === 0, errors.join(' | '));
  // Footprint at idle: all processes' memory and CPU over ~2 s.
  app.getAppMetrics(); // prime CPU counters
  await new Promise((r) => setTimeout(r, 2000));
  const metrics = app.getAppMetrics();
  report.memoryMB = Math.round(metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize || 0), 0) / 1024);
  report.idleCpuPercent = Math.round(metrics.reduce((sum, m) => sum + (m.cpu?.percentCPUUsage || 0), 0) * 10) / 10;
  report.processes = metrics.length;
  const pageByPid = new Map(BrowserWindow.getAllWindows().map((w) => [w.webContents.getOSProcessId(), path.basename(w.webContents.getURL().split('?')[0])]));
  report.breakdown = metrics.map((m) => ({
    type: m.type === 'Tab' ? `renderer:${pageByPid.get(m.pid) || '?'}` : m.name ? `${m.type}:${m.name}` : m.type,
    workingSetMB: Math.round((m.memory?.workingSetSize || 0) / 1024),
    privateMB: Math.round((m.memory?.privateBytes || 0) / 1024),
  }));
  report.privateMB = report.breakdown.reduce((n, p) => n + p.privateMB, 0);
  check(`idle CPU ${report.idleCpuPercent}% (under 2%)`, report.idleCpuPercent < 2);
  // Saved credentials survive updates: report whether they could be read back (never their values).
  await secrets.whenLoaded();
  const keyStatus = secrets.status();
  report.saved = { providerKeys: Object.keys(keyStatus).filter((n) => keyStatus[n].set) };
  report.build = buildInfo();
  require('node:fs').writeFileSync(outFile, JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

app.whenReady().then(async () => {
  if (!isPrimary) return;
  app.setAppUserModelId('dev.intellipointer.desktop');
  // The UI is local and needs no browser permissions (camera, location, notifications, ...).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // An earlier version kept an encrypted cloud sign-in token here; nothing uses it now.
  try { require('node:fs').rmSync(path.join(app.getPath('userData'), 'session.bin'), { force: true }); } catch { /* ignore */ }
  secrets.load(); // in the background; everything that needs a key waits for it
  if (SMOKE_TEST_OUT) {
    createPanel();
    createBubble();
    capture.init();
    registerIpc();
    await runSmokeTest(SMOKE_TEST_OUT);
    return;
  }
  log('app.start', { version: buildInfo().version, commit: buildInfo().commit, packaged: app.isPackaged });
  // Start the helper first: PowerShell needs a moment to load it.
  selection.events.on('selection', showBubble);
  selection.events.on('down', onGlobalMouseDown);
  selection.setWatching(settings.get().selectionBubble);
  selection.start();
  const failed = registerHotkeys();
  createPanel();
  createBubble();
  capture.init();
  createTray();
  registerIpc();
  updater.init({ onStateChange: updateTrayMenu }); // installed builds only
  if (failed.length) {
    new Notification({ title: 'IntelliPointer', body: `Shortcut already used by another app: ${failed.join(', ')}. Change it in Settings.` }).show();
  }
  applyLoginItem();
  if (!BACKGROUND_START) showPanel({ focus: true }); // opened by hand: show the panel so users find settings
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
