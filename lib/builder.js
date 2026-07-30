/**
 * HTML 랜딩 페이지 + SEO 파일 생성 모듈
 * 키워드 기반으로 콘텐츠를 다양화하고, 테마색은 랜덤으로 선택 가능.
 */

export function slugify(text) {
  return text.trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\uAC00-\uD7AF\-]/g, '')
    .replace(/-+/g, '-')
    .toLowerCase() || 'page';
}

function escapeHtml(text) {
  const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' };
  return String(text).replace(/[&<>"]/g, c => map[c] || c);
}

function darken(hex, amt) {
  try {
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    r = Math.max(0, r - amt); g = Math.max(0, g - amt); b = Math.max(0, b - amt);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  } catch (e) { return hex; }
}

export function getRandomColor() {
  const palette = [
    '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706',
    '#059669', '#0891b2', '#0284c7', '#4f46e5', '#be185d', '#9333ea',
    '#b45309', '#15803d', '#0f766e', '#0369a1', '#4338ca', '#c026d3'
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

export function buildHeadSEO(r, siteUrl) {
  const name = escapeHtml(r.name || '서비스');
  const slogan = escapeHtml(r.slogan || '최고의 서비스');
  const phone = escapeHtml(r.phone || '');
  const f1 = escapeHtml(r.f1 || '');
  const description = escapeHtml(r.metaDescription || `${name} - ${slogan}. 전화: ${phone}`);
  const keywords = escapeHtml(r.metaKeywords || `${name},${r.keyword || ''},${f1},${r.f2 || ''},${r.f3 || ''}`);
  const url = siteUrl || '';
  return `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="description" content="${description}">
<meta name="keywords" content="${keywords}">
<link rel="canonical" href="${url}">
<title>${name} - ${slogan}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${name} - ${slogan}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">`;
}

// 키워드 기반 콘텐츠 라이브러리
const CONTENT_LIBRARY = [
  {
    keywords: ['인테리어', '리모델링', '홈스타일링', '집꾸미기'],
    intro: [
      `{name}는 고객님의 공간을 더 가치 있게 만드는 {keyword} 전문 업체입니다. 수년간의 현장 경험과 다양한 프로젝트 수행을 바탕으로, 공간의 특성과 라이프스타일에 맞춘 최적의 솔루션을 제안드립니다.`,
      `{name}은(는) {keyword}를 통해 일상 속 공간의 변화를 만듭니다. 작은 공간부터 전체 리모델링까지, 고객의 취향과 예산에 맞춘 차별화된 디자인을 제공합니다.`,
      `{name}는 {keyword} 전문가들이 모인 공간 연출 전문 업체입니다. 트렌디한 감각과 실용적인 설계를 결합하여, 살고 싶어지는 공간을 완성합니다.`
    ],
    features: [
      ['맞춤형 디자인', '고객님의 취향과 공간 특성을 반영한 개별 맞춤 디자인을 제공합니다.'],
      ['전문 시공 인력', '각 분야별 전문가들이 책임감 있게 현장을 관리하고 시공합니다.'],
      ['투명한 견적', '숨겨진 비용 없이 합리적인 가격으로 정직하게 견적을 안내드립니다.'],
      ['철저한 사후 관리', '서비스 완료 후에도 궁금한 점과 A/S를 신속하게 처리해 드립니다.']
    ],
    process: [
      ['전화/문자 상담', '원하시는 스타일과 현재 공간 상태를 간단히 말씀해 주세요.'],
      ['방문 상담 및 견적', '전문 상담사가 직접 방문하여 정확한 견적과 일정을 안내드립니다.'],
      ['디자인 확정', '고객님과 최종 디자인과 자재를 확정한 후 작업을 시작합니다.'],
      ['시공과 완료 점검', '작업 중간중간 꼼꼼히 점검하여 완벽한 마무리를 약속드립니다.']
    ],
    faq: [
      ['{keyword} 비용은 얼마인가요?', '시공 범위, 공간 크기, 자재 선택 등에 따라 비용이 달라집니다. 상담 후 정확한 견적을 안내드립니다.'],
      ['당일 방문 상담이 가능한가요?', '일정 여유에 따라 당일 방문이 가능한 경우도 있습니다. 먼저 연락 주시면 빠르게 확인해 드리겠습니다.'],
      ['서비스 지역은 어디인가요?', '{name}는 전국 주요 지역에서 {keyword} 서비스를 제공하고 있습니다.'],
      ['시공 기간은 얼마나 걸리나요?', '작업 규모에 따라 상이하지만, 상담 시 예상 일정을 함께 안내드립니다.']
    ],
    why: '공간은 단순히 거주하는 곳이 아니라 일상의 질을 결정하는 중요한 요소입니다. 전문 {keyword} 업체의 도움을 받으면 공간 활용도를 높이고, 취향에 맞는 분위기를 연출할 수 있습니다.'
  },
  {
    keywords: ['청소', '입주청소', '이사청소', '에어컨청소', '세탁기청소', '하수구청소'],
    intro: [
      `{name}는 깨끗하고 쾌적한 공간을 만드는 {keyword} 전문 업체입니다. 꼼꼼한 작업과 체계적인 절차로, 먼지와 찌든 때를 말끔하게 제거해 드립니다.`,
      `{name}은(는) 바쁜 일상 속에서도 깨끗한 공간을 누릴 수 있도록 {keyword} 서비스를 제공합니다. 전문 장비와 안전한 세제로 위생적인 결과를 약속드립니다.`,
      `{name}는 {keyword} 전문가들이 직접 방문하여 꼼꼼하게 작업합니다. 한 번의 서비스로 오래 지속되는 청결함을 느껴 보세요.`
    ],
    features: [
      ['전문 장비 사용', '최신 청소 장비와 세제로 구석구석 깨끗이 제거합니다.'],
      ['친환경 세제', '인체와 환경에 무해한 세제를 사용하여 안전하게 작업합니다.'],
      ['꼼꼼한 점검', '작업 전후 사진으로 비교하며 놓치는 부분 없이 마무리합니다.'],
      ['합리적인 가격', '투명한 견적으로 부담 없이 이용할 수 있습니다.']
    ],
    process: [
      ['상담 예약', '원하시는 서비스와 일정을 말씀해 주세요.'],
      ['현장 확인', '작업 공간의 상태를 확인하고 필요한 장비를 준비합니다.'],
      ['꼼꼼한 청소', '전문가가 한 칸 한 칸 정성껏 청소합니다.'],
      ['완료 점검', '고객님과 함께 작업 결과를 확인하며 마무리합니다.']
    ],
    faq: [
      ['{keyword} 비용은 얼마인가요?', '공간 크기와 작업 범위에 따라 달라집니다. 전화 상담 후 정확한 견적을 드립니다.'],
      ['당일 예약이 가능한가요?', '일정에 따라 당일 예약이 가능합니다. 먼저 연락 주시면 확인해 드리겠습니다.'],
      ['사용하는 세제는 안전한가요?', '네, 인체와 환경에 무해한 세제를 사용합니다.'],
      ['작업 시간은 얼마나 걸리나요?', '작업 범위에 따라 1~4시간 정도 소요됩니다.']
    ],
    why: '깨끗한 공간은 건강한 삶의 시작입니다. 전문 {keyword} 업체의 도움으로 소중한 공간을 위생적이고 쾌적하게 유지해 보세요.'
  },
  {
    keywords: ['이사', '사무실이사', '포장이사', '원룸이사'],
    intro: [
      `{name}는 안전하고 빠른 {keyword}를 제공하는 전문 업체입니다. 포장부터 운송, 배치까지 책임지고 진행합니다.`,
      `{name}은(는) 고객님의 소중한 짐을 안전하게 옮기는 {keyword} 서비스를 제공합니다. 풍부한 경험으로 신속하고 정확한 이사를 도와드립니다.`,
      `{name}는 {keyword} 전문 인력과 차량으로, 복잡한 이사 과정을 편리하게 해결해 드립니다.`
    ],
    features: [
      ['체계적인 포장', '파손 방지를 위한 전문 포장 재료와 방법을 사용합니다.'],
      ['안전 운송', '경험 많은 기사님이 짐을 안전하게 운송합니다.'],
      ['꼼꼼한 배치', '도착지에서 원하는 위치에 가구와 짐을 정리해 드립니다.'],
      ['정확한 일정', '약속된 시간에 맞춰 신속하게 이사를 마칩니다.']
    ],
    process: [
      ['상담 및 견적', '이사 규모와 일정을 말씀해 주시면 견적을 안내드립니다.'],
      ['방문 포장', '전문 인력이 짐을 안전하게 포장합니다.'],
      ['운송', '적재량에 맞는 차량으로 신속하게 운송합니다.'],
      ['배치 및 정리', '도착지에서 짐을 원하는 위치에 배치해 드립니다.']
    ],
    faq: [
      ['{keyword} 비용은 얼마인가요?', '거리, 짐의 양, 층수 등에 따라 달라집니다. 상담 후 정확한 견적을 드립니다.'],
      ['당일 예약이 가능한가요?', '차량 일정에 따라 가능 여부가 달라집니다. 미리 연락 주시면 확인해 드리겠습니다.'],
      ['포장 재료는 제공되나요?', '네, 박스, 에어캡 등 필요한 포장 재료를 제공합니다.'],
      ['고가 가전도 안전하게 옮겨주나요?', '네, 전문 포장으로 TV, 냉장고 등 고가 가전도 안전하게 운송합니다.']
    ],
    why: '이사는 많은 에너지가 필요한 과정입니다. 전문 {keyword} 업체의 도움으로 번거로움을 줄이고, 새로운 공간에서의 시작을 편안하게 준비하세요.'
  },
  {
    keywords: ['세탁', '세탁대행', '와이셔츠세탁', '이불세탁', '욕실세탁'],
    intro: [
      `{name}는 깔끔하고 위생적인 {keyword} 서비스를 제공합니다. 섬유별 최적의 세탁 방법으로 의류와 침구를 관리해 드립니다.`,
      `{name}은(는) 바쁜 현대인을 위한 {keyword} 서비스로, 픽업부터 배송까지 한 번에 해결해 드립니다.`,
      `{name}는 {keyword} 전문 업체로, 소중한 의류를 손상 없이 깨끗이 세탁합니다.`
    ],
    features: [
      ['섬유별 맞춤 세탁', '소재와 오염 상태에 따라 최적의 세탁 방법을 선택합니다.'],
      ['위생적인 건조', '청결한 시설에서 건조하여 냄새와 세균을 제거합니다.'],
      ['픽업/배송 서비스', '원하시면 집 앞까지 픽업하고 배송해 드립니다.'],
      ['합리적인 가격', '투명한 가격으로 부담 없이 이용할 수 있습니다.']
    ],
    process: [
      ['예약 및 픽업', '세탁물을 수거할 일정을 예약해 주세요.'],
      ['전처리 및 세탁', '오염 부위를 전처리한 후 섬유에 맞게 세탁합니다.'],
      ['건조 및 다림질', '건조 후 필요 시 다림질까지 깔끔하게 마무리합니다.'],
      ['배송 완료', '완료된 세탁물을 지정한 주소로 배송해 드립니다.']
    ],
    faq: [
      ['{keyword} 비용은 얼마인가요?', '세탁물의 종류와 양에 따라 달라집니다. 상담 후 견적을 드립니다.'],
      ['픽업 서비스 지역은 어디인가요?', '주요 지역에서 픽업 및 배송이 가능합니다. 자세한 내용은 문의 바랍니다.'],
      ['특수 소재도 세탁 가능한가요?', '네, 실크, 울 등 섬유별 맞춤 세탁이 가능합니다.'],
      ['세탁 기간은 얼마나 걸리나요?', '일반적으로 2~3일 소요되며, 급행 서비스도 가능합니다.']
    ],
    why: '깨끗한 의류와 침구는 일상의 위생과 직결됩니다. 전문 {keyword} 업체를 통해 편리하고 위생적인 세탁을 경험해 보세요.'
  },
  {
    keywords: ['에어컨', '에어컨설치', '에어컨수리', '냉난방기'],
    intro: [
      `{name}는 시원하고 쾌적한 여름을 위한 {keyword} 전문 업체입니다. 설치부터 청소, 수리까지 종합 서비스를 제공합니다.`,
      `{name}은(는) {keyword} 설치 및 유지보수 전문가들이 모인 업체입니다. 안전하고 정확한 작업으로 만족을 드립니다.`,
      `{name}는 {keyword} 관련 모든 고민을 한 번에 해결해 드립니다. 전문 기술자가 꼼꼼히 점검하고 작업합니다.`
    ],
    features: [
      ['전문 기술자 시공', '경험 많은 기술자가 안전하게 설치 및 수리합니다.'],
      ['철저한 누수 점검', '설치 후 누수 및 작동 상태를 꼼꼼히 확인합니다.'],
      ['빠른 출동', '고장 접수 시 신속하게 방문하여 문제를 해결합니다.'],
      ['정품 부품 사용', '수리 시 정품 부품을 사용하여 내구성을 높입니다.']
    ],
    process: [
      ['전화 상담', '증상이나 필요한 서비스를 말씀해 주세요.'],
      ['방문 점검', '기술자가 직접 방문하여 상태를 점검합니다.'],
      ['작업 진행', '설치, 청소 또는 수리 작업을 안전하게 진행합니다.'],
      ['완료 확인', '작동 테스트 후 고객님과 함께 결과를 확인합니다.']
    ],
    faq: [
      ['{keyword} 설치 비용은 얼마인가요?', '기종과 설치 환경에 따라 달라집니다. 상담 후 정확한 견적을 드립니다.'],
      ['당일 출동이 가능한가요?', '일정에 따라 당일 출동이 가능한 경우도 있습니다.'],
      ['청소는 얼마나 자주 해야 하나요?', '1년에 1~2회 정기 청소를 권장합니다.'],
      ['AS는 어떻게 받나요?', '작업 완료 후 문제 발생 시 빠르게 AS 처리해 드립니다.']
    ],
    why: '에어컨은 정기적인 관리 없이는 성능 저하와 전기료 상승을 초래할 수 있습니다. 전문 {keyword} 업체를 통해 시원하고 경제적인 여름을 준비하세요.'
  },
  {
    keywords: ['미용', '헤어', '네일', '피부관리', '속눈썹', '왁싱', '반영구'],
    intro: [
      `{name}는 아름다움을 디자인하는 {keyword} 전문 샵입니다. 트렌디한 감각과 세심한 손길로 만족스러운 결과를 선사합니다.`,
      `{name}은(는) 고객 한 사람 한 사람에게 집중하는 {keyword} 서비스를 제공합니다. 편안한 분위기에서 힐링하세요.`,
      `{name}는 {keyword} 전문가들이 모여, 개개인의 얼굴형과 취향을 살린 스타일링을 제안합니다.`
    ],
    features: [
      ['1:1 맞춤 상담', '고객의 얼굴형과 취향을 고려한 맞춤 디자인을 제공합니다.'],
      ['고급 제품 사용', '두피와 피부에 자극이 적은 우수한 제품을 사용합니다.'],
      ['위생적인 시설', '도구 소독과 청결 관리를 철저히 하여 안전하게 시술합니다.'],
      ['편안한 분위기', '여유로운 공간에서 편안하게 서비스를 받으실 수 있습니다.']
    ],
    process: [
      ['상담 예약', '원하시는 스타일이나 시술을 예약해 주세요.'],
      ['1:1 디자인 상담', '전문가가 얼굴형과 취향에 맞는 스타일을 제안합니다.'],
      ['시술/서비스 진행', '세심한 손길로 꼼꼼하게 작업합니다.'],
      ['완료 및 홈케어 안내', '유지를 위한 홈케어 팁을 함께 안내드립니다.']
    ],
    faq: [
      ['{keyword} 가격은 얼마인가요?', '시술 종류와 난이도에 따라 달라집니다. 상담 후 정확한 견적을 드립니다.'],
      ['예약은 필수인가요?', '원활한 서비스를 위해 사전 예약을 권장합니다.'],
      ['시술 시간은 얼마나 걸리나요?', '시술에 따라 30분~2시간 정도 소요됩니다.'],
      ['두피/피부가 민감핸데 괜찮을까요?', '네, 상담 시 피부 타입을 확인하고 맞춤 제품을 사용합니다.']
    ],
    why: '아름다움은 세심한 관심에서 시작합니다. 전문 {keyword} 전문가의 손길로 자신감 있는 나를 만나보세요.'
  },
  {
    keywords: ['렌트카', '카셰어링', '장기렌트', '차량대여'],
    intro: [
      `{name}는 편리하고 안전한 {keyword} 서비스를 제공합니다. 다양한 차종과 합리적인 요금으로 여행과 출장을 더욱 편리하게 만듭니다.`,
      `{name}은(는) {keyword} 전문 업체로, 간편한 예약부터 반납까지 원스톱으로 진행합니다.`,
      `{name}는 {keyword}를 통해 고객님의 이동을 책임집니다. 깨끗하고 안전한 차량으로 만족을 드립니다.`
    ],
    features: [
      ['다양한 차종', '경차부터 SUV, 승합차까지 상황에 맞는 차량을 선택할 수 있습니다.'],
      ['깨끗한 차량', '반납 후 항상 내외부를 청결하게 정비합니다.'],
      ['간편한 예약', '전화 또는 온라인으로 빠르게 예약할 수 있습니다.'],
      ['합리적인 요금', '장기 대여 할인 등 다양한 요금 혜택을 제공합니다.']
    ],
    process: [
      ['차량 선택 및 예약', '원하시는 차종과 일정을 말씀해 주세요.'],
      ['계약 및 결제', '간단한 서류 확인 후 계약을 진행합니다.'],
      ['차량 인수', '약속된 장소에서 차량을 인수합니다.'],
      ['사용 후 반납', '약속된 시간과 장소에서 차량을 반납합니다.']
    ],
    faq: [
      ['{keyword} 요금은 얼마인가요?', '차종과 대여 기간에 따라 달라집니다. 상담 시 정확한 견적을 드립니다.'],
      ['보험은 포함되어 있나요?', '네, 기본 보험이 포함되어 있으며 추가 보험도 선택 가능합니다.'],
      ['면허 조건이 있나요?', '유효한 2종 보통 이상 면허가 필요합니다.'],
      ['반납 지연 시 어떻게 되나요?', '추가 시간에 따라 추가 요금이 발생할 수 있습니다.']
    ],
    why: '안전하고 쾌적한 이동은 일정의 질을 높입니다. 전문 {keyword} 업체를 통해 필요한 순간, 필요한 차량을 이용해 보세요.'
  }
];

function pickTemplate(keyword) {
  const k = (keyword || '').trim();
  // 정확 키워드 매칭
  let tpl = CONTENT_LIBRARY.find(t => t.keywords.includes(k));
  // 부분 매칭
  if (!tpl) {
    tpl = CONTENT_LIBRARY.find(t => t.keywords.some(kw => k.includes(kw) || kw.includes(k)));
  }
  return tpl || null;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(text, name, keyword) {
  return text.replace(/{name}/g, name).replace(/{keyword}/g, keyword);
}

function buildInfoContent(name, keyword) {
  const safeName = escapeHtml(name);
  const safeKeyword = escapeHtml(keyword);
  const tpl = pickTemplate(keyword);

  if (!tpl) {
    // 범용 템플릿
    return `
  <section class="info-content" id="info">
    <div class="info-wrap">
      <h2>${safeKeyword} 전문 업체 ${safeName}</h2>
      <p>${safeName}는 고객님의 만족을 최우선으로 하는 ${safeKeyword} 서비스를 제공합니다. 전문적인 노하우와 꾸준한 연구를 바탕으로, 최상의 결과를 만들어 드립니다.</p>
      <p>아파트, 빌라, 오피스텔, 상업공간 등 다양한 현장에서 ${safeKeyword} 서비스를 제공하고 있으며, 고객님의 예산과 상황에 맞춘 맞춤형 솔루션을 제안드립니다.</p>

      <h3>${safeName}의 ${safeKeyword} 서비스 특징</h3>
      <ul>
        <li><strong>전문 인력:</strong> 각 분야별 경험이 풍부한 전문가들이 책임지고 작업합니다.</li>
        <li><strong>맞춤 상담:</strong> 고객의 상황에 맞춰 최적의 서비스 방향을 제안합니다.</li>
        <li><strong>투명한 견적:</strong> 숨겨진 비용 없이 정직하게 비용을 안내드립니다.</li>
        <li><strong>철저한 사후 관리:</strong> 서비스 완료 후에도 궁금한 점과 A/S를 신속하게 처리해 드립니다.</li>
      </ul>

      <h3>${safeKeyword} 이용 절차</h3>
      <ol>
        <li><strong>전화/문자 상담:</strong> 원하시는 서비스와 현재 상황을 간단히 말씀해 주세요.</li>
        <li><strong>꼼꼼한 상담 및 견적:</strong> 전문 상담사가 정확한 견적과 일정을 안내드립니다.</li>
        <li><strong>서비스 확정:</strong> 고객님과 최종 내용을 확정한 후 작업을 시작합니다.</li>
        <li><strong>완료 점검:</strong> 작업 중간중간 점검하여 완벽한 마무리를 약속드립니다.</li>
      </ol>

      <h3>${safeKeyword} 서비스를 받아야 하는 이유</h3>
      <p>전문가의 도움을 받으면 시간과 비용을 절약하고, 더 나은 결과를 얻을 수 있습니다. 특히 구조적이거나 기술적인 부분은 경험이 풍부한 전문가의 상담이 필수적입니다.</p>
      <p>${safeName}는 고객님의 소중한 시간과 비용을 존중하며, 안전하고 합리적인 방법으로 최상의 결과를 만들어 드립니다. 지금 바로 전화 또는 문자 상담을 통해 ${safeKeyword} 전문가의 조언을 받아보세요.</p>

      <h3>자주 묻는 질문</h3>
      <dl class="faq">
        <dt>Q. ${safeKeyword} 비용은 얼마인가요?</dt>
        <dd>A. 서비스 범위와 상황에 따라 비용이 달라집니다. 전화 또는 문자 상담 후 정확한 견적을 안내드립니다.</dd>
        <dt>Q. 당일 예약이 가능한가요?</dt>
        <dd>A. 일정 여유에 따라 당일 서비스가 가능한 경우도 있습니다. 먼저 연락 주시면 빠르게 확인해 드리겠습니다.</dd>
        <dt>Q. 서비스 지역은 어디인가요?</dt>
        <dd>A. ${safeName}는 전국 주요 지역에서 ${safeKeyword} 서비스를 제공하고 있습니다.</dd>
        <dt>Q. 작업 기간은 얼마나 걸리나요?</dt>
        <dd>A. 작업 규모에 따라 상이하지만, 상담 시 예상 일정을 함께 안내드립니다.</dd>
      </dl>
    </div>
  </section>`;
  }

  const intro = fillTemplate(pickRandom(tpl.intro), safeName, safeKeyword);
  const why = fillTemplate(tpl.why, safeName, safeKeyword);
  const features = tpl.features.map(([title, desc]) => `<li><strong>${escapeHtml(title)}:</strong> ${escapeHtml(fillTemplate(desc, safeName, safeKeyword))}</li>`).join('');
  const process = tpl.process.map(([title, desc]) => `<li><strong>${escapeHtml(title)}:</strong> ${escapeHtml(fillTemplate(desc, safeName, safeKeyword))}</li>`).join('');
  const faq = tpl.faq.map(([q, a]) => `
    <dt>Q. ${escapeHtml(fillTemplate(q, safeName, safeKeyword))}</dt>
    <dd>A. ${escapeHtml(fillTemplate(a, safeName, safeKeyword))}</dd>
  `).join('');

  return `
  <section class="info-content" id="info">
    <div class="info-wrap">
      <h2>${safeKeyword} 전문 업체 ${safeName}</h2>
      <p>${intro}</p>

      <h3>${safeName}의 ${safeKeyword} 서비스 특징</h3>
      <ul>${features}</ul>

      <h3>${safeKeyword} 이용 절차</h3>
      <ol>${process}</ol>

      <h3>${safeKeyword} 서비스를 받아야 하는 이유</h3>
      <p>${why}</p>
      <p>${safeName}는 고객님의 소중한 시간과 비용을 존중하며, 안전하고 합리적인 방법으로 최상의 결과를 만들어 드립니다. 지금 바로 전화 또는 문자 상담을 통해 ${safeKeyword} 전문가의 조언을 받아보세요.</p>

      <h3>자주 묻는 질문</h3>
      <dl class="faq">${faq}</dl>
    </div>
  </section>`;
}

function buildFeatureCards(name, keyword, f1, f2, f3) {
  const icons = ['&#9889;', '&#127775;', '&#128142;', '&#128161;', '&#128077;', '&#128295;'];
  const shuffled = [...icons].sort(() => Math.random() - 0.5);
  const cards = [
    { title: f1, desc: `${name}의 ${f1} 서비스로 고객 만족을 최우선으로 실현합니다.` },
    { title: f2, desc: `${name}은(는) ${f2}을(를) 통해 차별화된 품질을 제공합니다.` },
    { title: f3, desc: `${name}의 ${f3}으로 누구나 부담 없이 이용할 수 있습니다.` }
  ];
  return cards.map((c, i) => `
    <div class="feat-card"><div class="feat-icon">${shuffled[i]}</div><h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(c.desc)}</p></div>
  `).join('');
}

function buildSlogan(name, keyword) {
  const slogans = [
    `${name}와 함께하는 특별한 ${keyword}`,
    `${keyword}의 새로운 기준, ${name}`,
    `믿을 수 있는 ${keyword} 전문가 ${name}`,
    `${name}에서 시작하는 ${keyword}`,
    `${name}이(가) 책임지는 ${keyword} 서비스`,
    `고객 만족 1위 ${keyword} 업체 ${name}`
  ];
  return pickRandom(slogans);
}

function buildHeroSub(name, keyword) {
  const subs = [
    `${name}와 함께 더 나은 경험을 만들어 보세요. 지금 바로 전문가와 상담하세요.`,
    `${keyword} 전문가 ${name}이(가) 합리적인 견적으로 빠르게 해결해 드립니다.`,
    `수많은 고객이 선택한 ${name}. ${keyword} 고민은 전문가에게 맡겨 주세요.`,
    `${name}은(는) 고객 한 분 한 분을 위한 맞춤 ${keyword} 서비스를 제공합니다.`,
    `지금 상담하시면 ${name}의 ${keyword} 전문가가 친절하게 안내해 드립니다.`
  ];
  return pickRandom(subs);
}

function buildFeatureLabels(keyword) {
  const pool = [
    '빠른 서비스', '전문 인력', '합리적 가격', '친절 상담', '꼼꼼한 작업',
    '안전한 진행', '정확한 견적', '철저한 관리', '신속한 출동', '맞춤 솔루션',
    '품질 보증', '사후 관리', '편리한 예약', '전국 서비스', '경력의 노하우'
  ];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
}

function buildBottomBar(phone, color) {
  const c = escapeHtml(color);
  return `
  <div class="bottom-bar" style="background:#fff;border-top:1px solid #e5e7eb">
    <a href="tel:${phone}" class="bottom-btn" style="background:${c};color:#fff">📞 전화상담</a>
    <a href="sms:${phone}" class="bottom-btn" style="background:#1f2937;color:#fff">💬 문자상담</a>
  </div>`;
}

export function buildHTML(r, siteUrl) {
  const c = r.color || getRandomColor();
  const cd = darken(c, 45);
  const name = r.name || '서비스';
  const keyword = r.keyword || name;
  const phone = r.phone || '010-0000-0000';
  const [f1, f2, f3] = r.f1 ? [r.f1, r.f2, r.f3] : buildFeatureLabels(keyword);
  const slogan = r.slogan || buildSlogan(name, keyword);
  const heroSub = buildHeroSub(name, keyword);
  const year = new Date().getFullYear();
  const seoHead = buildHeadSEO({ ...r, f1, f2, f3, slogan }, siteUrl);
  const bottomBar = buildBottomBar(phone, c);
  const infoContent = buildInfoContent(name, keyword);
  const featureCards = buildFeatureCards(name, keyword, f1, f2, f3);

  return `<!DOCTYPE html>
<html lang="ko">
<head>${seoHead}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;padding-bottom:64px}
nav{background:${c};padding:18px 48px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
.logo{color:#fff;font-size:20px;font-weight:800}
.nav-btn{background:#fff;color:${c};padding:9px 22px;border-radius:7px;text-decoration:none;font-size:14px;font-weight:700}.nav-btn:hover{opacity:.85}
.hero{background:linear-gradient(135deg,${c} 0%,${cd} 100%);padding:110px 48px 100px;text-align:center}
.hero h1{color:#fff;font-size:clamp(30px,6vw,58px);font-weight:800;line-height:1.15;letter-spacing:-1px;margin-bottom:18px}
.hero p{color:rgba(255,255,255,.85);font-size:clamp(15px,2vw,19px);margin-bottom:40px;max-width:600px;margin-left:auto;margin-right:auto}
.hero-btns{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.hero-btn{display:inline-block;background:#fff;color:${c};padding:16px 32px;border-radius:10px;font-size:16px;font-weight:800;text-decoration:none;box-shadow:0 8px 30px rgba(0,0,0,.2);min-width:160px}
.hero-btn.outline{background:transparent;color:#fff;border:2px solid #fff;box-shadow:none}
.features{padding:90px 48px;background:#f9fafb}
.features h2{text-align:center;font-size:clamp(22px,4vw,34px);font-weight:800;margin-bottom:12px}
.features .fsub{text-align:center;color:#888;font-size:15px;margin-bottom:50px}
.feat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:22px;max-width:940px;margin:0 auto}
.feat-card{background:#fff;padding:34px 26px;border-radius:14px;box-shadow:0 2px 14px rgba(0,0,0,.06)}
.feat-icon{width:50px;height:50px;background:${c}22;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}
.feat-card h3{font-size:17px;font-weight:700;color:${c};margin-bottom:8px}
.feat-card p{font-size:13px;color:#777;line-height:1.7}
.info-content{padding:90px 48px;background:#fff}
.info-wrap{max-width:800px;margin:0 auto}
.info-content h2{font-size:clamp(22px,4vw,32px);font-weight:800;margin-bottom:20px;color:#111}
.info-content h3{font-size:clamp(17px,3vw,21px);font-weight:700;margin:40px 0 16px;color:#222}
.info-content p{color:#555;line-height:1.9;margin-bottom:18px;font-size:15px}
.info-content ul,.info-content ol{margin:0 0 20px 22px;color:#555;line-height:1.9;font-size:15px}
.info-content li{margin-bottom:10px}
.faq{margin-top:24px}
.faq dt{font-weight:700;color:#111;margin:22px 0 8px;font-size:15px}
.faq dd{color:#555;line-height:1.8;margin-left:0;font-size:15px}
.bottom-bar{position:fixed;bottom:0;left:0;right:0;z-index:100;padding:10px 16px;display:flex;gap:10px;justify-content:center;box-shadow:0 -2px 8px rgba(0,0,0,.08)}
.bottom-btn{flex:1;max-width:220px;padding:14px 0;border-radius:8px;font-size:15px;font-weight:700;text-align:center;text-decoration:none}
footer{background:#111;color:#888;text-align:center;padding:28px;font-size:12px}
@media(max-width:600px){
  nav{padding:14px 20px}
  .hero{padding:80px 20px 70px}
  .hero-btn{padding:14px 22px;font-size:15px;min-width:140px}
  .features{padding:70px 20px}
  .info-content{padding:70px 20px}
}
</style>
</head>
<body>
<nav><div class="logo">${name}</div><a href="tel:${phone}" class="nav-btn">${phone}</a></nav>
<section class="hero">
<h1>${slogan}</h1>
<p>${heroSub}</p>
<div class="hero-btns">
  <a href="tel:${phone}" class="hero-btn">📞 전화상담 바로가기</a>
  <a href="sms:${phone}" class="hero-btn outline">💬 문자상담 바로가기</a>
</div>
</section>
<section class="features">
<h2>왜 ${name}인가요?</h2>
<p class="fsub">${name}만의 특별한 3가지 이유</p>
<div class="feat-grid">
${featureCards}
</div>
</section>
${infoContent}
${bottomBar}
<footer><p>&copy; ${year} ${name}. All rights reserved.</p></footer>
</body>
</html>`;
}

export function buildSitemap(siteUrl) {
  const u = (siteUrl || '').replace(/\/$/, '');
  const today = new Date().toISOString().split('T')[0];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>' + u + '/</loc>\n    <lastmod>' + today + '</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n';
}

export function buildRobots(siteUrl) {
  const u = (siteUrl || '').replace(/\/$/, '');
  return 'User-agent: *\nAllow: /\nSitemap: ' + u + '/sitemap.xml\n';
}
