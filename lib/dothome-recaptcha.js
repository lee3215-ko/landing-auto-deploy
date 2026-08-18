/**
 * reCAPTCHA v2 — 체크박스 + 이미지 타일 선택(3x3/4x4) 자동 해결
 */
import fs from 'fs';
import path from 'path';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

async function humanMouseClick(page, x, y) {
  const steps = 14 + Math.floor(Math.random() * 10);
  await page.mouse.move(x + rand(-10, 10), y + rand(-10, 10), { steps });
  await sleep(rand(60, 180));
  await page.mouse.move(x, y, { steps: 4 });
  await sleep(rand(30, 90));
  await page.mouse.down();
  await sleep(rand(35, 90));
  await page.mouse.up();
}

function findRecaptchaFrames(page) {
  const frames = page.frames();
  const anchor = frames.find((f) => /recaptcha\/(?:api2|enterprise)\/anchor/i.test(f.url()));
  const bframe = frames.find((f) => /recaptcha\/(?:api2|enterprise)\/bframe/i.test(f.url()));
  return { anchor, bframe };
}

async function isRecaptchaSolved(page) {
  const { anchor } = findRecaptchaFrames(page);
  if (anchor) {
    const ok = await anchor.evaluate(() => {
      const el = document.querySelector('#recaptcha-anchor');
      return el?.getAttribute('aria-checked') === 'true'
        || el?.classList?.contains('recaptcha-checkbox-checked');
    }).catch(() => false);
    if (ok) return true;
  }
  return page.evaluate(() => {
    const ta = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
    return !!(ta && ta.value && ta.value.length > 20);
  }).catch(() => false);
}

async function isChallengeVisible(bframe) {
  if (!bframe) return false;
  return bframe.evaluate(() => {
    const payload = document.querySelector('.rc-imageselect-payload, #rc-imageselect, .rc-imageselect');
    if (!payload) return false;
    const style = window.getComputedStyle(payload);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const tiles = document.querySelectorAll('.rc-imageselect-tile, td.rc-imageselect-tile');
    return tiles.length >= 9;
  }).catch(() => false);
}

async function waitForRecaptchaAnchor(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { anchor } = findRecaptchaFrames(page);
    if (anchor) {
      const ready = await anchor.$('#recaptcha-anchor, .recaptcha-checkbox-border').catch(() => null);
      if (ready) return anchor;
    }
    // iframe DOM 존재 여부
    const hasIframe = await page.evaluate(() => (
      [...document.querySelectorAll('iframe')].some((f) => /recaptcha.*anchor|anchor.*recaptcha/i.test(f.src || ''))
    )).catch(() => false);
    if (hasIframe) {
      await sleep(400);
      const { anchor: a2 } = findRecaptchaFrames(page);
      if (a2) return a2;
    }
    await sleep(400);
  }
  return null;
}

async function scrollRecaptchaIntoView(page) {
  await page.evaluate(() => {
    const iframe = [...document.querySelectorAll('iframe')].find((f) => /recaptcha.*anchor|anchor.*recaptcha/i.test(f.src || ''));
    const wrap = iframe?.closest('.g-recaptcha, .grecaptcha, [class*="recaptcha"], form') || iframe;
    if (wrap) wrap.scrollIntoView({ block: 'center', inline: 'nearest' });
    else window.scrollBy(0, 200);
  }).catch(() => {});
  await sleep(500);
}

/**
 * 「로봇이 아닙니다」 체크 — iframe 좌표 클릭 / frame.click / 외곽 iframe 클릭 순으로 시도
 */
