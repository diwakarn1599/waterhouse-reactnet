#requires -Version 5.1
<#
.SYNOPSIS
  Run the API and the Vite dev server together for local development.
.DESCRIPTION
  API on http://localhost:5080, UI on http://localhost:5173 with /api proxied.
  Open the UI URL - it has hot reload.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$api = Start-Process -PassThru -NoNewWindow -FilePath 'dotnet' `
  -ArgumentList 'run' -WorkingDirectory (Join-Path $root 'src/Waterhouse.Api')

Write-Host 'API starting on http://localhost:5080' -ForegroundColor Cyan
Write-Host 'UI  starting on http://localhost:5173' -ForegroundColor Cyan
Write-Host 'Ctrl+C to stop both.' -ForegroundColor DarkGray

try {
  Push-Location (Join-Path $root 'src/web')
  npm run dev
} finally {
  Pop-Location
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
}
