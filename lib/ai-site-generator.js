import fs from 'fs';
import path from 'path';

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (c) => map[c] || c);
}

function escapeAttr(text) {
  return escapeHtml(text);
}

function escapeJsonLd(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function stripTrailingSlash(url = '') {
  return String(url || '').replace(/\/+$/, '');
}

function splitSentences(text) {
  return String(text || '')
    .replace(/([.!?。！？])\s+/g, '$1|')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sentenceParagraphs(text, fallback = '') {
  const source = text || fallback;
  const sentences = splitSentences(source);
  if (!sentences.length) return [`${fallback || source}`].filter(Boolean);
  const groups = [];
  for (let i = 0; i < sentences.length; i += 2) {
    groups.push(sentences.slice(i, i + 2).join(' '));
  }
  return groups;
}

function slugify(text, fallback = 'page') {
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\uAC00-\uD7AF-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || fallback;
}

function uniqueSlug(raw, index, used) {
  const base = slugify(raw, `page-${index + 1}`);
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOr(value, fallback) {
  const str = String(value || '').trim();
  return str || fallback;
}

/** 메타 타이틀에서 SEO 핵심 구문 추출 (| · - : 앞부분) */
function seoPrimaryFromMetaTitle(metaTitle, fallback = '') {
  const raw = String(metaTitle || '').trim();
  if (!raw) return String(fallback || '').trim();
  const part = raw.split(/\s*[|·｜\-–—:：]\s*/)[0].trim();
  return part || raw;
}

/** 페이지당 H1은 메타 타이틀과 일치 (검색 노출 정렬) */
function buildSeoH1(metaTitle, fallback = '') {
  const meta = String(metaTitle || '').trim();
  if (!meta) return String(fallback || '').trim();
  if (meta.length <= 70) return meta;
  return seoPrimaryFromMetaTitle(meta, fallback);
}

/** 홈 섹션 H2 — 메타 타이틀/핵심어 포함 */
function buildHomeSeoHeadings(metaTitle, name, keyword) {
  const primary = seoPrimaryFromMetaTitle(metaTitle, keyword || name);
  return {
    h1: buildSeoH1(metaTitle, primary),
    primary,
    intro: `${primary} 소개`,
    features: `${primary} 핵심 강점`,
    process: `${primary} 이용 절차`,
    why: `${name}를 선택해야 하는 이유`,
    guides: `${primary} 상세 안내`,
    faq: `${primary} 자주 묻는 질문`,
  };
}

/** 서브페이지 H1/H2 — 페이지 타이틀 기준 */
function buildSubSeoHeadings(pageTitle, metaTitle, keyword) {
  const primary = seoPrimaryFromMetaTitle(pageTitle || metaTitle, keyword);
  return {
    h1: buildSeoH1(pageTitle, primary),
    primary,
    overview: `${primary} 한눈에 보기`,
    faq: `${primary} 자주 묻는 질문`,
    related: `${primary} 관련 안내`,
  };
}

function headingIncludesKeyword(heading, keyword) {
  const h = String(heading || '');
  const k = String(keyword || '').trim();
  if (!k) return true;
  return h.includes(k) || k.split(/\s+/).some((part) => part.length >= 2 && h.includes(part));
}

function withKeywordHeading(heading, keyword, fallback) {
  const base = textOr(heading, fallback);
  if (headingIncludesKeyword(base, keyword)) return base;
  const k = String(keyword || '').trim();
  return k ? `${k} ${base}` : base;
}

function normalizeKeywords(value, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return textOr(value, fallback);
}

function normalizeSections(sections, title, keyword, name) {
  const primary = seoPrimaryFromMetaTitle(title, keyword);
  const defaults = [
    {
      heading: `${primary} 핵심 이해`,
      body: `${keyword}를 검토할 때는 단순한 가격이나 안내 문구보다 실제 상황에 맞는 절차, 준비 사항, 예상 소요 시간을 함께 확인하는 것이 중요합니다. ${name}는 처음 문의하는 분도 흐름을 쉽게 이해할 수 있도록 기본 조건부터 주의할 점까지 차근차근 안내합니다.`,
    },
    {
      heading: `${primary} 상담 전 확인 사항`,
      body: `상담 전에는 원하는 일정, 현재 상황, 필요한 서류나 조건을 미리 정리해 두면 더 빠르고 정확한 안내를 받을 수 있습니다. 특히 ${keyword} 관련 선택지는 상황에 따라 달라질 수 있어, 충분한 설명을 듣고 비교한 뒤 결정하는 과정이 필요합니다.`,
    },
    {
      heading: `${primary} 진행 과정과 장점`,
      body: `${name}는 문의 접수 후 핵심 조건을 확인하고, 가능한 방법과 예상 결과를 현실적으로 안내합니다. 불필요한 과장 없이 진행 가능 범위와 유의사항을 함께 설명해 신뢰할 수 있는 결정을 돕습니다.`,
    },
    {
      heading: `${primary} 전문가 상담 활용법`,
      body: `${keyword}는 세부 조건에 따라 결과가 달라질 수 있으므로 혼자 판단하기보다 경험 있는 상담자에게 현재 상황을 공유하는 것이 좋습니다. 궁금한 점을 메모해 두고 문의하면 상담 시간을 더 효율적으로 활용할 수 있습니다.`,
    },
  ];
  const cleaned = asArray(sections).slice(0, 4).map((section, i) => ({
    heading: withKeywordHeading(section?.heading, primary, defaults[i]?.heading || `${primary} 상세 안내 ${i + 1}`),
    body: textOr(section?.body, defaults[i]?.body || defaults[0].body),
  }));
  while (cleaned.length < 4) cleaned.push(defaults[cleaned.length]);
  return cleaned;
}

function normalizeFaq(faq, fallbackTopic, phone, count = 3) {
  const defaults = [
    {
      q: `${fallbackTopic} 상담은 어떻게 시작하나요?`,
      a: `전화 ${phone} 또는 문자로 문의하시면 현재 상황을 확인한 뒤 필요한 절차와 가능 여부를 안내해 드립니다.`,
    },
    {
      q: '처음 문의해도 자세히 안내받을 수 있나요?',
      a: '네. 기본 개념부터 준비 사항, 진행 순서까지 이해하기 쉽게 설명드리므로 처음 이용하는 분도 부담 없이 문의할 수 있습니다.',
    },
    {
      q: '당일 상담도 가능한가요?',
      a: '상담 일정과 문의량에 따라 당일 안내가 가능합니다. 빠른 확인이 필요하다면 전화 문의를 권장합니다.',
    },
    {
      q: '비용이나 조건은 어떻게 확인하나요?',
      a: '상황과 요청 범위에 따라 달라질 수 있어 상담 시 조건을 확인한 뒤 명확하게 안내해 드립니다.',
    },
  ];
  const cleaned = asArray(faq).slice(0, count).map((item, i) => ({
    q: textOr(item?.q, defaults[i]?.q || defaults[0].q),
    a: textOr(item?.a, defaults[i]?.a || defaults[0].a),
  }));
  while (cleaned.length < count) cleaned.push(defaults[cleaned.length]);
  return cleaned;
}

function normalizeFeatures(features, keyword, name) {
  const defaults = [
    {
      title: '상황별 맞춤 안내',
      desc: `${keyword}를 찾는 이유와 조건을 먼저 확인한 뒤 필요한 정보만 선별해 안내합니다.`,
    },
    {
      title: '빠른 상담 연결',
      desc: '전화와 문자 문의를 통해 필요한 내용을 신속하게 확인하고 다음 단계를 안내합니다.',
    },
    {
      title: '명확한 절차 설명',
      desc: '진행 전 알아야 할 준비 사항, 일정, 주의점을 이해하기 쉬운 흐름으로 정리합니다.',
    },
    {
      title: '신뢰 중심 운영',
      desc: `${name}는 과장된 표현보다 실제 도움이 되는 정보와 현실적인 상담을 우선합니다.`,
    },
  ];
  const cleaned = asArray(features).slice(0, 4).map((item, i) => ({
    title: withKeywordHeading(item?.title, keyword, defaults[i]?.title || `강점 ${i + 1}`),
    desc: textOr(item?.desc, defaults[i]?.desc || defaults[0].desc),
  }));
  while (cleaned.length < 4) cleaned.push(defaults[cleaned.length]);
  return cleaned;
}

function normalizeProcess(process, keyword) {
  const defaults = [
    { title: '문의 접수', desc: `전화 또는 문자로 ${keyword} 관련 문의 내용을 남겨 주세요.` },
    { title: '상황 확인', desc: '필요한 조건과 현재 상황을 확인해 가능한 방향을 정리합니다.' },
    { title: '맞춤 안내', desc: '절차, 일정, 유의사항을 포함해 이해하기 쉽게 설명합니다.' },
    { title: '상담 진행', desc: '결정에 필요한 추가 질문을 확인하고 다음 단계를 도와드립니다.' },
  ];
  const cleaned = asArray(process).slice(0, 4).map((item, i) => ({
    title: textOr(item?.title, defaults[i]?.title || `단계 ${i + 1}`),
    desc: textOr(item?.desc, defaults[i]?.desc || defaults[0].desc),
  }));
  while (cleaned.length < 4) cleaned.push(defaults[cleaned.length]);
  return cleaned;
}

function normalizeSubPages(subPages, { name, keyword, phone, metaTitle = '' }) {
  const primary = seoPrimaryFromMetaTitle(metaTitle, keyword || name);
  const fallback = buildFallbackSubPages({ name, keyword: primary, phone, metaTitle });
  const used = new Set();
  const pages = asArray(subPages).slice(0, 6).map((page, i) => {
    const source = fallback[i];
    let title = textOr(page?.title, source.title);
    title = withKeywordHeading(title, primary, source.title);
    const headings = buildSubSeoHeadings(title, metaTitle, primary);
    return {
      title: headings.h1,
      slug: uniqueSlug(page?.slug || title, i, used),
      metaDescription: textOr(page?.metaDescription, source.metaDescription),
      summary: textOr(page?.summary, source.summary),
      sections: normalizeSections(page?.sections, headings.h1, primary, name),
      faq: normalizeFaq(page?.faq, headings.primary, phone, 3),
      keywords: normalizeKeywords(page?.keywords, source.keywords),
      sectionHeadings: headings,
    };
  });

  while (pages.length < 6) {
    const i = pages.length;
    const page = { ...fallback[i], slug: uniqueSlug(fallback[i].slug, i, used) };
    page.sectionHeadings = buildSubSeoHeadings(page.title, metaTitle, primary);
    pages.push(page);
  }
  return pages;
}

function normalizePlan(plan, input) {
  const { name, keyword, phone, metaTitle, metaDescription, metaKeywords } = input;
  const fallback = buildFallbackPlan(input);
  const resolvedMetaTitle = textOr(plan?.metaTitle, metaTitle || fallback.metaTitle);
  const headings = buildHomeSeoHeadings(resolvedMetaTitle, name, keyword);
  // H1은 메타 타이틀과 정렬 — AI heroTitle이 달라도 메타 기준 강제
  const heroTitle = headings.h1;
  return {
    metaTitle: resolvedMetaTitle,
    metaDescription: textOr(plan?.metaDescription, metaDescription || fallback.metaDescription),
    metaKeywords: normalizeKeywords(plan?.metaKeywords, metaKeywords || fallback.metaKeywords),
    heroTitle,
    heroSubtitle: textOr(plan?.heroSubtitle, fallback.heroSubtitle),
    intro: textOr(plan?.intro, fallback.intro),
    features: normalizeFeatures(plan?.features, keyword, name),
    process: normalizeProcess(plan?.process, keyword),
    whyChoose: textOr(plan?.whyChoose, fallback.whyChoose),
    homeFaq: normalizeFaq(plan?.homeFaq, headings.primary, phone, 4),
    ctaTitle: withKeywordHeading(plan?.ctaTitle, headings.primary, fallback.ctaTitle),
    ctaText: textOr(plan?.ctaText, fallback.ctaText),
    sectionHeadings: headings,
    subPages: normalizeSubPages(plan?.subPages, {
      name,
      keyword,
      phone,
      metaTitle: resolvedMetaTitle,
    }),
  };
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(candidate);
  }
}

async function callOpenAIJson(apiKey, systemPrompt, userPrompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.65,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.error?.message || `OpenAI API 오류 (${resp.status})`);
  const raw = data.choices?.[0]?.message?.content || '{}';
  return parseJsonObject(raw);
}

async function generateBannerImage(apiKey, keyword, name) {
  // 계정/플랜에 따라 사용 가능한 이미지 모델이 다르므로 순서대로 시도한다.
  const models = ['gpt-image-2', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'];
  const prompt = `Premium Korean SEO landing page hero banner for "${name}" and keyword "${keyword}". Professional local service website image, warm trust-building business atmosphere, natural Korean office/service context, modern editorial composition, clean negative space for headline overlay, no text, no logo, no watermark, high quality.`;
  let lastErr = '';

  for (const model of models) {
    const body = { model, prompt, n: 1, size: '1024x1024' };
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      lastErr = `${model}: ${data.error?.message || `이미지 생성 실패 (${resp.status})`}`;
      continue;
    }
    const item = data.data?.[0];
    if (!item) {
      lastErr = `${model}: 이미지 데이터 없음`;
      continue;
    }
    if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item.url) {
      const imgResp = await fetch(item.url);
      if (!imgResp.ok) {
        lastErr = `${model}: 이미지 다운로드 실패 (${imgResp.status})`;
        continue;
      }
      return Buffer.from(await imgResp.arrayBuffer());
    }
    lastErr = `${model}: b64_json/url 없음`;
  }
  throw new Error(lastErr || '이미지 생성 실패');
}

