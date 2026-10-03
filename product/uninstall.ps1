# Kursor uninstaller bootstrap for Windows: same Node lookup as install.ps1, then uninstall.mjs.
#   powershell -ExecutionPolicy Bypass -File product\uninstall.ps1 [--yes] [--keep-config] [--purge]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args)
$env:KURSOR_BOOTSTRAP_SCRIPT = 'uninstall.mjs'
& (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'install.ps1') @Args
exit $LASTEXITCODE
