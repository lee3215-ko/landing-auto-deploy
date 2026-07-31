# Build kkang-cli.exe (bundled Python) into engine/kkang-site-builder/kkang-cli
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EngineSrc = $env:KKANG_ENGINE_SRC
if (-not $EngineSrc) {
  $candidates = @(
    'C:\Users\thdco\Projects\kkang-site-builder',
    (Join-Path (Split-Path -Parent $Root) 'Projects\kkang-site-builder')
  )
  foreach ($c in $candidates) {
    $resolved = [System.IO.Path]::GetFullPath($c)
    if (Test-Path (Join-Path $resolved 'build\build_cli.bat')) {
      $EngineSrc = $resolved
      break
    }
  }
}
if (-not $EngineSrc) {
  Write-Host '[build-kkang-cli] engine source not found'
  exit 1
}

Write-Host "[build-kkang-cli] building from $EngineSrc"
$prev = Get-Location
Set-Location $EngineSrc
try {
  & cmd /c "build\build_cli.bat"
  if ($LASTEXITCODE -ne 0) { throw "kkang-cli build failed" }
} finally {
  Set-Location $prev
}

$SrcDist = Join-Path $EngineSrc 'dist\kkang-cli'
$Dst = Join-Path $Root 'engine\kkang-site-builder\kkang-cli'
if (-not (Test-Path (Join-Path $SrcDist 'kkang-cli.exe'))) {
  throw "kkang-cli.exe not found at $SrcDist"
}
if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dst) | Out-Null
Copy-Item -Recurse -Force $SrcDist $Dst

# Ensure default keywords pack beside CLI datas (already in _MEIPASS via PyInstaller)
$BundledKw = Join-Path $Root 'bundled-keywords\default_keywords.json'
$DstData = Join-Path $Dst 'data'
if ((Test-Path $BundledKw) -and -not (Test-Path (Join-Path $DstData 'default_keywords.json'))) {
  New-Item -ItemType Directory -Force -Path $DstData | Out-Null
  Copy-Item -Force $BundledKw (Join-Path $DstData 'default_keywords.json')
}

Write-Host "[build-kkang-cli] installed -> $Dst"
exit 0