function buildFallbackSubPages({ name, keyword, phone, metaTitle = '' }) {
  const base = seoPrimaryFromMetaTitle(metaTitle, keyword || name);
  const topics = [
    `${base} 상담 안내`,
    `${base} 이용 절차`,
    `${base} 비용과 조건`,
    `${base} 준비 사항`,
    `${base} 주의할 점`,
    `${base} 전문가 문의`,
  ];
  return topics.map((title, i) => {
    const headings = buildSubSeoHeadings(title, metaTitle, base);
    return {
      title: headings.h1,
      slug: `page-${i + 1}`,
      metaDescription: `${title}를 찾는 분을 위해 ${name}가 절차, 조건, 상담 방법을 자세히 안내합니다. 문의 ${phone}`,
      summary: `${title}에 대해 처음 확인해야 할 핵심 정보와 상담 전 알아두면 좋은 내용을 정리했습니다.`,
      sections: normalizeSections([], title, base, name),
      faq: normalizeFaq([], title, phone, 3),
      keywords: `${base}, ${title}, ${name}, 상담, 문의`,
      sectionHeadings: headings,
    };
  });
}

function buildFallbackPlan({ name, keyword, phone, metaTitle, metaDescription, metaKeywords }) {
  const resolvedMeta = metaTitle || `${keyword || name} | ${name} 전문 상담 안내`;
  const headings = buildHomeSeoHeadings(resolvedMeta, name, keyword);
  const base = headings.primary;
  return {
    metaTitle: resolvedMeta,
    metaDescription: metaDescription || `${name}에서 ${base} 관련 절차, 조건, 비용, 상담 방법을 한눈에 확인하세요. 빠른 문의 ${phone}`,
    metaKeywords: metaKeywords || `${base}, ${name}, ${base} 상담, ${base} 안내, 전화상담`,
    heroTitle: headings.h1,
    heroSubtitle: `${name}가 ${base}에 대한 복잡한 정보를 쉽게 정리하고 상황에 맞는 상담 방향을 안내합니다.`,
    intro: `${name}는 ${base}를 알아보는 분들이 신뢰할 수 있는 정보를 빠르게 확인할 수 있도록 구성된 전문 안내 사이트입니다. 절차와 조건, 상담 전 준비할 사항을 한눈에 이해할 수 있도록 정리했습니다. 처음 문의하는 분도 부담 없이 확인할 수 있으며, 필요한 경우 전화와 문자로 빠르게 상담을 이어갈 수 있습니다.`,
    features: normalizeFeatures([], base, name),
    process: normalizeProcess([], base),
    whyChoose: `${base}는 개인의 상황과 조건에 따라 확인해야 할 내용이 달라질 수 있습니다. ${name}는 단순한 홍보 문구보다 실제 문의자가 궁금해하는 절차, 준비 사항, 유의점을 중심으로 안내합니다. 빠른 상담 연결과 명확한 설명을 통해 처음 알아보는 분도 안정적으로 다음 단계를 결정할 수 있습니다.`,
    homeFaq: normalizeFaq([], base, phone, 4),
    ctaTitle: `지금 ${base} 상담이 필요하신가요?`,
    ctaText: `전화 ${phone} 또는 문자로 문의하시면 현재 상황에 맞는 안내를 빠르게 받아보실 수 있습니다.`,
    sectionHeadings: headings,
    subPages: buildFallbackSubPages({ name, keyword: base, phone, metaTitle: resolvedMeta }),
  };
}

