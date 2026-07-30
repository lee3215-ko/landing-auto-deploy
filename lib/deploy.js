import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { log, api, error, warn } from './logger.js';
import { findIndexHtmlRelative } from './source-utils.js';

const API_BASE = 'https://api.netlify.com/api/v1';

export async function extractZip(zipPath, outputDir) {
  log(`ZIP 압축 해제: ${zipPath} -> ${outputDir}`);
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);
  const entries = Object.entries(zip.files).filter(([name, entry]) => !entry.dir);
  for (const [name, entry] of entries) {
    const outPath = path.join(outputDir, name);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const buf = await entry.async('nodebuffer');
    fs.writeFileSync(outPath, buf);
  }
  log(`ZIP 압축 해제 완료: ${entries.length}개 파일`);
}

async function apiGet(endpoint, token, attempt = 1) {
  api(`GET ${endpoint}`);
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 429 && attempt < 4) {
    const wait = attempt * 5000;
    warn(`GET ${endpoint} 429, ${wait}ms 후 재시도 (${attempt}/3)...`);
    await new Promise(r => setTimeout(r, wait));
    return apiGet(endpoint, token, attempt + 1);
  }
  if (!resp.ok) {
    const errText = await resp.text();
    error(`GET ${endpoint} failed: ${resp.status} ${resp.statusText} - ${errText}`);
    throw new Error(`GET ${endpoint} failed (${resp.status}): ${errText || resp.statusText}`);
  }
  api(`GET ${endpoint} -> ${resp.status}`);
  return resp.json();
}

/** 배포 전 Netlify 토큰 유효성 검사 */
export async function validateNetlifyToken(token) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: '토큰이 비어 있습니다.' };
  try {
    const resp = await fetch(`${API_BASE}/user`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      const errText = await resp.text();
      return { ok: false, error: `인증 실패 (${resp.status}): ${errText || 'Access Denied'}` };
    }
    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, error: `확인 실패 (${resp.status}): ${errText || resp.statusText}` };
    }
    const user = await resp.json();
    return { ok: true, email: user?.email || user?.slug || '' };
  } catch (e) {
    return { ok: false, error: e.message || '토큰 확인 중 오류' };
  }
}

async function apiPost(endpoint, token, bodyObj, attempt = 1) {
  api(`POST ${endpoint} body=${JSON.stringify(bodyObj).slice(0, 200)}`);
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });
  if (resp.status === 429 && attempt < 4) {
    const wait = attempt * 5000;
    warn(`POST ${endpoint} 429, ${wait}ms 후 재시도 (${attempt}/3)...`);
    await new Promise(r => setTimeout(r, wait));
    return apiPost(endpoint, token, bodyObj, attempt + 1);
  }
  if (!resp.ok) {
    const errText = await resp.text();
    error(`POST ${endpoint} failed (${resp.status}): ${errText}`);
    throw new Error(`POST ${endpoint} failed (${resp.status}): ${errText}`);
  }
  api(`POST ${endpoint} -> ${resp.status}`);
  return resp.json();
}

async function uploadDeployZip(siteId, token, zipBuf, attempt = 1) {
  api(`uploadDeployZip siteId=${siteId} attempt=${attempt} size=${zipBuf.length}`);
  const resp = await fetch(`${API_BASE}/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zipBuf,
  });

  if (resp.status === 429 && attempt < 4) {
    const wait = attempt * 8000;
    warn(`429 Rate Limit, ${wait}ms 후 재시도 (${attempt}/3)...`);
    await new Promise(r => setTimeout(r, wait));
    return uploadDeployZip(siteId, token, zipBuf, attempt + 1);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    error(`Deploy upload failed (${resp.status}): ${errText}`);
    throw new Error(`Deploy upload failed (${resp.status}): ${errText}`);
  }
  api(`uploadDeployZip -> ${resp.status}`);
  return resp.json();
}

async function getDeploy(siteId, deployId, token) {
  api(`getDeploy siteId=${siteId} deployId=${deployId}`);
  const resp = await fetch(`${API_BASE}/sites/${siteId}/deploys/${deployId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    warn(`getDeploy failed ${resp.status}`);
    return null;
  }
  return resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** index.html이 있는 실제 배포 루트 (ZIP 하위 폴더 구조 대응) */
export function resolveDeployRoot(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    throw new Error(`배포 폴더가 없습니다: ${dirPath}`);
  }
  if (fs.existsSync(path.join(dirPath, 'index.html'))) return dirPath;
  const rel = findIndexHtmlRelative(dirPath);
  if (!rel) {
    throw new Error(`배포 폴더에 index.html이 없습니다: ${dirPath}`);
  }
  const root = path.dirname(rel) === '.' ? dirPath : path.join(dirPath, path.dirname(rel));
  log(`배포 루트 자동 선택: ${root} (${rel})`);
  return root;
}

function sitePublicUrl(site) {
  const raw = site?.ssl_url || site?.url || '';
  if (raw) return raw.replace(/^http:\/\//i, 'https://');
  if (site?.name) return `https://${site.name}.netlify.app`;
  return '';
}

async function verifySiteLive(siteUrl, serviceName) {
  const url = sitePublicUrl({ ssl_url: siteUrl });
  for (let i = 0; i < 20; i += 1) {
    await sleep(i === 0 ? 1500 : 2500);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const body = await res.text();
      const platform404 = /Site not found/i.test(body) && /doesn't exist on Netlify/i.test(body);
      if (platform404) {
        warn(`[${serviceName}] Netlify 사이트 미생성 대기 (${i + 1}/20)...`);
        continue;
      }
      if (res.ok) {
        log(`[${serviceName}] 사이트 접속 확인 OK (${res.status})`);
        return url;
      }
      if (res.status === 404) {
        throw new Error(`사이트는 있으나 페이지를 찾을 수 없습니다. index.html 위치를 확인하세요: ${url}`);
      }
      warn(`[${serviceName}] HTTP ${res.status} — 재시도 (${i + 1}/20)`);
    } catch (e) {
      if (e.message?.includes('index.html') || e.message?.includes('페이지를 찾을 수 없')) throw e;
      warn(`[${serviceName}] 접속 확인 재시도: ${e.message}`);
    }
  }
  throw new Error(`사이트가 열리지 않습니다 (Site not found): ${url}`);
}

function zipDir(dirPath) {
  log(`zipDir: ${dirPath}`);
  const zip = new JSZip();
  function walk(current, prefix) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else zip.file(rel, fs.readFileSync(full));
    }
  }
  walk(dirPath, '');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function waitForDeployReady(siteId, deployId, token, serviceName) {
  log(`[${serviceName}] 배포 상태 대기 시작...`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const d = await getDeploy(siteId, deployId, token);
    if (!d) continue;
    log(`[${serviceName}] 배포 상태: ${d.state}`);
    if (d.state === 'ready' || d.state === 'current') {
      log(`[${serviceName}] 배포 ${d.state}`);
      return d;
    }
    if (d.state === 'error' || d.state === 'failed') {
      error(`[${serviceName}] 배포 실패 (${d.state})`);
      throw new Error(`배포 실패 (${d.state})`);
    }
  }
  warn(`[${serviceName}] 배포 시간 초과 (60s)`);
  throw new Error(`배포 시간 초과 — Netlify에서 배포가 완료되지 않았습니다.`);
}

