// Generated inputs for a release build: the icon bundle, the .exe icon and the
// build stamp shown in Settings. Run by `npm run dist` / `npm run release`.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

execSync(`"${process.execPath}" scripts/build-icons.js`, { cwd: root, stdio: 'inherit' });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const { makeIco } = require('../src/main/icon.js');
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), makeIco());

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {
  /* not a git checkout */
}
const info = { version: pkg.version, commit, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'src', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`prepared ${info.version} (${info.commit})`);