export async function generateSitePlan({
  name,
  keyword,
  phone,
  metaTitle = '',
  metaDescription = '',
  metaKeywords = '',
  openaiApiKey = '',
  sendLog = null,
}) {
  const log = (msg) => sendLog?.(msg);
  const input = { name, keyword, phone, metaTitle, metaDescription, metaKeywords };
  if (!openaiApiKey) {
    log('OpenAI API Key 없음 — 고품질 템플릿 콘텐츠 사용');
    return normalizePlan(buildFallbackPlan(input), input);
  }

  log('OpenAI로 SEO 랜딩페이지 콘텐츠 생성 중...');
  const systemPrompt = `당신은 한국어 SEO 랜딩페이지 전략가이자 전문 카피라이터입니다. 반드시 유효한 JSON 객체만 출력하세요.
목표: 메타 타이틀 중심의 헤딩 구조(H1/H2/H3)를 갖춘 검색 최적화 랜딩 콘텐츠를 작성합니다.
주의:
- 과장 광고, 허위 보장, 의미 없는 AI식 표현을 피하세요.
- 검색 의도를 고려해 구체적이고 자연스러운 한국어 문장으로 작성하세요.
- slug는 영문 소문자, 숫자, 하이픈만 사용하세요.
- subPages는 정확히 6개여야 합니다.
- 각 subPages.sections는 정확히 4개이며 body는 각각 2~3문장의 긴 단락으로 작성하세요.
- 각 subPages.faq는 정확히 3개입니다.
- homeFaq는 정확히 4개입니다.
- features는 정확히 4개, process는 정확히 4개입니다.
- SEO 헤딩 규칙(필수):
  1) metaTitle은 사용자가 준 메타 타이틀 힌트를 우선 반영하세요.
  2) heroTitle(홈 H1)은 metaTitle과 동일하거나 핵심 구문만 남긴 형태여야 합니다. 메타와 무관한 마케팅 문구 H1 금지.
  3) 섹션용 제목(features/process/cta의 상위 개념)과 서브페이지 title, sections.heading에는 metaTitle의 핵심 키워드를 자연스럽게 포함하세요.
  4) 페이지당 H1 주제는 하나, 하위는 H2→H3 계층을 의식해 작성하세요.

JSON 스키마:
{
  "metaTitle": "50자 내외",
  "metaDescription": "120~155자",
  "metaKeywords": "쉼표 구분 키워드",
  "heroTitle": "메타 타이틀과 정렬된 H1",
  "heroSubtitle": "신뢰감 있는 보조 문구",
  "intro": "3~4문장 소개문",
  "features": [{"title":"", "desc":""}],
  "process": [{"title":"", "desc":""}],
  "whyChoose": "3~4문장 선택 이유",
  "homeFaq": [{"q":"", "a":""}],
  "ctaTitle": "문의 유도 제목(핵심 키워드 포함)",
  "ctaText": "문의 유도 설명",
  "subPages": [
    {
      "title": "핵심 키워드 포함 H1",
      "slug": "",
      "metaDescription": "",
      "summary": "",
      "sections": [{"heading":"H2용 소제목(키워드 포함)", "body":""}],
      "faq": [{"q":"", "a":""}],
      "keywords": "쉼표 구분 키워드"
    }
  ]
}`;
  const userPrompt = `브랜드명: ${name}
핵심 키워드: ${keyword}
전화번호: ${phone}
메타 타이틀(최우선): ${metaTitle || `${name} ${keyword}`}
메타 디스크립션 힌트: ${metaDescription || ''}
메타 키워드 힌트: ${metaKeywords || keyword}

요청:
1. 홈 <title>/metaTitle과 H1(heroTitle)을 메타 타이틀 기준으로 일치시키세요.
2. 홈 본문 섹션 소제목·CTA·FAQ 질문에도 메타 타이틀 핵심어를 자연스럽게 넣으세요.
3. SEO 내부링크용 서브페이지를 정확히 6개 만드세요. 각 서브페이지 title이 H1이 되며 메타 타이틀/핵심 키워드와 연관되어야 합니다.
4. 각 서브페이지 sections.heading은 H2로 쓰일 소제목이며 키워드를 포함하세요.
5. 각 서브페이지는 title, slug, metaDescription, summary, sections 4개(heading/body), faq 3개(q/a), keywords를 포함하세요.
6. sections body는 실제 방문자가 읽을 수 있는 긴 단락으로 작성하세요.`;

  try {
    const plan = await callOpenAIJson(openaiApiKey, systemPrompt, userPrompt);
    if (!Array.isArray(plan.subPages) || plan.subPages.length < 6) {
      throw new Error('서브페이지 6개 생성 실패');
    }
    return normalizePlan(plan, input);
  } catch (e) {
    log(`AI 생성 실패, 고품질 템플릿 사용: ${e.message}`);
    return normalizePlan(buildFallbackPlan(input), input);
  }
}

