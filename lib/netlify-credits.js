import fs from 'fs';
import path from 'path';
import {
  launchChromeStandalone,
  connectChromeForAutomation,
  disconnectBrowser,
  isDebugPortOpen,
} from './chrome-connect.js';

export const NETLIFY_CREDITS_PORT = 9335;
export const DEFAULT_TEAM_SLUG = 'minji-cho9475';

const LOGIN_URL = 'https://app.netlify.com/';
const BILLING_GENERAL = (team) => `https://app.netlify.com/teams/${team}/billing/general`;

let state = {
  profileDir: '',
  last: null,
  onUpdate: null,
  onLog: null,
  preferredTeam: DEFAULT_TEAM_SLUG,
};

function log(msg) {
  if (typeof state.onLog === 'function') state.onLog(String(msg));
}

function emit(data) {
  state.last = { ...(state.last || {}), ...data, at: new Date().toISOString() };
  if (typeof state.onUpdate === 'function') state.onUpdate(state.last);
  return state.last;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveTeam(teamSlug = '') {
  return String(teamSlug || state.preferredTeam || DEFAULT_TEAM_SLUG).trim() || DEFAULT_TEAM_SLUG;
}

async function withConnectedBrowser(fn) {
  if (!(await isDebugPortOpen(NETLIFY_CREDITS_PORT))) {
    throw new Error('Netlify Chrome 창이 열려 있지 않습니다. 「Netlify 로그인」을 먼저 실행하세요.');
  }
  let browser;
  try {
    browser = await connectChromeForAutomation({
      port: NETLIFY_CREDITS_PORT,
      quiet: true,
    });
    return await fn(browser);
  } finally {
    await disconnectBrowser(browser);
  }
}

/** 빌링 탭 우선, 없으면 Netlify 탭, 없으면 새 탭 */
async function getBillingPage(browser, team) {
  const billingUrl = BILLING_GENERAL(team);
  const pages = await browser.pages();
  const scored = [];
  for (const p of pages) {
    let url = '';
    try { url = p.url(); } catch { continue; }
    if (!url || url.startsWith('chrome://') || url.startsWith('devtools://')) continue;
    let score = 0;
    if (/\/teams\/[^/]+\/billing/i.test(url)) score += 200;
    if (url.includes(team)) score += 30;
    if (/app\.netlify\.com/i.test(url)) score += 50;
    if (/\/login|\/signup|\/authorize|about:blank/i.test(url)) score -= 80;
    scored.push({ p, url, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 50) return scored[0].p;

  const page = await browser.newPage();
  await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  return page;
}

/** Credits available 파싱 */
export async function scrapeNetlifyCreditsFromPage(page) {
  return page.evaluate(() => {
    const out = {
      ok: false,
      credits: null,
      creditsText: '',
      teamSlug: '',
      loggedIn: false,
      url: location.href,
      debug: '',
    };

    const pathAndSearch = `${location.pathname}${location.search}${location.hash}`;
    out.loggedIn = /app\.netlify\.com/i.test(location.host)
      && !/\/login(?:\/|$|\?)|\/signup(?:\/|$|\?)|\/authorize(?:\/|$|\?)/i.test(pathAndSearch);

    const teamFromHref = (href) => {
      const m = String(href || '').match(/\/teams\/([^/?#]+)/i);
      return m ? m[1] : '';
    };
    out.teamSlug = teamFromHref(location.pathname);

    const parseCredits = (raw) => {
      const text = String(raw || '').replace(/\u00a0/g, ' ').trim();
      const m = text.match(/(\d{1,3}(?:[,.\s]\d{3})+|\d+)/);
      if (!m) return null;
      const credits = parseInt(m[1].replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(credits)) return null;
      return { credits, creditsText: m[1].replace(/\s/g, ',') };
    };

    const apply = (parsed, href = '') => {
      if (!parsed) return false;
      out.ok = true;
      out.credits = parsed.credits;
      out.creditsText = parsed.creditsText;
      if (!out.teamSlug && href) out.teamSlug = teamFromHref(href);
      return true;
    };

    for (const dt of document.querySelectorAll('dt')) {
      if (!/credits?\s*available/i.test((dt.textContent || '').replace(/\s+/g, ' '))) continue;
      const root = dt.closest('a, dl, div') || dt.parentElement;
      const dd = root?.querySelector('dd') || dt.parentElement?.querySelector('dd');
      if (apply(parseCredits(dd?.textContent), dt.closest('a')?.getAttribute('href') || '')) {
        out.debug = 'dt+dd';
        return out;
      }
    }

    for (const a of document.querySelectorAll('a[href*="credit"], a.tw-meter, a[href*="billing"]')) {
      const dd = a.querySelector('dd');
      const t = (a.textContent || '').replace(/\s+/g, ' ');
      if (dd && /credit/i.test(t) && apply(parseCredits(dd.textContent), a.getAttribute('href') || '')) {
        out.debug = 'a>dd';
        return out;
      }
      const m = t.match(/credits?\s*available\s*([\d,.\s]+)/i);
      if (m && apply(parseCredits(m[1]), a.getAttribute('href') || '')) {
        out.debug = 'a-text';
        return out;
      }
    }

    const body = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
    let m = body.match(/credits?\s*available\s*[:：]?\s*([\d,.\s]{1,16})/i)
      || body.match(/credits?\s*available\s*\n+\s*([\d,.\s]{1,16})/i);
    if (m && apply(parseCredits(m[1]))) {
      out.debug = 'body';
      return out;
    }

    const html = document.documentElement?.innerHTML || '';
    m = html.match(/Credits\s*available[\s\S]{0,240}?>([\d,]{1,12})</i);
    if (m && apply(parseCredits(m[1]))) {
      out.debug = 'html';
      return out;
    }

    out.debug = `miss hasLabel=${/credits?\s*available/i.test(body)} path=${location.pathname}`;
    return out;
  });
}

async function waitForCredits(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scraped = await scrapeNetlifyCreditsFromPage(page);
    if (scraped.ok) return scraped;
    await sleep(600);
  }
  return scrapeNetlifyCreditsFromPage(page);
}

/**
 * 빌링 페이지 새로고침 후 크레딧 읽기 (폴링 없음)
 */
export async function refreshNetlifyCredits({ teamSlug = '' } = {}) {
  const team = resolveTeam(teamSlug);
  state.preferredTeam = team;
  const billingUrl = BILLING_GENERAL(team);

  try {
    const scraped = await withConnectedBrowser(async (browser) => {
      const page = await getBillingPage(browser, team);
      const cur = page.url();
      log(`크레딧 새로고침: ${billingUrl}`);

      // 같은 빌링이면 reload, 아니면 이동
      if (/\/teams\/[^/]+\/billing/i.test(cur) && cur.includes(team)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      } else {
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      }
      await sleep(2500);

      let result = await waitForCredits(page, 20000);
      if (!result.ok) {
        // 한 번 더 하드 리로드
        await page.goto(billingUrl, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() =>
          page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }),
        );
        await sleep(3000);
        result = await waitForCredits(page, 15000);
      }
      return result;
    });

    if (!scraped?.loggedIn) {
      return emit({
        ok: false,
        status: 'waiting_login',
        message: '로그인 필요',
        teamSlug: team,
        credits: state.last?.credits ?? null,
        creditsText: state.last?.creditsText || '',
        url: scraped?.url || billingUrl,
      });
    }

    if (scraped.ok) {
      const prev = state.last?.credits;
      const out = emit({
        ok: true,
        status: 'ok',
        message: '',
        credits: scraped.credits,
        creditsText: scraped.creditsText || String(scraped.credits),
        teamSlug: scraped.teamSlug || team,
        url: scraped.url || billingUrl,
      });
      if (prev != null && prev !== scraped.credits) {
        log(`크레딧 변동: ${Number(prev).toLocaleString()} → ${Number(scraped.credits).toLocaleString()}`);
      } else {
        log(`✔ 크레딧: ${out.teamSlug} · ${Number(scraped.credits).toLocaleString()}`);
      }
      return out;
    }

    log(`✖ 크레딧 미검출 (${scraped.debug || ''})`);
    return emit({
      ok: false,
      status: 'no_credits_ui',
      message: 'Credits available을 찾지 못함',
      teamSlug: scraped.teamSlug || team,
      credits: state.last?.credits ?? null,
      creditsText: state.last?.creditsText || '',
      url: scraped.url || billingUrl,
    });
  } catch (e) {
    log(`[ERROR] 크레딧 새로고침: ${e.message}`);
    return emit({
      ok: false,
      status: 'error',
      message: e.message,
      teamSlug: team,
      credits: state.last?.credits ?? null,
      creditsText: state.last?.creditsText || '',
    });
  }
}

/**
 * Chrome 창만 띄움 (수동 로그인). 주기적 수집 없음.
 * 창은 닫지 않음. 크레딧은 새로고침/배포 완료 시에만 읽음.
 */
export async function startNetlifyCreditsMonitor({
  dataRoot,
  teamSlug = '',
  onUpdate,
  onLog,
} = {}) {
  state.onUpdate = onUpdate;
  state.onLog = onLog;
  state.profileDir = path.join(dataRoot || process.cwd(), 'chrome-netlify-credits');
  fs.mkdirSync(state.profileDir, { recursive: true });

  const team = resolveTeam(teamSlug);
  state.preferredTeam = team;
  const startUrl = BILLING_GENERAL(team);

  log('═══ Netlify 로그인 ═══');
  log(`빌링 페이지: ${startUrl}`);
  log('Chrome에서 로그인해 주세요. 크레딧은 「↻ 새로고침」또는 배포 완료 시에만 읽습니다.');

  await launchChromeStandalone({
    userDataDir: state.profileDir,
    port: NETLIFY_CREDITS_PORT,
    startUrl,
    sendLog: log,
  });

  // 이미 열린 세션이면 빌링으로 이동
  try {
    await withConnectedBrowser(async (browser) => {
      const page = await getBillingPage(browser, team);
      if (!page.url().includes(`/teams/${team}/billing`)) {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      }
    });
  } catch (e) {
    log(`[WARN] ${e.message}`);
  }

  emit({
    ok: false,
    status: 'ready',
    message: '로그인 후 ↻ 로 크레딧 확인',
    teamSlug: team,
    credits: state.last?.credits ?? null,
    creditsText: state.last?.creditsText || '',
  });

  // 로그인 직후 한 번만 시도 (주기 폴링 없음)
  await sleep(1500);
  return { ok: true, port: NETLIFY_CREDITS_PORT, teamSlug: team, ...(await refreshNetlifyCredits({ teamSlug: team })) };
}

export function getNetlifyCreditsStatus() {
  return {
    monitoring: false,
    last: state.last,
    preferredTeam: state.preferredTeam,
  };
}

export function stopNetlifyCreditsMonitor() {
  return { ok: true, last: state.last };
}
