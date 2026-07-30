import { launchBrowser } from './puppeteer-launch.js';
import fs from 'fs';
import path from 'path';
import { log as sharedLog, step, action, error, warn } from './logger.js';
import { solveCaptcha, refreshCaptchaImage, detectCaptcha, isPlausibleCaptchaCode } from './captcha-solver.js';
import { loginNaverForSearchAdvisor } from './naver-login-wait.js';

export { solveCaptcha, refreshCaptchaImage, detectCaptcha } from './captcha-solver.js';

const NAVER_LOGIN = 'https://nid.naver.com/nidlogin.login?mode=form&url=https://www.naver.com';
const BOARD = 'https://searchadvisor.naver.com/console/board';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toISOString().substring(11, 19); }

/** 네이티브 alert/confirm 자동 확인(accept) + Enter 폴백 */
function attachAcceptDialogs(page, label = '확인 창') {
  let lastMsg = '';
  let accepted = 0;
  const onDialog = async (dialog) => {
    lastMsg = dialog.message() || '';
    log(`     🔔 ${label}: "${lastMsg.replace(/\s+/g, ' ').slice(0, 90)}"`);
    try {
      await dialog.accept();
      accepted += 1;
      log('     👆 확인(accept)');
    } catch (e) {
      log(`     ⚠ 확인 창 처리 오류: ${e.message}`);
    }
  };
  page.on('dialog', onDialog);
  return {
    get lastMsg() { return lastMsg; },
    get accepted() { return accepted; },
    async waitForDialog(timeoutMs = 4000) {
      const before = accepted;
      const deadline = Date.now() + timeoutMs;
      while (accepted === before && Date.now() < deadline) {
        await sleep(120);
      }
      if (accepted === before) {
        try {
          await page.keyboard.press('Enter');
          log('     ⌨ Enter 전송 (확인 창 대응)');
          await sleep(350);
        } catch { /* ignore */ }
      }
      return accepted > before;
    },
    detach() {
      try { page.off('dialog', onDialog); } catch { /* ignore */ }
    },
  };
}

function buildVerifyUrl(siteUrl) {
  return `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(siteUrl)}`;
}

function isVerifyUrl(url = '') {
  return /\/console\/verify(\?|\/|$)/i.test(url) || /[?&]site=/i.test(url) && /verify/i.test(url);
}

async function hasVerifyPageUi(page) {
  return page.evaluate(() => {
    const url = location.href || '';
    // 보드(사이트 목록) 화면은 소유확인 UI가 아님
    if (/\/console\/board/i.test(url) && !/verify/i.test(url)) {
      const body = document.body?.innerText || '';
      if (/사이트\s*목록|최대\s*100개\s*사이트/i.test(body)
        && !document.querySelector('input[type="radio"][value="meta"]')) {
        return false;
      }
    }
    if (document.querySelector('input[type="radio"][value="meta"]')) return true;
    for (const lbl of document.querySelectorAll('label')) {
      if (/HTML\s*태그/i.test(lbl.textContent || '')) return true;
    }
    // 메타 코드 스니펫이 보이면 소유확인 화면
    const text = document.body?.innerText || '';
    if (/naver-site-verification/i.test(text)) return true;
    if (/HTML\s*태그/.test(text) && /소유\s*확인/.test(text) && !/사이트\s*목록/.test(text)) return true;
    return false;
  }).catch(() => false);
}

/** SPA 전환 대기 — verify URL 또는 실제 소유확인 UI만 성공 */
async function waitForVerifyScreen(page, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (isVerifyUrl(url)) return true;
    if (await hasVerifyPageUi(page)) return true;
    await sleep(600);
  }
  return false;
}

/** 라이브 사이트에 네이버 인증 메타가 반영될 때까지 대기 */
async function waitUntilMetaLive(siteUrl, content, { maxWaitMs = 45000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt += 1;
    try {
      const resp = await fetch(siteUrl, {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        redirect: 'follow',
      });
      const html = await resp.text();
      if (html.includes(content) || new RegExp(`naver-site-verification[^>]{0,80}${content}`, 'i').test(html)) {
        log(`     ✅ 라이브 메타 확인 (${attempt}회): ${siteUrl}`);
        return true;
      }
      log(`     ⏳ 라이브 메타 미반영 (${attempt}회)...`);
    } catch (e) {
      log(`     ⚠ 라이브 메타 확인 실패: ${e.message}`);
    }
    await sleep(intervalMs);
  }
  return false;
}

export class CreditExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreditExceededError';
  }
}

async function openVerifyPage(page, siteUrl) {
  const verifyUrl = buildVerifyUrl(siteUrl);
  log(`     verify 페이지 이동: ${verifyUrl}`);
  await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  if (await waitForVerifyScreen(page, 12000)) return true;

  await page.goto(verifyUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() =>
    page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
  );
  await sleep(3000);
  return waitForVerifyScreen(page, 20000);
}

/** 서치어드바이저 보드 URL 입력창 — Vuetify 동적 id(#input-141)에 의존하지 않음 */
async function waitForBoardUrlInput(page, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (/nid\.naver\.com/i.test(url)) {
      log('     ⚠ 로그인 페이지로 이동됨 — 수동 로그인 대기...');
      await sleep(3000);
      continue;
    }
    const found = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"], input[type="url"], input[type="search"], input:not([type]), textarea',
      ));
      const scored = [];
      for (const el of inputs) {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 12 || r.bottom < 0 || r.top > innerHeight) continue;
        if (el.disabled || el.readOnly) continue;
        const meta = `${el.id || ''} ${el.name || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
        let score = r.width;
        if (/url|사이트|주소|http|도메인|등록/i.test(meta)) score += 1000;
        if (/input-\d+/i.test(el.id || '')) score += 200;
        scored.push({ score, id: el.id || '', placeholder: el.placeholder || '', el });
      }
      scored.sort((a, b) => b.score - a.score);
      if (!scored.length) return null;
      const best = scored[0];
      best.el.setAttribute('data-nrc-board-input', '1');
      return { id: best.id, placeholder: best.placeholder, score: best.score };
    });
    if (found) return found;
    await sleep(600);
  }
  return null;
}

/** 보드 등록용 URL — 경로 없이 호스트(스킴 포함)만 */
function toBoardHostUrl(siteUrl) {
  try {
    const u = new URL(String(siteUrl || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(siteUrl || '').trim().replace(/\/+$/, '');
  }
}

async function typeBoardUrl(page, siteUrl) {
  const url = toBoardHostUrl(siteUrl);
  // Vuetify 입력은 value 직접 대입 + 키보드 재입력을 같이 하면 이어붙음
  // → native setter로 한 번만 설정
  const typed = await page.evaluate((value) => {
    const el = document.querySelector('[data-nrc-board-input="1"]')
      || document.querySelector('input[type="text"]')
      || document.querySelector('input[type="url"]');
    if (!el) return { ok: false, value: '' };
    el.focus();
    el.click();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: true, value: el.value || '' };
  }, url);

  if (!typed?.ok) {
    const input = await page.$('[data-nrc-board-input="1"]') || await page.$('input[type="text"]');
    if (!input) throw new Error('URL 입력 필드 없음');
    await input.click({ clickCount: 3 });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await input.type(url, { delay: 15 });
  } else if (typed.value !== url) {
    // setter가 Vue에 반영 안 된 경우만 키보드로 교체
    const input = await page.$('[data-nrc-board-input="1"]') || await page.$('input[type="text"]');
    if (input) {
      await input.click({ clickCount: 3 });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await input.type(url, { delay: 15 });
    }
  }

  const finalValue = await page.evaluate(() => {
    const el = document.querySelector('[data-nrc-board-input="1"]')
      || document.querySelector('input[type="text"]')
      || document.querySelector('input[type="url"]');
    return el ? (el.value || '') : '';
  });
  if (finalValue && finalValue !== url) {
    log(`     ⚠ 입력값 불일치 (기대=${url}, 실제=${finalValue}) — 재설정`);
    await page.evaluate((value) => {
      const el = document.querySelector('[data-nrc-board-input="1"]')
        || document.querySelector('input[type="text"]')
        || document.querySelector('input[type="url"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, url);
  }
}

let LOGS = [];
function log(msg) {
  const line = `[${now()}] ${msg}`;
  LOGS.push(line);
  console.log(line);
  sharedLog(`[NAVER] ${msg}`);
}
function saveLog(folder) {
  fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, 'naver-debug.log');
  fs.writeFileSync(p, LOGS.join('\n'), 'utf8');
  log(`로그 저장: ${p}`);
}

/** 버튼 정확히 클릭: evaluate로 좌표 계산 → mouse.click (Vuetify 대응) */
async function clickButtonByText(page, text) {
  action(`버튼 검색: "${text}"`);
  const res = await page.evaluate((kw) => {
    for (const btn of document.querySelectorAll('button, [role="button"], .v-btn')) {
      const t = btn.textContent.trim();
      if (t === kw || t.includes(kw)) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { ok: true, x: r.left + r.width/2, y: r.top + r.height/2 };
      }
    }
    return { ok: false };
  }, text);
  if (res.ok) {
    await page.mouse.click(res.x, res.y);
    log(`     🖱️ "${text}" 클릭`);
    return true;
  }
  warn(`     "${text}" 버튼 찾지 못함`);
  return false;
}

async function ss(page, name, folder) {
  try {
    const dir = path.join(folder, 'screenshots'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${name}.png`); await page.screenshot({ path: file, fullPage: true });
    log(`  📸 ${file}`); return file;
  } catch (e) { log(`  ⚠ ss: ${e.message}`); return ''; }
}

