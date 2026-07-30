import fs from 'fs';
import path from 'path';
import { buildHTML, buildSitemap, buildRobots, getRandomColor } from './builder.js';
import { writeSiteBundle, buildSitemapWithPages } from './ai-site-generator.js';
import { deploySite, resolveDeployRoot, validateNetlifyToken } from './deploy.js';
import { registerNaverSites, injectMeta } from './naver-register.js';
import { getTitleFromSource, fallbackSourceName, resolveZipSiteDir } from './source-utils.js';
import { createFileLogger, setLogger, step, action, error, warn } from './logger.js';
import { checkpoint, resetRunControl, RunStopped } from './run-pause.js';

const OUTPUT_ROOT = process.env.OUTPUT_ROOT || path.join(process.cwd(), 'output');

function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
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

export async function runFullPipeline(config, sendLog = null) {
  resetRunControl();
  const results = [];
  let stopped = false;
  const { netlifyTokens, naverAccounts, openaiApiKey, services, seoOptions, deploySources, headless = false, metaInjectOnly = false } = config;
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

  // 메타 데이터 풀 (ZIP/폴더 소스 배포 시에는 사용하지 않음)
  const metaTitles = seoOptions?.metaTitles?.length ? seoOptions.metaTitles : ['{name} | {keyword}'];
  const metaDescriptions = seoOptions?.metaDescriptions?.length ? seoOptions.metaDescriptions : ['{name}를 찾고 계신가요?'];
  const metaKeywords = seoOptions?.metaKeywords?.length ? seoOptions.metaKeywords : ['{keyword}'];

  // 배포 소스 정규화 (zip + folder)

  // 로깅 초기화
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

  // 배포 전 Netlify 토큰 유효성 검사 (AI 생성 비용 낭비 방지)
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

  step('=== 전체 파이프라인 시작 ===');
  step(`배포 대상: ${sources.length ? `소스 ${sources.length}개` : `서비스 ${services.length}개`}, Netlify 토큰: ${netlifyTokens.length}, 네이버 계정: ${naverAccounts.length}`);
  step(`브라우저 모드: ${headless ? '헤드리스(창 숨김)' : '창 표시'}`);
  step(`소유확인: ${metaInjectOnly ? '메타 태그만 주입 (버튼 생략 · 수동 확인)' : '자동 소유확인'}`);
  if (sources.length) step(`배포 소스: ${sources.length}개 (zip ${sources.filter(s => s.type === 'zip').length}개, folder ${sources.filter(s => s.type === 'folder').length}개)`);

  const expanded = await buildExpandedList(services, sources);
  if (!expanded.length) throw new Error('배포할 사이트가 없습니다.');

  const BATCH_SIZE = 10;
  const MAX_SITES_PER_TOKEN = 20;

  // 모든 결과 저장
  const deployedSites = [];
  const failedServices = [];
  const tokenUsageCount = {};

  // 배치 단위로: 10개씩 배포 -> 네이버 등록 반복
  try {
  for (let batchStart = 0; batchStart < expanded.length; batchStart += BATCH_SIZE) {
    await checkpoint(relay);
    const batch = expanded.slice(batchStart, batchStart + BATCH_SIZE);
    step(`=== 배치 ${Math.floor(batchStart / BATCH_SIZE) + 1} 시작 (사이트 ${batchStart + 1} ~ ${Math.min(batchStart + BATCH_SIZE, expanded.length)} / ${expanded.length}) ===`);

    // 1) 배포
    const batchSites = [];
    for (let i = 0; i < batch.length; i++) {
      await checkpoint(relay);
      const svc = batch[i];
      const globalIndex = batchStart + i;
      const siteName = 'site-' + Math.random().toString(36).substring(2, 6);
      const folder = path.join(outputRoot, siteName);
      fs.mkdirSync(folder, { recursive: true });

      const titleTemplate = pickRandom(metaTitles);
      const descTemplate = pickRandom(metaDescriptions);
      const kwTemplate = pickRandom(metaKeywords);
      const usingSource = !!(svc.source || (sources.length && globalIndex < sources.length));
      const displayName = svc.displayName
        || titleTemplate.replace(/{keyword}/g, svc.keyword || '');
      const title = displayName;
      const description = descTemplate.replace(/{keyword}/g, svc.keyword || '');
      const keywords = kwTemplate.replace(/{keyword}/g, svc.keyword || '');

      step(`[${displayName}] 사이트 생성/배포 시작 (${globalIndex + 1}/${expanded.length})`);

      const hasToken = netlifyTokens.some((t, idx) => {
        const usedCount = t.usedCount || tokenUsageCount[idx] || 0;
        return !t.used && usedCount < MAX_SITES_PER_TOKEN;
      });
      if (!hasToken) {
        error(`[${displayName}] 사용 가능한 Netlify 토큰이 없습니다. 나머지 사이트 생성을 중단합니다.`);
        failedServices.push({ name: displayName, error: '사용 가능한 Netlify 토큰이 없습니다.' });
        for (let j = i + 1; j < batch.length; j++) {
          failedServices.push({ name: batch[j].displayName || batch[j].keyword || `site-${j}`, error: '유효한 Netlify 토큰 없음 — 중단' });
        }
        break;
      }

      action(`[${displayName}] 폴더 생성: ${folder}`);

      const siteUrl = `https://${siteName}.netlify.app`;
      if (!usingSource) {
        step(`[${displayName}] SEO 데이터 준비`);
        action(`[${displayName}] title=${title.slice(0, 60)}..., description=${description.slice(0, 80)}...`);
      } else {
        step(`[${displayName}] ZIP/폴더 소스 배포 (index.html 타이틀 사용)`);
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
        step(`[${displayName}] 배포 소스 소진, 자동 생성 HTML로 배포`);
      }

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
      }

      let deployDir = usingSource && sourceType === 'folder' ? sourcePath : folder;
      let deployZipPath = null;

      if (usingSource && sourceType === 'zip' && sourcePath) {
        try {
          const { htmlDir, indexRel } = await resolveZipSiteDir(sourcePath, folder);
          deployDir = htmlDir;
          step(`[${displayName}] ZIP 압축 해제 — 사이트 폴더: ${indexRel}`);
        } catch (e) {
          error(`[${displayName}] ZIP 처리 실패: ${e.message}`);
          failedServices.push({ name: displayName, error: e.message });
          continue;
        }
      } else if (usingSource && sourceType === 'folder' && sourcePath) {
        try {
          deployDir = resolveDeployRoot(sourcePath);
        } catch (e) {
          error(`[${displayName}] 폴더 소스 확인 실패: ${e.message}`);
          failedServices.push({ name: displayName, error: e.message });
          continue;
        }
      }

      step(`[${displayName}] Netlify 배포 시작: siteName=${siteName}, source=${sourceType || 'auto'}`);

      let deployResult = null;
      let lastErr = null;

      // 사용 가능한 토큰 인덱스 목록
      const availableIndexes = netlifyTokens
        .map((t, idx) => ({ t, idx }))
        .filter(({ t, idx }) => {
          const usedCount = t.usedCount || tokenUsageCount[idx] || 0;
          return !t.used && usedCount < MAX_SITES_PER_TOKEN;
        })
        .map(({ idx }) => idx);

      if (!availableIndexes.length) {
        error(`[${displayName}] 사용 가능한 Netlify 토큰이 없습니다. 나머지 사이트 생성을 중단합니다.`);
        failedServices.push({ name: displayName, error: '사용 가능한 Netlify 토큰이 없습니다.' });
        for (let j = i + 1; j < batch.length; j++) {
          failedServices.push({ name: batch[j].displayName || batch[j].keyword || `site-${j}`, error: '유효한 Netlify 토큰 없음 — 중단' });
        }
        break;
      }

      // AI 생성은 배포 가능한 토큰이 있을 때만 (위에서 이미 생성했을 수 있음 — 순서 변경)
      // 토큰 확인을 생성 전으로 옮기기 위해 아래 블록에서 처리

      // 전체 인덱스 기준으로 순환 (배치 내 i가 아닌 globalIndex 사용)
      let usedTokenIndex = availableIndexes[globalIndex % availableIndexes.length];
      const triedIndexes = new Set();
      let authFailedAll = false;

      while (triedIndexes.size < availableIndexes.length) {
        triedIndexes.add(usedTokenIndex);
        const tokenObj = netlifyTokens[usedTokenIndex];
        const token = typeof tokenObj === 'string' ? tokenObj : (tokenObj?.token || '');
        const tokenId = typeof tokenObj === 'string' ? '' : (tokenObj?.id || '');

        try {
          deployResult = await deploySite({
            netlifyToken: token,
            siteName,
            dir: deployDir,
            zipPath: deployZipPath,
            serviceName: displayName,
          });
          relay(`✅ [${displayName}] 배포 완료: ${deployResult.url}`);
          tokenUsageCount[usedTokenIndex] = (tokenUsageCount[usedTokenIndex] || (netlifyTokens[usedTokenIndex]?.usedCount || 0)) + 1;
          if (typeof netlifyTokens[usedTokenIndex] === 'object') {
            netlifyTokens[usedTokenIndex].usedCount = tokenUsageCount[usedTokenIndex];
          }
          step(`[${displayName}] 토큰 ${usedTokenIndex + 1} 사용 카운트: ${tokenUsageCount[usedTokenIndex]}/${MAX_SITES_PER_TOKEN}`);
          relay(`[TOKEN_COUNT] ${usedTokenIndex} ${tokenUsageCount[usedTokenIndex]}`);
          batchSites.push({
            name: displayName,
            url: deployResult.url,
            folder: deployDir,
            siteId: deployResult.siteId,
            netlifyToken: token,
            netlifyAccountId: tokenId,
            sourceType,
            sourcePath,
            zipPath: sourceType === 'zip' ? sourcePath : deployZipPath,
            naverAccount: naverAccounts[globalIndex % naverAccounts.length],
          });
          break;
        } catch (e) {
          lastErr = e;
          const msg = e.message || '';
          if (msg.includes('401') || /Access Denied|Unauthorized/i.test(msg)) {
            error(`[${displayName}] Netlify 토큰 ${usedTokenIndex + 1} 인증 실패 (401). 토큰이 만료·삭제되었거나 잘못되었습니다.`);
            error(`  → Netlify 대시보드에서 Personal Access Token을 새로 발급해 설정 탭에 다시 넣어주세요.`);
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
          if (msg.includes('403') || msg.includes('Account credit usage exceeded') || msg.includes('credits')) {
            warn(`[${displayName}] 토큰 ${usedTokenIndex + 1} 크레딧 초과, 다음 토큰 시도...`);
            markTokenUsed(usedTokenIndex);
            await new Promise(r => setTimeout(r, 3000));
            const nextPos = (availableIndexes.indexOf(usedTokenIndex) + 1) % availableIndexes.length;
            usedTokenIndex = availableIndexes[nextPos];
            continue;
          }
          if (msg.includes('429') || msg.includes('rate limit')) {
            warn(`[${displayName}] 토큰 ${usedTokenIndex + 1} Rate limit, 다음 토큰 시도...`);
            await new Promise(r => setTimeout(r, 5000));
            const nextPos = (availableIndexes.indexOf(usedTokenIndex) + 1) % availableIndexes.length;
            usedTokenIndex = availableIndexes[nextPos];
            continue;
          }
          break;
        }
      }

      if (!deployResult) {
        error(`[${displayName}] 배포 실패: ${lastErr?.message || '알 수 없는 오류'}`);
        failedServices.push({ name: displayName, error: lastErr?.message || '배포 실패' });
        if (authFailedAll) {
          error('유효한 Netlify 토큰이 모두 실패했습니다. 나머지 사이트 생성을 중단합니다.');
          for (let j = i + 1; j < batch.length; j++) {
            failedServices.push({ name: batch[j].displayName || batch[j].keyword || `site-${j}`, error: '유효한 Netlify 토큰 없음 — 중단' });
          }
          break;
        }
      }

      // 배포 사이 간 딜레이 (짧은 간격 방지)
      await new Promise(r => setTimeout(r, 800));
    }

    deployedSites.push(...batchSites);

    // 2) 배치 완료 후 네이버 등록
    if (batchSites.length) {
      await checkpoint(relay);
      step(`=== 배치 ${Math.floor(batchStart / BATCH_SIZE) + 1} 네이버 등록 시작 (${batchSites.length}개) ===`);
      await registerBatch(batchSites, naverAccounts, netlifyTokens, outputRoot, openaiApiKey, relay, markTokenUsed, results, headless, metaInjectOnly);
    }

    // 배치 간 긴 휴식
    if (batchStart + BATCH_SIZE < expanded.length) {
      await checkpoint(relay);
      const rest = 5000;
      step(`=== 다음 배치 전 ${rest / 1000}초 대기 ===`);
      await new Promise(r => setTimeout(r, rest));
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
    warn(`배포 실패한 서비스: ${failedServices.length}개`);
  }

  // 결과 저장
  try {
    const resultsPath = path.join(outputRoot, 'results.json');
    let existing = [];
    if (fs.existsSync(resultsPath)) {
      existing = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    }
    const seen = new Set();
    const merged = [];
    for (const r of [...existing, ...results]) {
      if (r.url && !seen.has(r.url)) { seen.add(r.url); merged.push(r); }
      else if (!r.url) { merged.push(r); }
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

async function registerBatch(sites, naverAccounts, netlifyTokens, outputRoot, openaiApiKey, relay, markTokenUsed, results, headless = false, metaInjectOnly = false) {
  const grouped = {};
  for (const s of sites) {
    if (!s.naverAccount?.id) {
      warn(`네이버 계정 없음 — 등록 건너뜀: ${s.name || s.url}`);
      results.push({
        url: s.url,
        name: s.name,
        status: 'error',
        error: '네이버 계정 정보가 없습니다.',
        naverAccountId: '',
        netlifyAccountId: s.netlifyAccountId || '',
        registeredAt: new Date().toISOString(),
      });
      continue;
    }
    const key = s.naverAccount.id;
    if (!grouped[key]) grouped[key] = { account: s.naverAccount, sites: [] };
    grouped[key].sites.push(s);
  }

  for (const key of Object.keys(grouped)) {
    const { account, sites } = grouped[key];
    step(`네이버 계정: ${account.id} (사이트 ${sites.length}개)`);

    try {
      const naverResults = await registerNaverSites({
        sites,
        redeployCallback: async (site, metaTag) => {
          step(`[${site.name}] 소유확인용 재배포`);
          let deployDir = site.folder;
          let tempDir = null;
          try {
            if (site.sourceType === 'zip' && site.zipPath) {
              tempDir = fs.mkdtempSync(path.join(outputRoot, 'zip-extract-'));
              const { htmlDir, indexRel } = await resolveZipSiteDir(site.zipPath, tempDir);
              step(`[${site.name}] ZIP 내부 사이트 폴더: ${indexRel}`);
              injectMeta(htmlDir, metaTag, path.basename(indexRel));
              if (path.basename(indexRel).toLowerCase() !== 'index.html') {
                const sourceHtml = path.join(htmlDir, path.basename(indexRel));
                const targetHtml = path.join(htmlDir, 'index.html');
                fs.copyFileSync(sourceHtml, targetHtml);
                step(`[${site.name}] Netlify 인식용 index.html 생성: ${targetHtml}`);
              }
              deployDir = htmlDir;
            } else if (site.sourceType === 'folder' && site.sourcePath) {
              injectMeta(site.sourcePath, metaTag);
              deployDir = site.sourcePath;
            } else {
              injectMeta(site.folder, metaTag);
              deployDir = site.folder;
            }
            await deploySite({
              netlifyToken: site.netlifyToken,
              siteId: site.siteId,
              dir: deployDir,
              serviceName: site.name,
            });
          } catch (e) {
            const msg = e.message || '';
            if (msg.includes('403') || msg.includes('Account credit usage exceeded') || msg.includes('credits')) {
              const tokenIdx = netlifyTokens.findIndex(t => (typeof t === 'string' ? t : t.token) === site.netlifyToken);
              if (tokenIdx >= 0) {
                warn(`[${site.name}] 재배포 토큰 ${tokenIdx + 1} 크레딧 초과, used 처리`);
                markTokenUsed(tokenIdx);
              }
            }
            throw e;
          } finally {
            if (tempDir) {
              try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { warn(`임시 폰더 삭제 실패: ${e.message}`); }
            }
          }
        },
        headless: !!headless,
        metaInjectOnly: !!metaInjectOnly,
        openaiApiKey,
        naverAccount: account,
      });
      results.push(...naverResults);
      for (const r of naverResults) {
        const deployed = sites.find(d => d.url === r.url);
        r.netlifyAccountId = deployed?.netlifyAccountId || '';
        r.naverAccountId = account.id;
        r.registeredAt = r.registeredAt || new Date().toISOString();
        relay(`[NAVER] ${r.name}: ${r.status} (${r.url})`);
      }
    } catch (e) {
      error(`네이버 등록 중 예외: ${e.message}`);
      for (const s of sites) results.push({ url: s.url, name: s.name, status: 'error', error: e.message, naverAccountId: account.id, netlifyAccountId: s.netlifyAccountId, registeredAt: new Date().toISOString() });
    }
  }
}
