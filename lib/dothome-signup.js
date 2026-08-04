import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { launchBrowser } from './puppeteer-launch.js';
import { log as sharedLog } from './logger.js';
import { isPlausibleCaptchaCode } from './captcha-solver.js';
import { fetchDothomeAuthCodeFromNaverMail } from './dothome-mail-auth.js';
import { passRecaptchaHumanLike } from './dothome-recaptcha.js';

const require = createRequire(import.meta.url);
let sharp = null;
try { sharp = require('sharp'); } catch { /* optional */ }

const AGREE_URL = 'https://www.dothome.co.kr/member/join/service-agree.php';
const LOGIN_URL = 'https://www.dothome.co.kr/login.php?rt_url=05528aeef36e378aa0c30795377485ef6d6bf0b5f8dc9113f215a777a80b37f9ef52a992e89c3deff2b2b38579667215';
const FREE_HOSTING_CANDIDATES = [
  'https://www.dothome.co.kr/hosting/free.php',
  'https://www.dothome.co.kr/customer/product/free_hosting.php',
  'https://www.dothome.co.kr/hosting/freehosting.php',
];
const FIXED_PASSWORD = 'dlwkdrns12435!';

const RANDOM_ADDRESSES = [
  '서울특별시 강남구 테헤란로 152',
  '서울특별시 서초구 서초대로 396',
  '서울특별시 마포구 월드컵북로 396',
  '경기도 성남시 분당구 판교역로 235',
  '경기도 수원시 영통구 광교중앙로 145',
  '인천광역시 연수구 센트럴로 263',
  '부산광역시 해운대구 센텀중앙로 97',
  '대구광역시 수성구 달구벌대로 2437',
  '대전광역시 유성구 대학로 99',
  '광주광역시 서구 상무중앙로 61',
];

const NAME_SYLLABLES = [
  '민', '서', '지', '현', '수', '영', '준', '호', '윤', '하',
  '유', '진', '성', '우', '아', '은', '혜', '연', '재', '도',
  '경', '원', '석', '훈', '기', '태', '상', '희', '나', '솔',
];

const CAPTCHA_PROMPTS = [
  `이 이미지는 닷홈 회원가입 보안문자입니다.
글자를 왼쪽→오른쪽으로 한 글자씩 정확히 읽고, 공백/설명/따옴표 없이 코드만 출력하세요.
영문·숫자만. 대소문자를 구분하세요. 보통 4~8자입니다.
0과 O, 1과 I/l, 5와 S, 8과 B를 혼동하지 마세요.
거절·설명 문구는 금지. 코드만 출력.`,
  `OCR CAPTCHA: read ONLY the distorted characters left-to-right.
Output A-Za-z0-9 only, no spaces, no explanation. Preserve case. Length typically 4-8.`,
  `보안문자 OCR. 이미지 속 문자를 순서대로 이어 붙여라.
출력 형식: 코드 문자열만. 영문 대소문자+숫자. 거절/사과 금지.`,
];

let cancelRequested = false;

export function requestDothomeSignupCancel() {
  cancelRequested = true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function relay(sendLog, msg) {
  sharedLog(`[DOTHOME] ${msg}`);
  if (sendLog) sendLog(msg);
}

function checkCancel() {
  if (cancelRequested) throw new Error('사용자 정지');
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/** 영문+숫자 조합 아이디 (이전에 쓴 아이디 제외) */
export function generateDothomeId(usedIds = []) {
  const used = new Set((usedIds || []).map((x) => String(x).toLowerCase()));
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789';

  for (let attempt = 0; attempt < 80; attempt++) {
    const len = 8 + Math.floor(Math.random() * 4); // 8~11
    let id = letters[Math.floor(Math.random() * letters.length)];
    for (let i = 1; i < len; i++) {
      id += alnum[Math.floor(Math.random() * alnum.length)];
    }
    if (!/\d/.test(id)) {
      id = `${id.slice(0, -1)}${Math.floor(Math.random() * 10)}`;
    }
    if (!used.has(id.toLowerCase())) return id;
  }
  throw new Error('사용 가능한 새 아이디를 만들지 못했습니다.');
}

function randomHangulName() {
  return `${randomPick(NAME_SYLLABLES)}${randomPick(NAME_SYLLABLES)}${randomPick(NAME_SYLLABLES)}`;
}

function randomPhoneParts() {
  return {
    tel1: '010',
    tel2: randomDigits(4),
    tel3: randomDigits(4),
  };
}

async function setInputValue(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`입력창 없음: ${sel}`);
    el.focus();
    el.value = '';
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, selector, String(value));
}

function cleanCaptchaAnswer(raw) {
  const cleaned = String(raw || '').replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  return isPlausibleCaptchaCode(cleaned, false) ? cleaned : '';
}

function tallyVotes(votes) {
  const tally = {};
  for (const v of votes) {
    if (!v) continue;
    tally[v] = (tally[v] || 0) + 1;
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([answer, count]) => ({ answer, count }));
}

