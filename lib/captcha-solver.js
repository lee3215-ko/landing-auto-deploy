import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { action, api as logApi, log as sharedLog } from './logger.js';
import {
  expandWithCharHints,
  filterLearnedAnswers,
  getSolveHints,
  hashBuffer,
  logCaptchaFailure,
  lookupHashAnswer,
} from './captcha-learn.js';

const require = createRequire(import.meta.url);
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharedLog(`[CAPTCHA] sharp 로드 실패: ${e.message}`); }

function log(msg) {
  sharedLog(`[CAPTCHA] ${msg}`);
}

const PROMPT_BASE = `이 이미지는 웹사이트 소유권 확인 절차에서 표시된 왜곡된 텍스트 코드(verification code)입니다.
글자를 왼쪽에서 오른쪽 순서대로 한 글자씩 정확히 읽어, 공백/특수문자/설명/띄어쓰기 없이 코드 문자열만 출력하세요.
영문 대소문자와 숫자로 구성되어 있으며, 보통 5~8자입니다.
숫자 0과 영문 O, 숫자 1과 영문 I/L 등이 헷갈리면 문맥상 가장 가능성 높은 글자를 선택하세요.
거절·사과·설명 문구("Imsorry", "I can't" 등)는 절대 출력하지 마세요. 반드시 코드만 출력하세요.`;

const PROMPT_ALT = `너는 OCR 전문가다. 이미지 속 왜곡된 영문·숫자 보안문자를 읽어라.
각 글자를 개별적으로 식별한 뒤 왼쪽→오른쪽 순으로 이어 붙여라.
출력은 A-Za-z0-9만 허용. 길이는 보통 5~8자. 설명·따옴표·접두어·거절문 금지.`;

const PROMPT_STRICT = `CAPTCHA text recognition. Read ONLY the distorted characters in the image.
Output format: raw code string, no spaces, no punctuation, no explanation, no refusals.
Preserve exact letter case (uppercase/lowercase matters). Length typically 5-8.`;

/** 단계별 OCR 강도 — 1차는 빠르게, 실패 시 변형·투표 확대 */
function getEscalationConfig(attemptLevel = 0) {
  const level = Math.max(0, Math.min(attemptLevel, 5));
  // 1차: 빠른 2표(저온) → 캡챠 만료 전 제출. 이후 단계만 투표 확대
  const voteCount = level === 0 ? 2 : Math.min(3 + level * 2, 9);
  return {
    level,
    voteCount,
    variantCount: level === 0 ? 2 : Math.min(2 + Math.floor(level / 2), 4),
    temperatures: Array.from({ length: voteCount }, (_, i) => {
      if (level === 0) return i === 0 ? 0 : 0.1;
      const base = level * 0.05;
      return Math.min(0.45, (i % 5) * 0.08 + base);
    }),
    prompts: level < 2
      ? [PROMPT_BASE, PROMPT_STRICT]
      : level < 4
        ? [PROMPT_BASE, PROMPT_ALT, PROMPT_STRICT]
        : [PROMPT_BASE, PROMPT_ALT, PROMPT_STRICT],
    topCandidates: level === 0 ? 2 : Math.min(2 + Math.floor(level / 2), 4),
  };
}

