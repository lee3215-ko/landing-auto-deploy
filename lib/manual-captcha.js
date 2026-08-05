/**
 * 배포결과 「수동캡챠」:
 * 1) 공유 네이버 세션에서 verify → HTML 태그 라디오 선택 → 소유확인(캡챠 화면)
 * 2) 사용자가 캡챠 완료할 때까지 대기
 * 3) 완료되면 빠르게 → robots → 사이트맵 → 웹페이지 수집 자동 진행
 */
import fs from 'fs';
import path from 'path';
import { normalizeAdvisorSiteUrl, escapeAdvisorOauthCallback } from './naver-register.js';
import { collectLocalSitePageUrls } from './kkang-site-builder.js';

const BOARD = 'https://searchadvisor.naver.com/console/board';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

function resolveSiteDir(row, outputRoot) {
  const candidates = [
    row?.siteDir,
    row?.folder,
    row?.outputDir,
  ].filter(Boolean).map(String);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  // output/site-xxxx 추정
  try {
    const host = new URL(normalizeAdvisorSiteUrl(row?.url || '')).hostname || '';
    const slug = host.replace(/\.netlify\.app$/i, '') || String(row?.siteSlug || '').trim();
    if (slug && outputRoot) {
      const p = path.join(outputRoot, slug);
      if (fs.existsSync(path.join(p, 'index.html'))) return p;
    }
  } catch { /* ignore */ }
  return '';
}

/** 화면 좌표로 실제 마우스 클릭 (Vue/Vuetify 라디오·버튼용) */
async function clickAt(page, x, y) {
  if (!(x > 0 && y > 0)) return false;
  try {
    await page.mouse.click(x, y, { delay: 40 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 서치어드바이저 verify UI:
 *   <div class="title black--text">HTML 태그</div>
 * 이 타이틀(또는 그 카드/라디오 부모)을 클릭해야 선택됨.
 */
async function selectHtmlMetaRadio(page, sendLog) {
  // 타이틀 등장 대기
  for (let w = 0; w < 20; w++) {
    const found = await page.evaluate(() => {
      const nodes = document.querySelectorAll('.title, .title.black--text, div.title, label, [role="radio"]');
      for (const el of nodes) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t === 'HTML 태그' || /^HTML\s*태그$/.test(t)) return true;
      }
      return /HTML\s*태그/.test(document.body?.innerText || '');
    }).catch(() => false);
    if (found) break;
    await sleep(500);
  }

  const hit = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isHtmlTitle = (el) => {
      const t = norm(el.textContent);
      // 카드 전체 텍스트가 길면 title 자식만 검사
      if (el.classList?.contains('title') || /black--text/.test(el.className || '')) {
        return t === 'HTML 태그' || /^HTML\s*태그$/.test(t);
      }
      return t === 'HTML 태그';
    };

    let titleEl = null;
    for (const el of document.querySelectorAll('.title.black--text, .title, div.title')) {
      if (isHtmlTitle(el)) { titleEl = el; break; }
    }
    if (!titleEl) {
      for (const el of document.querySelectorAll('div, span, label, p')) {
        if (norm(el.textContent) === 'HTML 태그' && el.children.length === 0) {
          titleEl = el;
          break;
        }
      }
    }
    if (!titleEl) return null;

    // 클릭 대상: 라디오/카드 조상 우선, 없으면 title 자체
    let target = titleEl;
    let cur = titleEl;
    for (let i = 0; i < 8 && cur; i++) {
      if (
        cur.matches?.('input[type="radio"], label, [role="radio"], .v-radio, .v-card, .v-list-item, .method, .verify-method')
        || (cur.classList && (
          cur.classList.contains('v-radio')
          || cur.classList.contains('v-card')
          || cur.classList.contains('v-list-item')
          || /radio|method|card|item/i.test(cur.className || '')
        ))
      ) {
        target = cur;
        break;
      }
      // 형제/자식에 radio 있으면 그 컨테이너
      if (cur.querySelector?.('input[type="radio"]')) {
        target = cur;
        break;
      }
      cur = cur.parentElement;
    }

    const radio = target.querySelector?.('input[type="radio"]')
      || titleEl.closest?.('label, .v-radio, [role="radio"]')?.querySelector?.('input[type="radio"]')
      || document.querySelector('input[type="radio"][value="meta"]');

    if (radio) {
      try {
        radio.checked = true;
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        radio.dispatchEvent(new Event('input', { bubbles: true }));
      } catch { /* ignore */ }
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    const r = target.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    return {
      how: radio ? 'title+radio' : 'title.black--text',
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      text: norm(titleEl.textContent).slice(0, 20),
    };
  }).catch(() => null);

  if (!hit) {
    relay(sendLog, '⚠ HTML 태그(title) 미감지 — 창에서 「HTML 태그」를 직접 클릭해 주세요');
    return '';
  }

  const ok = await clickAt(page, hit.x, hit.y);
  // evaluate click 백업
  if (!ok) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.title.black--text, .title')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t === 'HTML 태그' || /^HTML\s*태그$/.test(t)) {
          (el.closest('label, .v-radio, .v-card, [role="radio"]') || el).click();
          return;
        }
      }
    }).catch(() => {});
  }
  relay(sendLog, `HTML 태그 선택: ${hit.how} ("${hit.text}") @ ${Math.round(hit.x)},${Math.round(hit.y)}`);

  await sleep(1800);
  for (let i = 0; i < 12; i++) {
    const ready = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const metaReady = /naver-site-verification/i.test(t)
        || Array.from(document.querySelectorAll('code, pre, textarea')).some((el) =>
          /naver-site-verification|content=/i.test(el.textContent || el.value || ''));
      const btnReady = Array.from(document.querySelectorAll('button, a, div[role="button"], .v-btn'))
        .some((el) => {
          const s = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return s === '소유확인' || s === '소유 확인';
        });
      return metaReady || btnReady;
    }).catch(() => false);
    if (ready) break;
    await sleep(600);
  }
  return hit.how;
}

