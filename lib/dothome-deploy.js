import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import { Client } from 'basic-ftp';

function relay(sendLog, msg) {
  if (typeof sendLog === 'function') sendLog(msg);
}

/**
 * 닷홈 무료호스팅: 서브도메인 = FTP 아이디
 */
export function resolveSiteUrl(account, { https = false } = {}) {
  const ftpId = String(account?.ftpId || '').trim();
  const proto = https ? 'https' : 'http';
  if (ftpId) return `${proto}://${ftpId}.dothome.co.kr`;
  const fromAccount = String(account?.url || '').trim();
  if (fromAccount) return fromAccount.replace(/\/$/, '').replace(/^http:/, https ? 'https:' : 'http:');
  const id = String(account?.id || '').trim();
  return id ? `${proto}://${id}.dothome.co.kr` : '';
}

/**
 * 호스트 후보:
 * 1) UI에서 지정한 값
 * 2) ftp.dothome.co.kr (신규 계정은 서브도메인 DNS가 아직 없을 수 있음)
 * 3) 해석된 IP
 * 4) {ftpId}.dothome.co.kr
 */
export function buildFtpHostCandidates(ftpUser, ftpHost) {
  const user = String(ftpUser || '').trim();
  const preferred = String(ftpHost || '').trim();
  const list = [];
  const push = (h) => {
    const v = String(h || '').trim();
    if (v && !list.includes(v)) list.push(v);
  };
  push(preferred);
  push('ftp.dothome.co.kr');
  if (user) push(`${user}.dothome.co.kr`);
  return list;
}

async function expandHostsWithIps(hosts, sendLog) {
  const out = [...hosts];
  for (const host of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
    try {
      const ips = await dns.resolve4(host);
      for (const ip of ips) {
        if (!out.includes(ip)) {
          out.push(ip);
          relay(sendLog, `DNS ${host} → ${ip}`);
        }
      }
    } catch (e) {
      relay(sendLog, `DNS 실패 ${host}: ${e.code || e.message}`);
    }
  }
  return out;
}

async function connectFtp(host, user, password, { timeoutMs = 20_000, secure = false } = {}) {
  const client = new Client(timeoutMs);
  client.ftp.verbose = false;
  try {
    await client.access({
      host,
      user,
      password,
      secure,
      // IPv4 우선 — 일부 회선에서 IPv6로 타임아웃 나는 경우 완화
      family: 4,
    });
    return client;
  } catch (e) {
    client.close();
    throw e;
  }
}

function formatFtpHelp(errors) {
  const joined = errors.join('\n');
  const tips = [];
  if (/ENOTFOUND|Non-existent|EAI_AGAIN/i.test(joined)) {
    tips.push('· 서브도메인 DNS 없음 → 마이닷홈에서 무료호스팅이 실제로 개통됐는지 확인하세요.');
  }
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKETTIMEDOUT/i.test(joined)) {
    tips.push('· 21포트 타임아웃 → 이 PC/회선에서 닷홈 FTP가 막혀 있습니다. (공유기·백신·회사망·ISP)');
    tips.push('· 다른 인터넷(핫스팟/VPN)에서 FileZilla로 ftp.dothome.co.kr:21 접속을 먼저 테스트하세요.');
    tips.push('· 마이닷홈 → 호스팅 상세 → FTP 접속설정이 「접속허용」인지 확인하세요.');
  }
  if (/530|Login incorrect|인증/i.test(joined)) {
    tips.push('· 530/로그인 실패 → FTP 아이디·비밀번호를 확인하거나 마이닷홈에서 FTP 암호를 재설정하세요.');
  }
  if (!tips.length) {
    tips.push('· 마이닷홈 호스팅 상세의 FTP 정보를 확인하고, FileZilla로 동일 정보 접속을 테스트하세요.');
  }
  return tips.join('\n');
}

async function ensureHtmlDir(client, sendLog) {
  const list = await client.list();
  const names = list.map((e) => e.name.toLowerCase());
  if (names.includes('html')) {
    await client.cd('html');
    relay(sendLog, 'FTP 원격 경로: /html');
    return;
  }
  const hasIndex = names.includes('index.html') || names.includes('index.php');
  if (hasIndex) {
    relay(sendLog, 'FTP 원격 경로: 현재 폴더(웹루트)');
    return;
  }
  try {
    await client.ensureDir('html');
    await client.cd('html');
    relay(sendLog, 'FTP 원격 경로: /html (생성)');
  } catch {
    relay(sendLog, 'FTP 원격 경로: 현재 폴더');
  }
}

