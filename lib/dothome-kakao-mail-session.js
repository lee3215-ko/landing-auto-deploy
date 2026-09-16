/**
 * 닷홈 전용 카카오 메일 세션
 * - 「카카오 메일 로그인」으로 한 번만 로그인
 * - Chrome 창을 닫지 않고 유지 (디버그 포트 재연결)
 * - 인증코드 조회는 같은 창에서만 진행
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import { launchBrowser } from './puppeteer-launch.js';
import { isDebugPortOpen } from './chrome-connect.js';
import { attachSafeDialogHandler } from './dialog-guard.js';
import {
  clickMailRowByHostId,
  extractAuthCodeFromOpenMail,
} from './dothome-mail-auth.js';

export const KAKAO_MAIL_HOME = 'https://mail.kakao.com/';
export const KAKAO_MAIL_INBOX = 'https://mail.kakao.com/top/INBOX';

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
let savedCreds = {
  mailId: '',
  mailPw: '',
  scratchDir: '',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rememberCreds(partial = {}) {
  savedCreds = {
    mailId: String(partial.mailId || savedCreds.mailId || '').trim(),
    mailPw: String(partial.mailPw || savedCreds.mailPw || '').trim(),
    scratchDir: String(partial.scratchDir || savedCreds.scratchDir || '').trim(),
  };
}

function attachMailDialogGuard(p, log) {
  if (!p) return;
  attachSafeDialogHandler(p, {
    log: (m) => log?.(String(m || '').replace(/^\[.*?\]\s*/, '')),
  });
}

export function setDothomeMailProfileDir(dir) {
  profileDir = String(dir || '').trim();
}

function getProfileDir() {
  // 카카오 전환 후 프로필 분리 (네이버 메일 쿠키와 충돌 방지)
  const base = profileDir || path.join(process.cwd(), 'output', 'chrome-dothome-mail');
  return path.join(base, 'kakao');
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
    provider: 'kakao',
  };
}

async function isMailLoggedIn(p) {
  if (!p || p.isClosed?.()) return false;
  try {
    const url = p.url() || '';
    if (/accounts\.kakao\.com|logins\.daum\.net|auth\.kakao/i.test(url) && /login|signin/i.test(url)) {
      return false;
    }
    // 로그인 폼이 보이면 미로그인
    const onLoginForm = await p.evaluate(() => !!(
      document.querySelector('input[name="loginId"], input#loginId--1, input[name="password"], input#password--2')
      && document.querySelector('button[type="submit"].submit, button.btn_g.highlight.submit, .cont_login')
    )).catch(() => false);
    if (onLoginForm) return false;

    if (/mail\.kakao\.com/i.test(url)) {
      return await p.evaluate(() => !!(
        document.querySelector('#mailList, .list_mail, .mail_item, .profile_mail, .txt_mail, #mainContent')
      )).catch(() => true);
    }
    return false;
  } catch {
    return false;
  }
}

async function isBrowserAlive() {
  try {
    if (!browser) return false;
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) return false;
    if (browser.connected === false) return false;
    await browser.pages();
    return true;
  } catch {
    return false;
  }
}

function wireBrowserDisconnect(b) {
  if (!b || b.__ladMailDisconnectWired) return b;
  b.__ladMailDisconnectWired = true;
  b.on('disconnected', () => {
    if (browser === b) {
      browser = null;
      page = null;
      if (status === 'ready' || status === 'starting') {
        status = 'idle';
        emit();
      }
    }
  });
  return b;
}

function killOrphanChromeForProfile(dir, log) {
  try {
    const escaped = String(dir).replace(/'/g, "''");
    const ps = `
$p = '${escaped}'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -match 'chrome|chromium' -and
    ($_.CommandLine -like "*$p*" -or $_.CommandLine -like "*remote-debugging-port=${DOTHOME_MAIL_DEBUG_PORT}*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g, ' ')}"`, {
      windowsHide: true,
      timeout: 15000,
    });
    log?.('고아 Chrome 정리 시도');
  } catch { /* ignore */ }
}

