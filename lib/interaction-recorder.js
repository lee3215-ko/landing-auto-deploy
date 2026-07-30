import fs from 'fs';
import path from 'path';

export const RECORDER_INJECT = () => {
  if (window.__recorderInstalled) return;
  window.__recorderInstalled = true;
  window.__interactionLog = [];
  const t0 = Date.now();

  const push = (type, data) => {
    window.__interactionLog.push({
      ts: Date.now() - t0,
      type,
      url: location.href,
      ...data,
    });
  };

  const cssPath = (el) => {
    if (!el || el === document.documentElement) return 'html';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  };

  const isPasswordEl = (el) => {
    if (!el) return false;
    if (el.type === 'password') return true;
    const id = (el.id || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    return id.includes('password') || name.includes('password') || name === 'pw';
  };

  document.addEventListener('click', (e) => {
    push('click', {
      sel: cssPath(e.target),
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      screenX: Math.round(e.screenX),
      screenY: Math.round(e.screenY),
      trusted: e.isTrusted,
      tag: e.target?.tagName,
    });
  }, true);

  document.addEventListener('keydown', (e) => {
    const pw = isPasswordEl(e.target);
    push('keydown', {
      sel: cssPath(e.target),
      key: pw ? '*' : e.key,
      code: e.code,
      trusted: e.isTrusted,
    });
  }, true);

  document.addEventListener('input', (e) => {
    const t = e.target;
    push('input', {
      sel: cssPath(t),
      len: (t?.value || '').length,
      field: isPasswordEl(t) ? 'password' : ((t?.type === 'email' || /email/i.test(t?.name || '')) ? 'email' : 'text'),
      trusted: e.isTrusted,
    });
  }, true);

  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < 180) return;
    lastMove = now;
    push('mousemove', { x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, true);

  push('recorder_start', { title: document.title });
};

export function getRecordingPath(outputRoot, flow) {
  return path.join(outputRoot, 'recordings', `netlify-${flow}.jsonl`);
}

export function loadRecording(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export async function attachRecorderToPage(page) {
  await page.evaluateOnNewDocument(RECORDER_INJECT);
  try {
    await page.evaluate(RECORDER_INJECT);
  } catch { /* about:blank */ }
}

export async function startInteractionRecording(browser, filePath, sendLog = null) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');

  const log = (msg) => sendLog?.(`[RECORD] ${msg}`);

  const pages = await browser.pages();
  for (const p of pages) await attachRecorderToPage(p);

  browser.on('targetcreated', async (target) => {
    try {
      if (target.type() !== 'page') return;
      const p = await target.page();
      if (p) await attachRecorderToPage(p);
    } catch { /* ignore */ }
  });

  let total = 0;
  const poll = async () => {
    for (const p of await browser.pages()) {
      try {
        const batch = await p.evaluate(() => {
          const out = window.__interactionLog || [];
          window.__interactionLog = [];
          return out;
        });
        if (!batch.length) continue;
        fs.appendFileSync(filePath, `${batch.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
        total += batch.length;
      } catch { /* closed page */ }
    }
    if (total > 0 && total % 20 === 0) log(`이벤트 ${total}개 저장됨`);
  };

  const interval = setInterval(poll, 400);
  log(`기록 파일: ${filePath}`);

  return {
    async stop() {
      clearInterval(interval);
      await poll();
      log(`기록 완료 — 총 ${total}개 이벤트`);
      return total;
    },
    get count() {
      return total;
    },
  };
}
