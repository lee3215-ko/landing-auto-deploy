/**
 * 캡챠 실패 로그 + 수동 「학습하기」로 실패율 감소용 모델 갱신
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_MODEL = {
  version: 1,
  trainedAt: '',
  failureCount: 0,
  successCount: 0,
  /** 제출 후 실패한 답 (우선 피함) */
  avoidAnswers: [],
  /** 성공한 답 길이 분포 */
  lengthHistogram: {},
  /** 혼동 보정: 실패답→성공답 문자 치환 힌트 */
  charHints: {},
  /** YesCaptcha 재시도 횟수 (학습 후 2~3) */
  yesCaptchaRetries: 2,
  /** 1차 YesCaptcha 타임아웃(ms) */
  yesTimeoutMs: 45000,
  notes: [],
};

let learnRoot = '';

export function setCaptchaLearnRoot(dir) {
  learnRoot = String(dir || '').trim();
}

function rootDir() {
  return learnRoot || path.join(process.cwd(), 'output', 'captcha-learn');
}

function failuresPath() {
  return path.join(rootDir(), 'failures.jsonl');
}

function successesPath() {
  return path.join(rootDir(), 'successes.jsonl');
}

function modelPath() {
  return path.join(rootDir(), 'model.json');
}

function imagesDir() {
  return path.join(rootDir(), 'images');
}

function ensureDirs() {
  fs.mkdirSync(rootDir(), { recursive: true });
  fs.mkdirSync(imagesDir(), { recursive: true });
}

export function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
}

function appendJsonl(filePath, obj) {
  ensureDirs();
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function readJsonl(filePath, limit = 5000) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const slice = lines.length > limit ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

export function loadCaptchaModel() {
  try {
    if (!fs.existsSync(modelPath())) return { ...DEFAULT_MODEL };
    const m = JSON.parse(fs.readFileSync(modelPath(), 'utf8'));
    return { ...DEFAULT_MODEL, ...m };
  } catch {
    return { ...DEFAULT_MODEL };
  }
}

function saveModel(model) {
  ensureDirs();
  fs.writeFileSync(modelPath(), JSON.stringify(model, null, 2), 'utf8');
}

/**
 * 캡챠 OCR/제출 실패 기록 (항상 호출 가능)
 */
export function logCaptchaFailure(entry = {}) {
  try {
    ensureDirs();
    const now = new Date().toISOString();
    let imageRel = '';
    let imageHash = entry.imageHash || '';
    if (entry.imageBuf?.length) {
      imageHash = imageHash || hashBuffer(entry.imageBuf);
      const dest = path.join(imagesDir(), `${now.replace(/[:.]/g, '-')}_${imageHash}.png`);
      try {
        fs.writeFileSync(dest, entry.imageBuf);
        imageRel = path.relative(rootDir(), dest);
      } catch { /* ignore */ }
    } else if (entry.imagePath && fs.existsSync(entry.imagePath)) {
      try {
        const buf = fs.readFileSync(entry.imagePath);
        imageHash = imageHash || hashBuffer(buf);
        const dest = path.join(imagesDir(), `${now.replace(/[:.]/g, '-')}_${imageHash}.png`);
        fs.copyFileSync(entry.imagePath, dest);
        imageRel = path.relative(rootDir(), dest);
      } catch { /* ignore */ }
    }

    const row = {
      at: now,
      kind: entry.kind || 'fail',
      context: entry.context || '',
      solver: entry.solver || '',
      answers: Array.isArray(entry.answers) ? entry.answers.filter(Boolean).slice(0, 8) : [],
      reason: entry.reason || '',
      captchaKey: entry.captchaKey || '',
      attemptLevel: entry.attemptLevel ?? null,
      imageHash,
      imageRel,
      meta: entry.meta || {},
    };
    appendJsonl(failuresPath(), row);
    return row;
  } catch (e) {
    console.warn('[CAPTCHA-LEARN] log fail:', e.message);
    return null;
  }
}

/** 제출 성공 시 — 학습용 정답 축적 */
export function logCaptchaSuccess(entry = {}) {
  try {
    ensureDirs();
    const row = {
      at: new Date().toISOString(),
      context: entry.context || '',
      solver: entry.solver || '',
      answer: String(entry.answer || '').trim(),
      captchaKey: entry.captchaKey || '',
      imageHash: entry.imageHash || '',
      failedBefore: entry.failedBefore || [],
    };
    if (!row.answer) return null;
    appendJsonl(successesPath(), row);
    return row;
  } catch (e) {
    console.warn('[CAPTCHA-LEARN] log success:', e.message);
    return null;
  }
}

export function getCaptchaLearnStats() {
  const fails = readJsonl(failuresPath());
  const oks = readJsonl(successesPath());
  const model = loadCaptchaModel();
  const bySolver = {};
  const byReason = {};
  for (const f of fails) {
    const s = f.solver || 'unknown';
    bySolver[s] = (bySolver[s] || 0) + 1;
    const r = f.reason || 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;
  }
  return {
    failureCount: fails.length,
    successCount: oks.length,
    bySolver,
    byReason,
    model,
    root: rootDir(),
    lastFailureAt: fails.length ? fails[fails.length - 1].at : '',
    lastSuccessAt: oks.length ? oks[oks.length - 1].at : '',
  };
}

export function listRecentCaptchaFailures(limit = 50) {
  const fails = readJsonl(failuresPath());
  return fails.slice(-limit).reverse();
}

/**
 * 실패/성공 로그를 분석해 model.json 갱신 (사용자가 학습하기 버튼으로만 호출)
 */
export function trainCaptchaModel({ onLog } = {}) {
  const log = (m) => { if (typeof onLog === 'function') onLog(m); };
  const fails = readJsonl(failuresPath());
  const oks = readJsonl(successesPath());
  if (!fails.length && !oks.length) {
    return { ok: false, message: '학습할 캡챠 기록이 없습니다. 실패가 쌓인 뒤 다시 눌러 주세요.' };
  }

  const failAnswers = new Map();
  for (const f of fails) {
    for (const a of f.answers || []) {
      const k = String(a).trim();
      if (!k) continue;
      failAnswers.set(k, (failAnswers.get(k) || 0) + 1);
    }
  }
  const successAnswers = new Set(oks.map((o) => String(o.answer || '').trim()).filter(Boolean));

  // 성공한 적 없는 실패 답만 avoid
  const avoid = [...failAnswers.entries()]
    .filter(([a]) => !successAnswers.has(a))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([a]) => a);

  const lengthHistogram = {};
  for (const a of successAnswers) {
    const n = a.length;
    lengthHistogram[n] = (lengthHistogram[n] || 0) + 1;
  }

  // 같은 imageHash에서 실패 후 성공이 있으면 문자 힌트
  const charHints = {};
  const byHash = new Map();
  for (const f of fails) {
    if (!f.imageHash) continue;
    if (!byHash.has(f.imageHash)) byHash.set(f.imageHash, { fails: [], ok: null });
    byHash.get(f.imageHash).fails.push(...(f.answers || []));
  }
  for (const o of oks) {
    if (!o.imageHash) continue;
    if (!byHash.has(o.imageHash)) byHash.set(o.imageHash, { fails: [], ok: null });
    byHash.get(o.imageHash).ok = o.answer;
  }
  for (const { fails: tried, ok } of byHash.values()) {
    if (!ok) continue;
    for (const bad of tried) {
      if (!bad || bad === ok || bad.length !== ok.length) continue;
      for (let i = 0; i < ok.length; i++) {
        if (bad[i] === ok[i]) continue;
        const key = `${bad[i]}→${ok[i]}`;
        charHints[key] = (charHints[key] || 0) + 1;
      }
    }
  }

  const failRate = fails.length / Math.max(1, fails.length + oks.length);
  const yesCaptchaRetries = failRate > 0.55 ? 3 : failRate > 0.35 ? 2 : 2;
  const yesTimeoutMs = failRate > 0.5 ? 60000 : 45000;

  const notes = [
    `실패 ${fails.length}건 · 성공 ${oks.length}건 분석`,
    `회피 답 ${avoid.length}개`,
    `문자 힌트 ${Object.keys(charHints).length}개`,
    `YesCaptcha 재시도 ${yesCaptchaRetries}회`,
  ];

  const model = {
    ...DEFAULT_MODEL,
    version: 1,
    trainedAt: new Date().toISOString(),
    failureCount: fails.length,
    successCount: oks.length,
    avoidAnswers: avoid,
    lengthHistogram,
    charHints,
    yesCaptchaRetries,
    yesTimeoutMs,
    notes,
  };
  saveModel(model);
  log(`학습 완료: ${notes.join(' · ')}`);
  return { ok: true, model, message: notes.join(' · ') };
}