async function clickRecaptchaCheckbox(page, sendLog) {
  const log = (m) => sendLog?.(m);

  await scrollRecaptchaIntoView(page);
  let anchor = await waitForRecaptchaAnchor(page, 25000);
  if (!anchor) {
    // 마지막 시도: 프레임 목록 재수집
    await sleep(1000);
    ({ anchor } = findRecaptchaFrames(page));
  }

  // ── 방법1: iframe 요소의 페이지 좌표로 mouse 클릭 ──
  const iframeHandle = await page.$([
    'iframe[src*="recaptcha/api2/anchor"]',
    'iframe[src*="recaptcha/enterprise/anchor"]',
    'iframe[title*="reCAPTCHA"]',
    'iframe[src*="anchor"]',
  ].join(', ')).catch(() => null);

  if (iframeHandle) {
    await iframeHandle.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await sleep(400);
    const iframeBox = await iframeHandle.boundingBox();
    if (iframeBox && iframeBox.width > 10 && iframeBox.height > 10) {
      // 체크박스는 iframe 왼쪽 중앙 부근 (약 28x28)
      const x = iframeBox.x + Math.min(28, iframeBox.width * 0.12);
      const y = iframeBox.y + iframeBox.height * 0.5;
      log(`체크박스 좌표 클릭 (${Math.round(x)}, ${Math.round(y)})`);
      await humanMouseClick(page, x, y);
      await sleep(1200);
      if (await isRecaptchaSolved(page)) return true;
      let { bframe } = findRecaptchaFrames(page);
      if (await isChallengeVisible(bframe)) return true;
    }
  }

  // ── 방법2: anchor frame 내부 element click ──
  if (anchor) {
    try {
      const el = await anchor.$('#recaptcha-anchor, .recaptcha-checkbox-border, .recaptcha-checkbox, span.recaptcha-checkbox');
      if (el) {
        const box = await el.boundingBox();
        if (box) {
          log('anchor 내부 boundingBox 클릭');
          await humanMouseClick(page, box.x + box.width * 0.5, box.y + box.height * 0.5);
          await sleep(1200);
          if (await isRecaptchaSolved(page)) return true;
          if (await isChallengeVisible(findRecaptchaFrames(page).bframe)) return true;
        }
        log('anchor frame.click() 시도');
        await el.click({ delay: rand(40, 90) });
        await sleep(1200);
        if (await isRecaptchaSolved(page)) return true;
        if (await isChallengeVisible(findRecaptchaFrames(page).bframe)) return true;
      }
    } catch (e) {
      log(`anchor 클릭 예외: ${e.message}`);
    }
  }

  // ── 방법3: Puppeteer contentFrame + click ──
  if (iframeHandle) {
    try {
      const frame = await iframeHandle.contentFrame();
      if (frame) {
        await frame.waitForSelector('#recaptcha-anchor', { timeout: 5000 }).catch(() => {});
        log('contentFrame #recaptcha-anchor 클릭');
        await frame.click('#recaptcha-anchor', { delay: 50 });
        await sleep(1500);
        if (await isRecaptchaSolved(page)) return true;
        if (await isChallengeVisible(findRecaptchaFrames(page).bframe)) return true;
      }
    } catch (e) {
      log(`contentFrame 클릭 실패: ${e.message}`);
    }
  }

  // ── 방법4: 메인 페이지에서 보이는 체크 영역 재클릭 ──
  if (iframeHandle) {
    const box = await iframeHandle.boundingBox();
    if (box) {
      for (const [dx, dy] of [[0.08, 0.5], [0.15, 0.5], [0.25, 0.5]]) {
        const x = box.x + box.width * dx;
        const y = box.y + box.height * dy;
        log(`재시도 클릭 (${Math.round(x)}, ${Math.round(y)})`);
        await humanMouseClick(page, x, y);
        await sleep(1500);
        if (await isRecaptchaSolved(page)) return true;
        if (await isChallengeVisible(findRecaptchaFrames(page).bframe)) return true;
      }
    }
  }

  throw new Error('「로봇이 아닙니다」 체크박스를 클릭하지 못했습니다.');
}

async function readChallengeMeta(bframe) {
  return bframe.evaluate(() => {
    const desc = (
      document.querySelector('.rc-imageselect-desc-text, .rc-imageselect-desc, strong')?.textContent
      || document.body?.innerText
      || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 200);

    const tiles = Array.from(document.querySelectorAll(
      'table.rc-imageselect-table-44 td.rc-imageselect-tile, table.rc-imageselect-table-33 td.rc-imageselect-tile, .rc-imageselect-tile',
    ));
    // 중복 제거 (중첩 셀렉터)
    const unique = [];
    const seen = new Set();
    for (const t of tiles) {
      if (seen.has(t)) continue;
      seen.add(t);
      unique.push(t);
    }

    let cols = 4;
    if (document.querySelector('table.rc-imageselect-table-33')) cols = 3;
    else if (document.querySelector('table.rc-imageselect-table-44')) cols = 4;
    else if (unique.length === 9) cols = 3;
    else if (unique.length === 16) cols = 4;

    return {
      desc,
      tileCount: unique.length,
      cols,
      rows: unique.length && cols ? Math.ceil(unique.length / cols) : 0,
      selectedCount: unique.filter((t) => t.classList.contains('rc-imageselect-tileselected')).length,
      verifyLabel: (document.querySelector('#recaptcha-verify-button')?.textContent || '').trim(),
    };
  });
}

