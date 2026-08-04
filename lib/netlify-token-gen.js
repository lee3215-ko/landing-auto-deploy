import path from 'path';
import { launchBrowser } from './puppeteer-launch.js';
import {
  launchChromeStandalone,
  connectChromeForAutomation,
  disconnectBrowser,
  isDebugPortOpen,
  DEFAULT_DEBUG_PORT,
} from './chrome-connect.js';
import { verifyNetlifyViaNaverMail } from './naver-mail-netlify.js';
import {
  detectNetlifyScreen,
  clickVerifyEmailButton,
  completeNetlifyOnboarding,
  logoutNetlify,
  randomTokenDescription,
} from './netlify-onboarding.js';
import {
  loadProgress,
  saveProgress,
  clearProgress,
  resolveResumeStep,
  describeResume,
  isStepAtOrBefore,
  isStepBefore,
  stepLabel,
  findBestNetlifyPage,
  stepFromUrl,
  laterStep,
} from './netlify-flow-resume.js';
import { shouldStopTokenGen, TokenGenStopped } from './token-gen-cancel.js';

const SIGNUP_URL = 'https://app.netlify.com/signup';
const LOGIN_URL = 'https://app.netlify.com/login';
const TOKEN_SETTINGS_URL = 'https://app.netlify.com/user/applications#oauth';
const TOKEN_NEW_URL = 'https://app.netlify.com/user/applications/personal';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(sendLog, msg) {
  const line = `[TOKEN_GEN] ${msg}`;
  if (sendLog) sendLog(line);
  console.log(line);
}

function resolveNaverEmail(account) {
  const raw = (account.email || account.naverId || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  return `${raw}@naver.com`;
}

function resolveNaverId(account) {
  const id = (account.naverId || '').trim();
  if (id && !id.includes('@')) return id;
  const email = resolveNaverEmail(account);
  if (email.includes('@')) return email.split('@')[0];
  return id.replace(/@naver\.com$/i, '');
}

async function withNetlifyPage(chromePort, sendLog, fn, mode = 'signup', quiet = true) {
  const browser = await connectChromeForAutomation({
    port: chromePort,
    sendLog: (m) => log(sendLog, m),
    quiet,
  });
  try {
    const { page } = await findBestNetlifyPage(browser, mode, (m) => log(sendLog, m));
    return await fn(page);
  } finally {
    await disconnectBrowser(browser);
  }
}

async function withBestNetlifyPage(chromePort, sendLog, mode = 'signup', quiet = true) {
  const browser = await connectChromeForAutomation({
    port: chromePort,
    sendLog: (m) => log(sendLog, m),
    quiet,
  });
  const { page, snapshot } = await findBestNetlifyPage(browser, mode, (m) => log(sendLog, m));
  return { browser, page, snapshot };
}

async function openNetlifyPage(chromePort, url, sendLog, mode = 'signup') {
  const { browser, page } = await withBestNetlifyPage(chromePort, sendLog, mode);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1000);
  } finally {
    await disconnectBrowser(browser);
  }
}

async function detectCurrentSnapshot(chromePort, sendLog, mode = 'signup', retries = 4) {
  let best = { url: '', screen: 'unknown', step: 'unknown' };
  for (let i = 0; i < retries; i += 1) {
    try {
      const browser = await connectChromeForAutomation({
        port: chromePort,
        sendLog: (m) => log(sendLog, m),
        quiet: i > 0,
      });
      try {
        const { snapshot } = await findBestNetlifyPage(browser, mode, (m) => log(sendLog, m));
        const step = snapshot.step === 'unknown' ? stepFromUrl(snapshot.url) : snapshot.step;
        const snap = { ...snapshot, step };
        best = { ...snap, step: laterStep(best.step, snap.step) };
        if (snap.step === 'post_verify' || snap.step === 'create_token') return snap;
        if (snap.url.includes('signup-questions')) return { ...snap, step: 'post_verify' };
      } finally {
        await disconnectBrowser(browser);
      }
    } catch {
      /* retry */
    }
    if (i < retries - 1) await sleep(2000);
  }
  return best;
}

