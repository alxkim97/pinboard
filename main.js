const { app, BrowserWindow, ipcMain, screen, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { attachToDesktop, detachFromDesktop } = require('./desktop-attach');

// The HTML lang attribute alone doesn't change the native <input type="date">
// picker's day/month order in Electron — it follows the app's own locale,
// which otherwise inherits from the OS (often en-US, MM/DD/YYYY). Forcing
// en-GB here switches the native date picker to DD/MM/YYYY. Must be set
// before app is ready.
app.commandLine.appendSwitch('lang', 'en-GB');

// Without this, Windows can cache the taskbar/Start icon against the shared
// dev electron.exe binary instead of this app's own icon, especially across
// repeated relaunches during development.
app.setAppUserModelId('com.alexkim.pinboard');

// Prevent multiple copies running at once — without this, "Start with
// Windows" plus a manual launch (or double-clicking the shortcut twice)
// silently spawns duplicate tray icons and windows, each with its own
// pin widgets fighting over the same pins.json/settings.json files.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const PINS_FILE = path.join(app.getPath('userData'), 'pins.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;
const pinWindows = new Map(); // noteId -> BrowserWindow
let cascadeIndex = 0;

function loadPins() {
  try {
    return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function savePins(pins) {
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2), 'utf8');
}

function updatePin(id, partial) {
  const pins = loadPins();
  pins[id] = { ...pins[id], ...partial };
  savePins(pins);
}

function removePin(id) {
  const pins = loadPins();
  delete pins[id];
  savePins(pins);
}

function defaultPosition() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const x = width - 260 - (cascadeIndex % 5) * 30;
  const y = 40 + (cascadeIndex % 5) * 30;
  cascadeIndex++;
  return { x, y, width: 220, height: 200 };
}

function loadSettings() {
  try {
    return { alwaysOnTop: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { alwaysOnTop: false };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function applyLayering(win, alwaysOnTop) {
  if (alwaysOnTop) {
    detachFromDesktop(win);
    win.setAlwaysOnTop(true);
  } else {
    win.setAlwaysOnTop(false);
    attachToDesktop(win);
  }
}

function toggleGlobalAlwaysOnTop() {
  const settings = loadSettings();
  settings.alwaysOnTop = !settings.alwaysOnTop;
  saveSettings(settings);
  for (const win of pinWindows.values()) applyLayering(win, settings.alwaysOnTop);
  rebuildTrayMenu();
  return settings.alwaysOnTop;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#2b2b2b',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      for (const win of pinWindows.values()) win.destroy();
      pinWindows.clear();
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
}

function rebuildTrayMenu() {
  const startAtLogin = app.getLoginItemSettings().openAtLogin;
  const { alwaysOnTop } = loadSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Pinboard', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    {
      label: 'Keep Notes On Top',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: () => toggleGlobalAlwaysOnTop(),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    { label: 'Quit Pinboard', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip('Pinboard');
  rebuildTrayMenu();
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

function openPinWindow(note) {
  if (pinWindows.has(note.id)) {
    pinWindows.get(note.id).focus();
    return;
  }

  const pins = loadPins();
  const saved = pins[note.id];
  const pos = { ...defaultPosition(), ...saved };

  const win = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    minWidth: 160,
    minHeight: 160,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'pin-widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the note square while resizing, rather than a free-form rectangle.
  win.setAspectRatio(1);

  win.loadFile('pin-widget.html');
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('pin:init', note);
    applyLayering(win, loadSettings().alwaysOnTop);
  });

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    updatePin(note.id, { x, y });
  });

  win.on('resized', () => {
    const [width, height] = win.getSize();
    updatePin(note.id, { width, height });
  });

  win.on('closed', () => {
    pinWindows.delete(note.id);
  });

  pinWindows.set(note.id, win);
  updatePin(note.id, pos);
}

function closePinWindow(id) {
  const win = pinWindows.get(id);
  if (win) win.destroy();
  pinWindows.delete(id);
  removePin(id);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pin:unpinned', id);
  }
}

ipcMain.handle('pin:list', () => loadPins());

ipcMain.handle('pin:open', (_event, note) => {
  openPinWindow(note);
  return true;
});

ipcMain.handle('pin:close', (_event, id) => {
  closePinWindow(id);
  return true;
});

ipcMain.handle('pin:refresh', (_event, note) => {
  const win = pinWindows.get(note.id);
  if (win) win.webContents.send('pin:init', note);
  return true;
});

ipcMain.on('pin:move-by', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.on('pin:request-open-main', (_event, noteId) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('pin:open-detail', noteId);
});

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Default to launching at Windows login; the tray menu lets Alex turn
    // this off later if he doesn't want that.
    if (!app.getLoginItemSettings().wasOpenedAtLogin && !app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true });
    }
    createWindow();
    createTray();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});
