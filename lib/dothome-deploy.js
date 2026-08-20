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

function isTransientDnsCode(code = '') {
  return /EAI_AGAIN|ETIMEOUT|ESERVFAIL|ECONNREFUSED|ENETUNREACH/i.test(String(code || ''));
}

function isHardDnsMissingCode(code = '', message = '') {
  const s = `${code} ${message}`;
  // 일시 오류는 미개통으로 보지 않음 (로그에서 resolve4만 실패해도 FTP는 되는 경우 많음)
  if (isTransientDnsCode(code)) return false;
  return /ENOTFOUND|ENODATA|Non-existent|not found/i.test(s);
}

/**
 * 닷홈 무료호스팅 개통 여부 (서브도메인 DNS)
 * resolve4 실패 시 OS lookup 폴백 — 한쪽만 살아도 개통으로 본다.
 * @returns {{ ok:boolean, status:'ready'|'dns_missing'|'dns_error', host:string, ip?:string, error?:string, tip?:string }}
 */
export async function checkDothomeHostingReady(ftpIdOrUrl = '') {
  const raw = String(ftpIdOrUrl || '').trim();
  let host = '';
  if (/^https?:\/\//i.test(raw)) {
    try { host = new URL(raw).hostname; } catch { host = ''; }
  } else if (raw.includes('.')) {
    host = raw.replace(/^https?:\/\//i, '').split('/')[0];
  } else if (raw) {
    host = `${raw}.dothome.co.kr`;
  }
  host = String(host || '').replace(/^www\./i, '').toLowerCase();
  if (!host) {
    return {
      ok: false,
      status: 'dns_error',
      host: '',
      error: 'FTP 아이디/URL이 없습니다.',
      tip: '닷홈 계정에 FTP 아이디가 있는지 확인하세요.',
    };
  }

  let resolveErr = null;
  try {
    const ips = await dns.resolve4(host);
    const ip = ips?.[0] || '';
    if (ip) return { ok: true, status: 'ready', host, ip, via: 'resolve4' };
  } catch (e) {
    resolveErr = e;
  }

  // Node resolve4만 실패하고 OS lookup은 되는 경우가 잦음 → 미개통으로 오판하지 않음
  try {
    const looked = await dns.lookup(host, { family: 4 });
    const ip = looked?.address || '';
    if (ip) {
      return {
        ok: true,
        status: 'ready',
        host,
        ip,
        via: 'lookup',
        note: resolveErr ? `resolve4:${resolveErr.code || resolveErr.message}` : '',
      };
    }
  } catch (e) {
    const code = e?.code || resolveErr?.code || '';
    const msg = e?.message || resolveErr?.message || '';
    const missing = isHardDnsMissingCode(code, msg)
      && isHardDnsMissingCode(resolveErr?.code || code, resolveErr?.message || msg);
    return {
      ok: false,
      status: missing ? 'dns_missing' : 'dns_error',
      host,
      error: `${code || 'DNS'} ${msg}`.trim(),
      tip: missing
        ? '서브도메인 DNS가 없습니다. FTP 프로브로 한 번 더 확인한 뒤, 진짜 미개통이면 재가입하세요.'
        : 'DNS 일시 조회 실패. 잠시 후 다시 시도하거나 FTP로 직접 확인하세요.',
    };
  }

  return {
    ok: false,
    status: 'dns_missing',
    host,
    error: 'DNS A레코드 없음',
    tip: '호스팅 미개통 가능성. FTP 프로브로 재확인하세요.',
  };
}

/** 서브도메인 FTP 접속으로 개통 여부 재확인 (DNS 오판 방지) */
export async function probeDothomeSubdomainFtp(ftpId, password, sendLog, { timeoutMs = 18_000 } = {}) {
  const user = String(ftpId || '').trim();
  const pw = String(password || '').trim();
  const host = user ? `${user}.dothome.co.kr` : '';
  if (!user || !pw || !host) {
    return { ok: false, host, error: 'FTP 아이디/비밀번호 없음', hostnameMissing: false };
  }
  let client = null;
  try {
    client = await connectFtp(host, user, pw, { timeoutMs, secure: false });
    relay(sendLog, `✔ FTP 프로브 성공: ${host} (DNS 조회 실패해도 개통으로 판단)`);
    return { ok: true, host, hostnameMissing: false };
  } catch (e) {
    const code = e?.code || '';
    const msg = e?.message || String(e);
    const hostnameMissing = isHardDnsMissingCode(code, msg)
      || /getaddrinfo|ENOTFOUND/i.test(`${code} ${msg}`);
    relay(sendLog, `FTP 프로브 실패: ${host} — ${code || msg}${hostnameMissing ? ' (호스트 미해석)' : ''}`);
    return { ok: false, host, error: `${code || 'FTP'} ${msg}`.trim(), hostnameMissing, code };
  } finally {
    if (client) {
      try { client.close(); } catch { /* ignore */ }
    }
  }
}

/** 신규 직후 서브도메인 DNS가 뜰 때까지 폴링 */
export async function waitForDothomeHostingDns(ftpId, sendLog, {
  maxWaitMs = 90_000,
  intervalMs = 5_000,
} = {}) {
  const start = Date.now();
  let last = null;
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt += 1;
    last = await checkDothomeHostingReady(ftpId);
    if (last.ok) {
      relay(sendLog, `✔ 호스팅 DNS 확인: ${last.host} → ${last.ip}`);
      return last;
    }
    const left = Math.max(0, Math.ceil((maxWaitMs - (Date.now() - start)) / 1000));
    relay(sendLog, `⏳ 호스팅 DNS 대기 (${attempt})… ${last.error || last.status} · 남은 ${left}s`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last || {
    ok: false,
    status: 'dns_missing',
    host: `${String(ftpId || '').trim()}.dothome.co.kr`,
    error: 'DNS 대기 시간 초과',
  };
}

/** 공용 FTP — 많은 회선에서 21포트 차단 */
const DOTHOME_PUBLIC_FTP_HOST = 'ftp.dothome.co.kr';
const DOTHOME_PUBLIC_FTP_IPS = new Set(['211.239.120.109']);

/**
 * 무료호스팅 실제 서버 IP (서브도메인 DNS 실패 시에도 공용 211보다 먼저 시도)
 * 계정마다 다를 수 있으나 현재 닷홈 무료호스팅 대부분 이 대역
 */
const DOTHOME_HOSTING_FTP_FALLBACK_IPS = ['112.175.185.136'];

function isIpv4(host = '') {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host || '').trim());
}