export async function uploadSiteViaFtp({
  siteDir,
  ftpHost = '',
  ftpUser,
  ftpPassword,
  sendLog,
}) {
  const user = String(ftpUser || '').trim();
  const password = String(ftpPassword || '').trim();
  if (!user || !password) throw new Error('FTP 아이디/비밀번호가 없습니다.');
  const local = String(siteDir || '').trim();
  if (!local || !fs.existsSync(local)) throw new Error(`로컬 사이트 폴더 없음: ${local}`);

  let hosts = buildFtpHostCandidates(user, ftpHost);
  relay(sendLog, `FTP 업로드 시작… (${user})`);
  relay(sendLog, `로컬: ${local}`);
  hosts = await expandHostsWithIps(hosts, sendLog);

  let client = null;
  let connectedHost = '';
  const errors = [];
  // plain FTP 우선, 실패 시 FTPS(explicit) 한 번 더
  const modes = [
    { secure: false, label: 'FTP' },
    { secure: true, label: 'FTPS' },
  ];

  outer:
  for (const host of hosts) {
    for (const mode of modes) {
      try {
        relay(sendLog, `FTP 접속 시도: ${host} (${mode.label})`);
        client = await connectFtp(host, user, password, { secure: mode.secure });
        connectedHost = `${host} (${mode.label})`;
        relay(sendLog, `FTP 접속 성공: ${connectedHost}`);
        break outer;
      } catch (e) {
        const msg = e?.message || String(e);
        errors.push(`${host}/${mode.label}: ${msg}`);
        relay(sendLog, `FTP 실패 (${host}/${mode.label}): ${msg}`);
        // ENOTFOUND는 FTPS 재시도 의미 없음
        if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) break;
      }
    }
  }

  if (!client) {
    throw new Error(
      `FTP 접속 실패 (21포트).\n시도: ${hosts.join(', ')}\n`
      + `${errors.slice(0, 6).join('\n')}\n\n확인 사항:\n${formatFtpHelp(errors)}`,
    );
  }

  try {
    await ensureHtmlDir(client, sendLog);
    relay(sendLog, '정적 파일 업로드 중… (/html 내용물)');
    await client.uploadFromDir(local);
    relay(sendLog, `FTP 업로드 완료 (${connectedHost})`);
  } finally {
    client.close();
  }
}

/**
 * 티스토리 HTML 수정 앱과 동일 흐름:
 * 서치어드바이저 사이트 등록 → HTML 메타 추출 → 전 페이지 주입 → FTP 재업로드 → 소유확인 → 인덱싱
 */
