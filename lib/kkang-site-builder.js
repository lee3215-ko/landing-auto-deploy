import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let activeChild = null;
let cancelFile = null;

function resolveCliExe(builderRoot = '') {
  const candidates = [];
  if (builderRoot) {
    candidates.push(path.join(builderRoot, 'kkang-cli', 'kkang-cli.exe'));
    candidates.push(path.join(builderRoot, 'dist', 'kkang-cli', 'kkang-cli.exe'));
  }
  candidates.push(path.resolve(__dirname, '..', 'engine', 'kkang-site-builder', 'kkang-cli', 'kkang-cli.exe'));
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'kkang-site-builder', 'kkang-cli', 'kkang-cli.exe'));
    candidates.push(path.join(process.resourcesPath, 'kkang-cli', 'kkang-cli.exe'));
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

function hasCliBridge(root) {
  if (!root) return false;
  if (fs.existsSync(path.join(root, 'kkang-cli', 'kkang-cli.exe'))) return true;
  return fs.existsSync(path.join(root, 'scripts', 'cli_bridge.py'));
}

/** 설정 경로 → 앱 내장 engine → 패키지 resources → 개발용 Projects 순 */
export function resolveBuilderRoot(config = {}) {
  const candidates = [];
  const fromConfig = (config.kkangBuilderPath || '').trim();
  if (fromConfig) candidates.push(path.resolve(fromConfig));

  // 개발: landing-auto-deploy/engine/kkang-site-builder
  candidates.push(path.resolve(__dirname, '..', 'engine', 'kkang-site-builder'));

  // 패키지: resources/kkang-site-builder (extraResources)
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'kkang-site-builder'));
  }

  // 개발 PC 레거시 경로 (있을 때만)
  candidates.push(path.resolve('C:\\Users\\thdco\\Projects\\kkang-site-builder'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'Projects', 'kkang-site-builder'));

  for (const root of candidates) {
    if (hasCliBridge(root)) return root;
  }
  return candidates[0] || path.resolve(__dirname, '..', 'engine', 'kkang-site-builder');
}

export function describeBuilderRoot(config = {}) {
  const root = resolveBuilderRoot(config);
  const cliExe = resolveCliExe(root);
  return {
    root,
    ok: hasCliBridge(root),
    bundled: /[\\/]engine[\\/]kkang-site-builder|[\\/]resources[\\/]kkang-site-builder/i.test(root),
    cliExe: cliExe || null,
    mode: cliExe ? 'exe' : 'python',
  };
}

