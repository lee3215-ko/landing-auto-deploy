import { detectCaptcha, solveCaptcha, refreshCaptchaImage } from './captcha-solver.js';

export const NAVER_LOGIN = 'https://nid.naver.com/nidlogin.login?mode=form&url=https://www.naver.com/';
export const SEARCH_ADVISOR_BOARD = 'https://searchadvisor.naver.com/console/board';

const PROTECTION_PATTERNS = [
  '보호조치', '보호 조치', '보호하고', '아이디를 보호',
  '2단계 인증', '본인확인', '본인 확인', '비정상적인',
  '로그인 제한', '일시적으로 제한', '자동입력 방지',
  '해외 로그인', '새로운 기기', '인증번호',
];

/** 대량생성 ID 로그인 제한 — ensureNaverSession에서 다음 계정 전환용 */
export class NaverMassCreatedIdError extends Error {
  constructor(info = {}) {
    const id = String(info.accountId || '').trim();
    const reason = String(info.reason || '대량생성 ID').trim();
    super(id
      ? `네이버 로그인 제한(대량생성 ID): ${id}`
      : '네이버 로그인 제한(대량생성 ID)');
    this.name = 'NaverMassCreatedIdError';
    this.code = 'NAVER_MASS_CREATED_ID';
    this.reason = reason;
    this.date = String(info.date || '').trim();
    this.accountId = id;
  }
}

export function isMassCreatedIdReason(reason) {
  return /대량\s*생성\s*ID|대량생성ID/i.test(String(reason || ''));
}

export function isMassCreatedIdRestriction(info) {
  return !!(info && isMassCreatedIdReason(info.reason));
}

/**
 * nid 로그인 제한 화면(#divWarning)에서 제한일자·사유 추출
 * @returns {Promise<{reason:string,date:string,accountId:string}|null>}
 */
export async function detectNaverLoginRestriction(page) {
  if (!page || page.isClosed?.()) return null;
  try {
    const url = page.url() || '';
    if (!/nid\.naver\.com/i.test(url)) return null;
    return await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const hasWarn = !!(
        document.querySelector('#divWarning, .warning_title, .protection_content')
        || /로그인\s*제한|제한사유|대량\s*생성/.test(body)
      );
      if (!hasWarn) return null;

      function cellAfter(header) {
        const want = String(header || '').replace(/\s+/g, '');
        for (const th of document.querySelectorAll('th')) {
          const t = (th.innerText || th.textContent || '').replace(/\s+/g, '').trim();
          if (!t.includes(want)) continue;
          const td = th.closest('tr')?.querySelector('td');
          if (td) return (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return '';
      }

      const reason = cellAfter('제한사유');
      const date = cellAfter('제한일자');
      const em = document.querySelector('#divWarning em, .warning_title em, .warning em');
      const accountId = (em?.textContent || '').replace(/\s+/g, '').trim();
      if (!reason && !date && !/로그인\s*제한|로그인을\s*제한/.test(body)) return null;
      return { reason: reason || '', date: date || '', accountId: accountId || '' };
    });
  } catch {
    return null;
  }
}