export async function generateSiteAssets({
  plan,
  openaiApiKey = '',
  sendLog = null,
}) {
  const log = (msg) => sendLog?.(msg);
  if (!openaiApiKey) return null;
  try {
    log('대표 이미지 생성 중...');
    return await generateBannerImage(openaiApiKey, plan.heroTitle, plan.metaTitle);
  } catch (e) {
    log(`이미지 생성 실패: ${e.message}`);
    return null;
  }
}

function buildSharedCss(color) {
  return `:root{--primary:${color};--primary-dark:color-mix(in srgb,var(--primary) 72%,#111827);--primary-soft:color-mix(in srgb,var(--primary) 12%,#fff);--ink:#111827;--muted:#5b6472;--line:#e5e7eb;--paper:#fff;--bg:#f6f7f9;--radius:22px;--shadow:0 18px 50px rgba(15,23,42,.12)}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:'Noto Sans KR',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--ink);background:var(--bg);line-height:1.75;word-break:keep-all;padding-bottom:76px}
a{text-decoration:none;color:inherit}
img{max-width:100%;display:block}
.container{width:min(1180px,calc(100% - 40px));margin:0 auto}
.site-header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.92);backdrop-filter:blur(16px);border-bottom:1px solid rgba(229,231,235,.85)}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:22px;min-height:72px}
.logo{font-size:20px;font-weight:900;letter-spacing:-.03em;color:var(--ink)}
.site-nav{display:flex;align-items:center;gap:22px;color:#374151;font-size:15px;font-weight:700}
.site-nav a{transition:color .2s ease}
.site-nav a:hover{color:var(--primary)}
.header-tel{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:var(--primary);color:#fff;font-weight:900;box-shadow:0 10px 24px color-mix(in srgb,var(--primary) 28%,transparent)}
.hero{position:relative;isolation:isolate;min-height:590px;display:flex;align-items:center;overflow:hidden;color:#fff;background:#111827}
.hero::before{content:"";position:absolute;inset:0;background:linear-gradient(110deg,rgba(17,24,39,.9),rgba(17,24,39,.66) 44%,rgba(17,24,39,.2)),var(--hero-image);background-size:cover;background-position:center;z-index:-2}
.hero::after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 72% 16%,color-mix(in srgb,var(--primary) 42%,transparent),transparent 30%),linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.24));z-index:-1}
.hero-content{max-width:760px;padding:98px 0}
.eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;padding:8px 14px;border:1px solid rgba(255,255,255,.28);border-radius:999px;background:rgba(255,255,255,.12);font-size:14px;font-weight:800}
.hero h1{font-size:clamp(34px,5.6vw,66px);line-height:1.12;letter-spacing:-.055em;margin-bottom:22px}
.hero-subtitle{font-size:clamp(18px,2.2vw,25px);line-height:1.65;color:rgba(255,255,255,.9);max-width:700px}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:34px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 22px;border-radius:14px;font-weight:900;transition:transform .2s ease,box-shadow .2s ease}
.btn:hover{transform:translateY(-2px)}
.btn-primary{background:var(--primary);color:#fff;box-shadow:0 16px 32px color-mix(in srgb,var(--primary) 32%,transparent)}
.btn-light{background:rgba(255,255,255,.94);color:var(--ink)}
.section{padding:86px 0}
.section.alt{background:#fff}
.section-head{max-width:760px;margin:0 auto 38px;text-align:center}
.section-kicker{display:inline-block;margin-bottom:10px;color:var(--primary);font-size:14px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
.section h2{font-size:clamp(28px,4vw,42px);line-height:1.24;letter-spacing:-.04em;margin-bottom:14px}
.section-desc{color:var(--muted);font-size:18px}
.intro-card{margin-top:-70px;position:relative;z-index:5;background:var(--paper);border-radius:var(--radius);box-shadow:var(--shadow);padding:34px;border:1px solid rgba(255,255,255,.6)}
.intro-card p{font-size:18px;color:#374151;margin-bottom:12px}
.intro-card p:last-child{margin-bottom:0}
.feature-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.feature-card,.sub-card,.faq-item,.related-card{background:var(--paper);border:1px solid var(--line);border-radius:20px;box-shadow:0 10px 28px rgba(15,23,42,.06)}
.feature-card{padding:26px}
.feature-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--primary-soft);color:var(--primary);font-weight:900;margin-bottom:18px}
.feature-card h3{font-size:20px;letter-spacing:-.03em;margin-bottom:10px}
.feature-card p{color:var(--muted)}
.process-list{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;counter-reset:step}
.process-step{position:relative;background:#fff;border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 10px 28px rgba(15,23,42,.06);counter-increment:step}
.process-step::before{content:counter(step,decimal-leading-zero);display:inline-grid;place-items:center;width:46px;height:46px;border-radius:50%;background:var(--primary);color:#fff;font-weight:900;margin-bottom:16px}
.process-step h3{font-size:20px;margin-bottom:10px}
.process-step p{color:var(--muted)}
.why-box{display:grid;grid-template-columns:.9fr 1.1fr;gap:32px;align-items:center;background:linear-gradient(135deg,var(--primary-dark),var(--primary));border-radius:28px;padding:42px;color:#fff;box-shadow:var(--shadow)}
.why-box h2{margin-bottom:0}
.why-copy p{color:rgba(255,255,255,.9);font-size:17px;margin-bottom:12px}
.why-copy p:last-child{margin-bottom:0}
.subpage-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.sub-card{overflow:hidden;transition:transform .2s ease,box-shadow .2s ease}
.sub-card:hover{transform:translateY(-6px);box-shadow:0 20px 44px rgba(15,23,42,.12)}
.sub-card img{width:100%;height:190px;object-fit:cover;background:var(--primary-soft)}
.sub-card-body{padding:22px}
.sub-card span{display:block;color:var(--primary);font-size:13px;font-weight:900;margin-bottom:8px}
.sub-card h3{font-size:21px;line-height:1.38;letter-spacing:-.03em;margin-bottom:10px}
.sub-card p{color:var(--muted);font-size:15px}
.faq-list{display:grid;gap:14px;max-width:900px;margin:0 auto}
.faq-item{padding:0;overflow:hidden}
.faq-item summary{cursor:pointer;list-style:none;padding:20px 24px;font-weight:900;font-size:18px}
.faq-item summary::-webkit-details-marker{display:none}
.faq-item p{padding:0 24px 22px;color:var(--muted)}
.cta-banner{background:linear-gradient(135deg,var(--primary-dark),var(--primary));color:#fff;border-radius:30px;padding:46px;text-align:center;box-shadow:var(--shadow)}
.cta-banner h2{margin-bottom:12px}
.cta-banner p{max-width:720px;margin:0 auto 24px;color:rgba(255,255,255,.9);font-size:18px}
.breadcrumbs{font-size:14px;color:#6b7280;margin:28px 0}
.breadcrumbs a{color:var(--primary);font-weight:800}
.page-hero{background:linear-gradient(120deg,rgba(17,24,39,.86),rgba(17,24,39,.46)),var(--hero-image);background-size:cover;background-position:center;color:#fff;padding:86px 0}
.page-hero h1{font-size:clamp(32px,5vw,54px);line-height:1.18;letter-spacing:-.05em;margin-bottom:18px}
.page-hero p{max-width:760px;font-size:19px;color:rgba(255,255,255,.9)}
.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:34px;align-items:start}
.article-card{background:#fff;border:1px solid var(--line);border-radius:24px;padding:36px;box-shadow:0 12px 34px rgba(15,23,42,.07)}
.article-card h2{font-size:30px;letter-spacing:-.04em;margin:8px 0 18px}
.article-section{padding:28px 0;border-top:1px solid var(--line)}
.article-section:first-of-type{border-top:0;padding-top:4px}
.article-section h2{font-size:24px;letter-spacing:-.03em;margin-bottom:12px}
.article-section p{color:#374151;font-size:17px}
.side-card{position:sticky;top:96px;background:#fff;border:1px solid var(--line);border-radius:24px;padding:24px;box-shadow:0 12px 34px rgba(15,23,42,.07)}
.side-card h2{font-size:22px;margin-bottom:14px}
.side-card a{display:block;padding:12px 0;border-top:1px solid var(--line);font-weight:800;color:#374151}
.side-card a:hover{color:var(--primary)}
.related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:22px}
.related-card{padding:18px;font-weight:900}
.related-card:hover{color:var(--primary)}
footer{background:#111827;color:#aeb6c2;text-align:center;padding:38px 20px;font-size:13px}
.footer-links{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:12px}
.footer-links a{color:#fff;font-weight:800}
.bottom-bar{position:fixed;left:0;right:0;bottom:0;z-index:90;display:flex;gap:10px;justify-content:center;padding:10px 14px;background:rgba(255,255,255,.96);border-top:1px solid var(--line);box-shadow:0 -8px 24px rgba(15,23,42,.1)}
.bottom-btn{flex:1;max-width:260px;min-height:52px;display:flex;align-items:center;justify-content:center;border-radius:14px;color:#fff;font-weight:900}
.bottom-btn.call{background:var(--primary)}
.bottom-btn.sms{background:#111827}
@media(max-width:980px){.site-nav{display:none}.feature-grid,.process-list{grid-template-columns:repeat(2,1fr)}.subpage-grid,.related-grid{grid-template-columns:repeat(2,1fr)}.why-box,.content-grid{grid-template-columns:1fr}.side-card{position:static}.hero{min-height:520px}}
@media(max-width:640px){.container{width:min(100% - 28px,1180px)}.header-inner{min-height:64px}.header-tel{padding:9px 12px;font-size:14px}.hero-content{padding:74px 0}.intro-card{margin-top:-44px;padding:24px}.section{padding:64px 0}.feature-grid,.process-list,.subpage-grid,.related-grid{grid-template-columns:1fr}.why-box,.cta-banner,.article-card{padding:26px}.sub-card img{height:180px}.bottom-bar{padding:8px}.bottom-btn{min-height:48px;font-size:14px}}`;
}