function commandExists(cmd) {
  if (!cmd) return false;
  if (path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return fs.existsSync(cmd);
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [cmd], { stdio: 'ignore', windowsHide: true });
    } else {
      execFileSync('which', [cmd], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  const candidates = [
    process.env.KKANG_PYTHON,
    process.platform === 'win32' ? 'py' : null,
    'python',
    'python3',
  ].filter(Boolean);

  for (const cmd of candidates) {
    if (commandExists(cmd)) return cmd;
  }
  return '';
}

function buildSpawn(builderRoot, args) {
  const cliExe = resolveCliExe(builderRoot);
  if (cliExe) {
    return {
      cmd: cliExe,
      args: [...args],
      cwd: path.dirname(cliExe),
      mode: 'exe',
    };
  }

  const script = path.join(builderRoot, 'scripts', 'cli_bridge.py');
  if (!fs.existsSync(script)) {
    throw new Error(
      `KKang CLI를 찾을 수 없습니다.\n` +
      `배포본에는 kkang-cli.exe가 포함되어야 합니다.\n` +
      `(engine: ${builderRoot})`
    );
  }

  const py = findPython();
  if (!py) {
    throw new Error(
      'Python이 없고 내장 kkang-cli.exe도 없습니다.\n' +
      '최신 LandingAutoDeploy.zip 을 다시 받거나, Python 3를 설치하세요.'
    );
  }
  if (process.platform === 'win32' && (py === 'py' || /[\\/]py\.exe$/i.test(py))) {
    return { cmd: py, args: ['-3', script, ...args], cwd: builderRoot, mode: 'python' };
  }
  return { cmd: py, args: [script, ...args], cwd: builderRoot, mode: 'python' };
}

function resolveKkangDataDir() {
  try {
    // Electron main에서 주입. 패키지 EXE는 userData에 custom 키워드 저장
    if (process.env.KKANG_DATA_DIR) return process.env.KKANG_DATA_DIR;
  } catch { /* ignore */ }
  return '';
}

function runCli({ builderRoot, args, onLog, cancelPath = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, args: spawnArgs, cwd } = buildSpawn(builderRoot, args);
    const env = { ...process.env };
    if (cancelPath) env.KKANG_CANCEL_FILE = cancelPath;
    const dataDir = resolveKkangDataDir();
    if (dataDir) env.KKANG_DATA_DIR = dataDir;
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';

    const child = spawn(cmd, spawnArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let resultPayload = null;
    let errorPayload = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      fn(value);
    };

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'log' && onLog) onLog(msg.message || '');
        else if (msg.type === 'result') resultPayload = msg;
        else if (msg.type === 'error') {
          errorPayload = msg;
          if (onLog) onLog(`✖ ${msg.message || '오류'}`);
        }
      } catch {
        if (onLog) onLog(text);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const parts = stdoutBuf.split(/\r?\n/);
      stdoutBuf = parts.pop() || '';
      for (const part of parts) handleLine(part);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      // Surface unexpected stderr as log lines (truncated)
      const parts = stderrBuf.split(/\r?\n/);
      stderrBuf = parts.pop() || '';
      for (const part of parts) {
        if (part.trim() && onLog) onLog(`[py] ${part.trim()}`);
      }
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(reject, new Error('시간 초과'));
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const hint = resolveCliExe(builderRoot)
        ? `내장 CLI 실행 실패: ${err.message}`
        : `Python 실행 실패: ${err.message}\n내장 kkang-cli.exe가 없거나 Python 3가 PATH에 없습니다.`;
      finish(reject, new Error(hint));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (resultPayload) {
        finish(resolve, resultPayload);
        return;
      }
      if (errorPayload) {
        finish(resolve, { type: 'error', ok: false, message: errorPayload.message || '오류' });
        return;
      }
      if (code === 0) {
        finish(resolve, { type: 'result', ok: true, data: {} });
        return;
      }
      finish(reject, new Error(stderrBuf.trim() || `CLI 종료 코드 ${code}`));
    });
  });
}

export async function pingKkangBuilder(config = {}, onLog) {
  const info = describeBuilderRoot(config);
  const builderRoot = info.root;
  if (!info.ok) {
    return {
      ok: false,
      error: `엔진을 찾을 수 없습니다. 고급설정 경로를 지정하거나 npm run sync:engine 후 다시 빌드하세요.\n(${builderRoot})`,
      builderRoot,
      bundled: info.bundled,
    };
  }
  try {
    const out = await runCli({
      builderRoot,
      args: ['ping'],
      onLog,
      timeoutMs: 30000,
    });
    if (out.type === 'error' || out.ok === false) {
      return { ok: false, error: out.message || '핑 실패', builderRoot, bundled: info.bundled };
    }
    return { ok: true, builderRoot, bundled: info.bundled, ...(out.data || {}) };
  } catch (e) {
    return {
      ok: false,
      error: e.message || String(e),
      builderRoot,
      bundled: info.bundled,
    };
  }
}

export async function listKkangKeywords(config = {}, onLog) {
  const builderRoot = resolveBuilderRoot(config);
  const out = await runCli({
    builderRoot,
    args: ['keywords'],
    onLog,
    timeoutMs: 60000,
  });
  if (out.type === 'error' || out.ok === false) {
    throw new Error(out.message || '키워드 목록을 불러오지 못했습니다.');
  }
  return { builderRoot, ...(out.data || {}) };
}

