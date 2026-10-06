/**
 * 네이버 계정 시트 (공개 CSV).
 * A 카카오 아이디, B 네이버 아이디, C 네이버 비밀번호, D 이름, H 컴퓨터 이름.
 * 카카오 메일 비밀번호는 계정 공통.
 */
import https from 'https';

export const NAVER_ACCOUNT_SHEET_ID = '1xQnL0kc1dJm9jeAL78O5D-IUBXPZE9_qwI3kIVH6Wm0';
export const NAVER_ACCOUNT_SHEET_GID = '680347381';
export const KAKAO_MAIL_PASSWORD = 'zhfldk123!';

const COL = { kakaoId: 0, naverId: 1, naverPw: 2, name: 3, programId: 7 };

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'landing-auto-deploy' },
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

/**
 * H열이 programId 와 같은 행만 계정으로 읽는다.
 * sheetRow 는 1부터 세는 시트 행 번호 (비밀번호 C열을 나중에 고칠 때 사용).
 */
export async function fetchProgramAccounts(programId) {
  const program = String(programId || '').trim();
  if (!program) throw new Error('프로그램 구분(H열)이 비어 있습니다.');
  const url = `https://docs.google.com/spreadsheets/d/${NAVER_ACCOUNT_SHEET_ID}/export?format=csv&gid=${NAVER_ACCOUNT_SHEET_GID}`;
  const text = await fetchText(url);
  if (!text || text.trim().startsWith('<')) {
    throw new Error('시트를 읽지 못했습니다. 공유 설정을 확인해 주세요.');
  }
  const rows = parseCsv(text);
  const accounts = [];
  rows.forEach((cols, index) => {
    const naverId = String(cols[COL.naverId] || '').trim();
    const naverPw = String(cols[COL.naverPw] || '').trim();
    const rowProgram = String(cols[COL.programId] || '').trim();
    if (!naverId || !naverPw) return;
    if (rowProgram !== program) return;
    if (naverId === '네이버' || naverPw === '비밀번호') return;
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
  return accounts;
}
