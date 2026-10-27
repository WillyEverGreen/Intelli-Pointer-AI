// electron-builder hook: compile the native selection helper (C#, built with the
// compiler that ships with Windows) into the packaged app.
const path = require('node:path');
const { build } = require('./build-helper.js');

exports.default = async function afterPack(context) {
  const out = path.join(context.appOutDir, 'resources', 'app', 'src', 'main', 'native', 'IntelliPointerHelper.exe');
  build(out);
  console.log(`  built native helper -> ${path.relative(context.appOutDir, out)}`);
};
