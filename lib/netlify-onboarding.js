const SIGNUP_QUESTIONS_URL = /signup-questions/i;

/** Netlify signup-questions 라디오 그룹 (순서대로 잠금 해제됨) */
const RADIO_GROUPS = [
  { name: 'useCaseContext', values: ['personal', 'work', 'client', 'school'] },
  { name: 'webExperience', values: ['new', 'beginner', 'intermediate', 'advanced'] },
  { name: 'useCase', values: ['marketing_or_company_site', 'blog', 'saas_app', 'prototype', 'other'] },
  { name: 'jobRole', values: ['junior_web_developer', 'other', 'senior_web_developer'] },
  { name: 'referralSource', values: ['search', 'other', 'social', 'coworker'] },
];

const TEXT_FIELDS = [
  { name: 'firstName', random: () => randomFirstName() },
  { name: 'lastName', random: () => randomLastName() },
  { name: 'companyName', random: () => randomCompanyName() },
  { name: 'teamName', random: () => randomCompanyName() },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomLetters(min = 4, max = 8) {
  const len = min + Math.floor(Math.random() * (max - min + 1));
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function randomFirstName() {
  return randomLetters(4, 7);
}

export function randomLastName() {
  return randomLetters(5, 9);
}

export function randomCompanyName() {
  return `${randomLetters(5, 8)} ${randomLetters(4, 6)}`;
}

export function randomTokenDescription() {
  return `${randomLetters(3, 5).toLowerCase()}${Math.floor(Math.random() * 900 + 100)}`;
}

export async function detectNetlifyScreen(page) {
  const url = page.url();

  // URL 우선 (페이지 로딩 중에도 인식)
  if (SIGNUP_QUESTIONS_URL.test(url)) return 'signup_questions';
  if (/\/user\/applications/i.test(url)) return 'token_settings';
  if (url.includes('app.netlify.com') && !url.includes('/login') && !url.includes('/signup')) {
    return 'dashboard';
  }

  const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

  if (/check your email/i.test(body)) return 'check_email';
  if (/verify your email|you.re nearly there/i.test(body)) return 'verify_email';
  if (SIGNUP_QUESTIONS_URL.test(url) || /your email is now verified|nice to meet you/i.test(body)) {
    return 'signup_questions';
  }
  if (/continue to deploy/i.test(body) || /how did you hear about us/i.test(body)) {
    return 'onboarding_survey';
  }
  if (/skip this step/i.test(body)) return 'deploy_intro';
  if (url.includes('/user/applications')) return 'token_settings';
  if (url.includes('app.netlify.com') && !url.includes('/login') && !url.includes('/signup')) {
    return 'dashboard';
  }
  return 'unknown';
}

async function fillAllTextFields(page, sendLog) {
  const values = TEXT_FIELDS.map((f) => ({ name: f.name, val: f.random() }));
  const filled = await page.evaluate((pairs) => {
    let count = 0;
    const fill = (name, val) => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (!el || (el.value || '').trim()) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      count += 1;
    };
    for (const { name, val } of pairs) fill(name, val);
    return count;
  }, values);

  if (filled > 0) {
    const names = values.filter((v) => filled).map((v) => `${v.name}=${v.val}`).join(', ');
    sendLog?.(`텍스트 입력 (${filled}개): ${names.slice(0, 120)}`);
  }
  return filled;
}

async function selectRadioGroup(page, groupName, preferredValues, sendLog) {
  const result = await page.evaluate((name, prefs) => {
    const isEnabled = (input) => {
      let el = input;
      for (let i = 0; i < 15 && el; i++) {
        const cls = el.className;
        if (typeof cls === 'string' && cls.includes('pointer-events-none')) return false;
        el = el.parentElement;
      }
      return true;
    };

    const radios = [...document.querySelectorAll(`input[type="radio"][name="${name}"]`)];
    if (!radios.length) return { ok: false, reason: 'missing' };
    if (radios.some((r) => r.checked)) return { ok: true, reason: 'already', value: radios.find((r) => r.checked)?.value };

    const enabled = radios.filter(isEnabled);
    if (!enabled.length) return { ok: false, reason: 'locked' };

    let pick = enabled.find((r) => prefs.includes(r.value)) || enabled[0];
    const label = pick.closest('label');
    if (label) {
      label.scrollIntoView({ block: 'center', behavior: 'instant' });
      const span = label.querySelector('span.tw-inline-block') || label.querySelector('span');
      (span || label).click();
      return { ok: true, value: pick.value, method: 'label' };
    }
    pick.click();
    pick.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: pick.value, method: 'input' };
  }, groupName, preferredValues);

  if (result.ok && result.value && result.reason !== 'already') {
    sendLog?.(`설문 선택: ${groupName} → ${result.value}`);
  }
  return result;
}

async function selectAllVisibleRadioGroups(page, sendLog) {
  let selected = 0;
  for (const group of RADIO_GROUPS) {
    const r = await selectRadioGroup(page, group.name, group.values, sendLog);
    if (r.ok && r.reason !== 'already' && r.method) {
      selected += 1;
      await sleep(700);
    }
  }
  return selected;
}

async function clickContinueToDeploy(page) {
  const res = await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      const t = (btn.textContent || '').trim();
      if (t.includes('Continue to deploy')) {
        if (btn.disabled) return { ok: false, disabled: true };
        btn.click();
        return { ok: true };
      }
    }
    return { ok: false, disabled: false };
  });
  return res;
}

