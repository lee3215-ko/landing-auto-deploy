/** 서치어드바이저 보드: 소유확인 진행 링크 유무 분기 + HTML태그 소유확인(캡챠) */
import {
  solveCaptcha,
  refreshCaptchaImage,
  detectCaptcha,
  isPlausibleCaptchaCode,
} from './captcha-solver.js';
import { log as sharedLog } from './logger.js';

const BOARD = 'https://searchadvisor.naver.com/console/board';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function relay(sendLog, msg) {
  sharedLog(`[NAVER-OWN] ${msg}`);
  if (sendLog) sendLog(msg);
}

export function normalizeAdvisorSiteUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/i.test(u.protocol)) return String(raw || '').trim();
    u.hash = '';
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    return String(raw || '').trim();
  }
}

export function toBoardHostUrl(siteUrl) {
  try {
    const u = new URL(String(siteUrl || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(siteUrl || '').trim().replace(/\/+$/, '');
  }
}

function buildVerifyUrl(siteUrl) {
  return `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(siteUrl)}`;
}

function buildSummaryUrl(siteUrl) {
  return `https://searchadvisor.naver.com/console/site/summary?site=${encodeURIComponent(siteUrl)}`;
}

async function hasVerifyPageUi(page) {
  return page.evaluate(() => {
    const url = location.href || '';
    if (/\/console\/board/i.test(url) && !/verify/i.test(url)) {
      const body = document.body?.innerText || '';
      if (/사이트\s*목록|최대\s*100개\s*사이트/i.test(body)
        && !document.querySelector('input[type="radio"][value="meta"]')) {
        return false;
      }
    }
    if (document.querySelector('input[type="radio"][value="meta"]')) return true;
    for (const lbl of document.querySelectorAll('label')) {
      if (/HTML\s*태그/i.test(lbl.textContent || '')) return true;
    }
    const text = document.body?.innerText || '';
    if (/naver-site-verification/i.test(text)) return true;
    if (/HTML\s*태그/.test(text) && /소유\s*확인/.test(text) && !/사이트\s*목록/.test(text)) return true;
    return false;
  }).catch(() => false);
}

/** 사이트 목록「검색」입력란 마킹 */
async function waitForBoardSearchInput(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (/nid\.naver\.com/i.test(page.url())) {
      await sleep(1500);
      continue;
    }
    const marked = await page.evaluate(() => {
      document.querySelectorAll('[data-nrc-board-search]').forEach((el) => {
        el.removeAttribute('data-nrc-board-search');
      });

      const isRegisterField = (el) => {
        const id = el.id || '';
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        const labelText = (label?.textContent || '').replace(/\s+/g, ' ').trim();
        const ph = (el.placeholder || '').trim();
        const meta = `${labelText} ${ph} ${el.className || ''}`;
        if (/이곳에\s*URL|example\.com|URL을\s*입력/i.test(meta)) return true;
        if (/등록/.test(meta) && /URL|http/i.test(meta)) return true;
        return false;
      };

      const isSearchField = (el) => {
        if (isRegisterField(el)) return false;
        const id = el.id || '';
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        const labelText = (label?.textContent || '').replace(/\s+/g, ' ').trim();
        const ph = (el.placeholder || '').trim();
        if (labelText === '검색' || /^검색$/.test(labelText)) return true;
        if (ph === '검색') return true;
        let p = el.parentElement;
        for (let i = 0; i < 10 && p; i++, p = p.parentElement) {
          const t = (p.innerText || '').slice(0, 80);
          if (/사이트\s*목록/.test(t) && /검색/.test(labelText || ph || t)) {
            if (/삭제/.test(t)) return true;
          }
        }
        return false;
      };

      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"], input[type="search"], input:not([type])',
      ));
      let best = null;
      let bestScore = -1;
      for (const el of inputs) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 10) continue;
        if (el.disabled || el.readOnly) continue;
        if (isRegisterField(el)) continue;
        if (!isSearchField(el)) continue;
        let score = r.width + (r.top > 200 ? 500 : 0);
        const id = el.id || '';
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        const labelText = (label?.textContent || '').trim();
        if (labelText === '검색') score += 2000;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (!best) return false;
      best.setAttribute('data-nrc-board-search', '1');
      return true;
    }).catch(() => false);
    if (marked) return true;
    await sleep(250);
  }
  return false;
}

