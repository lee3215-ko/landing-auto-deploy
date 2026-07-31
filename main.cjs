const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// GPU 플래그는 app ready 전에만 설정. (portable 재실행과 별개로, 드라이버 크래시 완화)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

// 단일 인스턴스 — 더블클릭/바로가기 중복으로 두 번 뜨는 현상 방지
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 이미 실행 중이면 즉시 종료 (이후 코드 실행 방지)
  app.exit(0);
  process.exit(0);
}

app.setAppUserModelId('com.landing.auto-deploy');

// 개발 환경(소스 폰더)에서는 프로그램 폰더에 저장, 패키징(EXE) 환경에서는 userData에 저장
const isPackaged = app.isPackaged;
const DEFAULT_DATA_FOLDER = isPackaged ? path.join(app.getPath('userData'), 'data') : __dirname;
const CONFIG_PATH = path.join(DEFAULT_DATA_FOLDER, 'config.json');
const RESULTS_PATH = path.join(DEFAULT_DATA_FOLDER, 'output', 'results.json');
const GENERATED_TOKENS_PATH = path.join(DEFAULT_DATA_FOLDER, 'output', 'generated-tokens.json');
const CREATED_SITES_PATH = path.join(DEFAULT_DATA_FOLDER, 'output', 'created-sites.json');
const OUTPUT_ROOT = path.join(DEFAULT_DATA_FOLDER, 'output');

// KKang 엔진: 배포 기본 키워드는 엔진 data/, 이용자 추가분은 userData 에 저장
const KKANG_USER_DATA = path.join(app.getPath('userData'), 'kkang-data');
try {
  fs.mkdirSync(KKANG_USER_DATA, { recursive: true });
} catch { /* ignore */ }
process.env.KKANG_DATA_DIR = KKANG_USER_DATA;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      openaiApiKey: '',
      yesCaptchaClientKey: '',
      netlifyTokens: [],
      naverAccounts: [],
      services: [],
      seoOptions: {
        metaTitles: [],
        metaDescriptions: [],
        metaKeywords: [],
        generateSitemap: true,
        generateRobots: true,
      },
      deployFolder: '',
      deploySources: [],
      netlifyGenAccounts: [],
      urlCrawlNaver: { id: '', pw: '' },
      cursorApiKey: '',
      kkangBuilderPath: '',
      kkangOutputDir: '',
      kkangNetlifyToken: '',
      kkangNetlifyId: '',
      cloudflare: {
        accountId: '',
        apiToken: '',
        projectName: '',
        brand: '',
        phone: '',
        naver: '',
        outputDir: '',
        keywords: '',
        notes: '',
        deploy: true,
        createProject: true,
        sites: [],
      },
      dothome: {
        hostId: '',
        hostPw: 'dlwkdrns12435!',
        emailLocal: '',
        ftpHost: '',
        keyword: '',
        externalUrl: '',
        phone: '010-6338-7124',
        imageDir: '',
        googleVerifyFile: '',
        usedIds: [],
        usedFtpIds: [],
        accounts: [],
      },
    };
  }
}

function pickNaverAccountForDothome(config, options = {}) {
  if (options.naverAccount?.id && options.naverAccount?.pw) {
    return {
      id: String(options.naverAccount.id).trim(),
      pw: String(options.naverAccount.pw).trim(),
    };
  }
  const accounts = Array.isArray(config.naverAccounts) ? config.naverAccounts : [];
  const emailLocal = String(options.emailLocal || config.dothome?.emailLocal || '').trim().replace(/@.*$/, '');
  if (emailLocal) {
    const matched = accounts.find((a) => String(a.id || '').trim() === emailLocal);
    if (matched?.id && matched?.pw) return { id: matched.id.trim(), pw: matched.pw.trim() };
  }
  const first = accounts.find((a) => a?.id && a?.pw);
  return first ? { id: String(first.id).trim(), pw: String(first.pw).trim() } : null;
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveResults(results) {
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), 'utf8');
}

