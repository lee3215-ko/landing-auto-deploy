/**
 * GitHub version.json 기반 자동 업데이트 (네이버 신고 프로그램과 동일 패턴)
 */
import { app, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import os from 'os';
import { createWriteStream } from 'fs';
import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';

const execFile = promisify(execFileCb);

export const UPDATE_VERSION_URL =
  'https://raw.githubusercontent.com/lee3215-ko/landing-auto-deploy/main/version.json';

export const RELEASE_ASSET = 'LandingAutoDeploy.zip';
export const EXE_NAME = 'Landing Auto Deploy.exe';
export const ZIP_INNER_FOLDER = 'LandingAutoDeploy';

/** UTF-8 BOM 제거 후 JSON 파싱 (PowerShell Set-Content BOM 대응) */
function parseJsonText(text) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
  return JSON.parse(cleaned);
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

  // GitHub Contents API 우선 (raw DNS 이슈 우회)
  const m = raw.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (m) {
    const [, owner, repo, branch, filePath] = m;
    const api =
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`;
    try {
      const meta = await requestJson(api, { Accept: 'application/vnd.github+json' });
      if (meta?.content) {
        const text = Buffer.from(meta.content, 'base64').toString('utf8');
        return parseJsonText(text);
      }
    } catch {
      /* fall through */
    }
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
  for (const key of ['url', 'download_url', 'api_download_url']) {
    if (payload[key]) urls.push(payload[key]);
  }
  for (const item of payload.download_urls || []) urls.push(item);

  const m = String(versionUrl || '').match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//,
  );
  const version = String(payload.version || '').trim();
  if (m && version) {
    const owner = m[1];
    const repo = m[2];
    const tag = version.startsWith('v') ? version : `v${version}`;
    const assetId = payload.asset_id != null ? Number(payload.asset_id) : null;
    if (assetId && Number.isFinite(assetId)) {
      urls.unshift(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`);
    }
    urls.push(
      `https://github.com/${owner}/${repo}/releases/download/${tag}/${RELEASE_ASSET}`,
      `https://github.com/${owner}/${repo}/releases/latest/download/${RELEASE_ASSET}`,
    );
  }
  return dedupeUrls(urls);
}