async function getTileHandles(bframe) {
  const tiles = await bframe.$$(
    'table.rc-imageselect-table-44 td.rc-imageselect-tile, table.rc-imageselect-table-33 td.rc-imageselect-tile, td.rc-imageselect-tile, .rc-imageselect-tile',
  );
  // dedupe by element handle identity is hard — filter by bounding boxes
  const out = [];
  const boxes = [];
  for (const t of tiles) {
    const box = await t.boundingBox();
    if (!box || box.width < 20 || box.height < 20) continue;
    const dup = boxes.some((b) => Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2);
    if (dup) continue;
    boxes.push(box);
    out.push(t);
  }
  // sort top-to-bottom, left-to-right
  const decorated = [];
  for (let i = 0; i < out.length; i++) {
    decorated.push({ el: out[i], box: boxes[i] });
  }
  decorated.sort((a, b) => (Math.abs(a.box.y - b.box.y) < 8 ? a.box.x - b.box.x : a.box.y - b.box.y));
  return decorated.map((d) => d.el);
}

const TARGET_MAP = [
  ['자전거', 'bicycle'],
  ['오토바이', 'motorcycle'],
  ['스쿠터', 'scooter'],
  ['트랙터', 'tractor'],
  ['버스', 'bus'],
  ['자동차', 'car'],
  ['차량', 'vehicle'],
  ['트럭', 'truck'],
  ['택시', 'taxi'],
  ['신호등', 'traffic light'],
  ['횡단보도', 'crosswalk'],
  ['소화전', 'fire hydrant'],
  ['다리', 'bridge'],
  ['배', 'boat'],
  ['보트', 'boat'],
  ['비행기', 'airplane'],
  ['계단', 'stairs'],
  ['굴뚝', 'chimney'],
  ['우산', 'umbrella'],
  ['가방', 'bag'],
  ['벤치', 'bench'],
  ['산', 'mountain'],
  ['나무', 'tree'],
  ['주차장', 'parking meter'],
  ['주차미터', 'parking meter'],
];

function extractTargetObject(desc) {
  const text = String(desc || '');
  for (const [ko, en] of TARGET_MAP) {
    if (text.includes(ko)) return { ko, en };
  }
  // "○○가 있는" 패턴
  const m = text.match(/([가-힣A-Za-z]{2,12})\s*가\s*있는/);
  if (m) return { ko: m[1], en: m[1] };
  const first = text.replace(/\s+/g, ' ').trim().split(/\s+/)[0] || 'object';
  return { ko: first.slice(0, 20), en: first.slice(0, 20) };
}

function isVisionRefusal(raw) {
  return /sorry|can'?t assist|cannot assist|unable to|i'?m not able|won'?t help|against.*policy|refuse|죄송|도와드릴\s*수\s*없|할\s*수\s*없/i.test(String(raw || ''));
}

