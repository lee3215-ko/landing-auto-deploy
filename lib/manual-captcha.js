/**
 * 배포결과·생성사이트 「수동캡챠」:
 * 이미 열린 서치어드바이저 Chrome(+)에 새 탭 → HTML 태그 → 소유확인(캡챠 수동) → 수집
 * 생성 중 메인 탭은 goto/reload 금지.
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

async function clickAt(page, x, y) {
  if (!(x > 0 && y > 0)) return false;
  try {
    await page.mouse.click(x, y, { delay: 40 });
    return true;
  } catch {
    return false;
  }
}

/** <div class="title black--text">HTML 태그</div> 클릭 */
async function selectHtmlMetaRadio(page, sendLog) {
  for (let w = 0; w < 20; w++) {
    const found = await page.evaluate(() => {
      for (const el of document.querySelectorAll('.title.black--text, .title, div.title')) {
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
    let titleEl = null;
    for (const el of document.querySelectorAll('.title.black--text, .title, div.title')) {
      const t = norm(el.textContent);
      if (t === 'HTML 태그' || /^HTML\s*태그$/.test(t)) { titleEl = el; break; }
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

    let target = titleEl;
    let cur = titleEl;
    for (let i = 0; i < 8 && cur; i++) {
      if (
        cur.matches?.('input[type="radio"], label, [role="radio"], .v-radio, .v-card, .v-list-item')
        || (cur.classList && (
          cur.classList.contains('v-radio')
          || cur.classList.contains('v-card')
          || /radio|method|card|item/i.test(cur.className || '')
        ))
      ) {
        target = cur;
        break;
      }
      if (cur.querySelector?.('input[type="radio"]')) {
        target = cur;
        break;
      }
      cur = cur.parentElement;
    }

    const radio = target.querySelector?.('input[type="radio"]')
      || document.querySelector('input[type="radio"][value="meta"]');
    if (radio) {
      try {
        radio.checked = true;
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
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
    relay(sendLog, '⚠ HTML 태그(title) 미감지 — 새 탭에서 「HTML 태그」를 직접 클릭해 주세요');
    return '';
  }

  await clickAt(page, hit.x, hit.y);
  relay(sendLog, `HTML 태그 선택: ${hit.how} ("${hit.text}")`);
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

  if (!hit) return '';
  await clickAt(page, hit.x, hit.y);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, a, .v-btn')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t === '소유확인' || t === '소유 확인') { el.click(); return; }
    }
  }).catch(() => {});
  return hit.t || '소유확인';
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
    return Array.from(document.querySelectorAll('.v-image__image, div')).some((el) => {
      try {
        const bi = getComputedStyle(el).backgroundImage || '';
        return /nhncaptcha|captcha\.nid/.test(bi);
      } catch { return false; }
    });
  }).catch(() => false);
}

const META_MISS_RE = /메타\s*태그|찾을\s*수\s*없|호스팅\s*또는\s*사이트\s*서버/i;

/** 네이티브 alert + 화면(v-dialog) 메타미검출 메시지 */
async function readMetaMissingPopup(page, dlg) {
  if (dlg?.metaMissing && dlg.metaMissingMsg) return dlg.metaMissingMsg;
  const last = String(dlg?.lastMsg || '');
  if (META_MISS_RE.test(last)) {
    dlg?.markMetaMissing?.(last);
    return last.replace(/\s+/g, ' ').trim();
  }
  const domMsg = await page.evaluate(() => {
    const roots = document.querySelectorAll(
      '.v-dialog--active, .v-overlay--active .v-card, [role="dialog"], .swal2-popup, .v-snackbar--active',
    );
    for (const el of roots) {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/메타\s*태그|찾을\s*수\s*없|호스팅\s*또는\s*사이트\s*서버/i.test(t)) {
        return t.slice(0, 240);
      }
    }
    return '';
  }).catch(() => '');
  if (domMsg) {
    dlg?.markMetaMissing?.(domMsg);
    return domMsg;
  }
  return '';
}

