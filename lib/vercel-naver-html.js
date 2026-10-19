/**
 * 서치어드바이저에서 HTML 파일 소유확인 파일을 받아 사이트 루트에 저장한다.
 * 소유확인 버튼은 누르지 않는다. 배포 후에 따로 누른다.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const BOARD = 'https://searchadvisor.naver.com/console/board';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

function verifyUrl(siteUrl) {
  return `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(siteUrl)}`;
}

async function clickExactLabel(page, label) {
  const hit = await page.evaluate((labelText) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    let titleEl = null;
    for (const el of document.querySelectorAll('.title.black--text, .title, div.title, label, span, div')) {
      if (norm(el.textContent) === labelText) { titleEl = el; break; }
    }
    const radio = document.querySelector('input[type="radio"][value="file"]')
      || document.querySelector('input[type="radio"][value="html"]');
    if (radio) {
      radio.click();
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const target = titleEl
      ? (titleEl.closest('label, .v-radio, .v-card, [role="radio"], .v-list-item') || titleEl)
      : radio;
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    try { target.click(); } catch { /* ignore */ }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label).catch(() => null);
  if (!hit) return false;
  try { await page.mouse.click(hit.x, hit.y, { delay: 40 }); } catch { /* ignore */ }
  return true;
}

async function readHtmlFileOffer(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const nameMatch = text.match(/naver[a-z0-9_-]{4,}\.html/i);
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: a.href || '',
      text: (a.textContent || '').trim(),
      download: a.getAttribute('download') || '',
    }));
    const link = links.find((l) => /naver.+\.html/i.test(`${l.href} ${l.text} ${l.download}`));
    return {
      name: nameMatch ? nameMatch[0] : (link?.download || link?.text || ''),
      href: link?.href || '',
    };
  }).catch(() => ({ name: '', href: '' }));
}

function looksLikeVerification(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 20000) return false;
  if (/nid\.naver\.com/.test(t) && !/naver-site-verification/i.test(t)) return false;
  return true;
}

function decodeDataUrl(href) {
  const comma = href.indexOf(',');
  if (comma < 0) return '';
  const meta = href.slice(0, comma);
  const data = href.slice(comma + 1);
  try {
    if (/;base64/i.test(meta)) return Buffer.from(data, 'base64').toString('utf8');
    return decodeURIComponent(data);
  } catch {
    return '';
  }
}

async function fetchFileText(page, href) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }, href).catch((e) => ({ ok: false, status: 0, text: '', error: e.message }));
}

async function fetchWithBrowserCookies(page, href) {
  const cookies = await page.cookies(href).catch(() => []);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
  const res = await fetch(href, {
    redirect: 'follow',
    headers: {
      Cookie: cookieHeader,
      Referer: 'https://searchadvisor.naver.com/',
      'User-Agent': ua || 'Mozilla/5.0',
      Accept: 'text/html,*/*',
    },
  });
  const text = await res.text();
  if (!res.ok) return '';
  return text;
}

async function armDownloadCapture(page) {
  await page.evaluate(() => {
    if (window.__naverCapInstalled) return;
    window.__naverCapInstalled = true;
    window.__naverCap = { text: '', name: '' };
    const saveText = (text, name) => {
      const t = String(text || '');
      if (!t.trim() || t.length > 20000) return;
      if (/nid\.naver\.com/.test(t)) return;
      window.__naverCap.text = t;
      if (name) window.__naverCap.name = name;
    };
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      try {
        if (obj && typeof obj.text === 'function') {
          obj.text().then((t) => saveText(t)).catch(() => {});
        }
      } catch { /* ignore */ }
      return origCreate.call(this, obj);
    };
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const disp = res.headers.get('content-disposition') || '';
        const reqUrl = String(args[0]?.url || args[0] || '');
        if (/naver.+\.html/i.test(`${reqUrl} ${disp}`) || /attachment/i.test(disp)) {
          const name = (disp.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i) || [])[1] || '';
          saveText(await res.clone().text(), decodeURIComponent(name));
        }
      } catch { /* ignore */ }
      return res;
    };
  }).catch(() => {});
}

async function readCapturedDownload(page) {
  return page.evaluate(() => window.__naverCap || { text: '', name: '' }).catch(() => ({ text: '', name: '' }));
}

async function clickHtmlConfirmFile(page) {
  const hit = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const links = Array.from(document.querySelectorAll('a.api_link, a'));
    const el = links.find((a) => norm(a.textContent) === 'HTML 확인 파일')
      || links.find((a) => /HTML\s*확인\s*파일/.test(norm(a.textContent)));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    try { el.click(); } catch { /* ignore */ }
    return { x: r.left + Math.max(r.width, 4) / 2, y: r.top + Math.max(r.height, 4) / 2 };
  }).catch(() => null);
  if (!hit) return false;
  try { await page.mouse.click(hit.x, hit.y, { delay: 40 }); } catch { /* ignore */ }
  return true;
}

async function clickDownloadControl(page) {
  if (await clickHtmlConfirmFile(page)) return true;
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], .v-btn'));
    const el = nodes.find((n) => /다운로드/.test(norm(n.innerText || n.textContent || '')));
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }).catch(() => false);
}