/** sharp 없이 Puppeteer canvas로 1..N 번호 오버레이 */
async function annotateGridImage(page, inputPath, outputPath, cols, rows) {
  const b64 = fs.readFileSync(inputPath).toString('base64');

  async function runOn(targetPage) {
    return targetPage.evaluate(async ({ b64In, cols: c, rows: r }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('image load failed'));
        img.src = `data:image/png;base64,${b64In}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const cw = canvas.width / c;
      const ch = canvas.height / r;
      const fontSize = Math.max(16, Math.floor(Math.min(cw, ch) * 0.32));
      ctx.font = `bold ${fontSize}px Arial,sans-serif`;
      ctx.textBaseline = 'top';
      for (let row = 0; row < r; row++) {
        for (let col = 0; col < c; col++) {
          const n = row * c + col + 1;
          const x = col * cw + 6;
          const y = row * ch + 6;
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(x - 2, y - 2, fontSize * (n >= 10 ? 1.5 : 1.1), fontSize + 4);
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#000';
          ctx.fillStyle = '#FFE600';
          ctx.strokeText(String(n), x, y);
          ctx.fillText(String(n), x, y);
        }
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }, { b64In: b64, cols, rows });
  }

  let outB64;
  try {
    outB64 = await runOn(page);
  } catch (e) {
    // CSP 등으로 메인 페이지 실패 시 빈 페이지에서 처리
    const tmp = await page.browser().newPage();
    try {
      await tmp.goto('about:blank');
      outB64 = await runOn(tmp);
    } finally {
      await tmp.close().catch(() => {});
    }
  }

  if (!outB64) throw new Error('canvas 오버레이 실패');
  fs.writeFileSync(outputPath, Buffer.from(outB64, 'base64'));
}

async function callVision(apiKey, prompt, b64) {
  return callVisionContent(apiKey, [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } },
  ]);
}

async function callVisionContent(apiKey, content) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: 120,
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return (data.choices?.[0]?.message?.content || '').trim();
}

function parseTileNumbers(raw, tileCount) {
  if (!raw || isVisionRefusal(raw)) return { status: 'refuse', numbers: [] };

  if (/numbers\s*=\s*none/i.test(raw) || /^none$/i.test(raw.trim())) {
    return { status: 'empty', numbers: [] };
  }

  const m = raw.match(/numbers?\s*=\s*([0-9,\s]+)/i)
    || raw.match(/\[([0-9,\s]+)\]/)
    || raw.match(/([0-9]+(?:\s*,\s*[0-9]+)+)/);

  let nums = [];
  if (m) {
    nums = m[1].split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => n > 0);
  } else {
    const alone = raw.match(/\d+/g);
    if (alone?.length) nums = alone.map((n) => parseInt(n, 10));
  }

  nums = [...new Set(nums.filter((n) => n > 0 && n <= tileCount))];
  if (!nums.length) {
    if (/sorry|can'?t|unable|refuse/i.test(raw)) return { status: 'refuse', numbers: [] };
    return { status: 'empty', numbers: [] };
  }
  return { status: 'ok', numbers: nums };
}

/**
 * 타일을 하나씩 캡처해 Vision에 전달 (전체 격자 numbers=none 일 때 폴백)
 */
async function askPerTileFallback(page, bframe, apiKey, folder, target, meta, log) {
  const tiles = await getTileHandles(bframe);
  if (tiles.length < 9) return { status: 'empty', numbers: [] };

  const stamp = Date.now();
  const tileDir = path.join(folder, `tiles_${stamp}`);
  fs.mkdirSync(tileDir, { recursive: true });

  const content = [
    {
      type: 'text',
      text: `I will show ${tiles.length} photo tiles one by one, labeled Tile 1 .. Tile ${tiles.length}.
Which tiles contain ANY part of a "${target.en}" (${target.ko})?
Include partial pieces. Reply ONLY: numbers=1,5,7  or numbers=none`,
    },
  ];

  // 토큰/비용 절감: 최대 16장, detail=low
  const maxTiles = Math.min(tiles.length, 16);
  for (let i = 0; i < maxTiles; i++) {
    const p = path.join(tileDir, `t${i + 1}.png`);
    try {
      await tiles[i].screenshot({ path: p });
      const b64 = fs.readFileSync(p).toString('base64');
      content.push({ type: 'text', text: `Tile ${i + 1}:` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}`, detail: 'low' },
      });
    } catch (e) {
      log(`타일 ${i + 1} 캡처 실패: ${e.message}`);
    }
  }

  log(`타일별 Vision 분석 (${maxTiles}장)...`);
  const raw = await callVisionContent(apiKey, content);
  log(`타일별 응답: ${raw}`);
  return parseTileNumbers(raw, meta.tileCount || maxTiles);
}

/**
 * @returns {{ status: 'ok'|'empty'|'refuse', numbers: number[] }}
 */
