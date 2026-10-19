/**
 * Vercel Hobby: 로그인 계정별 프로젝트 100개 · 하루 배포 100회.
 * 주소 선점 → 네이버 HTML 소유확인 파일 → 같은 프로젝트에 배포 → 수집.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const VERCEL_PROJECT_CAP = 100;
export const VERCEL_DAILY_CAP = 100;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPublicFile(url, sendLog) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const text = await res.text();
      if (res.ok && text.trim() && text.length < 20000) {
        relay(sendLog, `소유확인 파일 공개됨: ${url}`);
        return true;
      }
    } catch { /* 배포 반영 전 */ }
    await sleep(2000);
  }
  relay(sendLog, `⚠ 소유확인 파일이 아직 안 열림: ${url}`);
  return false;
}

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

export function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function publicVercelAccount(account) {
  if (!account) return null;
  const day = account.deployDay === todayKey() ? Number(account.deployCount) || 0 : 0;
  const projects = Number(account.projectCount) || 0;
  return {
    userId: account.userId || '',
    username: account.username || '',
    teamId: account.teamId || '',
    teamSlug: account.teamSlug || '',
    projectCount: projects,
    deployCount: day,
    projectCap: VERCEL_PROJECT_CAP,
    dailyCap: VERCEL_DAILY_CAP,
    full: projects >= VERCEL_PROJECT_CAP || day >= VERCEL_DAILY_CAP,
  };
}

export function accountHasRoom(account) {
  const pub = publicVercelAccount(account);
  return !!pub && !pub.full && !!account.token;
}

export function pickVercelAccount(accounts, activeUserId = '') {
  const list = Array.isArray(accounts) ? accounts : [];
  const active = list.find((a) => a?.userId && a.userId === activeUserId);
  if (accountHasRoom(active)) return active;
  return list.find((a) => accountHasRoom(a)) || null;
}

function sanitizeSlug(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52);
  return s || 'site';
}

const KO_SLUG_WORDS = [
  ['핸드폰콘텐츠이용료', 'phone-content-fee'],
  ['휴대폰콘텐츠이용료', 'phone-content-fee'],
  ['핸드폰컨텐츠이용료', 'phone-content-fee'],
  ['핸드폰콘테츠이용료', 'phone-content-fee'],
  ['아이폰콘텐츠이용료', 'iphone-content-fee'],
  ['아이폰컨텐츠이용료', 'iphone-content-fee'],
  ['콘텐츠이용료', 'content-fee'],
  ['컨텐츠이용료', 'content-fee'],
  ['콘테츠이용료', 'content-fee'],
  ['정보이용료', 'info-fee'],
  ['소액결제', 'micropay'],
  ['현금화', 'cash'],
  ['핸드폰', 'phone'],
  ['휴대폰', 'mobile'],
  ['아이폰', 'iphone'],
  ['휴지폰', 'old-phone'],
  ['구글', 'google'],
  ['네이버', 'naver'],
  ['24시간', '24h'],
  ['당일', 'today'],
  ['급전', 'fast'],
  ['한도', 'limit'],
  ['조회', 'check'],
  ['콘텐츠', 'content'],
  ['컨텐츠', 'content'],
  ['콘테츠', 'content'],
  ['이용료', 'fee'],
].sort((a, b) => b[0].length - a[0].length);

const SLUG_SKIP_LATIN = new Set(['card', 'site', 'zip', 'tiket', 'ticket']);

function slugFromKoreanTitle(title) {
  const raw = String(title || '');
  const words = [];
  for (const word of raw.toLowerCase().match(/[a-z]{2,}/g) || []) {
    if (!SLUG_SKIP_LATIN.has(word)) words.push(word);
  }
  let rest = raw;
  for (let guard = 0; rest && guard < 40; guard += 1) {
    let best = null;
    let bestAt = -1;
    for (const pair of KO_SLUG_WORDS) {
      const at = rest.indexOf(pair[0]);
      if (at < 0) continue;
      if (bestAt < 0 || at < bestAt || (at === bestAt && pair[0].length > best[0].length)) {
        best = pair;
        bestAt = at;
      }
    }
    if (!best) break;
    words.push(best[1]);
    rest = rest.slice(bestAt + best[0].length);
  }
  const stem = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'landing';
  const n = 1000 + Math.floor(Math.random() * 9000);
  return sanitizeSlug(`${stem}-${n}`);
}