async function clickOwnershipConfirm(page) {
  const hit = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(
      'button, a, div[role="button"], .v-btn, span.v-btn__content',
    ));
    const scored = [];
    for (const el of buttons) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!(t === '소유확인' || t === '소유 확인')) continue;
      if (/진행|목록|방법|태그|취소/.test(t)) continue;
      const clickEl = el.closest('button, a, [role="button"], .v-btn') || el;
      const r = clickEl.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      scored.push({
        t,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        yTop: r.top,
      });
    }
    scored.sort((a, b) => b.yTop - a.yTop);
    return scored[0] || null;
  }).catch(() => null);

  if (!hit) return '';
  await page.evaluate((y) => {
    window.scrollTo(0, Math.max(0, y - 200));
  }, hit.y).catch(() => {});
  await sleep(200);
  // 스크롤 후 좌표 재계산
  const hit2 = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(
      'button, a, div[role="button"], .v-btn, span.v-btn__content',
    ));
    for (const el of buttons) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!(t === '소유확인' || t === '소유 확인')) continue;
      const clickEl = el.closest('button, a, [role="button"], .v-btn') || el;
      const r = clickEl.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      clickEl.scrollIntoView({ block: 'center' });
      const r2 = clickEl.getBoundingClientRect();
      return { t, x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
    }
    return null;
  }).catch(() => null);

  const target = hit2 || hit;
  await clickAt(page, target.x, target.y);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, a, .v-btn')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t === '소유확인' || t === '소유 확인') { el.click(); return; }
    }
  }).catch(() => {});
  return target.t || '소유확인';
}

async function isOwnershipDone(page, dlg) {
  if (dlg?.ownershipDone) return true;
  const msg = dlg?.lastMsg || '';
  if (/완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/i.test(msg)) return true;
  try {
    const u = page.url() || '';
    if (/\/console\/site\//i.test(u) && !/\/verify/i.test(u)) return true;
  } catch { /* ignore */ }
  const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  if (/소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/.test(body)) return true;
  return false;
}

async function hasCaptchaVisible(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    if (/보안절차|아래 이미지에 보이는 글자/.test(text)) return true;
    if (document.querySelector('.v-dialog--active img[src*="captcha"], .v-dialog--active [style*="nhncaptcha"]')) return true;
    const bg = Array.from(document.querySelectorAll('.v-image__image, div')).some((el) => {
      try {
        const bi = getComputedStyle(el).backgroundImage || '';
        return /nhncaptcha|captcha\.nid/.test(bi);
      } catch { return false; }
    });
    return bg;
  }).catch(() => false);
}

/**
 * @returns {Promise<{ok:boolean, status:string, message:string, collect?:object}>}
 */
