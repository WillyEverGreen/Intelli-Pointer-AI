// Electron end-to-end test of the selection overlay, isolated from the real
// desktop: feeds a synthetic "screenshot", simulates mouse/keyboard input into
// the overlay window only, and checks the confirmed crops.
// Run: npx electron test/overlay.e2e.js [outDir]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

const outDir = process.argv[2] || path.join(__dirname, '..', '.test-output');
const W = 1000;
const H = 640;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function syntheticBitmap(w, h) {
  // BGRA gradient with a dark "text" bar, like Windows' native capture format.
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bar = y > 280 && y < 320 && x > 150 && x < 600;
      buf[i] = bar ? 30 : 255 - (x % 256); // B
      buf[i + 1] = bar ? 30 : (y % 256); // G
      buf[i + 2] = bar ? 30 : 200; // R
      buf[i + 3] = 255;
    }
  }
  return buf;
}

async function drag(wc, x1, y1, x2, y2, modifiers = []) {
  wc.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1, modifiers });
  for (let i = 1; i <= 10; i++) {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x1 + ((x2 - x1) * i) / 10), y: Math.round(y1 + ((y2 - y1) * i) / 10), button: 'left', modifiers });
    await wait(16);
  }
  wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1, modifiers });
  await wait(50);
}

async function key(wc, keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'char', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await wait(50);
}

app.whenReady().then(async () => {
  if (process.env.IP_THEME) nativeTheme.themeSource = process.env.IP_THEME; // light | dark
  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };

  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: true,
    frame: false,
    alwaysOnTop: true, // an occluded window stops painting on Windows
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'), contextIsolation: true, sandbox: true },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) consoleErrors.push(e.message);
    else console.log('[renderer]', e.level, e.message);
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay.html'));

  const ready = new Promise((r) => ipcMain.once('overlay:ready', r));
  // Simulate a 1.5x-scaled display: physical bitmap is 1.5x the CSS size.
  const scale = 1.5;
  const pw = Math.round(W * scale);
  const ph = Math.round(H * scale);
  win.webContents.send('overlay:start', { width: pw, height: ph, bitmap: syntheticBitmap(pw, ph), scaleFactor: scale });
  await ready;
  check(true, 'overlay painted and signalled ready');
  win.focus();
  await wait(100);

  const wc = win.webContents;
  const state = async (label) => {
    const st = await wc.executeJavaScript('window.__overlayState()');
    console.log(`  [${label}] tool=${st.tool}`, st.ops.map((o) => `${o.type}:${o.shape || ''}@${Math.round(o.x ?? o.x1 ?? o.points?.[0]?.[0])},${Math.round(o.y ?? o.y1 ?? o.points?.[0]?.[1])}`).join(' '));
  };
  await drag(wc, 100, 150, 400, 350); // rectangle region
  await state('rectangle region');
  await key(wc, 'E');
  await drag(wc, 500, 150, 700, 300); // ellipse region
  await state('ellipse region');
  await key(wc, 'A');
  await drag(wc, 850, 500, 650, 320); // arrow annotation
  await state('arrow annotation');
  await key(wc, 'B');
  await drag(wc, 150, 280, 250, 320); // blur inside region 1
  await state('blur inside region 1');
  await key(wc, 'L');
  await drag(wc, 750, 400, 900, 450); // lasso (thin diagonal: too small → closes as a valid polygon)
  await state('lasso (thin diagonal');
  await key(wc, 'Z', ['control']); // undo the lasso
  await state('undo the lasso');
  await drag(wc, 200, 200, 300, 260); // move region 1 by +100,+60
  await state('move region 1 by +10');
  await wait(100);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `overlay-drawn${process.env.IP_THEME ? '-' + process.env.IP_THEME : ''}.png`), shot.toPNG());

  const confirmed = new Promise((r) => ipcMain.once('overlay:confirm', (_e, p) => r(p)));
  await key(wc, 'Return');
  const payload = await Promise.race([confirmed, wait(5000).then(() => null)]);
  check(Boolean(payload), 'Enter confirms the selection');
  if (payload) {
    check(payload.regions.length === 2, `two regions captured (got ${payload.regions.length})`);
    const [r1, r2] = payload.regions;
    check(r1.shape === 'rect' && r2.shape === 'ellipse', 'region shapes are rect + ellipse');
    check(r1.bbox.x === 200 && r1.bbox.y === 210, `region 1 was moved to 200,210 (got ${r1.bbox.x},${r1.bbox.y})`);
    // ±2px: input coordinates are rounded through the monitor's own DPI scaling.
    const near = (a, b) => Math.abs(a - b) <= 2;
    check(near(r1.width, 300 * scale) && near(r1.height, 200 * scale), `region 1 cropped at physical resolution (${r1.width}x${r1.height})`);
    check(Buffer.from(r1.png).subarray(1, 4).toString() === 'PNG', 'crop is a PNG');
    payload.regions.forEach((r, i) => fs.writeFileSync(path.join(outDir, `region-${i + 1}.png`), Buffer.from(r.png)));
  }
  check(consoleErrors.length === 0, `no renderer console errors ${consoleErrors.join(' | ')}`);

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  console.log(`images in ${outDir}`);
  app.exit(failures.length ? 1 : 0);
});
