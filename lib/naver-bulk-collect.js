import fs from 'fs';
import path from 'path';
import { launchBrowser, findSystemChrome } from './puppeteer-launch.js';
import {
  loginNaverForAdvisor,
  normalizeAdvisorSiteUrl,
  toAdvisorCrawlPageUrl,
  escapeAdvisorOauthCallback,
  selectFastCrawlMode,
  requestRobotsTxtCollect,
  submitAdvisorTextRequest,
} from './naver-register.js';
import { confirmOwnershipViaBoard } from './naver-ownership.js';
import { log as sharedLog } from './logger.js';
import {
  throwIfCrawlStopped,
  CrawlStopped,
  setCrawlActiveBrowser,
  clearCrawlActiveBrowser,
  shouldStopCrawl,
} from './crawl-cancel.js';

const BOARD = 'https://searchadvisor.naver.com/console/board';

async function sleep(ms) {
  const step = 200;
  let left = ms;
  while (left > 0) {
    throwIfCrawlStopped();
    const chunk = Math.min(step, left);
    await new Promise((r) => setTimeout(r, chunk));
    left -= chunk;
  }
}

function relay(sendLog, msg) {
  // setLogger가 sendLog와 같으면 sharedLog+sendLog 이중 호출로 로그가 두 번 찍힘 → 한 경로만
  if (typeof sendLog === 'function') sendLog(msg);
  else sharedLog(`[NAVER-COLLECT] ${msg}`);
}

function urlKey(u) {
  return String(u || '').trim().replace(/\/$/, '').toLowerCase();
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    const u = normalizeAdvisorSiteUrl(raw);
    if (!u || seen.has(urlKey(u))) continue;
    seen.add(urlKey(u));
    out.push(u);
  }
  return out;
}

/**
 * jobs: [{ siteUrl, pageUrls }]
 * - sites: [{ homeUrl, urls }] 하위 페이지 포함
 * - siteUrls: 홈만 (하위 없으면 홈 1건)
 */
function normalizeSiteJobs({ homeUrl, urls = [], sites, siteUrls } = {}) {
  const jobs = [];
  const seen = new Set();

  const pushJob = (homeRaw, pageList) => {
    const siteUrl = normalizeAdvisorSiteUrl(homeRaw);
    if (!siteUrl || seen.has(urlKey(siteUrl))) return;
    seen.add(urlKey(siteUrl));
    let pageUrls = dedupeUrls(pageList || []);
    if (!pageUrls.length) pageUrls = [siteUrl];
    else if (!pageUrls.some((u) => urlKey(u) === urlKey(siteUrl))) {
      pageUrls = [siteUrl, ...pageUrls];
    }
    jobs.push({ siteUrl, pageUrls });
  };

  if (Array.isArray(sites) && sites.length) {
    for (const s of sites) {
      pushJob(s.homeUrl || s.siteUrl || s.url || '', s.urls || s.pageUrls || []);
    }
  } else if (Array.isArray(siteUrls) && siteUrls.length) {
    for (const u of siteUrls) pushJob(u, [u]);
  } else if (homeUrl) {
    pushJob(homeUrl, urls);
  }
  return jobs;
}

