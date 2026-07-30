import fs from 'fs';
import { humanFillInput } from './human-browser.js';
import { getRecordingPath, loadRecording } from './interaction-recorder.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function hasRecording(outputRoot, flow) {
  const p = getRecordingPath(outputRoot, flow);
  return fs.existsSync(p) && fs.statSync(p).size > 50;
}

export async function replayInteractionRecording(page, filePath, { email = '', password = '' } = {}, sendLog = null, options = {}) {
  const log = (msg) => sendLog?.(`[REPLAY] ${msg}`);
  let events = loadRecording(filePath);
  if (!events.length) throw new Error('재생할 기록이 비어 있습니다.');

  if (options.urlFilter) {
    const before = events.length;
    events = events.filter((e) => !e.url || options.urlFilter(e.url));
    log(`URL 필터: ${before} → ${events.length}개 이벤트`);
  }

  if (!events.length) throw new Error('필터 후 재생할 이벤트가 없습니다.');

  log(`패턴 재생 시작 (${events.length}개 이벤트)`);

  const filled = { email: false, password: false };
  let lastTs = 0;

  for (const ev of events) {
    const gap = ev.ts - lastTs;
    if (gap > 0 && gap < 20000) await sleep(gap);
    lastTs = ev.ts;

    if (ev.type === 'mousemove') {
      await page.mouse.move(ev.x, ev.y, { steps: 2 }).catch(() => {});
      continue;
    }

    if (ev.type === 'click') {
      if (ev.trusted === false) log(`참고: 기록된 클릭 trusted=false (${ev.sel})`);
      await page.mouse.move(ev.x, ev.y, { steps: 8 }).catch(() => {});
      await sleep(80);
      await page.mouse.click(ev.x, ev.y).catch(() => {});
      continue;
    }

    if (ev.type === 'input') {
      if (ev.field === 'email' && email && !filled.email) {
        const sels = [ev.sel, 'input#email', 'input[name="email"]', 'input[type="email"]'].filter(Boolean);
        if (await humanFillInput(page, sels, email)) {
          filled.email = true;
          log(`이메일 입력 (${ev.sel})`);
        }
      } else if (ev.field === 'password' && password && !filled.password) {
        const sels = [ev.sel, 'input#password', 'input[name="password"]', 'input[type="password"]'].filter(Boolean);
        if (await humanFillInput(page, sels, password)) {
          filled.password = true;
          log(`비밀번호 입력 (${ev.sel})`);
        }
      }
      continue;
    }

    if (ev.type === 'keydown' && ev.key && ev.key.length === 1 && ev.key !== '*') {
      await page.keyboard.press(ev.key).catch(() => {});
    }
  }

  log(`재생 완료 (email=${filled.email}, password=${filled.password})`);
  return filled;
}

export async function replayNetlifyFlow(page, outputRoot, flow, credentials, sendLog) {
  const filePath = getRecordingPath(outputRoot, flow);
  if (!hasRecording(outputRoot, flow)) return false;
  await replayInteractionRecording(
    page,
    filePath,
    credentials,
    sendLog,
    { urlFilter: (url) => /app\.netlify\.com/i.test(url) },
  );
  return true;
}
