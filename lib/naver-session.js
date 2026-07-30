/**
 * 앱 전역 네이버 서치어드바이저 세션
 * - 우측 상단 「네이버 로그인」으로 시작
 * - Chrome 창 유지, 이후 색인/수집은 동일 창에서 진행
 */
import fs from 'fs';
import path from 'path';
import { launchBrowser } from './puppeteer-launch.js';
import { loginNaverForSearchAdvisor, isNaverLoggedIn } from './naver-login-wait.js';

const BOARD = 'https://searchadvisor.naver.com/console/board';

let browser = null;
let page = null;
let accountId = '';
let status = 'idle'; // idle | starting | ready | error
let lastError = '';
let siteCount = null;
let statusListeners = new Set();
let defaultUserDataDir = '';

export function setNaverSessionProfileDir(dir) {
  defaultUserDataDir = String(dir || '').trim();
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

/** 서치어드바이저 보드에 등록된 사이트 URL 개수 */
export async function countAdvisorRegisteredSites(targetPage = null) {
  const p = targetPage || page;
  if (!p) return null;
  try {
    await p.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));
    // 목록이 늦게 그려질 수 있어 짧게 폴링
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
        // 폴백: 테이블 행 수 (체크박스 있는 사이트 행)
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

async function ensurePage() {
  if (page && !page.isClosed?.()) {
    try {
      await page.evaluate(() => true);
      return page;
    } catch { /* recreate */ }
  }
  page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  page.on('dialog', async (dialog) => {
    const msg = dialog.message() || '';
    try {
      if (/삭제\s*하시겠습니까|영구\s*삭제/i.test(msg)) await dialog.dismiss();
      else await dialog.accept();
    } catch { /* ignore */ }
  });
  return page;
}

/**
 * @param {{
 *   naverAccount: {id:string,pw:string},
 *   openaiApiKey?: string,
 *   headless?: boolean,
 *   userDataDir?: string,
 *   outputFolder?: string,
 *   forceRelogin?: boolean,
 *   onLog?: (msg:string)=>void,
 * }} opts
 */
export async function ensureNaverSession(opts = {}) {
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
      if (await isNaverLoggedIn(p)) {
        log(`네이버 세션 재사용: ${wantId}`);
        if (siteCount == null) {
          const n = await countAdvisorRegisteredSites(p);
          if (n != null) log(`등록 사이트 ${n}개`);
        }
        return { browser, page: p, accountId: wantId };
      }
    } catch { /* re-login */ }
  }

  status = 'starting';
  lastError = '';
  emit();

  if (!(await isBrowserAlive())) {
    browser = null;
    page = null;
    const profileDir = userDataDir
      || defaultUserDataDir
      || path.join(process.cwd(), 'output', 'chrome-naver-session');
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
      if (status === 'ready') {
        status = 'idle';
        accountId = '';
        emit();
      }
    });
  }

  const p = await ensurePage();
  const folder = outputFolder || path.join(process.cwd(), 'output', 'naver-session');
  try { fs.mkdirSync(folder, { recursive: true }); } catch { /* ignore */ }

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

/** 작업용 page 핸들 (세션 없으면 null) */
export async function getNaverSessionPage() {
  if (!(await isBrowserAlive()) || status !== 'ready') return null;
  return ensurePage();
}

export async function getNaverSessionBrowser() {
  if (!(await isBrowserAlive())) return null;
  return browser;
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
