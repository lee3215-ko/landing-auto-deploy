/**
 * Cloudflare Pages ZIP → URL 치환 → 네이버 메타 선수집 → Pages 1회 배포 → 수집
 */
import fs from 'fs';
import path from 'path';
import {
  deployPagesDirectory,
  pagesDevUrl,
  sanitizePagesSlug,
  ensurePagesProject,
  getPagesProject,
} from './cloudflare-pages.js';

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

/** ZIP 파일명 → Pages 프로젝트 slug */
export function slugFromZipPath(zipPath = '') {
  const base = path.basename(String(zipPath || ''), path.extname(String(zipPath || '')));
  return sanitizePagesSlug(base) || `landing-${Date.now().toString(36).slice(-6)}`;
}

/**
 * 프로젝트명 충돌 시 접미사 부여
 * @param {string} preferred
 * @param {{ accountId:string, apiToken:string }} creds
 */
export async function resolveUniquePagesSlug(preferred, { accountId, apiToken, sendLog } = {}) {
  let base = sanitizePagesSlug(preferred) || `landing-${Date.now().toString(36).slice(-6)}`;
  if (!accountId || !apiToken) return base;

  for (let i = 0; i < 12; i++) {
    const candidate = i === 0 ? base : sanitizePagesSlug(`${base}-${i + 1}`) || `${base}${i + 1}`;
    try {
      await getPagesProject(accountId, apiToken, candidate);
      // 존재함 → 다음 후보 (재배포가 아니라 새 ZIP이면 충돌 회피)
      relay(sendLog, `프로젝트명 사용 중 → 다음 후보: ${candidate}`);
    } catch (e) {
      if (e.status === 404 || /not found|does not exist|404/i.test(`${e.status} ${e.message}`)) {
        return candidate;
      }
      // 조회 실패 시 preferred로 진행 (ensure에서 생성/재사용)
      relay(sendLog, `⚠ 프로젝트 조회 실패(${e.message}) — ${candidate} 로 진행`);
      return candidate;
    }
  }
  return sanitizePagesSlug(`${base}-${Date.now().toString(36).slice(-4)}`) || base;
}