async function freshPage(browser) {
  // 기존 탭 재사용 — about:blank 남발 방지
  try {
    const { getOrCreateSharedPage, adoptSessionPage } = await import('./naver-session.js');
    const shared = await getOrCreateSharedPage(browser);
    if (shared) {
      adoptSessionPage(shared);
      return shared;
    }
  } catch { /* fall through */ }
  const pages = await browser.pages().catch(() => []);
  const prefer = pages.find((p) => /searchadvisor\.naver\.com/i.test(p.url() || ''))
    || pages.find((p) => {
      const u = p.url() || '';
      return u && u !== 'about:blank' && !u.startsWith('chrome://');
    })
    || pages[0];
  if (prefer) {
    try { await prefer.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'); } catch { /* ignore */ }
    return prefer;
  }
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  return page;
}

function isDetachedError(err) {
  return /detached Frame|Execution context was destroyed|Target closed|Session closed/i.test(err?.message || String(err || ''));
}

/**
 * 사이트 1개: 빠르게 → robots → 사이트맵 → 하위 페이지별 웹페이지 수집
 */
async function collectOneSite({
  page,
  ensurePage,
  siteUrl,
  pageUrls = [],
  folder,
  sendLog,
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  doFast = true,
  doRobots = true,
  doSitemap = true,
  doWebpage = true,
}) {
  const encodedSite = encodeURIComponent(siteUrl);
  const targets = dedupeUrls(pageUrls.length ? pageUrls : [siteUrl]);
  const stats = {
    ownership: null,
    fast: false,
    robots: false,
    sitemap: false,
    webpage: false,
    pagesOk: 0,
    pagesFail: 0,
    pageTotal: targets.length,
  };
  const sitemapUrl = `${siteUrl.replace(/\/$/, '')}/sitemap.xml`;

  throwIfCrawlStopped();
  // 보드에서 「소유확인 진행」유무 분기 → 필요 시 HTML태그+캡챠 자동 소유확인
  relay(sendLog, `소유확인 확인 중... (${siteUrl})`);
  page = await ensurePage();
  try {
    const ownership = await confirmOwnershipViaBoard(page, siteUrl, {
      openaiApiKey,
      yesCaptchaClientKey,
      outputFolder: folder,
      sendLog,
    });
    stats.ownership = ownership;
    relay(sendLog, ownership.neededVerify
      ? (ownership.ok ? '✅ 자동 소유확인 완료' : `⚠ 소유확인: ${ownership.message}`)
      : `✅ ${ownership.message}`);
  } catch (e) {
    if (e?.name === 'CrawlStopped' || e?.cancelled) throw e;
    relay(sendLog, `⚠ 소유확인 분기 예외: ${e.message} — 사이트 관리로 계속`);
    stats.ownership = { ok: false, owned: false, neededVerify: true, message: e.message };
    if (isDetachedError(e)) {
      throwIfCrawlStopped();
      page = await ensurePage();
    }
  }

  throwIfCrawlStopped();
  relay(sendLog, `사이트 요약 콘솔 이동... (${siteUrl}) · 하위 URL ${targets.length}개`);
  page = await ensurePage();
  await page.goto(`https://searchadvisor.naver.com/console/site/summary?site=${encodedSite}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await sleep(2500);
  relay(sendLog, `현재 페이지: ${page.url()}`);

  const summaryText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/등록되지\s*않은\s*사이트|소유\s*확인이\s*필요|사이트를\s*등록/.test(summaryText)
    && !/요청\s*내역|수집\s*현황|웹\s*페이지/.test(summaryText)) {
    relay(sendLog, '⚠ 사이트가 서치어드바이저에 등록/소유확인되지 않은 것으로 보입니다. 소유확인 후에도 동일하면 수동 확인이 필요합니다.');
  }

  if (doFast) {
    throwIfCrawlStopped();
    relay(sendLog, '설정 > 수집 주기 > 빠르게 선택...');
    page = await ensurePage();
    try {
      stats.fast = !!(await selectFastCrawlMode(page, siteUrl, folder));
      relay(sendLog, stats.fast ? '✅ 수집주기 빠르게' : '⚠ 수집주기 빠르게 실패 (계속)');
    } catch (e) {
      if (e?.name === 'CrawlStopped' || e?.cancelled) throw e;
      relay(sendLog, `⚠ 수집주기 빠르게 예외: ${e.message}`);
    }
    await sleep(800);
  }

  if (doRobots) {
    throwIfCrawlStopped();
    relay(sendLog, 'robots.txt 수집 요청...');
    page = await ensurePage();
    try {
      const robots = await requestRobotsTxtCollect(page, siteUrl, folder);
      if (robots?.ok) {
        stats.robots = true;
        relay(sendLog, `✅ robots.txt 수집 요청 (${robots.button || 'OK'})`);
      } else {
        relay(sendLog, `⚠ robots.txt 수집 요청 실패: ${robots?.reason || 'unknown'} (계속 진행)`);
      }
    } catch (e) {
      if (e?.name === 'CrawlStopped' || e?.cancelled) throw e;
      relay(sendLog, `⚠ robots.txt 예외: ${e.message}`);
    }
    await sleep(1000);
  }

  if (doSitemap) {
    throwIfCrawlStopped();
    const sitemapPage = `https://searchadvisor.naver.com/console/site/request/sitemap?site=${encodedSite}`;
    relay(sendLog, `사이트맵 제출: ${sitemapUrl}`);
    page = await ensurePage();
    try {
      const sm = await submitAdvisorTextRequest(page, sitemapPage, sitemapUrl, folder, { screenshotTag: 'sitemap_submit' });
      if (sm.ok) {
        stats.sitemap = true;
        relay(sendLog, `✅ 사이트맵 제출 (${sm.button})`);
      } else {
        relay(sendLog, `⚠ 사이트맵 제출 실패: ${sm.reason || 'unknown'}`);
        if (/미등록|권한/.test(sm.reason || '')) {
          relay(sendLog, '소유확인이 안 된 사이트는 수집 요청 폼이 없습니다. 이 사이트는 건너뜁니다.');
          return {
            siteUrl,
            sitemapUrl,
            pageUrls: targets,
            stats,
            skipped: true,
            ok: false,
            message: sm.reason || '사이트 미등록/권한 없음',
          };
        }
      }
    } catch (e) {
      if (e?.name === 'CrawlStopped' || e?.cancelled) throw e;
      relay(sendLog, `⚠ 사이트맵 예외: ${e.message}`);
      if (isDetachedError(e)) {
        throwIfCrawlStopped();
        page = await ensurePage();
      }
    }
    await sleep(1200);
  }

  if (doWebpage) {
    const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodedSite}`;
    let consecutiveFails = 0;
    for (let i = 0; i < targets.length; i++) {
      throwIfCrawlStopped();
      const target = targets[i];
      // 경로(/limit-guide.html)만 넣으면 빨간 오류 — 배포 전체 URL 필수
      const crawlUrl = toAdvisorCrawlPageUrl(siteUrl, target);
      relay(sendLog, `[${i + 1}/${targets.length}] 웹페이지 수집: ${crawlUrl}`);
      try {
        page = await ensurePage();
        await escapeAdvisorOauthCallback(page, crawlPage);
        const res = await submitAdvisorTextRequest(page, crawlPage, crawlUrl, folder, {
          screenshotTag: `crawl_${i + 1}`,
        });
        if (res.ok) {
          stats.pagesOk += 1;
          consecutiveFails = 0;
          relay(sendLog, `  ✅ 제출 (${res.button})`);
        } else {
          stats.pagesFail += 1;
          consecutiveFails += 1;
          relay(sendLog, `  ⚠ 실패: ${res.reason || 'unknown'}`);
          if (/미등록|권한/.test(res.reason || '') || consecutiveFails >= 5) {
            relay(sendLog, '연속 실패가 많아 이 사이트를 중단합니다.');
            break;
          }
        }
      } catch (e) {
        if (e?.name === 'CrawlStopped' || e?.cancelled) throw e;
        stats.pagesFail += 1;
        consecutiveFails += 1;
        relay(sendLog, `  ⚠ 예외: ${e.message}`);
        if (isDetachedError(e)) {
          throwIfCrawlStopped();
          page = await ensurePage();
        }
        if (consecutiveFails >= 5) {
          relay(sendLog, '연속 예외로 이 사이트를 중단합니다.');
          break;
        }
      }
      await sleep(1200);
    }
    stats.webpage = stats.pagesOk > 0;
  }

  const parts = [];
  if (doFast) parts.push(stats.fast ? '빠르게✓' : '빠르게✗');
  if (doRobots) parts.push(stats.robots ? 'robots✓' : 'robots✗');
  if (doSitemap) parts.push(stats.sitemap ? '사이트맵✓' : '사이트맵✗');
  if (doWebpage) parts.push(`웹수집 ${stats.pagesOk}/${targets.length}`);
  const message = parts.length ? parts.join(', ') : '옵션 없음';
  const ok = doWebpage
    ? stats.pagesOk > 0
    : (stats.fast || stats.robots || stats.sitemap);

  relay(sendLog, `사이트 완료 — ${message}`);
  return { siteUrl, sitemapUrl, pageUrls: targets, stats, ok, message };
}

/**
 * 네이버 서치어드바이저 웹페이지 수집 진행
 * 사이트별: 빠르게/robots/사이트맵 + 하위 URL 전부 웹페이지 수집 신청
 */
export async function submitNaverBulkCollection({
  homeUrl,
  urls = [],
  sites,
  siteUrls,
  naverAccount = null,
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  outputRoot,
  sendLog = null,
  headless = false,
  doFast = true,
  doRobots = true,
  doSitemap = true,
  doWebpage = true,
  onItemStart = null,
  onItemDone = null,
  browser: externalBrowser = null,
  page: externalPage = null,
  keepBrowserOpen = false,
  skipLogin = false,
  /** false면 공유 세션 메인 탭 핸들을 바꾸지 않음 (수동캡챠 새 탭용) */
  adoptSession = true,
} = {}) {
  const jobs = normalizeSiteJobs({ homeUrl, urls, sites, siteUrls });
  if (!jobs.length) throw new Error('수집할 사이트 URL이 없습니다.');
  if (!(doFast || doRobots || doSitemap || doWebpage)) {
    throw new Error('수집 옵션을 하나 이상 선택하세요. (빠르게 / robots / 사이트맵 / 웹페이지 수집)');
  }

  const folder = path.join(outputRoot || path.join(process.cwd(), 'output'), `naver-collect-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });

  const chromePath = findSystemChrome();
  const totalPages = jobs.reduce((n, j) => n + j.pageUrls.length, 0);
  const opts = [];
  if (doFast) opts.push('빠르게');
  if (doRobots) opts.push('robots');
  if (doSitemap) opts.push('사이트맵');
  if (doWebpage) opts.push('웹수집');

  relay(sendLog, `═══ 네이버 웹페이지 수집 진행: ${jobs.length}개 사이트 · URL ${totalPages}개 — ${opts.join(', ')} ═══`);
  relay(sendLog, chromePath
    ? `브라우저: 실제 Chrome (${chromePath})`
    : '브라우저: Puppeteer 번들 Chromium (시스템 Chrome 없음)');
  relay(sendLog, `모드: ${headless ? '헤드리스(창 숨김)' : '창 표시'}${externalBrowser ? ' · 공유세션' : ''}`);

  const ownsBrowser = !externalBrowser;
  let browser = externalBrowser;
  if (!browser) {
    const { getNaverSessionProfileDir } = await import('./naver-session.js');
    browser = await launchBrowser({
      headless: !!headless,
      userDataDir: getNaverSessionProfileDir(),
      args: ['--window-size=1400,900', '--window-position=120,80'],
      defaultViewport: { width: 1400, height: 900 },
    });
  }
  if (ownsBrowser) setCrawlActiveBrowser(browser);

  let page = externalPage || await freshPage(browser);
  if (adoptSession) {
    try {
      const { adoptSessionPage } = await import('./naver-session.js');
      adoptSessionPage(page);
    } catch { /* ignore */ }
  }

  const ensurePage = async () => {
    throwIfCrawlStopped();
    try {
      await page.evaluate(() => true);
      // 중간에 OAuth callback에 머물면 보드로 탈출 (이전 수정 강화)
      if (await escapeAdvisorOauthCallback(page, BOARD)) {
        relay(sendLog, 'OAuth 콜백 탈출 → 보드 복귀');
      }
      return page;
    } catch (e) {
      throwIfCrawlStopped();
      if (shouldStopCrawl()) throw new CrawlStopped();
      // 전용 탭(수동캡챠)이면 메인 탭을 훔치지 않고 같은 브라우저에 새 탭만 연다
      if (!adoptSession && externalBrowser) {
        relay(sendLog, '⚠ 전용 탭 손상 — 새 탭으로 복구');
        page = await browser.newPage();
        try {
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        } catch { /* ignore */ }
      } else {
        relay(sendLog, '⚠ 페이지/프레임 손상 — 기존 탭으로 복구');
        page = await freshPage(browser);
        try {
          const { adoptSessionPage } = await import('./naver-session.js');
          adoptSessionPage(page);
        } catch { /* ignore */ }
      }
      await escapeAdvisorOauthCallback(page, BOARD);
      return page;
    }
  };

  const results = [];
  const totals = { fastOk: 0, robotsOk: 0, sitemapOk: 0, pagesOk: 0, pagesFail: 0, webpageOk: 0, fail: 0 };
  let stopped = false;

  try {
    throwIfCrawlStopped();
    if (!skipLogin) {
      const hasCreds = !!(naverAccount?.id && naverAccount?.pw);
      if (hasCreds) {
        relay(sendLog, `네이버 자동 로그인 (계정: ${naverAccount.id})...`);
        await loginNaverForAdvisor(page, naverAccount, {
          openaiApiKey, yesCaptchaClientKey, outputFolder: folder, manualOnly: false,
        });
      } else {
        relay(sendLog, '네이버 로그인 창 열기 (직접 로그인)...');
        await loginNaverForAdvisor(page, null, {
          openaiApiKey, yesCaptchaClientKey, outputFolder: folder, manualOnly: true,
        });
      }
    } else {
      relay(sendLog, '공유 네이버 세션 — 로그인 생략');
    }

    throwIfCrawlStopped();
    relay(sendLog, '서치어드바이저 보드 이동...');
    await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    if (await escapeAdvisorOauthCallback(page, BOARD)) {
      relay(sendLog, 'OAuth 콜백 감지 — 보드로 재이동');
      await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(2000);
    }

    for (let si = 0; si < jobs.length; si++) {
      throwIfCrawlStopped();
      const job = jobs[si];
      const index = si + 1;
      const total = jobs.length;
      relay(sendLog, `\n═══ [${index}/${total}] ${job.siteUrl} (URL ${job.pageUrls.length}개) ═══`);
      if (typeof onItemStart === 'function') {
        try {
          onItemStart({
            siteUrl: job.siteUrl,
            index,
            total,
            pageCount: job.pageUrls.length,
          });
        } catch { /* ignore */ }
      }

      let out;
      try {
        out = await collectOneSite({
          page,
          ensurePage,
          siteUrl: job.siteUrl,
          pageUrls: job.pageUrls,
          folder,
          sendLog,
          openaiApiKey,
          yesCaptchaClientKey,
          doFast,
          doRobots,
          doSitemap,
          doWebpage,
        });
      } catch (e) {
        if (e?.name === 'CrawlStopped' || e?.cancelled || shouldStopCrawl()) {
          stopped = true;
          relay(sendLog, '⏹ 사용자가 정지했습니다.');
          out = {
            siteUrl: job.siteUrl,
            pageUrls: job.pageUrls,
            stats: { fast: false, robots: false, sitemap: false, webpage: false, pagesOk: 0, pagesFail: 0 },
            ok: false,
            message: e.message || '사용자가 정지했습니다.',
            error: e.message || '사용자가 정지했습니다.',
            stopped: true,
          };
          results.push(out);
          if (typeof onItemDone === 'function') {
            try {
              onItemDone({
                siteUrl: out.siteUrl,
                index,
                total,
                ok: false,
                message: out.message,
                stats: out.stats || {},
                pageCount: job.pageUrls.length,
                skipped: false,
                stopped: true,
              });
            } catch { /* ignore */ }
          }
          break;
        }
        relay(sendLog, `❌ 사이트 처리 실패: ${e.message}`);
        out = {
          siteUrl: job.siteUrl,
          pageUrls: job.pageUrls,
          stats: { fast: false, robots: false, sitemap: false, webpage: false, pagesOk: 0, pagesFail: job.pageUrls.length },
          ok: false,
          message: e.message,
          error: e.message,
        };
        try { page = await ensurePage(); } catch { /* stop or closed */ }
      }

      results.push(out);
      if (out.stats?.fast) totals.fastOk += 1;
      if (out.stats?.robots) totals.robotsOk += 1;
      if (out.stats?.sitemap) totals.sitemapOk += 1;
      totals.pagesOk += out.stats?.pagesOk || 0;
      totals.pagesFail += out.stats?.pagesFail || 0;
      if (out.ok) totals.webpageOk += 1;
      else totals.fail += 1;

      if (typeof onItemDone === 'function') {
        try {
          onItemDone({
            siteUrl: out.siteUrl,
            index,
            total,
            ok: !!out.ok,
            message: out.message || out.error || '',
            stats: out.stats || {},
            pageCount: (out.pageUrls || job.pageUrls || []).length,
            skipped: !!out.skipped,
          });
        } catch { /* ignore */ }
      }

      if (si < jobs.length - 1) await sleep(1500);
    }

    if (stopped || shouldStopCrawl()) {
      relay(sendLog, `\n⏹ 정지됨 — 사이트 ${results.length}개 처리 · 페이지 ${totals.pagesOk}성공/${totals.pagesFail}실패`);
      const err = new CrawlStopped();
      err.partial = {
        sites: results,
        totals,
        okCount: results.filter((r) => r.ok).length,
      };
      throw err;
    }

    relay(sendLog, `\n✅ 전체 완료 — 사이트 ${results.length}개 · 페이지 ${totals.pagesOk}성공/${totals.pagesFail}실패 · 빠르게 ${totals.fastOk} · robots ${totals.robotsOk} · 사이트맵 ${totals.sitemapOk}`);

    const first = results[0] || {};
    return {
      siteUrl: first.siteUrl,
      sitemapUrl: first.sitemapUrl,
      stats: first.stats || {},
      sites: results,
      totals,
      okCount: results.filter((r) => r.ok).length,
    };
  } finally {
    if (ownsBrowser) clearCrawlActiveBrowser();
    if (!keepBrowserOpen && ownsBrowser) {
      if (!headless && !shouldStopCrawl() && !stopped) {
        relay(sendLog, '브라우저 종료 (10초 후)');
        try { await sleep(10000); } catch { /* stopped during wait */ }
      } else {
        relay(sendLog, '브라우저 종료');
      }
      await browser.close().catch(() => {});
    } else {
      relay(sendLog, '공유 네이버 세션 유지 (브라우저 닫지 않음)');
    }
  }
}
