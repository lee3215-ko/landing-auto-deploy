let config = {};
let savedResults = [];
let createdSites = [];
let sitesFilter = 'all';
let deployFolderPath = '';
let deploySources = [];
let generatedTokens = [];
let activeGenAccountIdx = -1;
let tokenGenRunning = false;
let tokenGenWaitingLogin = false;
let crawledUrls = []; // flat list for display/copy (derived)
let crawlBatches = []; // [{ homeUrl, urls }] — 내부 URL 크롤(선택)
let crawlSiteStatus = []; // [{ url, status, message, at }] — 웹페이지 수집 진행
let naverCollectRunning = false;
/** URL 수집 탭 작업 상태: idle | running | stopped */
let crawlJobState = 'idle';
/** 마지막 작업 종류 — 재시작용: 'crawl' | 'collect' | null */
let crawlLastJob = null;
let urlCrawlRunning = false;
let seoBusy = false;
let seoStopRequested = false;
let seoKeywords = []; // [{kw, slug, cat, folder, custom}]
let seoFolders = [];
let seoCounts = {};
let seoSelected = new Set();
let seoFolder = 'all';
let seoKeywordsLoaded = false;

const PAGE_META = {
  config: { title: '설정', subtitle: 'Netlify 대량 배포 및 네이버 서치어드바이저 자동 등록' },
  'seo-gen': { title: '넷리파이 생성', subtitle: '키워드 SEO 랜딩 생성 · Cursor AI · Netlify 배포 (KKang)' },
  'cf-pages': { title: 'Cloudflare Pages 생성', subtitle: 'Cloudflare Pages 사이트 생성 · 배포 (기본 틀 · 순차 업데이트)' },
  dothome: { title: '닷홈 호스팅 생성', subtitle: '닷홈 회원가입 자동화 · 이후 FTP/사이트 배포' },
  'token-gen': { title: '토큰 자동 생성', subtitle: '가입(수동) → 화면 인식 후 메일·온보딩·토큰·로그아웃 자동' },
  'url-crawl': { title: 'URL 수집', subtitle: '하위 URL 수집 후 네이버 웹페이지 수집 일괄 신청' },
  sites: { title: '생성 사이트', subtitle: 'Netlify · Cloudflare Pages · 닷홈 생성 목록 (생성일 포함)' },
  results: { title: '배포/등록 결과', subtitle: '저장된 배포 URL 및 네이버 등록 현황' },
};

const SITE_PROVIDER_META = {
  netlify: { label: 'Netlify', cls: 'netlify' },
  cloudflare: { label: 'Cloudflare', cls: 'cloudflare' },
  dothome: { label: '닷홈', cls: 'dothome' },
};