async function throwIfMassCreatedId(page, fallbackAccountId = '') {
  const info = await detectNaverLoginRestriction(page);
  if (!isMassCreatedIdRestriction(info)) return info;
  throw new NaverMassCreatedIdError({
    ...info,
    accountId: info.accountId || fallbackAccountId || '',
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function pageHasNaverProtection(page) {
  try {
    const url = page.url() || '';
    // 홈/보드 본문 오탐 방지 — nid 로그인·인증 화면에서만 검사
    if (!/nid\.naver\.com/i.test(url)) return false;
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
    const url = page.url() || '';
    if (!/nid\.naver\.com/i.test(url)) return false;
    return await page.evaluate(() => !!(document.querySelector('#id') || document.querySelector('#pw')));
  } catch {
    return false;
  }
}

/** 로그인 성공: nid/oauth 로그인 폼을 벗어남 */
export async function isNaverLoggedIn(page) {
  try {
    const url = page.url() || '';
    if (!url || url === 'about:blank' || url.startsWith('chrome://')) return false;

    // OAuth·로그인 페이지 = 미로그인
    if (/nid\.naver\.com/i.test(url) || /oauth2\.0\/authorize/i.test(url)) return false;

    if (/searchadvisor\.naver\.com/i.test(url) && !/\/auth\//i.test(url)) return true;

    if (/naver\.com/i.test(url)) {
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
  accountId = '',
} = {}) {
  const start = Date.now();
  let announced = false;

  while (Date.now() - start < maxWaitMs) {
    if (page.isClosed?.()) {
      throw new Error('네이버 로그인 창이 닫혔습니다. 다시 「네이버 로그인」을 눌러 주세요.');
    }

    await throwIfMassCreatedId(page, accountId);

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
        log('⏳ Chrome에서 아이디·비밀번호 입력 후 「로그인」을 눌러 주세요. (최대 10분 대기)');
      }
      announced = true;
    }

    await sleep(2000);
  }

  throw new Error('네이버 로그인 대기 시간 초과 — 보호조치·2단계 인증을 수동으로 완료한 뒤 다시 시도해 주세요.');
}

async function turnOffIpSecurity(page) {
  try {
    await page.evaluate(() => {
      // IP 보안 ON이면 꺼서 추가인증을 줄임
      const candidates = [
        document.querySelector('#switch'),
        document.querySelector('.ip_check .switch_on'),
        document.querySelector('.ip_check span[role="checkbox"]'),
        ...Array.from(document.querySelectorAll('.switch_on, .switch')),
      ].filter(Boolean);
      for (const el of candidates) {
        const wrap = el.closest?.('.ip_check') || el.parentElement;
        const text = ((wrap?.innerText || el.innerText || '') + '').replace(/\s+/g, '');
        const on = el.classList?.contains('switch_on')
          || el.getAttribute?.('aria-checked') === 'true'
          || /IP보안.*ON|ON/i.test(text);
        if (on || /ip/i.test(el.id || '') || (wrap && /IP/.test(wrap.innerText || ''))) {
          el.click();
          return;
        }
      }
    });
  } catch { /* ignore */ }
}

async function typeIntoField(page, selectors, value) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of sels) {
    const el = await page.$(sel);
    if (!el) continue;
    await el.click({ clickCount: 1 }).catch(() => {});
    await sleep(150);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await sleep(80);
    await page.keyboard.type(String(value), { delay: 35 });
    await sleep(200);
    return true;
  }
  return false;
}

async function clickLoginButton(page) {
  const clicked = await page.evaluate(() => {
    const sels = [
      '#log\\.login',
      'button.btn_login',
      '.btn_login',
      'button[type="submit"]',
      'input.btn_login',
      'input[type="submit"]',
    ];
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        if (el) {
          el.click();
          return s;
        }
      } catch { /* ignore */ }
    }
    // 텍스트로 「로그인」 버튼 찾기
    const nodes = document.querySelectorAll('button, a, input[type="submit"]');
    for (const el of nodes) {
      const t = ((el.textContent || el.value || '') + '').trim();
      if (t === '로그인') {
        el.click();
        return 'text:로그인';
      }
    }
    return '';
  });
  if (clicked) return true;
  await page.keyboard.press('Enter');
  return false;
}

async function tryAutoLoginFields(page, naverAccount) {
  if (!naverAccount?.id || !naverAccount?.pw) return false;
  await turnOffIpSecurity(page);
  await sleep(300);

  const idOk = await typeIntoField(page, ['#id', 'input[name="id"]', 'input[autocomplete="username"]'], naverAccount.id);
  await sleep(250);
  const pwOk = await typeIntoField(page, ['#pw', 'input[name="pw"]', 'input[type="password"]'], naverAccount.pw);
  if (!idOk || !pwOk) return false;

  await sleep(400);
  await clickLoginButton(page);
  return true;
}