async function typeBoardSearch(page, url) {
  const value = toBoardHostUrl(url);
  const typed = await page.evaluate((v) => {
    const el = document.querySelector('[data-nrc-board-search="1"]');
    if (!el) return false;
    el.focus();
    el.click();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value);
  if (!typed) {
    const input = await page.$('[data-nrc-board-search="1"]');
    if (input) {
      await input.click({ clickCount: 3 });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await input.type(value, { delay: 12 });
    }
  }
}

async function hasOwnershipProgressLink(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('a.api_link, a, button, span')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/소유\s*확인\s*진행/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      if (el.getAttribute('aria-disabled') === 'true' || el.disabled) continue;
      if (el.classList.contains('v-btn--disabled') || el.classList.contains('disabled')) continue;
      return true;
    }
    return false;
  }).catch(() => false);
}

async function clickOwnershipProgressLink(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('a.api_link, a, button, span')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/소유\s*확인\s*진행/.test(t)) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return t.substring(0, 40);
      }
    }
    return '';
  }).catch(() => '');
}

async function openSiteManagement(page, siteUrl, { preferClick = false, sendLog = null } = {}) {
  const normalized = normalizeAdvisorSiteUrl(siteUrl);
  const host = (() => {
    try { return new URL(normalized).host; } catch { return normalized; }
  })();

  if (preferClick) {
    const clicked = await page.evaluate((h) => {
      const links = Array.from(document.querySelectorAll('a[href], td a, .v-data-table a'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const t = (a.textContent || '').trim();
        if (t.includes(h) || href.includes(h) || href.includes(encodeURIComponent(h))) {
          if (/소유\s*확인/.test(t)) continue;
          a.click();
          return t.substring(0, 60) || href.substring(0, 60);
        }
      }
      return '';
    }, host).catch(() => '');
    if (clicked) {
      relay(sendLog, `사이트 관리 링크 클릭: ${clicked}`);
      await sleep(2000);
      const url = page.url() || '';
      if (/\/console\/site\//i.test(url) || !/verify/i.test(url)) return true;
    }
  }

  const summary = buildSummaryUrl(normalized);
  relay(sendLog, `사이트 관리 이동: ${summary}`);
  try {
    await page.goto(summary, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    return true;
  } catch (e) {
    relay(sendLog, `⚠ 사이트 관리 이동 실패: ${e.message}`);
    return false;
  }
}

async function selectHtmlMetaMethod(page, sendLog) {
  const how = await page.evaluate(() => {
    const radio = document.querySelector('input[type="radio"][value="meta"]');
    if (radio) { radio.click(); return 'radio[value=meta]'; }
    for (const lbl of document.querySelectorAll('label')) {
      if (/HTML\s*태그/i.test(lbl.textContent || '')) {
        const forId = lbl.getAttribute('for');
        const inp = forId
          ? document.getElementById(forId)
          : lbl.querySelector('input[type="radio"]');
        if (inp) { inp.click(); return 'label'; }
        lbl.click();
        return 'label-click';
      }
    }
    return '';
  }).catch(() => '');
  if (how) relay(sendLog, `HTML 태그 선택: ${how}`);
  await sleep(1500);
  for (let i = 0; i < 8; i++) {
    const ready = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      return /naver-site-verification/i.test(t)
        || !!document.querySelector('meta[name="naver-site-verification"]')
        || Array.from(document.querySelectorAll('code, pre, textarea')).some((el) =>
          /naver-site-verification|content=/i.test(el.textContent || el.value || ''));
    }).catch(() => false);
    if (ready) break;
    await sleep(700);
  }
}

async function clickOwnershipConfirmButton(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(
      'button, a, div[role="button"], .v-btn',
    ));
    const scored = [];
    for (const el of buttons) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^소유\s*확인$/.test(t) && t !== '소유확인') continue;
      if (/진행|취소/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      scored.push({ el, t, y: r.top });
    }
    scored.sort((a, b) => b.y - a.y);
    if (!scored.length) return '';
    scored[0].el.scrollIntoView({ block: 'center' });
    scored[0].el.click();
    return scored[0].t;
  }).catch(() => '');
}

/**
 * HTML 태그 선택 → 소유확인 클릭 → 캡챠 OCR 해결
 */