export async function deploySite({ netlifyToken, siteName, siteId, dir, zipPath, serviceName }) {
  log(`[${serviceName}] deploySite 시작: siteName=${siteName} siteId=${siteId || '신규'} zipPath=${zipPath || '없음'}`);
  let site;
  let currentName = siteName;

  if (siteId) {
    try {
      site = await apiGet(`/sites/${siteId}`, netlifyToken);
      log(`[${serviceName}] 기존 사이트 재배포: ${site.name} (${site.url})`);
    } catch (e) {
      site = { id: siteId, name: currentName };
      warn(`[${serviceName}] 사이트 정보 조회 실패, 이름 추정 사용`);
    }
  } else {
    try {
      const sites = await apiGet(`/sites`, netlifyToken);
      const existing = sites?.find(s => s.name === currentName);
      if (existing) {
        site = existing;
        log(`[${serviceName}] 기존 사이트 재사용: ${site.url}`);
      }
    } catch (e) {
      warn(`[${serviceName}] 기존 사이트 조회 실패`);
    }

    if (!site) {
      let attempts = 0;
      while (attempts < 5) {
        try {
          site = await apiPost('/sites', netlifyToken, { name: currentName });
          log(`[${serviceName}] 신규 사이트 생성: ${site.url}`);
          break;
        } catch (e) {
          const msg = e.message || '';
          if (msg.includes('unique') || msg.includes('422') || msg.includes('subdomain')) {
            attempts++;
            currentName = siteName + '-' + Math.floor(Math.random() * 9000 + 1000);
            warn(`[${serviceName}] 이름 중복, 재시도: ${currentName}`);
          } else { throw e; }
        }
      }
      if (!site) throw new Error('사이트 생성 실패');
    }
  }

  let zipBuf;
  if (zipPath) {
    log(`[${serviceName}] ZIP 파일 직접 업로드 (비권장 — index.html 위치 확인 필요): ${zipPath}`);
    zipBuf = fs.readFileSync(zipPath);
  } else {
    const deployRoot = resolveDeployRoot(dir);
    const files = fs.readdirSync(deployRoot);
    log(`[${serviceName}] 배포 루트: ${deployRoot}`);
    log(`[${serviceName}] 배포 파일: ${files.slice(0, 12).join(', ')}${files.length > 12 ? '...' : ''}`);
    if (!fs.existsSync(path.join(deployRoot, 'index.html'))) {
      throw new Error(`배포 ZIP에 index.html이 없습니다: ${deployRoot}`);
    }
    zipBuf = await zipDir(deployRoot);
  }
  log(`[${serviceName}] zip 크기: ${zipBuf.length} bytes`);

  log(`[${serviceName}] 업로드 중...`);
  const deploy = await uploadDeployZip(site.id, netlifyToken, zipBuf);
  log(`[${serviceName}] 배포 응답 state: ${deploy.state}`);

  await waitForDeployReady(site.id, deploy.id, netlifyToken, serviceName);

  const publicUrl = sitePublicUrl(site);
  await verifySiteLive(publicUrl, serviceName);

  const result = {
    url: publicUrl,
    siteId: site.id,
    deployId: deploy.id,
    state: deploy.state,
  };
  log(`[${serviceName}] deploySite 완료: ${result.url}`);
  return result;
}
