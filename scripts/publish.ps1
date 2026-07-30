param(
    [string]$Notes = "업데이트",
    [ValidateSet("patch", "minor", "major", "none")]
    [string]$Bump = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root
. (Join-Path $PSScriptRoot "gh-env.ps1")

function Read-DeployConfig {
    Get-Content (Join-Path $Root "deploy.json") -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Read-AppVersion($cfg) {
    $path = Join-Path $Root $cfg.version.file
    if ($cfg.version.format -eq "package.json" -or $cfg.version.file -eq "package.json") {
        $pkg = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$pkg.version
    }
    $text = Get-Content $path -Raw -Encoding UTF8
    $var = [regex]::Escape($cfg.version.variable)
    if ($text -match "${var}\s*=\s*`"([^`"]+)`"") {
        return $Matches[1]
    }
    throw "Version not found in $($cfg.version.file)"
}

function Set-AppVersion($cfg, [string]$Version) {
    $path = Join-Path $Root $cfg.version.file
    if ($cfg.version.format -eq "package.json" -or $cfg.version.file -eq "package.json") {
        # 원본 JSON 구조 유지 — 버전 문자열만 교체
        $text = Get-Content $path -Raw -Encoding UTF8
        if ($text -notmatch '"version"\s*:\s*"[^"]+"') {
            throw "package.json version field not found"
        }
        $text = $text -replace '"version"\s*:\s*"[^"]+"', "`"version`": `"$Version`""
        [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
    } else {
        $text = Get-Content $path -Raw -Encoding UTF8
        $var = [regex]::Escape($cfg.version.variable)
        $text = $text -replace "${var}\s*=\s*`"[^`"]+`"", "$($cfg.version.variable) = `"$Version`""
        [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
    }

    $htmlPath = Join-Path $Root "renderer\index.html"
    if (Test-Path $htmlPath) {
        $html = Get-Content $htmlPath -Raw -Encoding UTF8
        $html = $html -replace 'version-tag">v?[\d.]+<', "version-tag`">v$Version<"
        [System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.UTF8Encoding]::new($false))
    }
}

function Bump-Version([string]$Version, [string]$Part) {
    $parts = $Version.Split(".")
    if ($parts.Count -lt 3) { throw "Invalid version: $Version" }
    [int]$major = $parts[0]
    [int]$minor = $parts[1]
    [int]$patch = $parts[2]
    switch ($Part) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
        "none" { }
    }
    return "$major.$minor.$patch"
}

function Write-VersionJson($cfg, [string]$Version, [string]$ReleaseNotes, $AssetId = $null) {
    $tag = "v$Version"
    $owner = $cfg.github_owner
    $repo = $cfg.github_repo
    $asset = $cfg.release_asset
    $versioned = "https://github.com/$owner/$repo/releases/download/$tag/$asset"
    $latest = "https://github.com/$owner/$repo/releases/latest/download/$asset"
    $urls = New-Object System.Collections.Generic.List[string]
    $apiUrl = $null
    if ($AssetId) {
        $apiUrl = "https://api.github.com/repos/$owner/$repo/releases/assets/$AssetId"
        $urls.Add($apiUrl) | Out-Null
    }
    $urls.Add($versioned) | Out-Null
    $urls.Add($latest) | Out-Null

    $payload = [ordered]@{
        version           = $Version
        url               = $(if ($apiUrl) { $apiUrl } else { $versioned })
        download_url      = $versioned
        api_download_url  = $apiUrl
        asset_id          = $AssetId
        notes             = $ReleaseNotes
        download_urls     = @($urls)
    } | ConvertTo-Json -Depth 5
    # Windows PowerShell Set-Content -Encoding UTF8 는 BOM을 붙여 JSON.parse가 깨짐
    $path = Join-Path $Root "version.json"
    [System.IO.File]::WriteAllText($path, $payload + "`n", [System.Text.UTF8Encoding]::new($false))
}

function Get-ReleaseAssetId($cfg, [string]$Tag) {
    try {
        $json = & (Get-GhExe) api "repos/$($cfg.github_owner)/$($cfg.github_repo)/releases/tags/$Tag" 2>$null
        if (-not $json) { return $null }
        $rel = $json | ConvertFrom-Json
        foreach ($a in $rel.assets) {
            if ($a.name -eq $cfg.release_asset) { return [int64]$a.id }
        }
    } catch { }
    return $null
}

function Ensure-GitRemote($cfg) {
    if (-not (Test-Path (Join-Path $Root ".git"))) {
        git init | Out-Null
    }
    $branch = git branch --show-current 2>$null
    if ($branch -and $branch -ne "main") {
        git branch -M main | Out-Null
    } elseif (-not $branch) {
        git checkout -B main 2>$null | Out-Null
    }
    $remoteUrl = "https://github.com/$($cfg.github_owner)/$($cfg.github_repo).git"
    $hasOrigin = @(git remote 2>$null) -contains "origin"
    if (-not $hasOrigin) {
        git remote add origin $remoteUrl
        Write-Host "[git] origin: $remoteUrl"
    }
}

function Ensure-GhAuth {
    Invoke-Gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Run .\scripts\setup-github.ps1 or gh auth login"
    }
}

$cfg = Read-DeployConfig
$bumpPart = if ($Bump) { $Bump } else { $cfg.default_bump }
$current = Read-AppVersion $cfg
$newVersion = Bump-Version $current $bumpPart
$tag = "v$newVersion"
$displayName = if ($cfg.app_display_name) { $cfg.app_display_name } else { $cfg.github_repo }

Write-Host "============================================"
Write-Host " $displayName deploy"
Write-Host " version: $current -> $newVersion"
Write-Host "============================================"

Set-AppVersion $cfg $newVersion
Write-VersionJson $cfg $newVersion $Notes

if (-not $SkipBuild) {
    Write-Host "[1/4] Building..."
    $buildScript = Join-Path $Root $cfg.build.script
    if (-not (Test-Path $buildScript)) { throw "Build script missing: $($cfg.build.script)" }
    & $buildScript
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
}

$distDir = Join-Path $Root ($cfg.build.dist_dir -replace "/", "\")
if (-not (Test-Path $distDir)) {
    throw "Build output missing: $($cfg.build.dist_dir)"
}
$exeCheck = Join-Path $distDir "Landing Auto Deploy.exe"
if (-not (Test-Path $exeCheck)) {
    throw "EXE missing: $exeCheck"
}

Write-Host "[2/4] Creating zip..."
$zipPath = Join-Path $Root "dist\$($cfg.release_asset)"
$distParent = Split-Path $zipPath -Parent
if (-not (Test-Path $distParent)) { New-Item -ItemType Directory -Path $distParent | Out-Null }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $distDir -DestinationPath $zipPath -Force

Ensure-GhInstalled
Ensure-GitRemote $cfg
Ensure-GhAuth

# ensure remote repo exists
$repoCheck = & (Get-GhExe) repo view "$($cfg.github_owner)/$($cfg.github_repo)" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[gh] creating public repo $($cfg.github_repo)..."
    Invoke-Gh repo create "$($cfg.github_owner)/$($cfg.github_repo)" --public --source . --remote origin --push
}

Write-Host "[3/4] Pushing to GitHub..."
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$addArgs = @()
foreach ($item in $cfg.git_add) {
    $addArgs += $item
}
if ($addArgs.Count -gt 0) {
    git add -- @addArgs 2>$null
}
git add deploy.json deploy.bat version.json scripts build.bat .gitignore README.md 2>$null
git add -u

if (git status --porcelain) {
    git -c user.email="noreply@users.noreply.github.com" -c user.name="lee3215-ko" commit -m "Release $newVersion"
}

git push -u origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "[git] pull --rebase then push..."
    git pull origin main --rebase
    git push -u origin main
    if ($LASTEXITCODE -ne 0) {
        $ErrorActionPreference = $prevEap
        throw "git push failed"
    }
}
$ErrorActionPreference = $prevEap

Write-Host "[4/4] GitHub Release..."
if (Test-GhRelease $tag) {
    Invoke-Gh release upload $tag $zipPath --clobber
    Invoke-Gh release edit $tag --notes $Notes --title $newVersion
} else {
    Invoke-Gh release create $tag $zipPath --title $newVersion --notes $Notes --latest
}

$assetId = Get-ReleaseAssetId $cfg $tag
Write-VersionJson $cfg $newVersion $Notes $assetId
if (git status --porcelain version.json) {
    git add version.json
    git commit -m "Update version.json download URLs for $newVersion"
    git push origin main
}

Write-Host ""
Write-Host "Done!"
Write-Host "  version: $newVersion"
Write-Host "  https://github.com/$($cfg.github_owner)/$($cfg.github_repo)/releases/tag/$tag"
Write-Host "  download: https://github.com/$($cfg.github_owner)/$($cfg.github_repo)/releases/latest/download/$($cfg.release_asset)"
