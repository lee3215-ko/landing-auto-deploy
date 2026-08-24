/**
 * Cloudflare Pages — 프로젝트 생성 + Direct Upload 배포
 * (wrangler 없이 REST API)
 */
import fs from 'fs';
import path from 'path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

const IGNORE_NAMES = new Set([
  '_worker.js',
  '_redirects',
  '_headers',
  '_routes.json',
  '.DS_Store',
  'Thumbs.db',
]);

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

function authHeaders(apiToken) {
  return {
    Authorization: `Bearer ${String(apiToken || '').trim()}`,
    'Content-Type': 'application/json',
  };
}

async function cfJson(url, { method = 'GET', apiToken, body, jwt } = {}) {
  const headers = jwt
    ? { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
    : authHeaders(apiToken);
  const resp = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.success === false) {
    const err = data?.errors?.[0]?.message
      || data?.messages?.[0]
      || data?.error
      || `HTTP ${resp.status}`;
    const e = new Error(String(err));
    e.status = resp.status;
    e.cf = data;
    throw e;
  }
  return data;
}

/** wrangler hashFile 과 동일: blake3(base64(contents)+ext).hex().slice(0,32) */
export function hashPagesFile(contents, relPath) {
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const base64Contents = buf.toString('base64');
  const extension = path.extname(relPath).replace(/^\./, '');
  const input = Buffer.from(base64Contents + extension, 'utf8');
  return bytesToHex(blake3(input)).slice(0, 32);
}

function walkStaticFiles(dir) {
  const out = [];
  const root = path.resolve(dir);
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (IGNORE_NAMES.has(ent.name)) continue;
      if (ent.name === 'node_modules' || ent.name === 'functions' || ent.name === '.git') continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push({ full, rel: rel.replace(/^\/+/, '') });
      }
    }
  };
  walk(root);
  return out;
}

