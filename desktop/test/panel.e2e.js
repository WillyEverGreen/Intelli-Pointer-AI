// Electron end-to-end test of the floating panel against a REAL backend.
// It wires the panel's IPC to the real api/settings/ocr modules (no capture,
// no tray, no global hotkeys), injects an image as if it had been captured,
// clicks a quick action, and waits for the streamed answer.
//
// Needs a backend on http://127.0.0.1:8080 (e.g. AUTH_DISABLED=true for local dev).
// Run: npx electron test/panel.e2e.js <image.png> [outDir]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

const imagePath = process.argv[2];
const outDir = process.argv[3] || path.join(__dirname, '..', '.test-output');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', path.join(outDir, 'userData')); // isolated settings/latency log

app.whenReady().then(async () => {
  if (process.env.IP_THEME) nativeTheme.themeSource = process.env.IP_THEME; // light | dark
  const settings = require('../src/main/settings');
  const auth = require('../src/main/auth');
  const api = require('../src/main/api');
  const ocr = require('../src/main/ocr');
  const latency = require('../src/main/latency');
  await auth.restore();
  settings.update({ providers: { cloud: { enabled: true } } }); // this test goes through the cloud backend
  fs.mkdirSync(outDir, { recursive: true });

  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };

  const win = new BrowserWindow({
    width: 460,
    height: 640,
    frame: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'panel.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) errors.push(e.message);
    else if (e.message.startsWith('CLICK')) console.log('  ', e.message);
  });

  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(_e, ...a));
  h('settings:get', () => settings.get());
  h('settings:update', (_e, p) => ({ settings: settings.update(p), hotkeyErrors: [] }));
  h('auth:status', () => auth.status());
  h('models:list', () => api.listModels());
  h('usage:get', () => api.usage());
  h('ask:cancel', (_e, id) => api.cancel(id));
  h('ask:start', async (e, { reqId, body, cacheable, meta }) => {
    const r = await api.ask({ reqId, body, cacheable }, (event, data) => e.sender.send('ask:event', { reqId, event, data }));
    latency.record({ timestamp: new Date().toISOString(), model: body.model, uploadBytes: r.timings.uploadBytes, firstTokenMs: r.timings.firstTokenMs, totalMs: r.timings.totalMs, outcome: r.outcome, ocrMs: meta?.ocrMs });
    return { outcome: r.outcome };
  });
  h('hotkeys:check', () => ({ ok: true }));
  for (const ch of ['clipboard:write', 'panel:pin', 'panel:resize', 'panel:hide', 'open:latencyLog', 'open:diagnostics', 'capture:start', 'auth:signIn', 'auth:signOut']) h(ch, () => true);

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'panel.html'));
  await wait(1500); // models load
  await win.webContents.executeJavaScript(`document.addEventListener('click', (e) => console.log('CLICK', e.target.id || e.target.textContent, 'trusted=' + e.isTrusted, e.clientX, e.clientY), true)`);
  // Open the model menu and read its entries.
  await win.webContents.executeJavaScript(`document.getElementById('model-button').click()`);
  await wait(100);
  const models = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.mm-name')].map((n) => n.textContent)`);
  check(models.length > 0, `panel loaded models from backend (${models.join(', ')})`);
  // Prefer the lighter model (less likely to be overloaded): search and press Enter.
  await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.mm-search input'); s.value = 'lite'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new KeyboardEvent('keydown', { key: models.some((m) => m.includes('lite')) ? 'Enter' : 'Escape', bubbles: true })); })()`.replace('models.some((m) => m.includes(\'lite\'))', String(models.some((m) => m.includes('lite')))));

  // Inject a "captured" region, then run real local OCR on it like main.js does.
  const png = fs.readFileSync(imagePath);
  const base64 = png.toString('base64');
  win.webContents.send('context:add', {
    contextId: 'ctx-test', mode: 'replace', kind: 'screen', action: null, timings: { captureMs: 0 },
    images: [{ label: 'Region 1', width: 420, height: 90, mime: 'image/png', base64, bytes: png.length, dataUrl: `data:image/png;base64,${base64}` }],
  });
  const t0 = performance.now();
  const o = await ocr.recognize(png);
  const ocrMs = Math.round(performance.now() - t0);
  console.log(`  OCR (${ocrMs} ms, ${o.confidence}%): ${JSON.stringify(o.text)}`);
  check(/range/.test(o.text), 'local OCR read the code text');
  win.webContents.send('context:ocr', { contextId: 'ctx-test', text: o.text, confidence: o.confidence, ocrMs });
  await wait(300);
  const privacy = await win.webContents.executeJavaScript(`document.getElementById('privacy').textContent`);
  check(/1 image/.test(privacy) && /OCR text/.test(privacy), `privacy notice lists what will be sent: "${privacy}"`);

  // Click the "Fix error" quick action.
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#quick-actions button')].find(b => b.textContent === 'Fix error').click()`);

  let answer = '';
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    const st = await win.webContents.executeJavaScript(`({
      streaming: !!document.querySelector('.bubble.streaming'),
      text: document.querySelector('.msg.assistant .bubble')?.innerText || '',
      timing: document.querySelector('.msg.assistant .timing')?.textContent || '',
      error: document.querySelector('.msg.assistant .error')?.textContent || '',
    })`);
    if (!st.streaming && (st.timing || st.error)) {
      answer = st.text;
      console.log(`  answer: ${JSON.stringify(st.text.slice(0, 200))}`);
      console.log(`  timing: ${st.timing}${st.error ? `  error: ${st.error}` : ''}`);
      check(!st.error, 'answer streamed without error');
      break;
    }
  }
  check(/print\(i\)/.test(answer), 'answer contains the fixed code');

  // Follow-up uses the existing context (no new capture).
  if (answer) {
    await win.webContents.executeJavaScript(`document.getElementById('input').value = 'What would that loop print last?'; document.getElementById('btn-send').click()`);
    for (let i = 0; i < 90; i++) {
      await wait(1000);
      const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.msg.assistant .timing, .msg.assistant .error').length`);
      if (n >= 2) break;
    }
    const last = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.msg.assistant .bubble')].pop().innerText`);
    console.log(`  follow-up: ${JSON.stringify(last.slice(0, 160))}`);
    check(/\b9\b/.test(last), 'follow-up answered from the same screenshot context');
  }

  console.log('  body class:', await win.webContents.executeJavaScript(`document.body.className + ' | collapse btn: ' + document.getElementById('btn-collapse').textContent + ' | msgs: ' + document.querySelectorAll('.msg').length + ' | conv display: ' + getComputedStyle(document.getElementById('conversation')).display + ' h=' + document.getElementById('conversation').offsetHeight`));
  fs.writeFileSync(path.join(outDir, `panel${process.env.IP_THEME ? '-' + process.env.IP_THEME : ''}.png`), (await win.webContents.capturePage()).toPNG());
  check(errors.length === 0, `no renderer console errors ${errors.join(' | ')}`);
  await ocr.shutdown();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
