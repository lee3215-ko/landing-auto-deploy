import fs from 'fs';
import path from 'path';
import { buildHTML, buildSitemap, buildRobots, getRandomColor } from './builder.js';
import { writeSiteBundle, buildSitemapWithPages } from './ai-site-generator.js';
import { deploySite, resolveDeployRoot, validateNetlifyToken } from './deploy.js';
import { getTitleFromSource, fallbackSourceName, resolveZipSiteDir } from './source-utils.js';
import { createFileLogger, setLogger, step, action, error, warn } from './logger.js';
import { checkpoint, resetRunControl, RunStopped } from './run-pause.js';

const OUTPUT_ROOT = process.env.OUTPUT_ROOT || path.join(process.cwd(), 'output');

function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function slugifySiteName() {
  return 'site-' + Math.random().toString(36).substring(2, 6);
}

async function buildExpandedList(services, sources) {
  if (sources.length > 0) {
    const defaultSvc = services[0] || { keyword: '', phone: '010-0000-0000' };
    const expanded = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      let title = '';
      try {
        title = await getTitleFromSource(src);
      } catch (e) {
        warn(`타이틀 추출 실패 (${src.name}): ${e.message}`);
      }
      expanded.push({
        keyword: defaultSvc.keyword || '',
        phone: defaultSvc.phone || '010-0000-0000',
        displayName: title || fallbackSourceName(src),
        originalName: src.name,
        index: i,
        source: src,
      });
    }
    return expanded;
  }

  const expanded = [];
  let globalIdx = 0;
  for (const svc of services) {
    const count = Math.max(1, parseInt(svc.count) || 1);
    for (let c = 0; c < count; c++) {
      expanded.push({
        ...svc,
        displayName: svc.name,
        originalName: svc.name,
        index: globalIdx++,
      });
    }
  }
  return expanded;
}

/** ZIP/폴더 → 출력 폴더에 안정 siteDir 준비 (injectMetaAllHtml 용) */
async function prepareSiteDir({
  folder,
  usingSource,
  sourceType,
  sourcePath,
  displayName,
  siteUrl,
  title,
  description,
  keywords,
  svc,
  openaiApiKey,
  seoOptions,
  relay,
}) {
  fs.mkdirSync(folder, { recursive: true });

  if (!usingSource) {
    let siteBundle = null;
    try {
      siteBundle = await writeSiteBundle({
        outputFolder: folder,
        name: displayName,
        keyword: svc.keyword || displayName,
        phone: svc.phone || '010-0000-0000',
        siteUrl,
        color: getRandomColor(),
        metaTitle: title,
        metaDescription: description,
        metaKeywords: keywords,
        openaiApiKey,
        sendLog: relay,
      });
    } catch (e) {
      error(`[${displayName}] AI 사이트 생성 실패, 기본 템플릿 사용: ${e.message}`);
      const html = buildHTML({
        name: displayName,
        slogan: title,
        phone: svc.phone || '010-0000-0000',
        keyword: svc.keyword,
        metaKeywords: keywords,
        metaDescription: description,
      }, siteUrl);
      action(`[${displayName}] index.html 작성 (기본)`);
      fs.writeFileSync(path.join(folder, 'index.html'), html, 'utf8');
    }

    if (seoOptions?.generateSitemap) {
      action(`[${displayName}] sitemap.xml 작성`);
      const sitemap = siteBundle?.slugs?.length
        ? buildSitemapWithPages(siteUrl, siteBundle.slugs)
        : buildSitemap(siteUrl);
      fs.writeFileSync(path.join(folder, 'sitemap.xml'), sitemap, 'utf8');
    }
    if (seoOptions?.generateRobots) {
      action(`[${displayName}] robots.txt 작성`);
      fs.writeFileSync(path.join(folder, 'robots.txt'), buildRobots(siteUrl), 'utf8');
    }
    return folder;
  }

  if (sourceType === 'zip' && sourcePath) {
    const { htmlDir, indexRel } = await resolveZipSiteDir(sourcePath, folder);
    step(`[${displayName}] ZIP 압축 해제 — 사이트 폴더: ${indexRel}`);
    // index.html이 다른 이름이면 Netlify용 복사
    const base = path.basename(indexRel);
    if (base.toLowerCase() !== 'index.html') {
      const sourceHtml = path.join(htmlDir, base);
      const targetHtml = path.join(htmlDir, 'index.html');
      if (fs.existsSync(sourceHtml) && !fs.existsSync(targetHtml)) {
        fs.copyFileSync(sourceHtml, targetHtml);
        step(`[${displayName}] Netlify 인식용 index.html 생성`);
      }
    }
    return htmlDir;
  }

  if (sourceType === 'folder' && sourcePath) {
    const root = resolveDeployRoot(sourcePath);
    // 원본 폴더를 직접 수정하지 않도록 출력 폴더로 복사
    fs.cpSync(root, folder, { recursive: true });
    step(`[${displayName}] 폴더 소스 복사 → ${folder}`);
    return folder;
  }

  return folder;
}

