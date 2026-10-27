// Boots a built app in --smoke-test mode (no tray or hotkeys) and fails if any
// window or bundled library did not load.   node scripts/smoke-test.js <app folder>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.resolve(process.argv[2] || '');
const exe = path.join(dir, 'IntelliPointer AI.exe');
if (!fs.existsSync(exe)) {
  console.error(`No app found at ${exe}`);
  process.exit(1);
}
const out = path.join(os.tmpdir(), `intellipointer-smoke-${process.pid}.json`);
fs.rmSync(out, { force: true });
spawnSync(exe, [`--smoke-test=${out}`], { timeout: 90000, stdio: 'ignore' });
let report;
try {
  report = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  console.error('The app did not start (no smoke-test report).');
  process.exit(1);
}
for (const c of report.checks) console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass || !c.detail ? '' : ` - ${c.detail}`}`);
console.log(`build ${report.build.version} (${report.build.commit}), ${report.memoryMB} MB RAM, ${report.idleCpuPercent}% idle CPU`);
process.exit(report.ok ? 0 : 1);
