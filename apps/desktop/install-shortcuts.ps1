# Registers the packaged app in the Start menu (and optionally on the desktop) for the current user.
#   powershell -ExecutionPolicy Bypass -File apps\desktop\install-shortcuts.ps1 [-Desktop] [-Remove]
# Nothing is copied: the shortcuts point at release\Orrery-win32-x64\Orrery.exe in this folder.
param([switch]$Desktop, [switch]$Remove)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $root 'release\Orrery-win32-x64\Orrery.exe'
$targets = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Orrery.lnk'))
if ($Desktop -or $Remove) { $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Orrery.lnk') }

# The app used to be called "Control Room": clear its shortcuts so there are not two entries.
foreach ($old in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Control Room.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Control Room.lnk'))) { if (Test-Path $old) { Remove-Item $old -Confirm:$false; "removed old: $old" } }

if ($Remove) {
  foreach ($t in $targets) { if (Test-Path $t) { Remove-Item $t -Confirm:$false; "removed: $t" } }
  return
}
if (-not (Test-Path $exe)) { throw "アプリがまだ作られていません。先に npm run package を実行してください: $exe" }

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  $s = $shell.CreateShortcut($t)
  $s.TargetPath = $exe
  $s.WorkingDirectory = Split-Path -Parent $exe
  $s.IconLocation = "$exe,0"
  $s.Description = 'Orrery - AIエージェントの軌道を見守る'
  $s.Save()
  "created: $t"
}
