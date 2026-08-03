param(
    [Parameter(Mandatory = $false)]
    [string]$ExePath
)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pkgPath = Join-Path $root 'package.json'
$version = 'dev'
if (Test-Path -LiteralPath $pkgPath) {
    try {
        $version = [string]((Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version)
    } catch { }
}

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
    throw "EXE를 찾을 수 없습니다. 먼저 build.bat 실행 후 다시 시도하세요."
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
$linkName = "Landing Auto Deploy v$version.lnk"
$desc = "Landing Auto Deploy v$version (개발 PC 빌드)"

$aliasName = 'Landing Auto Deploy.lnk'
foreach ($desk in $desktops) {
    # 이전 버전 바로가기 정리 (고정명·버전명만 남김)
    Get-ChildItem -LiteralPath $desk -Filter 'Landing Auto Deploy*.lnk' -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -ne $linkName -and $_.Name -ne $aliasName) {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }

    foreach ($name in @($linkName, $aliasName)) {
        $lnk = Join-Path $desk $name
        $shortcut = $shell.CreateShortcut($lnk)
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = Split-Path $exe
        $shortcut.Description = $desc
        $shortcut.IconLocation = "$exe,0"
        $shortcut.Save()
        $created += $lnk
    }
}

Write-Host "바로가기 생성 (v$version):"
$created | ForEach-Object { Write-Host "  $_" }
Write-Host "대상: $exe"