async function clickDownloadAndRead(page) {
  let captured = '';
  const onResponse = async (res) => {
    if (captured) return;
    try {
      const headers = res.headers();
      const disp = headers['content-disposition'] || '';
      const hit = /naver[a-z0-9_-]{4,}\.html/i.test(`${res.url()} ${disp}`)
        || (/attachment/i.test(disp) && /html/i.test(`${disp} ${headers['content-type'] || ''}`));
      if (!hit) return;
      const text = await res.text();
      if (text.trim()) captured = text;
    } catch { /* ignore */ }
  };
  page.on('response', onResponse);
  try {
    const clicked = await clickDownloadControl(page);
    if (!clicked) return '';
    for (let i = 0; i < 24 && !captured; i++) await sleep(300);
    return captured;
  } finally {
    page.off('response', onResponse);
  }
}

async function downloadByClickToDisk(page) {
  const dir = path.join(os.tmpdir(), `naver-html-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const client = await page.createCDPSession();
  try {
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dir,
      eventsEnabled: true,
    });
  } catch {
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dir,
    });
  }
  const clicked = await clickDownloadControl(page);
  if (!clicked) return '';
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(dir).filter((name) => /\.html?$/i.test(name) && !name.endsWith('.crdownload'));
    if (files.length) return fs.readFileSync(path.join(dir, files[0]), 'utf8');
    await sleep(400);
  }
  return '';
}

async function readOfferBody(page, offer, sendLog) {
  await armDownloadCapture(page);
  const dir = path.join(os.tmpdir(), `naver-html-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  let client = null;
  try {
    client = await page.createCDPSession();
    try {
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
        eventsEnabled: true,
      });
    } catch {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    }
  } catch { /* 클릭으로 받은 내용을 우선 사용 */ }

  relay(sendLog, 'HTML 확인 파일 클릭…');
  const clicked = await clickHtmlConfirmFile(page);
  if (!clicked) relay(sendLog, '⚠ HTML 확인 파일 링크를 찾지 못함');

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const cap = await readCapturedDownload(page);
    if (looksLikeVerification(cap.text)) {
      if (cap.name) offer.name = offer.name || cap.name;
      return cap.text;
    }
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => /\.html?$/i.test(name) && !name.endsWith('.crdownload'))
      : [];
    if (files.length) {
      offer.name = offer.name || files[0];
      return fs.readFileSync(path.join(dir, files[0]), 'utf8');
    }
    await sleep(400);
  }

  const href = String(offer.href || '').trim();
  if (href.startsWith('data:')) {
    const decoded = decodeDataUrl(href);
    if (looksLikeVerification(decoded)) return decoded;
  }
  if (/^blob:/i.test(href)) {
    const viaPage = await fetchFileText(page, href);
    if (viaPage.ok && looksLikeVerification(viaPage.text)) return viaPage.text;
  }
  return '';
}

/**
 * @returns {{ fileName: string, filePath: string }}
 */
export async function downloadNaverOwnershipHtml({ page, siteUrl, siteDir, sendLog }) {
  if (!page) throw new Error('서치어드바이저 창이 없습니다.');
  const url = String(siteUrl || '').trim().replace(/\/$/, '');
  if (!url) throw new Error('사이트 주소가 없습니다.');
  fs.mkdirSync(siteDir, { recursive: true });

  const { ensureAdvisorPage } = await import('./naver-register.js');
  relay(sendLog, '서치어드바이저에 사이트 주소 등록…');
  await ensureAdvisorPage(page, BOARD, { settleMs: 1000, label: '보드' });
  const hostUrl = (() => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return url;
    }
  })();

  const typed = await page.evaluate((value) => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])'));
    const el = inputs.find((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 80 && r.height > 12 && !node.disabled;
    });
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    return true;
  }, hostUrl).catch(() => false);
  if (typed) {
    await page.keyboard.press('Enter');
    await sleep(1500);
  }

  relay(sendLog, 'HTML 파일 소유확인 화면으로 이동…');
  await page.goto(verifyUrl(hostUrl), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const clicked = await clickExactLabel(page, 'HTML 파일');
  if (!clicked) relay(sendLog, '⚠ HTML 파일 항목을 바로 누르지 못함 — 화면에 나온 파일명을 찾습니다');
  await sleep(1200);

  let offer = { name: '', href: '' };
  for (let i = 0; i < 8; i++) {
    offer = await readHtmlFileOffer(page);
    if (offer.name || offer.href) break;
    await sleep(700);
  }
  const fileName = String(offer.name || '').match(/naver[a-z0-9_-]{4,}\.html/i)?.[0]
    || String(offer.href || '').match(/naver[a-z0-9_-]{4,}\.html/i)?.[0]
    || '';
  if (!fileName && !offer.href) {
    throw new Error('서치어드바이저에서 HTML 소유확인 파일을 찾지 못했습니다. 로그인된 창에서 HTML 파일 항목이 보이는지 확인하세요.');
  }

  relay(sendLog, `소유확인 파일 받는 중: ${fileName || offer.href}`);
  const body = await readOfferBody(page, offer, sendLog);
  if (!String(body || '').trim()) {
    throw new Error('HTML 소유확인 파일을 받지 못해 배포·소유확인·수집을 시작하지 못했습니다.');
  }
  const safeName = fileName || 'naver-verification.html';
  const filePath = path.join(siteDir, safeName);
  fs.writeFileSync(filePath, body, 'utf8');
  relay(sendLog, `✔ 소유확인 파일 저장: ${safeName}`);
  return { fileName: safeName, filePath };
}