function buildHead({ title, description, keywords, canonical, color, cssPath = 'assets/css/style.css', imageUrl = '' }) {
  const t = escapeAttr(title);
  const d = escapeAttr(description);
  const k = escapeAttr(keywords);
  const c = escapeAttr(canonical || '');
  const img = escapeAttr(imageUrl || '');
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index, follow">
<meta name="description" content="${d}">
<meta name="keywords" content="${k}">
<link rel="canonical" href="${c}">
<title>${t}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${c}">
${img ? `<meta property="og:image" content="${img}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${img ? `<meta name="twitter:image" content="${img}">` : ''}
<meta name="theme-color" content="${escapeAttr(color)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${escapeAttr(cssPath)}">`;
}

function buildJsonLd(data) {
  return `<script type="application/ld+json">${escapeJsonLd(data)}</script>`;
}

function buildHeader(name, phone, prefix = '') {
  return `<header class="site-header">
  <div class="container header-inner">
    <a href="${prefix}index.html" class="logo">${escapeHtml(name)}</a>
    <nav class="site-nav" aria-label="주요 메뉴">
      <a href="${prefix}index.html#features">강점</a>
      <a href="${prefix}index.html#process">절차</a>
      <a href="${prefix}index.html#faq">FAQ</a>
    </nav>
    <a href="tel:${escapeAttr(phone)}" class="header-tel">${escapeHtml(phone)}</a>
  </div>
</header>`;
}

function buildBottomBar(phone) {
  return `<div class="bottom-bar" aria-label="빠른 상담">
  <a href="tel:${escapeAttr(phone)}" class="bottom-btn call">전화상담</a>
  <a href="sms:${escapeAttr(phone)}" class="bottom-btn sms">문자상담</a>
</div>`;
}

function buildFooter(plan, name, phone, prefix = '') {
  const links = plan.subPages.map((p) => `<a href="${prefix}pages/${escapeAttr(p.slug)}.html">${escapeHtml(p.title)}</a>`).join('\n    ');
  return `<footer>
  <div class="footer-links">
    <a href="${prefix}index.html">홈</a>
    ${links}
  </div>
  <p>${escapeHtml(name)} · 상담문의 ${escapeHtml(phone)}</p>
  <p>&copy; ${new Date().getFullYear()} ${escapeHtml(name)}. All rights reserved.</p>
</footer>`;
}

function buildSubGrid(plan, imagePath) {
  return plan.subPages.map((p, i) => {
    const href = `pages/${escapeAttr(p.slug)}.html`;
    return `<article class="sub-card">
  <a href="${href}">
    <img src="${escapeAttr(imagePath)}" alt="${escapeAttr(p.title)}" loading="lazy">
    <div class="sub-card-body">
      <span>0${i + 1}</span>
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.summary)}</p>
    </div>
  </a>
</article>`;
  }).join('\n');
}

function buildFaqItems(faq) {
  return asArray(faq).map((item, i) => `<details class="faq-item"${i === 0 ? ' open' : ''}>
  <summary>${escapeHtml(item.q)}</summary>
  <p>${escapeHtml(item.a)}</p>
</details>`).join('\n');
}

function buildHomeJsonLd(plan, { name, phone, siteUrl, imageUrl }) {
  const base = stripTrailingSlash(siteUrl);
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name,
      url: `${base}/`,
      telephone: phone,
      image: imageUrl,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: plan.metaTitle,
      headline: plan.heroTitle || plan.metaTitle,
      description: plan.metaDescription,
      url: `${base}/`,
      inLanguage: 'ko-KR',
      isPartOf: { '@type': 'WebSite', name, url: `${base}/` },
      primaryImageOfPage: imageUrl,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name,
      url: `${base}/`,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${base}/?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: plan.subPages.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: p.title,
        url: `${base}/pages/${p.slug}.html`,
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: plan.homeFaq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
  ];
}