function metaMissingResult(url, popupMsg) {
  const popup = (popupMsg || '메타태그를 찾을 수 없습니다. 호스팅 또는 사이트 서버 관리자에게 확인 요청해 주세요.')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    ok: false,
    status: 'meta_missing',
    popupMessage: popup,
    message:
      `[메타미검출] ${popup}\n`
      + '기록됨 — 「인증재시도」·재배포·삭제 또는 다른 사이트 「수동캡챠」를 진행하세요.\n'
      + `URL: ${url}`,
  };
}

/**
 * @returns {Promise<{ok:boolean, status:string, message:string, collect?:object}>}
 */
/**
 * @param {object} opts
 * @param {(ctx:{siteUrl:string,content:string,siteDir:string,metaTag:string})=>Promise<{ok?:boolean,url?:string,error?:string}>} [opts.ensureMetaLive]
 * @param {(payload:{status:string,message:string,popupMessage?:string,siteUrl:string})=>Promise<void>|void} [opts.onRecordStatus]
 *   메타미검출 등 실패를 즉시 results/생성사이트에 기록
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
  ensureMetaLive = null,
  onRecordStatus = null,
} = {}) {
  const url = normalizeAdvisorSiteUrl(siteUrl);
  if (!url) throw new Error('사이트 URL이 없습니다.');

  const {
    openNaverSessionTab,
    peekNaverSessionPage,
    attachNaverChrome,
    getNaverSessionStatus,
  } = await import('./naver-session.js');
  const { attachSafeDialogHandler } = await import('./dialog-guard.js');

  const {
    beginManualCaptchaJob,
    endManualCaptchaJob,
    getActiveManualCaptchaJobs,
    runExclusiveManualCollect,
  } = await import('./manual-captcha-jobs.js');

  relay(sendLog, `═══ 수동캡챠: ${url} ═══`);
  relay(sendLog, '흐름: 열린 서치어드바이저 Chrome → (+)새 탭 → verify → HTML태그 → 소유확인(수동) → 수집');
  relay(sendLog, '생성 중인 탭은 새로고침하지 않습니다. · 여러 사이트 동시 진행 가능(캡챠 탭 병렬)');

  // 메인(생성) 탭 고정 — 동시 작업 시 마지막 종료 때만 복원
  let mainPage = peekNaverSessionPage();
  const mainUrlBefore = (() => {
    try { return mainPage?.url?.() || ''; } catch { return ''; }
  })();

  const st = getNaverSessionStatus();
  let sessionAccount = (naverAccount?.id) ? naverAccount : null;
  if (!sessionAccount?.id && st?.accountId) {
    sessionAccount = { id: st.accountId, pw: naverAccount?.pw || '' };
  }

  // ★ 로그인 UI/ensure 없이 포트 9334 Chrome에만 붙음
  relay(sendLog, '서치어드바이저 Chrome 연결 중 (포트 9334)…');
  let browser = await attachNaverChrome({
    onLog: (m) => relay(sendLog, m),
  });
  mainPage = peekNaverSessionPage() || mainPage;
  beginManualCaptchaJob(mainPage);
  try {
  const concurrent = getActiveManualCaptchaJobs();
  if (concurrent > 1) {
    relay(sendLog, `🔀 수동캡챠 동시 진행 중 (${concurrent}건) — 각 사이트 전용 탭 사용`);
  }

  if (!browser) {
    throw new Error(
      '서치어드바이저 Chrome에 연결할 수 없습니다.\n'
      + '사이트 생성/네이버 로그인으로 연 창(디버그 포트 9334)이 열려 있어야 합니다.\n'
      + '일반 브라우저에서 연 창은 연결되지 않습니다.',
    );
  }

  // (+) 새 탭 (사이트별 전용 — 다른 수동캡챠 탭과 독립)
  let page;
  try {
    page = await openNaverSessionTab({
      bringToFront: true,
      onLog: (m) => relay(sendLog, m),
    });
  } catch (e) {
    throw new Error(e.message || '새 탭을 열 수 없습니다.');
  }
  relay(sendLog, '✔ 전용 새 탭 열림 — verify로 이동');

  const assertMainUntouched = (label) => {
    if (!mainPage || mainPage.isClosed?.()) return;
    try {
      const now = mainPage.url() || '';
      if (mainUrlBefore && now && now !== mainUrlBefore) {
        relay(sendLog, `⚠ 메인 탭 URL 변경(${label}): ${mainUrlBefore.slice(0, 50)} → ${now.slice(0, 50)}`);
      }
    } catch { /* ignore */ }
  };
  assertMainUntouched('새탭직후');

  const dlg = attachSafeDialogHandler(page, {
    log: (m) => relay(sendLog, String(m).replace('네이티브 팝업', '팝업')),
    onMessage: (msg) => {
      if (META_MISS_RE.test(msg || '')) {
        relay(sendLog, `📋 메타미검출 팝업 인식: "${String(msg).replace(/\s+/g, ' ').slice(0, 100)}"`);
      }
    },
  });

  const recordAndFinishMetaMiss = async (popupMsg) => {
    const result = metaMissingResult(url, popupMsg);
    relay(sendLog, `📋 메타미검출 기록 → 수동캡챠 종료 (다음 작업 가능)`);
    relay(sendLog, `   ${result.popupMessage}`);
    try {
      await onRecordStatus?.({
        status: 'meta_missing',
        message: result.message,
        popupMessage: result.popupMessage,
        siteUrl: url,
      });
    } catch (e) {
      relay(sendLog, `⚠ 상태 기록 실패: ${e.message || e}`);
    }
    try { dlg?.detach?.(); } catch { /* ignore */ }
    return result;
  };

    const verifyUrl = `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(url)}`;
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(2000);
    await escapeAdvisorOauthCallback(page, verifyUrl);
    if (!/\/console\/verify/i.test(page.url() || '')) {
      await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(1500);
    }
    assertMainUntouched('verify후');
    relay(sendLog, `verify: ${page.url()}`);

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
      await sleep(800);
      const clicked = await clickOwnershipConfirm(page);
      if (clicked) relay(sendLog, `👆 "${clicked}" — 캡챠를 직접 입력·확인 해주세요`);
      else relay(sendLog, '소유확인 버튼 미감지 — 새 탭에서 HTML 태그 선택 후 소유확인을 눌러 주세요');

      const start = Date.now();
      let sawCaptcha = false;
      let metaMissRecoveryTried = false;
      while (Date.now() - start < waitTimeoutMs) {
        if (await isOwnershipDone(page, dlg)) break;

        const popupMsg = await readMetaMissingPopup(page, dlg);
        if (popupMsg) {
          // 1) 즉시 기록 — 버튼 풀고 재배포/삭제/다음 사이트 가능하게
          try {
            await onRecordStatus?.({
              status: 'meta_missing',
              message: metaMissingResult(url, popupMsg).message,
              popupMessage: popupMsg,
              siteUrl: url,
            });
          } catch { /* ignore */ }
          relay(sendLog, `📋 메타미검출 팝업 기록됨: "${popupMsg.slice(0, 120)}"`);

          // 2) 1회만 자동 재배포 시도 후 소유확인 1회 — 실패하면 즉시 종료
          if (!metaMissRecoveryTried) {
            metaMissRecoveryTried = true;
            if (dlg) {
              dlg.metaMissing = false;
              dlg.lastMsg = '';
            }
            try {
              const { getMeta, waitUntilMetaLive } = await import('./naver-register.js');
              const content = await getMeta(page);
              const dir = siteDir || resolveSiteDir({ url, siteSlug, siteDir, folder: siteDir }, outputRoot);
              if (content && typeof ensureMetaLive === 'function' && dir) {
                const metaTag = `<meta name="naver-site-verification" content="${content}" />`;
                relay(sendLog, '🔄 메타미검출 → 1회 자동 재배포 시도…');
                const fixed = await ensureMetaLive({
                  siteUrl: url, content, siteDir: dir, metaTag, siteSlug,
                });
                if (fixed?.ok) {
                  relay(sendLog, `✔ 메타 재배포 완료${fixed.url ? `: ${fixed.url}` : ''}`);
                  await waitUntilMetaLive(url, content, { maxWaitMs: 45000, intervalMs: 4000 });
                  await sleep(3000);
                  const again = await clickOwnershipConfirm(page);
                  if (again) relay(sendLog, `👆 "${again}" 재클릭 — 캡챠가 뜨면 입력, 같은 팝업이면 종료합니다`);
                  // 재클릭 후 짧게만 성공/재팝업 대기
                  for (let w = 0; w < 20; w++) {
                    if (await isOwnershipDone(page, dlg)) break;
                    const againMiss = await readMetaMissingPopup(page, dlg);
                    if (againMiss) return recordAndFinishMetaMiss(againMiss);
                    await sleep(1000);
                  }
                  if (await isOwnershipDone(page, dlg)) break;
                } else {
                  relay(sendLog, `⚠ 자동 재배포 실패: ${fixed?.error || 'unknown'}`);
                }
              } else {
                relay(sendLog, 'ℹ 자동 재배포 생략 (토큰/폴더/메타코드 부족) — 기록 후 종료');
              }
            } catch (e) {
              relay(sendLog, `⚠ 메타 복구 중 오류: ${e.message || e}`);
            }
            return recordAndFinishMetaMiss(popupMsg);
          }
          return recordAndFinishMetaMiss(popupMsg);
        }

        const cap = await hasCaptchaVisible(page);
        if (cap && !sawCaptcha) {
          sawCaptcha = true;
          relay(sendLog, '⏳ 캡챠 입력 대기 중… (새 탭에서 수동 입력 후 확인)');
        }
        await sleep(1500);
      }

      if (!(await isOwnershipDone(page, dlg))) {
        const lateMiss = await readMetaMissingPopup(page, dlg);
        if (lateMiss || dlg?.metaMissing) {
          return recordAndFinishMetaMiss(lateMiss || dlg.metaMissingMsg);
        }
        try { dlg?.detach?.(); } catch { /* ignore */ }
        return {
          ok: false,
          status: 'captcha',
          message: '수동 캡챠 대기 시간 초과 — 다시 「수동캡챠」를 눌러주세요.',
        };
      }
      relay(sendLog, '✅ 수동 캡챠/소유확인 완료');
    }

    try { dlg?.detach?.(); } catch { /* ignore */ }

    const dir = siteDir || resolveSiteDir({ url, siteSlug, siteDir, folder: siteDir }, outputRoot);
    let pageUrls = dir
      ? collectLocalSitePageUrls(dir, url.replace(/\/$/, ''))
      : [`${url.replace(/\/$/, '')}/`];
    // 메인 URL 보장 + sitemap.xml 은 웹수집 대상에서 제외(사이트맵 제출은 별도)
    const home = `${url.replace(/\/$/, '')}/`;
    const homeKey = home.replace(/\/$/, '').toLowerCase();
    pageUrls = (pageUrls || [])
      .map((u) => String(u || '').trim())
      .filter((u) => u && !/\/sitemap\.xml$/i.test(u.replace(/\/$/, '')));
    if (!pageUrls.some((u) => u.replace(/\/$/, '').toLowerCase() === homeKey)) {
      pageUrls = [home, ...pageUrls];
    }
    relay(sendLog, `═══ 수집 대기열 진입 (${pageUrls.length}개 URL · 홈 포함) — 전용 탭 ═══`);
    if (getActiveManualCaptchaJobs() > 1) {
      relay(sendLog, '⏳ 다른 수동캡챠 수집이 있으면 순차 진행(캡챠 입력 탭은 그대로 유지)');
    }

    const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
    const collectOut = await runExclusiveManualCollect(() => submitNaverBulkCollection({
      sites: [{ homeUrl: url, urls: pageUrls }],
      naverAccount: sessionAccount || naverAccount
        || (Array.isArray(naverAccounts) ? naverAccounts.find((a) => a?.id && a?.pw) : null),
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
      adoptSession: false,
      skipOwnership: true, // 방금 수동 소유확인 완료
    }));

    const pagesOk = collectOut?.totals?.pagesOk ?? 0;
    relay(sendLog, `✔ 수동캡챠 + 수집 완료 · 웹수집 ${pagesOk}/${pageUrls.length}건`);
    assertMainUntouched('수집후');
    return {
      ok: true,
      status: 'success',
      message: `소유확인·수집 완료 (웹수집 ${pagesOk}/${pageUrls.length})`,
      collect: collectOut,
      pageUrlCount: pageUrls.length,
      siteDir: dir,
    };
  } finally {
    endManualCaptchaJob();
  }
}

