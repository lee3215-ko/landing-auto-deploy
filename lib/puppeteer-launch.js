import fs from 'fs';
import puppeteer from 'puppeteer';

const SYSTEM_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean);

function findSystemChrome() {
  return SYSTEM_CHROME_PATHS.find((p) => fs.existsSync(p)) || '';
}

export { findSystemChrome };

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
 * 실제 Google Chrome 우선 사용 (번들 Chromium은 폴백).
 * options.preferBundled=true 이면 기존처럼 Puppeteer Chrome 우선.
 */
export async function launchBrowser(options = {}) {
  const { preferBundled = false, ignoreDefaultArgs, args, ...rest } = options;
  const mergedIgnore = [
    ...IGNORE_DEFAULT_ARGS,
    ...(Array.isArray(ignoreDefaultArgs) ? ignoreDefaultArgs : []),
  ];
  const merged = {
    ...rest,
    ignoreDefaultArgs: mergedIgnore,
    args: [...STEALTH_ARGS, ...(args || [])],
  };

  const systemChrome = findSystemChrome();

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
        return await puppeteer.launch({ ...merged, channel: 'chrome' });
      } catch {
        /* fall through */
      }
    }
    return await puppeteer.launch(merged);
  } catch (e) {
    const msg = e?.message || '';
    if (!/Could not find Chrome/i.test(msg)) throw e;

    if (!systemChrome) {
      throw new Error(
        'Google Chrome을 찾을 수 없습니다. Chrome을 설치하거나 npx puppeteer browsers install chrome 를 실행하세요.',
      );
    }

    console.warn(`[puppeteer] Bundled Chrome 없음 — 시스템 Chrome 사용: ${systemChrome}`);
    return puppeteer.launch({ ...merged, executablePath: systemChrome });
  }
}
