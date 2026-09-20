/**
 * 네이버 보호조치 감지 → 전체 작업 중지 + 안내 팝업만
 * (진행 게이지에는 보호조치 상태를 넣지 않음)
 */
import {
  requestRunStop,
  isRunStopped,
  RunStopped,
} from './run-pause.js';

/** @type {null | ((payload: { detail: string, source: string }) => Promise<void> | void)} */
let alertHandler = null;

/** @type {null | ((payload: object) => void)} */
let uiNotify = null;

let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 4000;

/** 보호조치로 중지된 뒤, 다음 시작 시 서치어드바이저 대시보드로 진입 */
let preferAdvisorBoardOnNextStart = false;

export function setNaverProtectionAlertHandler(fn) {
  alertHandler = typeof fn === 'function' ? fn : null;
}

export function setNaverProtectionUiNotify(fn) {
  uiNotify = typeof fn === 'function' ? fn : null;
}

export function markAdvisorBoardRestartNeeded() {
  preferAdvisorBoardOnNextStart = true;
}

export function consumeAdvisorBoardRestartNeeded() {
  const v = preferAdvisorBoardOnNextStart;
  preferAdvisorBoardOnNextStart = false;
  return v;
}

export function peekAdvisorBoardRestartNeeded() {
  return preferAdvisorBoardOnNextStart;
}

const PAGE_PROTECTION_PATTERNS = [
  '보호조치',
  '보호 조치',
  '보호하고',
  '아이디를 보호',
  '2단계 인증',
  '본인확인',
  '본인 확인',
  '비정상적인',
  '로그인 제한',
  '일시적으로 제한',
  '자동입력 방지',
  '해외 로그인',
  '새로운 기기',
];

const ADVISOR_PROTECTION_PATTERNS = [
  '보호조치',
  '보호 조치',
  '이용이 제한',
  '이용을 제한',
  '비정상적인 이용',
  '비정상 이용',
  '서비스 이용이 제한',
  '접근이 제한',
];

export function isNaverProtectionText(text) {
  const s = String(text || '');
  if (!s) return false;
  return /보호\s*조치|아이디를\s*보호|로그인\s*제한|일시적(으로)?\s*제한|비정상(적인)?\s*(접근|이용)|2단계\s*인증|본인\s*확인|해외\s*로그인|새로운\s*기기|이용이\s*제한|접근이\s*제한|서비스\s*이용이\s*제한/.test(s);
}

/**
 * nid 로그인·서치어드바이저 화면에서 보호조치 문구 감지
 * @param {import('puppeteer').Page} page
 */
export async function pageHasNaverProtection(page) {
  if (!page || page.isClosed?.()) return false;
  try {
    const url = page.url() || '';
    const onNid = /nid\.naver\.com/i.test(url);
    const onAdvisor = /searchadvisor\.naver\.com/i.test(url);
    if (!onNid && !onAdvisor) return false;
    const patterns = onNid ? PAGE_PROTECTION_PATTERNS : ADVISOR_PROTECTION_PATTERNS;
    return await page.evaluate((pats) => {
      const text = document.body?.innerText || '';
      return pats.some((p) => text.includes(p));
    }, patterns);
  } catch {
    return false;
  }
}

/**
 * 보호조치 감지 → 전체 작업 중지 → 팝업만 표시
 * (재개하지 않음. 사용자가 보호조치 해제 후 「시작」을 다시 눌러야 함)
 * @param {{ log?: (msg: string) => void, detail?: string, source?: string, forceAlert?: boolean }} [opts]
 */
export async function pauseForNaverProtection(opts = {}) {
  const {
    log = () => {},
    detail = '네이버에서 보호조치가 감지되었습니다.',
    source = '',
    forceAlert = false,
  } = opts;

  // 이미 중지된 경우에도 팝업은 한 번 더 보여줄 수 있음
  markAdvisorBoardRestartNeeded();
  requestRunStop();

  log('⏹ [RUN_STOPPED] 네이버 보호조치 감지 — 전체 작업 중지');
  log(`   → ${detail}${source ? ` (${source})` : ''}`);
  log('   → 브라우저에서 보호조치를 해제한 뒤 「전체 실행 시작」을 다시 눌러 주세요.');

  try {
    uiNotify?.({
      type: 'naver-protection',
      detail,
      source,
      stopped: true,
      paused: false,
    });
  } catch { /* ignore */ }

  const now = Date.now();
  const shouldAlert = forceAlert || (now - lastAlertAt >= ALERT_COOLDOWN_MS);
  if (shouldAlert) lastAlertAt = now;

  if (shouldAlert && alertHandler) {
    try {
      await alertHandler({ detail, source });
    } catch (e) {
      try { log(`⚠ 보호조치 안내 팝업 오류: ${e?.message || e}`); } catch { /* ignore */ }
    }
  }

  throw new RunStopped('네이버 보호조치로 작업을 중지했습니다. 해제 후 다시 시작해 주세요.');
}

/** @deprecated 이름 호환 — pauseForNaverProtection과 동일(중지) */
export const stopForNaverProtection = pauseForNaverProtection;

/**
 * 페이지에 보호조치가 보이면 작업 중지·팝업
 * @returns {Promise<boolean>} 보호조치를 처리했으면 true (그 경우 예외 throw)
 */
export async function ensureNoNaverProtection(page, opts = {}) {
  const { log = () => {}, source = '' } = opts;
  if (!(await pageHasNaverProtection(page))) return false;
  await pauseForNaverProtection({
    log,
    detail: '네이버 보호조치 화면이 감지되었습니다. 브라우저에서 보호조치·추가인증을 해제한 뒤 「시작」을 다시 눌러 주세요.',
    source,
  });
  return true;
}
