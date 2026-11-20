# Builds the real application and the per-user GUI installer. No installation is performed.
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows 10/11 x64.' }
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw 'Bun is required. Install it from https://bun.sh/docs/installation, reopen PowerShell and retry. This script does not download or execute an installer automatically.'
}
function Invoke-Bun {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  & bun @Arguments
  if ($LASTEXITCODE -ne 0) { throw ('Bun failed (' + $LASTEXITCODE + '): ' + ($Arguments -join ' ')) }
}
Write-Host 'Bun version:'
Invoke-Bun @('--version')
Invoke-Bun @('install', '--frozen-lockfile')
if (-not $SkipTests) {
  # The test command first generates embedded UI resources.
  Invoke-Bun @('run', 'test:windows')
  Invoke-Bun @('run', 'typecheck')
}
Invoke-Bun @('run', 'release')
$exe = Join-Path (Get-Location) 'release\JarvisCodeSetup.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Installer was not produced.' }
Get-FileHash -LiteralPath $exe -Algorithm SHA256 | Format-List
Write-Host 'Ready: release\JarvisCodeSetup.exe'
Write-Warning 'Unsigned unless JC_SIGN_CERT / JC_SIGN_CMD was supplied. SmartScreen may warn.'
