/**
 * 닷홈 전용 네이버 메일 세션
 * - 「네이버 메일 로그인」으로 한 번만 로그인
 * - Chrome 창을 닫지 않고 유지
 * - 인증코드 조회는 같은 창에서만 진행 (재로그인/새창 금지)
 */
import fs from 'fs';
import path from 'path';
import { launchBrowser } from './puppeteer-launch.js';
import { loginNaverWithCaptcha } from './naver-login.js';
import {
  clickMailRowByHostId,
  extractAuthCodeFromOpenMail,
  NAVER_MAIL_HOME,
  NAVER_MAIL_INBOX,
} from './dothome-mail-auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  const browserAlive = !!(browser?.connected);
  return {
    status,
    accountId: accountId || '',
    loggedIn: status === 'ready' && !!accountId && pageAlive && browserAlive,
    error: lastError || '',
    pageAlive,
    browserAlive,
  };
}

async function isMailLoggedIn(p) {
  if (!p || p.isClosed?.()) return false;
  try {
    const url = p.url() || '';
    if (/nid\.naver\.com/i.test(url)) return false;
    if (/mail\.naver\.com/i.test(url)) {
      const hasLoginForm = await p.evaluate(() => !!(
        document.querySelector('#id') || document.querySelector('#pw')
      )).catch(() => false);
      return !hasLoginForm;
    }
    // 쿠키/세션으로 메일함 진입 가능한지
    return false;
  } catch {
    return false;
  }
}

async function ensureBrowser({ headless = false } = {}) {
  if (browser?.connected) {
    if (!page || page.isClosed?.()) {
      const pages = await browser.pages().catch(() => []);
      page = pages.find((p) => /mail\.naver\.com/i.test(p.url() || '')) || pages[0] || await browser.newPage();
    }
    return;
  }

  const dir = getProfileDir();
  fs.mkdirSync(dir, { recursive: true });
  browser = await launchBrowser({
    headless: !!headless,
    userDataDir: dir,
    args: [
      '--window-size=1200,900',
      '--window-position=100,60',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1200, height: 900 },
  });
  browser.on('disconnected', () => {
    browser = null;
    page = null;
    if (status === 'ready') {
      status = 'idle';
      accountId = '';
      lastError = '메일 브라우저가 닫혔습니다. 다시 「네이버 메일 로그인」을 눌러 주세요.';
      emit();
    }
  });

  const pages = await browser.pages().catch(() => []);
  page = pages[0] || await browser.newPage();
  await page.setUserAgent(UA).catch(() => {});
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
        throw new Error('네이버 아이디/비밀번호가 없습니다. 설정 탭 네이버 계정을 확인하세요.');
      }
      if (!openaiApiKey && !yesCaptchaClientKey) {
        throw new Error('네이버 로그인 캡챠용 OpenAI 또는 YesCaptcha 키가 필요합니다.');
      }

      status = 'starting';
      lastError = '';
      accountId = String(naverId).trim();
      emit();

      await ensureBrowser({ headless });
      log(`네이버 메일 로그인 시작: ${accountId}`);

      if (!forceRelogin && await isMailLoggedIn(page)) {
        log('이미 메일 로그인 상태 — 창 유지');
        status = 'ready';
        lastError = '';
        emit();
        return getDothomeMailSessionStatus();
      }

      // 세션 쿠키로 바로 메일함 진입 시도
      if (!forceRelogin) {
        try {
          await page.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(2000);
          if (await isMailLoggedIn(page)) {
            log('저장된 세션으로 메일함 진입');
            status = 'ready';
            lastError = '';
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
      emit();
      return getDothomeMailSessionStatus();
    } catch (e) {
      status = 'error';
      lastError = e.message || String(e);
      emit();
      throw e;
    } finally {
      loginPromise = null;
    }
  })();

  return loginPromise;
}

async function ensureReadyPage() {
  const st = getDothomeMailSessionStatus();
  if (!st.loggedIn || !page || page.isClosed?.()) {
    throw new Error(
      '네이버 메일 로그인이 필요합니다. 닷홈 탭에서 「네이버 메일 로그인」을 먼저 눌러 주세요.',
    );
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

  const mailPage = await ensureReadyPage();
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
      // 같은 받은편지함이면 새로고침으로 최신 메일 반영
      await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2000);
    }
  } catch (e) {
    throw new Error(`메일함 이동 실패: ${e.message}`);
  }

  if (!(await isMailLoggedIn(mailPage))) {
    status = 'idle';
    accountId = '';
    lastError = '메일 세션이 만료되었습니다. 「네이버 메일 로그인」을 다시 해주세요.';
    emit();
    throw new Error(lastError);
  }

  const start = Date.now();
  let opened = false;
  let lastRefresh = 0;

  while (Date.now() - start < timeoutMs) {
    const hit = await clickMailRowByHostId(mailPage, hostId);
    if (hit) {
      log(`메일 클릭: ${hit}`);
      opened = true;
      break;
    }
    const elapsed = Date.now() - start;
    if (elapsed - lastRefresh > 10000) {
      log('메일 목록 새로고침...');
      await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
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
  const code = await extractAuthCodeFromOpenMail(mailPage);
  if (!code) throw new Error('메일 본문에서 인증코드를 추출하지 못했습니다.');
  log(`인증코드 추출: ${code}`);

  // 다음 조회를 위해 목록으로 돌아가 두기 (창은 유지)
  try {
    await mailPage.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(1000);
  } catch { /* ignore */ }

  return code;
}

export async function closeDothomeNaverMailSession() {
  try {
    if (browser?.connected) await browser.close();
  } catch { /* ignore */ }
  browser = null;
  page = null;
  accountId = '';
  status = 'idle';
  lastError = '';
  emit();
  return getDothomeMailSessionStatus();
}
