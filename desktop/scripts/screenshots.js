// Captures the README / report screenshots from the real UI, driven through one
// realistic use case: a student hits a Python error, marks it, and gets an answer.
//   1 select    the frozen screen with the region marked
//   2 captured  the panel with the crop, local OCR and quick actions
//   3 answer    the streamed AI answer next to the original screen
//   4 settings  model sources (Cloud / 9Router / Gemini / Groq)
// Needs a Gemini key for the answer: set GEMINI_API_KEY in the environment.
// Run: npx electron scripts/screenshots.js [outDir]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'docs', 'screenshots'));
const W = 1280;
const H = 720;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ip-shots-')));

async function drag(wc, x1, y1, x2, y2) {
  wc.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x1 + ((x2 - x1) * i) / 12), y: Math.round(y1 + ((y2 - y1) * i) / 12), button: 'left' });
    await wait(16);
  }
  wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
  await wait(80);
}

app.on('window-all-closed', () => {}); // windows come and go between shots

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const settings = require('../src/main/settings');
  const secrets = require('../src/main/secrets');
  const api = require('../src/main/api');
  const ocr = require('../src/main/ocr');
  if (!process.env.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY to generate the answer screenshot.');
  await secrets.load();
  await secrets.set('gemini', process.env.GEMINI_API_KEY);
  settings.update({ providers: { gemini: { enabled: true, models: [{ id: 'gemini-flash-latest', vision: true }] } } });

  // ----- the stand-in desktop -----
  const screen = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, frame: false, alwaysOnTop: true, webPreferences: { backgroundThrottling: false } });
  await screen.loadFile(path.join(__dirname, 'demo-screen.html'));
  await wait(400);
  const trace = await screen.webContents.executeJavaScript(`(() => { const r = document.getElementById('trace').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const desktop = await screen.webContents.capturePage();
  screen.destroy();
  const { width: sw, height: sh } = desktop.getSize();
  const region = { x: trace.x - 8, y: trace.y - 2, width: Math.min(trace.w, 820), height: trace.h + 4 };

  // ----- 1. selection overlay -----
  const overlay = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: true, frame: false, alwaysOnTop: true,
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'), contextIsolation: true, sandbox: true },
  });
  await overlay.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'overlay.html'));
  overlay.webContents.send('overlay:show', { scaleFactor: sw / W });
  await wait(100);
  overlay.webContents.send('overlay:frame', { width: sw, height: sh, bitmap: desktop.toBitmap() });
  await wait(300);
  overlay.focus();
  await wait(150);
  await drag(overlay.webContents, region.x, region.y, region.x + region.width, region.y + region.height);
  await wait(250);
  fs.writeFileSync(path.join(outDir, '1-select-region.png'), (await overlay.webContents.capturePage()).toPNG());
  overlay.destroy();
  console.log('1-select-region.png');

  // ----- the panel, wired like panel.e2e.js -----
  const panel = new BrowserWindow({
    width: 460, height: 640, frame: false, alwaysOnTop: true, show: true,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'panel.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(_e, ...a));
  h('settings:get', () => settings.get());
  h('settings:update', (_e, p) => ({ settings: settings.update(p), hotkeyErrors: [] }));
  h('models:list', () => api.listModels());
  h('ask:cancel', (_e, id) => api.cancel(id));
  h('ask:start', async (e, { reqId, body, cacheable }) => {
    const r = await api.ask({ reqId, body, cacheable }, (event, data) => e.sender.send('ask:event', { reqId, event, data }));
    return { outcome: r.outcome };
  });
  h('providers:status', () => ({ providers: settings.get().providers, keys: secrets.status() }));
  h('hotkeys:check', () => ({ ok: true }));
  for (const ch of ['clipboard:write', 'panel:pin', 'panel:resize', 'panel:hide', 'open:latencyLog', 'open:diagnostics', 'capture:start']) h(ch, () => true);
  await panel.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'panel.html'));
  await wait(1800);
  const pjs = (code) => panel.webContents.executeJavaScript(code);

  // The full Flash model reads screenshots better than Flash-Lite.
  await pjs(`document.getElementById('model-button').click()`);
  await wait(150);
  await pjs(`(() => { const s = document.querySelector('.mm-search input'); s.value = 'flash-latest'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await wait(300);
  if (!(await pjs(`document.getElementById('model-menu').hidden`))) await pjs(`document.getElementById('model-button').click()`);
  await wait(200);

  // ----- 4. model sources in Settings (taken now: the panel is empty and idle) -----
  await pjs(`document.getElementById('btn-settings').click()`);
  await pjs(`document.querySelectorAll('[data-role="hint"]').forEach((el) => { el.style.visibility = 'hidden'; })`); // never publish the tail of a real key
  await wait(900);
  fs.writeFileSync(path.join(outDir, '4-settings-models.png'), (await panel.webContents.capturePage()).toPNG());
  console.log('4-settings-models.png');
  await pjs(`document.getElementById('btn-back').click()`);
  await wait(300);

  // ----- 2. captured region + local OCR -----
  const k = sw / W; // the display scale: the bitmap is larger than the CSS layout
  const crop = desktop.crop({ x: Math.round(region.x * k), y: Math.round(region.y * k), width: Math.round(region.width * k), height: Math.round(region.height * k) });
  const png = crop.toPNG();
  const base64 = png.toString('base64');
  panel.webContents.send('context:add', {
    contextId: 'ctx-shot', mode: 'replace', kind: 'screen', action: null, timings: { captureMs: 0 },
    images: [{ label: 'Region 1', width: crop.getSize().width, height: crop.getSize().height, mime: 'image/png', base64, bytes: png.length, dataUrl: `data:image/png;base64,${base64}` }],
  });
  const t0 = performance.now();
  const o = await ocr.recognize(png);
  panel.webContents.send('context:ocr', { contextId: 'ctx-shot', text: o.text, confidence: o.confidence, ocrMs: Math.round(performance.now() - t0) });
  await wait(500);
  const panel2 = await panel.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, '2-captured-and-ocr.png'), panel2.toPNG());
  console.log(`2-captured-and-ocr.png (OCR ${o.confidence}%)`);

  // ----- 3. streamed answer, shown beside the original screen -----
  await pjs(`[...document.querySelectorAll('#quick-actions button')].find((b) => b.textContent === 'Fix error').click()`);
  try {
  let done = false;
  for (let i = 0; i < 90 && !done; i++) {
    await wait(1000);
    done = await pjs(`!document.querySelector('.bubble.streaming') && !!document.querySelector('.msg.assistant .timing, .msg.assistant .error')`);
  }
  if (!done) throw new Error('the answer did not finish streaming');
  if (await pjs(`!!document.querySelector('.msg.assistant .error')`)) throw new Error('the answer ended with an error: ' + await pjs(`document.querySelector('.msg.assistant .error').textContent`));
  await pjs(`document.getElementById('conversation').scrollTop = 0`);
  await wait(400);
  const panel3 = await panel.webContents.capturePage();
  const comp = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, frame: false, alwaysOnTop: true, webPreferences: { backgroundThrottling: false } });
  const [pw, ph] = [panel3.getSize().width, panel3.getSize().height];
  const px = Math.round(W - pw / (panel3.getSize().width / 460) - 40);
  const html = `<body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#1e1e1e">
    <img src="${desktop.toDataURL()}" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px">
    <img src="${panel3.toDataURL()}" style="position:absolute;left:${px}px;top:28px;width:460px;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.12)"></body>`;
  await comp.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await wait(500);
  fs.writeFileSync(path.join(outDir, '3-ai-answer.png'), (await comp.webContents.capturePage()).toPNG());
  comp.destroy();
  console.log('3-ai-answer.png');
  } catch (err) {
    // A busy model must not lose the other shots; the previous answer image is kept.
    console.warn(`3-ai-answer.png skipped: ${err.message}`);
  }

  await ocr.shutdown();
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
