/**
 * GitHub version.json 기반 자동 업데이트
 * 네이버 신고 프로그램(update_ui.py)과 동일: 확인 다이얼로그 → 진행률 창 → 설치 후 재실행
 */
import { app, dialog, shell, net, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { spawn, execFile as execFileCb } from 'child_process';
import os from 'os';
import { createWriteStream } from 'fs';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const UPDATE_VERSION_URL =
  'https://raw.githubusercontent.com/lee3215-ko/landing-auto-deploy/main/version.json';

export const RELEASE_ASSET = 'LandingAutoDeploy.zip';
export const EXE_NAME = 'Landing Auto Deploy.exe';
export const ZIP_INNER_FOLDER = 'LandingAutoDeploy';

const UPDATE_LOG = path.join(os.tmpdir(), 'LandingAutoDeploy_update.log');
const MIN_ZIP_BYTES = 1024 * 1024;

function parseJsonText(text) {
  return JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim());
}

function writeUpdateLog(msg) {
  try {
    fs.appendFileSync(UPDATE_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* ignore */ }
}

function parseVersion(version) {
  return String(version || '')
    .trim()
    .split('.')
    .map((p) => parseInt(String(p).replace(/\D/g, '') || '0', 10));
}

export function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: {
          'User-Agent': `LandingAutoDeploy/${app.getVersion()}`,
          'Cache-Control': 'no-cache',
          ...headers,
        },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          requestJson(res.headers.location, headers).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
              return;
            }
            resolve(parseJsonText(text));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function fetchVersionPayload(versionUrl) {
  const raw = String(versionUrl || '').trim();
  if (!raw) return null;

  const m = raw.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (m) {
    const [, owner, repo, branch, filePath] = m;
    const api =
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
    try {
      const meta = await requestJson(api, { Accept: 'application/vnd.github+json' });
      if (meta?.content) {
        return parseJsonText(Buffer.from(meta.content, 'base64').toString('utf8'));
      }
    } catch { /* fall through */ }
  }

  try {
    const busted = raw.includes('?') ? `${raw}&_=${Date.now()}` : `${raw}?_=${Date.now()}`;
    return await requestJson(busted);
  } catch {
    return null;
  }
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const s = String(u || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function collectDownloadUrls(payload, versionUrl) {
  const urls = [];
  const m = String(versionUrl || '').match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//,
  );
  const version = String(payload.version || '').trim();
  const owner = m?.[1];
  const repo = m?.[2];
  const tag = version ? (version.startsWith('v') ? version : `v${version}`) : '';
  const assetId = payload.asset_id != null ? Number(payload.asset_id) : null;

  if (owner && repo && assetId && Number.isFinite(assetId)) {
    urls.push(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`);
  }
  for (const key of ['url', 'download_url', 'api_download_url']) {
    if (payload[key]) urls.push(payload[key]);
  }
  for (const item of payload.download_urls || []) urls.push(item);
  if (owner && repo && tag) {
    urls.push(
      `https://github.com/${owner}/${repo}/releases/download/${tag}/${RELEASE_ASSET}`,
      `https://github.com/${owner}/${repo}/releases/latest/download/${RELEASE_ASSET}`,
    );
  }
  return dedupeUrls(urls);
}

export async function checkForUpdate(versionUrl = UPDATE_VERSION_URL, currentVersion = app.getVersion()) {
  const payload = await fetchVersionPayload(versionUrl);
  if (!payload) {
    return { unavailable: true, error: 'version.json 조회 실패 (네트워크/GitHub)' };
  }
  const remote = String(payload.version || '').trim();
  if (!remote || !isNewer(remote, currentVersion)) {
    return { unavailable: false, upToDate: true, remote, current: currentVersion };
  }
  const downloadUrls = collectDownloadUrls(payload, versionUrl);
  return {
    unavailable: false,
    upToDate: false,
    version: remote,
    notes: String(payload.notes || '').trim(),
    url: downloadUrls[0] || '',
    downloadUrls,
  };
}

function buildDownloadHeaders(url) {
  const headers = { 'User-Agent': `LandingAutoDeploy/${app.getVersion()}` };
  try {
    const u = new URL(url);
    if (u.hostname === 'api.github.com' && u.pathname.includes('/releases/assets/')) {
      headers.Accept = 'application/octet-stream';
    }
  } catch { /* ignore */ }
  return headers;
}

function formatNetworkError(err) {
  const message = String(err?.message || err || '').trim();
  const lowered = message.toLowerCase();
  if (lowered.includes('getaddrinfo') || message.includes('11001') || lowered.includes('enotfound')) {
    return (
      '인터넷 연결 또는 DNS 설정을 확인해 주세요.\n'
      + '(GitHub 서버 주소를 찾지 못했습니다)\n\n'
      + '· Wi-Fi/유선 연결 확인\n'
      + '· 회사망·보안 프로그램이 GitHub 차단 여부 확인\n'
      + '· 「아니오」로 브라우저에서 직접 받기'
    );
  }
  if (lowered.includes('timed out') || lowered.includes('timeout')) {
    return '다운로드 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.';
  }
  if (lowered.includes('certificate') || lowered.includes('ssl')) {
    return '보안 인증서(SSL) 오류입니다. PC 날짜/시간이 맞는지 확인해 주세요.';
  }
  return message || String(err);
}

/** Chromium 네트워크 스택 + 진행률 */
function downloadWithElectronNet(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    if (typeof net?.request !== 'function') {
      reject(new Error('electron.net unavailable'));
      return;
    }
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const request = net.request({ method: 'GET', url, redirect: 'follow' });
    for (const [k, v] of Object.entries(buildDownloadHeaders(url))) {
      try { request.setHeader(k, v); } catch { /* ignore */ }
    }

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      resolve(dest);
    };

    const timer = setTimeout(() => {
      try { request.abort(); } catch { /* ignore */ }
      fail(new Error('download timeout (electron.net)'));
    }, 600000);

    request.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status !== 200) {
        fail(new Error(`HTTP ${status} (electron.net)`));
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0', 10) || 0;
      let downloaded = 0;
      const out = createWriteStream(dest);
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        try { onProgress?.(downloaded, total); } catch { /* ignore */ }
      });
      response.on('error', (e) => {
        clearTimeout(timer);
        out.destroy();
        fail(e);
      });
      out.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      out.on('finish', () => {
        clearTimeout(timer);
        ok();
      });
      response.pipe(out);
    });
    request.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    request.end();
  });
}