async function askOpenAIForTiles({ apiKey, b64, meta, target, log }) {
  const cols = meta.cols || 4;
  const rows = meta.rows || 4;
  const total = meta.tileCount || cols * rows;

  // 캡챠 언급 금지 — 16칸 격자 객체 탐지
  const prompt = `This image is ONE photo split into exactly ${total} equal cells in a ${rows}x${cols} grid.
Cell numbering (left→right, top→bottom):
${cols === 4
    ? '1  2  3  4\n5  6  7  8\n9 10 11 12\n13 14 15 16'
    : '1 2 3\n4 5 6\n7 8 9'}
Yellow digits on cells (if present) are the cell IDs.

Task: list EVERY cell ID that contains ANY visible part of a "${target.en}" / "${target.ko}".
Include partial pieces (roof, bumper, wheel, logo, window edge). If the object spans multiple cells, include ALL of those cells.

Reply with exactly one line:
numbers=7,11
or if none:
numbers=none`;

  const raw = await callVision(apiKey, prompt, b64);
  log(`Vision 응답: ${raw}`);
  return parseTileNumbers(raw, total);
}

/** 타일 선택 후 누를 버튼: 확인 / 다음 (건너뛰기는 제외) */
function isActionButtonLabel(label) {
  const t = String(label || '').trim();
  if (!t) return false;
  if (/건너뛰|skip/i.test(t)) return false;
  return /확인|다음|verify|next/i.test(t);
}

