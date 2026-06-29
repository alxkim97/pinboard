const { app, BrowserWindow, ipcMain, screen, Tray, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
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

// Desktop-attached pin widgets (see desktop-attach.js) can't be dragged
// live once SetParent has ever touched their HWND — Windows keeps
// reporting their position correctly, but the screen stops repainting them,
// and detaching again doesn't undo it. So instead of moving the real
// (possibly desktop-attached) window during a drag, it goes invisible
// (opacity 0, still receiving input normally) and a single shared,
// never-attached "shadow" window is shown in its place and moved in
// lockstep — that one is always paintable since it's never been through
// SetParent. The real window's position stays in sync the whole time via
// the same move-by messages, so when the drag ends it's already exactly
// where it needs to be.
let dragShadowWindow = null;
let activeDrag = null; // { realWin, shadowWin }

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

// Auto-update via electron-updater + GitHub Releases. A manual tray check
// always reports back (found/not found/error); the periodic background
// check stays silent unless it actually finds something, so it doesn't nag.
let updateDownloaded = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', (info) => {
  updateDownloaded = true;
  rebuildTrayMenu();
  dialog.showMessageBox({
    type: 'info',
    title: 'Pinboard update ready',
    message: `Pinboard ${info.version} has been downloaded.`,
    detail: 'Restart now to install it, or it will install automatically the next time Pinboard quits.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
});

autoUpdater.on('error', (err) => {
  console.error('autoUpdater error:', err);
});

function checkForUpdates(manual) {
  if (!manual) {
    autoUpdater.checkForUpdates().catch(() => {});
    return;
  }
  const cleanup = () => {
    autoUpdater.off('update-not-available', onNotAvailable);
    autoUpdater.off('update-available', cleanup);
    autoUpdater.off('error', onError);
  };
  const onNotAvailable = () => {
    cleanup();
    dialog.showMessageBox({ type: 'info', title: 'Pinboard', message: "You're up to date." });
  };
  const onError = (err) => {
    cleanup();
    dialog.showMessageBox({
      type: 'error',
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: String((err && err.message) || err),
    });
  };
  autoUpdater.once('update-not-available', onNotAvailable);
  autoUpdater.once('update-available', cleanup);
  autoUpdater.once('error', onError);
  autoUpdater.checkForUpdates().catch(() => {});
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
    updateDownloaded
      ? { label: 'Restart to Install Update', click: () => { isQuitting = true; autoUpdater.quitAndInstall(); } }
      : { label: 'Check for Updates', click: () => checkForUpdates(true) },
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
    opacity: 0, // hidden until the on-top toggle dance below settles, see comment
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
    // A note attached to the desktop layer immediately after creation
    // can't be live-dragged later, but one that's briefly shown as a
    // normal floating window first and only THEN attached can be —
    // confirmed empirically (toggling Always-on-Top ON, then OFF, before
    // dragging works; attaching directly on creation doesn't). This
    // codifies that same proven sequence for every new pin automatically.
    // The window stays invisible (opacity 0, set at creation above) for
    // this whole handshake so the "ON" half doesn't visibly flash above
    // every other window on screen — it only appears once settled.
    applyLayering(win, true);
    if (!loadSettings().alwaysOnTop) {
      setTimeout(() => {
        applyLayering(win, false);
        win.setOpacity(1);
      }, 300);
    } else {
      win.setOpacity(1);
    }
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

function createDragShadowWindow() {
  const win = new BrowserWindow({
    width: 220,
    height: 200,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'pin-widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Purely a visual stand-in — all mouse input should keep going to the
  // (invisible) real window underneath so its existing drag handling
  // keeps working unchanged.
  win.setIgnoreMouseEvents(true);
  win.loadFile('pin-widget.html');
  return win;
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
  const nx = Math.round(x + dx);
  const ny = Math.round(y + dy);
  win.setPosition(nx, ny);
  if (activeDrag && activeDrag.realWin === win) {
    activeDrag.shadowWin.setPosition(nx, ny);
  }
});

ipcMain.on('pin:drag-start', (event, note) => {
  const realWin = BrowserWindow.fromWebContents(event.sender);
  if (!realWin || !dragShadowWindow) return;
  const [x, y] = realWin.getPosition();
  const [w, h] = realWin.getSize();
  dragShadowWindow.setBounds({ x, y, width: w, height: h });
  dragShadowWindow.webContents.send('pin:init', note);
  dragShadowWindow.showInactive();
  // A freshly desktop-attached real window's opacity change isn't always
  // reliable (same stuck-rendering family of issue as its position), so
  // don't just rely on opacity to hide it — force the shadow itself to be
  // topmost so it's guaranteed to be the visible one regardless.
  dragShadowWindow.setAlwaysOnTop(true);
  dragShadowWindow.moveTop();
  realWin.setOpacity(0);
  activeDrag = { realWin, shadowWin: dragShadowWindow };
});

ipcMain.on('pin:drag-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setOpacity(1);
  if (activeDrag && activeDrag.realWin === win) {
    activeDrag.shadowWin.setAlwaysOnTop(false);
    activeDrag.shadowWin.hide();
    activeDrag = null;
  }
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
    dragShadowWindow = createDragShadowWindow();

    // Delay the first check past startup so it doesn't compete with the
    // board's initial load/render, then recheck periodically since this is
    // a long-running background app that may not get relaunched for days.
    setTimeout(() => checkForUpdates(false), 10_000);
    setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
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