function downloadWithNodeHttps(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 12) {
      reject(new Error('too many redirects'));
      return;
    }
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = buildDownloadHeaders(url);
    const req = lib.request(u, { method: 'GET', headers, timeout: 600000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        downloadWithNodeHttps(next, dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 160)}`));
        });
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let downloaded = 0;
      const out = createWriteStream(dest);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        try { onProgress?.(downloaded, total); } catch { /* ignore */ }
      });
      res.pipe(out);
      out.on('finish', () => resolve(dest));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('download timeout'));
    });
    req.end();
  });
}

function assertValidZip(dest) {
  const st = fs.statSync(dest);
  if (st.size < MIN_ZIP_BYTES) throw new Error(`file too small (${st.size} bytes)`);
  const fd = fs.openSync(dest, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('not a zip (GitHub HTML/JSON 오류 페이지일 수 있음)');
  }
  return st.size;
}

async function downloadToFile(url, dest, onProgress) {
  writeUpdateLog(`download try: ${url}`);
  try {
    await downloadWithElectronNet(url, dest, onProgress);
    const size = assertValidZip(dest);
    writeUpdateLog(`download ok (electron.net) size=${size}`);
    return dest;
  } catch (e) {
    writeUpdateLog(`electron.net fail: ${e.message || e}`);
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
  }
  await downloadWithNodeHttps(url, dest, onProgress);
  const size = assertValidZip(dest);
  writeUpdateLog(`download ok (node https) size=${size}`);
  return dest;
}

async function downloadWithFallbacks(urls, dest, onProgress) {
  const errors = [];
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
        await downloadToFile(url, dest, onProgress);
        return url;
      } catch (e) {
        const msg = `${url} → ${formatNetworkError(e)}`;
        writeUpdateLog(`download fail: ${msg}`);
        errors.push(msg);
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
      }
    }
  }
  throw new Error(errors.slice(0, 4).join('\n') || '다운로드 실패');
}

function getInstallDir() {
  // electron-builder portable
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return path.dirname(process.execPath);
}

function isLikelyPortableTemp() {
  const p = String(process.execPath || '').toLowerCase();
  return /\\temp\\|\\tmp\\|appdata\\local\\temp/.test(p) && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function writeUpdatePs1(scriptPath) {
  // Electron 종료 후에도 살아남도록 VBS/Start-Process로 분리 실행.
  // 설치 폴더의 관련 프로세스를 모두 종료한 뒤 robocopy (파일 잠금 방지).
  const body = `param(
    [string]$Staging,
    [string]$Install,
    [string]$Exe,
    [string]$Inner,
    [int]$WaitPid,
    [string]$Token = ""
)
$ErrorActionPreference = "Continue"
$Log = Join-Path $env:TEMP "LandingAutoDeploy_update.log"
function Write-Log([string]$Message) {
    try {
        Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -Encoding UTF8
    } catch {}
}
function Show-Fail([string]$Message) {
    Write-Log $Message
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        [System.Windows.Forms.MessageBox]::Show(
            ($Message + "\`n\`n로그: " + $Log),
            "Landing Auto Deploy 업데이트 실패",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
    } catch {}
}
# 시작 마커 (Electron 측 대기용) — 가장 먼저 기록
try {
    if ($Token) {
        Set-Content -LiteralPath (Join-Path $env:TEMP ("LandingAutoDeploy_upd_started_" + $Token + ".flag")) -Value (Get-Date -Format o) -Encoding UTF8
    }
} catch {}
Write-Log "update start (powershell)"
Write-Log "Staging=$Staging"
Write-Log "Install=$Install"
Write-Log "Exe=$Exe"
Write-Log "WaitPid=$WaitPid"
Write-Log "Token=$Token"
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
    Write-Log "force stop pid $WaitPid"
    Stop-Process -Id $WaitPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
# Electron helper/GPU 등 설치 폴더 프로세스가 남아 있으면 robocopy 실패함
$installNorm = $Install.TrimEnd('\\') + '\\'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = [string]$_.ExecutablePath
    if (-not $cmd) { $cmd = [string]$_.CommandLine }
    if ($cmd -and $cmd.StartsWith($installNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Log ("kill related pid={0} name={1}" -f $_.ProcessId, $_.Name)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like 'Landing Auto Deploy*' -or $_.ProcessName -eq 'electron'
} | ForEach-Object {
    try {
        $mp = $_.Path
        if ($mp -and $mp.StartsWith($installNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Log ("kill by name pid={0} path={1}" -f $_.Id, $mp)
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
Write-Log "process wait done"
Start-Sleep -Seconds 3
$exeName = Split-Path $Exe -Leaf
$src = Join-Path $Staging $Inner
if (-not (Test-Path (Join-Path $src $exeName))) {
    $hit = Get-ChildItem -LiteralPath $Staging -Recurse -Filter $exeName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $src = $hit.Directory.FullName }
}
if (-not (Test-Path (Join-Path $src $exeName))) {
    Show-Fail "압축 해제된 exe를 찾지 못했습니다. src=$src"
    exit 2
}
Write-Log "robocopy $src -> $Install (data folder excluded)"
& robocopy $src $Install /E /IS /IT /XD data /R:12 /W:2 /NFL /NDL /NJH /NJS | Out-Null
$rc = $LASTEXITCODE
Write-Log "robocopy exit=$rc"
if ($rc -ge 8) {
    Show-Fail "파일 복사 실패 (robocopy $rc). 프로그램을 모두 종료한 뒤 zip을 수동으로 덮어써 주세요."
    exit 1
}
Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
Write-Log "starting $Exe"
if (-not (Test-Path -LiteralPath $Exe)) {
    Show-Fail "설치 후 exe가 없습니다: $Exe"
    exit 3
}
Start-Process -FilePath $Exe
Write-Log "update success"
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
exit 0
`;
  fs.writeFileSync(scriptPath, body, 'utf8');
}

function quotePsSingle(a) {
  return `'${String(a).replace(/'/g, "''")}'`;
}

function quoteVbs(a) {
  return `"${String(a).replace(/"/g, '""')}"`;
}

/**
 * Electron Job Object에서 완전히 분리해 업데이터 실행.
 * 1순위: wscript VBS (부모 종료와 무관)
 * 2순위: powershell Start-Process
 * 3순위: cmd start "title" /b
 */
function launchDetachedUpdater(scriptPath, stagingDir, installDir, exePath, waitPid, token) {
  const fileArgs = [
    scriptPath,
    stagingDir,
    installDir,
    exePath,
    ZIP_INNER_FOLDER,
    String(waitPid),
    String(token || ''),
  ];

  // ── 1) VBS / wscript ──
  try {
    const vbsPath = path.join(os.tmpdir(), `landing_upd_${waitPid}.vbs`);
    const psCmd = [
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File',
      ...fileArgs.map(quoteVbs),
    ].join(' ');
    const vbs = [
      'On Error Resume Next',
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run ${quoteVbs(psCmd)}, 0, False`,
      `On Error Resume Next`,
      `Set fso = CreateObject("Scripting.FileSystemObject")`,
      `fso.DeleteFile WScript.ScriptFullName, True`,
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbs, 'utf8');
    writeUpdateLog(`launch via wscript: ${vbsPath}`);
    const c1 = spawn('wscript.exe', ['//B', '//Nologo', vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    c1.on('error', (e) => writeUpdateLog(`wscript spawn error: ${e.message}`));
    c1.unref();
  } catch (e) {
    writeUpdateLog(`wscript launch fail: ${e.message || e}`);
  }

  // ── 2) PowerShell Start-Process (cmd start 버그 회피) ──
  try {
    const argList = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      ...fileArgs,
    ].map(quotePsSingle).join(', ');
    const launcherPath = path.join(os.tmpdir(), `landing_upd_launch_${waitPid}.ps1`);
    fs.writeFileSync(
      launcherPath,
      [
        "$ErrorActionPreference = 'Continue'",
        `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${argList}) -WindowStyle Hidden`,
        'Start-Sleep -Milliseconds 300',
        'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
      ].join('\r\n'),
      'utf8',
    );
    writeUpdateLog(`launch via Start-Process: ${launcherPath}`);
    const c2 = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcherPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    c2.on('error', (e) => writeUpdateLog(`Start-Process spawn error: ${e.message}`));
    c2.unref();
  } catch (e) {
    writeUpdateLog(`Start-Process launch fail: ${e.message || e}`);
  }

  // ── 3) cmd start "title" /b (빈 title 금지 — /b 가 title로 먹히는 버그 방지) ──
  try {
    const batPath = path.join(os.tmpdir(), `landing_upd_${waitPid}.cmd`);
    const batArgs = fileArgs.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ');
    fs.writeFileSync(
      batPath,
      [
        '@echo off',
        `start "LandingAutoDeployUpdate" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${batArgs}`,
        `del "%~f0" >nul 2>&1`,
      ].join('\r\n'),
      'utf8',
    );
    writeUpdateLog(`launch via cmd: ${batPath}`);
    const c3 = spawn('cmd.exe', ['/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    c3.on('error', (e) => writeUpdateLog(`cmd spawn error: ${e.message}`));
    c3.unref();
  } catch (e) {
    writeUpdateLog(`cmd launch fail: ${e.message || e}`);
  }
}

async function waitForUpdaterStarted(token, timeoutMs = 20000) {
  const flagPath = path.join(os.tmpdir(), `LandingAutoDeploy_upd_started_${token}.flag`);
  const marker = 'update start (powershell)';
  let baselineLen = 0;
  try {
    baselineLen = fs.readFileSync(UPDATE_LOG, 'utf8').length;
  } catch { /* ignore */ }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fs.existsSync(flagPath)) return true;
    } catch { /* ignore */ }
    try {
      const cur = fs.readFileSync(UPDATE_LOG, 'utf8');
      if (cur.length > baselineLen && cur.slice(baselineLen).includes(marker)) return true;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function extractZip(zipPath, stagingDir, onStatus) {
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  writeUpdateLog(`extract start zip=${zipPath} -> ${stagingDir}`);
  onStatus?.('압축 해제 중…');

  try {
    await execFile('tar.exe', ['-xf', zipPath, '-C', stagingDir], { windowsHide: true, timeout: 600000 });
    writeUpdateLog('extract ok (tar)');
    return;
  } catch (e) {
    writeUpdateLog(`tar extract fail: ${e.message || e}`);
  }

  await execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${stagingDir.replace(/'/g, "''")}')`,
    ],
    { windowsHide: true, timeout: 600000 },
  );
  writeUpdateLog('extract ok (ZipFile)');
}

function findExtractedExe(stagingDir) {
  const candidates = [
    path.join(stagingDir, ZIP_INNER_FOLDER, EXE_NAME),
    path.join(stagingDir, EXE_NAME),
    path.join(stagingDir, 'win-unpacked', EXE_NAME),
    path.join(stagingDir, ZIP_INNER_FOLDER, 'win-unpacked', EXE_NAME),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function scheduleApplyUpdate(zipPath) {
  const installDir = getInstallDir();
  const stagingDir = path.join(os.tmpdir(), `LandingAutoDeploy_staging_${process.pid}`);
  const scriptPath = path.join(os.tmpdir(), `landing_auto_deploy_update_${process.pid}.ps1`);
  const exePath = path.join(installDir, EXE_NAME);
  const token = `${process.pid}_${Date.now()}`;

  return extractZip(zipPath, stagingDir).then(() => {
    const found = findExtractedExe(stagingDir);
    if (!found) {
      throw new Error(`압축 해제 후 exe를 찾지 못했습니다.\n${stagingDir}`);
    }
    writeUpdateLog(`extracted exe: ${found}`);
    writeUpdatePs1(scriptPath);
    launchDetachedUpdater(scriptPath, stagingDir, installDir, exePath, process.pid, token);
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
  });
}

function createProgressWindow(parent) {
  const win = new BrowserWindow({
    width: 420,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0f1419',
    title: '업데이트 중',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const htmlPath = path.join(__dirname, '..', 'renderer', 'update-progress.html');
  win.loadFile(htmlPath);
  win.once('ready-to-show', () => {
    try {
      win.show();
      win.focus();
    } catch { /* ignore */ }
  });
  return win;
}

async function setProgressUI(win, done, total, text) {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(
      `window.setUpdateProgress(${Number(done) || 0}, ${Number(total) || 0}, ${JSON.stringify(text || '')});`,
      true,
    );
  } catch { /* ignore */ }
}

export function canAutoUpdate() {
  return app.isPackaged && process.platform === 'win32' && !isLikelyPortableTemp();
}

/**
 * 시작 후 업데이트 확인 → 예/아니오/취소 → 진행률 창 → 설치 후 재실행
 * (네이버 신고 update_ui.py 와 동일 흐름)
 */
export async function runStartupUpdateCheck(mainWindow = null) {
  if (!app.isPackaged || process.platform !== 'win32') {
    writeUpdateLog(`skip update check (packaged=${app.isPackaged}, platform=${process.platform})`);
    return;
  }

  const sendLog = (msg) => {
    writeUpdateLog(msg);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-line', `[업데이트] ${msg}`);
      }
    } catch { /* ignore */ }
  };

  let progressWin = null;
  try {
    const current = app.getVersion();
    sendLog(`확인 중… 현재 ${current}`);

    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.lift?.();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(true);
        setTimeout(() => {
          try { if (!mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); } catch { /* ignore */ }
        }, 400);
      }
    } catch { /* ignore */ }

    const info = await checkForUpdate(UPDATE_VERSION_URL, current);
    if (info?.unavailable) {
      sendLog(info.error || 'version.json 조회 실패');
      return;
    }
    if (info?.upToDate || !info?.version) {
      sendLog(`최신입니다 (${info?.remote || current})`);
      return;
    }
    sendLog(`새 버전 ${info.version} 발견`);

    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    let message = `새 버전 ${info.version}이 있습니다.\n(현재: ${current})`;
    if (info.notes) message += `\n\n${info.notes}`;

    const autoOk = canAutoUpdate() && !!(info.downloadUrls?.length || info.url);
    if (autoOk) {
      message += '\n\n「예」= 자동 업데이트 후 재실행\n「아니오」= 브라우저에서 받기\n「취소」= 나중에';
    } else {
      message += '\n\n이 설치 형태는 자동 덮어쓰기가 어렵습니다.\n브라우저에서 zip을 받아 설치 폴더에 덮어쓴 뒤 다시 실행하세요.';
    }

    const result = await dialog.showMessageBox(win || undefined, {
      type: 'info',
      buttons: autoOk ? ['예', '아니오', '취소'] : ['다운로드 페이지 열기', '취소'],
      defaultId: 0,
      cancelId: autoOk ? 2 : 1,
      title: '업데이트',
      message: 'Landing Auto Deploy 업데이트',
      detail: message,
      noLink: true,
    });

    if (autoOk) {
      if (result.response === 2) return;
      if (result.response === 1) {
        const openUrl = info.downloadUrls?.find((u) => u.includes('github.com/') && !u.includes('api.github.com'))
          || info.downloadUrls?.[0]
          || info.url
          || 'https://github.com/lee3215-ko/landing-auto-deploy/releases/latest';
        await shell.openExternal(openUrl);
        return;
      }
    } else {
      if (result.response !== 0) return;
      await shell.openExternal(
        info.downloadUrls?.find((u) => u.includes('github.com/') && !u.includes('api.github.com'))
        || 'https://github.com/lee3215-ko/landing-auto-deploy/releases/latest',
      );
      return;
    }

    // 「예」→ 진행률 창 (신고 프로그램과 동일)
    progressWin = createProgressWindow(win);
    await new Promise((r) => {
      if (progressWin.webContents.isLoading()) {
        progressWin.webContents.once('did-finish-load', () => r());
      } else r();
    });
    await setProgressUI(progressWin, 0, 100, '다운로드 중…');

    const zipPath = path.join(os.tmpdir(), `LandingAutoDeploy_${info.version}.zip`);
    sendLog('다운로드 시작…');
    await downloadWithFallbacks(info.downloadUrls || [info.url], zipPath, (done, total) => {
      const pct = total > 0 ? Math.min(100, Math.round((done * 100) / total)) : 0;
      const mb = (done / (1024 * 1024)).toFixed(1);
      const text = total > 0
        ? `다운로드 ${pct}% (${mb} MB)`
        : `다운로드 중… (${mb} MB)`;
      setProgressUI(progressWin, done, total, text);
    });

    const sizeMb = Math.round(fs.statSync(zipPath).size / (1024 * 1024));
    sendLog(`다운로드 완료 (${sizeMb} MB)`);
    await setProgressUI(progressWin, 100, 100, '압축 해제·설치 준비 중…');

    const stagingDir = path.join(os.tmpdir(), `LandingAutoDeploy_staging_${process.pid}`);
    await extractZip(zipPath, stagingDir, (t) => setProgressUI(progressWin, 100, 100, t));
    const found = findExtractedExe(stagingDir);
    if (!found) throw new Error(`압축 해제 후 exe를 찾지 못했습니다.\n${stagingDir}`);

    const installDir = getInstallDir();
    const scriptPath = path.join(os.tmpdir(), `landing_auto_deploy_update_${process.pid}.ps1`);
    const exePath = path.join(installDir, EXE_NAME);
    const token = `${process.pid}_${Date.now()}`;
    writeUpdatePs1(scriptPath);
    writeUpdateLog(`schedule apply install=${installDir} exe=${exePath} pid=${process.pid} token=${token}`);

    launchDetachedUpdater(scriptPath, stagingDir, installDir, exePath, process.pid, token);

    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    await setProgressUI(progressWin, 100, 100, '설치 스크립트 시작 확인 중…');
    sendLog(`설치 스크립트 실행 (로그: ${UPDATE_LOG})`);

    const started = await waitForUpdaterStarted(token, 25000);
    if (!started) {
      throw new Error(
        `업데이트 설치 스크립트가 시작되지 않았습니다.\n로그: ${UPDATE_LOG}\n\n수동으로 zip을 받아 설치 폴더에 덮어써 주세요.`,
      );
    }
    writeUpdateLog('updater process confirmed started');

    await setProgressUI(progressWin, 100, 100, '설치 중… 잠시 후 다시 실행됩니다');
    await new Promise((r) => setTimeout(r, 1200));
    try { if (progressWin && !progressWin.isDestroyed()) progressWin.close(); } catch { /* ignore */ }
    app.exit(0);
  } catch (e) {
    console.error('[updater]', e);
    writeUpdateLog(`FATAL: ${e.message || e}`);
    try { if (progressWin && !progressWin.isDestroyed()) progressWin.close(); } catch { /* ignore */ }
    try {
      await dialog.showMessageBox({
        type: 'warning',
        buttons: ['확인'],
        title: '업데이트 실패',
        message: '자동 업데이트 실패',
        detail: `${formatNetworkError(e)}\n\n로그: ${UPDATE_LOG}\n\n「아니오」로 브라우저에서 직접 받아 주세요.`,
        noLink: true,
      });
      await shell.openExternal('https://github.com/lee3215-ko/landing-auto-deploy/releases/latest');
    } catch { /* ignore */ }
  }
}
