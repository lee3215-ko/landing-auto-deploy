import { loginNaverWithCaptcha } from './naver-login.js';
import { connectChromeForAutomation, getOrCreatePage, disconnectBrowser } from './chrome-connect.js';

const NAVER_MAIL_INBOX = 'https://mail.naver.com/v2/folders/0';
const NAVER_MAIL_HOME = 'https://mail.naver.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MAIL_SUBJECT_HINTS = [
  "let's verify your email",
  'lets verify your email',
  'verify your email',
  '이메일 인증',
];

function getAllFrames(page) {
  return [page, ...page.frames()];
}

async function findVerifyLinkInFrame(frame) {
  return frame.evaluate(() => {
    const pick = (href, text) => {
      const h = (href || '').replace(/&amp;/g, '&').trim();
      if (!h || !/netlify\.com/i.test(h)) return '';
      if (/url\d*\.netlify\.com\/ls\/click/i.test(h)) return h;
      if (/(verify|confirmation|confirm|auth|token|signup|email)/i.test(h)) return h;
      const t = (text || '').toLowerCase();
      if (/verify|confirm|인증|확인/.test(t)) return h;
      return '';
    };

    const selectors = [
      'table tbody tr td a[href]',
      'table a[href]',
      'a[href*="netlify"]',
      'a[href]',
    ];

    for (const sel of selectors) {
      for (const a of document.querySelectorAll(sel)) {
        const href = a.getAttribute('href') || a.href || '';
        const hit = pick(href, a.textContent);
        if (hit) {
          const full = hit.startsWith('http') ? hit : new URL(hit, location.href).href;
          const r = a.getBoundingClientRect();
          return {
            href: full,
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            text: (a.textContent || '').trim().slice(0, 60),
            sel,
          };
        }
      }
    }

    const html = document.documentElement?.innerHTML || '';
    const matches = html.match(/https?:\/\/[^\s"'<>]*netlify\.com[^\s"'<>]*/gi) || [];
    for (const raw of matches) {
      const hit = pick(raw, '');
      if (hit) return { href: hit, x: 0, y: 0, text: '', sel: 'html' };
    }
    return null;
  }).catch(() => null);
}

async function findNetlifyVerifyLink(page) {
  for (const frame of getAllFrames(page)) {
    const hit = await findVerifyLinkInFrame(frame);
    if (hit?.href) return hit;
  }
  return null;
}

async function clickVerifyLinkInMail(page, sendLog) {
  for (const frame of getAllFrames(page)) {
    const hit = await findVerifyLinkInFrame(frame);
    if (!hit?.href) continue;

    log(sendLog, `인증 링크 발견: ${hit.text || hit.href.slice(0, 70)}...`);

    const clicked = await frame.evaluate((targetHref) => {
      const norm = (u) => (u || '').replace(/&amp;/g, '&').trim();
      const target = norm(targetHref);
      for (const a of document.querySelectorAll('table a[href], a[href]')) {
        const raw = a.getAttribute('href') || a.href || '';
        const full = raw.startsWith('http') ? raw : new URL(raw, location.href).href;
        if (norm(full) === target || norm(raw) === target || full.includes('netlify.com')) {
          if (/netlify\.com/i.test(full)) {
            a.click();
            return true;
          }
        }
      }
      return false;
    }, hit.href).catch(() => false);

    if (clicked) {
      log(sendLog, '메일 본문 링크 클릭 완료');
      return { href: hit.href, clicked: true };
    }

    if (hit.x > 0 && hit.y > 0) {
      try {
        await page.mouse.click(hit.x, hit.y);
        log(sendLog, '메일 본문 링크 좌표 클릭');
        return { href: hit.href, clicked: true };
      } catch { /* fall through */ }
    }

    return { href: hit.href, clicked: false };
  }
  return null;
}

function log(sendLog, msg) {
  sendLog?.(msg);
}

async function clickNetlifyMailRow(page) {
  const coords = await page.evaluate((subjects) => {
    const matchSubject = (text) => {
      const t = (text || '').toLowerCase();
      if (!t.includes('netlify')) return false;
      return subjects.some((s) => t.includes(s));
    };

    const rowSelectors = [
      '[class*="mail_list"] li',
      '[class*="MailList"] [class*="item"]',
      '[role="row"]',
      'ul li',
      'div[class*="list"]',
    ];

    for (const sel of rowSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!matchSubject(el.textContent)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 18 || r.top < 0) continue;
        return { x: r.left + Math.min(r.width * 0.4, 200), y: r.top + r.height / 2, text: (el.textContent || '').slice(0, 100) };
      }
    }

    for (const el of document.querySelectorAll('li, tr, div, span')) {
      const t = (el.textContent || '').toLowerCase();
      if (!t.includes('netlify') || !t.includes('verify')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 16 || r.height > 80) continue;
      return { x: r.left + 150, y: r.top + r.height / 2, text: (el.textContent || '').slice(0, 100) };
    }
    return null;
  }, MAIL_SUBJECT_HINTS);

  if (!coords) return false;
  await page.mouse.click(coords.x, coords.y);
  return coords.text;
}

