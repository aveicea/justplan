'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({
  defaults: { windowBounds: { x: null, y: null } }
});

let mainWindow = null;
let tray = null;
const WIDGET_WIDTH = 400;
const WIDGET_HEIGHT = 700;

// Dock에서 숨김 (메뉴바 앱으로 동작)
if (process.platform === 'darwin') {
  app.dock.hide();
}

function isPositionOnScreen(x, y) {
  if (x === null || y === null) return false;
  return screen.getAllDisplays().some(({ bounds }) =>
    x >= bounds.x &&
    y >= bounds.y &&
    x <= bounds.x + bounds.width - WIDGET_WIDTH &&
    y <= bounds.y + bounds.height - WIDGET_HEIGHT
  );
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const saved = store.get('windowBounds');
  const x = isPositionOnScreen(saved.x, saved.y) ? saved.x : sw - WIDGET_WIDTH - 20;
  const y = isPositionOnScreen(saved.x, saved.y) ? saved.y : sh - WIDGET_HEIGHT - 20;

  mainWindow = new BrowserWindow({
    x, y,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: false,   // 다른 앱이 앞에 오면 위젯은 뒤로 감
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 기존 index.html 수정 없이 드래그 영역 CSS 주입
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      .header { -webkit-app-region: drag; }
      button, .loading, #loading, .header-buttons { -webkit-app-region: no-drag; }
    `);
  });

  // 모든 Space에서 표시
  mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: false,
    skipTransformProcessType: true
  });

  // 위치 저장
  mainWindow.on('moved', () => {
    const [wx, wy] = mainWindow.getPosition();
    store.set('windowBounds', { x: wx, y: wy });
  });

  // 닫기 버튼 대신 숨기기 (트레이에서만 종료)
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  // 외부 링크는 기본 브라우저에서 열기
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'sparkles_2728.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('JustPlan');
  tray.on('click', toggleWindow);
  buildTrayMenu();
}

function buildTrayMenu() {
  const visible = mainWindow && mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? '위젯 숨기기' : '위젯 보이기', click: toggleWindow },
    { type: 'separator' },
    {
      label: '오른쪽 하단으로 초기화', click: () => {
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        const x = sw - WIDGET_WIDTH - 20;
        const y = sh - WIDGET_HEIGHT - 20;
        mainWindow.setPosition(x, y);
        store.set('windowBounds', { x, y });
      }
    },
    { type: 'separator' },
    {
      label: 'JustPlan 종료', click: () => {
        mainWindow.removeAllListeners('close');
        app.quit();
      }
    }
  ]));
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: false,
      skipTransformProcessType: true
    });
  }
  buildTrayMenu();
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* 트레이 앱이므로 종료하지 않음 */ });
app.on('activate', () => { if (mainWindow) mainWindow.show(); });