async function connectMailDebugBrowser(log) {
  if (!(await isDebugPortOpen(DOTHOME_MAIL_DEBUG_PORT))) return null;
  try {
    log?.(`기존 카카오 메일 Chrome 재연결 (포트 ${DOTHOME_MAIL_DEBUG_PORT})…`);
    const b = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${DOTHOME_MAIL_DEBUG_PORT}`,
      defaultViewport: null,
      protocolTimeout: 120000,
    });
    return wireBrowserDisconnect(b);
  } catch (e) {
    log?.(`재연결 실패: ${e.message || e}`);
    return null;
  }
}

async function pickMailPage(b) {
  const pages = await b.pages().catch(() => []);
  const mail = pages.find((p) => {
    try {
      const u = p.url() || '';
      return /mail\.kakao\.com/i.test(u) || /accounts\.kakao\.com/i.test(u);
    } catch { return false; }
  });
  return mail || pages[0] || await b.newPage();
}

async function ensureBrowser({ headless = false, log = null } = {}) {
  if (await isBrowserAlive()) {
    if (!page || page.isClosed?.()) {
      page = await pickMailPage(browser);
    }
    attachMailDialogGuard(page, log);
    return;
  }

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
    log?.('카카오 메일 Chrome 실행…');
    b = await tryLaunch();
  } catch (e) {
    const msg = e?.message || String(e || '');
    if (!/already running|userDataDir|SingletonLock|profile.*in use/i.test(msg)) throw e;
    log?.(`메일 프로필 사용 중 — 재연결 시도… (${msg})`);
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
  attachMailDialogGuard(page, log);
}

async function fillKakaoLogin(page, mailId, mailPw, log) {
  await page.goto(KAKAO_MAIL_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(1500);

  // 이미 로그인된 경우
  if (await isMailLoggedIn(page)) return true;

  // 로그인 폼 대기 (리다이렉트 포함)
  for (let i = 0; i < 20; i++) {
    const ready = await page.evaluate(() => !!(
      document.querySelector('input[name="loginId"], input#loginId--1, input[placeholder*="카카오메일"], input[placeholder*="아이디"]')
    )).catch(() => false);
    if (ready) break;
    if (await isMailLoggedIn(page)) return true;
    await sleep(500);
  }

  const filled = await page.evaluate((id, pw) => {
    const idEl = document.querySelector('input[name="loginId"], input#loginId--1, input[type="text"].tf_g');
    const pwEl = document.querySelector('input[name="password"], input#password--2, input[type="password"].tf_g');
    if (!idEl || !pwEl) return false;
    const setVal = (el, val) => {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(idEl, id);
    setVal(pwEl, pw);
    return true;
  }, mailId, mailPw);

  if (!filled) {
    // 키보드 타이핑 폴백
    const idSel = await page.$('input[name="loginId"], input#loginId--1, input[type="text"].tf_g');
    const pwSel = await page.$('input[name="password"], input#password--2, input[type="password"].tf_g');
    if (!idSel || !pwSel) throw new Error('카카오 로그인 입력칸을 찾지 못했습니다.');
    await idSel.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type(String(mailId), { delay: 25 });
    await pwSel.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type(String(mailPw), { delay: 25 });
  }

  log?.(`카카오 메일 로그인 클릭: ${mailId}`);
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"].submit, button.btn_g.highlight.submit, button[type="submit"].btn_g');
    if (btn) {
      btn.click();
      return true;
    }
    const form = document.querySelector('form');
    if (form) {
      form.requestSubmit?.() || form.submit?.();
      return true;
    }
    return false;
  });
  if (!clicked) await page.keyboard.press('Enter');

  // 로그인 완료 대기 (2FA/추가인증이면 사용자가 창에서 처리)
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < 180000) {
    if (await isMailLoggedIn(page)) {
      try {
        await page.goto(KAKAO_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch { /* ignore */ }
      await sleep(1500);
      return true;
    }
    const url = page.url() || '';
    if (!announced && /two.?step|2단계|인증|captcha|qr/i.test(url + (await page.evaluate(() => document.body?.innerText || '').catch(() => '')))) {
      log?.('추가 인증/보안 화면 감지 — Chrome 창에서 완료해 주세요…');
      announced = true;
    }
    await sleep(1500);
  }
  throw new Error('카카오 메일 로그인 시간 초과 — 창에서 추가 인증을 완료한 뒤 「다시 로그인」을 눌러 주세요.');
}

export async function reviveDothomeMailSession({ sendLog = null, headless = false } = {}) {
  const log = (m) => {
    const line = `[DOTHOME-MAIL] ${m}`;
    sendLog?.(line);
    console.log(line);
  };
  try {
    await ensureBrowser({ headless, log });
    if (await isMailLoggedIn(page)) {
      status = 'ready';
      if (!accountId) accountId = readSessionMeta().accountId || 'kakao';
      lastError = '';
      saveSessionMeta({ accountId, status: 'ready' });
      emit();
      return true;
    }
    try {
      await page.goto(KAKAO_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2000);
      if (await isMailLoggedIn(page)) {
        status = 'ready';
        if (!accountId) accountId = readSessionMeta().accountId || 'kakao';
        lastError = '';
        saveSessionMeta({ accountId, status: 'ready' });
        emit();
        return true;
      }
    } catch { /* ignore */ }
  } catch (e) {
    log(`세션 복구 실패: ${e.message || e}`);
  }
  return false;
}

export async function ensureDothomeMailSessionReady({
  mailId = '',
  mailPw = '',
  // 구버전 호환
  naverId = '',
  naverPw = '',
  headless = false,
  scratchDir = '',
  sendLog = null,
  allowLogin = false,
} = {}) {
  const id = String(mailId || naverId || savedCreds.mailId || '').trim();
  const pw = String(mailPw || naverPw || savedCreds.mailPw || '').trim();
  rememberCreds({ mailId: id, mailPw: pw, scratchDir });

  const st = getDothomeMailSessionStatus();
  if (st.loggedIn) return st;

  const revived = await reviveDothomeMailSession({ sendLog, headless });
  if (revived) return getDothomeMailSessionStatus();

  if (!(allowLogin && id && pw)) {
    throw new Error(
      '카카오 메일 로그인이 필요합니다. 닷홈 탭에서 「카카오 메일 로그인」을 먼저 눌러 주세요.',
    );
  }

  return startDothomeMailLogin({
    mailId: id,
    mailPw: pw,
    headless,
    scratchDir: scratchDir || savedCreds.scratchDir,
    sendLog,
    forceRelogin: true,
  });
}

export async function startDothomeMailLogin({
  mailId = '',
  mailPw = '',
  naverId = '',
  naverPw = '',
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
      const id = String(mailId || naverId || '').trim();
      const pw = String(mailPw || naverPw || '').trim();
      if (!id || !pw) {
        throw new Error('카카오 메일 아이디/비밀번호가 없습니다. 닷홈 탭을 확인하세요.');
      }

      status = 'starting';
      lastError = '';
      accountId = id.replace(/@kakao\.com$/i, '');
      rememberCreds({ mailId: id, mailPw: pw, scratchDir });
      saveSessionMeta({ accountId, status: 'starting' });
      emit();

      await ensureBrowser({ headless, log });
      attachMailDialogGuard(page, log);
      log(`카카오 메일 로그인 시작: ${accountId}${forceRelogin ? ' (강제 재로그인)' : ''}`);

      if (!forceRelogin && await isMailLoggedIn(page)) {
        log('이미 메일 로그인 상태 — 창 유지');
        status = 'ready';
        lastError = '';
        saveSessionMeta({ accountId, status: 'ready' });
        emit();
        return getDothomeMailSessionStatus();
      }

      if (!forceRelogin) {
        try {
          await page.goto(KAKAO_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 45000 });
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

      await fillKakaoLogin(page, id, pw, log);

      if (!(await isMailLoggedIn(page))) {
        throw new Error('메일함 진입 실패 — 추가 인증이 있으면 창에서 완료한 뒤 다시 시도하세요.');
      }

      log('✅ 카카오 메일 로그인 완료 — 이 창을 닫지 마세요. 이후 인증코드는 이 창에서만 조회합니다.');
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

/** 구버전 이름 호환 */
export async function startDothomeNaverMailLogin(opts = {}) {
  return startDothomeMailLogin({
    ...opts,
    mailId: opts.mailId || opts.naverId,
    mailPw: opts.mailPw || opts.naverPw,
  });
}

export async function reloginDothomeMailAfterVpn(opts = {}) {
  // VPN 단축키 제거됨 — 강제 재로그인만 수행
  return startDothomeMailLogin({
    ...opts,
    mailId: opts.mailId || opts.naverId || savedCreds.mailId,
    mailPw: opts.mailPw || opts.naverPw || savedCreds.mailPw,
    forceRelogin: true,
  });
}

async function ensureReadyPage(sendLog) {
  const st = getDothomeMailSessionStatus();
  if (!st.loggedIn) {
    const ok = await reviveDothomeMailSession({ sendLog });
    if (!ok) {
      throw new Error(
        '카카오 메일 로그인이 필요합니다. 닷홈 탭에서 「카카오 메일 로그인」을 먼저 눌러 주세요.',
      );
    }
  }
  if (!page || page.isClosed?.()) {
    throw new Error('메일 페이지를 찾을 수 없습니다. 「카카오 메일 로그인」을 다시 눌러 주세요.');
  }
  return page;
}

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

  log(`카카오 메일함에서 인증코드 조회 (제목 FTP: ${hostId}) — 기존 로그인 창 사용`);

  try {
    await mailPage.bringToFront().catch(() => {});
  } catch { /* ignore */ }

  try {
    const url = mailPage.url() || '';
    if (!/mail\.kakao\.com/i.test(url) || /accounts\.kakao\.com/i.test(url)) {
      await mailPage.goto(KAKAO_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2500);
    } else if (!/INBOX|top\//i.test(url)) {
      await mailPage.goto(KAKAO_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(2000);
    } else {
      // 새로고침 버튼 우선
      const refreshed = await mailPage.evaluate(() => {
        const btn = document.querySelector('button.btn_refresh, .btn_refresh');
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (!refreshed) await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2000);
    }
  } catch (e) {
    throw new Error(`메일함 이동 실패: ${e.message}`);
  }

  if (!(await isMailLoggedIn(mailPage))) {
    log('메일 로그인 확인 실패 — 재로그인 시도…');
    if (!(savedCreds.mailId && savedCreds.mailPw)) {
      status = 'idle';
      lastError = '메일 세션이 만료되었습니다. 「카카오 메일 로그인」을 다시 해주세요.';
      emit();
      throw new Error(lastError);
    }
    await startDothomeMailLogin({
      mailId: savedCreds.mailId,
      mailPw: savedCreds.mailPw,
      scratchDir: savedCreds.scratchDir,
      sendLog,
      forceRelogin: true,
    });
  }

  const start = Date.now();
  let opened = false;
  let lastRefresh = 0;
  const activePage = page || mailPage;
  if (!(await isMailLoggedIn(activePage))) {
    throw new Error('메일 재로그인 후에도 메일함에 진입하지 못했습니다.');
  }

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
      const clicked = await activePage.evaluate(() => {
        const btn = document.querySelector('button.btn_refresh, .btn_refresh');
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (!clicked) await activePage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2500);
      lastRefresh = elapsed;
    } else {
      await sleep(1800);
    }
  }

  if (!opened) {
    throw new Error(`메일 목록에서 제목에 "${hostId}"가 있는 메일을 찾지 못했습니다.`);
  }

  await sleep(2500);
  const code = await extractAuthCodeFromOpenMail(activePage);
  if (!code) throw new Error('메일 본문에서 인증코드를 추출하지 못했습니다.');
  log(`인증코드 추출: ${code}`);

  // 목록으로 복귀
  try {
    await activePage.goto(KAKAO_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* ignore */ }

  return code;
}

export async function closeDothomeNaverMailSession() {
  try {
    if (browser?.connected || browser?.isConnected?.()) {
      try { await browser.close(); } catch {
        try { await browser.disconnect(); } catch { /* ignore */ }
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

export const closeDothomeMailSession = closeDothomeNaverMailSession;