async function searchNetlifyMail(page) {
  const searched = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="search"], input[type="text"], input[placeholder*="검색"], input[aria-label*="검색"]');
    for (const inp of inputs) {
      const ph = (inp.placeholder || inp.getAttribute('aria-label') || '').toLowerCase();
      if (ph.includes('검색') || ph.includes('search') || inp.type === 'search') {
        inp.focus();
        inp.value = 'netlify verify';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  });
  if (searched) {
    await sleep(500);
    await page.keyboard.press('Enter');
    await sleep(3000);
    return true;
  }
  return false;
}

async function waitForMailInbox(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (/mail\.naver\.com/i.test(page.url())) {
      const ready = await page.evaluate(() => !!(
        document.querySelector('[class*="mail"], [role="row"], [class*="MailList"], iframe')
      ));
      if (ready) return true;
    }
    await sleep(800);
  }
  return false;
}

async function waitForMailBody(page, sendLog, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (/\/v2\/read\//i.test(page.url())) {
      log(sendLog, '메일 읽기 화면 로드됨');
      return true;
    }
    const hit = await findNetlifyVerifyLink(page);
    if (hit?.href) return true;
    const hasBody = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      return /verify your email|let.s verify|netlify/i.test(t) && document.querySelector('table a, iframe');
    }).catch(() => false);
    if (hasBody) return true;
    await sleep(1500);
  }
  return false;
}

async function openVerifyInNetlifyChrome(verifyUrl, chromePort, sendLog) {
  if (!chromePort) return null;
  log(sendLog, '인증 링크를 Netlify Chrome 창에서 엽니다...');
  const browser = await connectChromeForAutomation({ port: chromePort, sendLog });
  try {
    const page = await getOrCreatePage(browser);
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(3000);

    const body = await page.evaluate(() => document.body?.innerText || '');
    if (/verify your email|you.re nearly there/i.test(body)) {
      log(sendLog, '「Verify email」 페이지 — 버튼 클릭...');
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, a')) {
          if (/^verify email$/i.test((el.textContent || '').trim())) {
            el.click();
            return;
          }
        }
      });
      await sleep(4000);
    } else {
      log(sendLog, `인증 페이지: ${page.url().slice(0, 90)}`);
    }
    return page;
  } finally {
    await disconnectBrowser(browser);
  }
}

async function waitForNewTabUrl(browser, timeoutMs = 15000) {
  const start = Date.now();
  const before = new Set((await browser.pages()).map((p) => p.url()));
  while (Date.now() - start < timeoutMs) {
    const pages = await browser.pages();
    for (const p of pages) {
      const url = p.url();
      if (/netlify\.com/i.test(url) && !before.has(url)) return url;
    }
    await sleep(500);
  }
  return '';
}