async function clickByText(page, patterns, extraSelector = '') {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const res = await page.evaluate((pats, extra) => {
    const base = 'button, a, [role="button"], [role="option"], input[type="submit"]';
    const nodes = document.querySelectorAll(extra ? `${base}, ${extra}` : base);
    for (const el of nodes) {
      const t = ((el.textContent || el.value || el.getAttribute('aria-label') || '') + '').trim();
      for (const p of pats) {
        if (t === p || t.includes(p)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
    }
    return { ok: false };
  }, list, extraSelector);
  if (res.ok) {
    await page.mouse.click(res.x, res.y);
    return true;
  }
  return false;
}

async function isCheckEmailScreen(page) {
  return (await detectNetlifyScreen(page)) === 'check_email';
}

async function waitForCheckEmailScreen(chromePort, sendLog, shouldStop = null, timeoutMs = 600000) {
  log(sendLog, '═══ 1단계: Netlify 가입 (직접 입력) ═══');
  log(sendLog, 'Chrome에서 Sign up with email → 이메일·비밀번호 → Sign up');
  log(sendLog, '"Check your email" 화면이 뜨면 자동으로 다음 단계를 진행합니다...');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldStop?.()) throw new TokenGenStopped();
    const snap = await detectCurrentSnapshot(chromePort, sendLog, 'signup', 1);
    if (snap.step === 'post_verify' || snap.step === 'create_token' || snap.url.includes('signup-questions')) {
      log(sendLog, '✓ 이미 인증·온보딩 단계 (가입 대기 생략)');
      return true;
    }
    if (snap.screen === 'check_email') {
      log(sendLog, '✓ "Check your email" 화면 확인됨');
      return true;
    }
    await sleep(2500);
  }
  throw new Error('"Check your email" 화면 대기 시간 초과. 가입 후 Sign up을 눌렀는지 확인하세요.');
}

async function waitForManualLogin(chromePort, sendLog, shouldStop = null, timeoutMs = 600000) {
  log(sendLog, 'Chrome에서 Log in with email → 이메일·비밀번호 → Log in');
  log(sendLog, '로그인이 완료되면 자동으로 진행합니다...');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldStop?.()) throw new TokenGenStopped();
    const screen = await withNetlifyPage(chromePort, sendLog, (page) => detectNetlifyScreen(page));
    if (screen === 'dashboard' || screen === 'token_settings') {
      log(sendLog, '✓ Netlify 로그인 확인됨');
      return true;
    }
    await sleep(2500);
  }
  throw new Error('Netlify 로그인 대기 시간 초과');
}

function isReadyForNextAccount(snap) {
  if (snap.step === 'create_token' || snap.step === 'post_verify' || snap.step === 'check_email') {
    return true;
  }
  if (['dashboard', 'check_email', 'signup_questions', 'verify_email', 'onboarding_survey'].includes(snap.screen)) {
    return true;
  }
  if (snap.url.includes('signup-questions')) return true;
  if (snap.url.includes('/signup') && !/\/login/i.test(snap.url)) return true;
  if (/app\.netlify\.com/i.test(snap.url) && !snap.url.includes('/login') && snap.step !== 'unknown') {
    return true;
  }
  return false;
}

async function waitForNextAccountLogin(chromePort, sendLog, shouldStop, mode, timeoutMs = 600000) {
  log(sendLog, '═══ 다음 계정 대기 ═══');
  log(sendLog, 'Chrome 로그인(또는 가입) 화면에서 직접 입력하세요. 완료되면 자동으로 다음 계정을 진행합니다.');
  log(sendLog, '💡 중단하려면 앱에서 「정지」 버튼을 누르세요.');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldStop?.()) throw new TokenGenStopped();
    const snap = await detectCurrentSnapshot(chromePort, sendLog, mode, 1);
    if (isReadyForNextAccount(snap)) {
      log(sendLog, `✓ 다음 계정 준비됨 (${snap.url.slice(0, 60) || snap.screen})`);
      return true;
    }
    await sleep(2500);
  }
  throw new Error('다음 계정 로그인·가입 대기 시간 초과');
}

