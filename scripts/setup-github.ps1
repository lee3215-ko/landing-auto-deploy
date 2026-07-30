$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root
. (Join-Path $PSScriptRoot "gh-env.ps1")

Ensure-GhInstalled
Write-Host "GitHub auth status:"
Invoke-Gh auth status
Write-Host ""
Write-Host "OK. Deploy with: .\deploy.bat"
