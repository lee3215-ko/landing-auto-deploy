# Sync kkang-site-builder into app engine/ (for other PCs / packaging)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Src = $env:KKANG_ENGINE_SRC
if (-not $Src) {
  $candidates = @(
    'C:\Users\thdco\Projects\kkang-site-builder',
    (Join-Path (Split-Path -Parent $Root) 'Projects\kkang-site-builder'),
    (Join-Path $Root '..\..\Projects\kkang-site-builder')
  )
  foreach ($c in $candidates) {
    $resolved = [System.IO.Path]::GetFullPath($c)
    if (Test-Path (Join-Path $resolved 'scripts\cli_bridge.py')) {
      $Src = $resolved
      break
    }
  }
}
if (-not $Src -or -not (Test-Path (Join-Path $Src 'scripts\cli_bridge.py'))) {
  Write-Host '[sync-kkang-engine] engine source not found. Set KKANG_ENGINE_SRC.'
  exit 0
}
$Dst = Join-Path $Root 'engine\kkang-site-builder'
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
Write-Host "[sync-kkang-engine] $Src -> $Dst"
robocopy $Src $Dst /MIR /NFL /NDL /NJH /NJS /nc /ns /np `
  /XD .git dist output __pycache__ .venv venv node_modules .cursor backups `
  /XF *.pyc *.pyo *.log
$code = $LASTEXITCODE
if ($code -ge 8) { exit $code }

# Ensure default keyword pack is present for first-run seeding
$DstData = Join-Path $Dst 'data'
New-Item -ItemType Directory -Force -Path $DstData | Out-Null
$DefaultKw = Join-Path $DstData 'default_keywords.json'
$BundledKw = Join-Path $Root 'bundled-keywords\default_keywords.json'
$SrcKw = Join-Path $Src 'data\default_keywords.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BundledKw) | Out-Null
if (Test-Path $SrcKw) {
  Copy-Item -Force $SrcKw $DefaultKw
  Copy-Item -Force $SrcKw $BundledKw
  Write-Host '[sync-kkang-engine] default_keywords.json synced'
} elseif (Test-Path $BundledKw) {
  Copy-Item -Force $BundledKw $DefaultKw
  Write-Host '[sync-kkang-engine] bundled-keywords copied to engine'
} else {
  Write-Host '[sync-kkang-engine] WARN: default_keywords.json missing'
}

Write-Host '[sync-kkang-engine] done'
exit 0