async function buildImageVariants(inputBuf, variantCount = 4) {
  const variants = [];
  const push = (buf, mime, label) => {
    variants.push({ buf, b64: buf.toString('base64'), mime, label });
  };

  let baseBuf = inputBuf;
  let meta = { width: 0, height: 0, format: 'png' };
  if (sharp) {
    try {
      meta = await sharp(inputBuf).metadata();
      if (meta.format === 'gif' || (meta.pages && meta.pages > 1)) {
        baseBuf = await sharp(inputBuf, { pages: 1 }).png().toBuffer();
        meta = await sharp(baseBuf).metadata();
      }
    } catch { /* keep original */ }
  }

  push(baseBuf, meta.format === 'jpeg' ? 'image/jpeg' : 'image/png', 'original');
  if (!sharp || variantCount < 2) return variants.slice(0, variantCount);

  try {
    const w = Math.max(meta.width || 120, 80);
    const up = await sharp(baseBuf).resize({ width: Math.round(w * 3), kernel: 'lanczos3' }).png().toBuffer();
    push(up, 'image/png', 'upscale3x');
  } catch { /* skip */ }

  if (variantCount >= 3) {
    try {
      const norm = await sharp(baseBuf)
        .resize({ width: Math.round((meta.width || 120) * 2.5), kernel: 'lanczos3' })
        .normalize()
        .sharpen({ sigma: 1.2 })
        .png()
        .toBuffer();
      push(norm, 'image/png', 'normalize');
    } catch { /* skip */ }
  }

  if (variantCount >= 4) {
    try {
      const gray = await sharp(baseBuf)
        .resize({ width: Math.round((meta.width || 120) * 2.5), kernel: 'lanczos3' })
        .greyscale()
        .linear(1.35, -18)
        .threshold(140)
        .png()
        .toBuffer();
      push(gray, 'image/png', 'threshold');
    } catch { /* skip */ }
  }

  if (variantCount >= 5) {
    try {
      const inv = await sharp(baseBuf)
        .resize({ width: Math.round((meta.width || 120) * 2.5), kernel: 'lanczos3' })
        .negate()
        .normalize()
        .png()
        .toBuffer();
      push(inv, 'image/png', 'negate');
    } catch { /* skip */ }
  }

  return variants.slice(0, variantCount);
}

