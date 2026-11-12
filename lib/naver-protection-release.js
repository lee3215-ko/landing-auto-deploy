/**
 * 네이버 보호조치를 이메일(아이디@susupo.app)로 해제한다.
 * 이메일 칸이 없으면 no-email. 비밀번호는 이 프로그램 시트 C열에 기록한다.
 */
import crypto from 'crypto';
import { SusupoMailbox } from './susupo-mailbox.js';
import { writeAccountPasswordOnSheet } from './naver-account-sheet.js';
import { detectCaptcha, solveCaptcha } from './captcha-solver.js';

const EMAIL_DOMAIN = 'susupo.app';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function newPassword() {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const all = lower + upper + digits;
  const chars = [
    lower[crypto.randomInt(lower.length)],
    upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
  ];
  while (chars.length < 12) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function bodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || '');
  } catch {
    return '';
  }
}

async function hasVisibleId(page, id) {
  try {
    return await page.evaluate((elementId) => {
      const el = document.getElementById(elementId);
      if (!el) return false;
      const rect = el.getClientRects();
      return !!(el.offsetWidth || el.offsetHeight || rect.length);
    }, id);
  } catch {
    return false;
  }
}

async function clickText(page, labels) {
  try {
    return await page.evaluate((needles) => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const nodes = [...document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button]')];
      for (const needle of needles) {
        for (const el of nodes) {
          if (!visible(el)) continue;
          const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 40) continue;
          if (text === needle || text.includes(needle)) {
            el.click();
            return text;
          }
        }
      }
      return '';
    }, labels);
  } catch {
    return '';
  }
}

