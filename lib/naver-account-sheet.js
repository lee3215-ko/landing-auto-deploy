/**
 * 네이버 계정 시트 (공개 CSV).
 * A 카카오 아이디, B 네이버 아이디, C 네이버 비밀번호, D 이름, H 컴퓨터 이름.
 * I열(네이버 서치어드바이저)이 비어 있는 행만 자동 등록 대상이다.
 * 카카오 메일 비밀번호는 계정 공통.
 */
import https from 'https';

export const NAVER_ACCOUNT_SHEET_ID = '1xQnL0kc1dJm9jeAL78O5D-IUBXPZE9_qwI3kIVH6Wm0';
export const NAVER_ACCOUNT_SHEET_GID = '680347381';
export const KAKAO_MAIL_PASSWORD = 'zhfldk123!';

const COL = { kakaoId: 0, naverId: 1, naverPw: 2, name: 3, programId: 7, advisor: 8 };

function fetchText(url) {
  const bust = `${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url + bust, {
      headers: {
        'User-Agent': 'landing-auto-deploy',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`시트 응답 ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('시트 요청 시간 초과'));
    });
  });
}

function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function sheetCsvUrl(extra = '') {
  const base = `https://docs.google.com/spreadsheets/d/${NAVER_ACCOUNT_SHEET_ID}`;
  return `${base}${extra}`;
}

/** 빈 행까지 포함한 시트 전체. 행 번호는 이 순서가 맞다. */
async function loadExportRows() {
  const text = await fetchText(sheetCsvUrl(`/export?format=csv&gid=${NAVER_ACCOUNT_SHEET_GID}`));
  if (!text || text.trim().startsWith('<')) {
    throw new Error('시트를 읽지 못했습니다. 공유 설정을 확인해 주세요.');
  }
  return parseCsv(text);
}

