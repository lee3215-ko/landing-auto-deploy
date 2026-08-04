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
/** 계정당 사이트 한도 100 — 95개부터 다음 아이디로 전환 */
export const NAVER_SITE_SOFT_LIMIT = 95;
export const NAVER_SITE_HARD_LIMIT = 100;

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
    // OAuth callback은 일시 화면 — 콘솔보다 우선순위 낮춤
    if (/searchadvisor\.naver\.com\/auth\//i.test(u)) return 35;
    if (/searchadvisor\.naver\.com\/console\//i.test(u)) return 100;
    if (/searchadvisor\.naver\.com/i.test(u)) return 80;
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

/** about:blank · OAuth callback 잔여 탭 정리 */
async function pruneBlankTabs(keepPage = null) {
  const pages = await listPages();
  if (pages.length <= 1) return;
  const keep = keepPage && !keepPage.isClosed?.() ? keepPage : null;
  const hasConsole = pages.some((p) => {
    if (keep && p === keep) return /searchadvisor\.naver\.com\/console\//i.test(pageUrl(keep));
    return /searchadvisor\.naver\.com\/console\//i.test(pageUrl(p));
  }) || /searchadvisor\.naver\.com\/console\//i.test(pageUrl(keep));

  for (const p of pages) {
    if (keep && p === keep) continue;
    const u = pageUrl(p);
    const isBlank = u === 'about:blank' || u === '';
    const isOauthCallback = /searchadvisor\.naver\.com\/auth\/callback/i.test(u);
    if (isBlank) {
      if (!keep && pages.filter((x) => {
        const uu = pageUrl(x);
        return uu && uu !== 'about:blank' && !uu.startsWith('chrome://');
      }).length === 0 && p === pages[0]) {
        continue;
      }
      try { await p.close(); } catch { /* ignore */ }
      continue;
    }
    // 콘솔 탭이 있으면 OAuth callback 팝업/잔여 탭은 닫음
    if (isOauthCallback && hasConsole) {
      try { await p.close(); } catch { /* ignore */ }
    }
  }
}

/** 서치어드바이저 보드에 등록된 사이트 URL 개수 */
export async function countAdvisorRegisteredSites(targetPage = null, { forceReload = false } = {}) {
  const p = targetPage || page;
  if (!p) return null;
  try {
    // OAuth callback에 멈춰 있으면 보드로 이동
    const cur0 = pageUrl(p);
    if (/searchadvisor\.naver\.com\/auth\//i.test(cur0)) {
      await p.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }

    const cur = pageUrl(p);
    const onBoard = /searchadvisor\.naver\.com\/console\/board/i.test(cur);
    if (!onBoard || forceReload) {
      const url = forceReload ? `${BOARD}${BOARD.includes('?') ? '&' : '?'}_=${Date.now()}` : BOARD;
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2500));
    } else {
      try { await p.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1200));
    }

    // 신규 계정 동의 팝업이 있으면 처리
    try {
      const { acceptSearchAdvisorConsentIfPresent } = await import('./naver-login-wait.js');
      await acceptSearchAdvisorConsentIfPresent(p, () => {});
    } catch { /* ignore */ }

    let count = 0;
    let how = '';
    for (let i = 0; i < 10; i++) {
      const got = await p.evaluate(() => {
        const body = document.body?.innerText || '';

        // 1) UI에 표시된 등록 개수 문구 우선
        //    ※ 예전 버그: 페이지의 일반 http 링크(~3개)를 먼저 세서 항상 3으로 고정됨
        const patterns = [
          /등록(?:된)?\s*사이트\s*[:：]?\s*(\d{1,3})/i,
          /사이트\s*수\s*[:：]?\s*(\d{1,3})/i,
          /(\d{1,3})\s*\/\s*100\b/,
          /총\s*(\d{1,3})\s*(?:개|건)/,
          /전체\s*(\d{1,3})\s*(?:개|건)/,
        ];
        for (const re of patterns) {
          const m = body.match(re);
          if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n >= 0 && n <= 100) return { n, how: 'label' };
          }
        }

        const normHostPath = (raw) => {
          try {
            const u = new URL(String(raw || '').trim());
            if (!/^https?:$/i.test(u.protocol)) return '';
            // 네이버 자사/도움말 링크는 사이트 목록이 아님
            if (/(^|\.)naver\.com$/i.test(u.hostname)) return '';
            if (/(^|\.)naver\.me$/i.test(u.hostname)) return '';
            return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
          } catch {
            return '';
          }
        };

        const urls = new Set();
        const add = (raw) => {
          const key = normHostPath(raw);
          if (key) urls.add(key);
        };

        // 2) 사이트 목록 테이블/리스트 행
        const rowSel = [
          'table tbody tr',
          '.v-data-table tbody tr',
          '[class*="site-list"] li',
          '[class*="SiteList"] li',
          '.v-list-item',
        ].join(',');
        for (const tr of document.querySelectorAll(rowSel)) {
          const text = (tr.innerText || '').trim();
          for (const a of tr.querySelectorAll('a[href]')) {
            add(a.getAttribute('href'));
            add(a.textContent);
          }
          const m = text.match(/https?:\/\/[^\s<>"']+/i);
          if (m) add(m[0]);
        }
        if (urls.size) return { n: urls.size, how: 'table' };

        // 3) 본문의 외부 호스팅 URL만 (네비/푸터 naver 링크 제외)
        for (const a of document.querySelectorAll('main a[href], .v-main a[href], [class*="content"] a[href], a[href]')) {
          add(a.getAttribute('href'));
          add(a.textContent);
        }
        return { n: urls.size, how: 'links' };
      }).catch(() => ({ n: 0, how: 'err' }));

      count = Number(got?.n) || 0;
      how = got?.how || '';
      // label/table 이면 바로 채택. links만 잡히면 한두 번 더 대기(렌더 지연)
      if ((how === 'label' || how === 'table') || i >= 4) break;
      await new Promise((r) => setTimeout(r, 700));
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
  // OAuth callback 팝업이 새 탭으로 뜨면 콘솔이 있을 때 정리
  if (!b.__ladOauthWired) {
    b.__ladOauthWired = true;
    b.on('targetcreated', async (target) => {
      try {
        if (target.type() !== 'page') return;
        const np = await target.page();
        if (!np) return;
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 400));
          let u = '';
          try { u = np.url() || ''; } catch { return; }
          if (/searchadvisor\.naver\.com\/console\//i.test(u)) {
            // callback → console 로 전환된 탭이면 유지하고 메인으로 채택
            if (!page || page.isClosed?.()) page = attachPageHandlers(np);
            return;
          }
          if (!/searchadvisor\.naver\.com\/auth\/callback/i.test(u) && u && u !== 'about:blank') {
            return;
          }
        }
        const pages = await b.pages().catch(() => []);
        const hasConsole = pages.some((x) => x !== np && /searchadvisor\.naver\.com\/console\//i.test(x.url?.() || ''));
        if (hasConsole && /searchadvisor\.naver\.com\/auth\/callback/i.test(np.url?.() || '')) {
          try { await np.close(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    });
  }
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

  let placement = { x: 80, y: 60, width: 1400, height: 900 };
  try {
    const { getChromeWindowPlacement } = await import('./window-placement.js');
    placement = await getChromeWindowPlacement(1400, 900);
    log(`로그인 창을 앱과 같은 모니터에 배치 (${placement.x}, ${placement.y})`);
  } catch { /* ignore */ }

  const launchArgs = [
    `--remote-debugging-port=${NAVER_DEBUG_PORT}`,
    `--window-size=${placement.width},${placement.height}`,
    `--window-position=${placement.x},${placement.y}`,
  ];

  const tryLaunch = async () => launchBrowser({
    headless: !!headless,
    userDataDir: profileDir,
    args: launchArgs,
    defaultViewport: { width: placement.width, height: placement.height },
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

function sessionMetaPath(profileDir) {
  return path.join(profileDir, 'lad-session-account.json');
}

function readSavedSessionAccount(profileDir) {
  try {
    const raw = fs.readFileSync(sessionMetaPath(profileDir), 'utf8');
    const j = JSON.parse(raw);
    return String(j?.id || '').trim();
  } catch {
    return '';
  }
}

function writeSavedSessionAccount(profileDir, id) {
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      sessionMetaPath(profileDir),
      JSON.stringify({ id: String(id || '').trim(), at: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch { /* ignore */ }
}

function clearSavedSessionAccount(profileDir) {
  try { fs.unlinkSync(sessionMetaPath(profileDir)); } catch { /* ignore */ }
}

function markReady(wantId, log, msg, profileDir = '') {
  accountId = wantId;
  status = 'ready';
  lastError = '';
  if (profileDir) writeSavedSessionAccount(profileDir, wantId);
  log(msg);
  emit();
}

async function logoutNaverInPage(p, log) {
  if (!p || p.isClosed?.()) return;
  log('네이버 로그아웃 중 (계정 전환/재로그인)…');
  try {
    await p.goto('https://nid.naver.com/nidlogin.logout?returl=https%3A%2F%2Fwww.naver.com', {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* ignore */ }
  try {
    const client = await p.createCDPSession();
    await client.send('Network.clearBrowserCookies');
  } catch { /* ignore */ }
  try {
    await p.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  } catch { /* ignore */ }
}

async function ensureNaverSessionInner(opts = {}) {
  const {
    naverAccount,
    openaiApiKey = '',
    yesCaptchaClientKey = '',
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

  const savedId = accountId || readSavedSessionAccount(profileDir);
  // 설정 계정이 바뀌었거나 강제 재로그인이면 기존 Chrome 쿠키 세션을 쓰지 않음
  const mustSwitchAccount = !!(savedId && savedId !== wantId);
  const mustRelogin = !!forceRelogin || mustSwitchAccount;

  if (mustSwitchAccount) {
    log(`설정 계정 변경 감지: 이전 ${savedId} → 새 ${wantId} (재로그인)`);
  }

  // 메모리 핸들이 죽었으면 디버그 포트로 먼저 복구
  if (!(await isBrowserAlive())) {
    const reconnected = await connectNaverDebugBrowser(log);
    if (reconnected) browser = reconnected;
  }

  if (await isBrowserAlive()) {
    const p = await ensurePage();
    const already = await sessionLooksLoggedIn(p);
    if (already && !mustRelogin && savedId === wantId) {
      markReady(wantId, log, `네이버 세션 재사용: ${wantId}`, profileDir);
      await pruneBlankTabs(p);
      try {
        const n = await countAdvisorRegisteredSites(p);
        if (n != null) log(`등록 사이트 ${n}개`);
      } catch { /* ignore */ }
      return { browser, page: p, accountId: wantId };
    }
    if (already && mustRelogin) {
      await logoutNaverInPage(p, log);
      accountId = '';
      clearSavedSessionAccount(profileDir);
      status = 'starting';
      emit();
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

  // 프로필 쿠키로 예전 계정이 남아 있으면, 설정 계정과 다를 때/강제 재로그인 때 로그아웃
  if (await sessionLooksLoggedIn(p)) {
    if (!mustRelogin && (savedId === wantId || !savedId)) {
      // savedId 없으면 예전 버그로 잘못된 매칭 가능 → 계정 불명일 땐 재로그인
      if (savedId === wantId) {
        markReady(wantId, log, `✅ 네이버 세션 준비됨(기존 로그인): ${wantId}`, profileDir);
        await pruneBlankTabs(p);
        try {
          const n = await countAdvisorRegisteredSites(p);
          if (n != null) log(`등록 사이트 ${n}개`);
        } catch { /* ignore */ }
        return { browser, page: p, accountId: wantId };
      }
    }
    log(`기존 네이버 로그인 세션이 있어 로그아웃 후 ${wantId} 로 다시 로그인합니다.`);
    await logoutNaverInPage(p, log);
    clearSavedSessionAccount(profileDir);
  }

  try {
    await loginNaverForSearchAdvisor(p, naverAccount, {
      openaiApiKey,
      yesCaptchaClientKey,
      outputFolder: folder,
      log: (msg) => log(msg),
    });
    if (!(await sessionLooksLoggedIn(p))) {
      throw new Error('네이버 로그인 후 서치어드바이저에 진입하지 못했습니다.');
    }
    markReady(wantId, log, `✅ 네이버 세션 준비됨: ${wantId} (창 유지)`, profileDir);
    await pruneBlankTabs(p);
    try {
      const n = await countAdvisorRegisteredSites(p);
      if (n != null) log(`등록 사이트 ${n}개`);
    } catch { /* ignore */ }
    return { browser, page: p, accountId: wantId };
  } catch (e) {
    try {
      const p2 = await ensurePage();
      if (await sessionLooksLoggedIn(p2) && readSavedSessionAccount(profileDir) === wantId) {
        markReady(wantId, log, `✅ 네이버 세션 복구(보드 확인): ${wantId}`, profileDir);
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

function listValidNaverAccounts(list) {
  return (Array.isArray(list) ? list : [])
    .map((a) => ({ id: String(a?.id || '').trim(), pw: String(a?.pw || '').trim() }))
    .filter((a) => a.id && a.pw);
}

function nextNaverAccount(accounts, currentId) {
  const list = listValidNaverAccounts(accounts);
  if (list.length < 2) return null;
  const idx = list.findIndex((a) => a.id === currentId);
  if (idx < 0) return list.find((a) => a.id !== currentId) || null;
  for (let i = 1; i < list.length; i++) {
    const cand = list[(idx + i) % list.length];
    if (cand.id !== currentId) return cand;
  }
  return null;
}

export async function ensureNaverSession(opts = {}) {
  if (sessionPromise) {
    return sessionPromise;
  }
  sessionPromise = (async () => {
    const accounts = listValidNaverAccounts(opts.naverAccounts);
    let account = opts.naverAccount;
    if ((!account?.id || !account?.pw) && accounts.length) account = accounts[0];

    let result = await ensureNaverSessionInner({ ...opts, naverAccount: account });
    let n = siteCount;
    try {
      n = await countAdvisorRegisteredSites(result?.page || page, { forceReload: false });
    } catch { /* ignore */ }

    // 95개 이상이면 다음 네이버 아이디로 전환 (한도 100)
    let switches = 0;
    while (
      n != null
      && n >= NAVER_SITE_SOFT_LIMIT
      && accounts.length > 1
      && switches < accounts.length
    ) {
      const next = nextNaverAccount(accounts, account?.id || result?.accountId || '');
      if (!next) break;
      const log = (msg) => { if (typeof opts.onLog === 'function') opts.onLog(msg); };
      log(`등록 사이트 ${n}개 ≥ ${NAVER_SITE_SOFT_LIMIT} — 다음 계정으로 전환: ${next.id}`);
      account = next;
      result = await ensureNaverSessionInner({
        ...opts,
        naverAccount: account,
        forceRelogin: true,
      });
      try {
        n = await countAdvisorRegisteredSites(result?.page || page, { forceReload: true });
      } catch { n = siteCount; }
      switches += 1;
      if (n == null || n < NAVER_SITE_SOFT_LIMIT) break;
    }

    return {
      ...result,
      siteCount: n,
      naverAccount: account || result?.naverAccount || null,
      rotated: switches > 0,
    };
  })().finally(() => {
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
  const profileDir = getNaverSessionProfileDir();
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
  clearSavedSessionAccount(profileDir);
  emit();
}
