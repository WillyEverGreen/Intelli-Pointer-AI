// Builds IntelliPointer as a Windows app and installs (or updates) it for the
// current user, with Desktop and Start-menu shortcuts. Run after any change:
//
//   npm run app:install                 test, build, install, relaunch
//   npm run app:install -- --no-launch  ...without relaunching
//   npm run app:install -- --skip-tests
//   npm run app:build                   build into desktop/dist only
//
// Installs to %LOCALAPPDATA%\Programs\IntelliPointer AI (no admin rights).
// Settings and sign-in live in %APPDATA%\IntelliPointer AI and survive updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require('../package.json');
const APP = pkg.productName;
const args = new Set(process.argv.slice(2));
const buildOnly = args.has('--build-only');

if (process.platform !== 'win32') {
  console.error('IntelliPointer is a Windows app; run this on Windows.');
  process.exit(1);
}

const step = (msg) => console.log(`\n▶ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Tests
if (!args.has('--skip-tests')) {
  step('Syntax check');
  execSync('npm run check', { cwd: root, stdio: 'inherit' });
  step('Running unit tests');
  execSync('npm test', { cwd: root, stdio: 'inherit' });
  const electronBin = require('electron'); // path to the Electron executable
  const appTests = [
    ['Selected-text shortcut and clipboard handling', 'test/selection.e2e.js'],
    ['Overlay leaves itself out of screenshots', 'test/capture-exclusion.e2e.js'],
    ['Screen-region shortcut speed (briefly dims the screen)', 'test/capture.e2e.js'],
  ];
  for (const [label, file] of appTests) {
    step(`Testing: ${label}`);
    const r = spawnSync(electronBin, [file], { cwd: root, encoding: 'utf8', timeout: 90000 });
    const lines = `${r.stdout || ''}`.split(/\r?\n/).filter((l) => /^(PASS|FAIL|\s+round|grab)/.test(l));
    for (const l of lines) console.log(`  ${l.trim()}`);
    if (r.status !== 0 || !lines.length || lines.some((l) => l.startsWith('FAIL'))) {
      throw new Error(`${label}: test failed; not installing.`);
    }
  }
}

// 2. Generated assets: icon bundle, .exe icon, build stamp
step('Preparing assets');
execSync(`"${process.execPath}" scripts/build-icons.js`, { cwd: root, stdio: 'inherit' });
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
const { makeIco } = require('../src/main/icon.js');
const icoPath = path.join(buildDir, 'icon.ico');
fs.writeFileSync(icoPath, makeIco());

let commit = 'unknown';
let dirty = false;
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  dirty = execSync('git status --porcelain', { cwd: root }).toString().trim().length > 0;
} catch {
  /* not a git checkout */
}
const buildInfo = { version: pkg.version, commit: dirty ? `${commit}+changes` : commit, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'src', 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`  version ${buildInfo.version}, commit ${buildInfo.commit}`);

// 3. Package
step('Packaging (the first run downloads the Electron runtime, ~100 MB)');
const [appPath] = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  overwrite: true,
  platform: 'win32',
  arch: 'x64',
  name: APP,
  executableName: APP,
  appVersion: pkg.version,
  buildVersion: pkg.version,
  icon: icoPath,
  asar: false, // keeps the PowerShell helper and OCR worker files directly readable
  prune: true,
  ignore: [
    /^\/(test|scripts|dist|build|\.test-output)(\/|$)/,
    /^\/node_modules\/(lucide-static|@electron\/packager)(\/|$)/,
  ],
  win32metadata: { CompanyName: 'IntelliPointer', FileDescription: APP, ProductName: APP, InternalName: APP },
  quiet: true,
});
console.log(`  built ${appPath}`);

// Native helper: compiled C# (~16 MB RAM) instead of a PowerShell host.
const { build: buildHelper } = require('./build-helper.js');
buildHelper(path.join(appPath, 'resources', 'app', 'src', 'main', 'native', 'IntelliPointerHelper.exe'));
console.log('  built native helper');

// Lighter install: Chromium ships ~55 UI language packs; the app is English-only.
const localesDir = path.join(appPath, 'locales');
for (const f of fs.existsSync(localesDir) ? fs.readdirSync(localesDir) : []) {
  if (f !== 'en-US.pak') fs.rmSync(path.join(localesDir, f));
}
const dirSize = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`  app size: ${Math.round(dirSize(appPath) / 1048576)} MB`);

// Boots a built exe in --smoke-test mode (no tray, hotkeys or selection helper)
// and fails the run if any window or bundled library didn't load.
function smokeTest(exePath, label) {
  const out = path.join(os.tmpdir(), `intellipointer-smoke-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  spawnSync(exePath, [`--smoke-test=${out}`], { timeout: 60000, stdio: 'ignore' });
  let report;
  try {
    report = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    throw new Error(`${label}: the app did not start (no smoke-test report).`);
  }
  for (const c of report.checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass || !c.detail ? '' : ` — ${c.detail}`}`);
  if (report.memoryMB) console.log(`  footprint at idle: ${report.memoryMB} MB RAM across ${report.processes} processes, ${report.idleCpuPercent}% CPU`);
  if (!report.ok) throw new Error(`${label}: smoke test failed.`);
  return report;
}

step('Smoke-testing the build');
smokeTest(path.join(appPath, `${APP}.exe`), 'Built app');
if (buildOnly) process.exit(0);

// 4. Stop the running copy (and its helper processes) so files can be replaced
step('Closing the running app');
spawnSync('taskkill', ['/F', '/T', '/IM', `${APP}.exe`], { stdio: 'ignore' });
await sleep(800);

// 5. Install
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', APP);
step(`Installing to ${installDir}`);
for (let attempt = 1; ; attempt++) {
  try {
    fs.rmSync(installDir, { recursive: true, force: true });
    break;
  } catch (err) {
    if (attempt >= 10) throw new Error(`Could not replace ${installDir} (${err.code}). Close IntelliPointer and retry.`);
    await sleep(500);
  }
}
fs.cpSync(appPath, installDir, { recursive: true });
const exe = path.join(installDir, `${APP}.exe`);

// 6. Shortcuts (Desktop + Start menu). Paths go through env vars to avoid quoting issues.
step('Updating Desktop and Start menu shortcuts');
// Writes each shortcut, reads it back, and prints its target so the next step can verify it.
const ps = `
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $path = Join-Path $dir ($env:IP_APP + '.lnk')
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $env:IP_EXE
  $lnk.WorkingDirectory = $env:IP_DIR
  $lnk.IconLocation = $env:IP_EXE + ',0'
  $lnk.Description = 'Ask about anything on your screen'
  $lnk.Save()
  Write-Output ($path + '|' + $shell.CreateShortcut($path).TargetPath)
}`;
const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  env: { ...process.env, IP_APP: APP, IP_EXE: exe, IP_DIR: installDir },
  encoding: 'utf8',
});
if (res.status !== 0) throw new Error(`Shortcut creation failed: ${(res.stderr || '').trim()}`);
const shortcuts = res.stdout.trim().split(/\r?\n/).map((line) => line.split('|'));
for (const [lnk, target] of shortcuts) {
  const good = path.resolve(target) === path.resolve(exe);
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${lnk}`);
  if (!good) throw new Error(`${lnk} points to ${target}, expected ${exe}`);
}

// 7. Launch the installed app exactly as the shortcut does.
step('Verifying the installed app starts from the shortcut target');
const report = smokeTest(shortcuts[0][1], 'Installed app');
console.log(`  running build ${report.build.version} (${report.build.commit})`);

// 8. Relaunch
if (!args.has('--no-launch')) {
  step('Starting IntelliPointer');
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: installDir }).unref();
}
console.log(`\n✔ IntelliPointer ${buildInfo.version} (${buildInfo.commit}) installed.`);
