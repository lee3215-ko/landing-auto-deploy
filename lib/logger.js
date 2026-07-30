import fs from 'fs';
import path from 'path';

let activeLogger = null;

export function setLogger(logger) {
  activeLogger = logger;
}

export function createFileLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const startTime = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `run-${startTime}.log`);

  const lines = [];
  const log = (msg) => {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    lines.push(line);
    console.log(line);
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch {}
  };

  log.info = log;
  log.step = (msg) => log(`[STEP] ${msg}`);
  log.action = (msg) => log(`[ACTION] ${msg}`);
  log.error = (msg) => log(`[ERROR] ${msg}`);
  log.warn = (msg) => log(`[WARN] ${msg}`);
  log.api = (msg) => log(`[API] ${msg}`);
  log.ui = (msg) => log(`[UI] ${msg}`);
  log.getLogFile = () => logFile;
  log.getLines = () => lines;

  return log;
}

export function log(msg, level = 'info') {
  if (activeLogger) {
    const fn = activeLogger[level] || activeLogger.info || activeLogger;
    fn(msg);
  } else {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
  }
}

export function step(msg) { log(msg, 'step'); }
export function action(msg) { log(msg, 'action'); }
export function error(msg) { log(msg, 'error'); }
export function warn(msg) { log(msg, 'warn'); }
export function api(msg) { log(msg, 'api'); }
export function ui(msg) { log(msg, 'ui'); }
