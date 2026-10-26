# Test double for src/main/native/selection-helper.ps1: same stdin/stdout
# protocol, no mouse hook, no UI Automation, no keystrokes.
# On start it reports one mouse selection, then answers:
#   getsel <id>             -> sel-result with text "selected text from fake helper"
#   copy <id>               -> copy-sent skipped:true (as if the foreground app were a console)
#   grab <id> <x> <y> <w> <h> -> a real BitBlt screen copy, same code as the helper
param([int]$OwnPid = 0)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FakeGrab {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } }
  public static string Grab(string id, int x, int y, int w, int h) {
    long t0 = DateTime.UtcNow.Ticks;
    byte[] raw;
    using (var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h), System.Drawing.CopyPixelOperation.SourceCopy);
      var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
      raw = new byte[w * 4 * h];
      Marshal.Copy(data.Scan0, raw, 0, raw.Length);
      bmp.UnlockBits(data);
    }
    long ms = (DateTime.UtcNow.Ticks - t0) / 10000;
    return "{\"type\":\"grab\",\"id\":\"" + id + "\",\"ms\":" + ms + ",\"width\":" + w + ",\"height\":" + h + ",\"data\":\"" + Convert.ToBase64String(raw) + "\"}";
  }
}
'@
[FakeGrab]::Init()
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.WriteLine('{"type":"selection","text":"mouse-selected text","x":10,"y":20}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(' ')
  $cmd = $parts[0]; $id = if ($parts.Length -gt 1) { $parts[1] } else { '0' }
  if ($cmd -eq 'exit') { break }
  if ($cmd -eq 'getsel') {
    [Console]::Out.WriteLine('{"type":"sel-result","id":"' + $id + '","ms":3,"text":"selected text from fake helper"}')
  } elseif ($cmd -eq 'copy') {
    [Console]::Out.WriteLine('{"type":"copy-sent","id":"' + $id + '","skipped":true}')
  } elseif ($cmd -eq 'grab') {
    [Console]::Out.WriteLine([FakeGrab]::Grab($id, [int]$parts[2], [int]$parts[3], [int]$parts[4], [int]$parts[5]))
  }
  [Console]::Out.Flush()
}