export function slugFromZipTitle(zipPath) {
  const base = path.basename(String(zipPath || ''), '.zip');
  if (/[가-힣]/.test(base)) return slugFromKoreanTitle(base);
  return sanitizeSlug(base);
}

export function slugFromZipPath(zipPath) {
  return slugFromZipTitle(zipPath);
}

async function vercelApi(token, apiPath, { method = 'GET', body, teamId } = {}) {
  const url = new URL(`https://api.vercel.com${apiPath}`);
  if (teamId) url.searchParams.set('teamId', teamId);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 240) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const VERCEL_CLI_CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp';

async function vercelOAuthMeta() {
  const res = await fetch('https://vercel.com/.well-known/openid-configuration', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Vercel 로그인 주소를 가져오지 못했습니다.');
  const json = await res.json().catch(() => ({}));
  if (!json?.device_authorization_endpoint || !json?.token_endpoint) {
    throw new Error('Vercel 로그인 설정이 올바르지 않습니다.');
  }
  return json;
}

export async function ensureFreshVercelToken(account) {
  if (!account?.token) return account;
  const exp = Number(account.expiresAt) || 0;
  const now = Math.floor(Date.now() / 1000);
  if (!account.refreshToken || (exp && exp - now > 120)) return account;
  const meta = await vercelOAuthMeta();
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: VERCEL_CLI_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error('Vercel 로그인 시간이 지났습니다. 다시 로그인하세요.');
  }
  account.token = json.access_token;
  if (json.refresh_token) account.refreshToken = json.refresh_token;
  if (typeof json.expires_in === 'number') account.expiresAt = now + json.expires_in;
  return account;
}

export async function refreshVercelAccount(account) {
  account = await ensureFreshVercelToken(account);
  const token = account?.token;
  if (!token) throw new Error('Vercel 토큰이 없습니다. 다시 로그인하세요.');
  const user = await vercelApi(token, '/v2/user');
  const username = user?.user?.username || account.username || '';
  const userId = user?.user?.id || account.userId || '';
  let teamId = account.teamId || '';
  let teamSlug = account.teamSlug || '';
  try {
    const teams = await vercelApi(token, '/v2/teams');
    const list = Array.isArray(teams?.teams) ? teams.teams : [];
    const found = list.find((t) => t.id === teamId) || list[0];
    if (found) {
      teamId = found.id || teamId;
      teamSlug = found.slug || teamSlug;
    }
  } catch { /* 개인 계정 */ }
  let projectCount = 0;
  let until = '';
  for (let page = 0; page < 30; page++) {
    const q = new URLSearchParams({ limit: '100' });
    if (until) q.set('until', until);
    const data = await vercelApi(token, `/v9/projects?${q}`, { teamId });
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    projectCount += projects.length;
    const next = data?.pagination?.next;
    if (!next || !projects.length) break;
    until = String(next);
  }
  const day = account.deployDay === todayKey() ? Number(account.deployCount) || 0 : 0;
  return {
    ...account,
    userId,
    username,
    teamId,
    teamSlug,
    projectCount,
    deployDay: todayKey(),
    deployCount: day,
  };
}

export async function startVercelDeviceLogin({ onVisit } = {}) {
  const meta = await vercelOAuthMeta();
  const authRes = await fetch(meta.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: VERCEL_CLI_CLIENT_ID,
      scope: 'openid offline_access',
    }),
  });
  const auth = await authRes.json().catch(() => ({}));
  if (!authRes.ok || !auth.device_code || !auth.verification_uri_complete) {
    throw new Error(auth.error_description || 'Vercel 로그인 코드를 받지 못했습니다.');
  }
  if (typeof onVisit === 'function') onVisit(auth.verification_uri_complete);
  let waitMs = Math.max(2, Number(auth.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(auth.expires_in) || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(waitMs);
    let tokenRes;
    try {
      tokenRes = await fetch(meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: VERCEL_CLI_CLIENT_ID,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: auth.device_code,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      waitMs = Math.min(waitMs * 2, 30000);
      continue;
    }
    const tokens = await tokenRes.json().catch(() => ({}));
    if (tokenRes.ok && tokens.access_token) {
      return {
        token: tokens.access_token,
        userId: '',
        teamId: '',
        refreshToken: tokens.refresh_token || '',
        expiresAt: Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) || 3600),
      };
    }
    const code = String(tokens.error || '');
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      waitMs += 5000;
      continue;
    }
    if (code === 'access_denied') throw new Error('Vercel 로그인이 취소되었습니다.');
    if (code === 'expired_token') throw new Error('로그인 시간이 지났습니다. 다시 로그인하세요.');
    throw new Error(tokens.error_description || 'Vercel 로그인에 실패했습니다.');
  }
  throw new Error('로그인 시간이 지났습니다. 다시 로그인하세요.');
}