async function getMeta(page) {
  log('  🔍 메타 태그 추출...');

  const extractOnce = async () => {
    // 1) 숨겨진 실제 <meta> 태그
    const dom = await page.evaluate(() => {
      const el = document.querySelector('meta[name="naver-site-verification"]');
      return el ? el.getAttribute('content') : '';
    });
    if (dom && dom.length >= 16) return { value: dom, how: 'DOM' };

    // 2) code/pre/textarea/input 에 표시된 스니펫
    const fromBoxes = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll('code, pre, textarea, input[type="text"], input[readonly], .v-text-field input'),
      ];
      for (const el of nodes) {
        const t = (el.value || el.textContent || el.innerText || '').trim();
        if (!t) continue;
        const m = t.match(/naver-site-verification["'\s][^>]{0,80}content=["']([a-zA-Z0-9_-]{16,})["']/i)
          || t.match(/content=["']([a-zA-Z0-9_-]{16,})["'][^>]{0,80}naver-site-verification/i)
          || t.match(/name=["']naver-site-verification["'][^>]*content=["']([a-zA-Z0-9_-]{16,})["']/i);
        if (m?.[1]) return m[1];
        // content 값만 단독 표시되는 경우
        if (/^[a-f0-9]{20,}$/i.test(t)) return t;
      }
      return '';
    });
    if (fromBoxes) return { value: fromBoxes, how: 'BOX' };

    // 3) body 텍스트
    const fullText = await page.evaluate(() => {
      return (document.body?.innerText || '') + '\n' + (document.body?.textContent || '');
    });
    let m = fullText.match(/<meta[^>]*name=["']naver-site-verification["'][^>]*content=["']([^"']+)["']/i)
      || fullText.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']naver-site-verification["']/i)
      || fullText.match(/naver-site-verification["'\s=>]+[^a-z0-9_-]{0,40}([a-zA-Z0-9_-]{20,})/i);
    if (m?.[1] && m[1].length >= 16) return { value: m[1], how: 'TEXT' };

    const idx = fullText.indexOf('naver-site-verification');
    if (idx !== -1) {
      const snippet = fullText.substring(Math.max(0, idx - 120), idx + 400);
      m = snippet.match(/content=["']([a-zA-Z0-9_-]{16,})["']/i)
        || snippet.match(/([a-f0-9]{20,})/i);
      if (m?.[1]) return { value: m[1], how: 'SNIPPET' };
    }

    // 4) raw HTML (엔티티 디코드)
    const raw = await page.content();
    const html = raw
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#34;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    m = html.match(/<meta[^>]*name=["']naver-site-verification["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']naver-site-verification["']/i);
    if (m?.[1] && m[1].length >= 16) return { value: m[1], how: 'HTML' };

    // 5) 복사 버튼 근처 텍스트
    const nearCopy = await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button, a, span, div')) {
        const label = (btn.textContent || '').trim();
        if (!/복사|copy/i.test(label)) continue;
        let node = btn;
        for (let d = 0; d < 6 && node; d++) {
          const t = node.innerText || node.textContent || '';
          const mm = t.match(/content=["']([a-zA-Z0-9_-]{16,})["']/i)
            || t.match(/([a-f0-9]{20,})/i);
          if (mm?.[1]) return mm[1];
          node = node.parentElement;
        }
      }
      return '';
    });
    if (nearCopy) return { value: nearCopy, how: 'COPY' };

    return { value: '', how: '', textSample: fullText.replace(/\s+/g, ' ').slice(0, 200) };
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    const out = await extractOnce();
    if (out.value) {
      log(`  ✅ ${out.how}: ${out.value}`);
      return out.value;
    }
    log(`  ⚠ 메타 미검출 (시도 ${attempt}/5)`);
    if (attempt < 5) {
      // HTML 태그 방식 재선택
      await page.evaluate(() => {
        const radio = document.querySelector('input[type="radio"][value="meta"]');
        if (radio) radio.click();
        for (const lbl of document.querySelectorAll('label')) {
          if (/HTML\s*태그/i.test(lbl.textContent || '')) lbl.click();
        }
      });
      await sleep(2000);
    } else if (out.textSample) {
      log(`  📝 sample: ${out.textSample}`);
    }
  }

  log('  ⚠ 메타 태그 없음');
  return '';
}

export function injectMeta(folder, tag, htmlFileName = 'index.html') {
  const p = path.join(folder, htmlFileName);
  if (!fs.existsSync(p)) {
    // index.html이 명시되지 않았다면 index_*.html fallback
    if (htmlFileName === 'index.html') {
      const files = fs.readdirSync(folder).filter(f => /^index_[^\\/]+\.html$/i.test(f));
      if (files.length) {
        const fallback = files.sort()[0];
        return injectMeta(folder, tag, fallback);
      }
    }
    throw new Error(`HTML 파일을 찾을 수 없습니다: ${p}`);
  }
  let h = fs.readFileSync(p, 'utf8');
  if (h.includes('naver-site-verification') && h.includes(tag)) {
    log('  ℹ 메타 이미 존재');
    return;
  }
  // 기존 verification 메타 교체
  if (/naver-site-verification/i.test(h)) {
    h = h.replace(/<meta[^>]*naver-site-verification[^>]*>\s*/ig, '');
  }
  if (/<head[^>]*>/i.test(h)) {
    h = h.replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`);
  } else if (/<html[^>]*>/i.test(h)) {
    h = h.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n  ${tag}\n</head>`);
  } else {
    h = `${tag}\n${h}`;
  }
  fs.writeFileSync(p, h, 'utf8');
  log(`  🏷 메타 주입 완료: ${htmlFileName}`);
}

/** 폴더(하위 포함)의 모든 .html 에 네이버 인증 메타 주입 */
export function injectMetaAllHtml(folder, tag) {
  if (!fs.existsSync(folder)) throw new Error(`폴더 없음: ${folder}`);
  const skipDirs = new Set(['node_modules', '.git', '.netlify', '.ai-cache', '__pycache__']);
  const relFiles = [];
  const walk = (dir, prefix = '') => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.htaccess') {
        if (ent.isDirectory()) continue;
      }
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full, rel);
      } else if (/\.html?$/i.test(ent.name)) {
        relFiles.push(rel);
      }
    }
  };
  walk(folder);
  if (!relFiles.length) throw new Error(`HTML 파일이 없습니다: ${folder}`);
  for (const rel of relFiles) {
    const dir = path.dirname(path.join(folder, rel));
    const base = path.basename(rel);
    injectMeta(dir, tag, base);
  }
  log(`  🏷 메타 일괄 주입: ${relFiles.length}개 HTML`);
  return relFiles;
}


function getSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
  if (el.className && typeof el.className === 'string') {
    const cls = el.className.split(/\s+/).filter(Boolean)[0];
    if (cls) return `${el.tagName.toLowerCase()}.${cls}`;
  }
  if (el.placeholder) return `${el.tagName.toLowerCase()}[placeholder*="${el.placeholder.slice(0,4)}"]`;
  return el.tagName.toLowerCase();
}
/** 네이버 로그인 (서치어드바이저 작업용) */
export async function loginNaverForAdvisor(page, naverAccount, { openaiApiKey = '', outputFolder = './output', manualOnly = false } = {}) {
  let lastDialogMsg = '';
  page.on('dialog', async (dialog) => {
    lastDialogMsg = dialog.message();
    log(`     🔔 네이티브 팝업: "${lastDialogMsg.substring(0, 60)}"`);
    try { await dialog.accept(); } catch (e) { log(`     ⚠ 팝업 처리 오류: ${e.message}`); }
  });
  await loginNaverForSearchAdvisor(page, naverAccount, {
    openaiApiKey,
    outputFolder,
    log: (msg) => log(msg),
    screenshotFn: ss,
    getLastDialogMsg: () => lastDialogMsg,
    manualOnly,
  });
}

/** 서치어드바이저 site 파라미터용 URL 정규화 */
export function normalizeAdvisorSiteUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return String(raw || '').trim();
    u.hash = '';
    // 네이버 서치어드바이저는 루트도 trailing slash 없는 호스트 URL을 선호
    if (u.pathname === '/' || u.pathname === '') {
      return `${u.protocol}//${u.host}`;
    }
    let href = u.href;
    if (href.endsWith('/')) href = href.slice(0, -1);
    return href;
  } catch {
    return String(raw || '').trim();
  }
}

/** 설정 > 수집 주기 > 빠르게 */
export async function selectFastCrawlMode(page, siteUrl, outputFolder = './output') {
  const encodedSite = encodeURIComponent(normalizeAdvisorSiteUrl(siteUrl));
  log('     설정 페이지 이동 (빠르게)...');
  await page.goto(`https://searchadvisor.naver.com/console/site/option?site=${encodedSite}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);
  await ss(page, '09_settings', outputFolder);

  // 「빠르게」 선택 시 뜨는 alert: 「수집 주기 업데이트에 일부 시간이 소요될 수 있습니다…」
  let dialogMsg = '';
  let dialogAccepted = false;
  const onDialog = async (dialog) => {
    dialogMsg = dialog.message() || '';
    log(`     🔔 수집주기 확인 창: "${dialogMsg.replace(/\s+/g, ' ').slice(0, 80)}"`);
    try {
      await dialog.accept();
      dialogAccepted = true;
      log('     👆 확인(accept) 클릭');
    } catch (e) {
      log(`     ⚠ 확인 창 처리 오류: ${e.message}`);
    }
  };
  page.on('dialog', onDialog);

  try {
    const fastClicked = await page.evaluate(() => {
      const radio = document.querySelector('input[type="radio"][value="fast"]');
      if (radio) { radio.click(); return 'radio[value=fast]'; }
      for (const lbl of document.querySelectorAll('label')) {
        if (/빠르게/.test(lbl.textContent || '')) {
          const inp = lbl.querySelector('input[type="radio"]') || document.getElementById(lbl.getAttribute('for'));
          if (inp) { inp.click(); return 'label 빠르게'; }
          lbl.click();
          return 'label 빠르게(텍스트)';
        }
      }
      // 라디오 옆 텍스트 노드
      for (const el of document.querySelectorAll('input[type="radio"]')) {
        const wrap = el.closest('label, .v-radio, .v-selection-control, li, div') || el.parentElement;
        if (wrap && /빠르게/.test(wrap.textContent || '')) {
          el.click();
          return 'wrap 빠르게';
        }
      }
      return '';
    }).catch(() => '');

    if (fastClicked) log(`     👆 ${fastClicked}`);
    else log('     ⚠ 빠르게 못 찾음');

    // alert 등장·처리 대기
    const deadline = Date.now() + 5000;
    while (!dialogAccepted && Date.now() < deadline) {
      await sleep(150);
    }

    if (!dialogAccepted) {
      // 핸들러가 못 잡았을 때 Enter로 한 번 더 시도
      try {
        await page.keyboard.press('Enter');
        log('     ⌨ Enter 전송 (확인 창 대응)');
        await sleep(400);
      } catch { /* ignore */ }
    } else if (/수집\s*주기|새로고침|시간이\s*소요/i.test(dialogMsg)) {
      log('     ✅ 수집주기 안내 확인 완료');
    }

    await sleep(1200);
    await ss(page, '10_fast_selected', outputFolder);
    return !!fastClicked;
  } finally {
    try { page.off('dialog', onDialog); } catch { /* ignore */ }
  }
}

/** 요청 > robots.txt 검증 페이지에서 「수집 요청」 클릭 */
export async function requestRobotsTxtCollect(page, siteUrl, outputFolder = './output') {
  const encodedSite = encodeURIComponent(normalizeAdvisorSiteUrl(siteUrl));
  const robotsPage = `https://searchadvisor.naver.com/console/site/check/robots?site=${encodedSite}`;
  log('     robots.txt 수집 요청 페이지 이동...');
  log(`     URL: ${robotsPage}`);

  // 페이지 진입/버튼 클릭 시: 「robots.txt가 수집되지 않았습니다. 수집 요청해주세요.」
  const dialogs = attachAcceptDialogs(page, 'robots.txt 확인 창');

  try {
    try {
      await page.goto(robotsPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      log(`     ⚠ robots 페이지 이동 실패: ${e.message}`);
      return { ok: false, reason: e.message };
    }
    // 진입 직후 alert가 뜨면 확인
    await dialogs.waitForDialog(3500);
    await sleep(1500);

    // 사이드 메뉴 robots.txt 항목이 있으면 한번 더 클릭 (SPA 활성화)
    await page.evaluate(() => {
      const nodes = document.querySelectorAll(
        '.item_title_DdItX, .submenu_item_DSGA1, .v-list-item__title, .v-list-item, a, button, div',
      );
      for (const el of nodes) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^robots\.txt$/i.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
    await dialogs.waitForDialog(2500);
    await sleep(800);
    await ss(page, '11_robots_page', outputFolder).catch(() => {});

    const clicked = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      if (/등록되지\s*않은\s*사이트|권한이\s*없/.test(body)
        && !/robots\.txt|수집\s*요청/.test(body)) {
        return { ok: false, reason: '사이트 미등록/권한 없음' };
      }

      const candidates = [];
      for (const btn of document.querySelectorAll(
        'button, a, [role="button"], .v-btn, input[type="button"], input[type="submit"]',
      )) {
        const txt = (btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim();
        if (!/수집\s*요청/.test(txt)) continue;
        if (/삭제|취소|내역/.test(txt) && !/^수집\s*요청$/.test(txt)) continue;
        const r = btn.getBoundingClientRect();
        if (r.width < 20 || r.height < 10 || r.bottom < 0 || r.top > innerHeight) continue;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('v-btn--disabled')) continue;
        // robots 본문/카드 근처 버튼을 우선
        const nearRobots = !!(btn.closest('[class*="robots"], [class*="Robots"]')
          || /robots/i.test(btn.closest('.v-card, .card, section, main')?.innerText?.slice(0, 200) || ''));
        candidates.push({
          el: btn,
          txt,
          y: r.top,
          score: (nearRobots ? 1000 : 0) + r.width,
        });
      }
      candidates.sort((a, b) => b.score - a.score || a.y - b.y);
      if (!candidates.length) return { ok: false, reason: '수집 요청 버튼 없음' };
      const pick = candidates[0];
      pick.el.click();
      return { ok: true, button: pick.txt };
    }).catch((e) => ({ ok: false, reason: e.message }));

    if (!clicked?.ok) {
      log(`     ⚠ robots.txt 수집 요청 실패: ${clicked?.reason || 'unknown'}`);
      await ss(page, '11_robots_fail', outputFolder).catch(() => {});
      return clicked || { ok: false, reason: 'unknown' };
    }
    log(`     👆 robots.txt ${clicked.button}`);
    // 수집요청 후 또 alert가 뜨면 확인
    await dialogs.waitForDialog(4000);
    await sleep(800);

    // DOM 모달(확인/닫기) 처리
    const modal = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, .v-btn, [role="button"]'));
      for (const btn of buttons) {
        const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^(확\s*인|확인|닫기|OK|예)$/i.test(txt)) continue;
        const dlg = btn.closest('.v-dialog, [role="dialog"], .v-overlay__content, .modal, .ly_pop');
        if (!dlg) continue;
        const r = btn.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) continue;
        btn.click();
        return txt;
      }
      return '';
    }).catch(() => '');
    if (modal) {
      log(`     👆 robots 모달: ${modal}`);
      await sleep(1000);
    }

    await ss(page, '11_robots_requested', outputFolder).catch(() => {});
    log('     ✅ robots.txt 수집 요청 완료');
    return { ok: true, button: clicked.button, modal, dialogMsg: dialogs.lastMsg || '' };
  } finally {
    dialogs.detach();
  }
}