async function clickByText(page, patterns, tags = 'button, a, [role="button"], [role="option"], input[type="submit"]') {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const res = await page.evaluate((pats, tagSel) => {
    const nodes = document.querySelectorAll(tagSel);
    for (const el of nodes) {
      const t = ((el.textContent || el.value || '') + '').trim();
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
  }, list, tags);
  if (res.ok) {
    await page.mouse.click(res.x, res.y);
    return true;
  }
  return false;
}

export async function clickVerifyEmailButton(page, sendLog) {
  const screen = await detectNetlifyScreen(page);
  if (screen !== 'verify_email') return false;

  sendLog?.('「Verify email」 버튼 클릭...');
  const clicked = await clickByText(page, ['Verify email', 'Verify Email']);
  if (clicked) await sleep(3000);
  return clicked;
}

export async function completeNetlifyOnboarding(page, sendLog) {
  sendLog?.('═══ Netlify 온보딩 자동 완료 ═══');

  const deadline = Date.now() + 300000;

  while (Date.now() < deadline) {
    const screen = await detectNetlifyScreen(page);

    if (screen === 'dashboard' || screen === 'token_settings') {
      sendLog?.('온보딩 완료 — 대시보드/설정 화면');
      return true;
    }

    if (screen === 'verify_email') {
      await clickVerifyEmailButton(page, sendLog);
      await sleep(2000);
      continue;
    }

    if (screen === 'signup_questions' || screen === 'onboarding_survey' || screen === 'deploy_intro') {
      await fillAllTextFields(page, sendLog);

      // 라디오 그룹을 순서대로 하나씩 선택 (잠긴 섹션은 다음 루프에서 해제됨)
      for (let round = 0; round < RADIO_GROUPS.length; round++) {
        const n = await selectAllVisibleRadioGroups(page, sendLog);
        if (n > 0) await sleep(800);
        else break;
      }

      const deployBtn = await clickContinueToDeploy(page);
      if (deployBtn.ok) {
        sendLog?.('「Continue to deploy」 클릭');
        await sleep(3000);
        continue;
      }

      if (await clickByText(page, 'Skip this step for now')) {
        sendLog?.('「Skip this step for now」 클릭');
        await sleep(3000);
        continue;
      }

      if (deployBtn.disabled) {
        sendLog?.('Continue to deploy 비활성 — 설문 항목 추가 선택 중...');
      }
    }

    await sleep(1200);
  }

  throw new Error('Netlify 온보딩 완료 시간 초과');
}

async function clickElementCenter(page, pos) {
  if (!pos) return false;
  await page.mouse.click(pos.x, pos.y);
  return true;
}

/** Netlify 좌측 하단 사이드바 프로필(이메일 표시) 클릭 */
async function openBottomProfileMenu(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const inBottomSidebar = (r) => r.top > vh * 0.5 && r.left < vw * 0.4 && r.bottom <= vh + 2;

    const emailHits = [];
    for (const el of document.querySelectorAll('button, a, [role="button"], div, span')) {
      const text = (el.textContent || '').trim();
      if (!/@\S+\.\S+/.test(text) || text.length > 180) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 28) continue;
      if (!inBottomSidebar(r)) continue;
      emailHits.push({ r, area: r.width * r.height });
    }
    emailHits.sort((a, b) => a.area - b.area);
    if (emailHits.length) {
      const { r } = emailHits[0];
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    for (const el of document.querySelectorAll('button, a, div, span')) {
      const r = el.getBoundingClientRect();
      const t = (el.textContent || '').trim();
      if (r.width >= 22 && r.width <= 56 && r.height >= 22 && r.height <= 56
        && /^[A-Z]$/.test(t) && inBottomSidebar(r)) {
        let node = el;
        for (let d = 0; d < 6 && node; d += 1) {
          const parent = node.parentElement;
          if (!parent) break;
          const pr = parent.getBoundingClientRect();
          if (pr.width > 80 && pr.height > 36 && inBottomSidebar(pr)) {
            return { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 };
          }
          node = parent;
        }
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  });
}

/** 프로필 메뉴의 Sign out (downshift menuitem danger) */
async function findSignOutButton(page) {
  return page.evaluate(() => {
    const selectors = [
      'button[role="option"].danger',
      'button.menuitem.danger',
      'button[id^="downshift-"][id*="item"]',
      '[role="option"]',
      'button.menuitem',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.textContent || '').trim();
        if (!/^sign out$/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  });
}

export async function logoutNetlify(page, sendLog) {
  sendLog?.('하단 프로필 클릭 → Sign out...');

  let signedOut = false;
  for (let attempt = 0; attempt < 3 && !signedOut; attempt += 1) {
    const profilePos = await openBottomProfileMenu(page);
    if (!profilePos) {
      sendLog?.('하단 프로필 영역을 찾지 못함');
      break;
    }

    await clickElementCenter(page, profilePos);
    await sleep(attempt === 0 ? 1000 : 1500);

    let signOutPos = await findSignOutButton(page);
    if (!signOutPos) {
      signOutPos = await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, a, [role="option"], [role="menuitem"]')) {
          const t = (el.textContent || '').trim();
          if (!/^sign out$/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      });
    }

    if (signOutPos) {
      await clickElementCenter(page, signOutPos);
      signedOut = true;
      break;
    }

    sendLog?.(`Sign out 메뉴 대기 중... (${attempt + 1}/3)`);
    await sleep(800);
  }

  if (!signedOut) {
    sendLog?.('Sign out 자동 클릭 실패 — 하단 프로필 → Sign out 을 수동으로 눌러 주세요');
    await page.goto('https://app.netlify.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    return false;
  }

  sendLog?.('✅ 로그아웃 완료');
  await sleep(2000);
  await page.goto('https://app.netlify.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(1000);
  sendLog?.('로그인 화면입니다. 다음 계정으로 로그인(또는 가입)해 주세요.');
  return true;
}
