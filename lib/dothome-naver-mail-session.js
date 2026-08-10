/**
 * 닷홈 전용 네이버 메일 세션
 * - 「네이버 메일 로그인」으로 한 번만 로그인
 * - Chrome 창을 닫지 않고 유지 (디버그 포트 재연결)
 * - 인증코드 조회는 같은 창에서만 진행 (재로그인/새창 금지)
 * - 앱 재시작·일시 끊김 시에도 프로필 쿠키로 복구 시도
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import { launchBrowser } from './puppeteer-launch.js';
import { isDebugPortOpen } from './chrome-connect.js';
import { loginNaverWithCaptcha } from './naver-login.js';
import {
  clickMailRowByHostId,
  extractAuthCodeFromOpenMail,
  NAVER_MAIL_HOME,
  NAVER_MAIL_INBOX,
} from './dothome-mail-auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 닷홈 메일 Chrome 전용 디버그 포트 (서치어드바이저 9334 / Netlify 9335와 분리) */
export const DOTHOME_MAIL_DEBUG_PORT = 9336;

let browser = null;
let page = null;
let accountId = '';
let status = 'idle'; // idle | starting | ready | error
let lastError = '';
let profileDir = '';
let statusListeners = new Set();
let loginPromise = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function setDothomeMailProfileDir(dir) {
  profileDir = String(dir || '').trim();
}

function getProfileDir() {
  return profileDir || path.join(process.cwd(), 'output', 'chrome-dothome-mail');
}

function sessionMetaPath() {
  return path.join(getProfileDir(), 'dothome-mail-session.json');
}