export async function completeHtmlTagOwnership(page, {
  openaiApiKey = '',
  outputFolder = './output',
  sendLog = null,
} = {}) {
  let lastDialogMsg = '';
  const onDialog = async (dialog) => {
    lastDialogMsg = dialog.message() || '';
    relay(sendLog, `🔔 팝업: "${lastDialogMsg.substring(0, 80)}"`);
    try {
      if (/삭제\s*하시겠습니까/i.test(lastDialogMsg)) await dialog.dismiss();
      else await dialog.accept();
    } catch { /* ignore */ }
  };
  page.on('dialog', onDialog);

  try {
    await selectHtmlMetaMethod(page, sendLog);
    await sleep(600);

    const clicked = await clickOwnershipConfirmButton(page);
    if (clicked) relay(sendLog, `소유확인 버튼 클릭: ${clicked}`);
    else {
      relay(sendLog, '⚠ 소유확인 버튼 없음');
      return { ok: false, reason: 'no_confirm_button' };
    }
    await sleep(2000);

    const alreadyOwned = () =>
      /완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/i.test(lastDialogMsg || '');

    let captchaSuccess = false;
    const markOk = (why) => {
      captchaSuccess = true;
      relay(sendLog, `✅ 소유확인 성공! (${why})`);
    };

    const maxAttempts = 6;
    for (let captchaAttempts = 0; captchaAttempts < maxAttempts; captchaAttempts++) {
      if (alreadyOwned()) {
        markOk('팝업');
        break;
      }
      try {
        const u = page.url();
        if (/\/console\/site\/(summary|request|option)/i.test(u)) {
          markOk(`페이지 이동: ${u}`);
          break;
        }
      } catch { /* ignore */ }

      const hasCaptcha = await detectCaptcha(page);
      if (!hasCaptcha) {
        await sleep(1500);
        if (alreadyOwned() || /\/console\/site\//i.test(page.url())) {
          markOk('캡챠 없음');
        } else {
          relay(sendLog, '캡챠 없음 — 소유확인 결과 대기');
          await sleep(2500);
          if (alreadyOwned() || /\/console\/site\//i.test(page.url())) markOk('재확인');
          else markOk('캡챠 없이 종료');
        }
        break;
      }

      const attemptLevel = captchaAttempts;
      relay(sendLog, `캡챠 감지 (시도 ${captchaAttempts + 1}/${maxAttempts}, OCR 단계 ${attemptLevel})`);
      if (!openaiApiKey) {
        relay(sendLog, '⚠ OpenAI API 키 없음 — 캡챠 자동 해결 불가');
        return { ok: false, reason: 'no_openai_key' };
      }

      const captchaResult = await solveCaptcha(page, outputFolder, openaiApiKey, { attemptLevel });
      if (alreadyOwned()) {
        markOk('OCR 중 완료 팝업');
        break;
      }

      const candidates = (captchaResult?.alternatives?.length
        ? captchaResult.alternatives
        : [captchaResult?.answer])
        .filter(Boolean)
        .filter((a) => isPlausibleCaptchaCode(a, false));

      if (!candidates.length) {
        relay(sendLog, '캡챠 OCR 실패 — 새로고침 후 재시도');
        await refreshCaptchaImage(page);
        await sleep(1500);
        continue;
      }

      let roundSuccess = false;
      for (let ci = 0; ci < candidates.length && !roundSuccess; ci++) {
        if (alreadyOwned()) {
          markOk('후보 입력 전 완료');
          roundSuccess = true;
          break;
        }
        const answer = candidates[ci];
        if (ci > 0) relay(sendLog, `대안 답변 시도: "${answer}"`);

        const allFrames = [page, ...page.frames()];
        const targetFrame = allFrames[captchaResult?.frameIndex || 0] || page;
        const targetInputId = captchaResult?.inputId || '';
        const inputSelector = captchaResult?.inputSelector || '';

        await targetFrame.evaluate((id, sel, ans) => {
          function findInput() {
            let inp = id ? document.getElementById(id) : null;
            if (!inp && sel) { try { inp = document.querySelector(sel); } catch { /* */ } }
            if (!inp) {
              const sels = [
                'input#captcha', 'input[name="captcha"]', 'input[data-detect="code"]',
                'input[placeholder*="정답"]', 'input[placeholder*="보안"]',
                '.captcha_wrap input[type="text"]', '[class*="captcha"] input[type="text"]',
              ];
              for (const s of sels) {
                try {
                  const el = document.querySelector(s);
                  if (el) { inp = el; break; }
                } catch { /* */ }
              }
            }
            if (!inp) {
              const dialog = document.querySelector('[role="dialog"], .v-dialog, .modal, .ly_pop');
              if (dialog) {
                const di = dialog.querySelector('input[type="text"],input:not([type])');
                if (di && di.type !== 'password' && di.type !== 'hidden') inp = di;
              }
            }
            return inp;
          }
          function findConfirm(inp) {
            let container = inp;
            while (container && container !== document.body) {
              if (container.matches?.('[role="dialog"], .v-dialog, .modal, .ly_pop')) break;
              container = container.parentElement;
            }
            const scope = container || document.body;
            for (const btn of scope.querySelectorAll('button, a, input[type="submit"]')) {
              const txt = (btn.textContent || btn.value || '').trim();
              if (/^(확\s*인|확인)$/.test(txt)) return btn;
            }
            return null;
          }
          const inp = findInput();
          if (!inp) return false;
          inp.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(inp, ans);
          else inp.value = ans;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          const btn = findConfirm(inp);
          if (btn) btn.click();
          return true;
        }, targetInputId, inputSelector, answer).catch(() => false);

        await sleep(3500);
        const msg = lastDialogMsg || '';
        const currentUrl = page.url() || '';

        if (/완료되었습니다|소유\s*확인이\s*완료/i.test(msg) || alreadyOwned()) {
          markOk('캡챠 제출 후 완료');
          roundSuccess = true;
          break;
        }
        if (/\/console\/site\//i.test(currentUrl)) {
          markOk(`콘솔 이동: ${currentUrl}`);
          roundSuccess = true;
          break;
        }
        if (/실패|보안절차|자동등록|잘못\s*입력/.test(msg)) {
          relay(sendLog, '캡챠/검증 실패 — 다음 후보');
          continue;
        }
      }

      if (captchaSuccess) break;
      if (alreadyOwned()) {
        markOk('라운드 종료');
        break;
      }
      relay(sendLog, '캡챠 새로고침 후 재시도');
      await refreshCaptchaImage(page);
      await sleep(1500);
      await clickOwnershipConfirmButton(page);
      await sleep(2000);
    }

    const finalUrl = (() => { try { return page.url(); } catch { return ''; } })();
    if (captchaSuccess || alreadyOwned() || /\/console\/site\//i.test(finalUrl)) {
      return { ok: true, url: finalUrl };
    }
    return { ok: false, reason: 'ownership_unconfirmed', url: finalUrl };
  } finally {
    try { page.off('dialog', onDialog); } catch { /* ignore */ }
  }
}

/**
 * 보드 검색 → 소유확인 진행 있으면 자동 소유확인, 없으면 사이트 관리로.
 * @returns {{ ok: boolean, owned: boolean, neededVerify: boolean, message: string }}
 */
export async function confirmOwnershipViaBoard(page, siteUrl, {
  openaiApiKey = '',
  outputFolder = './output',
  sendLog = null,
} = {}) {
  const normalized = normalizeAdvisorSiteUrl(siteUrl);
  const hostUrl = toBoardHostUrl(normalized);
  relay(sendLog, `소유확인 분기: ${normalized}`);

  relay(sendLog, '컨트롤보드 이동...');
  await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(800);

  if (!(await waitForBoardSearchInput(page, 10000))) {
    relay(sendLog, '⚠ 사이트 목록 검색창 없음 — 사이트 관리로 이동');
    const ok = await openSiteManagement(page, normalized, { sendLog });
    return {
      ok,
      owned: true,
      neededVerify: false,
      message: ok ? '검색창 없음 → 사이트 관리' : '사이트 관리 실패',
    };
  }

  await typeBoardSearch(page, hostUrl);
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(900);

  if (await hasOwnershipProgressLink(page)) {
    const progress = await clickOwnershipProgressLink(page);
    relay(sendLog, `소유확인 진행 클릭: ${progress || '소유확인 진행'}`);
    await sleep(1500);

    if (!(await hasVerifyPageUi(page)) && !/\/console\/verify/i.test(page.url() || '')) {
      await sleep(800);
    }
    if (!(await hasVerifyPageUi(page)) && !/\/console\/verify/i.test(page.url() || '')) {
      relay(sendLog, '소유확인 화면 미진입 — verify 직접 이동');
      await page.goto(buildVerifyUrl(normalized), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }

    if (!(await hasVerifyPageUi(page))) {
      relay(sendLog, '⚠ 소유확인 UI 없음 — 사이트 관리로 진행');
      const ok = await openSiteManagement(page, normalized, { sendLog });
      return {
        ok,
        owned: false,
        neededVerify: true,
        message: '소유확인 UI 없음',
      };
    }

    const result = await completeHtmlTagOwnership(page, {
      openaiApiKey,
      outputFolder,
      sendLog,
    });
    if (!result.ok) {
      relay(sendLog, `⚠ 자동 소유확인 미완료 (${result.reason || 'unknown'}) — 수집은 계속 시도`);
    }
    // 수집을 위해 사이트 콘솔로
    await openSiteManagement(page, normalized, { sendLog });
    return {
      ok: !!result.ok,
      owned: !!result.ok,
      neededVerify: true,
      message: result.ok ? '소유확인 완료' : `소유확인 미완료: ${result.reason || ''}`,
    };
  }

  relay(sendLog, '「소유확인 진행」 없음 — 사이트 관리로 바로 진행');
  const ok = await openSiteManagement(page, normalized, { preferClick: true, sendLog });
  return {
    ok,
    owned: true,
    neededVerify: false,
    message: ok ? '이미 소유확인됨 → 사이트 관리' : '사이트 관리 진입 실패',
  };
}
