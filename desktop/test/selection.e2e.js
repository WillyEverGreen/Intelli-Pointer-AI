// Tests the selected-text hotkey plumbing (src/main/selection.js) against a
// fake helper that speaks the real protocol. Run: npx electron test/selection.e2e.js
const path = require('node:path');
const { app } = require('electron');

process.env.IP_SELECTION_HELPER_TEST = path.join(__dirname, 'fixtures', 'fake-selection-helper.ps1');
app.setPath('userData', path.join(require('node:os').tmpdir(), `intellipointer-selection-test-${process.pid}`));

app.whenReady().then(async () => {
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const selection = require('../src/main/selection');
  const t0 = Date.now();
  selection.start();
  while (!selection.isAvailable() && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
  check(selection.isAvailable(), `helper became ready (${Date.now() - t0} ms)`);

  let t = Date.now();
  const a = await selection.readViaAutomation();
  check(a.text === 'selected text from fake helper' && !a.timedOut, `selected text read via automation in ${Date.now() - t} ms`);
  check(Date.now() - t < 300, 'automation read is fast when the helper answers');

  // Two requests in flight are matched by id, not by order.
  const [x, y] = await Promise.all([selection.readViaAutomation(), selection.readViaAutomation()]);
  check(x.text && y.text, 'concurrent requests both resolve');

  // The tests below use the real system clipboard: keep the user's contents safe.
  const { clipboard, ClipboardItem } = require('electron');
  const clip = require('../src/main/clipboard');
  const usersClipboard = await clip.snapshot();
  // If another program is holding the Windows clipboard open, nothing can be
  // tested here; say so instead of reporting false failures.
  await clipboard.writeText('intellipointer-probe').catch(() => {});
  const clipboardWorks = (await clipboard.readText().catch(() => '')) === 'intellipointer-probe';
  if (!clipboardWorks) console.log('SKIP clipboard checks: the Windows clipboard is locked by another program right now');
  if (clipboardWorks) try {
    // Copy fallback skipped (fake reports a console window): clipboard must be restored.
    await clipboard.writeText('user clipboard contents');
    const c = await selection.readViaCopy();
    check(c.skipped && c.text === '', 'Ctrl+C fallback skipped for consoles (no throw on the async clipboard API)');
    check((await clipboard.readText()) === 'user clipboard contents', "user's text clipboard restored after the copy attempt");

    // Image + HTML survive a snapshot/restore round trip, and images read back as PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    const snap = await clip.snapshot();
    await clipboard.writeText('temporary');
    await clip.restore(snap);
    const back = await clip.readImagePng();
    check(back && back.subarray(1, 4).toString() === 'PNG', 'clipboard image restored and read back as PNG');
    await clipboard.write([new ClipboardItem({ 'text/plain': 'plain', 'text/html': '<b>rich</b>' })]);
    const snap2 = await clip.snapshot();
    clipboard.clear();
    await clip.restore(snap2);
    const items = await clipboard.read();
    check(items.some((i) => i.types.includes('text/html')) && (await clipboard.readText()) === 'plain', 'text + HTML restored together');
  } finally {
    await clip.restore(usersClipboard);
  }

  // The fake reported a mouse selection on start; it backs the last-resort fallback.
  check(selection.recentSelection() === 'mouse-selected text', 'recent mouse selection remembered for fallback');
  check(selection.recentSelection(0) === '', 'stale mouse selections are ignored');

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  selection.stop();
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
});
