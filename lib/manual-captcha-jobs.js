/**
 * 수동캡챠 동시 실행 지원:
 * - 캡챠 대기(탭)는 여러 개 병렬
 * - 수집(CDP 조작)은 브라우저 공유 레이스 방지를 위해 직렬화
 * - 세션 메인 탭 복원은 마지막 작업 종료 시에만
 */
import { adoptSessionPage } from './naver-session.js';

let activeJobs = 0;
/** @type {import('puppeteer').Page | null} */
let preservedMainPage = null;
let collectChain = Promise.resolve();

export function beginManualCaptchaJob(mainPage) {
  activeJobs += 1;
  if (!preservedMainPage && mainPage && !mainPage.isClosed?.()) {
    preservedMainPage = mainPage;
  }
  return activeJobs;
}

export function endManualCaptchaJob() {
  activeJobs = Math.max(0, activeJobs - 1);
  if (activeJobs === 0) {
    const main = preservedMainPage;
    preservedMainPage = null;
    if (main && !main.isClosed?.()) {
      try { adoptSessionPage(main); } catch { /* ignore */ }
    }
  }
  return activeJobs;
}

export function getActiveManualCaptchaJobs() {
  return activeJobs;
}

/** 수집 단계만 한 번에 하나 (캡챠 대기는 병렬 유지) */
export function runExclusiveManualCollect(fn) {
  const run = collectChain.then(() => fn());
  // 이전 실패가 다음 수집을 막지 않도록
  collectChain = run.then(() => undefined, () => undefined);
  return run;
}
