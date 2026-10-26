# IntelliPointer selection helper (Windows only).
#
# A small long-running process that the Electron main process talks to over
# stdin/stdout (one JSON object per line). It:
#   - watches left-mouse drags / double-clicks with a low-level mouse hook and,
#     after each one, reads the *selected text* of the focused control through
#     Windows UI Automation (no keystrokes, clipboard untouched);
#   - on request, sends Ctrl+C (after the user's hotkey modifiers are released)
#     as a fallback for apps that do not expose their selection to UI Automation.
# Selected text is only reported to IntelliPointer on this PC; nothing is sent
# anywhere until the user clicks an action.
param([int]$OwnPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

public static class IPSelection {
    delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;
    const int WM_LBUTTONUP = 0x0202;
    const int DRAG_PX = 8;

    static LowLevelProc proc = HookProc; // keep a reference so the GC never collects it
    static readonly object outLock = new object();
    static int ownPid;
    static volatile bool watching = true;
    static int checking = 0;
    static POINT downPt;
    static long lastUpTicks = 0;
    static POINT lastUpPt;
    static bool doubleClick = false;

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    public static void Run(int pid) {
        ownPid = pid;
        // Per-monitor DPI aware: screen copies use real physical pixels.
        // (Low-level mouse hook coordinates are physical either way.)
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        Thread hookThread = new Thread(delegate () {
            string module = Process.GetCurrentProcess().MainModule.ModuleName;
            SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(module), 0);
            Application.Run(); // message loop required by low-level hooks
        });
        hookThread.IsBackground = true;
        hookThread.SetApartmentState(ApartmentState.STA);
        hookThread.Start();
        Emit("{\"type\":\"ready\"}");

        // Commands: "<name> <id>". Slow work runs on pool (MTA) threads, never on
        // this STA thread: UI Automation calls from an STA without a message
        // pump can stall, which made the hotkey time out.
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            string[] parts = line.Split(' ');
            string cmd = parts[0];
            string id = parts.Length > 1 ? parts[1] : "0";
            if (cmd == "getsel") {
                ThreadPool.QueueUserWorkItem(delegate (object s) {
                    long t0 = DateTime.UtcNow.Ticks;
                    string text = ReadSelection(false);
                    Emit("{\"type\":\"sel-result\",\"id\":\"" + id + "\",\"ms\":" + ((DateTime.UtcNow.Ticks - t0) / 10000) + ",\"text\":" + Json(text) + "}");
                });
            } else if (cmd == "copy") {
                ThreadPool.QueueUserWorkItem(delegate (object s) {
                    // Ctrl+C in a terminal with nothing selected would interrupt the running program.
                    if (ForegroundIsConsole()) {
                        Emit("{\"type\":\"copy-sent\",\"id\":\"" + id + "\",\"skipped\":true}");
                    } else {
                        SendCopy();
                        Emit("{\"type\":\"copy-sent\",\"id\":\"" + id + "\"}");
                    }
                });
            } else if (cmd == "grab" && parts.Length >= 6) {
                // grab <id> <x> <y> <w> <h>: copy a screen rectangle (physical px).
                int gx = int.Parse(parts[2]), gy = int.Parse(parts[3]), gw = int.Parse(parts[4]), gh = int.Parse(parts[5]);
                ThreadPool.QueueUserWorkItem(delegate (object s) { Grab(id, gx, gy, gw, gh); });
            } else if (line == "watch 1") {
                watching = true;
            } else if (line == "watch 0") {
                watching = false;
            } else if (line == "exit") {
                break;
            }
        }
    }

    static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
        // Never do slow work here: Windows drops hooks that take too long.
        if (nCode >= 0) {
            int msg = wParam.ToInt32();
            if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP) {
                MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if (msg == WM_LBUTTONDOWN) {
                    long now = DateTime.UtcNow.Ticks;
                    doubleClick = (now - lastUpTicks) < 4500000 && Math.Abs(info.pt.x - lastUpPt.x) < 6 && Math.Abs(info.pt.y - lastUpPt.y) < 6;
                    downPt = info.pt;
                    if (watching) Emit("{\"type\":\"down\",\"x\":" + info.pt.x + ",\"y\":" + info.pt.y + "}");
                } else {
                    lastUpTicks = DateTime.UtcNow.Ticks;
                    lastUpPt = info.pt;
                    bool dragged = Math.Abs(info.pt.x - downPt.x) >= DRAG_PX || Math.Abs(info.pt.y - downPt.y) >= DRAG_PX;
                    if (watching && (dragged || doubleClick)) {
                        POINT p = info.pt;
                        ThreadPool.QueueUserWorkItem(delegate (object state) { CheckSelection(p); });
                    }
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    static void CheckSelection(POINT p) {
        if (Interlocked.Exchange(ref checking, 1) == 1) return;
        try {
            Thread.Sleep(90); // let the app finish updating its selection
            uint fgPid;
            GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
            if (ownPid != 0 && fgPid == (uint)ownPid) return;
            string text = ReadSelection(true);
            if (!string.IsNullOrEmpty(text) && text.Trim().Length >= 2) {
                Emit("{\"type\":\"selection\",\"text\":" + Json(text) + ",\"x\":" + p.x + ",\"y\":" + p.y + "}");
            }
        } finally {
            Interlocked.Exchange(ref checking, 0);
        }
    }

    // Selected text of the focused control via UI Automation, or "" if none.
    static string ReadSelection(bool skipOwn) {
        try {
            AutomationElement el = AutomationElement.FocusedElement;
            if (el == null) return "";
            if (skipOwn && ownPid != 0 && el.Current.ProcessId == ownPid) return "";
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty)) return "";
            object pattern;
            for (int depth = 0; el != null && depth < 4; depth++) {
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                    TextPatternRange[] ranges = ((TextPattern)pattern).GetSelection();
                    StringBuilder sb = new StringBuilder();
                    foreach (TextPatternRange r in ranges) {
                        if (sb.Length > 0) sb.Append("\n");
                        sb.Append(r.GetText(20000));
                    }
                    return sb.ToString();
                }
                el = TreeWalker.ControlViewWalker.GetParent(el);
            }
        } catch (Exception) {
            // Many controls throw for unsupported patterns; treat as "no selection".
        }
        return "";
    }

    // Screen copy with GDI BitBlt: ~50 ms for 1080p, no warm-up, and windows
    // with content protection (our overlay) are left out by Windows.
    // Replies with raw BGRA pixels, base64, on one line. Nothing touches disk.
    static void Grab(string id, int x, int y, int w, int h) {
        try {
            long t0 = DateTime.UtcNow.Ticks;
            byte[] raw;
            using (var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            using (var g = System.Drawing.Graphics.FromImage(bmp)) {
                g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h), System.Drawing.CopyPixelOperation.SourceCopy);
                var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                raw = new byte[w * 4 * h];
                if (data.Stride == w * 4) {
                    Marshal.Copy(data.Scan0, raw, 0, raw.Length);
                } else {
                    for (int row = 0; row < h; row++) Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)row * data.Stride), raw, row * w * 4, w * 4);
                }
                bmp.UnlockBits(data);
            }
            long ms = (DateTime.UtcNow.Ticks - t0) / 10000;
            Emit("{\"type\":\"grab\",\"id\":\"" + id + "\",\"ms\":" + ms + ",\"width\":" + w + ",\"height\":" + h + ",\"data\":\"" + Convert.ToBase64String(raw) + "\"}");
        } catch (Exception e) {
            Emit("{\"type\":\"grab\",\"id\":\"" + id + "\",\"error\":" + Json(e.Message) + "}");
        }
    }

    static bool ForegroundIsConsole() {
        try {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            string name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
            string[] consoles = { "windowsterminal", "openconsole", "conhost", "cmd", "powershell", "pwsh", "wt", "mintty", "alacritty", "wezterm-gui" };
            return Array.IndexOf(consoles, name) >= 0;
        } catch (Exception) {
            return true; // unknown: be safe and don't send Ctrl+C
        }
    }

    // Sends Ctrl+C once the user has let go of the hotkey's modifier keys.
    // The user is usually still holding the hotkey's modifiers (Ctrl+Shift),
    // and Ctrl+Shift+C means something else in many apps. So Shift is
    // released synthetically right away instead of waiting for the user.
    // Alt/Win are waited for (briefly), since a synthetic Alt or Win release
    // can open a menu or the Start menu.
    static void SendCopy() {
        const uint KEYUP = 0x0002;
        int[] waitFor = { 0x12, 0x5B, 0x5C }; // Alt, LWin, RWin
        for (int i = 0; i < 25; i++) {
            bool held = false;
            foreach (int vk in waitFor) if ((GetAsyncKeyState(vk) & 0x8000) != 0) held = true;
            if (!held) break;
            Thread.Sleep(20);
        }
        foreach (byte vk in new byte[] { 0xA0, 0xA1 }) { // LShift, RShift
            if ((GetAsyncKeyState(vk) & 0x8000) != 0) keybd_event(vk, 0, KEYUP, UIntPtr.Zero);
        }
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x43, 0, 0, UIntPtr.Zero);
        keybd_event(0x43, 0, KEYUP, UIntPtr.Zero);
        keybd_event(0x11, 0, KEYUP, UIntPtr.Zero);
    }

    static void Emit(string json) {
        lock (outLock) {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    static string Json(string s) {
        if (s == null) s = "";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s) {
            switch (c) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20 || (int)c == 0x2028 || (int)c == 0x2029) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append("\"").ToString();
    }
}
'@

# Compile once and reuse: the DLL is cached per source hash under
# %LOCALAPPDATA%\IntelliPointer\helper-cache, so later starts skip the C# compiler.
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 16)
$cacheDir = Join-Path $env:LOCALAPPDATA 'IntelliPointer\helper-cache'
$dll = Join-Path $cacheDir "IPSelection-$hash.dll"
if (-not (Test-Path $dll)) {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $tmp = "$dll.$PID.tmp"
  Add-Type -TypeDefinition $source -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing -OutputAssembly $tmp -OutputType Library
  Move-Item -Force -Path $tmp -Destination $dll
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -Path $dll
[IPSelection]::Run($OwnPid)