const SITE_STATUS_META = {
  deployed: { label: '배포됨', cls: 'success' },
  created: { label: '생성됨', cls: 'already' },
  generated: { label: '사이트 생성', cls: 'already' },
  account: { label: '계정만', cls: 'manual' },
  draft: { label: '초안', cls: 'manual' },
  success: { label: '완료', cls: 'success' },
  manual: { label: '수동', cls: 'manual' },
  error: { label: '오류', cls: 'error' },
};

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return (s || '').replace(/[<>"]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLines(text) {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function renderNetlifyTokens() {
  const el = $('netlifyTokens');
  const visible = config.netlifyTokens.map((t, i) => ({
    t, i, obj: typeof t === 'string' ? { token: t, id: '' } : (t || { token: '', id: '' }),
  })).filter(({ obj }) => obj.token);

  if (!visible.length) {
    el.innerHTML = '<p class="empty-hint">등록된 토큰이 없습니다. 위에서 토큰과 아이디를 입력 후 다중 추가하세요.</p>';
    return;
  }

  el.innerHTML = visible.map(({ t, i, obj }) => {
    const expanded = t.expanded !== false;
    const usedTag = t.used ? '<span class="tag tag-used">다씀</span>' : '';
    const countTag = `<span class="tag tag-count">${t.usedCount || 0}개</span>`;
    const label = obj.id ? obj.id : (obj.token ? `토큰 ${i + 1}` : `빈 토큰 ${i + 1}`);
    return `
    <div class="item ${expanded ? 'expanded' : ''}" data-idx="${i}">
      <div class="item-header">
        <span class="item-title" data-action="toggle-token" data-idx="${i}">${escapeHtml(label)} ${countTag}${usedTag}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <button type="button" class="btn btn-danger btn-sm" data-action="remove-token" data-idx="${i}">삭제</button>
          <span class="toggle-icon" data-action="toggle-token" data-idx="${i}">${expanded ? '▲' : '▼'}</span>
        </div>
      </div>
      <div class="item-body">
        <div class="token-grid">
          <div class="form-group"><label>토큰</label><input type="password" data-idx="${i}" data-field="token" value="${escapeHtml(obj.token)}" placeholder="nfp_..."></div>
          <div class="form-group"><label>아이디</label><input type="text" data-idx="${i}" data-field="id" value="${escapeHtml(obj.id)}" placeholder="계정 식별명"></div>
        </div>
        <div class="row" style="margin-top:8px;align-items:center;">
          <div class="form-group" style="margin-bottom:0;">
            <label>사용 개수</label>
            <input type="number" data-idx="${i}" data-field="usedCount" value="${t.usedCount || 0}" min="0" style="width:80px;">
          </div>
          <label class="inline-check" style="margin-bottom:6px;">
            <input type="checkbox" data-idx="${i}" data-field="used" ${t.used ? 'checked' : ''}> 크레딧 다씀
          </label>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderNaverAccounts() {
  const el = $('naverAccounts');
  const showEmpty = $('showEmptyAccounts')?.checked;
  const visible = config.naverAccounts.map((acc, i) => ({ acc, i }))
    .filter(({ acc }) => showEmpty || acc.id || acc.pw);

  if (!visible.length) {
    el.innerHTML = '<p class="empty-hint">등록된 계정이 없습니다.</p>';
    return;
  }

  el.innerHTML = visible.map(({ acc, i }) => {
    const expanded = acc.expanded !== false;
    const label = acc.id || `빈 계정 ${i + 1}`;
    return `
    <div class="item ${expanded ? 'expanded' : ''}" data-idx="${i}">
      <div class="item-header">
        <span class="item-title" data-action="toggle-account" data-idx="${i}">${escapeHtml(label)}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <button type="button" class="btn btn-danger btn-sm" data-action="remove-account" data-idx="${i}">삭제</button>
          <span class="toggle-icon" data-action="toggle-account" data-idx="${i}">${expanded ? '▲' : '▼'}</span>
        </div>
      </div>
      <div class="item-body">
        <div class="row">
          <div class="form-group"><label>ID</label><input type="text" data-idx="${i}" data-field="id" value="${escapeHtml(acc.id)}"></div>
          <div class="form-group"><label>PW</label><input type="password" data-idx="${i}" data-field="pw" value="${escapeHtml(acc.pw)}"></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderServices() {
  const el = $('services');
  if (!config.services.length) {
    el.innerHTML = '<p class="empty-hint">등록된 서비스가 없습니다.</p>';
    return;
  }
  el.innerHTML = config.services.map((s, i) => `
    <div class="item expanded">
      <div class="item-header">
        <span class="item-title">서비스 ${i + 1}${s.keyword ? ` · ${escapeHtml(s.keyword.split(',')[0])}` : ''}</span>
        <button class="btn btn-danger btn-sm" type="button" data-action="remove-service" data-idx="${i}">삭제</button>
      </div>
      <div class="item-body" style="display:block;">
        <div class="row">
          <div class="form-group"><label>키워드</label><input type="text" value="${escapeHtml(s.keyword)}" data-idx="${i}" data-field="keyword" placeholder="키워드1,키워드2"></div>
          <div class="form-group"><label>전화번호</label><input type="text" value="${escapeHtml(s.phone || '')}" data-idx="${i}" data-field="phone"></div>
        </div>
        <div class="row" style="margin-top:8px;">
          <div class="form-group"><label>생성 개수</label><input type="number" min="1" value="${s.count || 1}" data-idx="${i}" data-field="count" style="width:90px;"></div>
        </div>
      </div>
    </div>
  `).join('');
}

function addBulkTokens() {
  const tokens = parseLines($('bulkTokens').value);
  const ids = parseLines($('bulkIds').value);
  const validTokens = tokens.filter(t => t.startsWith('nfp_'));
  const skipped = tokens.length - validTokens.length;

  if (!validTokens.length) {
    alert('유효한 Netlify 토큰(nfp_로 시작)을 한 줄에 하나씩 입력하세요.');
    return;
  }

  for (let i = 0; i < validTokens.length; i++) {
    config.netlifyTokens.push({
      token: validTokens[i],
      id: ids[i] || '',
      used: false,
      usedCount: 0,
      expanded: false,
    });
  }

  $('bulkTokens').value = '';
  $('bulkIds').value = '';
  renderNetlifyTokens();

  let msg = `✅ ${validTokens.length}개 토큰 추가됨`;
  if (ids.length && ids.length !== validTokens.length) {
    msg += ` (아이디 ${ids.length}개 → ${Math.min(ids.length, validTokens.length)}개 매칭)`;
  }
  if (skipped) msg += ` · 형식 오류 ${skipped}개 제외`;
  logLine(msg);
}

function removeNetlifyToken(i) { config.netlifyTokens.splice(i, 1); renderNetlifyTokens(); }
function updateNetlifyToken(i, field, value) {
  if (typeof config.netlifyTokens[i] === 'string') {
    config.netlifyTokens[i] = { token: config.netlifyTokens[i], id: '', used: false, usedCount: 0 };
  }
  if (field === 'usedCount') value = Math.max(0, parseInt(value) || 0);
  config.netlifyTokens[i][field] = value;
  if (field === 'id' || field === 'token' || field === 'used' || field === 'usedCount') renderNetlifyTokens();
}
function toggleToken(i) {
  if (typeof config.netlifyTokens[i] === 'string') {
    config.netlifyTokens[i] = { token: config.netlifyTokens[i], id: '', used: false, usedCount: 0 };
  }
  config.netlifyTokens[i].expanded = !config.netlifyTokens[i].expanded;
  renderNetlifyTokens();
}

function addNaverAccount() {
  config.naverAccounts.forEach(a => { a.expanded = false; });
  config.naverAccounts.push({ id: '', pw: '', expanded: true });
  renderNaverAccounts();
}
function removeNaverAccount(i) { config.naverAccounts.splice(i, 1); renderNaverAccounts(); }
function updateNaverAccount(i, field, value) {
  config.naverAccounts[i][field] = value;
  if (field === 'id') renderNaverAccounts();
}
function toggleAccount(i) {
  config.naverAccounts[i].expanded = !config.naverAccounts[i].expanded;
  renderNaverAccounts();
}

function addService() {
  config.services.push({ keyword: '', phone: '', count: 1 });
  renderServices();
}
function removeService(i) { config.services.splice(i, 1); renderServices(); }
function updateService(i, field, value) {
  if (field === 'count') value = parseInt(value) || 1;
  config.services[i][field] = value;
}

function updateSourceModeHint() {
  const hint = $('sourceModeHint');
  if (!hint) return;
  hint.hidden = !deploySources.length;
}

async function restoreDeployFolder(folder, sources) {
  if (!folder) {
    updateSourceModeHint();
    return;
  }
  deployFolderPath = folder;
  deploySources = Array.isArray(sources) ? [...sources] : [];
  $('deployFolderName').textContent = folder.split(/[\\/]/).pop();
  const info = $('deployFolderInfo');
  info.style.display = 'block';
  if (deploySources.length) {
    const zipCount = deploySources.filter(s => s.type === 'zip').length;
    const folderCount = deploySources.filter(s => s.type === 'folder').length;
    info.textContent = `총 ${deploySources.length}개 배포 소스 (zip ${zipCount}, 폴더 ${folderCount}). index.html 타이틀로 결과에 표시됩니다.`;
  } else {
    info.textContent = '저장된 폴더 경로 (소스 목록 없음 — 폴더를 다시 선택하세요)';
  }
  updateSourceModeHint();
}

async function selectDeployFolder() {
  if (!window.electronAPI?.selectFolder) {
    alert('폴더 선택 기능을 사용할 수 없습니다.');
    return;
  }
  const folder = await window.electronAPI.selectFolder();
  if (!folder) return;
  deployFolderPath = folder;
  const files = await window.electronAPI.listFolderFiles(folder);
  const zipFiles = (files || []).filter(f => f.toLowerCase().endsWith('.zip'));

  deploySources = [];
  for (const f of zipFiles) {
    deploySources.push({ type: 'zip', path: folder + '\\' + f, name: f });
  }
  for (const d of files || []) {
    const subPath = folder + '\\' + d;
    try {
      const stat = await window.electronAPI.getFileStat(subPath);
      if (stat?.isDirectory) {
        const subFiles = await window.electronAPI.listFolderFiles(subPath);
        if (subFiles.includes('index.html')) {
          deploySources.push({ type: 'folder', path: subPath, name: d });
        }
      }
    } catch { /* ignore */ }
  }

  $('deployFolderName').textContent = folder.split(/[\\/]/).pop();
  const info = $('deployFolderInfo');
  info.style.display = 'block';
  if (deploySources.length) {
    const zipCount = deploySources.filter(s => s.type === 'zip').length;
    const folderCount = deploySources.filter(s => s.type === 'folder').length;
    info.textContent = `총 ${deploySources.length}개 배포 소스 (zip ${zipCount}, 폴더 ${folderCount}). index.html 타이틀로 결과에 표시됩니다.`;
  } else {
    info.textContent = 'zip/폴더 소스 없음 — 자동 생성 HTML로 배포합니다.';
  }
  updateSourceModeHint();
}

function collectConfig() {
  return {
    openaiApiKey: $('openaiApiKey').value.trim(),
    yesCaptchaClientKey: ($('yesCaptchaClientKey')?.value || '').trim(),
    headless: !!$('headlessMode')?.checked,
    metaInjectOnly: !!$('metaInjectOnly')?.checked,
    netlifyTokens: config.netlifyTokens
      .map(t => typeof t === 'string'
        ? { token: t, id: '', used: false, usedCount: 0 }
        : { token: (t.token || '').trim(), id: (t.id || '').trim(), used: !!t.used, usedCount: t.usedCount || 0 })
      .filter(t => t.token),
    naverAccounts: config.naverAccounts
      .map(a => ({ id: a.id.trim(), pw: a.pw.trim() }))
      .filter(a => a.id && a.pw),
    services: config.services
      .filter(s => s.keyword?.trim())
      .map(s => ({ ...s, count: parseInt(s.count) || 1 })),
    seoOptions: {
      metaTitles: parseLines($('metaTitles').value),
      metaDescriptions: parseLines($('metaDescriptions').value),
      metaKeywords: parseLines($('metaKeywords').value),
      generateSitemap: $('generateSitemap').checked,
      generateRobots: $('generateRobots').checked,
    },
    deployFolder: deployFolderPath,
    deploySources: [...deploySources],
    netlifyGenAccounts: parseGenAccountsFromBulk(),
    urlCrawlNaver: {
      id: ($('crawlNaverId')?.value || '').trim(),
      pw: ($('crawlNaverPw')?.value || '').trim(),
    },
    urlCrawlHomes: parseLines($('crawlHomeUrls')?.value || ''),
    urlCrawlSites: crawlSiteStatus.map((s) => ({
      url: s.url,
      status: s.status || '대기',
      message: s.message || '',
      at: s.at || '',
    })),
    urlCrawlOpts: {
      fast: !!$('crawlOptFast')?.checked,
      robots: !!$('crawlOptRobots')?.checked,
      sitemap: !!$('crawlOptSitemap')?.checked,
      webpage: !!$('crawlOptWebpage')?.checked,
    },
    cursorApiKey: ($('seoCursorKey')?.value || config.cursorApiKey || '').trim(),
    kkangBuilderPath: ($('seoBuilderPath')?.value || config.kkangBuilderPath || '').trim(),
    kkangFastAi: $('seoFastAi') ? !!$('seoFastAi').checked : (config.kkangFastAi !== false),
    kkangOutputDir: ($('seoOutputDir')?.value || config.kkangOutputDir || '').trim(),
    kkangNetlifyToken: ($('seoNetlifyToken')?.value || config.kkangNetlifyToken || '').trim(),
    kkangNetlifyId: ($('seoNetlifyId')?.value || config.kkangNetlifyId || '').trim(),
    cloudflare: {
      accountId: ($('cfAccountId')?.value || '').trim(),
      apiToken: ($('cfApiToken')?.value || '').trim(),
      projectName: ($('cfProjectName')?.value || '').trim(),
      brand: ($('cfBrand')?.value || '').trim(),
      phone: ($('cfPhone')?.value || '').trim(),
      naver: ($('cfNaver')?.value || '').trim(),
      outputDir: ($('cfOutputDir')?.value || '').trim(),
      keywords: ($('cfKeywords')?.value || ''),
      notes: ($('cfNotes')?.value || ''),
      sites: Array.isArray(config.cloudflare?.sites) ? config.cloudflare.sites : [],
      deploy: !!$('cfDeploy')?.checked,
      createProject: !!$('cfCreateProject')?.checked,
    },
    dothome: {
      hostId: ($('dhHostId')?.value || '').trim(),
      hostPw: ($('dhFixedPw')?.value || 'dlwkdrns12435!').trim(),
      emailLocal: ($('dhEmailLocal')?.value || '').trim().replace(/@.*$/, ''),
      keyword: ($('dhKeyword')?.value || '').trim(),
      externalUrl: ($('dhExternalUrl')?.value || '').trim(),
      phone: ($('dhPhone')?.value || '010-6338-7124').trim() || '010-6338-7124',
      imageDir: ($('dhImageDir')?.value || '').trim(),
      googleVerifyFile: ($('dhGoogleVerifyFile')?.value || '').trim(),
      ftpHost: ($('dhFtpHost')?.value || '').trim(),
      usedIds: Array.isArray(config.dothome?.usedIds) ? config.dothome.usedIds : [],
      usedFtpIds: Array.isArray(config.dothome?.usedFtpIds) ? config.dothome.usedFtpIds : [],
      accounts: Array.isArray(config.dothome?.accounts) ? config.dothome.accounts : [],
    },
  };
}

function syncHeadlessUi(on) {
  const checked = !!on;
  if ($('headlessMode')) $('headlessMode').checked = checked;
  for (const id of ['headlessToggleBtn', 'crawlHeadlessToggleBtn', 'dhHeadlessToggleBtn']) {
    const btn = $(id);
    if (!btn) continue;
    btn.textContent = checked ? '👻 헤드리스 ON' : '🖥 창 모드';
    btn.classList.toggle('btn-primary', checked);
    btn.classList.toggle('btn-ghost', !checked);
    btn.title = checked
      ? '헤드리스 ON — 클릭하면 창 모드로 전환'
      : '창 모드 — 클릭하면 헤드리스(창 숨김)로 전환';
  }
  const hint = $('headlessHint');
  if (hint) {
    hint.textContent = checked
      ? '헤드리스 ON: Chrome 창이 안 보입니다. 수동 로그인·캡챠 확인이 필요하면 OFF로 두세요.'
      : '창 모드: Chrome 창이 보입니다. 백그라운드 실행은 헤드리스를 켜세요.';
  }
}

function hasDeploySources(cfg) {
  return Array.isArray(cfg.deploySources) && cfg.deploySources.length > 0;
}

const STATUS_MAP = {
  success: { label: '성공', cls: 'success' },
  already: { label: '이미 등록', cls: 'already' },
  already_registered: { label: '이미 등록', cls: 'already' },
  error: { label: '오류', cls: 'error' },
  captcha: { label: '캡챠', cls: 'captcha' },
  unknown: { label: '미확인', cls: 'unknown' },
  manual: { label: '수동 완료', cls: 'manual' },
};

const INDEX_CHECK_STATUSES = new Set(['success', 'manual']);

function canIndexCheckRow(r) {
  return !!(r?.url?.trim());
}

function canReinjectRow(r) {
  return !!(
    r?.url
    && INDEX_CHECK_STATUSES.has(r.status)
    && r.indexed === false
    && r.indexCheckedAt
  );
}

function renderIndexCell(r, originalIndex) {
  if (!canIndexCheckRow(r)) {
    return '<span class="status-pill indexed-pending" style="opacity:0.5">—</span>';
  }
  if (r.indexed === true) {
    const title = r.indexSampleUrl ? ` title="${escapeHtml(r.indexSampleUrl)}"` : '';
    const when = r.indexCheckedAt ? `<br><span style="font-size:10px;color:var(--text-dim)">${formatDate(r.indexCheckedAt)}</span>` : '';
    const recheck = `<div class="index-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="check-index-one" data-idx="${originalIndex}" title="네이버 검색으로 재확인 (로그인 불필요)">재확인</button></div>`;
    return `<span class="status-pill indexed-yes"${title}>인덱싱됨</span>${when}${recheck}`;
  }
  if (r.indexed === false) {
    const when = r.indexCheckedAt ? `<br><span style="font-size:10px;color:var(--text-dim)">${formatDate(r.indexCheckedAt)}</span>` : '';
    const reinjectBtn = canReinjectRow(r)
      ? `<button class="btn btn-primary btn-sm" type="button" data-action="reinject-index" data-idx="${originalIndex}" title="서치어드바이저 수집 재신청 (네이버 계정 필요)">재인젝싱</button>`
      : '';
    const actions = `<div class="index-actions">
          ${reinjectBtn}
          <button class="btn btn-ghost btn-sm" type="button" data-action="check-index-one" data-idx="${originalIndex}" title="네이버 검색으로 재확인 (로그인 불필요)">재확인</button>
        </div>`;
    return `<span class="status-pill indexed-no">미인덱싱</span>${when}${r.indexCheckedAt ? actions : `<div class="index-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="check-index-one" data-idx="${originalIndex}">확인</button></div>`}`;
  }
  if (r.indexed === null && r.indexMessage) {
    const btn = `<button class="btn btn-ghost btn-sm" type="button" data-action="check-index-one" data-idx="${originalIndex}">재시도</button>`;
    return `<span class="status-pill indexed-fail">${escapeHtml(r.indexMessage)}</span> ${btn}`;
  }
  const btn = `<button class="btn btn-ghost btn-sm" type="button" data-action="check-index-one" data-idx="${originalIndex}">확인</button>`;
  return `<span class="status-pill indexed-pending">미확인</span> ${btn}`;
}

function updateStats(results) {
  const total = results.length;
  const success = results.filter(r => r.status === 'success' || r.status === 'already' || r.status === 'already_registered').length;
  const manual = results.filter(r => r.status === 'manual' || r.status === 'captcha').length;
  const error = results.filter(r => r.status === 'error').length;
  const indexed = results.filter(r => r.indexed === true).length;
  $('statTotal').textContent = total;
  $('statSuccess').textContent = success;
  $('statManual').textContent = manual;
  $('statError').textContent = error;
  $('statIndexed').textContent = indexed;
  const badge = $('resultsBadge');
  badge.textContent = total;
  badge.hidden = total === 0;

  const targets = results.filter(r => canIndexCheckRow(r)).length;
  const alreadyIndexed = results.filter(r => canIndexCheckRow(r) && r.indexed === true).length;
  const pending = results.filter(r => canIndexCheckRow(r) && r.indexed !== true).length;
  $('indexCheckHint').textContent = targets
    ? `확인 대상 ${targets}건 (네이버 site: 검색 · 로그인 불필요) · 인덱싱됨 ${alreadyIndexed}건 · 미확인/미인덱싱 ${pending}건`
    : '인덱싱 확인할 배포 URL이 없습니다.';
}

function renderResultsTable(results) {
  const list = $('resultsList');
  list.innerHTML = '';
  updateStats(results);

  if (!results?.length) {
    list.innerHTML = '<p class="empty-hint">저장된 결과가 없습니다.</p>';
    return;
  }

  const table = document.createElement('div');
  table.className = 'table-wrap';
  table.innerHTML = `
    <table class="results-table">
      <thead>
        <tr>
          <th class="col-check"><input type="checkbox" id="selectAllResultUrls" title="전체 선택"></th>
          <th>서비스명</th>
          <th>배포 URL</th>
          <th>네이버 등록</th>
          <th>인덱싱</th>
          <th>등록 일시</th>
          <th>네이버 계정</th>
          <th>Netlify</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>`;
  const tbody = table.querySelector('tbody');
  const rows = [...results].reverse();

  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const originalIndex = r.originalIndex ?? (results.length - 1 - idx);
    const st = STATUS_MAP[r.status] || { label: r.status || '-', cls: 'unknown' };
    const manualBtn = r.status === 'captcha'
      ? `<button class="btn btn-primary btn-sm" type="button" data-action="mark-manual" data-idx="${originalIndex}">수동완료</button>`
      : '';
    const url = (r.url || '').trim();
    const urlCell = url
      ? `<div class="url-cell">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
          <button class="btn btn-ghost btn-sm url-copy-btn" type="button" data-action="copy-url" data-url="${escapeHtml(url)}" title="URL 복사">복사</button>
        </div>`
      : '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="result-url-check" data-url="${escapeHtml(url)}" ${url ? '' : 'disabled'}></td>
      <td>${escapeHtml(r.name || '-')}</td>
      <td>${urlCell}</td>
      <td><span class="status-pill ${st.cls}">${st.label}</span>${manualBtn}${r.error ? `<br><span style="color:var(--danger);font-size:11px;">${escapeHtml(r.error)}</span>` : ''}</td>
      <td>${renderIndexCell(r, originalIndex)}</td>
      <td>${formatDate(r.registeredAt)}</td>
      <td>${escapeHtml(r.naverAccountId || '-')}</td>
      <td>${escapeHtml(r.netlifyAccountId || '-')}</td>
      <td><button class="btn btn-danger btn-sm" type="button" data-action="delete-result" data-idx="${originalIndex}">삭제</button></td>`;
    tbody.appendChild(tr);
  }
  list.appendChild(table);

  const selectAll = $('selectAllResultUrls');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      list.querySelectorAll('.result-url-check:not(:disabled)').forEach((cb) => {
        cb.checked = selectAll.checked;
      });
    });
  }
}

async function copyToClipboard(text, okMsg, { sitesTab = false } = {}) {
  if (!text) return alert('복사할 URL이 없습니다.');
  try {
    if (window.electronAPI?.clipboardWrite) {
      await window.electronAPI.clipboardWrite(text);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed');
      ta.remove();
    }
    if (okMsg) {
      if (sitesTab) {
        setSitesIndexProgress(okMsg, true);
        setTimeout(() => setSitesIndexProgress('', false), 2500);
      } else {
        setIndexProgress(okMsg, true);
        setTimeout(() => setIndexProgress('', false), 2500);
      }
    }
    return true;
  } catch (e) {
    alert(`복사 실패: ${e?.message || e}`);
    return false;
  }
}

function getVisibleResultUrls() {
  const checks = document.querySelectorAll('#resultsList .result-url-check');
  const urls = [];
  checks.forEach((cb) => {
    const u = (cb.dataset.url || '').trim();
    if (u) urls.push(u);
  });
  return urls;
}

function getSelectedResultUrls() {
  const checks = document.querySelectorAll('#resultsList .result-url-check:checked');
  const urls = [];
  checks.forEach((cb) => {
    const u = (cb.dataset.url || '').trim();
    if (u) urls.push(u);
  });
  return urls;
}

async function copySelectedResultUrls() {
  const urls = getSelectedResultUrls();
  if (!urls.length) return alert('복사할 URL을 체크하세요.');
  await copyToClipboard(urls.join('\n'), `📋 ${urls.length}개 URL 복사됨`);
}

async function copyAllResultUrls() {
  const urls = getVisibleResultUrls();
  if (!urls.length) return alert('복사할 URL이 없습니다.');
  await copyToClipboard(urls.join('\n'), `📋 전체 ${urls.length}개 URL 복사됨`);
}

function filterResults() {
  const q = $('resultsSearch').value.trim().toLowerCase();
  if (!q) {
    renderResultsTable(savedResults);
    return;
  }
  const filtered = savedResults
    .map((r, originalIndex) => ({ ...r, originalIndex }))
    .filter(r =>
      (r.url || '').toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.netlifyAccountId || '').toLowerCase().includes(q) ||
      (r.naverAccountId || '').toLowerCase().includes(q)
    );
  renderResultsTable(filtered);
}

async function deleteResult(index) {
  if (!confirm('이 결과를 삭제하시겠습니까?')) return;
  savedResults.splice(index, 1);
  await window.electronAPI.saveResults(savedResults);
  filterResults();
}

async function markManualCaptcha(index) {
  if (!confirm('수동 캡챠 완료로 표시하시겠습니까?')) return;
  savedResults[index].status = 'manual';
  savedResults[index].registeredAt = new Date().toISOString();
  await window.electronAPI.saveResults(savedResults);
  filterResults();
}

async function clearAllResults() {
  if (!confirm('모든 결과를 삭제하시겠습니까?')) return;
  savedResults = [];
  await window.electronAPI.saveResults(savedResults);
  renderResultsTable([]);
}

let indexCheckRunning = false;
let reinjectRunning = false;

function setIndexProgress(text, show = true) {
  const el = $('indexProgress');
  if (!show || !text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

async function runIndexCheck(indices = null) {
  if (indexCheckRunning) return;
  indexCheckRunning = true;
  const btn = $('checkIndexBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 확인 중...';
  setIndexProgress('인덱싱 확인 준비 중...');

  try {
    const out = await window.electronAPI.checkIndex({ indices });
    if (out.error) {
      if (out.summary?.skipped && !out.summary?.checked) {
        setIndexProgress(out.error, true);
        setTimeout(() => setIndexProgress('', false), 6000);
      } else {
        alert(out.error);
      }
      return;
    }
    savedResults = out.results || savedResults;
    filterResults();
    const s = out.summary || {};
    const skipPart = s.skipped ? ` · 생략(이미 인덱싱) ${s.skipped}` : '';
    setIndexProgress(`완료: ${s.checked || 0}건 확인 · 인덱싱 ${s.indexed || 0} · 미인덱싱 ${s.notIndexed || 0}${s.failed ? ` · 실패 ${s.failed}` : ''}${skipPart}`, true);
    setTimeout(() => setIndexProgress('', false), 8000);
  } finally {
    indexCheckRunning = false;
    btn.disabled = false;
    btn.textContent = '🔍 인덱싱 확인';
  }
}

async function checkIndexOne(index, { force = false, fromReinject = false } = {}) {
  if (indexCheckRunning || (!fromReinject && reinjectRunning)) return;
  const r = savedResults[index];
  if (!canIndexCheckRow(r)) return;
  if (!force && r.indexed === true) return;
  indexCheckRunning = true;
  setIndexProgress(`확인 중: ${r.url}`);
  try {
    const out = await window.electronAPI.checkIndex({ indices: [index], force: force || r.indexed === false });
    if (out.error && !out.results) {
      alert(out.error);
      return;
    }
    if (out.results) savedResults = out.results;
    filterResults();
    if (out.summary) {
      const s = out.summary;
      setIndexProgress(`재확인 완료: 인덱싱 ${s.indexed || 0} · 미인덱싱 ${s.notIndexed || 0}`, true);
      setTimeout(() => setIndexProgress('', false), 5000);
    }
  } finally {
    indexCheckRunning = false;
    if (!reinjectRunning) setIndexProgress('', false);
  }
}

async function reinjectIndexOne(index) {
  if (reinjectRunning || indexCheckRunning) return;
  const r = savedResults[index];
  if (!canReinjectRow(r)) {
    if (!r?.url) return;
    alert('재인젝싱은 네이버 등록 성공·수동 완료 후, 인덱싱 확인에서 미인덱싱으로 나온 경우에만 가능합니다.\n인덱싱 여부만 보려면 「재확인」을 누르세요. (네이버 검색만 사용, 계정 불필요)');
    return;
  }
  if (!confirm(`${r.name || r.url}\n네이버 웹페이지 수집(인덱싱)을 재신청하시겠습니까?\n완료 후 인덱싱 상태를 다시 확인합니다.`)) return;

  reinjectRunning = true;
  setIndexProgress(`재인젝싱 중: ${r.url}`);
  try {
    const out = await window.electronAPI.reinjectIndex({ index });
    if (out.error) {
      alert(out.error);
      return;
    }
    if (out.results) savedResults = out.results;
    filterResults();
    setIndexProgress('재인젝싱 완료 — 인덱싱 재확인 중...');
    await new Promise(res => setTimeout(res, 2000));
    await checkIndexOne(index, { force: true, fromReinject: true });
  } finally {
    reinjectRunning = false;
  }
}

function switchTab(name) {
  currentTabName = name;
  $('configPanel').classList.toggle('active', name === 'config');
  $('seoGenPanel')?.classList.toggle('active', name === 'seo-gen');
  $('cfPagesPanel')?.classList.toggle('active', name === 'cf-pages');
  $('dothomePanel')?.classList.toggle('active', name === 'dothome');
  $('tokenGenPanel').classList.toggle('active', name === 'token-gen');
  $('urlCrawlPanel').classList.toggle('active', name === 'url-crawl');
  $('sitesPanel')?.classList.toggle('active', name === 'sites');
  $('resultsPanel').classList.toggle('active', name === 'results');
  $('nav-config').classList.toggle('active', name === 'config');
  $('nav-seo-gen')?.classList.toggle('active', name === 'seo-gen');
  $('nav-cf-pages')?.classList.toggle('active', name === 'cf-pages');
  $('nav-dothome')?.classList.toggle('active', name === 'dothome');
  $('nav-token-gen').classList.toggle('active', name === 'token-gen');
  $('nav-url-crawl').classList.toggle('active', name === 'url-crawl');
  $('nav-sites')?.classList.toggle('active', name === 'sites');
  $('nav-results').classList.toggle('active', name === 'results');
  const meta = PAGE_META[name] || PAGE_META.config;
  $('pageTitle').textContent = meta.title;
  $('pageSubtitle').textContent = meta.subtitle;
  const onSeo = name === 'seo-gen';
  const onSites = name === 'sites';
  const onConfig = name === 'config';
  // Netlify 로그인 버튼: 설정/생성/사이트 탭
  if ($('seoNetlifyLoginBtn')) $('seoNetlifyLoginBtn').hidden = !(onSeo || onSites || onConfig);
  if ($('seoNetlifyCreditRefreshBtn')) $('seoNetlifyCreditRefreshBtn').hidden = !(onSeo || onSites || onConfig);
  // 크레딧: 설정 + 넷리파이 생성 + 생성 사이트
  updateNetlifyCreditBadgeVisibility(onSeo || onSites || onConfig);
  updateNaverSessionBadge();
  updateNaverLoginButton();
  if (name === 'results') loadSavedResults();
  if (name === 'sites') loadCreatedSites();
  if (name === 'seo-gen' && !seoKeywordsLoaded) loadSeoKeywords();
}

let netlifyCreditState = null;
let currentTabName = 'config';

function formatNetlifyCredits(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

function updateNetlifyCreditBadgeVisibility(forceShow) {
  const badge = $('netlifyCreditBadge');
  if (!badge) return;
  const showTab = forceShow != null
    ? !!forceShow
    : (currentTabName === 'seo-gen' || currentTabName === 'sites' || currentTabName === 'config');
  const hasData = !!(netlifyCreditState && (netlifyCreditState.teamSlug || netlifyCreditState.credits != null || netlifyCreditState.status));
  badge.hidden = !(showTab && hasData);
}

let naverSessionState = { status: 'idle', accountId: '', loggedIn: false, siteCount: null };

function updateNaverLoginButton() {
  const btn = $('naverLoginBtn');
  const refreshBtn = $('naverSiteCountRefreshBtn');
  if (!btn) return;
  const st = naverSessionState.status || 'idle';
  const loggedIn = st === 'ready' && !!naverSessionState.accountId;
  if (st === 'starting') {
    btn.textContent = '로그인 중…';
    btn.disabled = true;
  } else if (loggedIn) {
    btn.textContent = '네이버 재로그인';
    btn.disabled = false;
  } else {
    btn.textContent = '네이버 로그인';
    btn.disabled = false;
  }
  if (refreshBtn) refreshBtn.hidden = !loggedIn;
}

function updateNaverSessionBadge(data) {
  if (data) naverSessionState = { ...naverSessionState, ...data };
  const badge = $('naverSessionBadge');
  const idEl = $('naverSessionId');
  const countEl = $('naverSessionCount');
  if (!badge || !idEl) return;
  badge.classList.remove('waiting', 'error');
  const id = naverSessionState.accountId || '';
  const st = naverSessionState.status || 'idle';
  const sc = naverSessionState.siteCount;
  const countText = (sc != null && Number.isFinite(Number(sc))) ? `· ${Number(sc)}개` : '';

  if (countEl) {
    if (countText) {
      countEl.textContent = countText;
      countEl.hidden = false;
    } else {
      countEl.textContent = '';
      countEl.hidden = true;
    }
  }

  if (st === 'ready' && id) {
    idEl.textContent = id;
    badge.hidden = false;
  } else if (st === 'starting') {
    idEl.textContent = '로그인 중…';
    badge.classList.add('waiting');
    badge.hidden = false;
    if (countEl) countEl.hidden = true;
  } else if (st === 'error') {
    idEl.textContent = naverSessionState.error ? String(naverSessionState.error).slice(0, 28) : '로그인 실패';
    badge.classList.add('error');
    badge.hidden = false;
    if (countEl) countEl.hidden = true;
  } else if (id) {
    idEl.textContent = id;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
  updateNaverLoginButton();
}

async function startNaverLogin(ev) {
  const btn = $('naverLoginBtn');
  if (btn) btn.disabled = true;
  updateNaverSessionBadge({ status: 'starting' });
  try {
    // 이미 로그인된 Chrome이 있으면 재로그인하지 않고 세션만 붙잡음
    // (Shift+클릭 시에만 강제 재로그인)
    const forceRelogin = !!(ev && ev.shiftKey);
    const res = await window.electronAPI.naverSessionStart?.({ forceRelogin });
    if (res && !res.ok) {
      updateNaverSessionBadge({
        status: 'error',
        error: res.error || '로그인 실패',
        accountId: '',
        loggedIn: false,
        siteCount: null,
      });
      alert(res.error || '네이버 로그인 실패');
    } else if (res) {
      updateNaverSessionBadge(res);
      if (res.siteCount != null) logLine(`[네이버] 로그인 완료 · 등록 ${res.siteCount}개`);
      else if (res.loggedIn || res.status === 'ready') logLine(`[네이버] 세션 연결됨 · ${res.accountId || ''}`);
    }
  } catch (e) {
    updateNaverSessionBadge({ status: 'error', error: e.message || String(e), accountId: '', loggedIn: false });
    alert(e.message || '네이버 로그인 실패');
  } finally {
    updateNaverLoginButton();
  }
}

async function refreshNaverSiteCount() {
  try {
    const res = await window.electronAPI.naverSessionRefreshSites?.();
    if (res) updateNaverSessionBadge(res);
    if (res?.ok && res.siteCount != null) logLine(`[네이버] 등록 사이트 ${res.siteCount}개`);
    else if (res && !res.ok) alert(res.error || '조회 실패');
  } catch (e) {
    alert(e.message || '조회 실패');
  }
}

function renderNetlifyCreditBadge(data) {
  if (!data) return;
  netlifyCreditState = data;
  const badge = $('netlifyCreditBadge');
  const idEl = $('netlifyCreditId');
  const amtEl = $('netlifyCreditAmount');
  if (!badge || !idEl || !amtEl) return;

  const team = data.teamSlug || data.email || '—';
  idEl.textContent = team;

  badge.classList.remove('waiting', 'error');
  if (data.ok && data.credits != null) {
    amtEl.textContent = formatNetlifyCredits(data.credits);
  } else if (data.status === 'waiting_login' || data.status === 'starting' || data.status === 'ready') {
    badge.classList.add('waiting');
    amtEl.textContent = data.status === 'ready' ? '↻ 로 확인' : '로그인 대기';
  } else if (data.credits != null) {
    amtEl.textContent = formatNetlifyCredits(data.credits);
    if (data.status === 'error' || data.status === 'no_credits_ui') badge.classList.add('waiting');
  } else {
    badge.classList.add(data.status === 'error' ? 'error' : 'waiting');
    amtEl.textContent = data.message ? String(data.message).slice(0, 24) : '확인 중…';
  }
  updateNetlifyCreditBadgeVisibility();
}

async function startNetlifyCreditsLogin() {
  seoLog('Netlify 로그인 Chrome 실행…');
  const teamHint = (
    config.netlifyCreditsTeam
    || netlifyCreditState?.teamSlug
    || 'minji-cho9475'
  ).trim();
  const out = await window.electronAPI.netlifyCreditsLogin({ teamSlug: teamHint });
  if (out?.error) {
    seoLog(`✖ ${out.error}`);
    alert(out.error);
    return;
  }
  seoLog(`빌링: https://app.netlify.com/teams/${teamHint}/billing/general`);
  seoLog('로그인 후 크레딧은 「↻」또는 배포 완료 시에만 갱신됩니다. (자동 반복 수집 없음)');
  if (out) renderNetlifyCreditBadge(out);
}

async function refreshNetlifyCreditsUi() {
  seoLog('크레딧 새로고침…');
  const out = await window.electronAPI.netlifyCreditsRefresh({
    teamSlug: (config.netlifyCreditsTeam || netlifyCreditState?.teamSlug || 'minji-cho9475').trim(),
  });
  if (out?.error && out.credits == null) {
    seoLog(`크레딧 새로고침: ${out.error}`);
  }
  if (out) renderNetlifyCreditBadge(out);
}

function updateSitesStats(list) {
  const all = Array.isArray(list) ? list : [];
  const n = all.filter((s) => s.provider === 'netlify').length;
  const c = all.filter((s) => s.provider === 'cloudflare').length;
  const d = all.filter((s) => s.provider === 'dothome').length;
  const indexed = all.filter((s) => s.indexed === true).length;
  if ($('siteStatTotal')) $('siteStatTotal').textContent = all.length;
  if ($('siteStatNetlify')) $('siteStatNetlify').textContent = n;
  if ($('siteStatCloudflare')) $('siteStatCloudflare').textContent = c;
  if ($('siteStatDothome')) $('siteStatDothome').textContent = d;
  if ($('siteStatIndexed')) $('siteStatIndexed').textContent = indexed;
  const badge = $('sitesBadge');
  if (badge) {
    badge.textContent = all.length;
    badge.hidden = all.length === 0;
  }

  const withUrl = all.filter((s) => !!(s.url || '').trim()).length;
  const pending = all.filter((s) => (s.url || '').trim() && s.indexed !== true).length;
  const hint = $('sitesIndexHint');
  if (hint) {
    hint.textContent = withUrl
      ? `URL ${withUrl}건 · 인덱싱됨 ${indexed}건 · 미확인/미인덱싱 ${pending}건 (네이버 site: 검색 · 로그인 불필요)`
      : '인덱싱 확인할 URL이 없습니다.';
  }
}

function renderSiteIndexCell(site) {
  const url = (site?.url || '').trim();
  if (!url) {
    return '<span class="status-pill indexed-pending" style="opacity:0.5">—</span>';
  }
  const idAttr = escapeHtml(site.id || '');
  if (site.indexed === true) {
    const when = site.indexCheckedAt
      ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">${formatDate(site.indexCheckedAt)}</div>`
      : '';
    return `<span class="status-pill indexed-yes" title="${escapeHtml(site.indexMessage || '인덱싱됨')}">인덱싱됨</span>${when}
      <div class="index-actions"><button class="btn btn-ghost btn-sm" type="button" data-sites-action="check-index" data-id="${idAttr}" title="재확인">재확인</button></div>`;
  }
  if (site.indexed === false) {
    const when = site.indexCheckedAt
      ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">${formatDate(site.indexCheckedAt)}</div>`
      : '';
    return `<span class="status-pill indexed-no">미인덱싱</span>${when}
      <div class="index-actions"><button class="btn btn-ghost btn-sm" type="button" data-sites-action="check-index" data-id="${idAttr}">재확인</button></div>`;
  }
  if (site.indexed === null && site.indexMessage) {
    return `<span class="status-pill indexed-fail">${escapeHtml(site.indexMessage)}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-sites-action="check-index" data-id="${idAttr}">재시도</button>`;
  }
  return `<span class="status-pill indexed-pending">미확인</span>
    <button class="btn btn-ghost btn-sm" type="button" data-sites-action="check-index" data-id="${idAttr}">확인</button>`;
}

function isSiteNaverDone(site) {
  const d = site?.detail || {};
  const st = String(d.naverStatus || '').toLowerCase();
  if (st === 'captcha' || st === 'error' || st === 'fail' || st === 'failed' || st === 'unknown') return false;
  if (d.naverError && !['success', 'already', 'manual'].includes(st)) return false;
  if (d.naverAuto === true) return true;
  if (st === 'success' || st === 'already' || st === 'manual') return true;
  // 메타만 있고 실패 흔적 없으면 완료 (구버전)
  if (d.naverMeta && !d.naverError) return true;
  return false;
}

/** 메타는 있는데 소유확인/캡챠 실패 → 색인재시도 대상 */
function needsNaverIndexRetry(site) {
  if (site?.provider !== 'netlify') return false;
  if (isSiteNaverDone(site)) return false;
  const d = site?.detail || {};
  const st = String(d.naverStatus || '').toLowerCase();
  if (st === 'captcha' || /captcha/i.test(String(d.naverError || ''))) return true;
  if (d.naverMeta) return true;
  if (d.naverError && (site.url || '').trim()) return true;
  return false;
}

function siteDetailHtml(site) {
  const d = site.detail || {};
  if (site.provider === 'netlify') {
    const bits = [];
    if (d.title) bits.push(d.title);
    if (d.pageUrlCount) bits.push(`웹수집 ${d.pageUrlCount}URL`);
    if (d.brand) bits.push(d.brand);
    if (d.pages) bits.push(`${d.pages}페이지`);
    if (d.keywords) bits.push(`키워드 ${d.keywords}개`);
    if (isSiteNaverDone(site)) bits.push('네이버 완료');
    else if (d.naverError) bits.push(`네이버 실패: ${String(d.naverError).slice(0, 40)}`);
    if (d.theme) bits.push(d.theme);
    return bits.join(' · ') || 'Netlify SEO 사이트';
  }
  if (site.provider === 'cloudflare') {
    const bits = [];
    if (d.brand) bits.push(d.brand);
    if (d.notes) bits.push(d.notes);
    return bits.join(' · ') || 'Cloudflare Pages';
  }
  if (site.provider === 'dothome') {
    const bits = [];
    if (d.hostId) bits.push(`회원 ${d.hostId}`);
    if (d.ftpId) bits.push(`FTP ${d.ftpId}`);
    if (d.keyword) bits.push(d.keyword);
    if (d.email) bits.push(d.email);
    if (d.naverStatus) bits.push(`네이버 ${d.naverStatus}`);
    if (d.deployedAt) bits.push(`배포 ${formatDate(d.deployedAt)}`);
    else if (d.generatedAt) bits.push(`생성 ${formatDate(d.generatedAt)}`);
    return bits.join(' · ') || '닷홈 호스팅';
  }
  return '-';
}

function siteAccountIds(site) {
  const d = site?.detail || {};
  if (site.provider === 'netlify') {
    return {
      naverId: d.naverAccountId || '',
      netlifyId: d.netlifyAccountId || '',
    };
  }
  if (site.provider === 'cloudflare') {
    return {
      naverId: d.naverAccountId || '',
      netlifyId: d.accountId || '',
    };
  }
  if (site.provider === 'dothome') {
    return {
      naverId: d.naverAccountId || '',
      netlifyId: '',
    };
  }
  return { naverId: '', netlifyId: '' };
}

function getFilteredCreatedSites() {
  const q = ($('sitesSearch')?.value || '').trim().toLowerCase();
  return createdSites
    .filter((s) => sitesFilter === 'all' || s.provider === sitesFilter)
    .filter((s) => {
      if (!q) return true;
      const d = s.detail || {};
      const hay = [
        s.name, s.url, s.status, s.provider,
        d.brand, d.keyword, d.ftpId, d.hostId, d.email, d.notes, d.phone,
      ].join(' ').toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      const ta = new Date(a.createdAt || a.updatedAt || 0).getTime();
      const tb = new Date(b.createdAt || b.updatedAt || 0).getTime();
      return tb - ta;
    });
}

function renderCreatedSites() {
  const list = $('sitesList');
  if (!list) return;
  updateSitesStats(createdSites);
  const rows = getFilteredCreatedSites();
  if (!rows.length) {
    list.innerHTML = '<p class="empty-hint">표시할 생성 사이트가 없습니다. 넷리파이/Cloudflare/닷홈에서 만들거나 「새로고침」으로 기존 데이터를 불러오세요.</p>';
    return;
  }

  const table = document.createElement('div');
  table.className = 'table-wrap';
  table.innerHTML = `
    <table class="results-table">
      <thead>
        <tr>
          <th>유형</th>
          <th>이름</th>
          <th>URL</th>
          <th>네이버 아이디</th>
          <th>Netlify 아이디</th>
          <th>상태</th>
          <th>인덱싱</th>
          <th>생성일</th>
          <th>상세</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>`;
  const tbody = table.querySelector('tbody');

  for (const s of rows) {
    const prov = SITE_PROVIDER_META[s.provider] || { label: s.provider, cls: 'unknown' };
    const st = SITE_STATUS_META[s.status] || { label: s.status || '-', cls: 'unknown' };
    const url = (s.url || '').trim();
    const accounts = siteAccountIds(s);
    const urlCell = url
      ? `<div class="url-cell">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
          <button class="btn btn-ghost btn-sm url-copy-btn" type="button" data-sites-action="copy" data-url-enc="${encodeURIComponent(url)}">복사</button>
        </div>`
      : '-';
    const canRetryNaver = s.provider === 'netlify' && !!(s.url || '').trim();
    const naverDone = canRetryNaver && isSiteNaverDone(s);
    const indexRetry = canRetryNaver && needsNaverIndexRetry(s);
    let naverBtn = '';
    if (canRetryNaver) {
      if (naverDone) {
        naverBtn = `
          <span class="status-pill success" title="네이버 소유확인·인덱싱 신청 완료${accounts.naverId ? ` · ${accounts.naverId}` : ''}">네이버 완료</span>
          <button class="btn btn-ghost btn-sm" type="button" data-sites-action="retry-naver-index" data-id="${escapeHtml(s.id)}" title="소유확인·인덱싱만 다시">색인재시도</button>`;
      } else if (indexRetry) {
        naverBtn = `
          <span class="status-pill indexed-fail" title="${escapeHtml(s.detail?.naverError || s.detail?.naverStatus || '소유확인 미완료')}">네이버 미완료</span>
          <button class="btn btn-warning btn-sm" type="button" data-sites-action="retry-naver-index" data-id="${escapeHtml(s.id)}" title="서치어드바이저 검색 → 소유확인 → 인덱싱 (재배포 없음)">색인재시도</button>
          <button class="btn btn-ghost btn-sm" type="button" data-sites-action="retry-naver" data-id="${escapeHtml(s.id)}" title="HTML 인증부터 다시">인증재시도</button>`;
      } else {
        naverBtn = `<button class="btn btn-primary btn-sm" type="button" data-sites-action="retry-naver" data-id="${escapeHtml(s.id)}" title="네이버 HTML 인증 추출 → head 삽입 → Netlify 재배포">네이버 인증</button>`;
      }
    }
    const titleLine = s.detail?.title
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(s.detail.title)}</div>`
      : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="provider-pill ${prov.cls}">${prov.label}</span></td>
      <td><strong>${escapeHtml(s.name || '-')}</strong>${titleLine}</td>
      <td>${urlCell}</td>
      <td>${accounts.naverId
        ? `<div class="naver-id-cell">
            <span class="naver-id-value">${escapeHtml(accounts.naverId)}</span>
            ${s.detail?.naverIdManual
              ? `<button class="naver-id-manual-tag" type="button" data-sites-action="set-naver-id" data-id="${escapeHtml(s.id)}" title="다시 입력">수동입력완료</button>`
              : `<button class="btn btn-ghost btn-sm" type="button" data-sites-action="set-naver-id" data-id="${escapeHtml(s.id)}" title="네이버 아이디 수정">수정</button>`}
          </div>`
        : `<div class="naver-id-empty-row">
            <span style="color:var(--text-dim)">-</span>
            <button class="btn btn-ghost btn-sm" type="button" data-sites-action="set-naver-id" data-id="${escapeHtml(s.id)}" title="네이버 아이디 수동 입력">수동입력</button>
          </div>`}</td>
      <td>${accounts.netlifyId ? escapeHtml(accounts.netlifyId) : '<span style="color:var(--text-dim)">-</span>'}</td>
      <td><span class="status-pill ${st.cls}">${st.label}</span></td>
      <td>${renderSiteIndexCell(s)}</td>
      <td>${formatDate(s.createdAt)}</td>
      <td><div class="sites-detail">${escapeHtml(siteDetailHtml(s))}</div></td>
      <td style="white-space:nowrap;display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        ${naverBtn}
        <button class="btn btn-danger btn-sm" type="button" data-sites-action="delete" data-id="${escapeHtml(s.id)}">삭제</button>
      </td>`;
    tbody.appendChild(tr);
  }
  list.innerHTML = '';
  list.appendChild(table);
}

async function loadCreatedSites(forceSync = true) {
  try {
    createdSites = forceSync
      ? (await window.electronAPI.syncCreatedSites()) || []
      : (await window.electronAPI.loadCreatedSites({ sync: false })) || [];
  } catch {
    createdSites = [];
  }
  renderCreatedSites();
}

function filterCreatedSites() {
  renderCreatedSites();
}

async function deleteCreatedSite(id) {
  if (!id) return;
  if (!confirm('이 사이트를 목록에서 삭제할까요?\n(실제 호스팅/배포는 삭제되지 않습니다)')) return;
  createdSites = (await window.electronAPI.deleteCreatedSite(id)) || [];
  renderCreatedSites();
}

async function clearCreatedSites() {
  if (!createdSites.length) return;
  if (!confirm(`생성 사이트 ${createdSites.length}건을 목록에서 모두 삭제할까요?\n(실제 호스팅/배포는 삭제되지 않습니다)`)) return;
  createdSites = (await window.electronAPI.saveCreatedSites([])) || [];
  renderCreatedSites();
}

async function copyCreatedSiteUrls() {
  const urls = getFilteredCreatedSites().map((s) => (s.url || '').trim()).filter(Boolean);
  if (!urls.length) return alert('복사할 URL이 없습니다.');
  const ok = await copyToClipboard(urls.join('\n'), `📋 ${urls.length}개 URL 복사됨`, { sitesTab: true });
  if (ok) alert(`${urls.length}개 URL을 복사했습니다.`);
}

let sitesIndexCheckRunning = false;

function setSitesIndexProgress(text, show = true) {
  const el = $('sitesIndexProgress');
  if (!el) return;
  if (!show || !text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

async function runSitesIndexCheck(ids = null) {
  if (sitesIndexCheckRunning || indexCheckRunning) return;
  sitesIndexCheckRunning = true;
  const btn = $('sitesCheckIndexBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 확인 중...';
  }
  setSitesIndexProgress('인덱싱 확인 준비 중...');

  try {
    const out = await window.electronAPI.checkSitesIndex({
      ids,
      force: Array.isArray(ids) && ids.length === 1,
    });
    if (out?.results) createdSites = out.results;
    renderCreatedSites();

    if (out?.error) {
      if (out.summary?.skipped && !out.summary?.checked) {
        setSitesIndexProgress(out.error, true);
        setTimeout(() => setSitesIndexProgress('', false), 6000);
      } else {
        alert(out.error);
        setSitesIndexProgress('', false);
      }
      return;
    }

    const s = out?.summary || {};
    const skipPart = s.skipped ? ` · 이미 인덱싱 ${s.skipped}건 건너뜀` : '';
    setSitesIndexProgress(
      `완료: ${s.checked || 0}건 확인 · 인덱싱 ${s.indexed || 0} · 미인덱싱 ${s.notIndexed || 0}${s.failed ? ` · 실패 ${s.failed}` : ''}${skipPart}`,
      true,
    );
    setTimeout(() => setSitesIndexProgress('', false), 8000);
  } catch (e) {
    alert(e.message || String(e));
    setSitesIndexProgress('', false);
  } finally {
    sitesIndexCheckRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 인덱싱 확인';
    }
  }
}

async function checkSiteIndexOne(id) {
  if (!id) return;
  const site = createdSites.find((s) => s.id === id);
  if (!site?.url) return alert('URL이 없습니다.');
  await runSitesIndexCheck([id]);
}

let manualNaverIdPendingId = null;

function closeManualNaverIdModal() {
  manualNaverIdPendingId = null;
  const modal = $('manualNaverIdModal');
  if (modal) modal.hidden = true;
  const input = $('manualNaverIdInput');
  if (input) input.value = '';
}

function openManualNaverIdModal(site) {
  manualNaverIdPendingId = site.id;
  const modal = $('manualNaverIdModal');
  const input = $('manualNaverIdInput');
  const hint = $('manualNaverIdSiteHint');
  if (!modal || !input) {
    alert('입력 창을 열 수 없습니다.');
    return;
  }
  if (hint) hint.textContent = `${site.name || ''}${site.url ? ` · ${site.url}` : ''}`.trim();
  input.value = site.detail?.naverAccountId || '';
  modal.hidden = false;
  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
}

async function saveManualNaverIdFromModal() {
  const id = manualNaverIdPendingId;
  if (!id) return;
  const site = createdSites.find((s) => s.id === id);
  if (!site) {
    closeManualNaverIdModal();
    return alert('사이트를 찾을 수 없습니다.');
  }
  const naverAccountId = String($('manualNaverIdInput')?.value || '').trim();
  if (!naverAccountId) return alert('아이디를 입력하세요.');
  try {
    const saved = await window.electronAPI.upsertCreatedSite({
      id: site.id,
      provider: site.provider,
      name: site.name,
      url: site.url,
      status: site.status,
      detail: {
        ...(site.detail || {}),
        naverAccountId,
        naverIdManual: true,
      },
    });
    if (Array.isArray(saved)) createdSites = saved;
    else {
      const idx = createdSites.findIndex((s) => s.id === site.id);
      if (idx >= 0) {
        createdSites[idx] = {
          ...createdSites[idx],
          detail: {
            ...(createdSites[idx].detail || {}),
            naverAccountId,
            naverIdManual: true,
          },
        };
      }
    }
    closeManualNaverIdModal();
    renderCreatedSites();
  } catch (e) {
    alert(e.message || String(e));
  }
}

async function setManualNaverId(id) {
  if (!id) return;
  const site = createdSites.find((s) => s.id === id);
  if (!site) return alert('사이트를 찾을 수 없습니다.');
  openManualNaverIdModal(site);
}

async function retrySiteNaverIndex(id) {
  if (!id) return;
  const site = createdSites.find((s) => s.id === id);
  if (!site) return alert('사이트를 찾을 수 없습니다.');
  if (site.provider !== 'netlify') return alert('Netlify 사이트만 가능합니다.');
  if (!(config.naverAccounts || []).some((a) => a?.id && a?.pw)) {
    return alert('네이버 계정이 없습니다.\n설정 탭에 네이버 아이디/비밀번호를 등록하세요.');
  }
  if (!confirm(`${site.name}\n서치어드바이저에서 사이트 검색 → 소유확인 → 인덱싱을 다시 진행할까요?\n(Netlify 재배포 없음)`)) {
    return;
  }

  setSitesIndexProgress(`색인재시도 중: ${site.url || site.name}`, true);
  try {
    await window.electronAPI.saveConfig(collectConfig());
    const out = await window.electronAPI.kkangRetryNaverIndex({
      siteId: site.id,
      siteSlug: site.name,
      siteUrl: site.url,
      siteDir: site.detail?.output || '',
      naverAccountId: site.detail?.naverAccountId || '',
    });
    if (out?.createdSites) createdSites = out.createdSites;
    else await loadCreatedSites(false);
    renderCreatedSites();

    if (out?.ok) {
      setSitesIndexProgress(`✔ 색인재시도 완료: ${site.url}`, true);
      const acct = out.naver?.naverAccountId || site.detail?.naverAccountId || '';
      alert(`색인재시도 완료\n${site.url}${acct ? `\n계정: ${acct}` : ''}`);
    } else {
      setSitesIndexProgress('', false);
      alert(out?.error || '색인재시도 실패');
    }
  } catch (e) {
    setSitesIndexProgress('', false);
    alert(e.message || String(e));
  }
}

async function retrySiteNaver(id) {
  if (!id) return;
  const site = createdSites.find((s) => s.id === id);
  if (!site) return alert('사이트를 찾을 수 없습니다.');
  if (site.provider !== 'netlify') return alert('Netlify 사이트만 네이버 인증 재시도가 가능합니다.');

  const tokenFromSeo = ($('seoNetlifyToken')?.value || '').trim();
  const hasToken = tokenFromSeo || (config.netlifyTokens || []).some((t) => t && t.token);
  if (!hasToken) {
    return alert('Netlify 토큰이 없습니다.\n설정 탭에 토큰을 추가·저장한 뒤 다시 시도하세요.');
  }
  if (!(config.naverAccounts || []).some((a) => a?.id && a?.pw)) {
    return alert('네이버 계정이 없습니다.\n설정 탭에 네이버 아이디/비밀번호를 등록하세요.');
  }

  if (isSiteNaverDone(site)) {
    if (!confirm(`${site.name}\n이미 네이버 등록이 완료된 사이트입니다.\n다시 실행할까요?`)) return;
  } else if (!confirm(`${site.name}\n네이버 HTML 인증을 추출해 head에 넣고 Netlify에 재배포할까요?`)) {
    return;
  }

  setSitesIndexProgress(`네이버 인증 재시도 중: ${site.url || site.name}`, true);
  try {
    await window.electronAPI.saveConfig(collectConfig());
    const out = await window.electronAPI.kkangRetryNaver({
      siteId: site.id,
      siteSlug: site.name,
      siteUrl: site.url,
      siteDir: site.detail?.output || '',
      netlifyToken: tokenFromSeo,
      netlifyAccountId: ($('seoNetlifyId')?.value || config.kkangNetlifyId || '').trim(),
    });
    if (out?.createdSites) createdSites = out.createdSites;
    else await loadCreatedSites(false);
    renderCreatedSites();

    if (out?.ok) {
      setSitesIndexProgress(`✔ 네이버 인증·재배포 완료: ${site.url}`, true);
      const acct = out.naver?.naverAccountId || '';
      const title = out.title || '';
      alert(`네이버 등록 완료\n${site.url}${acct ? `\n계정: ${acct}` : ''}${title ? `\n타이틀: ${title}` : ''}`);
    } else {
      setSitesIndexProgress('', false);
      alert(out?.error || '네이버 인증 재시도 실패');
    }
  } catch (e) {
    setSitesIndexProgress('', false);
    alert(e.message || String(e));
  }
}

function crawlLog(line) {
  const w = $('crawlLog');
  if (!w) return;
  w.textContent += line + '\n';
  w.scrollTop = w.scrollHeight;
}

function getCrawlHomeUrls() {
  return parseLines($('crawlHomeUrls')?.value || '');
}

function normalizeCrawlUrlKey(url) {
  return (url || '').trim().replace(/\/$/, '').toLowerCase();
}

function syncCrawledUrlsFlat() {
  crawledUrls = crawlBatches.flatMap((b) => b.urls || []);
}

function findBatchForHome(homeUrl) {
  const key = normalizeCrawlUrlKey(homeUrl);
  return crawlBatches.find((b) => normalizeCrawlUrlKey(b.homeUrl) === key) || null;
}

function syncCrawlSiteStatusFromInput() {
  const homes = getCrawlHomeUrls();
  const prev = new Map(crawlSiteStatus.map((s) => [normalizeCrawlUrlKey(s.url), s]));
  crawlSiteStatus = homes.map((url) => {
    const old = prev.get(normalizeCrawlUrlKey(url));
    const batch = findBatchForHome(url);
    const urlCount = (batch?.urls || []).length;
    return old
      ? { ...old, url, urlCount }
      : { url, status: '대기', message: '', at: '', urlCount };
  });
}

function statusTagClass(status) {
  const s = (status || '').trim();
  if (s === '성공') return 'tag tag-ok';
  if (s === '실패' || s === '중단') return 'tag tag-fail';
  if (s === '진행중') return 'tag tag-run';
  return 'tag tag-wait';
}

function renderCrawlStatusTable() {
  const body = $('crawlStatusBody');
  const hint = $('crawlResultHint');
  if (!body) return;
  syncCrawlSiteStatusFromInput();
  const n = crawlSiteStatus.length;
  const okN = crawlSiteStatus.filter((s) => s.status === '성공').length;
  const runN = crawlSiteStatus.filter((s) => s.status === '진행중').length;
  const urlN = crawlSiteStatus.reduce((sum, s) => sum + (s.urlCount || 0), 0);
  if (hint) {
    hint.textContent = n
      ? `${n}개 사이트 · 하위 URL ${urlN}개 · 성공 ${okN}${runN ? ` · 진행 ${runN}` : ''}`
      : '0개 사이트';
  }
  if (!n) {
    body.innerHTML = '<tr><td colspan="5" class="empty-hint">사이트 주소를 입력하면 목록이 표시됩니다.</td></tr>';
  } else {
    body.innerHTML = crawlSiteStatus.map((s, i) => `
      <tr data-url="${escapeHtml(s.url)}">
        <td>${i + 1}</td>
        <td class="url-cell">
          <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.url)}</a>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">하위 URL ${s.urlCount || 0}개</div>
        </td>
        <td><span class="${statusTagClass(s.status)}">${escapeHtml(s.status || '대기')}</span></td>
        <td>${escapeHtml(s.message || '')}</td>
        <td>${escapeHtml(s.at || '-')}</td>
      </tr>
    `).join('');
  }
  const collectBtn = $('submitNaverCollectBtn');
  if (collectBtn) collectBtn.disabled = !n || crawlJobState === 'running';
  const startBtn = $('startCrawlBtn');
  if (startBtn) startBtn.disabled = crawlJobState === 'running';
}

function setCrawlJobControls({ running = false, canRestart = false } = {}) {
  crawlJobState = running ? 'running' : (canRestart ? 'stopped' : 'idle');
  const stopBtn = $('stopCrawlBtn');
  const restartBtn = $('restartCrawlBtn');
  const startBtn = $('startCrawlBtn');
  const collectBtn = $('submitNaverCollectBtn');
  if (stopBtn) stopBtn.disabled = !running;
  if (restartBtn) restartBtn.disabled = !canRestart || running;
  if (startBtn) startBtn.disabled = running;
  if (collectBtn) {
    const n = crawlSiteStatus.length;
    collectBtn.disabled = running || !n;
  }
}

async function stopCrawlJob() {
  if (crawlJobState !== 'running') return;
  crawlLog('⏹ 정지 요청…');
  const stopBtn = $('stopCrawlBtn');
  if (stopBtn) stopBtn.disabled = true;
  try {
    await window.electronAPI.stopCrawl();
  } catch (e) {
    crawlLog(`⚠ 정지 요청 실패: ${e.message}`);
  }
}

async function restartCrawlJob() {
  if (crawlJobState === 'running') return;
  if (!crawlLastJob) return alert('재시작할 작업이 없습니다.');
  setCrawlJobControls({ running: false, canRestart: false });
  if (crawlLastJob === 'collect') await submitNaverCollect();
  else await startUrlCrawl();
}

function renderCrawlUrls() {
  const out = $('crawlUrlOutput');
  syncCrawledUrlsFlat();
  if (out) {
    const lines = [];
    for (const b of crawlBatches) {
      lines.push(`# ${b.homeUrl}`);
      lines.push(...(b.urls || []));
      lines.push('');
    }
    out.value = lines.join('\n').trim();
  }
  const has = crawledUrls.length > 0;
  if ($('copyCrawlUrlsBtn')) $('copyCrawlUrlsBtn').disabled = !has;
  if ($('clearCrawlUrlsBtn')) $('clearCrawlUrlsBtn').disabled = !has;
  renderCrawlStatusTable();
}

function findCrawlStatus(url) {
  const key = normalizeCrawlUrlKey(url);
  return crawlSiteStatus.find((s) => {
    const k = normalizeCrawlUrlKey(s.url);
    return k === key || (key && k && (key.includes(k) || k.includes(key)));
  }) || null;
}

function nowCrawlAt() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onNaverCollectProgress(data) {
  if (!data?.siteUrl) return;
  const item = findCrawlStatus(data.siteUrl);
  if (!item) return;
  if (data.phase === 'start') {
    item.status = '진행중';
    const pc = data.pageCount ? ` · URL ${data.pageCount}개` : '';
    item.message = `수집 중… (${data.index}/${data.total}${pc})`;
    item.at = nowCrawlAt();
    crawlLog(`[네이버] ▶ 진행 (${data.index}/${data.total}) ${data.siteUrl}${pc}`);
  } else if (data.phase === 'done') {
    item.status = data.ok ? '성공' : '실패';
    item.message = data.message || '';
    item.at = nowCrawlAt();
    crawlLog(`[네이버] ✓ ${item.status} (${data.index}/${data.total}) ${data.siteUrl} | ${item.message}`);
  }
  renderCrawlStatusTable();
  window.electronAPI.saveConfig(collectConfig()).catch(() => {});
}

function resetCrawlStatus() {
  for (const s of crawlSiteStatus) {
    s.status = '대기';
    s.message = '';
    s.at = '';
  }
  renderCrawlStatusTable();
  crawlLog('상태 초기화 완료 (모두 대기)');
}

async function startUrlCrawl() {
  const homes = getCrawlHomeUrls();
  if (!homes.length) return alert('사이트 홈 주소를 한 줄에 하나씩 입력하세요.');
  if (crawlJobState === 'running') return;

  const btn = $('startCrawlBtn');
  const prev = btn?.textContent || '';
  crawlLastJob = 'crawl';
  urlCrawlRunning = true;
  setCrawlJobControls({ running: true, canRestart: false });
  if (btn) btn.textContent = '⏳ 수집 중...';
  crawlBatches = [];
  renderCrawlUrls();

  await window.electronAPI.saveConfig(collectConfig());

  let stopped = false;
  for (let i = 0; i < homes.length; i++) {
    const homeUrl = homes[i];
    crawlLog(`═══ [${i + 1}/${homes.length}] 내부 URL 수집: ${homeUrl} ═══`);
    if (btn) btn.textContent = `⏳ 수집 중... (${i + 1}/${homes.length})`;

    const out = await window.electronAPI.crawlSiteUrls({
      homeUrl,
      maxPages: 200,
      maxDepth: 5,
      resetStop: i === 0,
    });

    if (out.stopped) {
      stopped = true;
      crawlLog(`⏹ 정지됨 — ${homeUrl}`);
      break;
    }

    if (out.error) {
      crawlLog(`❌ ${homeUrl}: ${out.error}`);
      crawlBatches.push({ homeUrl, urls: [] });
    } else {
      const urls = out.urls || [];
      crawlBatches.push({ homeUrl, urls });
      crawlLog(`✨ ${homeUrl}: ${urls.length}개 URL`);
    }
    renderCrawlUrls();
  }

  urlCrawlRunning = false;
  if (btn) btn.textContent = prev;
  if (stopped) {
    setCrawlJobControls({ running: false, canRestart: true });
    crawlLog(`⏹ 하위 URL 수집 정지 — ${crawlBatches.length}개 사이트 · ${crawledUrls.length}개 URL`);
  } else {
    setCrawlJobControls({ running: false, canRestart: false });
    crawlLog(`✅ 내부 URL 수집 완료 — ${crawlBatches.length}개 사이트 · ${crawledUrls.length}개 URL`);
  }
}

async function copyCrawlUrls() {
  if (!crawledUrls.length) return;
  const ok = await copyToClipboard(crawledUrls.join('\n'));
  if (ok) crawlLog('📋 클립보드에 복사됨');
}

function clearCrawlUrls() {
  crawlBatches = [];
  crawledUrls = [];
  renderCrawlUrls();
}

async function ensureCrawlBatchesForHomes(homes) {
  const need = [];
  for (const homeUrl of homes) {
    const batch = findBatchForHome(homeUrl);
    if (!batch || !(batch.urls || []).length) need.push(homeUrl);
  }
  if (!need.length) return { stopped: false };

  crawlLog(`[네이버] 하위 URL 미수집 ${need.length}건 → 자동 수집 후 진행`);
  for (let i = 0; i < need.length; i++) {
    const homeUrl = need[i];
    crawlLog(`═══ 자동 URL 수집 [${i + 1}/${need.length}] ${homeUrl} ═══`);
    const out = await window.electronAPI.crawlSiteUrls({
      homeUrl,
      maxPages: 200,
      maxDepth: 5,
      resetStop: i === 0,
    });
    if (out.stopped) {
      crawlLog(`⏹ 자동 URL 수집 정지`);
      return { stopped: true };
    }
    // 기존 배치 교체/추가
    crawlBatches = crawlBatches.filter((b) => normalizeCrawlUrlKey(b.homeUrl) !== normalizeCrawlUrlKey(homeUrl));
    if (out.error) {
      crawlLog(`❌ ${homeUrl}: ${out.error} → 홈 URL만 신청`);
      crawlBatches.push({ homeUrl, urls: [homeUrl] });
    } else {
      const urls = out.urls || [];
      crawlBatches.push({ homeUrl, urls: urls.length ? urls : [homeUrl] });
      crawlLog(`✨ ${homeUrl}: ${(urls.length || 1)}개 URL`);
    }
    renderCrawlUrls();
  }
  return { stopped: false };
}

async function submitNaverCollect() {
  syncCrawlSiteStatusFromInput();
  const all = [...crawlSiteStatus];
  if (!all.length) return alert('사이트 홈 주소를 한 줄에 하나씩 입력하세요.');
  if (crawlJobState === 'running') return;

  const pending = all.filter((s) => (s.status || '').trim() !== '성공');
  const skipped = all.length - pending.length;
  if (skipped) crawlLog(`[네이버] 이미 수집 성공 ${skipped}건 건너뜀`);
  if (!pending.length) {
    return alert('목록의 수집 상태가 모두 성공입니다.\n다시 실행하려면 「상태 초기화」를 누르세요.');
  }

  const doFast = !!$('crawlOptFast')?.checked;
  const doRobots = !!$('crawlOptRobots')?.checked;
  const doSitemap = !!$('crawlOptSitemap')?.checked;
  const doWebpage = !!$('crawlOptWebpage')?.checked;
  if (!(doFast || doRobots || doSitemap || doWebpage)) {
    return alert('수집 옵션을 하나 이상 선택하세요.\n(수집주기 빠르게 / robots.txt / 사이트맵 / 웹페이지 수집)');
  }

  const crawlNaverId = ($('crawlNaverId')?.value || '').trim();
  const crawlNaverPw = ($('crawlNaverPw')?.value || '').trim();
  const useAutoLogin = !!(crawlNaverId && crawlNaverPw);
  if ((crawlNaverId && !crawlNaverPw) || (!crawlNaverId && crawlNaverPw)) {
    return alert('네이버 아이디와 비밀번호를 모두 입력하거나, 둘 다 비워 두고 수동 로그인하세요.');
  }

  const btn = $('submitNaverCollectBtn');
  const prev = btn?.textContent || '';
  crawlLastJob = 'collect';
  naverCollectRunning = true;
  setCrawlJobControls({ running: true, canRestart: false });
  if (btn) btn.textContent = '⏳ 준비 중...';

  let stopped = false;
  try {
    await window.electronAPI.saveConfig(collectConfig());
    const pre = await ensureCrawlBatchesForHomes(pending.map((s) => s.url));
    if (pre.stopped) {
      stopped = true;
      crawlLog('⏹ 웹페이지 수집 정지 (URL 준비 단계)');
      return;
    }
    syncCrawlSiteStatusFromInput();

    const sites = pending.map((s) => {
      const batch = findBatchForHome(s.url);
      const urls = (batch?.urls || []).length ? batch.urls : [s.url];
      return { homeUrl: s.url, urls };
    });
    const totalUrls = sites.reduce((n, s) => n + (s.urls || []).length, 0);

    const opts = [];
    if (doFast) opts.push('빠르게');
    if (doRobots) opts.push('robots');
    if (doSitemap) opts.push('사이트맵');
    if (doWebpage) opts.push('웹수집');
    const headlessOn = !!$('headlessMode')?.checked;
    crawlLog(`📡 웹페이지 수집 일괄 실행 — 사이트 ${sites.length}개 · URL ${totalUrls}개 · ${opts.join(', ')} · ${headlessOn ? '헤드리스' : '창 모드'}`);
    if (btn) btn.textContent = '⏳ 수집 진행 중...';

    const out = await window.electronAPI.submitNaverCollect({
      sites,
      naverAccount: useAutoLogin ? { id: crawlNaverId, pw: crawlNaverPw } : null,
      doFast,
      doRobots,
      doSitemap,
      doWebpage,
    });

    for (const s of crawlSiteStatus) {
      if ((s.status || '').trim() === '진행중') {
        s.status = out.stopped ? '정지' : '중단';
        s.message = (out.error || (out.stopped ? '사용자가 정지했습니다.' : '작업 중단')).slice(0, 120);
        s.at = nowCrawlAt();
      }
    }
    renderCrawlStatusTable();
    await window.electronAPI.saveConfig(collectConfig());

    if (out.stopped) {
      stopped = true;
      crawlLog(`⏹ ${out.error || '사용자가 정지했습니다.'}`);
      return;
    }

    if (out.error) {
      crawlLog(`❌ ${out.error}`);
      alert(out.error);
      return;
    }

    const okCount = out.okCount ?? (out.sites || []).filter((s) => s.ok).length;
    const total = (out.sites || []).length || sites.length;
    const pagesOk = out.totals?.pagesOk ?? 0;
    const pagesFail = out.totals?.pagesFail ?? 0;
    crawlLog(`✅ 웹페이지 수집 완료 — 사이트 ${okCount}/${total} · 페이지 ${pagesOk}성공/${pagesFail}실패`);
    alert(`웹페이지 수집 완료\n사이트 ${okCount}/${total}\n하위 페이지 ${pagesOk}성공 / ${pagesFail}실패`);
  } finally {
    naverCollectRunning = false;
    if (btn) btn.textContent = prev;
    setCrawlJobControls({ running: false, canRestart: stopped });
    renderCrawlStatusTable();
  }
}

function setRunControls({ active = false, paused = false } = {}) {
  $('startBtn').disabled = active;
  $('startBtn').textContent = active ? '⏳ 실행 중...' : '▶ 전체 실행 시작';
  $('pauseRunBtn').disabled = !active || paused;
  $('resumeRunBtn').disabled = !active || !paused;
  $('stopRunBtn').disabled = !active;
}

async function startRun() {
  const cfg = collectConfig();
  if (!cfg.netlifyTokens.length) return alert('Netlify 토큰을 하나 이상 입력하세요.');
  if (!cfg.naverAccounts.length) return alert('네이버 계정을 하나 이상 입력하세요.');

  const sourceMode = hasDeploySources(cfg);
  if (!sourceMode) {
    if (!cfg.services.length) return alert('등록할 키워드를 하나 이상 입력하세요.');
    if (!cfg.seoOptions.metaTitles.length || !cfg.seoOptions.metaDescriptions.length || !cfg.seoOptions.metaKeywords.length) {
      return alert('메타 타이틀, 디스크립션, 키워드를 각각 최소 1개 이상 입력하세요.');
    }
  } else if (!cfg.services.length) {
    logLine(`📦 ZIP/폴더 소스 ${cfg.deploySources.length}개 배포 모드 (SEO·서비스 생략)`);
  }

  setRunControls({ active: true });
  $('logWindow').textContent = '';

  await window.electronAPI.saveConfig(cfg);
  const result = await window.electronAPI.startRun(cfg);

  setRunControls({ active: false });
  if (result.error) {
    logLine(`❌ 오류: ${result.error}`);
  } else if (result.stopped) {
    logLine('⏹ 배포가 정지되었습니다. (완료된 항목까지 저장됨)');
    const newResults = result.results || [];
    if (newResults.length) {
      savedResults = [...savedResults, ...newResults];
      renderResultsTable(savedResults);
      switchTab('results');
    }
  } else {
    logLine('✨ 실행 완료');
    const newResults = result.results || [];
    savedResults = [...savedResults, ...newResults];
    renderResultsTable(savedResults);
    switchTab('results');
  }
}

async function pauseRun() {
  await window.electronAPI.pauseRun();
  setRunControls({ active: true, paused: true });
}

async function resumeRun() {
  await window.electronAPI.resumeRun();
  setRunControls({ active: true, paused: false });
}

async function stopRun() {
  if (!confirm('배포를 정지하시겠습니까? 완료된 항목까지만 저장됩니다.')) return;
  $('stopRunBtn').disabled = true;
  logLine('⏹ 정지 요청... 현재 단계가 끝나면 중단합니다.');
  await window.electronAPI.stopRun();
}

async function loadSavedResults() {
  savedResults = await window.electronAPI.loadResults();
  renderResultsTable(savedResults);
}

function parseGenAccountsFromBulk() {
  const ids = parseLines($('bulkGenNaverIds')?.value || '');
  const pws = parseLines($('bulkGenNaverPws')?.value || '');
  const max = Math.max(ids.length, pws.length);
  const accounts = [];
  for (let i = 0; i < max; i += 1) {
    if (!ids[i] && !pws[i]) continue;
    const naverId = ids[i] || '';
    accounts.push({
      id: naverId,
      naverId,
      naverPw: pws[i] || '',
      email: '',
      netlifyPassword: '',
    });
  }
  return accounts;
}

function syncBulkGenTextareasFromConfig() {
  const accs = config.netlifyGenAccounts || [];
  if (!$('bulkGenNaverIds')) return;
  $('bulkGenNaverIds').value = accs.map((a) => a.naverId || a.id || '').join('\n');
  $('bulkGenNaverPws').value = accs.map((a) => a.naverPw || '').join('\n');
}

async function saveGeneratedTokensToDisk() {
  await window.electronAPI.saveGeneratedTokens(generatedTokens);
}

function upsertGeneratedToken(entry) {
  if (!entry?.token) return;
  const displayId = entry.naverId || entry.id || '';
  const exists = generatedTokens.some((t) => t.token === entry.token);
  if (exists) return;
  generatedTokens.push({
    token: entry.token,
    id: displayId,
    naverId: displayId,
    email: entry.email || '',
    createdAt: new Date().toISOString(),
    used: false,
    usedCount: 0,
  });
  saveGeneratedTokensToDisk();
  renderGeneratedTokens();
}

function mergeGeneratedTokens(list) {
  for (const t of list || []) upsertGeneratedToken(t);
}

function removeGeneratedToken(i) {
  generatedTokens.splice(i, 1);
  saveGeneratedTokensToDisk();
  renderGeneratedTokens();
}

function renderNetlifyGenAccounts() {
  const el = $('netlifyGenAccounts');
  if (!el) return;
  const accounts = parseGenAccountsFromBulk();
  const ids = parseLines($('bulkGenNaverIds')?.value || '');
  const pws = parseLines($('bulkGenNaverPws')?.value || '');
  const mismatch = ids.length > 0 && pws.length > 0 && ids.length !== pws.length;

  if (!accounts.length) {
    el.innerHTML = '<p class="empty-hint">위에 네이버 아이디·비밀번호를 한 줄에 하나씩 입력하세요.</p>';
    return;
  }

  el.innerHTML = `
    ${mismatch ? '<p class="bulk-hint" style="color:var(--warning);margin-bottom:8px;">⚠ 아이디와 비밀번호 줄 수가 다릅니다. 순서대로 짝지어집니다.</p>' : ''}
    <div class="gen-account-list">
      ${accounts.map((acc, i) => `
        <div class="gen-account-row ${activeGenAccountIdx === i ? 'active' : ''} ${activeGenAccountIdx === i && tokenGenWaitingLogin ? 'waiting' : ''}" data-idx="${i}">
          <span class="gen-account-num">${i + 1}</span>
          <span class="gen-account-id" title="${escapeHtml(acc.naverId || '')}">${escapeHtml(acc.naverId || '(아이디 없음)')}</span>
          <span class="gen-account-pw" title="비밀번호 입력됨">${acc.naverPw ? escapeHtml(acc.naverPw) : '<span style="color:var(--danger)">비밀번호 없음</span>'}</span>
          ${activeGenAccountIdx === i ? '<span class="gen-account-status">▶ 진행 중</span>' : ''}
          ${activeGenAccountIdx === i && tokenGenWaitingLogin ? '<span class="gen-account-status" style="color:var(--warning)">⏳ 로그인 대기</span>' : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function getTokenGenMode() {
  return $('tokenGenModeLogin')?.checked ? 'login' : 'signup';
}

function updateTokenGenButtonLabel() {
  const btn = $('startTokenGenBtn');
  if (!btn) return;
  btn.textContent = getTokenGenMode() === 'signup'
    ? '▶ 회원가입 · 인증 · 토큰 생성'
    : '▶ 로그인 · 토큰 생성';
}

function renderGeneratedTokens() {
  const el = $('generatedTokensList');
  if (!generatedTokens.length) {
    el.innerHTML = '<p class="empty-hint">아직 생성된 토큰이 없습니다.</p>';
    $('applyGenTokensBtn').disabled = true;
    return;
  }
  $('applyGenTokensBtn').disabled = false;
  el.innerHTML = generatedTokens.map((t, i) => {
    const displayId = t.naverId || t.id || `토큰 ${i + 1}`;
    const when = t.createdAt ? `<span style="font-size:11px;color:var(--text-dim);margin-left:8px;">${formatDate(t.createdAt)}</span>` : '';
    return `
    <div class="item expanded" data-idx="${i}">
      <div class="item-header">
        <span class="item-title">${escapeHtml(displayId)}${when}</span>
        <button type="button" class="btn btn-danger btn-sm" data-action="remove-gen-token" data-idx="${i}">삭제</button>
      </div>
      <div class="item-body" style="display:block;">
        <div class="form-group"><label>토큰</label><input type="text" class="token-plain" readonly value="${escapeHtml(t.token)}"></div>
      </div>
    </div>`;
  }).join('');
}

function tokenGenLog(line) {
  const w = $('tokenGenLog');
  w.textContent += line + '\n';
  w.scrollTop = w.scrollHeight;
}

let netlifyRecording = false;

async function startRecordNetlify() {
  const mode = getTokenGenMode();
  const cfg = collectConfig();
  const btn = $('recordNetlifyBtn');

  if (netlifyRecording) {
    btn.disabled = true;
    const out = await window.electronAPI.recordNetlifyFlowStop();
    btn.disabled = false;
    netlifyRecording = false;
    btn.textContent = '📼 Netlify 동작 기록 (학습)';

    if (out.error) {
      tokenGenLog(`❌ ${out.error}`);
      alert(out.error);
      return;
    }
    tokenGenLog(`📼 기록 저장: ${out.recordPath}`);
    tokenGenLog(`   이벤트 ${out.eventCount}개 — 이제 「토큰 생성」을 실행하세요.`);
    alert(`동작 기록 완료 (${out.eventCount}개 이벤트)\n\n다음 토큰 생성 시 이 패턴을 재생합니다.`);
    return;
  }

  if (!confirm('Chrome이 열립니다. 직접 가입/로그인하면 클릭·입력이 기록됩니다.\n완료 후 [기록 완료] 버튼을 다시 누르세요.\n\n시작할까요?')) return;

  btn.disabled = true;
  $('tokenGenLog').textContent = '';

  const out = await window.electronAPI.recordNetlifyFlowStart({
    mode,
    outputRoot: cfg.outputRoot || './output',
  });

  btn.disabled = false;

  if (out.error) {
    tokenGenLog(`❌ ${out.error}`);
    alert(out.error);
    return;
  }

  netlifyRecording = true;
  btn.textContent = '✅ 기록 완료 (클릭하여 저장)';
  tokenGenLog(`📼 기록 시작 — Chrome에서 ${mode === 'login' ? '로그인' : '가입'}을 직접 완료하세요.`);
  tokenGenLog(`   저장 경로: ${out.recordPath}`);
}

function setTokenGenRunning(running) {
  tokenGenRunning = running;
  $('startTokenGenBtn').disabled = running;
  $('stopTokenGenBtn').disabled = !running;
  if (!running) {
    tokenGenWaitingLogin = false;
    activeGenAccountIdx = -1;
    renderNetlifyGenAccounts();
  }
}

async function stopTokenGen() {
  if (!tokenGenRunning) return;
  $('stopTokenGenBtn').disabled = true;
  tokenGenLog('⏹ 정지 요청... 현재 단계가 끝나면 중단합니다.');
  await window.electronAPI.stopTokenGen();
}

async function startTokenGen() {
  const mode = getTokenGenMode();
  const accounts = parseGenAccountsFromBulk()
    .map(a => ({
      id: (a.naverId || a.id || '').trim(),
      naverId: (a.naverId || a.id || '').trim(),
      naverPw: (a.naverPw || '').trim(),
      email: (a.email || '').trim(),
      netlifyPassword: '',
      password: (a.naverPw || '').trim(),
    }))
    .filter(a => a.naverId || a.email);

  if (!accounts.length) return alert('네이버 아이디(또는 메일)를 하나 이상 입력하세요.');

  const cfg = collectConfig();
  if (mode === 'signup') {
    const invalid = accounts.find(a => !a.naverId || !a.naverPw);
    if (invalid) return alert('회원가입 모드: 모든 계정에 네이버 아이디·비밀번호가 필요합니다.');
    if (!cfg.openaiApiKey) {
      return alert('회원가입 모드: 네이버 캡챠 자동 해결을 위해 설정 탭의 OpenAI API Key를 입력하세요.');
    }
  }

  const descriptionPrefix = $('tokenGenDesc').value.trim() || 'landing-auto-deploy';

  const prevLabel = $('startTokenGenBtn').textContent;
  $('startTokenGenBtn').textContent = '⏳ 진행 중...';
  $('tokenGenLog').textContent = '';
  tokenGenWaitingLogin = false;
  setTokenGenRunning(true);

  await window.electronAPI.saveConfig(cfg);

  const out = await window.electronAPI.generateTokens({
    accounts,
    descriptionPrefix,
    mode,
    openaiApiKey: cfg.openaiApiKey,
    outputRoot: cfg.outputRoot || './output',
  });

  setTokenGenRunning(false);
  $('startTokenGenBtn').textContent = prevLabel;
  updateTokenGenButtonLabel();

  if (out.error) {
    tokenGenLog(`❌ ${out.error}`);
    alert(out.error);
    return;
  }

  if (out.stopped) {
    mergeGeneratedTokens(out.tokens);
    tokenGenLog(`⏹ 정지됨 — 누적 ${generatedTokens.length}개 토큰 저장됨`);
    return;
  }

  mergeGeneratedTokens(out.tokens);
  tokenGenLog(`✨ 이번 실행 ${(out.tokens || []).length}개 생성 · 누적 ${generatedTokens.length}개 저장됨`);
}

async function applyGenTokens() {
  if (!generatedTokens.length) return;
  for (const t of generatedTokens) {
    const exists = config.netlifyTokens.some(x => (typeof x === 'string' ? x : x.token) === t.token);
    if (!exists) {
      config.netlifyTokens.push({
        token: t.token,
        id: t.naverId || t.id || '',
        used: false,
        usedCount: 0,
        expanded: false,
      });
    }
  }
  renderNetlifyTokens();
  const cfg = collectConfig();
  await window.electronAPI.saveConfig(cfg);
  alert(`${generatedTokens.length}개 토큰을 설정 탭 목록에 추가했습니다.`);
  switchTab('config');
}

async function load() {
  config = await window.electronAPI.loadConfig();
  config.netlifyTokens = (config.netlifyTokens || []).map(t =>
    typeof t === 'string'
      ? { token: t, id: '', used: false, usedCount: 0, expanded: false }
      : { ...t, used: !!t.used, usedCount: t.usedCount || 0, expanded: false }
  );
  config.naverAccounts = (config.naverAccounts || []).map(a => ({ ...a, expanded: false }));
  config.netlifyGenAccounts = (config.netlifyGenAccounts || []).map(a => {
    const naverId = a.naverId || (a.email && !a.email.includes('@') ? a.email : '') || a.id || '';
    return {
      id: naverId,
      naverId,
      naverPw: a.naverPw || a.password || '',
      email: a.email?.includes('@') ? a.email : '',
      netlifyPassword: a.netlifyPassword || '',
    };
  });
  config.services = config.services || [];

  generatedTokens = await window.electronAPI.loadGeneratedTokens();
  generatedTokens = (generatedTokens || []).map((t) => ({
    ...t,
    id: t.naverId || t.id || '',
    naverId: t.naverId || t.id || '',
  }));

  $('openaiApiKey').value = config.openaiApiKey || '';
  if ($('yesCaptchaClientKey')) $('yesCaptchaClientKey').value = config.yesCaptchaClientKey || '';
  if ($('crawlNaverId')) $('crawlNaverId').value = config.urlCrawlNaver?.id || '';
  if ($('crawlNaverPw')) $('crawlNaverPw').value = config.urlCrawlNaver?.pw || '';
  if ($('crawlHomeUrls')) {
    const homes = Array.isArray(config.urlCrawlHomes) ? config.urlCrawlHomes : [];
    $('crawlHomeUrls').value = homes.join('\n');
  }
  const savedSites = Array.isArray(config.urlCrawlSites) ? config.urlCrawlSites : [];
  crawlSiteStatus = savedSites.map((s) => ({
    url: s.url || '',
    status: s.status || '대기',
    message: s.message || '',
    at: s.at || s.registeredAt || '',
  })).filter((s) => s.url);
  const opts = config.urlCrawlOpts || {};
  if ($('crawlOptFast')) $('crawlOptFast').checked = opts.fast !== false;
  if ($('crawlOptRobots')) $('crawlOptRobots').checked = opts.robots !== false;
  if ($('crawlOptSitemap')) $('crawlOptSitemap').checked = opts.sitemap !== false;
  if ($('crawlOptWebpage')) $('crawlOptWebpage').checked = opts.webpage !== false;
  syncBulkGenTextareasFromConfig();
  $('metaTitles').value = (config.seoOptions?.metaTitles || []).join('\n');
  $('metaDescriptions').value = (config.seoOptions?.metaDescriptions || []).join('\n');
  $('metaKeywords').value = (config.seoOptions?.metaKeywords || []).join('\n');
  $('generateSitemap').checked = config.seoOptions?.generateSitemap !== false;
  $('generateRobots').checked = config.seoOptions?.generateRobots !== false;
  syncHeadlessUi(!!config.headless);
  if ($('metaInjectOnly')) $('metaInjectOnly').checked = !!config.metaInjectOnly;

  if ($('seoCursorKey')) $('seoCursorKey').value = config.cursorApiKey || '';
  if ($('seoBuilderPath')) $('seoBuilderPath').value = config.kkangBuilderPath || '';
  if ($('seoFastAi')) $('seoFastAi').checked = config.kkangFastAi !== false;
  if ($('seoOutputDir')) $('seoOutputDir').value = config.kkangOutputDir || '';
  if ($('seoNetlifyToken')) $('seoNetlifyToken').value = config.kkangNetlifyToken || '';
  if ($('seoNetlifyId')) $('seoNetlifyId').value = config.kkangNetlifyId || '';
  randomSeoSlug(false);
  updateSeoPreviewUrl();
  if (config.netlifyCreditsLast) {
    renderNetlifyCreditBadge({
      ok: config.netlifyCreditsLast.credits != null,
      status: 'saved',
      credits: config.netlifyCreditsLast.credits,
      creditsText: config.netlifyCreditsLast.creditsText,
      teamSlug: config.netlifyCreditsLast.teamSlug || config.netlifyCreditsTeam || '',
    });
  }

  const cf = config.cloudflare || {};
  if ($('cfAccountId')) $('cfAccountId').value = cf.accountId || '';
  if ($('cfApiToken')) $('cfApiToken').value = cf.apiToken || '';
  if ($('cfBrand')) $('cfBrand').value = cf.brand || '';
  if ($('cfPhone')) $('cfPhone').value = cf.phone || '';
  if ($('cfNaver')) $('cfNaver').value = cf.naver || '';
  if ($('cfOutputDir')) $('cfOutputDir').value = cf.outputDir || '';
  if ($('cfKeywords')) $('cfKeywords').value = cf.keywords || '';
  if ($('cfNotes')) $('cfNotes').value = cf.notes || '';
  if ($('cfDeploy')) $('cfDeploy').checked = cf.deploy !== false;
  if ($('cfCreateProject')) $('cfCreateProject').checked = cf.createProject !== false;
  if (cf.projectName && $('cfProjectName')) $('cfProjectName').value = cf.projectName;
  else randomCfSlug(false);
  updateCfPreviewUrl();

  const dh = config.dothome || {};
  if ($('dhEmailLocal')) $('dhEmailLocal').value = dh.emailLocal || '';
  if ($('dhFixedPw')) $('dhFixedPw').value = 'dlwkdrns12435!';
  if ($('dhHostId')) $('dhHostId').value = dh.hostId || '';
  if ($('dhKeyword')) $('dhKeyword').value = dh.keyword || '';
  if ($('dhExternalUrl')) $('dhExternalUrl').value = dh.externalUrl || '';
  if ($('dhPhone')) $('dhPhone').value = dh.phone || '010-6338-7124';
  if ($('dhImageDir')) $('dhImageDir').value = dh.imageDir || '';
  if ($('dhGoogleVerifyFile')) $('dhGoogleVerifyFile').value = dh.googleVerifyFile || '';
  if ($('dhFtpHost')) {
    const h = dh.ftpHost || '';
    $('dhFtpHost').value = h === 'ftp.dothome.co.kr' ? '' : h;
  }
  updateDhPreviewUrl();
  renderDhAccounts();

  renderNetlifyTokens();
  renderNaverAccounts();
  renderServices();
  renderNetlifyGenAccounts();
  renderGeneratedTokens();
  renderCrawlUrls();
  updateTokenGenButtonLabel();
  await restoreDeployFolder(config.deployFolder, config.deploySources);
  await loadSavedResults();
  await loadCreatedSites(true);
  setupEvents();
}

function setupEvents() {
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('addBulkTokensBtn').addEventListener('click', addBulkTokens);
  $('addAccountBtn').addEventListener('click', addNaverAccount);
  $('addServiceBtn').addEventListener('click', addService);
  $('selectFolderBtn').addEventListener('click', selectDeployFolder);
  $('startBtn').addEventListener('click', startRun);
  $('pauseRunBtn').addEventListener('click', pauseRun);
  $('resumeRunBtn').addEventListener('click', resumeRun);
  $('stopRunBtn').addEventListener('click', stopRun);
  $('headlessMode')?.addEventListener('change', async () => {
    syncHeadlessUi($('headlessMode').checked);
    await window.electronAPI.saveConfig(collectConfig());
  });
  for (const id of ['headlessToggleBtn', 'crawlHeadlessToggleBtn', 'dhHeadlessToggleBtn']) {
    $(id)?.addEventListener('click', async () => {
      syncHeadlessUi(!$('headlessMode')?.checked);
      await window.electronAPI.saveConfig(collectConfig());
    });
  }
  $('metaInjectOnly')?.addEventListener('change', async () => {
    await window.electronAPI.saveConfig(collectConfig());
  });
  $('clearLogBtn').addEventListener('click', () => { $('logWindow').textContent = ''; });
  $('resultsSearch').addEventListener('input', filterResults);
  $('clearAllResultsBtn').addEventListener('click', clearAllResults);
  $('checkIndexBtn').addEventListener('click', () => runIndexCheck());

  // 생성 사이트 통합
  $('sitesSearch')?.addEventListener('input', filterCreatedSites);
  $('sitesCopyUrlsBtn')?.addEventListener('click', copyCreatedSiteUrls);
  $('sitesCheckIndexBtn')?.addEventListener('click', () => runSitesIndexCheck());
  $('sitesSyncBtn')?.addEventListener('click', () => loadCreatedSites(true));
  $('sitesClearBtn')?.addEventListener('click', clearCreatedSites);
  $('sitesFilters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sites-filter]');
    if (!btn) return;
    sitesFilter = btn.dataset.sitesFilter || 'all';
    $('sitesFilters').querySelectorAll('.chip').forEach((el) => {
      el.classList.toggle('active', el.dataset.sitesFilter === sitesFilter);
    });
    renderCreatedSites();
  });
  $('sitesList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sites-action]');
    if (!btn) return;
    const action = btn.dataset.sitesAction;
    if (action === 'copy') {
      let url = '';
      try {
        url = btn.dataset.urlEnc ? decodeURIComponent(btn.dataset.urlEnc) : (btn.dataset.url || '');
      } catch {
        url = btn.dataset.url || '';
      }
      await copyToClipboard(url, '📋 URL 복사됨', { sitesTab: true });
    } else if (action === 'delete') {
      await deleteCreatedSite(btn.dataset.id);
    } else if (action === 'check-index') {
      await checkSiteIndexOne(btn.dataset.id);
    } else if (action === 'retry-naver') {
      await retrySiteNaver(btn.dataset.id);
    } else if (action === 'retry-naver-index') {
      await retrySiteNaverIndex(btn.dataset.id);
    } else if (action === 'set-naver-id') {
      await setManualNaverId(btn.dataset.id);
    }
  });
  $('manualNaverIdModal')?.addEventListener('click', (e) => {
    if (e.target?.closest?.('[data-manual-naver-close]')) closeManualNaverIdModal();
  });
  $('manualNaverIdSaveBtn')?.addEventListener('click', () => saveManualNaverIdFromModal());
  $('manualNaverIdInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveManualNaverIdFromModal();
    } else if (e.key === 'Escape') {
      closeManualNaverIdModal();
    }
  });
  $('startTokenGenBtn').addEventListener('click', startTokenGen);
  $('stopTokenGenBtn').addEventListener('click', stopTokenGen);
  $('startCrawlBtn')?.addEventListener('click', startUrlCrawl);
  $('submitNaverCollectBtn')?.addEventListener('click', submitNaverCollect);
  $('stopCrawlBtn')?.addEventListener('click', stopCrawlJob);
  $('restartCrawlBtn')?.addEventListener('click', restartCrawlJob);
  $('resetCrawlStatusBtn')?.addEventListener('click', resetCrawlStatus);
  $('crawlHomeUrls')?.addEventListener('input', () => {
    renderCrawlStatusTable();
  });
  $('copyCrawlUrlsBtn')?.addEventListener('click', copyCrawlUrls);
  $('clearCrawlUrlsBtn')?.addEventListener('click', clearCrawlUrls);
  $('clearCrawlLogBtn')?.addEventListener('click', () => { if ($('crawlLog')) $('crawlLog').textContent = ''; });
  for (const id of ['crawlOptFast', 'crawlOptRobots', 'crawlOptSitemap', 'crawlOptWebpage']) {
    $(id)?.addEventListener('change', async () => {
      await window.electronAPI.saveConfig(collectConfig());
    });
  }

  // 넷리파이 생성
  $('seoNetlifyLoginBtn')?.addEventListener('click', startNetlifyCreditsLogin);
  $('seoNetlifyLoginBtn2')?.addEventListener('click', startNetlifyCreditsLogin);
  $('naverLoginBtn')?.addEventListener('click', (e) => startNaverLogin(e));
  $('naverSiteCountRefreshBtn')?.addEventListener('click', refreshNaverSiteCount);
  $('seoNetlifyCreditRefreshBtn')?.addEventListener('click', refreshNetlifyCreditsUi);
  $('seoRandomSlugBtn')?.addEventListener('click', () => randomSeoSlug(true));
  $('seoSiteSlug')?.addEventListener('input', updateSeoPreviewUrl);
  $('seoBrowseOutBtn')?.addEventListener('click', browseSeoOutputDir);
  $('seoBrowseBuilderBtn')?.addEventListener('click', browseSeoBuilderPath);
  // Netlify 토큰·아이디 자동 저장
  const persistSeoNetlifyCreds = async () => {
    try {
      config = { ...config, ...collectConfig() };
      await window.electronAPI.saveConfig(config);
    } catch { /* ignore */ }
  };
  $('seoNetlifyToken')?.addEventListener('change', persistSeoNetlifyCreds);
  $('seoNetlifyToken')?.addEventListener('blur', persistSeoNetlifyCreds);
  $('seoNetlifyId')?.addEventListener('change', persistSeoNetlifyCreds);
  $('seoNetlifyId')?.addEventListener('blur', persistSeoNetlifyCreds);
  $('seoSelectAllBtn')?.addEventListener('click', () => seoSelectVisible(true));
  $('seoClearKwBtn')?.addEventListener('click', () => seoSelectVisible(false));
  $('seoRandomKwBtn')?.addEventListener('click', seoRandomSelect);
  $('seoReloadKwBtn')?.addEventListener('click', () => loadSeoKeywords(true));
  $('seoDeleteKwBtn')?.addEventListener('click', deleteSelectedSeoKeywords);
  $('seoKwSearch')?.addEventListener('input', renderSeoKeywords);
  $('seoAddKwBtn')?.addEventListener('click', addSeoKeywords);
  $('seoGenerateBtn')?.addEventListener('click', startSeoGenerate);
  $('seoStopBtn')?.addEventListener('click', stopSeoGenerate);
  $('seoClearLogBtn')?.addEventListener('click', () => { if ($('seoLog')) $('seoLog').textContent = ''; });

  // Cloudflare Pages 생성 (기본 틀)
  $('cfRandomSlugBtn')?.addEventListener('click', () => randomCfSlug(true));
  $('cfProjectName')?.addEventListener('input', updateCfPreviewUrl);
  $('cfBrowseOutBtn')?.addEventListener('click', browseCfOutputDir);
  $('cfGenerateBtn')?.addEventListener('click', startCfGenerate);
  $('cfStopBtn')?.addEventListener('click', stopCfGenerate);
  $('cfClearLogBtn')?.addEventListener('click', () => { if ($('cfLog')) $('cfLog').textContent = ''; });

  // 닷홈 호스팅 생성
  $('dhHostId')?.addEventListener('input', updateDhPreviewUrl);
  $('dhBrowseImageBtn')?.addEventListener('click', browseDhImageDir);
  $('dhBrowseGoogleBtn')?.addEventListener('click', browseDhGoogleFile);
  $('dhGenerateBtn')?.addEventListener('click', startDhGenerate);
  $('dhFullPipelineBtn')?.addEventListener('click', startDhFullPipeline);
  $('dhStopBtn')?.addEventListener('click', stopDhGenerate);
  $('vpnHotkeyTestBtn')?.addEventListener('click', testVpnHotkey);
  $('dhClearLogBtn')?.addEventListener('click', () => { if ($('dhLog')) $('dhLog').textContent = ''; });
  $('dhAccountsList')?.addEventListener('click', (e) => {
    if (dhBusy) return;
    const genBtn = e.target?.closest?.('[data-dh-seo-gen]');
    if (genBtn) {
      startDhSeoGenerate(genBtn.getAttribute('data-dh-seo-gen') || '');
      return;
    }
    const depBtn = e.target?.closest?.('[data-dh-deploy]');
    if (depBtn) {
      startDhDeploy(depBtn.getAttribute('data-dh-deploy') || '', true);
    }
  });

  $('copySelectedUrlsBtn')?.addEventListener('click', copySelectedResultUrls);
  $('copyAllResultUrlsBtn')?.addEventListener('click', copyAllResultUrls);
  $('recordNetlifyBtn')?.addEventListener('click', startRecordNetlify);
  $('applyGenTokensBtn').addEventListener('click', applyGenTokens);
  $('clearTokenGenLogBtn').addEventListener('click', () => { $('tokenGenLog').textContent = ''; });
  $('tokenGenModeSignup')?.addEventListener('change', updateTokenGenButtonLabel);
  $('tokenGenModeLogin')?.addEventListener('change', updateTokenGenButtonLabel);
  $('showEmptyAccounts').addEventListener('change', renderNaverAccounts);

  for (const id of ['bulkGenNaverIds', 'bulkGenNaverPws']) {
    $(id)?.addEventListener('input', () => {
      config.netlifyGenAccounts = parseGenAccountsFromBulk();
      renderNetlifyGenAccounts();
    });
  }

  $('generatedTokensList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.dataset.action !== 'remove-gen-token') return;
    const idx = parseInt(t.dataset.idx, 10);
    if (!Number.isNaN(idx)) removeGeneratedToken(idx);
  });

  $('netlifyTokens').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const idx = parseInt(t.dataset.idx, 10);
    if (Number.isNaN(idx)) return;
    if (t.dataset.action === 'remove-token') { e.stopPropagation(); removeNetlifyToken(idx); }
    else if (t.dataset.action === 'toggle-token') { e.stopPropagation(); toggleToken(idx); }
  });
  $('netlifyTokens').addEventListener('change', (e) => {
    const t = e.target;
    if (t.tagName !== 'INPUT') return;
    const idx = parseInt(t.dataset.idx, 10);
    const field = t.dataset.field;
    if (Number.isNaN(idx) || !field) return;
    updateNetlifyToken(idx, field, t.type === 'checkbox' ? t.checked : t.value);
  });

  $('naverAccounts').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const idx = parseInt(t.dataset.idx, 10);
    if (Number.isNaN(idx)) return;
    if (t.dataset.action === 'remove-account') { e.stopPropagation(); removeNaverAccount(idx); }
    else if (t.dataset.action === 'toggle-account') { e.stopPropagation(); toggleAccount(idx); }
  });
  $('naverAccounts').addEventListener('change', (e) => {
    const t = e.target;
    if (t.tagName !== 'INPUT') return;
    const idx = parseInt(t.dataset.idx, 10);
    const field = t.dataset.field;
    if (Number.isNaN(idx) || !field) return;
    updateNaverAccount(idx, field, t.value);
  });

  $('services').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.dataset.action !== 'remove-service') return;
    removeService(parseInt(t.dataset.idx, 10));
  });
  $('services').addEventListener('change', (e) => {
    const t = e.target;
    if (!t.dataset.idx) return;
    updateService(parseInt(t.dataset.idx, 10), t.dataset.field, t.value);
  });

  $('resultsList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    if (t.dataset.action === 'copy-url') {
      e.preventDefault();
      const url = t.dataset.url || '';
      copyToClipboard(url, '📋 URL 복사됨');
      return;
    }
    const idx = parseInt(t.dataset.idx, 10);
    if (t.dataset.action === 'delete-result') deleteResult(idx);
    else if (t.dataset.action === 'mark-manual') markManualCaptcha(idx);
    else if (t.dataset.action === 'check-index-one') checkIndexOne(idx, { force: true });
    else if (t.dataset.action === 'reinject-index') reinjectIndexOne(idx);
  });
}

