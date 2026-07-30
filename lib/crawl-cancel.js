let stopRequested = false;
/** @type {import('puppeteer').Browser | null} */
let activeBrowser = null;

export function resetCrawlStop() {
  stopRequested = false;
}

export function requestCrawlStop() {
  stopRequested = true;
  if (activeBrowser) {
    const b = activeBrowser;
    activeBrowser = null;
    b.close().catch(() => {});
  }
}

export function setCrawlActiveBrowser(browser) {
  activeBrowser = browser || null;
}

export function clearCrawlActiveBrowser() {
  activeBrowser = null;
}

export function shouldStopCrawl() {
  return stopRequested;
}

export class CrawlStopped extends Error {
  constructor(message = '사용자가 정지했습니다.') {
    super(message);
    this.name = 'CrawlStopped';
    this.cancelled = true;
  }
}

export function throwIfCrawlStopped() {
  if (stopRequested) throw new CrawlStopped();
}
