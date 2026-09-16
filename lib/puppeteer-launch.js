import fs from 'fs';
import puppeteer from 'puppeteer';

const SYSTEM_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean);

const SYSTEM_EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
].filter(Boolean);

function findSystemChrome() {
  return SYSTEM_CHROME_PATHS.find((p) => fs.existsSync(p)) || '';
}

function findSystemEdge() {
  return SYSTEM_EDGE_PATHS.find((p) => fs.existsSync(p)) || '';
}

export { findSystemChrome, findSystemEdge };

const STEALTH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
];

// Puppeteer 기본값에 AutomationControlled가 들어 있어 노란 경고 + 네이버 봇 탐지 유발
const IGNORE_DEFAULT_ARGS = [
  '--enable-automation',
  '--disable-blink-features=AutomationControlled',
];

/**
 * 브라우저 실행.
 * options.browser: 'edge' | 'chrome' | 'auto'(기본=chrome)
 * options.preferBundled=true 이면 Puppeteer 번들 Chromium 우선.
 */
export async function launchBrowser(options = {}) {
  const {
    preferBundled = false,
    browser: browserPref = 'auto',
    ignoreDefaultArgs,
    args,
    ...rest
  } = options;
  const mergedIgnore = [
    ...IGNORE_DEFAULT_ARGS,
    ...(Array.isArray(ignoreDefaultArgs) ? ignoreDefaultArgs : []),
  ];
  const merged = {
    ...rest,
    ignoreDefaultArgs: mergedIgnore,
    args: [...STEALTH_ARGS, ...(args || [])],
  };

  const wantEdge = String(browserPref || '').toLowerCase() === 'edge';
  const systemEdge = findSystemEdge();
  const systemChrome = findSystemChrome();

  if (!preferBundled && wantEdge) {
    if (systemEdge) {
      try {
        console.warn(`[puppeteer] 시스템 Edge 사용: ${systemEdge}`);
        return await puppeteer.launch({ ...merged, executablePath: systemEdge });
      } catch (e) {
        console.warn(`[puppeteer] 시스템 Edge 실행 실패, channel=msedge 재시도: ${e.message}`);
      }
    }
    try {
      return await puppeteer.launch({ ...merged, channel: 'msedge' });
    } catch (e) {
      console.warn(`[puppeteer] Edge 실패 → Chrome 폴백: ${e.message}`);
    }
  }

  if (!preferBundled && systemChrome) {
    try {
      console.warn(`[puppeteer] 시스템 Chrome 사용: ${systemChrome}`);
      return await puppeteer.launch({ ...merged, executablePath: systemChrome });
    } catch (e) {
      console.warn(`[puppeteer] 시스템 Chrome 실행 실패, 번들로 재시도: ${e.message}`);
    }
  }

  try {
    if (!preferBundled) {
      try {
        return await puppeteer.launch({ ...merged, channel: wantEdge ? 'msedge' : 'chrome' });
      } catch {
        /* fall through */
      }
    }
    return await puppeteer.launch(merged);
  } catch (e) {
    const msg = e?.message || '';
    if (!/Could not find Chrome|Could not find Edge|Failed to launch/i.test(msg)) throw e;

    const fallback = wantEdge ? (systemEdge || systemChrome) : (systemChrome || systemEdge);
    if (!fallback) {
      throw new Error(
        '브라우저를 찾을 수 없습니다. Microsoft Edge 또는 Google Chrome을 설치하세요.',
      );
    }

    console.warn(`[puppeteer] Bundled 없음 — 시스템 브라우저 사용: ${fallback}`);
    return puppeteer.launch({ ...merged, executablePath: fallback });
  }
}