/** 솔버가 후보를 걸러낼 때 사용 */
export function filterLearnedAnswers(candidates = []) {
  const model = loadCaptchaModel();
  const avoid = new Set(model.avoidAnswers || []);
  const list = (candidates || []).map((c) => String(c || '').trim()).filter(Boolean);
  if (!list.length) return list;
  const preferred = list.filter((a) => !avoid.has(a));
  return preferred.length ? preferred : list;
}

/** 학습된 문자 힌트로 답 변형 추가 */
export function expandWithCharHints(answer = '') {
  const a = String(answer || '').trim();
  if (!a) return [];
  const model = loadCaptchaModel();
  const hints = model.charHints || {};
  const top = Object.entries(hints).sort((x, y) => y[1] - x[1]).slice(0, 12);
  const out = new Set([a]);
  for (const [pair] of top) {
    const [from, to] = pair.split('→');
    if (!from || !to || from.length !== 1 || to.length !== 1) continue;
    if (!a.includes(from)) continue;
    out.add(a.split(from).join(to));
  }
  // 흔한 OCR 혼동
  const swaps = [['0', 'O'], ['O', '0'], ['1', 'l'], ['l', '1'], ['I', '1'], ['1', 'I'], ['5', 'S'], ['S', '5']];
  for (const [from, to] of swaps) {
    if (a.includes(from)) out.add(a.split(from).join(to));
  }
  return [...out];
}

export function getSolveHints() {
  const model = loadCaptchaModel();
  return {
    yesCaptchaRetries: Math.max(1, Math.min(4, model.yesCaptchaRetries || 2)),
    yesTimeoutMs: Math.max(25000, Math.min(90000, model.yesTimeoutMs || 45000)),
    avoidAnswers: model.avoidAnswers || [],
    trainedAt: model.trainedAt || '',
  };
}
