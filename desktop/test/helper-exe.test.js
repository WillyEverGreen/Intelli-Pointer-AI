// Tests the real compiled helper (IntelliPointerHelper.exe) in --no-hook mode:
// startup time, a BitBlt grab over the line protocol, and its memory use.
// Skips on non-Windows. Run: node --test test/helper-exe.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const isWindows = process.platform === 'win32';

test('compiled helper starts, grabs the screen, and stays small', { skip: !isWindows, timeout: 60000 }, async () => {
  const { build } = require('../scripts/build-helper');
  const exe = build(path.join(os.tmpdir(), `IntelliPointerHelper-test-${process.pid}.exe`));
  const t0 = Date.now();
  const child = spawn(exe, [String(process.pid), '--no-hook'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let pending = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      pending.push(chunk.subarray(start, nl));
      const msg = JSON.parse(Buffer.concat(pending).toString('utf8'));
      pending = [];
      start = nl + 1;
      lines.push(msg);
      for (const w of waiters.splice(0)) w();
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  const next = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 10000);
    const check = () => {
      const m = lines.find((l) => l.type === type);
      if (m) {
        clearTimeout(timer);
        lines.splice(lines.indexOf(m), 1);
        resolve(m);
      } else waiters.push(check);
    };
    check();
  });

  try {
    await next('ready');
    const startMs = Date.now() - t0;
    assert.ok(startMs < 3000, `starts quickly (${startMs} ms)`);

    const tGrab = Date.now();
    child.stdin.write('grab 7 0 0 320 200\n');
    const g = await next('grab');
    const roundTrip = Date.now() - tGrab;
    assert.equal(g.id, '7');
    assert.equal(g.width, 320);
    assert.equal(Buffer.from(g.data, 'base64').length, 320 * 200 * 4, 'BGRA pixels');
    assert.ok(roundTrip < 1000, `grab round trip ${roundTrip} ms`);

    // Full-screen-sized grab speed (1920x1080 worth of pixels).
    const tBig = Date.now();
    child.stdin.write('grab 8 0 0 1920 1080\n');
    const big = await next('grab');
    const bigMs = Date.now() - tBig;
    assert.equal(Buffer.from(big.data, 'base64').length, 1920 * 1080 * 4);

    await new Promise((r) => setTimeout(r, 500));
    const mem = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${child.pid}).PrivateMemorySize64 / 1MB`], { encoding: 'utf8' });
    const privateMB = Math.round(Number(mem.trim()));
    console.log(`  helper: ready in ${startMs} ms, 1080p grab round trip ${bigMs} ms, ${privateMB} MB private memory after grabs`);
    assert.ok(privateMB < 40, `helper uses ${privateMB} MB (PowerShell host used ~110-130 MB)`);
  } finally {
    child.stdin.write('exit\n');
    setTimeout(() => child.kill(), 500);
  }
});