async function callVision({ apiKey, prompt, b64, mimeType, temperature = 0 }) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}`, detail: 'high' } },
        ],
      }],
      temperature,
      max_tokens: 40,
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function captureCaptchaBuffer(page, folder, tag = 'captcha') {
  fs.mkdirSync(folder, { recursive: true });
  await page.waitForSelector('#capt_img', { timeout: 15000 });

  // 1) 원본 URL 다운로드 (쿠키 포함)
  const srcInfo = await page.evaluate(() => {
    const img = document.querySelector('#capt_img');
    if (!img) return null;
    const src = img.currentSrc || img.src || '';
    return { src, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  });

  let buf = null;
  if (srcInfo?.src) {
    try {
      buf = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ab = await r.arrayBuffer();
        return Array.from(new Uint8Array(ab));
      }, srcInfo.src);
      if (buf?.length) buf = Buffer.from(buf);
    } catch {
      buf = null;
    }
  }

  // 2) 요소 스크린샷 폴백 / 보조
  const shotPath = path.join(folder, `${tag}_shot.png`);
  const imgHandle = await page.$('#capt_img');
  if (imgHandle) {
    await imgHandle.screenshot({ path: shotPath });
  }

  if (!buf || buf.length < 80) {
    if (!fs.existsSync(shotPath)) throw new Error('보안문자 이미지를 캡처하지 못했습니다.');
    buf = fs.readFileSync(shotPath);
  } else {
    fs.writeFileSync(path.join(folder, `${tag}_raw.bin`), buf);
    // PNG가 아니면 스크린샷도 후보로 남김
  }

  return { buf, shotPath, srcInfo };
}

async function refreshDothomeCaptcha(page) {
  try {
    await page.click('#reload_capt_btn');
  } catch {
    await page.evaluate(() => {
      const btn = document.querySelector('#reload_capt_btn');
      if (btn) btn.click();
      else {
        const img = document.querySelector('#capt_img');
        if (img) img.src = `/common/chsignup/chsignup.php?${Date.now()}`;
      }
    });
  }
  await sleep(1400);
}

/**
 * 다중 투표 + 이미지 변형 + 합의 검증 OCR
 * @returns {{ answer: string, confidence: number, votes: object[] }}
 */
async function ocrCaptchaConsensus(apiKey, inputBuf, sendLog, level = 0) {
  const voteCount = 5 + level * 2; // 5,7,9...
  const variantCount = Math.min(5, 3 + level);
  const variants = await buildImageVariants(inputBuf, variantCount);
  const prompts = level === 0 ? CAPTCHA_PROMPTS.slice(0, 2) : CAPTCHA_PROMPTS;
  const temps = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3].slice(0, voteCount);

  relay(sendLog, `OCR 강화 L${level}: 변형 ${variants.length}종 · 투표 ${voteCount}회`);

  const votes = [];
  let callIdx = 0;
  for (const variant of variants) {
    for (const prompt of prompts) {
      if (callIdx >= voteCount) break;
      const temperature = temps[callIdx] ?? 0.1;
      try {
        const raw = await callVision({
          apiKey,
          prompt,
          b64: variant.b64,
          mimeType: variant.mime,
          temperature,
        });
        const cleaned = cleanCaptchaAnswer(raw);
        relay(sendLog, `  · ${variant.label}/t${temperature}: "${raw}" → "${cleaned || '-'}"`);
        if (cleaned) votes.push(cleaned);
      } catch (e) {
        relay(sendLog, `  · OCR 실패: ${e.message}`);
      }
      callIdx += 1;
      if (callIdx >= voteCount) break;
    }
    if (callIdx >= voteCount) break;
  }

  if (!votes.length) return { answer: '', confidence: 0, ranked: [] };

  const ranked = tallyVotes(votes);
  relay(sendLog, `투표 결과: ${ranked.map((r) => `${r.answer}(${r.count})`).join(', ')}`);

  const top = ranked[0];
  const total = votes.length;
  const confidence = top.count / total;
  const second = ranked[1];
  // 합의: 최소 2표 + 과반 또는 단독 최다(3표+)
  const agreed = top.count >= 2 && (confidence >= 0.5 || top.count >= 3)
    && (!second || top.count > second.count);

  if (!agreed) {
    relay(sendLog, `합의 부족 (top=${top.answer} ${top.count}/${total}) — 재시도 필요`);
    return { answer: '', confidence, ranked, topCandidate: top.answer };
  }

  return { answer: top.answer, confidence, ranked };
}

async function solveDothomeCaptcha(page, folder, apiKey, sendLog, { maxRounds = 5 } = {}) {
  checkCancel();

  for (let round = 0; round < maxRounds; round++) {
    checkCancel();
    const level = Math.min(round, 4);
    relay(sendLog, `보안문자 인식 라운드 ${round + 1}/${maxRounds}...`);

    const { buf } = await captureCaptchaBuffer(page, folder, `captcha_r${round + 1}`);
    const result = await ocrCaptchaConsensus(apiKey, buf, sendLog, level);

    if (result.answer) {
      relay(sendLog, `✅ 보안문자 채택: ${result.answer} (신뢰도 ${(result.confidence * 100).toFixed(0)}%)`);
      await setInputValue(page, '#captcha', result.answer);
      // 입력값 재확인
      const typed = await page.$eval('#captcha', (el) => el.value).catch(() => '');
      if (typed !== result.answer) {
        await setInputValue(page, '#captcha', result.answer);
      }
      return result.answer;
    }

    // 약한 후보라도 마지막 라운드면 시도
    if (round === maxRounds - 1 && result.topCandidate) {
      relay(sendLog, `⚠ 최종 후보로 시도: ${result.topCandidate}`);
      await setInputValue(page, '#captcha', result.topCandidate);
      return result.topCandidate;
    }

    relay(sendLog, '보안문자 새로고침 후 재인식...');
    await refreshDothomeCaptcha(page);
  }

  throw new Error('보안문자 인식 실패 (합의 부족)');
}

function isCaptchaMismatchMessage(msg = '') {
  return /확인\s*단어|보안\s*문자|captcha|일치\s*하지|올바르지|잘못|다시\s*입력/i.test(msg);
}

function randomBirth1990Plus() {
  const year = 1990 + Math.floor(Math.random() * 16); // 1990~2005
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return {
    year: String(year),
    month: String(month).padStart(2, '0'),
    day: String(day).padStart(2, '0'),
  };
}

/** FTP 아이디용 — 계정 아이디와 동일 규칙, usedFtpIds 제외 */
export function generateFtpId(usedFtpIds = [], avoidIds = []) {
  const used = new Set([
    ...(usedFtpIds || []).map((x) => String(x).toLowerCase()),
    ...(avoidIds || []).map((x) => String(x).toLowerCase()),
  ]);
  return generateDothomeId([...used]);
}

async function waitForAnySelector(page, selectors, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    checkCancel();
    for (const sel of selectors) {
      const ok = await page.$(sel).then((el) => !!el).catch(() => false);
      if (ok) return sel;
    }
    await sleep(400);
  }
  return '';
}

async function loginDothome(page, { id, password }, sendLog) {
  relay(sendLog, '로그인 페이지 이동...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  checkCancel();

  await page.waitForSelector('#exampleInputID2, input[name="loginbox_id"]', { timeout: 20000 });
  await setInputValue(page, '#exampleInputID2', id);
  await setInputValue(page, '#exampleInputpw2', password);
  relay(sendLog, `로그인: ${id}`);

  await page.evaluate(() => {
    const btn = document.querySelector('#btnDothomeLogin')
      || document.querySelector('.main_dothome_login');
    if (!btn) throw new Error('로그인 버튼 없음');
    btn.click();
  });
  await sleep(4000);

  // 로그인 후 무료호스팅 안내/신청 화면 대기
  let found = await waitForAnySelector(page, ['#confirm_free', '#btnGoFree', '#ftp_id', '#staff_name'], 12000);
  if (!found) {
    for (const url of FREE_HOSTING_CANDIDATES) {
      checkCancel();
      relay(sendLog, `무료호스팅 페이지 시도: ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2500);
        found = await waitForAnySelector(page, ['#confirm_free', '#btnGoFree', 'a[href*="free"]'], 5000);
        if (found) break;
        // 신청하기 링크 클릭
        const clicked = await page.evaluate(() => {
          const a = Array.from(document.querySelectorAll('a, button')).find((el) =>
            /신청하기|무료호스팅\s*신청/.test((el.textContent || '').replace(/\s+/g, ' ')));
          if (!a) return false;
          a.click();
          return true;
        });
        if (clicked) {
          await sleep(2500);
          found = await waitForAnySelector(page, ['#confirm_free', '#btnGoFree'], 8000);
          if (found) break;
        }
      } catch { /* try next */ }
    }
  }
  if (!found) {
    relay(sendLog, `현재 URL: ${page.url()}`);
    throw new Error('무료호스팅 신청 화면을 찾지 못했습니다. (로그인 후 확인)');
  }
  relay(sendLog, '로그인 후 무료호스팅 화면 진입');
}