async function handleLoginCaptcha(page, naverAccount, openaiApiKey, outputFolder, loginAttempt, log, getLastDialogMsg, yesCaptchaClientKey = '') {
  if (!(await detectCaptcha(page))) return false;
  if (!(await isNaverLoginFormVisible(page)) && !(await pageHasNaverProtection(page))) return false;

  log(`   🚨 로그인 캡챠 감지 (시도 ${loginAttempt + 1}/5)`);
  await tryAutoLoginFields(page, naverAccount);

  const captchaResult = await solveCaptcha(page, outputFolder, openaiApiKey, {
    attemptLevel: loginAttempt,
    yesCaptchaClientKey,
    context: 'naver-login',
  });
  const candidates = (captchaResult?.alternatives?.length
    ? captchaResult.alternatives
    : [typeof captchaResult === 'string' ? captchaResult : captchaResult?.answer]).filter(Boolean);

  const tried = [];
  for (const answer of candidates) {
    if (!answer) continue;
    tried.push(answer);
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
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(inp, ans);
      else inp.value = ans;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, targetInputId, answer);
    if (!injected) continue;
    log(`   ⌨️  캡챠 입력: ${answer}`);
    await clickLoginButton(page);
    for (let w = 0; w < 20; w++) {
      if (getLastDialogMsg?.()) break;
      await sleep(500);
    }
    await sleep(2000);
    if (!(await detectCaptcha(page)) && (await isNaverLoggedIn(page))) {
      try {
        const { logCaptchaSuccess } = await import('./captcha-learn.js');
        logCaptchaSuccess({
          context: 'naver-login',
          solver: captchaResult?.solver || '',
          answer,
          captchaKey: captchaResult?.captchaKey || '',
          imageHash: captchaResult?.imageHash || '',
          failedBefore: tried.slice(0, -1),
        });
      } catch { /* ignore */ }
      return true;
    }
  }
  try {
    const { logCaptchaFailure } = await import('./captcha-learn.js');
    logCaptchaFailure({
      context: 'naver-login',
      solver: captchaResult?.solver || 'unknown',
      answers: tried,
      reason: 'submit_rejected',
      captchaKey: captchaResult?.captchaKey || '',
      imageHash: captchaResult?.imageHash || '',
      attemptLevel: loginAttempt,
    });
  } catch { /* ignore */ }
  await refreshCaptchaImage(page);
  await sleep(1500);
  return false;
}

/**
 * 신규 서치어드바이저 계정: 「동의하기」체크 + 확인
 * 팝업이 없으면 false 반환 후 그대로 진행
 */
