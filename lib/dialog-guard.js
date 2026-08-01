/**
 * Puppeteer dialog 단일 핸들러 — 이중 accept로 인한
 * "Cannot accept dialog which is already handled" 방지
 */

const KEY = Symbol.for('lad.safeDialogHandler');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{
 *   log?: (msg: string) => void,
 *   onMessage?: (msg: string) => void,
 *   shouldDismiss?: (msg: string) => boolean,
 * }} [opts]
 */
export function attachSafeDialogHandler(page, opts = {}) {
  if (!page) return null;

  if (page[KEY]) {
    const st = page[KEY];
    if (opts.log) st.log = opts.log;
    if (opts.onMessage) st.onMessage = opts.onMessage;
    if (opts.shouldDismiss) st.shouldDismiss = opts.shouldDismiss;
    return st;
  }

  const state = {
    lastMsg: '',
    ownershipDone: false,
    accepted: 0,
    log: opts.log || (() => {}),
    onMessage: opts.onMessage || null,
    shouldDismiss: opts.shouldDismiss || null,
    handling: false,
  };

  page.on('dialog', async (dialog) => {
    if (state.handling) {
      try { await dialog.dismiss(); } catch { /* already handled */ }
      return;
    }
    state.handling = true;
    const msg = dialog.message() || '';
    state.lastMsg = msg;
    try { state.onMessage?.(msg); } catch { /* ignore */ }

    try {
      state.log(`     🔔 네이티브 팝업: "${msg.replace(/\s+/g, ' ').slice(0, 90)}"`);
      if (state.shouldDismiss?.(msg) || /삭제\s*하시겠습니까|영구\s*삭제|정말\s*삭제/i.test(msg)) {
        await dialog.dismiss();
        state.log('     ⛔ 팝업 dismiss');
        return;
      }
      if (/완료되었습니다|소유\s*확인이\s*완료|사이트\s*소유\s*확인이\s*완료/i.test(msg)) {
        state.ownershipDone = true;
      }
      await dialog.accept();
      state.accepted += 1;
      state.log('     ✅ 팝업 accept');
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

export async function waitForDialogAccept(page, timeoutMs = 4000) {
  const st = page?.[KEY];
  if (!st) return false;
  const before = st.accepted;
  const deadline = Date.now() + timeoutMs;
  while (st.accepted === before && Date.now() < deadline) {
    await sleep(120);
  }
  if (st.accepted === before) {
    try {
      await page.keyboard.press('Enter');
      await sleep(350);
    } catch { /* ignore */ }
  }
  return st.accepted > before;
}
