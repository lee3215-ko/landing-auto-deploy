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
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * 실제 Google Chrome 우선 사용 (번들 Chromium은 폴백).
 * options.preferBundled=true 이면 기존처럼 Puppeteer Chrome 우선.
 */
export async function launchBrowser(options = {}) {
  const { preferBundled = false, ...rest } = options;
  const merged = {
    ignoreDefaultArgs: ['--enable-automation'],
    ...rest,
    args: [...STEALTH_ARGS, ...(rest.args || [])],
  };

  const systemChrome = findSystemChrome();

  // 기본: 설치된 Chrome 사용
  if (!preferBundled && systemChrome) {
    try {
      console.warn(`[puppeteer] 시스템 Chrome 사용: ${systemChrome}`);
      return await puppeteer.launch({ ...merged, executablePath: systemChrome });
    } catch (e) {
      console.warn(`[puppeteer] 시스템 Chrome 실행 실패, 번들로 재시도: ${e.message}`);
    }
  }

  try {
    // channel:'chrome' 도 시스템 Chrome을 가리킴
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