window.electronAPI.onReinjectLog((line) => {
  setIndexProgress(line, true);
});

window.electronAPI.onIndexProgress((p) => {
  if (p.phase === 'checking') {
    setIndexProgress(`인덱싱 확인 ${p.current}/${p.total}: ${p.url}`);
  }
});

window.electronAPI.onIndexUpdated((p) => {
  if (p.index != null && savedResults[p.index]) {
    savedResults[p.index] = p.result;
    filterResults();
  }
});

window.electronAPI.onSitesIndexProgress((p) => {
  if (p.phase === 'checking') {
    setSitesIndexProgress(`인덱싱 확인 ${p.current}/${p.total}: ${p.url}`);
  }
});

window.electronAPI.onSitesIndexUpdated((p) => {
  if (p.index != null && createdSites[p.index]) {
    createdSites[p.index] = p.result;
    renderCreatedSites();
  }
});

async function logLine(line) {
  const w = $('logWindow');
  w.textContent += line + '\n';
  w.scrollTop = w.scrollHeight;

  if (line.includes('[RUN_PAUSED]')) setRunControls({ active: true, paused: true });
  if (line.includes('[RUN_RESUMED]')) setRunControls({ active: true, paused: false });

  const usedMatch = line.match(/\[TOKEN_USED\]\s*(\d+)/);
  if (usedMatch) {
    const idx = parseInt(usedMatch[1], 10);
    if (config.netlifyTokens[idx]) {
      config.netlifyTokens[idx].used = true;
      renderNetlifyTokens();
      await window.electronAPI.saveConfig(collectConfig());
    }
  }

  const countMatch = line.match(/\[TOKEN_COUNT\]\s*(\d+)\s+(\d+)/);
  if (countMatch) {
    const idx = parseInt(countMatch[1], 10);
    const count = parseInt(countMatch[2], 10);
    if (config.netlifyTokens[idx]) {
      config.netlifyTokens[idx].usedCount = count;
      renderNetlifyTokens();
      await window.electronAPI.saveConfig(collectConfig());
    }
  }
}