/** 수집 폼 입력창이 나타날 때까지 대기 */
async function waitForAdvisorFormInput(page, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const found = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        // 미등록/권한 없음 화면
        if (/등록되지\s*않은\s*사이트|소유\s*확인|권한이\s*없|사이트\s*등록\s*후/.test(body)
          && !document.querySelector('input[type="text"], input[type="url"], textarea')) {
          return { ok: false, blocked: true, reason: '사이트 미등록/권한 없음 화면' };
        }
        const inputs = Array.from(document.querySelectorAll(
          'input[type="text"], input[type="url"], input:not([type]), textarea',
        ));
        let best = null;
        let bestScore = -1;
        for (const el of inputs) {
          const r = el.getBoundingClientRect();
          if (r.width < 60 || r.height < 10 || r.bottom < 0 || r.top > innerHeight) continue;
          if (el.disabled || el.readOnly) continue;
          const meta = `${el.id || ''} ${el.name || ''} ${el.placeholder || ''} ${el.className || ''}`;
          let score = r.width;
          if (/url|사이트|주소|http|sitemap|수집|요청/i.test(meta)) score += 800;
          if (/input-\d+/i.test(el.id || '')) score += 200;
          if (score > bestScore) {
            bestScore = score;
            best = {
              id: el.id || '',
              placeholder: el.placeholder || '',
              score,
            };
          }
        }
        if (!best) return { ok: false, blocked: false, reason: 'input 없음' };
        return { ok: true, ...best };
      });
      if (found?.blocked) return found;
      if (found?.ok) return found;
    } catch (e) {
      if (/detached Frame|Execution context was destroyed|Target closed/i.test(e.message || '')) {
        await sleep(800);
        continue;
      }
      throw e;
    }
    await sleep(500);
  }
  return { ok: false, blocked: false, reason: 'input 없음 (대기 시간 초과)' };
}

/** 서치어드바이저 텍스트 입력 폼 제출 (사이트맵·웹페이지 수집 등) */
export async function submitAdvisorTextRequest(page, formPageUrl, value, outputFolder = './output', { screenshotTag = 'form' } = {}) {
  const tryOnce = async () => {
    await page.goto(formPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    // SPA 렌더 추가 대기
    try {
      await page.waitForSelector('input[type="text"], input[type="url"], textarea, .v-text-field', {
        timeout: 12000,
      });
    } catch { /* continue — waitForAdvisorFormInput 에서 재확인 */ }

    const found = await waitForAdvisorFormInput(page, 20000);
    await ss(page, screenshotTag, outputFolder).catch(() => {});

    if (!found?.ok) {
      return { ok: false, reason: found?.reason || 'input 없음', value: '' };
    }

    const submitted = await page.evaluate((targetUrl) => {
      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"], input[type="url"], input:not([type]), textarea',
      ));
      let input = null;
      let best = -1;
      for (const el of inputs) {
        const r = el.getBoundingClientRect();
        if (r.width < 60 || r.height < 10) continue;
        if (el.disabled || el.readOnly) continue;
        const meta = `${el.id || ''} ${el.placeholder || ''} ${el.className || ''}`;
        let score = r.width;
        if (/url|사이트|주소|http|sitemap|수집|요청/i.test(meta)) score += 800;
        if (score > best) { best = score; input = el; }
      }
      if (!input) return { ok: false, reason: 'input 없음' };

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      input.focus();
      input.click();
      if (setter) setter.call(input, targetUrl);
      else input.value = targetUrl;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      for (const btn of document.querySelectorAll('button, a, div[role="button"], input[type="button"], input[type="submit"]')) {
        const txt = (btn.textContent || btn.value || '').trim();
        if (/^(확\s*인|확인|제출|등록|추가|요청)$/.test(txt)) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            btn.click();
            return { ok: true, button: txt, value: input.value };
          }
        }
      }
      return { ok: false, reason: '확인 버튼 없음', value: input.value };
    }, value);

    await sleep(2500);
    return submitted;
  };

  try {
    return await tryOnce();
  } catch (e) {
    const msg = e?.message || '';
    if (/detached Frame|Execution context was destroyed|Target closed|Session closed/i.test(msg)) {
      log(`     ⚠ 프레임 detach — 페이지 재진입 후 1회 재시도 (${msg.slice(0, 80)})`);
      await sleep(1500);
      try {
        return await tryOnce();
      } catch (e2) {
        return { ok: false, reason: e2.message || msg };
      }
    }
    return { ok: false, reason: msg };
  }
}

