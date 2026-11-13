/**
 * AI 낙서 탐정 키오스크 셸.
 * - 앱 파일을 app:// 로 제공하고, 그 밖의 모든 네트워크 요청을 막는다(외부 요청 0건).
 * - 전체 화면 키오스크, 확대·이동 제스처 차단, 화면 프로세스가 죽으면 다시 연다.
 * - 운영자 설정: 실행 파일 옆 settings.json 이 있으면 그것을 우선 사용한다.
 *
 * 운영자 키: Ctrl+Shift+D 진단, Ctrl+Shift+Q 종료, Ctrl+Shift+R 새로고침
 */
const { app, BrowserWindow, protocol, session, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SMOKE = process.env.KIOSK_SMOKE;
const windowed = process.argv.includes('--windowed') || Boolean(SMOKE);
let blocked = 0;
const DIST = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

// 외부 통신 기능 끄기
app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,AutofillServerCommunication');
app.commandLine.appendSwitch('no-pings');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

function operatorSettingsPath() {
  // 설치본: 실행 파일 옆, 개발 실행: app/settings.json
  const candidates = [path.join(path.dirname(process.execPath), 'settings.json'), path.join(__dirname, '..', 'settings.json')];
  return candidates.find((p) => fs.existsSync(p));
}

async function serve(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel === 'settings.json') {
    const custom = operatorSettingsPath();
    if (custom) return new Response(fs.readFileSync(custom), { headers: { 'content-type': MIME['.json'], 'cache-control': 'no-store' } });
  }
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(fs.readFileSync(file), {
    headers: {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 1920,
    fullscreen: !windowed,
    kiosk: !windowed,
    autoHideMenuBar: true,
    backgroundColor: '#241f33',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowed,
      backgroundThrottling: false,
    },
  });
  if (windowed) win.setSize(540, 960);
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}));
  win.webContents.on('will-navigate', (e, url) => url.startsWith('app://') || e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', () => setTimeout(() => !win.isDestroyed() && win.reload(), 1000));
  win.webContents.on('unresponsive', () => setTimeout(() => !win.isDestroyed() && win.webContents.forcefullyCrashRenderer(), 10000));
  win.loadURL('app://kiosk/index.html');
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', serve);
  // app:// 와 개발 도구 외의 모든 요청 차단
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const ok = details.url.startsWith('app://') || details.url.startsWith('devtools://') || details.url.startsWith('data:') || details.url.startsWith('blob:');
    if (!ok) {
      blocked++;
      console.warn('[blocked]', details.url);
    }
    callback({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  let win = createWindow();
  if (SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const ok = await require('./smoke.cjs')(win, SMOKE);
      console.log(`blocked external requests: ${blocked}`);
      app.exit(ok && blocked === 0 ? 0 : 1);
    });
  }
  globalShortcut.register('Control+Shift+Q', () => app.quit());
  globalShortcut.register('Control+Shift+R', () => win && !win.isDestroyed() && win.reload());
  app.on('second-instance', () => win && win.focus());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