function seoLog(line) {
  const w = $('seoLog');
  if (!w) return;
  w.textContent += line + '\n';
  w.scrollTop = w.scrollHeight;
}

function updateSeoPreviewUrl() {
  const slug = sanitizeSeoSlug($('seoSiteSlug')?.value || '');
  const el = $('seoPreviewUrl');
  if (el) el.textContent = `https://${slug || 'keyword-ab123'}.netlify.app`;
}

function sanitizeSeoSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || '';
}

function randomSeoLetters(len = 2) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function randomSeoDigits(len = 3) {
  let out = '';
  for (let i = 0; i < len; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

/** 이미 쓴 Netlify 사이트명 (생성 사이트 + 배치 중) */
const seoBatchUsedSlugs = new Set();

function collectUsedSeoSlugs() {
  const used = new Set(seoBatchUsedSlugs);
  for (const s of createdSites || []) {
    const url = String(s.url || s.domain || '');
    const m = url.match(/https?:\/\/([a-z0-9-]+)\.netlify\.app/i);
    if (m?.[1]) used.add(m[1].toLowerCase());
    const name = sanitizeSeoSlug(s.name || s.siteSlug || s.site_slug || '');
    if (name) used.add(name);
  }
  return used;
}

/** 선택된(또는 인자로 받은) 키워드 슬러그에서 Netlify 사이트명 prefix 추출 (짧게) */
function pickSeoSlugPrefix(preferredItems) {
  const pool = (preferredItems && preferredItems.length)
    ? preferredItems
    : seoKeywords.filter((k) => seoSelected.has(k.kw));
  if (!pool.length) return '';
  const item = pool[Math.floor(Math.random() * pool.length)];
  let base = sanitizeSeoSlug(item.slug || '');
  if (!base) {
    const folder = String(item.folder || item.cat || '').toLowerCase();
    const folderMap = {
      kkang: 'kkang', cash: 'cash', mobile: 'mobile', gift: 'gift',
      loan: 'loan', card: 'card', fee: 'fee', other: 'site',
    };
    base = folderMap[folder] || 'site';
  }
  // 짧게: 최대 14자 (예: mobile-cash-out → mobile-cash-ou)
  if (base.length > 14) base = base.slice(0, 14).replace(/-$/, '');
  return base || 'site';
}

/**
 * 사이트명: {키워드슬러그}-{영문2자}{숫자3자}
 * 예: mobile-cash-xk847
 */
function randomSeoSlug(logIt = true, preferredItems) {
  const prefix = pickSeoSlugPrefix(preferredItems) || 'site';
  const used = collectUsedSeoSlugs();
  let slug = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    slug = `${prefix}-${randomSeoLetters(2)}${randomSeoDigits(3)}`;
    if (!used.has(slug)) break;
  }
  seoBatchUsedSlugs.add(slug);
  const el = $('seoSiteSlug');
  if (el) {
    el.readOnly = false;
    el.disabled = false;
    el.value = slug;
  }
  updateSeoPreviewUrl();
  if (logIt) seoLog(`사이트명 랜덤: ${slug}`);
  return slug;
}

function unlockSeoInputs() {
  for (const id of ['seoSiteSlug', 'seoBrand', 'seoPhone', 'seoNaver']) {
    const el = $(id);
    if (!el) continue;
    el.readOnly = false;
    el.disabled = false;
  }
}

async function browseSeoOutputDir() {
  const dir = await window.electronAPI.selectFolder();
  if (dir && $('seoOutputDir')) $('seoOutputDir').value = dir;
}

async function browseSeoBuilderPath() {
  const dir = await window.electronAPI.selectFolder();
  if (dir && $('seoBuilderPath')) $('seoBuilderPath').value = dir;
  await pingSeoEngine();
}

function setSeoBusy(busy) {
  seoBusy = busy;
  if ($('seoGenerateBtn')) $('seoGenerateBtn').disabled = busy;
  if ($('seoStopBtn')) $('seoStopBtn').disabled = !busy;
  // 생성 중에도 사이트명·업체명은 수정 가능해야 함 (입력 잠금 방지)
  unlockSeoInputs();
}

function visibleSeoKeywords() {
  const q = ($('seoKwSearch')?.value || '').trim().toLowerCase();
  return seoKeywords.filter((item) => {
    if (seoFolder !== 'all' && item.folder !== seoFolder) return false;
    if (!q) return true;
    return item.kw.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q);
  });
}

