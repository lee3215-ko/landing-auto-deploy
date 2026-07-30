import fs from 'fs';
import path from 'path';

const PROVIDERS = new Set(['netlify', 'cloudflare', 'dothome']);

export function siteKey(provider, name) {
  return `${String(provider || '').trim()}:${String(name || '').trim().toLowerCase()}`;
}

/** 네이버 소유확인/등록이 끝난 상태인지 */
export function isNaverRegistrationDone(detailOrResult = {}) {
  const d = detailOrResult || {};
  const st = String(d.naverStatus || d.status || '').toLowerCase();
  // 캡챠·에러는 메타가 있어도 미완료
  if (st === 'captcha' || st === 'error' || st === 'fail' || st === 'failed' || st === 'unknown') {
    return false;
  }
  if (d.naverError && !['success', 'already', 'manual'].includes(st)) {
    return false;
  }
  if (st === 'success' || st === 'already' || st === 'manual') return true;
  if (d.naverAuto === true) return true;
  // 메타만 있고 실패 흔적 없으면 완료로 간주 (구버전 복구)
  if ((d.metaContent || d.naverMeta) && !d.naverError) return true;
  return false;
}

export function extractHtmlTitle(siteDir) {
  try {
    const p = path.join(String(siteDir || ''), 'index.html');
    if (!fs.existsSync(p)) return '';
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return '';
    return String(m[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch {
    return '';
  }
}

function readNaverMetaFromHtml(siteDir) {
  try {
    const p = path.join(String(siteDir || ''), 'index.html');
    if (!fs.existsSync(p)) return '';
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/naver-site-verification[^>]*content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["'][^>]*naver-site-verification/i);
    return m ? String(m[1] || '').trim() : '';
  } catch {
    return '';
  }
}

/** 로컬 폴더에서 타이틀·네이버 메타를 읽어 목록 보정 (이전 버전 누락 복구) */
export function enrichSitesFromLocal(sites, { kkangOutputRoot = '' } = {}) {
  return (Array.isArray(sites) ? sites : []).map((site) => {
    if (site.provider !== 'netlify') return site;
    const detail = { ...(site.detail || {}) };
    const candidates = [
      String(detail.output || '').trim(),
      kkangOutputRoot ? path.join(kkangOutputRoot, site.name) : '',
    ].filter(Boolean);
    let dir = '';
    for (const c of candidates) {
      try {
        if (fs.existsSync(path.join(c, 'index.html'))) {
          dir = c;
          break;
        }
      } catch { /* next */ }
    }
    if (!dir) return site;
    if (!detail.output) detail.output = dir;
    if (!detail.title) detail.title = extractHtmlTitle(dir);
    const meta = readNaverMetaFromHtml(dir);
    if (meta) {
      detail.naverMeta = detail.naverMeta || meta;
      const failed = /^(captcha|error|fail|failed|unknown)$/i.test(String(detail.naverStatus || ''))
        || !!detail.naverError;
      // 캡챠 등으로 소유확인 실패한 경우 메타만으로 「완료」처리하지 않음
      if (!failed) {
        detail.naverAuto = true;
        detail.naverStatus = detail.naverStatus || 'success';
        detail.naverError = '';
      } else {
        detail.naverAuto = false;
      }
    }
    return { ...site, detail };
  });
}

export function normalizeSiteEntry(raw = {}) {
  const provider = String(raw.provider || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const createdAt = raw.createdAt || raw.registeredAt || new Date().toISOString();
  const updatedAt = raw.updatedAt || createdAt;
  const entry = {
    id: String(raw.id || siteKey(provider, name)),
    provider,
    name,
    url: String(raw.url || '').trim(),
    createdAt,
    updatedAt,
    status: String(raw.status || 'created').trim() || 'created',
    detail: raw.detail && typeof raw.detail === 'object' ? { ...raw.detail } : {},
  };
  if ('indexed' in raw) entry.indexed = raw.indexed;
  if (raw.indexMessage != null) entry.indexMessage = String(raw.indexMessage);
  if (raw.indexSampleUrl != null) entry.indexSampleUrl = String(raw.indexSampleUrl || '');
  if (raw.indexResultCount != null) entry.indexResultCount = raw.indexResultCount;
  if (raw.indexQuery != null) entry.indexQuery = String(raw.indexQuery || '');
  if (raw.indexCheckedAt != null) entry.indexCheckedAt = String(raw.indexCheckedAt || '');
  return entry;
}

export function loadSitesRegistry(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.sites) ? raw.sites : []);
    return list.map(normalizeSiteEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveSitesRegistry(filePath, sites) {
  const list = (Array.isArray(sites) ? sites : []).map(normalizeSiteEntry).filter(Boolean);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

export function upsertSite(sites, entry) {
  const next = normalizeSiteEntry(entry);
  if (!next) return Array.isArray(sites) ? sites : [];
  const list = Array.isArray(sites) ? [...sites] : [];
  const idx = list.findIndex((s) => s.id === next.id || (s.provider === next.provider && s.name.toLowerCase() === next.name.toLowerCase()));
  if (idx >= 0) {
    const prev = list[idx];
    const mergedDetail = { ...(prev.detail || {}), ...(next.detail || {}) };
    // 새 값이 실패면 완료로 덮지 않음 / 완료면 실패 메시지 제거
    if (next.detail?.naverAuto === false || next.detail?.naverError
      || /^(captcha|error|fail)/i.test(String(next.detail?.naverStatus || ''))) {
      mergedDetail.naverAuto = false;
      if (next.detail?.naverError) mergedDetail.naverError = next.detail.naverError;
      if (next.detail?.naverStatus) mergedDetail.naverStatus = next.detail.naverStatus;
    } else if (isNaverRegistrationDone(mergedDetail) || next.detail?.naverAuto === true) {
      mergedDetail.naverAuto = true;
      mergedDetail.naverError = '';
      if (!mergedDetail.naverStatus) mergedDetail.naverStatus = 'success';
    }
    const merged = {
      ...prev,
      ...next,
      createdAt: prev.createdAt || next.createdAt,
      updatedAt: next.updatedAt || new Date().toISOString(),
      detail: mergedDetail,
    };
    // 인덱싱 확인 결과는 새 확인이 없으면 유지
    if (!next.indexCheckedAt && prev.indexCheckedAt) {
      merged.indexed = prev.indexed;
      merged.indexMessage = prev.indexMessage;
      merged.indexSampleUrl = prev.indexSampleUrl;
      merged.indexResultCount = prev.indexResultCount;
      merged.indexQuery = prev.indexQuery;
      merged.indexCheckedAt = prev.indexCheckedAt;
    }
    list[idx] = merged;
  } else {
    list.unshift(next);
  }
  return list;
}

export function removeSite(sites, id) {
  const key = String(id || '');
  return (Array.isArray(sites) ? sites : []).filter((s) => s.id !== key);
}

/** 기존 results / dothome accounts / cloudflare 설정에서 통합 목록 시드 */
export function mergeLegacySources(existing, { results = [], dothomeAccounts = [], cloudflareSites = [] } = {}) {
  let list = Array.isArray(existing) ? [...existing] : [];

  for (const r of results || []) {
    const source = String(r.source || '').toLowerCase();
    // 설정탭 대량 배포는 제외 — 넷리파이 생성(kkang)만
    if (!source.includes('kkang')) continue;
    const url = String(r.url || '').trim();
    const name = String(r.name || '').trim() || (url.match(/https?:\/\/([^.]+)\.netlify\.app/i)?.[1] || '');
    if (!name) continue;
    list = upsertSite(list, {
      provider: 'netlify',
      name,
      url,
      createdAt: r.createdAt || r.registeredAt,
      status: r.deployed === false ? 'created' : (r.status || 'deployed'),
      detail: {
        brand: r.brand || '',
        pages: r.pages || '',
        output: r.output || '',
        message: r.message || '',
        from: 'results',
      },
    });
  }

  for (const a of dothomeAccounts || []) {
    const ftpId = String(a.ftpId || '').trim();
    const name = ftpId || String(a.id || '').trim();
    if (!name) continue;
    const url = String(a.url || '').trim()
      || (ftpId ? `https://${ftpId}.dothome.co.kr/` : '');
    let status = 'account';
    if (a.deployedAt) status = 'deployed';
    else if (a.generatedAt || a.siteDir) status = 'generated';
    list = upsertSite(list, {
      provider: 'dothome',
      name,
      url,
      createdAt: a.createdAt || a.generatedAt || a.deployedAt,
      updatedAt: a.deployedAt || a.generatedAt || a.createdAt,
      status,
      detail: {
        hostId: a.id || '',
        ftpId: ftpId || '',
        email: a.email || '',
        phone: a.phone || '',
        keyword: a.keyword || '',
        siteDir: a.siteDir || '',
        naverStatus: a.naverStatus || '',
        generatedAt: a.generatedAt || '',
        deployedAt: a.deployedAt || '',
        from: 'dothome-accounts',
      },
    });
  }

  for (const c of cloudflareSites || []) {
    const name = String(c.name || c.projectName || '').trim();
    if (!name) continue;
    list = upsertSite(list, {
      provider: 'cloudflare',
      name,
      url: String(c.url || `https://${name}.pages.dev`).trim(),
      createdAt: c.createdAt,
      status: c.status || 'draft',
      detail: {
        accountId: c.accountId || '',
        projectName: name,
        notes: c.notes || '',
        from: 'cloudflare',
      },
    });
  }

  return list;
}

export function entryFromNetlifyGenerate(result = {}, job = {}) {
  const name = String(result.site_slug || job.site_slug || '').trim();
  if (!name) return null;
  const naver = result.naverAuto || {};
  const naverOk = isNaverRegistrationDone(naver) || isNaverRegistrationDone({
    naverAuto: !!naver.metaContent && !result.naverAutoError,
    naverMeta: naver.metaContent,
    naverStatus: naver.status,
    naverError: result.naverAutoError || naver.error || '',
  });
  const naverError = naverOk
    ? ''
    : String(result.naverAutoError || naver.error || '').trim();
  const title = String(result.title || '').trim()
    || extractHtmlTitle(result.output || '');
  return normalizeSiteEntry({
    provider: 'netlify',
    name,
    url: String(result.domain || `https://${name}.netlify.app`).trim(),
    createdAt: new Date().toISOString(),
    status: result.deployed ? 'deployed' : 'created',
    detail: {
      brand: job.brand || '',
      phone: job.phone || '',
      pages: result.pages || '',
      output: result.output || '',
      keywords: Array.isArray(job.keywords) ? job.keywords.length : 0,
      title,
      naverAuto: naverOk,
      naverMeta: naver.metaContent || '',
      naverStatus: naver.status || (naverOk ? 'success' : (naverError ? 'error' : '')),
      naverAccountId: naver.naverAccountId || result.naverAccountId || '',
      netlifyAccountId: result.netlifyAccountId || job.netlify_account_id || job.netlifyAccountId || '',
      pageUrlCount: result.naverAuto?.pageUrlCount || result.pageUrlCount || 0,
      pageCollectOk: result.naverAuto?.pageCollect
        ? (result.naverAuto.pageCollect.totals?.pagesOk ?? null)
        : null,
      naverError,
      theme: result.theme || result.theme_name || '',
    },
  });
}

export function entryFromDothomeAccount(account = {}, extras = {}) {
  const ftpId = String(account.ftpId || '').trim();
  const name = ftpId || String(account.id || '').trim();
  if (!name) return null;
  const url = String(extras.url || account.url || '').trim()
    || (ftpId ? `https://${ftpId}.dothome.co.kr/` : '');
  let status = 'account';
  if (extras.deployedAt || account.deployedAt) status = 'deployed';
  else if (extras.generatedAt || account.generatedAt || account.siteDir) status = 'generated';
  return normalizeSiteEntry({
    provider: 'dothome',
    name,
    url,
    createdAt: account.createdAt || new Date().toISOString(),
    updatedAt: extras.deployedAt || extras.generatedAt || new Date().toISOString(),
    status,
    detail: {
      hostId: account.id || '',
      ftpId: ftpId || '',
      email: account.email || '',
      phone: account.phone || '',
      keyword: extras.keyword || account.keyword || '',
      siteDir: extras.siteDir || account.siteDir || '',
      naverStatus: extras.naverStatus || account.naverStatus || '',
      generatedAt: extras.generatedAt || account.generatedAt || '',
      deployedAt: extras.deployedAt || account.deployedAt || '',
    },
  });
}

export function entryFromCloudflare(project = {}) {
  const name = String(project.name || project.projectName || '').trim();
  if (!name) return null;
  return normalizeSiteEntry({
    provider: 'cloudflare',
    name,
    url: String(project.url || `https://${name}.pages.dev`).trim(),
    createdAt: project.createdAt || new Date().toISOString(),
    status: project.status || 'draft',
    detail: {
      accountId: project.accountId || '',
      projectName: name,
      brand: project.brand || '',
      phone: project.phone || '',
      notes: project.notes || '기본 틀 저장',
    },
  });
}
