import fs from 'fs';
import path from 'path';

const PROVIDERS = new Set(['netlify', 'cloudflare', 'dothome']);

export function siteKey(provider, name) {
  return `${String(provider || '').trim()}:${String(name || '').trim().toLowerCase()}`;
}

/** 설정 탭 전체 실행 → 배포결과 전용 */
export function isSettingsDeployResult(row = {}) {
  const s = String(row?.source || '').toLowerCase();
  if (/kkang|dothome|cloudflare|cf-pages|cf_pages/.test(s)) return false;
  if (/settings|pipeline/.test(s)) return true;
  // 구버전: source 없음 → 배포결과로 취급
  return !s;
}

/** 생성 사이트 탭 전용 (설정 탭 ZIP/전체실행 제외) */
export function isCreatedSitesEntry(site = {}) {
  const from = String(site?.detail?.from || '').toLowerCase();
  if (/settings|pipeline/.test(from)) return false;
  return true;
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

function stripHtmlText(raw = '') {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractHtmlTitle(siteDir) {
  try {
    const p = path.join(String(siteDir || ''), 'index.html');
    if (!fs.existsSync(p)) return '';
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return '';
    return stripHtmlText(m[1]).slice(0, 160);
  } catch {
    return '';
  }
}

/** index.html 첫 H1 텍스트 (키워드 요약용) */
export function extractHtmlH1(siteDir) {
  try {
    const p = path.join(String(siteDir || ''), 'index.html');
    if (!fs.existsSync(p)) return '';
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!m) return '';
    return stripHtmlText(m[1]).slice(0, 160);
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

/** 로컬 폴더에서 타이틀·H1·네이버 메타를 읽어 목록 보정 (이전 버전 누락 복구) */
export function enrichSitesFromLocal(sites, { kkangOutputRoot = '' } = {}) {
  return (Array.isArray(sites) ? sites : []).map((site) => {
    const detail = { ...(site.detail || {}) };
    const candidates = [
      String(detail.output || '').trim(),
      String(detail.siteDir || '').trim(),
      site.provider === 'netlify' && kkangOutputRoot
        ? path.join(kkangOutputRoot, site.name)
        : '',
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
    if (site.provider === 'netlify' && !detail.output) detail.output = dir;
    if (site.provider === 'dothome' && !detail.siteDir) detail.siteDir = dir;
    if (!detail.title) detail.title = extractHtmlTitle(dir);
    if (!detail.h1) detail.h1 = extractHtmlH1(dir);
    if (!detail.keyword) {
      const fromZip = String(detail.sourcePath || '')
        .split(/[/\\]/).pop()
        .replace(/\.zip$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();
      detail.keyword = detail.title || detail.h1 || fromZip || '';
    }
    if (site.provider === 'netlify') {
      const meta = readNaverMetaFromHtml(dir);
      if (meta) {
        detail.naverMeta = detail.naverMeta || meta;
        const failed = /^(captcha|error|fail|failed|unknown)$/i.test(String(detail.naverStatus || ''))
          || !!detail.naverError;
        if (!failed) {
          detail.naverAuto = true;
          detail.naverStatus = detail.naverStatus || 'success';
          detail.naverError = '';
        } else {
          detail.naverAuto = false;
        }
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

function normalizeDeletedKeys(keys) {
  return [...new Set((Array.isArray(keys) ? keys : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean))];
}

export function siteDeletedKeys(site = {}) {
  const keys = [];
  const id = String(site.id || '').trim();
  if (id) keys.push(id);
  const provider = String(site.provider || '').trim().toLowerCase();
  const name = String(site.name || '').trim();
  if (provider && name) keys.push(siteKey(provider, name));
  return normalizeDeletedKeys(keys);
}

/** { sites, deletedKeys } — 구버전 배열 JSON도 지원 */
export function loadSitesRegistryMeta(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.sites) ? raw.sites : []);
    const deletedKeys = Array.isArray(raw)
      ? []
      : normalizeDeletedKeys(raw?.deletedKeys);
    return {
      sites: list.map(normalizeSiteEntry).filter(Boolean),
      deletedKeys,
    };
  } catch {
    return { sites: [], deletedKeys: [] };
  }
}

export function loadSitesRegistry(filePath) {
  return loadSitesRegistryMeta(filePath).sites;
}

export function isSiteDeleted(site, deletedKeys = []) {
  if (!site) return false;
  const set = new Set(normalizeDeletedKeys(deletedKeys));
  if (!set.size) return false;
  return siteDeletedKeys(site).some((k) => set.has(k));
}

export function filterOutDeletedSites(sites, deletedKeys = []) {
  const set = normalizeDeletedKeys(deletedKeys);
  if (!set.length) return Array.isArray(sites) ? sites : [];
  return (Array.isArray(sites) ? sites : []).filter((s) => !isSiteDeleted(s, set));
}

export function rememberDeletedSites(deletedKeys = [], sitesOrIds = []) {
  const set = new Set(normalizeDeletedKeys(deletedKeys));
  for (const item of Array.isArray(sitesOrIds) ? sitesOrIds : []) {
    if (item && typeof item === 'object') {
      for (const k of siteDeletedKeys(item)) set.add(k);
    } else if (item != null && String(item).trim()) {
      set.add(String(item).trim());
    }
  }
  return [...set];
}

export function forgetDeletedSites(deletedKeys = [], sitesOrIds = []) {
  const remove = new Set();
  for (const item of Array.isArray(sitesOrIds) ? sitesOrIds : []) {
    if (item && typeof item === 'object') {
      for (const k of siteDeletedKeys(item)) remove.add(k);
    } else if (item != null && String(item).trim()) {
      remove.add(String(item).trim());
    }
  }
  if (!remove.size) return normalizeDeletedKeys(deletedKeys);
  return normalizeDeletedKeys(deletedKeys).filter((k) => !remove.has(k));
}

export function saveSitesRegistry(filePath, sites, options = {}) {
  const list = (Array.isArray(sites) ? sites : []).map(normalizeSiteEntry).filter(Boolean);
  const prev = loadSitesRegistryMeta(filePath);
  const deletedKeys = options.deletedKeys !== undefined
    ? normalizeDeletedKeys(options.deletedKeys)
    : prev.deletedKeys;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // deletedKeys를 유지하기 위해 객체 형식으로 저장 (구버전 배열도 로드 가능)
  fs.writeFileSync(
    filePath,
    JSON.stringify({ sites: list, deletedKeys }, null, 2),
    'utf8',
  );
  return list;
}

/** detail 병합 — 빈 문자열로 기존 계정/경로 값을 지우지 않음 */
function mergeSiteDetail(prevDetail = {}, nextDetail = {}) {
  const prev = prevDetail && typeof prevDetail === 'object' ? prevDetail : {};
  const next = nextDetail && typeof nextDetail === 'object' ? nextDetail : {};
  const merged = { ...prev, ...next };
  const keepIfEmpty = [
    'naverAccountId', 'netlifyAccountId', 'accountId', 'hostId', 'ftpId',
    'output', 'siteDir', 'title', 'h1', 'keyword', 'naverMeta', 'brand', 'phone',
    'sourcePath', 'sourceType',
  ];
  for (const key of keepIfEmpty) {
    if (!String(next[key] ?? '').trim() && String(prev[key] ?? '').trim()) {
      merged[key] = prev[key];
    }
  }
  return merged;
}

export function upsertSite(sites, entry) {
  const next = normalizeSiteEntry(entry);
  if (!next) return Array.isArray(sites) ? sites : [];
  const list = Array.isArray(sites) ? [...sites] : [];
  const idx = list.findIndex((s) => s.id === next.id || (s.provider === next.provider && s.name.toLowerCase() === next.name.toLowerCase()));
  if (idx >= 0) {
    const prev = list[idx];
    const mergedDetail = mergeSiteDetail(prev.detail, next.detail);
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

/** 기존 results / dothome accounts / cloudflare 설정에서 통합 목록 시드
 *  - 설정 탭(settings-pipeline) 결과는 배포결과 전용 → 여기로 넣지 않음
 *  - 넷리파이 SEO(kkang) 등만 생성 사이트로 시드
 */
export function mergeLegacySources(existing, { results = [], dothomeAccounts = [], cloudflareSites = [] } = {}) {
  let list = (Array.isArray(existing) ? [...existing] : []).filter(isCreatedSitesEntry);

  for (const r of results || []) {
    const source = String(r.source || '').toLowerCase();
    const url = String(r.url || '').trim();
    // 설정 탭 배포결과는 생성 사이트에 넣지 않음
    if (isSettingsDeployResult(r)) continue;
    const fromKkang = source.includes('kkang');
    if (!fromKkang) continue;
    const slug = url.match(/https?:\/\/([^.]+)\.netlify\.app/i)?.[1] || '';
    const name = slug || String(r.name || '').trim();
    if (!name || !url) continue;
    const st = String(r.status || '').toLowerCase();
    list = upsertSite(list, {
      provider: 'netlify',
      name,
      url,
      createdAt: r.createdAt || r.registeredAt,
      status: r.deployed === false
        ? 'created'
        : ((st === 'success' || st === 'already') ? 'deployed' : (st || 'deployed')),
      detail: {
        brand: r.brand || '',
        pages: r.pages || '',
        output: r.output || '',
        message: r.message || r.error || '',
        title: r.name || '',
        naverStatus: r.status || '',
        naverAccountId: r.naverAccountId || '',
        netlifyAccountId: r.netlifyAccountId || '',
        naverAuto: st === 'success' || st === 'already',
        from: 'kkang',
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
        title: a.title || '',
        h1: a.h1 || '',
        siteDir: a.siteDir || '',
        naverStatus: a.naverStatus || '',
        naverError: a.naverError || '',
        naverAccountId: a.naverAccountId || '',
        hostingStatus: a.hostingStatus || '',
        hostingOk: a.hostingOk,
        hostingIp: a.hostingIp || '',
        hostingError: a.hostingError || '',
        hostingCheckedAt: a.hostingCheckedAt || '',
        generatedAt: a.generatedAt || '',
        deployedAt: a.deployedAt || '',
        sourcePath: a.sourcePath || '',
        sourceType: a.sourceType || '',
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
        brand: c.brand || '',
        phone: c.phone || '',
        notes: c.notes || '',
        title: c.title || '',
        h1: c.h1 || '',
        sourcePath: c.sourcePath || '',
        sourceType: c.sourceType || '',
        naverStatus: c.naverStatus || '',
        naverAccountId: c.naverAccountId || '',
        deployedAt: c.deployedAt || '',
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
  const st = String(naver.status || '').toLowerCase();
  // 메타만 있다고 완료 처리 금지 — 소유확인 성공 상태만 완료
  const naverOk = !naver.partial && isNaverRegistrationDone({
    ...naver,
    naverStatus: st,
    naverMeta: naver.metaContent,
    naverError: result.naverAutoError || naver.error || '',
  }) && ['success', 'already', 'manual'].includes(st);
  let naverError = naverOk
    ? ''
    : String(result.naverAutoError || naver.error || '').trim();
  if (!naverOk && !naverError) {
    if (st === 'captcha') {
      naverError = naver.metaContent
        ? '소유확인 캡챠 실패 (메타는 배포됨) — 수동캡챠로 이어가세요'
        : '소유확인 캡챠 실패 — 수동캡챠로 다시 시도하세요';
    } else if (st) {
      naverError = `네이버 소유확인 미완료 (${st})`;
    }
  }
  const title = String(result.title || '').trim()
    || extractHtmlTitle(result.output || '');
  const h1 = String(result.h1 || '').trim()
    || extractHtmlH1(result.output || '');
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
      h1,
      keyword: title || h1 || '',
      naverAuto: naverOk,
      naverMeta: naver.metaContent || '',
      naverStatus: st || (naverOk ? 'success' : (naverError ? 'error' : '')),
      naverAccountId: naver.naverAccountId
        || result.naverAccountId
        || job.naver_account_id
        || job.naverAccountId
        || '',
      netlifyAccountId: result.netlifyAccountId
        || job.netlify_account_id
        || job.netlifyAccountId
        || '',
      pageUrlCount: result.naverAuto?.pageUrlCount || result.pageUrlCount || 0,
      pageCollectOk: result.naverAuto?.pageCollect
        ? (result.naverAuto.pageCollect.totals?.pagesOk ?? null)
        : null,
      naverError,
      theme: result.theme || result.theme_name || '',
      from: 'kkang',
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
  const siteDir = String(extras.siteDir || account.siteDir || '').trim();
  const title = String(extras.title || account.title || '').trim()
    || (siteDir ? extractHtmlTitle(siteDir) : '');
  const h1 = String(extras.h1 || account.h1 || '').trim()
    || (siteDir ? extractHtmlH1(siteDir) : '');
  const sourcePath = String(extras.sourcePath || account.sourcePath || '').trim();
  const sourceType = String(extras.sourceType || account.sourceType || '').trim();
  let keyword = String(extras.keyword || account.keyword || '').trim();
  if (!keyword) {
    const fromZip = sourcePath.split(/[/\\]/).pop().replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').trim();
    keyword = title || h1 || fromZip || '';
  }
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
      keyword,
      title,
      h1,
      siteDir,
      naverStatus: extras.naverStatus || account.naverStatus || '',
      naverError: extras.naverError != null ? extras.naverError : (account.naverError || ''),
      naverAccountId: extras.naverAccountId || account.naverAccountId || '',
      hostingStatus: extras.hostingStatus != null ? extras.hostingStatus : (account.hostingStatus || ''),
      hostingOk: extras.hostingOk != null ? extras.hostingOk : account.hostingOk,
      hostingIp: extras.hostingIp != null ? extras.hostingIp : (account.hostingIp || ''),
      hostingError: extras.hostingError != null ? extras.hostingError : (account.hostingError || ''),
      hostingTip: extras.hostingTip != null ? extras.hostingTip : (account.hostingTip || ''),
      hostingCheckedAt: extras.hostingCheckedAt || account.hostingCheckedAt || '',
      generatedAt: extras.generatedAt || account.generatedAt || '',
      deployedAt: extras.deployedAt || account.deployedAt || '',
      sourcePath,
      sourceType,
      from: extras.from || 'dothome',
    },
  });
}

export function entryFromCloudflare(project = {}) {
  const name = String(project.name || project.projectName || '').trim();
  if (!name) return null;
  const siteDir = String(project.siteDir || '').trim();
  const sourcePath = String(project.sourcePath || '').trim();
  const sourceType = String(project.sourceType || '').trim();
  const title = String(project.title || '').trim()
    || (siteDir ? extractHtmlTitle(siteDir) : '');
  const h1 = String(project.h1 || '').trim()
    || (siteDir ? extractHtmlH1(siteDir) : '');
  let keyword = String(project.keyword || '').trim();
  if (!keyword) {
    const fromZip = sourcePath.split(/[/\\]/).pop().replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').trim();
    keyword = title || h1 || fromZip || name;
  }
  let status = project.status || 'draft';
  if (project.deployedAt || /deployed|success/i.test(status)) status = 'deployed';
  else if (siteDir || sourcePath) status = status === 'draft' ? 'generated' : status;

  return normalizeSiteEntry({
    provider: 'cloudflare',
    name,
    url: String(project.url || `https://${name}.pages.dev`).trim(),
    createdAt: project.createdAt || new Date().toISOString(),
    updatedAt: project.deployedAt || project.updatedAt || new Date().toISOString(),
    status,
    detail: {
      accountId: project.accountId || '',
      projectName: name,
      brand: project.brand || '',
      phone: project.phone || '',
      notes: project.notes || '',
      keyword,
      title,
      h1,
      siteDir,
      sourcePath,
      sourceType: sourceType || (sourcePath ? 'zip' : ''),
      naverStatus: project.naverStatus || '',
      naverError: project.naverError != null ? project.naverError : '',
      naverAccountId: project.naverAccountId || '',
      deployedAt: project.deployedAt || '',
      from: project.from || 'cloudflare',
    },
  });
}