function updateSeoKwHint() {
  const hint = $('seoKwHint');
  if (hint) hint.textContent = `선택 ${seoSelected.size}개 · 목록 ${seoKeywords.length}개`;
}

function renderSeoFolderTabs() {
  const wrap = $('seoFolderTabs');
  if (!wrap) return;
  const folders = seoFolders.length
    ? seoFolders
    : [
        { label: '전체', key: 'all' },
        { label: '카드깡', key: 'kkang' },
        { label: '현금화', key: 'cash' },
        { label: '소액결제', key: 'mobile' },
        { label: '상품권', key: 'gift' },
        { label: '대출·한도', key: 'loan' },
        { label: '기타', key: 'other' },
      ];
  wrap.innerHTML = folders.map(({ label, key }) => {
    const count = seoCounts[key] ?? (key === 'all' ? seoKeywords.length : 0);
    const active = seoFolder === key ? ' active' : '';
    return `<button type="button" class="seo-folder-tab${active}" data-folder="${escapeHtml(key)}">${escapeHtml(label)} <span>${count}</span></button>`;
  }).join('');
  wrap.querySelectorAll('.seo-folder-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      seoFolder = btn.dataset.folder || 'all';
      renderSeoFolderTabs();
      renderSeoKeywords();
    });
  });
}

