function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function randomDelay(min = 300, max = 900) {
  await sleep(randomBetween(min, max));
}

export async function prepareHumanPage(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
}

export async function idleMouseWander(page) {
  const moves = randomBetween(2, 4);
  for (let i = 0; i < moves; i++) {
    await page.mouse.move(randomBetween(120, 900), randomBetween(120, 700), { steps: randomBetween(8, 18) });
    await randomDelay(120, 380);
  }
}

async function humanMoveTo(page, x, y) {
  const steps = randomBetween(14, 32);
  const fromX = randomBetween(80, 320);
  const fromY = randomBetween(80, 280);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const cx = fromX + (x - fromX) * ease;
    const cy = fromY + (y - fromY) * ease;
    await page.mouse.move(cx, cy);
    await sleep(randomBetween(6, 22));
  }
  await page.mouse.move(x, y);
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function findButtonCoords(page, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const normPats = list.map(normalizeText);
  return page.evaluate((pats) => {
    function norm(t) {
      return (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
      const t = norm(el.textContent || el.value || '');
      for (const p of pats) {
        if (t === p || t.includes(p)) {
          const target = el.closest('button, a, [role="button"]') || el;
          const r = target.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
    }
    return null;
  }, normPats);
}

export async function waitForButtonByText(page, patterns, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const coords = await findButtonCoords(page, patterns);
    if (coords) return coords;
    await sleep(400);
  }
  return null;
}

export async function humanClickAt(page, x, y) {
  await humanMoveTo(page, x, y);
  await randomDelay(70, 200);
  await page.mouse.down();
  await sleep(randomBetween(45, 110));
  await page.mouse.up();
}

export async function humanClickElement(page, el) {
  await el.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await randomDelay(250, 550);
  const box = await el.boundingBox();
  if (!box) return false;
  const x = box.x + box.width * (0.32 + Math.random() * 0.36);
  const y = box.y + box.height * (0.32 + Math.random() * 0.36);
  await humanClickAt(page, x, y);
  return true;
}

export async function humanClickByText(page, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const normPats = list.map(normalizeText);
  const handle = await page.evaluateHandle((pats) => {
    function norm(t) {
      return (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
      const t = norm(el.textContent || el.value || '');
      for (const p of pats) {
        if (t === p || t.includes(p)) {
          const target = el.closest('button, a, [role="button"]') || el;
          const r = target.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) return target;
        }
      }
    }
    return null;
  }, normPats);
  const el = handle.asElement();
  if (!el) {
    const coords = await findButtonCoords(page, list);
    if (!coords) return false;
    await humanClickAt(page, coords.x, coords.y);
    return true;
  }
  const clicked = await humanClickElement(page, el);
  if (clicked) return true;
  const coords = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (coords?.x) {
    await humanClickAt(page, coords.x, coords.y);
    return true;
  }
  try {
    await el.click();
    return true;
  } catch {
    return false;
  }
}

export async function waitAndHumanClickByText(page, patterns, timeoutMs = 30000) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const coords = await waitForButtonByText(page, list, timeoutMs);
  if (coords) {
    await humanClickAt(page, coords.x, coords.y);
    return true;
  }
  return humanClickByText(page, list);
}

export async function humanClickSelector(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  return humanClickElement(page, el);
}

export async function humanType(page, selector, text) {
  const el = await page.$(selector);
  if (!el) return false;

  await humanClickElement(page, el);
  await randomDelay(180, 420);

  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await sleep(randomBetween(40, 90));
  await page.keyboard.press('Backspace');
  await randomDelay(100, 260);

  for (const ch of text) {
    await page.keyboard.type(ch, { delay: randomBetween(60, 150) });
    if (Math.random() < 0.1) await randomDelay(140, 380);
  }
  await randomDelay(220, 520);
  return true;
}

export async function humanFillInput(page, selectors, value) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of sels) {
    if (await page.$(sel)) return humanType(page, sel, value);
  }
  return false;
}
