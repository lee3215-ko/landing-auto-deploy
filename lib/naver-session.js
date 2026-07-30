/**
 * 앱 전역 네이버 서치어드바이저 세션
 * - 우측 상단 「네이버 로그인」으로 시작
 * - Chrome 창·탭 1개 유지, 이후 색인/수집은 동일 창에서 진행
 */
import fs from 'fs';
import path from 'path';
import { launchBrowser } from './puppeteer-launch.js';
import { loginNaverForSearchAdvisor, isNaverLoggedIn } from './naver-login-wait.js';

const BOARD = 'https://searchadvisor.naver.com/console/board';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browser = null;
let page = null;
let accountId = '';
let status = 'idle'; // idle | starting | ready | error
let lastError = '';
let siteCount = null;
let statusListeners = new Set();
let defaultUserDataDir = '';
let sessionPromise = null;

export function setNaverSessionProfileDir(dir) {
  defaultUserDataDir = String(dir || '').trim();
}

export function getNaverSessionProfileDir() {
  return defaultUserDataDir
    || path.join(process.cwd(), 'output', 'chrome-naver-session');
}

function emit() {
  const snap = getNaverSessionStatus();
  for (const fn of statusListeners) {
    try { fn(snap); } catch { /* ignore */ }
  }
}

export function onNaverSessionStatus(fn) {
  if (typeof fn === 'function') statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function getNaverSessionStatus() {
  return {
    status,
    accountId: accountId || '',
    loggedIn: status === 'ready' && !!accountId,
    error: lastError || '',
    siteCount: siteCount == null ? null : siteCount,
  };
}

/** 외부에서 page 핸들을 세션에 동기화 (bulk-collect 복구 등) */
export function adoptSessionPage(p) {
  if (p && !p.isClosed?.()) page = p;
}

function attachPageHandlers(p) {
  if (!p || p.__ladHandlersAttached) return p;
  p.__ladHandlersAttached = true;
  p.on('dialog', async (dialog) => {
    const msg = dialog.message() || '';
    try {
      if (/삭제\s*하시겠습니까|영구\s*삭제/i.test(msg)) await dialog.dismiss();
      else await dialog.accept();
    } catch { /* ignore */ }
  });
  return p;
}

async function pickExistingPage() {
  if (!browser) return null;
  let pages = [];
  try {
    pages = await browser.pages();
  } catch {
    return null;
  }
  if (!pages.length) return null;

  const score = (p) => {
    try {
      const u = p.url() || '';
      if (/searchadvisor\.naver\.com/i.test(u)) return 100;
      if (/nid\.naver\.com|naver\.com/i.test(u)) return 50;
      if (u === 'about:blank' || u === '' || u.startsWith('chrome://')) return 1;
      return 10;
    } catch {
      return 0;
    }
  };

  const sorted = [...pages].sort((a, b) => score(b) - score(a));
  const best = sorted[0];
  return best ? attachPageHandlers(best) : null;
}

/** 서치어드바이저 보드에 등록된 사이트 URL 개수 */
export async function countAdvisorRegisteredSites(targetPage = null) {
  const p = targetPage || page;
  if (!p) return null;
  try {
    await p.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));
    let count = 0;
    for (let i = 0; i < 8; i++) {
      count = await p.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a.api_link, a.d-block.secondary--text'));
        const urls = new Set();
        for (const a of links) {
          const t = (a.textContent || '').trim();
          if (/^https?:\/\//i.test(t)) urls.add(t.replace(/\/$/, '').toLowerCase());
        }
        if (urls.size) return urls.size;
        const rows = document.querySelectorAll('table tbody tr');
        let n = 0;
        for (const tr of rows) {
          const text = (tr.innerText || '').trim();
          if (/https?:\/\//i.test(text)) n += 1;
        }
        return n;
      }).catch(() => 0);
      if (count > 0) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    siteCount = count;
    emit();
    return count;
  } catch {
    return siteCount;
  }
}

async function isBrowserAlive() {
  try {
    if (!browser || !browser.isConnected?.()) return false;
    const pages = await browser.pages();
    return Array.isArray(pages);
  } catch {
    return false;
  }
}

/**
 * 기존 탭 재사용 우선 — about:blank 새 탭 남발 방지
 */
export async function ensurePage() {
  if (page && !page.isClosed?.()) {
    try {
      await page.evaluate(() => true);
      return attachPageHandlers(page);
    } catch { /* fall through */ }
  }

  const existing = await pickExistingPage();
  if (existing) {
    page = existing;
    try { await page.setUserAgent(UA); } catch { /* ignore */ }
    return page;
  }

  page = await browser.newPage();
  await page.setUserAgent(UA);
  attachPageHandlers(page);
  return page;
}

async function sessionLooksLoggedIn(p) {
  if (!p) return false;
  try {
    if (await isNaverLoggedIn(p)) return true;
  } catch { /* ignore */ }
  // about:blank 등 → 보드로 이동 후 쿠키/세션 확인
  try {
    await p.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((r) => setTimeout(r, 1200));
    if (await isNaverLoggedIn(p)) return true;
    const url = p.url() || '';
    if (/searchadvisor\.naver\.com/i.test(url) && !/nid\.naver\.com|login/i.test(url)) return true;
  } catch { /* ignore */ }
  return false;
}

