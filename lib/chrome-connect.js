import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { findSystemChrome } from './puppeteer-launch.js';

export const DEFAULT_DEBUG_PORT = 9333;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDebugVersion(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function isDebugPortOpen(port) {
  try {
    await fetchDebugVersion(port);
    return true;
  } catch {
    return false;
  }
}

async function waitForDebugPort(port, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDebugPortOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * 일반 Chrome만 실행. Puppeteer는 연결하지 않음 → 사용자 클릭/입력이 실제 이벤트.
 */
export async function launchChromeStandalone({
  userDataDir,
  port = DEFAULT_DEBUG_PORT,
  startUrl = '',
  sendLog = null,
  windowPlacement = null,
} = {}) {
  const exe = findSystemChrome();
  if (!exe) throw new Error('Google Chrome을 찾을 수 없습니다.');

  const profilePath = path.resolve(userDataDir);
  fs.mkdirSync(profilePath, { recursive: true });

  sendLog?.(`✅ Chrome 실행 파일: ${exe}`);
  sendLog?.(`✅ Chrome 프로필: ${profilePath}`);
  sendLog?.(`✅ Puppeteer 미연결 (수동 조작 모드)`);

  if (await isDebugPortOpen(port)) {
    sendLog?.(`기존 Chrome 세션 사용 (디버그 포트 ${port})`);
    if (startUrl) {
      sendLog?.(`이미 Chrome이 열려 있습니다. 주소창에 직접 이동: ${startUrl}`);
    }
    return { exe, profilePath, port, reused: true };
  }

  let placement = windowPlacement;
  if (!placement) {
    try {
      const { getChromeWindowPlacement } = await import('./window-placement.js');
      placement = await getChromeWindowPlacement(1400, 900);
    } catch { /* ignore */ }
  }
  const posArgs = placement
    ? [`--window-size=${placement.width},${placement.height}`, `--window-position=${placement.x},${placement.y}`]
    : ['--start-maximized'];
  if (placement) {
    sendLog?.(`✅ 창 위치: 모니터 좌표 (${placement.x}, ${placement.y}) ${placement.width}×${placement.height}`);
  }

  const args = [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...posArgs,
  ];
  if (startUrl) args.push(startUrl);

  sendLog?.('Chrome 창 실행 중...');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const ok = await waitForDebugPort(port);
  if (!ok) throw new Error('Chrome 실행 시간 초과');

  const ver = await fetchDebugVersion(port);
  sendLog?.(`✅ Chrome 버전: ${ver.Browser || 'unknown'}`);

  return { exe, profilePath, port, reused: false };
}

/** 가입·로그인 완료 후 토큰 생성 단계에서만 Puppeteer 연결 */
export async function connectChromeForAutomation({ port = DEFAULT_DEBUG_PORT, sendLog = null, quiet = false } = {}) {
  if (!(await isDebugPortOpen(port))) {
    throw new Error(`Chrome 디버그 포트(${port})에 연결할 수 없습니다. Chrome 창이 열려 있는지 확인하세요.`);
  }
  if (!quiet) sendLog?.(`토큰 생성 단계: Chrome에 Puppeteer 연결 (포트 ${port})`);
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });
  return browser;
}

export async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  return pages.find((p) => !p.url().startsWith('chrome://')) || pages[0] || await browser.newPage();
}

export async function disconnectBrowser(browser) {
  try {
    if (browser?.isConnected?.()) await browser.disconnect();
  } catch { /* ignore */ }
}