function checkStop(shouldStop, created) {
  if (shouldStop?.()) throw new TokenGenStopped(created);
}

async function extractTokenFromPage(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('code')) {
      const v = (el.textContent || '').trim();
      if (v.startsWith('nfp_')) return v;
    }
    const body = document.body.innerText || '';
    const m = body.match(/nfp_[A-Za-z0-9_-]{20,}/);
    if (m) return m[0];
    for (const el of document.querySelectorAll('input, pre, textarea')) {
      const v = (el.value || el.textContent || '').trim();
      if (v.startsWith('nfp_')) return v;
    }
    return '';
  });
}

async function setExpiration90Days(page, sendLog) {
  const nativeOk = await page.evaluate(() => {
    for (const sel of document.querySelectorAll('select')) {
      for (const opt of sel.options) {
        if (/90\s*day/i.test(opt.text) || opt.text.includes('90')) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  });
  if (nativeOk) {
    log(sendLog, '만료 기간: 90일 설정');
    return true;
  }

  const dropdownPos = await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      const t = (btn.textContent || '').trim();
      if (/^\d+\s*days?$/i.test(t)) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  });

  if (!dropdownPos) {
    log(sendLog, '⚠ 만료 드롭다운을 찾지 못함 — 기본값으로 진행');
    return false;
  }

  await page.mouse.click(dropdownPos.x, dropdownPos.y);
  await sleep(700);

  let picked = await clickByText(page, ['90 days'], 'button.menuitem, button[id*="-item-"]');
  if (!picked) {
    picked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('[role="option"], button.menuitem, button[id*="-item-"]')) {
        const t = (el.textContent || '').trim();
        if (/^90\s*days?$/i.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    });
  }

  if (picked) {
    log(sendLog, '만료 기간: 90일 설정');
    await sleep(400);
    return true;
  }

  log(sendLog, '⚠ 90일 옵션을 찾지 못함');
  return false;
}

