/**
 * 앱 전역 네이버 서치어드바이저 세션
 * - 우측 상단 「네이버 로그인」으로 시작
 * - Chrome 창·탭 1개 유지, 이후 색인/수집은 동일 창에서 진행
 * - 프로필 잠금 시 디버그 포트로 재연결 (already running 해결)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import { launchBrowser } from './puppeteer-launch.js';
import { loginNaverForSearchAdvisor, isNaverLoggedIn, isNaverLoginFormVisible } from './naver-login-wait.js';
import { isDebugPortOpen } from './chrome-connect.js';

const BOARD = 'https://searchadvisor.naver.com/console/board';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 네이버 세션 Chrome 전용 디버그 포트 (Netlify 9335와 분리) */
export const NAVER_DEBUG_PORT = 9334;

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

function pageUrl(p) {
  try { return p?.url?.() || ''; } catch { return ''; }
}

function scorePage(p) {
  try {
    const u = pageUrl(p);
    if (/searchadvisor\.naver\.com/i.test(u)) return 100;
    if (/nid\.naver\.com/i.test(u)) return 60;
    if (/naver\.com/i.test(u)) return 50;
    if (!u || u === 'about:blank' || u.startsWith('chrome://')) return 1;
    return 10;
  } catch {
    return 0;
  }
}

async function listPages() {
  if (!browser) return [];
  try {
    return await browser.pages();
  } catch {
    return [];
  }
}

async function pickExistingPage() {
  const pages = await listPages();
  if (!pages.length) return null;
  const sorted = [...pages].sort((a, b) => scorePage(b) - scorePage(a));
  const best = sorted[0];
  return best ? attachPageHandlers(best) : null;
}

/** about:blank 탭 정리 — keep 페이지만 남기고 빈 탭 닫기 */
async function pruneBlankTabs(keepPage = null) {
  const pages = await listPages();
  if (pages.length <= 1) return;
  const keep = keepPage && !keepPage.isClosed?.() ? keepPage : null;
  for (const p of pages) {
    if (keep && p === keep) continue;
    const u = pageUrl(p);
    if (u === 'about:blank' || u === '') {
      if (!keep && pages.filter((x) => {
        const uu = pageUrl(x);
        return uu && uu !== 'about:blank' && !uu.startsWith('chrome://');
      }).length === 0 && p === pages[0]) {
        continue;
      }
      try { await p.close(); } catch { /* ignore */ }
    }
  }
}

/** 서치어드바이저 보드에 등록된 사이트 URL 개수 */
export async function countAdvisorRegisteredSites(targetPage = null) {
  const p = targetPage || page;
  if (!p) return null;
  try {
    const cur = pageUrl(p);
    if (!/searchadvisor\.naver\.com\/console\/board/i.test(cur)) {
      await p.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2500));
    } else {
      await new Promise((r) => setTimeout(r, 800));
    }
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

function wireBrowserDisconnect(b) {
  if (!b || b.__ladDisconnectWired) return b;
  b.__ladDisconnectWired = true;
  b.on('disconnected', () => {
    if (browser === b) {
      browser = null;
      page = null;
      siteCount = null;
      if (status === 'ready' || status === 'starting') {
        status = 'idle';
        accountId = '';
        emit();
      }
    }
  });
  return b;
}

