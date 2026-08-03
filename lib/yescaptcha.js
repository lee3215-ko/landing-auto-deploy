/**
 * YesCaptcha — reCAPTCHA v2 + ImageToText(이미지 캡챠)
 * Docs: NoCaptchaTaskProxyless / ImageToTextTask
 */

const API_NODES = [
  'https://api.yescaptcha.com',
  'https://cn.yescaptcha.com',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return data;
}

/**
 * @returns {Promise<string>} gRecaptchaResponse token
 */
export async function solveRecaptchaV2YesCaptcha({
  clientKey,
  websiteURL,
  websiteKey,
  sendLog = null,
  timeoutMs = 180000,
  taskType = 'NoCaptchaTaskProxyless',
} = {}) {
  const log = (m) => {
    const line = `[YESCAPTCHA] ${m}`;
    sendLog?.(line);
    console.log(line);
  };

  if (!clientKey) throw new Error('YesCaptcha 클라이언트 키가 없습니다.');
  if (!websiteURL) throw new Error('websiteURL이 없습니다.');
  if (!websiteKey) throw new Error('reCAPTCHA sitekey를 찾지 못했습니다.');

  let lastErr = '';
  let taskId = '';
  let apiBase = API_NODES[0];

  for (const base of API_NODES) {
    log(`createTask (${taskType}) @ ${base.replace('https://', '')}`);
    const created = await postJson(`${base}/createTask`, {
      clientKey,
      task: {
        type: taskType,
        websiteURL,
        websiteKey,
      },
    });
    if (created.errorId) {
      lastErr = created.errorDescription || created.errorCode || JSON.stringify(created);
      log(`createTask 실패: ${lastErr}`);
      continue;
    }
    if (!created.taskId) {
      lastErr = 'taskId 없음';
      continue;
    }
    taskId = created.taskId;
    apiBase = base;
    log(`taskId: ${taskId}`);
    break;
  }

  if (!taskId) {
    // 다른 타입으로 한 번 더
    const altType = taskType === 'NoCaptchaTaskProxyless'
      ? 'RecaptchaV2TaskProxyless'
      : 'NoCaptchaTaskProxyless';
    for (const base of API_NODES) {
      log(`createTask 재시도 (${altType})`);
      const created = await postJson(`${base}/createTask`, {
        clientKey,
        task: {
          type: altType,
          websiteURL,
          websiteKey,
        },
      });
      if (!created.errorId && created.taskId) {
        taskId = created.taskId;
        apiBase = base;
        log(`taskId: ${taskId}`);
        break;
      }
      lastErr = created.errorDescription || created.errorCode || lastErr;
    }
  }

  if (!taskId) throw new Error(`YesCaptcha createTask 실패: ${lastErr || 'unknown'}`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    const result = await postJson(`${apiBase}/getTaskResult`, {
      clientKey,
      taskId,
    });

    if (result.errorId) {
      throw new Error(result.errorDescription || result.errorCode || 'getTaskResult 오류');
    }

    if (result.status === 'processing') {
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 9 < 3) log(`처리 중… (${elapsed}s)`);
      continue;
    }

    if (result.status === 'ready') {
      const token = result.solution?.gRecaptchaResponse || '';
      if (!token) throw new Error('solution.gRecaptchaResponse 비어 있음');
      log(`토큰 수신 (${token.slice(0, 24)}…)`);
      return token;
    }

    lastErr = `알 수 없는 status: ${result.status}`;
  }

  throw new Error(`YesCaptcha 시간 초과: ${lastErr || 'timeout'}`);
}

/**
 * 이미지 캡챠(네이버 NHN 등) → 텍스트
 * @returns {Promise<string>} 인식된 코드
 */
