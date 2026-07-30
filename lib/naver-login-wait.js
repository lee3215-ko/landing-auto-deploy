import { detectCaptcha, solveCaptcha, refreshCaptchaImage } from './captcha-solver.js';

const NAVER_LOGIN = 'https://nid.naver.com/nidlogin.login?mode=form&url=https://www.naver.com';

const PROTECTION_PATTERNS = [
  '보호조치', '보호 조치', '보호하고', '아이디를 보호',
  '2단계 인증', '본인확인', '본인 확인', '비정상적인',
  '로그인 제한', '일시적으로 제한', '자동입력 방지',
  '해외 로그인', '새로운 기기', '인증번호',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function pageHasNaverProtection(page) {
  try {
    return await page.evaluate((patterns) => {
      const text = document.body?.innerText || '';
      return patterns.some((p) => text.includes(p));
    }, PROTECTION_PATTERNS);
  } catch {
    return false;
  }
}

export async function isNaverLoginFormVisible(page) {
  try {
    return await page.evaluate(() => !!(document.querySelector('#id') || document.querySelector('#pw')));
  } catch {
    return false;
  }
}

export async function isNaverLoggedIn(page) {
  try {
    const url = page.url();
    if (/searchadvisor\.naver\.com/i.test(url)) return true;
    if (/nid\.naver\.com/i.test(url)) {
      const onForm = await isNaverLoginFormVisible(page);
      if (onForm) return false;
      const protection = await pageHasNaverProtection(page);
      return !protection;
    }
    if (/\.naver\.com/i.test(url)) {
      return !(await isNaverLoginFormVisible(page));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 보호조치·2단계 인증 등으로 자동 로그인이 막힌 경우 사용자가 직접 로그인할 때까지 대기
 */
export async function waitForNaverManualLogin(page, {
  log = () => {},
  maxWaitMs = 600000,
  screenshotFn = null,
  outputFolder = './output',
} = {}) {
  const start = Date.now();
  let announced = false;

  while (Date.now() - start < maxWaitMs) {
    if (await isNaverLoggedIn(page)) {
      log('✅ 네이버 로그인 완료');
      await sleep(1500);
      return true;
    }

    const protection = await pageHasNaverProtection(page);
    const onLogin = await isNaverLoginFormVisible(page);

    if (!announced && (protection || onLogin)) {
      if (protection) {
        log('🛡️ 네이버 보호조치/추가인증 화면 감지');
        log('   → Chrome 창에서 직접 로그인·인증을 완료해 주세요. (최대 10분 대기)');
        if (screenshotFn) await screenshotFn(page, 'manual_login_protection', outputFolder);
      } else {
        log('⏳ 자동 로그인 미완료 — Chrome에서 수동 로그인을 완료해 주세요. (최대 10분 대기)');
      }
      announced = true;
    }

    await sleep(2000);
  }

  throw new Error('네이버 로그인 대기 시간 초과 — 보호조치·2단계 인증을 수동으로 완료한 뒤 다시 시도해 주세요.');
}

async function tryAutoLoginFields(page, naverAccount) {
  if (!naverAccount?.id || !naverAccount?.pw) return;
  await page.evaluate((id, pw) => {
    const idField = document.querySelector('#id, input[name="id"], input[autocomplete="username"]');
    const pwField = document.querySelector('#pw, input[name="pw"], input[type="password"]');
    if (idField) { idField.value = id; idField.dispatchEvent(new Event('input', { bubbles: true })); }
    if (pwField) { pwField.value = pw; pwField.dispatchEvent(new Event('input', { bubbles: true })); }
  }, naverAccount.id, naverAccount.pw);
  await sleep(400);
  await page.keyboard.press('Enter');
}

async function handleLoginCaptcha(page, naverAccount, openaiApiKey, outputFolder, loginAttempt, log, getLastDialogMsg) {
  if (!(await detectCaptcha(page))) return false;
  if (!(await isNaverLoginFormVisible(page)) && !(await pageHasNaverProtection(page))) return false;

  log(`   🚨 로그인 캡챠 감지 (시도 ${loginAttempt + 1}/5)`);
  await tryAutoLoginFields(page, naverAccount);

  const captchaResult = await solveCaptcha(page, outputFolder, openaiApiKey, { attemptLevel: loginAttempt });
  const candidates = (captchaResult?.alternatives?.length
    ? captchaResult.alternatives
    : [typeof captchaResult === 'string' ? captchaResult : captchaResult?.answer]).filter(Boolean);

  for (const answer of candidates) {
    if (!answer) continue;
    const allFrames = [page, ...page.frames()];
    const targetFrame = allFrames[captchaResult?.frameIndex || 0] || page;
    const targetInputId = typeof captchaResult === 'object' ? captchaResult?.inputId : '';
    const injected = await targetFrame.evaluate((id, ans) => {
      function findCap() {
        if (id) { const e = document.getElementById(id); if (e) return e; }
        const sels = ['input#captcha', 'input#chptcha', 'input[name="captcha"]', 'input[name="chptcha"]', 'input[data-detect="code"]', 'input[placeholder*="정답"]', 'input[placeholder*="보안"]'];
        for (const s of sels) { try { const el = document.querySelector(s); if (el) return el; } catch {} }
        return null;
      }
      const inp = findCap();
      if (!inp) return false;
      inp.focus();
      inp.value = ans;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, targetInputId, answer);
    if (!injected) continue;
    log(`   ⌨️  캡챠 입력: ${answer}`);
    await page.keyboard.press('Enter');
    for (let w = 0; w < 20; w++) {
      if (getLastDialogMsg?.()) break;
      await sleep(500);
    }
    await sleep(2000);
    if (!(await detectCaptcha(page)) && (await isNaverLoggedIn(page))) return true;
  }
  await refreshCaptchaImage(page);
  await sleep(1500);
  return false;
}

/**
 * 서치어드바이저 등록용 네이버 로그인 — 자동 시도 후 보호조치 시 수동 로그인 대기
 */
export async function loginNaverForSearchAdvisor(page, naverAccount, {
  openaiApiKey = '',
  outputFolder = './output',
  log = () => {},
  screenshotFn = null,
  getLastDialogMsg = null,
  manualOnly = false,
} = {}) {
  log('🔐 네이버 로그인...');
  await page.goto(NAVER_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  if (manualOnly) {
    log('⏳ 로그인 창이 열렸습니다. Chrome에서 직접 로그인해 주세요. (최대 10분 대기)');
    await waitForNaverManualLogin(page, { log, screenshotFn, outputFolder });
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {});
    log(`   URL: ${page.url()}`);
    return;
  }

  if (naverAccount?.id && naverAccount?.pw) {
    await tryAutoLoginFields(page, naverAccount);
    log(`   ID: ${naverAccount.id} — 자동 로그인 시도`);
  } else {
    log('⏳ 수동 로그인 대기...');
  }

  await sleep(2000);
  if (await pageHasNaverProtection(page)) {
    log('🛡️ 로그인 직후 보호조치 감지 — 자동 입력을 중단하고 수동 로그인을 기다립니다.');
    await waitForNaverManualLogin(page, { log, screenshotFn, outputFolder });
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {});
    return;
  }

  for (let loginAttempt = 0; loginAttempt < 5; loginAttempt++) {
    if (await isNaverLoggedIn(page)) break;

    if (await pageHasNaverProtection(page)) {
      log('🛡️ 보호조치 감지 — 수동 로그인 대기로 전환');
      break;
    }

    if (naverAccount?.id) {
      const captchaOk = await handleLoginCaptcha(
        page, naverAccount, openaiApiKey, outputFolder, loginAttempt, log, getLastDialogMsg,
      );
      if (captchaOk) break;
    }

    if (await isNaverLoggedIn(page)) break;
    await sleep(1500);
  }

  if (!(await isNaverLoggedIn(page))) {
    await waitForNaverManualLogin(page, { log, screenshotFn, outputFolder });
  }

  await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {});
  log(`   URL: ${page.url()}`);
}
