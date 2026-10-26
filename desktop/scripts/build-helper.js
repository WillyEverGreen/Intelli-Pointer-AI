// Compiles src/main/native/selection-helper.cs into a small standalone exe
// with the C# compiler that ships with Windows (.NET Framework 4.x), so the
// helper no longer needs a PowerShell host (~110 MB less RAM).
//
// Used two ways:
//   - by scripts/install-app.mjs, which builds it into the packaged app;
//   - at runtime by src/main/selection.js when running from source, caching
//     the exe under %LOCALAPPDATA%\IntelliPointer\helper by source hash.
//
// CLI: node scripts/build-helper.js <out.exe>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'src', 'main', 'native', 'selection-helper.cs');
const WINDIR = process.env.WINDIR || 'C:\\Windows';

function findCsc() {
  for (const dir of ['Framework64', 'Framework']) {
    const csc = path.join(WINDIR, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

// UI Automation assemblies live in the GAC, not next to csc.exe.
function gacAssembly(name) {
  const base = path.join(WINDIR, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  if (!fs.existsSync(base)) return null;
  for (const version of fs.readdirSync(base)) {
    const dll = path.join(base, version, `${name}.dll`);
    if (fs.existsSync(dll)) return dll;
  }
  return null;
}

function sourceHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex').slice(0, 16);
}

// Compiles the helper to `outPath`. Throws with the compiler output on failure.
function build(outPath) {
  const csc = findCsc();
  if (!csc) throw new Error('C# compiler (.NET Framework 4) not found.');
  const refs = ['UIAutomationClient', 'UIAutomationTypes'].map((n) => {
    const dll = gacAssembly(n);
    if (!dll) throw new Error(`${n}.dll not found in the GAC.`);
    return `-r:${dll}`;
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  execFileSync(csc, [
    '-nologo', '-optimize+', '-target:exe', '-platform:anycpu', `-out:${tmp}`,
    ...refs, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', SOURCE,
  ], { stdio: 'pipe', windowsHide: true });
  fs.renameSync(tmp, outPath);
  return outPath;
}

// Path of a built helper for the current source, compiling it if needed.
function ensureCached() {
  const dir = path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), 'IntelliPointer', 'helper');
  const exe = path.join(dir, `IntelliPointerHelper-${sourceHash()}.exe`);
  return fs.existsSync(exe) ? exe : build(exe);
}

module.exports = { build, ensureCached, findCsc, SOURCE };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', 'build', 'IntelliPointerHelper.exe');
  console.log(`built ${build(out)}`);
}