function captchaKeyFromSrc(src = '') {
  try {
    const u = new URL(String(src));
    return u.searchParams.get('key') || u.searchParams.get('id') || '';
  } catch {
    const m = String(src).match(/[?&]key=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

/** v4는 새로고침 시 key 유지·r(배경)만 바뀌는 경우가 많아 key+r로 변화를 본다 */
function captchaSrcFingerprint(src = '') {
  const s = String(src || '');
  try {
    const u = new URL(s);
    const key = u.searchParams.get('key') || u.searchParams.get('id') || '';
    const r = u.searchParams.get('r') || '';
    return `${key}|${r}|${u.pathname}`;
  } catch {
    const key = captchaKeyFromSrc(s);
    const rm = s.match(/[?&]r=([^&]+)/i);
    return `${key}|${rm ? rm[1] : ''}|${s.slice(0, 120)}`;
  }
}

/** 브라우저 컨텍스트에서 URL → base64 (쿠키/세션 유지) */
async function fetchImageInFrame(frame, src) {
  if (!src) return null;
  try {
    const b64 = await frame.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
        if (!r.ok) return '';
        const ab = await r.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
      } catch {
        return '';
      }
    }, src);
    if (!b64 || b64.length < 80) return null;
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/** 페이지에 보이는 캡챠 이미지를 버퍼로 (img / CSS background / URL) */
async function captureCaptchaImageBuffer(page, captchaFrame, fallbackSrc = '') {
  const meta = await captchaFrame.evaluate(() => {
    const imgSels = [
      'img#captchaimg', 'img.captcha_img', '.captcha_img img', '.captcha_wrap img',
      'img[src*="captcha"]', 'img[src*="nhncaptcha"]', 'img[src*="nid.naver"]',
    ];
    let img = null;
    for (const s of imgSels) { img = document.querySelector(s); if (img) break; }
    if (img) {
      const r = img.getBoundingClientRect();
      return {
        kind: 'img',
        src: img.currentSrc || img.src || '',
        w: r.width,
        h: r.height,
      };
    }

    // Search Advisor 등은 div background-image 로 캡챠 표시
    let bgSrc = '';
    let bgSel = '';
    const nodes = document.querySelectorAll(
      'div, span, p, a, i, [class*="captcha"], [id*="captcha"], [style*="captcha"], [style*="background"]',
    );
    for (const el of nodes) {
      const s = window.getComputedStyle(el).backgroundImage || '';
      if (!s || s === 'none') continue;
      if (!/captcha|nhncaptcha|nid\.naver|data:image/i.test(s)) continue;
      const m = s.match(/url\(["']?([^"')]+)["']?\)/i);
      if (!m?.[1]) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      bgSrc = m[1];
      // 스크린샷용 임시 마커
      el.setAttribute('data-lad-captcha-bg', '1');
      bgSel = '[data-lad-captcha-bg="1"]';
      break;
    }
    return { kind: 'bg', src: bgSrc, w: 0, h: 0, bgSel };
  }).catch(() => ({ kind: '', src: '', w: 0, h: 0, bgSel: '' }));

  const src = String(meta.src || fallbackSrc || '').trim();
  log(`캡처 후보: kind=${meta.kind || '?'} src=${(src || '').slice(0, 90)}`);

  const shotWithTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);

  // 1) 요소 스크린샷 우선 — naver v4 캡챠는 gif를 background-position 스프라이트로 렌더하므로
  //    화면에 보이는 요소를 캡처해야 사람이 보는 글자와 동일. (원본 gif fetch는 전체 스프라이트/빈값이라 OCR 불가)
  const shotSels = [
    'img#captchaimg',
    'img[src*="captcha"]',
    'img[src*="nhncaptcha"]',
    'img.captcha_img',
    '.captcha_wrap img',
    '[data-lad-captcha-bg="1"]',
    '.captcha_img',
    '.captcha_wrap',
    '[class*="captcha"] img',
  ];
  for (const sel of shotSels) {
    try {
      const handle = await captchaFrame.$(sel);
      if (!handle) continue;
      // CDP hang 방지 — 3분 protocolTimeout까지 기다리지 않음
      const buf = await shotWithTimeout(
        handle.screenshot({ type: 'png', omitBackground: false }),
        8000,
        `element-screenshot:${sel}`,
      );
      await handle.dispose().catch(() => {});
      if (buf?.length > 200) {
        await captchaFrame.evaluate(() => {
          document.querySelectorAll('[data-lad-captcha-bg]').forEach((el) => el.removeAttribute('data-lad-captcha-bg'));
        }).catch(() => {});
        return {
          buf: Buffer.from(buf),
          imgSrc: src,
          method: `element-screenshot:${sel}`,
          captchaKey: captchaKeyFromSrc(src),
        };
      }
    } catch (e) {
      log(`요소 스크린샷 실패(${sel}): ${e.message}`);
    }
  }

  // 2) 페이지 clip 스크린샷 (요소 screenshot hang 시 대안)
  try {
    const box = await captchaFrame.evaluate(() => {
      const sels = [
        '[data-lad-captcha-bg="1"]',
        'img#captchaimg',
        'img[src*="captcha"]',
        'img[src*="nhncaptcha"]',
        '.captcha_wrap',
        '[class*="captcha"] img',
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 40 && r.height >= 20) {
          return { x: r.left, y: r.top, width: r.width, height: r.height, sel };
        }
      }
      return null;
    }).catch(() => null);
    if (box) {
      const clip = {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      };
      const buf = await shotWithTimeout(
        page.screenshot({ type: 'png', clip, captureBeyondViewport: true }),
        10000,
        'page-clip',
      );
      if (buf?.length > 200) {
        await captchaFrame.evaluate(() => {
          document.querySelectorAll('[data-lad-captcha-bg]').forEach((el) => el.removeAttribute('data-lad-captcha-bg'));
        }).catch(() => {});
        return {
          buf: Buffer.from(buf),
          imgSrc: src,
          method: `page-clip:${box.sel}`,
          captchaKey: captchaKeyFromSrc(src),
        };
      }
    }
  } catch (e) {
    log(`페이지 clip 스크린샷 실패: ${e.message}`);
  }

  await captchaFrame.evaluate(() => {
    document.querySelectorAll('[data-lad-captcha-bg]').forEach((el) => el.removeAttribute('data-lad-captcha-bg'));
  }).catch(() => {});

  if (!src) {
    log('캡챠 URL 없음 (img/bgSrc 모두 비어 있음)');
    return null;
  }

  // nhncaptchav4.gif 는 스프라이트 시트 — fetch OCR은 글자가 틀리므로 최후 수단만
  const isV4Sprite = /nhncaptchav4|captcha\.nid\.naver\.com/i.test(src);
  if (isV4Sprite) {
    log('⚠ v4 캡챠 스프라이트 fetch OCR 생략 (화면 캡처 실패) — 재시도 유도');
    return null;
  }

  // 3) Node fetch + 쿠키 (비-v4만)
  try {
    const cookies = await page.cookies().catch(() => []);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const r = await fetch(src, {
      headers: {
        Cookie: cookieHeader,
        Referer: page.url(),
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 200) {
      return { buf, imgSrc: src, method: 'fetch-cookie', captchaKey: captchaKeyFromSrc(src) };
    }
  } catch (e) {
    log(`쿠키 fetch 실패: ${e.message}`);
  }

  // 4) 단순 fetch
  try {
    const r = await fetch(src);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 200) {
      return { buf, imgSrc: src, method: 'fetch', captchaKey: captchaKeyFromSrc(src) };
    }
  } catch (e) {
    log(`fetch 실패: ${e.message}`);
  }
  return null;
}

/** 대소문자·O/0·I/1 변형 후보 (필터는 호출측에서) */
export function expandCaptchaCaseVariants(answer) {
  const a = String(answer || '').replace(/[^A-Za-z0-9]/g, '');
  if (!a) return [];
  const out = new Set([a, a.toUpperCase(), a.toLowerCase()]);
  const swaps = [['0', 'O'], ['O', '0'], ['1', 'I'], ['I', '1'], ['5', 'S'], ['S', '5'], ['8', 'B'], ['B', '8']];
  for (const [from, to] of swaps) {
    if (!a.toUpperCase().includes(from.toUpperCase())) continue;
    out.add(a.replace(new RegExp(from, 'gi'), to));
    out.add(a.toUpperCase().replace(new RegExp(from, 'gi'), to));
  }
  return [...out];
}

/** 캡챠 감지: 모든 frame 탐색 */
export async function detectCaptcha(page) {
  action('캡챠 감지 시작');
  const frames = [page, ...page.frames()];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    try {
      const found = await frame.evaluate(() => {
        const img = document.querySelector('img#captchaimg, img[src*="captcha"], .captcha img, div[style*="captcha"]');
        let bg = false;
        for (const el of document.querySelectorAll('div, span, p, [class*="captcha"]')) {
          const s = window.getComputedStyle(el).backgroundImage || '';
          if (/captcha|nhncaptcha|nid\.naver/i.test(s)) { bg = true; break; }
        }
        const input = document.querySelector('input#captcha, input#chptcha, input[name="captcha"], input[placeholder*="정답"], input[placeholder*="보안"]');
        const question = document.querySelector('#captcha_info, .captcha_message');
        return { img: !!img, bg, input: !!input, question: !!question };
      });
      log(`  [frame ${i}] img=${found.img} bg=${found.bg} input=${found.input} question=${found.question}`);
      if (found.img || found.bg || found.input || found.question) return true;
    } catch (e) { log(`  [frame ${i}] evaluate 실패: ${e.message}`); continue; }
  }
  log('  캡챠 요소 없음');
  return false;
}