export async function runManualCaptchaAndCollect({
  siteUrl,
  siteDir = '',
  siteSlug = '',
  naverAccount = null,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  outputRoot = '',
  sendLog = null,
  waitTimeoutMs = 10 * 60 * 1000,
} = {}) {
  const url = normalizeAdvisorSiteUrl(siteUrl);
  if (!url) throw new Error('사이트 URL이 없습니다.');

  const {
    ensureNaverSession,
    adoptSessionPage,
    openNaverSessionTab,
    peekNaverSessionPage,
    getNaverSessionBrowser,
    getNaverSessionStatus,
    waitForNaverSessionBrowser,
  } = await import('./naver-session.js');
  const { attachSafeDialogHandler } = await import('./dialog-guard.js');

  relay(sendLog, `═══ 수동캡챠: ${url} ═══`);
  relay(sendLog, '기존 네이버 Chrome에 새 탭을 엽니다. 생성 중 탭은 goto/reload 하지 않습니다.');

  // 메인 탭 핸들 고정 — 이후 이 탭에는 절대 goto/reload 금지
  let mainPage = peekNaverSessionPage();
  const mainUrlBefore = (() => {
    try { return mainPage?.url?.() || ''; } catch { return ''; }
  })();

  let sessionAccount = naverAccount?.id ? naverAccount : null;
  const st = getNaverSessionStatus();
  if (!sessionAccount?.id && st?.accountId) {
    sessionAccount = { id: st.accountId, pw: naverAccount?.pw || '' };
  }

  // 1) 이미/곧 뜰 Chrome만 기다림 — ensureNaverSession(보드 reload) 호출 금지
  let browser = await getNaverSessionBrowser();
  if (!browser && (st?.status === 'ready' || st?.status === 'starting')) {
    relay(sendLog, '네이버 Chrome 준비 대기… (메인 탭 유지)');
    browser = await waitForNaverSessionBrowser(90000);
    mainPage = peekNaverSessionPage() || mainPage;
  }

  // 2) 정말 창이 없을 때만 최소 ensure (preserveTabs → 무네비게이션)
  if (!browser) {
    const acct = (naverAccount?.id && naverAccount?.pw)
      ? naverAccount
      : (Array.isArray(naverAccounts) ? naverAccounts.find((a) => a?.id && a?.pw) : null);
    if (!acct) {
      throw new Error('네이버 Chrome 창이 없습니다. 우측 상단 「네이버 로그인」으로 창을 연 뒤 다시 「수동캡챠」를 눌러주세요.');
    }
    relay(sendLog, '네이버 Chrome 재연결/준비 중… (메인 탭 유지)');
    const session = await ensureNaverSession({
      naverAccount: acct,
      naverAccounts,
      openaiApiKey,
      yesCaptchaClientKey,
      headless: false,
      outputFolder: path.join(outputRoot || process.cwd(), 'output', `manual-captcha-${Date.now()}`),
      onLog: (m) => relay(sendLog, String(m).replace(/^\[.*?\]\s*/, '')),
      preserveTabs: true,
      skipSiteCount: true,
    });
    browser = session?.browser || await getNaverSessionBrowser();
    mainPage = peekNaverSessionPage() || mainPage || session?.page || null;
    sessionAccount = session?.naverAccount || acct;
  } else {
    relay(sendLog, `기존 네이버 Chrome 재사용${st?.accountId ? ` (${st.accountId})` : ''} — 메인 탭 유지`);
  }

  if (!browser) {
    throw new Error('네이버 Chrome 창에 연결하지 못했습니다. 우측 상단 「네이버 로그인」 후 다시 시도하세요.');
  }

  // 메인 탭 URL이 바뀌었는지 감시 로그용
  const assertMainUntouched = (label) => {
    if (!mainPage || mainPage.isClosed?.()) return;
    try {
      const now = mainPage.url() || '';
      if (mainUrlBefore && now && now !== mainUrlBefore) {
        relay(sendLog, `⚠ 메인 탭 URL 변경 감지(${label}): ${mainUrlBefore.slice(0, 60)} → ${now.slice(0, 60)}`);
      }
    } catch { /* ignore */ }
  };

  // 새 탭에서만 수동캡챠·수집 — 메인(생성) 탭은 네비게이션하지 않음
  let page;
  try {
    page = await openNaverSessionTab({ bringToFront: true });
  } catch (e) {
    throw new Error(e.message || '새 탭을 열 수 없습니다.');
  }
  relay(sendLog, '새 탭 열림 → HTML 태그 선택 → 소유확인(캡챠)');
  assertMainUntouched('새탭직후');

  const dlg = attachSafeDialogHandler(page, {
    log: (m) => relay(sendLog, String(m).replace('네이티브 팝업', '팝업')),
  });

  try {
    // verify → HTML 태그 라디오 → 소유확인(캡챠 창) — 반드시 새 탭(page)만 이동
    const verifyUrl = `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(url)}`;
    await escapeAdvisorOauthCallback(page, BOARD);
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(2000);
    await escapeAdvisorOauthCallback(page, verifyUrl);
    if (!/\/console\/verify/i.test(page.url() || '')) {
      await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(1500);
    }
    assertMainUntouched('verify이동후');

    // verify 화면에 있어도 「이미 완료」로 오판하지 않도록: HTML태그 title이 보이면 무조건 선택→소유확인
    const hasHtmlTitle = await page.evaluate(() => {
      for (const el of document.querySelectorAll('.title.black--text, .title, div.title')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t === 'HTML 태그' || /^HTML\s*태그$/.test(t)) return true;
      }
      return false;
    }).catch(() => false);

    if (!hasHtmlTitle && (await isOwnershipDone(page, dlg))) {
      relay(sendLog, '✅ 이미 소유확인됨 — 수집 단계로 진행');
    } else {
      await selectHtmlMetaRadio(page, sendLog);
      await sleep(1000);
      const clicked = await clickOwnershipConfirm(page);
      if (clicked) relay(sendLog, `👆 "${clicked}" — 캡챠를 수동으로 풀어주세요`);
      else relay(sendLog, '소유확인 버튼 미감지 — 창에서 HTML 태그 선택 후 소유확인을 눌러 주세요');

      const start = Date.now();
      let sawCaptcha = false;
      while (Date.now() - start < waitTimeoutMs) {
        if (await isOwnershipDone(page, dlg)) break;
        const cap = await hasCaptchaVisible(page);
        if (cap && !sawCaptcha) {
          sawCaptcha = true;
          relay(sendLog, '⏳ 캡챠 화면 대기 중… (수동 입력 후 확인)');
        }
        await sleep(1500);
      }

      if (!(await isOwnershipDone(page, dlg))) {
        try { dlg?.detach?.(); } catch { /* ignore */ }
        return {
          ok: false,
          status: 'captcha',
          message: '수동 캡챠 대기 시간 초과 — 다시 「수동캡챠」를 눌러주세요.',
        };
      }
      relay(sendLog, '✅ 수동 캡챠/소유확인 완료 감지');
    }

    try { dlg?.detach?.(); } catch { /* ignore */ }

    // 수집: 빠르게 → robots → 사이트맵 → 웹페이지 (이 새 탭에서만)
    const dir = siteDir || resolveSiteDir({ url, siteSlug, siteDir, folder: siteDir }, outputRoot);
    const pageUrls = dir
      ? collectLocalSitePageUrls(dir, url.replace(/\/$/, ''))
      : [`${url.replace(/\/$/, '')}/`];
    relay(sendLog, `═══ 수집 자동 진행 (${pageUrls.length}개 URL) ═══`);

    const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
    const collectOut = await submitNaverBulkCollection({
      sites: [{ homeUrl: url, urls: pageUrls }],
      naverAccount: sessionAccount || naverAccount,
      openaiApiKey,
      yesCaptchaClientKey,
      outputRoot,
      sendLog,
      headless: false,
      doFast: true,
      doRobots: true,
      doSitemap: true,
      doWebpage: true,
      browser,
      page,
      keepBrowserOpen: true,
      skipLogin: true,
      adoptSession: false, // 메인(생성) 탭 핸들을 덮어쓰지 않음
    });

    const pagesOk = collectOut?.totals?.pagesOk ?? 0;
    relay(sendLog, `✔ 수동캡챠 + 수집 완료 · 웹수집 ${pagesOk}건`);
    return {
      ok: true,
      status: 'success',
      message: `소유확인·수집 완료 (웹수집 ${pagesOk})`,
      collect: collectOut,
      pageUrlCount: pageUrls.length,
      siteDir: dir,
    };
  } finally {
    // 생성 중인 메인 탭을 세션 기본으로 복구
    if (mainPage && !mainPage.isClosed?.()) {
      try { adoptSessionPage(mainPage); } catch { /* ignore */ }
    }
  }
}