export async function checkForUpdate(versionUrl = UPDATE_VERSION_URL, currentVersion = app.getVersion()) {
  const payload = await fetchVersionPayload(versionUrl);
  if (!payload) return null;
  const remote = String(payload.version || '').trim();
  if (!remote || !isNewer(remote, currentVersion)) return null;
  const downloadUrls = collectDownloadUrls(payload, versionUrl);
  return {
    version: remote,
    notes: String(payload.notes || '').trim(),
    url: downloadUrls[0] || '',
    downloadUrls,
  };
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': `LandingAutoDeploy/${app.getVersion()}` };
    if (u.hostname === 'api.github.com' && u.pathname.includes('/releases/assets/')) {
      headers.Accept = 'application/octet-stream';
    }
    const req = lib.request(u, { method: 'GET', headers, timeout: 600000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = createWriteStream(dest);
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

async function downloadWithFallbacks(urls, dest) {
  const errors = [];
  for (const url of urls) {
    try {
      await downloadToFile(url, dest);
      const st = fs.statSync(dest);
      if (st.size < 1024) throw new Error('file too small');
      const fd = fs.openSync(dest, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not a zip');
      return url;
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    }
  }
  throw new Error(errors.join('\n') || '다운로드 실패');
}

function getInstallDir() {
  return path.dirname(process.execPath);
}

function writeUpdatePs1(scriptPath) {
  const body = `param(
    [string]$Staging,
    [string]$Install,
    [string]$Exe,
    [string]$Inner,
    [int]$WaitPid
)
$ErrorActionPreference = "Continue"
$Log = Join-Path $env:TEMP "LandingAutoDeploy_update.log"
function Write-Log([string]$Message) {
    Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}
Write-Log "update start"
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
}
if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $WaitPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 2
$src = Join-Path $Staging $Inner
if (-not (Test-Path $src)) { $src = $Staging }
# win-unpacked 폴더가 한 겹 더 있을 수 있음
if (-not (Test-Path (Join-Path $src $Exe.Split('\\')[-1])) -and (Test-Path (Join-Path $src 'win-unpacked'))) {
    $src = Join-Path $src 'win-unpacked'
}
Write-Log "robocopy $src -> $Install"
& robocopy $src $Install /E /IS /IT /XD data /R:8 /W:3 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Log "robocopy failed $LASTEXITCODE"; exit 1 }
Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $Exe
Write-Log "update success"
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
exit 0
`;
  fs.writeFileSync(scriptPath, body, 'utf8');
}

async function extractZip(zipPath, stagingDir) {
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  // PowerShell Expand-Archive (Node zip 의존 없이)
  await execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${stagingDir.replace(/'/g, "''")}' -Force`,
    ],
    { windowsHide: true },
  );
}

function scheduleApplyUpdate(zipPath) {
  const installDir = getInstallDir();
  const stagingDir = path.join(os.tmpdir(), `LandingAutoDeploy_staging_${process.pid}`);
  const scriptPath = path.join(os.tmpdir(), `landing_auto_deploy_update_${process.pid}.ps1`);
  const exePath = path.join(installDir, EXE_NAME);

  return extractZip(zipPath, stagingDir).then(() => {
    writeUpdatePs1(scriptPath);
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', scriptPath,
        stagingDir,
        installDir,
        exePath,
        ZIP_INNER_FOLDER,
        String(process.pid),
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    ).unref();
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
  });
}

export function canAutoUpdate() {
  return app.isPackaged && process.platform === 'win32';
}

/**
 * 시작 후 업데이트 확인 → 다이얼로그 → 자동 설치
 */
export async function runStartupUpdateCheck(mainWindow = null) {
  if (!canAutoUpdate()) return;
  try {
    const current = app.getVersion();
    const info = await checkForUpdate(UPDATE_VERSION_URL, current);
    if (!info) return;

    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    let message = `새 버전 ${info.version}이 있습니다.\n(현재: ${current})`;
    if (info.notes) message += `\n\n${info.notes}`;
    message += '\n\n「예」= 자동 업데이트 후 재실행\n「아니오」= 브라우저에서 받기\n「취소」= 나중에';

    const result = await dialog.showMessageBox(win || undefined, {
      type: 'info',
      buttons: ['예', '아니오', '취소'],
      defaultId: 0,
      cancelId: 2,
      title: '업데이트',
      message: 'Landing Auto Deploy 업데이트',
      detail: message,
      noLink: true,
    });

    if (result.response === 2) return;

    if (result.response === 1) {
      const openUrl = info.downloadUrls?.[1] || info.url
        || `https://github.com/lee3215-ko/landing-auto-deploy/releases/latest`;
      await shell.openExternal(openUrl);
      return;
    }

    // 예 = 자동 업데이트
    const zipPath = path.join(os.tmpdir(), `LandingAutoDeploy_${info.version}.zip`);
    dialog.showMessageBox(win || undefined, {
      type: 'info',
      buttons: ['확인'],
      title: '업데이트',
      message: '업데이트를 다운로드합니다.\n완료되면 앱이 종료되고 새 버전이 실행됩니다.',
    }).catch(() => {});

    await downloadWithFallbacks(info.downloadUrls || [info.url], zipPath);
    await scheduleApplyUpdate(zipPath);
    app.exit(0);
  } catch (e) {
    console.error('[updater]', e);
    try {
      await dialog.showMessageBox({
        type: 'warning',
        buttons: ['확인'],
        title: '업데이트',
        message: `자동 업데이트 실패\n${e.message || e}\n\n릴리스 페이지에서 직접 받아 주세요.`,
      });
      await shell.openExternal('https://github.com/lee3215-ko/landing-auto-deploy/releases/latest');
    } catch { /* ignore */ }
  }
}