export async function solveImageToTextYesCaptcha({
  clientKey,
  bodyBase64,
  sendLog = null,
  caseSensitive = true,
  minLength = 4,
  maxLength = 8,
  timeoutMs = 90000,
} = {}) {
  const log = (m) => {
    const line = `[YESCAPTCHA-IMG] ${m}`;
    sendLog?.(line);
    console.log(line);
  };

  if (!clientKey) throw new Error('YesCaptcha 클라이언트 키가 없습니다.');
  const body = String(bodyBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!body || body.length < 80) throw new Error('캡챠 이미지 body가 비어 있습니다.');

  let lastErr = '';
  let taskId = '';
  let apiBase = API_NODES[0];

  for (const base of API_NODES) {
    log(`createTask ImageToTextTask @ ${base.replace('https://', '')}`);
    const created = await postJson(`${base}/createTask`, {
      clientKey,
      task: {
        type: 'ImageToTextTask',
        body,
        phrase: false,
        case: !!caseSensitive,
        numeric: 0,
        math: false,
        minLength,
        maxLength,
      },
    });
    if (created.errorId) {
      lastErr = created.errorDescription || created.errorCode || JSON.stringify(created);
      log(`createTask 실패: ${lastErr}`);
      continue;
    }
    if (!created.taskId) {
      lastErr = 'taskId 없음';
      continue;
    }
    taskId = created.taskId;
    apiBase = base;
    log(`taskId: ${taskId}`);
    break;
  }

  if (!taskId) throw new Error(`YesCaptcha ImageToText 실패: ${lastErr || 'unknown'}`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    const result = await postJson(`${apiBase}/getTaskResult`, { clientKey, taskId });
    if (result.errorId) {
      throw new Error(result.errorDescription || result.errorCode || 'getTaskResult 오류');
    }
    if (result.status === 'processing') {
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 8 < 2) log(`처리 중… (${elapsed}s)`);
      continue;
    }
    if (result.status === 'ready') {
      const text = String(result.solution?.text || '').trim();
      if (!text) throw new Error('solution.text 비어 있음');
      log(`인식: "${text}"`);
      return text;
    }
    lastErr = `알 수 없는 status: ${result.status}`;
  }
  throw new Error(`YesCaptcha ImageToText 시간 초과: ${lastErr || 'timeout'}`);
}

export async function extractRecaptchaSiteKey(page) {
  return page.evaluate(() => {
    const byAttr = document.querySelector('[data-sitekey]');
    if (byAttr?.getAttribute('data-sitekey')) return byAttr.getAttribute('data-sitekey');

    for (const iframe of document.querySelectorAll('iframe[src*="recaptcha"]')) {
      try {
        const u = new URL(iframe.src);
        const k = u.searchParams.get('k');
        if (k) return k;
      } catch { /* ignore */ }
      const m = (iframe.src || '').match(/[?&]k=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }

    // grecaptcha cfg
    try {
      const cfg = window.___grecaptcha_cfg;
      if (cfg?.clients) {
        const dump = JSON.stringify(cfg.clients);
        const m = dump.match(/"sitekey"\s*:\s*"([^"]+)"/i)
          || dump.match(/sitekey["']?\s*[:=]\s*["']([^"']+)/i);
        if (m) return m[1];
      }
    } catch { /* ignore */ }

    return '';
  }).catch(() => '');
}

/**
 * 발급받은 토큰을 페이지에 주입 + 콜백 호출
 */
export async function injectRecaptchaToken(page, token) {
  return page.evaluate((tok) => {
    const areas = [
      ...document.querySelectorAll('#g-recaptcha-response'),
      ...document.querySelectorAll('textarea[name="g-recaptcha-response"]'),
    ];
    for (const ta of areas) {
      ta.value = tok;
      ta.innerHTML = tok;
      ta.style.display = 'block';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // data-callback
    const widget = document.querySelector('.g-recaptcha, [data-sitekey]');
    const cbName = widget?.getAttribute('data-callback');
    if (cbName && typeof window[cbName] === 'function') {
      try { window[cbName](tok); return { ok: true, via: 'data-callback' }; } catch { /* ignore */ }
    }

    // ___grecaptcha_cfg 콜백 탐색
    try {
      const cfg = window.___grecaptcha_cfg;
      const clients = cfg?.clients || {};
      for (const client of Object.values(clients)) {
        const walk = (obj, depth = 0) => {
          if (!obj || depth > 6) return false;
          if (typeof obj === 'function' && obj.toString().includes('callback') === false) {
            // try calling functions that look like success callbacks — too risky
          }
          if (typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
              if ((k === 'callback' || k === 'promise-callback') && typeof v === 'function') {
                try { v(tok); return true; } catch { /* ignore */ }
              }
              if (walk(v, depth + 1)) return true;
            }
          }
          return false;
        };
        if (walk(client)) return { ok: true, via: 'grecaptcha_cfg' };
      }
    } catch { /* ignore */ }

    return { ok: areas.length > 0, via: 'textarea' };
  }, token);
}