function renderSeoKeywords() {
  const list = $('seoKwList');
  if (!list) return;
  const items = visibleSeoKeywords();
  if (!items.length) {
    list.innerHTML = '<p class="empty-hint">표시할 키워드가 없습니다.</p>';
    updateSeoKwHint();
    return;
  }
  list.innerHTML = items.map((item) => {
    const checked = seoSelected.has(item.kw) ? ' checked' : '';
    const custom = item.custom ? ' <span class="seo-kw-custom">추가</span>' : '';
    const delBtn = item.custom
      ? `<button type="button" class="btn btn-ghost btn-sm seo-kw-del" data-del-kw="${escapeHtml(item.kw)}" title="삭제">×</button>`
      : '';
    return `<label class="seo-kw-item"><input type="checkbox" data-kw="${escapeHtml(item.kw)}"${checked}><span>${escapeHtml(item.kw)} <code>/${escapeHtml(item.slug)}/</code>${custom}</span>${delBtn}</label>`;
  }).join('');
  list.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.addEventListener('change', () => {
      const kw = el.dataset.kw;
      if (el.checked) seoSelected.add(kw);
      else seoSelected.delete(kw);
      updateSeoKwHint();
    });
  });
  list.querySelectorAll('[data-del-kw]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSeoKeywords([btn.dataset.delKw]);
    });
  });
  updateSeoKwHint();
}

