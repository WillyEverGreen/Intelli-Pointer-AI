// Electron test of the "Ask AI" selection bar and of the panel receiving
// selected text. Does not start the native selection helper.
// Run: npx electron test/bubble.e2e.js [outDir]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

const outDir = process.argv[2] || path.join(__dirname, '..', '.test-output');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(outDir, 'userData-bubble'));

app.whenReady().then(async () => {
  if (process.env.IP_THEME) nativeTheme.themeSource = process.env.IP_THEME; // light | dark
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
  fs.writeFileSync(path.join(outDir, `bubble${process.env.IP_THEME ? '-' + process.env.IP_THEME : ''}.png`), (await bubble.webContents.capturePage()).toPNG());

  // Panel receives selected text (as main.js openWithText sends it).
  const settings = require('../src/main/settings');
  const h = (ch, fn) => ipcMain.handle(ch, fn);
  h('settings:get', () => settings.get());
  h('auth:status', () => ({ signedIn: false, secureStorage: true }));
  h('models:list', () => ({
    models: [
      { id: 'gemini:gemini-flash-latest', label: 'Gemini · gemini-flash-latest', group: 'Gemini (your key)', vision: true, webSearch: true, direct: true },
      { id: 'groq:llama-3.3-70b-versatile', label: 'Groq · llama-3.3-70b-versatile', group: 'Groq (your key)', vision: false, webSearch: false, direct: true },
    ],
    errors: [],
  }));
  const providerStatus = () => ({
    providers: settings.get().providers,
    keys: { gemini: { set: true, hint: '…a1b2' }, groq: { set: false, hint: '' }, local: { set: false, hint: '' } },
  });
  h('providers:status', providerStatus);
  h('providers:save', providerStatus);
  h('providers:fetchModels', () => ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.5-flash']
    .map((id) => ({ id, vision: true })));
  for (const ch of ['settings:update', 'usage:get', 'ask:cancel', 'ask:start', 'clipboard:write', 'panel:pin', 'panel:resize', 'panel:hide', 'open:latencyLog', 'capture:start', 'auth:signIn', 'auth:signOut']) h(ch, () => null);
  const panel = new BrowserWindow({ width: 460, height: 600, frame: false, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'panel.js'), contextIsolation: true, sandbox: true } });
  watch(panel);
  await panel.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'panel.html'));
  await wait(500);
  const longText = 'Android: Go to Settings > Network & internet > Internet (or Connections > Data usage) to see total mobile and Wi-Fi data consumption, set alerts, and review app-by-app usage. iPhone: Settings > Mobile Data shows usage per app since the last reset.';
  panel.webContents.send('context:add', { contextId: 'c1', mode: 'replace', kind: 'selection', images: [], text: longText, action: null });
  await wait(400);
  const st = await panel.webContents.executeJavaScript(`({ kind: document.getElementById('context-kind').textContent, privacy: document.getElementById('privacy').textContent, clip: document.getElementById('clip-text').textContent, more: !document.getElementById('clip-more').hidden, options: document.getElementById('context-options').hidden })`);
  check(st.kind === 'Selected text', `context card title: "${st.kind}"`);
  check(/selected text/.test(st.privacy) && /directly/.test(await panel.webContents.executeJavaScript(`document.getElementById('privacy').title`)), `privacy notice: "${st.privacy}"`);
  check(st.clip === longText, 'selected text shown in the panel');
  check(st.more, 'long text is clamped with a Show more link');
  check(st.options, 'image/OCR switches hidden for text-only context');
  const hasSetting = await panel.webContents.executeJavaScript(`!!document.getElementById('s-selectionBubble')`);
  check(hasSetting, 'settings has the Ask-AI-bar toggle');

  // Screenshots of each panel state for visual review.
  const suffix = process.env.IP_THEME ? `-${process.env.IP_THEME}` : '';
  const snap = async (name) => fs.writeFileSync(path.join(outDir, `${name}${suffix}.png`), (await panel.webContents.capturePage()).toPNG());
  await snap('panel-selection');
  await panel.webContents.executeJavaScript(`document.getElementById('btn-newchat').click()`);
  await wait(200);
  await snap('panel-empty');
  await panel.webContents.executeJavaScript(`document.getElementById('btn-settings').click()`);
  await wait(400);
  await panel.webContents.executeJavaScript(`document.querySelector('.prov-pane[data-prov="gemini"] [data-role="load"]').click()`);
  await wait(400);
  const picked = await panel.webContents.executeJavaScript(`[...document.querySelectorAll('.prov-pane[data-prov="gemini"] .model-row')].filter((r) => r.querySelector('input').checked).map((r) => r.textContent.replace('Images', '').trim())`);
  check(picked.join() === 'gemini-flash-latest,gemini-flash-lite-latest,gemini-pro-latest', `Load models preselects sensible defaults (${picked.join(', ')})`);
  await snap('panel-settings');
  await panel.webContents.executeJavaScript(`document.querySelector('[data-prov-tab="local"]').click()`);
  await wait(200);
  await snap('panel-settings-local');

  check(errors.length === 0, `no renderer console errors ${errors.join(' | ')}`);
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
