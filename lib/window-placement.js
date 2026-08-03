/**
 * 메인 앱이 떠 있는 모니터에 Chrome 창을 배치하기 위한 좌표 계산
 */
export async function getChromeWindowPlacement(width = 1400, height = 900) {
  const w = Math.max(800, Number(width) || 1400);
  const h = Math.max(600, Number(height) || 900);
  try {
    const electron = await import('electron');
    const { BrowserWindow, screen } = electron;
    const wins = BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow();
    const main = (focused && !focused.isDestroyed() ? focused : null)
      || wins.find((win) => {
        try { return /Landing Auto Deploy/i.test(win.getTitle?.() || ''); } catch { return false; }
      })
      || wins[0]
      || null;

    const display = main
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay();
    const area = display.workArea || display.bounds;
    const winW = Math.min(w, Math.max(800, area.width - 40));
    const winH = Math.min(h, Math.max(600, area.height - 40));
    const x = Math.round(area.x + Math.max(16, (area.width - winW) / 2));
    const y = Math.round(area.y + Math.max(16, (area.height - winH) / 2));
    return {
      x,
      y,
      width: winW,
      height: winH,
      displayId: display.id,
    };
  } catch {
    return { x: 80, y: 60, width: w, height: h, displayId: null };
  }
}

export function chromeWindowArgs(placement) {
  const p = placement || { x: 80, y: 60, width: 1400, height: 900 };
  return [
    `--window-size=${p.width},${p.height}`,
    `--window-position=${p.x},${p.y}`,
  ];
}
