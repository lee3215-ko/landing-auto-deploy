import path from 'path';
import {
  launchChromeStandalone,
  connectChromeForAutomation,
  getOrCreatePage,
  disconnectBrowser,
  DEFAULT_DEBUG_PORT,
} from './chrome-connect.js';
import { startInteractionRecording, getRecordingPath } from './interaction-recorder.js';

const SIGNUP_URL = 'https://app.netlify.com/signup';
const LOGIN_URL = 'https://app.netlify.com/login';

/** @type {{ browser: import('puppeteer').Browser, recorder: { stop: () => Promise<number> }, recordPath: string } | null} */
let activeRecording = null;

export async function startNetlifyRecording({
  mode = 'signup',
  outputRoot = './output',
  sendLog = null,
} = {}) {
  if (activeRecording) throw new Error('이미 기록 중입니다. [기록 완료]를 먼저 누르세요.');

  const flow = mode === 'login' ? 'login' : 'signup';
  const startUrl = mode === 'login' ? LOGIN_URL : SIGNUP_URL;
  const chromeProfile = path.join(outputRoot, 'chrome-netlify-profile');
  const recordPath = getRecordingPath(outputRoot, flow);

  const log = (msg) => {
    const line = `[RECORD] ${msg}`;
    if (sendLog) sendLog(line);
    console.log(line);
  };

  log(`═══ Netlify ${flow} 동작 기록 시작 ═══`);
  log('Chrome에서 직접 가입/로그인하세요. 클릭·키보드·마우스가 기록됩니다.');

  await launchChromeStandalone({
    userDataDir: chromeProfile,
    port: DEFAULT_DEBUG_PORT,
    startUrl,
    sendLog: (m) => log(m),
  });

  const browser = await connectChromeForAutomation({
    port: DEFAULT_DEBUG_PORT,
    sendLog: (m) => log(m),
  });

  const page = await getOrCreatePage(browser);
  if (!page.url().includes('netlify.com')) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  const recorder = await startInteractionRecording(browser, recordPath, sendLog);
  activeRecording = { browser, recorder, recordPath, flow };

  log('기록 중... 완료 후 앱의 [기록 완료] 버튼을 누르세요.');
  return { recordPath, flow, started: true };
}

export async function stopNetlifyRecording(sendLog = null) {
  if (!activeRecording) throw new Error('진행 중인 기록이 없습니다.');

  const log = (msg) => {
    const line = `[RECORD] ${msg}`;
    if (sendLog) sendLog(line);
    console.log(line);
  };

  const { browser, recorder, recordPath, flow } = activeRecording;
  const count = await recorder.stop();
  await disconnectBrowser(browser);
  activeRecording = null;

  log(`저장 완료: ${recordPath} (${count}개 이벤트)`);
  return { recordPath, eventCount: count, flow };
}

export function isRecordingActive() {
  return !!activeRecording;
}
