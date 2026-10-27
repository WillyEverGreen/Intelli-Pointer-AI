// The updater must be started on the normal launch path. (It was once wired
// into the smoke-test branch only, so installed apps never checked for updates.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

test('updater.init runs on the normal start path, after the IPC handlers exist', () => {
  assert.match(main, /createTray\(\);\s*registerIpc\(\);\s*updater\.init\(/);
  assert.strictEqual(main.match(/updater\.init\(/g).length, 1);
});

test('release builds publish to GitHub Releases', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.build.publish[0].provider, 'github');
  assert.match(pkg.build.win.artifactName, /^[^ ]+$/, 'artifact names must not contain spaces (GitHub renames them, breaking latest.yml)');
});
