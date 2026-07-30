import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { generateSeoContentWithCursor } from './cursor-seo-content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'seo-site-templates');

/** 템플릿 파일 → 논리 키 → 앵커 ID (본문 H2에 순서대로 부여) */
const PAGE_DEFS = [
  {
    key: 'index',
    template: 'index.html',
    bodyClass: 'page-home',
    anchors: ['guide'],
    suffix: '', // {slug}.html
  },
  {
    key: 'fee-guide',
    template: 'fee-guide.html',
    bodyClass: 'page-fee',
    anchors: ['fee', 'receipt', 'alternatives'],
    suffix: '-fee',
  },
  {
    key: 'safety-check',
    template: 'safety-check.html',
    bodyClass: 'page-safety',
    anchors: ['privacy', 'terms', 'stop'],
    suffix: '-safety',
  },
  {
    key: 'faq',
    template: 'faq.html',
    bodyClass: 'page-faq',
    anchors: ['records', 'alternatives'],
    suffix: '-faq',
  },
];

const KEYWORD_SLUG_ALIASES = {
  신용카드현금화: 'credit-card-cash',
  카드깡: 'card-cash',
  신용카드한도현금화: 'credit-limit-cash',
  소액결제현금화: 'micropayment-cash',
};

/** 템플릿에 등장하는 이미지 파일명 (순서 = 사용자 이미지 매핑) */
export const TEMPLATE_IMAGE_NAMES = [
  'credit-card-cash-secure-guide.png',
  'credit-card-cash-fee-guide.png',
  'credit-card-cash-installment-guide.png',
  'credit-card-cash-safe-consultation.png',
  'credit-card-cash-premium-service.png',
  'card-payment-consulting-center.png',
  'credit-card-cash-application-guide.png',
  'credit-card-limit-cash-consultation.png',
  'credit-card-cash-professional-support.png',
  'card-cash-24hour-customer-support.png',
];

/** 금지어 → 안전한 대체 문구 (배포 중단 대신 치환) */
const FORBIDDEN_REPLACEMENTS = [
  { re: /키움24시/gi, to: '' },
  { re: /키움뱅크/gi, to: '' },
  { re: /키움페이/gi, to: '' },
  { re: /키움/gi, to: '' },
  { re: /무조건\s*가능/g, to: '상담 후 가능 여부 확인' },
  { re: /100%\s*가능/g, to: '상황에 따라 다를 수 있음' },
  { re: /승인\s*보장/g, to: '승인 여부 확인' },
  { re: /최저\s*수수료\s*보장/g, to: '수수료는 사전 확인' },
  { re: /즉시\s*입금\s*보장/g, to: '입금 시점은 사전 확인' },
  { re: /10년\s*무사고/g, to: '운영 기간은 직접 확인' },
  { re: /정식\s*등록\s*업체/g, to: '등록·인허가 여부는 직접 확인' },
  { re: /안전업체/g, to: '안전 여부는 직접 판단' },
];

const FORBIDDEN = FORBIDDEN_REPLACEMENTS.map((x) => x.re);

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePhone(display) {
  const digits = String(display || '010-6338-7124').replace(/\D/g, '');
  const d = digits.length >= 10 ? digits : '01063387124';
  const pretty = d.length === 11
    ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
    : '010-6338-7124';
  return { display: pretty, tel: `tel:${d}`, sms: `sms:${d}`, digits: d };
}

function logoHtml(keyword) {
  const kw = String(keyword || '').trim();
  const compact = kw.replace(/\s+/g, '');
  if (compact === '신용카드현금화') return '신용카드<span>현금화</span>';
  if (kw.length >= 4) {
    const cut = Math.ceil(kw.length / 2);
    return `${escapeHtml(kw.slice(0, cut))}<span>${escapeHtml(kw.slice(cut))}</span>`;
  }
  return `<span>${escapeHtml(kw)}</span>`;
}

/**
 * 핵심키워드 → URL용 영문 슬러그
 * 예: 신용카드 현금화 → credit-card-cash
 */
