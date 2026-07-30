import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRecordingPath, loadRecording } from './interaction-recorder.js';

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runPowerShell(script) {
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
}

async function getChromeHwnd(titlePart = 'Netlify') {
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinHwnd {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [WinHwnd]::Find('${titlePart.replace(/'/g, "''")}')
if ($h -eq [IntPtr]::Zero) { exit 1 }
Write-Output $h.ToInt64()
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true },
  );
  const hwnd = parseInt(stdout.trim(), 10);
  if (!hwnd) throw new Error('Chrome 창을 찾지 못했습니다');
  return hwnd;
}

async function clientToScreen(hwnd, clientX, clientY) {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinPt {
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  public static string Map(long hwnd, int x, int y) {
    var pt = new POINT { X = x, Y = y };
    ClientToScreen((IntPtr)hwnd, ref pt);
    return pt.X + "," + pt.Y;
  }
}
"@
[WinPt]::Map(${hwnd}, ${Math.round(clientX)}, ${Math.round(clientY)})
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true },
  );
  const [sx, sy] = stdout.trim().split(',').map(Number);
  return { x: sx, y: sy };
}

async function focusChromeWindow(titlePart = 'Netlify') {
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static bool Activate(string part) {
    bool ok = false;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, 512);
      var t = sb.ToString();
      if (t.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) {
        SetForegroundWindow(hWnd);
        ok = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return ok;
  }
}
"@
[WinFocus]::Activate('${titlePart.replace(/'/g, "''")}')
`;
  await runPowerShell(ps);
}

async function osMouseClick(x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int b, int e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0002, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0004, 0, 0, 0, 0);
  }
}
"@
[WinMouse]::Click(${px}, ${py})
`;
  await runPowerShell(ps);
}

async function osPasteText(text) {
  const safe = text.replace(/'/g, "''");
  await runPowerShell(`Set-Clipboard -Value '${safe}'`);
  await sleep(120);
  await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
`);
}

async function osKeyTap(key) {
  const map = { Tab: '{TAB}', Enter: '{ENTER}', Escape: '{ESC}' };
  const send = map[key] || key;
  await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${send.replace(/'/g, "''")}')
`);
}

export async function replayOsLevel(filePath, { email = '', password = '' } = {}, sendLog = null, options = {}) {
  const log = (msg) => sendLog?.(`[OS-REPLAY] ${msg}`);
  let events = loadRecording(filePath);
  if (options.urlFilter) {
    events = events.filter((e) => !e.url || options.urlFilter(e.url));
  }
  if (!events.length) throw new Error('OS 재생: 이벤트 없음');

  const clickCount = events.filter((e) => e.type === 'click').length;
  const inputCount = events.filter((e) => e.type === 'input').length;
  if (clickCount < 2) {
    throw new Error(`가입 기록이 불완전합니다 (클릭 ${clickCount}개). 「동작 기록」으로 가입 전체를 다시 녹화하세요.`);
  }

  log(`Windows 실제 입력으로 재생 (${events.length}개, 클릭 ${clickCount}, Puppeteer 미사용)`);
  await focusChromeWindow('Netlify');
  await sleep(800);

  let hwnd = null;
  try {
    hwnd = await getChromeHwnd('Netlify');
  } catch {
    log('Chrome HWND 조회 실패 — screenX/Y 또는 대략 좌표 사용');
  }

  const filled = { email: false, password: false };
  let lastTs = 0;

  for (const ev of events) {
    const gap = ev.ts - lastTs;
    if (gap > 0 && gap < 20000) await sleep(gap);
    lastTs = ev.ts;

    if (ev.type === 'mousemove') continue;

    if (ev.type === 'click') {
      await focusChromeWindow('Netlify').catch(() => {});
      let sx = ev.screenX;
      let sy = ev.screenY;
      if ((!sx && sx !== 0) || (!sy && sy !== 0)) {
        if (!hwnd) hwnd = await getChromeHwnd('Netlify');
        const pt = await clientToScreen(hwnd, ev.x, ev.y);
        sx = pt.x;
        sy = pt.y;
      }
      await osMouseClick(sx, sy);
      continue;
    }

    if (ev.type === 'input') {
      if (ev.field === 'email' && email && !filled.email) {
        await focusChromeWindow('Netlify').catch(() => {});
        await osPasteText(email);
        filled.email = true;
        log('이메일 붙여넣기 (OS)');
        continue;
      }
      if (ev.field === 'password' && password && !filled.password) {
        await focusChromeWindow('Netlify').catch(() => {});
        await osPasteText(password);
        filled.password = true;
        log('비밀번호 붙여넣기 (OS)');
        continue;
      }
    }

    if (ev.type === 'keydown' && ev.key === 'Tab') {
      await osKeyTap('Tab');
    }
  }

  log(`OS 재생 완료 (email=${filled.email}, password=${filled.password})`);
  return filled;
}

export async function replayNetlifyFlowOs(outputRoot, flow, credentials, sendLog) {
  const filePath = getRecordingPath(outputRoot, flow);
  return replayOsLevel(
    filePath,
    credentials,
    sendLog,
    { urlFilter: (url) => /app\.netlify\.com/i.test(url) },
  );
}