function guessContentType(rel) {
  const ext = path.extname(rel).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

export function sanitizePagesSlug(raw = '') {
  return String(raw || '')
    .toLowerCase()
    .replace(/\.zip$/i, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 58);
}

export function pagesDevUrl(projectName) {
  const slug = sanitizePagesSlug(projectName);
  return slug ? `https://${slug}.pages.dev` : '';
}

export async function getPagesProject(accountId, apiToken, projectName) {
  const name = sanitizePagesSlug(projectName);
  const data = await cfJson(
    `${CF_API}/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`,
    { apiToken },
  );
  return data?.result || null;
}

export async function ensurePagesProject(accountId, apiToken, projectName, { sendLog } = {}) {
  const name = sanitizePagesSlug(projectName);
  if (!name) throw new Error('Cloudflare Pages 프로젝트명이 없습니다.');
  if (!accountId) throw new Error('Cloudflare Account ID가 필요합니다.');
  if (!apiToken) throw new Error('Cloudflare API Token이 필요합니다.');

  try {
    const existing = await getPagesProject(accountId, apiToken, name);
    if (existing) {
      relay(sendLog, `Pages 프로젝트 재사용: ${name}`);
      return existing;
    }
  } catch (e) {
    if (e.status !== 404 && !/not found|does not exist/i.test(e.message || '')) {
      // 404면 생성 진행
      if (!/404|could not find|not found/i.test(`${e.status} ${e.message}`)) {
        relay(sendLog, `⚠ 프로젝트 조회: ${e.message}`);
      }
    }
  }

  relay(sendLog, `Pages 프로젝트 생성: ${name}`);
  try {
    const data = await cfJson(
      `${CF_API}/accounts/${accountId}/pages/projects`,
      {
        method: 'POST',
        apiToken,
        body: {
          name,
          production_branch: 'main',
        },
      },
    );
    return data?.result || { name };
  } catch (e) {
    // 이미 있으면 조회
    if (/already exists|taken|duplicate/i.test(e.message || '')) {
      return getPagesProject(accountId, apiToken, name);
    }
    const tip = /auth|forbidden|permission|token/i.test(e.message || '')
      ? '\n토큰에 Account · Cloudflare Pages · Edit 권한이 있는지 확인하세요.'
      : '';
    throw new Error(`Pages 프로젝트 생성 실패: ${e.message}${tip}`);
  }
}

async function getUploadJwt(accountId, apiToken, projectName) {
  const data = await cfJson(
    `${CF_API}/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/upload-token`,
    { method: 'GET', apiToken },
  );
  const jwt = data?.result?.jwt || data?.result?.token || data?.result;
  if (!jwt || typeof jwt !== 'string') throw new Error('Pages upload-token JWT를 받지 못했습니다.');
  return jwt;
}

/**
 * 정적 폴더를 Cloudflare Pages에 Direct Upload
 * @returns {{ ok:boolean, url:string, projectName:string, deploymentId?:string, fileCount:number }}
 */
export async function deployPagesDirectory({
  accountId,
  apiToken,
  projectName,
  siteDir,
  branch = 'main',
  sendLog,
} = {}) {
  const name = sanitizePagesSlug(projectName);
  const dir = String(siteDir || '').trim();
  if (!fs.existsSync(dir)) throw new Error(`배포 폴더 없음: ${dir}`);

  await ensurePagesProject(accountId, apiToken, name, { sendLog });

  const files = walkStaticFiles(dir);
  if (!files.length) throw new Error('업로드할 정적 파일이 없습니다.');

  relay(sendLog, `Pages 업로드 준비: ${files.length}개 파일`);

  const hashed = files.map(({ full, rel }) => {
    const contents = fs.readFileSync(full);
    const hash = hashPagesFile(contents, rel);
    return {
      full,
      rel,
      hash,
      contents,
      contentType: guessContentType(rel),
    };
  });

  const jwt = await getUploadJwt(accountId, apiToken, name);

  // missing check (optional but faster on redeploy)
  let missing = new Set(hashed.map((h) => h.hash));
  try {
    const miss = await cfJson(`${CF_API}/pages/assets/check-missing`, {
      method: 'POST',
      jwt,
      body: { hashes: hashed.map((h) => h.hash) },
    });
    const list = miss?.result || miss?.result?.hashes || [];
    if (Array.isArray(list) && list.length) {
      missing = new Set(list);
    } else if (Array.isArray(miss?.result) && miss.result.length === 0) {
      missing = new Set();
    }
  } catch {
    /* 전체 업로드 */
  }

  const toUpload = hashed.filter((h) => missing.has(h.hash));
  relay(sendLog, `신규 업로드: ${toUpload.length} / 전체 ${hashed.length}`);

  const BATCH = 40;
  for (let i = 0; i < toUpload.length; i += BATCH) {
    const chunk = toUpload.slice(i, i + BATCH);
    const body = chunk.map((f) => ({
      key: f.hash,
      value: f.contents.toString('base64'),
      metadata: { contentType: f.contentType },
      base64: true,
    }));
    await cfJson(`${CF_API}/pages/assets/upload`, {
      method: 'POST',
      jwt,
      body,
    });
    relay(sendLog, `  업로드 ${Math.min(i + BATCH, toUpload.length)}/${toUpload.length}`);
  }

  if (hashed.length) {
    await cfJson(`${CF_API}/pages/assets/upsert-hashes`, {
      method: 'POST',
      jwt,
      body: { hashes: hashed.map((h) => h.hash) },
    });
  }

  const manifest = {};
  for (const f of hashed) {
    const key = f.rel.startsWith('/') ? f.rel : `/${f.rel}`;
    manifest[key] = f.hash;
  }

  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('branch', branch);

  for (const special of ['_headers', '_redirects']) {
    const p = path.join(dir, special);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const buf = fs.readFileSync(p);
      form.append(special, new Blob([buf], { type: 'text/plain' }), special);
    }
  }

  const deployUrl = `${CF_API}/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/deployments`;
  const resp = await fetch(deployUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${String(apiToken).trim()}` },
    body: form,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.success === false) {
    const err = data?.errors?.[0]?.message || `HTTP ${resp.status}`;
    throw new Error(`Pages 배포 생성 실패: ${err}`);
  }

  const result = data?.result || {};
  const url = result.url
    || result.aliases?.[0]
    || pagesDevUrl(name);
  const deploymentId = result.id || '';
  let fileCount = Number(result.latest_stage?.file_count
    ?? result.files?.length
    ?? hashed.length) || hashed.length;

  // 짧게 폴링
  if (deploymentId) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const d = await cfJson(
          `${CF_API}/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/deployments/${deploymentId}`,
          { apiToken },
        );
        const st = d?.result?.latest_stage?.status || d?.result?.stage || '';
        const fc = Number(d?.result?.latest_stage?.file_count || 0);
        if (fc > 0) fileCount = fc;
        if (/success|active|deployed/i.test(String(st))) break;
        if (/failure|failed|error/i.test(String(st))) {
          throw new Error(`Pages 배포 실패 상태: ${st}`);
        }
      } catch (e) {
        if (/배포 실패/.test(e.message || '')) throw e;
      }
    }
  }

  relay(sendLog, `✔ Pages 배포 완료: ${url} (파일 ${fileCount})`);
  return {
    ok: true,
    url: String(url).replace(/\/$/, ''),
    projectName: name,
    deploymentId,
    fileCount,
  };
}
