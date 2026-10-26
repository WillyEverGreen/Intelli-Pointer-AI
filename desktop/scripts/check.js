// Syntax-checks every JavaScript file the app ships, so a typo can never
// reach a running app as an error dialog. Run: npm run check
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'src'));
for (const extra of ['scripts', 'test']) {
  for (const f of fs.readdirSync(path.join(root, extra))) if (/\.(js|mjs)$/.test(f)) files.push(path.join(root, extra, f));
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✖ ${path.relative(root, f)}\n${r.stderr.trim()}\n`);
  }
}
console.log(failed ? `${failed} of ${files.length} files have syntax errors` : `✔ ${files.length} files parse cleanly`);
process.exit(failed ? 1 : 0);
