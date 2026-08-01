param(
    [Parameter(Mandatory = $false)]
    [string]$ExePath
)

$root = Join-Path $PSScriptRoot '..'
$candidates = @(
    (Join-Path $root 'release\LandingAutoDeploy\Landing Auto Deploy.exe'),
    (Join-Path $root 'dist-publish-build\win-unpacked\Landing Auto Deploy.exe'),
    (Join-Path $root 'dist-publish\win-unpacked\Landing Auto Deploy.exe'),
    (Join-Path $root 'dist\win-unpacked\Landing Auto Deploy.exe')
)

if ($ExePath -and (Test-Path -LiteralPath $ExePath)) {
    # keep provided
} else {
    $ExePath = $null
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) {
            $ExePath = $c
            break
        }
    }
}

if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) {
    throw "EXE를 찾을 수 없습니다. 먼저 npm run dist:dir 후 다시 실행하세요."
}

$exe = (Resolve-Path -LiteralPath $ExePath).Path

$desktops = @(
    [Environment]::GetFolderPath('Desktop'),
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
    $shortcut.IconLocation = "$exe,0"
    $shortcut.Save()
    $created += $lnk
}

Write-Host "바로가기 생성:"
$created | ForEach-Object { Write-Host "  $_" }
Write-Host "대상: $exe"