function buildSubJsonLd(plan, sub, { name, phone, siteUrl, imageUrl }) {
  const base = stripTrailingSlash(siteUrl);
  const pageUrl = `${base}/pages/${sub.slug}.html`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name,
      url: `${base}/`,
      telephone: phone,
      image: imageUrl,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: sub.title,
      headline: sub.title,
      description: sub.metaDescription || plan.metaDescription,
      url: pageUrl,
      inLanguage: 'ko-KR',
      isPartOf: { '@type': 'WebSite', name, url: `${base}/` },
      primaryImageOfPage: imageUrl,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '홈', item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: sub.title, item: pageUrl },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: sub.faq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
  ];
}

export function buildIndexHtml(plan, { name, phone, siteUrl, color, imagePath = 'assets/images/banner.png' }) {
  const base = stripTrailingSlash(siteUrl);
  const canonical = `${base}/`;
  const imageUrl = `${base}/${imagePath}`;
  const headings = plan.sectionHeadings || buildHomeSeoHeadings(plan.metaTitle, name, plan.metaKeywords);
  const h1 = headings.h1 || plan.heroTitle || plan.metaTitle;
  const head = buildHead({
    title: plan.metaTitle,
    description: plan.metaDescription,
    keywords: plan.metaKeywords,
    canonical,
    color,
    imageUrl,
  });
  const intro = sentenceParagraphs(plan.intro, plan.heroSubtitle).map((p) => `<p>${escapeHtml(p)}</p>`).join('\n      ');
  const why = sentenceParagraphs(plan.whyChoose).map((p) => `<p>${escapeHtml(p)}</p>`).join('\n        ');
  const features = plan.features.map((item, i) => `<article class="feature-card">
  <div class="feature-icon">${i + 1}</div>
  <h3>${escapeHtml(item.title)}</h3>
  <p>${escapeHtml(item.desc)}</p>
</article>`).join('\n');
  const process = plan.process.map((item) => `<article class="process-step">
  <h3>${escapeHtml(item.title)}</h3>
  <p>${escapeHtml(item.desc)}</p>
</article>`).join('\n');
  const jsonLd = buildHomeJsonLd({ ...plan, heroTitle: h1 }, { name, phone, siteUrl, imageUrl }).map(buildJsonLd).join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
${head}
${jsonLd}
</head>
<body style="--hero-image:url('${escapeAttr(imagePath)}')">
${buildHeader(name, phone)}
<main>
  <section class="hero" aria-label="메인 소개">
    <div class="container hero-content">
      <span class="eyebrow">${escapeHtml(name)}</span>
      <h1>${escapeHtml(h1)}</h1>
      <p class="hero-subtitle">${escapeHtml(plan.heroSubtitle)}</p>
      <div class="hero-actions">
        <a href="tel:${escapeAttr(phone)}" class="btn btn-primary">전화 상담하기</a>
        <a href="#subpages" class="btn btn-light">상세 안내 보기</a>
      </div>
    </div>
  </section>

  <section class="container intro-card" aria-labelledby="intro-heading">
    <h2 id="intro-heading" class="section-kicker" style="display:block;margin-bottom:14px;font-size:18px;">${escapeHtml(headings.intro)}</h2>
    ${intro}
  </section>

  <section id="features" class="section">
    <div class="container">
      <div class="section-head">
        <span class="section-kicker">Features</span>
        <h2>${escapeHtml(headings.features)}</h2>
        <p class="section-desc">방문자가 바로 이해하고 문의할 수 있도록 핵심 장점을 명확하게 정리했습니다.</p>
      </div>
      <div class="feature-grid">${features}</div>
    </div>
  </section>

  <section id="process" class="section alt">
    <div class="container">
      <div class="section-head">
        <span class="section-kicker">Process</span>
        <h2>${escapeHtml(headings.process)}</h2>
        <p class="section-desc">문의부터 안내까지 필요한 흐름을 단계별로 확인할 수 있습니다.</p>
      </div>
      <div class="process-list">${process}</div>
    </div>
  </section>

  <section class="section">
    <div class="container why-box">
      <div>
        <span class="section-kicker">Why Choose</span>
        <h2>${escapeHtml(headings.why)}</h2>
      </div>
      <div class="why-copy">${why}</div>
    </div>
  </section>

  <section id="subpages" class="section alt">
    <div class="container">
      <div class="section-head">
        <span class="section-kicker">Guides</span>
        <h2>${escapeHtml(headings.guides)}</h2>
        <p class="section-desc">검색 의도에 맞춘 6개의 상세 페이지에서 더 깊이 있는 정보를 확인하세요.</p>
      </div>
      <div class="subpage-grid" itemscope itemtype="https://schema.org/ItemList">
        ${buildSubGrid(plan, imagePath)}
      </div>
    </div>
  </section>

  <section id="faq" class="section">
    <div class="container">
      <div class="section-head">
        <span class="section-kicker">FAQ</span>
        <h2>${escapeHtml(headings.faq)}</h2>
        <p class="section-desc">상담 전 많이 궁금해하는 내용을 먼저 확인해 보세요.</p>
      </div>
      <div class="faq-list">${buildFaqItems(plan.homeFaq)}</div>
    </div>
  </section>

  <section class="section alt">
    <div class="container cta-banner">
      <h2>${escapeHtml(plan.ctaTitle)}</h2>
      <p>${escapeHtml(plan.ctaText)}</p>
      <a href="tel:${escapeAttr(phone)}" class="btn btn-light">${escapeHtml(phone)} 전화문의</a>
    </div>
  </section>
</main>
${buildBottomBar(phone)}
${buildFooter(plan, name, phone)}
</body>
</html>`;
}

export function buildSubPageHtml(plan, sub, { name, phone, siteUrl, color, imagePath = 'assets/images/banner.png' }) {
  const base = stripTrailingSlash(siteUrl);
  const canonical = `${base}/pages/${sub.slug}.html`;
  const pageImagePath = `../${imagePath}`;
  const imageUrl = `${base}/${imagePath}`;
  const headings = sub.sectionHeadings || buildSubSeoHeadings(sub.title, plan.metaTitle, plan.sectionHeadings?.primary);
  const pageTitle = `${sub.title} | ${plan.metaTitle || name}`;
  const related = plan.subPages
    .filter((p) => p.slug !== sub.slug)
    .slice(0, 3)
    .map((p) => `<a class="related-card" href="${escapeAttr(p.slug)}.html">${escapeHtml(p.title)}</a>`)
    .join('\n');
  const navLinks = plan.subPages
    .map((p) => `<a href="${escapeAttr(p.slug)}.html">${escapeHtml(p.title)}</a>`)
    .join('\n');
  // H1 아래 본문 섹션은 H2 (키워드 포함 소제목)
  const sections = sub.sections.map((s) => `<section class="article-section">
  <h2>${escapeHtml(s.heading)}</h2>
  <p>${escapeHtml(s.body)}</p>
</section>`).join('\n');
  const head = buildHead({
    title: pageTitle,
    description: sub.metaDescription || plan.metaDescription,
    keywords: sub.keywords || plan.metaKeywords,
    canonical,
    color,
    cssPath: '../assets/css/style.css',
    imageUrl,
  });
  const jsonLd = buildSubJsonLd(plan, sub, { name, phone, siteUrl, imageUrl }).map(buildJsonLd).join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
${head}
${jsonLd}
</head>
<body style="--hero-image:url('${escapeAttr(pageImagePath)}')">
${buildHeader(name, phone, '../')}
<main>
  <section class="page-hero">
    <div class="container">
      <h1>${escapeHtml(headings.h1 || sub.title)}</h1>
      <p>${escapeHtml(sub.summary || '')}</p>
    </div>
  </section>

  <div class="container">
    <nav class="breadcrumbs" aria-label="breadcrumb">
      <a href="../index.html">홈</a> / <span>${escapeHtml(sub.title)}</span>
    </nav>
  </div>

  <section class="section">
    <div class="container content-grid">
      <article class="article-card">
        ${sections}

        <section class="article-section" id="faq">
          <h2>${escapeHtml(headings.faq)}</h2>
          <div class="faq-list">${buildFaqItems(sub.faq)}</div>
        </section>

        <section class="article-section">
          <h2>${escapeHtml(headings.related)}</h2>
          <div class="related-grid">${related}</div>
        </section>
      </article>

      <aside class="side-card" aria-label="다른 페이지">
        <h2>전체 안내 페이지</h2>
        <a href="../index.html">홈으로 이동</a>
        ${navLinks}
        <a href="tel:${escapeAttr(phone)}">전화 상담 ${escapeHtml(phone)}</a>
      </aside>
    </div>
  </section>

  <section class="section alt">
    <div class="container cta-banner">
      <h2>${escapeHtml(plan.ctaTitle)}</h2>
      <p>${escapeHtml(plan.ctaText)}</p>
      <a href="tel:${escapeAttr(phone)}" class="btn btn-light">${escapeHtml(phone)} 전화문의</a>
    </div>
  </section>
</main>
${buildBottomBar(phone)}
${buildFooter(plan, name, phone, '../')}
</body>
</html>`;
}