/** 이미 떠 있는 네이버 Chrome(디버그 포트)에 재연결 */
async function connectNaverDebugBrowser(log) {
  if (!(await isDebugPortOpen(NAVER_DEBUG_PORT))) return null;
  try {
    log(`기존 네이버 Chrome에 재연결 (포트 ${NAVER_DEBUG_PORT})…`);
    const b = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${NAVER_DEBUG_PORT}`,
      defaultViewport: null,
    });
    return wireBrowserDisconnect(b);
  } catch (e) {
    log(`재연결 실패: ${e.message || e}`);
    return null;
  }
}

/** 프로필을 잠근 고아 Chrome 프로세스 종료 (Windows) */
function killOrphanChromeForProfile(profileDir, log) {
  const needle = path.resolve(profileDir).replace(/\\/g, '/').toLowerCase();
  const needleWin = path.resolve(profileDir).toLowerCase();
  try {
    if (process.platform !== 'win32') return false;
    const scriptPath = path.join(profileDir, '_kill_orphan.ps1');
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }
    const ps = `
$needles = @(${JSON.stringify(needle)}, ${JSON.stringify(needleWin)}, 'chrome-naver-session')
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return }
  $low = $cl.ToLower()
  foreach ($n in $needles) {
    if ($n -and $low.Contains([string]$n)) {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
      break
    }
  }
}
`;
    fs.writeFileSync(scriptPath, ps, 'utf8');
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      windowsHide: true,
      timeout: 20000,
      stdio: 'ignore',
    });
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
    log('프로필을 쓰던 Chrome 프로세스를 정리했습니다. 다시 실행합니다…');
    return true;
  } catch (e) {
    log(`Chrome 정리 실패: ${e.message || e}`);
    return false;
  }
}

function isProfileLockedError(err) {
  const msg = err?.message || String(err || '');
  return /already running|userDataDir|SingletonLock|profile.*in use|The browser is already running/i.test(msg);
}

/** 연결 또는 실행 — 프로필 잠금 시 재연결/정리 후 재시도 */
async function openNaverBrowser({ headless, profileDir, log }) {
  let b = await connectNaverDebugBrowser(log);
  if (b) return b;

  const launchArgs = [
    `--remote-debugging-port=${NAVER_DEBUG_PORT}`,
    '--window-size=1400,900',
    '--window-position=80,60',
  ];

  const tryLaunch = async () => launchBrowser({
    headless: !!headless,
    userDataDir: profileDir,
    args: launchArgs,
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    log('네이버 로그인 창 실행…');
    b = await tryLaunch();
    return wireBrowserDisconnect(b);
  } catch (e) {
    if (!isProfileLockedError(e)) throw e;
    log(`프로필 사용 중 — 재연결 시도… (${e.message})`);
  }

  await new Promise((r) => setTimeout(r, 800));
  b = await connectNaverDebugBrowser(log);
  if (b) return b;

  killOrphanChromeForProfile(profileDir, log);
  await new Promise((r) => setTimeout(r, 1500));
  b = await connectNaverDebugBrowser(log);
  if (b) return b;

  log('네이버 Chrome 재실행…');
  b = await tryLaunch();
  return wireBrowserDisconnect(b);
}

/**
 * 기존 탭 재사용 우선 — about:blank 새 탭 남발 방지
 */
export async function ensurePage() {
  if (!browser) throw new Error('브라우저가 없습니다.');

  const best = await pickExistingPage();
  if (best && scorePage(best) >= 50) {
    page = best;
    try { await page.setUserAgent(UA); } catch { /* ignore */ }
    await pruneBlankTabs(page);
    return page;
  }

  if (page && !page.isClosed?.() && scorePage(page) >= 50) {
    try {
      await page.evaluate(() => true);
      return attachPageHandlers(page);
    } catch { /* fall through */ }
  }

  if (best) {
    page = best;
    try { await page.setUserAgent(UA); } catch { /* ignore */ }
    await pruneBlankTabs(page);
    return page;
  }

  const pages = await listPages();
  if (pages.length) {
    page = attachPageHandlers(pages[0]);
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
    const cur = pageUrl(p);
    // OAuth/로그인 화면이면 절대 로그인됨으로 보지 않음
    if (/nid\.naver\.com/i.test(cur) || /oauth2\.0\/authorize/i.test(cur)) return false;
    // 이미 서치어드바이저 콘솔에 있으면 OK
    if (/searchadvisor\.naver\.com/i.test(cur) && !/\/auth\//i.test(cur)) {
      return true;
    }
    if (cur && !/about:blank|chrome:\/\//i.test(cur) && (await isNaverLoggedIn(p))) {
      return true;
    }
    // about:blank 등에서는 보드로 이동하지 않음
    // (보드 이동 → oauth 「searchadvisor 로그인 중」화면이 떠서 로그인 불가처럼 보임)
    if (!cur || cur === 'about:blank' || cur.startsWith('chrome://') || cur.startsWith('chrome-error://')) {
      return false;
    }
  } catch { /* ignore */ }

  // 쿠키로만 가볍게 확인 (네비게이션 없음)
  try {
    const cookies = await p.cookies('https://www.naver.com', 'https://nid.naver.com').catch(() => []);
    const hasSes = cookies.some((c) => /^(NID_AUT|NID_SES)$/i.test(c.name) && c.value);
    if (!hasSes) return false;
    // 쿠키 있을 때만 보드 확인
    await p.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((r) => setTimeout(r, 1200));
    const url = pageUrl(p);
    if (/nid\.naver\.com|oauth2\.0\/authorize/i.test(url) || (await isNaverLoginFormVisible(p))) return false;
    if (/searchadvisor\.naver\.com/i.test(url) && !/\/auth\//i.test(url)) return true;
  } catch { /* ignore */ }
  return false;
}

function markReady(wantId, log, msg) {
  accountId = wantId;
  status = 'ready';
  lastError = '';
  log(msg);
  emit();
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
  const profileDir = userDataDir || getNaverSessionProfileDir();
  if (userDataDir) setNaverSessionProfileDir(userDataDir);

  // 메모리 핸들이 죽었으면 디버그 포트로 먼저 복구
  if (!(await isBrowserAlive())) {
    const reconnected = await connectNaverDebugBrowser(log);
    if (reconnected) browser = reconnected;
  }

  if (await isBrowserAlive()) {
    const p = await ensurePage();
    const already = await sessionLooksLoggedIn(p);
    if (already) {
      markReady(wantId, log, forceRelogin
        ? `네이버 이미 로그인됨 — 재로그인 생략, 세션 유지: ${wantId}`
        : `네이버 세션 재사용: ${wantId}`);
      await pruneBlankTabs(p);
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
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }

    log(`네이버 로그인 창 준비… (${wantId})`);
    browser = await openNaverBrowser({ headless, profileDir, log });
  }

  const p = await ensurePage();
  const folder = outputFolder || path.join(process.cwd(), 'output', 'naver-session');
  try { fs.mkdirSync(folder, { recursive: true }); } catch { /* ignore */ }

  if (await sessionLooksLoggedIn(p)) {
    markReady(wantId, log, `✅ 네이버 세션 준비됨(기존 로그인): ${wantId}`);
    await pruneBlankTabs(p);
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
    if (!(await sessionLooksLoggedIn(p))) {
      throw new Error('네이버 로그인 후 서치어드바이저에 진입하지 못했습니다.');
    }
    markReady(wantId, log, `✅ 네이버 세션 준비됨: ${wantId} (창 유지)`);
    await pruneBlankTabs(p);
    try {
      const n = await countAdvisorRegisteredSites(p);
      if (n != null) log(`등록 사이트 ${n}개`);
    } catch { /* ignore */ }
    return { browser, page: p, accountId: wantId };
  } catch (e) {
    try {
      const p2 = await ensurePage();
      if (await sessionLooksLoggedIn(p2)) {
        markReady(wantId, log, `✅ 네이버 세션 복구(보드 확인): ${wantId}`);
        await pruneBlankTabs(p2);
        try {
          const n = await countAdvisorRegisteredSites(p2);
          if (n != null) log(`등록 사이트 ${n}개`);
        } catch { /* ignore */ }
        return { browser, page: p2, accountId: wantId };
      }
    } catch { /* ignore */ }

    status = 'error';
    lastError = e.message || String(e);
    accountId = '';
    siteCount = null;
    emit();
    throw e;
  }
}

export async function ensureNaverSession(opts = {}) {
  if (sessionPromise) {
    return sessionPromise;
  }
  sessionPromise = ensureNaverSessionInner(opts).finally(() => {
    sessionPromise = null;
  });
  return sessionPromise;
}

export async function getNaverSessionPage() {
  if (!(await isBrowserAlive())) {
    const reconnected = await connectNaverDebugBrowser(() => {});
    if (reconnected) browser = reconnected;
  }
  if (!(await isBrowserAlive())) return null;
  try {
    const p = await ensurePage();
    if (status === 'ready') return p;
    if (await sessionLooksLoggedIn(p)) {
      status = 'ready';
      if (!accountId) accountId = 'session';
      lastError = '';
      emit();
      await pruneBlankTabs(p);
      return p;
    }
  } catch { /* ignore */ }
  return null;
}

export async function getNaverSessionBrowser() {
  if (!(await isBrowserAlive())) {
    const reconnected = await connectNaverDebugBrowser(() => {});
    if (reconnected) browser = reconnected;
  }
  if (!(await isBrowserAlive())) return null;
  return browser;
}

export async function getOrCreateSharedPage(externalBrowser = null) {
  if (externalBrowser && externalBrowser === browser) {
    return ensurePage();
  }
  if (externalBrowser) {
    const pages = await externalBrowser.pages().catch(() => []);
    const prefer = pages.find((p) => /searchadvisor\.naver\.com/i.test(pageUrl(p)))
      || pages.find((p) => {
        const u = pageUrl(p);
        return u && u !== 'about:blank' && !u.startsWith('chrome://');
      })
      || pages[0];
    if (prefer) return prefer;
    return pages[0] || null;
  }
  if (await isBrowserAlive()) return ensurePage();
  return null;
}

export async function closeNaverSession() {
  try {
    if (browser) {
      if (browser.isConnected?.()) {
        try {
          await browser.close();
        } catch {
          try { await browser.disconnect(); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
  browser = null;
  page = null;
  accountId = '';
  status = 'idle';
  lastError = '';
  siteCount = null;
  emit();
}
