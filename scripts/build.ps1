#requires -Version 5.1
<#
.SYNOPSIS
  Build the UI into the API's wwwroot, then publish a self-contained API.
.EXAMPLE
  ./scripts/build.ps1 -Runtime linux-x64
#>
param(
  [string]$Runtime = 'linux-x64',
  [string]$Output  = 'publish'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '==> Building UI' -ForegroundColor Cyan
Push-Location (Join-Path $root 'src/web')
try {
  if (Test-Path 'package-lock.json') { npm ci } else { npm install }
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
} finally { Pop-Location }

Write-Host '==> Publishing API' -ForegroundColor Cyan
$outPath = Join-Path $root $Output
Push-Location (Join-Path $root 'src/Waterhouse.Api')
try {
  # Self-contained: no .NET runtime to install or patch on the server.
  dotnet publish -c Release -r $Runtime --self-contained true -o $outPath
  if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }
} finally { Pop-Location }

Write-Host "==> Done: $outPath" -ForegroundColor Green
