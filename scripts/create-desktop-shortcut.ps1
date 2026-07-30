param(
    [Parameter(Mandatory = $false)]
    [string]$ExePath
)

# Always prefer unpacked Electron exe.
# Portable EXE extracts to %TEMP% then relaunches — looks like "닫혔다 다시 켜짐".
$distRoot = Join-Path $PSScriptRoot '..\dist'
$unpacked = Join-Path $distRoot 'win-unpacked\Landing Auto Deploy.exe'

if (Test-Path -LiteralPath $unpacked) {
    $ExePath = $unpacked
} elseif (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) {
    $portable = Get-ChildItem -LiteralPath $distRoot -Filter 'LandingAutoDeploy-*.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($portable) { $ExePath = $portable.FullName }
}

if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) {
    throw "EXE를 찾을 수 없습니다. 먼저 npm run dist 후 다시 실행하세요."
}

$exe = (Resolve-Path -LiteralPath $ExePath).Path
$isPortable = [System.IO.Path]::GetFileName($exe) -like 'LandingAutoDeploy-*.exe'
if ($isPortable) {
    Write-Warning "portable EXE는 실행 시 한 번 재시작됩니다. win-unpacked 빌드를 권장합니다."
}

$desktop = [Environment]::GetFolderPath('Desktop')
# OneDrive Desktop도 정리
$desktops = @(
    $desktop,
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'OneDrive\Desktop'),
    (Join-Path $env:USERPROFILE 'OneDrive\바탕 화면')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

$shell = New-Object -ComObject WScript.Shell
$created = @()

foreach ($desk in $desktops) {
    $lnk = Join-Path $desk 'Landing Auto Deploy.lnk'
    $shortcut = $shell.CreateShortcut($lnk)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = Split-Path $exe
    $shortcut.Description = 'Netlify 배포 + 네이버 서치어드바이저 자동 등록'
    $shortcut.Save()
    $created += $lnk

    Get-ChildItem $desk -Filter '*Landing*' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Extension -eq '.lnk' -and $_.FullName -ne $lnk) {
            Write-Host "중복 바로가기 삭제: $($_.FullName)"
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "바로가기 생성:"
$created | ForEach-Object { Write-Host "  $_" }
Write-Host "대상: $exe"