export async function addKkangKeywords(config = {}, items = [], onLog) {
  const builderRoot = resolveBuilderRoot(config);
  const tmp = path.join(os.tmpdir(), `kkang-add-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  try {
    const out = await runCli({
      builderRoot,
      args: ['add-keywords', '--job', tmp],
      onLog,
      timeoutMs: 60000,
    });
    if (out.type === 'error' || out.ok === false) {
      throw new Error(out.message || '키워드 추가 실패');
    }
    return out.data || {};
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export async function removeKkangKeywords(config = {}, keywords = [], onLog) {
  const builderRoot = resolveBuilderRoot(config);
  const list = (Array.isArray(keywords) ? keywords : [])
    .map((k) => (typeof k === 'string' ? k : k?.kw || ''))
    .map((k) => String(k || '').trim())
    .filter(Boolean);
  if (!list.length) return { removed: [], skipped: [] };

  const tmp = path.join(os.tmpdir(), `kkang-remove-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ keywords: list }, null, 2), 'utf8');
  try {
    const out = await runCli({
      builderRoot,
      args: ['remove-keywords', '--job', tmp],
      onLog,
      timeoutMs: 60000,
    });
    if (out.type === 'error' || out.ok === false) {
      throw new Error(out.message || '키워드 삭제 실패');
    }
    return out.data || { removed: [], skipped: [] };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export async function generateKkangSite(options = {}) {
  const {
    config = {},
    job = {},
    onLog,
  } = options;

  const builderRoot = resolveBuilderRoot(config);
  cancelFile = path.join(os.tmpdir(), `kkang-cancel-${Date.now()}.flag`);
  try { if (fs.existsSync(cancelFile)) fs.unlinkSync(cancelFile); } catch { /* ignore */ }

  const tmp = path.join(os.tmpdir(), `kkang-job-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');

  try {
    if (onLog) onLog(`엔진: ${builderRoot}`);
    const out = await runCli({
      builderRoot,
      args: ['generate', '--job', tmp],
      onLog,
      cancelPath: cancelFile,
    });
    if (out.cancelled) {
      return { ok: false, cancelled: true, message: out.message || '중지됨' };
    }
    if (out.type === 'error' || out.ok === false) {
      return { ok: false, error: out.message || '생성 실패' };
    }
    const data = { ...(out.data || {}) };
    // 이미지 폴더가 있으면 랜덤 적용, 없으면 엔진 생성 이미지 유지
    const imageDir = String(job.image_dir || job.imageDir || config.kkangImageDir || '').trim();
    const siteDir = data.output
      || (data.site_slug
        ? path.join(job.output_dir || config.kkangOutputDir || '', data.site_slug)
        : '');
    if (imageDir && siteDir) {
      try {
        const { applyRandomImagesFromFolder } = await import('./kkang-images.js');
        const imgRes = await applyRandomImagesFromFolder({
          siteDir,
          imageDir,
          onLog: onLog || (() => {}),
        });
        data.imagesFromFolder = imgRes;
      } catch (e) {
        if (onLog) onLog(`[WARN] 이미지 폴더 적용 실패 — 생성 이미지 유지: ${e.message}`);
      }
    } else if (onLog && !imageDir) {
      onLog('이미지 폴더 미지정 — 미리보기와 동일한 자동 생성 이미지 사용');
    }
    return { ok: true, ...data };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    try { if (cancelFile && fs.existsSync(cancelFile)) fs.unlinkSync(cancelFile); } catch { /* ignore */ }
    cancelFile = null;
  }
}

export function stopKkangGenerate() {
  if (cancelFile) {
    try { fs.writeFileSync(cancelFile, '1', 'utf8'); } catch { /* ignore */ }
  }
  // Soft cancel first; hard-kill after a short grace if still running
  const child = activeChild;
  if (child && child.pid) {
    setTimeout(() => {
      if (activeChild !== child) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }, 8000);
  }
  return { ok: true };
}

export function getDefaultBuilderRoot() {
  return resolveBuilderRoot();
}

/** 로컬 생성 폴더(+sitemap.xml)에서 하위 페이지 URL 목록 수집 */
export function collectLocalSitePageUrls(siteDir, siteRootUrl) {
  const root = String(siteRootUrl || '').replace(/\/$/, '');
  if (!root) return [];
  const dir = String(siteDir || '').trim();
  const urls = new Set([`${root}/`]);

  /** zip/sitemap에 다른 도메인이 있어도 배포 Netlify 주소(root)로 강제 */
  const addUnderRoot = (pathname) => {
    let p = String(pathname || '/').trim() || '/';
    if (!p.startsWith('/')) p = `/${p}`;
    const base = (p.split('?')[0].split('/').pop() || '');
    // 웹페이지 수집 목록에서 sitemap·google 소유확인 파일 제외
    if (/^sitemap\.xml$/i.test(base)) return;
    if (/^google[a-z0-9]+\.html?$/i.test(base)) return;
    // ZIP 템플릿 플레이스홀더가 경로로 남은 경우 제외
    if (/__SITE_URL__|__BASE_URL__/i.test(p)) return;
    if (/^\/index\.html?$/i.test(p.split('?')[0])) p = '/';
    else if (/\.html?$/i.test(p.split('?')[0])) {
      p = p.replace(/\.html?(?=\?|$)/i, '');
      if (p.endsWith('/index')) p = p.slice(0, -'/index'.length) || '/';
    }
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (p === '/' || p === '') {
      urls.add(`${root}/`);
      return;
    }
    urls.add(`${root}${p}`);
  };

  const addPath = (relPath) => {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rel) {
      addUnderRoot('/');
      return;
    }
    if (/^google[a-z0-9]+\.html?$/i.test(rel.split('/').pop() || '')) return;
    // 로컬 파일 limit-guide.html → 공개 URL /limit-guide
    addUnderRoot(`/${rel}`);
  };

  try {
    const smPath = path.join(dir, 'sitemap.xml');
    if (fs.existsSync(smPath)) {
      const xml = fs.readFileSync(smPath, 'utf8');
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const loc = String(m[1] || '').trim();
        if (!loc) continue;
        try {
          const u = new URL(loc, root);
          // 호스트가 달라도(zip 원본명) 경로만 배포 URL에 붙임
          addUnderRoot(u.pathname + (u.search || ''));
        } catch {
          if (loc.startsWith('/')) addUnderRoot(loc);
        }
      }
    }
  } catch { /* ignore */ }

  const skipDirs = new Set(['node_modules', '.git', '.netlify', '.ai-cache', '__pycache__', 'assets', 'scripts']);
  const walk = (current, rel = '') => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(current, ent.name);
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full, nextRel);
      } else if (/^index\.html?$/i.test(ent.name)) {
        addPath(rel);
      } else if (/\.html?$/i.test(ent.name)) {
        addPath(nextRel);
      }
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir);

  // normalize + dedupe (공개 pretty URL: /page.html → /page, trailing slash 제거)
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    let u = String(raw || '').trim();
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    try {
      const parsed = new URL(u);
      let pathOnly = parsed.pathname || '/';
      const leaf = pathOnly.split('/').pop() || '';
      if (!/^google[a-z0-9]+\.html?$/i.test(leaf)) {
        if (/^\/index\.html?$/i.test(pathOnly)) pathOnly = '/';
        else if (/\.html?$/i.test(pathOnly)) {
          pathOnly = pathOnly.replace(/\.html?$/i, '') || '/';
        }
      }
      if (pathOnly.length > 1 && pathOnly.endsWith('/')) {
        pathOnly = pathOnly.slice(0, -1);
      }
      parsed.pathname = pathOnly || '/';
      u = parsed.pathname === '/'
        ? `${parsed.protocol}//${parsed.host}/`
        : parsed.toString().replace(/\/$/, '');
    } catch { continue; }
    const key = u.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  // home first
  out.sort((a, b) => {
    const ah = a.replace(/\/$/, '') === root ? 0 : 1;
    const bh = b.replace(/\/$/, '') === root ? 0 : 1;
    return ah - bh || a.localeCompare(b);
  });
  return out;
}

/**
 * 네이버 서치어드바이저 HTML 태그 인증
 * - firstDeploy=true: 로컬 HTML에 메타 삽입 후 Netlify 최초 1회 배포 → 소유확인
 * - firstDeploy=false: 이미 배포된 사이트에 메타 삽입 후 재배포 → 소유확인
 * 이후 빠르게 → robots → 사이트맵 → 하위 URL 웹수집 (간단 홈 인덱싱은 하지 않음)
 */
export async function registerNaverMetaForKkangSite({
  siteUrl,
  siteDir,
  siteSlug,
  netlifyToken,
  naverAccount: naverAccountArg,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  metaInjectOnly = false,
  collectSubpages = true,
  outputRoot,
  onLog,
  /** true면 배포 전에 메타를 넣고 최초 1회만 배포 (크레딧 절약) */
  firstDeploy = false,
} = {}) {
  let naverAccount = naverAccountArg;
  const log = (msg) => { if (typeof onLog === 'function') onLog(String(msg)); };

  const rootUrl = String(siteUrl || '').replace(/\/?$/, '/');
  const dir = String(siteDir || '').trim();
  if (!rootUrl || rootUrl === '/') throw new Error('네이버 등록용 사이트 URL이 없습니다.');
  if (!dir || !fs.existsSync(dir)) throw new Error(`사이트 폴더가 없습니다: ${dir}`);
  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error('네이버 계정이 필요합니다. 설정 탭에 네이버 아이디/비밀번호를 등록하세요.');
  }
  if (!netlifyToken) {
    throw new Error('Netlify 토큰이 필요합니다. (배포용)');
  }

  const { registerNaverSites, injectMetaAllHtml } = await import('./naver-register.js');
  const { deploySite } = await import('./deploy.js');
  const { setLogger } = await import('./logger.js');
  const { ensureNaverSession } = await import('./naver-session.js');

  const folder = path.join(outputRoot || path.join(process.cwd(), 'output'), `kkang-naver-${siteSlug || 'site'}-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });

  log(firstDeploy
    ? '═══ 네이버 HTML 태그 선수집 → 메타 삽입 → Netlify 1회 배포 ═══'
    : '═══ 네이버 HTML 태그 인증코드 자동 추출 ═══');
  log(`사이트: ${rootUrl}`);
  log(`계정: ${naverAccount.id}`);
  setLogger((msg) => log(String(msg).replace(/^\[.*?\]\s*/, '')));

  let session = null;
  try {
    session = await ensureNaverSession({
      naverAccount,
      naverAccounts,
      openaiApiKey,
      yesCaptchaClientKey,
      headless: !!headless,
      outputFolder: folder,
      onLog: log,
    });
    if (session?.naverAccount?.id && session.naverAccount.id !== naverAccount.id) {
      naverAccount = session.naverAccount;
      log(`계정 전환됨 → ${naverAccount.id} (등록 ${session.siteCount ?? '?'}개 한도 대응)`);
    }
    log('공유 네이버 로그인 창으로 색인 진행');
  } catch (e) {
    const msg = e?.message || String(e);
    if (/already running|userDataDir/i.test(msg)) {
      throw new Error(
        `네이버 Chrome 프로필이 다른 창에서 사용 중입니다.\n`
        + `열려 있는 네이버 Chrome 창을 모두 닫고, 우측 상단 「네이버 로그인」을 누른 뒤 다시 시도하세요.\n`
        + `(${msg})`,
      );
    }
    throw new Error(
      `네이버 세션 연결 실패: ${msg}\n`
      + `우측 상단 「네이버 로그인」으로 먼저 로그인한 뒤 다시 시도하세요.`,
    );
  }

  let deployInfo = null;
  const results = await registerNaverSites({
    sites: [{
      url: rootUrl,
      name: siteSlug || rootUrl,
      folder,
      siteDir: dir,
    }],
    headless: !!headless,
    metaInjectOnly: !!metaInjectOnly,
    openaiApiKey,
    yesCaptchaClientKey,
    naverAccount,
    browser: session?.browser || null,
    page: session?.page || null,
    keepBrowserOpen: !!session,
    skipLogin: !!session,
    // 메타가 이미(또는 이번에) 포함된 단일 배포만 — 추가 재배포로 크레딧 낭비 방지
    extraRedeployOnMiss: false,
    // 홈만 인덱싱(①) 생략 → 사이트맵+하위 URL 일괄 수집(②)만 수행
    skipIndexing: true,
    redeployCallback: async (_site, metaTag) => {
      log('네이버 HTML 인증 메타 → 전체 HTML head 삽입…');
      injectMetaAllHtml(dir, metaTag);
      if (firstDeploy) {
        log('메타 삽입 후 Netlify 최초 배포 (1회)…');
      } else {
        log('메타 반영 후 Netlify 재배포 (1회)…');
      }
      deployInfo = await deploySite({
        netlifyToken,
        siteName: siteSlug,
        dir,
        serviceName: siteSlug || 'kkang-site',
      });
      if (deployInfo?.url) {
        log(`배포 URL: ${deployInfo.url}`);
      }
    },
  });

  const first = Array.isArray(results) ? results[0] : null;
  const okStatuses = new Set(['success', 'already', 'manual']);
  if (!first) {
    throw new Error('네이버 등록 결과가 없습니다. (로그인/서치어드바이저 화면을 확인하세요)');
  }
  if (deployInfo) {
    first.deployed = true;
    first.deployUrl = deployInfo.url || '';
    first.siteId = deployInfo.siteId || '';
  }
  first.naverAccountId = first.naverAccountId || naverAccount.id;
  first.siteDir = first.siteDir || dir;
  first.folder = first.folder || folder;
  first.siteSlug = first.siteSlug || siteSlug || '';

  const st = String(first.status || '').toLowerCase();
  if (!okStatuses.has(st)) {
    // 캡챠 등: 메타 삽입·배포는 됐을 수 있음 → 호출측에서 계정/상태 저장 후 「수동캡챠」
    first.partial = true;
    first.metaDeployed = !!first.metaContent;
    if (st === 'captcha') {
      first.error = first.metaContent
        ? '소유확인 캡챠 실패 (메타 태그는 이미 배포됨) — 「수동캡챠」로 이어가세요'
        : '소유확인 캡챠 실패 — 「수동캡챠」로 다시 시도하세요';
    } else {
      first.error = first.error
        || (first.metaContent
          ? `네이버 소유확인 미완료 (${first.status || 'unknown'}) · 메타는 배포됨`
          : `네이버 소유확인 미완료 (${first.status || 'unknown'})`);
    }
    log(`⚠ 네이버 소유확인 미완료: ${first.status}${first.metaContent ? ' · 메타는 배포됨 → 수동캡챠 가능' : ' · 메타 미배포'}`);
    return first;
  }
  log(`네이버 등록 결과: ${first.status}${first.metaContent ? ` · meta=${String(first.metaContent).slice(0, 12)}…` : ''}`);

  try {
    const { countAdvisorRegisteredSites } = await import('./naver-session.js');
    const n = await countAdvisorRegisteredSites(session?.page || null, { forceReload: true });
    if (n != null) log(`서치어드바이저 등록 사이트: ${n}개`);
  } catch { /* ignore */ }

  // 하위 페이지 웹페이지 수집 (URL 수집 탭과 동일 로직) — 공유 세션 창 재사용
  if (collectSubpages && !metaInjectOnly) {
    try {
      const pageUrls = collectLocalSitePageUrls(dir, rootUrl.replace(/\/$/, ''));
      first.pageUrls = pageUrls;
      first.pageUrlCount = pageUrls.length;
      log(`═══ 하위 페이지 수집 (${pageUrls.length}개) — 빠르게 → robots → 사이트맵 → 웹수집 ═══`);
      for (const u of pageUrls.slice(0, 8)) log(`  · ${u}`);
      if (pageUrls.length > 8) log(`  · … 외 ${pageUrls.length - 8}개`);

      const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
      const collectOut = await submitNaverBulkCollection({
        sites: [{ homeUrl: rootUrl, urls: pageUrls }],
        naverAccount,
        openaiApiKey,
        yesCaptchaClientKey,
        outputRoot,
        sendLog: log,
        headless: !!headless,
        doFast: true,
        doRobots: true,
        doSitemap: true,
        doWebpage: true,
        browser: session?.browser || null,
        page: session?.page || null,
        keepBrowserOpen: !!session,
        skipLogin: !!session,
      });
      first.pageCollect = collectOut;
      const pagesOk = collectOut?.totals?.pagesOk ?? collectOut?.results?.[0]?.stats?.pagesOk;
      log(`✔ 하위 페이지 웹수집 완료${pagesOk != null ? ` · 성공 ${pagesOk}/${pageUrls.length}` : ''}`);
    } catch (e) {
      log(`[WARN] 하위 페이지 웹수집 실패: ${e.message}`);
      first.pageCollectError = e.message;
    }
  }

  return first;
}

/**
 * 캡챠 등으로 소유확인만 실패한 경우: 보드 검색 → 소유확인 진행 → 인덱싱
 * (메타 재추출·Netlify 재배포 없음)
 */
export async function retryNaverOwnershipAndIndex({
  siteUrl,
  siteDir = '',
  siteSlug = '',
  naverAccount: naverAccountArg,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  outputRoot,
  onLog,
  collectSubpages = true,
} = {}) {
  let naverAccount = naverAccountArg;
  const log = (msg) => { if (typeof onLog === 'function') onLog(String(msg)); };
  const rootUrl = String(siteUrl || '').replace(/\/?$/, '/');
  if (!rootUrl || rootUrl === '/') throw new Error('사이트 URL이 없습니다.');
  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error('네이버 계정이 필요합니다.');
  }

  const { confirmOwnershipViaBoard } = await import('./naver-ownership.js');
  const { setLogger } = await import('./logger.js');
  const { ensureNaverSession } = await import('./naver-session.js');

  const folder = path.join(
    outputRoot || path.join(process.cwd(), 'output'),
    `kkang-own-${siteSlug || 'site'}-${Date.now()}`,
  );
  fs.mkdirSync(folder, { recursive: true });

  log('═══ 네이버 색인재시도 (소유확인 → 인덱싱) ═══');
  log(`사이트: ${rootUrl}`);
  log(`계정: ${naverAccount.id}`);
  setLogger((msg) => log(String(msg).replace(/^\[.*?\]\s*/, '')));

  const session = await ensureNaverSession({
    naverAccount,
    naverAccounts,
    openaiApiKey,
    yesCaptchaClientKey,
    headless: !!headless,
    outputFolder: folder,
    onLog: log,
  });
  if (session?.naverAccount?.id && session.naverAccount.id !== naverAccount.id) {
    naverAccount = session.naverAccount;
    log(`계정 전환됨 → ${naverAccount.id}`);
  }
  const page = session.page;

  try {
    const ownership = await confirmOwnershipViaBoard(page, rootUrl, {
      openaiApiKey,
      yesCaptchaClientKey,
      outputFolder: folder,
      sendLog: log,
    });
    log(`소유확인: ${ownership.message || (ownership.ok ? 'OK' : '실패')}`);

    // 간단 인덱싱(①) 없이 사이트맵+하위 수집(②)만 수행
    let pageCollect = null;
    let indexOut = null;
    const dir = String(siteDir || '').trim();
    if (collectSubpages && dir && fs.existsSync(dir) && (ownership.ok || ownership.owned)) {
      try {
        const pageUrls = collectLocalSitePageUrls(dir, rootUrl.replace(/\/$/, ''));
        log(`═══ 하위 페이지 웹페이지 수집 (${pageUrls.length}개) — 빠르게/robots/사이트맵/웹수집 ═══`);
        const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
        pageCollect = await submitNaverBulkCollection({
          sites: [{ homeUrl: rootUrl, urls: pageUrls }],
          naverAccount,
          openaiApiKey,
          yesCaptchaClientKey,
          outputRoot,
          sendLog: log,
          headless: !!headless,
          doFast: true,
          doRobots: true,
          doSitemap: true,
          doWebpage: true,
          browser: session.browser,
          page: session.page,
          keepBrowserOpen: true,
          skipLogin: true,
        });
        indexOut = pageCollect;
      } catch (e) {
        log(`[WARN] 웹수집: ${e.message}`);
      }
    }

    if (!ownership.ok && !ownership.owned) {
      return {
        ok: false,
        status: 'captcha',
        error: ownership.message || '소유확인 실패',
        naverAccountId: naverAccount.id,
        ownership,
        indexOut,
      };
    }

    try {
      const { countAdvisorRegisteredSites } = await import('./naver-session.js');
      const n = await countAdvisorRegisteredSites(page, { forceReload: true });
      if (n != null) log(`서치어드바이저 등록 사이트: ${n}개`);
    } catch { /* ignore */ }

    return {
      ok: true,
      status: 'success',
      naverAccountId: naverAccount.id,
      ownership,
      indexOut,
      pageCollect,
      pageUrlCount: pageCollect?.results?.[0]?.urls?.length
        || pageCollect?.totals?.pagesOk
        || 0,
    };
  } finally {
    log('공유 네이버 세션 유지');
  }
}