export function keywordToSlug(keyword, ftpId = '') {
  const raw = String(keyword || '').trim();
  const compact = raw.replace(/\s+/g, '');
  if (KEYWORD_SLUG_ALIASES[compact]) return KEYWORD_SLUG_ALIASES[compact];

  let s = raw
    .toLowerCase()
    .replace(/신용카드/g, 'credit-card')
    .replace(/현금화/g, 'cash')
    .replace(/카드깡/g, 'card-cash')
    .replace(/소액결제/g, 'micropayment')
    .replace(/한도/g, 'limit')
    .replace(/수수료/g, 'fee')
    .replace(/상담/g, 'consult')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (s.length < 3) {
    const id = String(ftpId || 'site').replace(/[^a-z0-9-]+/gi, '').toLowerCase() || 'site';
    s = `seo-${id}`;
  }
  return s.slice(0, 48);
}

function buildPageRoutes(slug) {
  return PAGE_DEFS.map((def) => {
    const file = def.suffix === '' ? `${slug}.html` : `${slug}${def.suffix}.html`;
    return { ...def, file, href: file };
  });
}

function findForbidden(text) {
  const hits = [];
  for (const { re } of FORBIDDEN_REPLACEMENTS) {
    re.lastIndex = 0;
    if (re.test(text)) hits.push(String(re));
  }
  return hits;
}

/** 금지어를 안전한 문구로 치환. 치환 내역 반환 */
function sanitizeForbidden(text) {
  let out = String(text || '');
  const replaced = [];
  for (const { re, to } of FORBIDDEN_REPLACEMENTS) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, to);
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.])/g, '$1');
    replaced.push(String(re));
  }
  return { text: out, replaced };
}

function assertNoForbidden(text, label) {
  const hits = findForbidden(text);
  if (hits.length) {
    throw new Error(`금지어 감지 (${label}): ${hits.join(', ')}`);
  }
}

/** 금지어가 있으면 치환하고, 그래도 남으면 에러 */
function scrubOrThrow(text, label, sendLog) {
  const first = findForbidden(text);
  if (!first.length) return text;
  const { text: cleaned, replaced } = sanitizeForbidden(text);
  if (replaced.length) {
    relay(sendLog, `⚠ 금지어 자동 치환 (${label}): ${replaced.join(', ')}`);
  }
  const left = findForbidden(cleaned);
  if (left.length) {
    throw new Error(`금지어 감지 (${label}): ${left.join(', ')}`);
  }
  return cleaned;
}

