import fs from 'fs';
import path from 'path';
import { launchBrowser } from './puppeteer-launch.js';
import { loginNaverForAdvisor, requestNaverIndexing } from './naver-register.js';
import { log as sharedLog } from './logger.js';

function relay(sendLog, msg) {
  sharedLog(`[REINDEX] ${msg}`);
  if (sendLog) sendLog(msg);
}

export async function reinjectIndexing({
  siteUrl,
  siteName = '',
  naverAccount,
  openaiApiKey = '',
  outputRoot,
  sendLog = null,
  headless = false,
}) {
  if (!siteUrl) throw new Error('URL이 없습니다.');
  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error(`네이버 계정 정보가 없습니다: ${naverAccount?.id || '(없음)'}`);
  }

  const folder = path.join(outputRoot || path.join(process.cwd(), 'output'), `reindex-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });

  relay(sendLog, `재인젝싱 시작: ${siteName || siteUrl}`);
  relay(sendLog, `모드: ${headless ? '헤드리스' : '창 표시'}`);
  const browser = await launchBrowser({
    headless: !!headless,
    args: ['--window-size=1400,900', '--window-position=120,80'],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    await loginNaverForAdvisor(page, naverAccount, { openaiApiKey, outputFolder: folder });
    const out = await requestNaverIndexing(page, siteUrl, folder);
    relay(sendLog, `✅ 재인젝싱 완료: ${siteUrl}${out.crawlRegistered ? ' (수집 요청 확인)' : ''}`);
    return out;
  } finally {
    if (!headless) {
      relay(sendLog, '브라우저 종료 (10초 후)');
      await new Promise(r => setTimeout(r, 10000));
    } else {
      relay(sendLog, '브라우저 종료');
    }
    await browser.close();
  }
}
