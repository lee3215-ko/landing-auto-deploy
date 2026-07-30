let stopRequested = false;

export function resetTokenGenStop() {
  stopRequested = false;
}

export function requestTokenGenStop() {
  stopRequested = true;
}

export function shouldStopTokenGen() {
  return stopRequested;
}

export class TokenGenStopped extends Error {
  constructor(tokens = []) {
    super('사용자가 정지했습니다.');
    this.name = 'TokenGenStopped';
    this.tokens = tokens;
  }
}