async function createProject(account, name, sendLog) {
  try {
    const created = await vercelApi(account.token, '/v10/projects', {
      method: 'POST',
      teamId: account.teamId,
      body: { name, framework: null },
    });
    relay(sendLog, `프로젝트 생성: ${created.name || name}`);
    return created.name || name;
  } catch (e) {
    if (e.status === 409 || /already exists|conflict/i.test(e.message || '')) {
      relay(sendLog, `프로젝트 이름 사용 중: ${name}`);
      return '';
    }
    throw e;
  }
}

export async function reserveProjectName(account, preferred, sendLog) {
  const base = sanitizeSlug(preferred);
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    const got = await createProject(account, name, sendLog);
    if (got) return got;
  }
  throw new Error('사용 가능한 Vercel 프로젝트 이름을 만들지 못했습니다.');
}

function listSiteFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(current, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push({ rel: rel.replace(/\\/g, '/'), abs });
    }
  };
  walk(dir, '');
  return out;
}

async function uploadVercelFile(token, teamId, buf) {
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  const url = new URL('https://api.vercel.com/v2/files');
  if (teamId) url.searchParams.set('teamId', teamId);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'x-vercel-digest': sha,
    },
    body: buf,
  });
  if (res.status === 200 || res.status === 201 || res.status === 409) return sha;
  const text = await res.text();
  throw new Error(text.slice(0, 240) || `파일 업로드 실패 HTTP ${res.status}`);
}