async function fillById(page, id, value) {
  try {
    return await page.evaluate((elementId, next) => {
      const el = document.getElementById(elementId);
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, id, value);
  } catch {
    return false;
  }
}

async function emailUnlockAvailable(page) {
  if (await hasVisibleId(page, 'r_email')) return true;
  if (await hasVisibleId(page, 'email')) return true;
  if (await hasVisibleId(page, 'd_email')) return true;
  const text = await bodyText(page);
  if (/본인 명의 휴대폰/.test(text) && !/이메일 인증|이메일로 인증|본인확인 이메일/.test(text)) return false;
  return /이메일 인증|이메일로 인증|본인확인 이메일/.test(text);
}

async function openReleaseForm(page, log) {
  if (await hasVisibleId(page, 'r_email') || await hasVisibleId(page, 'email') || await hasVisibleId(page, 'newPw')) {
    return true;
  }
  const clicked = await page.evaluate(() => {
    const link = document.querySelector('.detect_clear a');
    if (link) {
      link.click();
      return true;
    }
    return false;
  }).catch(() => false) || await clickText(page, ['보호조치 해제', '보호조치해제']);
  if (clicked) log('보호조치 해제를 눌렀습니다.');
  for (let i = 0; i < 15; i += 1) {
    if (await hasVisibleId(page, 'r_email') || await hasVisibleId(page, 'email') || await hasVisibleId(page, 'newPw')) {
      return true;
    }
    const text = await bodyText(page);
    if (/본인 명의 휴대폰/.test(text) && !/이메일/.test(text)) return true;
    await sleep(700);
  }
  return false;
}

async function chooseEmail(page, log) {
  if (await hasVisibleId(page, 'newPw')) return true;
  await page.evaluate(() => {
    const radio = document.getElementById('r_email');
    if (radio) {
      radio.checked = true;
      radio.click();
      if (window.toggleMethod) window.toggleMethod('email');
    }
    const box = document.getElementById('d_email');
    if (box) box.style.display = 'block';
  }).catch(() => {});
  for (let i = 0; i < 10; i += 1) {
    if (await hasVisibleId(page, 'email') || await hasVisibleId(page, 'newPw')) {
      log('본인확인 이메일로 인증을 선택했습니다.');
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function solveReleaseCaptcha(page, log, openaiApiKey, yesCaptchaClientKey, outputFolder) {
  if (!(await detectCaptcha(page))) return true;
  log('보호조치 보안문자를 풉니다.');
  const solved = await solveCaptcha(page, outputFolder || './output', openaiApiKey || '', {
    yesCaptchaClientKey,
    context: 'protection-release',
  });
  const answer = typeof solved === 'string' ? solved : solved?.answer;
  if (!answer) return false;
  const inputId = typeof solved === 'object' ? solved.inputId : '';
  const typed = await page.evaluate((id, ans) => {
    const el = (id && document.getElementById(id))
      || document.querySelector('input#captcha, input[name="captcha"], input[placeholder*="보안"], input[placeholder*="정답"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, ans);
    else el.value = ans;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, inputId || '', answer);
  return typed;
}

async function changePassword(page, log, openaiApiKey, yesCaptchaClientKey, outputFolder) {
  let password = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const text = await bodyText(page);
    if (password && /나중에 하기/.test(text)) return password;
    if (!password) password = newPassword();
    const filled = await fillById(page, 'newPw', password) && await fillById(page, 'newPwConfirm', password);
    if (!filled) return '';
    log('새 비밀번호를 입력했습니다.');
    const rejected = await page.evaluate(() => {
      const el = document.getElementById('e_newPw');
      return el ? (el.innerText || '') : '';
    }).catch(() => '');
    if (/사용불가|재작성|8자/.test(rejected)) {
      password = '';
      continue;
    }
    const captchaOk = await solveReleaseCaptcha(page, log, openaiApiKey, yesCaptchaClientKey, outputFolder);
    if (!captchaOk) continue;
    await fillById(page, 'newPw', password);
    await fillById(page, 'newPwConfirm', password);
    await clickText(page, ['확인', '변경']);
    await sleep(1500);
    if (/나중에 하기/.test(await bodyText(page)) || await hasVisibleId(page, 'svi.later')) return password;
  }
  return /나중에 하기/.test(await bodyText(page)) ? password : '';
}

export async function releaseProtectionByEmail(page, {
  naverId,
  name = '',
  sheetRow = 0,
  log = () => {},
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  outputFolder = './output',
} = {}) {
  const id = String(naverId || '').trim();
  const email = `${id}@${EMAIL_DOMAIN}`;
  log('보호조치 화면 — 이메일 해제를 진행합니다.');
  const opened = await openReleaseForm(page, log);
  if (!opened) {
    return { ok: false, reason: 'no-form', message: '보호조치 해제 화면으로 넘어가지 못했습니다.' };
  }
  if (!(await emailUnlockAvailable(page))) {
    return { ok: false, reason: 'no-email', message: '이메일로 보호조치 해제 할수 없음' };
  }
  if (!(await chooseEmail(page, log))) {
    return { ok: false, reason: 'no-email', message: '이메일로 보호조치 해제 할수 없음' };
  }
  if (name && !(await fillById(page, 'nm2', name))) {
    return { ok: false, reason: 'form', message: '이름을 입력하지 못했습니다.' };
  }
  if (!(await fillById(page, 'email', email))) {
    return { ok: false, reason: 'no-email', message: '이메일로 보호조치 해제 할수 없음' };
  }
  const sentTo = await page.evaluate(() => {
    const el = document.getElementById('email');
    return String(el?.value || '').trim();
  }).catch(() => email);
  const mailboxAddress = /@/.test(sentTo) ? sentTo : email;
  log(`이름과 이메일을 입력했습니다. ${mailboxAddress}`);
  const requestedAt = Date.now();
  const asked = await page.evaluate(() => {
    const btn = document.getElementById('btnEmailAuthNo');
    if (!btn) return false;
    btn.click();
    return true;
  }).catch(() => false);
  if (!asked) return { ok: false, reason: 'form', message: '인증 버튼을 누르지 못했습니다.' };
  log(`인증 메일을 요청했습니다. ${mailboxAddress}`);
  let code = '';
  try {
    const box = new SusupoMailbox();
    code = await box.waitForCode(mailboxAddress, requestedAt - 20000, 90000, log);
  } catch (e) {
    return { ok: false, reason: 'mailbox', message: e?.message || '메일함 연결 실패' };
  }
  if (!code) return { ok: false, reason: 'no-code', message: `${mailboxAddress} 로 인증번호가 오지 않았습니다.` };
  if (!(await fillById(page, 'authNo', code))) {
    return { ok: false, reason: 'form', message: '인증번호 칸을 찾지 못했습니다.' };
  }
  log('인증번호를 입력했습니다.');
  await clickText(page, ['확인']);
  await page.evaluate(() => {
    document.querySelector('a.btn_certify_submit')?.click();
  }).catch(() => {});
  let ready = false;
  for (let i = 0; i < 20; i += 1) {
    if (await hasVisibleId(page, 'newPw') || /나중에 하기/.test(await bodyText(page))) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) return { ok: false, reason: 'form', message: '비밀번호 변경 화면이 뜨지 않았습니다.' };
  const password = await changePassword(page, log, openaiApiKey, yesCaptchaClientKey, outputFolder);
  if (!password) return { ok: false, reason: 'password', message: '새 비밀번호를 끝내지 못했습니다.' };
  try {
    await writeAccountPasswordOnSheet(page, { sheetRow, naverId: id, password, log });
  } catch (e) {
    log(`시트 반영 실패: ${e?.message || e}`);
  }
  const later = await page.evaluate(() => {
    const el = document.getElementById('svi.later');
    if (el) {
      el.click();
      return true;
    }
    return false;
  }).catch(() => false) || await clickText(page, ['나중에 하기']);
  if (later) log('나중에 하기를 눌렀습니다.');
  return { ok: true, reason: 'released', password };
}