export function buildSitemapWithPages(siteUrl, slugs) {
  const base = stripTrailingSlash(siteUrl);
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    { loc: `${base}/`, priority: '1.0' },
    ...slugs.map((slug) => ({ loc: `${base}/pages/${slug}`, priority: '0.8' })),
  ];
  const body = urls.map((u) => `  <url>
    <loc>${escapeHtml(u.loc)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

function buildPlaceholderSvg(color = '#2563eb') {
  const safeColor = color || '#2563eb';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640" viewBox="0 0 1024 640">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${escapeAttr(safeColor)}"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <radialGradient id="r" cx="75%" cy="20%" r="65%">
      <stop offset="0%" stop-color="rgba(255,255,255,.34)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="640" fill="url(#g)"/>
  <rect width="1024" height="640" fill="url(#r)"/>
  <circle cx="820" cy="150" r="92" fill="rgba(255,255,255,.18)"/>
  <circle cx="910" cy="410" r="150" fill="rgba(255,255,255,.08)"/>
  <rect x="110" y="218" width="560" height="36" rx="18" fill="rgba(255,255,255,.28)"/>
  <rect x="110" y="292" width="450" height="22" rx="11" fill="rgba(255,255,255,.2)"/>
  <rect x="110" y="340" width="320" height="22" rx="11" fill="rgba(255,255,255,.16)"/>
</svg>`;
}