/**
 * 네이버 메일 로그인 → Netlify 인증 메일 열기 → 인증 링크 클릭
 */
export async function verifyNetlifyViaNaverMail({
  mailBrowser,
  naverId,
  naverPw,
  openaiApiKey,
  scratchDir,
  chromePort = null,
  sendLog = null,
} = {}) {
  const slog = (msg) => {
    const line = `[NAVER_MAIL] ${msg}`;
    if (sendLog) sendLog(line);
    console.log(line);
  };

  const mailPage = await mailBrowser.newPage();
  mailPage.setDefaultTimeout(60000);

  try {
    slog('네이버 로그인 (GPT 캡챠)...');
    await loginNaverWithCaptcha(mailPage, {
      naverId,
      naverPw,
      openaiApiKey,
      scratchDir,
      sendLog: (line) => slog(line.replace(/^\[NAVER_LOGIN\]\s*/, '')),
    });

    slog('네이버 메일함 이동...');
    try {
      await mailPage.goto(NAVER_MAIL_INBOX, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch {
      await mailPage.goto(NAVER_MAIL_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    if (!(await waitForMailInbox(mailPage))) {
      throw new Error('네이버 메일함 로딩 시간 초과');
    }
    await sleep(2000);

    slog('Netlify 인증 메일 검색...');
    await searchNetlifyMail(mailPage).catch(() => {});

    let mailOpened = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const rowText = await clickNetlifyMailRow(mailPage);
      if (rowText) {
        slog(`메일 클릭: ${rowText.replace(/\s+/g, ' ').slice(0, 70)}...`);
        mailOpened = true;
        await sleep(2000);
        await clickNetlifyMailRow(mailPage).catch(() => {});
        break;
      }
      slog(`메일 목록 재탐색 (${attempt + 1}/8)...`);
      await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2500);
    }

    if (!mailOpened) {
      slog('메일 목록 자동 클릭 실패 — 수동으로 Netlify 메일을 열어주세요');
    }

    slog('메일 본문 로딩 대기...');
    if (!(await waitForMailBody(mailPage, slog, 45000))) {
      slog('메일 본문 대기 시간 초과 — 링크 탐색 계속 시도');
    }
    await sleep(2000);

    let verifyUrl = '';
    let linkResult = null;

    for (let attempt = 0; attempt < 12; attempt++) {
      linkResult = await clickVerifyLinkInMail(mailPage, slog);
      if (linkResult?.href) {
        verifyUrl = linkResult.href;
        break;
      }

      const found = await findNetlifyVerifyLink(mailPage);
      if (found?.href) {
        verifyUrl = found.href;
        slog(`링크 URL 추출: ${verifyUrl.slice(0, 90)}...`);
        break;
      }

      slog(`메일 본문 링크 탐색 (${attempt + 1}/12)...`);
      await sleep(2500);
    }

    if (!verifyUrl && linkResult?.clicked) {
      const tabUrl = await waitForNewTabUrl(mailBrowser, 12000);
      if (tabUrl) {
        verifyUrl = tabUrl;
        slog(`새 탭에서 인증 URL 확인: ${tabUrl.slice(0, 90)}`);
      }
    }

    if (!verifyUrl) {
      throw new Error('Netlify 인증 링크를 찾지 못했습니다. 메일 본문이 열렸는지 확인하세요.');
    }

    slog(`인증 링크: ${verifyUrl.slice(0, 100)}...`);

    if (chromePort) {
      await openVerifyInNetlifyChrome(verifyUrl, chromePort, slog);
    } else {
      const verifyPage = await mailBrowser.newPage();
      await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await sleep(4000);
      slog(`인증 페이지: ${verifyPage.url().slice(0, 80)}`);
      await verifyPage.close().catch(() => {});
    }

    slog('✅ Netlify 이메일 인증 완료');
    return { verifyUrl, success: true };
  } finally {
    await mailPage.close().catch(() => {});
  }
}