function pickAvailableTokenIndexes(netlifyTokens) {
  return netlifyTokens
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !t?.used)
    .map(({ idx }) => idx);
}

export async function runFullPipeline(config, sendLog = null) {
  resetRunControl();
  const results = [];
  let stopped = false;
  const {
    netlifyTokens,
    naverAccounts,
    openaiApiKey,
    services,
    seoOptions,
    deploySources,
    headless = false,
    metaInjectOnly = false,
  } = config;
  const outputRoot = config.outputRoot || OUTPUT_ROOT;

  if (!netlifyTokens.length) throw new Error('Netlify 토큰이 하나 이상 필요합니다.');
  if (!naverAccounts.length) throw new Error('네이버 계정이 하나 이상 필요합니다.');

  const sources = Array.isArray(deploySources) ? deploySources : [];
  if (!sources.length && !services.length) {
    throw new Error('등록할 서비스 또는 배포 ZIP/폴더 소스가 필요합니다.');
  }
  if (!sources.length) {
    const titles = seoOptions?.metaTitles || [];
    const descriptions = seoOptions?.metaDescriptions || [];
    const keywords = seoOptions?.metaKeywords || [];
    if (!titles.length || !descriptions.length || !keywords.length) {
      throw new Error('자동 생성 배포 시 메타 타이틀, 디스크립션, 키워드가 각각 최소 1개 이상 필요합니다.');
    }
  }

  const metaTitles = seoOptions?.metaTitles?.length ? seoOptions.metaTitles : ['{name} | {keyword}'];
  const metaDescriptions = seoOptions?.metaDescriptions?.length ? seoOptions.metaDescriptions : ['{name}를 찾고 계신가요?'];
  const metaKeywords = seoOptions?.metaKeywords?.length ? seoOptions.metaKeywords : ['{keyword}'];

  const logDir = path.join(outputRoot, 'logs');
  const fileLogger = createFileLogger(logDir);
  setLogger(fileLogger);

  const relay = (msg) => {
    fileLogger(msg);
    if (sendLog) sendLog(msg);
  };

  const markTokenUsed = (idx) => {
    if (typeof netlifyTokens[idx] === 'object' && netlifyTokens[idx]) {
      netlifyTokens[idx].used = true;
    }
    relay(`[TOKEN_USED] ${idx}`);
  };

  step('Netlify 토큰 유효성 검사...');
  let validTokenCount = 0;
  for (let i = 0; i < netlifyTokens.length; i++) {
    const t = netlifyTokens[i];
    if (t?.used) continue;
    const token = typeof t === 'string' ? t : (t?.token || '');
    const check = await validateNetlifyToken(token);
    if (check.ok) {
      validTokenCount += 1;
      relay(`✅ 토큰 ${i + 1} 유효${check.email ? ` (${check.email})` : ''}`);
    } else {
      error(`❌ 토큰 ${i + 1} 무효: ${check.error}`);
      error(`  → https://app.netlify.com/user/applications#personal-access-tokens 에서 새 토큰을 발급하세요.`);
      markTokenUsed(i);
    }
  }
  if (!validTokenCount) {
    throw new Error('유효한 Netlify 토큰이 없습니다. 설정 탭에서 Personal Access Token을 새로 발급해 넣어주세요.');
  }
  step(`유효한 Netlify 토큰: ${validTokenCount}개`);

  step('=== 전체 파이프라인 시작 (메타 선수집 → 1회 배포 → 소유확인 → 사이트맵·하위 페이지 수집) ===');
  step(`대상: ${sources.length ? `소스 ${sources.length}개` : `서비스 ${services.length}개`}, Netlify 토큰: ${netlifyTokens.length}, 네이버 계정: ${naverAccounts.length}`);
  step(`브라우저 모드: ${headless ? '헤드리스(창 숨김)' : '창 표시'}`);
  step(`소유확인: ${metaInjectOnly ? '메타 태그만 주입 (버튼 생략 · 수동 확인)' : '자동 소유확인 + 빠르게/robots/사이트맵/웹수집'}`);
  if (sources.length) {
    step(`배포 소스: ${sources.length}개 (zip ${sources.filter((s) => s.type === 'zip').length}개, folder ${sources.filter((s) => s.type === 'folder').length}개)`);
  }

  const expanded = await buildExpandedList(services, sources);
  if (!expanded.length) throw new Error('배포할 사이트가 없습니다.');

  const BATCH_SIZE = 10;
  const deployedSites = [];
  const failedServices = [];
  const tokenUsageCount = {};

  const { registerNaverMetaForKkangSite } = await import('./kkang-site-builder.js');

  try {
    for (let batchStart = 0; batchStart < expanded.length; batchStart += BATCH_SIZE) {
      await checkpoint(relay);
      const batch = expanded.slice(batchStart, batchStart + BATCH_SIZE);
      step(`=== 배치 ${Math.floor(batchStart / BATCH_SIZE) + 1} 시작 (사이트 ${batchStart + 1} ~ ${Math.min(batchStart + BATCH_SIZE, expanded.length)} / ${expanded.length}) ===`);

      for (let i = 0; i < batch.length; i++) {
        await checkpoint(relay);
        const svc = batch[i];
        const globalIndex = batchStart + i;
        const siteName = slugifySiteName();
        const folder = path.join(outputRoot, siteName);

        const titleTemplate = pickRandom(metaTitles);
        const descTemplate = pickRandom(metaDescriptions);
        const kwTemplate = pickRandom(metaKeywords);
        const usingSource = !!(svc.source || (sources.length && globalIndex < sources.length));
        const displayName = svc.displayName
          || titleTemplate.replace(/{keyword}/g, svc.keyword || '');
        const title = displayName;
        const description = descTemplate.replace(/{keyword}/g, svc.keyword || '');
        const keywords = kwTemplate.replace(/{keyword}/g, svc.keyword || '');
        const siteUrl = `https://${siteName}.netlify.app`;
        const naverAccount = naverAccounts[globalIndex % naverAccounts.length];

        step(`[${displayName}] 사이트 준비 (${globalIndex + 1}/${expanded.length}) · ${siteUrl}`);

        const availableIndexes = pickAvailableTokenIndexes(netlifyTokens);
        if (!availableIndexes.length) {
          error(`[${displayName}] 사용 가능한 Netlify 토큰이 없습니다. 나머지 사이트 생성을 중단합니다.`);
          failedServices.push({ name: displayName, error: '사용 가능한 Netlify 토큰이 없습니다.' });
          for (let j = i + 1; j < batch.length; j++) {
            failedServices.push({
              name: batch[j].displayName || batch[j].keyword || `site-${j}`,
              error: '유효한 Netlify 토큰 없음 — 중단',
            });
          }
          break;
        }

        let sourcePath = null;
        let sourceType = null;
        if (svc.source) {
          sourcePath = svc.source.path;
          sourceType = svc.source.type;
          step(`[${displayName}] 배포 소스: ${svc.source.name} (${sourceType})`);
        } else if (sources.length && globalIndex < sources.length) {
          const src = sources[globalIndex];
          sourcePath = src.path;
          sourceType = src.type;
          step(`[${displayName}] 배포 소스 우선 사용: ${src.name} (${sourceType})`);
        } else {
          step(`[${displayName}] 자동 생성 HTML`);
        }

        let siteDir;
        try {
          siteDir = await prepareSiteDir({
            folder,
            usingSource,
            sourceType,
            sourcePath,
            displayName,
            siteUrl,
            title,
            description,
            keywords,
            svc,
            openaiApiKey,
            seoOptions,
            relay,
          });
        } catch (e) {
          error(`[${displayName}] 사이트 준비 실패: ${e.message}`);
          failedServices.push({ name: displayName, error: e.message });
          results.push({
            url: siteUrl,
            name: displayName,
            status: 'error',
            error: e.message,
            naverAccountId: naverAccount?.id || '',
            registeredAt: new Date().toISOString(),
          });
          continue;
        }

        if (!naverAccount?.id || !naverAccount?.pw) {
          error(`[${displayName}] 네이버 계정 없음 — 건너뜀`);
          failedServices.push({ name: displayName, error: '네이버 계정 정보가 없습니다.' });
          results.push({
            url: siteUrl,
            name: displayName,
            status: 'error',
            error: '네이버 계정 정보가 없습니다.',
            registeredAt: new Date().toISOString(),
          });
          continue;
        }

        let usedTokenIndex = availableIndexes[globalIndex % availableIndexes.length];
        const triedIndexes = new Set();
        let naverResult = null;
        let lastErr = null;
        let authFailedAll = false;

        while (triedIndexes.size < availableIndexes.length) {
          triedIndexes.add(usedTokenIndex);
          const tokenObj = netlifyTokens[usedTokenIndex];
          const token = typeof tokenObj === 'string' ? tokenObj : (tokenObj?.token || '');
          const tokenId = typeof tokenObj === 'string' ? '' : (tokenObj?.id || '');

          try {
            step(`[${displayName}] 네이버 HTML 선수집 → 메타 삽입 → Netlify 1회 배포 (토큰 ${usedTokenIndex + 1})`);
            naverResult = await registerNaverMetaForKkangSite({
              siteUrl,
              siteDir,
              siteSlug: siteName,
              netlifyToken: token,
              naverAccount,
              openaiApiKey,
              headless: !!headless,
              metaInjectOnly: !!metaInjectOnly,
              collectSubpages: !metaInjectOnly,
              outputRoot,
              onLog: relay,
              firstDeploy: true,
            });

            tokenUsageCount[usedTokenIndex] = (tokenUsageCount[usedTokenIndex]
              || (typeof netlifyTokens[usedTokenIndex] === 'object' ? (netlifyTokens[usedTokenIndex].usedCount || 0) : 0)) + 1;
            if (typeof netlifyTokens[usedTokenIndex] === 'object') {
              netlifyTokens[usedTokenIndex].usedCount = tokenUsageCount[usedTokenIndex];
            }
            relay(`[TOKEN_COUNT] ${usedTokenIndex} ${tokenUsageCount[usedTokenIndex]}`);

            const finalUrl = naverResult?.deployUrl || naverResult?.url || siteUrl;
            const siteId = naverResult?.siteId || '';
            deployedSites.push({
              name: displayName,
              url: finalUrl,
              folder: siteDir,
              siteId,
              netlifyToken: token,
              netlifyAccountId: tokenId,
              sourceType,
              sourcePath,
              naverAccount,
            });

            const row = {
              ...(naverResult || {}),
              url: finalUrl,
              name: displayName,
              naverAccountId: naverAccount.id,
              netlifyAccountId: tokenId,
              registeredAt: new Date().toISOString(),
            };
            results.push(row);
            relay(`[NAVER] ${displayName}: ${row.status || 'ok'} (${finalUrl})`);
            if (row.pageUrlCount != null) {
              relay(`[${displayName}] 하위 페이지 수집 대상 ${row.pageUrlCount}개`);
            }
            break;
          } catch (e) {
            lastErr = e;
            const msg = e.message || '';
            error(`[${displayName}] 네이버/배포 실패: ${msg}`);

            if (/401|Access Denied|Unauthorized/i.test(msg)) {
              error(`  → 토큰 ${usedTokenIndex + 1} 인증 실패. 다음 토큰 시도…`);
              markTokenUsed(usedTokenIndex);
              const remaining = availableIndexes.filter((idx) => idx !== usedTokenIndex && !netlifyTokens[idx]?.used);
              if (!remaining.length) {
                authFailedAll = true;
                break;
              }
              const nextPos = (availableIndexes.indexOf(usedTokenIndex) + 1) % availableIndexes.length;
              usedTokenIndex = availableIndexes[nextPos];
              continue;
            }
            if (/403|Account credit usage exceeded|credits/i.test(msg)) {
              warn(`[${displayName}] 토큰 ${usedTokenIndex + 1} 크레딧 초과, 다음 토큰 시도…`);
              markTokenUsed(usedTokenIndex);
              await new Promise((r) => setTimeout(r, 3000));
              const nextPos = (availableIndexes.indexOf(usedTokenIndex) + 1) % availableIndexes.length;
              usedTokenIndex = availableIndexes[nextPos];
              continue;
            }
            if (/429|rate limit/i.test(msg)) {
              warn(`[${displayName}] Rate limit, 다음 토큰 시도…`);
              await new Promise((r) => setTimeout(r, 5000));
              const nextPos = (availableIndexes.indexOf(usedTokenIndex) + 1) % availableIndexes.length;
              usedTokenIndex = availableIndexes[nextPos];
              continue;
            }
            break;
          }
        }

        if (!naverResult) {
          // 네이버 실패 시 메타 없이 배포만 시도 (Netlify 생성 탭과 동일 폴백)
          const fallbackIdx = pickAvailableTokenIndexes(netlifyTokens)[0];
          if (fallbackIdx != null) {
            const tokenObj = netlifyTokens[fallbackIdx];
            const token = typeof tokenObj === 'string' ? tokenObj : (tokenObj?.token || '');
            const tokenId = typeof tokenObj === 'string' ? '' : (tokenObj?.id || '');
            try {
              warn(`[${displayName}] 네이버 인증 실패 — 메타 없이 Netlify 배포 시도…`);
              const deployResult = await deploySite({
                netlifyToken: token,
                siteName,
                dir: siteDir,
                serviceName: displayName,
              });
              relay(`✅ [${displayName}] 배포 완료(메타 없음): ${deployResult.url}`);
              deployedSites.push({
                name: displayName,
                url: deployResult.url,
                folder: siteDir,
                siteId: deployResult.siteId,
                netlifyToken: token,
                netlifyAccountId: tokenId,
                sourceType,
                sourcePath,
                naverAccount,
              });
              results.push({
                url: deployResult.url,
                name: displayName,
                status: 'error',
                error: lastErr?.message || '네이버 등록 실패 (배포만 완료)',
                naverAccountId: naverAccount.id,
                netlifyAccountId: tokenId,
                registeredAt: new Date().toISOString(),
              });
            } catch (de) {
              error(`[${displayName}] 폴백 배포도 실패: ${de.message}`);
              failedServices.push({ name: displayName, error: lastErr?.message || de.message });
              results.push({
                url: siteUrl,
                name: displayName,
                status: 'error',
                error: lastErr?.message || de.message,
                naverAccountId: naverAccount.id,
                registeredAt: new Date().toISOString(),
              });
            }
          } else {
            failedServices.push({ name: displayName, error: lastErr?.message || '네이버/배포 실패' });
            results.push({
              url: siteUrl,
              name: displayName,
              status: 'error',
              error: lastErr?.message || '네이버/배포 실패',
              naverAccountId: naverAccount.id,
              registeredAt: new Date().toISOString(),
            });
          }

          if (authFailedAll) {
            error('유효한 Netlify 토큰이 모두 실패했습니다. 나머지 사이트 생성을 중단합니다.');
            for (let j = i + 1; j < batch.length; j++) {
              failedServices.push({
                name: batch[j].displayName || batch[j].keyword || `site-${j}`,
                error: '유효한 Netlify 토큰 없음 — 중단',
              });
            }
            break;
          }
        }

        await new Promise((r) => setTimeout(r, 800));
      }

      if (batchStart + BATCH_SIZE < expanded.length) {
        await checkpoint(relay);
        const rest = 5000;
        step(`=== 다음 배치 전 ${rest / 1000}초 대기 ===`);
        await new Promise((r) => setTimeout(r, rest));
      }
    }
  } catch (e) {
    if (e instanceof RunStopped || e.name === 'RunStopped') {
      stopped = true;
      warn('사용자가 배포를 정지했습니다.');
      relay('⏹ 사용자 정지 — 완료된 작업까지 결과를 저장합니다.');
    } else {
      throw e;
    }
  }

  if (failedServices.length) {
    warn(`실패/부분 실패: ${failedServices.length}개`);
  }

  try {
    const resultsPath = path.join(outputRoot, 'results.json');
    let existing = [];
    if (fs.existsSync(resultsPath)) {
      existing = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    }
    const seen = new Set();
    const merged = [];
    for (const r of [...existing, ...results]) {
      if (r.url && !seen.has(r.url)) {
        seen.add(r.url);
        merged.push(r);
      } else if (!r.url) {
        merged.push(r);
      }
    }
    fs.writeFileSync(resultsPath, JSON.stringify(merged, null, 2), 'utf8');
    relay(`결과 저장 완료: ${resultsPath}`);
  } catch (e) {
    error(`결과 저장 실패: ${e.message}`);
  }

  step(stopped ? '=== 작업 정지됨 (부분 완료) ===' : '=== 전체 작업 완료 ===');
  relay(`로그 파일: ${fileLogger.getLogFile()}`);
  return { deployedSites, results, logFile: fileLogger.getLogFile(), stopped };
}
