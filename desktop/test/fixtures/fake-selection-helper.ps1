# Test double for src/main/native/selection-helper.ps1: same stdin/stdout
# protocol, no mouse hook, no UI Automation, no keystrokes.
# On start it reports one mouse selection, then answers:
#   getsel <id>  -> sel-result with text "selected text from fake helper"
#   copy <id>    -> copy-sent skipped:true (as if the foreground app were a console)
param([int]$OwnPid = 0)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
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
  }
  [Console]::Out.Flush()
}
