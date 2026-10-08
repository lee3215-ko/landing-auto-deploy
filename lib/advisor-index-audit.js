/**
 * 로그인된 서치어드바이저 사이트 목록을 site: 검색으로 확인하고,
 * 색인되지 않은 주소는 목록에서 체크 후 삭제한다.
 */
const BOARD = 'https://searchadvisor.naver.com/console/board';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normUrl(value) {
  return String(value || '').trim().replace(/\/$/, '').toLowerCase();
}

async function ensureBoard(page) {
  let cur = '';
  try { cur = page.url() || ''; } catch { cur = ''; }
  if (/searchadvisor\.naver\.com\/console\/board/i.test(cur)) return;
  await page.goto(BOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1600);
}

async function readVisibleSites(page) {
  return page.evaluate(() => {
    const urls = [];
    const seen = new Set();
    for (const tr of document.querySelectorAll('tbody tr')) {
      const text = [...tr.querySelectorAll('a')]
        .map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
        .find((t) => /^https?:\/\//i.test(t));
      if (!text) continue;
      const key = text.replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(text);
    }
    const next = document.querySelector('.v-data-footer__icons-after button, button[aria-label="다음 페이지"]');
    const hasNext = !!(next && !next.disabled && !next.classList.contains('v-btn--disabled') && next.getAttribute('disabled') == null);
    return { urls, hasNext };
  }).catch(() => ({ urls: [], hasNext: false }));
}

async function clickNextPage(page) {
  return page.evaluate(() => {
    const next = document.querySelector('.v-data-footer__icons-after button, button[aria-label="다음 페이지"]');
    if (!next || next.disabled || next.classList.contains('v-btn--disabled')) return false;
    next.click();
    return true;
  }).catch(() => false);
}

/** 보드의 등록 사이트 주소. 이미 보드에 있으면 그 화면에서 읽고, 아니면 한 번만 이동한다. */
export async function listAdvisorBoardSites(page, { onLog = null } = {}) {
  const log = (m) => { try { onLog?.(m); } catch { /* ignore */ } };
  await ensureBoard(page);
  const all = new Map();
  let stuck = '';
  for (let i = 0; i < 20; i += 1) {
    await sleep(700);
    const batch = await readVisibleSites(page);
    const first = batch.urls[0] || '';
    if (i > 0 && first && first === stuck && !batch.urls.some((u) => !all.has(normUrl(u)))) break;
    stuck = first;
    for (const url of batch.urls) all.set(normUrl(url), url.trim());
    log(`사이트 목록 ${all.size}개`);
    if (!batch.hasNext) break;
    const moved = await clickNextPage(page);
    if (!moved) break;
    await sleep(900);
  }
  return [...all.values()];
}

async function selectVisible(page, wanted) {
  return page.evaluate((list) => {
    const want = new Set(list.map((u) => String(u || '').trim().replace(/\/$/, '').toLowerCase()));
    const picked = [];
    for (const tr of document.querySelectorAll('tbody tr')) {
      const text = [...tr.querySelectorAll('a')]
        .map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
        .find((t) => /^https?:\/\//i.test(t));
      if (!text || !want.has(text.replace(/\/$/, '').toLowerCase())) continue;
      const icon = tr.querySelector('i.material-icons');
      const iconText = (icon?.textContent || '').trim();
      const checked = iconText === 'check_box';
      if (!checked) {
        const box = tr.querySelector('.v-simple-checkbox, .v-input--selection-controls__input, i.material-icons');
        box?.click();
      }
      picked.push(text);
    }
    return picked;
  }, wanted).catch(() => []);
}

async function clickDeleteButton(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const btn = buttons.find((b) => {
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      return t === '삭제' && !b.disabled && !b.classList.contains('v-btn--disabled');
    });
    if (!btn) return false;
    btn.click();
    return true;
  }).catch(() => false);
}

async function confirmDeleteDialog(page) {
  await sleep(600);
  await page.evaluate(() => {
    const dialog = document.querySelector('.v-dialog--active, .v-overlay--active .v-dialog');
    const root = dialog || document;
    const buttons = [...root.querySelectorAll('button')];
    const ok = buttons.find((b) => {
      const t = (b.innerText || '').replace(/\s+/g, '');
      return t === '삭제' || t === '확인';
    });
    if (dialog && ok) ok.click();
  }).catch(() => {});
}

/**
 * 색인 안 된 주소만 목록에서 체크하고 삭제 버튼을 누른다.
 * @returns {Promise<string[]>} 삭제를 시도한 주소
 */
export async function deleteAdvisorSites(page, urls, { onLog = null } = {}) {
  const log = (m) => { try { onLog?.(m); } catch { /* ignore */ } };
  const { attachSafeDialogHandler } = await import('./dialog-guard.js');
  attachSafeDialogHandler(page, {
    protectDelete: false,
    log: (m) => log(m),
  });
  const remaining = new Set((urls || []).map(normUrl).filter(Boolean));
  const removed = [];
  await ensureBoard(page);

  for (let round = 0; round < 25 && remaining.size; round += 1) {
    let acted = false;
    for (let p = 0; p < 20 && remaining.size; p += 1) {
      await sleep(500);
      const wanted = [...remaining];
      const picked = await selectVisible(page, wanted);
      const hits = picked.filter((u) => remaining.has(normUrl(u)));
      if (hits.length) {
        log(`체크 ${hits.length}개 · 삭제`);
        await sleep(400);
        const clicked = await clickDeleteButton(page);
        if (!clicked) {
          log('삭제 버튼이 비어 있습니다. 체크가 반영되지 않았습니다.');
          break;
        }
        await confirmDeleteDialog(page);
        await sleep(1600);
        for (const u of hits) {
          remaining.delete(normUrl(u));
          removed.push(u);
        }
        acted = true;
        break;
      }
      const more = await clickNextPage(page);
      if (!more) break;
      await sleep(800);
    }
    if (!acted) break;
    await ensureBoard(page);
  }
  return removed;
}