async function registerNaverForCloudflare({
  projectName,
  siteDir,
  siteRootUrl,
  accountId,
  apiToken,
  naverAccount,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  metaInjectOnly = false,
  outputRoot,
  sendLog,
  onDeployed = null,
}) {
  let rootUrl = String(siteRootUrl || '').replace(/\/?$/, '/');
  if (!rootUrl || rootUrl === '/') {
    throw new Error('네이버 등록용 사이트 URL이 없습니다.');
  }
  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error('네이버 계정이 필요합니다. 설정 탭에 네이버 아이디/비밀번호를 등록하세요.');
  }

  const { registerNaverSites, injectMetaAllHtml } = await import('./naver-register.js');
  const { setLogger } = await import('./logger.js');
  const { ensureNaverSession } = await import('./naver-session.js');
  const folder = path.join(
    outputRoot || path.join(process.cwd(), 'output'),
    `cf-naver-${projectName}-${Date.now()}`,
  );
  fs.mkdirSync(folder, { recursive: true });

  relay(sendLog, '═══ 네이버 HTML 태그 선수집 → 메타 삽입 → Pages 1회 배포 ═══');
  relay(sendLog, `사이트: ${rootUrl}`);
  relay(sendLog, `계정: ${naverAccount.id}`);
  setLogger((msg) => {
    const t = String(msg).replace(/^\[.*?\]\s*/, '');
    if (typeof sendLog === 'function') sendLog(t);
  });

  let session = null;
  let deployed = false;
  let deployInfo = null;
  try {
    try {
      session = await ensureNaverSession({
        naverAccount,
        naverAccounts,
        openaiApiKey,
        yesCaptchaClientKey,
        headless: !!headless,
        outputFolder: folder,
        onLog: sendLog,
      });
      if (session?.naverAccount?.id && session.naverAccount.id !== naverAccount.id) {
        naverAccount = session.naverAccount;
        relay(sendLog, `계정 전환됨 → ${naverAccount.id}`);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      if (/already running|userDataDir/i.test(msg)) {
        throw new Error(
          `네이버 Chrome 프로필이 다른 창에서 사용 중입니다.\n`
          + `열려 있는 네이버 Chrome 창을 모두 닫고 「네이버 로그인」후 다시 시도하세요.\n(${msg})`,
        );
      }
      throw new Error(
        `네이버 세션 연결 실패: ${msg}\n우측 상단 「네이버 로그인」으로 먼저 로그인한 뒤 다시 시도하세요.`,
      );
    }

    const results = await registerNaverSites({
      sites: [{
        url: rootUrl,
        name: projectName || rootUrl,
        folder,
        siteDir,
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
      skipIndexing: true,
      metaLiveMaxWaitMs: 120_000,
      extraRedeployOnMiss: true,
      redeployCallback: async (_site, metaTag) => {
        relay(sendLog, '네이버 HTML 인증 메타 → 전체 HTML 주입…');
        injectMetaAllHtml(siteDir, metaTag);
        relay(sendLog, deployed
          ? '메타 반영 후 Pages 재업로드…'
          : '메타 삽입 후 Pages 최초 배포 (1회)…');
        deployInfo = await deployPagesDirectory({
          accountId,
          apiToken,
          projectName,
          siteDir,
          sendLog,
        });
        deployed = true;
        if (typeof onDeployed === 'function') {
          try { await onDeployed(deployInfo); } catch { /* ignore */ }
        }
      },
    });

    const first = Array.isArray(results) ? results[0] : null;
    const okStatuses = new Set(['success', 'already', 'manual']);
    if (!first) {
      throw new Error('네이버 등록 결과가 없습니다. (로그인/서치어드바이저 화면을 확인하세요)');
    }
    if (first.status === 'error' || !okStatuses.has(first.status)) {
      const err = new Error(first.error || `네이버 등록 실패 (상태: ${first.status || 'unknown'})`);
      err.naverStatus = first.status || 'error';
      err.failKind = first.failKind || first.status || '';
      err.deployOk = deployed;
      err.deployInfo = deployInfo;
      throw err;
    }
    first.naverAccountId = first.naverAccountId || naverAccount.id;
    first.deployOk = deployed;
    first.deployInfo = deployInfo;
    first.url = first.url || rootUrl;
    relay(sendLog, `네이버 등록 결과: ${first.status}${first.metaContent ? ` · meta=${String(first.metaContent).slice(0, 12)}…` : ''}`);
    return first;
  } finally {
    setLogger(null);
  }
}

/**
 * ZIP 1개 → Pages 배포 + 네이버 색인
 */
export async function deployCloudflareZipSite({
  zipPath,
  projectName = '',
  accountId,
  apiToken,
  registerNaver = true,
  naverAccount = null,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  metaInjectOnly = false,
  outputRoot,
  /** true면 기존 동명 프로젝트 재사용 (다시 배포) */
  reuseProject = false,
  sendLog,
} = {}) {
  if (!accountId) throw new Error('Cloudflare Account ID가 필요합니다.');
  if (!apiToken) throw new Error('Cloudflare API Token이 필요합니다.');

  const { resolveExistingZipPath, rewriteSitePublicUrls, saveRewrittenSiteAsSuccessZip, resolveZipSiteDir } = await import('./source-utils.js');
  let usedZipPath = resolveExistingZipPath(zipPath) || String(zipPath || '').trim();
  if (!usedZipPath) throw new Error('ZIP 경로가 없습니다.');
  if (!fs.existsSync(usedZipPath)) {
    const err = new Error(`ZIP 파일이 없습니다: ${usedZipPath}`);
    err.code = 'ZIP_MISSING';
    err.zipMissing = true;
    throw err;
  }

  relay(sendLog, '═══ Cloudflare Pages ZIP 배포 ═══');
  relay(sendLog, `ZIP: ${path.basename(usedZipPath)}`);

  const preferred = sanitizePagesSlug(projectName) || slugFromZipPath(usedZipPath);
  let slug = preferred;
  if (reuseProject) {
    await ensurePagesProject(accountId, apiToken, slug, { sendLog });
  } else {
    slug = await resolveUniquePagesSlug(preferred, { accountId, apiToken, sendLog });
    // 첫 후보가 기존과 같으면(조회 실패 등으로 preferred 유지) ensure에서 생성/재사용
    await ensurePagesProject(accountId, apiToken, slug, { sendLog });
  }

  const rootUrlBare = pagesDevUrl(slug);
  const rootUrl = `${rootUrlBare}/`;
  relay(sendLog, `Pages URL: ${rootUrlBare}`);

  const extractRoot = path.join(
    outputRoot || process.cwd(),
    'cf-zip-extract',
    `${slug}-${Date.now()}`,
  );
  fs.mkdirSync(extractRoot, { recursive: true });
  const resolved = await resolveZipSiteDir(usedZipPath, extractRoot);
  const localDir = resolved.htmlDir;
  relay(sendLog, `ZIP 사이트 루트: ${localDir}`);

  if (!fs.existsSync(path.join(localDir, 'index.html'))) {
    throw new Error(`업로드할 index.html이 없습니다: ${localDir}`);
  }

  try {
    rewriteSitePublicUrls(localDir, rootUrlBare, sendLog);
  } catch (e) {
    relay(sendLog, `⚠ 사이트 URL 재작성 경고: ${e.message}`);
  }

  let movedZip = null;
  let deployOk = false;
  let deployInfo = null;
  const moveZipAfterDeploy = async () => {
    if (!usedZipPath || movedZip) return;
    try {
      const mv = await saveRewrittenSiteAsSuccessZip(localDir, usedZipPath);
      if (mv?.ok && mv.rewritten) {
        movedZip = { from: mv.from, to: mv.path, rewritten: true };
        relay(sendLog, `📦 성공 ZIP 저장(주소 반영본): 성공\\${path.basename(mv.path)}`);
      } else if (mv?.ok && mv.skipped) {
        movedZip = { from: mv.from, to: mv.path, skipped: true };
      } else if (mv?.ok) {
        movedZip = { from: mv.from, to: mv.path, rewritten: false };
        relay(sendLog, `📦 성공 ZIP 이동: 성공\\${path.basename(mv.path)}`);
      } else if (mv?.error) {
        relay(sendLog, `⚠ 성공 ZIP 저장 실패: ${mv.error}`);
      }
    } catch (e) {
      relay(sendLog, `⚠ 성공 ZIP 저장 예외: ${e.message}`);
    }
  };

  let naverResult = null;
  let pageCollect = null;

  if (registerNaver) {
    if (!naverAccount?.id || !naverAccount?.pw) {
      throw new Error('설정 탭에 네이버 계정(아이디/비밀번호)을 등록하세요.');
    }
    try {
      naverResult = await registerNaverForCloudflare({
        projectName: slug,
        siteDir: localDir,
        siteRootUrl: rootUrl,
        accountId,
        apiToken,
        naverAccount,
        naverAccounts,
        openaiApiKey,
        yesCaptchaClientKey,
        headless,
        metaInjectOnly,
        outputRoot,
        sendLog,
        onDeployed: async (info) => {
          deployOk = true;
          deployInfo = info;
          await moveZipAfterDeploy();
        },
      });
      deployOk = deployOk || !!naverResult?.deployOk;
      deployInfo = deployInfo || naverResult?.deployInfo || null;
      if (deployOk && !movedZip) await moveZipAfterDeploy();

      try {
        const { collectLocalSitePageUrls } = await import('./kkang-site-builder.js');
        const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
        const { ensureNaverSession } = await import('./naver-session.js');
        const collectBase = String(naverResult?.url || rootUrl).replace(/\/$/, '');
        const pageUrls = collectLocalSitePageUrls(localDir, collectBase);
        relay(sendLog, `═══ Pages 하위 페이지 수집 (${pageUrls.length}개) — 사이트맵·웹수집 ═══`);
        let session = null;
        try {
          session = await ensureNaverSession({
            naverAccount,
            naverAccounts,
            openaiApiKey,
            yesCaptchaClientKey,
            headless: !!headless,
            onLog: sendLog,
          });
        } catch (e) {
          relay(sendLog, `⚠ 공유 세션 재사용 실패 — 하위 수집 건너뜀: ${e.message}`);
        }
        if (session) {
          pageCollect = await submitNaverBulkCollection({
            sites: [{ homeUrl: collectBase.endsWith('/') ? collectBase : `${collectBase}/`, urls: pageUrls }],
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
          });
          const ok = pageCollect?.totals?.pagesOk ?? 0;
          const fail = pageCollect?.totals?.pagesFail ?? 0;
          relay(sendLog, `✔ 하위 수집 완료 — 페이지 ${ok}성공/${fail}실패`);
        }
      } catch (e) {
        relay(sendLog, `[WARN] 사이트맵/하위 웹수집: ${e.message}`);
      }
    } catch (e) {
      const err = new Error(e?.message || String(e));
      err.deployOk = !!(e?.deployOk || deployOk);
      err.movedZip = movedZip;
      err.siteDir = localDir;
      err.siteUrl = rootUrl;
      err.projectName = slug;
      err.sourcePath = movedZip?.to || usedZipPath || '';
      err.naverStatus = e?.naverStatus || '';
      err.failKind = e?.failKind || '';
      err.deployInfo = e?.deployInfo || deployInfo;
      throw err;
    }
  } else {
    deployInfo = await deployPagesDirectory({
      accountId,
      apiToken,
      projectName: slug,
      siteDir: localDir,
      sendLog,
    });
    deployOk = true;
    await moveZipAfterDeploy();
  }

  const siteUrl = String(deployInfo?.url || rootUrlBare).replace(/\/$/, '');
  relay(sendLog, `사이트: ${siteUrl}`);

  return {
    ok: true,
    siteUrl,
    homeUrl: siteUrl,
    rootUrl,
    projectName: slug,
    siteDir: localDir,
    sourcePath: movedZip?.to || usedZipPath || '',
    sourceType: 'zip',
    movedZip,
    deployOk,
    deployInfo,
    naver: naverResult,
    pageCollect,
  };
}
