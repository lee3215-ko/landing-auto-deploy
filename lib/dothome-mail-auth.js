import { loginNaverWithCaptcha } from './naver-login.js';

const NAVER_MAIL_INBOX = 'https://mail.naver.com/v2/folders/0';
const NAVER_MAIL_HOME = 'https://mail.naver.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 메일 목록에서 FTP 아이디가 제목에 포함된 행을 찾아 클릭
 * 제목 예: [닷홈] {ftpId} 무료호스팅 신청 인증코드 발급
 */
async function clickMailRowByHostId(page, hostId) {
  const coords = await page.evaluate((hid) => {
    const id = String(hid || '').trim();
    if (!id) return null;

    const rowSelectors = [
      '[class*="mail_list"] li',
      '[class*="MailList"] [class*="item"]',
      '[class*="mail_item"]',
      '[role="row"]',
      'ul.mail_list li',
      'li[class*="mail"]',
    ];

    const seen = new Set();
    const candidates = [];

    for (const sel of rowSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t.includes(id)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 16 || r.height > 120 || r.top < 0) continue;
        candidates.push({
          x: r.left + Math.min(r.width * 0.45, 220),
          y: r.top + r.height / 2,
          text: t.slice(0, 140),
          area: r.width * r.height,
        });
      }
    }

    // fallback: 제목 링크/텍스트 노드
    if (!candidates.length) {
      for (const el of document.querySelectorAll('a.mail_title_link, .mail_title, a[href*="/read/"], span, a, div')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t.includes(id)) continue;
        if (t.length > 200) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 12 || r.height > 100 || r.top < 0) continue;
        candidates.push({
          x: r.left + Math.min(r.width * 0.5, 180),
          y: r.top + r.height / 2,
          text: t.slice(0, 140),
          area: r.width * r.height,
        });
      }
    }

    if (!candidates.length) return null;
    // 가장 작은(구체적인) 행 우선 — 전체 리스트 컨테이너 오클릭 방지
    candidates.sort((a, b) => a.area - b.area);
    return candidates[0];
  }, hostId);

  if (!coords) return '';
  await page.mouse.click(coords.x, coords.y);
  return coords.text;
}

/**
 * 네이버 메일 목록에서 닷홈 무료호스팅 인증코드 추출
 * (검색창 사용 안 함 — 목록에서 FTP 아이디가 제목에 있는 메일만 클릭)
 * @param hostId FTP 아이디 (메일 제목 매칭용)
 */
export async function fetchDothomeAuthCodeFromNaverMail({
  browser,
  naverId,
  naverPw,
  hostId,
  openaiApiKey = '',
  scratchDir = '',
  sendLog = null,
  timeoutMs = 120000,
} = {}) {
  const log = (msg) => {
    const line = `[DOTHOME-MAIL] ${msg}`;
    if (sendLog) sendLog(line);
    console.log(line);
  };

  if (!naverId || !naverPw) throw new Error('네이버 메일 로그인용 아이디/비밀번호가 없습니다. 설정 탭 네이버 계정을 확인하세요.');
  if (!hostId) throw new Error('FTP 아이디가 없어 메일을 찾을 수 없습니다.');

  const mailPage = await browser.newPage();
  mailPage.setDefaultTimeout(60000);
  await mailPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );

  try {
    log(`네이버 로그인: ${naverId}`);
    await loginNaverWithCaptcha(mailPage, {
      naverId,
      naverPw,
      openaiApiKey,
      scratchDir,
      sendLog: (line) => log(String(line).replace(/^\[NAVER_LOGIN\]\s*/, '')),
    });

    log('네이버 메일함 이동...');
    try {
      await mailPage.goto(NAVER_MAIL_INBOX, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      await mailPage.goto(NAVER_MAIL_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await sleep(3500);

    log(`메일 목록에서 제목에 FTP아이디 "${hostId}" 포함된 메일 찾는 중...`);
    const start = Date.now();
    let opened = false;
    let lastRefresh = 0;

    while (Date.now() - start < timeoutMs) {
      const hit = await clickMailRowByHostId(mailPage, hostId);
      if (hit) {
        log(`메일 클릭: ${hit}`);
        opened = true;
        break;
      }

      const elapsed = Date.now() - start;
      if (elapsed - lastRefresh > 12000) {
        log('메일 목록 새로고침...');
        await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(3000);
        lastRefresh = elapsed;
      } else {
        await sleep(2000);
      }
    }

    if (!opened) throw new Error(`메일 목록에서 제목에 "${hostId}"가 있는 메일을 찾지 못했습니다.`);

    await sleep(2500);

    // 본문에서 인증코드 추출 (32자 hex 우선)
    const code = await mailPage.evaluate(() => {
      const extract = (text) => {
        const t = text || '';
        const hex = t.match(/\b[a-f0-9]{32}\b/i);
        if (hex) return hex[0];
        const alnum = t.match(/\b[A-Za-z0-9]{16,40}\b/);
        if (alnum && !/dothome|naver|http|mail/i.test(alnum[0])) return alnum[0];
        return '';
      };

      for (const td of document.querySelectorAll('td')) {
        const c = extract(td.textContent || '');
        if (c) return c;
      }
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const doc = frame.contentDocument;
          if (!doc) continue;
          const c = extract(doc.body?.innerText || '');
          if (c) return c;
        } catch { /* cross-origin */ }
      }
      return extract(document.body?.innerText || '');
    });

    if (!code) throw new Error('메일 본문에서 인증코드를 추출하지 못했습니다.');
    log(`인증코드 추출: ${code}`);
    return code;
  } finally {
    await mailPage.close().catch(() => {});
  }
}
