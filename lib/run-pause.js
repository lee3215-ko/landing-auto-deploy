function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let paused = false;
let stopRequested = false;

export function resetRunControl() {
  paused = false;
  stopRequested = false;
}

export function requestRunPause() {
  paused = true;
}

export function requestRunResume() {
  paused = false;
}

export function requestRunStop() {
  stopRequested = true;
  paused = false;
}

export function isRunPaused() {
  return paused && !stopRequested;
}

export function isRunStopped() {
  return stopRequested;
}

export class RunStopped extends Error {
  constructor() {
    super('사용자가 배포를 정지했습니다.');
    this.name = 'RunStopped';
  }
}

/** 일시정지 중이면 재개될 때까지 대기. 정지 요청 시 예외 */
export async function waitWhilePaused(sendLog = null) {
  if (!isRunPaused()) return;
  const log = (msg) => { if (sendLog) sendLog(msg); };
  log('⏸ [RUN_PAUSED] 일시정지 — 「재개」를 누르면 이어집니다.');
  while (isRunPaused()) {
    await sleep(400);
  }
  if (isRunStopped()) throw new RunStopped();
  log('▶ [RUN_RESUMED] 재개');
}

export async function checkpoint(sendLog = null) {
  await waitWhilePaused(sendLog);
  if (isRunStopped()) throw new RunStopped();
}