async function ensureNaverSessionInner(opts = {}) {
  const {
    naverAccount,
    openaiApiKey = '',
    headless = false,
    userDataDir = '',
    outputFolder = '',
    forceRelogin = false,
    onLog = null,
  } = opts;

  const log = (msg) => {
    if (typeof onLog === 'function') onLog(msg);
  };

  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error('네이버 계정이 필요합니다.');
  }

  const wantId = String(naverAccount.id).trim();

  if (!forceRelogin && (await isBrowserAlive()) && accountId === wantId && status === 'ready') {
    const p = await ensurePage();
    try {
      if (await sessionLooksLoggedIn(p)) {
        log(`네이버 세션 재사용: ${wantId}`);
        status = 'ready';
        emit();
        try {
          const n = await countAdvisorRegisteredSites(p);
          if (n != null) log(`등록 사이트 ${n}개`);
        } catch { /* ignore */ }
        return { browser, page: p, accountId: wantId };
      }
    } catch { /* re-login */ }
  }

  // 브라우저만 살아 있고 프로필에 로그인 쿠키가 남은 경우 — 재로그인 UI 없이 보드만 열기
  if (!forceRelogin && (await isBrowserAlive())) {
    const p = await ensurePage();
    if (await sessionLooksLoggedIn(p)) {
      accountId = wantId;
      status = 'ready';
      lastError = '';
      log(`네이버 세션 복구(기존 창): ${wantId}`);
      emit();
      try {
        const n = await countAdvisorRegisteredSites(p);
        if (n != null) log(`등록 사이트 ${n}개`);
      } catch { /* ignore */ }
      return { browser, page: p, accountId: wantId };
    }
  }

  status = 'starting';
  lastError = '';
  emit();

  if (!(await isBrowserAlive())) {
    browser = null;
    page = null;
    const profileDir = userDataDir || getNaverSessionProfileDir();
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }

    log(`네이버 로그인 창 실행… (${wantId})`);
    browser = await launchBrowser({
      headless: !!headless,
      userDataDir: profileDir,
      args: ['--window-size=1400,900', '--window-position=80,60'],
      defaultViewport: { width: 1400, height: 900 },
    });
    browser.on('disconnected', () => {
      browser = null;
      page = null;
      siteCount = null;
      if (status === 'ready' || status === 'starting') {
        status = 'idle';
        accountId = '';
        emit();
      }
    });
  }

  const p = await ensurePage();
  const folder = outputFolder || path.join(process.cwd(), 'output', 'naver-session');
  try { fs.mkdirSync(folder, { recursive: true }); } catch { /* ignore */ }

  // 프로필에 이미 로그인된 경우 login 스킵
  if (!forceRelogin && (await sessionLooksLoggedIn(p))) {
    accountId = wantId;
    status = 'ready';
    lastError = '';
    log(`✅ 네이버 세션 준비됨(기존 로그인): ${wantId}`);
    emit();
    try {
      const n = await countAdvisorRegisteredSites(p);
      if (n != null) log(`등록 사이트 ${n}개`);
    } catch { /* ignore */ }
    return { browser, page: p, accountId: wantId };
  }

  try {
    await loginNaverForSearchAdvisor(p, naverAccount, {
      openaiApiKey,
      outputFolder: folder,
      log: (msg) => log(msg),
    });
    accountId = wantId;
    status = 'ready';
    lastError = '';
    log(`✅ 네이버 세션 준비됨: ${wantId} (창 유지)`);
    emit();
    try {
      const n = await countAdvisorRegisteredSites(p);
      if (n != null) log(`등록 사이트 ${n}개`);
    } catch { /* ignore */ }
    return { browser, page: p, accountId: wantId };
  } catch (e) {
    status = 'error';
    lastError = e.message || String(e);
    accountId = '';
    siteCount = null;
    emit();
    throw e;
  }
}

/**
 * 단일 비행: 동시 호출이 새 탭/재로그인을 연쇄하지 않음
 */
export async function ensureNaverSession(opts = {}) {
  if (sessionPromise) {
    return sessionPromise;
  }
  sessionPromise = ensureNaverSessionInner(opts).finally(() => {
    sessionPromise = null;
  });
  return sessionPromise;
}

/** 작업용 page 핸들 (세션 없으면 null) */
export async function getNaverSessionPage() {
  if (!(await isBrowserAlive()) || status !== 'ready') return null;
  return ensurePage();
}

export async function getNaverSessionBrowser() {
  if (!(await isBrowserAlive())) return null;
  return browser;
}

/** register/bulk에서 쓸 공용 page 확보 (없으면 null) */
export async function getOrCreateSharedPage(externalBrowser = null) {
  if (externalBrowser && externalBrowser === browser) {
    return ensurePage();
  }
  if (externalBrowser) {
    const pages = await externalBrowser.pages().catch(() => []);
    const prefer = pages.find((p) => /searchadvisor\.naver\.com/i.test(p.url() || ''))
      || pages.find((p) => {
        const u = p.url() || '';
        return u && !u.startsWith('chrome://');
      })
      || pages[0];
    if (prefer) return prefer;
    return externalBrowser.newPage();
  }
  if (await isBrowserAlive()) return ensurePage();
  return null;
}

export async function closeNaverSession() {
  try {
    if (browser) await browser.close();
  } catch { /* ignore */ }
  browser = null;
  page = null;
  accountId = '';
  status = 'idle';
  lastError = '';
  siteCount = null;
  emit();
}