function saveSessionMeta(patch = {}) {
  try {
    const dir = getProfileDir();
    fs.mkdirSync(dir, { recursive: true });
    const prev = readSessionMeta();
    const next = {
      ...prev,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(sessionMetaPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function readSessionMeta() {
  try {
    const p = sessionMetaPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

function emit() {
  const snap = getDothomeMailSessionStatus();
  for (const fn of statusListeners) {
    try { fn(snap); } catch { /* ignore */ }
  }
}

export function onDothomeMailSessionStatus(fn) {
  if (typeof fn === 'function') statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function getDothomeMailSessionStatus() {
  const pageAlive = !!(page && !page.isClosed?.());
  const browserAlive = !!(browser?.connected || browser?.isConnected?.());
  return {
    status,
    accountId: accountId || '',
    loggedIn: status === 'ready' && !!accountId && pageAlive && browserAlive,
    error: lastError || '',
    pageAlive,
    browserAlive,
    port: DOTHOME_MAIL_DEBUG_PORT,
  };
}

/** 로그인 폼(#id/#pw)과 메일 UI의 다른 요소를 구분 */
async function isMailLoggedIn(p) {
  if (!p || p.isClosed?.()) return false;
  try {
    const url = p.url() || '';
    if (/nid\.naver\.com/i.test(url)) return false;
    if (!/mail\.naver\.com/i.test(url)) return false;

    return await p.evaluate(() => {
      // 실제 로그인 입력칸만 본다 (메일 UI의 다른 #id 요소와 혼동 금지)
      const idInp = document.querySelector('input#id, input[name="id"]');
      const pwInp = document.querySelector('input#pw, input[name="pw"], input[type="password"]#pw');
      const idVisible = !!(idInp && idInp.offsetParent !== null && (idInp.type || 'text') !== 'hidden');
      const pwVisible = !!(pwInp && pwInp.offsetParent !== null);
      if (idVisible && pwVisible) return false;

      // 메일함 UI 흔적
      const mailUi = !!(
        document.querySelector('[class*="mail_list"], [class*="MailList"], .mailbox_list, #mail_header, .lnb_mail')
        || document.querySelector('a[href*="folders"]')
        || /받은메일함|메일\s*쓰기|Mail/i.test(document.body?.innerText || '')
      );
      return mailUi || (!idVisible && !pwVisible && location.hostname.includes('mail.naver.com'));
    }).catch(() => /mail\.naver\.com/i.test(url) && !/nid\.naver\.com/i.test(url));
  } catch {
    return false;
  }
}

async function isBrowserAlive() {
  try {
    if (!browser) return false;
    const connected = browser.connected ?? browser.isConnected?.();
    if (!connected) return false;
    await browser.pages();
    return true;
  } catch {
    return false;
  }
}

function wireBrowserDisconnect(b) {
  if (!b || b.__dhMailDisconnectWired) return b;
  b.__dhMailDisconnectWired = true;
  b.on('disconnected', () => {
    if (browser === b) {
      browser = null;
      page = null;
      // 계정 메타는 유지 — 다음 호출에서 디버그 포트/쿠키로 복구
      if (status === 'ready' || status === 'starting') {
        status = 'idle';
        lastError = '메일 Chrome 연결이 끊겼습니다. 창이 열려 있으면 자동 재연결합니다.';
        emit();
      }
    }
  });
  return b;
}

async function connectMailDebugBrowser(log) {
  if (!(await isDebugPortOpen(DOTHOME_MAIL_DEBUG_PORT))) return null;
  try {
    log?.(`기존 메일 Chrome에 재연결 (포트 ${DOTHOME_MAIL_DEBUG_PORT})…`);
    const b = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${DOTHOME_MAIL_DEBUG_PORT}`,
      defaultViewport: null,
    });
    return wireBrowserDisconnect(b);
  } catch (e) {
    log?.(`재연결 실패: ${e.message || e}`);
    return null;
  }
}

function killOrphanChromeForProfile(dir, log) {
  const needle = path.resolve(dir).replace(/\\/g, '/').toLowerCase();
  const needleWin = path.resolve(dir).toLowerCase();
  try {
    if (process.platform !== 'win32') return false;
    const scriptPath = path.join(dir, '_kill_orphan_mail.ps1');
    fs.mkdirSync(dir, { recursive: true });
    const ps = `
$needles = @(${JSON.stringify(needle)}, ${JSON.stringify(needleWin)}, 'chrome-dothome-mail')
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
    log?.('메일 프로필을 쓰던 Chrome을 정리했습니다.');
    return true;
  } catch (e) {
    log?.(`Chrome 정리 실패: ${e.message || e}`);
    return false;
  }
}

function isProfileLockedError(err) {
  const msg = err?.message || String(err || '');
  return /already running|userDataDir|SingletonLock|profile.*in use|The browser is already running/i.test(msg);
}

async function pickMailPage(b) {
  const pages = await b.pages().catch(() => []);
  const mail = pages.find((p) => {
    try { return /mail\.naver\.com/i.test(p.url() || ''); } catch { return false; }
  });
  return mail || pages[0] || await b.newPage();
}

async function ensureBrowser({ headless = false, log = null } = {}) {
  if (await isBrowserAlive()) {
    if (!page || page.isClosed?.()) {
      page = await pickMailPage(browser);
    }
    return;
  }

  // 1) 이미 떠 있는 메일 Chrome 재연결
  let b = await connectMailDebugBrowser(log);
  if (b) {
    browser = b;
    page = await pickMailPage(browser);
    await page.setUserAgent(UA).catch(() => {});
    return;
  }

  const dir = getProfileDir();
  fs.mkdirSync(dir, { recursive: true });

  let placement = { x: 100, y: 60, width: 1200, height: 900 };
  try {
    const { getChromeWindowPlacement } = await import('./window-placement.js');
    placement = await getChromeWindowPlacement(1200, 900);
  } catch { /* ignore */ }

  const launchArgs = [
    `--remote-debugging-port=${DOTHOME_MAIL_DEBUG_PORT}`,
    `--window-size=${placement.width},${placement.height}`,
    `--window-position=${placement.x},${placement.y}`,
    '--disable-blink-features=AutomationControlled',
  ];

  const tryLaunch = async () => launchBrowser({
    headless: !!headless,
    userDataDir: dir,
    args: launchArgs,
    defaultViewport: { width: placement.width, height: placement.height },
  });

  try {
    log?.('네이버 메일 Chrome 실행…');
    b = await tryLaunch();
  } catch (e) {
    if (!isProfileLockedError(e)) throw e;
    log?.(`메일 프로필 사용 중 — 재연결 시도… (${e.message})`);
    await sleep(800);
    b = await connectMailDebugBrowser(log);
    if (!b) {
      killOrphanChromeForProfile(dir, log);
      await sleep(1500);
      b = await connectMailDebugBrowser(log);
      if (!b) b = await tryLaunch();
    }
  }

  browser = wireBrowserDisconnect(b);
  page = await pickMailPage(browser);
  await page.setUserAgent(UA).catch(() => {});
}

/**
 * 쿠키/열린 창으로 세션 복구 (재로그인 UI 없이)
 * @returns {Promise<boolean>}
 */
export async function reviveDothomeMailSession({ sendLog = null, headless = false } = {}) {
  const log = (m) => {
    const line = `[DOTHOME-MAIL] ${m}`;
    sendLog?.(line);
    console.log(line);
  };

  const meta = readSessionMeta();
  if (!accountId && meta.accountId) accountId = String(meta.accountId).trim();

  try {
    await ensureBrowser({ headless, log });
  } catch (e) {
    log(`브라우저 복구 실패: ${e.message}`);
    return false;
  }

  if (await isMailLoggedIn(page)) {
    status = 'ready';
    lastError = '';
    if (!accountId) accountId = meta.accountId || 'session';
    saveSessionMeta({ accountId, status: 'ready' });
    emit();
    log(`메일 세션 유지됨: ${accountId}`);
    return true;
  }

  // 받은함 진입으로 쿠키 세션 확인
  try {
    await page.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2000);
    if (await isMailLoggedIn(page)) {
      status = 'ready';
      lastError = '';
      if (!accountId) accountId = meta.accountId || 'session';
      saveSessionMeta({ accountId, status: 'ready' });
      emit();
      log(`저장된 쿠키로 메일 세션 복구: ${accountId}`);
      return true;
    }
  } catch (e) {
    log(`메일함 복구 이동 실패: ${e.message}`);
  }

  return false;
}

/**
 * 가입/인증 전에 호출 — 가능하면 재로그인 없이 복구
 */
export async function ensureDothomeMailSessionReady({
  naverId = '',
  naverPw = '',
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  scratchDir = '',
  sendLog = null,
  allowLogin = false,
} = {}) {
  const st = getDothomeMailSessionStatus();
  if (st.loggedIn) return st;

  const revived = await reviveDothomeMailSession({ sendLog, headless });
  if (revived) return getDothomeMailSessionStatus();

  if (!allowLogin) {
    throw new Error(
      '네이버 메일 로그인이 필요합니다. 닷홈 탭에서 「네이버 메일 로그인」을 먼저 눌러 주세요.\n'
      + '(한 번 로그인하면 메일 창을 닫지 않는 한 계속 유지됩니다)',
    );
  }

  return startDothomeNaverMailLogin({
    naverId,
    naverPw,
    openaiApiKey,
    yesCaptchaClientKey,
    headless,
    scratchDir,
    sendLog,
    forceRelogin: false,
  });
}

/**
 * 네이버 메일 로그인 (창 유지)
 */
export async function startDothomeNaverMailLogin({
  naverId,
  naverPw,
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  scratchDir = '',
  sendLog = null,
  forceRelogin = false,
} = {}) {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const log = (m) => {
      const line = `[DOTHOME-MAIL] ${m}`;
      sendLog?.(line);
      console.log(line);
    };

    try {
      if (!naverId || !naverPw) {
        throw new Error('네이버 아이디/비밀번호가 없습니다. 닷홈 탭 메일 계정을 확인하세요.');
      }
      if (!openaiApiKey && !yesCaptchaClientKey) {
        throw new Error('네이버 로그인 캡챠용 OpenAI 또는 YesCaptcha 키가 필요합니다.');
      }

      status = 'starting';
      lastError = '';
      accountId = String(naverId).trim();
      saveSessionMeta({ accountId, status: 'starting' });
      emit();

      await ensureBrowser({ headless, log });
      log(`네이버 메일 로그인 시작: ${accountId}`);

      if (!forceRelogin && await isMailLoggedIn(page)) {
        log('이미 메일 로그인 상태 — 창 유지 (재로그인 안 함)');
        status = 'ready';
        lastError = '';
        saveSessionMeta({ accountId, status: 'ready' });
        emit();
        return getDothomeMailSessionStatus();
      }

      if (!forceRelogin) {
        try {
          await page.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(2000);
          if (await isMailLoggedIn(page)) {
            log('저장된 세션으로 메일함 진입 — 재로그인 생략');
            status = 'ready';
            lastError = '';
            saveSessionMeta({ accountId, status: 'ready' });
            emit();
            return getDothomeMailSessionStatus();
          }
        } catch { /* login required */ }
      }

      const dir = scratchDir || path.join(getProfileDir(), 'captcha');
      fs.mkdirSync(dir, { recursive: true });
      await loginNaverWithCaptcha(page, {
        naverId: accountId,
        naverPw,
        openaiApiKey,
        yesCaptchaClientKey,
        scratchDir: dir,
        sendLog: (line) => log(String(line).replace(/^\[NAVER_LOGIN\]\s*/, '')),
      });

      log('네이버 메일함 이동...');
      try {
        await page.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch {
        await page.goto(NAVER_MAIL_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      await sleep(2500);

      if (!(await isMailLoggedIn(page))) {
        throw new Error('메일함 진입 실패 — 캡챠·2단계 인증을 창에서 완료한 뒤 다시 시도하세요.');
      }

      log('✅ 네이버 메일 로그인 완료 — 이 창을 닫지 마세요. 이후 인증코드는 이 창에서만 조회합니다.');
      status = 'ready';
      lastError = '';
      saveSessionMeta({ accountId, status: 'ready' });
      emit();
      return getDothomeMailSessionStatus();
    } catch (e) {
      status = 'error';
      lastError = e.message || String(e);
      saveSessionMeta({ accountId, status: 'error', error: lastError });
      emit();
      throw e;
    } finally {
      loginPromise = null;
    }
  })();

  return loginPromise;
}

async function ensureReadyPage(sendLog = null) {
  // 끊겼으면 재연결·쿠키 복구 먼저
  const st = getDothomeMailSessionStatus();
  if (!st.loggedIn) {
    const ok = await reviveDothomeMailSession({ sendLog });
    if (!ok) {
      throw new Error(
        '네이버 메일 로그인이 필요합니다. 닷홈 탭에서 「네이버 메일 로그인」을 먼저 눌러 주세요.',
      );
    }
  }
  if (!page || page.isClosed?.()) {
    throw new Error('메일 페이지를 찾을 수 없습니다. 「네이버 메일 로그인」을 다시 눌러 주세요.');
  }
  return page;
}

/**
 * 이미 로그인된 메일 창에서 인증코드만 조회 (새 창·재로그인 없음)
 */
export async function fetchAuthCodeFromMailSession({
  hostId,
  timeoutMs = 120000,
  sendLog = null,
} = {}) {
  const log = (m) => {
    const line = `[DOTHOME-MAIL] ${m}`;
    sendLog?.(line);
    console.log(line);
  };

  const mailPage = await ensureReadyPage(sendLog);
  if (!hostId) throw new Error('FTP 아이디가 없어 메일을 찾을 수 없습니다.');

  log(`메일함에서 인증코드 조회 (제목 FTP: ${hostId}) — 기존 로그인 창 사용`);

  try {
    await mailPage.bringToFront().catch(() => {});
  } catch { /* ignore */ }

  // 목록으로 복귀 (이전 메일 읽기 화면일 수 있음)
  try {
    const url = mailPage.url() || '';
    if (!/mail\.naver\.com/i.test(url) || /nid\.naver\.com/i.test(url)) {
      await mailPage.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2500);
    } else if (!/folders\/0|\/v2\/folders/i.test(url)) {
      await mailPage.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(2000);
    } else {
      await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2000);
    }
  } catch (e) {
    throw new Error(`메일함 이동 실패: ${e.message}`);
  }

  // 한 번 실패해도 즉시 세션을 버리지 않고 복구 재시도
  if (!(await isMailLoggedIn(mailPage))) {
    log('메일 로그인 확인 실패 — 세션 복구 재시도…');
    const revived = await reviveDothomeMailSession({ sendLog });
    if (!revived || !(await isMailLoggedIn(page))) {
      status = 'idle';
      lastError = '메일 세션이 만료되었습니다. 「네이버 메일 로그인」을 다시 해주세요.';
      emit();
      throw new Error(lastError);
    }
  }

  const start = Date.now();
  let opened = false;
  let lastRefresh = 0;
  const activePage = page || mailPage;

  while (Date.now() - start < timeoutMs) {
    const hit = await clickMailRowByHostId(activePage, hostId);
    if (hit) {
      log(`메일 클릭: ${hit}`);
      opened = true;
      break;
    }
    const elapsed = Date.now() - start;
    if (elapsed - lastRefresh > 10000) {
      log('메일 목록 새로고침...');
      await activePage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2500);
      lastRefresh = elapsed;
    } else {
      await sleep(1800);
    }
  }

  if (!opened) {
    throw new Error(`메일 목록에서 제목에 "${hostId}"가 있는 메일을 찾지 못했습니다.`);
  }

  await sleep(2200);
  const code = await extractAuthCodeFromOpenMail(activePage);
  if (!code) throw new Error('메일 본문에서 인증코드를 추출하지 못했습니다.');
  log(`인증코드 추출: ${code}`);

  // 다음 조회를 위해 목록으로 돌아가 두기 (창은 유지)
  try {
    await activePage.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(1000);
  } catch { /* ignore */ }

  return code;
}

export async function closeDothomeNaverMailSession() {
  try {
    if (browser?.connected || browser?.isConnected?.()) {
      // launch로 연 경우 close, connect로 연 경우도 Chrome 종료
      try {
        await browser.close();
      } catch {
        try { browser.disconnect?.(); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  browser = null;
  page = null;
  accountId = '';
  status = 'idle';
  lastError = '';
  saveSessionMeta({ accountId: '', status: 'idle' });
  emit();
  return getDothomeMailSessionStatus();
}