async function startFreeHostingApply(page, sendLog) {
  checkCancel();
  // 이미 신청 폼(#ftp_id)이면 스킵
  if (await page.$('#ftp_id')) {
    relay(sendLog, '이미 무료호스팅 신청 폼입니다');
    return;
  }

  await page.waitForSelector('#confirm_free', { timeout: 20000 });
  await page.evaluate(() => {
    const box = document.querySelector('#confirm_free');
    if (box && !box.checked) {
      box.click();
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
  relay(sendLog, '이용안내 숙지 체크');
  await sleep(500);

  await page.evaluate(() => {
    const btn = document.querySelector('#btnGoFree');
    if (!btn) throw new Error('무료호스팅 신청하기 버튼 없음');
    btn.click();
  });
  relay(sendLog, '무료호스팅 신청하기 클릭');
  await sleep(3000);
  await page.waitForSelector('#ftp_id, input[name="ftp_id"]', { timeout: 30000 });
}

async function fillFreeHostingForm(page, {
  name,
  phone,
  emailLocal,
  ftpId,
  password,
}, sendLog) {
  checkCancel();
  const emailId = String(emailLocal || '').replace(/@.*$/, '');

  // 담당자: 전화/휴대 동일, 이메일
  relay(sendLog, '담당자 정보 입력...');
  if (await page.$('#staff_email_type_opt')) {
    await page.evaluate(() => {
      const sel = document.querySelector('#staff_email_type_opt');
      if (sel) {
        sel.value = 'naver.com';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }
  if (await page.$('#staff_email_id')) {
    await setInputValue(page, '#staff_email_id', emailId);
  }
  // 전화번호 / 휴대전화
  const telPairs = [
    ['input[name="staff_tel_01"]', phone.tel1],
    ['input[name="staff_tel_02"]', phone.tel2],
    ['input[name="staff_tel_03"]', phone.tel3],
    ['input[name="staff_mobile_01"]', phone.tel1],
    ['input[name="staff_mobile_02"]', phone.tel2],
    ['input[name="staff_mobile_03"]', phone.tel3],
  ];
  for (const [sel, val] of telPairs) {
    if (await page.$(sel)) await setInputValue(page, sel, val);
  }

  // 계약자: 개인 + 이름 + 생년월일 + 주소
  relay(sendLog, '계약자 정보 입력...');
  await page.evaluate(() => {
    const person = document.querySelector('#contractor_type_person');
    if (person && !person.checked) person.click();
    const list = document.querySelector('#contractor_list');
    if (list) {
      list.value = '';
      list.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(400);
  if (await page.$('#contractor_name')) {
    await setInputValue(page, '#contractor_name', name);
  }
  const birth = randomBirth1990Plus();
  relay(sendLog, `생년월일: ${birth.year}-${birth.month}-${birth.day}`);
  if (await page.$('input[name="contractor_birth_year"]')) {
    await setInputValue(page, 'input[name="contractor_birth_year"]', birth.year);
    await setInputValue(page, 'input[name="contractor_birth_month"]', birth.month);
    await setInputValue(page, 'input[name="contractor_birth_day"]', birth.day);
  }
  const address = randomPick(RANDOM_ADDRESSES);
  relay(sendLog, `주소: ${address}`);
  if (await page.$('#contractor_address')) {
    await setInputValue(page, '#contractor_address', address);
  }

  // FTP / DB / CMS
  relay(sendLog, `FTP 아이디: ${ftpId}`);
  await setInputValue(page, '#ftp_id', ftpId);
  await sleep(300);

  const ftpDialogs = [];
  const onFtpDialog = async (dialog) => {
    const msg = dialog.message() || '';
    ftpDialogs.push(msg);
    relay(sendLog, `FTP 팝업: ${msg}`);
    try { await dialog.accept(); } catch { /* ignore */ }
  };
  page.on('dialog', onFtpDialog);
  try {
    await page.click('#btnOverlapFTPID');
    await sleep(2000);
    const last = ftpDialogs[ftpDialogs.length - 1] || '';
    if (/이미\s*사용|중복|불가|존재/.test(last)) {
      throw new Error(`FTP 아이디 중복: ${last}`);
    }
    relay(sendLog, 'FTP 중복확인 완료');
  } finally {
    page.off('dialog', onFtpDialog);
  }

  await setInputValue(page, 'input[name="ftp_pw"]', password);
  await setInputValue(page, 'input[name="db_pw"]', password);
  relay(sendLog, 'FTP/DB 비밀번호 고정값 입력');

  // CMS 미설치 — 정적 HTML만 사용할 예정이므로 그누보드 등 CMS를 선택하지 않음
  const cmsDialogs = [];
  const onCmsDialog = async (dialog) => {
    const msg = dialog.message() || '';
    cmsDialogs.push(msg);
    relay(sendLog, `CMS 팝업: ${msg}`);
    try { await dialog.accept(); } catch { /* ignore */ }
  };
  page.on('dialog', onCmsDialog);
  try {
    await page.evaluate(() => {
      const sel = document.querySelector('#option_code');
      if (!sel) return;
      // 빈 값 / "없음" / "선택" 옵션 우선
      const opts = Array.from(sel.options || []);
      const none = opts.find((o) => {
        const t = `${o.textContent || ''} ${o.value || ''}`;
        return !String(o.value || '').trim()
          || /없음|선택|미설치|직접/.test(t);
      });
      sel.value = none ? none.value : '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(800);
    if (cmsDialogs.length) {
      await sleep(400);
    }
    // CMS 설정 테이블이 보이면 숨김 (그누보드 필드 미입력)
    await page.evaluate(() => {
      const box = document.querySelector('#cms_info_table');
      if (box) box.style.display = 'none';
    }).catch(() => {});
    relay(sendLog, 'CMS: 미선택 (정적 사이트 전용)');
  } finally {
    page.off('dialog', onCmsDialog);
  }

  return { birth, address };
}

async function clickAgreeFlow(page, sendLog) {
  relay(sendLog, '약관 동의 페이지 이동...');
  await page.goto(AGREE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  checkCancel();

  const checked = await page.evaluate(() => {
    const box = document.querySelector('#allCheck')
      || document.querySelector('input[name="all_agree"]')
      || document.querySelector('.check-all-agree input[type="checkbox"]');
    if (!box) return false;
    if (!box.checked) {
      box.click();
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return !!box.checked;
  });
  relay(sendLog, checked ? '전체 동의 체크 완료' : '전체 동의 체크 실패(계속 시도)');
  await sleep(500);

  const agreeClicked = await page.evaluate(() => {
    const a = document.querySelector('a.btn-agree')
      || Array.from(document.querySelectorAll('a, button')).find((el) => /동의하기/.test(el.textContent || ''));
    if (!a) return false;
    if (typeof window.agree === 'function') {
      window.agree();
      return true;
    }
    a.click();
    return true;
  });
  if (!agreeClicked) throw new Error('동의하기 버튼을 찾지 못했습니다.');
  relay(sendLog, '동의하기 클릭');
  await sleep(2500);

  await page.waitForSelector('#ID', { timeout: 30000 });
  relay(sendLog, '회원가입 폼 진입');
}

async function fillSignupForm(page, { id, password, name, phone, emailLocal }, sendLog) {
  checkCancel();
  relay(sendLog, `아이디 입력: ${id}`);
  await setInputValue(page, '#ID', id);
  await sleep(400);

  // 중복확인
  const dialogs = [];
  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    dialogs.push(msg);
    relay(sendLog, `팝업: ${msg}`);
    try { await dialog.accept(); } catch { /* ignore */ }
  };
  page.on('dialog', onDialog);

  try {
    await page.click('#idcheck');
    await sleep(2000);
    const last = dialogs[dialogs.length - 1] || '';
    if (/이미\s*사용|중복|불가|존재/.test(last)) {
      throw new Error(`아이디 중복: ${last}`);
    }
    relay(sendLog, '중복확인 완료');

    relay(sendLog, '비밀번호 입력 (공통)');
    await setInputValue(page, '#PW', password);
    await sleep(300);
    await setInputValue(page, '#PW_CHECK', password);
    await sleep(300);

    relay(sendLog, `이름: ${name}`);
    await setInputValue(page, '#NAME', name);

    relay(sendLog, `연락처: ${phone.tel1}-${phone.tel2}-${phone.tel3}`);
    await setInputValue(page, '#TEL1', phone.tel1);
    await setInputValue(page, '#TEL2', phone.tel2);
    await setInputValue(page, '#TEL3', phone.tel3);

    // 이메일: 로컬 + naver.com
    relay(sendLog, `이메일: ${emailLocal}@naver.com`);
    await page.evaluate(() => {
      const sel = document.querySelector('#emailtype');
      if (sel) {
        sel.value = 'naver.com';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(300);
    await setInputValue(page, '#email1', emailLocal);
    // email2 가 disabled 라도 값 확인
    await page.evaluate(() => {
      const e2 = document.querySelector('#email2');
      if (e2) {
        e2.disabled = false;
        e2.value = 'naver.com';
        e2.dispatchEvent(new Event('change', { bubbles: true }));
        e2.disabled = true;
      }
    });
  } finally {
    page.off('dialog', onDialog);
  }

  return dialogs;
}

/**
 * 닷홈 무료호스팅 회원가입
 */
export async function runDothomeSignup({
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  emailLocal = '',
  naverAccount = null,
  usedIds = [],
  usedFtpIds = [],
  headless = false,
  outputRoot = '',
  sendLog = null,
} = {}) {
  cancelRequested = false;

  const local = String(emailLocal || '').trim().replace(/@.*$/, '');
  if (!local) throw new Error('네이버 이메일 아이디(앞부분)를 입력하세요.');
  if (!openaiApiKey) throw new Error('설정 탭에 OpenAI API Key가 필요합니다. (보안문자 OCR)');
  if (!yesCaptchaClientKey) {
    relay(sendLog, '⚠ YesCaptcha 키가 없습니다. reCAPTCHA는 수동/보조 모드로 진행됩니다.');
  }

  // 네이버 메일은 미리 로그인한 창만 사용 (매회 재로그인 금지)
  {
    const { getDothomeMailSessionStatus } = await import('./dothome-naver-mail-session.js');
    const mailSt = getDothomeMailSessionStatus();
    if (!mailSt.loggedIn) {
      throw new Error(
        '네이버 메일 로그인이 필요합니다. 닷홈 탭에서 「네이버 메일 로그인」을 먼저 완료하세요.',
      );
    }
    relay(sendLog, `네이버 메일 세션 사용: ${mailSt.accountId} (창 유지·재로그인 없음)`);
  }

  const id = generateDothomeId(usedIds);
  const password = FIXED_PASSWORD;
  const name = randomHangulName();
  const phone = randomPhoneParts();
  let ftpId = generateFtpId(usedFtpIds, [id]);
  const folder = path.join(outputRoot || path.join(process.cwd(), 'output'), `dothome-signup-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });

  const accountBase = () => ({
    id,
    pw: password,
    name,
    phone: `${phone.tel1}-${phone.tel2}-${phone.tel3}`,
    email: `${local}@naver.com`,
    // 무료호스팅 서브도메인·DB = FTP 아이디
    url: `http://${ftpId}.dothome.co.kr`,
    ftpId,
    ftpPw: password,
    dbPw: password,
    createdAt: new Date().toISOString(),
  });

  relay(sendLog, `═══ 닷홈 회원가입 시작 ═══`);
  relay(sendLog, `아이디: ${id}`);
  relay(sendLog, `이메일: ${local}@naver.com`);
  relay(sendLog, `모드: ${headless ? '헤드리스' : '창 표시'}`);

  const browser = await launchBrowser({
    headless: !!headless,
    args: ['--window-size=1280,900', '--window-position=80,40'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );

  const joinDialogs = [];
  const onJoinDialog = async (dialog) => {
    const msg = dialog.message() || '';
    joinDialogs.push(msg);
    relay(sendLog, `가입 팝업: ${msg}`);
    try { await dialog.accept(); } catch { /* ignore */ }
  };

  try {
    checkCancel();
    await clickAgreeFlow(page, sendLog);

    checkCancel();
    await fillSignupForm(page, {
      id,
      password,
      name,
      phone,
      emailLocal: local,
    }, sendLog);

    page.on('dialog', onJoinDialog);

    const beforeUrl = page.url();
    let captchaOk = false;
    for (let submitTry = 1; submitTry <= 4; submitTry++) {
      checkCancel();
      joinDialogs.length = 0;

      await solveDothomeCaptcha(page, folder, openaiApiKey, sendLog, { maxRounds: 5 });
      await sleep(400);

      relay(sendLog, `가입하기 클릭 (${submitTry}/4)...`);
      await page.evaluate(() => {
        const btn = document.querySelector('#btnSubmit')
          || Array.from(document.querySelectorAll('a, button')).find((el) => /가입하기/.test(el.textContent || ''));
        if (!btn) throw new Error('가입하기 버튼 없음');
        btn.click();
      });
      await sleep(3500);

      const captchaFail = joinDialogs.some((m) => isCaptchaMismatchMessage(m));
      if (captchaFail) {
        relay(sendLog, '⚠ 보안문자 불일치 — 새로고침 후 재시도');
        await refreshDothomeCaptcha(page);
        continue;
      }
      captchaOk = true;
      break;
    }

    if (!captchaOk && joinDialogs.some((m) => isCaptchaMismatchMessage(m))) {
      throw new Error(`보안문자 반복 실패: ${joinDialogs.filter(isCaptchaMismatchMessage).join(' / ')}`);
    }

    const afterUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    const popupFail = joinDialogs.some((m) => /오류|실패|불가|잘못|다시|보안문자|인증|확인\s*단어/.test(m));
    const pageFail = /오류|실패|이미\s*가입|사용할\s*수\s*없|보안문자|확인\s*단어/.test(bodyText)
      && !/가입.*완료|환영|로그인/.test(bodyText);
    const okHint = /가입.*완료|회원가입.*완료|환영합니다|무료호스팅|마이페이지|로그인/.test(bodyText)
      || (/member|join|complete|finish|welcome/i.test(afterUrl) && afterUrl !== beforeUrl);

    await page.screenshot({ path: path.join(folder, 'after_submit.png'), fullPage: true }).catch(() => {});

    if (popupFail || (pageFail && !okHint)) {
      const reason = joinDialogs.join(' / ') || '가입 실패로 보입니다. 화면을 확인하세요.';
      relay(sendLog, `⚠ ${reason}`);
      return {
        ok: false,
        error: reason,
        account: accountBase(),
        dialogs: joinDialogs,
        folder,
      };
    }

    relay(sendLog, `✅ 회원가입 완료 — 로그인·무료호스팅 신청 진행`);

    // ── 로그인 ──
    checkCancel();
    page.off('dialog', onJoinDialog);
    await loginDothome(page, { id, password }, sendLog);

    // ── 무료호스팅 신청 시작 ──
    checkCancel();
    await startFreeHostingApply(page, sendLog);

    // FTP 중복 시 재생성 최대 5회
    let hostingMeta = null;
    let ftpOk = false;
    const triedFtp = new Set([...(usedFtpIds || []), id].map((x) => String(x).toLowerCase()));
    for (let fi = 0; fi < 5; fi++) {
      checkCancel();
      if (fi > 0) {
        ftpId = generateFtpId([...triedFtp]);
        relay(sendLog, `FTP 아이디 재생성: ${ftpId}`);
      }
      triedFtp.add(ftpId.toLowerCase());
      try {
        hostingMeta = await fillFreeHostingForm(page, {
          name,
          phone,
          emailLocal: local,
          ftpId,
          password,
        }, sendLog);
        ftpOk = true;
        break;
      } catch (e) {
        if (/FTP 아이디 중복/.test(e.message)) {
          relay(sendLog, e.message);
          continue;
        }
        throw e;
      }
    }
    if (!ftpOk) throw new Error('FTP 아이디 중복을 피하지 못했습니다.');

    // 확인 단어 OCR + 재시도
    page.on('dialog', onJoinDialog);
    let hostingCaptchaOk = false;
    for (let t = 1; t <= 4; t++) {
      checkCancel();
      joinDialogs.length = 0;
      await solveDothomeCaptcha(page, folder, openaiApiKey, sendLog, { maxRounds: 5 });
      await sleep(400);

      // 이메일 인증코드 발송
      relay(sendLog, `인증코드 발송 클릭 (${t}/4)...`);
      const sendClicked = await page.evaluate(() => {
        const btn = document.querySelector('#btnEmailAuthSend');
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!sendClicked) throw new Error('인증코드 발송 버튼을 찾지 못했습니다.');
      await sleep(3000);

      const captchaFail = joinDialogs.some((m) => isCaptchaMismatchMessage(m));
      if (captchaFail) {
        relay(sendLog, '⚠ 확인단어 불일치 — 재시도');
        await refreshDothomeCaptcha(page);
        continue;
      }
      hostingCaptchaOk = true;
      break;
    }

    if (!hostingCaptchaOk) {
      throw new Error(`확인단어/인증발송 실패: ${joinDialogs.join(' / ') || 'unknown'}`);
    }

    // 인증코드 입력란 표시 대기
    await page.waitForSelector('#authcode', { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => {
      const row = document.querySelector('#divEmailCode');
      if (row) row.style.display = '';
    }).catch(() => {});

    // 사용정책 동의
    await page.evaluate(() => {
      const box = document.querySelector('#agree_service_terms, input.agree_service_terms');
      if (!box) throw new Error('사용정책 동의 체크박스 없음');
      if (!box.checked) {
        box.click();
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    relay(sendLog, '무료계정 사용정책 동의 체크');
    await sleep(400);

    // reCAPTCHA 먼저 (오래 걸림) — 인증코드는 통과 직후 받아 바로 신청 (만료 방지)
    relay(sendLog, 'reCAPTCHA 「로봇이 아닙니다」 클릭...');
    const captchaPassed = await passRecaptchaHumanLike(page, {
      openaiApiKey,
      yesCaptchaClientKey,
      folder,
      sendLog,
      maxRounds: 4,
      manualWaitMs: 180000,
    });
    if (!captchaPassed) {
      return {
        ok: false,
        error: 'reCAPTCHA(로봇이 아닙니다) 통과 실패 — 브라우저에서 직접 체크 후 다시 실행하세요.',
        stage: 'recaptcha_failed',
        account: {
          ...accountBase(),
          birth: hostingMeta?.birth || null,
          address: hostingMeta?.address || '',
          cms: 'none',
        },
        usedFtpId: ftpId,
      };
    }
    relay(sendLog, 'reCAPTCHA 통과 확인');

    // reCAPTCHA 직후 인증코드 재발송 → 최신 코드로 바로 신청 (만료 방지)
    relay(sendLog, '인증코드 재발송 (최신 코드 확보)...');
    joinDialogs.length = 0;
    page.off('dialog', onJoinDialog);
    page.on('dialog', onJoinDialog);
    await page.evaluate(() => {
      const btn = document.querySelector('#btnEmailAuthSend');
      if (btn) btn.click();
    });
    await sleep(3500);

    // ── 네이버 메일에서 인증코드 (방금 재발송된 메일) ──
    const naverId = naverAccount?.id || local;
    const naverPw = naverAccount?.pw || '';
    if (!naverPw) {
      throw new Error('네이버 메일 비밀번호가 없습니다. 설정 탭에 네이버 계정(아이디=이메일 앞부분)을 등록하세요.');
    }

    relay(sendLog, `네이버 메일(기존 로그인 창)에서 인증코드 조회 (제목 FTP: ${ftpId})...`);
    let authCode = await fetchDothomeAuthCodeFromNaverMail({
      naverId,
      naverPw,
      hostId: ftpId,
      openaiApiKey,
      yesCaptchaClientKey,
      sendLog,
      timeoutMs: 120000,
      preferSession: true,
    });

    await setInputValue(page, '#authcode', authCode);
    relay(sendLog, `인증코드 입력: ${authCode}`);
    await sleep(400);

    async function clickFreeSubmit() {
      joinDialogs.length = 0;
      page.off('dialog', onJoinDialog);
      page.on('dialog', onJoinDialog);
      await page.evaluate(() => {
        const btn = document.querySelector('#btnFreeSubmit');
        if (!btn) throw new Error('신청하기 버튼 없음');
        btn.click();
      });
      await sleep(5000);
    }

    const isAuthExpired = (msgs) => (msgs || []).some((m) => /인증.*만료|만료.*인증|코드.*만료|만료.*코드/i.test(m));

    relay(sendLog, '신청하기 클릭...');
    await clickFreeSubmit();
    await page.screenshot({ path: path.join(folder, 'after_free_submit.png'), fullPage: true }).catch(() => {});

    // 닷홈 "인증이 만료되었습니다" → 코드 재발송 후 1회 재시도
    if (isAuthExpired(joinDialogs)) {
      relay(sendLog, '⚠ 닷홈: 인증 만료 — 인증코드 재발송 후 재시도');
      joinDialogs.length = 0;
      await page.evaluate(() => {
        const btn = document.querySelector('#btnEmailAuthSend');
        if (btn) btn.click();
      });
      await sleep(3500);

      if (!(await passRecaptchaHumanLike(page, {
        openaiApiKey,
        yesCaptchaClientKey,
        folder,
        sendLog,
        maxRounds: 2,
        manualWaitMs: 90000,
      }))) {
        return {
          ok: false,
          error: '인증 만료 후 reCAPTCHA 재통과 실패',
          stage: 'recaptcha_failed',
          account: {
            ...accountBase(),
            birth: hostingMeta?.birth || null,
            address: hostingMeta?.address || '',
            cms: 'none',
            authCode,
          },
          usedFtpId: ftpId,
        };
      }

      authCode = await fetchDothomeAuthCodeFromNaverMail({
        naverId,
        naverPw,
        hostId: ftpId,
        openaiApiKey,
        yesCaptchaClientKey,
        sendLog,
        timeoutMs: 90000,
        preferSession: true,
      });
      await setInputValue(page, '#authcode', authCode);
      relay(sendLog, `새 인증코드 입력: ${authCode}`);
      await sleep(400);
      relay(sendLog, '신청하기 재클릭...');
      await clickFreeSubmit();
      await page.screenshot({ path: path.join(folder, 'after_free_submit_retry.png'), fullPage: true }).catch(() => {});
    }

    if (isAuthExpired(joinDialogs)) {
      return {
        ok: false,
        error: '닷홈 인증이 만료되었습니다. (reCAPTCHA·메일 조회에 시간이 너무 오래 걸림)\n다시 「닷홈 가입」을 실행해 주세요.',
        stage: 'auth_expired',
        account: {
          ...accountBase(),
          birth: hostingMeta?.birth || null,
          address: hostingMeta?.address || '',
          cms: 'none',
          authCode,
        },
        usedFtpId: ftpId,
        dialogs: joinDialogs,
        folder,
        finalUrl: page.url(),
      };
    }

    const submitFail = joinDialogs.some((m) => /오류|실패|불가|잘못|인증|captcha|로봇/i.test(m));
    const bodyAfter = await page.evaluate(() => document.body?.innerText?.slice(0, 2500) || '').catch(() => '');
    const submitOk = /신청.*완료|접수.*완료|무료호스팅.*완료|마이닷홈|서비스\s*신청이/.test(bodyAfter)
      || (!submitFail && !/인증코드|로봇이 아닙니다|확인\s*단어/.test(bodyAfter));

    if (submitFail) {
      return {
        ok: false,
        error: joinDialogs.join(' / ') || '신청 실패',
        stage: 'submit_failed',
        account: {
          ...accountBase(),
          birth: hostingMeta?.birth || null,
          address: hostingMeta?.address || '',
          cms: 'none',
          authCode,
        },
        usedFtpId: ftpId,
        dialogs: joinDialogs,
        folder,
        finalUrl: page.url(),
      };
    }

    relay(sendLog, submitOk
      ? '✅ 무료호스팅 신청 완료'
      : '✅ 신청하기 클릭 완료 — 화면에서 최종 결과 확인');

    return {
      ok: true,
      stage: 'free_hosting_submitted',
      account: {
        ...accountBase(),
        birth: hostingMeta?.birth || null,
        address: hostingMeta?.address || '',
        cms: 'none',
        authCode,
      },
      usedFtpId: ftpId,
      dialogs: joinDialogs,
      folder,
      finalUrl: page.url(),
    };
  } finally {
    page.off('dialog', onJoinDialog);
    if (!headless) {
      relay(sendLog, '브라우저 15초 후 종료...');
      await sleep(15000);
    }
    await browser.close().catch(() => {});
  }
}

export { FIXED_PASSWORD };
