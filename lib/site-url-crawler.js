import { shouldStopCrawl, CrawlStopped } from './crawl-cancel.js';

const SKIP_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|webm|avi|mov|xml|json)$/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUrl(raw, base = null) {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return null;
    u.hash = '';
    // Netlify 등 정적 호스팅: /foo.html 과 /foo 는 동일 페이지 → 확장자 제거로 중복 방지
    if (/\.html?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\.html?$/i, '') || '/';
      if (u.pathname.endsWith('/index')) {
        u.pathname = u.pathname.slice(0, -'/index'.length) || '/';
      }
    }
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

function isSameOrigin(a, originHost) {
  try {
    return new URL(a).hostname.replace(/^www\./i, '') === originHost.replace(/^www\./i, '');
  } catch {
    return false;
  }
}

/**
 * Manus 등: sitemap은 커스텀 도메인(card-cash.manus.space)인데
 * 실제 접속 호스트는 cardcash-xxxx.manus.space 인 경우 → 경로만 유지하고 수집 호스트로 재작성
 */
function remapToOrigin(url, homeUrl) {
  try {
    const home = new URL(homeUrl);
    const u = new URL(url);
    const remapped = new URL(u.pathname + u.search, home.origin);
    return normalizeUrl(remapped.href);
  } catch {
    return null;
  }
}

function shouldCrawl(url) {
  const u = new URL(url);
  const path = u.pathname.toLowerCase();
  if (SKIP_EXT.test(path)) return false;
  if (path.includes('/wp-json') || path.includes('/feed') || path.includes('/api/')) return false;
  return true;
}

function extractAnchorHrefs(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = (m[2] || m[3] || m[4] || '').trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw) || /^mailto:/i.test(raw) || /^tel:/i.test(raw)) {
      continue;
    }
    const abs = normalizeUrl(raw, baseUrl);
    if (abs) out.add(abs);
  }
  return [...out];
}

/** SPA 번들/HTML에서 /blog, /board 같은 경로 힌트 추출 */
function extractPathHints(text, homeUrl) {
  const out = new Set();
  const re = /["'`](\/[a-zA-Z][\w\-\/]{0,80})["'`]/g;
  let m;
  while ((m = re.exec(text))) {
    const path = m[1];
    if (SKIP_EXT.test(path)) continue;
    if (path.startsWith('/assets') || path.startsWith('/api') || path.startsWith('/static')) continue;
    if (path.includes('://')) continue;
    const abs = normalizeUrl(path, homeUrl);
    if (abs) out.add(abs);
  }
  return [...out];
}

function extractSitemapLocs(xml) {
  const out = new Set();
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const abs = normalizeUrl(m[1].trim());
    if (abs) out.add(abs);
  }
  return [...out];
}

