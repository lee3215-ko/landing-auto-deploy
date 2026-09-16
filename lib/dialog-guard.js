/**
 * Puppeteer dialog 단일 핸들러 — 이중 accept로 인한
 * "Cannot accept dialog which is already handled" 방지
 */

const KEY = Symbol.for('lad.safeDialogHandler');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isDeleteConfirmMessage(msg) {
  return /삭제\s*하시겠습니까|영구\s*삭제|정말\s*삭제/i.test(String(msg || ''));
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{
 *   log?: (msg: string) => void,
 *   onMessage?: (msg: string) => void,
 *   shouldDismiss?: (msg: string) => boolean,
 *   protectDelete?: boolean,
 * }} [opts]
 *
 * protectDelete=true  → 자동화 중 실수 삭제 방지(삭제 확인 dismiss)
 * protectDelete=false → 보드에서 사이트 선택 후 수동 삭제 가능(삭제 확인 accept)  ← 기본
 */
export function attachSafeDialogHandler(page, opts = {}) {
  if (!page) return null;

  if (page[KEY]) {
    const st = page[KEY];
    if (opts.log) st.log = opts.log;
    if (opts.onMessage) st.onMessage = opts.onMessage;
    if (opts.shouldDismiss) st.shouldDismiss = opts.shouldDismiss;
    if (opts.protectDelete != null) st.protectDelete = !!opts.protectDelete;
    return st;
  }

  const state = {
    lastMsg: '',
    ownershipDone: false,
    /** 네이버 「메타태그를 찾을 수 없습니다」류 */
    metaMissing: false,
    metaMissingMsg: '',
    metaMissingAt: 0,
    accepted: 0,
    log: opts.log || (() => {}),
    onMessage: opts.onMessage || null,
    shouldDismiss: opts.shouldDismiss || null,
    /** 기본 false — 서치어드바이저 보드에서 수동 삭제가 먹히게 */
    protectDelete: opts.protectDelete === true,
    handling: false,
    /** 동일 메시지 스팸 로그 억제 */
    lastLoggedMsg: '',
    lastLoggedAt: 0,
    sameMsgCount: 0,
    enterFallbackUsed: 0,
  };

  const markMetaMissing = (msg) => {
    if (!/메타\s*태그|찾을\s*수\s*없|호스팅\s*또는\s*사이트\s*서버/i.test(msg || '')) return false;
    state.metaMissing = true;
    state.metaMissingMsg = String(msg || '').replace(/\s+/g, ' ').trim();
    state.metaMissingAt = Date.now();
    state.lastMsg = msg;
    return true;
  };
  state.markMetaMissing = markMetaMissing;

  page.on('dialog', async (dialog) => {
    if (state.handling) {
      try { await dialog.dismiss(); } catch { /* already handled */ }
      return;
    }
    state.handling = true;
    const msg = dialog.message() || '';
    state.lastMsg = msg;
    markMetaMissing(msg);
    try { state.onMessage?.(msg); } catch { /* ignore */ }

    try {
      const compact = msg.replace(/\s+/g, ' ').slice(0, 90);
      const now = Date.now();
      const sameAsLast = compact && compact === state.lastLoggedMsg && (now - state.lastLoggedAt) < 15000;
      if (sameAsLast) {
        state.sameMsgCount += 1;
        // 같은 alert가 연속이면 첫 1회 + 10회마다만 로그 (스팸 방지)
        if (state.sameMsgCount === 1 || state.sameMsgCount % 10 === 0) {
          state.log(`     🔔 네이티브 팝업(반복×${state.sameMsgCount}): "${compact}"`);
        }
      } else {
        state.sameMsgCount = 1;
        state.lastLoggedMsg = compact;
        state.lastLoggedAt = now;
        state.log(`     🔔 네이티브 팝업: "${compact}"`);
      }

      const blockDelete = state.protectDelete && isDeleteConfirmMessage(msg);
      if (state.shouldDismiss?.(msg) || blockDelete) {
        await dialog.dismiss();
        if (!sameAsLast) {
          state.log(blockDelete ? '     ⛔ 삭제 확인 팝업 dismiss (자동화 보호)' : '     ⛔ 팝업 dismiss');
        }
        return;
      }
      if (/완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/i.test(msg)) {
        state.ownershipDone = true;
      }
      await dialog.accept();
      state.accepted += 1;
      if (!sameAsLast) {
        state.log(
          isDeleteConfirmMessage(msg)
            ? '     ✅ 삭제 확인 accept (사이트 삭제 진행)'
            : '     ✅ 팝업 accept',
        );
      }
    } catch (e) {
      const m = e?.message || String(e);
      if (!/already handled/i.test(m)) {
        state.log(`     ⚠ 팝업 처리: ${m}`);
      }
    } finally {
      state.handling = false;
    }
  });

  page[KEY] = state;
  return state;
}

export function getDialogState(page) {
  return page?.[KEY] || null;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {number} [timeoutMs]
 * @param {{ allowEnterFallback?: boolean }} [opts]
 */
export async function waitForDialogAccept(page, timeoutMs = 4000, opts = {}) {
  const st = page?.[KEY];
  if (!st) return false;
  const allowEnter = opts.allowEnterFallback !== false;
  const before = st.accepted;
  const deadline = Date.now() + timeoutMs;
  while (st.accepted === before && Date.now() < deadline) {
    await sleep(120);
  }
  // Enter 폴백은 최대 1회 — 반복 Enter가 robots alert를 연쇄로 다시 띄우는 문제 방지
  if (st.accepted === before && allowEnter && (st.enterFallbackUsed || 0) < 1) {
    try {
      st.enterFallbackUsed = (st.enterFallbackUsed || 0) + 1;
      await page.keyboard.press('Enter');
      await sleep(350);
    } catch { /* ignore */ }
  }
  return st.accepted > before;
}