async function deployDirectory(account, dir, name, sendLog) {
  const listed = listSiteFiles(dir);
  if (!listed.some((f) => f.rel === 'index.html' || f.rel.endsWith('/index.html'))) {
    throw new Error('배포 폴더에 index.html이 없습니다.');
  }
  const files = [];
  let bytes = 0;
  for (const f of listed) {
    const buf = fs.readFileSync(f.abs);
    if (buf.length > 9 * 1024 * 1024) {
      throw new Error(`파일이 너무 큽니다 (${f.rel}, ${Math.ceil(buf.length / 1024)}KB). 한 파일은 9MB 이하여야 합니다.`);
    }
    bytes += buf.length;
    const sha = await uploadVercelFile(account.token, account.teamId, buf);
    files.push({ file: f.rel, sha, size: buf.length });
  }
  relay(sendLog, `Vercel 배포 중 · 파일 ${files.length}개 · ${Math.ceil(bytes / 1024)}KB`);
  const data = await vercelApi(account.token, '/v13/deployments', {
    method: 'POST',
    teamId: account.teamId,
    body: {
      name,
      project: name,
      target: 'production',
      files,
      projectSettings: { framework: null },
    },
  });
  const aliases = []
    .concat(data?.alias || [])
    .concat(data?.automaticAliases || [])
    .map((a) => String(a || ''))
    .filter(Boolean);
  const bare = `${name}.vercel.app`;
  const normHost = (a) => String(a || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const host = aliases.some((a) => normHost(a) === bare) ? bare : (aliases.find((a) => normHost(a).endsWith('.vercel.app')) || bare);
  return {
    url: `https://${host.replace(/^https?:\/\//, '')}`,
    deploymentId: data?.id || '',
  };
}

export async function deployVercelZipSite({
  zipPath,
  projectName = '',
  account,
  registerNaver = true,
  naverAccount = null,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  outputRoot,
  sendLog,
} = {}) {
  await ensureFreshVercelToken(account);
  if (!account?.token) {
    const err = new Error('Vercel 로그인이 필요합니다.');
    err.code = 'VERCEL_LOGIN';
    throw err;
  }
  if (!accountHasRoom(account)) {
    const err = new Error('이 Vercel 계정은 프로젝트 100개 또는 오늘 배포 100회에 도달했습니다. 다음 아이디로 로그인하세요.');
    err.code = 'VERCEL_ACCOUNT_FULL';
    throw err;
  }

  const { resolveExistingZipPath, rewriteSitePublicUrls, saveRewrittenSiteAsSuccessZip, resolveZipSiteDir } = await import('./source-utils.js');
  const usedZipPath = resolveExistingZipPath(zipPath) || String(zipPath || '').trim();
  if (!usedZipPath || !fs.existsSync(usedZipPath)) {
    const err = new Error(`ZIP 파일이 없습니다: ${usedZipPath || zipPath}`);
    err.code = 'ZIP_MISSING';
    throw err;
  }

  relay(sendLog, '═══ Vercel ZIP 배포 ═══');
  relay(sendLog, `계정: ${account.username || account.teamSlug || account.userId} · 프로젝트 ${account.projectCount || 0}/100 · 오늘 ${account.deployDay === todayKey() ? account.deployCount || 0 : 0}/100`);
  relay(sendLog, `ZIP: ${path.basename(usedZipPath)}`);

  const manualName = String(projectName || '').trim();
  const preferred = manualName
    ? (/[가-힣]/.test(manualName) ? slugFromKoreanTitle(manualName) : sanitizeSlug(manualName))
    : slugFromZipTitle(usedZipPath);
  relay(sendLog, `사이트 이름: ${path.basename(usedZipPath)} → ${preferred}`);
  let slug = '';
  try {
  slug = await reserveProjectName(account, preferred, sendLog);
  const rootUrlBare = `https://${slug}.vercel.app`;
  relay(sendLog, `주소 확정: ${rootUrlBare}`);

  const extractRoot = path.join(outputRoot || process.cwd(), 'vercel-zip-extract', `${slug}-${Date.now()}`);
  fs.mkdirSync(extractRoot, { recursive: true });
  const resolved = await resolveZipSiteDir(usedZipPath, extractRoot);
  const localDir = resolved.htmlDir;
  if (!fs.existsSync(path.join(localDir, 'index.html'))) {
    throw new Error(`업로드할 index.html이 없습니다: ${localDir}`);
  }
  try {
    rewriteSitePublicUrls(localDir, rootUrlBare, sendLog);
  } catch (e) {
    relay(sendLog, `⚠ 사이트 URL 재작성 경고: ${e.message}`);
  }

  let naverFile = null;
  let session = null;
  if (registerNaver) {
    if (!naverAccount?.id || !naverAccount?.pw) {
      throw new Error('설정 탭에 네이버 계정(아이디/비밀번호)을 등록하세요.');
    }
    const { ensureNaverSession } = await import('./naver-session.js');
    session = await ensureNaverSession({
      naverAccount,
      naverAccounts,
      openaiApiKey,
      yesCaptchaClientKey,
      headless: !!headless,
      onLog: sendLog,
    });
    const { downloadNaverOwnershipHtml } = await import('./vercel-naver-html.js');
    naverFile = await downloadNaverOwnershipHtml({
      page: session.page,
      siteUrl: rootUrlBare,
      siteDir: localDir,
      sendLog,
    });
  }

  const deployed = await deployDirectory(account, localDir, slug, sendLog);
  const deployedUrl = String(deployed.url || rootUrlBare).replace(/\/$/, '');
  const siteUrl = rootUrlBare;
  relay(sendLog, `✔ 배포 완료: ${siteUrl}`);
  if (deployedUrl !== siteUrl) relay(sendLog, `배포 별칭: ${deployedUrl}`);

  let movedZip = null;
  try {
    const mv = await saveRewrittenSiteAsSuccessZip(localDir, usedZipPath);
    if (mv?.ok && mv.path) {
      movedZip = { from: mv.from || usedZipPath, to: mv.path, rewritten: !!mv.rewritten };
      relay(sendLog, `📦 성공 ZIP: 성공\\${path.basename(mv.path)}`);
    } else if (mv?.error) {
      relay(sendLog, `⚠ 성공 ZIP 저장 실패: ${mv.error}`);
    }
  } catch (e) {
    relay(sendLog, `⚠ 성공 ZIP 저장 예외: ${e.message}`);
  }

  let naverStatus = '';
  let naverError = '';
  let pageCollect = null;
  if (registerNaver && session?.page) {
    relay(sendLog, '배포 완료 — 소유확인과 수집을 이어서 진행합니다.');
    let fileLive = false;
    if (naverFile?.fileName) {
      fileLive = await waitForPublicFile(`${siteUrl}/${encodeURIComponent(naverFile.fileName)}`, sendLog);
      if (!fileLive) naverError = '소유확인 파일이 사이트에 열려 있지 않습니다';
    }
    let ownershipConfirmed = false;
    try {
      const { confirmOwnershipViaBoard } = await import('./naver-ownership.js');
      const own = await confirmOwnershipViaBoard(session.page, siteUrl, {
        openaiApiKey,
        yesCaptchaClientKey,
        outputFolder: outputRoot,
        sendLog,
        verifyMethod: 'file',
      });
      ownershipConfirmed = !!own?.ok && own?.neededVerify === true;
      relay(sendLog, own?.message || (ownershipConfirmed ? '소유확인 완료' : '소유확인 미완료'));
      if (!ownershipConfirmed && !naverError) naverError = own?.message || '소유확인 미완료';
    } catch (e) {
      naverError = e.message;
      relay(sendLog, `⚠ 소유확인: ${e.message}`);
    }
    try {
      const { collectLocalSitePageUrls } = await import('./kkang-site-builder.js');
      const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
      const pageUrls = collectLocalSitePageUrls(localDir, siteUrl);
      relay(sendLog, `═══ 수집주기·페이지 수집 (${pageUrls.length}개) ═══`);
      pageCollect = await submitNaverBulkCollection({
        sites: [{ homeUrl: siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`, urls: pageUrls }],
        naverAccount,
        openaiApiKey,
        yesCaptchaClientKey,
        outputRoot,
        sendLog,
        headless: !!headless,
        doFast: true,
        doRobots: true,
        doSitemap: true,
        doWebpage: true,
        browser: session.browser,
        page: session.page,
        keepBrowserOpen: true,
        skipLogin: true,
        skipOwnership: !!ownershipConfirmed,
        verifyMethod: 'file',
      });
      const ok = pageCollect?.totals?.pagesOk ?? 0;
      const fail = pageCollect?.totals?.pagesFail ?? 0;
      const collectMsg = String(pageCollect?.sites?.[0]?.message || pageCollect?.message || '');
      relay(sendLog, `페이지 수집 — ${ok}성공/${fail}실패`);
      const unregistered = /미등록|권한 없음/.test(collectMsg);
      if (ok > 0 && !unregistered) {
        naverStatus = 'success';
        naverError = '';
      } else {
        naverStatus = 'captcha';
        naverError = unregistered
          ? '서치어드바이저에 사이트가 등록되어 있지 않습니다. 수동캡챠 또는 선택 캡챠 자동으로 이어가세요.'
          : (naverError || `웹페이지 수집 실패 (${ok}성공/${fail}실패). 수동캡챠로 이어가세요.`);
      }
    } catch (e) {
      naverStatus = 'captcha';
      naverError = naverError || e.message;
      relay(sendLog, `[WARN] 페이지 수집: ${e.message}`);
    }
    if (!naverStatus) naverStatus = naverError ? 'captcha' : (ownershipConfirmed && fileLive ? 'success' : 'captcha');
  }

  return {
    ok: true,
    projectName: slug,
    siteUrl,
    siteDir: localDir,
    sourcePath: usedZipPath,
    movedZip,
    naverFile,
    naverStatus,
    naverError,
    pageCollect,
    account,
    reservedProject: true,
  };
  } catch (e) {
    if (slug) {
      e.reservedProject = slug;
      e.vercelUserId = account.userId;
    }
    throw e;
  }
}

export { sleep };
