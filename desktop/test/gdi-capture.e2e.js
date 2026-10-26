// Checks the GDI (BitBlt) screen copy used by the selection helper:
// speed, and that content-protected windows (our overlay) are left out.
// Uses a standalone PowerShell snippet, not the helper. Saves nothing.
// Run: npx electron test/gdi-capture.e2e.js
const { app, BrowserWindow, screen } = require('electron');
const { spawnSync } = require('node:child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PS = `
Add-Type -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Diagnostics;
public static class GdiProbe {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public static string Run(int x, int y, int w, int h, int rx, int ry, int gx, int gy) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    var times = new System.Collections.Generic.List<long>();
    string result = "";
    for (int i = 0; i < 3; i++) {
      var sw = Stopwatch.StartNew();
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
      using (var g = Graphics.FromImage(bmp)) {
        g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOptions());
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] raw = new byte[data.Stride * h];
        Marshal.Copy(data.Scan0, raw, 0, raw.Length);
        bmp.UnlockBits(data);
        string b64 = Convert.ToBase64String(raw);
        times.Add(sw.ElapsedMilliseconds);
        Color r = Px(raw, data.Stride, rx, ry), gr = Px(raw, data.Stride, gx, gy);
        result = String.Format("red={0},{1},{2} green={3},{4},{5} b64len={6}", r.R, r.G, r.B, gr.R, gr.G, gr.B, b64.Length);
      }
    }
    return String.Join("/", times) + " ms | " + result;
  }
  static CopyPixelOperation CopyPixelOptions() { return CopyPixelOperation.SourceCopy; }
  static Color Px(byte[] raw, int stride, int x, int y) { int i = y * stride + x * 4; return Color.FromArgb(raw[i + 2], raw[i + 1], raw[i]); }
}
'@ -ReferencedAssemblies System.Drawing
[GdiProbe]::Run(%ARGS%)
`;

function makeWindow(x, color, protect) {
  const win = new BrowserWindow({ x, y: 40, width: 120, height: 120, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: color });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (protect) win.setContentProtection(true);
  win.loadURL(`data:text/html,<body style="margin:0;background:${color}"></body>`);
  return win;
}

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor;
  const a = makeWindow(d.bounds.x + 40, '#ff0000', true);
  const b = makeWindow(d.bounds.x + 200, '#00ff00', false);
  await wait(500);
  a.showInactive();
  b.showInactive();
  await wait(600);
  const W = Math.round(d.bounds.width * sf);
  const H = Math.round(d.bounds.height * sf);
  const args = [0, 0, W, H, Math.round(100 * sf), Math.round(100 * sf), Math.round(260 * sf), Math.round(100 * sf)].join(',');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS.replace('%ARGS%', args)], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '').trim();
  console.log(`physical ${W}x${H}: ${out}${r.stderr ? ` | stderr: ${r.stderr.trim().slice(0, 300)}` : ''}`);
  const m = /red=(\d+),(\d+),(\d+) green=(\d+),(\d+),(\d+)/.exec(out);
  if (m) {
    const [, rr, rg, rb, gr, gg, gb] = m.map(Number);
    console.log(`${!(rr > 200 && rg < 60 && rb < 60) ? 'PASS' : 'FAIL'} protected window excluded from BitBlt capture`);
    console.log(`${gg > 200 && gr < 60 && gb < 60 ? 'PASS' : 'FAIL'} normal window captured (control)`);
  }
  app.exit(0);
});