export async function refreshCaptchaImage(page) {
  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const clicked = await frame.evaluate(() => {
        // 1순위: 다이얼로그 안 「새로고침」버튼 (cached 아이콘 + accent)
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const el of btns) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/^새로고침$|새로고침/.test(t)) continue;
          if (t.length > 20) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          el.click();
          return `btn:${t.slice(0, 20)}`;
        }
        // 2순위: material-icons cached 근처 버튼
        for (const icon of document.querySelectorAll('.material-icons, i.v-icon')) {
          const it = (icon.textContent || '').trim();
          if (it !== 'cached' && it !== 'refresh') continue;
          const btn = icon.closest('button, a, [role="button"]');
          if (!btn) continue;
          const r = btn.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          btn.click();
          return 'icon:cached';
        }
        const refreshHints = ['새로고침', '다른 이미지', '이미지 새로', '다시 보기', '다시보기', 'refresh', 'reload'];
        const candidates = Array.from(document.querySelectorAll('a, button, span, img, i, em'));
        for (const el of candidates) {
          const t = `${el.textContent || ''} ${el.alt || ''} ${el.title || ''} ${el.className || ''}`.trim();
          if (!refreshHints.some((h) => t.toLowerCase().includes(h.toLowerCase()))) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return t.slice(0, 40); }
        }
        return '';
      });
      if (clicked) {
        log(`캡챠 이미지 새로고침: ${clicked}`);
        return true;
      }
    } catch { /* frame skip */ }
  }
  return false;
}

