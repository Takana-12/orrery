# Restarts Orrery after it has quit, optionally swapping in a freshly built app first.
# Started by the running app ("更新して再起動" / "再起動だけする" in settings), which then quits.
#   update-swap.ps1 -WaitPid <pid> -Exe <exe to start> -Log <file> [-Arguments <args>] [-WorkingDirectory <dir>] [-Release <repo>\release]
# With -Release, the new build waiting in <Release>\.staging\Orrery-win32-x64 replaces <Release>\Orrery-win32-x64 first;
# if that fails, the previous build is put back and started.
# Nothing has to be killed by hand: Orrery processes still running from the same folder after the wait are ended here,
# so the port and the single-instance lock are free when the new one starts.
param(
  [Parameter(Mandatory)][int]$WaitPid,
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$Log,
  [string]$Arguments = '',
  [string]$WorkingDirectory = '',
  [string]$Release = ''
)

# Never stand in the folder that is about to be renamed (Windows refuses to move a folder a process is "in").
Set-Location -LiteralPath ([IO.Path]::GetTempPath())
[Environment]::CurrentDirectory = [IO.Path]::GetTempPath()
function Write-Log([string]$m) { "$(Get-Date -Format o) $m" | Add-Content -LiteralPath $Log -Encoding utf8 }
$exeDir = Split-Path -Parent $Exe
$exeName = [IO.Path]::GetFileNameWithoutExtension($Exe)
# By name first: reading the path of every process on the machine can take most of a minute.
function Get-Leftovers { @(Get-Process -Name $exeName -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.Path -and (Split-Path -Parent $_.Path) -ieq $exeDir }) }

Write-Log "waiting for pid $WaitPid ($Exe)"
try { Wait-Process -Id $WaitPid -Timeout 20 -ErrorAction Stop } catch {}
# Helper processes (renderer, GPU) normally follow within a moment; whatever is still there after that is stuck.
for ($i = 0; $i -lt 20 -and (Get-Leftovers).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
$left = Get-Leftovers
if ($left.Count -gt 0) {
  Write-Log "ending $($left.Count) leftover process(es): $(($left | ForEach-Object { $_.Id }) -join ', ')"
  $left | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

$ok = $true
if ($Release) {
  $name = 'Orrery-win32-x64'
  $live = Join-Path $Release $name
  $next = Join-Path $Release ".staging\$name"
  $old = Join-Path $Release '.previous'
  $ok = $false
  if (-not (Test-Path -LiteralPath $next)) {
    Write-Log "no new build at $next"
  } else {
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
      $moved = $false
      try {
        if (Test-Path -LiteralPath $live) { Move-Item -LiteralPath $live -Destination $old -ErrorAction Stop; $moved = $true }
        Move-Item -LiteralPath $next -Destination $live -ErrorAction Stop
        $ok = $true
      } catch {
        Write-Log "retry ${i}: $_"
        if ($moved -and -not (Test-Path -LiteralPath $live)) { Move-Item -LiteralPath $old -Destination $live -ErrorAction SilentlyContinue }
        Get-Leftovers | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
    }
  }
  if ($ok) {
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $Release '.staging') -Recurse -Force -ErrorAction SilentlyContinue
    # The rest of "npm run install-app": the Start menu shortcut (it points at the same exe, so this only matters
    # when it is missing or was removed).
    try {
      $out = & (Join-Path $PSScriptRoot 'install-shortcuts.ps1') 2>&1
      Write-Log "shortcuts: $($out -join '; ')"
    } catch { Write-Log "shortcuts failed: $_" }
  }
}

$start = @{ FilePath = $Exe }
if ($Arguments) { $start.ArgumentList = $Arguments }
if ($WorkingDirectory) { $start.WorkingDirectory = $WorkingDirectory } else { $start.WorkingDirectory = $exeDir }
if (Test-Path -LiteralPath $Exe) {
  Start-Process @start
  Write-Log "started $Exe"
} else {
  Write-Log "not found: $Exe"
}
if ($ok) {
  Write-Log 'done'
} else {
  Write-Log 'update failed; previous build started'
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.Popup("Orrery を更新できませんでした。以前のバージョンで起動しています。`n詳細: $Log", 0, 'Orrery', 0x30)
}