/**
 * 호스트 후보 (접속 우선순위):
 * 1) UI에서 지정한 값
 * 2) {ftpId}.dothome.co.kr
 * 3) 호스팅 IP 폴백(112…) — DNS 실패해도 공용보다 먼저
 * 4) ftp.dothome.co.kr (공용, 마지막)
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
  if (user) push(`${user}.dothome.co.kr`);
  for (const ip of DOTHOME_HOSTING_FTP_FALLBACK_IPS) push(ip);
  push(DOTHOME_PUBLIC_FTP_HOST);
  return list;
}

async function expandHostsWithIps(hosts, sendLog) {
  const out = [...hosts];
  for (const host of hosts) {
    if (isIpv4(host)) continue;
    let resolved = false;
    try {
      const ips = await dns.resolve4(host);
      for (const ip of ips) {
        if (!out.includes(ip)) {
          out.push(ip);
          relay(sendLog, `DNS ${host} → ${ip}`);
        }
        resolved = true;
      }
    } catch (e) {
      relay(sendLog, `DNS resolve4 생략 ${host}: ${e.code || e.message}`);
    }
    // resolve4만 실패하고 OS lookup은 되는 경우 → 호스팅 IP를 후보에 넣음
    if (!resolved) {
      try {
        const looked = await dns.lookup(host, { family: 4 });
        const ip = looked?.address || '';
        if (ip && !out.includes(ip)) {
          out.push(ip);
          relay(sendLog, `DNS lookup ${host} → ${ip}`);
          resolved = true;
        }
      } catch (e) {
        relay(sendLog, `DNS lookup 생략 ${host}: ${e.code || e.message} (호스트명·폴백 IP로 계속 시도)`);
      }
    }
  }
  return out;
}

/**
 * 서브도메인 DNS가 비어도 호스팅 IP(112…)는 공용 211보다 앞에 유지.
 * UI에 이미 IP가 있으면 중복 추가하지 않음.
 */
