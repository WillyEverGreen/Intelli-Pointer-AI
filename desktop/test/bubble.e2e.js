// Electron test of the "Ask AI" selection bar and of the panel receiving
// selected text. Does not start the native selection helper.
// Run: npx electron test/bubble.e2e.js [outDir]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const outDir = process.argv[2] || path.join(__dirname, '..', '.test-output');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(outDir, 'userData-bubble'));

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const errors = [];
  const watch = (w) => w.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) errors.push(e.message);
  });

  // Same window options as main.js createBubble().
  const bubble = new BrowserWindow({
    width: 340, height: 50, show: false, frame: false, transparent: true, resizable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'bubble.js'), contextIsolation: true, sandbox: true },
  });
  watch(bubble);
  await bubble.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'bubble.html'));
  bubble.webContents.send('bubble:show', { preview: 'Report is a draft written against your rubric.' });
  bubble.showInactive();
  await wait(400);

  const fits = await bubble.webContents.executeJavaScript(`(() => { const r = document.getElementById('bar').getBoundingClientRect(); return { w: Math.round(r.right), h: Math.round(r.bottom) }; })()`);
  check(fits.w <= 340 && fits.h <= 50, `bar fits inside the 340x50 window (${fits.w}x${fits.h})`);
  check(!bubble.isFocused(), 'bubble does not take focus');

  const action = new Promise((r) => ipcMain.once('bubble:action', (_e, a) => r(a)));
  await bubble.webContents.executeJavaScript(`document.querySelector('[data-action="explain"]').click()`);
  check((await Promise.race([action, wait(2000).then(() => 'timeout')])) === 'explain', 'clicking Explain sends action "explain"');
  const ask = new Promise((r) => ipcMain.once('bubble:action', (_e, a) => r(a)));
  await bubble.webContents.executeJavaScript(`document.getElementById('ask').click()`);
  check((await Promise.race([ask, wait(2000).then(() => 'timeout')])) === null, 'clicking Ask AI sends no action (opens composer)');
  fs.writeFileSync(path.join(outDir, 'bubble.png'), (await bubble.webContents.capturePage()).toPNG());

  // Panel receives selected text (as main.js openWithText sends it).
  const settings = require('../src/main/settings');
  const h = (ch, fn) => ipcMain.handle(ch, fn);
  h('settings:get', () => settings.get());
  h('auth:status', () => ({ signedIn: false, secureStorage: true }));
  h('models:list', () => [{ id: 'gemini/x', label: 'Google Gemini · x', vision: true, webSearch: true }]);
  for (const ch of ['settings:update', 'usage:get', 'ask:cancel', 'ask:start', 'clipboard:write', 'panel:pin', 'panel:resize', 'panel:hide', 'open:latencyLog', 'capture:start', 'auth:signIn', 'auth:signOut']) h(ch, () => null);
  const panel = new BrowserWindow({ width: 460, height: 600, show: false, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'panel.js'), contextIsolation: true, sandbox: true } });
  watch(panel);
  await panel.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'panel.html'));
  await wait(500);
  panel.webContents.send('context:add', { contextId: 'c1', mode: 'replace', kind: 'selection', images: [], text: 'Report is a draft written against your rubric.', action: null });
  await wait(300);
  const st = await panel.webContents.executeJavaScript(`({ status: document.getElementById('ocr-status').textContent, privacy: document.getElementById('privacy').textContent, clip: document.querySelector('.clip-text')?.textContent })`);
  check(st.status === 'Selected text attached', `panel status: "${st.status}"`);
  check(/selected text/.test(st.privacy), `privacy notice: "${st.privacy}"`);
  check(st.clip === 'Report is a draft written against your rubric.', 'selected text shown in the panel');
  const hasSetting = await panel.webContents.executeJavaScript(`!!document.getElementById('s-selectionBubble')`);
  check(hasSetting, 'settings has the Ask-AI-bar toggle');

  check(errors.length === 0, `no renderer console errors ${errors.join(' | ')}`);
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
