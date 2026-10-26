# Fallback launcher for the IntelliPointer native helper.
#
# Normally the app runs the compiled IntelliPointerHelper.exe (see
# selection-helper.cs and scripts/build-helper.js). This script is only used
# when that exe is missing and cannot be built: it compiles the same C# source
# in-process with PowerShell (slower to start, ~110 MB more memory).
param([int]$OwnPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'selection-helper.cs'))
Add-Type -TypeDefinition $source -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
[IPSelection]::Run($OwnPid, $true)