function seoSelectVisible(on) {
  for (const item of visibleSeoKeywords()) {
    if (on) seoSelected.add(item.kw);
    else seoSelected.delete(item.kw);
  }
  renderSeoKeywords();
}

function seoRandomSelect() {
  const n = parseInt($('seoTopicCount')?.value || '16', 10) || 16;
  const pool = visibleSeoKeywords();
  if (!pool.length) return alert('현재 탭에 선택할 키워드가 없습니다.');
  seoSelectVisible(false);
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(n, pool.length));
  for (const item of shuffled) seoSelected.add(item.kw);
  renderSeoKeywords();
  seoLog(`랜덤 선택: ${shuffled.length}개`);
  // 선택한 키워드 슬러그 기반으로 사이트명 자동 설정
  randomSeoSlug(true, shuffled);
  // 업체명이 비어 있거나 기본값이면 대표 키워드로 제안
  const brandEl = $('seoBrand');
  if (brandEl) {
    brandEl.readOnly = false;
    brandEl.disabled = false;
    const cur = (brandEl.value || '').trim();
    if (!cur || cur === '카드깡전문') {
      const primary = shuffled[0];
      if (primary?.kw) brandEl.value = primary.kw;
    }
  }
}

async function pingSeoEngine() {
  const hint = $('seoEngineHint');
  if (hint) hint.textContent = '엔진 연결 확인 중…';
  // Save path first
  await window.electronAPI.saveConfig(collectConfig());
  const out = await window.electronAPI.kkangPing();
  if (hint) {
    if (out?.ok) {
      const where = out.bundled ? '내장 엔진' : '사용자 경로';
      hint.textContent = `연결됨 (${where}) · AI ${out.ai_available ? '가능' : '키 필요'} · ${out.builderRoot || ''}`;
    } else {
      hint.textContent = `연결 실패: ${out?.error || 'Python 설치 또는 엔진 동기화(npm run sync:engine) 필요'}`;
    }
  }
  return out;
}

async function loadSeoKeywords(force = false) {
  if (seoKeywordsLoaded && !force) return;
  seoLog('키워드 목록 불러오는 중…');
  await window.electronAPI.saveConfig(collectConfig());
  const out = await window.electronAPI.kkangListKeywords();
  if (out?.error) {
    seoLog(`✖ ${out.error}`);
    if ($('seoEngineHint')) $('seoEngineHint').textContent = `연결 실패: ${out.error}`;
    return;
  }
  seoKeywords = out.keywords || [];
  seoFolders = out.folders || [];
  seoCounts = out.counts || {};
  seoKeywordsLoaded = true;
  // Keep existing selections that still exist
  const valid = new Set(seoKeywords.map((k) => k.kw));
  seoSelected = new Set([...seoSelected].filter((k) => valid.has(k)));
  renderSeoFolderTabs();
  renderSeoKeywords();
  seoLog(`키워드 ${seoKeywords.length}개 로드`);
  await pingSeoEngine();
}

async function addSeoKeywords() {
  const kws = parseLines($('seoBulkKw')?.value || '');
  const slugs = parseLines($('seoBulkSlug')?.value || '');
  if (!kws.length) return alert('키워드를 1개 이상 입력하세요.');
  const items = kws.map((kw, i) => ({ kw, slug: slugs[i] || '' }));
  const out = await window.electronAPI.kkangAddKeywords(items);
  if (out?.error) return alert(out.error);
  if ($('seoBulkKw')) $('seoBulkKw').value = '';
  if ($('seoBulkSlug')) $('seoBulkSlug').value = '';
  const added = out.added || [];
  for (const a of added) seoSelected.add(a.kw);
  seoLog(`키워드 ${added.length}개 추가`);
  await loadSeoKeywords(true);
}

async function deleteSeoKeywords(keywords) {
  const list = (keywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  if (!list.length) return;

  // 기본 키워드는 삭제 불가 — 추가(custom)만
  const customMap = new Map(seoKeywords.map((k) => [k.kw, !!k.custom]));
  const deletable = list.filter((kw) => customMap.get(kw));
  const builtin = list.filter((kw) => !customMap.get(kw));
  if (!deletable.length) {
    return alert('기본 키워드는 삭제할 수 없습니다.\n직접 추가한 [추가] 키워드만 삭제됩니다.');
  }
  const msg = builtin.length
    ? `[추가] 키워드 ${deletable.length}개를 삭제할까요?\n(기본 키워드 ${builtin.length}개는 제외)`
    : `[추가] 키워드 ${deletable.length}개를 삭제할까요?\n${deletable.slice(0, 8).join(', ')}${deletable.length > 8 ? ' …' : ''}`;
  if (!confirm(msg)) return;

  const out = await window.electronAPI.kkangRemoveKeywords(deletable);
  if (out?.error) return alert(out.error);
  const removed = out.removed || [];
  for (const kw of removed) seoSelected.delete(kw);
  seoLog(`키워드 ${removed.length}개 삭제${out.skipped?.length ? ` · 제외 ${out.skipped.length}` : ''}`);
  await loadSeoKeywords(true);
}

async function deleteSelectedSeoKeywords() {
  if (!seoSelected.size) return alert('삭제할 키워드를 먼저 선택하세요.');
  await deleteSeoKeywords([...seoSelected]);
}

async function startSeoGenerate() {
  if (seoBusy) return;
  const deployCount = Math.max(1, Math.min(50, parseInt($('seoDeployCount')?.value || '1', 10) || 1));
  const deploy = !!$('seoDeploy')?.checked;
  const naver = ($('seoNaver')?.value || '').trim();
  if (!naver && !deploy) {
    return alert('네이버 인증을 자동으로 넣으려면 「생성 후 Netlify 배포」를 켜거나, 인증 코드를 직접 입력하세요.');
  }
  if (!naver && !(config.naverAccounts || []).some((a) => a?.id && a?.pw)) {
    return alert('네이버 인증 자동 추출을 쓰려면 설정 탭에 네이버 계정을 등록하세요.\n(또는 인증 코드를 직접 입력)');
  }
  // 현재 태그(폴더)에 키워드가 있어야 랜덤 재선택 가능
  if (!visibleSeoKeywords().length) {
    return alert('현재 선택된 키워드 태그에 키워드가 없습니다.');
  }

  setSeoBusy(true);
  seoStopRequested = false;
  seoBatchUsedSlugs.clear();
  for (const s of collectUsedSeoSlugs()) seoBatchUsedSlugs.add(s);
  if ($('seoLog')) $('seoLog').textContent = '';
  await window.electronAPI.saveConfig(collectConfig());

  let okCount = 0;
  let failCount = 0;
  let lastDoneMsg = '';
  let lastOkDomain = '';

  try {
    for (let i = 0; i < deployCount; i++) {
      if (seoStopRequested) {
        seoLog(`⏹ 배치 중단 (${i}/${deployCount})`);
        break;
      }

      seoLog(`═══ 배포 ${i + 1}/${deployCount} ═══`);
      // 현재 태그 내에서 키워드·사이트명 랜덤 재선택
      seoRandomSelect();
      const slug = sanitizeSeoSlug($('seoSiteSlug')?.value || '') || randomSeoSlug(true);
      if (!slug) {
        seoLog('✖ 사이트명 생성 실패');
        failCount += 1;
        continue;
      }
      if (!seoSelected.size) {
        seoLog('✖ 키워드 선택 실패');
        failCount += 1;
        continue;
      }

      const job = {
        site_slug: slug,
        brand: ($('seoBrand')?.value || '').trim() || '카드깡전문',
        phone: ($('seoPhone')?.value || '').trim() || '010-6338-7124',
        naver_code: ($('seoNaver')?.value || '').trim(),
        google_code: ($('seoGoogle')?.value || '').trim(),
        topic_count: parseInt($('seoTopicCount')?.value || '16', 10) || 16,
        use_ai: !!$('seoUseAi')?.checked,
        fast_ai: !!$('seoFastAi')?.checked,
        cursor_api_key: ($('seoCursorKey')?.value || '').trim(),
        netlify_token: ($('seoNetlifyToken')?.value || '').trim(),
        netlify_account_id: ($('seoNetlifyId')?.value || '').trim(),
        deploy,
        create_site: !!$('seoCreateSite')?.checked,
        output_dir: ($('seoOutputDir')?.value || '').trim(),
        kkangBuilderPath: ($('seoBuilderPath')?.value || '').trim(),
        keywords: [...seoSelected],
      };

      try {
        const result = await window.electronAPI.kkangGenerate(job);
        if (seoStopRequested || result?.cancelled) {
          seoLog('⏹ 생성이 중지되었습니다.');
          break;
        }
        if (result?.ok) {
          okCount += 1;
          seoBatchUsedSlugs.add(slug);
          lastOkDomain = result.domain || `https://${slug}.netlify.app`;
          seoLog(`✔ 완료 (${okCount}/${deployCount}): ${result.pages || '?'}페이지 · ${result.domain || ''}`);
          const naverDone = !!(
            result.naverAuto?.metaContent
            || ['success', 'already', 'manual'].includes(String(result.naverAuto?.status || '').toLowerCase())
          );
          if (naverDone) {
            const acct = result.naverAuto?.naverAccountId || result.naverAccountId || '';
            seoLog(`✔ 네이버 등록 완료${acct ? ` · 계정 ${acct}` : ''}${result.title ? ` · ${result.title}` : ''}`);
          } else if (result.naverAutoError) {
            seoLog(`⚠ 네이버 인증 자동 삽입 실패: ${result.naverAutoError}`);
          }
          if ($('seoNaver') && (job.naver_code || naverDone)) $('seoNaver').value = '';
          if (result.results) savedResults = result.results;
          if (result.createdSites) createdSites = result.createdSites;
          else await loadCreatedSites(true);
          renderCreatedSites();
        } else {
          failCount += 1;
          seoLog(`✖ ${result?.error || '생성 실패'}`);
        }
      } catch (e) {
        failCount += 1;
        seoLog(`✖ ${e.message}`);
      }
    }

    if (okCount > 0) {
      lastDoneMsg = deployCount > 1
        ? `배치 완료\n성공 ${okCount}개 · 실패 ${failCount}개\n마지막: ${lastOkDomain}`
        : `완료\n${lastOkDomain}`;
    } else if (!seoStopRequested) {
      lastDoneMsg = failCount ? `생성 실패 (${failCount}건)` : '생성 실패';
    }
  } finally {
    setSeoBusy(false);
    unlockSeoInputs();
    try { await window.electronAPI.focusMainWindow?.(); } catch { /* ignore */ }
  }

  if (lastDoneMsg) {
    await new Promise((r) => setTimeout(r, 50));
    alert(lastDoneMsg);
  }
  if (okCount > 0) {
    // 다음 생성용 미리보기 사이트명
    randomSeoSlug(false);
  }
  unlockSeoInputs();
  try {
    await window.electronAPI.focusMainWindow?.();
    if (okCount > 0) {
      $('seoSiteSlug')?.focus();
      $('seoSiteSlug')?.select?.();
    }
  } catch { /* ignore */ }
}

async function stopSeoGenerate() {
  if (!seoBusy) return;
  seoStopRequested = true;
  seoLog('⏹ 정지 요청…');
  if ($('seoStopBtn')) $('seoStopBtn').disabled = true;
  await window.electronAPI.kkangStop();
}

/* ── Cloudflare Pages 생성 (기본 틀) ── */
let cfBusy = false;

function cfLog(line) {
  const w = $('cfLog');
  if (!w) return;
  w.textContent += line + '\n';
  w.scrollTop = w.scrollHeight;
}

function sanitizeCfSlug(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 58);
}

function updateCfPreviewUrl() {
  const slug = sanitizeCfSlug($('cfProjectName')?.value || '') || 'my-landing-xxxxxx';
  const el = $('cfPreviewUrl');
  if (el) el.textContent = `https://${slug}.pages.dev`;
}

function randomCfSlug(logIt = true) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `landing-${suffix}`;
  if ($('cfProjectName')) $('cfProjectName').value = name;
  updateCfPreviewUrl();
  if (logIt) cfLog(`프로젝트명 랜덤: ${name}`);
}

async function browseCfOutputDir() {
  const dir = await window.electronAPI.selectFolder?.();
  if (dir && $('cfOutputDir')) $('cfOutputDir').value = dir;
}

function setCfBusy(busy) {
  cfBusy = busy;
  if ($('cfGenerateBtn')) $('cfGenerateBtn').disabled = busy;
  if ($('cfStopBtn')) $('cfStopBtn').disabled = !busy;
}

async function startCfGenerate() {
  if (cfBusy) return;
  const project = sanitizeCfSlug($('cfProjectName')?.value || '');
  if (!project) return alert('프로젝트명을 입력하세요.');

  setCfBusy(true);
  if ($('cfLog')) $('cfLog').textContent = '';
  cfLog(`☁ Cloudflare Pages 생성 틀 실행 — ${project}`);
  cfLog('· 사이트 생성 / 디자인 / 배포 로직은 아직 연결되지 않았습니다.');
  cfLog('· 입력값·생성 사이트 목록에 등록하고, 이후 업데이트에서 실제 생성을 붙일 예정입니다.');

  try {
    await window.electronAPI.saveConfig(collectConfig());
    const saved = await window.electronAPI.cloudflareSaveSite({
      name: project,
      url: `https://${project}.pages.dev`,
      status: 'draft',
      accountId: ($('cfAccountId')?.value || '').trim(),
      brand: ($('cfBrand')?.value || '').trim(),
      phone: ($('cfPhone')?.value || '').trim(),
      notes: '기본 틀 저장 (실제 배포 전)',
      createdAt: new Date().toISOString(),
    });
    if (saved?.createdSites) createdSites = saved.createdSites;
    else await loadCreatedSites(true);
    renderCreatedSites();
    cfLog('✔ 설정 저장 완료 (Account / Token / 키워드 등)');
    cfLog(`✔ 생성 사이트 목록에 등록: https://${project}.pages.dev`);
    alert(`Cloudflare Pages 목록에 등록했습니다.\nhttps://${project}.pages.dev\n\n실제 사이트 생성·배포는 이후 업데이트됩니다.`);
  } catch (e) {
    cfLog(`✖ ${e.message}`);
    alert(e.message);
  } finally {
    setCfBusy(false);
  }
}