/** CSS background / img 에서 현재 captcha key 추출 */
async function currentCaptchaKey(captchaFrame) {
  return captchaFrame.evaluate(() => {
    const img = document.querySelector('img#captchaimg, img[src*="captcha"], img.captcha_img');
    if (img) return img.currentSrc || img.src || '';
    for (const el of document.querySelectorAll('.v-image__image, div, span')) {
      try {
        const bi = getComputedStyle(el).backgroundImage || '';
        const m = bi.match(/url\(["']?(https?:[^"')]*captcha[^"']*)["']?\)/i)
          || bi.match(/url\(["']?(https?:[^"')]*nhncaptcha[^"']*)["']?\)/i);
        if (m) return m[1];
      } catch { /* ignore */ }
    }
    return '';
  }).catch(() => '');
}

async function waitCaptchaKeyChanged(captchaFrame, prevKey, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const src = await currentCaptchaKey(captchaFrame);
    const key = captchaKeyFromSrc(src);
    if (key && prevKey && key !== prevKey) return { src, key };
    if (src && prevKey && !key && src !== prevKey) return { src, key: captchaKeyFromSrc(src) };
    await new Promise((r) => setTimeout(r, 250));
  }
  const src = await currentCaptchaKey(captchaFrame);
  return { src, key: captchaKeyFromSrc(src) };
}

/** key 유지 + r 변경(v4) 또는 key 변경을 모두 감지 */
async function waitCaptchaSrcChanged(captchaFrame, prevSrc, timeoutMs = 8000) {
  const prevFp = captchaSrcFingerprint(prevSrc);
  const prevKey = captchaKeyFromSrc(prevSrc);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const src = await currentCaptchaKey(captchaFrame);
    if (!src) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const key = captchaKeyFromSrc(src);
    const fp = captchaSrcFingerprint(src);
    if (fp && fp !== prevFp) {
      return {
        src,
        key,
        keyChanged: !!(prevKey && key && key !== prevKey),
        srcChanged: true,
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const src = await currentCaptchaKey(captchaFrame);
  const key = captchaKeyFromSrc(src);
  const fp = captchaSrcFingerprint(src);
  return {
    src,
    key,
    keyChanged: !!(prevKey && key && key !== prevKey),
    srcChanged: !!(src && fp && fp !== prevFp),
  };
}

/** GPT OCR 투표 → Map(answer → count) */
async function gptOcrTally(buf, apiKey, esc, hints, passLabel = 'OCR') {
  const tally = new Map();
  if (!apiKey || !buf?.length) return tally;
  const add = (raw) => {
    const c = cleanAnswer(raw, false);
    if (!c) return '';
    if ((hints.avoidAnswers || []).includes(c)) return '';
    tally.set(c, (tally.get(c) || 0) + 1);
    return c;
  };
  try {
    const variants = await buildImageVariants(buf, esc.variantCount);
    const jobs = Array.from({ length: esc.voteCount }, (_, i) => ({
      i,
      variant: variants[i % variants.length],
      prompt: esc.prompts[i % esc.prompts.length],
      temp: esc.temperatures[i] ?? 0.1,
    }));
    const res = await Promise.all(jobs.map(async ({ i, variant, prompt, temp }) => {
      try {
        const raw = await callVision({
          apiKey, prompt, b64: variant.b64, mimeType: variant.mime, temperature: temp,
        });
        return { raw, label: variant.label, i };
      } catch (e) {
        log(`${passLabel}[${i + 1}] 실패: ${e.message}`);
        return { raw: '', label: variant.label, i };
      }
    }));
    for (const { raw, label, i } of res) {
      const c = add(raw);
      log(`${passLabel}[${i + 1}] ${label}: "${raw}" → "${c || ''}"`);
    }
  } catch (e) {
    log(`${passLabel} API 실패: ${e.message}`);
  }
  return tally;
}

/** 1차·2차(새로고침 후) 표를 합산 — 양쪽 공통 답을 최우선 */
function mergeRefreshCompareTallies(tally1, tally2) {
  const keys = new Set([...tally1.keys(), ...tally2.keys()]);
  const ranked = [];
  for (const answer of keys) {
    const c1 = tally1.get(answer) || 0;
    const c2 = tally2.get(answer) || 0;
    const both = c1 > 0 && c2 > 0;
    ranked.push({
      answer,
      count: c1 + c2 + (both ? 10 : 0),
      c1,
      c2,
      both,
    });
  }
  ranked.sort((a, b) =>
    (b.both - a.both)
    || (b.count - a.count)
    || (b.c2 - a.c2)
    || (b.answer.length - a.answer.length));
  return ranked;
}

async function buildImageVariants(inputBuf, variantCount) {
  const variants = [];
  const push = (buf, mime, label) => {
    variants.push({ b64: buf.toString('base64'), mime, label });
  };

  let meta = { width: 0, height: 0, format: 'png' };
  if (sharp) {
    try { meta = await sharp(inputBuf).metadata(); } catch { /* use defaults */ }
  }

  let baseBuf = inputBuf;
  const isAnim = meta.format === 'gif' || (meta.pages && meta.pages > 1);
  if (sharp && isAnim) {
    try {
      // 중간 프레임 우선(첫 프레임은 빈/페이드인인 경우 많음)
      const pages = meta.pages || 1;
      const mid = Math.max(0, Math.min(pages - 1, Math.floor(pages / 2)));
      baseBuf = await sharp(inputBuf, { page: mid, pages: 1 }).png().toBuffer();
      meta = await sharp(baseBuf).metadata();
    } catch {
      try {
        baseBuf = await sharp(inputBuf, { pages: 1 }).png().toBuffer();
        meta = await sharp(baseBuf).metadata();
      } catch { /* keep original */ }
    }
  }

  const mime = meta.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  push(baseBuf, mime, 'original');

  if (!sharp || variantCount < 2) return variants.slice(0, variantCount);

  try {
    const w = meta.width || 120;
    const up2 = await sharp(baseBuf)
      .resize({ width: Math.max(240, Math.round(w * 2.5)), kernel: 'lanczos3' })
      .normalize()
      .sharpen({ sigma: 1.2 })
      .png()
      .toBuffer();
    push(up2, 'image/png', 'upscale-sharp');
  } catch { /* skip */ }

  if (variantCount < 3) return variants.slice(0, variantCount);

  try {
    const norm = await sharp(baseBuf).normalize().sharpen({ sigma: 1 }).png().toBuffer();
    push(norm, 'image/png', 'normalize');
  } catch { /* skip */ }

  if (variantCount < 4) return variants.slice(0, variantCount);

  try {
    const gray = await sharp(baseBuf).greyscale().linear(1.35, -16).threshold(140).png().toBuffer();
    push(gray, 'image/png', 'gray-threshold');
  } catch { /* skip */ }

  return variants.slice(0, variantCount);
}

function tallyVotes(votes) {
  const tally = {};
  for (const v of votes) {
    if (!v) continue;
    tally[v] = (tally[v] || 0) + 1;
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([answer, count]) => ({ answer, count }));
}

async function callVision({ apiKey, prompt, b64, mimeType, temperature = 0.2 }) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}`, detail: 'high' } },
        ],
      }],
      temperature,
      max_tokens: 50,
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return (data.choices?.[0]?.message?.content || '').trim();
}

const OCR_REFUSAL_RE = /sorry|cant|cannot|unable|refuse|apolog|imsorry|asai|language|model|openai|chatgpt|help|describe|image|captcha|보안|문자|모르겠|읽을|수없/i;

/** OCR 결과가 실제 캡챠 코드처럼 보이는지 검사 */
export function isPlausibleCaptchaCode(raw, hasQuestion = false) {
  if (!raw) return false;
  if (hasQuestion) {
    const t = String(raw).trim();
    if (t.length < 1 || t.length > 20) return false;
    if (OCR_REFUSAL_RE.test(t)) return false;
    return true;
  }
  const s = String(raw).replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '');
  // 네이버 NHN 캡챠는 보통 4~7자 (로그상 U5HI/PN5D=4자도 유효 후보)
  if (s.length < 4 || s.length > 8) return false;
  if (OCR_REFUSAL_RE.test(s)) return false;
  // 영문 사절/문장형 (모음 비율 과도 + 소문자 장문)
  if (/^[A-Za-z]+$/.test(s) && s.length >= 8 && (s.match(/[aeiouAEIOU]/g) || []).length >= s.length * 0.4) {
    return false;
  }
  return true;
}

function cleanAnswer(s, hasQuestion) {
  if (hasQuestion) {
    const t = s.replace(/^정답[:：]\s*/, '').replace(/[.．。]$/, '').trim();
    return isPlausibleCaptchaCode(t, true) ? t : '';
  }
  const cleaned = s.replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '').substring(0, 12);
  return isPlausibleCaptchaCode(cleaned, false) ? cleaned : '';
}

async function findCaptchaFrame(page) {
  let captchaFrame = page;
  let captchaFrameIndex = 0;
  const frames = [page, ...page.frames()];
  for (let i = 0; i < frames.length; i++) {
    try {
      const hasCaptcha = await frames[i].evaluate(() =>
        !!document.querySelector('img#captchaimg, img[src*="captcha"], input#captcha, input#chptcha, #captcha_info, .captcha_message'),
      );
      if (hasCaptcha) { captchaFrame = frames[i]; captchaFrameIndex = i; break; }
    } catch { continue; }
  }
  return { captchaFrame, captchaFrameIndex };
}

async function extractCaptchaDom(captchaFrame) {
  return captchaFrame.evaluate(() => {
    let img = null;
    const selectors = [
      'img#captchaimg', 'img.captcha_img', '.captcha_img img', '.captcha_wrap img',
      'img[src*="captcha"]', 'img[alt*="보안"]', 'img[alt*="캡차"]', 'img[alt*="captcha"]',
    ];
    for (const s of selectors) { img = document.querySelector(s); if (img) break; }
    let bgSrc = '';
    if (!img) {
      for (const el of document.querySelectorAll('div, span')) {
        const s = window.getComputedStyle(el).backgroundImage;
        if (s && (s.includes('captcha') || s.includes('data:image'))) {
          bgSrc = s.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
          if (bgSrc.length > 100) break;
        }
      }
    }
    const imgSrc = img ? img.src : bgSrc;
    const qEl = document.querySelector('#captcha_info, .captcha_message') || document.querySelector('.captcha_desc');
    const question = qEl ? qEl.innerText.trim() : '';

    let inp = (function findCaptchaInputLocal() {
      const sels = [
        'input#captcha', 'input#chptcha', 'input[name="captcha"]', 'input[name="chptcha"]',
        'input[data-detect="code"]', 'input[placeholder*="정답"]', 'input[placeholder*="보안"]',
        'input.input_text', '.captcha_wrap input[type="text"]', '.captcha_row input[type="text"]',
        '#cap_line input[type="text"]', '#rcapt input[type="text"]',
        '[class*="captcha"] input[type="text"]', '[id*="captcha"] input[type="text"]',
      ];
      for (const s of sels) { try { const el = document.querySelector(s); if (el) return el; } catch {} }
      let capEl = document.querySelector('#captchaimg, .captcha_img, img[src*="captcha"]');
      if (!capEl) {
        for (const el of document.querySelectorAll('div, span, p')) {
          const bs = (window.getComputedStyle(el).backgroundImage || '');
          if (bs.includes('captcha') || bs.includes('nhncaptcha')) { capEl = el; break; }
        }
      }
      if (capEl) {
        let node = capEl;
        for (let d = 0; d < 8 && node; d++) {
          if (node.querySelector) {
            const c = node.querySelector('input[type="text"],input:not([type]),input[type="tel"],input[type="number"],input[type="search"]');
            if (c && c.type !== 'password' && c.type !== 'hidden') return c;
          }
          node = node.parentElement;
        }
      }
      const SKIP = ['id', 'pw', 'password', 'userid', 'user_id', 'loginid', 'email', 'username', 'user'];
      for (const el of document.querySelectorAll('input[type="text"],input:not([type]),input[type="tel"],input[type="number"],input[type="search"]')) {
        const idn = (el.id || '').toLowerCase();
        const nm = (el.name || '').toLowerCase();
        if (SKIP.includes(idn) || SKIP.includes(nm)) continue;
        if (el.type === 'password' || el.type === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
      return null;
    })();

    const inputId = inp ? (inp.id || inp.name || '') : '';
    const inputSelector = inp ? (function getSel(el) {
      if (el.id) return `#${el.id}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(/\s+/).filter(Boolean)[0];
        if (cls) return `${el.tagName.toLowerCase()}.${cls}`;
      }
      if (el.placeholder) return `${el.tagName.toLowerCase()}[placeholder*="${el.placeholder.slice(0, 4)}"]`;
      return el.tagName.toLowerCase();
    })(inp) : '';
    const imgInfo = img
      ? { tag: img.tagName, src: img.src.substring(0, 80), width: img.width, height: img.height }
      : { bgSrc: bgSrc.substring(0, 80) };
    return { imgSrc, question, inputId, inputSelector, imgInfo };
  });
}