function loadGeneratedTokens() {
  try {
    return JSON.parse(fs.readFileSync(GENERATED_TOKENS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveGeneratedTokens(tokens) {
  fs.mkdirSync(path.dirname(GENERATED_TOKENS_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

async function loadCreatedSites({ sync = true } = {}) {
  const {
    loadSitesRegistry,
    saveSitesRegistry,
    mergeLegacySources,
    enrichSitesFromLocal,
  } = await import('./lib/sites-registry.js');
  const current = loadSitesRegistry(CREATED_SITES_PATH);
  if (!sync) {
    return enrichSitesFromLocal(current, { kkangOutputRoot: path.join(OUTPUT_ROOT, 'kkang-sites') });
  }
  const config = loadConfig();
  const merged = mergeLegacySources(current, {
    results: loadResults(),
    dothomeAccounts: config.dothome?.accounts || [],
    cloudflareSites: config.cloudflare?.sites || [],
  });
  const enriched = enrichSitesFromLocal(merged, {
    kkangOutputRoot: path.join(OUTPUT_ROOT, 'kkang-sites'),
  });
  return saveSitesRegistry(CREATED_SITES_PATH, enriched);
}

async function upsertCreatedSite(entry) {
  const { loadSitesRegistry, saveSitesRegistry, upsertSite } = await import('./lib/sites-registry.js');
  const sites = upsertSite(loadSitesRegistry(CREATED_SITES_PATH), entry);
  return saveSitesRegistry(CREATED_SITES_PATH, sites);
}

let mainWindow = null;
let appReady = false;

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: true,
    backgroundColor: '#0b0f1a',
    title: 'Landing Auto Deploy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone', details);
    // 렌더러 크래시 시 한 번만 복구 (무한 재시작 방지)
    if (details?.reason === 'crashed' || details?.reason === 'oom') {
      try { mainWindow?.webContents?.reload(); } catch { /* ignore */ }
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return mainWindow;
}

function focusMainWindow() {
  if (!appReady) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  try { mainWindow.webContents?.focus(); } catch { /* ignore */ }
}

ipcMain.handle('focus-main-window', async () => {
  focusMainWindow();
  return { ok: true };
});

/** VPN 등 OS 전역 단축키 테스트 전송 */
ipcMain.handle('send-hotkey', async (_event, hotkey = {}) => {
  const key = String(hotkey.key || '').trim().toLowerCase().slice(0, 1);
  if (!key || !/^[a-z0-9]$/i.test(key)) {
    return { ok: false, error: '유효한 키(a-z, 0-9)를 입력하세요.' };
  }
  if (!hotkey.alt && !hotkey.ctrl && !hotkey.shift) {
    return { ok: false, error: 'Alt/Ctrl/Shift 중 하나 이상 필요합니다.' };
  }
  // SendKeys: ^ Ctrl, % Alt, + Shift
  let seq = '';
  if (hotkey.ctrl) seq += '^';
  if (hotkey.alt) seq += '%';
  if (hotkey.shift) seq += '+';
  seq += key;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('${seq.replace(/'/g, "''")}')
`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
      timeout: 10000,
    });
    return { ok: true, seq };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

app.on('second-instance', () => {
  focusMainWindow();
});

app.whenReady().then(() => {
  appReady = true;
  createWindow();
  // 패키지 실행 시 시작 후 자동 업데이트 확인 (네이버 신고 앱과 동일 패턴)
  if (app.isPackaged) {
    setTimeout(() => {
      import('./lib/app-updater.js')
        .then(({ runStartupUpdateCheck }) => runStartupUpdateCheck(mainWindow))
        .catch((e) => console.error('[updater] load failed', e));
    }, 2500);
  }
  // 네이버 세션: 프로필 경로만 준비 (자동 로그인 안 함 — 우측 상단 버튼으로 시작)
  setTimeout(() => { initNaverSessionListeners().catch(() => {}); }, 800);
});

function broadcastNaverSession(data) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('naver-session-update', data);
    }
  } catch { /* ignore */ }
}

async function initNaverSessionListeners() {
  const { onNaverSessionStatus, getNaverSessionStatus, setNaverSessionProfileDir } = await import('./lib/naver-session.js');
  const profileDir = path.join(app.getPath('userData'), 'chrome-naver-session');
  setNaverSessionProfileDir(profileDir);
  onNaverSessionStatus((snap) => broadcastNaverSession(snap));
  broadcastNaverSession(getNaverSessionStatus());
}

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('clipboard-write', (_event, text) => {
  const value = text == null ? '' : String(text);
  clipboard.writeText(value);
  return { ok: true, length: value.length };
});

ipcMain.handle('naver-session-status', async () => {
  const { getNaverSessionStatus } = await import('./lib/naver-session.js');
  return getNaverSessionStatus();
});

ipcMain.handle('naver-session-start', async (event, options = {}) => {
  const config = loadConfig();
  const preferredId = String(options.naverAccountId || '').trim();
  const acct = preferredId
    ? (config.naverAccounts || []).find((a) => a.id === preferredId)
    : (config.naverAccounts || []).find((a) => a?.id && a?.pw);
  if (!acct?.id || !acct?.pw) return { ok: false, error: '설정에 네이버 계정이 없습니다.' };
  const { ensureNaverSession, getNaverSessionStatus, onNaverSessionStatus, setNaverSessionProfileDir } = await import('./lib/naver-session.js');
  onNaverSessionStatus((snap) => broadcastNaverSession(snap));
  const profileDir = path.join(app.getPath('userData'), 'chrome-naver-session');
  setNaverSessionProfileDir(profileDir);
  try {
    await ensureNaverSession({
      naverAccount: acct,
      openaiApiKey: config.openaiApiKey || '',
      headless: false,
      forceRelogin: !!options.forceRelogin,
      userDataDir: profileDir,
      outputFolder: path.join(OUTPUT_ROOT, 'naver-session'),
      onLog: (msg) => event.sender.send('log-line', `[네이버세션] ${msg}`),
    });
    return { ok: true, ...getNaverSessionStatus() };
  } catch (e) {
    return { ok: false, error: e.message, ...getNaverSessionStatus() };
  }
});

ipcMain.handle('naver-session-refresh-sites', async () => {
  const {
    countAdvisorRegisteredSites,
    getNaverSessionStatus,
    getNaverSessionPage,
  } = await import('./lib/naver-session.js');
  let p = await getNaverSessionPage();
  if (!p) {
    return { ok: false, error: '네이버 로그인이 필요합니다. 먼저 「네이버 로그인」을 완료하세요.', ...getNaverSessionStatus() };
  }
  try {
    const n = await countAdvisorRegisteredSites(p);
    return { ok: true, siteCount: n, ...getNaverSessionStatus() };
  } catch (e) {
    return { ok: false, error: e.message || '조회 실패', ...getNaverSessionStatus() };
  }
});

app.on('before-quit', () => {
  import('./lib/naver-session.js').then(({ closeNaverSession }) => closeNaverSession()).catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!appReady) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC handlers
ipcMain.handle('load-config', () => loadConfig());
ipcMain.handle('save-config', (_, config) => { saveConfig(config); return true; });
ipcMain.handle('load-results', () => loadResults());
ipcMain.handle('save-results', (_, results) => { saveResults(results); return true; });
ipcMain.handle('load-created-sites', async (_, options = {}) => loadCreatedSites(options || {}));
ipcMain.handle('save-created-sites', async (_, sites) => {
  const { saveSitesRegistry } = await import('./lib/sites-registry.js');
  return saveSitesRegistry(CREATED_SITES_PATH, sites || []);
});
ipcMain.handle('upsert-created-site', async (_, entry) => upsertCreatedSite(entry));
ipcMain.handle('delete-created-site', async (_, id) => {
  const { loadSitesRegistry, saveSitesRegistry, removeSite } = await import('./lib/sites-registry.js');
  const sites = removeSite(loadSitesRegistry(CREATED_SITES_PATH), id);
  return saveSitesRegistry(CREATED_SITES_PATH, sites);
});
ipcMain.handle('sync-created-sites', async () => loadCreatedSites({ sync: true }));
ipcMain.handle('load-generated-tokens', () => loadGeneratedTokens());
ipcMain.handle('save-generated-tokens', (_, tokens) => { saveGeneratedTokens(tokens); return true; });

ipcMain.handle('select-output-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.filePaths[0] || '';
});
ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.filePaths[0] || '';
});
ipcMain.handle('list-folder-files', async (_, folder) => {
  try {
    return fs.readdirSync(folder);
  } catch (e) {
    return [];
  }
});
ipcMain.handle('get-file-stat', async (_, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size };
  } catch (e) {
    return null;
  }
});
ipcMain.handle('select-file', async (_, filters) => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: filters || [{ name: '텍스트 파일', extensions: ['txt'] }, { name: '모든 파일', extensions: ['*'] }]
  });
  return res.filePaths[0] || '';
});
ipcMain.handle('select-files', async (_, options = {}) => {
  const filters = options.filters || [
    { name: 'ZIP 파일', extensions: ['zip'] },
    { name: '모든 파일', extensions: ['*'] },
  ];
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters,
    title: options.title || '파일 선택',
  });
  return res.canceled ? [] : (res.filePaths || []);
});
ipcMain.handle('read-text-file', async (_, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
});

ipcMain.handle('start-run', async (event, config) => {
  saveConfig(config);
  const { resetRunControl } = await import('./lib/run-pause.js');
  resetRunControl();
  const { runFullPipeline } = await import('./lib/runner.js');
  try {
    const result = await runFullPipeline({ ...config, outputRoot: OUTPUT_ROOT }, (line) => {
      event.sender.send('log-line', line);
    });
    event.sender.send('log-line', `\n[LOG FILE] ${result.logFile || '없음'}`);
    return result;
  } catch (e) {
    event.sender.send('log-line', `[ERROR] ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('pause-run', async () => {
  const { requestRunPause } = await import('./lib/run-pause.js');
  requestRunPause();
  return { ok: true };
});

ipcMain.handle('resume-run', async () => {
  const { requestRunResume } = await import('./lib/run-pause.js');
  requestRunResume();
  return { ok: true };
});

ipcMain.handle('stop-run', async () => {
  const { requestRunStop } = await import('./lib/run-pause.js');
  requestRunStop();
  return { ok: true };
});

ipcMain.handle('check-index', async (event, { indices = null, force = false } = {}) => {
  const { checkIndexBatch, getIndexCheckTargets, countSkippedIndexed } = await import('./lib/naver-index-check.js');
  const results = loadResults();
  const skipIndexed = !force;
  const targets = indices != null
    ? getIndexCheckTargets(results, { skipIndexed }).filter(({ index }) => indices.includes(index))
    : getIndexCheckTargets(results, { skipIndexed });

  if (!targets.length) {
    const skipped = countSkippedIndexed(results);
    const msg = indices != null
      ? '이미 인덱싱된 사이트이거나 확인 대상이 아닙니다.'
      : (skipped > 0
        ? `확인할 대상이 없습니다. 이미 인덱싱된 ${skipped}건은 재확인하지 않습니다.`
        : '확인할 배포 URL이 없습니다.');
    return { error: msg, results, summary: { checked: 0, skipped } };
  }

  try {
    const out = await checkIndexBatch(results, {
      indices,
      skipIndexed,
      onProgress: (p) => {
        if (p.phase === 'done') {
          event.sender.send('index-updated', p);
        }
        event.sender.send('index-progress', p);
      },
      onSave: (updated) => saveResults(updated),
    });
    return out;
  } catch (e) {
    return { error: e.message, results };
  }
});

ipcMain.handle('check-sites-index', async (event, { ids = null, force = false } = {}) => {
  const { checkIndexBatch, getIndexCheckTargets, countSkippedIndexed } = await import('./lib/naver-index-check.js');
  const { saveSitesRegistry } = await import('./lib/sites-registry.js');
  const sites = await loadCreatedSites({ sync: false });
  const skipIndexed = !force;

  let indices = null;
  if (Array.isArray(ids) && ids.length) {
    const idSet = new Set(ids.map(String));
    indices = sites
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => idSet.has(String(s.id)))
      .map(({ i }) => i);
    if (!indices.length) {
      return { error: '선택한 사이트를 찾을 수 없습니다.', results: sites, summary: { checked: 0, skipped: 0 } };
    }
  }

  const targets = indices != null
    ? getIndexCheckTargets(sites, { skipIndexed }).filter(({ index }) => indices.includes(index))
    : getIndexCheckTargets(sites, { skipIndexed });

  if (!targets.length) {
    const skipped = countSkippedIndexed(sites);
    const msg = indices != null
      ? '이미 인덱싱된 사이트이거나 URL이 없습니다.'
      : (skipped > 0
        ? `확인할 대상이 없습니다. 이미 인덱싱된 ${skipped}건은 재확인하지 않습니다.`
        : '확인할 URL이 있는 생성 사이트가 없습니다.');
    return { error: msg, results: sites, summary: { checked: 0, skipped } };
  }

  try {
    const out = await checkIndexBatch(sites, {
      indices,
      skipIndexed,
      onProgress: (p) => {
        if (p.phase === 'done') {
          event.sender.send('sites-index-updated', p);
        }
        event.sender.send('sites-index-progress', p);
      },
      onSave: (updated) => saveSitesRegistry(CREATED_SITES_PATH, updated),
    });
    return out;
  } catch (e) {
    return { error: e.message, results: sites };
  }
});

ipcMain.handle('reinject-index', async (event, { index } = {}) => {
  const config = loadConfig();
  const results = loadResults();
  if (index == null || !results[index]) {
    return { error: '결과를 찾을 수 없습니다.', results };
  }
  const row = results[index];
  if (!row.url) return { error: 'URL이 없습니다.', results };
  if (!['success', 'manual'].includes(row.status)) {
    return { error: '등록 성공·수동 완료 항목만 재인젝싱할 수 있습니다.', results };
  }
  if (row.indexed !== false || !row.indexCheckedAt) {
    return { error: '인덱싱 확인 후 미인덱싱 상태에서만 재인젝싱할 수 있습니다.', results };
  }

  const naverAccount = (config.naverAccounts || []).find(a => a.id === row.naverAccountId);
  if (!naverAccount) {
    return { error: `네이버 계정을 찾을 수 없습니다: ${row.naverAccountId || '(없음)'}`, results };
  }

  const { reinjectIndexing } = await import('./lib/naver-reindex.js');
  try {
    await reinjectIndexing({
      siteUrl: row.url,
      siteName: row.name,
      naverAccount,
      openaiApiKey: config.openaiApiKey || '',
      outputRoot: OUTPUT_ROOT,
      sendLog: (line) => event.sender.send('reinject-log', line),
      headless: !!config.headless,
    });
    results[index] = {
      ...results[index],
      reindexedAt: new Date().toISOString(),
      indexMessage: '재인젝싱 완료',
    };
    saveResults(results);
    return { ok: true, results, index };
  } catch (e) {
    return { error: e.message, results };
  }
});

ipcMain.handle('record-netlify-flow-start', async (event, options) => {
  const { startNetlifyRecording } = await import('./lib/netlify-record.js');
  const outputRoot = options.outputRoot || OUTPUT_ROOT;
  try {
    const out = await startNetlifyRecording({
      mode: options.mode || 'signup',
      outputRoot,
      sendLog: (line) => event.sender.send('token-gen-log', line),
    });
    return out;
  } catch (e) {
    event.sender.send('token-gen-log', `[ERROR] ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('record-netlify-flow-stop', async (event) => {
  const { stopNetlifyRecording } = await import('./lib/netlify-record.js');
  try {
    const out = await stopNetlifyRecording((line) => event.sender.send('token-gen-log', line));
    return out;
  } catch (e) {
    event.sender.send('token-gen-log', `[ERROR] ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('generate-tokens', async (event, options) => {
  const { generateNetlifyTokens } = await import('./lib/netlify-token-gen.js');
  const { resetTokenGenStop, TokenGenStopped } = await import('./lib/token-gen-cancel.js');
  resetTokenGenStop();
  try {
    const tokens = await generateNetlifyTokens({
      ...options,
      sendLog: (line) => event.sender.send('token-gen-log', line),
      onProgress: (data) => event.sender.send('token-gen-progress', data),
    });
    return { tokens };
  } catch (e) {
    if (e.name === 'TokenGenStopped') {
      event.sender.send('token-gen-log', `[STOP] ${e.message}`);
      return { tokens: e.tokens || [], stopped: true };
    }
    event.sender.send('token-gen-log', `[ERROR] ${e.message}`);
    return { error: e.message, tokens: [] };
  }
});

ipcMain.handle('stop-token-gen', async () => {
  const { requestTokenGenStop } = await import('./lib/token-gen-cancel.js');
  requestTokenGenStop();
  return { ok: true };
});

ipcMain.handle('crawl-site-urls', async (event, options = {}) => {
  const { crawlSiteUrls } = await import('./lib/site-url-crawler.js');
  const { resetCrawlStop, CrawlStopped } = await import('./lib/crawl-cancel.js');
  if (options.resetStop !== false) resetCrawlStop();
  try {
    const { resetStop: _r, ...crawlOpts } = options;
    const urls = await crawlSiteUrls({
      ...crawlOpts,
      sendLog: (line) => event.sender.send('crawl-url-log', line),
    });
    return { urls };
  } catch (e) {
    if (e?.name === 'CrawlStopped' || e?.cancelled) {
      event.sender.send('crawl-url-log', `⏹ ${e.message}`);
      return { error: e.message, urls: [], stopped: true };
    }
    event.sender.send('crawl-url-log', `[ERROR] ${e.message}`);
    return { error: e.message, urls: [] };
  }
});

ipcMain.handle('stop-crawl', async () => {
  const { requestCrawlStop } = await import('./lib/crawl-cancel.js');
  requestCrawlStop();
  return { ok: true };
});

ipcMain.handle('submit-naver-collect', async (event, options = {}) => {
  const {
    homeUrl,
    urls,
    sites,
    siteUrls,
    naverAccount,
    doFast = true,
    doRobots = true,
    doSitemap = true,
    doWebpage = true,
  } = options;
  const config = loadConfig();
  // URL 수집 탭에서 넘긴 계정만 사용 (설정 탭 naverAccounts와 분리)
  const crawlAccount = (naverAccount?.id && naverAccount?.pw)
    ? { id: String(naverAccount.id).trim(), pw: String(naverAccount.pw).trim() }
    : (config.urlCrawlNaver?.id && config.urlCrawlNaver?.pw
      ? { id: String(config.urlCrawlNaver.id).trim(), pw: String(config.urlCrawlNaver.pw).trim() }
      : null);
  const { submitNaverBulkCollection } = await import('./lib/naver-bulk-collect.js');
  const { resetCrawlStop, CrawlStopped } = await import('./lib/crawl-cancel.js');
  resetCrawlStop();
  try {
    let session = null;
    try {
      const { ensureNaverSession } = await import('./lib/naver-session.js');
      if (crawlAccount) {
        session = await ensureNaverSession({
          naverAccount: crawlAccount,
          openaiApiKey: config.openaiApiKey || '',
          headless: !!config.headless,
          outputFolder: path.join(OUTPUT_ROOT, 'naver-session'),
          onLog: (msg) => event.sender.send('crawl-url-log', `[세션] ${msg}`),
        });
      }
    } catch (e) {
      event.sender.send('crawl-url-log', `⚠ 공유 세션 실패: ${e.message}`);
    }
    const out = await submitNaverBulkCollection({
      homeUrl,
      urls: urls || [],
      sites: Array.isArray(sites) ? sites : undefined,
      siteUrls: Array.isArray(siteUrls) ? siteUrls : undefined,
      naverAccount: crawlAccount,
      openaiApiKey: config.openaiApiKey || '',
      outputRoot: OUTPUT_ROOT,
      headless: !!config.headless,
      doFast: !!doFast,
      doRobots: !!doRobots,
      doSitemap: !!doSitemap,
      doWebpage: !!doWebpage,
      browser: session?.browser || null,
      page: session?.page || null,
      keepBrowserOpen: !!session,
      skipLogin: !!session,
      sendLog: (line) => event.sender.send('crawl-url-log', line),
      onItemStart: (data) => event.sender.send('naver-collect-progress', { phase: 'start', ...data }),
      onItemDone: (data) => event.sender.send('naver-collect-progress', { phase: 'done', ...data }),
    });
    return { ok: true, ...out };
  } catch (e) {
    if (e?.name === 'CrawlStopped' || e?.cancelled) {
      event.sender.send('crawl-url-log', `⏹ ${e.message}`);
      return {
        ok: false,
        stopped: true,
        error: e.message,
        ...(e.partial || {}),
      };
    }
    event.sender.send('crawl-url-log', `[ERROR] ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('netlify-credits-login', async (event, options = {}) => {
  const { startNetlifyCreditsMonitor, DEFAULT_TEAM_SLUG } = await import('./lib/netlify-credits.js');
  const config = loadConfig();
  const teamSlug = String(options.teamSlug || config.netlifyCreditsTeam || DEFAULT_TEAM_SLUG || '').trim();
  const sendLog = (line) => event.sender.send('kkang-log', line);
  try {
    const out = await startNetlifyCreditsMonitor({
      dataRoot: DEFAULT_DATA_FOLDER,
      teamSlug,
      onLog: sendLog,
      onUpdate: (data) => {
        try {
          if (data?.teamSlug || data?.credits != null) {
            const cfg = loadConfig();
            if (data.teamSlug) cfg.netlifyCreditsTeam = data.teamSlug;
            cfg.netlifyCreditsLast = {
              credits: data.credits,
              creditsText: data.creditsText,
              teamSlug: data.teamSlug || cfg.netlifyCreditsTeam,
              at: data.at,
            };
            saveConfig(cfg);
          }
        } catch { /* ignore */ }
        event.sender.send('netlify-credits-update', data);
      },
    });
    return out;
  } catch (e) {
    sendLog(`[ERROR] Netlify 로그인: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('netlify-credits-refresh', async (event, options = {}) => {
  const { refreshNetlifyCredits, DEFAULT_TEAM_SLUG } = await import('./lib/netlify-credits.js');
  const config = loadConfig();
  try {
    const out = await refreshNetlifyCredits({
      teamSlug: String(options.teamSlug || config.netlifyCreditsTeam || DEFAULT_TEAM_SLUG || '').trim(),
    });
    if (out) {
      try {
        if (out.teamSlug || out.credits != null) {
          const cfg = loadConfig();
          if (out.teamSlug) cfg.netlifyCreditsTeam = out.teamSlug;
          cfg.netlifyCreditsLast = {
            credits: out.credits,
            creditsText: out.creditsText,
            teamSlug: out.teamSlug || cfg.netlifyCreditsTeam,
            at: out.at,
          };
          saveConfig(cfg);
        }
      } catch { /* ignore */ }
      event.sender.send('netlify-credits-update', out);
    }
    return out;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('netlify-credits-status', async () => {
  const { getNetlifyCreditsStatus, NETLIFY_CREDITS_PORT } = await import('./lib/netlify-credits.js');
  const { isDebugPortOpen } = await import('./lib/chrome-connect.js');
  const st = getNetlifyCreditsStatus();
  const config = loadConfig();
  return {
    ...st,
    portOpen: await isDebugPortOpen(NETLIFY_CREDITS_PORT),
    saved: config.netlifyCreditsLast || null,
    teamSlug: config.netlifyCreditsTeam || '',
  };
});

ipcMain.handle('netlify-credits-stop', async () => {
  const { stopNetlifyCreditsMonitor } = await import('./lib/netlify-credits.js');
  return stopNetlifyCreditsMonitor({ closeBrowser: false });
});

ipcMain.handle('kkang-ping', async (event) => {
  const config = loadConfig();
  const { pingKkangBuilder } = await import('./lib/kkang-site-builder.js');
  try {
    return await pingKkangBuilder(config, (line) => event.sender.send('kkang-log', line));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('kkang-list-keywords', async (event) => {
  const config = loadConfig();
  const { listKkangKeywords } = await import('./lib/kkang-site-builder.js');
  try {
    return await listKkangKeywords(config, (line) => event.sender.send('kkang-log', line));
  } catch (e) {
    event.sender.send('kkang-log', `[ERROR] ${e.message}`);
    return { error: e.message, keywords: [], folders: [], counts: {} };
  }
});

ipcMain.handle('kkang-add-keywords', async (event, { items } = {}) => {
  const config = loadConfig();
  const { addKkangKeywords } = await import('./lib/kkang-site-builder.js');
  try {
    return await addKkangKeywords(config, items || [], (line) => event.sender.send('kkang-log', line));
  } catch (e) {
    event.sender.send('kkang-log', `[ERROR] ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('kkang-remove-keywords', async (event, { keywords } = {}) => {
  const config = loadConfig();
  const { removeKkangKeywords } = await import('./lib/kkang-site-builder.js');
  try {
    return await removeKkangKeywords(config, keywords || [], (line) => event.sender.send('kkang-log', line));
  } catch (e) {
    event.sender.send('kkang-log', `[ERROR] ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('kkang-generate', async (event, job = {}) => {
  const config = loadConfig();
  // 네이버 세션 프로필 경로 고정 (배포 중 ensureNaverSession이 같은 창을 쓰도록)
  {
    const { setNaverSessionProfileDir } = await import('./lib/naver-session.js');
    setNaverSessionProfileDir(path.join(app.getPath('userData'), 'chrome-naver-session'));
  }
  // Persist builder path / cursor key / netlify 자격증명
  if (job.kkangBuilderPath != null) config.kkangBuilderPath = String(job.kkangBuilderPath || '').trim();
  if (job.cursor_api_key != null) config.cursorApiKey = String(job.cursor_api_key || '').trim();
  if (job.output_dir != null) config.kkangOutputDir = String(job.output_dir || '').trim();
  if (job.netlify_token != null) config.kkangNetlifyToken = String(job.netlify_token || '').trim();
  if (job.netlify_account_id != null) config.kkangNetlifyId = String(job.netlify_account_id || '').trim();
  saveConfig(config);

  // Prefer explicit token, else saved kkang token, else first unused Netlify token from settings
  let netlifyToken = String(job.netlify_token || config.kkangNetlifyToken || '').trim();
  let netlifyAccountId = String(job.netlify_account_id || config.kkangNetlifyId || '').trim();
  if (!netlifyToken) {
    const tokens = config.netlifyTokens || [];
    const unused = tokens.find((t) => t && t.token && !t.used);
    const any = tokens.find((t) => t && t.token);
    const picked = unused || any;
    netlifyToken = picked?.token || '';
    if (!netlifyAccountId && picked?.id) netlifyAccountId = String(picked.id).trim();
  } else if (!netlifyAccountId) {
    const match = (config.netlifyTokens || []).find((t) => t && t.token === netlifyToken);
    if (match?.id) netlifyAccountId = String(match.id).trim();
  }

  const manualNaverEarly = String(job.naver_code || '').trim();
  const willDeploy = job.deploy !== false;
  // 자동 네이버 인증: 배포 전에 HTML 메타를 넣고 1회만 배포 (크레딧 절약)
  const naverAccountForAuto = (willDeploy && !manualNaverEarly)
    ? pickNaverAccountForDothome(config, {})
    : null;
  const deferDeployForNaver = !!(willDeploy && !manualNaverEarly && naverAccountForAuto && netlifyToken);

  if (willDeploy && !manualNaverEarly && !netlifyToken) {
    event.sender.send('kkang-log', '[WARN] Netlify 토큰이 없습니다. 배포는 CLI 로그인으로 될 수 있으나, 네이버 인증 자동 배포에는 토큰이 필요합니다.');
  }
  if (deferDeployForNaver) {
    event.sender.send('kkang-log', 'ℹ 네이버 HTML 선수집 모드: 사이트 생성 → 메타 삽입 → Netlify 1회 배포');
  }

  const { generateKkangSite, registerNaverMetaForKkangSite } = await import('./lib/kkang-site-builder.js');
  const sendLog = (line) => event.sender.send('kkang-log', line);
  try {
    const result = await generateKkangSite({
      config,
      job: {
        ...job,
        // 자동 네이버면 엔진 쪽 배포는 건너뛰고, 메타 삽입 후 1회 배포
        deploy: willDeploy && !deferDeployForNaver,
        cursor_api_key: job.cursor_api_key || config.cursorApiKey || '',
        netlify_token: netlifyToken,
        netlify_account_id: netlifyAccountId,
        output_dir: job.output_dir || config.kkangOutputDir || path.join(OUTPUT_ROOT, 'kkang-sites'),
      },
      onLog: sendLog,
    });
    if (result?.ok) {
      result.netlifyAccountId = netlifyAccountId;
    }

    const manualNaver = String(job.naver_code || '').trim();
    // 네이버 코드 미입력 + 배포 예정 → HTML 태그 선수집·삽입 후(최초) 배포
    if (result?.ok && !manualNaver && (deferDeployForNaver || result.deployed)) {
      const naverAccount = naverAccountForAuto || pickNaverAccountForDothome(config, {});
      if (!naverAccount) {
        sendLog('[WARN] 네이버 계정이 없어 HTML 인증 자동 삽입을 건너뜁니다. 설정 탭에 계정을 등록하세요.');
        result.naverAuto = { skipped: true, reason: 'no_naver_account' };
        // 선수집 모드였는데 계정 없음이면 여기서 일반 배포
        if (deferDeployForNaver && netlifyToken) {
          try {
            const siteDir = result.output
              || path.join(job.output_dir || config.kkangOutputDir || path.join(OUTPUT_ROOT, 'kkang-sites'), result.site_slug || job.site_slug);
            const { deploySite } = await import('./lib/deploy.js');
            sendLog('네이버 계정 없음 — 메타 없이 Netlify 배포…');
            const dep = await deploySite({
              netlifyToken,
              siteName: result.site_slug || job.site_slug,
              dir: siteDir,
              serviceName: result.site_slug || job.site_slug || 'kkang-site',
            });
            result.deployed = true;
            if (dep?.url) result.domain = dep.url;
          } catch (depErr) {
            sendLog(`[ERROR] Netlify 배포 실패: ${depErr.message}`);
            result.deployError = depErr.message;
          }
        }
      } else if (!netlifyToken) {
        sendLog('[WARN] Netlify 토큰이 없어 네이버 메타 삽입·배포를 건너뜁니다.');
        result.naverAuto = { skipped: true, reason: 'no_netlify_token' };
      } else {
        try {
          const siteDir = result.output
            || path.join(job.output_dir || config.kkangOutputDir || path.join(OUTPUT_ROOT, 'kkang-sites'), result.site_slug || job.site_slug);
          const siteUrl = result.domain
            || `https://${result.site_slug || job.site_slug}.netlify.app`;
          const naverResult = await registerNaverMetaForKkangSite({
            siteUrl,
            siteDir,
            siteSlug: result.site_slug || job.site_slug,
            netlifyToken,
            naverAccount,
            openaiApiKey: config.openaiApiKey || '',
            headless: !!config.headless,
            metaInjectOnly: !!config.metaInjectOnly,
            outputRoot: OUTPUT_ROOT,
            onLog: sendLog,
            firstDeploy: !!deferDeployForNaver,
          });
          result.naverAccountId = naverAccount.id;
          if (naverResult?.deployed || naverResult?.deployUrl) {
            result.deployed = true;
            if (naverResult.deployUrl) result.domain = naverResult.deployUrl;
          }
          try {
            const { extractHtmlTitle } = await import('./lib/sites-registry.js');
            result.title = extractHtmlTitle(siteDir);
          } catch { /* ignore */ }

          const naverSt = String(naverResult?.status || '').toLowerCase();
          const naverOk = ['success', 'already', 'manual'].includes(naverSt) && !naverResult?.partial;
          result.naverAuto = {
            ...naverResult,
            naverAccountId: naverResult?.naverAccountId || naverAccount.id,
          };
          if (naverOk) {
            result.message = (result.message || '') + (deferDeployForNaver
              ? ' · 네이버 HTML 선수집 후 1회 배포'
              : ' · 네이버 HTML 인증 자동 삽입');
            sendLog(`✔ 네이버 등록 완료 (${naverAccount.id}) · ${naverSt || 'success'}`);
          } else {
            result.naverAutoError = naverResult?.error
              || `네이버 등록 실패 (상태: ${naverResult?.status || 'unknown'})`;
            sendLog(`⚠ 네이버 소유확인 미완료 (${naverSt || 'unknown'}) · 계정 ${naverAccount.id}`);
            sendLog('   → 「생성 사이트」탭에서 「색인재시도」로 소유확인·인덱싱만 다시 할 수 있습니다.');
          }
        } catch (naverErr) {
          sendLog(`[ERROR] 네이버 HTML 인증 자동 삽입 실패: ${naverErr.message}`);
          sendLog('   → 「생성 사이트」탭에서 「네이버 인증」또는 「색인재시도」로 재시도할 수 있습니다.');
          result.naverAccountId = naverAccount.id;
          result.naverAuto = {
            status: 'error',
            error: naverErr.message,
            naverAccountId: naverAccount.id,
          };
          result.naverAutoError = naverErr.message;
          // 선수집 모드에서 네이버 실패 시에도 사이트는 배포 시도
          if (deferDeployForNaver && !result.deployed) {
            try {
              const siteDir = result.output
                || path.join(job.output_dir || config.kkangOutputDir || path.join(OUTPUT_ROOT, 'kkang-sites'), result.site_slug || job.site_slug);
              const { deploySite } = await import('./lib/deploy.js');
              sendLog('네이버 인증 실패 — 메타 없이 Netlify 배포 시도…');
              const dep = await deploySite({
                netlifyToken,
                siteName: result.site_slug || job.site_slug,
                dir: siteDir,
                serviceName: result.site_slug || job.site_slug || 'kkang-site',
              });
              result.deployed = true;
              if (dep?.url) result.domain = dep.url;
            } catch (depErr) {
              sendLog(`[ERROR] Netlify 배포 실패: ${depErr.message}`);
              result.deployError = depErr.message;
            }
          }
        }
      }
    }

    // On success: append to deploy results for Naver pipeline visibility
    if (result?.ok && result.domain) {
      const results = loadResults();
      const naverNote = result.naverAuto?.metaContent
        ? ' · 네이버 인증 자동'
        : (result.naverAutoError ? ' · 네이버 인증 실패' : '');
      results.unshift({
        name: result.site_slug || job.site_slug || 'kkang-site',
        url: result.domain,
        status: result.deployed ? 'success' : 'manual',
        message: (result.deployed ? 'SEO 사이트 생성·배포 완료' : 'SEO 사이트 생성 완료 (배포 안 함)') + naverNote,
        source: 'kkang-site-builder',
        output: result.output || '',
        createdAt: new Date().toISOString(),
      });
      saveResults(results);
      result.results = results;

      try {
        const { entryFromNetlifyGenerate } = await import('./lib/sites-registry.js');
        const siteEntry = entryFromNetlifyGenerate(result, job);
        if (siteEntry) {
          result.createdSites = await upsertCreatedSite(siteEntry);
        }
      } catch (e) {
        sendLog(`[WARN] 생성 사이트 목록 저장 실패: ${e.message}`);
      }
    }

    // 배포 후 Netlify 크레딧 갱신 (로그인 Chrome이 열려 있을 때)
    if (result?.ok && result.deployed) {
      try {
        const { refreshNetlifyCredits, DEFAULT_TEAM_SLUG } = await import('./lib/netlify-credits.js');
        const cr = await refreshNetlifyCredits({
          teamSlug: loadConfig().netlifyCreditsTeam || DEFAULT_TEAM_SLUG,
        });
        if (cr) event.sender.send('netlify-credits-update', cr);
      } catch { /* ignore */ }
    }
    return result;
  } catch (e) {
    event.sender.send('kkang-log', `[ERROR] ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('kkang-stop', async () => {
  const { stopKkangGenerate } = await import('./lib/kkang-site-builder.js');
  return stopKkangGenerate();
});

/** 이미 생성·배포된 Netlify 사이트에 네이버 HTML 인증만 재시도 (토큰 추가 후) */
ipcMain.handle('kkang-retry-naver', async (event, options = {}) => {
  const config = loadConfig();
  const sendLog = (line) => event.sender.send('kkang-log', line);

  let netlifyToken = String(options.netlifyToken || config.kkangNetlifyToken || '').trim();
  let netlifyAccountId = String(options.netlifyAccountId || config.kkangNetlifyId || '').trim();
  if (!netlifyToken) {
    const tokens = config.netlifyTokens || [];
    const unused = tokens.find((t) => t && t.token && !t.used);
    const any = tokens.find((t) => t && t.token);
    const picked = unused || any;
    netlifyToken = picked?.token || '';
    if (!netlifyAccountId && picked?.id) netlifyAccountId = String(picked.id).trim();
  } else if (!netlifyAccountId) {
    const match = (config.netlifyTokens || []).find((t) => t && t.token === netlifyToken);
    if (match?.id) netlifyAccountId = String(match.id).trim();
  }
  if (!netlifyToken) {
    return { ok: false, error: 'Netlify 토큰이 없습니다. 설정 탭 또는 넷리파이 생성 탭에 토큰을 저장하세요.' };
  }

  const naverAccount = pickNaverAccountForDothome(config, {});
  if (!naverAccount) {
    return { ok: false, error: '네이버 계정이 없습니다. 설정 탭에 네이버 아이디/비밀번호를 등록하세요.' };
  }

  const sites = await loadCreatedSites({ sync: false });
  const siteId = String(options.siteId || '').trim();
  const slugOpt = String(options.siteSlug || options.name || '').trim();
  let site = null;
  if (siteId) site = sites.find((s) => s.id === siteId) || null;
  if (!site && slugOpt) {
    site = sites.find((s) => s.provider === 'netlify' && s.name === slugOpt) || null;
  }
  if (!site && slugOpt) {
    site = {
      id: `netlify:${slugOpt}`,
      provider: 'netlify',
      name: slugOpt,
      url: `https://${slugOpt}.netlify.app`,
      detail: {},
    };
  }
  if (!site?.name) {
    return { ok: false, error: '대상 사이트를 찾을 수 없습니다.' };
  }

  const siteSlug = site.name;
  const siteUrl = String(options.siteUrl || site.url || `https://${siteSlug}.netlify.app`).trim();
  const candidates = [
    String(options.siteDir || '').trim(),
    String(site.detail?.output || '').trim(),
    path.join(OUTPUT_ROOT, 'kkang-sites', siteSlug),
    path.join(config.kkangOutputDir || '', siteSlug),
  ].filter(Boolean);

  let siteDir = '';
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, 'index.html'))) {
        siteDir = c;
        break;
      }
    } catch { /* next */ }
  }
  if (!siteDir) {
    return {
      ok: false,
      error: `로컬 사이트 폴더(index.html)를 찾을 수 없습니다.\n시도: ${candidates.join('\n') || '(없음)'}`,
    };
  }

  const { registerNaverMetaForKkangSite } = await import('./lib/kkang-site-builder.js');
  try {
    sendLog(`═══ 네이버 HTML 인증 재시도: ${siteSlug} ═══`);
    sendLog(`폴더: ${siteDir}`);
    sendLog(`URL: ${siteUrl}`);
    const naverResult = await registerNaverMetaForKkangSite({
      siteUrl,
      siteDir,
      siteSlug,
      netlifyToken,
      naverAccount,
      openaiApiKey: config.openaiApiKey || '',
      headless: !!config.headless,
      metaInjectOnly: !!config.metaInjectOnly,
      outputRoot: OUTPUT_ROOT,
      onLog: sendLog,
    });

    const { extractHtmlTitle } = await import('./lib/sites-registry.js');
    const title = extractHtmlTitle(siteDir) || site.detail?.title || '';
    const naverSt = String(naverResult?.status || '').toLowerCase();
    const naverOk = ['success', 'already', 'manual'].includes(naverSt) && !naverResult?.partial;
    const createdSites = await upsertCreatedSite({
      ...site,
      url: siteUrl,
      status: 'deployed',
      detail: {
        ...(site.detail || {}),
        output: siteDir,
        title,
        naverAuto: naverOk,
        naverMeta: naverResult?.metaContent || site.detail?.naverMeta || '',
        naverError: naverOk ? '' : (naverResult?.error || `상태: ${naverSt}`),
        naverStatus: naverSt || (naverOk ? 'success' : 'error'),
        naverAccountId: naverResult?.naverAccountId || naverAccount.id,
        netlifyAccountId: netlifyAccountId || site.detail?.netlifyAccountId || config.kkangNetlifyId || '',
        pageUrlCount: naverResult?.pageUrlCount || 0,
        pageCollectOk: naverResult?.pageCollect?.totals?.pagesOk ?? null,
        naverRetriedAt: new Date().toISOString(),
      },
    });

    if (naverOk) {
      sendLog(`✔ 네이버 HTML 인증 완료: ${naverSt || 'ok'} · 네이버 ${naverAccount.id}${netlifyAccountId ? ` · Netlify ${netlifyAccountId}` : ''}`);
      if (naverResult?.pageUrlCount) {
        sendLog(`   하위 페이지 웹수집: ${naverResult.pageUrlCount}개 URL`);
      }
      if (title) sendLog(`   타이틀: ${title}`);
      return { ok: true, naver: naverResult, createdSites, siteDir, siteUrl, title };
    }

    sendLog(`⚠ 소유확인 미완료 (${naverSt}) · 「색인재시도」로 다시 시도하세요.`);
    return {
      ok: false,
      partial: true,
      error: naverResult?.error || `네이버 등록 실패 (상태: ${naverSt})`,
      naver: naverResult,
      createdSites,
      siteDir,
      siteUrl,
      title,
    };
  } catch (e) {
    sendLog(`[ERROR] 네이버 인증 재시도 실패: ${e.message}`);
    try {
      await upsertCreatedSite({
        ...site,
        detail: {
          ...(site.detail || {}),
          output: siteDir,
          naverAuto: false,
          naverStatus: 'error',
          naverError: e.message,
          naverAccountId: site.detail?.naverAccountId || naverAccount.id,
        },
      });
    } catch { /* ignore */ }
    return { ok: false, error: e.message, siteDir, siteUrl };
  }
});

/** 메타는 이미 있을 때: 보드 검색 → 소유확인 → 인덱싱만 재시도 (재배포 없음) */
ipcMain.handle('kkang-retry-naver-index', async (event, options = {}) => {
  const config = loadConfig();
  const sendLog = (line) => event.sender.send('kkang-log', line);

  const preferredId = String(options.naverAccountId || '').trim();
  let naverAccount = null;
  if (preferredId) {
    naverAccount = (config.naverAccounts || []).find((a) => a?.id === preferredId && a?.pw) || null;
  }
  if (!naverAccount) naverAccount = pickNaverAccountForDothome(config, {});
  if (!naverAccount) {
    return { ok: false, error: '네이버 계정이 없습니다. 설정 탭에 네이버 아이디/비밀번호를 등록하세요.' };
  }

  const sites = await loadCreatedSites({ sync: false });
  const siteId = String(options.siteId || '').trim();
  const slugOpt = String(options.siteSlug || options.name || '').trim();
  let site = null;
  if (siteId) site = sites.find((s) => s.id === siteId) || null;
  if (!site && slugOpt) {
    site = sites.find((s) => s.provider === 'netlify' && s.name === slugOpt) || null;
  }
  if (!site?.name) {
    return { ok: false, error: '대상 사이트를 찾을 수 없습니다.' };
  }

  const siteSlug = site.name;
  const siteUrl = String(options.siteUrl || site.url || `https://${siteSlug}.netlify.app`).trim();
  const candidates = [
    String(options.siteDir || '').trim(),
    String(site.detail?.output || '').trim(),
    path.join(OUTPUT_ROOT, 'kkang-sites', siteSlug),
    path.join(config.kkangOutputDir || '', siteSlug),
  ].filter(Boolean);
  let siteDir = '';
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, 'index.html'))) {
        siteDir = c;
        break;
      }
    } catch { /* next */ }
  }

  const { retryNaverOwnershipAndIndex } = await import('./lib/kkang-site-builder.js');
  try {
    sendLog(`═══ 색인재시도: ${siteSlug} ═══`);
    sendLog(`URL: ${siteUrl} · 계정: ${naverAccount.id}`);
    const out = await retryNaverOwnershipAndIndex({
      siteUrl,
      siteDir,
      siteSlug,
      naverAccount,
      openaiApiKey: config.openaiApiKey || '',
      headless: !!config.headless,
      outputRoot: OUTPUT_ROOT,
      onLog: sendLog,
    });

    const createdSites = await upsertCreatedSite({
      ...site,
      url: siteUrl,
      status: 'deployed',
      detail: {
        ...(site.detail || {}),
        output: siteDir || site.detail?.output || '',
        naverAuto: !!out.ok,
        naverStatus: out.status || (out.ok ? 'success' : 'captcha'),
        naverError: out.ok ? '' : (out.error || '소유확인 실패'),
        naverAccountId: out.naverAccountId || naverAccount.id,
        pageUrlCount: out.pageUrlCount || site.detail?.pageUrlCount || 0,
        naverIndexRetriedAt: new Date().toISOString(),
      },
    });

    if (out.ok) {
      sendLog(`✔ 색인재시도 완료 · 네이버 ${naverAccount.id}`);
      return { ok: true, naver: out, createdSites, siteUrl };
    }
    sendLog(`⚠ 색인재시도 미완료: ${out.error || out.status}`);
    return { ok: false, error: out.error || '소유확인 실패', naver: out, createdSites, siteUrl };
  } catch (e) {
    sendLog(`[ERROR] 색인재시도 실패: ${e.message}`);
    try {
      await upsertCreatedSite({
        ...site,
        detail: {
          ...(site.detail || {}),
          naverAuto: false,
          naverStatus: 'error',
          naverError: e.message,
          naverAccountId: site.detail?.naverAccountId || naverAccount.id,
        },
      });
    } catch { /* ignore */ }
    return { ok: false, error: e.message, siteUrl };
  }
});

ipcMain.handle('dothome-signup', async (event, options = {}) => {
  const config = loadConfig();
  const { runDothomeSignup } = await import('./lib/dothome-signup.js');
  const sendLog = (line) => event.sender.send('dothome-log', line);
  const emailLocal = String(options.emailLocal || config.dothome?.emailLocal || '').trim().replace(/@.*$/, '');

  // 네이버 메일용 계정: 이메일 앞부분과 같은 아이디 우선
  const accounts = Array.isArray(config.naverAccounts) ? config.naverAccounts : [];
  let naverAccount = accounts.find((a) => a?.id && a?.pw && a.id === emailLocal) || null;
  if (!naverAccount && config.urlCrawlNaver?.id && config.urlCrawlNaver?.pw) {
    if (!emailLocal || config.urlCrawlNaver.id === emailLocal) {
      naverAccount = { id: config.urlCrawlNaver.id, pw: config.urlCrawlNaver.pw };
    }
  }
  if (!naverAccount) {
    naverAccount = accounts.find((a) => a?.id && a?.pw) || null;
  }

  try {
    const out = await runDothomeSignup({
      openaiApiKey: config.openaiApiKey || '',
      yesCaptchaClientKey: (() => {
        const k = String(config.yesCaptchaClientKey || '').trim();
        if (!k) return '';
        if (/^sk-/i.test(k)) return ''; // OpenAI 키 오입력 방지
        return k;
      })(),
      emailLocal,
      naverAccount,
      usedIds: [
        ...(config.dothome?.usedIds || []),
        ...((config.dothome?.accounts || []).map((a) => a.id)),
      ],
      usedFtpIds: [
        ...(config.dothome?.usedFtpIds || []),
        ...((config.dothome?.accounts || []).map((a) => a.ftpId).filter(Boolean)),
      ],
      headless: options.headless != null ? !!options.headless : !!config.headless,
      outputRoot: OUTPUT_ROOT,
      sendLog,
    });

    if (out?.account?.id) {
      const dh = { ...(config.dothome || {}) };
      const used = new Set([...(dh.usedIds || []), out.account.id]);
      dh.usedIds = [...used];
      if (out.account.ftpId || out.usedFtpId) {
        const ftpUsed = new Set([...(dh.usedFtpIds || []), out.account.ftpId || out.usedFtpId]);
        dh.usedFtpIds = [...ftpUsed];
      }
      dh.accounts = [...(dh.accounts || []), out.account];
      dh.hostId = out.account.id;
      dh.hostPw = out.account.pw;
      dh.emailLocal = options.emailLocal || dh.emailLocal || '';
      config.dothome = dh;
      saveConfig(config);
      try {
        const { entryFromDothomeAccount } = await import('./lib/sites-registry.js');
        const siteEntry = entryFromDothomeAccount(out.account);
        if (siteEntry) out.createdSites = await upsertCreatedSite(siteEntry);
      } catch (e) {
        sendLog(`[WARN] 생성 사이트 목록 저장 실패: ${e.message}`);
      }
    }
    return out;
  } catch (e) {
    sendLog(`[ERROR] ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dothome-signup-stop', async () => {
  const { requestDothomeSignupCancel } = await import('./lib/dothome-signup.js');
  requestDothomeSignupCancel();
  return { ok: true };
});

function findDothomeAccount(config, options = {}) {
  const accounts = Array.isArray(config.dothome?.accounts) ? config.dothome.accounts : [];
  let account = options.account || null;
  if (!account && options.ftpId) {
    account = accounts.find((a) => a?.ftpId === options.ftpId) || null;
  }
  if (!account && options.accountId) {
    account = accounts.find((a) => a?.id === options.accountId) || null;
  }
  return account;
}

function patchDothomeAccount(config, ftpId, patch) {
  const dh = { ...(config.dothome || {}) };
  dh.accounts = (dh.accounts || []).map((a) => {
    if (a?.ftpId && a.ftpId === ftpId) return { ...a, ...patch };
    return a;
  });
  config.dothome = dh;
  saveConfig(config);
  return dh.accounts.find((a) => a.ftpId === ftpId) || null;
}

ipcMain.handle('dothome-seo-generate', async (event, options = {}) => {
  const config = loadConfig();
  const { generateDothomeSeoSite } = await import('./lib/dothome-seo-site.js');
  const sendLog = (line) => event.sender.send('dothome-log', line);
  const account = findDothomeAccount(config, options);
  if (!account?.ftpId) {
    return { ok: false, error: '계정을 찾을 수 없습니다. FTP 아이디가 있는 계정이 필요합니다.' };
  }

  const keyword = String(options.keyword || config.dothome?.keyword || '').trim();
  const imageDir = String(options.imageDir || config.dothome?.imageDir || '').trim();
  const externalUrl = String(options.externalUrl || config.dothome?.externalUrl || '').trim();
  const phoneDisplay = String(options.phoneDisplay || config.dothome?.phone || '010-6338-7124').trim();
  const cursorApiKey = String(options.cursorApiKey || config.cursorApiKey || '').trim();
  const googleVerifyFile = String(options.googleVerifyFile || config.dothome?.googleVerifyFile || '').trim();

  try {
    const out = await generateDothomeSeoSite({
      ftpId: account.ftpId,
      keyword,
      phoneDisplay,
      externalUrl,
      imageDir,
      cursorApiKey,
      googleVerifyFile,
      sendLog,
    });
    const dh = { ...(config.dothome || {}) };
    dh.keyword = keyword;
    dh.imageDir = imageDir;
    dh.externalUrl = externalUrl;
    dh.phone = phoneDisplay;
    dh.googleVerifyFile = googleVerifyFile;
    config.dothome = dh;
    const generatedAt = new Date().toISOString();
    const acc = patchDothomeAccount(config, account.ftpId, {
      url: out.siteUrl,
      siteDir: out.siteDir,
      keyword,
      generatedAt,
    });
    let createdSites;
    try {
      const { entryFromDothomeAccount } = await import('./lib/sites-registry.js');
      const siteEntry = entryFromDothomeAccount(acc || account, {
        url: out.siteUrl,
        siteDir: out.siteDir,
        keyword,
        generatedAt,
      });
      if (siteEntry) createdSites = await upsertCreatedSite(siteEntry);
    } catch (e) {
      sendLog(`[WARN] 생성 사이트 목록 저장 실패: ${e.message}`);
    }
    return { ...out, ok: true, account: acc, createdSites };
  } catch (e) {
    sendLog(`[ERROR] ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dothome-deploy', async (event, options = {}) => {
  const config = loadConfig();
  const { deployDothomeSite, resolveSiteUrl } = await import('./lib/dothome-deploy.js');
  const sendLog = (line) => event.sender.send('dothome-log', line);

  const account = findDothomeAccount(config, options);
  if (!account) {
    return { ok: false, error: '배포할 계정을 찾을 수 없습니다. 생성된 계정에서 선택하세요.' };
  }

  const ftpHost = String(options.ftpHost || config.dothome?.ftpHost || '').trim();
  const keyword = String(options.keyword || config.dothome?.keyword || account.keyword || '').trim();
  const imageDir = String(options.imageDir || config.dothome?.imageDir || '').trim();
  const externalUrl = String(options.externalUrl || config.dothome?.externalUrl || '').trim();
  const phoneDisplay = String(options.phoneDisplay || config.dothome?.phone || '010-6338-7124').trim();
  const cursorApiKey = String(options.cursorApiKey || config.cursorApiKey || '').trim();
  const googleVerifyFile = String(options.googleVerifyFile || config.dothome?.googleVerifyFile || '').trim();
  const generate = options.generate !== false; // 기본: 생성 후 배포
  const registerNaver = options.registerNaver !== false && !!generate;
  const siteDir = String(options.siteDir || account.siteDir || '').trim();
  const naverAccount = pickNaverAccountForDothome(config, options);

  try {
    if (registerNaver && !naverAccount) {
      return {
        ok: false,
        error: '생성 후 배포에는 네이버 서치어드바이저 등록이 포함됩니다.\n설정 탭에 네이버 계정(아이디/비밀번호)을 등록하세요.',
      };
    }

    const out = await deployDothomeSite({
      account,
      siteDir: generate ? '' : siteDir,
      generate,
      keyword,
      phoneDisplay,
      externalUrl,
      imageDir,
      cursorApiKey,
      googleVerifyFile,
      ftpHost,
      registerNaver,
      naverAccount,
      openaiApiKey: config.openaiApiKey || '',
      headless: !!config.headless,
      metaInjectOnly: !!config.metaInjectOnly,
      outputRoot: OUTPUT_ROOT,
      sendLog,
    });

    const siteUrl = out.siteUrl || `${resolveSiteUrl(account, { https: true })}/`;
    const dh = { ...(config.dothome || {}) };
    dh.keyword = keyword;
    dh.imageDir = imageDir;
    dh.externalUrl = externalUrl;
    dh.phone = phoneDisplay;
    dh.ftpHost = ftpHost;
    dh.googleVerifyFile = googleVerifyFile;
    config.dothome = dh;
    const deployedAt = new Date().toISOString();
    const acc = patchDothomeAccount(config, account.ftpId, {
      url: siteUrl,
      deployedAt,
      siteDir: out.siteDir || account.siteDir,
      keyword,
      cms: 'none',
      naverStatus: out.naver?.status || '',
      naverMeta: out.naver?.metaContent || '',
      naverAccountId: out.naver?.naverAccountId || naverAccount?.id || '',
    });

    sendLog(`✔ 배포 완료: ${siteUrl}`);
    if (out.naver?.status) sendLog(`✔ 네이버: ${out.naver.status}`);

    let createdSites;
    try {
      const { entryFromDothomeAccount } = await import('./lib/sites-registry.js');
      const siteEntry = entryFromDothomeAccount(acc || account, {
        url: siteUrl,
        siteDir: out.siteDir || account.siteDir,
        keyword,
        deployedAt,
        naverStatus: out.naver?.status || '',
        naverAccountId: out.naver?.naverAccountId || naverAccount?.id || '',
      });
      if (siteEntry) createdSites = await upsertCreatedSite(siteEntry);
    } catch (e) {
      sendLog(`[WARN] 생성 사이트 목록 저장 실패: ${e.message}`);
    }
    return { ...out, ok: true, account: acc, createdSites };
  } catch (e) {
    sendLog(`[ERROR] ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cloudflare-save-site', async (event, project = {}) => {
  const config = loadConfig();
  const { entryFromCloudflare } = await import('./lib/sites-registry.js');
  const entry = entryFromCloudflare({
    ...project,
    accountId: project.accountId || config.cloudflare?.accountId || '',
    brand: project.brand || config.cloudflare?.brand || '',
    phone: project.phone || config.cloudflare?.phone || '',
  });
  if (!entry) return { ok: false, error: '프로젝트명이 없습니다.' };

  const cf = { ...(config.cloudflare || {}) };
  const sites = Array.isArray(cf.sites) ? [...cf.sites] : [];
  const idx = sites.findIndex((s) => String(s.name || '').toLowerCase() === entry.name.toLowerCase());
  const row = {
    name: entry.name,
    url: entry.url,
    status: entry.status,
    createdAt: idx >= 0 ? (sites[idx].createdAt || entry.createdAt) : entry.createdAt,
    accountId: entry.detail.accountId || '',
    brand: entry.detail.brand || '',
    phone: entry.detail.phone || '',
    notes: entry.detail.notes || '',
  };
  if (idx >= 0) sites[idx] = { ...sites[idx], ...row };
  else sites.unshift(row);
  cf.sites = sites;
  config.cloudflare = cf;
  saveConfig(config);

  const createdSites = await upsertCreatedSite(entry);
  return { ok: true, site: entry, createdSites };
});