async function stopCfGenerate() {
  if (!cfBusy) return;
  cfLog('⏹ 정지 요청… (아직 실행 중인 작업 없음)');
  setCfBusy(false);
}

/* ── 닷홈 호스팅 회원가입 ── */
let dhBusy = false;
let dhStopRequested = false;

function dhLog(line) {
  const w = $('dhLog');
  if (!w) return;
  w.textContent += line + '\n';
  w.scrollTop = w.scrollHeight;
}

function updateDhPreviewUrl() {
  const id = ($('dhHostId')?.value || '').trim() || '(FTP아이디)';
  const el = $('dhPreviewUrl');
  if (el) el.textContent = `https://${id}.dothome.co.kr`;
}

function dhSiteUrlForAccount(a) {
  const ftpId = (a?.ftpId || '').trim();
  if (ftpId) return `https://${ftpId}.dothome.co.kr/`;
  return (a?.url || '').trim();
}

function dhSeoInputsOrAlert() {
  const keyword = ($('dhKeyword')?.value || '').trim();
  const imageDir = ($('dhImageDir')?.value || '').trim();
  const cursorApiKey = ($('seoCursorKey')?.value || config.cursorApiKey || '').trim();
  if (!keyword) {
    alert('핵심키워드를 입력하세요.');
    return null;
  }
  if (!imageDir) {
    alert('이미지 폴더(PNG/JPG 8장 이상)를 지정하세요.');
    return null;
  }
  if (!cursorApiKey) {
    alert('Cursor API Key가 필요합니다.\n넷리파이 생성 탭에 Cursor API Key를 입력한 뒤 설정을 저장하세요.');
    return null;
  }
  return {
    keyword,
    imageDir,
    externalUrl: ($('dhExternalUrl')?.value || '').trim(),
    phoneDisplay: ($('dhPhone')?.value || '010-6338-7124').trim() || '010-6338-7124',
    ftpHost: ($('dhFtpHost')?.value || '').trim(),
    googleVerifyFile: ($('dhGoogleVerifyFile')?.value || '').trim(),
    cursorApiKey,
  };
}

function renderDhAccounts() {
  const list = $('dhAccountsList');
  const hint = $('dhAccountsHint');
  const accounts = Array.isArray(config.dothome?.accounts) ? config.dothome.accounts : [];
  if (hint) hint.textContent = `${accounts.length}개 · 사이트 생성 / 생성 후 배포`;
  if (!list) return;
  if (!accounts.length) {
    list.innerHTML = '<p class="empty-hint">아직 생성된 계정이 없습니다.</p>';
    return;
  }
  list.innerHTML = [...accounts].reverse().map((a) => {
    const siteUrl = dhSiteUrlForAccount(a);
    const canDeploy = !!(a.ftpId && (a.ftpPw || a.pw || a.dbPw));
    const deployed = a.deployedAt
      ? `<div style="font-size:11px;color:#2e7d32;margin-top:4px;">배포됨 ${escapeHtml(a.deployedAt)}</div>`
      : '';
    const generated = a.generatedAt
      ? `<div style="font-size:11px;color:#1565c0;margin-top:4px;">생성됨 ${escapeHtml(a.generatedAt)}</div>`
      : '';
    return `
    <div class="item-card" style="padding:10px 12px;">
      <div style="font-weight:700;">${escapeHtml(a.id || '-')}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
        ${escapeHtml(a.email || '')}<br>
        ${escapeHtml(a.phone || '')} · ${escapeHtml(a.name || '')}<br>
        FTP: ${escapeHtml(a.ftpId || '-')} · CMS: ${escapeHtml(a.cms || 'none')}<br>
        <a href="${escapeHtml(siteUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(siteUrl || '')}</a>
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${escapeHtml(a.createdAt || '')}</div>
      ${generated}${deployed}
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
        <button type="button" class="btn btn-ghost btn-sm" data-dh-seo-gen="${escapeHtml(a.ftpId || '')}" ${canDeploy && !dhBusy ? '' : 'disabled'}>
          사이트 생성
        </button>
        <button type="button" class="btn btn-success btn-sm" data-dh-deploy="${escapeHtml(a.ftpId || '')}" ${canDeploy && !dhBusy ? '' : 'disabled'}>
          생성 후 배포
        </button>
        ${siteUrl ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener">열기</a>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function browseDhImageDir() {
  const dir = await window.electronAPI.selectFolder();
  if (dir && $('dhImageDir')) $('dhImageDir').value = dir;
}

async function browseDhGoogleFile() {
  const file = await window.electronAPI.selectFile([
    { name: 'Google 인증 HTML', extensions: ['html', 'htm'] },
    { name: 'All Files', extensions: ['*'] },
  ]);
  if (file && $('dhGoogleVerifyFile')) $('dhGoogleVerifyFile').value = file;
}

function setDhBusy(busy) {
  dhBusy = busy;
  if ($('dhGenerateBtn')) $('dhGenerateBtn').disabled = busy;
  if ($('dhFullPipelineBtn')) $('dhFullPipelineBtn').disabled = busy;
  if ($('dhStopBtn')) $('dhStopBtn').disabled = !busy;
  renderDhAccounts();
}

async function startDhSeoGenerate(ftpId) {
  if (dhBusy) return;
  const inputs = dhSeoInputsOrAlert();
  if (!inputs) return;
  const accounts = Array.isArray(config.dothome?.accounts) ? config.dothome.accounts : [];
  const account = accounts.find((a) => a?.ftpId === ftpId);
  if (!account?.ftpId) return alert('FTP 아이디가 있는 계정이 필요합니다.');

  setDhBusy(true);
  dhLog(`📄 정적 SEO 생성: ${account.ftpId} / ${inputs.keyword}`);
  try {
    await window.electronAPI.saveConfig(collectConfig());
    const out = await window.electronAPI.dothomeSeoGenerate({
      ftpId: account.ftpId,
      ...inputs,
    });
    const fresh = await window.electronAPI.loadConfig();
    if (fresh) config = fresh;
    renderDhAccounts();
    if (out?.ok) {
      dhLog(`✔ 생성 완료: ${out.siteDir || ''}`);
      if (out.createdSites) createdSites = out.createdSites;
      else await loadCreatedSites(true);
      renderCreatedSites();
      alert(`사이트 생성 완료\n${out.siteDir || ''}`);
    } else {
      dhLog(`✖ ${out?.error || '생성 실패'}`);
      alert(out?.error || '생성 실패');
    }
  } catch (e) {
    dhLog(`✖ ${e.message}`);
    alert(e.message);
  } finally {
    setDhBusy(false);
  }
}

async function startDhDeploy(ftpId, generate = true) {
  if (dhBusy) return;
  const inputs = dhSeoInputsOrAlert();
  if (!inputs) return;
  const accounts = Array.isArray(config.dothome?.accounts) ? config.dothome.accounts : [];
  const account = accounts.find((a) => a?.ftpId === ftpId);
  if (!account) return alert('계정을 찾을 수 없습니다.');
  if (!account.ftpId) return alert('FTP 아이디가 없습니다. 무료호스팅까지 완료된 계정인지 확인하세요.');

  setDhBusy(true);
  dhLog(`🚀 정적 사이트 ${generate ? '생성 후 배포' : '배포'}: ${account.ftpId}`);

  try {
    await window.electronAPI.saveConfig(collectConfig());
    const out = await window.electronAPI.dothomeDeploy({
      ftpId: account.ftpId,
      generate: !!generate,
      siteDir: account.siteDir || '',
      ...inputs,
    });

    const fresh = await window.electronAPI.loadConfig();
    if (fresh) config = fresh;
    renderDhAccounts();

    if (out?.ok) {
      dhLog(`✔ 배포 완료: ${out.siteUrl || ''}`);
      if (out.naver?.status) dhLog(`✔ 네이버 등록: ${out.naver.status}`);
      if (out.googleVerifyFile) dhLog(`✔ 구글 인증 파일: ${out.googleVerifyFile}`);
      if (out.createdSites) createdSites = out.createdSites;
      else await loadCreatedSites(true);
      renderCreatedSites();
      const naverLine = out.naver?.status ? `\n네이버: ${out.naver.status}` : '';
      alert(`배포 완료\n${out.siteUrl || ''}${naverLine}`);
    } else {
      dhLog(`✖ ${out?.error || '배포 실패'}`);
      alert(out?.error || '배포 실패');
    }
  } catch (e) {
    dhLog(`✖ ${e.message}`);
    alert(e.message);
  } finally {
    setDhBusy(false);
  }
}

async function startDhGenerate() {
  if (dhBusy) return;
  const emailLocal = ($('dhEmailLocal')?.value || '').trim().replace(/@.*$/, '');
  if (!emailLocal) return alert('네이버 이메일 아이디(앞부분)를 입력하세요.');
  if (!($('openaiApiKey')?.value || '').trim()) {
    return alert('설정 탭에 OpenAI API Key를 입력하세요. (보안문자 인식용)');
  }
  const yesKey = ($('yesCaptchaClientKey')?.value || '').trim();
  if (yesKey && /^sk-/i.test(yesKey)) {
    return alert('YesCaptcha Client Key 칸에 OpenAI 키(sk-…)가 들어가 있습니다.\n설정 탭에서 YesCaptcha 클라이언트 키로 바꿔 주세요.');
  }
  if (!yesKey) {
    if (!confirm('YesCaptcha 키가 없습니다. reCAPTCHA는 수동으로 풀어야 합니다. 계속할까요?')) return;
  }

  const count = Math.max(1, Math.min(30, parseInt($('dhSignupCount')?.value || '1', 10) || 1));
  setDhBusy(true);
  dhStopRequested = false;
  if ($('dhLog')) $('dhLog').textContent = '';
  dhLog(`🏠 닷홈 회원가입 시작… (${count}회)`);
  dhLog(`이메일: ${emailLocal}@naver.com`);

  let okCount = 0;
  try {
    for (let i = 0; i < count; i++) {
      if (dhStopRequested) {
        dhLog(`⏹ 중단 (${i}/${count})`);
        break;
      }
      dhLog(`═══ 가입 ${i + 1}/${count} ═══`);
      await window.electronAPI.saveConfig(collectConfig());
      const out = await window.electronAPI.dothomeSignup({
        emailLocal,
        headless: !!$('headlessMode')?.checked,
      });
      const fresh = await window.electronAPI.loadConfig();
      if (fresh) config = fresh;

      if (out?.account) {
        if ($('dhHostId')) $('dhHostId').value = out.account.id || '';
        updateDhPreviewUrl();
        renderDhAccounts();
        dhLog(`계정: ${out.account.id} / FTP ${out.account.ftpId || '-'}`);
        dhLog(`URL: ${out.account.url || ''}`);
        if (out.createdSites) createdSites = out.createdSites;
        else await loadCreatedSites(true);
        renderCreatedSites();
      }

      if (out?.ok) {
        okCount += 1;
        dhLog(`✔ 가입 ${i + 1} 완료`);
      } else {
        dhLog(`✖ ${out?.error || '가입 실패'}`);
        if (count === 1) alert(out?.error || '가입 실패');
      }
    }
    if (count > 1) alert(`회원가입 배치\n성공 ${okCount}/${count}`);
  } catch (e) {
    dhLog(`✖ ${e.message}`);
    alert(e.message);
  } finally {
    setDhBusy(false);
  }
}

/** 회원가입 → SEO 생성 → FTP·네이버 배포 연속 */
async function startDhFullPipeline() {
  if (dhBusy) return;
  const emailLocal = ($('dhEmailLocal')?.value || '').trim().replace(/@.*$/, '');
  if (!emailLocal) return alert('네이버 이메일 아이디(앞부분)를 입력하세요.');
  const inputs = dhSeoInputsOrAlert();
  if (!inputs) return;
  if (!($('openaiApiKey')?.value || '').trim()) {
    return alert('설정 탭에 OpenAI API Key를 입력하세요.');
  }
  if (!(config.naverAccounts || []).some((a) => a?.id && a?.pw)) {
    return alert('설정 탭에 네이버 계정을 등록하세요. (배포 시 색인용)');
  }

  const count = Math.max(1, Math.min(30, parseInt($('dhSignupCount')?.value || '1', 10) || 1));
  setDhBusy(true);
  dhStopRequested = false;
  if ($('dhLog')) $('dhLog').textContent = '';
  dhLog(`🚀 가입→생성→배포 시작 (${count}회)`);

  let okCount = 0;
  try {
    for (let i = 0; i < count; i++) {
      if (dhStopRequested) {
        dhLog(`⏹ 중단 (${i}/${count})`);
        break;
      }
      dhLog(`═══ 풀파이프라인 ${i + 1}/${count} ═══`);
      await window.electronAPI.saveConfig(collectConfig());
      const signup = await window.electronAPI.dothomeSignup({
        emailLocal,
        headless: !!$('headlessMode')?.checked,
      });
      let fresh = await window.electronAPI.loadConfig();
      if (fresh) config = fresh;
      renderDhAccounts();

      const ftpId = signup?.account?.ftpId;
      if (!signup?.ok || !ftpId) {
        dhLog(`✖ 가입 실패: ${signup?.error || 'FTP 없음'}`);
        continue;
      }
      dhLog(`✔ 가입 완료 · FTP ${ftpId}`);
      if ($('dhHostId')) $('dhHostId').value = signup.account.id || '';

      const out = await window.electronAPI.dothomeDeploy({
        ftpId,
        generate: true,
        ...inputs,
      });
      fresh = await window.electronAPI.loadConfig();
      if (fresh) config = fresh;
      renderDhAccounts();
      if (out?.createdSites) createdSites = out.createdSites;
      else await loadCreatedSites(true);
      renderCreatedSites();

      if (out?.ok) {
        okCount += 1;
        dhLog(`✔ 배포 완료: ${out.siteUrl || ftpId}`);
        await maybeSendVpnHotkey(okCount);
      } else {
        dhLog(`✖ 배포 실패: ${out?.error || ''}`);
      }
    }
    alert(`풀파이프라인 완료\n성공 ${okCount}/${count}`);
  } catch (e) {
    dhLog(`✖ ${e.message}`);
    alert(e.message);
  } finally {
    setDhBusy(false);
  }
}

async function stopDhGenerate() {
  if (!dhBusy) return;
  dhStopRequested = true;
  dhLog('⏹ 정지 요청…');
  await window.electronAPI.dothomeSignupStop();
}

function readVpnHotkeyFromUi() {
  const key = String($('vpnHotkeyKey')?.value || '').trim().toLowerCase().slice(0, 1);
  const mod = String($('vpnHotkeyMod')?.value || 'alt').toLowerCase();
  return {
    alt: mod === 'alt',
    ctrl: mod === 'ctrl',
    shift: mod === 'shift',
    key: key || '',
  };
}

function vpnEverySitesCount() {
  return Math.max(1, Math.min(50, parseInt($('vpnEverySites')?.value || '1', 10) || 1));
}

async function maybeSendVpnHotkey(okCount) {
  const every = vpnEverySitesCount();
  if (!okCount || okCount % every !== 0) return;
  const hk = readVpnHotkeyFromUi();
  if (!hk.key) {
    dhLog('⚠ VPN 단축키 키가 비어 있어 건너뜀');
    return;
  }
  const label = [hk.ctrl && 'Ctrl', hk.alt && 'Alt', hk.shift && 'Shift', hk.key.toUpperCase()].filter(Boolean).join('+');
  dhLog(`VPN 단축키 전송 (${okCount}개마다) · ${label}`);
  const out = await window.electronAPI.sendHotkey?.(hk);
  if (out && !out.ok) dhLog(`⚠ VPN 단축키 실패: ${out.error || ''}`);
  else dhLog('✔ VPN 단축키 전송 완료');
}

async function testVpnHotkey() {
  const hk = readVpnHotkeyFromUi();
  if (!hk.key) return alert('VPN 단축키 키를 입력하세요.');
  const label = [hk.ctrl && 'Ctrl', hk.alt && 'Alt', hk.shift && 'Shift', hk.key.toUpperCase()].filter(Boolean).join('+');
  dhLog(`VPN 단축키 테스트: ${label}`);
  const out = await window.electronAPI.sendHotkey?.(hk);
  if (out && !out.ok) alert(out.error || '단축키 전송 실패');
  else alert(`단축키를 보냈습니다 (${label}).\nVPN IP가 바뀌었는지 확인하세요.`);
}

window.electronAPI.onLogLine(logLine);
window.electronAPI.onTokenGenLog(tokenGenLog);
window.electronAPI.onCrawlUrlLog(crawlLog);
window.electronAPI.onNaverCollectProgress(onNaverCollectProgress);
window.electronAPI.onKkangLog(seoLog);
window.electronAPI.onNetlifyCreditsUpdate((data) => {
  renderNetlifyCreditBadge(data || {});
  if (data?.ok && data.credits != null) {
    config.netlifyCreditsTeam = data.teamSlug || config.netlifyCreditsTeam || '';
    config.netlifyCreditsLast = {
      credits: data.credits,
      creditsText: data.creditsText,
      teamSlug: data.teamSlug,
      at: data.at,
    };
  }
});
window.electronAPI.onNaverSessionUpdate?.((data) => {
  updateNaverSessionBadge(data || {});
});
window.electronAPI.naverSessionStatus?.().then((s) => {
  if (s) updateNaverSessionBadge(s);
}).catch(() => {});
window.electronAPI.getAppVersion?.().then((v) => {
  const el = $('appVersionTag');
  if (el && v) el.textContent = `v${v}`;
}).catch(() => {});
window.electronAPI.onDothomeLog(dhLog);
window.electronAPI.onTokenGenProgress((data) => {
  if (data.status === 'processing') {
    activeGenAccountIdx = data.index;
    tokenGenWaitingLogin = false;
    renderNetlifyGenAccounts();
    return;
  }
  if (data.status === 'waiting_login') {
    activeGenAccountIdx = data.index;
    tokenGenWaitingLogin = true;
    renderNetlifyGenAccounts();
    return;
  }
  if (data.status === 'token_created' && data.token) {
    upsertGeneratedToken({
      token: data.token,
      naverId: data.naverId || data.label || '',
      id: data.naverId || data.label || '',
    });
    return;
  }
  if (data.status === 'done') {
    tokenGenWaitingLogin = false;
    activeGenAccountIdx = -1;
    renderNetlifyGenAccounts();
  }
});
load();
