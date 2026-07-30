import fs from 'fs';
import path from 'path';
import { detectCaptcha, solveCaptcha, refreshCaptchaImage } from './naver-register.js';

const NAVER_LOGIN = 'https://nid.naver.com/nidlogin.login?mode=form&url=https://mail.naver.com';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fillNaverCredentials(page, naverId, naverPw) {
  await page.evaluate((id, pw) => {
    const idField = document.querySelector('#id, input[name="id"], input[autocomplete="username"]');
    const pwField = document.querySelector('#pw, input[name="pw"], input[type="password"]');
    if (idField) {
      idField.value = id;
      idField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (pwField) {
      pwField.value = pw;
      pwField.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, naverId, naverPw);
}

async function injectCaptchaAnswer(page, captchaResult) {
  const answer = typeof captchaResult === 'string' ? captchaResult : captchaResult?.answer;
  const targetInputId = typeof captchaResult === 'object' ? captchaResult?.inputId : '';
  if (!answer) return false;

  const allFrames = [page, ...page.frames()];
  const targetFrame = allFrames[captchaResult?.frameIndex || 0] || page;
  const injected = await targetFrame.evaluate((id, ans) => {
    function findCap() {
      if (id) {
        const e = document.getElementById(id);
        if (e) return e;
      }
      const sels = [
        'input#captcha', 'input#chptcha', 'input[name="captcha"]', 'input[name="chptcha"]',
        'input[data-detect="code"]', 'input[placeholder*="정답"]', 'input[placeholder*="보안"]',
        'input.input_text', '.captcha_wrap input[type="text"]', '.captcha_row input[type="text"]',
        '#cap_line input[type="text"]', '#rcapt input[type="text"]',
        '[class*="captcha"] input[type="text"]', '[id*="captcha"] input[type="text"]',
      ];
      for (const s of sels) {
        try {
          const el = document.querySelector(s);
          if (el) return el;
        } catch { /* ignore */ }
      }
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

  if (!injected) return false;

  await targetFrame.evaluate((id) => {
    function findCap() {
      if (id) {
        const e = document.getElementById(id);
        if (e) return e;
      }
      const sels = [
        'input#captcha', 'input#chptcha', 'input[name="captcha"]', 'input[name="chptcha"]',
        'input[data-detect="code"]', 'input[placeholder*="정답"]', 'input[placeholder*="보안"]',
      ];
      for (const s of sels) {
        try {
          const el = document.querySelector(s);
          if (el) return el;
        } catch { /* ignore */ }
      }
      return null;
    }
    const inp = findCap();
    if (inp) inp.focus();
  }, targetInputId);

  await page.keyboard.press('Enter');
  return true;
}

export async function loginNaverWithCaptcha(page, {
  naverId,
  naverPw,
  openaiApiKey = '',
  scratchDir = './output/token-gen-captcha',
  sendLog = null,
} = {}) {
  const log = (msg) => {
    const line = `[NAVER_LOGIN] ${msg}`;
    if (sendLog) sendLog(line);
    console.log(line);
  };

  if (!naverId || !naverPw) throw new Error('네이버 아이디·비밀번호가 필요합니다.');
  if (!openaiApiKey) throw new Error('네이버 캡챠 자동 해결을 위해 OpenAI API Key가 필요합니다.');

  fs.mkdirSync(path.join(scratchDir, 'screenshots'), { recursive: true });

  let lastDialogMsg = '';
  page.on('dialog', async (dialog) => {
    lastDialogMsg = dialog.message();
    try { await dialog.accept(); } catch { /* ignore */ }
  });

  log('네이버 로그인 페이지 이동...');
  await page.goto(NAVER_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);

  await fillNaverCredentials(page, naverId, naverPw);
  await sleep(400);
  await page.keyboard.press('Enter');
  log(`자동 로그인 시도: ${naverId}`);

  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(2000);
    const hasCaptcha = await detectCaptcha(page);
    if (!hasCaptcha) break;

    log(`캡챠 감지 (시도 ${attempt + 1}/5, OCR 단계 ${attempt}) — GPT Vision`);
    await fillNaverCredentials(page, naverId, naverPw);
    await sleep(300);

    const captchaResult = await solveCaptcha(page, scratchDir, openaiApiKey, { attemptLevel: attempt });
    const candidates = (captchaResult?.alternatives?.length
      ? captchaResult.alternatives
      : [captchaResult?.answer]).filter(Boolean);

    let submitted = false;
    for (const ans of candidates) {
      const tryResult = typeof captchaResult === 'object'
        ? { ...captchaResult, answer: ans }
        : ans;
      if (await injectCaptchaAnswer(page, tryResult)) {
        log(`캡챠 입력: ${ans}`);
        submitted = true;
        for (let w = 0; w < 20; w++) {
          if (lastDialogMsg) break;
          await sleep(500);
        }
        await sleep(2000);
        const stillCaptcha = await detectCaptcha(page);
        if (!stillCaptcha) break;
        log(`캡챠 실패 — 대안/새로고침 시도`);
      }
    }
    if (submitted) continue;

    await refreshCaptchaImage(page);
    await sleep(1500);
    log('캡챠 자동 해결 실패 — 30초 수동 입력 대기');
    await sleep(30000);
  }

  const start = Date.now();
  while (Date.now() - start < 120000) {
    const onLogin = await page.evaluate(() => !!(document.querySelector('#id') || document.querySelector('#pw')));
    if (!onLogin) {
      log('네이버 로그인 완료');
      await sleep(2000);
      return true;
    }
    await sleep(1500);
  }

  throw new Error('네이버 로그인 시간 초과 (캡챠·2단계 인증 확인 필요)');
}
