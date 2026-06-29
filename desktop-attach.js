// Reparents a window into the same layer as the desktop icons (the
// classic Rainmeter/Wallpaper-Engine trick), so the window is immune to
// Windows' "Show Desktop" (it IS part of the desktop, not a regular
// top-level app window) and naturally sits behind normal windows without
// needing "always on top" at all.
//
// How it works: Explorer's desktop is "Progman", which on most Windows
// 10 builds hosts the desktop icons ("SHELLDLL_DefView") inside a
// "WorkerW" child, with a second sibling WorkerW sitting unused behind
// it — that sibling is the classic Rainmeter attach point. On this dev
// machine (Windows build 26200) there's no sibling WorkerW at all —
// SHELLDLL_DefView is a direct child of Progman — so we fall back to
// using Progman itself as the parent in that case.
//
// This is inherently a bit of OS archaeology — Microsoft has changed this
// internal layout before and could again. Every call here is wrapped so a
// failure just leaves the window as a normal floating window instead of
// crashing the app.

let koffi;
let user32;
let dwmapi;
let FindWindowA, FindWindowExA, SendMessageTimeoutA, SetParent, EnumWindows, DwmSetWindowAttribute;
let EnumWindowsProcType;

// Windows 11 rounds the corners of every top-level window, including
// frameless ones, by default — that clashes with the sharp-cornered
// paper-card look the note widgets are going for elsewhere.
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_DONOTROUND = 1;

function init() {
  if (koffi) return;
  koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  FindWindowA = user32.func('intptr_t FindWindowA(str lpClassName, str lpWindowName)');
  FindWindowExA = user32.func('intptr_t FindWindowExA(intptr_t hWndParent, intptr_t hWndChildAfter, str lpszClass, str lpszWindow)');
  SendMessageTimeoutA = user32.func(
    'intptr_t SendMessageTimeoutA(intptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam, uint32 fuFlags, uint32 uTimeout, _Out_ uintptr_t *lpdwResult)'
  );
  SetParent = user32.func('intptr_t SetParent(intptr_t hWndChild, intptr_t hWndNewParent)');
  EnumWindowsProcType = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)');
  dwmapi = koffi.load('dwmapi.dll');
  DwmSetWindowAttribute = dwmapi.func(
    'long DwmSetWindowAttribute(intptr_t hwnd, uint32 dwAttribute, void *pvAttribute, uint32 cbAttribute)'
  );
}

function squareCorners(win) {
  try {
    init();
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE();
    const pref = Buffer.alloc(4);
    pref.writeUInt32LE(DWMWCP_DONOTROUND, 0);
    DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, pref, 4);
  } catch (err) {
    // Not available pre-Windows 11 — just leave the default rounding.
    console.error('squareCorners failed:', err.message);
  }
}

function findDesktopWorkerW() {
  init();

  const progman = FindWindowA('Progman', null);
  if (!progman) return null;

  // Asks Explorer to spawn the icon-hosting WorkerW if it hasn't already.
  SendMessageTimeoutA(progman, 0x052c, 0, 0, 0, 1000, [0]);

  let target = null;
  let shellViewParent = null;
  const callback = koffi.register((hwnd) => {
    const shellView = FindWindowExA(hwnd, 0, 'SHELLDLL_DefView', null);
    if (shellView) {
      shellViewParent = hwnd;
      // The WorkerW we want is the next sibling after the one hosting
      // the desktop icons — that one sits behind everything, unused.
      target = FindWindowExA(0, hwnd, 'WorkerW', null);
    }
    return true; // keep enumerating
  }, koffi.pointer(EnumWindowsProcType));

  try {
    EnumWindows(callback, 0);
  } finally {
    koffi.unregister(callback);
  }

  // On this Windows build there's no separate sibling WorkerW — the
  // desktop icons live directly under Progman, so Progman itself is the
  // right parent to use.
  if (!target && shellViewParent === progman) target = progman;

  return target || null;
}

function nudgeRedraw(win) {
  try {
    const [w, h] = win.getSize();
    win.setSize(w + 1, h);
    win.setSize(w, h);
  } catch {
    // window may have been destroyed between the caller's check and here
  }
}

function attachToDesktop(win) {
  try {
    const workerW = findDesktopWorkerW();
    if (!workerW) {
      console.error('attachToDesktop: no WorkerW found');
      return false;
    }
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE();
    SetParent(hwnd, workerW);
    nudgeRedraw(win);
    return true;
  } catch (err) {
    console.error('attachToDesktop failed:', err.message);
    return false;
  }
}

function detachFromDesktop(win) {
  try {
    init();
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE();
    SetParent(hwnd, 0);
    return true;
  } catch (err) {
    console.error('detachFromDesktop failed:', err.message);
    return false;
  }
}

module.exports = { attachToDesktop, detachFromDesktop, squareCorners };