export function resolveOutputDir(ftpId, baseRoot) {
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const root = baseRoot
    || path.join(os.homedir(), 'Documents', 'Codex', '호스팅');
  const dayDir = path.join(root, `${y}-${m}-${d}`);
  const siteDir = path.join(dayDir, `${d}일_${ftpId}_seo_site`);
  return { dayDir, siteDir, dateLabel: `${y}-${m}-${d}` };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * 폴더 안 PNG/JPG/WEBP 중 랜덤으로 8~10장 선택 (슬롯 10개 채움)
 */
function listSourceImages(imageDir, sendLog) {
  const dir = path.resolve(String(imageDir || '').trim());
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(`이미지 폴더가 없습니다: ${imageDir || '(비어 있음)'}`);
  }
  const pool = fs.readdirSync(dir)
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
    .map((n) => path.join(dir, n));
  if (pool.length < 8) {
    throw new Error(`이미지가 부족합니다. PNG/JPG 8장 이상 필요 (현재 ${pool.length}장)`);
  }

  const shuffled = shuffleInPlace([...pool]);
  const need = TEMPLATE_IMAGE_NAMES.length; // 10
  const picked = [];

  // 중복 없이 최대 need장
  for (const f of shuffled) {
    if (picked.length >= need) break;
    picked.push(f);
  }
  // 8~9장만 있으면 나머지 슬롯은 풀에서 다시 랜덤 보충
  while (picked.length < need) {
    picked.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  relay(
    sendLog,
    `이미지 랜덤 선택: 폴더 ${pool.length}장 중 ${picked.length}장 → ${picked.map((p) => path.basename(p)).join(', ')}`,
  );
  return picked;
}

function copyImages(srcFiles, imgOutDir, sendLog) {
  fs.mkdirSync(imgOutDir, { recursive: true });
  const used = [];
  for (let i = 0; i < TEMPLATE_IMAGE_NAMES.length; i += 1) {
    const name = TEMPLATE_IMAGE_NAMES[i];
    const src = srcFiles[i];
    if (!src) throw new Error('이미지 선택 결과가 부족합니다.');
    const dest = path.join(imgOutDir, name);
    fs.copyFileSync(src, dest);
    used.push({ name, src: path.basename(src) });
  }
  relay(sendLog, `이미지 ${used.length}장 복사 → img/`);
  return used;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relatedKeywordsBar(relatedKeywords) {
  const chips = (relatedKeywords || []).map(
    (k) => `<span class="kw-chip">${escapeHtml(k)}</span>`,
  ).join('');
  return `<div class="kw-bar wrap" aria-label="관련 키워드">${chips}</div>`;
}

function sectionsToArticleHtml(pageData, { isFaq = false, anchors = [] } = {}) {
  const parts = [];
  let anchorIdx = 0;
  // FAQ 페이지: records 앵커를 FAQ 블록에 부여
  if (isFaq && Array.isArray(pageData.faqs) && pageData.faqs.length) {
    const id = anchors[anchorIdx] ? ` id="${anchors[anchorIdx]}"` : '';
    if (anchors[anchorIdx]) anchorIdx += 1;
    parts.push(`<h2${id}>자주 묻는 질문</h2><div class="faq">`);
    for (const item of pageData.faqs) {
      parts.push(
        `<details><summary>${escapeHtml(item.q)}</summary><p>${escapeHtml(item.a)}</p></details>`,
      );
    }
    parts.push('</div>');
  }
  for (const sec of pageData.sections || []) {
    if (sec.h2) {
      const id = anchors[anchorIdx] ? ` id="${anchors[anchorIdx]}"` : '';
      if (anchors[anchorIdx]) anchorIdx += 1;
      parts.push(`<h2${id}>${escapeHtml(sec.h2)}</h2>`);
    }
    if (sec.box) {
      parts.push(`<div class="summary"><strong>${escapeHtml(sec.box)}</strong></div>`);
    }
    if (sec.body) {
      for (const para of String(sec.body).split(/\n+/).filter(Boolean)) {
        parts.push(`<p>${escapeHtml(para)}</p>`);
      }
    }
    if (Array.isArray(sec.list) && sec.list.length) {
      const type = sec.listType === 'ol' ? 'ol' : 'ul';
      const cls = sec.listType === 'ol' ? 'steps' : 'check';
      parts.push(`<${type} class="${cls}">`);
      for (const li of sec.list) {
        parts.push(`<li>${escapeHtml(li)}</li>`);
      }
      parts.push(`</${type}>`);
    }
  }
  // 남은 필수 앵커가 있으면 빈 마커로 보장 (링크 깨짐 방지)
  while (anchorIdx < anchors.length) {
    parts.push(`<span id="${anchors[anchorIdx]}" hidden></span>`);
    anchorIdx += 1;
  }
  return parts.join('\n');
}

function rewriteInternalLinks(html, routes) {
  const byOld = {
    'index.html': routes.find((r) => r.key === 'index')?.href,
    'fee-guide.html': routes.find((r) => r.key === 'fee-guide')?.href,
    'safety-check.html': routes.find((r) => r.key === 'safety-check')?.href,
    'faq.html': routes.find((r) => r.key === 'faq')?.href,
  };
  let out = html;
  for (const [oldName, newName] of Object.entries(byOld)) {
    if (!newName) continue;
    out = out.split(oldName).join(newName);
  }
  return out;
}

function setCanonicalAndOg(html, pageUrl) {
  let out = html;
  const abs = pageUrl;
  if (/rel="canonical"/.test(out)) {
    out = out.replace(/rel="canonical"\s+href="[^"]*"/, `rel="canonical" href="${abs}"`);
    out = out.replace(/href="[^"]*"\s+rel="canonical"/, `href="${abs}" rel="canonical"`);
  }
  out = out.replace(/property="og:url"\s+content="[^"]*"/, `property="og:url" content="${abs}"`);
  return out;
}

function applyPageContent(html, pageKey, pageData, relatedKeywords, { anchors = [], pageUrl = '' } = {}) {
  if (!pageData) return html;
  let out = html;

  if (pageUrl) out = setCanonicalAndOg(out, pageUrl);

  if (pageData.title) {
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageData.title)}</title>`);
    out = out.replace(
      /property="og:title"\s+content="[^"]*"/,
      `property="og:title" content="${escapeHtml(pageData.title)}"`,
    );
    out = out.replace(
      /name="twitter:title"\s+content="[^"]*"/,
      `name="twitter:title" content="${escapeHtml(pageData.title)}"`,
    );
  }
  if (pageData.description) {
    out = out.replace(
      /name="description"\s+content="[^"]*"/,
      `name="description" content="${escapeHtml(pageData.description)}"`,
    );
    out = out.replace(
      /property="og:description"\s+content="[^"]*"/,
      `property="og:description" content="${escapeHtml(pageData.description)}"`,
    );
    out = out.replace(
      /name="twitter:description"\s+content="[^"]*"/,
      `name="twitter:description" content="${escapeHtml(pageData.description)}"`,
    );
  }
  if (relatedKeywords?.length) {
    const kwMeta = relatedKeywords.join(', ');
    if (/name="keywords"/.test(out)) {
      out = out.replace(
        /name="keywords"\s+content="[^"]*"/,
        `name="keywords" content="${escapeHtml(kwMeta)}"`,
      );
    } else {
      out = out.replace(
        /<meta name="robots"/,
        `<meta name="keywords" content="${escapeHtml(kwMeta)}">\n<meta name="robots"`,
      );
    }
  }
  if (pageData.h1) {
    out = out.replace(/<h1>[^<]*<\/h1>/, `<h1>${escapeHtml(pageData.h1)}</h1>`);
  }
  if (pageData.lead) {
    out = out.replace(
      /<p class="lead">[\s\S]*?<\/p>/,
      `<p class="lead">${escapeHtml(pageData.lead)}</p>`,
    );
  }

  // index: guide 앵커는 본문 섹션 또는 hero 아래 body에 유지
  const articleAnchors = pageKey === 'index'
    ? anchors.filter((a) => a !== 'guide')
    : anchors;
  const articleInner = sectionsToArticleHtml(pageData, {
    isFaq: pageKey === 'faq',
    anchors: articleAnchors,
  });
  if (articleInner) {
    out = out.replace(
      /(<article class="article">)[\s\S]*?(<\/article>)/,
      `$1\n${articleInner}\n$2`,
    );
  }
  if (pageKey === 'index' && anchors.includes('guide') && !/\sid="guide"/.test(out)) {
    out = out.replace(/<section class="body"/, '<section class="body" id="guide"');
  }

  if (relatedKeywords?.length) {
    out = out.replace(
      /(<\/div>\s*<\/div>\s*<main>)/,
      `</div>\n</div>\n${relatedKeywordsBar(relatedKeywords)}\n<main>`,
    );
  }

  return out;
}

function transformHtml(html, ctx) {
  let out = html;
  const { ftpId, keyword, phone, externalUrl, baseHttps, homeHref } = ctx;

  out = out.split('cardcash23').join(ftpId);
  out = out.split('https://cardcash23.dothome.co.kr').join(baseHttps);
  out = out.split('http://cardcash23.dothome.co.kr').join(baseHttps);

  if (externalUrl) {
    out = out.replace(
      /href="https:\/\/cardggang24\.dothome\.co\.kr\/?"/g,
      `href="${externalUrl}" rel="noopener noreferrer"`,
    );
  } else {
    out = out.replace(/<a class="btn primary"[^>]*>[\s\S]*?<\/a>\s*/g, '');
    out = out.replace(
      /href="https:\/\/cardggang24\.dothome\.co\.kr\/?"/g,
      `href="${homeHref}#guide"`,
    );
  }

  out = out.split('010-6338-7124').join(phone.display);
  out = out.split('tel:01063387124').join(phone.tel);
  out = out.split('sms:01063387124').join(phone.sms);
  out = out.split('01063387124').join(phone.digits);

  // 템플릿 기본 키워드 → 사용자 핵심키워드
  out = out.split('신용카드현금화').join(keyword);

  out = out.replace(
    /<a class="logo" href="[^"]*">[\s\S]*?<\/a>/,
    `<a class="logo" href="${homeHref}">${logoHtml(keyword)}</a>\n<button class="menu-toggle" type="button" aria-label="메뉴">메뉴</button>`,
  );

  out = out.replace(
    /<div class="contact-card">([\s\S]*?)<a href="tel:[^"]+">([\s\S]*?)<\/a>([\s\S]*?)<\/div>/g,
    '<div class="contact-card">$1<span class="cta-plain">$2</span>$3</div>',
  );

  return out;
}

function buildRobots(baseHttps) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${baseHttps}/sitemap.xml\n`;
}

function buildSitemap(baseHttps, images, routes) {
  const imgTags = images.map((im, i) => {
    const titles = [
      '상담 전 확인 기준',
      '수수료 비교',
      '카드 조건 확인',
      '안전 점검',
      '개인정보 보호',
      '자주 묻는 질문',
      '상담 기록 보관',
      '실제 부담액 비교',
      '조건 먼저 확인',
      '합법 대안 비교',
    ];
    return `  <image:image>
    <image:loc>${baseHttps}/img/${im.name}</image:loc>
    <image:title>${titles[i] || im.name}</image:title>
  </image:image>`;
  }).join('\n');

  const home = routes.find((r) => r.key === 'index');
  const fee = routes.find((r) => r.key === 'fee-guide');
  const safety = routes.find((r) => r.key === 'safety-check');
  const faq = routes.find((r) => r.key === 'faq');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${baseHttps}/${home.href}</loc>
${imgTags}
  </url>
  <url>
    <loc>${baseHttps}/${fee.href}</loc>
    <image:image>
      <image:loc>${baseHttps}/img/${TEMPLATE_IMAGE_NAMES[1]}</image:loc>
      <image:title>수수료와 실제 부담액 비교</image:title>
    </image:image>
  </url>
  <url>
    <loc>${baseHttps}/${safety.href}</loc>
    <image:image>
      <image:loc>${baseHttps}/img/${TEMPLATE_IMAGE_NAMES[3]}</image:loc>
      <image:title>개인정보와 카드사 약관 점검</image:title>
    </image:image>
  </url>
  <url>
    <loc>${baseHttps}/${faq.href}</loc>
    <image:image>
      <image:loc>${baseHttps}/img/${TEMPLATE_IMAGE_NAMES[5]}</image:loc>
      <image:title>상담 전 자주 묻는 질문</image:title>
    </image:image>
  </url>
</urlset>
`;
}

function collectIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\sid=["']([^"']+)["']/g)) ids.add(m[1]);
  return ids;
}

/**
 * 내부 링크·앵커 점검. 깨진 해시만 제거, 없는 파일은 오류.
 */
function validateAndFixLinks(siteDir, htmlFiles, sendLog) {
  const fileSet = new Set(htmlFiles);
  const idMap = new Map();
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(siteDir, f), 'utf8');
    idMap.set(f, collectIds(html));
  }

  for (const f of htmlFiles) {
    let html = fs.readFileSync(path.join(siteDir, f), 'utf8');
    let changed = false;
    html = html.replace(/\bhref=["']([^"']+)["']/g, (full, href) => {
      if (/^(https?:|tel:|sms:|mailto:|javascript:)/i.test(href)) return full;
      if (href.startsWith('#')) {
        const id = href.slice(1);
        if (id && !idMap.get(f)?.has(id)) {
          changed = true;
          relay(sendLog, `앵커 수정: ${f} ${href} → (제거)`);
          return 'href="#"';
        }
        return full;
      }
      const [pathPart, hash] = href.split('#');
      const target = pathPart || f;
      if (!fileSet.has(target) && !fs.existsSync(path.join(siteDir, target))) {
        throw new Error(`깨진 내부 링크: ${f} → ${href}`);
      }
      if (hash && fileSet.has(target) && !idMap.get(target)?.has(hash)) {
        changed = true;
        relay(sendLog, `앵커 수정: ${f} ${href} → ${target}`);
        return `href="${target}"`;
      }
      return full;
    });
    if (changed) fs.writeFileSync(path.join(siteDir, f), html, 'utf8');
  }
  relay(sendLog, '내부 링크·앵커 점검 완료');
}

/**
 * 정적 SEO 4페이지 사이트 생성 (Cursor API로 관련키워드·본문 재작성)
 */
/**
 * 구글 Search Console HTML 인증 파일을 사이트 루트에 복사
 * 예: googlef55ada0a814882a8.html
 */
export function installGoogleVerifyFile(siteDir, googleVerifyFile, sendLog) {
  const src = String(googleVerifyFile || '').trim();
  if (!src) {
    relay(sendLog, '구글 인증 파일: (없음 · 선택사항)');
    return null;
  }
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error(`구글 인증 파일을 찾을 수 없습니다: ${src}`);
  }
  const base = path.basename(src);
  if (!/^google[a-z0-9]+\.html$/i.test(base)) {
    relay(sendLog, `⚠ 파일명이 google….html 형식이 아닙니다: ${base} (그대로 복사)`);
  }
  const dest = path.join(siteDir, base);
  fs.copyFileSync(src, dest);
  // 내용이 비어 있으면 Search Console 기본 형식 보정
  let body = fs.readFileSync(dest, 'utf8').trim();
  if (!body) {
    body = `google-site-verification: ${base}`;
    fs.writeFileSync(dest, `${body}\n`, 'utf8');
  }
  relay(sendLog, `구글 인증 파일 포함: ${base}`);
  return base;
}

export async function generateDothomeSeoSite({
  ftpId,
  keyword,
  phoneDisplay = '010-6338-7124',
  externalUrl = '',
  imageDir,
  outputRoot,
  cursorApiKey = '',
  googleVerifyFile = '',
  sendLog,
} = {}) {
  const id = String(ftpId || '').trim();
  const kw = String(keyword || '').trim();
  if (!id) throw new Error('FTP/호스팅 아이디가 필요합니다.');
  if (!kw) throw new Error('핵심키워드가 필요합니다.');
  if (!String(cursorApiKey || '').trim()) {
    throw new Error('Cursor API Key가 필요합니다. 넷리파이 생성 탭에 키를 입력·저장하세요.');
  }

  let ext = String(externalUrl || '').trim();
  if (ext && !/^https?:\/\//i.test(ext)) ext = `https://${ext}`;
  // 비어 있으면 선택사항 — 외부 버튼 미표시

  const phone = normalizePhone(phoneDisplay);
  const baseHttps = `https://${id}.dothome.co.kr`;
  const slug = keywordToSlug(kw, id);
  const routes = buildPageRoutes(slug);
  const homeRoute = routes.find((r) => r.key === 'index');
  const { dayDir, siteDir } = resolveOutputDir(id, outputRoot);

  relay(sendLog, `═══ 정적 SEO 사이트 생성 ═══`);
  relay(sendLog, `키워드: ${kw}`);
  relay(sendLog, `슬러그: ${slug}`);
  relay(sendLog, `홈 URL: ${baseHttps}/${homeRoute.href}`);
  relay(sendLog, `호스팅: ${id}`);
  relay(sendLog, `외부 연결: ${ext || '(없음·선택사항)'}`);
  relay(sendLog, `저장: ${siteDir}`);

  let ai = await generateSeoContentWithCursor({
    keyword: kw,
    phoneDisplay: phone.display,
    apiKey: cursorApiKey,
    sendLog,
  });
  // AI JSON 전체에 금지어가 있으면 먼저 치환
  {
    const rawAi = JSON.stringify(ai);
    const hits = findForbidden(rawAi);
    if (hits.length) {
      relay(sendLog, `⚠ AI 문구 금지어 감지 → 자동 치환: ${hits.join(', ')}`);
      const { text: cleaned } = sanitizeForbidden(rawAi);
      try {
        ai = JSON.parse(cleaned);
      } catch {
        // JSON 깨지면 페이지별 문자열만 다시 훑음 — 아래 scrubOrThrow가 처리
      }
    }
  }
  const relatedKeywords = ai.relatedKeywords || [];

  fs.mkdirSync(dayDir, { recursive: true });
  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
  fs.mkdirSync(siteDir, { recursive: true });

  const srcImages = listSourceImages(imageDir, sendLog);
  const imgMeta = copyImages(srcImages, path.join(siteDir, 'img'), sendLog);

  const ctx = {
    ftpId: id,
    keyword: kw,
    phone,
    externalUrl: ext,
    baseHttps,
    homeHref: homeRoute.href,
  };

  const writtenPages = [];
  for (const route of routes) {
    const raw = fs.readFileSync(path.join(TEMPLATE_DIR, route.template), 'utf8');
    let html = transformHtml(raw, ctx);
    html = rewriteInternalLinks(html, routes);
    const pageUrl = `${baseHttps}/${route.href}`;
    html = applyPageContent(html, route.key, ai.pages?.[route.key], relatedKeywords, {
      anchors: route.anchors,
      pageUrl,
    });
    let chipIdx = 0;
    html = html.replace(/<small>([^<]*)<\/small>/g, (m) => {
      if (chipIdx < relatedKeywords.length) {
        const rk = relatedKeywords[chipIdx];
        chipIdx += 1;
        return `<small>${escapeHtml(rk)}</small>`;
      }
      return m;
    });
    html = scrubOrThrow(html, route.file, sendLog);
    fs.writeFileSync(path.join(siteDir, route.file), html, 'utf8');
    writtenPages.push(route.file);
    relay(sendLog, `작성: ${route.file} ← ${route.template}`);
  }

  // / 접속용 index.html → 슬러그 홈으로 이동 (주소창에 index.html 안 남김)
  fs.writeFileSync(
    path.join(siteDir, 'index.html'),
    `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=./${homeRoute.href}">
<link rel="canonical" href="${baseHttps}/${homeRoute.href}">
<title>${escapeHtml(kw)}</title>
<script>location.replace("./${homeRoute.href}");</script>
</head>
<body>
<p><a href="./${homeRoute.href}">${escapeHtml(kw)} 안내로 이동</a></p>
</body>
</html>
`,
    'utf8',
  );

  // Apache: / 에서 슬러그 홈을 기본 문서로
  fs.writeFileSync(
    path.join(siteDir, '.htaccess'),
    `DirectoryIndex ${homeRoute.href} index.html\n`,
    'utf8',
  );

  let css = fs.readFileSync(path.join(TEMPLATE_DIR, 'site.css'), 'utf8');
  if (!css.includes('.kw-bar')) {
    css += `
.kw-bar{display:flex;flex-wrap:wrap;gap:8px;padding:10px 0 4px}
.kw-chip{display:inline-block;padding:5px 11px;border-radius:999px;background:#e7f6f2;color:#0f5f56;font-size:13px;font-weight:800;border:1px solid #cfe8e1}
.page-fee .kw-chip{background:#fce8ef;color:#7a2d45;border-color:#f0c9d6}
.page-safety .kw-chip{background:#e8f1f5;color:#2f5570;border-color:#cfdfe8}
.page-faq .kw-chip{background:#eef5e9;color:#2f5a40;border-color:#d5e4cf}
@media(max-width:820px){.kw-bar{padding:8px 0}}
`;
  }
  fs.writeFileSync(path.join(siteDir, 'site.css'), css, 'utf8');
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'site.js'), path.join(siteDir, 'site.js'));
  fs.writeFileSync(path.join(siteDir, 'robots.txt'), buildRobots(baseHttps), 'utf8');
  fs.writeFileSync(
    path.join(siteDir, 'sitemap.xml'),
    buildSitemap(baseHttps, imgMeta.map((m) => ({ name: m.name })), routes),
    'utf8',
  );
  const googleName = installGoogleVerifyFile(siteDir, googleVerifyFile, sendLog);

  validateAndFixLinks(siteDir, writtenPages, sendLog);

  for (const f of [...writtenPages, 'index.html', 'site.css', 'site.js', 'robots.txt', 'sitemap.xml', '.htaccess']) {
    if (!fs.existsSync(path.join(siteDir, f))) throw new Error(`생성 누락: ${f}`);
  }
  for (const name of TEMPLATE_IMAGE_NAMES.slice(0, 8)) {
    if (!fs.existsSync(path.join(siteDir, 'img', name))) {
      throw new Error(`이미지 누락: img/${name}`);
    }
  }

  relay(sendLog, `✔ 생성 완료: ${siteDir}`);
  relay(sendLog, `페이지: ${writtenPages.join(', ')}`);
  return {
    ok: true,
    siteDir,
    siteUrl: `${baseHttps}/${homeRoute.href}`,
    homeUrl: `${baseHttps}/${homeRoute.href}`,
    rootUrl: `${baseHttps}/`,
    ftpId: id,
    keyword: kw,
    slug,
    relatedKeywords,
    images: imgMeta,
    pages: writtenPages,
    googleVerifyFile: googleName || '',
    routes: routes.map((r) => ({ key: r.key, file: r.file, url: `${baseHttps}/${r.href}` })),
  };
}