export async function acceptSearchAdvisorConsentIfPresent(page, log = () => {}) {
  if (!page || page.isClosed?.()) return false;

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8
          && st.visibility !== 'hidden'
          && st.display !== 'none'
          && st.opacity !== '0';
      };

      const roots = [];
      for (const sel of [
        '[role="dialog"]',
        '.v-dialog--active',
        '.v-dialog',
        '.v-overlay--active .v-overlay__content',
        '.modal',
        '.ly_pop',
        '.popup',
        '.layer_popup',
      ]) {
        document.querySelectorAll(sel).forEach((el) => {
          if (isVisible(el)) roots.push(el);
        });
      }
      // 본문에 동의 UI만 있는 경우
      if (!roots.length) roots.push(document.body);

      for (const root of roots) {
        const text = (root.innerText || '').replace(/\s+/g, ' ');
        if (!/동의/.test(text)) continue;
        if (!/(이용\s*약관|개인정보|서비스\s*이용|동의하고|동의합니다|필수\s*동의)/i.test(text)
          && !/동의하기/.test(text)) {
          continue;
        }

        // 체크박스 / 동의하기 토글
        const checks = root.querySelectorAll(
          'input[type="checkbox"], .v-input--selection-controls__input, .v-selection-control, label, [role="checkbox"]',
        );
        let checked = 0;
        for (const el of checks) {
          const labelText = (
            (el.closest('label')?.innerText || el.innerText || el.getAttribute('aria-label') || '')
          ).replace(/\s+/g, ' ');
          const nearAgree = /동의/.test(labelText) || /동의/.test(el.parentElement?.innerText || '');
          if (!nearAgree && el.tagName !== 'INPUT') continue;

          if (el.tagName === 'INPUT') {
            if (!el.checked) {
              el.click();
              checked += 1;
            } else {
              checked += 1;
            }
          } else {
            const input = el.querySelector('input[type="checkbox"]');
            if (input && !input.checked) {
              el.click();
              checked += 1;
            } else if (!input && nearAgree) {
              el.click();
              checked += 1;
            } else if (input?.checked) {
              checked += 1;
            }
          }
        }

        // 「전체 동의」버튼
        for (const btn of root.querySelectorAll('button, a, [role="button"], .v-btn, label')) {
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (/^(전체\s*동의|모두\s*동의|전부\s*동의)/.test(t) && isVisible(btn)) {
            btn.click();
            checked += 1;
          }
        }

        // 확인 / 동의하고 시작 등
        for (const btn of root.querySelectorAll('button, a, [role="button"], .v-btn, input[type="button"], input[type="submit"]')) {
          const t = (btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim();
          if (!/^(확\s*인|확인|동의하고\s*시작|동의\s*완료|시작하기|다음)$/.test(t)) continue;
          if (!isVisible(btn)) continue;
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
          btn.click();
          return { ok: true, checked, button: t };
        }
      }
      return { ok: false, checked: 0 };
    }).catch(() => ({ ok: false }));

    if (result?.ok) {
      log(`   ✅ 서치어드바이저 동의 팝업 처리 (${result.button || '확인'}${result.checked ? `, 체크 ${result.checked}` : ''})`);
      await sleep(1200);
      return true;
    }

    // 동의 관련 UI가 아예 없으면 스킵
    const hasConsentUi = await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return /동의하기|이용\s*약관|개인정보.*동의|필수\s*동의/.test(body)
        && !!(document.querySelector('[role="dialog"], .v-dialog--active, .v-dialog, .modal, .ly_pop'));
    }).catch(() => false);

    if (!hasConsentUi) return false;
    await sleep(700);
  }
  return false;
}

async function goToSearchAdvisorBoard(page, log) {
  const cur = page.url() || '';
  // OAuth callback(/auth/callback?code=...) 은 로그인 중간 화면 — 보드로 보냄
  if (/searchadvisor\.naver\.com\/auth\//i.test(cur)) {
    log('   OAuth 콜백 화면 감지 → 대시보드로 이동…');
  } else if (/searchadvisor\.naver\.com\/console\//i.test(cur)) {
    log(`   ✅ 이미 대시보드: ${cur}`);
    await acceptSearchAdvisorConsentIfPresent(page, log);
    return;
  } else if (/searchadvisor\.naver\.com/i.test(cur) && !/nid\.naver\.com/i.test(cur) && !/\/auth\//i.test(cur)) {
    log(`   ✅ 이미 서치어드바이저: ${cur}`);
    await acceptSearchAdvisorConsentIfPresent(page, log);
    return;
  }

  log('📂 네이버 서치어드바이저 대시보드로 이동…');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(SEARCH_ADVISOR_BOARD, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      log(`   대시보드 이동 재시도 (${attempt + 1}/3): ${e.message || e}`);
      await sleep(1500);
      continue;
    }
    await sleep(2000);
    await acceptSearchAdvisorConsentIfPresent(page, log);
    const url = page.url() || '';
    if (/searchadvisor\.naver\.com\/auth\//i.test(url)) {
      log('   아직 OAuth 콜백 — 보드 재진입…');
      await sleep(1500);
      continue;
    }
    if (/searchadvisor\.naver\.com/i.test(url) && !/nid\.naver\.com/i.test(url)) {
      log(`   ✅ 대시보드: ${url}`);
      return;
    }
    if (/nid\.naver\.com/i.test(url) || (await isNaverLoginFormVisible(page))) {
      // 로그인 세션이 아직 안 잡힌 경우 — 짧게 대기 후 재시도
      log('   아직 로그인 세션 반영 전 — 잠시 후 재시도…');
      await sleep(2500);
      continue;
    }
  }

  const finalUrl = page.url() || '';
  if (/searchadvisor\.naver\.com/i.test(finalUrl) && !/nid\.naver\.com/i.test(finalUrl) && !/\/auth\//i.test(finalUrl)) {
    await acceptSearchAdvisorConsentIfPresent(page, log);
    log(`   ✅ 대시보드: ${finalUrl}`);
    return;
  }
  throw new Error(`서치어드바이저 대시보드 진입 실패 (현재: ${finalUrl || 'unknown'})`);
}