function quoteSheetValue(value) {
  return String(value || '').replace(/'/g, "''");
}

/**
 * 로그인 직전에 호출한다. B열이 아이디인 행의 C열을 그 자리에서 읽는다.
 * 처음에 받아 둔 비밀번호는 쓰지 않는다.
 */
export async function fetchAccountByNaverId(naverId) {
  const id = String(naverId || '').trim();
  if (!id) return null;
  const tq = encodeURIComponent(`select B,C,D where B='${quoteSheetValue(id)}'`);
  const queried = await fetchText(sheetCsvUrl(
    `/gviz/tq?tqx=out:csv&gid=${NAVER_ACCOUNT_SHEET_GID}&headers=0&tq=${tq}`,
  ));
  const hit = parseCsv(queried).find((cols) => String(cols[0] || '').trim() === id);
  if (!hit) return null;
  const pw = String(hit[1] || '').trim();
  if (!pw) return null;
  let sheetRow = 0;
  try {
    const rows = await loadExportRows();
    const index = rows.findIndex((cols) => String(cols[COL.naverId] || '').trim() === id);
    if (index >= 0) sheetRow = index + 1;
  } catch { /* 행 번호는 비밀번호 입력에 필요 없다 */ }
  return {
    id,
    pw,
    name: String(hit[2] || '').trim(),
    sheetRow,
  };
}

/** 로그인 칸에 넣기 직전, 계정 객체의 비밀번호를 시트 값으로 갈아끼운다. */
export async function applyLiveSheetPassword(account, log = () => {}, { alwaysLog = false } = {}) {
  const id = String(account?.id || '').trim();
  if (!id) return false;
  let live = null;
  try {
    live = await fetchAccountByNaverId(id);
  } catch (err) {
    log(`시트를 읽지 못했습니다. ${id}: ${err?.message || err}`);
    return false;
  }
  if (!live?.pw) {
    log(`시트에서 ${id} 비밀번호를 읽지 못했습니다.`);
    return false;
  }
  const prev = String(account.pw || '');
  account.pw = live.pw;
  if (live.sheetRow) account.sheetRow = live.sheetRow;
  if (live.name && !account.name) account.name = live.name;
  if (prev !== live.pw) {
    log(`시트 비밀번호가 바뀌어 있습니다. ${id} / ${live.pw}`);
  } else if (alwaysLog) {
    log(`시트 비밀번호로 입력합니다. ${id} / ${live.pw}`);
  }
  return true;
}

/**
 * H열이 programId 와 같고, I열이 빈 행만 계정으로 읽는다.
 * I열에 100개 등 값이 있으면 자동 등록하지 않는다.
 * sheetRow 는 1부터 세는 시트 행 번호 (비밀번호 C열을 나중에 고칠 때 사용).
 */
export async function fetchProgramAccounts(programId) {
  const program = String(programId || '').trim();
  if (!program) throw new Error('컴퓨터 이름(H열)이 비어 있습니다.');
  const rows = await loadExportRows();
  const accounts = [];
  let matched = 0;
  let skipped = 0;
  rows.forEach((cols, index) => {
    const naverId = String(cols[COL.naverId] || '').trim();
    const naverPw = String(cols[COL.naverPw] || '').trim();
    const rowProgram = String(cols[COL.programId] || '').trim();
    if (!naverId || !naverPw) return;
    if (rowProgram !== program) return;
    if (naverId === '네이버' || naverPw === '비밀번호') return;
    matched += 1;
    const advisor = String(cols[COL.advisor] || '').trim();
    if (advisor) {
      skipped += 1;
      return;
    }
    accounts.push({
      id: naverId,
      pw: naverPw,
      name: String(cols[COL.name] || '').trim(),
      kakaoId: String(cols[COL.kakaoId] || '').trim(),
      kakaoPw: KAKAO_MAIL_PASSWORD,
      sheetRow: index + 1,
      programId: program,
    });
  });
  return { accounts, matched, skipped };
}

/**
 * 이 프로그램이 읽는 시트의 C열(비밀번호)을 고친다.
 * 구글 시트에 로그인된 브라우저가 아니면 false.
 */
async function readFormulaBar(sheetPage) {
  return sheetPage.evaluate(() => {
    const el = document.querySelector('#t-formula-bar-input, .cell-input, #cell-input');
    return String(el?.textContent || el?.value || '').trim();
  }).catch(() => '');
}

export async function writeAccountPasswordOnSheet(page, { naverId, password, log = () => {} } = {}) {
  const pw = String(password || '');
  const id = String(naverId || '').trim();
  if (!page || !pw || !id) return false;
  log(`새 비밀번호: ${id} / ${pw}`);
  const browser = page.browser?.();
  if (!browser) return false;
  let row = 0;
  try {
    const found = await fetchAccountByNaverId(id);
    row = Number(found?.sheetRow) || 0;
  } catch (err) {
    log(`시트 행을 읽지 못했습니다: ${err?.message || err}`);
    return false;
  }
  if (!row) {
    log(`시트에서 ${id} 행을 찾지 못했습니다. 새 비밀번호: ${pw}`);
    return false;
  }
  const sheetPage = await browser.newPage();
  try {
    const url = `https://docs.google.com/spreadsheets/d/${NAVER_ACCOUNT_SHEET_ID}/edit#gid=${NAVER_ACCOUNT_SHEET_GID}`;
    await sheetPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2500));
    const here = sheetPage.url() || '';
    if (/accounts\.google\.com|servicelogin/i.test(here)) {
      log(`구글 시트에 로그인되어 있지 않습니다. 새 비밀번호: ${pw}`);
      return false;
    }
    await sheetPage.waitForSelector('#t-name-box', { timeout: 15000 });
    const jump = async (addr) => {
      await sheetPage.click('#t-name-box');
      await sheetPage.keyboard.down('Control');
      await sheetPage.keyboard.press('KeyA');
      await sheetPage.keyboard.up('Control');
      await sheetPage.keyboard.type(addr, { delay: 20 });
      await sheetPage.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 600));
      return sheetPage.$eval('#t-name-box', (el) => String(el.value || el.textContent || '').trim().toUpperCase());
    };
    const idCell = await jump(`B${row}`);
    if (idCell !== `B${row}`) {
      log(`시트 B${row}로 이동하지 못했습니다. 새 비밀번호: ${pw}`);
      return false;
    }
    const shownId = await readFormulaBar(sheetPage);
    if (shownId && shownId !== id) {
      log(`시트 B${row}가 ${id}가 아니라서 넣지 않았습니다. 새 비밀번호: ${pw}`);
      return false;
    }
    const landed = await jump(`C${row}`);
    if (landed !== `C${row}`) {
      log(`시트 C${row}로 이동하지 못했습니다. 새 비밀번호: ${pw}`);
      return false;
    }
    await sheetPage.keyboard.type(pw, { delay: 15 });
    await sheetPage.keyboard.press('Enter');
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await fetchAccountByNaverId(id).catch(() => null);
      if (again?.pw === pw) {
        log(`시트 C${row}에 새 비밀번호를 넣었습니다. ${id} / ${pw}`);
        return true;
      }
    }
    log(`시트 C${row}에서 새 비밀번호가 확인되지 않았습니다. ${id} / ${pw}`);
    return false;
  } catch (e) {
    log(`시트를 수정하지 못했습니다: ${e?.message || e}. 새 비밀번호: ${pw}`);
    return false;
  } finally {
    try { await sheetPage.close(); } catch { /* ignore */ }
  }
}