async function fetchText(url, timeoutMs = 20000, { allowPlain = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const okType = ct.includes('text/html')
      || ct.includes('application/xhtml')
      || ct.includes('xml')
      || (allowPlain && (ct.includes('text/plain') || ct.includes('text/')));
    if (!okType && !allowPlain) {
      return { ok: false, status: res.status, text: '', skip: true };
    }
    const text = await res.text();
    return { ok: true, status: res.status, text, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function collectSitemapCandidates(homeUrl, sendLog) {
  const base = new URL(homeUrl);
  const candidates = [
    new URL('/sitemap.xml', base).href,
    new URL('/sitemap_index.xml', base).href,
    new URL('/sitemap-index.xml', base).href,
  ];

  // robots.txt 의 Sitemap: 지시자도 수집
  const robotsUrl = new URL('/robots.txt', base).href;
  sendLog?.(`robots.txt 확인: ${robotsUrl}`);
  const robots = await fetchText(robotsUrl, 15000, { allowPlain: true });
  if (robots.ok && robots.text) {
    const re = /^Sitemap:\s*(\S+)/gim;
    let m;
    while ((m = re.exec(robots.text))) {
      const sm = normalizeUrl(m[1].trim());
      if (sm && !candidates.includes(sm)) candidates.push(sm);
    }
  }
  return candidates;
}

async function collectFromSitemap(homeUrl, originHost, sendLog) {
  const candidates = await collectSitemapCandidates(homeUrl, sendLog);
  const found = new Set();

  for (const sm of candidates) {
    if (shouldStopCrawl()) throw new CrawlStopped();
    sendLog?.(`sitemap 확인: ${sm}`);
    const res = await fetchText(sm);
    if (!res.ok || !res.text) continue;

    // sitemap index 인 경우 하위 sitemap도 따라감
    const childSitemaps = [];
    if (/<sitemapindex/i.test(res.text)) {
      for (const loc of extractSitemapLocs(res.text)) childSitemaps.push(loc);
    }

    const locSources = childSitemaps.length ? childSitemaps : [null];
    for (const child of locSources) {
      if (shouldStopCrawl()) throw new CrawlStopped();
      let xml = res.text;
      if (child) {
        sendLog?.(`  하위 sitemap: ${child}`);
        const childRes = await fetchText(child);
        if (!childRes.ok || !childRes.text) continue;
        xml = childRes.text;
      }
      for (const loc of extractSitemapLocs(xml)) {
        let target = loc;
        if (!isSameOrigin(loc, originHost)) {
          // 다른 호스트여도 경로를 수집 호스트로 재작성 (Manus 커스텀 도메인 대응)
          const remapped = remapToOrigin(loc, homeUrl);
          if (!remapped) continue;
          sendLog?.(`  호스트 재매핑: ${loc} → ${remapped}`);
          target = remapped;
        }
        if (shouldCrawl(target)) found.add(target);
      }
    }
    if (found.size) break;
  }

  if (found.size) sendLog?.(`sitemap에서 ${found.size}개 URL 발견`);
  return found;
}

async function collectFromJsBundles(homeUrl, html, originHost, sendLog) {
  const found = new Set();
  const scriptRe = /(?:src|href)=["']([^"']+\.js)["']/gi;
  const scripts = [];
  let m;
  while ((m = scriptRe.exec(html))) {
    const abs = normalizeUrl(m[1], homeUrl);
    if (!abs || !isSameOrigin(abs, originHost)) continue;
    if (!/\/assets\//i.test(abs) && !/index-/i.test(abs)) continue;
    scripts.push(abs);
  }
  for (const src of scripts.slice(0, 3)) {
    sendLog?.(`JS 번들에서 경로 추출: ${src}`);
    const res = await fetchText(src, 20000, { allowPlain: true });
    if (!res.ok || !res.text) continue;
    for (const hint of extractPathHints(res.text, homeUrl)) {
      if (isSameOrigin(hint, originHost) && shouldCrawl(hint)) found.add(hint);
    }
  }
  if (found.size) sendLog?.(`JS에서 ${found.size}개 경로 힌트 발견`);
  return found;
}

export async function crawlSiteUrls({
  homeUrl,
  maxPages = 200,
  maxDepth = 5,
  sendLog = null,
} = {}) {
  const start = normalizeUrl(homeUrl);
  if (!start) throw new Error('올바른 사이트 주소를 입력하세요. (https://example.com)');

  const originHost = new URL(start).hostname;
  const visited = new Set();
  const queue = [{ url: start, depth: 0 }];
  const results = new Set([start]);

  sendLog?.(`═══ URL 수집 시작: ${start} ═══`);

  const sitemapUrls = await collectFromSitemap(start, originHost, sendLog);
  if (shouldStopCrawl()) throw new CrawlStopped();
  for (const u of sitemapUrls) {
    results.add(u);
    if (!visited.has(u)) queue.push({ url: u, depth: 1 });
  }

  // 홈 HTML 로드 후 SPA 경로 힌트 보강
  const homeRes = await fetchText(start);
  if (homeRes.ok && homeRes.text) {
    for (const hint of extractPathHints(homeRes.text, start)) {
      if (isSameOrigin(hint, originHost) && shouldCrawl(hint)) {
        results.add(hint);
        if (!visited.has(hint)) queue.push({ url: hint, depth: 1 });
      }
    }
    // sitemap이 비었거나 SPA면 JS 번들에서도 경로 추출
    if (sitemapUrls.size < 2) {
      const jsHints = await collectFromJsBundles(start, homeRes.text, originHost, sendLog);
      for (const u of jsHints) {
        results.add(u);
        if (!visited.has(u)) queue.push({ url: u, depth: 1 });
      }
    }
  }

  while (queue.length && visited.size < maxPages) {
    if (shouldStopCrawl()) {
      sendLog?.('⏹ URL 수집 정지됨');
      throw new CrawlStopped();
    }
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    if (!shouldCrawl(url)) continue;
    sendLog?.(`[${visited.size}/${maxPages}] ${url}`);

    const res = await fetchText(url);
    if (!res.ok) {
      if (!res.skip) sendLog?.(`  ⚠ 로드 실패 (${res.status || res.error || 'unknown'})`);
      await sleep(150);
      continue;
    }

    const pageBase = normalizeUrl(res.finalUrl || url) || url;
    // 리다이렉트가 다른 호스트로 가면 수집 호스트로 재매핑해 결과에 유지
    if (isSameOrigin(pageBase, originHost)) {
      results.add(pageBase);
    } else {
      const remapped = remapToOrigin(pageBase, start);
      if (remapped) results.add(remapped);
      else results.add(url);
    }

    if (depth >= maxDepth) {
      await sleep(100);
      continue;
    }

    const hrefs = extractAnchorHrefs(res.text, pageBase);
    for (const link of hrefs) {
      let target = link;
      if (!isSameOrigin(link, originHost)) {
        // 같은 manus 계열 절대링크면 경로만 가져와 재매핑
        try {
          const h = new URL(link).hostname;
          if (h.endsWith('.manus.space') || h === originHost) {
            target = remapToOrigin(link, start);
          } else {
            continue;
          }
        } catch {
          continue;
        }
      }
      if (!target || !shouldCrawl(target)) continue;
      results.add(target);
      if (!visited.has(target)) queue.push({ url: target, depth: depth + 1 });
    }
    await sleep(120);
  }

  const sorted = [...results].sort((a, b) => a.localeCompare(b, 'ko'));
  sendLog?.(`✅ 수집 완료: ${sorted.length}개 URL (페이지 방문 ${visited.size}개)`);
  return sorted;
}
