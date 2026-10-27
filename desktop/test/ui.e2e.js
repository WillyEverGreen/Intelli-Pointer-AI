// UI test of the panel and the Ask bar with stubbed main-process handlers:
// model menu, settings tabs (models, commands, shortcuts, general), the
// commands editor and the Ask bar. Saves a screenshot of every state.
// Run: npx electron test/ui.e2e.js [outDir]   (IP_THEME=dark|light)
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

const outDir = process.argv[2] || path.join(__dirname, '..', '.test-output');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(outDir, `userData-ui-${process.pid}`));
// Same as the app (software rendering) unless IP_GPU=on.
if (process.env.IP_GPU !== 'on') app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (process.env.IP_THEME) nativeTheme.themeSource = process.env.IP_THEME;
  fs.mkdirSync(outDir, { recursive: true });
  const suffix = process.env.IP_THEME ? `-${process.env.IP_THEME}` : '';
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const errors = [];
  const watch = (w) => w.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) errors.push(e.message);
  });

  // ----- Ask bar -----
  const bubble = new BrowserWindow({
    width: 340, height: 50, show: false, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'bubble.js'), contextIsolation: true, sandbox: true },
  });
  watch(bubble);
  const resized = new Promise((r) => ipcMain.once('bubble:resize', (_e, w, h) => r({ w, h })));
  await bubble.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'bubble', 'bubble.html'));
  bubble.webContents.send('bubble:show', { preview: 'Report text', commands: [{ id: 'explain', name: 'Explain' }, { id: 'translate', name: 'Translate' }, { id: 'eli12', name: 'Explain like I’m 12' }] });
  const size = await Promise.race([resized, wait(2000).then(() => null)]);
  check(size && size.w > 200 && size.w < 600, `Ask bar sizes itself to its commands (${size?.w}x${size?.h})`);
  bubble.setSize(size?.w || 340, size?.h || 50);
  bubble.showInactive();
  await wait(300);
  const action = new Promise((r) => ipcMain.once('bubble:action', (_e, a) => r(a)));
  await bubble.webContents.executeJavaScript(`[...document.querySelectorAll('#commands button')].find((b) => b.textContent.includes('12')).click()`);
  check((await Promise.race([action, wait(2000).then(() => 'timeout')])) === 'eli12', 'custom command in the Ask bar sends its id');
  // capturePage can't read transparent windows in software rendering.
  try {
    fs.writeFileSync(path.join(outDir, `bubble${suffix}.png`), (await bubble.webContents.capturePage()).toPNG());
  } catch {
    console.log('  (Ask bar screenshot needs IP_GPU=on)');
  }

  // ----- Panel with stubbed main process -----
  const settings = require('../src/main/settings');
  const commands = require('../src/main/commands');
  const h = (ch, fn) => ipcMain.handle(ch, fn);
  h('settings:get', () => ({
    ...settings.get(),
    activeHotkeys: { captureHotkey: 'Alt+Shift+S', selectionHotkey: 'Alt+Shift+A' },
    hotkeyErrors: [],
    defaultCommands: commands.DEFAULT_COMMANDS,
    defaults: { captureHotkey: 'Alt+Shift+S', selectionHotkey: 'Alt+Shift+A' },
    build: { version: '0.1.0', commit: 'test', builtAt: new Date().toISOString() },
  }));
  h('settings:update', (_e, p) => ({ settings: settings.update(p), hotkeyErrors: [] }));
  h('models:list', () => ({
    models: [
      { id: 'local:gemini-3.8-flash', label: '9Router · gemini-3.8-flash', group: '9Router (this network)', vision: true, latencyMs: 640, direct: true, local: true },
      { id: 'local:claude-haiku-4.5', label: '9Router · claude-haiku-4.5', group: '9Router (this network)', vision: true, latencyMs: 1820, direct: true, local: true },
      { id: 'local:qwen3-coder', label: '9Router · qwen3-coder', group: '9Router (this network)', vision: false, latencyMs: 4300, direct: true, local: true },
      { id: 'gemini:gemini-flash-latest', label: 'Gemini · gemini-flash-latest', group: 'Gemini (your key)', vision: true, webSearch: true, direct: true },
    ],
    errors: [],
  }));
  const providerStatus = () => ({
    providers: { ...settings.get().providers, local: { ...settings.get().providers.local, baseUrl: 'http://127.0.0.1:20127/v1', label: '9Router', models: [{ id: 'gemini-3.8-flash', vision: true, latencyMs: 640 }, { id: 'claude-haiku-4.5', vision: true, latencyMs: 1820 }] } },
    keys: { gemini: { set: true, hint: '…a1b2' }, groq: { set: false, hint: '' }, local: { set: true, hint: '…9f3c' } },
  });
  h('providers:status', providerStatus);
  let providerSaves = 0;
  h('providers:save', () => { providerSaves += 1; return providerStatus(); });
  h('providers:fetchModels', () => []);
  h('update:status', () => ({ supported: false, status: 'idle', current: '1.0.0', message: '' }));
  h('hotkeys:check', (_e, acc) => (acc === 'Ctrl+Alt+Q' ? { ok: false, reason: 'Another app already uses this shortcut.' } : { ok: true }));
  for (const ch of ['ask:cancel', 'ask:start', 'clipboard:write', 'panel:pin', 'panel:resize', 'panel:hide', 'open:latencyLog', 'open:diagnostics', 'capture:start', 'auth:signIn', 'auth:signOut', 'providers:speedTest']) h(ch, () => null);

  const panel = new BrowserWindow({
    width: 460, height: 640, frame: false, alwaysOnTop: true, show: true,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'panel.js'), contextIsolation: true, sandbox: true },
  });
  watch(panel);
  await panel.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'panel.html'));
  await wait(600);
  const js = (code) => panel.webContents.executeJavaScript(code);
  // Screenshots are for visual review; capturePage needs GPU rendering (IP_GPU=on).
  const snap = async (name) => {
    await wait(350); // let the window repaint first
    try {
      fs.writeFileSync(path.join(outDir, `${name}${suffix}.png`), (await panel.webContents.capturePage()).toPNG());
    } catch {
      /* software rendering: no screenshot */
    }
  };

  // Empty state + shortcuts
  const keys = await js(`document.getElementById('hk-capture').textContent + ' / ' + document.getElementById('hk-selection').textContent`);
  check(keys === 'AltShiftS / AltShiftA', `empty state shows the new shortcuts (${keys})`);
  const chips = await js(`[...document.querySelectorAll('#quick-actions button')].map((b) => b.textContent)`);
  check(chips.length === commands.DEFAULT_COMMANDS.length, `one button per command (${chips.length})`);
  await snap('panel-empty');

  // Model menu
  const label = await js(`document.getElementById('model-button').textContent`);
  check(label.includes('gemini-3.8-flash'), `model button shows the current model (${label.trim()})`);
  await js(`document.getElementById('model-button').click()`);
  await wait(150);
  const groups = await js(`[...document.querySelectorAll('.mm-group')].map((g) => g.textContent)`);
  check(groups.join() === '9Router (this network),Gemini (your key)', `models grouped by source (${groups.join(', ')})`);
  await snap('model-menu');
  await js(`(() => { const s = document.querySelector('.mm-search input'); s.value = 'haiku'; s.dispatchEvent(new Event('input')); })()`);
  await wait(50);
  const filtered = await js(`document.querySelectorAll('.mm-item').length`);
  check(filtered === 1, 'search filters the model list');
  await js(`document.querySelector('.mm-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(50);
  check((await js(`document.getElementById('model-button').textContent`)).includes('claude-haiku-4.5'), 'Enter chooses the highlighted model');
  check(await js(`document.getElementById('model-menu').hidden`), 'menu closes after choosing');

  // Settings: Models
  await js(`document.getElementById('btn-settings').click()`);
  await wait(500);
  const sources = await js(`[...document.querySelectorAll('.source-row .strong')].map((s) => s.textContent)`);
  check(sources.join() === 'Gemini,Groq,9Router', `source list (${sources.join(', ')})`);
  const switches = await js(`document.querySelectorAll('.source-row .switch').length`);
  check(switches === 3, 'each source has a show-in-menu switch');
  // Credentials save themselves when you leave the field (no Save click needed).
  const savesBefore = providerSaves;
  await js(`(() => { const el = document.querySelector('.prov-pane[data-prov="gemini"] [data-role="key"]'); el.value = 'AIzaTestKey123'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(400);
  check(providerSaves > savesBefore, 'a typed credential is saved as soon as the field loses focus');
  await snap('settings-models');
  check((await js(`document.getElementById('update-status').textContent`)).includes('installed app'), 'Settings shows that updates work in the installed app (running from source here)');

  // Settings: Commands
  await js(`document.querySelector('[data-tab="commands"]').click()`);
  await wait(150);
  await snap('settings-commands');
  await js(`document.getElementById('btn-add-command').click()`);
  await wait(150);
  await js(`document.getElementById('cmd-name').value = 'Explain like I’m 12'; document.getElementById('cmd-prompt').value = 'Explain this simply, for a 12-year-old.';`);
  const sheet = await js(`(() => { const el = document.getElementById('command-editor'); const r = el.querySelector('.command-editor').getBoundingClientRect(); return { hidden: el.hidden, display: getComputedStyle(el).display, top: Math.round(r.top), height: Math.round(r.height) }; })()`);
  check(!sheet.hidden && sheet.display === 'flex' && sheet.height > 200, `command editor opens as a sheet (${JSON.stringify(sheet)})`);
  await wait(900);
  await snap('settings-command-editor');
  await js(`document.getElementById('btn-cmd-done').click()`);
  await wait(100);
  const names = await js(`[...document.querySelectorAll('.command-row .strong')].map((s) => s.textContent)`);
  check(names.at(-1).startsWith('Explain like'), 'new command added to the list');
  await js(`document.getElementById('btn-save').click()`);
  await wait(400);
  check(settings.get().commands.some((c) => c.name.startsWith('Explain like')), 'saved command persisted to settings');

  // Settings: Shortcuts
  await js(`document.querySelector('[data-tab="shortcuts"]').click()`);
  await wait(150);
  await snap('settings-shortcuts');
  const shortcutText = await js(`document.querySelector('#hk-capture-input .shortcut-button').textContent`);
  check(shortcutText === 'AltShiftS', `shortcut recorder shows Alt+Shift+S (${shortcutText})`);

  // Settings: General
  await js(`document.querySelector('[data-tab="general"]').click()`);
  await wait(150);
  await snap('settings-general');

  check(errors.length === 0, `no renderer console errors ${errors.join(' | ')}`);
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
