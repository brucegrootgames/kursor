# Kursor installer bootstrap for Windows: finds Node.js 18+ and runs install.mjs with the same arguments.
#   powershell -ExecutionPolicy Bypass -File product\install.ps1 [options]     (or just product\install.cmd)
# The real work — download, rebrand, shortcuts, Path, protocol — is in install.mjs.
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = if ($env:KURSOR_BOOTSTRAP_SCRIPT) { $env:KURSOR_BOOTSTRAP_SCRIPT } else { 'install.mjs' }

function Test-Node([string] $exe) {
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $false }
  try { $major = & $exe -p 'process.versions.node.split(".")[0]' 2>$null } catch { return $false }
  return ([int]$major -ge 18)
}

function Find-Node {
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath -and (Test-Node $onPath.Source)) { return $onPath.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),
    (Join-Path $env:APPDATA 'fnm\aliases\default\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'fnm_multishells\*\node.exe'),
    (Join-Path $env:APPDATA 'nvm\*\node.exe'),
    'C:\nvm4w\nodejs\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  )
  foreach ($pattern in $candidates) {
    foreach ($hit in @(Get-Item -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)) {
      if (Test-Node $hit.FullName) { return $hit.FullName }
    }
  }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Error @"
Node.js 18 or newer is required to run the Kursor installer (it is not needed to use Kursor).
Install it with:  winget install OpenJS.NodeJS.LTS      or from https://nodejs.org
Then open a new terminal and re-run this script.
"@
  exit 1
}

& $node (Join-Path $dir $script) @Args
exit $LASTEXITCODE