function packResult({
  answer, alternatives, inputId, inputSelector, captchaFrameIndex, esc, captchaKey, imgSrc, solver, imageHash,
}) {
  const merged = filterLearnedAnswers([
    answer,
    ...(alternatives || []),
    ...expandWithCharHints(answer),
  ].filter(Boolean).filter((x) => isPlausibleCaptchaCode(x, false)));
  const alts = [...new Set(merged)].slice(0, 6);
  const finalAnswer = alts[0] || answer;
  if (!finalAnswer) return '';
  return {
    answer: finalAnswer,
    alternatives: alts.length ? alts : [finalAnswer],
    inputId,
    inputSelector,
    frameIndex: captchaFrameIndex,
    attemptLevel: esc.level,
    captchaKey,
    imgSrc,
    solver,
    imageHash,
  };
}

/**
 * @param {object} options
 * @param {number} [options.attemptLevel=0] 재시도 단계 (0부터, 높을수록 OCR 강도 증가)
 * @param {string} [options.yesCaptchaClientKey] 사용 안 함(소유확인 OCR에서 제거). 하위 호환용으로만 받음
 * @param {boolean} [options.refreshCompare=true] 1차 OCR → 새로고침 1회 → 2차 OCR → 비교 채택
 * @param {string} [options.context] 학습 로그용 컨텍스트 (login/ownership 등)
 */
