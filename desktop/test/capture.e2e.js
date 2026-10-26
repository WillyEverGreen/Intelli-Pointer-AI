// End-to-end timing of the real capture module: hotkey-equivalent call ->
// overlay visible -> screenshot frozen in -> confirm before/after the frame.
// Briefly dims the screen; keeps nothing (crops are discarded).
// Run: npx electron test/capture.e2e.js
const path = require('node:path');
const { app, ipcMain, BrowserWindow } = require('electron');

// Real BitBlt grabs through the real compiled helper, minus its mouse hook.
process.env.IP_HELPER_NO_HOOK = '1';

app.setPath('userData', path.join(require('node:os').tmpdir(), `intellipointer-capture-test-${process.pid}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.IP_GPU === 'off') app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const capture = require('../src/main/capture');
  ipcMain.on('overlay:confirm', (e, payload) => capture.onOverlayConfirm(e.sender, payload));
  ipcMain.on('overlay:cancel', () => capture.cancel());
  let shownAt = 0;
  ipcMain.on('overlay:shown', () => {
    shownAt = performance.now();
    capture.onOverlayShown();
  });
  const selection = require('../src/main/selection');
  selection.start();
  capture.init();
  await wait(1500); // overlays pre-load at app start
  check(selection.isAvailable(), 'helper ready for fast screen copies');

  const overlayWin = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html'));
  const state = () => overlayWin().webContents.executeJavaScript('window.__overlayState()');

  for (const round of [1, 2, 3]) {
    if (round === 3) await wait(15000); // after idling: Electron's grabber used to take ~2.4 s here
    const t0 = performance.now();
    shownAt = 0;
    const pending = capture.startSelection();
    while (!shownAt && performance.now() - t0 < 5000) await wait(5);
    const visibleMs = Math.round(shownAt - t0);
    check(overlayWin().isVisible() && shownAt > 0, `round ${round}: overlay painted on screen ${visibleMs} ms after the hotkey`);
    // Confirm immediately, before the screenshot is in: must wait for it, not fail.
    await overlayWin().webContents.executeJavaScript("document.getElementById('ask').click()");
    const result = await pending;
    const totalMs = Math.round(performance.now() - t0);
    check(result && result.regions.length === 1 && result.regions[0].width > 100, `round ${round}: confirm before the frame still returns a full-resolution crop (${result?.regions[0].width}x${result?.regions[0].height})`);
    console.log(`  round ${round}: overlay shown ${result?.overlayShownMs} ms, screenshot in ${result?.captureMs} ms, crop ready ${totalMs} ms`);
    check(visibleMs < 100, `round ${round}: overlay appears in under 100 ms`);
    check(result?.captureMethod === 'bitblt', `round ${round}: fast BitBlt path used (${result?.captureMethod})`);
    check(result?.captureMs < 400, `round ${round}: screenshot ready in under 400 ms`);
    check(totalMs < 1000, `round ${round}: hotkey to finished crop in under 1 s (${totalMs} ms)`);
    await wait(400);
    check(!overlayWin().isVisible(), `round ${round}: overlay hidden after confirm`);
    const st = await state();
    check(!st.active && !st.hasFrame, `round ${round}: overlay reset (no stale frame for next time)`);
  }

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