async function createOneToken(page, description, sendLog) {
  log(sendLog, '═══ 토큰 생성 ═══');
  await page.goto(TOKEN_SETTINGS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);

  let opened = await clickByText(page, ['New access token']);
  if (!opened) {
    await page.goto(TOKEN_NEW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    opened = await clickByText(page, ['New access token', 'Generate new token']);
  }
  if (!opened) {
    const hrefClicked = await page.evaluate(() => {
      const a = document.querySelector('a[href*="personal"]');
      if (a) { a.click(); return true; }
      return false;
    });
    if (hrefClicked) {
      await sleep(2000);
      opened = true;
    }
  }
  if (!opened) throw new Error('「New access token」 버튼을 찾지 못했습니다.');

  await sleep(1500);
  const desc = description || randomTokenDescription();
  const filled = await page.evaluate((val) => {
    const el = document.querySelector('input[name="token"]')
      || document.querySelector('input[type="text"]:not([type="hidden"])');
    if (!el) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, desc);
  if (!filled) throw new Error('토큰 설명 입력란을 찾지 못했습니다.');
  log(sendLog, `토큰 설명: ${desc}`);

  await setExpiration90Days(page, sendLog);
  await sleep(500);

  const submitted = await clickByText(page, ['Generate token', 'Generate', 'Create token']);
  if (!submitted) throw new Error('「Generate token」 버튼을 찾지 못했습니다.');

  await sleep(3000);
  let token = await extractTokenFromPage(page);
  if (!token) {
    await sleep(2000);
    token = await extractTokenFromPage(page);
  }
  if (!token?.startsWith('nfp_')) {
    throw new Error('생성된 토큰(nfp_...)을 화면에서 찾지 못했습니다.');
  }

  log(sendLog, `✅ 토큰 저장: ${token.slice(0, 12)}...`);
  await clickByText(page, ['Done', 'Close', '닫기', '완료']).catch(() => {});
  await sleep(1500);
  return token;
}

async function createTokenOnce(page, description, sendLog, outputRoot, accountKey, saved) {
  if (saved?.lastToken?.startsWith('nfp_')) {
    log(sendLog, `✓ 토큰 이미 생성됨 (${saved.lastToken.slice(0, 12)}...) — 재생성 생략`);
    return saved.lastToken;
  }

  const onPage = await extractTokenFromPage(page);
  if (onPage?.startsWith('nfp_')) {
    log(sendLog, '✓ 화면에 생성된 토큰이 있음 — 재생성 생략');
    saveProgress(outputRoot, accountKey, { step: 'logout', lastToken: onPage });
    return onPage;
  }

  const token = await createOneToken(page, description, sendLog);
  saveProgress(outputRoot, accountKey, { step: 'logout', lastToken: token });
  return token;
}

async function runPostVerifyAutomation(chromePort, sendLog) {
  log(sendLog, '═══ 2단계: 이메일 인증 후 Netlify 자동 진행 ═══');

  await withNetlifyPage(chromePort, sendLog, async (page) => {
    await clickVerifyEmailButton(page, sendLog);
    await sleep(2000);

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const screen = await detectNetlifyScreen(page);
      if (screen === 'signup_questions' || screen === 'onboarding_survey' || screen === 'dashboard') {
        break;
      }
      if (screen === 'verify_email') {
        await clickVerifyEmailButton(page, sendLog);
      }
      await sleep(2000);
    }

    await completeNetlifyOnboarding(page, sendLog);
  });
}

async function ensureNetlifySession(account, mode, sendLog, openaiApiKey, scratchDir, chromePort, outputRoot, shouldStop = null, yesCaptchaClientKey = '') {
  const email = resolveNaverEmail(account);
  const naverId = resolveNaverId(account);
  const naverPw = (account.naverPw || account.password || '').trim();
  const label = naverId || account.id || email;
  const accountKey = label;

  if (!email) throw new Error(`${label}: 네이버 메일 주소가 필요합니다.`);

  const saved = loadProgress(outputRoot, accountKey);
  const snapshot = await detectCurrentSnapshot(chromePort, sendLog, mode);
  const startStep = resolveResumeStep({
    savedStep: saved?.step,
    detectedStep: snapshot.step,
    detectedUrl: snapshot.url,
    mode,
  });

  log(sendLog, '═══ 화면 인식 이어하기 ═══');
  log(sendLog, describeResume(startStep, snapshot, saved));
  saveProgress(outputRoot, accountKey, {
    mode,
    step: startStep,
    lastUrl: snapshot.url,
    lastScreen: snapshot.screen,
  });

  if (mode === 'signup') {
    if (!naverId || !naverPw) {
      throw new Error(`${label}: 회원가입 모드에는 네이버 아이디·비밀번호가 필요합니다.`);
    }

    // 1. 가입 (직접 입력) → Check your email
    if (isStepAtOrBefore(startStep, 'check_email')) {
      if (snapshot.step === 'check_email') {
        log(sendLog, '✓ "Check your email" 화면 (이어하기 — 가입 단계 생략)');
      } else if (snapshot.step === 'post_verify' || snapshot.url.includes('signup-questions')) {
        log(sendLog, '✓ 온보딩 설문 화면 (이어하기 — 가입 단계 생략)');
      } else if (snapshot.step === 'manual_signup') {
        log(sendLog, '═══ 1단계: Netlify 가입 (직접 입력) ═══');
        log(sendLog, 'Chrome에서 Sign up with email → 이메일·비밀번호 → Sign up');
        await waitForCheckEmailScreen(chromePort, sendLog, shouldStop);
      } else if (isStepBefore(snapshot.step, 'check_email') || snapshot.step === 'unknown') {
        log(sendLog, '가입 페이지로 이동...');
        await openNetlifyPage(chromePort, SIGNUP_URL, sendLog);
        await waitForCheckEmailScreen(chromePort, sendLog, shouldStop);
      } else {
        log(sendLog, `✓ ${stepLabel(snapshot.step)} (이어하기 — 가입 단계 생략)`);
      }
      const pastSignup = snapshot.step === 'post_verify' || snapshot.step === 'create_token'
        || snapshot.url.includes('signup-questions');
      if (!pastSignup) {
        saveProgress(outputRoot, accountKey, { step: 'check_email', lastScreen: 'check_email' });
      }
    }

    // 2. 네이버 메일 인증
    if (isStepAtOrBefore(startStep, 'naver_mail')) {
      checkStop(shouldStop);
      log(sendLog, '인증 메일 도착 대기 (15초)...');
      for (let w = 0; w < 15; w += 1) {
        checkStop(shouldStop);
        await sleep(1000);
      }
      log(sendLog, '═══ 3단계: 네이버 메일 → 인증 링크 (백그라운드) ═══');
      saveProgress(outputRoot, accountKey, { step: 'naver_mail' });

      const mailBrowser = await launchBrowser({
        headless: true,
        defaultViewport: { width: 1280, height: 900 },
      });
      try {
        await verifyNetlifyViaNaverMail({
          mailBrowser,
          naverId,
          naverPw,
          openaiApiKey,
          yesCaptchaClientKey,
          scratchDir,
          chromePort,
          sendLog: (m) => log(sendLog, m),
        });
      } finally {
        await mailBrowser.close().catch(() => {});
      }
      saveProgress(outputRoot, accountKey, { step: 'post_verify' });
    }

    // 3. Verify email + 온보딩
    if (isStepAtOrBefore(startStep, 'post_verify')) {
      await runPostVerifyAutomation(chromePort, sendLog);
      saveProgress(outputRoot, accountKey, { step: 'create_token', lastScreen: 'dashboard' });
    }
  } else {
    if (isStepBefore(startStep, 'create_token')) {
      if (snapshot.step === 'create_token') {
        log(sendLog, '✓ Netlify 로그인됨 (이어하기)');
      } else {
        if (snapshot.step !== 'manual_signup') {
          await openNetlifyPage(chromePort, LOGIN_URL, sendLog);
        }
        await waitForManualLogin(chromePort, sendLog, shouldStop);
      }
      saveProgress(outputRoot, accountKey, { step: 'create_token' });
    } else {
      log(sendLog, `✓ ${stepLabel(startStep)} — 세션 준비 완료`);
    }
  }
}

export async function generateNetlifyTokens({
  accounts = [],
  descriptionPrefix = 'landing-auto-deploy',
  mode = 'signup',
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  outputRoot = './output',
  sendLog = null,
  onProgress = null,
  shouldStop = shouldStopTokenGen,
  headless = false,
} = {}) {
  if (!accounts.length) throw new Error('Netlify 가입 계정을 하나 이상 추가하세요.');
  if (mode === 'signup' && !openaiApiKey && !yesCaptchaClientKey) {
    throw new Error('회원가입 모드: 네이버 캡챠용 OpenAI 또는 YesCaptcha 키가 필요합니다. 설정 탭에서 입력하세요.');
  }

  log(sendLog, `💡 계정 ${accounts.length}개 · 계정당 토큰 1개 · 로그아웃 후 다음 계정 로그인 대기`);
  log(sendLog, '💡 「정지」 버튼을 누를 때까지 목록 순서대로 반복합니다.');

  const scratchDir = path.join(outputRoot, 'token-gen-captcha');
  const chromeProfile = path.join(outputRoot, 'chrome-netlify-profile');
  const chromePort = DEFAULT_DEBUG_PORT;

  log(sendLog, '═══ 화면 인식 자동화: 가입(수동) → 메일·온보딩·토큰(자동) ═══');
  log(sendLog, '💡 중간에 Chrome/앱을 꺼도 다시 실행하면 URL·화면을 인식해 이어서 진행합니다.');

  const portAlreadyOpen = await isDebugPortOpen(chromePort);
  const hasAnyProgress = accounts.some((a) => {
    const key = a.id || resolveNaverEmail(a);
    return !!loadProgress(outputRoot, key);
  });
  const skipStartUrl = portAlreadyOpen || hasAnyProgress;

  await launchChromeStandalone({
    userDataDir: chromeProfile,
    port: chromePort,
    startUrl: skipStartUrl ? '' : (mode === 'signup' ? SIGNUP_URL : LOGIN_URL),
    sendLog: (m) => log(sendLog, m),
  });

  if (!portAlreadyOpen) {
    log(sendLog, 'Chrome 탭 복원 대기 중...');
    await sleep(3500);
  }

  const created = [];

  try {
  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
    checkStop(shouldStop, created);

    const account = accounts[accountIndex];
    const naverId = (account.naverId || '').trim();
    const label = naverId || account.id || resolveNaverEmail(account) || 'account';
    const accountKey = label;

    onProgress?.({
      index: accountIndex,
      label,
      naverId: account.naverId || '',
      status: 'processing',
    });
    log(sendLog, `=== 계정 ${accountIndex + 1}/${accounts.length}: ${label} (${mode === 'signup' ? '회원가입' : '로그인'}) ===`);

    await ensureNetlifySession(account, mode, sendLog, openaiApiKey, scratchDir, chromePort, outputRoot, shouldStop, yesCaptchaClientKey);

    const browser = await connectChromeForAutomation({
      port: chromePort,
      sendLog: (m) => log(sendLog, m),
      quiet: false,
    });

    try {
      checkStop(shouldStop, created);
      const { page } = await findBestNetlifyPage(browser, mode, (m) => log(sendLog, m));

      const desc = `${descriptionPrefix}-${randomTokenDescription()}`;
      log(sendLog, '토큰 1개 생성');
      const progress = loadProgress(outputRoot, accountKey);
      const token = await createTokenOnce(page, desc, sendLog, outputRoot, accountKey, progress);

      created.push({
        token,
        id: naverId || label,
        email: resolveNaverEmail(account),
        naverId,
        used: false,
        usedCount: 0,
      });
      onProgress?.({
        index: accountIndex,
        label: naverId || label,
        naverId,
        status: 'token_created',
        token,
        tokenIndex: 0,
      });

      log(sendLog, '═══ 로그아웃 ═══');
      await logoutNetlify(page, sendLog);
      clearProgress(outputRoot, accountKey);
      log(sendLog, `✅ 계정 ${accountIndex + 1}/${accounts.length} 완료 (토큰 1개 · 로그아웃)`);
      onProgress?.({ index: accountIndex, label, naverId: account.naverId || '', status: 'done' });
    } finally {
      await disconnectBrowser(browser);
    }

    if (accountIndex < accounts.length - 1) {
      checkStop(shouldStop, created);
      onProgress?.({ index: accountIndex + 1, status: 'waiting_login' });
      await waitForNextAccountLogin(chromePort, sendLog, shouldStop, mode);
    }
  }

  log(sendLog, `✨ 전체 완료 — ${created.length}개 토큰 생성`);
  return created;
  } catch (e) {
    if (e.name === 'TokenGenStopped') {
      throw new TokenGenStopped(created.length ? created : (e.tokens || []));
    }
    throw e;
  }
}