async function registerNaverAfterDeploy({
  account,
  siteDir,
  siteRootUrl,
  ftpHost,
  naverAccount,
  openaiApiKey = '',
  headless = false,
  metaInjectOnly = false,
  outputRoot,
  sendLog,
}) {
  const rootUrl = String(siteRootUrl || resolveSiteUrl(account, { https: true }) || '').replace(/\/?$/, '/');
  if (!rootUrl || rootUrl === '/') throw new Error('네이버 등록용 사이트 URL이 없습니다.');
  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error('네이버 계정이 필요합니다. 설정 탭에 네이버 아이디/비밀번호를 등록하세요.');
  }

  const { registerNaverSites, injectMetaAllHtml } = await import('./naver-register.js');
  const { setLogger } = await import('./logger.js');
  const folder = path.join(outputRoot || path.join(process.cwd(), 'output'), `dothome-naver-${account.ftpId}-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });

  relay(sendLog, `═══ 네이버 서치어드바이저 등록 ═══`);
  relay(sendLog, `사이트: ${rootUrl}`);
  relay(sendLog, `계정: ${naverAccount.id}`);
  setLogger((msg) => relay(sendLog, String(msg).replace(/^\[.*?\]\s*/, '')));

  const results = await registerNaverSites({
    sites: [{
      url: rootUrl,
      name: account.ftpId || account.id || rootUrl,
      folder,
      siteDir,
    }],
    headless: !!headless,
    metaInjectOnly: !!metaInjectOnly,
    openaiApiKey,
    naverAccount,
    redeployCallback: async (_site, metaTag) => {
      relay(sendLog, '네이버 HTML 인증 메타 → 전체 HTML 주입…');
      injectMetaAllHtml(siteDir, metaTag);
      relay(sendLog, '메타 반영 후 FTP 재업로드…');
      await uploadSiteViaFtp({
        siteDir,
        ftpHost,
        ftpUser: account.ftpId,
        ftpPassword: account.ftpPw || account.pw || account.dbPw,
        sendLog,
      });
    },
  });

  const first = Array.isArray(results) ? results[0] : null;
  const okStatuses = new Set(['success', 'already', 'manual']);
  if (!first) {
    throw new Error('네이버 등록 결과가 없습니다. (로그인/서치어드바이저 화면을 확인하세요)');
  }
  if (first.status === 'error' || !okStatuses.has(first.status)) {
    throw new Error(first.error || `네이버 등록 실패 (상태: ${first.status || 'unknown'})`);
  }
  relay(sendLog, `네이버 등록 결과: ${first.status}${first.metaContent ? ` · meta=${String(first.metaContent).slice(0, 12)}…` : ''}`);
  return first;
}

/**
 * 정적 SEO 생성(+선택) 후 FTP 업로드 — 생성 후 배포 시 네이버 등록까지
 */
export async function deployDothomeSite({
  account,
  siteDir,
  generate = false,
  keyword,
  phoneDisplay,
  externalUrl,
  imageDir,
  cursorApiKey = '',
  googleVerifyFile = '',
  outputRoot,
  ftpHost,
  registerNaver = false,
  naverAccount = null,
  openaiApiKey = '',
  headless = false,
  metaInjectOnly = false,
  sendLog,
} = {}) {
  if (!account?.ftpId) throw new Error('배포할 계정에 FTP 아이디가 없습니다.');

  relay(sendLog, `═══ 닷홈 정적 사이트 배포 ═══`);
  relay(sendLog, `회원: ${account.id || '-'} / FTP: ${account.ftpId}`);

  let localDir = String(siteDir || '').trim();
  let genResult = null;

  if (generate || !localDir) {
    // 동적 import — Cursor SDK는 생성 시에만 로드 (asar 경로 이슈 회피)
    const { generateDothomeSeoSite } = await import('./dothome-seo-site.js');
    genResult = await generateDothomeSeoSite({
      ftpId: account.ftpId,
      keyword: keyword || account.keyword || '',
      phoneDisplay: phoneDisplay || '010-6338-7124',
      externalUrl: externalUrl || account.externalUrl || '',
      imageDir: imageDir || account.imageDir || '',
      cursorApiKey,
      googleVerifyFile: googleVerifyFile || account.googleVerifyFile || '',
      outputRoot,
      sendLog,
    });
    localDir = genResult.siteDir;
  } else if (googleVerifyFile && fs.existsSync(googleVerifyFile)) {
    const { installGoogleVerifyFile } = await import('./dothome-seo-site.js');
    installGoogleVerifyFile(localDir, googleVerifyFile, sendLog);
  }

  if (!fs.existsSync(path.join(localDir, 'index.html'))) {
    throw new Error(`업로드할 index.html이 없습니다: ${localDir}`);
  }

  await uploadSiteViaFtp({
    siteDir: localDir,
    ftpHost,
    ftpUser: account.ftpId,
    ftpPassword: account.ftpPw || account.pw || account.dbPw,
    sendLog,
  });

  const rootUrl = `${resolveSiteUrl(account, { https: true })}/`;
  const siteUrl = genResult?.homeUrl
    || genResult?.siteUrl
    || rootUrl;

  let naverResult = null;
  if (registerNaver) {
    naverResult = await registerNaverAfterDeploy({
      account,
      siteDir: localDir,
      siteRootUrl: rootUrl,
      ftpHost,
      naverAccount,
      openaiApiKey,
      headless,
      metaInjectOnly,
      outputRoot,
      sendLog,
    });
  }

  relay(sendLog, `사이트: ${siteUrl}`);
  relay(sendLog, `로컬: ${localDir}`);

  return {
    ok: true,
    siteUrl,
    homeUrl: siteUrl,
    rootUrl,
    siteDir: localDir,
    ftpId: account.ftpId,
    slug: genResult?.slug,
    pages: genResult?.pages,
    googleVerifyFile: genResult?.googleVerifyFile || '',
    generate: genResult,
    naver: naverResult,
  };
}
