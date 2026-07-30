import fs from 'fs';
import path from 'path';
import { detectNetlifyScreen } from './netlify-onboarding.js';

export const FLOW_STEPS = [
  'manual_signup',
  'check_email',
  'naver_mail',
  'post_verify',
  'create_token',
  'logout',
  'done',
];

const STEP_LABELS = {
  manual_signup: '1. Netlify 가입/로그인 (직접 입력)',
  check_email: '2. Check your email 확인',
  naver_mail: '3. 네이버 메일 인증',
  post_verify: '4. Verify email · 온보딩 설문',
  create_token: '5. 토큰 생성',
  logout: '6. 로그아웃',
  done: '완료',
};

function stepIndex(step) {
  const i = FLOW_STEPS.indexOf(step);
  return i >= 0 ? i : 0;
}

export function stepLabel(step) {
  return STEP_LABELS[step] || step;
}

export function isStepAtOrBefore(current, target) {
  return stepIndex(current) <= stepIndex(target);
}

export function isStepBefore(current, target) {
  return stepIndex(current) < stepIndex(target);
}

export function laterStep(a, b) {
  if (!a) return b || 'manual_signup';
  if (!b) return a;
  return stepIndex(a) >= stepIndex(b) ? a : b;
}

/** URL + 화면 텍스트 → 플로우 단계 */
export function screenToFlowStep(screen, url = '', mode = 'signup') {
  const u = (url || '').toLowerCase();

  // 구체적 URL 경로 먼저 (/signup-questions는 /signup 보다 우선)
  if (u.includes('signup-questions')) return 'post_verify';
  if (u.includes('/user/applications')) return 'create_token';

  if (screen === 'check_email') return 'check_email';
  if (screen === 'verify_email') return 'post_verify';
  if (screen === 'signup_questions' || screen === 'onboarding_survey' || screen === 'deploy_intro') {
    return 'post_verify';
  }
  if (screen === 'token_settings') return 'create_token';
  if (screen === 'dashboard') return 'create_token';

  // 정확히 /signup 또는 /login 만 (signup-questions 제외)
  if (/\/signup\/?(?:\?|#|$)/i.test(url)) return 'manual_signup';
  if (/\/login/i.test(url)) return 'manual_signup';

  if (mode === 'login' && /app\.netlify\.com/i.test(url)) return 'create_token';
  return 'unknown';
}

export function stepFromUrl(url = '') {
  const u = (url || '').toLowerCase();
  if (u.includes('signup-questions')) return 'post_verify';
  if (u.includes('/user/applications')) return 'create_token';
  if (/\/signup\/?(?:\?|#|$)/i.test(url)) return 'manual_signup';
  if (/\/login/i.test(url)) return 'manual_signup';
  if (/app\.netlify\.com/i.test(url) && !u.includes('/signup') && !u.includes('/login')) {
    return 'create_token';
  }
  return 'unknown';
}

export async function inspectNetlifyPage(page, mode = 'signup') {
  const url = page.url();
  const screen = await detectNetlifyScreen(page);
  let step = screenToFlowStep(screen, url, mode);
  if (step === 'unknown') {
    step = stepFromUrl(url);
  }
  return { url, screen, step };
}

/** 열린 Chrome 탭 중 Netlify 진행이 가장 앞선 탭 선택 */
export async function findBestNetlifyPage(browser, mode = 'signup', sendLog = null) {
  const pages = await browser.pages();
  let bestPage = null;
  let bestSnap = null;
  let bestIdx = -1;

  for (const page of pages) {
    const rawUrl = page.url();
    if (rawUrl.startsWith('chrome://') || rawUrl.startsWith('chrome-extension://')) continue;
    if (!/netlify\.com/i.test(rawUrl) && !rawUrl.startsWith('about:blank')) continue;

    try {
      const snap = await inspectNetlifyPage(page, mode);
      const step = snap.step === 'unknown' ? stepFromUrl(snap.url) : snap.step;
      const idx = stepIndex(step);
      if (idx > bestIdx) {
        bestIdx = idx;
        bestPage = page;
        bestSnap = { ...snap, step: step === 'unknown' ? snap.step : step };
      }
    } catch { /* tab closed */ }
  }

  if (bestPage && bestSnap) {
    await bestPage.bringToFront().catch(() => {});
    sendLog?.(`Netlify 탭 선택: ${bestSnap.url.slice(0, 80)} → ${stepLabel(bestSnap.step)}`);
    return { page: bestPage, snapshot: bestSnap };
  }

  const fallback = pages.find((p) => !p.url().startsWith('chrome://')) || pages[0] || await browser.newPage();
  const snap = await inspectNetlifyPage(fallback, mode);
  return { page: fallback, snapshot: snap };
}

export function getProgressPath(outputRoot) {
  return path.join(outputRoot, 'token-gen-progress.json');
}

export function loadProgress(outputRoot, accountKey) {
  const filePath = getProgressPath(outputRoot);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.accountKey !== accountKey) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveProgress(outputRoot, accountKey, patch) {
  const filePath = getProgressPath(outputRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prev = loadProgress(outputRoot, accountKey) || {};
  const next = {
    accountKey,
    step: 'manual_signup',
    mode: 'signup',
    tokensCreated: 0,
    updatedAt: new Date().toISOString(),
    lastUrl: '',
    lastScreen: '',
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function clearProgress(outputRoot, accountKey) {
  const filePath = getProgressPath(outputRoot);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.accountKey === accountKey) fs.unlinkSync(filePath);
  } catch { /* no file */ }
}

/**
 * 저장된 진행 + 현재 Chrome 화면을 합쳐 시작 단계 결정
 */
export function resolveResumeStep({ savedStep, detectedStep, detectedUrl = '', mode }) {
  const urlStep = stepFromUrl(detectedUrl);
  const detected = detectedStep && detectedStep !== 'unknown' ? detectedStep : urlStep;

  if (detected && detected !== 'unknown' && savedStep && FLOW_STEPS.includes(savedStep)) {
    return laterStep(savedStep, detected);
  }
  if (detected && detected !== 'unknown') return detected;
  if (savedStep && FLOW_STEPS.includes(savedStep)) return savedStep;
  return 'manual_signup';
}

export function describeResume(startStep, snapshot, saved) {
  const lines = [];
  lines.push(`▶ 이어하기 — ${stepLabel(startStep)}부터 진행`);
  if (snapshot?.url) lines.push(`   현재 URL: ${snapshot.url.slice(0, 100)}`);
  if (snapshot?.screen) lines.push(`   인식 화면: ${snapshot.screen}`);
  if (saved?.step && saved.step !== startStep) {
    lines.push(`   저장된 단계: ${stepLabel(saved.step)} (${saved.updatedAt?.slice(0, 19) || ''})`);
  }
  return lines.join('\n');
}
