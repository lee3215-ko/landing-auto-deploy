import os from 'os';
import path from 'path';
import fs from 'fs';

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

function extractJson(text) {
  let raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  return JSON.parse(raw);
}

async function loadCursorSdk() {
  try {
    return await import('@cursor/sdk');
  } catch (e) {
    const msg = e?.message || String(e);
    throw new Error(
      `Cursor SDK 로드 실패: ${msg}\n`
      + 'portable EXE에서 반복되면 dist\\win-unpacked\\Landing Auto Deploy.exe 로 실행하세요.',
    );
  }
}

/** Electron 등 node:sqlite 없는 런타임용 JSONL 스토어 */
async function createLocalStore() {
  const { JsonlLocalAgentStore } = await loadCursorSdk();
  const root = path.join(os.tmpdir(), 'landing-auto-deploy-cursor-store');
  fs.mkdirSync(root, { recursive: true });
  return new JsonlLocalAgentStore(root);
}

/**
 * Cursor Agent.prompt — JSON만 요청 (파일 수정 도구에 의존하지 않음)
 * Electron(Node 내장 sqlite 없음)에서는 JsonlLocalAgentStore 필수
 */
export async function runCursorPrompt(prompt, { apiKey, cwd, sendLog, label = 'AI' } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Cursor API Key가 없습니다. 넷리파이 생성 탭에 키를 입력하세요.');

  const workDir = cwd || path.join(os.tmpdir(), 'landing-auto-deploy-cursor');
  fs.mkdirSync(workDir, { recursive: true });
  relay(sendLog, `Cursor AI 호출 중… (${label})`);

  const { Agent } = await loadCursorSdk();
  const result = await Agent.prompt(prompt, {
    apiKey: key,
    model: { id: 'composer-2.5' },
    local: {
      cwd: workDir,
      store: await createLocalStore(),
    },
  });

  if (result?.status === 'error') {
    throw new Error(`Cursor AI 실패 (${label}): ${result?.error || result?.result || 'unknown'}`);
  }
  const text = String(result?.result || '').trim();
  if (!text) throw new Error(`Cursor AI 빈 응답 (${label})`);
  return text;
}

/**
 * 핵심키워드 → 관련키워드 5개 + 4페이지 본문 JSON
 */
export async function generateSeoContentWithCursor({
  keyword,
  phoneDisplay = '010-6338-7124',
  apiKey,
  sendLog,
} = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('핵심키워드가 필요합니다.');

  const prompt = `당신은 네이버·구글 검색용 정보형 금융 주의 안내 사이트 카피라이터입니다.
핵심키워드: ${kw}
연락처 표시: ${phoneDisplay}

반드시 JSON만 출력하세요. 마크다운 코드펜스·설명 문장 금지.

스키마:
{
  "relatedKeywords": ["관련키워드1","관련키워드2","관련키워드3","관련키워드4","관련키워드5"],
  "pages": {
    "index": {
      "title": "${kw} | 상담 전 확인할 비용과 안전 기준",
      "description": "80~130자, ${kw}로 시작, 과장 금지",
      "h1": "${kw}로 시작하는 H1 (title과 동일 복사 금지)",
      "lead": "첫 문단 2~3문장",
      "sections": [
        {"h2":"...", "body":"문단 HTML 없이 평문 2~4문장", "list":["항목", "..."], "listType":"check|ol|none", "box":"요약 강조 문장 또는 빈 문자열"}
      ]
    },
    "fee-guide": {
      "title": "${kw} | 수수료와 실제 수령액 비교",
      "description": "...",
      "h1": "...",
      "lead": "...",
      "sections": [ ... 7~10개 ... ]
    },
    "safety-check": {
      "title": "${kw} | 개인정보와 카드사 약관 점검",
      "description": "...",
      "h1": "...",
      "lead": "...",
      "sections": [ ... ]
    },
    "faq": {
      "title": "${kw} | 상담 전 자주 묻는 질문",
      "description": "...",
      "h1": "...",
      "lead": "...",
      "faqs": [{"q":"질문","a":"답변"}, "... 5~8개"],
      "sections": [ ... 보충 H2 3~5개 ... ]
    }
  }
}

규칙:
- relatedKeywords는 핵심키워드와 검색 의도가 다르지만 연관된 한국어 키워드 정확히 5개
- 페이지마다 title/description/h1/lead/sections가 서로 달라야 함
- index sections 7~10개, fee-guide·safety-check 7~10개
- 절대 쓰지 말 것(한 글자라도 금지): 승인 보장, 무조건 가능, 100% 가능, 최저 수수료 보장, 즉시 입금 보장, 10년 무사고, 정식 등록 업체, 안전업체, 키움(뱅크/페이 포함)
- 대신: "승인 여부 확인", "상담 후 가능 여부 확인", "수수료는 사전 확인", "입금 시점은 사전 확인" 등 확인·주의 표현만 사용
- 정보성·주의·비교·공식 대안(카드론·현금서비스·서민금융) 관점
- 연락처 번호는 본문에 반복하지 말 것 (이미 헤더/하단에 있음)
`;

  const raw = await runCursorPrompt(prompt, {
    apiKey,
    cwd: path.join(os.tmpdir(), 'landing-auto-deploy-cursor'),
    sendLog,
    label: kw,
  });

  let data;
  try {
    data = extractJson(raw);
  } catch (e) {
    throw new Error(`Cursor AI JSON 파싱 실패: ${e.message}`);
  }

  const related = Array.isArray(data.relatedKeywords)
    ? data.relatedKeywords.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  if (related.length < 5) {
    // 부족하면 보충
    const fillers = [`${kw} 수수료`, `${kw} 비용`, `${kw} 주의사항`, `${kw} 상담`, `${kw} 비교`];
    for (const f of fillers) {
      if (related.length >= 5) break;
      if (!related.includes(f) && f !== kw) related.push(f);
    }
  }
  data.relatedKeywords = related.slice(0, 5);

  if (!data.pages?.index || !data.pages?.['fee-guide'] || !data.pages?.['safety-check'] || !data.pages?.faq) {
    throw new Error('Cursor AI 응답에 페이지 본문이 부족합니다.');
  }

  relay(sendLog, `관련키워드 5개: ${data.relatedKeywords.join(', ')}`);
  return data;
}