export async function solveCaptcha(page, folder, apiKey, options = {}) {
  const attemptLevel = options.attemptLevel ?? 0;
  const esc = getEscalationConfig(attemptLevel);
  const context = options.context || 'captcha';
  const hints = getSolveHints();
  // 소유확인 글자캡챠: YesCaptcha 제거. GPT + 새로고침 비교만.
  const refreshCompare = options.refreshCompare !== false;

  if (!apiKey) { log('OpenAI 키 없음'); return ''; }
  action(`solveCaptcha 시작 (단계 ${esc.level}: GPT만, 새로고침비교=${refreshCompare ? 'ON' : 'OFF'}, 투표 ${esc.voteCount}회, 변형 ${esc.variantCount}종${hints.trainedAt ? ', 학습모델ON' : ''})`);

  const { captchaFrame, captchaFrameIndex } = await findCaptchaFrame(page);
  let { imgSrc, question, inputId, inputSelector, imgInfo } = await extractCaptchaDom(captchaFrame);
  // inputId/selector는 새로고침 후 갱신될 수 있음

  if (!imgSrc && captchaFrame !== page) {
    log('메인 프레임에서 재탐색...');
    return solveCaptcha(page, folder, apiKey, options);
  }

  log(`캡챠 이미지: ${JSON.stringify(imgInfo)}`);
  if (!imgSrc) {
    log('캡챠 URL/요소 없음');
    logCaptchaFailure({
      context, reason: 'no_image_src', attemptLevel: esc.level, solver: 'none',
    });
    return '';
  }

  // bgSrc(CSS background) 포함 — fallbackSrc로 전달해 fetch까지 시도
  const captured = await captureCaptchaImageBuffer(page, captchaFrame, imgSrc);
  if (!captured?.buf?.length) {
    log('이미지 캡처 실패 (img/bg/fetch 모두 실패)');
    logCaptchaFailure({
      context, reason: 'capture_failed', attemptLevel: esc.level, solver: 'none', captchaKey: captchaKeyFromSrc(imgSrc),
    });
    return '';
  }
  imgSrc = captured.imgSrc || imgSrc;
  const captchaKey = captured.captchaKey || captchaKeyFromSrc(imgSrc);
  const imageHash = hashBuffer(captured.buf);
  log(`캡처 방식: ${captured.method}${captchaKey ? ` key=${captchaKey.slice(0, 12)}…` : ''}`);

  const imgPath = path.join(folder, 'screenshots', `captcha_L${esc.level}.png`);
  fs.mkdirSync(path.dirname(imgPath), { recursive: true });
  fs.writeFileSync(imgPath, captured.buf);

  const votes = [];
  const failBase = {
    context,
    captchaKey,
    attemptLevel: esc.level,
    imageBuf: captured.buf,
    imageHash,
    imagePath: imgPath,
  };

  // ── 0) 학습된 동일 이미지 해시 즉시 재사용 ──
  const memorized = lookupHashAnswer(imageHash);
  if (memorized && isPlausibleCaptchaCode(memorized, false)) {
    log(`학습 해시 기억 답 사용: "${memorized}"`);
    return packResult({
      answer: memorized,
      alternatives: expandWithCharHints(memorized),
      inputId,
      inputSelector,
      captchaFrameIndex,
      esc,
      captchaKey,
      imgSrc,
      solver: 'hash-memory',
      imageHash,
    });
  }

  // ── 질문형 캡챠는 GPT QA 경로 (기존 유지) ──
  if (question) {
    if (!apiKey) { log('질문형 캡챠인데 OpenAI 키 없음'); return ''; }
    const variants = await buildImageVariants(captured.buf, esc.variantCount);
    const questionPrompt = `아래 이미지를 보고 질문에 답해줘.\n\n질문: ${question}\n\n설명 없이 정답 단어만 출력해. '정답:' 같은 prefix는 붙이지 마.`;
    try {
      const qaResults = await Promise.all(
        Array.from({ length: esc.voteCount }, (_, i) => i).map(async (i) => {
          try {
            const raw = await callVision({
              apiKey, prompt: questionPrompt, b64: variants[0].b64, mimeType: variants[0].mime,
              temperature: esc.temperatures[i] ?? 0,
            });
            const c = cleanAnswer(raw, true);
            log(`GPT QA[${i + 1}]: "${raw}" → "${c}"`);
            return c;
          } catch (e) { log(`QA 투표 ${i + 1} 실패: ${e.message}`); return ''; }
        }),
      );
      for (const c of qaResults) if (c) votes.push(c);
    } catch (e) { log(`QA API 실패: ${e.message}`); }
    if (!votes.length) {
      logCaptchaFailure({ ...failBase, solver: 'openai', reason: 'empty_qa', answers: [] });
      return '';
    }
    const ranked = tallyVotes(votes);
    const answer = ranked[0]?.answer;
    if (!answer) return '';
    return packResult({
      answer, alternatives: ranked.slice(0, 2).map((r) => r.answer),
      inputId, inputSelector, captchaFrameIndex, esc, captchaKey, imgSrc, solver: 'openai-qa', imageHash,
    });
  }

  // ── 글자 캡챠: GPT만. 1차 인식 → 새로고침 1회 → 2차 인식 → 공통 답 우선 채택 ──
  //    (네이버 v4: 새로고침 시 문자열 동일·배경만 변경 → 두 번 읽어 교차검증)
  let finalBuf = captured.buf;
  let finalKey = captchaKey;
  let finalSrc = imgSrc;
  let finalHash = imageHash;
  let finalImgPath = imgPath;

  const tally1 = await gptOcrTally(captured.buf, apiKey, esc, hints, 'GPT1차');
  if (!tally1.size) {
    log('1차 OCR 결과 없음');
    logCaptchaFailure({ ...failBase, solver: 'gpt-refresh', reason: 'empty_ocr_pass1', answers: [] });
    return '';
  }
  log(`1차 표: ${[...tally1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, c]) => `${a}(${c})`).join(', ')}`);

  let tally2 = new Map();
  /** key가 바뀌면 다른 문제 → 1·2차 합산 금지. key 같고 r만 바뀌면(v4) 교차검증 */
  let mergeCompare = true;
  if (refreshCompare) {
    const prevKey = captchaKey || captchaKeyFromSrc(imgSrc) || '';
    log('새로고침 1회 → 동일 문자열·다른 배경으로 재인식');
    const refreshed = await refreshCaptchaImage(page);
    if (refreshed) {
      await new Promise((r) => setTimeout(r, 900));
      const after = await waitCaptchaSrcChanged(captchaFrame, imgSrc || prevKey, 8000);
      if (!after.srcChanged && !after.keyChanged) {
        // 클릭은 됐지만 URL이 안 바뀜 → 한 번 더 시도
        log('새로고침 반영 없음(r/key 동일) — 재클릭 1회');
        await refreshCaptchaImage(page);
        await new Promise((r) => setTimeout(r, 900));
        const after2 = await waitCaptchaSrcChanged(captchaFrame, imgSrc || prevKey, 6000);
        Object.assign(after, after2);
      }
      if (!after.srcChanged && !after.keyChanged) {
        log(`새로고침 후에도 이미지 미갱신(${(after.key || prevKey || '').slice(0, 12)}…) — 1차 표만 사용`);
      } else if (after.keyChanged) {
        // 다른 문제(문자열 다름) — 합산하면 오염됨. 2차만 사용
        mergeCompare = false;
        log(`새로고침 후 캡챠 key 변경(${(prevKey || '').slice(0, 10)}→${(after.key || '').slice(0, 10)}) — 2차 OCR만 사용`);
        const dom2 = await extractCaptchaDom(captchaFrame);
        if (dom2.inputId) inputId = dom2.inputId;
        if (dom2.inputSelector) inputSelector = dom2.inputSelector;
        const src2 = after.src || dom2.imgSrc || imgSrc;
        const captured2 = await captureCaptchaImageBuffer(page, captchaFrame, src2);
        if (captured2?.buf?.length) {
          finalBuf = captured2.buf;
          finalSrc = captured2.imgSrc || src2;
          finalKey = captured2.captchaKey || captchaKeyFromSrc(finalSrc);
          finalHash = hashBuffer(finalBuf);
          finalImgPath = path.join(folder, 'screenshots', `captcha_L${esc.level}_r.png`);
          fs.writeFileSync(finalImgPath, finalBuf);
          tally2 = await gptOcrTally(finalBuf, apiKey, esc, hints, 'GPT2차');
          log(`2차 표(단독): ${[...tally2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, c]) => `${a}(${c})`).join(', ') || '(없음)'}`);
        } else {
          log('2차 캡처 실패 — 1차 표만 사용');
          mergeCompare = true;
        }
      } else {
        // v4: key 동일 · r(배경)만 변경 → 교차검증
        log(`새로고침 반영(key 유지·배경 변경) — 비교 OCR 진행 key=${(after.key || prevKey || '').slice(0, 12)}…`);
        const dom2 = await extractCaptchaDom(captchaFrame);
        if (dom2.inputId) inputId = dom2.inputId;
        if (dom2.inputSelector) inputSelector = dom2.inputSelector;
        const src2 = after.src || dom2.imgSrc || imgSrc;
        const captured2 = await captureCaptchaImageBuffer(page, captchaFrame, src2);
        if (captured2?.buf?.length) {
          finalBuf = captured2.buf;
          finalSrc = captured2.imgSrc || src2;
          finalKey = captured2.captchaKey || captchaKeyFromSrc(finalSrc);
          finalHash = hashBuffer(finalBuf);
          finalImgPath = path.join(folder, 'screenshots', `captcha_L${esc.level}_r.png`);
          fs.writeFileSync(finalImgPath, finalBuf);
          log(`2차 캡처: ${captured2.method} key=${(finalKey || '').slice(0, 12)}…`);
          tally2 = await gptOcrTally(finalBuf, apiKey, esc, hints, 'GPT2차');
          log(`2차 표: ${[...tally2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, c]) => `${a}(${c})`).join(', ') || '(없음)'}`);
        } else {
          log('2차 캡처 실패 — 1차 표만 사용');
        }
      }
    } else {
      log('새로고침 버튼 미감지 — 1차 표만 사용');
    }
  }

  const ranked = tally2.size
    ? (mergeCompare
      ? mergeRefreshCompareTallies(tally1, tally2)
      : [...tally2.entries()].map(([answer, count]) => ({ answer, count, both: false, c1: 0, c2: count }))
        .sort((a, b) => b.count - a.count || b.answer.length - a.answer.length))
    : [...tally1.entries()].map(([answer, count]) => ({ answer, count, both: false, c1: count, c2: 0 }))
      .sort((a, b) => b.count - a.count || b.answer.length - a.answer.length);

  if (!ranked.length) {
    log('유효한 OCR 결과 없음');
    logCaptchaFailure({ ...failBase, solver: 'gpt-refresh', reason: 'empty_ocr', answers: [] });
    return '';
  }

  log(`비교 합산: ${ranked.slice(0, 6).map((r) => `${r.answer}(${r.count}${r.both ? ',양쪽일치' : ''})`).join(', ')}`);
  logApi(`캡챠 단계${esc.level} 비교합산: 후보 ${ranked.length}개`);

  const ordered = filterLearnedAnswers(ranked.map((r) => r.answer));
  const answer = ordered[0];
  if (!answer) {
    logCaptchaFailure({
      ...failBase, solver: 'gpt-refresh', reason: 'no_plausible',
      answers: ranked.map((r) => r.answer), imageBuf: finalBuf, imageHash: finalHash, imagePath: finalImgPath,
      captchaKey: finalKey,
    });
    return '';
  }
  // 양쪽 일치한 답만 우선, 대안은 최대 2개
  const bothFirst = ranked.filter((r) => r.both).map((r) => r.answer);
  const alternatives = filterLearnedAnswers([
    ...bothFirst,
    ...ordered,
  ]).slice(0, 2);
  const pick = alternatives[0] || answer;
  const bothOk = ranked.find((r) => r.answer === pick)?.both;
  log(`채택 "${pick}" [${bothOk ? '양쪽일치' : 'GPT'}]${alternatives.length > 1 ? ` 대안: ${alternatives.slice(1).join(', ')}` : ''}`);
  return packResult({
    answer: pick,
    alternatives,
    inputId,
    inputSelector,
    captchaFrameIndex,
    esc,
    captchaKey: finalKey,
    imgSrc: finalSrc,
    solver: bothOk ? 'gpt-refresh-agree' : 'gpt-refresh',
    imageHash: finalHash,
  });
}

/** 제출 직전: 캡챠 이미지가 OCR 시점과 같은 key인지 */
export async function captchaImageStillFresh(page, expectedKey = '', expectedSrc = '') {
  if (!expectedKey && !expectedSrc) return true;
  try {
    const { captchaFrame } = await findCaptchaFrame(page);
    // CSS background(nhncaptchav4) 포함
    const cur = await currentCaptchaKey(captchaFrame);
    if (!cur) return true;
    if (expectedKey) {
      const k = captchaKeyFromSrc(cur);
      if (k && expectedKey && k !== expectedKey) return false;
    }
    if (expectedSrc && cur.split('?')[0] === expectedSrc.split('?')[0]) {
      const k1 = captchaKeyFromSrc(cur);
      const k2 = captchaKeyFromSrc(expectedSrc);
      if (k1 && k2 && k1 !== k2) return false;
    }
    return true;
  } catch {
    return true;
  }
}