/** 네이버 서치어드바이저 웹페이지 수집(인덱싱) 신청 */
export async function requestNaverIndexing(page, siteUrl, outputFolder = './output') {
  log('  인덱싱(수집) 신청 시작...');
  const normalized = normalizeAdvisorSiteUrl(siteUrl);
  const encodedSite = encodeURIComponent(normalized);

  await selectFastCrawlMode(page, normalized, outputFolder);

  log('     robots.txt 수집 요청...');
  const robots = await requestRobotsTxtCollect(page, normalized, outputFolder);
  if (!robots?.ok) log(`     ⚠ robots.txt 수집 요청 스킵/실패: ${robots?.reason || 'unknown'}`);

  log('     웹 페이지 수집 페이지 이동...');
  const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodedSite}`;
  log(`     URL: ${crawlPage}`);

  log('     URL 입력 및 수집 요청...');
  const submitted = await submitAdvisorTextRequest(page, crawlPage, normalized, outputFolder, { screenshotTag: '12_crawl_page' });
  if (submitted.ok) log(`     👆 확인 클릭: ${submitted.button}`);
  else log(`     ⚠ 수집 요청 실패: ${submitted.reason} (value=${submitted.value || ''})`);
  await sleep(1000);

  log('     수집 요청 내역 확인...');
  let crawlRegistered = false;
  for (let check = 0; check < 6; check++) {
    const found = await page.evaluate((targetUrl) => {
      const bodyText = document.body.innerText;
      return bodyText.includes(targetUrl.replace('https://', '')) && /\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2}/.test(bodyText);
    }, normalized);
    if (found) { crawlRegistered = true; break; }
    await sleep(2000);
  }
  if (crawlRegistered) log('     ✅ 웹 페이지 수집 등록 확인');
  else log('     ⚠ 수집 요청 내역 확인 실패 (계속 진행)');

  await ss(page, '13_index_done', outputFolder);
  log('  ✅ 인덱싱 신청 완료');
  return { crawlRegistered };
}

export async function registerNaverSites({
  sites,
  redeployCallback,
  headless = false,
  metaInjectOnly = false,
  openaiApiKey = '',
  naverAccount = null,
  /** 라이브 메타 미확인 시 redeployCallback 추가 호출 허용 (Netlify 크레딧 절약 시 false) */
  extraRedeployOnMiss = true,
  /** 공유 세션 — 있으면 새 브라우저를 띄우지 않음 */
  browser: externalBrowser = null,
  page: externalPage = null,
  keepBrowserOpen = false,
  skipLogin = false,
} = {}) {
  LOGS = []; log('🚀 naver-register 시작');
  step(`registerNaverSites: sites=${sites.length}, headless=${headless}, metaInjectOnly=${metaInjectOnly}, extraRedeploy=${extraRedeployOnMiss}, account=${naverAccount?.id || '없음'}, shared=${!!externalBrowser}`);
  const ownsBrowser = !externalBrowser;
  const browser = externalBrowser || await launchBrowser({
    headless, args: ['--window-size=1400,900','--window-position=100,100'],
    defaultViewport: { width: 1400, height: 900 }
  });
  let page = externalPage;
  if (!page) {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  }
  log(ownsBrowser ? '브라우저 페이지 생성 완료' : '공유 네이버 세션 사용');

  // 네이티브 alert/confirm — 삭제 확인은 거부, 소유확인 성공은 즉시 플래그
  let lastDialogMsg = '';
  let ownershipDoneByDialog = false;
  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    lastDialogMsg = msg;
    log(`     🔔 네이티브 팝업 감지: "${msg.substring(0, 80)}"`);
    try {
      if (/삭제\s*하시겠습니까|삭제\s*할|영구\s*삭제|정말\s*삭제/i.test(msg)) {
        await dialog.dismiss();
        log('     ⛔ 삭제 확인 팝업 → 거부(dismiss)');
        return;
      }
      if (/완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/i.test(msg)) {
        ownershipDoneByDialog = true;
      }
      await dialog.accept();
      log('     ✅ 팝업 자동 확인(accept) 처리');
    } catch (e) {
      log(`     ⚠ 팝업 처리 오류: ${e.message}`);
    }
  };
  page.on('dialog', onDialog);

  const results = [];
  let abortRemaining = null;
  try {
    // 1) 로그인 (공유 세션이면 생략)
    if (!skipLogin) {
      await loginNaverForSearchAdvisor(page, naverAccount, {
        openaiApiKey,
        outputFolder: sites[0]?.folder || './output/site',
        log: (msg) => log(msg),
        screenshotFn: ss,
        getLastDialogMsg: () => lastDialogMsg,
      });
    } else {
      log('공유 세션 — 로그인 생략');
    }

    for (const site of sites) {
      if (abortRemaining) {
        results.push({
          url: site.url,
          name: site.name,
          status: 'error',
          error: abortRemaining,
          naverAccountId: naverAccount?.id || '',
          registeredAt: new Date().toISOString(),
        });
        continue;
      }
      log(`\n========================================`);
      log(`📝 [${site.name}]: ${site.url}`);
      log(`========================================`);
      try {
        // (A) console/board 이동
        log('  (A) console/board 이동...');
        await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
        log('     URL 입력창 대기 (동적 id 대응)...');
        let boardInput = await waitForBoardUrlInput(page, 45000);
        if (!boardInput) {
          log('     ⚠ 보드 입력창 없음 — 새로고침 후 재시도');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await sleep(2000);
          boardInput = await waitForBoardUrlInput(page, 30000);
        }
        if (!boardInput) {
          log('     ⚠ 보드 입력 실패 — verify 페이지 직접 이동으로 우회');
          const ok = await openVerifyPage(page, site.url);
          if (!ok) throw new Error(`보드 URL 입력창을 찾지 못함 (현재: ${page.url()})`);
          log(`     ✅ verify 우회 성공: ${page.url()}`);
        } else {
          log(`     ✅ 입력창 감지 (id=${boardInput.id || '없음'}, score=${boardInput.score})`);
          await sleep(500);
          log(`     URL: ${page.url()}`); await ss(page, '01_board', site.folder);

          // (B) URL 입력
          log('  (B) URL 입력...');
          await typeBoardUrl(page, site.url);
          log(`     입력: ${site.url}`); await ss(page, '02_url_typed', site.folder);

          // (C) Enter 또는 확인 버튼 → SPA 전환
          log('  (C) Enter → SPA 전환...');
          let transitionOk = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            await page.keyboard.press('Enter');
            await sleep(1500);
            if (await waitForVerifyScreen(page, 8000)) {
              transitionOk = true;
              break;
            }
            log(`     ⚠ Enter 미전환 (시도 ${attempt + 1}/3)`);
            if (attempt === 0) {
              const iconClicked = await page.evaluate(() => {
                const input = document.querySelector('[data-nrc-board-input="1"], input[type="text"], input[type="url"]');
                if (!input) return false;
                for (let p = input.parentElement; p && p !== document.body; p = p.parentElement) {
                  const candidates = p.querySelectorAll('button, [role="button"], .v-input__icon, .v-input__append-inner, i.v-icon, a');
                  for (const btn of candidates) {
                    if (btn === input) continue;
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                      btn.click();
                      return true;
                    }
                  }
                }
                return false;
              });
              if (iconClicked) log('     👆 입력창 아이콘/버튼 클릭');
            }
            if (attempt === 1) {
              const ok = await page.evaluate(() => {
                for (const b of document.querySelectorAll('button, a, div[role="button"]')) {
                  if (/소유확인\s*진행|확인|검색/.test(b.textContent)) { b.click(); return b.textContent.trim().substring(0, 30); }
                }
                return '';
              });
              if (ok) log(`     👆 "${ok}" 클릭`); else log('     ⚠ 확인 버튼도 없음');
            }
            await sleep(1000);
          }

          if (!transitionOk) {
            log('     ⚠ SPA 전환 실패, 직접 verify 페이지로 이동');
            transitionOk = await openVerifyPage(page, site.url);
          }

          if (!transitionOk) {
            throw new Error(`URL 전환 실패: ${page.url()}`);
          }
          // board URL만으로 성공한 것처럼 보이지 않게 재검증
          if (!isVerifyUrl(page.url()) && !(await hasVerifyPageUi(page))) {
            log('     ⚠ 소유확인 UI 미확인 — verify 직접 이동');
            transitionOk = await openVerifyPage(page, site.url);
            if (!transitionOk || (!(await hasVerifyPageUi(page)) && !isVerifyUrl(page.url()))) {
              throw new Error(`소유확인 화면 진입 실패: ${page.url()}`);
            }
          }
          log(`     ✅ 소유확인 화면: ${page.url()}`);
        }
        await sleep(1500);
        await ss(page, '03_after_enter', site.folder);

        // (D) HTML 태그 라디오 버튼 정확히 클릭
        log('  (D) HTML 태그 라디오 클릭...');
        const radioClicked = await page.evaluate(() => {
          // 1차: input[value="meta"] 직접 클릭
          const radio = document.querySelector('input[type="radio"][value="meta"]');
          if (radio) { radio.click(); return 'radio[value=meta]'; }
          // 2차: label 내부 텍스트 "HTML 태그" 포함된 label 클릭
          for (const lbl of document.querySelectorAll('label')) {
            if (/HTML\s*태그/i.test(lbl.textContent)) {
              const forId = lbl.getAttribute('for');
              const inp = forId ? document.getElementById(forId) : lbl.querySelector('input[type="radio"]');
              if (inp) { inp.click(); return 'label HTML태그'; }
            }
          }
          return '';
        });
        if (radioClicked) { log(`     👆 ${radioClicked}`); }
        else { log('     ⚠ 라디오 클릭 실패 → 수동 선택 필요'); }
        await sleep(4000);
        // 메타 스니펫 렌더링 대기
        for (let w = 0; w < 10; w++) {
          const ready = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return /naver-site-verification/i.test(t)
              || !!document.querySelector('meta[name="naver-site-verification"]')
              || Array.from(document.querySelectorAll('code, pre, textarea')).some((el) =>
                /naver-site-verification|content=/i.test(el.textContent || el.value || ''));
          });
          if (ready) break;
          await sleep(1000);
        }
        log(`     URL: ${page.url()}`); await ss(page, '04_tag_selected', site.folder);

        // (E) 메타 태그 추출
        const content = await getMeta(page);
        if (!content) {
          log('  ❌ 메타 태그 없음 (소유확인 HTML태그 코드를 읽지 못함)');
          results.push({
            url: site.url,
            name: site.name,
            status: 'error',
            error: 'no_meta: 네이버 소유확인 화면에서 인증 메타코드를 추출하지 못함',
            naverAccountId: naverAccount?.id || '',
            registeredAt: new Date().toISOString(),
          });
          continue;
        }
        const metaTag = `<meta name="naver-site-verification" content="${content}" />`;

        // (F) 메타 주입 + 배포/재배포 (ZIP 소스는 redeployCallback에서 압축 해제 후 주입)
        log('  (F) 메타 반영·배포...');
        if (redeployCallback) {
          try {
            await redeployCallback(site, metaTag);
          } catch (redeployErr) {
            const msg = redeployErr?.message || String(redeployErr);
            if (/403|credit usage exceeded|credits/i.test(msg)) {
              throw new CreditExceededError(msg);
            }
            throw redeployErr;
          }
          log('     배포 완료 — 라이브 메타 반영 대기...');
          const waitMs = extraRedeployOnMiss ? 60000 : 90000;
          const liveOk = await waitUntilMetaLive(site.url, content, { maxWaitMs: waitMs, intervalMs: 4000 });
          if (!liveOk && extraRedeployOnMiss) {
            log('     ⚠ 라이브 메타 미확인 — 재배포 1회 추가 시도');
            try {
              await redeployCallback(site, metaTag);
            } catch (redeployErr) {
              const msg = redeployErr?.message || String(redeployErr);
              if (/403|credit usage exceeded|credits/i.test(msg)) {
                throw new CreditExceededError(msg);
              }
              throw redeployErr;
            }
            const liveOk2 = await waitUntilMetaLive(site.url, content, { maxWaitMs: 45000, intervalMs: 4000 });
            if (!liveOk2) log('     ⚠ 라이브 메타 여전히 미확인 — 소유확인 계속 시도');
          } else if (!liveOk) {
            log('     ⚠ 라이브 메타 미확인 — 추가 재배포 생략(크레딧 절약), 소유확인 계속 시도');
          }
        } else {
          injectMeta(site.folder, metaTag);
        }
        await sleep(3000);

        // 메타만 주입 모드: 소유확인 버튼/캡챠 생략 → 다음 사이트
        if (metaInjectOnly) {
          log('  ⏭ 소유확인 버튼 생략 모드 — 메타 태그만 주입 완료, 다음 사이트로 진행');
          log(`     메타: ${metaTag}`);
          log('     ※ 네이버에서 「소유확인」은 직접 눌러 주세요.');
          results.push({
            url: site.url,
            name: site.name,
            status: 'manual',
            error: '',
            note: 'meta_injected: 소유확인 버튼 미클릭 — 수동 확인 필요',
            metaContent: content,
            naverAccountId: naverAccount?.id || '',
            registeredAt: new Date().toISOString(),
          });
          continue;
        }

        // (G) 소유확인
        log('  (G) 소유확인...');
        let clicked = await page.evaluate((kw) => {
          for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
            const t = el.textContent.trim();
            for (const k of kw) { if (t.includes(k)) { el.scrollIntoView({ block: 'center' }); el.click(); return t.substring(0,30); } }
          }
          return '';
        }, ['소유확인', '소유 확인']);
        if (clicked) log(`     👆 "${clicked}"`); else log('     ⚠ 수동 클릭 필요');
        log('     ⏳ 네이버 검증 대기 (10초)...'); await sleep(10000);

        // (I) 캡챠 감지 및 처리 (단계별 OCR 강화, 최대 6회)
        let captchaAttempts = 0;
        const maxCaptchaAttempts = 6;
        let captchaSuccess = false;

        const markOwnershipSuccess = (why) => {
          captchaSuccess = true;
          ownershipDoneByDialog = true;
          log(`     ✅ 소유확인 성공! (${why})`);
        };

        const alreadyOwned = () => ownershipDoneByDialog
          || /완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/i.test(lastDialogMsg || '');

        while (captchaAttempts < maxCaptchaAttempts) {
          if (alreadyOwned()) {
            markOwnershipSuccess('팝업/이전 단계');
            break;
          }

          // 요약/콘솔로 이미 이동했으면 소유확인 완료로 간주
          try {
            const u = page.url();
            if (/\/console\/site\/(summary|request|option)/i.test(u)) {
              markOwnershipSuccess(`페이지 이동: ${u}`);
              break;
            }
          } catch { /* ignore */ }

          const hasCaptcha = await detectCaptcha(page);
          if (!hasCaptcha) {
            if (alreadyOwned()) {
              markOwnershipSuccess('캡챠 종료 + 완료 팝업');
              break;
            }
            // 캡챠 없이 verify에 남아있으면 추가 대기 후 재확인
            log('  ✅ 캡챠 없음 또는 이미 해결됨');
            await sleep(2000);
            if (alreadyOwned() || /\/console\/site\//i.test(page.url())) {
              markOwnershipSuccess('캡챠 없음 후 재확인');
            }
            break;
          }
          
          captchaAttempts++;
          const attemptLevel = captchaAttempts - 1;
          log(`  🚨 캡챠 감지됨! (시도 ${captchaAttempts}/${maxCaptchaAttempts}, OCR 단계 ${attemptLevel})`);
          await ss(page, `06_captcha_${captchaAttempts}`, site.folder);

          if (alreadyOwned()) {
            markOwnershipSuccess('OCR 시작 전 완료 팝업');
            break;
          }

          const captchaResult = await solveCaptcha(page, site.folder, openaiApiKey, { attemptLevel });

          // OCR 도중 소유확인 완료 팝업이 뜬 경우 — 입력하지 말고 종료
          if (alreadyOwned()) {
            markOwnershipSuccess('OCR 중 완료 팝업');
            break;
          }

          const candidates = (captchaResult?.alternatives?.length
            ? captchaResult.alternatives
            : [captchaResult?.answer])
            .filter(Boolean)
            .filter((a) => isPlausibleCaptchaCode(a, false));
          if (!candidates.length) {
            log(`  ⚠ 캡챠 OCR 실패/거부(유효 코드 없음) — 이미지 새로고침 후 재시도`);
            if (alreadyOwned()) {
              markOwnershipSuccess('OCR 실패 직후 완료 팝업');
              break;
            }
            await refreshCaptchaImage(page);
            await sleep(2000);
            continue;
          }

          let roundSuccess = false;
          for (let ci = 0; ci < candidates.length && !roundSuccess; ci++) {
          if (alreadyOwned()) {
            markOwnershipSuccess('후보 입력 전 완료 팝업');
            roundSuccess = true;
            break;
          }
          const answer = candidates[ci];
          if (ci > 0) log(`  🔄 대안 답변 시도 (${ci + 1}/${candidates.length}): "${answer}"`);
          const targetInputId = typeof captchaResult === 'object' ? captchaResult?.inputId : '';
          const targetFrameIndex = typeof captchaResult === 'object' ? captchaResult?.frameIndex : 0;
          if (answer && answer.length >= 1) {
            // iframe 대응: solveCaptcha가 감지한 frame에 직접 입력
            const allFrames = [page, ...page.frames()];
            const targetFrame = allFrames[targetFrameIndex] || page;
            const inputSelector = captchaResult?.inputSelector;
            const injected = await targetFrame.evaluate((id, sel, ans) => {
              function getSelectorLocal(el) {
                if (!el) return '';
                if (el.id) return '#' + el.id;
                if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
                if (el.className && typeof el.className === 'string') {
                  const cls = el.className.split(/\s+/).filter(Boolean)[0];
                  if (cls) return el.tagName.toLowerCase() + '.' + cls;
                }
                if (el.placeholder) return el.tagName.toLowerCase() + '[placeholder*="' + el.placeholder.slice(0, 4) + '"]';
                return el.tagName.toLowerCase();
              }
              function findInput() {
                let inp = id ? document.getElementById(id) : null;
                if (!inp && sel) { try { inp = document.querySelector(sel); } catch {} }
                if (!inp) {
                  const sels = ['input#captcha','input#chptcha','input[name="captcha"]','input[name="chptcha"]','input[data-detect="code"]','input[placeholder*="정답"]','input[placeholder*="보안"]','input.input_text','.captcha_wrap input[type="text"]','.captcha_row input[type="text"]','#cap_line input[type="text"]','#rcapt input[type="text"]','[class*="captcha"] input[type="text"]','[id*="captcha"] input[type="text"]'];
                  for (const s of sels) { try { const el = document.querySelector(s); if (el) { inp = el; break; } } catch {} }
                }
                if (!inp) {
                  // 캡챠 이미지 근처의 input 우선 탐색 (소유확인 페이지)
                  let capEl = document.querySelector('#captchaimg, .captcha_img, img[src*="captcha"]');
                  if (!capEl) { for (const el of document.querySelectorAll('div, span, p')) { const bs = (window.getComputedStyle(el).backgroundImage || ''); if (bs.includes('captcha') || bs.includes('nhncaptcha')) { capEl = el; break; } } }
                  if (capEl) { let node = capEl; for (let d = 0; d < 8 && node; d++) { if (node.querySelector) { const c = node.querySelector('input[type="text"],input:not([type]),input[type="tel"],input[type="number"],input[type="search"]'); if (c && c.type !== 'password' && c.type !== 'hidden') { inp = c; break; } } node = node.parentElement; } }
                }
                if (!inp) {
                  // 모달/다이얼로그 안의 텍스트 입력 우선
                  const dialog = document.querySelector('[role="dialog"], .v-dialog, .modal, .ly_pop, .popup');
                  if (dialog) {
                    const di = dialog.querySelector('input[type="text"],input:not([type]),input[type="tel"]');
                    if (di && di.type !== 'password' && di.type !== 'hidden') inp = di;
                  }
                }
                if (!inp) {
                  // 최종 fallback: 아이디/비번 칸만 제외하고 첫 보이는 텍스트 입력 (이 페이지엔 id/pw 칸이 없음)
                  const SKIP = ['id','pw','password','userid','user_id','loginid','email','username','user','search'];
                  const cands = Array.from(document.querySelectorAll('input[type="text"],input:not([type]),input[type="tel"],input[type="number"],input[type="search"]'));
                  for (const el of cands) {
                    const idn = (el.id || '').toLowerCase(), nm = (el.name || '').toLowerCase();
                    if (SKIP.includes(idn) || SKIP.includes(nm)) continue;
                    if (el.type === 'password' || el.type === 'hidden') continue;
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    inp = el; break;
                  }
                }
                return inp;
              }
              function findConfirmButton(inp) {
                // 캡챠 입력창이 속한 팝업/다이얼로그 난에서만 "확인" 버튼 찾기
                let container = inp;
                const popupSelectors = ['[role="dialog"]', '.modal', '.layer', '.popup', '.ly_pop', '.captcha_layer', '.captcha_popup', '.input_captcha', '.captcha_area', '.v-dialog'];
                while (container && container !== document.body) {
                  const parent = container.parentElement;
                  if (!parent) break;
                  for (const s of popupSelectors) {
                    if (parent.matches && parent.matches(s)) { container = parent; break; }
                  }
                  container = parent;
                }
                if (!container || container === document.body) {
                  const dlg = document.querySelector('[role="dialog"], .v-dialog--active, .v-dialog');
                  container = dlg || document;
                }
                const scope = container === document ? document.body : container;
                const btns = scope.querySelectorAll('button, a, div[role="button"], input[type="button"], input[type="submit"]');
                for (const btn of btns) {
                  const txt = (btn.textContent || btn.value || '').trim();
                  if (/^(확\s*인|확인)$/.test(txt)) {
                    const r = btn.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    return btn;
                  }
                }
                return null;
              }
              const inp = findInput();
              if (!inp) return false;
              const rect = inp.getBoundingClientRect();
              inp.focus();
              inp.value = '';
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              const confirmBtn = findConfirmButton(inp);
              return { ok: true, selector: getSelectorLocal(inp), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, confirmSelector: getSelectorLocal(confirmBtn) };
            }, targetInputId, inputSelector, answer);
            if (!injected || !injected.ok) { log('  ⚠ 캡챠 입력 필드 없음'); continue; }
            log(`  ⌨️  캡챠 입력 대상: ${injected.selector}, 확인버튼: ${injected.confirmSelector || '미감지'}`);

            // 실제 마우스/키보드로 입력 (React/Vue controlled input 대응)
            try {
              const box = injected.rect;
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;
              await targetFrame.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) { el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
              }, injected.selector);
              await page.mouse.click(cx, cy);
              await page.keyboard.type(answer, { delay: 30 });
              log(`  ⌨️  캡챠 입력 완료: ${answer}`);
            } catch (e) {
              log(`  ⚠ 키보드 입력 실패, evaluate fallback: ${e.message}`);
              await targetFrame.evaluate((sel, ans) => {
                const el = document.querySelector(sel);
                if (el) { el.value = ans; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
              }, injected.selector, answer);
            }

            // 제출 전 dialog 메시지 초기화
            lastDialogMsg = '';
            // "확인" 버튼 클릭으로 제출 (캡챠 팝업 난에서만 찾기)
            log('     👆 확인 버튼 클릭 (제출)...');
            const clicked = await targetFrame.evaluate((inputSel) => {
              const inp = document.querySelector(inputSel);
              if (!inp) return null;
              let container = inp;
              const popupSelectors = ['[role="dialog"]', '.modal', '.layer', '.popup', '.ly_pop', '.captcha_layer', '.captcha_popup', '.input_captcha', '.captcha_area', '.v-dialog'];
              while (container && container !== document.body) {
                const parent = container.parentElement;
                if (!parent) break;
                for (const s of popupSelectors) {
                  if (parent.matches && parent.matches(s)) { container = parent; break; }
                }
                container = parent;
              }
              if (!container || container === document.body) {
                container = document.querySelector('[role="dialog"], .v-dialog--active, .v-dialog') || document;
              }
              const scope = container === document ? document.body : container;
              for (const btn of scope.querySelectorAll('button, a, div[role="button"], input[type="button"], input[type="submit"]')) {
                const txt = (btn.textContent || btn.value || '').trim();
                if (/^(확\s*인|확인)$/.test(txt)) {
                  const r = btn.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) continue;
                  btn.click();
                  return txt;
                }
              }
              return null;
            }, injected.selector);
            if (!clicked) {
              // board 등에서 Enter 치면 삭제 등 위험 동작 → 캡챠 모달이 있을 때만 Enter
              const onVerify = /\/console\/verify/i.test(page.url());
              if (onVerify) {
                log('     ⚠ 확인 버튼 못 찾음, Enter fallback (verify 한정)...');
                await page.keyboard.press('Enter');
              } else {
                log('     ⚠ 확인 버튼 못 찾음 — Enter 생략 (오작동 방지)');
                continue;
              }
            } else {
              log(`     👆 "${clicked}" 버튼 클릭됨`);
            }

            // 팝업(dialog) 등장까지 최대 10초 폴
            for (let w = 0; w < 20; w++) {
              if (lastDialogMsg || ownershipDoneByDialog) break;
              await sleep(500);
            }
            await sleep(1500);
            
            // dialog 메시지로 성공/실패 판단
            log(`     팝업 메시지: "${(lastDialogMsg || '').substring(0, 50)}"`);
            const msg = lastDialogMsg || '';
            let currentUrl = '';
            try { currentUrl = page.url(); } catch { currentUrl = ''; }
            log(`     현재 URL: ${currentUrl}`);

            if (ownershipDoneByDialog || /완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/.test(msg)) {
              markOwnershipSuccess(msg.slice(0, 40) || '완료 팝업');
              roundSuccess = true;
              break;
            }

            if (/\/console\/site\//i.test(currentUrl)) {
              markOwnershipSuccess(`콘솔 이동: ${currentUrl}`);
              roundSuccess = true;
              break;
            }

            if (/삭제\s*하시겠습니까/i.test(msg)) {
              log('     ⛔ 삭제 팝업 감지 — 캡챠 재시도 중단하고 verify 복귀');
              try {
                await openVerifyPage(page, site.url);
              } catch { /* ignore */ }
              break;
            }

            if (/메타\s*태그|찾을\s*수\s*없|호스팅/.test(msg)) {
              log('     ⚠ 메타태그 미검출 팝업 — 라이브 재확인 후 소유확인 재시도');
              const liveOk = await waitUntilMetaLive(site.url, content, {
                maxWaitMs: extraRedeployOnMiss ? 30000 : 60000,
                intervalMs: 3000,
              });
              if (liveOk && redeployCallback) {
                // 이미 반영됨 — 소유확인 버튼만 다시
              } else if (redeployCallback && extraRedeployOnMiss) {
                try {
                  await redeployCallback(site, metaTag);
                  await waitUntilMetaLive(site.url, content, { maxWaitMs: 45000, intervalMs: 4000 });
                } catch (redeployErr) {
                  const rem = redeployErr?.message || String(redeployErr);
                  if (/403|credit usage exceeded|credits/i.test(rem)) {
                    throw new CreditExceededError(rem);
                  }
                }
              } else if (!liveOk) {
                log('     ⚠ 추가 재배포 생략(크레딧 절약) — 소유확인만 재시도');
              }
              await sleep(2000);
              await page.evaluate(() => {
                for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
                  if (/소유확인|소유\s*확인/.test(el.textContent || '')) { el.click(); return; }
                }
              }).catch(() => {});
              await sleep(3000);
              continue;
            }

            if (/실패|보안절차|자동등록|자동입력|잘못\s*입력/.test(msg)) {
              log('     ❌ 캡챠/검증 실패 (팝업). 다음 후보 또는 재시도...');
              await sleep(1000);
              continue;
            }

            const hasFailText = await page.evaluate(() => {
              const t = document.body?.innerText || '';
              return /실패하였습니다|보안절차|자동등록|자동입력/.test(t);
            }).catch(() => false);
            if (hasFailText) {
              log('     ❌ 실패(fallback). 다음 후보 또는 재시도...');
              continue;
            }

            // board 이동만으로는 성공 판정하지 않음 (오판 방지)
            log('     ⏳ 결과 미확인, 추가 대기...');
            await sleep(3000);
            if (alreadyOwned() || /\/console\/site\//i.test(page.url())) {
              markOwnershipSuccess('대기 후 재확인');
              roundSuccess = true;
              break;
            }
          }
          }
          if (captchaSuccess) break;

          if (alreadyOwned()) {
            markOwnershipSuccess('라운드 종료 시 완료 팝업');
            break;
          }

          log('  ⚠ 이번 라운드 실패 — 캡챠 새로고침 후 OCR 단계 상향');
          await refreshCaptchaImage(page);
          await sleep(2000);
          await page.evaluate(() => {
            for (const btn of document.querySelectorAll('button, a, div[role="button"]')) {
              if (/소유확인/.test(btn.textContent)) { btn.click(); return; }
            }
          });
          await sleep(3000);
        }

        log(`     URL: ${page.url()}`); await ss(page, '05_verify', site.folder);

        // (J) 결과 — 캡챠 성공 플래그 / 완료 팝업 / 요약 페이지 우선
        log('  (I) 결과 확인...');
        let status = 'unknown';
        const finalUrl = (() => { try { return page.url(); } catch { return ''; } })();
        if (captchaSuccess || ownershipDoneByDialog || /\/console\/site\//i.test(finalUrl)) {
          log(`  ✅ 소유확인 완료 (캡챠 통과/완료 확인)`); status = 'success';
        } else {
          let body = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (/등록\s*완료|성공|확인\s*완료|소유\s*확인\s*완료/.test(body)) { log(`  ✅ 등록 성공`); status = 'success'; }
          else if (/이미\s*등록|중복/.test(body)) { log(`  ℹ 이미 등록`); status = 'already'; }
          else if (/캡챠|보안|자동|로봇/.test(body)) { log(`  ⚠ 캡챠/보안 문제`); status = 'captcha'; }
          else { log(`  ⚠ 상태 미확인`); }
        }
        results.push({
          url: site.url,
          name: site.name,
          status,
          metaContent: typeof content === 'string' ? content : '',
          naverAccountId: naverAccount?.id || '',
          registeredAt: new Date().toISOString(),
        });

        // (K) 인덱싱 신청 (소유확인 성공 시)
        if (status === 'success' || status === 'already') {
          try {
            await requestNaverIndexing(page, site.url, site.folder);
          } catch (idxErr) {
            log(`  ⚠ 인덱싱 신청 중 오류: ${idxErr.message}`);
          }
        }

      } catch (e) {
        if (e?.name === 'CreditExceededError' || /credit usage exceeded|credits/i.test(e?.message || '')) {
          log(`  ❌ 크레딧 초과 — 남은 사이트 등록 중단: ${e.message}`);
          results.push({
            url: site.url,
            name: site.name,
            status: 'error',
            error: e.message,
            naverAccountId: naverAccount?.id || '',
            registeredAt: new Date().toISOString(),
          });
          abortRemaining = `Netlify 크레딧 초과로 중단: ${e.message}`;
          await ss(page, 'ZZ_credit', site.folder).catch(() => {});
          continue;
        }
        log(`  ❌ 실패: ${e.message}`);
        results.push({
          url: site.url,
          name: site.name,
          status: 'error',
          error: e.message,
          naverAccountId: naverAccount?.id || '',
          registeredAt: new Date().toISOString(),
        });
        try { await ss(page, 'ZZ_error', site.folder); } catch {}
        // 페이지 컨텍스트 파괴 시 보드로 복구
        if (/Execution context was destroyed|Target closed|Session closed/i.test(e.message || '')) {
          try {
            await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(1500);
          } catch {}
        }
      }
      // 사이트 간 간격 — 이전 화면(캡챠/verify) 잔류로 다음 보드 입력 실패 방지
      await sleep(2500);
      try {
        await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {}
    }

  } catch (e) {
    log(`❌ 전체 오류: ${e.message}`);
  } finally {
    try { page.off('dialog', onDialog); } catch { /* ignore */ }
    if (!keepBrowserOpen && ownsBrowser) {
      if (!headless) { log('\n💡 10초 후 닫힘'); await sleep(10000); }
      await browser.close().catch(() => {});
    } else {
      log('공유 네이버 세션 유지 (브라우저 닫지 않음)');
    }
    const dir = sites[0]?.folder || './output'; saveLog(dir);
    log(`📋 ${path.join(dir,'naver-debug.log')}`);
  }
  // 등록 완료 후 보드 사이트 수 갱신 (타이틀 배지용)
  if (keepBrowserOpen) {
    try {
      const { countAdvisorRegisteredSites } = await import('./naver-session.js');
      const n = await countAdvisorRegisteredSites(page);
      if (n != null) log(`서치어드바이저 등록 사이트: ${n}개`);
    } catch { /* ignore */ }
  }
  return results;
}