function ensureDothomeHostingIpFallbacks(hosts, sendLog) {
  const out = [...hosts];
  const hasHostingIp = out.some((h) => isIpv4(h) && !DOTHOME_PUBLIC_FTP_IPS.has(String(h).trim()));
  for (const ip of DOTHOME_HOSTING_FTP_FALLBACK_IPS) {
    if (out.includes(ip)) continue;
    const pubIdx = out.findIndex((h) => {
      const s = String(h || '').toLowerCase();
      return s === DOTHOME_PUBLIC_FTP_HOST || DOTHOME_PUBLIC_FTP_IPS.has(s);
    });
    if (pubIdx >= 0) out.splice(pubIdx, 0, ip);
    else out.push(ip);
    relay(
      sendLog,
      hasHostingIp
        ? `FTP 호스팅 IP 후보 유지: ${ip}`
        : `FTP 호스팅 IP 폴백 추가: ${ip} (서브도메인 DNS 실패 시 공용 211 우회)`,
    );
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
  if (/ENOTFOUND|Non-existent/i.test(joined) && /getaddrinfo|ENOTFOUND/i.test(joined)) {
    tips.push('· 호스트명을 찾을 수 없음 → 개통 전이거나 DNS 전파 중일 수 있습니다. FTP 프로브·재가입을 검토하세요.');
  }
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKETTIMEDOUT/i.test(joined)) {
    tips.push('· 21포트 타임아웃 → 공용 ftp.dothome.co.kr(211…)가 막힌 회선일 수 있습니다.');
    tips.push('· FileZilla에서 호스트를 {FTP아이디}.dothome.co.kr 로 접속해 보세요. (발행 결과는 동일)');
    tips.push('· 그래도 안 되면 핫스팟/다른 VPN으로 회선을 바꿔 보세요.');
  }
  if (/ECONNRESET|data socket/i.test(joined)) {
    tips.push('· 업로드 중 data socket 끊김 → 재시도하거나 서브도메인 FTP·Passive 모드로 다시 올려보세요.');
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
  hosts = ensureDothomeHostingIpFallbacks(hosts, sendLog);
  // 서브도메인·호스팅 IP(112…)를 공용 ftp / 211… 보다 앞에 유지
  hosts = prioritizeSubdomainFtpHosts(hosts, user);
  relay(sendLog, `FTP 호스트 우선순위: ${hosts.slice(0, 5).join(' → ')}${hosts.length > 5 ? ' …' : ''}`);

  const isPublicFtp = (h) => {
    const s = String(h || '').toLowerCase();
    return s === DOTHOME_PUBLIC_FTP_HOST || DOTHOME_PUBLIC_FTP_IPS.has(s);
  };

  let lastUploadError = null;
  const maxUploadAttempts = 3;

  for (let attempt = 1; attempt <= maxUploadAttempts; attempt++) {
    let client = null;
    let connectedHost = '';
    const errors = [];
    // plain FTP 우선. 공용 호스트만 FTPS 보조 시도 (서브도메인은 TLS 미지원인 경우 많음)
    const modesFor = (host) => {
      if (isPublicFtp(host)) {
        return [
          { secure: false, label: 'FTP' },
          { secure: true, label: 'FTPS' },
        ];
      }
      return [{ secure: false, label: 'FTP' }];
    };

    outer:
    for (const host of hosts) {
      for (const mode of modesFor(host)) {
        try {
          relay(sendLog, `FTP 접속 시도: ${host} (${mode.label})${attempt > 1 ? ` · 재시도 ${attempt}` : ''}`);
          client = await connectFtp(host, user, password, { secure: mode.secure });
          connectedHost = `${host} (${mode.label})`;
          relay(sendLog, `FTP 접속 성공: ${connectedHost}`);
          break outer;
        } catch (e) {
          const msg = e?.message || String(e);
          errors.push(`${host}/${mode.label}: ${msg}`);
          relay(sendLog, `FTP 실패 (${host}/${mode.label}): ${msg}`);
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
      return;
    } catch (e) {
      lastUploadError = e;
      const msg = e?.message || String(e);
      relay(sendLog, `⚠ FTP 전송 실패: ${msg}`);
      try { client.close(); } catch { /* ignore */ }
      client = null;
      const retryable = /ECONNRESET|EPIPE|ETIMEDOUT|ESOCKETTIMEDOUT|data socket|transfer/i.test(msg);
      if (!retryable || attempt >= maxUploadAttempts) {
        const help = formatFtpHelp([msg, ...errors]);
        throw new Error(
          `${msg}\n접속: ${connectedHost}\n\n확인 사항:\n${help}`,
        );
      }
      relay(sendLog, `↻ 데이터 소켓 오류 — ${attempt + 1}/${maxUploadAttempts}회 재접속 후 재업로드…`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally {
      if (client) {
        try { client.close(); } catch { /* ignore */ }
      }
    }
  }

  throw lastUploadError || new Error('FTP 업로드 실패');
}

/** 서브도메인 호스트·호스팅 IP(112…)를 공용 ftp.dothome.co.kr / 211.239.120.109 보다 앞에 */
function prioritizeSubdomainFtpHosts(hosts, ftpUser) {
  const user = String(ftpUser || '').trim().toLowerCase();
  const subHost = user ? `${user}.dothome.co.kr` : '';
  const publicHosts = new Set([DOTHOME_PUBLIC_FTP_HOST, ...DOTHOME_PUBLIC_FTP_IPS]);
  const preferred = [];
  const hostingIps = [];
  const publicOnes = [];
  const rest = [];
  for (const h of hosts) {
    const s = String(h || '').trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (subHost && low === subHost) preferred.push(s);
    else if (publicHosts.has(low)) publicOnes.push(s);
    else if (isIpv4(s) && DOTHOME_PUBLIC_FTP_IPS.has(s)) publicOnes.push(s);
    else if (isIpv4(s) && DOTHOME_HOSTING_FTP_FALLBACK_IPS.includes(s)) hostingIps.push(s);
    else if (isIpv4(s)) hostingIps.push(s); // resolve/lookup으로 얻은 호스팅 IP
    else rest.push(s);
  }
  const out = [];
  const push = (h) => { if (h && !out.includes(h)) out.push(h); };
  for (const h of preferred) push(h);
  for (const h of hostingIps) push(h);
  for (const h of rest) push(h);
  for (const h of publicOnes) push(h);
  return out.length ? out : hosts;
}

/**
 * 닷홈 네이버 등록 URL — http 우선 (무료호스팅 https SSL이 네이버 검증에 자주 실패)
 */
async function probeHttpReachable(url, { timeoutMs = 12_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)',
        'Cache-Control': 'no-cache',
      },
    });
    return { ok: resp.status > 0 && resp.status < 500, status: resp.status };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

export async function pickDothomeNaverRootUrl(account, sendLog) {
  const httpUrl = `${resolveSiteUrl(account, { https: false })}/`;
  const httpsUrl = `${resolveSiteUrl(account, { https: true })}/`;
  const httpProbe = await probeHttpReachable(httpUrl);
  if (httpProbe.ok) {
    relay(sendLog, `네이버 등록 URL: ${httpUrl} (http 우선 · HTTP ${httpProbe.status})`);
    return httpUrl;
  }
  relay(sendLog, `http 접근 실패(${httpProbe.error || httpProbe.status}) — https 프로브`);
  const httpsProbe = await probeHttpReachable(httpsUrl);
  if (httpsProbe.ok) {
    relay(sendLog, `네이버 등록 URL: ${httpsUrl} (https · HTTP ${httpsProbe.status})`);
    return httpsUrl;
  }
  relay(sendLog, `양 스킴 프로브 실패 — http로 네이버 등록 시도: ${httpUrl}`);
  return httpUrl;
}

/**
 * 네이버 HTML 태그 선수집 → 메타 주입 → FTP 1회 업로드 → 소유확인
 * (Netlify firstDeploy와 동일 패턴 — 닷홈은 ftpId로 URL이 미리 확정됨)
 */
async function registerNaverAfterDeploy({
  account,
  siteDir,
  siteRootUrl,
  ftpHost,
  naverAccount,
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  metaInjectOnly = false,
  outputRoot,
  sendLog,
  /** true면 업로드 전에 메타만 넣고 redeployCallback에서 최초 FTP */
  firstDeploy = true,
  onFtpUploaded = null,
}) {
  let rootUrl = String(siteRootUrl || '').trim();
  if (!rootUrl || rootUrl === '/') {
    rootUrl = await pickDothomeNaverRootUrl(account, sendLog);
  } else {
    rootUrl = rootUrl.replace(/\/?$/, '/');
    // 호출측이 https를 넘긴 경우에도 닷홈은 http 우선으로 재선정
    if (/^https:\/\//i.test(rootUrl) && /\.dothome\.co\.kr/i.test(rootUrl)) {
      rootUrl = await pickDothomeNaverRootUrl(account, sendLog);
    }
  }
  if (!rootUrl || rootUrl === '/') throw new Error('네이버 등록용 사이트 URL이 없습니다.');
  if (!naverAccount?.id || !naverAccount?.pw) {
    throw new Error('네이버 계정이 필요합니다. 설정 탭에 네이버 아이디/비밀번호를 등록하세요.');
  }

  const { registerNaverSites, injectMetaAllHtml } = await import('./naver-register.js');
  const { setLogger } = await import('./logger.js');
  const { ensureNaverSession } = await import('./naver-session.js');
  const folder = path.join(outputRoot || path.join(process.cwd(), 'output'), `dothome-naver-${account.ftpId}-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });

  relay(sendLog, firstDeploy
    ? '═══ 네이버 HTML 태그 선수집 → 메타 삽입 → FTP 1회 업로드 ═══'
    : '═══ 네이버 서치어드바이저 등록 ═══');
  relay(sendLog, `사이트: ${rootUrl}`);
  relay(sendLog, `계정: ${naverAccount.id}`);
  setLogger((msg) => {
    const t = String(msg).replace(/^\[.*?\]\s*/, '');
    if (typeof sendLog === 'function') sendLog(t);
    else relay(null, t);
  });

  let session = null;
  let ftpUploaded = false;
  try {
    try {
      session = await ensureNaverSession({
        naverAccount,
        naverAccounts,
        openaiApiKey,
        headless: !!headless,
        outputFolder: folder,
        onLog: sendLog,
      });
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
        name: account.ftpId || account.id || rootUrl,
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
      // 홈만 간단 인덱싱 생략 → 하위 페이지 수집에서 사이트맵·웹수집
      skipIndexing: true,
      metaLiveMaxWaitMs: 120_000,
      // 선배포: 메타 넣은 뒤 1회 FTP. 라이브 미확인 시 1회 재업로드 허용
      extraRedeployOnMiss: true,
      redeployCallback: async (_site, metaTag) => {
        relay(sendLog, '네이버 HTML 인증 메타 → 전체 HTML 주입…');
        injectMetaAllHtml(siteDir, metaTag);
        relay(sendLog, firstDeploy && !ftpUploaded
          ? '메타 삽입 후 FTP 최초 업로드 (1회)…'
          : '메타 반영 후 FTP 재업로드…');
        await uploadSiteViaFtp({
          siteDir,
          ftpHost,
          ftpUser: account.ftpId,
          ftpPassword: account.ftpPw || account.pw || account.dbPw,
          sendLog,
        });
        ftpUploaded = true;
        if (typeof onFtpUploaded === 'function') {
          try { await onFtpUploaded(); } catch { /* ignore */ }
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
      err.ftpOk = ftpUploaded;
      throw err;
    }
    first.naverAccountId = first.naverAccountId || naverAccount.id;
    first.ftpOk = ftpUploaded;
    first.url = first.url || rootUrl;
    relay(sendLog, `네이버 등록 결과: ${first.status}${first.metaContent ? ` · meta=${String(first.metaContent).slice(0, 12)}…` : ''}`);
    try {
      const { countAdvisorRegisteredSites } = await import('./naver-session.js');
      const n = await countAdvisorRegisteredSites(session?.page || null, { forceReload: true });
      if (n != null) relay(sendLog, `서치어드바이저 등록 사이트: ${n}개`);
    } catch { /* ignore */ }
    return first;
  } finally {
    // 다음 닷홈 가입 루프에서 sharedLog↔sendLog 이중 출력이 남지 않도록 복구
    setLogger(null);
  }
}

/**
 * 정적 SEO 생성(+선택) 후 FTP 업로드 — 생성 후 배포 시 네이버 등록까지
 * ZIP/AI 공통: 주소·메타 정리 후 FTP 1회 (네이버 등록 시 메타 선수집)
 */
export async function deployDothomeSite({
  account,
  siteDir,
  zipPath = '',
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
  naverAccounts = [],
  openaiApiKey = '',
  yesCaptchaClientKey = '',
  headless = false,
  metaInjectOnly = false,
  sendLog,
} = {}) {
  if (!account?.ftpId) throw new Error('배포할 계정에 FTP 아이디가 없습니다.');

  relay(sendLog, `═══ 닷홈 정적 사이트 배포 ═══`);
  relay(sendLog, `회원: ${account.id || '-'} / FTP: ${account.ftpId}`);

  let localDir = String(siteDir || '').trim();
  let genResult = null;
  const { resolveExistingZipPath, rewriteSitePublicUrls, moveZipToSuccessFolder } = await import('./source-utils.js');
  let usedZipPath = resolveExistingZipPath(zipPath) || String(zipPath || '').trim();
  const gVerify = googleVerifyFile || account.googleVerifyFile || '';

  if (usedZipPath) {
    if (!fs.existsSync(usedZipPath)) {
      const err = new Error(`ZIP 파일이 없습니다: ${usedZipPath}`);
      err.code = 'ZIP_MISSING';
      err.zipMissing = true;
      throw err;
    }
    const { resolveZipSiteDir } = await import('./source-utils.js');
    const extractRoot = path.join(
      outputRoot || process.cwd(),
      'dothome-zip-extract',
      `${account.ftpId}-${Date.now()}`,
    );
    fs.mkdirSync(extractRoot, { recursive: true });
    relay(sendLog, `📦 ZIP 배포 모드: ${path.basename(usedZipPath)}`);
    const resolved = await resolveZipSiteDir(usedZipPath, extractRoot);
    localDir = resolved.htmlDir;
    relay(sendLog, `ZIP 사이트 루트: ${localDir}`);
    if (gVerify && fs.existsSync(gVerify)) {
      const { installGoogleVerifyFile } = await import('./dothome-seo-site.js');
      installGoogleVerifyFile(localDir, gVerify, sendLog);
    }
  } else if (generate || !localDir) {
    // 동적 import — Cursor SDK는 생성 시에만 로드 (asar 경로 이슈 회피)
    const { generateDothomeSeoSite } = await import('./dothome-seo-site.js');
    genResult = await generateDothomeSeoSite({
      ftpId: account.ftpId,
      keyword: keyword || account.keyword || '',
      phoneDisplay: phoneDisplay || '010-6338-7124',
      externalUrl: externalUrl || account.externalUrl || '',
      imageDir: imageDir || account.imageDir || '',
      cursorApiKey,
      googleVerifyFile: gVerify,
      outputRoot,
      sendLog,
    });
    localDir = genResult.siteDir;
  } else if (gVerify && fs.existsSync(gVerify)) {
    const { installGoogleVerifyFile } = await import('./dothome-seo-site.js');
    installGoogleVerifyFile(localDir, gVerify, sendLog);
  }

  if (!fs.existsSync(path.join(localDir, 'index.html'))) {
    throw new Error(`업로드할 index.html이 없습니다: ${localDir}`);
  }

  // 가입 직후 DNS 전파 대기 — 실패해도 FTP 프로브로 개통 재확인 (resolve4 오판 방지)
  {
    const ready = await waitForDothomeHostingDns(account.ftpId, sendLog, {
      maxWaitMs: 90_000,
      intervalMs: 5_000,
    });
    if (!ready.ok) {
      const ftpPw = account.ftpPw || account.pw || account.dbPw || '';
      const probe = await probeDothomeSubdomainFtp(account.ftpId, ftpPw, sendLog);
      if (probe.ok) {
        relay(sendLog, `ℹ DNS 조회는 실패했지만 FTP 접속 가능 → 업로드 진행 (${probe.host})`);
      } else if (ready.status === 'dns_missing' && probe.hostnameMissing) {
        const host = ready.host || probe.host || `${account.ftpId}.dothome.co.kr`;
        const err = new Error(
          `무료호스팅 미개통(서브도메인 DNS·FTP 모두 실패): ${host}\n`
          + '마이닷홈 확인 없이 이 계정은 버리고 새로 가입하세요. (다시 배포 불가)',
        );
        err.code = 'DOTHOME_DNS_MISSING';
        err.dnsMissing = true;
        err.hostingStatus = 'dns_missing';
        err.ftpId = account.ftpId;
        err.host = host;
        throw err;
      } else {
        // DNS 일시 오류·포트 막힘 등은 미개통 폐기하지 않고 업로드 단계에서 재시도
        relay(sendLog, `⚠ DNS 대기 실패(${ready.status}: ${ready.error || ''}) — 미개통 확정 아님, FTP 업로드 재시도`);
      }
    }
  }

  // 네이버/공개 URL = FTP 아이디 서브도메인 (ZIP 안 주소와 무관)
  const rootUrl = await pickDothomeNaverRootUrl(account, sendLog);
  const siteUrl = genResult?.homeUrl
    || genResult?.siteUrl
    || rootUrl;

  // ZIP/폴더: canonical·sitemap·robots를 닷홈 주소로 맞춤 (AI 생성은 이미 반영됨)
  try {
    rewriteSitePublicUrls(localDir, rootUrl.replace(/\/$/, ''), sendLog);
  } catch (e) {
    relay(sendLog, `⚠ 사이트 URL 재작성 경고: ${e.message}`);
  }

  let movedZip = null;
  let ftpOk = false;
  const moveZipAfterFtp = async () => {
    if (!usedZipPath || movedZip) return;
    try {
      const mv = moveZipToSuccessFolder(usedZipPath);
      if (mv?.ok && !mv.skipped) {
        movedZip = { from: mv.from, to: mv.path };
        relay(sendLog, `📦 성공 ZIP 이동: ${path.basename(usedZipPath)} → 성공\\${path.basename(mv.path)}`);
      } else if (mv?.ok && mv.skipped) {
        movedZip = { from: mv.from, to: mv.path, skipped: true };
        relay(sendLog, `📦 이미 성공 폴더에 있음: ${path.basename(usedZipPath)}`);
      } else if (mv?.error) {
        relay(sendLog, `⚠ 성공 ZIP 이동 실패(원본 유지): ${mv.error}`);
      }
    } catch (e) {
      relay(sendLog, `⚠ 성공 ZIP 이동 예외: ${e.message}`);
    }
  };

  let naverResult = null;
  let pageCollect = null;
  if (registerNaver) {
    try {
      // 메타 선수집 → 주입 → FTP 1회 → 소유확인 (업로드를 네이버 메타 이후로 이동)
      naverResult = await registerNaverAfterDeploy({
        account,
        siteDir: localDir,
        siteRootUrl: rootUrl,
        ftpHost,
        naverAccount,
        naverAccounts,
        openaiApiKey,
        yesCaptchaClientKey,
        headless,
        metaInjectOnly,
        outputRoot,
        sendLog,
        firstDeploy: true,
        onFtpUploaded: async () => {
          ftpOk = true;
          await moveZipAfterFtp();
        },
      });
      ftpOk = ftpOk || !!naverResult?.ftpOk;
      if (ftpOk && !movedZip) await moveZipAfterFtp();

      // 사이트맵 제출 + 하위 페이지 웹수집
      try {
        const { collectLocalSitePageUrls } = await import('./kkang-site-builder.js');
        const { submitNaverBulkCollection } = await import('./naver-bulk-collect.js');
        const { ensureNaverSession } = await import('./naver-session.js');
        const collectBase = String(naverResult?.url || rootUrl).replace(/\/$/, '');
        const pageUrls = collectLocalSitePageUrls(localDir, collectBase);
        relay(sendLog, `═══ 닷홈 하위 페이지 수집 (${pageUrls.length}개) — 사이트맵·웹수집 ═══`);
        let session = null;
        try {
          session = await ensureNaverSession({
            naverAccount,
            naverAccounts,
            openaiApiKey,
            headless: !!headless,
            onLog: sendLog,
          });
        } catch (e) {
          relay(sendLog, `⚠ 공유 세션 재사용 실패 — 하위 수집 건너뜀: ${e.message}`);
          pageCollect = null;
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
      // FTP·ZIP 이동은 성공한 상태 — 호출측에서 목록 정리할 수 있게 부가정보 전달
      const err = new Error(e?.message || String(e));
      err.ftpOk = !!(e?.ftpOk || ftpOk);
      err.movedZip = movedZip;
      err.siteDir = localDir;
      err.siteUrl = siteUrl;
      err.sourcePath = movedZip?.to || usedZipPath || '';
      err.naverStatus = e?.naverStatus || '';
      err.failKind = e?.failKind || '';
      throw err;
    }
  } else {
    // 네이버 생략: URL 정리본만 FTP 업로드
    await uploadSiteViaFtp({
      siteDir: localDir,
      ftpHost,
      ftpUser: account.ftpId,
      ftpPassword: account.ftpPw || account.pw || account.dbPw,
      sendLog,
    });
    ftpOk = true;
    await moveZipAfterFtp();
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
    sourcePath: movedZip?.to || usedZipPath || '',
    sourceType: usedZipPath ? 'zip' : (genResult ? 'ai' : 'folder'),
    movedZip,
    ftpOk,
    naver: naverResult,
    pageCollect,
  };
}