async function clickVerifyButton(page, bframe, log) {
  const btn = await bframe.$('#recaptcha-verify-button');
  if (!btn) {
    log('확인/다음 버튼 없음');
    return false;
  }
  const label = await bframe.evaluate((el) => (el.textContent || '').trim(), btn);
  if (/건너뛰|skip/i.test(label)) {
    log(`버튼이 「${label}」라서 클릭하지 않음 (타일을 먼저 선택해야 함)`);
    return false;
  }
  if (!isActionButtonLabel(label) && label) {
    // 라벨이 비어있거나 알 수 없으면 타일 선택 후에는 클릭 시도
    log(`버튼 라벨 「${label}」 — 클릭 시도`);
  }
  const box = await btn.boundingBox();
  if (!box) return false;
  log(`「${label || '확인/다음'}」 클릭`);
  await humanMouseClick(page, box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

async function reloadChallenge(page, bframe, log) {
  const reload = await bframe.$('#recaptcha-reload-button, .rc-button-reload');
  if (!reload) return false;
  const box = await reload.boundingBox();
  if (!box) return false;
  log('챌린지 새로고침');
  await humanMouseClick(page, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(2000);
  return true;
}

/**
 * 한 번의 이미지 챌린지(타일 선택) 해결 시도
 * 4x4=16칸 기준: 대상(버스 등)이 걸친 칸을 모두 클릭 → 「다음」또는「확인」
 */
async function solveOneTileChallenge(page, bframe, apiKey, folder, log) {
  if (!apiKey) throw new Error('이미지 캡챠 해결용 OpenAI 키가 없습니다.');
  fs.mkdirSync(folder, { recursive: true });

  const meta = await readChallengeMeta(bframe);
  const target = extractTargetObject(meta.desc);
  log(`챌린지: "${target.ko}"(${target.en}) · ${meta.cols}x${meta.rows} = ${meta.tileCount}칸`);

  if (meta.tileCount < 9) {
    throw new Error(`타일 수를 읽지 못함 (${meta.tileCount})`);
  }

  const stamp = Date.now();
  const shot = path.join(folder, `recaptcha_tiles_${stamp}.png`);
  const annotated = path.join(folder, `recaptcha_tiles_${stamp}_num.png`);

  const table = await bframe.$('.rc-imageselect-target, table.rc-imageselect-table-44, table.rc-imageselect-table-33, .rc-imageselect-payload');
  if (table) {
    await table.screenshot({ path: shot }).catch(async () => {
      const body = await bframe.$('body');
      if (body) await body.screenshot({ path: shot });
      else await page.screenshot({ path: shot });
    });
  } else {
    const body = await bframe.$('body');
    if (body) await body.screenshot({ path: shot });
    else await page.screenshot({ path: shot });
  }

  let imagePath = shot;
  try {
    await annotateGridImage(page, shot, annotated, meta.cols || 4, meta.rows || 4);
    imagePath = annotated;
    log('번호 오버레이 완료');
  } catch (e) {
    log(`번호 오버레이 실패(원본 사용): ${e.message}`);
  }

  let result = await askOpenAIForTiles({
    apiKey,
    b64: fs.readFileSync(imagePath).toString('base64'),
    meta,
    target,
    log,
  });

  if (result.status === 'refuse') {
    log('Vision 거절 — 객체탐지 문구로 재시도');
    const altPrompt = `Photo mosaic ${meta.cols}x${meta.rows} cells numbered 1-${meta.tileCount} (yellow labels if present).
List every cell that shows any part of a ${target.en}.
Output only: numbers=7,11  or numbers=none`;
    const raw2 = await callVision(apiKey, altPrompt, fs.readFileSync(imagePath).toString('base64'));
    log(`Vision 재시도: ${raw2}`);
    result = parseTileNumbers(raw2, meta.tileCount);
  }

  // 전체 격자에서 못 찾으면 타일별은 비용·시간만 소모하고 같은 none이 나와서 생략
  // → 바로 수동 대기로 넘김
  const tiles = await getTileHandles(bframe);
  if (!tiles.length) throw new Error('클릭 가능한 타일 핸들 없음');
  if (tiles.length !== meta.tileCount) {
    log(`타일 핸들 ${tiles.length}개 / 예상 ${meta.tileCount}칸`);
  }

  if (result.status === 'refuse' || result.status === 'empty' || !result.numbers.length) {
    throw new Error('VISION_EMPTY');
  }

  log(`선택 타일(${result.numbers.length}개): ${result.numbers.join(', ')}`);
  for (const n of result.numbers) {
    const tile = tiles[n - 1];
    if (!tile) {
      log(`타일 ${n}번 핸들 없음 — 건너뜀`);
      continue;
    }
    const box = await tile.boundingBox();
    if (!box) continue;
    const selected = await tile.evaluate((el) => el.classList.contains('rc-imageselect-tileselected')).catch(() => false);
    if (selected) {
      log(`타일 ${n} 이미 선택됨`);
      continue;
    }
    log(`타일 ${n} 클릭`);
    await humanMouseClick(page, box.x + box.width / 2, box.y + box.height / 2);
    await sleep(rand(200, 450));
  }

  await sleep(rand(500, 900));

  // 선택 후 버튼이 「다음」또는「확인」으로 바뀌면 클릭
  let frame = findRecaptchaFrames(page).bframe || bframe;
  for (let w = 0; w < 12; w++) {
    const label = await frame?.$eval('#recaptcha-verify-button', (el) => (el.textContent || '').trim()).catch(() => '');
    if (isActionButtonLabel(label)) {
      await clickVerifyButton(page, frame, log);
      return 'auto';
    }
    await sleep(250);
    frame = findRecaptchaFrames(page).bframe || frame;
  }

  const clicked = await clickVerifyButton(page, findRecaptchaFrames(page).bframe || bframe, log);
  if (!clicked) throw new Error('타일은 선택했지만 확인/다음 버튼을 누르지 못함');
  return 'auto';
}

/**
 * Vision이 타일을 못 풀 때 — 사용자가 타일만 고르면 「다음/확인」은 자동 클릭
 */
async function waitForManualChallengeSolve(page, log, timeoutMs = 180000) {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const { isYesCaptchaOutOfCredit } = await import('./yescaptcha.js');
    if (isYesCaptchaOutOfCredit()) {
      log('🛑 YesCaptcha 잔액 없음 → 타일 자동 풀이 불가. 충전 후 재실행이 훨씬 빠릅니다.');
    }
  } catch { /* ignore */ }
  log('⚠ OpenAI Vision이 reCAPTCHA 타일을 자동으로 풀지 못합니다 (정책상 numbers=none).');
  log('👉 브라우저 창에서 파란 안내(자전거/신호등 등)에 맞는 타일을 직접 클릭하세요.');
  log('👉 타일을 고르면 「다음」/「확인」은 프로그램이 자동으로 누릅니다.');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const start = Date.now();
  let lastHint = 0;

  while (Date.now() - start < timeoutMs) {
    if (await isRecaptchaSolved(page)) {
      log('수동 선택으로 reCAPTCHA 통과');
      return true;
    }

    let { bframe } = findRecaptchaFrames(page);
    if (!bframe || !(await isChallengeVisible(bframe))) {
      await sleep(800);
      if (await isRecaptchaSolved(page)) return true;
      continue;
    }

    let meta = null;
    try {
      meta = await readChallengeMeta(bframe);
    } catch {
      await sleep(800);
      continue;
    }

    const target = extractTargetObject(meta.desc || '');
    if (Date.now() - lastHint > 12000) {
      const left = Math.max(0, Math.round((timeoutMs - (Date.now() - start)) / 1000));
      log(`대기 중… 「${target.ko}」 타일 선택 필요 · 선택됨 ${meta.selectedCount}칸 · 버튼「${meta.verifyLabel || '?'}」 · 남은 ${left}초`);
      lastHint = Date.now();
    }

    // 사용자가 1칸 이상 선택했고 버튼이 다음/확인이면 자동 클릭
    if (meta.selectedCount > 0 && isActionButtonLabel(meta.verifyLabel)) {
      log(`선택 ${meta.selectedCount}칸 감지 → 「${meta.verifyLabel}」 자동 클릭`);
      await clickVerifyButton(page, bframe, log).catch(() => {});
      await sleep(2200);
      continue;
    }

    await sleep(900);
  }

  return await isRecaptchaSolved(page);
}

/**
 * 이미지 챌린지: OpenAI는 타일 캡챠를 사실상 거부(numbers=none)하므로
 * 바로 수동 선택 모드로 전환. 「다음/확인」만 자동.
 */
async function solveImageChallengeLoop(page, apiKey, folder, sendLog, _maxChallengeRounds = 1) {
  const log = (m) => sendLog?.(m);

  if (await isRecaptchaSolved(page)) return true;

  let { bframe } = findRecaptchaFrames(page);
  for (let w = 0; w < 12 && !(await isChallengeVisible(bframe)); w++) {
    await sleep(400);
    ({ bframe } = findRecaptchaFrames(page));
  }

  if (!(await isChallengeVisible(bframe))) {
    log('이미지 챌린지 창 없음');
    return await isRecaptchaSolved(page);
  }

  // 자동 Vision 1회만 가볍게 시도 (성공하면 좋음, 실패해도 새로고침 안 함)
  if (apiKey) {
    try {
      log('타일 자동 인식 1회 시도...');
      await solveOneTileChallenge(page, bframe, apiKey, folder, log);
      await sleep(2000);
      if (await isRecaptchaSolved(page)) {
        log('타일 챌린지 자동 통과');
        return true;
      }
    } catch (e) {
      log(`자동 인식 스킵: ${e.message === 'VISION_EMPTY' ? 'Vision이 numbers=none 반환 (캡챠 정책)' : e.message}`);
    }
  }

  if (await isRecaptchaSolved(page)) return true;
  return waitForManualChallengeSolve(page, log, 180000);
}

/**
 * reCAPTCHA 통과 시도
 * 1) YesCaptcha 토큰 주입 (키 있을 때)
 * 2) 체크박스 클릭
 * 3) 타일 → 수동 보조
 */
export async function passRecaptchaHumanLike(page, {
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  folder = '',
  sendLog = null,
  maxRounds = 4,
  manualWaitMs = 180000,
} = {}) {
  const log = (m) => {
    const line = `[RECAPTCHA] ${m}`;
    sendLog?.(line);
    console.log(line);
  };

  log('reCAPTCHA iframe 대기...');
  await scrollRecaptchaIntoView(page);
  const anchorReady = await waitForRecaptchaAnchor(page, 30000);
  if (!anchorReady) {
    log('⚠ anchor iframe을 아직 못 찾음 — 계속 시도');
  } else {
    log('anchor iframe 준비됨');
  }

  // ── YesCaptcha 우선 ──
  const yesKey = String(yesCaptchaClientKey || '').trim();
  if (yesKey && /^sk-/i.test(yesKey)) {
    log('⚠ YesCaptcha 칸에 OpenAI 키(sk-…)가 들어가 있습니다. 설정에서 YesCaptcha Client Key를 다시 넣어 주세요.');
  } else if (yesKey) {
    try {
      const {
        solveRecaptchaV2YesCaptcha,
        extractRecaptchaSiteKey,
        injectRecaptchaToken,
        isYesCaptchaOutOfCredit,
      } = await import('./yescaptcha.js');
      if (isYesCaptchaOutOfCredit()) {
        log('⏭ YesCaptcha 잔액 없음 — 토큰 요청 생략 · 체크박스/수동 모드');
        log('👉 reCAPTCHA 타일 자동 통과는 YesCaptcha 충전이 필요합니다: https://yescaptcha.com');
      } else {
        const websiteURL = page.url();
        const websiteKey = await extractRecaptchaSiteKey(page);
        if (!websiteKey) {
          log('YesCaptcha: sitekey를 못 찾음 — 체크박스 방식으로 전환');
        } else {
          log(`YesCaptcha 요청… sitekey=${websiteKey.slice(0, 10)}…`);
          const token = await solveRecaptchaV2YesCaptcha({
            clientKey: yesKey,
            websiteURL,
            websiteKey,
            sendLog,
            timeoutMs: 180000,
          });
          const inj = await injectRecaptchaToken(page, token);
          log(`토큰 주입: ${inj?.via || 'ok'}`);
          await sleep(1500);
          if (await isRecaptchaSolved(page)) {
            log('YesCaptcha로 통과');
            return true;
          }
          // 체크박스 UI는 안 바뀌어도 textarea에 값이 있으면 통과로 간주
          const hasToken = await page.evaluate(() => {
            const ta = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
            return !!(ta && ta.value && ta.value.length > 40);
          }).catch(() => false);
          if (hasToken) {
            log('YesCaptcha 토큰 주입 완료 (응답 필드 확인)');
            return true;
          }
          log('YesCaptcha 토큰 주입 후 미확인 — 체크박스 방식으로 보조');
        }
      }
    } catch (e) {
      log(`YesCaptcha 실패: ${e.message} — 체크박스 방식으로 전환`);
    }
  } else {
    log('YesCaptcha 키 없음 — 수동/체크박스 모드');
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (await isRecaptchaSolved(page)) {
      log('이미 통과됨');
      return true;
    }

    let { bframe } = findRecaptchaFrames(page);
    const challengeOpen = await isChallengeVisible(bframe);

    if (!challengeOpen) {
      log(`「로봇이 아닙니다」 체크 시도 ${round}/${maxRounds}`);
      try {
        await clickRecaptchaCheckbox(page, log);
      } catch (e) {
        log(`체크박스 클릭 실패: ${e.message}`);
      }
      await sleep(2000);
    }

    if (await isRecaptchaSolved(page)) {
      log('체크박스 통과 (초록 체크)');
      return true;
    }

    ({ bframe } = findRecaptchaFrames(page));
    for (let w = 0; w < 20 && !(await isChallengeVisible(bframe)); w++) {
      await sleep(300);
      ({ bframe } = findRecaptchaFrames(page));
    }

    if (await isChallengeVisible(bframe)) {
      log('타일 선택 캡챠 감지');
      const ok = await solveImageChallengeLoop(
        page,
        openaiApiKey,
        folder || path.join(process.cwd(), 'output', 'recaptcha'),
        log,
        1,
      );
      if (ok) return true;
    } else {
      log('체크 후 통과/챌린지 없음 — 재시도');
    }

    await sleep(1000);
  }

  if (await isRecaptchaSolved(page)) {
    log('통과 확인');
    return true;
  }

  if (manualWaitMs > 0) {
    log(`자동 실패 — ${Math.round(manualWaitMs / 1000)}초 동안 브라우저에서 직접 해결해 주세요`);
    await scrollRecaptchaIntoView(page);
    const start = Date.now();
    while (Date.now() - start < manualWaitMs) {
      if (await isRecaptchaSolved(page)) {
        log('수동으로 통과 확인');
        return true;
      }
      const { bframe } = findRecaptchaFrames(page);
      if (await isChallengeVisible(bframe)) {
        const ok = await waitForManualChallengeSolve(page, log, Math.max(5000, manualWaitMs - (Date.now() - start)));
        if (ok) return true;
        break;
      }
      await sleep(1500);
    }
  }

  log('reCAPTCHA 통과 실패');
  return false;
}
