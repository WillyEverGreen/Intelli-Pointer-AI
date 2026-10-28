// Saved API keys must survive a restart. Writes a key in one Electron process and reads it back in a
// fresh one (the original bug: keys saved by one run could not be read by the next).
// Run: npx electron test/secrets.e2e.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { app } = require('electron');

const [, , mode, dir] = process.argv;

if (mode === 'write' || mode === 'read' || mode === 'clear') {
  app.setPath('userData', dir);
  app.whenReady().then(async () => {
    const secrets = require('../src/main/secrets');
    await secrets.load();
    if (mode === 'write') await secrets.set('local', 'sk-test-roundtrip-ABCD');
    if (mode === 'clear') await secrets.set('local', '');
    const st = secrets.status().local;
    console.log(`RESULT ${JSON.stringify({ set: st.set, hint: st.hint, value: secrets.get('local'), problem: secrets.problem(), file: fs.existsSync(path.join(dir, 'provider-keys.dpapi')) })}`);
    app.exit(0);
  });
} else {
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-secrets-'));
  const run = (m) => {
    const r = spawnSync(process.execPath, [__filename, m, dirPath], { encoding: 'utf8', timeout: 60000 });
    const line = `${r.stdout}`.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    return line ? JSON.parse(line.slice(7)) : { error: r.stderr || 'no output' };
  };
  const w = run('write');
  check(w.set && w.file, 'a key is saved to disk');
  const raw = fs.readFileSync(path.join(dirPath, 'provider-keys.dpapi'), 'utf8');
  check(!raw.includes('sk-test-roundtrip'), 'the file does not contain the key in plain text');
  const r1 = run('read');
  check(r1.set && r1.value === 'sk-test-roundtrip-ABCD' && r1.hint === '…ABCD', 'a fresh process reads the key back (restart)');
  const r2 = run('read');
  check(r2.set && r2.value === 'sk-test-roundtrip-ABCD', 'and again on the next start');
  fs.writeFileSync(path.join(dirPath, 'provider-keys.dpapi'), 'not-a-valid-blob');
  const bad = run('read');
  check(!bad.set && /could not be read/.test(bad.problem), 'an unreadable file is reported instead of silently ignored');
  const cleared = run('clear');
  check(!cleared.set && !cleared.file, 'removing the key deletes the file');
  fs.rmSync(dirPath, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  process.exit(failures.length ? 1 : 0);
}
