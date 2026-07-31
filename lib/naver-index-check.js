const SEARCH_SSC = 'tab.nx.all';
const DEFAULT_DELAY_MS = 1500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: 'https://search.naver.com/',
};

const NO_RESULT_PATTERNS = [
  '검색 결과가 없습니다',
  '검색결과가 없습니다',
  '에 대한 검색결과가 없습니다',
  '결과가 없습니다',
];

const TITLE_LINK_RE = /<a nocr="1" href="(https?:\/\/[^"]+)" class="[^"]*bw6s5j6PgZwBpJOh[^"]*"[^>]+data-heatmap-target="\.link"/gi;
const JSON_DESK_HREF_RE = /"deviceType":"desk","href":"(https?:\/\/[^"]+)"/g;

export const INDEX_CHECK_STATUSES = new Set(['success', 'manual']);

/** 인덱싱 확인 대상: URL만 있으면 됨 (네이버 검색, 로그인 불필요) */
export function canIndexCheck(result) {
  return !!(result?.url?.trim());
}

/** 재인젝싱(서치어드바이저 수집 신청) 대상 */
export function canReinjectIndex(result) {
  return !!(
    result?.url
    && INDEX_CHECK_STATUSES.has(result.status)
    && result.indexed === false
    && result.indexCheckedAt
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeHref(href) {
  return href.replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

export function normalizeSite(value) {
  let v = (value || '').trim().toLowerCase();
  if (!v) throw new Error('URL이 비어 있습니다.');
  if (!v.includes('://')) v = `https://${v}`;
  const u = new URL(v);
  let host = (u.hostname || '').replace(/^www\./, '');
  let path = u.pathname.replace(/\/$/, '') || '';
  return host + path;
}

export function urlMatches(resultUrl, target) {
  const result = normalizeSite(resultUrl);
  const targetNorm = normalizeSite(target);
  const resultHost = result.split('/')[0];
  const targetHost = targetNorm.split('/')[0];
  if (resultHost !== targetHost) return false;

  const resultPath = result.slice(resultHost.length).replace(/^\//, '');
  const targetPath = targetNorm.slice(targetHost.length).replace(/^\//, '');
  if (!targetPath) return true;
  if (!resultPath) return true;
  return resultPath.startsWith(targetPath) || targetPath.startsWith(resultPath);
}

function siteSearchQuery(site) {
  let value = site.trim().replace(/\/$/, '');
  if (!value.startsWith('http')) value = `https://${value}`;
  return `site:${value}`;
}

function buildSearchUrl(query, start = 1) {
  const params = new URLSearchParams({
    where: 'nexearch',
    sm: 'tab_hty.top',
    query,
    ssc: SEARCH_SSC,
    start: String(start),
  });
  return `https://search.naver.com/search.naver?${params}`;
}

async function fetchHtml(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function fetchSearchPage(query, start = 1) {
  return fetchHtml(buildSearchUrl(query, start));
}

function htmlHasNoResults(html) {
  if (!html) return false;
  const lowered = html.toLowerCase();
  return NO_RESULT_PATTERNS.some((p) => html.includes(p)) || lowered.includes('search_not_found');
}

/** 제안/교정 블록은 도메인 문자열이 있어도 실제 검색결과가 아님 → 판정 전 제거 */
function stripSuggestBlocks(html) {
  return String(html || '')
    .replace(/<div[^>]*class="[^"]*suggest_wrap[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*sp_nreview[^"]*api_subject_bx[^"]*"[\s\S]{0,8000}/gi, (chunk) =>
      /suggest/i.test(chunk) ? '' : chunk);
}

function extractJsonDeskUrls(html) {
  const urls = [];
  const seen = new Set();
  let m;
  const re = new RegExp(JSON_DESK_HREF_RE.source, 'g');
  while ((m = re.exec(html)) !== null) {
    const link = normalizeHref(m[1]);
    if (seen.has(link)) continue;
    seen.add(link);
    urls.push(link);
  }
  return urls;
}

function extractGenericHttpUrls(html, host) {
  if (!host) return [];
  const urls = [];
  const seen = new Set();
  const hostRe = host.replace(/\./g, '\\.');
  const re = new RegExp(`https?:\\/\\/(?:www\\.)?${hostRe}[^"'\\s<>]*`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    let link = normalizeHref(m[0]).replace(/[),.;]+$/, '');
    try { link = decodeURIComponent(link); } catch { /* keep */ }
    if (seen.has(link)) continue;
    seen.add(link);
    urls.push(link);
  }
  return urls;
}

function extractPageResults(html, siteUrl = '') {
  const results = [];
  const seen = new Set();
  let m;
  const re = new RegExp(TITLE_LINK_RE.source, 'gi');
  while ((m = re.exec(html)) !== null) {
    const link = normalizeHref(m[1]);
    if (seen.has(link)) continue;
    seen.add(link);
    results.push(link);
  }
  if (results.length) return results;

  const jsonUrls = extractJsonDeskUrls(html);
  if (jsonUrls.length) return jsonUrls;

  // 메타/og:title/검색창 쿼리에 들어 있는 site:URL 문자열은 결과가 아님.
  // 본문 a[href] 로만 보조 추출 (head·suggest 제외).
  try {
    const host = normalizeSite(siteUrl).split('/')[0];
    const bodyOnly = String(html || '')
      .replace(/<head[\s\S]*?<\/head>/i, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    const hostPlain = host.replace(/\./g, '\\.');
    const hrefRe = new RegExp(
      `href\\s*=\\s*["'](https?:\\/\\/(?:www\\.)?${hostPlain}[^"']*)["']`,
      'gi',
    );
    const fromHref = [];
    let hm;
    while ((hm = hrefRe.exec(bodyOnly)) !== null) {
      let link = normalizeHref(hm[1]).replace(/[),.;]+$/, '');
      try { link = decodeURIComponent(link); } catch { /* keep */ }
      if (seen.has(link)) continue;
      seen.add(link);
      fromHref.push(link);
    }
    return fromHref;
  } catch {
    return [];
  }
}

/**
 * 네이버가 netlify.app 점을 떼고 "제안"을 띄운 경우,
 * 원문 site: 쿼리 링크(검색결과 보기) href를 찾아 따라간다.
 */
export function extractSuggestFollowUrl(html, expectedQuery) {
  if (!html || !/suggest_wrap/i.test(html)) return null;

  const expected = String(expectedQuery || '').trim();
  let expectedHost = '';
  try {
    const raw = expected.replace(/^site:/i, '').trim();
    expectedHost = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    expectedHost = '';
  }

  const blocks = [];
  const wrapRe = /<div[^>]*class="[^"]*suggest_wrap[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
  let bm;
  while ((bm = wrapRe.exec(html)) !== null) blocks.push(bm[0]);
  if (!blocks.length) {
    const idx = html.search(/class="[^"]*suggest_wrap/i);
    if (idx >= 0) blocks.push(html.slice(idx, idx + 5000));
  }

  for (const block of blocks) {
    // 네이버 제안 링크는 href='...' 작은따옴표인 경우가 많음
    const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
    let hm;
    while ((hm = hrefRe.exec(block)) !== null) {
      const rawHref = normalizeHref(hm[1]);
      if (/help\.naver\.com/i.test(rawHref)) continue;

      let abs;
      try {
        abs = new URL(rawHref, 'https://search.naver.com/search.naver');
      } catch {
        continue;
      }
      if (!/search\.naver\.com/i.test(abs.hostname)) continue;

      let q = abs.searchParams.get('query') || '';
      try { q = decodeURIComponent(q); } catch { /* keep */ }
      const qNorm = q.trim();
      if (!qNorm) continue;

      const exact =
        qNorm === expected
        || qNorm.toLowerCase() === expected.toLowerCase()
        || qNorm.replace(/\s+/g, '') === expected.replace(/\s+/g, '');

      // 제안 source는 "site:… netlify.app"(점→공백), 링크는 올바른 점 포함 쿼리
      const hasHostWithDot = expectedHost && qNorm.toLowerCase().includes(expectedHost);
      const looksLikeSiteQuery = /^site:/i.test(qNorm);

      if ((exact || hasHostWithDot) && looksLikeSiteQuery) {
        return abs.toString();
      }
    }
  }
  return null;
}

function evaluateSearchHtml(html, siteUrl, query) {
  // 제안 박스의 도메인/링크는 검색결과가 아님
  const body = stripSuggestBlocks(html);

  // 「검색결과가 없습니다」→ 미인덱싱 (쿼리 문구에 도메인이 보여도 무시)
  if (htmlHasNoResults(body) || htmlHasNoResults(html)) {
    return { indexed: false, message: '미인덱싱', sampleUrl: null, resultCount: 0, query };
  }

  const urls = extractPageResults(body, siteUrl);
  const matching = urls.filter((u) => {
    try { return urlMatches(u, siteUrl); } catch { return false; }
  });
  let domain = '';
  try { domain = normalizeSite(siteUrl).split('/')[0]; } catch { domain = ''; }
  const domainUrls = domain
    ? urls.filter((u) => {
      try { return normalizeSite(u).split('/')[0] === domain; } catch { return false; }
    })
    : [];

  if (matching.length) {
    return {
      indexed: true,
      message: '인덱싱됨',
      sampleUrl: matching[0],
      resultCount: domainUrls.length || urls.length,
      query,
    };
  }

  if (domainUrls.length) {
    return {
      indexed: true,
      message: `도메인 인덱싱 (${domainUrls.length}건)`,
      sampleUrl: domainUrls[0],
      resultCount: domainUrls.length,
      query,
    };
  }

  // 결과 링크 파싱 실패 시에만: 본문에 실제 결과 카드성 호스트가 보일 때
  // (검색창/쿼리 표시만으로 true 내지 않음 — title 링크·desk href 없을 때 보조)
  if (domain) {
    const hostPlain = domain.replace(/\./g, '\\.');
    // 검색결과 영역 휴리스틱: a[href] 근처 또는 JSON desk href
    const resultish = new RegExp(
      `href=["']https?:\\/\\/(?:www\\.)?${hostPlain}[^"']*["']`,
      'i',
    );
    if (resultish.test(body)) {
      const sample = extractGenericHttpUrls(body, domain)[0] || `https://${domain}/`;
      return {
        indexed: true,
        message: '인덱싱됨 (결과 링크)',
        sampleUrl: sample,
        resultCount: 1,
        query,
      };
    }
  }

  return { indexed: false, message: '미인덱싱', sampleUrl: null, resultCount: 0, query };
}

export async function checkNaverIndex(siteUrl) {
  const query = siteSearchQuery(siteUrl);

  let html;
  try {
    html = await fetchSearchPage(query, 1);
  } catch (e) {
    return {
      indexed: null,
      message: `확인 실패 (${e.message})`,
      sampleUrl: null,
      resultCount: 0,
      query,
    };
  }

  // 오교정 제안이 있으면 반드시 그 링크를 먼저 따라감
  // (첫 화면 제안 박스에 도메인이 보여도 인덱싱됨으로 보지 않음)
  const followUrl = extractSuggestFollowUrl(html, query);
  if (followUrl) {
    try {
      const followedHtml = await fetchHtml(followUrl);
      const followed = evaluateSearchHtml(followedHtml, siteUrl, query);
      return {
        ...followed,
        suggestFollowed: true,
        message: followed.indexed === true
          ? (followed.message === '인덱싱됨' ? '인덱싱됨 (제안 링크)' : `${followed.message} (제안 링크)`)
          : followed.message,
      };
    } catch (e) {
      return {
        indexed: null,
        message: `제안 링크 확인 실패 (${e.message})`,
        sampleUrl: null,
        resultCount: 0,
        query,
      };
    }
  }

  return evaluateSearchHtml(html, siteUrl, query);
}

export function getIndexCheckTargets(results, { skipIndexed = true } = {}) {
  return results
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => {
      if (!canIndexCheck(r)) return false;
      if (skipIndexed && r.indexed === true) return false;
      return true;
    });
}

export function countSkippedIndexed(results) {
  return results.filter(r => canIndexCheck(r) && r.indexed === true).length;
}

export async function checkIndexBatch(results, { indices = null, skipIndexed = true, delayMs = DEFAULT_DELAY_MS, onProgress = null, onSave = null } = {}) {
  const targets = indices != null
    ? indices
        .map(i => ({ index: i, r: results[i] }))
        .filter(({ r }) => r && canIndexCheck(r) && !(skipIndexed && r.indexed === true))
    : getIndexCheckTargets(results, { skipIndexed });

  const skipped = indices == null ? countSkippedIndexed(results) : 0;

  if (!targets.length) {
    return {
      results,
      summary: { checked: 0, indexed: 0, notIndexed: 0, failed: 0, skipped },
    };
  }

  let indexed = 0;
  let notIndexed = 0;
  let failed = 0;

  for (let n = 0; n < targets.length; n++) {
    const { index, r } = targets[n];
    if (onProgress) onProgress({ phase: 'checking', current: n + 1, total: targets.length, url: r.url, name: r.name });

    const status = await checkNaverIndex(r.url);
    const patch = {
      indexed: status.indexed,
      indexMessage: status.message,
      indexSampleUrl: status.sampleUrl,
      indexResultCount: status.resultCount,
      indexQuery: status.query,
      indexCheckedAt: new Date().toISOString(),
    };
    results[index] = { ...results[index], ...patch };

    if (status.indexed === true) indexed++;
    else if (status.indexed === false) notIndexed++;
    else failed++;

    if (onSave) await onSave(results);
    if (onProgress) {
      onProgress({
        phase: 'done',
        current: n + 1,
        total: targets.length,
        index,
        result: results[index],
        status,
      });
    }

    if (n < targets.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return {
    results,
    summary: { checked: targets.length, indexed, notIndexed, failed, skipped },
  };
}