export async function writeSiteBundle({
  outputFolder,
  name,
  keyword,
  phone,
  siteUrl,
  color,
  metaTitle = '',
  metaDescription = '',
  metaKeywords = '',
  openaiApiKey = '',
  sendLog = null,
}) {
  const log = (msg) => sendLog?.(msg);
  const themeColor = color || '#2563eb';
  const plan = await generateSitePlan({
    name,
    keyword,
    phone,
    metaTitle,
    metaDescription,
    metaKeywords,
    openaiApiKey,
    sendLog,
  });

  const imageBuf = await generateSiteAssets({ plan, openaiApiKey, sendLog });
  const assetsDir = path.join(outputFolder, 'assets');
  const cssDir = path.join(assetsDir, 'css');
  const imgDir = path.join(assetsDir, 'images');
  const pagesDir = path.join(outputFolder, 'pages');
  fs.mkdirSync(cssDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(pagesDir, { recursive: true });

  const imagePath = 'assets/images/banner.png';
  const imageFull = path.join(outputFolder, imagePath);
  if (imageBuf) {
    fs.writeFileSync(imageFull, imageBuf);
    log('대표 이미지 저장 완료');
  } else {
    fs.writeFileSync(path.join(imgDir, 'banner.svg'), buildPlaceholderSvg(themeColor), 'utf8');
  }

  const actualImagePath = imageBuf ? imagePath : 'assets/images/banner.svg';
  fs.writeFileSync(path.join(cssDir, 'style.css'), buildSharedCss(themeColor), 'utf8');
  fs.writeFileSync(path.join(outputFolder, 'index.html'), buildIndexHtml(plan, {
    name, phone, siteUrl, color: themeColor, imagePath: actualImagePath,
  }), 'utf8');

  for (const sub of plan.subPages) {
    const html = buildSubPageHtml(plan, sub, {
      name, phone, siteUrl, color: themeColor, imagePath: actualImagePath,
    });
    fs.writeFileSync(path.join(pagesDir, `${sub.slug}.html`), html, 'utf8');
  }

  const redirects = ['/pages/* /pages/:splat.html 200', '/* /index.html 200'].join('\n');
  fs.writeFileSync(path.join(outputFolder, '_redirects'), redirects, 'utf8');

  log(`서브페이지 ${plan.subPages.length}개 생성 완료 (메타 타이틀: ${plan.metaTitle})`);
  return {
    plan,
    slugs: plan.subPages.map((p) => p.slug),
    metaTitle: plan.metaTitle,
  };
}