/**
 * 1) nid 로그인 페이지 접속
 * 2) 로그인 (자동 시도 → 필요 시 수동)
 * 3) 서치어드바이저 보드로 이동
 */
export async function loginNaverForSearchAdvisor(page, naverAccount, {
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  outputFolder = './output',
  log = () => {},
  screenshotFn = null,
  getLastDialogMsg = null,
  manualOnly = false,
} = {}) {
  log('🔐 네이버 로그인 페이지 접속…');
  log(`   ${NAVER_LOGIN}`);
  await page.goto(NAVER_LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);

  const accountId = String(naverAccount?.id || '').trim();

  if (manualOnly) {
    log('⏳ Chrome에서 직접 로그인해 주세요. (최대 10분 대기)');
    await waitForNaverManualLogin(page, { log, screenshotFn, outputFolder, accountId });
    await goToSearchAdvisorBoard(page, log);
    return;
  }

  if (naverAccount?.id && naverAccount?.pw) {
    log(`   ID: ${naverAccount.id} — 자동 입력 후 로그인 클릭`);
    await tryAutoLoginFields(page, naverAccount);
  } else {
    log('⏳ 수동 로그인 대기…');
  }

  await sleep(2500);
  await throwIfMassCreatedId(page, accountId);
  if (await pageHasNaverProtection(page)) {
    // 대량생성 ID가 아닌 일반 보호조치만 수동 대기
    log('🛡️ 로그인 직후 보호조치 감지 — Chrome에서 직접 인증해 주세요.');
    await waitForNaverManualLogin(page, { log, screenshotFn, outputFolder, accountId });
    await goToSearchAdvisorBoard(page, log);
    return;
  }

  for (let loginAttempt = 0; loginAttempt < 5; loginAttempt++) {
    if (page.isClosed?.()) {
      throw new Error('네이버 로그인 창이 닫혔습니다. 다시 「네이버 로그인」을 눌러 주세요.');
    }
    await throwIfMassCreatedId(page, accountId);
    if (await isNaverLoggedIn(page)) break;

    if (await pageHasNaverProtection(page)) {
      log('🛡️ 보호조치 감지 — 수동 로그인 대기로 전환');
      break;
    }

    if (naverAccount?.id) {
      const captchaOk = await handleLoginCaptcha(
        page, naverAccount, openaiApiKey, outputFolder, loginAttempt, log, getLastDialogMsg, yesCaptchaClientKey,
      );
      if (captchaOk) break;
    }

    if (await isNaverLoggedIn(page)) break;
    await sleep(1500);
  }

  await throwIfMassCreatedId(page, accountId);
  if (!(await isNaverLoggedIn(page))) {
    log('⏳ 자동 로그인 미완료 — Chrome에서 「로그인」을 완료해 주세요.');
    await waitForNaverManualLogin(page, { log, screenshotFn, outputFolder, accountId });
  }

  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 }).catch(() => {});
  log(`   로그인 후 URL: ${page.url()}`);

  await goToSearchAdvisorBoard(page, log);
}
