import fs from 'fs';
import path from 'path';
import {
  launchChromeStandalone,
  connectChromeForAutomation,
  disconnectBrowser,
  isDebugPortOpen,
} from './chrome-connect.js';
import { humanFillInput, humanClickByText, humanClickSelector, randomDelay } from './human-browser.js';

export const NETLIFY_CREDITS_PORT = 9335;
/** @deprecated 하드코딩 팀 사용 금지 — 로그인 계정에서 자동 감지 */
export const DEFAULT_TEAM_SLUG = '';
/** Netlify Tokens 아이디(@naver.com) 공통 비밀번호 */
export const DEFAULT_NETLIFY_LOGIN_PASSWORD = 'ycJCBqzymh@';

const LOGIN_EMAIL_URL = 'https://app.netlify.com/login/email';
const TEAMS_HOME_URL = 'https://app.netlify.com/teams';
const BILLING_GENERAL = (team) => (
  team
    ? `https://app.netlify.com/teams/${team}/billing/general`
    : 'https://app.netlify.com/teams'
);

function normalizeNetlifyEmail(id = '') {
  const s = String(id || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  return `${s}@naver.com`;
}

/** 설정 netlifyTokens 아이디 기준 로그인 이메일 (미사용 토큰 우선) */
export function resolveNetlifyLoginEmail(tokens = [], preferredId = '') {
  const list = (Array.isArray(tokens) ? tokens : []).map((t) =>
    typeof t === 'string' ? { token: t, id: '', used: false } : (t || {}),
  );
  const withId = list.filter((t) => String(t.id || '').trim());
  const prefer = normalizeNetlifyEmail(preferredId);

  // preferred가 토큰 목록의 아이디와 일치하면 그것 사용
  if (prefer && withId.some((t) => normalizeNetlifyEmail(t.id) === prefer)) {
    return prefer;
  }

  // 설정 토큰: 미사용 → 아무거나 (아이디 있는 항목만)
  const unused = withId.find((t) => !t.used);
  const picked = unused || withId[0];
  if (picked) return normalizeNetlifyEmail(picked.id);

  // 토큰에 아이디가 없을 때만 preferred / bare 폴백
  if (prefer) return prefer;
  return '';
}

/** 현재 로그인된 Netlify 계정 이메일 추정 */
async function detectLoggedInEmail(page) {
  return page.evaluate(() => {
    const body = (document.body?.innerText || '');
    const m = body.match(/[A-Z0-9._%+-]+@naver\.com/i)
      || body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (m) return m[0];
    for (const el of document.querySelectorAll('[data-testid*="user"], [class*="avatar"], [class*="profile"], button, a')) {
      const t = (el.textContent || el.getAttribute('aria-label') || '').trim();
      const em = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (em) return em[0];
    }
    return '';
  }).catch(() => '');
}

function isLoggedInUrl(url = '') {
  const u = String(url || '');
  if (!/app\.netlify\.com/i.test(u)) return false;
  return !/\/login(?:\/|$|\?)|\/signup(?:\/|$|\?)|\/authorize(?:\/|$|\?)/i.test(u);
}

let state = {
  profileDir: '',
  last: null,
  onUpdate: null,
  onLog: null,
  preferredTeam: '',
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
  return String(teamSlug || state.preferredTeam || '').trim();
}

/** 로그인된 계정에서 팀 슬러그 자동 감지 (이전 계정 하드코딩 사용 안 함) */
export async function discoverActiveTeamSlug(page) {
  if (!page) return '';

  const fromUrl = (url = '') => {
    const m = String(url).match(/\/teams\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  };

  let slug = fromUrl(page.url());
  if (slug && !/^(new|create)$/i.test(slug)) return slug;

  slug = await page.evaluate(() => {
    const pick = (href) => {
      const m = String(href || '').match(/\/teams\/([^/?#]+)/i);
      if (!m) return '';
      const s = decodeURIComponent(m[1]);
      if (/^(new|create)$/i.test(s)) return '';
      return s;
    };
    // 현재 경로
    let s = pick(location.pathname);
    if (s) return s;
    // 사이드바/팀 링크
    for (const a of document.querySelectorAll('a[href*="/teams/"]')) {
      s = pick(a.getAttribute('href'));
      if (s) return s;
    }
    return '';
  }).catch(() => '');
  if (slug) return slug;

  // 팀 목록으로 이동 후 첫 팀 선택
  try {
    await page.goto(TEAMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    slug = fromUrl(page.url());
    if (slug && !/^(new|create)$/i.test(slug)) return slug;

    const href = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href*="/teams/"]')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/\/teams\/([^/?#]+)/i);
        if (!m) continue;
        const s = decodeURIComponent(m[1]);
        if (/^(new|create)$/i.test(s)) continue;
        return h;
      }
      return '';
    });
    if (href) {
      const abs = href.startsWith('http') ? href : `https://app.netlify.com${href.startsWith('/') ? '' : '/'}${href}`;
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(800);
      slug = fromUrl(page.url()) || fromUrl(href);
    }
  } catch (e) {
    log(`팀 자동 감지 실패: ${e.message}`);
  }
  return slug || '';
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
async function getBillingPage(browser, team = '') {
  const pages = await browser.pages();
  const scored = [];
  for (const p of pages) {
    let url = '';
    try { url = p.url(); } catch { continue; }
    if (!url || url.startsWith('chrome://') || url.startsWith('devtools://')) continue;
    let score = 0;
    if (/\/teams\/[^/]+\/billing/i.test(url)) score += 200;
    if (team && url.includes(team)) score += 40;
    if (/app\.netlify\.com/i.test(url)) score += 50;
    if (/\/login|\/signup|\/authorize|about:blank/i.test(url)) score -= 80;
    scored.push({ p, url, score });
  }
  scored.sort((a, b) => b.score - a.score);
  let page = scored[0]?.score >= 50 ? scored[0].p : null;
  if (!page) page = await browser.newPage();

  let teamSlug = String(team || '').trim();
  if (!teamSlug) {
    teamSlug = await discoverActiveTeamSlug(page);
  }
  if (teamSlug) state.preferredTeam = teamSlug;

  const billingUrl = BILLING_GENERAL(teamSlug);
  const cur = page.url();
  if (teamSlug && !cur.includes(`/teams/${teamSlug}/billing`)) {
    await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  } else if (!teamSlug && !/app\.netlify\.com/i.test(cur)) {
    await page.goto(TEAMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  }
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
 * teamSlug 비우면 로그인된 계정 팀을 자동 감지
 */
export async function refreshNetlifyCredits({ teamSlug = '' } = {}) {
  let team = resolveTeam(teamSlug);

  try {
    const scraped = await withConnectedBrowser(async (browser) => {
      const page = await getBillingPage(browser, team);
      // getBillingPage가 팀을 새로 찾았을 수 있음
      team = resolveTeam(team) || (await discoverActiveTeamSlug(page)) || '';
      if (team) state.preferredTeam = team;
      const billingUrl = BILLING_GENERAL(team);
      const cur = page.url();
      log(`크레딧 새로고침: ${billingUrl || cur}`);

      if (team && /\/teams\/[^/]+\/billing/i.test(cur) && cur.includes(team)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      } else if (team) {
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      }
      await sleep(2500);

      let result = await waitForCredits(page, 20000);
      if (!result.ok && team) {
        await page.goto(billingUrl, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() =>
          page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }),
        );
        await sleep(3000);
        result = await waitForCredits(page, 15000);
      }
      if (!result.teamSlug && team) result.teamSlug = team;
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

/** 이메일 로그인 폼 자동 입력 (#email / #password → Log in) */
export async function autoLoginNetlifyEmail(page, email, password, sendLog = log, { forceAccount = true } = {}) {
  const mail = normalizeNetlifyEmail(email);
  const pass = String(password || '').trim();
  if (!mail || !pass) throw new Error('Netlify 로그인 이메일/비밀번호가 없습니다. 설정 → Netlify Tokens 아이디를 확인하세요.');

  // 이미 로그인된 세션이 있어도, 설정 토큰 아이디와 다르면 로그아웃 후 재로그인
  if (isLoggedInUrl(page.url())) {
    const current = (await detectLoggedInEmail(page) || '').trim();
    if (!forceAccount || (current && current.toLowerCase() === mail.toLowerCase())) {
      sendLog(`✓ 이미 해당 계정으로 로그인됨: ${current || mail}`);
      return { ok: true, already: true, email: current || mail };
    }
    sendLog(`세션 계정(${current || '다른 계정'}) ≠ 설정 토큰(${mail}) → 로그아웃 후 재로그인`);
    try {
      const { logoutNetlify } = await import('./netlify-onboarding.js');
      await logoutNetlify(page, sendLog);
    } catch (e) {
      sendLog(`로그아웃 시도 실패: ${e.message} — 로그인 페이지로 이동`);
      await page.goto(LOGIN_EMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    await sleep(1000);
  }

  sendLog(`자동 로그인(설정 토큰 아이디): ${mail}`);
  if (!/\/login\/email/i.test(page.url())) {
    await page.goto(LOGIN_EMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(1200);
  }

  // 간혹 /login 에 머무르면 email 로그인 링크 클릭
  if (!(await page.$('#email'))) {
    const clicked = await humanClickByText(page, [
      'Log in with email',
      'Continue with email',
      'Email',
    ]);
    if (clicked) await sleep(1200);
    if (!(await page.$('#email'))) {
      await page.goto(LOGIN_EMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await sleep(1500);
    }
  }

  await page.waitForSelector('#email', { timeout: 30000 });
  const emailOk = await humanFillInput(page, ['#email', 'input[name="email"]', 'input[type="email"]'], mail);
  if (!emailOk) throw new Error('이메일 입력란을 찾지 못했습니다.');
  await randomDelay(200, 450);

  await page.waitForSelector('#password', { timeout: 15000 });
  const passOk = await humanFillInput(page, ['#password', 'input[name="password"]', 'input[type="password"]'], pass);
  if (!passOk) throw new Error('비밀번호 입력란을 찾지 못했습니다.');
  await randomDelay(250, 500);

  let submitted = await humanClickSelector(page, 'button[type="submit"]');
  if (!submitted) {
    submitted = await humanClickByText(page, ['Log in', 'Login', 'Sign in']);
  }
  if (!submitted) {
    await page.focus('#password').catch(() => {});
    await page.keyboard.press('Enter');
  }
  sendLog('Log in 제출…');

  const start = Date.now();
  while (Date.now() - start < 90000) {
    await sleep(1000);
    const cur = page.url();
    if (isLoggedInUrl(cur)) {
      sendLog(`✓ Netlify 로그인 완료 (${cur.slice(0, 80)})`);
      return { ok: true, url: cur };
    }
    // 에러 메시지
    const err = await page.evaluate(() => {
      const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
      if (/incorrect|invalid|wrong password|couldn.?t log|try again/i.test(t)) return t.slice(0, 160);
      return '';
    }).catch(() => '');
    if (err) throw new Error(`Netlify 로그인 실패: ${err}`);
  }
  throw new Error('Netlify 로그인 후 대시보드 이동 시간 초과');
}

/**
 * Chrome 창 띄운 뒤 Tokens 아이디로 자동 로그인.
 * 창은 닫지 않음. 크레딧은 새로고침/배포 완료 시에만 읽음.
 */
export async function startNetlifyCreditsMonitor({
  dataRoot,
  teamSlug = '',
  email = '',
  password = '',
  onUpdate,
  onLog,
  /** true면 저장된 이전 팀 슬러그를 무시하고 로그인 계정에서 다시 감지 */
  rediscoverTeam = true,
} = {}) {
  state.onUpdate = onUpdate;
  state.onLog = onLog;
  state.profileDir = path.join(dataRoot || process.cwd(), 'chrome-netlify-credits');
  fs.mkdirSync(state.profileDir, { recursive: true });

  // 로그인 시 이전 계정 팀(minji-cho9475 등)으로 강제 이동하지 않음
  if (rediscoverTeam) state.preferredTeam = '';
  let team = rediscoverTeam ? '' : resolveTeam(teamSlug);
  const loginEmail = normalizeNetlifyEmail(email);
  const loginPass = String(password || DEFAULT_NETLIFY_LOGIN_PASSWORD).trim();

  log('═══ Netlify 로그인 ═══');
  if (loginEmail) log(`설정 Tokens 아이디로 로그인: ${loginEmail}`);
  else log('⚠ 설정 → Netlify Tokens에 아이디(@naver.com)가 없습니다. 수동 로그인 대기');
  log('빌링 URL은 로그인 후 현재 계정 팀으로 자동 이동합니다.');

  let windowPlacement = null;
  try {
    const { getChromeWindowPlacement } = await import('./window-placement.js');
    windowPlacement = await getChromeWindowPlacement(1400, 900);
    if (windowPlacement) {
      log(`Chrome 창을 앱과 같은 모니터에 배치 (${windowPlacement.x}, ${windowPlacement.y})`);
    }
  } catch { /* ignore */ }

  const startUrl = loginEmail ? LOGIN_EMAIL_URL : TEAMS_HOME_URL;
  await launchChromeStandalone({
    userDataDir: state.profileDir,
    port: NETLIFY_CREDITS_PORT,
    startUrl,
    sendLog: log,
    windowPlacement,
  });

  try {
    await withConnectedBrowser(async (browser) => {
      const pages = await browser.pages();
      let page = pages.find((p) => {
        try { return /netlify\.com/i.test(p.url()); } catch { return false; }
      }) || pages[0] || await browser.newPage();

      if (loginEmail) {
        await autoLoginNetlifyEmail(page, loginEmail, loginPass, log, { forceAccount: true });
      }

      // 로그인된 계정의 팀 자동 감지 → 그 팀 빌링으로 이동
      team = await discoverActiveTeamSlug(page);
      if (team) {
        state.preferredTeam = team;
        const billingUrl = BILLING_GENERAL(team);
        log(`현재 계정 팀 감지: ${team}`);
        log(`빌링 이동: ${billingUrl}`);
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      } else {
        log('팀 슬러그를 자동 감지하지 못함 — Teams 홈으로 이동');
        await page.goto(TEAMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        team = await discoverActiveTeamSlug(page);
        if (team) {
          state.preferredTeam = team;
          await page.goto(BILLING_GENERAL(team), { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
          log(`팀 재감지: ${team}`);
        }
      }
    });
  } catch (e) {
    log(`[WARN] 자동 로그인: ${e.message}`);
  }

  emit({
    ok: false,
    status: 'ready',
    message: loginEmail ? '자동 로그인 시도 완료' : '로그인 후 ↻ 로 크레딧 확인',
    teamSlug: team || state.preferredTeam || '',
    credits: state.last?.credits ?? null,
    creditsText: state.last?.creditsText || '',
  });

  await sleep(1500);
  const refreshed = await refreshNetlifyCredits({ teamSlug: team || state.preferredTeam || '' });
  return {
    ok: true,
    port: NETLIFY_CREDITS_PORT,
    teamSlug: refreshed?.teamSlug || team || state.preferredTeam || '',
    email: loginEmail,
    ...refreshed,
  };
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
